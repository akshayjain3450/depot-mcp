#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, DEFAULT_API_URL, loadConfig } from './config.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

const HELP = `${SERVER_NAME} ${SERVER_VERSION}: MCP server for depot.dev, speaking JSON-RPC over stdio. Read-only unless DEPOT_MCP_ALLOW_WRITES is set.

Usage: ${SERVER_NAME} [--help | --version]

Configuration is read from the environment:
  DEPOT_TOKEN              Required. Depot Organization token or \`depot login\` user token.
  DEPOT_ORG_ID             Organization to scope a user token to.
  DEPOT_PROJECT_ID         Default project for build tools.
  DEPOT_API_URL            API endpoint (default ${DEFAULT_API_URL}); must be https except on localhost.
  DEPOT_MCP_MAX_LOG_PAGES  Log pages read per call (positive integer).
  DEPOT_MCP_OUTPUT_BUDGET  Characters of tool output per call (positive integer).
  DEPOT_MCP_ENABLE_BETA    Also register the read-only sandbox and registry tools built on
                           Depot's beta APIs (depot.sandbox.v1, depot.registry.v1beta1).
  DEPOT_MCP_ALLOW_WRITES   Set to 1 to register the reversible write tools (cancel, retry, rerun,
                           dispatch, CI variables, create and update project; sandbox stop and
                           kill with the beta flag). Off by default. Every write defaults to
                           dryRun:true.
  DEPOT_MCP_DISPATCH_ALLOWLIST
                           Comma-separated owner/name:workflow.yml entries that
                           depot_dispatch_ci_workflow may start. Unset: any repository the token sees.
  DEPOT_MCP_ALLOW_DESTRUCTIVE
                           Set to 1, together with DEPOT_MCP_ALLOW_WRITES, to also register the
                           irreversible writes (depot_delete_project). Off by default and no
                           effect on its own. Each needs a confirmation argument naming the target.

See the README for the MCP client configuration and the full list of tools.
`;

/** Handles the informational flags before touching the environment, so they work with no token set. */
function handleFlags(argv: readonly string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return true;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (handleFlags(process.argv.slice(2))) {
    return;
  }

  const config = loadConfig();
  const { server, registration } = createServer({ config });

  // stdout carries the JSON-RPC stream, so every diagnostic must go to stderr.
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} ready on stdio: ${registration.readOnly.length} read-only tool(s), ${registration.beta.length} beta tool(s), ${registration.mutating.length} mutating tool(s), ${registration.destructive.length} of them destructive.`,
  );
  if (registration.betaEnabled) {
    console.error(
      `DEPOT_MCP_ENABLE_BETA is set: ${registration.beta.join(', ')} use Depot APIs that may change without notice.`,
    );
  }
  if (registration.writesEnabled) {
    console.error(
      `DEPOT_MCP_ALLOW_WRITES is set: ${registration.mutating.length} mutating tool(s) registered (${registration.mutating.join(', ')}). Each defaults to dryRun:true and changes nothing until called again with dryRun:false; every applied write is logged here as "[depot-mcp write] ...".`,
    );
    console.error(
      registration.destructiveEnabled
        ? `DEPOT_MCP_ALLOW_DESTRUCTIVE is set: ${registration.destructive.join(', ')} registered. What they delete cannot be restored; each refuses unless its confirmation argument names the target exactly.`
        : 'DEPOT_MCP_ALLOW_DESTRUCTIVE is not set: no destructive tool (depot_delete_project) is registered.',
    );
  }

  let closing = false;
  const shutdown = (reason: string): void => {
    if (closing) {
      return;
    }
    closing = true;
    console.error(`${SERVER_NAME}: ${reason}, shutting down.`);
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`${SERVER_NAME}: error while closing:`, error);
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => shutdown('received SIGINT'));
  process.on('SIGTERM', () => shutdown('received SIGTERM'));
  // The client hanging up is the normal way an MCP server ends; exit rather than linger.
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`${SERVER_NAME}: ${error.message}`);
    process.exit(78); // EX_CONFIG
  }
  console.error(`${SERVER_NAME} failed to start:`, error);
  process.exit(1);
});
