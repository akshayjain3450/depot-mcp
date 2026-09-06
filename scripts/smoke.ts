/**
 * Live read-only smoke test against a real Depot organization.
 *
 *   DEPOT_TOKEN=dp_... npm run smoke
 *
 * Exercises the same client the MCP server uses, reports what it found, and calls no mutating RPC.
 * The token is never printed.
 */
import { ConfigError, loadConfig } from '../src/config.js';
import { DepotApi } from '../src/depot/api.js';
import { DepotClient } from '../src/depot/client.js';
import { DepotApiError, formatDepotError } from '../src/depot/errors.js';
import {
  readNumber,
  readObject,
  readObjectArray,
  readString,
  type JsonObject,
} from '../src/depot/shape.js';
import { isBuildFailure, parseBuild, parseBuildStep, selectFailingStep } from '../src/lib/build.js';
import {
  parseAttemptDetail,
  parseAttempts,
  parseJobDetail,
  parseWorkflowContext,
} from '../src/lib/ci-detail.js';
import { isFailureState, parseRunSummary, parseRunTree, selectInterestingJob } from '../src/lib/ci-tree.js';
import { parseWorkflowListEntry } from '../src/lib/ci-workflow.js';
import { parseDiagnosis } from '../src/lib/diagnosis.js';
import { parseProject } from '../src/lib/project.js';
import { daysAgoRfc3339 } from '../src/lib/time.js';
import { ORGANIZATION_TOKEN_NOTE, USER_TOKEN_WARNING } from '../src/tools/whoami.js';

type Status = 'ok' | 'failed' | 'skipped';

interface Check {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
}

const checks: Check[] = [];

function record(name: string, status: Status, detail: string): void {
  const icon = status === 'ok' ? 'PASS' : status === 'failed' ? 'FAIL' : 'SKIP';
  console.log(`  [${icon}] ${name}: ${detail}`);
  checks.push({ name, status, detail });
}

async function attempt(
  name: string,
  operation: () => Promise<{ detail: string }>,
): Promise<boolean> {
  try {
    const { detail } = await operation();
    record(name, 'ok', detail);
    return true;
  } catch (error) {
    record(name, 'failed', formatDepotError(error).split('\n')[0] ?? 'unknown error');
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new DepotApi(
    new DepotClient({ token: config.token, apiUrl: config.apiUrl, orgId: config.orgId }),
  );

  console.log('depot-mcp live smoke test (read-only)');
  console.log(`  API: ${config.apiUrl}`);
  console.log(`  Organization: ${config.orgId ?? 'not set (DEPOT_ORG_ID unset)'}`);
  console.log(`  Project default: ${config.projectId ?? 'not set (DEPOT_PROJECT_ID unset)'}`);
  console.log('');

  console.log('Identity');
  const listedOrganizations = await attempt('ListOrganizations', async () => {
    const organizations = readObjectArray(await api.listOrganizations(), 'organizations', 'orgs');
    for (const org of organizations) {
      console.log(`         - ${readString(org, 'orgId') ?? '?'} ${readString(org, 'name') ?? ''}`);
    }
    if (organizations.length > 1 && config.orgId === undefined) {
      console.log(
        '         ! Several organizations are visible and DEPOT_ORG_ID is unset; results may come from only one of them.',
      );
    }
    return { detail: `${organizations.length} organization(s) visible` };
  });

  if (!listedOrganizations) {
    console.log(`         ! ${ORGANIZATION_TOKEN_NOTE}`);
  }

  let firstProjectId = config.projectId;
  console.log('');
  console.log('Container builds');
  const listedProjects = await attempt('ListProjects', async () => {
    let response: JsonObject;
    try {
      response = await api.listProjects({ pageSize: 100 });
    } catch (error) {
      if (error instanceof DepotApiError && error.code === 'unauthenticated') {
        console.log(`         ! ${USER_TOKEN_WARNING}`);
      }
      throw error;
    }
    const projects = readObjectArray(response, 'projects').map(parseProject);
    const orgIds = [...new Set(projects.map((project) => project.organizationId).filter(Boolean))];
    if (!listedOrganizations && orgIds.length > 0) {
      console.log(`         - organization id(s) from projects: ${orgIds.join(', ')}`);
    }
    for (const project of projects.slice(0, 10)) {
      console.log(
        `         - ${project.projectId ?? '?'} ${project.name ?? ''} (${project.regionId ?? '?'}, hardware ${project.hardware ?? '?'})`,
      );
    }
    firstProjectId ??= projects[0]?.projectId;
    return { detail: `${projects.length} project(s)` };
  });

  if (!listedOrganizations && listedProjects) {
    // An Organization token cannot list organizations; that is expected, not a failure.
    const index = checks.findIndex((entry) => entry.name === 'ListOrganizations');
    if (index !== -1) {
      checks[index] = {
        name: 'ListOrganizations',
        status: 'skipped',
        detail: 'not available to Organization tokens (expected)',
      };
    }
  }

  if (!listedOrganizations && !listedProjects) {
    console.log('');
    console.log('Authentication failed on both identity checks, so the remaining checks were not attempted.');
    summarise();
    process.exitCode = 1;
    return;
  }

  let failedBuildId: string | undefined;
  if (firstProjectId === undefined) {
    record('ListBuilds', 'skipped', 'no project id available');
  } else {
    const projectId = firstProjectId;
    await attempt('ListBuilds', async () => {
      const builds = readObjectArray(
        await api.listBuilds({ projectId, pageSize: 10 }),
        'builds',
      ).map(parseBuild);
      for (const build of builds.slice(0, 5)) {
        console.log(
          `         - ${build.buildId ?? '?'} ${build.status ?? '?'} ${build.cachedSteps ?? 0}/${build.totalSteps ?? 0} cached`,
        );
      }
      failedBuildId = builds.find((build) => isBuildFailure(build.status))?.buildId;
      return { detail: `${builds.length} build(s) in ${projectId}` };
    });

    await attempt('ListImages', async () => {
      const images = readObjectArray(await api.listImages({ projectId, pageSize: 10 }), 'images');
      return { detail: `${images.length} registry image(s) in ${projectId}` };
    });
  }

  if (failedBuildId === undefined || firstProjectId === undefined) {
    record('GetBuildSteps', 'skipped', 'no failed container build to inspect');
  } else {
    const buildId = failedBuildId;
    const projectId = firstProjectId;
    await attempt('GetBuildSteps', async () => {
      const steps = readObjectArray(
        await api.getBuildSteps({ projectId, buildId, pageSize: 500 }),
        'buildSteps',
        'steps',
      ).map(parseBuildStep);
      const failing = selectFailingStep(steps);
      if (failing !== undefined) {
        console.log(`         - failing step: ${failing.name ?? '?'} (${failing.cacheState ?? '?'})`);
      }
      return { detail: `${steps.length} step(s); depot_diagnose_build is exercisable` };
    });
  }

  console.log('');
  console.log('Depot CI');
  let failedRunId: string | undefined;
  const ciReachable = await attempt('ListRuns', async () => {
    const runs = readObjectArray(await api.listRuns({ pageSize: 10 }), 'runs').map(parseRunSummary);
    for (const run of runs.slice(0, 5)) {
      console.log(
        `         - ${run.runId ?? '?'} ${run.status ?? '?'} ${run.repo ?? '?'} ${run.createdAt ?? ''}`,
      );
    }
    failedRunId = runs.find((run) => isFailureState(run.status))?.runId;
    return {
      detail:
        runs.length === 0
          ? '0 runs — Depot CI may not be enabled for this organization'
          : `${runs.length} run(s)`,
    };
  });

  if (!ciReachable) {
    record('GetFailureDiagnosis', 'skipped', 'ListRuns failed');
  } else if (failedRunId === undefined) {
    await attempt('ListRuns(status=failed)', async () => {
      const runs = readObjectArray(
        await api.listRuns({ status: ['failed'], pageSize: 5 }),
        'runs',
      ).map(parseRunSummary);
      failedRunId = runs[0]?.runId;
      return { detail: `${runs.length} failed run(s) in history` };
    });
  }

  if (failedRunId === undefined) {
    record(
      'GetFailureDiagnosis',
      'skipped',
      'no failed run found — the flagship tool cannot be verified without one',
    );
  } else {
    const runId = failedRunId;
    await attempt('GetFailureDiagnosis', async () => {
      const response: JsonObject = await api.getFailureDiagnosis(runId, 'RUN');
      const diagnosis = parseDiagnosis(response, { maxFailureGroups: 5, maxEvidenceLines: 5 });
      console.log(`         - state: ${diagnosis.state}`);
      console.log(`         - failure groups: ${diagnosis.failureGroups.length}`);
      console.log(`         - failing attempts: ${diagnosis.representativeAttempts.length}`);
      console.log(`         - narrower targets: ${diagnosis.narrowerTargets.length}`);
      console.log(`         - AI text present: ${diagnosis.aiDisclosure !== undefined}`);
      console.log(`         - truncated by Depot: ${diagnosis.truncation.byDepot}`);
      if (diagnosis.truncation.notes.length > 0) {
        console.log(`         - notes: ${diagnosis.truncation.notes.join(' ')}`);
      }
      return { detail: `state=${diagnosis.state} for run ${runId}` };
    });

    await attempt('GetRunStatus', async () => {
      const workflows = readObjectArray(await api.getRunStatus(runId), 'workflows');
      return { detail: `${workflows.length} workflow(s) in the run tree` };
    });

    await attempt('GetJobAttemptLogs', async () => {
      const workflows = readObjectArray(await api.getRunStatus(runId), 'workflows');
      const jobs = workflows.flatMap((workflow) => readObjectArray(workflow, 'jobs'));
      const jobId = jobs.map((job) => readString(job, 'jobId')).find((id) => id !== undefined);
      if (jobId === undefined) {
        return { detail: 'no job id in the run tree; skipped' };
      }
      const response = await api.getJobAttemptLogs({ jobId });
      const lines = readObjectArray(response, 'lines');
      return { detail: `${lines.length} log line(s) on the first page of job ${jobId}` };
    });

    // The failed run's tree gives one workflow, job and attempt id for the detail RPCs.
    const selection = selectInterestingJob(parseRunTree(await api.getRunStatus(runId)));
    const workflowId = selection?.workflow.workflowId;
    const jobId = selection?.job.jobId;
    const attemptId = selection?.attempt?.attemptId;

    if (workflowId === undefined) {
      record('GetWorkflow', 'skipped', 'no workflow id in the run tree');
    } else {
      await attempt('GetWorkflow', async () => {
        const response = await api.getWorkflow(workflowId);
        const workflow = parseWorkflowContext(response);
        const executions = readObjectArray(response, 'executions');
        const jobs = readObjectArray(response, 'jobs');
        return {
          detail: `workflow "${workflow.name ?? '?'}" ${workflow.status ?? '?'}, ${executions.length} execution(s), ${jobs.length} job(s)`,
        };
      });
    }

    if (jobId === undefined) {
      record('GetJob', 'skipped', 'no job id in the run tree');
    } else {
      await attempt('GetJob', async () => {
        const response = await api.getJob(jobId);
        const job = parseJobDetail(response);
        const attempts = parseAttempts(response);
        return {
          detail: `job "${job.jobDisplayName ?? job.jobKey ?? '?'}" ${job.status ?? '?'}/${job.conclusion ?? '?'}, ${attempts.length} attempt(s), current ${job.currentAttemptId ?? '?'}`,
        };
      });
    }

    if (attemptId === undefined) {
      record('GetAttempt', 'skipped', 'no attempt id in the run tree');
    } else {
      await attempt('GetAttempt', async () => {
        const response = await api.getAttempt(attemptId);
        const detail = parseAttemptDetail(readObject(response, 'attempt') ?? {});
        return {
          detail: `attempt ${detail.attempt ?? '?'} ${detail.status ?? '?'}/${detail.conclusion ?? '?'}, sandbox ${detail.sandboxId ?? '?'}, current=${detail.isCurrent ?? '?'}`,
        };
      });
    }
  }

  await attempt('ListWorkflows', async () => {
    const workflows = readObjectArray(await api.listWorkflows({ pageSize: 10 }), 'workflows').map(
      parseWorkflowListEntry,
    );
    for (const workflow of workflows.slice(0, 5)) {
      console.log(
        `         - ${workflow.workflowId ?? '?'} ${workflow.name ?? '?'} ${workflow.status ?? '?'} ${workflow.runId ?? '?'} jobs=${JSON.stringify(workflow.jobCounts)}`,
      );
    }
    return { detail: `${workflows.length} workflow(s) with no status filter` };
  });

  console.log('');
  console.log('CI configuration (names and scoping only)');
  await attempt('ListSecrets', async () => {
    const secrets = readObjectArray(await api.listSecrets(), 'secrets');
    return { detail: `${secrets.length} secret name(s); values are never returned by Depot` };
  });
  await attempt('ListVariables', async () => {
    const variables = readObjectArray(await api.listVariables(), 'variables');
    return { detail: `${variables.length} variable name(s) (values not printed here)` };
  });

  console.log('');
  console.log('Usage');
  await attempt('GetUsage', async () => {
    const response = await api.getUsage({
      startAt: daysAgoRfc3339(7),
      endAt: new Date().toISOString(),
    });
    const builds = readObjectArray(response, 'containerBuild');
    const runners = readObjectArray(response, 'githubActionsJobs');
    const storage = readObjectArray(response, 'storage');
    const savedMinutes = builds.reduce(
      (total, row) => total + (readNumber(row, 'minutesSaved') ?? 0),
      0,
    );
    return {
      detail: `${builds.length} build row(s), ${runners.length} runner repo(s), ${storage.length} storage row(s), ${savedMinutes} min saved by cache in 7 days`,
    };
  });

  summarise();
}

function summarise(): void {
  const passed = checks.filter((check) => check.status === 'ok').length;
  const failed = checks.filter((check) => check.status === 'failed');
  const skipped = checks.filter((check) => check.status === 'skipped');

  console.log('');
  console.log(`Result: ${passed} passed, ${failed.length} failed, ${skipped.length} skipped.`);
  for (const check of failed) {
    console.log(`  FAIL ${check.name}: ${check.detail}`);
  }
  for (const check of skipped) {
    console.log(`  SKIP ${check.name}: ${check.detail}`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(78);
  }
  console.error('Smoke test crashed:', error);
  process.exit(1);
});
