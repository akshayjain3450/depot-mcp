import { afterEach, describe, expect, it, vi } from 'vitest';
import { DepotClient, type DepotClientOptions, type FetchLike } from '../../src/depot/client.js';
import { DepotApiError, DepotTransportError, formatDepotError } from '../../src/depot/errors.js';

const TOKEN = 'dp_supersecret_token_value_0123456789';
const TOKEN_PATTERN = /supersecret/;
const target = { service: 'depot.ci.v1.CIService', method: 'ListRuns' };

interface Reply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function build(replies: readonly Reply[], options: Partial<DepotClientOptions> = {}) {
  const calls: Recorded[] = [];
  const sleeps: number[] = [];
  let index = 0;
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({ url, init });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) {
      throw new Error('no reply configured');
    }
    return Promise.resolve(
      new Response(reply.body ?? '', { status: reply.status, headers: reply.headers ?? {} }),
    );
  };
  const client = new DepotClient({
    token: TOKEN,
    apiUrl: 'https://api.depot.dev',
    fetch: fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...options,
  });
  return { client, calls, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => error,
  );
}

/** Everything an error could leak through: message, stack, own properties, and the cause chain. */
function serializeError(error: unknown): string {
  const parts: string[] = [String(error)];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message, current.stack ?? '');
    parts.push(JSON.stringify(current, Object.getOwnPropertyNames(current)));
    current = current.cause;
  }
  return parts.join('\n');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DepotClient backoff schedule', () => {
  it('backs off exponentially on unavailable, capped at 4 seconds', async () => {
    const { client, calls, sleeps } = build(
      [{ status: 503, body: '{"code":"unavailable"}' }],
      { maxAttempts: 5 },
    );

    await expect(client.call(target)).rejects.toThrow(/unavailable/);

    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([250, 750, 2250, 4000]);
  });

  it('waits four times longer on a rate limit, capped at 8 seconds', async () => {
    const { client, calls, sleeps } = build(
      [{ status: 429, body: '{"code":"resource_exhausted","message":"slow down"}' }],
      { maxAttempts: 5 },
    );

    await expect(client.call(target)).rejects.toThrow(/resource_exhausted/);

    expect(calls).toHaveLength(5);
    expect(sleeps).toEqual([1000, 3000, 8000, 8000]);
  });

  it('uses the plain schedule for transport failures and honours a custom attempt budget', async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const client = new DepotClient({
      token: TOKEN,
      apiUrl: 'https://api.depot.dev',
      maxAttempts: 2,
      fetch: () => {
        attempts += 1;
        return Promise.reject(new Error('ECONNRESET'));
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });

    await expect(client.call(target)).rejects.toThrow(DepotTransportError);

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it('makes exactly one attempt when maxAttempts is 1', async () => {
    const { client, calls, sleeps } = build([{ status: 503 }], { maxAttempts: 1 });

    await expect(client.call(target)).rejects.toThrow(DepotApiError);

    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('sleeps with a real timer by default', async () => {
    vi.useFakeTimers();
    let index = 0;
    const client = new DepotClient({
      token: TOKEN,
      apiUrl: 'https://api.depot.dev',
      fetch: () => {
        index += 1;
        return Promise.resolve(
          index === 1
            ? new Response('{"code":"unavailable"}', { status: 503 })
            : new Response('{"runs":[]}', { status: 200 }),
        );
      },
    });

    let settled = false;
    const pending = client.call(target).then((value) => {
      settled = true;
      return value;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ runs: [] });
    expect(index).toBe(2);
  });

  it('honours a Retry-After header in seconds, capped at 8 seconds', async () => {
    const short = build([
      { status: 429, body: '{"code":"resource_exhausted"}', headers: { 'retry-after': '2' } },
      { status: 200, body: '{}' },
    ]);
    await short.client.call(target);
    expect(short.sleeps).toEqual([2000]);

    const long = build([
      { status: 503, body: '{"code":"unavailable"}', headers: { 'retry-after': '120' } },
      { status: 200, body: '{}' },
    ]);
    await long.client.call(target);
    expect(long.sleeps).toEqual([8000]);
  });

  it('honours an HTTP-date Retry-After relative to the injected clock', async () => {
    const now = Date.UTC(2026, 8, 5, 12, 0, 0);
    const { client, sleeps } = build(
      [
        {
          status: 429,
          body: '{"code":"resource_exhausted"}',
          headers: { 'retry-after': new Date(now + 3_000).toUTCString() },
        },
        { status: 200, body: '{}' },
      ],
      { now: () => now },
    );

    await client.call(target);

    expect(sleeps).toEqual([3000]);
  });

  it('falls back to the schedule when Retry-After is unparseable', async () => {
    const { client, sleeps } = build([
      { status: 429, body: '{"code":"resource_exhausted"}', headers: { 'retry-after': 'soon' } },
      { status: 200, body: '{}' },
    ]);

    await client.call(target);

    expect(sleeps).toEqual([1000]);
  });

  it('stops retrying once the next wait would cross the call deadline', async () => {
    let clock = 0;
    const { client, calls, sleeps } = build([{ status: 503, body: '{"code":"unavailable"}' }], {
      maxAttempts: 10,
      callDeadlineMs: 1_000,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });

    await expect(client.call(target)).rejects.toThrow(/unavailable/);

    // 250 then 750 would land exactly on the 1000ms deadline, so the second retry is skipped.
    expect(sleeps).toEqual([250]);
    expect(calls).toHaveLength(2);
  });
});

describe('DepotClient retry classification by HTTP status', () => {
  // 500 maps to Connect `internal`, which is deliberately not retryable here even though the
  // user-facing guidance for `internal` says "Retry". Pinned; see the report.
  it.each([400, 401, 403, 404, 412, 500, 501])('does not retry HTTP %i', async (status) => {
    const { client, calls, sleeps } = build([{ status }]);

    await expect(client.call(target)).rejects.toThrow(DepotApiError);

    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([408, 409, 429, 502, 503, 504])('retries HTTP %i up to the attempt budget', async (status) => {
    const { client, calls } = build([{ status }]);

    await expect(client.call(target)).rejects.toThrow(DepotApiError);

    expect(calls).toHaveLength(3);
  });

  it('retries on the declared Connect code even when the HTTP status is not retryable', async () => {
    const { client, calls } = build([
      { status: 500, body: '{"code":"unavailable","message":"store down"}' },
      { status: 200, body: '{"ok":true}' },
    ]);

    await expect(client.call(target)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe('DepotClient timeouts', () => {
  it('passes an abort signal to fetch and retries a timeout exactly once', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    let attempts = 0;
    const client = new DepotClient({
      token: TOKEN,
      apiUrl: 'https://api.depot.dev',
      requestTimeoutMs: 1,
      sleep: () => Promise.resolve(),
      fetch: (_url, init) => {
        attempts += 1;
        signals.push(init.signal);
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        });
      },
    });

    const error = await failure(client.call(target));

    expect(error).toBeInstanceOf(DepotTransportError);
    expect((error as DepotTransportError).timedOut).toBe(true);
    expect(String(error)).toMatch(/timeout|timed out|aborted/i);
    // A request that outran its timeout gets one more try, not the full attempt budget.
    expect(attempts).toBe(2);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('gives a fresh signal to every attempt', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const { client } = build([{ status: 503 }, { status: 200, body: '{}' }], {
      fetch: (_url, init) => {
        signals.push(init.signal);
        return Promise.resolve(
          new Response(signals.length === 1 ? '{"code":"unavailable"}' : '{}', {
            status: signals.length === 1 ? 503 : 200,
          }),
        );
      },
    });

    await client.call(target);

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });
});

describe('DepotClient body handling', () => {
  it('treats whitespace-only success bodies as an empty message', async () => {
    const { client } = build([{ status: 200, body: '  \n ' }]);

    await expect(client.call(target)).resolves.toEqual({});
  });

  it('rejects a JSON null or array on success without retrying', async () => {
    const asNull = build([{ status: 200, body: 'null' }]);
    const error = await failure(asNull.client.call(target));
    expect(error).toBeInstanceOf(DepotApiError);
    expect((error as DepotApiError).code).toBe('internal');
    expect(String(error)).toMatch(/not a JSON object/);
    expect(asNull.calls).toHaveLength(1);

    const asArray = build([{ status: 200, body: '[]' }]);
    await expect(asArray.client.call(target)).rejects.toThrow(/not a JSON object/);
  });

  it('rejects malformed JSON on success without retrying', async () => {
    const { client, calls } = build([{ status: 200, body: '{"runs": [' }]);

    const error = await failure(client.call(target));

    expect((error as DepotApiError).code).toBe('internal');
    expect(String(error)).toMatch(/not valid JSON/);
    expect(calls).toHaveLength(1);
  });

  it('retries an HTML 502 and then points at DEPOT_API_URL with a bounded snippet', async () => {
    const html = `<!DOCTYPE html><html><body>${'gateway '.repeat(200)}</body></html>`;
    const { client, calls } = build([{ status: 502, body: html }]);

    const error = await failure(client.call(target));

    expect(calls).toHaveLength(3);
    expect(error).toBeInstanceOf(DepotApiError);
    const apiError = error as DepotApiError;
    expect(apiError.code).toBe('unavailable');
    expect(apiError.httpStatus).toBe(502);
    expect(apiError.serverMessage).toContain('DEPOT_API_URL');
    expect(apiError.serverMessage?.length ?? 0).toBeLessThan(300);
  });

  it('reports a bare HTTP status when an error body is empty', async () => {
    const { client } = build([{ status: 500 }]);

    const error = await failure(client.call(target));

    expect((error as DepotApiError).serverMessage).toBeUndefined();
    expect(String(error)).toContain('HTTP 500');
    expect(String(error)).toContain('internal');
  });

  it('maps an unrecognised status with an unknown code to "unknown"', async () => {
    const { client } = build([{ status: 418, body: '{"code":"teapot"}' }]);

    const error = await failure(client.call(target));

    expect((error as DepotApiError).code).toBe('unknown');
  });

  it('wraps a non-Error rejection from fetch', async () => {
    const client = new DepotClient({
      token: TOKEN,
      apiUrl: 'https://api.depot.dev',
      maxAttempts: 1,
      fetch: () => Promise.reject(new Error('socket hang up')),
    });

    const error = await failure(client.call(target));

    expect(error).toBeInstanceOf(DepotTransportError);
    expect(String(error)).toContain('socket hang up');
    expect((error as DepotTransportError).rpc).toBe('depot.ci.v1.CIService/ListRuns');
  });

  it('wraps a failure while reading the body as a transport error', async () => {
    const { client, calls } = build([], {
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('stream reset'));
              },
            }),
            { status: 200 },
          ),
        ),
    });

    const error = await failure(client.call(target));

    expect(error).toBeInstanceOf(DepotTransportError);
    expect(String(error)).toContain('stream reset');
    expect(calls).toHaveLength(0);
  });
});

describe('DepotClient request formation', () => {
  it('always POSTs JSON with the bearer token and Connect headers', async () => {
    const { client, calls } = build([{ status: 200, body: '{}' }]);

    await client.call(target, { a: 1 });

    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"a":1}');
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    });
  });

  it('keeps a path prefix from DEPOT_API_URL', async () => {
    const { client, calls } = build([{ status: 200, body: '{}' }], {
      apiUrl: 'https://proxy.example/depot//',
    });

    await client.call(target);

    expect(calls[0]?.url).toBe('https://proxy.example/depot/depot.ci.v1.CIService/ListRuns');
  });

  it('sends an empty JSON object when no request is given', async () => {
    const { client, calls } = build([{ status: 200, body: '{}' }]);

    await client.call(target);

    expect(calls[0]?.init.body).toBe('{}');
  });

  it('never sends x-depot-org unless an organization is configured', async () => {
    const without = build([{ status: 200, body: '{}' }]);
    await without.client.call(target);
    expect(Object.keys(without.calls[0]?.init.headers ?? {})).not.toContain('x-depot-org');

    const withOrg = build([{ status: 200, body: '{}' }], { orgId: 'org_9z8y7x' });
    await withOrg.client.call(target);
    expect(withOrg.calls[0]?.init.headers).toMatchObject({ 'x-depot-org': 'org_9z8y7x' });
  });
});

describe('DepotClient token hygiene', () => {
  const failures: Array<[string, Reply[] | 'throws' | 'timeout']> = [
    ['401 envelope', [{ status: 401, body: '{"code":"unauthenticated","message":"bad token"}' }]],
    ['HTML 500', [{ status: 500, body: '<html><body>Internal Server Error</body></html>' }]],
    ['malformed 200', [{ status: 200, body: 'not json' }]],
    ['empty 403', [{ status: 403 }]],
    ['network throw', 'throws'],
    ['timeout', 'timeout'],
  ];

  it.each(failures)('keeps the token out of the %s error and its formatted message', async (_label, mode) => {
    let client: DepotClient;
    if (mode === 'throws') {
      client = new DepotClient({
        token: TOKEN,
        apiUrl: 'https://api.depot.dev',
        maxAttempts: 1,
        fetch: () => Promise.reject(new Error('ENOTFOUND api.depot.dev')),
      });
    } else if (mode === 'timeout') {
      client = new DepotClient({
        token: TOKEN,
        apiUrl: 'https://api.depot.dev',
        maxAttempts: 1,
        requestTimeoutMs: 1,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason as Error);
            });
          }),
      });
    } else {
      client = build(mode, { maxAttempts: 1 }).client;
    }

    const error = await failure(client.call(target));

    expect(serializeError(error)).not.toMatch(TOKEN_PATTERN);
    expect(formatDepotError(error)).not.toMatch(TOKEN_PATTERN);
  });

  // GAP (src/depot/errors.ts parseConnectError + formatDepotError): the server's `message` is
  // forwarded verbatim, so an endpoint that echoes request headers (a misconfigured
  // DEPOT_API_URL landing on a debugging proxy) can push the bearer token into the model's context.
  it('scrubs the token if a server echoes it back in a Connect error message', async () => {
    const { client } = build(
      [{ status: 401, body: JSON.stringify({ code: 'unauthenticated', message: `got Bearer ${TOKEN}` }) }],
      { maxAttempts: 1 },
    );

    const error = await failure(client.call(target));

    expect(formatDepotError(error)).not.toMatch(TOKEN_PATTERN);
  });

  // Same gap through the non-JSON path: the first 200 characters of an HTML body are surfaced.
  it('scrubs the token if a server echoes it back in an HTML error page', async () => {
    const { client } = build([{ status: 404, body: `<html>authorization: Bearer ${TOKEN}</html>` }], {
      maxAttempts: 1,
    });

    const error = await failure(client.call(target));

    expect(formatDepotError(error)).not.toMatch(TOKEN_PATTERN);
  });

  it('scrubs the token from a transport error message but keeps the raw cause for stderr', async () => {
    const cause = new Error(`request failed with headers authorization: Bearer ${TOKEN}`);
    const client = new DepotClient({
      token: TOKEN,
      apiUrl: 'https://api.depot.dev',
      maxAttempts: 1,
      fetch: () => Promise.reject(cause),
    });

    const error = await failure(client.call(target));

    expect(error).toBeInstanceOf(DepotTransportError);
    expect((error as DepotTransportError).message).not.toMatch(TOKEN_PATTERN);
    expect((error as DepotTransportError).message).toContain('[redacted]');
    expect(formatDepotError(error)).not.toMatch(TOKEN_PATTERN);
    expect((error as DepotTransportError).cause).toBe(cause);
  });
});
