import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolModule } from '../lib/tool.js';
import { listCiArtifactsTool } from './ci-artifacts.js';
import { listCiSecretsTool, listCiVariablesTool } from './ci-config.js';
import { deleteCiVariableTool, setCiVariableTool } from './ci-variables-write.js';
import { diagnoseCiFailureTool } from './ci-diagnose.js';
import { getCiLogsTool } from './ci-logs.js';
import { getCiMetricsTool } from './ci-metrics.js';
import { getCiRunTool, listCiRunsTool } from './ci-runs.js';
import { getCiJobSummaryTool } from './ci-summary.js';
import { diagnoseBuildTool, listBuildsTool } from './builds.js';
import { getProjectTool, listProjectsTool } from './projects.js';
import { createProjectTool } from './projects-write.js';
import { listImagesTool } from './registry.js';
import { getUsageTool } from './usage.js';
import { whoamiTool } from './whoami.js';

export const readOnlyTools: readonly ToolModule[] = [
  whoamiTool,
  diagnoseCiFailureTool,
  listCiRunsTool,
  getCiRunTool,
  getCiLogsTool,
  getCiJobSummaryTool,
  getCiMetricsTool,
  listCiArtifactsTool,
  diagnoseBuildTool,
  listBuildsTool,
  listProjectsTool,
  getProjectTool,
  getUsageTool,
  listImagesTool,
  listCiSecretsTool,
  listCiVariablesTool,
];

/**
 * Registered only when DEPOT_MCP_ALLOW_WRITES is set, so a client without the flag never sees
 * them. Every entry is built with `defineWriteTool`: dryRun defaults to true, preconditions are
 * checked server-side before any mutating RPC, and each applied write logs one line to stderr.
 * Depot has no read-only token scope, so this gate is the only thing enforcing least privilege.
 */
export const mutatingTools: readonly ToolModule[] = [
  setCiVariableTool,
  deleteCiVariableTool,
  createProjectTool,
];

export interface RegistrationSummary {
  readonly readOnly: string[];
  readonly mutating: string[];
  readonly writesEnabled: boolean;
}

export function registerTools(server: McpServer, context: ToolContext): RegistrationSummary {
  for (const tool of readOnlyTools) {
    tool.register(server, context);
  }

  const mutating: string[] = [];
  if (context.config.allowWrites) {
    for (const tool of mutatingTools) {
      tool.register(server, context);
      mutating.push(tool.name);
    }
  }

  return {
    readOnly: readOnlyTools.map((tool) => tool.name),
    mutating,
    writesEnabled: context.config.allowWrites,
  };
}
