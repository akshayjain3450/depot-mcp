<!-- Keep the description short. Say what changed and why; the diff shows how. -->

## What

## Why

## Checklist

- [ ] `npm run typecheck && npm run lint && npm test` pass locally.
- [ ] Any new or changed tool has a test in `test/tools/` that drives it through the MCP `Client` against fixtures.
- [ ] No new tool can mutate anything in Depot (see the read-only rule in CONTRIBUTING.md). If it can, it is behind `DEPOT_MCP_ALLOW_WRITES` and marked `destructiveHint` appropriately.
- [ ] Output stays bounded (`DEPOT_MCP_OUTPUT_BUDGET`) and reports truncation.
- [ ] The token is never logged, echoed, or included in an error message.
- [ ] `README.md` (tool table, configuration) and `CHANGELOG.md` are updated if behaviour changed.
- [ ] If the tool count changed, `EXPECTED_TOOL_COUNT` in `.github/scripts/mcp-smoke.mjs` and the count in `README.md` are updated.
