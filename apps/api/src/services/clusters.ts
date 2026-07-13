type ClusterMarketRow = {
  id: string;
  event_id: string;
  venue: string;
  title: string | null;
  description?: string | null;
  slug?: string | null;
  image?: string | null;
  icon?: string | null;
  market_category?: string | null;
  market_type: string | null;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
  volume_24h: unknown;
  activity_volume_last_24h?: unknown;
  activity_volume_valid?: unknown;
  volume_total: unknown;
  liquidity: unknown;
  open_interest: unknown;
  close_time: unknown;
  expiration_time: unknown;
  event_title: string | null;
  event_description?: string | null;
  event_slug?: string | null;
  event_image?: string | null;
  event_icon?: string | null;
  event_category?: string | null;
};

export type ClusterMarketSummary = {
  marketId: string;
  eventId: string;
  venue: string;
  source?: "hunch" | "agg";
  pricingSource?: "hunch_db" | "agg_midpoint" | "agg_orderbook";
  aggVenueMarketId?: string | null;
  aggVenueEventId?: string | null;
  matchMethod?: string | null;
  outcomeMapping?: {
    confidence: number;
    method: "exact_title" | "selected_participant" | "source_identity";
    sourceYesTo: "NO" | "YES";
  } | null;
  active?: boolean;
  orderable?: boolean;
  priceAsOf?: string | null;
  marketSlug: string | null;
  eventSlug: string | null;
  marketImage: string | null;
  marketIcon: string | null;
  eventImage: string | null;
  eventIcon: string | null;
  image: string | null;
  icon: string | null;
  marketTitle: string | null;
  marketDescription: string | null;
  eventTitle: string | null;
  eventDescription: string | null;
  marketCategory: string | null;
  eventCategory: string | null;
  marketType: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  yesMid: number | null;
  noMid: number | null;
  liquidity: number | null;
  volume24h: number | null;
  volumeTotal: number | null;
  openInterest: number | null;
  expiresAt: string | null;
};

type ClusterMetrics = {
  venueCounts: Record<string, number>;
  venueCount: number;
  priceSpread: number | null;
  minLiquidity: number | null;
  totalLiquidity: number | null;
  volume24h: number | null;
  expiresAt: string | null;
};

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type ParticipantGroup = {
  tokens: Set<string>;
};

function normalizeComparableText(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/['’]/g, "").trim();
}

function tokenizeComparableText(value: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  const matches = normalizeComparableText(value).match(/[a-z0-9]+/g) ?? [];
  for (const token of matches) {
    if (token.length < 2) continue;
    if (
      token === "vs" ||
      token === "versus" ||
      token === "match" ||
      token === "winner" ||
      token === "miami" ||
      token === "open"
    ) {
      continue;
    }
    tokens.add(token);
  }
  return tokens;
}

function extractMatchParticipantGroups(
  value: string | null | undefined,
): ParticipantGroup[] {
  if (!value) return [];
  const parts = value
    .replace(/[–—]/g, " vs ")
    .split(/\b(?:vs\.?|versus)\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length !== 2) return [];
  return parts
    .map((part) => ({ tokens: tokenizeComparableText(part) }))
    .filter((group) => group.tokens.size > 0);
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) {
    if (b.has(token)) count += 1;
  }
  return count;
}

function inferSelectedParticipant(
  market: ClusterMarketSummary,
): ParticipantGroup | null {
  const participants = extractMatchParticipantGroups(
    market.eventTitle ?? market.marketTitle,
  );
  if (participants.length !== 2) return null;

  const titleTokens = tokenizeComparableText(market.marketTitle);
  if (titleTokens.size > 0) {
    const leftOverlap = intersectionSize(titleTokens, participants[0].tokens);
    const rightOverlap = intersectionSize(titleTokens, participants[1].tokens);
    if (leftOverlap > 0 && rightOverlap === 0) return participants[0];
    if (rightOverlap > 0 && leftOverlap === 0) return participants[1];
  }

  const normalizedTitle = normalizeComparableText(market.marketTitle);
  const normalizedEvent = normalizeComparableText(market.eventTitle);
  if (normalizedTitle.length > 0 && normalizedTitle === normalizedEvent) {
    return participants[0];
  }

  return null;
}

export function hasSameInferredSelectedParticipant(
  left: ClusterMarketSummary,
  right: ClusterMarketSummary,
): boolean {
  const leftSelected = inferSelectedParticipant(left);
  const rightSelected = inferSelectedParticipant(right);
  if (!leftSelected || !rightSelected) return true;
  return intersectionSize(leftSelected.tokens, rightSelected.tokens) > 0;
}

function haveEquivalentParticipantUniverse(
  left: ClusterMarketSummary,
  right: ClusterMarketSummary,
): boolean {
  const leftParticipants = extractMatchParticipantGroups(
    left.eventTitle ?? left.marketTitle,
  );
  const rightParticipants = extractMatchParticipantGroups(
    right.eventTitle ?? right.marketTitle,
  );
  if (leftParticipants.length !== 2 || rightParticipants.length !== 2) {
    return false;
  }
  const sameOrder =
    intersectionSize(leftParticipants[0].tokens, rightParticipants[0].tokens) >
      0 &&
    intersectionSize(leftParticipants[1].tokens, rightParticipants[1].tokens) >
      0;
  const reverseOrder =
    intersectionSize(leftParticipants[0].tokens, rightParticipants[1].tokens) >
      0 &&
    intersectionSize(leftParticipants[1].tokens, rightParticipants[0].tokens) >
      0;
  return sameOrder || reverseOrder;
}

export function resolveExplicitMarketOutcomeMapping(
  source: ClusterMarketSummary,
  target: ClusterMarketSummary,
): NonNullable<ClusterMarketSummary["outcomeMapping"]> | null {
  if (source.marketId === target.marketId) {
    return { confidence: 1, method: "source_identity", sourceYesTo: "YES" };
  }

  const sourceTitle = normalizeComparableText(source.marketTitle);
  const targetTitle = normalizeComparableText(target.marketTitle);
  if (sourceTitle && sourceTitle === targetTitle) {
    return { confidence: 1, method: "exact_title", sourceYesTo: "YES" };
  }

  if (!haveEquivalentParticipantUniverse(source, target)) return null;
  const sourceSelected = inferSelectedParticipant(source);
  const targetSelected = inferSelectedParticipant(target);
  if (!sourceSelected || !targetSelected) return null;
  return {
    confidence: 0.98,
    method: "selected_participant",
    sourceYesTo:
      intersectionSize(sourceSelected.tokens, targetSelected.tokens) > 0
        ? "YES"
        : "NO",
  };
}

function resolveComparablePrice(
  market: ClusterMarketSummary,
  canonicalSelection: ParticipantGroup | null,
): number | null {
  if (market.yesMid == null) return null;
  if (!canonicalSelection) return market.yesMid;

  const selected = inferSelectedParticipant(market);
  if (!selected) return market.yesMid;
  if (intersectionSize(selected.tokens, canonicalSelection.tokens) > 0) {
    return market.yesMid;
  }
  return market.noMid ?? market.yesMid;
}

function resolveCanonicalSelection(
  markets: ClusterMarketSummary[],
): ParticipantGroup | null {
  const inferred = markets
    .map(inferSelectedParticipant)
    .filter((value): value is ParticipantGroup => value != null);
  if (inferred.length < 2) return null;

  const canonical = inferred[0];
  const hasOpposite = inferred.some(
    (selection) => intersectionSize(selection.tokens, canonical.tokens) === 0,
  );
  return hasOpposite ? canonical : null;
}

export function resolveLiquidityDisplay(row: {
  liquidity: unknown;
  open_interest?: unknown;
  openInterest?: unknown;
}): number | null {
  const liquidity = toNumber(row.liquidity);
  if (liquidity != null && liquidity > 0) return liquidity;

  const openInterest = toNumber(row.openInterest ?? row.open_interest ?? null);
  if (openInterest != null && openInterest > 0) return openInterest;

  return null;
}

export function resolveYesMid(
  row: Pick<ClusterMarketRow, "best_bid" | "best_ask" | "last_price">,
): number | null {
  const bid = toNumber(row.best_bid);
  const ask = toNumber(row.best_ask);
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return toNumber(row.last_price);
}

export function resolveExpiresAt(
  row: Pick<ClusterMarketRow, "expiration_time" | "close_time">,
): string | null {
  const expiration = parseDate(row.expiration_time);
  const close = parseDate(row.close_time);
  if (expiration && close) {
    return (expiration < close ? expiration : close).toISOString();
  }
  if (expiration) return expiration.toISOString();
  if (close) return close.toISOString();
  return null;
}

export function scoreMarket(
  row: Pick<
    ClusterMarketRow,
    | "volume_24h"
    | "activity_volume_last_24h"
    | "activity_volume_valid"
    | "volume_total"
    | "liquidity"
    | "open_interest"
  >,
): number {
  const volume24h = resolveVolume24h(row) ?? 0;
  const volumeTotal = toNumber(row.volume_total) ?? 0;
  const liquidity = toNumber(row.liquidity) ?? 0;
  const openInterest = toNumber(row.open_interest) ?? 0;
  return volume24h * 2 + liquidity + openInterest + volumeTotal * 0.2;
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true" || value === "t" || value === "1";
}

function resolveVolume24h(
  row: Pick<
    ClusterMarketRow,
    "volume_24h" | "activity_volume_last_24h" | "activity_volume_valid"
  >,
): number | null {
  const venueVolume = toNumber(row.volume_24h);
  if (venueVolume != null && venueVolume > 0) return venueVolume;

  const activityVolume = toNumber(row.activity_volume_last_24h);
  if (
    isTrue(row.activity_volume_valid) &&
    activityVolume != null &&
    activityVolume > 0
  ) {
    return activityVolume;
  }

  return venueVolume;
}

export function buildMarketSummary(
  row: ClusterMarketRow,
): ClusterMarketSummary {
  const yesBid = toNumber(row.best_bid);
  const yesAsk = toNumber(row.best_ask);
  const yesMid = resolveYesMid(row);
  const noMid = yesMid != null ? 1 - yesMid : null;

  return {
    marketId: row.id,
    eventId: row.event_id,
    venue: row.venue,
    marketSlug: row.slug ?? null,
    eventSlug: row.event_slug ?? null,
    marketImage: row.image ?? null,
    marketIcon: row.icon ?? null,
    eventImage: row.event_image ?? null,
    eventIcon: row.event_icon ?? null,
    image: row.image ?? row.event_image ?? null,
    icon: row.icon ?? row.event_icon ?? null,
    marketTitle: row.title,
    marketDescription: row.description ?? null,
    eventTitle: row.event_title,
    eventDescription: row.event_description ?? null,
    marketCategory: row.market_category ?? null,
    eventCategory: row.event_category ?? null,
    marketType: row.market_type,
    yesBid,
    yesAsk,
    yesMid,
    noMid,
    liquidity: toNumber(row.liquidity),
    volume24h: resolveVolume24h(row),
    volumeTotal: toNumber(row.volume_total),
    openInterest: toNumber(row.open_interest),
    expiresAt: resolveExpiresAt(row),
  };
}

export function computeClusterMetrics(
  markets: ClusterMarketSummary[],
): ClusterMetrics {
  const venueCounts: Record<string, number> = {};
  let minLiquidity: number | null = null;
  let totalLiquidity = 0;
  let volume24h = 0;
  let expiresAt: string | null = null;
  const comparablePrices: number[] = [];
  const canonicalSelection = resolveCanonicalSelection(markets);

  for (const market of markets) {
    const venue = market.venue;
    venueCounts[venue] = (venueCounts[venue] ?? 0) + 1;

    const liquidityDisplay = resolveLiquidityDisplay({
      liquidity: market.liquidity,
      openInterest: market.openInterest,
    });
    if (liquidityDisplay != null) {
      totalLiquidity += liquidityDisplay;
      if (minLiquidity == null || liquidityDisplay < minLiquidity) {
        minLiquidity = liquidityDisplay;
      }
    }

    if (market.volume24h != null) {
      volume24h += market.volume24h;
    }

    const comparablePrice = resolveComparablePrice(market, canonicalSelection);
    if (comparablePrice != null) comparablePrices.push(comparablePrice);

    if (market.expiresAt) {
      if (!expiresAt || market.expiresAt < expiresAt) {
        expiresAt = market.expiresAt;
      }
    }
  }

  const venueCount = Object.keys(venueCounts).length;
  const priceSpread =
    comparablePrices.length >= 2
      ? Math.max(...comparablePrices) - Math.min(...comparablePrices)
      : null;

  return {
    venueCounts,
    venueCount,
    priceSpread,
    minLiquidity,
    totalLiquidity: Number.isFinite(totalLiquidity) ? totalLiquidity : null,
    volume24h: Number.isFinite(volume24h) ? volume24h : null,
    expiresAt,
  };
}
