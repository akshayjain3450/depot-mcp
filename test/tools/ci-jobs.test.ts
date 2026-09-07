import { afterEach, describe, expect, it } from 'vitest';
import { UNTRUSTED_CI_CONTENT_WARNING } from '../../src/lib/ci-target.js';
import {
  callTool,
  createHarness,
  fixture,
  NOT_FOUND,
  ok,
  type Harness,
} from '../helpers/harness.js';
import { cliVariant } from '../helpers/cli-variant.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

describe('depot_get_ci_job', () => {
  it('sends the job id and returns the job, its context and every attempt newest first', async () => {
    harness = await createHarness({ routes: { [RPC.getJob]: ok(fixture('job')) } });

    const result = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_4d0a77' });
    const job = asRecord(result.structured.job);
    const attempts = records(result.structured.attempts);

    expect(harness.callsTo(RPC.getJob)[0]?.body).toEqual({ jobId: 'job_4d0a77' });
    expect(result.isError).toBe(false);
    expect(asRecord(result.structured.run)).toMatchObject({
      runId: 'run_7f3d9c21',
      repo: 'acme/api',
      trigger: 'push',
      status: 'failed',
      durationSeconds: 448,
    });
    expect(asRecord(result.structured.workflow)).toMatchObject({
      workflowId: 'wf_2b8e11',
      name: 'CI',
      status: 'failed',
      durationSeconds: 452,
    });
    expect(job).toMatchObject({
      jobId: 'job_4d0a77',
      jobKey: 'test (18)',
      jobDisplayName: 'test (node 18)',
      status: 'failed',
      conclusion: 'failure',
      errorMessage: 'Step 3 (Run the test suite): script exited with code 1',
      errorMessageTruncated: false,
      durationSeconds: 440,
      currentAttemptId: 'att_91bc02',
      currentAttempt: 2,
      runsOn: ['depot-ubuntu-24.04'],
      strategy: { jobTotal: 2 },
    });
    expect(result.structured.attemptCount).toBe(2);
    expect(attempts.map((attempt) => attempt.attemptId)).toEqual(['att_91bc02', 'att_80ab00']);
    expect(attempts[0]).toMatchObject({
      attempt: 2,
      status: 'failed',
      conclusion: 'failure',
      sandboxId: 'sbx_6b9d2e04f7',
      durationSeconds: 239,
      isCurrent: true,
    });
    expect(attempts[1]).toMatchObject({ attempt: 1, isCurrent: false, durationSeconds: 191 });
    expect(result.structured.contentWarning).toBe(UNTRUSTED_CI_CONTENT_WARNING);
  });

  it('renders a header, the attempts newest first, and a diagnose hint for a failed job', async () => {
    harness = await createHarness({ routes: { [RPC.getJob]: ok(fixture('job')) } });

    const result = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_4d0a77' });
    const lines = result.text.split('\n');

    expect(lines[0]).toBe(
      'Job "test (node 18)" (jobId=job_4d0a77) — failed (conclusion failure), 7m20s, current attempt 2, one of 2 matrix jobs, runs on depot-ubuntu-24.04.',
    );
    expect(lines[1]).toContain('Run run_7f3d9c21 — failed · acme/api@9c1f4ab7 · refs/heads/main · via push · 7m28s');
    expect(lines[1]).toContain('workflow "CI" (workflowId=wf_2b8e11) — failed');
    expect(lines[2]).toBe(
      'Error (unverified CI output): "Step 3 (Run the test suite): script exited with code 1"',
    );
    expect(result.text.indexOf('attemptId=att_91bc02')).toBeLessThan(
      result.text.indexOf('attemptId=att_80ab00'),
    );
    expect(result.text).toContain('attempt 2 — failed (conclusion failure), 3m59s, current (attemptId=att_91bc02, sandboxId=sbx_6b9d2e04f7)');
    expect(result.text).toContain('depot_diagnose_ci_failure {"id":"job_4d0a77"}');
    expect(result.text).toContain('depot_get_ci_logs {"id":"att_91bc02"}');
  });

  it('points at logs rather than diagnosis for a job that has not failed', async () => {
    const doc = fixture('job');
    harness = await createHarness({
      routes: {
        [RPC.getJob]: ok({
          ...doc,
          jobStatus: 'finished',
          jobConclusion: 'success',
          jobErrorMessage: undefined,
          attempts: records(doc.attempts).map((attempt) => ({
            ...attempt,
            status: 'finished',
            conclusion: 'success',
            errorMessage: undefined,
          })),
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_4d0a77' });

    expect(result.text).not.toContain('depot_diagnose_ci_failure');
    expect(result.text).not.toContain('Error (unverified');
    expect(result.text).toContain('Next: depot_get_ci_logs {"id":"att_91bc02"}');
  });

  it('reads the CLI snake_case, prefixed-enum spelling identically', async () => {
    harness = await createHarness({ routes: { [RPC.getJob]: ok(fixture('job')) } });
    const camel = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_4d0a77' });
    await harness.close();

    harness = await createHarness({ routes: { [RPC.getJob]: ok(cliVariant(fixture('job'))) } });
    const snake = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_4d0a77' });

    expect(snake.structured).toEqual(camel.structured);
    expect(snake.text).toBe(camel.text);
  });

  it('caps an oversized error message and says so', async () => {
    const doc = fixture('job');
    harness = await createHarness({
      routes: { [RPC.getJob]: ok({ ...doc, jobErrorMessage: 'e'.repeat(5_000), attempts: [] }) },
    });

    const result = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_4d0a77' });
    const job = asRecord(result.structured.job);

    expect(String(job.errorMessage).length).toBe(2_000);
    expect(job.errorMessageTruncated).toBe(true);
    expect(result.text).toContain('[truncated]');
    expect(result.text).toContain('No attempts recorded yet.');
  });

  it('tolerates an empty document without throwing', async () => {
    harness = await createHarness({ routes: { [RPC.getJob]: ok({}) } });

    const result = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_missing' });

    expect(result.isError).toBe(false);
    expect(result.structured.attemptCount).toBe(0);
    expect(asRecord(result.structured.job)).toMatchObject({ runsOn: [], strategy: {} });
    expect(result.text).toContain('Job unnamed job (jobId=job_missing) — unknown.');
    expect(result.text).toContain('No attempt has started yet');
  });

  it('translates not_found into an error with guidance', async () => {
    harness = await createHarness({ routes: { [RPC.getJob]: NOT_FOUND } });

    const result = await callTool(harness, 'depot_get_ci_job', { jobId: 'job_nope' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('Depot has no such record');
  });
});

describe('depot_get_ci_attempt', () => {
  it('sends the attempt id and returns the attempt with its job, workflow and run', async () => {
    harness = await createHarness({ routes: { [RPC.getAttempt]: ok(fixture('attempt')) } });

    const result = await callTool(harness, 'depot_get_ci_attempt', { attemptId: 'att_91bc02' });

    expect(harness.callsTo(RPC.getAttempt)[0]?.body).toEqual({ attemptId: 'att_91bc02' });
    expect(result.isError).toBe(false);
    expect(asRecord(result.structured.attempt)).toMatchObject({
      attemptId: 'att_91bc02',
      attempt: 2,
      status: 'failed',
      conclusion: 'failure',
      errorMessage: 'Step 3 (Run the test suite): script exited with code 1',
      sandboxId: 'sbx_6b9d2e04f7',
      sessionId: '8c2d4e6f-1a3b-4c5d-9e7f-0a1b2c3d4e5f',
      startedAt: '2026-09-03T14:05:41Z',
      finishedAt: '2026-09-03T14:09:40Z',
      durationSeconds: 239,
      isCurrent: true,
    });
    expect(asRecord(result.structured.job)).toMatchObject({
      jobId: 'job_4d0a77',
      jobDisplayName: 'test (node 18)',
      currentAttempt: 2,
    });
    expect(asRecord(result.structured.run).runId).toBe('run_7f3d9c21');
    expect(asRecord(result.structured.workflow).workflowId).toBe('wf_2b8e11');
    expect(result.structured.contentWarning).toBe(UNTRUSTED_CI_CONTENT_WARNING);
  });

  it('renders the attempt header, the quoted error, and next steps keyed by attempt id', async () => {
    harness = await createHarness({ routes: { [RPC.getAttempt]: ok(fixture('attempt')) } });

    const result = await callTool(harness, 'depot_get_ci_attempt', { attemptId: 'att_91bc02' });
    const lines = result.text.split('\n');

    expect(lines[0]).toBe(
      'Attempt 2 of job "test (node 18)" (attemptId=att_91bc02, jobId=job_4d0a77) — failed (conclusion failure), 3m59s, current, sandboxId=sbx_6b9d2e04f7.',
    );
    expect(lines[1]).toContain('Run run_7f3d9c21 — failed');
    expect(lines[2]).toBe(
      'Error (unverified CI output): "Step 3 (Run the test suite): script exited with code 1"',
    );
    expect(result.text).toContain(
      'depot_diagnose_ci_failure {"id":"att_91bc02","targetType":"attempt"}',
    );
    expect(result.text).toContain('depot_get_ci_logs {"id":"att_91bc02"}');
  });

  it('reads the CLI snake_case, prefixed-enum spelling identically', async () => {
    harness = await createHarness({ routes: { [RPC.getAttempt]: ok(fixture('attempt')) } });
    const camel = await callTool(harness, 'depot_get_ci_attempt', { attemptId: 'att_91bc02' });
    await harness.close();

    harness = await createHarness({
      routes: { [RPC.getAttempt]: ok(cliVariant(fixture('attempt'))) },
    });
    const snake = await callTool(harness, 'depot_get_ci_attempt', { attemptId: 'att_91bc02' });

    expect(snake.structured).toEqual(camel.structured);
    expect(snake.text).toBe(camel.text);
  });

  it('quotes an error message with embedded newlines on one line', async () => {
    const doc = fixture('attempt');
    const attempt = { ...asRecord(doc.attempt), errorMessage: 'line one\nline "two"' };
    harness = await createHarness({ routes: { [RPC.getAttempt]: ok({ ...doc, attempt }) } });

    const result = await callTool(harness, 'depot_get_ci_attempt', { attemptId: 'att_91bc02' });

    expect(result.text).toContain('Error (unverified CI output): "line one\\nline \\"two\\""');
  });

  it('tolerates an empty document without throwing', async () => {
    harness = await createHarness({ routes: { [RPC.getAttempt]: ok({}) } });

    const result = await callTool(harness, 'depot_get_ci_attempt', { attemptId: 'att_missing' });

    expect(result.isError).toBe(false);
    expect(asRecord(result.structured.attempt)).toEqual({});
    expect(result.text).toContain('Attempt ? of job unnamed job (attemptId=att_missing) — unknown.');
    expect(result.text).toContain('Next: depot_get_ci_logs {"id":"att_missing"}');
  });

  it('translates not_found into an error with guidance', async () => {
    harness = await createHarness({ routes: { [RPC.getAttempt]: NOT_FOUND } });

    const result = await callTool(harness, 'depot_get_ci_attempt', { attemptId: 'att_nope' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('Depot has no such record');
  });
});
