/**
 * Argument builders for `scripts/verify.ts`: one per tool, prompt, and resource template.
 *
 * Kept apart from the runner so `test/unit/verify-builders.test.ts` can assert that every
 * registered tool has a builder without running anything live. A tool that is registered but has
 * no entry here is a failure of the verification script, so a new tool cannot slip through.
 */

/** Ids found by the discovery phase. Any of them may be missing on a given organization. */
export interface Discovery {
  /** Set by the discovery phase from `depot_whoami`. */
  tokenKind: string | undefined;
  activeOrgId: string | undefined;
  projectId: string | undefined;
  repo: string | undefined;
  failedRunId: string | undefined;
  /** A successful run when one exists, otherwise any run other than the failed one. */
  okRunId: string | undefined;
  workflowId: string | undefined;
  jobId: string | undefined;
  attemptId: string | undefined;
  artifactId: string | undefined;
  failedBuildId: string | undefined;
  okBuildId: string | undefined;
  sandboxId: string | undefined;
  repository: string | undefined;
  /** A `yyyymmdd-hhmm` UTC stamp for names that must be unique per session. */
  readonly stamp: string;
}

export function emptyDiscovery(stamp: string): Discovery {
  return {
    tokenKind: undefined,
    activeOrgId: undefined,
    projectId: undefined,
    repo: undefined,
    failedRunId: undefined,
    okRunId: undefined,
    workflowId: undefined,
    jobId: undefined,
    attemptId: undefined,
    artifactId: undefined,
    failedBuildId: undefined,
    okBuildId: undefined,
    sandboxId: undefined,
    repository: undefined,
    stamp,
  };
}

/** Every id present, for tests and for checking that a builder produces arguments at all. */
export function fullDiscovery(stamp = '20260101-0000'): Discovery {
  return {
    tokenKind: 'organization',
    activeOrgId: 'org_example',
    projectId: 'proj_example',
    repo: 'owner/name',
    failedRunId: 'run_failed',
    okRunId: 'run_ok',
    workflowId: 'wf_example',
    jobId: 'job_example',
    attemptId: 'att_example',
    artifactId: 'art_example',
    failedBuildId: 'bld_failed',
    okBuildId: 'bld_ok',
    sandboxId: 'sbx_example',
    repository: 'example/repo',
    stamp,
  };
}

export type Args = Record<string, unknown>;

/** Either the arguments to send, or the reason the scenario has to be skipped. */
export type Built = { readonly args: Args } | { readonly skip: string };

export type ArgumentBuilder = (discovery: Discovery) => Built;

function need(value: string | undefined, thing: string, args: (value: string) => Args): Built {
  return value === undefined ? { skip: `no ${thing} available` } : { args: args(value) };
}

function needTwo(
  a: string | undefined,
  b: string | undefined,
  things: string,
  args: (a: string, b: string) => Args,
): Built {
  return a === undefined || b === undefined
    ? { skip: `no ${things} available` }
    : { args: args(a, b) };
}

/** Variable written and deleted by the write scenarios; never anything a workflow reads. */
export const VERIFY_VARIABLE_NAME = 'DEPOT_MCP_VERIFY';

export const VERIFY_PROJECT_NAME = 'depot-mcp-verify';

/**
 * The workflow the dispatch scenarios start: the lab repository's `artifacts.yml`, which fails on
 * purpose within seconds, so a dispatched run costs almost nothing and never deploys anything.
 */
export const VERIFY_DISPATCH = {
  repo: 'akshayjain3450/depot-ci-lab',
  workflow: 'artifacts.yml',
  ref: 'main',
} as const;

/**
 * One builder per read-only tool (beta tools included). Values come from discovery; a builder
 * skips, rather than guesses, when the id it needs was not found.
 */
export const READ_TOOL_ARGUMENTS: Readonly<Record<string, ArgumentBuilder>> = {
  depot_whoami: () => ({ args: {} }),
  depot_diagnose_ci_failure: (d) =>
    need(d.failedRunId, 'failed run', (id) => ({ id, targetType: 'run', maxEvidenceLines: 5 })),
  depot_list_ci_runs: () => ({ args: { limit: 10 } }),
  depot_get_ci_run: (d) => need(d.failedRunId ?? d.okRunId, 'run', (runId) => ({ runId })),
  depot_get_ci_job: (d) => need(d.jobId, 'job', (jobId) => ({ jobId })),
  depot_get_ci_attempt: (d) => need(d.attemptId, 'attempt', (attemptId) => ({ attemptId })),
  depot_list_ci_workflows: () => ({ args: { limit: 10 } }),
  depot_get_ci_workflow: (d) => need(d.workflowId, 'workflow', (workflowId) => ({ workflowId })),
  // The discovered run is terminal, so this returns on the first poll.
  depot_wait_for_ci_run: (d) =>
    need(d.failedRunId ?? d.okRunId, 'run', (runId) => ({ runId, timeoutSeconds: 5 })),
  depot_get_ci_logs: (d) =>
    need(d.attemptId, 'attempt', (id) => ({ id, targetType: 'attempt', tailLines: 20 })),
  depot_get_ci_job_summary: (d) => need(d.jobId, 'job', (id) => ({ id, targetType: 'job' })),
  depot_get_ci_metrics: (d) => need(d.failedRunId ?? d.okRunId, 'run', (id) => ({ id, level: 'run' })),
  depot_list_ci_artifacts: (d) => need(d.failedRunId ?? d.okRunId, 'run', (runId) => ({ runId })),
  depot_get_ci_artifact_url: (d) => need(d.artifactId, 'artifact', (artifactId) => ({ artifactId })),
  depot_compare_ci_runs: (d) =>
    needTwo(d.okRunId, d.failedRunId, 'pair of runs', (runA, runB) => ({ runA, runB, maxJobs: 10 })),
  depot_diagnose_build: (d) =>
    need(d.failedBuildId ?? d.okBuildId, 'build', (buildId) => ({
      buildId,
      ...(d.projectId === undefined ? {} : { projectId: d.projectId }),
      tailLines: 20,
    })),
  depot_get_build: (d) => need(d.okBuildId ?? d.failedBuildId, 'build', (buildId) => ({ buildId })),
  depot_list_builds: (d) => need(d.projectId, 'project', (projectId) => ({ projectId, limit: 10 })),
  depot_list_projects: () => ({ args: { limit: 50 } }),
  depot_get_project: (d) => need(d.projectId, 'project', (projectId) => ({ projectId })),
  depot_audit_trust_policies: (d) => need(d.projectId, 'project', (projectId) => ({ projectId })),
  depot_list_project_tokens: (d) => need(d.projectId, 'project', (projectId) => ({ projectId })),
  depot_get_usage: () => ({ args: { days: 30 } }),
  depot_list_project_usage: () => ({ args: { days: 30 } }),
  depot_get_cache_summary: (d) =>
    need(d.projectId, 'project', (projectId) => ({ projectId, windowDays: 30, buildSample: 20 })),
  depot_list_images: (d) => need(d.projectId, 'project', (projectId) => ({ projectId, limit: 10 })),
  depot_list_ci_secrets: () => ({ args: {} }),
  depot_list_ci_variables: () => ({ args: {} }),
  // Beta tools.
  depot_list_sandboxes: () => ({ args: { limit: 10 } }),
  depot_get_sandbox: (d) => need(d.sandboxId, 'sandbox', (sandboxId) => ({ sandboxId })),
  depot_list_registry_repositories: () => ({ args: { limit: 10 } }),
  depot_get_registry_image: (d) =>
    need(d.repository, 'registry repository', (repository) => ({ repository, tag: 'latest' })),
};

export type WriteExpectation = 'refusal' | 'preview' | 'either';

export interface WriteDryRunScenario {
  readonly build: ArgumentBuilder;
  /** What the dry run should say for the ids discovery hands it. Recorded, not enforced. */
  readonly expect: WriteExpectation;
  readonly why: string;
}

/**
 * One dry-run scenario per mutating tool. `dryRun` is left at its default (true) on purpose: the
 * point is to prove the default changes nothing.
 */
export const WRITE_DRY_RUN_ARGUMENTS: Readonly<Record<string, WriteDryRunScenario>> = {
  depot_cancel_ci_run: {
    build: (d) => need(d.failedRunId, 'failed run', (runId) => ({ runId })),
    expect: 'refusal',
    why: 'the discovered run is terminal, so the preview must refuse it',
  },
  depot_cancel_ci_job: {
    build: (d) => need(d.jobId, 'failed job', (jobId) => ({ jobId })),
    expect: 'refusal',
    why: 'the discovered job is terminal, so the preview must refuse it',
  },
  depot_retry_ci_failed_jobs: {
    build: (d) => need(d.workflowId, 'workflow of the failed run', (workflowId) => ({ workflowId })),
    expect: 'either',
    why: 'a preview unless the failed job has hit the attempt cap',
  },
  depot_retry_ci_job: {
    build: (d) => need(d.jobId, 'failed job', (jobId) => ({ jobId })),
    expect: 'either',
    why: 'a preview unless the job has hit the attempt cap',
  },
  depot_rerun_ci_workflow: {
    build: (d) =>
      need(d.workflowId, 'workflow of the failed run', (workflowId) => ({
        workflowId,
        allowFullRerun: true,
      })),
    expect: 'preview',
    why: 'allowFullRerun lifts the only refusal that applies to a finished workflow',
  },
  depot_dispatch_ci_workflow: {
    build: () => ({ args: { ...VERIFY_DISPATCH } }),
    expect: 'either',
    why: 'a preview naming the last run of the lab workflow, or a refusal when DEPOT_MCP_DISPATCH_ALLOWLIST leaves it out',
  },
  depot_set_ci_variable: {
    build: (d) => ({ args: { name: VERIFY_VARIABLE_NAME, value: `ok-${d.stamp}` } }),
    expect: 'preview',
    why: 'a plain value with no secret of the same name',
  },
  depot_delete_ci_variable: {
    build: () => ({ args: { name: VERIFY_VARIABLE_NAME, allVariants: true } }),
    expect: 'either',
    why: 'a refusal when the variable does not exist, a preview when a previous apply left it behind',
  },
  depot_create_project: {
    build: () => ({ args: { name: VERIFY_PROJECT_NAME } }),
    expect: 'either',
    why: 'a preview the first time, a duplicate-name refusal once an apply run has created one',
  },
  // Beta sandbox writes, registered only with both gates open.
  depot_stop_sandbox: {
    build: (d) => need(d.sandboxId, 'sandbox', (sandboxId) => ({ sandboxId })),
    expect: 'either',
    why: 'a refusal when the discovered sandbox is terminal, a preview while it runs',
  },
  depot_kill_sandbox: {
    build: (d) => need(d.sandboxId, 'sandbox', (sandboxId) => ({ sandboxId })),
    expect: 'either',
    why: 'the same rule as stop',
  },
  depot_update_project: {
    build: (d) =>
      need(d.projectId, 'project', (projectId) => ({
        projectId,
        name: `${VERIFY_PROJECT_NAME}-rename-${d.stamp}`,
      })),
    expect: 'preview',
    why: 'a stamped name never equals the current one, so the diff has one entry and nothing shrinks',
  },
  // Registered only when DEPOT_MCP_ALLOW_DESTRUCTIVE is set in the environment the script runs in.
  depot_delete_project: {
    build: (d) =>
      need(d.projectId, 'project', (projectId) => ({
        projectId,
        confirmProjectName: `${VERIFY_PROJECT_NAME}-not-this-project`,
      })),
    expect: 'refusal',
    why: 'the confirmation name is deliberately wrong, so the name check must refuse before anything else',
  },
};

/** Prompt arguments are strings on the wire. */
export type PromptArgs = Record<string, string>;

export type PromptBuilt = { readonly args: PromptArgs } | { readonly skip: string };

export const PROMPT_ARGUMENTS: Readonly<Record<string, (d: Discovery) => PromptBuilt>> = {
  'diagnose-latest-failure': (d) => ({ args: d.repo === undefined ? {} : { repo: d.repo } }),
  'explain-build-slowness': (d) => ({
    args: d.projectId === undefined ? {} : { projectId: d.projectId },
  }),
  'triage-failures-today': () => ({ args: { hours: '24' } }),
  'compare-ci-runs': (d) =>
    d.okRunId === undefined || d.failedRunId === undefined
      ? { skip: 'no pair of runs available' }
      : { args: { runA: d.okRunId, runB: d.failedRunId } },
  'cache-audit': (d) => ({ args: d.projectId === undefined ? {} : { projectId: d.projectId } }),
  'debug-missing-secret': (d) => ({
    args: { name: 'NPM_TOKEN', repo: d.repo ?? 'owner/name', workflow: 'ci.yml' },
  }),
  'watch-run': (d) =>
    d.failedRunId === undefined ? { skip: 'no run available' } : { args: { runId: d.failedRunId } },
};

/** Keyed by the advertised `uriTemplate`; the values fill its `{name}` variables. */
export const RESOURCE_TEMPLATE_ARGUMENTS: Readonly<Record<string, (d: Discovery) => PromptBuilt>> =
  {
    'depot://ci/run/{runId}': (d) =>
      d.failedRunId === undefined ? { skip: 'no run available' } : { args: { runId: d.failedRunId } },
    'depot://project/{projectId}/builds': (d) =>
      d.projectId === undefined
        ? { skip: 'no project available' }
        : { args: { projectId: d.projectId } },
  };

export function expandTemplate(template: string, variables: PromptArgs): string {
  return template.replace(/\{([^}]+)\}/g, (match, name: string) => variables[name] ?? match);
}
