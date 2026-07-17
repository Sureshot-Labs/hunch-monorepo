export type CanonicalMarketSide = "YES" | "NO";

export type CanonicalMarketTopBlocker =
  | "missing_ask"
  | "missing_bid"
  | "stale"
  | "crossed_book"
  | "no_book"
  | "inconsistent_probability";

export type CanonicalMarketTopInput = {
  yesTop?: CanonicalSideTopInput | null;
  noTop?: CanonicalSideTopInput | null;
  now?: Date | number;
  maxAgeMs?: number;
  probabilityConsistencyTolerance?: number;
};

export type CanonicalSideTopInput = {
  bestAsk?: unknown;
  bestBid?: unknown;
  ts?: Date | string | number | null;
};

export type CanonicalMarketTop = {
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  topAsOf: Record<CanonicalMarketSide, string | null>;
  probability: number | null;
  blockers: CanonicalMarketTopBlocker[];
};

export const DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_PROBABILITY_CONSISTENCY_TOLERANCE = 0.02;

type NormalizedSideTop = {
  asOf: string | null;
  ask: number | null;
  bid: number | null;
  crossed: boolean;
  fresh: boolean;
  stale: boolean;
};

type NormalizedObservedSideTop = {
  asOf: string | null;
  ask: number | null;
  bid: number | null;
  crossed: boolean;
};

function finiteProbability(value: unknown): number | null {
  if (value == null) return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function timestampMs(value: CanonicalSideTopInput["ts"]): number | null {
  if (value instanceof Date) {
    const parsed = value.getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 1_000_000_000_000 ? value : value * 1000;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSideTop(
  input: CanonicalSideTopInput | null | undefined,
  nowMs: number,
  maxAgeMs: number,
): NormalizedSideTop {
  const bid = finiteProbability(input?.bestBid);
  const ask = finiteProbability(input?.bestAsk);
  const tsMs = timestampMs(input?.ts);
  const asOf = tsMs == null ? null : new Date(tsMs).toISOString();
  const hasQuote = bid != null || ask != null;
  const stale =
    hasQuote && (tsMs == null || tsMs > nowMs || nowMs - tsMs > maxAgeMs);
  const crossed = bid != null && ask != null && bid > ask;
  const fresh = hasQuote && !stale && !crossed;
  return {
    asOf,
    ask: fresh ? ask : null,
    bid: fresh ? bid : null,
    crossed,
    fresh,
    stale,
  };
}

function midpoint(top: NormalizedSideTop): number | null {
  return top.bid != null && top.ask != null ? (top.bid + top.ask) / 2 : null;
}

function normalizeObservedSideTop(
  input: CanonicalSideTopInput | null | undefined,
): NormalizedObservedSideTop {
  const bid = finiteProbability(input?.bestBid);
  const ask = finiteProbability(input?.bestAsk);
  const tsMs = timestampMs(input?.ts);
  const crossed = bid != null && ask != null && bid > ask;
  return {
    asOf: tsMs == null ? null : new Date(tsMs).toISOString(),
    ask: crossed ? null : ask,
    bid: crossed ? null : bid,
    crossed,
  };
}

function observedMidpoint(top: NormalizedObservedSideTop): number | null {
  return top.bid != null && top.ask != null ? (top.bid + top.ask) / 2 : null;
}

/**
 * Builds a presentation-only snapshot from the latest observed canonical
 * token tops. Unlike buildCanonicalMarketTop, quote age does not erase a
 * coherent book: execution callers must continue to use the strict helper.
 */
export function buildObservedCanonicalMarketTop(
  input: Omit<CanonicalMarketTopInput, "now" | "maxAgeMs">,
): CanonicalMarketTop {
  const tolerance =
    typeof input.probabilityConsistencyTolerance === "number" &&
    Number.isFinite(input.probabilityConsistencyTolerance)
      ? Math.max(0, input.probabilityConsistencyTolerance)
      : DEFAULT_PROBABILITY_CONSISTENCY_TOLERANCE;
  const yes = normalizeObservedSideTop(input.yesTop);
  const no = normalizeObservedSideTop(input.noTop);
  const blockers: CanonicalMarketTopBlocker[] = [];

  if (yes.crossed || no.crossed) blockers.push("crossed_book");
  if (yes.bid == null && yes.ask == null && no.bid == null && no.ask == null) {
    blockers.push("no_book");
  }
  if (yes.bid == null || no.bid == null) blockers.push("missing_bid");
  if (yes.ask == null || no.ask == null) blockers.push("missing_ask");

  const yesMid = observedMidpoint(yes);
  const noMid = observedMidpoint(no);
  const yesFromNo = noMid == null ? null : 1 - noMid;
  let probability = yesMid ?? yesFromNo;
  if (yes.crossed || no.crossed) {
    probability = null;
  } else if (
    yesMid != null &&
    yesFromNo != null &&
    Math.abs(yesMid - yesFromNo) > tolerance
  ) {
    probability = null;
    blockers.push("inconsistent_probability");
  }

  return {
    yesBid: yes.bid,
    yesAsk: yes.ask,
    noBid: no.bid,
    noAsk: no.ask,
    topAsOf: { YES: yes.asOf, NO: no.asOf },
    probability,
    blockers: Array.from(new Set(blockers)),
  };
}

export function buildCanonicalMarketTop(
  input: CanonicalMarketTopInput,
): CanonicalMarketTop {
  const nowMs =
    input.now instanceof Date
      ? input.now.getTime()
      : typeof input.now === "number" && Number.isFinite(input.now)
        ? input.now
        : Date.now();
  const maxAgeMs =
    typeof input.maxAgeMs === "number" && Number.isFinite(input.maxAgeMs)
      ? Math.max(0, input.maxAgeMs)
      : DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS;
  const tolerance =
    typeof input.probabilityConsistencyTolerance === "number" &&
    Number.isFinite(input.probabilityConsistencyTolerance)
      ? Math.max(0, input.probabilityConsistencyTolerance)
      : DEFAULT_PROBABILITY_CONSISTENCY_TOLERANCE;

  const yes = normalizeSideTop(input.yesTop, nowMs, maxAgeMs);
  const no = normalizeSideTop(input.noTop, nowMs, maxAgeMs);
  const blockers: CanonicalMarketTopBlocker[] = [];

  if (yes.stale || no.stale) blockers.push("stale");
  if (yes.crossed || no.crossed) blockers.push("crossed_book");
  if (!yes.fresh && !no.fresh) blockers.push("no_book");
  if (yes.bid == null || no.bid == null) blockers.push("missing_bid");
  if (yes.ask == null || no.ask == null) blockers.push("missing_ask");

  const yesMid = midpoint(yes);
  const noMid = midpoint(no);
  const yesFromNo = noMid == null ? null : 1 - noMid;
  let probability = yesMid ?? yesFromNo;
  if (yes.crossed || no.crossed) {
    probability = null;
  } else if (
    yesMid != null &&
    yesFromNo != null &&
    Math.abs(yesMid - yesFromNo) > tolerance
  ) {
    probability = null;
    blockers.push("inconsistent_probability");
  }

  return {
    yesBid: yes.bid,
    yesAsk: yes.ask,
    noBid: no.bid,
    noAsk: no.ask,
    topAsOf: { YES: yes.asOf, NO: no.asOf },
    probability,
    blockers: Array.from(new Set(blockers)),
  };
}
