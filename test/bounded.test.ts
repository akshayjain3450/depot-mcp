import { afterEach, describe, expect, it } from 'vitest';
import {
  callTool,
  createHarness,
  fixture,
  NOT_FOUND,
  ok,
  type Harness,
  type StubReply,
  type StubRoutes,
} from './helpers/harness.js';
import { RPC } from './helpers/rpcs.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const BUDGET = 2_000;

/**
 * TextBudget appends its "[output truncated ...]" footer after the limit is reached, so a rendered
 * result may legitimately exceed the budget by that one line. Anything beyond it means a tool is
 * writing text outside the budget.
 */
const FOOTER_ALLOWANCE = 120;

function many<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

function filler(index: number): string {
  return `line ${index} ${'x'.repeat(180)}`;
}

interface GiantCase {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly routes: StubRoutes;
  /** What the text says when it had to cut something. */
  readonly saysTruncated: RegExp;
  /** Set when the tool is known to write outside the budget; the case is then marked `it.fails`. */
  readonly knownToExceed?: string;
}

const TRUNCATED_FOOTER = /output truncated/;

const GIANT_CASES: readonly GiantCase[] = [
  {
    name: 'depot_whoami',
    args: {},
    routes: {
      [RPC.listOrganizations]: ok({
        organizations: many(300, (i) => ({ orgId: `org_${i}`, name: `Organization ${filler(i)}` })),
      }),
      [RPC.listProjects]: ok({
        projects: many(300, (i) => ({ projectId: `proj_${i}`, name: `project-${i}` })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_diagnose_ci_failure',
    args: { id: 'run_giant' },
    routes: {
      [RPC.getFailureDiagnosis]: ok({
        state: 'STATE_GROUPED_FAILURES',
        target: { targetId: 'run_giant', targetType: 'TARGET_TYPE_RUN' },
        failureGroups: many(20, (g) => ({
          fingerprint: `fp_${g}`,
          count: 3,
          errorMessage: `error ${g} ${'e'.repeat(500)}`,
          diagnosis: 'd'.repeat(500),
          possibleFix: 'f'.repeat(500),
          representatives: many(3, (a) => ({
            attemptId: `att_${g}_${a}`,
            jobKey: `job ${g}`,
            attempt: 1,
            relevantLines: many(60, (l) => ({ lineNumber: l, content: filler(l) })),
          })),
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_list_ci_runs',
    args: {},
    routes: {
      [RPC.listRuns]: ok({
        runs: many(500, (i) => ({
          runId: `run_${i}`,
          repo: 'acme/api',
          status: 'STATUS_FAILED',
          sha: '9c1f4ab7deadbeef',
          createdAt: '2026-09-03T14:02:19Z',
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_get_ci_run',
    args: { runId: 'run_giant' },
    routes: {
      [RPC.getRun]: ok(fixture('run')),
      [RPC.getRunStatus]: ok({
        runId: 'run_giant',
        status: 'STATUS_FAILED',
        workflows: [
          {
            workflowId: 'wf_giant',
            name: 'CI',
            status: 'STATUS_FAILED',
            jobs: many(300, (j) => ({
              jobId: `job_${j}`,
              jobDisplayName: `job number ${j}`,
              status: 'STATUS_FINISHED',
              conclusion: 'CONCLUSION_FAILED',
              attempts: [{ attemptId: `att_${j}`, attempt: 1, conclusion: 'CONCLUSION_FAILED' }],
            })),
          },
        ],
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_get_ci_logs',
    args: { id: 'att_giant' },
    routes: {
      [RPC.getJobAttemptLogs]: many(3, (page) =>
        ok({
          lines: many(300, (i) => ({ lineNumber: page * 300 + i + 1, body: filler(i) })),
          ...(page < 2 ? { nextPageToken: `cursor-${page + 2}` } : {}),
        }),
      ),
    },
    saysTruncated: /dropped|truncated/,
  },
  {
    name: 'depot_get_ci_job_summary',
    args: { id: 'job_giant' },
    routes: { [RPC.getJobSummary]: ok({ markdown: many(600, filler).join('\n') }) },
    saysTruncated: /\[truncated: \d+ characters in the original\]/,
  },
  {
    name: 'depot_get_ci_metrics',
    args: { id: 'att_giant' },
    routes: {
      [RPC.getJobAttemptMetrics]: ok({
        samples: many(400, (i) => ({ t: i, cpuPercent: 50.5, memoryBytes: 1_234_567 })),
      }),
    },
    saysTruncated: /\[truncated: \d+ characters in the original\]/,
  },
  {
    name: 'depot_list_ci_artifacts',
    args: { runId: 'run_giant' },
    routes: {
      [RPC.listArtifacts]: ok({
        artifacts: many(500, (i) => ({
          artifactId: `art_${i}`,
          name: `artifact-${i}-${'n'.repeat(60)}.xml`,
          sizeBytes: 1024 * i,
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_diagnose_build',
    args: { buildId: 'bld_giant', projectId: 'proj_api7f2', tailLines: 1000 },
    routes: {
      [RPC.getBuild]: ok(fixture('build')),
      [RPC.getBuildSteps]: ok({
        steps: [
          {
            name: 'RUN npm run build',
            digest: 'sha256:33cc',
            cacheState: 'CACHE_STATE_UNCACHED',
            error: 'exit code: 2',
            hasLogs: true,
          },
        ],
      }),
      [RPC.getBuildStepLogs]: ok({ logs: many(2000, (i) => ({ message: filler(i) })) }),
    },
    // Trims the tail to the budget before rendering, so it reports the drop in a note rather than
    // by overflowing TextBudget.
    saysTruncated: /dropped|truncated/,
  },
  {
    name: 'depot_list_builds',
    args: { projectId: 'proj_api7f2' },
    routes: {
      [RPC.listBuilds]: ok({
        builds: many(500, (i) => ({
          buildId: `bld_${i}`,
          status: 'STATUS_SUCCESS',
          cachedSteps: 3,
          totalSteps: 4,
          createdAt: '2026-09-03T14:02:19Z',
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_list_projects',
    args: {},
    routes: {
      [RPC.listProjects]: ok({
        projects: many(500, (i) => ({
          projectId: `proj_${i}`,
          name: `project-${i}`,
          regionId: 'us-east-1',
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_get_project',
    args: { projectId: 'proj_api7f2' },
    routes: {
      [RPC.getProject]: ok({ project: { projectId: 'proj_api7f2', name: 'api' } }),
      [RPC.listTrustPolicies]: ok({
        trustPolicies: many(500, (i) => ({
          trustPolicyId: `tp_${i}`,
          github: { org: 'acme', repository: `repo-${i}` },
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_audit_trust_policies',
    args: {},
    routes: {
      [RPC.listProjects]: ok({
        projects: many(50, (i) => ({ projectId: `proj_${i}`, name: `project-${i}` })),
      }),
      [RPC.listTrustPolicies]: ok({
        trustPolicies: many(20, (i) => ({
          trustPolicyId: `tp_${i}`,
          github: { repositoryOwner: 'acme', repository: `repo-${i}-${'r'.repeat(40)}` },
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_list_project_tokens',
    args: { projectId: 'proj_api7f2' },
    routes: {
      [RPC.listTokens]: ok({
        tokens: many(500, (i) => ({ tokenId: `tok_${i}`, description: `token ${filler(i)}` })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_get_usage',
    args: {},
    routes: {
      [RPC.getUsage]: ok({
        containerBuild: many(500, (i) => ({
          projectName: `project-${i}`,
          buildCount: i,
          minutesBilled: 10,
          minutesSaved: 20,
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_list_project_usage',
    args: {},
    routes: {
      [RPC.listProjectUsage]: ok({
        usage: many(500, (i) => ({
          projectId: `proj_${i}`,
          buildCount: i,
          buildDurationSeconds: 60 * i,
          layerCacheSizeGb: i,
        })),
      }),
      [RPC.listProjects]: ok({
        projects: many(500, (i) => ({ projectId: `proj_${i}`, name: `project-${filler(i)}` })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    // The summary is a fixed number of lines, so the only thing Depot can inflate is the text
    // inside them: a huge project name lands in the first line and every observation.
    name: 'depot_get_cache_summary',
    args: { projectId: 'proj_giant' },
    routes: {
      [RPC.getProject]: ok({
        project: {
          projectId: 'proj_giant',
          name: `giant ${'n'.repeat(3_000)}`,
          cachePolicy: { keepDays: 14, keepGb: 50 },
        },
      }),
      [RPC.listProjectUsage]: ok({
        usage: [{ projectId: 'proj_giant', buildCount: 3, buildDurationSeconds: 90, layerCacheSizeGb: 49 }],
      }),
      [RPC.listBuilds]: ok(fixture('builds-list')),
      [RPC.getUsage]: ok({ containerBuild: [] }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_list_images',
    args: { projectId: 'proj_api7f2' },
    routes: {
      [RPC.listImages]: ok({
        images: many(500, (i) => ({
          tag: `v1.${i}`,
          digest: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 1_000_000,
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_list_ci_secrets',
    args: {},
    routes: {
      [RPC.listSecrets]: ok({
        secrets: many(500, (i) => ({
          name: `SECRET_${i}`,
          variants: [{ variantName: 'default', attributes: {} }],
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
  {
    name: 'depot_list_ci_variables',
    args: {},
    routes: {
      [RPC.listVariables]: ok({
        variables: many(500, (i) => ({
          name: `VAR_${i}`,
          variants: [{ variantName: 'default', value: `value-${i}`, attributes: {} }],
        })),
      }),
    },
    saysTruncated: TRUNCATED_FOOTER,
  },
];

describe.each(GIANT_CASES)('$name against a response far larger than the budget', (giant) => {
  const run = giant.knownToExceed === undefined ? it : it.fails;

  run(
    giant.knownToExceed === undefined
      ? 'keeps the rendered text within the budget and says it was cut'
      : `KNOWN GAP: ${giant.knownToExceed}`,
    async () => {
      harness = await createHarness({ routes: giant.routes, config: { outputCharBudget: BUDGET } });
      await harness.client.listTools();

      const result = await callTool(harness, giant.name, giant.args);

      expect(result.isError, result.text).toBe(false);
      expect(result.text).toMatch(giant.saysTruncated);
      expect(result.text.length).toBeLessThanOrEqual(BUDGET + FOOTER_ALLOWANCE);
    },
  );
});

describe('boundedness gaps', () => {
  it.todo(
    'bounds structuredContent as well as the text: list tools currently return every row Depot sends (pageSize is a request hint Depot may ignore), and diagnose_ci_failure returns every representative attempt per group',
  );

  it('respects the configured budget for a tool that fits, without any truncation note', async () => {
    harness = await createHarness({
      routes: { [RPC.listRuns]: ok(fixture('list-runs')) },
      config: { outputCharBudget: BUDGET },
    });

    const result = await callTool(harness, 'depot_list_ci_runs', {});

    expect(result.text).not.toMatch(/truncated/);
    expect(result.text.length).toBeLessThanOrEqual(BUDGET);
  });
});

/** Pages of sequential log lines, each page pointing at the next except the last. */
function logPages(
  sizes: readonly number[],
  body: (lineNumber: number) => string = (n) => `line ${n}`,
  endless = false,
): StubReply[] {
  let lineNumber = 0;
  return sizes.map((size, page) => {
    const lines = many(size, () => {
      lineNumber += 1;
      return { lineNumber, body: body(lineNumber), stepKey: 'run-tests' };
    });
    const last = page === sizes.length - 1;
    return ok(last && !endless ? { lines } : { lines, nextPageToken: `cursor-${page + 2}` });
  });
}

function lineNumbers(structured: Record<string, unknown>): number[] {
  const value = structured.lines;
  return Array.isArray(value)
    ? value.map((line) => Number((line as Record<string, unknown>).lineNumber))
    : [];
}

describe('depot_get_ci_logs ring buffer', () => {
  it('keeps exactly tailLines lines when the tail straddles a page boundary', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: logPages([4, 4, 4]) },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_x', tailLines: 5 });

    expect(lineNumbers(result.structured)).toEqual([8, 9, 10, 11, 12]);
    expect(result.structured).toMatchObject({
      linesReturned: 5,
      linesMatched: 12,
      pagesFetched: 3,
      truncated: true,
    });
    expect(result.structured.nextPageToken).toBeUndefined();
    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(3);
  });

  it('returns everything, unflagged, when tailLines equals the total line count', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: logPages([4, 4, 4]) },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_x', tailLines: 12 });

    expect(lineNumbers(result.structured)).toEqual(many(12, (i) => i + 1));
    expect(result.structured.truncated).toBe(false);
    expect(result.structured.notes).toEqual([]);
  });

  it('keeps exactly the last page when tailLines equals its size, and a single line for tailLines=1', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: logPages([4, 4, 4]) },
    });
    const lastPage = await callTool(harness, 'depot_get_ci_logs', { id: 'att_x', tailLines: 4 });
    expect(lineNumbers(lastPage.structured)).toEqual([9, 10, 11, 12]);

    await harness.close();
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: logPages([4, 4, 4]) },
    });
    const single = await callTool(harness, 'depot_get_ci_logs', { id: 'att_x', tailLines: 1 });
    expect(lineNumbers(single.structured)).toEqual([12]);
  });

  it('retains early matches when grep hits only in the first page', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getJobAttemptLogs]: logPages([4, 4, 4], (n) => (n <= 4 ? `alpha ${n}` : `beta ${n}`)),
      },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_x',
      grep: 'ALPHA',
      tailLines: 2,
    });

    expect(lineNumbers(result.structured)).toEqual([3, 4]);
    expect(result.structured.linesMatched).toBe(4);
    expect(result.structured.pagesFetched).toBe(3);
  });

  it('fetches at most DEPOT_MCP_MAX_LOG_PAGES pages of an endless log and hands back the next cursor', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: logPages([4, 4, 4, 4, 4, 4], undefined, true) },
      config: { maxLogPages: 3 },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_x', tailLines: 100 });

    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(3);
    expect(lineNumbers(result.structured)).toEqual(many(12, (i) => i + 1));
    expect(result.structured).toMatchObject({
      pagesFetched: 3,
      truncated: true,
      nextPageToken: 'cursor-4',
    });
    expect(JSON.stringify(result.structured.notes)).toContain('DEPOT_MCP_MAX_LOG_PAGES');
  });

  it('honours a cap of one page', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: logPages([4, 4, 4], undefined, true) },
      config: { maxLogPages: 1 },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_x' });

    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(1);
    expect(result.structured.pagesFetched).toBe(1);
    expect(result.structured.nextPageToken).toBe('cursor-2');
  });

  it('stops when Depot echoes the same cursor back instead of looping forever', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getJobAttemptLogs]: [
          ok({ lines: [{ lineNumber: 1, body: 'a' }], nextPageToken: 'same' }),
          ok({ lines: [{ lineNumber: 2, body: 'b' }], nextPageToken: 'same' }),
        ],
      },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: 'att_x' });

    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(2);
    expect(lineNumbers(result.structured)).toEqual([1, 2]);
    expect(result.structured.nextPageToken).toBeUndefined();
  });

  it('reads forward from a cursor and stops once tailLines is filled', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: logPages([4, 4, 4]) },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_x',
      pageToken: 'cursor-1',
      tailLines: 8,
    });

    expect(harness.callsTo(RPC.getJobAttemptLogs)).toHaveLength(2);
    expect(lineNumbers(result.structured)).toEqual(many(8, (i) => i + 1));
    expect(result.structured.nextPageToken).toBe('cursor-3');
  });

  // A forward window that ends mid-page hands back a server-issued cursor naming that page and an
  // offset into it, so the next call re-fetches the same Depot page and skips what was returned.
  // The stub answers in call order, so the reply list mirrors that fetch sequence: page 1 for the
  // first call, page 1 again (resumed at line 3) and then page 2 for the second.
  it('does not skip lines when a forward page is larger than tailLines', async () => {
    const [page1 = ok({}), page2 = ok({})] = logPages([3, 3]);
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: [page1, page1, page2] },
    });

    const first = await callTool(harness, 'depot_get_ci_logs', {
      id: 'att_x',
      pageToken: 'cursor-1',
      tailLines: 2,
    });
    const returned = lineNumbers(first.structured);
    const token = first.structured.nextPageToken;

    if (typeof token === 'string') {
      const next = await callTool(harness, 'depot_get_ci_logs', {
        id: 'att_x',
        pageToken: token,
        tailLines: 2,
      });
      const resumedAt = lineNumbers(next.structured)[0];
      expect(resumedAt).toBe((returned.at(-1) ?? 0) + 1);
    } else {
      expect(returned).toEqual([1, 2, 3]);
    }
  });

  // A not_found probe for an ambiguous id is not a log page: with maxLogPages=2 the ambiguous id
  // still gets two real pages before the cap fires.
  it('counts only log pages, not id-resolution probes, towards the page cap', async () => {
    harness = await createHarness({
      routes: { [RPC.getJobAttemptLogs]: [NOT_FOUND, ...logPages([4, 4, 4], undefined, true)] },
      config: { maxLogPages: 2 },
    });

    const result = await callTool(harness, 'depot_get_ci_logs', { id: '01JQAMBIGUOUS' });

    const logCalls = harness
      .callsTo(RPC.getJobAttemptLogs)
      .filter((call) => call.body.jobId !== undefined);
    expect(logCalls).toHaveLength(2);
    expect(result.structured.pagesFetched).toBe(2);
  });
});

describe('depot_diagnose_build log tail', () => {
  const stepsRoute = ok({
    steps: [
      {
        name: 'RUN npm run build',
        digest: 'sha256:33cc',
        cacheState: 'CACHE_STATE_UNCACHED',
        error: 'exit code: 2',
        hasLogs: true,
      },
    ],
  });

  function stepLogPages(sizes: readonly number[], endless = false): StubReply[] {
    let n = 0;
    return sizes.map((size, page) => {
      const logs = many(size, () => {
        n += 1;
        return { message: `msg ${n}` };
      });
      const last = page === sizes.length - 1;
      return ok(last && !endless ? { logs } : { logs, nextPageToken: `cursor-${page + 2}` });
    });
  }

  it('keeps exactly tailLines trailing messages across page boundaries', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok(fixture('build')),
        [RPC.getBuildSteps]: stepsRoute,
        [RPC.getBuildStepLogs]: stepLogPages([4, 4, 4]),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
      tailLines: 5,
    });

    expect(result.structured.logTail).toEqual(['msg 8', 'msg 9', 'msg 10', 'msg 11', 'msg 12']);
    expect(result.structured.logTruncated).toBe(true);
    expect(harness.callsTo(RPC.getBuildStepLogs)).toHaveLength(3);
    expect(harness.callsTo(RPC.getBuildStepLogs)[2]?.body.pageToken).toBe('cursor-3');
  });

  it('stops reading step logs at DEPOT_MCP_MAX_LOG_PAGES and flags the tail as partial', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok(fixture('build')),
        [RPC.getBuildSteps]: stepsRoute,
        [RPC.getBuildStepLogs]: stepLogPages([4, 4, 4, 4], true),
      },
      config: { maxLogPages: 2 },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
      tailLines: 100,
    });

    expect(harness.callsTo(RPC.getBuildStepLogs)).toHaveLength(2);
    expect(result.structured.logTail).toHaveLength(8);
    expect(result.structured.logTruncated).toBe(true);
  });

  it('pages through the step list and reports the total', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok(fixture('build')),
        [RPC.getBuildSteps]: [
          ok({
            steps: many(3, (i) => ({ name: `step ${i}`, digest: `sha256:${i}`, cacheState: 2 })),
            nextPageToken: 'steps-2',
          }),
          ok({
            steps: [
              { name: 'last', digest: 'sha256:last', cacheState: 1, hasLogs: true, error: 'boom' },
            ],
          }),
        ],
        [RPC.getBuildStepLogs]: ok({ logs: [{ message: 'only line' }] }),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
    });

    expect(result.structured.stepCount).toBe(4);
    expect(harness.callsTo(RPC.getBuildSteps)[1]?.body.pageToken).toBe('steps-2');
    expect(result.structured.logTail).toEqual(['only line']);
    expect(result.structured.logTruncated).toBe(false);
  });

  it('reports a step with no logs instead of fetching them', async () => {
    harness = await createHarness({
      routes: {
        [RPC.getBuild]: ok(fixture('build')),
        [RPC.getBuildSteps]: ok({
          steps: [{ name: 'RUN x', digest: 'sha256:1', cacheState: 1, hasLogs: false, error: 'boom' }],
        }),
      },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
    });

    expect(harness.callsTo(RPC.getBuildStepLogs)).toHaveLength(0);
    expect(result.structured.logTail).toEqual([]);
    expect(JSON.stringify(result.structured.notes)).toContain('no logs for this step');
  });

  it('says so when Depot returns no steps at all', async () => {
    harness = await createHarness({
      routes: { [RPC.getBuild]: ok(fixture('build')), [RPC.getBuildSteps]: ok({}) },
    });

    const result = await callTool(harness, 'depot_diagnose_build', {
      buildId: 'bld_4a91c7',
      projectId: 'proj_api7f2',
    });

    expect(result.isError).toBe(false);
    expect(result.structured.failingStep).toBeUndefined();
    expect(result.text).toContain('no steps');
  });
});
