import { z } from 'zod';
import type { VariableAttribute } from '../depot/api.js';
import { DepotApiError } from '../depot/errors.js';
import { readBoolean, readObject, readString, type JsonObject } from '../depot/shape.js';
import { redactValue } from '../lib/redact.js';
import type { ToolContext } from '../lib/tool.js';
import { defineWriteTool } from '../lib/write.js';
import {
  ATTRIBUTE_KEYS,
  describeAttributes,
  parseEntry,
  variantSchema,
  type NamedEntry,
} from './ci-config.js';

/** A variant as it appears in a preview: the list tool's shape, with every field optional. */
type VariantView = z.input<typeof variantSchema>;

const DEFAULT_VARIANT = 'default';

/** GitHub-style identifier: what `${{ vars.NAME }}` can reference, and safe in an audit line. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

const nameSchema = z
  .string()
  .regex(VARIABLE_NAME, 'a variable name is letters, digits and underscores, not starting with a digit')
  .describe('The CI variable name, as referenced by ${{ vars.NAME }} in a workflow.');

const scopeSchema = {
  repository: z
    .string()
    .min(1)
    .optional()
    .describe('Scope the variant to one repository, as owner/name. Omit for every repository.'),
  environment: z
    .string()
    .min(1)
    .optional()
    .describe('Scope the variant to one GitHub environment name.'),
  branch: z
    .string()
    .min(1)
    .optional()
    .describe('Scope the variant to a branch; Depot accepts glob patterns such as release/*.'),
  workflow: z
    .string()
    .min(1)
    .optional()
    .describe('Scope the variant to one workflow file, for example ci.yml; glob patterns allowed.'),
};

type Scope = { [K in (typeof ATTRIBUTE_KEYS)[number]]?: string | undefined };

function scopeOf(input: Scope): Record<string, string> {
  const scope: Record<string, string> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const value = input[key];
    if (value !== undefined) {
      scope[key] = value;
    }
  }
  return scope;
}

function toAttributes(scope: Record<string, string>): VariableAttribute[] {
  return Object.entries(scope).map(([key, value]) => ({ key, value }));
}

function variantLabel(variant: VariantView): string {
  return variant.name ?? DEFAULT_VARIANT;
}

function describeVariant(variant: VariantView): string {
  const value = variant.value === undefined ? '(no value returned)' : variant.value;
  return `${variantLabel(variant)}: ${describeAttributes(variant.attributes)} = ${value}${
    variant.id === undefined ? '' : ` [id ${variant.id}]`
  }`;
}

/** `undefined` when Depot has no variable of that name; any other failure propagates. */
async function findVariable(context: ToolContext, name: string): Promise<NamedEntry | undefined> {
  let response: JsonObject;
  try {
    response = await context.api.getVariable(name);
  } catch (error) {
    if (error instanceof DepotApiError && error.code === 'not_found') {
      return undefined;
    }
    throw error;
  }
  const variable = readObject(response, 'variable') ?? response;
  return parseEntry(variable, true);
}

async function secretExists(context: ToolContext, name: string): Promise<boolean> {
  try {
    await context.api.getSecret(name);
    return true;
  } catch (error) {
    if (error instanceof DepotApiError && error.code === 'not_found') {
      return false;
    }
    throw error;
  }
}

const FIELD_NAME_NOTE =
  "Request field names come from the generated v3beta2 bindings vendored in Depot's open-source CLI (variables.pb.go); this server has never called the mutating RPC live, so treat the first real apply as a verification step. depot.ci.v3beta2 is a beta API.";

export const setCiVariableTool = defineWriteTool({
  name: 'depot_set_ci_variable',
  title: 'Create or update one Depot CI variable variant',
  description: `Create or overwrite one variant of a Depot CI variable (SetVariableVariant), the API form of \`depot ci vars set\`.

A variable is a name with variants; each variant carries a value and optional scoping (repository, environment, branch, workflow). Without variantName this writes the "default" variant, exactly as the CLI does, and the scoping given here replaces that variant's scoping. dryRun (the default) fetches the current variable and shows the variant that would be overwritten, with its current value.

Refuses, before any write: a value this server's redaction rules classify as a credential (use a Depot secret for those; variables are readable by anyone who can list them), and a name that already belongs to a Depot CI secret, since \${{ vars.X }} next to \${{ secrets.X }} is a mistake waiting to happen. Only registered when DEPOT_MCP_ALLOW_WRITES is set. ${FIELD_NAME_NOTE}`,
  inputSchema: {
    name: nameSchema,
    value: z
      .string()
      .max(64_000)
      .describe('The plain-text value. Credential-shaped values are refused; store those as secrets.'),
    variantName: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Which variant to write. Omit for "default", the variant the CLI writes without one.'),
    description: z
      .string()
      .max(1_000)
      .optional()
      .describe('Free-text description stored on the variant; omit to leave it unchanged.'),
    ...scopeSchema,
  },
  previewSchema: {
    name: z.string(),
    variantName: z.string(),
    value: z.string(),
    scope: z.record(z.string(), z.string()),
    variableExists: z.boolean(),
    variableId: z.string().optional(),
    existingVariant: variantSchema.optional(),
    otherVariants: z.array(variantSchema),
    secretWithSameName: z.boolean(),
    valueLooksLikeCredential: z.string().optional(),
  },
  afterSchema: {
    variableId: z.string().optional(),
    variantId: z.string().optional(),
    createdVariable: z.boolean().optional(),
    createdVariant: z.boolean().optional(),
  },
  destructive: false,
  idempotent: true,
  preview: async (input, context) => {
    const variantName = input.variantName ?? DEFAULT_VARIANT;
    const scope = scopeOf(input);
    const [variable, secretWithSameName] = await Promise.all([
      findVariable(context, input.name),
      secretExists(context, input.name),
    ]);
    const existingVariant = variable?.variants.find(
      (variant) => variantLabel(variant) === variantName,
    );
    const otherVariants =
      variable?.variants.filter((variant) => variant !== existingVariant) ?? [];
    const redaction = redactValue(input.name, input.value);

    const lines: string[] = [];
    if (variable === undefined) {
      lines.push(`No CI variable named ${input.name} exists; this would create it with variant "${variantName}".`);
    } else if (existingVariant === undefined) {
      lines.push(
        `${input.name} exists (${variable.variants.length} variant(s)) but has no "${variantName}" variant; this would add one.`,
      );
    } else {
      lines.push(
        `${input.name} variant "${variantName}" would be overwritten. Currently: ${describeVariant(existingVariant)}`,
      );
    }
    // A credential-shaped value is refused below; echoing it here would put it in the preview.
    lines.push(
      `New value: ${redaction.reason === undefined ? input.value : redaction.value}`,
      `New scope: ${describeAttributes(scope)}`,
    );
    if (input.description !== undefined) {
      lines.push(`Description: ${input.description}`);
    }
    if (otherVariants.length > 0) {
      lines.push('Other variants, untouched:');
      for (const variant of otherVariants) {
        lines.push(`  ${describeVariant(variant)}`);
      }
    }

    return {
      lines,
      data: {
        name: input.name,
        variantName,
        value: redaction.reason === undefined ? input.value : redaction.value,
        scope,
        variableExists: variable !== undefined,
        variableId: variable?.id,
        existingVariant,
        otherVariants,
        secretWithSameName,
        valueLooksLikeCredential: redaction.reason,
      },
    };
  },
  refuse: (preview) => {
    if (preview.valueLooksLikeCredential !== undefined) {
      return `the value for ${preview.name} looks like a credential (redaction rule "${preview.valueLooksLikeCredential}" fired). Depot CI variables are returned in plain text to anyone who can list them. Store it as a Depot secret instead: depot ci secrets set ${preview.name}.`;
    }
    if (preview.secretWithSameName) {
      return `a Depot CI secret named ${preview.name} already exists. A variable with the same name would sit beside it as \${{ vars.${preview.name} }}; choose a different name.`;
    }
    return undefined;
  },
  auditIds: (_input, preview) => `variable=${preview.name} variant=${preview.variantName}`,
  apply: async (input, context, preview) => {
    const response = await context.api.setVariableVariant({
      variableName: input.name,
      variantName: input.variantName,
      value: input.value,
      description: input.description,
      attributes: toAttributes(preview.scope),
    });
    const variable = readObject(response, 'variable');
    const variant = readObject(response, 'variant');
    const createdVariable = readBoolean(response, 'createdVariable');
    const createdVariant = readBoolean(response, 'createdVariant');
    const verb =
      createdVariable === true
        ? 'created the variable and its'
        : createdVariant === true
          ? 'added'
          : 'updated';
    return {
      lines: [`${input.name}: ${verb} variant "${preview.variantName}" (${describeAttributes(preview.scope)}).`],
      data: {
        variableId: readString(variable, 'id') ?? preview.variableId,
        variantId: readString(variant, 'id'),
        createdVariable,
        createdVariant,
      },
    };
  },
});

export const deleteCiVariableTool = defineWriteTool({
  name: 'depot_delete_ci_variable',
  title: 'Delete one Depot CI variable variant, or a whole variable',
  description: `Delete one variant of a Depot CI variable (DeleteVariableVariant), or with allVariants: true the whole variable and every variant (DeleteVariable). The API form of \`depot ci vars remove\`.

Select the variant by variantName and/or by scoping attributes (repository, environment, branch, workflow); the selector must match exactly one variant. dryRun (the default) lists the variable's variants with their values, marks which would go, and changes nothing. Deleting the last variant removes the variable itself, and Depot reports that.

Refuses, before any write: a name Depot does not have; a selector that matches no variant or more than one; a call with no selector unless allVariants is true, so a whole-variable delete is always explicit; and allVariants combined with a selector. Values are shown with this server's credential redaction applied. Only registered when DEPOT_MCP_ALLOW_WRITES is set. ${FIELD_NAME_NOTE}`,
  inputSchema: {
    name: nameSchema,
    variantName: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe('Select the variant by its name ("default" for the unnamed one).'),
    ...scopeSchema,
    allVariants: z
      .boolean()
      .default(false)
      .describe('Delete the variable and every variant. Required for a whole-variable delete; cannot be combined with a selector.'),
  },
  previewSchema: {
    name: z.string(),
    variableExists: z.boolean(),
    variableId: z.string().optional(),
    allVariants: z.boolean(),
    selector: z.object({
      variantName: z.string().optional(),
      scope: z.record(z.string(), z.string()),
    }),
    variants: z.array(variantSchema),
    matching: z.array(variantSchema),
  },
  afterSchema: {
    deletedVariable: z.boolean(),
    deletedVariantIds: z.array(z.string()),
  },
  destructive: true,
  idempotent: true,
  preview: async (input, context) => {
    const scope = scopeOf(input);
    const variable = await findVariable(context, input.name);
    const variants = variable?.variants ?? [];
    const selectorGiven = input.variantName !== undefined || Object.keys(scope).length > 0;
    const matching = selectorGiven
      ? variants.filter(
          (variant) =>
            (input.variantName === undefined || variantLabel(variant) === input.variantName) &&
            Object.entries(scope).every(([key, value]) => variant.attributes[key] === value),
        )
      : variants;

    const lines: string[] = [];
    if (variable === undefined) {
      lines.push(`No CI variable named ${input.name} exists.`);
    } else {
      lines.push(`${input.name} has ${variants.length} variant(s):`);
      for (const variant of variants) {
        const marked = matching.includes(variant) ? 'WOULD DELETE' : 'kept';
        lines.push(`  [${marked}] ${describeVariant(variant)}`);
      }
      if (input.allVariants) {
        lines.push(`allVariants is set: the variable ${input.name} itself would be removed.`);
      }
    }

    return {
      lines,
      data: {
        name: input.name,
        variableExists: variable !== undefined,
        variableId: variable?.id,
        allVariants: input.allVariants,
        selector: { variantName: input.variantName, scope },
        variants,
        matching,
      },
    };
  },
  refuse: (preview) => {
    const selectorGiven =
      preview.selector.variantName !== undefined || Object.keys(preview.selector.scope).length > 0;
    if (!preview.variableExists) {
      return `no CI variable named ${preview.name} exists. depot_list_ci_variables shows the names Depot has.`;
    }
    if (preview.allVariants && selectorGiven) {
      return 'allVariants cannot be combined with variantName or scoping attributes. Either select one variant, or delete the whole variable with allVariants alone.';
    }
    if (!selectorGiven && !preview.allVariants) {
      return `this would delete ${preview.name} and all ${preview.variants.length} of its variant(s). Pass allVariants: true to confirm, or select one variant with variantName, repository, environment, branch, or workflow.`;
    }
    if (preview.allVariants) {
      return undefined;
    }
    if (preview.matching.length === 0) {
      return `no variant of ${preview.name} matches that selector. The dry run lists the variants that exist.`;
    }
    if (preview.matching.length > 1) {
      return `the selector matches ${preview.matching.length} variants of ${preview.name} (${preview.matching
        .map((variant) => variant.name ?? DEFAULT_VARIANT)
        .join(', ')}); narrow it to one, or pass allVariants: true to delete the whole variable.`;
    }
    if (preview.matching[0]?.id === undefined) {
      return `Depot returned no id for that variant, so this server cannot address it for deletion. Use depot ci vars remove ${preview.name} --variant ${preview.matching[0]?.name ?? DEFAULT_VARIANT} instead.`;
    }
    return undefined;
  },
  auditIds: (_input, preview) =>
    preview.allVariants
      ? `variable=${preview.name} id=${preview.variableId ?? 'by-name'} all-variants`
      : `variable=${preview.name} variant=${preview.matching[0]?.id ?? 'unknown'}`,
  apply: async (_input, context, preview) => {
    if (preview.allVariants) {
      await context.api.deleteVariable(
        preview.variableId === undefined ? { name: preview.name } : { id: preview.variableId },
      );
      const ids = preview.variants
        .map((variant) => variant.id)
        .filter((id): id is string => id !== undefined);
      return {
        lines: [`Deleted ${preview.name} and its ${preview.variants.length} variant(s).`],
        data: { deletedVariable: true, deletedVariantIds: ids },
      };
    }
    const target = preview.matching[0];
    const variantId = target?.id;
    if (target === undefined || variantId === undefined) {
      // refuse() already rejected this shape; the guard keeps the types honest.
      throw new Error('no addressable variant to delete');
    }
    const response = await context.api.deleteVariableVariant(variantId);
    const deletedVariable = readBoolean(response, 'deletedVariable') ?? false;
    return {
      lines: [
        deletedVariable
          ? `Deleted variant "${variantLabel(target)}" of ${preview.name}; it was the last one, so the variable is gone too.`
          : `Deleted variant "${variantLabel(target)}" of ${preview.name} (${describeAttributes(target.attributes)}); ${preview.variants.length - 1} variant(s) remain.`,
      ],
      data: { deletedVariable, deletedVariantIds: [variantId] },
    };
  },
});
