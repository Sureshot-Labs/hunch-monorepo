import {
  buildCanonicalMarketTop,
  DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS,
} from "./canonical-market-top.js";

export type MarketPriceSide = "YES" | "NO";

export type MarketPriceBlocker =
  | "buy_price_too_high"
  | "invalid_spread"
  | "live_price_stale"
  | "missing_side_price"
  | "no_book"
  | "terminal_price";

export type PriceTopInput = {
  bestBid?: unknown;
  bestAsk?: unknown;
  ts?: Date | string | null;
};

export type MarketPriceStateInput = {
  marketBestBid?: unknown;
  marketBestAsk?: unknown;
  lastPrice?: unknown;
  yesTop?: PriceTopInput | null;
  noTop?: PriceTopInput | null;
  maxBuyPrice?: number;
  terminalPp?: number;
  maxAgeMs?: number;
  now?: Date | number;
};

export type MarketSidePriceState = {
  ask: number | null;
  bid: number | null;
  buyPrice: number | null;
  blockers: MarketPriceBlocker[];
};

export type MarketPriceState = {
  blockers: MarketPriceBlocker[];
  hasBook: boolean;
  invalidSpread: boolean;
  maxBuyPrice: number;
  no: MarketSidePriceState;
  terminalLike: boolean;
  terminalPp: number;
  yes: MarketSidePriceState;
  yesProbability: number | null;
};

function unique<T extends string>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function normalizePriceValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? clampProbability(value) : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? clampProbability(parsed) : null;
}

export function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampProbability(value);
}

function hasInvalidSpread(bid: number | null, ask: number | null): boolean {
  return bid != null && ask != null && bid > ask;
}

export function buildMarketPriceState(
  input: MarketPriceStateInput,
): MarketPriceState {
  const maxBuyPrice = normalizeThreshold(input.maxBuyPrice, 0.95);
  const terminalPp = normalizeThreshold(input.terminalPp, 0.01);
  const canonical = buildCanonicalMarketTop({
    yesTop: input.yesTop,
    noTop: input.noTop,
    now: input.now,
    maxAgeMs: input.maxAgeMs ?? DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS,
  });
  const yesBid = canonical.yesBid;
  const yesAsk = canonical.yesAsk;
  const noBid = canonical.noBid;
  const noAsk = canonical.noAsk;

  const invalidSpread =
    hasInvalidSpread(yesBid, yesAsk) || hasInvalidSpread(noBid, noAsk);
  const hasBook =
    yesBid != null || yesAsk != null || noBid != null || noAsk != null;
  const yesProbability = canonical.probability;
  const terminalLike =
    yesProbability != null &&
    (yesProbability <= terminalPp || yesProbability >= 1 - terminalPp);

  const sideBlockers = (buyPrice: number | null): MarketPriceBlocker[] => {
    const blockers: MarketPriceBlocker[] = [];
    if (!hasBook) blockers.push("no_book");
    if (invalidSpread) blockers.push("invalid_spread");
    if (canonical.blockers.includes("stale")) {
      blockers.push("live_price_stale");
    }
    if (terminalLike) blockers.push("terminal_price");
    if (buyPrice == null) blockers.push("missing_side_price");
    if (buyPrice != null && buyPrice >= maxBuyPrice) {
      blockers.push("buy_price_too_high");
    }
    return unique(blockers);
  };

  const yes: MarketSidePriceState = {
    ask: yesAsk,
    bid: yesBid,
    buyPrice: yesAsk,
    blockers: sideBlockers(yesAsk),
  };
  const no: MarketSidePriceState = {
    ask: noAsk,
    bid: noBid,
    buyPrice: noAsk,
    blockers: sideBlockers(noAsk),
  };

  return {
    blockers: unique([...yes.blockers, ...no.blockers]),
    hasBook,
    invalidSpread,
    maxBuyPrice,
    no,
    terminalLike,
    terminalPp,
    yes,
    yesProbability,
  };
}

export function getMarketPriceSideState(
  state: MarketPriceState,
  side: MarketPriceSide,
): MarketSidePriceState {
  return side === "YES" ? state.yes : state.no;
}
