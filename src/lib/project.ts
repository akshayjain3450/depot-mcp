import {
  asObject,
  mapEnumNumber,
  readNumber,
  readObject,
  readString,
  type JsonObject,
} from '../depot/shape.js';

/** From depot/proto: HARDWARE_UNSPECIFIED defaults to 16x32, and the numbering is not sequential. */
const HARDWARE_BY_NUMBER: Readonly<Record<number, string>> = {
  0: 'unspecified (defaults to 16x32)',
  1: '16x32',
  2: '4x4',
  3: '8x8',
  4: '8x16',
  5: '32x64',
  6: '64x128',
  7: '96x192',
  8: '192x384',
  9: '4x8',
  10: '384x768',
};

export interface ProjectSummary {
  projectId: string | undefined;
  name: string | undefined;
  organizationId: string | undefined;
  regionId: string | undefined;
  hardware: string | undefined;
  createdAt: string | undefined;
  cachePolicy: {
    keepDays: number | undefined;
    keepGb: number | undefined;
  };
}

export function parseProject(source: JsonObject): ProjectSummary {
  const inner = readObject(source, 'project') ?? source;
  const cachePolicy = readObject(inner, 'cachePolicy');
  return {
    projectId: readString(inner, 'projectId', 'id'),
    name: readString(inner, 'name'),
    organizationId: readString(inner, 'organizationId', 'orgId'),
    regionId: readString(inner, 'regionId', 'region'),
    hardware: mapEnumNumber(inner, ['hardware'], HARDWARE_BY_NUMBER, ['hardware']),
    createdAt: readString(inner, 'createdAt'),
    cachePolicy: {
      keepDays: readNumber(cachePolicy, 'keepDays'),
      keepGb: readNumber(cachePolicy, 'keepGb'),
    },
  };
}

export interface TrustPolicySummary {
  trustPolicyId: string | undefined;
  /** The oneof key Depot populated: github, buildkite, circleci, gitlab, or something newer. */
  provider: string | undefined;
  /** Every scalar field of the provider object, as strings, so an unknown provider still shows. */
  detail: Record<string, string>;
}

export function parseTrustPolicy(source: JsonObject): TrustPolicySummary {
  const detail: Record<string, string> = {};
  let provider: string | undefined;
  for (const [key, value] of Object.entries(source)) {
    const nested = asObject(value);
    if (nested === undefined) {
      continue;
    }
    // The proto models the provider as a oneof, so exactly one nested object identifies it.
    provider = key;
    for (const [field, fieldValue] of Object.entries(nested)) {
      if (typeof fieldValue === 'string' || typeof fieldValue === 'number') {
        detail[field] = String(fieldValue);
      }
    }
  }
  return {
    trustPolicyId: readString(source, 'trustPolicyId', 'id'),
    provider,
    detail,
  };
}

/**
 * One line naming the external identity a policy admits, in the provider's own terms (from
 * depot/proto TrustPolicy): GitHub owner/repository, Buildkite organization/pipeline, CircleCI
 * organization and project UUIDs, GitLab namespace and project ids. `readString` tolerates
 * snake_case, so a policy recorded from the CLI reads the same.
 */
export function describeTrustIdentity(policy: TrustPolicySummary): string {
  const field = (...keys: string[]): string | undefined => readString(policy.detail, ...keys);
  switch (policy.provider) {
    case 'github':
      return `github ${field('repositoryOwner', 'org', 'owner') ?? '?'}/${field('repository', 'repo') ?? '?'}`;
    case 'buildkite':
      return `buildkite ${field('organizationSlug') ?? '?'}/${field('pipelineSlug') ?? '?'}`;
    case 'circleci':
      return `circleci organization ${field('organizationUuid') ?? '?'} project ${field('projectUuid') ?? '?'}`;
    case 'gitlab':
      return `gitlab namespace ${field('namespaceId') ?? '?'} project ${field('projectId') ?? '?'}`;
    default: {
      const pairs = Object.entries(policy.detail).map(([key, value]) => `${key}=${value}`);
      return `${policy.provider ?? 'unknown provider'}${pairs.length === 0 ? '' : ` ${pairs.join(', ')}`}`;
    }
  }
}
