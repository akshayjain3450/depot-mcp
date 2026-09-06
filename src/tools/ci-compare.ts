import { z } from 'zod';
import { formatDepotError, isDepotRequestError } from '../depot/errors.js';
import type { JsonObject } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import {
  compareJobs,
  diffFailures,
  parseRunMetricsByJob,
  type FailureFingerprint,
  type JobComparison,
  type JobMetrics,
} from '../lib/ci-compare.js';
import {
  isWrongTargetError,
  UNTRUSTED_CI_CONTENT_WARNING,
  UNTRUSTED_CONTENT_BEGIN,
  UNTRUSTED_CONTENT_END,
} from '../lib/ci-target.js';
import {
  countJobs,
  isFailureState,
  parseRunSummary,
  parseRunTree,
  type RunSummary,
  type RunTree,
} from '../lib/ci-tree.js';
import { parseDiagnosis, type FailureGroup } from '../lib/diagnosis.js';
import { formatDuration } from '../lib/time.js';
import { defineTool, ToolInputError, type ToolContext } from '../lib/tool.js';
import { fetchDiagnosis } from './ci-diagnose.js';

const DESCRIPTION = `Compare two Depot CI runs side by side: which jobs changed status, got slower or faster, used more memory, appeared or disappeared, and which failures are new in the second run versus fixed since the first.

Use this when the question is about the difference between two runs rather than one run on its own: "what regressed between these two commits", "is this failure new or was it already broken on main", "did the retry fail the same way" (a flaky failure produces a different error message across runs; a deterministic one repeats), or "why is this run slower than the last one".

runA is the baseline (older, or known-good) and runB is the run under question; deltas read B minus A. Jobs are matched by their job key, so both runs should come from the same workflow or the matrix will be mostly "only in A" and "only in B". Failure fingerprints come from Depot's failure analysis and are only fetched for the sides that actually failed.

For a single run, use depot_diagnose_ci_failure instead: it explains the failure with diagnosis, suggested fix, and evidence lines, none of which this tool returns.`;

/** Diagnosis is compared on group error messages only; evidence lines are never fetched. */
const DIAGNOSIS_LIMITS = { maxFailureGroups: 20, maxEvidenceLines: 0 } as const;

const runIdentitySchema = z.object({
  runId: z.string().optional(),
  repo: z.string().optional(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  trigger: z.string().optional(),
  pr: z.number().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationSeconds: z.number().optional(),
  jobCount: z.number(),
  failedJobCount: z.number(),
});

const fingerprintSchema = z.object({
  errorMessage: z.string(),
  fingerprint: z.string().optional(),
  count: z.number().optional(),
  jobKeys: z.array(z.string()),
});

const sideDataSchema = z.object({
  a: z.string().describe('One of available, unavailable.'),
  b: z.string().describe('One of available, unavailable.'),
});

const outputSchema = {
  runA: runIdentitySchema,
  runB: runIdentitySchema,
  jobs: z.array(
    z.object({
      jobKey: z.string(),
      presence: z.string().describe('One of both, onlyA, onlyB.'),
      statusA: z.string().optional(),
      statusB: z.string().optional(),
      statusChanged: z.boolean(),
      durationSecondsA: z.number().optional(),
      durationSecondsB: z.number().optional(),
      durationDeltaSeconds: z.number().optional().describe('B minus A.'),
      peakMemoryBytesA: z.number().optional(),
      peakMemoryBytesB: z.number().optional(),
      peakMemoryDeltaBytes: z.number().optional().describe('B minus A.'),
      peakMemoryUtilizationA: z.number().optional().describe('Fraction of the memory limit, 0 to 1.'),
      peakMemoryUtilizationB: z.number().optional(),
      peakMemoryUtilizationDelta: z.number().optional().describe('B minus A, in fraction points.'),
    }),
  ),
  jobsReturned: z.number(),
  jobsOmitted: z.number().describe('Rows dropped by maxJobs; changed rows are kept first.'),
  onlyInA: z.array(z.string()),
  onlyInB: z.array(z.string()),
  statusChanges: z.number(),
  failures: z.object({
    newInB: z.array(fingerprintSchema),
    resolvedInB: z.array(fingerprintSchema),
    inBoth: z.array(fingerprintSchema),
  }),
  metrics: sideDataSchema.describe('Whether GetRunMetrics answered for each side.'),
  diagnosis: sideDataSchema
    .extend({
      a: z.string().describe('One of available, unavailable, skipped (run did not fail or includeDiagnosis=false).'),
      b: z.string(),
    })
    .describe('Whether a failure diagnosis was fetched for each side.'),
  notes: z.array(z.string()),
  truncated: z.boolean(),
  contentWarning: z.string(),
};

type Side = 'A' | 'B';

interface RunIdentity extends RunSummary {
  jobCount: number;
  failedJobCount: number;
}

interface SideResult {
  run: RunIdentity;
  tree: RunTree;
  metrics: ReadonlyMap<string, JobMetrics>;
  metricsState: 'available' | 'unavailable';
  failureGroups: FailureGroup[];
  diagnosisState: 'available' | 'unavailable' | 'skipped';
  notes: string[];
}

async function fetchRun(
  context: ToolContext,
  side: Side,
  runId: string,
): Promise<{ run: RunSummary; tree: RunTree }> {
  try {
    const [runResponse, statusResponse] = await Promise.all([
      context.api.getRun(runId),
      context.api.getRunStatus(runId),
    ]);
    return { run: parseRunSummary(runResponse), tree: parseRunTree(statusResponse) };
  } catch (error) {
    if (isWrongTargetError(error)) {
      throw new ToolInputError(
        `Depot did not recognise run${side} "${runId}" as a run in this organization. Find valid run ids with depot_list_ci_runs, and set DEPOT_ORG_ID if the token spans several organizations.`,
      );
    }
    throw error;
  }
}

async function fetchMetrics(
  context: ToolContext,
  runId: string,
): Promise<{ metrics: Map<string, JobMetrics>; error: string | undefined }> {
  try {
    const response: JsonObject = await context.api.getRunMetrics(runId);
    return { metrics: parseRunMetricsByJob(response), error: undefined };
  } catch (error) {
    if (isDepotRequestError(error)) {
      return { metrics: new Map(), error: formatDepotError(error) };
    }
    throw error;
  }
}

async function fetchFailureGroups(
  context: ToolContext,
  runId: string,
): Promise<{ groups: FailureGroup[]; error: string | undefined }> {
  try {
    const { response } = await fetchDiagnosis(context, runId, 'run');
    return { groups: parseDiagnosis(response, DIAGNOSIS_LIMITS).failureGroups, error: undefined };
  } catch (error) {
    if (isDepotRequestError(error)) {
      return { groups: [], error: formatDepotError(error) };
    }
    if (error instanceof ToolInputError) {
      return { groups: [], error: error.message };
    }
    throw error;
  }
}

async function fetchSide(
  context: ToolContext,
  side: Side,
  runId: string,
  includeDiagnosis: boolean,
): Promise<SideResult> {
  const [{ run, tree }, metrics] = await Promise.all([
    fetchRun(context, side, runId),
    fetchMetrics(context, runId),
  ]);
  const counts = countJobs(tree);
  const notes: string[] = [];
  if (metrics.error !== undefined) {
    notes.push(`Metrics for run${side} are unavailable, so its durations and memory are blank: ${metrics.error}`);
  }

  const failed = isFailureState(run.status) || isFailureState(tree.status) || counts.failed > 0;
  let failureGroups: FailureGroup[] = [];
  let diagnosisState: SideResult['diagnosisState'] = 'skipped';
  if (includeDiagnosis && failed) {
    const diagnosis = await fetchFailureGroups(context, runId);
    failureGroups = diagnosis.groups;
    diagnosisState = diagnosis.error === undefined ? 'available' : 'unavailable';
    if (diagnosis.error !== undefined) {
      notes.push(`Failure diagnosis for run${side} is unavailable, so its failures are not in the lists below: ${diagnosis.error}`);
    }
  }

  return {
    run: { ...run, runId: run.runId ?? tree.runId ?? runId, jobCount: counts.total, failedJobCount: counts.failed },
    tree,
    metrics: metrics.metrics,
    metricsState: metrics.error === undefined ? 'available' : 'unavailable',
    failureGroups,
    diagnosisState,
    notes,
  };
}

function signed(value: number, unit: string): string {
  return `${value > 0 ? '+' : ''}${value}${unit}`;
}

function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return mib >= 1024 ? `${(mib / 1024).toFixed(1)}GiB` : `${Math.round(mib)}MiB`;
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function describeRun(run: RunIdentity): string {
  const bits = [
    run.status ?? 'unknown status',
    run.repo === undefined
      ? undefined
      : `${run.repo}${run.sha === undefined ? '' : `@${run.sha.slice(0, 8)}`}`,
    run.trigger === undefined ? undefined : `via ${run.trigger}`,
    formatDuration(run.durationSeconds),
    `${run.jobCount} job(s), ${run.failedJobCount} failed`,
    run.startedAt ?? run.createdAt,
  ].filter((bit): bit is string => bit !== undefined);
  return bits.join(' · ');
}

function describeJobRow(row: JobComparison): string {
  if (row.presence === 'onlyA') {
    return `${row.jobKey}: only in A (${row.statusA ?? 'unknown'})`;
  }
  if (row.presence === 'onlyB') {
    return `${row.jobKey}: only in B (${row.statusB ?? 'unknown'})`;
  }
  const status = `${row.statusA ?? 'unknown'} -> ${row.statusB ?? 'unknown'}`;
  const parts = [status];
  if (row.durationSecondsA !== undefined || row.durationSecondsB !== undefined) {
    let duration = `${formatDuration(row.durationSecondsA)} -> ${formatDuration(row.durationSecondsB)}`;
    if (row.durationDeltaSeconds !== undefined && row.durationDeltaSeconds !== 0) {
      duration += ` (${signed(row.durationDeltaSeconds, 's')})`;
    }
    parts.push(duration);
  }
  if (row.peakMemoryBytesA !== undefined || row.peakMemoryBytesB !== undefined) {
    const a = row.peakMemoryBytesA === undefined ? '?' : formatBytes(row.peakMemoryBytesA);
    const b = row.peakMemoryBytesB === undefined ? '?' : formatBytes(row.peakMemoryBytesB);
    let memory = `peak mem ${a} -> ${b}`;
    if (row.peakMemoryDeltaBytes !== undefined && row.peakMemoryDeltaBytes !== 0) {
      memory += ` (${row.peakMemoryDeltaBytes > 0 ? '+' : '-'}${formatBytes(Math.abs(row.peakMemoryDeltaBytes))})`;
    }
    parts.push(memory);
  } else if (
    row.peakMemoryUtilizationA !== undefined ||
    row.peakMemoryUtilizationB !== undefined
  ) {
    const a = row.peakMemoryUtilizationA === undefined ? '?' : formatPercent(row.peakMemoryUtilizationA);
    const b = row.peakMemoryUtilizationB === undefined ? '?' : formatPercent(row.peakMemoryUtilizationB);
    let memory = `peak mem ${a} -> ${b} of limit`;
    if (row.peakMemoryUtilizationDelta !== undefined && row.peakMemoryUtilizationDelta !== 0) {
      memory += ` (${signed(Number((row.peakMemoryUtilizationDelta * 100).toFixed(1)), ' pts')})`;
    }
    parts.push(memory);
  }
  const marker = row.statusChanged ? ' [changed]' : '';
  return `${row.jobKey}: ${parts.join('; ')}${marker}`;
}

function pushFingerprints(text: TextBudget, heading: string, entries: readonly FailureFingerprint[]): void {
  text.push('', heading);
  if (entries.length === 0) {
    text.push('  (none)');
    return;
  }
  for (const entry of entries) {
    const jobs = entry.jobKeys.length === 0 ? '' : ` [${entry.jobKeys.join(', ')}]`;
    const count = entry.count === undefined || entry.count <= 1 ? '' : ` (${entry.count}x)`;
    text.push(`  - ${entry.errorMessage}${count}${jobs}`);
  }
}

export const compareCiRunsTool = defineTool({
  name: 'depot_compare_ci_runs',
  title: 'Compare two Depot CI runs',
  description: DESCRIPTION,
  inputSchema: {
    runA: z
      .string()
      .trim()
      .min(1)
      .describe('Baseline run id (the older or known-good run), as returned by depot_list_ci_runs.'),
    runB: z
      .string()
      .trim()
      .min(1)
      .describe('Run id to compare against the baseline (the newer or suspect run). Deltas are B minus A.'),
    includeDiagnosis: z
      .boolean()
      .default(true)
      .describe(
        'Fetch Depot failure analysis for each failed side to list failures new in B and resolved in B. Set false to compare only status, timing, and memory.',
      ),
    maxJobs: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe('Cap on job matrix rows. Rows that changed (status or presence) are kept first.'),
  },
  outputSchema,
  handler: async (input, context) => {
    if (input.runA === input.runB) {
      throw new ToolInputError(
        `runA and runB are the same run (${input.runA}); nothing to compare. Pass two different run ids, for example the same workflow on two commits.`,
      );
    }

    const [sideA, sideB] = await Promise.all([
      fetchSide(context, 'A', input.runA, input.includeDiagnosis),
      fetchSide(context, 'B', input.runB, input.includeDiagnosis),
    ]);

    const allRows = compareJobs(sideA.tree, sideB.tree, sideA.metrics, sideB.metrics);
    const rows = allRows.slice(0, input.maxJobs);
    const jobsOmitted = allRows.length - rows.length;
    const onlyInA = allRows.filter((row) => row.presence === 'onlyA').map((row) => row.jobKey);
    const onlyInB = allRows.filter((row) => row.presence === 'onlyB').map((row) => row.jobKey);
    const statusChanges = allRows.filter((row) => row.statusChanged).length;
    const failures = diffFailures(sideA.failureGroups, sideB.failureGroups);

    const notes = [...sideA.notes, ...sideB.notes];
    if (!input.includeDiagnosis) {
      notes.push('Failure diagnosis was not fetched (includeDiagnosis=false); the failure lists are empty.');
    }
    if (sideA.run.repo !== undefined && sideB.run.repo !== undefined && sideA.run.repo !== sideB.run.repo) {
      notes.push('The two runs come from different repositories, so job keys are unlikely to match.');
    }
    if (jobsOmitted > 0) {
      notes.push(`${jobsOmitted} unchanged job row(s) omitted by maxJobs=${input.maxJobs}.`);
    }

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(
      `Depot CI run comparison: A=${sideA.run.runId ?? input.runA} (baseline) vs B=${sideB.run.runId ?? input.runB}. Deltas are B minus A.`,
      UNTRUSTED_CONTENT_BEGIN,
      `A: ${describeRun(sideA.run)}`,
      `B: ${describeRun(sideB.run)}`,
    );
    if (sideA.run.durationSeconds !== undefined && sideB.run.durationSeconds !== undefined) {
      const wall = sideB.run.durationSeconds - sideA.run.durationSeconds;
      text.push(`Wall time: ${wall === 0 ? 'unchanged' : signed(wall, 's')}.`);
    }

    const inBoth = allRows.length - onlyInA.length - onlyInB.length;
    text.push(
      '',
      `Jobs: ${inBoth} in both, ${onlyInA.length} only in A, ${onlyInB.length} only in B, ${statusChanges} status change(s).`,
    );
    if (allRows.length === 0) {
      text.push('  Neither run reports any jobs yet.');
    } else if (allRows.every((row) => row.presence === 'both' && !row.statusChanged)) {
      text.push('  Every job has the same status in both runs.');
    }
    if (rows.length > 0) {
      text.push('', 'Job matrix (A -> B):');
      for (const row of rows) {
        text.push(`  ${describeJobRow(row)}`);
      }
    }

    if (sideA.diagnosisState === 'available' || sideB.diagnosisState === 'available') {
      pushFingerprints(text, 'New failures in B (absent from A):', failures.newInB);
      pushFingerprints(text, 'Resolved in B (present in A only):', failures.resolvedInB);
      if (failures.inBoth.length > 0) {
        pushFingerprints(text, 'Failing the same way in both:', failures.inBoth);
      }
    }
    text.push(UNTRUSTED_CONTENT_END);

    if (notes.length > 0) {
      text.push('', 'Notes:');
      for (const note of notes) {
        text.push(`  - ${note}`);
      }
    }
    const failedSides = [sideA, sideB].filter((side) => side.diagnosisState === 'available');
    if (failedSides.length > 0) {
      text.push(
        '',
        `For root cause and a suggested fix, call depot_diagnose_ci_failure {"id":"${failedSides[failedSides.length - 1]?.run.runId ?? input.runB}"}.`,
      );
    }

    return {
      summary: text.render(),
      data: {
        runA: sideA.run,
        runB: sideB.run,
        jobs: rows,
        jobsReturned: rows.length,
        jobsOmitted,
        onlyInA,
        onlyInB,
        statusChanges,
        failures,
        metrics: { a: sideA.metricsState, b: sideB.metricsState },
        diagnosis: { a: sideA.diagnosisState, b: sideB.diagnosisState },
        notes,
        truncated: text.didOverflow || jobsOmitted > 0,
        contentWarning: UNTRUSTED_CI_CONTENT_WARNING,
      },
    };
  },
});
