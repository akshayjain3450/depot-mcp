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
