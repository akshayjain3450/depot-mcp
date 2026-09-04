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

describe('depot_list_projects', () => {
  it('decodes hardware from both the symbolic and numeric encodings', async () => {
    harness = await createHarness({ routes: { [RPC.listProjects]: ok(fixture('projects')) } });

    const result = await callTool(harness, 'depot_list_projects', {});
    const projects = records(result.structured.projects);

    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({ name: 'api', regionId: 'us-east-1', hardware: '16x32' });
    expect(projects[1]).toMatchObject({ name: 'web', hardware: '32x64' });
    expect(asRecord(projects[0]?.cachePolicy)).toMatchObject({ keepDays: 14, keepGb: 50 });
    expect(result.text).toContain('cache keeps 50 GB / 14 days');
  });

  it('explains an empty project list', async () => {
    harness = await createHarness({ routes: { [RPC.listProjects]: ok({}) } });

    const result = await callTool(harness, 'depot_list_projects', {});

    expect(result.structured.returned).toBe(0);
    expect(result.text).toContain('depot_whoami');
  });
});

describe('depot_get_project', () => {
  it('returns configuration alongside OIDC trust policies', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok({
          project: {
            projectId: 'proj_api7f2',
            name: 'api',
            regionId: 'us-east-1',
            hardware: 'HARDWARE_16X32',
            organizationId: 'org_1a2b3c',
            cachePolicy: { keepDays: 14, keepGb: 50 },
          },
        }),
        [RPC.listTrustPolicies]: ok({
          trustPolicies: [
            { trustPolicyId: 'tp_1', github: { org: 'acme', repository: 'api' } },
            { trustPolicyId: 'tp_2', buildkite: { organizationSlug: 'acme', pipelineSlug: 'api' } },
          ],
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_project', { projectId: 'proj_api7f2' });
    const policies = records(result.structured.trustPolicies);

    expect(asRecord(result.structured.project).name).toBe('api');
    expect(policies).toHaveLength(2);
    expect(policies[0]).toMatchObject({ trustPolicyId: 'tp_1', provider: 'github' });
    expect(asRecord(policies[0]?.detail)).toMatchObject({ org: 'acme', repository: 'api' });
    expect(result.text).toContain('github');
  });

  it('says plainly when there are no trust policies', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProject]: ok({ project: { projectId: 'proj_api7f2', name: 'api' } }),
        [RPC.listTrustPolicies]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_get_project', { projectId: 'proj_api7f2' });

    expect(records(result.structured.trustPolicies)).toHaveLength(0);
    expect(result.text).toContain('must authenticate with a token');
  });
});

describe('depot_get_usage', () => {
  it('breaks down spend drivers and cache savings', async () => {
    harness = await createHarness({ routes: { [RPC.getUsage]: ok(fixture('usage')) } });

    const result = await callTool(harness, 'depot_get_usage', {});

    expect(result.structured.scope).toBe('organization');
    expect(result.structured.periodStart).toBe('2026-08-05T00:00:00Z');
    expect(records(result.structured.containerBuild)[0]).toMatchObject({
      label: 'api',
      minutesSaved: 3820,
      minutesBilled: 640,
    });
    const runners = records(result.structured.githubActionsJobs);
    expect(runners[0]?.repo).toBe('acme/api');
    expect(records(runners[0]?.jobs)).toHaveLength(2);
    expect(records(result.structured.storage)).toHaveLength(2);
    expect(result.text).toContain('3820 min saved by cache');
    expect(result.text).toContain('depot-ubuntu-24.04-8');
  });

  it('defaults to a 30 day window and sends RFC 3339 timestamps', async () => {
    harness = await createHarness({ routes: { [RPC.getUsage]: ok(fixture('usage')) } });

    await callTool(harness, 'depot_get_usage', {});
    const body = harness.callsTo(RPC.getUsage)[0]?.body ?? {};

    expect(String(body.startAt)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(String(body.endAt)).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    const span = Date.parse(String(body.endAt)) - Date.parse(String(body.startAt));
    expect(Math.round(span / 86_400_000)).toBe(30);
  });

  it('normalises a plain date and scopes to one project', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getProjectUsage]: ok({
          projectId: 'proj_api7f2',
          buildCount: 412,
          buildDurationSeconds: 38_400,
          layerCacheSizeGb: 42,
        }),
      },
    });

    const result = await callTool(harness, 'depot_get_usage', {
      projectId: 'proj_api7f2',
      startAt: '2026-08-01',
      endAt: '2026-09-01',
    });

    expect(harness.callsTo(RPC.getProjectUsage)[0]?.body).toEqual({
      projectId: 'proj_api7f2',
      startAt: '2026-08-01T00:00:00.000Z',
      endAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.structured.scope).toBe('project proj_api7f2');
    expect(asRecord(result.structured.projectUsage).layerCacheSizeGb).toBe(42);
  });

  it('rejects a half-specified window and an unparseable date', async () => {
    harness = await createHarness({ routes: { [RPC.getUsage]: ok(fixture('usage')) } });

    const halfWindow = await callTool(harness, 'depot_get_usage', { startAt: '2026-08-01' });
    expect(halfWindow.isError).toBe(true);
    expect(halfWindow.text).toContain('both startAt and endAt');

    const badDate = await callTool(harness, 'depot_get_usage', {
      startAt: 'last tuesday',
      endAt: '2026-09-01',
    });
    expect(badDate.isError).toBe(true);
    expect(badDate.text).toContain('RFC 3339');
  });
});

describe('depot_list_images', () => {
  it('lists registry images with digests', async () => {
    harness = await createHarness({ routes: { [RPC.listImages]: ok(fixture('images')) } });

    const result = await callTool(harness, 'depot_list_images', { projectId: 'proj_api7f2' });
    const images = records(result.structured.images);

    expect(images).toHaveLength(2);
    expect(images[0]?.sizeBytes).toBe(184_320_000);
    expect(result.text).toContain('175.8 MiB');
    expect(result.text).toContain('sha256:8f21c0b6');
  });

  it('requires a project', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_list_images', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('DEPOT_PROJECT_ID');
  });
});
