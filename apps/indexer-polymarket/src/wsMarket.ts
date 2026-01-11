import WebSocket from "ws";
import { env } from "./env";
import { log } from "./log";
import { ensureRedis, redis } from "./redis";
import PQueue from "p-queue";
import { writeUnifiedBookTop, writeUnifiedLastTrade } from "@hunch/db";
import { pool } from "./db";

// Very light state holder
type SubState = { subscribed: Set<string> };
const state: SubState = { subscribed: new Set() };
const mq = new PQueue({ concurrency: Number(env.wsConcurrency || 8) });
let redisBound = false;
let shutdownBound = false;
let currentWs: WebSocket | null = null;
let desiredTokenIds: string[] = [];

function bindRedisErrorOnce() {
  if (redisBound) return;
  redisBound = true;
  redis.on("error", (e) => log.err("redis error", e));
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

function normalizeSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  if (lower.includes("buy")) return "BUY";
  if (lower.includes("sell")) return "SELL";
  return null;
}

function bestBid(levels: Array<{ price: string }> | undefined): number | null {
  if (!levels || levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p > best) best = p;
  }
  return best;
}

function bestAsk(levels: Array<{ price: string }> | undefined): number | null {
  if (!levels || levels.length === 0) return null;
  let best: number | null = null;
  for (const level of levels) {
    const p = parsePrice(level.price);
    if (p == null) continue;
    if (best == null || p < best) best = p;
  }
  return best;
}

// tolerant payload builders (send both keys; server will ignore one)
function sendSubscribe(ws: WebSocket, ids: string[]) {
  if (!ids.length) return;
  const payload = { type: "MARKET", assets_ids: ids, asset_ids: ids };
  ws.send(JSON.stringify(payload));
}

function sendUnsubscribe(ws: WebSocket, ids: string[]) {
  if (!ids.length) return;
  const payload = { type: "UNSUBSCRIBE", assets_ids: ids, asset_ids: ids };
  ws.send(JSON.stringify(payload));
}

// call this whenever desired token set changes
function syncSubscriptions(ws: WebSocket, desiredIds: string[]) {
  const ids = desiredIds.slice(0, env.wsSubset);
  const { toSub, toUnsub, next } = diffSets(state.subscribed, ids);

  // send diffs
  sendUnsubscribe(ws, toUnsub);
  sendSubscribe(ws, toSub);

  // update local state
  state.subscribed = next;

  log.info("WS sync", {
    add: toSub.length,
    remove: toUnsub.length,
    total: next.size,
  });
}

export function startMarketWS(initialTokenIds: string[], attempt = 0) {
  desiredTokenIds = initialTokenIds;
  // New WS connection must re-subscribe from scratch.
  // Keep a local memory set for diffing, but don't assume the server preserves it.
  state.subscribed = new Set();
  const ws = new WebSocket(env.wsUrl, { perMessageDeflate: true });
  currentWs = ws;

  // perMessageDeflate enables per-message compression (a WebSocket extension called permessage-deflate).
  // This means that data sent/received can be compressed to save bandwidth.
  // Useful if you’re sending large JSON payloads or lots of messages.
  // Both client and server must support it; if not, the option is ignored.

  let pingInterval: NodeJS.Timeout | null = null;

  if (!shutdownBound) {
    shutdownBound = true;
    const shutdown = () => {
      try {
        if (pingInterval) clearInterval(pingInterval);
      } catch {
        // ignore; timer may already be cleared
      }
      try {
        ws.close();
      } catch {
        // ignore; socket may already be closed
      }
      // best-effort quit so we flush buffers and free sockets
      redis.quit().catch(() => redis.disconnect());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }

  ws.on("open", async () => {
    log.info("WS open", env.wsUrl);
    bindRedisErrorOnce();
    await ensureRedis();
    syncSubscriptions(ws, desiredTokenIds); // <- instead of manual add + send

    pingInterval = setInterval(() => {
      try {
        ws.ping();
      } catch {
        // ignore; socket may already be closed
      }
    }, 20_000);
  });

  ws.on("message", (raw) => {
    const text = String(raw);
    if (text === "PONG" || text === "PING") return;

    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      // Some WS servers send non-JSON keepalives; ignore.
      return;
    }
    //console.log("WS msg", msg);
    void mq
      .add(async () => {
        try {
          if (typeof msg !== "object" || msg === null) return;
          const m = msg as Record<string, unknown>;
          const evt = m.event_type || m.type; // be tolerant
          const id = m.asset_id || m.token_id;
          if (typeof id !== "string" || id.length === 0) return;

          // book snapshot or price change
          if (evt === "book" || evt === "price_change") {
            // some docs show bids/asks; older text mentions buys/sells; normalize
            const bids =
              (m.bids as Array<{ price: string }> | undefined) ||
              (m.buys as Array<{ price: string }> | undefined) ||
              [];
            const asks =
              (m.asks as Array<{ price: string }> | undefined) ||
              (m.sells as Array<{ price: string }> | undefined) ||
              [];

            const bb = bestBid(bids);
            const ba = bestAsk(asks);

            if (bb != null || ba != null) {
              const t = Number(m.timestamp);
              const ts = isFinite(t) ? (t < 1e12 ? t * 1000 : t) : Date.now();

              const tick = {
                token_id: id,
                best_bid: bb,
                best_ask: ba,
                ts,
              };
              const tickJson = JSON.stringify(tick);

              const multi = redis.multi();
              multi.set(`book:${id}`, JSON.stringify(msg), { EX: 5 });
              multi.set(`top:${id}`, tickJson, { EX: 60 });
              multi.publish(`prices:${id}`, tickJson);
              await Promise.all([
                writeUnifiedBookTop(pool, id, bb, ba, new Date(ts)),
                multi.exec(),
              ]);
            }
          } else if (evt === "last_trade_price") {
            const price = parsePrice(
              m.price ??
                m.last_trade_price ??
                m.last_price ??
                m.value ??
                m.last_trade_price_dollars,
            );
            if (price == null || price < 0 || price > 1) return;

            const size =
              parseSize(m.size ?? m.amount ?? m.quantity ?? m.count) ?? 1;
            const side = normalizeSide(
              m.side ?? m.taker_side ?? m.takerSide ?? m.direction,
            );

            const t = Number(m.timestamp);
            const ts = isFinite(t) ? (t < 1e12 ? t * 1000 : t) : Date.now();

            await writeUnifiedLastTrade(pool, {
              tokenId: id,
              venue: "polymarket",
              price,
              size,
              side: side ?? "BUY",
              ts: new Date(ts),
              txHash:
                typeof m.tx_hash === "string"
                  ? m.tx_hash
                  : typeof m.txHash === "string"
                    ? m.txHash
                    : null,
            });
          }
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
    log.warn("WS closed", code, reason.toString());
    // reconnect with exponential backoff
    const max = 30_000;
    const base = 1000 * 2 ** Math.min(attempt, 5);
    const delay = Math.min(max, base) + Math.floor(Math.random() * 500);
    setTimeout(() => startMarketWS(desiredTokenIds, attempt + 1), delay);
  });

  ws.on("error", (err) => log.err("WS error", err));
  return ws;
}

export function updateMarketWSSubscriptions(nextTokenIds: string[]): void {
  desiredTokenIds = nextTokenIds;
  const ws = currentWs;
  if (!ws) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  syncSubscriptions(ws, desiredTokenIds);
}
