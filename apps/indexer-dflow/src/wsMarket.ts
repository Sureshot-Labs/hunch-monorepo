import WebSocket from "ws";
import PQueue from "p-queue";
import { writeUnifiedBookTop } from "@hunch/db";

import { env } from "./env.js";
import { log } from "./log.js";
import { pool } from "./db.js";
import { ensureRedis, redis } from "./redis.js";

type PriceMessage = {
  channel?: string;
  type?: string;
  market_ticker?: string;
  yes_bid?: string | number | null;
  yes_ask?: string | number | null;
  no_bid?: string | number | null;
  no_ask?: string | number | null;
};

type TickerTokens = {
  yesTokenId: string;
  noTokenId: string;
};

type SubState = {
  subscribed: Set<string>;
  all: boolean;
};

const state: SubState = { subscribed: new Set(), all: false };
const mq = new PQueue({ concurrency: Number(env.wsConcurrency || 8) });
let redisBound = false;
let shutdownBound = false;
let currentWs: WebSocket | null = null;
let desiredTickers: string[] = [];
let tickerTokens = new Map<string, TickerTokens>();
const missingTickers = new Set<string>();
let msgCount = 0;
let msgCountStart = Date.now();
let msgLogTimer: NodeJS.Timeout | null = null;

function bindRedisErrorOnce() {
  if (redisBound) return;
  redisBound = true;
  redis.on("error", (e) => log.err("redis error", e));
}

function clearMsgLogger() {
  if (msgLogTimer) {
    clearInterval(msgLogTimer);
    msgLogTimer = null;
  }
}

function startMsgLogger() {
  clearMsgLogger();
  if (!env.dflowWsLogEverySec || env.dflowWsLogEverySec <= 0) return;
  msgCount = 0;
  msgCountStart = Date.now();
  msgLogTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = Math.max(1, (now - msgCountStart) / 1000);
    const rps = (msgCount / elapsed).toFixed(2);
    log.info("WS msgs", {
      count: msgCount,
      seconds: Math.floor(elapsed),
      rate: rps,
    });
    msgCount = 0;
    msgCountStart = now;
  }, env.dflowWsLogEverySec * 1000);
}

function normalizeTicker(value: string): string {
  return value.trim();
}

function uniqueTickers(values: string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeTicker).filter((v) => v.length > 0)),
  );
}

function parsePrice(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildBookSide(best: number | null) {
  return best != null ? [{ price: String(best), size: "NA" }] : [];
}

async function publishTokenTop(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  ts: Date,
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

  const snap = {
    token_id: tokenId,
    bids: buildBookSide(bestBid),
    asks: buildBookSide(bestAsk),
    timestamp: tsMs.toString(),
  };

  const multi = redis.multi();
  multi.set(`book:${tokenId}`, JSON.stringify(snap), { EX: 5 });
  multi.set(`top:${tokenId}`, tickJson, { EX: 60 });
  multi.publish(`prices:${tokenId}`, tickJson);

  await Promise.all([
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, ts),
    multi.exec(),
  ]);
}

async function fetchTokensForTickers(
  tickers: string[],
): Promise<Map<string, TickerTokens>> {
  if (!tickers.length) return new Map();
  const { rows } = await pool.query<{
    venue_market_id: string;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select m.venue_market_id, m.token_yes, m.token_no
      from unified_markets m
      where m.venue = 'kalshi'
        and m.venue_market_id = any($1::text[])
    `,
    [tickers],
  );

  const map = new Map<string, TickerTokens>();
  for (const row of rows) {
    if (!row.venue_market_id || !row.token_yes || !row.token_no) continue;
    if (!row.token_yes.startsWith("sol:")) continue;
    if (!row.token_no.startsWith("sol:")) continue;
    map.set(row.venue_market_id, {
      yesTokenId: row.token_yes,
      noTokenId: row.token_no,
    });
  }
  return map;
}

async function refreshTickerTokens(tickers: string[]): Promise<void> {
  const unique = uniqueTickers(tickers);
  const map = await fetchTokensForTickers(unique);
  tickerTokens = map;
  missingTickers.clear();
}

async function ensureTickerTokens(ticker: string): Promise<TickerTokens | null> {
  const existing = tickerTokens.get(ticker);
  if (existing) return existing;
  if (missingTickers.has(ticker)) return null;

  missingTickers.add(ticker);
  log.warn("WS ticker missing mapping", { ticker });
  const map = await fetchTokensForTickers([ticker]);
  const tokens = map.get(ticker) ?? null;
  if (tokens) {
    tickerTokens.set(ticker, tokens);
    missingTickers.delete(ticker);
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

function sendSubscribe(ws: WebSocket, tickers: string[]) {
  if (!tickers.length) return;
  ws.send(
    JSON.stringify({
      type: "subscribe",
      channel: "prices",
      tickers,
    }),
  );
}

function sendUnsubscribe(ws: WebSocket, tickers: string[]) {
  if (!tickers.length) return;
  ws.send(
    JSON.stringify({
      type: "unsubscribe",
      channel: "prices",
      tickers,
    }),
  );
}

function sendSubscribeAll(ws: WebSocket) {
  ws.send(JSON.stringify({ type: "subscribe", channel: "prices", all: true }));
}

function sendUnsubscribeAll(ws: WebSocket) {
  ws.send(JSON.stringify({ type: "unsubscribe", channel: "prices", all: true }));
}

async function syncSubscriptions(ws: WebSocket, tickers: string[]) {
  if (env.dflowWsAll) {
    if (!state.all) {
      sendSubscribeAll(ws);
      state.all = true;
      state.subscribed = new Set();
      log.info("WS sync", { mode: "all" });
    }
    return;
  }

  const unique = uniqueTickers(tickers).slice(0, env.wsSubset);
  await refreshTickerTokens(unique);

  if (state.all) {
    sendUnsubscribeAll(ws);
    state.all = false;
  }

  const { toSub, toUnsub, next } = diffSets(state.subscribed, unique);
  sendUnsubscribe(ws, toUnsub);
  sendSubscribe(ws, toSub);
  state.subscribed = next;

  log.info("WS sync", {
    add: toSub.length,
    remove: toUnsub.length,
    total: next.size,
  });
}

export function startMarketWS(initialTickers: string[], attempt = 0) {
  desiredTickers = uniqueTickers(initialTickers).slice(0, env.wsSubset);
  state.subscribed = new Set();
  state.all = false;

  if (!env.dflowWsAll && desiredTickers.length === 0) {
    log.info("WS disabled (no tickers)");
    return null;
  }

  const ws = new WebSocket(env.dflowWsUrl, {
    perMessageDeflate: true,
    headers: env.dflowApiKey
      ? {
          "x-api-key": env.dflowApiKey,
        }
      : undefined,
  });
  currentWs = ws;
  let pingInterval: NodeJS.Timeout | null = null;

  if (!shutdownBound) {
    shutdownBound = true;
    const shutdown = () => {
      try {
        if (pingInterval) clearInterval(pingInterval);
      } catch {
        // ignore
      }
      try {
        ws.close();
      } catch {
        // ignore
      }
      redis.quit().catch(() => redis.disconnect());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  ws.on("open", async () => {
    log.info("WS open", env.dflowWsUrl);
    bindRedisErrorOnce();
    await ensureRedis();
    void syncSubscriptions(ws, desiredTickers);
    startMsgLogger();

    pingInterval = setInterval(() => {
      try {
        ws.ping();
      } catch {
        // ignore; socket may already be closed
      }
    }, 20_000);
  });

  ws.on("message", (raw) => {
    let msg: PriceMessage;
    try {
      msg = JSON.parse(String(raw)) as PriceMessage;
    } catch {
      return;
    }

    if (msg.channel !== "prices") return;
    const ticker = msg.market_ticker;
    if (!ticker) return;
    msgCount += 1;

    void mq
      .add(async () => {
        try {
          const tokens = await ensureTickerTokens(ticker);
          if (!tokens) return;
          const ts = new Date();

          const yesBid = parsePrice(msg.yes_bid);
          const yesAsk = parsePrice(msg.yes_ask);
          const noBid = parsePrice(msg.no_bid);
          const noAsk = parsePrice(msg.no_ask);

          await Promise.all([
            publishTokenTop(tokens.yesTokenId, yesBid, yesAsk, ts),
            publishTokenTop(tokens.noTokenId, noBid, noAsk, ts),
          ]);
        } catch (err) {
          log.warn("WS message handler error", err);
        }
      })
      .catch((err) => {
        log.warn("WS message task rejected", err);
      });
  });

  ws.on("close", (code, reason) => {
    if (pingInterval) clearInterval(pingInterval);
    clearMsgLogger();
    log.warn("WS closed", code, reason.toString());
    const max = 30_000;
    const base = 1000 * 2 ** Math.min(attempt, 5);
    const delay = Math.min(max, base) + Math.floor(Math.random() * 500);
    setTimeout(() => startMarketWS(desiredTickers, attempt + 1), delay);
  });

  ws.on("error", (err) => log.err("WS error", err));
  return ws;
}

export function updateMarketWSSubscriptions(nextTickers: string[]): void {
  desiredTickers = uniqueTickers(nextTickers).slice(0, env.wsSubset);
  const ws = currentWs;
  if (!ws) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  void syncSubscriptions(ws, desiredTickers);
}
