import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { pool } from "../db.js";
import { env } from "../env.js";
import { computeAcceptingOrders } from "../lib/market-availability.js";
import { getRedisStatus } from "../redis.js";
import { fetchMarketSignalPricingByIds } from "../repos/unified-read.js";
import {
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
  selectRankedRepresentativeMarketsForEvents,
  type RankedRepresentativeMarket,
} from "../services/market-map-representative.js";
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

function metricForEvent(
  event: MarketMapEventSummary,
  sizeBy: "count" | "volume24h" | "liquidity" | "openInterest",
): number {
  const openInterestFallback =
    event.openInterest > 0 ? event.openInterest : Math.max(0, event.liquidity);
  switch (sizeBy) {
    case "count":
      return 1;
    case "liquidity":
      return event.liquidity;
    case "openInterest":
      return openInterestFallback;
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
    return sortDir === "asc" ? leftMetric - rightMetric : rightMetric - leftMetric;
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

type MarketMapSignalPreviewSummary = {
  signalCount: number;
  signalsPreview: MarketMapSignalSummary[];
  topSignal: MarketMapSignalSummary | null;
};

const MARKET_MAP_SIGNALS_PREVIEW_LIMIT = 8;

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
  marketStatus: string | null;
  pmAcceptingOrders: boolean | null;
  closeTime: unknown;
  expirationTime: unknown;
  bestBid: unknown;
  bestAsk: unknown;
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
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    acceptingOrders: computeAcceptingOrders({
      status: params.marketStatus,
      closeTime: params.closeTime,
      expirationTime: params.expirationTime,
      pmAcceptingOrders: params.pmAcceptingOrders,
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
        marketStatus: row.market_status ?? null,
        pmAcceptingOrders: row.pm_accepting_orders ?? null,
        closeTime: row.close_time,
        expirationTime: row.expiration_time,
        bestBid: row.best_bid,
        bestAsk: row.best_ask,
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

function filterUsableEvents(events: MarketMapEventSummary[]): {
  items: MarketMapEventSummary[];
  dropped: number;
  droppedReasons: MarketMapDropReasonCounts;
} {
  const items: MarketMapEventSummary[] = [];
  const droppedReasons = emptyDropReasonCounts();
  let dropped = 0;
  for (const event of events) {
    const reason = getMarketMapDropReason({
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
      resolvedOutcome: event.resolvedOutcome ?? null,
      resolvedOutcomePct: event.resolvedOutcomePct ?? null,
    });
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
    const directCount = Math.max(0, Math.trunc(toNumber(row.direct_count) ?? 0));
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
      const fallback = Math.max(0, Math.trunc(directCountByNodeId.get(nodeId) ?? 0));
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
    const current =
      byEventId.get(row.event_id) ?? {
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
    const events = safeJsonParse<MarketMapEventSummary[]>(rawEvents[index]) ?? [];
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
    const openInterestFallback =
      event.openInterest > 0
        ? event.openInterest
        : live.openInterest > 0
          ? live.openInterest
          : liquidityFallback;
    return {
      ...event,
      representativeMarketId: live.marketId,
      representativeMarketTitle: live.marketTitle ?? event.representativeMarketTitle ?? null,
      image: event.image ?? live.marketImage,
      icon: event.icon ?? live.marketIcon,
      marketsPreview,
      oddsSource: live.oddsSource,
      closeTime: live.closeTime ?? event.closeTime ?? null,
      liquidity: liquidityFallback,
      openInterest: openInterestFallback,
      tokenYes: live.tokenYes,
      tokenNo: live.tokenNo,
      yesBid: live.yesBid,
      yesAsk: live.yesAsk,
      noBid: live.noBid,
      noAsk: live.noAsk,
      marketBestBid: live.marketBestBid,
      marketBestAsk: live.marketBestAsk,
      lastPrice: live.lastPrice,
      change24h: live.change24h,
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

      if (
        level === 1 &&
        parentId != null
      ) {
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

      const sizeBy = parseMarketMapSizeBy(query.sizeBy, effective.sizeByDefault);
      const limit = query.limit ?? effective.mergeLimitDefault;
      const perVenueMin = query.perVenueMin ?? effective.mergePerVenueMinDefault;
      const includeChildrenPreview = query.includeChildrenPreview ?? false;
      const childrenPreviewLimit = query.childrenPreviewLimit ?? 8;
      const includeEventsPreview =
        query.includeEventsPreview ??
        query.includeLeafEventsPreview ??
        false;
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
        "market-map:v1",
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

      const pipeline = redis.multi();
      pipeline.get(marketMapRunMetaKey(runId));
      pipeline.get(marketMapRunNodesGlobalKey(runId));
      const raw = (await pipeline.exec()) as unknown as Array<string | null>;
      const meta = safeJsonParse<MarketMapMeta>(raw[0]);
      let allNodes = safeJsonParse<MarketMapNode[]>(raw[1]) ?? [];
      if (!raw[1]) {
        const legacy = redis.multi();
        for (const venue of effective.venuesEnabled) {
          legacy.get(marketMapRunNodesKey(runId, venue));
        }
        const legacyRaw = (await legacy.exec()) as unknown as Array<string | null>;
        allNodes = legacyRaw.flatMap((value) => safeJsonParse<MarketMapNode[]>(value) ?? []);
      }
      if (allNodes.length > 0) {
        const nodeSignalSummary = await loadNodeSignalSummaryByNodeId({
          runId,
          nodeIds: allNodes.map((node) => node.id),
          previewLimit: 1,
        });
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
        ? allNodes.find((node) => node.id === parentId) ?? null
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
          ? await loadNodeSignalSummaryByNodeId({
              runId,
              nodeIds: items.map((node) => node.id),
              previewLimit: MARKET_MAP_SIGNALS_PREVIEW_LIMIT,
            })
          : {
              directCountByNodeId: new Map<string, number>(),
              signalsPreviewByNodeId: new Map<string, MarketMapSignalSummary[]>(),
              topSignalByNodeId: new Map<string, MarketMapSignalSummary>(),
            };

      const itemsWithNodeSignalPreview = items.map((node) => ({
        ...node,
        signalsPreview:
          itemNodeSignalPreviewSummary.signalsPreviewByNodeId.get(node.id) ??
          node.signalsPreview,
        topSignal:
          itemNodeSignalPreviewSummary.signalsPreviewByNodeId.get(node.id)?.[0] ??
          itemNodeSignalPreviewSummary.topSignalByNodeId.get(node.id) ??
          node.topSignal ??
          null,
      }));

      const itemsWithLeafSignals =
        level === 3 && itemsWithNodeSignalPreview.length > 0
          ? await (async () => {
              const leafSignalSummary = await loadLeafSignalSummaryByNodeId({
                runId,
                nodeIds: itemsWithNodeSignalPreview.map((node) => node.id),
                previewLimit: MARKET_MAP_SIGNALS_PREVIEW_LIMIT,
                redis,
              });
              return itemsWithNodeSignalPreview.map((node) => ({
                ...node,
                signalCountSubtree: Math.max(
                  0,
                  Math.max(
                    Math.trunc(node.signalCountSubtree ?? 0),
                    Math.trunc(leafSignalSummary.countByNodeId.get(node.id) ?? 0),
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
              const parentIds = new Set(itemsWithLeafSignals.map((node) => node.id));
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
          ? await loadLeafSignalSummaryByNodeId({
              runId,
              nodeIds: Array.from(previewNodeIds),
              previewLimit: MARKET_MAP_SIGNALS_PREVIEW_LIMIT,
              redis,
            })
          : {
              countByNodeId: new Map<string, number>(),
              signalsPreviewByNodeId: new Map<string, MarketMapSignalSummary[]>(),
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
            previewLeafSignalSummary.signalsPreviewByNodeId.get(childNode.id)?.[0] ??
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
              const rawEvents = (await pipeline.exec()) as unknown as Array<
                string | null
              >;

              const eventsByNode = itemsWithPreviewSignals.map((_, index) =>
                (safeJsonParse<MarketMapEventSummary[]>(rawEvents[index]) ?? [])
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
                  )
                  .slice(0, eventsPreviewLimit),
              );
              const previewEventIds = Array.from(
                new Set(
                  eventsByNode.flatMap((events) =>
                    events.map((event) => event.eventId),
                  ),
                ),
              );
              const eventSignalSummaryByEventId =
                previewEventIds.length > 0
                  ? await loadEventSignalSummaryByEventId({
                      runId,
                      eventIds: previewEventIds,
                    })
                  : new Map();
              const eventsByNodeWithSignals = eventsByNode.map((events) =>
                applySignalSummaryToEvents(events, eventSignalSummaryByEventId),
              );

              const previewEvents = eventsByNodeWithSignals.flat();
              let liveBundle: MarketMapLiveMarketBundle | null = null;
              if (previewEvents.length > 0) {
                try {
                  liveBundle = await loadLiveMarketDataForEvents(
                    previewEvents,
                    marketsPreviewLimit,
                  );
                } catch (error) {
                  skipCacheWrite = true;
                  request.log.warn(
                    {
                      err: error,
                      level,
                      parentId,
                      nodeCount: itemsWithPreview.length,
                      previewEventCount: previewEvents.length,
                    },
                    "market-map events preview live market enrichment failed",
                  );
                }
              }

              let droppedPreviewEvents = 0;
              const droppedReasons = emptyDropReasonCounts();
              const previewItems = itemsWithPreviewSignals.map((node, index) => {
                const withLive =
                  liveBundle == null
                    ? eventsByNodeWithSignals[index]
                    : applyLiveMarketDataToEvents(
                        eventsByNodeWithSignals[index],
                        liveBundle.primaryByEventVenue,
                        liveBundle.marketsByEventVenue,
                      );
                if (liveBundle == null) {
                  return {
                    ...node,
                    eventsPreview: withLive,
                  };
                }
                const filtered = filterUsableEvents(withLive);
                droppedPreviewEvents += filtered.dropped;
                for (const reason of Object.keys(
                  filtered.droppedReasons,
                ) as MarketMapDropReason[]) {
                  droppedReasons[reason] += filtered.droppedReasons[reason];
                }
                return {
                  ...node,
                  eventsPreview: filtered.items,
                };
              });
              if (liveBundle != null && droppedPreviewEvents > 0) {
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

      const raw = await redis.get(marketMapRunNodeKey(runId, request.params.id));
      const node = safeJsonParse<MarketMapNode>(raw);
      if (!node) {
        return reply.code(404).send({ error: "Market map node not found" });
      }
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
        "market-map:node-events:v1",
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
      const events = (safeJsonParse<MarketMapEventSummary[]>(eventsRaw) ?? []).filter(
        (event) =>
          selectedVenueSet.size === 0 ? true : selectedVenueSet.has(event.venue),
      );
      const sortedEvents = sortNodeEvents({
        events,
        sortBy,
        sortDir,
      });
      const items = sortedEvents.slice(offset, offset + limit);
      const eventSignalSummaryByEventId =
        items.length > 0
          ? await loadEventSignalSummaryByEventId({
              runId,
              eventIds: Array.from(new Set(items.map((item) => item.eventId))),
            })
          : new Map();
      let itemsWithLiveMarket = applySignalSummaryToEvents(
        items,
        eventSignalSummaryByEventId,
      );
      let qualityGateApplied = false;
      if (items.length > 0) {
        try {
          const liveBundle = await loadLiveMarketDataForEvents(
            itemsWithLiveMarket,
            marketsPreviewLimit,
          );
          itemsWithLiveMarket = applyLiveMarketDataToEvents(
            itemsWithLiveMarket,
            liveBundle.primaryByEventVenue,
            liveBundle.marketsByEventVenue,
          );
          qualityGateApplied = true;
        } catch (error) {
          skipCacheWrite = true;
          request.log.warn(
            { err: error, nodeId, itemCount: items.length },
            "market-map node events live market enrichment failed",
          );
        }
      }
      if (qualityGateApplied) {
        const filtered = filterUsableEvents(itemsWithLiveMarket);
        itemsWithLiveMarket = filtered.items;
        if (filtered.dropped > 0) {
          request.log.info(
            {
              nodeId,
              offset,
              limit,
              droppedItems: filtered.dropped,
              droppedReasons: filtered.droppedReasons,
            },
            "market-map node events quality gate dropped events",
          );
        }
      }

      const payload = {
        runId,
        node: applyVenueFilterToNode(node, selectedVenueSet),
        total: events.length,
        offset,
        limit,
        venues: selectedVenues,
        items: itemsWithLiveMarket,
      };
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
