import crypto from "node:crypto";
import type { DbQuery } from "../db.js";
import { buildBroadOrderableMarketSql } from "../lib/market-availability.js";
import { isRecord } from "../lib/type-guards.js";
import {
  buildMarketSummary,
  computeClusterMetrics,
  resolveExplicitMarketOutcomeMapping,
  type ClusterMarketSummary,
} from "./clusters.js";
import {
  AGG_SUPPORTED_VENUES,
  type AggMarketClient,
  type AggMidpoint,
  type AggSupportedVenue,
  type AggVenueMarket,
} from "./agg-market-client.js";
import type { ClusterExecutionSummary } from "./cluster-execution.js";
import { filterSignalBotVenuesForLifecycleCapability } from "./signal-bot-venue-lifecycle.js";

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
  event_venue_event_id: string | null;
  event_title: string | null;
  event_description: string | null;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_category: string | null;
  canonical_active: boolean;
  canonical_orderable: boolean;
};

export type AggMarketAlternativesDiagnostics = {
  aggNoMatch: number;
  targetSearchEmpty: number;
  externalMatchUnindexed: number;
  canonicalMarketInactive: number;
  outcomeMappingMissing: number;
  priceUnavailable: number;
};

export type AggClusterSortBy = "spread" | "volume24h";
export type AggClusterSortDir = "asc" | "desc";

export type AggClustersQueryInput = {
  cursor?: string;
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
  execution?: ClusterExecutionSummary;
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
  coverage: {
    complete: boolean;
    nextCursor: string | null;
    pagesFetched: number;
    sourceMarkets: number;
  };
  generatedAt: string;
  defaults: AggClusterDefaults;
  items: AggClusterSummary[];
};

export type AggMarketAlternativesQueryInput = {
  venues?: string;
  limit?: number;
  sourceLimit?: number;
};

export type AggMarketAlternativeMidpoint = {
  marketId: string;
  eventId: string;
  venue: string;
  yesMid: number | null;
  noMid: number | null;
};

export type AggMarketAlternativesResponse = {
  generatedAt: string;
  source: "agg";
  pricingSource: "agg_midpoint";
  marketId: string;
  eventId: string | null;
  status: "matched" | "not_found";
  priceSpread: number | null;
  lowestYesMid: AggMarketAlternativeMidpoint | null;
  lowestNoMid: AggMarketAlternativeMidpoint | null;
  markets: ClusterMarketSummary[];
  alternatives: ClusterMarketSummary[];
  matchDiagnostics: AggClusterSummary["matchDiagnostics"] | null;
  diagnostics: AggMarketAlternativesDiagnostics;
};

export type AggMarketAlternativesCacheClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
};

export type AggMarketAlternativesCacheStatus = "hit" | "miss" | "skip";
export type AggMarketAlternativesCacheLayer = "local" | "redis" | "none";
export type AggMarketAlternativesCacheKind =
  AggMarketAlternativesResponse["status"];

export type AggMarketAlternativesCacheMetadata = {
  kind: AggMarketAlternativesCacheKind | null;
  layer: AggMarketAlternativesCacheLayer;
  status: AggMarketAlternativesCacheStatus;
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

function parseExpiryMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isClusterMarketExpired(
  market: Pick<ClusterMarketSummary, "expiresAt">,
  nowMs: number,
): boolean {
  const expiryMs = parseExpiryMs(market.expiresAt);
  return expiryMs != null && expiryMs <= nowMs;
}

type DbMatchedMarket = {
  row: AggClusterMarketRow;
  matchMethod: "externalIdentifier" | "conditionId";
};

function createAggAlternativesDiagnostics(): AggMarketAlternativesDiagnostics {
  return {
    aggNoMatch: 0,
    targetSearchEmpty: 0,
    externalMatchUnindexed: 0,
    canonicalMarketInactive: 0,
    outcomeMappingMissing: 0,
    priceUnavailable: 0,
  };
}

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export type AggClusterListCacheClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
};

export type AggClusterListCacheStatus = "hit" | "miss" | "skip";
export type AggClusterListCacheLayer = "local" | "redis" | "none";

export type AggClusterListCacheMetadata = {
  status: AggClusterListCacheStatus;
  layer: AggClusterListCacheLayer;
};

type ResolvedAggMidpoint = {
  timestamp: string | null;
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
const AGG_ALTERNATIVE_REQUEST_HARD_CAP = 6;

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
const cache = new Map<string, CacheEntry<AggClusterListResponse>>();
const alternativesCache = new Map<
  string,
  CacheEntry<AggMarketAlternativesResponse>
>();
const AGG_CLUSTER_REDIS_CACHE_PREFIX = "agg:clusters:v1";
const AGG_ALTERNATIVES_REDIS_CACHE_PREFIX = "agg:market-alternatives:v1";
const MAX_ALTERNATIVES_CACHE_ENTRIES = 500;
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

function toProbabilityFromUnknown(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function resolveReliableDbYesReference(
  row: AggClusterMarketRow,
): number | null {
  const bid = toProbabilityFromUnknown(row.best_bid);
  const ask = toProbabilityFromUnknown(row.best_ask);
  if (bid != null && ask != null) return (bid + ask) / 2;

  const lastPrice = toProbabilityFromUnknown(row.last_price);
  if (lastPrice != null) return lastPrice;

  // A bid-only quote is a lower bound but still on the selected side. An
  // ask-only quote can be arbitrarily stale/wide, so do not use it to orient
  // external midpoint data.
  return bid;
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
  if (yesValue != null) {
    return { timestamp: midpoint.timestamp, value: yesValue, side: "yes" };
  }

  const noOutcome = midpoint.outcomes.find(
    (outcome) => normalizeLabel(outcome.label) === "no",
  );
  const noValue = toProbability(noOutcome?.midpoint ?? noOutcome?.price);
  if (noValue != null) {
    return { timestamp: midpoint.timestamp, value: noValue, side: "no" };
  }

  const topLevelValue = toProbability(midpoint.midpoint ?? midpoint.price);
  return topLevelValue == null
    ? null
    : {
        timestamp: midpoint.timestamp,
        value: topLevelValue,
        side: "unknown",
      };
}

function orientAggMidpointToDbYes(params: {
  midpoint: ResolvedAggMidpoint;
  referenceYesMid: number | null;
}): number | null {
  const { midpoint } = params;
  const yesMid = params.referenceYesMid;
  const noMid = yesMid == null ? null : 1 - yesMid;

  if (midpoint.side === "yes") {
    if (yesMid == null) return null;
    if (
      Math.abs(yesMid - midpoint.value) > MAX_AGG_DB_SELECTED_SIDE_DEVIATION
    ) {
      return null;
    }
    return midpoint.value;
  }

  if (midpoint.side === "no") {
    if (yesMid == null) return null;
    const inferredYes = 1 - midpoint.value;
    if (Math.abs(yesMid - inferredYes) > MAX_AGG_DB_SELECTED_SIDE_DEVIATION) {
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
  diagnostics?: AggMarketAlternativesDiagnostics,
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
        e.venue_event_id as event_venue_event_id,
        e.title as event_title,
        e.description as event_description,
        e.slug as event_slug,
        e.image as event_image,
        e.icon as event_icon,
        e.category as event_category,
        (m.status = 'ACTIVE' and e.status = 'ACTIVE') as canonical_active,
        (
          m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and ${buildBroadOrderableMarketSql({ marketAlias: "m", eventAlias: "e", nowParam: "now()", pmAlias: "pm" })}
          and (m.close_time is null or m.close_time > now())
          and (m.expiration_time is null or m.expiration_time > now())
        ) as canonical_orderable
      from unified_markets m
      join unified_events e on e.id = m.event_id
      left join polymarket_markets pm
        on pm.id = m.venue_market_id
       and m.venue = 'polymarket'
      left join unified_market_activity_metrics_24h mam
        on mam.market_id = m.id
      where m.venue = any($1::text[])
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
    if (!matched) {
      if (diagnostics && (market.externalIdentifier || market.conditionId)) {
        diagnostics.externalMatchUnindexed += 1;
      }
      continue;
    }
    if (!matched.row.canonical_active || !matched.row.canonical_orderable) {
      if (diagnostics) diagnostics.canonicalMarketInactive += 1;
      continue;
    }
    byAggMarketId.set(market.aggMarketId, matched);
  }

  return byAggMarketId;
}

async function loadSeedMarketRow(
  db: DbQuery,
  marketId: string,
): Promise<AggClusterMarketRow | null> {
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
        e.venue_event_id as event_venue_event_id,
        e.title as event_title,
        e.description as event_description,
        e.slug as event_slug,
        e.image as event_image,
        e.icon as event_icon,
        e.category as event_category
      from unified_markets m
      join unified_events e on e.id = m.event_id
      left join polymarket_markets pm
        on pm.id = m.venue_market_id
       and m.venue = 'polymarket'
      left join unified_market_activity_metrics_24h mam
        on mam.market_id = m.id
      where m.status = 'ACTIVE'
        and e.status = 'ACTIVE'
        and ${buildBroadOrderableMarketSql({ marketAlias: "m", eventAlias: "e", nowParam: "now()", pmAlias: "pm" })}
        and (m.close_time is null or m.close_time > now())
        and (m.expiration_time is null or m.expiration_time > now())
        and (m.id = $1 or m.venue_market_id = $1)
      order by case when m.id = $1 then 0 else 1 end
      limit 1
    `,
    [marketId],
  );
  return rows[0] ?? null;
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

function buildAlternativeSearchTerms(seed: ClusterMarketSummary): string[] {
  const values = [seed.eventTitle, seed.marketTitle];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    const term = value?.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms.slice(0, 3);
}

function buildAlternativeVenueMarketAttempts(params: {
  seed: ClusterMarketSummary;
  seedRow: AggClusterMarketRow;
  venues: AggSupportedVenue[];
}): Array<{
  venue?: string;
  venueEventId?: string;
  search?: string;
}> {
  const attempts: Array<{
    venue?: string;
    venueEventId?: string;
    search?: string;
  }> = [];

  if (params.seedRow.event_venue_event_id) {
    attempts.push({
      venue: params.seed.venue,
      venueEventId: params.seedRow.event_venue_event_id,
    });
  }

  const searchTerms = buildAlternativeSearchTerms(params.seed);
  const targetVenues = params.venues.filter(
    (venue) => venue !== params.seed.venue,
  );
  for (const venue of targetVenues) {
    for (const search of searchTerms.slice(0, 2)) {
      attempts.push({ venue, search });
    }
  }
  const seen = new Set<string>();
  return (
    attempts
      .filter((attempt) => {
        const key = JSON.stringify({
          venue: attempt.venue ?? null,
          venueEventId: attempt.venueEventId ?? null,
          search: attempt.search ?? null,
        });
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      // Reserve one request for the unscoped top-volume fallback below.
      .slice(0, AGG_ALTERNATIVE_REQUEST_HARD_CAP - 1)
  );
}

function orderAlternativeMarkets(
  marketId: string,
  markets: ClusterMarketSummary[],
): { markets: ClusterMarketSummary[]; alternatives: ClusterMarketSummary[] } {
  const seed = markets.find((market) => market.marketId === marketId) ?? null;
  const seedYesMid = seed?.yesMid ?? null;
  const alternatives = markets
    .filter((market) => market.marketId !== marketId)
    .sort((left, right) => {
      const leftDistance =
        seedYesMid != null && left.yesMid != null
          ? Math.abs(left.yesMid - seedYesMid)
          : -1;
      const rightDistance =
        seedYesMid != null && right.yesMid != null
          ? Math.abs(right.yesMid - seedYesMid)
          : -1;
      if (leftDistance !== rightDistance) return rightDistance - leftDistance;
      const leftVolume = left.volume24h ?? left.volumeTotal ?? 0;
      const rightVolume = right.volume24h ?? right.volumeTotal ?? 0;
      if (leftVolume !== rightVolume) return rightVolume - leftVolume;
      return left.marketId.localeCompare(right.marketId);
    });

  return {
    markets: seed ? [seed, ...alternatives] : markets,
    alternatives,
  };
}

function resolveLowestMidpoint(
  markets: ClusterMarketSummary[],
  side: "yes" | "no",
): AggMarketAlternativeMidpoint | null {
  const candidates = markets.filter((market) =>
    side === "yes" ? market.yesMid != null : market.noMid != null,
  );
  if (!candidates.length) return null;

  const best = candidates.slice().sort((left, right) => {
    const leftValue = side === "yes" ? left.yesMid : left.noMid;
    const rightValue = side === "yes" ? right.yesMid : right.noMid;
    return (
      (leftValue ?? Number.POSITIVE_INFINITY) -
      (rightValue ?? Number.POSITIVE_INFINITY)
    );
  })[0];
  if (!best) return null;
  return {
    marketId: best.marketId,
    eventId: best.eventId,
    venue: best.venue,
    yesMid: best.yesMid,
    noMid: best.noMid,
  };
}

function matchDiagnosticsForMarkets(
  diagnostics: AggClusterSummary["matchDiagnostics"] | null,
  markets: ClusterMarketSummary[],
): AggClusterSummary["matchDiagnostics"] | null {
  if (!diagnostics) return null;
  const venues = [...new Set(markets.map((market) => market.venue))].filter(
    (venue): venue is AggSupportedVenue => supportedVenueSet.has(venue),
  );
  return {
    ...diagnostics,
    matchedMarketIds: markets.map((market) => market.marketId),
    venues,
  };
}

function buildNotFoundAlternativesResponse(params: {
  generatedAt: string;
  marketId: string;
  eventId: string | null;
  diagnostics?: AggMarketAlternativesDiagnostics;
}): AggMarketAlternativesResponse {
  return {
    generatedAt: params.generatedAt,
    source: "agg",
    pricingSource: "agg_midpoint",
    marketId: params.marketId,
    eventId: params.eventId,
    status: "not_found",
    priceSpread: null,
    lowestYesMid: null,
    lowestNoMid: null,
    markets: [],
    alternatives: [],
    matchDiagnostics: null,
    diagnostics: params.diagnostics ?? createAggAlternativesDiagnostics(),
  };
}

function buildMatchedAlternativesResponseFromCluster(params: {
  generatedAt: string;
  seed: ClusterMarketSummary;
  cluster: AggClusterSummary;
  venues: AggSupportedVenue[];
  outputLimit: number;
  nowMs: number;
  diagnostics?: AggMarketAlternativesDiagnostics;
}): AggMarketAlternativesResponse | null {
  const venueSet = new Set(params.venues);
  const clusterMarkets = params.cluster.markets.filter(
    (market) =>
      venueSet.has(market.venue as AggSupportedVenue) &&
      !isClusterMarketExpired(market, params.nowMs),
  );
  const ordered = orderAlternativeMarkets(params.seed.marketId, clusterMarkets);
  const orderedSeed =
    ordered.markets.find(
      (market) => market.marketId === params.seed.marketId,
    ) ?? null;
  if (!orderedSeed) return null;

  const alternatives = ordered.alternatives
    .filter(
      (market) =>
        resolveExplicitMarketOutcomeMapping(orderedSeed, market) != null,
    )
    .slice(0, params.outputLimit);
  if (!alternatives.length) return null;

  const markets = [orderedSeed, ...alternatives].map((market) => ({
    ...market,
    outcomeMapping: resolveExplicitMarketOutcomeMapping(orderedSeed, market),
  }));
  const mappedAlternatives = markets.slice(1);
  const metrics = computeClusterMetrics(markets);

  return {
    generatedAt: params.generatedAt,
    source: "agg",
    pricingSource: "agg_midpoint",
    marketId: params.seed.marketId,
    eventId: params.seed.eventId,
    status: "matched",
    priceSpread: metrics.priceSpread,
    lowestYesMid: resolveLowestMidpoint(markets, "yes"),
    lowestNoMid: resolveLowestMidpoint(markets, "no"),
    markets,
    alternatives: mappedAlternatives,
    matchDiagnostics: matchDiagnosticsForMarkets(
      params.cluster.matchDiagnostics,
      markets,
    ),
    diagnostics: params.diagnostics ?? createAggAlternativesDiagnostics(),
  };
}

function filterOutcomeMappableMarkets(
  markets: ClusterMarketSummary[],
): ClusterMarketSummary[] {
  if (markets.length < 2) return markets;

  let best: ClusterMarketSummary[] = [];
  for (const first of markets) {
    const candidate: ClusterMarketSummary[] = [first];
    for (const market of markets) {
      if (
        market !== first &&
        candidate.every((existing) =>
          Boolean(resolveExplicitMarketOutcomeMapping(existing, market)),
        )
      ) {
        candidate.push(market);
      }
    }

    if (candidate.length > best.length) best = candidate;
  }

  return best.length >= 2 ? best : [];
}

function findCachedClusterForMarket(params: {
  marketId: string;
  now: number;
}): AggClusterSummary | null {
  const candidates: AggClusterSummary[] = [];
  for (const entry of cache.values()) {
    if (entry.expiresAt <= params.now) continue;
    for (const cluster of entry.value.items) {
      if (
        cluster.markets.some((market) => market.marketId === params.marketId)
      ) {
        candidates.push(cluster);
      }
    }
  }

  return candidates.sort(compareAlternativeClusters)[0] ?? null;
}

function compareAlternativeClusters(
  left: AggClusterSummary,
  right: AggClusterSummary,
): number {
  if (left.marketCount !== right.marketCount) {
    return right.marketCount - left.marketCount;
  }
  if (left.score !== right.score) return right.score - left.score;
  return left.id.localeCompare(right.id);
}

function findClusterForMarket(
  clusters: AggClusterSummary[],
  marketId: string,
): AggClusterSummary | null {
  return (
    clusters
      .filter((entry) =>
        entry.markets.some((market) => market.marketId === marketId),
      )
      .sort(compareAlternativeClusters)[0] ?? null
  );
}

function buildAggClusterSummaries(params: {
  groups: NormalizedAggGroup[];
  matchedRowsByAggId: Map<string, DbMatchedMarket>;
  generatedAt: string;
  nowMs: number;
}): AggClusterSummary[] {
  const clusters: AggClusterSummary[] = [];
  const seenIds = new Set<string>();

  for (const group of params.groups) {
    const markets: ClusterMarketSummary[] = [];
    for (const aggMarket of group.markets) {
      const matched = params.matchedRowsByAggId.get(aggMarket.aggMarketId);
      if (!matched) continue;
      const baseSummary = buildMarketSummary(matched.row);
      if (isClusterMarketExpired(baseSummary, params.nowMs)) continue;
      const yesMid = orientAggMidpointToDbYes({
        midpoint: aggMarket.midpoint,
        referenceYesMid: resolveReliableDbYesReference(matched.row),
      });
      if (yesMid == null) continue;
      markets.push({
        ...baseSummary,
        active: true,
        source: "agg",
        pricingSource: "agg_midpoint",
        aggVenueMarketId: aggMarket.aggMarketId,
        aggVenueEventId: aggMarket.venueEventId,
        matchMethod: matched.matchMethod,
        orderable: true,
        outcomeMapping: null,
        priceAsOf: aggMarket.midpoint.timestamp,
        marketTitle: matched.row.title ?? aggMarket.question,
        yesMid,
        noMid: 1 - yesMid,
      });
    }

    const comparableMarkets = filterOutcomeMappableMarkets([
      ...new Map(markets.map((market) => [market.marketId, market])).values(),
    ]);
    const venueSet = new Set(comparableMarkets.map((market) => market.venue));
    if (comparableMarkets.length < 2 || venueSet.size < 2) continue;

    const id = hashClusterId(
      comparableMarkets.map((market) => market.marketId),
    );
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const metrics = computeClusterMetrics(comparableMarkets);
    clusters.push({
      id,
      label: buildLabel(comparableMarkets),
      score: scoreCluster(metrics),
      source: "agg",
      category: resolveClusterCategory(comparableMarkets),
      seedMarketId: comparableMarkets[0]?.marketId ?? null,
      marketCount: comparableMarkets.length,
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
        matchedMarketIds: comparableMarkets.map((market) => market.marketId),
        venues: [...venueSet] as AggSupportedVenue[],
      },
      markets: comparableMarkets,
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

export function buildAggClusterListCacheKey(
  query: AggClustersQueryInput,
): string {
  return JSON.stringify({
    venues: parseAggVenues(query.venues).join(","),
    cursor: query.cursor?.trim() || null,
    limit: clampInt(query.limit, DEFAULTS.limit, 200),
    sourceLimit: clampInt(query.sourceLimit, 100, 100),
    minLiquidity: query.minLiquidity ?? null,
    minVenueCount: query.minVenueCount ?? DEFAULTS.minVenueCount,
    minSpread: query.minSpread ?? DEFAULTS.minSpread,
    sort_by: query.sort_by ?? "volume24h",
    sort_dir: query.sort_dir ?? "desc",
  });
}

function buildAggClusterListRedisCacheKey(
  query: AggClustersQueryInput,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(buildAggClusterListCacheKey(query))
    .digest("hex");
  return `${AGG_CLUSTER_REDIS_CACHE_PREFIX}:${hash}`;
}

function readAggClusterListCachedBody(
  body: string,
): AggClusterListResponse | null {
  try {
    const parsed = JSON.parse(body) as AggClusterListResponse;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.generatedAt !== "string") return null;
    if (!parsed.defaults || typeof parsed.defaults !== "object") return null;
    if (!Array.isArray(parsed.items)) return null;
    if (!parsed.coverage || typeof parsed.coverage !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAggClusterLocalCache(params: {
  key: string;
  value: AggClusterListResponse;
  ttlSec: number;
  now: number;
}): void {
  if (params.ttlSec <= 0) return;
  cache.set(params.key, {
    expiresAt: params.now + params.ttlSec * 1000,
    value: params.value,
  });
}

export function clearAggClustersCacheForTests() {
  cache.clear();
  alternativesCache.clear();
}

async function buildAggClustersFromVenueMarkets(params: {
  venueMarkets: AggVenueMarket[];
  venues: AggSupportedVenue[];
  client: AggMarketClient;
  db: DbQuery;
  generatedAt: string;
  nowMs: number;
  diagnostics?: AggMarketAlternativesDiagnostics;
}): Promise<AggClusterSummary[]> {
  const candidateMarkets = dedupeAggMarkets(
    params.venueMarkets.flatMap((market) => [
      market,
      ...market.matchedVenueMarkets,
    ]),
  ).filter(
    (market) =>
      params.venues.includes(market.venue as AggSupportedVenue) &&
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
    markets: params.venueMarkets,
    midpointsByMarketId,
    venues: new Set(params.venues),
  });
  const matchedRowsByAggId = await loadMatchedMarketRows(
    params.db,
    groups,
    params.diagnostics,
  );
  const clusters = buildAggClusterSummaries({
    groups,
    matchedRowsByAggId,
    generatedAt: params.generatedAt,
    nowMs: params.nowMs,
  });
  if (
    params.diagnostics &&
    groups.length > 0 &&
    matchedRowsByAggId.size > 0 &&
    clusters.length === 0
  ) {
    params.diagnostics.outcomeMappingMissing += 1;
  }
  return clusters;
}

export async function buildAggClusterListResponse(params: {
  query: AggClustersQueryInput;
  client: AggMarketClient;
  db: DbQuery;
  now?: Date;
}): Promise<AggClusterListResponse> {
  const now = params.now ?? new Date();
  const generatedAt = now.toISOString();
  const nowMs = now.getTime();
  const venues = parseAggVenues(params.query.venues);
  const sourceLimit = clampInt(params.query.sourceLimit, 100, 100);
  const outputLimit = clampInt(params.query.limit, DEFAULTS.limit, 200);

  const venueMarketsPage = await params.client.getVenueMarkets({
    cursor: params.query.cursor,
    status: "open",
    matchStatus: ["matched", "verified"],
    limit: sourceLimit,
    sortBy: "volume",
    sortDir: "desc",
  });

  const sourceMarkets = dedupeAggMarkets(venueMarketsPage.items);
  const clusters = await buildAggClustersFromVenueMarkets({
    venueMarkets: sourceMarkets,
    venues,
    client: params.client,
    db: params.db,
    generatedAt,
    nowMs,
  });
  const filtered = applyFilters(clusters, params.query, DEFAULTS);
  const sorted = sortClusters(
    filtered,
    params.query.sort_by ?? "volume24h",
    params.query.sort_dir ?? "desc",
  );

  return {
    coverage: {
      complete: venueMarketsPage.nextCursor == null,
      nextCursor: venueMarketsPage.nextCursor,
      pagesFetched: 1,
      sourceMarkets: sourceMarkets.length,
    },
    generatedAt,
    defaults: DEFAULTS,
    items: sorted.slice(0, outputLimit),
  };
}

export async function buildAggMarketAlternativesResponse(params: {
  marketId: string;
  query: AggMarketAlternativesQueryInput;
  client: AggMarketClient;
  db: DbQuery;
  now?: Date;
}): Promise<AggMarketAlternativesResponse | null> {
  const now = params.now ?? new Date();
  const generatedAt = now.toISOString();
  const nowMs = now.getTime();
  const venues = parseAggVenues(params.query.venues);
  const sourceLimit = clampInt(params.query.sourceLimit, 50, 100);
  const outputLimit = clampInt(params.query.limit, 10, 50);
  const seedRow = await loadSeedMarketRow(params.db, params.marketId);
  if (!seedRow) return null;

  const seed = buildMarketSummary(seedRow);
  const diagnostics = createAggAlternativesDiagnostics();
  if (isClusterMarketExpired(seed, nowMs)) {
    return buildNotFoundAlternativesResponse({
      generatedAt,
      marketId: seed.marketId,
      eventId: seed.eventId,
      diagnostics,
    });
  }
  if (!venues.includes(seed.venue as AggSupportedVenue)) {
    return buildNotFoundAlternativesResponse({
      generatedAt,
      marketId: seed.marketId,
      eventId: seed.eventId,
      diagnostics,
    });
  }

  const attempts = buildAlternativeVenueMarketAttempts({
    seed,
    seedRow,
    venues,
  });

  for (const attempt of attempts) {
    const venueMarketsPage = await params.client.getVenueMarkets({
      venue: attempt.venue,
      venueEventId: attempt.venueEventId,
      search: attempt.search,
      status: "open",
      matchStatus: ["matched", "verified"],
      limit: sourceLimit,
      sortBy: "volume",
      sortDir: "desc",
    });
    const venueMarkets = venueMarketsPage.items;
    if (!venueMarkets.length) {
      if (attempt.venue && attempt.search) diagnostics.targetSearchEmpty += 1;
      continue;
    }

    const clusters = await buildAggClustersFromVenueMarkets({
      venueMarkets,
      venues,
      client: params.client,
      db: params.db,
      generatedAt,
      nowMs,
      diagnostics,
    });
    const cluster = findClusterForMarket(clusters, seed.marketId);
    if (!cluster) continue;

    const response = buildMatchedAlternativesResponseFromCluster({
      generatedAt,
      seed,
      cluster,
      venues,
      outputLimit,
      nowMs,
      diagnostics,
    });
    if (response) return response;
  }

  const cachedCluster = findCachedClusterForMarket({
    marketId: seed.marketId,
    now: Date.now(),
  });
  if (cachedCluster) {
    const response = buildMatchedAlternativesResponseFromCluster({
      generatedAt,
      seed,
      cluster: cachedCluster,
      venues,
      outputLimit,
      nowMs,
      diagnostics,
    });
    if (response) return response;
  }

  const broadVenueMarketsPage = await params.client.getVenueMarkets({
    status: "open",
    matchStatus: ["matched", "verified"],
    limit: sourceLimit,
    sortBy: "volume",
    sortDir: "desc",
  });
  const broadVenueMarkets = broadVenueMarketsPage.items;
  if (broadVenueMarkets.length) {
    const clusters = await buildAggClustersFromVenueMarkets({
      venueMarkets: broadVenueMarkets,
      venues,
      client: params.client,
      db: params.db,
      generatedAt,
      nowMs,
      diagnostics,
    });
    const cluster = findClusterForMarket(clusters, seed.marketId);
    if (cluster) {
      const response = buildMatchedAlternativesResponseFromCluster({
        generatedAt,
        seed,
        cluster,
        venues,
        outputLimit,
        nowMs,
        diagnostics,
      });
      if (response) return response;
    }
  }

  diagnostics.aggNoMatch += 1;
  return buildNotFoundAlternativesResponse({
    generatedAt,
    marketId: seed.marketId,
    eventId: seed.eventId,
    diagnostics,
  });
}

export async function getAggClusterListResponseCachedWithMetadata(params: {
  query: AggClustersQueryInput;
  client: AggMarketClient;
  db: DbQuery;
  ttlSec: number;
  cacheClient?: AggClusterListCacheClient | null;
  onCacheError?: (operation: "read" | "write", error: unknown) => void;
}): Promise<{
  response: AggClusterListResponse;
  cache: AggClusterListCacheMetadata;
}> {
  const requestedVenues = parseAggVenues(params.query.venues);
  const lifecycle = await filterSignalBotVenuesForLifecycleCapability(
    params.db,
    requestedVenues,
    "discovery",
  );
  const venues = lifecycle.venues.filter((venue) =>
    AGG_SUPPORTED_VENUES.includes(venue as AggSupportedVenue),
  ) as AggSupportedVenue[];
  if (venues.length === 0) {
    return {
      response: {
        coverage: {
          complete: true,
          nextCursor: null,
          pagesFetched: 0,
          sourceMarkets: 0,
        },
        generatedAt: new Date().toISOString(),
        defaults: DEFAULTS,
        items: [],
      },
      cache: { status: "skip", layer: "none" },
    };
  }
  const query = { ...params.query, venues: venues.join(",") };
  const key = `${lifecycle.revision}:${buildAggClusterListCacheKey(query)}`;
  const now = Date.now();

  if (params.ttlSec <= 0) {
    const response = await buildAggClusterListResponse({
      query,
      client: params.client,
      db: params.db,
    });
    return { response, cache: { status: "skip", layer: "none" } };
  }

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return {
      response: cached.value,
      cache: { status: "hit", layer: "local" },
    };
  }

  const cacheClient = params.cacheClient ?? null;
  const redisKey = `${buildAggClusterListRedisCacheKey(query)}:${lifecycle.revision}`;
  let cacheStatus: AggClusterListCacheStatus = cacheClient ? "miss" : "skip";

  if (cacheClient) {
    try {
      const cachedBody = await cacheClient.get(redisKey);
      const cachedResponse = cachedBody
        ? readAggClusterListCachedBody(cachedBody)
        : null;
      if (cachedResponse) {
        writeAggClusterLocalCache({
          key,
          value: cachedResponse,
          ttlSec: params.ttlSec,
          now,
        });
        return {
          response: cachedResponse,
          cache: { status: "hit", layer: "redis" },
        };
      }
    } catch (error) {
      params.onCacheError?.("read", error);
      cacheStatus = "skip";
    }
  }

  const response = await buildAggClusterListResponse({
    query,
    client: params.client,
    db: params.db,
  });

  writeAggClusterLocalCache({
    key,
    value: response,
    ttlSec: params.ttlSec,
    now,
  });

  if (cacheClient && cacheStatus !== "skip") {
    try {
      await cacheClient.set(redisKey, JSON.stringify(response), {
        EX: params.ttlSec,
      });
    } catch (error) {
      params.onCacheError?.("write", error);
    }
  }

  return { response, cache: { status: cacheStatus, layer: "none" } };
}

export async function getAggClusterListResponseCached(params: {
  query: AggClustersQueryInput;
  client: AggMarketClient;
  db: DbQuery;
  ttlSec: number;
  cacheClient?: AggClusterListCacheClient | null;
  onCacheError?: (operation: "read" | "write", error: unknown) => void;
}): Promise<AggClusterListResponse> {
  const { response } = await getAggClusterListResponseCachedWithMetadata({
    query: params.query,
    client: params.client,
    db: params.db,
    ttlSec: params.ttlSec,
    cacheClient: params.cacheClient,
    onCacheError: params.onCacheError,
  });
  return response;
}

export function buildAggMarketAlternativesCacheKey(
  marketId: string,
  query: AggMarketAlternativesQueryInput,
): string {
  return JSON.stringify({
    marketId,
    venues: parseAggVenues(query.venues).join(","),
    limit: clampInt(query.limit, 10, 50),
    sourceLimit: clampInt(query.sourceLimit, 50, 100),
  });
}

export function buildAggMarketAlternativesRedisCacheKey(
  marketId: string,
  query: AggMarketAlternativesQueryInput,
): string {
  const normalized = buildAggMarketAlternativesCacheKey(marketId, query);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return `${AGG_ALTERNATIVES_REDIS_CACHE_PREFIX}:${hash}`;
}

export function readAggMarketAlternativesCacheKind(
  body: string,
): AggMarketAlternativesCacheKind | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return null;
    return parsed.status === "matched" || parsed.status === "not_found"
      ? parsed.status
      : null;
  } catch {
    return null;
  }
}

function parseAggMarketAlternativesResponse(
  body: string,
): AggMarketAlternativesResponse | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return null;
    return parsed.status === "matched" || parsed.status === "not_found"
      ? (parsed as AggMarketAlternativesResponse)
      : null;
  } catch {
    return null;
  }
}

export function aggMarketAlternativesCacheTtlForResponse(
  response: AggMarketAlternativesResponse,
  options: {
    matchedTtlSec: number;
    notFoundTtlSec: number;
  },
): number {
  if (response.status === "matched") return options.matchedTtlSec;
  if (response.status === "not_found") return options.notFoundTtlSec;
  return 0;
}

function pruneAlternativesCache(now: number): void {
  for (const [key, entry] of alternativesCache.entries()) {
    if (entry.expiresAt <= now) alternativesCache.delete(key);
  }

  while (alternativesCache.size > MAX_ALTERNATIVES_CACHE_ENTRIES) {
    const oldestKey = alternativesCache.keys().next().value as
      | string
      | undefined;
    if (!oldestKey) break;
    alternativesCache.delete(oldestKey);
  }
}

export async function getAggMarketAlternativesResponseCached(params: {
  marketId: string;
  query: AggMarketAlternativesQueryInput;
  client: AggMarketClient;
  db: DbQuery;
  ttlSec: number;
}): Promise<AggMarketAlternativesResponse | null> {
  const key = buildAggMarketAlternativesCacheKey(params.marketId, params.query);
  const now = Date.now();
  const cached = alternativesCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await buildAggMarketAlternativesResponse({
    marketId: params.marketId,
    query: params.query,
    client: params.client,
    db: params.db,
  });

  if (value?.status === "matched" && params.ttlSec > 0) {
    pruneAlternativesCache(now);
    alternativesCache.set(key, {
      expiresAt: now + params.ttlSec * 1000,
      value,
    });
    pruneAlternativesCache(now);
  }

  return value;
}

export async function getAggMarketAlternativesResponseCachedWithMetadata(params: {
  cacheClient?: AggMarketAlternativesCacheClient | null;
  client: AggMarketClient;
  db: DbQuery;
  marketId: string;
  matchedTtlSec: number;
  notFoundTtlSec: number;
  onCacheError?: (operation: "read" | "write", error: unknown) => void;
  query: AggMarketAlternativesQueryInput;
}): Promise<{
  cache: AggMarketAlternativesCacheMetadata;
  response: AggMarketAlternativesResponse | null;
}> {
  const requestedVenues = parseAggVenues(params.query.venues);
  const lifecycle = await filterSignalBotVenuesForLifecycleCapability(
    params.db,
    requestedVenues,
    "discovery",
  );
  const venues = lifecycle.venues.filter((venue) =>
    AGG_SUPPORTED_VENUES.includes(venue as AggSupportedVenue),
  ) as AggSupportedVenue[];
  if (venues.length === 0) {
    return {
      cache: { kind: "not_found", layer: "none", status: "skip" },
      response: buildNotFoundAlternativesResponse({
        eventId: null,
        generatedAt: new Date().toISOString(),
        marketId: params.marketId,
      }),
    };
  }
  const query = { ...params.query, venues: venues.join(",") };
  let cacheStatus: AggMarketAlternativesCacheStatus = "skip";
  let cacheLayer: AggMarketAlternativesCacheLayer = "none";
  let cacheKind: AggMarketAlternativesCacheKind | null = null;
  const redisCacheKey = buildAggMarketAlternativesRedisCacheKey(
    params.marketId,
    query,
  );
  const lifecycleRedisCacheKey = `${redisCacheKey}:${lifecycle.revision}`;

  if (params.cacheClient) {
    cacheLayer = "redis";
    try {
      const cached = await params.cacheClient.get(lifecycleRedisCacheKey);
      const parsed =
        cached == null ? null : parseAggMarketAlternativesResponse(cached);
      if (parsed) {
        return {
          cache: {
            kind: parsed.status,
            layer: "redis",
            status: "hit",
          },
          response: parsed,
        };
      }
      cacheStatus = "miss";
    } catch (error) {
      params.onCacheError?.("read", error);
      cacheLayer = "none";
      cacheStatus = "skip";
    }
  }

  const response = await getAggMarketAlternativesResponseCached({
    client: params.client,
    db: params.db,
    marketId: params.marketId,
    query,
    ttlSec: params.matchedTtlSec,
  });
  if (!response) {
    return {
      cache: { kind: null, layer: cacheLayer, status: cacheStatus },
      response,
    };
  }

  cacheKind = response.status;
  const ttlSec = aggMarketAlternativesCacheTtlForResponse(response, {
    matchedTtlSec: params.matchedTtlSec,
    notFoundTtlSec: params.notFoundTtlSec,
  });
  if (params.cacheClient && ttlSec > 0) {
    try {
      await params.cacheClient.set(
        lifecycleRedisCacheKey,
        JSON.stringify(response),
        {
          EX: ttlSec,
        },
      );
    } catch (error) {
      params.onCacheError?.("write", error);
    }
  }

  return {
    cache: {
      kind: cacheKind,
      layer: cacheLayer,
      status: params.cacheClient && ttlSec > 0 ? cacheStatus : "skip",
    },
    response,
  };
}
