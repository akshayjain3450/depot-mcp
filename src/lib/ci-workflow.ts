import { z } from 'zod';
import { readEnum, readNumber, readObject, readString, type JsonObject } from '../depot/shape.js';
import { parseAttempts, parseJobDetail } from './ci-detail.js';
import { STATUS_PREFIXES } from './ci-tree.js';
import { durationSecondsBetween } from './time.js';

/** Shapes specific to `ListWorkflows` and `GetWorkflow`, verified live 2026-09-06. */

export const workflowListEntrySchema = z.object({
  workflowId: z.string().optional(),
  name: z.string().optional(),
  repo: z.string().optional(),
  status: z.string().optional(),
  trigger: z.string().optional(),
  runId: z.string().optional(),
  sha: z.string().optional(),
  headSha: z.string().optional(),
  pr: z.number().optional(),
  createdAt: z.string().optional(),
  jobCounts: z
    .record(z.string(), z.number())
    .describe('Whatever counters Depot reports for the workflow, typically total and failed.'),
});

export type WorkflowListEntry = z.infer<typeof workflowListEntrySchema>;

export function parseWorkflowListEntry(source: JsonObject): WorkflowListEntry {
  const counts = readObject(source, 'jobCounts') ?? {};
  const jobCounts: Record<string, number> = {};
  for (const key of Object.keys(counts)) {
    const value = readNumber(counts, key);
    if (value !== undefined) {
      jobCounts[key] = value;
    }
  }
  return {
    workflowId: readString(source, 'workflowId', 'id'),
    name: readString(source, 'name', 'workflowName'),
    repo: readString(source, 'repo', 'repository'),
    status: readEnum(source, ['status', 'workflowStatus'], STATUS_PREFIXES),
    trigger: readEnum(source, ['trigger'], ['trigger']),
    runId: readString(source, 'runId'),
    sha: readString(source, 'sha'),
    headSha: readString(source, 'headSha'),
    pr: readNumber(source, 'pr', 'pullRequest'),
    createdAt: readString(source, 'createdAt'),
    jobCounts,
  };
}

export const executionSchema = z.object({
  executionId: z.string().optional(),
  execution: z.number().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
});

export const workflowAttemptSchema = z.object({
  attemptId: z.string().optional(),
  attempt: z.number().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  sandboxId: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
});

export const workflowJobSchema = z.object({
  jobId: z.string().optional(),
  jobKey: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
  attempts: z.array(workflowAttemptSchema),
});

export type Execution = z.infer<typeof executionSchema>;
export type WorkflowJob = z.infer<typeof workflowJobSchema>;

export function parseExecution(source: JsonObject): Execution {
  const startedAt = readString(source, 'startedAt');
  const finishedAt = readString(source, 'finishedAt');
  return {
    executionId: readString(source, 'executionId', 'id'),
    execution: readNumber(source, 'execution', 'executionNumber'),
    status: readEnum(source, ['status', 'executionStatus'], STATUS_PREFIXES),
    createdAt: readString(source, 'createdAt'),
    startedAt,
    finishedAt,
    durationSeconds: durationSecondsBetween(startedAt, finishedAt),
  };
}

export function parseWorkflowJob(source: JsonObject): WorkflowJob {
  const job = parseJobDetail(source);
  return {
    jobId: job.jobId,
    jobKey: job.jobKey ?? job.jobDisplayName,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationSeconds: job.durationSeconds,
    attempts: parseAttempts(source).map((attempt) => ({
      attemptId: attempt.attemptId,
      attempt: attempt.attempt,
      status: attempt.status,
      conclusion: attempt.conclusion,
      sandboxId: attempt.sandboxId,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      durationSeconds: attempt.durationSeconds,
    })),
  };
}
