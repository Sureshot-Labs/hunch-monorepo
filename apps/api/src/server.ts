import Fastify from "fastify";
import crypto from "node:crypto";
import { pool } from "./db.js";
import { env } from "./env.js";
import { getRedis } from "./redis.js";
import { onReqStart, onReqEnd, getMetrics } from "./metrics.js";

const app = Fastify({ logger: true });

app.addHook("onRequest", async (req, _reply) => {
  (req as any)._t0 = onReqStart();
});
app.addHook("onResponse", async (req, _reply) => {
  onReqEnd((req as any)._t0);
});

app.get("/metrics", async (_req, reply) => {
  const m = getMetrics();
  return reply.send(m);
});

app.get("/health", async () => ({ ok: true }));

/**
 * GET /prices/stream
 * Query:
 *  - token_id: string | comma-separated list | repeated param
 * Streams initial snapshots (if any) + live ticks from Redis pub/sub.
 */
app.get("/prices/stream", async (request, reply) => {
  const r = await getRedis();
  if (!r) {
    reply.code(503);
    return reply.send({ error: "Redis not configured" });
  }

  // normalize token ids: ?token_id=a&token_id=b or ?token_id=a,b
  const q = request.query as Record<string, any>;
  let ids: string[] = [];
  if (Array.isArray(q.token_id))
    ids = q.token_id.flatMap((s: string) => String(s).split(","));
  else if (typeof q.token_id === "string") ids = q.token_id.split(",");
  ids = ids.map((s) => s.trim()).filter(Boolean);

  if (!ids.length) {
    reply.code(400);
    return reply.send({ error: "Pass token_id or token_id=a,b,c" });
  }

  // SSE headers
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.flushHeaders();

  const sub = r.duplicate();
  await sub.connect();

  const channels = ids.map((id) => `prices:${id}`);
  const send = (evt: string, data: any) => {
    try {
      reply.raw.write(`event: ${evt}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client closed mid-write */
    }
  };

  // send current snapshots if present
  for (const id of ids) {
    try {
      const snap = await r.get(`book:${id}`);
      if (snap) send("snapshot", JSON.parse(snap));
    } catch {}
  }

  // subscribe to live ticks
  for (const ch of channels) {
    await sub.subscribe(ch, (message: string) => {
      try {
        send("tick", JSON.parse(message));
      } catch {}
    });
  }

  // heartbeat so proxies don’t kill idle streams
  const hb = setInterval(() => {
    try {
      reply.raw.write(":keepalive\n\n");
    } catch {}
  }, 20000);

  // cleanup
  request.raw.on("close", async () => {
    clearInterval(hb);
    try {
      for (const ch of channels) await sub.unsubscribe(ch);
    } catch {}
    try {
      await sub.quit();
    } catch {
      sub.disconnect();
    }
  });
});

/**
 * GET /feed
 * Query:
 *  - limit?: number (default env.defaultLimit, max env.maxLimit)
 *  - offset?: number (default 0)
 *  - min_volume24hr?: number (default > 0)
 *  - venue?: string ("polymarket" | "kalshi")
 *  - category?: string (exact match)
 *
 * Adds ETag + Cache-Control. Uses Redis string body as the single source of truth
 * so ETag always matches the exact bytes sent.
 */
app.get("/feed", async (req, reply) => {
  const q = req.query as Record<string, string | undefined>;
  const limit = Math.min(
    Math.max(parseInt(q.limit ?? "") || env.defaultLimit, 1),
    env.maxLimit
  );
  const offset = Math.max(parseInt(q.offset ?? "") || 0, 0);
  const minVol = q.min_volume24hr != null ? Number(q.min_volume24hr) : 1e-9;
  const venue = q.venue?.toLowerCase();
  const category = q.category;

  const cacheKey = `feed:v2:${limit}:${offset}:${minVol}:${venue ?? ""}:${
    category ?? ""
  }`;
  const r = await getRedis();

  // serve from cache if present, with proper ETag/304 handling
  if (r) {
    const cachedBody = await r.get(cacheKey);
    if (cachedBody) {
      const etag = `W/"${crypto
        .createHash("sha1")
        .update(cachedBody)
        .digest("hex")}"`;
      if (req.headers["if-none-match"] === etag) {
        reply.header("ETag", etag);
        reply.code(304);
        return reply.send();
      }
      reply.header("x-cache", "hit");
      reply.header("ETag", etag);
      reply.header(
        "Cache-Control",
        "private, max-age=2, stale-while-revalidate=30"
      );
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(cachedBody); // send exact bytes we hashed
    }
  }

  // Build SQL with sequential parameters only
  const params: any[] = [minVol, limit, offset];
  const where: string[] = [
    "coalesce(m.volume24hr, 0) >= $1",
    "m.enable_orderbook = true",
  ];

  if (venue) {
    params.push(venue);
    where.push("lower(v.name) = $4");
  }
  if (category) {
    params.push(category);
    where.push("e.category = $" + params.length);
  }

  const sql = `
    with base as (
      select
        m.id as market_uuid,
        v.name as venue,
        m.market_id,
        m.title as market_title,
        e.title as event_title,
        e.category,
        e.start_time,
        e.end_time,
        m.volume24hr,
        m.liquidity,
        m.accepting_orders,
        m.clob_token_yes,
        m.clob_token_no
      from markets m
      join events e   on e.id = m.event_id
      join venues v   on v.id = m.venue_id
      where ${where.join(" and ")}
    ),
    latest as (
      select distinct on (bt.token_id)
        bt.token_id, bt.best_bid, bt.best_ask, bt.mid, bt.spread, bt.ts
      from book_top bt
      order by bt.token_id, bt.ts desc
    )
    select
      b.venue,
      b.market_id,
      b.event_title,
      b.market_title,
      b.category,
      b.start_time,
      b.end_time,
      b.volume24hr,
      b.liquidity,
      b.accepting_orders,
      b.clob_token_yes as token_yes,
      b.clob_token_no  as token_no,
      ly.best_bid as yes_bid, ly.best_ask as yes_ask,
      ln.best_bid as no_bid,  ln.best_ask as no_ask,
      greatest(coalesce(ly.ts, '-infinity'), coalesce(ln.ts, '-infinity')) as last_update
    from base b
    left join latest ly on ly.token_id = b.clob_token_yes
    left join latest ln on ln.token_id = b.clob_token_no
    order by b.volume24hr desc nulls last, b.market_id
    limit $2 offset $3
  `;

  const { rows } = await pool.query(sql, params);

  const data = rows.map((r) => ({
    venue: r.venue,
    marketId: r.market_id,
    eventTitle: r.event_title,
    marketTitle: r.market_title,
    category: r.category,
    startTime: r.start_time,
    endTime: r.end_time,
    volume24h: r.volume24hr != null ? Number(r.volume24hr) : 0, // cast
    liquidity: r.liquidity != null ? Number(r.liquidity) : 0, // cast
    acceptingOrders: r.accepting_orders,
    tokens: { yes: r.token_yes, no: r.token_no },
    top: {
      yesBid: r.yes_bid != null ? Number(r.yes_bid) : null,
      yesAsk: r.yes_ask != null ? Number(r.yes_ask) : null,
      noBid: r.no_bid != null ? Number(r.no_bid) : null,
      noAsk: r.no_ask != null ? Number(r.no_ask) : null,
    },
    lastUpdate: r.last_update,
  }));

  const payload = {
    count: data.length,
    limit,
    offset,
    minVolume24h: minVol,
    data,
  };

  // serialize once, hash those exact bytes for ETag, then cache/send same bytes
  const body = JSON.stringify(payload);
  const etag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;

  if (r) {
    await r.set(cacheKey, body, { EX: env.feedTtlSec });
    reply.header("x-cache", "miss");
  }

  reply.header("ETag", etag);
  reply.header(
    "Cache-Control",
    "private, max-age=2, stale-while-revalidate=30"
  );
  reply.header("Content-Type", "application/json; charset=utf-8");
  return reply.send(body);
});

export async function start() {
  await getRedis().catch(() => {}); // optional
  const addr = await app.listen({ port: env.port, host: "0.0.0.0" });
  app.log.info(`api listening on ${addr}`);
}

// actually start the server
start().catch((e) => {
  app.log.error(e);
  process.exit(1);
});
