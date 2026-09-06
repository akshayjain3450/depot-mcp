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
  type StubReply,
  type StubRoutes,
} from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const A = 'run_cmp_a';
const B = 'run_cmp_b';

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Answers per side from the request body, so the two runs share one route deterministically. */
function bySide(
  field: 'runId' | 'targetId',
  replies: { a: StubReply; b: StubReply },
): (body: Record<string, unknown>) => StubReply {
  return (body) => (body[field] === A ? replies.a : replies.b);
}

function routes(overrides: Partial<StubRoutes> = {}): StubRoutes {
  return {
    [RPC.getRun]: bySide('runId', {
      a: ok(fixture('compare-run-a')),
      b: ok(fixture('compare-run-b')),
    }),
    [RPC.getRunStatus]: bySide('runId', {
      a: ok(fixture('compare-status-a')),
      b: ok(fixture('compare-status-b')),
    }),
    [RPC.getRunMetrics]: bySide('runId', {
      a: ok(fixture('compare-metrics-a')),
      b: ok(fixture('compare-metrics-b')),
    }),
    [RPC.getFailureDiagnosis]: bySide('targetId', {
      a: ok(fixture('compare-diagnosis-a')),
      b: ok(fixture('compare-diagnosis-b')),
    }),
    ...overrides,
  };
}

function byKey(result: { structured: Record<string, unknown> }, jobKey: string) {
  const row = rows(result.structured.jobs).find((entry) => entry.jobKey === jobKey);
  if (row === undefined) {
    throw new Error(`no matrix row for ${jobKey}`);
  }
  return row;
}

describe('depot_compare_ci_runs', () => {
  it('sends GetRun, GetRunStatus, GetRunMetrics, and a numeric-typed GetFailureDiagnosis for each side', async () => {
    harness = await createHarness({ routes: routes() });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError, result.text).toBe(false);
    for (const rpc of [RPC.getRun, RPC.getRunStatus, RPC.getRunMetrics]) {
      expect(harness.callsTo(rpc).map((call) => call.body)).toEqual([{ runId: A }, { runId: B }]);
    }
    expect(harness.callsTo(RPC.getFailureDiagnosis).map((call) => call.body)).toEqual([
      { targetId: A, targetType: 1 },
      { targetId: B, targetType: 1 },
    ]);
  });

  it('builds the job matrix with status, duration, and memory deltas, changed rows first', async () => {
    harness = await createHarness({ routes: routes() });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError, result.text).toBe(false);
    expect(rows(result.structured.jobs).map((row) => row.jobKey)).toEqual([
      'ci.yml:test',
      'ci.yml:build',
      'ci.yml:deploy',
      'ci.yml:docs',
      'ci.yml:lint',
    ]);
    expect(result.structured).toMatchObject({
      jobsReturned: 5,
      jobsOmitted: 0,
      onlyInA: ['ci.yml:deploy'],
      onlyInB: ['ci.yml:docs'],
      statusChanges: 2,
      truncated: false,
      metrics: { a: 'available', b: 'available' },
      diagnosis: { a: 'available', b: 'available' },
      contentWarning: UNTRUSTED_CI_CONTENT_WARNING,
    });

    expect(byKey(result, 'ci.yml:test')).toMatchObject({
      presence: 'both',
      statusA: 'failed',
      statusB: 'finished',
      statusChanged: true,
      durationSecondsA: 95,
      durationSecondsB: 90,
      durationDeltaSeconds: -5,
      peakMemoryUtilizationA: 0.42,
      peakMemoryUtilizationB: 0.4,
    });
    // Memory comes from the latest attempt (attempt 2), and the int64-as-string bytes parse.
    expect(byKey(result, 'ci.yml:build')).toMatchObject({
      statusA: 'finished',
      statusB: 'failed',
      statusChanged: true,
      durationDeltaSeconds: 15,
      peakMemoryBytesA: 1_610_612_736,
      peakMemoryBytesB: 2_415_919_104,
      peakMemoryDeltaBytes: 805_306_368,
    });
    expect(byKey(result, 'ci.yml:lint')).toMatchObject({
      statusChanged: false,
      durationDeltaSeconds: 1,
    });
    expect(Number(byKey(result, 'ci.yml:lint').peakMemoryUtilizationDelta)).toBeCloseTo(0.01, 6);
    expect(byKey(result, 'ci.yml:deploy')).toMatchObject({
      presence: 'onlyA',
      statusA: 'skipped',
    });
    expect(byKey(result, 'ci.yml:deploy').statusB).toBeUndefined();
    expect(byKey(result, 'ci.yml:docs')).toMatchObject({ presence: 'onlyB', statusB: 'finished' });
  });

  it('lists failures new in B, resolved in B, and shared, keyed on the group error message', async () => {
    harness = await createHarness({ routes: routes() });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });
    const failures = asRecord(result.structured.failures);

    expect(rows(failures.newInB)).toEqual([
      expect.objectContaining({
        errorMessage: "Step 4 (Compile): error TS2322: Type 'string' is not assignable to type 'number'",
        count: 2,
        jobKeys: ['ci.yml:build'],
      }),
    ]);
    expect(rows(failures.resolvedInB).map((entry) => entry.errorMessage)).toEqual([
      'AssertionError: expected 200 to equal 503',
    ]);
    expect(rows(failures.inBoth).map((entry) => entry.errorMessage)).toEqual([
      'Error: ENOSPC: no space left on device',
    ]);
  });

  it('renders a side-by-side header, the deltas, and the failure lists inside the untrusted fence', async () => {
    harness = await createHarness({ routes: routes() });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.text).toContain(`A=${A} (baseline) vs B=${B}`);
    expect(result.text).toContain('A: failed · acme/api@aaaa1111 · via push · 3m · 4 job(s), 1 failed');
    expect(result.text).toContain('B: failed · acme/api@ffff6666 · via push · 3m30s · 4 job(s), 1 failed');
    expect(result.text).toContain('Wall time: +30s.');
    expect(result.text).toContain('Jobs: 3 in both, 1 only in A, 1 only in B, 2 status change(s).');
    expect(result.text).toContain('ci.yml:test: failed -> finished; 1m35s -> 1m30s (-5s); peak mem 42.0% -> 40.0% of limit (-2 pts) [changed]');
    expect(result.text).toContain('ci.yml:build: finished -> failed; 1m -> 1m15s (+15s); peak mem 1.5GiB -> 2.3GiB (+768MiB) [changed]');
    expect(result.text).toContain('ci.yml:deploy: only in A (skipped)');
    expect(result.text).toContain('ci.yml:docs: only in B (finished)');
    expect(result.text).toContain('New failures in B (absent from A):\n  - Step 4 (Compile): error TS2322');
    expect(result.text).toContain('Resolved in B (present in A only):\n  - AssertionError: expected 200 to equal 503 (2x) [ci.yml:test]');
    expect(result.text).toContain('Failing the same way in both:\n  - Error: ENOSPC');
    expect(result.text).toContain('depot_diagnose_ci_failure {"id":"run_cmp_b"}');

    const begin = result.text.indexOf(UNTRUSTED_CONTENT_BEGIN);
    const end = result.text.indexOf(UNTRUSTED_CONTENT_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(result.text.slice(begin, end)).toContain('ci.yml:build');
    expect(result.text.slice(begin, end)).toContain('TS2322');
  });

  it('tolerates a metrics failure on one side: durations blank there, comparison still returned', async () => {
    harness = await createHarness({
      routes: routes({
        [RPC.getRunMetrics]: bySide('runId', {
          a: ok(fixture('compare-metrics-a')),
          b: connectError(429, 'resource_exhausted', 'metrics too large'),
        }),
      }),
    });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.metrics).toEqual({ a: 'available', b: 'unavailable' });
    expect(byKey(result, 'ci.yml:test')).toMatchObject({ durationSecondsA: 95 });
    expect(byKey(result, 'ci.yml:test').durationSecondsB).toBeUndefined();
    expect(byKey(result, 'ci.yml:test').durationDeltaSeconds).toBeUndefined();
    expect(JSON.stringify(result.structured.notes)).toContain('Metrics for runB are unavailable');
    expect(result.text).toContain('ci.yml:test: failed -> finished; 1m35s -> unknown duration');
    expect(rows(asRecord(result.structured.failures).newInB)).toHaveLength(1);
  });

  it('tolerates a diagnosis failure on one side and says that side is missing from the lists', async () => {
    harness = await createHarness({
      routes: routes({
        [RPC.getFailureDiagnosis]: bySide('targetId', {
          a: connectError(403, 'permission_denied', 'no'),
          b: ok(fixture('compare-diagnosis-b')),
        }),
      }),
    });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.diagnosis).toEqual({ a: 'unavailable', b: 'available' });
    expect(JSON.stringify(result.structured.notes)).toContain('Failure diagnosis for runA is unavailable');
    // Nothing is known about A, so every B failure looks new and nothing is "resolved".
    expect(rows(asRecord(result.structured.failures).newInB)).toHaveLength(2);
    expect(rows(asRecord(result.structured.failures).resolvedInB)).toHaveLength(0);
  });

  it('skips the diagnosis entirely with includeDiagnosis=false', async () => {
    harness = await createHarness({ routes: routes() });

    const result = await callTool(harness, 'depot_compare_ci_runs', {
      runA: A,
      runB: B,
      includeDiagnosis: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getFailureDiagnosis)).toHaveLength(0);
    expect(result.structured.diagnosis).toEqual({ a: 'skipped', b: 'skipped' });
    expect(result.structured.failures).toEqual({ newInB: [], resolvedInB: [], inBoth: [] });
    expect(result.text).not.toContain('New failures in B');
    expect(JSON.stringify(result.structured.notes)).toContain('includeDiagnosis=false');
  });

  it('only diagnoses the side that failed', async () => {
    const greenA = { ...fixture('compare-run-a'), status: 'finished' };
    const greenStatusA = JSON.parse(
      JSON.stringify(fixture('compare-status-a')).replaceAll('"failed"', '"finished"'),
    ) as unknown;
    harness = await createHarness({
      routes: routes({
        [RPC.getRun]: bySide('runId', { a: ok(greenA), b: ok(fixture('compare-run-b')) }),
        [RPC.getRunStatus]: bySide('runId', {
          a: ok(greenStatusA),
          b: ok(fixture('compare-status-b')),
        }),
      }),
    });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getFailureDiagnosis).map((call) => call.body)).toEqual([
      { targetId: B, targetType: 1 },
    ]);
    expect(result.structured.diagnosis).toEqual({ a: 'skipped', b: 'available' });
    expect(rows(asRecord(result.structured.failures).newInB)).toHaveLength(2);
  });

  it('refuses the same id on both sides, and reports two identical runs as unchanged', async () => {
    harness = await createHarness({ routes: routes() });

    const same = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: A });
    expect(same.isError).toBe(true);
    expect(same.text).toContain('same run');
    expect(harness.calls).toHaveLength(0);

    await harness.close();
    harness = await createHarness({
      routes: {
        [RPC.getRun]: ok(fixture('compare-run-a')),
        [RPC.getRunStatus]: ok(fixture('compare-status-a')),
        [RPC.getRunMetrics]: ok(fixture('compare-metrics-a')),
        [RPC.getFailureDiagnosis]: ok(fixture('compare-diagnosis-a')),
      },
    });

    const twin = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: 'run_cmp_twin' });

    expect(twin.isError, twin.text).toBe(false);
    expect(twin.structured).toMatchObject({
      statusChanges: 0,
      onlyInA: [],
      onlyInB: [],
      failures: { newInB: [], resolvedInB: [] },
    });
    expect(rows(asRecord(twin.structured.failures).inBoth)).toHaveLength(2);
    expect(rows(twin.structured.jobs).every((row) => row.durationDeltaSeconds === 0 || row.durationDeltaSeconds === undefined)).toBe(true);
    expect(twin.text).toContain('Every job has the same status in both runs.');
    expect(twin.text).toContain('Wall time: unchanged.');
    expect(twin.text).toContain('New failures in B (absent from A):\n  (none)');
  });

  it('names the side when one run id is unknown', async () => {
    harness = await createHarness({
      routes: routes({
        [RPC.getRun]: bySide('runId', { a: ok(fixture('compare-run-a')), b: NOT_FOUND }),
        [RPC.getRunStatus]: bySide('runId', { a: ok(fixture('compare-status-a')), b: NOT_FOUND }),
      }),
    });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError).toBe(true);
    expect(result.text).toContain(`runB "${B}"`);
    expect(result.text).toContain('depot_list_ci_runs');
  });

  it('surfaces other Depot errors on the run itself as errors', async () => {
    harness = await createHarness({
      routes: routes({ [RPC.getRun]: connectError(401, 'unauthenticated', 'Invalid token') }),
    });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('unauthenticated');
  });

  it('reads snake_case spellings of every document', async () => {
    const snake = (value: unknown): unknown =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll('"jobKey"', '"job_key"')
          .replaceAll('"startedAt"', '"started_at"')
          .replaceAll('"finishedAt"', '"finished_at"')
          .replaceAll('"peakMemoryUtilization"', '"peak_memory_utilization"')
          .replaceAll('"peakMemoryBytes"', '"peak_memory_bytes"')
          .replaceAll('"errorMessage"', '"error_message"')
          .replaceAll('"failureGroups"', '"failure_groups"')
          .replaceAll('"runId"', '"run_id"'),
      ) as unknown;
    harness = await createHarness({
      routes: {
        [RPC.getRun]: bySide('runId', {
          a: ok(snake(fixture('compare-run-a'))),
          b: ok(snake(fixture('compare-run-b'))),
        }),
        [RPC.getRunStatus]: bySide('runId', {
          a: ok(snake(fixture('compare-status-a'))),
          b: ok(snake(fixture('compare-status-b'))),
        }),
        [RPC.getRunMetrics]: bySide('runId', {
          a: ok(snake(fixture('compare-metrics-a'))),
          b: ok(snake(fixture('compare-metrics-b'))),
        }),
        [RPC.getFailureDiagnosis]: bySide('targetId', {
          a: ok(snake(fixture('compare-diagnosis-a'))),
          b: ok(snake(fixture('compare-diagnosis-b'))),
        }),
      },
    });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B });

    expect(result.isError, result.text).toBe(false);
    expect(asRecord(result.structured.runA)).toMatchObject({ runId: A, durationSeconds: 180 });
    expect(byKey(result, 'ci.yml:build')).toMatchObject({
      durationDeltaSeconds: 15,
      peakMemoryDeltaBytes: 805_306_368,
    });
    expect(rows(asRecord(result.structured.failures).newInB)).toHaveLength(1);
  });

  it('caps the matrix at maxJobs, keeping changed rows and reporting the omission', async () => {
    harness = await createHarness({ routes: routes() });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: A, runB: B, maxJobs: 3 });

    expect(result.isError, result.text).toBe(false);
    expect(rows(result.structured.jobs).map((row) => row.jobKey)).toEqual([
      'ci.yml:test',
      'ci.yml:build',
      'ci.yml:deploy',
    ]);
    expect(result.structured).toMatchObject({
      jobsReturned: 3,
      jobsOmitted: 2,
      truncated: true,
      // Counts still describe the whole comparison, not just the returned rows.
      onlyInB: ['ci.yml:docs'],
      statusChanges: 2,
    });
    expect(result.text).toContain('2 unchanged job row(s) omitted by maxJobs=3');
  });

  it('rejects blank ids before calling Depot', async () => {
    harness = await createHarness({ routes: routes() });

    const result = await callTool(harness, 'depot_compare_ci_runs', { runA: '  ', runB: B });

    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});
