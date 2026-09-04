import { z } from 'zod';
import { readNumber, readObjectArray, readString } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import { defineTool, ToolInputError } from '../lib/tool.js';

function formatMib(bytes: number | undefined): string {
  return bytes === undefined ? 'unknown size' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export const listImagesTool = defineTool({
  name: 'depot_list_images',
  title: 'List images in a Depot project registry',
  description: `List the container images stored in a Depot project's registry, with tag, digest, push time, and size.

Use this to check whether a build actually pushed what you expected, to find the digest behind a tag before a deploy, or to see when an image was last refreshed.

Requires a projectId; DEPOT_PROJECT_ID is used when set, and depot_list_projects lists the options.

Read-only: this cannot delete tags or images. Image deletion is deliberately not exposed by this server, since it is irreversible and something may be deploying what you delete.`,
  inputSchema: {
    projectId: z
      .string()
      .optional()
      .describe('The project whose registry to list. Falls back to DEPOT_PROJECT_ID.'),
    limit: z.number().int().min(1).max(200).default(50).describe('Maximum images to return.'),
    pageToken: z.string().optional().describe('nextPageToken from a previous call.'),
  },
  outputSchema: {
    projectId: z.string(),
    images: z.array(
      z.object({
        tag: z.string().optional(),
        digest: z.string().optional(),
        pushedAt: z.string().optional(),
        sizeBytes: z.number().optional(),
      }),
    ),
    returned: z.number(),
    nextPageToken: z.string().optional(),
  },
  handler: async (input, context) => {
    const projectId = input.projectId ?? context.config.projectId;
    if (projectId === undefined) {
      throw new ToolInputError(
        'A projectId is required to list registry images. Call depot_list_projects to see the options, or set DEPOT_PROJECT_ID.',
      );
    }

    const response = await context.api.listImages({
      projectId,
      pageSize: input.limit,
      pageToken: input.pageToken,
    });
    const images = readObjectArray(response, 'images').map((entry) => ({
      tag: readString(entry, 'tag'),
      digest: readString(entry, 'digest'),
      pushedAt: readString(entry, 'pushedAt'),
      sizeBytes: readNumber(entry, 'sizeBytes'),
    }));
    const nextPageToken = readString(response, 'nextPageToken');

    const text = new TextBudget(context.config.outputCharBudget);
    if (images.length === 0) {
      text.push(
        `No images are stored in project ${projectId}'s registry.`,
        'Builds only land here when they push to the Depot registry; a build that only produced a local image will not appear.',
      );
    } else {
      text.push(`${images.length} image(s) in project ${projectId}:`);
      for (const image of images) {
        text.push(
          `  ${image.tag ?? '<untagged>'} — ${formatMib(image.sizeBytes)} · pushed ${image.pushedAt ?? 'unknown'}${
            image.digest === undefined ? '' : ` · ${image.digest}`
          }`,
        );
      }
    }
    if (nextPageToken !== undefined) {
      text.push('', `More images available: re-call with pageToken="${nextPageToken}".`);
    }

    return {
      summary: text.render(),
      data: { projectId, images, returned: images.length, nextPageToken },
    };
  },
});
