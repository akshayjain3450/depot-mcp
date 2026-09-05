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
        "env": { "DEPOT_TOKEN": "YOUR_DEPOT_TOKEN" }
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

/**
 * A value is quoted back in an error only when it is short and plainly not a secret. Anything
 * else (a token pasted into the wrong variable, say) is described, never echoed.
 */
function describeValue(raw: string): string {
  return raw.length <= 40 && /^[\w.+-]+$/.test(raw) ? `got ${JSON.stringify(raw)}` : 'got a value that is not one';
}

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  const raw = readOptional(value);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, ${describeValue(raw)}.`);
  }
  return parsed;
}

/** Printable ASCII, no spaces: what an HTTP header value may hold and what Depot tokens use. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

function readToken(value: string | undefined): string {
  const token = readOptional(value);
  if (token === undefined) {
    throw new ConfigError(MISSING_TOKEN_MESSAGE);
  }
  if (!TOKEN_PATTERN.test(token)) {
    // Never echo the value: this is the token itself, and the usual cause is a line break
    // picked up from a wrapped terminal, which would otherwise be copied into an HTTP error.
    throw new ConfigError(
      'DEPOT_TOKEN contains whitespace or control characters (often a line break copied from a wrapped terminal). Paste the token again as a single line.',
    );
  }
  return token;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/**
 * Validates an override of the API endpoint. The token travels in a header to whatever this
 * names, so the rules are strict and the raw value is never repeated in an error: a token
 * pasted into this variable by mistake must not land in a log line.
 */
function readApiUrl(value: string | undefined): string {
  const raw = readOptional(value);
  if (raw === undefined) {
    return DEFAULT_API_URL;
  }
  const reject = (rule: string): never => {
    throw new ConfigError(
      `DEPOT_API_URL ${rule}. Leave it unset to use ${DEFAULT_API_URL}; the value is not repeated here in case it is a secret.`,
    );
  };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('is not an absolute URL (expected something like https://api.depot.dev)');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return reject('must be an http(s) URL');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return reject('must use https: except for localhost, 127.0.0.1, ::1 or *.localhost');
  }
  if (url.username !== '' || url.password !== '') {
    return reject('must not embed a username or password');
  }
  if (url.search !== '' || url.hash !== '') {
    return reject('must not carry a query string or fragment');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DepotMcpConfig {
  const token = readToken(env.DEPOT_TOKEN);
  const apiUrl = readApiUrl(env.DEPOT_API_URL);

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
