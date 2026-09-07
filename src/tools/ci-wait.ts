import { z } from 'zod';
import { formatCount, TextBudget } from '../lib/budget.js';
import { quoteName } from '../lib/ci-detail.js';
import { countJobs, isFailureState, type JobNode, type RunTree } from '../lib/ci-tree.js';
import {
  isJobTerminal,
  waitForRun,
  waitForWorkflow,
  type NodeChange,
  type WaitOutcome,
} from '../lib/ci-wait.js';
import { formatDuration } from '../lib/time.js';
import { defineTool, ToolInputError, type ToolContext } from '../lib/tool.js';

const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_POLL_SECONDS = 2;
const MAX_POLL_SECONDS = 30;
const DEFAULT_POLL_SECONDS = 5;

const nodeChangeSchema = z.object({
  kind: z.enum(['run', 'workflow', 'execution', 'job', 'attempt']),
  id: z.string(),
  name: z.string().optional(),
  from: z.string().optional().describe('State in the first snapshot; absent if the node was new.'),
  to: z.string().optional().describe('State in the last snapshot; absent if the node disappeared.'),
});

const executionPositionSchema = z.object({
  number: z.number().optional().describe('The latest execution number Depot reported.'),
  count: z.number().describe('How many executions the workflow has had, reruns included.'),
  status: z.string().optional().describe('Status of the latest execution at the last poll.'),
});

type ExecutionPosition = z.input<typeof executionPositionSchema>;

/** What both targets have in common once polled, so one report serves a run and a workflow. */
interface Watched {
  readonly target: 'run' | 'workflow';
  /** The run id, or the workflow id when watching a workflow. */
  readonly id: string;
  readonly name: string | undefined;
  readonly outcome: WaitOutcome;
  readonly status: string | undefined;
  readonly initialStatus: string | undefined;
  readonly last: RunTree;
  readonly job: JobNode | undefined;
  readonly polls: number;
  readonly elapsedMs: number;
  readonly changes: NodeChange[];
  readonly runId: string | undefined;
  readonly workflowId: string | undefined;
  readonly execution: ExecutionPosition | undefined;
}

interface WatchInput {
  readonly runId: string | undefined;
  readonly workflowId: string | undefined;
  readonly untilJobKey: string | undefined;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

async function watch(input: WatchInput, context: ToolContext): Promise<Watched> {
  const timing = {
    sleep: context.sleep,
    now: context.now,
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs,
    untilJobKey: input.untilJobKey,
  };

  if (input.workflowId !== undefined) {
    const result = await waitForWorkflow({
      ...timing,
      api: context.api,
      workflowId: input.workflowId,
      expectedRunId: input.runId,
    });
    const { first, last } = result;
    return {
      target: 'workflow',
      id: last.workflowId ?? input.workflowId,
      name: last.name,
      outcome: result.outcome,
      status: last.latest?.status ?? last.status,
      initialStatus: first.latest?.status ?? first.status,
      last: last.tree,
      job: result.job,
      polls: result.polls,
      elapsedMs: result.elapsedMs,
      changes: result.changes,
      runId: last.runId ?? input.runId,
      workflowId: last.workflowId ?? input.workflowId,
      execution:
        last.latest === undefined
          ? undefined
          : { number: last.latest.execution, count: last.executions.length, status: last.latest.status },
    };
  }

  if (input.runId === undefined) {
    throw new ToolInputError(
      'Pass runId to wait for a run, or workflowId to wait for one workflow (the thing to watch after depot_rerun_ci_workflow or depot_retry_ci_failed_jobs).',
    );
  }
  const result = await waitForRun({ ...timing, api: context.api, runId: input.runId });
  return {
    target: 'run',
    id: result.last.runId ?? input.runId,
    name: undefined,
    outcome: result.outcome,
    status: result.last.status,
    initialStatus: result.first.status,
    last: result.last,
    job: result.job,
    polls: result.polls,
    elapsedMs: result.elapsedMs,
    changes: result.changes,
    runId: result.last.runId ?? input.runId,
    workflowId: undefined,
    execution: undefined,
  };
}

function describeExecution(execution: ExecutionPosition | undefined): string {
  return execution === undefined ? '' : ` on execution ${execution.number ?? execution.count} of ${execution.count}`;
}

export const waitForCiRunTool = defineTool({
  name: 'depot_wait_for_ci_run',
  title: 'Wait for a Depot CI run or workflow to finish',
  description: `Wait, for a bounded time, until a Depot CI run, one workflow in it, or one job reaches a terminal state, then report the outcome and which nodes changed state while waiting.

Use this after a push or a rerun when the next step depends on the result: "wait for the run to finish, then diagnose it if it failed". Pass runId to watch a whole run. Pass workflowId to watch one workflow: this is what to do after depot_rerun_ci_workflow or depot_retry_ci_failed_jobs, which start a new execution of the same workflow rather than a new run; the wait ends when the latest execution is terminal. With both ids the workflow is watched and must belong to that run. Pass untilJobKey to return as soon as one job is done instead of the whole target, for example the test job when the deploy job behind it does not matter yet.

This is bounded polling, not a stream. It calls GetRunStatus (or GetWorkflow) every pollSeconds until the target is finished, failed, or cancelled, or until timeoutSeconds is spent, whichever comes first, then returns. It never subscribes to Depot's log or status streams. If the result says timedOut=true the target is still going: call this tool again with the same id to keep waiting; the changes list shows what moved in the meantime. Keep timeoutSeconds below your MCP client's own tool-call timeout, or the client will give up before this tool does.

A run or workflow that is already finished returns immediately after one poll, so this is also a cheap way to check "is it done yet". For the structure use depot_get_ci_run or depot_get_ci_workflow; for why it failed use depot_diagnose_ci_failure.`,
  inputSchema: {
    runId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'The run id to wait on, as returned by depot_list_ci_runs. Required unless workflowId is given; with workflowId it is only cross-checked.',
      ),
    workflowId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Wait for this workflow instead of a whole run, as shown by depot_get_ci_run (workflowId=...) or returned by depot_rerun_ci_workflow. The wait ends when its latest execution is terminal.',
      ),
    timeoutSeconds: z
      .number()
      .int()
      .min(MIN_TIMEOUT_SECONDS)
      .max(MAX_TIMEOUT_SECONDS)
      .default(DEFAULT_TIMEOUT_SECONDS)
      .describe(
        `Longest this call may wait, ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} seconds. On expiry the tool returns timedOut=true rather than an error; call again to keep waiting.`,
      ),
    pollSeconds: z
      .number()
      .int()
      .min(MIN_POLL_SECONDS)
      .max(MAX_POLL_SECONDS)
      .default(DEFAULT_POLL_SECONDS)
      .describe(
        `Seconds between status requests, ${MIN_POLL_SECONDS} to ${MAX_POLL_SECONDS}. Each poll is one request to Depot; lower values give faster answers at the cost of more requests.`,
      ),
    untilJobKey: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Return as soon as this job reaches a terminal state, even if the run or workflow is still going. Accepts the job key, display name, or job id as shown by depot_get_ci_run.',
      ),
  },
  outputSchema: {
    runId: z.string().optional(),
    workflowId: z.string().optional().describe('Present when a workflow was watched.'),
    outcome: z
      .enum(['run_terminal', 'workflow_terminal', 'job_terminal', 'timed_out'])
      .describe(
        'Why the wait ended: the run finished, the workflow (its latest execution) finished, the named job finished, or the timeout expired.',
      ),
    timedOut: z.boolean(),
    status: z
      .string()
      .optional()
      .describe('Status of the watched run, or of the latest execution of the watched workflow, at the last poll.'),
    initialStatus: z.string().optional().describe('The same status at the first poll.'),
    failed: z.boolean().describe('True when the target ended in failed or cancelled.'),
    execution: executionPositionSchema
      .optional()
      .describe('When watching a workflow: which execution the wait followed.'),
    job: z
      .object({
        jobId: z.string().optional(),
        key: z.string().optional(),
        displayName: z.string().optional(),
        status: z.string().optional(),
        conclusion: z.string().optional(),
        terminal: z.boolean(),
      })
      .optional()
      .describe('The job named by untilJobKey, when it was found.'),
    jobCount: z.number(),
    failedJobCount: z.number(),
    polls: z.number(),
    elapsedSeconds: z.number(),
    timeoutSeconds: z.number(),
    pollSeconds: z.number(),
    changes: z.array(nodeChangeSchema).describe('Nodes whose state differs between the first and last poll.'),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    const watched = await watch(
      {
        runId: input.runId,
        workflowId: input.workflowId,
        untilJobKey: input.untilJobKey,
        timeoutMs: input.timeoutSeconds * 1000,
        pollMs: input.pollSeconds * 1000,
      },
      context,
    );

    const { status } = watched;
    const counts = countJobs(watched.last);
    const elapsedSeconds = Math.round(watched.elapsedMs / 1000);
    const timedOut = watched.outcome === 'timed_out';
    const failed = isFailureState(status);
    const notes: string[] = [];
    const job =
      watched.job === undefined
        ? undefined
        : {
            jobId: watched.job.jobId,
            key: watched.job.key,
            displayName: watched.job.displayName,
            status: watched.job.status,
            conclusion: watched.job.conclusion,
            terminal: isJobTerminal(watched.job),
          };

    const structure = watched.target === 'run' ? 'depot_get_ci_run' : 'depot_get_ci_workflow';
    if (input.untilJobKey !== undefined && watched.job === undefined) {
      notes.push(
        `No job matching "${input.untilJobKey}" appeared in the ${watched.target} while waiting, so the wait covered the whole ${watched.target}. ${structure} lists the job keys.`,
      );
    }

    // "run run_x" or "workflow wf_y ("CI")": the same sentence shapes serve both targets.
    const label =
      watched.target === 'run'
        ? `run ${watched.id}`
        : `workflow ${watched.id}${watched.name === undefined ? '' : ` (${quoteName(watched.name, '')})`}`;
    const idArgument =
      watched.target === 'run' ? `runId="${watched.id}"` : `workflowId="${watched.id}"`;
    const position = describeExecution(watched.execution);

    const text = new TextBudget(context.config.outputCharBudget);
    const waited = `after ${formatDuration(elapsedSeconds)} and ${formatCount(watched.polls, 'poll')}`;
    if (timedOut) {
      text.push(
        `Timed out ${waited}: ${label} is still ${status ?? 'in an unknown state'}${position} (${counts.total} job(s), ${counts.failed} failed so far).`,
        `The ${watched.target} has not finished. Call depot_wait_for_ci_run again with ${idArgument} to keep waiting; nothing was cancelled.`,
      );
    } else if (watched.outcome === 'job_terminal' && job !== undefined) {
      text.push(
        `Job "${job.displayName ?? job.key ?? job.jobId ?? input.untilJobKey ?? ''}" reached ${job.conclusion ?? job.status ?? 'a terminal state'} ${waited}; ${label} is ${status ?? 'unknown'} overall${position} (${counts.total} job(s), ${counts.failed} failed).`,
      );
    } else {
      text.push(
        `${label.charAt(0).toUpperCase()}${label.slice(1)} ${status ?? 'ended'} ${waited}${position}: ${counts.total} job(s), ${counts.failed} failed.`,
      );
    }

    if (watched.changes.length === 0) {
      text.push(
        watched.polls === 1
          ? `The ${watched.target} was already in this state on the first poll, so nothing changed while waiting.`
          : 'No node changed state between the first and last poll.',
      );
    } else {
      text.push('', `${formatCount(watched.changes.length, 'node')} changed state while waiting:`);
      for (const change of watched.changes) {
        const name = change.name === undefined ? change.id : `${change.name} (${change.id})`;
        text.push(`  ${change.kind} ${name}: ${change.from ?? 'absent'} -> ${change.to ?? 'absent'}`);
      }
    }

    if (failed || counts.failed > 0) {
      const target = watched.target === 'run' ? '' : ',"targetType":"workflow"';
      text.push('', `Explain the failure with depot_diagnose_ci_failure {"id":"${watched.id}"${target}}.`);
    }
    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }

    return {
      summary: text.render(),
      data: {
        runId: watched.runId,
        workflowId: watched.workflowId,
        outcome: watched.outcome,
        timedOut,
        status,
        initialStatus: watched.initialStatus,
        failed,
        execution: watched.execution,
        job,
        jobCount: counts.total,
        failedJobCount: counts.failed,
        polls: watched.polls,
        elapsedSeconds,
        timeoutSeconds: input.timeoutSeconds,
        pollSeconds: input.pollSeconds,
        changes: watched.changes,
        notes,
      },
    };
  },
});
