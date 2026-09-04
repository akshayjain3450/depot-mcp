import { afterEach, describe, expect, it } from 'vitest';
import { callTool, connectError, createHarness, fixture, ok, type Harness } from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const TOKEN = 'test-token-never-logged';

describe('depot_whoami', () => {
  it('reports the visible organizations and projects', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.isError).toBe(false);
    expect(result.structured.activeOrgId).toBe('org_1a2b3c');
    expect(result.structured.orgSelection).toContain('exactly one organization');
    expect(result.structured.projectCount).toBe(2);
    expect(result.structured.writesEnabled).toBe(false);
    expect(result.structured.mutatingToolsAvailable).toBe(0);
    expect(result.text).toContain('Acme Engineering');
    expect(result.text).toContain('<- active');
  });

  it('never reveals the token', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.text).not.toContain(TOKEN);
    expect(JSON.stringify(result.structured)).not.toContain(TOKEN);
    expect(result.structured.tokenSource).toBe('DEPOT_TOKEN environment variable');
  });

  it('warns loudly when several organizations are visible and none is selected', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations-multi')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.activeOrgId).toBeUndefined();
    expect(result.structured.orgSelection).toBe('not set');
    expect(JSON.stringify(result.structured.warnings)).toContain('DEPOT_ORG_ID');
    expect(result.text).toContain('org_9z8y7x');
  });

  it('treats a configured DEPOT_ORG_ID as authoritative', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations-multi')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
      config: { orgId: 'org_9z8y7x' },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.activeOrgId).toBe('org_9z8y7x');
    expect(result.structured.orgSelection).toContain('DEPOT_ORG_ID');
    expect(harness.callsTo(RPC.listOrganizations)[0]?.headers['x-depot-org']).toBe('org_9z8y7x');
  });

  it('still reports what worked when one check fails', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: connectError(403, 'permission_denied', 'token cannot list projects'),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    const failures = Array.isArray(result.structured.failures) ? result.structured.failures : [];

    expect(result.isError).toBe(false);
    expect(result.structured.activeOrgId).toBe('org_1a2b3c');
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures)).toContain('ListProjects');
    expect(result.text).toContain('Checks that failed');
  });

  it('flags that the write gate is inert in this version', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
      config: { allowWrites: true },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.writesEnabled).toBe(true);
    expect(result.structured.mutatingToolsAvailable).toBe(0);
    expect(JSON.stringify(result.structured.warnings)).toContain('no effect');
  });

  it('explains a token that authenticates but sees nothing', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok({}),
        [RPC.listProjects]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(JSON.stringify(result.structured.warnings)).toContain('project token');
  });
});
