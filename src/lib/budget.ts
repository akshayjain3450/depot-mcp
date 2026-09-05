export interface TruncatedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

const ELLIPSIS = '…';

/**
 * Longest single log line body any tool returns, in prose or structuredContent. Window budgets
 * keep at least one entry, so without this a single enormous line would be that entry.
 */
export const MAX_LOG_LINE_CHARS = 2_000;

export function truncateText(value: string, limit: number): TruncatedText {
  if (value.length <= limit) {
    return { text: value, truncated: false, originalLength: value.length };
  }
  const keep = Math.max(0, limit - ELLIPSIS.length);
  return {
    text: `${value.slice(0, keep)}${ELLIPSIS}`,
    truncated: true,
    originalLength: value.length,
  };
}

export interface WindowResult<T> {
  readonly kept: T[];
  readonly dropped: number;
}

/** Keep as many trailing entries as fit in `charBudget`; log tails are where failures live. */
export function keepTailWithinBudget<T>(
  entries: readonly T[],
  charBudget: number,
  sizeOf: (entry: T) => number,
): WindowResult<T> {
  const kept: T[] = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) {
      continue;
    }
    const size = sizeOf(entry);
    if (used + size > charBudget && kept.length > 0) {
      break;
    }
    kept.unshift(entry);
    used += size;
  }
  return { kept, dropped: entries.length - kept.length };
}

/** Keep as many leading entries as fit in `charBudget`; used when paging forward. */
export function keepHeadWithinBudget<T>(
  entries: readonly T[],
  charBudget: number,
  sizeOf: (entry: T) => number,
): WindowResult<T> {
  const kept: T[] = [];
  let used = 0;
  for (const entry of entries) {
    const size = sizeOf(entry);
    if (used + size > charBudget && kept.length > 0) {
      break;
    }
    kept.push(entry);
    used += size;
  }
  return { kept, dropped: entries.length - kept.length };
}

/** Below this many characters a truncated fragment is noise, so the line is dropped instead. */
const MIN_USEFUL_FRAGMENT_CHARS = 16;

/**
 * Accumulates the human-readable summary text for a tool result and stops accepting lines once
 * the character budget is spent, so no tool can return unbounded prose to the model.
 *
 * Overflow is terminal: the line that overflows is cut down to whatever room remains (or dropped
 * when that room is too small to be useful) and every later push is refused, so the rendered
 * text is always a prefix of what was pushed rather than a prefix with holes in it.
 */
export class TextBudget {
  private readonly lines: string[] = [];
  private used = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  push(...lines: string[]): this {
    for (const line of lines) {
      if (this.overflowed) {
        return this;
      }
      const room = this.limit - this.used - 1;
      if (line.length <= room) {
        this.lines.push(line);
        this.used += line.length + 1;
        continue;
      }
      this.overflowed = true;
      if (room >= MIN_USEFUL_FRAGMENT_CHARS) {
        const fragment = truncateText(line, room).text;
        this.lines.push(fragment);
        this.used += fragment.length + 1;
      }
      return this;
    }
    return this;
  }

  get didOverflow(): boolean {
    return this.overflowed;
  }

  render(): string {
    const body = this.lines.join('\n');
    return this.overflowed
      ? `${body}\n[output truncated to stay within this server's ${this.limit}-character budget]`
      : body;
  }
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
