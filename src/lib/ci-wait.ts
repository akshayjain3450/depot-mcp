import type { DepotApi } from '../depot/api.js';
import { parseRunTree, type JobNode, type RunTree } from './ci-tree.js';

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

export type NodeKind = 'run' | 'workflow' | 'job' | 'attempt';

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

function flatten(tree: RunTree): Map<string, NodeState> {
  const nodes = new Map<string, NodeState>();
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

/** Every node whose state differs between two snapshots, in tree order of the later one. */
export function diffTrees(first: RunTree, last: RunTree): NodeChange[] {
  const before = flatten(first);
  const after = flatten(last);
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

export type WaitOutcome = 'run_terminal' | 'job_terminal' | 'timed_out';

export interface WaitOptions {
  readonly api: Pick<DepotApi, 'getRunStatus'>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly untilJobKey?: string | undefined;
}

export interface WaitResult {
  readonly outcome: WaitOutcome;
  readonly first: RunTree;
  readonly last: RunTree;
  readonly job: JobNode | undefined;
  readonly polls: number;
  readonly elapsedMs: number;
  readonly changes: NodeChange[];
}

/**
 * Polls `GetRunStatus` until the run (or one named job) reaches a terminal state or the timeout
 * is spent. Sleeps never total more than `timeoutMs` and no poll starts after the deadline, so
 * the call returns within the timeout plus the duration of one status request. Each poll is an
 * ordinary unary RPC under the client's own per-call deadline; nothing here streams.
 */
export async function waitForRun(options: WaitOptions): Promise<WaitResult> {
  const start = options.now();
  const deadline = start + options.timeoutMs;
  let polls = 0;
  let first: RunTree | undefined;

  for (;;) {
    const tree = parseRunTree(await options.api.getRunStatus(options.runId));
    polls += 1;
    first ??= tree;
    const job = options.untilJobKey === undefined ? undefined : findJob(tree, options.untilJobKey);

    const finish = (outcome: WaitOutcome): WaitResult => ({
      outcome,
      first: first ?? tree,
      last: tree,
      job,
      polls,
      elapsedMs: Math.max(0, options.now() - start),
      changes: diffTrees(first ?? tree, tree),
    });

    if (isTerminalState(tree.status)) {
      return finish('run_terminal');
    }
    if (job !== undefined && isJobTerminal(job)) {
      return finish('job_terminal');
    }
    const remaining = deadline - options.now();
    if (remaining <= 0) {
      return finish('timed_out');
    }
    await options.sleep(Math.min(options.pollMs, remaining));
  }
}
