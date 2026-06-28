import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import { requestMarketRefreshForMarketRefs } from "../lib/market-refresh.js";
import { isRecord } from "../lib/type-guards.js";
import { getRedisStatus } from "../redis.js";
import { fetchMarketSignalPricingByIds } from "../repos/unified-read.js";
import {
  marketMapSidebarsQuerySchema,
  marketMapNodeEventsQuerySchema,
  marketMapNodeParamsSchema,
  marketMapQuerySchema,
} from "../schemas/market-map.js";
import {
  applyVenueFilterToNode,
  type MarketMapEventMarketPreview,
  type MarketMapEventSummary,
  type MarketMapMeta,
  type MarketMapNode,
  type MarketMapSignalSummary,
  type MarketMapSignalTargetMarket,
  type MarketMapVenue,
  marketMapActiveKey,
  marketMapRunMetaKey,
  marketMapRunNodeEventsKey,
  marketMapRunNodeKey,
  marketMapRunNodesKey,
  marketMapRunNodesGlobalKey,
  parseMarketMapParentIdQuery,
  parseMarketMapSizeBy,
  parseMarketMapVenuesQuery,
  safeJsonParse,
  sortNodesByMetric,
} from "../services/market-map.js";
import {
  eventVenueKey,
  selectPreferredRepresentativeMarketsForEvents,
  selectRankedRepresentativeMarketsForEvents,
  type RankedRepresentativeMarket,
} from "../services/market-map-representative.js";
import {
  fetchMarketMapEventSparklines,
  type MarketMapSparklineOptions,
} from "../services/market-map-sparklines.js";
import {
  getMarketMapDropReason,
  type MarketMapDropReason,
} from "../services/market-map-quality.js";
import { resolveMarketMapPolicy } from "../services/runtime-policies.js";

function buildWeakEtag(body: string): string {
  return `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;
}

function buildPrivateCacheControl(ttlSec: number): string {
  return ttlSec > 0
    ? `private, max-age=${ttlSec}, stale-while-revalidate=${ttlSec * 2}`
    : "no-store";
}

function readRefreshString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function addMarketMapTokenRef(
  tokenRefs: Array<{ tokenId: string; venue: string | null }>,
  tokenId: unknown,
  venue: string | null,
): void {
  const normalized = readRefreshString(tokenId);
  if (!normalized) return;
  tokenRefs.push({ tokenId: normalized, venue });
}

function collectMarketMapRefreshRefs(
  value: unknown,
  refs: {
    tokenRefs: Array<{ tokenId: string; venue: string | null }>;
    marketIds: Set<string>;
  },
  venueHint: string | null = null,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectMarketMapRefreshRefs(entry, refs, venueHint);
    }
    return;
  }
  if (!isRecord(value)) return;

  const venue = readRefreshString(value.venue) ?? venueHint;
  addMarketMapTokenRef(refs.tokenRefs, value.tokenYes, venue);
  addMarketMapTokenRef(refs.tokenRefs, value.tokenNo, venue);

  for (const key of [
    "marketId",
    "representativeMarketId",
    "heroMarketId",
    "targetMarketId",
  ]) {
    const marketId = readRefreshString(value[key]);
    if (marketId) refs.marketIds.add(marketId);
  }

  for (const key of [
    "items",
    "eventsPreview",
    "marketsPreview",
    "trendingNow",
    "volumeMovers24h",
    "liquidityMovers24h",
    "topMovers24h",
    "signalsPreview",
    "childrenPreview",
  ]) {
    collectMarketMapRefreshRefs(value[key], refs, venue);
  }
  collectMarketMapRefreshRefs(value.targetMarket, refs, venue);
  collectMarketMapRefreshRefs(value.node, refs, venue);
}

function scheduleMarketMapRefreshCollection(
  logLabel: string,
  collect: () => void,
): void {
  setImmediate(() => {
    try {
      collect();
    } catch (error) {
      console.warn(`[${logLabel}] market refresh collect failed`, error);
    }
  });
}

function requestMarketMapPayloadRefreshNow(
  payload: unknown,
  logLabel: string,
): void {
  const refs = {
    tokenRefs: [] as Array<{ tokenId: string; venue: string | null }>,
    marketIds: new Set<string>(),
  };
  collectMarketMapRefreshRefs(payload, refs);
  requestMarketRefreshForMarketRefs({
    db: pool,
    tokenRefs: refs.tokenRefs,
    marketIds: Array.from(refs.marketIds),
    logLabel,
  });
}

function requestMarketMapPayloadRefresh(
  payload: unknown,
  logLabel: string,
): void {
  scheduleMarketMapRefreshCollection(logLabel, () => {
    requestMarketMapPayloadRefreshNow(payload, logLabel);
  });
}

function requestMarketMapBodyRefresh(body: string, logLabel: string): void {
  scheduleMarketMapRefreshCollection(logLabel, () => {
    const payload = safeJsonParse<unknown>(body);
    if (payload != null) requestMarketMapPayloadRefreshNow(payload, logLabel);
  });
}

function metricForEvent(
  event: MarketMapEventSummary,
  sizeBy: "count" | "volume24h" | "liquidity" | "openInterest",
): number {
  switch (sizeBy) {
    case "count":
      return 1;
    case "liquidity":
      return event.liquidity;
    case "openInterest":
      return event.openInterest;
    case "volume24h":
    default:
      return event.volume24h;
  }
}

type MarketMapNodeEventsSortBy = "volume24h" | "liquidity" | "openInterest";
type MarketMapNodeEventsSortDir = "asc" | "desc";

function compareNodeEventsBySort(params: {
  left: MarketMapEventSummary;
  right: MarketMapEventSummary;
  sortBy: MarketMapNodeEventsSortBy;
  sortDir: MarketMapNodeEventsSortDir;
}): number {
  const { left, right, sortBy, sortDir } = params;
  const leftMetric = metricForEvent(left, sortBy);
  const rightMetric = metricForEvent(right, sortBy);
  if (leftMetric !== rightMetric) {
    return sortDir === "asc"
      ? leftMetric - rightMetric
      : rightMetric - leftMetric;
  }
  if (right.score !== left.score) return right.score - left.score;
  return left.eventId.localeCompare(right.eventId);
}

function sortNodeEvents(params: {
  events: MarketMapEventSummary[];
  sortBy: MarketMapNodeEventsSortBy | null;
  sortDir: MarketMapNodeEventsSortDir;
}): MarketMapEventSummary[] {
  const { events, sortBy, sortDir } = params;
  if (!sortBy) return events;
  return events
    .slice()
    .sort((left, right) =>
      compareNodeEventsBySort({ left, right, sortBy, sortDir }),
    );
}

type MarketMapLiveMarketData = {
  marketId: string;
  marketTitle: string | null;
  marketImage: string | null;
  marketIcon: string | null;
  tradeType: string | null;
  marketAddress: string | null;
  closeTime: string | null;
  marketStatus: string | null;
  marketBestBid: number | null;
  marketBestAsk: number | null;
  lastPrice: number | null;
  change24h: number | null;
  tokenYes: string | null;
  tokenNo: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  acceptingOrders: boolean | null;
  resolvedOutcome: string | null;
  resolvedOutcomePct: number | null;
  volume24h: number;
  liquidity: number;
  openInterest: number;
  volumeLast24h: number | null;
  volumePrev24h: number | null;
  volumeLast24hChange: number | null;
  volumeLast24hChangePct: number | null;
  liquidityNow: number | null;
  liquidityChange24h: number | null;
  liquidityChangePct24h: number | null;
  openInterestNow: number | null;
  openInterestChange24h: number | null;
  openInterestChangePct24h: number | null;
  activityMetricsUpdatedAt: string | null;
  oddsSource: "representative" | "fallback";
};

type MarketMapLiveMarketBundle = {
  primaryByEventVenue: Map<string, MarketMapLiveMarketData>;
  marketsByEventVenue: Map<string, MarketMapEventMarketPreview[]>;
};

type MarketMapSignalType = "catalyst" | "risk" | "update";
type MarketMapSignalDirection = "up" | "down" | "mixed";

type MarketMapNodeSignalRow = {
  node_id: string;
  direct_count: unknown;
  title: string | null;
  description: string | null;
  signal_type: MarketMapSignalType | null;
  direction: MarketMapSignalDirection | null;
  confidence: unknown;
  created_at: Date | string;
  target_market_id: string | null;
  target_market_title: string | null;
  target_event_id: string | null;
  target_event_title: string | null;
  target_venue: string | null;
};

type MarketMapEventSignalRow = {
  event_id: string;
  signal_count: unknown;
  title: string | null;
  description: string | null;
  signal_type: MarketMapSignalType | null;
  direction: MarketMapSignalDirection | null;
  confidence: unknown;
  created_at: Date | string;
  target_market_id: string | null;
  target_market_title: string | null;
  target_event_id: string | null;
  target_event_title: string | null;
  target_venue: string | null;
};

type MarketMapEventActivityMetricsRow = {
  event_id: string;
  volume_last_24h: unknown;
  volume_prev_24h: unknown;
  volume_last_24h_change: unknown;
  volume_last_24h_change_pct: unknown;
  liquidity_now: unknown;
  liquidity_change_24h: unknown;
  liquidity_change_pct_24h: unknown;
  open_interest_now: unknown;
  open_interest_change_24h: unknown;
  open_interest_change_pct_24h: unknown;
  updated_at: Date | string | null;
};

type MarketMapEventActivityMetrics = {
  volumeLast24h: number | null;
  volumePrev24h: number | null;
  volumeLast24hChange: number | null;
  volumeLast24hChangePct: number | null;
  liquidityNow: number | null;
  liquidityChange24h: number | null;
  liquidityChangePct24h: number | null;
  openInterestNow: number | null;
  openInterestChange24h: number | null;
  openInterestChangePct24h: number | null;
  activityMetricsUpdatedAt: string | null;
};

type MarketMapSidebarKind =
  | "trendingNow"
  | "volumeMovers24h"
  | "volumeMoversAbsolute24h"
  | "liquidityMovers24h"
  | "liquidityMoversAbsolute24h"
  | "topMovers24h";

type MarketMapSidebarMoverSortBy = "percent" | "absolute";

type MarketMapSidebarEventRow = MarketMapEventActivityMetricsRow & {
  event_id: string;
  title: string | null;
  venue: string;
  start_time: Date | string | null;
  end_time: Date | string | null;
  event_image: string | null;
  event_icon: string | null;
  event_volume_24h: unknown;
  event_liquidity: unknown;
  event_open_interest: unknown;
  change_24h: unknown;
  score: unknown;
};

type MarketMapSignalPreviewSummary = {
  signalCount: number;
  signalsPreview: MarketMapSignalSummary[];
  topSignal: MarketMapSignalSummary | null;
};

type MarketMapSidebarQualityFloors = {
  minVolumeBase: number;
  minVolumeChangePct: number;
  minVolumeChangeAbs: number;
  minLiquidityBase: number;
  minLiquidityChangePct: number;
  minLiquidityChangeAbs: number;
};

const MARKET_MAP_SIGNALS_PREVIEW_LIMIT = 8;
const MARKET_MAP_COMPARABLE_LIQUIDITY_VENUES = new Set<string>(["polymarket"]);

function emptyMarketMapSidebarQualityFloors(): MarketMapSidebarQualityFloors {
  return {
    minVolumeBase: 0,
    minVolumeChangePct: 0,
    minVolumeChangeAbs: 0,
    minLiquidityBase: 0,
    minLiquidityChangePct: 0,
    minLiquidityChangeAbs: 0,
  };
}

type MarketMapDropReasonCounts = Record<MarketMapDropReason, number>;

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return new Date().toISOString();
  return new Date(parsed).toISOString();
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function normalizeEventActivityMetrics(
  row: MarketMapEventActivityMetricsRow,
): MarketMapEventActivityMetrics {
  return {
    volumeLast24h: toNumber(row.volume_last_24h),
    volumePrev24h: toNumber(row.volume_prev_24h),
    volumeLast24hChange: toNumber(row.volume_last_24h_change),
    volumeLast24hChangePct: toNumber(row.volume_last_24h_change_pct),
    liquidityNow: toNumber(row.liquidity_now),
    liquidityChange24h: toNumber(row.liquidity_change_24h),
    liquidityChangePct24h: toNumber(row.liquidity_change_pct_24h),
    openInterestNow: toNumber(row.open_interest_now),
    openInterestChange24h: toNumber(row.open_interest_change_24h),
    openInterestChangePct24h: toNumber(row.open_interest_change_pct_24h),
    activityMetricsUpdatedAt: toIsoStringOrNull(row.updated_at),
  };
}

async function loadEventActivityMetricsByEventId(
  eventIds: string[],
): Promise<Map<string, MarketMapEventActivityMetrics>> {
  const normalized = Array.from(
    new Set(eventIds.map((eventId) => eventId.trim()).filter(Boolean)),
  );
  const byEventId = new Map<string, MarketMapEventActivityMetrics>();
  if (normalized.length === 0) return byEventId;

  const { rows } = await pool.query<MarketMapEventActivityMetricsRow>(
    `
      select
        event_id,
        volume_last_24h,
        volume_prev_24h,
        volume_last_24h_change,
        volume_last_24h_change_pct,
        liquidity_now,
        liquidity_change_24h,
        liquidity_change_pct_24h,
        open_interest_now,
        open_interest_change_24h,
        open_interest_change_pct_24h,
        updated_at
      from unified_event_activity_metrics_24h
      where event_id = any($1::text[])
    `,
    [normalized],
  );

  for (const row of rows) {
    byEventId.set(row.event_id, normalizeEventActivityMetrics(row));
  }
  return byEventId;
}

function applyEventActivityMetricsToEvents(
  events: MarketMapEventSummary[],
  byEventId: ReadonlyMap<string, MarketMapEventActivityMetrics>,
): MarketMapEventSummary[] {
  if (byEventId.size === 0) return events;
  return events.map((event) => {
    const metrics = byEventId.get(event.eventId);
    return metrics ? { ...event, ...metrics } : event;
  });
}

function normalizeSidebarEventRow(
  row: MarketMapSidebarEventRow,
): MarketMapEventSummary {
  return {
    ...normalizeEventActivityMetrics(row),
    eventId: row.event_id,
    title: row.title?.trim() || row.event_id,
    venue: row.venue,
    startTime: toIsoStringOrNull(row.start_time),
    endTime: toIsoStringOrNull(row.end_time),
    closeTime: null,
    representativeMarketId: null,
    representativeMarketTitle: null,
    oddsSource: null,
    tokenYes: null,
    tokenNo: null,
    yesBid: null,
    yesAsk: null,
    noBid: null,
    noAsk: null,
    marketBestBid: null,
    marketBestAsk: null,
    lastPrice: null,
    change24h: toNumber(row.change_24h),
    tradeType: null,
    marketAddress: null,
    marketStatus: null,
    acceptingOrders: null,
    resolvedOutcome: null,
    resolvedOutcomePct: null,
    image: row.event_image,
    icon: row.event_icon,
    volume24h: toNumber(row.event_volume_24h) ?? 0,
    liquidity: toNumber(row.event_liquidity) ?? 0,
    openInterest: toNumber(row.event_open_interest) ?? 0,
    score: toNumber(row.score) ?? 0,
    x: 0,
    y: 0,
  };
}

function resolveMarketMapSidebarQualityFloors(policy: {
  minEventVolume24h: number;
  minEventLiquidity: number;
  minVolume24h?: number;
  minLiquidity?: number;
  minVolumeChange24h?: number;
  minVolumeChangePct24h?: number;
  minLiquidityChange24h?: number;
  minLiquidityChangePct24h?: number;
}): MarketMapSidebarQualityFloors {
  const minVolumeBase = Math.max(
    0,
    policy.minVolume24h ?? policy.minEventVolume24h,
  );
  const minLiquidityBase = Math.max(
    0,
    policy.minLiquidity ?? policy.minEventLiquidity,
  );
  return {
    minVolumeBase,
    minVolumeChangePct: Math.max(0, policy.minVolumeChangePct24h ?? 0),
    minVolumeChangeAbs: Math.max(0, policy.minVolumeChange24h ?? 0),
    minLiquidityBase,
    minLiquidityChangePct: Math.max(0, policy.minLiquidityChangePct24h ?? 0),
    minLiquidityChangeAbs: Math.max(0, policy.minLiquidityChange24h ?? 0),
  };
}

function marketMapSidebarQualityForKind(
  kind: MarketMapSidebarKind,
  quality: MarketMapSidebarQualityFloors,
): MarketMapSidebarQualityFloors {
  const scoped = emptyMarketMapSidebarQualityFloors();
  switch (kind) {
    case "volumeMovers24h":
    case "volumeMoversAbsolute24h":
      return {
        ...scoped,
        minVolumeBase: quality.minVolumeBase,
        minVolumeChangePct: quality.minVolumeChangePct,
        minVolumeChangeAbs: quality.minVolumeChangeAbs,
      };
    case "liquidityMovers24h":
    case "liquidityMoversAbsolute24h":
      return {
        ...scoped,
        minLiquidityBase: quality.minLiquidityBase,
        minLiquidityChangePct: quality.minLiquidityChangePct,
        minLiquidityChangeAbs: quality.minLiquidityChangeAbs,
      };
    case "topMovers24h":
    case "trendingNow":
    default:
      return {
        ...scoped,
        minVolumeBase: quality.minVolumeBase,
      };
  }
}

function marketMapSidebarVenuesForKind(
  kind: MarketMapSidebarKind,
  venues: string[],
): string[] {
  switch (kind) {
    case "liquidityMovers24h":
    case "liquidityMoversAbsolute24h":
      return venues.filter((venue) =>
        MARKET_MAP_COMPARABLE_LIQUIDITY_VENUES.has(venue),
      );
    case "trendingNow":
    case "volumeMovers24h":
    case "volumeMoversAbsolute24h":
    case "topMovers24h":
    default:
      return venues;
  }
}

function volumeSidebarKindForSort(
  sortBy: MarketMapSidebarMoverSortBy,
): MarketMapSidebarKind {
  return sortBy === "absolute" ? "volumeMoversAbsolute24h" : "volumeMovers24h";
}

function liquiditySidebarKindForSort(
  sortBy: MarketMapSidebarMoverSortBy,
): MarketMapSidebarKind {
  return sortBy === "absolute"
    ? "liquidityMoversAbsolute24h"
    : "liquidityMovers24h";
}

function resolveMarketMapSidebarLimit(
  value: number | undefined,
  fallback: number,
): number {
  return Math.max(0, Math.min(25, Math.trunc(value ?? fallback)));
}

function marketMapSidebarCandidateLimit(limit: number): number {
  return limit <= 0 ? 0 : Math.min(100, Math.max(limit * 5, limit));
}

function marketMapSidebarActivePrefilterLimit(limit: number): number {
  return limit <= 0 ? 0 : Math.min(1000, Math.max(limit * 10, limit));
}

function marketMapSparklinesEnabled(
  options: Pick<
    MarketMapSparklineOptions,
    "includeVolume" | "includeLiquidity" | "includeMovement"
  >,
): boolean {
  return (
    options.includeVolume || options.includeLiquidity || options.includeMovement
  );
}

function sidebarSqlParts(kind: MarketMapSidebarKind): {
  fromSql: string;
  filterSql: string;
  orderSql: string;
} {
  switch (kind) {
    case "volumeMovers24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.volume_valid is true
          and eam.volume_last_24h_change_pct is not null
          and eam.volume_last_24h >= $3::numeric
          and eam.volume_prev_24h >= $3::numeric
          and eam.volume_last_24h_change_pct >= $4::numeric
        `,
        orderSql: `
          eam.volume_last_24h_change_pct desc nulls last,
          eam.volume_last_24h desc nulls last
        `,
      };
    case "volumeMoversAbsolute24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.volume_valid is true
          and eam.volume_last_24h_change is not null
          and greatest(
            coalesce(eam.volume_last_24h, 0),
            coalesce(eam.volume_prev_24h, 0)
          ) >= $3::numeric
          and abs(eam.volume_last_24h_change) >= $5::numeric
        `,
        orderSql: `
          abs(eam.volume_last_24h_change) desc nulls last,
          eam.volume_last_24h desc nulls last
        `,
      };
    case "liquidityMovers24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.liquidity_valid is true
          and eam.liquidity_change_pct_24h is not null
          and eam.liquidity_now >= $6::numeric
          and eam.liquidity_24h_ago >= $6::numeric
          and eam.liquidity_change_pct_24h >= $7::numeric
        `,
        orderSql: `
          eam.liquidity_change_pct_24h desc nulls last,
          eam.liquidity_now desc nulls last
        `,
      };
    case "liquidityMoversAbsolute24h":
      return {
        fromSql: `
          from unified_event_activity_metrics_24h eam
          join unified_events e
            on e.id = eam.event_id
           and e.venue = eam.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
        `,
        filterSql: `
          and eam.venue = any($1::text[])
          and eam.liquidity_valid is true
          and eam.liquidity_change_24h is not null
          and greatest(
            coalesce(eam.liquidity_now, 0),
            coalesce(eam.liquidity_24h_ago, 0)
          ) >= $6::numeric
          and abs(eam.liquidity_change_24h) >= $8::numeric
        `,
        orderSql: `
          abs(eam.liquidity_change_24h) desc nulls last,
          eam.liquidity_now desc nulls last
        `,
      };
    case "topMovers24h":
      return {
        fromSql: `
          from unified_event_change_24h ec
          join unified_events e
            on e.id = ec.event_id
          left join unified_event_activity_metrics_24h eam
            on eam.event_id = e.id
           and eam.venue = e.venue
        `,
        filterSql: "and ec.change_24h is not null",
        orderSql: "ec.change_24h desc nulls last",
      };
    case "trendingNow":
    default:
      return {
        fromSql: `
          from unified_events e
          left join unified_event_activity_metrics_24h eam
            on eam.event_id = e.id
           and eam.venue = e.venue
          left join unified_event_change_24h ec
            on ec.event_id = e.id
        `,
        filterSql: "",
        orderSql: `
          coalesce(
            case when eam.volume_valid is true then eam.volume_last_24h else null end,
            e.volume_24h,
            0
          ) desc
        `,
      };
  }
}

function sidebarRankedOrderSql(kind: MarketMapSidebarKind): string {
  switch (kind) {
    case "volumeMovers24h":
      return `
        re.volume_last_24h_change_pct desc nulls last,
        re.volume_last_24h desc nulls last
      `;
    case "volumeMoversAbsolute24h":
      return `
        abs(re.volume_last_24h_change) desc nulls last,
        re.volume_last_24h desc nulls last
      `;
    case "liquidityMovers24h":
      return `
        re.liquidity_change_pct_24h desc nulls last,
        re.liquidity_now desc nulls last
      `;
    case "liquidityMoversAbsolute24h":
      return `
        abs(re.liquidity_change_24h) desc nulls last,
        re.liquidity_now desc nulls last
      `;
    case "topMovers24h":
      return "re.change_24h desc nulls last";
    case "trendingNow":
    default:
      return "re.score desc";
  }
}

async function loadMarketMapSidebarCandidates(params: {
  kind: MarketMapSidebarKind;
  venues: string[];
  limit: number;
  quality: MarketMapSidebarQualityFloors;
}): Promise<MarketMapEventSummary[]> {
  const { kind, venues, limit, quality } = params;
  if (venues.length === 0 || limit <= 0) return [];
  const { fromSql, filterSql, orderSql } = sidebarSqlParts(kind);
  const rankedOrderSql = sidebarRankedOrderSql(kind);
  const activePrefilterLimit = marketMapSidebarActivePrefilterLimit(limit);
  const { rows } = await pool.query<MarketMapSidebarEventRow>(
    `
      with ranked_events as materialized (
        select
          e.id as event_id,
          e.title,
          e.venue::text as venue,
          e.start_date as start_time,
          e.end_date as end_time,
          e.image as event_image,
          e.icon as event_icon,
          coalesce(e.volume_24h, 0) as event_volume_24h,
          coalesce(
            nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0),
            0
          ) as event_liquidity,
          coalesce(e.open_interest, 0) as event_open_interest,
          ec.change_24h,
          eam.volume_last_24h,
          eam.volume_prev_24h,
          eam.volume_last_24h_change,
          eam.volume_last_24h_change_pct,
          eam.liquidity_now,
          eam.liquidity_change_24h,
          eam.liquidity_change_pct_24h,
          eam.open_interest_now,
          eam.open_interest_change_24h,
          eam.open_interest_change_pct_24h,
          eam.updated_at,
          coalesce(
            case when eam.volume_valid is true then eam.volume_last_24h else null end,
            e.volume_24h,
            0
          )::double precision as score
        ${fromSql}
        where e.status = 'ACTIVE'
          and e.venue = any($1::text[])
          and (e.end_date is null or e.end_date > now())
          and $3::numeric >= 0
          and $4::numeric >= 0
          and $5::numeric >= 0
          and $6::numeric >= 0
          and $7::numeric >= 0
          and $8::numeric >= 0
          and (
            $3::numeric <= 0
            or coalesce(
              case when eam.volume_valid is true then eam.volume_last_24h else null end,
              e.volume_24h,
              0
            ) >= $3::numeric
          )
          and (
            $6::numeric <= 0
            or coalesce(
              eam.liquidity_now,
              nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0),
              0
            ) >= $6::numeric
          )
          ${filterSql}
        order by
          ${orderSql},
          e.id
        limit $9
      )
      select *
      from ranked_events re
      where exists (
        select 1
        from unified_markets m
        where m.event_id = re.event_id
          and m.venue = re.venue
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > now())
          and (m.close_time is null or m.close_time > now())
      )
      order by
        ${rankedOrderSql},
        re.event_id
      limit $2
    `,
    [
      venues,
      Math.max(1, Math.trunc(limit)),
      quality.minVolumeBase,
      quality.minVolumeChangePct,
      quality.minVolumeChangeAbs,
      quality.minLiquidityBase,
      quality.minLiquidityChangePct,
      quality.minLiquidityChangeAbs,
      activePrefilterLimit,
    ],
  );
  return rows.map(normalizeSidebarEventRow);
}

function dedupeEventsForLiveLookup(
  groups: ReadonlyArray<ReadonlyArray<MarketMapEventSummary>>,
): MarketMapEventSummary[] {
  const byKey = new Map<string, MarketMapEventSummary>();
  for (const group of groups) {
    for (const event of group) {
      const key = eventVenueKey(event.eventId, event.venue);
      if (!byKey.has(key)) byKey.set(key, event);
    }
  }
  return Array.from(byKey.values());
}

function applyMarketMapSparklinesToEvents(
  events: MarketMapEventSummary[],
  sparklinesByEvent: ReadonlyMap<
    string,
    MarketMapEventSummary["activitySparklines"]
  >,
): MarketMapEventSummary[] {
  if (sparklinesByEvent.size === 0) return events;
  return events.map((event) => {
    const sparklines = sparklinesByEvent.get(
      eventVenueKey(event.eventId, event.venue),
    );
    return sparklines ? { ...event, activitySparklines: sparklines } : event;
  });
}

function signalPreviewKey(signal: MarketMapSignalSummary): string {
  return [
    signal.createdAt,
    signal.title,
    signal.description ?? "",
    signal.signalType ?? "",
    signal.direction ?? "",
    signal.targetMarketId ?? "",
    signal.targetEventId ?? "",
    signal.targetVenue ?? "",
  ].join("|");
}

function mergeSignalsPreviewLists(params: {
  lists: ReadonlyArray<ReadonlyArray<MarketMapSignalSummary> | undefined>;
  limit: number;
}): MarketMapSignalSummary[] {
  const { lists, limit } = params;
  if (limit <= 0) return [];
  const byKey = new Map<string, MarketMapSignalSummary>();
  for (const list of lists) {
    if (!list || list.length === 0) continue;
    for (const signal of list) {
      const key = signalPreviewKey(signal);
      if (byKey.has(key)) continue;
      byKey.set(key, signal);
    }
  }
  return [...byKey.values()]
    .sort((left, right) => {
      const createdAtDiff =
        Date.parse(right.createdAt) - Date.parse(left.createdAt);
      if (createdAtDiff !== 0) return createdAtDiff;
      return right.title.localeCompare(left.title);
    })
    .slice(0, limit);
}

function normalizeSignalTargetMarket(params: {
  marketId: string;
  venue: string | null;
  marketStatus: string | null;
  pmAcceptingOrders: boolean | null;
  marketMetadata: unknown;
  closeTime: unknown;
  expirationTime: unknown;
  eventEndTime: unknown;
  bestBid: unknown;
  bestAsk: unknown;
  tokenYes: string | null;
  tokenNo: string | null;
  bestBidYes: unknown;
  bestAskYes: unknown;
  bestBidNo: unknown;
  bestAskNo: unknown;
  lastPrice: unknown;
  resolvedOutcome: string | null;
  resolvedOutcomePct: unknown;
}): MarketMapSignalTargetMarket {
  const yesBid = toNumber(params.bestBidYes) ?? toNumber(params.bestBid);
  const yesAsk = toNumber(params.bestAskYes) ?? toNumber(params.bestAsk);
  const noBid =
    toNumber(params.bestBidNo) ??
    (yesBid == null ? null : Math.max(0, Math.min(1, 1 - yesBid)));
  const noAsk =
    toNumber(params.bestAskNo) ??
    (yesAsk == null ? null : Math.max(0, Math.min(1, 1 - yesAsk)));

  return {
    marketId: params.marketId,
    marketStatus: params.marketStatus,
    marketBestBid: toNumber(params.bestBid),
    marketBestAsk: toNumber(params.bestAsk),
    lastPrice: toNumber(params.lastPrice),
    tokenYes: params.tokenYes,
    tokenNo: params.tokenNo,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    acceptingOrders: computeAcceptingOrders({
      venue: params.venue,
      status: params.marketStatus,
      closeTime: params.closeTime,
      expirationTime: params.expirationTime,
      eventEndTime: params.eventEndTime,
      pmAcceptingOrders: params.pmAcceptingOrders,
      dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(
        params.marketMetadata,
      ),
    }),
    resolvedOutcome: params.resolvedOutcome,
    resolvedOutcomePct: toNumber(params.resolvedOutcomePct),
  };
}

async function enrichSignalSummaryTargetMarkets(
  signals: Iterable<MarketMapSignalSummary>,
): Promise<void> {
  const signalList = Array.from(signals);
  if (signalList.length === 0) return;

  const marketIds = Array.from(
    new Set(
      signalList
        .map((signal) => signal.targetMarketId?.trim() || null)
        .filter((marketId): marketId is string => Boolean(marketId)),
    ),
  );
  if (marketIds.length === 0) {
    for (const signal of signalList) {
      signal.targetMarket = null;
    }
    return;
  }

  const rows = await fetchMarketSignalPricingByIds(pool, marketIds);
  const byMarketId = new Map<string, MarketMapSignalTargetMarket>();
  for (const row of rows) {
    byMarketId.set(
      row.market_id,
      normalizeSignalTargetMarket({
        marketId: row.market_id,
        venue: row.venue ?? null,
        marketStatus: row.market_status ?? null,
        pmAcceptingOrders: row.pm_accepting_orders ?? null,
        marketMetadata: row.market_metadata,
        closeTime: row.close_time,
        expirationTime: row.expiration_time,
        eventEndTime: row.event_end_time,
        bestBid: row.best_bid,
        bestAsk: row.best_ask,
        tokenYes: row.token_yes ?? null,
        tokenNo: row.token_no ?? null,
        bestBidYes: row.best_bid_yes,
        bestAskYes: row.best_ask_yes,
        bestBidNo: row.best_bid_no,
        bestAskNo: row.best_ask_no,
        lastPrice: row.last_price,
        resolvedOutcome: row.resolved_outcome ?? null,
        resolvedOutcomePct: row.resolved_outcome_pct,
      }),
    );
  }

  for (const signal of signalList) {
    const marketId = signal.targetMarketId?.trim() || null;
    signal.targetMarket = marketId ? (byMarketId.get(marketId) ?? null) : null;
  }
}

function normalizeLiveRow(
  row: RankedRepresentativeMarket,
  oddsSource: "representative" | "fallback",
): MarketMapLiveMarketData {
  return {
    marketId: row.marketId,
    marketTitle: row.marketTitle,
    marketImage: row.marketImage,
    marketIcon: row.marketIcon,
    tradeType: row.tradeType,
    marketAddress: row.marketAddress,
    closeTime: row.closeTime,
    marketStatus: row.marketStatus,
    marketBestBid: row.marketBestBid,
    marketBestAsk: row.marketBestAsk,
    lastPrice: row.lastPrice,
    change24h: row.change24h,
    tokenYes: row.tokenYes,
    tokenNo: row.tokenNo,
    yesBid: row.yesBid,
    yesAsk: row.yesAsk,
    noBid: row.noBid,
    noAsk: row.noAsk,
    acceptingOrders: row.acceptingOrders,
    resolvedOutcome: row.resolvedOutcome,
    resolvedOutcomePct: row.resolvedOutcomePct,
    volume24h: row.volume24h,
    liquidity: row.liquidity,
    openInterest: row.openInterest,
    volumeLast24h: row.volumeLast24h,
    volumePrev24h: row.volumePrev24h,
    volumeLast24hChange: row.volumeLast24hChange,
    volumeLast24hChangePct: row.volumeLast24hChangePct,
    liquidityNow: row.liquidityNow,
    liquidityChange24h: row.liquidityChange24h,
    liquidityChangePct24h: row.liquidityChangePct24h,
    openInterestNow: row.openInterestNow,
    openInterestChange24h: row.openInterestChange24h,
    openInterestChangePct24h: row.openInterestChangePct24h,
    activityMetricsUpdatedAt: row.activityMetricsUpdatedAt,
    oddsSource,
  };
}

function normalizePreviewMarketRow(
  row: RankedRepresentativeMarket,
): MarketMapEventMarketPreview {
  return {
    marketId: row.marketId,
    marketTitle: row.marketTitle,
    marketImage: row.marketImage,
    marketIcon: row.marketIcon,
    tradeType: row.tradeType,
    marketAddress: row.marketAddress,
    closeTime: row.closeTime,
    marketStatus: row.marketStatus,
    marketBestBid: row.marketBestBid,
    marketBestAsk: row.marketBestAsk,
    lastPrice: row.lastPrice,
    change24h: row.change24h,
    tokenYes: row.tokenYes,
    tokenNo: row.tokenNo,
    yesBid: row.yesBid,
    yesAsk: row.yesAsk,
    noBid: row.noBid,
    noAsk: row.noAsk,
    acceptingOrders: row.acceptingOrders,
    resolvedOutcome: row.resolvedOutcome,
    resolvedOutcomePct: row.resolvedOutcomePct,
    volume24h: row.volume24h,
    volumeTotal: row.volumeTotal,
    liquidity: row.liquidity,
    openInterest: row.openInterest,
    volumeLast24h: row.volumeLast24h,
    volumePrev24h: row.volumePrev24h,
    volumeLast24hChange: row.volumeLast24hChange,
    volumeLast24hChangePct: row.volumeLast24hChangePct,
    liquidityNow: row.liquidityNow,
    liquidityChange24h: row.liquidityChange24h,
    liquidityChangePct24h: row.liquidityChangePct24h,
    openInterestNow: row.openInterestNow,
    openInterestChange24h: row.openInterestChange24h,
    openInterestChangePct24h: row.openInterestChangePct24h,
    activityMetricsUpdatedAt: row.activityMetricsUpdatedAt,
  };
}

function emptyDropReasonCounts(): MarketMapDropReasonCounts {
  return {
    missing_token_pair: 0,
    untradeable: 0,
    missing_odds: 0,
  };
}

function incrementDropReason(
  counts: MarketMapDropReasonCounts,
  reason: MarketMapDropReason,
): void {
  counts[reason] += 1;
}

function getMarketMapEventDropReason(
  event: MarketMapEventSummary,
): MarketMapDropReason | null {
  return getMarketMapDropReason({
    tokenYes: event.tokenYes ?? null,
    tokenNo: event.tokenNo ?? null,
    acceptingOrders: event.acceptingOrders ?? null,
    marketStatus: event.marketStatus ?? null,
    yesBid: event.yesBid ?? null,
    yesAsk: event.yesAsk ?? null,
    noBid: event.noBid ?? null,
    noAsk: event.noAsk ?? null,
    marketBestBid: event.marketBestBid ?? null,
    marketBestAsk: event.marketBestAsk ?? null,
    lastPrice: event.lastPrice ?? null,
    closeTime: event.closeTime ?? event.endTime ?? null,
    expirationTime: null,
    resolvedOutcome: event.resolvedOutcome ?? null,
    resolvedOutcomePct: event.resolvedOutcomePct ?? null,
  });
}

function filterUsableEvents(events: MarketMapEventSummary[]): {
  items: MarketMapEventSummary[];
  dropped: number;
  droppedReasons: MarketMapDropReasonCounts;
} {
  const items: MarketMapEventSummary[] = [];
  const droppedReasons = emptyDropReasonCounts();
  let dropped = 0;
  for (const event of events) {
    const reason = getMarketMapEventDropReason(event);
    if (!reason) {
      items.push(event);
      continue;
    }
    dropped += 1;
    incrementDropReason(droppedReasons, reason);
  }
  return { items, dropped, droppedReasons };
}

async function loadNodeSignalSummaryByNodeId(params: {
  runId: string;
  nodeIds: string[];
  previewLimit?: number;
}): Promise<{
  directCountByNodeId: Map<string, number>;
  signalsPreviewByNodeId: Map<string, MarketMapSignalSummary[]>;
  topSignalByNodeId: Map<string, MarketMapSignalSummary>;
}> {
  const { runId, nodeIds, previewLimit = 1 } = params;
  const directCountByNodeId = new Map<string, number>();
  const signalsPreviewByNodeId = new Map<string, MarketMapSignalSummary[]>();
  const topSignalByNodeId = new Map<string, MarketMapSignalSummary>();
  if (nodeIds.length === 0) {
    return { directCountByNodeId, signalsPreviewByNodeId, topSignalByNodeId };
  }

  const { rows } = await pool.query<MarketMapNodeSignalRow>(
    `
    with candidates as (
      select
        n.id as note_id,
        t.target_id as node_id,
        count(*) over (partition by t.target_id) as direct_count,
        n.title,
        n.description,
        n.signal_type,
        n.direction,
        n.confidence,
        n.created_at
      from ai_note_targets t
      join ai_notes n
        on n.id = t.note_id
      where t.target_kind = 'node'
        and t.target_id = any($1::text[])
        and n.note_type = 'signal'
        and n.producer_type = 'map_signals'
        and n.status = 'active'
        and coalesce(n.lineage->>'map_run_id', '') = $2
    ),
    dedup as (
      select
        c.note_id,
        c.node_id,
        c.direct_count,
        c.title,
        c.description,
        c.signal_type,
        c.direction,
        c.confidence,
        c.created_at,
        max(t.target_id) filter (
          where t.target_kind = 'market' and coalesce(t.is_primary, false)
        ) as target_market_id,
        max(coalesce(t.target_meta->>'target_market_title', m.title)) filter (
          where t.target_kind = 'market' and coalesce(t.is_primary, false)
        ) as target_market_title,
        max(coalesce(t.target_meta->>'target_venue', m.venue)) filter (
          where t.target_kind = 'market' and coalesce(t.is_primary, false)
        ) as target_venue,
        coalesce(
          max(t.target_id) filter (where t.target_kind = 'event'),
          max(m.event_id) filter (
            where t.target_kind = 'market' and coalesce(t.is_primary, false)
          )
        ) as target_event_id,
        coalesce(
          max(coalesce(t.target_meta->>'target_event_title', e.title)) filter (
            where t.target_kind = 'event'
          ),
          max(coalesce(t.target_meta->>'target_event_title', me.title)) filter (
            where t.target_kind = 'market' and coalesce(t.is_primary, false)
          )
        ) as target_event_title
      from candidates c
      left join ai_note_targets t
        on t.note_id = c.note_id
       and t.target_kind in ('market', 'event')
      left join unified_markets m
        on t.target_kind = 'market'
       and m.id = t.target_id
      left join unified_events me
        on t.target_kind = 'market'
       and me.id = m.event_id
      left join unified_events e
        on t.target_kind = 'event'
       and e.id = t.target_id
      group by
        c.note_id,
        c.node_id,
        c.direct_count,
        c.title,
        c.description,
        c.signal_type,
        c.direction,
        c.confidence,
        c.created_at
    ),
    ranked as (
      select
        node_id,
        direct_count,
        title,
        description,
        signal_type,
        direction,
        confidence,
        created_at,
        target_market_id,
        target_market_title,
        target_event_id,
        target_event_title,
        target_venue,
        row_number() over (
          partition by node_id
          order by created_at desc, note_id desc
        ) as rn
      from dedup
    )
    select
      node_id,
      direct_count,
      title,
      description,
      signal_type,
      direction,
      confidence,
      created_at,
      target_market_id,
      target_market_title,
      target_event_id,
      target_event_title,
      target_venue
    from ranked
    where rn <= $3
    order by node_id, rn
    `,
    [nodeIds, runId, Math.max(1, Math.trunc(previewLimit))],
  );

  const signalsToEnrich: MarketMapSignalSummary[] = [];
  for (const row of rows) {
    const directCount = Math.max(
      0,
      Math.trunc(toNumber(row.direct_count) ?? 0),
    );
    directCountByNodeId.set(row.node_id, directCount);
    const signal: MarketMapSignalSummary = {
      title: row.title?.trim() || "AI signal",
      description: row.description?.trim() || null,
      signalType: row.signal_type ?? null,
      direction: row.direction ?? null,
      confidence: toNumber(row.confidence),
      createdAt: toIsoString(row.created_at),
      targetMarketId: row.target_market_id ?? null,
      targetMarketTitle: row.target_market_title?.trim() || null,
      targetEventId: row.target_event_id ?? null,
      targetEventTitle: row.target_event_title?.trim() || null,
      targetVenue: row.target_venue?.trim() || null,
    };
    const current = signalsPreviewByNodeId.get(row.node_id) ?? [];
    current.push(signal);
    signalsPreviewByNodeId.set(row.node_id, current);
    signalsToEnrich.push(signal);
  }

  await enrichSignalSummaryTargetMarkets(signalsToEnrich);

  for (const [nodeId, signalsPreview] of signalsPreviewByNodeId) {
    const topSignal = signalsPreview[0];
    if (topSignal) {
      topSignalByNodeId.set(nodeId, topSignal);
    }
  }

  return { directCountByNodeId, signalsPreviewByNodeId, topSignalByNodeId };
}

function computeNodeSignalSubtreeCounts(
  nodes: MarketMapNode[],
  directCountByNodeId: ReadonlyMap<string, number>,
): Map<string, number> {
  const byParentId = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const existing = byParentId.get(node.parentId) ?? [];
    existing.push(node.id);
    byParentId.set(node.parentId, existing);
  }

  const memo = new Map<string, number>();
  const inProgress = new Set<string>();
  const dfs = (nodeId: string): number => {
    const cached = memo.get(nodeId);
    if (cached != null) return cached;
    if (inProgress.has(nodeId)) {
      const fallback = Math.max(
        0,
        Math.trunc(directCountByNodeId.get(nodeId) ?? 0),
      );
      memo.set(nodeId, fallback);
      return fallback;
    }
    inProgress.add(nodeId);
    let total = Math.max(0, Math.trunc(directCountByNodeId.get(nodeId) ?? 0));
    for (const childId of byParentId.get(nodeId) ?? []) {
      total += dfs(childId);
    }
    inProgress.delete(nodeId);
    memo.set(nodeId, total);
    return total;
  };

  for (const node of nodes) dfs(node.id);
  return memo;
}

function applySignalSummaryToNodes(params: {
  nodes: MarketMapNode[];
  directCountByNodeId: ReadonlyMap<string, number>;
  subtreeCountByNodeId: ReadonlyMap<string, number>;
  signalsPreviewByNodeId: ReadonlyMap<string, MarketMapSignalSummary[]>;
  topSignalByNodeId: ReadonlyMap<string, MarketMapSignalSummary>;
}): MarketMapNode[] {
  const {
    nodes,
    directCountByNodeId,
    subtreeCountByNodeId,
    signalsPreviewByNodeId,
    topSignalByNodeId,
  } = params;
  return nodes.map((node) => ({
    ...node,
    signalCountDirect: Math.max(
      0,
      Math.trunc(directCountByNodeId.get(node.id) ?? 0),
    ),
    signalCountSubtree: Math.max(
      0,
      Math.trunc(subtreeCountByNodeId.get(node.id) ?? 0),
    ),
    topSignal: topSignalByNodeId.get(node.id) ?? null,
    signalsPreview: signalsPreviewByNodeId.get(node.id),
  }));
}

async function loadEventSignalSummaryByEventId(params: {
  runId: string;
  eventIds: string[];
  previewLimit?: number;
}): Promise<Map<string, MarketMapSignalPreviewSummary>> {
  const { runId, eventIds, previewLimit = 1 } = params;
  const byEventId = new Map<string, MarketMapSignalPreviewSummary>();
  if (eventIds.length === 0) return byEventId;

  const { rows } = await pool.query<MarketMapEventSignalRow>(
    `
    with candidates as (
      select
        n.id as note_id,
        case
          when t.target_kind = 'event' then t.target_id
          else m.event_id
        end as event_id,
        n.title,
        n.description,
        n.signal_type,
        n.direction,
        n.confidence,
        n.created_at,
        t.target_kind,
        t.target_id,
        coalesce(t.is_primary, false) as is_primary,
        t.target_rank,
        t.target_meta,
        m.title as market_target_title,
        m.venue as market_target_venue
      from ai_note_targets t
      join ai_notes n
        on n.id = t.note_id
      left join unified_markets m
        on t.target_kind = 'market'
       and m.id = t.target_id
      where n.note_type = 'signal'
        and n.producer_type = 'map_signals'
        and n.status = 'active'
        and coalesce(n.lineage->>'map_run_id', '') = $2
        and (
          (t.target_kind = 'event' and t.target_id = any($1::text[]))
          or (t.target_kind = 'market' and m.event_id = any($1::text[]))
        )
    ),
    dedup as (
      select
        note_id,
        event_id,
        title,
        description,
        signal_type,
        direction,
        confidence,
        created_at,
        max(target_id) filter (
          where target_kind = 'market' and is_primary
        ) as target_market_id,
        max(coalesce(target_meta->>'target_market_title', market_target_title)) filter (
          where target_kind = 'market' and is_primary
        ) as target_market_title,
        max(coalesce(target_meta->>'target_venue', market_target_venue)) filter (
          where target_kind = 'market' and is_primary
        ) as target_venue,
        max(target_id) filter (
          where target_kind = 'event'
        ) as target_event_id,
        max(target_meta->>'target_event_title') filter (
          where target_kind = 'event'
        ) as target_event_title
      from candidates
      where event_id is not null
      group by
        note_id,
        event_id,
        title,
        description,
        signal_type,
        direction,
        confidence,
        created_at
    ),
    ranked as (
      select
        event_id,
        count(*) over (partition by event_id) as signal_count,
        title,
        description,
        signal_type,
        direction,
        confidence,
        created_at,
        target_market_id,
        target_market_title,
        coalesce(target_event_id, event_id) as target_event_id,
        target_event_title,
        target_venue,
        row_number() over (
          partition by event_id
          order by created_at desc, note_id desc
        ) as rn
      from dedup
    )
    select
      event_id,
      signal_count,
      title,
      description,
      signal_type,
      direction,
      confidence,
      created_at,
      target_market_id,
      target_market_title,
      target_event_id,
      target_event_title,
      target_venue
    from ranked
    where rn <= $3
    order by event_id, rn
    `,
    [eventIds, runId, Math.max(1, Math.trunc(previewLimit))],
  );

  const signalsToEnrich: MarketMapSignalSummary[] = [];
  for (const row of rows) {
    const current = byEventId.get(row.event_id) ?? {
      signalCount: Math.max(0, Math.trunc(toNumber(row.signal_count) ?? 0)),
      signalsPreview: [],
      topSignal: null,
    };
    const signal: MarketMapSignalSummary = {
      title: row.title?.trim() || "AI signal",
      description: row.description?.trim() || null,
      signalType: row.signal_type ?? null,
      direction: row.direction ?? null,
      confidence: toNumber(row.confidence),
      createdAt: toIsoString(row.created_at),
      targetMarketId: row.target_market_id ?? null,
      targetMarketTitle: row.target_market_title?.trim() || null,
      targetEventId: row.target_event_id ?? null,
      targetEventTitle: row.target_event_title?.trim() || null,
      targetVenue: row.target_venue?.trim() || null,
    };
    current.signalsPreview.push(signal);
    byEventId.set(row.event_id, current);
    signalsToEnrich.push(signal);
  }

  await enrichSignalSummaryTargetMarkets(signalsToEnrich);

  for (const summary of byEventId.values()) {
    summary.topSignal = summary.signalsPreview[0] ?? null;
  }

  return byEventId;
}

async function loadLeafSignalSummaryByNodeId(params: {
  runId: string;
  nodeIds: string[];
  previewLimit?: number;
  redis: {
    multi: () => {
      get: (key: string) => unknown;
      exec: () => Promise<unknown>;
    };
  };
}): Promise<{
  countByNodeId: Map<string, number>;
  signalsPreviewByNodeId: Map<string, MarketMapSignalSummary[]>;
  topSignalByNodeId: Map<string, MarketMapSignalSummary>;
}> {
  const { runId, nodeIds, previewLimit = 1, redis } = params;
  const countByNodeId = new Map<string, number>();
  const signalsPreviewByNodeId = new Map<string, MarketMapSignalSummary[]>();
  const topSignalByNodeId = new Map<string, MarketMapSignalSummary>();
  if (nodeIds.length === 0) {
    return { countByNodeId, signalsPreviewByNodeId, topSignalByNodeId };
  }

  const pipeline = redis.multi();
  for (const nodeId of nodeIds) {
    pipeline.get(marketMapRunNodeEventsKey(runId, nodeId));
  }
  const rawEvents = (await pipeline.exec()) as unknown as Array<string | null>;
  const eventIdsByNodeId = new Map<string, string[]>();
  const allEventIds = new Set<string>();

  for (let index = 0; index < nodeIds.length; index += 1) {
    const nodeId = nodeIds[index];
    const events =
      safeJsonParse<MarketMapEventSummary[]>(rawEvents[index]) ?? [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const event of events) {
      if (!event.eventId || seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      ids.push(event.eventId);
      allEventIds.add(event.eventId);
    }
    eventIdsByNodeId.set(nodeId, ids);
  }

  if (allEventIds.size === 0) {
    return { countByNodeId, signalsPreviewByNodeId, topSignalByNodeId };
  }

  const byEventId = await loadEventSignalSummaryByEventId({
    runId,
    eventIds: Array.from(allEventIds),
    previewLimit,
  });

  for (const nodeId of nodeIds) {
    const eventIds = eventIdsByNodeId.get(nodeId) ?? [];
    let total = 0;
    const mergedSignals: MarketMapSignalSummary[][] = [];
    for (const eventId of eventIds) {
      const summary = byEventId.get(eventId);
      if (!summary) continue;
      total += Math.max(0, Math.trunc(summary.signalCount ?? 0));
      mergedSignals.push(summary.signalsPreview);
    }
    countByNodeId.set(nodeId, total);
    const signalsPreview = mergeSignalsPreviewLists({
      lists: mergedSignals,
      limit: Math.max(1, Math.trunc(previewLimit)),
    });
    if (signalsPreview.length > 0) {
      signalsPreviewByNodeId.set(nodeId, signalsPreview);
    }
    const topSignal = signalsPreview[0] ?? null;
    if (topSignal) {
      topSignalByNodeId.set(nodeId, topSignal);
    }
  }

  return { countByNodeId, signalsPreviewByNodeId, topSignalByNodeId };
}

function applySignalSummaryToEvents(
  events: MarketMapEventSummary[],
  byEventId: ReadonlyMap<string, MarketMapSignalPreviewSummary>,
): MarketMapEventSummary[] {
  return events.map((event) => {
    const summary = byEventId.get(event.eventId);
    return {
      ...event,
      signalCount: summary?.signalCount ?? 0,
      topSignal: summary?.topSignal ?? null,
      signalsPreview: summary?.signalsPreview,
    };
  });
}

async function loadLiveMarketDataForEvents(
  events: MarketMapEventSummary[],
  perEventLimit = 1,
): Promise<MarketMapLiveMarketBundle> {
  const primaryByEventVenue = new Map<string, MarketMapLiveMarketData>();
  const marketsByEventVenue = new Map<string, MarketMapEventMarketPreview[]>();
  if (events.length === 0) {
    return { primaryByEventVenue, marketsByEventVenue };
  }

  const preferredByEventVenue = new Map<string, string | null>();
  const inputs = events.map((event) => {
    const key = eventVenueKey(event.eventId, event.venue);
    const preferredMarketId = event.representativeMarketId ?? null;
    preferredByEventVenue.set(key, preferredMarketId);
    return {
      eventId: event.eventId,
      venue: event.venue,
      preferredMarketId,
    };
  });

  const ranked = await selectRankedRepresentativeMarketsForEvents(
    pool,
    inputs,
    Math.max(1, Math.trunc(perEventLimit)),
  );

  for (const row of ranked) {
    const key = eventVenueKey(row.eventId, row.venue);
    const existingMarkets = marketsByEventVenue.get(key) ?? [];
    existingMarkets.push(normalizePreviewMarketRow(row));
    marketsByEventVenue.set(key, existingMarkets);
    if (primaryByEventVenue.has(key)) continue;
    const preferredMarketId = preferredByEventVenue.get(key) ?? null;
    const oddsSource =
      preferredMarketId != null && row.marketId === preferredMarketId
        ? "representative"
        : "fallback";
    primaryByEventVenue.set(key, normalizeLiveRow(row, oddsSource));
  }

  return { primaryByEventVenue, marketsByEventVenue };
}

async function loadPrimaryLiveMarketDataForEvents(
  events: MarketMapEventSummary[],
): Promise<MarketMapLiveMarketBundle> {
  const primaryByEventVenue = new Map<string, MarketMapLiveMarketData>();
  const marketsByEventVenue = new Map<string, MarketMapEventMarketPreview[]>();
  if (events.length === 0) {
    return { primaryByEventVenue, marketsByEventVenue };
  }

  const preferredByEventVenue = new Map<string, string | null>();
  const inputs = events.map((event) => {
    const key = eventVenueKey(event.eventId, event.venue);
    const preferredMarketId = event.representativeMarketId ?? null;
    preferredByEventVenue.set(key, preferredMarketId);
    return {
      eventId: event.eventId,
      venue: event.venue,
      preferredMarketId,
    };
  });

  const directRows = await selectPreferredRepresentativeMarketsForEvents(
    pool,
    inputs,
  );
  for (const row of directRows) {
    const key = eventVenueKey(row.eventId, row.venue);
    if (primaryByEventVenue.has(key)) continue;
    primaryByEventVenue.set(key, normalizeLiveRow(row, "representative"));
    marketsByEventVenue.set(key, [normalizePreviewMarketRow(row)]);
  }

  const fallbackInputs = inputs.filter(
    (input) =>
      !primaryByEventVenue.has(eventVenueKey(input.eventId, input.venue)),
  );
  if (fallbackInputs.length > 0) {
    const fallbackRows = await selectRankedRepresentativeMarketsForEvents(
      pool,
      fallbackInputs,
      1,
    );
    for (const row of fallbackRows) {
      const key = eventVenueKey(row.eventId, row.venue);
      if (primaryByEventVenue.has(key)) continue;
      const preferredMarketId = preferredByEventVenue.get(key) ?? null;
      const oddsSource =
        preferredMarketId != null && row.marketId === preferredMarketId
          ? "representative"
          : "fallback";
      primaryByEventVenue.set(key, normalizeLiveRow(row, oddsSource));
      marketsByEventVenue.set(key, [normalizePreviewMarketRow(row)]);
    }
  }

  return { primaryByEventVenue, marketsByEventVenue };
}

function applyLiveMarketDataToEvents(
  events: MarketMapEventSummary[],
  primaryByEventVenue: ReadonlyMap<string, MarketMapLiveMarketData>,
  marketsByEventVenue: ReadonlyMap<string, MarketMapEventMarketPreview[]>,
): MarketMapEventSummary[] {
  return events.map((event) => {
    const key = eventVenueKey(event.eventId, event.venue);
    const live = primaryByEventVenue.get(key);
    const marketsPreview =
      marketsByEventVenue.get(key) ?? event.marketsPreview ?? [];
    if (!live) return event;
    const liquidityFallback =
      event.liquidity > 0
        ? event.liquidity
        : live.liquidity > 0
          ? live.liquidity
          : live.openInterest > 0
            ? live.openInterest
            : 0;
    const eventOpenInterest =
      event.venue === "limitless" &&
      event.openInterest === event.liquidity &&
      live.openInterest <= 0
        ? 0
        : event.openInterest;
    const openInterestValue =
      eventOpenInterest > 0
        ? eventOpenInterest
        : live.openInterest > 0
          ? live.openInterest
          : 0;
    return {
      ...event,
      representativeMarketId: live.marketId,
      representativeMarketTitle:
        live.marketTitle ?? event.representativeMarketTitle ?? null,
      image: event.image ?? live.marketImage,
      icon: event.icon ?? live.marketIcon,
      marketsPreview,
      oddsSource: live.oddsSource,
      closeTime: live.closeTime ?? event.closeTime ?? null,
      liquidity: liquidityFallback,
      openInterest: openInterestValue,
      tokenYes: live.tokenYes,
      tokenNo: live.tokenNo,
      yesBid: live.yesBid,
      yesAsk: live.yesAsk,
      noBid: live.noBid,
      noAsk: live.noAsk,
      marketBestBid: live.marketBestBid,
      marketBestAsk: live.marketBestAsk,
      lastPrice: live.lastPrice,
      change24h: live.change24h ?? event.change24h,
      tradeType: live.tradeType,
      marketAddress: live.marketAddress,
      marketStatus: live.marketStatus,
      acceptingOrders: live.acceptingOrders,
      resolvedOutcome: live.resolvedOutcome,
      resolvedOutcomePct: live.resolvedOutcomePct,
    };
  });
}

export const marketMapRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/market-map",
    { schema: { querystring: marketMapQuerySchema } },
    async (request, reply) => {
      const policy = await resolveMarketMapPolicy(pool);
      const effective = policy.effective;
      const query = request.query;
      const level = query.level ?? 1;
      const parentId = parseMarketMapParentIdQuery(query.parent);

      if (!effective.enabled) {
        return {
          enabled: false,
          runId: null,
          generatedAt: null,
          version: null,
          projectionMethod: null,
          projectionFallback: null,
          venues: [] as string[],
          level,
          items: [] as MarketMapNode[],
          defaults: {
            sizeBy: effective.sizeByDefault,
            limit: effective.mergeLimitDefault,
            perVenueMin: effective.mergePerVenueMinDefault,
          },
        };
      }

      const requestedVenues = parseMarketMapVenuesQuery(query.venues);
      const allowedVenueSet = new Set(effective.venuesEnabled);
      const venues =
        (requestedVenues.length > 0
          ? requestedVenues.filter((venue) => allowedVenueSet.has(venue))
          : effective.venuesEnabled
        ).slice() || [];
      if (venues.length === 0) {
        return reply.code(400).send({
          error: "No enabled venues selected for market map",
        });
      }

      if (level === 1 && parentId != null) {
        return reply.code(400).send({
          error: "Parent params are not allowed for level=1",
        });
      }

      if (level > 1) {
        if (!parentId) {
          return reply.code(400).send({
            error: "Missing parent when level > 1",
          });
        }
      }

      const sizeBy = parseMarketMapSizeBy(
        query.sizeBy,
        effective.sizeByDefault,
      );
      const limit = query.limit ?? effective.mergeLimitDefault;
      const perVenueMin =
        query.perVenueMin ?? effective.mergePerVenueMinDefault;
      const includeChildrenPreview = query.includeChildrenPreview ?? false;
      const childrenPreviewLimit = query.childrenPreviewLimit ?? 8;
      const includeEventsPreview =
        query.includeEventsPreview ?? query.includeLeafEventsPreview ?? false;
      const eventsPreviewLimit =
        query.eventsPreviewLimit ?? query.leafEventsPreviewLimit ?? 10;
      const marketsPreviewLimit = query.marketsPreviewLimit ?? 8;
      const cacheEnabled = env.marketMapTtlSec > 0;
      const cacheTtl = cacheEnabled ? env.marketMapTtlSec : 0;
      const policyCacheVersion = [
        policy.source,
        policy.effectiveAt?.toISOString() ?? "none",
        effective.sizeByDefault,
        String(effective.mergeLimitDefault),
        String(effective.mergePerVenueMinDefault),
        effective.venuesEnabled.join(","),
      ].join(":");

      const { redis, status } = await getRedisStatus();
      if (!redis) {
        const error =
          status === "loading" ? "Redis loading, retry" : "Redis unavailable";
        return reply.code(503).send({ error });
      }

      const runId = await redis.get(marketMapActiveKey());
      if (!runId) {
        return {
          enabled: true,
          runId: null,
          generatedAt: null,
          version: null,
          projectionMethod: null,
          projectionFallback: null,
          venues,
          level,
          sizeBy,
          limit,
          perVenueMin,
          items: [] as MarketMapNode[],
          defaults: {
            sizeBy: effective.sizeByDefault,
            limit: effective.mergeLimitDefault,
            perVenueMin: effective.mergePerVenueMinDefault,
          },
        };
      }
      const cacheKey = [
        "market-map:v4",
        runId,
        policyCacheVersion,
        String(level),
        parentId ?? "",
        sizeBy,
        String(limit),
        String(perVenueMin),
        includeChildrenPreview ? "1" : "0",
        String(childrenPreviewLimit),
        includeEventsPreview ? "1" : "0",
        String(eventsPreviewLimit),
        String(marketsPreviewLimit),
        venues.slice().sort().join(","),
      ].join(":");
      let skipCacheWrite = false;
      if (cacheEnabled) {
        const cachedBody = await redis.get(cacheKey);
        if (cachedBody) {
          const etag = buildWeakEtag(cachedBody);
          requestMarketMapBodyRefresh(cachedBody, "market-map");
          if (request.headers["if-none-match"] === etag) {
            reply.header("ETag", etag);
            reply.code(304);
            return reply.send();
          }
          reply.header("x-cache", "hit");
          reply.header("ETag", etag);
          reply.header("Cache-Control", buildPrivateCacheControl(cacheTtl));
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedBody);
        }
      }

      const coldBuildStartedAt = Date.now();
      const coldPhaseTimings: Record<string, number> = {};
      const timeColdPhase = async <T>(
        label: string,
        fn: () => Promise<T>,
      ): Promise<T> => {
        const startedAt = Date.now();
        try {
          return await fn();
        } finally {
          coldPhaseTimings[label] =
            (coldPhaseTimings[label] ?? 0) + Date.now() - startedAt;
        }
      };
      let eventsPreviewRawCount = 0;
      let eventsPreviewDisplayedCount = 0;
      let eventsPreviewLiveDurationMs = 0;

      const pipeline = redis.multi();
      pipeline.get(marketMapRunMetaKey(runId));
      pipeline.get(marketMapRunNodesGlobalKey(runId));
      const raw = (await timeColdPhase("redis.snapshot", async () =>
        pipeline.exec(),
      )) as unknown as Array<string | null>;
      const meta = safeJsonParse<MarketMapMeta>(raw[0]);
      let allNodes = safeJsonParse<MarketMapNode[]>(raw[1]) ?? [];
      if (!raw[1]) {
        const legacy = redis.multi();
        for (const venue of effective.venuesEnabled) {
          legacy.get(marketMapRunNodesKey(runId, venue));
        }
        const legacyRaw = (await timeColdPhase("redis.legacyNodes", async () =>
          legacy.exec(),
        )) as unknown as Array<string | null>;
        allNodes = legacyRaw.flatMap(
          (value) => safeJsonParse<MarketMapNode[]>(value) ?? [],
        );
      }
      if (allNodes.length > 0) {
        const nodeSignalSummary = await timeColdPhase(
          "signals.globalNodeSummary",
          () =>
            loadNodeSignalSummaryByNodeId({
              runId,
              nodeIds: allNodes.map((node) => node.id),
              previewLimit: 1,
            }),
        );
        const subtreeCountByNodeId = computeNodeSignalSubtreeCounts(
          allNodes,
          nodeSignalSummary.directCountByNodeId,
        );
        allNodes = applySignalSummaryToNodes({
          nodes: allNodes,
          directCountByNodeId: nodeSignalSummary.directCountByNodeId,
          subtreeCountByNodeId,
          signalsPreviewByNodeId: nodeSignalSummary.signalsPreviewByNodeId,
          topSignalByNodeId: nodeSignalSummary.topSignalByNodeId,
        });
      }
      const selectedVenueSet = new Set<MarketMapVenue>(venues);
      const parentNode = parentId
        ? (allNodes.find((node) => node.id === parentId) ?? null)
        : null;
      if (level > 1) {
        if (!parentNode) {
          return reply.code(404).send({
            error: "Market map parent node not found in active snapshot",
            runId,
            level,
            parentId,
          });
        }
        if (parentNode.level !== level - 1) {
          return reply.code(400).send({
            error: `Market map parent level mismatch: expected level ${level - 1}, got ${parentNode.level}`,
            runId,
            level,
            parentId,
          });
        }
      }

      const levelNodes = allNodes.filter((node) => {
        if (node.level !== level) return false;
        if (level === 1) return node.parentId == null;
        return node.parentId === parentId;
      });

      const items = sortNodesByMetric(
        levelNodes
          .map((node) => applyVenueFilterToNode(node, selectedVenueSet))
          .filter((node) => node.eventCount > 0),
        sizeBy,
      ).slice(0, limit);

      const itemNodeSignalPreviewSummary =
        items.length > 0
          ? await timeColdPhase("signals.itemNodePreview", () =>
              loadNodeSignalSummaryByNodeId({
                runId,
                nodeIds: items.map((node) => node.id),
                previewLimit: MARKET_MAP_SIGNALS_PREVIEW_LIMIT,
              }),
            )
          : {
              directCountByNodeId: new Map<string, number>(),
              signalsPreviewByNodeId: new Map<
                string,
                MarketMapSignalSummary[]
              >(),
              topSignalByNodeId: new Map<string, MarketMapSignalSummary>(),
            };

      const itemsWithNodeSignalPreview = items.map((node) => ({
        ...node,
        signalsPreview:
          itemNodeSignalPreviewSummary.signalsPreviewByNodeId.get(node.id) ??
          node.signalsPreview,
        topSignal:
          itemNodeSignalPreviewSummary.signalsPreviewByNodeId.get(
            node.id,
          )?.[0] ??
          itemNodeSignalPreviewSummary.topSignalByNodeId.get(node.id) ??
          node.topSignal ??
          null,
      }));

      const itemsWithLeafSignals =
        level === 3 && itemsWithNodeSignalPreview.length > 0
          ? await (async () => {
              const leafSignalSummary = await timeColdPhase(
                "signals.level3LeafSummary",
                () =>
                  loadLeafSignalSummaryByNodeId({
                    runId,
                    nodeIds: itemsWithNodeSignalPreview.map((node) => node.id),
                    previewLimit: MARKET_MAP_SIGNALS_PREVIEW_LIMIT,
                    redis,
                  }),
              );
              return itemsWithNodeSignalPreview.map((node) => ({
                ...node,
                signalCountSubtree: Math.max(
                  0,
                  Math.max(
                    Math.trunc(node.signalCountSubtree ?? 0),
                    Math.trunc(
                      leafSignalSummary.countByNodeId.get(node.id) ?? 0,
                    ),
                  ),
                ),
                signalsPreview:
                  leafSignalSummary.signalsPreviewByNodeId.get(node.id) ??
                  node.signalsPreview,
                topSignal:
                  leafSignalSummary.signalsPreviewByNodeId.get(node.id)?.[0] ??
                  node.topSignal ??
                  leafSignalSummary.topSignalByNodeId.get(node.id) ??
                  null,
              }));
            })()
          : itemsWithNodeSignalPreview;

      const itemsWithPreview =
        includeChildrenPreview && level < 3
          ? (() => {
              const parentIds = new Set(
                itemsWithLeafSignals.map((node) => node.id),
              );
              const byParent = new Map<string, MarketMapNode[]>();
              for (const node of allNodes) {
                if (node.level !== level + 1) continue;
                if (!node.parentId) continue;
                if (!parentIds.has(node.parentId)) continue;
                const existing = byParent.get(node.parentId) ?? [];
                existing.push(node);
                byParent.set(node.parentId, existing);
              }

              return itemsWithLeafSignals.map((node) => {
                const children = sortNodesByMetric(
                  (byParent.get(node.id) ?? [])
                    .map((childNode) =>
                      applyVenueFilterToNode(childNode, selectedVenueSet),
                    )
                    .filter((childNode) => childNode.eventCount > 0),
                  sizeBy,
                ).slice(0, childrenPreviewLimit);
                return {
                  ...node,
                  childrenPreview: children,
                };
              });
            })()
          : itemsWithLeafSignals;

      const previewNodeIds = new Set<string>();
      for (const node of itemsWithPreview) {
        for (const child of node.childrenPreview ?? []) {
          previewNodeIds.add(child.id);
        }
      }
      const previewLeafSignalSummary =
        previewNodeIds.size > 0
          ? await timeColdPhase("signals.previewLeafSummary", () =>
              loadLeafSignalSummaryByNodeId({
                runId,
                nodeIds: Array.from(previewNodeIds),
                previewLimit: MARKET_MAP_SIGNALS_PREVIEW_LIMIT,
                redis,
              }),
            )
          : {
              countByNodeId: new Map<string, number>(),
              signalsPreviewByNodeId: new Map<
                string,
                MarketMapSignalSummary[]
              >(),
              topSignalByNodeId: new Map<string, MarketMapSignalSummary>(),
            };

      const itemsWithPreviewSignals = itemsWithPreview.map((node) => ({
        ...node,
        childrenPreview: (node.childrenPreview ?? []).map((childNode) => ({
          ...childNode,
          signalCountSubtree: Math.max(
            0,
            Math.max(
              Math.trunc(childNode.signalCountSubtree ?? 0),
              Math.trunc(
                previewLeafSignalSummary.countByNodeId.get(childNode.id) ?? 0,
              ),
            ),
          ),
          signalsPreview:
            previewLeafSignalSummary.signalsPreviewByNodeId.get(childNode.id) ??
            childNode.signalsPreview,
          topSignal:
            previewLeafSignalSummary.signalsPreviewByNodeId.get(
              childNode.id,
            )?.[0] ??
            childNode.topSignal ??
            previewLeafSignalSummary.topSignalByNodeId.get(childNode.id) ??
            null,
        })),
      }));

      const itemsWithEventsPreview =
        includeEventsPreview && itemsWithPreviewSignals.length > 0
          ? await (async () => {
              const pipeline = redis.multi();
              for (const node of itemsWithPreviewSignals) {
                pipeline.get(marketMapRunNodeEventsKey(runId, node.id));
              }
              const rawEvents = (await timeColdPhase(
                "redis.eventsPreview",
                async () => pipeline.exec(),
              )) as unknown as Array<string | null>;

              const eventsByNode = itemsWithPreviewSignals.map((_, index) => {
                const nodeEvents = (
                  safeJsonParse<MarketMapEventSummary[]>(rawEvents[index]) ?? []
                )
                  .filter((event) =>
                    selectedVenueSet.size === 0
                      ? true
                      : selectedVenueSet.has(event.venue),
                  )
                  .sort(
                    (a, b) =>
                      metricForEvent(b, sizeBy) - metricForEvent(a, sizeBy) ||
                      b.score - a.score ||
                      a.eventId.localeCompare(b.eventId),
                  );
                eventsPreviewRawCount += nodeEvents.length;
                return nodeEvents;
              });
              const allPreviewEvents = eventsByNode.flat();
              const canonicalPreviewEventByVenue = new Map<
                string,
                MarketMapEventSummary
              >();
              for (const event of allPreviewEvents) {
                const key = eventVenueKey(event.eventId, event.venue);
                if (!canonicalPreviewEventByVenue.has(key)) {
                  canonicalPreviewEventByVenue.set(key, event);
                }
              }

              const droppedReasons = emptyDropReasonCounts();
              let droppedPreviewEvents = 0;
              const selectedPreviewEventsByNode = eventsByNode.map(
                () => [] as MarketMapEventSummary[],
              );
              const cursors = eventsByNode.map(() => 0);
              const candidateBatchSize = Math.max(eventsPreviewLimit, 12);
              let liveEnrichmentFailed = false;

              while (!liveEnrichmentFailed) {
                const candidateEntries: Array<{
                  nodeIndex: number;
                  event: MarketMapEventSummary;
                }> = [];

                for (
                  let nodeIndex = 0;
                  nodeIndex < eventsByNode.length;
                  nodeIndex += 1
                ) {
                  if (
                    selectedPreviewEventsByNode[nodeIndex].length >=
                    eventsPreviewLimit
                  ) {
                    continue;
                  }
                  const nodeEvents = eventsByNode[nodeIndex];
                  let taken = 0;
                  while (
                    cursors[nodeIndex] < nodeEvents.length &&
                    taken < candidateBatchSize
                  ) {
                    candidateEntries.push({
                      nodeIndex,
                      event: nodeEvents[cursors[nodeIndex]],
                    });
                    cursors[nodeIndex] += 1;
                    taken += 1;
                  }
                }

                if (candidateEntries.length === 0) break;

                const candidates = candidateEntries.map((entry) => entry.event);
                const liveInputs = candidateEntries.map((entry) => {
                  const key = eventVenueKey(
                    entry.event.eventId,
                    entry.event.venue,
                  );
                  return canonicalPreviewEventByVenue.get(key) ?? entry.event;
                });
                let hydratedCandidates = candidates;
                const liveStartedAt = Date.now();
                try {
                  const liveBundle =
                    await loadPrimaryLiveMarketDataForEvents(liveInputs);
                  hydratedCandidates = applyLiveMarketDataToEvents(
                    candidates,
                    liveBundle.primaryByEventVenue,
                    liveBundle.marketsByEventVenue,
                  );
                } catch (error) {
                  liveEnrichmentFailed = true;
                  skipCacheWrite = true;
                  request.log.warn(
                    {
                      err: error,
                      level,
                      parentId,
                      nodeCount: itemsWithPreview.length,
                      previewEventCount: allPreviewEvents.length,
                      attemptedPreviewEventCount: candidates.length,
                    },
                    "market-map events preview live market enrichment failed",
                  );
                  break;
                } finally {
                  eventsPreviewLiveDurationMs += Date.now() - liveStartedAt;
                }

                for (
                  let index = 0;
                  index < hydratedCandidates.length;
                  index += 1
                ) {
                  const entry = candidateEntries[index];
                  const event = hydratedCandidates[index] ?? entry.event;
                  const reason = getMarketMapEventDropReason(event);
                  if (reason) {
                    droppedPreviewEvents += 1;
                    incrementDropReason(droppedReasons, reason);
                    continue;
                  }
                  const selected = selectedPreviewEventsByNode[entry.nodeIndex];
                  if (selected.length < eventsPreviewLimit) {
                    selected.push(event);
                  }
                }

                const needsMoreCandidates = eventsByNode.some(
                  (nodeEvents, nodeIndex) =>
                    selectedPreviewEventsByNode[nodeIndex].length <
                      eventsPreviewLimit &&
                    cursors[nodeIndex] < nodeEvents.length,
                );
                if (!needsMoreCandidates) break;
              }

              const previewItemsBeforeMetadata = liveEnrichmentFailed
                ? (() => {
                    const filteredPreviewEvents =
                      filterUsableEvents(allPreviewEvents);
                    droppedPreviewEvents = filteredPreviewEvents.dropped;
                    for (const reason of Object.keys(
                      filteredPreviewEvents.droppedReasons,
                    ) as MarketMapDropReason[]) {
                      droppedReasons[reason] +=
                        filteredPreviewEvents.droppedReasons[reason];
                    }

                    const usablePreviewEventByVenue = new Map<
                      string,
                      MarketMapEventSummary
                    >();
                    for (const event of filteredPreviewEvents.items) {
                      usablePreviewEventByVenue.set(
                        eventVenueKey(event.eventId, event.venue),
                        event,
                      );
                    }

                    return itemsWithPreviewSignals.map((node, index) => {
                      const eventsPreview = eventsByNode[index]
                        .map((event) =>
                          usablePreviewEventByVenue.get(
                            eventVenueKey(event.eventId, event.venue),
                          ),
                        )
                        .filter(
                          (event): event is MarketMapEventSummary =>
                            event != null,
                        )
                        .slice(0, eventsPreviewLimit);
                      return {
                        ...node,
                        eventsPreview,
                      };
                    });
                  })()
                : itemsWithPreviewSignals.map((node, index) => ({
                    ...node,
                    eventsPreview: selectedPreviewEventsByNode[index],
                  }));

              const displayedPreviewEvents = previewItemsBeforeMetadata.flatMap(
                (node) => node.eventsPreview ?? [],
              );
              eventsPreviewDisplayedCount = displayedPreviewEvents.length;
              const previewEventIds = Array.from(
                new Set(displayedPreviewEvents.map((event) => event.eventId)),
              );
              const eventSignalSummaryByEventId =
                previewEventIds.length > 0
                  ? await timeColdPhase("signals.previewEvents", () =>
                      loadEventSignalSummaryByEventId({
                        runId,
                        eventIds: previewEventIds,
                      }),
                    )
                  : new Map();
              const eventActivityMetricsByEventId = await timeColdPhase(
                "metrics.previewEvents",
                () => loadEventActivityMetricsByEventId(previewEventIds),
              );
              const eventsWithMetadata = applyEventActivityMetricsToEvents(
                applySignalSummaryToEvents(
                  displayedPreviewEvents,
                  eventSignalSummaryByEventId,
                ),
                eventActivityMetricsByEventId,
              );
              const eventWithMetadataByVenue = new Map<
                string,
                MarketMapEventSummary
              >();
              for (const event of eventsWithMetadata) {
                eventWithMetadataByVenue.set(
                  eventVenueKey(event.eventId, event.venue),
                  event,
                );
              }

              const previewItems = previewItemsBeforeMetadata.map((node) => ({
                ...node,
                eventsPreview: node.eventsPreview?.map(
                  (event) =>
                    eventWithMetadataByVenue.get(
                      eventVenueKey(event.eventId, event.venue),
                    ) ?? event,
                ),
              }));

              if (droppedPreviewEvents > 0) {
                request.log.info(
                  {
                    level,
                    parentId,
                    droppedPreviewEvents,
                    droppedReasons,
                    previewNodeCount: previewItems.length,
                  },
                  "market-map events preview quality gate dropped events",
                );
              }
              return previewItems;
            })()
          : itemsWithPreviewSignals;

      const countsByVenue: Record<MarketMapVenue, number> = Object.fromEntries(
        venues.map((venue) => [venue, 0]),
      );
      for (const node of levelNodes) {
        const breakdown = node.venueBreakdown ?? {};
        for (const venue of venues) {
          countsByVenue[venue] += breakdown[venue]?.eventCount ?? 0;
        }
      }

      const payload = {
        enabled: true,
        runId,
        generatedAt: meta?.generatedAt ?? null,
        version: meta?.version ?? null,
        projectionMethod: meta?.projectionMethod ?? null,
        projectionFallback: meta?.projectionFallback ?? null,
        venues,
        level,
        sizeBy,
        limit,
        perVenueMin,
        countsByVenue,
        items: itemsWithEventsPreview,
        defaults: {
          sizeBy: effective.sizeByDefault,
          limit: effective.mergeLimitDefault,
          perVenueMin: effective.mergePerVenueMinDefault,
        },
      };
      requestMarketMapPayloadRefresh(payload, "market-map");
      const body = JSON.stringify(payload);
      const coldBuildDurationMs = Date.now() - coldBuildStartedAt;
      if (coldBuildDurationMs > 1_000 || eventsPreviewLiveDurationMs > 500) {
        request.log.info(
          {
            level,
            parentId,
            sizeBy,
            itemCount: itemsWithEventsPreview.length,
            includeChildrenPreview,
            includeEventsPreview,
            childrenPreviewLimit,
            eventsPreviewLimit,
            marketsPreviewLimit,
            eventsPreviewRawCount,
            eventsPreviewDisplayedCount,
            eventsPreviewLiveDurationMs,
            coldPhaseTimings,
            coldBuildDurationMs,
          },
          "market-map cold build complete",
        );
      }
      const etag = buildWeakEtag(body);
      if (request.headers["if-none-match"] === etag) {
        reply.header("ETag", etag);
        reply.code(304);
        return reply.send();
      }
      if (cacheEnabled && !skipCacheWrite) {
        await redis.setEx(cacheKey, cacheTtl, body);
        reply.header("x-cache", "miss");
      } else if (cacheEnabled && skipCacheWrite) {
        reply.header("x-cache", "bypass");
      }
      reply.header("ETag", etag);
      reply.header("Cache-Control", buildPrivateCacheControl(cacheTtl));
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(body);
    },
  );

  z.get(
    "/market-map/sidebars",
    { schema: { querystring: marketMapSidebarsQuerySchema } },
    async (request, reply) => {
      const generatedAt = new Date().toISOString();
      const policy = await resolveMarketMapPolicy(pool);
      const emptyPayload = {
        trendingNow: [] as MarketMapEventSummary[],
        volumeMovers24h: [] as MarketMapEventSummary[],
        liquidityMovers24h: [] as MarketMapEventSummary[],
        topMovers24h: [] as MarketMapEventSummary[],
        generatedAt,
      };

      if (!policy.effective.enabled) {
        return emptyPayload;
      }

      const requestedVenues = parseMarketMapVenuesQuery(request.query.venues);
      const allowedVenueSet = new Set(policy.effective.venuesEnabled);
      const venues =
        requestedVenues.length > 0
          ? requestedVenues.filter((venue) => allowedVenueSet.has(venue))
          : policy.effective.venuesEnabled;
      if (venues.length === 0) {
        return reply.code(400).send({
          error: "No enabled venues selected for market map sidebars",
        });
      }

      const defaultLimit = request.query.limit ?? 5;
      const sidebarLimits = {
        trendingNow: resolveMarketMapSidebarLimit(
          request.query.trendingLimit,
          defaultLimit,
        ),
        volumeMovers24h: resolveMarketMapSidebarLimit(
          request.query.volumeMoversLimit,
          defaultLimit,
        ),
        liquidityMovers24h: resolveMarketMapSidebarLimit(
          request.query.liquidityMoversLimit,
          defaultLimit,
        ),
        topMovers24h: resolveMarketMapSidebarLimit(
          request.query.topMoversLimit,
          defaultLimit,
        ),
      };
      const volumeMoversSortBy = request.query.volumeMoversSortBy ?? "percent";
      const liquidityMoversSortBy =
        request.query.liquidityMoversSortBy ?? "percent";
      const volumeMoverKind = volumeSidebarKindForSort(volumeMoversSortBy);
      const liquidityMoverKind = liquiditySidebarKindForSort(
        liquidityMoversSortBy,
      );
      const sparklineOptions: MarketMapSparklineOptions = {
        includeVolume: request.query.includeVolumeSparkline,
        includeLiquidity: request.query.includeLiquiditySparkline,
        includeMovement: request.query.includeMovementSparkline,
        windowHours: request.query.sparklineWindowHours ?? 48,
        bucketHours: request.query.sparklineBucketHours,
      };
      const quality = resolveMarketMapSidebarQualityFloors({
        ...policy.effective,
        minVolume24h: request.query.minVolume24h,
        minLiquidity: request.query.minLiquidity,
        minVolumeChange24h: request.query.minVolumeChange24h,
        minVolumeChangePct24h: request.query.minVolumeChangePct24h,
        minLiquidityChange24h: request.query.minLiquidityChange24h,
        minLiquidityChangePct24h: request.query.minLiquidityChangePct24h,
      });
      const cacheEnabled = env.marketMapTtlSec > 0;
      const cacheTtl = cacheEnabled ? Math.min(env.marketMapTtlSec, 60) : 0;
      const policyCacheVersion = [
        policy.source,
        policy.effectiveAt?.toISOString() ?? "none",
        String(policy.effective.enabled),
        policy.effective.venuesEnabled.join(","),
        String(quality.minVolumeBase),
        String(quality.minVolumeChangePct),
        String(quality.minVolumeChangeAbs),
        String(quality.minLiquidityBase),
        String(quality.minLiquidityChangePct),
        String(quality.minLiquidityChangeAbs),
        String(sidebarLimits.trendingNow),
        String(sidebarLimits.volumeMovers24h),
        String(sidebarLimits.liquidityMovers24h),
        String(sidebarLimits.topMovers24h),
        volumeMoversSortBy,
        liquidityMoversSortBy,
        String(sparklineOptions.includeVolume),
        String(sparklineOptions.includeLiquidity),
        String(sparklineOptions.includeMovement),
        String(sparklineOptions.windowHours),
        String(sparklineOptions.bucketHours ?? "auto"),
      ].join(":");
      const cacheKey = [
        "market-map:sidebars:v4",
        policyCacheVersion,
        venues.slice().sort().join(","),
        String(defaultLimit),
      ].join(":");
      let sidebarRedis: Awaited<ReturnType<typeof getRedisStatus>>["redis"] =
        null;
      let skipCacheWrite = false;

      if (cacheEnabled) {
        const { redis } = await getRedisStatus();
        sidebarRedis = redis;
        if (sidebarRedis) {
          const cachedBody = await sidebarRedis.get(cacheKey);
          if (cachedBody) {
            const etag = buildWeakEtag(cachedBody);
            requestMarketMapBodyRefresh(cachedBody, "market-map:sidebars");
            if (request.headers["if-none-match"] === etag) {
              reply.header("ETag", etag);
              reply.code(304);
              return reply.send();
            }
            reply.header("x-cache", "hit");
            reply.header("ETag", etag);
            reply.header("Cache-Control", buildPrivateCacheControl(cacheTtl));
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send(cachedBody);
          }
        }
      }

      const [
        trendingCandidates,
        volumeMoverCandidates,
        liquidityMoverCandidates,
        topMoverCandidates,
      ] = await Promise.all([
        loadMarketMapSidebarCandidates({
          kind: "trendingNow",
          venues: marketMapSidebarVenuesForKind("trendingNow", venues),
          limit: marketMapSidebarCandidateLimit(sidebarLimits.trendingNow),
          quality: marketMapSidebarQualityForKind("trendingNow", quality),
        }),
        loadMarketMapSidebarCandidates({
          kind: volumeMoverKind,
          venues: marketMapSidebarVenuesForKind(volumeMoverKind, venues),
          limit: marketMapSidebarCandidateLimit(sidebarLimits.volumeMovers24h),
          quality: marketMapSidebarQualityForKind(volumeMoverKind, quality),
        }),
        loadMarketMapSidebarCandidates({
          kind: liquidityMoverKind,
          venues: marketMapSidebarVenuesForKind(liquidityMoverKind, venues),
          limit: marketMapSidebarCandidateLimit(
            sidebarLimits.liquidityMovers24h,
          ),
          quality: marketMapSidebarQualityForKind(liquidityMoverKind, quality),
        }),
        loadMarketMapSidebarCandidates({
          kind: "topMovers24h",
          venues: marketMapSidebarVenuesForKind("topMovers24h", venues),
          limit: marketMapSidebarCandidateLimit(sidebarLimits.topMovers24h),
          quality: marketMapSidebarQualityForKind("topMovers24h", quality),
        }),
      ]);

      const allCandidates = dedupeEventsForLiveLookup([
        trendingCandidates,
        volumeMoverCandidates,
        liquidityMoverCandidates,
        topMoverCandidates,
      ]);

      let liveBundle: MarketMapLiveMarketBundle | null = null;
      if (allCandidates.length > 0) {
        try {
          liveBundle = await loadLiveMarketDataForEvents(allCandidates, 1);
        } catch (error) {
          skipCacheWrite = true;
          request.log.warn(
            { err: error, itemCount: allCandidates.length },
            "market-map sidebars live market enrichment failed",
          );
        }
      }

      const hydrate = (
        events: MarketMapEventSummary[],
        limit: number,
      ): MarketMapEventSummary[] => {
        const withLive =
          liveBundle == null
            ? events
            : applyLiveMarketDataToEvents(
                events,
                liveBundle.primaryByEventVenue,
                liveBundle.marketsByEventVenue,
              );
        const filtered = filterUsableEvents(withLive).items;
        return filtered.slice(0, limit);
      };

      let payload = {
        trendingNow: hydrate(trendingCandidates, sidebarLimits.trendingNow),
        volumeMovers24h: hydrate(
          volumeMoverCandidates,
          sidebarLimits.volumeMovers24h,
        ),
        liquidityMovers24h: hydrate(
          liquidityMoverCandidates,
          sidebarLimits.liquidityMovers24h,
        ),
        topMovers24h: hydrate(topMoverCandidates, sidebarLimits.topMovers24h),
        generatedAt,
      };

      if (marketMapSparklinesEnabled(sparklineOptions)) {
        const returnedEvents = dedupeEventsForLiveLookup([
          payload.trendingNow,
          payload.volumeMovers24h,
          payload.liquidityMovers24h,
          payload.topMovers24h,
        ]);
        const sparklinesByEvent = await fetchMarketMapEventSparklines(
          pool,
          returnedEvents,
          sparklineOptions,
        );
        payload = {
          ...payload,
          trendingNow: applyMarketMapSparklinesToEvents(
            payload.trendingNow,
            sparklinesByEvent,
          ),
          volumeMovers24h: applyMarketMapSparklinesToEvents(
            payload.volumeMovers24h,
            sparklinesByEvent,
          ),
          liquidityMovers24h: applyMarketMapSparklinesToEvents(
            payload.liquidityMovers24h,
            sparklinesByEvent,
          ),
          topMovers24h: applyMarketMapSparklinesToEvents(
            payload.topMovers24h,
            sparklinesByEvent,
          ),
        };
      }
      requestMarketMapPayloadRefresh(payload, "market-map:sidebars");
      const body = JSON.stringify(payload);
      const etag = buildWeakEtag(body);
      if (request.headers["if-none-match"] === etag) {
        reply.header("ETag", etag);
        reply.code(304);
        return reply.send();
      }
      if (cacheEnabled && sidebarRedis && !skipCacheWrite) {
        await sidebarRedis.setEx(cacheKey, cacheTtl, body);
        reply.header("x-cache", "miss");
      } else if (cacheEnabled && sidebarRedis && skipCacheWrite) {
        reply.header("x-cache", "bypass");
      }
      reply.header("ETag", etag);
      reply.header("Cache-Control", buildPrivateCacheControl(cacheTtl));
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(body);
    },
  );

  z.get(
    "/market-map/node/:id",
    { schema: { params: marketMapNodeParamsSchema } },
    async (request, reply) => {
      const policy = await resolveMarketMapPolicy(pool);
      if (!policy.effective.enabled) {
        return reply.code(404).send({ error: "Market map is disabled" });
      }

      const { redis, status } = await getRedisStatus();
      if (!redis) {
        const error =
          status === "loading" ? "Redis loading, retry" : "Redis unavailable";
        return reply.code(503).send({ error });
      }

      const runId = await redis.get(marketMapActiveKey());
      if (!runId) {
        return reply.code(404).send({ error: "No active market map snapshot" });
      }

      const raw = await redis.get(
        marketMapRunNodeKey(runId, request.params.id),
      );
      const node = safeJsonParse<MarketMapNode>(raw);
      if (!node) {
        return reply.code(404).send({ error: "Market map node not found" });
      }
      requestMarketMapPayloadRefresh({ node }, "market-map:node");
      return { runId, node };
    },
  );

  z.get(
    "/market-map/node/:id/events",
    {
      schema: {
        params: marketMapNodeParamsSchema,
        querystring: marketMapNodeEventsQuerySchema,
      },
    },
    async (request, reply) => {
      const policy = await resolveMarketMapPolicy(pool);
      if (!policy.effective.enabled) {
        return reply.code(404).send({ error: "Market map is disabled" });
      }

      const { redis, status } = await getRedisStatus();
      if (!redis) {
        const error =
          status === "loading" ? "Redis loading, retry" : "Redis unavailable";
        return reply.code(503).send({ error });
      }

      const runId = await redis.get(marketMapActiveKey());
      if (!runId) {
        return reply.code(404).send({ error: "No active market map snapshot" });
      }

      const nodeId = request.params.id;
      const queryVenues = parseMarketMapVenuesQuery(request.query.venues);
      const allowedVenueSet = new Set(policy.effective.venuesEnabled);
      const selectedVenues =
        queryVenues.length > 0
          ? queryVenues.filter((venue) => allowedVenueSet.has(venue))
          : policy.effective.venuesEnabled;
      const selectedVenueSet = new Set<MarketMapVenue>(selectedVenues);
      const offset = request.query.offset ?? 0;
      const limit = request.query.limit ?? 100;
      const sortBy = request.query.sort_by ?? null;
      const sortDir = request.query.sort_dir ?? "desc";
      const marketsPreviewLimit = request.query.marketsPreviewLimit ?? 8;
      const cacheEnabled = env.marketMapTtlSec > 0;
      const cacheTtl = cacheEnabled ? env.marketMapTtlSec : 0;
      const policyCacheVersion = [
        policy.source,
        policy.effectiveAt?.toISOString() ?? "none",
        policy.effective.venuesEnabled.join(","),
      ].join(":");
      const cacheKey = [
        "market-map:node-events:v4",
        runId,
        policyCacheVersion,
        nodeId,
        selectedVenues.slice().sort().join(","),
        String(offset),
        String(limit),
        sortBy ?? "default",
        sortDir,
        String(marketsPreviewLimit),
      ].join(":");
      let skipCacheWrite = false;
      if (cacheEnabled) {
        const cachedBody = await redis.get(cacheKey);
        if (cachedBody) {
          const etag = buildWeakEtag(cachedBody);
          requestMarketMapBodyRefresh(cachedBody, "market-map:node-events");
          if (request.headers["if-none-match"] === etag) {
            reply.header("ETag", etag);
            reply.code(304);
            return reply.send();
          }
          reply.header("x-cache", "hit");
          reply.header("ETag", etag);
          reply.header("Cache-Control", buildPrivateCacheControl(cacheTtl));
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedBody);
        }
      }

      const [nodeRaw, eventsRaw] = await Promise.all([
        redis.get(marketMapRunNodeKey(runId, nodeId)),
        redis.get(marketMapRunNodeEventsKey(runId, nodeId)),
      ]);
      const node = safeJsonParse<MarketMapNode>(nodeRaw);
      if (!node) {
        return reply.code(404).send({ error: "Market map node not found" });
      }
      const events = (
        safeJsonParse<MarketMapEventSummary[]>(eventsRaw) ?? []
      ).filter((event) =>
        selectedVenueSet.size === 0 ? true : selectedVenueSet.has(event.venue),
      );
      const sortedEvents = sortNodeEvents({
        events,
        sortBy,
        sortDir,
      });
      let sortedEventsWithLiveMarket = sortedEvents;
      if (sortedEvents.length > 0) {
        try {
          const liveBundle = await loadLiveMarketDataForEvents(
            sortedEvents,
            marketsPreviewLimit,
          );
          sortedEventsWithLiveMarket = applyLiveMarketDataToEvents(
            sortedEvents,
            liveBundle.primaryByEventVenue,
            liveBundle.marketsByEventVenue,
          );
        } catch (error) {
          skipCacheWrite = true;
          request.log.warn(
            { err: error, nodeId, itemCount: sortedEvents.length },
            "market-map node events live market enrichment failed",
          );
        }
      }
      const filteredEvents = filterUsableEvents(sortedEventsWithLiveMarket);
      if (filteredEvents.dropped > 0) {
        request.log.info(
          {
            nodeId,
            offset,
            limit,
            droppedItems: filteredEvents.dropped,
            droppedReasons: filteredEvents.droppedReasons,
          },
          "market-map node events quality gate dropped events",
        );
      }

      const items = filteredEvents.items.slice(offset, offset + limit);
      const eventSignalSummaryByEventId =
        items.length > 0
          ? await loadEventSignalSummaryByEventId({
              runId,
              eventIds: Array.from(new Set(items.map((item) => item.eventId))),
            })
          : new Map();
      let itemsWithMetadata = applySignalSummaryToEvents(
        items,
        eventSignalSummaryByEventId,
      );
      const eventActivityMetricsByEventId =
        await loadEventActivityMetricsByEventId(
          items.map((item) => item.eventId),
        );
      itemsWithMetadata = applyEventActivityMetricsToEvents(
        itemsWithMetadata,
        eventActivityMetricsByEventId,
      );

      const payload = {
        runId,
        node: applyVenueFilterToNode(node, selectedVenueSet),
        total: filteredEvents.items.length,
        offset,
        limit,
        venues: selectedVenues,
        items: itemsWithMetadata,
      };
      requestMarketMapPayloadRefresh(payload, "market-map:node-events");
      const body = JSON.stringify(payload);
      const etag = buildWeakEtag(body);
      if (request.headers["if-none-match"] === etag) {
        reply.header("ETag", etag);
        reply.code(304);
        return reply.send();
      }
      if (cacheEnabled && !skipCacheWrite) {
        await redis.setEx(cacheKey, cacheTtl, body);
        reply.header("x-cache", "miss");
      } else if (cacheEnabled && skipCacheWrite) {
        reply.header("x-cache", "bypass");
      }
      reply.header("ETag", etag);
      reply.header("Cache-Control", buildPrivateCacheControl(cacheTtl));
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(body);
    },
  );
};
