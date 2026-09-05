# Prior art survey: is there a Depot (depot.dev) MCP server?

**Survey date:** 2026-09-04. All findings verified live on that date; nothing here is from training data.

---

## Verdict

**No, nothing exists.** There is no MCP server for depot.dev — not first-party, not third-party, not in any registry.

**Confidence: high (~95%).** The first-party conclusion is close to certain, because Depot publishes a complete machine-readable index of its entire site (`/llms.txt`) plus its docs and CLI as open-source repos, and all three contain zero references to MCP. The residual 5% covers private/unreleased work and a hypothetical unindexed personal repo belonging to a Depot engineer.

The important nuance is not that Depot forgot about MCP. **Depot evaluated the agent-integration problem, chose Agent Skills instead of MCP, and shipped that in February 2026.** Their CEO publicly criticized MCP's maturity in May 2025. This is a deliberate road not taken, which is both the opportunity and the main risk.

---

## Evidence

### 1. First-party: Depot ships no MCP server

#### The decisive test: Depot's own site index

Depot publishes `/llms.txt`, which it describes as "the site index for Depot, covering documentation, blog posts, the changelog, and customer stories." If Depot had shipped or announced an MCP server, it would appear here.

```bash
curl -s https://depot.dev/llms.txt -o depot_llms.txt   # 71,305 bytes, 577 lines
grep -ic 'mcp' depot_llms.txt                          # => 0
grep -in 'model context protocol' depot_llms.txt       # => no matches
```

**Zero occurrences of "mcp" across every doc page, blog post, and changelog entry Depot has ever published.** The changelog in that index runs through 2026-08-26 ("Datadog CI Visibility is now generally available"), so coverage is current to roughly a week before this survey.

#### The `depot` CLI has no `mcp` subcommand

Checked against `depot/cli` at HEAD, latest release **v2.102.7, published 2026-08-24**. The full command registration in `pkg/cmd/root/root.go` adds 24 subcommands:

`bake`, `blog`, `build`, `cache`, `cargo`, `claude`, `configure-docker`, `exec`, `gocache`, `image`, `init`, `list`, `login`, `logout`, `org`, `projects`, `pull`, `pulltoken`, `push`, `registry`, `ci`, `sandbox`, `tests`, `version`

There is no `mcp` command and no `pkg/cmd/mcp` directory. There *is* a `pkg/cmd/claude` (remote Claude Code sessions) and a `pkg/cmd/sandbox` — Depot's agent bet lives there, not in MCP.

```bash
gh api repos/depot/cli/contents/pkg/cmd            # no "mcp" dir
gh api repos/depot/cli/contents/pkg/cmd/root/root.go   # 24 AddCommand calls, no MCP
gh api repos/depot/cli/releases/latest             # v2.102.7 | 2026-08-24
```

#### GitHub org and code search

```bash
gh repo list depot --limit 100     # 92 public repos; no depot/mcp, no depot/mcp-server
gh api -X GET search/code -f q='mcp repo:depot/docs'          # total_count: 0
gh api -X GET search/code -f q='mcp repo:depot/cli'           # total_count: 1
gh api -X GET search/code -f q='modelcontextprotocol org:depot'  # total_count: 4
```

Both non-zero results are false positives:

- The single `depot/cli` hit is `.github/workflows/claude.yml` — CI configuration for the Claude Code GitHub Action, not an MCP implementation.
- All four `modelcontextprotocol` hits are inside `depot/zed-test`, which is a **fork of `zed-industries/zed`** used for build benchmarking. That is Zed's MCP code, not Depot's.

#### Live endpoint probes (2026-09-04)

| URL | Result |
|---|---|
| `https://depot.dev/mcp` | 404 |
| `https://api.depot.dev/mcp` | 404 |
| `https://depot.dev/api/mcp` | 404 |
| `https://mcp.depot.dev` | DNS failure (curl 000) |
| `https://depot.dev/.well-known/mcp.json` | 404 |
| `https://depot.dev/sse` | 404 |
| `https://depot.dev/docs/mcp` | 200 — **but this is a catch-all, see below** |

A JSON-RPC `initialize` handshake posted to `https://depot.dev/mcp` returned Depot's HTML 404 page, not an MCP response.

The `/docs/mcp` 200 is a soft 404: a deliberately bogus path (`/docs/this-page-does-not-exist-xyz`) behaves identically, and `depot/docs` contains no MCP file among its 122 source blobs.

#### Package registries

```bash
# npm — 404 unless noted
depot-mcp, @depot/mcp, @depot/mcp-server, depot-mcp-server, mcp-server-depot   # all 404
# The real @depot npm scope publishes only:
#   @depot/cli (2026-08-24), @depot/sdk-node (2025-09-17), @depot/connectrpc-workers (2025-05-02)

# PyPI — all 404
depot-mcp, mcp-depot, depot-mcp-server, mcp-server-depot, depot-dev-mcp
```

Docker Hub search for `depot-mcp` and `mcp+depot` returned no depot.dev-related image.

### 2. Third-party / community: nothing exists

GitHub repo searches, all run 2026-09-04:

```bash
gh search repos "depot mcp"
gh search repos "depot.dev mcp"        # => [] (zero results)
gh search repos "mcp-server-depot"
curl "https://api.github.com/search/repositories?q=depot+mcp&sort=stars"   # 35 total
```

Every hit is a naming collision. The complete list of what "depot + mcp" actually surfaces:

| Repo | What it really is |
|---|---|
| `mcp-depot/mcp-depot` (7–8★, created 2026-04-24) | Generic self-hosted MCP hub for wrapping arbitrary REST APIs (Jira, Jenkins, Confluence). Pure name collision. |
| `MAKaminski/depot-mcp` (0★) | **Home Depot (HD)** stock/investment research |
| `markswendsen-code/mcp-homedepot`, `sstepanovvl/mcp_homedepot`, `Oyen-o/node-serpapi-home-depot-mcp` | Home Depot retail product search |
| `flevy-com/kpi-depot-mcp` (0★) | "KPI Depot" corporate benchmarks |
| `DemonBigj781/depotdownloader-mcp` (0★) | **Steam** DepotDownloader |
| `RKingsfield/depot-mcp` (0★) | Warhammer 40k data |
| `sandraschi/depot-mcp` (0★) | NVMe fleet file storage |
| `Ruhal-Doshi/skill-depot` (6★) | RAG skill retrieval |
| Various French repos | "dépôt" = repository in French |

There is **no repository anywhere on GitHub that implements MCP against the depot.dev API.**

I also checked for latent demand — no one is even asking for it:

```bash
gh search issues "mcp" --owner depot          # 4 hits, all unrelated auto-generated
                                              # README test issues from 2025-05-21
gh search issues "depot.dev mcp server"       # 0 results
```

### 3. MCP registries and directories: absent

**Official MCP registry** (`registry.modelcontextprotocol.io`) — 15 results for `search=depot`, all unrelated: `com.kpidepot/kpi-depot`, `io.github.aistoragedepot-admin/aistoragedepot-mcp`, and eleven duplicate versions of `io.github.cogdepot/cogdepot`. No depot.dev.

I validated this null result with a control query rather than trusting it blindly:

```bash
curl "https://registry.modelcontextprotocol.io/v0/servers?search=buildkite&limit=10"
# => 1 result: io.github.buildkite/buildkite-mcp-server  ✅ API and query verified working
curl "https://registry.modelcontextprotocol.io/v0/servers?search=depot&limit=100"
# => 15 results, none depot.dev
curl "https://registry.modelcontextprotocol.io/v0/servers?search=depot.dev&limit=50"
# => count: 0
```

The `search=depot.dev` query returning **exactly zero** results is the cleanest single data point in this survey: the official registry has no entry matching Depot's domain at all.

**`punkpeye/awesome-mcp-servers`** — the largest community list, README is 1,402,012 bytes:

```bash
grep -ic depot awesome-mcp-servers/README.md    # => 0
```

**`modelcontextprotocol/servers`** README: `grep -ic depot` → **0**.

**Caveat, stated honestly:** my direct API calls to Glama (`glama.ai/api/mcp/v1/servers?query=`) and PulseMCP (`api.pulsemcp.com/v0beta/servers?query=`) returned zero results *even for the control query "buildkite"*, meaning those endpoints did not respond to my parameters. **I do not count those as evidence.** As a substitute, a web search scoped to `glama.ai`, `mcp.so`, `smithery.ai`, and `pulsemcp.com` for "depot.dev MCP server" surfaced only the Home Depot investment server and `skill-depot` — no depot.dev entry. Combined with the zero result in the official registry (which those directories mirror), I'm confident but this specific sub-check is weaker than the others.

---

## Depot's own AI/agent posture

This is the most decision-relevant section, and it cuts both ways.

### They have an explicit published AI strategy — and MCP is deliberately not in it

Depot maintains a page at **https://depot.dev/docs/ai-at-depot** titled "AI and agent resources," which enumerates every agent-facing surface they offer:

1. **Sherlock** — Depot's AI assistant in the docs and dashboard. It can fetch build/job/workflow details and logs, read project and org settings, usage, analytics, registry info, and cache summaries, and open support tickets. Notably, this is a *chat assistant locked inside Depot's own UI*, not a tool surface exposed to your agent.
2. **AI error summaries in Depot CI** — automatic post-failure diagnosis.
3. **Skills** — `github.com/depot/skills`, installed via `npx skills add depot/skills`.
4. **Depot CI for coding agents** — the `depot ci run` → read failure → fix → rerun loop.
5. **Markdown docs** — append `.md` to any URL, or send `Accept: text/markdown`.
6. **`llms.txt` / `llms-all.txt`**.

An MCP server is the single most obvious omission from that list.

### They chose Skills over MCP, deliberately

**Blog: "Now available: Depot skills" — Kyle Galbraith (CEO & Co-founder), published 2026-02-24**
https://depot.dev/blog/now-available-depot-skills
(also changelog `2026-02-24-depot-skills`)

Four `SKILL.md` files covering Container Builds, GitHub Actions Runners, Depot CI, and General. The stated motivation: *"we were tired of watching agents confidently generate the wrong thing... agents that fall back to `docker build` because they can't remember the right flag syntax."*

The entire post — including a "What could be better?" section listing known weaknesses — **never mentions MCP once.** Their acknowledged limitations are revealing: *"Agent support varies. Skills work best with agents that explicitly support the SKILL.md convention — Claude Code, Codex, Cursor. If you're using something else, you can still reference the skill files manually, but the install path is less turnkey. Skills are also sometimes notorious for not being automatically used by agents."*

Those are precisely the problems MCP solves.

### The CEO is on record as an MCP skeptic

**Kyle Galbraith, LinkedIn, 2025-05-19:**
> "MCP servers are quite cool. I like the idea of exposing a set of tools to an external system that can then use them to craft valuable solutions.
>
> It may just be me, but it really seems like MCP servers are quite brittle at the moment. There is this local vs. remote thing; authentication/authz seem kind of all over the place, and I find even my local ones running in Claude constantly crash.
>
> I'm sure that's all being worked on, and probably a large chunk is user error over here. But it makes it hard to feel super confident that the whole thing isn't about to shift right out from under you."

This is the clearest available explanation for why Depot went the skills route nine months later. Note the date: several of his complaints (remote transport, OAuth) have since been addressed by the spec.

### They are MCP-aware and position themselves as the *host*, not the server

**Blog: "Now available: Remote agent sandboxes on Depot" — 2025-08-13**
https://depot.dev/blog/now-available-remote-agent-sandboxes

On limitations of remote Claude Code: *"Currently, we only support the tools that Claude Code comes pre-configured with. You can specify things like your own MCP servers and the like via the `claude` CLI flags and config files."*

So Depot's relationship to MCP is as an execution substrate that *runs* other people's MCP servers. That is a different posture from vending one.

### But their whole product direction is agent infrastructure

Recent trajectory, all from the changelog:

- `depot claude` remote agent sandboxes (2025-08-13)
- Depot CI API + CLI GA (2026-06-04) — explicitly agent-framed: *"you and your agents should be able to do everything you can do in the dashboard from the CLI or API"*; protobuf/Connect is the source of truth with a generated OpenAPI v3 spec as the public contract
- Sandbox SDK private beta (2026-06-18)
- Depot Metal (2026-07-07)
- **Depot Code** private beta (2026-07-09) — "Git based source control built for agents and engineers"
- AI analysis for all CI workflows/jobs (2026-07-21)

The homepage now reads: *"Depot gives engineering teams the fast source control, builds, CI runners, sandboxes, caches, and registries they need to ship reliable software they trust at AI speed."*

**Read:** Depot cares intensely about agents but has consistently expressed that care through CLI + skills + API, not MCP. They've had roughly 18 months and two explicit product decisions to ship an MCP server and haven't. That is the opportunity. The risk is that a company this agent-focused, with an OpenAPI spec already generated and a CEO whose objections were about MCP's 2025 immaturity, could reverse the decision on a quiet afternoon.

---

## Adjacent prior art

There is a well-established convention for CI/build MCP servers. Notably, **no build-accelerator competitor has one either** — GitHub searches for Namespace, Blacksmith, WarpBuild, and BuildJet MCP servers all returned zero. Two comprehensive 2026 CI/CD MCP roundups (chatforest.com) cover GitHub Actions, Jenkins, GitLab CI, CircleCI, Buildkite, Azure DevOps, Argo CD, and TeamCity — and mention Depot zero times. The entire "faster builds" category is unrepresented in MCP.

### CircleCI — `CircleCI-Public/mcp-server-circleci` (the diagnostic model)

92★ · 62 forks · 27 open issues · TypeScript · created 2025-03-26 · last push 2026-08-06 · https://circleci.com/product/mcp/

The most relevant template, because it optimizes for *"why did my build break"* rather than CRUD. Roughly 14–17 tools:

| Tool | Purpose |
|---|---|
| `get_build_failure_logs` | Structured error summaries, deliberately **not** raw log dumps |
| `find_flaky_tests` | Surfaces instability from test history — platform intelligence you can't get by parsing logs |
| `get_job_test_results` | Test outcome analysis |
| `get_latest_pipeline_status` | Health check |
| `config_helper` | Validate/debug config before pushing |
| `run_pipeline`, `rerun_workflow`, `run_rollback_pipeline` | Trigger, retry, roll back |
| `analyze_diff` | Connect code changes to build outcomes |
| `find_underused_resource_classes` | Spot over-provisioned CI compute |
| `download_usage_api_data` | Usage/cost export |
| `list_artifacts`, `list_component_versions`, `list_followed_projects` | Discovery |

**Lesson:** the highest-value tools expose *platform-specific intelligence* (flaky detection, resource right-sizing), not thin API wrappers.

### Buildkite — `buildkite/buildkite-mcp-server` (the auth/deployment model)

53★ · 39 forks · 18 open issues · Go · MIT · created 2025-04-08 · **latest release v1.22.0 on 2026-09-04** (i.e. shipped the day of this survey — very actively maintained) · https://buildkite.com/docs/apis/mcp-server

Tools span four areas: pipelines, builds, jobs, tests (Test Engine analytics). The v1.0.0 build-workflow set — `cancel_build`, `rebuild_build`, `retry_job`, `get_job_env` — closes the "check failure → inspect environment → retry" loop in one session.

The genuinely instructive part is deployment:

- **Remote server with OAuth**, recommended for interactive tools
- **Remote server with API token pass-through** for headless agents, which issues a short-lived token and **exposes only tools whose scope begins with `read_`** — read-only enforced by the transport
- **Local server** pinned to a specific version for reproducible automation

**Lesson:** a credible vendor-grade MCP server ships remote + local, with read-only scoping as a first-class mode.

### Docker — `docker/hub-mcp` (the registry-metadata model)

162★ · 101 forks · 5 open issues · TypeScript · Apache-2.0 · created 2025-06-12 · last push 2026-08-27 · https://docs.docker.com/docker-hub/mcp-server/

13–14 tools, all registry metadata: `search`, `checkRepository`, `checkRepositoryTag`, `createRepository`, `getRepositoryInfo`, `getRepositoryTag`, `listNamespaces`, `listRepositoriesByNamespace`, `listRepositoryTags`, `updateRepositoryInfo`, `get-repository-dockerfile` / `set-repository-dockerfile`, `dockerHardenedImages`.

Note what it does **not** do: it never builds an image. Docker's MCP story is discovery and repo management; `docker/mcp-gateway` (1,552★) is a separate gateway product. **Nobody has shipped an MCP server that actually drives a container build.** That gap is exactly where Depot lives.

### For scale reference

`github/github-mcp-server`: 32,712★ · 4,898 forks · Go.

---

## What a Depot MCP server would wrap

Depot's API surface is unusually well-suited to this, which materially lowers implementation risk. From `depot/proto` and the generated clients in `depot/cli`:

**Protobuf/Connect services:** `depot.build.v1` (build, registry), `depot.buildkit.v1`, `depot.code.v1beta1`, `depot.core.v1` (build, org, project, usage), `depot.registry.v1beta1`, plus CLI-side `depot.agent.v1`, `depot.cache.v1`, `depot.ci.v1/v2/v3beta2`, `depot.testresults.v1`.

**Public APIs** (https://depot.dev/docs/api/overview): Depot CI API, Container Builds API, Sandbox API — with an **OpenAPI v3 spec generated from the protobuf definitions as the public contract**, and org-level API tokens plus OIDC for auth.

**`depot ci` CLI surface** (a ready-made tool list): `migrate` (preflight / workflows / secrets-and-vars), `run` (+ `list`, `show`), `workflow` (`list`, `show`), `dispatch`, `status`, `cancel`, `rerun`, `retry`, `logs`, `metrics`, `summary`.

A first version could be generated largely from the OpenAPI spec and then hand-curated down to a tight, well-described tool set.

---

## Recommendation

**Build it.** The hypothesis is confirmed: the niche is genuinely empty, and it's empty in an unusually clean way — not "abandoned repo with 3 stars," but *nothing at all*, across first-party, GitHub, npm, PyPI, Docker Hub, and the official registry.

### Where the differentiation actually is

Depot's skills teach an agent to *shell out to the `depot` binary*. That leaves four real gaps:

1. **Agents without a shell.** Skills only work for agents that can execute `depot` locally with a logged-in CLI. Any hosted or browser-based client is excluded. MCP with a remote transport reaches all of them.
2. **Clients that don't support `SKILL.md`.** Depot admits this themselves — skills work well in Claude Code, Codex, and Cursor, and degrade elsewhere. MCP is client-agnostic.
3. **Reliability of invocation.** Depot's own post concedes skills are "notorious for not being automatically used by agents" and suggests users manually prompt for them. Tool calls don't have that failure mode.
4. **Read-only safety scoping.** A skill can't stop an agent from running a destructive command. Buildkite's read-scope-only remote token mode shows how MCP does this properly — which matters a lot for a product that spends real money per build minute.

### The specific product wedge

Follow CircleCI's diagnostic-first design rather than generating a flat CRUD wrapper. The killer surface for Depot specifically is **build and CI forensics plus cost**, because Depot has data nobody else has:

- Why did this build fail (structured, not a log dump) — Depot already generates AI error summaries; expose them as a tool
- Cache hit rate and cache effectiveness per project
- Build duration trends and regressions, and the slowest-job analysis their dashboard already computes
- Usage and spend (`depot.core.v1.usage`) — "what is costing us the most build time this month"
- Test results and flaky-test data (`depot.testresults.v1`, GA as of 2026-07-29)
- Triggering and monitoring: `depot ci dispatch` / `status` / `logs` / `retry`

There's a sharp framing available: **Depot's Sherlock assistant can already answer most of these questions, but only inside Depot's own dashboard.** An MCP server puts that same context in the user's editor, where they're actually working. That's a concrete, honest pitch for both users and Depot itself.

Also worth noting: nobody has shipped an MCP server that *runs a container build*. `depot build` as a tool call is genuinely novel territory.

### Risks, weighted

| Risk | Assessment |
|---|---|
| **Depot ships their own** | The real risk. They're deeply agent-focused, have an OpenAPI spec ready, and the CEO's 2025 objections have largely been fixed by the spec since. Mitigate by moving fast and building it as an obvious donation/adoption candidate — clean Go or TypeScript matching their stack, MIT-licensed. |
| **Depot rejects the approach** | Low impact. They're MCP-aware and friendly to community contribution ("pull requests are very welcome" on skills). Nothing suggests hostility, only prioritization. |
| **Small market** | Real but acceptable. Depot is a mid-size startup ($4.1M seed, Aug 2024). Compare CircleCI's official server at 92★ and Buildkite's at 53★ — this category has modest star counts even for first-party vendor servers. Build for utility and positioning, not GitHub stars. |
| **API churn** | Low. The protobuf/Connect contract is versioned and public, with `v1` stability on core services. |

### Suggested opening move

Ship a focused v1 of roughly 10–15 tools weighted toward diagnostics and read operations, with remote and local transports and a read-only default mode. Register it in the official MCP registry (currently zero competition for the "depot" query) and open a PR to `depot/skills` or file an issue on `depot/cli` mentioning it — that both tests Depot's receptiveness and buys distribution.

---

## Reproducibility: full query list

**GitHub (via `gh`, all run 2026-09-04):**
```bash
gh repo list depot --limit 100 --json name,description,stargazerCount,pushedAt,isArchived
gh search repos "depot mcp"
gh search repos "depot.dev mcp"
gh search repos "mcp-server-depot"
gh search repos "namespace mcp server ci" / "blacksmith mcp server ci" / "warpbuild mcp" / "buildjet mcp"
gh search issues "mcp" --owner depot
gh search issues "depot.dev mcp server"
gh api -X GET search/code -f q='mcp org:depot'
gh api -X GET search/code -f q='mcp repo:depot/docs'
gh api -X GET search/code -f q='mcp repo:depot/cli'
gh api -X GET search/code -f q='modelcontextprotocol org:depot'
gh api repos/depot/cli/contents/pkg/cmd
gh api repos/depot/cli/contents/pkg/cmd/root/root.go
gh api repos/depot/cli/releases/latest
gh api "repos/depot/docs/git/trees/HEAD?recursive=1"
gh api "repos/depot/proto/git/trees/HEAD?recursive=1"
gh api repos/depot/skills/contents/README.md
curl "https://api.github.com/search/repositories?q=depot+mcp&sort=stars&per_page=30"
```

**Registries:**
```bash
curl "https://registry.modelcontextprotocol.io/v0/servers?search=depot&limit=100"
curl "https://registry.modelcontextprotocol.io/v0/servers?search=depot.dev&limit=50"   # => 0
curl "https://registry.modelcontextprotocol.io/v0/servers?search=buildkite&limit=10"   # control
curl "https://registry.npmjs.org/-/v1/search?text=depot%20mcp&size=15"
curl "https://registry.npmjs.org/-/v1/search?text=scope:depot&size=50"
curl -o /dev/null -w "%{http_code}" https://registry.npmjs.org/{depot-mcp,mcp-depot,@depot/mcp,@depot/mcp-server,depot-mcp-server,mcp-server-depot}
curl -o /dev/null -w "%{http_code}" https://pypi.org/pypi/{depot-mcp,mcp-depot,depot-mcp-server,mcp-server-depot,depot-dev-mcp}/json
curl "https://hub.docker.com/v2/search/repositories/?query=depot-mcp&page_size=10"
curl "https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md" | grep -ic depot
curl "https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md" | grep -ic depot
```

**Depot live endpoints:**
```bash
curl -s https://depot.dev/llms.txt | grep -ic mcp
curl -L -o /dev/null -w "%{http_code}" https://depot.dev/mcp
curl -L -o /dev/null -w "%{http_code}" https://api.depot.dev/mcp
curl -L -o /dev/null -w "%{http_code}" https://depot.dev/api/mcp
curl -L -o /dev/null -w "%{http_code}" https://mcp.depot.dev
curl -L -o /dev/null -w "%{http_code}" https://depot.dev/.well-known/mcp.json
curl -X POST https://depot.dev/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}'
curl https://depot.dev/docs/cli/reference/depot-ci.md
curl https://depot.dev/docs/api/overview.md
```

**Web searches:** "depot.dev MCP server Model Context Protocol"; "depot mcp server github depot.dev docker build"; "depot.dev blog MCP server announcement 2026"; "mcp.so OR glama.ai OR smithery.ai OR pulsemcp depot build cache MCP server directory"; "CircleCI MCP server Buildkite MCP server tools list CI build"; "Docker Hub MCP server official tools registry images 2026"; "Depot MCP Kyle Galbraith Jacob Gillespie remote MCP server August September 2026".

**Key source URLs:**
- https://depot.dev/docs/ai-at-depot
- https://depot.dev/blog/now-available-depot-skills (2026-02-24)
- https://depot.dev/blog/now-available-remote-agent-sandboxes (2025-08-13)
- https://depot.dev/blog/now-available-depot-ci-api (2026-06-04)
- https://github.com/depot/skills
- https://github.com/depot/cli
- https://www.linkedin.com/posts/kylegalbraith459_mcp-servers-are-quite-cool-i-like-the-idea-activity-7330257274617118721-G4Gb (2025-05-19)
- https://circleci.com/product/mcp/
- https://buildkite.com/docs/apis/mcp-server
- https://docs.docker.com/docker-hub/mcp-server/

---

## Addendum: re-verification on 2026-09-05

A second, independent pass one day later. Verdict unchanged: **no standalone Depot (depot.dev) MCP server exists, first-party or third-party.** Confidence stays at roughly 95%. Two corrections and several new data points:

### Corrections to the 2026-09-04 survey

1. **One public codebase does implement MCP tools against `api.depot.dev`**, found by GitHub *code* search rather than repo-name search: `InnerScopeHearing/otchealth-mcp-server` (1 star, no license, TypeScript, Fastify + `@modelcontextprotocol/sdk`, Streamable HTTP with bearer auth). It carries 46 `depot_*` tools inside a single company's internal gateway alongside roughly 800 tools for unrelated services. It is not standalone, not packaged, not licensed, and not in any registry, so it is not usable prior art. It is still worth reading as a verified map of which Connect RPCs on `api.depot.dev` accept a bearer organization token, and for its gating pattern: each tool carries `category: read | write_simple | write_orchestrated`, env flags `READ_ONLY_MODE` / `ENABLE_WRITE_TOOLS` / `ENABLE_HIGH_RISK_TOOLS`, writes default to `dry_run=true`, and MCP annotations are set per tool.
2. **The claim that no build-accelerator competitor ships an MCP server was wrong.** WarpBuild has a hosted remote server at `https://mcp.warpbuild.com/mcp` (docs dated 2026-01-20). Blacksmith has a third-party one, `grahamnotgrant/blacksmith-mcp` (stdio via `npx`, auth by reusing a browser session cookie). Namespace has none.
3. The npm package `mcp-depot` **exists** (v1.0.3, 2026-07-31). It is the generic REST-to-MCP hub from `mcp-depot/mcp-depot`, unrelated to Depot. The 2026-09-04 survey listed it as 404.

### Re-checked sources (all 2026-09-05)

- GitHub repo search: `"depot mcp"`, `"depot-mcp"`, `"mcp-depot"` return only name collisions (Home Depot, KPI Depot, Warhammer, Steam DepotDownloader, French "dépôt"). `"depot.dev mcp"` and `"depot model context protocol"` return 0.
- GitHub code search: `"api.depot.dev" modelcontextprotocol` returns 0. `"depot.dev" "McpServer"` returns 9, of which only the otchealth repo is real.
- `depot` org: 92 repos, none MCP-related. `depot/cli` latest release still v2.102.7 (2026-08-24), 25 command dirs, no `mcp`. `depot/skills` had a content commit on 2026-09-02 with zero MCP references. `depot/docs` synced 2026-09-02, zero hits.
- npm: `depot-mcp`, `@depot/mcp`, `@depot/mcp-server`, `depot-mcp-server`, `mcp-server-depot`, `depot-dev-mcp`, `@depot-dev/mcp`, `depotdev-mcp`, `depot-ci-mcp`, `mcp-depot-dev` all 404. PyPI: `depot-mcp`, `mcp-depot`, `mcp-server-depot`, `depot-mcp-server`, `depot-dev-mcp`, `depotdev-mcp` all 404.
- Official registry: `GET /v0/servers?search=depot` returns 15 unrelated entries; `search=depot.dev` returns 0. Control query `search=buildkite` works.
- Smithery (6 pages of `q=depot`), Glama, PulseMCP, Docker MCP catalog (824 servers in `docker/mcp-registry`), four awesome-mcp-servers lists: zero Depot entries. mcp.so (403), cursor.directory (429) and mcpservers.org (JS shell) could only be checked weakly through web search.
- Depot's site: `llms.txt` (71,305 bytes) and `llms-all.txt` (870,565 bytes) contain zero occurrences of "mcp". Newest changelog entry is still 2026-08-26. `docs/ai-at-depot` says that agents integrating over HTTP instead of a shell should call the Depot CI API directly, which is Depot's stated answer to shell-less agents. `depot.dev/mcp`, `api.depot.dev/mcp`, `mcp.depot.dev`, `.well-known/mcp.json`, `/sse` all 404 or unresolvable.
- Not checkable: X/Twitter and LinkedIn.

### Reference servers and how they distribute

| Server | Language | Transports | Distribution | Read-only / write gating |
| --- | --- | --- | --- | --- |
| github/github-mcp-server (MIT, v1.12.0 on 2026-09-03) | Go | stdio, streamable HTTP | hosted `api.githubcopilot.com/mcp/` (OAuth or PAT); local via Docker image or Go binary | `--read-only` flag, `--toolsets` allow-list, `--tools` fine-grained; read-only wins over explicit tools |
| buildkite/buildkite-mcp-server (MIT, v1.22.0) | Go | stdio, HTTP | hosted `mcp.buildkite.com/mcp`, `/direct`, `/mcp/readonly`; local binary, Docker, brew | read-only endpoint exposes only tools whose scope starts with `read_` |
| CircleCI | npm package now deprecated | hosted streamable HTTP, CLI-bundled stdio | `mcp.circleci.com/v1/mcp`, `circleci` CLI | curated small toolset, confirmation on destructive actions |
| Railway | npm package deprecated, now in CLI | stdio (`railway mcp`), remote `mcp.railway.com` (OAuth) | CLI-bundled | none documented |
| WarpBuild (official) | unknown | streamable HTTP only | `mcp.warpbuild.com/mcp` with dashboard API key | none documented |
| grahamnotgrant/blacksmith-mcp (MIT) | TypeScript | stdio | `npx blacksmith-mcp` | read-only by nature (analytics) |
| docker/hub-mcp (Apache-2.0) | TypeScript | stdio, HTTP | `npm start -- --transport=...`; HTTP fails closed without `MCP_AUTH_TOKEN` | none |

The 2026 pattern across vendors is CLI-bundled stdio plus a hosted remote with OAuth, with standalone npm packages being deprecated in favour of those two. Read-only gating is done at the endpoint level (Buildkite) or by flag (GitHub).

### Naming and discoverability

- `depot-mcp` is free on npm and PyPI. `mcp-depot` is taken. Never use `@depot/*` (Depot's npm scope) or `dev.depot/*` in the official registry (requires DNS or HTTP domain verification only Depot can pass).
- The bare word "depot" is polluted in every directory. The official registry matches on name plus description, so the package description should begin with "depot.dev" and keywords should include `depot.dev`, `depot-ci`, `container-builds`, `github-actions`, `mcp-server`.
- Publish order: official MCP registry (`io.github.<owner>/depot-mcp`, needs `mcpName` in package.json and the `mcp-publisher` CLI), npm, Docker MCP catalog (PR to `docker/mcp-registry`), Smithery, then Glama and PulseMCP (which crawl the registry and GitHub), then `punkpeye/awesome-mcp-servers`. Optionally open an issue on `depot/skills` linking the project.
