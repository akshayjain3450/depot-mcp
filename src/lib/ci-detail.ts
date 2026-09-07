import { z } from 'zod';
import {
  readBoolean,
  readEnum,
  readNumber,
  readObject,
  readObjectArray,
  readString,
  readStringArray,
  type JsonObject,
} from '../depot/shape.js';
import { MAX_LOG_LINE_CHARS, truncateText } from './budget.js';
import { isFailureState, STATUS_PREFIXES } from './ci-tree.js';
import { durationSecondsBetween, formatDuration } from './time.js';

/**
 * `GetJob`, `GetAttempt` and `GetWorkflow` all open with the same flattened parent context
 * (`runStatus`, `workflowName`, `jobErrorMessage`, ...) before the object itself. Verified live
 * 2026-09-06; the field names below are the ones Depot returned, with unprefixed and nested
 * spellings accepted as fallbacks because depot.ci.v1 publishes no schema.
 */

/** Workflow and job names come from YAML; keep them short when echoed into prose. */
export const CI_NAME_CHAR_LIMIT = 120;

export const runContextSchema = z.object({
  runId: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  headSha: z.string().optional(),
  trigger: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
});

export const workflowContextSchema = z.object({
  workflowId: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
});

export const attemptDetailSchema = z.object({
  attemptId: z.string().optional(),
  attempt: z.number().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  errorMessage: z.string().optional(),
  errorMessageTruncated: z.boolean().optional(),
  sandboxId: z.string().optional(),
  sessionId: z.string().optional(),
  createdAt: z.string().optional(),
  dispatchedAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
  isCurrent: z.boolean().optional(),
});

export const jobDetailSchema = z.object({
  jobId: z.string().optional(),
  jobKey: z.string().optional(),
  jobDisplayName: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  errorMessage: z.string().optional(),
  errorMessageTruncated: z.boolean().optional(),
  createdAt: z.string().optional(),
  dispatchedAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
  currentAttemptId: z.string().optional(),
  currentAttempt: z.number().optional(),
  runsOn: z.array(z.string()),
  strategy: z.object({ jobTotal: z.number().optional() }),
});

export type RunContext = z.infer<typeof runContextSchema>;
export type WorkflowContext = z.infer<typeof workflowContextSchema>;
export type AttemptDetail = z.infer<typeof attemptDetailSchema>;
export type JobDetail = z.infer<typeof jobDetailSchema>;

export function parseRunContext(source: JsonObject): RunContext {
  const nested = readObject(source, 'run');
  const createdAt = readString(source, 'runCreatedAt') ?? readString(nested, 'createdAt');
  const startedAt = readString(source, 'runStartedAt') ?? readString(nested, 'startedAt');
  const finishedAt = readString(source, 'runFinishedAt') ?? readString(nested, 'finishedAt');
  return {
    runId: readString(source, 'runId') ?? readString(nested, 'runId', 'id'),
    repo: readString(source, 'repo', 'repository') ?? readString(nested, 'repo', 'repository'),
    ref: readString(source, 'ref') ?? readString(nested, 'ref'),
    sha: readString(source, 'sha') ?? readString(nested, 'sha'),
    headSha: readString(source, 'headSha') ?? readString(nested, 'headSha'),
    trigger: readEnum(source, ['trigger'], ['trigger']) ?? readEnum(nested, ['trigger'], ['trigger']),
    status:
      readEnum(source, ['runStatus'], STATUS_PREFIXES) ??
      readEnum(nested, ['status', 'runStatus'], STATUS_PREFIXES),
    createdAt,
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
  };
}

export function parseWorkflowContext(source: JsonObject): WorkflowContext {
  const nested = readObject(source, 'workflow');
  const createdAt = readString(source, 'workflowCreatedAt') ?? readString(nested, 'createdAt');
  const startedAt = readString(source, 'workflowStartedAt') ?? readString(nested, 'startedAt');
  const finishedAt = readString(source, 'workflowFinishedAt') ?? readString(nested, 'finishedAt');
  return {
    workflowId: readString(source, 'workflowId') ?? readString(nested, 'workflowId', 'id'),
    name: readString(source, 'workflowName') ?? readString(nested, 'name', 'workflowName'),
    status:
      readEnum(source, ['workflowStatus'], STATUS_PREFIXES) ??
      readEnum(nested, ['status', 'workflowStatus'], STATUS_PREFIXES),
    createdAt,
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
  };
}

/** Error messages are CI output: cap them like a log line so one cannot swamp the budget. */
function capErrorMessage(
  raw: string | undefined,
): Pick<AttemptDetail, 'errorMessage' | 'errorMessageTruncated'> {
  if (raw === undefined) {
    return { errorMessage: undefined, errorMessageTruncated: undefined };
  }
  const capped = truncateText(raw, MAX_LOG_LINE_CHARS);
  return { errorMessage: capped.text, errorMessageTruncated: capped.truncated };
}

export function parseAttemptDetail(source: JsonObject): AttemptDetail {
  const startedAt = readString(source, 'startedAt', 'attemptStartedAt');
  const finishedAt = readString(source, 'finishedAt', 'attemptFinishedAt');
  return {
    attemptId: readString(source, 'attemptId', 'id'),
    attempt: readNumber(source, 'attempt', 'attemptNumber'),
    status: readEnum(source, ['status', 'attemptStatus'], STATUS_PREFIXES),
    conclusion: readEnum(source, ['conclusion', 'attemptConclusion'], STATUS_PREFIXES),
    ...capErrorMessage(readString(source, 'errorMessage', 'attemptErrorMessage')),
    sandboxId: readString(source, 'sandboxId'),
    sessionId: readString(source, 'sessionId'),
    createdAt: readString(source, 'createdAt', 'attemptCreatedAt'),
    dispatchedAt: readString(source, 'dispatchedAt', 'attemptDispatchedAt'),
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
    isCurrent: readBoolean(source, 'isCurrent', 'current'),
  };
}

/**
 * Reads the job fields from either a `GetJob`/`GetAttempt` document (where they carry a `job`
 * prefix beside the run and workflow fields) or a job entry inside `GetWorkflow` (bare names).
 */
export function parseJobDetail(source: JsonObject): JobDetail {
  const startedAt = readString(source, 'jobStartedAt', 'startedAt');
  const finishedAt = readString(source, 'jobFinishedAt', 'finishedAt');
  return {
    jobId: readString(source, 'jobId', 'id'),
    jobKey: readString(source, 'jobKey', 'key'),
    jobDisplayName: readString(source, 'jobDisplayName', 'displayName'),
    status: readEnum(source, ['jobStatus', 'status'], STATUS_PREFIXES),
    conclusion: readEnum(source, ['jobConclusion', 'conclusion'], STATUS_PREFIXES),
    ...capErrorMessage(readString(source, 'jobErrorMessage', 'errorMessage')),
    createdAt: readString(source, 'jobCreatedAt', 'createdAt'),
    dispatchedAt: readString(source, 'jobDispatchedAt', 'dispatchedAt'),
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
    currentAttemptId: readString(source, 'currentAttemptId'),
    currentAttempt: readNumber(source, 'currentAttempt', 'currentAttemptNumber'),
    runsOn: readStringArray(readObject(source, 'runsOn'), 'labels'),
    strategy: { jobTotal: readNumber(readObject(source, 'strategy'), 'jobTotal') },
  };
}

export function parseAttempts(source: JsonObject): AttemptDetail[] {
  return readObjectArray(source, 'attempts').map(parseAttemptDetail);
}

/** Highest attempt number first; Depot lists them oldest first. Stable for equal numbers. */
export function newestFirst<T extends { attempt?: number | undefined }>(
  attempts: readonly T[],
): T[] {
  return attempts
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (b.entry.attempt ?? 0) - (a.entry.attempt ?? 0) || a.index - b.index)
    .map(({ entry }) => entry);
}

export function isFailed(node: { status?: string | undefined; conclusion?: string | undefined }): boolean {
  return isFailureState(node.conclusion) || isFailureState(node.status);
}

/** "failed (conclusion failure)" when Depot reports both and they differ; one word otherwise. */
export function formatState(node: {
  status?: string | undefined;
  conclusion?: string | undefined;
}): string {
  if (node.status === undefined) {
    return node.conclusion ?? 'unknown';
  }
  if (node.conclusion === undefined || node.conclusion === node.status) {
    return node.status;
  }
  return `${node.status} (conclusion ${node.conclusion})`;
}

/** Names from workflow YAML are untrusted: quote them and keep them short. */
export function quoteName(name: string | undefined, fallback: string): string {
  return name === undefined ? fallback : `"${truncateText(name, CI_NAME_CHAR_LIMIT).text}"`;
}

/** Error text is CI output: one line, JSON-quoted so embedded newlines and quotes stay visible. */
export function quoteError(message: string): string {
  return JSON.stringify(message);
}

export function describeRun(run: RunContext): string {
  const bits = [
    run.status ?? 'unknown status',
    run.repo === undefined
      ? undefined
      : run.sha === undefined
        ? run.repo
        : `${run.repo}@${run.sha.slice(0, 8)}`,
    // API-triggered runs report the SHA as the ref (seen live); once is enough.
    run.ref === run.sha ? undefined : run.ref,
    run.trigger === undefined ? undefined : `via ${run.trigger}`,
    run.durationSeconds === undefined ? undefined : formatDuration(run.durationSeconds),
  ].filter((bit): bit is string => bit !== undefined);
  return `Run ${run.runId ?? 'unknown'} — ${bits.join(' · ')}`;
}

export function describeWorkflow(workflow: WorkflowContext): string {
  const id = workflow.workflowId === undefined ? '' : ` (workflowId=${workflow.workflowId})`;
  return `workflow ${quoteName(workflow.name, 'unnamed')}${id} — ${workflow.status ?? 'unknown'}`;
}

/** One line per attempt, as rendered under a job in every tool that lists attempts. */
export function describeAttempt(attempt: AttemptDetail): string {
  const ids = [
    attempt.attemptId === undefined ? undefined : `attemptId=${attempt.attemptId}`,
    attempt.sandboxId === undefined ? undefined : `sandboxId=${attempt.sandboxId}`,
  ].filter((bit): bit is string => bit !== undefined);
  const bits = [
    formatState(attempt),
    attempt.durationSeconds === undefined ? undefined : formatDuration(attempt.durationSeconds),
    attempt.isCurrent === true ? 'current' : undefined,
  ].filter((bit): bit is string => bit !== undefined);
  return `attempt ${attempt.attempt ?? '?'} — ${bits.join(', ')}${
    ids.length === 0 ? '' : ` (${ids.join(', ')})`
  }`;
}
