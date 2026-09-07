import { decodeBuildRequestForInspection } from '../../src/depot/build-proto.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DEFAULT_MAX_LOG_PAGES, DEFAULT_OUTPUT_CHAR_BUDGET, type DepotMcpConfig } from '../../src/config.js';
import type { FetchLike } from '../../src/depot/client.js';
import { asObject, type JsonObject } from '../../src/depot/shape.js';
import { createServer } from '../../src/server.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture(name: string): JsonObject {
  const raw = readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');
  const parsed = asObject(JSON.parse(raw) as unknown);
  if (parsed === undefined) {
    throw new Error(`Fixture ${name}.json is not a JSON object`);
  }
  return parsed;
}

export interface StubReply {
  readonly status?: number;
  readonly body?: unknown;
  /** Bypasses JSON encoding, for exercising non-JSON responses from a misconfigured endpoint. */
  readonly raw?: string;
}

/** A function route answers per request body, for RPCs a tool calls once per side or target. */
export type StubRoute = StubReply | readonly StubReply[] | ((body: JsonObject) => StubReply);

/** Keyed by `<fully.qualified.Service>/<Method>`. */
export type StubRoutes = Record<string, StubRoute>;

export interface RecordedCall {
  readonly rpc: string;
  readonly body: JsonObject;
  readonly headers: Record<string, string>;
}

export function ok(body: unknown): StubReply {
  return { status: 200, body };
}

export function connectError(status: number, code: string, message: string): StubReply {
  return { status, body: { code, message } };
}

export const NOT_FOUND = connectError(404, 'not_found', 'no such record');

export interface Harness {
  readonly client: Client;
  readonly calls: RecordedCall[];
  /** Every pause the server asked for, in milliseconds. None of them actually waits. */
  readonly sleeps: number[];
  callsTo(rpc: string): RecordedCall[];
  close(): Promise<void>;
}

/**
 * The harness clock starts here and advances only when the server sleeps, so a tool that polls
 * until a deadline sees time pass without the test waiting for it.
 */
export const HARNESS_EPOCH = Date.parse('2026-09-06T12:00:00Z');

export function testConfig(overrides: Partial<DepotMcpConfig> = {}): DepotMcpConfig {
  return {
    token: 'test-token-never-logged',
    apiUrl: 'https://api.depot.dev',
    orgId: undefined,
    projectId: undefined,
    allowWrites: false,
    allowDestructive: false,
    enableBeta: false,
    maxLogPages: DEFAULT_MAX_LOG_PAGES,
    outputCharBudget: DEFAULT_OUTPUT_CHAR_BUDGET,
    ...overrides,
  };
}

function jsonResponse(reply: StubReply): Response {
  const body = reply.raw ?? JSON.stringify(reply.body);
  return new Response(body, {
    status: reply.status ?? 200,
    headers: { 'content-type': reply.raw === undefined ? 'application/json' : 'text/html' },
  });
}

function isReplyList(route: StubRoute): route is readonly StubReply[] {
  return Array.isArray(route);
}

export function stubFetch(routes: StubRoutes, calls: RecordedCall[]): FetchLike {
  const perRouteCallCount = new Map<string, number>();

  return (url, init) => {
    const rpc = new URL(url).pathname.replace(/^\//, '');
    const method = rpc.split('/').pop() ?? '';
    const decodedBinary =
      init.body instanceof Uint8Array ? decodeBuildRequestForInspection(method, init.body) : undefined;
    const rawBody = typeof init.body === 'string' ? init.body : '{}';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      }
    }
    const body = decodedBinary ?? asObject(JSON.parse(rawBody) as unknown) ?? {};
    calls.push({ rpc, body, headers });

    const route = routes[rpc];
    if (typeof route === 'function') {
      return Promise.resolve(jsonResponse(route(body)));
    }
    if (route === undefined) {
      return Promise.resolve(
        jsonResponse(
          connectError(404, 'not_found', `test harness has no route for ${rpc}`),
        ),
      );
    }

    if (isReplyList(route)) {
      const index = perRouteCallCount.get(rpc) ?? 0;
      perRouteCallCount.set(rpc, index + 1);
      const reply = route[Math.min(index, route.length - 1)];
      if (reply === undefined) {
        throw new Error(`Route ${rpc} has an empty reply list`);
      }
      return Promise.resolve(jsonResponse(reply));
    }

    return Promise.resolve(jsonResponse(route));
  };
}

export async function createHarness(options: {
  routes: StubRoutes;
  config?: Partial<DepotMcpConfig>;
}): Promise<Harness> {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let clock = HARNESS_EPOCH;
  const { server } = createServer({
    config: testConfig(options.config),
    fetch: stubFetch(options.routes, calls),
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
  });

  const client = new Client({ name: 'depot-mcp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    calls,
    sleeps,
    callsTo: (rpc) => calls.filter((call) => call.rpc === rpc),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface ToolCallResult {
  readonly text: string;
  readonly structured: JsonObject;
  readonly isError: boolean;
}

export async function callTool(
  harness: Harness,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCallResult> {
  const result = await harness.client.callTool({ name, arguments: args });
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((part) => {
      const value = asObject(part)?.text;
      return typeof value === 'string' ? value : '';
    })
    .join('\n');
  return {
    text,
    structured: asObject(result.structuredContent) ?? {},
    isError: result.isError === true,
  };
}
