import { z } from 'zod';
import { readNumber, readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import { defineTool, ToolInputError } from '../lib/tool.js';

const MAX_SIGNED_URLS = 10;

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return 'unknown size';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'KiB'}`;
}

export const listCiArtifactsTool = defineTool({
  name: 'depot_list_ci_artifacts',
  title: 'List Depot CI artifacts',
  description: `List the artifacts a Depot CI run, workflow, job, or attempt uploaded, optionally with signed download URLs.

Use this to find out what a run produced — test reports, JUnit XML, coverage output, built binaries, screenshots from a failed browser test. Filter to one job or attempt by passing its id alongside runId.

Set withDownloadUrl=true to also fetch signed HTTPS URLs, which are minted one request per artifact and capped at ${MAX_SIGNED_URLS} per call. This tool never downloads or reads artifact contents; it returns metadata and links only.`,
  inputSchema: {
    runId: z.string().optional().describe('The run whose artifacts you want.'),
    workflowId: z.string().optional().describe('Narrow to one workflow within the run.'),
    jobId: z.string().optional().describe('Narrow to one job.'),
    attemptId: z.string().optional().describe('Narrow to one attempt.'),
    withDownloadUrl: z
      .boolean()
      .default(false)
      .describe(
        `Also mint a signed download URL per artifact. Costs one extra request each, capped at ${MAX_SIGNED_URLS}.`,
      ),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum artifacts to return.'),
    pageToken: z
      .string()
      .optional()
      .describe(
        'Continue a previous listing: pass the nextPageToken from the last call, with the same filters.',
      ),
  },
  outputSchema: {
    artifacts: z.array(
      z.object({
        artifactId: z.string().optional(),
        name: z.string().optional(),
        sizeBytes: z.number().optional(),
        createdAt: z.string().optional(),
        downloadUrl: z.string().optional(),
      }),
    ),
    returned: z.number(),
    nextPageToken: z.string().optional(),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    if (
      input.runId === undefined &&
      input.workflowId === undefined &&
      input.jobId === undefined &&
      input.attemptId === undefined
    ) {
      throw new ToolInputError(
        'Pass at least one of runId, workflowId, jobId, or attemptId. Use depot_list_ci_runs to find a runId.',
      );
    }

    const response = await context.api.listArtifacts({
      runId: input.runId,
      workflowId: input.workflowId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      pageSize: input.limit,
      pageToken: input.pageToken,
    });

    const artifacts = readObjectArray(response, 'artifacts').map((entry) => ({
      artifactId: readString(entry, 'artifactId', 'id'),
      name: readString(entry, 'name', 'path'),
      sizeBytes: readNumber(entry, 'sizeBytes', 'size'),
      createdAt: readString(entry, 'createdAt', 'uploadedAt'),
      downloadUrl: undefined as string | undefined,
    }));

    const notes: string[] = [];
    if (input.withDownloadUrl) {
      const eligible = artifacts.slice(0, MAX_SIGNED_URLS);
      for (const artifact of eligible) {
        if (artifact.artifactId === undefined) {
          continue;
        }
        const urlResponse = await context.api.getArtifactDownloadUrl(artifact.artifactId);
        artifact.downloadUrl = readString(urlResponse, 'downloadUrl', 'url', 'signedUrl');
      }
      if (artifacts.length > eligible.length) {
        notes.push(
          `Signed URLs were minted for the first ${MAX_SIGNED_URLS} artifacts only; re-call with a narrower filter for the rest.`,
        );
      }
    }

    const nextPageToken = readString(response, 'nextPageToken');
    if (nextPageToken !== undefined) {
      notes.push(
        'More artifacts available: re-call with pageToken set to nextPageToken, or with a narrower filter.',
      );
    }

    const text = new TextBudget(context.config.outputCharBudget);
    if (artifacts.length === 0) {
      text.push(
        'No artifacts were uploaded for that target.',
        'Depot CI only stores artifacts a workflow explicitly uploads, so an empty list often just means the workflow does not upload any.',
      );
    } else {
      text.push(`${artifacts.length} artifact(s):`);
      for (const artifact of artifacts) {
        text.push(
          `  ${artifact.name ?? 'unnamed'} — ${formatBytes(artifact.sizeBytes)}${
            artifact.artifactId === undefined ? '' : ` (artifactId=${artifact.artifactId})`
          }`,
        );
        if (artifact.downloadUrl !== undefined) {
          text.push(`    ${artifact.downloadUrl}`);
        }
      }
      if (notes.length > 0) {
        text.push('', ...notes.map((note) => `note: ${note}`));
      }
    }

    return {
      summary: text.render(),
      data: { artifacts, returned: artifacts.length, nextPageToken, notes },
    };
  },
});

export interface SignedUrlExpiry {
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
}

/**
 * A signed S3 URL carries its own lifetime in the query string (`X-Amz-Date` plus
 * `X-Amz-Expires` seconds). Read it when present so the caller knows how long the link lives;
 * anything unparseable is reported as unknown rather than guessed.
 */
export function signedUrlExpiry(url: string, now: number): SignedUrlExpiry | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const date = parsed.searchParams.get('X-Amz-Date');
  const expires = Number(parsed.searchParams.get('X-Amz-Expires'));
  const match = date === null ? null : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (match === null || !Number.isFinite(expires) || expires <= 0) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match;
  const signedAt = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  if (Number.isNaN(signedAt)) {
    return undefined;
  }
  const expiresAtMs = signedAt + expires * 1000;
  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresInSeconds: Math.round((expiresAtMs - now) / 1000),
  };
}

function formatExpiry(seconds: number): string {
  return seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

export const URL_HANDLING_WARNING =
  'This URL is a bearer capability: anyone who has it can download the artifact until it expires, with no Depot token. Use it right away and do not paste it into commit messages, issues, pull requests, chat, logs, or files.';

export const getCiArtifactUrlTool = defineTool({
  name: 'depot_get_ci_artifact_url',
  title: 'Get a signed download URL for one Depot CI artifact',
  description: `Mint a short-lived signed download URL for one Depot CI artifact, by artifact id.

Use this when you already know which artifact you want (from depot_list_ci_artifacts) and need to fetch it: a JUnit report to read the failing test names, a screenshot from a browser test, a built binary. Download it with curl or fetch as soon as you have the URL, since Depot signs it for minutes, not hours.

The URL is a bearer capability. Anyone holding it can download the artifact until it expires, so treat it like a credential: use it immediately and never write it anywhere durable (commit messages, issues, chat, files). This tool returns the URL only; it does not download the artifact or read its contents, and it cannot upload, replace, or delete anything.

To see what a run produced, or to get URLs for several artifacts in one call, use depot_list_ci_artifacts (with withDownloadUrl=true) instead.`,
  inputSchema: {
    artifactId: z
      .string()
      .trim()
      .min(1)
      .describe('The artifact id, as returned by depot_list_ci_artifacts.'),
  },
  outputSchema: {
    artifactId: z.string(),
    downloadUrl: z.string().describe('Signed HTTPS URL. Short-lived; do not store it.'),
    expiresAt: z.string().optional().describe('When the signature expires, when the URL says so.'),
    expiresInSeconds: z.number().optional(),
    warning: z.string().describe('Handling instructions: the URL is a bearer capability.'),
  },
  handler: async (input, context) => {
    const response = await context.api.getArtifactDownloadUrl(input.artifactId);
    const downloadUrl = readString(response, 'downloadUrl', 'url', 'signedUrl');
    if (downloadUrl === undefined) {
      throw new ToolInputError(
        `Depot answered without a download URL for artifact ${input.artifactId}. The artifact may have expired or been deleted; depot_list_ci_artifacts shows what is still stored.`,
      );
    }
    const expiry = signedUrlExpiry(downloadUrl, context.now());
    const expiresAt = readString(response, 'expiresAt', 'expiry') ?? expiry?.expiresAt;

    const lifetime =
      expiry === undefined
        ? 'short-lived'
        : expiry.expiresInSeconds > 0
          ? `expires in about ${formatExpiry(expiry.expiresInSeconds)}, at ${expiry.expiresAt}`
          : 'the signature appears to have expired already; call again for a fresh one';

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(
      `Signed download URL for artifact ${input.artifactId} (${lifetime}):`,
      downloadUrl,
      '',
      URL_HANDLING_WARNING,
    );

    return {
      summary: text.render(),
      data: {
        artifactId: input.artifactId,
        downloadUrl,
        expiresAt,
        expiresInSeconds: expiry?.expiresInSeconds,
        warning: URL_HANDLING_WARNING,
      },
    };
  },
});
