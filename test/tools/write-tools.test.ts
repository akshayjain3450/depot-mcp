import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
  NOT_FOUND,
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

const WRITE_RPCS: readonly string[] = [
  RPC.setVariableVariant,
  RPC.deleteVariableVariant,
  RPC.deleteVariable,
  RPC.createProject,
];

async function writable(routes: StubRoutes): Promise<Harness> {
  const created = await createHarness({ routes, config: { allowWrites: true } });
  // Priming the client-side output validators, so every structured result below is checked
  // against the advertised schema.
  await created.client.listTools();
  return created;
}

function writeCalls(from: Harness): string[] {
  return from.calls.map((call) => call.rpc).filter((rpc) => WRITE_RPCS.includes(rpc));
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function record(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

const SENTRY_TOKEN = 'sntrys_9f8e7d6c5b4a39281706f5e4d3c2b1a0';

const VARIABLE_ROUTES: StubRoutes = {
  [RPC.getVariable]: ok(fixture('variable')),
  [RPC.getSecret]: NOT_FOUND,
};

describe('gating', () => {
  it('hides every write tool unless DEPOT_MCP_ALLOW_WRITES is set, and refuses to call them', async () => {
    harness = await createHarness({ routes: VARIABLE_ROUTES });
    const { tools } = await harness.client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain('depot_set_ci_variable');
    const outcome = await harness.client
      .callTool({ name: 'depot_set_ci_variable', arguments: { name: 'X', value: 'y' } })
      .then(
        (result) => ({ failed: result.isError === true }),
        () => ({ failed: true }),
      );
    expect(outcome.failed).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('lists the write tools with dryRun defaulting to true when enabled', async () => {
    harness = await writable({});
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining(['depot_set_ci_variable', 'depot_delete_ci_variable', 'depot_create_project']),
    );
    expect(tools).toHaveLength(37);
    for (const name of ['depot_set_ci_variable', 'depot_delete_ci_variable', 'depot_create_project']) {
      const tool = tools.find((entry) => entry.name === name);
      const dryRun = record(record(tool?.inputSchema.properties).dryRun);
      expect(dryRun.default, name).toBe(true);
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      expect(tool?.annotations?.openWorldHint, name).toBe(true);
    }
  });

  it('annotates delete as destructive and create as non-idempotent, and nothing else', async () => {
    harness = await writable({});
    const { tools } = await harness.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations ?? {}]));

    expect(byName.get('depot_set_ci_variable')).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(byName.get('depot_delete_ci_variable')).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(byName.get('depot_create_project')).toMatchObject({ destructiveHint: false, idempotentHint: false });
  });
});

describe('depot_set_ci_variable', () => {
  it('previews the variant that would be overwritten and calls no write RPC by default', async () => {
    harness = await writable(VARIABLE_ROUTES);

    const result = await callTool(harness, 'depot_set_ci_variable', {
      name: 'DEPLOY_ENV',
      value: 'preprod',
      variantName: 'production',
      repository: 'acme/api',
      branch: 'main',
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(false);
    const preview = record(result.structured.preview);
    expect(preview).toMatchObject({
      name: 'DEPLOY_ENV',
      variantName: 'production',
      value: 'preprod',
      variableExists: true,
      variableId: 'var_2c9e1f',
      secretWithSameName: false,
      scope: { repository: 'acme/api', branch: 'main' },
    });
    expect(record(preview.existingVariant)).toMatchObject({
      id: 'vv_prod_02',
      name: 'production',
      value: 'production',
      attributes: { repository: 'acme/api', branch: 'main' },
    });
    expect(records(preview.otherVariants).map((variant) => variant.name)).toEqual(['default', 'release']);
    expect(result.structured.resend).toEqual({
      name: 'DEPLOY_ENV',
      value: 'preprod',
      variantName: 'production',
      repository: 'acme/api',
      branch: 'main',
      dryRun: false,
    });
    expect(result.text).toContain('nothing was changed');
    expect(result.text).toContain('variant "production" would be overwritten');
    expect(result.text).toContain('= production [id vv_prod_02]');
    expect(result.text).toContain('New value: preprod');
    expect(writeCalls(harness)).toEqual([]);
    expect(harness.callsTo(RPC.getVariable)[0]?.body).toEqual({ name: 'DEPLOY_ENV' });
    expect(harness.callsTo(RPC.getSecret)[0]?.body).toEqual({ name: 'DEPLOY_ENV' });
  });

  it('previews creating a variable Depot does not have yet', async () => {
    harness = await writable({ [RPC.getVariable]: NOT_FOUND, [RPC.getSecret]: NOT_FOUND });

    const result = await callTool(harness, 'depot_set_ci_variable', { name: 'NEW_FLAG', value: 'on' });

    expect(result.isError, result.text).toBe(false);
    expect(record(result.structured.preview)).toMatchObject({
      variableExists: false,
      variantName: 'default',
      scope: {},
      otherVariants: [],
    });
    expect(result.text).toContain('No CI variable named NEW_FLAG exists; this would create it');
  });

  it('applies with the field names from the v3beta2 bindings and logs one audit line', async () => {
    harness = await writable({
      ...VARIABLE_ROUTES,
      [RPC.setVariableVariant]: ok({
        variable: { id: 'var_2c9e1f', name: 'DEPLOY_ENV' },
        variant: { id: 'vv_prod_02', name: 'production', value: 'preprod' },
        createdVariable: false,
        createdVariant: false,
      }),
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_set_ci_variable', {
      name: 'DEPLOY_ENV',
      value: 'preprod',
      variantName: 'production',
      description: 'Pre-production',
      repository: 'acme/api',
      branch: 'main',
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(result.structured.after).toEqual({
      variableId: 'var_2c9e1f',
      variantId: 'vv_prod_02',
      createdVariable: false,
      createdVariant: false,
    });
    expect(record(result.structured.before).variableId).toBe('var_2c9e1f');
    expect(writeCalls(harness)).toEqual([RPC.setVariableVariant]);
    expect(harness.callsTo(RPC.setVariableVariant)[0]?.body).toEqual({
      variableName: 'DEPLOY_ENV',
      variantName: 'production',
      value: 'preprod',
      description: 'Pre-production',
      attributes: [
        { key: 'repository', value: 'acme/api' },
        { key: 'branch', value: 'main' },
      ],
    });
    expect(result.text).toContain('updated variant "production"');
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /^\[depot-mcp write\] depot_set_ci_variable variable=DEPLOY_ENV variant=production \d{4}-/,
    );
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain('preprod');
  });

  it('omits variantName from the request when the caller did not give one, so Depot applies its default', async () => {
    harness = await writable({
      [RPC.getVariable]: NOT_FOUND,
      [RPC.getSecret]: NOT_FOUND,
      [RPC.setVariableVariant]: ok({ createdVariable: true, createdVariant: true }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_set_ci_variable', {
      name: 'NEW_FLAG',
      value: 'on',
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.setVariableVariant)[0]?.body).toEqual({
      variableName: 'NEW_FLAG',
      value: 'on',
      attributes: [],
    });
    expect(result.text).toContain('created the variable and its variant "default"');
  });

  it.each([
    ['by name', 'NPM_TOKEN', 'not-a-secret-value', 'name'],
    ['by vendor pattern', 'GH_HELPER', 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', 'pattern'],
    ['by structure', 'DB_CONFIG', 'postgres://app:hunter2@db.internal/app', 'structure'],
  ])('refuses a credential-shaped value %s and points at secrets', async (_label, name, value, rule) => {
    harness = await writable({ [RPC.getVariable]: NOT_FOUND, [RPC.getSecret]: NOT_FOUND });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_set_ci_variable', { name, value, dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Refused, nothing was changed');
    expect(result.text).toContain(`rule "${rule}"`);
    expect(result.text).toContain(`depot ci secrets set ${name}`);
    expect(result.text).not.toContain(value);
    expect(writeCalls(harness)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('refuses a name that already belongs to a secret', async () => {
    harness = await writable({
      [RPC.getVariable]: NOT_FOUND,
      [RPC.getSecret]: ok({ secret: { id: 'sec_88a1', name: 'DEPLOY_BUCKET' } }),
    });

    const result = await callTool(harness, 'depot_set_ci_variable', {
      name: 'DEPLOY_BUCKET',
      value: 'acme-artifacts',
      dryRun: false,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('secret named DEPLOY_BUCKET already exists');
    expect(writeCalls(harness)).toEqual([]);
  });

  it('rejects a name that is not an identifier before any network call', async () => {
    harness = await writable(VARIABLE_ROUTES);

    const result = await callTool(harness, 'depot_set_ci_variable', { name: 'bad name', value: 'x' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('name');
    expect(harness.calls).toHaveLength(0);
  });

  it('surfaces a Depot error from the lookup rather than treating it as absent', async () => {
    harness = await writable({
      [RPC.getVariable]: connectError(403, 'permission_denied', 'member role'),
      [RPC.getSecret]: NOT_FOUND,
    });

    const result = await callTool(harness, 'depot_set_ci_variable', { name: 'X', value: 'y' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('permission_denied');
    expect(writeCalls(harness)).toEqual([]);
  });
});

describe('depot_delete_ci_variable', () => {
  it('previews the one variant a name selector picks, with values, and writes nothing', async () => {
    harness = await writable(VARIABLE_ROUTES);

    const result = await callTool(harness, 'depot_delete_ci_variable', {
      name: 'DEPLOY_ENV',
      variantName: 'production',
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(false);
    const preview = record(result.structured.preview);
    expect(records(preview.variants)).toHaveLength(3);
    expect(records(preview.matching).map((variant) => variant.id)).toEqual(['vv_prod_02']);
    expect(result.text).toContain('[WOULD DELETE] production: repository=acme/api, branch=main = production');
    expect(result.text).toContain('[kept] default: applies everywhere = staging');
    expect(result.structured.resend).toEqual({
      name: 'DEPLOY_ENV',
      variantName: 'production',
      allVariants: false,
      dryRun: false,
    });
    expect(writeCalls(harness)).toEqual([]);
  });

  it('selects by scoping attributes and deletes that variant by id', async () => {
    harness = await writable({
      ...VARIABLE_ROUTES,
      [RPC.deleteVariableVariant]: ok({ deletedVariable: false }),
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_delete_ci_variable', {
      name: 'DEPLOY_ENV',
      repository: 'acme/api',
      branch: 'release/*',
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(result.structured.after).toEqual({ deletedVariable: false, deletedVariantIds: ['vv_release_03'] });
    expect(harness.callsTo(RPC.deleteVariableVariant)[0]?.body).toEqual({ variantId: 'vv_release_03' });
    expect(writeCalls(harness)).toEqual([RPC.deleteVariableVariant]);
    expect(result.text).toContain('Deleted variant "release"');
    expect(result.text).toContain('2 variant(s) remain');
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /^\[depot-mcp write\] depot_delete_ci_variable variable=DEPLOY_ENV variant=vv_release_03 /,
    );
  });

  it('reports when Depot says the last variant took the variable with it', async () => {
    harness = await writable({
      ...VARIABLE_ROUTES,
      [RPC.deleteVariableVariant]: ok({ deletedVariable: true }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_delete_ci_variable', {
      name: 'DEPLOY_ENV',
      variantName: 'default',
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(record(result.structured.after).deletedVariable).toBe(true);
    expect(result.text).toContain('the variable is gone too');
  });

  it('deletes the whole variable by id only with allVariants', async () => {
    harness = await writable({ ...VARIABLE_ROUTES, [RPC.deleteVariable]: ok({}) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_delete_ci_variable', {
      name: 'DEPLOY_ENV',
      allVariants: true,
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.deleteVariable)[0]?.body).toEqual({ id: 'var_2c9e1f' });
    expect(writeCalls(harness)).toEqual([RPC.deleteVariable]);
    expect(result.structured.after).toEqual({
      deletedVariable: true,
      deletedVariantIds: ['vv_default_01', 'vv_prod_02', 'vv_release_03'],
    });
    expect(result.text).toContain('Deleted DEPLOY_ENV and its 3 variant(s)');
  });

  it('falls back to the name lookup when Depot returned no variable id', async () => {
    harness = await writable({
      [RPC.getVariable]: ok({
        variable: { name: 'LEGACY', variants: [{ name: 'default', value: '1', attributes: [] }] },
      }),
      [RPC.deleteVariable]: ok({}),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_delete_ci_variable', {
      name: 'LEGACY',
      allVariants: true,
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.deleteVariable)[0]?.body).toEqual({ name: 'LEGACY' });
  });

  it.each([
    ['a variable Depot does not have', { name: 'NOPE', variantName: 'default' }, 'no CI variable named NOPE'],
    ['a whole-variable delete without allVariants', { name: 'DEPLOY_ENV' }, 'all 3 of its variant(s). Pass allVariants: true'],
    ['allVariants combined with a selector', { name: 'DEPLOY_ENV', allVariants: true, branch: 'main' }, 'cannot be combined'],
    ['a selector matching nothing', { name: 'DEPLOY_ENV', environment: 'qa' }, 'no variant of DEPLOY_ENV matches'],
    ['a selector matching several variants', { name: 'DEPLOY_ENV', repository: 'acme/api' }, 'matches 2 variants of DEPLOY_ENV (production, release)'],
  ])('refuses %s', async (_label, args, reason) => {
    harness = await writable({
      [RPC.getVariable]: [
        args.name === 'NOPE' ? NOT_FOUND : ok(fixture('variable')),
      ],
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_delete_ci_variable', { ...args, dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Refused, nothing was changed');
    expect(result.text).toContain(reason);
    expect(writeCalls(harness)).toEqual([]);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('refuses a variant Depot returned without an id, naming the CLI fallback', async () => {
    harness = await writable({
      [RPC.getVariable]: ok({
        variable: { id: 'var_x', name: 'LEGACY', variants: [{ name: 'default', value: '1', attributes: [] }] },
      }),
    });

    const result = await callTool(harness, 'depot_delete_ci_variable', {
      name: 'LEGACY',
      variantName: 'default',
      dryRun: false,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('depot ci vars remove LEGACY --variant default');
    expect(writeCalls(harness)).toEqual([]);
  });

  it('redacts credential-shaped values in the preview', async () => {
    harness = await writable({
      [RPC.getVariable]: ok({
        variable: {
          id: 'var_sentry',
          name: 'SENTRY_AUTH_TOKEN',
          variants: [
            { id: 'vv_sentry', name: 'default', value: SENTRY_TOKEN, attributes: [] },
          ],
        },
      }),
    });

    const result = await callTool(harness, 'depot_delete_ci_variable', {
      name: 'SENTRY_AUTH_TOKEN',
      variantName: 'default',
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain('redacted by depot-mcp');
    expect(result.text).not.toContain(SENTRY_TOKEN);
    expect(JSON.stringify(result.structured)).not.toContain(SENTRY_TOKEN);
    expect(records(record(result.structured.preview).matching)[0]).toMatchObject({
      id: 'vv_sentry',
      redacted: true,
      redactionReason: 'name',
    });
  });
});

describe('depot_create_project', () => {
  const PROJECT_ROUTES: StubRoutes = { [RPC.listProjects]: ok(fixture('projects')) };

  it('previews resolved defaults and the absence of a name clash, listing projects with pageSize 100', async () => {
    harness = await writable(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_create_project', { name: 'worker' });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(false);
    expect(record(result.structured.preview)).toEqual({
      name: 'worker',
      regionId: 'us-east-1',
      regionKnown: true,
      hardware: '16x32',
      hardwareExplicit: false,
      cachePolicy: { keepDays: 14, keepGb: 50, explicit: false },
      organizationId: 'org_1a2b3c',
      existingProjectCount: 2,
      existingListComplete: true,
      sameName: [],
    });
    expect(result.structured.resend).toEqual({
      name: 'worker',
      regionId: 'us-east-1',
      allowDuplicateName: false,
      dryRun: false,
    });
    expect(result.text).toContain('Would create project "worker" in us-east-1');
    expect(result.text).toContain('16x32 (Depot default)');
    expect(result.text).toContain('50 GB for 14 days (Depot default)');
    expect(result.text).toContain('No existing project has this name');
    expect(harness.callsTo(RPC.listProjects)[0]?.body).toEqual({ pageSize: 100 });
    expect(writeCalls(harness)).toEqual([]);
  });

  it('follows nextPageToken so a clash on a later page is still seen', async () => {
    harness = await writable({
      [RPC.listProjects]: [
        ok({ projects: [{ projectId: 'p1', name: 'one' }], nextPageToken: 'page-2' }),
        ok({ projects: [{ projectId: 'p2', name: 'Worker' }] }),
      ],
    });

    const result = await callTool(harness, 'depot_create_project', { name: 'worker' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('already exists (p2)');
    expect(harness.callsTo(RPC.listProjects)[1]?.body).toEqual({ pageSize: 100, pageToken: 'page-2' });
  });

  it('applies with the project.proto field names, the enum spelling for hardware, and both cache fields', async () => {
    harness = await writable({
      ...PROJECT_ROUTES,
      [RPC.createProject]: ok({
        project: {
          projectId: 'proj_new9z',
          organizationId: 'org_1a2b3c',
          name: 'worker',
          regionId: 'eu-central-1',
          hardware: 'HARDWARE_8X16',
          cachePolicy: { keepDays: 7, keepGb: 50 },
          createdAt: '2026-09-06T10:00:00Z',
        },
      }),
    });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_create_project', {
      name: 'worker',
      regionId: 'eu-central-1',
      hardware: '8x16',
      cacheKeepDays: 7,
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(harness.callsTo(RPC.createProject)[0]?.body).toEqual({
      name: 'worker',
      regionId: 'eu-central-1',
      hardware: 'HARDWARE_8X16',
      cachePolicy: { keepDays: 7, keepGb: 50 },
    });
    expect(writeCalls(harness)).toEqual([RPC.createProject]);
    expect(record(result.structured.after).project).toMatchObject({
      projectId: 'proj_new9z',
      name: 'worker',
      regionId: 'eu-central-1',
      hardware: '8x16',
      cachePolicy: { keepDays: 7, keepGb: 50 },
    });
    expect(result.text).toContain('Created proj_new9z');
    expect(result.text).toContain('DEPOT_PROJECT_ID=proj_new9z');
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(
      /^\[depot-mcp write\] depot_create_project project="worker" region=eu-central-1 /,
    );
  });

  it('sends neither hardware nor a cache policy when the caller set none, so Depot applies its defaults', async () => {
    harness = await writable({
      ...PROJECT_ROUTES,
      [RPC.createProject]: ok({ project: { projectId: 'proj_new9z', name: 'worker', regionId: 'us-east-1' } }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await callTool(harness, 'depot_create_project', { name: 'worker', dryRun: false });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.createProject)[0]?.body).toEqual({ name: 'worker', regionId: 'us-east-1' });
  });

  it('refuses a duplicate name, case-insensitively, unless allowDuplicateName is set', async () => {
    harness = await writable({
      ...PROJECT_ROUTES,
      [RPC.createProject]: ok({ project: { projectId: 'proj_api2', name: 'API', regionId: 'us-east-1' } }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const refused = await callTool(harness, 'depot_create_project', { name: 'API', dryRun: false });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('a project named "API" already exists (proj_api7f2)');
    expect(refused.text).toContain('allowDuplicateName: true');
    expect(writeCalls(harness)).toEqual([]);

    const preview = await callTool(harness, 'depot_create_project', { name: 'API', allowDuplicateName: true });
    expect(preview.isError, preview.text).toBe(false);
    expect(records(record(preview.structured.preview).sameName).map((project) => project.projectId)).toEqual([
      'proj_api7f2',
    ]);
    expect(preview.text).toContain('A project with this name already exists');

    const applied = await callTool(harness, 'depot_create_project', {
      name: 'API',
      allowDuplicateName: true,
      dryRun: false,
    });
    expect(applied.isError, applied.text).toBe(false);
    expect(writeCalls(harness)).toEqual([RPC.createProject]);
  });

  it('refuses a region Depot does not document, even on a dry run', async () => {
    harness = await writable(PROJECT_ROUTES);

    const result = await callTool(harness, 'depot_create_project', { name: 'edge', regionId: 'ap-south-1' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('"ap-south-1" is not a region Depot documents; use us-east-1 or eu-central-1');
    expect(writeCalls(harness)).toEqual([]);
  });

  it('rejects an unknown hardware label and a blank name before any network call', async () => {
    harness = await writable(PROJECT_ROUTES);

    const hardware = await callTool(harness, 'depot_create_project', { name: 'edge', hardware: '2x2' });
    const blank = await callTool(harness, 'depot_create_project', { name: '   ' });

    expect(hardware.isError).toBe(true);
    expect(hardware.text).toContain('hardware');
    expect(blank.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);
  });

  it('translates a Depot refusal of the token into guidance', async () => {
    harness = await writable({
      [RPC.listProjects]: connectError(401, 'unauthenticated', 'Invalid token'),
    });

    const result = await callTool(harness, 'depot_create_project', { name: 'edge' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Organization token');
    expect(writeCalls(harness)).toEqual([]);
  });
});
