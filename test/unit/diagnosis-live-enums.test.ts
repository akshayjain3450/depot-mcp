import { describe, expect, it } from 'vitest';
import { parseDiagnosis, type DiagnosisLimits } from '../../src/lib/diagnosis.js';

const limits: DiagnosisLimits = { maxFailureGroups: 10, maxEvidenceLines: 10 };

/** The enum spellings Depot actually returned on 2026-09-06, as opposed to the CLI's short forms. */
const LIVE_DOCUMENT = {
  state: 'FAILURE_DIAGNOSIS_STATE_GROUPED_FAILURES',
  target: {
    targetId: 'jlj6ll9tdm',
    targetType: 'FAILURE_DIAGNOSIS_TARGET_TYPE_RUN',
    status: 'FAILURE_DIAGNOSIS_RESOURCE_STATUS_FAILED',
  },
  context: { repo: 'akshayjain3450/depot-ci-lab', trigger: 'api' },
  failureGroups: [
    {
      errorMessage: 'Step 3 (Run the test suite): script exited with code 1',
      count: 1,
      representatives: [
        {
          attemptId: 'fxf65mg2k7',
          jobName: '_inline_0.yaml:build',
          attemptConclusion: 'FAILURE_DIAGNOSIS_CONCLUSION_FAILURE',
          attemptStatus: 'FAILURE_DIAGNOSIS_RESOURCE_STATUS_FAILED',
        },
      ],
    },
  ],
  nextCommands: [
    { kind: 'DRILL_DOWN_COMMAND_KIND_LOGS', label: 'Logs', targetId: 'fxf65mg2k7' },
  ],
};

describe('parseDiagnosis with the enum spellings Depot emits live', () => {
  const diagnosis = parseDiagnosis(LIVE_DOCUMENT, limits);

  it('normalises the state, target type and status', () => {
    expect(diagnosis.state).toBe('grouped_failures');
    expect(diagnosis.target.targetType).toBe('run');
    expect(diagnosis.target.status).toBe('failed');
  });

  it('normalises attempt status and conclusion inside groups', () => {
    const representative = diagnosis.failureGroups[0]?.attempts[0];
    expect(representative?.attemptConclusion).toBe('failure');
    expect(representative?.attemptStatus).toBe('failed');
  });

  it('maps the drill-down command kind to the logs tool', () => {
    expect(diagnosis.nextSteps[0]?.kind).toBe('logs');
    expect(diagnosis.nextSteps[0]?.tool).toBe('depot_get_ci_logs');
  });
});
