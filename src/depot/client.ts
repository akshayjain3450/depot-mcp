import {
  DepotApiError,
  DepotTransportError,
  isDepotRequestError,
  parseConnectError,
  parseRetryAfter,
  rpcLabel,
  type RpcTarget,
} from './errors.js';
import { asObject, type JsonObject } from './shape.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DepotClientOptions {
  readonly token: string;
  readonly apiUrl: string;
  readonly orgId?: string | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Clock, injectable so the deadline can be tested without waiting. */
  readonly now?: (() => number) | undefined;
  readonly maxAttempts?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
  /** Upper bound on one `call()`, retries and backoff included. */
  readonly callDeadlineMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
export const DEFAULT_CALL_DEADLINE_MS = 40_000;
/** Depot's largest legitimate responses (a full log page) are well under 1 MiB. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const BASE_BACKOFF_MS = 250;

/**
 * Depot's CLI backs off up to 30s, which suits a long-lived process. A tool call sits inside a
 * client timeout measured in tens of seconds, so the ceiling here is deliberately much lower:
 * better to return a retryable error the agent can call again than to hold the turn open.
 */
const MAX_BACKOFF_MS = 4_000;
/** The most a `Retry-After` header can hold a call; beyond this the agent should decide. */
const MAX_RETRY_AFTER_MS = MAX_BACKOFF_MS * 2;

export function backoffMs(attempt: number, error: unknown): number {
  if (error instanceof DepotApiError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS);
  }
  const exponential = Math.min(BASE_BACKOFF_MS * 3 ** (attempt - 1), MAX_BACKOFF_MS);
  const isLimit = error instanceof DepotApiError && error.code === 'resource_exhausted';
  return isLimit ? Math.min(exponential * 4, MAX_RETRY_AFTER_MS) : exponential;
}

class BodyTooLargeError extends Error {
  constructor(readonly declaredBytes: number | undefined) {
    super('response body exceeds the size cap');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Reads a body while counting bytes, cancelling the stream as soon as the cap is passed so a
 * runaway response cannot exhaust memory before `text()` would have returned.
 */
async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    throw new BodyTooLargeError(Number(declared));
  }
  if (response.body === null) {
    return response.text();
  }

  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(undefined);
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

/**
 * Minimal client for Depot's Connect JSON binding: every unary RPC is
 * `POST <apiUrl>/<fully.qualified.Service>/<Method>` with a JSON body.
 */
export class DepotClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly orgId: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly callDeadlineMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: DepotClientOptions) {
    this.token = options.token;
    this.baseUrl = options.apiUrl.replace(/\/+$/, '');
    this.orgId = options.orgId;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.now = options.now ?? (() => Date.now());
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.callDeadlineMs = options.callDeadlineMs ?? DEFAULT_CALL_DEADLINE_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async call(target: RpcTarget, request: JsonObject = {}): Promise<JsonObject> {
    const deadline = this.now() + this.callDeadlineMs;
    let timeoutRetries = 0;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(target, request, deadline);
      } catch (error) {
        if (!isDepotRequestError(error) || !error.retryable || attempt >= this.maxAttempts) {
          throw error;
        }
        // A request that outran its own timeout is unlikely to succeed on a third try, and each
        // retry costs another full timeout; one retry covers the transient case.
        if (error instanceof DepotTransportError && error.timedOut) {
          if (timeoutRetries >= 1) {
            throw error;
          }
          timeoutRetries += 1;
        }
        const wait = backoffMs(attempt, error);
        if (this.now() + wait >= deadline) {
          throw error;
        }
        await this.sleep(wait);
      }
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
      // Required by the Connect protocol for unary requests; without it Depot may reject the call.
      'connect-protocol-version': '1',
    };
    if (this.orgId !== undefined) {
      headers['x-depot-org'] = this.orgId;
    }
    return headers;
  }

  private transportError(rpc: string, cause: unknown): DepotTransportError {
    return new DepotTransportError(rpc, cause, [this.token]);
  }

  private async attempt(
    target: RpcTarget,
    request: JsonObject,
    deadline: number,
  ): Promise<JsonObject> {
    const rpc = rpcLabel(target);
    const url = `${this.baseUrl}/${target.service}/${target.method}`;
    const timeoutMs = Math.max(1, Math.min(this.requestTimeoutMs, deadline - this.now()));

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        // JSON.stringify drops undefined-valued keys, which is exactly the wire shape we want:
        // protobuf JSON treats an absent field as unset.
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw this.transportError(rpc, error);
    }

    let body: string;
    try {
      body = await readBodyCapped(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        const size =
          error.declaredBytes === undefined
            ? 'a response'
            : `a ${error.declaredBytes.toLocaleString('en-US')}-byte response`;
        throw new DepotApiError({
          code: 'resource_exhausted',
          httpStatus: response.status,
          rpc,
          serverMessage: `Depot sent ${size} larger than the ${Math.round(this.maxResponseBytes / 1024 / 1024)} MiB this server will read. Narrow the request (fewer lines, one attempt, a shorter time range).`,
          retryable: false,
        });
      }
      throw this.transportError(rpc, error);
    }

    if (!response.ok) {
      throw parseConnectError(
        target,
        response.status,
        body,
        parseRetryAfter(response.headers.get('retry-after'), this.now()),
        [this.token],
      );
    }

    if (body.trim() === '') {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new DepotApiError({
        code: 'internal',
        httpStatus: response.status,
        rpc,
        serverMessage: 'Depot returned a success status with a body that is not valid JSON.',
      });
    }

    const object = asObject(parsed);
    if (object === undefined) {
      throw new DepotApiError({
        code: 'internal',
        httpStatus: response.status,
        rpc,
        serverMessage: 'Depot returned a success status with a body that is not a JSON object.',
      });
    }
    return object;
  }
}
