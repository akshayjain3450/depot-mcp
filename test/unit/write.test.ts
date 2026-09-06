import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DepotApi } from '../../src/depot/api.js';
import { DepotClient } from '../../src/depot/client.js';
import { asObject } from '../../src/depot/shape.js';
import type { ToolContext } from '../../src/lib/tool.js';
import { defineWriteTool } from '../../src/lib/write.js';
import { testConfig } from '../helpers/harness.js';

interface Probe {
  readonly client: Client;
  readonly previews: number;
  readonly applies: number;
  close(): Promise<void>;
}

const AUDIT_LINE = /^\[depot-mcp write\] probe_write target=t-1 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function probe(options: {
  refuse?: string | undefined;
  destructive?: boolean;
  idempotent?: boolean;
}): Promise<Probe> {
  const counters = { previews: 0, applies: 0 };
  const tool = defineWriteTool({
    name: 'probe_write',
    title: 'Probe',
    description: 'A write tool that touches nothing.',
    inputSchema: {
      target: z.string().describe('What to write to; only echoed back.'),
    },
    previewSchema: { target: z.string(), current: z.number() },
    afterSchema: { current: z.number() },
    destructive: options.destructive ?? false,
    idempotent: options.idempotent ?? true,
    preview: (input) => {
      counters.previews += 1;
      return Promise.resolve({ summary: `current is 1 for ${input.target}`, data: { target: input.target, current: 1 } });
    },
    refuse: () => options.refuse,
    auditIds: (input) => `target=${input.target}`,
    apply: (_input, _context, preview) => {
      counters.applies += 1;
      return Promise.resolve({ summary: 'now 2', data: { current: preview.current + 1 } });
    },
  });

  const config = testConfig();
  const context: ToolContext = {
    api: new DepotApi(
      new DepotClient({
        token: config.token,
        apiUrl: config.apiUrl,
        fetch: () => Promise.reject(new Error('the probe must not touch the network')),
      }),
    ),
    config,
  };
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  tool.register(server, context);
  const client = new Client({ name: 'probe-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();

  return {
    client,
    get previews() {
      return counters.previews;
    },
    get applies() {
      return counters.applies;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function call(
  handle: Probe,
  args: Record<string, unknown>,
): Promise<{ text: string; structured: Record<string, unknown>; isError: boolean }> {
  const result = await handle.client.callTool({ name: 'probe_write', arguments: args });
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((part) => {
      const value = asObject(part)?.text;
      return typeof value === 'string' ? value : '';
    })
    .join('\n');
  return { text, structured: asObject(result.structuredContent) ?? {}, isError: result.isError === true };
}

let handle: Probe | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

describe('defineWriteTool', () => {
  it('adds a described dryRun flag and honest annotations', async () => {
    handle = await probe({ destructive: true, idempotent: false });
    const { tools } = await handle.client.listTools();
    const tool = tools[0];

    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
      title: 'Probe',
    });
    const dryRun = asObject(asObject(tool?.inputSchema.properties)?.dryRun);
    expect(dryRun?.type).toBe('boolean');
    expect(dryRun?.default).toBe(true);
    expect(String(dryRun?.description)).toContain('Preview only');
    expect(Object.keys(asObject(tool?.outputSchema?.properties) ?? {}).sort()).toEqual([
      'after',
      'applied',
      'before',
      'preview',
      'resend',
    ]);
  });

  it('defaults to a dry run that previews, applies nothing, and returns the arguments to resend', async () => {
    handle = await probe({});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await call(handle, { target: 't-1' });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({
      applied: false,
      preview: { target: 't-1', current: 1 },
      resend: { target: 't-1', dryRun: false },
    });
    expect(result.text).toContain('nothing was changed');
    expect(result.text).toContain('current is 1 for t-1');
    expect(result.text).toContain('dryRun: false');
    expect(handle.previews).toBe(1);
    expect(handle.applies).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('applies with dryRun false after a fresh preview, and writes one audit line to stderr', async () => {
    handle = await probe({});
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await call(handle, { target: 't-1', dryRun: false });

    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({
      applied: true,
      before: { target: 't-1', current: 1 },
      after: { current: 2 },
    });
    expect(result.text).toContain('Applied probe_write');
    expect(result.text).toContain('now 2');
    expect(handle.previews).toBe(1);
    expect(handle.applies).toBe(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toMatch(AUDIT_LINE);
  });

  it('turns a refusal into a tool error before apply, in both modes', async () => {
    handle = await probe({ refuse: 'the target is locked' });
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const dry = await call(handle, { target: 't-1' });
    const wet = await call(handle, { target: 't-1', dryRun: false });

    for (const result of [dry, wet]) {
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Refused, nothing was changed: the target is locked');
      expect(result.structured).toEqual({});
    }
    expect(handle.previews).toBe(2);
    expect(handle.applies).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
  });

  it('rejects a mistyped dryRun rather than treating it as truthy', async () => {
    handle = await probe({});

    const result = await call(handle, { target: 't-1', dryRun: 'false' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('dryRun');
    expect(handle.applies).toBe(0);
  });
});
