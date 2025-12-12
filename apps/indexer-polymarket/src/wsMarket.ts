import WebSocket from "ws";
import { env } from "./env";
import { log } from "./log";
import { writeBookTop } from "./repo";
import { ensureRedis, redis } from "./redis";
import PQueue from "p-queue";

// Very light state holder
type SubState = { subscribed: Set<string> };
const state: SubState = { subscribed: new Set() };
const mq = new PQueue({ concurrency: Number(env.wsConcurrency || 8) });
let redisBound = false;
let shutdownBound = false;

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
  const ws = new WebSocket(env.wsUrl, { perMessageDeflate: true });

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
    const initial = initialTokenIds.slice(0, env.wsSubset);
    syncSubscriptions(ws, initial); // <- instead of manual add + send

    pingInterval = setInterval(() => {
      try {
        ws.ping();
      } catch {
        // ignore; socket may already be closed
      }
    }, 20_000);
  });

  ws.on("message", async (raw) => {
    mq.add(async () => {
      const msg = JSON.parse(String(raw));
      const evt = msg.event_type || msg.type; // be tolerant
      const id = msg.asset_id || msg.token_id;
      if (!id) return;

      // book snapshot or price change
      if (evt === "book" || evt === "price_change") {
        // some docs show bids/asks; older text mentions buys/sells; normalize
        const bids = msg.bids || msg.buys || [];
        const asks = msg.asks || msg.sells || [];

        const bb = bids.length ? parseFloat(bids[0].price) : null;
        const ba = asks.length ? parseFloat(asks[0].price) : null;

        if (bb != null || ba != null) {
          const t = Number(msg.timestamp);
          const ts = isFinite(t) ? (t < 1e12 ? t * 1000 : t) : Date.now();

          const multi = redis.multi();
          multi.set(`book:${id}`, JSON.stringify(msg), { EX: 5 });
          multi.publish(
            `prices:${id}`,
            JSON.stringify({ token_id: id, best_bid: bb, best_ask: ba, ts }),
          );
          await Promise.all([
            writeBookTop(id, bb, ba, new Date(ts)),
            multi.exec(),
          ]);
        }
      } else if (evt === "last_trade_price") {
        // optional: buffer then batch insert into last_trade
      }
    });
  });

  ws.on("close", (code, reason) => {
    if (pingInterval) clearInterval(pingInterval);
    log.warn("WS closed", code, reason.toString());
    // reconnect with exponential backoff
    const max = 30_000;
    const base = 1000 * 2 ** Math.min(attempt, 5);
    const delay = Math.min(max, base) + Math.floor(Math.random() * 500);
    setTimeout(
      () => startMarketWS(Array.from(state.subscribed), attempt + 1),
      delay,
    );
  });

  ws.on("error", (err) => log.err("WS error", err));
  return ws;
}
