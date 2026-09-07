import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { DepotMcpConfig } from '../../src/config.js';
import { asObject, readString, type JsonObject } from '../../src/depot/shape.js';
import { createServer } from '../../src/server.js';
import {
  callTool,
  NOT_FOUND,
  ok,
  testConfig,
  type Harness,
  type RecordedCall,
  type StubReply,
} from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface FakeLine {
  readonly lineNumber: number;
  readonly body: string;
  readonly stream?: string;
}

interface FakePage {
  readonly lines: FakeLine[];
  readonly nextPageToken?: string;
}

/** Depot pages keyed by the pageToken that fetches them; '' is the first page. */
type PagedLog = Record<string, FakePage>;

function fakeLine(lineNumber: number, body = `line ${lineNumber} of the log output`): FakeLine {
  return { lineNumber, body };
}

function page(lines: FakeLine[], nextPageToken?: string): FakePage {
  return nextPageToken === undefined ? { lines } : { lines, nextPageToken };
}

function logPage(fake: FakePage): JsonObject {
  return {
    lines: fake.lines.map((line) => ({
      stepKey: 'run-tests',
      timestampMs: String(1_788_444_140_000 + line.lineNumber * 1000),
      lineNumber: line.lineNumber,
      stream: line.stream ?? 'STREAM_STDOUT',
      body: line.body,
    })),
    ...(fake.nextPageToken === undefined ? {} : { nextPageToken: fake.nextPageToken }),
  };
}

/** Three pages of three lines each: 1-3, 4-6, 7-9. */
const threePages: PagedLog = {
  '': page([fakeLine(1), fakeLine(2), fakeLine(3)], 'p2'),
  p2: page([fakeLine(4), fakeLine(5), fakeLine(6)], 'p3'),
  p3: page([fakeLine(7), fakeLine(8), fakeLine(9)]),
};

/**
 * A stub that answers GetJobAttemptLogs by the pageToken in the request, the way Depot does,
 * rather than by call order. `reply` can veto a request first, for probe misses.
 */
async function createPagedHarness(options: {
  log: PagedLog;
  config?: Partial<DepotMcpConfig>;
  reply?: (body: JsonObject) => StubReply | undefined;
}): Promise<Harness> {
  const calls: RecordedCall[] = [];
  const { server } = createServer({
    config: testConfig(options.config),
    sleep: () => Promise.resolve(),
    fetch: (url, init) => {
      const rpc = new URL(url).pathname.replace(/^\//, '');
      const body = asObject(JSON.parse(typeof init.body === 'string' ? init.body : '{}') as unknown) ?? {};
      calls.push({ rpc, body, headers: {} });

      let reply: StubReply | undefined = options.reply?.(body);
      if (reply === undefined) {
        if (rpc !== RPC.getJobAttemptLogs) {
          reply = { status: 404, body: { code: 'not_found', message: `no route for ${rpc}` } };
        } else {
          const fake = options.log[readString(body, 'pageToken') ?? ''];
          reply =
            fake === undefined
              ? { status: 404, body: { code: 'not_found', message: 'unknown page token' } }
              : ok(logPage(fake));
        }
      }
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  });

  const client = new Client({ name: 'depot-mcp-paging-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    calls,
    sleeps: [],
    callsTo: (rpc) => calls.filter((call) => call.rpc === rpc),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function lineNumbers(structured: JsonObject): number[] {
  const value = structured.lines;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((line) => {
    const number = asObject(line)?.lineNumber;
    return typeof number === 'number' ? number : Number.NaN;
  });
}

/** Follows nextPageToken from `startToken` until the tool reports no more pages. */
async function walkForward(
  active: Harness,
  startToken: string,
  args: Record<string, unknown>,
): Promise<{ calls: number[][]; tokens: string[] }> {
  const collected: number[][] = [];
  const tokens: string[] = [];
  let pageToken: string | undefined = startToken;
  for (let guard = 0; pageToken !== undefined && guard < 20; guard += 1) {
    const result = await callTool(active, 'depot_get_ci_logs', { id: 'att_91bc02', ...args, pageToken });
    expect(result.isError, result.text).toBe(false);
    collected.push(lineNumbers(result.structured));
    const next = result.structured.nextPageToken;
    pageToken = typeof next === 'string' ? next : undefined;
    if (pageToken !== undefined) {
      tokens.push(pageToken);
    }
  }
  return { calls: collected, tokens };
}

describe('depot_get_ci_logs forward paging', () => {
  it('returns every line exactly once across successive calls when tailLines splits a page', async () => {
    harness = await createPagedHarness({ log: threePages });

    const walk = await walkForward(harness, 'p2', { tailLines: 4 });

    expect(walk.calls[0]).toEqual([4, 5, 6, 7]);
    expect(walk.calls.flat()).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('never drops lines from the start of a forward window to fit the character budget', async () => {
    harness = await createPagedHarness({ log: threePages, config: { outputCharBudget: 720 } });

    const walk = await walkForward(harness, 'p2', {});

    expect(walk.calls[0]?.[0]).toBe(4);
    expect(walk.calls.flat()).toEqual([4, 5, 6, 7, 8, 9]);
    expect(walk.calls.length).toBeGreaterThan(1);
  });

  it('keeps grep results complete across the cursor', async () => {
    harness = await createPagedHarness({ log: threePages });

    const walk = await walkForward(harness, '', { grep: 'line', tailLines: 2 });

    expect(walk.calls.flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('hands back a continuation that Depot itself would not understand only when needed', async () => {
    harness = await createPagedHarness({ log: threePages });

    const result = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_91bc02',
      pageToken: 'p2',
      tailLines: 3,
    });

    expect(lineNumbers(result.structured)).toEqual([4, 5, 6]);
    expect(result.structured.nextPageToken).toBe('p3');
  });
});

describe('depot_get_ci_logs tail mode at the page cap', () => {
  it('does not claim the lines are the end of the log when the page cap stopped the walk', async () => {
    harness = await createPagedHarness({ log: threePages, config: { maxLogPages: 2 } });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02' });

    expect(lineNumbers(result.structured)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.structured.pagesFetched).toBe(2);
    expect(result.structured.pageCapHit).toBe(true);
    expect(result.structured.nextPageToken).toBe('p3');
    expect(result.structured.truncated).toBe(true);
    const notes = JSON.stringify(result.structured.notes);
    expect(notes).not.toContain('Earlier log lines were not read');
    expect(notes).toContain('DEPOT_MCP_MAX_LOG_PAGES');
    expect(notes).toContain('p3');
    expect(result.text).toMatch(/continues/i);
    expect(result.text).toMatch(/first 2 page/i);
  });

  it('reports pageCapHit false and no token when the whole log was read', async () => {
    harness = await createPagedHarness({ log: threePages });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02' });

    expect(lineNumbers(result.structured)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.structured.pageCapHit).toBe(false);
    expect(result.structured.nextPageToken).toBeUndefined();
    expect(result.text).not.toMatch(/continues/i);
  });

  it('does not count a probe miss against the page cap', async () => {
    harness = await createPagedHarness({
      log: threePages,
      config: { maxLogPages: 2 },
      reply: (body) => (readString(body, 'attemptId') === undefined ? undefined : NOT_FOUND),
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: '01JQ9Z8ABCDEF' });

    expect(result.isError, result.text).toBe(false);
    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(3);
    expect(result.structured.pagesFetched).toBe(2);
    expect(lineNumbers(result.structured)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('depot_get_ci_logs oversized lines', () => {
  it('caps a single huge line so it cannot bypass the budget through structuredContent', async () => {
    const huge = 'x'.repeat(50_000);
    harness = await createPagedHarness({
      log: { '': page([fakeLine(1), { lineNumber: 2, body: huge }, fakeLine(3)]) },
      config: { outputCharBudget: 3_000 },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02' });

    expect(result.isError, result.text).toBe(false);
    expect(JSON.stringify(result.structured).length).toBeLessThan(6_000);
    expect(result.text.length).toBeLessThanOrEqual(3_100);
    const lines = Array.isArray(result.structured.lines) ? result.structured.lines : [];
    const capped = lines.map((line) => asObject(line)).find((line) => line?.lineNumber === 2);
    expect(capped).toBeDefined();
    expect(String(capped?.body).length).toBeLessThanOrEqual(2_000);
    expect(capped?.bodyTruncated).toBe(true);
    expect(JSON.stringify(result.structured.notes)).toMatch(/1 line.*truncated/i);
  });

  it('does not flag ordinary lines as truncated', async () => {
    harness = await createPagedHarness({ log: threePages });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_91bc02', tailLines: 1 });

    const lines = Array.isArray(result.structured.lines) ? result.structured.lines : [];
    expect(asObject(lines[0])?.bodyTruncated).toBeUndefined();
  });
});
