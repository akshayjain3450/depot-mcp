import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  connectError,
  createHarness,
  fixture,
  NOT_FOUND,
  ok,
  type Harness,
} from '../helpers/harness.js';
import { RPC } from '../helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const SUMMARY = ok(fixture('job-summary'));

/** The job summary tool is the cheapest consumer of resolveAttemptTarget: one request per probe. */
async function summary(id: string, targetType?: string) {
  if (harness === undefined) {
    throw new Error('harness not created');
  }
  return callTool(harness, 'depot_get_ci_job_summary', {
    id,
    ...(targetType === undefined ? {} : { targetType }),
  });
}

describe('resolveAttemptTarget through depot_get_ci_job_summary', () => {
  it('sends an attempt id straight through and describes the target', async () => {
    harness = await createHarness({ routes: { [RPC.getJobSummary]: SUMMARY } });

    const result = await summary('att_91bc02');

    expect(harness.callsTo(RPC.getJobSummary).map((call) => call.body)).toEqual([
      { attemptId: 'att_91bc02' },
    ]);
    expect(result.structured.target).toEqual({
      describedAs: 'attempt att_91bc02',
      attemptId: 'att_91bc02',
    });
  });

  it('lets an explicit targetType override the prefix', async () => {
    harness = await createHarness({ routes: { [RPC.getJobSummary]: SUMMARY } });

    await summary('job_4d0a77', 'attempt');

    expect(harness.callsTo(RPC.getJobSummary)[0]?.body).toEqual({ attemptId: 'job_4d0a77' });
  });

  it('surfaces not_found directly when the kind was explicit or prefixed', async () => {
    harness = await createHarness({ routes: { [RPC.getJobSummary]: NOT_FOUND } });

    const result = await summary('job_missing');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('not_found');
    expect(result.text).toContain('no such record');
    expect(harness.callsTo(RPC.getJobSummary)).toHaveLength(1);
  });

  it('walks a run down to its failed job when that job has no attempts', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getRunStatus]: ok({
          workflows: [{ jobs: [{ jobId: 'job_x', jobKey: 'build', conclusion: 'CONCLUSION_FAILED' }] }],
        }),
        [RPC.getJobSummary]: SUMMARY,
      },
    });

    const result = await summary('run_1');

    expect(harness.callsTo(RPC.getJobSummary)[0]?.body).toEqual({ jobId: 'job_x' });
    expect(result.structured.target).toMatchObject({
      describedAs: '"build" in run run_1',
      jobId: 'job_x',
    });
  });

  it('explains a run that has no jobs yet', async () => {
    harness = await createHarness({ routes: { [RPC.getRunStatus]: ok({ workflows: [] }) } });

    const result = await summary('run_empty');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('has no jobs yet');
    expect(result.text).toContain('depot_get_ci_run');
    expect(harness.callsTo(RPC.getJobSummary)).toHaveLength(0);
  });

  it('explains a run whose jobs carry no ids at all', async () => {
    harness = await createHarness({
      routes: { [RPC.getRunStatus]: ok({ workflows: [{ jobs: [{ jobKey: 'anon' }] }] }) },
    });

    const result = await summary('run_anon');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Could not find a job or attempt id');
  });

  it('propagates a run lookup failure other than not_found', async () => {
    harness = await createHarness({
      routes: { [RPC.getRunStatus]: connectError(403, 'permission_denied', 'wrong org') },
    });

    const result = await summary('run_1');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('permission_denied');
    expect(result.text).toContain('DEPOT_ORG_ID');
  });

  it('tries attempt, job, then run for an unprefixed id and explains when none match', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobSummary]: NOT_FOUND, [RPC.getRunStatus]: NOT_FOUND },
    });

    const result = await summary('01JQNOPE');

    expect(harness.callsTo(RPC.getJobSummary).map((call) => call.body)).toEqual([
      { attemptId: '01JQNOPE' },
      { jobId: '01JQNOPE' },
    ]);
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('does not recognise "01JQNOPE"');
    expect(result.text).toContain('DEPOT_ORG_ID');
  });

  it('falls back to the run interpretation for an unprefixed id and succeeds', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getJobSummary]: [NOT_FOUND, NOT_FOUND, SUMMARY],
        [RPC.getRunStatus]: ok(fixture('run-status')),
      },
    });

    const result = await summary('01JQRUN');

    expect(harness.callsTo(RPC.getJobSummary)[2]?.body).toEqual({ attemptId: 'att_91bc02' });
    expect(result.isError).toBe(false);
    expect(result.structured.target).toMatchObject({ attemptId: 'att_91bc02' });
  });

  it('stops probing on the first error that is not not_found', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobSummary]: [NOT_FOUND, connectError(403, 'permission_denied', 'nope')] },
    });

    const result = await summary('01JQDENIED');

    expect(harness.callsTo(RPC.getJobSummary)).toHaveLength(2);
    expect(harness.callsTo(RPC.getRunStatus)).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('permission_denied');
  });

  it('refuses a workflow id before making any request', async () => {
    harness = await createHarness({ routes: {} });

    const result = await summary('01JQ', 'workflow');

    expect(result.isError).toBe(true);
    expect(result.text).toContain('stored per job attempt');
    expect(harness.calls).toHaveLength(0);
  });

  it('trims ids and rejects whitespace-only ids before calling Depot', async () => {
    harness = await createHarness({ routes: { [RPC.getJobSummary]: SUMMARY } });

    const blank = await summary('  ');
    expect(blank.isError).toBe(true);
    expect(blank.text).toContain('must not be empty');

    await summary('  att_1 ');

    expect(harness.callsTo(RPC.getJobSummary).map((call) => call.body)).toEqual([
      { attemptId: 'att_1' },
    ]);
  });

  // A pasted dashboard URL is not parsed; it is sent verbatim as an attempt id first.
  it('sends a URL-shaped id to Depot verbatim (pinned)', async () => {
    harness = await createHarness({ routes: { [RPC.getJobSummary]: SUMMARY } });

    await summary('https://depot.dev/orgs/acme/ci/runs/run_7f3d9c21');

    expect(harness.callsTo(RPC.getJobSummary).map((call) => call.body)).toEqual([
      { attemptId: 'https://depot.dev/orgs/acme/ci/runs/run_7f3d9c21' },
    ]);
  });
});
