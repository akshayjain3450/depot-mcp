import { z } from 'zod';
import { asObject, readObjectArray, readString, type JsonObject } from '../depot/shape.js';
import { TextBudget } from '../lib/budget.js';
import { redactValue } from '../lib/redact.js';
import { defineTool, type ToolContext } from '../lib/tool.js';

export const ATTRIBUTE_KEYS = ['repository', 'environment', 'branch', 'workflow'] as const;

export interface Variant {
  id: string | undefined;
  name: string | undefined;
  attributes: Record<string, string>;
  lastModified: string | undefined;
  value: string | undefined;
  redacted: boolean;
  redactionReason: string | undefined;
}

export interface NamedEntry {
  id: string | undefined;
  name: string;
  description: string | undefined;
  variants: Variant[];
}

/** Variant scoping arrives either as an object of named attributes or as key/value pairs. */
function readAttributes(source: JsonObject): Record<string, string> {
  const attributes: Record<string, string> = {};
  const nested = source.attributes;

  if (Array.isArray(nested)) {
    for (const entry of nested) {
      const record = asObject(entry);
      const key = readString(record, 'key', 'name', 'type');
      const value = readString(record, 'value');
      if (key !== undefined && value !== undefined) {
        attributes[key] = value;
      }
    }
    return attributes;
  }

  const record = asObject(nested) ?? source;
  for (const key of ATTRIBUTE_KEYS) {
    const value = readString(record, key);
    if (value !== undefined) {
      attributes[key] = value;
    }
  }
  return attributes;
}

/**
 * One named secret or variable with its variants. Depot's generated bindings call the variant's
 * own name `name` (the CLI's `variantName` spelling is accepted too); a bare entry with no
 * `variants` list is treated as its own single variant.
 */
export function parseEntry(entry: JsonObject, withValues: boolean): NamedEntry {
  const name = readString(entry, 'name') ?? 'unnamed';
  const rawVariants = readObjectArray(entry, 'variants');
  const variants = (rawVariants.length > 0 ? rawVariants : [entry]).map((variant): Variant => {
    const rawValue = withValues ? readString(variant, 'value') : undefined;
    const redaction =
      rawValue === undefined
        ? { value: undefined, redacted: false, reason: undefined }
        : redactValue(name, rawValue);
    return {
      id: readString(variant, 'id', 'variantId'),
      name: readString(variant, 'variantName', 'variant', 'name'),
      attributes: readAttributes(variant),
      lastModified: readString(variant, 'lastModified', 'updatedAt'),
      value: redaction.value,
      redacted: redaction.redacted,
      redactionReason: redaction.reason,
    };
  });
  return {
    id: readString(entry, 'id', 'variableId', 'secretId'),
    name,
    description: readString(entry, 'description'),
    variants,
  };
}

export function parseEntries(
  response: JsonObject,
  listKey: string,
  withValues: boolean,
): NamedEntry[] {
  return readObjectArray(response, listKey).map((entry) => parseEntry(entry, withValues));
}

export function describeAttributes(attributes: Record<string, string>): string {
  const entries = Object.entries(attributes);
  return entries.length === 0
    ? 'applies everywhere'
    : entries.map(([key, value]) => `${key}=${value}`).join(', ');
}

interface ScopeFilter {
  readonly query?: string | undefined;
  readonly repository?: string | undefined;
  readonly environment?: string | undefined;
  readonly branch?: string | undefined;
  readonly workflow?: string | undefined;
}

function applyFilter(entries: NamedEntry[], filter: ScopeFilter): NamedEntry[] {
  const needle = filter.query?.toLowerCase();
  const wanted: Array<[string, string | undefined]> = [
    ['repository', filter.repository],
    ['environment', filter.environment],
    ['branch', filter.branch],
    ['workflow', filter.workflow],
  ];

  const result: NamedEntry[] = [];
  for (const entry of entries) {
    if (needle !== undefined && !entry.name.toLowerCase().includes(needle)) {
      continue;
    }
    const variants = entry.variants.filter((variant) =>
      wanted.every(
        ([key, value]) =>
          value === undefined ||
          variant.attributes[key] === undefined ||
          variant.attributes[key] === value,
      ),
    );
    if (variants.length > 0) {
      result.push({ ...entry, variants });
    }
  }
  return result;
}

const filterSchema = {
  query: z.string().optional().describe('Case-insensitive substring match on the name.'),
  repository: z
    .string()
    .optional()
    .describe('Keep variants scoped to this repository, plus unscoped ones.'),
  environment: z.string().optional().describe('Keep variants scoped to this environment.'),
  branch: z.string().optional().describe('Keep variants scoped to this branch.'),
  workflow: z.string().optional().describe('Keep variants scoped to this workflow.'),
};

export const variantSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  attributes: z.record(z.string(), z.string()),
  lastModified: z.string().optional(),
  value: z.string().optional(),
  redacted: z.boolean(),
  redactionReason: z.string().optional(),
});

const entrySchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string().optional(),
  variants: z.array(variantSchema),
});

function render(
  context: ToolContext,
  label: string,
  entries: NamedEntry[],
  showValues: boolean,
): string {
  const text = new TextBudget(context.config.outputCharBudget);
  if (entries.length === 0) {
    text.push(
      `No CI ${label} matched.`,
      'An empty result can also mean the token cannot see this organization — depot_whoami will confirm, and DEPOT_ORG_ID selects one when a token spans several.',
    );
    return text.render();
  }

  text.push(`${entries.length} CI ${label}:`);
  for (const entry of entries) {
    text.push(
      `  ${entry.name}${entry.description === undefined ? '' : ` — ${entry.description}`}`,
    );
    for (const variant of entry.variants) {
      const scope = describeAttributes(variant.attributes);
      const shown =
        showValues && variant.value !== undefined ? ` = ${variant.value}` : '';
      text.push(`    ${variant.name ?? 'default'}: ${scope}${shown}`);
    }
  }
  return text.render();
}

export const listCiSecretsTool = defineTool({
  name: 'depot_list_ci_secrets',
  title: 'List Depot CI secret names and scoping',
  description: `List the names and scoping of Depot CI secrets. Values are never returned — Depot's API does not expose them at all, by design.

Use this to answer "why can't my job see $FOO". Depot models a secret as one name with several variants, each scoped by repository, environment, branch, and workflow attributes; a job that cannot see a secret usually means no variant matches that job's scope. Compare what this returns against the job you are debugging.

Filtering happens in this server, because Depot's v3beta2 list filters are undocumented. Note that depot.ci.v3beta2 is a beta API and the most likely of Depot's surfaces to change.`,
  inputSchema: filterSchema,
  outputSchema: {
    secrets: z.array(entrySchema),
    returned: z.number(),
    valuesAvailable: z
      .literal(false)
      .describe('Always false: Depot never returns secret values over the API.'),
  },
  handler: async (input, context) => {
    const entries = applyFilter(
      parseEntries(await context.api.listSecrets(), 'secrets', false),
      input,
    );
    return {
      summary: render(context, 'secret(s)', entries, false),
      data: { secrets: entries, returned: entries.length, valuesAvailable: false as const },
    };
  },
});

export const listCiVariablesTool = defineTool({
  name: 'depot_list_ci_variables',
  title: 'List Depot CI variables and their scoping',
  description: `List Depot CI variables, their values, and their scoping.

Use this for the same "why can't my job see $FOO" question as depot_list_ci_secrets, and to check that a variable holds what you expect for a given branch or environment. Depot models a variable as one name with several variants, each scoped by repository, environment, branch, and workflow.

Unlike secrets, Depot does return variable values. Because variables are routinely misused to hold credentials, this server redacts any value whose name or content looks like a secret and reports which rule fired, so a redacted value still tells you the variable exists.

Filtering happens in this server. depot.ci.v3beta2 is a beta API and the most likely of Depot's surfaces to change.`,
  inputSchema: filterSchema,
  outputSchema: {
    variables: z.array(entrySchema),
    returned: z.number(),
    redactedCount: z.number(),
  },
  handler: async (input, context) => {
    const entries = applyFilter(
      parseEntries(await context.api.listVariables(), 'variables', true),
      input,
    );
    const redactedCount = entries.reduce(
      (total, entry) => total + entry.variants.filter((variant) => variant.redacted).length,
      0,
    );

    const summary = render(context, 'variable(s)', entries, true);
    return {
      summary:
        redactedCount === 0
          ? summary
          : `${summary}\n\n${redactedCount} value(s) were redacted by this server because they look like credentials.`,
      data: { variables: entries, returned: entries.length, redactedCount },
    };
  },
});
