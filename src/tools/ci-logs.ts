import { z } from 'zod';
import { DEFAULT_MAX_LOG_PAGES } from '../config.js';
import {
  readEnum,
  readNumber,
  readObjectArray,
  readString,
  type JsonObject,
} from '../depot/shape.js';
import { keepTailWithinBudget, MAX_LOG_LINE_CHARS, TextBudget, truncateText } from '../lib/budget.js';
import { resolveAttemptTarget, type AttemptOrJob, type TargetCandidate } from '../lib/ci-target.js';
import { CI_TARGET_TYPES } from '../lib/resolve.js';
import { defineTool, ToolInputError, type ToolContext } from '../lib/tool.js';

/** Headroom under the character budget for the header, notes and continuation line. */
const LINE_BUDGET_HEADROOM = 600;

/** Per-line overhead charged against the budget on top of the body: prefix, separators, JSON keys. */
const LINE_OVERHEAD_CHARS = 24;

interface LogLine {
  readonly stepKey: string | undefined;
  readonly stepName: string | undefined;
  readonly stream: string | undefined;
  readonly lineNumber: number | undefined;
  readonly timestamp: string | undefined;
  readonly body: string;
  readonly bodyTruncated?: true;
}

// CSI and OSC escape sequences (colours, cursor moves, hyperlinks). Linear: one bounded run each.
const ANSI_ESCAPES = /\u001b\[[0-9;?]{0,32}[ -/]*[@-~]|\u001b\][^\u0007\u001b]{0,512}(?:\u0007|\u001b\\)/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPES, '');
}

function parseLine(source: JsonObject): LogLine {
  const timestampMs = readNumber(source, 'timestampMs');
  const body = truncateText(
    stripAnsi(readString(source, 'body', 'content', 'message') ?? ''),
    MAX_LOG_LINE_CHARS,
  );
  return {
    stepKey: readString(source, 'stepKey', 'stepId'),
    stepName: readString(source, 'stepName'),
    stream: readEnum(source, ['stream'], ['stream', 'log_stream']),
    lineNumber: readNumber(source, 'lineNumber'),
    timestamp: timestampMs === undefined ? undefined : new Date(timestampMs).toISOString(),
    body: body.text,
    ...(body.truncated ? { bodyTruncated: true as const } : {}),
  };
}

function sizeOf(line: LogLine): number {
  return line.body.length + LINE_OVERHEAD_CHARS;
}

/**
 * Where a forward window starts: a Depot page plus how many raw lines of it were already returned.
 * Depot pages are whatever size Depot chooses, so a window that ends mid-page needs both parts to
 * resume without skipping or repeating anything.
 */
interface Cursor {
  readonly pageToken: string | undefined;
  readonly skip: number;
}

const CURSOR_PREFIX = 'depot-mcp:';

function decodeCursor(token: string | undefined): Cursor {
  if (token === undefined || !token.startsWith(CURSOR_PREFIX)) {
    return { pageToken: token, skip: 0 };
  }
  const rest = token.slice(CURSOR_PREFIX.length);
  const separator = rest.indexOf(':');
  const skip = Number(rest.slice(0, separator));
  if (separator < 0 || !Number.isInteger(skip) || skip < 0) {
    throw new ToolInputError(
      `pageToken ${JSON.stringify(token)} is not a token this server issued. Pass back a nextPageToken exactly as it was returned.`,
    );
  }
  const pageToken = rest.slice(separator + 1);
  return { pageToken: pageToken === '' ? undefined : pageToken, skip };
}

/** A plain Depot token when the window ended on a page boundary, so tokens stay interchangeable. */
function encodeCursor(cursor: Cursor): string | undefined {
  return cursor.skip === 0 ? cursor.pageToken : `${CURSOR_PREFIX}${cursor.skip}:${cursor.pageToken ?? ''}`;
}

interface LogSource {
  readonly first: JsonObject;
  readonly target: TargetCandidate;
  next(pageToken: string): Promise<JsonObject>;
}

async function openLog(
  context: ToolContext,
  id: string,
  explicit: (typeof CI_TARGET_TYPES)[number] | undefined,
  pageToken: string | undefined,
): Promise<LogSource> {
  const resolved = await resolveAttemptTarget(context, id, explicit, (request) =>
    context.api.getJobAttemptLogs({ ...request, pageToken }),
  );
  const request: AttemptOrJob = resolved.target.request;
  return {
    first: resolved.result,
    target: resolved.target,
    next: (token) => context.api.getJobAttemptLogs({ ...request, pageToken: token }),
  };
}

interface CollectResult {
  readonly lines: LogLine[];
  readonly pagesFetched: number;
  readonly pageCapHit: boolean;
  readonly nextPageToken: string | undefined;
  /** Lines that passed the filters in the pages read; in forward mode, only up to the window end. */
  readonly matched: number;
  /** Forward mode only: the window closed before tailLines because of the character budget. */
  readonly stoppedByBudget: boolean;
}

function nextTokenOf(response: JsonObject, currentToken: string | undefined): string | undefined {
  const next = readString(response, 'nextPageToken');
  return next === undefined || next === currentToken ? undefined : next;
}

/**
 * `GetJobAttemptLogs` pages oldest-first with no tail parameter, so a tail means reading forward
 * and keeping only the last `tailLines` in a ring buffer, bounded by DEPOT_MCP_MAX_LOG_PAGES.
 * When the cap stops the walk, the buffer holds the end of the last page read, not the end of the
 * log, and the result says so.
 */
async function collectTail(
  context: ToolContext,
  source: LogSource,
  options: { readonly tailLines: number; readonly match: (line: LogLine) => boolean },
): Promise<CollectResult> {
  const buffer: LogLine[] = [];
  let matched = 0;
  let pagesFetched = 0;
  let pageToken: string | undefined;
  let response = source.first;

  for (;;) {
    pagesFetched += 1;
    const page = readObjectArray(response, 'lines').map(parseLine).filter(options.match);
    matched += page.length;
    for (const line of page) {
      buffer.push(line);
      if (buffer.length > options.tailLines) {
        buffer.shift();
      }
    }

    const base = { lines: buffer, pagesFetched, matched, stoppedByBudget: false };
    const next = nextTokenOf(response, pageToken);
    if (next === undefined) {
      return { ...base, pageCapHit: false, nextPageToken: undefined };
    }
    if (pagesFetched >= context.config.maxLogPages) {
      return { ...base, pageCapHit: true, nextPageToken: next };
    }
    pageToken = next;
    response = await source.next(next);
  }
}

/**
 * Forward mode returns lines in order from the cursor and stops at whichever comes first: tailLines,
 * the character budget, the page cap, or the end of the log. It never drops a line: the window
 * closes just before the first line that does not fit and the cursor points at that line.
 */
async function collectForward(
  context: ToolContext,
  source: LogSource,
  options: {
    readonly cursor: Cursor;
    readonly tailLines: number;
    readonly charBudget: number;
    readonly match: (line: LogLine) => boolean;
  },
): Promise<CollectResult> {
  const kept: LogLine[] = [];
  let used = 0;
  let pagesFetched = 0;
  let pageToken = options.cursor.pageToken;
  let skip = options.cursor.skip;
  let response = source.first;

  for (;;) {
    pagesFetched += 1;
    const raw = readObjectArray(response, 'lines');
    for (const [offset, entry] of raw.slice(skip).entries()) {
      const line = parseLine(entry);
      if (!options.match(line)) {
        continue;
      }
      const overCount = kept.length >= options.tailLines;
      const overBudget = kept.length > 0 && used + sizeOf(line) > options.charBudget;
      if (overCount || overBudget) {
        return {
          lines: kept,
          pagesFetched,
          pageCapHit: false,
          nextPageToken: encodeCursor({ pageToken, skip: skip + offset }),
          matched: kept.length,
          stoppedByBudget: overBudget && !overCount,
        };
      }
      kept.push(line);
      used += sizeOf(line);
    }
    skip = 0;

    const base = { lines: kept, pagesFetched, matched: kept.length, stoppedByBudget: false };
    const next = nextTokenOf(response, pageToken);
    if (next === undefined) {
      return { ...base, pageCapHit: false, nextPageToken: undefined };
    }
    if (kept.length >= options.tailLines) {
      return { ...base, pageCapHit: false, nextPageToken: next };
    }
    if (pagesFetched >= context.config.maxLogPages) {
      return { ...base, pageCapHit: true, nextPageToken: next };
    }
    pageToken = next;
    response = await source.next(next);
  }
}

const logLineSchema = z.object({
  stepKey: z.string().optional(),
  stepName: z.string().optional(),
  stream: z.string().optional(),
  lineNumber: z.number().optional(),
  timestamp: z.string().optional(),
  body: z.string(),
  bodyTruncated: z.boolean().optional(),
});

export const getCiLogsTool = defineTool({
  name: 'depot_get_ci_logs',
  title: 'Get Depot CI job logs',
  description: `Fetch a bounded slice of the persisted logs for a Depot CI job attempt.

Try depot_diagnose_ci_failure first. It is cheaper, it already contains the relevant log lines with a diagnosis attached, and it identifies which job actually broke. Use this tool when you need detail the diagnosis did not include: the full traceback, output from a step that did not fail, or a specific pattern.

Defaults to the last 200 matching lines, because failures land at the end of a log. "grep" (case-insensitive substring, not a regex), "stepKey" and "stream" are applied by this server after it fetches pages from Depot, so they reduce what you receive but not what is read: a grep still walks the log page by page, up to DEPOT_MCP_MAX_LOG_PAGES pages (default ${DEFAULT_MAX_LOG_PAGES}), and is the most expensive way to use this tool. Prefer stepKey or stream, which at least keep the returned window small.

"id" accepts an attempt id, a job id, or a run id. Given a run id this picks that run's failed job (or its last job) and reads the latest attempt, mirroring what "depot ci logs" does.

Paging contract:
- Without a pageToken you get the tail: the last "tailLines" matching lines of what was read. If the page cap stops the walk first, the result says so, the lines are the end of what was read rather than the end of the log, and nextPageToken continues forward from there.
- With a pageToken you get the next window forward: up to "tailLines" lines in order from that point, and a new nextPageToken if more remain. Nothing in a forward window is ever dropped for the character budget; the window just closes early and the token resumes at the exact next line, so following nextPageToken until it is absent yields every line exactly once. That is how to follow a running job's output across turns.
- Pass tokens back verbatim. Some are issued by this server rather than Depot; both are opaque.
- Each line body is capped at ${MAX_LOG_LINE_CHARS} characters ("bodyTruncated" marks the ones that were cut).`,
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
      .describe(
        'Maximum log lines per call: the last N of what was read without a pageToken, the next N forward with one.',
      ),
    grep: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter applied to line bodies by this server after fetching. Not a regular expression.',
      ),
    stepKey: z
      .string()
      .optional()
      .describe("Keep only lines from this step, as reported in a line's stepKey."),
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
        'Continue forward from a previous nextPageToken instead of returning the tail. Use this to poll a running job or to read a log from the start.',
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
    pageCapHit: z.boolean(),
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

    const forward = input.pageToken !== undefined;
    const cursor = decodeCursor(input.pageToken === '' ? undefined : input.pageToken);
    const charBudget = context.config.outputCharBudget - LINE_BUDGET_HEADROOM;
    const source = await openLog(context, input.id, input.targetType, cursor.pageToken);

    const collected = forward
      ? await collectForward(context, source, { cursor, tailLines: input.tailLines, charBudget, match })
      : await collectTail(context, source, { tailLines: input.tailLines, match });

    const budgeted = forward
      ? { kept: collected.lines, dropped: 0 }
      : keepTailWithinBudget(collected.lines, charBudget, sizeOf);
    const kept = budgeted.kept;
    const bodiesTruncated = kept.filter((line) => line.bodyTruncated === true).length;

    const notes: string[] = [];
    if (collected.matched > kept.length) {
      notes.push(
        `${collected.matched - kept.length} matching line(s) were dropped to respect tailLines and the character budget.`,
      );
    }
    if (budgeted.dropped > 0) {
      notes.push(
        `${budgeted.dropped} line(s) were dropped from the start of this window to fit the character budget.`,
      );
    }
    if (collected.stoppedByBudget) {
      notes.push(
        'This window closed before tailLines to fit the character budget. Nothing was dropped: nextPageToken resumes at the very next line.',
      );
    }
    if (bodiesTruncated > 0) {
      notes.push(
        `${bodiesTruncated} line(s) longer than ${MAX_LOG_LINE_CHARS} characters had their body truncated (bodyTruncated: true).`,
      );
    }
    if (collected.pageCapHit && collected.nextPageToken !== undefined) {
      notes.push(
        forward
          ? `Stopped after ${collected.pagesFetched} page(s) (DEPOT_MCP_MAX_LOG_PAGES). Continue with pageToken="${collected.nextPageToken}".`
          : `Stopped after ${collected.pagesFetched} page(s) (DEPOT_MCP_MAX_LOG_PAGES). These are the last lines of what was read, not the end of the log. Continue forward with pageToken="${collected.nextPageToken}", or raise DEPOT_MCP_MAX_LOG_PAGES.`,
      );
    }
    if (needle !== undefined && collected.matched === 0) {
      notes.push(`No line in the pages read contained "${input.grep ?? ''}".`);
    }

    const grepLabel = input.grep === undefined ? '' : ` matching "${input.grep}"`;
    const header = forward
      ? `${kept.length} log line(s) from ${source.target.describedAs}${grepLabel}, continuing from the given pageToken.`
      : collected.pageCapHit
        ? `${kept.length} log line(s) from ${source.target.describedAs}${grepLabel}, from the first ${collected.pagesFetched} page(s) only. The log continues past what was read.`
        : `Last ${kept.length} log line(s) from ${source.target.describedAs}${grepLabel}.`;

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(header, '');
    for (const line of kept) {
      const prefix = [
        input.includeTimestamps ? line.timestamp : undefined,
        line.stepName !== undefined
          ? `[${line.stepName}]`
          : line.stepKey === undefined
            ? undefined
            : `[${line.stepKey}]`,
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
          describedAs: source.target.describedAs,
          attemptId: source.target.request.attemptId,
          jobId: source.target.request.jobId,
        },
        lines: kept,
        linesReturned: kept.length,
        linesMatched: collected.matched,
        pagesFetched: collected.pagesFetched,
        pageCapHit: collected.pageCapHit,
        truncated: collected.matched > kept.length || collected.pageCapHit || bodiesTruncated > 0,
        nextPageToken: collected.nextPageToken,
        notes,
      },
    };
  },
});
