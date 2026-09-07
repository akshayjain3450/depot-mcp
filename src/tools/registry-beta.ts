import { z } from 'zod';
import { formatDepotError } from '../depot/errors.js';
import {
  asObject,
  readBoolean,
  readNumber,
  readObject,
  readObjectArray,
  readString,
  readStringArray,
  type JsonObject,
} from '../depot/shape.js';
import { formatCount, TextBudget } from '../lib/budget.js';
import { defineTool, ToolInputError } from '../lib/tool.js';

const BETA_NOTICE =
  'Beta: this tool is registered only when DEPOT_MCP_ENABLE_BETA is set, because depot.registry.v1beta1 is beta in its name and published only as a proto; Depot may change it without notice. Field names follow the proto as of 2026-09-06.';

const BETA_FOOTER =
  'Beta API (depot.registry.v1beta1): field names and paging may change without notice.';

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return 'unknown size';
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const retentionPolicySchema = z.object({
  enabled: z.boolean().optional(),
  keepCount: z.number().optional(),
  keepDays: z.number().optional(),
  updatedAt: z.string().optional(),
});

export type RetentionPolicySummary = z.infer<typeof retentionPolicySchema>;

/** `GetRetentionPolicyResponse.policy` is optional: an empty object means no policy exists. */
export function parseRetentionPolicy(source: JsonObject): RetentionPolicySummary | undefined {
  const policy = readObject(source, 'policy');
  if (policy === undefined) {
    return undefined;
  }
  return {
    enabled: readBoolean(policy, 'enabled'),
    keepCount: readNumber(policy, 'keepCount'),
    keepDays: readNumber(policy, 'keepDays'),
    updatedAt: readString(policy, 'updatedAt'),
  };
}

function describeRetention(policy: RetentionPolicySummary | undefined): string {
  if (policy === undefined) {
    return 'no retention policy';
  }
  if (policy.enabled === false) {
    return 'retention policy disabled';
  }
  const rules = [
    policy.keepCount === undefined ? undefined : `keep ${policy.keepCount} newest`,
    policy.keepDays === undefined ? undefined : `keep ${policy.keepDays} days`,
  ].filter((part): part is string => part !== undefined);
  return rules.length === 0 ? 'retention policy enabled (no limits set)' : `retention: ${rules.join(', ')}`;
}

const repositorySchema = z.object({
  name: z.string().optional(),
  scope: z.string().optional(),
  tagCount: z.number().optional(),
  sizeBytes: z.number().optional(),
  createdAt: z.string().optional(),
  lastPushedAt: z.string().optional(),
  retentionPolicy: retentionPolicySchema.optional(),
  /** Set when GetRetentionPolicy failed for this repository; the listing itself still succeeded. */
  retentionPolicyError: z.string().optional(),
});

type RepositorySummary = z.infer<typeof repositorySchema>;

function parseRepository(entry: JsonObject): RepositorySummary {
  return {
    name: readString(entry, 'name'),
    scope: readString(entry, 'scope'),
    tagCount: readNumber(entry, 'tagCount'),
    sizeBytes: readNumber(entry, 'sizeBytes'),
    createdAt: readString(entry, 'createdAt'),
    lastPushedAt: readString(entry, 'lastPushedAt'),
  };
}

export const listRegistryRepositoriesTool = defineTool({
  name: 'depot_list_registry_repositories',
  title: 'List Depot registry repositories (beta API)',
  description: `List the repositories in the organization's Depot registry, with tag count, total size, last push time, and each repository's retention policy.

Use this to see what the organization publishes to the Depot registry, to find a repository name for depot_get_registry_image, or to audit which repositories have a retention policy (and so will have old images pruned) and which do not. depot_list_images lists the images inside one project's registry; this lists the repositories across the organization.

The registry pages by number: pass page=2 when hasMore is true. Retention policies are fetched with one extra call per repository on the page; set withRetentionPolicy=false to skip that.

${BETA_NOTICE}

Read-only: repository, tag, image, and retention-policy deletion are deliberately not exposed by this server, and registry tokens are never listed or created.`,
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe('Filter repositories by name substring, applied by Depot.'),
    page: z.number().int().min(1).default(1).describe('1-based page number.'),
    limit: z.number().int().min(1).max(100).default(25).describe('Repositories per page.'),
    withRetentionPolicy: z
      .boolean()
      .default(true)
      .describe('Also fetch each repository\'s retention policy (one extra call per repository).'),
  },
  outputSchema: {
    repositories: z.array(repositorySchema),
    returned: z.number(),
    page: z.number(),
    pageSize: z.number().optional(),
    hasMore: z.boolean(),
    beta: z.literal(true),
  },
  handler: async (input, context) => {
    const response = await context.api.listRegistryRepositories({
      page: input.page,
      pageSize: input.limit,
      query: input.query,
    });
    const repositories = readObjectArray(response, 'repositories').map(parseRepository);
    const hasMore = readBoolean(response, 'hasMore') ?? false;
    const page = readNumber(response, 'page') ?? input.page;
    const pageSize = readNumber(response, 'pageSize');

    if (input.withRetentionPolicy) {
      const results = await Promise.allSettled(
        repositories.map((repository) =>
          repository.name === undefined
            ? Promise.reject(new Error('repository has no name'))
            : context.api.getRegistryRetentionPolicy(repository.name),
        ),
      );
      results.forEach((result, index) => {
        const repository = repositories[index];
        if (repository === undefined) {
          return;
        }
        if (result.status === 'fulfilled') {
          repository.retentionPolicy = parseRetentionPolicy(result.value);
        } else {
          repository.retentionPolicyError = formatDepotError(result.reason).split('\n')[0];
        }
      });
    }

    const text = new TextBudget(context.config.outputCharBudget);
    if (repositories.length === 0) {
      text.push(
        input.query === undefined && input.page === 1
          ? 'No repositories exist in this organization\'s Depot registry. Images land here only when a build pushes to registry.depot.dev.'
          : 'No repositories match this page and query.',
      );
    } else {
      text.push(`${formatCount(repositories.length, 'repository', 'repositories')} (page ${page}):`);
      for (const repository of repositories) {
        const retention = input.withRetentionPolicy
          ? repository.retentionPolicyError === undefined
            ? describeRetention(repository.retentionPolicy)
            : `retention policy unavailable (${repository.retentionPolicyError ?? 'error'})`
          : undefined;
        const bits = [
          `${repository.tagCount ?? '?'} tag(s)`,
          formatBytes(repository.sizeBytes),
          `last push ${repository.lastPushedAt ?? 'never'}`,
          retention,
        ].filter((part): part is string => part !== undefined);
        text.push(`  ${repository.name ?? 'unnamed'}: ${bits.join(' · ')}`);
      }
    }
    if (hasMore) {
      text.push('', `More repositories exist; re-call with page=${page + 1}.`);
    }
    text.push('', BETA_FOOTER);

    return {
      summary: text.render(),
      data: {
        repositories,
        returned: repositories.length,
        page,
        pageSize,
        hasMore,
        beta: true as const,
      },
    };
  },
});

const platformSchema = z.object({
  os: z.string().optional(),
  architecture: z.string().optional(),
  variant: z.string().optional(),
  digest: z.string().optional(),
  sizeBytes: z.number().optional(),
});

export type ManifestKind = 'index' | 'manifest' | 'unknown' | 'absent';

export interface DecodedManifest {
  readonly kind: ManifestKind;
  readonly mediaType: string | undefined;
  readonly platforms: Array<z.infer<typeof platformSchema>>;
  readonly layerCount: number | undefined;
  readonly layersSizeBytes: number | undefined;
  readonly configDigest: string | undefined;
  readonly annotations: Record<string, string>;
  readonly parseError: string | undefined;
}

const MAX_ANNOTATIONS = 20;
const MAX_ANNOTATION_CHARS = 200;

function pickAnnotations(source: unknown): Record<string, string> {
  const record = asObject(source);
  const picked: Record<string, string> = {};
  if (record === undefined) {
    return picked;
  }
  for (const [key, value] of Object.entries(record).slice(0, MAX_ANNOTATIONS)) {
    if (typeof value === 'string') {
      picked[key] = value.length > MAX_ANNOTATION_CHARS ? `${value.slice(0, MAX_ANNOTATION_CHARS)}…` : value;
    }
  }
  return picked;
}

/**
 * `GetImageDetailResponse.manifest` is `bytes`, which protobuf JSON encodes as base64. It holds
 * the raw OCI (or Docker v2) manifest the registry stores: either an image index with one entry
 * per platform, or a single-platform manifest listing config and layers. The manifest is
 * registry content, not something this server produced, so every field is read tolerantly and
 * a manifest that is not JSON is reported rather than thrown.
 */
export function decodeManifest(raw: unknown): DecodedManifest {
  const empty: DecodedManifest = {
    kind: 'absent',
    mediaType: undefined,
    platforms: [],
    layerCount: undefined,
    layersSizeBytes: undefined,
    configDigest: undefined,
    annotations: {},
    parseError: undefined,
  };
  if (raw === undefined || raw === null || raw === '') {
    return empty;
  }

  let document: JsonObject | undefined;
  if (typeof raw === 'string') {
    let decoded: string;
    try {
      decoded = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return { ...empty, kind: 'unknown', parseError: 'manifest is not valid base64' };
    }
    // A proxy or test double may hand the manifest over as JSON text rather than base64.
    const candidate = decoded.trimStart().startsWith('{') ? decoded : raw;
    try {
      document = asObject(JSON.parse(candidate) as unknown);
    } catch {
      return { ...empty, kind: 'unknown', parseError: 'manifest bytes are not JSON' };
    }
  } else {
    document = asObject(raw);
  }
  if (document === undefined) {
    return { ...empty, kind: 'unknown', parseError: 'manifest is not a JSON object' };
  }

  const mediaType = readString(document, 'mediaType');
  const manifests = readObjectArray(document, 'manifests');
  const layers = readObjectArray(document, 'layers');
  const annotations = pickAnnotations(document.annotations);

  if (manifests.length > 0 || (mediaType !== undefined && /\.index\.|manifest\.list/.test(mediaType))) {
    const platforms = manifests.map((entry) => {
      const platform = readObject(entry, 'platform');
      return {
        os: readString(platform, 'os'),
        architecture: readString(platform, 'architecture'),
        variant: readString(platform, 'variant'),
        digest: readString(entry, 'digest'),
        sizeBytes: readNumber(entry, 'size'),
      };
    });
    return {
      kind: 'index',
      mediaType,
      platforms,
      layerCount: undefined,
      layersSizeBytes: undefined,
      configDigest: undefined,
      annotations,
      parseError: undefined,
    };
  }

  if (layers.length > 0 || readObject(document, 'config') !== undefined) {
    let layersSizeBytes = 0;
    let sized = 0;
    for (const layer of layers) {
      const size = readNumber(layer, 'size');
      if (size !== undefined) {
        layersSizeBytes += size;
        sized += 1;
      }
    }
    return {
      kind: 'manifest',
      mediaType,
      platforms: [],
      layerCount: layers.length,
      layersSizeBytes: sized === 0 ? undefined : layersSizeBytes,
      configDigest: readString(readObject(document, 'config'), 'digest'),
      annotations,
      parseError: undefined,
    };
  }

  return { ...empty, kind: 'unknown', mediaType, annotations, parseError: 'manifest has neither manifests nor layers' };
}

function describePlatform(platform: z.infer<typeof platformSchema>): string {
  const name = [platform.os, platform.architecture, platform.variant]
    .filter((part): part is string => part !== undefined)
    .join('/');
  return name === '' ? 'unknown platform' : name;
}

const DIGEST_PATTERN = /^[a-z0-9]+:[0-9a-f]{32,}$/i;

export const getRegistryImageTool = defineTool({
  name: 'depot_get_registry_image',
  title: 'Get one Depot registry image (beta API)',
  description: `Show one image in the organization's Depot registry, by repository plus tag or digest: its digest, media type, size, tags, push time, and a summary of its manifest (the platforms of a multi-platform index, or the layer count and config digest of a single-platform image).

Use this to confirm what a tag points at before a deploy, to check which platforms an image was built for, or to compare the digest behind two tags. The raw manifest is parsed in this server and summarised; it is not returned verbatim.

${BETA_NOTICE}

Read-only: tag and image deletion are deliberately not exposed by this server.`,
  inputSchema: {
    repository: z
      .string()
      .trim()
      .min(1)
      .describe('Repository name as shown by depot_list_registry_repositories.'),
    tag: z.string().trim().min(1).optional().describe('Tag to look up, for example "latest". Give tag or digest, not both.'),
    digest: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe('Content digest to look up, for example "sha256:...". Give tag or digest, not both.'),
  },
  outputSchema: {
    repository: z.string(),
    reference: z.string(),
    digest: z.string().optional(),
    mediaType: z.string().optional(),
    configMediaType: z.string().optional(),
    sizeBytes: z.number().optional(),
    tags: z.array(z.string()),
    pushedAt: z.string().optional(),
    manifestKind: z.enum(['index', 'manifest', 'unknown', 'absent']),
    platforms: z.array(platformSchema),
    layerCount: z.number().optional(),
    layersSizeBytes: z.number().optional(),
    configDigest: z.string().optional(),
    annotations: z.record(z.string(), z.string()),
    manifestParseError: z.string().optional(),
    beta: z.literal(true),
  },
  handler: async (input, context) => {
    if (input.tag !== undefined && input.digest !== undefined) {
      throw new ToolInputError('Give either tag or digest, not both.');
    }
    const reference = input.tag ?? input.digest;
    if (reference === undefined) {
      throw new ToolInputError('A tag or a digest is required to identify the image.');
    }
    if (input.digest !== undefined && !DIGEST_PATTERN.test(input.digest)) {
      throw new ToolInputError(
        'digest must look like "sha256:<hex>". Pass a tag name through the tag argument instead.',
      );
    }

    const response = await context.api.getRegistryImageDetail({
      repository: input.repository,
      reference,
    });
    const digest = readString(response, 'digest');
    const mediaType = readString(response, 'mediaType');
    const configMediaType = readString(response, 'configMediaType');
    const sizeBytes = readNumber(response, 'sizeBytes');
    const tags = readStringArray(response, 'tags');
    const pushedAt = readString(response, 'pushedAt');
    const manifest = decodeManifest(response.manifest);

    const text = new TextBudget(context.config.outputCharBudget);
    text.push(
      `${input.repository}@${reference}${digest === undefined || digest === reference ? '' : ` -> ${digest}`}`,
      `Size: ${formatBytes(sizeBytes)} · pushed ${pushedAt ?? 'unknown'} · ${mediaType ?? 'unknown media type'}`,
      tags.length === 0 ? 'Tags: none (untagged image)' : `Tags: ${tags.join(', ')}`,
    );
    switch (manifest.kind) {
      case 'index':
        text.push(
          manifest.platforms.length === 0
            ? 'Manifest: multi-platform index with no platform entries.'
            : `Manifest: multi-platform index, ${formatCount(manifest.platforms.length, 'platform')}:`,
        );
        for (const platform of manifest.platforms) {
          text.push(
            `  ${describePlatform(platform)}: ${formatBytes(platform.sizeBytes)} manifest${platform.digest === undefined ? '' : ` · ${platform.digest}`}`,
          );
        }
        break;
      case 'manifest':
        text.push(
          `Manifest: single-platform image, ${formatCount(manifest.layerCount ?? 0, 'layer')}${manifest.layersSizeBytes === undefined ? '' : ` totalling ${formatBytes(manifest.layersSizeBytes)}`}${manifest.configDigest === undefined ? '' : ` · config ${manifest.configDigest}`}.`,
          'The platform of a single-platform image lives in its config blob, which this tool does not fetch.',
        );
        break;
      case 'unknown':
        text.push(`Manifest: could not be summarised (${manifest.parseError ?? 'unrecognised shape'}).`);
        break;
      case 'absent':
        text.push('Manifest: Depot returned none for this image.');
        break;
    }
    const annotationEntries = Object.entries(manifest.annotations);
    if (annotationEntries.length > 0) {
      text.push('Annotations (registry content, untrusted):');
      for (const [key, value] of annotationEntries) {
        text.push(`  ${key}=${value}`);
      }
    }
    text.push('', BETA_FOOTER);

    return {
      summary: text.render(),
      data: {
        repository: input.repository,
        reference,
        digest,
        mediaType,
        configMediaType,
        sizeBytes,
        tags,
        pushedAt,
        manifestKind: manifest.kind,
        platforms: manifest.platforms,
        layerCount: manifest.layerCount,
        layersSizeBytes: manifest.layersSizeBytes,
        configDigest: manifest.configDigest,
        annotations: manifest.annotations,
        manifestParseError: manifest.parseError,
        beta: true as const,
      },
    };
  },
});
