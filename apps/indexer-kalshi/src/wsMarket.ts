// apps/indexer-kalshi/src/wsMarket.ts
import WebSocket from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { env } from "./env";
import { redis } from "../../indexer-polymarket/src/redis";
import { writeBookTop } from "../../indexer-polymarket/src/repo";

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

export function startMarketWS(tickers: string[]) {
  if (!tickers.length) {
    console.log("[indexer] No tickers to subscribe");
    return;
  }

  const unique = Array.from(new Set(tickers)).slice(0, env.wsSubset);
  console.log(`[WS] subscribing to ${unique.length} tickers`);

  let ws: WebSocket | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let lastPong = Date.now();
  let msgCount = 0;
  let msgCountStartTime = Date.now();
  let msgLogTimer: NodeJS.Timeout | null = null;

  const connect = () => {
    const headers = signWsHeaders();
    ws = new WebSocket(env.kalshiWsUrl, { headers });

    ws.on("open", () => {
      const msg = {
        id: 1,
        cmd: "subscribe",
        params: { channels: ["orderbook"], market_tickers: unique },
      };
      ws!.send(JSON.stringify(msg));
      console.log("[WS] subscribed");

      // keepalive: ping every 20s, if no pong in 60s -> reconnect
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          (ws as any).ping?.();
        } catch {}
        if (Date.now() - lastPong > 60_000) {
          console.warn("[WS] pong timeout; reconnecting");
          try {
            ws?.close();
          } catch {}
        }
      }, 20_000);

      // reset message counters and start logging interval
      msgCount = 0;
      msgCountStartTime = Date.now();
      if (msgLogTimer) clearInterval(msgLogTimer);
      msgLogTimer = setInterval(() => {
        const now = Date.now();
        const elapsed = (now - msgCountStartTime) / 1000;
        const rps = (msgCount / Math.max(1, elapsed)).toFixed(2);
        console.log(
          `[WS] msgs=${msgCount} in ${Math.floor(elapsed)}s ~ ${rps}/s`
        );
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
        const ts = new Date();
        await writeBookTop(`kalshi:${t}:YES`, top.yesBid, top.yesAsk, ts);
        await writeBookTop(`kalshi:${t}:NO`, top.noBid, top.noAsk, ts);

        msgCount++;
      } catch (e) {
        console.warn("[WS] parse", String(e));
      }
    });

    const onCloseOrError = (tag: string, err?: unknown) => {
      console.warn(`[WS] ${tag}`, err ? String(err) : "");
      try {
        ws?.close();
      } catch {}
      ws = null;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (msgLogTimer) {
        clearInterval(msgLogTimer);
        msgLogTimer = null;
      }
      setTimeout(connect, 2000);
    };

    ws.on("error", (e) => onCloseOrError("error", e));
    ws.on("close", () => onCloseOrError("closed"));
  };

  connect();
}
