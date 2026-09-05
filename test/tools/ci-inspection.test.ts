import { afterEach, describe, expect, it } from 'vitest';
import {
  UNTRUSTED_CI_CONTENT_WARNING,
  UNTRUSTED_CONTENT_BEGIN,
  UNTRUSTED_CONTENT_END,
} from '../../src/lib/ci-target.js';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
  NOT_FOUND,
  ok,
  type Harness,
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

describe('depot_get_ci_job_summary', () => {
  it('returns the authored markdown', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobSummary]: ok(fixture('job-summary')) },
    });

    const result = await callTool(harness, 'depot_get_ci_job_summary', { id: 'job_4d0a77' });

    expect(result.structured.empty).toBe(false);
    expect(String(result.structured.markdown)).toContain('## Test results');
    expect(result.text).toContain('| unit | 128 | 1 |');
    expect(harness.callsTo(RPC.getJobSummary)[0]?.body).toEqual({ jobId: 'job_4d0a77' });
  });

  it('fences the job-authored markdown as untrusted content', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobSummary]: ok(fixture('job-summary')) },
    });

    const result = await callTool(harness, 'depot_get_ci_job_summary', { id: 'job_4d0a77' });

    expect(result.structured.contentWarning).toBe(UNTRUSTED_CI_CONTENT_WARNING);
    const begin = result.text.indexOf(UNTRUSTED_CONTENT_BEGIN);
    const end = result.text.indexOf(UNTRUSTED_CONTENT_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(result.text.slice(begin, end)).toContain('## Test results');
  });

  it('quotes and caps the job display name when resolving a run id', async () => {
    const longName = 'x'.repeat(500);
    const runStatus = fixture('run-status');
    const tree = JSON.parse(JSON.stringify(runStatus).replace('test (node 18)', longName)) as unknown;
    harness = await createHarness({
      routes: {
        [RPC.getRunStatus]: ok(tree),
        [RPC.getJobSummary]: ok(fixture('job-summary')),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_job_summary', { id: 'run_7f3d9c21' });
    const describedAs = String(asRecord(result.structured.target).describedAs);

    expect(describedAs).toMatch(/^latest attempt of "x+…" in run run_7f3d9c21$/);
    expect(describedAs.length).toBeLessThan(200);
    expect(harness.callsTo(RPC.getJobSummary)[0]?.body).toEqual({ attemptId: 'att_91bc02' });
  });

  it('falls through on invalid_argument as well as not_found for an ambiguous id', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getJobSummary]: [
          connectError(400, 'invalid_argument', 'not an attempt id'),
          ok(fixture('job-summary')),
        ],
      },
    });

    const result = await callTool(harness, 'depot_get_ci_job_summary', { id: '01JQABC' });

    expect(result.isError).toBe(false);
    expect(harness.callsTo(RPC.getJobSummary).map((call) => call.body)).toEqual([
      { attemptId: '01JQABC' },
      { jobId: '01JQABC' },
    ]);
  });

  it('treats a job with no summary as a normal empty result, not an error', async () => {
    harness = await createHarness({ routes: { [RPC.getJobSummary]: ok({}) } });

    const result = await callTool(harness, 'depot_get_ci_job_summary', { id: 'att_91bc02' });

    expect(result.isError).toBe(false);
    expect(result.structured.empty).toBe(true);
    expect(result.text).toContain('Most jobs do not write one');
    expect(result.text).toContain('depot_diagnose_ci_failure');
  });

  it('resolves an ambiguous id by trying attempt then job', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobSummary]: [NOT_FOUND, ok(fixture('job-summary'))] },
    });

    const result = await callTool(harness, 'depot_get_ci_job_summary', { id: '01JQABC' });

    const bodies = harness.callsTo(RPC.getJobSummary).map((call) => call.body);
    expect(bodies).toEqual([{ attemptId: '01JQABC' }, { jobId: '01JQABC' }]);
    expect(result.structured.empty).toBe(false);
  });

  it('truncates a very long summary within the budget', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobSummary]: ok({ markdown: 'x'.repeat(5_000) }) },
      config: { outputCharBudget: 1_000 },
    });

    const result = await callTool(harness, 'depot_get_ci_job_summary', { id: 'job_4d0a77' });

    expect(result.structured.truncated).toBe(true);
    expect(result.structured.originalLength).toBe(5_000);
    expect(String(result.structured.markdown).length).toBeLessThanOrEqual(800);
  });
});

describe('depot_get_ci_metrics', () => {
  it('recognises memory fields and flags a likely OOM', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptMetrics]: ok(fixture('metrics-attempt')) },
    });

    const result = await callTool(harness, 'depot_get_ci_metrics', { id: 'att_91bc02' });

    expect(result.structured.level).toBe('attempt');
    expect(asRecord(result.structured.metrics)).toMatchObject({
      peakMemoryBytes: 8_577_351_680,
      memoryLimitBytes: 8_589_934_592,
      peakCpuPercent: 99.1,
    });
    expect(result.structured.likelyOom).toBe(true);
    expect(result.text).toContain('out-of-memory kill is likely');
  });

  it('passes the raw document through, bounded, because Depot publishes no schema', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptMetrics]: ok(fixture('metrics-attempt')) },
    });

    const result = await callTool(harness, 'depot_get_ci_metrics', { id: 'att_91bc02' });

    expect(String(result.structured.rawJson)).toContain('samples');
    expect(result.structured.rawTruncated).toBe(false);
  });

  it('honours an explicit level', async () => {
    harness = await createHarness({
      routes: { 'depot.ci.v1.CIService/GetRunMetrics': ok({ runId: 'run_7f3d9c21' }) },
    });

    const result = await callTool(harness, 'depot_get_ci_metrics', {
      id: 'run_7f3d9c21',
      level: 'run',
    });

    expect(result.structured.level).toBe('run');
    expect(result.structured.likelyOom).toBeUndefined();
  });

  it('tries the next level on not_found or invalid_argument, but not on other errors', async () => {
    harness = await createHarness({
      routes: {
        'depot.ci.v1.CIService/GetRunMetrics': connectError(400, 'invalid_argument', 'not a run'),
        'depot.ci.v1.CIService/GetJobMetrics': NOT_FOUND,
        [RPC.getJobAttemptMetrics]: ok(fixture('metrics-attempt')),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_metrics', { id: '01JQ9Z8ABCDEF' });

    expect(result.isError).toBe(false);
    expect(result.structured.level).toBe('attempt');

    const denied = await createHarness({
      routes: {
        'depot.ci.v1.CIService/GetRunMetrics': connectError(403, 'permission_denied', 'no'),
      },
    });
    try {
      const failure = await callTool(denied, 'depot_get_ci_metrics', { id: '01JQ9Z8ABCDEF' });
      expect(failure.isError).toBe(true);
      expect(denied.callsTo('depot.ci.v1.CIService/GetJobMetrics')).toHaveLength(0);
    } finally {
      await denied.close();
    }
  });
});

describe('depot_list_ci_artifacts', () => {
  it('lists artifacts with sizes', async () => {
    harness = await createHarness({ routes: { [RPC.listArtifacts]: ok(fixture('artifacts')) } });

    const result = await callTool(harness, 'depot_list_ci_artifacts', { runId: 'run_7f3d9c21' });
    const artifacts = records(result.structured.artifacts);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]).toMatchObject({ name: 'junit-results.xml', sizeBytes: 184_216 });
    expect(result.text).toContain('179.9 KiB');
    expect(records(result.structured.artifacts)[0]?.downloadUrl).toBeUndefined();
  });

  it('mints signed URLs only when asked', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listArtifacts]: ok(fixture('artifacts')),
        [RPC.getArtifactDownloadUrl]: ok({ downloadUrl: 'https://signed.example/artifact' }),
      },
    });

    const result = await callTool(harness, 'depot_list_ci_artifacts', {
      runId: 'run_7f3d9c21',
      withDownloadUrl: true,
    });

    expect(harness.callsTo(RPC.getArtifactDownloadUrl)).toHaveLength(2);
    expect(records(result.structured.artifacts)[0]?.downloadUrl).toBe(
      'https://signed.example/artifact',
    );
  });

  it('requires at least one identifier', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_list_ci_artifacts', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('depot_list_ci_runs');
    expect(harness.callsTo(RPC.listArtifacts)).toHaveLength(0);
  });

  it('explains an empty artifact list', async () => {
    harness = await createHarness({ routes: { [RPC.listArtifacts]: ok({}) } });

    const result = await callTool(harness, 'depot_list_ci_artifacts', { runId: 'run_7f3d9c21' });

    expect(result.structured.returned).toBe(0);
    expect(result.text).toContain('explicitly uploads');
  });

  it('forwards pageToken and points at it when more pages exist', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listArtifacts]: ok({ ...fixture('artifacts'), nextPageToken: 'page-2' }),
      },
    });

    const result = await callTool(harness, 'depot_list_ci_artifacts', {
      runId: 'run_7f3d9c21',
      pageToken: 'page-1',
    });

    expect(harness.callsTo(RPC.listArtifacts)[0]?.body).toMatchObject({
      runId: 'run_7f3d9c21',
      pageToken: 'page-1',
    });
    expect(result.structured.nextPageToken).toBe('page-2');
    expect(result.text).toContain('re-call with pageToken');
    expect(result.text).not.toContain('higher limit');
  });
});
