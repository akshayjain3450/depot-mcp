import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { JsonObject } from '../../src/depot/shape.js';
import { isTerminalSandboxState } from '../../src/tools/sandbox-writes.js';
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

const TOOLS = ['depot_stop_sandbox', 'depot_kill_sandbox'] as const;

/** Shaped like GetSandboxResponse in depot/sandbox-sdk sandbox.proto: the record under `sandbox`. */
function runningSandbox(overrides: JsonObject = {}): JsonObject {
  return {
    sandbox: {
      sandboxId: 'sbx_run01',
      organizationId: 'org_1a2b3c',
      name: 'pr-4821-review',
      status: 'SANDBOX_STATUS_RUNNING',
      createdAt: '2026-09-07T09:00:00Z',
      startedAt: '2026-09-07T09:00:40Z',
      expiresAt: '2026-09-07T10:00:40Z',
      resources: { vcpus: 4, memoryMb: 8192, diskGb: 40 },
      runtime: { imageRef: 'ghcr.io/acme/agent-runtime:node22' },
      env: { OPENAI_API_KEY: 'sk-live-do-not-return-me', NODE_ENV: 'test' },
      ...overrides,
    },
  };
}

async function open(routes: StubRoutes): Promise<Harness> {
  harness = await createHarness({ routes, config: { allowWrites: true, enableBeta: true } });
  await harness.client.listTools();
  return harness;
}

function mutatingCalls(h: Harness): string[] {
  return h.calls.map((call) => call.rpc).filter((rpc) => rpc === RPC.stopSandbox || rpc === RPC.killSandbox);
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
  it.each([
    ['neither flag', {}],
    ['writes only', { allowWrites: true }],
    ['beta only', { enableBeta: true }],
  ])('hides both sandbox writes with %s set, and refuses to call them', async (_label, config) => {
    harness = await createHarness({ routes: { [RPC.getSandbox]: ok(runningSandbox()) }, config });
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name);

    for (const name of TOOLS) {
      expect(names).not.toContain(name);
      const failed = await harness.client
        .callTool({ name, arguments: { sandboxId: 'sbx_run01', dryRun: false } })
        .then(
          (result) => result.isError === true,
          () => true,
        );
      expect(failed, name).toBe(true);
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('registers both with both flags, stop non-destructive and kill destructive, both idempotent and beta-labelled', async () => {
    const h = await open({});
    const { tools } = await h.client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    expect(byName.get('depot_stop_sandbox')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byName.get('depot_kill_sandbox')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    for (const name of TOOLS) {
      const tool = byName.get(name);
      expect(record(record(tool?.inputSchema.properties).dryRun).default, name).toBe(true);
      expect(tool?.description ?? '', name).toMatch(/beta/i);
      expect(tool?.description ?? '', name).toMatch(/may change/i);
      expect(tool?.description ?? '', name).toContain('DEPOT_MCP_ENABLE_BETA');
      expect(tool?.description ?? '', name).toContain('DEPOT_MCP_ALLOW_WRITES');
      expect(tool?.description ?? '', name).toContain('dryRun:false');
    }
  });
});

describe.each(TOOLS)('%s', (name) => {
  const rpc = name === 'depot_stop_sandbox' ? RPC.stopSandbox : RPC.killSandbox;
  const rpcName = name === 'depot_stop_sandbox' ? 'StopSandbox' : 'KillSandbox';
  const landsIn = name === 'depot_stop_sandbox' ? 'finished' : 'cancelled';

  it('previews a running sandbox from GetSandbox {id}, withholding environment values, and calls nothing mutating', async () => {
    const h = await open({ [RPC.getSandbox]: ok(runningSandbox()) });

    const result = await callTool(h, name, { sandboxId: ' sbx_run01 ' });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(false);
    expect(result.structured.refusal).toBeUndefined();
    expect(h.callsTo(RPC.getSandbox)[0]?.body).toEqual({ id: 'sbx_run01' });
    expect(result.structured.preview).toMatchObject({
      sandboxId: 'sbx_run01',
      status: 'running',
      terminal: false,
      sandbox: { name: 'pr-4821-review', envNames: ['NODE_ENV', 'OPENAI_API_KEY'] },
    });
    expect(result.structured.resend).toEqual({ sandboxId: 'sbx_run01', dryRun: false });
    expect(result.text).toContain('sbx_run01 "pr-4821-review": running');
    expect(result.text).toContain('Expires 2026-09-07T10:00:40Z');
    expect(result.text).toContain(`${rpcName} would`);
    expect(result.text).toContain(landsIn);
    expect(result.text).not.toContain('sk-live-do-not-return-me');
    expect(JSON.stringify(result.structured)).not.toContain('sk-live-do-not-return-me');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it(`applies with ${rpcName} {sandbox: {id}}, reports the returned sandbox, and logs one audit line`, async () => {
    const h = await open({
      [RPC.getSandbox]: ok(runningSandbox()),
      [rpc]: ok(runningSandbox({ status: 'SANDBOX_STATUS_RUNNING' })),
    });
    const spy = audit();

    const result = await callTool(h, name, { sandboxId: 'sbx_run01', dryRun: false });

    expect(result.isError, result.text).toBe(false);
    expect(result.structured.applied).toBe(true);
    expect(h.callsTo(rpc)).toHaveLength(1);
    expect(h.callsTo(rpc)[0]?.body).toEqual({ sandbox: { id: 'sbx_run01' } });
    expect(h.callsTo(rpc)[0]?.headers.authorization).toBe('Bearer test-token-never-logged');
    expect(result.structured.before).toMatchObject({ sandboxId: 'sbx_run01', terminal: false });
    expect(result.structured.after).toMatchObject({
      rpc: rpcName,
      status: 'running',
      sandbox: { sandboxId: 'sbx_run01', status: 'running' },
    });
    expect(result.text).toContain(`APPLIED ${name}`);
    expect(result.text).toContain(`${rpcName} accepted. Depot reports the sandbox as running at read time; it proceeds toward ${landsIn}`);
    expect(result.text).toContain('depot_get_sandbox {"sandboxId":"sbx_run01"}');
    expect(result.text).not.toContain('sk-live-do-not-return-me');
    expect(auditLines(spy)).toHaveLength(1);
    expect(auditLines(spy)[0]).toMatch(new RegExp(`^\\[depot-mcp write\\] ${name} sandboxId=sbx_run01 \\d{4}-`));
  });

  it.each(['SANDBOX_STATUS_FINISHED', 'SANDBOX_STATUS_CANCELLED', 'SANDBOX_STATUS_FAILED', 5, 6, 7])(
    'refuses a sandbox already in terminal state %s, on a dry run and on apply, before any mutating call',
    async (status) => {
      const h = await open({
        [RPC.getSandbox]: ok(runningSandbox({ status, stoppedAt: '2026-09-07T09:30:00Z', exitCode: 0 })),
        [rpc]: ok(runningSandbox()),
      });
      const spy = audit();

      const dry = await callTool(h, name, { sandboxId: 'sbx_run01' });
      expect(dry.isError, dry.text).toBe(false);
      expect(String(dry.structured.refusal)).toMatch(/^Sandbox sbx_run01 is already (finished|cancelled|failed); there is nothing to (stop|kill)\./);
      expect(String(dry.structured.refusal)).toContain('failed_precondition');
      expect(dry.structured.resend).toBeUndefined();
      expect(record(dry.structured.preview).terminal).toBe(true);

      const applied = await callTool(h, name, { sandboxId: 'sbx_run01', dryRun: false });
      expect(applied.isError).toBe(true);
      expect(applied.text).toContain(`Refused ${name} before calling Depot`);
      expect(applied.text).toContain('is already');

      expect(mutatingCalls(h)).toEqual([]);
      expect(auditLines(spy)).toHaveLength(0);
    },
  );

  it('refuses the recorded failed sandbox fixture', async () => {
    const h = await open({ [RPC.getSandbox]: ok(fixture('sandbox')) });

    const result = await callTool(h, name, { sandboxId: 'sbx_01j9hzzz0a1b2c3d4e5f', dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('already failed');
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('lets Depot decide for a sandbox whose state is unknown, and translates its 412', async () => {
    const h = await open({
      [RPC.getSandbox]: ok({ sandbox: { sandboxId: 'sbx_odd' } }),
      [rpc]: connectError(412, 'failed_precondition', 'sandbox is already in a terminal state'),
    });
    const spy = audit();

    const dry = await callTool(h, name, { sandboxId: 'sbx_odd' });
    expect(dry.structured.refusal).toBeUndefined();

    const applied = await callTool(h, name, { sandboxId: 'sbx_odd', dryRun: false });
    expect(applied.isError).toBe(true);
    expect(applied.text).toContain(`Depot refused ${name} (failed_precondition, HTTP 412)`);
    expect(applied.text).toContain('sandbox is already in a terminal state');
    expect(h.callsTo(rpc)).toHaveLength(1);
    expect(auditLines(spy)).toHaveLength(0);
  });

  it("passes Depot's not_found for an unknown id through as a tool error, calling nothing mutating", async () => {
    const h = await open({ [RPC.getSandbox]: connectError(404, 'not_found', 'Sandbox nope not found') });

    for (const dryRun of [true, false]) {
      const result = await callTool(h, name, { sandboxId: 'nope', dryRun });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('not_found');
      expect(result.text).toContain('Sandbox nope not found');
    }
    expect(mutatingCalls(h)).toEqual([]);
  });

  it('rejects a blank sandboxId before any request', async () => {
    const h = await open({});

    const result = await callTool(h, name, { sandboxId: '   ' });

    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe('isTerminalSandboxState', () => {
  it('treats finished, cancelled, and failed as terminal and everything else as live or unknown', () => {
    expect(isTerminalSandboxState('finished')).toBe(true);
    expect(isTerminalSandboxState('cancelled')).toBe(true);
    expect(isTerminalSandboxState('failed')).toBe(true);
    expect(isTerminalSandboxState('running')).toBe(false);
    expect(isTerminalSandboxState('created')).toBe(false);
    expect(isTerminalSandboxState('unspecified')).toBe(false);
    expect(isTerminalSandboxState(undefined)).toBe(false);
  });
});
