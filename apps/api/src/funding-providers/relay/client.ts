import {
  parseRelayRequestList,
  relayQuoteResponseSchema,
  relayStatusResponseSchema,
  type RelayQuoteResponse,
  type RelayRequestListItem,
  type RelayStatusResponse,
} from "./schemas.js";

const DEFAULT_RELAY_API_BASE_URL = "https://api.relay.link";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class RelayClientError extends Error {
  constructor(
    message: string,
    readonly code:
      | "http_error"
      | "invalid_response"
      | "network_error"
      | "response_too_large"
      | "timeout",
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

export type RelayQuoteRequest = Readonly<{
  user: string;
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: "EXACT_INPUT";
  useDepositAddress?: boolean;
  strict?: boolean;
  refundTo?: string;
}>;

export type RelayClientConfig = Readonly<{
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}>;

export class RelayClient {
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(config: RelayClientConfig) {
    if (!config.apiKey.trim()) {
      throw new Error("Relay API key must not be empty");
    }
    this.#apiKey = config.apiKey;
    this.#baseUrl = new URL(DEFAULT_RELAY_API_BASE_URL);
    this.#fetch = config.fetchImpl ?? fetch;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isInteger(this.#timeoutMs) ||
      this.#timeoutMs <= 0 ||
      this.#timeoutMs > 60_000
    ) {
      throw new Error("Relay timeout must be between 1 and 60000 milliseconds");
    }
  }

  async quote(request: RelayQuoteRequest): Promise<RelayQuoteResponse> {
    const response = await this.#request(
      "POST",
      "/quote/v2",
      undefined,
      request,
    );
    const parsed = relayQuoteResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new RelayClientError(
        "Relay Quote v2 response failed the pinned schema",
        "invalid_response",
        false,
      );
    }
    return parsed.data;
  }

  async status(requestId: string): Promise<RelayStatusResponse> {
    const normalizedRequestId = normalizeOpaqueLookup(
      requestId,
      "Relay request ID",
    );
    const response = await this.#request(
      "GET",
      "/intents/status/v3",
      new URLSearchParams({ requestId: normalizedRequestId }),
    );
    const parsed = relayStatusResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new RelayClientError(
        "Relay Status v3 response failed the pinned schema",
        "invalid_response",
        false,
      );
    }
    return parsed.data;
  }

  async requestsByDepositAddress(
    depositAddress: string,
  ): Promise<readonly RelayRequestListItem[]> {
    const normalizedDepositAddress = normalizeOpaqueLookup(
      depositAddress,
      "Relay deposit address",
    );
    try {
      return parseRelayRequestList(
        await this.#request(
          "GET",
          "/requests/v2",
          new URLSearchParams({
            depositAddress: normalizedDepositAddress,
            includeChildRequests: "true",
            limit: "50",
            sortBy: "updatedAt",
            sortDirection: "asc",
          }),
        ),
      );
    } catch (error) {
      if (error instanceof RelayClientError) throw error;
      throw new RelayClientError(
        "Relay Requests v2 response failed the pinned schema",
        "invalid_response",
        false,
      );
    }
  }

  async #request(
    method: "GET" | "POST",
    path: string,
    query?: URLSearchParams,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    if (query) url.search = query.toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const contentLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_RESPONSE_BYTES
      ) {
        throw new RelayClientError(
          "Relay response exceeded size limit",
          "response_too_large",
          false,
          response.status,
        );
      }
      const text = await readBoundedResponseText(response);
      if (!response.ok) {
        throw new RelayClientError(
          `Relay HTTP ${response.status}`,
          "http_error",
          response.status === 429 || response.status >= 500,
          response.status,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new RelayClientError(
          "Relay returned invalid JSON",
          "invalid_response",
          false,
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof RelayClientError) throw error;
      if (controller.signal.aborted) {
        throw new RelayClientError("Relay request timed out", "timeout", true);
      }
      throw new RelayClientError(
        "Relay network request failed",
        "network_error",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeOpaqueLookup(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 512) {
    throw new Error(`${label} length is outside policy`);
  }
  return normalized;
}

async function readBoundedResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RelayClientError(
        "Relay response exceeded size limit",
        "response_too_large",
        false,
        response.status,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
