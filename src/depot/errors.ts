import { asObject, readString } from './shape.js';

export const CONNECT_ERROR_CODES = [
  'canceled',
  'unknown',
  'invalid_argument',
  'deadline_exceeded',
  'not_found',
  'already_exists',
  'permission_denied',
  'resource_exhausted',
  'failed_precondition',
  'aborted',
  'out_of_range',
  'unimplemented',
  'internal',
  'unavailable',
  'data_loss',
  'unauthenticated',
] as const;

export type ConnectErrorCode = (typeof CONNECT_ERROR_CODES)[number];

const HTTP_STATUS_TO_CODE: Readonly<Record<number, ConnectErrorCode>> = {
  400: 'invalid_argument',
  401: 'unauthenticated',
  403: 'permission_denied',
  404: 'not_found',
  408: 'deadline_exceeded',
  409: 'aborted',
  412: 'failed_precondition',
  429: 'resource_exhausted',
  499: 'canceled',
  500: 'internal',
  501: 'unimplemented',
  502: 'unavailable',
  503: 'unavailable',
  504: 'unavailable',
};

const RETRYABLE_CODES: ReadonlySet<ConnectErrorCode> = new Set([
  'unavailable',
  'deadline_exceeded',
  'aborted',
  'resource_exhausted',
]);

function isConnectErrorCode(value: string): value is ConnectErrorCode {
  return (CONNECT_ERROR_CODES as readonly string[]).includes(value);
}

export interface RpcTarget {
  readonly service: string;
  readonly method: string;
}

export function rpcLabel(target: RpcTarget): string {
  return `${target.service}/${target.method}`;
}

/** An error Depot returned as a Connect error envelope, or one synthesised from an HTTP status. */
export class DepotApiError extends Error {
  readonly code: ConnectErrorCode;
  readonly httpStatus: number;
  readonly rpc: string;
  readonly serverMessage: string | undefined;
  readonly retryable: boolean;

  constructor(options: {
    code: ConnectErrorCode;
    httpStatus: number;
    rpc: string;
    serverMessage?: string | undefined;
  }) {
    const detail = options.serverMessage ?? `HTTP ${options.httpStatus}`;
    super(`Depot ${options.rpc} failed with ${options.code}: ${detail}`);
    this.name = 'DepotApiError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    this.rpc = options.rpc;
    this.serverMessage = options.serverMessage;
    this.retryable = RETRYABLE_CODES.has(options.code);
  }
}

/** A request that never produced an HTTP response: DNS failure, TLS failure, timeout, offline. */
export class DepotTransportError extends Error {
  readonly rpc: string;
  readonly retryable = true;

  constructor(rpc: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Could not reach the Depot API for ${rpc}: ${reason}`);
    this.name = 'DepotTransportError';
    this.rpc = rpc;
    this.cause = cause;
  }
}

export type DepotRequestError = DepotApiError | DepotTransportError;

export function isDepotRequestError(value: unknown): value is DepotRequestError {
  return value instanceof DepotApiError || value instanceof DepotTransportError;
}

export function parseConnectError(
  target: RpcTarget,
  httpStatus: number,
  rawBody: string,
): DepotApiError {
  const rpc = rpcLabel(target);
  const fallbackCode = HTTP_STATUS_TO_CODE[httpStatus] ?? 'unknown';

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // A non-JSON body means we did not reach a Connect handler at all — usually a wrong
    // DEPOT_API_URL landing on an HTML error page. Surface a snippet, not the whole page.
    const snippet = rawBody.trim().slice(0, 200);
    return new DepotApiError({
      code: fallbackCode,
      httpStatus,
      rpc,
      serverMessage:
        snippet === ''
          ? undefined
          : `non-JSON response from the API (is DEPOT_API_URL correct?): ${snippet}`,
    });
  }

  const envelope = asObject(parsed);
  const declaredCode = readString(envelope, 'code');
  const code =
    declaredCode !== undefined && isConnectErrorCode(declaredCode) ? declaredCode : fallbackCode;

  return new DepotApiError({
    code,
    httpStatus,
    rpc,
    serverMessage: readString(envelope, 'message'),
  });
}

const CODE_GUIDANCE: Readonly<Record<ConnectErrorCode, string>> = {
  unauthenticated:
    'Depot rejected the credential. Check that DEPOT_TOKEN is set to a current, unrevoked Depot API token — an Organization token from Organization Settings -> API Tokens, or a user token from `depot login`. Project tokens cannot reach the CI API or the Depot API at all.',
  permission_denied:
    'The token is valid but is not allowed to see this resource. If it is a user token spanning several organizations, set DEPOT_ORG_ID to the organization that owns this resource. If it is a project token, it cannot reach the CI API — use an Organization token.',
  not_found:
    'Depot has no such record. Check the identifier, and check that it belongs to the organization this token is scoped to — a valid ID from another organization reads as not found.',
  invalid_argument:
    'Depot rejected the arguments. Re-read the tool input description; contradictory filters (for example a pull-request number without a repo) produce this.',
  failed_precondition:
    'The resource is in the wrong state for this call, or its state changed mid-request. Re-read current status and try again.',
  resource_exhausted:
    'Depot applied a limit. Log streams are capped per token, per organization and per attempt, and metrics results can be too large to return. Wait a moment, then narrow the request (fewer lines, a single attempt) and retry.',
  unavailable:
    "Depot's log or metrics store is transiently unavailable. This is retryable — try again shortly.",
  internal: 'Depot hit a server-side error. Retry; if it persists, this is a Depot-side problem.',
  deadline_exceeded: 'The request outran its deadline. Retry with a narrower request.',
  canceled: 'The request was canceled before it completed.',
  unknown: 'Depot returned an unclassified error.',
  already_exists: 'The resource already exists.',
  out_of_range: 'An argument was outside the range Depot accepts.',
  unimplemented:
    'Depot does not implement this method. The API surface may have changed — this server may need an update.',
  aborted: 'The request was aborted, usually by a concurrency conflict. Retry.',
  data_loss: 'Depot reported unrecoverable data loss for this request.',
};

/**
 * Turn a failed request into something an agent can act on, rather than a raw error envelope.
 * Never includes the token or any request header.
 */
export function formatDepotError(error: unknown): string {
  if (error instanceof DepotApiError) {
    const lines = [
      `Depot API error (${error.code}, HTTP ${error.httpStatus}) calling ${error.rpc}.`,
    ];
    if (error.serverMessage !== undefined) {
      lines.push(`Depot said: ${error.serverMessage}`);
    }
    lines.push(CODE_GUIDANCE[error.code]);
    return lines.join('\n');
  }

  if (error instanceof DepotTransportError) {
    return [
      error.message,
      'Check network connectivity and, if you have overridden it, that DEPOT_API_URL points at a Depot API endpoint.',
    ].join('\n');
  }

  return error instanceof Error ? error.message : String(error);
}
