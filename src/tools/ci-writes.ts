import { z } from 'zod';
import type { JsonObject } from '../depot/shape.js';
import { truncateText } from '../lib/budget.js';
import {
  countAttempts,
  isActiveState,
  isFailedJob,
  isTerminalState,
  nodeState,
  parseJobDetail,
  parseWorkflowDetail,
  summariseMutationResponse,
  type JobDetail,
  type WorkflowDetail,
} from '../lib/ci-detail.js';
import { parseRunTree, type JobNode } from '../lib/ci-tree.js';
import { formatDuration } from '../lib/time.js';
import { ToolInputError, type ToolContext } from '../lib/tool.js';
import { defineWriteTool, type WriteApplied, type WritePreview } from '../lib/write.js';

/**
 * A job that has already run this many times is not going to pass on the next try without a
 * change; past this point a retry needs `force:true`. Matches the limit in docs/roadmap.md.
 */
export const RETRY_ATTEMPT_CAP = 3;

/** Job names come from workflow YAML; keep them short when echoed. */
const LABEL_CHAR_LIMIT = 120;
const ERROR_CHAR_LIMIT = 300;
const JOB_LIST_LIMIT = 25;

function label(job: Pick<JobNode, 'displayName' | 'key' | 'jobId'>): string {
  const name = job.displayName ?? job.key ?? job.jobId ?? 'unnamed job';
  return `"${truncateText(name, LABEL_CHAR_LIMIT).text}"`;
}

const workflowIdField = z
  .string()
  .min(1)
  .describe('The workflow id, as shown by depot_get_ci_run (workflowId=...) for the parent run.');
const jobIdField = z
  .string()
  .min(1)
  .describe('The job id, as shown by depot_get_ci_run (jobId=...) for the parent run.');

const jobRowSchema = z.object({
  jobId: z.string().optional(),
  label: z.string(),
  state: z.string(),
  attemptCount: z.number(),
});

type JobRow = z.input<typeof jobRowSchema>;

function jobRow(job: JobNode & { attemptCount?: number }): JobRow {
  return {
    jobId: job.jobId,
    label: label(job),
    state: nodeState(job),
    attemptCount: job.attemptCount ?? countAttempts(job),
  };
}

const afterSchema = {
  rpc: z.string(),
  status: z.string().optional(),
  ids: z.record(z.string(), z.string()),
  responseKeys: z.array(z.string()),
};

type AfterData = z.input<z.ZodObject<typeof afterSchema>>;

/** Depot's mutating RPCs have undocumented responses: report whatever came back, tolerantly. */
function afterFromResponse(rpc: string, response: JsonObject): WriteApplied<AfterData> {
  const summary = summariseMutationResponse(response);
  const idText = Object.entries(summary.ids)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  const lines = [
    `${rpc} accepted.${summary.status === undefined ? '' : ` Reported status: ${summary.status}.`}`,
    idText === '' ? 'Depot returned no ids.' : `Ids in the response: ${idText}.`,
  ];
  if (summary.keys.length === 0) {
    lines.push('Depot returned an empty response body, which is normal for this RPC.');
  }
  return {
    data: { rpc, status: summary.status, ids: summary.ids, responseKeys: summary.keys },
    lines,
  };
}

// ---------------------------------------------------------------------------------------------
// Workflow previews, shared by retry-failed-jobs and rerun.

const workflowPreviewSchema = {
  workflowId: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  runId: z.string().optional(),
  runStatus: z.string().optional(),
  repo: z.string().optional(),
  jobCount: z.number(),
  failedJobCount: z.number(),
  activeJobCount: z.number(),
  executionCount: z.number(),
  previousDurationSeconds: z.number().optional(),
  failedJobs: z.array(jobRowSchema),
  jobs: z.array(jobRowSchema),
};

type WorkflowPreview = z.input<z.ZodObject<typeof workflowPreviewSchema>>;

async function workflowPreview(
  workflowId: string,
  context: ToolContext,
): Promise<{ detail: WorkflowDetail; preview: WritePreview<WorkflowPreview> }> {
  const detail = parseWorkflowDetail(await context.api.getWorkflow(workflowId));
  const failed = detail.jobs.filter(isFailedJob);
  const active = detail.jobs.filter((job) => isActiveState(job.status));
  const executionsDone = detail.executions.filter((execution) => isTerminalState(execution.status));
  const previousDurationSeconds =
    detail.durationSeconds ?? executionsDone.at(-1)?.durationSeconds;

  const lines = [
    `Workflow ${detail.workflowId ?? workflowId} ${detail.name === undefined ? '' : `"${truncateText(detail.name, LABEL_CHAR_LIMIT).text}" `}is ${detail.status ?? 'in an unknown state'}${detail.repo === undefined ? '' : ` in ${detail.repo}`}${detail.runId === undefined ? '' : ` (run ${detail.runId}, ${detail.runStatus ?? 'unknown status'})`}.`,
    `Jobs: ${detail.jobs.length} total, ${failed.length} failed or cancelled, ${active.length} still active.`,
    `Previous executions: ${detail.executions.length}; last wall time ${formatDuration(previousDurationSeconds)}.`,
  ];
  for (const job of failed.slice(0, JOB_LIST_LIMIT)) {
    lines.push(
      `  failed: ${label(job)} ${nodeState(job)}, ${job.attemptCount} attempt(s)${job.jobId === undefined ? '' : ` (jobId=${job.jobId})`}`,
    );
  }
  if (failed.length > JOB_LIST_LIMIT) {
    lines.push(`  ... ${failed.length - JOB_LIST_LIMIT} more failed jobs`);
  }

  return {
    detail,
    preview: {
      data: {
        workflowId: detail.workflowId ?? workflowId,
        name: detail.name,
        status: detail.status,
        runId: detail.runId,
        runStatus: detail.runStatus,
        repo: detail.repo,
        jobCount: detail.jobs.length,
        failedJobCount: failed.length,
        activeJobCount: active.length,
        executionCount: detail.executions.length,
        previousDurationSeconds,
        failedJobs: failed.slice(0, JOB_LIST_LIMIT).map(jobRow),
        jobs: detail.jobs.slice(0, JOB_LIST_LIMIT).map(jobRow),
      },
      lines,
    },
  };
}

function refuseRunningWorkflow(preview: WorkflowPreview): string | undefined {
  if (isActiveState(preview.status)) {
    return `Workflow ${preview.workflowId ?? ''} is still ${preview.status ?? 'running'} (${preview.activeJobCount} active job(s)). Depot only retries or reruns a finished workflow; wait for it, or cancel it with depot_cancel_ci_run.`;
  }
  return undefined;
}

function refuseAttemptCap(rows: readonly JobRow[], force: boolean): string | undefined {
  if (force) {
    return undefined;
  }
  const capped = rows.filter((row) => row.attemptCount >= RETRY_ATTEMPT_CAP);
  if (capped.length === 0) {
    return undefined;
  }
  const named = capped
    .slice(0, 5)
    .map((row) => `${row.label} (${row.attemptCount} attempts)`)
    .join(', ');
  return `${capped.length} failed job(s) already ran ${RETRY_ATTEMPT_CAP} or more times: ${named}. Another retry without a code or configuration change is unlikely to pass. Pass force:true to retry anyway.`;
}

// ---------------------------------------------------------------------------------------------
// Job previews, shared by cancel-job and retry-job.

const jobPreviewSchema = {
  jobId: z.string().optional(),
  label: z.string(),
  state: z.string(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  errorMessage: z.string().optional(),
  runId: z.string().optional(),
  runStatus: z.string().optional(),
  workflowId: z.string().optional(),
  workflowName: z.string().optional(),
  workflowStatus: z.string().optional(),
  attemptCount: z.number(),
  durationSeconds: z.number().optional(),
};

type JobPreview = z.input<z.ZodObject<typeof jobPreviewSchema>>;

async function jobPreview(
  jobId: string,
  context: ToolContext,
): Promise<{ detail: JobDetail; preview: WritePreview<JobPreview> }> {
  const detail = parseJobDetail(await context.api.getJob(jobId));
  const errorMessage =
    detail.errorMessage === undefined
      ? undefined
      : truncateText(detail.errorMessage, ERROR_CHAR_LIMIT).text;
  const lines = [
    `Job ${label(detail)} (jobId=${detail.jobId ?? jobId}) is ${nodeState(detail)} after ${detail.attemptCount} attempt(s), ${formatDuration(detail.durationSeconds)}.`,
    `Workflow ${detail.workflowId ?? 'unknown'}${detail.workflowName === undefined ? '' : ` "${truncateText(detail.workflowName, LABEL_CHAR_LIMIT).text}"`} is ${detail.workflowStatus ?? 'in an unknown state'}; run ${detail.runId ?? 'unknown'} is ${detail.runStatus ?? 'in an unknown state'}${detail.repo === undefined ? '' : ` (${detail.repo})`}.`,
  ];
  if (errorMessage !== undefined) {
    lines.push(`Last error (untrusted CI content): ${errorMessage}`);
  }
  return {
    detail,
    preview: {
      data: {
        jobId: detail.jobId ?? jobId,
        label: label(detail),
        state: nodeState(detail),
        status: detail.status,
        conclusion: detail.conclusion,
        errorMessage,
        runId: detail.runId,
        runStatus: detail.runStatus,
        workflowId: detail.workflowId,
        workflowName: detail.workflowName,
        workflowStatus: detail.workflowStatus,
        attemptCount: detail.attemptCount,
        durationSeconds: detail.durationSeconds,
      },
      lines,
    },
  };
}

function refuseRunMismatch(
  expected: string | undefined,
  actual: string | undefined,
  what: string,
): string | undefined {
  if (expected !== undefined && actual !== undefined && expected !== actual) {
    return `${what} belongs to run ${actual}, not to run ${expected} as the arguments claim. Check the ids with depot_get_ci_run.`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------

export const cancelCiRunTool = defineWriteTool({
  name: 'depot_cancel_ci_run',
  title: 'Cancel a Depot CI run or workflow',
  description: `Cancel a queued or running Depot CI run (CancelRun) and every unfinished workflow and job under it, or, when workflowId is given, cancel just that workflow (CancelWorkflow) and its jobs.

Use this when a run is known to be wasted: a superseded commit, a job stuck waiting, a workflow started by mistake. Cancelling is idempotent but not reversible; finished work is kept, unfinished jobs stop and report cancelled.

Refuses a run or workflow that is already finished, failed, or cancelled (nothing to cancel), and a workflowId that does not belong to the given runId.`,
  inputSchema: {
    runId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The run to cancel, as returned by depot_list_ci_runs. Required unless workflowId is given; with workflowId it is only cross-checked.',
      ),
    workflowId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Cancel only this workflow (and its jobs) instead of the whole run. Other workflows in the run keep going.',
      ),
  },
  previewSchema: {
    target: z.enum(['run', 'workflow']),
    runId: z.string().optional(),
    workflowId: z.string().optional(),
    name: z.string().optional(),
    status: z.string().optional(),
    workflowCount: z.number(),
    jobCount: z.number(),
    activeJobCount: z.number(),
    activeJobs: z.array(jobRowSchema),
  },
  afterSchema,
  destructive: true,
  idempotent: true,
  preview: async (input, context) => {
    if (input.workflowId === undefined && input.runId === undefined) {
      throw new ToolInputError('Pass runId to cancel a run, or workflowId to cancel one workflow.');
    }

    if (input.workflowId !== undefined) {
      const { detail } = await workflowPreview(input.workflowId, context);
      const active = detail.jobs.filter((job) => isActiveState(job.status));
      const lines = [
        `Workflow ${detail.workflowId ?? input.workflowId}${detail.name === undefined ? '' : ` "${truncateText(detail.name, LABEL_CHAR_LIMIT).text}"`} is ${detail.status ?? 'in an unknown state'}; run ${detail.runId ?? 'unknown'} is ${detail.runStatus ?? 'in an unknown state'}${detail.repo === undefined ? '' : ` (${detail.repo})`}.`,
        `Jobs: ${detail.jobs.length} total, ${active.length} would be stopped.`,
        ...active.slice(0, JOB_LIST_LIMIT).map((job) => `  active: ${label(job)} ${nodeState(job)}`),
      ];
      return {
        data: {
          target: 'workflow' as const,
          runId: detail.runId,
          workflowId: detail.workflowId ?? input.workflowId,
          name: detail.name,
          status: detail.status,
          workflowCount: 1,
          jobCount: detail.jobs.length,
          activeJobCount: active.length,
          activeJobs: active.slice(0, JOB_LIST_LIMIT).map(jobRow),
        },
        lines,
      };
    }

    const runId = input.runId ?? '';
    const tree = parseRunTree(await context.api.getRunStatus(runId));
    const jobs = tree.workflows.flatMap((workflow) => workflow.jobs);
    const active = jobs.filter((job) => isActiveState(job.status));
    const lines = [
      `Run ${tree.runId ?? runId} is ${tree.status ?? 'in an unknown state'} with ${tree.workflows.length} workflow(s) and ${jobs.length} job(s); ${active.length} job(s) would be stopped.`,
      ...tree.workflows.map(
        (workflow) =>
          `  workflow "${workflow.name ?? 'unnamed'}" ${workflow.status ?? 'unknown'}${workflow.workflowId === undefined ? '' : ` (workflowId=${workflow.workflowId})`}`,
      ),
      ...active.slice(0, JOB_LIST_LIMIT).map((job) => `  active: ${label(job)} ${nodeState(job)}`),
    ];
    return {
      data: {
        target: 'run' as const,
        runId: tree.runId ?? runId,
        status: tree.status,
        workflowCount: tree.workflows.length,
        jobCount: jobs.length,
        activeJobCount: active.length,
        activeJobs: active.slice(0, JOB_LIST_LIMIT).map(jobRow),
      },
      lines,
    };
  },
  refuse: (preview, input) => {
    const id = preview.target === 'run' ? preview.runId : preview.workflowId;
    if (isTerminalState(preview.status)) {
      return `The ${preview.target} ${id ?? ''} is already ${preview.status ?? 'finished'}; there is nothing to cancel.`;
    }
    if (preview.target === 'workflow') {
      return refuseRunMismatch(input.runId, preview.runId, `Workflow ${preview.workflowId ?? ''}`);
    }
    return undefined;
  },
  apply: async (input, context, preview) => {
    if (preview.target === 'workflow') {
      const workflowId = preview.workflowId ?? input.workflowId ?? '';
      return afterFromResponse('CancelWorkflow', await context.api.cancelWorkflow(workflowId));
    }
    const runId = preview.runId ?? input.runId ?? '';
    return afterFromResponse('CancelRun', await context.api.cancelRun(runId));
  },
});

export const cancelCiJobTool = defineWriteTool({
  name: 'depot_cancel_ci_job',
  title: 'Cancel one Depot CI job',
  description: `Cancel a single queued or running Depot CI job (CancelJob), leaving the rest of its workflow and run untouched.

Use this for one stuck or pointless job, for example a matrix entry that is hanging, when the rest of the run should finish. To stop everything, use depot_cancel_ci_run instead. Cancelling is idempotent but not reversible.

Refuses a job that is already finished, failed, cancelled, or skipped, and a job that does not belong to the given runId.`,
  inputSchema: {
    jobId: jobIdField,
    runId: z
      .string()
      .min(1)
      .optional()
      .describe('Optional cross-check: the run this job is expected to belong to. A mismatch is refused.'),
  },
  previewSchema: jobPreviewSchema,
  afterSchema,
  destructive: true,
  idempotent: true,
  preview: async (input, context) => (await jobPreview(input.jobId, context)).preview,
  refuse: (preview, input) => {
    if (isTerminalState(preview.status) || isTerminalState(preview.conclusion)) {
      return `Job ${preview.label} is already ${preview.state}; there is nothing to cancel.`;
    }
    return refuseRunMismatch(input.runId, preview.runId, `Job ${preview.label}`);
  },
  apply: async (input, context) =>
    afterFromResponse('CancelJob', await context.api.cancelJob(input.jobId)),
});

export const retryCiFailedJobsTool = defineWriteTool({
  name: 'depot_retry_ci_failed_jobs',
  title: 'Retry the failed jobs of a Depot CI workflow',
  description: `Retry only the failed and cancelled jobs of a finished Depot CI workflow (RetryFailedJobs). Successful jobs are kept; each retried job gets a new attempt, so this costs compute for the failed subset only.

This is the right tool for "try CI again" after a flaky failure. It is cheaper than depot_rerun_ci_workflow, which reruns every job. Pass workflowId, or runId when the run has exactly one workflow. Each call creates new attempts, so it is not idempotent.

Refuses a workflow that is still running, a workflow with no failed or cancelled jobs, a run with several workflows (pass the workflowId), and, unless force:true, a workflow in which any failed job has already run ${RETRY_ATTEMPT_CAP} or more times.`,
  inputSchema: {
    workflowId: z
      .string()
      .min(1)
      .optional()
      .describe('The workflow whose failed jobs to retry. Takes precedence over runId when both are given.'),
    runId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Alternative to workflowId: a run that contains exactly one workflow. A run with several workflows is refused with their ids.',
      ),
    force: z
      .boolean()
      .default(false)
      .describe(
        `Retry even when a failed job has already run ${RETRY_ATTEMPT_CAP} or more times. Off by default because repeated retries without a change rarely pass.`,
      ),
  },
  previewSchema: workflowPreviewSchema,
  afterSchema,
  destructive: false,
  idempotent: false,
  preview: async (input, context) => {
    let workflowId = input.workflowId;
    if (workflowId === undefined) {
      if (input.runId === undefined) {
        throw new ToolInputError('Pass workflowId, or runId for a run with exactly one workflow.');
      }
      const tree = parseRunTree(await context.api.getRunStatus(input.runId));
      const ids = tree.workflows
        .map((workflow) => workflow.workflowId)
        .filter((id): id is string => id !== undefined);
      if (ids.length !== 1) {
        const listed = tree.workflows
          .map((workflow) => `${workflow.workflowId ?? 'unknown id'} ("${workflow.name ?? 'unnamed'}", ${workflow.status ?? 'unknown'})`)
          .join('; ');
        throw new ToolInputError(
          ids.length === 0
            ? `Run ${input.runId} has no workflows with ids, so there is nothing to retry. Check it with depot_get_ci_run.`
            : `Run ${input.runId} has ${tree.workflows.length} workflows, so the target is ambiguous. Pass workflowId for one of: ${listed}.`,
        );
      }
      workflowId = ids[0] ?? '';
    }
    const { preview } = await workflowPreview(workflowId, context);
    preview.lines.push(
      `RetryFailedJobs would create a new attempt for each of the ${preview.data.failedJobCount} failed job(s) and leave the rest as they are.`,
    );
    return preview;
  },
  refuse: (preview, input) => {
    const running = refuseRunningWorkflow(preview);
    if (running !== undefined) {
      return running;
    }
    if (preview.failedJobCount === 0) {
      return `Workflow ${preview.workflowId ?? ''} has no failed or cancelled jobs (${preview.jobCount} job(s), all ${preview.status ?? 'done'}); there is nothing to retry. Use depot_rerun_ci_workflow to run everything again.`;
    }
    return refuseAttemptCap(preview.failedJobs, input.force);
  },
  apply: async (input, context, preview) => {
    const workflowId = preview.workflowId ?? input.workflowId ?? '';
    return afterFromResponse('RetryFailedJobs', await context.api.retryFailedJobs(workflowId));
  },
});

export const retryCiJobTool = defineWriteTool({
  name: 'depot_retry_ci_job',
  title: 'Retry one failed Depot CI job',
  description: `Retry a single failed or cancelled Depot CI job (RetryJob), creating a new attempt of that job only. Nothing else in the workflow runs again.

This is the narrowest retry: use it when exactly one job is known to be flaky. For every failed job in a workflow, use depot_retry_ci_failed_jobs; for the whole workflow, depot_rerun_ci_workflow. Each call creates a new attempt, so it is not idempotent.

Refuses a job that did not fail or get cancelled (nothing to retry, or still running), and, unless force:true, a job that has already run ${RETRY_ATTEMPT_CAP} or more times.`,
  inputSchema: {
    jobId: jobIdField,
    force: z
      .boolean()
      .default(false)
      .describe(
        `Retry even when the job has already run ${RETRY_ATTEMPT_CAP} or more times. Off by default because repeated retries without a change rarely pass.`,
      ),
  },
  previewSchema: jobPreviewSchema,
  afterSchema,
  destructive: false,
  idempotent: false,
  preview: async (input, context) => {
    const { preview } = await jobPreview(input.jobId, context);
    preview.lines.push(`RetryJob would start attempt ${preview.data.attemptCount + 1} of this job.`);
    return preview;
  },
  refuse: (preview, input) => {
    if (!isFailedJob(preview)) {
      return isActiveState(preview.status)
        ? `Job ${preview.label} is still ${preview.state}; only a failed or cancelled job can be retried. Wait for it, or cancel it with depot_cancel_ci_job.`
        : `Job ${preview.label} is ${preview.state}, not failed or cancelled, so there is nothing to retry.`;
    }
    return refuseAttemptCap([{ label: preview.label, state: preview.state, attemptCount: preview.attemptCount }], input.force);
  },
  apply: async (input, context) =>
    afterFromResponse('RetryJob', await context.api.retryJob(input.jobId)),
});

export const rerunCiWorkflowTool = defineWriteTool({
  name: 'depot_rerun_ci_workflow',
  title: 'Rerun a whole Depot CI workflow',
  description: `Rerun every job of a finished Depot CI workflow (RerunWorkflow), successful ones included. Depot resets each terminal job and starts a new execution, so this costs the workflow's full compute again.

Prefer depot_retry_ci_failed_jobs, which reruns only what failed; this tool is for cases where the passing jobs must run again too (a changed secret or variable, a suspected bad cache, a green workflow that needs a fresh artifact). The preview reports the job count and the previous execution's wall time so the cost is visible. Each call creates a new execution, so it is not idempotent.

Refuses a workflow that is still running, and, unless allowFullRerun:true, a workflow that has failed jobs, pointing at depot_retry_ci_failed_jobs instead.`,
  inputSchema: {
    workflowId: workflowIdField,
    allowFullRerun: z
      .boolean()
      .default(false)
      .describe(
        'Rerun every job even though some failed and depot_retry_ci_failed_jobs would rerun only those. Off by default to avoid paying for jobs that already passed.',
      ),
  },
  previewSchema: workflowPreviewSchema,
  afterSchema,
  destructive: false,
  idempotent: false,
  preview: async (input, context) => {
    const { preview } = await workflowPreview(input.workflowId, context);
    preview.lines.push(
      `RerunWorkflow would start execution ${preview.data.executionCount + 1}, running all ${preview.data.jobCount} job(s) again; the previous execution took ${formatDuration(preview.data.previousDurationSeconds)}.`,
    );
    return preview;
  },
  refuse: (preview, input) => {
    const running = refuseRunningWorkflow(preview);
    if (running !== undefined) {
      return running;
    }
    if (preview.failedJobCount > 0 && !input.allowFullRerun) {
      return `Workflow ${preview.workflowId ?? ''} has ${preview.failedJobCount} failed job(s) out of ${preview.jobCount}. depot_retry_ci_failed_jobs {"workflowId":"${preview.workflowId ?? ''}"} reruns only those; a full rerun would also repeat the ${preview.jobCount - preview.failedJobCount} that passed. Pass allowFullRerun:true if that is really wanted.`;
    }
    return undefined;
  },
  apply: async (input, context) =>
    afterFromResponse('RerunWorkflow', await context.api.rerunWorkflow(input.workflowId)),
});
