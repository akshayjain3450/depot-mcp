import { afterEach, describe, expect, it } from 'vitest';
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

describe('depot_list_ci_workflows', () => {
  it('sends no status filter when the caller gives none, because ListWorkflows answers without one', async () => {
    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
    });

    await callTool(harness, 'depot_list_ci_workflows', {});

    expect(harness.callsTo(RPC.listWorkflows)[0]?.body).toEqual({ pageSize: 20 });
  });

  it('passes filters through to Depot verbatim, with limit as pageSize', async () => {
    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
    });

    await callTool(harness, 'depot_list_ci_workflows', {
      name: 'CI',
      repo: 'acme/api',
      status: ['failed', 'running'],
      trigger: 'push',
      sha: '9c1f4ab7',
      pr: 412,
      limit: 5,
      pageToken: 'page-2',
    });

    expect(harness.callsTo(RPC.listWorkflows)[0]?.body).toEqual({
      name: 'CI',
      repo: 'acme/api',
      status: ['failed', 'running'],
      trigger: 'push',
      sha: '9c1f4ab7',
      pr: 412,
      pageSize: 5,
      pageToken: 'page-2',
    });
  });

  it('normalises statuses and returns job counts, run ids and the next page token', async () => {
    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
    });

    const result = await callTool(harness, 'depot_list_ci_workflows', {});
    const workflows = records(result.structured.workflows);

    expect(result.isError).toBe(false);
    expect(result.structured.returned).toBe(3);
    expect(workflows.map((workflow) => workflow.status)).toEqual(['failed', 'finished', 'running']);
    expect(workflows[0]).toMatchObject({
      workflowId: 'wf_2b8e11',
      name: 'CI',
      repo: 'acme/api',
      trigger: 'push',
      runId: 'run_7f3d9c21',
      sha: '9c1f4ab7d2e5f60318b4c7a9e0d1f2a3b4c5d6e7',
      headSha: '9c1f4ab7d2e5f60318b4c7a9e0d1f2a3b4c5d6e7',
      createdAt: '2026-09-03T14:02:12Z',
      jobCounts: { total: 3, failed: 1 },
    });
    expect(workflows[2]?.jobCounts).toEqual({ total: 2 });
    expect(result.structured.nextPageToken).toBe('eyJvZmZzZXQiOjN9');
  });

  it('lists workflows newest first with counts and a diagnose hint on the failed one', async () => {
    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
    });

    const result = await callTool(harness, 'depot_list_ci_workflows', {});
    const lines = result.text.split('\n');

    expect(lines[0]).toBe('3 Depot CI workflow(s), newest first:');
    expect(lines[1]).toBe(
      '  wf_2b8e11 — "CI" · failed · acme/api · 9c1f4ab7 · via push · 3 job(s), 1 failed · run run_7f3d9c21 · 2026-09-03T14:02:12Z',
    );
    expect(lines[3]).toContain('"Deploy" · running · acme/api · 0f0e0d0c · via workflow_dispatch · 2 job(s) · run run_5d1b7a09');
    expect(result.text).toContain('re-call with pageToken="eyJvZmZzZXQiOjN9"');
    expect(result.text).toContain(
      'depot_diagnose_ci_failure {"id":"wf_2b8e11","targetType":"workflow"}',
    );
    expect(result.text).toContain('depot_get_ci_workflow {"workflowId":"wf_2b8e11"}');
  });

  it('reads the CLI snake_case, prefixed-enum spelling identically', async () => {
    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
    });
    const camel = await callTool(harness, 'depot_list_ci_workflows', {});
    await harness.close();

    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok(cliVariant(fixture('workflows-list'))) },
    });
    const snake = await callTool(harness, 'depot_list_ci_workflows', {});

    expect(snake.structured).toEqual(camel.structured);
    expect(snake.text).toBe(camel.text);
  });

  it('explains an empty result instead of returning a bare empty list', async () => {
    harness = await createHarness({ routes: { [RPC.listWorkflows]: ok({}) } });

    const result = await callTool(harness, 'depot_list_ci_workflows', { status: ['failed'] });

    expect(result.isError).toBe(false);
    expect(result.structured.returned).toBe(0);
    expect(records(result.structured.workflows)).toHaveLength(0);
    expect(result.text).toContain('No Depot CI workflows matched');
    expect(result.text).toContain('DEPOT_ORG_ID');
    expect(result.text).not.toContain('depot_diagnose_ci_failure');
  });

  it('tolerates entries with missing fields', async () => {
    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok({ workflows: [{}, { workflowId: 'wf_bare' }] }) },
    });

    const result = await callTool(harness, 'depot_list_ci_workflows', {});
    const workflows = records(result.structured.workflows);

    expect(result.isError).toBe(false);
    expect(workflows).toHaveLength(2);
    expect(workflows[0]).toEqual({ jobCounts: {} });
    expect(result.text).toContain('  unknown id — unnamed · unknown status');
    expect(result.text).toContain('  wf_bare — unnamed · unknown status');
  });

  it('refuses a pr filter without a repo, which Depot itself requires', async () => {
    harness = await createHarness({
      routes: { [RPC.listWorkflows]: ok(fixture('workflows-list')) },
    });

    const result = await callTool(harness, 'depot_list_ci_workflows', { pr: 412 });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('owner/name');
    expect(harness.callsTo(RPC.listWorkflows)).toHaveLength(0);
  });

  it('rejects an unknown status value before any request is made', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_list_ci_workflows', { status: ['exploded'] });

    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('translates not_found into an error with guidance', async () => {
    harness = await createHarness({ routes: { [RPC.listWorkflows]: NOT_FOUND } });

    const result = await callTool(harness, 'depot_list_ci_workflows', { repo: 'acme/gone' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('Depot has no such record');
  });
});

describe('depot_get_ci_workflow', () => {
  it('sends the workflow id and returns context, executions and the job tree', async () => {
    harness = await createHarness({ routes: { [RPC.getWorkflow]: ok(fixture('workflow')) } });

    const result = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_2b8e11' });
    const executions = records(result.structured.executions);
    const jobs = records(result.structured.jobs);

    expect(harness.callsTo(RPC.getWorkflow)[0]?.body).toEqual({ workflowId: 'wf_2b8e11' });
    expect(result.isError).toBe(false);
    expect(asRecord(result.structured.run)).toMatchObject({
      runId: 'run_7f3d9c21',
      repo: 'acme/api',
      status: 'failed',
      durationSeconds: 448,
    });
    expect(asRecord(result.structured.workflow)).toMatchObject({
      workflowId: 'wf_2b8e11',
      name: 'CI',
      status: 'failed',
      startedAt: '2026-09-03T14:02:13Z',
      finishedAt: '2026-09-03T14:09:45Z',
      durationSeconds: 452,
    });
    expect(result.structured.executionCount).toBe(1);
    expect(executions[0]).toEqual({
      executionId: 'exec_1a7c3e',
      execution: 1,
      status: 'failed',
      createdAt: '2026-09-03T14:02:12Z',
      startedAt: '2026-09-03T14:02:13Z',
      finishedAt: '2026-09-03T14:09:45Z',
      durationSeconds: 452,
    });
    expect(result.structured.jobCount).toBe(3);
    expect(result.structured.failedJobCount).toBe(1);
    expect(jobs.map((job) => job.jobKey)).toEqual(['lint', 'test (18)', 'deploy']);
    expect(jobs[1]).toMatchObject({ jobId: 'job_4d0a77', status: 'failed', durationSeconds: 440 });
    const attempts = records(jobs[1]?.attempts);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual({
      attemptId: 'att_91bc02',
      attempt: 2,
      status: 'failed',
      sandboxId: 'sbx_6b9d2e04f7',
      startedAt: '2026-09-03T14:05:41Z',
      finishedAt: '2026-09-03T14:09:40Z',
      durationSeconds: 239,
    });
    expect(records(jobs[2]?.attempts)).toHaveLength(0);
  });

  it('renders the header, the execution history, the job tree and a diagnose hint', async () => {
    harness = await createHarness({ routes: { [RPC.getWorkflow]: ok(fixture('workflow')) } });

    const result = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_2b8e11' });
    const lines = result.text.split('\n');

    expect(lines[0]).toBe(
      'Workflow "CI" (workflowId=wf_2b8e11) — failed, 7m32s (execution 1 of 1), 3 job(s), 1 failed.',
    );
    expect(lines[1]).toBe('Run run_7f3d9c21 — failed · acme/api@9c1f4ab7 · refs/heads/main · via push · 7m28s.');
    expect(lines[2]).toBe('Executions: #1 failed, 7m32s, executionId=exec_1a7c3e');
    expect(result.text).toContain('  "lint" — finished, 1m2s (jobId=job_1c9f30)');
    expect(result.text).toContain('    attempt 1 — finished, 1m2s (attemptId=att_11aa01, sandboxId=sbx_9e1f2a3b4c)');
    expect(result.text).toContain('  "test (18)" — failed, 7m20s (jobId=job_4d0a77)');
    expect(result.text).toContain('    attempt 2 — failed, 3m59s (attemptId=att_91bc02, sandboxId=sbx_6b9d2e04f7)');
    expect(result.text).toContain('  "deploy" — skipped (jobId=job_7e5b21)');
    expect(result.text).toContain(
      'depot_diagnose_ci_failure {"id":"wf_2b8e11","targetType":"workflow"}',
    );
  });

  it('shows rerun lineage when the workflow has several executions', async () => {
    const doc = fixture('workflow');
    const first = asRecord(records(doc.executions)[0]);
    harness = await createHarness({
      routes: {
        [RPC.getWorkflow]: ok({
          ...doc,
          executions: [
            first,
            {
              executionId: 'exec_2b8d4f',
              execution: 2,
              status: 'failed',
              startedAt: '2026-09-03T15:00:00Z',
              finishedAt: '2026-09-03T15:06:00Z',
            },
          ],
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_2b8e11' });

    expect(result.structured.executionCount).toBe(2);
    expect(result.text).toContain(
      'Executions (2, oldest first): #1 failed, 7m32s, executionId=exec_1a7c3e; #2 failed, 6m, executionId=exec_2b8d4f',
    );
  });

  it('after a rerun, reports the latest execution as the duration rather than first start to last finish', async () => {
    harness = await createHarness({ routes: { [RPC.getWorkflow]: ok(fixture('workflow-rerun')) } });

    const result = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_2b8e11' });
    const lines = result.text.split('\n');

    expect(result.isError, result.text).toBe(false);
    // Depot's top-level workflow timing spans 2026-09-03T14:02:13Z to 2026-09-04T14:00:20Z.
    expect(lines[0]).toBe(
      'Workflow "CI" (workflowId=wf_2b8e11) — finished, 2m15s (execution 2 of 2), 2 job(s), 0 failed.',
    );
    expect(lines[0]).not.toContain('23h');
    expect(asRecord(result.structured.workflow)).toMatchObject({
      status: 'finished',
      startedAt: '2026-09-04T13:58:05Z',
      finishedAt: '2026-09-04T14:00:20Z',
      durationSeconds: 135,
    });
    expect(asRecord(result.structured.latestExecution)).toMatchObject({
      executionId: 'exec_2b8d4f',
      execution: 2,
      status: 'finished',
      durationSeconds: 135,
    });
    expect(result.structured.executionCount).toBe(2);
    expect(records(result.structured.executions).map((execution) => execution.durationSeconds)).toEqual([452, 135]);
    expect(result.text).not.toContain('depot_diagnose_ci_failure');
  });

  it('picks the highest execution number as latest even when Depot lists them out of order', async () => {
    const doc = fixture('workflow-rerun');
    const executions = records(doc.executions);
    harness = await createHarness({
      routes: { [RPC.getWorkflow]: ok({ ...doc, executions: [executions[1], executions[0]] }) },
    });

    const result = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_2b8e11' });

    expect(asRecord(result.structured.latestExecution).execution).toBe(2);
    expect(asRecord(result.structured.workflow).durationSeconds).toBe(135);
    expect(result.text).toContain('2m15s (execution 2 of 2)');
  });

  it('reads the CLI snake_case, prefixed-enum spelling identically', async () => {
    harness = await createHarness({ routes: { [RPC.getWorkflow]: ok(fixture('workflow')) } });
    const camel = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_2b8e11' });
    await harness.close();

    harness = await createHarness({
      routes: { [RPC.getWorkflow]: ok(cliVariant(fixture('workflow'))) },
    });
    const snake = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_2b8e11' });

    expect(snake.structured).toEqual(camel.structured);
    expect(snake.text).toBe(camel.text);
  });

  it('tolerates an empty document without throwing', async () => {
    harness = await createHarness({ routes: { [RPC.getWorkflow]: ok({}) } });

    const result = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_missing' });

    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({
      executionCount: 0,
      jobCount: 0,
      failedJobCount: 0,
    });
    expect(result.text).toContain('Workflow unnamed (workflowId=wf_missing) — unknown status, 0 job(s), 0 failed.');
    expect(result.text).toContain('No jobs recorded for this workflow yet.');
    expect(result.text).not.toContain('depot_diagnose_ci_failure');
  });

  it('translates not_found into an error with guidance', async () => {
    harness = await createHarness({ routes: { [RPC.getWorkflow]: NOT_FOUND } });

    const result = await callTool(harness, 'depot_get_ci_workflow', { workflowId: 'wf_nope' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('Depot has no such record');
  });
});
