import { z } from 'zod';
import {
  mapEnumNumber,
  readNumber,
  readObject,
  readObjectArray,
  readString,
  type JsonObject,
} from '../depot/shape.js';
import { formatCount, TextBudget } from '../lib/budget.js';
import { toRfc3339 } from '../lib/time.js';
import { defineTool, ToolInputError } from '../lib/tool.js';

/**
 * From depot/sandbox-sdk sandbox.proto (`enum SandboxStatus`). The wire spelling is the full
 * enum name; the tool speaks the bare lower-case form on both sides.
 */
export const SANDBOX_STATES = [
  'created',
  'assigned',
  'starting',
  'running',
  'finished',
  'cancelled',
  'failed',
] as const;

export type SandboxState = (typeof SANDBOX_STATES)[number];

const SANDBOX_STATUS_BY_NUMBER: Readonly<Record<number, string>> = {
  0: 'unspecified',
  1: 'created',
  2: 'assigned',
  3: 'starting',
  4: 'running',
  5: 'finished',
  6: 'cancelled',
  7: 'failed',
};

export function toWireSandboxStatus(state: SandboxState): string {
  return `SANDBOX_STATUS_${state.toUpperCase()}`;
}

const BETA_NOTICE =
  'Beta: this tool is registered only when DEPOT_MCP_ENABLE_BETA is set, because depot.sandbox.v1 is published as a proto without reference documentation and Depot may change it without notice. Field names and states here follow the proto as of 2026-09-06.';

export const sandboxSchema = z.object({
  sandboxId: z.string().optional(),
  name: z.string().optional(),
  organizationId: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  startedAt: z.string().optional(),
  stoppedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  exitCode: z.number().optional(),
  errorMessage: z.string().optional(),
  resources: z.object({
    vcpus: z.number().optional(),
    memoryMb: z.number().optional(),
    diskGb: z.number().optional(),
  }),
  runtime: z.object({
    imageRef: z.string().optional(),
    named: z.string().optional(),
  }),
  activeCpuUsageMs: z.number().optional(),
  networkUsage: z
    .object({
      ingressBytes: z.number().optional(),
      egressBytes: z.number().optional(),
    })
    .optional(),
  /** Names only. A sandbox's environment routinely carries credentials, so values never leave Depot through this server. */
  envNames: z.array(z.string()),
});

export type SandboxSummary = z.infer<typeof sandboxSchema>;

const MAX_ERROR_CHARS = 500;

export function parseSandbox(source: JsonObject): SandboxSummary {
  const inner = readObject(source, 'sandbox') ?? source;
  const resources = readObject(inner, 'resources');
  const runtime = readObject(inner, 'runtime');
  const network = readObject(inner, 'networkUsage');
  const env = readObject(inner, 'env');
  const errorMessage = readString(inner, 'errorMessage');
  return {
    sandboxId: readString(inner, 'sandboxId', 'id'),
    name: readString(inner, 'name'),
    organizationId: readString(inner, 'organizationId', 'orgId'),
    status: mapEnumNumber(inner, ['status'], SANDBOX_STATUS_BY_NUMBER, ['SANDBOX_STATUS']),
    createdAt: readString(inner, 'createdAt'),
    startedAt: readString(inner, 'startedAt'),
    stoppedAt: readString(inner, 'stoppedAt'),
    expiresAt: readString(inner, 'expiresAt'),
    exitCode: readNumber(inner, 'exitCode'),
    errorMessage:
      errorMessage === undefined
        ? undefined
        : errorMessage.length > MAX_ERROR_CHARS
          ? `${errorMessage.slice(0, MAX_ERROR_CHARS)}…`
          : errorMessage,
    resources: {
      vcpus: readNumber(resources, 'vcpus'),
      memoryMb: readNumber(resources, 'memoryMb'),
      diskGb: readNumber(resources, 'diskGb'),
    },
    runtime: {
      imageRef: readString(runtime, 'imageRef'),
      named: readString(runtime, 'named'),
    },
    activeCpuUsageMs: readNumber(inner, 'activeCpuUsageMs'),
    networkUsage:
      network === undefined
        ? undefined
        : {
            ingressBytes: readNumber(network, 'ingressBytes'),
            egressBytes: readNumber(network, 'egressBytes'),
          },
    envNames: env === undefined ? [] : Object.keys(env).sort(),
  };
}

function describeResources(sandbox: SandboxSummary): string {
  const parts = [
    sandbox.resources.vcpus === undefined ? undefined : `${sandbox.resources.vcpus} vCPU`,
    sandbox.resources.memoryMb === undefined ? undefined : `${sandbox.resources.memoryMb} MB`,
    sandbox.resources.diskGb === undefined ? undefined : `${sandbox.resources.diskGb} GB disk`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? 'default resources' : parts.join(' / ');
}

export function describeSandbox(sandbox: SandboxSummary): string {
  const runtime = sandbox.runtime.imageRef ?? sandbox.runtime.named ?? 'unknown runtime';
  const label = sandbox.name === undefined ? '' : ` "${sandbox.name}"`;
  const outcome =
    sandbox.exitCode === undefined ? '' : ` · exit ${sandbox.exitCode}`;
  return `${sandbox.sandboxId ?? 'unknown id'}${label}: ${sandbox.status ?? 'unknown status'} · ${runtime} · ${describeResources(sandbox)} · created ${sandbox.createdAt ?? 'unknown'}${outcome}`;
}

function parseWindowBound(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return toRfc3339(value);
  } catch (error) {
    throw new ToolInputError(`${field}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const listSandboxesTool = defineTool({
  name: 'depot_list_sandboxes',
  title: 'List Depot sandboxes (beta API)',
  description: `List the organization's Depot sandboxes (Depot's on-demand VMs for agents), most recent first, with state, runtime image, resources, timing, and exit code.

Use this to see which sandboxes are running or recently finished, to find a sandboxId for depot_get_sandbox, or to check whether a failed sandbox left an error message. Filter by state (for example ["running"]) or by creation time.

${BETA_NOTICE}

Read-only: this cannot create a sandbox or run commands in one; those operations are deliberately not exposed by this server. Stopping or killing a sandbox is a separate write tool (depot_stop_sandbox, depot_kill_sandbox) that exists only when DEPOT_MCP_ALLOW_WRITES is also set. Sandbox environment variables are reported by name only, never by value.`,
  inputSchema: {
    states: z
      .array(z.enum(SANDBOX_STATES))
      .optional()
      .describe(
        'Only sandboxes in these states. Omit for every state. Terminal states are finished, cancelled, and failed.',
      ),
    createdAfter: z
      .string()
      .optional()
      .describe('Only sandboxes created at or after this time (RFC 3339 or YYYY-MM-DD, UTC).'),
    createdBefore: z
      .string()
      .optional()
      .describe('Only sandboxes created at or before this time (RFC 3339 or YYYY-MM-DD, UTC).'),
    limit: z.number().int().min(1).max(100).default(25).describe('Maximum sandboxes to return.'),
    pageToken: z
      .string()
      .optional()
      .describe('Continue a previous listing: pass the nextPageToken from the last call.'),
  },
  outputSchema: {
    sandboxes: z.array(sandboxSchema),
    returned: z.number(),
    nextPageToken: z.string().optional(),
    beta: z.literal(true),
  },
  handler: async (input, context) => {
    const createdAfter = parseWindowBound(input.createdAfter, 'createdAfter');
    const createdBefore = parseWindowBound(input.createdBefore, 'createdBefore');
    const states = input.states === undefined ? undefined : input.states.map(toWireSandboxStatus);
    const hasFilter =
      (states !== undefined && states.length > 0) ||
      createdAfter !== undefined ||
      createdBefore !== undefined;

    const response = await context.api.listSandboxes({
      pageSize: input.limit,
      pageToken: input.pageToken,
      filter: hasFilter ? { states, createdAfter, createdBefore } : undefined,
    });
    const sandboxes = readObjectArray(response, 'sandboxes').map(parseSandbox);
    const nextPageToken = readString(response, 'nextPageToken');

    const text = new TextBudget(context.config.outputCharBudget);
    if (sandboxes.length === 0) {
      text.push(
        hasFilter
          ? 'No sandboxes match the filter.'
          : 'No sandboxes are visible to this token: the organization has not created any, or DEPOT_ORG_ID selects a different organization.',
      );
    } else {
      text.push(`${formatCount(sandboxes.length, 'sandbox', 'sandboxes')}, most recent first:`);
      for (const sandbox of sandboxes) {
        text.push(`  ${describeSandbox(sandbox)}`);
        if (sandbox.errorMessage !== undefined) {
          text.push(`    error: ${sandbox.errorMessage}`);
        }
      }
    }
    if (nextPageToken !== undefined) {
      text.push('', `More sandboxes exist; re-call with pageToken="${nextPageToken}".`);
    }
    text.push('', 'Beta API (depot.sandbox.v1): field names and states may change without notice.');

    return {
      summary: text.render(),
      data: { sandboxes, returned: sandboxes.length, nextPageToken, beta: true as const },
    };
  },
});

export const getSandboxTool = defineTool({
  name: 'depot_get_sandbox',
  title: 'Get one Depot sandbox (beta API)',
  description: `Show one Depot sandbox: its lifecycle state, runtime image, provisioned resources, creation, start, stop and expiry times, exit code, error message, metered CPU time and network bytes (available once the sandbox has ended), and the names of its environment variables.

Use this after depot_list_sandboxes to inspect a sandbox that failed or is still running, or to check when a running sandbox will expire.

${BETA_NOTICE}

Read-only: this cannot extend the sandbox or run commands in it. Stopping or killing it is a separate write tool (depot_stop_sandbox, depot_kill_sandbox) that exists only when DEPOT_MCP_ALLOW_WRITES is also set. Environment variable values are never returned, only their names.`,
  inputSchema: {
    sandboxId: z
      .string()
      .trim()
      .min(1)
      .describe('The sandbox id, as returned by depot_list_sandboxes.'),
  },
  outputSchema: {
    sandbox: sandboxSchema,
    beta: z.literal(true),
  },
  handler: async (input, context) => {
    const response = await context.api.getSandbox(input.sandboxId);
    const sandbox = parseSandbox(response);

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(describeSandbox(sandbox));
    if (sandbox.organizationId !== undefined) {
      text.push(`Organization: ${sandbox.organizationId}`);
    }
    const timing = [
      sandbox.startedAt === undefined ? undefined : `started ${sandbox.startedAt}`,
      sandbox.stoppedAt === undefined ? undefined : `stopped ${sandbox.stoppedAt}`,
      sandbox.expiresAt === undefined ? undefined : `expires ${sandbox.expiresAt}`,
    ].filter((part): part is string => part !== undefined);
    if (timing.length > 0) {
      text.push(`Timing: ${timing.join(' · ')}`);
    }
    if (sandbox.errorMessage !== undefined) {
      text.push(`Error: ${sandbox.errorMessage}`);
    }
    if (sandbox.activeCpuUsageMs !== undefined) {
      text.push(`Active CPU time: ${(sandbox.activeCpuUsageMs / 1000).toFixed(1)}s`);
    }
    if (sandbox.networkUsage !== undefined) {
      text.push(
        `Network: ${sandbox.networkUsage.ingressBytes ?? 'unknown'} bytes in, ${sandbox.networkUsage.egressBytes ?? 'unknown'} bytes out`,
      );
    }
    text.push(
      sandbox.envNames.length === 0
        ? 'Environment variables: none set at creation.'
        : `Environment variables (names only, values withheld): ${sandbox.envNames.join(', ')}`,
    );
    text.push('', 'Beta API (depot.sandbox.v1): field names and states may change without notice.');

    return { summary: text.render(), data: { sandbox, beta: true as const } };
  },
});
