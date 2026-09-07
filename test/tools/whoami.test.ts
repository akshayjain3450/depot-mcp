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
    expect(result.structured.betaEnabled).toBe(false);
    expect(result.structured.betaTools).toEqual([]);
    expect(result.text).toContain('Beta tools: not registered');
    expect(result.text).toContain('DEPOT_MCP_ENABLE_BETA');
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

  it('recognises an Organization token: organizations 401, projects fine', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: connectError(401, 'unauthenticated', 'Invalid token'),
        [RPC.listProjects]: ok(fixture('projects')),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    const failures = Array.isArray(result.structured.failures) ? result.structured.failures : [];

    expect(result.isError).toBe(false);
    expect(result.structured.tokenKind).toBe('organization');
    expect(failures).toHaveLength(0);
    expect(result.structured.activeOrgId).toBe('org_1a2b3c');
    expect(result.text).toContain('Kind: Organization token');
    expect(result.text).not.toContain('Checks that failed');
    expect(result.text).not.toContain('typical of a project token');
  });

  it('asks for a project when an Organization token sees none', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: connectError(401, 'unauthenticated', 'Invalid token'),
        [RPC.listProjects]: ok({ projects: [] }),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    expect(result.structured.tokenKind).toBe('organization');
    expect(result.text).toContain('sees no projects yet');
  });

  it('explains a user token when organizations list but projects answer 401', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: connectError(401, 'unauthenticated', 'Invalid token'),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    const warnings = Array.isArray(result.structured.warnings) ? result.structured.warnings : [];

    expect(result.isError).toBe(false);
    expect(result.structured.tokenKind).toBe('user');
    expect(warnings.some((w) => String(w).includes('user token'))).toBe(true);
    expect(result.text).toContain('Organization Settings -> API Tokens');
    expect(result.text).toContain('keep working');
    expect(result.text).toContain('owner does not change this');
  });

  it('does not call a 403 on projects a user-token problem', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: connectError(403, 'permission_denied', 'nope'),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    expect(result.text).not.toContain('accept only Organization tokens');
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

  it('reports the registered write tools when DEPOT_MCP_ALLOW_WRITES is on', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
      config: { allowWrites: true },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.writesEnabled).toBe(true);
    expect(result.structured.mutatingToolsAvailable).toBe(9);
    expect(result.structured.mutatingTools).toEqual([
      'depot_cancel_ci_run',
      'depot_cancel_ci_job',
      'depot_retry_ci_failed_jobs',
      'depot_retry_ci_job',
      'depot_rerun_ci_workflow',
      'depot_dispatch_ci_workflow',
      'depot_set_ci_variable',
      'depot_delete_ci_variable',
      'depot_create_project',
    ]);
    expect(result.text).toContain('Writes: ENABLED');
    expect(result.text).toContain('9 mutating tool(s) registered: depot_cancel_ci_run');
    expect(result.structured.mutatingTools).not.toContain('depot_stop_sandbox');
    expect(result.text).toContain('dryRun:true');
    expect(JSON.stringify(result.structured.warnings)).not.toContain('no effect');
  });

  it('reports writes as disabled, with no mutating tools, when the gate is off', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.writesEnabled).toBe(false);
    expect(result.structured.mutatingToolsAvailable).toBe(0);
    expect(result.structured.mutatingTools).toEqual([]);
    expect(result.text).toContain('Writes: disabled');
    expect(result.text).not.toContain('depot_cancel_ci_run');
  });

  it('names the beta tools when DEPOT_MCP_ENABLE_BETA is set', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
      config: { enableBeta: true },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.betaEnabled).toBe(true);
    expect(result.structured.betaTools).toEqual([
      'depot_list_sandboxes',
      'depot_get_sandbox',
      'depot_list_registry_repositories',
      'depot_get_registry_image',
    ]);
    expect(result.text).toContain('Beta tools: enabled by DEPOT_MCP_ENABLE_BETA');
    expect(result.text).toContain('may change without notice');
    expect(result.structured.warnings).toEqual([]);
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

describe('depot_whoami organization ambiguity', () => {
  it('reports every visible organization and the exact count in the warning', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations-multi')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    const organizations = Array.isArray(result.structured.organizations)
      ? result.structured.organizations
      : [];
    const warnings = Array.isArray(result.structured.warnings) ? result.structured.warnings : [];

    expect(organizations).toEqual([
      { orgId: 'org_1a2b3c', name: 'Acme Engineering' },
      { orgId: 'org_9z8y7x', name: 'Acme Labs' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain('2 organizations');
    expect(result.text).not.toContain('<- active');
    expect(result.text).toContain('Warnings:');
    expect(harness.callsTo(RPC.listOrganizations)[0]?.headers['x-depot-org']).toBeUndefined();
  });

  it('marks the configured organization active and drops the warning', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations-multi')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
      config: { orgId: 'org_1a2b3c' },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.warnings).toEqual([]);
    expect(result.text).toContain('org_1a2b3c — Acme Engineering <- active');
    expect(result.text).not.toContain('org_9z8y7x — Acme Labs <- active');
    expect(harness.callsTo(RPC.listProjects)[0]?.headers['x-depot-org']).toBe('org_1a2b3c');
  });

  // DEPOT_ORG_ID is still authoritative for request scoping, but a value the token cannot see is
  // almost always a typo, so it is cross-checked against the visible list and called out.
  it('warns when DEPOT_ORG_ID names an organization the token cannot see', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations-multi')),
        [RPC.listProjects]: ok(fixture('projects')),
      },
      config: { orgId: 'org_typo' },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    const warnings = Array.isArray(result.structured.warnings) ? result.structured.warnings : [];

    expect(result.isError).toBe(false);
    expect(result.structured.activeOrgId).toBe('org_typo');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain('"org_typo"');
    expect(String(warnings[0])).toContain('cannot see that organization');
    expect(String(warnings[0])).toContain('org_1a2b3c, org_9z8y7x');
    expect(result.text).toContain('cannot see that organization');
    expect(result.text).not.toContain('<- active');
  });

  it('reads organizations under the alternative key and id spellings', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok({
          orgs: [{ organizationId: 'org_a', name: 'A' }, { id: 'org_b', name: 'B' }],
        }),
        [RPC.listProjects]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.organizations).toEqual([
      { orgId: 'org_a', name: 'A' },
      { orgId: 'org_b', name: 'B' },
    ]);
    expect(result.structured.activeOrgId).toBeUndefined();
  });

  it('reports both failures without guessing about the token when every check fails', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: connectError(401, 'unauthenticated', 'bad token'),
        [RPC.listProjects]: connectError(401, 'unauthenticated', 'bad token'),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});
    const failures = Array.isArray(result.structured.failures) ? result.structured.failures : [];

    expect(result.isError).toBe(false);
    expect(failures).toHaveLength(2);
    expect(result.structured.warnings).toEqual([]);
    expect(result.structured.projectCount).toBeUndefined();
    expect(result.structured.organizations).toEqual([]);
    expect(result.text).toContain('Organizations visible: none.');
    expect(result.text).toContain('DEPOT_TOKEN');
    expect(result.text).not.toContain(TOKEN);
  });

  it('previews at most 25 projects and says how many more exist', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listOrganizations]: ok(fixture('organizations')),
        [RPC.listProjects]: ok({
          projects: Array.from({ length: 30 }, (_, i) => ({ projectId: `proj_${i}`, name: `p${i}` })),
        }),
      },
    });

    const result = await callTool(harness, 'depot_whoami', {});

    expect(result.structured.projectCount).toBe(30);
    expect(Array.isArray(result.structured.projects) ? result.structured.projects : []).toHaveLength(25);
    expect(result.text).toContain('… 5 more; see depot_list_projects.');
  });
});
