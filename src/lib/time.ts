export function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function durationSecondsBetween(
  start: string | undefined,
  end: string | undefined,
): number | undefined {
  const from = parseTimestamp(start);
  const to = parseTimestamp(end);
  if (from === undefined || to === undefined || to < from) {
    return undefined;
  }
  return Math.round((to - from) / 1000);
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined) {
    return 'unknown duration';
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) {
    return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** Depot's usage RPCs take google.protobuf.Timestamp values, which JSON-encode as RFC 3339. */
export function toRfc3339(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`"${value}" is not a date this server can parse; use RFC 3339 or YYYY-MM-DD.`);
  }
  return new Date(parsed).toISOString();
}

export function daysAgoRfc3339(days: number, now: number = Date.now()): string {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}
