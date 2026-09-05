import { z } from 'zod';
import { formatDepotError } from '../depot/errors.js';
import { readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import { parseProject } from '../lib/project.js';
import { defineTool } from '../lib/tool.js';

const PROJECT_PREVIEW_LIMIT = 25;

export const whoamiTool = defineTool({
  name: 'depot_whoami',
  title: 'Check the Depot token and its visible scope',
  description: `Verify the configured Depot token and report which organizations and projects it can actually see.

Call this first whenever another Depot tool returns an empty list or a permission error. Depot's most common confusing failure is a token that spans several organizations with none selected: requests then resolve against the wrong organization and return empty results rather than an error. This tool says plainly whether that is happening and what to set.

Also reports whether write tools are enabled. This version of the server ships no mutating tools at all, so the answer is always that nothing can be modified.

Never returns the token or any part of it.`,
  inputSchema: {},
  outputSchema: {
    apiUrl: z.string(),
    tokenSource: z.string(),
    organizations: z.array(z.object({ orgId: z.string().optional(), name: z.string().optional() })),
    activeOrgId: z.string().optional(),
    orgSelection: z.string(),
    projectCount: z.number().optional(),
    projects: z.array(z.object({ projectId: z.string().optional(), name: z.string().optional() })),
    writesEnabled: z.boolean(),
    mutatingToolsAvailable: z.literal(0),
    warnings: z.array(z.string()),
    failures: z.array(z.object({ check: z.string(), detail: z.string() })),
  },
  handler: async (_input, context) => {
    const [orgResult, projectResult] = await Promise.allSettled([
      context.api.listOrganizations(),
      context.api.listProjects(),
    ]);

    const failures: Array<{ check: string; detail: string }> = [];
    const warnings: string[] = [];

    const organizations =
      orgResult.status === 'fulfilled'
        ? readObjectArray(orgResult.value, 'organizations', 'orgs').map((entry) => ({
            orgId: readString(entry, 'orgId', 'organizationId', 'id'),
            name: readString(entry, 'name'),
          }))
        : [];
    if (orgResult.status === 'rejected') {
      failures.push({
        check: 'depot.core.v1.OrganizationService/ListOrganizations',
        detail: formatDepotError(orgResult.reason),
      });
    }

    const projects =
      projectResult.status === 'fulfilled'
        ? readObjectArray(projectResult.value, 'projects').map(parseProject)
        : [];
    if (projectResult.status === 'rejected') {
      failures.push({
        check: 'depot.core.v1.ProjectService/ListProjects',
        detail: formatDepotError(projectResult.reason),
      });
    }

    const configuredOrgId = context.config.orgId;
    const soleOrgId = organizations.length === 1 ? organizations[0]?.orgId : undefined;
    const activeOrgId = configuredOrgId ?? soleOrgId;

    let orgSelection: string;
    if (configuredOrgId !== undefined) {
      orgSelection = 'set explicitly by DEPOT_ORG_ID';
    } else if (soleOrgId !== undefined) {
      orgSelection = 'implicit: the token sees exactly one organization';
    } else {
      orgSelection = 'not set';
      if (organizations.length > 1) {
        warnings.push(
          `This token can see ${organizations.length} organizations and DEPOT_ORG_ID is not set. Depot resolves ambiguous requests to one organization, so CI runs, secrets and projects from the others will silently appear to be missing. Set DEPOT_ORG_ID to one of the ids listed above.`,
        );
      }
    }

    if (
      configuredOrgId !== undefined &&
      organizations.length > 0 &&
      !organizations.some((org) => org.orgId === configuredOrgId)
    ) {
      const visible = organizations
        .map((org) => org.orgId)
        .filter((orgId): orgId is string => orgId !== undefined);
      warnings.push(
        `DEPOT_ORG_ID is set to "${configuredOrgId}", but this token cannot see that organization. Requests scoped to it will fail or return nothing. Visible organization ids: ${visible.length === 0 ? 'none reported' : visible.join(', ')}.`,
      );
    }

    if (organizations.length === 0 && failures.length === 0) {
      warnings.push(
        'The token authenticated but sees no organizations. That is typical of a project token, which cannot reach the Depot CI API or the Depot API — use an Organization token instead.',
      );
    }
    if (context.config.allowWrites) {
      warnings.push(
        'DEPOT_MCP_ALLOW_WRITES is set, but this version registers no mutating tools, so it currently has no effect.',
      );
    }

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(
      `Depot API: ${context.config.apiUrl}`,
      'Token source: the DEPOT_TOKEN environment variable (its value is never reported).',
      '',
    );
    text.push(
      organizations.length === 0
        ? 'Organizations visible: none.'
        : `Organizations visible (${organizations.length}):`,
    );
    for (const org of organizations) {
      const marker = org.orgId !== undefined && org.orgId === activeOrgId ? ' <- active' : '';
      text.push(`  ${org.orgId ?? 'unknown id'} — ${org.name ?? 'unnamed'}${marker}`);
    }
    text.push('', `Organization selection: ${orgSelection}.`);

    if (projectResult.status === 'fulfilled') {
      text.push('', `Container build projects visible: ${projects.length}.`);
      for (const project of projects.slice(0, PROJECT_PREVIEW_LIMIT)) {
        text.push(
          `  ${project.projectId ?? 'unknown id'} — ${project.name ?? 'unnamed'} (${project.regionId ?? 'unknown region'})`,
        );
      }
      if (projects.length > PROJECT_PREVIEW_LIMIT) {
        text.push(`  … ${projects.length - PROJECT_PREVIEW_LIMIT} more; see depot_list_projects.`);
      }
    }

    text.push(
      '',
      'Writes: this server version registers no mutating tools, so nothing here can retry, cancel, rerun, or delete anything.',
    );

    if (warnings.length > 0) {
      text.push('', 'Warnings:');
      for (const warning of warnings) {
        text.push(`  - ${warning}`);
      }
    }
    if (failures.length > 0) {
      text.push('', 'Checks that failed:');
      for (const failure of failures) {
        text.push(`  - ${failure.check}: ${failure.detail}`);
      }
    }

    return {
      summary: text.render(),
      data: {
        apiUrl: context.config.apiUrl,
        tokenSource: 'DEPOT_TOKEN environment variable',
        organizations,
        activeOrgId,
        orgSelection,
        projectCount: projectResult.status === 'fulfilled' ? projects.length : undefined,
        projects: projects
          .slice(0, PROJECT_PREVIEW_LIMIT)
          .map((project) => ({ projectId: project.projectId, name: project.name })),
        writesEnabled: context.config.allowWrites,
        mutatingToolsAvailable: 0 as const,
        warnings,
        failures,
      },
    };
  },
});
