import { chunkArray } from "@hunch/shared";
import { Pool } from "pg";

type BookTopCacheEntry = {
  bestBid: number | null;
  bestAsk: number | null;
  lastWrittenAtMs: number;
};

const BOOK_TOP_DEDUPE_EPSILON = 1e-9;
const BOOK_TOP_CACHE_MAX = 200_000;
const BOOK_TOP_CACHE_PRUNE_BATCH = 20_000;
const BOOK_TOP_HEARTBEAT_MS = (() => {
  const raw = process.env.UNIFIED_BOOK_TOP_HEARTBEAT_MS;
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
})();
const bookTopWriteCache = new Map<string, BookTopCacheEntry>();
const bookTopWriteInFlight = new Map<string, Promise<void>>();

function isBookTopValueEqual(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= BOOK_TOP_DEDUPE_EPSILON;
}

function setBookTopCache(tokenId: string, entry: BookTopCacheEntry): void {
  if (bookTopWriteCache.has(tokenId)) {
    bookTopWriteCache.delete(tokenId);
  }
  bookTopWriteCache.set(tokenId, entry);

  if (bookTopWriteCache.size <= BOOK_TOP_CACHE_MAX) return;
  for (let i = 0; i < BOOK_TOP_CACHE_PRUNE_BATCH; i += 1) {
    const oldest = bookTopWriteCache.keys().next().value;
    if (!oldest) break;
    bookTopWriteCache.delete(oldest);
  }
}

function shouldSkipBookTopWrite(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  tsMs: number,
): boolean {
  const prev = bookTopWriteCache.get(tokenId);
  if (!prev) {
    return false;
  }

  // Drop out-of-order updates so we do not regress the book timestamp per token.
  if (tsMs < prev.lastWrittenAtMs) {
    return true;
  }

  const unchanged =
    isBookTopValueEqual(prev.bestBid, bestBid) &&
    isBookTopValueEqual(prev.bestAsk, bestAsk);
  if (!unchanged) {
    return false;
  }

  if (BOOK_TOP_HEARTBEAT_MS > 0) {
    return tsMs - prev.lastWrittenAtMs < BOOK_TOP_HEARTBEAT_MS;
  }

  return true;
}

// Types for unified tables
export interface UnifiedEventRow {
  id: string; // venue:venue_event_id
  venue: string;
  venue_event_id: string;
  title: string;
  description?: string;
  category?: string;
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";
  series_key?: string;
  series_title?: string;
  start_date?: Date;
  end_date?: Date;
  volume_total?: number;
  volume_24h?: number;
  open_interest?: number;
  liquidity?: number;
  metadata?: unknown;
  slug?: string;
  image?: string;
  icon?: string;
  created_at?: Date;
  updated_at?: Date;
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
  metadata?: unknown;
  outcomes?: string; // JSON string
  token_yes?: string; // Token ID for YES outcome (used by Limitless, Kalshi)
  token_no?: string; // Token ID for NO outcome (used by Limitless, Kalshi)
  clob_token_ids?: string; // JSON array of token IDs (used by Polymarket)
  condition_id?: string; // Condition ID for CLOB and resolution ties
  market_ledger?: string; // DFlow market ledger (Solana)
  settlement_mint?: string; // DFlow settlement mint (Solana USDC)
  is_initialized?: boolean; // DFlow account initialization state
  redemption_status?: string; // DFlow redemption status (optional enum)
  resolved_outcome?: string; // Resolved outcome (YES/NO) when available
  resolved_outcome_pct?: number; // Resolved YES payout in bps for scalar outcomes
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
      series_key, series_title, start_date, end_date, volume_total, volume_24h, open_interest,
      liquidity, metadata, slug, image, icon, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
    )
    ON CONFLICT (venue, venue_event_id) 
    DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      status = EXCLUDED.status,
      series_key = EXCLUDED.series_key,
      series_title = EXCLUDED.series_title,
      start_date = EXCLUDED.start_date,
      end_date = EXCLUDED.end_date,
      volume_total = EXCLUDED.volume_total,
      volume_24h = EXCLUDED.volume_24h,
      open_interest = EXCLUDED.open_interest,
      liquidity = EXCLUDED.liquidity,
      metadata = EXCLUDED.metadata,
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
    eventRow.series_key,
    eventRow.series_title,
    eventRow.start_date,
    eventRow.end_date,
    eventRow.volume_total,
    eventRow.volume_24h,
    eventRow.open_interest,
    eventRow.liquidity,
    eventRow.metadata,
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
        series_key text,
        series_title text,
        start_date timestamptz,
        end_date timestamptz,
        volume_total numeric,
        volume_24h numeric,
        open_interest numeric,
        liquidity numeric,
        metadata jsonb,
        slug text,
        image text,
        icon text,
        created_at timestamptz,
        updated_at timestamptz
      )
    )
    insert into unified_events (
      id, venue, venue_event_id, title, description, category, status,
      series_key, series_title, start_date, end_date, volume_total, volume_24h, open_interest,
      liquidity, metadata, slug, image, icon, created_at, updated_at
    )
    select
      id, venue, venue_event_id, title, description, category, status,
      series_key, series_title, start_date, end_date, volume_total, volume_24h, open_interest,
      liquidity, metadata, slug, image, icon, created_at, updated_at
    from input
    on conflict (venue, venue_event_id)
    do update set
      title = excluded.title,
      description = excluded.description,
      category = excluded.category,
      status = excluded.status,
      series_key = excluded.series_key,
      series_title = excluded.series_title,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      volume_total = excluded.volume_total,
      volume_24h = excluded.volume_24h,
      open_interest = excluded.open_interest,
      liquidity = excluded.liquidity,
      metadata = excluded.metadata,
      slug = excluded.slug,
      image = excluded.image,
      icon = excluded.icon,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      updated_at_db = now()
    where
      (unified_events.title, unified_events.description, unified_events.category,
       unified_events.status, unified_events.series_key, unified_events.series_title,
       unified_events.start_date, unified_events.end_date,
       unified_events.volume_total, unified_events.volume_24h, unified_events.open_interest,
       unified_events.liquidity, unified_events.metadata, unified_events.slug, unified_events.image, unified_events.icon,
       unified_events.created_at, unified_events.updated_at)
      is distinct from
      (excluded.title, excluded.description, excluded.category,
       excluded.status, excluded.series_key, excluded.series_title, excluded.start_date, excluded.end_date,
       excluded.volume_total, excluded.volume_24h, excluded.open_interest,
       excluded.liquidity, excluded.metadata, excluded.slug, excluded.image, excluded.icon,
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
  const existingTokenSources = await loadUnifiedMarketTokenSources(pool, [
    marketRow.id,
  ]);
  const existingTokenSource = existingTokenSources.get(marketRow.id);
  const query = `
    INSERT INTO unified_markets (
      id, venue, venue_market_id, event_id, title, description, category, status,
      market_type, open_time, close_time, expiration_time, best_bid, best_ask,
      last_price, volume_total, volume_24h, open_interest, liquidity, metadata, outcomes,
      token_yes, token_no, clob_token_ids, condition_id, market_ledger,
      settlement_mint, is_initialized, redemption_status, resolved_outcome,
      resolved_outcome_pct, slug, image, icon, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
    )
    ON CONFLICT (venue, venue_market_id) 
    DO UPDATE SET
      event_id = EXCLUDED.event_id,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      status = CASE
        WHEN unified_markets.venue = 'kalshi'
          AND unified_markets.status in ('CLOSED','SETTLED','ARCHIVED')
          AND EXCLUDED.status = 'ACTIVE'
        THEN unified_markets.status
        ELSE EXCLUDED.status
      END,
      market_type = EXCLUDED.market_type,
      open_time = EXCLUDED.open_time,
      close_time = EXCLUDED.close_time,
      expiration_time = EXCLUDED.expiration_time,
      best_bid = CASE
        WHEN unified_markets.venue = 'limitless'
          AND coalesce(EXCLUDED.metadata->>'tradeType', '') = 'amm'
          AND EXCLUDED.best_bid IS NULL
        THEN unified_markets.best_bid
        ELSE EXCLUDED.best_bid
      END,
      best_ask = CASE
        WHEN unified_markets.venue = 'limitless'
          AND coalesce(EXCLUDED.metadata->>'tradeType', '') = 'amm'
          AND EXCLUDED.best_ask IS NULL
        THEN unified_markets.best_ask
        ELSE EXCLUDED.best_ask
      END,
      last_price = CASE
        WHEN unified_markets.venue = 'limitless'
          AND coalesce(EXCLUDED.metadata->>'tradeType', '') = 'amm'
          AND EXCLUDED.last_price IS NULL
        THEN unified_markets.last_price
        ELSE EXCLUDED.last_price
      END,
      volume_total = EXCLUDED.volume_total,
      volume_24h = EXCLUDED.volume_24h,
      open_interest = EXCLUDED.open_interest,
      liquidity = EXCLUDED.liquidity,
      metadata = EXCLUDED.metadata,
      outcomes = EXCLUDED.outcomes,
      token_yes = CASE
        WHEN unified_markets.venue = 'kalshi'
          AND unified_markets.token_yes like 'sol:%'
          AND EXCLUDED.token_yes like 'kalshi:%'
        THEN unified_markets.token_yes
        ELSE EXCLUDED.token_yes
      END,
      token_no = CASE
        WHEN unified_markets.venue = 'kalshi'
          AND unified_markets.token_no like 'sol:%'
          AND EXCLUDED.token_no like 'kalshi:%'
        THEN unified_markets.token_no
        ELSE EXCLUDED.token_no
      END,
      clob_token_ids = EXCLUDED.clob_token_ids,
      condition_id = EXCLUDED.condition_id,
      market_ledger = COALESCE(EXCLUDED.market_ledger, unified_markets.market_ledger),
      settlement_mint = COALESCE(EXCLUDED.settlement_mint, unified_markets.settlement_mint),
      is_initialized = COALESCE(EXCLUDED.is_initialized, unified_markets.is_initialized),
      redemption_status = COALESCE(EXCLUDED.redemption_status, unified_markets.redemption_status),
      resolved_outcome = COALESCE(EXCLUDED.resolved_outcome, unified_markets.resolved_outcome),
      resolved_outcome_pct = COALESCE(EXCLUDED.resolved_outcome_pct, unified_markets.resolved_outcome_pct),
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
    marketRow.metadata,
    marketRow.outcomes,
    marketRow.token_yes,
    marketRow.token_no,
    marketRow.clob_token_ids,
    marketRow.condition_id,
    marketRow.market_ledger,
    marketRow.settlement_mint,
    marketRow.is_initialized,
    marketRow.redemption_status,
    marketRow.resolved_outcome,
    marketRow.resolved_outcome_pct,
    marketRow.slug,
    marketRow.image,
    marketRow.icon,
    marketRow.created_at,
    marketRow.updated_at,
  ];

  const result = await pool.query(query, values);
  const id = result.rows[0].id as string;
  if (shouldSyncUnifiedMarketTokens(marketRow, existingTokenSource)) {
    await syncUnifiedMarketTokens(pool, [id]);
  }
  return id;
}

export async function upsertUnifiedMarkets(
  pool: Pool,
  marketRows: UnifiedMarketRow[],
): Promise<void> {
  if (marketRows.length === 0) return;

  const rows = dedupeById(marketRows);

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
        metadata jsonb,
        outcomes text,
        token_yes text,
        token_no text,
        clob_token_ids text,
        condition_id text,
        market_ledger text,
        settlement_mint text,
        is_initialized boolean,
        redemption_status text,
        resolved_outcome text,
        resolved_outcome_pct numeric,
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
      last_price, volume_total, volume_24h, open_interest, liquidity, metadata, outcomes,
      token_yes, token_no, clob_token_ids, condition_id, market_ledger,
      settlement_mint, is_initialized, redemption_status, resolved_outcome,
      resolved_outcome_pct, slug, image, icon, created_at, updated_at
    )
    select
      id, venue, venue_market_id, event_id, title, description, category, status,
      market_type, open_time, close_time, expiration_time, best_bid, best_ask,
      last_price, volume_total, volume_24h, open_interest, liquidity, metadata, outcomes,
      token_yes, token_no, clob_token_ids, condition_id, market_ledger,
      settlement_mint, is_initialized, redemption_status, resolved_outcome,
      resolved_outcome_pct, slug, image, icon, created_at, updated_at
    from input
    on conflict (venue, venue_market_id)
    do update set
      event_id = excluded.event_id,
      title = excluded.title,
      description = excluded.description,
      category = excluded.category,
      status = CASE
        WHEN unified_markets.venue = 'kalshi'
          AND unified_markets.status in ('CLOSED','SETTLED','ARCHIVED')
          AND excluded.status = 'ACTIVE'
        THEN unified_markets.status
        ELSE excluded.status
      END,
      market_type = excluded.market_type,
      open_time = excluded.open_time,
      close_time = excluded.close_time,
      expiration_time = excluded.expiration_time,
      best_bid = CASE
        WHEN unified_markets.venue = 'limitless'
          AND coalesce(excluded.metadata->>'tradeType', '') = 'amm'
          AND excluded.best_bid IS NULL
        THEN unified_markets.best_bid
        ELSE excluded.best_bid
      END,
      best_ask = CASE
        WHEN unified_markets.venue = 'limitless'
          AND coalesce(excluded.metadata->>'tradeType', '') = 'amm'
          AND excluded.best_ask IS NULL
        THEN unified_markets.best_ask
        ELSE excluded.best_ask
      END,
      last_price = CASE
        WHEN unified_markets.venue = 'limitless'
          AND coalesce(excluded.metadata->>'tradeType', '') = 'amm'
          AND excluded.last_price IS NULL
        THEN unified_markets.last_price
        ELSE excluded.last_price
      END,
      volume_total = excluded.volume_total,
      volume_24h = excluded.volume_24h,
      open_interest = excluded.open_interest,
      liquidity = excluded.liquidity,
      metadata = excluded.metadata,
      outcomes = excluded.outcomes,
      token_yes = CASE
        WHEN unified_markets.venue = 'kalshi'
          AND unified_markets.token_yes like 'sol:%'
          AND excluded.token_yes like 'kalshi:%'
        THEN unified_markets.token_yes
        ELSE excluded.token_yes
      END,
      token_no = CASE
        WHEN unified_markets.venue = 'kalshi'
          AND unified_markets.token_no like 'sol:%'
          AND excluded.token_no like 'kalshi:%'
        THEN unified_markets.token_no
        ELSE excluded.token_no
      END,
      clob_token_ids = excluded.clob_token_ids,
      condition_id = excluded.condition_id,
      market_ledger = COALESCE(excluded.market_ledger, unified_markets.market_ledger),
      settlement_mint = COALESCE(excluded.settlement_mint, unified_markets.settlement_mint),
      is_initialized = COALESCE(excluded.is_initialized, unified_markets.is_initialized),
      redemption_status = COALESCE(excluded.redemption_status, unified_markets.redemption_status),
      resolved_outcome = COALESCE(excluded.resolved_outcome, unified_markets.resolved_outcome),
      resolved_outcome_pct = COALESCE(excluded.resolved_outcome_pct, unified_markets.resolved_outcome_pct),
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
       unified_markets.liquidity, unified_markets.metadata, unified_markets.outcomes, unified_markets.token_yes,
       unified_markets.token_no, unified_markets.clob_token_ids, unified_markets.condition_id,
       unified_markets.market_ledger, unified_markets.settlement_mint,
       unified_markets.is_initialized, unified_markets.redemption_status,
       unified_markets.resolved_outcome, unified_markets.resolved_outcome_pct,
       unified_markets.slug, unified_markets.image, unified_markets.icon,
       unified_markets.created_at, unified_markets.updated_at)
      is distinct from
      (excluded.event_id, excluded.title, excluded.description,
       excluded.category, excluded.status, excluded.market_type,
       excluded.open_time, excluded.close_time, excluded.expiration_time,
       excluded.best_bid, excluded.best_ask, excluded.last_price,
       excluded.volume_total, excluded.volume_24h, excluded.open_interest,
       excluded.liquidity, excluded.metadata, excluded.outcomes, excluded.token_yes,
       excluded.token_no, excluded.clob_token_ids, excluded.condition_id,
       excluded.market_ledger, excluded.settlement_mint,
       excluded.is_initialized, excluded.redemption_status,
       excluded.resolved_outcome, excluded.resolved_outcome_pct,
       excluded.slug, excluded.image, excluded.icon,
       excluded.created_at, excluded.updated_at)
  `;

  const batches = chunkArray(rows, 500);
  for (const batch of batches) {
    const existingTokenSources = await loadUnifiedMarketTokenSources(
      pool,
      batch.map((row: UnifiedMarketRow) => row.id),
    );
    await pool.query(query, [JSON.stringify(batch)]);
    const changedMarketIds = batch
      .filter((row: UnifiedMarketRow) =>
        shouldSyncUnifiedMarketTokens(row, existingTokenSources.get(row.id)),
      )
      .map((row: UnifiedMarketRow) => row.id);
    if (changedMarketIds.length > 0) {
      await syncUnifiedMarketTokens(pool, changedMarketIds);
    }
  }
}

type UnifiedMarketTokenRow = {
  market_id: string;
  token_id: string;
  venue: string;
  outcome_side: "YES" | "NO" | null;
};

type MarketTokenSource = Pick<
  UnifiedMarketRow,
  "id" | "venue" | "token_yes" | "token_no" | "clob_token_ids"
>;

function parseClobTokenIds(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((token) => typeof token === "string") as string[];
  } catch {
    return [];
  }
}

function buildMarketTokenRows(market: MarketTokenSource): UnifiedMarketTokenRow[] {
  const tokens: UnifiedMarketTokenRow[] = [];
  const seen = new Set<string>();

  const pushToken = (token_id: string | null | undefined, outcome_side: "YES" | "NO" | null) => {
    if (!token_id) return;
    if (seen.has(token_id)) return;
    seen.add(token_id);
    tokens.push({
      market_id: market.id,
      token_id,
      venue: market.venue,
      outcome_side,
    });
  };

  pushToken(market.token_yes ?? null, "YES");
  pushToken(market.token_no ?? null, "NO");
  const clobTokens = parseClobTokenIds(market.clob_token_ids);
  if (clobTokens.length > 0) {
    pushToken(clobTokens[0], "YES");
    pushToken(clobTokens[1], "NO");
    for (const token of clobTokens.slice(2)) {
      pushToken(token, null);
    }
  }

  return tokens;
}

async function loadUnifiedMarketTokenSources(
  pool: Pool,
  marketIds: string[],
): Promise<Map<string, MarketTokenSource>> {
  const ids = Array.from(new Set(marketIds)).filter(Boolean);
  if (ids.length === 0) return new Map();

  const { rows } = await pool.query<MarketTokenSource>(
    `
      select id, venue, token_yes, token_no, clob_token_ids
      from unified_markets
      where id = any($1::text[])
    `,
    [ids],
  );

  return new Map(rows.map((row) => [row.id, row]));
}

function resolvePersistedMarketTokenSource(
  next: MarketTokenSource,
  current?: MarketTokenSource,
): MarketTokenSource {
  const token_yes =
    current?.venue === "kalshi" &&
    current.token_yes?.startsWith("sol:") &&
    next.token_yes?.startsWith("kalshi:")
      ? current.token_yes
      : next.token_yes;

  const token_no =
    current?.venue === "kalshi" &&
    current.token_no?.startsWith("sol:") &&
    next.token_no?.startsWith("kalshi:")
      ? current.token_no
      : next.token_no;

  return {
    id: next.id,
    venue: next.venue,
    token_yes,
    token_no,
    clob_token_ids: next.clob_token_ids,
  };
}

function buildMarketTokenSignature(source: MarketTokenSource): string[] {
  return buildMarketTokenRows(source)
    .map(
      (row) => `${row.venue}:${row.token_id}:${row.outcome_side ?? "__NULL__"}`,
    )
    .sort();
}

function shouldSyncUnifiedMarketTokens(
  next: MarketTokenSource,
  current?: MarketTokenSource,
): boolean {
  if (!current) return true;

  const currentSignature = buildMarketTokenSignature(current);
  const nextSignature = buildMarketTokenSignature(
    resolvePersistedMarketTokenSource(next, current),
  );

  if (currentSignature.length !== nextSignature.length) return true;
  for (let index = 0; index < currentSignature.length; index += 1) {
    if (currentSignature[index] !== nextSignature[index]) return true;
  }
  return false;
}

export async function syncUnifiedMarketTokens(
  pool: Pool,
  marketIds: string[],
): Promise<void> {
  const ids = Array.from(new Set(marketIds)).filter(Boolean);
  if (ids.length === 0) return;

  const batches = chunkArray(ids, 1000);
  for (const batch of batches) {
    const markets = await pool.query<MarketTokenSource>(
      `
        select id, venue, token_yes, token_no, clob_token_ids
        from unified_markets
        where id = any($1::text[])
      `,
      [batch],
    );

    const tokenRows = markets.rows.flatMap(buildMarketTokenRows);

    await pool.query("begin");
    try {
      await pool.query(
        `
          delete from unified_market_tokens
          where market_id = any($1::text[])
        `,
        [batch],
      );

      if (tokenRows.length > 0) {
        await pool.query(
          `
            insert into unified_market_tokens (market_id, token_id, venue, outcome_side)
            select x.market_id, x.token_id, x.venue, x.outcome_side
            from jsonb_to_recordset($1::jsonb) as x(
              market_id text,
              token_id text,
              venue text,
              outcome_side text
            )
            join unified_markets um on um.id = x.market_id
            on conflict (market_id, token_id) do update
              set venue = excluded.venue,
                  outcome_side = excluded.outcome_side
          `,
          [JSON.stringify(tokenRows)],
        );
      }
      await pool.query("commit");
    } catch (err) {
      await pool.query("rollback");
      throw err;
    }
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
    on conflict (market_id, side) do update
      set token_id = CASE
            WHEN unified_tokens.venue = 'kalshi'
              AND unified_tokens.token_id like 'sol:%'
              AND excluded.token_id like 'kalshi:%'
            THEN unified_tokens.token_id
            ELSE excluded.token_id
          END,
          venue = CASE
            WHEN unified_tokens.venue = 'kalshi'
              AND unified_tokens.token_id like 'sol:%'
              AND excluded.token_id like 'kalshi:%'
            THEN unified_tokens.venue
            ELSE excluded.venue
          END,
          updated_at = now()
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

  const byMarketSide = new Map<string, (typeof tokens)[number]>();
  for (const token of tokens) {
    byMarketSide.set(`${token.market_id}:${token.side}`, token);
  }
  const rows = Array.from(byMarketSide.values());

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
    on conflict (market_id, side) do update
      set token_id = excluded.token_id,
          venue = excluded.venue,
          updated_at = now()
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
  if (bestBid == null && bestAsk == null) return;

  const runWrite = async (): Promise<void> => {
    const tsMs = ts.getTime();
    if (shouldSkipBookTopWrite(tokenId, bestBid, bestAsk, tsMs)) {
      return;
    }

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

    await pool.query(
      `
      insert into unified_token_top_latest (
        token_id,
        venue,
        ts,
        best_bid,
        best_ask,
        mid,
        spread,
        updated_at
      )
      values ($1,$2,$3,$4,$5,$6,$7, now())
      on conflict (token_id) do update
        set venue = excluded.venue,
            ts = excluded.ts,
            best_bid = excluded.best_bid,
            best_ask = excluded.best_ask,
            mid = excluded.mid,
            spread = excluded.spread,
            updated_at = now()
      where excluded.ts >= unified_token_top_latest.ts
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

    setBookTopCache(tokenId, {
      bestBid,
      bestAsk,
      lastWrittenAtMs: tsMs,
    });
  };

  const prev = bookTopWriteInFlight.get(tokenId);
  let current: Promise<void>;
  if (prev) {
    current = prev.then(runWrite, runWrite);
  } else {
    current = runWrite();
  }

  bookTopWriteInFlight.set(tokenId, current);
  try {
    await current;
  } finally {
    if (bookTopWriteInFlight.get(tokenId) === current) {
      bookTopWriteInFlight.delete(tokenId);
    }
  }
}

export async function writeUnifiedLastTrade(
  pool: Pool,
  inputs: {
    tokenId: string;
    venue: string;
    price: number;
    size: number;
    side: "BUY" | "SELL";
    ts: Date;
    txHash?: string | null;
  },
): Promise<void> {
  const { tokenId, venue, price, size, side, ts, txHash } = inputs;
  await pool.query(
    `
      insert into unified_last_trade(token_id, venue, ts, price, size, side, tx_hash)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict do nothing
    `,
    [tokenId, venue, ts.toISOString(), price, size, side, txHash ?? null],
  );
}
