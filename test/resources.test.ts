import { afterEach, describe, expect, it } from 'vitest';
import { RESOURCE_URIS } from '../src/resources.js';
import { createHarness, fixture, NOT_FOUND, ok, type Harness } from './helpers/harness.js';

const RPC = {
  listRuns: 'depot.ci.v1.CIService/ListRuns',
  getRunStatus: 'depot.ci.v1.CIService/GetRunStatus',
  listBuilds: 'depot.core.v1.BuildService/ListBuilds',
  listProjects: 'depot.core.v1.ProjectService/ListProjects',
} as const;

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function readText(uri: string): Promise<string> {
  if (harness === undefined) {
    throw new Error('harness not created');
  }
  const result = await harness.client.readResource({ uri });
  expect(result.contents).toHaveLength(1);
  const [content] = result.contents;
  expect(content?.uri).toBe(uri);
  expect(content?.mimeType).toBe('text/plain');
  return content !== undefined && 'text' in content ? content.text : '';
}

describe('resources/list and resources/templates/list', () => {
  it('lists the two fixed resources with titles, descriptions and a text mime type', async () => {
    harness = await createHarness({ routes: {} });
    const { resources } = await harness.client.listResources();

    expect(resources.map((resource) => resource.uri).sort()).toEqual(
      [RESOURCE_URIS.failedRuns, RESOURCE_URIS.projects].sort(),
    );
    for (const resource of resources) {
      expect(resource.name, resource.uri).not.toHaveLength(0);
      expect(resource.title ?? '', resource.uri).not.toHaveLength(0);
      expect(resource.description ?? '', resource.uri).not.toHaveLength(0);
      expect(resource.mimeType, resource.uri).toBe('text/plain');
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('lists the two templates without any list callback having hit Depot', async () => {
    harness = await createHarness({ routes: {} });
    const { resourceTemplates } = await harness.client.listResourceTemplates();

    expect(resourceTemplates.map((template) => template.uriTemplate).sort()).toEqual(
      [RESOURCE_URIS.run, RESOURCE_URIS.projectBuilds].sort(),
    );
    for (const template of resourceTemplates) {
      expect(template.name, template.uriTemplate).not.toHaveLength(0);
      expect(template.title ?? '', template.uriTemplate).not.toHaveLength(0);
      expect(template.description ?? '', template.uriTemplate).not.toHaveLength(0);
      expect(template.mimeType, template.uriTemplate).toBe('text/plain');
    }
    expect(harness.calls).toHaveLength(0);
  });
});

describe('resources/read', () => {
  it('depot://ci/run/{runId} renders the run tree from GetRunStatus alone', async () => {
    harness = await createHarness({
      routes: { [RPC.getRunStatus]: ok(fixture('run-status')) },
    });

    const text = await readText('depot://ci/run/run_7f3d9c21');

    expect(text).toContain('Run run_7f3d9c21 — failed, 3 job(s), 1 failed.');
    expect(text).toContain('workflow "CI" — failed (workflowId=wf_2b8e11)');
    expect(text).toContain('test (node 18) — failed (jobId=job_4d0a77)');
    expect(text).toContain('attempt 2 — failed (attemptId=att_91bc02)');
    expect(text).toContain('depot_diagnose_ci_failure {"id":"run_7f3d9c21"}');
    expect(harness.calls.map((call) => call.rpc)).toEqual([RPC.getRunStatus]);
    expect(harness.calls[0]?.body).toEqual({ runId: 'run_7f3d9c21' });
  });

  it('depot://ci/runs/failed lists the last 20 failed runs, newest first', async () => {
    harness = await createHarness({ routes: { [RPC.listRuns]: ok(fixture('list-runs')) } });

    const text = await readText(RESOURCE_URIS.failedRuns);

    expect(text).toContain('3 most recent failed Depot CI run(s), newest first:');
    expect(text).toContain('run_7f3d9c21 — failed · acme/api · 9c1f4ab7 · refs/heads/main · via push');
    expect(text).toContain('depot_diagnose_ci_failure {"id":"run_7f3d9c21"}');
    expect(text).toContain('Only the newest 20 are shown');
    expect(harness.calls[0]?.body).toEqual({ status: ['failed'], pageSize: 20 });
  });

  it('depot://ci/runs/failed explains an empty list', async () => {
    harness = await createHarness({
      routes: { [RPC.listRuns]: ok(fixture('list-runs-empty')) },
    });

    const text = await readText(RESOURCE_URIS.failedRuns);

    expect(text).toContain('No failed Depot CI runs.');
    expect(text).toContain('DEPOT_ORG_ID');
  });

  it('depot://project/{projectId}/builds lists builds with cache ratios', async () => {
    harness = await createHarness({
      routes: { [RPC.listBuilds]: ok(fixture('builds-list')) },
    });

    const text = await readText('depot://project/proj_api7f2/builds');

    expect(text).toContain('3 most recent container build(s) for project proj_api7f2, newest first:');
    expect(text).toContain('bld_4a91c7 — failed · 3m15s · 11/14 cached (79%), saved 6m52s');
    expect(text).toContain('bld_2c11de — success · 10m11s · 0/14 cached (0%), saved 0s');
    expect(text).toContain('"projectId":"proj_api7f2"');
    expect(harness.calls[0]?.body).toEqual({ projectId: 'proj_api7f2', pageSize: 20 });
  });

  it('depot://projects lists projects with their cache policies', async () => {
    harness = await createHarness({
      routes: { [RPC.listProjects]: ok(fixture('projects')) },
    });

    const text = await readText(RESOURCE_URIS.projects);

    expect(text).toContain('2 Depot project(s) with cache policies:');
    expect(text).toContain('proj_api7f2 — api · us-east-1 · hardware 16x32 · cache keeps 50 GB / 14 days');
    expect(text).toContain('proj_web3c9 — web · eu-central-1 · hardware 32x64 · cache keeps 100 GB / 7 days');
    expect(text).toContain('depot://project/<projectId>/builds');
  });

  it('translates a Depot error into a readable JSON-RPC error instead of a raw throw', async () => {
    harness = await createHarness({ routes: { [RPC.getRunStatus]: NOT_FOUND } });

    const outcome = await harness.client.readResource({ uri: 'depot://ci/run/run_missing' }).then(
      () => ({ failed: false, detail: '' }),
      (error: unknown) => ({
        failed: true,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );

    expect(outcome.failed).toBe(true);
    expect(outcome.detail).toContain('depot://ci/run/run_missing');
    expect(outcome.detail).toContain('not_found');
    expect(outcome.detail).toContain('Depot has no such record');
    expect(outcome.detail).not.toContain('DepotApiError');
  });

  it('rejects a URI variable that is not a Depot id before calling Depot', async () => {
    harness = await createHarness({ routes: {} });

    await expect(
      harness.client.readResource({ uri: 'depot://project/proj%20x%22/builds' }),
    ).rejects.toThrow(/projectId/);
    expect(harness.calls).toHaveLength(0);
  });

  it('rejects an unknown depot:// URI', async () => {
    harness = await createHarness({ routes: {} });

    await expect(harness.client.readResource({ uri: 'depot://ci/nope' })).rejects.toThrow(
      /not found/i,
    );
    expect(harness.calls).toHaveLength(0);
  });

  it('bounds every resource to the configured character budget', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getRunStatus]: ok(fixture('run-status')),
        [RPC.listRuns]: ok(fixture('list-runs')),
        [RPC.listBuilds]: ok(fixture('builds-list')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
      config: { outputCharBudget: 160 },
    });

    for (const uri of [
      'depot://ci/run/run_7f3d9c21',
      RESOURCE_URIS.failedRuns,
      'depot://project/proj_api7f2/builds',
      RESOURCE_URIS.projects,
    ]) {
      const text = await readText(uri);
      expect(text, uri).toContain("[output truncated to stay within this server's 160-character budget]");
      const body = text.split('\n[output truncated')[0] ?? '';
      expect(body.length, uri).toBeLessThanOrEqual(160);
    }
  });
});
