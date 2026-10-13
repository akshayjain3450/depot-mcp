import { describe, expect, it } from 'vitest';
import {
  createProjectReadGuard,
  projectVerificationConfig,
  verificationFailureMessage,
  verifyProject,
} from '../../scripts/project-verification.js';
import { encodeGetBuildStepLogsRequest, encodeGetBuildStepsRequest } from '../../src/depot/build-proto.js';
import { DepotApiError } from '../../src/depot/errors.js';
import { ProtobufWriter } from '../../src/depot/protobuf.js';
import { connectError, fixture, ok, stubFetch, type RecordedCall, type StubRoutes } from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

const scope = { orgId: 'org_approved', projectId: 'proj_approved', projectName: 'approved-project' };
const env = {
  DEPOT_TOKEN: 'fake-token-for-offline-tests',
  DEPOT_ORG_ID: scope.orgId,
  DEPOT_PROJECT_ID: scope.projectId,
  DEPOT_MCP_VERIFY_APPLY: '0',
};
const buildId = 'bld_4a91c7';
const project = { project: { projectId: scope.projectId, organizationId: scope.orgId, name: scope.projectName } };
const routes: StubRoutes = {
  [RPC.getProject]: ok(project),
  [RPC.listBuilds]: ok({ builds: [{ buildId, status: 2 }] }),
  [RPC.getBuild]: ok(fixture('build')),
  [RPC.getBuildSteps]: ok(fixture('build-steps')),
  [RPC.getBuildStepLogs]: ok(fixture('build-step-logs')),
};

function guardHarness() {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const guard = createProjectReadGuard(scope, (url, init) => {
    sent.push({ url, init });
    return Promise.resolve(new Response('{}'));
  });
  const request = (rpc: string, body: string | Uint8Array, overrides: RequestInit = {}) =>
    guard.fetch(`https://api.depot.dev/${rpc}`, {
      method: 'POST', body,
      headers: {
        'x-depot-org': scope.orgId,
        'content-type': typeof body === 'string' ? 'application/json' : 'application/proto',
      },
      ...overrides,
    });
  return { guard, sent, request };
}

describe('project verification request boundary', () => {
  it.each([
    RPC.listProjects, RPC.listOrganizations, RPC.listRuns, RPC.getUsage, RPC.listVariables,
    RPC.listSandboxes, RPC.listRegistryRepositories, RPC.createProject, RPC.updateProject,
    RPC.deleteProject, RPC.retryJob, RPC.rerunWorkflow, RPC.cancelRun, RPC.dispatchWorkflow,
    'depot.future.v1.Service/NewOperation',
  ])('blocks %s before any request leaves the process', async (rpc) => {
    const h = guardHarness();
    await expect(h.request(rpc, '{}')).rejects.toThrow('Blocked');
    expect(h.sent).toEqual([]);
  });

  it('blocks another project even when the RPC is permitted, and stays closed after a violation', async () => {
    const h = guardHarness();
    await expect(h.request(RPC.getProject, JSON.stringify({ projectId: 'other' }))).rejects.toThrow('Blocked');
    await expect(h.request(RPC.getProject, JSON.stringify({ projectId: scope.projectId }))).rejects.toThrow('Blocked');
    expect(h.sent).toEqual([]);
    expect(() => h.guard.assertUnblocked()).toThrow('Blocked');
  });

  it.each([
    { projectId: 'other', buildId },
    { projectId: scope.projectId, buildId: 'other' },
  ])('blocks protobuf step/log requests with mismatching targets: %j', async (target) => {
    for (const [rpc, body] of [
      [RPC.getBuildSteps, encodeGetBuildStepsRequest({ ...target, pageSize: 500 })],
      [RPC.getBuildStepLogs, encodeGetBuildStepLogsRequest({ ...target, buildStepDigest: 'sha256:1', pageSize: 500 })],
    ] as const) {
      const h = guardHarness();
      h.guard.selectBuild(buildId);
      await expect(h.request(rpc, body)).rejects.toThrow('Blocked');
      expect(h.sent).toEqual([]);
    }
  });

  it('rejects duplicate protobuf fields and page tokens instead of relying on decoder ambiguity', async () => {
    const invalid = [
      new ProtobufWriter().string(1, 'other').string(1, scope.projectId).string(2, buildId).int32(3, 500).finish(),
      encodeGetBuildStepsRequest({ projectId: scope.projectId, buildId, pageSize: 500, pageToken: 'unapproved-page' }),
    ];
    for (const body of invalid) {
      const h = guardHarness();
      h.guard.selectBuild(buildId);
      await expect(h.request(RPC.getBuildSteps, body)).rejects.toThrow('Blocked');
      expect(h.sent).toEqual([]);
    }
  });

  it('requires a selected build and rejects unselected IDs in GetBuild', async () => {
    const unselected = guardHarness();
    await expect(unselected.request(RPC.getBuild, JSON.stringify({ buildId }))).rejects.toThrow('Blocked');
    expect(unselected.sent).toEqual([]);
    const selected = guardHarness();
    selected.guard.selectBuild(buildId);
    await expect(selected.request(RPC.getBuild, JSON.stringify({ buildId: 'other' }))).rejects.toThrow('Blocked');
    expect(selected.sent).toEqual([]);
  });

  it.each([
    { method: 'GET' },
    { headers: { 'x-depot-org': 'other', 'content-type': 'application/json' } },
    { headers: { 'x-depot-org': scope.orgId, 'content-type': 'application/proto' } },
  ])('rejects mismatched method or headers: %j', async (overrides) => {
    const h = guardHarness();
    await expect(h.request(RPC.getProject, JSON.stringify({ projectId: scope.projectId }), overrides)).rejects.toThrow('Blocked');
    expect(h.sent).toEqual([]);
  });

  it.each([
    'https://elsewhere.example/', 'http://api.depot.dev/',
    'https://api.depot.dev/prefix/', 'https://api.depot.dev:444/',
  ])('rejects an unapproved destination %s', async (base) => {
    const h = guardHarness();
    await expect(h.guard.fetch(`${base}${RPC.getProject}`, {
      method: 'POST', headers: { 'x-depot-org': scope.orgId },
      body: JSON.stringify({ projectId: scope.projectId }),
    })).rejects.toThrow('Blocked');
    expect(h.sent).toEqual([]);
  });

  it('forces redirect rejection and bounds all outbound requests, including retries', async () => {
    const h = guardHarness();
    for (let i = 0; i < 18; i += 1) {
      await h.request(RPC.getProject, JSON.stringify({ projectId: scope.projectId }), { redirect: 'follow' });
    }
    expect(h.sent.every(({ init }) => init.redirect === 'error')).toBe(true);
    await expect(h.request(RPC.getProject, JSON.stringify({ projectId: scope.projectId }))).rejects.toThrow('Blocked');
    expect(h.sent).toHaveLength(18);
  });
});

describe('project verification configuration', () => {
  it.each([
    { DEPOT_PROJECT_ID: 'other' }, { DEPOT_ORG_ID: '' },
    { DEPOT_API_URL: 'https://proxy.example' },
    { DEPOT_MCP_ALLOW_WRITES: '1' }, { DEPOT_MCP_ALLOW_DESTRUCTIVE: 'true' },
    { DEPOT_MCP_ENABLE_BETA: 'yes' }, { DEPOT_MCP_VERIFY_APPLY: '1' },
  ])('refuses unsafe or ambiguous configuration before network access: %j', async (overrides) => {
    const calls: RecordedCall[] = [];
    await expect(verifyProject({ ...scope, env: { ...env, ...overrides }, fetch: stubFetch(routes, calls) })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('fixes sampling limits regardless of broader defaults', () => {
    const result = projectVerificationConfig({ ...env, DEPOT_MCP_MAX_LOG_PAGES: '100' }, scope);
    expect(result.config).toMatchObject({ allowWrites: false, allowDestructive: false, enableBeta: false, maxLogPages: 1 });
  });
});

describe('project verification over real MCP round-trips', () => {
  async function run(overrides: StubRoutes = {}) {
    const calls: RecordedCall[] = [];
    const sleeps: number[] = [];
    let clock = 0;
    const result = await verifyProject({
      ...scope, env, fetch: stubFetch({ ...routes, ...overrides }, calls),
      now: () => clock,
      sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    });
    return { calls, sleeps, result };
  }

  it('reads only the approved project and a build found within it; keeps private output out of the report', async () => {
    const { calls, result } = await run();
    expect(calls.map(({ rpc }) => rpc)).toEqual([
      RPC.getProject, RPC.listBuilds, RPC.getBuild, RPC.getBuild, RPC.getBuildSteps, RPC.getBuildStepLogs,
    ]);
    expect(result).toMatchObject({ stepsAvailable: true, logsUnavailable: false, stepCount: 4, maxPagesPerEndpoint: 1 });
    expect(calls.slice(1).every(({ body }) => body.projectId === scope.projectId || body.buildId === buildId)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/sha256|TS2345|npm|fake-token|approved-project|bld_4a91c7/);
  });

  it('exercises transient steps recovery through the guarded protobuf request', async () => {
    const { result, calls, sleeps } = await run({
      [RPC.getBuildSteps]: [connectError(500, 'internal', 'Error fetching build steps'), ok(fixture('build-steps'))],
    });
    expect(result.stepsAvailable).toBe(true);
    expect(calls.filter(({ rpc }) => rpc === RPC.getBuildSteps)).toHaveLength(2);
    expect(sleeps).toEqual([250]);
  });

  it('does not report available steps or logs when the build has no steps', async () => {
    const { result, calls } = await run({ [RPC.getBuildSteps]: ok({}) });
    expect(result).toMatchObject({ stepsAvailable: false, stepCount: 0, logLinesReturned: 0 });
    expect(calls.filter(({ rpc }) => rpc === RPC.getBuildStepLogs)).toHaveLength(0);
  });

  it('reports exhausted retries without exposing the server message', async () => {
    const { result, calls, sleeps } = await run({
      [RPC.getBuildSteps]: connectError(500, 'internal', 'Error fetching build steps'),
    });
    expect(result.stepsAvailable).toBe(false);
    expect(calls.filter(({ rpc }) => rpc === RPC.getBuildSteps)).toHaveLength(3);
    expect(calls.filter(({ rpc }) => rpc === RPC.getBuildStepLogs)).toHaveLength(0);
    expect(sleeps).toEqual([250, 750]);
  });

  it('does not retry the known persistent logs error or page past its sample', async () => {
    const { result, calls, sleeps } = await run({
      [RPC.getBuildSteps]: ok({ ...fixture('build-steps'), nextPageToken: 'another-page' }),
      [RPC.getBuildStepLogs]: connectError(500, 'internal', 'internal error'),
    });
    expect(result).toMatchObject({ stepsAvailable: true, logsUnavailable: true });
    expect(calls.filter(({ rpc }) => rpc === RPC.getBuildSteps)).toHaveLength(1);
    expect(calls.filter(({ rpc }) => rpc === RPC.getBuildStepLogs)).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([
    { projectId: 'other' }, { name: 'other' }, { organizationId: 'other' }, { organizationId: undefined },
  ])('stops at a mismatched or incomplete project identity: %j', async (overrides) => {
    const calls: RecordedCall[] = [];
    await expect(verifyProject({ ...scope, env, fetch: stubFetch({
      ...routes, [RPC.getProject]: ok({ project: { ...project.project, ...overrides } }),
    }, calls) })).rejects.toThrow('did not match');
    expect(calls.map(({ rpc }) => rpc)).toEqual([RPC.getProject]);
  });

  it.each([{ builds: [] }, { builds: [{ buildId, status: 1 }] }])('stops when there is no completed build: %j', async ({ builds }) => {
    const calls: RecordedCall[] = [];
    await expect(verifyProject({ ...scope, env, fetch: stubFetch({
      ...routes, [RPC.listBuilds]: ok({ builds }),
    }, calls) })).rejects.toThrow('No completed build');
    expect(calls.map(({ rpc }) => rpc)).toEqual([RPC.getProject, RPC.listBuilds]);
  });

  it('never echoes raw transport errors, server messages, or config input on failure', () => {
    expect(verificationFailureMessage(new Error(`Bearer ${env.DEPOT_TOKEN}`))).not.toContain(env.DEPOT_TOKEN);
    const error = new DepotApiError({ code: 'internal', httpStatus: 500, rpc: RPC.getProject, serverMessage: 'private data' });
    expect(verificationFailureMessage(error)).toBe('Depot request failed: internal, HTTP 500.');
  });
});
