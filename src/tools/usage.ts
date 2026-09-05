import { z } from 'zod';
import { readNumber, readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import { daysAgoRfc3339, toRfc3339, toRfc3339WindowEnd } from '../lib/time.js';
import { defineTool, ToolInputError } from '../lib/tool.js';

const REPO_LIMIT = 20;
const JOBS_PER_REPO_LIMIT = 10;

function parseWindowBoundary(
  field: 'startAt' | 'endAt',
  value: string,
  convert: (value: string) => string,
): string {
  try {
    return convert(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(`${field}: ${reason}`);
  }
}

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
    if ((input.startAt === undefined) !== (input.endAt === undefined)) {
      throw new ToolInputError(
        'Pass both startAt and endAt, or neither (in which case "days" sets the window).',
      );
    }

    const startAt =
      input.startAt === undefined
        ? daysAgoRfc3339(input.days)
        : parseWindowBoundary('startAt', input.startAt, toRfc3339);
    const endAt =
      input.endAt === undefined
        ? new Date().toISOString()
        : parseWindowBoundary('endAt', input.endAt, toRfc3339WindowEnd);

    const notes: string[] = [];
    const text = new TextBudget(context.config.outputCharBudget);

    if (input.projectId !== undefined) {
      const response = await context.api.getProjectUsage({
        projectId: input.projectId,
        startAt,
        endAt,
      });
      const usage = {
        projectId: readString(response, 'projectId') ?? input.projectId,
        buildCount: readNumber(response, 'buildCount'),
        buildDurationSeconds: readNumber(response, 'buildDurationSeconds'),
        layerCacheSizeGb: readNumber(response, 'layerCacheSizeGb'),
      };
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
