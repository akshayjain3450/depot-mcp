import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DepotApi } from '../../src/depot/api.js';
import { DepotClient, type FetchLike } from '../../src/depot/client.js';
import { defineTool, type ToolContext } from '../../src/lib/tool.js';
import { createServer } from '../../src/server.js';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
  ok,
  testConfig,
  type Harness,
} from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

const TOKEN = 'test-token-never-logged';

/** Like createHarness, but with a caller-supplied fetch so transport failures can be staged. */
async function connectWithFetch(fetchImpl: FetchLike, token = TOKEN): Promise<Harness> {
  const { server } = createServer({
    config: testConfig({ token }),
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
  });
  const client = new Client({ name: 'depot-mcp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    calls: [],
    sleeps: [],
    callsTo: () => [],
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('Depot error surfacing through a tool call', () => {
  it('turns 401 into a message that names DEPOT_TOKEN', async () => {
    harness = await createHarness({
      routes: { [RPC.listRuns]: { status: 401, body: fixture('error-unauthenticated') } },
    });

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('unauthenticated');
    expect(result.text).toContain('DEPOT_TOKEN');
    expect(result.text).toContain('invalid or expired API token');
    expect(result.text).not.toContain('test-token-never-logged');
  });

  it('turns 403 into advice about organization scope', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listRuns]: connectError(403, 'permission_denied', 'not a member of this organization'),
      },
    });

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('permission_denied');
    expect(result.text).toContain('DEPOT_ORG_ID');
  });

  it('explains 404 as possibly the wrong organization', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getRun]: connectError(404, 'not_found', 'run not found'),
        [RPC.getRunStatus]: connectError(404, 'not_found', 'run not found'),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_run', { runId: 'run_missing' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('organization');
  });

  it('retries a 429 with backoff before giving up, and explains the limit', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getJobAttemptLogs]: connectError(
          429,
          'resource_exhausted',
          'too many concurrent log streams for this token',
        ),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02' });

    expect(result.isError).toBe(true);
    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(3);
    expect(result.text).toContain('resource_exhausted');
    expect(result.text).toContain('Log streams are capped');
  });

  it('retries a transient 503 and succeeds without the caller noticing', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listRuns]: [
          connectError(503, 'unavailable', 'log store unavailable'),
          ok(fixture('list-runs')),
        ],
      },
    });

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(false);
    expect(harness.callsTo(RPC.listRuns)).toHaveLength(2);
    expect(result.structured.returned).toBe(3);
  });

  it('does not retry an invalid_argument', async () => {
    harness = await createHarness({
      routes: { [RPC.listRuns]: connectError(400, 'invalid_argument', 'pr requires repo') },
    });

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(true);
    expect(harness.callsTo(RPC.listRuns)).toHaveLength(1);
  });

  it('points at DEPOT_API_URL when the endpoint returns HTML instead of Connect JSON', async () => {
    harness = await createHarness({
      routes: {
        [RPC.listRuns]: { status: 404, raw: '<!DOCTYPE html><html><body>Not found</body></html>' },
      },
    });

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain('DEPOT_API_URL');
    expect(result.text).not.toContain('DOCTYPE html><html><body>Not found</body></html><');
  });

  it('sends the bearer token and Connect protocol header on every request', async () => {
    harness = await createHarness({ routes: { [RPC.listRuns]: ok(fixture('list-runs')) } });

    await callTool(harness, 'depot_list_ci_runs', {});
    const headers = harness.callsTo(RPC.listRuns)[0]?.headers ?? {};

    expect(headers.authorization).toBe('Bearer test-token-never-logged');
    expect(headers['connect-protocol-version']).toBe('1');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-depot-org']).toBeUndefined();
  });
});

describe('token never reaches a tool result', () => {
  it('scrubs a fetch error that quotes the Authorization header', async () => {
    harness = await connectWithFetch(() =>
      Promise.reject(new TypeError(`Headers.append: "Bearer ${TOKEN}" is an invalid header value.`)),
    );

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).toContain('Could not reach the Depot API');
  });

  it('scrubs both halves of a token that carries a line break', async () => {
    const token = 'dp_first_half_0123\r\nsecond_half_4567';
    harness = await connectWithFetch(
      () =>
        Promise.reject(
          new TypeError(`Headers.append: "Bearer ${token}" is an invalid header value.`),
        ),
      token,
    );

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('dp_first_half_0123');
    expect(result.text).not.toContain('second_half_4567');
  });

  it('scrubs a token containing a space from any transport failure', async () => {
    const token = 'dp_left_part_0123 right_part_4567';
    harness = await connectWithFetch(
      () => Promise.reject(new Error(`connect failed for right_part_4567 / dp_left_part_0123`)),
      token,
    );

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain('dp_left_part_0123');
    expect(result.text).not.toContain('right_part_4567');
  });
});

describe('defineTool internal errors', () => {
  async function connectTool(
    tool: ReturnType<typeof defineTool>,
  ): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const context: ToolContext = {
      api: new DepotApi(
        new DepotClient({
          token: 't',
          apiUrl: 'https://api.depot.dev',
          fetch: () => Promise.resolve(new Response('{}')),
        }),
      ),
      config: testConfig(),
      sleep: () => Promise.resolve(),
      now: () => Date.now(),
    };
    tool.register(server, context);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('turns a thrown handler error into a clean isError result and logs the stack to stderr', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tool = defineTool({
      name: 'depot_test_throws',
      title: 'Throws',
      description: 'x',
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      handler: () => Promise.reject<never>(new Error('handler exploded')),
    });
    const { client, close } = await connectTool(tool);

    try {
      const result = await client.callTool({ name: 'depot_test_throws', arguments: {} });
      const text = Array.isArray(result.content)
        ? result.content.map((part) => (part as { text?: string }).text ?? '').join('')
        : '';

      expect(result.isError).toBe(true);
      expect(text).toBe('depot-mcp internal error in depot_test_throws: handler exploded');
      expect(stderr).toHaveBeenCalledWith(
        'depot_test_throws threw:',
        expect.stringContaining('handler exploded'),
      );
    } finally {
      await close();
    }
  });

  it('reports output that fails its own schema as an internal error instead of an SDK exception', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tool = defineTool({
      name: 'depot_test_bad_output',
      title: 'Bad output',
      description: 'x',
      inputSchema: {},
      outputSchema: { count: z.number() },
      handler: () =>
        Promise.resolve({ summary: 'fine', data: { count: 'not a number' } as unknown as { count: number } }),
    });
    const { client, close } = await connectTool(tool);

    try {
      const result = await client.callTool({ name: 'depot_test_bad_output', arguments: {} });
      const text = Array.isArray(result.content)
        ? result.content.map((part) => (part as { text?: string }).text ?? '').join('')
        : '';

      expect(result.isError).toBe(true);
      expect(text).toContain('depot-mcp internal error in depot_test_bad_output');
      expect(text).toContain('output failed its schema');
    } finally {
      await close();
    }
  });
});
