import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolModule } from '../lib/tool.js';
import { getCiArtifactUrlTool, listCiArtifactsTool } from './ci-artifacts.js';
import { compareCiRunsTool } from './ci-compare.js';
import { auditTrustPoliciesTool, listProjectTokensTool } from './access.js';
import { getCacheSummaryTool } from './cache.js';
import { betaTools } from './beta.js';
import { listCiSecretsTool, listCiVariablesTool } from './ci-config.js';
import { diagnoseCiFailureTool } from './ci-diagnose.js';
import { getCiAttemptTool, getCiJobTool } from './ci-jobs.js';
import { getCiLogsTool } from './ci-logs.js';
import { getCiMetricsTool } from './ci-metrics.js';
import { getCiRunTool, listCiRunsTool } from './ci-runs.js';
import { getCiJobSummaryTool } from './ci-summary.js';
import { getCiWorkflowTool, listCiWorkflowsTool } from './ci-workflows.js';
import { diagnoseBuildTool, listBuildsTool, getBuildTool } from './builds.js';
import { waitForCiRunTool } from './ci-wait.js';
import { getProjectTool, listProjectsTool } from './projects.js';
import { listImagesTool } from './registry.js';
import { getUsageTool, listProjectUsageTool } from './usage.js';
import { whoamiTool } from './whoami.js';
import {
  betaMutatingTools,
  mutatingTools,
  destructiveTools,
  destructiveWritesEnabled,
} from './writes.js';

export { betaMutatingTools, destructiveTools, mutatingTools };

export const readOnlyTools: readonly ToolModule[] = [
  whoamiTool,
  diagnoseCiFailureTool,
  listCiRunsTool,
  getCiRunTool,
  getCiJobTool,
  getCiAttemptTool,
  listCiWorkflowsTool,
  getCiWorkflowTool,
  waitForCiRunTool,
  getCiLogsTool,
  getCiJobSummaryTool,
  getCiMetricsTool,
  listCiArtifactsTool,
  getCiArtifactUrlTool,
  compareCiRunsTool,
  diagnoseBuildTool,
  getBuildTool,
  listBuildsTool,
  listProjectsTool,
  getProjectTool,
  auditTrustPoliciesTool,
  listProjectTokensTool,
  getUsageTool,
  listProjectUsageTool,
  getCacheSummaryTool,
  listImagesTool,
  listCiSecretsTool,
  listCiVariablesTool,
];

export { betaTools };

export interface RegistrationSummary {
  readonly readOnly: string[];
  /** Read-only tools over beta Depot APIs; empty unless DEPOT_MCP_ENABLE_BETA is set. */
  readonly beta: string[];
  /** Every registered write tool, the beta sandbox writes included when both gates are open. */
  /** Reversible writes plus, when both gates are open, the destructive ones. */
  readonly mutating: string[];
  /** Irreversible writes; empty unless DEPOT_MCP_ALLOW_WRITES and DEPOT_MCP_ALLOW_DESTRUCTIVE are both set. */
  readonly destructive: string[];
  readonly writesEnabled: boolean;
  readonly destructiveEnabled: boolean;
  readonly betaEnabled: boolean;
}

export function registerTools(server: McpServer, context: ToolContext): RegistrationSummary {
  for (const tool of readOnlyTools) {
    tool.register(server, context);
  }

  const beta: string[] = [];
  if (context.config.enableBeta) {
    for (const tool of betaTools) {
      tool.register(server, context);
      beta.push(tool.name);
    }
  }

  // The gate. With DEPOT_MCP_ALLOW_WRITES unset the write tools are never registered, so a
  // client cannot list, call, or be talked into calling them. The sandbox writes sit behind
  // the beta gate as well, since their API is beta.
  const mutating: string[] = [];
  if (context.config.allowWrites) {
    for (const tool of mutatingTools) {
      tool.register(server, context);
      mutating.push(tool.name);
    }
    if (context.config.enableBeta) {
      for (const tool of betaMutatingTools) {
        tool.register(server, context);
        mutating.push(tool.name);
      }
    }
  }

  // The second gate. DEPOT_MCP_ALLOW_DESTRUCTIVE on its own registers nothing: an operator who
  // turns writes off must not find deletion still reachable.
  const destructive: string[] = [];
  const destructiveEnabled = destructiveWritesEnabled(context.config);
  if (destructiveEnabled) {
    for (const tool of destructiveTools) {
      tool.register(server, context);
      mutating.push(tool.name);
      destructive.push(tool.name);
    }
  }

  return {
    readOnly: readOnlyTools.map((tool) => tool.name),
    beta,
    mutating,
    destructive,
    writesEnabled: context.config.allowWrites,
    destructiveEnabled,
    betaEnabled: context.config.enableBeta,
  };
}
