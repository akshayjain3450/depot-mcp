/**
 * Release verification against a live Depot organization, one pass per token kind in .env.
 *
 *   npm run verify                       # read-only and dry-run scenarios
 *   npm run verify -- --out report.md    # same, Markdown report elsewhere than docs/verification/latest.md
 *   npm run verify:apply                 # also the apply scenarios; see docs/verification.md first
 *
 * For every token among DEPOT_TOKEN (organization), DEPOT_USER_TOKEN (user), and
 * DEPOT_PROJECT_TOKEN (project) the script creates the server in-process with the write and beta
 * gates open, connects an MCP client over InMemoryTransport, discovers ids, and then calls every
 * registered tool, prompt, and resource. Nothing here talks to Depot except through the server
 * under test, and a fetch wrapper refuses any mutating RPC unless the apply gate has opened.
 *
 * Tokens are never printed. Every line of output passes through a mask that removes token-shaped
 * strings and reduces URLs to their host, so a signed artifact URL cannot leak into a report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { ConfigError, loadConfig, type DepotMcpConfig } from '../src/config.js';
import type { FetchLike } from '../src/depot/client.js';
import {
  asObject,
  readNumber,
  readObject,
  readObjectArray,
  readString,
  type JsonObject,
} from '../src/depot/shape.js';
import { createServer, SERVER_VERSION } from '../src/server.js';
import {
  emptyDiscovery,
  expandTemplate,
  PROMPT_ARGUMENTS,
  READ_TOOL_ARGUMENTS,
  RESOURCE_TEMPLATE_ARGUMENTS,
  VERIFY_PROJECT_NAME,
  VERIFY_VARIABLE_NAME,
  WRITE_DRY_RUN_ARGUMENTS,
  type Args,
  type Discovery,
  type WriteExpectation,
} from './verify-scenarios.js';

// ---------------------------------------------------------------------------------------------
// Tokens and masking

type TokenLabel = 'organization' | 'user' | 'project';

const TOKEN_LABELS: readonly TokenLabel[] = ['organization', 'user', 'project'];

const TOKEN_ENV: Readonly<Record<TokenLabel, string>> = {
  organization: 'DEPOT_TOKEN',
  user: 'DEPOT_USER_TOKEN',
  project: 'DEPOT_PROJECT_TOKEN',
};

interface TokenEntry {
  readonly label: TokenLabel;
  readonly env: string;
  readonly value: string;
}

const tokenValues: string[] = [];

/**
 * Depot tokens start with `depot_` or `dp_` and mix cases and digits; tool names share the
 * prefix but are lowercase throughout, so the case check keeps `depot_list_ci_runs` readable.
 */
function mask(text: string): string {
  let out = text;
  for (const value of tokenValues) {
    out = out.split(value).join('[token]');
  }
  out = out.replace(/(dp_|depot_)[A-Za-z0-9_-]{6,}/g, (match) =>
    /[A-Z0-9]/.test(match) ? '[token]' : match,
  );
  return out.replace(
    /https?:\/\/([^\s/"'<>)\]]+)[^\s"'<>)\]]*/g,
    (_match, host: string) => `https://${host}/[url elided]`,
  );
}

const out: string[] = [];

function say(line = ''): void {
  const safe = mask(line);
  console.log(safe);
  out.push(safe);
}

// ---------------------------------------------------------------------------------------------
// Outcomes

type Kind =
  | 'ok'
  | 'empty'
  | 'refused'
  | 'preview'
  | 'applied'
  | 'depot'
  | 'error'
  | 'schema'
  | 'crashed'
  | 'skipped'
  | 'missing';

interface Outcome {
  readonly kind: Kind;
  /** Connect code, for `depot`. */
  readonly code?: string | undefined;
  readonly note: string;
}

interface Scenario {
  readonly name: string;
  readonly outcome: Outcome;
}

function cell(outcome: Outcome): string {
  if (outcome.kind === 'depot') {
    return outcome.code ?? 'depot';
  }
  return outcome.kind === 'missing' ? 'MISSING BUILDER' : outcome.kind;
}

const NOTE_CHARS = 150;

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > NOTE_CHARS ? `${trimmed.slice(0, NOTE_CHARS - 1)}…` : trimmed;
}

const DEPOT_ERROR = /Depot (?:API error|refused \S+) \((\w+), HTTP (\d+)\) calling (\S+?)[.,;\s]/;

function depotOutcome(text: string): Outcome | undefined {
  const match = DEPOT_ERROR.exec(text);
  if (match === null) {
    return undefined;
  }
  const said = /Depot said: ([^\n]*)/.exec(text)?.[1];
  return {
    kind: 'depot',
    code: match[1],
    note: `${match[3] ?? ''} HTTP ${match[2] ?? ''}${said === undefined ? '' : `: ${said}`}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Session: one server and client per token

interface Gate {
  open: boolean;
  requests: number;
  readonly mutatingCalls: string[];
  readonly violations: string[];
}

const MUTATING_PATH = /Cancel|Retry|Rerun|Set|Delete|Create/;

/** The safety net: no request whose path names a mutating RPC leaves the process while closed. */
function guardedFetch(gate: Gate): FetchLike {
  return (url, init) => {
    gate.requests += 1;
    const pathname = new URL(url).pathname;
    if (MUTATING_PATH.test(pathname)) {
      if (!gate.open) {
        gate.violations.push(pathname);
        return Promise.reject(
          new Error(`verify: blocked mutating request ${pathname} while the apply gate is closed`),
        );
      }
      gate.mutatingCalls.push(pathname);
    }
    return fetch(url, init);
  };
}

interface Session {
  readonly label: TokenLabel;
  readonly config: DepotMcpConfig;
  readonly client: Client;
  readonly tools: readonly Tool[];
  readonly validators: ReadonlyMap<string, JsonSchemaValidator<unknown>>;
  readonly gate: Gate;
  close(): Promise<void>;
}

async function openSession(token: TokenEntry, env: NodeJS.ProcessEnv): Promise<Session> {
  const config = loadConfig({
    ...env,
    DEPOT_TOKEN: token.value,
    DEPOT_MCP_ALLOW_WRITES: '1',
    DEPOT_MCP_ENABLE_BETA: '1',
  });
  const gate: Gate = { open: false, requests: 0, mutatingCalls: [], violations: [] };
  const { server } = createServer({ config, fetch: guardedFetch(gate) });
  const client = new Client({ name: 'depot-mcp-verify', version: SERVER_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  const provider = new AjvJsonSchemaValidator();
  const validators = new Map<string, JsonSchemaValidator<unknown>>();
  for (const tool of tools) {
    if (tool.outputSchema !== undefined) {
      // The SDK's own Client passes the advertised schema straight through the same way.
      validators.set(tool.name, provider.getValidator(tool.outputSchema as JsonSchemaType));
    }
  }

  return {
    label: token.label,
    config,
    client,
    tools,
    validators,
    gate,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Calling tools

const DEFAULT_CALL_TIMEOUT_MS = 90_000;

interface Invocation {
  readonly text: string;
  readonly structured: JsonObject | undefined;
  readonly isError: boolean;
  readonly thrown: Error | undefined;
  readonly schemaError: string | undefined;
}

function contentText(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

/**
 * Sends tools/call directly so the output-schema check can be reported as its own verdict
 * instead of surfacing as a thrown client error; the validator is the SDK's own Ajv provider,
 * the one `Client.callTool` (and so the protocol tests) use.
 */
async function invoke(
  session: Session,
  name: string,
  args: Args,
  timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
): Promise<Invocation> {
  let result: CallToolResult;
  try {
    result = await session.client.request(
      { method: 'tools/call', params: { name, arguments: args } },
      CallToolResultSchema,
      { timeout: timeoutMs },
    );
  } catch (error) {
    return {
      text: '',
      structured: undefined,
      isError: true,
      thrown: error instanceof Error ? error : new Error(String(error)),
      schemaError: undefined,
    };
  }

  const structured = asObject(result.structuredContent);
  const isError = result.isError === true;
  let schemaError: string | undefined;
  const validator = session.validators.get(name);
  if (!isError && validator !== undefined) {
    if (structured === undefined) {
      schemaError = 'tool declares an output schema but returned no structuredContent';
    } else {
      const verdict = validator(structured);
      if (!verdict.valid) {
        schemaError = verdict.errorMessage;
      }
    }
  }
  return { text: contentText(result), structured, isError, thrown: undefined, schemaError };
}

/** A list that found nothing, or a summary that opens by saying so. */
function looksEmpty(structured: JsonObject, text: string): boolean {
  return readNumber(structured, 'returned') === 0 || /^(No|Nothing)\b/.test(firstLine(text));
}

function classify(invocation: Invocation): Outcome {
  if (invocation.thrown !== undefined) {
    return { kind: 'crashed', note: firstLine(invocation.thrown.message) };
  }
  if (invocation.schemaError !== undefined) {
    return { kind: 'schema', note: firstLine(invocation.schemaError) };
  }
  const text = invocation.text;
  if (invocation.isError) {
    const depot = depotOutcome(text);
    if (depot !== undefined) {
      return depot;
    }
    if (/depot-mcp internal error/.test(text)) {
      return { kind: 'crashed', note: firstLine(text) };
    }
    if (/refus/i.test(text)) {
      return { kind: 'refused', note: firstLine(text) };
    }
    return { kind: 'error', note: firstLine(text) };
  }
  const structured = invocation.structured ?? {};
  if (typeof structured.refusal === 'string') {
    return { kind: 'refused', note: firstLine(structured.refusal) };
  }
  if (structured.applied === false) {
    return { kind: 'preview', note: firstLine(text.split('\n').slice(1).join('\n')) || firstLine(text) };
  }
  if (structured.applied === true) {
    return { kind: 'applied', note: firstLine(text) };
  }
  if (text.trim() === '') {
    return { kind: 'error', note: 'empty summary' };
  }
  if (looksEmpty(structured, text)) {
    return { kind: 'empty', note: firstLine(text) };
  }
  return { kind: 'ok', note: firstLine(text) };
}

// ---------------------------------------------------------------------------------------------
// Discovery

interface DiscoveryResult {
  readonly discovery: Discovery;
  readonly notes: string[];
  readonly whoami: JsonObject | undefined;
}

function isFailureWord(value: string | undefined): boolean {
  return value !== undefined && /fail|cancel|error/i.test(value);
}

function isSuccessWord(value: string | undefined): boolean {
  return value !== undefined && /success|finish|complet/i.test(value);
}

async function discover(session: Session, stamp: string): Promise<DiscoveryResult> {
  const d = emptyDiscovery(stamp);
  const notes: string[] = [];
  const registered = new Set(session.tools.map((tool) => tool.name));

  const probe = async (name: string, args: Args): Promise<JsonObject | undefined> => {
    if (!registered.has(name)) {
      notes.push(`${name}: not registered`);
      return undefined;
    }
    const invocation = await invoke(session, name, args);
    const outcome = classify(invocation);
    if (outcome.kind === 'ok' || outcome.kind === 'empty') {
      return invocation.structured ?? {};
    }
    notes.push(`${name}: ${cell(outcome)} (${outcome.note})`);
    return undefined;
  };

  const whoami = await probe('depot_whoami', {});
  d.tokenKind = readString(whoami, 'tokenKind');
  d.activeOrgId = readString(whoami, 'activeOrgId');

  const projects = await probe('depot_list_projects', { limit: 50 });
  d.projectId =
    readObjectArray(projects, 'projects').map((project) => readString(project, 'projectId'))[0] ??
    readObjectArray(whoami, 'projects').map((project) => readString(project, 'projectId'))[0] ??
    session.config.projectId;

  if (d.projectId !== undefined) {
    const builds = readObjectArray(
      await probe('depot_list_builds', { projectId: d.projectId, limit: 50 }),
      'builds',
    );
    d.failedBuildId = builds.find((build) => isFailureWord(readString(build, 'status')))
      ? readString(builds.find((build) => isFailureWord(readString(build, 'status'))), 'buildId')
      : undefined;
    d.okBuildId =
      readString(builds.find((build) => isSuccessWord(readString(build, 'status'))), 'buildId') ??
      readString(builds.find((build) => !isFailureWord(readString(build, 'status'))), 'buildId');
  }

  const runs = readObjectArray(await probe('depot_list_ci_runs', { limit: 50 }), 'runs');
  const failedRun = runs.find((run) => readString(run, 'status') === 'failed');
  d.failedRunId = readString(failedRun, 'runId');
  // A successful run when there is one; otherwise any other run, so the comparison scenarios
  // still have a pair on an organization whose every run failed.
  const okRun =
    runs.find((run) => readString(run, 'status') === 'finished') ??
    runs.find((run) => readString(run, 'runId') !== d.failedRunId);
  d.okRunId = readString(okRun, 'runId');
  d.repo = readString(failedRun, 'repo') ?? readString(okRun, 'repo');

  const treeRunId = d.failedRunId ?? d.okRunId;
  if (treeRunId !== undefined) {
    const tree = await probe('depot_get_ci_run', { runId: treeRunId });
    let fallback:
      | { workflowId: string | undefined; jobId: string | undefined; attemptId: string | undefined }
      | undefined;
    for (const workflow of readObjectArray(tree, 'workflows')) {
      for (const job of readObjectArray(workflow, 'jobs')) {
        const attempts = readObjectArray(job, 'attempts');
        const pick = {
          workflowId: readString(workflow, 'workflowId'),
          jobId: readString(job, 'jobId'),
          attemptId:
            readString(
              attempts.find((attempt) =>
                isFailureWord(readString(attempt, 'conclusion') ?? readString(attempt, 'status')),
              ),
              'attemptId',
            ) ?? readString(attempts[attempts.length - 1], 'attemptId'),
        };
        fallback ??= pick;
        if (isFailureWord(readString(job, 'conclusion') ?? readString(job, 'status'))) {
          fallback = pick;
          break;
        }
      }
    }
    d.workflowId = fallback?.workflowId;
    d.jobId = fallback?.jobId;
    d.attemptId = fallback?.attemptId;
  }

  for (const runId of [d.failedRunId, d.okRunId]) {
    if (runId === undefined || d.artifactId !== undefined) {
      continue;
    }
    const artifacts = readObjectArray(await probe('depot_list_ci_artifacts', { runId }), 'artifacts');
    d.artifactId = readString(artifacts[0], 'artifactId');
  }

  d.sandboxId = readString(
    readObjectArray(await probe('depot_list_sandboxes', { limit: 10 }), 'sandboxes')[0],
    'sandboxId',
  );
  d.repository = readString(
    readObjectArray(await probe('depot_list_registry_repositories', { limit: 10 }), 'repositories')[0],
    'name',
  );

  return { discovery: d, notes, whoami };
}

function describeDiscovery(d: Discovery): string {
  const pairs: Array<[string, string | undefined]> = [
    ['tokenKind', d.tokenKind],
    ['activeOrg', d.activeOrgId],
    ['project', d.projectId],
    ['repo', d.repo],
    ['failedRun', d.failedRunId],
    ['okRun', d.okRunId],
    ['workflow', d.workflowId],
    ['job', d.jobId],
    ['attempt', d.attemptId],
    ['artifact', d.artifactId],
    ['failedBuild', d.failedBuildId],
    ['okBuild', d.okBuildId],
    ['sandbox', d.sandboxId],
    ['repository', d.repository],
  ];
  return pairs.map(([key, value]) => `${key}=${value ?? '-'}`).join(' ');
}

// ---------------------------------------------------------------------------------------------
// Scenario phases

type Recorder = (name: string, outcome: Outcome) => void;

function isWriteTool(tool: Tool): boolean {
  return tool.annotations?.readOnlyHint === false;
}

async function runReadScenarios(session: Session, d: Discovery, record: Recorder): Promise<void> {
  for (const tool of session.tools) {
    if (isWriteTool(tool)) {
      continue;
    }
    const builder = READ_TOOL_ARGUMENTS[tool.name];
    if (builder === undefined) {
      record(tool.name, {
        kind: 'missing',
        note: `no argument builder in scripts/verify-scenarios.ts for read tool ${tool.name}`,
      });
      continue;
    }
    const built = builder(d);
    if ('skip' in built) {
      record(tool.name, { kind: 'skipped', note: built.skip });
      continue;
    }
    record(tool.name, classify(await invoke(session, tool.name, built.args)));
  }
}

async function runPromptScenarios(session: Session, d: Discovery, record: Recorder): Promise<void> {
  const { prompts } = await session.client.listPrompts();
  for (const prompt of prompts) {
    const name = `prompt ${prompt.name}`;
    const builder = PROMPT_ARGUMENTS[prompt.name];
    if (builder === undefined) {
      record(name, { kind: 'missing', note: `no argument builder for prompt ${prompt.name}` });
      continue;
    }
    const built = builder(d);
    if ('skip' in built) {
      record(name, { kind: 'skipped', note: built.skip });
      continue;
    }
    try {
      const result = await session.client.getPrompt({ name: prompt.name, arguments: built.args });
      const text = result.messages
        .map((message) => (message.content.type === 'text' ? message.content.text : ''))
        .join('\n');
      record(
        name,
        text.trim() === ''
          ? { kind: 'error', note: 'prompt returned no text' }
          : { kind: 'ok', note: `${result.messages.length} message(s): ${firstLine(text)}` },
      );
    } catch (error) {
      record(name, { kind: 'crashed', note: firstLine(error instanceof Error ? error.message : String(error)) });
    }
  }
}

async function readResource(session: Session, name: string, uri: string, record: Recorder): Promise<void> {
  try {
    const result = await session.client.readResource({ uri });
    const text = result.contents
      .map((content) => ('text' in content && typeof content.text === 'string' ? content.text : ''))
      .join('\n');
    record(
      name,
      text.trim() === ''
        ? { kind: 'error', note: 'resource returned no text' }
        : { kind: 'ok', note: firstLine(text) },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const depot = depotOutcome(message);
    if (depot !== undefined) {
      record(name, depot);
    } else if (error instanceof McpError) {
      record(name, { kind: 'error', note: firstLine(message) });
    } else {
      record(name, { kind: 'crashed', note: firstLine(message) });
    }
  }
}

async function runResourceScenarios(session: Session, d: Discovery, record: Recorder): Promise<void> {
  const { resources } = await session.client.listResources();
  for (const resource of resources) {
    await readResource(session, `resource ${resource.uri}`, resource.uri, record);
  }
  const { resourceTemplates } = await session.client.listResourceTemplates();
  for (const template of resourceTemplates) {
    const name = `resource ${template.uriTemplate}`;
    const builder = RESOURCE_TEMPLATE_ARGUMENTS[template.uriTemplate];
    if (builder === undefined) {
      record(name, { kind: 'missing', note: `no argument builder for template ${template.uriTemplate}` });
      continue;
    }
    const built = builder(d);
    if ('skip' in built) {
      record(name, { kind: 'skipped', note: built.skip });
      continue;
    }
    await readResource(session, name, expandTemplate(template.uriTemplate, built.args), record);
  }
}

function expectationNote(outcome: Outcome, expect: WriteExpectation): string {
  if (outcome.kind !== 'preview' && outcome.kind !== 'refused') {
    return outcome.note;
  }
  const matched = expect === 'either' || expect === outcome.kind;
  return `${matched ? 'as expected' : `expected ${expect}`}; ${outcome.note}`;
}

async function runDryRunScenarios(session: Session, d: Discovery, record: Recorder): Promise<void> {
  for (const tool of session.tools) {
    if (!isWriteTool(tool)) {
      continue;
    }
    const name = `dry-run ${tool.name}`;
    const scenario = WRITE_DRY_RUN_ARGUMENTS[tool.name];
    if (scenario === undefined) {
      record(name, {
        kind: 'missing',
        note: `no dry-run builder in scripts/verify-scenarios.ts for write tool ${tool.name}`,
      });
      continue;
    }
    const built = scenario.build(d);
    if ('skip' in built) {
      record(name, { kind: 'skipped', note: built.skip });
      continue;
    }
    if (built.args.dryRun === false) {
      throw new Error(`dry-run builder for ${tool.name} sets dryRun:false`);
    }
    const outcome = classify(await invoke(session, tool.name, built.args));
    record(name, { ...outcome, note: expectationNote(outcome, scenario.expect) });
  }
}

// ---------------------------------------------------------------------------------------------
// Apply phase

/** Upper bound on the CI time the apply phase may spend waiting on runs. */
const APPLY_BUDGET_SECONDS = 150;
const RETRY_WAIT_SECONDS = 180;

function applyGateReason(
  session: Session,
  d: Discovery,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (env.DEPOT_MCP_VERIFY_APPLY !== '1') {
    return 'DEPOT_MCP_VERIFY_APPLY is not 1';
  }
  if (session.label !== 'organization') {
    return `apply runs only with the organization token, this is the ${session.label} token`;
  }
  const allowed = env.DEPOT_MCP_VERIFY_ORG?.trim();
  if (allowed === undefined || allowed === '') {
    return 'DEPOT_MCP_VERIFY_ORG is not set; it must name the organization allowed to receive writes';
  }
  if (d.activeOrgId === undefined) {
    return 'depot_whoami reported no activeOrgId, so the allowlist cannot be checked';
  }
  if (d.activeOrgId !== allowed) {
    return `depot_whoami reports activeOrgId ${d.activeOrgId}, not the allowlisted ${allowed}`;
  }
  return undefined;
}

/** Any value under a key that names the wanted id kind, anywhere in the response. */
function findIds(value: unknown, keyPattern: RegExp, found: string[] = []): string[] {
  const object = asObject(value);
  if (object === undefined) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        findIds(entry, keyPattern, found);
      }
    }
    return found;
  }
  for (const [key, entry] of Object.entries(object)) {
    if (typeof entry === 'string' && keyPattern.test(key)) {
      found.push(entry);
    } else {
      findIds(entry, keyPattern, found);
    }
  }
  return found;
}

function waitSeconds(remaining: number, cap: number): number {
  return Math.max(5, Math.min(cap, Math.floor(remaining)));
}

async function runApplyScenarios(session: Session, d: Discovery, record: Recorder): Promise<void> {
  const started = Date.now();
  const remaining = (): number => APPLY_BUDGET_SECONDS - (Date.now() - started) / 1000;
  const apply = async (tool: string, args: Args, name: string): Promise<Invocation> => {
    session.gate.open = true;
    try {
      const invocation = await invoke(session, tool, { ...args, dryRun: false });
      record(name, classify(invocation));
      return invocation;
    } finally {
      session.gate.open = false;
    }
  };
  const wait = async (runId: string, cap: number, name: string): Promise<Invocation> => {
    const timeoutSeconds = waitSeconds(remaining(), cap);
    const invocation = await invoke(
      session,
      'depot_wait_for_ci_run',
      { runId, timeoutSeconds, pollSeconds: 5 },
      (timeoutSeconds + 30) * 1000,
    );
    const outcome = classify(invocation);
    const status = readString(invocation.structured, 'status') ?? 'unknown';
    const why = readString(invocation.structured, 'outcome') ?? '';
    record(name, { ...outcome, note: `status ${status} (${why}); ${outcome.note}` });
    return invocation;
  };

  // (a) Variable round trip.
  const value = `ok-${d.stamp}`;
  await apply('depot_set_ci_variable', { name: VERIFY_VARIABLE_NAME, value }, 'apply set variable');
  const listed = await invoke(session, 'depot_list_ci_variables', { query: VERIFY_VARIABLE_NAME });
  const present = readObjectArray(listed.structured, 'variables').some(
    (variable) => readString(variable, 'name') === VERIFY_VARIABLE_NAME,
  );
  record('apply confirm variable present', {
    kind: present ? 'ok' : 'error',
    note: present ? `${VERIFY_VARIABLE_NAME} listed after set` : `${VERIFY_VARIABLE_NAME} missing after set`,
  });
  await apply(
    'depot_delete_ci_variable',
    { name: VERIFY_VARIABLE_NAME, allVariants: true },
    'apply delete variable',
  );
  const relisted = await invoke(session, 'depot_list_ci_variables', { query: VERIFY_VARIABLE_NAME });
  const gone = !readObjectArray(relisted.structured, 'variables').some(
    (variable) => readString(variable, 'name') === VERIFY_VARIABLE_NAME,
  );
  record('apply confirm variable gone', {
    kind: gone ? 'ok' : 'error',
    note: gone ? `${VERIFY_VARIABLE_NAME} absent after delete` : `${VERIFY_VARIABLE_NAME} still listed`,
  });

  // (b) Retry the failed job, then wait for its run.
  if (d.jobId === undefined || d.failedRunId === undefined) {
    record('apply retry job', { kind: 'skipped', note: 'no failed job available' });
  } else {
    let retry = await apply('depot_retry_ci_job', { jobId: d.jobId }, 'apply retry job');
    if (retry.isError && /attempt|3 or more/i.test(retry.text)) {
      retry = await apply('depot_retry_ci_job', { jobId: d.jobId, force: true }, 'apply retry job (force)');
    }
    if (!retry.isError) {
      await wait(d.failedRunId, RETRY_WAIT_SECONDS, 'apply wait after retry');
    }
  }

  // (c) Full rerun, cancel the new run at once, confirm it lands in cancelled.
  if (d.workflowId === undefined) {
    record('apply rerun workflow', { kind: 'skipped', note: 'no workflow available' });
  } else if (remaining() < 20) {
    record('apply rerun workflow', { kind: 'skipped', note: 'apply time budget exhausted' });
  } else {
    const rerun = await apply(
      'depot_rerun_ci_workflow',
      { workflowId: d.workflowId, allowFullRerun: true },
      'apply rerun workflow',
    );
    const after = readObject(rerun.structured, 'after');
    const newRunId = findIds(after, /runid/i).find((id) => id !== d.failedRunId);
    const newWorkflowId = findIds(after, /workflowid/i).find((id) => id !== d.workflowId);
    if (rerun.isError) {
      record('apply cancel rerun', { kind: 'skipped', note: 'rerun was not applied' });
    } else if (newRunId === undefined && newWorkflowId === undefined) {
      record('apply cancel rerun', {
        kind: 'skipped',
        note: 'rerun response carried no new run or workflow id; cancel it in the dashboard',
      });
    } else {
      const target = newRunId === undefined ? { workflowId: newWorkflowId } : { runId: newRunId };
      await apply('depot_cancel_ci_run', target, 'apply cancel rerun');
      const waitRun = newRunId ?? d.failedRunId;
      if (waitRun === undefined) {
        record('apply wait after cancel', { kind: 'skipped', note: 'no run id to wait on' });
      } else {
        const waited = await wait(waitRun, 120, 'apply wait after cancel');
        const status = readString(waited.structured, 'status') ?? '';
        record('apply confirm cancelled', {
          kind: /cancel/i.test(status) ? 'ok' : 'error',
          note: `run ${waitRun} ended ${status || 'unknown'}`,
        });
      }
    }
  }

  // (d) Create a project and read it back.
  const projectName = `${VERIFY_PROJECT_NAME}-${d.stamp}`;
  const created = await apply('depot_create_project', { name: projectName }, 'apply create project');
  const projectId = readString(readObject(readObject(created.structured, 'after'), 'project'), 'projectId');
  if (projectId === undefined) {
    record('apply get created project', { kind: 'skipped', note: 'create returned no projectId' });
  } else {
    record('apply get created project', classify(await invoke(session, 'depot_get_project', { projectId })));
  }
  say('');
  say('*** REMINDER: projects cannot be deleted through this server. ***');
  say(`*** Remove "${projectName}"${projectId === undefined ? '' : ` (${projectId})`} in the Depot dashboard. ***`);
}

// ---------------------------------------------------------------------------------------------
// Per-token run and reporting

interface TokenReport {
  readonly token: TokenEntry;
  readonly scenarios: Scenario[];
  readonly discoveryLine: string;
  readonly discoveryNotes: string[];
  readonly applyGate: string;
  readonly requests: number;
  readonly mutatingCalls: string[];
  readonly violations: string[];
  readonly fatal: string | undefined;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function printRow(name: string, outcome: Outcome): void {
  say(`  ${pad(name, 44)} ${pad(cell(outcome), 18)} ${outcome.note}`);
}

async function verifyToken(
  token: TokenEntry,
  env: NodeJS.ProcessEnv,
  stamp: string,
): Promise<TokenReport> {
  const scenarios: Scenario[] = [];
  const record: Recorder = (name, outcome) => {
    scenarios.push({ name, outcome });
    printRow(name, outcome);
  };

  say('');
  say(`== ${token.label} token (${token.env}) ==`);
  let session: Session;
  try {
    session = await openSession(token, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    say(`  could not start the server: ${firstLine(message)}`);
    return {
      token,
      scenarios,
      discoveryLine: '',
      discoveryNotes: [],
      applyGate: 'closed',
      requests: 0,
      mutatingCalls: [],
      violations: [],
      fatal: message,
    };
  }

  try {
    const counts = {
      read: session.tools.filter((tool) => !isWriteTool(tool)).length,
      write: session.tools.filter(isWriteTool).length,
    };
    say(`tools/list: ${session.tools.length} tools (${counts.read} read-only including beta, ${counts.write} write)`);

    const { discovery, notes } = await discover(session, stamp);
    const discoveryLine = describeDiscovery(discovery);
    say(`discovery: ${discoveryLine}`);
    for (const note of notes) {
      say(`  discovery note: ${note}`);
    }

    say('');
    say(`  ${pad('scenario', 44)} ${pad('result', 18)} note`);
    await runReadScenarios(session, discovery, record);
    await runPromptScenarios(session, discovery, record);
    await runResourceScenarios(session, discovery, record);
    await runDryRunScenarios(session, discovery, record);

    const reason = applyGateReason(session, discovery, env);
    const applyGate = reason === undefined ? 'open' : `closed: ${reason}`;
    say('');
    say(`apply gate ${applyGate}`);
    if (reason === undefined) {
      await runApplyScenarios(session, discovery, record);
    }

    if (session.gate.violations.length > 0) {
      say('');
      say(`!!! ${session.gate.violations.length} mutating request(s) attempted while the gate was closed: ${session.gate.violations.join(', ')}`);
    }
    say(`requests to Depot: ${session.gate.requests}; mutating RPCs called: ${session.gate.mutatingCalls.length === 0 ? 'none' : session.gate.mutatingCalls.join(', ')}`);

    return {
      token,
      scenarios,
      discoveryLine,
      discoveryNotes: notes,
      applyGate,
      requests: session.gate.requests,
      mutatingCalls: session.gate.mutatingCalls,
      violations: session.gate.violations,
      fatal: undefined,
    };
  } finally {
    await session.close();
  }
}

/** Codes the documented token matrix predicts for tokens Depot's core services refuse. */
const EXPECTED_DENIALS: ReadonlySet<string> = new Set(['unauthenticated', 'permission_denied']);

function isFailure(report: TokenReport, scenario: Scenario): boolean {
  const { kind, code } = scenario.outcome;
  if (kind === 'crashed' || kind === 'schema' || kind === 'missing') {
    return true;
  }
  if (kind === 'depot') {
    return report.token.label === 'organization' || !EXPECTED_DENIALS.has(code ?? '');
  }
  return false;
}

function summarise(reports: readonly TokenReport[]): { failures: string[]; total: number } {
  const failures: string[] = [];
  let total = 0;
  for (const report of reports) {
    if (report.fatal !== undefined) {
      failures.push(`${report.token.label}: server did not start (${firstLine(report.fatal)})`);
    }
    for (const violation of report.violations) {
      failures.push(`${report.token.label}: mutating request ${violation} attempted with the gate closed`);
    }
    for (const scenario of report.scenarios) {
      total += 1;
      if (isFailure(report, scenario)) {
        failures.push(`${report.token.label}: ${scenario.name} ${cell(scenario.outcome)} (${scenario.outcome.note})`);
      }
    }
  }
  return { failures, total };
}

function matrixLines(reports: readonly TokenReport[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    for (const scenario of report.scenarios) {
      if (!seen.has(scenario.name)) {
        seen.add(scenario.name);
        names.push(scenario.name);
      }
    }
  }
  const columns = TOKEN_LABELS.map((label) => reports.find((report) => report.token.label === label));
  const lines = [
    `| scenario | ${TOKEN_LABELS.join(' | ')} |`,
    `| --- | ${TOKEN_LABELS.map(() => '---').join(' | ')} |`,
  ];
  for (const name of names) {
    const cells = columns.map((report) => {
      if (report === undefined) {
        return 'no token';
      }
      const scenario = report.scenarios.find((entry) => entry.name === name);
      return scenario === undefined ? '-' : cell(scenario.outcome);
    });
    lines.push(`| ${name} | ${cells.join(' | ')} |`);
  }
  return lines;
}

function markdownReport(
  reports: readonly TokenReport[],
  auditLines: readonly string[],
  summary: { failures: string[]; total: number },
  tokensPresent: readonly TokenEntry[],
  startedAt: string,
): string {
  const lines: string[] = [
    '# depot-mcp verification report',
    '',
    `- Date: ${startedAt}`,
    `- Server version: ${SERVER_VERSION}`,
    `- Tokens: ${TOKEN_LABELS.map((label) => `${label} (${TOKEN_ENV[label]}: ${tokensPresent.some((token) => token.label === label) ? 'present' : 'absent'})`).join(', ')}`,
    `- Apply: ${reports.map((report) => `${report.token.label} ${report.applyGate}`).join('; ')}`,
    '',
    '## Cross-token matrix',
    '',
    ...matrixLines(reports),
    '',
  ];
  for (const report of reports) {
    lines.push(`## ${report.token.label} token (${report.token.env})`, '');
    if (report.fatal !== undefined) {
      lines.push(`Server did not start: ${firstLine(report.fatal)}`, '');
      continue;
    }
    lines.push(`Discovery: \`${report.discoveryLine}\``, '');
    for (const note of report.discoveryNotes) {
      lines.push(`- discovery note: ${note}`);
    }
    if (report.discoveryNotes.length > 0) {
      lines.push('');
    }
    lines.push('| scenario | result | note |', '| --- | --- | --- |');
    for (const scenario of report.scenarios) {
      lines.push(
        `| ${scenario.name} | ${cell(scenario.outcome)} | ${scenario.outcome.note.replace(/\|/g, '\\|')} |`,
      );
    }
    lines.push(
      '',
      `Requests to Depot: ${report.requests}. Mutating RPCs called: ${report.mutatingCalls.length === 0 ? 'none' : report.mutatingCalls.join(', ')}. Gate violations: ${report.violations.length}.`,
      '',
    );
  }
  lines.push('## Audit lines', '');
  if (auditLines.length === 0) {
    lines.push('No write was applied.');
  } else {
    lines.push('```', ...auditLines, '```');
  }
  lines.push('', '## Summary', '');
  lines.push(
    summary.failures.length === 0
      ? `${summary.total} scenario(s), no failures.`
      : `${summary.total} scenario(s), ${summary.failures.length} failure(s):`,
  );
  for (const failure of summary.failures) {
    lines.push(`- ${failure}`);
  }
  lines.push('');
  return lines.map(mask).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Entry point

function utcStamp(date: Date): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: { out: { type: 'string', default: path.join('docs', 'verification', 'latest.md') } },
  });
  const outPath = path.resolve(values.out);
  const env = process.env;
  const started = new Date();
  const stamp = utcStamp(started);

  const tokens: TokenEntry[] = [];
  for (const label of TOKEN_LABELS) {
    const envName = TOKEN_ENV[label];
    const value = env[envName]?.trim();
    if (value !== undefined && value !== '') {
      tokens.push({ label, env: envName, value });
      tokenValues.push(value);
    }
  }

  // Every applied write logs one audit line to stderr; keep a copy for the report.
  const auditLines: string[] = [];
  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    const line = args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' ');
    if (line.includes('[depot-mcp write]')) {
      auditLines.push(mask(line));
    }
    originalError(mask(line));
  };

  say(`depot-mcp verify ${SERVER_VERSION} at ${started.toISOString()}`);
  say(
    `tokens: ${TOKEN_LABELS.map((label) => `${label} (${TOKEN_ENV[label]}) ${tokens.some((token) => token.label === label) ? 'present' : 'absent'}`).join(', ')}`,
  );
  if (tokens.length === 0) {
    say('Nothing to verify: set at least DEPOT_TOKEN in .env or the environment.');
    return 1;
  }
  say(
    env.DEPOT_MCP_VERIFY_APPLY === '1'
      ? `apply requested for organization ${env.DEPOT_MCP_VERIFY_ORG ?? '(DEPOT_MCP_VERIFY_ORG unset)'}`
      : 'apply not requested (DEPOT_MCP_VERIFY_APPLY unset); read-only and dry-run scenarios only',
  );

  const reports: TokenReport[] = [];
  for (const token of tokens) {
    try {
      reports.push(await verifyToken(token, env, stamp));
    } catch (error) {
      if (error instanceof ConfigError) {
        say(`  ${token.env}: ${firstLine(error.message)}`);
      } else {
        throw error;
      }
    }
  }

  say('');
  say('== cross-token matrix ==');
  for (const line of matrixLines(reports)) {
    say(line);
  }

  if (auditLines.length > 0) {
    say('');
    say('== audit lines ==');
    for (const line of auditLines) {
      say(line);
    }
  }

  const summary = summarise(reports);
  say('');
  for (const failure of summary.failures) {
    say(`FAIL ${failure}`);
  }
  say(
    `verify: ${tokens.length} token(s), ${summary.total} scenario(s), ${summary.failures.length} failure(s); ${summary.failures.length === 0 ? 'PASS' : 'FAIL'}`,
  );

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    markdownReport(reports, auditLines, summary, tokens, started.toISOString()),
    'utf8',
  );
  say(`report written to ${path.relative(process.cwd(), outPath)}`);
  return summary.failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(mask(error instanceof Error ? (error.stack ?? error.message) : String(error)));
    process.exitCode = 1;
  },
);
