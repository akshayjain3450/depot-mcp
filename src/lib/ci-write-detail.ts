import {
  asObject,
  readEnum,
  readNumber,
  readObjectArray,
  readString,
  type JsonObject,
} from '../depot/shape.js';
import { isFailureState, STATUS_PREFIXES, type JobNode } from './ci-tree.js';
import { durationSecondsBetween } from './time.js';

/**
 * States after which Depot will not move a run, workflow, job, or attempt on its own. Anything
 * else (queued, running, pending, waiting) is treated as active. An unknown or missing state is
 * neither, so the write tools let Depot decide rather than refusing on a guess.
 */
const TERMINAL_STATES = new Set([
  'finished',
  'completed',
  'success',
  'succeeded',
  'failed',
  'failure',
  'error',
  'cancelled',
  'canceled',
  'skipped',
  'timed_out',
  'timeout',
]);

export function isTerminalState(state: string | undefined): boolean {
  return state !== undefined && TERMINAL_STATES.has(state);
}

/** True only when the state is known and not terminal: the job or workflow is still in flight. */
export function isActiveState(state: string | undefined): boolean {
  return state !== undefined && !TERMINAL_STATES.has(state);
}

export interface StatefulNode {
  readonly status?: string | undefined;
  readonly conclusion?: string | undefined;
}

export function isFailedJob(job: StatefulNode): boolean {
  return isFailureState(job.conclusion) || isFailureState(job.status);
}

/** The best-effort state of a node: Depot sends a conclusion only once a status is terminal. */
export function nodeState(node: StatefulNode): string {
  return node.conclusion ?? node.status ?? 'unknown';
}

export interface AttemptDetail {
  attemptId: string | undefined;
  attempt: number | undefined;
  status: string | undefined;
  conclusion: string | undefined;
  errorMessage: string | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationSeconds: number | undefined;
}

export interface JobDetail {
  jobId: string | undefined;
  key: string | undefined;
  displayName: string | undefined;
  status: string | undefined;
  conclusion: string | undefined;
  errorMessage: string | undefined;
  runId: string | undefined;
  runStatus: string | undefined;
  workflowId: string | undefined;
  workflowName: string | undefined;
  workflowStatus: string | undefined;
  repo: string | undefined;
  currentAttempt: number | undefined;
  attemptCount: number;
  attempts: AttemptDetail[];
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationSeconds: number | undefined;
}

function parseAttemptDetail(source: JsonObject): AttemptDetail {
  const startedAt = readString(source, 'startedAt');
  const finishedAt = readString(source, 'finishedAt');
  return {
    attemptId: readString(source, 'attemptId', 'id'),
    attempt: readNumber(source, 'attempt', 'attemptNumber'),
    status: readEnum(source, ['status', 'attemptStatus'], STATUS_PREFIXES),
    conclusion: readEnum(source, ['conclusion', 'attemptConclusion'], STATUS_PREFIXES),
    errorMessage: readString(source, 'errorMessage'),
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
  };
}

/**
 * How many times a job has run. Depot reports both an attempt list and a `currentAttempt`
 * counter; the larger wins, so a truncated list cannot hide attempts from the retry cap.
 */
export function countAttempts(source: {
  readonly attempts: ReadonlyArray<{ readonly attempt: number | undefined }>;
  readonly currentAttempt?: number | undefined;
}): number {
  let highest = source.currentAttempt ?? 0;
  for (const attempt of source.attempts) {
    if (attempt.attempt !== undefined && attempt.attempt > highest) {
      highest = attempt.attempt;
    }
  }
  return Math.max(highest, source.attempts.length);
}

/** `GetJob` is flat: run, workflow and job fields side by side, prefixed by their owner. */
export function parseJobDetail(response: JsonObject): JobDetail {
  const attempts = readObjectArray(response, 'attempts').map(parseAttemptDetail);
  const currentAttempt = readNumber(response, 'currentAttempt');
  const startedAt = readString(response, 'jobStartedAt', 'startedAt');
  const finishedAt = readString(response, 'jobFinishedAt', 'finishedAt');
  return {
    jobId: readString(response, 'jobId', 'id'),
    key: readString(response, 'jobKey', 'key'),
    displayName: readString(response, 'jobDisplayName', 'displayName', 'name'),
    status: readEnum(response, ['jobStatus', 'status'], STATUS_PREFIXES),
    conclusion: readEnum(response, ['jobConclusion', 'conclusion'], STATUS_PREFIXES),
    errorMessage: readString(response, 'jobErrorMessage', 'errorMessage'),
    runId: readString(response, 'runId'),
    runStatus: readEnum(response, ['runStatus'], STATUS_PREFIXES),
    workflowId: readString(response, 'workflowId'),
    workflowName: readString(response, 'workflowName'),
    workflowStatus: readEnum(response, ['workflowStatus'], STATUS_PREFIXES),
    repo: readString(response, 'repo', 'repository'),
    currentAttempt,
    attemptCount: countAttempts({ attempts, currentAttempt }),
    attempts,
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
  };
}

export interface WorkflowExecution {
  executionId: string | undefined;
  execution: number | undefined;
  status: string | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationSeconds: number | undefined;
}

export interface WorkflowJob extends JobNode {
  attemptCount: number;
  startedAt: string | undefined;
  finishedAt: string | undefined;
}

export interface WorkflowDetail {
  workflowId: string | undefined;
  name: string | undefined;
  status: string | undefined;
  runId: string | undefined;
  runStatus: string | undefined;
  repo: string | undefined;
  ref: string | undefined;
  sha: string | undefined;
  executions: WorkflowExecution[];
  jobs: WorkflowJob[];
  startedAt: string | undefined;
  finishedAt: string | undefined;
  durationSeconds: number | undefined;
}

function parseExecution(source: JsonObject): WorkflowExecution {
  const startedAt = readString(source, 'startedAt');
  const finishedAt = readString(source, 'finishedAt');
  return {
    executionId: readString(source, 'executionId', 'id'),
    execution: readNumber(source, 'execution', 'executionNumber'),
    status: readEnum(source, ['status', 'executionStatus'], STATUS_PREFIXES),
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
  };
}

function parseWorkflowJob(source: JsonObject): WorkflowJob {
  const attempts = readObjectArray(source, 'attempts').map((attempt) => ({
    attemptId: readString(attempt, 'attemptId', 'id'),
    attempt: readNumber(attempt, 'attempt', 'attemptNumber'),
    status: readEnum(attempt, ['status', 'attemptStatus'], STATUS_PREFIXES),
    conclusion: readEnum(attempt, ['conclusion', 'attemptConclusion'], STATUS_PREFIXES),
  }));
  return {
    jobId: readString(source, 'jobId', 'id'),
    key: readString(source, 'jobKey', 'key'),
    displayName: readString(source, 'jobDisplayName', 'displayName', 'name'),
    status: readEnum(source, ['status', 'jobStatus'], STATUS_PREFIXES),
    conclusion: readEnum(source, ['conclusion', 'jobConclusion'], STATUS_PREFIXES),
    attempts,
    attemptCount: countAttempts({ attempts, currentAttempt: readNumber(source, 'currentAttempt') }),
    startedAt: readString(source, 'startedAt'),
    finishedAt: readString(source, 'finishedAt'),
  };
}

/** `GetWorkflow` is flat like `GetJob`, plus `executions` (rerun history) and nested `jobs`. */
export function parseWorkflowDetail(response: JsonObject): WorkflowDetail {
  const startedAt = readString(response, 'workflowStartedAt', 'startedAt');
  const finishedAt = readString(response, 'workflowFinishedAt', 'finishedAt');
  return {
    workflowId: readString(response, 'workflowId', 'id'),
    name: readString(response, 'workflowName', 'name'),
    status: readEnum(response, ['workflowStatus', 'status'], STATUS_PREFIXES),
    runId: readString(response, 'runId'),
    runStatus: readEnum(response, ['runStatus'], STATUS_PREFIXES),
    repo: readString(response, 'repo', 'repository'),
    ref: readString(response, 'ref'),
    sha: readString(response, 'sha', 'headSha'),
    executions: readObjectArray(response, 'executions').map(parseExecution),
    jobs: readObjectArray(response, 'jobs').map(parseWorkflowJob),
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
  };
}

const ID_KEY = /(?:^id$|Id$|_id$)/;
const MAX_COLLECTED_IDS = 40;
const MAX_ARRAY_ENTRIES = 10;

/**
 * Depot does not document what its mutating RPCs return. Rather than assert a shape, gather
 * every id-looking string in the response (top level and nested, bounded) so the result can
 * name whatever Depot created or touched, and read a status if one is present.
 */
export function summariseMutationResponse(response: JsonObject): {
  ids: Record<string, string>;
  status: string | undefined;
  keys: string[];
} {
  const ids: Record<string, string> = {};
  let collected = 0;
  const visit = (object: JsonObject, prefix: string): void => {
    for (const [key, value] of Object.entries(object)) {
      if (collected >= MAX_COLLECTED_IDS) {
        return;
      }
      if (typeof value === 'string') {
        if (ID_KEY.test(key) && value !== '') {
          ids[`${prefix}${key}`] = value;
          collected += 1;
        }
      } else if (Array.isArray(value)) {
        value.slice(0, MAX_ARRAY_ENTRIES).forEach((entry, index) => {
          const nested = asObject(entry);
          if (nested !== undefined) {
            visit(nested, `${prefix}${key}[${index}].`);
          }
        });
      } else {
        const nested = asObject(value);
        if (nested !== undefined) {
          visit(nested, `${prefix}${key}.`);
        }
      }
    }
  };
  visit(response, '');
  return {
    ids,
    status: readEnum(
      response,
      ['status', 'runStatus', 'workflowStatus', 'jobStatus', 'attemptStatus'],
      STATUS_PREFIXES,
    ),
    keys: Object.keys(response),
  };
}
