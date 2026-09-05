import { afterEach, describe, expect, it } from 'vitest';
import {
  UNTRUSTED_CI_CONTENT_WARNING,
  UNTRUSTED_CONTENT_BEGIN,
  UNTRUSTED_CONTENT_END,
} from '../../src/lib/ci-target.js';
import { AI_DISCLOSURE } from '../../src/lib/diagnosis.js';
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

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

describe('depot_diagnose_ci_failure — grouped_failures', () => {
  it('clusters root causes, keeps the evidence, and preserves the AI disclosure', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: 'run_7f3d9c21' });

    expect(result.isError).toBe(false);
    expect(result.structured.state).toBe('grouped_failures');
    expect(result.structured.resolvedTargetType).toBe('run');
    expect(result.structured.aiDisclosure).toBe(AI_DISCLOSURE);

    const groups = asArray(result.structured.failureGroups);
    expect(groups).toHaveLength(2);
    const first = asRecord(groups[0]);
    expect(first.count).toBe(4);
    expect(first.source).toBe('test');
    expect(first.diagnosis).toContain('Redis client');
    expect(first.possibleFix).toContain('setup hook');

    const attempts = asArray(first.attempts).map(asRecord);
    expect(attempts[0]?.attemptId).toBe('att_91bc02');
    expect(attempts[0]?.attemptConclusion).toBe('failed');
    expect(asArray(attempts[0]?.evidence)).toHaveLength(4);
    expect(asRecord(asArray(attempts[0]?.evidence)[1]).content).toContain('AssertionError');

    expect(result.text).toContain('AssertionError: expected 200 to equal 503');
    expect(result.text).toContain('acme/api@9c1f4ab7');
    expect(result.text).toContain(AI_DISCLOSURE);
  });

  it('fences CI-derived text and labels AI prose as unverified', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: 'run_7f3d9c21' });

    expect(result.structured.contentWarning).toBe(UNTRUSTED_CI_CONTENT_WARNING);
    expect(result.text).toContain("Depot's diagnosis (unverified): The health endpoint");
    expect(result.text).toContain("Depot's suggested fix (unverified, from CI output): Await");

    const begin = result.text.indexOf(UNTRUSTED_CONTENT_BEGIN);
    const end = result.text.indexOf(UNTRUSTED_CONTENT_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const fenced = result.text.slice(begin, end);
    expect(fenced).toContain('Context: acme/api');
    expect(fenced).toContain('AssertionError: expected 200 to equal 503');
    expect(fenced).toContain('View logs for test (18)');
    expect(result.text.slice(end)).toContain(AI_DISCLOSURE);
  });

  it('sends the inferred target type and only one request for a prefixed id', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
    });

    await callTool(harness, 'depot_diagnose_ci_failure', { id: 'run_7f3d9c21' });

    const calls = harness.callsTo(RPC.getFailureDiagnosis);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ targetId: 'run_7f3d9c21', targetType: 'RUN' });
  });

  it("translates Depot's nextCommands into this server's own tool calls", async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: 'run_7f3d9c21' });
    const nextSteps = asArray(result.structured.nextSteps).map(asRecord);

    expect(nextSteps.map((step) => step.kind)).toEqual(['diagnose_job', 'logs', 'summary']);
    expect(nextSteps[0]).toMatchObject({
      tool: 'depot_diagnose_ci_failure',
      arguments: { id: 'job_4d0a77', targetType: 'job' },
    });
    expect(nextSteps[1]).toMatchObject({
      tool: 'depot_get_ci_logs',
      arguments: { id: 'att_91bc02' },
    });
    expect(nextSteps[2]).toMatchObject({
      tool: 'depot_get_ci_job_summary',
      arguments: { id: 'job_4d0a77' },
    });
    expect(result.text).not.toContain('depot ci logs');
  });

  it("propagates Depot's own truncation bounds instead of implying completeness", async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: 'run_7f3d9c21' });
    const truncation = asRecord(result.structured.truncation);

    expect(truncation.byDepot).toBe(true);
    expect(truncation.byServer).toBe(false);
    expect(truncation.omittedFailureGroups).toBe(1);
    expect(truncation.omittedAttempts).toBe(3);

    const notes = asArray(truncation.notes).join(' ');
    expect(notes).toContain('truncated this diagnosis server-side');
    expect(notes).toContain('1 further failure group');
    expect(notes).toContain('2 job(s) never ran');
    expect(notes).toContain('jobDisplayName');
  });

  it('reports separately when this server, not Depot, dropped groups', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', {
      id: 'run_7f3d9c21',
      maxFailureGroups: 1,
    });
    const truncation = asRecord(result.structured.truncation);

    expect(asArray(result.structured.failureGroups)).toHaveLength(1);
    expect(truncation.byServer).toBe(true);
    expect(asArray(truncation.notes).join(' ')).toContain('maxFailureGroups');
  });

  it('caps evidence lines and says how many it withheld', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-grouped')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', {
      id: 'run_7f3d9c21',
      maxEvidenceLines: 1,
    });

    const attempt = asRecord(asArray(asRecord(asArray(result.structured.failureGroups)[0]).attempts)[0]);
    expect(asArray(attempt.evidence)).toHaveLength(1);
    expect(attempt.evidenceOmitted).toBe(3);
  });
});

describe('depot_diagnose_ci_failure — other states', () => {
  it('returns the single culprit for focused_failure', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-focused')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: 'att_91bc02' });
    const attempts = asArray(result.structured.representativeAttempts).map(asRecord);

    expect(result.structured.state).toBe('focused_failure');
    expect(result.structured.resolvedTargetType).toBe('attempt');
    expect(harness.callsTo(RPC.getFailureDiagnosis)[0]?.body.targetType).toBe('ATTEMPT');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.diagnosis).toContain('out-of-memory');
    expect(result.text).toContain('exit code 137');
    expect(result.text).toContain('JavaScript heap out of memory');
  });

  it('explains an empty diagnosis rather than returning a bare state', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-empty')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: 'run_0000aaaa' });

    expect(result.isError).toBe(false);
    expect(result.structured.state).toBe('empty');
    expect(result.structured.emptyReason).toBe('no_failure_evidence');
    expect(asArray(result.structured.failureGroups)).toHaveLength(0);
    expect(asRecord(result.structured.target).status).toBe('finished');
    expect(result.text).toContain('no failure evidence');
    expect(result.text).toContain('depot_list_ci_runs');
    expect(result.text).toContain(UNTRUSTED_CONTENT_END);
  });

  it('turns over_limit into narrower targets the agent can re-call with', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-over-limit')) },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: 'run_bigmatrix' });
    const targets = asArray(result.structured.narrowerTargets).map(asRecord);

    expect(result.structured.state).toBe('over_limit');
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      targetType: 'workflow',
      targetId: 'wf_unit_tests',
      failedJobCount: 41,
    });
    expect(asRecord(targets[0]?.nextStep)).toMatchObject({
      tool: 'depot_diagnose_ci_failure',
      arguments: { id: 'wf_unit_tests', targetType: 'workflow' },
    });
    expect(result.text).toContain('Too many failures to diagnose at this level');
    expect(result.text).toContain('wf_unit_tests');
  });
});

describe('depot_diagnose_ci_failure — identifier resolution', () => {
  it('tries each target type when the id carries no recognisable prefix', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getFailureDiagnosis]: [NOT_FOUND, NOT_FOUND, NOT_FOUND, ok(fixture('diagnosis-focused'))],
      },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: '01JQ9Z8ABCDEF' });

    const attempted = harness.callsTo(RPC.getFailureDiagnosis).map((call) => call.body.targetType);
    expect(attempted).toEqual(['RUN', 'WORKFLOW', 'JOB', 'ATTEMPT']);
    expect(result.structured.resolvedTargetType).toBe('attempt');
  });

  it('also falls through when Depot rejects the id with invalid_argument', async () => {
    const wrongKind = connectError(400, 'invalid_argument', 'id is not a run');
    harness = await createHarness({
      routes: {
        [RPC.getFailureDiagnosis]: [wrongKind, NOT_FOUND, wrongKind, ok(fixture('diagnosis-focused'))],
      },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: '01JQ9Z8ABCDEF' });

    expect(result.isError).toBe(false);
    expect(harness.callsTo(RPC.getFailureDiagnosis)).toHaveLength(4);
    expect(result.structured.resolvedTargetType).toBe('attempt');
  });

  it('does not mask other Depot errors as a wrong-kind fall-through', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getFailureDiagnosis]: connectError(403, 'permission_denied', 'token lacks ci scope'),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: '01JQ9Z8ABCDEF' });

    expect(result.isError).toBe(true);
    expect(harness.callsTo(RPC.getFailureDiagnosis)).toHaveLength(1);
    expect(result.text).toContain('permission_denied');
  });

  it('respects an explicit targetType and does not guess', async () => {
    harness = await createHarness({
      routes: { [RPC.getFailureDiagnosis]: ok(fixture('diagnosis-focused')) },
    });

    await callTool(harness, 'depot_diagnose_ci_failure', {
      id: '01JQ9Z8ABCDEF',
      targetType: 'job',
    });

    const calls = harness.callsTo(RPC.getFailureDiagnosis);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.targetType).toBe('JOB');
  });

  it('returns an actionable error when nothing matches the id', async () => {
    harness = await createHarness({ routes: { [RPC.getFailureDiagnosis]: [NOT_FOUND] } });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: '01JQ9Z8ABCDEF' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('did not recognise');
    expect(result.text).toContain('DEPOT_ORG_ID');
    expect(result.text).toContain('depot_list_ci_runs');
  });

  it('rejects an unusable argument through schema validation', async () => {
    harness = await createHarness({ routes: {} });

    const result = await callTool(harness, 'depot_diagnose_ci_failure', { id: '' });

    expect(result.isError).toBe(true);
    expect(harness.callsTo(RPC.getFailureDiagnosis)).toHaveLength(0);
  });
});
