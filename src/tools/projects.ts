import { z } from 'zod';
import { asObject, readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import { parseProject, type ProjectSummary } from '../lib/project.js';
import { defineTool } from '../lib/tool.js';

const projectSchema = z.object({
  projectId: z.string().optional(),
  name: z.string().optional(),
  organizationId: z.string().optional(),
  regionId: z.string().optional(),
  hardware: z.string().optional(),
  createdAt: z.string().optional(),
  cachePolicy: z.object({
    keepDays: z.number().optional(),
    keepGb: z.number().optional(),
  }),
});

/** One line per project with its cache policy; shared by the project tools and the projects resource. */
export function describeProject(project: ProjectSummary): string {
  const cache = [
    project.cachePolicy.keepGb === undefined ? undefined : `${project.cachePolicy.keepGb} GB`,
    project.cachePolicy.keepDays === undefined ? undefined : `${project.cachePolicy.keepDays} days`,
  ].filter((part): part is string => part !== undefined);
  const bits = [
    project.regionId ?? 'unknown region',
    project.hardware === undefined ? undefined : `hardware ${project.hardware}`,
    cache.length === 0 ? undefined : `cache keeps ${cache.join(' / ')}`,
  ].filter((part): part is string => part !== undefined);
  return `${project.projectId ?? 'unknown id'} — ${project.name ?? 'unnamed'} · ${bits.join(' · ')}`;
}

export const listProjectsTool = defineTool({
  name: 'depot_list_projects',
  title: 'List Depot container build projects',
  description: `List Depot container build projects with their region, runner hardware, and cache policy.

Use this to find a projectId for depot_list_builds, depot_diagnose_build, or depot_list_images, and to check configuration that affects build speed: which region a project builds in, how large its runners are, and how much layer cache it retains before eviction.

These are container build projects. Depot CI runs are organised by repository and workflow instead — use depot_list_ci_runs for those.`,
  inputSchema: {
    regionId: z
      .string()
      .optional()
      .describe('Filter to one region, for example "us-east-1" or "eu-central-1".'),
    limit: z.number().int().min(1).max(200).default(100).describe('Maximum projects to return.'),
    pageToken: z
      .string()
      .optional()
      .describe('Continue a previous listing: pass the nextPageToken from the last call.'),
  },
  outputSchema: {
    projects: z.array(projectSchema),
    returned: z.number(),
    nextPageToken: z.string().optional(),
  },
  handler: async (input, context) => {
    // ListProjects is paginated like the other list RPCs, and the API wrapper spreads the request
    // through verbatim, so the token rides along even though its parameter type omits it.
    const request: {
      regionId?: string | undefined;
      pageSize?: number | undefined;
      pageToken?: string | undefined;
    } = { regionId: input.regionId, pageSize: input.limit, pageToken: input.pageToken };
    const response = await context.api.listProjects(request);
    const projects = readObjectArray(response, 'projects').map(parseProject);
    const nextPageToken = readString(response, 'nextPageToken');

    const text = new TextBudget(context.config.outputCharBudget);
    if (projects.length === 0) {
      text.push(
        'No Depot container build projects are visible to this token.',
        'If you expected some, run depot_whoami — a token that spans several organizations needs DEPOT_ORG_ID set, and a project token cannot list projects at all.',
      );
    } else {
      text.push(`${projects.length} Depot project(s):`);
      for (const project of projects) {
        text.push(`  ${describeProject(project)}`);
      }
    }
    if (nextPageToken !== undefined) {
      text.push('', 'More projects exist than were returned; re-call with pageToken set to nextPageToken.');
    }

    return {
      summary: text.render(),
      data: { projects, returned: projects.length, nextPageToken },
    };
  },
});

export const getProjectTool = defineTool({
  name: 'depot_get_project',
  title: 'Get one Depot project and its trust policies',
  description: `Show one Depot container build project's full configuration together with its OIDC trust policies.

Use this to check build capacity and cache retention for a specific project, and to audit which external CI systems are allowed to exchange an OIDC token for Depot credentials — trust policies are the answer to "how does our GitHub Actions workflow authenticate to Depot without a stored token".

Trust-relationship tokens carry project-token permissions, which means they cannot reach the Depot CI API or the Depot API; only container builds and the registry.`,
  inputSchema: {
    projectId: z.string().min(1).describe('The project id, from depot_list_projects.'),
  },
  outputSchema: {
    project: projectSchema,
    trustPolicies: z.array(
      z.object({
        trustPolicyId: z.string().optional(),
        provider: z.string().optional(),
        detail: z.record(z.string(), z.string()),
      }),
    ),
  },
  handler: async (input, context) => {
    const [projectResponse, policiesResponse] = await Promise.all([
      context.api.getProject(input.projectId),
      context.api.listTrustPolicies(input.projectId),
    ]);

    const project = parseProject(projectResponse);
    const trustPolicies = readObjectArray(policiesResponse, 'trustPolicies').map((entry) => {
      const detail: Record<string, string> = {};
      let provider: string | undefined;
      for (const [key, value] of Object.entries(entry)) {
        const nested = asObject(value);
        if (nested === undefined) {
          continue;
        }
        // The proto models the provider as a oneof, so exactly one nested object identifies it.
        provider = key;
        for (const [field, fieldValue] of Object.entries(nested)) {
          if (typeof fieldValue === 'string' || typeof fieldValue === 'number') {
            detail[field] = String(fieldValue);
          }
        }
      }
      return {
        trustPolicyId: readString(entry, 'trustPolicyId', 'id'),
        provider,
        detail,
      };
    });

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(describeProject(project));
    if (project.organizationId !== undefined) {
      text.push(`Organization: ${project.organizationId}`);
    }
    if (project.createdAt !== undefined) {
      text.push(`Created: ${project.createdAt}`);
    }

    if (trustPolicies.length === 0) {
      text.push(
        '',
        'No OIDC trust policies: builds for this project must authenticate with a token.',
      );
    } else {
      text.push('', `${trustPolicies.length} OIDC trust policy(ies):`);
      for (const policy of trustPolicies) {
        const detail = Object.entries(policy.detail)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ');
        text.push(`  ${policy.provider ?? 'unknown provider'}${detail === '' ? '' : ` (${detail})`}`);
      }
    }

    return { summary: text.render(), data: { project, trustPolicies } };
  },
});
