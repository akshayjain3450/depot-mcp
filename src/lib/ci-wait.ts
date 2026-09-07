import type { DepotApi } from '../depot/api.js';
import { parseRunTree, type JobNode, type RunTree } from './ci-tree.js';
import { latestExecution } from './ci-workflow.js';
import {
  parseWorkflowDetail,
  type WorkflowDetail,
  type WorkflowExecution,
} from './ci-write-detail.js';
import { ToolInputError } from './tool.js';

/**
 * Depot documents run status as queued | running | finished | failed | cancelled. The extra
 * spellings cover the conclusion-style values `ci-tree` normalises jobs and attempts to, so one
 * predicate serves every level of the tree.
 */
const TERMINAL_STATES = new Set([
  'finished',
  'failed',
  'failure',
  'cancelled',
  'canceled',
  'success',
  'succeeded',
  'error',
  'timed_out',
  'skipped',
  'completed',
]);

export function isTerminalState(state: string | undefined): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

/** A job is done when its status is terminal or Depot has recorded a conclusion for it. */
export function isJobTerminal(job: JobNode): boolean {
  return isTerminalState(job.status) || job.conclusion !== undefined;
}

/** Accepts the job key, its display name, or its id, since agents quote whichever they saw last. */
export function findJob(tree: RunTree, key: string): JobNode | undefined {
  for (const workflow of tree.workflows) {
    for (const job of workflow.jobs) {
      if (job.key === key || job.displayName === key || job.jobId === key) {
        return job;
      }
    }
  }
  return undefined;
}

export type NodeKind = 'run' | 'workflow' | 'execution' | 'job' | 'attempt';

export interface NodeChange {
  readonly kind: NodeKind;
  readonly id: string;
  readonly name: string | undefined;
  /** Undefined when the node was not in the first snapshot. */
  readonly from: string | undefined;
  /** Undefined when the node is no longer in the last snapshot. */
  readonly to: string | undefined;
}

interface NodeState {
  readonly kind: NodeKind;
  readonly name: string | undefined;
  readonly state: string | undefined;
}

type NodeMap = Map<string, NodeState>;

function flattenTree(tree: RunTree): NodeMap {
  const nodes: NodeMap = new Map();
  nodes.set(`run:${tree.runId ?? ''}`, { kind: 'run', name: undefined, state: tree.status });
  for (const [workflowIndex, workflow] of tree.workflows.entries()) {
    nodes.set(`workflow:${workflow.workflowId ?? `#${workflowIndex}`}`, {
      kind: 'workflow',
      name: workflow.name,
      state: workflow.status,
    });
    for (const [jobIndex, job] of workflow.jobs.entries()) {
      const jobId = job.jobId ?? job.key ?? `#${workflowIndex}.${jobIndex}`;
      nodes.set(`job:${jobId}`, {
        kind: 'job',
        name: job.displayName ?? job.key,
        state: job.conclusion ?? job.status,
      });
      for (const [attemptIndex, attempt] of job.attempts.entries()) {
        nodes.set(`attempt:${attempt.attemptId ?? `${jobId}#${attemptIndex}`}`, {
          kind: 'attempt',
          name: `${job.displayName ?? job.key ?? jobId} attempt ${attempt.attempt ?? attemptIndex + 1}`,
          state: attempt.conclusion ?? attempt.status,
        });
      }
    }
  }
  return nodes;
}

/** Every node whose state differs between two flattened snapshots, in the order of the later one. */
function diffNodes(before: NodeMap, after: NodeMap): NodeChange[] {
  const changes: NodeChange[] = [];
  for (const [key, node] of after) {
    const previous = before.get(key);
    if (previous === undefined || previous.state !== node.state) {
      changes.push({
        kind: node.kind,
        id: key.slice(key.indexOf(':') + 1),
        name: node.name,
        from: previous?.state,
        to: node.state,
      });
    }
  }
  for (const [key, node] of before) {
    if (!after.has(key)) {
      changes.push({
        kind: node.kind,
        id: key.slice(key.indexOf(':') + 1),
        name: node.name,
        from: node.state,
        to: undefined,
      });
    }
  }
  return changes;
}

/** Every node whose state differs between two snapshots, in tree order of the later one. */
export function diffTrees(first: RunTree, last: RunTree): NodeChange[] {
  return diffNodes(flattenTree(first), flattenTree(last));
}

export type WaitOutcome = 'run_terminal' | 'workflow_terminal' | 'job_terminal' | 'timed_out';

interface PollOptions<TSnapshot> {
  /** One read of the watched thing; each call is an ordinary unary RPC. */
  readonly fetch: () => Promise<TSnapshot>;
  /** The outcome that ends the wait, or undefined to keep polling. */
  readonly settled: (snapshot: TSnapshot) => WaitOutcome | undefined;
  readonly diff: (first: TSnapshot, last: TSnapshot) => NodeChange[];
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

export interface PollResult<TSnapshot> {
  readonly outcome: WaitOutcome;
  readonly first: TSnapshot;
  readonly last: TSnapshot;
  readonly polls: number;
  readonly elapsedMs: number;
  readonly changes: NodeChange[];
}

/**
 * Polls `fetch` until `settled` names an outcome or the timeout is spent. Sleeps never total
 * more than `timeoutMs` and no poll starts after the deadline, so the call returns within the
 * timeout plus the duration of one request. Nothing here streams.
 */
async function pollUntil<TSnapshot>(options: PollOptions<TSnapshot>): Promise<PollResult<TSnapshot>> {
  const start = options.now();
  const deadline = start + options.timeoutMs;
  let polls = 0;
  let first: TSnapshot | undefined;

  for (;;) {
    const snapshot = await options.fetch();
    polls += 1;
    const initial = first ?? snapshot;
    first = initial;

    const finish = (outcome: WaitOutcome): PollResult<TSnapshot> => ({
      outcome,
      first: initial,
      last: snapshot,
      polls,
      elapsedMs: Math.max(0, options.now() - start),
      changes: options.diff(initial, snapshot),
    });

    const outcome = options.settled(snapshot);
    if (outcome !== undefined) {
      return finish(outcome);
    }
    const remaining = deadline - options.now();
    if (remaining <= 0) {
      return finish('timed_out');
    }
    await options.sleep(Math.min(options.pollMs, remaining));
  }
}

interface WaitTiming {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly untilJobKey?: string | undefined;
}

/** `job_terminal` when the named job is done, else undefined; shared by both targets. */
function jobOutcome(tree: RunTree, untilJobKey: string | undefined): WaitOutcome | undefined {
  if (untilJobKey === undefined) {
    return undefined;
  }
  const job = findJob(tree, untilJobKey);
  return job !== undefined && isJobTerminal(job) ? 'job_terminal' : undefined;
}

export interface WaitOptions extends WaitTiming {
  readonly api: Pick<DepotApi, 'getRunStatus'>;
  readonly runId: string;
}

export interface WaitResult extends PollResult<RunTree> {
  readonly job: JobNode | undefined;
}

/** Polls `GetRunStatus` until the run (or one named job) reaches a terminal state. */
export async function waitForRun(options: WaitOptions): Promise<WaitResult> {
  const result = await pollUntil({
    fetch: async () => parseRunTree(await options.api.getRunStatus(options.runId)),
    settled: (tree) =>
      isTerminalState(tree.status) ? 'run_terminal' : jobOutcome(tree, options.untilJobKey),
    diff: diffTrees,
    sleep: options.sleep,
    now: options.now,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
  });
  return {
    ...result,
    job: options.untilJobKey === undefined ? undefined : findJob(result.last, options.untilJobKey),
  };
}

export interface WorkflowSnapshot {
  readonly workflowId: string | undefined;
  readonly name: string | undefined;
  readonly runId: string | undefined;
  /** The workflow's own status as Depot reports it. */
  readonly status: string | undefined;
  readonly executions: WorkflowExecution[];
  /** The execution with the highest number; after a rerun, the one that is actually running. */
  readonly latest: WorkflowExecution | undefined;
  /** The workflow as a one-workflow run tree, so job lookup, counting and diffing are shared. */
  readonly tree: RunTree;
}

export function snapshotWorkflow(detail: WorkflowDetail): WorkflowSnapshot {
  return {
    workflowId: detail.workflowId,
    name: detail.name,
    runId: detail.runId,
    status: detail.status,
    executions: detail.executions,
    latest: latestExecution(detail.executions),
    tree: {
      runId: detail.runId,
      status: detail.runStatus,
      workflows: [
        {
          workflowId: detail.workflowId,
          name: detail.name,
          path: undefined,
          status: detail.status,
          jobs: detail.jobs,
        },
      ],
    },
  };
}

/**
 * After a rerun the workflow-level status can lag the new execution, so the latest execution
 * decides when one exists and carries a status; the workflow's own status is the fallback.
 */
export function isWorkflowTerminal(snapshot: WorkflowSnapshot): boolean {
  const latest = snapshot.latest?.status;
  return isTerminalState(latest ?? snapshot.status);
}

function flattenWorkflow(snapshot: WorkflowSnapshot): NodeMap {
  const nodes = flattenTree(snapshot.tree);
  for (const [index, execution] of snapshot.executions.entries()) {
    nodes.set(`execution:${execution.executionId ?? `#${index}`}`, {
      kind: 'execution',
      name: `execution ${execution.execution ?? index + 1}`,
      state: execution.status,
    });
  }
  return nodes;
}

export function diffWorkflowSnapshots(first: WorkflowSnapshot, last: WorkflowSnapshot): NodeChange[] {
  return diffNodes(flattenWorkflow(first), flattenWorkflow(last));
}

export interface WaitForWorkflowOptions extends WaitTiming {
  readonly api: Pick<DepotApi, 'getWorkflow'>;
  readonly workflowId: string;
  /** When given, the workflow must belong to this run; a mismatch ends the wait on the first poll. */
  readonly expectedRunId?: string | undefined;
}

export interface WorkflowWaitResult extends PollResult<WorkflowSnapshot> {
  readonly job: JobNode | undefined;
}

/**
 * Polls `GetWorkflow` until the latest execution (or one named job) reaches a terminal state.
 * This is what to watch after `RerunWorkflow` or `RetryFailedJobs`: they create a new execution
 * of the same workflow, not a new run.
 */
export async function waitForWorkflow(options: WaitForWorkflowOptions): Promise<WorkflowWaitResult> {
  const result = await pollUntil({
    fetch: async () => {
      const snapshot = snapshotWorkflow(parseWorkflowDetail(await options.api.getWorkflow(options.workflowId)));
      if (
        options.expectedRunId !== undefined &&
        snapshot.runId !== undefined &&
        snapshot.runId !== options.expectedRunId
      ) {
        throw new ToolInputError(
          `Workflow ${options.workflowId} belongs to run ${snapshot.runId}, not to run ${options.expectedRunId} as the arguments claim. Pass just one of runId and workflowId, or check the ids with depot_get_ci_run.`,
        );
      }
      return snapshot;
    },
    settled: (snapshot) =>
      isWorkflowTerminal(snapshot)
        ? 'workflow_terminal'
        : jobOutcome(snapshot.tree, options.untilJobKey),
    diff: diffWorkflowSnapshots,
    sleep: options.sleep,
    now: options.now,
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
  });
  return {
    ...result,
    job:
      options.untilJobKey === undefined ? undefined : findJob(result.last.tree, options.untilJobKey),
  };
}
