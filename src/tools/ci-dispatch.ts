import { z } from 'zod';
import type { DispatchAllowlistEntry } from '../config.js';
import { readObjectArray, readString, type JsonObject } from '../depot/shape.js';
import { truncateText } from '../lib/budget.js';
import { parseWorkflowListEntry, type WorkflowListEntry } from '../lib/ci-workflow.js';
import { summariseMutationResponse } from '../lib/ci-write-detail.js';
import { defineWriteTool } from '../lib/write.js';

/** GitHub's `workflow_dispatch` accepts at most 10 inputs; twice that leaves room for Depot's own. */
export const DISPATCH_MAX_INPUTS = 20;
/** Longer values are files, not parameters, and would bloat the request and the audit trail. */
export const DISPATCH_MAX_INPUT_CHARS = 1000;

/** How many of the repository's recent workflows are read to find the last run of this one. */
const RECENT_WORKFLOW_PAGE = 50;
const RECENT_NAMES_SHOWN = 8;
const NAME_CHAR_LIMIT = 120;

/** `owner/name` as GitHub spells it: no spaces, no extra path segments, no `.git` games. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/**
 * Validates the argument shapes without touching Depot. Returns the reason the dispatch must
 * not proceed, or undefined when the arguments are well-formed. Used by the preview (to skip the
 * read when there is no point) and by the refusal step.
 */
export function dispatchArgumentProblem(input: {
  repo: string;
  workflow: string;
  ref: string;
  inputs?: Record<string, string> | undefined;
}): string | undefined {
  const repo = input.repo.trim();
  const workflow = input.workflow.trim();
  const ref = input.ref.trim();
  if (!REPO_PATTERN.test(repo)) {
    return `repo must be a GitHub repository in owner/name form (for example acme/api), not ${JSON.stringify(truncateText(input.repo, 80).text)}.`;
  }
  if (workflow === '') {
    return 'workflow is empty; pass the workflow file basename, for example ci.yml.';
  }
  if (/[/\\]/.test(workflow)) {
    return `workflow must be the file basename (for example deploy.yml), not a path like ${JSON.stringify(truncateText(workflow, 80).text)}. Depot resolves it under .github/workflows itself.`;
  }
  if (/\s/.test(workflow)) {
    return `workflow ${JSON.stringify(truncateText(workflow, 80).text)} contains whitespace; pass the workflow file basename, for example ci.yml.`;
  }
  if (ref === '') {
    return 'ref is empty; pass the branch, tag, or commit SHA the workflow should run on (for example main).';
  }
  const inputs = input.inputs ?? {};
  const keys = Object.keys(inputs);
  if (keys.length > DISPATCH_MAX_INPUTS) {
    return `inputs has ${keys.length} keys; at most ${DISPATCH_MAX_INPUTS} are accepted.`;
  }
  for (const key of keys) {
    const value = inputs[key] ?? '';
    if (key.trim() === '') {
      return 'inputs contains an empty key.';
    }
    if (value.length > DISPATCH_MAX_INPUT_CHARS) {
      return `inputs.${key} is ${value.length} characters long; each value is capped at ${DISPATCH_MAX_INPUT_CHARS}. Put large content in the repository, not in a dispatch input.`;
    }
  }
  return undefined;
}

/** True when no allowlist is configured, or when this repository and workflow file are on it. */
export function isDispatchAllowed(
  repo: string,
  workflow: string,
  allowlist: readonly DispatchAllowlistEntry[] | undefined,
): boolean {
  if (allowlist === undefined) {
    return true;
  }
  const wanted = repo.trim().toLowerCase();
  const file = workflow.trim();
  return allowlist.some((entry) => entry.repo === wanted && entry.workflow === file);
}

function allowlistRefusal(
  repo: string,
  workflow: string,
  allowlist: readonly DispatchAllowlistEntry[],
): string {
  const listed = allowlist.map((entry) => `${entry.repo}:${entry.workflow}`).join(', ');
  return `${repo}:${workflow} is not on DEPOT_MCP_DISPATCH_ALLOWLIST (${listed}). The operator of this server decides which workflows an agent may start; ask them to add it.`;
}

type MatchKind = 'path' | 'name' | 'prefix';

const MATCH_RANK: Readonly<Record<MatchKind, number>> = { path: 0, name: 1, prefix: 2 };

function stem(workflow: string): string {
  return workflow.replace(/\.ya?ml$/i, '');
}

/**
 * Depot reports the workflow file (`workflowPath`) on some rows and only the YAML `name:` on
 * others, and the two rarely agree with the basename an operator types. Match the file first,
 * then the name against the basename or its stem, then a name that begins with the stem.
 */
export function matchWorkflowEntry(entry: WorkflowListEntry, workflow: string): MatchKind | undefined {
  const wanted = workflow.toLowerCase();
  const wantedStem = stem(wanted);
  if (entry.workflowPath !== undefined && entry.workflowPath.toLowerCase() === wanted) {
    return 'path';
  }
  const name = entry.name?.toLowerCase();
  if (name === undefined || name === '') {
    return undefined;
  }
  if (name === wanted || name === wantedStem) {
    return 'name';
  }
  if (wantedStem !== '' && (name.startsWith(`${wantedStem}-`) || name.startsWith(`${wantedStem}_`) || name.startsWith(`${wantedStem} `))) {
    return 'prefix';
  }
  return undefined;
}

const lastRunSchema = z.object({
  workflowId: z.string().optional(),
  runId: z.string().optional(),
  name: z.string().optional(),
  workflowPath: z.string().optional(),
  status: z.string().optional(),
  trigger: z.string().optional(),
  sha: z.string().optional(),
  createdAt: z.string().optional(),
  /** How the row was matched to the requested file: path, name, or a name beginning with the stem. */
  matchedBy: z.enum(['path', 'name', 'prefix']),
});

type LastRun = z.input<typeof lastRunSchema>;

function pickLastRun(entries: readonly WorkflowListEntry[], workflow: string): LastRun | undefined {
  let best: { entry: WorkflowListEntry; kind: MatchKind } | undefined;
  // Entries arrive newest first, so the first row of the best rank is the most recent.
  for (const entry of entries) {
    const kind = matchWorkflowEntry(entry, workflow);
    if (kind !== undefined && (best === undefined || MATCH_RANK[kind] < MATCH_RANK[best.kind])) {
      best = { entry, kind };
    }
  }
  if (best === undefined) {
    return undefined;
  }
  return {
    workflowId: best.entry.workflowId,
    runId: best.entry.runId,
    name: best.entry.name,
    workflowPath: best.entry.workflowPath,
    status: best.entry.status,
    trigger: best.entry.trigger,
    sha: best.entry.sha ?? best.entry.headSha,
    createdAt: best.entry.createdAt,
    matchedBy: best.kind,
  };
}

function describeLastRun(last: LastRun): string {
  const bits = [
    last.status ?? 'unknown status',
    last.trigger === undefined ? undefined : `via ${last.trigger}`,
    last.sha === undefined ? undefined : last.sha.slice(0, 8),
    last.createdAt,
  ].filter((bit): bit is string => bit !== undefined);
  const how =
    last.matchedBy === 'path'
      ? 'matched by workflow file'
      : last.matchedBy === 'name'
        ? 'matched by workflow name'
        : 'probably the same workflow, matched by name prefix';
  return `Last run of this workflow: ${last.runId === undefined ? 'unknown run' : `run ${last.runId}`}${last.workflowId === undefined ? '' : ` (workflowId=${last.workflowId})`}, "${truncateText(last.name ?? last.workflowPath ?? 'unnamed', NAME_CHAR_LIMIT).text}" ${bits.join(' · ')}; ${how}.`;
}

export const dispatchCiWorkflowTool = defineWriteTool({
  name: 'depot_dispatch_ci_workflow',
  title: 'Dispatch a Depot CI workflow',
  description: `Start a new Depot CI run of one workflow file on a branch, tag, or commit (DispatchWorkflow), with optional workflow_dispatch inputs. The API form of \`depot ci dispatch\`.

Use this when a workflow needs to run now without a push: a manual deploy, a nightly job on demand, a release workflow on a tag. The workflow must declare an on.workflow_dispatch trigger and the repository must be connected to Depot's GitHub app; Depot validates inputs against the workflow's own input schema. This starts real CI compute and, if the workflow deploys or publishes, real side effects: the preview says so, and shows the last run of the same workflow and how it ended so the user knows what they are starting. Each call creates a new run, so it is not idempotent.

When DEPOT_MCP_DISPATCH_ALLOWLIST is set, only the listed owner/name:workflow.yml pairs may be dispatched and everything else is refused before any request. Also refuses a repo that is not owner/name, a workflow that is a path rather than a file basename, an empty ref, and more than ${DISPATCH_MAX_INPUTS} inputs or any input value over ${DISPATCH_MAX_INPUT_CHARS} characters. After the user confirms the preview, call again with dryRun:false to apply; the result carries the new run id for depot_wait_for_ci_run.`,
  inputSchema: {
    repo: z
      .string()
      .trim()
      .describe('GitHub repository in owner/name form, as shown by depot_list_ci_runs (repo=...).'),
    workflow: z
      .string()
      .trim()
      .describe('The workflow file basename under .github/workflows, for example ci.yml or deploy.yml. Not a path, and not the YAML name: field.'),
    ref: z
      .string()
      .trim()
      .describe('Branch, tag, or commit SHA to run the workflow on, for example main.'),
    inputs: z
      .record(z.string(), z.string())
      .optional()
      .describe(`workflow_dispatch inputs as a flat object of string values (Depot coerces types). At most ${DISPATCH_MAX_INPUTS} keys, each value at most ${DISPATCH_MAX_INPUT_CHARS} characters. Omit when the workflow takes none.`),
  },
  previewSchema: {
    repo: z.string(),
    workflow: z.string(),
    ref: z.string(),
    inputCount: z.number(),
    inputKeys: z.array(z.string()),
    allowlistActive: z.boolean(),
    allowlisted: z.boolean(),
    argumentProblem: z.string().optional(),
    lastRun: lastRunSchema.optional(),
    recentWorkflowCount: z.number(),
    recentNames: z.array(z.string()),
  },
  afterSchema: {
    rpc: z.string(),
    runId: z.string().optional(),
    workflowId: z.string().optional(),
    ids: z.record(z.string(), z.string()),
    responseKeys: z.array(z.string()),
  },
  destructive: false,
  idempotent: false,
  preview: async (input, context) => {
    const repo = input.repo;
    const workflow = input.workflow;
    const ref = input.ref;
    const inputKeys = Object.keys(input.inputs ?? {}).sort();
    const allowlist = context.config.dispatchAllowlist;
    const allowlisted = isDispatchAllowed(repo, workflow, allowlist);
    const problem =
      dispatchArgumentProblem(input) ??
      (allowlist !== undefined && !allowlisted ? allowlistRefusal(repo, workflow, allowlist) : undefined);

    const lines = [
      `DispatchWorkflow would start ${workflow} in ${repo} on ref ${ref} with ${inputKeys.length === 0 ? 'no inputs' : `${inputKeys.length} input(s): ${inputKeys.join(', ')}`}.`,
      'This starts a real CI run: it spends compute minutes and, if the workflow deploys or publishes, has real effects outside Depot. Check what the workflow does before applying.',
      allowlist === undefined
        ? 'DEPOT_MCP_DISPATCH_ALLOWLIST is not set, so any repository this token can see may be dispatched.'
        : `DEPOT_MCP_DISPATCH_ALLOWLIST is set (${allowlist.length} entry(ies)); ${repo}:${workflow} is ${allowlisted ? 'on it' : 'NOT on it'}.`,
    ];

    // Nothing to read when the arguments are already refused: the read would only cost a request.
    if (problem !== undefined) {
      lines.push(`Arguments not accepted: ${problem}`);
      return {
        data: {
          repo,
          workflow,
          ref,
          inputCount: inputKeys.length,
          inputKeys,
          allowlistActive: allowlist !== undefined,
          allowlisted,
          argumentProblem: problem,
          recentWorkflowCount: 0,
          recentNames: [],
        },
        lines,
      };
    }

    const response = await context.api.listWorkflows({ repo, pageSize: RECENT_WORKFLOW_PAGE });
    const entries = readObjectArray(response, 'workflows').map(parseWorkflowListEntry);
    const lastRun = pickLastRun(entries, workflow);
    const recentNames = [...new Set(entries.map((entry) => entry.workflowPath ?? entry.name).filter((name): name is string => name !== undefined))].slice(0, RECENT_NAMES_SHOWN);

    if (lastRun !== undefined) {
      lines.push(describeLastRun(lastRun));
    } else if (entries.length === 0) {
      lines.push(`Depot lists no workflows for ${repo}: either nothing has run there yet, the repository is not connected to Depot, or this token cannot see it. The dispatch may still be accepted; Depot will answer not_found or invalid_argument otherwise.`);
    } else {
      lines.push(`No previous run of ${workflow} among the ${entries.length} most recent workflow(s) in ${repo} (seen: ${recentNames.join(', ')}). Depot will refuse the dispatch if the file does not exist or lacks a workflow_dispatch trigger.`);
    }

    return {
      data: {
        repo,
        workflow,
        ref,
        inputCount: inputKeys.length,
        inputKeys,
        allowlistActive: allowlist !== undefined,
        allowlisted,
        lastRun,
        recentWorkflowCount: entries.length,
        recentNames,
      },
      lines,
    };
  },
  refuse: (preview) => preview.argumentProblem,
  apply: async (input, context, preview) => {
    const response: JsonObject = await context.api.dispatchWorkflow({
      repo: preview.repo,
      workflow: preview.workflow,
      ref: preview.ref,
      inputs: input.inputs,
    });
    const summary = summariseMutationResponse(response);
    const runId = readString(response, 'runId', 'run_id', 'id');
    const workflowId = readString(response, 'workflowId', 'workflow_id');
    const lines = [
      `DispatchWorkflow accepted: ${runId === undefined ? 'Depot returned no run id' : `new run ${runId}`}${workflowId === undefined ? '' : ` (workflowId=${workflowId})`} for ${preview.workflow} in ${preview.repo} on ${preview.ref}.`,
      runId === undefined
        ? 'Find the run with depot_list_ci_runs filtered by repo, then follow it with depot_wait_for_ci_run.'
        : `Follow it with depot_wait_for_ci_run {"runId":"${runId}"}; depot_get_ci_run shows its jobs, and depot_diagnose_ci_failure explains a failure.`,
    ];
    return {
      data: { rpc: 'DispatchWorkflow', runId, workflowId, ids: summary.ids, responseKeys: summary.keys },
      lines,
    };
  },
});
