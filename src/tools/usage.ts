import { z } from 'zod';
import { DepotApiError } from '../depot/errors.js';
import { readNumber, readObjectArray, readString } from '../depot/shape.js';
import { formatCount, TextBudget } from '../lib/budget.js';
import { parseProject } from '../lib/project.js';
import { formatDuration } from '../lib/time.js';
import { defineTool } from '../lib/tool.js';
import { parseProjectUsage, resolveUsageWindow } from '../lib/usage.js';

const REPO_LIMIT = 20;
const JOBS_PER_REPO_LIMIT = 10;
/** One ListProjects page is enough to name every project a trial or mid-sized organization has. */
const PROJECT_NAME_PAGE_SIZE = 200;

const windowInputSchema = {
  days: z
    .number()
    .int()
    .min(1)
    .max(366)
    .default(30)
    .describe('Look back this many days from now. Ignored when startAt and endAt are both given.'),
  startAt: z
    .string()
    .optional()
    .describe(
      'Start of the window, RFC 3339 or YYYY-MM-DD. Dates are UTC; a date-only value means midnight at the start of that day. Requires endAt.',
    ),
  endAt: z
    .string()
    .optional()
    .describe(
      'End of the window, RFC 3339 or YYYY-MM-DD. Dates are UTC. A date-only value is inclusive: "2024-01-31" covers all of 31 January. Requires startAt.',
    ),
};

const usageRowSchema = z.object({
  label: z.string(),
  buildCount: z.number().optional(),
  minutesBilled: z.number().optional(),
  minutesSaved: z.number().optional(),
});

export const getUsageTool = defineTool({
  name: 'depot_get_usage',
  title: 'Get Depot usage and spend drivers',
  description: `Report Depot usage for a period: container build minutes and minutes saved by caching, GitHub Actions runner minutes by repository and workflow, storage, and agent sandbox minutes.

Use this for cost questions — "what is burning our Depot minutes", "which repo dominates our runner bill", "is the cache actually paying for itself". minutesSaved against minutesBilled is the cache's return on investment; a project with high billed minutes and low saved minutes is where to look first.

This is also the only place Depot exposes managed GitHub Actions runner data through the API, and it is aggregated: there is no per-job runner list.

Pass projectId to scope to one container build project, which returns build counts, duration and layer cache size instead of the organization-wide breakdown. Defaults to the last 30 days.`,
  inputSchema: {
    ...windowInputSchema,
    projectId: z
      .string()
      .optional()
      .describe('Scope to one container build project instead of the whole organization.'),
  },
  outputSchema: {
    periodStart: z.string(),
    periodEnd: z.string(),
    scope: z.string(),
    containerBuild: z.array(usageRowSchema),
    githubActionsJobs: z.array(
      z.object({
        repo: z.string(),
        totalMinutesBilled: z.number().optional(),
        jobs: z.array(
          z.object({
            workflow: z.string().optional(),
            runner: z.string().optional(),
            jobCount: z.number().optional(),
            minutesElapsed: z.number().optional(),
            minutesBilled: z.number().optional(),
          }),
        ),
      }),
    ),
    storage: z.array(z.object({ storageType: z.string().optional(), totalGb: z.number().optional() })),
    agentSandbox: z.array(
      z.object({
        agentType: z.string().optional(),
        sandboxesCount: z.number().optional(),
        minutesElapsed: z.number().optional(),
        minutesBilled: z.number().optional(),
      }),
    ),
    projectUsage: z
      .object({
        projectId: z.string().optional(),
        buildCount: z.number().optional(),
        buildDurationSeconds: z.number().optional(),
        layerCacheSizeGb: z.number().optional(),
      })
      .optional(),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    const { startAt, endAt } = resolveUsageWindow(input);

    const notes: string[] = [];
    const text = new TextBudget(context.config.outputCharBudget);

    if (input.projectId !== undefined) {
      const response = await context.api.getProjectUsage({
        projectId: input.projectId,
        startAt,
        endAt,
      });
      const parsed = parseProjectUsage(response);
      const usage = { ...parsed, projectId: parsed.projectId ?? input.projectId };
      text.push(
        `Usage for project ${usage.projectId} from ${startAt} to ${endAt}:`,
        `  builds: ${usage.buildCount ?? 'unknown'}`,
        `  build duration: ${usage.buildDurationSeconds ?? 'unknown'} seconds`,
        `  layer cache: ${usage.layerCacheSizeGb ?? 'unknown'} GB`,
      );
      return {
        summary: text.render(),
        data: {
          periodStart: startAt,
          periodEnd: endAt,
          scope: `project ${usage.projectId}`,
          containerBuild: [],
          githubActionsJobs: [],
          storage: [],
          agentSandbox: [],
          projectUsage: usage,
          notes,
        },
      };
    }

    const response = await context.api.getUsage({ startAt, endAt });

    const containerBuild = readObjectArray(response, 'containerBuild').map((entry) => ({
      label: readString(entry, 'projectName', 'projectId') ?? 'unknown project',
      buildCount: readNumber(entry, 'buildCount'),
      minutesBilled: readNumber(entry, 'minutesBilled'),
      minutesSaved: readNumber(entry, 'minutesSaved'),
    }));

    const allRepos = readObjectArray(response, 'githubActionsJobs');
    const githubActionsJobs = allRepos.slice(0, REPO_LIMIT).map((entry) => {
      const allJobs = readObjectArray(entry, 'jobs');
      return {
        repo: readString(entry, 'repo') ?? 'unknown repo',
        totalMinutesBilled: readNumber(entry, 'total', 'totalMinutesBilled'),
        jobs: allJobs.slice(0, JOBS_PER_REPO_LIMIT).map((job) => ({
          workflow: readString(job, 'workflow'),
          runner: readString(job, 'runner'),
          jobCount: readNumber(job, 'jobCount'),
          minutesElapsed: readNumber(job, 'minutesElapsed'),
          minutesBilled: readNumber(job, 'minutesBilled'),
        })),
      };
    });
    if (allRepos.length > REPO_LIMIT) {
      notes.push(
        `Showing the first ${REPO_LIMIT} of ${allRepos.length} repositories with runner usage.`,
      );
    }

    const storage = readObjectArray(response, 'storage').map((entry) => ({
      storageType: readString(entry, 'storageType'),
      totalGb: readNumber(entry, 'totalGb'),
    }));
    const agentSandbox = readObjectArray(response, 'agentSandbox').map((entry) => ({
      agentType: readString(entry, 'agentType'),
      sandboxesCount: readNumber(entry, 'sandboxesCount'),
      minutesElapsed: readNumber(entry, 'minutesElapsed'),
      minutesBilled: readNumber(entry, 'minutesBilled'),
    }));

    const periodStart = readString(response, 'periodStart') ?? startAt;
    const periodEnd = readString(response, 'periodEnd') ?? endAt;

    text.push(`Depot usage from ${periodStart} to ${periodEnd}.`);

    if (containerBuild.length > 0) {
      text.push('', 'Container builds:');
      for (const row of containerBuild) {
        text.push(
          `  ${row.label} — ${row.buildCount ?? 0} build(s), ${row.minutesBilled ?? 0} min billed, ${row.minutesSaved ?? 0} min saved by cache`,
        );
      }
    }
    if (githubActionsJobs.length > 0) {
      text.push('', 'GitHub Actions runners (aggregated; Depot exposes no per-job detail):');
      for (const repo of githubActionsJobs) {
        text.push(
          `  ${repo.repo}${repo.totalMinutesBilled === undefined ? '' : ` — ${repo.totalMinutesBilled} min billed`}`,
        );
        for (const job of repo.jobs) {
          text.push(
            `    ${job.workflow ?? 'unknown workflow'} on ${job.runner ?? 'unknown runner'} — ${job.jobCount ?? 0} job(s), ${job.minutesBilled ?? 0} min billed`,
          );
        }
      }
    }
    if (storage.length > 0) {
      text.push('', 'Storage:');
      for (const row of storage) {
        text.push(`  ${row.storageType ?? 'unknown'} — ${row.totalGb ?? 0} GB`);
      }
    }
    if (agentSandbox.length > 0) {
      text.push('', 'Agent sandboxes:');
      for (const row of agentSandbox) {
        text.push(
          `  ${row.agentType ?? 'unknown'} — ${row.sandboxesCount ?? 0} sandbox(es), ${row.minutesBilled ?? 0} min billed`,
        );
      }
    }
    if (
      containerBuild.length === 0 &&
      githubActionsJobs.length === 0 &&
      storage.length === 0 &&
      agentSandbox.length === 0
    ) {
      text.push(
        '',
        'Depot reported no usage in this window. Try a longer window with "days", and check depot_whoami if you expected activity.',
      );
    }
    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }

    return {
      summary: text.render(),
      data: {
        periodStart,
        periodEnd,
        scope: 'organization',
        containerBuild,
        githubActionsJobs,
        storage,
        agentSandbox,
        projectUsage: undefined,
        notes,
      },
    };
  },
});

const projectUsageRowSchema = z.object({
  projectId: z.string(),
  name: z.string().optional(),
  buildCount: z.number().optional(),
  buildDurationSeconds: z.number().optional(),
  layerCacheSizeGb: z.number().optional(),
});

type ProjectUsageRow = z.infer<typeof projectUsageRowSchema>;

/** Largest cache first, then most builds, then id, so two calls over the same data read the same. */
function compareByCacheSize(a: ProjectUsageRow, b: ProjectUsageRow): number {
  return (
    (b.layerCacheSizeGb ?? -1) - (a.layerCacheSizeGb ?? -1) ||
    (b.buildCount ?? -1) - (a.buildCount ?? -1) ||
    a.projectId.localeCompare(b.projectId)
  );
}

export const listProjectUsageTool = defineTool({
  name: 'depot_list_project_usage',
  title: 'List Depot usage per project',
  description: `List every Depot container build project's build count, total build time, and layer cache size for a period, in one call.

Use this for "which project holds the most cache", "which projects are actually building", and "where is our storage going". Rows are sorted by layer cache size, largest first, and carry the project name when depot_list_projects can supply it. For minutes billed and minutes saved by caching use depot_get_usage; for one project's cache health use depot_get_cache_summary.

Organization token only. Defaults to the last 30 days; Depot pages long lists, so re-call with pageToken when nextPageToken is set.`,
  inputSchema: {
    ...windowInputSchema,
    pageToken: z
      .string()
      .optional()
      .describe('Continue a previous listing: pass the nextPageToken from the last call.'),
  },
  outputSchema: {
    periodStart: z.string(),
    periodEnd: z.string(),
    projects: z.array(projectUsageRowSchema),
    returned: z.number(),
    totals: z.object({
      buildCount: z.number(),
      buildDurationSeconds: z.number(),
      layerCacheSizeGb: z.number(),
    }),
    nextPageToken: z.string().optional(),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    const { startAt, endAt } = resolveUsageWindow(input);
    const notes: string[] = [];

    const [usageResponse, names] = await Promise.all([
      context.api.listProjectUsage({ startAt, endAt, pageToken: input.pageToken }),
      resolveProjectNames(context.api.listProjects({ pageSize: PROJECT_NAME_PAGE_SIZE }), notes),
    ]);

    const projects = readObjectArray(usageResponse, 'usage')
      .map(parseProjectUsage)
      .map((row): ProjectUsageRow => {
        const projectId = row.projectId ?? 'unknown project';
        return {
          projectId,
          name: names.get(projectId),
          buildCount: row.buildCount,
          buildDurationSeconds: row.buildDurationSeconds,
          layerCacheSizeGb: row.layerCacheSizeGb,
        };
      })
      .sort(compareByCacheSize);
    const nextPageToken = readString(usageResponse, 'nextPageToken');

    const totals = {
      buildCount: projects.reduce((sum, row) => sum + (row.buildCount ?? 0), 0),
      buildDurationSeconds: projects.reduce((sum, row) => sum + (row.buildDurationSeconds ?? 0), 0),
      layerCacheSizeGb: projects.reduce((sum, row) => sum + (row.layerCacheSizeGb ?? 0), 0),
    };

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(`Per-project usage from ${startAt} to ${endAt}, largest cache first:`);
    if (projects.length === 0) {
      text.push(
        '  Depot reported no project usage in this window.',
        'Try a longer window with "days", and check depot_whoami if you expected activity: this call needs an Organization token.',
      );
    } else {
      const idWidth = Math.max(...projects.map((row) => row.projectId.length));
      for (const row of projects) {
        const label = row.name === undefined ? '' : ` (${row.name})`;
        text.push(
          `  ${row.projectId.padEnd(idWidth)}${label}  builds ${row.buildCount ?? '?'}  build time ${row.buildDurationSeconds === undefined ? '?' : formatDuration(row.buildDurationSeconds)}  cache ${row.layerCacheSizeGb ?? '?'} GB`,
        );
      }
      text.push(
        '',
        `Total on this page: ${formatCount(totals.buildCount, 'build')}, ${formatDuration(totals.buildDurationSeconds)} of build time, ${totals.layerCacheSizeGb} GB of layer cache.`,
      );
    }
    if (nextPageToken !== undefined) {
      text.push('', 'More projects exist than were returned; re-call with pageToken set to nextPageToken.');
    }
    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }

    return {
      summary: text.render(),
      data: {
        periodStart: startAt,
        periodEnd: endAt,
        projects,
        returned: projects.length,
        totals,
        nextPageToken,
        notes,
      },
    };
  },
});

/**
 * Names are decoration, so a failed ListProjects (a user token, say, which this service refuses)
 * degrades to ids with a note instead of failing the usage listing.
 */
async function resolveProjectNames(
  listing: Promise<Record<string, unknown>>,
  notes: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (const project of readObjectArray(await listing, 'projects').map(parseProject)) {
      if (project.projectId !== undefined && project.name !== undefined) {
        names.set(project.projectId, project.name);
      }
    }
  } catch (error) {
    if (!(error instanceof DepotApiError)) {
      throw error;
    }
    notes.push(
      `Project names are missing because ListProjects failed (${error.code}); the ids are still correct.`,
    );
  }
  return names;
}
