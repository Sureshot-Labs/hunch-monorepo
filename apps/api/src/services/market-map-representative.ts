import type { Pool } from "pg";
import { buildOrderableMarketSql } from "../lib/market-availability.js";
import { buildRenderableMarketSql } from "../lib/market-renderability.js";

type SelectionRow = {
  event_id: string;
  event_venue: string;
  market_id: string;
  market_title: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_trade_type: string | null;
  market_address: string | null;
  market_close_time: Date | string | null;
  market_status: string | null;
  market_best_bid: unknown;
  market_best_ask: unknown;
  last_price: unknown;
  market_change_24h: unknown;
  token_yes: string | null;
  token_no: string | null;
  yes_top_bid: unknown;
  yes_top_ask: unknown;
  no_top_bid: unknown;
  no_top_ask: unknown;
  accepting_orders: boolean | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  yes_probability: unknown;
  market_volume_24h: unknown;
  market_volume_total: unknown;
  market_liquidity: unknown;
  market_open_interest: unknown;
  market_volume_last_24h: unknown;
  market_volume_prev_24h: unknown;
  market_volume_last_24h_change: unknown;
  market_volume_last_24h_change_pct: unknown;
  market_liquidity_now: unknown;
  market_liquidity_change_24h: unknown;
  market_liquidity_change_pct_24h: unknown;
  market_open_interest_now: unknown;
  market_open_interest_change_24h: unknown;
  market_open_interest_change_pct_24h: unknown;
  market_activity_metrics_updated_at: Date | string | null;
  preferred_market_id: string | null;
  market_rank: unknown;
};

export type RepresentativeEventInput = {
  eventId: string;
  venue: string;
  preferredMarketId?: string | null;
};

export type RankedRepresentativeMarket = {
  eventId: string;
  venue: string;
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
  yesProbability: number | null;
  volume24h: number;
  volumeTotal: number;
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
  preferredMarketId: string | null;
  rank: number;
};

export function eventVenueKey(eventId: string, venue: string): string {
  return `${eventId}::${venue}`;
}

function toNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNumberOrZero(value: unknown): number {
  const parsed = toNumber(value);
  return parsed == null ? 0 : parsed;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  if (value == null) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function normalizeInput(inputs: RepresentativeEventInput[]): Array<
  Required<Pick<RepresentativeEventInput, "eventId" | "venue">> & {
    preferredMarketId: string | null;
  }
> {
  const normalized = new Map<
    string,
    Required<Pick<RepresentativeEventInput, "eventId" | "venue">> & {
      preferredMarketId: string | null;
    }
  >();

  for (const input of inputs) {
    const eventId = input.eventId.trim();
    const venue = input.venue.trim().toLowerCase();
    if (!eventId || !venue) continue;
    const key = eventVenueKey(eventId, venue);
    const preferredMarketId = input.preferredMarketId?.trim() || null;
    const existing = normalized.get(key);
    if (!existing) {
      normalized.set(key, {
        eventId,
        venue,
        preferredMarketId,
      });
      continue;
    }
    if (!existing.preferredMarketId && preferredMarketId) {
      existing.preferredMarketId = preferredMarketId;
      normalized.set(key, existing);
    }
  }

  return Array.from(normalized.values());
}

function normalizeRow(row: SelectionRow): RankedRepresentativeMarket {
  return {
    eventId: row.event_id,
    venue: row.event_venue,
    marketId: row.market_id,
    marketTitle: row.market_title?.trim() || null,
    marketImage: row.market_image ?? null,
    marketIcon: row.market_icon ?? null,
    tradeType: row.market_trade_type ?? null,
    marketAddress: row.market_address ?? null,
    closeTime:
      row.market_close_time == null
        ? null
        : new Date(row.market_close_time).toISOString(),
    marketStatus: row.market_status ?? null,
    marketBestBid: toNumber(row.market_best_bid),
    marketBestAsk: toNumber(row.market_best_ask),
    lastPrice: toNumber(row.last_price),
    change24h: toNumber(row.market_change_24h),
    tokenYes: row.token_yes ?? null,
    tokenNo: row.token_no ?? null,
    yesBid: toNumber(row.yes_top_bid),
    yesAsk: toNumber(row.yes_top_ask),
    noBid: toNumber(row.no_top_bid),
    noAsk: toNumber(row.no_top_ask),
    acceptingOrders: toBoolean(row.accepting_orders),
    resolvedOutcome: row.resolved_outcome ?? null,
    resolvedOutcomePct: toNumber(row.resolved_outcome_pct),
    yesProbability: toNumber(row.yes_probability),
    volume24h: toNumberOrZero(row.market_volume_24h),
    volumeTotal: toNumberOrZero(row.market_volume_total),
    liquidity: toNumberOrZero(row.market_liquidity),
    openInterest: toNumberOrZero(row.market_open_interest),
    volumeLast24h: toNumber(row.market_volume_last_24h),
    volumePrev24h: toNumber(row.market_volume_prev_24h),
    volumeLast24hChange: toNumber(row.market_volume_last_24h_change),
    volumeLast24hChangePct: toNumber(row.market_volume_last_24h_change_pct),
    liquidityNow: toNumber(row.market_liquidity_now),
    liquidityChange24h: toNumber(row.market_liquidity_change_24h),
    liquidityChangePct24h: toNumber(row.market_liquidity_change_pct_24h),
    openInterestNow: toNumber(row.market_open_interest_now),
    openInterestChange24h: toNumber(row.market_open_interest_change_24h),
    openInterestChangePct24h: toNumber(row.market_open_interest_change_pct_24h),
    activityMetricsUpdatedAt: toIsoStringOrNull(
      row.market_activity_metrics_updated_at,
    ),
    preferredMarketId: row.preferred_market_id ?? null,
    rank: Math.max(1, Math.trunc(toNumber(row.market_rank) ?? 1)),
  };
}

export async function selectRankedRepresentativeMarketsForEvents(
  pool: Pool,
  inputs: RepresentativeEventInput[],
  perEventLimit: number,
): Promise<RankedRepresentativeMarket[]> {
  const normalized = normalizeInput(inputs);
  if (normalized.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(20, Math.trunc(perEventLimit)));
  // Keep expensive top-of-book lookups bounded to a small candidate set.
  const prefilterLimit = Math.max(limit, 10);
  const nowParam = new Date().toISOString();
  const renderableMarketExpr = buildRenderableMarketSql({ alias: "m" });
  const orderableMarketExpr = buildOrderableMarketSql({
    marketAlias: "m",
    eventAlias: "e",
    nowParam: "$5",
    pmAlias: "pm",
  });
  const eventIds = normalized.map((input) => input.eventId);
  const venues = normalized.map((input) => input.venue);
  const preferredMarketIds = normalized.map((input) => input.preferredMarketId);

  const { rows } = await pool.query<SelectionRow>(
    `
    with raw_input as (
      select *
      from unnest($1::text[], $2::text[], $3::text[]) as ei(event_id, event_venue, preferred_market_id)
    ),
    event_input as (
      select distinct on (event_id, event_venue)
        event_id,
        event_venue,
        preferred_market_id
      from raw_input
      order by event_id, event_venue, (preferred_market_id is not null) desc
    ),
    candidate_markets as (
      select
        ei.event_id,
        ei.event_venue,
        ei.preferred_market_id,
        m.id as market_id,
        row_number() over (
          partition by ei.event_id, ei.event_venue
          order by
            (case when m.id = ei.preferred_market_id then 0 else 1 end),
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
            m.venue_market_id,
            m.id
        ) as candidate_rank
      from event_input ei
      join unified_events e
        on e.id = ei.event_id
       and e.venue = ei.event_venue
      join unified_markets m
        on m.event_id = ei.event_id
       and m.venue = ei.event_venue
      left join polymarket_markets pm
        on m.venue = 'polymarket' and pm.id = m.venue_market_id
      where ${orderableMarketExpr} is true
        and ${renderableMarketExpr}
    ),
    market_base as (
      select
        cm.event_id as input_event_id,
        cm.event_venue as input_event_venue,
        cm.preferred_market_id as input_preferred_market_id,
        m.*
      from candidate_markets cm
      join unified_markets m
        on m.id = cm.market_id
      where cm.candidate_rank <= $6
    ),
    ranked as (
      select
        m.input_event_id as event_id,
        m.input_event_venue as event_venue,
        m.id as market_id,
        m.title as market_title,
        m.image as market_image,
        m.icon as market_icon,
        m.metadata->>'tradeType' as market_trade_type,
        m.metadata->>'address' as market_address,
        m.close_time as market_close_time,
        m.status::text as market_status,
        coalesce(m.best_bid, km.yes_bid_dollars) as market_best_bid,
        coalesce(m.best_ask, km.yes_ask_dollars) as market_best_ask,
        coalesce(m.last_price, km.last_price_dollars) as last_price,
        mc.change_24h as market_change_24h,
        mt.token_yes,
        mt.token_no,
        coalesce(yes_top.best_bid, km.yes_bid_dollars) as yes_top_bid,
        coalesce(yes_top.best_ask, km.yes_ask_dollars) as yes_top_ask,
        coalesce(no_top.best_bid, km.no_bid_dollars) as no_top_bid,
        coalesce(no_top.best_ask, km.no_ask_dollars) as no_top_ask,
        ${orderableMarketExpr} as accepting_orders,
        m.resolved_outcome,
        m.resolved_outcome_pct,
        odds.yes_probability,
        m.volume_24h as market_volume_24h,
        m.volume_total as market_volume_total,
        m.liquidity as market_liquidity,
        coalesce(m.open_interest, 0) as market_open_interest,
        mam.volume_last_24h as market_volume_last_24h,
        mam.volume_prev_24h as market_volume_prev_24h,
        mam.volume_last_24h_change as market_volume_last_24h_change,
        mam.volume_last_24h_change_pct as market_volume_last_24h_change_pct,
        mam.liquidity_now as market_liquidity_now,
        mam.liquidity_change_24h as market_liquidity_change_24h,
        mam.liquidity_change_pct_24h as market_liquidity_change_pct_24h,
        mam.open_interest_now as market_open_interest_now,
        mam.open_interest_change_24h as market_open_interest_change_24h,
        mam.open_interest_change_pct_24h as market_open_interest_change_pct_24h,
        mam.updated_at as market_activity_metrics_updated_at,
        m.input_preferred_market_id as preferred_market_id,
        row_number() over (
          partition by m.input_event_id, m.input_event_venue
          order by
            (
              case
                when mt.token_yes is not null
                  and mt.token_no is not null
                  and ${orderableMarketExpr} is true
                  and (
                    m.resolved_outcome is null
                    or upper(m.resolved_outcome::text) not in ('YES', 'NO')
                  )
                  and (
                    m.resolved_outcome_pct is null
                    or (m.resolved_outcome_pct > 0 and m.resolved_outcome_pct < 10000)
                  )
                  and (
                    coalesce(yes_top.best_bid, km.yes_bid_dollars) is not null
                    or coalesce(yes_top.best_ask, km.yes_ask_dollars) is not null
                    or coalesce(no_top.best_bid, km.no_bid_dollars) is not null
                    or coalesce(no_top.best_ask, km.no_ask_dollars) is not null
                    or m.best_bid is not null
                    or m.best_ask is not null
                    or coalesce(m.last_price, km.last_price_dollars) is not null
                    or odds.yes_probability is not null
                  )
                then 0
                else 1
              end
            ),
            (
              case
                when ${orderableMarketExpr} is true
                  and (
                    m.resolved_outcome is null
                    or upper(m.resolved_outcome::text) not in ('YES', 'NO')
                  )
                  and (
                    m.resolved_outcome_pct is null
                    or (m.resolved_outcome_pct > 0 and m.resolved_outcome_pct < 10000)
                  )
                then 0
                else 1
              end
            ),
            (
              case
                when coalesce(yes_top.best_bid, km.yes_bid_dollars) is not null
                  or coalesce(yes_top.best_ask, km.yes_ask_dollars) is not null
                  or coalesce(no_top.best_bid, km.no_bid_dollars) is not null
                  or coalesce(no_top.best_ask, km.no_ask_dollars) is not null
                  or m.best_bid is not null
                  or m.best_ask is not null
                  or coalesce(m.last_price, km.last_price_dollars) is not null
                  or m.resolved_outcome is not null
                  or m.resolved_outcome_pct is not null
                then 0
                else 1
              end
            ),
            (
              case
                when coalesce(yes_top.best_bid, km.yes_bid_dollars) is not null
                  and coalesce(yes_top.best_ask, km.yes_ask_dollars) is not null
                  and coalesce(no_top.best_bid, km.no_bid_dollars) is not null
                  and coalesce(no_top.best_ask, km.no_ask_dollars) is not null
                then 0
                when coalesce(yes_top.best_bid, km.yes_bid_dollars) is not null
                  and coalesce(yes_top.best_ask, km.yes_ask_dollars) is not null
                then 1
                when coalesce(no_top.best_bid, km.no_bid_dollars) is not null
                  and coalesce(no_top.best_ask, km.no_ask_dollars) is not null
                then 1
                when coalesce(yes_top.best_bid, km.yes_bid_dollars) is not null
                  or coalesce(yes_top.best_ask, km.yes_ask_dollars) is not null
                  or coalesce(no_top.best_bid, km.no_bid_dollars) is not null
                  or coalesce(no_top.best_ask, km.no_ask_dollars) is not null
                then 2
                when m.best_bid is not null
                  and m.best_ask is not null
                then 3
                when m.best_bid is not null
                  or m.best_ask is not null
                then 4
                when m.resolved_outcome is not null
                  or m.resolved_outcome_pct is not null
                then 5
                when coalesce(m.last_price, km.last_price_dollars) is not null
                then 6
                else 7
              end
            ),
            (case when odds.yes_probability is null then 1 else 0 end),
            odds.yes_probability desc,
            (
              case
                when ${orderableMarketExpr} is true
                then 0
                else 1
              end
            ),
            (case when mt.token_yes is not null and mt.token_no is not null then 0 else 1 end),
            (case when m.id = m.input_preferred_market_id then 0 else 1 end),
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
            coalesce(nullif(m.open_interest, 0), nullif(m.liquidity, 0), 0) desc,
            coalesce(m.volume_total, 0) desc,
            m.venue_market_id,
            m.id
        ) as market_rank
      from market_base m
      join unified_events e
        on e.id = m.input_event_id
       and e.venue = m.input_event_venue
      cross join lateral (
        select
          case
            when m.venue = 'polymarket' and m.clob_token_ids is not null then
              coalesce(
                (regexp_match(
                  m.clob_token_ids,
                  '^[[:space:]]*\\[[[:space:]]*"([^"]+)"[[:space:]]*,[[:space:]]*"([^"]+)"'
                ))[1],
                m.token_yes
              )
            else m.token_yes
          end as token_yes,
          case
            when m.venue = 'polymarket' and m.clob_token_ids is not null then
              coalesce(
                (regexp_match(
                  m.clob_token_ids,
                  '^[[:space:]]*\\[[[:space:]]*"([^"]+)"[[:space:]]*,[[:space:]]*"([^"]+)"'
                ))[2],
                m.token_no
              )
            else m.token_no
          end as token_no
      ) mt
      left join lateral (
        select best_bid, best_ask
        from unified_token_top_latest
        where mt.token_yes is not null
          and token_id = mt.token_yes
          and ts > ($5::timestamptz - interval '7 days')
        limit 1
      ) yes_top on true
      left join lateral (
        select best_bid, best_ask
        from unified_token_top_latest
        where mt.token_no is not null
          and token_id = mt.token_no
          and ts > ($5::timestamptz - interval '7 days')
        limit 1
      ) no_top on true
      left join polymarket_markets pm
        on m.venue = 'polymarket' and pm.id = m.venue_market_id
      left join kalshi_markets km
        on m.venue = 'kalshi' and km.id = m.venue_market_id
      left join unified_market_change_24h mc
        on mc.market_id = m.id
      left join unified_market_activity_metrics_24h mam
        on mam.market_id = m.id
      cross join lateral (
        select
          case
            when coalesce(yes_top.best_bid, km.yes_bid_dollars) is not null
              and coalesce(yes_top.best_ask, km.yes_ask_dollars) is not null
              then greatest(
                0::double precision,
                least(
                  1::double precision,
                  ((coalesce(yes_top.best_bid, km.yes_bid_dollars) + coalesce(yes_top.best_ask, km.yes_ask_dollars)) / 2)::double precision
                )
              )
            when coalesce(yes_top.best_bid, km.yes_bid_dollars) is not null
              then greatest(
                0::double precision,
                least(1::double precision, coalesce(yes_top.best_bid, km.yes_bid_dollars)::double precision)
              )
            when coalesce(yes_top.best_ask, km.yes_ask_dollars) is not null
              then greatest(
                0::double precision,
                least(1::double precision, coalesce(yes_top.best_ask, km.yes_ask_dollars)::double precision)
              )
            when coalesce(no_top.best_bid, km.no_bid_dollars) is not null
              and coalesce(no_top.best_ask, km.no_ask_dollars) is not null
              then greatest(
                0::double precision,
                least(
                  1::double precision,
                  (1 - ((coalesce(no_top.best_bid, km.no_bid_dollars) + coalesce(no_top.best_ask, km.no_ask_dollars)) / 2)::double precision)
                )
              )
            when coalesce(no_top.best_bid, km.no_bid_dollars) is not null
              then greatest(
                0::double precision,
                least(1::double precision, (1 - coalesce(no_top.best_bid, km.no_bid_dollars)::double precision))
              )
            when coalesce(no_top.best_ask, km.no_ask_dollars) is not null
              then greatest(
                0::double precision,
                least(1::double precision, (1 - coalesce(no_top.best_ask, km.no_ask_dollars)::double precision))
              )
            when m.best_bid is not null and m.best_ask is not null
              then greatest(
                0::double precision,
                least(1::double precision, ((m.best_bid + m.best_ask) / 2)::double precision)
              )
            when m.best_bid is not null
              then greatest(0::double precision, least(1::double precision, m.best_bid::double precision))
            when m.best_ask is not null
              then greatest(0::double precision, least(1::double precision, m.best_ask::double precision))
            when m.resolved_outcome_pct is not null
              then greatest(
                0::double precision,
                least(1::double precision, (m.resolved_outcome_pct::double precision / 10000))
              )
            when upper(coalesce(m.resolved_outcome::text, '')) = 'YES'
              then 1::double precision
            when upper(coalesce(m.resolved_outcome::text, '')) = 'NO'
              then 0::double precision
            when coalesce(m.last_price, km.last_price_dollars) is not null
              then greatest(
                0::double precision,
                least(1::double precision, coalesce(m.last_price, km.last_price_dollars)::double precision)
              )
            else null::double precision
          end as yes_probability
      ) odds
    )
    select
      event_id,
      event_venue,
      market_id,
      market_title,
      market_image,
      market_icon,
      market_trade_type,
      market_address,
      market_close_time,
      market_status,
      market_best_bid,
      market_best_ask,
      last_price,
      market_change_24h,
      token_yes,
      token_no,
      yes_top_bid,
      yes_top_ask,
      no_top_bid,
      no_top_ask,
      accepting_orders,
      resolved_outcome,
      resolved_outcome_pct,
      yes_probability,
      market_volume_24h,
      market_volume_total,
      market_liquidity,
      market_open_interest,
      market_volume_last_24h,
      market_volume_prev_24h,
      market_volume_last_24h_change,
      market_volume_last_24h_change_pct,
      market_liquidity_now,
      market_liquidity_change_24h,
      market_liquidity_change_pct_24h,
      market_open_interest_now,
      market_open_interest_change_24h,
      market_open_interest_change_pct_24h,
      market_activity_metrics_updated_at,
      preferred_market_id,
      market_rank
    from ranked
    where market_rank <= $4
    order by event_id, event_venue, market_rank
    `,
    [eventIds, venues, preferredMarketIds, limit, nowParam, prefilterLimit],
  );

  return rows.map(normalizeRow);
}
