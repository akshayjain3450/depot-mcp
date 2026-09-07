import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

function userPrompt(text: string) {
  return {
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
  };
}

/**
 * Prompt arguments are interpolated into instructions the agent will follow, so each one is
 * stripped to the characters its kind can legitimately contain before it is JSON-quoted. Anything
 * else is dropped, and an argument left empty after stripping is treated as absent.
 */
function stripTo(pattern: RegExp, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cleaned = value.replace(pattern, '');
  return cleaned === '' ? undefined : cleaned;
}

/** A GitHub "owner/name". */
function sanitizeRepo(repo: string | undefined): string | undefined {
  return stripTo(/[^A-Za-z0-9._/-]/g, repo);
}

/** A Depot run, job, attempt or project id. */
function sanitizeId(id: string | undefined): string | undefined {
  return stripTo(/[^A-Za-z0-9._-]/g, id);
}

/** A git branch or a workflow file path: the repo character set plus "/" is already allowed. */
function sanitizePath(value: string | undefined): string | undefined {
  return stripTo(/[^A-Za-z0-9._/-]/g, value);
}

/** A CI secret or variable name, which is an environment variable name in practice. */
function sanitizeName(value: string | undefined): string | undefined {
  return stripTo(/[^A-Za-z0-9_.-]/g, value);
}

const DEFAULT_TRIAGE_HOURS = 24;
const MAX_TRIAGE_HOURS = 24 * 7;

/** Prompt arguments arrive as strings; an unparseable or out-of-range window falls back to the default. */
function sanitizeHours(value: string | undefined): number {
  if (value === undefined || !/^\d{1,3}$/.test(value.trim())) {
    return DEFAULT_TRIAGE_HOURS;
  }
  const hours = Number(value.trim());
  return hours >= 1 && hours <= MAX_TRIAGE_HOURS ? hours : DEFAULT_TRIAGE_HOURS;
}

/** A required id that is empty after stripping cannot be sent to Depot, so the prompt says so. */
function requireId(name: string, value: string): string {
  const safe = sanitizeId(value);
  if (safe === undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${name} must contain at least one of: letters, digits, ".", "_", "-".`,
    );
  }
  return safe;
}

/**
 * Prompts encode Depot's run -> workflow -> job -> attempt hierarchy and the preferred tool order,
 * so an agent does not have to rediscover either.
 */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'diagnose-latest-failure',
    {
      title: 'Diagnose the latest Depot CI failure',
      description:
        'Find the most recent failed Depot CI run, explain why it failed, and propose a fix.',
      argsSchema: {
        repo: z
          .string()
          .optional()
          .describe('Optional "owner/name" to restrict the search to one repository.'),
      },
    },
    ({ repo }) => {
      const safeRepo = sanitizeRepo(repo);
      return userPrompt(
        [
          'Find and explain my most recent Depot CI failure, then propose a fix.',
          '',
          'Steps:',
          `1. Call depot_list_ci_runs with status=["failed"] and limit=1${
            safeRepo === undefined ? '' : ` and repo=${JSON.stringify(safeRepo)}`
          }.`,
          '2. Call depot_diagnose_ci_failure with the runId from step 1. Read its failureGroups (or representativeAttempts) — each carries an error message, a diagnosis, a suggested fix, and the evidence lines.',
          '3. If the state is over_limit, re-call depot_diagnose_ci_failure with one of the ids in narrowerTargets.',
          '4. Only if the diagnosis is not specific enough, call depot_get_ci_logs on the failing attempt id, using a grep term drawn from the error message.',
          '',
          "Then tell me: what broke, which job and step, why, and the smallest change that would fix it. Depot's diagnoses are AI-generated — say which parts you verified against the evidence lines and which you are taking on trust.",
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'explain-build-slowness',
    {
      title: 'Explain why Depot builds are slow',
      description:
        'Analyse recent container builds and usage to work out whether slowness is cache misses, cold builds, or genuinely more work.',
      argsSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Optional project to focus on. Omit to pick from the available projects.'),
      },
    },
    ({ projectId }) =>
      userPrompt(
        [
          'Work out why my Depot container builds are slow.',
          '',
          'Steps:',
          projectId === undefined
            ? '1. Call depot_list_projects and pick the project that looks most active.'
            : `1. Use project ${JSON.stringify(projectId.replace(/[^A-Za-z0-9._-]/g, ''))}.`,
          '2. Call depot_list_builds for it with limit=20. For each build compare cachedSteps against totalSteps, and look at savedDurationSeconds versus buildDurationSeconds.',
          '3. Call depot_get_usage for the last 30 days to see billed minutes against minutes saved.',
          '4. Call depot_diagnose_build on the slowest recent build to see which step dominated and whether it was cached.',
          '',
          'Then tell me whether the cause is a low cache hit ratio (and which step keeps invalidating), an undersized runner, or simply more work than before. Note the project cache policy from step 1 if retention could be evicting layers early.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'triage-failures-today',
    {
      title: 'Triage the recent Depot CI failures',
      description:
        'Group the failed and cancelled Depot CI runs of the last day by repository and workflow, diagnose the distinct groups, and mark each as recurring or new.',
      argsSchema: {
        repo: z
          .string()
          .optional()
          .describe('Optional "owner/name" to restrict the triage to one repository.'),
        hours: z
          .string()
          .optional()
          .describe(
            `How far back to look, in whole hours (1 to ${MAX_TRIAGE_HOURS}). Defaults to ${DEFAULT_TRIAGE_HOURS}.`,
          ),
      },
    },
    ({ repo, hours }) => {
      const safeRepo = sanitizeRepo(repo);
      const window = sanitizeHours(hours);
      return userPrompt(
        [
          `Triage every Depot CI run that failed or was cancelled in the last ${window} hour(s)${
            safeRepo === undefined ? '' : ` in repository ${JSON.stringify(safeRepo)}`
          }.`,
          '',
          'Steps:',
          `1. Call depot_list_ci_runs with status=["failed","cancelled"] and limit=100${
            safeRepo === undefined ? '' : ` and repo=${JSON.stringify(safeRepo)}`
          }. Keep only runs whose createdAt is within the last ${window} hour(s); if the oldest run returned is still inside the window, re-call with pageToken until one falls outside it.`,
          '2. For each kept run call depot_get_ci_run with failedOnly=true to learn its workflow name and the keys of the jobs that failed. Group the runs by repo, then workflow, then the set of failed job keys.',
          '3. For at most 5 distinct groups, newest run first, call depot_diagnose_ci_failure with that run\'s runId. Read the failureGroups: an error message, a diagnosis, a suggested fix, and evidence lines for each. If the state is over_limit, re-call with one of the ids in narrowerTargets.',
          '4. Mark a group as recurring when more than one run in the window falls into it, or when its error message matches another group\'s; otherwise mark it new.',
          '',
          'Then report a table with one row per group: repo, workflow, failed jobs, run count, newest runId, recurring or new, and a one-line cause. Below the table say which groups look safe to retry as-is (a network timeout, a runner killed for memory, a run cancelled by a newer push) and which need a code or configuration change first. Depot\'s diagnoses are AI-generated: say which causes you verified against the evidence lines.',
          'This server is read-only. Do not attempt to retry, rerun, or cancel anything; if a retry is warranted say so and leave it to a person in the Depot dashboard.',
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'compare-ci-runs',
    {
      title: 'Compare two Depot CI runs',
      description:
        'Diff two Depot CI runs: job status changes, duration and peak memory deltas per job, and failure groups present in one run but not the other.',
      argsSchema: {
        runA: z.string().describe('The baseline run id, usually the older or the passing run.'),
        runB: z.string().describe('The run to compare against the baseline, usually the newer or the failing run.'),
      },
    },
    ({ runA, runB }) => {
      const safeA = requireId('runA', runA);
      const safeB = requireId('runB', runB);
      return userPrompt(
        [
          `Compare Depot CI run ${JSON.stringify(safeA)} (A, the baseline) with run ${JSON.stringify(safeB)} (B).`,
          '',
          'Steps:',
          `1. Call depot_get_ci_run with runId=${JSON.stringify(safeA)}, then again with runId=${JSON.stringify(safeB)}. Match jobs between the two runs by their key, and note the attempt count of each.`,
          `2. Call depot_get_ci_metrics with id=${JSON.stringify(safeA)} and level="run", then with id=${JSON.stringify(safeB)}. Where the run-level document does not break metrics down by job, call it again per job with the jobIds from step 1 (only for jobs that failed or whose status changed, to keep the call count down).`,
          '3. For whichever run failed (or both), call depot_diagnose_ci_failure with its runId and read the failureGroups.',
          '',
          'Then report: a status diff (jobs that pass in A and fail in B, and the reverse); per job, the duration delta and the peak memory delta between A and B, flagging any job whose memory in B sits at its limit; and the failure groups present in B but not in A (and the reverse), with their error messages. State which run is newer from the createdAt fields, and say whether the differences look like a code change, a flaky dependency, or a runner resource problem.',
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'cache-audit',
    {
      title: 'Audit Depot build cache effectiveness',
      description:
        'Check container build cache hit ratios against each project\'s retention policy and the last 30 days of usage, and flag projects where the cache is not paying for itself.',
      argsSchema: {
        projectId: z
          .string()
          .optional()
          .describe('Optional project to audit. Omit to audit every project the token can see.'),
      },
    },
    ({ projectId }) => {
      const safeProject = sanitizeId(projectId);
      return userPrompt(
        [
          safeProject === undefined
            ? 'Audit the container build cache of every Depot project this token can see.'
            : `Audit the container build cache of Depot project ${JSON.stringify(safeProject)}.`,
          '',
          'Steps:',
          `1. Call depot_list_projects and note each project's cache policy (keepGb and keepDays)${
            safeProject === undefined ? '' : `, then keep only project ${JSON.stringify(safeProject)}`
          }.`,
          '2. For each project under audit call depot_list_builds with limit=20. For every build compare cachedSteps against totalSteps and note savedDurationSeconds; compute the mean cache hit ratio and how many builds had zero cached steps.',
          `3. Call depot_get_usage with days=30${
            safeProject === undefined ? '' : ` and projectId=${JSON.stringify(safeProject)}`
          } to see billed build minutes against minutes saved by the cache.`,
          '',
          'Then report one row per project: cache policy, builds sampled, mean hit ratio, cold builds (zero cached steps), and minutes saved over 30 days. Flag a project when its mean hit ratio is below 50% or a third or more of its builds were cold, and flag a retention policy shorter than 7 days or smaller than the size a full rebuild would need when the build history suggests layers are being evicted between builds. For each flagged project say what would most likely raise the hit ratio (a longer or larger retention policy, a more stable base layer, or a Dockerfile ordering change).',
          'Resetting a project\'s cache is not offered by this server and would destroy every cached layer; do not suggest it as a fix.',
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'debug-missing-secret',
    {
      title: 'Debug a Depot CI secret or variable a job cannot see',
      description:
        'Work out which secret or variable variant applies to a repository, branch and workflow, and why a job might not see it.',
      argsSchema: {
        name: z.string().describe('The secret or variable name the job expects, for example NPM_TOKEN.'),
        repo: z.string().describe('The repository the job runs in, as "owner/name".'),
        branch: z.string().optional().describe('The branch the job ran on, for example "main" or "release/2.4".'),
        workflow: z
          .string()
          .optional()
          .describe('The workflow file name or path, for example "ci.yml" or ".github/workflows/ci.yml".'),
      },
    },
    ({ name, repo, branch, workflow }) => {
      const safeName = sanitizeName(name);
      const safeRepo = sanitizeRepo(repo);
      if (safeName === undefined || safeRepo === undefined) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'name and repo must each contain at least one letter or digit.',
        );
      }
      const safeBranch = sanitizePath(branch);
      const safeWorkflow = sanitizePath(workflow);
      const scope = [
        `repo=${JSON.stringify(safeRepo)}`,
        safeBranch === undefined ? undefined : `branch=${JSON.stringify(safeBranch)}`,
        safeWorkflow === undefined ? undefined : `workflow=${JSON.stringify(safeWorkflow)}`,
      ].filter((part): part is string => part !== undefined);
      const where = [
        `repository ${JSON.stringify(safeRepo)}`,
        safeBranch === undefined ? undefined : `branch ${JSON.stringify(safeBranch)}`,
        safeWorkflow === undefined ? undefined : `workflow ${JSON.stringify(safeWorkflow)}`,
      ]
        .filter((part): part is string => part !== undefined)
        .join(', ');
      return userPrompt(
        [
          `A Depot CI job in ${where} cannot see the secret or variable ${JSON.stringify(safeName)}. Work out why.`,
          '',
          'Steps:',
          `1. Call depot_list_ci_secrets with query=${JSON.stringify(safeName)} and ${scope.join(', ')}. The result lists every variant of each matching secret with its scoping attributes (repository, environment, branch, workflow); unscoped variants apply everywhere.`,
          `2. Call depot_list_ci_variables with the same arguments, in case the value was defined as a variable rather than a secret.`,
          `3. If nothing matches, re-call both tools with only query=${JSON.stringify(safeName)} and no scoping, to see whether the name exists but is scoped to a different repository, branch, or workflow.`,
          '',
          `Then tell me: whether ${JSON.stringify(safeName)} exists at all; which variant, if any, would match this job (the most specific variant whose every attribute matches wins, and a variant scoped to another repository, branch, environment or workflow never applies); and the most likely reason the job did not see it, for example a case difference in the name, a branch-scoped variant while the job ran on a pull request merge ref, a workflow variant keyed by a different file name, or a variable defined where a secret was expected. Note that secret values are never returned by Depot and variable values may be redacted here, so compare names and scopes only.`,
          'This server cannot create or change secrets or variables; describe the change for a person to make in the Depot dashboard.',
        ].join('\n'),
      );
    },
  );

  server.registerPrompt(
    'watch-run',
    {
      title: 'Watch a Depot CI run to completion',
      description:
        'Poll one Depot CI run until it finishes, then diagnose it if it failed or list its artifacts if it passed.',
      argsSchema: {
        runId: z.string().describe('The run id to watch, as returned by depot_list_ci_runs.'),
      },
    },
    ({ runId }) => {
      const safeRun = requireId('runId', runId);
      return userPrompt(
        [
          `Watch Depot CI run ${JSON.stringify(safeRun)} until it finishes, then tell me the outcome.`,
          '',
          'Steps:',
          `1. Call depot_get_ci_run with runId=${JSON.stringify(safeRun)}. If the run status is queued or running, wait about 30 seconds and call it again; report each job whose status changed since the previous poll. Stop polling after 20 polls (roughly 10 minutes) and say the run is still going.`,
          `2. When the run status is failed or cancelled, call depot_diagnose_ci_failure with id=${JSON.stringify(safeRun)} and read the failureGroups; if the state is over_limit, re-call with one of the ids in narrowerTargets.`,
          `3. When the run status is finished, call depot_list_ci_artifacts with runId=${JSON.stringify(safeRun)} to list what it produced.`,
          '',
          'Then report: the final status and total duration; on failure, which job and step broke, why, and the smallest fix, noting that Depot\'s diagnoses are AI-generated and which parts you verified against the evidence lines; on success, the artifacts with their sizes.',
          'This server is read-only, so it cannot cancel or retry the run.',
        ].join('\n'),
      );
    },
  );
}
