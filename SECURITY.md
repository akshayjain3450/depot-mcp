# Security policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately through GitHub's "Report a vulnerability" form on this repository's Security tab (https://github.com/akshayjain3450/depot-mcp/security/advisories/new), or by email to akshayjain.developer@gmail.com. Include the version or commit, the client you used, and steps to reproduce. You will get an acknowledgement within 5 working days and a fix or a clear answer within 30 days for anything confirmed.

This is a community project maintained in spare time. There is no bug bounty.

Problems in Depot's own service or API belong with Depot: https://depot.dev/docs and their published security contact.

## What counts

Anything that lets this server:

- expose the Depot token (in a tool result, an error message, stderr, a file, or a crash dump);
- mutate anything in Depot, since every tool is meant to be read-only;
- return CI variable values that the redaction rules should have caught;
- exceed its output budget in a way that could exhaust a client's context or memory;
- be tricked by content from Depot (log lines, variable values, diagnosis text) into doing something other than returning that content.

Prompt injection through log content is a real concern: CI logs are attacker-influenced text and this server hands them to a model. The server does not, and cannot, sanitize log semantics. If you find a case where the server itself acts on log content rather than merely returning it, report it.

## The token caveat you must understand

**Depot has no read-only token scope.** An Organization token that can call `ListRuns` can also call `CancelRun`, `RerunWorkflow`, `ResetProject`, and `DeleteProject`. Nothing about the credential you give this server limits what it could do. The server is read-only because it registers no mutating tool, not because the token is restricted.

Consequences:

- If this process is compromised, the attacker holds a credential with full write access to your Depot organization. Create a dedicated Organization token for this server so you can revoke it on its own.
- `readOnlyHint` and `destructiveHint` are hints to the client, not enforcement. Some clients ignore them.
- A fork or a modified build of this server can do anything the token can do. Install from a source you trust, pin versions, and prefer the npm package with provenance once it is published.
- Project tokens cannot reach the Depot API at all, so they are not a least-privilege option here.

## What the server does to limit exposure

- The token is read from `DEPOT_TOKEN` only. It is never logged, never included in errors, never returned by `depot_whoami`, and never written to disk. The server does not read `~/.config/depot/depot.yaml`.
- No tool can mutate Depot state. `DEPOT_MCP_ALLOW_WRITES` exists as a gate for a future version and currently enables nothing.
- Operations judged unsafe for an agent are permanently excluded, not merely deferred: `ProjectService/ResetProject`, `CIService/Run`, token and secret writes, image and tag deletion, and `ShareBuild`.
- CI variable values that look like credentials (by name or by content) are replaced with a placeholder, and the result names the rule that fired.
- Every tool result is capped by `DEPOT_MCP_OUTPUT_BUDGET`, and log fetching is capped by `DEPOT_MCP_MAX_LOG_PAGES`.
- The server speaks MCP over stdio only. It opens no listening port, so the token never crosses a network boundary other than TLS to `api.depot.dev` (or whatever `DEPOT_API_URL` you set).

## Supported versions

Only the latest release receives fixes.
