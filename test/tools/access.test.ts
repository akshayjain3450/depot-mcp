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

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

describe('depot_audit_trust_policies', () => {
  it('lists projects, reads the policies of each, and maps identities to projects', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listProjects]: ok(fixture('projects')),
        [RPC.listTrustPolicies]: [
          ok({
            trustPolicies: [
              { trustPolicyId: 'tp_1', github: { repositoryOwner: 'acme', repository: 'api' } },
              { trustPolicyId: 'tp_2', buildkite: { organizationSlug: 'acme', pipelineSlug: 'api' } },
            ],
          }),
          ok({}),
        ],
      },
    });

    const result = await callTool(harness, 'depot_audit_trust_policies', {});

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.listProjects)[0]?.body).toEqual({ pageSize: 50 });
    expect(harness.callsTo(RPC.listTrustPolicies).map((call) => call.body)).toEqual([
      { projectId: 'proj_api7f2' },
      { projectId: 'proj_web3c9' },
    ]);

    const projects = records(result.structured.projects);
    expect(projects).toHaveLength(2);
    expect(records(projects[0]?.trustPolicies)).toEqual([
      {
        trustPolicyId: 'tp_1',
        provider: 'github',
        identity: 'github acme/api',
        detail: { repositoryOwner: 'acme', repository: 'api' },
      },
      {
        trustPolicyId: 'tp_2',
        provider: 'buildkite',
        identity: 'buildkite acme/api',
        detail: { organizationSlug: 'acme', pipelineSlug: 'api' },
      },
    ]);
    expect(records(projects[1]?.trustPolicies)).toEqual([]);
    expect(result.structured.identities).toEqual([
      { identity: 'buildkite acme/api', provider: 'buildkite', projectIds: ['proj_api7f2'] },
      { identity: 'github acme/api', provider: 'github', projectIds: ['proj_api7f2'] },
    ]);
    expect(result.structured).toMatchObject({
      projectsAudited: 2,
      projectsWithPolicies: 1,
      policyCount: 2,
      projectsFailed: 0,
      projectCapHit: false,
    });
    expect(result.text).toContain('2 projects checked, 1 with OIDC trust policies, 2 policies in total');
    expect(result.text).toContain('proj_web3c9 (web): no trust policies (token-only)');
    expect(result.text).toContain('github acme/api -> proj_api7f2');
  });

  it('treats an organization with no policies at all as a valid answer', async () => {
    harness = await createHarness({
      routes: { [RPC.listProjects]: ok(fixture('projects')), [RPC.listTrustPolicies]: ok({}) },
    });

    const result = await callTool(harness, 'depot_audit_trust_policies', {});

    expect(result.isError).toBe(false);
    expect(result.structured.identities).toEqual([]);
    expect(result.text).toContain('No project trusts an external OIDC identity');
  });

  it('audits only the named project without listing projects', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listTrustPolicies]: ok({
          trust_policies: [
            { trust_policy_id: 'tp_9', circleci: { organization_uuid: 'org-uuid', project_uuid: 'proj-uuid' } },
            { gitlab: { namespace_id: '42', project_id: '77' } },
          ],
        }),
      },
    });

    const result = await callTool(harness, 'depot_audit_trust_policies', { projectId: 'proj_only' });

    expect(harness.callsTo(RPC.listProjects)).toHaveLength(0);
    expect(harness.callsTo(RPC.listTrustPolicies)[0]?.body).toEqual({ projectId: 'proj_only' });
    const identities = records(result.structured.identities).map((entry) => entry.identity);
    expect(identities).toEqual([
      'circleci organization org-uuid project proj-uuid',
      'gitlab namespace 42 project 77',
    ]);
    expect(records(records(result.structured.projects)[0]?.trustPolicies)[0]?.trustPolicyId).toBe('tp_9');
  });

  it('records a project whose policies could not be read instead of failing the audit', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listProjects]: ok(fixture('projects')),
        [RPC.listTrustPolicies]: [
          connectError(403, 'permission_denied', 'nope'),
          ok({ trustPolicies: [{ github: { repositoryOwner: 'acme', repository: 'web' } }] }),
        ],
      },
    });

    const result = await callTool(harness, 'depot_audit_trust_policies', {});

    expect(result.isError).toBe(false);
    const projects = records(result.structured.projects);
    expect(projects[0]?.error).toBe('permission_denied: nope');
    expect(projects[1]?.error).toBeUndefined();
    expect(result.structured.projectsFailed).toBe(1);
    expect(result.text).toContain('could not list trust policies (permission_denied: nope)');
    expect(result.text).toContain('github acme/web -> proj_web3c9');
  });

  it('caps the audit at 50 projects and says more exist', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listProjects]: ok({
          projects: Array.from({ length: 50 }, (_, i) => ({ projectId: `proj_${i}` })),
          nextPageToken: 'page-2',
        }),
        [RPC.listTrustPolicies]: ok({}),
      },
    });

    const result = await callTool(harness, 'depot_audit_trust_policies', {});

    expect(harness.callsTo(RPC.listTrustPolicies)).toHaveLength(50);
    expect(result.structured.projectCapHit).toBe(true);
    expect(strings(result.structured.notes)[0]).toMatch(/first 50 projects/);
  });

  it('translates a Connect error from ListProjects', async () => {
    harness = await createHarness({
      routes: { [RPC.listProjects]: connectError(401, 'unauthenticated', 'Invalid token') },
    });

    const result = await callTool(harness, 'depot_audit_trust_policies', {});

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unauthenticated|Invalid token/);
  });
});

describe('depot_list_project_tokens', () => {
  it('returns token metadata for the project', async () => {
    harness = await createHarness({ routes: { [RPC.listTokens]: ok(fixture('project-tokens')) } });

    const result = await callTool(harness, 'depot_list_project_tokens', { projectId: 'proj_api7f2' });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.listTokens)[0]?.body).toEqual({ projectId: 'proj_api7f2' });
    expect(result.structured.returned).toBe(2);
    expect(records(result.structured.tokens)).toEqual([
      { tokenId: 'tok_9f2a1c', description: 'GitHub Actions deploy' },
      { tokenId: 'tok_0b7d3e', description: 'local dev laptop', createdAt: '2026-06-01T08:00:00Z' },
    ]);
    expect(result.text).toContain('2 project tokens for project proj_api7f2 (metadata only)');
    expect(result.text).toContain('tok_0b7d3e: "local dev laptop", created 2026-06-01T08:00:00Z');
  });

  it('never passes through a secret, whatever Depot calls the field', async () => {
    const leaked = 'dp_supersecretvalue_0123456789';
    harness = await createHarness({
      routes: {
        [RPC.listTokens]: ok({
          tokens: [
            {
              token_id: 'tok_snake',
              description: 'snake case with extras',
              secret: leaked,
              token: leaked,
              value: leaked,
              hash: 'sha256:deadbeef',
            },
          ],
        }),
      },
    });

    const result = await callTool(harness, 'depot_list_project_tokens', { projectId: 'proj_api7f2' });

    expect(result.isError).toBe(false);
    expect(records(result.structured.tokens)).toEqual([
      { tokenId: 'tok_snake', description: 'snake case with extras' },
    ]);
    const everything = `${result.text}\n${JSON.stringify(result.structured)}`;
    expect(everything).not.toContain(leaked);
    expect(everything).not.toContain('deadbeef');
    expect(everything).not.toMatch(/"secret"|"token"|"value"|"hash"/);
  });

  it('explains an empty token list', async () => {
    harness = await createHarness({ routes: { [RPC.listTokens]: ok({}) } });

    const result = await callTool(harness, 'depot_list_project_tokens', { projectId: 'proj_api7f2' });

    expect(result.structured.returned).toBe(0);
    expect(result.text).toContain('has no project tokens');
    expect(result.text).toContain('depot_audit_trust_policies');
  });

  it('requires a projectId and translates a Connect error', async () => {
    harness = await createHarness({
      routes: { [RPC.listTokens]: connectError(404, 'not_found', 'project not found') },
    });

    const missing = await callTool(harness, 'depot_list_project_tokens', {});
    expect(missing.isError).toBe(true);
    expect(harness.calls).toHaveLength(0);

    const refused = await callTool(harness, 'depot_list_project_tokens', { projectId: 'proj_missing' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not_found|project not found/);
  });
});
