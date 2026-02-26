import { createHash } from "node:crypto";

export const MARKET_MAP_KEY_PREFIX = "ai:market_map:v1";

export const MARKET_MAP_DEFAULT_VENUES = [
  "polymarket",
  "kalshi",
  "limitless",
] as const;

export type MarketMapVenue = string;

export const MARKET_MAP_SIZE_BY = [
  "count",
  "volume24h",
  "liquidity",
  "openInterest",
] as const;

export type MarketMapSizeBy = (typeof MARKET_MAP_SIZE_BY)[number];

export type MarketMapNodeVenueMetrics = {
  eventCount: number;
  sumVolume24h: number;
  sumLiquidity: number;
  sumOpenInterest: number;
};

export type MarketMapNode = {
  id: string;
  venue: MarketMapVenue;
  dominantVenue: MarketMapVenue | null;
  venueCount: number;
  venueBreakdown: Record<MarketMapVenue, MarketMapNodeVenueMetrics>;
  level: number;
  parentId: string | null;
  childIds: string[];
  label: string;
  labelRepresentative: string;
  labelAi: string | null;
  labelSource: "representative" | "ai";
  x: number;
  y: number;
  eventCount: number;
  sumVolume24h: number;
  sumLiquidity: number;
  sumOpenInterest: number;
  score: number;
  sampleEventIds: string[];
  heroEventId?: string | null;
  heroMarketId?: string | null;
  heroImage?: string | null;
  heroIcon?: string | null;
  eventsPreview?: MarketMapEventSummary[];
  updatedAt: string;
};

export type MarketMapEventSummary = {
  eventId: string;
  title: string;
  venue: MarketMapVenue;
  representativeMarketId: string | null;
  representativeMarketTitle?: string | null;
  oddsSource?: "representative" | "fallback" | null;
  tokenYes?: string | null;
  tokenNo?: string | null;
  yesBid?: number | null;
  yesAsk?: number | null;
  noBid?: number | null;
  noAsk?: number | null;
  marketBestBid?: number | null;
  marketBestAsk?: number | null;
  lastPrice?: number | null;
  marketStatus?: string | null;
  acceptingOrders?: boolean | null;
  resolvedOutcome?: string | null;
  resolvedOutcomePct?: number | null;
  image?: string | null;
  icon?: string | null;
  volume24h: number;
  liquidity: number;
  openInterest: number;
  score: number;
  x: number;
  y: number;
};

export type MarketMapMeta = {
  runId: string;
  generatedAt: string;
  version: string;
  venues: MarketMapVenue[];
  depth: number;
  eventCountTotal: number;
  projectionMethod: "umap" | "pca2";
  projectionFallback: boolean;
  projectionDurationMs: number;
  buildDurationMs: number;
};

export function marketMapActiveKey(): string {
  return `${MARKET_MAP_KEY_PREFIX}:active`;
}

export function marketMapRunMetaKey(runId: string): string {
  return `${MARKET_MAP_KEY_PREFIX}:run:${runId}:meta`;
}

export function marketMapRunNodesGlobalKey(runId: string): string {
  return `${MARKET_MAP_KEY_PREFIX}:run:${runId}:nodes`;
}

export function marketMapRunNodesKey(runId: string, venue: MarketMapVenue): string {
  return `${MARKET_MAP_KEY_PREFIX}:run:${runId}:nodes:${venue}`;
}

export function marketMapRunNodeKey(runId: string, nodeId: string): string {
  return `${MARKET_MAP_KEY_PREFIX}:run:${runId}:node:${nodeId}`;
}

export function marketMapRunNodeEventsKey(runId: string, nodeId: string): string {
  return `${MARKET_MAP_KEY_PREFIX}:run:${runId}:events:${nodeId}`;
}

function isValidMarketMapVenue(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

export function normalizeMarketMapVenue(value: string): MarketMapVenue | null {
  const normalized = value.trim().toLowerCase();
  if (!isValidMarketMapVenue(normalized)) return null;
  return normalized;
}

export function normalizeMarketMapVenues(
  values: Iterable<string>,
): MarketMapVenue[] {
  const out: MarketMapVenue[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeMarketMapVenue(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function parseMarketMapVenuesQuery(
  raw: string | undefined,
): MarketMapVenue[] {
  if (!raw) return [];
  return normalizeMarketMapVenues(raw.split(","));
}

export function parseMarketMapParentsQuery(
  raw: string | undefined,
): Record<MarketMapVenue, string> {
  if (!raw) return {};
  const entries = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const out: Record<MarketMapVenue, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator >= entry.length - 1) continue;
    const venue = normalizeMarketMapVenue(entry.slice(0, separator));
    if (!venue) continue;
    const parentId = entry.slice(separator + 1).trim();
    if (!parentId) continue;
    out[venue] = parentId;
  }
  return out;
}

export function parseMarketMapParentIdQuery(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes("=")) return trimmed;
  const byVenue = parseMarketMapParentsQuery(trimmed);
  const first = Object.values(byVenue)[0];
  return first?.trim() ? first.trim() : null;
}

export function isMarketMapSizeBy(value: unknown): value is MarketMapSizeBy {
  return (
    typeof value === "string" &&
    (MARKET_MAP_SIZE_BY as readonly string[]).includes(value)
  );
}

export function parseMarketMapSizeBy(
  raw: string | undefined,
  fallback: MarketMapSizeBy,
): MarketMapSizeBy {
  if (!raw) return fallback;
  const normalized = raw.trim();
  return isMarketMapSizeBy(normalized) ? normalized : fallback;
}

export function metricForNode(node: MarketMapNode, sizeBy: MarketMapSizeBy): number {
  switch (sizeBy) {
    case "count":
      return node.eventCount;
    case "liquidity":
      return node.sumLiquidity;
    case "openInterest":
      return node.sumOpenInterest;
    case "volume24h":
    default:
      return node.sumVolume24h;
  }
}

export function aggregateNodeMetricsForVenues(
  node: MarketMapNode,
  venues: ReadonlySet<MarketMapVenue> | null,
): MarketMapNodeVenueMetrics {
  const breakdownEntries = Object.entries(node.venueBreakdown ?? {});
  if (!venues || venues.size === 0) {
    return {
      eventCount: node.eventCount,
      sumVolume24h: node.sumVolume24h,
      sumLiquidity: node.sumLiquidity,
      sumOpenInterest: node.sumOpenInterest,
    };
  }
  if (breakdownEntries.length === 0) {
    if (venues.has(node.venue)) {
      return {
        eventCount: node.eventCount,
        sumVolume24h: node.sumVolume24h,
        sumLiquidity: node.sumLiquidity,
        sumOpenInterest: node.sumOpenInterest,
      };
    }
    return {
      eventCount: 0,
      sumVolume24h: 0,
      sumLiquidity: 0,
      sumOpenInterest: 0,
    };
  }
  let eventCount = 0;
  let sumVolume24h = 0;
  let sumLiquidity = 0;
  let sumOpenInterest = 0;
  for (const [venue, metrics] of breakdownEntries) {
    if (!venues.has(venue)) continue;
    eventCount += metrics.eventCount;
    sumVolume24h += metrics.sumVolume24h;
    sumLiquidity += metrics.sumLiquidity;
    sumOpenInterest += metrics.sumOpenInterest;
  }
  return {
    eventCount,
    sumVolume24h,
    sumLiquidity,
    sumOpenInterest,
  };
}

export function applyVenueFilterToNode(
  node: MarketMapNode,
  venues: ReadonlySet<MarketMapVenue> | null,
): MarketMapNode {
  const metrics = aggregateNodeMetricsForVenues(node, venues);
  const breakdown = node.venueBreakdown ?? {};
  const breakdownEntries = Object.entries(breakdown);
  let dominantVenue: string | null = null;
  if (breakdownEntries.length > 0) {
    dominantVenue =
      breakdownEntries
        .filter(([venue]) => !venues || venues.size === 0 || venues.has(venue))
        .sort(
          (a, b) =>
            b[1].sumVolume24h - a[1].sumVolume24h ||
            b[1].eventCount - a[1].eventCount,
        )[0]?.[0] ?? null;
  } else if (!venues || venues.size === 0 || venues.has(node.venue)) {
    dominantVenue = node.venue;
  }
  const venueCount = Object.entries(breakdown).filter(
    ([venue, stats]) =>
      (!venues || venues.size === 0 || venues.has(venue)) && stats.eventCount > 0,
  ).length || ((dominantVenue && metrics.eventCount > 0) ? 1 : 0);
  return {
    ...node,
    venue: dominantVenue ?? node.venue,
    dominantVenue,
    venueCount,
    eventCount: metrics.eventCount,
    sumVolume24h: metrics.sumVolume24h,
    sumLiquidity: metrics.sumLiquidity,
    sumOpenInterest: metrics.sumOpenInterest,
  };
}

export function sortNodesByMetric(
  nodes: MarketMapNode[],
  sizeBy: MarketMapSizeBy,
): MarketMapNode[] {
  return nodes
    .slice()
    .sort((a, b) => metricForNode(b, sizeBy) - metricForNode(a, sizeBy));
}

export function mergeVenueNodeListsBalanced(params: {
  byVenue: Record<MarketMapVenue, MarketMapNode[]>;
  venues: MarketMapVenue[];
  sizeBy: MarketMapSizeBy;
  limit: number;
  perVenueMin: number;
}): MarketMapNode[] {
  const { byVenue, venues, sizeBy } = params;
  const limit = Math.max(1, Math.trunc(params.limit));
  const venueCount = Math.max(1, venues.length);
  const requestedMin = Math.max(0, Math.trunc(params.perVenueMin));
  const effectiveMin = Math.min(requestedMin, Math.floor(limit / venueCount));

  const sortedByVenue: Record<MarketMapVenue, MarketMapNode[]> = {};
  for (const venue of venues) {
    sortedByVenue[venue] = sortNodesByMetric(byVenue[venue] ?? [], sizeBy);
  }

  const taken = new Set<string>();
  const merged: MarketMapNode[] = [];

  for (const venue of venues) {
    if (merged.length >= limit) break;
    const rows = sortedByVenue[venue];
    for (let i = 0; i < rows.length && i < effectiveMin; i += 1) {
      const row = rows[i];
      if (taken.has(row.id)) continue;
      merged.push(row);
      taken.add(row.id);
      if (merged.length >= limit) break;
    }
  }

  if (merged.length >= limit) return merged.slice(0, limit);

  const all = venues
    .flatMap((venue) => sortedByVenue[venue])
    .filter((row) => !taken.has(row.id))
    .sort((a, b) => metricForNode(b, sizeBy) - metricForNode(a, sizeBy));

  for (const row of all) {
    if (merged.length >= limit) break;
    merged.push(row);
  }
  return merged.slice(0, limit);
}

export function safeJsonParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function buildMarketMapNodeId(input: {
  scope: string;
  level: number;
  parentId: string | null;
  eventIds: string[];
}): string {
  const sortedIds = input.eventIds.slice().sort();
  const hash = createHash("sha1")
    .update(input.scope)
    .update("|")
    .update(String(input.level))
    .update("|")
    .update(input.parentId ?? "root")
    .update("|")
    .update(sortedIds.join("|"))
    .digest("hex")
    .slice(0, 12);
  return `mm:v1:${input.scope}:${input.level}:${hash}`;
}

export function getVenueFromNodeId(nodeId: string): MarketMapVenue | null {
  const parts = nodeId.split(":");
  if (parts.length < 5) return null;
  const venue = parts[2];
  return normalizeMarketMapVenue(venue);
}
