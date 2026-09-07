import { describe, expect, it } from 'vitest';
import { isBuildFailure, parseBuild, parseBuildStep } from '../../src/lib/build.js';
import {
  countJobs,
  isFailureState,
  parseRunSummary,
  parseRunTree,
  selectInterestingJob,
} from '../../src/lib/ci-tree.js';
import { parseProject } from '../../src/lib/project.js';
import {
  candidateTargetTypes,
  CI_TARGET_TYPES,
  inferTargetType,
  normalizeTargetType,
} from '../../src/lib/resolve.js';
import {
  daysAgoRfc3339,
  durationSecondsBetween,
  formatDuration,
  parseTimestamp,
  toRfc3339,
} from '../../src/lib/time.js';

describe('parseBuild', () => {
  it('reads a wrapped or flat build, decoding numeric and symbolic statuses', () => {
    expect(parseBuild({ build: { buildId: 'b', status: 2 } })).toMatchObject({
      buildId: 'b',
      status: 'failed',
    });
    expect(parseBuild({ id: 'b', status: 'STATUS_SUCCESS' }).status).toBe('success');
    expect(parseBuild({ status: 5 }).status).toBe('canceled');
    expect(parseBuild({ status: 99 }).status).toBeUndefined();
    expect(parseBuild({}).status).toBeUndefined();
  });

  it('computes the cache hit ratio to two decimals and skips it for zero steps', () => {
    expect(parseBuild({ cachedSteps: 1, totalSteps: 3 }).cacheHitRatio).toBe(0.33);
    expect(parseBuild({ cachedSteps: '11', totalSteps: '14' }).cacheHitRatio).toBe(0.79);
    expect(parseBuild({ cachedSteps: 0, totalSteps: 0 }).cacheHitRatio).toBeUndefined();
    expect(parseBuild({ cachedSteps: 2 }).cacheHitRatio).toBeUndefined();
  });

  it('derives the duration from timestamps only when Depot gives none', () => {
    const timestamps = { startedAt: '2026-09-03T18:20:00Z', finishedAt: '2026-09-03T18:23:30Z' };

    expect(parseBuild(timestamps).buildDurationSeconds).toBe(210);
    expect(parseBuild({ ...timestamps, buildDurationSeconds: '5' }).buildDurationSeconds).toBe(5);
    expect(parseBuild({ startedAt: 'garbage' }).buildDurationSeconds).toBeUndefined();
  });

  it('classifies failure states including both cancel spellings', () => {
    for (const state of ['failed', 'error', 'canceled', 'cancelled']) {
      expect(isBuildFailure(state), state).toBe(true);
    }
    for (const state of ['success', 'running', 'unspecified', undefined]) {
      expect(isBuildFailure(state), String(state)).toBe(false);
    }
  });
});

describe('parseBuildStep', () => {
  it('decodes numeric and symbolic cache states and string booleans', () => {
    expect(parseBuildStep({ cacheState: 2 }).cacheState).toBe('cached');
    expect(parseBuildStep({ cache_state: 'CACHE_STATE_UNCACHED' }).cacheState).toBe('uncached');
    expect(parseBuildStep({ hasLogs: 'true' }).hasLogs).toBe(true);
    expect(parseBuildStep({}).hasLogs).toBe(false);
  });

  it('computes step duration and keeps an empty error absent', () => {
    const step = parseBuildStep({
      name: 'RUN x',
      startedAt: '2026-09-03T18:20:00Z',
      completedAt: '2026-09-03T18:20:07Z',
      error: '',
    });

    expect(step.durationSeconds).toBe(7);
    expect(step.error).toBeUndefined();
  });
});

describe('parseProject', () => {
  it('decodes hardware from numbers and symbols, including the non-sequential table', () => {
    expect(parseProject({ hardware: 0 }).hardware).toBe('unspecified (defaults to 16x32)');
    expect(parseProject({ hardware: 10 }).hardware).toBe('384x768');
    expect(parseProject({ hardware: 'HARDWARE_4X4' }).hardware).toBe('4x4');
    expect(parseProject({ hardware: 42 }).hardware).toBeUndefined();
  });

  it('accepts the alternative key spellings and a wrapped project', () => {
    const project = parseProject({
      project: { id: 'p', region: 'eu-central-1', orgId: 'o', cachePolicy: { keepGb: '50' } },
    });

    expect(project).toMatchObject({
      projectId: 'p',
      regionId: 'eu-central-1',
      organizationId: 'o',
      cachePolicy: { keepGb: 50, keepDays: undefined },
    });
  });

  it('leaves the cache policy empty when absent', () => {
    expect(parseProject({}).cachePolicy).toEqual({ keepDays: undefined, keepGb: undefined });
  });
});

describe('parseRunTree', () => {
  it('reads a flat tree and a tree nested under run', () => {
    const flat = parseRunTree({ runId: 'r', status: 'STATUS_RUNNING', workflows: [{ id: 'w' }] });
    expect(flat).toMatchObject({ runId: 'r', status: 'running' });
    expect(flat.workflows[0]?.workflowId).toBe('w');

    const nested = parseRunTree({
      run: { id: 'r2', runStatus: 'RUN_STATUS_FAILED', workflows: [{ workflowId: 'w2' }] },
    });
    expect(nested).toMatchObject({ runId: 'r2', status: 'failed' });
    expect(nested.workflows[0]?.workflowId).toBe('w2');
  });

  it('prefers top-level workflows over nested ones when both exist', () => {
    const tree = parseRunTree({
      workflows: [{ id: 'top' }],
      run: { workflows: [{ id: 'nested' }] },
    });

    expect(tree.workflows.map((workflow) => workflow.workflowId)).toEqual(['top']);
  });

  it('parses jobs and attempts through their alternative key spellings', () => {
    const tree = parseRunTree({
      workflows: [
        {
          workflow_name: 'CI',
          workflow_path: '.github/workflows/ci.yml',
          jobs: [
            {
              id: 'j',
              key: 'test',
              name: 'Test',
              job_status: 'JOB_STATUS_FINISHED',
              job_conclusion: 'CONCLUSION_FAILED',
              attempts: [{ id: 'a', attemptNumber: '2', attempt_status: 'ATTEMPT_STATUS_FINISHED' }],
            },
          ],
        },
      ],
    });
    const job = tree.workflows[0]?.jobs[0];

    expect(tree.workflows[0]).toMatchObject({ name: 'CI', path: '.github/workflows/ci.yml' });
    expect(job).toMatchObject({
      jobId: 'j',
      key: 'test',
      displayName: 'Test',
      status: 'finished',
      conclusion: 'failed',
    });
    expect(job?.attempts[0]).toMatchObject({ attemptId: 'a', attempt: 2, status: 'finished' });
  });

  it('handles an empty response', () => {
    expect(parseRunTree({})).toEqual({ runId: undefined, status: undefined, workflows: [] });
  });

  it('strips JOB_CONCLUSION_ and ATTEMPT_CONCLUSION_ prefixes like every other status prefix', () => {
    const tree = parseRunTree({
      workflows: [
        {
          jobs: [
            { conclusion: 'JOB_CONCLUSION_FAILED', attempts: [{ conclusion: 'ATTEMPT_CONCLUSION_FAILED' }] },
          ],
        },
      ],
    });

    expect(tree.workflows[0]?.jobs[0]?.conclusion).toBe('failed');
    expect(tree.workflows[0]?.jobs[0]?.attempts[0]?.conclusion).toBe('failed');
    expect(countJobs(tree).failed).toBe(1);
  });
});

describe('selectInterestingJob and countJobs', () => {
  const job = (jobId: string, conclusion?: string, attempts: number[] = [1]) => ({
    jobId,
    conclusion,
    attempts: attempts.map((attempt) => ({ attemptId: `${jobId}-${attempt}`, attempt })),
  });

  it('returns nothing for a run without jobs', () => {
    expect(selectInterestingJob(parseRunTree({}))).toBeUndefined();
    expect(selectInterestingJob(parseRunTree({ workflows: [{ jobs: [] }] }))).toBeUndefined();
    expect(countJobs(parseRunTree({}))).toEqual({ total: 0, failed: 0 });
  });

  it('picks the first failed job, else the last job', () => {
    const tree = parseRunTree({
      workflows: [
        { jobs: [job('a', 'success'), job('b', 'timed_out'), job('c', 'failed')] },
        { jobs: [job('d', 'success')] },
      ],
    });

    expect(selectInterestingJob(tree)?.job.jobId).toBe('b');
    expect(countJobs(tree)).toEqual({ total: 4, failed: 2 });

    const green = parseRunTree({ workflows: [{ jobs: [job('a', 'success'), job('b', 'success')] }] });
    expect(selectInterestingJob(green)?.job.jobId).toBe('b');
  });

  it('treats a failing status as a failure when there is no conclusion', () => {
    const tree = parseRunTree({ workflows: [{ jobs: [{ jobId: 'a', status: 'cancelled' }, job('b')] }] });

    expect(selectInterestingJob(tree)?.job.jobId).toBe('a');
    expect(selectInterestingJob(tree)?.attempt).toBeUndefined();
  });

  it('picks the highest attempt number regardless of array order', () => {
    const tree = parseRunTree({ workflows: [{ jobs: [job('a', 'failed', [3, 1, 2])] }] });

    expect(selectInterestingJob(tree)?.attempt?.attemptId).toBe('a-3');
  });

  it('recognises every failure spelling Depot uses', () => {
    for (const state of ['failed', 'failure', 'error', 'cancelled', 'canceled', 'timed_out']) {
      expect(isFailureState(state), state).toBe(true);
    }
    expect(isFailureState('skipped')).toBe(false);
    expect(isFailureState(undefined)).toBe(false);
  });
});

describe('parseRunSummary', () => {
  it('reads identity through alternative keys and normalises enums', () => {
    const run = parseRunSummary({
      run: {
        id: 'r',
        repository: 'acme/api',
        headSha: 'abc',
        trigger: 'TRIGGER_WORKFLOW_DISPATCH',
        pullRequest: '412',
        run_status: 'RUN_STATUS_FINISHED',
      },
    });

    expect(run).toMatchObject({
      runId: 'r',
      repo: 'acme/api',
      sha: 'abc',
      trigger: 'workflow_dispatch',
      pr: 412,
      status: 'finished',
    });
  });

  it('prefers an explicit duration over one derived from timestamps', () => {
    const timestamps = { startedAt: '2026-09-03T14:02:19Z', finishedAt: '2026-09-03T14:09:47Z' };

    expect(parseRunSummary(timestamps).durationSeconds).toBe(448);
    expect(parseRunSummary({ ...timestamps, durationSeconds: 10 }).durationSeconds).toBe(10);
  });
});

describe('target type helpers', () => {
  it('requires a separator after the prefix and ignores case', () => {
    expect(inferTargetType('runner-1')).toBeUndefined();
    expect(inferTargetType('jobs')).toBeUndefined();
    expect(inferTargetType('RUN_ABC')).toBe('run');
    expect(inferTargetType('Job-1')).toBe('job');
    expect(inferTargetType('WF-1')).toBe('workflow');
    expect(inferTargetType('')).toBeUndefined();
    expect(inferTargetType('   ')).toBeUndefined();
  });

  it('does not understand dashboard URLs (pinned: they fall back to trying every type)', () => {
    const url = 'https://depot.dev/orgs/acme/ci/runs/run_7f3d9c21';

    expect(inferTargetType(url)).toBeUndefined();
    expect(candidateTargetTypes(url, undefined)).toEqual([...CI_TARGET_TYPES]);
  });

  it('normalises wire spellings case-insensitively', () => {
    expect(normalizeTargetType('Run')).toBe('run');
    expect(normalizeTargetType('target_type_attempt')).toBe('attempt');
    expect(normalizeTargetType('')).toBeUndefined();
  });
});

describe('time helpers', () => {
  it('rejects blank, malformed, and epoch-second inputs', () => {
    for (const value of ['', '   ', '2026-13-45', 'not a date', '1700000000']) {
      expect(() => toRfc3339(value), JSON.stringify(value)).toThrow(/RFC 3339/);
    }
  });

  it('normalises offsets to UTC', () => {
    expect(toRfc3339('2026-08-01T10:00:00+02:00')).toBe('2026-08-01T08:00:00.000Z');
    expect(toRfc3339('2026-08-01T10:00:00.250Z')).toBe('2026-08-01T10:00:00.250Z');
  });

  // Pinned: JavaScript's Date rolls an impossible calendar date forward instead of rejecting it,
  // so a typo like Feb 30 silently becomes Mar 2.
  it('rolls impossible calendar dates forward instead of rejecting them (pinned)', () => {
    expect(toRfc3339('2026-02-30')).toBe('2026-03-02T00:00:00.000Z');
  });

  it('parses timestamps to milliseconds', () => {
    expect(parseTimestamp('1970-01-01T00:00:01Z')).toBe(1000);
    expect(parseTimestamp(undefined)).toBeUndefined();
    expect(parseTimestamp('x')).toBeUndefined();
  });

  it('rounds durations to whole seconds and allows zero', () => {
    const start = '2026-01-01T00:00:00Z';

    expect(durationSecondsBetween(start, start)).toBe(0);
    expect(durationSecondsBetween(start, '2026-01-01T00:00:00.400Z')).toBe(0);
    expect(durationSecondsBetween(start, '2026-01-01T00:00:00.500Z')).toBe(1);
    expect(durationSecondsBetween(start, undefined)).toBeUndefined();
  });

  it('formats hour-scale durations without days and passes odd inputs through (pinned)', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(3_599)).toBe('59m59s');
    expect(formatDuration(3_600)).toBe('1h0m');
    expect(formatDuration(3_660)).toBe('1h1m');
    expect(formatDuration(2 * 86_400 + 60)).toBe('48h1m');
    expect(formatDuration(-5)).toBe('-5s');
    expect(formatDuration(61.5)).toBe('1m1.5s');
  });

  it('computes a window start relative to a supplied now', () => {
    expect(daysAgoRfc3339(30, Date.UTC(2026, 8, 5))).toBe('2026-08-06T00:00:00.000Z');
    expect(daysAgoRfc3339(0, Date.UTC(2026, 8, 5))).toBe('2026-09-05T00:00:00.000Z');
  });
});

describe('inferTargetType with ids seen live', () => {
  it('treats a push-triggered ps_ run id as a run', async () => {
    const { inferTargetType } = await import('../../src/lib/resolve.js');
    expect(inferTargetType('ps_st95t8cmg1')).toBe('run');
    expect(inferTargetType('jlj6ll9tdm')).toBeUndefined();
  });
});
