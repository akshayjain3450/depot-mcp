import {
  DepotApiError,
  DepotTransportError,
  isDepotRequestError,
  parseConnectError,
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
  readonly maxAttempts?: number | undefined;
  readonly requestTimeoutMs?: number | undefined;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 25_000;
const BASE_BACKOFF_MS = 250;

/**
 * Depot's CLI backs off up to 30s, which suits a long-lived process. A tool call sits inside a
 * client timeout measured in tens of seconds, so the ceiling here is deliberately much lower —
 * better to return a retryable error the agent can call again than to hold the turn open.
 */
const MAX_BACKOFF_MS = 4_000;

function backoffMs(attempt: number, error: unknown): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 3 ** (attempt - 1), MAX_BACKOFF_MS);
  const isLimit = error instanceof DepotApiError && error.code === 'resource_exhausted';
  return isLimit ? Math.min(exponential * 4, MAX_BACKOFF_MS * 2) : exponential;
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
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;

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
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async call(target: RpcTarget, request: JsonObject = {}): Promise<JsonObject> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(target, request);
      } catch (error) {
        const retryable =
          isDepotRequestError(error) && error.retryable && attempt < this.maxAttempts;
        if (!retryable) {
          throw error;
        }
        await this.sleep(backoffMs(attempt, error));
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

  private async attempt(target: RpcTarget, request: JsonObject): Promise<JsonObject> {
    const rpc = rpcLabel(target);
    const url = `${this.baseUrl}/${target.service}/${target.method}`;

    let response: Response;
    let body: string;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: this.headers(),
        // JSON.stringify drops undefined-valued keys, which is exactly the wire shape we want:
        // protobuf JSON treats an absent field as unset.
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      body = await response.text();
    } catch (error) {
      throw new DepotTransportError(rpc, error);
    }

    if (!response.ok) {
      throw parseConnectError(target, response.status, body);
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
