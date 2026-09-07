import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { JsonObject } from '../../src/depot/shape.js';
import {
  DISPATCH_MAX_INPUT_CHARS,
  DISPATCH_MAX_INPUTS,
  matchWorkflowEntry,
} from '../../src/tools/ci-dispatch.js';
import { parseWorkflowListEntry } from '../../src/lib/ci-workflow.js';
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

const ARGS = { repo: 'acme/api', workflow: 'ci.yml', ref: 'main' };

/** The shape Depot answered for a real repository on 2026-09-07, ids replaced. */
const LAB_WORKFLOWS: JsonObject = {
  workflows: [
    {
      workflowId: 'wf_push01',
      name: 'deliberate-failure',
      workflowPath: 'fail.yml',
      repo: 'acme/api',
      status: 'cancelled',
      trigger: 'push',
      runId: 'ps_run01',
      sha: '4159f5fe517dc93fba6b922bb4c2f3650221a5b7',
      createdAt: '2026-09-06T00:49:58Z',
      jobCounts: { total: 1, cancelled: 1 },
    },
    {
      workflowId: 'wf_api01',
      name: 'artifacts-and-summary',
      repo: 'acme/api',
      status: 'failed',
      trigger: 'api',
      runId: 'run_art01',
      sha: '4159f5fe517dc93fba6b922bb4c2f3650221a5b7',
      createdAt: '2026-09-06T00:49:58Z',
      jobCounts: { total: 1, failed: 1 },
    },
    {
      workflowId: 'wf_api00',
      name: 'deliberate-failure',
      repo: 'acme/api',
      status: 'failed',
      trigger: 'api',
      runId: 'run_fail00',
      createdAt: '2026-09-06T00:25:20Z',
      jobCounts: { total: 1, failed: 1 },
    },
  ],
};

async function writable(routes: StubRoutes, config: Parameters<typeof createHarness>[0]['config'] = {}): Promise<Harness> {
  harness = await createHarness({ routes, config: { allowWrites: true, ...config } });
  await harness.client.listTools();
  return harness;
}

function dispatchCalls(h: Harness): number {
  return h.callsTo(RPC.dispatchWorkflow).length;
}

type StderrSpy = MockInstance<typeof console.error>;

function audit(): StderrSpy {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function auditLines(spy: StderrSpy): string[] {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line) => line.startsWith('[depot-mcp write]'));
}

function record(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

describe('gating', () => {
  it('is absent without DEPOT_MCP_ALLOW_WRITES and present, with honest annotations, with it', async () => {
    harness = await createHarness({ routes: {} });
    expect((await harness.client.listTools()).tools.map((tool) => tool.name)).not.toContain('depot_dispatch_ci_workflow');
    await harness.close();

    harness = await createHarness({ routes: {}, config: { allowWrites: true } });
    const { tools } = await harness.client.listTools();
    const tool = tools.find((entry) => entry.name === 'depot_dispatch_ci_workflow');

    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(record(record(tool?.inputSchema.properties).dryRun).default).toBe(true);
    expect(tool?.description).toContain('dryRun:false');
    expect(tool?.description).toContain('DEPOT_MCP_DISPATCH_ALLOWLIST');
    expect(tool?.description).toContain('depot_wait_for_ci_run');
  });
});

describe('depot_dispatch_ci_workflow preview', () => {
  it('lists the repository once, names the last run of the workflow, and warns that a real run starts', async () => {
    const h = await writable({ [RPC.listWorkflows]: ok(LAB_WORKFLOWS) });

    const result = await callTool(h, 'depot_dispatch_ci_workflow', {
      repo: 'acme/api',
      workflow: 'artifacts.yml',
      ref: 'main',
      inputs: { environment: 'staging' },
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(false);
    expect(result.structured.refusal).toBeUndefined();
    expect(h.callsTo(RPC.listWorkflows)).toHaveLength(1);
    expect(h.callsTo(RPC.listWorkflows)[0]?.body).toEqual({ repo: 'acme/api', pageSize: 50 });
    expect(result.structured.preview).toMatchObject({
      repo: 'acme/api',
      workflow: 'artifacts.yml',
      ref: 'main',
      inputCount: 1,
      inputKeys: ['environment'],
      allowlistActive: false,
      allowlisted: true,
      recentWorkflowCount: 3,
      lastRun: {
        runId: 'run_art01',
        workflowId: 'wf_api01',
        name: 'artifacts-and-summary',
        status: 'failed',
        trigger: 'api',
        matchedBy: 'prefix',
      },
    });
    expect(result.structured.resend).toEqual({
      repo: 'acme/api',
      workflow: 'artifacts.yml',
      ref: 'main',
      inputs: { environment: 'staging' },
      dryRun: false,
    });
    expect(result.text).toContain('DRY RUN');
    expect(result.text).toContain('would start artifacts.yml in acme/api on ref main with 1 input(s): environment');
    expect(result.text).toContain('This starts a real CI run');
    expect(result.text).toContain('deploys or publishes');
    expect(result.text).toContain('Last run of this workflow: run run_art01 (workflowId=wf_api01), "artifacts-and-summary" failed · via api · 4159f5fe · 2026-09-06T00:49:58Z; probably the same workflow, matched by name prefix.');
    expect(result.text).toContain('DEPOT_MCP_DISPATCH_ALLOWLIST is not set');
    expect(dispatchCalls(h)).toBe(0);
  });

  it('prefers a row whose workflowPath is the file over one that merely shares the name', async () => {
    const h = await writable({ [RPC.listWorkflows]: ok(LAB_WORKFLOWS) });

    const result = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, workflow: 'fail.yml' });

    expect(record(result.structured.preview).lastRun).toMatchObject({
      runId: 'ps_run01',
      workflowPath: 'fail.yml',
      matchedBy: 'path',
    });
    expect(result.text).toContain('matched by workflow file');
  });

  it('says so when the workflow has no previous run, and when the repository has none at all', async () => {
    const h = await writable({ [RPC.listWorkflows]: [ok(fixture('workflows-list')), ok({})] });

    const unseen = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, workflow: 'release.yml' });
    expect(unseen.isError, unseen.text).toBe(false);
    expect(unseen.structured.refusal).toBeUndefined();
    expect(record(unseen.structured.preview).lastRun).toBeUndefined();
    expect(record(unseen.structured.preview).recentNames).toEqual(['CI', 'Deploy']);
    expect(unseen.text).toContain('No previous run of release.yml among the 3 most recent workflow(s) in acme/api (seen: CI, Deploy)');

    const empty = await callTool(h, 'depot_dispatch_ci_workflow', ARGS);
    expect(empty.isError, empty.text).toBe(false);
    expect(empty.text).toContain('Depot lists no workflows for acme/api');
    expect(record(empty.structured.preview).recentWorkflowCount).toBe(0);
  });

  it('matches the YAML name against the basename and its stem, case-insensitively', () => {
    const entry = (name: string, workflowPath?: string) =>
      parseWorkflowListEntry({ name, ...(workflowPath === undefined ? {} : { workflowPath }) });

    expect(matchWorkflowEntry(entry('CI'), 'ci.yml')).toBe('name');
    expect(matchWorkflowEntry(entry('ci.yml'), 'CI.yml')).toBe('name');
    expect(matchWorkflowEntry(entry('Deploy production'), 'deploy.yaml')).toBe('prefix');
    expect(matchWorkflowEntry(entry('deployment'), 'deploy.yml')).toBeUndefined();
    expect(matchWorkflowEntry(entry('Something', 'deploy.yml'), 'deploy.yml')).toBe('path');
    expect(matchWorkflowEntry(entry('', undefined), 'x.yml')).toBeUndefined();
  });
});

describe('depot_dispatch_ci_workflow refusals', () => {
  it.each([
    ['a repo without an owner', { ...ARGS, repo: 'api' }, 'repo must be a GitHub repository in owner/name form'],
    ['a repo with a path', { ...ARGS, repo: 'acme/api/extra' }, 'repo must be a GitHub repository in owner/name form'],
    ['a repo with spaces', { ...ARGS, repo: 'acme api/x' }, 'owner/name form'],
    ['a workflow path', { ...ARGS, workflow: '.github/workflows/ci.yml' }, 'workflow must be the file basename'],
    ['a workflow with a backslash', { ...ARGS, workflow: 'workflows\\ci.yml' }, 'workflow must be the file basename'],
    ['a workflow with whitespace', { ...ARGS, workflow: 'ci yml' }, 'contains whitespace'],
    ['an empty workflow', { ...ARGS, workflow: '  ' }, 'workflow is empty'],
    ['an empty ref', { ...ARGS, ref: '  ' }, 'ref is empty'],
    ['an empty input key', { ...ARGS, inputs: { '': 'x' } }, 'inputs contains an empty key'],
    [
      `more than ${DISPATCH_MAX_INPUTS} inputs`,
      { ...ARGS, inputs: Object.fromEntries(Array.from({ length: DISPATCH_MAX_INPUTS + 1 }, (_, i) => [`k${i}`, 'v'])) },
      `inputs has ${DISPATCH_MAX_INPUTS + 1} keys; at most ${DISPATCH_MAX_INPUTS} are accepted`,
    ],
    [
      `an input value over ${DISPATCH_MAX_INPUT_CHARS} characters`,
      { ...ARGS, inputs: { notes: 'x'.repeat(DISPATCH_MAX_INPUT_CHARS + 1) } },
      `inputs.notes is ${DISPATCH_MAX_INPUT_CHARS + 1} characters long; each value is capped at ${DISPATCH_MAX_INPUT_CHARS}`,
    ],
  ])('refuses %s on a dry run and on apply, without calling Depot at all', async (_label, args, reason) => {
    const h = await writable({ [RPC.listWorkflows]: ok(LAB_WORKFLOWS), [RPC.dispatchWorkflow]: ok({ runId: 'nope' }) });
    const spy = audit();

    const dry = await callTool(h, 'depot_dispatch_ci_workflow', args);
    expect(dry.isError, dry.text).toBe(false);
    expect(String(dry.structured.refusal)).toContain(reason);
    expect(dry.structured.resend).toBeUndefined();
    expect(dry.text).toContain('would be REFUSED');

    const applied = await callTool(h, 'depot_dispatch_ci_workflow', { ...args, dryRun: false });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain('Refused depot_dispatch_ci_workflow before calling Depot');
    expect(applied.text).toContain(reason);

    expect(h.calls).toHaveLength(0);
    expect(auditLines(spy)).toHaveLength(0);
  });

  it('accepts exactly the input cap', async () => {
    const h = await writable({ [RPC.listWorkflows]: ok(LAB_WORKFLOWS) });

    const result = await callTool(h, 'depot_dispatch_ci_workflow', {
      ...ARGS,
      inputs: Object.fromEntries(Array.from({ length: DISPATCH_MAX_INPUTS }, (_, i) => [`k${i}`, 'x'.repeat(DISPATCH_MAX_INPUT_CHARS)])),
    });

    expect(result.structured.refusal).toBeUndefined();
    expect(record(result.structured.preview).inputCount).toBe(DISPATCH_MAX_INPUTS);
  });

  it('refuses a repo and workflow that DEPOT_MCP_DISPATCH_ALLOWLIST does not list, before any request', async () => {
    const h = await writable(
      { [RPC.listWorkflows]: ok(LAB_WORKFLOWS), [RPC.dispatchWorkflow]: ok({ runId: 'nope' }) },
      { dispatchAllowlist: [{ repo: 'acme/web', workflow: 'ci.yml' }, { repo: 'acme/api', workflow: 'deploy.yml' }] },
    );
    const spy = audit();

    const dry = await callTool(h, 'depot_dispatch_ci_workflow', ARGS);
    expect(dry.isError, dry.text).toBe(false);
    expect(String(dry.structured.refusal)).toBe(
      'acme/api:ci.yml is not on DEPOT_MCP_DISPATCH_ALLOWLIST (acme/web:ci.yml, acme/api:deploy.yml). The operator of this server decides which workflows an agent may start; ask them to add it.',
    );
    expect(dry.structured.preview).toMatchObject({ allowlistActive: true, allowlisted: false });
    expect(dry.text).toContain('acme/api:ci.yml is NOT on it');

    const applied = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, dryRun: false });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain('not on DEPOT_MCP_DISPATCH_ALLOWLIST');

    expect(h.calls).toHaveLength(0);
    expect(auditLines(spy)).toHaveLength(0);
  });

  it('allows a listed pair, matching the repository case-insensitively and the file exactly', async () => {
    const h = await writable(
      { [RPC.listWorkflows]: ok(LAB_WORKFLOWS) },
      { dispatchAllowlist: [{ repo: 'acme/api', workflow: 'ci.yml' }] },
    );

    const listed = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, repo: 'Acme/API' });
    expect(listed.structured.refusal).toBeUndefined();
    expect(listed.structured.preview).toMatchObject({ allowlistActive: true, allowlisted: true });
    expect(listed.text).toContain('DEPOT_MCP_DISPATCH_ALLOWLIST is set (1 entry(ies)); Acme/API:ci.yml is on it');

    const wrongCase = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, workflow: 'CI.yml' });
    expect(String(wrongCase.structured.refusal)).toContain('not on DEPOT_MCP_DISPATCH_ALLOWLIST');
    expect(h.callsTo(RPC.listWorkflows)).toHaveLength(1);
  });

  it('rejects a missing ref before any network call', async () => {
    const h = await writable({});

    const result = await callTool(h, 'depot_dispatch_ci_workflow', { repo: 'acme/api', workflow: 'ci.yml' });

    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe('depot_dispatch_ci_workflow apply', () => {
  it('sends the CLI binding field names, reports the run id with a wait hint, and logs one audit line without the inputs', async () => {
    const h = await writable({
      [RPC.listWorkflows]: ok(LAB_WORKFLOWS),
      [RPC.dispatchWorkflow]: ok({ orgId: 'org_1a2b3c', runId: 'run_new77' }),
    });
    const spy = audit();

    const result = await callTool(h, 'depot_dispatch_ci_workflow', {
      repo: 'acme/api',
      workflow: 'artifacts.yml',
      ref: 'main',
      inputs: { environment: 'staging', dry: 'false' },
      dryRun: false,
    });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(h.callsTo(RPC.listWorkflows)).toHaveLength(1);
    expect(h.callsTo(RPC.dispatchWorkflow)).toHaveLength(1);
    expect(h.callsTo(RPC.dispatchWorkflow)[0]?.body).toEqual({
      repo: 'acme/api',
      workflow: 'artifacts.yml',
      ref: 'main',
      inputs: { environment: 'staging', dry: 'false' },
    });
    expect(h.callsTo(RPC.dispatchWorkflow)[0]?.headers.authorization).toBe('Bearer test-token-never-logged');
    expect(result.structured.before).toMatchObject({ repo: 'acme/api', lastRun: { runId: 'run_art01' } });
    expect(result.structured.after).toEqual({
      rpc: 'DispatchWorkflow',
      runId: 'run_new77',
      ids: { orgId: 'org_1a2b3c', runId: 'run_new77' },
      responseKeys: ['orgId', 'runId'],
    });
    expect(result.text).toContain('APPLIED depot_dispatch_ci_workflow');
    expect(result.text).toContain('new run run_new77 for artifacts.yml in acme/api on main');
    expect(result.text).toContain('depot_wait_for_ci_run {"runId":"run_new77"}');
    expect(auditLines(spy)).toHaveLength(1);
    expect(auditLines(spy)[0]).toMatch(
      /^\[depot-mcp write\] depot_dispatch_ci_workflow repo=acme\/api workflow=artifacts\.yml ref=main \d{4}-/,
    );
    expect(auditLines(spy)[0]).not.toContain('staging');
    expect(result.text).not.toContain('test-token-never-logged');
  });

  it('omits inputs from the request when none were given, and reads a workflow id when Depot sends one', async () => {
    const h = await writable({
      [RPC.listWorkflows]: ok({}),
      [RPC.dispatchWorkflow]: ok({ run_id: 'run_snake', workflow_id: 'wf_snake' }),
    });
    audit();

    const result = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, dryRun: false });

    expect(result.isError, result.text).toBe(false);
    expect(h.callsTo(RPC.dispatchWorkflow)[0]?.body).toEqual({ repo: 'acme/api', workflow: 'ci.yml', ref: 'main' });
    expect(result.structured.after).toMatchObject({ runId: 'run_snake', workflowId: 'wf_snake' });
    expect(result.text).toContain('new run run_snake (workflowId=wf_snake)');
  });

  it('copes with an empty response by pointing at depot_list_ci_runs', async () => {
    const h = await writable({ [RPC.listWorkflows]: ok({}), [RPC.dispatchWorkflow]: ok({}) });
    audit();

    const result = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, dryRun: false });

    expect(result.isError, result.text).toBe(false);
    expect(record(result.structured.after).runId).toBeUndefined();
    expect(result.text).toContain('Depot returned no run id');
    expect(result.text).toContain('depot_list_ci_runs');
  });

  it('translates a 412 from DispatchWorkflow and logs nothing', async () => {
    const h = await writable({
      [RPC.listWorkflows]: ok({}),
      [RPC.dispatchWorkflow]: connectError(412, 'failed_precondition', 'workflow has no workflow_dispatch trigger'),
    });
    const spy = audit();

    const result = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Depot refused depot_dispatch_ci_workflow (failed_precondition, HTTP 412)');
    expect(result.text).toContain('workflow has no workflow_dispatch trigger');
    expect(auditLines(spy)).toHaveLength(0);
  });

  it('passes a not_found from Depot through as a tool error', async () => {
    const h = await writable({
      [RPC.listWorkflows]: ok({}),
      [RPC.dispatchWorkflow]: connectError(404, 'not_found', 'repository not connected'),
    });
    audit();

    const result = await callTool(h, 'depot_dispatch_ci_workflow', { ...ARGS, dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('repository not connected');
  });
});
