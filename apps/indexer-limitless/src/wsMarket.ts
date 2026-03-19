import PQueue from "p-queue";
import { io, type Socket } from "socket.io-client";
import { writeUnifiedBookTop } from "@hunch/db";
import { createTopTickGate } from "@hunch/infra";

import { env } from "./env.js";
import { log } from "./log.js";
import { pool } from "./db.js";
import { ensureRedis, redis } from "./redis.js";
import { normalizeLimitlessPricePair } from "./price-normalization.js";

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
  yes?: number | string | null;
  no?: number | string | null;
};

type NewPriceData = {
  marketAddress?: string;
  updatedPrices?: NewPriceEntry | NewPriceEntry[];
  timestamp?: number | string;
};

type TokenPair = {
  yesTokenId: string;
  noTokenId: string;
};

export type WsTargets = {
  slugs: string[];
  addresses: string[];
};

type WsSocketKind = "clob" | "amm";

type SocketState = {
  clob: string[];
  amm: string[];
};

type SocketMap = {
  clob: Socket | null;
  amm: Socket | null;
};

const EMPTY_WS_TARGETS: WsTargets = { slugs: [], addresses: [] };
const EMPTY_SOCKET_STATE: SocketState = { clob: [], amm: [] };
const state: SocketState = { ...EMPTY_SOCKET_STATE };
const mq = new PQueue({ concurrency: Number(env.wsConcurrency || 8) });
let redisBound = false;
let shutdownBound = false;
const currentSockets: SocketMap = { clob: null, amm: null };
let desiredTargets: WsTargets = EMPTY_WS_TARGETS;

const addressTokens = new Map<string, TokenPair>();
const marketIdTokens = new Map<string, TokenPair>();
const missingAddressRetryAt = new Map<string, number>();
const missingMarketIdRetryAt = new Map<string, number>();
const MISSING_TOKEN_RETRY_MS = 10_000;

const topTickGate = createTopTickGate({
  onDeferredPublish: ({ tokenId, bestBid, bestAsk, tsMs }) => {
    void publishTokenTopNow(tokenId, bestBid, bestAsk, tsMs).catch((error) => {
      log.warn("Deferred top tick publish failed", {
        tokenId,
        error: String(error),
      });
    });
  },
});

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

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueAddresses(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeAddress).filter((v) => v.length > 0)),
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
  if (!topTickGate.shouldPublish({ tokenId, bestBid, bestAsk, tsMs })) {
    return;
  }

  await publishTokenTopNow(tokenId, bestBid, bestAsk, tsMs, snapshot);
}

async function publishTokenTopNow(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  tsMs: number,
  snapshot?: unknown,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;
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
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, new Date(tsMs)),
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
  const nextRetryAt = missingAddressRetryAt.get(key) ?? 0;
  if (nextRetryAt > Date.now()) return null;
  missingAddressRetryAt.set(key, Date.now() + MISSING_TOKEN_RETRY_MS);
  const map = await fetchTokensForAddresses([key]);
  const tokens = map.get(key) ?? null;
  if (tokens) {
    addressTokens.set(key, tokens);
    missingAddressRetryAt.delete(key);
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
  const nextRetryAt = missingMarketIdRetryAt.get(key) ?? 0;
  if (nextRetryAt > Date.now()) return null;
  missingMarketIdRetryAt.set(key, Date.now() + MISSING_TOKEN_RETRY_MS);
  const map = await fetchTokensForMarketIds([key]);
  const tokens = map.get(key) ?? null;
  if (tokens) {
    marketIdTokens.set(key, tokens);
    missingMarketIdRetryAt.delete(key);
  } else {
    log.warn("WS AMM token mapping missing", { marketId: key });
  }
  return tokens;
}

function normalizeTargets(targets: WsTargets): WsTargets {
  const slugs = uniqueSlugs(targets.slugs).slice(0, env.wsSubset);
  const addresses = uniqueAddresses(targets.addresses).slice(0, env.wsSubset);
  return { slugs, addresses };
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function syncSubscriptions(
  kind: WsSocketKind,
  socket: Socket,
  targets: WsTargets,
  options?: { force?: boolean },
) {
  if (kind === "amm" && options?.force) {
    missingAddressRetryAt.clear();
    missingMarketIdRetryAt.clear();
  }
  const next = normalizeTargets(targets);
  const nextValues = kind === "clob" ? next.slugs : next.addresses;
  const currentValues = state[kind];
  if (!options?.force && arraysEqual(currentValues, nextValues)) return;
  socket.emit("subscribe_market_prices", {
    marketSlugs: kind === "clob" ? nextValues : [],
    marketAddresses: kind === "amm" ? nextValues : [],
  });
  state[kind] = nextValues;
  log.info(options?.force ? "WS resubscribe" : "WS sync", {
    kind,
    slugs: kind === "clob" ? nextValues.length : 0,
    addresses: kind === "amm" ? nextValues.length : 0,
    total: nextValues.length,
  });
}

function createSocket(kind: WsSocketKind): Socket {
  const label = kind === "clob" ? "CLOB" : "AMM";

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

  currentSockets[kind] = socket;

  if (!shutdownBound) {
    shutdownBound = true;
    const shutdown = () => {
      try {
        currentSockets.clob?.disconnect();
      } catch (error) {
        log.warn("Limitless WS shutdown disconnect failed", {
          kind: "clob",
          error: String(error),
        });
      }
      try {
        currentSockets.amm?.disconnect();
      } catch (error) {
        log.warn("Limitless WS shutdown disconnect failed", {
          kind: "amm",
          error: String(error),
        });
      }
      void redis.quit().catch(() => redis.disconnect());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  socket.on("connect", async () => {
    log.info("Limitless WS connected", { kind, label, url: wsUrl });
    bindRedisErrorOnce();
    await ensureRedis();
    syncSubscriptions(kind, socket, desiredTargets);
  });

  if (kind === "clob") {
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
        .catch((err) => log.warn("WS orderbook handler error", { kind, err }));
    });
  } else {
    socket.on("newPriceData", (payload: NewPriceData) => {
      void mq
        .add(async () => {
          const updatedPrices = payload?.updatedPrices;
          const entries = Array.isArray(updatedPrices)
            ? updatedPrices
            : updatedPrices
              ? [updatedPrices]
              : [];
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

            const [yesPrice, noPrice] = normalizeLimitlessPricePair(
              [
                entry.yesPrice ?? entry.yes,
                entry.noPrice ?? entry.no,
              ],
              "amm",
            );

            if (yesPrice != null) {
              await publishTokenTop(tokens.yesTokenId, yesPrice, yesPrice, ts);
            }
            if (noPrice != null) {
              await publishTokenTop(tokens.noTokenId, noPrice, noPrice, ts);
            }
          }
        })
        .catch((err) => log.warn("WS price handler error", { kind, err }));
    });
  }

  socket.on("disconnect", (reason) => {
    log.warn("Limitless WS disconnected", { kind, label, reason });
  });

  socket.on("connect_error", (err) => {
    log.warn("Limitless WS connect error", { kind, label, err });
  });

  socket.io.on("reconnect_attempt", (attemptNo) => {
    log.info("Limitless WS reconnecting", { kind, label, attempt: attemptNo });
  });

  socket.io.on("reconnect", () => {
    syncSubscriptions(kind, socket, desiredTargets);
  });

  socket.io.on("reconnect_error", (err) => {
    log.warn("Limitless WS reconnect error", { kind, label, err });
  });

  socket.io.on("reconnect_failed", () => {
    log.warn("Limitless WS reconnect failed", { kind, label });
  });

  return socket;
}

export function startMarketWS(initialTargets: WsTargets): void {
  desiredTargets = normalizeTargets(initialTargets);
  state.clob = [];
  state.amm = [];

  currentSockets.clob?.disconnect();
  currentSockets.amm?.disconnect();
  currentSockets.clob = createSocket("clob");
  currentSockets.amm = createSocket("amm");
}

export function updateMarketWSSubscriptions(nextTargets: WsTargets): void {
  desiredTargets = normalizeTargets(nextTargets);
  const clobSocket = currentSockets.clob;
  if (clobSocket?.connected) {
    syncSubscriptions("clob", clobSocket, desiredTargets);
  }
  const ammSocket = currentSockets.amm;
  if (ammSocket?.connected) {
    syncSubscriptions("amm", ammSocket, desiredTargets);
  }
}

export function resubscribeMarketWSSubscriptions(): void {
  const clobSocket = currentSockets.clob;
  if (clobSocket?.connected) {
    syncSubscriptions("clob", clobSocket, desiredTargets, { force: true });
  }
  const ammSocket = currentSockets.amm;
  if (ammSocket?.connected) {
    syncSubscriptions("amm", ammSocket, desiredTargets, { force: true });
  }
}
