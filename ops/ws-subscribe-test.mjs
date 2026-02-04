import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env"), override: true });

const venue = process.argv[2];
const isBun = Boolean(process.versions?.bun);
const counts = process.argv.slice(3).map((v) => Number(v)).filter(Number.isFinite);

if (!venue) {
  console.error("Usage: node ops/ws-subscribe-test.mjs <polymarket|dflow|limitless> [counts...]");
  process.exit(1);
}

const tests = counts.length ? counts : [200];

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("DATABASE_URL is required in .env");
  process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl });

function parseJsonStringArray(raw) {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function fetchPolymarketTokens(maxCount) {
  const limitMarkets = Math.max(100, maxCount * 2);
  const { rows } = await pool.query(
    `
      select clob_token_ids
      from polymarket_markets
      where closed = false
        and archived = false
        and enable_order_book = true
        and accepting_orders = true
        and clob_token_ids is not null
        and clob_token_ids <> '[]'
      order by
        coalesce(volume24hr_clob, 0) desc,
        coalesce(liquidity_clob, 0) desc,
        coalesce(volume24hr, 0) desc,
        coalesce(liquidity, 0) desc
      limit $1
    `,
    [limitMarkets],
  );

  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const tokenIds = parseJsonStringArray(row.clob_token_ids);
    for (const tokenId of tokenIds) {
      if (seen.has(tokenId)) continue;
      seen.add(tokenId);
      out.push(tokenId);
    }
  }
  return out;
}

async function fetchDflowTickers(maxCount) {
  const limitRows = Math.max(100, maxCount * 2);
  const { rows } = await pool.query(
    `
      select m.venue_market_id
      from unified_markets m
      where m.venue = 'kalshi'
        and m.status = 'ACTIVE'
        and m.venue_market_id is not null
      order by m.volume_24h desc nulls last,
               m.liquidity desc nulls last,
               m.open_interest desc nulls last
      limit $1
    `,
    [limitRows],
  );
  return rows.map((r) => r.venue_market_id).filter(Boolean);
}

async function fetchLimitlessSlugs(maxCount) {
  const limitRows = Math.max(100, maxCount * 2);
  const { rows } = await pool.query(
    `
      select m.slug
      from unified_markets m
      where m.venue = 'limitless'
        and m.status = 'ACTIVE'
        and m.slug is not null
      order by m.volume_total desc nulls last,
               m.liquidity desc nulls last,
               m.updated_at_db desc
      limit $1
    `,
    [limitRows],
  );
  return rows.map((r) => r.slug).filter(Boolean);
}

async function testPolymarket(ids, count) {
  const url =
    process.env.POLYMARKET_WS ??
    "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  const list = ids.slice(0, count);
  return await new Promise((resolve) => {
    const ws = new WebSocket(url);
    const start = Date.now();
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve({ ok, reason, ms: Date.now() - start });
    };
    const timer = setTimeout(() => finish(false, "timeout"), 8000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "MARKET", assets_ids: list, asset_ids: list }));
    });
    ws.on("message", () => {
      clearTimeout(timer);
      finish(true, "message");
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      finish(false, String(err));
    });
    ws.on("close", () => {
      clearTimeout(timer);
      finish(false, "closed");
    });
  });
}

async function testDflow(tickers, count) {
  const wsModule = await import("ws");
  const Ws = wsModule.default ?? wsModule.WebSocket;
  const dflowEnv = (process.env.DFLOW_ENV ?? "prod").toLowerCase();
  const url =
    process.env.DFLOW_WS_URL ??
    (dflowEnv === "dev"
      ? "wss://dev-prediction-markets-api.dflow.net/api/v1/ws"
      : "wss://prediction-markets-api.dflow.net/api/v1/ws");
  const list = tickers.slice(0, count);
  console.log(`[dflow] ws url: ${url} (env=${dflowEnv})`);
  return await new Promise((resolve) => {
  const ws = new Ws(url, {
    perMessageDeflate: true,
    handshakeTimeout: 8000,
    headers: process.env.DFLOW_API_KEY
      ? { "x-api-key": process.env.DFLOW_API_KEY }
      : undefined,
  });
    const start = Date.now();
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch {}
      resolve({ ok, reason, ms: Date.now() - start });
    };
    const timer = setTimeout(() => finish(false, "timeout"), 8000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "subscribe", channel: "prices", tickers: list }));
    });
    ws.on("message", () => {
      clearTimeout(timer);
      finish(true, "message");
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      const detail = err && typeof err === "object" && "message" in err ? err.message : String(err);
      finish(false, `error:${detail}`);
    });
    if (!isBun) {
      ws.on("unexpected-response", (_req, res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          clearTimeout(timer);
          const body = Buffer.concat(chunks).toString("utf8");
          const headers = JSON.stringify(res.headers);
          finish(
            false,
            `unexpected-response:${res.statusCode} headers=${headers} body=${body}`,
          );
        });
      });
    }
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      const msg = reason?.toString() || "";
      finish(false, `closed:${code}${msg ? `:${msg}` : ""}`);
    });
  });
}

async function testLimitless(slugs, count) {
  const base =
    process.env.LIMITLESS_WS ??
    "wss://ws.limitless.exchange";
  const wsUrl = base.endsWith("/markets") ? base : `${base}/markets`;
  const list = slugs.slice(0, count);
  const session = process.env.LIMITLESS_WS_SESSION ?? "";
  const { io } = await import("socket.io-client");
  return await new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (ok, reason) => {
      if (done) return;
      done = true;
      try { socket.disconnect(); } catch {}
      resolve({ ok, reason, ms: Date.now() - start });
    };
    const socket = io(wsUrl, {
      transports: ["websocket"],
      extraHeaders: session ? { cookie: `limitless_session=${session}` } : undefined,
      reconnection: false,
      timeout: 8000,
    });
    const timer = setTimeout(() => finish(false, "timeout"), 10000);
    socket.on("connect", () => {
      socket.emit("subscribe_market_prices", { marketSlugs: list });
    });
    socket.on("orderbookUpdate", () => {
      clearTimeout(timer);
      finish(true, "orderbookUpdate");
    });
    socket.on("newPriceData", () => {
      clearTimeout(timer);
      finish(true, "newPriceData");
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      finish(false, String(err));
    });
    socket.on("disconnect", () => {
      clearTimeout(timer);
      finish(false, "closed");
    });
  });
}

async function run() {
  let items = [];
  if (venue === "polymarket") {
    items = await fetchPolymarketTokens(Math.max(...tests));
  } else if (venue === "dflow") {
    items = await fetchDflowTickers(Math.max(...tests));
  } else if (venue === "limitless") {
    items = await fetchLimitlessSlugs(Math.max(...tests));
  } else {
    console.error(`Unknown venue: ${venue}`);
    process.exit(1);
  }

  const maxRequested = Math.max(...tests);
  console.log(`[${venue}] available items: ${items.length}`);
  if (maxRequested > items.length) {
    console.log(
      `[${venue}] requested max ${maxRequested} but only ${items.length} available; capping per test.`,
    );
  }
  for (const count of tests) {
    const actual = Math.min(count, items.length);
    if (actual === 0) {
      console.log(`  ${count}: no items available`);
      continue;
    }
    let result;
    if (venue === "polymarket") result = await testPolymarket(items, actual);
    if (venue === "dflow") result = await testDflow(items, actual);
    if (venue === "limitless") result = await testLimitless(items, actual);
    const label = actual === count ? `${count}` : `${count} (cap ${actual})`;
    console.log(
      `  ${label} -> ${result.ok ? "OK" : "FAIL"} (${result.reason}) in ${result.ms}ms`,
    );
  }
}

run()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
