import { describe, expect, it } from 'vitest';
import { DepotApi } from '../../src/depot/api.js';
import { DepotClient, type FetchLike } from '../../src/depot/client.js';
import { ProtobufWriter } from '../../src/depot/protobuf.js';

const TOKEN = 'depot_binarytest_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnop';

function protoResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status, headers: { 'content-type': 'application/proto' } });
}

describe('DepotClient binary Connect encoding', () => {
  it('sends application/proto and decodes an application/proto reply', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const reply = new ProtobufWriter()
      .message(1, new ProtobufWriter().string(1, '[1/1] RUN true').string(2, 'sha256:1').bool(7, true))
      .finish();
    const fetchImpl: FetchLike = (url, init) => {
      seen.push({ url, init });
      return Promise.resolve(protoResponse(reply));
    };
    const api = new DepotApi(new DepotClient({ token: TOKEN, apiUrl: 'https://api.test', fetch: fetchImpl }));

    const result = await api.getBuildSteps({ projectId: 'p', buildId: 'b' });

    expect(seen[0]?.url).toBe('https://api.test/depot.build.v1.BuildService/GetBuildSteps');
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/proto');
    expect(headers.accept).toContain('application/proto');
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.init.body).toBeInstanceOf(Uint8Array);
    expect(result).toEqual({
      buildSteps: [{ name: '[1/1] RUN true', digest: 'sha256:1', hasLogs: true }],
    });
  });

  it('still accepts a JSON reply to a binary request (proxies, fixtures)', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ buildSteps: [{ name: 'json' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const api = new DepotApi(new DepotClient({ token: TOKEN, apiUrl: 'https://api.test', fetch: fetchImpl }));
    expect(await api.getBuildSteps({ projectId: 'p', buildId: 'b' })).toEqual({
      buildSteps: [{ name: 'json' }],
    });
  });

  it('translates a Connect JSON error to a binary request like any other', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'internal', message: 'Error fetching build steps' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const api = new DepotApi(
      new DepotClient({ token: TOKEN, apiUrl: 'https://api.test', fetch: fetchImpl, maxAttempts: 1 }),
    );
    await expect(api.getBuildSteps({ projectId: 'p', buildId: 'b' })).rejects.toMatchObject({
      code: 'internal',
      serverMessage: 'Error fetching build steps',
    });
  });

  it('keeps JSON requests on application/json with a plain accept header', async () => {
    let headers: Record<string, string> = {};
    const fetchImpl: FetchLike = (_url, init) => {
      headers = init.headers as Record<string, string>;
      return Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    };
    await new DepotClient({ token: TOKEN, apiUrl: 'https://api.test', fetch: fetchImpl }).call({
      service: 's',
      method: 'm',
    });
    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('application/json');
  });
});
