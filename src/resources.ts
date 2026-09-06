import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { ErrorCode, McpError, type ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { DepotApiError, formatDepotError, isDepotRequestError } from './depot/errors.js';
import { readObjectArray, readString } from './depot/shape.js';
import { TextBudget } from './lib/budget.js';
import { parseBuild } from './lib/build.js';
import { parseRunSummary, parseRunTree } from './lib/ci-tree.js';
import { parseProject } from './lib/project.js';
import type { ToolContext } from './lib/tool.js';
import { describeBuild } from './tools/builds.js';
import { describeRun, renderRunTree } from './tools/ci-runs.js';
import { describeProject } from './tools/projects.js';

export const RESOURCE_URIS = {
  run: 'depot://ci/run/{runId}',
  failedRuns: 'depot://ci/runs/failed',
  projectBuilds: 'depot://project/{projectId}/builds',
  projects: 'depot://projects',
} as const;

const LIST_LIMIT = 20;

/** Depot ids are short alphanumerics; anything else in a URI variable is a typo or an injection. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

function textResult(uri: URL, text: string): ReadResourceResult {
  return { contents: [{ uri: uri.toString(), mimeType: 'text/plain', text }] };
}

function readVariable(variables: Variables, name: string): string {
  const raw = variables[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim() ?? '';
  if (trimmed === '' || !SAFE_ID.test(trimmed)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `The ${name} in this resource URI must be a Depot id (letters, digits, ".", "_", "-"); got ${JSON.stringify(trimmed)}.`,
    );
  }
  return trimmed;
}

/**
 * A Depot failure becomes a JSON-RPC error whose message is the same explanation the tools give,
 * so a client sees "no such record, check the organization" rather than a bare stack trace.
 * Anything else is a bug here and is reported as such, with the stack kept on stderr.
 */
async function guarded(uri: URL, read: () => Promise<string>): Promise<ReadResourceResult> {
  try {
    return textResult(uri, await read());
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    if (isDepotRequestError(error)) {
      const code =
        error instanceof DepotApiError &&
        (error.code === 'not_found' || error.code === 'invalid_argument')
          ? ErrorCode.InvalidParams
          : ErrorCode.InternalError;
      throw new McpError(code, `Could not read ${uri.toString()}.\n${formatDepotError(error)}`);
    }
    console.error(`resource ${uri.toString()} threw:`, error instanceof Error ? (error.stack ?? error.message) : error);
    throw new McpError(
      ErrorCode.InternalError,
      `depot-mcp internal error reading ${uri.toString()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readRun(context: ToolContext, runId: string): Promise<string> {
  const tree = parseRunTree(await context.api.getRunStatus(runId));
  return renderRunTree({ ...tree, runId: tree.runId ?? runId }, false, context.config.outputCharBudget);
}

async function readFailedRuns(context: ToolContext): Promise<string> {
  const response = await context.api.listRuns({ status: ['failed'], pageSize: LIST_LIMIT });
  const runs = readObjectArray(response, 'runs').map(parseRunSummary);
  const text = new TextBudget(context.config.outputCharBudget);
  if (runs.length === 0) {
    text.push(
      'No failed Depot CI runs.',
      'If you expected some, check DEPOT_ORG_ID: a token that spans several organizations reads other organizations as empty. depot_whoami confirms what this token can see.',
    );
    return text.render();
  }
  text.push(`${runs.length} most recent failed Depot CI run(s), newest first:`);
  for (const run of runs) {
    text.push(`  ${describeRun(run)}`);
  }
  const first = runs[0];
  text.push(
    '',
    `Read depot://ci/run/<runId> for a run's job tree, or call depot_diagnose_ci_failure {"id":"${first?.runId ?? ''}"} for its root cause.`,
  );
  if (readString(response, 'nextPageToken') !== undefined) {
    text.push(`Only the newest ${LIST_LIMIT} are shown; depot_list_ci_runs pages further.`);
  }
  return text.render();
}

async function readProjectBuilds(context: ToolContext, projectId: string): Promise<string> {
  const response = await context.api.listBuilds({ projectId, pageSize: LIST_LIMIT });
  const builds = readObjectArray(response, 'builds').map(parseBuild);
  const text = new TextBudget(context.config.outputCharBudget);
  if (builds.length === 0) {
    text.push(
      `Project ${projectId} has no container builds recorded.`,
      'If you expected some, confirm the project id against depot://projects and check DEPOT_ORG_ID.',
    );
    return text.render();
  }
  text.push(`${builds.length} most recent container build(s) for project ${projectId}, newest first:`);
  for (const build of builds) {
    text.push(`  ${describeBuild(build)}`);
  }
  text.push(
    '',
    `Diagnose a build with depot_diagnose_build {"buildId":"<buildId>","projectId":"${projectId}"}.`,
  );
  if (readString(response, 'nextPageToken') !== undefined) {
    text.push(`Only the newest ${LIST_LIMIT} are shown; depot_list_builds pages further.`);
  }
  return text.render();
}

async function readProjects(context: ToolContext): Promise<string> {
  const response = await context.api.listProjects();
  const projects = readObjectArray(response, 'projects').map(parseProject);
  const text = new TextBudget(context.config.outputCharBudget);
  if (projects.length === 0) {
    text.push(
      'No Depot container build projects are visible to this token.',
      'If you expected some, run depot_whoami: a token that spans several organizations needs DEPOT_ORG_ID set, and a project token cannot list projects at all.',
    );
    return text.render();
  }
  text.push(`${projects.length} Depot project(s) with cache policies:`);
  for (const project of projects) {
    text.push(`  ${describeProject(project)}`);
  }
  text.push('', 'Read depot://project/<projectId>/builds for a project\'s recent builds.');
  if (readString(response, 'nextPageToken') !== undefined) {
    text.push('More projects exist than were returned; depot_list_projects pages further.');
  }
  return text.render();
}

/**
 * Read-only views over the same Depot calls and parsers the tools use, for clients that attach
 * context by URI rather than by tool call. Templates carry no list callback (Depot has no cheap
 * way to enumerate runs by URI) and nothing here subscribes: every read is a fresh request.
 */
export function registerResources(server: McpServer, context: ToolContext): void {
  server.registerResource(
    'ci-run',
    new ResourceTemplate(RESOURCE_URIS.run, { list: undefined }),
    {
      title: 'Depot CI run tree',
      description:
        'One Depot CI run as its workflow -> job -> attempt tree with the status of every node, as depot_get_ci_run renders it. Structure only; depot_diagnose_ci_failure explains failures.',
      mimeType: 'text/plain',
    },
    (uri, variables) => guarded(uri, () => readRun(context, readVariable(variables, 'runId'))),
  );

  server.registerResource(
    'ci-failed-runs',
    RESOURCE_URIS.failedRuns,
    {
      title: 'Recent failed Depot CI runs',
      description: `The ${LIST_LIMIT} most recent failed Depot CI runs, newest first, with repository, commit, trigger, duration and time.`,
      mimeType: 'text/plain',
    },
    (uri) => guarded(uri, () => readFailedRuns(context)),
  );

  server.registerResource(
    'project-builds',
    new ResourceTemplate(RESOURCE_URIS.projectBuilds, { list: undefined }),
    {
      title: 'Recent Depot container builds for a project',
      description: `The ${LIST_LIMIT} most recent container builds of one project, with duration and cache hit ratio for each.`,
      mimeType: 'text/plain',
    },
    (uri, variables) =>
      guarded(uri, () => readProjectBuilds(context, readVariable(variables, 'projectId'))),
  );

  server.registerResource(
    'projects',
    RESOURCE_URIS.projects,
    {
      title: 'Depot projects',
      description:
        'Every Depot container build project visible to this token, with region, runner hardware and cache policy (retention in days and GB).',
      mimeType: 'text/plain',
    },
    (uri) => guarded(uri, () => readProjects(context)),
  );
}
