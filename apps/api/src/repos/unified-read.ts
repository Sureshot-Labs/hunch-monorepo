import type { Pool } from "@hunch/infra";
import type { PgParams } from "../server-types.js";

export type FeedInputs = {
  limit: number;
  offset: number;
  minVol: number;
  minLiquidity: number;
  venues?: string[];
  category?: string;
  filter?: string;
  sort?: string;
  nowParam: string;
  sevenDaysAgo: string;
  sevenDaysFromNow: string;
};

export async function fetchFeedEventIds(
  pool: Pool,
  inputs: FeedInputs,
): Promise<Array<{ id: string }>> {
  const eventParams: PgParams = [];
  const eventWhere: string[] = [];
  let paramIdx = 1;

  if (inputs.venues?.length) {
    eventParams.push(inputs.venues);
    eventWhere.push(`lower(e.venue) = ANY($${paramIdx++}::text[])`);
  }
  if (inputs.category) {
    // Case-insensitive category matching
    eventParams.push(inputs.category.toLowerCase());
    eventWhere.push(`lower(e.category) = $${paramIdx++}`);
  }

  // Filtering logic (filter param) - use parameterized dates for index usage
  if (inputs.filter === "newest") {
    eventParams.push(inputs.sevenDaysAgo);
    eventWhere.push(`e.start_date >= $${paramIdx++}`);
  } else if (inputs.filter === "endingsoon") {
    eventParams.push(inputs.sevenDaysFromNow);
    eventWhere.push(`e.end_date <= $${paramIdx++}`);
  }
  // if filter is not present, do not apply any filter

  // Always exclude expired, closed, settled, or archived events
  eventWhere.push("e.status = 'ACTIVE'");
  eventParams.push(inputs.nowParam);
  eventWhere.push(`(e.end_date IS NULL OR e.end_date > $${paramIdx++})`);

  // Sorting logic (sort param)
  let eventOrder = "";
  if (inputs.sort === "totalvol")
    eventOrder = "e.volume_total desc nulls last, e.id";
  else if (inputs.sort === "liquidity")
    eventOrder = "e.liquidity desc nulls last, e.id";
  else if (inputs.filter === "newest") {
    // When filtering by newest, sort by start_date descending (newest first)
    eventOrder = "e.start_date desc nulls last, e.id";
  } else if (inputs.filter === "endingsoon") {
    // When filtering by ending soon, sort by end_date ascending (ending soonest first)
    eventOrder = "e.end_date asc nulls last, e.id";
  } else if (inputs.sort == null || inputs.sort === "trending") {
    // Trending algorithm: combines volume, liquidity, and recency
    eventParams.push(inputs.sevenDaysAgo, inputs.sevenDaysFromNow);
    eventOrder = `
      (coalesce(e.volume_24h, 0) * 0.4 + 
       coalesce(e.liquidity, 0) * 0.3 + 
       case when e.start_date >= $${paramIdx++} then 1000 else 0 end * 0.2 +
       case when e.end_date <= $${paramIdx++} then 500 else 0 end * 0.1
      ) desc nulls last, e.id
    `;
  } else eventOrder = "e.start_date desc nulls last, e.id"; // fallback

  // Aggregate volume/liquidity for events
  // CRITICAL: Filter markets by ACTIVE status BEFORE joining to avoid scanning closed/settled markets
  // Use parameterized now() for better index usage
  eventParams.push(inputs.nowParam, inputs.nowParam);
  const eventSql = `
    select
      e.id,
      sum(coalesce(m.volume_24h, 0)) as total_volume,
      sum(coalesce(m.liquidity, 0)) as total_liquidity,
      e.start_date,
      e.end_date
    from unified_events e
    join unified_markets m on m.event_id = e.id
      and m.status = 'ACTIVE'
      and (m.expiration_time IS NULL OR m.expiration_time > $${paramIdx++})
      and (m.close_time IS NULL OR m.close_time > $${paramIdx++})
    ${eventWhere.length ? "where " + eventWhere.join(" and ") : ""}
    group by e.id, e.start_date, e.end_date
    having bool_or(
      (coalesce(m.volume_24h, 0) >= $${paramIdx++} or m.volume_24h is null)
      and coalesce(m.liquidity, 0) >= $${paramIdx++}
    )
    ${eventOrder ? `order by ${eventOrder}` : ""}
    limit ${inputs.limit} offset ${inputs.offset}
  `;
  eventParams.push(inputs.minVol, inputs.minLiquidity);

  const { rows } = await pool.query<{ id: string }>(eventSql, eventParams);
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
  const marketParams: PgParams = [
    inputs.minVol,
    inputs.minLiquidity,
    eventIds,
    inputs.nowParam,
    inputs.nowParam,
  ];
  const marketWhere: string[] = [
    "(coalesce(m.volume_24h, 0) >= $1 or m.volume_24h is null)",
    "coalesce(m.liquidity, 0) >= $2",
    // Only show ACTIVE markets - exclude CLOSED, SETTLED, and ARCHIVED
    "m.status = 'ACTIVE'",
    `m.event_id = ANY($3::text[])`,
    // Critical: Exclude expired or closed markets based on time
    // This ensures we don't show expired/closed markets even if status hasn't been updated yet
    // Use parameterized dates for index usage
    "(m.expiration_time IS NULL OR m.expiration_time > $4)",
    "(m.close_time IS NULL OR m.close_time > $5)",
  ];

  // Sorting for markets: use same sort as for events, or none
  let marketOrder = "";
  if (inputs.sort === "totalvol")
    marketOrder = "m.volume_24h desc nulls last, m.venue_market_id";
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
    // Use parameterized dates for index usage
    // Parameters are already: $1=minVol, $2=minLiquidity, $3=eventIds, $4=nowParam, $5=nowParam
    // So $6 and $7 will be the date parameters
    marketParams.push(inputs.sevenDaysAgo, inputs.sevenDaysFromNow);
    marketOrder = `
      (coalesce(m.volume_24h, 0) * 0.4 + 
       coalesce(m.liquidity, 0) * 0.3 + 
       case when e.start_date >= $6 then 1000 else 0 end * 0.2 +
       case when e.end_date <= $7 then 500 else 0 end * 0.1
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
      e.liquidity as event_liquidity,
      e.volume_total as event_volume,
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

  const { rows } = await pool.query<FeedMarketRow>(marketSql, marketParams);
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
