import { normalizePolymarketAssetId, parseRetryAfterMs } from "@hunch/shared";

import { isRecord } from "../lib/type-guards.js";

export type PolymarketDataApiPage<T> = {
  data: T[];
  nextCursor: string | null;
};

export class PolymarketDataApiV2Error extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly retryable: boolean,
    public readonly traceId: string | null,
    public readonly retryAfterMs: number | null,
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
  endpoint: "positions" | "holders" | "trades" | "prices-history";
  params: Readonly<Record<string, string>>;
  parseRow: (row: unknown) => T;
  timeoutMs: number;
  cursor?: string | null;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
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
  const response = await (inputs.fetchImpl ?? fetch)(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const error = isRecord(payload) ? payload : {};
    throw new PolymarketDataApiV2Error(
      response.status,
      typeof error.code === "string" ? error.code : null,
      typeof error.retryable === "boolean"
        ? error.retryable
        : response.status === 429 || response.status >= 500,
      typeof error.trace_id === "string" ? error.trace_id : null,
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
  }
  const page = parsePolymarketDataApiV2Page(
    await response.json(),
    inputs.parseRow,
  );
  signal.throwIfAborted();
  if (inputs.cursor != null && page.nextCursor === inputs.cursor)
    throw new Error("Polymarket Data API V2 repeated a pagination cursor.");
  return page;
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
  const fetchImpl = inputs.fetchImpl ?? fetch;
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
          fetchImpl,
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
