import type { Pool } from "@hunch/infra";
import type { PgParams } from "../server-types.js";

export type FeedInputs = {
  limit: number;
  offset: number;
  minVol: number;
  minLiquidity: number;
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
    "case when e.liquidity >= 9e18 then null else e.liquidity end";

  if (inputs.venues?.length) {
    eventWhere.push(`lower(e.venue) = ANY(${add(inputs.venues)}::text[])`);
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

  if (inputs.filter === "newest") {
    eventWhere.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}`);
  } else if (inputs.filter === "endingsoon") {
    eventWhere.push(`e.end_date <= ${add(inputs.sevenDaysFromNow)}`);
  }

  eventWhere.push("e.status = 'ACTIVE'");

  const nowParam = add(inputs.nowParam);
  eventWhere.push(`(e.end_date is null or e.end_date > ${nowParam})`);

  if (inputs.endWithin) {
    eventWhere.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}`,
    );
  }
  if (inputs.ageSince) {
    eventWhere.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}`,
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
      `coalesce(m.liquidity, ${safeEventLiquidityExpr}, 0) >= ${add(inputs.minLiquidity)}`,
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
      `coalesce(e.volume_24h, sum(coalesce(m.volume_24h, 0))) >= ${add(inputs.minVol)}`,
    );
  }
  having.push(`bool_or(${marketQualSql})`);

  let eventOrder = "";
  if (inputs.sort === "totalvol")
    eventOrder = "e.volume_total desc nulls last, e.id";
  else if (inputs.sort === "liquidity")
    eventOrder = `(${safeEventLiquidityExpr}) desc nulls last, e.id`;
  else if (inputs.filter === "newest")
    eventOrder = "e.start_date desc nulls last, e.id";
  else if (inputs.filter === "endingsoon")
    eventOrder = "e.end_date asc nulls last, e.id";
  else if (inputs.sort == null || inputs.sort === "trending") {
    const sevenDaysAgo = add(inputs.sevenDaysAgo);
    const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
    eventOrder = `
      (coalesce(e.volume_24h, 0) * 0.4 +
       coalesce(${safeEventLiquidityExpr}, 0) * 0.3 +
       case when e.start_date >= ${sevenDaysAgo} then 1000 else 0 end * 0.2 +
       case when e.end_date <= ${sevenDaysFromNow} then 500 else 0 end * 0.1
      ) desc nulls last, e.id
    `;
  } else eventOrder = "e.start_date desc nulls last, e.id";

  const eventSql = `
    select
      e.id
    from unified_events e
    join unified_markets m on m.event_id = e.id
      and m.status = 'ACTIVE'
      and (m.expiration_time is null or m.expiration_time > ${nowParam})
      and (m.close_time is null or m.close_time > ${nowParam})
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
  event_volume: unknown;
  event_volume_24h: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  market_uuid: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  volume_24h: unknown;
  volume_total: unknown;
  open_interest: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
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
  const safeEventLiquidityExpr =
    "case when e.liquidity >= 9e18 then null else e.liquidity end";

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
    `(m.expiration_time is null or m.expiration_time > ${nowParam})`,
    `(m.close_time is null or m.close_time > ${nowCloseParam})`,
  ];

  if (inputs.minLiquidity > 0) {
    marketWhere.push(
      `coalesce(m.liquidity, ${safeEventLiquidityExpr}, 0) >= ${add(inputs.minLiquidity)}`,
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

  // Sorting for markets: use same sort as for events, or none
  let marketOrder = "";
  if (inputs.sort === "totalvol")
    marketOrder = "m.volume_total desc nulls last, m.venue_market_id";
  else if (inputs.sort === "liquidity")
    marketOrder = "m.liquidity desc nulls last, m.venue_market_id";
  else if (inputs.filter === "newest") {
    // When filtering by newest, sort by event start_date descending (newest first)
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  } else if (inputs.filter === "endingsoon") {
    // When filtering by ending soon, sort by event end_date ascending (ending soonest first)
    marketOrder = "e.end_date asc nulls last, m.venue_market_id";
  } else if (inputs.sort == null || inputs.sort === "trending") {
    // Trending algorithm for markets: combines volume, liquidity, and recency
    marketOrder = `
      (coalesce(m.volume_24h, 0) * 0.4 + 
       coalesce(m.liquidity, 0) * 0.3 + 
       case when e.start_date >= (${nowParam}::timestamptz - interval '7 days') then 1000 else 0 end * 0.2 +
       case when e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
      ) desc nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id"; // fallback

  const marketSql = `
    select
      e.id as event_id,
      e.title as event_title,
      e.category,
      e.start_date,
      e.end_date,
      (${safeEventLiquidityExpr}) as event_liquidity,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      m.id as market_uuid,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      m.last_price,
      m.token_yes,
      m.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.updated_at as last_update
    from unified_events e
    join unified_markets m on m.event_id = e.id
    where ${marketWhere.join(" and ")}
    ${marketOrder ? `order by ${marketOrder}` : ""}
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
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
  condition_id: string | null;
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
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      m.last_price,
      m.outcomes,
      m.token_yes,
      m.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.created_at,
      m.updated_at
    FROM unified_events e
    JOIN unified_markets m ON m.event_id = e.id
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
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  open_interest: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: unknown;
  token_no: unknown;
  clob_token_ids: unknown;
  condition_id: string | null;
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
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      m.last_price,
      m.outcomes,
      m.token_yes,
      m.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.created_at as market_created_at,
      m.updated_at as market_updated_at
    FROM unified_events e
    LEFT JOIN unified_markets m ON m.event_id = e.id
    WHERE e.id = $1 OR e.venue_event_id = $1
    ORDER BY m.volume_24h DESC NULLS LAST, m.liquidity DESC NULLS LAST, m.venue_market_id
  `;

  const { rows } = await pool.query<EventDetailsRow>(eventSql, [eventId]);
  return rows;
}
