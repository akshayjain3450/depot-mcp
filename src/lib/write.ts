import { z } from 'zod';
import { DepotApiError } from '../depot/errors.js';
import { TextBudget } from './budget.js';
import { defineTool, ToolInputError, type ToolContext, type ToolModule } from './tool.js';

export const DRY_RUN_DESCRIPTION =
  'Defaults to true, and a dry run changes nothing: it reads the current state from Depot, returns a preview, says whether the write would be refused, and echoes the exact arguments to resend. Show the preview to the user and get their confirmation, then call the tool again with the same arguments and dryRun:false to apply.';

const WRITE_DESCRIPTION_FOOTER = `Two-step flow: every call defaults to dryRun:true, which only reads. Confirm the preview with the user, then resend with dryRun:false. The apply step re-reads the current state first and refuses (before calling Depot) if it no longer qualifies. Each applied write is logged to the server's stderr.`;

export interface WritePreview<TData> {
  /** Structured preview, echoed in the dry-run result and as `before` on apply. */
  readonly data: TData;
  /** Human-readable lines describing the current state, shown in both modes. */
  readonly lines: string[];
}

export interface WriteApplied<TData> {
  readonly data: TData;
  readonly lines?: readonly string[] | undefined;
}

export type WriteInput<TInput extends z.ZodRawShape> = z.output<z.ZodObject<TInput>>;

export interface WriteToolSpec<
  TInput extends z.ZodRawShape,
  TPreview extends z.ZodRawShape,
  TAfter extends z.ZodRawShape,
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The tool's own arguments. `dryRun` is added by the helper and must not be declared here. */
  readonly inputSchema: TInput;
  readonly previewSchema: TPreview;
  readonly afterSchema: TAfter;
  /** Cancels and deletes are destructive; retries and reruns create new work but destroy nothing. */
  readonly destructive: boolean;
  /** False for anything that creates a new attempt or run each time it is applied. */
  readonly idempotent: boolean;
  /** Reads the current state with Depot's read RPCs. Runs on every call, dry or not. */
  readonly preview: (
    input: WriteInput<TInput>,
    context: ToolContext,
  ) => Promise<WritePreview<z.input<z.ZodObject<TPreview>>>>;
  /** Returns the reason the write must not proceed, or undefined when it may. Never calls Depot. */
  readonly refuse: (
    preview: z.input<z.ZodObject<TPreview>>,
    input: WriteInput<TInput>,
  ) => string | undefined;
  /** The single mutating RPC. Only reached when a fresh preview passed `refuse`. */
  readonly apply: (
    input: WriteInput<TInput>,
    context: ToolContext,
    preview: z.input<z.ZodObject<TPreview>>,
  ) => Promise<WriteApplied<z.input<z.ZodObject<TAfter>>>>;
  /**
   * Identifiers for the audit line: names and ids, never values. Defaults to every
   * string-valued argument, which is right for tools whose arguments are ids; a tool that takes
   * a value (a variable's contents, a project name) names what it touched from the preview
   * instead.
   */
  readonly auditIds?:
    | ((input: WriteInput<TInput>, preview: z.input<z.ZodObject<TPreview>>) => string)
    | undefined;
}

/**
 * The default audit identifiers: every string-valued argument. Only strings qualify: ids are
 * strings, and the token never appears in tool input.
 */
export function defaultAuditIds(input: Record<string, unknown>): string {
  const parts = Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${key}=${value}`);
  return parts.length === 0 ? '(no ids)' : parts.join(' ');
}

/** One line per applied write, to stderr, so an operator can see what an agent changed. */
export function writeAuditLine(tool: string, ids: string, now = new Date()): void {
  console.error(`[depot-mcp write] ${tool} ${ids} ${now.toISOString()}`);
}

/**
 * Turns Depot's 412 into something the model can act on. Depot answers `failed_precondition`
 * when a retry or rerun targets a running workflow, and for rules this server does not know.
 */
function translatePrecondition(tool: string, error: DepotApiError): ToolInputError {
  const said = error.serverMessage === undefined ? '' : ` Depot said: ${error.serverMessage}.`;
  return new ToolInputError(
    `Depot refused ${tool} (${error.code}, HTTP ${error.httpStatus}) calling ${error.rpc}; nothing was changed.${said} Either the state changed between this server's preview and the request, or Depot applies a rule the preview does not check (for example, a workflow that is still running cannot be retried or rerun). Call the tool again with dryRun:true to see the current state, and wait for the workflow to finish if it is still running.`,
  );
}

/**
 * Wraps a mutating tool in the pattern every write here follows: dry-run by default, a preview
 * read from Depot in both modes, server-side refusals before any mutating RPC, and one audit
 * line per applied write. Registration, validation and error translation come from `defineTool`.
 */
export function defineWriteTool<
  TInput extends z.ZodRawShape,
  TPreview extends z.ZodRawShape,
  TAfter extends z.ZodRawShape,
>(spec: WriteToolSpec<TInput, TPreview, TAfter>): ToolModule {
  if ('dryRun' in spec.inputSchema) {
    throw new Error(`${spec.name} declares dryRun itself; defineWriteTool adds it.`);
  }

  const inputSchema = {
    ...spec.inputSchema,
    dryRun: z.boolean().default(true).describe(DRY_RUN_DESCRIPTION),
  };
  const previewObject = z.object(spec.previewSchema);
  const afterObject = z.object(spec.afterSchema);
  const outputSchema = {
    tool: z.string(),
    applied: z.boolean(),
    /** Present on a dry run that would be refused; the apply step returns a tool error instead. */
    refusal: z.string().optional(),
    preview: previewObject.optional(),
    resend: z.record(z.string(), z.unknown()).optional(),
    before: previewObject.optional(),
    after: afterObject.optional(),
  };

  return defineTool({
    name: spec.name,
    title: spec.title,
    description: `${spec.description}\n\n${WRITE_DESCRIPTION_FOOTER}`,
    inputSchema,
    outputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: spec.destructive,
      idempotentHint: spec.idempotent,
      // A write's effect reaches beyond this server: it starts or stops compute elsewhere.
      openWorldHint: true,
    },
    handler: async (rawInput, context) => {
      // Zod has already applied the schema, so the parsed object is the spec's own input plus
      // dryRun. TypeScript cannot see through a spread on a generic shape, so the split is done
      // on the erased type; this is the one cast in the write path.
      const { dryRun: dryRunValue, ...rest } = rawInput as Record<string, unknown>;
      const dryRun = dryRunValue !== false;
      const input = rest as WriteInput<TInput>;
      const text = new TextBudget(context.config.outputCharBudget);

      const preview = await spec.preview(input, context);
      const refusal = spec.refuse(preview.data, input);

      if (dryRun) {
        const resend: Record<string, unknown> = { ...rest, dryRun: false };
        text.push(`DRY RUN of ${spec.name}: nothing was changed. Current state read from Depot:`);
        text.push(...preview.lines.map((line) => `  ${line}`));
        if (refusal !== undefined) {
          text.push(
            '',
            `This write would be REFUSED: ${refusal}`,
            'Resending with dryRun:false will fail with the same reason until the state changes.',
          );
          return {
            summary: text.render(),
            data: { tool: spec.name, applied: false, refusal, preview: preview.data },
          };
        }
        text.push(
          '',
          `To apply: confirm with the user that this is wanted, then call ${spec.name} again with exactly ${JSON.stringify(resend)}.`,
        );
        return {
          summary: text.render(),
          data: { tool: spec.name, applied: false, preview: preview.data, resend },
        };
      }

      if (refusal !== undefined) {
        throw new ToolInputError(
          `Refused ${spec.name} before calling Depot: ${refusal} Nothing was changed. Current state: ${preview.lines.join('; ')}`,
        );
      }

      let applied: WriteApplied<z.input<z.ZodObject<TAfter>>>;
      try {
        applied = await spec.apply(input, context, preview.data);
      } catch (error) {
        if (error instanceof DepotApiError && error.code === 'failed_precondition') {
          throw translatePrecondition(spec.name, error);
        }
        throw error;
      }
      writeAuditLine(
        spec.name,
        spec.auditIds === undefined ? defaultAuditIds(rest) : spec.auditIds(input, preview.data),
      );

      text.push(`APPLIED ${spec.name}.`, 'State read from Depot immediately before applying:');
      text.push(...preview.lines.map((line) => `  ${line}`));
      const afterLines = applied.lines ?? [];
      if (afterLines.length > 0) {
        text.push('', "Depot's response:");
        text.push(...afterLines.map((line) => `  ${line}`));
      }
      return {
        summary: text.render(),
        data: { tool: spec.name, applied: true, before: preview.data, after: applied.data },
      };
    },
  });
}
