import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
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

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

describe('depot_list_project_usage', () => {
  it('sends the window and page token, names projects, and sorts by cache size', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listProjectUsage]: ok({ ...fixture('project-usage'), nextPageToken: 'page-2' }),
        [RPC.listProjects]: ok(fixture('projects')),
      },
    });

    const result = await callTool(harness, 'depot_list_project_usage', {
      startAt: '2026-08-01',
      endAt: '2026-08-31',
      pageToken: 'page-1',
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.listProjectUsage)[0]?.body).toEqual({
      startAt: '2026-08-01T00:00:00.000Z',
      endAt: '2026-09-01T00:00:00.000Z',
      pageToken: 'page-1',
    });
    expect(harness.callsTo(RPC.listProjects)).toHaveLength(1);

    const projects = records(result.structured.projects);
    expect(projects.map((row) => row.projectId)).toEqual(['proj_web3c9', 'proj_api7f2', 'proj_idle00']);
    expect(projects[0]).toMatchObject({ name: 'web', buildCount: 41, layerCacheSizeGb: 63 });
    expect(projects[2]?.name).toBeUndefined();
    expect(result.structured.totals).toEqual({
      buildCount: 43,
      buildDurationSeconds: 7392,
      layerCacheSizeGb: 64,
    });
    expect(result.structured.nextPageToken).toBe('page-2');
    expect(result.text).toContain('proj_web3c9 (web)');
    expect(result.text).toContain('cache 63 GB');
    expect(result.text).toContain('re-call with pageToken');
  });

  it('defaults to a 30-day window when no dates are given', async () => {
    harness = await createHarness({
      routes: { [RPC.listProjectUsage]: ok({}), [RPC.listProjects]: ok({}) },
    });
    const before = Date.now();

    const result = await callTool(harness, 'depot_list_project_usage', {});

    const body = harness.callsTo(RPC.listProjectUsage)[0]?.body ?? {};
    const startAt = Date.parse(String(body.startAt));
    const endAt = Date.parse(String(body.endAt));
    expect(endAt - startAt).toBe(30 * 24 * 60 * 60 * 1000);
    expect(endAt).toBeGreaterThanOrEqual(before);
    expect(body.pageToken).toBeUndefined();
    expect(result.structured.returned).toBe(0);
    expect(result.text).toContain('no project usage');
  });

  it('reads snake_case rows the same as camelCase', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listProjectUsage]: ok({
          usage: [
            { project_id: 'proj_snake', build_count: 4, build_duration_seconds: 120, layer_cache_size_gb: 9 },
          ],
        }),
        [RPC.listProjects]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_list_project_usage', {});

    expect(records(result.structured.projects)[0]).toEqual({
      projectId: 'proj_snake',
      buildCount: 4,
      buildDurationSeconds: 120,
      layerCacheSizeGb: 9,
    });
  });

  it('keeps going without names when ListProjects is refused', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listProjectUsage]: ok(fixture('project-usage')),
        [RPC.listProjects]: connectError(401, 'unauthenticated', 'Invalid token'),
      },
    });

    const result = await callTool(harness, 'depot_list_project_usage', {});

    expect(result.isError).toBe(false);
    expect(result.structured.returned).toBe(3);
    expect(records(result.structured.projects).every((row) => row.name === undefined)).toBe(true);
    expect(strings(result.structured.notes)[0]).toMatch(/names are missing.*unauthenticated/);
  });

  it('refuses half a window', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_list_project_usage', { startAt: '2026-08-01' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('both startAt and endAt');
    expect(harness.calls).toHaveLength(0);
  });

  it('translates a Connect error from ListProjectUsage', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listProjectUsage]: connectError(403, 'permission_denied', 'organization tokens only'),
        [RPC.listProjects]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_list_project_usage', {});

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/permission_denied|organization tokens only/);
  });
});

describe('depot_get_usage with projectId', () => {
  it('reads the record GetProjectUsage nests under "usage"', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProjectUsage]: ok({
          usage: { projectId: 'proj_api7f2', buildCount: 2, buildDurationSeconds: 12, layerCacheSizeGb: 1 },
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_usage', { projectId: 'proj_api7f2' });

    expect(result.isError).toBe(false);
    expect(result.structured.projectUsage).toEqual({
      projectId: 'proj_api7f2',
      buildCount: 2,
      buildDurationSeconds: 12,
      layerCacheSizeGb: 1,
    });
    expect(result.text).toContain('builds: 2');
  });
});

const PROJECT = {
  project: {
    projectId: 'proj_api7f2',
    name: 'api',
    cachePolicy: { keepBytes: '53687091200', keepDays: 14, keepGb: 50 },
  },
};

function build(index: number, cachedSteps: number, totalSteps: number, daysAgo: number) {
  return {
    buildId: `bld_${index}`,
    status: 'STATUS_SUCCESS',
    createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    buildDurationSeconds: 100,
    savedDurationSeconds: 90,
    cachedSteps,
    totalSteps,
  };
}

describe('depot_get_cache_summary', () => {
  it('combines policy, current size, a build sample and billing, and flags problems', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok(PROJECT),
        [RPC.listProjectUsage]: ok({
          usage: [
            { projectId: 'proj_other', layerCacheSizeGb: 3 },
            { projectId: 'proj_api7f2', buildCount: 4, buildDurationSeconds: 400, layerCacheSizeGb: 45 },
          ],
        }),
        [RPC.listBuilds]: ok({
          builds: [build(1, 1, 4, 0), build(2, 1, 4, 1), build(3, 1, 4, 2), build(4, 0, 4, 3)],
        }),
        [RPC.getUsage]: ok({
          containerBuild: [
            { projectName: 'web', minutesBilled: 500, minutesSaved: 1 },
            { projectName: 'api', buildCount: 4, minutesBilled: 7, minutesSaved: 6 },
          ],
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_cache_summary', {
      projectId: 'proj_api7f2',
      windowDays: 7,
      buildSample: 4,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getProject)[0]?.body).toEqual({ projectId: 'proj_api7f2' });
    expect(harness.callsTo(RPC.listBuilds)[0]?.body).toEqual({ projectId: 'proj_api7f2', pageSize: 4 });
    const usageBody = harness.callsTo(RPC.listProjectUsage)[0]?.body ?? {};
    expect(Date.parse(String(usageBody.endAt)) - Date.parse(String(usageBody.startAt))).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    expect(harness.callsTo(RPC.getUsage)).toHaveLength(1);

    expect(result.structured.policy).toEqual({ keepGb: 50, keepDays: 14 });
    expect(result.structured.cache).toEqual({
      layerCacheSizeGb: 45,
      percentOfKeepGb: 90,
      buildCountInWindow: 4,
      buildDurationSecondsInWindow: 400,
    });
    expect(asRecord(result.structured.sample)).toMatchObject({
      builds: 4,
      buildsWithStepCounts: 4,
      cachedSteps: 3,
      totalSteps: 16,
      hitRatio: 0.19,
      savedDurationSeconds: 360,
      minutesSaved: 6,
      averageDaysBetweenBuilds: 1,
    });
    expect(result.structured.billing).toEqual({ minutesBilled: 7, minutesSaved: 6 });

    const observations = strings(result.structured.observations);
    expect(observations.some((line) => /90% of its 50 GB/.test(line))).toBe(true);
    expect(observations.some((line) => /Only 19% of steps/.test(line))).toBe(true);
    expect(observations.some((line) => /cold/.test(line))).toBe(false);

    expect(result.text).toContain('Policy: keeps 50 GB / 14 days. Current layer cache: 45 GB (90% of the limit).');
    expect(result.text).toContain('3 of 16 steps from cache (19% hit ratio)');
    expect(result.text).toContain('7 min billed, 6 min saved');
    expect(result.text).toMatch(/does not list individual cache entries/);
    expect(result.text).toMatch(/Resetting a project .* not offered/);
    expect(strings(result.structured.limitations)).toHaveLength(2);
  });

  it('notices builds arriving less often than the retention keeps layers, and a stale last build', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok({ project: { projectId: 'proj_api7f2', cachePolicy: { keepDays: 7, keepGb: 50 } } }),
        [RPC.listProjectUsage]: ok({ usage: [{ projectId: 'proj_api7f2', layerCacheSizeGb: 2 }] }),
        [RPC.listBuilds]: ok({ builds: [build(1, 4, 4, 10), build(2, 4, 4, 22), build(3, 4, 4, 34)] }),
        [RPC.getUsage]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_get_cache_summary', { projectId: 'proj_api7f2' });

    const observations = strings(result.structured.observations);
    expect(observations.some((line) => /every 12 days .* 7 days/.test(line))).toBe(true);
    expect(observations.some((line) => /10 days ago, past the 7-day retention/.test(line))).toBe(true);
    // Only the GetUsage row is keyed by name, and this project has none, so GetUsage is not called.
    expect(harness.callsTo(RPC.getUsage)).toHaveLength(0);
    expect(result.structured.billing).toBeUndefined();
  });

  it('reports a healthy cache when nothing stands out', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok(PROJECT),
        [RPC.listProjectUsage]: ok({ usage: [{ projectId: 'proj_api7f2', layerCacheSizeGb: 5 }] }),
        [RPC.listBuilds]: ok({ builds: [build(1, 4, 4, 0), build(2, 3, 4, 1), build(3, 4, 4, 2)] }),
        [RPC.getUsage]: ok({ containerBuild: [] }),
      },
    });

    const result = await callTool(harness, 'depot_get_cache_summary', { projectId: 'proj_api7f2' });

    expect(strings(result.structured.observations)).toEqual([
      'Nothing stands out: cache size, hit ratio and build cadence all look healthy in this sample.',
    ]);
    expect(result.structured.billing).toBeUndefined();
  });

  it('walks ListProjectUsage pages to find the project and degrades when GetUsage fails', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok(PROJECT),
        [RPC.listProjectUsage]: [
          ok({ usage: [{ projectId: 'proj_other', layerCacheSizeGb: 3 }], nextPageToken: 'p2' }),
          ok({ usage: [{ project_id: 'proj_api7f2', layer_cache_size_gb: 8 }] }),
        ],
        [RPC.listBuilds]: ok({ builds: [] }),
        [RPC.getUsage]: connectError(500, 'internal', 'boom'),
      },
    });

    const result = await callTool(harness, 'depot_get_cache_summary', { projectId: 'proj_api7f2' });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.listProjectUsage)).toHaveLength(2);
    expect(harness.callsTo(RPC.listProjectUsage)[1]?.body).toMatchObject({ pageToken: 'p2' });
    expect(asRecord(result.structured.cache).layerCacheSizeGb).toBe(8);
    expect(strings(result.structured.notes)).toEqual([
      expect.stringMatching(/GetUsage failed \(internal\)/),
    ]);
    expect(strings(result.structured.observations)).toEqual([
      'No builds were returned for this project, so there is no hit ratio to report.',
    ]);
  });

  it('says so when the project has no usage row in the window', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok(PROJECT),
        [RPC.listProjectUsage]: ok({}),
        [RPC.listBuilds]: ok({ builds: [] }),
        [RPC.getUsage]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_get_cache_summary', { projectId: 'proj_api7f2' });

    expect(asRecord(result.structured.cache).layerCacheSizeGb).toBeUndefined();
    expect(strings(result.structured.notes)[0]).toMatch(/no row for this project/);
    expect(result.text).toContain('Current layer cache: unknown.');
  });

  it('falls back to DEPOT_PROJECT_ID and refuses to run without any project', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok(PROJECT),
        [RPC.listProjectUsage]: ok({}),
        [RPC.listBuilds]: ok({ builds: [] }),
        [RPC.getUsage]: ok({}),
      },
      config: { projectId: 'proj_env' },
    });
    const withDefault = await callTool(harness, 'depot_get_cache_summary', {});
    expect(withDefault.isError).toBe(false);
    expect(harness.callsTo(RPC.getProject)[0]?.body).toEqual({ projectId: 'proj_env' });

    await harness.close();
    harness = await createHarness({ routes: {} });
    const without = await callTool(harness, 'depot_get_cache_summary', {});
    expect(without.isError).toBe(true);
    expect(without.text).toContain('DEPOT_PROJECT_ID');
    expect(harness.calls).toHaveLength(0);
  });

  it('rejects a window or sample beyond the caps before calling Depot', async () => {
    harness = await createHarness({ routes: {} });

    const tooLong = await callTool(harness, 'depot_get_cache_summary', { projectId: 'p', windowDays: 91 });
    const tooMany = await callTool(harness, 'depot_get_cache_summary', { projectId: 'p', buildSample: 101 });

    expect(tooLong.isError).toBe(true);
    expect(tooMany.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('translates a Connect error from GetProject', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: connectError(404, 'not_found', 'project not found'),
        [RPC.listProjectUsage]: ok({}),
        [RPC.listBuilds]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_get_cache_summary', { projectId: 'proj_missing' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not_found|project not found/);
  });
});
