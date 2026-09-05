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
