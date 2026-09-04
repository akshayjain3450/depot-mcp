import { mapEnumNumber, readNumber, readObject, readString, type JsonObject } from '../depot/shape.js';

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
