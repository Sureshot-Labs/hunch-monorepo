import Fastify from "fastify";
import crypto from "node:crypto";
import { pool } from "./db.js";
import { env } from "./env.js";
import { getRedis } from "./redis.js";
import { onReqStart, onReqEnd, getMetrics } from "./metrics.js";
import { AuthService, createAuthMiddleware, User, UserWallet, PolymarketCredentials } from "./auth.js";
import { PrivyService } from "./privy-service.js";
import { VenueOrderManagerFactory } from "./venue-order-manager-factory.js";
import { PlaceOrderRequest, OrderStatus } from "./order-types.js";

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
          result = await this.makeRequest('/price-history', params);
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
    const requestPromise = polymarketRateLimiter.queueRequest(tokenId, { 
      endpoint: '/price-history',
      params: new URLSearchParams({ market: tokenId, interval: 'max' })
    });
    
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
 *  - venue?: string ("polymarket" | "kalshi" | "limitless")
 *  - category?: string (exact match)
 *  - sort?: string ("totalvol", "liquidity", default: "trending")
 *
 * Default sorting uses trending algorithm: 40% volume + 30% liquidity + 20% new events + 10% ending soon
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

  const cacheKey = `feed:v8:${limit}:${offset}:${minVol}:${minLiquidity}:${
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
    eventWhere.push(`lower(e.venue) = $${paramIdx++}`);
  }
  if (category) {
    eventParams.push(category);
    eventWhere.push(`e.category = $${paramIdx++}`);
  }

  // Filtering logic (filter param)
  if (filter === "newest") {
    eventWhere.push(`e.start_date >= now() - interval '7 days'`);
  } else if (filter === "endingsoon") {
    eventWhere.push(`e.end_date <= now() + interval '7 days'`);
  }
  // if filter is not present, do not apply any filter

  // Always exclude expired events
  eventWhere.push("(e.end_date IS NULL OR e.end_date > now())");

  // Sorting logic (sort param)
  let eventOrder = "";
  if (sort === "totalvol") eventOrder = "e.volume_total desc nulls last, e.id";
  else if (sort === "liquidity")
    eventOrder = "e.liquidity desc nulls last, e.id";
  else if (filter === "newest") {
    // When filtering by newest, sort by start_date descending (newest first)
    eventOrder = "e.start_date desc nulls last, e.id";
  } else if (filter === "endingsoon") {
    // When filtering by ending soon, sort by end_date ascending (ending soonest first)
    eventOrder = "e.end_date asc nulls last, e.id";
  } else if (sort == null) {
    // Trending algorithm: combines volume, liquidity, and recency
    eventOrder = `
      (coalesce(e.volume_24h, 0) * 0.4 + 
       coalesce(e.liquidity, 0) * 0.3 + 
       case when e.start_date >= now() - interval '7 days' then 1000 else 0 end * 0.2 +
       case when e.end_date <= now() + interval '7 days' then 500 else 0 end * 0.1
      ) desc nulls last, e.id
    `;
  } else eventOrder = "e.start_date desc nulls last, e.id"; // fallback

  // Aggregate volume/liquidity for events
  const eventSql = `
    select
      e.id,
      sum(coalesce(m.volume_24h, 0)) as total_volume,
      sum(coalesce(m.liquidity, 0)) as total_liquidity,
      e.start_date,
      e.end_date
    from unified_events e
    join unified_markets m on m.event_id = e.id
    ${eventWhere.length ? "where " + eventWhere.join(" and ") : ""}
    group by e.id, e.start_date, e.end_date
    having (sum(coalesce(m.volume_24h, 0)) >= $${paramIdx++} or sum(m.volume_24h) is null)
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
    "(coalesce(m.volume_24h, 0) >= $1 or m.volume_24h is null)",
    "coalesce(m.liquidity, 0) >= $2",
    "m.status = 'ACTIVE'",
    `m.event_id = ANY($3::text[])`,
    // Add expiration filter: exclude markets past their expiration time
    "(m.expiration_time IS NULL OR m.expiration_time > now()) AND (m.close_time IS NULL OR m.close_time > now())",
  ];

  // Sorting for markets: use same sort as for events, or none
  let marketOrder = "";
  if (sort === "totalvol")
    marketOrder = "m.volume_24h desc nulls last, m.venue_market_id";
  else if (sort === "liquidity")
    marketOrder = "m.liquidity desc nulls last, m.venue_market_id";
  else if (filter === "newest") {
    // When filtering by newest, sort by event start_date descending (newest first)
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  } else if (filter === "endingsoon") {
    // When filtering by ending soon, sort by event end_date ascending (ending soonest first)
    marketOrder = "e.end_date asc nulls last, m.venue_market_id";
  } else if (sort == null) {
    // Trending algorithm for markets: combines volume, liquidity, and recency
    marketOrder = `
      (coalesce(m.volume_24h, 0) * 0.4 + 
       coalesce(m.liquidity, 0) * 0.3 + 
       case when e.start_date >= now() - interval '7 days' then 1000 else 0 end * 0.2 +
       case when e.end_date <= now() + interval '7 days' then 500 else 0 end * 0.1
      ) desc nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id"; // fallback

  const marketSql = `
    select
      e.id as event_id,
      e.title as event_title,
      e.category,
      e.start_date,
      e.end_date,
      e.liquidity as event_liquidity,
      e.volume_total as event_volume,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      m.id as market_uuid,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      m.last_price,
      m.token_yes,
      m.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.updated_at as last_update
    from unified_events e
    join unified_markets m on m.event_id = e.id
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
        startTime: r.start_date,
        endTime: r.end_date,
        eventLiquidity:
          r.event_liquidity != null ? Number(r.event_liquidity) : 0,
        eventVolume: r.event_volume != null ? Number(r.event_volume) : 0,
        eventOpenInterest: r.event_open_interest != null ? Number(r.event_open_interest) : 0,
        eventSlug: r.event_slug,
        markets: [],
      };
    }
    // Parse token IDs based on venue
    let tokens = { yes: null, no: null };
    if (r.venue === 'polymarket' && r.clob_token_ids) {
      try {
        const tokenIds = JSON.parse(r.clob_token_ids);
        tokens = {
          yes: tokenIds[0] || null,
          no: tokenIds[1] || null
        };
      } catch (error) {
        // Invalid JSON, keep tokens as null
      }
    } else if (r.venue === 'limitless' || r.venue === 'kalshi') {
      tokens = {
        yes: r.token_yes,
        no: r.token_no
      };
    }

    eventMap[eid].markets.push({
      venue: r.venue,
      marketId: r.venue_market_id,
      marketTitle: r.market_title,
      marketSlug: r.market_slug,
      volume24h: r.volume_24h != null ? Number(r.volume_24h) : 0,
      volumeTotal: r.volume_total != null ? Number(r.volume_total) : 0,
      openInterest: r.open_interest != null ? Number(r.open_interest) : 0,
      liquidity: r.liquidity != null ? Number(r.liquidity) : 0,
      acceptingOrders: true, // Always true for active markets in unified table
      tokens,
      conditionId: r.condition_id || null,
      top: {
        yesBid: r.best_bid != null ? Number(r.best_bid) : null,
        yesAsk: r.best_ask != null ? Number(r.best_ask) : null,
        noBid: r.best_bid != null ? Number(1 - r.best_bid) : null, // Calculate no bid from yes bid
        noAsk: r.best_ask != null ? Number(1 - r.best_ask) : null, // Calculate no ask from yes ask
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
        eventOpenInterest: 0,
        eventSlug: null,
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
 * GET /markets/:marketId
 * Get detailed information for a specific market
 */
app.get("/markets/:marketId", async (request, reply) => {
  const { marketId } = request.params as { marketId: string };
  
  if (!marketId) {
    reply.code(400);
    return reply.send({ error: "marketId parameter is required" });
  }
  
  // Check client rate limiting
  const clientIp = request.ip || 'unknown';
  const rateLimitKey = `market:${clientIp}`;
  const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client
  
  if (!canProceed) {
    reply.code(429);
    return reply.send({ error: "Client rate limit exceeded. Please try again later." });
  }
  
  // Create cache key
  const cacheKey = `market:${marketId}`;
  const r = await getRedis();
  
  // Check cache first (30-second cache for market data)
  if (r) {
    const cachedData = await r.get(cacheKey);
    if (cachedData) {
      reply.header("x-cache", "hit");
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
      return reply.send(cachedData);
    }
  }
  
  try {
    // Query for market details with event information
    const marketSql = `
      SELECT
        e.id as event_id,
        e.title as event_title,
        e.description as event_description,
        e.category,
        e.start_date,
        e.end_date,
        e.liquidity as event_liquidity,
        e.volume_total as event_volume,
        m.id as market_id,
        m.venue,
        m.venue_market_id,
        m.title as market_title,
        m.description as market_description,
        m.market_type,
        m.open_time,
        m.close_time,
        m.expiration_time,
        m.volume_24h,
        m.liquidity,
        m.best_bid,
        m.best_ask,
        m.last_price,
        m.outcomes,
        m.token_yes,
        m.token_no,
        m.clob_token_ids,
        m.condition_id,
        m.created_at,
        m.updated_at
      FROM unified_events e
      JOIN unified_markets m ON m.event_id = e.id
      WHERE m.id = $1 OR m.venue_market_id = $1
    `;
    
    const { rows } = await pool.query(marketSql, [marketId]);
    
    if (rows.length === 0) {
      reply.code(404);
      return reply.send({ error: "Market not found" });
    }
    
    const market = rows[0];
    
    // Parse token IDs based on venue
    let tokens = { yes: null, no: null };
    if (market.venue === 'polymarket' && market.clob_token_ids) {
      try {
        const tokenIds = JSON.parse(market.clob_token_ids);
        tokens = {
          yes: tokenIds[0] || null,
          no: tokenIds[1] || null
        };
      } catch (error) {
        // Invalid JSON, keep tokens as null
      }
    } else if (market.venue === 'limitless' || market.venue === 'kalshi') {
      tokens = {
        yes: market.token_yes,
        no: market.token_no
      };
    }
    
    // Parse outcomes if available
    let outcomes = null;
    if (market.outcomes) {
      try {
        outcomes = JSON.parse(market.outcomes);
      } catch (error) {
        // Invalid JSON, keep outcomes as null
      }
    }
    
    const response = {
      marketId: market.market_id,
      venue: market.venue,
      venueMarketId: market.venue_market_id,
      marketTitle: market.market_title,
      marketDescription: market.market_description,
      marketType: market.market_type,
      openTime: market.open_time,
      closeTime: market.close_time,
      expirationTime: market.expiration_time,
      volume24h: market.volume_24h != null ? Number(market.volume_24h) : 0,
      liquidity: market.liquidity != null ? Number(market.liquidity) : 0,
      bestBid: market.best_bid != null ? Number(market.best_bid) : null,
      bestAsk: market.best_ask != null ? Number(market.best_ask) : null,
      lastPrice: market.last_price != null ? Number(market.last_price) : null,
      outcomes,
      tokens,
      conditionId: market.condition_id || null,
      createdAt: market.created_at,
      updatedAt: market.updated_at,
      event: {
        eventId: market.event_id,
        eventTitle: market.event_title,
        eventDescription: market.event_description,
        category: market.category,
        startTime: market.start_date,
        endTime: market.end_date,
        eventLiquidity: market.event_liquidity != null ? Number(market.event_liquidity) : 0,
        eventVolume: market.event_volume != null ? Number(market.event_volume) : 0,
      }
    };
    
    const responseBody = JSON.stringify(response);
    
    // Cache for 30 seconds
    if (r) {
      await r.set(cacheKey, responseBody, { EX: 30 });
      reply.header("x-cache", "miss");
    }
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    reply.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return reply.send(responseBody);
    
  } catch (error) {
    app.log.error({ error, marketId }, 'Market details fetch failed');
    reply.code(500);
    return reply.send({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
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

// ============================================================================
// PHASE 2: AUTHENTICATION & USER MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * POST /auth/privy
 * Authenticate user using Privy access token
 */
app.post("/auth/privy", async (request, reply) => {
  const body = request.body as { accessToken: string };
  
  if (!body.accessToken) {
    reply.code(400);
    return reply.send({ error: "accessToken is required" });
  }
  
  const clientIp = request.ip || 'unknown';
  const userAgent = request.headers['user-agent'] || 'unknown';
  
  try {
    // Verify Privy access token and get user data
    const { claims, user: privyUser, walletAddresses, primaryWalletAddress } = await PrivyService.verifyTokenAndGetUser(body.accessToken);
    
    if (!primaryWalletAddress) {
      reply.code(400);
      return reply.send({ error: "No wallet address found in Privy user data" });
    }
    
    // Create or update user in our database
    const user = await AuthService.createOrUpdateUserFromPrivy(privyUser, claims);
    
    // Generate session token
    const sessionToken = AuthService.generateToken(user.id, primaryWalletAddress);
    
    // Create session
    const session = await AuthService.createSession(
      user.id,
      sessionToken,
      primaryWalletAddress,
      clientIp,
      userAgent
    );
    
    // Record successful authentication
    await AuthService.recordAuthAttempt(
      primaryWalletAddress,
      'privy-auth',
      true,
      clientIp,
      userAgent
    );
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isActive: user.isActive,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      session: {
        token: sessionToken,
        expiresAt: session.expiresAt,
      },
      walletAddresses,
      primaryWalletAddress,
      privyUserId: privyUser.id,
    });
    
  } catch (error) {
    app.log.error({ error }, 'Privy authentication failed');
    
    // Record failed authentication attempt
    await AuthService.recordAuthAttempt(
      'unknown',
      'privy-auth',
      false,
      clientIp,
      userAgent,
      error instanceof Error ? error.message : 'Unknown error'
    );
    
    reply.code(401);
    return reply.send({ 
      error: 'Authentication failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /auth/logout
 * Logout user and invalidate session
 */
app.post("/auth/logout", async (request, reply) => {
  const authHeader = request.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401);
    return reply.send({ error: 'Missing or invalid authorization header' });
  }
  
  const token = authHeader.substring(7);
  
  try {
    await AuthService.invalidateSession(token);
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({ message: 'Successfully logged out' });
    
  } catch (error) {
    app.log.error({ error }, 'Logout failed');
    reply.code(500);
    return reply.send({ 
      error: 'Logout failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /auth/me
 * Get current user information
 */
app.get("/auth/me", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  
  try {
    // Get user wallets
    const wallets = await AuthService.getUserWallets(user.id);
    
    // Get Polymarket credentials
    const polymarketCreds = await AuthService.getPolymarketCredentials(user.id, walletAddress);
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        isActive: user.isActive,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      },
      wallets: wallets.map(w => ({
        id: w.id,
        walletAddress: w.walletAddress,
        walletType: w.walletType,
        isPrimary: w.isPrimary,
        isVerified: w.isVerified,
        createdAt: w.createdAt,
      })),
      polymarketCredentials: polymarketCreds ? {
        id: polymarketCreds.id,
        walletAddress: polymarketCreds.walletAddress,
        isActive: polymarketCreds.isActive,
        createdAt: polymarketCreds.createdAt,
        lastUsedAt: polymarketCreds.lastUsedAt,
      } : null,
      currentWallet: walletAddress,
    });
    
  } catch (error) {
    app.log.error({ error, userId: user.id }, 'Get user info failed');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to get user information',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /auth/venue-credentials
 * Set API credentials for any venue (Polymarket, Kalshi, Limitless)
 */
app.post("/auth/venue-credentials", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  const body = request.body as {
    venue: 'polymarket' | 'kalshi' | 'limitless';
    apiKey: string;
    apiSecret: string;
    additionalData?: any; // For venue-specific data
  };
  
  if (!body.venue || !body.apiKey || !body.apiSecret) {
    reply.code(400);
    return reply.send({ error: "venue, apiKey and apiSecret are required" });
  }
  
  if (!['polymarket', 'kalshi', 'limitless'].includes(body.venue)) {
    reply.code(400);
    return reply.send({ error: "venue must be one of: polymarket, kalshi, limitless" });
  }
  
  try {
    const credentials = await AuthService.createOrUpdateVenueCredentials(
      user.id,
      walletAddress,
      body.venue,
      body.apiKey,
      body.apiSecret,
      body.additionalData
    );
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      message: `${body.venue} credentials updated successfully`,
      credentials: {
        id: credentials.id,
        venue: credentials.venue,
        walletAddress: credentials.walletAddress,
        isActive: credentials.isActive,
        createdAt: credentials.createdAt,
        lastUsedAt: credentials.lastUsedAt,
      },
    });
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress, venue: body.venue }, 'Failed to update venue credentials');
    reply.code(500);
    return reply.send({ 
      error: `Failed to update ${body.venue} credentials`,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /auth/venue-credentials
 * Get all venue credentials for user
 */
app.get("/auth/venue-credentials", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  
  try {
    const credentials = await AuthService.getAllVenueCredentials(user.id, walletAddress);
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      credentials: credentials.map(c => ({
        id: c.id,
        venue: c.venue,
        walletAddress: c.walletAddress,
        isActive: c.isActive,
        createdAt: c.createdAt,
        lastUsedAt: c.lastUsedAt,
        additionalData: c.additionalData,
      })),
    });
    
  } catch (error) {
    app.log.error({ error, userId: user.id }, 'Failed to get venue credentials');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to get venue credentials',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /auth/polymarket-credentials
 * Set Polymarket API credentials for user (backward compatibility)
 */
app.post("/auth/polymarket-credentials", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  const body = request.body as {
    apiKey: string;
    apiSecret: string;
  };
  
  if (!body.apiKey || !body.apiSecret) {
    reply.code(400);
    return reply.send({ error: "apiKey and apiSecret are required" });
  }
  
  try {
    const credentials = await AuthService.createOrUpdatePolymarketCredentials(
      user.id,
      walletAddress,
      body.apiKey,
      body.apiSecret
    );
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      message: 'Polymarket credentials updated successfully',
      credentials: {
        id: credentials.id,
        venue: 'polymarket',
        walletAddress: credentials.walletAddress,
        isActive: credentials.isActive,
        createdAt: credentials.createdAt,
        lastUsedAt: credentials.lastUsedAt,
      },
    });
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress }, 'Failed to update Polymarket credentials');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to update Polymarket credentials',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /auth/wallets
 * Get user's wallets
 */
app.get("/auth/wallets", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  
  try {
    const wallets = await AuthService.getUserWallets(user.id);
    
    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send({
      wallets: wallets.map(w => ({
        id: w.id,
        walletAddress: w.walletAddress,
        walletType: w.walletType,
        isPrimary: w.isPrimary,
        isVerified: w.isVerified,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
    });
    
  } catch (error) {
    app.log.error({ error, userId: user.id }, 'Failed to get user wallets');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to get user wallets',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /auth/wallets
 * Add a new wallet to user account
 */
app.post("/auth/wallets", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const body = request.body as {
    walletAddress: string;
    walletType?: string;
    verificationSignature?: string;
  };
  
  if (!body.walletAddress) {
    reply.code(400);
    return reply.send({ error: "walletAddress is required" });
  }
  
  // Basic wallet address validation
  if (!/^0x[a-fA-F0-9]{40}$/.test(body.walletAddress)) {
    reply.code(400);
    return reply.send({ error: "Invalid wallet address format" });
  }
  
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Check if wallet already exists
      const existingWallet = await client.query(
        'SELECT id FROM user_wallets WHERE wallet_address = $1',
        [body.walletAddress]
      );
      
      if (existingWallet.rows.length > 0) {
        reply.code(409);
        return reply.send({ error: "Wallet address already exists" });
      }
      
      // Add new wallet
      const result = await client.query(
        `INSERT INTO user_wallets (user_id, wallet_address, wallet_type, is_primary, is_verified, verification_signature) 
         VALUES ($1, $2, $3, false, $4, $5) 
         RETURNING id, user_id, wallet_address, wallet_type, is_primary, is_verified, created_at, updated_at`,
        [
          user.id,
          body.walletAddress,
          body.walletType || 'ethereum',
          !!body.verificationSignature,
          body.verificationSignature || null,
        ]
      );
      
      await client.query('COMMIT');
      
      const newWallet = result.rows[0];
      
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        message: 'Wallet added successfully',
        wallet: {
          id: newWallet.id,
          walletAddress: newWallet.wallet_address,
          walletType: newWallet.wallet_type,
          isPrimary: newWallet.is_primary,
          isVerified: newWallet.is_verified,
          createdAt: newWallet.created_at,
          updatedAt: newWallet.updated_at,
        },
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress: body.walletAddress }, 'Failed to add wallet');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to add wallet',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ============================================================================
// ORDER MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * POST /orders
 * Place a new order
 */
app.post("/orders", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  const body = request.body as PlaceOrderRequest & { 
    venue: 'polymarket' | 'kalshi' | 'limitless';
    l1Signature?: string;
    l1Timestamp?: string;
    l1Nonce?: string;
  };
  
  // Extract L1 authentication headers from request headers
  const l1Headers = {
    l1Signature: request.headers['poly_signature'] as string,
    l1Timestamp: request.headers['poly_timestamp'] as string,
    l1Nonce: request.headers['poly_nonce'] as string,
  };
  
  // Validate required fields
  if (!body.venue) {
    reply.code(400);
    return reply.send({ error: "venue is required" });
  }
  
  if (!body.tokenId) {
    reply.code(400);
    return reply.send({ error: "tokenId is required" });
  }
  
  if (!body.side || !['BUY', 'SELL'].includes(body.side)) {
    reply.code(400);
    return reply.send({ error: "Valid side (BUY/SELL) is required" });
  }
  
  if (!body.orderType || !['GTC', 'GTD', 'FAK', 'FOK'].includes(body.orderType)) {
    reply.code(400);
    return reply.send({ error: "Valid order type (GTC/GTD/FAK/FOK) is required" });
  }
  
  if (!body.price || body.price <= 0) {
    reply.code(400);
    return reply.send({ error: "Valid price is required" });
  }
  
  if (!body.size || body.size <= 0) {
    reply.code(400);
    return reply.send({ error: "Valid size is required" });
  }
  
  try {
    const result = await VenueOrderManagerFactory.placeOrder(
      body.venue,
      user.id,
      walletAddress,
      request.headers,
      {
        tokenId: body.tokenId,
        side: body.side,
        orderType: body.orderType,
        price: body.price,
        size: body.size,
        expiresAt: body.expiresAt,
        l1Signature: l1Headers.l1Signature || body.l1Signature,
        l1Timestamp: l1Headers.l1Timestamp || body.l1Timestamp,
        l1Nonce: l1Headers.l1Nonce || body.l1Nonce,
      }
    );
    
    if (result.success) {
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        message: 'Order placed successfully',
        orderId: result.orderId,
        venueOrderId: result.venueOrderId,
        status: result.status,
      });
    } else {
      reply.code(400);
      return reply.send({
        error: result.errorMessage || 'Failed to place order',
        rawError: result.rawError,
      });
    }
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress, body }, 'Failed to place order');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to place order',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /orders
 * Get active orders for the user
 */
app.get("/orders", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  const query = request.query as { venue?: 'polymarket' | 'kalshi' | 'limitless' };
  
  try {
    if (query.venue) {
      // Get orders for specific venue
      const result = await VenueOrderManagerFactory.getActiveOrders(
        query.venue,
        user.id,
        walletAddress
      );
      
      if (result.success) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          orders: result.orders,
          venue: query.venue,
        });
      } else {
        reply.code(400);
        return reply.send({
          error: result.errorMessage || 'Failed to fetch orders',
        });
      }
    } else {
      // Get orders for all venues
      const allOrders = [];
      
      for (const venue of ['polymarket', 'kalshi', 'limitless'] as const) {
        try {
          const result = await VenueOrderManagerFactory.getActiveOrders(
            venue,
            user.id,
            walletAddress
          );
          
          if (result.success) {
            allOrders.push(...result.orders);
          }
        } catch (error) {
          app.log.warn({ error, venue, userId: user.id }, `Failed to fetch orders for ${venue}`);
        }
      }
      
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        orders: allOrders,
      });
    }
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress }, 'Failed to fetch orders');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to fetch orders',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /orders/:id
 * Get specific order details
 */
app.get("/orders/:id", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  const params = request.params as { id: string };
  const query = request.query as { venue?: 'polymarket' | 'kalshi' | 'limitless' };
  
  try {
    // First try to get order from database to determine venue
    const client = await pool.connect();
    try {
      const orderResult = await client.query(
        'SELECT venue FROM orders WHERE id = $1 AND user_id = $2',
        [params.id, user.id]
      );
      
      if (orderResult.rows.length === 0) {
        reply.code(404);
        return reply.send({ error: 'Order not found' });
      }
      
      const venue = orderResult.rows[0].venue as 'polymarket' | 'kalshi' | 'limitless';
      
      const result = await VenueOrderManagerFactory.getOrder(
        venue,
        user.id,
        walletAddress,
        params.id
      );
      
      if (result.success) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          order: result.order,
        });
      } else {
        reply.code(400);
        return reply.send({
          error: result.errorMessage || 'Failed to fetch order',
        });
      }
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress, orderId: params.id }, 'Failed to fetch order');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to fetch order',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * DELETE /orders/:id
 * Cancel an order
 */
app.delete("/orders/:id", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  const params = request.params as { id: string };
  
  try {
    // First get order from database to determine venue
    const client = await pool.connect();
    try {
      const orderResult = await client.query(
        'SELECT venue FROM orders WHERE id = $1 AND user_id = $2',
        [params.id, user.id]
      );
      
      if (orderResult.rows.length === 0) {
        reply.code(404);
        return reply.send({ error: 'Order not found' });
      }
      
      const venue = orderResult.rows[0].venue as 'polymarket' | 'kalshi' | 'limitless';
      
      const result = await VenueOrderManagerFactory.cancelOrder(
        venue,
        user.id,
        walletAddress,
        params.id
      );
      
      if (result.success) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: 'Order cancelled successfully',
        });
      } else {
        reply.code(400);
        return reply.send({
          error: result.errorMessage || 'Failed to cancel order',
          rawError: result.rawError,
        });
      }
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress, orderId: params.id }, 'Failed to cancel order');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to cancel order',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /orders/history
 * Get order history for the user
 */
app.get("/orders/history", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const query = request.query as { 
    venue?: 'polymarket' | 'kalshi' | 'limitless';
    status?: OrderStatus;
    limit?: number;
    offset?: number;
  };
  
  try {
    const client = await pool.connect();
    try {
      let whereClause = 'WHERE user_id = $1';
      const params: any[] = [user.id];
      let paramCount = 1;
      
      if (query.venue) {
        paramCount++;
        whereClause += ` AND venue = $${paramCount}`;
        params.push(query.venue);
      }
      
      if (query.status) {
        paramCount++;
        whereClause += ` AND status = $${paramCount}`;
        params.push(query.status);
      }
      
      const limit = Math.min(query.limit || 50, 100); // Max 100 orders
      const offset = query.offset || 0;
      
      const result = await client.query(`
        SELECT 
          id, user_id, venue, venue_order_id, token_id, side, order_type,
          price, size, status, filled_size, average_fill_price,
          expires_at, created_at, updated_at, filled_at, cancelled_at,
          error_message, raw_error
        FROM orders 
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
      `, [...params, limit, offset]);
      
      const orders = result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        venue: row.venue,
        venueOrderId: row.venue_order_id,
        tokenId: row.token_id,
        side: row.side,
        orderType: row.order_type,
        price: parseFloat(row.price),
        size: parseFloat(row.size),
        status: row.status,
        filledSize: parseFloat(row.filled_size || '0'),
        averageFillPrice: row.average_fill_price ? parseFloat(row.average_fill_price) : null,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        filledAt: row.filled_at,
        cancelledAt: row.cancelled_at,
        errorMessage: row.error_message,
        rawError: row.raw_error,
      }));
      
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        orders,
        pagination: {
          limit,
          offset,
          hasMore: orders.length === limit,
        },
      });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    app.log.error({ error, userId: user.id }, 'Failed to fetch order history');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to fetch order history',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /positions
 * Get user positions
 */
app.get("/positions", { preHandler: createAuthMiddleware() }, async (request, reply) => {
  const user = (request as any).user as User;
  const walletAddress = (request as any).walletAddress as string;
  const query = request.query as { venue?: 'polymarket' | 'kalshi' | 'limitless' };
  
  try {
    if (query.venue) {
      // Get positions for specific venue
      const result = await VenueOrderManagerFactory.getPositions(
        query.venue,
        user.id,
        walletAddress
      );
      
      if (result.success) {
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          positions: result.positions,
          venue: query.venue,
        });
      } else {
        reply.code(400);
        return reply.send({
          error: result.errorMessage || 'Failed to fetch positions',
        });
      }
    } else {
      // Get positions for all venues
      const allPositions = [];
      
      for (const venue of ['polymarket', 'kalshi', 'limitless'] as const) {
        try {
          const result = await VenueOrderManagerFactory.getPositions(
            venue,
            user.id,
            walletAddress
          );
          
          if (result.success) {
            allPositions.push(...result.positions);
          }
        } catch (error) {
          app.log.warn({ error, venue, userId: user.id }, `Failed to fetch positions for ${venue}`);
        }
      }
      
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        positions: allPositions,
      });
    }
    
  } catch (error) {
    app.log.error({ error, userId: user.id, walletAddress }, 'Failed to fetch positions');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to fetch positions',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /orders/store
 * Store order data after user performs the order on frontend
 * This API stores the orderID with walletAddress for tracking purposes
 */
app.post("/orders/store", async (request, reply) => {
  const body = request.body as {
    walletAddress: string;
    orderID: string;
    takingAmount?: string;
    makingAmount?: string;
    status?: string;
    success?: boolean;
    errorMsg?: string;
    venue?: string;
    tokenId?: string;
    side?: string;
    price?: number;
    size?: number;
  };
  
  // Validate required fields
  if (!body.walletAddress) {
    reply.code(400);
    return reply.send({ error: "walletAddress is required" });
  }
  
  if (!body.orderID) {
    reply.code(400);
    return reply.send({ error: "orderID is required" });
  }
  
  // Basic wallet address validation
  if (!/^0x[a-fA-F0-9]{40}$/.test(body.walletAddress)) {
    reply.code(400);
    return reply.send({ error: "Invalid wallet address format" });
  }
  
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Check if user exists for this wallet address
      const userResult = await client.query(
        `SELECT u.id FROM users u 
         JOIN user_wallets uw ON u.id = uw.user_id 
         WHERE uw.wallet_address = $1`,
        [body.walletAddress]
      );
      
      if (userResult.rows.length === 0) {
        reply.code(404);
        return reply.send({ error: "User not found for this wallet address" });
      }
      
      const userId = userResult.rows[0].id;
      
      // Check if order already exists
      const existingOrder = await client.query(
        'SELECT id FROM orders WHERE venue_order_id = $1 AND user_id = $2',
        [body.orderID, userId]
      );
      
      if (existingOrder.rows.length > 0) {
        reply.code(409);
        return reply.send({ error: "Order already exists" });
      }
      
      // Insert new order record
      const result = await client.query(
        `INSERT INTO orders (
          id, user_id, venue, venue_order_id, token_id, side, order_type,
          price, size, status, filled_size, error_message, raw_error,
          posted_at, last_update
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, 'GTC', $6, $7, $8, 0, $9, $10,
          now(), now()
        ) RETURNING id, venue_order_id, status, posted_at`,
        [
          userId,
          body.venue || 'polymarket',
          body.orderID,
          body.tokenId || null,
          body.side || null,
          body.price || null,
          body.size || null,
          body.status || 'live',
          body.errorMsg || null,
          body.success === false ? JSON.stringify(body) : null
        ]
      );
      
      await client.query('COMMIT');
      
      const newOrder = result.rows[0];
      
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        message: 'Order stored successfully',
        order: {
          id: newOrder.id,
          orderID: newOrder.venue_order_id,
          status: newOrder.status,
          storedAt: newOrder.posted_at,
        },
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    
  } catch (error) {
    app.log.error({ error, walletAddress: body.walletAddress, orderID: body.orderID }, 'Failed to store order');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to store order',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /orders/user/:walletAddress
 * Get order IDs for a specific wallet address
 * This API fetches all order IDs associated with a wallet address
 */
app.get("/orders/user/:walletAddress", async (request, reply) => {
  const { walletAddress } = request.params as { walletAddress: string };
  const query = request.query as { 
    limit?: number; 
    offset?: number; 
    status?: string;
    venue?: string;
  };
  
  // Basic wallet address validation
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    reply.code(400);
    return reply.send({ error: "Invalid wallet address format" });
  }
  
  try {
    const client = await pool.connect();
    try {
      // Check if user exists for this wallet address
      const userResult = await client.query(
        `SELECT u.id FROM users u 
         JOIN user_wallets uw ON u.id = uw.user_id 
         WHERE uw.wallet_address = $1`,
        [walletAddress]
      );
      
      if (userResult.rows.length === 0) {
        reply.code(404);
        return reply.send({ error: "User not found for this wallet address" });
      }
      
      const userId = userResult.rows[0].id;
      
      // Build query with filters
      let whereClause = 'WHERE user_id = $1';
      const params: any[] = [userId];
      let paramCount = 1;
      
      if (query.status) {
        paramCount++;
        whereClause += ` AND status = $${paramCount}`;
        params.push(query.status);
      }
      
      if (query.venue) {
        paramCount++;
        whereClause += ` AND venue = $${paramCount}`;
        params.push(query.venue);
      }
      
      const limit = Math.min(query.limit || 50, 100); // Max 100 orders
      const offset = query.offset || 0;
      
      // Get orders
      const result = await client.query(
        `SELECT 
          id, venue_order_id, venue, token_id, side, order_type,
          price, size, status, filled_size, average_fill_price,
          posted_at, last_update, filled_at, cancelled_at
        FROM orders 
        ${whereClause}
        ORDER BY posted_at DESC
        LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
        [...params, limit, offset]
      );
      
      // Get total count for pagination
      const countResult = await client.query(
        `SELECT COUNT(*) as total FROM orders ${whereClause}`,
        params
      );
      
      const totalCount = parseInt(countResult.rows[0].total);
      
      const orders = result.rows.map(row => ({
        id: row.id,
        orderID: row.venue_order_id,
        venue: row.venue,
        tokenId: row.token_id,
        side: row.side,
        orderType: row.order_type,
        price: row.price ? parseFloat(row.price) : null,
        size: row.size ? parseFloat(row.size) : null,
        status: row.status,
        filledSize: row.filled_size ? parseFloat(row.filled_size) : 0,
        averageFillPrice: row.average_fill_price ? parseFloat(row.average_fill_price) : null,
        postedAt: row.posted_at,
        lastUpdate: row.last_update,
        filledAt: row.filled_at,
        cancelledAt: row.cancelled_at,
      }));
      
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        walletAddress,
        orders,
        pagination: {
          total: totalCount,
          limit,
          offset,
          hasMore: offset + limit < totalCount,
        },
      });
      
    } finally {
      client.release();
    }
    
  } catch (error) {
    app.log.error({ error, walletAddress }, 'Failed to fetch orders for wallet address');
    reply.code(500);
    return reply.send({ 
      error: 'Failed to fetch orders',
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
