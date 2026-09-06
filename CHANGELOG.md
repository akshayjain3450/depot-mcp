# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Tool names are part of the public interface: renaming or removing one is a breaking change.

## [Unreleased]

### Added

- `DEPOT_MCP_ENABLE_BETA` registers four read-only tools built on Depot APIs that are published only as protos, one of them beta in its name. They are hidden unless the flag is set, every description says the API may change, and `depot_whoami` reports whether they are on (`betaEnabled`, `betaTools`). Verified live on 2026-09-06 with an Organization token; a user token has not been tried.
  - `depot_list_sandboxes` and `depot_get_sandbox` (`depot.sandbox.v1.SandboxService/ListSandboxes`, `GetSandbox`): sandbox state, runtime image, resources, timing, exit code, error, metered usage. State filter and creation-time window; token paging. Environment variables are returned by name only, never by value.
  - `depot_list_registry_repositories` (`depot.registry.v1beta1.RegistryService/ListRepositories` plus `GetRetentionPolicy` per repository, optional) and `depot_get_registry_image` (`GetImageDetail`, by tag or digest; the raw OCI manifest is base64-decoded and summarised into platforms or layers).
- The startup banner counts beta tools, and the CI stdio smoke checks the count with the flag on or off.

## [0.1.1] - 2026-09-06

First release published with npm trusted publishing (no stored token).

### Fixed

- First live Depot CI run: Depot's diagnosis document uses longer enum names than the CLI's JSON (`FAILURE_DIAGNOSIS_STATE_GROUPED_FAILURES`, `FAILURE_DIAGNOSIS_TARGET_TYPE_RUN`, `DRILL_DOWN_COMMAND_KIND_LOGS`, and so on); they now normalise to `grouped_failures`, `run`, `logs`, so states read correctly and next-step commands map to tools.
- `depot_list_ci_runs` with no status filter returned nothing, because Depot's `ListRuns` answers an empty list unless a status filter is present; the tool now sends every status when the caller gives none.
- `depot_get_ci_logs` strips ANSI colour and hyperlink escape sequences from log lines and labels lines with the step's name (`[Run the test suite]`) instead of its UUID key, when Depot provides one.

## [0.1.0] - 2026-09-06

First release.

### Added

- `docs/tokens.md`: which Depot token kind can call which tool and which Depot service, verified live.

- Read-only MCP server for Depot (depot.dev) over stdio, built on `@modelcontextprotocol/sdk` 1.x, protocol revision `2025-11-25`.
- 16 read-only tools, all annotated `readOnlyHint: true` and `destructiveHint: false`:
  - CI: `depot_diagnose_ci_failure`, `depot_list_ci_runs`, `depot_get_ci_run`, `depot_get_ci_logs`, `depot_get_ci_job_summary`, `depot_get_ci_metrics`, `depot_list_ci_artifacts`, `depot_list_ci_secrets`, `depot_list_ci_variables`.
  - Builds and projects: `depot_diagnose_build`, `depot_list_builds`, `depot_list_projects`, `depot_get_project`, `depot_list_images`, `depot_get_usage`.
  - Orientation: `depot_whoami`, which validates the token and detects the multi-organization ambiguity.
- Two prompts: `diagnose-latest-failure` and `explain-build-slowness`.
- Bounded output on every tool (`DEPOT_MCP_OUTPUT_BUDGET`, `DEPOT_MCP_MAX_LOG_PAGES`) with explicit truncation reporting.
- Credential-shaped CI variable values are redacted before they reach the model.
- `DEPOT_MCP_ALLOW_WRITES` gate, reserved for a future version; enables nothing in 0.1.0.
- Distribution: npm package with `mcpName` for the MCP Registry, `server.json`, an MCPB `manifest.json` for Claude Desktop, a Dockerfile, and a `.mcp.json.example` for Claude Code.
- CI on Node 20 and 22 (typecheck, lint, tests, build, pack, stdio smoke), a tag-triggered npm release workflow with provenance, Dependabot, issue and pull request templates.
- CONTRIBUTING, SECURITY, CODE_OF_CONDUCT.

### Changed

- License is Apache License 2.0 with the Commons Clause License Condition v1.0 (previously MIT during pre-release development). See LICENSE and NOTICE.
- `depot_get_ci_logs` forward paging is an exact cursor: a window that closes mid-page returns a server-issued `nextPageToken`, and following tokens yields every line exactly once. Filters (`grep`, `stepKey`, `stream`) are documented as applied in this server after fetching.
- When `DEPOT_MCP_MAX_LOG_PAGES` stops a log walk, `depot_get_ci_logs` and `depot_diagnose_build` say the log continues and return a continuation token instead of presenting the middle of the log as its tail. New output fields: `pageCapHit`, `lines[].bodyTruncated`, `logPageCapHit`, `logNextPageToken`, `logLinesTruncated`, `failingStep.errorTruncated`.
- Log line bodies, step errors, and Depot's diagnosis and fix text are capped (2000 characters) so one oversized line cannot exceed the output budget through `structuredContent`.
- `depot_get_usage` treats dates as UTC and makes a date-only `endAt` inclusive of that day; unparseable dates are rejected with the field name.
- `depot_list_ci_artifacts` and `depot_list_projects` accept `pageToken`.
- `depot_whoami` warns when `DEPOT_ORG_ID` is not among the organizations the token can see.
- `depot_get_ci_metrics` respects `DEPOT_MCP_OUTPUT_BUDGET` for the raw document it returns.
- `openWorldHint` is `false` on every tool: the server talks to one fixed, authenticated API.
- `DEPOT_API_URL` must be `https://` (plain `http://` only for localhost), with no credentials, query, or fragment. The rejected value is never echoed.
- `DEPOT_TOKEN` must be a single line of printable ASCII; the rejected value is never echoed.
- Retries honour `Retry-After` (capped at 8 s), retry a timed-out request once at most, and stop at a 40 s overall deadline per call. Responses over 8 MiB are refused.
- `--help` / `-h` and `--version` / `-v` flags; graceful shutdown on SIGINT, SIGTERM, and stdin close; `main`/`exports` point at `dist/server.js` so importing the package does not start a server.
- The package description and keywords lead with "depot.dev" so registry searches can tell this apart from unrelated "depot" projects.

### Fixed

- `depot_diagnose_build` works against a real failed build. Depot's JSON binding of `GetBuildSteps` is broken server-side, so the two build-step RPCs now use Connect's binary protobuf encoding through a small dependency-free codec built from Depot's published `build.proto`. When Depot's step or step-log endpoints fail server-side the tool degrades to the build-level facts and says what is missing (`stepsUnavailable`, `logsUnavailable`) instead of returning an error.

- `depot_diagnose_ci_failure` sent the diagnosis target type as a name; Depot accepts only the enum number and answered every call with `400 target_type is required`. Found on the first live run against a real organization.

- `depot_whoami` reports the token kind. An Organization token cannot call `ListOrganizations` (Depot answers `401 Invalid token`), so that call is no longer treated as the authentication check; the organization id comes from the visible projects instead. A user token is recognised by the opposite pattern and the affected tools are named. Both verified live on 2026-09-06.

- `depot_get_ci_logs` dropped lines when paging forward (lines past `tailLines` in the last fetched page were unreachable, and over-budget forward windows were trimmed from the start).
- The text budget could leave holes in a summary: an oversized line was dropped while later lines were still appended. The overflowing line is now truncated and nothing follows it.
- Probe misses while resolving a job or attempt id counted against the log page cap.
- Status enums with `JOB_CONCLUSION_` / `ATTEMPT_CONCLUSION_` prefixes were not normalised, so such jobs never counted as failed.
- Wrong-kind-of-id fall-through is consistent across diagnose, metrics, logs, and summary (`not_found` and `invalid_argument`).
- Prompt arguments are sanitised and quoted before interpolation.
- Identifiers are trimmed; whitespace-only ids are rejected before any request is made.

### Security

- Tokens containing line breaks or spaces no longer leak through the HTTP client's "invalid header value" error; transport and Connect error messages are scrubbed of the token.
- Untrusted CI content (logs, summaries, Depot's AI diagnosis and suggested fix) is fenced and labelled in tool summaries, and the server instructions tell the model to treat it as data.
- Credential redaction rewritten: unanchored vendor patterns (GitHub, GitLab, AWS, Google, Slack, Stripe, OpenAI, Anthropic, npm, PyPI, Docker Hub, Vault, Depot, JWT, Bearer/Basic, PEM), structural rules (`user:pass@` URLs, `password=`-style fragments), a length rule, and a windowed entropy rule that no longer over-redacts URLs, paths, image references, semver strings, or git SHAs. Name matching is segment-based, so `AUTHOR_NAME` and `CERT_PATH` are no longer redacted while `DB_PASS` and `SLACK_WEBHOOK` are.

[Unreleased]: https://github.com/akshayjain3450/depot-mcp/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/akshayjain3450/depot-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/akshayjain3450/depot-mcp/releases/tag/v0.1.0
