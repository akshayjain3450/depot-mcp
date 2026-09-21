# Plan: 0.2.2, 0.3.0, 0.4.0

Compiled 2026-09-17 from three live research passes, dates rebased 2026-09-21. This is the
resume point: it records what changed outside this repository, what that means for the tool
surface, and the order the remaining work should ship in.

The same material is published as a readable chart at
<https://claude.ai/artifact/B8WFqH9Q2a8ePZ46pvAjBy> (private to the maintainer).

## State at the time of writing

- `main` is at 0.2.1, published on npm and listed in the MCP registry. Nothing is in flight.
- PR #37 removed the README merge residue and corrected "read-only" to "read-only by default"
  across the README, package metadata, the Docker label, the server instructions, `SECURITY.md`
  and `CONTRIBUTING.md`. npm and the registry still show the old description until the next
  publish, because both read the metadata that shipped with 0.2.1.
- The trial organization ("Akshay", `kdqcc46clx`, repo `akshayjain3450/depot-ci-lab`) still
  exists, but every token and project in it was deleted after 0.2.1. **A live apply run needs a
  fresh Organization token in `.env` before 0.3.0 can be verified.**

## What changed at Depot since the research was written

Sources: [depot.dev/changelog](https://depot.dev/changelog), commit
[`d3629e2`](https://github.com/depot/proto/commit/d3629e2) in `depot/proto`,
[depot/cli releases](https://github.com/depot/cli/releases), [depot/skills](https://github.com/depot/skills).

| Date | Change | Effect here |
| --- | --- | --- |
| 2026-09-08 | Project configuration contract published. `CreateProject` now returns the existing active project when the name already exists | `depot_create_project` refuses duplicates and its description says "Depot permits duplicate names". Verify live, then rewrite the refusal and the wording |
| 2026-09-08 | Projects gained `buildTimeoutMinutes` and `maxConcurrentBuilds` on create, update and get | Not shown by the read tools; `depot_update_project` cannot set or clear them. Clearing uses a nullable int wrapper whose JSON encoding must be checked before use |
| 2026-09-08 | New `GetRegistryRetentionPolicy` and `UpdateRegistryRetentionPolicy` on `ProjectService` | Read folds into `depot_get_project`; update is a reversible write behind the flag |
| 2026-09-08 | New `ResetProjectMachines`: terminates builder machines, keeps the cache | Destroys nothing, so the `ResetProject` exclusion does not cover it. Candidate write |
| 2026-09-08 | New `UpdateTrustPolicy` (toggle public pull requests) | Stays excluded: trust policy writes grant access |
| 2026-09-08 | `CachePolicy.keepBytes` deprecated; `keepDays` bounded 1..30, `keepGb` 25..1000 | The server already sends the new fields. The update dry run could reject out-of-range values before Depot does |
| 2026-09-08 | `ListTrustPolicies` paginates and takes a provider filter | Already handled: `src/tools/projects-admin.ts` follows `nextPageToken` |
| 2026-08-21 | Depot CI can run on Origin, Cursor's git host. `Forge` enum with `FORGE_ORIGIN` | Run and workflow output assumes GitHub in its wording; Origin runs would be mislabelled |
| 2026-08-19 | Depot CI no longer auto-cancels an earlier pull request run when new commits arrive | The `triage-failures-today` prompt explains cancelled duplicates under the old behaviour |
| 2026-09-16 | CLI v2.102.8, the only CLI release in the window | No new subcommands or flags |
| ongoing | `github.com/depot/api` now returns 404; public protos live in `depot/proto` | No link in this repository points at the old path. Nothing to fix |

Unchanged: every Depot CI proto since 2026-08-21, the `ci.v3beta2` secrets and variables API
since 2026-08-20, and the sandbox API since 2026-06-17. No CI tool's request shape is stale.
Depot still ships no MCP server, and no other depot.dev MCP server exists on npm, PyPI or the
MCP registry as of 2026-09-17.

## What changed in the MCP ecosystem

Sources: the [2026-07-28 spec changelog](https://modelcontextprotocol.io/specification/latest/changelog),
the [SDK v2 migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md),
[Claude Code tool search](https://code.claude.com/docs/en/agent-sdk/tool-search),
[Codex PR #29486](https://github.com/openai/codex/pull/29486),
[Cursor dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery),
[VS Code agent tools](https://code.visualstudio.com/docs/copilot/agents/agent-tools).

- **Protocol 2026-07-28.** Sessions and the `initialize` handshake are gone, every request is
  self-describing, `server/discover` is mandatory, and list results carry cache hints. Roots,
  sampling and logging are deprecated with removal no earlier than 2027-07-28. This server uses
  none of the deprecated features.
- **SDK v2** (`@modelcontextprotocol/server` 2.0.0) serves both protocol eras from one codebase
  through a legacy shim, and ships a codemod. SDK 1.x keeps getting fixes until at least
  January 2027, so this is planned work, not an emergency.
- **Tool search changes the tool-count calculus.** Claude Code, Codex and Cursor now withhold
  tool definitions and load them by keyword search. VS Code caps a request at 128 tools.
  45 tools is inside every client's working range, so consolidation is not needed; keyword-rich
  names and descriptions are what pays now.
- **Vendors ship a skill beside the server** (Stripe, Cloudflare, Datadog, Notion). Depot's own
  skills repository does not know this server exists.
- **Hosted transport still needs OAuth.** stdio remains first-class and covers Claude Code,
  Claude Desktop, Cursor, VS Code, Codex and Gemini CLI. It cannot reach claude.ai web or
  mobile, ChatGPT, or the Claude API connector. See "Parked" below for why that stays parked.

## Releases

### 0.2.2 — documentation and release automation (1.5 days)

1. README configuration table lists `DEPOT_MCP_ALLOW_WRITES` three times, one of them saying
   "reserved for a future version; currently a no-op". Keep one row. *(done in this branch)*
2. README limitations claim there is no wait tool, contradicting `depot_wait_for_ci_run`.
   *(done in this branch)*
3. `docs/roadmap.md` says no mutating RPC has been called and that two write helpers exist.
   Both were true on 2026-09-06 and are false now. *(done in this branch)*
4. Dated addenda on both research files. *(done in this branch)*
5. Release workflow: publish the MCP registry entry over GitHub OIDC instead of printing a
   manual reminder, create the GitHub release with notes from the changelog, and skip cleanly
   when the version is already on npm. Model it on
   [mcp-modal's publish workflow](https://github.com/george-bobby/mcp-modal/blob/main/.github/workflows/publish.yml),
   which does all three in one file. **(0.7 days, not started)**
6. Optional: a script that bumps `package.json`, `server.json`, `manifest.json` and the
   changelog together, so a release is one command plus a tag.

### 0.3.0 — Depot contract catch-up (5 days)

Needs a fresh trial-organization token before the apply run.

| Task | Effort |
| --- | --- |
| Verify `CreateProject` duplicate-name behaviour live, then rewrite the refusal and description in `src/tools/projects-write.ts` | 0.5 d |
| Surface `buildTimeoutMinutes` and `maxConcurrentBuilds` in get, list, create and update; check the nullable int JSON encoding before supporting "clear" | 1 d |
| Registry retention policy: read into `depot_get_project`, update as a new write tool | 1 d |
| Origin-aware run and workflow output, so a non-GitHub forge is not mislabelled | 0.5 d |
| Cache policy bounds in the update dry run; correct the pull-request cancellation wording in the triage prompt | 0.5 d |
| Optional: `ResetProjectMachines` write, and secret/variable attribute listing | 1 d |
| `npm run verify`, `npm run verify:apply`, changelog, release | 0.5 d |

### 0.4.0 — MCP catch-up (5.5 days)

| Task | Effort |
| --- | --- |
| SDK v2 migration: run the codemod, fix the seven SDK-importing files, move to `serveStdio`, rename `McpError` to `ProtocolError`, set cache hints, keep `tools/list` order deterministic | 2.5 d |
| Tool-search pass over every tool and argument description, since descriptions are what gets searched | 1 d |
| `SKILL.md` in this repository, plus a pull request to `depot/skills` referencing the server | 1 d |
| Per-tool result size hints on the log and artifact tools; audit annotations against ChatGPT's rules in case the server is ever hosted | 0.5 d |
| Claude Code session test, a Cursor or VS Code smoke test, changelog, release | 0.5 d |

## ETA

Counted from Monday 2026-09-21. "Side project" assumes about two focused days a week.

| Release | Effort | Cumulative | Full time | Side project |
| --- | --- | --- | --- | --- |
| 0.2.2 | 1.5 d | 1.5 d | Tue 2026-09-22 | Sun 2026-09-27 |
| 0.3.0 | 5 d | 6.5 d | Tue 2026-09-29 | Sun 2026-10-11 |
| 0.4.0 | 5.5 d | 12 d | Wed 2026-10-07 | Sun 2026-11-01 |

Every estimate includes this project's release rule: a green `npm run verify` for each token
kind, one `npm run verify:apply` against the trial organization, and a human Claude Code
session test from `docs/verification.md`.

The order matters. Documentation ships first so the announcement does not point at a README
that contradicts itself. The Depot catch-up goes before the SDK migration because it changes
tool behaviour and is easier to verify on the SDK the verification script already runs on. The
SDK migration goes last so its session test exercises everything above it.

## Parked

- **Tasks extension** for `depot_wait_for_ci_run` and dispatch, about 2 days. The extension
  names CI pipelines as its target case, but no client on the compatibility matrix supports it
  yet. Revisit when one does.
- **Hosted Streamable HTTP endpoint**, 5 days or more. Blocked on Depot, not on effort. A hosted
  server needs a Depot credential per user, and Depot offers no OAuth to third-party
  applications: its "Login with Google and Microsoft" signs people into Depot's own dashboard,
  and its OIDC trust relationships mint tokens with project-token permissions, which cannot call
  the CI API at all. The only way to fill that gap today is to store other people's Organization
  tokens, which cannot be scoped read-only. Revisit only if Depot ships OAuth with scopes.
- **`depot_list_test_results`**, about 1.5 days. Requires shelling out to the `depot` binary
  behind a new `DEPOT_MCP_USE_CLI` opt-in. The open question is whether this server should ever
  depend on the CLI being installed.

## Open questions for the maintainer

1. Should the always-on ceiling of 30 tools be relaxed now that the three main clients defer
   tool definitions? Clients without tool search still pay for every schema.
2. Should `ResetProjectMachines` ship as a write tool, given `ResetProject` is permanently
   excluded and the two sound alike to a model?
3. Should this server ever shell out to the `depot` CLI, which is the only route to test results?

## How to resume

1. `git pull`, then read this file and `docs/roadmap.md`.
2. For anything in 0.3.0, ask for a fresh Organization token for the trial organization and put
   it in `.env`; the old ones were deleted after 0.2.1.
3. `npm ci && npm run verify` to confirm the baseline is still green before changing anything.
