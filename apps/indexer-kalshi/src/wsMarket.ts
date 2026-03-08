// apps/indexer-kalshi/src/wsMarket.ts
import WebSocket from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { env } from "./env.js";
import { redis } from "./redis.js";
import { pool } from "./db.js";
import { writeUnifiedBookTop } from "@hunch/db";
import { createTopTickGate } from "@hunch/infra";

// derive top-of-book from ws orderbook payload
function deriveTop(ob: { yes?: [number, number][]; no?: [number, number][] }) {
  const yesBidC = ob.yes?.[0]?.[0] ?? null;
  const noBidC = ob.no?.[0]?.[0] ?? null;
  const yesBid = yesBidC != null ? yesBidC / 100 : null;
  const noBid = noBidC != null ? noBidC / 100 : null;
  const yesAsk = noBid != null ? Math.max(0, 1 - noBid) : null;
  const noAsk = yesBid != null ? Math.max(0, 1 - yesBid) : null;
  return { yesBid, yesAsk, noBid, noAsk };
}

function signWsHeaders() {
  if (!env.kalshiKeyId || !env.kalshiPrivateKeyPath) {
    const extra =
      env.kalshiIssues.length > 0 ? ` (${env.kalshiIssues.join("; ")})` : "";
    throw new Error(`[kalshi] Missing auth env${extra}`);
  }

  const wsPath = "/trade-api/ws/v2";
  const ts = Date.now().toString();
  const pkPem = fs.readFileSync(path.resolve(env.kalshiPrivateKeyPath), "utf8");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(ts + "GET" + wsPath);
  signer.end();
  const signature = signer
    .sign({
      key: pkPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");

  return {
    "KALSHI-ACCESS-KEY": env.kalshiKeyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

function buildUniqueTickers(tickers: string[]): string[] {
  return Array.from(new Set(tickers)).slice(0, env.wsSubset);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

let desiredTickers: string[] = [];
let ws: WebSocket | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let msgLogTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let lastPong = Date.now();
let msgCount = 0;
let msgCountStartTime = Date.now();

async function publishKalshiTopNow(
  tokenId: string,
  bestBid: number | null,
  bestAsk: number | null,
  tsMs: number,
): Promise<void> {
  if (bestBid == null && bestAsk == null) return;
  const tick = {
    token_id: tokenId,
    best_bid: bestBid,
    best_ask: bestAsk,
    ts: tsMs,
  };
  const tickJson = JSON.stringify(tick);
  await Promise.all([
    writeUnifiedBookTop(pool, tokenId, bestBid, bestAsk, new Date(tsMs)),
    redis.set(`top:${tokenId}`, tickJson, { EX: 60 }),
    redis.publish(`prices:${tokenId}`, tickJson),
  ]);
}

const topTickGate = createTopTickGate({
  onDeferredPublish: ({ tokenId, bestBid, bestAsk, tsMs }) => {
    void publishKalshiTopNow(tokenId, bestBid, bestAsk, tsMs).catch((error) => {
      console.warn("[WS] deferred top publish failed", tokenId, String(error));
    });
  },
});

function clearTimers() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (msgLogTimer) {
    clearInterval(msgLogTimer);
    msgLogTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (!desiredTickers.length) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

function connect() {
  const unique = buildUniqueTickers(desiredTickers);
  if (!unique.length) {
    console.log("[WS] No tickers to subscribe");
    return;
  }

  const headers = signWsHeaders();
  ws = new WebSocket(env.kalshiWsUrl, { headers });

  ws.on("open", () => {
    const msg = {
      id: 1,
      cmd: "subscribe",
      params: { channels: ["orderbook"], market_tickers: unique },
    };
    ws?.send(JSON.stringify(msg));
    console.log(`[WS] subscribed (${unique.length} tickers)`);

    lastPong = Date.now();
    clearTimers();

    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {
        // ignore; ping not supported by client
      }
      if (Date.now() - lastPong > 60_000) {
        console.warn("[WS] pong timeout; reconnecting");
        try {
          ws?.close();
        } catch {
          // ignore; socket may already be closed
        }
      }
    }, 20_000);

    msgCount = 0;
    msgCountStartTime = Date.now();
    msgLogTimer = setInterval(() => {
      const now = Date.now();
      const elapsed = (now - msgCountStartTime) / 1000;
      const rps = (msgCount / Math.max(1, elapsed)).toFixed(2);
      console.log(`[WS] msgs=${msgCount} in ${Math.floor(elapsed)}s ~ ${rps}/s`);
      msgCount = 0;
      msgCountStartTime = now;
    }, 10_000);
  });

  ws.on("pong", () => {
    lastPong = Date.now();
  });

  ws.on("message", async (buf: Buffer) => {
    try {
      const m = JSON.parse(buf.toString());
      if (!m || !m.type || !m.data) return;
      if (!String(m.type).startsWith("orderbook")) return;
      const t = m.data.market_ticker as string;
      if (!t) return;

      // store raw book (so UI can render depth later)
      await redis.set(`book:kalshi:${t}`, JSON.stringify(m.data), { EX: 5 });

      const top = deriveTop(m.data);
      const tsMs = Date.now();
      const yesTokenId = `kalshi:${t}:YES`;
      const noTokenId = `kalshi:${t}:NO`;
      const publishYes = topTickGate.shouldPublish({
        tokenId: yesTokenId,
        bestBid: top.yesBid,
        bestAsk: top.yesAsk,
        tsMs,
      });
      const publishNo = topTickGate.shouldPublish({
        tokenId: noTokenId,
        bestBid: top.noBid,
        bestAsk: top.noAsk,
        tsMs,
      });

      if (!publishYes && !publishNo) {
        msgCount += 1;
        return;
      }

      const writes: Array<Promise<unknown>> = [];
      if (publishYes) {
        writes.push(
          publishKalshiTopNow(yesTokenId, top.yesBid, top.yesAsk, tsMs),
        );
      }
      if (publishNo) {
        writes.push(
          publishKalshiTopNow(noTokenId, top.noBid, top.noAsk, tsMs),
        );
      }

      await Promise.all(writes);

      msgCount += 1;
    } catch (e) {
      console.warn("[WS] parse", String(e));
    }
  });

  const onCloseOrError = (tag: string, err?: unknown) => {
    console.warn(`[WS] ${tag}`, err ? String(err) : "");
    try {
      ws?.close();
    } catch {
      // ignore; best-effort close
    }
    ws = null;
    clearTimers();
    scheduleReconnect();
  };

  ws.on("error", (e) => onCloseOrError("error", e));
  ws.on("close", () => onCloseOrError("closed"));
}

export function startMarketWS(tickers: string[]) {
  desiredTickers = buildUniqueTickers(tickers);
  if (!desiredTickers.length) {
    console.log("[indexer] No tickers to subscribe");
    return;
  }
  if (ws) {
    ws.close();
    return;
  }
  connect();
}

export function updateMarketWSSubscriptions(tickers: string[]) {
  const next = buildUniqueTickers(tickers);
  if (arraysEqual(next, desiredTickers)) return;
  desiredTickers = next;
  if (!desiredTickers.length) {
    if (ws) ws.close();
    return;
  }
  if (ws) {
    ws.close();
    return;
  }
  connect();
}
