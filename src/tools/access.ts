import { z } from 'zod';
import { DepotApiError } from '../depot/errors.js';
import { readObjectArray, readString, type JsonObject } from '../depot/shape.js';
import { formatCount, TextBudget } from '../lib/budget.js';
import { describeTrustIdentity, parseProject, parseTrustPolicy } from '../lib/project.js';
import { defineTool, type ToolContext } from '../lib/tool.js';

/** ListTrustPolicies is one request per project; this caps an organization-wide audit. */
const PROJECT_CAP = 50;
const TRUST_POLICY_CONCURRENCY = 4;

const trustPolicySchema = z.object({
  trustPolicyId: z.string().optional(),
  provider: z.string().optional(),
  identity: z.string(),
  detail: z.record(z.string(), z.string()),
});

const auditedProjectSchema = z.object({
  projectId: z.string(),
  name: z.string().optional(),
  trustPolicies: z.array(trustPolicySchema),
  error: z.string().optional(),
});

type AuditedProject = z.infer<typeof auditedProjectSchema>;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) {
        return;
      }
      results[index] = await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function auditProject(
  context: ToolContext,
  project: { projectId: string; name: string | undefined },
): Promise<AuditedProject> {
  try {
    const response = await context.api.listTrustPolicies(project.projectId);
    const trustPolicies = readObjectArray(response, 'trustPolicies')
      .map(parseTrustPolicy)
      .map((policy) => ({ ...policy, identity: describeTrustIdentity(policy) }));
    return { projectId: project.projectId, name: project.name, trustPolicies };
  } catch (error) {
    // One project's refusal should not blank the rest of the audit; the row says what happened.
    if (!(error instanceof DepotApiError)) {
      throw error;
    }
    return {
      projectId: project.projectId,
      name: project.name,
      trustPolicies: [],
      error: `${error.code}${error.serverMessage === undefined ? '' : `: ${error.serverMessage}`}`,
    };
  }
}

export const auditTrustPoliciesTool = defineTool({
  name: 'depot_audit_trust_policies',
  title: 'Audit Depot OIDC trust policies across projects',
  description: `List every OIDC trust policy across your Depot container build projects and summarise which external CI identities (a GitHub repository, a Buildkite pipeline, a CircleCI project, a GitLab project) can build into which project.

Use this for access reviews: "who can push builds into our projects without a token", "is a repository we archived still trusted", "does any project trust a repository outside our organization". A project with no trust policies is common and fine; its builds authenticate with a token instead.

Pass projectId to audit one project; otherwise the first ${PROJECT_CAP} projects are checked with one ListTrustPolicies call each. Read-only: adding or removing a trust policy is not offered by this server. Organization token only.`,
  annotations: { openWorldHint: false },
  inputSchema: {
    projectId: z
      .string()
      .optional()
      .describe(`Limit the audit to one project. Without it, up to ${PROJECT_CAP} projects are audited.`),
  },
  outputSchema: {
    projects: z.array(auditedProjectSchema),
    identities: z.array(
      z.object({
        identity: z.string(),
        provider: z.string().optional(),
        projectIds: z.array(z.string()),
      }),
    ),
    projectsAudited: z.number(),
    projectsWithPolicies: z.number(),
    policyCount: z.number(),
    projectsFailed: z.number(),
    projectCapHit: z.boolean(),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    const notes: string[] = [];
    let candidates: Array<{ projectId: string; name: string | undefined }>;
    let projectCapHit = false;

    if (input.projectId !== undefined) {
      candidates = [{ projectId: input.projectId, name: undefined }];
    } else {
      const response = await context.api.listProjects({ pageSize: PROJECT_CAP });
      candidates = readObjectArray(response, 'projects')
        .map(parseProject)
        .flatMap((project) =>
          project.projectId === undefined ? [] : [{ projectId: project.projectId, name: project.name }],
        )
        .slice(0, PROJECT_CAP);
      projectCapHit = readString(response, 'nextPageToken') !== undefined;
      if (projectCapHit) {
        notes.push(
          `Only the first ${PROJECT_CAP} projects were audited; more exist. Re-call with projectId for the rest.`,
        );
      }
    }

    const projects = await mapWithConcurrency(candidates, TRUST_POLICY_CONCURRENCY, (project) =>
      auditProject(context, project),
    );

    const byIdentity = new Map<string, { provider: string | undefined; projectIds: string[] }>();
    for (const project of projects) {
      for (const policy of project.trustPolicies) {
        const entry = byIdentity.get(policy.identity) ?? { provider: policy.provider, projectIds: [] };
        if (!entry.projectIds.includes(project.projectId)) {
          entry.projectIds.push(project.projectId);
        }
        byIdentity.set(policy.identity, entry);
      }
    }
    const identities = [...byIdentity.entries()]
      .map(([identity, entry]) => ({ identity, ...entry }))
      .sort((a, b) => a.identity.localeCompare(b.identity));

    const projectsWithPolicies = projects.filter((project) => project.trustPolicies.length > 0).length;
    const policyCount = projects.reduce((sum, project) => sum + project.trustPolicies.length, 0);
    const projectsFailed = projects.filter((project) => project.error !== undefined).length;

    const text = new TextBudget(context.config.outputCharBudget);
    if (projects.length === 0) {
      text.push(
        'No Depot container build projects are visible to this token, so there is nothing to audit.',
        'If you expected some, run depot_whoami: this call needs an Organization token.',
      );
    } else {
      text.push(
        `Trust policy audit: ${formatCount(projects.length, 'project')} checked, ${projectsWithPolicies} with OIDC trust policies, ${formatCount(policyCount, 'policy', 'policies')} in total${
          projectsFailed === 0 ? '' : `, ${projectsFailed} could not be read`
        }.`,
        '',
      );
      for (const project of projects) {
        const label = project.name === undefined ? project.projectId : `${project.projectId} (${project.name})`;
        if (project.error !== undefined) {
          text.push(`  ${label}: could not list trust policies (${project.error})`);
        } else if (project.trustPolicies.length === 0) {
          text.push(`  ${label}: no trust policies (token-only)`);
        } else {
          text.push(`  ${label}:`);
          for (const policy of project.trustPolicies) {
            text.push(
              `    - ${policy.identity}${policy.trustPolicyId === undefined ? '' : ` [${policy.trustPolicyId}]`}`,
            );
          }
        }
      }
      if (identities.length === 0) {
        text.push(
          '',
          'No project trusts an external OIDC identity: every container build authenticates with a Depot token. That is the common configuration, not a problem.',
        );
      } else {
        text.push('', 'External identities that can build into projects:');
        for (const entry of identities) {
          text.push(`  ${entry.identity} -> ${entry.projectIds.join(', ')}`);
        }
      }
    }
    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }

    return {
      summary: text.render(),
      data: {
        projects,
        identities,
        projectsAudited: projects.length,
        projectsWithPolicies,
        policyCount,
        projectsFailed,
        projectCapHit,
        notes,
      },
    };
  },
});

const projectTokenSchema = z.object({
  tokenId: z.string().optional(),
  description: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  lastUsedAt: z.string().optional(),
});

/**
 * Explicit allowlist. Depot's ListTokens returns only tokenId and description today (depot/proto,
 * verified live 2026-09-06), and the secret exists only in CreateToken's response, but a field
 * Depot adds later must not flow through by default: anything not named here is dropped.
 */
function parseProjectToken(source: JsonObject): z.infer<typeof projectTokenSchema> {
  return {
    tokenId: readString(source, 'tokenId', 'id'),
    description: readString(source, 'description'),
    createdAt: readString(source, 'createdAt'),
    updatedAt: readString(source, 'updatedAt'),
    expiresAt: readString(source, 'expiresAt'),
    lastUsedAt: readString(source, 'lastUsedAt'),
  };
}

export const listProjectTokensTool = defineTool({
  name: 'depot_list_project_tokens',
  title: 'List Depot project tokens',
  description: `List the project tokens that exist for one Depot container build project: token id, description, and timestamps when Depot provides them. Never the token secret, which Depot only reveals once, at creation, and this server never creates one.

Use this for credential inventory and access reviews: "which tokens exist for this project", "is there a token nobody remembers creating". Pair it with depot_audit_trust_policies for the OIDC side of the same question.

Read-only: creating, rotating, or revoking a token is not offered by this server. Organization token only.`,
  inputSchema: {
    projectId: z.string().min(1).describe('The project whose tokens to list, from depot_list_projects.'),
  },
  outputSchema: {
    projectId: z.string(),
    tokens: z.array(projectTokenSchema),
    returned: z.number(),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    const response = await context.api.listTokens(input.projectId);
    const tokens = readObjectArray(response, 'tokens').map(parseProjectToken);
    const notes = ['Token secrets are never returned by Depot after creation and are never returned by this tool.'];

    const text = new TextBudget(context.config.outputCharBudget);
    if (tokens.length === 0) {
      text.push(
        `Project ${input.projectId} has no project tokens.`,
        'Builds for it authenticate with an organization or user token, or through an OIDC trust policy (see depot_audit_trust_policies).',
      );
    } else {
      text.push(`${formatCount(tokens.length, 'project token')} for project ${input.projectId} (metadata only):`);
      for (const token of tokens) {
        const bits = [
          token.description === undefined ? 'no description' : JSON.stringify(token.description),
          token.createdAt === undefined ? undefined : `created ${token.createdAt}`,
          token.expiresAt === undefined ? undefined : `expires ${token.expiresAt}`,
          token.lastUsedAt === undefined ? undefined : `last used ${token.lastUsedAt}`,
        ].filter((part): part is string => part !== undefined);
        text.push(`  ${token.tokenId ?? 'unknown id'}: ${bits.join(', ')}`);
      }
    }
    text.push('', ...notes.map((note) => `note: ${note}`));

    return {
      summary: text.render(),
      data: { projectId: input.projectId, tokens, returned: tokens.length, notes },
    };
  },
});
