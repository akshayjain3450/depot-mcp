# Which Depot token can do what

Depot has three kinds of API token, and they are not interchangeable. This page lists exactly what each one can do through depot-mcp. Everything here was verified live against Depot's API on 2026-09-06 with two tokens from the same organization, one of them a user token belonging to an organization owner.

The short version: **use an Organization token.** It runs every tool, the opt-in write tools included. A user token runs the CI tools, the registry tool, and `depot_whoami`, but Depot's project, build, and usage services refuse it no matter what role the user has.
The short version: **use an Organization token.** It runs every tool, including the opt-in write tools; creating a project needs one. A user token runs the CI tools, the registry tool, and `depot_whoami`, but Depot's project, build, and usage services refuse it no matter what role the user has.

## By tool

| Tool | Organization token | User token |
| --- | --- | --- |
| `depot_whoami` | yes | yes |
| `depot_diagnose_ci_failure` | yes | yes |
| `depot_list_ci_runs` | yes | yes |
| `depot_get_ci_run` | yes | yes |
| `depot_get_ci_job`, `depot_get_ci_attempt`, `depot_list_ci_workflows`, `depot_get_ci_workflow` | yes | yes (same `depot.ci.v1` service as the tools above) |
| `depot_wait_for_ci_run` | yes | yes |
| `depot_get_ci_logs` | yes | yes |
| `depot_get_ci_job_summary` | yes | yes |
| `depot_get_ci_metrics` | yes | yes |
| `depot_list_ci_artifacts` | yes | yes |
| `depot_get_ci_artifact_url` | yes | yes |
| `depot_list_ci_secrets` | yes | yes, if the user is an organization admin or owner (members get `permission_denied`) |
| `depot_list_ci_variables` | yes | same as secrets |
| `depot_list_images` | yes | yes |
| `depot_list_projects` | yes | **no** (`401 Invalid token`) |
| `depot_get_project` | yes | **no** |
| `depot_list_builds` | yes | **no** |
| `depot_get_build` | yes | **no** |
| `depot_diagnose_build` | yes | **no** (needs `GetBuild`, which refuses user tokens; the step endpoints themselves accept them) |
| `depot_get_usage` | yes | **no** |
| `depot_audit_trust_policies` | yes | **no** (same `ProjectService` calls as `depot_get_project`) |
| `depot_list_project_tokens` | yes | **no** (`ProjectService`) |
| `depot_list_project_usage` | yes | **no** (`UsageService`) |
| `depot_get_cache_summary` | yes | **no** (projects, builds, and usage) |
| Beta `depot_list_sandboxes` (`DEPOT_MCP_ENABLE_BETA`) | yes | yes (verified 2026-09-07: an empty list, no error) |
| Beta `depot_get_sandbox` | yes | expected yes (same `SandboxService`; not exercised, the organization had no sandbox) |
| Beta `depot_list_registry_repositories` | yes | **no** (`401 Invalid token`, verified 2026-09-07) |
| Beta `depot_get_registry_image` | yes | **no** (same `depot.registry.v1beta1` service) |
| `depot_set_ci_variable` (write, opt-in) | yes | same as secrets: admins and owners |
| `depot_delete_ci_variable` (write, opt-in) | yes | same as secrets: admins and owners |
| `depot_create_project` (write, opt-in) | yes | **no** (`ProjectService` refuses user tokens; the dry run fails at `ListProjects`) |
| `depot_dispatch_ci_workflow` (write, opt-in) | dry run verified 2026-09-07 (`ListWorkflows`); apply expected to work (same `depot.ci.v1` service as `depot ci dispatch`) | expected yes, not verified |
| `depot_stop_sandbox`, `depot_kill_sandbox` (write, opt-in, beta) | dry run verified 2026-09-07 for the `not_found` path only, the organization had no sandbox; apply not exercised | expected yes (`SandboxService` accepts user tokens for `ListSandboxes`), not verified |
| Prompt `diagnose-latest-failure` | yes | yes |
| Prompt `explain-build-slowness` | yes | **no** (uses projects, builds, and usage) |
| Write tools (`DEPOT_MCP_ALLOW_WRITES`): `depot_cancel_ci_run`, `depot_cancel_ci_job`, `depot_retry_ci_failed_jobs`, `depot_retry_ci_job`, `depot_rerun_ci_workflow` | dry run verified; apply expected to work (same CI service) | expected to work for both steps, not yet verified |

Project tokens run nothing here: Depot's own scope matrix excludes them from Depot CI and from the API. Verified 2026-09-07 with `npm run verify`: every RPC answered `401 Invalid token`, and `depot_whoami` reports the kind as `unknown`.

The beta rows were verified on 2026-09-06 with an Organization token and on 2026-09-07 with a user token belonging to an organization owner (`npm run verify`, see [verification.md](./verification.md)). The sandbox service accepts both kinds; the registry v1beta1 service refuses user tokens the way the core services do. The beta tools stay behind `DEPOT_MCP_ENABLE_BETA` because their upstream contract is unpublished, not because of the token column.
## Write tools

The six Depot CI write tools (the five above plus `depot_dispatch_ci_workflow`) call `depot.ci.v1.CIService` only, the same service every CI read tool uses, and that service accepts both token kinds. The two sandbox writes call `depot.sandbox.v1.SandboxService`, which accepted a user token for `ListSandboxes`; their apply path has not been exercised with either kind. Their dry-run step (the reads `GetRunStatus`, `GetJob`, `GetWorkflow`) has been verified live with an Organization token. The apply step (`CancelRun`, `CancelWorkflow`, `CancelJob`, `RetryJob`, `RetryFailedJobs`, `RerunWorkflow`) has not been exercised against Depot with either token kind; nothing in Depot's scope matrix suggests it would differ from the reads.

Write tools planned on the roadmap for Depot's core services (`depot_create_project` on `depot.core.v1.ProjectService`, for example) will need an Organization token, since those services refuse user tokens for reads and there is no reason to expect writes to differ.

Whatever the token kind, the token is not what keeps writes from happening: `DEPOT_MCP_ALLOW_WRITES` is. See below.

## By Depot service

For anyone extending the server. "Refuses" means Depot answers `401 unauthenticated, Invalid token` for that token kind regardless of the caller's role.

| Depot service | Organization token | User token |
| --- | --- | --- |
| `depot.core.v1.OrganizationService` (`ListOrganizations`) | **refuses** (the token is not tied to a user, so there is no "my organizations") | accepts |
| `depot.core.v1.ProjectService` (projects, trust policies) | accepts | **refuses** |
| `depot.core.v1.BuildService` (`ListBuilds`, `GetBuild`) | accepts | **refuses** |
| `depot.core.v1.UsageService` | accepts | **refuses** |
| `depot.build.v1.BuildService` (`GetBuildSteps`, `GetBuildStepLogs`) | accepts | accepts |
| `depot.build.v1.RegistryService` (`ListImages`) | accepts | accepts |
| `depot.ci.v1.CIService` (runs, logs, metrics, artifacts, diagnosis) | accepts | accepts |
| `depot.ci.v3beta2` secrets and variables | accepts | accepts for admins and owners; `403` for members |
| `depot.sandbox.v1.SandboxService` (`ListSandboxes`, `GetSandbox`; `StopSandbox`, `KillSandbox` behind both gates) | accepts | accepts (`ListSandboxes` verified 2026-09-07) |
| `depot.registry.v1beta1.RegistryService` (`ListRepositories`, `ListImages`, `GetImageDetail`, `GetRetentionPolicy`, `ListTokens`) | accepts | **refuses** (`ListRepositories` verified 2026-09-07) |

Two consequences follow:

- **No single token can call every service.** Each kind is refused by one side. `depot_whoami` uses the pair of answers to tell which kind it holds, and reads the organization id from the projects when it holds an Organization token.
- **Owner or member makes no difference to the core services.** The check is on the token kind. The user's role only matters for CI secrets and variables.

## How to get each token

| Token | Where | Who can create it |
| --- | --- | --- |
| Organization token | Depot dashboard, the organization, Organization Settings, API Tokens | organization admins and owners |
| User token | Depot dashboard, your avatar, Account settings, API Tokens; or `depot login`, which stores it in `~/Library/Application Support/depot/depot.yaml` on macOS and `~/.config/depot/depot.yaml` on Linux | any user |
| Project token | project Settings, Project Tokens | not usable with this server |

Create a dedicated token for this server, named for the person and the purpose (for example "depot-mcp, Akshay"), so it can be revoked on its own. Put it in your MCP client's config for `DEPOT_TOKEN`; never commit it.

## What no token can do

- **Start a container build.** Depot has no API for it. A build means acquiring a BuildKit endpoint over mTLS and streaming the local build context, which only the `depot` CLI does. This server observes builds; it never starts them.
- **Restrict a token to read-only.** Depot has no read-only scope. An Organization token that can list runs can also cancel runs and delete projects. This server is read-only because it registers no mutating tool unless `DEPOT_MCP_ALLOW_WRITES` is set, not because the token is limited. With the flag set, every write tool dry-runs first and refuses server-side before calling Depot. See the [security section of the README](../README.md#read-only-model-and-security).
- **Restrict a token to read-only.** Depot has no read-only scope. An Organization token that can list runs can also cancel runs and delete projects. This server is read-only by default because it registers no mutating tool unless `DEPOT_MCP_ALLOW_WRITES` is set, not because the token is limited. See the [security section of the README](../README.md#read-only-model-and-security).

## If your token is the wrong kind

Call `depot_whoami`. It reports the token kind, which organization and projects it can see, and, for a user token, the exact tools that will fail and where to get an Organization token. The smoke script (`npm run smoke`) prints the same explanation.
