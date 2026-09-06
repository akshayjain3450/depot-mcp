import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolModule } from '../lib/tool.js';
import { listCiArtifactsTool } from './ci-artifacts.js';
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
import { mutatingTools } from './writes.js';

export { mutatingTools };

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

export interface RegistrationSummary {
  readonly readOnly: string[];
  readonly mutating: string[];
  readonly writesEnabled: boolean;
}

export function registerTools(server: McpServer, context: ToolContext): RegistrationSummary {
  for (const tool of readOnlyTools) {
    tool.register(server, context);
  }

  // The gate. With DEPOT_MCP_ALLOW_WRITES unset the write tools are never registered, so a
  // client cannot list, call, or be talked into calling them.
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
