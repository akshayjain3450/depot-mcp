import { afterEach, describe, expect, it } from 'vitest';
import { decodeManifest } from '../../src/tools/registry-beta.js';
import { parseSandbox, toWireSandboxStatus } from '../../src/tools/sandboxes.js';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
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

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function betaHarness(routes: StubRoutes): Promise<Harness> {
  return createHarness({ routes, config: { enableBeta: true } });
}

// The secret planted in the sandboxes fixture's env map; it must never reach the model.
const PLANTED_ENV_VALUE = 'sk-live-do-not-return-me';

describe('registration gate', () => {
  it('hides every beta tool unless DEPOT_MCP_ENABLE_BETA is set', async () => {
    harness = await createHarness({ routes: {} });
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).not.toContain('depot_list_sandboxes');
    expect(names).not.toContain('depot_get_registry_image');

    const outcome = await harness.client
      .callTool({ name: 'depot_list_sandboxes', arguments: {} })
      .then(
        (result) => result.isError === true,
        () => true,
      );
    expect(outcome).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('registers the four beta tools, read-only, when the flag is on', async () => {
    harness = await betaHarness({});
    const { tools } = await harness.client.listTools();
    const beta = tools.filter((tool) => /sandbox|registry/.test(tool.name));

    expect(beta.map((tool) => tool.name).sort()).toEqual([
      'depot_get_registry_image',
      'depot_get_sandbox',
      'depot_list_registry_repositories',
      'depot_list_sandboxes',
    ]);
    for (const tool of beta) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.description ?? '', tool.name).toMatch(/beta/i);
      expect(tool.description ?? '', tool.name).toMatch(/may change/i);
      expect(tool.description ?? '', tool.name).toContain('DEPOT_MCP_ENABLE_BETA');
    }
  });
});

describe('depot_list_sandboxes', () => {
  it('sends the filter in the proto shape and summarises each sandbox', async () => {
    harness = await betaHarness({ [RPC.listSandboxes]: ok(fixture('sandboxes')) });

    const result = await callTool(harness, 'depot_list_sandboxes', {
      states: ['running', 'failed'],
      createdAfter: '2026-09-01',
      limit: 10,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.listSandboxes)[0]?.body).toEqual({
      pageSize: 10,
      filter: {
        states: ['SANDBOX_STATUS_RUNNING', 'SANDBOX_STATUS_FAILED'],
        createdAfter: '2026-09-01T00:00:00.000Z',
      },
    });

    const sandboxes = records(result.structured.sandboxes);
    expect(sandboxes).toHaveLength(3);
    expect(sandboxes[0]).toMatchObject({
      sandboxId: 'sbx_01j9k2m3n4p5q6r7s8t9',
      name: 'pr-4821-review',
      status: 'running',
      envNames: ['NODE_ENV', 'OPENAI_API_KEY'],
    });
    expect(asRecord(sandboxes[0]?.resources)).toEqual({ vcpus: 4, memoryMb: 8192, diskGb: 40 });
    expect(sandboxes[1]).toMatchObject({
      status: 'failed',
      exitCode: 137,
      errorMessage: 'container killed: out of memory',
      activeCpuUsageMs: 31250,
    });
    expect(asRecord(sandboxes[1]?.networkUsage)).toEqual({ ingressBytes: 48213, egressBytes: 1024 });
    expect(result.structured.nextPageToken).toBe('eyJvZmZzZXQiOjN9');
    expect(result.structured.beta).toBe(true);
    expect(result.text).toContain('pr-4821-review');
    expect(result.text).toContain('running');
    expect(result.text).toContain('error: container killed: out of memory');
    expect(result.text).toContain('re-call with pageToken="eyJvZmZzZXQiOjN9"');
    expect(result.text).toMatch(/beta api/i);
  });

  it('never returns environment variable values, only names', async () => {
    harness = await betaHarness({ [RPC.listSandboxes]: ok(fixture('sandboxes')) });

    const result = await callTool(harness, 'depot_list_sandboxes', {});

    expect(result.text).not.toContain(PLANTED_ENV_VALUE);
    expect(JSON.stringify(result.structured)).not.toContain(PLANTED_ENV_VALUE);
  });

  it('omits the filter entirely when nothing narrows the list, and forwards the page token', async () => {
    harness = await betaHarness({ [RPC.listSandboxes]: ok({}) });

    const result = await callTool(harness, 'depot_list_sandboxes', { pageToken: 'next-1' });

    expect(harness.callsTo(RPC.listSandboxes)[0]?.body).toEqual({ pageSize: 25, pageToken: 'next-1' });
    expect(result.isError).toBe(false);
    expect(result.structured.returned).toBe(0);
    expect(result.structured.sandboxes).toEqual([]);
    expect(result.text).toContain('No sandboxes are visible');
  });

  it('says when a filtered list is empty rather than blaming the token', async () => {
    harness = await betaHarness({ [RPC.listSandboxes]: ok({}) });

    const result = await callTool(harness, 'depot_list_sandboxes', { states: ['running'] });

    expect(result.text).toContain('No sandboxes match the filter.');
  });

  it('rejects an unknown state before any request and a bad date with the field name', async () => {
    harness = await betaHarness({ [RPC.listSandboxes]: ok({}) });

    const badState = await callTool(harness, 'depot_list_sandboxes', { states: ['exploded'] });
    expect(badState.isError).toBe(true);

    const badDate = await callTool(harness, 'depot_list_sandboxes', { createdBefore: 'yesterday' });
    expect(badDate.isError).toBe(true);
    expect(badDate.text).toContain('createdBefore');

    expect(harness.calls).toHaveLength(0);
  });

  it('reads a numeric status encoding through the proto table', () => {
    expect(parseSandbox({ sandboxId: 'sbx_n', status: 4 }).status).toBe('running');
    expect(parseSandbox({ sandboxId: 'sbx_n', status: 7 }).status).toBe('failed');
    expect(parseSandbox({ sandbox: { sandboxId: 'sbx_w', status: 'SANDBOX_STATUS_STARTING' } })).toMatchObject({
      sandboxId: 'sbx_w',
      status: 'starting',
    });
    expect(toWireSandboxStatus('cancelled')).toBe('SANDBOX_STATUS_CANCELLED');
  });
});

describe('depot_get_sandbox', () => {
  it('asks for the sandbox by SandboxRef id and reports the terminal facts', async () => {
    harness = await betaHarness({ [RPC.getSandbox]: ok(fixture('sandbox')) });

    const result = await callTool(harness, 'depot_get_sandbox', { sandboxId: ' sbx_01j9hzzz0a1b2c3d4e5f ' });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getSandbox)[0]?.body).toEqual({ id: 'sbx_01j9hzzz0a1b2c3d4e5f' });
    expect(asRecord(result.structured.sandbox)).toMatchObject({
      sandboxId: 'sbx_01j9hzzz0a1b2c3d4e5f',
      status: 'failed',
      exitCode: 137,
      stoppedAt: '2026-09-05T22:41:30Z',
      envNames: [],
    });
    expect(result.text).toContain('exit 137');
    expect(result.text).toContain('Error: container killed: out of memory');
    expect(result.text).toContain('Active CPU time: 31.3s');
    expect(result.text).toContain('48213 bytes in, 1024 bytes out');
    expect(result.text).toContain('Environment variables: none');
  });

  it('lists environment variable names but withholds values', async () => {
    harness = await betaHarness({
      [RPC.getSandbox]: ok({
        sandbox: {
          sandboxId: 'sbx_env',
          status: 'SANDBOX_STATUS_RUNNING',
          env: { TOKEN: PLANTED_ENV_VALUE, A: '1' },
        },
      }),
    });

    const result = await callTool(harness, 'depot_get_sandbox', { sandboxId: 'sbx_env' });

    expect(asRecord(result.structured.sandbox).envNames).toEqual(['A', 'TOKEN']);
    expect(result.text).toContain('values withheld): A, TOKEN');
    expect(result.text).not.toContain(PLANTED_ENV_VALUE);
    expect(JSON.stringify(result.structured)).not.toContain(PLANTED_ENV_VALUE);
  });

  it('passes Depot\'s not_found through as a tool error', async () => {
    harness = await betaHarness({
      [RPC.getSandbox]: connectError(404, 'not_found', 'Sandbox nope not found'),
    });

    const result = await callTool(harness, 'depot_get_sandbox', { sandboxId: 'nope' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
  });

  it('requires a non-blank sandboxId', async () => {
    harness = await betaHarness({});

    const result = await callTool(harness, 'depot_get_sandbox', { sandboxId: '   ' });

    expect(result.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });
});

describe('depot_list_registry_repositories', () => {
  it('pages by number and attaches a retention policy per repository', async () => {
    harness = await betaHarness({
      [RPC.listRegistryRepositories]: ok(fixture('registry-repositories')),
      [RPC.getRegistryRetentionPolicy]: [
        ok(fixture('registry-retention-policy')),
        ok({}),
        connectError(403, 'permission_denied', 'no access to retention'),
      ],
    });

    const result = await callTool(harness, 'depot_list_registry_repositories', {
      query: 'acme',
      page: 1,
      limit: 25,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.listRegistryRepositories)[0]?.body).toEqual({
      page: 1,
      pageSize: 25,
      query: 'acme',
    });
    const policyCalls = harness.callsTo(RPC.getRegistryRetentionPolicy);
    expect(policyCalls.map((call) => call.body)).toEqual([
      { repository: 'acme/api' },
      { repository: 'acme/web' },
      { repository: 'acme/scratch' },
    ]);

    const repositories = records(result.structured.repositories);
    expect(repositories).toHaveLength(3);
    expect(repositories[0]).toMatchObject({ name: 'acme/api', tagCount: 14, sizeBytes: 2147483648 });
    expect(asRecord(repositories[0]?.retentionPolicy)).toEqual({
      enabled: true,
      keepCount: 20,
      keepDays: 30,
      updatedAt: '2026-08-15T11:11:11Z',
    });
    expect(repositories[1]?.retentionPolicy).toBeUndefined();
    expect(repositories[1]?.retentionPolicyError).toBeUndefined();
    expect(repositories[2]?.retentionPolicy).toBeUndefined();
    expect(String(repositories[2]?.retentionPolicyError)).toContain('permission_denied');
    expect(result.structured).toMatchObject({ page: 1, pageSize: 25, hasMore: false, returned: 3, beta: true });
    expect(result.text).toContain('acme/api: 14 tag(s) · 2048.0 MiB · last push 2026-09-06T07:55:12Z · retention: keep 20 newest, keep 30 days');
    expect(result.text).toContain('acme/web: 3 tag(s) · 700.0 MiB · last push 2026-08-30T16:20:41Z · no retention policy');
    expect(result.text).toContain('acme/scratch: 0 tag(s) · 0.0 KiB · last push never · retention policy unavailable');
  });

  it('skips the retention calls when asked, and points at the next page', async () => {
    harness = await betaHarness({
      [RPC.listRegistryRepositories]: ok({ ...fixture('registry-repositories'), page: 2, hasMore: true }),
    });

    const result = await callTool(harness, 'depot_list_registry_repositories', {
      page: 2,
      withRetentionPolicy: false,
    });

    expect(harness.callsTo(RPC.getRegistryRetentionPolicy)).toHaveLength(0);
    expect(result.structured.hasMore).toBe(true);
    expect(result.text).toContain('re-call with page=3');
    expect(result.text).not.toContain('retention');
  });

  it('tolerates the empty response Depot gives a fresh organization', async () => {
    harness = await betaHarness({ [RPC.listRegistryRepositories]: ok({ page: 1, pageSize: 25 }) });

    const result = await callTool(harness, 'depot_list_registry_repositories', {});

    expect(result.isError).toBe(false);
    expect(result.structured).toMatchObject({ repositories: [], returned: 0, page: 1, hasMore: false });
    expect(result.text).toContain('No repositories exist');
    expect(harness.callsTo(RPC.getRegistryRetentionPolicy)).toHaveLength(0);
  });

  it('reads a disabled policy as disabled rather than absent', async () => {
    harness = await betaHarness({
      [RPC.listRegistryRepositories]: ok({ repositories: [{ name: 'acme/api' }], page: 1 }),
      [RPC.getRegistryRetentionPolicy]: ok({ policy: { repository: 'acme/api', enabled: false } }),
    });

    const result = await callTool(harness, 'depot_list_registry_repositories', {});

    expect(asRecord(records(result.structured.repositories)[0]?.retentionPolicy)).toMatchObject({ enabled: false });
    expect(result.text).toContain('retention policy disabled');
  });
});

describe('depot_get_registry_image', () => {
  it('looks a tag up as a reference and summarises a multi-platform index manifest', async () => {
    harness = await betaHarness({ [RPC.getRegistryImageDetail]: ok(fixture('registry-image-detail')) });

    const result = await callTool(harness, 'depot_get_registry_image', { repository: 'acme/api', tag: 'main' });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getRegistryImageDetail)[0]?.body).toEqual({
      repository: 'acme/api',
      reference: 'main',
    });
    expect(result.structured).toMatchObject({
      repository: 'acme/api',
      reference: 'main',
      digest: 'sha256:8f21c0b6a4d95e37f0182c4b9ae6d5f3c2b1a0998877665544332211aabbccdd',
      sizeBytes: 184320000,
      tags: ['main', 'v1.4.0'],
      pushedAt: '2026-09-06T07:55:12Z',
      manifestKind: 'index',
      beta: true,
    });
    const platforms = records(result.structured.platforms);
    expect(platforms).toHaveLength(3);
    expect(platforms[0]).toMatchObject({ os: 'linux', architecture: 'amd64', sizeBytes: 1234 });
    expect(platforms[1]).toMatchObject({ os: 'linux', architecture: 'arm64', variant: 'v8' });
    expect(asRecord(result.structured.annotations)).toMatchObject({
      'org.opencontainers.image.source': 'https://github.com/acme/api',
    });
    expect(result.text).toContain('multi-platform index, 3 platforms');
    expect(result.text).toContain('linux/amd64');
    expect(result.text).toContain('linux/arm64/v8');
    expect(result.text).toContain('Tags: main, v1.4.0');
    expect(result.text).toContain('untrusted');
  });

  it('looks a digest up and summarises a single-platform manifest by layers', async () => {
    harness = await betaHarness({
      [RPC.getRegistryImageDetail]: ok(fixture('registry-image-detail-single')),
    });
    const digest = 'sha256:1122334455667788990011223344556677889900aabbccddeeff001122334455';

    const result = await callTool(harness, 'depot_get_registry_image', { repository: 'acme/web', digest });

    expect(harness.callsTo(RPC.getRegistryImageDetail)[0]?.body).toEqual({
      repository: 'acme/web',
      reference: digest,
    });
    expect(result.structured).toMatchObject({
      manifestKind: 'manifest',
      layerCount: 3,
      layersSizeBytes: 32654 + 16724 + 73109,
      configDigest: `sha256:cfg0${'0'.repeat(60)}`,
      platforms: [],
      tags: [],
    });
    expect(result.text).toContain('single-platform image, 3 layers');
    expect(result.text).toContain('Tags: none (untagged image)');
    expect(result.text).toContain('config blob');
  });

  it('refuses both, neither, and a digest that is not a digest, without calling Depot', async () => {
    harness = await betaHarness({});

    const both = await callTool(harness, 'depot_get_registry_image', { repository: 'r', tag: 't', digest: 'sha256:' + 'a'.repeat(64) });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('not both');

    const neither = await callTool(harness, 'depot_get_registry_image', { repository: 'r' });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain('tag or a digest');

    const bad = await callTool(harness, 'depot_get_registry_image', { repository: 'r', digest: 'latest' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('sha256:<hex>');

    expect(harness.calls).toHaveLength(0);
  });

  it('reports a manifest it cannot parse instead of failing', async () => {
    harness = await betaHarness({
      [RPC.getRegistryImageDetail]: ok({
        digest: 'sha256:' + 'd'.repeat(64),
        tags: ['odd'],
        manifest: Buffer.from('not json at all').toString('base64'),
      }),
    });

    const result = await callTool(harness, 'depot_get_registry_image', { repository: 'acme/api', tag: 'odd' });

    expect(result.isError).toBe(false);
    expect(result.structured.manifestKind).toBe('unknown');
    expect(result.structured.manifestParseError).toContain('not JSON');
    expect(result.text).toContain('could not be summarised');
  });

  it('passes Depot\'s not_found for an unknown reference through as a tool error', async () => {
    harness = await betaHarness({
      [RPC.getRegistryImageDetail]: connectError(404, 'not_found', 'image "latest" not found'),
    });

    const result = await callTool(harness, 'depot_get_registry_image', { repository: 'acme/api', tag: 'latest' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
  });
});

describe('decodeManifest', () => {
  it('treats a missing manifest as absent', () => {
    expect(decodeManifest(undefined).kind).toBe('absent');
    expect(decodeManifest('').kind).toBe('absent');
  });

  it('accepts an already-parsed object and JSON text as well as base64', () => {
    const index = { mediaType: 'application/vnd.docker.distribution.manifest.list.v2+json', manifests: [] };
    expect(decodeManifest(index).kind).toBe('index');
    expect(decodeManifest(JSON.stringify(index)).kind).toBe('index');
    expect(decodeManifest(Buffer.from(JSON.stringify(index)).toString('base64')).kind).toBe('index');
  });

  it('caps annotations and flags a shape with neither manifests nor layers', () => {
    const annotations: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) {
      annotations[`k${i}`] = 'v'.repeat(300);
    }
    const decoded = decodeManifest({ schemaVersion: 2, annotations });

    expect(decoded.kind).toBe('unknown');
    expect(Object.keys(decoded.annotations)).toHaveLength(20);
    expect(decoded.annotations.k0?.length).toBe(201);
  });
});
