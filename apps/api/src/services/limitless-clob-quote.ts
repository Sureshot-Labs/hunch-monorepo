import {
  parseLimitlessClobBook,
  quoteLimitlessClobDepth,
  type LimitlessClobSide,
} from "./limitless-clob-book.js";
import {
  loadLimitlessBook,
  clearLimitlessBookCache,
} from "./limitless-book.js";

const QUOTE_EXPIRY_MS = 5_000;
const QUOTE_TIMEOUT_MS = 3_000;

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
      totalNotional: number;
    }
  | {
      status: "insufficient_depth" | "no_liquidity" | "unavailable";
      asOf: string | null;
      minOrderNotionalUsd?: number;
      tokenId?: string;
      side?: LimitlessClobSide;
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

export type LimitlessClobOrderbookRequest = (input: {
  allowRetry: false;
  method: "GET";
  requestPath: string;
  timeoutMs: number;
}) => Promise<{ ok: boolean; payload: unknown }>;

async function loadLimitlessClobQuote(
  input: LimitlessClobQuoteInput,
  requestOrderbook?: LimitlessClobOrderbookRequest,
): Promise<LimitlessClobQuoteResult> {
  try {
    const snapshot = requestOrderbook
      ? null
      : await loadLimitlessBook(input.slug.trim());
    const response = requestOrderbook
      ? await requestOrderbook({
          allowRetry: false,
          method: "GET",
          requestPath: `/markets/${encodeURIComponent(input.slug.trim())}/orderbook`,
          timeoutMs: QUOTE_TIMEOUT_MS,
        })
      : { ok: true, payload: snapshot?.payload };
    if (!response.ok) return { status: "unavailable", asOf: null };

    const book = parseLimitlessClobBook(response.payload);
    if (!book) return { status: "unavailable", asOf: null };
    const observedAt = snapshot
      ? new Date(snapshot.observedAt)
      : (input.now ?? new Date());
    const expiresAt =
      snapshot?.expiresAt ??
      new Date(observedAt.getTime() + QUOTE_EXPIRY_MS).toISOString();
    if (snapshot && Date.parse(expiresAt) <= Date.now())
      return { status: "unavailable", asOf: observedAt.toISOString() };
    const asOf = observedAt.toISOString();
    const quote = quoteLimitlessClobDepth({
      amountShares: input.amountShares,
      amountUsd: input.amountUsd,
      book,
      side: input.side,
      tokenId: input.tokenId,
    });
    if (quote.status !== "ready") {
      // Resting limit orders still need the observed market minimum even when
      // immediate depth is insufficient. This does not make a market quote ready.
      return {
        status: quote.status,
        asOf,
        minOrderNotionalUsd: book.minOrderNotionalUsd,
        tokenId: input.tokenId,
        side: input.side,
      };
    }
    return {
      status: "ready",
      tokenId: input.tokenId,
      side: input.side,
      asOf,
      expiresAt,
      averagePrice: quote.averagePrice,
      worstPrice: quote.worstPrice,
      executableShares: quote.executableShares,
      availableShares: quote.availableShares,
      minOrderNotionalUsd: quote.minOrderNotionalUsd,
      totalNotional: quote.totalNotional,
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
  return loadLimitlessClobQuote(input);
}

export function clearLimitlessClobQuoteCacheForTests(): void {
  clearLimitlessBookCache();
}
