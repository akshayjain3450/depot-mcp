# Which Depot token can do what

Depot has three kinds of API token, and they are not interchangeable. This page lists exactly what each one can do through depot-mcp. Everything here was verified live against Depot's API on 2026-09-06 with two tokens from the same organization, one of them a user token belonging to an organization owner.

The short version: **use an Organization token.** It runs every tool. A user token runs the CI tools, the registry tool, and `depot_whoami`, but Depot's project, build, and usage services refuse it no matter what role the user has.

## By tool

| Tool | Organization token | User token |
| --- | --- | --- |
| `depot_whoami` | yes | yes |
| `depot_diagnose_ci_failure` | yes | yes |
| `depot_list_ci_runs` | yes | yes |
| `depot_get_ci_run` | yes | yes |
| `depot_get_ci_logs` | yes | yes |
| `depot_get_ci_job_summary` | yes | yes |
| `depot_get_ci_metrics` | yes | yes |
| `depot_list_ci_artifacts` | yes | yes |
| `depot_list_ci_secrets` | yes | yes, if the user is an organization admin or owner (members get `permission_denied`) |
| `depot_list_ci_variables` | yes | same as secrets |
| `depot_list_images` | yes | yes |
| `depot_list_projects` | yes | **no** (`401 Invalid token`) |
| `depot_get_project` | yes | **no** |
| `depot_list_builds` | yes | **no** |
| `depot_diagnose_build` | yes | **no** (needs `GetBuild`, which refuses user tokens; the step endpoints themselves accept them) |
| `depot_get_usage` | yes | **no** |
| Prompt `diagnose-latest-failure` | yes | yes |
| Prompt `explain-build-slowness` | yes | **no** (uses projects, builds, and usage) |

Project tokens run nothing here: Depot's own scope matrix excludes them from Depot CI and from the API.

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
- **Restrict a token to read-only.** Depot has no read-only scope. An Organization token that can list runs can also cancel runs and delete projects. This server is read-only because it registers no mutating tool, not because the token is limited. See the [security section of the README](../README.md#read-only-model-and-security).

## If your token is the wrong kind

Call `depot_whoami`. It reports the token kind, which organization and projects it can see, and, for a user token, the exact tools that will fail and where to get an Organization token. The smoke script (`npm run smoke`) prints the same explanation.
