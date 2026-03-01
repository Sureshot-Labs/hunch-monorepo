import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
import { getRedisStatus } from "../redis.js";
import {
  marketMapNodeEventsQuerySchema,
  marketMapNodeParamsSchema,
  marketMapQuerySchema,
} from "../schemas/market-map.js";
import {
  applyVenueFilterToNode,
  type MarketMapEventSummary,
  type MarketMapMeta,
  type MarketMapNode,
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
import { resolveMarketMapPolicy } from "../services/runtime-policies.js";

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

type MarketMapLiveMarketRow = {
  market_id: string;
  event_id: string;
  market_title: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_status: string | null;
  market_best_bid: unknown;
  market_best_ask: unknown;
  last_price: unknown;
  token_yes: string | null;
  token_no: string | null;
  yes_top_bid: unknown;
  yes_top_ask: unknown;
  no_top_bid: unknown;
  no_top_ask: unknown;
  accepting_orders: boolean | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
};

type MarketMapLiveMarketData = {
  marketId: string;
  marketTitle: string | null;
  marketImage: string | null;
  marketIcon: string | null;
  marketStatus: string | null;
  marketBestBid: number | null;
  marketBestAsk: number | null;
  lastPrice: number | null;
  tokenYes: string | null;
  tokenNo: string | null;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  acceptingOrders: boolean | null;
  resolvedOutcome: string | null;
  resolvedOutcomePct: number | null;
  oddsSource: "representative" | "fallback";
};

type MarketMapSignalType = "catalyst" | "risk" | "update";
type MarketMapSignalDirection = "up" | "down" | "mixed";

type MarketMapSignalSummary = {
  title: string;
  description: string | null;
  signalType: MarketMapSignalType | null;
  direction: MarketMapSignalDirection | null;
  confidence: number | null;
  createdAt: string;
};

type MarketMapNodeSignalRow = {
  node_id: string;
  direct_count: unknown;
  title: string | null;
  description: string | null;
  signal_type: MarketMapSignalType | null;
  direction: MarketMapSignalDirection | null;
  confidence: unknown;
  created_at: Date | string;
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
};

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

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

function normalizeLiveRow(
  row: MarketMapLiveMarketRow,
  oddsSource: "representative" | "fallback",
): MarketMapLiveMarketData {
  return {
    marketId: row.market_id,
    marketTitle: row.market_title?.trim() || null,
    marketImage: row.market_image ?? null,
    marketIcon: row.market_icon ?? null,
    marketStatus: row.market_status ?? null,
    marketBestBid: toNumber(row.market_best_bid),
    marketBestAsk: toNumber(row.market_best_ask),
    lastPrice: toNumber(row.last_price),
    tokenYes: row.token_yes ?? null,
    tokenNo: row.token_no ?? null,
    yesBid: toNumber(row.yes_top_bid),
    yesAsk: toNumber(row.yes_top_ask),
    noBid: toNumber(row.no_top_bid),
    noAsk: toNumber(row.no_top_ask),
    acceptingOrders: toBoolean(row.accepting_orders),
    resolvedOutcome: row.resolved_outcome ?? null,
    resolvedOutcomePct: toNumber(row.resolved_outcome_pct),
    oddsSource,
  };
}

async function loadNodeSignalSummaryByNodeId(params: {
  runId: string;
  nodeIds: string[];
}): Promise<{
  directCountByNodeId: Map<string, number>;
  topSignalByNodeId: Map<string, MarketMapSignalSummary>;
}> {
  const { runId, nodeIds } = params;
  const directCountByNodeId = new Map<string, number>();
  const topSignalByNodeId = new Map<string, MarketMapSignalSummary>();
  if (nodeIds.length === 0) {
    return { directCountByNodeId, topSignalByNodeId };
  }

  const { rows } = await pool.query<MarketMapNodeSignalRow>(
    `
    with ranked as (
      select
        t.target_id as node_id,
        count(*) over (partition by t.target_id) as direct_count,
        n.title,
        n.description,
        n.signal_type,
        n.direction,
        n.confidence,
        n.created_at,
        row_number() over (
          partition by t.target_id
          order by n.created_at desc, n.id desc
        ) as rn
      from ai_note_targets t
      join ai_notes n
        on n.id = t.note_id
      where t.target_kind = 'node'
        and t.target_id = any($1::text[])
        and n.note_type = 'signal'
        and n.producer_type = 'map_signals'
        and n.status = 'active'
        and coalesce(n.lineage->>'map_run_id', '') = $2
    )
    select
      node_id,
      direct_count,
      title,
      description,
      signal_type,
      direction,
      confidence,
      created_at
    from ranked
    where rn = 1
    `,
    [nodeIds, runId],
  );

  for (const row of rows) {
    const directCount = Math.max(0, Math.trunc(toNumber(row.direct_count) ?? 0));
    directCountByNodeId.set(row.node_id, directCount);
    topSignalByNodeId.set(row.node_id, {
      title: row.title?.trim() || "AI signal",
      description: row.description?.trim() || null,
      signalType: row.signal_type ?? null,
      direction: row.direction ?? null,
      confidence: toNumber(row.confidence),
      createdAt: toIsoString(row.created_at),
    });
  }

  return { directCountByNodeId, topSignalByNodeId };
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
  topSignalByNodeId: ReadonlyMap<string, MarketMapSignalSummary>;
}): MarketMapNode[] {
  const { nodes, directCountByNodeId, subtreeCountByNodeId, topSignalByNodeId } = params;
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
  }));
}

async function loadEventSignalSummaryByEventId(params: {
  runId: string;
  eventIds: string[];
}): Promise<
  Map<
    string,
    {
      signalCount: number;
      topSignal: MarketMapSignalSummary;
    }
  >
> {
  const { runId, eventIds } = params;
  const byEventId = new Map<
    string,
    {
      signalCount: number;
      topSignal: MarketMapSignalSummary;
    }
  >();
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
        case when t.target_kind = 'event' then 0 else 1 end as target_priority
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
        row_number() over (
          partition by event_id, note_id
          order by target_priority asc
        ) as rn_note
      from candidates
      where event_id is not null
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
        row_number() over (
          partition by event_id
          order by created_at desc, note_id desc
        ) as rn
      from dedup
      where rn_note = 1
    )
    select
      event_id,
      signal_count,
      title,
      description,
      signal_type,
      direction,
      confidence,
      created_at
    from ranked
    where rn = 1
    `,
    [eventIds, runId],
  );

  for (const row of rows) {
    byEventId.set(row.event_id, {
      signalCount: Math.max(0, Math.trunc(toNumber(row.signal_count) ?? 0)),
      topSignal: {
        title: row.title?.trim() || "AI signal",
        description: row.description?.trim() || null,
        signalType: row.signal_type ?? null,
        direction: row.direction ?? null,
        confidence: toNumber(row.confidence),
        createdAt: toIsoString(row.created_at),
      },
    });
  }
  return byEventId;
}

async function loadLeafSignalSummaryByNodeId(params: {
  runId: string;
  nodeIds: string[];
  redis: {
    multi: () => {
      get: (key: string) => unknown;
      exec: () => Promise<unknown>;
    };
  };
}): Promise<{
  countByNodeId: Map<string, number>;
  topSignalByNodeId: Map<string, MarketMapSignalSummary>;
}> {
  const { runId, nodeIds, redis } = params;
  const countByNodeId = new Map<string, number>();
  const topSignalByNodeId = new Map<string, MarketMapSignalSummary>();
  if (nodeIds.length === 0) return { countByNodeId, topSignalByNodeId };

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

  if (allEventIds.size === 0) return { countByNodeId, topSignalByNodeId };

  const byEventId = await loadEventSignalSummaryByEventId({
    runId,
    eventIds: Array.from(allEventIds),
  });

  for (const nodeId of nodeIds) {
    const eventIds = eventIdsByNodeId.get(nodeId) ?? [];
    let total = 0;
    let topSignal: MarketMapSignalSummary | null = null;
    for (const eventId of eventIds) {
      const summary = byEventId.get(eventId);
      if (!summary) continue;
      total += Math.max(0, Math.trunc(summary.signalCount ?? 0));
      const candidate = summary.topSignal;
      if (
        topSignal == null ||
        Date.parse(candidate.createdAt) > Date.parse(topSignal.createdAt)
      ) {
        topSignal = candidate;
      }
    }
    countByNodeId.set(nodeId, total);
    if (topSignal) {
      topSignalByNodeId.set(nodeId, topSignal);
    }
  }

  return { countByNodeId, topSignalByNodeId };
}

function applySignalSummaryToEvents(
  events: MarketMapEventSummary[],
  byEventId: ReadonlyMap<
    string,
    {
      signalCount: number;
      topSignal: MarketMapSignalSummary;
    }
  >,
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
): Promise<Map<string, MarketMapLiveMarketData>> {
  const byEventId = new Map<string, MarketMapLiveMarketData>();
  if (events.length === 0) {
    return byEventId;
  }

  const eventIds: string[] = [];
  const eventVenues: string[] = [];
  const preferredMarketIds: Array<string | null> = [];
  const preferredByEventId = new Map<string, string | null>();
  for (const event of events) {
    eventIds.push(event.eventId);
    eventVenues.push(event.venue);
    preferredMarketIds.push(event.representativeMarketId ?? null);
    preferredByEventId.set(event.eventId, event.representativeMarketId ?? null);
  }

  const { rows } = await pool.query<
    MarketMapLiveMarketRow & { preferred_market_id: string | null }
  >(
    `
    with event_input as (
      select *
      from unnest($1::text[], $2::text[], $3::text[]) as ei(event_id, event_venue, preferred_market_id)
    ),
    ranked as (
      select
        m.id as market_id,
        m.event_id,
        m.title as market_title,
        m.image as market_image,
        m.icon as market_icon,
        m.status::text as market_status,
        m.best_bid as market_best_bid,
        m.best_ask as market_best_ask,
        m.last_price,
        mt.token_yes,
        mt.token_no,
        yes_top.best_bid as yes_top_bid,
        yes_top.best_ask as yes_top_ask,
        no_top.best_bid as no_top_bid,
        no_top.best_ask as no_top_ask,
        coalesce(pm.accepting_orders, case when m.status::text = 'ACTIVE' then true else false end) as accepting_orders,
        m.resolved_outcome,
        m.resolved_outcome_pct,
        ei.preferred_market_id,
        odds.yes_probability,
        row_number() over (
          partition by m.event_id
          order by
            (
              case
                when m.status::text = 'ACTIVE'
                  and (m.expiration_time is null or m.expiration_time > now())
                  and (m.close_time is null or m.close_time > now())
                then 0
                else 1
              end
            ),
            (case when odds.yes_probability is null then 1 else 0 end),
            odds.yes_probability desc nulls last,
            (case when m.id = ei.preferred_market_id then 0 else 1 end),
            (case when mt.token_yes is not null and mt.token_no is not null then 0 else 1 end),
            (
              case
                when yes_top.best_bid is not null
                  or yes_top.best_ask is not null
                  or no_top.best_bid is not null
                  or no_top.best_ask is not null
                  or m.last_price is not null
                then 0
                else 1
              end
            ),
            (
              coalesce(
                case
                  when m.volume_24h is not null and m.volume_24h > 0 then m.volume_24h
                  when m.volume_total is not null and m.volume_total > 0 then m.volume_total
                  else null
                end,
                0
              )
            ) desc,
            (
              coalesce(
                nullif(m.liquidity, 0),
                nullif(m.open_interest, 0),
                0
              )
            ) desc,
            coalesce(m.open_interest, 0) desc,
            coalesce(m.volume_total, 0) desc,
            m.venue_market_id,
            m.id
        ) as market_rank
      from event_input ei
      join unified_markets m
        on m.event_id = ei.event_id
       and m.venue = ei.event_venue
      cross join lateral (
        select
          case
            when m.venue = 'polymarket' and m.clob_token_ids is not null
              then (m.clob_token_ids::jsonb ->> 0)
            else m.token_yes
          end as token_yes,
          case
            when m.venue = 'polymarket' and m.clob_token_ids is not null
              then (m.clob_token_ids::jsonb ->> 1)
            else m.token_no
          end as token_no
      ) mt
      left join lateral (
        select best_bid, best_ask
        from unified_book_top
        where token_id = mt.token_yes
          and ts > now() - interval '7 days'
        order by ts desc
        limit 1
      ) yes_top on true
      left join lateral (
        select best_bid, best_ask
        from unified_book_top
        where token_id = mt.token_no
          and ts > now() - interval '7 days'
        order by ts desc
        limit 1
      ) no_top on true
      left join polymarket_markets pm
        on m.venue = 'polymarket' and pm.id = m.venue_market_id
      cross join lateral (
        select
          case
            when yes_top.best_bid is not null and yes_top.best_ask is not null
              then greatest(
                0::double precision,
                least(1::double precision, ((yes_top.best_bid + yes_top.best_ask) / 2)::double precision)
              )
            when yes_top.best_bid is not null
              then greatest(0::double precision, least(1::double precision, yes_top.best_bid::double precision))
            when yes_top.best_ask is not null
              then greatest(0::double precision, least(1::double precision, yes_top.best_ask::double precision))
            when no_top.best_bid is not null and no_top.best_ask is not null
              then greatest(
                0::double precision,
                least(1::double precision, (1 - ((no_top.best_bid + no_top.best_ask) / 2)::double precision))
              )
            when no_top.best_bid is not null
              then greatest(0::double precision, least(1::double precision, (1 - no_top.best_bid::double precision)))
            when no_top.best_ask is not null
              then greatest(0::double precision, least(1::double precision, (1 - no_top.best_ask::double precision)))
            when m.last_price is not null
              then greatest(0::double precision, least(1::double precision, m.last_price::double precision))
            else null::double precision
          end as yes_probability
      ) odds
    )
    select
      market_id,
      event_id,
      market_title,
      market_image,
      market_icon,
      market_status,
      market_best_bid,
      market_best_ask,
      last_price,
      token_yes,
      token_no,
      yes_top_bid,
      yes_top_ask,
      no_top_bid,
      no_top_ask,
      accepting_orders,
      resolved_outcome,
      resolved_outcome_pct,
      preferred_market_id
    from ranked
    where market_rank = 1
    `,
    [eventIds, eventVenues, preferredMarketIds],
  );

  for (const row of rows) {
    const preferredMarketId = preferredByEventId.get(row.event_id) ?? null;
    const oddsSource =
      preferredMarketId != null && row.market_id === preferredMarketId
        ? "representative"
        : "fallback";
    byEventId.set(row.event_id, normalizeLiveRow(row, oddsSource));
  }
  return byEventId;
}

function applyLiveMarketDataToEvents(
  events: MarketMapEventSummary[],
  byEventId: ReadonlyMap<string, MarketMapLiveMarketData>,
): MarketMapEventSummary[] {
  return events.map((event) => {
    const live = byEventId.get(event.eventId);
    if (!live) return event;
    return {
      ...event,
      representativeMarketId: live.marketId,
      representativeMarketTitle: live.marketTitle ?? event.representativeMarketTitle ?? null,
      image: event.image ?? live.marketImage,
      icon: event.icon ?? live.marketIcon,
      oddsSource: live.oddsSource,
      tokenYes: live.tokenYes,
      tokenNo: live.tokenNo,
      yesBid: live.yesBid,
      yesAsk: live.yesAsk,
      noBid: live.noBid,
      noAsk: live.noAsk,
      marketBestBid: live.marketBestBid,
      marketBestAsk: live.marketBestAsk,
      lastPrice: live.lastPrice,
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
      const includeLeafEventsPreview = query.includeLeafEventsPreview ?? false;
      const leafEventsPreviewLimit = query.leafEventsPreviewLimit ?? 10;

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
        });
        const subtreeCountByNodeId = computeNodeSignalSubtreeCounts(
          allNodes,
          nodeSignalSummary.directCountByNodeId,
        );
        allNodes = applySignalSummaryToNodes({
          nodes: allNodes,
          directCountByNodeId: nodeSignalSummary.directCountByNodeId,
          subtreeCountByNodeId,
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

      const itemsWithLeafSignals =
        level === 3 && items.length > 0
          ? await (async () => {
              const leafSignalSummary = await loadLeafSignalSummaryByNodeId({
                runId,
                nodeIds: items.map((node) => node.id),
                redis,
              });
              return items.map((node) => ({
                ...node,
                signalCountSubtree: Math.max(
                  0,
                  Math.max(
                    Math.trunc(node.signalCountSubtree ?? 0),
                    Math.trunc(leafSignalSummary.countByNodeId.get(node.id) ?? 0),
                  ),
                ),
                topSignal:
                  node.topSignal ??
                  leafSignalSummary.topSignalByNodeId.get(node.id) ??
                  null,
              }));
            })()
          : items;

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
              redis,
            })
          : {
              countByNodeId: new Map<string, number>(),
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
          topSignal:
            childNode.topSignal ??
            previewLeafSignalSummary.topSignalByNodeId.get(childNode.id) ??
            null,
        })),
      }));

      const itemsWithLeafEventsPreview =
        includeLeafEventsPreview &&
        level === 3 &&
        itemsWithPreviewSignals.length > 0
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
                  .slice(0, leafEventsPreviewLimit),
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
              let liveByEventId: Map<string, MarketMapLiveMarketData> | null = null;
              if (previewEvents.length > 0) {
                try {
                  liveByEventId = await loadLiveMarketDataForEvents(previewEvents);
                } catch (error) {
                  request.log.warn(
                    {
                      err: error,
                      level,
                      parentId,
                      nodeCount: itemsWithPreview.length,
                      previewEventCount: previewEvents.length,
                    },
                    "market-map leaf preview live market enrichment failed",
                  );
                }
              }

              return itemsWithPreviewSignals.map((node, index) => ({
                ...node,
                eventsPreview:
                  liveByEventId == null
                    ? eventsByNodeWithSignals[index]
                    : applyLiveMarketDataToEvents(
                        eventsByNodeWithSignals[index],
                        liveByEventId,
                      ),
              }));
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

      return {
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
        items: itemsWithLeafEventsPreview,
        defaults: {
          sizeBy: effective.sizeByDefault,
          limit: effective.mergeLimitDefault,
          perVenueMin: effective.mergePerVenueMinDefault,
        },
      };
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
      const offset = request.query.offset ?? 0;
      const limit = request.query.limit ?? 100;
      const items = events.slice(offset, offset + limit);
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
      if (items.length > 0) {
        try {
          const liveByEventId = await loadLiveMarketDataForEvents(itemsWithLiveMarket);
          itemsWithLiveMarket = applyLiveMarketDataToEvents(
            itemsWithLiveMarket,
            liveByEventId,
          );
        } catch (error) {
          request.log.warn(
            { err: error, nodeId, itemCount: items.length },
            "market-map node events live market enrichment failed",
          );
        }
      }

      return {
        runId,
        node: applyVenueFilterToNode(node, selectedVenueSet),
        total: events.length,
        offset,
        limit,
        venues: selectedVenues,
        items: itemsWithLiveMarket,
      };
    },
  );
};
