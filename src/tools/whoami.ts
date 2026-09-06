import { z } from 'zod';
import { DepotApiError, formatDepotError } from '../depot/errors.js';
import { readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import { parseProject } from '../lib/project.js';
import { defineTool } from '../lib/tool.js';
import { betaTools } from './beta.js';

const PROJECT_PREVIEW_LIMIT = 25;

/**
 * Observed live on 2026-09-06: a user token lists organizations and reaches the CI API, but
 * depot.core.v1 Project/Build/Usage RPCs answer 401 "Invalid token" to it. Depot's scope matrix
 * does not say so, and the generic 401 guidance ("check the token") sends people the wrong way.
 */
export const USER_TOKEN_WARNING =
  'This token can list organizations and use the Depot CI tools, but Depot\'s core Project, Build, Registry and Usage services rejected it with "Invalid token". That is how Depot answers a user token on those services; they accept only Organization tokens. depot_list_projects, depot_get_project, depot_list_builds, depot_diagnose_build and depot_get_usage will fail until DEPOT_TOKEN is an Organization token (Depot dashboard -> Organization Settings -> API Tokens). Being an organization owner does not change this. The CI tools, depot_list_images and depot_list_ci_secrets/variables keep working. Full matrix: https://github.com/akshayjain3450/depot-mcp/blob/main/docs/tokens.md';

/**
 * The mirror image, also observed live on 2026-09-06: an Organization token reaches every core and
 * CI service but ListOrganizations answers 401 "Invalid token", because the token is not tied to a
 * user and has no "my organizations" to list. So that one RPC is not an authentication check; the
 * pair of results is.
 */
export const ORGANIZATION_TOKEN_NOTE =
  'Organization token: Depot does not let it list organizations (that RPC answers "Invalid token" for every Organization token, which is expected), so the organization id is taken from the projects it can see. Full matrix: https://github.com/akshayjain3450/depot-mcp/blob/main/docs/tokens.md';

export type TokenKind = 'organization' | 'user' | 'unknown';

function isUnauthenticated(result: PromiseSettledResult<unknown>): boolean {
  return (
    result.status === 'rejected' &&
    result.reason instanceof DepotApiError &&
    result.reason.code === 'unauthenticated'
  );
}

export const whoamiTool = defineTool({
  name: 'depot_whoami',
  title: 'Check the Depot token and its visible scope',
  description: `Verify the configured Depot token and report which organizations and projects it can actually see.

Call this first whenever another Depot tool returns an empty list or a permission error. Depot's most common confusing failure is a token that spans several organizations with none selected: requests then resolve against the wrong organization and return empty results rather than an error. This tool says plainly whether that is happening and what to set.

Also reports whether write tools are enabled (this version of the server ships no mutating tools at all, so the answer is always that nothing can be modified) and whether the beta sandbox and registry tools are registered (DEPOT_MCP_ENABLE_BETA).

Never returns the token or any part of it.`,
  inputSchema: {},
  outputSchema: {
    apiUrl: z.string(),
    tokenSource: z.string(),
    tokenKind: z.enum(['organization', 'user', 'unknown']),
    organizations: z.array(z.object({ orgId: z.string().optional(), name: z.string().optional() })),
    activeOrgId: z.string().optional(),
    orgSelection: z.string(),
    projectCount: z.number().optional(),
    projects: z.array(z.object({ projectId: z.string().optional(), name: z.string().optional() })),
    writesEnabled: z.boolean(),
    mutatingToolsAvailable: z.literal(0),
    betaEnabled: z.boolean(),
    betaTools: z.array(z.string()),
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

    const projects =
      projectResult.status === 'fulfilled'
        ? readObjectArray(projectResult.value, 'projects').map(parseProject)
        : [];

    let tokenKind: TokenKind = 'unknown';
    if (orgResult.status === 'fulfilled' && isUnauthenticated(projectResult)) {
      tokenKind = 'user';
    } else if (isUnauthenticated(orgResult) && projectResult.status === 'fulfilled') {
      tokenKind = 'organization';
    }

    let organizations: Array<{ orgId: string | undefined; name: string | undefined }> = [];
    if (orgResult.status === 'fulfilled') {
      organizations = readObjectArray(orgResult.value, 'organizations', 'orgs').map((entry) => ({
        orgId: readString(entry, 'orgId', 'organizationId', 'id'),
        name: readString(entry, 'name'),
      }));
    } else if (tokenKind === 'organization') {
      // Not a failure: derive the organization from the projects instead.
      const seen = new Set<string>();
      for (const project of projects) {
        if (project.organizationId !== undefined && !seen.has(project.organizationId)) {
          seen.add(project.organizationId);
          organizations.push({ orgId: project.organizationId, name: undefined });
        }
      }
    } else {
      failures.push({
        check: 'depot.core.v1.OrganizationService/ListOrganizations',
        detail: formatDepotError(orgResult.reason),
      });
    }

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

    if (tokenKind === 'user') {
      warnings.push(USER_TOKEN_WARNING);
    }
    if (tokenKind === 'organization' && projects.length === 0) {
      warnings.push(
        'This Organization token sees no projects yet, so the organization id could not be determined. Create a project in the Depot dashboard, or set DEPOT_ORG_ID explicitly.',
      );
    }

    if (organizations.length === 0 && failures.length === 0 && tokenKind !== 'organization') {
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
    const kindLabel =
      tokenKind === 'organization'
        ? 'Organization token'
        : tokenKind === 'user'
          ? 'user token'
          : 'token kind not determined';
    text.push(
      `Depot API: ${context.config.apiUrl}`,
      `Token source: the DEPOT_TOKEN environment variable (its value is never reported). Kind: ${kindLabel}.`,
      '',
    );
    if (tokenKind === 'organization') {
      text.push(ORGANIZATION_TOKEN_NOTE, '');
    }
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
      context.config.enableBeta
        ? `Beta tools: enabled by DEPOT_MCP_ENABLE_BETA (${betaTools.map((tool) => tool.name).join(', ')}). They are read-only but built on Depot APIs that may change without notice.`
        : 'Beta tools: not registered. Set DEPOT_MCP_ENABLE_BETA=1 to add the read-only sandbox and registry tools built on Depot\'s beta APIs.',
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
        tokenKind,
        organizations,
        activeOrgId,
        orgSelection,
        projectCount: projectResult.status === 'fulfilled' ? projects.length : undefined,
        projects: projects
          .slice(0, PROJECT_PREVIEW_LIMIT)
          .map((project) => ({ projectId: project.projectId, name: project.name })),
        writesEnabled: context.config.allowWrites,
        mutatingToolsAvailable: 0 as const,
        betaEnabled: context.config.enableBeta,
        betaTools: context.config.enableBeta ? betaTools.map((tool) => tool.name) : [],
        warnings,
        failures,
      },
    };
  },
});
