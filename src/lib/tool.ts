import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DepotMcpConfig } from '../config.js';
import type { DepotApi } from '../depot/api.js';
import { formatDepotError, isDepotRequestError } from '../depot/errors.js';

export interface ToolContext {
  readonly api: DepotApi;
  readonly config: DepotMcpConfig;
  /** Pause between polls. Injected so the test suite can wait without waiting. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Clock, injected alongside `sleep` so a fake sleep can advance a fake clock. */
  readonly now: () => number;
}

export interface ToolOutcome<TData> {
  /** Prose the model reads by default. Must already respect the configured character budget. */
  readonly summary: string;
  readonly data: TData;
}

/** Thrown when a request is well-formed but cannot be satisfied; surfaced as a tool error. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface ToolSpec<TInput extends z.ZodRawShape, TOutput extends z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly annotations?: Partial<ToolAnnotations> | undefined;
  readonly handler: (
    input: z.output<z.ZodObject<TInput>>,
    context: ToolContext,
  ) => Promise<ToolOutcome<z.input<z.ZodObject<TOutput>>>>;
}

export interface ToolModule {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  register(server: McpServer, context: ToolContext): void;
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/**
 * Wraps a tool spec so registration, argument parsing, output validation and Depot error
 * translation happen in exactly one place. Erasing the schema generics behind `ToolModule` keeps
 * heterogeneous tools storable in a single list.
 */
export function defineTool<TInput extends z.ZodRawShape, TOutput extends z.ZodRawShape>(
  spec: ToolSpec<TInput, TOutput>,
): ToolModule {
  const annotations: ToolAnnotations = {
    title: spec.title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    // A fixed, authenticated API rather than the open web; a tool that fans out can override.
    openWorldHint: false,
    ...spec.annotations,
  };

  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    annotations,
    register(server: McpServer, context: ToolContext): void {
      const inputObject = z.object(spec.inputSchema);
      const outputObject = z.object(spec.outputSchema);
      // Widening to the non-generic shape type lets the SDK resolve its conditional callback
      // type; left generic it stays deferred and no concrete handler is assignable.
      const inputSchema: z.ZodRawShape = spec.inputSchema;
      const outputSchema: z.ZodRawShape = spec.outputSchema;

      server.registerTool(
        spec.name,
        {
          title: spec.title,
          description: spec.description,
          inputSchema,
          outputSchema,
          annotations,
        },
        async (rawInput: unknown): Promise<CallToolResult> => {
          // McpServer validates arguments before calling this, so this branch is normally
          // unreachable; it stays as a guard against a future SDK that stops doing so.
          const parsedInput = inputObject.safeParse(rawInput ?? {});
          if (!parsedInput.success) {
            return toolError(
              `Invalid arguments for ${spec.name}: ${z.prettifyError(parsedInput.error)}`,
            );
          }

          try {
            const outcome = await spec.handler(parsedInput.data, context);
            return {
              content: [{ type: 'text', text: outcome.summary }],
              structuredContent: { ...outputObject.parse(outcome.data) },
            };
          } catch (error) {
            if (isDepotRequestError(error)) {
              return toolError(formatDepotError(error));
            }
            if (error instanceof ToolInputError) {
              return toolError(error.message);
            }
            // A bug in this server (a handler that threw, or output that failed its own schema).
            // The stack goes to stderr for the operator; the client gets a clean error result
            // instead of a thrown exception rewrapped by the SDK.
            const message =
              error instanceof z.ZodError
                ? `output failed its schema: ${z.prettifyError(error)}`
                : error instanceof Error
                  ? error.message
                  : String(error);
            console.error(
              `${spec.name} threw:`,
              error instanceof Error ? (error.stack ?? error.message) : error,
            );
            return toolError(`depot-mcp internal error in ${spec.name}: ${message}`);
          }
        },
      );
    },
  };
}
