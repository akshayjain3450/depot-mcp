import { z } from 'zod';
import { formatCount, TextBudget } from '../lib/budget.js';
import { countJobs, isFailureState } from '../lib/ci-tree.js';
import { isJobTerminal, waitForRun } from '../lib/ci-wait.js';
import { formatDuration } from '../lib/time.js';
import { defineTool } from '../lib/tool.js';

const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 300;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_POLL_SECONDS = 2;
const MAX_POLL_SECONDS = 30;
const DEFAULT_POLL_SECONDS = 5;

const nodeChangeSchema = z.object({
  kind: z.enum(['run', 'workflow', 'job', 'attempt']),
  id: z.string(),
  name: z.string().optional(),
  from: z.string().optional().describe('State in the first snapshot; absent if the node was new.'),
  to: z.string().optional().describe('State in the last snapshot; absent if the node disappeared.'),
});

export const waitForCiRunTool = defineTool({
  name: 'depot_wait_for_ci_run',
  title: 'Wait for a Depot CI run to finish',
  description: `Wait, for a bounded time, until a Depot CI run (or one job in it) reaches a terminal state, then report the outcome and which nodes changed state while waiting.

Use this after a push or a rerun when the next step depends on the result: "wait for the run to finish, then diagnose it if it failed". Pass untilJobKey to return as soon as one job is done instead of the whole run, for example the test job when the deploy job behind it does not matter yet.

This is bounded polling, not a stream. It calls GetRunStatus every pollSeconds until the run is finished, failed, or cancelled, or until timeoutSeconds is spent, whichever comes first, then returns. It never subscribes to Depot's log or status streams. If the result says timedOut=true the run is still going: call this tool again with the same runId to keep waiting; the changes list shows what moved in the meantime. Keep timeoutSeconds below your MCP client's own tool-call timeout, or the client will give up before this tool does.

A run that is already finished returns immediately after one poll, so this is also a cheap way to check "is it done yet". For the run's structure use depot_get_ci_run; for why it failed use depot_diagnose_ci_failure.`,
  inputSchema: {
    runId: z.string().trim().min(1).describe('The run id to wait on, as returned by depot_list_ci_runs.'),
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
        'Return as soon as this job reaches a terminal state, even if the run is still going. Accepts the job key, display name, or job id as shown by depot_get_ci_run.',
      ),
  },
  outputSchema: {
    runId: z.string().optional(),
    outcome: z
      .enum(['run_terminal', 'job_terminal', 'timed_out'])
      .describe('Why the wait ended: the run finished, the named job finished, or the timeout expired.'),
    timedOut: z.boolean(),
    status: z.string().optional().describe('Run status at the last poll.'),
    initialStatus: z.string().optional().describe('Run status at the first poll.'),
    failed: z.boolean().describe('True when the run ended in failed or cancelled.'),
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
      .describe('The job named by untilJobKey, when it was found in the run.'),
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
    const result = await waitForRun({
      api: context.api,
      sleep: context.sleep,
      now: context.now,
      runId: input.runId,
      timeoutMs: input.timeoutSeconds * 1000,
      pollMs: input.pollSeconds * 1000,
      untilJobKey: input.untilJobKey,
    });

    const runId = result.last.runId ?? input.runId;
    const status = result.last.status;
    const counts = countJobs(result.last);
    const elapsedSeconds = Math.round(result.elapsedMs / 1000);
    const timedOut = result.outcome === 'timed_out';
    const failed = isFailureState(status);
    const notes: string[] = [];
    const job =
      result.job === undefined
        ? undefined
        : {
            jobId: result.job.jobId,
            key: result.job.key,
            displayName: result.job.displayName,
            status: result.job.status,
            conclusion: result.job.conclusion,
            terminal: isJobTerminal(result.job),
          };

    if (input.untilJobKey !== undefined && result.job === undefined) {
      notes.push(
        `No job matching "${input.untilJobKey}" appeared in the run while waiting, so the wait covered the whole run. depot_get_ci_run lists the job keys.`,
      );
    }

    const text = new TextBudget(context.config.outputCharBudget);
    const waited = `after ${formatDuration(elapsedSeconds)} and ${formatCount(result.polls, 'poll')}`;
    if (timedOut) {
      text.push(
        `Timed out ${waited}: run ${runId} is still ${status ?? 'in an unknown state'} (${counts.total} job(s), ${counts.failed} failed so far).`,
        `The run has not finished. Call depot_wait_for_ci_run again with runId="${runId}" to keep waiting; nothing was cancelled.`,
      );
    } else if (result.outcome === 'job_terminal' && job !== undefined) {
      text.push(
        `Job "${job.displayName ?? job.key ?? job.jobId ?? input.untilJobKey ?? ''}" reached ${job.conclusion ?? job.status ?? 'a terminal state'} ${waited}; run ${runId} is ${status ?? 'unknown'} overall (${counts.total} job(s), ${counts.failed} failed).`,
      );
    } else {
      text.push(
        `Run ${runId} ${status ?? 'ended'} ${waited}: ${counts.total} job(s), ${counts.failed} failed.`,
      );
    }

    if (result.changes.length === 0) {
      text.push(
        result.polls === 1
          ? 'The run was already in this state on the first poll, so nothing changed while waiting.'
          : 'No node changed state between the first and last poll.',
      );
    } else {
      text.push('', `${formatCount(result.changes.length, 'node')} changed state while waiting:`);
      for (const change of result.changes) {
        const label = change.name === undefined ? change.id : `${change.name} (${change.id})`;
        text.push(`  ${change.kind} ${label}: ${change.from ?? 'absent'} -> ${change.to ?? 'absent'}`);
      }
    }

    if (failed || counts.failed > 0) {
      text.push('', `Explain the failure with depot_diagnose_ci_failure {"id":"${runId}"}.`);
    }
    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }

    return {
      summary: text.render(),
      data: {
        runId,
        outcome: result.outcome,
        timedOut,
        status,
        initialStatus: result.first.status,
        failed,
        job,
        jobCount: counts.total,
        failedJobCount: counts.failed,
        polls: result.polls,
        elapsedSeconds,
        timeoutSeconds: input.timeoutSeconds,
        pollSeconds: input.pollSeconds,
        changes: result.changes,
        notes,
      },
    };
  },
});
