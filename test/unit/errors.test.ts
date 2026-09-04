import { describe, expect, it } from 'vitest';
import {
  DepotApiError,
  DepotTransportError,
  formatDepotError,
  isDepotRequestError,
  parseConnectError,
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
