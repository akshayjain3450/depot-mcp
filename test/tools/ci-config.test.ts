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

const SENTRY_TOKEN = 'sntrys_9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const GITHUB_TOKEN = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

describe('depot_list_ci_secrets', () => {
  it('lists names and scoping and never claims to have values', async () => {
    harness = await createHarness({ routes: { [RPC.listSecrets]: ok(fixture('secrets')) } });

    const result = await callTool(harness, 'depot_list_ci_secrets', {});
    const secrets = records(result.structured.secrets);

    expect(result.structured.valuesAvailable).toBe(false);
    expect(secrets.map((secret) => secret.name)).toEqual(['NPM_TOKEN', 'AWS_DEPLOY_KEY']);
    expect(records(secrets[1]?.variants)).toHaveLength(2);
    for (const variant of records(secrets[1]?.variants)) {
      expect(variant.value).toBeUndefined();
    }
    expect(result.text).toContain('environment=production');
  });

  it('sends an empty request because the beta filter fields are undocumented', async () => {
    harness = await createHarness({ routes: { [RPC.listSecrets]: ok(fixture('secrets')) } });

    await callTool(harness, 'depot_list_ci_secrets', { query: 'npm' });

    expect(harness.callsTo(RPC.listSecrets)[0]?.body).toEqual({});
  });

  it('filters by name in this server', async () => {
    harness = await createHarness({ routes: { [RPC.listSecrets]: ok(fixture('secrets')) } });

    const result = await callTool(harness, 'depot_list_ci_secrets', { query: 'aws' });

    expect(records(result.structured.secrets).map((secret) => secret.name)).toEqual([
      'AWS_DEPLOY_KEY',
    ]);
  });
});

describe('depot_list_ci_variables', () => {
  it('returns ordinary values but redacts credential-shaped ones', async () => {
    harness = await createHarness({ routes: { [RPC.listVariables]: ok(fixture('variables')) } });

    const result = await callTool(harness, 'depot_list_ci_variables', {});
    const variables = records(result.structured.variables);
    const byName = new Map(variables.map((variable) => [variable.name, variable]));

    expect(result.structured.redactedCount).toBe(2);

    const nodeEnv = records(byName.get('NODE_ENV')?.variants);
    expect(nodeEnv[0]).toMatchObject({ value: 'production', redacted: false });
    expect(nodeEnv[1]).toMatchObject({ value: 'staging' });

    const bucket = records(byName.get('DEPLOY_BUCKET')?.variants);
    expect(bucket[0]).toMatchObject({ value: 'acme-artifacts-prod', redacted: false });

    const sentry = records(byName.get('SENTRY_AUTH_TOKEN')?.variants);
    expect(sentry[0]).toMatchObject({ redacted: true, redactionReason: 'name' });

    const credentials = records(byName.get('GH_APP_CREDENTIALS')?.variants);
    expect(credentials[0]).toMatchObject({ redacted: true, redactionReason: 'name' });
  });

  it('keeps redacted secrets out of both the text and the structured output', async () => {
    harness = await createHarness({ routes: { [RPC.listVariables]: ok(fixture('variables')) } });

    const result = await callTool(harness, 'depot_list_ci_variables', {});

    expect(result.text).not.toContain(SENTRY_TOKEN);
    expect(result.text).not.toContain(GITHUB_TOKEN);
    expect(JSON.stringify(result.structured)).not.toContain(SENTRY_TOKEN);
    expect(JSON.stringify(result.structured)).not.toContain(GITHUB_TOKEN);
    expect(result.text).toContain('redacted by depot-mcp');
    expect(result.text).toContain('look like credentials');
  });

  it('drops variants scoped to a different environment', async () => {
    harness = await createHarness({ routes: { [RPC.listVariables]: ok(fixture('variables')) } });

    const result = await callTool(harness, 'depot_list_ci_variables', {
      environment: 'production',
    });
    const byName = new Map(
      records(result.structured.variables).map((variable) => [variable.name, variable]),
    );

    expect(records(byName.get('NODE_ENV')?.variants)).toHaveLength(1);
    expect(records(byName.get('NODE_ENV')?.variants)[0]?.value).toBe('production');
  });

  it('explains an empty result', async () => {
    harness = await createHarness({ routes: { [RPC.listVariables]: ok({}) } });

    const result = await callTool(harness, 'depot_list_ci_variables', {});

    expect(result.structured.returned).toBe(0);
    expect(result.text).toContain('DEPOT_ORG_ID');
  });
});
