import type { Pool } from "@hunch/infra";
import type { PgParams } from "../server-types.js";

export type FeedInputs = {
  limit: number;
  offset: number;
  minVol: number;
  minLiquidity: number;
  q?: string;
  view?: "events" | "markets";
  eventScope?: "grouped" | "single";
  venues?: string[];
  category?: string;
  categories?: string[];
  filter?: string;
  sort?: string;
  minProb?: number;
  maxProb?: number;
  maxSpread?: number;
  endWithin?: string;
  ageSince?: string;
  nowParam: string;
  sevenDaysAgo: string;
  sevenDaysFromNow: string;
};

function createParamBuilder() {
  const params: PgParams = [];
  const add = (value: PgParams[number]): string => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, add };
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
  const supportedLimitlessMarketExpr = "true";
  const eventVolumeSortExpr = `
    coalesce(${eventVolumeDisplayExpr}, sum(coalesce(${marketVolumeDisplayExpr}, 0)))
  `;
  const isPolymarketOnly =
    inputs.venues?.length === 1 && inputs.venues[0] === "polymarket";
  const hasMarketFilters =
    inputs.minLiquidity > 0 ||
    inputs.minProb != null ||
    inputs.maxProb != null ||
    inputs.maxSpread != null;
  const hasEventScope = inputs.eventScope != null;
  const hasSearch = Boolean(inputs.q);
  const useSimpleEventQuery =
    isPolymarketOnly && !hasMarketFilters && !hasEventScope && !hasSearch;

  if (inputs.venues?.length) {
    eventWhere.push(`e.venue = ANY(${add(inputs.venues)}::text[])`);
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
  if (inputs.q) {
    const search = add(`%${inputs.q}%`);
    eventWhere.push(
      `(
        e.title ilike ${search} or
        e.description ilike ${search} or
        e.category ilike ${search} or
        e.slug ilike ${search} or
        m.title ilike ${search} or
        m.description ilike ${search} or
        m.category ilike ${search} or
        m.slug ilike ${search}
      )`,
    );
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

  const nowParam = add(inputs.nowParam);
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

  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
    end
  `;

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
    eventOrder = "e.volume_total desc nulls last, e.id";
  else if (inputs.sort === "liquidity")
    eventOrder = `(${eventLiquidityDisplayExpr}) desc nulls last, e.id`;
  else if (inputs.filter === "newest")
    eventOrder = "e.start_date desc nulls last, e.id";
  else if (inputs.filter === "endingsoon")
    eventOrder = "e.end_date asc nulls last, e.id";
  else if (inputs.sort == null || inputs.sort === "trending") {
    const sevenDaysAgo = add(inputs.sevenDaysAgo);
    const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
    eventOrder = `
      (coalesce(${eventVolumeSortExpr}, 0) * 0.4 +
       coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
       case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
       case when e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
      ) desc nulls last, e.id
    `;
  } else eventOrder = "e.start_date desc nulls last, e.id";

  if (useSimpleEventQuery) {
    const eventVolumeSimpleExpr = `coalesce(${eventVolumeDisplayExpr}, 0)`;
    let eventOrderSimple = "";
    if (inputs.sort === "totalvol") {
      eventOrderSimple = "e.volume_total desc nulls last, e.id";
    } else if (inputs.sort === "liquidity") {
      eventOrderSimple = `(${eventLiquidityDisplayExpr}) desc nulls last, e.id`;
    } else if (inputs.filter === "newest") {
      eventOrderSimple = "e.start_date desc nulls last, e.id";
    } else if (inputs.filter === "endingsoon") {
      eventOrderSimple = "e.end_date asc nulls last, e.id";
    } else if (inputs.sort == null || inputs.sort === "trending") {
      const sevenDaysAgo = add(inputs.sevenDaysAgo);
      const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
      eventOrderSimple = `
        (coalesce(${eventVolumeSimpleExpr}, 0) * 0.4 +
         coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
         case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
         case when e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
        ) desc nulls last, e.id
      `;
    } else {
      eventOrderSimple = "e.start_date desc nulls last, e.id";
    }

    const simpleHaving: string[] = [];
    if (inputs.minVol > 1e-9) {
      simpleHaving.push(
        `${eventVolumeSimpleExpr} >= ${add(inputs.minVol)}`,
      );
    }

    const eventSqlSimple = `
      select
        e.id
      from unified_events e
      ${eventWhere.length ? "where " + eventWhere.join(" and ") : ""}
      ${simpleHaving.length ? `and ${simpleHaving.join(" and ")}` : ""}
      and exists (
        select 1
        from unified_markets m
        where m.event_id = e.id
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and ${supportedLimitlessMarketExpr}
      )
      ${eventOrderSimple ? `order by ${eventOrderSimple}` : ""}
      limit ${inputs.limit} offset ${inputs.offset}
    `;

    const { rows } = await pool.query<{ id: string }>(
      eventSqlSimple,
      params,
    );
    return rows;
  }

  const eventSql = `
    select
      e.id
    from unified_events e
    join unified_markets m on m.event_id = e.id
      and m.status = 'ACTIVE'
      and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
      and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
      and ${supportedLimitlessMarketExpr}
    ${eventWhere.length ? "where " + eventWhere.join(" and ") : ""}
    group by e.id, e.start_date, e.end_date, e.liquidity
    having ${having.map((clause) => `(${clause})`).join(" and ")}
    ${eventOrder ? `order by ${eventOrder}` : ""}
    limit ${inputs.limit} offset ${inputs.offset}
  `;

  const { rows } = await pool.query<{ id: string }>(eventSql, params);
  return rows;
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
  outcomes: string | null;
  token_yes: unknown;
  token_no: unknown;
  clob_token_ids: unknown;
  condition_id: unknown;
  market_slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  last_update: unknown;
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

  const eventOrderSql = `
    select
      event_id,
      ord
    from unnest(${eventIdsParam}::text[]) with ordinality as t(event_id, ord)
  `;
  const marketSql = `
    with
      event_order as (${eventOrderSql}),
      market_base as (${marketBaseSql})
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
      m.outcomes,
      m.resolved_token_yes as token_yes,
      m.resolved_token_no as token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.updated_at as last_update
    from event_order eo
    join unified_events e on e.id = eo.event_id
    join market_base m on m.event_id = e.id
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = m.resolved_token_yes
      order by ts desc
      limit 1
    ) yes_top on true
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = m.resolved_token_no
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

  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const marketCountSql = `
    select event_id, count(*) as market_count
    from unified_markets m
    where status = 'ACTIVE'
      and (expiration_time is null or expiration_time > ${nowParam}::timestamptz)
      and (close_time is null or close_time > ${nowCloseParam}::timestamptz)
      and ${supportedLimitlessMarketExpr}
    group by event_id
  `;
  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
    end
  `;

  const where: string[] = [
    "m.status = 'ACTIVE'",
    "e.status = 'ACTIVE'",
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
    where.push(
      `lower(e.category) = ${add(inputs.category.toLowerCase())}`,
    );
  }

  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}`);
  } else if (inputs.filter === "endingsoon") {
    where.push(`e.end_date <= ${add(inputs.sevenDaysFromNow)}`);
  }

  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}`,
    );
  }
  if (inputs.ageSince) {
    where.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}`,
    );
  }

  if (inputs.q) {
    const search = add(`%${inputs.q}%`);
    where.push(
      `(
        e.title ilike ${search} or
        e.description ilike ${search} or
        e.category ilike ${search} or
        e.slug ilike ${search} or
        m.title ilike ${search} or
        m.description ilike ${search} or
        m.category ilike ${search} or
        m.slug ilike ${search}
      )`,
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
    marketOrder = "m.volume_total desc nulls last, m.venue_market_id";
  else if (inputs.sort === "liquidity")
    marketOrder = `${marketLiquidityDisplayExpr} desc nulls last, m.venue_market_id`;
  else if (inputs.filter === "newest")
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  else if (inputs.filter === "endingsoon")
    marketOrder = "e.end_date asc nulls last, m.venue_market_id";
  else if (inputs.sort == null || inputs.sort === "trending") {
    marketOrder = `
      (coalesce(${marketVolumeDisplayExpr}, 0) * 0.4 + 
       coalesce(${marketLiquidityDisplayExpr}, 0) * 0.3 + 
       case when e.start_date >= (${nowParam}::timestamptz - interval '7 days') then 1000 else 0 end * 0.2 +
       case when e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
      ) desc nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id";

  const limitParam = add(inputs.limit);
  const offsetParam = add(inputs.offset);
  const needsMarketCount =
    inputs.eventScope === "grouped" || inputs.eventScope === "single";
  const marketCountJoin = needsMarketCount
    ? `join (${marketCountSql}) emc on emc.event_id = m.event_id`
    : "";

  const marketCandidatesSql = `
    select
      m.id,
      m.event_id
    from unified_markets m
    join unified_events e on e.id = m.event_id
    ${marketCountJoin}
    where ${where.join(" and ")}
    ${marketOrder ? `order by ${marketOrder}` : ""}
    limit ${limitParam} offset ${offsetParam}
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
    from unified_markets m
    join market_candidates mc on mc.id = m.id
  `;

  const marketSql = `
    with
      market_candidates as (${marketCandidatesSql}),
      market_base as (${marketBaseSql})
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
      m.outcomes,
      m.resolved_token_yes as token_yes,
      m.resolved_token_no as token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.updated_at as last_update
    from unified_events e
    join market_base m on m.event_id = e.id
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = m.resolved_token_yes
      order by ts desc
      limit 1
    ) yes_top on true
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = m.resolved_token_no
      order by ts desc
      limit 1
    ) no_top on true
    ${marketOrder ? `order by ${marketOrder}` : ""}
    limit ${limitParam} offset ${offsetParam}
  `;

  const { rows } = await pool.query<FeedMarketRow>(marketSql, params);
  return rows;
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
      order by ts desc
      limit 1
    ) yes_top on true
    left join lateral (
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
  market_created_at: unknown;
  market_updated_at: unknown;
};

export async function fetchEventDetails(
  pool: Pool,
  eventId: string,
): Promise<EventDetailsRow[]> {
  // Query for event details with all associated markets
  const supportedLimitlessMarketExpr =
    "(m.venue <> 'limitless' or coalesce(lower(m.metadata->>'tradeType'), 'clob') <> 'amm')";
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
};

export async function fetchMarketsByTokenIds(
  pool: Pool,
  inputs: { tokenIds: string[]; venue?: string },
): Promise<MarketByTokenRow[]> {
  if (inputs.tokenIds.length === 0) return [];

  const params: PgParams = [inputs.tokenIds];
  let venueClause = "";
  if (inputs.venue) {
    params.push(inputs.venue);
    venueClause = `and m.venue = $${params.length}`;
  }

  const sql = `
    with market_tokens as (
      select
        m.id as market_id,
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
      from unified_markets m
    ),
    token_matches as (
      select
        ut.token_id,
        ut.side,
        ut.market_id
      from unified_tokens ut
      where ut.token_id = any($1::text[])

      union

      select
        token_map.token_id,
        case when token_map.ordinality = 1 then 'YES' else 'NO' end as side,
        m.id as market_id
      from unified_markets m
      cross join lateral (
        select elem.token_id, elem.ordinality
        from jsonb_array_elements_text(m.clob_token_ids::jsonb)
          with ordinality as elem(token_id, ordinality)
        where elem.token_id = any($1::text[])
      ) token_map
      where m.venue = 'polymarket'
        and m.clob_token_ids is not null
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
      e.icon as event_icon
    from token_matches tm
    join unified_markets m on m.id = tm.market_id
    join market_tokens mt on mt.market_id = m.id
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = mt.token_yes
      order by ts desc
      limit 1
    ) yes_top on true
    left join lateral (
      select best_bid, best_ask
      from unified_book_top
      where token_id = mt.token_no
      order by ts desc
      limit 1
    ) no_top on true
    left join polymarket_markets pm
      on pm.id = m.venue_market_id and m.venue = 'polymarket'
    left join polymarket_markets pm_parent
      on pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')
    left join unified_events e on e.id = m.event_id
    ${venueClause}
    order by array_position($1::text[], tm.token_id)
  `;

  const { rows } = await pool.query<MarketByTokenRow>(sql, params);
  return rows;
}
