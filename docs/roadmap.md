# Tool roadmap

What depot-mcp exposes, what Depot's API would allow, and which of it should become a tool. First compiled 2026-09-06 from `research/depot-api-surface.md`, Depot's published protos and CLI reference, and the live verification recorded in the changelog; updated as tools ship.

Two constraints shape every decision here:

- **Depot has no read-only token.** Any token that can list runs can also cancel them and delete projects. The tool list is the only safety boundary, so every write is opt-in and every irreversible operation is excluded outright.
- **Tool count has a cost.** Every tool's name and description is sent to the model on every request. Past roughly forty tools, models choose worse and each call costs more. The always-on surface therefore stays under thirty, with the gated tools invisible unless enabled.

## Today

28 always-on read-only tools, 4 read-only beta tools behind `DEPOT_MCP_ENABLE_BETA`, 8 write tools behind `DEPOT_MCP_ALLOW_WRITES`, 7 prompts, 4 resources. Everything below is on `main` unless marked otherwise; the 0.1.1 release carries only the first 16 tools and 2 prompts.

### Always on

| Group | Tool | Depot RPCs |
| --- | --- | --- |
| Orientation | `depot_whoami` | `ListOrganizations`, `ListProjects` |
| CI diagnosis | `depot_diagnose_ci_failure` | `GetFailureDiagnosis` |
| CI | `depot_list_ci_runs` | `ListRuns` |
| CI | `depot_get_ci_run` | `GetRun`, `GetRunStatus` |
| CI | `depot_get_ci_job` | `GetJob` |
| CI | `depot_get_ci_attempt` | `GetAttempt` |
| CI | `depot_list_ci_workflows` | `ListWorkflows` |
| CI | `depot_get_ci_workflow` | `GetWorkflow` |
| CI | `depot_wait_for_ci_run` | `GetRunStatus`, polled at a bounded interval up to a bounded timeout |
| CI | `depot_get_ci_logs` | `GetJobAttemptLogs` (plus `GetRunStatus` to resolve ids) |
| CI | `depot_get_ci_job_summary` | `GetJobSummary` |
| CI | `depot_get_ci_metrics` | `GetRunMetrics`, `GetJobMetrics`, `GetJobAttemptMetrics` |
| CI | `depot_list_ci_artifacts` | `ListArtifacts`, `GetArtifactDownloadURL` on request |
| CI | `depot_get_ci_artifact_url` | `GetArtifactDownloadURL` |
| CI | `depot_compare_ci_runs` | `GetRun`, `GetRunStatus`, `GetRunMetrics`, `GetFailureDiagnosis` per failed side |
| Builds | `depot_diagnose_build` | `GetBuild`, `GetBuildSteps`, `GetBuildStepLogs` (binary encoding) |
| Builds | `depot_get_build` | `GetBuild` |
| Builds | `depot_list_builds` | `ListBuilds` |
| Projects | `depot_list_projects` | `ListProjects` |
| Projects | `depot_get_project` | `GetProject`, `ListTrustPolicies` |
| Projects | `depot_audit_trust_policies` | `ListProjects`, `ListTrustPolicies` |
| Projects | `depot_list_project_tokens` | `ListTokens` (metadata only, output allowlisted) |
| Usage | `depot_get_usage` | `GetUsage`, `GetProjectUsage` |
| Usage | `depot_list_project_usage` | `ListProjectUsage`, `ListProjects` for names |
| Usage | `depot_get_cache_summary` | `GetProject`, `ListProjectUsage`, `ListBuilds`, `GetUsage` |
| Registry | `depot_list_images` | `ListImages` |
| CI config | `depot_list_ci_secrets` | `ListSecrets` (names and scoping only) |
| CI config | `depot_list_ci_variables` | `ListVariables` (values redacted when credential-shaped) |

### Beta, behind `DEPOT_MCP_ENABLE_BETA`

Read-only, verified live 2026-09-06 with an Organization token (empty lists on the trial organization; `not_found` for unknown ids). Gated because the APIs are private beta or published only as protos, and because the user-token column is untested.

| Group | Tool | Depot RPCs |
| --- | --- | --- |
| Sandboxes | `depot_list_sandboxes` | `depot.sandbox.v1.SandboxService/ListSandboxes` |
| Sandboxes | `depot_get_sandbox` | `depot.sandbox.v1.SandboxService/GetSandbox` |
| Registry | `depot_list_registry_repositories` | `depot.registry.v1beta1.RegistryService/ListRepositories`, `GetRetentionPolicy` |
| Registry | `depot_get_registry_image` | `depot.registry.v1beta1.RegistryService/GetImageDetail` (manifest decoded and summarised) |

Probed and accepted but not exposed: `RegistryService/ListImages` (needs a `repository`; `depot_list_images` already covers the project view) and `RegistryService/ListTokens`.

### Writes, behind `DEPOT_MCP_ALLOW_WRITES`

Every write tool defaults to `dryRun: true`, previews from Depot's read RPCs, refuses unsafe preconditions before any mutating RPC, and logs one audit line to stderr per applied write. All dry-run paths are verified live; **no mutating RPC has been called against Depot yet.**

| Tool | Depot RPC | Refuses |
| --- | --- | --- |
| `depot_cancel_ci_run` | `CancelRun`, or `CancelWorkflow` with `workflowId` | terminal targets; a workflow outside the named run |
| `depot_cancel_ci_job` | `CancelJob` | a terminal job; a job outside the named run |
| `depot_retry_ci_failed_jobs` | `RetryFailedJobs` | a running workflow; zero failed jobs; an ambiguous run; any job at 3 or more attempts unless forced |
| `depot_retry_ci_job` | `RetryJob` | a job that did not fail; the same attempt cap |
| `depot_rerun_ci_workflow` | `RerunWorkflow` | a running workflow; a full rerun when a failed subset exists, unless allowed |
| `depot_set_ci_variable` | `SetVariableVariant` | a credential-shaped value; a name that belongs to a secret |
| `depot_delete_ci_variable` | `DeleteVariableVariant`, `DeleteVariable` | a selector matching zero or many variants; a whole-variable delete unless asked |
| `depot_create_project` | `CreateProject` | a duplicate name unless allowed; an unknown region |

Two copies of the write helper exist (`src/lib/write.ts` for the CI writes, `src/lib/write-config.ts` for the variable and project writes); they were built in parallel from the same specification and should be unified in a follow-up.

### Prompts and resources

Prompts: `diagnose-latest-failure`, `explain-build-slowness`, `triage-failures-today`, `compare-ci-runs`, `cache-audit`, `debug-missing-secret`, `watch-run`. Resources, as templates without subscriptions: `depot://ci/run/{runId}`, `depot://ci/runs/failed`, `depot://project/{projectId}/builds`, `depot://projects`.

## Not yet built

| Tool | Depot RPCs | Why it is still pending |
| --- | --- | --- |
| `depot_list_test_results` | none public; `depot tests --output json` via the CLI | Only reachable by shelling out to the `depot` binary, which this server does not require. Needs a `DEPOT_MCP_USE_CLI` opt-in. |
| `depot_dispatch_ci_workflow` | `DispatchWorkflow` | A write that can deploy to production if the workflow does; wants an allowlist design and a live verification plan before it exists. |

Deliberately not added: standalone secret and variable getters (the list tools with filters already answer the question), organization details (no RPC beyond `ListOrganizations`, which Organization tokens cannot call), and the log streaming RPCs (Depot caps concurrent streams per organization, so a careless tool could starve real CI).

## Verification still owed

- The apply path of every write tool, against a throwaway run in a trial organization, with explicit approval.
- Beta tools with a user token.
- `GetJob` carries no dependency-job list despite the API survey; if Depot adds one, `depot_get_ci_job` should surface it.

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

## Counts

| | Tools | Prompts | Resources |
| --- | --- | --- | --- |
| 0.1.1 (released) | 16 | 2 | 0 |
| `main` today, always on | 28 | 7 | 4 |
| behind `DEPOT_MCP_ENABLE_BETA` | +4 | | |
| behind `DEPOT_MCP_ALLOW_WRITES` | +8 | | |
| Still pending | +2 | | |

For scale, the one known third-party codebase with Depot tools ships 46, of which 15 are writes this project excludes permanently. This surface is comparable on reads, adds sandbox and registry reads it lacks, and contains none of the credential or deletion operations.
