import { z } from 'zod';
import { DepotApiError } from '../depot/errors.js';
import { readObjectArray, readString } from '../depot/shape.js';
import {
  isBuildFailure,
  parseBuild,
  parseBuildStep,
  selectFailingStep,
  type BuildStep,
  type BuildSummary,
} from '../lib/build.js';
import { keepTailWithinBudget, MAX_LOG_LINE_CHARS, TextBudget, truncateText } from '../lib/budget.js';
import { parseProject } from '../lib/project.js';
import { formatDuration } from '../lib/time.js';
import { defineTool, ToolInputError, type ToolContext } from '../lib/tool.js';

const PROJECT_SEARCH_LIMIT = 20;

/** One line per build with its cache ratio; shared by depot_list_builds and the builds resource. */
export function describeBuild(build: BuildSummary): string {
  const cache =
    build.totalSteps === undefined
      ? 'cache unknown'
      : `${build.cachedSteps ?? 0}/${build.totalSteps} cached${
          build.cacheHitRatio === undefined ? '' : ` (${Math.round(build.cacheHitRatio * 100)}%)`
        }`;
  const saved =
    build.savedDurationSeconds === undefined
      ? ''
      : `, saved ${formatDuration(build.savedDurationSeconds)}`;
  return `${build.buildId ?? 'unknown id'} — ${build.status ?? 'unknown'} · ${formatDuration(build.buildDurationSeconds)} · ${cache}${saved} · ${build.createdAt ?? 'unknown time'}`;
}
const BUILD_SEARCH_PAGE_SIZE = 100;
const STEP_PAGE_SIZE = 500;

const buildSummarySchema = z.object({
  buildId: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  buildDurationSeconds: z.number().optional(),
  savedDurationSeconds: z.number().optional(),
  cachedSteps: z.number().optional(),
  totalSteps: z.number().optional(),
  cacheHitRatio: z.number().optional(),
});

/**
 * `GetBuildSteps` is keyed by project as well as build, but `GetBuild` does not return a project id.
 * Fall back to scanning recent builds per project, which is bounded but not cheap — hence the
 * strong preference for an explicit projectId or DEPOT_PROJECT_ID.
 */
async function resolveProjectId(
  context: ToolContext,
  buildId: string,
  explicit: string | undefined,
): Promise<string> {
  const configured = explicit ?? context.config.projectId;
  if (configured !== undefined) {
    return configured;
  }

  const projects = readObjectArray(await context.api.listProjects(), 'projects')
    .map(parseProject)
    .slice(0, PROJECT_SEARCH_LIMIT);

  for (const project of projects) {
    if (project.projectId === undefined) {
      continue;
    }
    const builds = readObjectArray(
      await context.api.listBuilds({
        projectId: project.projectId,
        pageSize: BUILD_SEARCH_PAGE_SIZE,
      }),
      'builds',
    ).map(parseBuild);
    if (builds.some((build) => build.buildId === buildId)) {
      return project.projectId;
    }
  }

  throw new ToolInputError(
    `Could not work out which project build ${buildId} belongs to. Depot's GetBuild response does not include a project id, and the build was not among the ${BUILD_SEARCH_PAGE_SIZE} most recent builds of the first ${PROJECT_SEARCH_LIMIT} projects. Re-call with projectId set (depot_list_projects lists them), or set DEPOT_PROJECT_ID.`,
  );
}

/**
 * Depot's build-step endpoints fail server-side for some builds (observed 2026-09-06: 500
 * "Error fetching build steps" for a failed build, 500 "internal error" for step logs). The
 * build-level facts from GetBuild are still worth returning, so those failures degrade the
 * result instead of replacing it.
 */
function isDepotSideFailure(error: unknown): error is DepotApiError {
  return (
    error instanceof DepotApiError &&
    (error.code === 'internal' || error.code === 'unavailable' || error.code === 'unknown')
  );
}

async function collectSteps(context: ToolContext, projectId: string, buildId: string) {
  const steps: BuildStep[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < context.config.maxLogPages; page += 1) {
    const response = await context.api.getBuildSteps({
      projectId,
      buildId,
      pageSize: STEP_PAGE_SIZE,
      pageToken,
    });
    steps.push(...readObjectArray(response, 'buildSteps', 'steps').map(parseBuildStep));
    const next = readString(response, 'nextPageToken');
    if (next === undefined || next === pageToken) {
      break;
    }
    pageToken = next;
  }
  return steps;
}

interface StepLogs {
  readonly lines: string[];
  /** Lines fell out of the ring buffer because the step logged more than tailLines. */
  readonly truncated: boolean;
  /** DEPOT_MCP_MAX_LOG_PAGES stopped the walk, so `lines` end where reading stopped, not at the end. */
  readonly pageCapHit: boolean;
  readonly nextPageToken: string | undefined;
  readonly pagesFetched: number;
  readonly bodiesTruncated: number;
}

/**
 * `GetBuildStepLogs` pages oldest-first, so the tail is a ring buffer over a bounded walk. When
 * the page cap stops the walk the buffer holds the end of the last page read, not the end of the
 * log, and the caller must say so.
 */
async function collectStepLogs(
  context: ToolContext,
  projectId: string,
  buildId: string,
  digest: string,
  tailLines: number,
): Promise<StepLogs> {
  const buffer: string[] = [];
  let pageToken: string | undefined;
  let truncated = false;
  let bodiesTruncated = 0;
  let pagesFetched = 0;

  for (;;) {
    const response = await context.api.getBuildStepLogs({
      projectId,
      buildId,
      buildStepDigest: digest,
      pageSize: 500,
      pageToken,
    });
    pagesFetched += 1;
    for (const entry of readObjectArray(response, 'logs')) {
      const message = truncateText(readString(entry, 'message') ?? '', MAX_LOG_LINE_CHARS);
      if (message.truncated) {
        bodiesTruncated += 1;
      }
      buffer.push(message.text);
      if (buffer.length > tailLines) {
        buffer.shift();
        truncated = true;
      }
    }
    const next = readString(response, 'nextPageToken');
    const base = { lines: buffer, truncated, pagesFetched, bodiesTruncated };
    if (next === undefined || next === pageToken) {
      return { ...base, pageCapHit: false, nextPageToken: undefined };
    }
    if (pagesFetched >= context.config.maxLogPages) {
      return { ...base, pageCapHit: true, nextPageToken: next };
    }
    pageToken = next;
  }
}

export const diagnoseBuildTool = defineTool({
  name: 'depot_diagnose_build',
  title: 'Diagnose a Depot container build failure',
  description: `Explain why a Depot container build failed: locate the step that broke and return its error and the tail of its logs, alongside cache effectiveness for the build.

Use this for "why did my docker build fail". Unlike Depot CI, container builds have no server-side AI diagnosis, so this tool does the legwork an agent would otherwise do by hand: read the build, page through its steps, pick the step that reported an error (or the last step that actually executed), and fetch only that step's logs.

Pass projectId when you know it. Depot's build record does not include a project id and the steps API requires one, so without it this tool has to scan recent builds across your projects, which costs several extra requests. DEPOT_PROJECT_ID works as a default.

Also reports cachedSteps vs totalSteps and secondsSaved, which is the fastest way to see whether a slow build is a cache miss problem rather than a code problem.

Read-only: this cannot start, retry, or cancel a build. Container builds cannot be triggered through Depot's API at all — a human runs "depot build" locally, or CI runs it.`,
  inputSchema: {
    buildId: z.string().min(1).describe('The build id, as shown by depot_list_builds or the Depot dashboard.'),
    projectId: z
      .string()
      .optional()
      .describe('The project that owns the build. Strongly preferred: without it the server has to search.'),
    tailLines: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe('How many trailing log lines to return from the failing step.'),
  },
  outputSchema: {
    build: buildSummarySchema,
    projectId: z.string(),
    stepCount: z.number(),
    failingStep: z
      .object({
        name: z.string().optional(),
        digest: z.string().optional(),
        cacheState: z.string().optional(),
        error: z.string().optional(),
        errorTruncated: z.boolean().optional(),
        durationSeconds: z.number().optional(),
        selectedBecause: z.string(),
      })
      .optional(),
    logTail: z.array(z.string()),
    logTruncated: z.boolean(),
    logPageCapHit: z.boolean(),
    logNextPageToken: z.string().optional(),
    logLinesTruncated: z.number(),
    cacheSummary: z.object({
      cachedSteps: z.number().optional(),
      totalSteps: z.number().optional(),
      cacheHitRatio: z.number().optional(),
      savedDurationSeconds: z.number().optional(),
    }),
    notes: z.array(z.string()),
    stepsUnavailable: z.boolean().optional(),
    logsUnavailable: z.boolean().optional(),
  },
  handler: async (input, context) => {
    const build = parseBuild(await context.api.getBuild(input.buildId));
    const projectId = await resolveProjectId(context, input.buildId, input.projectId);
    const notes: string[] = [];
    let steps: BuildStep[] = [];
    let stepsUnavailable = false;
    try {
      steps = await collectSteps(context, projectId, input.buildId);
    } catch (error) {
      if (!isDepotSideFailure(error)) {
        throw error;
      }
      stepsUnavailable = true;
      notes.push(
        `Depot could not return this build's steps (server-side ${error.code}: ${error.serverMessage ?? 'no detail'}). Only the build-level facts from GetBuild are available; the Depot dashboard's build page may still show the steps.`,
      );
    }
    const failing = selectFailingStep(steps);

    if (!isBuildFailure(build.status)) {
      notes.push(
        `This build's status is "${build.status ?? 'unknown'}", not a failure. The step below is the last one that executed, not necessarily a problem.`,
      );
    }

    let logTail: string[] = [];
    let logTruncated = false;
    let logPageCapHit = false;
    let logNextPageToken: string | undefined;
    let logLinesTruncated = 0;
    let logPagesFetched = 0;
    let logsUnavailable = false;
    let logs: StepLogs | undefined;
    if (failing?.digest !== undefined && failing.hasLogs) {
      try {
        logs = await collectStepLogs(context, projectId, input.buildId, failing.digest, input.tailLines);
      } catch (error) {
        if (!isDepotSideFailure(error)) {
          throw error;
        }
        logsUnavailable = true;
        notes.push(
          `Depot could not return the step's logs (server-side ${error.code}: ${error.serverMessage ?? 'no detail'}); the step's recorded error is shown instead.`,
        );
      }
    }
    if (logs !== undefined) {
      const budgeted = keepTailWithinBudget(
        logs.lines,
        context.config.outputCharBudget - 1_500,
        (line) => line.length + 1,
      );
      logTail = budgeted.kept;
      logTruncated = logs.truncated || budgeted.dropped > 0 || logs.pageCapHit;
      logPageCapHit = logs.pageCapHit;
      logNextPageToken = logs.nextPageToken;
      logLinesTruncated = logs.bodiesTruncated;
      logPagesFetched = logs.pagesFetched;
      if (budgeted.dropped > 0) {
        notes.push(
          `${budgeted.dropped} earlier log line(s) were dropped to fit the character budget; lower tailLines or raise DEPOT_MCP_OUTPUT_BUDGET.`,
        );
      }
      if (logs.pageCapHit) {
        notes.push(
          `Stopped reading the step's logs after ${logs.pagesFetched} page(s) (DEPOT_MCP_MAX_LOG_PAGES). The lines shown end where reading stopped, not at the end of the step's output; logNextPageToken marks where to continue, and raising DEPOT_MCP_MAX_LOG_PAGES reads further.`,
        );
      }
      if (logs.bodiesTruncated > 0) {
        notes.push(
          `${logs.bodiesTruncated} log line(s) longer than ${MAX_LOG_LINE_CHARS} characters were truncated.`,
        );
      }
    } else if (failing !== undefined && !logsUnavailable) {
      notes.push('Depot reports no logs for this step, so only its recorded error is available.');
    }

    const stepError =
      failing?.error === undefined ? undefined : truncateText(failing.error, MAX_LOG_LINE_CHARS);

    const selectedBecause =
      failing === undefined
        ? ''
        : failing.error !== undefined
          ? 'this step reported an error'
          : failing.cacheState === 'uncached'
            ? 'this was the last step that actually executed rather than hitting cache'
            : 'this was the last step with logs';

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(
      `Build ${build.buildId ?? input.buildId} in project ${projectId} — ${build.status ?? 'unknown status'}, ${formatDuration(build.buildDurationSeconds)}.`,
    );
    if (build.totalSteps !== undefined) {
      const ratio =
        build.cacheHitRatio === undefined ? '' : ` (${Math.round(build.cacheHitRatio * 100)}% cached)`;
      text.push(
        `Steps: ${build.cachedSteps ?? 0} of ${build.totalSteps} served from cache${ratio}.${
          build.savedDurationSeconds === undefined
            ? ''
            : ` Cache saved ${formatDuration(build.savedDurationSeconds)}.`
        }`,
      );
    }

    if (failing === undefined) {
      text.push(
        '',
        stepsUnavailable
          ? 'Depot could not return the steps for this build, so step-level detail is unavailable (see notes).'
          : 'Depot returned no steps for this build, so there is nothing to inspect.',
      );
    } else {
      text.push(
        '',
        `Step to look at: ${failing.name ?? 'unnamed step'} — ${selectedBecause}.`,
        `Cache state: ${failing.cacheState ?? 'unknown'}. Duration: ${formatDuration(failing.durationSeconds)}.`,
      );
      if (stepError !== undefined) {
        text.push(`Error: ${stepError.text}`);
      }
      if (logTail.length > 0) {
        text.push(
          '',
          logPageCapHit
            ? `${logTail.length} log line(s) from that step, from the first ${logPagesFetched} page(s) of its output only. The log continues past what was read:`
            : `Last ${logTail.length} log line(s) from that step:`,
          ...logTail,
        );
      }
    }

    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }

    return {
      summary: text.render(),
      data: {
        build,
        projectId,
        stepCount: steps.length,
        failingStep:
          failing === undefined
            ? undefined
            : {
                name: failing.name,
                digest: failing.digest,
                cacheState: failing.cacheState,
                error: stepError?.text,
                ...(stepError?.truncated === true ? { errorTruncated: true } : {}),
                durationSeconds: failing.durationSeconds,
                selectedBecause,
              },
        logTail,
        logTruncated,
        logPageCapHit,
        logNextPageToken,
        logLinesTruncated,
        ...(stepsUnavailable ? { stepsUnavailable: true } : {}),
        ...(logsUnavailable ? { logsUnavailable: true } : {}),
        cacheSummary: {
          cachedSteps: build.cachedSteps,
          totalSteps: build.totalSteps,
          cacheHitRatio: build.cacheHitRatio,
          savedDurationSeconds: build.savedDurationSeconds,
        },
        notes,
      },
    };
  },
});

const BUILD_TERMINAL_STATES = new Set(['success', 'failed', 'error', 'canceled', 'cancelled']);

function renderCacheLine(build: BuildSummary): string | undefined {
  if (build.totalSteps === undefined) {
    return undefined;
  }
  const ratio =
    build.cacheHitRatio === undefined ? '' : ` (${Math.round(build.cacheHitRatio * 100)}% cached)`;
  const saved =
    build.savedDurationSeconds === undefined
      ? ''
      : ` Cache saved ${formatDuration(build.savedDurationSeconds)}.`;
  return `Steps: ${build.cachedSteps ?? 0} of ${build.totalSteps} served from cache${ratio}.${saved}`;
}

export const getBuildTool = defineTool({
  name: 'depot_get_build',
  title: 'Get a Depot container build',
  description: `Show one Depot container build: its status, when it was created, started and finished, how long it ran, and how much of it the cache served.

Use this to check on a specific build by id: "did build X succeed", "is it still running", "how well did the cache do". It is one request and returns quickly, so it is the right way to poll a build that is in progress; call it again after a pause rather than waiting inside a tool.

It does not explain a failure. When the status is failed, error, or canceled, call depot_diagnose_build with the same buildId (and the projectId, if you know it) to find the failing step and its logs. For a list of recent builds use depot_list_builds; for Depot CI runs, which are a different product, use depot_get_ci_run.`,
  inputSchema: {
    buildId: z
      .string()
      .trim()
      .min(1)
      .describe('The build id, as shown by depot_list_builds or the Depot dashboard.'),
  },
  outputSchema: {
    build: buildSummarySchema,
    terminal: z.boolean().describe('True once the build has stopped, whatever the result.'),
    failure: z.boolean().describe('True for failed, error, or canceled.'),
    cacheSummary: z.object({
      cachedSteps: z.number().optional(),
      totalSteps: z.number().optional(),
      cacheHitRatio: z.number().optional(),
      savedDurationSeconds: z.number().optional(),
    }),
    hint: z.string().optional().describe('The next tool to call, when there is an obvious one.'),
  },
  handler: async (input, context) => {
    const build = parseBuild(await context.api.getBuild(input.buildId));
    const buildId = build.buildId ?? input.buildId;
    const failure = isBuildFailure(build.status);
    const terminal = build.status !== undefined && BUILD_TERMINAL_STATES.has(build.status);
    const hint = failure
      ? `Find the failing step with depot_diagnose_build {"buildId":"${buildId}"}${
          context.config.projectId === undefined ? ' (add projectId if you know it)' : ''
        }.`
      : terminal
        ? undefined
        : `The build has not finished; call depot_get_build {"buildId":"${buildId}"} again after a pause.`;

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(
      `Build ${buildId}: ${build.status ?? 'unknown status'}, ${formatDuration(build.buildDurationSeconds)}.`,
    );
    const timing = [
      build.createdAt === undefined ? undefined : `created ${build.createdAt}`,
      build.startedAt === undefined ? undefined : `started ${build.startedAt}`,
      build.finishedAt === undefined ? undefined : `finished ${build.finishedAt}`,
    ].filter((bit): bit is string => bit !== undefined);
    if (timing.length > 0) {
      text.push(`Timing: ${timing.join(', ')}.`);
    }
    const cacheLine = renderCacheLine(build);
    if (cacheLine !== undefined) {
      text.push(cacheLine);
    }
    if (hint !== undefined) {
      text.push('', hint);
    }

    return {
      summary: text.render(),
      data: {
        build,
        terminal,
        failure,
        cacheSummary: {
          cachedSteps: build.cachedSteps,
          totalSteps: build.totalSteps,
          cacheHitRatio: build.cacheHitRatio,
          savedDurationSeconds: build.savedDurationSeconds,
        },
        hint,
      },
    };
  },
});

export const listBuildsTool = defineTool({
  name: 'depot_list_builds',
  title: 'List Depot container builds',
  description: `List recent container builds for a Depot project, with duration and cache effectiveness for each.

Use this to find a build to diagnose, or to answer "are our builds getting slower" — every row carries cachedSteps, totalSteps and secondsSaved, so a run of builds with a low cache hit ratio is visible immediately without opening the dashboard.

Requires a projectId; DEPOT_PROJECT_ID is used when set, and depot_list_projects lists the options. These are container builds only, not Depot CI runs — use depot_list_ci_runs for those.`,
  inputSchema: {
    projectId: z
      .string()
      .optional()
      .describe('The project to list builds for. Falls back to DEPOT_PROJECT_ID.'),
    limit: z.number().int().min(1).max(100).default(20).describe('Maximum builds to return.'),
    pageToken: z.string().optional().describe('nextPageToken from a previous call.'),
  },
  outputSchema: {
    projectId: z.string(),
    builds: z.array(buildSummarySchema),
    returned: z.number(),
    nextPageToken: z.string().optional(),
  },
  handler: async (input, context) => {
    const projectId = input.projectId ?? context.config.projectId;
    if (projectId === undefined) {
      throw new ToolInputError(
        'A projectId is required to list container builds. Call depot_list_projects to see the options, or set DEPOT_PROJECT_ID to make one the default.',
      );
    }

    const response = await context.api.listBuilds({
      projectId,
      pageSize: input.limit,
      pageToken: input.pageToken,
    });
    const builds = readObjectArray(response, 'builds').map(parseBuild);
    const nextPageToken = readString(response, 'nextPageToken');

    const text = new TextBudget(context.config.outputCharBudget);
    if (builds.length === 0) {
      text.push(
        `Project ${projectId} has no container builds recorded.`,
        'If you expected some, confirm the project id with depot_list_projects and check DEPOT_ORG_ID.',
      );
    } else {
      text.push(`${builds.length} container build(s) for project ${projectId}, newest first:`);
      for (const build of builds) {
        text.push(`  ${describeBuild(build)}`);
      }
      const failed = builds.find((build) => isBuildFailure(build.status));
      if (failed?.buildId !== undefined) {
        text.push(
          '',
          `Diagnose a failure with depot_diagnose_build {"buildId":"${failed.buildId}","projectId":"${projectId}"}.`,
        );
      }
    }
    if (nextPageToken !== undefined) {
      text.push('', `More builds available: re-call with pageToken="${nextPageToken}".`);
    }

    return {
      summary: text.render(),
      data: { projectId, builds, returned: builds.length, nextPageToken },
    };
  },
});