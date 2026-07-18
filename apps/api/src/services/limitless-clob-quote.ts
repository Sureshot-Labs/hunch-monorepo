import {
  parseLimitlessClobBook,
  quoteLimitlessClobDepth,
  type LimitlessClobSide,
} from "./limitless-clob-book.js";
import { limitlessRequest } from "./limitless-client.js";

const QUOTE_CACHE_TTL_MS = 2_000;
const QUOTE_EXPIRY_MS = 5_000;
const QUOTE_TIMEOUT_MS = 3_000;
const QUOTE_CACHE_MAX_ENTRIES = 500;

export type LimitlessClobQuoteResult =
  | {
      status: "ready";
      tokenId: string;
      side: LimitlessClobSide;
      asOf: string;
      expiresAt: string;
      averagePrice: number;
      worstPrice: number;
      executableShares: number;
      availableShares: number;
      minOrderNotionalUsd: number;
    }
  | {
      status: "insufficient_depth" | "no_liquidity" | "unavailable";
      asOf: string | null;
    };

export type LimitlessClobQuoteInput = {
  amountShares?: number | null;
  amountUsd?: number | null;
  now?: Date;
  side: LimitlessClobSide;
  slug: string;
  tokenId: string;
};

export function isLimitlessClobDefinitiveNoFill(
  status: LimitlessClobQuoteResult["status"],
): status is "insufficient_depth" | "no_liquidity" {
  return status === "insufficient_depth" || status === "no_liquidity";
}

type QuoteCacheEntry = {
  expiresAt: number;
  promise: Promise<LimitlessClobQuoteResult>;
};

export type LimitlessClobOrderbookRequest = (input: {
  allowRetry: false;
  method: "GET";
  requestPath: string;
  timeoutMs: number;
}) => Promise<{ ok: boolean; payload: unknown }>;

const quoteCache = new Map<string, QuoteCacheEntry>();

function quoteCacheKey(input: LimitlessClobQuoteInput): string {
  return [
    input.slug.trim(),
    input.tokenId.trim(),
    input.side,
    input.amountUsd ?? "",
    input.amountShares ?? "",
  ].join("|");
}

function pruneQuoteCache(nowMs: number): void {
  for (const [key, entry] of quoteCache) {
    if (entry.expiresAt <= nowMs) quoteCache.delete(key);
  }
  while (quoteCache.size >= QUOTE_CACHE_MAX_ENTRIES) {
    const oldest = quoteCache.keys().next().value;
    if (typeof oldest !== "string") break;
    quoteCache.delete(oldest);
  }
}

async function loadLimitlessClobQuote(
  input: LimitlessClobQuoteInput,
  requestOrderbook: LimitlessClobOrderbookRequest,
): Promise<LimitlessClobQuoteResult> {
  try {
    const response = await requestOrderbook({
      allowRetry: false,
      method: "GET",
      requestPath: `/markets/${encodeURIComponent(input.slug.trim())}/orderbook`,
      timeoutMs: QUOTE_TIMEOUT_MS,
    });
    if (!response.ok) return { status: "unavailable", asOf: null };

    const book = parseLimitlessClobBook(response.payload);
    if (!book) return { status: "unavailable", asOf: null };
    const observedAt = input.now ?? new Date();
    const asOf = observedAt.toISOString();
    const quote = quoteLimitlessClobDepth({
      amountShares: input.amountShares,
      amountUsd: input.amountUsd,
      book,
      side: input.side,
      tokenId: input.tokenId,
    });
    if (quote.status !== "ready") {
      return { status: quote.status, asOf };
    }
    return {
      status: "ready",
      tokenId: input.tokenId,
      side: input.side,
      asOf,
      expiresAt: new Date(observedAt.getTime() + QUOTE_EXPIRY_MS).toISOString(),
      averagePrice: quote.averagePrice,
      worstPrice: quote.worstPrice,
      executableShares: quote.executableShares,
      availableShares: quote.availableShares,
      minOrderNotionalUsd: quote.minOrderNotionalUsd,
    };
  } catch {
    return { status: "unavailable", asOf: null };
  }
}

export function quoteLimitlessClobMarket(
  input: LimitlessClobQuoteInput,
  dependencies: {
    requestOrderbook?: LimitlessClobOrderbookRequest;
  } = {},
): Promise<LimitlessClobQuoteResult> {
  if (dependencies.requestOrderbook) {
    return loadLimitlessClobQuote(input, dependencies.requestOrderbook);
  }
  const nowMs = (input.now ?? new Date()).getTime();
  const key = quoteCacheKey(input);
  const cached = quoteCache.get(key);
  if (cached && cached.expiresAt > nowMs) return cached.promise;

  pruneQuoteCache(nowMs);
  const promise = loadLimitlessClobQuote(input, limitlessRequest);
  quoteCache.set(key, { expiresAt: nowMs + QUOTE_CACHE_TTL_MS, promise });
  return promise;
}

export function clearLimitlessClobQuoteCacheForTests(): void {
  quoteCache.clear();
}
