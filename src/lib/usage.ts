import { readNumber, readObject, readString, type JsonObject } from '../depot/shape.js';
import { daysAgoRfc3339, toRfc3339, toRfc3339WindowEnd } from './time.js';
import { ToolInputError } from './tool.js';

/** depot.core.v1.ProjectUsage, as returned by both ListProjectUsage rows and GetProjectUsage. */
export interface ProjectUsage {
  projectId: string | undefined;
  buildCount: number | undefined;
  buildDurationSeconds: number | undefined;
  layerCacheSizeGb: number | undefined;
}

/**
 * GetProjectUsage nests the record under `usage` (per depot/proto, and observed live 2026-09-06);
 * ListProjectUsage rows are the bare record. Accept both.
 */
export function parseProjectUsage(source: JsonObject): ProjectUsage {
  const inner = readObject(source, 'usage') ?? source;
  return {
    projectId: readString(inner, 'projectId'),
    buildCount: readNumber(inner, 'buildCount'),
    buildDurationSeconds: readNumber(inner, 'buildDurationSeconds'),
    layerCacheSizeGb: readNumber(inner, 'layerCacheSizeGb'),
  };
}

export interface UsageWindowInput {
  readonly days: number;
  readonly startAt?: string | undefined;
  readonly endAt?: string | undefined;
}

function parseWindowBoundary(
  field: 'startAt' | 'endAt',
  value: string,
  convert: (value: string) => string,
): string {
  try {
    return convert(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolInputError(`${field}: ${reason}`);
  }
}

/**
 * The window every usage tool accepts: an explicit startAt/endAt pair (a date-only endAt covers
 * that whole day) or a "days" look-back from now. Giving only one boundary is refused rather
 * than guessed at.
 */
export function resolveUsageWindow(
  input: UsageWindowInput,
  now: number = Date.now(),
): { startAt: string; endAt: string } {
  if ((input.startAt === undefined) !== (input.endAt === undefined)) {
    throw new ToolInputError(
      'Pass both startAt and endAt, or neither (in which case "days" sets the window).',
    );
  }
  return {
    startAt:
      input.startAt === undefined
        ? daysAgoRfc3339(input.days, now)
        : parseWindowBoundary('startAt', input.startAt, toRfc3339),
    endAt:
      input.endAt === undefined
        ? new Date(now).toISOString()
        : parseWindowBoundary('endAt', input.endAt, toRfc3339WindowEnd),
  };
}
