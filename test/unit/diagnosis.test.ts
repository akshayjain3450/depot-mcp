import { describe, expect, it } from 'vitest';
import { AI_DISCLOSURE, parseDiagnosis } from '../../src/lib/diagnosis.js';
import { fixture } from '../helpers/harness.js';

const limits = { maxFailureGroups: 5, maxEvidenceLines: 15 };

/** Rewrite every key of a JSON document to snake_case, the way `depot ci diagnose --output json` spells it. */
function snakeCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakeCase);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
        snakeCase(entry),
      ]),
    );
  }
  return value;
}

describe('parseDiagnosis', () => {
  it('reads the CLI snake_case document identically to the Connect camelCase one', () => {
    const camel = fixture('diagnosis-grouped');
    const snake = snakeCase(camel) as Record<string, unknown>;

    expect(parseDiagnosis(snake, limits)).toEqual(parseDiagnosis(camel, limits));
  });

  it('defaults the state to unknown and leaves the disclosure off when there is no AI text', () => {
    const diagnosis = parseDiagnosis({}, limits);

    expect(diagnosis.state).toBe('unknown');
    expect(diagnosis.aiDisclosure).toBeUndefined();
    expect(diagnosis.failureGroups).toEqual([]);
    expect(diagnosis.truncation).toEqual({
      byDepot: false,
      byServer: false,
      omittedFailureGroups: 0,
      omittedAttempts: 0,
      notes: [],
    });
  });

  it('adds the disclosure whenever any diagnosis or fix text is present', () => {
    const viaGroup = parseDiagnosis({ failureGroups: [{ possibleFix: 'x' }] }, limits);
    const viaAttempt = parseDiagnosis({ representativeAttempts: [{ diagnosis: 'x' }] }, limits);
    const viaNested = parseDiagnosis(
      { failureGroups: [{ representatives: [{ diagnosis: 'x' }] }] },
      limits,
    );

    expect(viaGroup.aiDisclosure).toBe(AI_DISCLOSURE);
    expect(viaAttempt.aiDisclosure).toBe(AI_DISCLOSURE);
    expect(viaNested.aiDisclosure).toBe(AI_DISCLOSURE);
  });

  it('maps next commands to tools and leaves unknown kinds without a tool', () => {
    const diagnosis = parseDiagnosis(
      {
        nextCommands: [
          { kind: 'NEXT_COMMAND_KIND_LOGS', targetId: 'att_1', label: 'read logs' },
          { kind: 'NEXT_COMMAND_KIND_RERUN', targetId: 'job_1' },
          { kind: 'NEXT_COMMAND_KIND_SUMMARY' },
          { label: 'no kind at all' },
        ],
      },
      limits,
    );

    expect(diagnosis.nextSteps).toEqual([
      { kind: 'logs', label: 'read logs', tool: 'depot_get_ci_logs', arguments: { id: 'att_1' } },
      { kind: 'rerun', label: undefined, tool: undefined, arguments: {} },
      { kind: 'summary', label: undefined, tool: 'depot_get_ci_job_summary', arguments: {} },
    ]);
  });

  it('caps error messages at 1200 characters and marks the group as truncated', () => {
    const diagnosis = parseDiagnosis(
      {
        failureGroups: [{ errorMessage: 'e'.repeat(2_000) }],
        representativeAttempts: [{ errorMessage: 'e'.repeat(2_000) }],
      },
      limits,
    );

    expect(diagnosis.failureGroups[0]?.errorMessage?.length).toBe(1_200);
    expect(diagnosis.failureGroups[0]?.errorMessageTruncated).toBe(true);
    expect(diagnosis.representativeAttempts[0]?.errorMessage?.length).toBe(1_200);
  });

  it("keeps Depot's own truncation flags even when nothing was cut here", () => {
    const diagnosis = parseDiagnosis(
      {
        failureGroups: [
          {
            errorMessage: 'short',
            errorMessageTruncated: true,
            representatives: [
              { relevantLines: [{ content: 'short', contentTruncated: true, body: 'ignored' }] },
            ],
          },
        ],
      },
      limits,
    );

    expect(diagnosis.failureGroups[0]?.errorMessageTruncated).toBe(true);
    expect(diagnosis.failureGroups[0]?.attempts[0]?.evidence[0]).toMatchObject({
      content: 'short',
      contentTruncated: true,
    });
  });

  it('caps evidence lines at 400 characters and honours a zero evidence limit', () => {
    const source = {
      representativeAttempts: [{ relevantLines: [{ body: 'x'.repeat(1_000) }, { body: 'y' }] }],
    };

    const capped = parseDiagnosis(source, limits).representativeAttempts[0];
    expect(capped?.evidence[0]?.content.length).toBe(400);
    expect(capped?.evidence[0]?.contentTruncated).toBe(true);
    expect(capped?.evidenceOmitted).toBe(0);

    const none = parseDiagnosis(source, { ...limits, maxEvidenceLines: 0 }).representativeAttempts[0];
    expect(none?.evidence).toEqual([]);
    expect(none?.evidenceOmitted).toBe(2);
  });

  it('turns every bounds field into a note', () => {
    const diagnosis = parseDiagnosis(
      {
        bounds: {
          truncated: true,
          omittedFailureGroupCount: 2,
          failureGroupLimit: 5,
          omittedAttemptCount: 7,
          skippedDependentCount: 3,
          totalProblemJobCount: 12,
        },
        context: { truncatedContextFields: ['jobDisplayName', 'workflowName'] },
      },
      limits,
    );
    const notes = diagnosis.truncation.notes.join('\n');

    expect(diagnosis.truncation).toMatchObject({
      byDepot: true,
      byServer: false,
      omittedFailureGroups: 2,
      omittedAttempts: 7,
    });
    expect(notes).toContain('server-side');
    expect(notes).toContain('2 further failure group(s)');
    expect(notes).toContain('limit is 5');
    expect(notes).toContain('7 further failing attempt(s)');
    expect(notes).toContain('3 job(s) never ran');
    expect(notes).toContain('12 problem job(s)');
    expect(notes).toContain('jobDisplayName, workflowName');
  });

  it('parses over-limit breakdowns with their first next command', () => {
    const diagnosis = parseDiagnosis(fixture('diagnosis-over-limit'), limits);

    expect(diagnosis.state).toBe('over_limit');
    expect(diagnosis.narrowerTargets.length).toBeGreaterThan(0);
    for (const target of diagnosis.narrowerTargets) {
      expect(target.targetId).toBeDefined();
      expect(target.nextStep?.tool).toBe('depot_diagnose_ci_failure');
    }
  });

  it('reads the empty state and its reason', () => {
    const diagnosis = parseDiagnosis(fixture('diagnosis-empty'), limits);

    expect(diagnosis.state).toBe('empty');
    expect(diagnosis.emptyReason).toBeDefined();
  });
});
