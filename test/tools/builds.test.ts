import { afterEach, describe, expect, it } from 'vitest';
import { callTool, connectError, createHarness, fixture, ok, type Harness } from '../helpers/harness.js';
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

const buildRoutes = {
  [RPC.getBuild]: ok(fixture('build')),
  [RPC.getBuildSteps]: ok(fixture('build-steps')),
  [RPC.getBuildStepLogs]: ok(fixture('build-step-logs')),
};

describe('depot_diagnose_build', () => {
  it('finds the step that errored and returns its logs and cache summary', async () => {
    harness = await createHarness({ routes: buildRoutes });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
    });

    expect(result.isError).toBe(false);
    expect(asRecord(result.structured.build)).toMatchObject({
      buildId: 'bld_4a91c7',
      status: 'failed',
      cachedSteps: 11,
      totalSteps: 14,
      cacheHitRatio: 0.79,
    });
    expect(result.structured.stepCount).toBe(4);
    expect(asRecord(result.structured.failingStep)).toMatchObject({
      digest: 'sha256:33cc',
      cacheState: 'uncached',
      selectedBecause: 'this step reported an error',
    });
    expect(String(asRecord(result.structured.failingStep).error)).toContain('exit code: 2');
    expect(records([...(result.structured.logTail as unknown[])])).toBeDefined();
    expect(result.text).toContain('error TS2345');
    expect(result.text).toContain('79% cached');

    expect(harness.callsTo(RPC.getBuildStepLogs)[0]?.body).toMatchObject({
      projectId: 'proj_api7f2',
      buildId: 'bld_4a91c7',
      buildStepDigest: 'sha256:33cc',
    });
  });

  it('finds the owning project by search when none is supplied', async () => {
    harness = await createHarness({
      routes: {
        ...buildRoutes,
        [RPC.listProjects]: ok(fixture('projects')),
        [RPC.listBuilds]: ok(fixture('builds-list')),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', { buildId: 'bld_4a91c7' });

    expect(result.structured.projectId).toBe('proj_api7f2');
    expect(harness.callsTo(RPC.listProjects)).toHaveLength(1);
  });

  it('prefers DEPOT_PROJECT_ID over searching', async () => {
    harness = await createHarness({
      routes: buildRoutes,
      config: { projectId: 'proj_from_env' },
    });

    const result = await callTool(harness, 'depot_diagnose_build', { buildId: 'bld_4a91c7' });

    expect(result.structured.projectId).toBe('proj_from_env');
    expect(harness.callsTo(RPC.listProjects)).toHaveLength(0);
  });

  it('asks for a projectId rather than failing opaquely when the search misses', async () => {
    harness = await createHarness({
      routes: {
        ...buildRoutes,
        [RPC.listProjects]: ok(fixture('projects')),
        [RPC.listBuilds]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', { buildId: 'bld_unknown' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('projectId');
    expect(result.text).toContain('depot_list_projects');
  });

  it('warns when the build did not actually fail', async () => {
    harness = await createHarness({
      routes: {
        ...buildRoutes,
        [RPC.getBuild]: ok({ build: { buildId: 'bld_ok', status: 3, cachedSteps: 14, totalSteps: 14 } }),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_ok',
      projectId: 'proj_api7f2',
    });

    expect(JSON.stringify(result.structured.notes)).toContain('not a failure');
  });

  it('does not call the tail "last lines" when the page cap stopped the log walk', async () => {
    harness = await createHarness({
      routes: {
        ...buildRoutes,
        [RPC.getBuildStepLogs]: ok({
          logs: [{ message: 'step 1 of many' }, { message: 'step 2 of many' }],
          nextPageToken: 'logs-page-2',
        }),
      },
      config: { maxLogPages: 1 },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
    });

    expect(result.isError).toBe(false);
    expect(harness.callsTo(RPC.getBuildStepLogs)).toHaveLength(1);
    expect(result.structured.logTail).toEqual(['step 1 of many', 'step 2 of many']);
    expect(result.structured.logTruncated).toBe(true);
    expect(result.structured.logPageCapHit).toBe(true);
    expect(result.structured.logNextPageToken).toBe('logs-page-2');
    expect(result.text).not.toMatch(/last \d+ log line/i);
    expect(result.text).toMatch(/first 1 page/i);
    expect(result.text).toMatch(/continues/i);
    expect(JSON.stringify(result.structured.notes)).toContain('DEPOT_MCP_MAX_LOG_PAGES');
  });

  it('keeps calling a complete tail the last lines', async () => {
    harness = await createHarness({ routes: buildRoutes });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
    });

    expect(result.structured.logPageCapHit).toBe(false);
    expect(result.structured.logNextPageToken).toBeUndefined();
    expect(result.text).toMatch(/last 4 log line/i);
  });

  it('caps a huge log line and a huge step error so neither escapes the budget', async () => {
    const hugeLine = 'L'.repeat(50_000);
    const hugeError = 'E'.repeat(50_000);
    harness = await createHarness({
      routes: {
        ...buildRoutes,
        [RPC.getBuildSteps]: ok({
          steps: [
            {
              name: 'RUN make',
              digest: 'sha256:33cc',
              cacheState: 1,
              error: hugeError,
              hasLogs: true,
            },
          ],
        }),
        [RPC.getBuildStepLogs]: ok({
          logs: [{ message: 'before' }, { message: hugeLine }, { message: 'after' }],
        }),
      },
      config: { outputCharBudget: 6_000 },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
    });

    expect(result.isError).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(6_100);
    expect(JSON.stringify(result.structured).length).toBeLessThan(12_000);
    const tail = Array.isArray(result.structured.logTail) ? result.structured.logTail.map(String) : [];
    expect(tail.map((line) => line.length <= 2_000)).toEqual([true, true, true]);
    expect(result.structured.logLinesTruncated).toBe(1);
    const failing = asRecord(result.structured.failingStep);
    expect(String(failing.error).length).toBeLessThanOrEqual(2_000);
    expect(failing.errorTruncated).toBe(true);
  });
});

describe('depot_list_builds', () => {
  it('reports cache effectiveness per build and points at the failure', async () => {
    harness = await createHarness({ routes: { [RPC.listBuilds]: ok(fixture('builds-list')) } });

    const result = await callTool(harness, 'depot_list_builds', { projectId: 'proj_api7f2' });
    const builds = records(result.structured.builds);

    expect(result.structured.returned).toBe(3);
    expect(builds.map((build) => build.status)).toEqual(['failed', 'success', 'success']);
    expect(builds[1]?.cacheHitRatio).toBe(0.93);
    expect(builds[2]?.cacheHitRatio).toBe(0);
    expect(result.text).toContain('11/14 cached');
    expect(result.text).toContain('depot_diagnose_build');
  });

  it('requires a project and says where to find one', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_list_builds', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('depot_list_projects');
    expect(result.text).toContain('DEPOT_PROJECT_ID');
  });
});

describe('depot_diagnose_build when Depot cannot serve step data', () => {

  it('still returns the build-level facts when GetBuildSteps fails server-side', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok(fixture('build')),
        [RPC.getBuildSteps]: connectError(500, 'internal', 'Error fetching build steps'),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_9e2c1a',
      projectId: 'proj_api7f2',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.stepsUnavailable).toBe(true);
    expect(result.structured.stepCount).toBe(0);
    expect(result.text).toContain('could not return the steps');
    expect(result.text).toContain('Error fetching build steps');
  });

  it('keeps the failing step and its error when GetBuildStepLogs fails server-side', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok(fixture('build')),
        [RPC.getBuildSteps]: ok(fixture('build-steps')),
        [RPC.getBuildStepLogs]: connectError(500, 'internal', 'internal error'),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_9e2c1a',
      projectId: 'proj_api7f2',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.logsUnavailable).toBe(true);
    expect(result.structured.logTail).toEqual([]);
    expect(result.text).toContain('Step to look at');
    expect(result.text).toContain("could not return the step's logs");
    expect(result.text).not.toContain('Depot reports no logs for this step');
  });

  it('does not swallow non-server-side errors from the step endpoints', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok(fixture('build')),
        [RPC.getBuildSteps]: connectError(403, 'permission_denied', 'nope'),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_9e2c1a',
      projectId: 'proj_api7f2',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('permission_denied');
  });
});

describe('depot_get_build', () => {
  it('returns status, timing, cache counters and a diagnose hint for a failed build', async () => {
    harness = await createHarness({ routes: { [RPC.getBuild]: ok(fixture('build')) } });

    const result = await callTool(harness, 'depot_get_build', { buildId: 'bld_4a91c7' });

    expect(result.isError, result.text).toBe(false);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.body).toEqual({ buildId: 'bld_4a91c7' });
    expect(result.structured).toEqual({
      build: {
        buildId: 'bld_4a91c7',
        status: 'failed',
        createdAt: '2026-09-03T18:20:00Z',
        startedAt: '2026-09-03T18:20:04Z',
        finishedAt: '2026-09-03T18:23:19Z',
        buildDurationSeconds: 195,
        savedDurationSeconds: 412,
        cachedSteps: 11,
        totalSteps: 14,
        cacheHitRatio: 0.79,
      },
      terminal: true,
      failure: true,
      cacheSummary: { cachedSteps: 11, totalSteps: 14, cacheHitRatio: 0.79, savedDurationSeconds: 412 },
      hint: 'Find the failing step with depot_diagnose_build {"buildId":"bld_4a91c7"} (add projectId if you know it).',
    });
    expect(result.text).toContain('Build bld_4a91c7: failed, 3m15s.');
    expect(result.text).toContain('created 2026-09-03T18:20:00Z, started 2026-09-03T18:20:04Z, finished 2026-09-03T18:23:19Z');
    expect(result.text).toContain('Steps: 11 of 14 served from cache (79% cached). Cache saved 6m52s.');
    expect(result.text).toContain('depot_diagnose_build {"buildId":"bld_4a91c7"}');
  });

  it('gives no hint for a successful build and drops the projectId aside when one is configured', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok({
          build: { buildId: 'bld_ok', status: 'STATUS_SUCCESS', cachedSteps: 14, totalSteps: 14 },
        }),
      },
      config: { projectId: 'proj_api7f2' },
    });

    const result = await callTool(harness, 'depot_get_build', { buildId: 'bld_ok' });

    expect(result.structured).toMatchObject({
      build: { status: 'success', cacheHitRatio: 1 },
      terminal: true,
      failure: false,
    });
    expect(result.structured.hint).toBeUndefined();
    expect(result.text).toContain('100% cached');
    expect(result.text).not.toContain('depot_diagnose_build');
  });

  it('says a running build is not finished and suggests polling again', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok({
          build: { buildId: 'bld_run', status: 1, createdAt: '2026-09-06T11:59:00Z', startedAt: '2026-09-06T11:59:10Z' },
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_build', { buildId: 'bld_run' });

    expect(result.structured).toMatchObject({
      build: { status: 'running' },
      terminal: false,
      failure: false,
    });
    expect(result.structured.hint).toContain('depot_get_build {"buildId":"bld_run"} again');
    expect(result.text).toContain('unknown duration');
    expect(result.text).not.toContain('Steps:');
  });

  it('reads a snake_case build document, including an error status, the same as camelCase', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok({
          build: {
            build_id: 'bld_snake',
            status: 'STATUS_ERROR',
            started_at: '2026-09-06T10:00:00Z',
            finished_at: '2026-09-06T10:00:30Z',
            saved_duration_seconds: '12',
            cached_steps: '1',
            total_steps: '4',
          },
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_build', { buildId: 'bld_snake' });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured).toMatchObject({
      build: {
        buildId: 'bld_snake',
        status: 'error',
        buildDurationSeconds: 30,
        savedDurationSeconds: 12,
        cachedSteps: 1,
        totalSteps: 4,
        cacheHitRatio: 0.25,
      },
      failure: true,
      terminal: true,
    });
    expect(result.text).toContain('depot_diagnose_build');
  });

  it('translates not_found into a tool error', async () => {
    harness = await createHarness({
      routes: { [RPC.getBuild]: connectError(404, 'not_found', 'build not found') },
    });

    const result = await callTool(harness, 'depot_get_build', { buildId: 'bld_missing' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
  });

  it('rejects a blank build id before calling Depot', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_get_build', { buildId: ' ' });

    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});
