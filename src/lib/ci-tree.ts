import {
  readNumber,
  readObject,
  readObjectArray,
  readEnum,
  readString,
  type JsonObject,
} from '../depot/shape.js';
import { durationSecondsBetween } from './time.js';

const STATUS_PREFIXES = ['status', 'run_status', 'job_status', 'attempt_status', 'conclusion'];

export interface AttemptNode {
  attemptId: string | undefined;
  attempt: number | undefined;
  status: string | undefined;
  conclusion: string | undefined;
}

export interface JobNode {
  jobId: string | undefined;
  key: string | undefined;
  displayName: string | undefined;
  status: string | undefined;
  conclusion: string | undefined;
  attempts: AttemptNode[];
}

export interface WorkflowNode {
  workflowId: string | undefined;
  name: string | undefined;
  path: string | undefined;
  status: string | undefined;
  jobs: JobNode[];
}

export interface RunTree {
  runId: string | undefined;
  status: string | undefined;
  workflows: WorkflowNode[];
}

const FAILURE_STATES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled', 'timed_out']);

export function isFailureState(state: string | undefined): boolean {
  return state !== undefined && FAILURE_STATES.has(state);
}

function parseAttempt(source: JsonObject): AttemptNode {
  return {
    attemptId: readString(source, 'attemptId', 'id'),
    attempt: readNumber(source, 'attempt', 'attemptNumber'),
    status: readEnum(source, ['status', 'attemptStatus'], STATUS_PREFIXES),
    conclusion: readEnum(source, ['conclusion', 'attemptConclusion'], STATUS_PREFIXES),
  };
}

function parseJob(source: JsonObject): JobNode {
  return {
    jobId: readString(source, 'jobId', 'id'),
    key: readString(source, 'jobKey', 'key'),
    displayName: readString(source, 'jobDisplayName', 'displayName', 'name'),
    status: readEnum(source, ['status', 'jobStatus'], STATUS_PREFIXES),
    conclusion: readEnum(source, ['conclusion', 'jobConclusion'], STATUS_PREFIXES),
    attempts: readObjectArray(source, 'attempts').map(parseAttempt),
  };
}

function parseWorkflow(source: JsonObject): WorkflowNode {
  return {
    workflowId: readString(source, 'workflowId', 'id'),
    name: readString(source, 'workflowName', 'name'),
    path: readString(source, 'workflowPath', 'path'),
    status: readEnum(source, ['status', 'workflowStatus'], STATUS_PREFIXES),
    jobs: readObjectArray(source, 'jobs').map(parseJob),
  };
}

/** `GetRunStatus` returns the workflow -> job -> attempt tree; the run itself may be nested or flat. */
export function parseRunTree(response: JsonObject): RunTree {
  const runObject = readObject(response, 'run');
  const workflows = readObjectArray(response, 'workflows');
  const nestedWorkflows = runObject === undefined ? [] : readObjectArray(runObject, 'workflows');
  return {
    runId: readString(response, 'runId') ?? readString(runObject, 'runId', 'id'),
    status: readEnum(response, ['status', 'runStatus'], STATUS_PREFIXES) ??
      readEnum(runObject, ['status', 'runStatus'], STATUS_PREFIXES),
    workflows: (workflows.length > 0 ? workflows : nestedWorkflows).map(parseWorkflow),
  };
}

export interface TreeSelection {
  readonly workflow: WorkflowNode;
  readonly job: JobNode;
  readonly attempt: AttemptNode | undefined;
}

function latestAttempt(job: JobNode): AttemptNode | undefined {
  if (job.attempts.length === 0) {
    return undefined;
  }
  return job.attempts.reduce((best, candidate) =>
    (candidate.attempt ?? 0) >= (best.attempt ?? 0) ? candidate : best,
  );
}

/**
 * Pick the job an agent most likely means: a failed one if there is one, otherwise the last job.
 * Mirrors how `depot ci logs` resolves a run ID down to a single attempt.
 */
export function selectInterestingJob(tree: RunTree): TreeSelection | undefined {
  let fallback: TreeSelection | undefined;
  for (const workflow of tree.workflows) {
    for (const job of workflow.jobs) {
      const selection: TreeSelection = { workflow, job, attempt: latestAttempt(job) };
      if (isFailureState(job.conclusion) || isFailureState(job.status)) {
        return selection;
      }
      fallback = selection;
    }
  }
  return fallback;
}

export interface RunSummary {
  runId: string | undefined;
  repo: string | undefined;
  ref: string | undefined;
  sha: string | undefined;
  trigger: string | undefined;
  pr: number | undefined;
  status: string | undefined;
  createdAt: string | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationSeconds: number | undefined;
}

export function parseRunSummary(source: JsonObject): RunSummary {
  const inner = readObject(source, 'run') ?? source;
  const startedAt = readString(inner, 'startedAt');
  const finishedAt = readString(inner, 'finishedAt');
  return {
    runId: readString(inner, 'runId', 'id'),
    repo: readString(inner, 'repo', 'repository'),
    ref: readString(inner, 'ref'),
    sha: readString(inner, 'sha', 'headSha'),
    trigger: readEnum(inner, ['trigger'], ['trigger']),
    pr: readNumber(inner, 'pr', 'pullRequest'),
    status: readEnum(inner, ['status', 'runStatus'], STATUS_PREFIXES),
    createdAt: readString(inner, 'createdAt'),
    startedAt,
    finishedAt,
    durationSeconds:
      readNumber(inner, 'durationSeconds') ?? durationSecondsBetween(startedAt, finishedAt),
  };
}

export function countJobs(tree: RunTree): { total: number; failed: number } {
  let total = 0;
  let failed = 0;
  for (const workflow of tree.workflows) {
    for (const job of workflow.jobs) {
      total += 1;
      if (isFailureState(job.conclusion) || isFailureState(job.status)) {
        failed += 1;
      }
    }
  }
  return { total, failed };
}
