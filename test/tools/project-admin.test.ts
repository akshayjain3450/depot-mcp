import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
  HARNESS_EPOCH,
  ok,
  type Harness,
  type StubRoutes,
} from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const WRITE_RPCS: readonly string[] = [RPC.updateProject, RPC.deleteProject];

function writeCalls(from: Harness): string[] {
  return from.calls.map((call) => call.rpc).filter((rpc) => WRITE_RPCS.includes(rpc));
}

function record(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

async function open(
  routes: StubRoutes,
  config: { allowWrites?: boolean; allowDestructive?: boolean } = { allowWrites: true },
): Promise<Harness> {
  const created = await createHarness({ routes, config });
  // Primes the client-side output validators, so every structured result below is checked
  // against the advertised schema.
  await created.client.listTools();
  return created;
}

/** The fixture project: "api" in us-east-1, 16x32, 50 GB for 14 days. */
const PROJECT_ROUTES: StubRoutes = { [RPC.getProject]: ok(fixture('project')) };

/** Three builds, the newest on 2026-09-03, three days before the harness epoch. */
const DELETE_ROUTES: StubRoutes = {
  ...PROJECT_ROUTES,
  [RPC.listBuilds]: ok(fixture('builds-list')),
};

/** A build from one hour before the harness clock, so the recent-build rule fires. */
function recentBuilds(): StubRoutes {
  const createdAt = new Date(HARNESS_EPOCH - 3_600_000).toISOString();
  return {
    ...PROJECT_ROUTES,
    [RPC.listBuilds]: ok({
      builds: [{ buildId: 'bld_fresh', status: 3, createdAt }, ...records(fixture('builds-list').builds)],
    }),
  };
}

async function toolNames(from: Harness): Promise<string[]> {
  const { tools } = await from.client.listTools();
  return tools.map((tool) => tool.name);
}

describe('gating', () => {
  it.each([
    ['neither flag', { allowWrites: false, allowDestructive: false }, false, false],
    ['writes only', { allowWrites: true, allowDestructive: false }, true, false],
    ['destructive only', { allowWrites: false, allowDestructive: true }, false, false],
    ['both flags', { allowWrites: true, allowDestructive: true }, true, true],
  ])('with %s lists update=%s and delete=%s', async (_label, config, updateListed, deleteListed) => {
    harness = await createHarness({ routes: {}, config });
    const names = await toolNames(harness);

    expect(names.includes('depot_update_project')).toBe(updateListed);
    expect(names.includes('depot_delete_project')).toBe(deleteListed);
  });

  it('refuses to call depot_delete_project when only DEPOT_MCP_ALLOW_WRITES is set, without touching Depot', async () => {
    harness = await open(DELETE_ROUTES, { allowWrites: true });

    const outcome = await harness.client
      .callTool({
        name: 'depot_delete_project',
        arguments: { projectId: 'proj_api7f2', confirmProjectName: 'api', dryRun: false },
      })
      .then(
        (result) => ({ failed: result.isError === true }),
        () => ({ failed: true }),
      );

    expect(outcome.failed).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('annotates update as reversible and idempotent, delete as destructive and idempotent', async () => {
    harness = await open({}, { allowWrites: true, allowDestructive: true });
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations ?? {}]));

    expect(byName.get('depot_update_project')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get('depot_delete_project')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    for (const name of ['depot_update_project', 'depot_delete_project']) {
      const tool = tools.find((entry) => entry.name === name);
      expect(record(record(tool?.inputSchema.properties).dryRun).default, name).toBe(true);
      expect(tool?.description, name).toContain('dryRun:false');
    }
  });
});

describe('depot_update_project', () => {
  it('previews a cache change as a diff, sending the whole policy, with an eviction warning when it shrinks', async () => {
    harness = await open(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      cacheKeepGb: 40,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(false);
    const preview = record(result.structured.preview);
    expect(preview).toMatchObject({
      projectId: 'proj_api7f2',
      changes: [{ field: 'cacheKeepGb', from: '50', to: '40' }],
      cachePolicy: { keepGb: 40, keepDays: 14 },
      cacheShrinks: true,
      hardwareChanges: false,
      regionChanges: false,
    });
    expect(record(preview.current)).toMatchObject({ name: 'api', hardware: '16x32' });
    expect(records(preview.warnings)).toHaveLength(1);
    expect(result.text).toContain('cacheKeepGb: 50 -> 40');
    expect(result.text).toContain('cache policy sent as a whole: 40 GB for 14 days');
    expect(result.text).toContain('WARNING: Shrinking the cache from 50 GB / 14 days to 40 GB / 14 days evicts');
    expect(result.structured.resend).toEqual({ projectId: 'proj_api7f2', cacheKeepGb: 40, dryRun: false });
    expect(harness.callsTo(RPC.getProject)[0]?.body).toEqual({ projectId: 'proj_api7f2' });
    expect(writeCalls(harness)).toEqual([]);
  });

  it('warns about cost on a hardware change and says nothing about eviction when the cache grows', async () => {
    harness = await open(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      hardware: '32x64',
      cacheKeepGb: 100,
    });

    expect(result.isError, result.text).toBe(false);
    const preview = record(result.structured.preview);
    expect(preview).toMatchObject({ cacheShrinks: false, hardwareChanges: true });
    expect(records(preview.changes).map((change) => change.field)).toEqual(['hardware', 'cacheKeepGb']);
    expect(result.text).toContain('hardware: 16x32 -> 32x64');
    expect(result.text).toContain('WARNING: Moving builders from 16x32 to 32x64 changes the per-minute cost');
    expect(result.text).not.toContain('evicts');
  });

  it('treats HARDWARE_UNSPECIFIED as 16x32, so asking for the default is not a change', async () => {
    harness = await open({
      [RPC.getProject]: ok({ project: { projectId: 'proj_x', name: 'x', hardware: 0, cachePolicy: { keepDays: 14, keepGb: 50 } } }),
    });

    const result = await callTool(harness, 'depot_update_project', { projectId: 'proj_x', hardware: '16x32' });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.refusal).toContain('no change requested');
  });

  it('refuses when the requested values equal the current ones, on a dry run and on apply', async () => {
    harness = await open(PROJECT_ROUTES);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const dry = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      cacheKeepDays: 14,
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.structured.applied).toBe(false);
    expect(dry.structured.refusal).toContain('no change requested');
    expect(dry.structured.resend).toBeUndefined();
    expect(dry.text).toContain('would be REFUSED');
    expect(dry.text).toContain('Requested values equal the current ones');

    const applied = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      cacheKeepDays: 14,
      name: 'api',
      dryRun: false,
    });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain('Refused depot_update_project before calling Depot: no change requested');
    expect(writeCalls(harness)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('rejects a call with no field to change before any network call', async () => {
    harness = await open(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_update_project', { projectId: 'proj_api7f2' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('No change requested');
    expect(harness.calls).toHaveLength(0);
  });

  it('refuses a region change and says Depot does not move projects', async () => {
    harness = await open(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      regionId: 'eu-central-1',
      dryRun: false,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('the project is in us-east-1 and Depot does not move projects between regions');
    expect(result.text).toContain('create a project in eu-central-1 with depot_create_project');
    expect(writeCalls(harness)).toEqual([]);
  });

  it('accepts the current region as a no-op alongside a real change', async () => {
    harness = await open(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      regionId: 'us-east-1',
      name: 'api-v2',
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.refusal).toBeUndefined();
    expect(records(record(result.structured.preview).changes)).toEqual([
      { field: 'name', from: 'api', to: 'api-v2' },
    ]);
  });

  it.each([
    ['cacheKeepGb', { cacheKeepGb: 0 }, 'cacheKeepGb must be at least 1 (got 0)'],
    ['cacheKeepDays', { cacheKeepDays: -3 }, 'cacheKeepDays must be at least 1 (got -3)'],
  ])('refuses %s below 1', async (_field, args, reason) => {
    harness = await open(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_update_project', { projectId: 'proj_api7f2', ...args });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.refusal).toContain(reason);
    expect(writeCalls(harness)).toEqual([]);
  });

  it('refuses a one-sided cache change when Depot did not report the current policy', async () => {
    harness = await open({ [RPC.getProject]: ok({ project: { projectId: 'proj_bare', name: 'bare' } }) });

    const result = await callTool(harness, 'depot_update_project', { projectId: 'proj_bare', cacheKeepGb: 20 });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.refusal).toContain('Pass both cacheKeepGb and cacheKeepDays');
    expect(record(result.structured.preview).cachePolicy).toBeUndefined();
  });

  it('applies with the project.proto field names, both cache numbers, and the hardware enum spelling', async () => {
    harness = await open({
      ...PROJECT_ROUTES,
      [RPC.updateProject]: ok({
        project: {
          projectId: 'proj_api7f2',
          name: 'api-v2',
          regionId: 'us-east-1',
          hardware: 'HARDWARE_8X16',
          cachePolicy: { keepDays: 7, keepGb: 50 },
        },
      }),
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      name: 'api-v2',
      hardware: '8x16',
      cacheKeepDays: 7,
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(harness.callsTo(RPC.updateProject)[0]?.body).toEqual({
      projectId: 'proj_api7f2',
      name: 'api-v2',
      hardware: 'HARDWARE_8X16',
      cachePolicy: { keepDays: 7, keepGb: 50 },
    });
    expect(writeCalls(harness)).toEqual([RPC.updateProject]);
    expect(record(result.structured.after).project).toMatchObject({
      name: 'api-v2',
      hardware: '8x16',
      cachePolicy: { keepDays: 7, keepGb: 50 },
    });
    expect(record(result.structured.before).projectId).toBe('proj_api7f2');
    expect(result.text).toContain('APPLIED depot_update_project');
    expect(result.text).toContain('Now: proj_api7f2 — api-v2');
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /^\[depot-mcp write\] depot_update_project projectId=proj_api7f2 name=api-v2 hardware=8x16 \d{4}-/,
    );
  });

  it('sends only the fields that change, never regionId', async () => {
    harness = await open({
      ...PROJECT_ROUTES,
      [RPC.updateProject]: ok({ project: { projectId: 'proj_api7f2', name: 'api' } }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_update_project', {
      projectId: 'proj_api7f2',
      name: 'api',
      regionId: 'us-east-1',
      hardware: '16x32',
      cacheKeepGb: 60,
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.updateProject)[0]?.body).toEqual({
      projectId: 'proj_api7f2',
      cachePolicy: { keepDays: 14, keepGb: 60 },
    });
  });

  it('rejects an unknown hardware label and a blank name before any network call', async () => {
    harness = await open(PROJECT_ROUTES);

    const hardware = await callTool(harness, 'depot_update_project', { projectId: 'p', hardware: '2x2' });
    const blank = await callTool(harness, 'depot_update_project', { projectId: 'p', name: '   ' });

    expect(hardware.isError).toBe(true);
    expect(hardware.text).toContain('hardware');
    expect(blank.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('surfaces a Depot error from GetProject rather than guessing', async () => {
    harness = await open({ [RPC.getProject]: connectError(401, 'unauthenticated', 'Invalid token') });

    const result = await callTool(harness, 'depot_update_project', { projectId: 'proj_api7f2', name: 'x' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Organization token');
    expect(writeCalls(harness)).toEqual([]);
  });
});

describe('depot_delete_project', () => {
  const both = { allowWrites: true, allowDestructive: true };

  it('previews the project, its build count and last build, and calls nothing mutating', async () => {
    harness = await open(DELETE_ROUTES, both);

    const result = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'api',
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(false);
    expect(result.structured.refusal).toBeUndefined();
    expect(record(result.structured.preview)).toMatchObject({
      nameMatches: true,
      buildCount: 3,
      buildCountComplete: true,
      lastBuildAt: '2026-09-03T18:20:00Z',
      hoursSinceLastBuild: 65.7,
      recentBuild: false,
    });
    expect(record(record(result.structured.preview).project)).toMatchObject({ projectId: 'proj_api7f2', name: 'api' });
    expect(result.text).toContain('Would PERMANENTLY delete proj_api7f2 — api');
    expect(result.text).toContain('in organization org_1a2b3c, created 2025-05-12T09:14:00Z');
    expect(result.text).toContain('Builds: 3; last build 2026-09-03T18:20:00Z (66 hour(s) ago)');
    expect(result.text).toContain('nothing can restore them');
    expect(result.text).toContain('confirmProjectName matches the current name');
    expect(result.structured.resend).toEqual({
      projectId: 'proj_api7f2',
      confirmProjectName: 'api',
      force: false,
      dryRun: false,
    });
    expect(harness.callsTo(RPC.getProject)[0]?.body).toEqual({ projectId: 'proj_api7f2' });
    expect(harness.callsTo(RPC.listBuilds)[0]?.body).toEqual({ projectId: 'proj_api7f2', pageSize: 100 });
    expect(writeCalls(harness)).toEqual([]);
  });

  it('says when the build count is a lower bound and when there are no builds', async () => {
    harness = await open(
      {
        ...PROJECT_ROUTES,
        [RPC.listBuilds]: [
          ok({ ...fixture('builds-list'), nextPageToken: 'more' }),
          ok({ builds: [] }),
        ],
      },
      both,
    );

    const paged = await callTool(harness, 'depot_delete_project', { projectId: 'proj_api7f2', confirmProjectName: 'api' });
    expect(record(paged.structured.preview).buildCountComplete).toBe(false);
    expect(paged.text).toContain('Builds: 3 or more (only the newest page was counted)');

    const empty = await callTool(harness, 'depot_delete_project', { projectId: 'proj_api7f2', confirmProjectName: 'api' });
    expect(record(empty.structured.preview)).toMatchObject({ buildCount: 0, recentBuild: false });
    expect(record(empty.structured.preview).lastBuildAt).toBeUndefined();
    expect(empty.text).toContain('Builds: none recorded.');
  });

  it('refuses a confirmProjectName that is not the current name, on a dry run and on apply', async () => {
    harness = await open(DELETE_ROUTES, both);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const dry = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'API',
    });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.structured.applied).toBe(false);
    expect(record(dry.structured.preview).nameMatches).toBe(false);
    expect(dry.structured.refusal).toContain('confirmProjectName "API" is not this project\'s current name');
    expect(dry.text).toContain('confirmProjectName does NOT match the current name');

    const applied = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'web',
      dryRun: false,
    });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain('Refused depot_delete_project before calling Depot: confirmProjectName "web"');
    expect(writeCalls(harness)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('refuses a project Depot returned without a name, whatever was typed', async () => {
    harness = await open({ [RPC.getProject]: ok({ project: { projectId: 'proj_anon' } }), [RPC.listBuilds]: ok({}) }, both);

    const result = await callTool(harness, 'depot_delete_project', { projectId: 'proj_anon', confirmProjectName: '' });

    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);

    const named = await callTool(harness, 'depot_delete_project', { projectId: 'proj_anon', confirmProjectName: 'unnamed' });
    expect(named.isError, named.text).toBe(false);
    expect(named.structured.refusal).toContain('is not this project\'s current name');
  });

  it('refuses a project with a build in the last 24 hours unless force is true', async () => {
    harness = await open({ ...recentBuilds(), [RPC.deleteProject]: ok({}) }, both);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const refused = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'api',
      dryRun: false,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('a build ran 1 hour(s) ago, within the last 24 hours');
    expect(refused.text).toContain('Pass force:true');
    expect(writeCalls(harness)).toEqual([]);

    const preview = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'api',
      force: true,
    });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.structured.refusal).toBeUndefined();
    expect(record(preview.structured.preview)).toMatchObject({ recentBuild: true, hoursSinceLastBuild: 1 });

    const forced = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'api',
      force: true,
      dryRun: false,
    });
    expect(forced.isError, forced.text).toBe(false);
    expect(writeCalls(harness)).toEqual([RPC.deleteProject]);
  });

  it('applies with the project id alone, as DeleteProjectRequest is, and logs one audit line', async () => {
    harness = await open({ ...DELETE_ROUTES, [RPC.deleteProject]: ok({}) }, both);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'api',
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(harness.callsTo(RPC.deleteProject)[0]?.body).toEqual({ projectId: 'proj_api7f2' });
    expect(writeCalls(harness)).toEqual([RPC.deleteProject]);
    expect(result.structured.after).toEqual({ projectId: 'proj_api7f2', name: 'api', responseKeys: [] });
    expect(record(record(result.structured.before).project).name).toBe('api');
    expect(result.text).toContain('APPLIED depot_delete_project');
    expect(result.text).toContain('DeleteProject accepted for proj_api7f2 ("api")');
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /^\[depot-mcp write\] depot_delete_project projectId=proj_api7f2 confirmProjectName=api \d{4}-/,
    );
  });

  it('re-reads before applying, so a rename between preview and apply is refused', async () => {
    harness = await open(
      {
        [RPC.getProject]: [ok(fixture('project')), ok({ project: { projectId: 'proj_api7f2', name: 'api-renamed' } })],
        [RPC.listBuilds]: ok({}),
        [RPC.deleteProject]: ok({}),
      },
      both,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const preview = await callTool(harness, 'depot_delete_project', { projectId: 'proj_api7f2', confirmProjectName: 'api' });
    expect(preview.structured.refusal).toBeUndefined();

    const applied = await callTool(harness, 'depot_delete_project', {
      projectId: 'proj_api7f2',
      confirmProjectName: 'api',
      dryRun: false,
    });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain('Refused depot_delete_project before calling Depot');
    expect(writeCalls(harness)).toEqual([]);
  });

  it('surfaces a Depot error from the reads rather than treating the project as gone', async () => {
    harness = await open({ [RPC.getProject]: connectError(404, 'not_found', 'no such project'), [RPC.listBuilds]: ok({}) }, both);

    const result = await callTool(harness, 'depot_delete_project', { projectId: 'proj_nope', confirmProjectName: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(writeCalls(harness)).toEqual([]);
  });
});
