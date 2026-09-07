import { z } from 'zod';
import type { DepotApi } from '../depot/api.js';
import { DepotApiError } from '../depot/errors.js';
import { readNumber, readObjectArray, readString } from '../depot/shape.js';
import { parseBuild, type BuildSummary } from '../lib/build.js';
import { formatCount, TextBudget } from '../lib/budget.js';
import { parseProject } from '../lib/project.js';
import { daysAgoRfc3339, formatDuration, parseTimestamp } from '../lib/time.js';
import { defineTool, ToolInputError } from '../lib/tool.js';
import { parseProjectUsage, type ProjectUsage } from '../lib/usage.js';

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;
const DEFAULT_BUILD_SAMPLE = 20;
const MAX_BUILD_SAMPLE = 100;
/** ListProjectUsage pages walked while looking for one project before giving up. */
const USAGE_PAGE_CAP = 10;
const USAGE_PAGE_SIZE = 200;
/** Past this share of keepGb, Depot's least-recently-used eviction is close enough to warn about. */
const CACHE_NEAR_LIMIT_RATIO = 0.8;
const LOW_HIT_RATIO = 0.5;
/** Fewer builds than this and a hit ratio says more about the sample than about the cache. */
const MIN_BUILDS_FOR_RATIO = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const LIMITATIONS = [
  "Depot's API does not list individual cache entries or layers; the only cache figure it exposes is the total layer cache size per project.",
  'Resetting a project (which deletes its whole cache) is deliberately not offered by this server. If a reset is truly needed, a human does it in the Depot dashboard.',
];

/**
 * ListProjectUsage rather than GetProjectUsage on purpose: live on 2026-09-06 the two disagreed on
 * buildCount for the same project and window (12 versus 2, where 2 was right), and the list rows
 * match what the dashboard shows. The walk is bounded by USAGE_PAGE_CAP.
 */
async function findProjectUsage(
  api: DepotApi,
  projectId: string,
  window: { startAt: string; endAt: string },
): Promise<{ usage: ProjectUsage | undefined; pageCapHit: boolean }> {
  let pageToken: string | undefined;
  for (let page = 0; page < USAGE_PAGE_CAP; page += 1) {
    const response = await api.listProjectUsage({ ...window, pageSize: USAGE_PAGE_SIZE, pageToken });
    const match = readObjectArray(response, 'usage')
      .map(parseProjectUsage)
      .find((row) => row.projectId === projectId);
    if (match !== undefined) {
      return { usage: match, pageCapHit: false };
    }
    const next = readString(response, 'nextPageToken');
    if (next === undefined || next === pageToken) {
      return { usage: undefined, pageCapHit: false };
    }
    pageToken = next;
  }
  return { usage: undefined, pageCapHit: true };
}

interface BillingRow {
  minutesBilled: number | undefined;
  minutesSaved: number | undefined;
}

/** GetUsage keys its container build rows by project name, not id; a missing row is not an error. */
async function findBillingRow(
  api: DepotApi,
  projectName: string | undefined,
  window: { startAt: string; endAt: string },
  notes: string[],
): Promise<BillingRow | undefined> {
  if (projectName === undefined) {
    return undefined;
  }
  try {
    const row = readObjectArray(await api.getUsage(window), 'containerBuild').find(
      (entry) => readString(entry, 'projectName') === projectName,
    );
    return row === undefined
      ? undefined
      : {
          minutesBilled: readNumber(row, 'minutesBilled'),
          minutesSaved: readNumber(row, 'minutesSaved'),
        };
  } catch (error) {
    if (!(error instanceof DepotApiError)) {
      throw error;
    }
    notes.push(`Minutes billed and saved are missing because GetUsage failed (${error.code}).`);
    return undefined;
  }
}

interface SampleStats {
  builds: number;
  buildsWithStepCounts: number;
  cachedSteps: number;
  totalSteps: number;
  hitRatio: number | undefined;
  savedDurationSeconds: number;
  newestBuildAt: string | undefined;
  oldestBuildAt: string | undefined;
  averageDaysBetweenBuilds: number | undefined;
}

function summariseSample(builds: readonly BuildSummary[]): SampleStats {
  let cachedSteps = 0;
  let totalSteps = 0;
  let buildsWithStepCounts = 0;
  let savedDurationSeconds = 0;
  for (const build of builds) {
    if (build.cachedSteps !== undefined && build.totalSteps !== undefined && build.totalSteps > 0) {
      cachedSteps += build.cachedSteps;
      totalSteps += build.totalSteps;
      buildsWithStepCounts += 1;
    }
    savedDurationSeconds += build.savedDurationSeconds ?? 0;
  }

  const timestamps = builds
    .map((build) => parseTimestamp(build.createdAt))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const oldest = timestamps[0];
  const newest = timestamps[timestamps.length - 1];
  const averageDaysBetweenBuilds =
    oldest !== undefined && newest !== undefined && timestamps.length >= 2
      ? Math.round(((newest - oldest) / (timestamps.length - 1) / DAY_MS) * 10) / 10
      : undefined;

  return {
    builds: builds.length,
    buildsWithStepCounts,
    cachedSteps,
    totalSteps,
    hitRatio: totalSteps > 0 ? Math.round((cachedSteps / totalSteps) * 100) / 100 : undefined,
    savedDurationSeconds,
    newestBuildAt: newest === undefined ? undefined : new Date(newest).toISOString(),
    oldestBuildAt: oldest === undefined ? undefined : new Date(oldest).toISOString(),
    averageDaysBetweenBuilds,
  };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export const getCacheSummaryTool = defineTool({
  name: 'depot_get_cache_summary',
  title: 'Summarise a Depot project cache',
  description: `Report the health of one Depot project's layer cache: the retention policy against the current cache size, the cache hit ratio over recent builds, the time the cache saved, and plain-language observations (cache near its size limit, low hit ratio, builds arriving less often than the retention keeps layers).

Use this for "is our cache working", "why are builds not hitting cache", and "are we about to evict layers". It combines depot_get_project (policy), depot_list_project_usage (current size), depot_list_builds (per-build cache counters) and depot_get_usage (minutes billed and saved) so you do not have to.

What it cannot do: Depot's API does not list individual cache entries, so there is no per-layer view, and this server never resets a project's cache. Requires a projectId or DEPOT_PROJECT_ID, and an Organization token.`,
  inputSchema: {
    projectId: z
      .string()
      .optional()
      .describe('The project to summarise. Falls back to DEPOT_PROJECT_ID; depot_list_projects lists the options.'),
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(MAX_WINDOW_DAYS)
      .default(DEFAULT_WINDOW_DAYS)
      .describe(`Usage window in days, ending now, for cache size and minutes saved. Maximum ${MAX_WINDOW_DAYS}.`),
    buildSample: z
      .number()
      .int()
      .min(1)
      .max(MAX_BUILD_SAMPLE)
      .default(DEFAULT_BUILD_SAMPLE)
      .describe(`How many of the most recent builds to aggregate the hit ratio over. Maximum ${MAX_BUILD_SAMPLE}.`),
  },
  outputSchema: {
    projectId: z.string(),
    projectName: z.string().optional(),
    window: z.object({ startAt: z.string(), endAt: z.string(), days: z.number() }),
    policy: z.object({ keepGb: z.number().optional(), keepDays: z.number().optional() }),
    cache: z.object({
      layerCacheSizeGb: z.number().optional(),
      percentOfKeepGb: z.number().optional(),
      buildCountInWindow: z.number().optional(),
      buildDurationSecondsInWindow: z.number().optional(),
    }),
    sample: z.object({
      builds: z.number(),
      buildsWithStepCounts: z.number(),
      cachedSteps: z.number(),
      totalSteps: z.number(),
      hitRatio: z.number().optional(),
      savedDurationSeconds: z.number(),
      minutesSaved: z.number(),
      newestBuildAt: z.string().optional(),
      oldestBuildAt: z.string().optional(),
      averageDaysBetweenBuilds: z.number().optional(),
    }),
    billing: z
      .object({ minutesBilled: z.number().optional(), minutesSaved: z.number().optional() })
      .optional(),
    observations: z.array(z.string()),
    limitations: z.array(z.string()),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    const projectId = input.projectId ?? context.config.projectId;
    if (projectId === undefined) {
      throw new ToolInputError(
        'A projectId is required to summarise a cache. Call depot_list_projects to see the options, or set DEPOT_PROJECT_ID to make one the default.',
      );
    }

    const now = Date.now();
    const window = { startAt: daysAgoRfc3339(input.windowDays, now), endAt: new Date(now).toISOString() };
    const notes: string[] = [];

    const [project, builds, found] = await Promise.all([
      context.api.getProject(projectId).then(parseProject),
      context.api
        .listBuilds({ projectId, pageSize: input.buildSample })
        .then((response) => readObjectArray(response, 'builds').map(parseBuild)),
      findProjectUsage(context.api, projectId, window),
    ]);
    const billing = await findBillingRow(context.api, project.name, window, notes);

    if (found.pageCapHit) {
      notes.push(
        `Stopped looking for this project in ListProjectUsage after ${USAGE_PAGE_CAP} pages; the current cache size is unknown.`,
      );
    } else if (found.usage === undefined) {
      notes.push(
        `ListProjectUsage returned no row for this project in the last ${input.windowDays} days, which usually means it had no builds in that window; the cache size is only reported for projects with activity.`,
      );
    }

    const sample = summariseSample(builds.slice(0, input.buildSample));
    const keepGb = project.cachePolicy.keepGb;
    const keepDays = project.cachePolicy.keepDays;
    const sizeGb = found.usage?.layerCacheSizeGb;
    const percentOfKeepGb =
      keepGb !== undefined && keepGb > 0 && sizeGb !== undefined
        ? Math.round((sizeGb / keepGb) * 100)
        : undefined;

    const observations: string[] = [];
    if (percentOfKeepGb !== undefined && keepGb !== undefined && sizeGb !== undefined) {
      if (sizeGb >= keepGb) {
        observations.push(
          `The layer cache (${sizeGb} GB) has reached its ${keepGb} GB policy limit, so Depot is evicting least recently used layers on every build; raising keepGb in the dashboard or shrinking image layers stops the churn.`,
        );
      } else if (sizeGb >= keepGb * CACHE_NEAR_LIMIT_RATIO) {
        observations.push(
          `The layer cache is at ${percentOfKeepGb}% of its ${keepGb} GB policy limit; once full, Depot evicts least recently used layers and builds begin to miss cache.`,
        );
      }
    }
    if (
      sample.hitRatio !== undefined &&
      sample.buildsWithStepCounts >= MIN_BUILDS_FOR_RATIO &&
      sample.hitRatio < LOW_HIT_RATIO
    ) {
      observations.push(
        `Only ${percent(sample.hitRatio)} of steps across the last ${formatCount(sample.buildsWithStepCounts, 'build')} came from cache. Usual causes: a COPY of the whole source tree before dependency installation, a build argument or base image that changes each run, or builds on differing platforms. depot_diagnose_build shows which steps missed.`,
      );
    }
    if (keepDays !== undefined && sample.averageDaysBetweenBuilds !== undefined) {
      if (sample.averageDaysBetweenBuilds > keepDays) {
        observations.push(
          `Builds arrive about every ${sample.averageDaysBetweenBuilds} days but the policy keeps layers for ${keepDays} days, so most builds start with a cold cache; a longer keepDays would let them reuse layers.`,
        );
      }
    }
    if (keepDays !== undefined && sample.newestBuildAt !== undefined) {
      const ageDays = (now - (parseTimestamp(sample.newestBuildAt) ?? now)) / DAY_MS;
      if (ageDays > keepDays) {
        observations.push(
          `The most recent build was ${Math.floor(ageDays)} days ago, past the ${keepDays}-day retention, so the next build will start cold.`,
        );
      }
    }
    if (sample.builds === 0) {
      observations.push('No builds were returned for this project, so there is no hit ratio to report.');
    } else if (sample.buildsWithStepCounts === 0) {
      observations.push(
        'Depot returned no step counts for the sampled builds, so the hit ratio could not be computed.',
      );
    } else if (observations.length === 0) {
      observations.push('Nothing stands out: cache size, hit ratio and build cadence all look healthy in this sample.');
    }

    const text = new TextBudget(context.config.outputCharBudget);
    const label = project.name === undefined ? projectId : `${projectId} (${project.name})`;
    text.push(`Cache summary for project ${label}, last ${input.windowDays} day(s).`);
    const policyBits = [
      keepGb === undefined ? undefined : `${keepGb} GB`,
      keepDays === undefined ? undefined : `${keepDays} days`,
    ].filter((part): part is string => part !== undefined);
    text.push(
      `Policy: ${policyBits.length === 0 ? 'unknown' : `keeps ${policyBits.join(' / ')}`}. Current layer cache: ${
        sizeGb === undefined ? 'unknown' : `${sizeGb} GB`
      }${percentOfKeepGb === undefined ? '' : ` (${percentOfKeepGb}% of the limit)`}.`,
    );
    if (found.usage !== undefined) {
      text.push(
        `Builds in window: ${found.usage.buildCount ?? 'unknown'}, ${
          found.usage.buildDurationSeconds === undefined ? 'unknown' : formatDuration(found.usage.buildDurationSeconds)
        } of build time.`,
      );
    }
    if (sample.builds > 0) {
      const ratio =
        sample.hitRatio === undefined
          ? 'no step counts reported'
          : `${sample.cachedSteps} of ${sample.totalSteps} steps from cache (${percent(sample.hitRatio)} hit ratio)`;
      text.push(
        `Last ${formatCount(sample.builds, 'build')}: ${ratio}; cache saved ${formatDuration(sample.savedDurationSeconds)} (${Math.round(sample.savedDurationSeconds / 60)} min).`,
      );
    }
    if (billing !== undefined) {
      text.push(
        `Billing in window: ${billing.minutesBilled ?? 0} min billed, ${billing.minutesSaved ?? 0} min saved by cache.`,
      );
    }
    text.push('', 'Observations:', ...observations.map((line) => `  - ${line}`));
    text.push('', 'Limits:', ...LIMITATIONS.map((line) => `  - ${line}`));
    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }

    return {
      summary: text.render(),
      data: {
        projectId,
        projectName: project.name,
        window: { ...window, days: input.windowDays },
        policy: { keepGb, keepDays },
        cache: {
          layerCacheSizeGb: sizeGb,
          percentOfKeepGb,
          buildCountInWindow: found.usage?.buildCount,
          buildDurationSecondsInWindow: found.usage?.buildDurationSeconds,
        },
        sample: { ...sample, minutesSaved: Math.round(sample.savedDurationSeconds / 60) },
        billing,
        observations,
        limitations: LIMITATIONS,
        notes,
      },
    };
  },
});
