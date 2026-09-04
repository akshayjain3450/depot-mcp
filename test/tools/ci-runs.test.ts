import { afterEach, describe, expect, it } from 'vitest';
import { callTool, createHarness, fixture, ok, type Harness } from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

describe('depot_list_ci_runs', () => {
  it('normalises statuses and surfaces the ids needed to drill in', async () => {
    harness = await createHarness({ routes: { [RPC.listRuns]: ok(fixture('list-runs')) } });

    const result = await callTool(harness, 'depot_list_ci_runs', {});
    const runs = records(result.structured.runs);

    expect(result.structured.returned).toBe(3);
    expect(runs.map((run) => run.status)).toEqual(['failed', 'finished', 'running']);
    expect(runs[0]).toMatchObject({
      runId: 'run_7f3d9c21',
      repo: 'acme/api',
      trigger: 'push',
      durationSeconds: 448,
    });
    expect(runs[1]?.pr).toBe(412);
    expect(result.structured.nextPageToken).toBe('eyJvZmZzZXQiOjN9');
    expect(result.text).toContain('run_7f3d9c21');
    expect(result.text).toContain('depot_diagnose_ci_failure');
  });

  it('passes filters through to Depot verbatim', async () => {
    harness = await createHarness({ routes: { [RPC.listRuns]: ok(fixture('list-runs')) } });

    await callTool(harness, 'depot_list_ci_runs', {
      status: ['failed'],
      repo: 'acme/api',
      limit: 5,
    });

    expect(harness.callsTo(RPC.listRuns)[0]?.body).toEqual({
      status: ['failed'],
      repo: 'acme/api',
      pageSize: 5,
    });
  });

  it('explains an empty result instead of returning a bare empty list', async () => {
    harness = await createHarness({ routes: { [RPC.listRuns]: ok(fixture('list-runs-empty')) } });

    const result = await callTool(harness, 'depot_list_ci_runs', { status: ['failed'] });

    expect(result.isError).toBe(false);
    expect(result.structured.returned).toBe(0);
    expect(records(result.structured.runs)).toHaveLength(0);
    expect(result.text).toContain('No Depot CI runs matched');
    expect(result.text).toContain('DEPOT_ORG_ID');
  });

  it("refuses a pr filter without a repo, which Depot itself requires", async () => {
    harness = await createHarness({ routes: { [RPC.listRuns]: ok(fixture('list-runs')) } });

    const result = await callTool(harness, 'depot_list_ci_runs', { pr: 412 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('owner/name');
    expect(harness.callsTo(RPC.listRuns)).toHaveLength(0);
  });
});

describe('depot_get_ci_run', () => {
  it('returns the workflow, job and attempt tree with failure counts', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getRun]: ok(fixture('run')),
        [RPC.getRunStatus]: ok(fixture('run-status')),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_run', { runId: 'run_7f3d9c21' });
    const workflows = records(result.structured.workflows);
    const jobs = records(workflows[0]?.jobs);

    expect(result.structured.jobCount).toBe(3);
    expect(result.structured.failedJobCount).toBe(1);
    expect(workflows).toHaveLength(1);
    expect(workflows[0]).toMatchObject({ workflowId: 'wf_2b8e11', name: 'CI', status: 'failed' });
    expect(jobs.map((job) => job.conclusion)).toEqual(['success', 'failed', 'skipped']);
    expect(records(jobs[1]?.attempts)).toHaveLength(2);
    expect(result.text).toContain('attemptId=att_91bc02');
    expect(result.text).toContain('depot_diagnose_ci_failure');
  });

  it('drops passing jobs when failedOnly is set', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getRun]: ok(fixture('run')),
        [RPC.getRunStatus]: ok(fixture('run-status')),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_run', {
      runId: 'run_7f3d9c21',
      failedOnly: true,
    });
    const jobs = records(records(result.structured.workflows)[0]?.jobs);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobId).toBe('job_4d0a77');
    expect(result.structured.jobCount).toBe(3);
    expect(result.text).not.toContain('job_1c9f30');
  });
});
