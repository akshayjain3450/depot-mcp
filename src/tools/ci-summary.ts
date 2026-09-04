import { z } from 'zod';
import { readObject, readString } from '../depot/shape.js';
import { truncateText } from '../lib/budget.js';
import { resolveAttemptTarget } from '../lib/ci-target.js';
import { CI_TARGET_TYPES } from '../lib/resolve.js';
import { defineTool } from '../lib/tool.js';

/**
 * Depot documents `GetJobSummary` as returning the authored step-summary markdown but does not
 * name the field, and there is no published schema for depot.ci.v1 to check against. Try the
 * plausible spellings, at the root and under a nested `summary`, rather than guessing one.
 */
function extractMarkdown(response: Record<string, unknown>): string | undefined {
  const keys = ['markdown', 'summary', 'content', 'body', 'text'] as const;
  const nested = readObject(response, 'summary');
  for (const key of keys) {
    const value = readString(response, key) ?? readString(nested, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export const getCiJobSummaryTool = defineTool({
  name: 'depot_get_ci_job_summary',
  title: 'Get a Depot CI job step summary',
  description: `Read the step summary a Depot CI job authored for itself — the equivalent of GitHub Actions' $GITHUB_STEP_SUMMARY.

This is markdown the job's own steps chose to publish: test result tables, coverage deltas, lint counts, deployment URLs. When a job writes one, it is usually a far better explanation of what happened than its logs, because a human decided what mattered.

Most jobs write nothing here, and an empty result is normal rather than an error. If it comes back empty, use depot_diagnose_ci_failure for a failure, or depot_get_ci_logs for raw output.

"id" accepts an attempt id, a job id, or a run id.`,
  inputSchema: {
    id: z.string().min(1).describe('An attempt id, job id, or run id.'),
    targetType: z
      .enum(CI_TARGET_TYPES)
      .optional()
      .describe('What "id" refers to. Omit to let the server work it out.'),
  },
  outputSchema: {
    target: z.object({
      describedAs: z.string(),
      attemptId: z.string().optional(),
      jobId: z.string().optional(),
    }),
    markdown: z.string(),
    empty: z.boolean(),
    truncated: z.boolean(),
    originalLength: z.number(),
  },
  handler: async (input, context) => {
    const { result, target } = await resolveAttemptTarget(
      context,
      input.id,
      input.targetType,
      (request) => context.api.getJobSummary(request),
    );

    const markdown = extractMarkdown(result);
    const data = {
      target: {
        describedAs: target.describedAs,
        attemptId: target.request.attemptId,
        jobId: target.request.jobId,
      },
    };

    if (markdown === undefined) {
      return {
        summary: `No step summary was published for ${target.describedAs}. Most jobs do not write one; this is not an error. Use depot_diagnose_ci_failure if it failed, or depot_get_ci_logs for raw output.`,
        data: { ...data, markdown: '', empty: true, truncated: false, originalLength: 0 },
      };
    }

    const capped = truncateText(markdown, context.config.outputCharBudget - 200);
    return {
      summary: `Step summary for ${target.describedAs}:\n\n${capped.text}${
        capped.truncated
          ? `\n\n[truncated: ${capped.originalLength} characters in the original]`
          : ''
      }`,
      data: {
        ...data,
        markdown: capped.text,
        empty: false,
        truncated: capped.truncated,
        originalLength: capped.originalLength,
      },
    };
  },
});
