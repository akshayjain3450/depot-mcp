import type { ToolModule } from '../lib/tool.js';
import { getRegistryImageTool, listRegistryRepositoriesTool } from './registry-beta.js';
import { getSandboxTool, listSandboxesTool } from './sandboxes.js';

/**
 * Read-only tools over Depot APIs that are beta or proto-only (`depot.sandbox.v1`,
 * `depot.registry.v1beta1`). Registered only when DEPOT_MCP_ENABLE_BETA is set, so a client that
 * has not opted in never sees a tool whose upstream contract may shift. Kept apart from
 * `src/tools/index.ts` so `depot_whoami` can name them without importing the registration module.
 */
export const betaTools: readonly ToolModule[] = [
  listSandboxesTool,
  getSandboxTool,
  listRegistryRepositoriesTool,
  getRegistryImageTool,
];
