# Contributing to depot-mcp

Thanks for looking. This is a community project, not a Depot product, and it is small enough that one person can hold the whole thing in their head. Keep it that way.

## Ground rules

1. **Read-only is the product.** Depot has no read-only token scope, so this server's tool registration is the entire safety boundary. A pull request that adds a tool able to retry, cancel, rerun, dispatch, reset, delete, share, or mint anything will not be merged into the default tool set. If you want to propose a mutating tool, it must live in `mutatingTools` in `src/tools/index.ts`, be gated by `DEPOT_MCP_ALLOW_WRITES`, carry honest `destructiveHint` and `idempotentHint` annotations, and be discussed in an issue first. Some operations are permanently out of scope regardless; see the Security section of the README.
2. **The token never leaves the process.** Never log it, never put it in an error, never return it from a tool, never read it from anywhere but the environment.
3. **Every result is bounded.** Anything that can grow with log volume must respect `DEPOT_MCP_OUTPUT_BUDGET` and say when it truncated.
4. **stdout is the protocol.** Diagnostics go to stderr. `console.log` is a lint error in `src/` for this reason.
5. **Tool names are stable.** They are `depot_<verb>_<noun>`, and renaming one breaks every user's allowlist. Add, deprecate, do not rename.
6. Write plainly. No marketing language in docs or tool descriptions.

## Development loop

Node 20 or newer (`.nvmrc` says 20; CI runs 20 and 22).

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
npm run lint        # eslint, type-aware rules
npm test            # vitest; no network, no Depot account
npm run build       # emits dist/
npm run inspect     # build, then open the MCP Inspector against dist/index.js
```

Run all four checks before opening a pull request. CI runs the same commands plus `npm pack --dry-run`, a metadata consistency check, and a stdio smoke test that starts the built server, performs the MCP handshake, and asserts the expected tool count (`.github/scripts/mcp-smoke.mjs`).

To exercise the server against your own Depot organization:

```bash
cp .env.example .env    # fill in DEPOT_TOKEN; .env is gitignored
npm run smoke           # read-only calls only, reports pass/fail/skip per check
```

## How the tests work

Tests live in `test/` and run under vitest.

- `test/unit/` covers pure functions: config parsing, the Depot client's retry policy, error translation, shape accessors, budgeting and redaction.
- `test/tools/` is the main suite. Each test builds a real `McpServer` through `createServer()` and connects a real MCP `Client` to it over the SDK's `InMemoryTransport`, so every assertion goes through the actual protocol: input validation, output-schema conformance, annotations, character budgets, and error translation.
- `test/helpers/harness.ts` is the glue. `createHarness(routes)` takes a map of `<Service>/<Method>` to stubbed replies and injects a fake `fetch`, so no test touches the network. It records every call the server makes, and `harness.callsTo(rpc)` lets you assert on request bodies and headers (for example that `x-depot-org` was sent).
- `test/fixtures/` holds recorded Depot JSON responses. The four `GetFailureDiagnosis` states (`diagnosis-focused.json`, `diagnosis-grouped.json`, `diagnosis-over-limit.json`, `diagnosis-empty.json`) are the behavioural surface of the flagship tool; keep all four green.

When you add a fixture, record it from a real response, then strip anything identifying: organization and project names, repository names, tokens, and log lines you would not paste into a public issue. Fixtures are public.

## Adding a tool

1. Pick the question the tool answers, not the RPC it wraps. One tool per question. Accept loose identifiers where Depot does (a run, workflow, job, or attempt ID) and resolve internally with `src/lib/ci-target.ts` and `src/lib/resolve.ts`.
2. Add the RPC to `src/depot/api.ts` if it is not there. Read responses through the tolerant accessors in `src/depot/shape.ts`; `depot.ci.v1` has no published schema, so never assume a field exists.
3. Create a module in `src/tools/` exporting a `ToolModule` (see `src/lib/tool.ts` for the shape and an existing tool such as `src/tools/ci-summary.ts` for a small example). Give it a Zod `inputSchema` and `outputSchema`, a `title`, a description that says what question it answers and when to prefer another tool, and annotations `readOnlyHint: true`, `destructiveHint: false`, and `idempotentHint` as appropriate.
4. Return both a short text rendering and `structuredContent`. Run the output through `src/lib/budget.ts` and set `truncated` when it fires.
5. Register it in `readOnlyTools` in `src/tools/index.ts`. Order matters: it is the order clients see, and it should stay deterministic.
6. Add a test in `test/tools/` using the harness and a fixture. Cover the empty case and at least one Connect error.
7. Update the tool table in `README.md`, the `EXPECTED_TOOL_COUNT` in `.github/scripts/mcp-smoke.mjs`, the count in the README, and `CHANGELOG.md`.

## Pull requests

- Keep them focused. One tool, one fix, one doc change.
- Explain what changed and why in the description; the diff shows how.
- Add or update a `CHANGELOG.md` entry under `Unreleased`.
- CI must be green on Node 20 and 22.

## Releasing

Maintainers only.

1. Update `version` in `package.json`, `server.json` (both the top-level `version` and the npm package entry), and `manifest.json`. `node .github/scripts/check-metadata.mjs` confirms they agree.
2. Move the `Unreleased` section of `CHANGELOG.md` to the new version with today's date.
3. Commit, tag `vX.Y.Z`, push the tag. `.github/workflows/release.yml` runs the full check suite and publishes to npm with provenance. Authentication is npm trusted publishing: npm trusts this repository's `release.yml` workflow running in the `npm` GitHub environment via OIDC, so no npm token is stored anywhere. If a release fails with an npm authentication error, check the Trusted Publisher settings on the npm package page (owner `akshayjain3450`, repository `depot-mcp`, workflow `release.yml`, environment `npm`).
4. Publish the MCP Registry entry: `mcp-publisher login github && mcp-publisher publish` from the repository root. The registry verifies ownership through the `mcpName` field in `package.json`.
5. Optional Claude Desktop bundle: stage a directory containing `manifest.json`, `package.json`, `dist/`, and production `node_modules/` (`npm ci --omit=dev` in the staging copy), then run `npx @anthropic-ai/mcpb pack <staging-dir> depot-mcp.mcpb` and attach the file to the GitHub release. Record its SHA-256 if you add an `mcpb` package entry to `server.json`.

## License and sign-off

The project is licensed under the Apache License 2.0 with the Commons Clause condition; see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). By submitting a contribution you agree that it is licensed under the same terms, as described in section 5 of the Apache License 2.0 (inbound equals outbound). There is no separate contributor licence agreement.

The project uses the [Developer Certificate of Origin](https://developercertificate.org/). Sign off every commit to certify that you wrote the change or otherwise have the right to submit it under the project's license:

```bash
git commit -s -m "Add depot_get_ci_job_summary"
```

This adds a `Signed-off-by:` trailer with your name and email. Pull requests with unsigned commits will be asked to rebase.

## Code of conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
