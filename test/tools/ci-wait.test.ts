import { afterEach, describe, expect, it } from 'vitest';
import { parseRunTree } from '../../src/lib/ci-tree.js';
import { diffTrees } from '../../src/lib/ci-wait.js';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
  ok,
  type Harness,
  type StubReply,
} from '../helpers/harness.js';
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

function snapshot(runStatus: string, jobs: Array<{ key: string; status: string }>): StubReply {
  return ok({
    runId: 'run_live',
    status: runStatus,
    workflows: [
      {
        workflowId: 'wf_1',
        name: 'CI',
        status: runStatus,
        jobs: jobs.map((job, index) => ({
          jobId: `job_${index}`,
          jobKey: job.key,
          status: job.status,
          attempts: [{ attemptId: `att_${index}`, attempt: 1, status: job.status }],
        })),
      },
    ],
  });
}

const RUNNING = snapshot('RUN_STATUS_RUNNING', [
  { key: 'lint', status: 'JOB_STATUS_RUNNING' },
  { key: 'test', status: 'JOB_STATUS_QUEUED' },
]);
const HALFWAY = snapshot('RUN_STATUS_RUNNING', [
  { key: 'lint', status: 'JOB_STATUS_FINISHED' },
  { key: 'test', status: 'JOB_STATUS_RUNNING' },
]);
const FAILED = snapshot('RUN_STATUS_FAILED', [
  { key: 'lint', status: 'JOB_STATUS_FINISHED' },
  { key: 'test', status: 'JOB_STATUS_FAILED' },
]);

describe('depot_wait_for_ci_run', () => {
  it('returns after one poll, without sleeping, when the run is already terminal', async () => {
    harness = await createHarness({ routes: { [RPC.getRunStatus]: ok(fixture('run-status')) } });

    const result = await callTool(harness, 'depot_wait_for_ci_run', {
      runId: 'run_7f3d9c21',
      timeoutSeconds: 5,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(1);
    expect(harness.callsTo(RPC.getRunStatus)[0]?.body).toEqual({ runId: 'run_7f3d9c21' });
    expect(harness.sleeps).toEqual([]);
    expect(result.structured).toMatchObject({
      runId: 'run_7f3d9c21',
      outcome: 'run_terminal',
      timedOut: false,
      status: 'failed',
      initialStatus: 'failed',
      failed: true,
      jobCount: 3,
      failedJobCount: 1,
      polls: 1,
      elapsedSeconds: 0,
      timeoutSeconds: 5,
      pollSeconds: 5,
      changes: [],
    });
    expect(result.text).toContain('Run run_7f3d9c21 failed after 0s and 1 poll');
    expect(result.text).toContain('nothing changed while waiting');
    expect(result.text).toContain('depot_diagnose_ci_failure {"id":"run_7f3d9c21"}');
  });

  it('polls at pollSeconds until the run ends and reports every node that changed', async () => {
    harness = await createHarness({
      routes: { [RPC.getRunStatus]: [RUNNING, HALFWAY, FAILED] },
    });

    const result = await callTool(harness, 'depot_wait_for_ci_run', {
      runId: 'run_live',
      timeoutSeconds: 60,
      pollSeconds: 4,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(3);
    expect(harness.sleeps).toEqual([4_000, 4_000]);
    expect(result.structured).toMatchObject({
      outcome: 'run_terminal',
      timedOut: false,
      status: 'failed',
      initialStatus: 'running',
      polls: 3,
      elapsedSeconds: 8,
    });
    const changes = records(result.structured.changes);
    expect(changes).toEqual([
      { kind: 'run', id: 'run_live', from: 'running', to: 'failed' },
      { kind: 'workflow', id: 'wf_1', name: 'CI', from: 'running', to: 'failed' },
      { kind: 'job', id: 'job_0', name: 'lint', from: 'running', to: 'finished' },
      { kind: 'attempt', id: 'att_0', name: 'lint attempt 1', from: 'running', to: 'finished' },
      { kind: 'job', id: 'job_1', name: 'test', from: 'queued', to: 'failed' },
      { kind: 'attempt', id: 'att_1', name: 'test attempt 1', from: 'queued', to: 'failed' },
    ]);
    expect(result.text).toContain('after 8s and 3 polls');
    expect(result.text).toContain('6 nodes changed state while waiting:');
    expect(result.text).toContain('job test (job_1): queued -> failed');
  });

  it('stops at the timeout with the run still running, never sleeping past the deadline', async () => {
    harness = await createHarness({ routes: { [RPC.getRunStatus]: RUNNING } });

    const result = await callTool(harness, 'depot_wait_for_ci_run', {
      runId: 'run_live',
      timeoutSeconds: 10,
      pollSeconds: 3,
    });

    expect(result.isError, result.text).toBe(false);
    // Polls at 0, 3, 6, 9 and 10 seconds: the last sleep is cut to the time remaining.
    expect(harness.sleeps).toEqual([3_000, 3_000, 3_000, 1_000]);
    expect(harness.sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(10_000);
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(5);
    expect(result.structured).toMatchObject({
      outcome: 'timed_out',
      timedOut: true,
      status: 'running',
      failed: false,
      polls: 5,
      elapsedSeconds: 10,
      changes: [],
    });
    expect(result.text).toContain('Timed out after 10s and 5 polls: run run_live is still running');
    expect(result.text).toContain('The run has not finished');
    expect(result.text).toContain('Call depot_wait_for_ci_run again with runId="run_live"');
    expect(result.text).not.toContain('depot_diagnose_ci_failure');
  });

  it('returns as soon as the job named by untilJobKey is terminal, while the run continues', async () => {
    harness = await createHarness({
      routes: { [RPC.getRunStatus]: [RUNNING, HALFWAY, FAILED] },
    });

    const result = await callTool(harness, 'depot_wait_for_ci_run', {
      runId: 'run_live',
      untilJobKey: 'lint',
      timeoutSeconds: 60,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(2);
    expect(result.structured).toMatchObject({
      outcome: 'job_terminal',
      timedOut: false,
      status: 'running',
      polls: 2,
      job: { jobId: 'job_0', key: 'lint', status: 'finished', terminal: true },
    });
    expect(result.text).toContain('Job "lint" reached finished after 5s and 2 polls');
    expect(result.text).toContain('run run_live is running overall');
  });

  it('matches untilJobKey against the job id as well as the key', async () => {
    harness = await createHarness({ routes: { [RPC.getRunStatus]: [HALFWAY, FAILED] } });

    const result = await callTool(harness, 'depot_wait_for_ci_run', {
      runId: 'run_live',
      untilJobKey: 'job_0',
    });

    expect(result.structured.outcome).toBe('job_terminal');
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(1);
  });

  it('waits for the whole run and says so when untilJobKey matches nothing', async () => {
    harness = await createHarness({ routes: { [RPC.getRunStatus]: [RUNNING, FAILED] } });

    const result = await callTool(harness, 'depot_wait_for_ci_run', {
      runId: 'run_live',
      untilJobKey: 'deploy',
    });

    expect(result.structured.outcome).toBe('run_terminal');
    expect(result.structured.job).toBeUndefined();
    expect(result.structured.notes).toEqual([expect.stringContaining('No job matching "deploy"')]);
    expect(result.text).toContain('depot_get_ci_run lists the job keys');
  });

  it('reads a snake_case status document the same as camelCase', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getRunStatus]: ok({
          run_id: 'run_snake',
          status: 'RUN_STATUS_FINISHED',
          workflows: [
            {
              workflow_id: 'wf_s',
              name: 'CI',
              status: 'WORKFLOW_STATUS_FINISHED',
              jobs: [{ job_id: 'job_s', job_key: 'build', status: 'JOB_STATUS_FINISHED', attempts: [] }],
            },
          ],
        }),
      },
    });

    const result = await callTool(harness, 'depot_wait_for_ci_run', {
      runId: 'run_snake',
      untilJobKey: 'build',
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({
      runId: 'run_snake',
      outcome: 'run_terminal',
      status: 'finished',
      failed: false,
      jobCount: 1,
      failedJobCount: 0,
      job: { jobId: 'job_s', key: 'build', status: 'finished', terminal: true },
    });
    expect(result.text).not.toContain('depot_diagnose_ci_failure');
  });

  it('translates not_found from the first poll into a tool error without retrying', async () => {
    harness = await createHarness({
      routes: { [RPC.getRunStatus]: connectError(404, 'not_found', 'run not found') },
    });

    const result = await callTool(harness, 'depot_wait_for_ci_run', { runId: 'run_missing' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(1);
    expect(harness.sleeps).toEqual([]);
  });

  it('rejects timeouts and poll intervals outside the documented bounds before calling Depot', async () => {
    harness = await createHarness({ routes: { [RPC.getRunStatus]: RUNNING } });

    for (const args of [
      { runId: 'run_live', timeoutSeconds: 1 },
      { runId: 'run_live', timeoutSeconds: 301 },
      { runId: 'run_live', pollSeconds: 1 },
      { runId: 'run_live', pollSeconds: 31 },
      { runId: '   ' },
    ]) {
      const result = await callTool(harness, 'depot_wait_for_ci_run', args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('advertises bounded polling rather than streaming in its description', async () => {
    harness = await createHarness({ routes: {} });
    const { tools } = await harness.client.listTools();
    const tool = tools.find((entry) => entry.name === 'depot_wait_for_ci_run');

    expect(tool?.description).toMatch(/bounded polling, not a stream/);
    expect(tool?.description).toContain('call this tool again');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    const properties = asRecord(tool?.inputSchema.properties);
    expect(Object.keys(properties).sort()).toEqual(['pollSeconds', 'runId', 'timeoutSeconds', 'untilJobKey']);
  });
});

describe('diffTrees', () => {
  it('reports nodes that appear or disappear between snapshots with an absent side', () => {
    const first = parseRunTree({
      runId: 'r',
      status: 'STATUS_RUNNING',
      workflows: [{ workflowId: 'w', status: 'STATUS_RUNNING', jobs: [{ jobId: 'old', status: 'STATUS_RUNNING' }] }],
    });
    const last = parseRunTree({
      runId: 'r',
      status: 'STATUS_RUNNING',
      workflows: [{ workflowId: 'w', status: 'STATUS_RUNNING', jobs: [{ jobId: 'new', status: 'STATUS_QUEUED' }] }],
    });

    expect(diffTrees(first, last)).toEqual([
      { kind: 'job', id: 'new', name: undefined, from: undefined, to: 'queued' },
      { kind: 'job', id: 'old', name: undefined, from: 'running', to: undefined },
    ]);
  });
});
