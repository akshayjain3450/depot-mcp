import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DepotApi } from '../../src/depot/api.js';
import { DepotClient } from '../../src/depot/client.js';
import { DepotApiError } from '../../src/depot/errors.js';
import { asObject } from '../../src/depot/shape.js';
import type { ToolContext } from '../../src/lib/tool.js';
import { defineWriteTool, DRY_RUN_DESCRIPTION, writeAuditLine } from '../../src/lib/write.js';
import { stubFetch, testConfig, type RecordedCall } from '../helpers/harness.js';

/**
 * A synthetic write tool: `preview` reports a counter, `refuse` rejects when the input asks it
 * to, and `apply` calls a spy standing in for the mutating RPC. Every branch of the helper is
 * observable without any Depot shape getting in the way.
 */
function makeFixture() {
  const rpc = vi.fn<(id: string) => Promise<{ id: string }>>((id) =>
    Promise.resolve({ id: `new_${id}` }),
  );
  let previews = 0;
  const tool = defineWriteTool({
    name: 'depot_probe_write',
    title: 'Probe write',
    description: 'A synthetic write tool used only by the unit test for the shared write helper.',
    inputSchema: {
      id: z.string().min(1).describe('The thing to change.'),
      refuseMe: z.boolean().default(false).describe('Ask the tool to refuse.'),
      explode: z.boolean().default(false).describe('Make the RPC answer 412.'),
    },
    previewSchema: { id: z.string(), previewNumber: z.number() },
    afterSchema: { newId: z.string() },
    destructive: true,
    idempotent: false,
    preview: (input) => {
      previews += 1;
      return Promise.resolve({
        data: { id: input.id, previewNumber: previews },
        lines: [`preview ${previews} of ${input.id}`],
      });
    },
    refuse: (_preview, input) => (input.refuseMe ? 'the caller asked to be refused' : undefined),
    apply: async (input, _context, preview) => {
      if (input.explode) {
        throw new DepotApiError({
          code: 'failed_precondition',
          httpStatus: 412,
          rpc: 'depot.ci.v1.CIService/Probe',
          serverMessage: 'workflow is still running',
        });
      }
      const response = await rpc(preview.id);
      return { data: { newId: response.id }, lines: [`created ${response.id}`] };
    },
  });
  return { tool, rpc, previewCount: () => previews };
}

interface Probe {
  client: Client;
  close: () => Promise<void>;
  call: (args: Record<string, unknown>) => Promise<{
    text: string;
    structured: Record<string, unknown>;
    isError: boolean;
  }>;
  listed: () => Promise<Awaited<ReturnType<Client['listTools']>>['tools'][number]>;
}

async function connect(tool: ReturnType<typeof makeFixture>['tool']): Promise<Probe> {
  const calls: RecordedCall[] = [];
  const context: ToolContext = {
    api: new DepotApi(
      new DepotClient({ token: 'test-token', apiUrl: 'https://api.depot.dev', fetch: stubFetch({}, calls) }),
    ),
    config: testConfig({ allowWrites: true }),
    sleep: () => Promise.resolve(),
    now: () => Date.now(),
  };
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  tool.register(server, context);
  const client = new Client({ name: 'probe-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
    call: async (args) => {
      const result = await client.callTool({ name: 'depot_probe_write', arguments: args });
      const blocks = Array.isArray(result.content) ? result.content : [];
      return {
        text: blocks
          .map((part) => {
            const value = asObject(part)?.text;
            return typeof value === 'string' ? value : '';
          })
          .join('\n'),
        structured: asObject(result.structuredContent) ?? {},
        isError: result.isError === true,
      };
    },
    listed: async () => {
      const { tools } = await client.listTools();
      const found = tools.find((entry) => entry.name === 'depot_probe_write');
      if (found === undefined) {
        throw new Error('probe tool not listed');
      }
      return found;
    },
  };
}

let probe: Probe | undefined;

afterEach(async () => {
  await probe?.close();
  probe = undefined;
});

describe('defineWriteTool', () => {
  it('adds a described dryRun argument that defaults to true and sets write annotations', async () => {
    const { tool } = makeFixture();
    probe = await connect(tool);
    const listed = await probe.listed();

    const properties = asObject(listed.inputSchema.properties) ?? {};
    const dryRun = asObject(properties.dryRun) ?? {};
    expect(dryRun.type).toBe('boolean');
    expect(dryRun.default).toBe(true);
    expect(dryRun.description).toBe(DRY_RUN_DESCRIPTION);
    expect(String(dryRun.description)).toContain('dryRun:false');
    expect(listed.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Probe write',
    });
    expect(listed.description).toContain('Two-step flow');
  });

  it('refuses a spec that declares dryRun itself', () => {
    expect(() =>
      defineWriteTool({
        name: 'depot_bad',
        title: 'bad',
        description: 'bad',
        inputSchema: { dryRun: z.boolean() },
        previewSchema: {},
        afterSchema: {},
        destructive: false,
        idempotent: true,
        preview: () => Promise.resolve({ data: {}, lines: [] }),
        refuse: () => undefined,
        apply: () => Promise.resolve({ data: {} }),
      }),
    ).toThrow(/declares dryRun itself/);
  });

  it('dry-runs by default: previews, echoes the arguments to resend, and calls no RPC', async () => {
    const { tool, rpc } = makeFixture();
    probe = await connect(tool);

    const result = await probe.call({ id: 'x1' });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({
      tool: 'depot_probe_write',
      applied: false,
      preview: { id: 'x1', previewNumber: 1 },
      resend: { id: 'x1', refuseMe: false, explode: false, dryRun: false },
    });
    expect(result.text).toContain('DRY RUN of depot_probe_write: nothing was changed');
    expect(result.text).toContain('preview 1 of x1');
    expect(result.text).toContain('confirm with the user');
    expect(result.text).toContain('"dryRun":false');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reports a refusal on a dry run without erroring, and withholds the resend arguments', async () => {
    const { tool, rpc } = makeFixture();
    probe = await connect(tool);

    const result = await probe.call({ id: 'x1', refuseMe: true });

    expect(result.isError).toBe(false);
    expect(result.structured.applied).toBe(false);
    expect(result.structured.refusal).toBe('the caller asked to be refused');
    expect(result.structured.resend).toBeUndefined();
    expect(result.text).toContain('would be REFUSED: the caller asked to be refused');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('on apply, refuses before the RPC with a tool error naming the reason', async () => {
    const { tool, rpc, previewCount } = makeFixture();
    probe = await connect(tool);

    const result = await probe.call({ id: 'x1', refuseMe: true, dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Refused depot_probe_write before calling Depot');
    expect(result.text).toContain('the caller asked to be refused');
    expect(result.text).toContain('Nothing was changed');
    expect(rpc).not.toHaveBeenCalled();
    expect(previewCount()).toBe(1);
  });

  it('on apply, re-reads state, calls the RPC once, returns before and after, and writes one audit line', async () => {
    const { tool, rpc, previewCount } = makeFixture();
    probe = await connect(tool);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await probe.call({ id: 'x1' });
    const result = await probe.call({ id: 'x1', dryRun: false });

    expect(result.isError).toBe(false);
    expect(previewCount()).toBe(2);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('x1');
    expect(result.structured).toEqual({
      tool: 'depot_probe_write',
      applied: true,
      before: { id: 'x1', previewNumber: 2 },
      after: { newId: 'new_x1' },
    });
    expect(result.text).toContain('APPLIED depot_probe_write');
    expect(result.text).toContain('preview 2 of x1');
    expect(result.text).toContain('created new_x1');

    const auditLines = stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[depot-mcp write]'));
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toMatch(
      /^\[depot-mcp write\] depot_probe_write id=x1 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('writes no audit line for a dry run or a refusal', async () => {
    const { tool } = makeFixture();
    probe = await connect(tool);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await probe.call({ id: 'x1' });
    await probe.call({ id: 'x1', refuseMe: true, dryRun: false });

    expect(stderr.mock.calls.filter((call) => String(call[0]).includes('[depot-mcp write]'))).toHaveLength(0);
  });

  it('translates a 412 from Depot on apply into a readable error and writes no audit line', async () => {
    const { tool } = makeFixture();
    probe = await connect(tool);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await probe.call({ id: 'x1', explode: true, dryRun: false });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Depot refused depot_probe_write (failed_precondition, HTTP 412)');
    expect(result.text).toContain('Depot said: workflow is still running');
    expect(result.text).toContain('nothing was changed');
    expect(result.text).toContain('dryRun:true');
    expect(stderr.mock.calls.filter((call) => String(call[0]).includes('[depot-mcp write]'))).toHaveLength(0);
  });

  it('rejects an invalid dryRun value before any preview', async () => {
    const { tool, previewCount } = makeFixture();
    probe = await connect(tool);

    const result = await probe.call({ id: 'x1', dryRun: 'no' });

    expect(result.isError).toBe(true);
    expect(previewCount()).toBe(0);
  });
});

describe('writeAuditLine', () => {
  it('names only string-valued arguments, never booleans, and stamps an ISO time', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    writeAuditLine('depot_x', { runId: 'r1', force: true, count: 3 }, new Date('2026-09-06T01:02:03.000Z'));

    expect(stderr).toHaveBeenCalledWith('[depot-mcp write] depot_x runId=r1 2026-09-06T01:02:03.000Z');
  });

  it('says so when there are no ids', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    writeAuditLine('depot_x', { force: true }, new Date(0));

    expect(stderr).toHaveBeenCalledWith('[depot-mcp write] depot_x (no ids) 1970-01-01T00:00:00.000Z');
  });
});
