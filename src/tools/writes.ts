import { deleteCiVariableTool, setCiVariableTool } from './ci-variables-write.js';
import { deleteProjectTool, updateProjectTool } from './projects-admin.js';
import { createProjectTool } from './projects-write.js';
import type { ToolModule } from '../lib/tool.js';
import {
  cancelCiJobTool,
  cancelCiRunTool,
  rerunCiWorkflowTool,
  retryCiFailedJobsTool,
  retryCiJobTool,
} from './ci-writes.js';

/**
 * Every reversible tool that can change something in Depot. Registered only when
 * DEPOT_MCP_ALLOW_WRITES is set; with the flag unset, tools/list never shows them. Depot has no
 * read-only token scope, so this list and the gate around it are the only thing enforcing least
 * privilege.
 *
 * Kept apart from index.ts so depot_whoami can report the count without a circular import.
 */
export const mutatingTools: readonly ToolModule[] = [
  cancelCiRunTool,
  cancelCiJobTool,
  retryCiFailedJobsTool,
  retryCiJobTool,
  rerunCiWorkflowTool,
  setCiVariableTool,
  deleteCiVariableTool,
  createProjectTool,
  updateProjectTool,
];

/**
 * Writes that cannot be undone. Behind a second gate, DEPOT_MCP_ALLOW_DESTRUCTIVE, which only
 * counts when DEPOT_MCP_ALLOW_WRITES is set too; each also demands a confirmation argument that
 * names the thing destroyed.
 */
export const destructiveTools: readonly ToolModule[] = [deleteProjectTool];

/** Whether the destructive tools are registered: both gates, never the second alone. */
export function destructiveWritesEnabled(config: {
  readonly allowWrites: boolean;
  readonly allowDestructive: boolean;
}): boolean {
  return config.allowWrites && config.allowDestructive;
}
