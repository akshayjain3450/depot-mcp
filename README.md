# depot-mcp

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server for [Depot](https://depot.dev). It gives a coding agent Depot's own answer to "why did CI fail?" and "why did this build fail?", plus the run history, cache effectiveness, registry contents, CI configuration, and usage data behind those answers.

**Community project. Not affiliated with, endorsed by, or supported by Depot.**

## Why this exists

Depot ships a genuinely good agent story already — it just isn't MCP. Depot's answer is [Agent Skills](https://github.com/depot/skills), four `SKILL.md` files that teach an agent to drive the `depot` CLI, plus a documented CI API and `llms.txt`. Depot's own post announcing Skills notes two limitations: skills work best in clients that implement the `SKILL.md` convention, and they are "sometimes notorious for not being automatically used by agents."

This server covers the gaps that leaves:

- **Agents without a shell.** Skills require a logged-in `depot` binary on the machine. A tool call does not.
- **Clients that don't read `SKILL.md`.** MCP is client-agnostic.
- **Reliable invocation.** A registered tool with a description is discovered through the protocol rather than hopefully retrieved.
- **A read-only boundary.** A skill cannot stop an agent from running `depot ci rerun`. This server can, and does — see [Security](#security).

The flagship tool is a thin, careful wrapper around something Depot already built and nobody else has: `GetFailureDiagnosis`, a server-side failure analysis that clusters a run's failures by root cause and returns a diagnosis, a suggested fix, and the evidence lines — already bounded, so it fits in a context window. Most of this server's value is exposing that well.

At the time of writing, no MCP server for Depot existed anywhere — not first-party, not in the official registry, not on npm or PyPI.

## Status

- **Read-only.** v1 registers no tool that can change anything. There is no retry, cancel, rerun, dispatch, delete, or token-minting tool.
- **Depot CI is beta**, per Depot's own documentation. The CI tools are the most valuable ones here and also the most likely to shift under you.
- **Not published to npm.** Run it from a clone, as below. The name `depot-mcp` is unclaimed on npm.
- **MCP protocol revision `2025-11-25`.** The current spec revision is `2026-07-28`, but the official TypeScript SDK does not implement it yet; `2025-11-25` is an explicitly supported backward-compatible revision and is what the SDK speaks. The transport layer is one thin file so that bump is a dependency upgrade.

## Requirements

- Node.js 20 or newer.
- A Depot **Organization token** (Depot dashboard → Organization Settings → API Tokens). A user token from `depot login` also works but spans every organization you belong to.
- **Project tokens will not work.** Depot's own scope matrix excludes them from Depot CI and the API entirely.

## Install and configure

### From a clone (works today)

```bash
git clone <your-fork-or-clone-url> depot-mcp
cd depot-mcp
npm install
npm run build
```

Then point your client at `node /absolute/path/to/depot-mcp/dist/index.js`.

**Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows:

```json
{
  "mcpServers": {
    "depot": {
      "command": "node",
      "args": ["/absolute/path/to/depot-mcp/dist/index.js"],
      "env": {
        "DEPOT_TOKEN": "dp_your_organization_token"
      }
    }
  }
}
```

**Claude Code** — either run:

```bash
claude mcp add depot --env DEPOT_TOKEN=dp_your_organization_token \
  -- node /absolute/path/to/depot-mcp/dist/index.js
```

or commit a `.mcp.json` at your repository root to share it with the team:

```json
{
  "mcpServers": {
    "depot": {
      "command": "node",
      "args": ["/absolute/path/to/depot-mcp/dist/index.js"],
      "env": {
        "DEPOT_TOKEN": "dp_your_organization_token"
      }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` for one:

```json
{
  "mcpServers": {
    "depot": {
      "command": "node",
      "args": ["/absolute/path/to/depot-mcp/dist/index.js"],
      "env": {
        "DEPOT_TOKEN": "dp_your_organization_token"
      }
    }
  }
}
```

### Via npx (once published)

If this package is ever published, every block above collapses to the same three lines in any client:

```json
{
  "mcpServers": {
    "depot": {
      "command": "npx",
      "args": ["-y", "depot-mcp"],
      "env": {
        "DEPOT_TOKEN": "dp_your_organization_token"
      }
    }
  }
}
```

### Checking it works

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

Then, from your agent, ask it to call `depot_whoami`. That confirms the token, reports which organizations and projects it can see, and warns about the organization ambiguity described below.

## Configuration

Every setting is an environment variable, set in your client's config JSON.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DEPOT_TOKEN` | **yes** | — | Depot API token. The server refuses to start without it. |
| `DEPOT_ORG_ID` | no | — | Sent as `x-depot-org`. **Set this if your token can see more than one organization** (see below). |
| `DEPOT_PROJECT_ID` | no | — | Default container-build project, so build tools can be called without one. |
| `DEPOT_API_URL` | no | `https://api.depot.dev` | Override the API endpoint. |
| `DEPOT_MCP_MAX_LOG_PAGES` | no | `20` | Cap on log/step pages fetched per tool call, so one call can't walk a gigabyte of logs. |
| `DEPOT_MCP_OUTPUT_BUDGET` | no | `24000` | Hard character ceiling on any single tool result. |
| `DEPOT_MCP_ALLOW_WRITES` | no | `0` | **Reserved for a future version; currently a no-op.** The gate exists so mutating tools can be added later without reworking registration. v1 defines none, so setting this changes nothing — `depot_whoami` will say so. |

### The organization gotcha

This is the single most confusing Depot failure mode, and Depot's own Agent Skill calls it out. A user token spans every organization you belong to. When more than one is visible and `DEPOT_ORG_ID` is unset, requests resolve against one organization and everything in the others reads as **empty rather than as an error**. If a list looks wrongly empty, call `depot_whoami` — it detects exactly this and tells you what to set.

## Tools

All 16 are annotated `readOnlyHint: true` and `destructiveHint: false`.

| Tool | Answers |
| --- | --- |
| **`depot_diagnose_ci_failure`** | **Why did this CI run/workflow/job/attempt fail?** Clustered root causes, AI diagnosis, suggested fix, evidence lines. Start here. |
| **`depot_diagnose_build`** | **Why did this container build fail?** Locates the failing step, returns its error and log tail, plus cache effectiveness. |
| `depot_whoami` | Is my token valid, and what can it see? Diagnoses the organization ambiguity above. |
| `depot_list_ci_runs` | Which runs happened recently, and which failed? Filter by status, repo, SHA, trigger, PR. |
| `depot_get_ci_run` | What is this run's workflow → job → attempt tree, and which node broke? |
| `depot_get_ci_logs` | Bounded raw logs for an attempt: tail by default, `grep`/step/stream filters, forward paging. |
| `depot_get_ci_job_summary` | What did the job publish about itself (the `$GITHUB_STEP_SUMMARY` equivalent)? |
| `depot_get_ci_metrics` | Was this an OOM kill or CPU starvation? CPU/memory for a run, job, or attempt. |
| `depot_list_ci_artifacts` | What did the run upload, and what is its signed download URL? |
| `depot_list_builds` | Recent container builds with duration and cache hit ratio. |
| `depot_list_projects` | Which build projects exist, in which region, on what hardware, with which cache policy? |
| `depot_get_project` | One project's full config plus its OIDC trust policies. |
| `depot_get_usage` | What is driving spend? Build minutes, minutes saved by cache, GitHub Actions runner minutes, storage, sandboxes. |
| `depot_list_images` | What is in this project's registry, with digests and sizes? |
| `depot_list_ci_secrets` | Which CI secrets exist and where do they apply? **Names and scoping only** — Depot never returns secret values. |
| `depot_list_ci_variables` | Which CI variables exist, with values and scoping. Credential-shaped values are redacted (see below). |

Two prompts chain these into common workflows: `diagnose-latest-failure` (find the last failed run → diagnose → propose a fix) and `explain-build-slowness` (builds + usage → is it cache misses or more work?).

### Output is always bounded

Every tool caps its own output and tells the agent when it truncated:

- Log tools page forward into a ring buffer and return the **tail**, since `GetJobAttemptLogs` pages oldest-first with no tail parameter.
- `depot_diagnose_ci_failure` propagates Depot's own `bounds` object as plain-language notes, and distinguishes what **Depot** dropped from what **this server** dropped, so a partial diagnosis never looks complete.
- Every result respects `DEPOT_MCP_OUTPUT_BUDGET`.

## Security

**Read the first point carefully.**

- **Depot has no read-only token scope.** An Organization token that can call `ListRuns` can also call `CancelRun`, `RerunWorkflow`, and `DeleteProject`. Nothing about the credential you hand this server makes it safe. **This server's tool registration is the entire safety boundary** — it is read-only because it defines no mutating tool, not because the token is restricted. Treat `readOnlyHint` as a hint to the client, not as enforcement.
- **Some operations are permanently out of scope**, not merely deferred: `ProjectService/ResetProject` (deletes all cached data — a plausible-sounding "fix" with an irreversible, invisible, expensive blast radius), `CIService/Run` (executes arbitrary workflow content on your infrastructure), token and secret writes (`CreateToken` returns the secret, which would land in a transcript), image and tag deletion, and `ShareBuild` (creates a public URL — data exposure disguised as a read).
- **The token is never logged, echoed, or written to disk.** It is read from the environment only, never printed in errors or in `depot_whoami`. This server does not read `~/.config/depot/depot.yaml`, so it cannot pick up ambient credentials you did not intend to give it.
- **CI variable values are scrubbed.** Depot withholds secret *values* server-side, but returns *variable* values verbatim, and variables get misused as secret storage. Values whose name or content looks like a credential are replaced with a placeholder, and the result reports which rule fired so you still know the variable exists.
- **Create a dedicated Organization token for this server** so you can revoke it independently.
- Depot stores CLI credentials in plaintext at `~/.config/depot/depot.yaml` (mode 0600), not the OS keychain. Relevant if you copy a token from there.

## Limitations

- **Container builds cannot be started through Depot's API at all**, by anyone. Running a build means acquiring an mTLS BuildKit endpoint and transferring the local build context; the `depot` CLI embeds a BuildKit fork to do it. Builds here are observability only. A human runs `depot build`, or CI does.
- **`depot.ci.v1` has reference docs but no published schema** — it is absent from both `depot/proto` and the Buf Schema Registry. There is nothing to generate types from and nothing to diff for breaking changes. Rather than assert a contract nobody publishes, responses are read through tolerant accessors that accept either camelCase or snake_case, handle protobuf's int64-as-string encoding, and strip enum name prefixes. Missing fields degrade to "unknown" instead of crashing.
- **`depot_get_ci_metrics` returns Depot's raw document alongside the fields it recognises**, because Depot documents that these RPCs return CPU and memory summaries without publishing their field names.
- **`depot.ci.v3beta2` is beta in its name.** The secrets and variables tools are the most breakage-prone. Their list filters are undocumented, so filtering happens in this server and the request sent to Depot is empty.
- **No log streaming.** Depot caps concurrent log streams per token *and per organization*, and a careless streaming tool could exhaust that for your whole org, including your real CI. This server polls the unary `GetJobAttemptLogs` instead, which Depot's docs explicitly bless.
- **There is no `wait_for_run_to_finish` tool**, deliberately. Long polls fit badly inside a tool-call timeout. Ask for status again instead; the agent can poll across turns.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint with type-aware rules
npm test            # vitest, no network or Depot account needed
npm run build       # emit dist/
npm run inspect     # build, then open the MCP Inspector
```

Tests drive a real `Client` against a real `McpServer` over the SDK's `InMemoryTransport`, with `fetch` stubbed to return recorded fixtures in `test/fixtures/`. They assert the full round trip: input validation, output-schema conformance, annotations, character budgets, and error translation. The fixtures cover all four `GetFailureDiagnosis` states (`focused_failure`, `grouped_failures`, `over_limit`, `empty`), empty results, and Connect error envelopes.

### Live check against your own Depot organization

```bash
DEPOT_TOKEN=dp_your_organization_token npm run smoke
```

This runs read-only calls only, prints what it found, and reports which checks passed, failed, or were skipped. It skips the failure-diagnosis check if your organization has no failed run to analyse — without one, the flagship tool cannot be exercised.

### Layout

```
src/
  index.ts          entrypoint: config, stdio transport
  server.ts         McpServer construction and instructions
  config.ts         environment resolution, fail-fast validation
  prompts.ts        the two chained workflows
  depot/
    client.ts       fetch against Depot's Connect JSON binding, with retry
    api.ts          typed RPC surface
    errors.ts       Connect error codes -> actionable messages
    shape.ts        tolerant accessors for an unpublished schema
  lib/
    tool.ts         registration, validation, error translation in one place
    budget.ts       character budgets and truncation
    diagnosis.ts    parsing and shaping the GetFailureDiagnosis document
    ci-tree.ts      run -> workflow -> job -> attempt parsing
    ci-target.ts    loose identifier resolution
    redact.ts       credential scrubbing
    build.ts  project.ts  resolve.ts  time.ts
  tools/            one module per tool group; index.ts holds the write gate
research/           the API and design research this was built from
```

`research/` documents the API surface, the MCP design decisions, and the prior-art survey this implementation follows. It is worth reading before changing anything non-obvious.

## License

MIT — see [LICENSE](./LICENSE).

Depot is a trademark of its owner. This project is unaffiliated.
