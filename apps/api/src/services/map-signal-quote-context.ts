import { buildObservedCanonicalMarketTop } from "@hunch/shared";

export type MarketSignalQuoteSide = {
  bid: number | null;
  ask: number | null;
  observedAt: string | null;
  status: "fresh" | "stale" | "missing" | "invalid";
};

export type MarketSignalQuoteContext = {
  capturedAt: string;
  yes: MarketSignalQuoteSide;
  no: MarketSignalQuoteSide;
};

const MAX_QUOTE_AGE_MS = 10 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

function sideContext(
  bid: number | null,
  ask: number | null,
  observedAt: string | null,
  nowMs: number,
): MarketSignalQuoteSide {
  if (bid == null || ask == null || !observedAt) {
    return { bid: null, ask: null, observedAt, status: "missing" };
  }
  const observedMs = Date.parse(observedAt);
  if (
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid < 0 ||
    ask > 1 ||
    bid > ask ||
    !Number.isFinite(observedMs) ||
    observedMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    return { bid: null, ask: null, observedAt, status: "invalid" };
  }
  if (nowMs - observedMs > MAX_QUOTE_AGE_MS) {
    return { bid: null, ask: null, observedAt, status: "stale" };
  }
  return { bid, ask, observedAt, status: "fresh" };
}

export function buildMarketSignalQuoteContext(
  quote: {
    yesBid: number | null;
    yesAsk: number | null;
    noBid: number | null;
    noAsk: number | null;
    topAsOf: { YES: string | null; NO: string | null };
  },
  now: Date = new Date(),
): MarketSignalQuoteContext {
  const nowMs = now.getTime();
  const yes = sideContext(quote.yesBid, quote.yesAsk, quote.topAsOf.YES, nowMs);
  const no = sideContext(quote.noBid, quote.noAsk, quote.topAsOf.NO, nowMs);
  if (yes.status === "fresh" && no.status === "fresh") {
    const canonical = buildObservedCanonicalMarketTop({
      yesTop: { bestBid: yes.bid, bestAsk: yes.ask, ts: yes.observedAt },
      noTop: { bestBid: no.bid, bestAsk: no.ask, ts: no.observedAt },
    });
    if (canonical.blockers.includes("inconsistent_probability")) {
      return {
        capturedAt: now.toISOString(),
        yes: { ...yes, bid: null, ask: null, status: "invalid" },
        no: { ...no, bid: null, ask: null, status: "invalid" },
      };
    }
  }
  return {
    capturedAt: now.toISOString(),
    yes,
    no,
  };
}
