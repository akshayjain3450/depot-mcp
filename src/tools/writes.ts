import type { ToolModule } from '../lib/tool.js';
import {
  cancelCiJobTool,
  cancelCiRunTool,
  rerunCiWorkflowTool,
  retryCiFailedJobsTool,
  retryCiJobTool,
} from './ci-writes.js';

/**
 * Every tool that can change something in Depot. Registered only when DEPOT_MCP_ALLOW_WRITES is
 * set; with the flag unset, tools/list never shows them. Depot has no read-only token scope, so
 * this list and the gate around it are the only thing enforcing least privilege.
 *
 * Kept apart from index.ts so depot_whoami can report the count without a circular import.
 */
export const mutatingTools: readonly ToolModule[] = [
  cancelCiRunTool,
  cancelCiJobTool,
  retryCiFailedJobsTool,
  retryCiJobTool,
  rerunCiWorkflowTool,
];
