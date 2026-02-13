import type { Pool } from "@hunch/infra";
import type { QueryResultRow } from "pg";
import type { PgParams } from "../server-types.js";

export type FeedInputs = {
  limit: number;
  offset: number;
  minVol: number;
  minLiquidity: number;
  marketIds?: string[];
  q?: string;
  view?: "events" | "markets";
  eventScope?: "grouped" | "single";
  venues?: string[];
  category?: string;
  categories?: string[];
  filter?: string;
  sort?: string;
  sortDir?: "asc" | "desc";
  minProb?: number;
  maxProb?: number;
  maxSpread?: number;
  endWithin?: string;
  ageSince?: string;
  nowParam: string;
  sevenDaysAgo: string;
  sevenDaysFromNow: string;
};

export type FavoriteFeedEventPage = {
  eventIds: string[];
  totalEvents: number;
  totalMarkets: number;
};

function createParamBuilder() {
  const params: PgParams = [];
  const add = (value: PgParams[number]): string => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, add };
}

async function queryRowsWithSearchHint<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: PgParams,
  useSearchHint: boolean,
): Promise<T[]> {
  if (!useSearchHint) {
    const { rows } = await pool.query<T>(sql, params);
    return rows;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL enable_seqscan = off");
    const { rows } = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback for failed search hints.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function fetchFeedEventIds(
  pool: Pool,
  inputs: FeedInputs,
): Promise<Array<{ id: string }>> {
  const { params, add } = createParamBuilder();
  const eventWhere: string[] = [];
  const safeEventLiquidityExpr =
    "case when e.liquidity >= 9e16 then null else e.liquidity end";
  const eventVolumeDisplayExpr = `
    case
      when e.volume_24h is not null and e.volume_24h > 0 then e.volume_24h
      when e.volume_total is not null and e.volume_total > 0 then e.volume_total
      else null
    end
  `;
  const marketVolumeDisplayExpr = `
    case
      when m.volume_24h is not null and m.volume_24h > 0 then m.volume_24h
      when m.volume_total is not null and m.volume_total > 0 then m.volume_total
      else null
    end
  `;
  const eventLiquidityDisplayExpr = `
    coalesce(nullif(${safeEventLiquidityExpr}, 0), nullif(e.open_interest, 0))
  `;
  const marketLiquidityDisplayExpr = `
    coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0))
  `;
  const eventOpenInterestExpr = `
    coalesce(nullif(e.open_interest, 0), nullif(sum(coalesce(m.open_interest, 0)), 0))
  `;
  const supportedLimitlessMarketExpr = "true";
  const eventVolumeSortExpr = `
    coalesce(${eventVolumeDisplayExpr}, sum(coalesce(${marketVolumeDisplayExpr}, 0)))
  `;
  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";

  const venuesParam = inputs.venues?.length ? add(inputs.venues) : null;
  if (venuesParam) {
    eventWhere.push(`e.venue = ANY(${venuesParam}::text[])`);
  }
  if (inputs.categories?.length) {
    eventWhere.push(
      `lower(e.category) = ANY(${add(inputs.categories)}::text[])`,
    );
  } else if (inputs.category) {
    eventWhere.push(
      `lower(e.category) = ${add(inputs.category.toLowerCase())}`,
    );
  }
  const nowParam = add(inputs.nowParam);
  const hasSearch = Boolean(inputs.q);
  const searchParam = hasSearch ? add(`%${inputs.q}%`) : null;
  const searchCte = hasSearch
    ? `
      search_events as materialized (
        select e.id
        from unified_events e
        where e.status = 'ACTIVE'
          and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
          and (
          e.title ilike ${searchParam} or
          e.description ilike ${searchParam} or
          e.category ilike ${searchParam} or
          e.slug ilike ${searchParam}
        )
        union
        select m.event_id as id
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
          and (
          m.title ilike ${searchParam} or
          m.description ilike ${searchParam} or
          m.category ilike ${searchParam} or
          m.slug ilike ${searchParam}
        )
      )
    `
    : "";
  if (hasSearch) {
    eventWhere.push("e.id in (select id from search_events)");
  }

  if (inputs.filter === "newest") {
    eventWhere.push(
      `e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`,
    );
  } else if (inputs.filter === "endingsoon") {
    eventWhere.push(
      `e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`,
    );
  }

  eventWhere.push("e.status = 'ACTIVE'");

  eventWhere.push(
    `(e.end_date is null or e.end_date > ${nowParam}::timestamptz)`,
  );

  if (inputs.endWithin) {
    eventWhere.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
    );
  }
  if (inputs.ageSince) {
    eventWhere.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}::timestamptz`,
    );
  }

  const requiresMarketJoin =
    inputs.minProb != null ||
    inputs.maxProb != null ||
    inputs.maxSpread != null ||
    inputs.eventScope != null ||
    inputs.sort === "trending_v2";

  if (inputs.sort === "change24h" && !requiresMarketJoin) {
    const eventChangeWhere = [...eventWhere];
    if (inputs.minVol > 1e-9) {
      eventChangeWhere.push(
        `${eventVolumeDisplayExpr} >= ${add(inputs.minVol)}`,
      );
    }
    if (inputs.minLiquidity > 0) {
      eventChangeWhere.push(
        `${eventLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
      );
    }

    const change24hParts: string[] = [];
    if (searchCte) change24hParts.push(searchCte);
    change24hParts.push(`
      filtered_events as (
        select e.id
        from unified_events e
        ${eventChangeWhere.length ? "where " + eventChangeWhere.join(" and ") : ""}
      )
    `);
    change24hParts.push(`
      event_change as (
        select
          m.event_id,
          avg(mc.change_24h) as change_24h
        from unified_markets m
        join filtered_events fe on fe.id = m.event_id
        left join unified_market_change_24h mc on mc.market_id = m.id
        where m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and ${supportedLimitlessMarketExpr}
        group by m.event_id
      )
    `);

    const withClause = `with ${change24hParts.join(",\n")}`;
    const eventChangeSql = `
      ${withClause}
      select e.id
      from unified_events e
      join filtered_events fe on fe.id = e.id
      left join event_change ec on ec.event_id = e.id
      order by ec.change_24h ${sortDir} nulls last, e.id
      limit ${inputs.limit} offset ${inputs.offset}
    `;

    return await queryRowsWithSearchHint<{ id: string }>(
      pool,
      eventChangeSql,
      params,
      hasSearch,
    );
  }

  if (!requiresMarketJoin) {
    const eventOnlyWhere = [...eventWhere];
    eventOnlyWhere.push(
      `exists (
        select 1
        from unified_markets m
        where m.event_id = e.id
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and ${supportedLimitlessMarketExpr}
      )`,
    );
    if (inputs.minVol > 1e-9) {
      eventOnlyWhere.push(
        `${eventVolumeDisplayExpr} >= ${add(inputs.minVol)}`,
      );
    }
    if (inputs.minLiquidity > 0) {
      eventOnlyWhere.push(
        `${eventLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
      );
    }

    const eventOpenInterestSortExpr =
      "coalesce(nullif(e.open_interest, 0), 0)";
    let eventOnlyOrder = "";
    if (inputs.sort === "totalvol")
      eventOnlyOrder = `(${eventVolumeDisplayExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "liquidity")
      eventOnlyOrder = `(${eventLiquidityDisplayExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "openinterest")
      eventOnlyOrder = `(${eventOpenInterestSortExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "time")
      eventOnlyOrder = `e.end_date ${sortDir} nulls last, e.id`;
    else if (inputs.filter === "newest")
      eventOnlyOrder = "e.start_date desc nulls last, e.id";
    else if (inputs.filter === "endingsoon")
      eventOnlyOrder = "e.end_date asc nulls last, e.id";
    else if (inputs.sort == null || inputs.sort === "trending") {
      const sevenDaysAgo = add(inputs.sevenDaysAgo);
      const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
      eventOnlyOrder = `
        (coalesce(${eventVolumeDisplayExpr}, 0) * 0.4 +
         coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
         case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
         case when e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
        ) ${sortDir} nulls last, e.id
      `;
    } else eventOnlyOrder = "e.start_date desc nulls last, e.id";

    const eventOnlySql = `
      ${searchCte ? `with ${searchCte}` : ""}
      select
        e.id
      from unified_events e
      ${eventOnlyWhere.length ? "where " + eventOnlyWhere.join(" and ") : ""}
      ${eventOnlyOrder ? `order by ${eventOnlyOrder}` : ""}
      limit ${inputs.limit} offset ${inputs.offset}
    `;

    const { rows } = await pool.query<{ id: string }>(eventOnlySql, params);
    return rows;
  }

  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
    end
  `;
  const change24hCteParts: string[] = [];
  if (inputs.sort === "change24h") {
    change24hCteParts.push(`
      market_change as (
        select
          m.id as market_id,
          mc.change_24h
        from unified_markets m
        join unified_events e on e.id = m.event_id
        left join unified_market_change_24h mc on mc.market_id = m.id
        where m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and ${supportedLimitlessMarketExpr}
          ${eventWhere.length ? `and ${eventWhere.join(" and ")}` : ""}
      )
    `);
  }
  const marketChangeJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const change24hExpr = inputs.sort === "change24h" ? "mc.change_24h" : "null";

  const marketQual: string[] = [];
  if (inputs.minLiquidity > 0) {
    marketQual.push(
      `${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
    );
  }
  if (inputs.minProb != null) {
    marketQual.push(`(${yesMidExpr}) >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    marketQual.push(`(${yesMidExpr}) <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    marketQual.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }
  const marketQualSql = marketQual.length
    ? marketQual.map((clause) => `(${clause})`).join(" and ")
    : "true";
  const tradeJoin =
    inputs.sort === "trending_v2"
      ? "left join unified_event_trade_24h et on et.event_id = e.id"
      : "";

  const having: string[] = [];
  if (inputs.minVol > 1e-9) {
    having.push(
      `${eventVolumeSortExpr} >= ${add(inputs.minVol)}`,
    );
  }
  having.push(`bool_or(${marketQualSql})`);
  if (inputs.eventScope === "grouped") {
    having.push("count(m.id) > 1");
  } else if (inputs.eventScope === "single") {
    having.push("count(m.id) = 1");
  }

  let eventOrder = "";
  if (inputs.sort === "totalvol")
    eventOrder = `(${eventVolumeSortExpr}) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "liquidity")
    eventOrder = `(${eventLiquidityDisplayExpr}) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "openinterest")
    eventOrder = `(${eventOpenInterestExpr}) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "change24h")
    eventOrder = `avg(${change24hExpr}) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "time")
    eventOrder = `e.end_date ${sortDir} nulls last, e.id`;
  else if (inputs.filter === "newest")
    eventOrder = "e.start_date desc nulls last, e.id";
  else if (inputs.filter === "endingsoon")
    eventOrder = "e.end_date asc nulls last, e.id";
  else if (inputs.sort === "trending_v2") {
    eventOrder = `
      case
        when e.venue = 'limitless'
          then max(coalesce(${eventLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${eventVolumeDisplayExpr}, 0))
        else coalesce(max(et.volume_24h), 0)
      end ${sortDir} nulls last, e.id
    `;
  } else if (inputs.sort == null || inputs.sort === "trending") {
    const sevenDaysAgo = add(inputs.sevenDaysAgo);
    const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
    eventOrder = `
      (coalesce(${eventVolumeSortExpr}, 0) * 0.4 +
       coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
       case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
       case when e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, e.id
    `;
  } else eventOrder = "e.start_date desc nulls last, e.id";

  const withParts: string[] = [];
  if (searchCte) withParts.push(searchCte);
  if (change24hCteParts.length) withParts.push(...change24hCteParts);
  const withClause = withParts.length ? `with ${withParts.join(",\n")}` : "";

  const eventSql = `
    ${withClause}
    select
      e.id
    from unified_events e
    join unified_markets m on m.event_id = e.id
      and m.status = 'ACTIVE'
      and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
      and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
      and ${supportedLimitlessMarketExpr}
    ${marketChangeJoin}
    ${tradeJoin}
    ${eventWhere.length ? "where " + eventWhere.join(" and ") : ""}
    group by e.id, e.start_date, e.end_date, e.liquidity
    having ${having.map((clause) => `(${clause})`).join(" and ")}
    ${eventOrder ? `order by ${eventOrder}` : ""}
    limit ${inputs.limit} offset ${inputs.offset}
  `;

  return await queryRowsWithSearchHint<{ id: string }>(
    pool,
    eventSql,
    params,
    hasSearch,
  );
}

export type FeedMarketRow = {
  event_id: string;
  event_title: string | null;
  category: string | null;
  start_date: unknown;
  end_date: unknown;
  event_liquidity: unknown;
  event_liquidity_display: unknown;
  event_volume: unknown;
  event_volume_24h: unknown;
  event_volume_display: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  market_uuid: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_type: string | null;
  market_status: string | null;
  market_open_time: unknown;
  market_close_time: unknown;
  market_expiration_time: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  volume_display: unknown;
  open_interest: unknown;
  liquidity: unknown;
  liquidity_display: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  last_price: unknown;
  change_24h: unknown;
  outcomes: string | null;
  token_yes: unknown;
  token_no: unknown;
  clob_token_ids: unknown;
  condition_id: unknown;
  market_slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  venue_exchange: string | null;
  venue_adapter: string | null;
  market_address: string | null;
  trade_type: string | null;
  last_update: unknown;
  market_created_at: unknown;
};

export async function fetchFeedMarkets(
  pool: Pool,
  inputs: FeedInputs,
  eventIds: string[],
): Promise<FeedMarketRow[]> {
  const { params, add } = createParamBuilder();
  // Cap markets per event in feed responses to avoid timeouts on large events.
  const perEventMarketLimit = 100;
  const safeEventLiquidityExpr =
    "case when e.liquidity >= 9e16 then null else e.liquidity end";
  const eventVolumeDisplayExpr = `
    case
      when e.volume_24h is not null and e.volume_24h > 0 then e.volume_24h
      when e.volume_total is not null and e.volume_total > 0 then e.volume_total
      else null
    end
  `;
  const marketVolumeDisplayExpr = `
    case
      when m.volume_24h is not null and m.volume_24h > 0 then m.volume_24h
      when m.volume_total is not null and m.volume_total > 0 then m.volume_total
      else null
    end
  `;
  const eventLiquidityDisplayExpr = `
    coalesce(nullif(${safeEventLiquidityExpr}, 0), nullif(e.open_interest, 0))
  `;
  const marketLiquidityDisplayExpr = `
    coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0))
  `;
  const supportedLimitlessMarketExpr = "true";
  const eventVolumeWindowExpr = `
    coalesce(
      ${eventVolumeDisplayExpr},
      nullif(sum(coalesce(${marketVolumeDisplayExpr}, 0)) over (partition by e.id), 0)
    )
  `;
  const eventLiquidityWindowExpr = `
    coalesce(
      ${eventLiquidityDisplayExpr},
      nullif(
        sum(
          coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0), 0)
        ) over (partition by e.id),
        0
      )
    )
  `;

  const eventIdsParam = add(eventIds);
  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const marketIdsParam = inputs.marketIds?.length
    ? add(inputs.marketIds)
    : null;
  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
    end
  `;
  const marketWhere: string[] = [
    // Only show ACTIVE markets - exclude CLOSED, SETTLED, and ARCHIVED
    "m.status = 'ACTIVE'",
    `m.event_id = ANY(${eventIdsParam}::text[])`,
    // Critical: Exclude expired or closed markets based on time
    // This ensures we don't show expired/closed markets even if status hasn't been updated yet
    // Use parameterized dates for index usage
    `(m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)`,
    `(m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)`,
    supportedLimitlessMarketExpr,
  ];
  if (marketIdsParam) {
    marketWhere.push(`m.id = ANY(${marketIdsParam}::text[])`);
  }

  if (inputs.minLiquidity > 0) {
    marketWhere.push(
      `${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
    );
  }

  if (inputs.minProb != null) {
    marketWhere.push(`${yesMidExpr} >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    marketWhere.push(`${yesMidExpr} <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    marketWhere.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }

  const marketOrder = "eo.ord, m.market_rank, m.venue_market_id";

  const marketRankExpr = `
    row_number() over (
      partition by m.event_id
      order by
        coalesce(${marketVolumeDisplayExpr}, 0) desc nulls last,
        coalesce(${marketLiquidityDisplayExpr}, 0) desc nulls last,
        m.venue_market_id
    ) as market_rank
  `;
  const rankedMarketSql = `
    select
      m.*,
      ${marketRankExpr}
    from unified_markets m
    where ${marketWhere.join(" and ")}
  `;

  const marketBaseSql = `
    select
      m.*,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>0)
        else m.token_yes
      end as resolved_token_yes,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>1)
        else m.token_no
      end as resolved_token_no
    from (${rankedMarketSql}) m
    where m.market_rank <= ${add(perEventMarketLimit)}
  `;
  const change24hCteParts: string[] = [];
  if (inputs.sort === "change24h") {
    change24hCteParts.push(`
      market_change as (
        select
          m.id as market_id,
          mc.change_24h
        from unified_markets m
        left join unified_market_change_24h mc on mc.market_id = m.id
        where m.event_id = ANY(${eventIdsParam}::text[])
          ${marketIdsParam ? `and m.id = ANY(${marketIdsParam}::text[])` : ""}
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and ${supportedLimitlessMarketExpr}
      )
    `);
  }
  const currentYesMidExpr = `
    case
      when yes_top.best_bid is not null and yes_top.best_ask is not null
        then (yes_top.best_bid + yes_top.best_ask) / 2
      else coalesce(yes_top.best_bid, yes_top.best_ask, m.best_bid, m.best_ask)
    end
  `;
  const change24hExpr =
    inputs.sort === "change24h" ? "mc.change_24h" : `
    case
      when ${currentYesMidExpr} is null or yes_24h.avg_mid is null or yes_24h.avg_mid = 0 then null
      else (${currentYesMidExpr} - yes_24h.avg_mid) / yes_24h.avg_mid
    end
  `;

  const eventOrderSql = `
    select
      event_id,
      ord
    from unnest(${eventIdsParam}::text[]) with ordinality as t(event_id, ord)
  `;
  const yesTopJoin = `left join lateral (
          select best_bid, best_ask
          from unified_book_top
          where token_id = m.resolved_token_yes
            and ts > (${nowParam}::timestamptz - interval '7 days')
          order by ts desc
          limit 1
        ) yes_top on true`;
  const yes24hJoin =
    inputs.sort === "change24h"
      ? ""
      : `left join lateral (
          select avg_mid
          from unified_book_top_1h
          where token_id = m.resolved_token_yes
            and bucket <= (${nowParam}::timestamptz - interval '24 hours')
          order by bucket desc
          limit 1
        ) yes_24h on true`;
  const marketChangeJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const withParts: string[] = [];
  if (change24hCteParts.length) withParts.push(...change24hCteParts);
  withParts.push(`event_order as (${eventOrderSql})`);
  withParts.push(`market_base as (${marketBaseSql})`);
  const withClause = `with ${withParts.join(",\n")}`;
  const marketSql = `
    ${withClause}
    select
      e.id as event_id,
      e.title as event_title,
      e.category,
      e.start_date,
      e.end_date,
      (${safeEventLiquidityExpr}) as event_liquidity,
      (${eventLiquidityWindowExpr}) as event_liquidity_display,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      (${eventVolumeWindowExpr}) as event_volume_display,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      m.id as market_uuid,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.market_type as market_type,
      m.status as market_status,
      m.open_time as market_open_time,
      m.close_time as market_close_time,
      m.expiration_time as market_expiration_time,
      m.volume_24h,
      m.volume_total,
      (${marketVolumeDisplayExpr}) as volume_display,
      m.open_interest,
      m.liquidity,
      (${marketLiquidityDisplayExpr}) as liquidity_display,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      m.last_price,
      (${change24hExpr}) as change_24h,
      m.outcomes,
      m.resolved_token_yes as token_yes,
      m.resolved_token_no as token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata->>'venueExchange' as venue_exchange,
      m.metadata->>'venueAdapter' as venue_adapter,
      m.metadata->>'address' as market_address,
      m.metadata->>'tradeType' as trade_type,
      m.updated_at as last_update,
      m.created_at as market_created_at
    from event_order eo
    join unified_events e on e.id = eo.event_id
    join market_base m on m.event_id = e.id
    ${yesTopJoin}
    ${yes24hJoin}
    ${marketChangeJoin}
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = m.resolved_token_no
        and ts > (${nowParam}::timestamptz - interval '7 days')
      order by ts desc
      limit 1
    ) no_top on true
    ${marketOrder ? `order by ${marketOrder}` : ""}
  `;

  const { rows } = await pool.query<FeedMarketRow>(marketSql, params);
  return rows;
}

export async function fetchFeedMarketsDirect(
  pool: Pool,
  inputs: FeedInputs,
): Promise<FeedMarketRow[]> {
  const { params, add } = createParamBuilder();
  const safeEventLiquidityExpr =
    "case when e.liquidity >= 9e16 then null else e.liquidity end";
  const eventVolumeDisplayExpr = `
    case
      when e.volume_24h is not null and e.volume_24h > 0 then e.volume_24h
      when e.volume_total is not null and e.volume_total > 0 then e.volume_total
      else null
    end
  `;
  const marketVolumeDisplayExpr = `
    case
      when m.volume_24h is not null and m.volume_24h > 0 then m.volume_24h
      when m.volume_total is not null and m.volume_total > 0 then m.volume_total
      else null
    end
  `;
  const eventLiquidityDisplayExpr = `
    coalesce(nullif(${safeEventLiquidityExpr}, 0), nullif(e.open_interest, 0))
  `;
  const marketLiquidityDisplayExpr = `
    coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0))
  `;
  const eventVolumeWindowExpr = `
    coalesce(
      ${eventVolumeDisplayExpr},
      nullif(sum(coalesce(${marketVolumeDisplayExpr}, 0)) over (partition by e.id), 0)
    )
  `;
  const eventLiquidityWindowExpr = `
    coalesce(
      ${eventLiquidityDisplayExpr},
      nullif(
        sum(
          coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0), 0)
        ) over (partition by e.id),
        0
      )
    )
  `;
  const supportedLimitlessMarketExpr = "true";
  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";
  const marketIdsParam = inputs.marketIds?.length
    ? add(inputs.marketIds)
    : null;
  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const hasSearch = Boolean(inputs.q);
  const searchParam = hasSearch ? add(`%${inputs.q}%`) : null;
  const searchCte = hasSearch
    ? `
      search_events as materialized (
        select e.id
        from unified_events e
        where e.status = 'ACTIVE'
          and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
          and (
          e.title ilike ${searchParam} or
          e.description ilike ${searchParam} or
          e.category ilike ${searchParam} or
          e.slug ilike ${searchParam}
        )
        union
        select m.event_id as id
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
          and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
          and (
          m.title ilike ${searchParam} or
          m.description ilike ${searchParam} or
          m.category ilike ${searchParam} or
          m.slug ilike ${searchParam}
        )
      )
    `
    : "";
  const searchEventJoin = hasSearch
    ? "join search_events se on se.id = e.id"
    : "";
  const searchMarketJoin = hasSearch
    ? "join search_events se on se.id = m.event_id"
    : "";
  const marketCountCte = `
    market_count as (
      select m.event_id, count(*) as market_count
      from unified_markets m
      join unified_events e on e.id = m.event_id
      ${searchMarketJoin}
      where m.status = 'ACTIVE'
        ${marketIdsParam ? `and m.id = ANY(${marketIdsParam}::text[])` : ""}
        and e.status = 'ACTIVE'
        and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
        and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
        and ${supportedLimitlessMarketExpr}
      group by m.event_id
    )
  `;
  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
    end
  `;
  const change24hCteParts: string[] = [];
  if (inputs.sort === "change24h") {
    change24hCteParts.push(`
      market_change as (
        select
          market_id,
          change_24h
        from unified_market_change_24h
      )
    `);
  }
  const where: string[] = [
    "m.status = 'ACTIVE'",
    "e.status = 'ACTIVE'",
    `(m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)`,
    `(m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)`,
    `(e.end_date is null or e.end_date > ${nowParam}::timestamptz)`,
    supportedLimitlessMarketExpr,
  ];
  if (marketIdsParam) {
    where.push(`m.id = ANY(${marketIdsParam}::text[])`);
  }

  if (inputs.venues?.length) {
    where.push(`m.venue = ANY(${add(inputs.venues)}::text[])`);
  }
  if (inputs.categories?.length) {
    where.push(
      `lower(e.category) = ANY(${add(inputs.categories)}::text[])`,
    );
  } else if (inputs.category) {
    where.push(
      `lower(e.category) = ${add(inputs.category.toLowerCase())}`,
    );
  }

  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    where.push(
      `e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`,
    );
  }

  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
    );
  }
  if (inputs.ageSince) {
    where.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}::timestamptz`,
    );
  }

  if (inputs.minLiquidity > 0) {
    where.push(`${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`);
  }
  if (inputs.minVol > 1e-9) {
    where.push(`${marketVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
  }
  if (inputs.minProb != null) {
    where.push(`${yesMidExpr} >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    where.push(`${yesMidExpr} <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    where.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }
  if (inputs.eventScope === "grouped") {
    where.push("emc.market_count > 1");
  } else if (inputs.eventScope === "single") {
    where.push("emc.market_count = 1");
  }

  let marketOrder = "";
  if (inputs.sort === "totalvol")
    marketOrder = `${marketVolumeDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "liquidity")
    marketOrder = `${marketLiquidityDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "openinterest")
    marketOrder = `m.open_interest ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "change24h")
    marketOrder = `change_24h ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "time")
    marketOrder = `coalesce(m.close_time, m.expiration_time, e.end_date) ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.filter === "newest")
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  else if (inputs.filter === "endingsoon")
    marketOrder = "e.end_date asc nulls last, m.venue_market_id";
  else if (inputs.sort === "trending_v2") {
    const marketTrendExpr = `
      case
        when m.venue = 'limitless'
          then (coalesce(${marketLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${marketVolumeDisplayExpr}, 0))
        else coalesce(trade_24h.volume_24h, 0)
      end
    `;
    marketOrder = `${marketTrendExpr} ${sortDir} nulls last, m.venue_market_id`;
  } else if (inputs.sort == null || inputs.sort === "trending") {
    marketOrder = `
      (coalesce(${marketVolumeDisplayExpr}, 0) * 0.4 + 
       coalesce(${marketLiquidityDisplayExpr}, 0) * 0.3 + 
       case when e.start_date >= (${nowParam}::timestamptz - interval '7 days') then 1000 else 0 end * 0.2 +
       case when e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id";

  const limitParam = add(inputs.limit);
  const offsetParam = add(inputs.offset);
  const needsMarketCount =
    inputs.eventScope === "grouped" || inputs.eventScope === "single";
  const marketCountJoin = needsMarketCount
    ? "join market_count emc on emc.event_id = m.event_id"
    : "";
  const change24hCandidateJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const tradeJoin =
    inputs.sort === "trending_v2"
      ? `left join lateral (
          select t.volume_24h
          from unified_market_trade_24h t
          where t.market_id = m.id
          limit 1
        ) trade_24h on true`
      : "";
  const change24hCandidateExpr =
    inputs.sort === "change24h" ? "mc.change_24h" : "null";

  const marketOrderExpr = marketOrder || "m.venue_market_id";
  const marketCandidatesSql = `
    select
      m.id,
      m.event_id
      ${inputs.sort === "change24h" ? `, (${change24hCandidateExpr}) as change_24h` : ""}
      , row_number() over (order by ${marketOrderExpr}) as ord
    from unified_markets m
    join unified_events e on e.id = m.event_id
    ${searchEventJoin}
    ${marketCountJoin}
    ${change24hCandidateJoin}
    ${tradeJoin}
    where ${where.join(" and ")}
    ${marketOrder ? `order by ${marketOrder}` : ""}
    limit ${limitParam} offset ${offsetParam}
  `;

  const marketBaseSql = `
    select
      m.*,
      mc.ord as ord
      ${inputs.sort === "change24h" ? ", mc.change_24h as change_24h" : ""}
      , case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>0)
        else m.token_yes
      end as resolved_token_yes,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>1)
        else m.token_no
      end as resolved_token_no
    from unified_markets m
    join market_candidates mc on mc.id = m.id
  `;
  const currentYesMidExpr = `
    case
      when yes_top.best_bid is not null and yes_top.best_ask is not null
        then (yes_top.best_bid + yes_top.best_ask) / 2
      else coalesce(yes_top.best_bid, yes_top.best_ask, m.best_bid, m.best_ask)
    end
  `;
  const change24hExpr = `
    ${inputs.sort === "change24h" ? "m.change_24h" : `case
      when ${currentYesMidExpr} is null or yes_24h.avg_mid is null or yes_24h.avg_mid = 0 then null
      else (${currentYesMidExpr} - yes_24h.avg_mid) / yes_24h.avg_mid
    end`}
  `;
  const yesTopJoin = `left join lateral (
          select best_bid, best_ask
          from unified_book_top
          where token_id = m.resolved_token_yes
            and ts > (${nowParam}::timestamptz - interval '7 days')
          order by ts desc
          limit 1
        ) yes_top on true`;
  const yes24hJoin =
    inputs.sort === "change24h"
      ? ""
      : `left join lateral (
          select avg_mid
          from unified_book_top_1h
          where token_id = m.resolved_token_yes
            and bucket <= (${nowParam}::timestamptz - interval '24 hours')
          order by bucket desc
          limit 1
        ) yes_24h on true`;
  const marketChangeJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const withParts: string[] = [];
  if (searchCte) withParts.push(searchCte);
  if (needsMarketCount || inputs.eventScope) {
    withParts.push(marketCountCte);
  }
  if (change24hCteParts.length) withParts.push(...change24hCteParts);
  withParts.push(`market_candidates as (${marketCandidatesSql})`);
  withParts.push(`market_base as (${marketBaseSql})`);
  const withClause = `with ${withParts.join(",\n")}`;

  const marketSql = `
    ${withClause}
    select
      e.id as event_id,
      e.title as event_title,
      e.category,
      e.start_date,
      e.end_date,
      (${safeEventLiquidityExpr}) as event_liquidity,
      (${eventLiquidityWindowExpr}) as event_liquidity_display,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      (${eventVolumeWindowExpr}) as event_volume_display,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      m.id as market_uuid,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.market_type as market_type,
      m.status as market_status,
      m.open_time as market_open_time,
      m.close_time as market_close_time,
      m.expiration_time as market_expiration_time,
      m.volume_24h,
      m.volume_total,
      (${marketVolumeDisplayExpr}) as volume_display,
      m.open_interest,
      m.liquidity,
      (${marketLiquidityDisplayExpr}) as liquidity_display,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      m.last_price,
      (${change24hExpr}) as change_24h,
      m.outcomes,
      m.resolved_token_yes as token_yes,
      m.resolved_token_no as token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata->>'venueExchange' as venue_exchange,
      m.metadata->>'venueAdapter' as venue_adapter,
      m.metadata->>'address' as market_address,
      m.metadata->>'tradeType' as trade_type,
      m.updated_at as last_update,
      m.created_at as market_created_at
    from unified_events e
    join market_base m on m.event_id = e.id
    ${yesTopJoin}
    ${yes24hJoin}
    ${marketChangeJoin}
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = m.resolved_token_no
        and ts > (${nowParam}::timestamptz - interval '7 days')
      order by ts desc
      limit 1
    ) no_top on true
    order by m.ord, m.venue_market_id
  `;

  const { rows } = await pool.query<FeedMarketRow>(marketSql, params);
  return rows;
}

export async function fetchFavoriteFeedEventPage(
  pool: Pool,
  inputs: FeedInputs,
): Promise<FavoriteFeedEventPage> {
  if (!inputs.marketIds?.length) {
    return { eventIds: [], totalEvents: 0, totalMarkets: 0 };
  }

  const { params, add } = createParamBuilder();
  const supportedLimitlessMarketExpr = "true";
  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";
  const marketIdsParam = add(inputs.marketIds);
  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const hasSearch = Boolean(inputs.q);
  const searchParam = hasSearch ? add(`%${inputs.q}%`) : null;
  const searchCte = hasSearch
    ? `
      search_events as materialized (
        select e.id
        from unified_events e
        where e.status = 'ACTIVE'
          and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
          and (
            e.title ilike ${searchParam} or
            e.description ilike ${searchParam} or
            e.category ilike ${searchParam} or
            e.slug ilike ${searchParam}
          )
        union
        select m.event_id as id
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
          and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
          and (
            m.title ilike ${searchParam} or
            m.description ilike ${searchParam} or
            m.category ilike ${searchParam} or
            m.slug ilike ${searchParam}
          )
      )
    `
    : "";
  const searchEventJoin = hasSearch
    ? "join search_events se on se.id = e.id"
    : "";
  const searchMarketJoin = hasSearch
    ? "join search_events se on se.id = m.event_id"
    : "";
  const marketCountCte = `
    market_count as (
      select m.event_id, count(*) as market_count
      from unified_markets m
      join unified_events e on e.id = m.event_id
      ${searchMarketJoin}
      where m.status = 'ACTIVE'
        and m.id = ANY(${marketIdsParam}::text[])
        and e.status = 'ACTIVE'
        and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
        and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
        and ${supportedLimitlessMarketExpr}
      group by m.event_id
    )
  `;
  const marketVolumeDisplayExpr = `
    case
      when m.volume_24h is not null and m.volume_24h > 0 then m.volume_24h
      when m.volume_total is not null and m.volume_total > 0 then m.volume_total
      else null
    end
  `;
  const marketLiquidityDisplayExpr = `
    coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0))
  `;
  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
    end
  `;
  const change24hCteParts: string[] = [];
  if (inputs.sort === "change24h") {
    change24hCteParts.push(`
      market_change as (
        select market_id, change_24h
        from unified_market_change_24h
      )
    `);
  }
  const where: string[] = [
    "m.status = 'ACTIVE'",
    "e.status = 'ACTIVE'",
    `m.id = ANY(${marketIdsParam}::text[])`,
    `(m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)`,
    `(m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)`,
    `(e.end_date is null or e.end_date > ${nowParam}::timestamptz)`,
    supportedLimitlessMarketExpr,
  ];

  if (inputs.venues?.length) {
    where.push(`m.venue = ANY(${add(inputs.venues)}::text[])`);
  }
  if (inputs.categories?.length) {
    where.push(
      `lower(e.category) = ANY(${add(inputs.categories)}::text[])`,
    );
  } else if (inputs.category) {
    where.push(`lower(e.category) = ${add(inputs.category.toLowerCase())}`);
  }
  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    where.push(`e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`);
  }
  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
    );
  }
  if (inputs.ageSince) {
    where.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}::timestamptz`,
    );
  }
  if (inputs.minLiquidity > 0) {
    where.push(`${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`);
  }
  if (inputs.minVol > 1e-9) {
    where.push(`${marketVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
  }
  if (inputs.minProb != null) {
    where.push(`${yesMidExpr} >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    where.push(`${yesMidExpr} <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    where.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }
  if (inputs.eventScope === "grouped") {
    where.push("emc.market_count > 1");
  } else if (inputs.eventScope === "single") {
    where.push("emc.market_count = 1");
  }

  let marketOrder = "";
  if (inputs.sort === "totalvol")
    marketOrder = `${marketVolumeDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "liquidity")
    marketOrder = `${marketLiquidityDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "openinterest")
    marketOrder = `m.open_interest ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "change24h")
    marketOrder = `change_24h ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "time")
    marketOrder = `coalesce(m.close_time, m.expiration_time, e.end_date) ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.filter === "newest")
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  else if (inputs.filter === "endingsoon")
    marketOrder = "e.end_date asc nulls last, m.venue_market_id";
  else if (inputs.sort === "trending_v2") {
    const marketTrendExpr = `
      case
        when m.venue = 'limitless'
          then (coalesce(${marketLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${marketVolumeDisplayExpr}, 0))
        else coalesce(trade_24h.volume_24h, 0)
      end
    `;
    marketOrder = `${marketTrendExpr} ${sortDir} nulls last, m.venue_market_id`;
  } else if (inputs.sort == null || inputs.sort === "trending") {
    marketOrder = `
      (coalesce(${marketVolumeDisplayExpr}, 0) * 0.4 + 
       coalesce(${marketLiquidityDisplayExpr}, 0) * 0.3 + 
       case when e.start_date >= (${nowParam}::timestamptz - interval '7 days') then 1000 else 0 end * 0.2 +
       case when e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id";

  const needsMarketCount =
    inputs.eventScope === "grouped" || inputs.eventScope === "single";
  const marketCountJoin = needsMarketCount
    ? "join market_count emc on emc.event_id = m.event_id"
    : "";
  const change24hCandidateJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const tradeJoin =
    inputs.sort === "trending_v2"
      ? `left join lateral (
          select t.volume_24h
          from unified_market_trade_24h t
          where t.market_id = m.id
          limit 1
        ) trade_24h on true`
      : "";
  const change24hCandidateExpr =
    inputs.sort === "change24h" ? "mc.change_24h" : "null";
  const marketOrderExpr = marketOrder || "m.venue_market_id";
  const limitParam = add(inputs.limit);
  const offsetParam = add(inputs.offset);

  const marketCandidatesSql = `
    select
      m.id,
      m.event_id
      ${inputs.sort === "change24h" ? `, (${change24hCandidateExpr}) as change_24h` : ""}
      , row_number() over (order by ${marketOrderExpr}) as ord
    from unified_markets m
    join unified_events e on e.id = m.event_id
    ${searchEventJoin}
    ${marketCountJoin}
    ${change24hCandidateJoin}
    ${tradeJoin}
    where ${where.join(" and ")}
  `;

  const withParts: string[] = [];
  if (searchCte) withParts.push(searchCte);
  if (needsMarketCount) withParts.push(marketCountCte);
  if (change24hCteParts.length) withParts.push(...change24hCteParts);
  withParts.push(`market_candidates as (${marketCandidatesSql})`);
  const withClause = `with ${withParts.join(",\n")}`;

  const sql = `
    ${withClause}
    select
      coalesce((select count(*) from market_candidates), 0)::int as total_markets,
      coalesce((select count(*) from (select distinct event_id from market_candidates) t), 0)::int as total_events,
      coalesce(
        (
          select array_agg(page.event_id order by page.first_ord)
          from (
            select event_id, min(ord) as first_ord
            from market_candidates
            group by event_id
            order by first_ord
            limit ${limitParam} offset ${offsetParam}
          ) page
        ),
        '{}'::text[]
      ) as event_ids
  `;

  const { rows } = await pool.query<{
    total_markets: number;
    total_events: number;
    event_ids: string[] | null;
  }>(sql, params);
  const row = rows[0];
  if (!row) return { eventIds: [], totalEvents: 0, totalMarkets: 0 };

  return {
    eventIds: Array.isArray(row.event_ids) ? row.event_ids : [],
    totalEvents: Number(row.total_events ?? 0),
    totalMarkets: Number(row.total_markets ?? 0),
  };
}

export type MarketDetailsRow = {
  event_id: string;
  event_title: string | null;
  event_description: string | null;
  event_category: string | null;
  start_date: unknown;
  end_date: unknown;
  event_liquidity: unknown;
  event_volume: unknown;
  event_image: string | null;
  event_icon: string | null;
  event_metadata: unknown;
  market_id: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_description: string | null;
  market_type: string | null;
  market_status: string | null;
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
  condition_id: string | null;
  market_ledger: string | null;
  settlement_mint: string | null;
  is_initialized: boolean | null;
  redemption_status: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  pm_order_price_min_tick_size: unknown;
  pm_order_min_size: unknown;
  pm_accepting_orders: boolean | null;
  pm_neg_risk: boolean | null;
  pm_neg_risk_market_id: string | null;
  pm_neg_risk_parent_condition_id: string | null;
  pm_neg_risk_request_id: string | null;
  pm_question_id: string | null;
  pm_clob_token_ids: string | null;
  slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export async function fetchMarketDetails(
  pool: Pool,
  marketId: string,
): Promise<MarketDetailsRow[]> {
  // Query for market details with event information
  const marketSql = `
    SELECT
      e.id as event_id,
      e.title as event_title,
      e.description as event_description,
      e.category as event_category,
      e.start_date,
      e.end_date,
      e.liquidity as event_liquidity,
      e.volume_total as event_volume,
      e.image as event_image,
      e.icon as event_icon,
      e.metadata as event_metadata,
      m.id as market_id,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.description as market_description,
      m.market_type,
      m.status as market_status,
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      m.last_price,
      m.outcomes,
      mt.token_yes,
      mt.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.market_ledger,
      m.settlement_mint,
      m.is_initialized,
      m.redemption_status,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      pm.order_price_min_tick_size as pm_order_price_min_tick_size,
      pm.order_min_size as pm_order_min_size,
      pm.accepting_orders as pm_accepting_orders,
      pm.neg_risk as pm_neg_risk,
      coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID') as pm_neg_risk_market_id,
      pm_parent.condition_id as pm_neg_risk_parent_condition_id,
      pm.neg_risk_request_id as pm_neg_risk_request_id,
      pm.question_id as pm_question_id,
      pm.clob_token_ids as pm_clob_token_ids,
      m.slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata as market_metadata,
      m.created_at,
      m.updated_at
    FROM unified_events e
    JOIN unified_markets m ON m.event_id = e.id
    cross join lateral (
      select
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>0)
          else m.token_yes
        end as token_yes,
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>1)
          else m.token_no
        end as token_no
    ) mt
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = mt.token_yes
        and m.status = 'ACTIVE'
        and ts > now() - interval '7 days'
      order by ts desc
      limit 1
    ) yes_top on true
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = mt.token_no
        and m.status = 'ACTIVE'
        and ts > now() - interval '7 days'
      order by ts desc
      limit 1
    ) no_top on true
    LEFT JOIN polymarket_markets pm
      ON m.venue = 'polymarket' AND pm.id = m.venue_market_id
    LEFT JOIN polymarket_markets pm_parent
      ON pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')
    WHERE m.id = $1 OR m.venue_market_id = $1
  `;

  const { rows } = await pool.query<MarketDetailsRow>(marketSql, [marketId]);
  return rows;
}

export type EventDetailsRow = {
  event_id: string;
  event_venue: string | null;
  venue_event_id: string | null;
  event_title: string | null;
  event_description: string | null;
  event_category: string | null;
  event_status: string | null;
  start_date: unknown;
  end_date: unknown;
  event_volume_total: unknown;
  event_volume_24h: unknown;
  event_liquidity: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_metadata: unknown;
  event_created_at: unknown;
  event_updated_at: unknown;
  market_id: string | null;
  market_venue: string | null;
  venue_market_id: string | null;
  market_title: string | null;
  market_description: string | null;
  market_type: string | null;
  market_status: string | null;
  pm_accepting_orders: boolean | null;
  pm_neg_risk: boolean | null;
  pm_neg_risk_market_id: string | null;
  pm_neg_risk_parent_condition_id: string | null;
  pm_neg_risk_request_id: string | null;
  pm_question_id: string | null;
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  open_interest: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: unknown;
  token_no: unknown;
  clob_token_ids: unknown;
  condition_id: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  market_slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_metadata: unknown;
  market_created_at: unknown;
  market_updated_at: unknown;
};

export async function fetchEventDetails(
  pool: Pool,
  eventId: string,
): Promise<EventDetailsRow[]> {
  // Query for event details with all associated markets
  const supportedLimitlessMarketExpr = "true";
  const eventSql = `
    SELECT
      e.id as event_id,
      e.venue as event_venue,
      e.venue_event_id,
      e.title as event_title,
      e.description as event_description,
      e.category as event_category,
      e.status as event_status,
      e.start_date,
      e.end_date,
      e.volume_total as event_volume_total,
      e.volume_24h as event_volume_24h,
      e.liquidity as event_liquidity,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      e.metadata as event_metadata,
      e.created_at as event_created_at,
      e.updated_at as event_updated_at,
      m.id as market_id,
      m.venue as market_venue,
      m.venue_market_id,
      m.title as market_title,
      m.description as market_description,
      m.market_type,
      m.status as market_status,
      pm.accepting_orders as pm_accepting_orders,
      pm.neg_risk as pm_neg_risk,
      coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID') as pm_neg_risk_market_id,
      pm_parent.condition_id as pm_neg_risk_parent_condition_id,
      pm.neg_risk_request_id as pm_neg_risk_request_id,
      pm.question_id as pm_question_id,
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      m.last_price,
      m.outcomes,
      mt.token_yes,
      mt.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata as market_metadata,
      m.created_at as market_created_at,
      m.updated_at as market_updated_at
    FROM unified_events e
    LEFT JOIN unified_markets m ON m.event_id = e.id
      AND ${supportedLimitlessMarketExpr}
    LEFT JOIN LATERAL (
      select
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>0)
          else m.token_yes
        end as token_yes,
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>1)
          else m.token_no
        end as token_no
    ) mt on true
    LEFT JOIN LATERAL (
      select best_bid, best_ask
      from unified_book_top
      where token_id = mt.token_yes
      order by ts desc
      limit 1
    ) yes_top on true
    LEFT JOIN LATERAL (
      select best_bid, best_ask
      from unified_book_top
      where token_id = mt.token_no
      order by ts desc
      limit 1
    ) no_top on true
    LEFT JOIN polymarket_markets pm
      ON m.venue = 'polymarket' AND pm.id = m.venue_market_id
    LEFT JOIN polymarket_markets pm_parent
      ON pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')
    WHERE e.id = $1 OR e.venue_event_id = $1
    ORDER BY m.volume_24h DESC NULLS LAST, m.liquidity DESC NULLS LAST, m.venue_market_id
  `;

  const { rows } = await pool.query<EventDetailsRow>(eventSql, [eventId]);
  return rows;
}

export type MarketByTokenRow = {
  token_id: string;
  side: string | null;
  market_id: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_description: string | null;
  market_type: string | null;
  market_status: string | null;
  pm_accepting_orders: boolean | null;
  pm_neg_risk: boolean | null;
  pm_neg_risk_market_id: string | null;
  pm_neg_risk_parent_condition_id: string | null;
  pm_neg_risk_request_id: string | null;
  pm_question_id: string | null;
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  open_interest: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
  condition_id: string | null;
  market_ledger: string | null;
  settlement_mint: string | null;
  is_initialized: boolean | null;
  redemption_status: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
  event_id: string | null;
  event_venue: string | null;
  venue_event_id: string | null;
  event_title: string | null;
  event_description: string | null;
  event_category: string | null;
  event_status: string | null;
  start_date: unknown;
  end_date: unknown;
  event_volume_total: unknown;
  event_volume_24h: unknown;
  event_liquidity: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_metadata: unknown;
};

export async function fetchMarketsByTokenIds(
  pool: Pool,
  inputs: { tokenIds: string[]; venue?: string; includeTop?: boolean },
): Promise<MarketByTokenRow[]> {
  if (inputs.tokenIds.length === 0) return [];

  const params: PgParams = [inputs.tokenIds];
  let venueClause = "";
  if (inputs.venue) {
    params.push(inputs.venue);
    venueClause = `and m.venue = $${params.length}`;
  }

  const includeTop = inputs.includeTop ?? true;
  const topSelect = includeTop
    ? `yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,`
    : `null::numeric as best_bid_yes,
      null::numeric as best_ask_yes,
      null::numeric as best_bid_no,
      null::numeric as best_ask_no,`;
  const topJoins = includeTop
    ? `left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = token_yes.token_id
        and ts > now() - interval '7 days'
      order by ts desc
      limit 1
    ) yes_top on true
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = token_no.token_id
        and ts > now() - interval '7 days'
      order by ts desc
      limit 1
    ) no_top on true`
    : "";

  const negRiskParentSelect =
    `pm_parent.condition_id as pm_neg_risk_parent_condition_id,`;
  const negRiskParentJoin = `left join polymarket_markets pm_parent
      on pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')`;

  const sql = `
    with input_tokens as (
      select token_id, min(ordinality) as ordinality
      from unnest($1::text[]) with ordinality as t(token_id, ordinality)
      where token_id is not null and token_id <> ''
      group by token_id
    ),
    token_matches as (
      select
        t.token_id,
        umt.outcome_side as side,
        umt.market_id,
        t.ordinality
      from input_tokens t
      join unified_market_tokens umt
        on umt.token_id = t.token_id
      where umt.outcome_side is not null
    )
    select
      tm.token_id,
      tm.side,
      m.id as market_id,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.description as market_description,
      m.market_type,
      m.status as market_status,
      pm.accepting_orders as pm_accepting_orders,
      pm.neg_risk as pm_neg_risk,
      coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID') as pm_neg_risk_market_id,
      ${negRiskParentSelect}
      pm.neg_risk_request_id as pm_neg_risk_request_id,
      pm.question_id as pm_question_id,
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      ${topSelect}
      m.last_price,
      m.outcomes,
      token_yes.token_id as token_yes,
      token_no.token_id as token_no,
      m.clob_token_ids,
      m.condition_id,
      m.market_ledger,
      m.settlement_mint,
      m.is_initialized,
      m.redemption_status,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      m.slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata as market_metadata,
      m.created_at,
      m.updated_at,
      e.id as event_id,
      e.venue as event_venue,
      e.venue_event_id,
      e.title as event_title,
      e.description as event_description,
      e.category as event_category,
      e.status as event_status,
      e.start_date,
      e.end_date,
      e.volume_total as event_volume_total,
      e.volume_24h as event_volume_24h,
      e.liquidity as event_liquidity,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      e.metadata as event_metadata
    from token_matches tm
    join unified_markets m on m.id = tm.market_id
    left join unified_market_tokens token_yes
      on token_yes.market_id = m.id
     and token_yes.outcome_side = 'YES'
    left join unified_market_tokens token_no
      on token_no.market_id = m.id
     and token_no.outcome_side = 'NO'
    ${topJoins}
    left join polymarket_markets pm
      on pm.id = m.venue_market_id and m.venue = 'polymarket'
    ${negRiskParentJoin}
    left join unified_events e on e.id = m.event_id
    ${venueClause}
    order by tm.ordinality
  `;

  const { rows } = await pool.query<MarketByTokenRow>(sql, params);
  return rows;
}
