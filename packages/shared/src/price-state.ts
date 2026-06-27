export type MarketPriceSide = "YES" | "NO";

export type MarketPriceBlocker =
  | "buy_price_too_high"
  | "invalid_spread"
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

function inverted(value: number | null): number | null {
  return value == null ? null : clampProbability(1 - value);
}

function mid(bid: number | null, ask: number | null): number | null {
  return bid != null && ask != null ? clampProbability((bid + ask) / 2) : null;
}

function fallbackProbability(
  bid: number | null,
  ask: number | null,
): number | null {
  if (bid != null && ask != null) return mid(bid, ask);
  if (bid != null) return bid;
  if (ask != null) return ask;
  return null;
}

function hasInvalidSpread(bid: number | null, ask: number | null): boolean {
  return bid != null && ask != null && bid > ask;
}

export function buildMarketPriceState(
  input: MarketPriceStateInput,
): MarketPriceState {
  const maxBuyPrice = normalizeThreshold(input.maxBuyPrice, 0.95);
  const terminalPp = normalizeThreshold(input.terminalPp, 0.01);
  const marketBid = normalizePriceValue(input.marketBestBid);
  const marketAsk = normalizePriceValue(input.marketBestAsk);
  const lastPrice = normalizePriceValue(input.lastPrice);

  const yesBid = normalizePriceValue(input.yesTop?.bestBid) ?? marketBid;
  const yesAsk = normalizePriceValue(input.yesTop?.bestAsk) ?? marketAsk;
  const noBid = normalizePriceValue(input.noTop?.bestBid) ?? inverted(marketAsk);
  const noAsk = normalizePriceValue(input.noTop?.bestAsk) ?? inverted(marketBid);

  const invalidSpread =
    hasInvalidSpread(yesBid, yesAsk) || hasInvalidSpread(noBid, noAsk);
  const hasBook =
    yesBid != null || yesAsk != null || noBid != null || noAsk != null;
  const yesProbability =
    mid(yesBid, yesAsk) ??
    (mid(noBid, noAsk) != null ? inverted(mid(noBid, noAsk)) : null) ??
    fallbackProbability(yesBid, yesAsk) ??
    (fallbackProbability(noBid, noAsk) != null
      ? inverted(fallbackProbability(noBid, noAsk))
      : null) ??
    lastPrice;
  const terminalLike =
    yesProbability != null &&
    (yesProbability <= terminalPp || yesProbability >= 1 - terminalPp);

  const sideBlockers = (buyPrice: number | null): MarketPriceBlocker[] => {
    const blockers: MarketPriceBlocker[] = [];
    if (!hasBook) blockers.push("no_book");
    if (invalidSpread) blockers.push("invalid_spread");
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
