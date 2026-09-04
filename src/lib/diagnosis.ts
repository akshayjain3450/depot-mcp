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
import { truncateText } from './budget.js';

/** Depot's CLI appends this whenever a diagnosis or suggested fix is present; keep it verbatim. */
export const AI_DISCLOSURE = 'This diagnosis is AI-generated and can make mistakes.';

const EVIDENCE_LINE_CHAR_LIMIT = 400;
const ERROR_MESSAGE_CHAR_LIMIT = 1_200;

export interface EvidenceLine {
  stepId: string | undefined;
  lineNumber: number | undefined;
  content: string;
  contentTruncated: boolean;
}

export interface AttemptRef {
  attemptId: string | undefined;
  jobId: string | undefined;
  jobKey: string | undefined;
  attempt: number | undefined;
  attemptStatus: string | undefined;
  attemptConclusion: string | undefined;
  errorMessage: string | undefined;
  diagnosis: string | undefined;
  possibleFix: string | undefined;
  evidence: EvidenceLine[];
  evidenceOmitted: number;
}

export interface FailureGroup {
  fingerprint: string | undefined;
  source: string | undefined;
  count: number | undefined;
  errorMessage: string | undefined;
  errorMessageTruncated: boolean;
  diagnosis: string | undefined;
  possibleFix: string | undefined;
  attempts: AttemptRef[];
  omittedRepresentativeCount: number | undefined;
}

export interface DiagnosisContext {
  repo: string | undefined;
  ref: string | undefined;
  sha: string | undefined;
  trigger: string | undefined;
  runId: string | undefined;
  runStatus: string | undefined;
  workflowId: string | undefined;
  workflowName: string | undefined;
  workflowPath: string | undefined;
  workflowStatus: string | undefined;
  jobId: string | undefined;
  jobKey: string | undefined;
  jobDisplayName: string | undefined;
  jobStatus: string | undefined;
  jobConclusion: string | undefined;
  attemptId: string | undefined;
  attempt: number | undefined;
  attemptStatus: string | undefined;
  truncatedContextFields: string[];
}

export interface NarrowerTarget {
  targetType: string | undefined;
  targetId: string | undefined;
  label: string | undefined;
  status: string | undefined;
  failedJobCount: number | undefined;
  nextStep: NextStep | undefined;
}

export interface NextStep {
  kind: string;
  label: string | undefined;
  tool: string | undefined;
  arguments: Record<string, string>;
}

export interface DiagnosisTruncation {
  byDepot: boolean;
  byServer: boolean;
  omittedFailureGroups: number;
  omittedAttempts: number;
  notes: string[];
}

export interface Diagnosis {
  state: string;
  emptyReason: string | undefined;
  target: {
    targetId: string | undefined;
    targetType: string | undefined;
    status: string | undefined;
  };
  context: DiagnosisContext;
  failureGroups: FailureGroup[];
  representativeAttempts: AttemptRef[];
  narrowerTargets: NarrowerTarget[];
  nextSteps: NextStep[];
  truncation: DiagnosisTruncation;
  aiDisclosure: string | undefined;
}

export interface DiagnosisLimits {
  readonly maxFailureGroups: number;
  readonly maxEvidenceLines: number;
}

/**
 * Depot returns `nextCommands` as ready-to-run `depot` CLI argv. Re-point each one at the
 * equivalent tool on this server so the agent gets a tool call rather than a shell command.
 */
const NEXT_COMMAND_TOOLS: Readonly<
  Record<string, { tool: string; args: (targetId: string) => Record<string, string> }>
> = {
  logs: { tool: 'depot_get_ci_logs', args: (id) => ({ id }) },
  summary: { tool: 'depot_get_ci_job_summary', args: (id) => ({ id }) },
  diagnose_workflow: {
    tool: 'depot_diagnose_ci_failure',
    args: (id) => ({ id, targetType: 'workflow' }),
  },
  diagnose_job: {
    tool: 'depot_diagnose_ci_failure',
    args: (id) => ({ id, targetType: 'job' }),
  },
};

function parseNextStep(source: JsonObject): NextStep | undefined {
  const kind = readEnum(source, ['kind'], ['next_command_kind', 'kind']);
  if (kind === undefined) {
    return undefined;
  }
  const targetId = readString(source, 'targetId');
  const mapping = NEXT_COMMAND_TOOLS[kind];
  return {
    kind,
    label: readString(source, 'label'),
    tool: mapping?.tool,
    arguments: mapping !== undefined && targetId !== undefined ? mapping.args(targetId) : {},
  };
}

function parseNextSteps(source: unknown, key: string): NextStep[] {
  const steps: NextStep[] = [];
  for (const entry of readObjectArray(source, key)) {
    const step = parseNextStep(entry);
    if (step !== undefined) {
      steps.push(step);
    }
  }
  return steps;
}

function parseEvidence(
  source: JsonObject,
  limit: number,
): { lines: EvidenceLine[]; omitted: number } {
  const raw = readObjectArray(source, 'relevantLines');
  const lines: EvidenceLine[] = [];
  for (const entry of raw.slice(0, limit)) {
    const content = readString(entry, 'content', 'body') ?? '';
    const capped = truncateText(content, EVIDENCE_LINE_CHAR_LIMIT);
    lines.push({
      stepId: readString(entry, 'stepId', 'stepKey'),
      lineNumber: readNumber(entry, 'lineNumber'),
      content: capped.text,
      contentTruncated: capped.truncated || (readBoolean(entry, 'contentTruncated') ?? false),
    });
  }
  return { lines, omitted: Math.max(0, raw.length - lines.length) };
}

function parseAttempt(source: JsonObject, limits: DiagnosisLimits): AttemptRef {
  const evidence = parseEvidence(source, limits.maxEvidenceLines);
  const errorMessage = readString(source, 'errorMessage');
  return {
    attemptId: readString(source, 'attemptId'),
    jobId: readString(source, 'jobId'),
    jobKey: readString(source, 'jobKey', 'jobDisplayName'),
    attempt: readNumber(source, 'attempt'),
    attemptStatus: readEnum(source, ['attemptStatus'], ['status', 'attempt_status']),
    attemptConclusion: readEnum(source, ['attemptConclusion'], ['conclusion', 'attempt_conclusion']),
    errorMessage:
      errorMessage === undefined
        ? undefined
        : truncateText(errorMessage, ERROR_MESSAGE_CHAR_LIMIT).text,
    diagnosis: readString(source, 'diagnosis'),
    possibleFix: readString(source, 'possibleFix'),
    evidence: evidence.lines,
    evidenceOmitted: evidence.omitted,
  };
}

function parseFailureGroup(source: JsonObject, limits: DiagnosisLimits): FailureGroup {
  const errorMessage = readString(source, 'errorMessage');
  const capped =
    errorMessage === undefined ? undefined : truncateText(errorMessage, ERROR_MESSAGE_CHAR_LIMIT);
  return {
    fingerprint: readString(source, 'fingerprint'),
    source: readString(source, 'source'),
    count: readNumber(source, 'count'),
    errorMessage: capped?.text,
    errorMessageTruncated:
      (capped?.truncated ?? false) || (readBoolean(source, 'errorMessageTruncated') ?? false),
    diagnosis: readString(source, 'diagnosis'),
    possibleFix: readString(source, 'possibleFix'),
    attempts: readObjectArray(source, 'representatives').map((entry) =>
      parseAttempt(entry, limits),
    ),
    omittedRepresentativeCount: readNumber(source, 'omittedRepresentativeCount'),
  };
}

function parseContext(source: JsonObject | undefined): DiagnosisContext {
  return {
    repo: readString(source, 'repo'),
    ref: readString(source, 'ref'),
    sha: readString(source, 'sha', 'headSha'),
    trigger: readString(source, 'trigger'),
    runId: readString(source, 'runId'),
    runStatus: readEnum(source, ['runStatus'], ['status', 'run_status']),
    workflowId: readString(source, 'workflowId'),
    workflowName: readString(source, 'workflowName'),
    workflowPath: readString(source, 'workflowPath'),
    workflowStatus: readEnum(source, ['workflowStatus'], ['status', 'workflow_status']),
    jobId: readString(source, 'jobId'),
    jobKey: readString(source, 'jobKey'),
    jobDisplayName: readString(source, 'jobDisplayName'),
    jobStatus: readEnum(source, ['jobStatus'], ['status', 'job_status']),
    jobConclusion: readEnum(source, ['jobConclusion'], ['conclusion', 'job_conclusion']),
    attemptId: readString(source, 'attemptId'),
    attempt: readNumber(source, 'attempt'),
    attemptStatus: readEnum(source, ['attemptStatus'], ['status', 'attempt_status']),
    truncatedContextFields: readStringArray(source, 'truncatedContextFields'),
  };
}

/**
 * Turn Depot's `bounds` object into notes an agent can act on. Depot caps this response
 * server-side and reports exactly what it dropped; losing that signal silently would make a
 * partial diagnosis look complete.
 */
function parseTruncation(bounds: JsonObject | undefined): DiagnosisTruncation {
  const omittedFailureGroups = readNumber(bounds, 'omittedFailureGroupCount') ?? 0;
  const omittedAttempts = readNumber(bounds, 'omittedAttemptCount') ?? 0;
  const notes: string[] = [];

  if (readBoolean(bounds, 'truncated') === true) {
    notes.push('Depot truncated this diagnosis server-side.');
  }
  if (omittedFailureGroups > 0) {
    const limit = readNumber(bounds, 'failureGroupLimit');
    notes.push(
      `${omittedFailureGroups} further failure group(s) were omitted by Depot${
        limit === undefined ? '' : ` (its limit is ${limit} per response)`
      }.`,
    );
  }
  if (omittedAttempts > 0) {
    notes.push(`${omittedAttempts} further failing attempt(s) were omitted by Depot.`);
  }
  const skippedDependents = readNumber(bounds, 'skippedDependentCount') ?? 0;
  if (skippedDependents > 0) {
    notes.push(
      `${skippedDependents} job(s) never ran because a job they depend on failed; they are not root causes.`,
    );
  }
  const totalProblemJobs = readNumber(bounds, 'totalProblemJobCount');
  if (totalProblemJobs !== undefined && totalProblemJobs > 0) {
    notes.push(`Depot considered ${totalProblemJobs} problem job(s) in total.`);
  }

  return {
    byDepot: notes.length > 0,
    byServer: false,
    omittedFailureGroups,
    omittedAttempts,
    notes,
  };
}

export function parseDiagnosis(response: JsonObject, limits: DiagnosisLimits): Diagnosis {
  const target = readObject(response, 'target');
  const allGroups = readObjectArray(response, 'failureGroups');
  const groups = allGroups
    .slice(0, limits.maxFailureGroups)
    .map((entry) => parseFailureGroup(entry, limits));
  const truncation = parseTruncation(readObject(response, 'bounds'));

  const groupsDroppedHere = allGroups.length - groups.length;
  if (groupsDroppedHere > 0) {
    truncation.byServer = true;
    truncation.notes.push(
      `This server returned the ${groups.length} largest failure group(s) and dropped ${groupsDroppedHere}; raise maxFailureGroups to see more.`,
    );
  }

  const narrowerTargets: NarrowerTarget[] = readObjectArray(response, 'overLimitBreakdown').map(
    (entry) => ({
      targetType: readEnum(entry, ['targetType'], ['target_type']),
      targetId: readString(entry, 'targetId'),
      label: readString(entry, 'label'),
      status: readEnum(entry, ['status'], ['status']),
      failedJobCount: readNumber(entry, 'failedProblemCandidateCount'),
      nextStep: parseNextSteps(entry, 'nextCommands')[0],
    }),
  );

  const diagnosis: Diagnosis = {
    state: readEnum(response, ['state'], ['state', 'diagnosis_state']) ?? 'unknown',
    emptyReason: readEnum(response, ['emptyReason'], ['empty_reason']),
    target: {
      targetId: readString(target, 'targetId'),
      targetType: readEnum(target, ['targetType'], ['target_type']),
      status: readEnum(target, ['status'], ['status']),
    },
    context: parseContext(readObject(response, 'context')),
    failureGroups: groups,
    representativeAttempts: readObjectArray(response, 'representativeAttempts').map((entry) =>
      parseAttempt(entry, limits),
    ),
    narrowerTargets,
    nextSteps: parseNextSteps(response, 'nextCommands'),
    truncation,
    aiDisclosure: undefined,
  };

  const hasAiText =
    diagnosis.failureGroups.some(
      (group) =>
        group.diagnosis !== undefined ||
        group.possibleFix !== undefined ||
        group.attempts.some(
          (attempt) => attempt.diagnosis !== undefined || attempt.possibleFix !== undefined,
        ),
    ) ||
    diagnosis.representativeAttempts.some(
      (attempt) => attempt.diagnosis !== undefined || attempt.possibleFix !== undefined,
    );

  if (hasAiText) {
    diagnosis.aiDisclosure = AI_DISCLOSURE;
  }

  if (diagnosis.context.truncatedContextFields.length > 0) {
    diagnosis.truncation.byDepot = true;
    diagnosis.truncation.notes.push(
      `Depot truncated these context fields: ${diagnosis.context.truncatedContextFields.join(', ')}.`,
    );
  }

  return diagnosis;
}
