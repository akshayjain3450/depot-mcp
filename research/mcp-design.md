# Depot MCP server — fit assessment and proposed design

Research date: **2026-09-04**. All MCP versions, protocol revisions and SDK APIs below were verified live against modelcontextprotocol.io, the npm registry, and by unpacking and grepping the published `@modelcontextprotocol/server@2.0.0` and `@modelcontextprotocol/client@2.0.0` tarballs. Depot facts reference the companion report, [`depot-api-surface.md`](./depot-api-surface.md).

## 1. Verdict up front

**Feasible, and unusually cleanly.** Depot's CI API is public, documented, and has a plain-JSON-over-HTTP-POST binding, so the server can be a thin `fetch` wrapper with no protobuf toolchain, no gRPC, no Docker on the host, and no CLI dependency for the read-only core.

Better than that: Depot already ships `GetFailureDiagnosis`, a server-side bounded failure analysis that returns clustered failures, an AI diagnosis, a suggested fix, the relevant log lines, and the *next call to make*. The single highest-value agent tool — "why did my build fail" — is one RPC, and Depot has already solved the context-window problem for us server-side.

The one thing that is genuinely not wrappable is **running a container build**. See §6.1.

## 2. Current MCP state (verified 2026-09-04)

### 2.1 Protocol revision, and the package rename that hides the current SDK

| | Value | Source |
| --- | --- | --- |
| **Current spec revision** | **`2026-07-28`** | [modelcontextprotocol.io/specification/versioning](https://modelcontextprotocol.io/specification/versioning) |
| Previous revisions | `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07` | ibid. |
| **Current SDK** | **`@modelcontextprotocol/server@2.0.0`**, published **2026-07-28** | npm |
| Legacy SDK | `@modelcontextprotocol/sdk@1.30.0`, published 2026-07-27, tops out at `2025-11-25` | npm |

`2026-07-28` is a **structural change** to how versioning works, and it is not something training data will contain:

- Every request now declares its version via a `_meta` key `io.modelcontextprotocol/protocolVersion`, and the server accepts or rejects **each request independently**. On Streamable HTTP the same value also travels in an `MCP-Protocol-Version` header.
- There is a new **mandatory `server/discover` RPC** returning supported protocol versions, capabilities and identity in one round trip. Calling it is optional for clients.
- **The `initialize` handshake and protocol-level sessions are gone.** MCP is now stateless; `Mcp-Session-Id` is removed, and list results no longer vary per connection. Servers that need cross-call state mint explicit handles and pass them as ordinary tool arguments.
- Version mismatch produces an `UnsupportedProtocolVersionError` listing supported versions, which the client can retry against.
- There is a formal feature lifecycle now: features marked Deprecated must remain for **at least twelve months** before removal, and there is a [deprecated-features registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md).

**The `@modelcontextprotocol/sdk` package is now the legacy v1 line.** The current SDK was split into `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, both at **2.0.0**, published on the spec release date. This is easy to miss: `npm view @modelcontextprotocol/sdk version` returns `1.30.0` and the package is not marked deprecated, so checking only that name gives the false impression that the SDK trails the spec. It does not — it was renamed.

I verified v2 implements the new revision by unpacking the published tarball and grepping the bundles: `server/discover` (146 hits), `subscriptions/listen` (156), `resultType` (226), `input_required` (238), and both `2026-07-28` and `2025-11-25` as protocol version literals.

Practical consequence: **build against `@modelcontextprotocol/server@2` and target `2026-07-28`.** Both `serveStdio` and `createMcpHandler` serve legacy clients by default (`legacy: 'stateless'`), so one server factory speaks the current revision *and* every handshake-era client with no extra work. Backward compatibility is free, which removes the reason to deliberately target the older revision.

### 2.2 TypeScript SDK

The v2 line, all published **2026-07-28**:

| Package | Version | Role |
| --- | --- | --- |
| `@modelcontextprotocol/server` | **2.0.0** | server — what we use |
| `@modelcontextprotocol/client` | 2.0.0 | client — dev dependency, for tests |
| `@modelcontextprotocol/core` | 2.0.0 | shared internals, pulled in transitively |
| `@modelcontextprotocol/node`, `/express`, `/fastify`, `/hono` | 2.0.0 | optional HTTP host adapters |

Dependencies of `@modelcontextprotocol/server@2.0.0` are refreshingly small — `zod ^4.2.0` and `@modelcontextprotocol/core@2.0.0`, `engines: node >=20`. Compare the v1 line, which bundled Express 5, Hono, `jose`, `pkce-challenge`, `ajv` and more into every install. **Zod 4 is a direct dependency, not a peer**, so the peer-range friction of the 1.x era is gone; tool and prompt schemas also accept any [Standard Schema](https://standardschema.dev/) library or raw JSON Schema. The tarball ships both ESM and CJS, plus Workers/browser shims.

**Idiomatic server definition** is `McpServer` + `registerTool`, with the transport owning a *factory* rather than an instance — because the protocol is stateless, the SDK constructs a fresh server per connection:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

function createServer(): McpServer {
  const server = new McpServer({ name: 'depot', version: '0.1.0' });

  server.registerTool(
    'depot_diagnose_failure',
    {
      title: 'Diagnose a failed Depot run',
      description: 'Explain why a Depot CI run failed, with the relevant log lines.',
      inputSchema: z.object({ runId: z.string().describe('Depot run ID') }),
      outputSchema: DiagnosisOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ runId }) => {
      const output = await diagnose(runId);
      return { content: [{ type: 'text', text: renderDiagnosis(output) }], structuredContent: output };
    },
  );

  return server;
}

void serveStdio(createServer);
```

`serveStdio(factory)` replaces the v1 `new StdioServerTransport()` + `server.connect(transport)` wiring, and `registerTool` replaces `tool()`. A v1→v2 codemod ships with the SDK.

Transports: **stdio** via `serveStdio` (active, what we want), **Streamable HTTP** via `createMcpHandler` plus the optional framework adapters, and **HTTP+SSE** which has been deprecated since `2025-03-26` and should be ignored. Standard stdio discipline applies and is worth restating because it bites everyone once: **stdout is the protocol channel, so all logging goes to stderr.** A stray `console.log` corrupts the JSON-RPC stream.

### 2.3 Feature support, and what `2026-07-28` deprecated

| Feature | Status | What it means for us |
| --- | --- | --- |
| Tool annotations | Active | `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Declare on every tool |
| Structured output | Active | `outputSchema` + `structuredContent`; validated server-side before the result leaves. `structuredContent` may now be any JSON value, not just an object |
| Progress notifications | Active | Our main defence against idle timeouts — see §6.3 |
| Resource subscriptions | Active, reshaped | `resources/subscribe` is replaced by an opt-in `subscriptions/listen` stream. Nothing arrives unsolicited |
| Elicitation | Active, **inverted** | No longer a server push. The handler *returns* an `input_required` result and the client re-calls the tool with `inputResponses` |
| **Sampling** | **Deprecated** | Migrate to calling an LLM provider directly. Do not build on it |
| **Roots** | **Deprecated** | Pass paths as tool parameters or server config instead |
| **MCP Logging** | **Deprecated** | Use stderr for stdio, OpenTelemetry for observability |

Deprecations are per the [official registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md) (SEP-2577), all deprecated in `2026-07-28` with earliest removal in the first revision released on or after **2027-07-28**. Nothing has been removed yet, so all three still work — but none should appear in a new design. This is convenient for us: the design below uses none of them.

**Elicitation's redesign matters if we ever want a confirmation prompt.** Under Multi Round-Trip Requests (MRTR, SEP-2322) the handler returns `inputRequired({ inputRequests: { confirm: inputRequired.elicit({...}) } })`, the client collects the answer and **retries the original call** with `inputResponses`; the handler reads it back with `acceptedContent(...)`. Handlers must therefore be write-once — read every answer first, then request only what is still missing — because `inputResponses` carries only the latest round. Cross-round state goes in `requestState`, an opaque attacker-controlled string that should be signed with `createRequestStateCodec` (HMAC-SHA256). A legacy shim converts this into real `elicitation/create` pushes for pre-2026 clients automatically, so one handler serves every client. The recommendation stands regardless: **keep elicitation off the critical path** and gate destructive operations with an explicit config flag instead (§5).

**Annotation enforcement is real but uneven, and now verified per client:**

- **Claude Desktop / claude.ai** honour them. Anthropic's own connector review criteria make `readOnlyHint`, `destructiveHint` and `title` a pass/fail submission requirement, and they drive auto-approval: `readOnlyHint: true` may auto-approve, `destructiveHint: true` forces a confirmation dialog.
- **Claude Code does not.** It reads only its own `_meta` fields and prompts identically for every MCP tool call, with several open tracking issues. Users work around it with `permissions.allow` entries.
- **Cursor** documents approval via Run Modes and allowlists, with no mention of `readOnlyHint`.

Declare them anyway — they are nearly free and required for directory submission — but the conclusion is unchanged and important: **annotations are not a security boundary.** The server's own read-only-by-default posture is (§5).

### 2.4 Higher-level frameworks — recommendation: don't

The decisive filter is now simply **which SDK line a framework depends on**, since anything still on `@modelcontextprotocol/sdk@1.x` cannot speak `2026-07-28`. I checked each package's manifest directly:

| Package | Version | Last publish | SDK dependency | Verdict |
| --- | --- | --- | --- | --- |
| `@modelcontextprotocol/server` | **2.0.0** | 2026-07-28 | — | **Use this.** Official, current revision, `McpServer` is already ergonomic |
| `fastmcp` (TS, punkpeye) | 4.20.0 | 2026-09-04 | `@modelcontextprotocol/sdk ^1.24.3` | **Protocol-stale.** Genuinely the most active third-party project — published *today* — but pinned to the legacy v1 line, so no `server/discover`, no statelessness, no MRTR. Excellent library, wrong protocol generation |
| `xmcp` | 1.1.3 | 2026-09-03 | `server`/`client ^2.0.0` | **The one credible framework option.** v2-ready and active. File-based tool routing; more value for HTTP-deployed servers than a stdio one |
| `mcp-handler` (Vercel) | 2.1.1 | 2026-08-13 | `server ^2.0.0`, `next >=13` | v2-ready but Next.js-only. Supersedes `@vercel/mcp-adapter`. Not applicable |
| `mcp-framework` | 0.2.22 | 2026-04-16 | Zod 3 | ~5 months stale, still pre-1.0. Avoid |
| Python `fastmcp` 4.x / official `mcp` 2.1.1 | — | 2026-09-02 / 2026-08-25 | — | Both on current lines and ergonomically ahead of TS, but wrong language here: the value is in JSON shaping and Depot's ecosystem is TypeScript-first (`@depot/sdk-node`, all the GH Actions) |

The ecosystem has **not** converged on a higher-level TypeScript standard, and v2 absorbed most of what the wrappers existed to provide: schema inference via Standard Schema, factory-based transports, `createMcpHandler` for testing, first-party framework adapters, and automatic dual-era backward compatibility. For a server of this size — roughly 15 tools, one auth header, one base URL — the raw SDK is less code than learning a framework's conventions, and a framework can now only *lag* the spec.

### 2.5 Distribution (verified)

- **The official MCP Registry exists and is in preview**, with its API **frozen at v0.1** since 2025-10-24 to let integrators build against it. GA has not landed. Backed by Anthropic, GitHub, PulseMCP and Microsoft. It is explicitly *not* meant to be consumed directly by host apps — hosts consume downstream marketplaces that implement its OpenAPI spec.
- Publishing uses a `server.json` (current schema `static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`) and the `mcp-publisher` CLI, latest release **v1.8.1** (2026-08-06), with `init`, `login`, `logout`, `publish`, `status`, `validate`. Lifecycle statuses: `active`, `deprecated`, `deleted`. Note that `server.json` declares secrets structurally via `environmentVariables` with `isSecret: true` — the closest thing to a cross-client secrets convention, and where `DEPOT_TOKEN` should be declared.
- **npm packages prove ownership by declaring `mcpName` in `package.json`.** That is the single extra field needed to be registry-publishable.
- Supported package types include `npm`, `pypi`, `nuget`, `oci`, `cargo`, and **`mcpb`**.
- **MCPB** (renamed from DXT in September 2025; tooling is `@anthropic-ai/mcpb`, **2.1.2**, 2026-06-04) is a ZIP containing a local server plus `manifest.json`, attached to a GitHub/GitLab release, referenced in `server.json` with `registryType: "mcpb"`, the release URL as `identifier`, `transport: {type: "stdio"}`, and a mandatory `fileSha256`. The registry does not validate the hash but **clients do** before installing. The URL must contain the string `"mcp"`. Claude Desktop supports one-click `.mcpb` install, and a `user_config` block in the manifest makes it auto-generate a settings UI with sensitive-value handling — a materially better token-entry story than hand-edited JSON. Anthropic's docs now position MCPB as secondary to remote servers for directory listing, so treat it as a later addition rather than a launch requirement.
- **MCP Inspector** is at `@modelcontextprotocol/inspector@2.5.0`, published 2026-09-02 — actively maintained, run via `npx @modelcontextprotocol/inspector <command>`.

## 3. Design principles for this server

The temptation is to mirror ~70 RPCs into ~70 tools. That is the wrong build. Depot's API is shaped for a CLI and a dashboard; an agent needs a different shape.

1. **One tool per *question*, not per RPC.** "Why did this fail?" beats `GetRun` + `GetRunStatus` + `GetJob` + `GetJobAttemptLogs` and the agent having to know the hierarchy.
2. **Accept loose identifiers.** Depot's own API already does this (`GetJobAttemptLogs` takes `attemptId` *or* `jobId`), and its CLI resolves run → job → latest attempt. Every tool should accept a run, workflow, job or attempt ID and resolve internally. Agents will paste whatever ID the user gave them.
3. **Budget output, always.** Every tool has a hard character cap and tells the agent when it truncated and how to get more. Never let a raw log page reach the model unbounded.
4. **Return `structuredContent` plus a short text summary.** The text is what the model reads by default; the structure is there when it needs a field.
5. **Read-only by default, writes opt-in.** Depot tokens have no read-only scope (§5), so the server *is* the safety boundary.
6. **Resolve org context eagerly and cache it.** The `x-depot-org` ambiguity is the top confusing failure mode for multi-org users, and Depot's own Skill calls it out.

## 4. Proposed tool surface

Naming: `depot_<verb>_<noun>`. All tools return `{ content: [{type:'text', ...}], structuredContent: {...} }` with an `outputSchema`.

### Tier 0 — orientation (read-only, always on)

| Tool | Description | Input | Output | Backed by |
| --- | --- | --- | --- | --- |
| `depot_whoami` | Verify the token and resolve which organizations and projects it can see. Call this first when anything returns empty. | `{}` | `{orgs:[{orgId,name}], activeOrgId, tokenSource, projectCount}` | `core.v1.OrganizationService/ListOrganizations` + `ProjectService/ListProjects` |

Small but load-bearing: it turns "why is my list empty" from a dead end into one call. `readOnlyHint: true, idempotentHint: true`.

### Tier 1 — CI diagnosis (read-only, the core value)

| Tool | Description | Input | Output | Backed by |
| --- | --- | --- | --- | --- |
| **`depot_diagnose_ci_failure`** | **Explain why a CI run/workflow/job/attempt failed, with clustered root causes, suggested fixes and the exact evidence lines.** | `{id, targetType?}` | `{state, target, context, failureGroups:[{errorMessage,count,diagnosis,possibleFix,evidence[],attempts[]}], narrowerTargets[], nextSteps[], truncated, aiDisclosure}` | `ci.v1.CIService/GetFailureDiagnosis` |
| `depot_list_ci_runs` | List recent CI runs, filterable by status, repo, SHA, trigger or PR. | `{status?[], repo?, sha?, trigger?, pr?, limit?=20}` | `{runs:[{runId,repo,ref,sha,trigger,status,createdAt,durationSeconds}], nextPageToken?}` | `CIService/ListRuns` |
| `depot_get_ci_run` | Show one run's workflow → job → attempt tree with statuses and the IDs needed for drill-down. | `{runId, failedOnly?=false}` | `{run{...}, workflows:[{workflowId,name,status,jobs:[{jobId,key,status,conclusion,attempts:[{attemptId,attempt,status}]}]}]}` | `CIService/GetRun` + `GetRunStatus` |
| `depot_get_ci_logs` | Fetch bounded logs for a job attempt — tail by default, with optional pattern filter. | `{id, tailLines?=200, grep?, stepKey?, includeTimestamps?=false, pageToken?}` | `{lines:[{stepKey,stream,lineNumber,timestamp,body}], totalReturned, truncated, nextPageToken?, hint?}` | `CIService/GetJobAttemptLogs` (unary, paged) |
| `depot_get_ci_job_summary` | Read a job's authored step-summary markdown. | `{jobId?, attemptId?}` | `{markdown, truncated}` | `CIService/GetJobSummary` |
| `depot_get_ci_metrics` | CPU and memory for a run, job, or attempt — for diagnosing OOM kills and CPU starvation. | `{id, level?}` | `{level, peakMemoryBytes, memoryLimitBytes?, avgCpuPercent, peakCpuPercent, samples?, capturedAt, likelyOom?}` | `GetRunMetrics` / `GetJobMetrics` / `GetJobAttemptMetrics` |
| `depot_list_ci_artifacts` | List artifacts for a run and optionally get a signed download URL. | `{runId, workflowId?, jobId?, attemptId?, withDownloadUrl?=false}` | `{artifacts:[{artifactId,name,sizeBytes,url?}]}` | `ListArtifacts` (+ `GetArtifactDownloadURL`) |

`depot_diagnose_ci_failure` is the reason to build this server. Depot has already done the hard part: it clusters failures by fingerprint, caps output with an explicit `bounds` object, marks `truncated`/`omitted*Count`, and returns `nextCommands` with a `kind` (`logs`/`summary`/`diagnose_workflow`/`diagnose_job`) and ready-made `argv`. The wrapper's job is to translate `nextCommands` into *this server's own tool names* so the agent gets "call `depot_get_ci_logs` with `attemptId=X`" rather than a shell command, and to preserve Depot's AI-generated disclaimer verbatim.

The `over_limit` state deserves specific handling: rather than failing, return `narrowerTargets` and tell the agent to re-call with a narrower ID. That is a clean, self-guiding agent loop.

### Tier 2 — container builds (read-only)

| Tool | Description | Input | Output | Backed by |
| --- | --- | --- | --- | --- |
| **`depot_diagnose_build`** | **Explain why a container build failed: locate the failing step and return its error and log tail.** | `{buildId, projectId?, tailLines?=100}` | `{build{status,durationSeconds,cachedSteps,totalSteps}, failingStep{name,digest,error}, logTail[], cacheSummary{cacheHitRatio,savedDurationSeconds}, truncated}` | `core.v1.BuildService/GetBuild` + `build.v1.BuildService/GetBuildSteps` + `GetBuildStepLogs` |
| `depot_list_builds` | Recent container builds for a project, with cache effectiveness. | `{projectId?, limit?=20}` | `{builds:[{buildId,status,createdAt,durationSeconds,savedDurationSeconds,cachedSteps,totalSteps}]}` | `core.v1.BuildService/ListBuilds` |
| `depot_list_projects` | List Depot projects with region, hardware and cache policy. | `{regionId?}` | `{projects:[{projectId,name,regionId,hardware,cachePolicy{keepDays,keepGb},createdAt}]}` | `ProjectService/ListProjects` |
| `depot_get_project` | One project's full configuration and trust policies. | `{projectId}` | `{project{...}, trustPolicies:[{trustPolicyId,provider,...}]}` | `GetProject` + `ListTrustPolicies` |
| `depot_get_usage` | Build minutes, minutes saved, GHA runner minutes, storage and sandbox usage for a period. | `{startAt, endAt, projectId?}` | `{periodStart, periodEnd, containerBuild[], githubActionsJobs[], storage[], agentSandbox[]}` | `UsageService/GetUsage` / `GetProjectUsage` |
| `depot_list_images` | Images in a project's Depot Registry. | `{projectId, limit?=50}` | `{images:[{tag,digest,pushedAt,sizeBytes}]}` | `build.v1.RegistryService/ListImages` |

`depot_diagnose_build` is the one genuinely non-trivial composite. Unlike CI, container builds have **no server-side diagnosis** — so the server does the work: `GetBuild` for status, `GetBuildSteps` to find the step with a non-empty `error` (falling back to the last `CACHE_STATE_UNCACHED` step with `hasLogs`), then `GetBuildStepLogs` on that step's digest and keep the tail. This is exactly the kind of multi-call reasoning that is wasteful to make an agent do and cheap to do in the server.

### Tier 3 — CI config inspection (read-only)

| Tool | Description | Input | Output | Backed by |
| --- | --- | --- | --- | --- |
| `depot_list_ci_secrets` | List CI secret **names and scoping only** — values are never returned. | `{query?, repo?, environment?, branch?, workflow?}` | `{secrets:[{name,variants:[{name,attributes[],lastModified}]}]}` | `ci.v3beta2.SecretService/ListSecrets` |
| `depot_list_ci_variables` | List CI variables and their values by scope. | same | `{variables:[{name,variants:[{name,value,attributes[]}]}]}` | `ci.v3beta2.VariableService/ListVariables` |

Genuinely useful for "my job can't see `$FOO`" — the variant/attribute model makes scoping mistakes common. Depot's API never returns secret values, so the read side is inherently safe.

### Tier 4 — mutating, opt-in

Gated behind `DEPOT_MCP_ALLOW_WRITES=1`. Not registered at all when unset, so the model cannot see or attempt them.

| Tool | Description | Input | Annotations | Backed by |
| --- | --- | --- | --- | --- |
| `depot_retry_ci_failed_jobs` | Retry only the failed/cancelled jobs in a finished workflow. | `{workflowId}` | `destructive:false, idempotent:false` | `CIService/RetryFailedJobs` |
| `depot_retry_ci_job` | Retry one failed job. | `{workflowId, jobId}` | `destructive:false` | `CIService/RetryJob` |
| `depot_cancel_ci_run` | Cancel a queued or running run and its descendants. | `{runId}` | `destructive:true` | `CIService/CancelRun` |
| `depot_cancel_ci_job` | Cancel one queued or running job. | `{workflowId, jobId}` | `destructive:true` | `CIService/CancelJob` |
| `depot_rerun_ci_workflow` | Reset every terminal job in a workflow and rerun all of them. | `{workflowId}` | `destructive:true` — costs full workflow compute | `CIService/RerunWorkflow` |
| `depot_dispatch_ci_workflow` | Trigger a `workflow_dispatch` workflow with validated inputs. | `{repo, workflow, ref, inputs?}` | `destructive:false, openWorld:true` | `CIService/DispatchWorkflow` |

`RetryFailedJobs` before `RerunWorkflow` is a deliberate cost ordering: retry-failed is a strict subset of rerun-all and is almost always what someone means by "try again".

### Tier 5 — deliberately excluded

Not shipped, at least not in v1:

| Excluded | Why |
| --- | --- |
| `CIService/Run` | Accepts arbitrary `workflowContent[]`. An agent that can author and execute CI workflows on your infrastructure is remote code execution with a billing meter. If ever added: separate env flag, and require `workflow` by path rather than inline content |
| `ProjectService/{Create,Update,Delete}Project` | Delete is irreversible and admin-only; create/update are rare, deliberate, low-value-to-automate acts better done in the dashboard |
| **`ProjectService/ResetProject`** | Terminates all machines and **deletes all cached data**. Catastrophic-if-wrong, silently expensive (every subsequent build is a cold build), and indistinguishable to a model from "clear the cache to fix my flaky build" |
| `ProjectService/{Create,Update,Delete}Token`, `registry.v1beta1` token RPCs | Mints long-lived credentials. `CreateToken` returns the secret in the response, so it would land in a transcript |
| `SecretService/{Create,Set,Update,Delete}*` | Writing secrets through a model means secret values in the conversation |
| `RegistryService/{DeleteImage,DeleteTag,BatchDeleteImage,DeleteRepository}` | Irreversible deletion of artifacts something may be deploying |
| `ShareBuild` | Creates a **public URL** for a build. Data exposure disguised as a read |
| `buildkit.v1.BuildKitService` | mTLS endpoint acquisition for driving BuildKit. No agent use |
| Everything in `depot.cli.v1`, `agent.v1`, `cache.v1`, `testresults.v1`, `ci.v2` | Internal, unversioned, undocumented. Will break |

Excluding `ResetProject` is the call I'd most expect pushback on. It is one RPC and it looks like a fix. But it is *the* worst-shaped operation for a model to hold: a plausible-sounding remedy with an irreversible, invisible, expensive blast radius.

### Resources and prompts

**Resources — one, maybe:** `depot://ci/run/{runId}` for a run's status tree, so a user can `@`-mention a run. Resource *subscriptions* look tempting for live run status, but implementing them means holding a poll loop per subscribed run, and it collides directly with the concurrent-stream limits in §6.3. Skip subscriptions in v1.

**Prompts — two, cheap and high leverage:**

- `diagnose-latest-failure` — "find my most recent failed run, diagnose it, propose a fix." Chains `depot_list_ci_runs(status:['failed'], limit:1)` → `depot_diagnose_ci_failure` → `depot_get_ci_logs`.
- `explain-build-slowness` — chains `depot_list_builds` → `depot_get_usage` and reasons about `cachedSteps/totalSteps` and `savedDurationSeconds`.

Prompts are the cheapest way to encode Depot's resource hierarchy so the agent doesn't have to rediscover it.

## 5. Auth and secret handling

Depot's token model (full table in the companion report) is coarse: **an Organization token that can call `ListRuns` can also call `CancelRun` and `DeleteProject`. There is no read-only token.** Project tokens cannot reach the CI API or the API at all, so they aren't a least-privilege option here.

Therefore:

- **The server is the security boundary.** Read-only is enforced by which tools get registered, not by the credential.
- **Config**: read `DEPOT_TOKEN` from the environment, per MCP convention (env vars in the client's config JSON). Optionally fall back to reading `api_token` from `~/.config/depot/depot.yaml`, which is how the CLI stores it — convenient, but make it opt-in via `DEPOT_MCP_USE_CLI_CONFIG=1` so the server never silently picks up ambient credentials.
- **Org context**: read `DEPOT_ORG_ID`, else resolve via `ListOrganizations` at startup; if exactly one org, use it; if several and none configured, make `depot_whoami` say so explicitly rather than returning confusing empty lists. Send `x-depot-org` on every request.
- **Never echo the token.** Not in errors, not in debug output, not in a `depot_whoami` response. Report `tokenSource: 'env' | 'cli-config'` and nothing more.
- **Redact on the way out.** `depot_list_ci_variables` returns real values and CI variables get misused as secret storage. Scrub anything matching high-entropy or key-like patterns before returning, and say that you did.
- Recommend an **Organization token created specifically for this server**, so it can be revoked independently.

The `2026-07-28` spec's OAuth/authorization work matters only for remote HTTP servers. For a stdio server the token never leaves the machine, which is the right default posture.

## 6. Hard parts and risks

### 6.1 Container builds cannot be triggered via API — the main structural limit

Running `depot build` means: `CreateBuild` → acquire an mTLS BuildKit endpoint → **transfer the local build context** → drive the BuildKit solve protocol → `ReportTimings` → `FinishBuild`. The CLI embeds a buildx/BuildKit fork to do it. There is no "build this" RPC.

Three options, in preference order:

1. **Don't.** Ship read-only build *observability* (`depot_diagnose_build`, `depot_list_builds`). The agent's job is explaining failures, and the human runs `depot build` in their terminal — where they can see progress. This is the v1 recommendation.
2. **Server-side CI.** `depot_dispatch_ci_workflow` triggers real work with no local context and no local Docker. If someone wants agent-triggered builds, this is the safe shape.
3. **Shell out to `depot build`.** Requires the CLI on `PATH`, a trusted working directory, and reintroduces every timeout and log-volume problem at once. Only worth it if a concrete workflow demands it.

Note that a plain `depot build` does **not** need local Docker — it runs remotely. Local Docker is needed only for `--load` and `configure-docker`. So "requires local Docker" is a narrower risk than it first appears; the real blocker is the **build context transfer**, not the daemon.

### 6.2 Log volume versus context window

CI logs are unbounded and a busy job produces megabytes. `GetJobAttemptLogs` has no `tailLines` parameter — it pages **oldest-first**, which is the opposite of what you want.

Mitigations:

The client-side limits are no longer guesswork. Claude Code documents them precisely, and they are the tightest published numbers we have to design against:

| Limit | Value |
| --- | --- |
| Output warning threshold | **10,000 tokens** (fixed, not configurable) |
| Default maximum | **25,000 tokens**, raisable by the user via `MAX_MCP_OUTPUT_TOKENS` |
| Per-tool override | `_meta["anthropic/maxResultSizeChars"]`, hard ceiling **500,000 characters** |

The per-tool annotation is the useful one: it applies independently of `MAX_MCP_OUTPUT_TOKENS` for text content, so a log tool can declare a larger budget without asking the user to change their environment. Anthropic's docs explicitly name the two things they want server authors to do — add that annotation, or **paginate**. No equivalent cap is documented for Claude Desktop or Cursor, so the safe move is to design to Claude Code's numbers.

Mitigations:

- Default to a **tail**. Page forward accumulating into a ring buffer of `tailLines`, then return only the tail. Costs extra requests but keeps output bounded. Cap total pages fetched (say 20) and report if the cap was hit.
- Hard character budget per tool result. Target **under ~40 KB (roughly 10k tokens) by default** so results never trip the warning threshold, and set `_meta["anthropic/maxResultSizeChars"]` on the raw-log tool only, where a deliberately larger payload is the point. Always pair truncation with explicit `truncated: true` and a `hint` naming the follow-up call.
- **Prefer `depot_diagnose_ci_failure` over raw logs and say so in the tool descriptions.** Depot's diagnose response is already bounded server-side with an explicit `bounds` object. Raw logs should be the escape hatch, not the default path.
- Support `grep` server-side so "find the stack trace" doesn't require shipping the whole log.
- Return tools in a **deterministic order** — `2026-07-28` asks for it, and it improves client-side and LLM prompt caching.

### 6.3 Streaming, timeouts, and the 429 you will actually hit

- Depot documents `resource_exhausted` / **429** for *"too many concurrent log streams for the token, organization, or attempt"* and for *"a log stream or export that exceeded its maximum duration."* Neither limit's value is published. **Log streaming is a scarce, shared, org-wide resource** — and a naive `follow` tool could exhaust it for the user's whole organization, including their CI.
- **Use the unary `GetJobAttemptLogs` with `pageToken`, not `StreamJobAttemptLogs`.** Depot's docs explicitly bless polling. It sidesteps Connect stream framing, the concurrency cap, and the duration cap in one move.
- **Tool-call timeouts are far more generous than expected, but the binding constraint is idleness, not wall-clock.** There is no spec-level timeout — `2026-07-28` actually *removed* the per-operation timeout guidance. Claude Code's documented behaviour:

  | Timer | Default | Override |
  | --- | --- | --- |
  | Tool wall-clock | **~28 hours** (`100000000` ms) | `MCP_TOOL_TIMEOUT`, or per-server `timeout` in `.mcp.json` |
  | Tool **idle** | **5 min** network / **30 min** stdio | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` |
  | Auto-background | 2 min | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` |

  The asymmetry is the thing to internalise: a per-server `timeout` is a **hard** wall-clock limit that progress notifications do *not* extend, but the idle timer aborts a call that sends "no response and no progress notification" for the window — so **progress notifications do buy time, against the idle timer specifically.** A call still running after two minutes moves to a background task, and Claude keeps working with the task ID. Nothing equivalent is documented for Claude Desktop or Cursor, so do not assume it.
- Long-running operations still fit badly in a tool call, so the recommendation is unchanged even though the timeouts are roomy: do **not** build a `wait_for_run_to_finish` tool. Return current status plus a suggestion to call again. Agent-polls-across-turns keeps the human in the loop, avoids holding a call open for a multi-minute build, and matches `2026-07-28`'s explicit "Stateful Tools" handle pattern.
- Emit progress notifications for the multi-page log fetches. Guard on `ctx.mcpReq._meta?.progressToken` and send nothing if the client did not ask; `progress` must strictly increase per token.
- On the client side, mirror the CLI's retry policy: retry `unavailable` / `deadline_exceeded` / `aborted` with 250 ms → 30 s exponential backoff; treat 429 as retryable-with-longer-backoff; never retry `invalid_argument`, `not_found`, `permission_denied`, or `failed_precondition`.
- Expect **duplicate log lines** when resuming. The CLI dedupes with a 4096-entry LRU keyed on `sha256(body)+stepKey+timestampMs+lineNumber+stream`; copy that if you paginate across reconnects.

### 6.4 Cost and safety of agent-triggered work

`RerunWorkflow` re-runs an entire workflow. `RetryFailedJobs` re-runs a subset. `Run` executes arbitrary workflow content. All bill real compute. An agent in a retry loop can burn money fast and silently.

- Writes off unless `DEPOT_MCP_ALLOW_WRITES=1`.
- `destructiveHint: true` on cancels and reruns — as a *hint*; the env gate is the actual control.
- Prefer the narrowest operation (`RetryJob` < `RetryFailedJobs` < `RerunWorkflow`) and say so in the descriptions.
- Consider an in-process rate limit on mutating calls (e.g. 5 per session) as a cheap circuit breaker against loops.

### 6.5 API stability

- `ci.v1` and `core.v1` are stable and documented.
- **`ci.v3beta2` is beta in its name.** The secrets/variables tools should be considered the most breakage-prone.
- **`depot.ci.v1` is documented but is not in the `depot/proto` repo and not on `buf.build/depot/api`.** So the CI API has *reference docs* but no published schema artifact. There is nothing to codegen from and nothing to diff for breaking changes — you are hand-writing types against prose. This is the main long-term maintenance tax, and it is a strong argument for pinning narrow hand-written types over trying to be exhaustive.
- Everything in `depot.cli.v1`, `agent.v1`, `cache.v1`, `testresults.v1` is internal and will break. Don't.

### 6.6 Testing needs a paid Depot account with real history

This is the practical blocker. Nothing meaningful is testable without:

- A Depot org and an **Organization token** (user tokens work too but span all orgs).
- **Depot CI enabled**, with the **Depot GitHub app / Code Access** connected — `DispatchWorkflow` requires the repo to be connected.
- **At least one genuinely failed CI run**, or `GetFailureDiagnosis` returns `state: empty` and the flagship tool is untestable.
- At least one failed **container build** for `depot_diagnose_build`.
- Depot CI is described in Depot's own Skill as **beta**.

So: unit-test everything against recorded fixtures (the API is JSON, so fixtures are trivial), and treat live testing as a separate, gated integration suite.

## 7. Recommended stack

**TypeScript on Node ≥ 20, `@modelcontextprotocol/server@^2.0.0` used directly with `McpServer` + `registerTool`, Zod 4 for schemas, plain `fetch` against Depot's Connect JSON binding, stdio transport via `serveStdio`, distributed as an `npx`-runnable npm package.**

Justification, point by point:

- **TypeScript over Python/Go.** The TS SDK is the reference implementation and tracks the spec most closely. Depot's own ecosystem is TypeScript-first (`@depot/sdk-node`, every GitHub Action). `npx` is the lowest-friction install path for MCP clients. Go would produce a nicer single binary but the MCP Go SDK is less mature and MCPB already solves "no toolchain required."
- **The v2 packages, not `@modelcontextprotocol/sdk`.** `@modelcontextprotocol/server@2.0.0` is the current line and the only one that speaks `2026-07-28`; the `sdk` package name is now legacy v1 and tops out at `2025-11-25`. v2 also serves handshake-era clients from the same factory by default, so targeting the current revision costs no compatibility.
- **Raw SDK over `fastmcp`/`xmcp`.** ~15 tools, one auth header, one base URL. `registerTool` with a Zod schema is already about as terse as it gets. `fastmcp` is disqualified for now regardless of ergonomics — it is still on the v1 SDK. `xmcp` is v2-ready and the reasonable alternative if file-based routing and HTTP hosting later become requirements.
- **Plain `fetch`, not `@depot/sdk-node`.** This is the most consequential choice and it goes against the obvious move. `@depot/sdk-node@2.0.0` was last published **2025-09-17**, **does not expose `depot.ci.v1` at all** — which is the entire core of this server — and creates its Connect transport as a **module-level singleton at import time**, so the base URL can't be injected per call. Against that, Depot's Connect JSON binding is literally `POST /<service>/<Method>` with a JSON body, and Depot's own docs publish curl examples for every method. A ~40-line typed `fetch` client covers CI, core, build and registry uniformly with zero protobuf dependency, no codegen step, and no `@bufbuild/protobuf` peer. Keep `@depot/sdk-node` in mind only if you later need the streaming or BuildKit RPCs.
- **stdio transport via `serveStdio(createServer)`.** The server holds a `DEPOT_TOKEN` and runs on the user's machine; stdio keeps the credential local and needs no auth layer. HTTP+SSE is deprecated. Because v2 transports take a *factory*, the same `createServer` can be handed to `createMcpHandler` later for Streamable HTTP hosting without touching tool code. Log to stderr only.
- **`npx` primary, MCPB secondary, Docker not at all.** `npx -y depot-mcp` is one line of config. Add `mcpName` to `package.json` to be registry-publishable, and ship a `.mcpb` bundle with `fileSha256` for one-click Claude Desktop install. Docker adds a daemon dependency and credential-passing awkwardness for zero benefit to a stdio server.

### Repo structure

```
depot-mcp/
  src/
    index.ts              # entrypoint: config + serveStdio(createServer)
    server.ts             # createServer(): McpServer factory, shared by stdio and tests
    config.ts             # DEPOT_TOKEN / DEPOT_ORG_ID / DEPOT_MCP_ALLOW_WRITES resolution
    depot/
      client.ts           # fetch wrapper: connectRpc(service, method, body) + retry/backoff
      types.ts            # hand-written types for the RPCs actually used
      errors.ts           # Connect error code -> actionable message mapping
    tools/
      whoami.ts
      ci-diagnose.ts      # depot_diagnose_ci_failure  <- the important one
      ci-runs.ts           ci-logs.ts       ci-metrics.ts
      ci-artifacts.ts      ci-config.ts     ci-mutations.ts
      builds.ts            projects.ts      usage.ts   registry.ts
    lib/
      budget.ts           # character-cap + truncation + hint helper
      resolve.ts          # loose ID -> {runId|workflowId|jobId|attemptId}
      redact.ts           # scrub secret-shaped values
    prompts.ts
  test/
    fixtures/             # recorded Depot JSON responses
    tools/*.test.ts       # in-process Client <-> createMcpHandler(createServer)
  package.json            # bin: depot-mcp, mcpName: io.github.<you>/depot-mcp
  manifest.json           # MCPB
  README.md
```

`budget.ts`, `resolve.ts` and `redact.ts` being shared primitives rather than per-tool logic is what keeps the tools boring, and boring tools are what make the output predictable.

### Testing strategy

**v2 has a first-class in-process story: drive the real server through a real `Client` with no socket.** Pass `createMcpHandler(...).fetch` as the client transport's `fetch` implementation, so tests exercise *the same handler you ship*:

```ts
import {Client, StreamableHTTPClientTransport} from '@modelcontextprotocol/client'
import {createMcpHandler} from '@modelcontextprotocol/server'

const handler = createMcpHandler(createServer)
const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
  fetch: (url, init) => handler.fetch(new Request(url, init)),
})
const client = new Client({name: 'test', version: '0.0.0'}, {versionNegotiation: {mode: 'auto'}})
await client.connect(transport)

const result = await client.callTool({name: 'depot_diagnose_ci_failure', arguments: {id: 'run_123'}})
// assert on structuredContent, not the text rendering
await client.close()
await handler.close()
```

Two things to get right. **Assert on `structuredContent`**, since the text block is a rendering and will churn. And remember that both handler failures and schema-rejected arguments come back as ordinary results with `isError: true` rather than thrown exceptions, so there is nothing to `catch`.

`InMemoryTransport.createLinkedPair()` still exists in `@modelcontextprotocol/client@2.0.0`, but the SDK docs are explicit that it connects **2025-era instances only** — `handler.fetch` is the in-process entry point for `2026-07-28` coverage. Use the handler. Stdio has no in-process shortcut; covering it means spawning the built binary via `StdioClientTransport`, which is worth exactly one smoke test.

Layers:

1. **Unit** — pure functions: ID resolution, truncation/budgeting, redaction, Connect error mapping, the `over_limit` → `narrowerTargets` transform. No network.
2. **Tool-level** — a real `Client` against `createMcpHandler(createServer)`, with the *Depot* `fetch` stubbed to return recorded fixtures. Assert the full MCP round trip: schema validation, `structuredContent` shape, `outputSchema` conformance, annotations, and that every result respects its character budget. This is the main suite and it needs no Depot account.
3. **Fixtures** — capture real responses once from a live org for each of the four `GetFailureDiagnosis` states (`empty`, `focused_failure`, `grouped_failures`, `over_limit`), plus a failed build with steps and logs. These four states are the whole behavioural surface of the flagship tool; without all four you will ship a tool that works only on the happy path.
4. **Integration** — gated on `DEPOT_TOKEN` being present, skipped by default in CI. Read-only calls only. Never exercise mutating tools against a real org from an automated suite.
5. **Manual** — `npx @modelcontextprotocol/inspector@2.5.0 node dist/index.js` for interactive checks, then a real Claude Desktop / Claude Code / Cursor install to confirm the config shape and that annotations render as expected.

## 8. What the user needs to decide or provide

1. **A Depot account with CI enabled, and an Organization token.** Ideally with real failure history — `GetFailureDiagnosis` returns `state: empty` without a failed run, which makes the flagship tool untestable. Depot CI is beta.
2. **Are agent-triggered reruns acceptable?** They cost real compute. Recommendation: ship read-only by default, put retry/cancel/rerun behind `DEPOT_MCP_ALLOW_WRITES=1`, and leave `CIService/Run` out entirely.
3. **Should container builds be triggerable at all?** Recommendation: no in v1. Read-only build observability plus `depot_dispatch_ci_workflow` covers the real workflows without shelling out to `depot build`.
4. **Scope: CI-only or CI + builds + registry + usage?** CI alone delivers most of the value and is the cleanest surface. The Tier 2 build/project/usage tools are cheap additions on the same client.
5. **Confirm `ResetProject` stays excluded** (§4 Tier 5). It is the one exclusion most likely to be questioned.
6. **Publish to the official MCP Registry?** It is still in preview with a frozen v0.1 API. Costs one `mcpName` field and an `mcp-publisher` run; the downside is tracking a pre-GA schema.
