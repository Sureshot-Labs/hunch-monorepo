import {
  writeResolvedTerminalTokenTops,
  writeUnifiedBookTop,
  writeUnifiedLastTrade,
} from "@hunch/db";
import { createTopTickGate } from "@hunch/infra";
import PQueue from "p-queue";
import WebSocket from "ws";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  LatestQuoteQueue,
  MarketSubscriptions,
  MarketSubscriptionShards,
  MarketEventDeduper,
  reconnectAttempt,
  mergeMarketQuote,
  type MarketQuote,
} from "./market-ws-flow.js";
import { env } from "./env.js";
import { fetchEventsByIds, fetchMarketById } from "./gammaClient.js";
import { log } from "./log.js";
import {
  mapPolymarketEventRow,
  mapPolymarketMarketRow,
  mapToUnifiedEvent,
  mapToUnifiedMarket,
} from "./mappers.js";
import {
  upsertEventsConsistently,
  upsertMarketsConsistently,
} from "./consistentUpserts.js";
import { ensureRedis, redis } from "./redis.js";
import { pool } from "./db.js";
import { PolymarketEvent, type TPolymarketEvent } from "./types.js";

type PriceLevel = { price: unknown };
type TokenMarketRef = {
  marketId: string;
  venueMarketId: string;
  conditionId: string | null;
  tokenYes: string | null;
  tokenNo: string | null;
};
type ParsedMarketState = {
  tokenId: string;
  eventType: string;
  market: string | null;
  conditionId: string | null;
  status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" | null;
  acceptingOrders: boolean | null;
  resolvedOutcome: "YES" | "NO" | null;
  winningAssetId: string | null;
  venueMarketId: string | null;
  ts: number;
};

const mq = new PQueue({ concurrency: Number(env.wsConcurrency || 8) });
const refreshQueue = new PQueue({ concurrency: 1 });
const pendingEventRefresh = new Set<string>();
const pendingMarketRefresh = new Set<string>();

const TOKEN_MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const TOKEN_MARKET_CACHE_MAX = 200_000;
const TOKEN_MARKET_CACHE_PRUNE_BATCH = 20_000;
const tokenMarketRefCache = new Map<
  string,
  { ref: TokenMarketRef | null; expiresAtMs: number }
>();

let redisBound = false;
let shutdownBound = false;
type SocketShard = {
  id: number;
  desired: string[];
  ws: WebSocket | null;
  subscriptions: MarketSubscriptions | null;
  reconnectTimer: NodeJS.Timeout | null;
  reportFlow?: () => void;
};
const socketShards = new Map<number, SocketShard>();
const subscriptionShards = new MarketSubscriptionShards(
  env.wsTokensPerSocket ?? 500,
);
const marketEvents = new MarketEventDeduper();
let stopping = false;
// Bun's event-loop histograms share native sampling state: resetting/disabling
// one per socket also resets/disables the others. Own one monitor per pool.
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
let flowInterval: NodeJS.Timeout | null = null;
function subscriptionCoverage() {
  let desiredTokens = 0;
  let connectedTokens = 0;
  let connectedSockets = 0;
  for (const shard of socketShards.values()) {
    desiredTokens += shard.desired.length;
    if (shard.ws?.readyState !== WebSocket.OPEN) continue;
    connectedSockets++;
    for (const token of shard.desired) {
      if (shard.subscriptions?.subscribed.has(token)) connectedTokens++;
    }
  }
  return { desiredTokens, connectedTokens, connectedSockets };
}
const quoteQueue = new LatestQuoteQueue<MarketQuote>(
  Number(env.wsConcurrency || 8),
  async (tick) => {
    await publishTopTickNow(
      tick.tokenId,
      tick.bestBid,
      tick.bestAsk,
      tick.tsMs,
      tick.bookPayload,
      tick.alreadyPersisted,
    );
  },
  (error) => log.warn("Top tick publish failed", { error: String(error) }),
  mergeMarketQuote,
);
const topTickGate = createTopTickGate({
  onDeferredPublish: ({ tokenId, bestBid, bestAsk, tsMs }) => {
    quoteQueue.push({ tokenId, bestBid, bestAsk, tsMs });
  },
});

function bindRedisErrorOnce() {
  if (redisBound) return;
  redisBound = true;
  redis.on("error", (e) => log.err("redis error", e));
}

function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseSize(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    ) {
      return true;
    }
    if (
      normalized === "false" ||
      normalized === "0" ||
      normalized === "no" ||
      normalized === "off"
    ) {
      return false;
    }
  }
  return null;
}

function normalizeSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  if (lower.includes("buy")) return "BUY";
  if (lower.includes("sell")) return "SELL";
  return null;
}

function normalizeOutcome(value: unknown): "YES" | "NO" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === "YES" || normalized === "NO") return normalized;
  return null;
}

function normalizeStatus(
  value: unknown,
): "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (
    normalized === "ACTIVE" ||
    normalized === "CLOSED" ||
    normalized === "SETTLED" ||
    normalized === "ARCHIVED"
  ) {
    return normalized;
  }
  return null;
}

function parseTimestampMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return Date.now();
  return n < 1e12 ? n * 1000 : n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseTokenIds(value: unknown): string[] {
  if (typeof value === "string") {
    const id = parseString(value);
    return id ? [id] : [];
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => parseString(item))
    .filter((item): item is string => Boolean(item));
}

function pickTokenId(record: Record<string, unknown>): string | null {
  return (
    parseString(record.asset_id) ??
    parseString(record.token_id) ??
    parseString(record.assetId) ??
    parseString(record.tokenId)
  );
}

function pickConditionId(record: Record<string, unknown>): string | null {
  return (
    parseString(record.market) ??
    parseString(record.condition_id) ??
    parseString(record.conditionId)
  );
}

function pickVenueMarketId(record: Record<string, unknown>): string | null {
  return (
    parseString(record.id) ??
    parseString(record.market_id) ??
    parseString(record.marketId)
  );
}

function pickEventId(record: Record<string, unknown>): string | null {
  const direct =
    parseString(record.event_id) ??
    parseString(record.eventId) ??
    parseString(record.eventID) ??
    parseString(record.event);
  if (direct) return direct;

  const nested = record.event_message;
  if (!isRecord(nested)) return null;
  return (
    parseString(nested.id) ??
    parseString(nested.event_id) ??
    parseString(nested.eventId)
  );
}

function parseLevels(value: unknown): PriceLevel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PriceLevel => isRecord(item) && "price" in item,
  );
}

function bestBid(levels: PriceLevel[]): number | null {
  if (levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p > best) best = p;
  }
  return best;
}

function bestAsk(levels: PriceLevel[]): number | null {
  if (levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p < best) best = p;
  }
  return best;
}

function setTokenMarketRefCache(tokenId: string, ref: TokenMarketRef): void {
  const expiresAtMs = Date.now() + TOKEN_MARKET_CACHE_TTL_MS;
  if (tokenMarketRefCache.has(tokenId)) {
    tokenMarketRefCache.delete(tokenId);
  }
  tokenMarketRefCache.set(tokenId, { ref, expiresAtMs });

  if (ref?.tokenYes && ref.tokenYes !== tokenId) {
    tokenMarketRefCache.set(ref.tokenYes, { ref, expiresAtMs });
  }
  if (ref?.tokenNo && ref.tokenNo !== tokenId) {
    tokenMarketRefCache.set(ref.tokenNo, { ref, expiresAtMs });
  }

  if (tokenMarketRefCache.size <= TOKEN_MARKET_CACHE_MAX) return;
  for (let i = 0; i < TOKEN_MARKET_CACHE_PRUNE_BATCH; i += 1) {
    const oldest = tokenMarketRefCache.keys().next().value;
    if (!oldest) break;
    tokenMarketRefCache.delete(oldest);
  }
}

async function resolveTokenMarketRef(
  tokenId: string,
): Promise<TokenMarketRef | null> {
  const nowMs = Date.now();
  const cached = tokenMarketRefCache.get(tokenId);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.ref;
  }

  const { rows } = await pool.query<{
    market_id: string;
    venue_market_id: string;
    condition_id: string | null;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select
        m.id as market_id,
        m.venue_market_id,
        m.condition_id,
        yes_token.token_id as token_yes,
        no_token.token_id as token_no
      from unified_market_tokens mt
      join unified_markets m
        on m.id = mt.market_id
       and m.venue = 'polymarket'
      left join unified_market_tokens yes_token
        on yes_token.market_id = m.id
       and yes_token.outcome_side = 'YES'
      left join unified_market_tokens no_token
        on no_token.market_id = m.id
       and no_token.outcome_side = 'NO'
      where mt.token_id = $1
      limit 1
    `,
    [tokenId],
  );

  const row = rows[0];
  if (!row) return null;

  const ref = {
    marketId: row.market_id,
    venueMarketId: row.venue_market_id,
    conditionId: row.condition_id ?? null,
    tokenYes: row.token_yes ?? null,
    tokenNo: row.token_no ?? null,
  };

  setTokenMarketRefCache(tokenId, ref);
  return ref;
}

async function resolveTokensByVenueMarketId(
  venueMarketId: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ token_id: string }>(
    `
      select mt.token_id
      from unified_markets m
      join unified_market_tokens mt on mt.market_id = m.id
      where m.venue = 'polymarket'
        and m.venue_market_id = $1
    `,
    [venueMarketId],
  );
  return rows.map((row) => row.token_id);
}

async function resolveTokenMarketRefByVenueMarketId(
  venueMarketId: string,
): Promise<TokenMarketRef | null> {
  const { rows } = await pool.query<{
    market_id: string;
    venue_market_id: string;
    condition_id: string | null;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select
        m.id as market_id,
        m.venue_market_id,
        m.condition_id,
        yes_token.token_id as token_yes,
        no_token.token_id as token_no
      from unified_markets m
      left join unified_market_tokens yes_token
        on yes_token.market_id = m.id
       and yes_token.outcome_side = 'YES'
      left join unified_market_tokens no_token
        on no_token.market_id = m.id
       and no_token.outcome_side = 'NO'
      where m.venue = 'polymarket'
        and m.venue_market_id = $1
      limit 1
    `,
    [venueMarketId],
  );

  const row = rows[0];
  if (!row) return null;
  const ref = {
    marketId: row.market_id,
    venueMarketId: row.venue_market_id,
    conditionId: row.condition_id ?? null,
    tokenYes: row.token_yes ?? null,
    tokenNo: row.token_no ?? null,
  };
  if (ref.tokenYes) setTokenMarketRefCache(ref.tokenYes, ref);
  if (ref.tokenNo) setTokenMarketRefCache(ref.tokenNo, ref);
  return ref;
}

function resolveOutcomeFromWinner(
  ref: TokenMarketRef | null,
  requested: "YES" | "NO" | null,
  winningAssetId: string | null,
): "YES" | "NO" | null {
  if (requested) return requested;
  if (!ref || !winningAssetId) return null;
  if (ref.tokenYes && ref.tokenYes === winningAssetId) return "YES";
  if (ref.tokenNo && ref.tokenNo === winningAssetId) return "NO";
  return null;
}

async function setPolymarketAcceptingOrders(
  ref: TokenMarketRef,
  acceptingOrders: boolean,
  tsMs: number,
): Promise<void> {
  if (!acceptingOrders) {
    await pool.query(
      `
        update unified_markets
        set
          status = 'CLOSED',
          updated_at = greatest(
            coalesce(updated_at, to_timestamp(0)),
            to_timestamp($2 / 1000.0)
          ),
          updated_at_db = now()
        where id = $1
          and venue = 'polymarket'
          and status = 'ACTIVE'
      `,
      [ref.marketId, tsMs],
    );
  } else {
    await pool.query(
      `
        update unified_markets
        set
          status = 'ACTIVE',
          updated_at = greatest(
            coalesce(updated_at, to_timestamp(0)),
            to_timestamp($2 / 1000.0)
          ),
          updated_at_db = now()
        where id = $1
          and venue = 'polymarket'
          and status = 'CLOSED'
      `,
      [ref.marketId, tsMs],
    );
  }

  await pool.query(
    `
      update polymarket_markets pm
      set
        accepting_orders = $2,
        accepting_orders_timestamp = to_timestamp($3 / 1000.0),
        updated_at_db = now()
      from unified_markets m
      where m.id = $1
        and m.venue = 'polymarket'
        and pm.id = m.venue_market_id
        and pm.accepting_orders is distinct from $2
    `,
    [ref.marketId, acceptingOrders, tsMs],
  );
}

async function setPolymarketAcceptingOrdersByVenueMarketId(
  venueMarketId: string,
  acceptingOrders: boolean,
  tsMs: number,
): Promise<void> {
  if (!acceptingOrders) {
    await pool.query(
      `
        update unified_markets
        set
          status = 'CLOSED',
          updated_at = greatest(
            coalesce(updated_at, to_timestamp(0)),
            to_timestamp($2 / 1000.0)
          ),
          updated_at_db = now()
        where venue = 'polymarket'
          and venue_market_id = $1
          and status = 'ACTIVE'
      `,
      [venueMarketId, tsMs],
    );
  } else {
    await pool.query(
      `
        update unified_markets
        set
          status = 'ACTIVE',
          updated_at = greatest(
            coalesce(updated_at, to_timestamp(0)),
            to_timestamp($2 / 1000.0)
          ),
          updated_at_db = now()
        where venue = 'polymarket'
          and venue_market_id = $1
          and status = 'CLOSED'
      `,
      [venueMarketId, tsMs],
    );
  }

  await pool.query(
    `
      update polymarket_markets
      set
        accepting_orders = $2,
        accepting_orders_timestamp = to_timestamp($3 / 1000.0),
        updated_at_db = now()
      where id = $1
        and accepting_orders is distinct from $2
    `,
    [venueMarketId, acceptingOrders, tsMs],
  );
}

async function setPolymarketResolved(
  ref: TokenMarketRef,
  resolvedOutcome: "YES" | "NO" | null,
  tsMs: number,
): Promise<void> {
  await pool.query(
    `
      update unified_markets
      set
        status = 'SETTLED',
        resolved_outcome = coalesce($2, resolved_outcome),
        updated_at = greatest(
          coalesce(updated_at, to_timestamp(0)),
          to_timestamp($3 / 1000.0)
        ),
        updated_at_db = now()
      where id = $1
        and venue = 'polymarket'
        and status <> 'ARCHIVED'
    `,
    [ref.marketId, resolvedOutcome, tsMs],
  );

  await pool.query(
    `
      update polymarket_markets pm
      set
        accepting_orders = false,
        accepting_orders_timestamp = to_timestamp($2 / 1000.0),
        updated_at_db = now()
      from unified_markets m
      where m.id = $1
        and m.venue = 'polymarket'
        and pm.id = m.venue_market_id
    `,
    [ref.marketId, tsMs],
  );
}

async function setResolvedByVenueMarketId(
  venueMarketId: string,
  resolvedOutcome: "YES" | "NO" | null,
  tsMs: number,
): Promise<void> {
  await pool.query(
    `
      update unified_markets
      set
        status = 'SETTLED',
        resolved_outcome = coalesce($2, resolved_outcome),
        updated_at = greatest(
          coalesce(updated_at, to_timestamp(0)),
          to_timestamp($3 / 1000.0)
        ),
        updated_at_db = now()
      where venue = 'polymarket'
        and venue_market_id = $1
        and status <> 'ARCHIVED'
    `,
    [venueMarketId, resolvedOutcome, tsMs],
  );

  await pool.query(
    `
      update polymarket_markets
      set
        accepting_orders = false,
        accepting_orders_timestamp = to_timestamp($2 / 1000.0),
        updated_at_db = now()
      where id = $1
    `,
    [venueMarketId, tsMs],
  );
}

async function publishTopTickNow(
  tokenId: string,
  bestBidValue: number | null,
  bestAskValue: number | null,
  tsMs: number,
  bookPayload?: unknown,
  alreadyPersisted = false,
): Promise<void> {
  const tick = {
    token_id: tokenId,
    best_bid: bestBidValue,
    best_ask: bestAskValue,
    ts: tsMs,
  };
  const tickJson = JSON.stringify(tick);

  const multi = redis.multi();
  if (bookPayload !== undefined) {
    multi.set(`book:${tokenId}`, JSON.stringify(bookPayload), { EX: 5 });
  }
  multi.set(`top:${tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${tokenId}`, tickJson);

  await Promise.all([
    alreadyPersisted
      ? Promise.resolve()
      : writeUnifiedBookTop(
          pool,
          tokenId,
          bestBidValue,
          bestAskValue,
          new Date(tsMs),
          { touchLatestWhenUnchanged: true },
        ),
    multi.exec(),
  ]);
}

async function publishResolvedTerminalTopTicks(input: {
  marketId: string;
  noTokenId: string | null;
  observedAtMs: number;
  resolvedOutcome: "YES" | "NO" | null;
  yesTokenId: string | null;
}): Promise<void> {
  if (!input.resolvedOutcome) return;
  const observedAt = new Date(input.observedAtMs);
  const result = await writeResolvedTerminalTokenTops(pool, {
    marketId: input.marketId,
    noTokenId: input.noTokenId,
    observedAt,
    resolvedOutcome: input.resolvedOutcome,
    yesTokenId: input.yesTokenId,
  });
  if (result.tokenPrices.length === 0) return;

  for (const row of result.tokenPrices) {
    // Cancel older deferred ticks and serialize Redis publication after any
    // in-flight top write. The terminal DB write above must not be repeated.
    const tick = {
      tokenId: row.tokenId,
      bestBid: row.price,
      bestAsk: row.price,
      tsMs: input.observedAtMs,
    };
    topTickGate.shouldPublish({ ...tick, forcePublish: true });
    quoteQueue.push({ ...tick, alreadyPersisted: true });
  }
}

function publishTopTick(
  tokenId: string,
  bestBidValue: number | null,
  bestAskValue: number | null,
  tsMs: number,
  bookPayload?: unknown,
): void {
  if (bestBidValue == null && bestAskValue == null) return;
  if (
    !topTickGate.shouldPublish({
      tokenId,
      bestBid: bestBidValue,
      bestAsk: bestAskValue,
      tsMs,
    })
  ) {
    return;
  }

  quoteQueue.push({
    tokenId,
    bestBid: bestBidValue,
    bestAsk: bestAskValue,
    tsMs,
    bookPayload,
  });
}

async function publishMarketState(
  stateUpdate: ParsedMarketState,
): Promise<void> {
  const payload = {
    schema_version: 1,
    venue: "polymarket",
    token_id: stateUpdate.tokenId,
    market: stateUpdate.market,
    condition_id: stateUpdate.conditionId,
    event_type: stateUpdate.eventType,
    status: stateUpdate.status,
    accepting_orders: stateUpdate.acceptingOrders,
    resolved_outcome: stateUpdate.resolvedOutcome,
    ts: stateUpdate.ts,
  };
  const payloadJson = JSON.stringify(payload);

  const multi = redis.multi();
  multi.set(`market_state:${stateUpdate.tokenId}`, payloadJson, { EX: 60 });
  multi.publish(`market_state:${stateUpdate.tokenId}`, payloadJson);
  await multi.exec();

  const ref = await resolveTokenMarketRef(stateUpdate.tokenId);
  if (stateUpdate.acceptingOrders != null) {
    if (ref) {
      await setPolymarketAcceptingOrders(
        ref,
        stateUpdate.acceptingOrders,
        stateUpdate.ts,
      );
    } else if (stateUpdate.venueMarketId) {
      await setPolymarketAcceptingOrdersByVenueMarketId(
        stateUpdate.venueMarketId,
        stateUpdate.acceptingOrders,
        stateUpdate.ts,
      );
    }
  }

  if (
    stateUpdate.status === "SETTLED" ||
    stateUpdate.resolvedOutcome != null ||
    stateUpdate.winningAssetId != null
  ) {
    const resolvedOutcome = resolveOutcomeFromWinner(
      ref,
      stateUpdate.resolvedOutcome,
      stateUpdate.winningAssetId,
    );
    if (ref) {
      await setPolymarketResolved(ref, resolvedOutcome, stateUpdate.ts);
      await publishResolvedTerminalTopTicks({
        marketId: ref.marketId,
        noTokenId: ref.tokenNo,
        observedAtMs: Date.now(),
        resolvedOutcome,
        yesTokenId: ref.tokenYes,
      });
    } else if (stateUpdate.venueMarketId) {
      await setResolvedByVenueMarketId(
        stateUpdate.venueMarketId,
        resolvedOutcome,
        stateUpdate.ts,
      );
      const venueRef = await resolveTokenMarketRefByVenueMarketId(
        stateUpdate.venueMarketId,
      );
      if (venueRef) {
        await publishResolvedTerminalTopTicks({
          marketId: venueRef.marketId,
          noTokenId: venueRef.tokenNo,
          observedAtMs: Date.now(),
          resolvedOutcome,
          yesTokenId: venueRef.tokenYes,
        });
      }
    }
  }
}

function parsePriceChangeEntries(
  message: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(message.price_changes)) return [];
  return message.price_changes.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry),
  );
}

function handleBookMessage(
  message: Record<string, unknown>,
  rawMessage: unknown,
  tsMs: number,
): void {
  const tokenId = pickTokenId(message);
  if (!tokenId) return;

  const bids = parseLevels(message.bids ?? message.buys);
  const asks = parseLevels(message.asks ?? message.sells);
  const bb = bestBid(bids);
  const ba = bestAsk(asks);

  publishTopTick(tokenId, bb, ba, tsMs, rawMessage);
}

function handlePriceChangeMessage(
  message: Record<string, unknown>,
  tsMs: number,
): void {
  const entries = parsePriceChangeEntries(message);

  if (entries.length) {
    const dedupedByToken = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      const tokenId = pickTokenId(entry);
      if (!tokenId) continue;
      dedupedByToken.set(tokenId, entry);
    }
    for (const [tokenId, entry] of dedupedByToken) {
      const bb = parsePrice(entry.best_bid ?? entry.bestBid);
      const ba = parsePrice(entry.best_ask ?? entry.bestAsk);
      publishTopTick(tokenId, bb, ba, tsMs);
    }
    return;
  }

  const tokenId = pickTokenId(message);
  if (!tokenId) return;
  const directBb = parsePrice(message.best_bid ?? message.bestBid);
  const directBa = parsePrice(message.best_ask ?? message.bestAsk);
  if (directBb != null || directBa != null) {
    publishTopTick(tokenId, directBb, directBa, tsMs);
    return;
  }

  const bids = parseLevels(message.bids ?? message.buys);
  const asks = parseLevels(message.asks ?? message.sells);
  const bb = bestBid(bids);
  const ba = bestAsk(asks);
  publishTopTick(tokenId, bb, ba, tsMs);
}

function handleBestBidAskMessage(
  message: Record<string, unknown>,
  tsMs: number,
): void {
  const tokenId = pickTokenId(message);
  if (!tokenId) return;
  const bb = parsePrice(message.best_bid ?? message.bestBid);
  const ba = parsePrice(message.best_ask ?? message.bestAsk);
  publishTopTick(tokenId, bb, ba, tsMs);
}

async function handleLastTradePrice(
  message: Record<string, unknown>,
  tsMs: number,
): Promise<void> {
  const tokenId = pickTokenId(message);
  if (!tokenId) return;

  const price = parsePrice(
    message.price ??
      message.last_trade_price ??
      message.last_price ??
      message.value ??
      message.last_trade_price_dollars,
  );
  if (price == null || price < 0 || price > 1) return;

  const size =
    parseSize(
      message.size ?? message.amount ?? message.quantity ?? message.count,
    ) ?? 1;
  const side = normalizeSide(
    message.side ??
      message.taker_side ??
      message.takerSide ??
      message.direction,
  );

  await writeUnifiedLastTrade(pool, {
    tokenId,
    venue: "polymarket",
    price,
    size,
    side: side ?? "BUY",
    ts: new Date(tsMs),
    txHash:
      typeof message.transaction_hash === "string"
        ? message.transaction_hash
        : typeof message.transactionHash === "string"
          ? message.transactionHash
          : typeof message.tx_hash === "string"
            ? message.tx_hash
            : typeof message.txHash === "string"
              ? message.txHash
              : null,
  });
}

function buildStateUpdate(
  tokenId: string,
  message: Record<string, unknown>,
  input: {
    eventType: string;
    tsMs: number;
    status?: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" | null;
    acceptingOrders?: boolean | null;
    resolvedOutcome?: "YES" | "NO" | null;
    winningAssetId?: string | null;
    venueMarketId?: string | null;
  },
): ParsedMarketState {
  const conditionId = pickConditionId(message);
  const market = conditionId ?? input.venueMarketId ?? null;
  return {
    tokenId,
    eventType: input.eventType,
    market,
    conditionId,
    status: input.status ?? null,
    acceptingOrders: input.acceptingOrders ?? null,
    resolvedOutcome: input.resolvedOutcome ?? null,
    winningAssetId: input.winningAssetId ?? null,
    venueMarketId: input.venueMarketId ?? pickVenueMarketId(message),
    ts: input.tsMs,
  };
}

async function handleTickSizeChange(
  message: Record<string, unknown>,
  tsMs: number,
): Promise<void> {
  const tokenIds = Array.from(
    new Set([
      ...parseTokenIds(message.assets_ids),
      ...parseTokenIds(message.asset_ids),
      ...parseTokenIds(message.asset_id),
      ...parseTokenIds(message.token_id),
    ]),
  );

  await Promise.all(
    tokenIds.map((tokenId) =>
      publishMarketState(
        buildStateUpdate(tokenId, message, {
          eventType: "tick_size_change",
          tsMs,
        }),
      ),
    ),
  );
}

function enqueueEventRefresh(eventId: string): void {
  if (pendingEventRefresh.has(eventId)) return;
  pendingEventRefresh.add(eventId);

  void refreshQueue
    .add(async () => {
      try {
        const rawEvents = await fetchEventsByIds([eventId]);
        if (!rawEvents.length) return;

        const parsedEvents: TPolymarketEvent[] = [];
        for (const candidate of rawEvents) {
          try {
            parsedEvents.push(PolymarketEvent.parse(candidate));
          } catch (error) {
            log.warn("Failed to parse refreshed event payload", {
              eventId,
              error: String(error),
            });
          }
        }
        if (!parsedEvents.length) return;

        const polymarketEventRows = parsedEvents.map(mapPolymarketEventRow);
        const unifiedEventRows = parsedEvents.map(mapToUnifiedEvent);
        const polymarketMarketRows = parsedEvents.flatMap((event) =>
          event.markets.map((market) =>
            mapPolymarketMarketRow(event.id, market),
          ),
        );
        const unifiedMarketRows = parsedEvents.flatMap((event) =>
          event.markets.map((market) =>
            mapToUnifiedMarket(market, event.id, event),
          ),
        );

        await upsertEventsConsistently(pool, {
          unified: unifiedEventRows,
          polymarket: polymarketEventRows,
        });
        await upsertMarketsConsistently(
          pool,
          {
            unified: unifiedMarketRows,
            polymarket: polymarketMarketRows,
          },
          {
            unifiedBatchSize: env.marketUpsertBatchSize,
          },
        );
      } catch (error) {
        log.warn("Event refresh from WS hint failed", { eventId, error });
      } finally {
        pendingEventRefresh.delete(eventId);
      }
    })
    .catch((error) => {
      pendingEventRefresh.delete(eventId);
      log.warn("Event refresh queue task failed", { eventId, error });
    });
}

function enqueueMarketRefresh(marketId: string): void {
  if (pendingMarketRefresh.has(marketId)) return;
  pendingMarketRefresh.add(marketId);

  void refreshQueue
    .add(async () => {
      try {
        const market = await fetchMarketById(marketId);
        if (!market) return;
        const eventId = pickEventId(market);
        if (eventId) enqueueEventRefresh(eventId);
      } catch (error) {
        log.warn("Market refresh from WS hint failed", { marketId, error });
      } finally {
        pendingMarketRefresh.delete(marketId);
      }
    })
    .catch((error) => {
      pendingMarketRefresh.delete(marketId);
      log.warn("Market refresh queue task failed", { marketId, error });
    });
}

async function handleMarketResolved(
  message: Record<string, unknown>,
  tsMs: number,
): Promise<void> {
  const venueMarketId = pickVenueMarketId(message);
  const resolvedOutcome = normalizeOutcome(
    message.winning_outcome ?? message.resolved_outcome ?? message.outcome,
  );
  const winningAssetId =
    parseString(message.winning_asset_id) ??
    parseString(message.winningAssetId);

  let tokenIds = Array.from(
    new Set([
      ...parseTokenIds(message.assets_ids),
      ...parseTokenIds(message.asset_ids),
      ...parseTokenIds(message.asset_id),
      ...parseTokenIds(message.token_id),
    ]),
  );

  if (venueMarketId && tokenIds.length < 2) {
    const dbTokenIds = await resolveTokensByVenueMarketId(venueMarketId);
    tokenIds = Array.from(new Set([...tokenIds, ...dbTokenIds]));
  }

  if (!tokenIds.length && venueMarketId) {
    await setResolvedByVenueMarketId(venueMarketId, resolvedOutcome, tsMs);
  }

  await Promise.all(
    tokenIds.map((tokenId) =>
      publishMarketState(
        buildStateUpdate(tokenId, message, {
          eventType: "market_resolved",
          tsMs,
          status: "SETTLED",
          acceptingOrders: false,
          resolvedOutcome,
          winningAssetId,
          venueMarketId,
        }),
      ),
    ),
  );

  const eventId = pickEventId(message);
  if (eventId) enqueueEventRefresh(eventId);
  if (venueMarketId) enqueueMarketRefresh(venueMarketId);
}

async function handleNewMarket(
  message: Record<string, unknown>,
  tsMs: number,
): Promise<void> {
  const venueMarketId = pickVenueMarketId(message);
  let tokenIds = Array.from(
    new Set([
      ...parseTokenIds(message.assets_ids),
      ...parseTokenIds(message.asset_ids),
      ...parseTokenIds(message.asset_id),
      ...parseTokenIds(message.token_id),
    ]),
  );

  if (venueMarketId && tokenIds.length < 2) {
    const dbTokenIds = await resolveTokensByVenueMarketId(venueMarketId);
    tokenIds = Array.from(new Set([...tokenIds, ...dbTokenIds]));
  }

  await Promise.all(
    tokenIds.map((tokenId) =>
      publishMarketState(
        buildStateUpdate(tokenId, message, {
          eventType: "new_market",
          tsMs,
          status: "ACTIVE",
          venueMarketId,
        }),
      ),
    ),
  );

  const eventId = pickEventId(message);
  if (eventId) enqueueEventRefresh(eventId);
  if (venueMarketId) enqueueMarketRefresh(venueMarketId);
}

// The hot quote path only normalizes/gates/enqueues. It must not create an
// async task (and several microtasks) for every discarded price delta.
function handleQuoteMessage(message: Record<string, unknown>): boolean {
  const eventType = String(
    message.event_type ?? message.type ?? "",
  ).toLowerCase();
  if (!["book", "price_change", "best_bid_ask"].includes(eventType))
    return false;
  const tsMs = parseTimestampMs(message.timestamp);
  if (eventType === "book") handleBookMessage(message, message, tsMs);
  else if (eventType === "price_change")
    handlePriceChangeMessage(message, tsMs);
  else handleBestBidAskMessage(message, tsMs);
  return true;
}

async function handleWsMessage(rawMessage: unknown): Promise<void> {
  if (!isRecord(rawMessage)) return;
  const message = rawMessage as Record<string, unknown>;
  const evtRaw = message.event_type ?? message.type;
  if (typeof evtRaw !== "string" || evtRaw.length === 0) return;
  const eventType = evtRaw.toLowerCase();
  const tsMs = parseTimestampMs(message.timestamp);

  if (eventType === "last_trade_price") {
    await handleLastTradePrice(message, tsMs);
    return;
  }
  if (eventType === "tick_size_change") {
    await handleTickSizeChange(message, tsMs);
    return;
  }
  if (eventType === "market_resolved") {
    await handleMarketResolved(message, tsMs);
    return;
  }
  if (eventType === "new_market") {
    await handleNewMarket(message, tsMs);
    return;
  }

  const tokenId = pickTokenId(message);
  if (!tokenId) return;

  const status = normalizeStatus(message.status);
  const acceptingOrders = parseBoolean(message.accepting_orders);
  if (status == null && acceptingOrders == null) return;

  await publishMarketState(
    buildStateUpdate(tokenId, message, {
      eventType,
      tsMs,
      status,
      acceptingOrders,
    }),
  );
}

function connectMarketShard(shard: SocketShard, attempt = 0) {
  if (stopping || socketShards.get(shard.id) !== shard || !shard.desired.length)
    return;
  const ws = new WebSocket(env.wsUrl, { perMessageDeflate: true });
  shard.ws = ws;
  shard.reconnectTimer = null;
  const isCurrent = () =>
    !stopping && socketShards.get(shard.id) === shard && shard.ws === ws;
  const pump = new MarketSubscriptions({
    chunkSize: env.wsSubChunkSize,
    customFeature: env.wsCustomFeatureEnabled,
    isOpen: () => isCurrent() && ws.readyState === WebSocket.OPEN,
    send: (payload) =>
      new Promise<void>((resolve, reject) =>
        ws.send(payload, (error) => (error ? reject(error) : resolve())),
      ),
    onError: (error) => {
      log.warn("WS subscription failed", {
        shard: shard.id,
        error: String(error),
      });
      ws.terminate();
    },
  });
  shard.subscriptions = pump;

  let pingInterval: NodeJS.Timeout | null = null;
  let lastMarketMessageAt = Date.now();
  let openedAt = 0;
  let receivedFrames = 0;
  let receivedBytes = 0;
  let receivedMarketFrames = 0;
  let parseErrors = 0;
  const flowMetrics = () => ({
    shard: shard.id,
    sockets: socketShards.size,
    ...subscriptionCoverage(),
    receivedFrames,
    receivedBytes,
    receivedMarketFrames,
    parseErrors,
    subscribed: pump.subscribed.size,
    desired: shard.desired.length,
    marketIdleMs: Date.now() - lastMarketMessageAt,
    quotes: quoteQueue.metrics(),
    eventsPending: mq.size,
    eventsRunning: mq.pending,
    eventLoopP99Ms: eventLoop.percentile(99) / 1e6,
    eventLoopMaxMs: eventLoop.max / 1e6,
  });

  ws.on("open", async () => {
    openedAt = Date.now();
    log.info("WS open", {
      shard: shard.id,
      tokens: shard.desired.length,
    });
    bindRedisErrorOnce();
    try {
      await ensureRedis();
    } catch (error) {
      log.err("WS Redis initialization failed", error);
      ws.terminate();
      return;
    }
    if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
    pump.update(shard.desired);
    lastMarketMessageAt = Date.now();

    pingInterval = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send("PING");
        }
      } catch {
        // ignore
      }
    }, 10_000);

    shard.reportFlow = () => {
      if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
      try {
        log.info("WS flow", flowMetrics());
        receivedFrames = 0;
        receivedBytes = 0;
        receivedMarketFrames = 0;
        parseErrors = 0;
        const staleForMs = Date.now() - lastMarketMessageAt;
        if (staleForMs < env.wsResubscribeSec * 1000) return;
        log.info("WS periodic full resubscribe", {
          shard: shard.id,
          staleMs: staleForMs,
        });
        pump.reset();
      } catch {
        // ignore
      }
    };
  });

  // The EventTarget API returns text directly. Bun's ws.on('message') shim
  // encodes each text frame to a Buffer; String(raw) would decode it again.
  // At thousands of price changes/sec that is pure allocation/GC overhead.
  ws.addEventListener("message", ({ data: raw }) => {
    if (!isCurrent()) return;
    const text = String(raw);
    receivedFrames++;
    receivedBytes += Buffer.byteLength(text);
    if (text === "PONG" || text === "PING") return;

    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      parseErrors++;
      return;
    }
    if (!isRecord(msg) && !Array.isArray(msg)) return;
    lastMarketMessageAt = Date.now();
    receivedMarketFrames++;

    // Quotes are normalized/coalesced before asynchronous DB/Redis work.
    // Trades remain lossless tasks. Only exact market-wide lifecycle copies
    // broadcast to multiple sockets share work; quotes share the existing gate.
    const orderedEvents: unknown[] = [];
    for (const entry of Array.isArray(msg) ? msg : [msg]) {
      try {
        if (isRecord(entry) && handleQuoteMessage(entry)) continue;
      } catch (error) {
        log.warn("WS quote handler error", error);
        continue;
      }
      orderedEvents.push(entry);
    }
    if (orderedEvents.length)
      void mq
        .add(async () => {
          for (const entry of orderedEvents) {
            try {
              const type = isRecord(entry)
                ? String(entry.event_type ?? entry.type ?? "").toLowerCase()
                : "";
              if (
                ["new_market", "market_resolved", "tick_size_change"].includes(
                  type,
                )
              ) {
                const key = createHash("sha256")
                  .update(JSON.stringify(entry))
                  .digest("hex");
                await marketEvents.run(key, () => handleWsMessage(entry));
              } else await handleWsMessage(entry);
            } catch (error) {
              // A failed lifecycle operation must not discard later trades in
              // the same provider frame. The failed event is not cached.
              log.warn("WS message handler error", error);
            }
          }
        })
        .catch((error) => {
          log.warn("WS message task rejected", error);
        });
  });

  ws.on("close", (code, reason) => {
    if (pingInterval) clearInterval(pingInterval);
    if (shard.ws === ws) shard.reportFlow = undefined;
    log.warn("WS closed", {
      code,
      reason: reason.toString(),
      connectedMs: openedAt ? Date.now() - openedAt : 0,
      // Short failing connections never reach the periodic flow log.
      ...flowMetrics(),
    });
    if (!isCurrent()) return;

    const max = 30_000;
    const nextAttempt = reconnectAttempt(
      attempt,
      openedAt ? Date.now() - openedAt : 0,
    );
    const base = 1000 * 2 ** Math.min(nextAttempt, 5);
    const delay = Math.min(max, base) + Math.floor(Math.random() * 500);
    shard.reconnectTimer = setTimeout(
      () => connectMarketShard(shard, nextAttempt),
      delay,
    );
  });

  ws.on("error", (error) => log.err("WS error", error));
  return ws;
}

export function startMarketWS(initialTokenIds: string[]) {
  if (!shutdownBound) {
    shutdownBound = true;
    eventLoop.enable();
    flowInterval = setInterval(() => {
      for (const shard of socketShards.values()) shard.reportFlow?.();
      eventLoop.reset();
    }, env.wsResubscribeSec * 1000);
    const shutdown = () => {
      stopping = true;
      if (flowInterval) clearInterval(flowInterval);
      eventLoop.disable();
      for (const shard of socketShards.values()) {
        if (shard.reconnectTimer) clearTimeout(shard.reconnectTimer);
        shard.ws?.terminate();
      }
      topTickGate.clear();
      void mq
        .onIdle()
        .then(() => quoteQueue.idle())
        .finally(() => redis.quit().catch(() => redis.disconnect()));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  updateMarketWSSubscriptions(initialTokenIds);
  return socketShards.values().next().value?.ws;
}

export function updateMarketWSSubscriptions(nextTokenIds: string[]): void {
  if (stopping) return;
  // Cap once globally, never once per connection. Reordering ranks does not
  // churn established subscriptions or move a token to another socket.
  const groups = subscriptionShards.update(
    [...new Set(nextTokenIds)].slice(0, env.wsSubset),
  );
  for (const [id, shard] of socketShards) {
    if (groups.has(id)) continue;
    socketShards.delete(id);
    if (shard.reconnectTimer) clearTimeout(shard.reconnectTimer);
    shard.ws?.terminate();
  }
  for (const [id, desired] of groups) {
    let shard = socketShards.get(id);
    if (!shard) {
      shard = {
        id,
        desired,
        ws: null,
        subscriptions: null,
        reconnectTimer: null,
      };
      socketShards.set(id, shard);
      connectMarketShard(shard);
    } else {
      shard.desired = desired;
      if (shard.ws?.readyState === WebSocket.OPEN)
        shard.subscriptions?.update(desired);
    }
  }
}
