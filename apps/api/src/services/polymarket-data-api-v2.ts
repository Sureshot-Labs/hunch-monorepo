import { normalizePolymarketAssetId, parseRetryAfterMs } from "@hunch/shared";

import { isRecord } from "../lib/type-guards.js";
import {
  currentDataApiLane,
  awaitDataApiTask,
  DataApiAdmissionError,
  type DataApiAdmission,
  type DataApiLane,
  type DataApiPermit,
} from "./polymarket-data-api-admission.js";

export type DataApiErrorDiagnostics = Readonly<{
  source: "upstream" | "shared_limiter";
  cfRay: string | null;
  contentType: string | null;
  responseFormat: "json" | "empty_or_non_json" | null;
}>;

export type PolymarketDataApiPage<T> = {
  data: T[];
  nextCursor: string | null;
};
export class PolymarketDataApiV2CursorError extends Error {
  constructor() {
    super("Polymarket Data API V2 repeated a pagination cursor.");
    this.name = "PolymarketDataApiV2CursorError";
  }
}

export class PolymarketDataApiV2Error extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryable: boolean,
    public readonly traceId: string | null,
    public readonly retryAfterMs: number | null,
    public readonly parameter: string | null = null,
    public readonly reason:
      | "protocol_contract"
      | "invalid_cursor"
      | "shared_cooldown"
      | "admission_deadline"
      | "coordination_unavailable"
      | null = null,
    public readonly diagnostics: DataApiErrorDiagnostics = {
      source: "upstream",
      cfRay: null,
      contentType: null,
      responseFormat: null,
    },
  ) {
    super(`Polymarket Data API V2 request failed (${status}).`);
    this.name = "PolymarketDataApiV2Error";
  }
}

/** Missing pagination is a malformed response, not proof of an empty wallet. */
export function parsePolymarketDataApiV2Page<T>(
  payload: unknown,
  parseRow: (row: unknown) => T,
): PolymarketDataApiPage<T> {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.data) ||
    !isRecord(payload.pagination) ||
    !(
      payload.pagination.next_cursor === null ||
      (typeof payload.pagination.next_cursor === "string" &&
        payload.pagination.next_cursor.length > 0 &&
        payload.pagination.next_cursor.length <= 8192)
    )
  ) {
    throw new Error(
      "Polymarket Data API V2 returned an invalid page envelope.",
    );
  }
  return {
    data: payload.data.map(parseRow),
    nextCursor: payload.pagination.next_cursor,
  };
}

/** One bounded page for intentional top-N reads and cursor-driven UI feeds. */
export async function fetchPolymarketDataApiV2Page<T>(inputs: {
  baseUrl: string;
  endpoint:
    | "positions"
    | "holders"
    | "trades"
    | "prices-history"
    | "activity"
    | "resolutions";
  params: Readonly<Record<string, string>>;
  parseRow: (row: unknown) => T;
  timeoutMs: number;
  cursor?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  admission?: DataApiAdmission;
  lane?: DataApiLane;
}): Promise<PolymarketDataApiPage<T>> {
  if (
    !Number.isFinite(inputs.timeoutMs) ||
    inputs.timeoutMs <= 0 ||
    "offset" in inputs.params ||
    "cursor" in inputs.params ||
    (inputs.cursor != null &&
      (!inputs.cursor.length || inputs.cursor.length > 8192))
  )
    throw new Error("Polymarket Data API V2 request bounds are invalid.");
  const url = new URL(`/v2/${inputs.endpoint}`, inputs.baseUrl);
  for (const [key, value] of Object.entries(inputs.params))
    url.searchParams.set(key, value);
  if (inputs.cursor) url.searchParams.set("cursor", inputs.cursor);
  const timeoutSignal = AbortSignal.timeout(inputs.timeoutMs);
  const signal = inputs.signal
    ? AbortSignal.any([inputs.signal, timeoutSignal])
    : timeoutSignal;
  signal.throwIfAborted();
  // Injected fetches are an offline transport boundary. Runtime wrappers (such
  // as holder telemetry) explicitly carry the shared admission dependency.
  const admission =
    inputs.admission ??
    (inputs.fetchImpl
      ? undefined
      : await awaitDataApiTask(
          import("./polymarket-data-api-admission-runtime.js").then((module) =>
            module.getDataApiAdmission(),
          ),
          signal,
        ));
  let permit: DataApiPermit | undefined;
  let outcome: "success" | "other" = "other";
  try {
    if (admission) {
      try {
        permit = await admission.acquire(
          url,
          signal,
          inputs.lane ?? currentDataApiLane(),
          inputs.timeoutMs,
        );
      } catch (error) {
        // The page's own deadline can expire before acquire emits its lease
        // deadline. No HTTP request was made: do not blame the upstream.
        const admissionError =
          error instanceof DataApiAdmissionError
            ? error
            : timeoutSignal.aborted &&
                error === timeoutSignal.reason &&
                !(inputs.signal?.aborted && error === inputs.signal.reason)
              ? new DataApiAdmissionError(0, "admission_deadline")
              : null;
        if (!admissionError) throw error;
        throw new PolymarketDataApiV2Error(
          admissionError.reason === "shared_cooldown" ? 429 : 503,
          admissionError.reason,
          true,
          null,
          admissionError.retryAfterMs,
          null,
          admissionError.reason,
          {
            source: "shared_limiter",
            cfRay: null,
            contentType: null,
            responseFormat: null,
          },
        );
      }
    }
    signal.throwIfAborted();
    const response = await (inputs.fetchImpl ?? fetch)(url, {
      method: "GET",
      // The positions edge returns an empty 429 for Node's default User-Agent,
      // even below its request allowance. Identify our client truthfully; keep
      // shared admission and Retry-After handling for real capacity limits.
      headers: {
        accept: "application/json",
        "user-agent": "Hunch/1.0 (+https://hunch.trade)",
      },
      signal,
    });
    outcome =
      response.status < 500 && response.status !== 429 ? "success" : "other";
    if (!response.ok) {
      let retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      if (response.status === 429 && admission && permit) {
        const limitedPermit = permit;
        permit = undefined;
        const feedback = admission.finish(limitedPermit, {
          kind: "limited",
          retryAfterMs: retryAfterMs ?? 0,
        });
        try {
          const wait = await awaitDataApiTask(feedback, signal);
          retryAfterMs = Math.max(retryAfterMs ?? 0, wait);
        } catch {
          // Already received a real 429. Cleanup must not replace that fact
          // (or its Retry-After) with a slice cancellation. The lease expires
          // even if Redis is unavailable; late feedback is still observed.
          void feedback.catch(() => {});
        }
      }
      const payload: unknown = await response.json().catch(() => null);
      const error = isRecord(payload) ? payload : {};
      throw new PolymarketDataApiV2Error(
        response.status,
        typeof error.code === "string" ? error.code : null,
        typeof error.retryable === "boolean"
          ? error.retryable
          : response.status === 429 || response.status >= 500,
        typeof error.trace_id === "string"
          ? error.trace_id
          : response.headers.get("x-trace-id"),
        retryAfterMs,
        typeof error.parameter === "string" &&
          /^[a-z_]{1,40}$/i.test(error.parameter)
          ? error.parameter
          : null,
        response.status === 400 &&
          error.parameter === "user" &&
          typeof error.error === "string" &&
          /user is a protocol contract address/i.test(error.error)
          ? "protocol_contract"
          : response.status === 400 && error.parameter === "cursor"
            ? "invalid_cursor"
            : null,
        {
          source: "upstream",
          cfRay: response.headers.get("cf-ray")?.slice(0, 80) ?? null,
          contentType:
            response.headers.get("content-type")?.slice(0, 100) ?? null,
          responseFormat: isRecord(payload) ? "json" : "empty_or_non_json",
        },
      );
    }
    const payload: unknown = await response.json();
    // The condition-batched resolutions endpoint is explicitly unpaginated.
    // Never accept a missing cursor envelope on an account/positions walk.
    const page =
      inputs.endpoint === "resolutions" &&
      isRecord(payload) &&
      Array.isArray(payload.data) &&
      !("pagination" in payload)
        ? { data: payload.data.map(inputs.parseRow), nextCursor: null }
        : parsePolymarketDataApiV2Page(payload, inputs.parseRow);
    signal.throwIfAborted();
    if (inputs.cursor != null && page.nextCursor === inputs.cursor)
      throw new PolymarketDataApiV2CursorError();
    return page;
  } finally {
    if (admission && permit) {
      const completion = admission.finish(permit, {
        kind: outcome,
        retryAfterMs: 0,
      });
      // Finishing the limiter is cleanup, not request evidence. Never mask a
      // known HTTP error or successful parsed page with a late Redis failure
      // or cancellation. Late permit cleanup/lease expiry remain in force.
      try {
        await awaitDataApiTask(completion, signal);
      } catch {
        void completion.catch(() => {});
      }
    }
  }
}

/** Complete API projection only: inactive markets can be absent even after
 * the final cursor. This must never authorize zeroing a ledger balance.
 * Callers choose row-grain deduplication; no partial result is returned/cached.
 * No automatic retries here: retry/budget decisions belong to the caller.
 */
export async function fetchPolymarketDataApiV2Pages<T>(inputs: {
  baseUrl: string;
  endpoint: "positions" | "holders" | "trades" | "prices-history";
  params: Readonly<Record<string, string>>;
  parseRow: (row: unknown) => T;
  timeoutMs: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
  admission?: DataApiAdmission;
  lane?: DataApiLane;
}): Promise<T[]> {
  const maxPages = inputs.maxPages ?? 20;
  if (
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    !Number.isFinite(inputs.timeoutMs) ||
    inputs.timeoutMs <= 0
  ) {
    throw new Error("Polymarket Data API V2 request bounds are invalid.");
  }
  if ("cursor" in inputs.params || "offset" in inputs.params) {
    throw new Error(
      "Polymarket Data API V2 cursor is owned by the page walker.",
    );
  }
  const params = { ...inputs.params };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), inputs.timeoutMs);
  const deadline = Date.now() + inputs.timeoutMs;
  const rows: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new DOMException(
          "Polymarket Data API V2 timed out.",
          "AbortError",
        );
      }
      const page: PolymarketDataApiPage<T> = await fetchPolymarketDataApiV2Page(
        {
          ...inputs,
          params,
          cursor,
          timeoutMs: Math.max(1, deadline - Date.now()),
          signal: controller.signal,
          fetchImpl: inputs.fetchImpl,
        },
      );
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new DOMException(
          "Polymarket Data API V2 timed out.",
          "AbortError",
        );
      }
      rows.push(...page.data);
      if (page.nextCursor === null) return rows;
      if (seenCursors.has(page.nextCursor)) {
        throw new Error("Polymarket Data API V2 repeated a pagination cursor.");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new Error("Polymarket Data API V2 exceeded the bounded page count.");
  } finally {
    clearTimeout(timeout);
  }
}

function requireString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || !value.length) {
    throw new Error(`Polymarket Data API V2 row has an invalid ${field}.`);
  }
  return value;
}

function requireAssetId(row: Record<string, unknown>): string {
  const value = normalizePolymarketAssetId(requireString(row, "token_id"));
  // Unlike quantities/marks, uint256 identities must never pass through Number.
  if (value === null) {
    throw new Error("Polymarket Data API V2 row has an invalid token_id.");
  }
  return value;
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim()) ||
    !Number.isFinite(Number(value))
  ) {
    throw new Error(`Polymarket Data API V2 row has an invalid ${field}.`);
  }
  return Number(value);
}

function requireQuantity(value: unknown, field: string): number {
  const quantity = nullableNumber(value, field);
  if (quantity === null || quantity < 0) {
    throw new Error(`Polymarket Data API V2 row has an invalid ${field}.`);
  }
  return quantity;
}

function requireOutcomeIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Polymarket Data API V2 row has an invalid outcome_index.");
  }
  // In particular, keep 999 unknown; do not turn it into binary NO.
  return value;
}

export type PolymarketDataApiV2Position = {
  tokenId: string;
  proxyWallet: string;
  conditionId: string;
  currentSize: number;
  averagePrice: number | null;
  outcomeIndex: number;
  redeemable: boolean;
  entryCostUsdc: number | null;
  entryFeesUsdc: number | null;
  totalCostUsdc: number | null;
  realizedPnl: number | null;
  unrealizedPnl: number | null;
};

/** Enrichment DTO, never a replacement for raw accounting/receipt evidence. */
export function parsePolymarketDataApiV2Position(
  row: unknown,
): PolymarketDataApiV2Position {
  if (!isRecord(row) || typeof row.redeemable !== "boolean") {
    throw new Error("Polymarket Data API V2 returned an invalid position.");
  }
  return {
    tokenId: requireAssetId(row),
    proxyWallet: requireString(row, "proxy_wallet"),
    conditionId: requireString(row, "condition_id"),
    currentSize: requireQuantity(row.current_size, "current_size"),
    averagePrice: nullableNumber(row.avg_price, "avg_price"),
    outcomeIndex: requireOutcomeIndex(row.outcome_index),
    redeemable: row.redeemable,
    entryCostUsdc: nullableNumber(row.entry_cost_usdc, "entry_cost_usdc"),
    entryFeesUsdc: nullableNumber(row.entry_fees_usdc, "entry_fees_usdc"),
    totalCostUsdc: nullableNumber(row.total_cost_usdc, "total_cost_usdc"),
    realizedPnl: nullableNumber(row.realized_pnl, "realized_pnl"),
    unrealizedPnl: nullableNumber(row.unrealized_pnl, "unrealized_pnl"),
  };
}

export type PolymarketDataApiV2HolderGroup = {
  tokenId: string;
  holders: Array<{ wallet: string; shares: number; outcomeIndex: number }>;
};

export type PolymarketDataApiV2Trade = {
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
  transactionHash: string | null;
};

export function parsePolymarketDataApiV2Trade(
  row: unknown,
): PolymarketDataApiV2Trade {
  if (!isRecord(row) || (row.side !== "BUY" && row.side !== "SELL"))
    throw new Error("Polymarket Data API V2 returned an invalid trade.");
  const price = requireQuantity(row.price, "price");
  const timestamp = requireQuantity(row.timestamp, "timestamp");
  if (
    price > 1 ||
    !Number.isSafeInteger(timestamp) ||
    timestamp > 8_640_000_000_000
  )
    throw new Error(
      "Polymarket Data API V2 returned an invalid trade price/time.",
    );
  return {
    tokenId: requireAssetId(row),
    side: row.side,
    price,
    size: requireQuantity(row.size, "size"),
    timestamp,
    transactionHash:
      row.transaction_hash == null
        ? null
        : requireString(row, "transaction_hash"),
  };
}

export function parsePolymarketDataApiV2HolderGroup(
  row: unknown,
): PolymarketDataApiV2HolderGroup {
  if (!isRecord(row) || !Array.isArray(row.holders)) {
    throw new Error("Polymarket Data API V2 returned an invalid holder group.");
  }
  const tokenId = requireAssetId(row);
  return {
    tokenId,
    holders: row.holders.map((holder) => {
      if (
        !isRecord(holder) ||
        (holder.token_id != null && requireAssetId(holder) !== tokenId)
      ) {
        throw new Error(
          "Polymarket Data API V2 holder does not match its asset group.",
        );
      }
      return {
        wallet: requireString(holder, "proxy_wallet"),
        shares: requireQuantity(holder.amount, "amount"),
        outcomeIndex: requireOutcomeIndex(holder.outcome_index),
      };
    }),
  };
}

export function polymarketDataApiV2PositionParams(
  owner: string,
): Record<string, string> {
  return {
    user: owner,
    status: "OPEN",
    filter_amount: "0",
    include_archived: "true",
    limit: "500",
  };
}

export function polymarketDataApiV2HolderParams(
  conditionId: string,
  limit: number,
): Record<string, string> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error(
      "Polymarket gross holder page limit must be between 1 and 100.",
    );
  }
  return {
    condition: conditionId,
    limit: String(limit),
    min_balance: "1",
    include_pnl: "true", // Preserve Hunch's per-side GROSS rather than default NET.
  };
}
