import { z } from 'zod';
import { readObjectArray, readString } from '../depot/shape.js';
import { parseBuild } from '../lib/build.js';
import {
  effectiveHardware,
  HARDWARE_LABELS,
  hardwareWireName,
  parseProject,
  type ProjectSummary,
} from '../lib/project.js';
import { parseTimestamp } from '../lib/time.js';
import { ToolInputError, type ToolContext } from '../lib/tool.js';
import { defineWriteTool } from '../lib/write.js';
import { describeProject, projectSchema } from './projects.js';

const projectIdField = z
  .string()
  .min(1)
  .describe('The project id, as shown by depot_list_projects or depot_get_project.');

function show(value: string | number | undefined): string {
  return value === undefined ? 'unknown' : String(value);
}

function hoursText(hours: number): string {
  return hours < 1 ? 'under an hour' : `${Math.round(hours)} hour(s)`;
}

// ---------------------------------------------------------------------------------------------
// depot_update_project

const changeSchema = z.object({
  field: z.enum(['name', 'regionId', 'hardware', 'cacheKeepGb', 'cacheKeepDays']),
  from: z.string(),
  to: z.string(),
});

type Change = z.input<typeof changeSchema>;

interface UpdateRequestFields {
  readonly name?: string | undefined;
  readonly regionId?: string | undefined;
  readonly hardware?: string | undefined;
  readonly cacheKeepGb?: number | undefined;
  readonly cacheKeepDays?: number | undefined;
}

/**
 * Every difference between the project as Depot reports it and the arguments, in the order the
 * preview shows them. A value equal to the current one is not a change, so repeating the current
 * settings gets the no-change refusal rather than a no-op write.
 */
function diffProject(current: ProjectSummary, input: UpdateRequestFields): Change[] {
  const changes: Change[] = [];
  if (input.name !== undefined && input.name !== current.name) {
    changes.push({ field: 'name', from: show(current.name), to: input.name });
  }
  if (input.regionId !== undefined && input.regionId !== current.regionId) {
    changes.push({ field: 'regionId', from: show(current.regionId), to: input.regionId });
  }
  if (input.hardware !== undefined && input.hardware !== effectiveHardware(current.hardware)) {
    changes.push({ field: 'hardware', from: show(current.hardware), to: input.hardware });
  }
  if (input.cacheKeepGb !== undefined && input.cacheKeepGb !== current.cachePolicy.keepGb) {
    changes.push({
      field: 'cacheKeepGb',
      from: show(current.cachePolicy.keepGb),
      to: String(input.cacheKeepGb),
    });
  }
  if (input.cacheKeepDays !== undefined && input.cacheKeepDays !== current.cachePolicy.keepDays) {
    changes.push({
      field: 'cacheKeepDays',
      from: show(current.cachePolicy.keepDays),
      to: String(input.cacheKeepDays),
    });
  }
  return changes;
}

function isCacheField(change: Change): boolean {
  return change.field === 'cacheKeepGb' || change.field === 'cacheKeepDays';
}

function shrinks(requested: number | undefined, current: number | undefined): boolean {
  return requested !== undefined && current !== undefined && requested < current;
}

export const updateProjectTool = defineWriteTool({
  name: 'depot_update_project',
  title: 'Update a Depot project: name, hardware, cache policy',
  description: `Change a Depot container build project's name, builder hardware, or layer cache policy (ProjectService/UpdateProject). The API form of editing the project in the Depot dashboard.

dryRun (the default) reads the project with GetProject and shows each field that would change, from the current value to the requested one. A smaller cache size or shorter retention comes with a warning, because Depot evicts layers past the new limit and the next builds of anything evicted run uncached. A hardware change comes with a warning too: it changes the per-minute cost of every future build. Fields left out are left alone, and only values that differ from the current state count as changes.

Refuses when nothing would change (every argument equals the current value), when regionId differs from the project's region (Depot does not move a project between regions; create one in the other region with depot_create_project instead), and when cacheKeepGb or cacheKeepDays is below 1. Changing one cache number sends both, the other taken from the current policy, because Depot reads an omitted one as zero.

Reversible: run the tool again with the old values. Needs an Organization token; Depot's ProjectService refuses user tokens. Only registered when DEPOT_MCP_ALLOW_WRITES is set. After the user confirms the preview, call again with dryRun:false to apply. Request shape from Depot's published project.proto.`,
  inputSchema: {
    projectId: projectIdField,
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('New project name as shown in the Depot dashboard. Omit to keep the current name.'),
    regionId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Accepted only when it equals the project's current region; Depot cannot move a project, so any other value is refused.",
      ),
    hardware: z
      .enum(HARDWARE_LABELS)
      .optional()
      .describe(
        'New builder size as CPUxGB, for example 16x32 (the Depot default) or 8x16. Changes the cost of every future build. Omit to keep the current size.',
      ),
    cacheKeepGb: z
      .number()
      .int()
      .max(10_000)
      .optional()
      .describe(
        'New layer cache size in GB per architecture; must be at least 1. Shrinking it evicts cached layers. Omit to keep the current size.',
      ),
    cacheKeepDays: z
      .number()
      .int()
      .max(365)
      .optional()
      .describe(
        'New number of days a cached layer is kept; must be at least 1. Shortening it evicts older layers. Omit to keep the current retention.',
      ),
  },
  previewSchema: {
    projectId: z.string(),
    current: projectSchema,
    changes: z.array(changeSchema),
    /** The whole policy that would be sent, present when either cache number changes. */
    cachePolicy: z.object({ keepDays: z.number(), keepGb: z.number() }).optional(),
    cacheShrinks: z.boolean(),
    hardwareChanges: z.boolean(),
    regionChanges: z.boolean(),
    warnings: z.array(z.string()),
  },
  afterSchema: {
    project: projectSchema,
  },
  destructive: false,
  idempotent: true,
  preview: async (input, context) => {
    if (
      input.name === undefined &&
      input.regionId === undefined &&
      input.hardware === undefined &&
      input.cacheKeepGb === undefined &&
      input.cacheKeepDays === undefined
    ) {
      throw new ToolInputError(
        'No change requested: pass at least one of name, hardware, cacheKeepGb, or cacheKeepDays.',
      );
    }

    const current = parseProject(await context.api.getProject(input.projectId));
    const changes = diffProject(current, input);
    const cacheChanges = changes.some(isCacheField);
    const keepGb = input.cacheKeepGb ?? current.cachePolicy.keepGb;
    const keepDays = input.cacheKeepDays ?? current.cachePolicy.keepDays;
    const cachePolicy =
      cacheChanges && keepGb !== undefined && keepDays !== undefined
        ? { keepGb, keepDays }
        : undefined;
    const cacheShrinks =
      cacheChanges &&
      (shrinks(input.cacheKeepGb, current.cachePolicy.keepGb) ||
        shrinks(input.cacheKeepDays, current.cachePolicy.keepDays));
    const hardwareChanges = changes.some((change) => change.field === 'hardware');
    const regionChanges = changes.some((change) => change.field === 'regionId');

    const warnings: string[] = [];
    if (cacheShrinks) {
      warnings.push(
        `Shrinking the cache from ${show(current.cachePolicy.keepGb)} GB / ${show(current.cachePolicy.keepDays)} days to ${show(keepGb)} GB / ${show(keepDays)} days evicts every layer past the new limit as soon as it applies. The next build of anything evicted runs uncached.`,
      );
    }
    if (hardwareChanges) {
      warnings.push(
        `Moving builders from ${show(current.hardware)} to ${input.hardware ?? ''} changes the per-minute cost of every future build in this project; check Depot's pricing for the new size.`,
      );
    }

    const lines = [`Current: ${describeProject(current)}`];
    if (changes.length === 0) {
      lines.push('Requested values equal the current ones; nothing would change.');
    } else {
      lines.push('Would change:');
      for (const change of changes) {
        lines.push(`  ${change.field}: ${change.from} -> ${change.to}`);
      }
      if (cachePolicy !== undefined) {
        lines.push(
          `  cache policy sent as a whole: ${cachePolicy.keepGb} GB for ${cachePolicy.keepDays} days`,
        );
      }
    }
    for (const warning of warnings) {
      lines.push(`WARNING: ${warning}`);
    }

    return {
      data: {
        projectId: current.projectId ?? input.projectId,
        current,
        changes,
        cachePolicy,
        cacheShrinks,
        hardwareChanges,
        regionChanges,
        warnings,
      },
      lines,
    };
  },
  refuse: (preview, input) => {
    if (preview.regionChanges) {
      const change = preview.changes.find((entry) => entry.field === 'regionId');
      return `the project is in ${change?.from ?? 'its region'} and Depot does not move projects between regions. Leave regionId out, or create a project in ${change?.to ?? 'the other region'} with depot_create_project and point builds at it.`;
    }
    if (input.cacheKeepGb !== undefined && input.cacheKeepGb < 1) {
      return `cacheKeepGb must be at least 1 (got ${input.cacheKeepGb}); a cache of 0 GB would disable layer caching for every build.`;
    }
    if (input.cacheKeepDays !== undefined && input.cacheKeepDays < 1) {
      return `cacheKeepDays must be at least 1 (got ${input.cacheKeepDays}); a retention of 0 days would evict every layer at once.`;
    }
    if (preview.changes.length === 0) {
      return 'no change requested: every value given equals what the project already has.';
    }
    if (preview.changes.some(isCacheField) && preview.cachePolicy === undefined) {
      return "Depot did not report the project's current cache policy, so the unchanged half cannot be filled in. Pass both cacheKeepGb and cacheKeepDays.";
    }
    return undefined;
  },
  apply: async (input, context, preview) => {
    const response = await context.api.updateProject({
      projectId: input.projectId,
      name: preview.changes.some((change) => change.field === 'name') ? input.name : undefined,
      hardware:
        preview.hardwareChanges && input.hardware !== undefined
          ? hardwareWireName(input.hardware)
          : undefined,
      cachePolicy: preview.cachePolicy,
    });
    const project = parseProject(response);
    return {
      data: { project },
      lines: [`Now: ${describeProject(project)}`],
    };
  },
});

// ---------------------------------------------------------------------------------------------
// depot_delete_project

/** A build inside this window means the project is in use; deleting it then needs force. */
export const RECENT_BUILD_HOURS = 24;

/** ListBuilds pages of up to 100; one page says "in use" and counts every small project fully. */
const BUILD_PAGE_SIZE = 100;

interface BuildActivity {
  readonly count: number;
  readonly complete: boolean;
  readonly lastBuildAt: string | undefined;
}

async function buildActivity(projectId: string, context: ToolContext): Promise<BuildActivity> {
  const response = await context.api.listBuilds({ projectId, pageSize: BUILD_PAGE_SIZE });
  const builds = readObjectArray(response, 'builds').map(parseBuild);
  let latest: { at: string; ms: number } | undefined;
  for (const build of builds) {
    const at = build.createdAt ?? build.startedAt;
    const ms = parseTimestamp(at);
    if (at !== undefined && ms !== undefined && (latest === undefined || ms > latest.ms)) {
      latest = { at, ms };
    }
  }
  return {
    count: builds.length,
    complete: readString(response, 'nextPageToken') === undefined,
    lastBuildAt: latest?.at,
  };
}

function hoursAgo(timestamp: string | undefined, now: number): number | undefined {
  const ms = parseTimestamp(timestamp);
  return ms === undefined ? undefined : Math.max(0, (now - ms) / 3_600_000);
}

export const deleteProjectTool = defineWriteTool({
  name: 'depot_delete_project',
  title: 'Delete a Depot project permanently',
  description: `Delete a Depot container build project (ProjectService/DeleteProject), and with it its layer cache, build history, registry images, trust policies, and project tokens. Nothing brings any of that back. The API form of deleting the project in the Depot dashboard.

dryRun (the default) reads the project with GetProject and its builds with ListBuilds, then shows what would be destroyed: the project's name, region, hardware, and cache policy, how many builds it has (the newest 100 are counted), and when the last one ran. Show that to the user before anything else.

confirmProjectName must equal the project's current name exactly, as depot_get_project reports it. Ask the user for the name; do not copy it from a listing on their behalf. A mismatch is refused before any mutating call. A project with a build in the last ${RECENT_BUILD_HOURS} hours is also refused, since something still uses it, unless force is true.

Only registered when both DEPOT_MCP_ALLOW_WRITES and DEPOT_MCP_ALLOW_DESTRUCTIVE are set. Needs an Organization token. After the user has confirmed the preview and typed the project name, call again with dryRun:false to apply. Request shape from Depot's published project.proto.`,
  inputSchema: {
    projectId: projectIdField,
    confirmProjectName: z
      .string()
      .min(1)
      .describe(
        "The project's current name, typed by the user, exactly as depot_get_project shows it. Refused unless it matches; this is the confirmation that the right project is being destroyed.",
      ),
    force: z
      .boolean()
      .default(false)
      .describe(
        `Delete even though a build ran in the last ${RECENT_BUILD_HOURS} hours. Without it such a project is refused as still in use.`,
      ),
  },
  previewSchema: {
    project: projectSchema,
    nameMatches: z.boolean(),
    buildCount: z.number(),
    /** False when the project has more builds than the one page that was counted. */
    buildCountComplete: z.boolean(),
    lastBuildAt: z.string().optional(),
    hoursSinceLastBuild: z.number().optional(),
    recentBuild: z.boolean(),
  },
  afterSchema: {
    projectId: z.string(),
    name: z.string().optional(),
    responseKeys: z.array(z.string()),
  },
  destructive: true,
  idempotent: true,
  preview: async (input, context) => {
    const [projectResponse, activity] = await Promise.all([
      context.api.getProject(input.projectId),
      buildActivity(input.projectId, context),
    ]);
    const project = parseProject(projectResponse);
    const hours = hoursAgo(activity.lastBuildAt, context.now());
    const recentBuild = hours !== undefined && hours < RECENT_BUILD_HOURS;
    const nameMatches = project.name !== undefined && input.confirmProjectName === project.name;

    const lines = [
      `Would PERMANENTLY delete ${describeProject(project)}${project.organizationId === undefined ? '' : ` in organization ${project.organizationId}`}${project.createdAt === undefined ? '' : `, created ${project.createdAt}`}.`,
      activity.count === 0
        ? 'Builds: none recorded.'
        : `Builds: ${activity.count}${activity.complete ? '' : ' or more (only the newest page was counted)'}; last build ${activity.lastBuildAt ?? 'at an unknown time'}${hours === undefined ? '' : ` (${hoursText(hours)} ago)`}.`,
      'Its layer cache, build history, registry images, trust policies, and project tokens go with it; nothing can restore them.',
      nameMatches
        ? 'confirmProjectName matches the current name.'
        : 'confirmProjectName does NOT match the current name.',
    ];

    return {
      data: {
        project,
        nameMatches,
        buildCount: activity.count,
        buildCountComplete: activity.complete,
        lastBuildAt: activity.lastBuildAt,
        hoursSinceLastBuild: hours === undefined ? undefined : Math.round(hours * 10) / 10,
        recentBuild,
      },
      lines,
    };
  },
  refuse: (preview, input) => {
    if (!preview.nameMatches) {
      return `confirmProjectName "${input.confirmProjectName}" is not this project's current name. Deleting needs the exact name so a wrong projectId cannot be destroyed; read the name back to the user from the preview and have them confirm it.`;
    }
    if (preview.recentBuild && !input.force) {
      return `a build ran ${hoursText(preview.hoursSinceLastBuild ?? 0)} ago, within the last ${RECENT_BUILD_HOURS} hours, so something still uses this project. Pass force:true to delete it anyway.`;
    }
    return undefined;
  },
  apply: async (input, context, preview) => {
    const response = await context.api.deleteProject(input.projectId);
    return {
      data: {
        projectId: input.projectId,
        name: preview.project.name,
        responseKeys: Object.keys(response),
      },
      lines: [
        `DeleteProject accepted for ${input.projectId}${preview.project.name === undefined ? '' : ` ("${preview.project.name}")`}. The project no longer exists; builds that target it will fail until DEPOT_PROJECT_ID points elsewhere.`,
      ],
    };
  },
});
