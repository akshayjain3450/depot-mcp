import { afterEach, describe, expect, it } from 'vitest';
import { callTool, createHarness, fixture, ok, type Harness } from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function lines(structured: Record<string, unknown>): Array<Record<string, unknown>> {
  const value = structured.lines;
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

const bothPages = {
  [RPC.getJobAttemptLogs]: [ok(fixture('logs-page1')), ok(fixture('logs-page2'))],
};

describe('depot_get_ci_logs', () => {
  it('pages to the end of the log and returns every line by default', async () => {
    harness = await createHarness({ routes: bothPages });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02' });

    expect(result.isError).toBe(false);
    expect(lines(result.structured)).toHaveLength(7);
    expect(result.structured.pagesFetched).toBe(2);
    expect(result.structured.nextPageToken).toBeUndefined();
    expect(harness.callsTo(RPC.getJobAttemptLogs)[0]?.body).toEqual({ attemptId: 'att_91bc02' });
    expect(harness.callsTo(RPC.getJobAttemptLogs)[1]?.body.pageToken).toBe('cursor-page-2');
  });

  it('keeps the tail, not the head, when the log is longer than tailLines', async () => {
    harness = await createHarness({ routes: bothPages });

    const result = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      tailLines: 2,
    });

    expect(lines(result.structured).map((line) => line.lineNumber)).toEqual([6, 7]);
    expect(result.structured.linesMatched).toBe(7);
    expect(result.structured.truncated).toBe(true);
    expect(result.text).toContain('Tests  1 failed | 128 passed');
  });

  it('filters server-side with grep so the whole log need not be returned', async () => {
    harness = await createHarness({ routes: bothPages });

    const result = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      grep: 'assertionerror',
    });

    const returned = lines(result.structured);
    expect(returned).toHaveLength(1);
    expect(returned[0]?.lineNumber).toBe(5);
    expect(result.structured.pagesFetched).toBe(2);
  });

  it('filters by stream and by step', async () => {
    harness = await createHarness({ routes: bothPages });

    const stderr = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      stream: 'stderr',
    });
    expect(lines(stderr.structured).map((line) => line.lineNumber)).toEqual([5, 6]);

    await harness.close();
    harness = await createHarness({ routes: bothPages });
    const step = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      stepKey: 'install',
    });
    expect(lines(step.structured).map((line) => line.lineNumber)).toEqual([2]);
  });

  it('decodes int64 timestamps and only renders them when asked', async () => {
    harness = await createHarness({ routes: bothPages });

    const withTimestamps = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      tailLines: 1,
      includeTimestamps: true,
    });

    expect(lines(withTimestamps.structured)[0]?.timestamp).toBe('2026-09-03T14:02:42.000Z');
    expect(withTimestamps.text).toContain('2026-09-03T14:02:42.000Z');

    await harness.close();
    harness = await createHarness({ routes: bothPages });
    const without = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      tailLines: 1,
    });
    expect(without.text).not.toContain('2026-09-03T14:02:42.000Z');
  });

  it('resolves a run id down to the failed job\'s latest attempt', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getRunStatus]: ok(fixture('run-status')),
        ...bothPages,
      },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'run_7f3d9c21' });

    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(1);
    expect(harness.callsTo(RPC.getJobAttemptLogs)[0]?.body).toEqual({ attemptId: 'att_91bc02' });
    expect(result.structured.target).toMatchObject({ attemptId: 'att_91bc02' });
    expect(result.text).toContain('test (node 18)');
  });

  it('stops at the page cap and says so rather than reading a whole huge log', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: ok(fixture('logs-page1')) },
      config: { maxLogPages: 1 },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02' });

    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(1);
    expect(result.structured.nextPageToken).toBe('cursor-page-2');
    expect(JSON.stringify(result.structured.notes)).toContain('DEPOT_MCP_MAX_LOG_PAGES');
  });

  it('pages forward from a supplied token instead of returning the tail', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: ok(fixture('logs-page2')) },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      pageToken: 'cursor-page-2',
    });

    expect(harness.callsTo(RPC.getJobAttemptLogs)[0]?.body.pageToken).toBe('cursor-page-2');
    expect(lines(result.structured).map((line) => line.lineNumber)).toEqual([4, 5, 6, 7]);
  });

  it('respects the character budget and reports what it dropped', async () => {
    harness = await createHarness({ routes: bothPages, config: { outputCharBudget: 700 } });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02' });

    expect(result.text.length).toBeLessThanOrEqual(700);
    expect(lines(result.structured).length).toBeLessThan(7);
    expect(JSON.stringify(result.structured.notes)).toContain('character budget');
  });

  it('tells the caller to resolve a workflow id to a job first', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'wf_2b8e11' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('stored per job attempt');
    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(0);
  });
});
