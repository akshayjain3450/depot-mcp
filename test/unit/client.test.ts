import { describe, expect, it } from 'vitest';
import { DepotClient, type FetchLike } from '../../src/depot/client.js';
import { DepotApiError, DepotTransportError } from '../../src/depot/errors.js';

const target = { service: 'depot.ci.v1.CIService', method: 'ListRuns' };

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recordingFetch(replies: Array<{ status: number; body: string }>): {
  fetch: FetchLike;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  const fetchImpl: FetchLike = (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init.headers ?? {})) {
      if (typeof value === 'string') {
        headers[key.toLowerCase()] = value;
      }
    }
    calls.push({ url, headers, body: typeof init.body === 'string' ? init.body : '' });
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) {
      throw new Error('no reply configured');
    }
    return Promise.resolve(new Response(reply.body, { status: reply.status }));
  };
  return { fetch: fetchImpl, calls };
}

function client(fetchImpl: FetchLike, orgId?: string): DepotClient {
  return new DepotClient({
    token: 'secret-token',
    apiUrl: 'https://api.depot.dev',
    orgId,
    fetch: fetchImpl,
    sleep: () => Promise.resolve(),
  });
}

describe('DepotClient request shape', () => {
  it('posts to /<service>/<Method> with the Connect headers', async () => {
    const { fetch, calls } = recordingFetch([{ status: 200, body: '{"runs":[]}' }]);

    await client(fetch).call(target, { pageSize: 5 });

    expect(calls[0]?.url).toBe('https://api.depot.dev/depot.ci.v1.CIService/ListRuns');
    expect(calls[0]?.headers).toMatchObject({
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
      'connect-protocol-version': '1',
    });
    expect(calls[0]?.body).toBe('{"pageSize":5}');
  });

  it('sends x-depot-org only when an organization is configured', async () => {
    const withOrg = recordingFetch([{ status: 200, body: '{}' }]);
    await client(withOrg.fetch, 'org_1a2b3c').call(target, {});
    expect(withOrg.calls[0]?.headers['x-depot-org']).toBe('org_1a2b3c');

    const withoutOrg = recordingFetch([{ status: 200, body: '{}' }]);
    await client(withoutOrg.fetch).call(target, {});
    expect(withoutOrg.calls[0]?.headers['x-depot-org']).toBeUndefined();
  });

  it('omits unset fields rather than sending nulls', async () => {
    const { fetch, calls } = recordingFetch([{ status: 200, body: '{}' }]);

    await client(fetch).call(target, { repo: 'acme/api', sha: undefined, pr: undefined });

    expect(calls[0]?.body).toBe('{"repo":"acme/api"}');
  });

  it('trims a trailing slash from a configured base URL', async () => {
    const { fetch, calls } = recordingFetch([{ status: 200, body: '{}' }]);
    const trailing = new DepotClient({
      token: 't',
      apiUrl: 'https://depot.internal.example/',
      fetch,
      sleep: () => Promise.resolve(),
    });

    await trailing.call(target, {});

    expect(calls[0]?.url).toBe('https://depot.internal.example/depot.ci.v1.CIService/ListRuns');
  });
});

describe('DepotClient retries', () => {
  it('retries a retryable code and returns the eventual success', async () => {
    const { fetch, calls } = recordingFetch([
      { status: 503, body: '{"code":"unavailable","message":"down"}' },
      { status: 200, body: '{"runs":[{"runId":"run_1"}]}' },
    ]);

    const response = await client(fetch).call(target, {});

    expect(calls).toHaveLength(2);
    expect(response).toEqual({ runs: [{ runId: 'run_1' }] });
  });

  it('gives up after the attempt budget and throws the last error', async () => {
    const { fetch, calls } = recordingFetch([
      { status: 503, body: '{"code":"unavailable","message":"down"}' },
    ]);

    await expect(client(fetch).call(target, {})).rejects.toThrow(DepotApiError);
    expect(calls).toHaveLength(3);
  });

  it('does not retry a client error', async () => {
    const { fetch, calls } = recordingFetch([
      { status: 400, body: '{"code":"invalid_argument","message":"bad"}' },
    ]);

    await expect(client(fetch).call(target, {})).rejects.toThrow(/invalid_argument/);
    expect(calls).toHaveLength(1);
  });

  it('wraps a network failure as a transport error and retries it', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = () => {
      attempts += 1;
      return Promise.reject(new Error('ECONNREFUSED'));
    };

    await expect(client(fetchImpl).call(target, {})).rejects.toThrow(DepotTransportError);
    expect(attempts).toBe(3);
  });
});

describe('DepotClient response handling', () => {
  it('treats an empty body as an empty message', async () => {
    const { fetch } = recordingFetch([{ status: 200, body: '' }]);

    await expect(client(fetch).call(target, {})).resolves.toEqual({});
  });

  it('rejects a success body that is not a JSON object', async () => {
    const notJson = recordingFetch([{ status: 200, body: 'not json at all' }]);
    await expect(client(notJson.fetch).call(target, {})).rejects.toThrow(/not valid JSON/);

    const jsonArray = recordingFetch([{ status: 200, body: '[1,2,3]' }]);
    await expect(client(jsonArray.fetch).call(target, {})).rejects.toThrow(/not a JSON object/);
  });

  it('never puts the token in an error message', async () => {
    const { fetch } = recordingFetch([
      { status: 401, body: '{"code":"unauthenticated","message":"nope"}' },
    ]);

    const error = await client(fetch)
      .call(target, {})
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(DepotApiError);
    expect(String(error)).not.toContain('secret-token');
    expect(JSON.stringify(error instanceof Error ? error.message : error)).not.toContain(
      'secret-token',
    );
  });
});

interface HeaderReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

function headerFetch(replies: HeaderReply[]): { fetch: FetchLike; calls: number } {
  const state = { calls: 0 };
  let index = 0;
  const fetchImpl: FetchLike = () => {
    state.calls += 1;
    const reply = replies[Math.min(index, replies.length - 1)];
    index += 1;
    if (reply === undefined) {
      throw new Error('no reply configured');
    }
    return Promise.resolve(
      new Response(reply.body, { status: reply.status, headers: reply.headers ?? {} }),
    );
  };
  return {
    fetch: fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}

/** A fake clock that only moves when the client sleeps, so backoff maths is exact. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let time = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: (ms) => {
      sleeps.push(ms);
      time += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

function timeoutError(): Error {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

describe('DepotClient retry policy', () => {
  it('waits the Retry-After delay, in seconds, on a 429', async () => {
    const clock = fakeClock();
    const replies = headerFetch([
      { status: 429, body: '{"code":"resource_exhausted"}', headers: { 'retry-after': '3' } },
      { status: 200, body: '{}' },
    ]);

    await new DepotClient({
      token: 't',
      apiUrl: 'https://api.depot.dev',
      fetch: replies.fetch,
      sleep: clock.sleep,
      now: clock.now,
    }).call(target, {});

    expect(clock.sleeps).toEqual([3_000]);
  });

  it('honours an HTTP-date Retry-After on a 503, relative to its own clock', async () => {
    const clock = fakeClock();
    const at = new Date(clock.now() + 2_000).toUTCString();
    const replies = headerFetch([
      { status: 503, body: '{"code":"unavailable"}', headers: { 'retry-after': at } },
      { status: 200, body: '{}' },
    ]);

    await new DepotClient({
      token: 't',
      apiUrl: 'https://api.depot.dev',
      fetch: replies.fetch,
      sleep: clock.sleep,
      now: clock.now,
    }).call(target, {});

    // toUTCString drops sub-second precision, so allow the rounding.
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThan(0);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(2_000);
  });

  it('caps a long Retry-After so a tool call cannot be parked for a minute', async () => {
    const clock = fakeClock();
    const replies = headerFetch([
      { status: 429, body: '{"code":"resource_exhausted"}', headers: { 'retry-after': '60' } },
      { status: 200, body: '{}' },
    ]);

    await new DepotClient({
      token: 't',
      apiUrl: 'https://api.depot.dev',
      fetch: replies.fetch,
      sleep: clock.sleep,
      now: clock.now,
      callDeadlineMs: 60_000,
    }).call(target, {});

    expect(clock.sleeps).toEqual([8_000]);
  });

  it('retries a timed-out request once, then gives up', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = () => {
      attempts += 1;
      return Promise.reject(timeoutError());
    };

    const error = await client(fetchImpl)
      .call(target, {})
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(DepotTransportError);
    expect((error as DepotTransportError).timedOut).toBe(true);
    expect(attempts).toBe(2);
  });

  it('stops retrying once the next backoff would cross the call deadline', async () => {
    const clock = fakeClock();
    const replies = headerFetch([{ status: 503, body: '{"code":"unavailable"}' }]);

    const failing = new DepotClient({
      token: 't',
      apiUrl: 'https://api.depot.dev',
      fetch: replies.fetch,
      sleep: clock.sleep,
      now: clock.now,
      maxAttempts: 10,
      callDeadlineMs: 1_000,
    });

    await expect(failing.call(target, {})).rejects.toThrow(DepotApiError);
    // Backoff runs 250, 750, ...: after 250 + 750 = 1000 ms the deadline is reached.
    expect(clock.sleeps).toEqual([250]);
    expect(replies.calls).toBe(2);
  });
});

describe('DepotClient response size cap', () => {
  it('rejects a response whose Content-Length exceeds the cap without reading it', async () => {
    const replies = headerFetch([
      { status: 200, body: '{}', headers: { 'content-length': String(9 * 1024 * 1024) } },
    ]);

    const error = await client(replies.fetch)
      .call(target, {})
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(DepotApiError);
    expect((error as DepotApiError).code).toBe('resource_exhausted');
    expect((error as DepotApiError).retryable).toBe(false);
    expect((error as DepotApiError).message).toContain('8 MiB');
    expect(replies.calls).toBe(1);
  });

  it('aborts a streamed body once it passes the cap', async () => {
    const replies = headerFetch([{ status: 200, body: `{"pad":"${'x'.repeat(200)}"}` }]);

    const capped = new DepotClient({
      token: 't',
      apiUrl: 'https://api.depot.dev',
      fetch: replies.fetch,
      sleep: () => Promise.resolve(),
      maxResponseBytes: 64,
    });

    await expect(capped.call(target, {})).rejects.toMatchObject({
      name: 'DepotApiError',
      code: 'resource_exhausted',
      retryable: false,
    });
    expect(replies.calls).toBe(1);
  });

  it('still reads a body under the cap in full', async () => {
    const replies = headerFetch([{ status: 200, body: '{"ok":true}' }]);
    const capped = new DepotClient({
      token: 't',
      apiUrl: 'https://api.depot.dev',
      fetch: replies.fetch,
      sleep: () => Promise.resolve(),
      maxResponseBytes: 64,
    });

    await expect(capped.call(target, {})).resolves.toEqual({ ok: true });
  });
});

describe('DepotClient token scrubbing', () => {
  it('strips the token from a fetch error that echoes the Authorization header', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(
        new TypeError('Headers.append: "Bearer secret-token" is an invalid header value.'),
      );

    const error = await client(fetchImpl)
      .call(target, {})
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(DepotTransportError);
    expect((error as Error).message).not.toContain('secret-token');
    expect((error as Error).message).toContain('[redacted]');
  });

  it('strips every fragment of a token that contains a line break', async () => {
    const token = 'dp_first_half_0123\r\nsecond_half_4567';
    const fetchImpl: FetchLike = () =>
      Promise.reject(
        new TypeError(`Headers.append: "Bearer ${token}" is an invalid header value.`),
      );
    const broken = new DepotClient({
      token,
      apiUrl: 'https://api.depot.dev',
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });

    const error = await broken.call(target, {}).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    const message = (error as Error).message;
    expect(message).not.toContain('dp_first_half_0123');
    expect(message).not.toContain('second_half_4567');
  });

  it('strips a token with a space even when fetch quotes only part of it', async () => {
    const token = 'dp_left_part_0123 right_part_4567';
    const fetchImpl: FetchLike = () =>
      Promise.reject(new TypeError(`bad header: right_part_4567 and dp_left_part_0123`));
    const broken = new DepotClient({
      token,
      apiUrl: 'https://api.depot.dev',
      fetch: fetchImpl,
      sleep: () => Promise.resolve(),
    });

    const error = await broken.call(target, {}).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    const message = (error as Error).message;
    expect(message).not.toContain('dp_left_part_0123');
    expect(message).not.toContain('right_part_4567');
  });
});
