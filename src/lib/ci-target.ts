import { DepotApiError } from '../depot/errors.js';
import { parseRunTree, selectInterestingJob } from './ci-tree.js';
import { inferTargetType, type CiTargetType } from './resolve.js';
import { ToolInputError, type ToolContext } from './tool.js';

export interface AttemptOrJob {
  readonly attemptId?: string | undefined;
  readonly jobId?: string | undefined;
}

export interface TargetCandidate {
  readonly request: AttemptOrJob;
  readonly describedAs: string;
}

async function runCandidate(context: ToolContext, runId: string): Promise<TargetCandidate> {
  const tree = parseRunTree(await context.api.getRunStatus(runId));
  const selection = selectInterestingJob(tree);
  if (selection === undefined) {
    throw new ToolInputError(
      `Run ${runId} has no jobs yet, so there is nothing to read. Check its status with depot_get_ci_run.`,
    );
  }

  const label = selection.job.displayName ?? selection.job.key ?? 'a job';
  const attemptId = selection.attempt?.attemptId;
  if (attemptId !== undefined) {
    return { request: { attemptId }, describedAs: `latest attempt of ${label} in run ${runId}` };
  }
  if (selection.job.jobId !== undefined) {
    return { request: { jobId: selection.job.jobId }, describedAs: `${label} in run ${runId}` };
  }
  throw new ToolInputError(
    `Could not find a job or attempt id inside run ${runId}. Call depot_get_ci_run to see its tree, then pass a jobId or attemptId directly.`,
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof DepotApiError && error.code === 'not_found';
}

/**
 * Logs and step summaries are stored per attempt and reachable by attempt id or job id, never by
 * run id. Run the caller's operation against the most likely interpretation of `id` and fall
 * through on not_found, so no request is spent purely on probing.
 */
export async function resolveAttemptTarget<T>(
  context: ToolContext,
  id: string,
  explicit: CiTargetType | undefined,
  operation: (request: AttemptOrJob) => Promise<T>,
): Promise<{ result: T; target: TargetCandidate }> {
  const kind = explicit ?? inferTargetType(id);

  if (kind === 'workflow') {
    throw new ToolInputError(
      `${id} refers to a workflow, but logs and summaries are stored per job attempt. Call depot_get_ci_run on the parent run, or depot_diagnose_ci_failure on this workflow, to get a jobId or attemptId first.`,
    );
  }

  const candidates: TargetCandidate[] = [];
  if (kind === 'attempt') {
    candidates.push({ request: { attemptId: id }, describedAs: `attempt ${id}` });
  } else if (kind === 'job') {
    candidates.push({ request: { jobId: id }, describedAs: `latest attempt of job ${id}` });
  } else if (kind === 'run') {
    candidates.push(await runCandidate(context, id));
  } else {
    candidates.push(
      { request: { attemptId: id }, describedAs: `attempt ${id}` },
      { request: { jobId: id }, describedAs: `latest attempt of job ${id}` },
    );
  }

  let notFound: DepotApiError | undefined;
  for (const candidate of candidates) {
    try {
      return { result: await operation(candidate.request), target: candidate };
    } catch (error) {
      if (!isNotFound(error) || !(error instanceof DepotApiError)) {
        throw error;
      }
      notFound = error;
    }
  }

  if (kind === undefined) {
    try {
      const candidate = await runCandidate(context, id);
      return { result: await operation(candidate.request), target: candidate };
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    throw new ToolInputError(
      `Depot does not recognise "${id}" as an attempt, job, or run in this organization. Use depot_list_ci_runs to find a run, then depot_get_ci_run to get its job and attempt ids. If your token spans several organizations, set DEPOT_ORG_ID.`,
    );
  }

  throw notFound ?? new ToolInputError(`Could not resolve "${id}" to a Depot CI job attempt.`);
}
