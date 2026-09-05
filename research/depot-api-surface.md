# Depot programmatic surface — factual map

Research date: **2026-09-04**. Everything below was verified live against Depot's docs, the `depot/proto` repo, the `depot/cli` source at commit on `main` as of 2026-09-02, and npm/BSR metadata. Nothing here is from training data.

## 0. Executive summary of the surface

Depot exposes **three overlapping layers**:

| Layer | Transport | Public + documented? | Good for an MCP server? |
| --- | --- | --- | --- |
| Depot CI API (`depot.ci.v1`, `depot.ci.v3beta2`) | Connect RPC over HTTPS, JSON codec supported | **Yes** — full reference at [docs/api/ci/reference](https://depot.dev/docs/api/ci/reference) | **Yes, ideal.** Plain JSON POST, no codegen needed |
| Container Builds API (`depot.core.v1`, `depot.build.v1`, `depot.buildkit.v1`) | Connect RPC over HTTPS | **Yes** — [docs/api/sdk-reference](https://depot.dev/docs/api/sdk-reference), protos in [github.com/depot/proto](https://github.com/depot/proto) | Yes for metadata (projects/builds/usage/registry); **no** for actually running a build |
| Internal CLI-only services (`depot.cli.v1`, `depot.agent.v1`, `depot.cache.v1`, `depot.testresults.v1`, `depot.ci.v2`) | Connect RPC over HTTPS | **No** — vendored generated code inside `depot/cli` only | Reachable but unversioned/unsupported. Shell out to the CLI instead |

The single most important fact: **the Depot CI API is a first-class public API with a JSON-over-HTTP binding**, and it already contains an RPC purpose-built for agents (`GetFailureDiagnosis`). An MCP server needs no protobuf toolchain, no gRPC client, and no Docker on the host to cover the majority of useful functionality.

## 1. API basics

### Endpoints

| Purpose | Base URL | Env var override |
| --- | --- | --- |
| Main API (all services below) | `https://api.depot.dev` | `DEPOT_API_URL` |
| Remote exec / compute (`depot exec`, sandboxes) | `https://exec.depot.dev` | `DEPOT_EXEC_URL` |

Source: `pkg/api/rpc.go` in `depot/cli` (`getBaseURL()`, `getExecBaseURL()`), and `src/index.ts` in `depot/sdk-node`.

### Protocol

Connect RPC ([connectrpc.com](https://connectrpc.com)), which gives three wire protocols over the same endpoints: Connect, gRPC, and gRPC-Web. Critically, the **Connect protocol's unary JSON binding is just an HTTP POST**:

```bash
curl -X POST https://api.depot.dev/depot.ci.v1.CIService/ListRuns \
  -H "Authorization: Bearer $DEPOT_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Connect-Protocol-Version: 1" \
  --json '{"status":["failed"],"pageSize":25}'
```

The URL is always `POST /<fully.qualified.ServiceName>/<MethodName>`. Field names in JSON are **lowerCamelCase** (`pageSize`, `runId`, `attemptId`), per protobuf JSON mapping. This exact curl form is what Depot's own docs publish for every method, so it is a supported binding, not a trick.

Server-streaming methods (`StreamJobAttemptLogs`, `ExportJobAttemptLogs`, `GetEndpoint`, `FinishLogin`) use Connect's streaming framing — a length-prefixed envelope stream — which is *not* plain JSON and does need either the Connect client library or manual envelope parsing.

### Buf Schema Registry

- BSR module: **`buf.build/depot/api`** (confirmed by `name: buf.build/depot/api` in `depot/proto`'s `proto/buf.yaml`).
- Docs browser: `https://buf.build/depot/api/docs/main:depot.core.v1` etc.
- Pre-generated SDKs are published to BSR's managed registries — `depot/cli` itself imports `buf.build/gen/go/depot/api/connectrpc/go/depot/core/v1/corev1connect`, and `depot/sdk-node` generates with `buf generate buf.build/depot/api`.
- **Important caveat:** the BSR module tracks only the *public* protos (`depot/proto`). `depot.ci.v1` is **not** in `depot/proto` and therefore **not** on the BSR, despite being publicly documented. See §4.

### Errors and limits

Depot documents Connect error codes for the CI API. There is **no published rate limit** (no requests/minute number, no `Retry-After` documentation). The only documented resource limits are:

| Code | HTTP | Cause (verbatim from docs) |
| --- | --- | --- |
| `invalid_argument` | 400 | Malformed or contradictory arguments |
| `unauthenticated` | 401 | Missing/invalid token |
| `permission_denied` | 403 | Token lacks access to the resource |
| `not_found` | 404 | Unknown run/workflow/job/attempt/artifact ID, or a workflow with no `workflow_dispatch` trigger |
| `failed_precondition` | 412 | Cancelling something not queued/running; retrying before a workflow finishes; status changed mid-request |
| `resource_exhausted` | **429** | **Too many concurrent log streams for the token, organization, or attempt; a log stream or export that exceeded its maximum duration; a metrics result that is too large** |
| `unavailable` | 503 | Log/metrics store transiently down — retryable |
| `internal` | 500 | Server-side failure |

The 429 row is the one that matters for design: **concurrent log streams are capped per token and per org, and streams have a maximum duration.** Treat log streaming as a scarce resource.

### Pagination

Two different conventions coexist:

- **Cursor style** (`depot.ci.v1`, `depot.core.v1`, `depot.build.v1`): request takes `pageSize` + `pageToken`, response returns `nextPageToken`. Empty `nextPageToken` means done. `ListWorkflows` caps `pageSize` at 200. `depot tests` caps at 500 (default 100).
- **Page-number style** (`depot.ci.v3beta2`, `depot.registry.v1beta1`): request takes `{page, pageSize}`, response returns `{page, pageSize, hasMore}` (or `totalCount`). The CLI uses `pageSize: 100` and loops while `hasMore`.

## 2. Authentication

### Token types

From [docs/cli/authentication](https://depot.dev/docs/cli/authentication) — this table is verbatim from Depot's docs and is the definitive scope matrix:

| Service | User token | Organization token | Project token | Pull token |
| --- | --- | --- | --- | --- |
| Container Builds | ✅ | ✅ | ✅ (project-scoped) | — |
| Registry | ✅ | ✅ | ✅ (project-scoped) | ✅ (read-only) |
| Depot CI | ✅ | ✅ | — | — |
| Cache | ✅ | ✅ | — | — |
| Agents | ✅ | ✅ | — | — |
| API | ✅ | ✅ | — | — |

- **User access token** — tied to a Depot account, grants access to **every project in every org you belong to**. Created via `depot login` (stored locally) or from Account settings → API Tokens. Docs explicitly say local development only, not CI.
- **Organization token** — scoped to one org, not tied to a user. Created in Organization Settings → API Tokens. **This is what the API docs and `@depot/sdk-node` assume.**
- **Project token** — scoped to one project. Cannot use Depot CI, Cache, Agents, or the API. Created in project Settings → Project Tokens.
- **Pull token** — short-lived (**1 hour**), read-only, Registry-only. Generated with `depot pull-token --project <id>`. Not listed or revocable in the dashboard.

There are **no granular scopes**. A token is not "read-only" — an org token that can call `ListRuns` can also call `CancelRun` and `DeleteProject`. Least privilege must be enforced by the MCP server, not by Depot.

### Wire format

```
Authorization: Bearer <token>
x-depot-org: <org-id>        # optional; required when the user belongs to multiple orgs
```

Source: `WithAuthentication` / `WithAuthenticationAndOrg` in `pkg/api/rpc.go`. The `x-depot-org` header is what `--org` and `DEPOT_ORG_ID` map to. A user token spanning multiple orgs will get ambiguous or empty results without it — an easy and confusing failure mode.

### CLI token resolution order

From `pkg/helpers/token.go` and the docs, for org-scoped commands (`ResolveOrgAuth`):

1. `--token` flag
2. `DEPOT_TOKEN` env var
3. token stored by `depot login`
4. JIT token: `DEPOT_JIT_TOKEN`, then `DEPOT_CACHE_TOKEN`
5. if a TTY: interactive device-authorization login

For project-scoped/build commands (`ResolveProjectAuth`) the order inserts OIDC before JIT: `--token` → `DEPOT_TOKEN` → stored token → **OIDC provider exchange** → JIT → interactive.

### Credential storage

`depot login` writes to an XDG config file:

```
$XDG_CONFIG_HOME/depot/depot.yaml     # macOS default: ~/.config/depot/depot.yaml
```

Keys: `api_token`, `org_id`. Written with mode `0600` (see `writeConfig()` in `pkg/config/config.go`). Also `depot/state.yaml` for CLI state. Config is read via viper with `SetEnvPrefix("DEPOT")` + `AutomaticEnv()`, so any key is overridable by `DEPOT_<KEY>`.

**Plaintext on disk, not the OS keychain.** Worth noting for the security posture section of any design.

### Login flow

Device-authorization style, over Connect (`depot.cli.v1beta1.LoginService`):

1. `StartLogin({})` → `{id, approveUrl}`
2. CLI prints/opens `approveUrl`
3. `FinishLogin({id})` — a **server-stream** that blocks until the user approves, then yields `{token, ...}`
4. CLI persists the token via `config.SetApiToken`

This is CLI-only (not in `depot/proto`). An MCP server should not reimplement it; take a token from config instead.

### OIDC trust relationships

Depot supports token exchange from GitHub Actions, GitLab CI ID tokens, CircleCI, Buildkite, and RWX. Configured per-project in the dashboard (Settings → Trust Relationships), or via API: `ProjectService.ListTrustPolicies / AddTrustPolicy / RemoveTrustPolicy`. The `TrustPolicy` proto has a `oneof provider` over `GitHub {org, repository}`, `CircleCI {org UUID, project UUID}`, `Buildkite {org slug, pipeline slug}`, `GitLab {namespace id, project id}`.

**Trust relationship tokens have the same permissions as project tokens** — so they cannot reach Depot CI or the API. OIDC is irrelevant to a locally-run MCP server; it matters only if the server ever runs inside CI.

Provider implementations live in `depot-go/internal/oidc/{github,gitlab,circleci,buildkite,actionspublic}` and `depot/cli/pkg/oidc`.

## 3. Depot CI API — `depot.ci.v1.CIService` (public, documented)

Reference: <https://depot.dev/docs/api/ci/reference>. All paths are `POST https://api.depot.dev/depot.ci.v1.CIService/<Method>`.

Resource hierarchy: **run → workflow → job → attempt**. Logs, metrics, artifacts and diagnoses are *scoped to attempts* but reachable from any ancestor (pass `jobId` to mean "latest attempt of this job").

### Runs

| Method | Mutating | Request | Notes |
| --- | --- | --- | --- |
| `Run` | **Yes** | `{repo, sha, workflow, workflowContent[], job, forge}` | Triggers a CI run; may contain multiple workflows. `forge` is `github`/`origin` |
| `ListRuns` | No | `{status[], pageSize, pageToken, repo, sha, trigger, pr}` | Newest first. `repo` is `owner/name`; required if `pr` set. Statuses: `queued`, `running`, `finished`, `failed`, `cancelled` |
| `GetRun` | No | `{runId}` | Flat identity/repo/trigger/status/timestamps (RFC 3339) |
| `GetRunStatus` | No | `{runId}` | **Nested** workflows → jobs → attempts. The tree view |
| `GetRunMetrics` | No | `{runId}` | CPU/memory summaries at workflow, job, attempt level |
| `CancelRun` | **Yes** | `{runId}` | Cancels run + all unfinished descendants |

### Workflows

| Method | Mutating | Request | Notes |
| --- | --- | --- | --- |
| `ListWorkflows` | No | `{pageSize, name, repo, status[], trigger, sha, pr}` | `pageSize` up to **200** |
| `GetWorkflow` | No | `{workflowId}` | Identity, status, timestamps, parent run context, execution history, nested jobs + attempts |
| `DispatchWorkflow` | **Yes** | `{repo, workflow, ref, inputs}` | Requires an `on.workflow_dispatch` trigger; validates `inputs` against the workflow's input schema. Repo must be connected via the Depot GitHub app |
| `RerunWorkflow` | **Yes** | `{workflowId}` | Resets **every** terminal job to queued and reruns all. Fails if still running |
| `CancelWorkflow` | **Yes** | `{workflowId}` | Cancels workflow + child jobs |

### Jobs

| Method | Mutating | Request | Notes |
| --- | --- | --- | --- |
| `GetJob` | No | `{jobId}` | Includes dependency jobs and per-attempt detail |
| `GetJobSummary` | No | `{jobId, attemptId}` | Authored step-summary markdown (the GHA `$GITHUB_STEP_SUMMARY` equivalent) |
| `GetJobMetrics` | No | `{jobId}` | Per-attempt CPU/memory summaries |
| `RetryJob` | **Yes** | `{workflowId, jobId}` | Retries one failed job |
| `RetryFailedJobs` | **Yes** | `{workflowId}` | Retries only failed/cancelled jobs (cheaper than `RerunWorkflow`) |
| `CancelJob` | **Yes** | `{workflowId, jobId}` | |

### Attempts

| Method | Mutating | Request |
| --- | --- | --- |
| `GetAttempt` | No | `{attemptId}` |
| `GetJobAttemptMetrics` | No | `{attemptId}` — CPU/memory samples. Docs note a running attempt's metrics **grow on successive calls**, snapshot time is returned |

### Logs (the interesting part)

| Method | Kind | Request | Notes |
| --- | --- | --- | --- |
| `GetJobAttemptLogs` | **Unary** | `{attemptId \| jobId, pageToken}` | Persisted lines, oldest first. Poll with `pageToken` to fetch lines persisted since last response. Response: `{lines[], nextPageToken}` |
| `StreamJobAttemptLogs` | Server-stream | `{attemptId \| jobId, cursor}` | Follows live. Messages carry `line`, `attemptStatus`, `nextCursor`. Resumable via cursor |
| `ExportJobAttemptLogs` | Server-stream | `{attemptId \| jobId, format}` | Finite snapshot: one `metadata` message then raw `chunk` bytes |

`LogLine` fields (from `pkg/api/ci.go` `logLineIdentity`): `stepKey`, `timestampMs`, `lineNumber`, `stream` (stdout/stderr), `body`.

`GetJobAttemptLogs` being **unary** is the key affordance: an MCP server can page logs with ordinary JSON POSTs and never touch Connect streaming. The CLI's own `CIGetJobAttemptLogs` does exactly this — loops `pageToken` until empty.

The CLI's streaming client (`CIStreamJobAttemptLogLines`) is a useful reference implementation: it dedupes replayed lines through a 4096-entry LRU keyed on `sha256(body) + stepKey + timestampMs + lineNumber + stream`, and retries on `unavailable`/`deadline_exceeded`/`aborted` with exponential backoff from 250 ms to 30 s. Replayed duplicates on reconnect are expected.

### Artifacts

| Method | Mutating | Request | Notes |
| --- | --- | --- | --- |
| `ListArtifacts` | No | `{runId, workflowId, jobId, attemptId, pageSize, pageToken}` | The last three are optional filters. CLI uses `pageSize: 500` |
| `GetArtifactDownloadURL` | No | `{artifactId}` | Returns **one signed HTTPS URL**. Docs note there is no separate artifact REST endpoint |

### Diagnostics — the highest-value RPC for an agent

`POST /depot.ci.v1.CIService/GetFailureDiagnosis`

Request: `{targetId, targetType}` where `targetType` is the enum **number**: `1` RUN, `2` WORKFLOW, `3` JOB, `4` ATTEMPT. Verified live 2026-09-06: every symbolic spelling (`RUN`, `TARGET_TYPE_RUN`, `run`) is rejected with 400 "target_type is required", and `5` gives "Unsupported target_type: 5". Depot's JSON codec here does not accept enum names, unlike `ListRuns.status`, which accepts only the lowercase strings `queued|running|finished|failed|cancelled`.

This is a **server-side, bounded, AI-assisted failure analysis**. It is not a log dump. The response shape (reconstructed precisely from `pkg/cmd/ci/diagnose.go`, which serialises every field for `--output json`):

```
{
  orgId, state, emptyReason,
  target:  { targetId, targetType, status },
  context: { runId, repo, ref, sha, headSha, trigger, runStatus,
             workflowId, workflowName, workflowPath, workflowStatus,
             jobId, jobKey, jobDisplayName, jobStatus, jobConclusion,
             attemptId, attempt, attemptStatus, attemptConclusion,
             truncatedContextFields[] },
  bounds:  { failedProblemCandidateCount/Cap, totalProblemJobCount,
             skippedDependentCount, totalFailureGroupCount,
             omittedFailureGroupCount, failureGroupLimit,
             representativesPerGroupLimit, recentAttemptLimit,
             totalAttemptCount, omittedAttemptCount, relevantLineLimit,
             errorLineBodyCharLimit, errorMessageCharLimit,
             contextLabelCharLimit, truncated, ... },
  failureGroups: [ { fingerprint, source, count, errorMessage,
                     errorMessageTruncated, errorMessageOriginalLength,
                     diagnosis, possibleFix,
                     representatives: [ { runId, workflowId, jobId, jobKey,
                                          attemptId, attempt, attemptStatus,
                                          attemptConclusion, errorMessage,
                                          diagnosis, possibleFix,
                                          relevantLines: [ { stepId, lineNumber,
                                                             content, contentTruncated,
                                                             contentOriginalLength } ],
                                          nextCommands[] } ],
                     omittedRepresentativeCount } ],
  representativeAttempts: [ ... same shape ... ],
  nextCommands: [ { kind, targetId, label, argv[] } ],
  overLimitBreakdown: [ { targetType, targetId, label, status,
                          failedProblemCandidateCount, nextCommands[] } ]
}
```

Four response `state` values drive the UX:

- `empty` — no failure evidence (`emptyReason: no_failure_evidence`)
- `focused_failure` — one clear culprit, returns `representativeAttempts`
- `grouped_failures` — failures clustered by `fingerprint`, each with an AI `diagnosis` + `possibleFix`
- `over_limit` — too many failures to diagnose at this level; returns `overLimitBreakdown` with narrower targets and the exact `nextCommands` to drill into them

`nextCommands[].kind` ∈ `logs | summary | diagnose_workflow | diagnose_job`, and `argv` is a ready-to-run CLI argv. Depot is literally handing a caller the next tool call to make — a natural fit for an agent loop.

Depot's CLI appends the disclosure *"This diagnosis is AI-generated and can make mistakes"* whenever `diagnosis` or `possibleFix` is non-empty. Any wrapper should preserve that.

### CI secrets and variables — `depot.ci.v3beta2` (public, documented)

`POST /depot.ci.v3beta2.SecretService/<Method>` and `.../VariableService/<Method>`. Model is a named secret/variable with multiple **variants**, each carrying **attributes** (`repository`, `environment`, `branch`, `workflow`) that decide where the variant applies.

- `SecretService`: `ListSecrets`, `ListSecretAttributes`, `GetSecret`, `GetSecretVariant`, `CreateSecretVariant`, `SetSecretVariant`, `UpdateSecretVariantMetadata`, `UpdateSecretVariantValue`, `DeleteSecretVariant`, `DeleteSecret`
- `VariableService`: same ten methods with `Variable` substituted

**Secret values are never returned** — only metadata (`id`, `name`, `description`, `attributes`, `lastModified`, `valueGroupIndex`). Variable *values* are returned. An older `depot.ci.v2.SecretService`/`VariableService` with a flat org/repo model (`AddOrgSecret`, `ListRepoSecrets`, `BatchAddOrgSecrets`, …) is still used by the CLI but is superseded by v3beta2.

## 4. Container Builds API (public, documented)

Protos: [github.com/depot/proto](https://github.com/depot/proto) → BSR `buf.build/depot/api`. Docs: [docs/api/sdk-reference](https://depot.dev/docs/api/sdk-reference).

### `depot.core.v1.ProjectService`

`ListProjects` `{regionId?, pageSize?, pageToken?}` · `GetProject` `{projectId}` · `CreateProject` `{name, organizationId?, regionId, cachePolicy?, hardware?}` · `UpdateProject` · `DeleteProject` · **`ResetProject`** (terminates all machines, deletes all cached data) · `ListTrustPolicies` · `AddTrustPolicy` · `RemoveTrustPolicy` · `ListTokens` · `CreateToken` `{projectId, description}` → `{tokenId, secret}` · `UpdateToken` · `DeleteToken`

```proto
message Project {
  string project_id = 1; string organization_id = 2; string name = 3;
  string region_id = 4; google.protobuf.Timestamp created_at = 5;
  CachePolicy cache_policy = 6;   // { keep_days, keep_gb, keep_bytes[deprecated] }
  Hardware hardware = 7;
}
enum Hardware {  // HARDWARE_UNSPECIFIED defaults to 16x32
  HARDWARE_4X4=2; HARDWARE_4X8=9; HARDWARE_8X8=3; HARDWARE_8X16=4;
  HARDWARE_16X32=1; HARDWARE_32X64=5; HARDWARE_64X128=6;
  HARDWARE_96X192=7; HARDWARE_192X384=8; HARDWARE_384X768=10;
}
```

Regions documented: `us-east-1`, `eu-central-1`. Default cache policy on create: 50 GB/arch, 14 days.

### `depot.core.v1.BuildService`

`ListBuilds` `{projectId, pageSize?, pageToken?}` · `GetBuild` `{buildId}` · `ShareBuild` `{buildId}` → `{shareUrl}` · `StopSharingBuild` `{buildId}`

```proto
message Build {
  string build_id = 1; Status status = 2;
  Timestamp created_at = 3; optional Timestamp started_at = 4; optional Timestamp finished_at = 5;
  optional int32 build_duration_seconds = 6; optional int32 saved_duration_seconds = 7;
  optional int32 cached_steps = 8; optional int32 total_steps = 9;
  enum Status { STATUS_UNSPECIFIED=0; STATUS_RUNNING=1; STATUS_FAILED=2;
                STATUS_SUCCESS=3; STATUS_ERROR=4; STATUS_CANCELED=5; }
}
```

Note `cachedSteps`/`totalSteps` and `savedDurationSeconds` — cache-effectiveness data available with a single call, no separate cache API needed. `ShareBuild` produces a public URL, which is a nice agent output but is also a **data-exposure mutation**.

This service is in the protos and in `@depot/sdk-node`, but is **omitted from the sdk-reference doc prose** — the doc lists only Project/Build(`depot.build.v1`)/Registry/BuildKit/Usage.

### `depot.build.v1.BuildService`

`CreateBuild` `{projectId}` → `{buildId, buildToken}` · `FinishBuild` `{buildId, oneof result{success|error}}` · `GetBuildSteps` `{projectId, buildId, pageSize?, pageToken?}` · `GetBuildStepLogs` `{projectId, buildId, buildStepDigest, pageSize?, pageToken?}`

```proto
message BuildStep {
  string name = 1; string digest = 2;
  Timestamp started_at = 3; optional Timestamp completed_at = 4;
  CacheState cache_state = 5;  // UNSPECIFIED | UNCACHED | CACHED
  optional string error = 6; bool has_logs = 7;
}
// GetBuildStepLogsResponse.Log = { message, timestamp }
```

**`GetBuildSteps` + `GetBuildStepLogs` are the container-build analogue of CI's diagnose** — per-step cache state, per-step error, and `hasLogs` so you know which step to fetch logs for. There is no server-side AI diagnosis here; the wrapper has to do the "find the failing step, fetch its logs" work itself.

`CreateBuild` returns a short-lived **build token** distinct from the API token; it's what a BuildKit client authenticates with.

### `depot.build.v1.RegistryService`

`ListImages` `{projectId, pageSize?, pageToken?}` → `Image {tag, digest, pushedAt, sizeBytes}` · `DeleteImage` `{projectId, imageTags[]}`

### `depot.registry.v1beta1.RegistryService` (newer, standalone registry)

In `depot/proto` but not in the SDK reference or `@depot/sdk-node`. Thirteen methods: `CreateToken` / `ListTokens` / `RevokeToken` (with `RegistryAccessTokenPermission` ∈ `PULL | PUSH`, `repositoryScopes[]`, `expiresAt`), `CreateRepository` / `ListRepositories` / `DeleteRepository`, `ListImages` / `GetImageDetail` (returns raw `manifest` bytes) / `DeleteTag` / `BatchDeleteImage`, `GetRetentionPolicy` / `UpsertRetentionPolicy` / `DeleteRetentionPolicy` (`{enabled, keepCount, keepDays}`). Uses page-number pagination with `query` search.

### `depot.buildkit.v1.BuildKitService`

`GetEndpoint` `{buildId, platform}` → **server-stream** of `{pending{} | active{endpoint, serverName, cert, caCert}}` · `ReportHealth` (**client-stream**) · `ReleaseEndpoint`

This is the machinery for driving a build yourself: you get an mTLS BuildKit endpoint plus a client cert pair and then speak the BuildKit protocol. Not something to wrap in an MCP tool.

### `depot.core.v1.UsageService`

`ListProjectUsage` `{startAt, endAt, pageSize?, pageToken?}` · `GetProjectUsage` `{projectId, startAt, endAt}` · `GetUsage` `{startAt, endAt}`

`ProjectUsage {projectId, buildCount, buildDurationSeconds, layerCacheSizeGb}`.

`GetUsage` is the billing-wide view and is notably **the only place GitHub Actions runner data is exposed via API**:

```proto
message GetUsageResponse {
  Timestamp period_start = 1; Timestamp period_end = 2;
  repeated ContainerBuildUsage    container_build = 3;    // {projectName, buildCount, minutesSaved, minutesBilled}
  repeated GithubActionsJobsUsage github_actions_jobs = 4;// {repo, total, jobs[{workflow, runner, jobCount, minutesElapsed, minutesBilled}]}
  repeated StorageUsage           storage = 5;            // {storageType, totalGb}
  repeated AgentSandboxUsage      agent_sandbox = 6;      // {agentType, sandboxesCount, minutesElapsed, minutesBilled}
}
```

### `depot.core.v1.OrganizationService`

`ListOrganizations {}` → `Organization {orgId, name, createdAt}`. Only method.

### `depot.code.v1beta1.CodeService`

`CreateRepository` `{oneof source: standalone{repository, defaultBranch} | github{repository}}` → `{repositoryId}` · `DeleteRepository` `{repositoryId}`. Depot Code (hosted/mirrored git). GitHub mirroring needs an active GitHub Code Access connection.

## 5. Internal, CLI-only services (reachable but unsupported)

These exist as vendored generated Go in `depot/cli/pkg/proto/` and are **not** in `depot/proto`, **not** on the BSR, and **not** in the docs. They can be called (same base URL, same bearer auth) but have no compatibility promise.

| Package | Services / notable RPCs |
| --- | --- |
| `depot.cli.v1` | `BuildService`: `CreateBuild`, `GetBuild`, `FinishBuild`, `GetBuildKitConnection`, `ReportBuildHealth`, `ReportTimings`, `ReportStatus`, `ReportBuildContext`, `ListBuilds`, `GetPullInfo`, `GetPullToken`. `PushService`. `BuildStatus` enum: `RUNNING/FINISHED/FAILED/CANCELED` |
| `depot.cli.v1beta1` | `LoginService`: `StartLogin`, `FinishLogin`(stream). `ProjectsService`: `ListProjects`, `ResetProjectCache` |
| `depot.agent.v1` | `SessionService`: `UploadSession`, `DownloadSession`, `ListSessions`. `SandboxService`: `Shutdown`, … . `ClaudeService`. `AgentType_AGENT_TYPE_CLAUDE_CODE` |
| `depot.cache.v1` | `CacheService`: `CreateEntry`, `FetchMorePresignedURLs`, `FinalizeEntry`, `GetDownloadURL`, `GetDownloadURLByPrefix`, `CheckEntries`, `GetBundle`, `DeleteEntry`, **`ListEntries`** |
| `depot.testresults.v1` | `TestResultsService`: `ReportTestResults`, `SplitTests`, `ListTestResults` |
| `depot.ci.v1` (extra) | `DepotComputeService.RemoteExec` (server-stream, on `exec.depot.dev`, uses gRPC not Connect). `MigrationService`: `ListRepositories`, `GetRepositoryAnalysis`, `StartMigration`, `RetryMigration`, `ReportSecretImport`, `RegisterSecretMigrationIntent` |
| `depot.ci.v2` | Older flat `SecretService` / `VariableService` |

Two things worth flagging:

- **`depot.cache.v1.ListEntries` is the only way to enumerate distributed-cache entries**, and it is internal. There is no public cache-inspection API. Public cache visibility is limited to `Project.cachePolicy`, `ProjectUsage.layerCacheSizeGb`, `StorageUsage.totalGb`, and `Build.cachedSteps/totalSteps`.
- **`depot.testresults.v1.ListTestResults` is internal**, but `depot tests <id> --output json` exposes it — and *that* is documented. So test results are reachable via CLI-only.

## 6. CLI — `depot` (Go, [github.com/depot/cli](https://github.com/depot/cli))

Root command registry is `pkg/cmd/root/root.go`. Command tree as of 2026-09-02:

### Container builds
`depot build` · `depot bake` · `depot cache reset` · `depot configure-docker [--uninstall]` · `depot init` · `depot list builds` · `depot list projects` · `depot pull` · `depot pull-token` · `depot push` · `depot image list` · `depot image rm` · `depot registry`

### Depot CI (`depot ci …`)
`run` · `run list` · `run show` · `status` · `workflow list` · `workflow show` · `dispatch` · `rerun` · `retry` · `cancel` · `logs` · `summary` · `metrics` · `diagnose` · `artifacts list` · `artifacts download` · `ssh` · `secrets {set,add,bulk,get,list,remove}` · `vars {set,add,list,remove}` · `migrate {workflows,secrets-and-vars,preflight}`

### Platform
`depot login [--org-id] [--clear]` · `depot logout` · `depot org {list,switch,show}` · `depot projects {create,get,update,delete}` · `depot version`

### Tests
`depot tests <id>` · `depot tests split` · `depot tests run` · `depot tests report`

### Agents / sandboxes
`depot claude [--session-id|--resume|--local|--repository|--branch|--git-secret|--wait|--org|--token|--output]` · `depot claude list-sessions` · `depot claude secrets {add,list,remove}` · `depot sandbox` · `depot sandbox exec` · `depot sandbox exec-pipe` · `depot sandbox pty` · `depot exec`

### Language caches
`depot gocache` (via `GOCACHEPROG='depot gocache'`, needs Go ≥ 1.24) · `depot cargo` · `depot buildkitd` · `depot buildctl` · `depot blog`

### JSON output — the agent contract

Nearly every read command supports machine-readable output:

- `depot ci *`: `-o json` / `--output json` (short `-o` works on most `depot ci` subcommands; `depot tests`, `depot ci secrets`, `depot ci vars` accept only long `--output`). There is a shared `pkg/cmd/ci/output.go`.
- `depot list builds --output json|csv`
- `depot projects get|update --output json`
- `depot org list --output json|csv`
- `depot tests --output auto|table|json` (prints a table on a TTY, JSON when piped)
- `depot claude --output json|csv`

`depot ci diagnose --output json` emits the full diagnose document from §3 with snake_case keys.

Common flags on essentially all `depot ci` and `depot tests` commands: `--org <id>`, `--token <token>`, `-o/--output`.

### API-equivalence map

| CLI | Backing public API | CLI-only value added |
| --- | --- | --- |
| `depot ci run list` | `CIService.ListRuns` | auto-paginates to `-n` limit |
| `depot ci status` | `CIService.GetRunStatus` | tree rendering |
| `depot ci run show` | `CIService.GetRun` | — |
| `depot ci workflow list/show` | `ListWorkflows` / `GetWorkflow` | — |
| `depot ci logs` | `GetJobAttemptLogs` / `StreamJobAttemptLogs` / `ExportJobAttemptLogs` | resolves run-id → job → latest attempt; `--follow`; stream dedupe + backoff; `--output-file` export |
| `depot ci diagnose` | `GetFailureDiagnosis` | text rendering, drill-down `argv` synthesis |
| `depot ci metrics` | `GetRunMetrics`/`GetJobMetrics`/`GetJobAttemptMetrics` | picks the right RPC from `--run/--job/--attempt` |
| `depot ci summary` | `GetJobSummary` | — |
| `depot ci artifacts list/download` | `ListArtifacts` / `GetArtifactDownloadURL` | auto-paginate; fetches the signed URL |
| `depot ci run/dispatch/rerun/retry/cancel` | `Run`/`DispatchWorkflow`/`RerunWorkflow`/`RetryJob`+`RetryFailedJobs`/`Cancel*` | interactive pickers, git-remote repo detection |
| `depot ci secrets/vars` | `v3beta2.SecretService`/`VariableService` | variant/attribute flag ergonomics |
| `depot projects *` | `core.v1.ProjectService` | `depot.json` / `DEPOT_PROJECT_ID` resolution |
| `depot org list/show` | `core.v1.OrganizationService` | `switch` writes local config — **no API equivalent** |
| `depot list builds` | `core.v1.BuildService.ListBuilds` | — |
| `depot image list/rm` | `build.v1.RegistryService` | — |
| **`depot build` / `bake`** | *(no equivalent)* | **Only way to run a build.** Needs local build context + BuildKit protocol |
| **`depot cache reset`** | `ProjectService.ResetProject` (approx) / internal `ResetProjectCache` | |
| **`depot tests`** | internal `testresults.v1` | documented CLI, internal API |
| **`depot gocache` / `cargo`** | internal `cache.v1` | protocol adapters, inherently CLI |
| **`depot claude` / `sandbox` / `exec`** | internal `agent.v1` | interactive/PTY |
| **`depot login` / `logout`** | internal `cli.v1beta1.LoginService` | writes local config |
| **`depot configure-docker` / `init`** | *(none)* | pure local mutation |

### The build execution gap

`depot build` and `depot bake` have **no API equivalent**, and this is structural rather than an oversight. Running a build means: `CreateBuild` → `GetBuildKitConnection`/`GetEndpoint` → establish mTLS to a remote BuildKit → **transfer the local build context** → drive the BuildKit solve protocol → `ReportTimings`/`ReportBuildContext` → `FinishBuild`. The CLI embeds a fork of buildx/BuildKit to do this.

Practical consequences:

- Builds run on **Depot's remote infrastructure**, so a local Docker daemon is **not** needed for a plain `depot build`.
- A local Docker daemon **is** needed for `--load` (import into local Docker), and `depot configure-docker` / `docker depot ...`.
- `depot push` needs registry credentials — `docker login` or `DEPOT_PUSH_REGISTRY_USERNAME`/`DEPOT_PUSH_REGISTRY_PASSWORD`.
- Anything that triggers a build from an MCP server must either **shell out to `depot build`** (needs the CLI installed and a local working directory) or **use `depot ci run`/`DispatchWorkflow`** (server-side, no local context).

### Environment variables

| Var | Meaning |
| --- | --- |
| `DEPOT_TOKEN` | API token (all commands) |
| `DEPOT_API_URL` | Override `https://api.depot.dev` |
| `DEPOT_EXEC_URL` | Override `https://exec.depot.dev` |
| `DEPOT_ORG_ID` | Org context (→ `x-depot-org`) |
| `DEPOT_PROJECT_ID` | Default project |
| `DEPOT_BUILD_ID`, `DEPOT_PLATFORM`, `DEPOT_BUILD_PLATFORM` | Build context (set for BuildKit clients) |
| `DEPOT_JIT_TOKEN`, `DEPOT_CACHE_TOKEN` | JIT tokens injected in Depot-managed environments |
| `DEPOT_CACHE_HOST` | Cache endpoint for `gocache`/`cargo` |
| `DEPOT_SANDBOX_ID` | Set inside a Depot sandbox; forces `depot claude` local mode |
| `DEPOT_PUSH_REGISTRY_USERNAME` / `_PASSWORD` | `depot push` creds |
| `DEPOT_MATRIX_JOB_INDEX` / `_TOTAL` | Auto test sharding in Depot CI matrix jobs |
| `DEPOT_NO_SUMMARY_LINK`, `DEPOT_DEBUG_OIDC`, `DEPOT_SECRET`, `DEPOT_VAR`, `DEPOT_SECRET_MIGRATION_*` | Misc |
| `DEPOT_API_TOKEN` | Legacy, seen in login tests |

Config file: `~/.config/depot/depot.yaml` (`api_token`, `org_id`), mode 0600. Project pin: `depot.json` → `{"id": "PROJECT_ID"}`.

Install: Homebrew (`depot/homebrew-tap`), install script, `depot/setup-action` for GHA, asdf plugin.

## 7. SDKs

| SDK | Package | Version | Last publish | Status |
| --- | --- | --- | --- | --- |
| Node.js | [`@depot/sdk-node`](https://github.com/depot/sdk-node) | **2.0.0** | **2025-09-17** | Official, but ~12 months stale |
| Go | [`depot/depot-go`](https://github.com/depot/depot-go) | module | 2026-07-06 | Official, actively maintained |
| Python | [`depot/sdk-python`](https://github.com/depot/sdk-python) | — | 2025-04-24 | **"WIP Python SDK for Depot Admin API"** — raw `_pb2.py`/`_pb2_grpc.py` only, no package, don't use |
| Sandbox (TS) | [`depot/sandbox-sdk`](https://github.com/depot/sandbox-sdk) | — | 2026-06-13 | **Private beta**, API may change |

### `@depot/sdk-node` in detail

```ts
import {depot} from '@depot/sdk-node'
const headers = {Authorization: `Bearer ${process.env.DEPOT_TOKEN}`}
const result = await depot.core.v1.ProjectService.listProjects({}, {headers})
```

- Deps: `@connectrpc/connect@^2.1.0`, `@connectrpc/connect-node@^2.1.0`; peer `@bufbuild/protobuf@>=2 <3`.
- Transport is a **module-level singleton** created at import time: `createConnectTransport({baseUrl: process.env.DEPOT_API_URL ?? 'https://api.depot.dev', httpVersion: '2'})`. Base URL is fixed at import; you cannot pass a per-call base URL. Auth is per-call via `{headers}`.
- Exposes only: `build.v1.BuildService`, `build.v1.RegistryService`, `buildkit.v1.BuildKitService`, `core.v1.BuildService`, `core.v1.ProjectService`, `core.v1.UsageService`, `core.v1.OrganizationService`.
- **Does not expose `depot.ci.v1` at all**, nor `registry.v1beta1` or `code.v1beta1`. Its generated code predates them.
- README says authentication uses an **Organization Token**.

The gap is decisive for design: **the most agent-relevant API (Depot CI) has no SDK coverage in any language.** Go's `depot-go` is build-focused too (`build/`, `machine/`, `project/`, `proto/depot/cli/v1`).

### Depot's own agent integration: Skills, not MCP

[`depot/skills`](https://github.com/depot/skills) (updated 2026-09-02) ships four official Agent Skills with a `.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`, and `agents/openai.yaml` metadata:

| Skill | Size | Covers |
| --- | --- | --- |
| `depot-ci` | 22.7 KB + 5 reference files (~53 KB) | `depot ci migrate`, secrets/vars, running workflows, GHA compatibility, OIDC, **`runs-and-debugging.md` (24.8 KB)**, test splitting |
| `depot-container-builds` | 13.7 KB | `depot build`, `bake`, multi-platform, caching, Registry, Docker migration |
| `depot-github-runners` | 9.4 KB | Managed GHA runners, labels/sizes, caching, Dagger, Dependabot, egress filtering |
| `depot-general` | 12.0 KB | Install, auth (tokens, OIDC), project setup, org management, API, pricing |

The `depot-ci` skill opens with: *"Depot CI is a programmable CI system for engineers and agents."* It explicitly instructs agents to use `-o json` and documents the org-context gotcha. This tells us three things: (1) Depot considers the CLI's JSON output a deliberate agent contract, (2) the CLI is the surface Depot expects agents to drive, and (3) Depot's chosen distribution mechanism for agent capability is **Skills, not an MCP server** — so an MCP server is complementary rather than duplicative, and can reasonably borrow Skills' framing.

Also relevant: Depot docs are agent-friendly by design — `https://depot.dev/docs/llms.txt` is a site index, and **appending `.md` to any docs/blog/changelog URL returns its markdown source**.

## 8. Streaming, polling, and log volume

| Concern | Finding |
| --- | --- |
| Live CI logs, no streaming client | `GetJobAttemptLogs` is **unary** with `pageToken`; poll it. Docs explicitly bless this: "Poll with `pageToken` to fetch lines persisted after a previous response" |
| Live CI logs, streaming | `StreamJobAttemptLogs` server-stream, resumable via `cursor`, carries `attemptStatus` inline |
| Finite log snapshot | `ExportJobAttemptLogs` server-stream: one `metadata` message, then `chunk` bytes |
| **Concurrency cap** | `resource_exhausted`/429 for "too many concurrent log streams for the token, organization, or attempt" |
| **Stream duration cap** | Same code for "a log stream or export that exceeded its maximum duration" — undocumented value |
| Metrics size cap | Same code for "a metrics result that is too large" |
| Duplicate lines | Expected on stream reconnect. CLI dedupes with a 4096-entry LRU |
| Retry policy | CLI retries `unavailable`, `deadline_exceeded`, `aborted`; 250 ms → 30 s exponential backoff |
| Container build logs | `GetBuildSteps` (with `hasLogs`, `cacheState`, per-step `error`) then `GetBuildStepLogs` per step digest. Both unary + paginated. **No streaming, no server-side diagnosis** |
| Build progress | Not exposed as an API. `Build.cachedSteps`/`totalSteps` give coarse completion; `ReportTimings`/`ReportStatus` are CLI→server, not readable |
| Log truncation guidance | Only `GetFailureDiagnosis` bounds output server-side (`bounds.*` limits, `truncated`, `omitted*Count`). Raw log RPCs are unbounded — the caller must cap |

## 9. Things a wrapper genuinely cannot do

1. **Run a container build via API.** Requires local build context + embedded BuildKit client. Shell out to `depot build`/`bake`, or use Depot CI.
2. **Enumerate distributed cache entries.** `depot.cache.v1.ListEntries` is internal only.
3. **Read a secret's value.** By design — `SecretService` returns metadata only.
4. **Inspect GitHub Actions runner jobs individually.** Only aggregate `GithubActionsJobsUsage` via `UsageService.GetUsage`. There is no runner/job list API. (Depot CI runs *are* fully queryable; managed *GHA runners* are not.)
5. **Switch org server-side.** `depot org switch` only writes local config; pass `x-depot-org` per request.
6. **Get granular token scopes.** No read-only tokens exist for CI or the API.
7. **List or revoke pull tokens.** Not surfaced in the dashboard or API.
8. **Test results via a supported API.** `testresults.v1` is internal; `depot tests --output json` is the documented path.

## 10. Source index

| What | Where |
| --- | --- |
| Public protos | <https://github.com/depot/proto> → `proto/depot/{core/v1,build/v1,buildkit/v1,registry/v1beta1,code/v1beta1}` |
| BSR module | `buf.build/depot/api` · docs at `https://buf.build/depot/api/docs/main:<package>` |
| CLI source | <https://github.com/depot/cli> — `pkg/cmd/root/root.go`, `pkg/api/{rpc,ci,auth}.go`, `pkg/config/config.go`, `pkg/helpers/token.go`, `pkg/cmd/ci/diagnose.go`, vendored protos in `pkg/proto/depot/**` |
| Node SDK | <https://github.com/depot/sdk-node> · `@depot/sdk-node@2.0.0` |
| Go SDK | <https://github.com/depot/depot-go> (also `proto/depot/cli/v1/build.proto`) |
| Official Agent Skills | <https://github.com/depot/skills> |
| Depot CI API reference | <https://depot.dev/docs/api/ci/reference> |
| API overview | <https://depot.dev/docs/api/overview> |
| SDK reference | <https://depot.dev/docs/api/sdk-reference> |
| Authentication | <https://depot.dev/docs/cli/authentication> |
| CLI reference (platform) | <https://depot.dev/docs/cli/reference> |
| CLI reference (CI) | <https://depot.dev/docs/cli/reference/depot-ci> |
| CLI reference (builds) | <https://depot.dev/docs/cli/reference/container-builds> |
| CLI reference (agents) | <https://depot.dev/docs/cli/reference/agents> |
| Manage workflow runs | <https://depot.dev/docs/ci/how-to-guides/manage-workflow-runs> |
| Docs index for agents | <https://depot.dev/docs/llms.txt> (and `.md` suffix on any docs URL) |
