import { z } from 'zod';
import { readObjectArray, readString } from '../depot/shape.js';
import { parseProject, type ProjectSummary } from '../lib/project.js';
import type { ToolContext } from '../lib/tool.js';
import { defineWriteTool } from '../lib/write-config.js';
import { describeProject, projectSchema } from './projects.js';

/** The regions Depot documents for container build projects. */
export const KNOWN_REGIONS = ['us-east-1', 'eu-central-1'] as const;
const DEFAULT_REGION = 'us-east-1';

/** Labels from depot/proto's Hardware enum; the wire name is HARDWARE_<label upper-cased>. */
const HARDWARE_LABELS = [
  '4x4',
  '4x8',
  '8x8',
  '8x16',
  '16x32',
  '32x64',
  '64x128',
  '96x192',
  '192x384',
  '384x768',
] as const;

/** Depot's documented defaults for a new project. */
const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_KEEP_GB = 50;
const DEFAULT_HARDWARE = '16x32';

/** ListProjects pages of 100; ten pages is far beyond any organization seen so far. */
const MAX_LIST_PAGES = 10;

async function listAllProjects(
  context: ToolContext,
): Promise<{ projects: ProjectSummary[]; complete: boolean }> {
  const projects: ProjectSummary[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const response = await context.api.listProjects({ pageSize: 100, pageToken });
    projects.push(...readObjectArray(response, 'projects').map(parseProject));
    pageToken = readString(response, 'nextPageToken');
    if (pageToken === undefined) {
      return { projects, complete: true };
    }
  }
  return { projects, complete: false };
}

export const createProjectTool = defineWriteTool({
  name: 'depot_create_project',
  title: 'Create a Depot container build project',
  description: `Create a Depot container build project (ProjectService/CreateProject): a name, a region, optional runner hardware, and an optional layer cache policy. The API form of \`depot projects create\`.

dryRun (the default) lists the organization's existing projects, resolves every default (region us-east-1, hardware 16x32, cache 50 GB for 14 days), and says whether a project with this name already exists. Depot allows duplicate names, but they make every later projectId lookup ambiguous, so this tool refuses one unless allowDuplicateName is true. It also refuses a region outside the two Depot documents, us-east-1 and eu-central-1.

Creating a project is not destructive, but it is not idempotent either: two applies make two projects. Needs an Organization token; Depot's ProjectService refuses user tokens. Only registered when DEPOT_MCP_ALLOW_WRITES is set. After the user confirms the preview, call again with dryRun:false to apply. Request shape from Depot's published project.proto; this server has never invoked CreateProject live.`,
  inputSchema: {
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .describe('Project name shown in the Depot dashboard; need not be unique, but see allowDuplicateName.'),
    regionId: z
      .string()
      .default(DEFAULT_REGION)
      .describe('Where builders and the cache live: us-east-1 (default) or eu-central-1.'),
    hardware: z
      .enum(HARDWARE_LABELS)
      .optional()
      .describe('Builder size as CPUxGB, for example 16x32 (the Depot default) or 8x16. Omit for the default.'),
    cacheKeepDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Days a layer cache entry is retained; Depot defaults to 14. Sent together with cacheKeepGb.'),
    cacheKeepGb: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Layer cache size in GB per architecture; Depot defaults to 50. Sent together with cacheKeepDays.'),
    allowDuplicateName: z
      .boolean()
      .default(false)
      .describe('Create the project even if one with the same name already exists in the organization.'),
  },
  previewSchema: {
    name: z.string(),
    regionId: z.string(),
    regionKnown: z.boolean(),
    hardware: z.string(),
    hardwareExplicit: z.boolean(),
    cachePolicy: z.object({ keepDays: z.number(), keepGb: z.number(), explicit: z.boolean() }),
    organizationId: z.string().optional(),
    existingProjectCount: z.number(),
    existingListComplete: z.boolean(),
    sameName: z.array(projectSchema),
  },
  afterSchema: {
    project: projectSchema,
  },
  destructive: false,
  idempotent: false,
  preview: async (input, context) => {
    const { projects, complete } = await listAllProjects(context);
    const wanted = input.name.toLowerCase();
    const sameName = projects.filter((project) => project.name?.toLowerCase() === wanted);
    const organizationId = projects.find((project) => project.organizationId !== undefined)
      ?.organizationId;
    const cacheExplicit = input.cacheKeepDays !== undefined || input.cacheKeepGb !== undefined;
    const regionKnown = (KNOWN_REGIONS as readonly string[]).includes(input.regionId);

    const lines = [
      `Would create project "${input.name}" in ${input.regionId}${regionKnown ? '' : ' (not a region Depot documents)'}.`,
      `Hardware: ${input.hardware ?? `${DEFAULT_HARDWARE} (Depot default)`}`,
      `Cache policy: ${input.cacheKeepGb ?? DEFAULT_KEEP_GB} GB for ${input.cacheKeepDays ?? DEFAULT_KEEP_DAYS} days${cacheExplicit ? '' : ' (Depot default)'}`,
      `Organization has ${projects.length} project(s)${complete ? '' : ' in the first pages listed'}${organizationId === undefined ? '' : ` (${organizationId})`}.`,
    ];
    if (sameName.length > 0) {
      lines.push(`A project with this name already exists:`);
      for (const project of sameName) {
        lines.push(`  ${describeProject(project)}`);
      }
    } else {
      lines.push('No existing project has this name.');
    }

    return {
      summary: lines.join('\n'),
      data: {
        name: input.name,
        regionId: input.regionId,
        regionKnown,
        hardware: input.hardware ?? DEFAULT_HARDWARE,
        hardwareExplicit: input.hardware !== undefined,
        cachePolicy: {
          keepDays: input.cacheKeepDays ?? DEFAULT_KEEP_DAYS,
          keepGb: input.cacheKeepGb ?? DEFAULT_KEEP_GB,
          explicit: cacheExplicit,
        },
        organizationId,
        existingProjectCount: projects.length,
        existingListComplete: complete,
        sameName,
      },
    };
  },
  refuse: (preview, input) => {
    if (!preview.regionKnown) {
      return `"${preview.regionId}" is not a region Depot documents; use ${KNOWN_REGIONS.join(' or ')}.`;
    }
    if (preview.sameName.length > 0 && !input.allowDuplicateName) {
      const ids = preview.sameName.map((project) => project.projectId ?? 'unknown id').join(', ');
      return `a project named "${preview.name}" already exists (${ids}). Depot permits duplicate names, but they make projectId lookups ambiguous; pass allowDuplicateName: true to create another anyway.`;
    }
    return undefined;
  },
  auditIds: (_input, preview) => `project=${JSON.stringify(preview.name)} region=${preview.regionId}`,
  apply: async (input, context, preview) => {
    const response = await context.api.createProject({
      name: preview.name,
      regionId: preview.regionId,
      hardware:
        input.hardware === undefined ? undefined : `HARDWARE_${input.hardware.toUpperCase()}`,
      cachePolicy: preview.cachePolicy.explicit
        ? { keepDays: preview.cachePolicy.keepDays, keepGb: preview.cachePolicy.keepGb }
        : undefined,
    });
    const project = parseProject(response);
    return {
      summary: `Created ${describeProject(project)}. Builds can target it with DEPOT_PROJECT_ID=${project.projectId ?? '<see dashboard>'}.`,
      data: { project },
    };
  },
});
