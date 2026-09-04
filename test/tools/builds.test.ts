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
