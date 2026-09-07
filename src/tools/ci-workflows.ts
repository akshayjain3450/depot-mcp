import { z } from 'zod';
import { readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import {
  describeAttempt,
  describeRun,
  formatState,
  isFailed,
  parseRunContext,
  parseWorkflowContext,
  quoteName,
  runContextSchema,
  workflowContextSchema,
  type WorkflowContext,
} from '../lib/ci-detail.js';
import {
  currentWorkflowTiming,
  describeExecutionPosition,
  executionSchema,
  latestExecution,
  parseExecution,
  parseWorkflowJob,
  parseWorkflowListEntry,
  workflowJobSchema,
  workflowListEntrySchema,
  type Execution,
  type WorkflowJob,
} from '../lib/ci-workflow.js';
import { formatDuration } from '../lib/time.js';
import { defineTool, ToolInputError } from '../lib/tool.js';

const WORKFLOW_STATUSES = ['queued', 'running', 'finished', 'failed', 'cancelled'] as const;

function describeJobCounts(counts: Record<string, number>): string | undefined {
  const total = counts.total;
  if (total === undefined) {
    return undefined;
  }
  const failed = counts.failed;
  return `${total} job(s)${failed === undefined ? '' : `, ${failed} failed`}`;
}

export const listCiWorkflowsTool = defineTool({
  name: 'depot_list_ci_workflows',
  title: 'List Depot CI workflows',
  description: `List recent Depot CI workflows, newest first, with each one's status and job counts, optionally filtered by workflow name, status, repository, commit, trigger, or pull request.

Use this when the question is about a named workflow rather than a whole run: "is the deploy workflow green", "which CI workflows failed today", "how many jobs failed in the release workflow". A run groups every workflow a push triggered; this lists the workflows themselves, each with its parent runId.

Returns identity, status, and counts only. It does not return jobs or failure detail: pass a workflowId to depot_get_ci_workflow for its jobs and rerun history, or to depot_diagnose_ci_failure with targetType "workflow" for root cause.`,
  inputSchema: {
    name: z
      .string()
      .optional()
      .describe('Keep only workflows with this name, as written in the workflow YAML "name:" field.'),
    repo: z
      .string()
      .optional()
      .describe('Repository in "owner/name" form. Required when filtering by pr.'),
    status: z
      .array(z.enum(WORKFLOW_STATUSES))
      .optional()
      .describe(
        'Keep only workflows in these states. "finished" means completed successfully; a failed workflow reports "failed". Omit for every state.',
      ),
    trigger: z
      .string()
      .optional()
      .describe('Filter by what started the workflow, for example "push" or "workflow_dispatch".'),
    sha: z.string().optional().describe('Filter to workflows for one commit SHA.'),
    pr: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Pull request number. Depot requires repo to be set alongside this.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(20)
      .describe('Maximum workflows to return in one call.'),
    pageToken: z
      .string()
      .optional()
      .describe('nextPageToken from a previous call, to fetch the following page.'),
  },
  outputSchema: {
    workflows: z.array(workflowListEntrySchema),
    returned: z.number(),
    nextPageToken: z.string().optional(),
  },
  handler: async (input, context) => {
    if (input.pr !== undefined && input.repo === undefined) {
      throw new ToolInputError(
        'Depot requires a repo ("owner/name") when filtering workflows by pull request number. Re-call with both repo and pr.',
      );
    }

    const response = await context.api.listWorkflows({
      name: input.name,
      repo: input.repo,
      // Unlike ListRuns, ListWorkflows answers without a status filter (verified live
      // 2026-09-06), so the filter is sent only when the caller gave one.
      status: input.status === undefined ? undefined : [...input.status],
      trigger: input.trigger,
      sha: input.sha,
      pr: input.pr,
      pageSize: input.limit,
      pageToken: input.pageToken,
    });

    const workflows = readObjectArray(response, 'workflows').map(parseWorkflowListEntry);
    const nextPageToken = readString(response, 'nextPageToken');
    const text = new TextBudget(context.config.outputCharBudget);

    if (workflows.length === 0) {
      text.push(
        'No Depot CI workflows matched those filters.',
        'If you expected results: check the filters (status values are queued, running, finished, failed, cancelled; name must match the workflow YAML exactly), and if your token spans several organizations set DEPOT_ORG_ID; a mismatched organization returns an empty list rather than an error. depot_whoami confirms what this token can see.',
      );
      return { summary: text.render(), data: { workflows, returned: 0, nextPageToken } };
    }

    text.push(`${workflows.length} Depot CI workflow(s), newest first:`);
    for (const workflow of workflows) {
      const bits = [
        quoteName(workflow.name, 'unnamed'),
        workflow.status ?? 'unknown status',
        workflow.repo,
        workflow.sha === undefined ? undefined : workflow.sha.slice(0, 8),
        workflow.pr === undefined ? undefined : `PR ${workflow.pr}`,
        workflow.trigger === undefined ? undefined : `via ${workflow.trigger}`,
        describeJobCounts(workflow.jobCounts),
        workflow.runId === undefined ? undefined : `run ${workflow.runId}`,
        workflow.createdAt,
      ].filter((bit): bit is string => bit !== undefined);
      text.push(`  ${workflow.workflowId ?? 'unknown id'} — ${bits.join(' · ')}`);
    }
    if (nextPageToken !== undefined) {
      text.push('', `More workflows available: re-call with pageToken="${nextPageToken}".`);
    }
    const failed = workflows.find((workflow) => isFailed(workflow));
    if (failed !== undefined) {
      const id = failed.workflowId ?? '';
      text.push(
        '',
        `Diagnose a failure with depot_diagnose_ci_failure {"id":"${id}","targetType":"workflow"}, or see its jobs with depot_get_ci_workflow {"workflowId":"${id}"}.`,
      );
    }

    return {
      summary: text.render(),
      data: { workflows, returned: workflows.length, nextPageToken },
    };
  },
});

function describeExecution(execution: Execution): string {
  const bits = [
    execution.status ?? 'unknown',
    execution.durationSeconds === undefined ? undefined : formatDuration(execution.durationSeconds),
    execution.executionId === undefined ? undefined : `executionId=${execution.executionId}`,
  ].filter((bit): bit is string => bit !== undefined);
  return `#${execution.execution ?? '?'} ${bits.join(', ')}`;
}

function workflowHeadline(
  workflow: WorkflowContext,
  fallbackId: string,
  executions: Execution[],
  jobs: WorkflowJob[],
): string {
  const failed = jobs.filter(isFailed).length;
  const position = describeExecutionPosition(executions);
  const duration =
    workflow.durationSeconds === undefined ? undefined : formatDuration(workflow.durationSeconds);
  const bits = [
    workflow.status ?? 'unknown status',
    position === undefined ? duration : `${duration ?? 'unknown duration'} (${position})`,
    `${jobs.length} job(s)`,
    `${failed} failed`,
  ].filter((bit): bit is string => bit !== undefined);
  return `Workflow ${quoteName(workflow.name, 'unnamed')} (workflowId=${
    workflow.workflowId ?? fallbackId
  }) — ${bits.join(', ')}.`;
}

export const getCiWorkflowTool = defineTool({
  name: 'depot_get_ci_workflow',
  title: 'Get a Depot CI workflow',
  description: `Show one Depot CI workflow: its status and timing, its parent run, its execution history (every rerun or retry, oldest first), and its job -> attempt tree with the ids needed to drill in.

Use this when you have a workflowId (from depot_list_ci_workflows, depot_get_ci_run, or a diagnosis) and want to see how the workflow has been rerun and which of its jobs and attempts failed. It is the workflow-level counterpart of depot_get_ci_run.

It does not explain failures or return logs. For root cause, call depot_diagnose_ci_failure with the same id and targetType "workflow"; for one job across its attempts, depot_get_ci_job; for a whole run with several workflows, depot_get_ci_run.`,
  inputSchema: {
    workflowId: z
      .string()
      .min(1)
      .describe('The workflow id, as returned by depot_list_ci_workflows or depot_get_ci_run.'),
  },
  outputSchema: {
    run: runContextSchema,
    workflow: workflowContextSchema.describe(
      'The workflow as it stands now. startedAt, finishedAt and durationSeconds are those of the latest execution when Depot lists executions; the top-level timing Depot returns spans from the first start to the last finish and is not the time anything ran.',
    ),
    executions: z
      .array(executionSchema)
      .describe('Rerun and retry lineage in the order Depot reports it, oldest first.'),
    executionCount: z.number(),
    latestExecution: executionSchema
      .optional()
      .describe('The execution with the highest number: the one whose timing the summary reports.'),
    jobs: z.array(workflowJobSchema),
    jobCount: z.number(),
    failedJobCount: z.number(),
  },
  handler: async (input, context) => {
    const workflowId = input.workflowId.trim();
    const response = await context.api.getWorkflow(workflowId);
    const run = parseRunContext(response);
    const executions = readObjectArray(response, 'executions').map(parseExecution);
    const reported = parseWorkflowContext(response);
    const workflow: WorkflowContext = { ...reported, ...currentWorkflowTiming(reported, executions) };
    const jobs = readObjectArray(response, 'jobs').map(parseWorkflowJob);
    const failedJobCount = jobs.filter(isFailed).length;

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(workflowHeadline(workflow, workflowId, executions, jobs), `${describeRun(run)}.`);

    if (executions.length > 0) {
      const label = executions.length === 1 ? 'Executions' : `Executions (${executions.length}, oldest first)`;
      text.push(`${label}: ${executions.map(describeExecution).join('; ')}`);
    }

    if (jobs.length === 0) {
      text.push('', 'No jobs recorded for this workflow yet.');
    } else {
      text.push('', 'Jobs:');
      for (const job of jobs) {
        const duration = job.durationSeconds === undefined ? '' : `, ${formatDuration(job.durationSeconds)}`;
        text.push(
          `  ${quoteName(job.jobKey, 'unnamed job')} — ${formatState(job)}${duration}${
            job.jobId === undefined ? '' : ` (jobId=${job.jobId})`
          }`,
        );
        for (const attempt of job.attempts) {
          text.push(`    ${describeAttempt(attempt)}`);
        }
      }
    }

    if (failedJobCount > 0 || isFailed(workflow)) {
      text.push(
        '',
        `Explain the failures with depot_diagnose_ci_failure {"id":"${workflow.workflowId ?? workflowId}","targetType":"workflow"} rather than reading logs job by job.`,
      );
    }

    return {
      summary: text.render(),
      data: {
        run,
        workflow,
        executions,
        executionCount: executions.length,
        latestExecution: latestExecution(executions),
        jobs,
        jobCount: jobs.length,
        failedJobCount,
      },
    };
  },
});
