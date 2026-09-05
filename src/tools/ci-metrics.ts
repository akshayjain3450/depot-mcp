import { z } from 'zod';
import { readNumber, readString, type JsonObject } from '../depot/shape.js';
import { truncateText } from '../lib/budget.js';
import { isWrongTargetError } from '../lib/ci-target.js';
import { inferTargetType, type CiTargetType } from '../lib/resolve.js';
import { defineTool, ToolInputError, type ToolContext } from '../lib/tool.js';

const METRIC_LEVELS = ['run', 'job', 'attempt'] as const;

type MetricLevel = (typeof METRIC_LEVELS)[number];

const RAW_JSON_CHAR_LIMIT = 6_000;

interface RecognizedMetrics {
  peakMemoryBytes: number | undefined;
  memoryLimitBytes: number | undefined;
  peakCpuPercent: number | undefined;
  avgCpuPercent: number | undefined;
  capturedAt: string | undefined;
}

/**
 * Depot documents that these RPCs return CPU and memory summaries but publishes no field names for
 * them, so recognised fields are a best-effort read and the bounded raw document is always
 * returned alongside so nothing useful is hidden.
 */
function recognizeMetrics(response: JsonObject): RecognizedMetrics {
  return {
    peakMemoryBytes: readNumber(response, 'peakMemoryBytes', 'memoryPeakBytes', 'maxMemoryBytes'),
    memoryLimitBytes: readNumber(response, 'memoryLimitBytes', 'memoryLimit', 'limitMemoryBytes'),
    peakCpuPercent: readNumber(response, 'peakCpuPercent', 'cpuPeakPercent', 'maxCpuPercent'),
    avgCpuPercent: readNumber(response, 'avgCpuPercent', 'averageCpuPercent', 'cpuAveragePercent'),
    capturedAt: readString(response, 'capturedAt', 'snapshotAt', 'sampledAt'),
  };
}

async function fetchMetrics(
  context: ToolContext,
  id: string,
  level: MetricLevel,
): Promise<JsonObject> {
  switch (level) {
    case 'run':
      return context.api.getRunMetrics(id);
    case 'job':
      return context.api.getJobMetrics(id);
    case 'attempt':
      return context.api.getJobAttemptMetrics(id);
  }
}

function candidateLevels(id: string, explicit: MetricLevel | undefined): MetricLevel[] {
  if (explicit !== undefined) {
    return [explicit];
  }
  const inferred: CiTargetType | undefined = inferTargetType(id);
  if (inferred === 'run' || inferred === 'job' || inferred === 'attempt') {
    return [inferred];
  }
  return [...METRIC_LEVELS];
}

export const getCiMetricsTool = defineTool({
  name: 'depot_get_ci_metrics',
  title: 'Get Depot CI CPU and memory metrics',
  description: `Read CPU and memory metrics for a Depot CI run, job, or job attempt.

Use this when a job died without a useful error, was killed abruptly, hit an exit code like 137, or is simply slow — the shapes to look for are memory sitting at its limit (an OOM kill) or CPU pinned at 100% for the whole job (under-provisioned runner).

"id" accepts a run, job, or attempt id and the level is inferred; set "level" to pick explicitly. Note that metrics for a still-running attempt grow between calls, so a snapshot time is reported.

Depot does not publish field names for these responses, so this tool returns the metrics it recognises plus the raw document (bounded) so nothing is lost. Very large metrics results are rejected by Depot itself with a resource-exhausted error — ask for a single attempt rather than a whole run if that happens.`,
  inputSchema: {
    id: z.string().min(1).describe('A run id, job id, or attempt id.'),
    level: z
      .enum(METRIC_LEVELS)
      .optional()
      .describe(
        'Which level "id" refers to. Omit to infer; the server otherwise tries run, then job, then attempt.',
      ),
  },
  outputSchema: {
    level: z.string(),
    id: z.string(),
    metrics: z.object({
      peakMemoryBytes: z.number().optional(),
      memoryLimitBytes: z.number().optional(),
      peakCpuPercent: z.number().optional(),
      avgCpuPercent: z.number().optional(),
      capturedAt: z.string().optional(),
    }),
    likelyOom: z.boolean().optional(),
    rawJson: z.string().describe("Depot's metrics document as JSON text, truncated if large."),
    rawTruncated: z.boolean(),
  },
  handler: async (input, context) => {
    const levels = candidateLevels(input.id, input.level);
    let response: JsonObject | undefined;
    let resolved: MetricLevel | undefined;

    for (const level of levels) {
      try {
        response = await fetchMetrics(context, input.id, level);
        resolved = level;
        break;
      } catch (error) {
        if (!isWrongTargetError(error)) {
          throw error;
        }
      }
    }

    if (response === undefined || resolved === undefined) {
      throw new ToolInputError(
        `Depot has no metrics for "${input.id}" as a run, job, or attempt. Check the id with depot_get_ci_run, and set DEPOT_ORG_ID if your token spans several organizations.`,
      );
    }

    const metrics = recognizeMetrics(response);
    const likelyOom =
      metrics.peakMemoryBytes !== undefined &&
      metrics.memoryLimitBytes !== undefined &&
      metrics.memoryLimitBytes > 0
        ? metrics.peakMemoryBytes / metrics.memoryLimitBytes >= 0.95
        : undefined;

    // Leave room for the header lines and the truncation footer inside the configured budget.
    const rawLimit = Math.max(
      200,
      Math.min(RAW_JSON_CHAR_LIMIT, context.config.outputCharBudget - 1_200),
    );
    const raw = truncateText(JSON.stringify(response, null, 2), rawLimit);
    const lines = [`Depot CI metrics for ${resolved} ${input.id}.`];
    if (metrics.peakMemoryBytes !== undefined) {
      lines.push(`Peak memory: ${metrics.peakMemoryBytes} bytes.`);
    }
    if (metrics.memoryLimitBytes !== undefined) {
      lines.push(`Memory limit: ${metrics.memoryLimitBytes} bytes.`);
    }
    if (likelyOom === true) {
      lines.push('Peak memory is within 5% of the limit — an out-of-memory kill is likely.');
    }
    if (metrics.capturedAt !== undefined) {
      lines.push(`Snapshot taken at ${metrics.capturedAt}.`);
    }
    lines.push(
      '',
      'Raw metrics document (Depot does not publish a schema for this response):',
      raw.text,
    );
    if (raw.truncated) {
      lines.push(`[truncated: ${raw.originalLength} characters in the original]`);
    }

    return {
      summary: lines.join('\n'),
      data: {
        level: resolved,
        id: input.id,
        metrics,
        likelyOom,
        rawJson: raw.text,
        rawTruncated: raw.truncated,
      },
    };
  },
});
