import PQueue from "p-queue";
import { io, type Socket } from "socket.io-client";
import { writeUnifiedBookTop } from "@hunch/db";

import { env } from "./env.js";
import { log } from "./log.js";
import { pool } from "./db.js";
import { ensureRedis, redis } from "./redis.js";

type OrderbookEntry = {
  price?: string | number | null;
  size?: string | number | null;
};

type OrderbookUpdate = {
  marketSlug?: string;
  orderbook?: {
    bids?: OrderbookEntry[];
    asks?: OrderbookEntry[];
    tokenId?: string;
  };
  timestamp?: number | string;
};

type NewPriceEntry = {
  marketId?: number;
  marketAddress?: string;
  yesPrice?: number | string | null;
  noPrice?: number | string | null;
};

type NewPriceData = {
  marketAddress?: string;
  updatedPrices?: NewPriceEntry[];
  timestamp?: number | string;
};

type TokenPair = {
  yesTokenId: string;
  noTokenId: string;
};

type SubState = {
  subscribed: Set<string>;
};

const state: SubState = { subscribed: new Set() };
const mq = new PQueue({ concurrency: Number(env.wsConcurrency || 8) });
let redisBound = false;
let shutdownBound = false;
let currentSocket: Socket | null = null;
let desiredSlugs: string[] = [];

const addressTokens = new Map<string, TokenPair>();
const marketIdTokens = new Map<string, TokenPair>();
const missingAddresses = new Set<string>();
const missingMarketIds = new Set<string>();

function bindRedisErrorOnce() {
  if (redisBound) return;
  redisBound = true;
  redis.on("error", (e) => log.err("redis error", e));
}

function normalizeSlug(value: string): string {
  return value.trim();
}

function uniqueSlugs(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeSlug).filter((v) => v.length > 0)),
  );
}

function prefixLimitlessToken(tokenId?: string | null): string | undefined {
  if (!tokenId) return undefined;
  return tokenId.startsWith("limitless:") ? tokenId : `limitless:${tokenId}`;
}

function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bestBid(levels: OrderbookEntry[] | undefined): number | null {
  if (!levels || levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p > best) best = p;
  }
  return best;
}

function bestAsk(levels: OrderbookEntry[] | undefined): number | null {
  if (!levels || levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p < best) best = p;
  }
  return best;
}

function buildBookSide(best: number | null) {
  return best != null ? [{ price: String(best), size: "NA" }] : [];
}

async function publishTokenTop(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  ts: Date,
  snapshot?: unknown,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;

  const tsMs = ts.getTime();
  const tick = {
    token_id: tokenId,
    best_bid: bestBid,
    best_ask: bestAsk,
    ts: tsMs,
  };
  const tickJson = JSON.stringify(tick);
  const snap =
    snapshot ??
    ({
      token_id: tokenId,
      bids: buildBookSide(bestBid),
      asks: buildBookSide(bestAsk),
      timestamp: tsMs.toString(),
    } as const);

  const multi = redis.multi();
  multi.set(`book:${tokenId}`, JSON.stringify(snap), { EX: 5 });
  multi.set(`top:${tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${tokenId}`, tickJson);

  await Promise.all([
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, ts),
    multi.exec(),
  ]);
}

async function fetchTokensForAddresses(
  addresses: string[],
): Promise<Map<string, TokenPair>> {
  if (!addresses.length) return new Map();
  const { rows } = await pool.query<{
    address: string;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select lower(m.metadata->>'address') as address,
             m.token_yes,
             m.token_no
      from unified_markets m
      where m.venue = 'limitless'
        and m.metadata ? 'address'
        and lower(m.metadata->>'address') = any($1::text[])
    `,
    [addresses],
  );

  const map = new Map<string, TokenPair>();
  for (const row of rows) {
    if (!row.address || !row.token_yes || !row.token_no) continue;
    const yes = prefixLimitlessToken(row.token_yes);
    const no = prefixLimitlessToken(row.token_no);
    if (!yes || !no) continue;
    map.set(row.address, { yesTokenId: yes, noTokenId: no });
  }
  return map;
}

async function fetchTokensForMarketIds(
  marketIds: string[],
): Promise<Map<string, TokenPair>> {
  if (!marketIds.length) return new Map();
  const { rows } = await pool.query<{
    venue_market_id: string;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select m.venue_market_id,
             m.token_yes,
             m.token_no
      from unified_markets m
      where m.venue = 'limitless'
        and m.venue_market_id = any($1::text[])
    `,
    [marketIds],
  );

  const map = new Map<string, TokenPair>();
  for (const row of rows) {
    if (!row.venue_market_id || !row.token_yes || !row.token_no) continue;
    const yes = prefixLimitlessToken(row.token_yes);
    const no = prefixLimitlessToken(row.token_no);
    if (!yes || !no) continue;
    map.set(row.venue_market_id, { yesTokenId: yes, noTokenId: no });
  }
  return map;
}

async function ensureTokensForAddress(
  address: string,
): Promise<TokenPair | null> {
  const key = address.toLowerCase();
  const existing = addressTokens.get(key);
  if (existing) return existing;
  if (missingAddresses.has(key)) return null;
  missingAddresses.add(key);
  const map = await fetchTokensForAddresses([key]);
  const tokens = map.get(key) ?? null;
  if (tokens) {
    addressTokens.set(key, tokens);
    missingAddresses.delete(key);
  } else {
    log.warn("WS AMM token mapping missing", { address: key });
  }
  return tokens;
}

async function ensureTokensForMarketId(
  marketId: string,
): Promise<TokenPair | null> {
  const key = marketId;
  const existing = marketIdTokens.get(key);
  if (existing) return existing;
  if (missingMarketIds.has(key)) return null;
  missingMarketIds.add(key);
  const map = await fetchTokensForMarketIds([key]);
  const tokens = map.get(key) ?? null;
  if (tokens) {
    marketIdTokens.set(key, tokens);
    missingMarketIds.delete(key);
  } else {
    log.warn("WS AMM token mapping missing", { marketId: key });
  }
  return tokens;
}

function diffSets(current: Set<string>, desired: Iterable<string>) {
  const next = new Set(desired);
  const toSub: string[] = [];
  const toUnsub: string[] = [];
  next.forEach((id) => {
    if (!current.has(id)) toSub.push(id);
  });
  current.forEach((id) => {
    if (!next.has(id)) toUnsub.push(id);
  });
  return { toSub, toUnsub, next };
}

function sendSubscribe(socket: Socket, slugs: string[]) {
  if (!slugs.length) return;
  socket.emit("subscribe_market_prices", { marketSlugs: slugs });
}

function sendUnsubscribe(socket: Socket, slugs: string[]) {
  if (!slugs.length) return;
  socket.emit("unsubscribe", { channel: "subscribe_market_prices", marketSlugs: slugs });
}

function syncSubscriptions(socket: Socket, slugs: string[]) {
  const ids = uniqueSlugs(slugs).slice(0, env.wsSubset);
  const { toSub, toUnsub, next } = diffSets(state.subscribed, ids);

  sendUnsubscribe(socket, toUnsub);
  sendSubscribe(socket, toSub);

  state.subscribed = next;
  log.info("WS sync", {
    add: toSub.length,
    remove: toUnsub.length,
    total: next.size,
  });
}

export function startMarketWS(
  initialSlugs: string[],
  attempt = 0,
): Socket {
  desiredSlugs = uniqueSlugs(initialSlugs).slice(0, env.wsSubset);
  state.subscribed = new Set();

  const wsUrl = env.limitlessWsUrl.endsWith("/markets")
    ? env.limitlessWsUrl
    : `${env.limitlessWsUrl}/markets`;

  const headers = env.limitlessWsSession
    ? { cookie: `limitless_session=${env.limitlessWsSession}` }
    : undefined;

  const socket = io(wsUrl, {
    transports: ["websocket"],
    extraHeaders: headers,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: Infinity,
    timeout: 10000,
  });

  currentSocket = socket;

  if (!shutdownBound) {
    shutdownBound = true;
    const shutdown = () => {
      try {
        socket.disconnect();
      } catch {
        // ignore
      }
      redis.quit().catch(() => redis.disconnect());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  socket.on("connect", async () => {
    log.info("Limitless WS connected", { url: wsUrl });
    bindRedisErrorOnce();
    await ensureRedis();
    syncSubscriptions(socket, desiredSlugs);
  });

  socket.on("orderbookUpdate", (payload: OrderbookUpdate) => {
    void mq
      .add(async () => {
        const orderbook = payload?.orderbook;
        const rawTokenId = orderbook?.tokenId;
        const tokenId = prefixLimitlessToken(rawTokenId);
        if (!tokenId) return;

        const bids = orderbook?.bids ?? [];
        const asks = orderbook?.asks ?? [];
        const bb = bestBid(bids);
        const ba = bestAsk(asks);

        if (bb == null && ba == null) return;
        const tsRaw = payload.timestamp;
        const tsNum =
          typeof tsRaw === "number"
            ? tsRaw
            : typeof tsRaw === "string"
              ? Number(tsRaw)
              : Date.now();
        const ts = new Date(Number.isFinite(tsNum) ? tsNum : Date.now());

        await publishTokenTop(tokenId, bb, ba, ts, {
          token_id: tokenId,
          bids,
          asks,
          timestamp: ts.getTime().toString(),
        });
      })
      .catch((err) => log.warn("WS orderbook handler error", err));
  });

  socket.on("newPriceData", (payload: NewPriceData) => {
    void mq
      .add(async () => {
        const entries = payload?.updatedPrices ?? [];
        if (!entries.length) return;
        const tsRaw = payload.timestamp;
        const tsNum =
          typeof tsRaw === "number"
            ? tsRaw
            : typeof tsRaw === "string"
              ? Number(tsRaw)
              : Date.now();
        const ts = new Date(Number.isFinite(tsNum) ? tsNum : Date.now());

        for (const entry of entries) {
          const marketId =
            entry.marketId != null ? String(entry.marketId) : null;
          const address =
            (entry.marketAddress ?? payload.marketAddress)?.toLowerCase() ??
            null;

          let tokens: TokenPair | null = null;
          if (address) tokens = await ensureTokensForAddress(address);
          if (!tokens && marketId) {
            tokens = await ensureTokensForMarketId(marketId);
          }
          if (!tokens) {
            continue;
          }

          const yesPrice = parsePrice(entry.yesPrice);
          const noPrice = parsePrice(entry.noPrice);

          if (yesPrice != null) {
            await publishTokenTop(tokens.yesTokenId, yesPrice, yesPrice, ts);
          }
          if (noPrice != null) {
            await publishTokenTop(tokens.noTokenId, noPrice, noPrice, ts);
          }
        }
      })
      .catch((err) => log.warn("WS price handler error", err));
  });

  socket.on("disconnect", (reason) => {
    log.warn("Limitless WS disconnected", { reason });
  });

  socket.on("connect_error", (err) => {
    log.warn("Limitless WS connect error", err);
  });

  socket.io.on("reconnect_attempt", (attemptNo) => {
    log.info("Limitless WS reconnecting", { attempt: attemptNo });
  });

  socket.io.on("reconnect", () => {
    syncSubscriptions(socket, desiredSlugs);
  });

  socket.io.on("reconnect_error", (err) => {
    log.warn("Limitless WS reconnect error", err);
  });

  socket.io.on("reconnect_failed", () => {
    log.warn("Limitless WS reconnect failed");
    const max = 30_000;
    const base = 1000 * 2 ** Math.min(attempt, 5);
    const delay = Math.min(max, base) + Math.floor(Math.random() * 500);
    setTimeout(() => startMarketWS(desiredSlugs, attempt + 1), delay);
  });

  return socket;
}

export function updateMarketWSSubscriptions(nextSlugs: string[]): void {
  desiredSlugs = uniqueSlugs(nextSlugs).slice(0, env.wsSubset);
  const socket = currentSocket;
  if (!socket || !socket.connected) return;
  syncSubscriptions(socket, desiredSlugs);
}
