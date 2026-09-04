import { afterEach, describe, expect, it } from 'vitest';
import { callTool, connectError, createHarness, fixture, ok, type Harness } from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

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
