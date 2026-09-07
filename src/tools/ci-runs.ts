import { z } from 'zod';
import { readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import {
  countJobs,
  isFailureState,
  parseRunSummary,
  parseRunTree,
  type JobNode,
  type RunSummary,
  type RunTree,
} from '../lib/ci-tree.js';
import { formatDuration } from '../lib/time.js';
import { defineTool, ToolInputError } from '../lib/tool.js';

const RUN_STATUSES = ['queued', 'running', 'finished', 'failed', 'cancelled'] as const;

const runSummarySchema = z.object({
  runId: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  trigger: z.string().optional(),
  pr: z.number().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
});

const ALL_RUN_STATUSES = ['queued', 'running', 'finished', 'failed', 'cancelled'] as const;

/** One line per run, shared by the list tool and the failed-runs resource. */
export function describeRun(run: RunSummary): string {
  const bits = [
    run.status ?? 'unknown status',
    run.repo ?? 'unknown repo',
    run.sha === undefined ? undefined : run.sha.slice(0, 8),
    run.ref,
    run.trigger === undefined ? undefined : `via ${run.trigger}`,
    formatDuration(run.durationSeconds),
    run.createdAt,
  ].filter((bit): bit is string => bit !== undefined);
  return `${run.runId ?? 'unknown id'} — ${bits.join(' · ')}`;
}

export const listCiRunsTool = defineTool({
  name: 'depot_list_ci_runs',
  title: 'List Depot CI runs',
  description: `List recent Depot CI runs, newest first, optionally filtered by status, repository, commit, trigger, or pull request.

Use this to find the run someone is talking about — "my last failed build", "did main go green", "what ran for PR 412" — and then pass the returned runId to depot_diagnose_ci_failure or depot_get_ci_run.

The fastest path to diagnosing a recent breakage is status=["failed"] with limit=1, then depot_diagnose_ci_failure on the runId that comes back.

Returns identity, status and timing only. It does not return logs or failure detail; use depot_diagnose_ci_failure for that.`,
  inputSchema: {
    status: z
      .array(z.enum(RUN_STATUSES))
      .optional()
      .describe(
        'Keep only runs in these states. "finished" means completed successfully; a failed run reports "failed".',
      ),
    repo: z
      .string()
      .optional()
      .describe('Repository in "owner/name" form. Required when filtering by pr.'),
    sha: z.string().optional().describe('Filter to runs for one commit SHA.'),
    trigger: z
      .string()
      .optional()
      .describe('Filter by what started the run, for example "push" or "workflow_dispatch".'),
    pr: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Pull request number. Depot requires repo to be set alongside this.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum runs to return in one call.'),
    pageToken: z
      .string()
      .optional()
      .describe('nextPageToken from a previous call, to fetch the following page.'),
  },
  outputSchema: {
    runs: z.array(runSummarySchema),
    returned: z.number(),
    nextPageToken: z.string().optional(),
  },
  handler: async (input, context) => {
    if (input.pr !== undefined && input.repo === undefined) {
      throw new ToolInputError(
        'Depot requires a repo ("owner/name") when filtering runs by pull request number. Re-call with both repo and pr.',
      );
    }

    const response = await context.api.listRuns({
      // Verified live 2026-09-06: ListRuns answers an empty list unless a status filter is
      // present, so "no filter" is sent as every status.
      status: input.status === undefined ? [...ALL_RUN_STATUSES] : [...input.status],
      repo: input.repo,
      sha: input.sha,
      trigger: input.trigger,
      pr: input.pr,
      pageSize: input.limit,
      pageToken: input.pageToken,
    });

    const runs = readObjectArray(response, 'runs').map(parseRunSummary);
    const nextPageToken = readString(response, 'nextPageToken');
    const text = new TextBudget(context.config.outputCharBudget);

    if (runs.length === 0) {
      text.push(
        'No Depot CI runs matched those filters.',
        'If you expected results: check the filters (status values are queued, running, finished, failed, cancelled), and if your token spans several organizations set DEPOT_ORG_ID — a mismatched organization returns an empty list rather than an error. depot_whoami confirms what this token can see.',
      );
      return { summary: text.render(), data: { runs, returned: 0, nextPageToken } };
    }

    text.push(`${runs.length} Depot CI run(s), newest first:`);
    for (const run of runs) {
      text.push(`  ${describeRun(run)}`);
    }
    if (nextPageToken !== undefined) {
      text.push('', `More runs available: re-call with pageToken="${nextPageToken}".`);
    }
    const failed = runs.filter((run) => isFailureState(run.status));
    if (failed.length > 0) {
      text.push(
        '',
        `Diagnose a failure with depot_diagnose_ci_failure {"id":"${failed[0]?.runId ?? ''}"}.`,
      );
    }

    return { summary: text.render(), data: { runs, returned: runs.length, nextPageToken } };
  },
});

function renderJob(text: TextBudget, job: JobNode, indent: string): void {
  const state = job.conclusion ?? job.status ?? 'unknown';
  const label = job.displayName ?? job.key ?? 'unnamed job';
  text.push(`${indent}${label} — ${state}${job.jobId === undefined ? '' : ` (jobId=${job.jobId})`}`);
  for (const attempt of job.attempts) {
    const attemptState = attempt.conclusion ?? attempt.status ?? 'unknown';
    text.push(
      `${indent}  attempt ${attempt.attempt ?? '?'} — ${attemptState}${
        attempt.attemptId === undefined ? '' : ` (attemptId=${attempt.attemptId})`
      }`,
    );
  }
}

/** Renders the workflow -> job -> attempt tree; shared by depot_get_ci_run and the run resource. */
export function renderRunTree(tree: RunTree, failedOnly: boolean, charBudget: number): string {
  const text = new TextBudget(charBudget);
  const counts = countJobs(tree);
  text.push(
    `Run ${tree.runId ?? 'unknown'} — ${tree.status ?? 'unknown status'}, ${counts.total} job(s), ${counts.failed} failed.`,
  );

  for (const workflow of tree.workflows) {
    const jobs = failedOnly
      ? workflow.jobs.filter((job) => isFailureState(job.conclusion) || isFailureState(job.status))
      : workflow.jobs;
    if (failedOnly && jobs.length === 0) {
      continue;
    }
    text.push(
      '',
      `workflow "${workflow.name ?? 'unnamed'}" — ${workflow.status ?? 'unknown'}${
        workflow.workflowId === undefined ? '' : ` (workflowId=${workflow.workflowId})`
      }`,
    );
    for (const job of jobs) {
      renderJob(text, job, '  ');
    }
  }

  if (counts.failed > 0) {
    text.push(
      '',
      `Explain the failures with depot_diagnose_ci_failure {"id":"${tree.runId ?? ''}"} rather than reading logs job by job.`,
    );
  }
  return text.render();
}

export const getCiRunTool = defineTool({
  name: 'depot_get_ci_run',
  title: 'Get a Depot CI run tree',
  description: `Show one Depot CI run as its workflow -> job -> attempt tree, with the status of every node and the ids needed to drill in.

Use this to see the shape of a run: which jobs exist, which failed, and which attempt ids to pass to depot_get_ci_logs or depot_get_ci_metrics. Set failedOnly=true to cut a large matrix down to just the broken jobs.

This does not explain failures — it only reports structure and status. For root cause, call depot_diagnose_ci_failure with the same run id.`,
  inputSchema: {
    runId: z.string().min(1).describe('The run id, as returned by depot_list_ci_runs.'),
    failedOnly: z
      .boolean()
      .default(false)
      .describe('Show only jobs that failed or were cancelled. Useful for wide build matrices.'),
  },
  outputSchema: {
    run: runSummarySchema,
    jobCount: z.number(),
    failedJobCount: z.number(),
    workflows: z.array(
      z.object({
        workflowId: z.string().optional(),
        name: z.string().optional(),
        path: z.string().optional(),
        status: z.string().optional(),
        jobs: z.array(
          z.object({
            jobId: z.string().optional(),
            key: z.string().optional(),
            displayName: z.string().optional(),
            status: z.string().optional(),
            conclusion: z.string().optional(),
            attempts: z.array(
              z.object({
                attemptId: z.string().optional(),
                attempt: z.number().optional(),
                status: z.string().optional(),
                conclusion: z.string().optional(),
              }),
            ),
          }),
        ),
      }),
    ),
  },
  handler: async (input, context) => {
    const [runResponse, statusResponse] = await Promise.all([
      context.api.getRun(input.runId),
      context.api.getRunStatus(input.runId),
    ]);

    const tree = parseRunTree(statusResponse);
    const run = parseRunSummary(runResponse);
    const counts = countJobs(tree);
    const workflows = input.failedOnly
      ? tree.workflows
          .map((workflow) => ({
            ...workflow,
            jobs: workflow.jobs.filter(
              (job) => isFailureState(job.conclusion) || isFailureState(job.status),
            ),
          }))
          .filter((workflow) => workflow.jobs.length > 0)
      : tree.workflows;

    return {
      summary: renderRunTree(
        { ...tree, runId: tree.runId ?? run.runId },
        input.failedOnly,
        context.config.outputCharBudget,
      ),
      data: {
        run,
        jobCount: counts.total,
        failedJobCount: counts.failed,
        workflows,
      },
    };
  },
});
