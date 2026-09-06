import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolModule } from '../lib/tool.js';
import { listCiArtifactsTool } from './ci-artifacts.js';
import { compareCiRunsTool } from './ci-compare.js';
import { listCiSecretsTool, listCiVariablesTool } from './ci-config.js';
import { diagnoseCiFailureTool } from './ci-diagnose.js';
import { getCiLogsTool } from './ci-logs.js';
import { getCiMetricsTool } from './ci-metrics.js';
import { getCiRunTool, listCiRunsTool } from './ci-runs.js';
import { getCiJobSummaryTool } from './ci-summary.js';
import { diagnoseBuildTool, listBuildsTool } from './builds.js';
import { getProjectTool, listProjectsTool } from './projects.js';
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
  compareCiRunsTool,
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
 * Empty by design. This version of the server is read-only; the list and the DEPOT_MCP_ALLOW_WRITES
 * gate around it exist so mutating tools can be added later without reworking registration.
 * Depot has no read-only token scope, so this gate is the only thing enforcing least privilege.
 */
export const mutatingTools: readonly ToolModule[] = [];

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
