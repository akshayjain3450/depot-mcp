import { describe, expect, it } from 'vitest';
import {
  countAttempts,
  isActiveState,
  isFailedJob,
  isTerminalState,
  nodeState,
  parseJobDetail,
  parseWorkflowDetail,
  summariseMutationResponse,
} from '../../src/lib/ci-detail.js';
import { fixture } from '../helpers/harness.js';

describe('terminal and active states', () => {
  it.each(['finished', 'failed', 'cancelled', 'canceled', 'skipped', 'success', 'failure', 'timed_out'])(
    'treats %s as terminal',
    (state) => {
      expect(isTerminalState(state)).toBe(true);
      expect(isActiveState(state)).toBe(false);
    },
  );

  it.each(['queued', 'running', 'pending', 'waiting'])('treats %s as active', (state) => {
    expect(isTerminalState(state)).toBe(false);
    expect(isActiveState(state)).toBe(true);
  });

  it('treats an unknown state as neither, so Depot decides', () => {
    expect(isTerminalState(undefined)).toBe(false);
    expect(isActiveState(undefined)).toBe(false);
  });

  it('reads failure from either conclusion or status, and prefers the conclusion as the state', () => {
    expect(isFailedJob({ status: 'finished', conclusion: 'failure' })).toBe(true);
    expect(isFailedJob({ status: 'failed', conclusion: undefined })).toBe(true);
    expect(isFailedJob({ status: 'finished', conclusion: 'success' })).toBe(false);
    expect(isFailedJob({ status: 'skipped' })).toBe(false);
    expect(nodeState({ status: 'finished', conclusion: 'failure' })).toBe('failure');
    expect(nodeState({ status: 'running' })).toBe('running');
    expect(nodeState({})).toBe('unknown');
  });
});

describe('countAttempts', () => {
  it('takes the largest of the attempt list length, the highest attempt number, and currentAttempt', () => {
    expect(countAttempts({ attempts: [] })).toBe(0);
    expect(countAttempts({ attempts: [{ attempt: 1 }, { attempt: 2 }] })).toBe(2);
    expect(countAttempts({ attempts: [{ attempt: 5 }] })).toBe(5);
    expect(countAttempts({ attempts: [{ attempt: undefined }], currentAttempt: 3 })).toBe(3);
    expect(countAttempts({ attempts: [{ attempt: 1 }, { attempt: 1 }, { attempt: 1 }] })).toBe(3);
  });
});

describe('parseJobDetail', () => {
  it("reads Depot's flat GetJob document, prefixed fields included", () => {
    const job = parseJobDetail(fixture('job'));

    expect(job).toMatchObject({
      jobId: 'job_4d0a77',
      key: 'test (18)',
      displayName: 'test (node 18)',
      status: 'failed',
      conclusion: 'failure',
      errorMessage: 'Step 3 (Run the test suite): script exited with code 1',
      runId: 'run_7f3d9c21',
      runStatus: 'failed',
      workflowId: 'wf_2b8e11',
      workflowName: 'CI',
      workflowStatus: 'failed',
      repo: 'acme/api',
      currentAttempt: 2,
      attemptCount: 2,
      startedAt: '2026-09-05T14:05:00Z',
      finishedAt: '2026-09-05T14:09:39Z',
      durationSeconds: 279,
    });
    expect(job.attempts).toHaveLength(2);
    expect(job.attempts[1]).toMatchObject({ attemptId: 'att_91bc02', attempt: 2, conclusion: 'failure', durationSeconds: 279 });
  });

  it('strips enum prefixes and tolerates snake_case and missing fields', () => {
    const job = parseJobDetail({
      job_id: 'j1',
      job_status: 'JOB_STATUS_RUNNING',
      workflow_id: 'w1',
      attempts: [{ attempt_id: 'a1', attempt: '1', status: 'ATTEMPT_STATUS_RUNNING' }],
    });

    expect(job.jobId).toBe('j1');
    expect(job.status).toBe('running');
    expect(job.conclusion).toBeUndefined();
    expect(job.workflowId).toBe('w1');
    expect(job.attemptCount).toBe(1);
    expect(job.attempts[0]?.status).toBe('running');
    expect(job.durationSeconds).toBeUndefined();
  });
});

describe('parseWorkflowDetail', () => {
  it("reads Depot's flat GetWorkflow document with executions and nested jobs", () => {
    const workflow = parseWorkflowDetail(fixture('workflow'));

    expect(workflow).toMatchObject({
      workflowId: 'wf_2b8e11',
      name: 'CI',
      status: 'failed',
      runId: 'run_7f3d9c21',
      runStatus: 'failed',
      repo: 'acme/api',
      durationSeconds: 446,
    });
    expect(workflow.executions).toEqual([
      {
        executionId: 'exe_0001',
        execution: 1,
        status: 'failed',
        startedAt: '2026-09-05T14:02:13Z',
        finishedAt: '2026-09-05T14:09:39Z',
        durationSeconds: 446,
      },
    ]);
    expect(workflow.jobs.map((job) => [job.key, job.status, job.attemptCount])).toEqual([
      ['lint', 'finished', 1],
      ['test (18)', 'failed', 2],
      ['deploy', 'skipped', 0],
    ]);
  });

  it('returns empty lists rather than failing on a bare document', () => {
    const workflow = parseWorkflowDetail({});

    expect(workflow.workflowId).toBeUndefined();
    expect(workflow.executions).toEqual([]);
    expect(workflow.jobs).toEqual([]);
  });
});

describe('summariseMutationResponse', () => {
  it('collects id-looking strings at any depth, a status, and the top-level keys', () => {
    const summary = summariseMutationResponse({
      runId: 'r1',
      status: 'RUN_STATUS_CANCELLED',
      workflow: { workflowId: 'w1', name: 'CI' },
      jobs: [{ jobId: 'j1' }, { job_id: 'j2' }],
      count: 2,
    });

    expect(summary.ids).toEqual({
      runId: 'r1',
      'workflow.workflowId': 'w1',
      'jobs[0].jobId': 'j1',
      'jobs[1].job_id': 'j2',
    });
    expect(summary.status).toBe('cancelled');
    expect(summary.keys).toEqual(['runId', 'status', 'workflow', 'jobs', 'count']);
  });

  it('bounds what it collects from a large response', () => {
    const jobs = Array.from({ length: 100 }, (_, index) => ({ jobId: `j${index}` }));
    const summary = summariseMutationResponse({ jobs, other: jobs, more: jobs, extra: jobs, last: jobs });

    expect(Object.keys(summary.ids).length).toBeLessThanOrEqual(40);
    expect(summary.ids['jobs[9].jobId']).toBe('j9');
    expect(summary.ids['jobs[10].jobId']).toBeUndefined();
  });

  it('handles an empty body', () => {
    expect(summariseMutationResponse({})).toEqual({ ids: {}, status: undefined, keys: [] });
  });
});
