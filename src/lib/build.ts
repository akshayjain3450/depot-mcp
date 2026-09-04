import {
  mapEnumNumber,
  readBoolean,
  readNumber,
  readObject,
  readString,
  type JsonObject,
} from '../depot/shape.js';
import { durationSecondsBetween } from './time.js';

/** depot.core.v1.Build.Status numbering, from depot/proto. */
const BUILD_STATUS_BY_NUMBER: Readonly<Record<number, string>> = {
  0: 'unspecified',
  1: 'running',
  2: 'failed',
  3: 'success',
  4: 'error',
  5: 'canceled',
};

/** depot.build.v1.BuildStep.CacheState numbering, from depot/proto. */
const CACHE_STATE_BY_NUMBER: Readonly<Record<number, string>> = {
  0: 'unspecified',
  1: 'uncached',
  2: 'cached',
};

const BUILD_FAILURE_STATES = new Set(['failed', 'error', 'canceled', 'cancelled']);

export function isBuildFailure(status: string | undefined): boolean {
  return status !== undefined && BUILD_FAILURE_STATES.has(status);
}

export interface BuildSummary {
  buildId: string | undefined;
  status: string | undefined;
  createdAt: string | undefined;
  startedAt: string | undefined;
  finishedAt: string | undefined;
  buildDurationSeconds: number | undefined;
  savedDurationSeconds: number | undefined;
  cachedSteps: number | undefined;
  totalSteps: number | undefined;
  cacheHitRatio: number | undefined;
}

export function parseBuild(source: JsonObject): BuildSummary {
  const inner = readObject(source, 'build') ?? source;
  const cachedSteps = readNumber(inner, 'cachedSteps');
  const totalSteps = readNumber(inner, 'totalSteps');
  const startedAt = readString(inner, 'startedAt');
  const finishedAt = readString(inner, 'finishedAt');
  return {
    buildId: readString(inner, 'buildId', 'id'),
    status: mapEnumNumber(inner, ['status'], BUILD_STATUS_BY_NUMBER, ['status']),
    createdAt: readString(inner, 'createdAt'),
    startedAt,
    finishedAt,
    buildDurationSeconds:
      readNumber(inner, 'buildDurationSeconds') ?? durationSecondsBetween(startedAt, finishedAt),
    savedDurationSeconds: readNumber(inner, 'savedDurationSeconds'),
    cachedSteps,
    totalSteps,
    cacheHitRatio:
      cachedSteps !== undefined && totalSteps !== undefined && totalSteps > 0
        ? Math.round((cachedSteps / totalSteps) * 100) / 100
        : undefined,
  };
}

export interface BuildStep {
  name: string | undefined;
  digest: string | undefined;
  startedAt: string | undefined;
  completedAt: string | undefined;
  cacheState: string | undefined;
  error: string | undefined;
  hasLogs: boolean;
  durationSeconds: number | undefined;
}

export function parseBuildStep(source: JsonObject): BuildStep {
  const startedAt = readString(source, 'startedAt');
  const completedAt = readString(source, 'completedAt');
  return {
    name: readString(source, 'name'),
    digest: readString(source, 'digest'),
    startedAt,
    completedAt,
    cacheState: mapEnumNumber(source, ['cacheState'], CACHE_STATE_BY_NUMBER, ['cache_state']),
    error: readString(source, 'error'),
    hasLogs: readBoolean(source, 'hasLogs') ?? false,
    durationSeconds: durationSecondsBetween(startedAt, completedAt),
  };
}

/**
 * Container builds have no server-side diagnosis, so pick the step to investigate the way a human
 * would: the one that reported an error, else the last step that actually executed and has logs.
 */
export function selectFailingStep(steps: readonly BuildStep[]): BuildStep | undefined {
  const errored = steps.find((step) => step.error !== undefined);
  if (errored !== undefined) {
    return errored;
  }
  const executed = steps.filter((step) => step.cacheState === 'uncached' && step.hasLogs);
  return executed.at(-1) ?? steps.filter((step) => step.hasLogs).at(-1);
}
