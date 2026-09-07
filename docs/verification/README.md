# Verification reports

`npm run verify` writes its Markdown report here as `latest.md` (or wherever `--out` points). Everything in this directory except this file is gitignored: a report names run, job, and project ids from a real organization and is evidence for one release, not source.

The session guide, including what to record from a report and where, is [docs/verification.md](../verification.md).

## Format

- A header with the date, the server version, which of the three token kinds were present, and whether the apply gate opened for each.
- The cross-token matrix: one row per scenario, one column per token kind. A cell is one of `ok`, `empty` (the call succeeded and found nothing), `refused` (a tool error naming a rule), `preview` (a dry run that would proceed), `applied`, a Connect error code such as `unauthenticated`, `error` (a tool error that is neither a rule nor a Depot error), `schema` (structured content that failed the advertised output schema), `crashed` (a thrown exception), `skipped` (an id the organization did not have), `MISSING BUILDER` (a registered tool the script has no arguments for), or `no token`.
- One section per token with the discovered ids, the per-scenario table with a one-line note from each response, the number of requests sent to Depot, and the mutating RPCs that were actually called.
- The audit lines every applied write logged to stderr.
- A summary listing every failure, which is what the exit code reflects.

Tokens are masked before anything is written, and URLs are reduced to their host.
