export const DEFAULT_API_URL = 'https://api.depot.dev';
export const DEFAULT_MAX_LOG_PAGES = 20;
export const DEFAULT_OUTPUT_CHAR_BUDGET = 24_000;

export interface DepotMcpConfig {
  readonly token: string;
  readonly apiUrl: string;
  readonly orgId: string | undefined;
  readonly projectId: string | undefined;
  /**
   * Gate for mutating tools. v1 registers no mutating tools at all, so this currently only
   * controls whether the (empty) write tool set is offered — the wiring exists so a future
   * version can add them without reworking registration.
   */
  readonly allowWrites: boolean;
  readonly maxLogPages: number;
  readonly outputCharBudget: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const MISSING_TOKEN_MESSAGE = `DEPOT_TOKEN is not set, so depot-mcp cannot talk to the Depot API.

Create an Organization token in the Depot dashboard under
Organization Settings -> API Tokens, then pass it to the server through your MCP client config:

  {
    "mcpServers": {
      "depot": {
        "command": "npx",
        "args": ["-y", "depot-mcp"],
        "env": { "DEPOT_TOKEN": "dp_..." }
      }
    }
  }

A user token created by \`depot login\` also works, but it spans every organization you belong to;
if you belong to more than one, set DEPOT_ORG_ID as well. Project tokens will not work — they
cannot reach the Depot CI API or the Depot API.`;

function readOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function readBooleanFlag(value: string | undefined): boolean {
  const normalized = readOptional(value)?.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  const raw = readOptional(value);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DepotMcpConfig {
  const token = readOptional(env.DEPOT_TOKEN);
  if (token === undefined) {
    throw new ConfigError(MISSING_TOKEN_MESSAGE);
  }

  const apiUrl = readOptional(env.DEPOT_API_URL) ?? DEFAULT_API_URL;
  if (!/^https?:\/\//.test(apiUrl)) {
    throw new ConfigError(
      `DEPOT_API_URL must be an http(s) URL, got ${JSON.stringify(apiUrl)}. Leave it unset to use ${DEFAULT_API_URL}.`,
    );
  }

  return {
    token,
    apiUrl,
    orgId: readOptional(env.DEPOT_ORG_ID),
    projectId: readOptional(env.DEPOT_PROJECT_ID),
    allowWrites: readBooleanFlag(env.DEPOT_MCP_ALLOW_WRITES),
    maxLogPages: readPositiveInt(
      env.DEPOT_MCP_MAX_LOG_PAGES,
      DEFAULT_MAX_LOG_PAGES,
      'DEPOT_MCP_MAX_LOG_PAGES',
    ),
    outputCharBudget: readPositiveInt(
      env.DEPOT_MCP_OUTPUT_BUDGET,
      DEFAULT_OUTPUT_CHAR_BUDGET,
      'DEPOT_MCP_OUTPUT_BUDGET',
    ),
  };
}
