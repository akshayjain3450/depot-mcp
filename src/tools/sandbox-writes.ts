import { z } from 'zod';
import type { JsonObject } from '../depot/shape.js';
import type { ToolContext } from '../lib/tool.js';
import { defineWriteTool, type WritePreview } from '../lib/write.js';
import { describeSandbox, parseSandbox, sandboxSchema, type SandboxSummary } from './sandboxes.js';

/** From sandbox.proto: stop lands in finished, kill in cancelled, and failed is final too. */
const TERMINAL_SANDBOX_STATES: ReadonlySet<string> = new Set(['finished', 'cancelled', 'failed']);

export function isTerminalSandboxState(state: string | undefined): boolean {
  return state !== undefined && TERMINAL_SANDBOX_STATES.has(state);
}

const BETA_WRITE_NOTICE =
  'Beta and opt-in twice over: registered only when both DEPOT_MCP_ALLOW_WRITES and DEPOT_MCP_ENABLE_BETA are set, because depot.sandbox.v1 is published as a proto without reference documentation and Depot may change it without notice. Request shape follows the proto as of 2026-09-07 (a SandboxRef under `sandbox`); this server has never invoked it live.';

const sandboxIdField = z
  .string()
  .trim()
  .min(1)
  .describe('The sandbox id, as returned by depot_list_sandboxes or depot_get_sandbox.');

const previewSchema = {
  sandboxId: z.string(),
  status: z.string().optional(),
  terminal: z.boolean(),
  sandbox: sandboxSchema,
};

type SandboxPreview = z.input<z.ZodObject<typeof previewSchema>>;

async function sandboxPreview(
  sandboxId: string,
  context: ToolContext,
  wouldDo: string,
): Promise<WritePreview<SandboxPreview>> {
  const sandbox: SandboxSummary = parseSandbox(await context.api.getSandbox(sandboxId));
  const terminal = isTerminalSandboxState(sandbox.status);
  const lines = [describeSandbox(sandbox)];
  if (sandbox.expiresAt !== undefined) {
    lines.push(`Expires ${sandbox.expiresAt} on its own if left alone.`);
  }
  lines.push(terminal ? `The sandbox is already ${sandbox.status ?? 'finished'}.` : wouldDo);
  return {
    data: { sandboxId: sandbox.sandboxId ?? sandboxId, status: sandbox.status, terminal, sandbox },
    lines,
  };
}

function refuseTerminal(preview: SandboxPreview, verb: string): string | undefined {
  if (preview.terminal) {
    return `Sandbox ${preview.sandboxId} is already ${preview.status ?? 'finished'}; there is nothing to ${verb}. Depot would answer failed_precondition for the same reason.`;
  }
  return undefined;
}

const afterSchema = {
  rpc: z.string(),
  status: z.string().optional(),
  sandbox: sandboxSchema,
};

function afterFromResponse(rpc: string, response: JsonObject, landsIn: string) {
  const sandbox = parseSandbox(response);
  return {
    data: { rpc, status: sandbox.status, sandbox },
    lines: [
      `${rpc} accepted. Depot reports the sandbox as ${sandbox.status ?? 'unknown status'} at read time; it proceeds toward ${landsIn} on its own.`,
      `Check with depot_get_sandbox {"sandboxId":"${sandbox.sandboxId ?? ''}"}.`,
    ],
  };
}

export const stopSandboxTool = defineWriteTool({
  name: 'depot_stop_sandbox',
  title: 'Stop a Depot sandbox gracefully (beta API)',
  description: `Ask a running Depot sandbox to shut down cleanly (StopSandbox). The sandbox gets the chance to flush and exit, and lands in the finished state; its exit code, CPU time, and network usage stay readable through depot_get_sandbox.

Use this when an agent's sandbox is no longer needed and should stop spending compute: work is done, the session is over, or it was left running by mistake. Stopping is idempotent from the user's point of view but not reversible; a stopped sandbox cannot be resumed. For a sandbox that will not respond, depot_kill_sandbox terminates it without waiting.

The call returns as soon as Depot records the request; the status in the response is typically still running. Refuses a sandbox that is already finished, cancelled, or failed. ${BETA_WRITE_NOTICE} After the user confirms the preview, call again with dryRun:false to apply.`,
  inputSchema: { sandboxId: sandboxIdField },
  previewSchema,
  afterSchema,
  destructive: false,
  idempotent: true,
  preview: (input, context) =>
    sandboxPreview(input.sandboxId, context, 'StopSandbox would ask it to shut down cleanly; it lands in finished.'),
  refuse: (preview) => refuseTerminal(preview, 'stop'),
  apply: async (input, context) =>
    afterFromResponse('StopSandbox', await context.api.stopSandbox(input.sandboxId), 'finished'),
});

export const killSandboxTool = defineWriteTool({
  name: 'depot_kill_sandbox',
  title: 'Kill a Depot sandbox (beta API)',
  description: `Terminate a Depot sandbox immediately (KillSandbox), without giving it the chance to finish what it is doing. The sandbox lands in the cancelled state; unflushed work inside it is lost.

Use this for a sandbox that is stuck, runaway, or must stop now: a command that will not return, a process burning compute, something that should not keep running. Prefer depot_stop_sandbox when a clean shutdown is acceptable. Killing is not reversible.

The call is fire-and-forget: Depot records the request and the sandbox proceeds toward cancelled. Refuses a sandbox that is already finished, cancelled, or failed. ${BETA_WRITE_NOTICE} After the user confirms the preview, call again with dryRun:false to apply.`,
  inputSchema: { sandboxId: sandboxIdField },
  previewSchema,
  afterSchema,
  destructive: true,
  idempotent: true,
  preview: (input, context) =>
    sandboxPreview(input.sandboxId, context, 'KillSandbox would terminate it at once; it lands in cancelled and unflushed work is lost.'),
  refuse: (preview) => refuseTerminal(preview, 'kill'),
  apply: async (input, context) =>
    afterFromResponse('KillSandbox', await context.api.killSandbox(input.sandboxId), 'cancelled'),
});
