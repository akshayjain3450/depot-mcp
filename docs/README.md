# Documentation index

Design notes and distribution details for depot-mcp. The README covers installation and usage; this directory holds the reasoning behind the shape of the server.

## Reference

- [`roadmap.md`](./roadmap.md): the 17 tools of today, every Depot RPC not yet exposed with its risk tier, the planned 0.2 read tools and 0.3 write tools, and what is excluded for good.
- [`tokens.md`](./tokens.md): which Depot token kind can call which tool and which Depot service, verified live, and how to obtain each.

## Design and research

- [`../research/mcp-design.md`](../research/mcp-design.md): the design proposal this implementation follows. Tool list, tiers, exclusions, auth and secret handling, the hard parts (log volume, streaming limits, timeouts), testing strategy, stack choice.
- [`../research/depot-api-surface.md`](../research/depot-api-surface.md): the Depot API survey. Which services exist, which are documented, which have published schemas, token scopes, error codes, rate limits.
- [`../research/prior-art.md`](../research/prior-art.md): what already existed (Depot Agent Skills, `llms.txt`, the CI API) and why an MCP server still earns its place.

## Decisions worth knowing before changing code

| Decision | Where | Why |
| --- | --- | --- |
| Read-only, enforced by registration | `src/tools/index.ts` | Depot has no read-only token scope; the tool list is the only boundary. |
| Plain `fetch`, not `@depot/sdk-node` | `src/depot/client.ts` | The SDK does not expose `depot.ci.v1` and hard-wires its base URL at import time. |
| Tolerant accessors instead of generated types | `src/depot/shape.ts` | `depot.ci.v1` has docs but no published schema to generate from. |
| Unary log paging, no streaming | `src/tools/ci-logs.ts` | Depot caps concurrent log streams per organization; a streaming tool could starve real CI. |
| Tail by default, ring buffer | `src/lib/budget.ts`, `src/tools/ci-logs.ts` | `GetJobAttemptLogs` pages oldest-first with no tail parameter. |
| Credential-shaped variable values redacted | `src/lib/redact.ts` | Depot returns variable values verbatim and people misuse variables as secrets. |
| No `wait_for_run` tool | design doc section 6.3 | Long polls fit badly inside a tool call; the agent polls across turns. |
| `@modelcontextprotocol/sdk` 1.x, protocol `2025-11-25` | `package.json`, `src/index.ts` | Built before the move to the v2 packages (`@modelcontextprotocol/server` 2.0.0, spec `2026-07-28`, which also serves `2025-11-25` clients). The migration is planned: nine import sites plus `serveStdio` in `src/index.ts`, with the test harness moving to `@modelcontextprotocol/client`. |

## Distribution files

| File | Consumer | Notes |
| --- | --- | --- |
| `package.json` (`bin`, `files`, `mcpName`, `publishConfig`) | npm, MCP Registry ownership check | `mcpName` must equal `server.json` `name`. |
| `server.json` | Official MCP Registry (`mcp-publisher publish`) | Schema `2025-12-11`. Declares `DEPOT_TOKEN` as `isSecret`. |
| `manifest.json` | Claude Desktop `.mcpb` bundle (`npx @anthropic-ai/mcpb pack`) | `user_config.depot_token` is `sensitive`, so Claude Desktop keeps it in the OS keychain. |
| `.mcp.json.example` | Claude Code project config | Uses `${DEPOT_TOKEN}` expansion so the file is safe to commit. |
| `Dockerfile`, `.dockerignore` | Docker, Docker MCP Catalog | Multi-stage, distroless runtime, no token baked in. |
| `.github/scripts/check-metadata.mjs` | CI | Fails if the versions or names above disagree. |
| `.github/scripts/mcp-smoke.mjs` | CI | Starts `dist/index.js`, performs the handshake, asserts 17 read-only tools. |

Release steps are in [CONTRIBUTING.md](../CONTRIBUTING.md#releasing).
