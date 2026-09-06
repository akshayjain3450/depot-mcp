import type { DiagnosisTargetType } from '../depot/api.js';

export const CI_TARGET_TYPES = ['run', 'workflow', 'job', 'attempt'] as const;

export type CiTargetType = (typeof CI_TARGET_TYPES)[number];

const TARGET_PREFIXES: ReadonlyArray<readonly [RegExp, CiTargetType]> = [
  // Depot's real ids are bare 10-character strings (jlj6ll9tdm); push-triggered runs carry a
  // `ps_` prefix (ps_st95t8cmg1, observed live 2026-09-06). The named prefixes are kept for
  // callers that hand over CLI-style or documentation-style ids.
  [/^(?:run|ps)[_-]/i, 'run'],
  [/^(?:wf|workflow)[_-]/i, 'workflow'],
  [/^job[_-]/i, 'job'],
  [/^(?:att|attempt)[_-]/i, 'attempt'],
];

export function toDiagnosisTargetType(target: CiTargetType): DiagnosisTargetType {
  switch (target) {
    case 'run':
      return 'RUN';
    case 'workflow':
      return 'WORKFLOW';
    case 'job':
      return 'JOB';
    case 'attempt':
      return 'ATTEMPT';
  }
}

/**
 * No production code path calls this yet; it is kept because the unit suite pins the wire
 * spellings it accepts, and any parser that reads a Depot targetType enum should route through it.
 */
export function normalizeTargetType(value: string | undefined): CiTargetType | undefined {
  if (value === undefined) {
    return undefined;
  }
  const bare = value.toLowerCase().replace(/^target_type_/, '');
  return (CI_TARGET_TYPES as readonly string[]).includes(bare) ? (bare as CiTargetType) : undefined;
}

export function inferTargetType(id: string): CiTargetType | undefined {
  for (const [pattern, target] of TARGET_PREFIXES) {
    if (pattern.test(id)) {
      return target;
    }
  }
  return undefined;
}

/**
 * Depot does not publish its identifier formats, and agents paste whichever ID a human gave them.
 * Produce an ordered list of target types to try: an explicit choice wins, then a prefix hint,
 * then run-first because that is the ID a person is most likely to have.
 */
export function candidateTargetTypes(
  id: string,
  explicit: CiTargetType | undefined,
): CiTargetType[] {
  if (explicit !== undefined) {
    return [explicit];
  }
  const inferred = inferTargetType(id);
  if (inferred !== undefined) {
    return [inferred];
  }
  return [...CI_TARGET_TYPES];
}
