#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, loadConfig } from './config.js';
import { createServer, SERVER_NAME, SERVER_VERSION } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, registration } = createServer({ config });

  // stdout carries the JSON-RPC stream, so every diagnostic must go to stderr.
  console.error(
    `${SERVER_NAME} ${SERVER_VERSION} ready on stdio — ${registration.readOnly.length} read-only tool(s), ${registration.mutating.length} mutating tool(s).`,
  );
  if (registration.writesEnabled) {
    console.error(
      'DEPOT_MCP_ALLOW_WRITES is set, but this version ships no mutating tools, so it has no effect.',
    );
  }

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
