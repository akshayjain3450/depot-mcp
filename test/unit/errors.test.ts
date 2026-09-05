import { describe, expect, it } from 'vitest';
import {
  DepotApiError,
  DepotTransportError,
  formatDepotError,
  isDepotRequestError,
  MAX_SERVER_MESSAGE_CHARS,
  parseConnectError,
  parseRetryAfter,
  scrubSecrets,
} from '../../src/depot/errors.js';

const target = { service: 'depot.ci.v1.CIService', method: 'ListRuns' };

describe('parseConnectError', () => {
  it('reads the code and message out of a Connect error envelope', () => {
    const error = parseConnectError(
      target,
      401,
      JSON.stringify({ code: 'unauthenticated', message: 'invalid token' }),
    );

    expect(error.code).toBe('unauthenticated');
    expect(error.httpStatus).toBe(401);
    expect(error.serverMessage).toBe('invalid token');
    expect(error.rpc).toBe('depot.ci.v1.CIService/ListRuns');
    expect(error.retryable).toBe(false);
  });

  it('falls back to the HTTP status when the envelope has no usable code', () => {
    expect(parseConnectError(target, 429, JSON.stringify({ message: 'slow down' })).code).toBe(
      'resource_exhausted',
    );
    expect(parseConnectError(target, 503, JSON.stringify({ code: 'weird' })).code).toBe(
      'unavailable',
    );
    expect(parseConnectError(target, 418, '{}').code).toBe('unknown');
  });

  it('summarises a non-JSON body rather than forwarding a whole HTML page', () => {
    const html = `<!DOCTYPE html><html><body>${'x'.repeat(5_000)}</body></html>`;
    const error = parseConnectError(target, 404, html);

    expect(error.code).toBe('not_found');
    expect(error.serverMessage).toContain('DEPOT_API_URL');
    expect((error.serverMessage ?? '').length).toBeLessThan(300);
  });

  it('caps a server message so a stack trace cannot flood the context', () => {
    const error = parseConnectError(
      target,
      500,
      JSON.stringify({ code: 'internal', message: 'y'.repeat(5_000) }),
    );

    expect(error.serverMessage?.length).toBeLessThanOrEqual(MAX_SERVER_MESSAGE_CHARS + 20);
    expect(error.serverMessage).toContain('[truncated]');
    expect(error.message.length).toBeLessThan(700);
  });

  it('carries a Retry-After delay through to the error', () => {
    const error = parseConnectError(target, 429, '{"code":"resource_exhausted"}', 3_000);
    expect(error.retryAfterMs).toBe(3_000);
    expect(parseConnectError(target, 429, '{}').retryAfterMs).toBeUndefined();
  });

  it('marks the retryable codes as retryable and nothing else', () => {
    const retryable = ['unavailable', 'deadline_exceeded', 'aborted', 'resource_exhausted'];
    const notRetryable = [
      'invalid_argument',
      'not_found',
      'permission_denied',
      'failed_precondition',
      'unauthenticated',
    ];

    for (const code of retryable) {
      expect(parseConnectError(target, 500, JSON.stringify({ code })).retryable, code).toBe(true);
    }
    for (const code of notRetryable) {
      expect(parseConnectError(target, 500, JSON.stringify({ code })).retryable, code).toBe(false);
    }
  });
});

describe('formatDepotError', () => {
  it('names DEPOT_TOKEN for an authentication failure', () => {
    const message = formatDepotError(
      new DepotApiError({
        code: 'unauthenticated',
        httpStatus: 401,
        rpc: 'x/Y',
        serverMessage: 'bad token',
      }),
    );

    expect(message).toContain('unauthenticated');
    expect(message).toContain('DEPOT_TOKEN');
    expect(message).toContain('bad token');
    expect(message).toContain('Organization token');
  });

  it('names DEPOT_ORG_ID for a permission failure', () => {
    const message = formatDepotError(
      new DepotApiError({ code: 'permission_denied', httpStatus: 403, rpc: 'x/Y' }),
    );

    expect(message).toContain('DEPOT_ORG_ID');
  });

  it('explains the log stream limits behind resource_exhausted', () => {
    const message = formatDepotError(
      new DepotApiError({ code: 'resource_exhausted', httpStatus: 429, rpc: 'x/Y' }),
    );

    expect(message).toContain('Log streams are capped');
  });

  it('gives network advice for a transport failure', () => {
    const message = formatDepotError(new DepotTransportError('x/Y', new Error('ENOTFOUND')));

    expect(message).toContain('ENOTFOUND');
    expect(message).toContain('DEPOT_API_URL');
  });

  it('degrades gracefully for an unrelated error', () => {
    expect(formatDepotError(new Error('boom'))).toBe('boom');
    expect(formatDepotError('plain string')).toBe('plain string');
  });
});

describe('isDepotRequestError', () => {
  it('recognises both request error kinds and nothing else', () => {
    expect(isDepotRequestError(new DepotApiError({ code: 'internal', httpStatus: 500, rpc: 'a/B' }))).toBe(
      true,
    );
    expect(isDepotRequestError(new DepotTransportError('a/B', 'nope'))).toBe(true);
    expect(isDepotRequestError(new Error('other'))).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('3')).toBe(3_000);
    expect(parseRetryAfter(' 0 ')).toBe(0);
  });

  it('reads an HTTP-date relative to the given clock and never goes negative', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(parseRetryAfter(new Date(now + 5_000).toUTCString(), now)).toBe(5_000);
    expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBe(0);
  });

  it('ignores an absent or unparseable header', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

describe('scrubSecrets', () => {
  it('redacts any bearer credential and every given secret', () => {
    const out = scrubSecrets('Headers.append: "Bearer dp_abc" bad; also dp_abc again', ['dp_abc']);
    expect(out).not.toContain('dp_abc');
    expect(out).toContain('Bearer [redacted]');
  });

  it('redacts the halves of a secret that was split by whitespace', () => {
    const out = scrubSecrets('left: dp_lefthalf_1 right: righthalf_2', ['dp_lefthalf_1\nrighthalf_2']);
    expect(out).not.toContain('dp_lefthalf_1');
    expect(out).not.toContain('righthalf_2');
  });

  it('leaves unrelated text alone', () => {
    expect(scrubSecrets('ECONNREFUSED 127.0.0.1:443', ['dp_abc'])).toBe('ECONNREFUSED 127.0.0.1:443');
  });
});

describe('DepotTransportError', () => {
  it('scrubs the given secrets from its message but keeps the raw cause for stderr', () => {
    const cause = new Error('rejected "Bearer dp_secret_value_1"');
    const error = new DepotTransportError('a/B', cause, ['dp_secret_value_1']);

    expect(error.message).not.toContain('dp_secret_value_1');
    expect(error.cause).toBe(cause);
  });

  it('recognises a timeout by the cause name', () => {
    expect(new DepotTransportError('a/B', new DOMException('t', 'TimeoutError')).timedOut).toBe(true);
    expect(new DepotTransportError('a/B', new DOMException('t', 'AbortError')).timedOut).toBe(true);
    expect(new DepotTransportError('a/B', new Error('ENOTFOUND')).timedOut).toBe(false);
    expect(new DepotTransportError('a/B', 'string cause').timedOut).toBe(false);
  });
});

describe('DepotApiError', () => {
  it('lets a caller override retryable for a failure retrying cannot fix', () => {
    const error = new DepotApiError({
      code: 'resource_exhausted',
      httpStatus: 200,
      rpc: 'a/B',
      retryable: false,
    });
    expect(error.retryable).toBe(false);
  });
});
