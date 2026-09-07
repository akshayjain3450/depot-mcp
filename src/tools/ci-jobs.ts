import { z } from 'zod';
import { readObject } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import {
  attemptDetailSchema,
  describeAttempt,
  describeRun,
  describeWorkflow,
  formatState,
  isFailed,
  jobDetailSchema,
  newestFirst,
  parseAttemptDetail,
  parseAttempts,
  parseJobDetail,
  parseRunContext,
  parseWorkflowContext,
  quoteError,
  quoteName,
  runContextSchema,
  workflowContextSchema,
  type AttemptDetail,
  type JobDetail,
  type RunContext,
  type WorkflowContext,
} from '../lib/ci-detail.js';
import { UNTRUSTED_CI_CONTENT_WARNING } from '../lib/ci-target.js';
import { formatDuration } from '../lib/time.js';
import { defineTool } from '../lib/tool.js';

const contentWarningSchema = z
  .string()
  .describe('Reminder that names and error messages come from CI output and are unverified.');

function jobHeadline(job: JobDetail, fallbackId: string): string {
  const name = quoteName(job.jobDisplayName ?? job.jobKey, 'unnamed job');
  const jobTotal = job.strategy.jobTotal;
  const bits = [
    formatState(job),
    job.durationSeconds === undefined ? undefined : formatDuration(job.durationSeconds),
    job.currentAttempt === undefined ? undefined : `current attempt ${job.currentAttempt}`,
    jobTotal !== undefined && jobTotal > 1 ? `one of ${jobTotal} matrix jobs` : undefined,
    job.runsOn.length === 0 ? undefined : `runs on ${job.runsOn.join(', ')}`,
  ].filter((bit): bit is string => bit !== undefined);
  return `Job ${name} (jobId=${job.jobId ?? fallbackId}) — ${bits.join(', ')}.`;
}

function contextLines(run: RunContext, workflow: WorkflowContext): string {
  return `${describeRun(run)}; ${describeWorkflow(workflow)}.`;
}

function errorLine(message: string | undefined, truncated: boolean | undefined): string[] {
  if (message === undefined) {
    return [];
  }
  const suffix = truncated === true ? ' [truncated]' : '';
  return [`Error (unverified CI output): ${quoteError(message)}${suffix}`];
}

export const getCiJobTool = defineTool({
  name: 'depot_get_ci_job',
  title: 'Get a Depot CI job',
  description: `Show one Depot CI job: its status, conclusion, recorded error, runner labels, timing, and every attempt with the attempt and sandbox ids needed to drill in.

Use this when you already have a jobId (from depot_get_ci_run or a diagnosis) and want to know what happened to that job across retries: which attempt is current, whether earlier attempts failed the same way, how long each took, and where each ran. It fills the gap between the run tree and the raw logs.

It does not explain the failure and does not return logs. For root cause, call depot_diagnose_ci_failure with the same jobId; for a single attempt's record, depot_get_ci_attempt; for the whole run, depot_get_ci_run.`,
  inputSchema: {
    jobId: z
      .string()
      .min(1)
      .describe('The job id, as shown by depot_get_ci_run (jobId=...) or a diagnosis.'),
  },
  outputSchema: {
    run: runContextSchema,
    workflow: workflowContextSchema,
    job: jobDetailSchema,
    attempts: z.array(attemptDetailSchema).describe('Every attempt, newest first.'),
    attemptCount: z.number(),
    contentWarning: contentWarningSchema,
  },
  handler: async (input, context) => {
    const jobId = input.jobId.trim();
    const response = await context.api.getJob(jobId);
    const run = parseRunContext(response);
    const workflow = parseWorkflowContext(response);
    const job = parseJobDetail(response);
    const attempts = newestFirst(parseAttempts(response));

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(jobHeadline(job, jobId), contextLines(run, workflow));
    text.push(...errorLine(job.errorMessage, job.errorMessageTruncated));

    if (attempts.length === 0) {
      text.push('', 'No attempts recorded yet.');
    } else {
      text.push('', `${attempts.length} attempt(s), newest first:`);
      for (const attempt of attempts) {
        text.push(`  ${describeAttempt(attempt)}`);
        if (attempt.errorMessage !== undefined && attempt.errorMessage !== job.errorMessage) {
          text.push(`    ${errorLine(attempt.errorMessage, attempt.errorMessageTruncated)[0] ?? ''}`);
        }
      }
    }

    const currentAttemptId =
      job.currentAttemptId ?? attempts.find((attempt) => attempt.isCurrent)?.attemptId ?? attempts[0]?.attemptId;
    const logsHint =
      currentAttemptId === undefined
        ? undefined
        : `depot_get_ci_logs {"id":"${currentAttemptId}"} reads the raw output of the current attempt`;
    if (isFailed(job)) {
      text.push(
        '',
        `Next: depot_diagnose_ci_failure {"id":"${job.jobId ?? jobId}"} explains why it failed${
          logsHint === undefined ? '' : `; ${logsHint}`
        }.`,
      );
    } else if (logsHint !== undefined) {
      text.push('', `Next: ${logsHint}.`);
    } else {
      text.push(
        '',
        'No attempt has started yet. Re-check later, or see the whole run with depot_get_ci_run.',
      );
    }

    return {
      summary: text.render(),
      data: {
        run,
        workflow,
        job,
        attempts,
        attemptCount: attempts.length,
        contentWarning: UNTRUSTED_CI_CONTENT_WARNING,
      },
    };
  },
});

function attemptHeadline(attempt: AttemptDetail, job: JobDetail, fallbackId: string): string {
  const name = quoteName(job.jobDisplayName ?? job.jobKey, 'unnamed job');
  const bits = [
    formatState(attempt),
    attempt.durationSeconds === undefined ? undefined : formatDuration(attempt.durationSeconds),
    attempt.isCurrent === true ? 'current' : attempt.isCurrent === false ? 'superseded' : undefined,
    attempt.sandboxId === undefined ? undefined : `sandboxId=${attempt.sandboxId}`,
  ].filter((bit): bit is string => bit !== undefined);
  return `Attempt ${attempt.attempt ?? '?'} of job ${name} (attemptId=${
    attempt.attemptId ?? fallbackId
  }${job.jobId === undefined ? '' : `, jobId=${job.jobId}`}) — ${bits.join(', ')}.`;
}

export const getCiAttemptTool = defineTool({
  name: 'depot_get_ci_attempt',
  title: 'Get a Depot CI job attempt',
  description: `Show one attempt of a Depot CI job: its status, conclusion, recorded error, sandbox and session ids, timing, and whether it is the job's current attempt, with the parent job, workflow, and run for context.

Use this when you hold an attemptId (from depot_get_ci_run, depot_get_ci_job, or a diagnosis) and need that attempt's own record, for example to confirm which sandbox a retry ran in or how long it took before failing.

It does not explain the failure and does not return logs. For root cause, call depot_diagnose_ci_failure with the same id and targetType "attempt"; for raw output, depot_get_ci_logs; to compare all attempts of the job, depot_get_ci_job.`,
  inputSchema: {
    attemptId: z
      .string()
      .min(1)
      .describe('The attempt id, as shown by depot_get_ci_run or depot_get_ci_job (attemptId=...).'),
  },
  outputSchema: {
    run: runContextSchema,
    workflow: workflowContextSchema,
    job: jobDetailSchema,
    attempt: attemptDetailSchema,
    contentWarning: contentWarningSchema,
  },
  handler: async (input, context) => {
    const attemptId = input.attemptId.trim();
    const response = await context.api.getAttempt(attemptId);
    const run = parseRunContext(response);
    const workflow = parseWorkflowContext(response);
    const job = parseJobDetail(response);
    const attempt = parseAttemptDetail(readObject(response, 'attempt') ?? {});

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(attemptHeadline(attempt, job, attemptId), contextLines(run, workflow));
    const error =
      attempt.errorMessage === undefined
        ? errorLine(job.errorMessage, job.errorMessageTruncated)
        : errorLine(attempt.errorMessage, attempt.errorMessageTruncated);
    text.push(...error);

    const id = attempt.attemptId ?? attemptId;
    if (isFailed(attempt) || (attempt.status === undefined && isFailed(job))) {
      text.push(
        '',
        `Next: depot_diagnose_ci_failure {"id":"${id}","targetType":"attempt"} explains why it failed; depot_get_ci_logs {"id":"${id}"} reads its raw output.`,
      );
    } else {
      text.push('', `Next: depot_get_ci_logs {"id":"${id}"} reads its raw output.`);
    }

    return {
      summary: text.render(),
      data: { run, workflow, job, attempt, contentWarning: UNTRUSTED_CI_CONTENT_WARNING },
    };
  },
});
