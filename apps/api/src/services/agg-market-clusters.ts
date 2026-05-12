import crypto from "node:crypto";
import type { DbQuery } from "../db.js";
import {
  buildMarketSummary,
  computeClusterMetrics,
  type ClusterMarketSummary,
} from "./clusters.js";
import {
  AGG_SUPPORTED_VENUES,
  type AggMarketClient,
  type AggMidpoint,
  type AggSupportedVenue,
  type AggVenueMarket,
} from "./agg-market-client.js";

type AggClusterMarketRow = {
  id: string;
  event_id: string;
  venue: string;
  venue_market_id: string;
  title: string | null;
  description: string | null;
  slug: string | null;
  image: string | null;
  icon: string | null;
  market_category: string | null;
  market_type: string | null;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
  volume_24h: unknown;
  activity_volume_last_24h: unknown;
  activity_volume_valid: unknown;
  volume_total: unknown;
  liquidity: unknown;
  open_interest: unknown;
  close_time: unknown;
  expiration_time: unknown;
  condition_id: string | null;
  event_title: string | null;
  event_description: string | null;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_category: string | null;
};

export type AggClusterSortBy = "spread" | "volume24h";
export type AggClusterSortDir = "asc" | "desc";

export type AggClustersQueryInput = {
  venues?: string;
  limit?: number;
  sourceLimit?: number;
  minLiquidity?: number;
  minVenueCount?: number;
  minSpread?: number;
  sort_by?: AggClusterSortBy;
  sort_dir?: AggClusterSortDir;
};

type AggClusterDefaults = {
  limit: number;
  minVenueCount: number;
  minSpread: number;
  minQualityScore: number;
  minAnalysisConfidence: number;
  maxOutlierRatio: number;
};

export type AggClusterSummary = {
  id: string;
  label: string;
  score: number;
  source: "agg";
  category: string | null;
  seedMarketId: string | null;
  marketCount: number;
  venueCount: number;
  venueCounts: Record<string, number>;
  priceSpread: number | null;
  minLiquidity: number | null;
  totalLiquidity: number | null;
  volume24h: number | null;
  expiresAt: string | null;
  analysis: null;
  analysisStatus: null;
  analysisUpdatedAt: null;
  analysisConfidence: null;
  analysisModel: null;
  qualityScore: null;
  matchDiagnostics: {
    source: "agg";
    sourceMarketIds: string[];
    matchedMarketIds: string[];
    venues: AggSupportedVenue[];
  };
  markets: ClusterMarketSummary[];
  updatedAt: string;
  version: string;
};

export type AggClusterListResponse = {
  generatedAt: string;
  defaults: AggClusterDefaults;
  items: AggClusterSummary[];
};

type NormalizedAggMarket = {
  aggMarketId: string;
  venue: AggSupportedVenue;
  externalIdentifier: string | null;
  conditionId: string | null;
  venueEventId: string | null;
  question: string | null;
  midpoint: ResolvedAggMidpoint;
};

type NormalizedAggGroup = {
  sourceMarketIds: string[];
  markets: NormalizedAggMarket[];
};

type DbMatchedMarket = {
  row: AggClusterMarketRow;
  matchMethod: "externalIdentifier" | "conditionId";
};

type CacheEntry = {
  expiresAt: number;
  value: AggClusterListResponse;
};

type ResolvedAggMidpoint = {
  value: number;
  side: "yes" | "no" | "unknown";
};

const DEFAULTS: AggClusterDefaults = {
  limit: 40,
  minVenueCount: 2,
  minSpread: 0.01,
  minQualityScore: 0,
  minAnalysisConfidence: 0,
  maxOutlierRatio: 1,
};

const MAX_AGG_DB_SELECTED_SIDE_DEVIATION = 0.25;

function normalizeCategory(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function resolveClusterCategory(
  markets: ClusterMarketSummary[],
): string | null {
  const categoryStats = new Map<
    string,
    { category: string; count: number; volume24h: number }
  >();

  for (const market of markets) {
    const category = normalizeCategory(
      market.eventCategory ?? market.marketCategory,
    );
    if (!category) continue;
    const key = category.toLowerCase();
    const current = categoryStats.get(key) ?? {
      category,
      count: 0,
      volume24h: 0,
    };
    current.count += 1;
    current.volume24h += market.volume24h ?? 0;
    categoryStats.set(key, current);
  }

  const [best] = [...categoryStats.values()].sort((left, right) => {
    if (left.count !== right.count) return right.count - left.count;
    if (left.volume24h !== right.volume24h) {
      return right.volume24h - left.volume24h;
    }
    return left.category.localeCompare(right.category);
  });

  return best?.category ?? null;
}
const cache = new Map<string, CacheEntry>();
const supportedVenueSet = new Set<string>(AGG_SUPPORTED_VENUES);

function clampInt(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

function normalizeLabel(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function isOneSidedMarkSource(value: string | null | undefined): boolean {
  const normalized = normalizeLabel(value ?? null).replace(/\s+/g, "_");
  return (
    normalized.includes("one_sided") ||
    normalized.includes("one-sided") ||
    normalized.includes("onesided")
  );
}

function isOneSidedAggMidpoint(midpoint: AggMidpoint): boolean {
  if (isOneSidedMarkSource(midpoint.markSource)) return true;
  return midpoint.outcomes.some((outcome) =>
    isOneSidedMarkSource(outcome.markSource),
  );
}

function isOpenStatus(value: string | null): boolean {
  return normalizeLabel(value) === "open";
}

function toProbability(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value >= 0 && value <= 1 ? value : null;
}

function resolveAggMidpoint(
  midpoint: AggMidpoint | null,
): ResolvedAggMidpoint | null {
  if (!midpoint) return null;
  if (isOneSidedAggMidpoint(midpoint)) return null;

  const yesOutcome = midpoint.outcomes.find(
    (outcome) => normalizeLabel(outcome.label) === "yes",
  );
  const yesValue = toProbability(yesOutcome?.midpoint ?? yesOutcome?.price);
  if (yesValue != null) return { value: yesValue, side: "yes" };

  const noOutcome = midpoint.outcomes.find(
    (outcome) => normalizeLabel(outcome.label) === "no",
  );
  const noValue = toProbability(noOutcome?.midpoint ?? noOutcome?.price);
  if (noValue != null) return { value: noValue, side: "no" };

  const topLevelValue = toProbability(midpoint.midpoint ?? midpoint.price);
  return topLevelValue == null
    ? null
    : { value: topLevelValue, side: "unknown" };
}

function orientAggMidpointToDbYes(params: {
  midpoint: ResolvedAggMidpoint;
  market: ClusterMarketSummary;
}): number | null {
  const { midpoint, market } = params;
  const yesMid = market.yesMid;
  const noMid = market.noMid ?? (yesMid == null ? null : 1 - yesMid);

  if (midpoint.side === "yes") {
    if (
      yesMid != null &&
      Math.abs(yesMid - midpoint.value) > MAX_AGG_DB_SELECTED_SIDE_DEVIATION
    ) {
      return null;
    }
    return midpoint.value;
  }

  if (midpoint.side === "no") {
    const inferredYes = 1 - midpoint.value;
    if (
      yesMid != null &&
      Math.abs(yesMid - inferredYes) > MAX_AGG_DB_SELECTED_SIDE_DEVIATION
    ) {
      return null;
    }
    return inferredYes;
  }

  // AGG can return an unlabeled top-level midpoint. Orient it against our DB
  // yes/no midpoint before treating it as the comparable Yes-side price.
  const yesDiff =
    yesMid == null
      ? Number.POSITIVE_INFINITY
      : Math.abs(yesMid - midpoint.value);
  const noDiff =
    noMid == null ? Number.POSITIVE_INFINITY : Math.abs(noMid - midpoint.value);
  const bestDiff = Math.min(yesDiff, noDiff);
  if (
    !Number.isFinite(bestDiff) ||
    bestDiff > MAX_AGG_DB_SELECTED_SIDE_DEVIATION
  ) {
    return null;
  }

  return noDiff < yesDiff ? 1 - midpoint.value : midpoint.value;
}

function hasBinaryYesNoOutcomes(market: AggVenueMarket): boolean {
  const labels = new Set(
    market.venueMarketOutcomes.map((outcome) => normalizeLabel(outcome.label)),
  );
  return labels.has("yes") && labels.has("no");
}

function parseAggVenues(raw: string | undefined): AggSupportedVenue[] {
  const values =
    raw == null || raw.trim().length === 0
      ? [...AGG_SUPPORTED_VENUES]
      : raw
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
  const invalid = values.filter((venue) => !supportedVenueSet.has(venue));
  if (invalid.length > 0) {
    throw new Error(
      `Unsupported AGG venues: ${invalid.join(", ")}. Supported venues: ${AGG_SUPPORTED_VENUES.join(", ")}`,
    );
  }
  return [...new Set(values)] as AggSupportedVenue[];
}

function dedupeAggMarkets(markets: AggVenueMarket[]): AggVenueMarket[] {
  const byId = new Map<string, AggVenueMarket>();
  for (const market of markets) {
    byId.set(market.id, market);
  }
  return [...byId.values()];
}

function normalizeAggGroups(params: {
  markets: AggVenueMarket[];
  midpointsByMarketId: Map<string, AggMidpoint>;
  venues: Set<AggSupportedVenue>;
}): NormalizedAggGroup[] {
  const groups: NormalizedAggGroup[] = [];

  for (const primary of params.markets) {
    const members = dedupeAggMarkets([
      primary,
      ...primary.matchedVenueMarkets,
    ]).filter((market) => {
      return (
        params.venues.has(market.venue as AggSupportedVenue) &&
        isOpenStatus(market.status) &&
        hasBinaryYesNoOutcomes(market)
      );
    });

    if (members.length < 2) continue;

    const normalized: NormalizedAggMarket[] = [];
    for (const market of members) {
      const midpoint = resolveAggMidpoint(
        params.midpointsByMarketId.get(market.id) ?? null,
      );
      if (midpoint == null) continue;
      normalized.push({
        aggMarketId: market.id,
        venue: market.venue as AggSupportedVenue,
        externalIdentifier: market.externalIdentifier,
        conditionId: market.conditionId,
        venueEventId: market.venueEventId,
        question: market.question,
        midpoint,
      });
    }

    const distinctVenues = new Set(normalized.map((market) => market.venue));
    if (distinctVenues.size < 2) continue;

    // Conservative v1 rule: duplicate venues often mean head-to-head side
    // alignment is ambiguous. Drop until explicit side matching is implemented.
    if (distinctVenues.size !== normalized.length) continue;

    groups.push({
      sourceMarketIds: members.map((market) => market.id),
      markets: normalized,
    });
  }

  return groups;
}

function pairKey(
  venue: string,
  externalIdentifier: string | null,
): string | null {
  if (!externalIdentifier) return null;
  return `${venue}\u0000${externalIdentifier}`;
}

async function loadMatchedMarketRows(
  db: DbQuery,
  groups: NormalizedAggGroup[],
): Promise<Map<string, DbMatchedMarket>> {
  const markets = groups.flatMap((group) => group.markets);
  const venues = [...new Set(markets.map((market) => market.venue))];
  const externalIdentifiers = [
    ...new Set(
      markets
        .map((market) => market.externalIdentifier)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const conditionIds = [
    ...new Set(
      markets
        .map((market) => market.conditionId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];

  if (markets.length === 0 || venues.length === 0) return new Map();

  const { rows } = await db.query<AggClusterMarketRow>(
    `
      select
        m.id,
        m.event_id,
        m.venue,
        m.venue_market_id,
        m.title,
        m.description,
        m.slug,
        m.image,
        m.icon,
        m.category as market_category,
        m.market_type,
        m.best_bid,
        m.best_ask,
        m.last_price,
        m.volume_24h,
        mam.volume_last_24h as activity_volume_last_24h,
        mam.volume_valid as activity_volume_valid,
        m.volume_total,
        m.liquidity,
        m.open_interest,
        m.close_time,
        m.expiration_time,
        m.condition_id,
        e.title as event_title,
        e.description as event_description,
        e.slug as event_slug,
        e.image as event_image,
        e.icon as event_icon,
        e.category as event_category
      from unified_markets m
      join unified_events e on e.id = m.event_id
      left join unified_market_activity_metrics_24h mam
        on mam.market_id = m.id
      where m.status = 'ACTIVE'
        and e.status = 'ACTIVE'
        and m.venue = any($1::text[])
        and (
          m.venue_market_id = any($2::text[])
          or (
            m.condition_id is not null
            and m.condition_id = any($3::text[])
          )
        )
    `,
    [venues, externalIdentifiers, conditionIds],
  );

  const byExact = new Map<string, DbMatchedMarket>();
  const byCondition = new Map<string, DbMatchedMarket>();

  for (const row of rows) {
    const exactKey = pairKey(row.venue, row.venue_market_id);
    if (exactKey) {
      byExact.set(exactKey, { row, matchMethod: "externalIdentifier" });
    }
    const conditionKey = pairKey(row.venue, row.condition_id);
    if (conditionKey && !byCondition.has(conditionKey)) {
      byCondition.set(conditionKey, { row, matchMethod: "conditionId" });
    }
  }

  const byAggMarketId = new Map<string, DbMatchedMarket>();
  for (const market of markets) {
    const exactKey = pairKey(market.venue, market.externalIdentifier);
    const conditionKey = pairKey(market.venue, market.conditionId);
    const matched =
      (exactKey ? byExact.get(exactKey) : null) ??
      (conditionKey ? byCondition.get(conditionKey) : null) ??
      null;
    if (matched) byAggMarketId.set(market.aggMarketId, matched);
  }

  return byAggMarketId;
}

function buildLabel(markets: ClusterMarketSummary[]): string {
  const primary = markets.slice().sort((left, right) => {
    const leftVolume = left.volume24h ?? left.volumeTotal ?? 0;
    const rightVolume = right.volume24h ?? right.volumeTotal ?? 0;
    return rightVolume - leftVolume;
  })[0];
  const marketTitle = primary?.marketTitle?.trim() ?? "";
  const eventTitle = primary?.eventTitle?.trim() ?? "";

  if (marketTitle && eventTitle && marketTitle !== eventTitle) {
    return `${marketTitle} - ${eventTitle}`;
  }
  return eventTitle || marketTitle || "AGG matched market";
}

function hashClusterId(marketIds: string[]): string {
  const hash = crypto
    .createHash("sha1")
    .update(marketIds.slice().sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
  return `agg:${hash}`;
}

function scoreCluster(metrics: {
  priceSpread: number | null;
  volume24h: number | null;
  totalLiquidity: number | null;
  venueCount: number;
}): number {
  const spread = metrics.priceSpread ?? 0;
  const volume = Math.log10(Math.max(1, metrics.volume24h ?? 0));
  const liquidity = Math.log10(Math.max(1, metrics.totalLiquidity ?? 0));
  return spread * 100 + volume + liquidity * 0.5 + metrics.venueCount;
}

function buildAggClusterSummaries(params: {
  groups: NormalizedAggGroup[];
  matchedRowsByAggId: Map<string, DbMatchedMarket>;
  generatedAt: string;
}): AggClusterSummary[] {
  const clusters: AggClusterSummary[] = [];
  const seenIds = new Set<string>();

  for (const group of params.groups) {
    const markets: ClusterMarketSummary[] = [];
    for (const aggMarket of group.markets) {
      const matched = params.matchedRowsByAggId.get(aggMarket.aggMarketId);
      if (!matched) continue;
      const baseSummary = buildMarketSummary(matched.row);
      const yesMid = orientAggMidpointToDbYes({
        midpoint: aggMarket.midpoint,
        market: baseSummary,
      });
      if (yesMid == null) continue;
      markets.push({
        ...baseSummary,
        source: "agg",
        pricingSource: "agg_midpoint",
        aggVenueMarketId: aggMarket.aggMarketId,
        aggVenueEventId: aggMarket.venueEventId,
        matchMethod: matched.matchMethod,
        marketTitle: matched.row.title ?? aggMarket.question,
        yesMid,
        noMid: 1 - yesMid,
      });
    }

    const venueSet = new Set(markets.map((market) => market.venue));
    if (markets.length < 2 || venueSet.size < 2) continue;

    const id = hashClusterId(markets.map((market) => market.marketId));
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const metrics = computeClusterMetrics(markets);
    clusters.push({
      id,
      label: buildLabel(markets),
      score: scoreCluster(metrics),
      source: "agg",
      category: resolveClusterCategory(markets),
      seedMarketId: markets[0]?.marketId ?? null,
      marketCount: markets.length,
      venueCount: metrics.venueCount,
      venueCounts: metrics.venueCounts,
      priceSpread: metrics.priceSpread,
      minLiquidity: metrics.minLiquidity,
      totalLiquidity: metrics.totalLiquidity,
      volume24h: metrics.volume24h,
      expiresAt: metrics.expiresAt,
      analysis: null,
      analysisStatus: null,
      analysisUpdatedAt: null,
      analysisConfidence: null,
      analysisModel: null,
      qualityScore: null,
      matchDiagnostics: {
        source: "agg",
        sourceMarketIds: group.sourceMarketIds,
        matchedMarketIds: markets.map((market) => market.marketId),
        venues: [...venueSet] as AggSupportedVenue[],
      },
      markets,
      updatedAt: params.generatedAt,
      version: "agg-v1",
    });
  }

  return clusters;
}

function applyFilters(
  clusters: AggClusterSummary[],
  query: AggClustersQueryInput,
  defaults: AggClusterDefaults,
): AggClusterSummary[] {
  let filtered = clusters;
  const minVenueCount = query.minVenueCount ?? defaults.minVenueCount;
  if (minVenueCount != null) {
    filtered = filtered.filter(
      (cluster) => cluster.venueCount >= minVenueCount,
    );
  }

  const minSpread = query.minSpread ?? defaults.minSpread;
  if (minSpread != null) {
    filtered = filtered.filter(
      (cluster) =>
        cluster.priceSpread != null && cluster.priceSpread >= minSpread,
    );
  }

  const minLiquidity = query.minLiquidity;
  if (minLiquidity != null) {
    filtered = filtered.filter(
      (cluster) =>
        cluster.minLiquidity != null && cluster.minLiquidity >= minLiquidity,
    );
  }

  return filtered;
}

function sortClusters(
  clusters: AggClusterSummary[],
  sortBy: AggClusterSortBy,
  sortDir: AggClusterSortDir,
): AggClusterSummary[] {
  const multiplier = sortDir === "asc" ? 1 : -1;
  return clusters.slice().sort((left, right) => {
    const leftValue =
      sortBy === "volume24h" ? left.volume24h : left.priceSpread;
    const rightValue =
      sortBy === "volume24h" ? right.volume24h : right.priceSpread;
    const leftMissing = leftValue == null || !Number.isFinite(leftValue);
    const rightMissing = rightValue == null || !Number.isFinite(rightValue);
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (!leftMissing && !rightMissing && leftValue !== rightValue) {
      return (leftValue - rightValue) * multiplier;
    }
    if (left.score !== right.score) return right.score - left.score;
    return left.id.localeCompare(right.id);
  });
}

function cacheKey(query: AggClustersQueryInput): string {
  return JSON.stringify({
    venues: query.venues ?? null,
    limit: query.limit ?? null,
    sourceLimit: query.sourceLimit ?? null,
    minLiquidity: query.minLiquidity ?? null,
    minVenueCount: query.minVenueCount ?? null,
    minSpread: query.minSpread ?? null,
    sort_by: query.sort_by ?? null,
    sort_dir: query.sort_dir ?? null,
  });
}

export function clearAggClustersCacheForTests() {
  cache.clear();
}

export async function buildAggClusterListResponse(params: {
  query: AggClustersQueryInput;
  client: AggMarketClient;
  db: DbQuery;
  now?: Date;
}): Promise<AggClusterListResponse> {
  const generatedAt = (params.now ?? new Date()).toISOString();
  const venues = parseAggVenues(params.query.venues);
  const sourceLimit = clampInt(params.query.sourceLimit, 100, 100);
  const outputLimit = clampInt(params.query.limit, DEFAULTS.limit, 200);

  const venueMarkets = await params.client.getVenueMarkets({
    status: "open",
    matchStatus: ["matched", "verified"],
    limit: sourceLimit,
    sortBy: "volume",
    sortDir: "desc",
  });

  const candidateMarkets = dedupeAggMarkets(
    venueMarkets.flatMap((market) => [market, ...market.matchedVenueMarkets]),
  ).filter(
    (market) =>
      venues.includes(market.venue as AggSupportedVenue) &&
      isOpenStatus(market.status) &&
      hasBinaryYesNoOutcomes(market),
  );
  const midpoints = await params.client.getMidpoints(
    candidateMarkets.map((market) => market.id),
  );
  const midpointsByMarketId = new Map(
    midpoints.map((midpoint) => [midpoint.venueMarketId, midpoint]),
  );
  const groups = normalizeAggGroups({
    markets: venueMarkets,
    midpointsByMarketId,
    venues: new Set(venues),
  });
  const matchedRowsByAggId = await loadMatchedMarketRows(params.db, groups);
  const clusters = buildAggClusterSummaries({
    groups,
    matchedRowsByAggId,
    generatedAt,
  });
  const filtered = applyFilters(clusters, params.query, DEFAULTS);
  const sorted = sortClusters(
    filtered,
    params.query.sort_by ?? "volume24h",
    params.query.sort_dir ?? "desc",
  );

  return {
    generatedAt,
    defaults: DEFAULTS,
    items: sorted.slice(0, outputLimit),
  };
}

export async function getAggClusterListResponseCached(params: {
  query: AggClustersQueryInput;
  client: AggMarketClient;
  db: DbQuery;
  ttlSec: number;
}): Promise<AggClusterListResponse> {
  const key = cacheKey(params.query);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await buildAggClusterListResponse({
    query: params.query,
    client: params.client,
    db: params.db,
  });

  if (params.ttlSec > 0) {
    cache.set(key, {
      expiresAt: now + params.ttlSec * 1000,
      value,
    });
  }

  return value;
}
