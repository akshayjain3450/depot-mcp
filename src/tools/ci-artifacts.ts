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
