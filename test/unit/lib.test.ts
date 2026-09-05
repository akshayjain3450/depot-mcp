import { describe, expect, it } from 'vitest';
import { DepotApiError } from '../../src/depot/errors.js';
import { selectFailingStep, type BuildStep } from '../../src/lib/build.js';
import { keepHeadWithinBudget, keepTailWithinBudget, TextBudget, truncateText } from '../../src/lib/budget.js';
import { isWrongTargetError } from '../../src/lib/ci-target.js';
import { parseDiagnosis } from '../../src/lib/diagnosis.js';
import { redactValue } from '../../src/lib/redact.js';
import {
  candidateTargetTypes,
  inferTargetType,
  normalizeTargetType,
  toDiagnosisTargetType,
} from '../../src/lib/resolve.js';
import {
  durationSecondsBetween,
  formatDuration,
  isDateOnly,
  toRfc3339,
  toRfc3339WindowEnd,
} from '../../src/lib/time.js';

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('hello', 10)).toEqual({
      text: 'hello',
      truncated: false,
      originalLength: 5,
    });
  });

  it('caps long text at the limit and reports the original length', () => {
    const result = truncateText('x'.repeat(100), 20);

    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(100);
    expect(result.text).toHaveLength(20);
  });
});

describe('budget windows', () => {
  const entries = ['aaaa', 'bbbb', 'cccc', 'dddd'];
  const size = (entry: string): number => entry.length;

  it('keeps the last entries that fit', () => {
    expect(keepTailWithinBudget(entries, 9, size)).toEqual({ kept: ['cccc', 'dddd'], dropped: 2 });
  });

  it('keeps the first entries that fit', () => {
    expect(keepHeadWithinBudget(entries, 9, size)).toEqual({ kept: ['aaaa', 'bbbb'], dropped: 2 });
  });

  it('always keeps at least one entry even if it exceeds the budget', () => {
    expect(keepTailWithinBudget(['enormous'], 2, size).kept).toEqual(['enormous']);
  });

  it('handles an empty input', () => {
    expect(keepTailWithinBudget([], 10, size)).toEqual({ kept: [], dropped: 0 });
  });
});

describe('TextBudget', () => {
  it('joins lines while under the limit', () => {
    const budget = new TextBudget(100);
    budget.push('one', 'two');

    expect(budget.render()).toBe('one\ntwo');
    expect(budget.didOverflow).toBe(false);
  });

  it('stops accepting lines and says so once the budget is spent', () => {
    const budget = new TextBudget(20);
    budget.push('a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10));

    expect(budget.didOverflow).toBe(true);
    expect(budget.render()).toContain('output truncated');
    expect(budget.render()).not.toContain('c'.repeat(10));
  });
});

describe('redactValue', () => {
  it('redacts on a credential-shaped name', () => {
    const result = redactValue('SENTRY_AUTH_TOKEN', 'anything');

    expect(result.redacted).toBe(true);
    expect(result.reason).toBe('name');
    expect(result.value).toContain('redacted by depot-mcp');
    expect(result.value).not.toContain('anything');
  });

  it('redacts recognised credential formats regardless of name', () => {
    const cases = [
      'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
      'github_pat_11ABCDEFG0abcdefghijkl_ABCDEFGHIJKLMNOP',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'xoxb-123456789012-abcdefghijkl',
      'AKIAIOSFODNN7EXAMPLE',
      'glpat-abcdefghijklmnopqrst',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      '-----BEGIN RSA PRIVATE KEY-----',
    ];

    for (const value of cases) {
      const result = redactValue('HARMLESS_NAME', value);
      expect(result.redacted, value).toBe(true);
      expect(result.reason, value).toBe('pattern');
    }
  });

  it('redacts long high-entropy values', () => {
    const result = redactValue('BUILD_ARG', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6');

    expect(result.redacted).toBe(true);
    expect(result.reason).toBe('entropy');
  });

  it('leaves ordinary configuration values intact', () => {
    for (const [name, value] of [
      ['NODE_ENV', 'production'],
      ['DEPLOY_BUCKET', 'acme-artifacts-prod'],
      ['LOG_LEVEL', 'debug'],
      ['REGION', 'us-east-1'],
      ['FEATURE_FLAGS', 'new-billing,fast-checkout'],
      ['EMPTY', ''],
    ]) {
      const result = redactValue(name ?? '', value ?? '');
      expect(result.redacted, `${name ?? ''}=${value ?? ''}`).toBe(false);
      expect(result.value).toBe(value);
    }
  });
});

describe('target type resolution', () => {
  it('infers a type from a recognisable prefix', () => {
    expect(inferTargetType('run_7f3d')).toBe('run');
    expect(inferTargetType('wf_2b8e')).toBe('workflow');
    expect(inferTargetType('workflow-99')).toBe('workflow');
    expect(inferTargetType('job_4d0a')).toBe('job');
    expect(inferTargetType('att_91bc')).toBe('attempt');
    expect(inferTargetType('attempt_1')).toBe('attempt');
    expect(inferTargetType('01JQ9Z8ABCDEF')).toBeUndefined();
  });

  it('prefers an explicit type, then a prefix, then every type in turn', () => {
    expect(candidateTargetTypes('run_7f3d', 'job')).toEqual(['job']);
    expect(candidateTargetTypes('run_7f3d', undefined)).toEqual(['run']);
    expect(candidateTargetTypes('01JQ9Z8', undefined)).toEqual([
      'run',
      'workflow',
      'job',
      'attempt',
    ]);
  });

  it('maps to and from the wire spelling', () => {
    expect(toDiagnosisTargetType('attempt')).toBe('ATTEMPT');
    expect(normalizeTargetType('TARGET_TYPE_JOB')).toBe('job');
    expect(normalizeTargetType('WORKFLOW')).toBe('workflow');
    expect(normalizeTargetType('nonsense')).toBeUndefined();
    expect(normalizeTargetType(undefined)).toBeUndefined();
  });
});

describe('isWrongTargetError', () => {
  const apiError = (code: DepotApiError['code']): DepotApiError =>
    new DepotApiError({ code, httpStatus: 400, rpc: 'depot.ci.v1.CIService/GetJobSummary' });

  it('treats both not_found and invalid_argument as "wrong kind of id"', () => {
    expect(isWrongTargetError(apiError('not_found'))).toBe(true);
    expect(isWrongTargetError(apiError('invalid_argument'))).toBe(true);
  });

  it('does not swallow other Depot errors or non-Depot errors', () => {
    expect(isWrongTargetError(apiError('permission_denied'))).toBe(false);
    expect(isWrongTargetError(apiError('unavailable'))).toBe(false);
    expect(isWrongTargetError(new Error('not_found'))).toBe(false);
    expect(isWrongTargetError(undefined)).toBe(false);
  });
});

describe('parseDiagnosis', () => {
  const limits = { maxFailureGroups: 5, maxEvidenceLines: 15 };

  it('strips every Depot status prefix, not just STATUS_', () => {
    const diagnosis = parseDiagnosis(
      {
        state: 'STATE_OVER_LIMIT',
        target: { targetId: 'run_1', targetType: 'TARGET_TYPE_RUN', status: 'RUN_STATUS_FAILED' },
        overLimitBreakdown: [
          { targetType: 'TARGET_TYPE_JOB', targetId: 'job_1', status: 'JOB_STATUS_FAILED' },
          { targetType: 'TARGET_TYPE_WORKFLOW', targetId: 'wf_1', status: 'STATUS_FAILED' },
        ],
      },
      limits,
    );

    expect(diagnosis.target.status).toBe('failed');
    expect(diagnosis.narrowerTargets.map((target) => target.status)).toEqual(['failed', 'failed']);
  });

  it('caps AI prose and labels so repository content cannot flood the output', () => {
    const diagnosis = parseDiagnosis(
      {
        state: 'STATE_GROUPED_FAILURES',
        failureGroups: [
          {
            diagnosis: 'd'.repeat(5_000),
            possibleFix: 'f'.repeat(5_000),
            representatives: [{ attemptId: 'att_1', diagnosis: 'x'.repeat(5_000) }],
          },
        ],
        nextCommands: [
          { kind: 'NEXT_COMMAND_KIND_LOGS', targetId: 'att_1', label: 'l'.repeat(1_000) },
        ],
        overLimitBreakdown: [{ targetId: 'wf_1', label: 'w'.repeat(1_000) }],
      },
      limits,
    );

    const group = diagnosis.failureGroups[0];
    expect(group?.diagnosis?.length).toBeLessThanOrEqual(2_000);
    expect(group?.possibleFix?.length).toBeLessThanOrEqual(2_000);
    expect(group?.attempts[0]?.diagnosis?.length).toBeLessThanOrEqual(2_000);
    expect(diagnosis.nextSteps[0]?.label?.length).toBeLessThanOrEqual(200);
    expect(diagnosis.narrowerTargets[0]?.label?.length).toBeLessThanOrEqual(200);
  });
});

describe('time helpers', () => {
  it('computes a duration between two timestamps', () => {
    expect(durationSecondsBetween('2026-09-03T14:02:19Z', '2026-09-03T14:09:47Z')).toBe(448);
    expect(durationSecondsBetween('2026-09-03T14:09:47Z', '2026-09-03T14:02:19Z')).toBeUndefined();
    expect(durationSecondsBetween(undefined, '2026-09-03T14:09:47Z')).toBeUndefined();
    expect(durationSecondsBetween('nonsense', '2026-09-03T14:09:47Z')).toBeUndefined();
  });

  it('formats durations for humans', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(448)).toBe('7m28s');
    expect(formatDuration(7_200)).toBe('2h0m');
    expect(formatDuration(undefined)).toBe('unknown duration');
  });

  it('normalises dates and rejects unparseable ones', () => {
    expect(toRfc3339('2026-08-01')).toBe('2026-08-01T00:00:00.000Z');
    expect(() => toRfc3339('last tuesday')).toThrow(/RFC 3339/);
  });

  it('recognises a bare date', () => {
    expect(isDateOnly('2024-01-31')).toBe(true);
    expect(isDateOnly(' 2024-01-31 ')).toBe(true);
    expect(isDateOnly('2024-01-31T00:00:00Z')).toBe(false);
    expect(isDateOnly('2024-01')).toBe(false);
  });

  it('makes a date-only window end inclusive of that day', () => {
    expect(toRfc3339WindowEnd('2024-01-31')).toBe('2024-02-01T00:00:00.000Z');
    expect(toRfc3339WindowEnd('2024-12-31')).toBe('2025-01-01T00:00:00.000Z');
    expect(toRfc3339WindowEnd('2024-01-31T12:30:00Z')).toBe('2024-01-31T12:30:00.000Z');
    expect(() => toRfc3339WindowEnd('yesterday')).toThrow(/RFC 3339/);
  });
});

describe('selectFailingStep', () => {
  const step = (overrides: Partial<BuildStep>): BuildStep => ({
    name: 'step',
    digest: 'sha256:0',
    startedAt: undefined,
    completedAt: undefined,
    cacheState: 'cached',
    error: undefined,
    hasLogs: false,
    durationSeconds: undefined,
    ...overrides,
  });

  it('prefers the step that reported an error', () => {
    const steps = [
      step({ digest: 'a', cacheState: 'uncached', hasLogs: true }),
      step({ digest: 'b', error: 'exit code 2', cacheState: 'uncached', hasLogs: true }),
      step({ digest: 'c', cacheState: 'uncached', hasLogs: true }),
    ];

    expect(selectFailingStep(steps)?.digest).toBe('b');
  });

  it('falls back to the last step that actually executed', () => {
    const steps = [
      step({ digest: 'a', cacheState: 'cached', hasLogs: true }),
      step({ digest: 'b', cacheState: 'uncached', hasLogs: true }),
      step({ digest: 'c', cacheState: 'uncached', hasLogs: false }),
    ];

    expect(selectFailingStep(steps)?.digest).toBe('b');
  });

  it('falls back to any step with logs, and gives up on none', () => {
    expect(selectFailingStep([step({ digest: 'a', hasLogs: true })])?.digest).toBe('a');
    expect(selectFailingStep([step({ digest: 'a' })])).toBeUndefined();
    expect(selectFailingStep([])).toBeUndefined();
  });
});
