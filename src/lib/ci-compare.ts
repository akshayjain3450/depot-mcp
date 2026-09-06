import { readNumber, readObject, readObjectArray, readString, type JsonObject } from '../depot/shape.js';
import type { JobNode, RunTree } from './ci-tree.js';
import type { FailureGroup } from './diagnosis.js';
import { durationSecondsBetween } from './time.js';

/**
 * What one job contributed to `GetRunMetrics`. Verified live 2026-09-06: the document nests
 * `workflows[].jobs[].job` (identity plus `startedAt`/`finishedAt`) and
 * `workflows[].jobs[].attempts[].{attempt,availability,stats}`, where `stats` carries
 * `peakMemoryUtilization` as a 0..1 fraction. Depot publishes no schema, so byte-valued spellings
 * are read too in case a later response carries them.
 */
export interface JobMetrics {
  durationSeconds: number | undefined;
  peakMemoryBytes: number | undefined;
  peakMemoryUtilization: number | undefined;
}

function latestAttempt(entries: readonly JsonObject[]): JsonObject | undefined {
  let best: JsonObject | undefined;
  let bestNumber = -1;
  for (const entry of entries) {
    const inner = readObject(entry, 'attempt') ?? entry;
    const number = readNumber(inner, 'attempt', 'attemptNumber') ?? 0;
    if (number >= bestNumber) {
      best = entry;
      bestNumber = number;
    }
  }
  return best;
}

function readStats(attemptEntry: JsonObject | undefined): {
  peakMemoryBytes: number | undefined;
  peakMemoryUtilization: number | undefined;
} {
  const stats = readObject(attemptEntry, 'stats') ?? attemptEntry;
  return {
    peakMemoryBytes: readNumber(stats, 'peakMemoryBytes', 'memoryPeakBytes', 'maxMemoryBytes'),
    peakMemoryUtilization: readNumber(
      stats,
      'peakMemoryUtilization',
      'memoryPeakUtilization',
      'maxMemoryUtilization',
    ),
  };
}

/** Per-job timing and memory read from a `GetRunMetrics` document, keyed the same way as the tree. */
export function parseRunMetricsByJob(response: JsonObject): Map<string, JobMetrics> {
  const byJob = new Map<string, JobMetrics>();
  for (const workflowEntry of readObjectArray(response, 'workflows')) {
    for (const jobEntry of readObjectArray(workflowEntry, 'jobs')) {
      const job = readObject(jobEntry, 'job') ?? jobEntry;
      const key = jobKeyOf({
        key: readString(job, 'jobKey', 'key'),
        displayName: readString(job, 'jobDisplayName', 'displayName', 'name'),
        jobId: readString(job, 'jobId', 'id'),
      });
      if (key === undefined) {
        continue;
      }
      const attempt = latestAttempt(readObjectArray(jobEntry, 'attempts'));
      const attemptInner = readObject(attempt, 'attempt') ?? attempt;
      const durationSeconds =
        readNumber(job, 'durationSeconds') ??
        durationSecondsBetween(readString(job, 'startedAt'), readString(job, 'finishedAt')) ??
        durationSecondsBetween(
          readString(attemptInner, 'startedAt'),
          readString(attemptInner, 'finishedAt'),
        );
      byJob.set(key, { durationSeconds, ...readStats(attempt) });
    }
  }
  return byJob;
}

/**
 * Jobs are matched across runs by `jobKey`, which is stable across runs of the same workflow
 * (`_inline_0.yaml:build`), never by job id, which is fresh per run.
 */
export function jobKeyOf(job: {
  key: string | undefined;
  displayName: string | undefined;
  jobId: string | undefined;
}): string | undefined {
  return job.key ?? job.displayName ?? job.jobId;
}

export type JobPresence = 'both' | 'onlyA' | 'onlyB';

export interface JobComparison {
  jobKey: string;
  presence: JobPresence;
  statusA: string | undefined;
  statusB: string | undefined;
  statusChanged: boolean;
  durationSecondsA: number | undefined;
  durationSecondsB: number | undefined;
  durationDeltaSeconds: number | undefined;
  peakMemoryBytesA: number | undefined;
  peakMemoryBytesB: number | undefined;
  peakMemoryDeltaBytes: number | undefined;
  peakMemoryUtilizationA: number | undefined;
  peakMemoryUtilizationB: number | undefined;
  peakMemoryUtilizationDelta: number | undefined;
}

function jobState(job: JobNode): string | undefined {
  return job.conclusion ?? job.status;
}

function flattenJobs(tree: RunTree): Map<string, JobNode> {
  const jobs = new Map<string, JobNode>();
  for (const workflow of tree.workflows) {
    for (const job of workflow.jobs) {
      const key = jobKeyOf(job);
      if (key !== undefined && !jobs.has(key)) {
        jobs.set(key, job);
      }
    }
  }
  return jobs;
}

function delta(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : b - a;
}

/**
 * Union of both runs' jobs, in A's order with B-only jobs appended. Rows whose presence or status
 * differs come first so a capped matrix still shows every change.
 */
export function compareJobs(
  treeA: RunTree,
  treeB: RunTree,
  metricsA: ReadonlyMap<string, JobMetrics>,
  metricsB: ReadonlyMap<string, JobMetrics>,
): JobComparison[] {
  const jobsA = flattenJobs(treeA);
  const jobsB = flattenJobs(treeB);
  const keys = [...jobsA.keys(), ...[...jobsB.keys()].filter((key) => !jobsA.has(key))];

  const rows = keys.map((jobKey): JobComparison => {
    const a = jobsA.get(jobKey);
    const b = jobsB.get(jobKey);
    const ma = metricsA.get(jobKey);
    const mb = metricsB.get(jobKey);
    const statusA = a === undefined ? undefined : jobState(a);
    const statusB = b === undefined ? undefined : jobState(b);
    return {
      jobKey,
      presence: a === undefined ? 'onlyB' : b === undefined ? 'onlyA' : 'both',
      statusA,
      statusB,
      statusChanged: a !== undefined && b !== undefined && statusA !== statusB,
      durationSecondsA: ma?.durationSeconds,
      durationSecondsB: mb?.durationSeconds,
      durationDeltaSeconds: delta(ma?.durationSeconds, mb?.durationSeconds),
      peakMemoryBytesA: ma?.peakMemoryBytes,
      peakMemoryBytesB: mb?.peakMemoryBytes,
      peakMemoryDeltaBytes: delta(ma?.peakMemoryBytes, mb?.peakMemoryBytes),
      peakMemoryUtilizationA: ma?.peakMemoryUtilization,
      peakMemoryUtilizationB: mb?.peakMemoryUtilization,
      peakMemoryUtilizationDelta: delta(ma?.peakMemoryUtilization, mb?.peakMemoryUtilization),
    };
  });

  const changed = rows.filter((row) => row.presence !== 'both' || row.statusChanged);
  const unchanged = rows.filter((row) => row.presence === 'both' && !row.statusChanged);
  return [...changed, ...unchanged];
}

export interface FailureFingerprint {
  errorMessage: string;
  fingerprint: string | undefined;
  count: number | undefined;
  jobKeys: string[];
}

export interface FailureDiff {
  newInB: FailureFingerprint[];
  resolvedInB: FailureFingerprint[];
  inBoth: FailureFingerprint[];
}

function toFingerprint(group: FailureGroup): FailureFingerprint | undefined {
  const errorMessage = group.errorMessage ?? group.fingerprint;
  if (errorMessage === undefined) {
    return undefined;
  }
  const jobKeys = [
    ...new Set(
      group.attempts
        .map((attempt) => attempt.jobKey)
        .filter((key): key is string => key !== undefined),
    ),
  ];
  return { errorMessage, fingerprint: group.fingerprint, count: group.count, jobKeys };
}

function fingerprintsOf(groups: readonly FailureGroup[]): Map<string, FailureFingerprint> {
  const map = new Map<string, FailureFingerprint>();
  for (const group of groups) {
    const entry = toFingerprint(group);
    if (entry !== undefined && !map.has(entry.errorMessage)) {
      map.set(entry.errorMessage, entry);
    }
  }
  return map;
}

/**
 * Failure groups are matched on their error message rather than Depot's `fingerprint`, which
 * embeds source and message and so would separate identical errors reported from different
 * places. A side with no diagnosis contributes no fingerprints.
 */
export function diffFailures(
  groupsA: readonly FailureGroup[],
  groupsB: readonly FailureGroup[],
): FailureDiff {
  const a = fingerprintsOf(groupsA);
  const b = fingerprintsOf(groupsB);
  return {
    newInB: [...b.values()].filter((entry) => !a.has(entry.errorMessage)),
    resolvedInB: [...a.values()].filter((entry) => !b.has(entry.errorMessage)),
    inBoth: [...b.values()].filter((entry) => a.has(entry.errorMessage)),
  };
}
