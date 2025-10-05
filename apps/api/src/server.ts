import Fastify from "fastify";
import crypto from "node:crypto";
import { pool } from "./db.js";
import { env } from "./env.js";
import { getRedis } from "./redis.js";
import { onReqStart, onReqEnd, getMetrics } from "./metrics.js";

// Rate limiting for external APIs
const rateLimiters = new Map<string, { count: number; resetTime: number }>();

async function checkRateLimit(key: string, maxRequests: number = 10, windowMs: number = 60000): Promise<boolean> {
  const now = Date.now();
  const limiter = rateLimiters.get(key);
  
  if (!limiter || now > limiter.resetTime) {
    rateLimiters.set(key, { count: 1, resetTime: now + windowMs });
    return true;
  }
  
  if (limiter.count >= maxRequests) {
    return false;
  }
  
  limiter.count++;
  return true;
}

// Polymarket-specific rate limiting and request management
class PolymarketRateLimiter {
  public requestQueue: Array<{
    key: string;
    requestData: any;
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }> = [];
  public isProcessing = false;
  private lastRequestTime = 0;
  public requestCount = 0;
  public windowStart = Date.now();
  
  // Polymarket rate limits by endpoint type
  private readonly RATE_LIMITS = {
    'price-history': { maxRequests: 100, windowMs: 10000 }, // 100 requests per 10 seconds
    'book': { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
    'books': { maxRequests: 80, windowMs: 10000 }, // 80 requests per 10 seconds
    'price': { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
    'prices': { maxRequests: 80, windowMs: 10000 }, // 80 requests per 10 seconds
    'midpoint': { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
    'spreads': { maxRequests: 200, windowMs: 10000 }, // 200 requests per 10 seconds
  };
  
  private readonly WINDOW_MS = 10000; // 10 seconds
  private readonly MIN_REQUEST_INTERVAL = 50; // Minimum 50ms between requests
  
  async queueRequest(key: string, requestData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.requestQueue.push({ key, requestData, resolve, reject });
      this.processQueue();
    });
  }
  
  private async processQueue() {
    if (this.isProcessing || this.requestQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    while (this.requestQueue.length > 0) {
      const now = Date.now();
      
      // Reset window if needed
      if (now - this.windowStart >= this.WINDOW_MS) {
        this.requestCount = 0;
        this.windowStart = now;
      }
      
      // Check if we can make a request (use most restrictive limit)
      const maxRequests = Math.min(...Object.values(this.RATE_LIMITS).map(limit => limit.maxRequests));
      if (this.requestCount >= maxRequests) {
        // Wait for window to reset
        const waitTime = this.WINDOW_MS - (now - this.windowStart);
        await new Promise(resolve => setTimeout(resolve, waitTime + 100));
        continue;
      }
      
      // Ensure minimum interval between requests
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
        await new Promise(resolve => setTimeout(resolve, this.MIN_REQUEST_INTERVAL - timeSinceLastRequest));
      }
      
      const request = this.requestQueue.shift()!;
      
      try {
        let result;
        
        // Handle different request types
        if (request.requestData.isPost) {
          result = await this.makePostRequest(request.requestData.endpoint, request.requestData.body);
        } else if (request.requestData.endpoint) {
          result = await this.makeRequest(request.requestData.endpoint, request.requestData.params);
        } else {
          // Legacy price history request
          const params = new URLSearchParams({ 
            market: request.key,
            interval: 'max'
          });
          result = await this.makeRequest('/prices-history', params);
        }
        
        request.resolve(result);
        this.requestCount++;
        this.lastRequestTime = Date.now();
      } catch (error) {
        request.reject(error);
      }
    }
    
    this.isProcessing = false;
  }
  
  private async makeRequest(endpoint: string, params: URLSearchParams = new URLSearchParams()): Promise<any> {
    const url = `https://clob.polymarket.com${endpoint}${params.toString() ? '?' + params.toString() : ''}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Hunch-API/1.0',
      },
    });
    
    if (!response.ok) {
      throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
    }
    
    return response.json();
  }

  private async makePostRequest(endpoint: string, body: any): Promise<any> {
    const url = `https://clob.polymarket.com${endpoint}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Hunch-API/1.0',
      },
      body: JSON.stringify(body),
    });
    
    if (!response.ok) {
      throw new Error(`Polymarket API error: ${response.status} ${response.statusText}`);
    }
    
    return response.json();
  }
}

const polymarketRateLimiter = new PolymarketRateLimiter();

// Data processing utilities
class PriceHistoryProcessor {
  // Frontend-friendly time intervals in milliseconds
  private static readonly TIME_INTERVALS = {
    '1h': 60 * 60 * 1000,           // 1 hour
    '6h': 6 * 60 * 60 * 1000,       // 6 hours
    '1d': 24 * 60 * 60 * 1000,      // 1 day
    '1w': 7 * 24 * 60 * 60 * 1000,  // 1 week
    '1m': 30 * 24 * 60 * 60 * 1000, // 1 month
    '6m': 6 * 30 * 24 * 60 * 60 * 1000, // 6 months
    'max': Infinity,                // All available data
  };

  static processPriceHistory(rawData: any, requestedInterval: string, startTs?: number, endTs?: number): any {
    if (!rawData?.history || !Array.isArray(rawData.history)) {
      return rawData;
    }

    const history = rawData.history;
    const now = Date.now() / 1000; // Convert to Unix timestamp

    // Determine the actual time range to return
    let actualStartTs: number;
    let actualEndTs: number = now;

    if (startTs && endTs) {
      // Use explicit time range
      actualStartTs = startTs;
      actualEndTs = endTs;
    } else {
      // Use interval-based calculation
      const intervalMs = PriceHistoryProcessor.TIME_INTERVALS[requestedInterval as keyof typeof PriceHistoryProcessor.TIME_INTERVALS];
      if (intervalMs === undefined) {
        // Invalid interval, return all data
        return rawData;
      }
      
      if (intervalMs === Infinity) {
        // Max interval, return all data
        return rawData;
      }
      
      actualStartTs = now - (intervalMs / 1000); // Convert to seconds
    }

    // Filter and slice the data
    const filteredHistory = history.filter((point: any) => {
      const timestamp = point.t;
      return timestamp >= actualStartTs && timestamp <= actualEndTs;
    });

    // Apply fidelity (downsampling) if needed
    const fidelity = PriceHistoryProcessor.calculateFidelity(actualStartTs, actualEndTs, requestedInterval);
    const downsampledHistory = PriceHistoryProcessor.downsampleData(filteredHistory, fidelity);

    return {
      ...rawData,
      history: downsampledHistory,
      metadata: {
        requestedInterval,
        actualStartTs,
        actualEndTs,
        originalDataPoints: history.length,
        filteredDataPoints: filteredHistory.length,
        finalDataPoints: downsampledHistory.length,
        fidelityMinutes: fidelity,
      }
    };
  }

  private static calculateFidelity(startTs: number, endTs: number, interval: string): number {
    const durationMs = (endTs - startTs) * 1000;
    
    // Determine appropriate fidelity based on interval and duration
    switch (interval) {
      case '1h':
        return 1; // 1 minute fidelity for 1 hour
      case '6h':
        return 5; // 5 minute fidelity for 6 hours
      case '1d':
        return 15; // 15 minute fidelity for 1 day
      case '1w':
        return 60; // 1 hour fidelity for 1 week
      case '1m':
        return 240; // 4 hour fidelity for 1 month
      case '6m':
        return 1440; // 1 day fidelity for 6 months
      default:
        return Math.max(1, Math.floor(durationMs / (1000 * 60 * 100))); // Dynamic based on duration
    }
  }

  private static downsampleData(history: any[], fidelityMinutes: number): any[] {
    if (fidelityMinutes <= 1 || history.length <= 100) {
      return history; // No downsampling needed
    }

    const downsampled: any[] = [];
    const fidelityMs = fidelityMinutes * 60 * 1000;

    for (let i = 0; i < history.length; i++) {
      const currentPoint = history[i];
      const currentTime = currentPoint.t * 1000; // Convert to milliseconds

      if (downsampled.length === 0) {
        downsampled.push(currentPoint);
        continue;
      }

      const lastTime = downsampled[downsampled.length - 1].t * 1000;
      
      if (currentTime - lastTime >= fidelityMs) {
        downsampled.push(currentPoint);
      }
    }

    return downsampled;
  }
}

// External API clients
class PolymarketClient {
  private pendingRequests = new Map<string, Promise<any>>();
  
  // Existing price history method (maintains backward compatibility)
  async getPriceHistory(tokenId: string, options: {
    startTs?: number;
    endTs?: number;
    interval?: string;
    fidelity?: number;
  } = {}) {
    // Always use the same cache key for max data (tokenId only)
    // This ensures we fetch max data once and slice it for different requests
    const maxDataKey = `max-data:${tokenId}`;
    
    // If max data is already being fetched for this token, wait for it
    if (this.pendingRequests.has(maxDataKey)) {
      const maxDataPromise = this.pendingRequests.get(maxDataKey)!;
      const maxData = await maxDataPromise;
      
      // Process the max data for the specific request
      return PriceHistoryProcessor.processPriceHistory(
        maxData, 
        options.interval || 'max', 
        options.startTs, 
        options.endTs
      );
    }
    
    // Create new request promise for max data
    const requestPromise = polymarketRateLimiter.queueRequest(tokenId, {});
    
    // Store the promise for deduplication (using max data key)
    this.pendingRequests.set(maxDataKey, requestPromise);
    
    // Clean up when request completes
    requestPromise.finally(() => {
      this.pendingRequests.delete(maxDataKey);
    });
    
    // Wait for max data and then process it
    const maxData = await requestPromise;
    return PriceHistoryProcessor.processPriceHistory(
      maxData, 
      options.interval || 'max', 
      options.startTs, 
      options.endTs
    );
  }

  // New market data methods for trading functionality
  
  /**
   * Get order book for a single token
   * Rate limit: 200 requests/10s
   */
  async getOrderBook(tokenId: string): Promise<any> {
    const params = new URLSearchParams({ token_id: tokenId });
    return polymarketRateLimiter.queueRequest(`/book:${tokenId}`, { endpoint: '/book', params });
  }

  /**
   * Get order books for multiple tokens
   * Rate limit: 80 requests/10s
   */
  async getOrderBooksBatch(tokenIds: string[]): Promise<any> {
    const body = tokenIds.map(id => ({ token_id: id }));
    return polymarketRateLimiter.queueRequest(`/books:${tokenIds.join(',')}`, { endpoint: '/books', body, isPost: true });
  }

  /**
   * Get price for a single token with side
   * Rate limit: 200 requests/10s
   */
  async getPrice(tokenId: string, side: 'BUY' | 'SELL'): Promise<any> {
    const params = new URLSearchParams({ 
      token_id: tokenId,
      side: side
    });
    return polymarketRateLimiter.queueRequest(`/price:${tokenId}:${side}`, { endpoint: '/price', params });
  }

  /**
   * Get prices for multiple tokens with sides
   * Rate limit: 80 requests/10s
   */
  async getPricesBatch(requests: Array<{token_id: string, side: 'BUY' | 'SELL'}>): Promise<any> {
    return polymarketRateLimiter.queueRequest(`/prices:${requests.map(r => `${r.token_id}:${r.side}`).join(',')}`, { 
      endpoint: '/prices', 
      body: requests, 
      isPost: true 
    });
  }

  /**
   * Get midpoint price for a token
   * Rate limit: 200 requests/10s
   */
  async getMidpointPrice(tokenId: string): Promise<any> {
    const params = new URLSearchParams({ token_id: tokenId });
    return polymarketRateLimiter.queueRequest(`/midpoint:${tokenId}`, { endpoint: '/midpoint', params });
  }

  /**
   * Get bid-ask spreads for multiple tokens
   * Rate limit: 200 requests/10s
   */
  async getSpreadsBatch(tokenIds: string[]): Promise<any> {
    const body = tokenIds.map(id => ({ token_id: id }));
    return polymarketRateLimiter.queueRequest(`/spreads:${tokenIds.join(',')}`, { 
      endpoint: '/spreads', 
      body, 
      isPost: true 
    });
  }
}

const polymarketClient = new PolymarketClient();

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
 * GET /price-history/status
 * Returns the current status of the Polymarket rate limiter
 */
app.get("/price-history/status", async (request, reply) => {
  const status = {
    polymarketRateLimiter: {
      queueLength: polymarketRateLimiter.requestQueue.length,
      isProcessing: polymarketRateLimiter.isProcessing,
      requestCount: polymarketRateLimiter.requestCount,
      windowStart: polymarketRateLimiter.windowStart,
      timeUntilReset: Math.max(0, polymarketRateLimiter.windowStart + 10000 - Date.now()),
    },
    timestamp: new Date().toISOString(),
  };
  
  reply.header("Content-Type", "application/json; charset=utf-8");
  return reply.send(status);
});

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
  const minLiquidity = q.min_liquidity != null ? Number(q.min_liquidity) : 0;
  const venue = q.venue?.toLowerCase();
  const category = q.category;
  const filter = q.filter; // only use if present
  const sort = q.sort; // only use if present

  const cacheKey = `feed:v6:${limit}:${offset}:${minVol}:${minLiquidity}:${
    venue ?? ""
  }:${category ?? ""}:${filter ?? ""}:${sort ?? ""}`;
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
      return reply.send(cachedBody);
    }
  }

  // 1. Get event IDs matching filters, with limit/offset
  const eventParams: any[] = [];
  const eventWhere: string[] = [];
  let paramIdx = 1;

  if (venue) {
    eventParams.push(venue);
    eventWhere.push(`lower(v.name) = $${paramIdx++}`);
  }
  if (category) {
    eventParams.push(category);
    eventWhere.push(`e.category = $${paramIdx++}`);
  }

  // Filtering logic (filter param)
  if (filter === "newest") {
    eventWhere.push(`e.start_time >= now() - interval '7 days'`);
  } else if (filter === "endingsoon") {
    eventWhere.push(`e.end_time <= now() + interval '7 days'`);
  }
  // if filter is not present, do not apply any filter

  // Sorting logic (sort param)
  let eventOrder = "";
  if (sort === "totalvol") eventOrder = "e.volume_total desc nulls last, e.id";
  else if (sort === "liquidity")
    eventOrder = "e.liquidity desc nulls last, e.id";
  else if (sort == null) eventOrder = ""; // no sort if not present
  else eventOrder = "e.start_time desc nulls last, e.id"; // fallback

  // Aggregate volume/liquidity for events
  const eventSql = `
    select
      e.id,
      sum(coalesce(m.volume24hr, 0)) as total_volume,
      sum(coalesce(m.liquidity, 0)) as total_liquidity,
      e.start_time,
      e.end_time
    from events e
    join markets m on m.event_id = e.id
    ${venue ? "join venues v on v.id = e.venue_id" : ""}
    ${eventWhere.length ? "where " + eventWhere.join(" and ") : ""}
    group by e.id, e.start_time, e.end_time
    having sum(coalesce(m.volume24hr, 0)) >= $${paramIdx++}
      and sum(coalesce(m.liquidity, 0)) >= $${paramIdx++}
    ${eventOrder ? `order by ${eventOrder}` : ""}
    limit ${limit} offset ${offset}
  `;
  eventParams.push(minVol, minLiquidity);

  const { rows: eventRows } = await pool.query(eventSql, eventParams);
  const eventIds = eventRows.map((r) => r.id);
  if (!eventIds.length) {
    const payload = {
      count: 0,
      limit,
      offset,
      minVolume24h: minVol,
      data: [],
    };
    const body = JSON.stringify(payload);
    const etag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;
    reply.header("ETag", etag);
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(body);
  }

  // 2. Fetch all markets for those events, with volume/liquidity filter
  const marketParams: any[] = [minVol, minLiquidity, eventIds];
  const marketWhere: string[] = [
    "coalesce(m.volume24hr, 0) >= $1",
    "coalesce(m.liquidity, 0) >= $2",
    "m.enable_orderbook = true",
    `m.event_id = ANY($3::uuid[])`,
  ];

  // Sorting for markets: use same sort as for events, or none
  let marketOrder = "";
  if (sort === "totalvol")
    marketOrder = "m.volume24hr desc nulls last, m.market_id";
  else if (sort === "liquidity")
    marketOrder = "m.liquidity desc nulls last, m.market_id";
  else if (sort == null) marketOrder = ""; // no sort if not present
  else marketOrder = "e.start_time desc nulls last, m.market_id"; // fallback

  const marketSql = `
    select
      e.id as event_id,
      e.title as event_title,
      e.category,
      e.start_time,
      e.end_time,
      e.liquidity as event_liquidity,
      e.volume_total as event_volume,
      m.id as market_uuid,
      v.name as venue,
      m.market_id,
      m.title as market_title,
      m.volume24hr,
      m.liquidity,
      m.accepting_orders,
      m.clob_token_yes,
      m.clob_token_no,
      ly.best_bid as yes_bid, ly.best_ask as yes_ask,
      ln.best_bid as no_bid,  ln.best_ask as no_ask,
      greatest(coalesce(ly.ts, '-infinity'), coalesce(ln.ts, '-infinity')) as last_update
    from events e
    join markets m on m.event_id = e.id
    join venues v on v.id = m.venue_id
    left join (
      select distinct on (bt.token_id)
        bt.token_id, bt.best_bid, bt.best_ask, bt.ts
      from book_top bt
      order by bt.token_id, bt.ts desc
    ) ly on ly.token_id = m.clob_token_yes
    left join (
      select distinct on (bt.token_id)
        bt.token_id, bt.best_bid, bt.best_ask, bt.ts
      from book_top bt
      order by bt.token_id, bt.ts desc
    ) ln on ln.token_id = m.clob_token_no
    where ${marketWhere.join(" and ")}
    ${marketOrder ? `order by ${marketOrder}` : ""}
  `;

  const { rows } = await pool.query(marketSql, marketParams);

  // Group markets under their events
  const eventMap: Record<string, any> = {};
  for (const r of rows) {
    const eid = r.event_id;
    if (!eventMap[eid]) {
      eventMap[eid] = {
        eventId: eid,
        eventTitle: r.event_title,
        category: r.category,
        startTime: r.start_time,
        endTime: r.end_time,
        eventLiquidity:
          r.event_liquidity != null ? Number(r.event_liquidity) : 0,
        eventVolume: r.event_volume != null ? Number(r.event_volume) : 0,
        markets: [],
      };
    }
    eventMap[eid].markets.push({
      venue: r.venue,
      marketId: r.market_id,
      marketTitle: r.market_title,
      volume24h: r.volume24hr != null ? Number(r.volume24hr) : 0,
      liquidity: r.liquidity != null ? Number(r.liquidity) : 0,
      acceptingOrders: r.accepting_orders,
      tokens: { yes: r.clob_token_yes, no: r.clob_token_no },
      top: {
        yesBid: r.yes_bid != null ? Number(r.yes_bid) : null,
        yesAsk: r.yes_ask != null ? Number(r.yes_ask) : null,
        noBid: r.no_bid != null ? Number(r.no_bid) : null,
        noAsk: r.no_ask != null ? Number(r.no_ask) : null,
      },
      lastUpdate: r.last_update,
    });
  }

  // Only include events that were in the limited eventIds list
  const data = eventIds.map(
    (eid) =>
      eventMap[eid] || {
        eventId: eid,
        eventTitle: null,
        category: null,
        startTime: null,
        endTime: null,
        eventLiquidity: 0,
        eventVolume: 0,
        markets: [],
      }
  );

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

/**
 * GET /price-history
 * Query:
 *  - tokens: string (comma-separated token IDs - for Polymarket these are CLOB token IDs)
 *  - venue?: string ("polymarket" | "kalshi" | etc.) - defaults to "polymarket"
 *  - startTs?: number (Unix timestamp)
 *  - endTs?: number (Unix timestamp)
 *  - interval?: string ("1h", "6h", "1d", "1w", "1m", "6m", "max")
 *  - fidelity?: number (resolution in minutes)
 * 
 * Fetches price history for multiple tokens from specified venue.
 * 
 * OPTIMIZATION STRATEGY:
 * - Always fetches MAX data from Polymarket API (interval=max)
 * - Caches max data per token for 30 minutes
 * - Slices and downsamples data based on frontend requirements
 * - Dramatically reduces API calls to Polymarket
 * 
 * Supports intelligent caching, rate limiting, and request deduplication.
 */
app.get("/price-history", async (request, reply) => {
  const q = request.query as Record<string, string | undefined>;
  
  // Validate required parameters
  if (!q.tokens) {
    reply.code(400);
    return reply.send({ error: "tokens parameter is required (comma-separated token IDs)" });
  }
  
  const tokens = q.tokens.split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) {
    reply.code(400);
    return reply.send({ error: "At least one token ID is required" });
  }
  
  if (tokens.length > 50) {
    reply.code(400);
    return reply.send({ error: "Maximum 50 tokens per request" });
  }
  
  const venue = q.venue?.toLowerCase() || 'polymarket';
  const startTs = q.startTs ? parseInt(q.startTs) : undefined;
  const endTs = q.endTs ? parseInt(q.endTs) : undefined;
  const interval = q.interval;
  const fidelity = q.fidelity ? parseInt(q.fidelity) : undefined;
  
  // Validate timestamp parameters
  if (startTs && (isNaN(startTs) || startTs < 0)) {
    reply.code(400);
    return reply.send({ error: "startTs must be a valid Unix timestamp" });
  }
  if (endTs && (isNaN(endTs) || endTs < 0)) {
    reply.code(400);
    return reply.send({ error: "endTs must be a valid Unix timestamp" });
  }
  if (startTs && endTs && startTs >= endTs) {
    reply.code(400);
    return reply.send({ error: "startTs must be less than endTs" });
  }
  
  // Validate interval
  const validIntervals = ['1h', '6h', '1d', '1w', '1m', '6m', 'max'];
  if (interval && !validIntervals.includes(interval)) {
    reply.code(400);
    return reply.send({ error: `interval must be one of: ${validIntervals.join(', ')}` });
  }
  
  // Check client rate limiting (more generous since we handle Polymarket limits internally)
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `price-history:${venue}:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  // Create cache key for max data (per token) - much simpler caching strategy
  const maxDataCacheKeys = tokens.map(token => `max-data:${venue}:${token}`);
  const r = await getRedis();
  
  // Check if we have max data cached for all tokens
  let allMaxDataCached = true;
  const cachedMaxData: Record<string, any> = {};
  
  if (r) {
    for (const cacheKey of maxDataCacheKeys) {
      const cachedData = await r.get(cacheKey);
      if (cachedData) {
        const token = cacheKey.split(':')[2]; // Extract token from cache key
        cachedMaxData[token] = JSON.parse(cachedData);
      } else {
        allMaxDataCached = false;
        break;
      }
    }
  } else {
    allMaxDataCached = false;
  }
  
  // If we have all max data cached, process it and return
  if (allMaxDataCached && Object.keys(cachedMaxData).length === tokens.length) {
    const results: Record<string, any> = {};
    
    for (const token of tokens) {
      const maxData = cachedMaxData[token];
      results[token] = PriceHistoryProcessor.processPriceHistory(
        maxData,
        interval || 'max',
        startTs,
        endTs
      );
    }
    
    const response = {
      venue,
      tokens: results,
      metadata: {
        requestedTokens: tokens.length,
        successfulTokens: tokens.length,
        failedTokens: 0,
        timestamp: new Date().toISOString(),
        cacheStatus: 'max-data-cached',
      },
    };
    
    reply.header("x-cache", "hit");
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return reply.send(JSON.stringify(response));
  }
  
  try {
    const results: Record<string, any> = {};
    const errors: Record<string, string> = {};
    
    // Process each token
    for (const token of tokens) {
      try {
        let processedData;
        
        // Route to appropriate venue client
        switch (venue) {
          case 'polymarket':
            processedData = await polymarketClient.getPriceHistory(token, {
              startTs,
              endTs,
              interval,
              fidelity,
            });
            break;
          default:
            throw new Error(`Unsupported venue: ${venue}`);
        }
        
        results[token] = processedData;
        
        // Cache the max data for this token (if we got raw max data)
        if (r && processedData && !processedData.metadata?.originalDataPoints) {
          // This is raw max data, cache it
          const maxDataCacheKey = `max-data:${venue}:${token}`;
          await r.set(maxDataCacheKey, JSON.stringify(processedData), { EX: 1800 }); // 30 minutes
        }
        
      } catch (error) {
        errors[token] = error instanceof Error ? error.message : 'Unknown error';
      }
    }
    
    const response = {
      venue,
      tokens: results,
      errors: Object.keys(errors).length > 0 ? errors : undefined,
      metadata: {
        requestedTokens: tokens.length,
        successfulTokens: Object.keys(results).length,
        failedTokens: Object.keys(errors).length,
        timestamp: new Date().toISOString(),
      },
    };
    
    const responseBody = JSON.stringify(response);
    
    // No need to cache processed responses since we cache max data separately
    reply.header("x-cache", "miss");
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    return reply.send(responseBody);
    
  } catch (error) {
    app.log.error({ error, venue, tokens }, 'Price history fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /orderbook/{tokenId}
 * Get order book summary for a specific token
 * Rate limit: 200 requests/10s
 */
app.get("/orderbook/:tokenId", async (request, reply) => {
  const { tokenId } = request.params as { tokenId: string };
  
  if (!tokenId) {
    reply.code(400);
    return reply.send({ error: "tokenId parameter is required" });
  }
  
  // Check client rate limiting
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `orderbook:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  // Create cache key
  const cacheKey = `orderbook:${tokenId}`;
  const r = await getRedis();
  
  // Check cache first (5-second cache for order book data)
  if (r) {
    const cachedData = await r.get(cacheKey);
    if (cachedData) {
      reply.header("x-cache", "hit");
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=5, stale-while-revalidate=10");
      return reply.send(cachedData);
    }
  }
  
  try {
    const orderBook = await polymarketClient.getOrderBook(tokenId);
    
    const response = {
      tokenId,
      data: orderBook,
      timestamp: new Date().toISOString(),
    };
    
    const responseBody = JSON.stringify(response);
    
    // Cache for 5 seconds
    if (r) {
      await r.set(cacheKey, responseBody, { EX: 5 });
      reply.header("x-cache", "miss");
    }
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=5, stale-while-revalidate=10");
    return reply.send(responseBody);
    
  } catch (error) {
    app.log.error({ error, tokenId }, 'Order book fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /orderbook/batch
 * Get order book summaries for multiple tokens
 * Rate limit: 80 requests/10s
 */
app.post("/orderbook/batch", async (request, reply) => {
  const body = request.body as { tokenIds: string[] };
  
  if (!body.tokenIds || !Array.isArray(body.tokenIds) || body.tokenIds.length === 0) {
    reply.code(400);
    return reply.send({ error: "tokenIds array is required" });
  }
  
  if (body.tokenIds.length > 50) {
    reply.code(400);
    return reply.send({ error: "Maximum 50 tokens per request" });
  }
  
  // Check client rate limiting
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `orderbook-batch:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 50, 60000); // 50 requests per minute per client
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  try {
    const orderBooks = await polymarketClient.getOrderBooksBatch(body.tokenIds);
    
    const response = {
      tokenIds: body.tokenIds,
      data: orderBooks,
      timestamp: new Date().toISOString(),
    };
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=5, stale-while-revalidate=10");
    return reply.send(JSON.stringify(response));
    
  } catch (error) {
    app.log.error({ error, tokenIds: body.tokenIds }, 'Order books batch fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /price/{tokenId}
 * Query: side (BUY or SELL)
 * Get current price for a specific token and side
 * Rate limit: 200 requests/10s
 */
app.get("/price/:tokenId", async (request, reply) => {
  const { tokenId } = request.params as { tokenId: string };
  const q = request.query as { side?: string };
  
  if (!tokenId) {
    reply.code(400);
    return reply.send({ error: "tokenId parameter is required" });
  }
  
  if (!q.side || !['BUY', 'SELL'].includes(q.side.toUpperCase())) {
    reply.code(400);
    return reply.send({ error: "side parameter is required and must be 'BUY' or 'SELL'" });
  }
  
  const side = q.side.toUpperCase() as 'BUY' | 'SELL';
  
  // Check client rate limiting
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `price:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 100, 60000);
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  // Create cache key including side
  const cacheKey = `price:${tokenId}:${side}`;
  const r = await getRedis();
  
  // Check cache first (1-second cache for price data)
  if (r) {
    const cachedData = await r.get(cacheKey);
    if (cachedData) {
      reply.header("x-cache", "hit");
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=1, stale-while-revalidate=5");
      return reply.send(cachedData);
    }
  }
  
  try {
    const price = await polymarketClient.getPrice(tokenId, side);
    
    const response = {
      tokenId,
      side,
      data: price,
      timestamp: new Date().toISOString(),
    };
    
    const responseBody = JSON.stringify(response);
    
    // Cache for 1 second
    if (r) {
      await r.set(cacheKey, responseBody, { EX: 1 });
      reply.header("x-cache", "miss");
    }
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=1, stale-while-revalidate=5");
    return reply.send(responseBody);
    
  } catch (error) {
    app.log.error({ error, tokenId, side }, 'Price fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /price/batch
 * Get current prices for multiple tokens with sides
 * Rate limit: 80 requests/10s
 */
app.post("/price/batch", async (request, reply) => {
  const body = request.body as { requests: Array<{token_id: string, side: string}> };
  
  if (!body.requests || !Array.isArray(body.requests) || body.requests.length === 0) {
    reply.code(400);
    return reply.send({ error: "requests array is required with token_id and side" });
  }
  
  if (body.requests.length > 50) {
    reply.code(400);
    return reply.send({ error: "Maximum 50 requests per batch" });
  }
  
  // Validate each request
  for (const req of body.requests) {
    if (!req.token_id || !req.side || !['BUY', 'SELL'].includes(req.side.toUpperCase())) {
      reply.code(400);
      return reply.send({ error: "Each request must have token_id and side (BUY or SELL)" });
    }
  }
  
  // Normalize sides to uppercase
  const normalizedRequests = body.requests.map(req => ({
    token_id: req.token_id,
    side: req.side.toUpperCase() as 'BUY' | 'SELL'
  }));
  
  // Check client rate limiting
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `price-batch:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 50, 60000);
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  try {
    const prices = await polymarketClient.getPricesBatch(normalizedRequests);
    
    const response = {
      requests: normalizedRequests,
      data: prices,
      timestamp: new Date().toISOString(),
    };
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=1, stale-while-revalidate=5");
    return reply.send(JSON.stringify(response));
    
  } catch (error) {
    app.log.error({ error, requests: normalizedRequests }, 'Prices batch fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /midpoint/{tokenId}
 * Get midpoint price for a specific token
 * Rate limit: 200 requests/10s
 */
app.get("/midpoint/:tokenId", async (request, reply) => {
  const { tokenId } = request.params as { tokenId: string };
  
  if (!tokenId) {
    reply.code(400);
    return reply.send({ error: "tokenId parameter is required" });
  }
  
  // Check client rate limiting
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `midpoint:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 100, 60000);
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  // Create cache key
  const cacheKey = `midpoint:${tokenId}`;
  const r = await getRedis();
  
  // Check cache first (1-second cache)
  if (r) {
    const cachedData = await r.get(cacheKey);
    if (cachedData) {
      reply.header("x-cache", "hit");
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=1, stale-while-revalidate=5");
      return reply.send(cachedData);
    }
  }
  
  try {
    const midpoint = await polymarketClient.getMidpointPrice(tokenId);
    
    const response = {
      tokenId,
      data: midpoint,
      timestamp: new Date().toISOString(),
    };
    
    const responseBody = JSON.stringify(response);
    
    // Cache for 1 second
    if (r) {
      await r.set(cacheKey, responseBody, { EX: 1 });
      reply.header("x-cache", "miss");
    }
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=1, stale-while-revalidate=5");
    return reply.send(responseBody);
    
  } catch (error) {
    app.log.error({ error, tokenId }, 'Midpoint price fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /spreads
 * Get bid-ask spreads for multiple tokens
 * Rate limit: 200 requests/10s
 */
app.post("/spreads", async (request, reply) => {
  const body = request.body as { tokenIds: string[] };
  
  if (!body.tokenIds || !Array.isArray(body.tokenIds) || body.tokenIds.length === 0) {
    reply.code(400);
    return reply.send({ error: "tokenIds array is required" });
  }
  
  if (body.tokenIds.length > 50) {
    reply.code(400);
    return reply.send({ error: "Maximum 50 tokens per request" });
  }
  
  // Check client rate limiting
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `spreads:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 100, 60000);
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  try {
    const spreads = await polymarketClient.getSpreadsBatch(body.tokenIds);
    
    const response = {
      tokenIds: body.tokenIds,
      data: spreads,
      timestamp: new Date().toISOString(),
    };
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=1, stale-while-revalidate=5");
    return reply.send(JSON.stringify(response));
    
  } catch (error) {
    app.log.error({ error, tokenIds: body.tokenIds }, 'Spreads fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
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
