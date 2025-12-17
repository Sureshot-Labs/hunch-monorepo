import { Pool } from "pg";

// Types for unified tables
export interface UnifiedEventRow {
  id: string; // venue:venue_event_id
  venue: string;
  venue_event_id: string;
  title: string;
  description?: string;
  category?: string;
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
  start_date?: Date;
  end_date?: Date;
  volume_total?: number;
  volume_24h?: number;
  open_interest?: number;
  liquidity?: number;
  slug?: string;
  image?: string;
  icon?: string;
  created_at?: Date;
  updated_at?: Date;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return Array.from(map.values());
}

export interface UnifiedMarketRow {
  id: string; // venue:venue_market_id
  venue: string;
  venue_market_id: string;
  event_id: string; // References unified_events.id
  title: string;
  description?: string;
  category?: string;
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
  market_type: string;
  open_time?: Date;
  close_time?: Date;
  expiration_time?: Date;
  best_bid?: number;
  best_ask?: number;
  last_price?: number;
  volume_total?: number;
  volume_24h?: number;
  open_interest?: number;
  liquidity?: number;
  outcomes?: string; // JSON string
  token_yes?: string; // Token ID for YES outcome (used by Limitless, Kalshi)
  token_no?: string; // Token ID for NO outcome (used by Limitless, Kalshi)
  clob_token_ids?: string; // JSON array of token IDs (used by Polymarket)
  condition_id?: string; // Condition ID for CLOB and resolution ties
  slug?: string;
  image?: string;
  icon?: string;
  created_at?: Date;
  updated_at?: Date;
}

// Repository functions for unified tables
export async function upsertUnifiedEvent(
  pool: Pool,
  eventRow: UnifiedEventRow,
): Promise<string> {
  const query = `
    INSERT INTO unified_events (
      id, venue, venue_event_id, title, description, category, status,
      start_date, end_date, volume_total, volume_24h, open_interest, liquidity, slug,
      image, icon, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
    )
    ON CONFLICT (venue, venue_event_id) 
    DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      volume_total = EXCLUDED.volume_total,
      volume_24h = EXCLUDED.volume_24h,
      open_interest = EXCLUDED.open_interest,
      liquidity = EXCLUDED.liquidity,
      slug = EXCLUDED.slug,
      image = EXCLUDED.image,
      icon = EXCLUDED.icon,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      updated_at_db = now()
    RETURNING id
  `;

  const values = [
    eventRow.id,
    eventRow.venue,
    eventRow.venue_event_id,
    eventRow.title,
    eventRow.description,
    eventRow.category,
    eventRow.status,
    eventRow.start_date,
    eventRow.end_date,
    eventRow.volume_total,
    eventRow.volume_24h,
    eventRow.open_interest,
    eventRow.liquidity,
    eventRow.slug,
    eventRow.image,
    eventRow.icon,
    eventRow.created_at,
    eventRow.updated_at,
  ];

  const result = await pool.query(query, values);
  return result.rows[0].id;
}

export async function upsertUnifiedEvents(
  pool: Pool,
  eventRows: UnifiedEventRow[],
): Promise<void> {
  if (eventRows.length === 0) return;

  const rows = dedupeById(eventRows);

  const query = `
    with input as (
      select *
      from jsonb_to_recordset($1::jsonb) as x(
        id text,
        venue text,
        venue_event_id text,
        title text,
        description text,
        category text,
        status unified_status,
        start_date timestamptz,
        end_date timestamptz,
        volume_total numeric,
        volume_24h numeric,
        open_interest numeric,
        liquidity numeric,
        slug text,
        image text,
        icon text,
        created_at timestamptz,
        updated_at timestamptz
      )
    )
    insert into unified_events (
      id, venue, venue_event_id, title, description, category, status,
      start_date, end_date, volume_total, volume_24h, open_interest, liquidity, slug,
      image, icon, created_at, updated_at
    )
    select
      id, venue, venue_event_id, title, description, category, status,
      start_date, end_date, volume_total, volume_24h, open_interest, liquidity, slug,
      image, icon, created_at, updated_at
    from input
    on conflict (venue, venue_event_id)
    do update set
      title = excluded.title,
      description = excluded.description,
      category = excluded.category,
      status = excluded.status,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      volume_total = excluded.volume_total,
      volume_24h = excluded.volume_24h,
      open_interest = excluded.open_interest,
      liquidity = excluded.liquidity,
      slug = excluded.slug,
      image = excluded.image,
      icon = excluded.icon,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      updated_at_db = now()
    where
      (unified_events.title, unified_events.description, unified_events.category,
       unified_events.status, unified_events.start_date, unified_events.end_date,
       unified_events.volume_total, unified_events.volume_24h, unified_events.open_interest,
       unified_events.liquidity, unified_events.slug, unified_events.image, unified_events.icon,
       unified_events.created_at, unified_events.updated_at)
      is distinct from
      (excluded.title, excluded.description, excluded.category,
       excluded.status, excluded.start_date, excluded.end_date,
       excluded.volume_total, excluded.volume_24h, excluded.open_interest,
       excluded.liquidity, excluded.slug, excluded.image, excluded.icon,
       excluded.created_at, excluded.updated_at)
  `;

  const batches = chunkArray(rows, 1000);
  for (const batch of batches) {
    await pool.query(query, [JSON.stringify(batch)]);
  }
}

export async function upsertUnifiedMarket(
  pool: Pool,
  marketRow: UnifiedMarketRow,
): Promise<string> {
  // Handle closed markets: skip new ones, delete existing ones
  if (
    marketRow.status === "CLOSED" ||
    marketRow.status === "SETTLED" ||
    marketRow.status === "ARCHIVED"
  ) {
    // Check if market exists in the database
    const existingMarket = await pool.query(
      "SELECT id FROM unified_markets WHERE venue = $1 AND venue_market_id = $2",
      [marketRow.venue, marketRow.venue_market_id],
    );

    if (existingMarket.rows.length === 0) {
      // Market doesn't exist and is closed - skip storing it
      return marketRow.id;
    } else {
      // Market exists and is now closed - delete it instead of updating
      await pool.query(
        "DELETE FROM unified_markets WHERE venue = $1 AND venue_market_id = $2",
        [marketRow.venue, marketRow.venue_market_id],
      );
      return marketRow.id;
    }
  }

  // Normal upsert for active markets
  const query = `
    INSERT INTO unified_markets (
      id, venue, venue_market_id, event_id, title, description, category, status,
      market_type, open_time, close_time, expiration_time, best_bid, best_ask,
      last_price, volume_total, volume_24h, open_interest, liquidity, outcomes,
      token_yes, token_no, clob_token_ids, condition_id, slug,
      image, icon, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29
    )
    ON CONFLICT (venue, venue_market_id) 
    DO UPDATE SET
      event_id = EXCLUDED.event_id,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      market_type = EXCLUDED.market_type,
      open_time = EXCLUDED.open_time,
      close_time = EXCLUDED.close_time,
      expiration_time = EXCLUDED.expiration_time,
      best_bid = EXCLUDED.best_bid,
      best_ask = EXCLUDED.best_ask,
      last_price = EXCLUDED.last_price,
      volume_total = EXCLUDED.volume_total,
      volume_24h = EXCLUDED.volume_24h,
      open_interest = EXCLUDED.open_interest,
      liquidity = EXCLUDED.liquidity,
      outcomes = EXCLUDED.outcomes,
      token_yes = EXCLUDED.token_yes,
      token_no = EXCLUDED.token_no,
      clob_token_ids = EXCLUDED.clob_token_ids,
      condition_id = EXCLUDED.condition_id,
      slug = EXCLUDED.slug,
      image = EXCLUDED.image,
      icon = EXCLUDED.icon,
      created_at = EXCLUDED.created_at,
      updated_at = EXCLUDED.updated_at,
      updated_at_db = now()
    RETURNING id
  `;

  const values = [
    marketRow.id,
    marketRow.venue,
    marketRow.venue_market_id,
    marketRow.event_id,
    marketRow.title,
    marketRow.description,
    marketRow.category,
    marketRow.status,
    marketRow.market_type,
    marketRow.open_time,
    marketRow.close_time,
    marketRow.expiration_time,
    marketRow.best_bid,
    marketRow.best_ask,
    marketRow.last_price,
    marketRow.volume_total,
    marketRow.volume_24h,
    marketRow.open_interest,
    marketRow.liquidity,
    marketRow.outcomes,
    marketRow.token_yes,
    marketRow.token_no,
    marketRow.clob_token_ids,
    marketRow.condition_id,
    marketRow.slug,
    marketRow.image,
    marketRow.icon,
    marketRow.created_at,
    marketRow.updated_at,
  ];

  const result = await pool.query(query, values);
  return result.rows[0].id;
}

export async function upsertUnifiedMarkets(
  pool: Pool,
  marketRows: UnifiedMarketRow[],
): Promise<void> {
  if (marketRows.length === 0) return;

  const rows = dedupeById(marketRows);

  const active: UnifiedMarketRow[] = [];
  const closedIds: string[] = [];
  for (const row of rows) {
    if (row.status === "ACTIVE") active.push(row);
    else closedIds.push(row.id);
  }

  if (closedIds.length) {
    const idBatches = chunkArray(closedIds, 5000);
    for (const batch of idBatches) {
      await pool.query(
        "delete from unified_markets where id = any($1::text[])",
        [batch],
      );
    }
  }

  if (!active.length) return;

  const query = `
    with input as (
      select *
      from jsonb_to_recordset($1::jsonb) as x(
        id text,
        venue text,
        venue_market_id text,
        event_id text,
        title text,
        description text,
        category text,
        status unified_status,
        market_type text,
        open_time timestamptz,
        close_time timestamptz,
        expiration_time timestamptz,
        best_bid numeric,
        best_ask numeric,
        last_price numeric,
        volume_total numeric,
        volume_24h numeric,
        open_interest numeric,
        liquidity numeric,
        outcomes text,
        token_yes text,
        token_no text,
        clob_token_ids text,
        condition_id text,
        slug text,
        image text,
        icon text,
        created_at timestamptz,
        updated_at timestamptz
      )
    )
    insert into unified_markets (
      id, venue, venue_market_id, event_id, title, description, category, status,
      market_type, open_time, close_time, expiration_time, best_bid, best_ask,
      last_price, volume_total, volume_24h, open_interest, liquidity, outcomes,
      token_yes, token_no, clob_token_ids, condition_id, slug,
      image, icon, created_at, updated_at
    )
    select
      id, venue, venue_market_id, event_id, title, description, category, status,
      market_type, open_time, close_time, expiration_time, best_bid, best_ask,
      last_price, volume_total, volume_24h, open_interest, liquidity, outcomes,
      token_yes, token_no, clob_token_ids, condition_id, slug,
      image, icon, created_at, updated_at
    from input
    on conflict (venue, venue_market_id)
    do update set
      event_id = excluded.event_id,
      title = excluded.title,
      description = excluded.description,
      category = excluded.category,
      status = excluded.status,
      market_type = excluded.market_type,
      open_time = excluded.open_time,
      close_time = excluded.close_time,
      expiration_time = excluded.expiration_time,
      best_bid = excluded.best_bid,
      best_ask = excluded.best_ask,
      last_price = excluded.last_price,
      volume_total = excluded.volume_total,
      volume_24h = excluded.volume_24h,
      open_interest = excluded.open_interest,
      liquidity = excluded.liquidity,
      outcomes = excluded.outcomes,
      token_yes = excluded.token_yes,
      token_no = excluded.token_no,
      clob_token_ids = excluded.clob_token_ids,
      condition_id = excluded.condition_id,
      slug = excluded.slug,
      image = excluded.image,
      icon = excluded.icon,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      updated_at_db = now()
    where
      (unified_markets.event_id, unified_markets.title, unified_markets.description,
       unified_markets.category, unified_markets.status, unified_markets.market_type,
       unified_markets.open_time, unified_markets.close_time, unified_markets.expiration_time,
       unified_markets.best_bid, unified_markets.best_ask, unified_markets.last_price,
       unified_markets.volume_total, unified_markets.volume_24h, unified_markets.open_interest,
       unified_markets.liquidity, unified_markets.outcomes, unified_markets.token_yes,
       unified_markets.token_no, unified_markets.clob_token_ids, unified_markets.condition_id,
       unified_markets.slug, unified_markets.image, unified_markets.icon,
       unified_markets.created_at, unified_markets.updated_at)
      is distinct from
      (excluded.event_id, excluded.title, excluded.description,
       excluded.category, excluded.status, excluded.market_type,
       excluded.open_time, excluded.close_time, excluded.expiration_time,
       excluded.best_bid, excluded.best_ask, excluded.last_price,
       excluded.volume_total, excluded.volume_24h, excluded.open_interest,
       excluded.liquidity, excluded.outcomes, excluded.token_yes,
       excluded.token_no, excluded.clob_token_ids, excluded.condition_id,
       excluded.slug, excluded.image, excluded.icon,
       excluded.created_at, excluded.updated_at)
  `;

  const batches = chunkArray(active, 500);
  for (const batch of batches) {
    await pool.query(query, [JSON.stringify(batch)]);
  }
}

function venueFromUnifiedTokenId(tokenId: string): string {
  if (tokenId.startsWith("kalshi:")) return "kalshi";
  if (tokenId.startsWith("sol:")) return "kalshi";
  if (tokenId.startsWith("limitless:")) return "limitless";
  return "polymarket";
}

export async function upsertUnifiedToken(
  pool: Pool,
  token: {
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
  },
): Promise<void> {
  await pool.query(
    `
    insert into unified_tokens(token_id, venue, market_id, side)
    values ($1,$2,$3,$4)
    on conflict (token_id) do nothing
  `,
    [
      token.token_id,
      venueFromUnifiedTokenId(token.token_id),
      token.market_id,
      token.side,
    ],
  );
}

export async function upsertUnifiedTokens(
  pool: Pool,
  tokens: Array<{
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
  }>,
): Promise<void> {
  if (tokens.length === 0) return;

  const byId = new Map<string, (typeof tokens)[number]>();
  for (const token of tokens) byId.set(token.token_id, token);
  const rows = Array.from(byId.values());

  // We want to call venueFromUnifiedTokenId() from SQL, but it's a TS function.
  // Instead, inject venue values in JS and batch insert.
  const payload = rows.map((r) => ({
    token_id: r.token_id,
    venue: venueFromUnifiedTokenId(r.token_id),
    market_id: r.market_id,
    side: r.side,
  }));

  const batchedQuery = `
    with input as (
      select *
      from json_to_recordset($1::json)
        as x(token_id text, venue text, market_id text, side text)
    )
    insert into unified_tokens(token_id, venue, market_id, side)
    select token_id, venue, market_id, side
    from input
    on conflict (token_id) do nothing
  `;

  const batches = chunkArray(payload, 500);
  for (const batch of batches) {
    await pool.query(batchedQuery, [JSON.stringify(batch)]);
  }
}

export async function writeUnifiedBookTop(
  pool: Pool,
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  ts: Date,
): Promise<void> {
  const mid =
    bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const spread =
    bestBid != null && bestAsk != null ? Math.max(0, bestAsk - bestBid) : null;

  await pool.query(
    `
    insert into unified_book_top(token_id, venue, ts, best_bid, best_ask, mid, spread)
    values ($1,$2,$3,$4,$5,$6,$7)
    on conflict do nothing
  `,
    [
      tokenId,
      venueFromUnifiedTokenId(tokenId),
      ts.toISOString(),
      bestBid,
      bestAsk,
      mid,
      spread,
    ],
  );
}
