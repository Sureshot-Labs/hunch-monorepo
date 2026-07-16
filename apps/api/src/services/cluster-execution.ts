import type { ClusterMarketSummary } from "./clusters.js";
import { resolveExplicitMarketOutcomeMapping } from "./clusters.js";

export const CLUSTER_EXECUTION_QUOTE_MAX_AGE_MS = 10 * 60_000;

export type ClusterNativeOutcome = "NO" | "YES";

export type ClusterNativeTop = {
  ask: number | null;
  bid: number | null;
  asOf: string | null;
};

export type ClusterMarketNativeQuotes = {
  active: boolean;
  marketId: string;
  no: ClusterNativeTop;
  orderable: boolean;
  venue: string;
  yes: ClusterNativeTop;
};

export type ClusterMarketExecutionOffer = {
  ask: number;
  asOf: string;
  fresh: boolean;
  nativeOutcome: ClusterNativeOutcome;
};

export type ClusterMarketExecutionOffers = {
  no: ClusterMarketExecutionOffer | null;
  yes: ClusterMarketExecutionOffer | null;
};

export type ClusterExecutionOffer = {
  ask: number;
  asOf: string;
  marketId: string;
  nativeOutcome: ClusterNativeOutcome;
  venue: string;
};

export type ClusterExecutionVerification = {
  netEdge: number | null;
  shares: number | null;
  status: "not_candidate" | "rejected" | "unavailable" | "verified";
  totalCost: number | null;
  totalFees: number | null;
  verifiedAt: string | null;
};

export type ClusterExecutionSummary = {
  bestNoOffer: ClusterExecutionOffer | null;
  bestYesOffer: ClusterExecutionOffer | null;
  bundleCost: number | null;
  grossEdge: number | null;
  kind: "comparison" | "live_arbitrage" | "quotes_unavailable";
  midpointGap: number | null;
  quotesFresh: boolean;
  verification: ClusterExecutionVerification;
};

export type ClusterExecutionMarket = ClusterMarketSummary & {
  executionOffers?: ClusterMarketExecutionOffers | null;
};

type ClusterLike = {
  id: string;
  markets: ClusterExecutionMarket[];
  priceSpread: number | null;
  seedMarketId: string | null;
  totalLiquidity?: number | null;
  volume24h?: number | null;
};

type CanonicalOffer = ClusterExecutionOffer & {
  canonicalSide: ClusterNativeOutcome;
};

export function resolveNativeOutcomeForCanonicalSide(
  sourceYesTo: "NO" | "YES",
  canonicalSide: ClusterNativeOutcome,
): ClusterNativeOutcome {
  if (sourceYesTo === "YES") return canonicalSide;
  return canonicalSide === "YES" ? "NO" : "YES";
}

function finiteProbability(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0 || value >= 1) {
    return null;
  }
  return value;
}

function parseAsOf(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFreshAsOf(
  value: string | null,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  const parsed = parseAsOf(value);
  return (
    parsed != null && parsed <= nowMs + 5_000 && nowMs - parsed <= maxAgeMs
  );
}

export function resolveStrictClusterNativeOffer(input: {
  nativeOutcome: ClusterNativeOutcome;
  nowMs: number;
  maxAgeMs: number;
  top: ClusterNativeTop;
}): ClusterMarketExecutionOffer | null {
  const ask = finiteProbability(input.top.ask);
  if (ask == null || !input.top.asOf) return null;
  const bid = finiteProbability(input.top.bid);
  if (bid != null && bid > ask) return null;
  return {
    ask,
    asOf: input.top.asOf,
    fresh: isFreshAsOf(input.top.asOf, input.nowMs, input.maxAgeMs),
    nativeOutcome: input.nativeOutcome,
  };
}

function emptyVerification(
  status: ClusterExecutionVerification["status"],
): ClusterExecutionVerification {
  return {
    netEdge: null,
    shares: null,
    status,
    totalCost: null,
    totalFees: null,
    verifiedAt: null,
  };
}

function toExecutionOffer(input: {
  canonicalSide: ClusterNativeOutcome;
  market: ClusterMarketSummary;
  offer: ClusterMarketExecutionOffer;
}): CanonicalOffer {
  return {
    ask: input.offer.ask,
    asOf: input.offer.asOf,
    canonicalSide: input.canonicalSide,
    marketId: input.market.marketId,
    nativeOutcome: input.offer.nativeOutcome,
    venue: input.market.venue,
  };
}

function compareOffer(
  left: ClusterExecutionOffer,
  right: ClusterExecutionOffer,
) {
  if (left.ask !== right.ask) return left.ask - right.ask;
  const asOfDiff = Date.parse(right.asOf) - Date.parse(left.asOf);
  if (asOfDiff !== 0) return asOfDiff;
  return `${left.venue}:${left.marketId}`.localeCompare(
    `${right.venue}:${right.marketId}`,
  );
}

function bestCrossVenuePair(offers: CanonicalOffer[]): {
  no: ClusterExecutionOffer;
  yes: ClusterExecutionOffer;
} | null {
  const yes = offers.filter((offer) => offer.canonicalSide === "YES");
  const no = offers.filter((offer) => offer.canonicalSide === "NO");
  const pairs = yes.flatMap((yesOffer) =>
    no
      .filter((noOffer) => noOffer.venue !== yesOffer.venue)
      .map((noOffer) => ({
        cost: yesOffer.ask + noOffer.ask,
        no: noOffer,
        yes: yesOffer,
      })),
  );
  const best = pairs.sort((left, right) => {
    if (left.cost !== right.cost) return left.cost - right.cost;
    const yesDiff = compareOffer(left.yes, right.yes);
    return yesDiff !== 0 ? yesDiff : compareOffer(left.no, right.no);
  })[0];
  return best ? { no: best.no, yes: best.yes } : null;
}

export function buildClusterExecution(input: {
  cluster: ClusterLike;
  maxAgeMs?: number;
  nativeQuotesByMarketId: ReadonlyMap<string, ClusterMarketNativeQuotes>;
  now?: Date;
}): {
  execution: ClusterExecutionSummary;
  markets: ClusterExecutionMarket[];
} {
  const nowMs = (input.now ?? new Date()).getTime();
  const maxAgeMs = Math.max(
    0,
    Math.trunc(input.maxAgeMs ?? CLUSTER_EXECUTION_QUOTE_MAX_AGE_MS),
  );
  const seed =
    input.cluster.markets.find(
      (market) => market.marketId === input.cluster.seedMarketId,
    ) ?? input.cluster.markets[0];
  if (!seed) {
    return {
      markets: input.cluster.markets,
      execution: {
        bestNoOffer: null,
        bestYesOffer: null,
        bundleCost: null,
        grossEdge: null,
        kind: "quotes_unavailable",
        midpointGap: input.cluster.priceSpread,
        quotesFresh: false,
        verification: emptyVerification("not_candidate"),
      },
    };
  }

  const canonicalOffers: CanonicalOffer[] = [];
  const markets = input.cluster.markets.map((market) => {
    const mapping = resolveExplicitMarketOutcomeMapping(seed, market);
    const native = input.nativeQuotesByMarketId.get(market.marketId);
    if (!mapping || !native || !native.active || !native.orderable) {
      return { ...market, outcomeMapping: mapping, executionOffers: null };
    }

    const yesNative = resolveStrictClusterNativeOffer({
      nativeOutcome: "YES",
      nowMs,
      maxAgeMs,
      top: native.yes,
    });
    const noNative = resolveStrictClusterNativeOffer({
      nativeOutcome: "NO",
      nowMs,
      maxAgeMs,
      top: native.no,
    });
    const canonicalYes =
      resolveNativeOutcomeForCanonicalSide(mapping.sourceYesTo, "YES") === "YES"
        ? yesNative
        : noNative;
    const canonicalNo =
      resolveNativeOutcomeForCanonicalSide(mapping.sourceYesTo, "NO") === "YES"
        ? yesNative
        : noNative;
    const executionOffers: ClusterMarketExecutionOffers = {
      no: canonicalNo,
      yes: canonicalYes,
    };

    if (canonicalYes?.fresh) {
      canonicalOffers.push(
        toExecutionOffer({
          canonicalSide: "YES",
          market,
          offer: canonicalYes,
        }),
      );
    }
    if (canonicalNo?.fresh) {
      canonicalOffers.push(
        toExecutionOffer({
          canonicalSide: "NO",
          market,
          offer: canonicalNo,
        }),
      );
    }
    return {
      ...market,
      active: native.active,
      orderable: native.orderable,
      outcomeMapping: mapping,
      executionOffers,
    };
  });

  const pair = bestCrossVenuePair(canonicalOffers);
  if (!pair) {
    return {
      markets,
      execution: {
        bestNoOffer: null,
        bestYesOffer: null,
        bundleCost: null,
        grossEdge: null,
        kind: "quotes_unavailable",
        midpointGap: input.cluster.priceSpread,
        quotesFresh: false,
        verification: emptyVerification("not_candidate"),
      },
    };
  }

  const bundleCost = pair.yes.ask + pair.no.ask;
  const grossEdge = 1 - bundleCost;
  return {
    markets,
    execution: {
      bestNoOffer: pair.no,
      bestYesOffer: pair.yes,
      bundleCost,
      grossEdge,
      kind: "comparison",
      midpointGap: input.cluster.priceSpread,
      quotesFresh: true,
      verification: emptyVerification(
        grossEdge > 0 ? "unavailable" : "not_candidate",
      ),
    },
  };
}

export function applyClusterExecutionVerification(
  execution: ClusterExecutionSummary,
  verification: ClusterExecutionVerification,
): ClusterExecutionSummary {
  return {
    ...execution,
    kind:
      verification.status === "verified" &&
      verification.netEdge != null &&
      verification.netEdge > 0
        ? "live_arbitrage"
        : execution.quotesFresh
          ? "comparison"
          : "quotes_unavailable",
    verification,
  };
}

export function compareClusterExecution<
  T extends ClusterLike & {
    execution?: ClusterExecutionSummary | null;
  },
>(left: T, right: T): number {
  const leftExecution = left.execution;
  const rightExecution = right.execution;
  const leftRank =
    leftExecution?.kind === "live_arbitrage"
      ? 0
      : leftExecution?.quotesFresh
        ? 1
        : leftExecution?.kind === "comparison"
          ? 2
          : 3;
  const rightRank =
    rightExecution?.kind === "live_arbitrage"
      ? 0
      : rightExecution?.quotesFresh
        ? 1
        : rightExecution?.kind === "comparison"
          ? 2
          : 3;
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (leftRank === 0) {
    const edgeDiff =
      (rightExecution?.verification.netEdge ?? Number.NEGATIVE_INFINITY) -
      (leftExecution?.verification.netEdge ?? Number.NEGATIVE_INFINITY);
    if (edgeDiff !== 0) return edgeDiff;
  }
  if (leftRank === 1) {
    const edgeDiff =
      (rightExecution?.grossEdge ?? Number.NEGATIVE_INFINITY) -
      (leftExecution?.grossEdge ?? Number.NEGATIVE_INFINITY);
    if (edgeDiff !== 0) return edgeDiff;
  }
  const volumeDiff = (right.volume24h ?? 0) - (left.volume24h ?? 0);
  if (volumeDiff !== 0) return volumeDiff;
  const liquidityDiff =
    (right.totalLiquidity ?? 0) - (left.totalLiquidity ?? 0);
  if (liquidityDiff !== 0) return liquidityDiff;
  return left.id.localeCompare(right.id);
}
