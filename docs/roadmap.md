# Tool roadmap

What depot-mcp exposes today, what Depot's API would allow, and which of it should become a tool. Compiled 2026-09-06 from `research/depot-api-surface.md`, Depot's published protos and CLI reference, and the live verification in this repository's changelog. Risk tiers are the project's own judgement, not Depot's.

Two constraints shape every decision here:

- **Depot has no read-only token.** Any token that can list runs can also cancel them and delete projects. The tool list is the only safety boundary, so every write is opt-in and every irreversible operation is excluded outright.
- **Tool count has a cost.** Every tool's name and description is sent to the model on every request. Past roughly forty tools, models choose worse and each call costs more. The roadmap ends at 42, with the gated ones invisible unless enabled.

## Today: 16 tools, 2 prompts

All read-only, all registered unconditionally.

| Group | Tool | Depot RPCs |
| --- | --- | --- |
| Orientation | `depot_whoami` | `ListOrganizations`, `ListProjects` |
| CI diagnosis | `depot_diagnose_ci_failure` | `GetFailureDiagnosis` |
| CI | `depot_list_ci_runs` | `ListRuns` |
| CI | `depot_get_ci_run` | `GetRun`, `GetRunStatus` |
| CI | `depot_get_ci_logs` | `GetJobAttemptLogs` (plus `GetRunStatus` to resolve ids) |
| CI | `depot_get_ci_job_summary` | `GetJobSummary` |
| CI | `depot_get_ci_metrics` | `GetRunMetrics`, `GetJobMetrics`, `GetJobAttemptMetrics` |
| CI | `depot_list_ci_artifacts` | `ListArtifacts`, `GetArtifactDownloadURL` on request |
| Builds | `depot_diagnose_build` | `GetBuild`, `GetBuildSteps`, `GetBuildStepLogs` (binary encoding) |
| Builds | `depot_list_builds` | `ListBuilds` |
| Projects | `depot_list_projects` | `ListProjects` |
| Projects | `depot_get_project` | `GetProject`, `ListTrustPolicies` |
| Usage | `depot_get_usage` | `GetUsage`, `GetProjectUsage` |
| Registry | `depot_list_images` | `ListImages` |
| CI config | `depot_list_ci_secrets` | `ListSecrets` (names and scoping only) |
| CI config | `depot_list_ci_variables` | `ListVariables` (values redacted when credential-shaped) |

Prompts: `diagnose-latest-failure` and `explain-build-slowness`.

## 0.2: read additions

Twelve always-on tools, ordered by value. Rows marked **shipped** are in the current `Unreleased` changelog section.

| Tool | Depot RPCs | What it answers |
| --- | --- | --- |
| `depot_get_ci_job` | `GetJob` | One job with its dependency jobs and every attempt. The gap between the run tree and the logs. |
| `depot_get_ci_attempt` | `GetAttempt` | One attempt's status, timing, and sandbox identifiers. |
| `depot_list_ci_workflows` | `ListWorkflows` | Workflow runs filtered by name, repo, status, trigger, sha, or PR, with job counts. Defaults to every status, since Depot returns nothing without a status filter. |
| `depot_get_ci_workflow` | `GetWorkflow` | Execution history including rerun and retry lineage. Prerequisite for the 0.3 rerun previews. |
| `depot_wait_for_ci_run` | `GetRunStatus`, polled | Waits up to a bounded timeout for a run to finish, reporting which nodes changed. Polls the unary RPC only; never the streaming ones. |
| `depot_get_ci_artifact_url` | `GetArtifactDownloadURL` | A short-lived signed download URL for one artifact, never logged. |
| `depot_list_project_usage` (**shipped**) | `ListProjectUsage`, `ListProjects` for names | Every project's build count, build seconds, and layer cache size in one call. Organization token only. |
| `depot_get_cache_summary` (**shipped**) | `GetProject`, `ListProjectUsage`, `ListBuilds`, `GetUsage` | Cache policy versus current cache size, hit ratio over recent builds, minutes saved. Entry-level listing is impossible; the tool says so. |
| `depot_compare_ci_runs` | `GetRunStatus`, `GetRunMetrics`, `GetFailureDiagnosis` | Job status, duration, and peak memory deltas between two runs, plus failures new in one of them. Ship as a prompt first. |
| `depot_get_build` | `GetBuild` | One build's status, timing, and cache counters. The build-side wait primitive. |
| `depot_list_project_tokens` (**shipped**) | `ListTokens` | Credential inventory: id and description (depot/proto defines nothing else on the list response; the secret only exists in `CreateToken`'s reply). Verified live 2026-09-06; the tool allowlists its output fields so a future field cannot leak by default. |
| `depot_audit_trust_policies` (**shipped**) | `ListProjects`, `ListTrustPolicies` | Which external CI identities can build into which project, organization-wide. |

Five more behind a beta flag until verified live with both token kinds, because their APIs are private beta or documented only in protos: `depot_list_sandboxes`, `depot_get_sandbox` (`depot.sandbox.v1`), `depot_list_registry_repositories`, `depot_get_registry_image` (`depot.registry.v1beta1`), and `depot_list_test_results` (only reachable by shelling out to `depot tests --output json`, so it also needs the CLI).

Deliberately not added: standalone secret and variable getters (the list tools with filters already answer the question), organization details (no RPC beyond `ListOrganizations`, which Organization tokens cannot call), and the log streaming RPCs (Depot caps concurrent streams per organization, so a careless tool could starve real CI).

## 0.3: first write tools

Nine tools, registered only when `DEPOT_MCP_ALLOW_WRITES=1`, so a client without the flag never sees them. The registration gate already exists in `src/tools/index.ts`.

Every write tool follows one pattern:

- `dryRun` defaults to **true**. A dry run reads the current state with the matching read RPC and returns a preview plus the exact arguments to resend with `dryRun: false`. Where the client supports elicitation, ask for confirmation there instead.
- Preconditions are checked server-side first, so the model gets a reason rather than Depot's `412`.
- One audit line to stderr per applied write.
- Annotations: `readOnlyHint: false`; `destructiveHint` true only for cancel and delete; `idempotentHint` false for anything that creates a new attempt or run.
- Never accept inline workflow content, secret values, or token descriptions.

| Tool | Depot RPC | Refuses |
| --- | --- | --- |
| `depot_cancel_ci_run` | `CancelRun` (or `CancelWorkflow`) | a run that is already terminal |
| `depot_cancel_ci_job` | `CancelJob` | a terminal job, or one not in the named run |
| `depot_retry_ci_failed_jobs` | `RetryFailedJobs` | a workflow still running; zero failed jobs; any job already at three attempts unless forced; an ambiguous run with several workflows |
| `depot_retry_ci_job` | `RetryJob` | a job that did not fail; the same attempt cap |
| `depot_rerun_ci_workflow` | `RerunWorkflow` | a running workflow; a full rerun when a failed subset exists, pointing at the retry tool instead |
| `depot_dispatch_ci_workflow` | `DispatchWorkflow` | a workflow path with a slash (basename only), an empty ref, a malformed repo, oversized inputs, and optionally anything outside an allowlist. Its description says plainly that this can deploy to production if the workflow does. |
| `depot_set_ci_variable` | `SetVariableVariant` | a credential-shaped value (the redaction rules decide), a name that collides with a secret |
| `depot_delete_ci_variable` | `DeleteVariableVariant` | a whole-variable delete unless asked for; a selector matching zero or many variants |
| `depot_create_project` | `CreateProject` | a duplicate name unless allowed; an unknown region. Organization token only. |

## Permanently excluded

| Operation | Reason |
| --- | --- |
| `CIService/Run` | Accepts inline workflow content: remote code execution on your infrastructure with a billing meter. |
| `ProjectService/ResetProject` | Destroys all cached data, and to a model looks like "clear the cache to fix my build". |
| `ProjectService/DeleteProject`, `UpdateProject` | Irreversible, or silently changes cost and evicts cache. Dashboard acts. |
| Token creation, update, or revocation, on projects or the registry | Mints or revokes long-lived credentials; creation returns the secret into the transcript. |
| Trust policy add or remove | Grants or revokes an external CI identity's access to a project, the same blast radius as a token. |
| Secret creation, update, or deletion | Secret values through a model, or unrecoverable deletion of them. |
| Image, tag, repository, and retention-policy deletion | Irreversible deletion of artifacts something may be deploying. |
| `ShareBuild` | Creates a public URL: data exposure disguised as a read. |
| Build-protocol and BuildKit RPCs | Plumbing; the CLI is the only way to run a build. |
| Log streaming and export RPCs | Undocumented per-organization concurrency caps; a follow tool can starve the organization's own CI. |
| Sandbox creation and command or file execution | Arbitrary code execution and billable compute in a different product. |
| Internal, unversioned services (`depot.cli.v1`, `agent.v1`, `cache.v1`, `testresults.v1`, `ci.v2`) | Will break without notice. |

## Prompts and resources

Resources, as templates without subscriptions: `depot://ci/run/{runId}` (the run tree), `depot://ci/runs/failed` (last 20 failed runs), `depot://project/{projectId}/builds`, and `depot://projects`.

Prompts: `triage-failures-today` (group the day's failures by fingerprint, diagnose the distinct ones, mark recurring versus new), `compare-ci-runs`, `cache-audit`, `debug-missing-secret` (which variant would match a repo, branch, and workflow, and why the job did not see it), and `watch-run` (wait, then diagnose or list artifacts).

## Counts

| | Tools | Prompts | Resources |
| --- | --- | --- | --- |
| Today (0.1) | 16 | 2 | 0 |
| 0.2 reads, always on (4 of 12 shipped) | +12 | +5 | +4 |
| 0.2 reads, beta-gated | +5 | | |
| 0.3 writes, flag-gated | +9 | | |
| End of roadmap | 42 | 7 | 4 |

For scale, the one known third-party codebase with Depot tools ships 46, of which 15 are writes this project excludes permanently. This roadmap reaches a comparable read surface, plus sandbox and registry reads it lacks, with none of the credential or deletion operations.
