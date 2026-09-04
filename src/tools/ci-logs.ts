import { z } from 'zod';
import {
  readEnum,
  readNumber,
  readObjectArray,
  readString,
  type JsonObject,
} from '../depot/shape.js';
import { keepTailWithinBudget, TextBudget } from '../lib/budget.js';
import { resolveAttemptTarget, type AttemptOrJob } from '../lib/ci-target.js';
import { CI_TARGET_TYPES } from '../lib/resolve.js';
import { defineTool, type ToolContext } from '../lib/tool.js';

interface LogLine {
  stepKey: string | undefined;
  stream: string | undefined;
  lineNumber: number | undefined;
  timestamp: string | undefined;
  body: string;
}

function parseLine(source: JsonObject): LogLine {
  const timestampMs = readNumber(source, 'timestampMs');
  return {
    stepKey: readString(source, 'stepKey', 'stepId'),
    stream: readEnum(source, ['stream'], ['stream', 'log_stream']),
    lineNumber: readNumber(source, 'lineNumber'),
    timestamp: timestampMs === undefined ? undefined : new Date(timestampMs).toISOString(),
    body: readString(source, 'body', 'content', 'message') ?? '',
  };
}

interface CollectOptions {
  readonly tailLines: number;
  readonly startToken: string | undefined;
  readonly keepTail: boolean;
  readonly match: (line: LogLine) => boolean;
}

interface CollectResult {
  readonly lines: LogLine[];
  readonly describedAs: string;
  readonly request: AttemptOrJob;
  readonly pagesFetched: number;
  readonly pageCapHit: boolean;
  readonly nextPageToken: string | undefined;
  readonly matched: number;
}

/**
 * `GetJobAttemptLogs` pages oldest-first with no tail parameter, so a tail means reading forward
 * and keeping only the last `tailLines` in a ring buffer, bounded by DEPOT_MCP_MAX_LOG_PAGES.
 */
async function collectLines(
  context: ToolContext,
  id: string,
  explicit: (typeof CI_TARGET_TYPES)[number] | undefined,
  options: CollectOptions,
): Promise<CollectResult> {
  const buffer: LogLine[] = [];
  let matched = 0;
  let pagesFetched = 0;

  const resolved = await resolveAttemptTarget(context, id, explicit, (request) => {
    pagesFetched += 1;
    return context.api.getJobAttemptLogs({ ...request, pageToken: options.startToken });
  });

  const request = resolved.target.request;
  let response = resolved.result;
  let pageToken = options.startToken;

  for (;;) {
    const page = readObjectArray(response, 'lines').map(parseLine).filter(options.match);
    matched += page.length;
    for (const line of page) {
      buffer.push(line);
      if (options.keepTail && buffer.length > options.tailLines) {
        buffer.shift();
      }
    }

    const nextPageToken = readString(response, 'nextPageToken');
    const base = {
      lines: options.keepTail ? buffer : buffer.slice(0, options.tailLines),
      describedAs: resolved.target.describedAs,
      request,
      pagesFetched,
      matched,
    };

    if (nextPageToken === undefined || nextPageToken === pageToken) {
      return { ...base, pageCapHit: false, nextPageToken: undefined };
    }
    if (!options.keepTail && buffer.length >= options.tailLines) {
      return { ...base, pageCapHit: false, nextPageToken };
    }
    if (pagesFetched >= context.config.maxLogPages) {
      return { ...base, pageCapHit: true, nextPageToken };
    }

    pageToken = nextPageToken;
    pagesFetched += 1;
    response = await context.api.getJobAttemptLogs({ ...request, pageToken });
  }
}

const logLineSchema = z.object({
  stepKey: z.string().optional(),
  stream: z.string().optional(),
  lineNumber: z.number().optional(),
  timestamp: z.string().optional(),
  body: z.string(),
});

export const getCiLogsTool = defineTool({
  name: 'depot_get_ci_logs',
  title: 'Get Depot CI job logs',
  description: `Fetch a bounded slice of the persisted logs for a Depot CI job attempt.

Try depot_diagnose_ci_failure first. It is cheaper, it already contains the relevant log lines with a diagnosis attached, and it identifies which job actually broke. Use this tool when you need detail the diagnosis did not include: the full traceback, output from a step that did not fail, or a specific pattern.

Defaults to the last 200 matching lines, because failures land at the end of a log. Set "grep" to a substring (case-insensitive, not a regex) to search the whole log server-side and get only matching lines back — far cheaper than pulling everything. Narrow further with "stepKey" or "stream".

"id" accepts an attempt id, a job id, or a run id. Given a run id this picks that run's failed job (or its last job) and reads the latest attempt, mirroring what "depot ci logs" does.

Paging: without a pageToken you get the tail. With a pageToken you get the next window forward from that point plus a new nextPageToken — that is how you follow a running job's output across turns. Depot persists lines oldest-first and only ever appends, so a token stays valid.

Output is capped by line count and by an overall character budget; the result says when either cap dropped anything.`,
  inputSchema: {
    id: z
      .string()
      .min(1)
      .describe('An attempt id, job id, or run id. Attempt ids give the most precise result.'),
    targetType: z
      .enum(CI_TARGET_TYPES)
      .optional()
      .describe('What "id" refers to. Omit to let the server work it out.'),
    tailLines: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(200)
      .describe('Maximum log lines to return, taken from the end unless a pageToken is given.'),
    grep: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter applied to line bodies before truncation. Not a regular expression.',
      ),
    stepKey: z
      .string()
      .optional()
      .describe('Keep only lines from this step, as reported in a line\'s stepKey.'),
    stream: z
      .enum(['stdout', 'stderr'])
      .optional()
      .describe('Keep only one output stream. stderr alone is often enough to spot a failure.'),
    includeTimestamps: z
      .boolean()
      .default(false)
      .describe('Prefix each rendered line with its ISO timestamp. Costs context; usually not needed.'),
    pageToken: z
      .string()
      .optional()
      .describe(
        'Continue forward from a previous nextPageToken instead of returning the tail. Use this to poll a running job.',
      ),
  },
  outputSchema: {
    target: z.object({
      describedAs: z.string(),
      attemptId: z.string().optional(),
      jobId: z.string().optional(),
    }),
    lines: z.array(logLineSchema),
    linesReturned: z.number(),
    linesMatched: z.number(),
    pagesFetched: z.number(),
    truncated: z.boolean(),
    nextPageToken: z.string().optional(),
    notes: z.array(z.string()),
  },
  handler: async (input, context) => {
    const needle = input.grep?.toLowerCase();

    const match = (line: LogLine): boolean => {
      if (input.stepKey !== undefined && line.stepKey !== input.stepKey) {
        return false;
      }
      if (input.stream !== undefined && line.stream !== input.stream) {
        return false;
      }
      return needle === undefined || line.body.toLowerCase().includes(needle);
    };

    const collected = await collectLines(context, input.id, input.targetType, {
      tailLines: input.tailLines,
      startToken: input.pageToken,
      keepTail: input.pageToken === undefined,
      match,
    });

    const budgeted = keepTailWithinBudget(
      collected.lines,
      context.config.outputCharBudget - 600,
      (line) => line.body.length + 24,
    );

    const notes: string[] = [];
    if (collected.matched > budgeted.kept.length) {
      notes.push(
        `${collected.matched - budgeted.kept.length} matching line(s) were dropped to respect tailLines and the character budget.`,
      );
    }
    if (budgeted.dropped > 0) {
      notes.push(
        `${budgeted.dropped} line(s) were dropped from the start of this window to fit the character budget.`,
      );
    }
    if (collected.pageCapHit) {
      notes.push(
        `Stopped after ${collected.pagesFetched} pages (DEPOT_MCP_MAX_LOG_PAGES). Earlier log lines were not read; narrow with grep or stepKey to search the whole log cheaply.`,
      );
    }
    if (needle !== undefined && collected.matched === 0) {
      notes.push(`No line in the pages read contained "${input.grep ?? ''}".`);
    }

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(
      `${budgeted.kept.length} log line(s) from ${collected.describedAs}${
        input.grep === undefined ? '' : ` matching "${input.grep}"`
      }.`,
      '',
    );
    for (const line of budgeted.kept) {
      const prefix = [
        input.includeTimestamps ? line.timestamp : undefined,
        line.stepKey === undefined ? undefined : `[${line.stepKey}]`,
        line.stream === 'stderr' ? '(stderr)' : undefined,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' ');
      text.push(prefix === '' ? line.body : `${prefix} ${line.body}`);
    }
    if (notes.length > 0) {
      text.push('', ...notes.map((note) => `note: ${note}`));
    }
    if (collected.nextPageToken !== undefined) {
      text.push('', `Continue with pageToken="${collected.nextPageToken}".`);
    }

    return {
      summary: text.render(),
      data: {
        target: {
          describedAs: collected.describedAs,
          attemptId: collected.request.attemptId,
          jobId: collected.request.jobId,
        },
        lines: budgeted.kept,
        linesReturned: budgeted.kept.length,
        linesMatched: collected.matched,
        pagesFetched: collected.pagesFetched,
        truncated: collected.matched > budgeted.kept.length || collected.pageCapHit,
        nextPageToken: collected.nextPageToken,
        notes,
      },
    };
  },
});
