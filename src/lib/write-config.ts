import { z } from 'zod';
import {
  defineTool,
  ToolInputError,
  type ToolContext,
  type ToolModule,
  type ToolOutcome,
} from './tool.js';

const dryRunSchema = {
  dryRun: z
    .boolean()
    .default(true)
    .describe(
      'Preview only (the default). The tool reads current state and reports what it would change, without calling any mutating RPC. Set false to apply; the result then carries the state before and after.',
    ),
};

/** The tool's parsed arguments plus the `dryRun` flag the helper adds. */
export type WriteInput<TInput extends z.ZodRawShape> = z.output<z.ZodObject<TInput>> & {
  readonly dryRun: boolean;
};

type Shape<TShape extends z.ZodRawShape> = z.input<z.ZodObject<TShape>>;

export interface WriteToolSpec<
  TInput extends z.ZodRawShape,
  TPreview extends z.ZodRawShape,
  TAfter extends z.ZodRawShape,
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** The tool's own arguments; `dryRun` is added here. */
  readonly inputSchema: TInput;
  readonly previewSchema: TPreview;
  readonly afterSchema: TAfter;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  /** Read RPCs only: what exists now and what the write would do to it. */
  readonly preview: (
    input: WriteInput<TInput>,
    context: ToolContext,
  ) => Promise<ToolOutcome<Shape<TPreview>>>;
  /** A reason blocks the write in both modes, before any mutating RPC. */
  readonly refuse: (preview: Shape<TPreview>, input: WriteInput<TInput>) => string | undefined;
  /** Identifiers for the audit line: names and ids, never values. */
  readonly auditIds: (input: WriteInput<TInput>, preview: Shape<TPreview>) => string;
  readonly apply: (
    input: WriteInput<TInput>,
    context: ToolContext,
    preview: Shape<TPreview>,
  ) => Promise<ToolOutcome<Shape<TAfter>>>;
}

/**
 * Every mutating tool runs the same way: preview with read RPCs, refuse server-side when a
 * precondition fails, and only then call the mutating RPC. `dryRun` defaults to true, so a call
 * that omits it changes nothing and returns the exact arguments to resend. One audit line per
 * applied write goes to stderr; stdout is the protocol.
 */
export function defineWriteTool<
  TInput extends z.ZodRawShape,
  TPreview extends z.ZodRawShape,
  TAfter extends z.ZodRawShape,
>(spec: WriteToolSpec<TInput, TPreview, TAfter>): ToolModule {
  const previewObject = z.object(spec.previewSchema);
  const afterObject = z.object(spec.afterSchema);

  return defineTool({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: { ...spec.inputSchema, ...dryRunSchema },
    outputSchema: {
      applied: z.boolean(),
      preview: previewObject.optional(),
      resend: z.record(z.string(), z.unknown()).optional(),
      before: previewObject.optional(),
      after: afterObject.optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: spec.destructive,
      idempotentHint: spec.idempotent,
      openWorldHint: true,
    },
    handler: async (parsed, context) => {
      // The parsed shape is `TInput & dryRun`; TypeScript cannot reduce that intersection while
      // TInput is still generic, so name it once here rather than at every use.
      const input = parsed as WriteInput<TInput>;
      const preview = await spec.preview(input, context);
      const reason = spec.refuse(preview.data, input);
      if (reason !== undefined) {
        throw new ToolInputError(`Refused, nothing was changed: ${reason}`);
      }

      if (input.dryRun) {
        const resend: Record<string, unknown> = { ...input, dryRun: false };
        return {
          summary: [
            `DRY RUN of ${spec.name}: nothing was changed.`,
            '',
            preview.summary,
            '',
            `To apply, call ${spec.name} again with the same arguments and dryRun: false (the resend field holds them).`,
          ].join('\n'),
          data: { applied: false, preview: preview.data, resend },
        };
      }

      const after = await spec.apply(input, context, preview.data);
      console.error(
        `[depot-mcp write] ${spec.name} ${spec.auditIds(input, preview.data)} ${new Date().toISOString()}`,
      );
      return {
        summary: `Applied ${spec.name}.\n\n${after.summary}`,
        data: { applied: true, before: preview.data, after: after.data },
      };
    },
  });
}
