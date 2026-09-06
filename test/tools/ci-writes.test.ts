import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { JsonObject } from '../../src/depot/shape.js';
import { RETRY_ATTEMPT_CAP } from '../../src/tools/ci-writes.js';
import { callTool, connectError, createHarness, fixture, ok, type Harness, type StubRoutes } from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const MUTATING_RPCS: readonly string[] = [
  RPC.cancelRun,
  RPC.cancelWorkflow,
  RPC.cancelJob,
  RPC.retryJob,
  RPC.retryFailedJobs,
  RPC.rerunWorkflow,
];

async function writable(routes: StubRoutes): Promise<Harness> {
  harness = await createHarness({ routes, config: { allowWrites: true } });
  return harness;
}

function mutatingCalls(h: Harness): string[] {
  return h.calls.map((call) => call.rpc).filter((rpc) => MUTATING_RPCS.includes(rpc));
}

function job(overrides: JsonObject = {}): JsonObject {
  return { ...fixture('job'), ...overrides };
}

function runningJob(): JsonObject {
  const running = job({ jobStatus: 'running', workflowStatus: 'running', runStatus: 'running' });
  delete running.jobConclusion;
  return running;
}

function workflow(overrides: JsonObject = {}): JsonObject {
  return { ...fixture('workflow'), ...overrides };
}

/** The fixture workflow with its failed job at `attempts` attempts, for the retry cap. */
function workflowWithAttempts(attempts: number): JsonObject {
  const base = fixture('workflow');
  const jobs = (base.jobs as JsonObject[]).map((entry) =>
    entry.jobId === 'job_4d0a77'
      ? {
          ...entry,
          attempts: Array.from({ length: attempts }, (_, index) => ({
            attemptId: `att_${index + 1}`,
            attempt: index + 1,
            status: 'failed',
          })),
        }
      : entry,
  );
  return { ...base, jobs };
}

function greenWorkflow(): JsonObject {
  const base = fixture('workflow');
  const jobs = (base.jobs as JsonObject[]).map((entry) => ({ ...entry, status: 'finished' }));
  return { ...base, workflowStatus: 'finished', runStatus: 'finished', jobs };
}

type StderrSpy = MockInstance<typeof console.error>;

function audit(): StderrSpy {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function auditLines(spy: StderrSpy): string[] {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line) => line.startsWith('[depot-mcp write]'));
}

describe('depot_cancel_ci_run', () => {
  it('dry-runs a running run: reads GetRunStatus, previews the active jobs, calls nothing mutating', async () => {
    const h = await writable({ [RPC.getRunStatus]: ok(fixture('run-status-running')) });

    const result = await callTool(h, 'depot_cancel_ci_run', { runId: 'run_9a1b2c' });

    expect(result.isError).toBe(false);
    expect(result.structured.applied).toBe(false);
    expect(result.structured.refusal).toBeUndefined();
    expect(result.structured.preview).toMatchObject({
      target: 'run',
      runId: 'run_9a1b2c',
      status: 'running',
      workflowCount: 1,
      jobCount: 3,
      activeJobCount: 2,
    });
    expect(result.structured.resend).toEqual({ runId: 'run_9a1b2c', dryRun: false });
    expect(result.text).toContain('2 job(s) would be stopped');
    expect(result.text).toContain('"test (18)" running');
    expect(h.callsTo(RPC.getRunStatus)[0]?.body).toEqual({ runId: 'run_9a1b2c' });
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('applies with CancelRun {runId}, reports the response ids, and logs one audit line', async () => {
    const h = await writable({
      [RPC.getRunStatus]: ok(fixture('run-status-running')),
      [RPC.cancelRun]: ok({ runId: 'run_9a1b2c', status: 'cancelled' }),
    });
    const spy = audit();

    const result = await callTool(h, 'depot_cancel_ci_run', { runId: 'run_9a1b2c', dryRun: false });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(result.structured.before).toMatchObject({ target: 'run', status: 'running' });
    expect(result.structured.after).toEqual({
      rpc: 'CancelRun',
      status: 'cancelled',
      ids: { runId: 'run_9a1b2c' },
      responseKeys: ['runId', 'status'],
    });
    expect(h.callsTo(RPC.cancelRun)).toHaveLength(1);
    expect(h.callsTo(RPC.cancelRun)[0]?.body).toEqual({ runId: 'run_9a1b2c' });
    expect(h.callsTo(RPC.cancelRun)[0]?.headers.authorization).toBe('Bearer test-token-never-logged');
    expect(auditLines(spy)).toHaveLength(1);
    expect(auditLines(spy)[0]).toMatch(/^\[depot-mcp write\] depot_cancel_ci_run runId=run_9a1b2c \d{4}-/);
    expect(result.text).not.toContain('test-token-never-logged');
  });

  it('refuses a terminal run on apply, before any mutating call', async () => {
    const h = await writable({ [RPC.getRunStatus]: ok(fixture('run-status')) });

    const result = await callTool(h, 'depot_cancel_ci_run', { runId: 'run_7f3d9c21', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('already failed');
    expect(result.text).toContain('nothing to cancel');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('reports the same refusal on a dry run without an error', async () => {
    const h = await writable({ [RPC.getRunStatus]: ok(fixture('run-status')) });

    const result = await callTool(h, 'depot_cancel_ci_run', { runId: 'run_7f3d9c21' });

    expect(result.isError).toBe(false);
    expect(String(result.structured.refusal)).toContain('already failed');
    expect(result.structured.resend).toBeUndefined();
  });

  it('cancels one workflow with CancelWorkflow {workflowId} when workflowId is given', async () => {
    const h = await writable({
      [RPC.getWorkflow]: ok(workflow({ workflowStatus: 'running', runStatus: 'running' })),
      [RPC.cancelWorkflow]: ok({}),
    });
    audit();

    const dry = await callTool(h, 'depot_cancel_ci_run', { workflowId: 'wf_2b8e11', runId: 'run_7f3d9c21' });
    expect(dry.structured.preview).toMatchObject({ target: 'workflow', workflowId: 'wf_2b8e11', runId: 'run_7f3d9c21' });
    expect(mutatingCalls(h)).toEqual([]);

    const applied = await callTool(h, 'depot_cancel_ci_run', { workflowId: 'wf_2b8e11', dryRun: false });

    expect(applied.isError, applied.text).toBe(false);
    expect(h.callsTo(RPC.cancelWorkflow)[0]?.body).toEqual({ workflowId: 'wf_2b8e11' });
    expect(h.callsTo(RPC.cancelRun)).toHaveLength(0);
    expect(applied.structured.after).toMatchObject({ rpc: 'CancelWorkflow', ids: {}, responseKeys: [] });
    expect(applied.text).toContain('empty response body');
  });

  it('refuses a workflowId that belongs to a different run than the one named', async () => {
    const h = await writable({ [RPC.getWorkflow]: ok(workflow({ workflowStatus: 'running' })) });

    const result = await callTool(h, 'depot_cancel_ci_run', {
      workflowId: 'wf_2b8e11',
      runId: 'run_other',
      dryRun: false,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('belongs to run run_7f3d9c21, not to run run_other');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('asks for an id when given neither', async () => {
    const h = await writable({});

    const result = await callTool(h, 'depot_cancel_ci_run', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Pass runId');
    expect(h.calls).toHaveLength(0);
  });

  it('translates a 412 from CancelRun into a readable error and logs nothing', async () => {
    const h = await writable({
      [RPC.getRunStatus]: ok(fixture('run-status-running')),
      [RPC.cancelRun]: connectError(412, 'failed_precondition', 'run already finished'),
    });
    const spy = audit();

    const result = await callTool(h, 'depot_cancel_ci_run', { runId: 'run_9a1b2c', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Depot refused depot_cancel_ci_run (failed_precondition, HTTP 412)');
    expect(result.text).toContain('Depot said: run already finished');
    expect(auditLines(spy)).toHaveLength(0);
  });
});

describe('depot_cancel_ci_job', () => {
  it('previews from GetJob and applies with CancelJob {jobId}', async () => {
    const h = await writable({ [RPC.getJob]: ok(runningJob()), [RPC.cancelJob]: ok({ jobId: 'job_4d0a77' }) });
    audit();

    const dry = await callTool(h, 'depot_cancel_ci_job', { jobId: 'job_4d0a77' });
    expect(dry.isError).toBe(false);
    expect(dry.structured.preview).toMatchObject({
      jobId: 'job_4d0a77',
      label: '"test (node 18)"',
      state: 'running',
      attemptCount: 2,
      workflowId: 'wf_2b8e11',
    });
    expect(h.callsTo(RPC.getJob)[0]?.body).toEqual({ jobId: 'job_4d0a77' });
    expect(mutatingCalls(h)).toEqual([]);

    const applied = await callTool(h, 'depot_cancel_ci_job', { jobId: 'job_4d0a77', dryRun: false });

    expect(applied.isError, applied.text).toBe(false);
    expect(h.callsTo(RPC.cancelJob)[0]?.body).toEqual({ jobId: 'job_4d0a77' });
    expect(applied.structured.after).toMatchObject({ rpc: 'CancelJob', ids: { jobId: 'job_4d0a77' } });
  });

  it('refuses a job that already finished', async () => {
    const h = await writable({ [RPC.getJob]: ok(fixture('job')) });

    const result = await callTool(h, 'depot_cancel_ci_job', { jobId: 'job_4d0a77', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('already failure');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('refuses a job outside the named run', async () => {
    const h = await writable({ [RPC.getJob]: ok(runningJob()) });

    const result = await callTool(h, 'depot_cancel_ci_job', { jobId: 'job_4d0a77', runId: 'run_nope', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not to run run_nope');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('fences the error message it echoes as untrusted', async () => {
    const h = await writable({ [RPC.getJob]: ok(runningJob()) });

    const result = await callTool(h, 'depot_cancel_ci_job', { jobId: 'job_4d0a77' });

    expect(result.text).toContain('Last error (untrusted CI content): Step 3');
  });
});

describe('depot_retry_ci_failed_jobs', () => {
  it('previews the workflow: failed subset, executions, previous wall time', async () => {
    const h = await writable({ [RPC.getWorkflow]: ok(fixture('workflow')) });

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11' });

    expect(result.isError).toBe(false);
    expect(result.structured.preview).toMatchObject({
      workflowId: 'wf_2b8e11',
      name: 'CI',
      status: 'failed',
      jobCount: 3,
      failedJobCount: 1,
      activeJobCount: 0,
      executionCount: 1,
      previousDurationSeconds: 446,
      failedJobs: [{ jobId: 'job_4d0a77', label: '"test (18)"', state: 'failed', attemptCount: 2 }],
    });
    expect(result.structured.resend).toEqual({ workflowId: 'wf_2b8e11', force: false, dryRun: false });
    expect(result.text).toContain('3 total, 1 failed or cancelled, 0 still active');
    expect(result.text).toContain('last wall time 7m26s');
    expect(result.text).toContain('new attempt for each of the 1 failed job(s)');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('applies with RetryFailedJobs {workflowId}', async () => {
    const h = await writable({
      [RPC.getWorkflow]: ok(fixture('workflow')),
      [RPC.retryFailedJobs]: ok({ workflowId: 'wf_2b8e11', jobs: [{ jobId: 'job_4d0a77', attemptId: 'att_new' }] }),
    });
    const spy = audit();

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11', dryRun: false });

    expect(result.isError, result.text).toBe(false);
    expect(h.callsTo(RPC.retryFailedJobs)[0]?.body).toEqual({ workflowId: 'wf_2b8e11' });
    expect(result.structured.after).toMatchObject({
      rpc: 'RetryFailedJobs',
      ids: { workflowId: 'wf_2b8e11', 'jobs[0].jobId': 'job_4d0a77', 'jobs[0].attemptId': 'att_new' },
    });
    expect(auditLines(spy)[0]).toContain('depot_retry_ci_failed_jobs workflowId=wf_2b8e11');
  });

  it('resolves runId to the single workflow of the run and applies against that id', async () => {
    const h = await writable({
      [RPC.getRunStatus]: ok(fixture('run-status')),
      [RPC.getWorkflow]: ok(fixture('workflow')),
      [RPC.retryFailedJobs]: ok({}),
    });
    audit();

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { runId: 'run_7f3d9c21', dryRun: false });

    expect(result.isError, result.text).toBe(false);
    expect(h.callsTo(RPC.getRunStatus)[0]?.body).toEqual({ runId: 'run_7f3d9c21' });
    expect(h.callsTo(RPC.getWorkflow)[0]?.body).toEqual({ workflowId: 'wf_2b8e11' });
    expect(h.callsTo(RPC.retryFailedJobs)[0]?.body).toEqual({ workflowId: 'wf_2b8e11' });
  });

  it('refuses an ambiguous run, listing its workflows', async () => {
    const tree = fixture('run-status');
    const two = {
      ...tree,
      workflows: [
        ...(tree.workflows as JsonObject[]),
        { workflowId: 'wf_second', name: 'Deploy', status: 'failed', jobs: [] },
      ],
    };
    const h = await writable({ [RPC.getRunStatus]: ok(two) });

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { runId: 'run_7f3d9c21' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('has 2 workflows');
    expect(result.text).toContain('wf_2b8e11');
    expect(result.text).toContain('wf_second');
    expect(h.callsTo(RPC.getWorkflow)).toHaveLength(0);
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('refuses a run with no workflows', async () => {
    const h = await writable({ [RPC.getRunStatus]: ok({ runId: 'run_empty', status: 'queued', workflows: [] }) });

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { runId: 'run_empty' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('no workflows');
  });

  it('asks for an id when given neither', async () => {
    const h = await writable({});

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Pass workflowId');
    expect(h.calls).toHaveLength(0);
  });

  it('refuses a workflow that is still running', async () => {
    const running = workflow({ workflowStatus: 'running' });
    const h = await writable({ [RPC.getWorkflow]: ok(running) });

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('still running');
    expect(result.text).toContain('depot_cancel_ci_run');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('refuses a workflow with nothing failed, pointing at the rerun tool', async () => {
    const h = await writable({ [RPC.getWorkflow]: ok(greenWorkflow()) });

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('no failed or cancelled jobs');
    expect(result.text).toContain('depot_rerun_ci_workflow');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it(`refuses when a failed job already has ${RETRY_ATTEMPT_CAP} attempts, unless force is set`, async () => {
    const h = await writable({
      [RPC.getWorkflow]: ok(workflowWithAttempts(RETRY_ATTEMPT_CAP)),
      [RPC.retryFailedJobs]: ok({}),
    });
    audit();

    const refused = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11', dryRun: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`already ran ${RETRY_ATTEMPT_CAP} or more times`);
    expect(refused.text).toContain('"test (18)" (3 attempts)');
    expect(refused.text).toContain('force:true');
    expect(mutatingCalls(h)).toEqual([]);

    const forced = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11', force: true, dryRun: false });
    expect(forced.isError, forced.text).toBe(false);
    expect(h.callsTo(RPC.retryFailedJobs)).toHaveLength(1);
  });

  it('allows a job just under the cap', async () => {
    const h = await writable({ [RPC.getWorkflow]: ok(workflowWithAttempts(RETRY_ATTEMPT_CAP - 1)) });

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11' });

    expect(result.structured.refusal).toBeUndefined();
  });

  it('translates a 412 from RetryFailedJobs (the running-workflow case Depot enforces itself)', async () => {
    const h = await writable({
      [RPC.getWorkflow]: ok(fixture('workflow')),
      [RPC.retryFailedJobs]: connectError(412, 'failed_precondition', 'workflow is running'),
    });
    audit();

    const result = await callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('failed_precondition, HTTP 412');
    expect(result.text).toContain('workflow is running');
    expect(result.text).toContain('still running cannot be retried or rerun');
  });
});

describe('depot_retry_ci_job', () => {
  it('previews the job and applies with RetryJob {jobId}', async () => {
    const h = await writable({ [RPC.getJob]: ok(fixture('job')), [RPC.retryJob]: ok({ attemptId: 'att_3', attempt: 3 }) });
    const spy = audit();

    const dry = await callTool(h, 'depot_retry_ci_job', { jobId: 'job_4d0a77' });
    expect(dry.isError).toBe(false);
    expect(dry.structured.preview).toMatchObject({ jobId: 'job_4d0a77', state: 'failure', attemptCount: 2, durationSeconds: 279 });
    expect(dry.text).toContain('would start attempt 3');
    expect(dry.structured.resend).toEqual({ jobId: 'job_4d0a77', force: false, dryRun: false });
    expect(mutatingCalls(h)).toEqual([]);

    const applied = await callTool(h, 'depot_retry_ci_job', { jobId: 'job_4d0a77', dryRun: false });

    expect(applied.isError, applied.text).toBe(false);
    expect(h.callsTo(RPC.retryJob)[0]?.body).toEqual({ jobId: 'job_4d0a77' });
    expect(applied.structured.after).toMatchObject({ rpc: 'RetryJob', ids: { attemptId: 'att_3' } });
    expect(auditLines(spy)[0]).toContain('depot_retry_ci_job jobId=job_4d0a77');
  });

  it('refuses a job that succeeded', async () => {
    const h = await writable({ [RPC.getJob]: ok(job({ jobStatus: 'finished', jobConclusion: 'success' })) });

    const result = await callTool(h, 'depot_retry_ci_job', { jobId: 'job_4d0a77', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('is success, not failed or cancelled');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('refuses a job that is still running and suggests cancelling it', async () => {
    const h = await writable({ [RPC.getJob]: ok(runningJob()) });

    const result = await callTool(h, 'depot_retry_ci_job', { jobId: 'job_4d0a77', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('still running');
    expect(result.text).toContain('depot_cancel_ci_job');
  });

  it('accepts a cancelled job', async () => {
    const h = await writable({ [RPC.getJob]: ok(job({ jobStatus: 'cancelled', jobConclusion: 'cancelled' })) });

    const result = await callTool(h, 'depot_retry_ci_job', { jobId: 'job_4d0a77' });

    expect(result.structured.refusal).toBeUndefined();
  });

  it(`applies the ${RETRY_ATTEMPT_CAP}-attempt cap unless forced`, async () => {
    const h = await writable({
      [RPC.getJob]: ok(job({ currentAttempt: RETRY_ATTEMPT_CAP })),
      [RPC.retryJob]: ok({}),
    });
    audit();

    const refused = await callTool(h, 'depot_retry_ci_job', { jobId: 'job_4d0a77', dryRun: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(`already ran ${RETRY_ATTEMPT_CAP} or more times`);
    expect(mutatingCalls(h)).toEqual([]);

    const forced = await callTool(h, 'depot_retry_ci_job', { jobId: 'job_4d0a77', force: true, dryRun: false });
    expect(forced.isError, forced.text).toBe(false);
    expect(h.callsTo(RPC.retryJob)).toHaveLength(1);
  });
});

describe('depot_rerun_ci_workflow', () => {
  it('refuses a full rerun while failed jobs exist, pointing at depot_retry_ci_failed_jobs', async () => {
    const h = await writable({ [RPC.getWorkflow]: ok(fixture('workflow')) });

    const dry = await callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11' });
    expect(dry.isError).toBe(false);
    expect(String(dry.structured.refusal)).toContain('depot_retry_ci_failed_jobs {"workflowId":"wf_2b8e11"}');
    expect(String(dry.structured.refusal)).toContain('allowFullRerun:true');

    const applied = await callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11', dryRun: false });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain('1 failed job(s) out of 3');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('previews the job count and previous wall time, and applies with RerunWorkflow {workflowId} when allowed', async () => {
    const h = await writable({
      [RPC.getWorkflow]: ok(fixture('workflow')),
      [RPC.rerunWorkflow]: ok({ workflowId: 'wf_2b8e11', executionId: 'exe_0002' }),
    });
    const spy = audit();

    const dry = await callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11', allowFullRerun: true });
    expect(dry.isError).toBe(false);
    expect(dry.structured.refusal).toBeUndefined();
    expect(dry.structured.preview).toMatchObject({ jobCount: 3, failedJobCount: 1, executionCount: 1, previousDurationSeconds: 446 });
    expect(dry.text).toContain('would start execution 2, running all 3 job(s) again; the previous execution took 7m26s');
    expect(dry.structured.resend).toEqual({ workflowId: 'wf_2b8e11', allowFullRerun: true, dryRun: false });

    const applied = await callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11', allowFullRerun: true, dryRun: false });

    expect(applied.isError, applied.text).toBe(false);
    expect(h.callsTo(RPC.rerunWorkflow)[0]?.body).toEqual({ workflowId: 'wf_2b8e11' });
    expect(applied.structured.after).toMatchObject({ rpc: 'RerunWorkflow', ids: { workflowId: 'wf_2b8e11', executionId: 'exe_0002' } });
    expect(auditLines(spy)[0]).toContain('depot_rerun_ci_workflow workflowId=wf_2b8e11');
  });

  it('needs no flag for a workflow with nothing failed', async () => {
    const h = await writable({ [RPC.getWorkflow]: ok(greenWorkflow()) });

    const result = await callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11' });

    expect(result.structured.refusal).toBeUndefined();
    expect(result.structured.resend).toEqual({ workflowId: 'wf_2b8e11', allowFullRerun: false, dryRun: false });
  });

  it('refuses a running workflow', async () => {
    const h = await writable({ [RPC.getWorkflow]: ok(workflow({ workflowStatus: 'running' })) });

    const result = await callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11', allowFullRerun: true, dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('still running');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('translates a 412 from RerunWorkflow', async () => {
    const h = await writable({
      [RPC.getWorkflow]: ok(greenWorkflow()),
      [RPC.rerunWorkflow]: connectError(412, 'failed_precondition', 'workflow has not finished'),
    });
    audit();

    const result = await callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Depot refused depot_rerun_ci_workflow');
    expect(result.text).toContain('workflow has not finished');
  });
});

describe('write tools and the token', () => {
  it('never echo the token in a preview, an applied result, or a refusal', async () => {
    const h = await writable({
      [RPC.getWorkflow]: ok(fixture('workflow')),
      [RPC.retryFailedJobs]: ok({}),
    });
    audit();

    const results = await Promise.all([
      callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11' }),
      callTool(h, 'depot_retry_ci_failed_jobs', { workflowId: 'wf_2b8e11', dryRun: false }),
      callTool(h, 'depot_rerun_ci_workflow', { workflowId: 'wf_2b8e11', dryRun: false }),
    ]);

    for (const result of results) {
      expect(result.text).not.toContain('test-token-never-logged');
      expect(JSON.stringify(result.structured)).not.toContain('test-token-never-logged');
    }
  });
});
