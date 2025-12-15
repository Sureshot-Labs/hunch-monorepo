import type { FastifyPluginAsync } from "fastify";
import crypto from "node:crypto";
import { getRedis } from "../redis.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { parseOrReply } from "../lib/zod.js";
import { polymarketClient } from "../services/polymarket-client.js";
import type { PriceHistoryData } from "../server-types.js";
import {
  orderbookBatchBodySchema,
  priceBatchBodySchema,
  priceHistoryQuerySchema,
  priceQuerySchema,
  spreadsBodySchema,
  tokenIdParamsSchema,
} from "../schemas/polymarket-proxy.js";

export const polymarketProxyRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /price-history/status
   * Returns the current status of the Polymarket rate limiter
   */
  app.get("/price-history/status", async (_request, reply) => {
    const status = {
      polymarketRateLimiter: polymarketClient.getRateLimiterStatus(),
      timestamp: new Date().toISOString(),
    };

    reply.header("Content-Type", "application/json; charset=utf-8");
    return reply.send(status);
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
    const q = parseOrReply(reply, priceHistoryQuerySchema, request.query);
    if (!q) return;

    const tokens = q.tokens;
    const venue = q.venue;
    const startTs = q.startTs;
    const endTs = q.endTs;
    const interval = q.interval;
    const fidelity = q.fidelity;

    // Check if client is requesting too frequently
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `price-history:${clientIp}`;
    const canProceed = await checkRateLimit(rateLimitKey, 50, 60000); // 50 requests per minute per client

    if (!canProceed) {
      reply.code(429);
      return reply.send({
        error: "Rate limit exceeded. Please try again later.",
      });
    }

    // Create cache key for this specific request
    const cacheKey = `price-history:${venue}:${tokens.join(",")}:${interval}:${startTs || ""}:${endTs || ""}:${fidelity || ""}`;
    const r = await getRedis();

    // Check cache first (5-minute cache for processed data)
    if (r) {
      const cachedBody = await r.get(cacheKey);
      if (cachedBody) {
        const etag = `W/"${crypto.createHash("sha1").update(cachedBody).digest("hex")}"`;
        if (request.headers["if-none-match"] === etag) {
          reply.header("ETag", etag);
          reply.code(304);
          return reply.send();
        }
        reply.header("x-cache", "hit");
        reply.header("ETag", etag);
        reply.header(
          "Cache-Control",
          "public, max-age=300, stale-while-revalidate=600",
        );
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(cachedBody);
      }
    }

    try {
      const results: Record<string, PriceHistoryData> = {};
      const errors: Record<string, string> = {};

      // Process each token
      for (const token of tokens) {
        try {
          const processedData: PriceHistoryData =
            await polymarketClient.getPriceHistory(token, {
              startTs,
              endTs,
              interval,
              fidelity,
            });

          results[token] = processedData;

          // Cache the max data for this token (if we got raw max data)
          if (
            r &&
            processedData &&
            !processedData.metadata?.originalDataPoints
          ) {
            // This is raw max data, cache it
            const maxDataCacheKey = `max-data:${venue}:${token}`;
            await r.set(maxDataCacheKey, JSON.stringify(processedData), {
              EX: 1800,
            }); // 30 minutes
          }
        } catch (error) {
          errors[token] =
            error instanceof Error ? error.message : "Unknown error";
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
      const etag = `W/"${crypto.createHash("sha1").update(responseBody).digest("hex")}"`;

      // Cache processed response for 5 minutes
      if (r) {
        await r.set(cacheKey, responseBody, { EX: 300 });
        reply.header("x-cache", "miss");
      }

      reply.header("ETag", etag);
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Cache-Control",
        "public, max-age=60, stale-while-revalidate=300",
      );
      return reply.send(responseBody);
    } catch (error) {
      app.log.error({ error, venue, tokens }, "Price history fetch failed");
      reply.code(500);
      return reply.send({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /orderbook/{tokenId}
   * Get order book summary for a specific token
   * Rate limit: 200 requests/10s
   */
  app.get("/orderbook/:tokenId", async (request, reply) => {
    const params = parseOrReply(reply, tokenIdParamsSchema, request.params);
    if (!params) return;
    const { tokenId } = params;

    // Check client rate limiting
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `orderbook:${clientIp}`;
    const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client

    if (!canProceed) {
      reply.code(429);
      return reply.send({
        error: "Client rate limit exceeded. Please try again later.",
      });
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
        reply.header(
          "Cache-Control",
          "public, max-age=5, stale-while-revalidate=10",
        );
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
      reply.header(
        "Cache-Control",
        "public, max-age=5, stale-while-revalidate=10",
      );
      return reply.send(responseBody);
    } catch (error) {
      app.log.error({ error, tokenId }, "Order book fetch failed");
      reply.code(500);
      return reply.send({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /orderbook/batch
   * Get order book summaries for multiple tokens
   * Rate limit: 80 requests/10s
   */
  app.post("/orderbook/batch", async (request, reply) => {
    const body = parseOrReply(reply, orderbookBatchBodySchema, request.body);
    if (!body) return;

    // Check client rate limiting
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `orderbook-batch:${clientIp}`;
    const canProceed = await checkRateLimit(rateLimitKey, 50, 60000); // 50 requests per minute per client

    if (!canProceed) {
      reply.code(429);
      return reply.send({
        error: "Client rate limit exceeded. Please try again later.",
      });
    }

    try {
      const orderBooks = await polymarketClient.getOrderBooksBatch(
        body.tokenIds,
      );

      const response = {
        tokenIds: body.tokenIds,
        data: orderBooks,
        timestamp: new Date().toISOString(),
      };

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(response);
    } catch (error) {
      app.log.error(
        { error, tokenIds: body.tokenIds },
        "Order books batch fetch failed",
      );
      reply.code(500);
      return reply.send({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /price/{tokenId}
   * Get price for a token with side
   * Rate limit: 200 requests/10s
   */
  app.get("/price/:tokenId", async (request, reply) => {
    const params = parseOrReply(reply, tokenIdParamsSchema, request.params);
    if (!params) return;
    const { tokenId } = params;

    const q = parseOrReply(reply, priceQuerySchema, request.query);
    if (!q) return;
    const side = q.side;

    // Check client rate limiting
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `price:${clientIp}`;
    const canProceed = await checkRateLimit(rateLimitKey, 200, 60000); // 200 requests per minute per client

    if (!canProceed) {
      reply.code(429);
      return reply.send({
        error: "Client rate limit exceeded. Please try again later.",
      });
    }

    // Create cache key (1-second cache)
    const cacheKey = `price:${tokenId}:${side}`;
    const r = await getRedis();

    if (r) {
      const cachedData = await r.get(cacheKey);
      if (cachedData) {
        reply.header("x-cache", "hit");
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header(
          "Cache-Control",
          "public, max-age=1, stale-while-revalidate=2",
        );
        return reply.send(cachedData);
      }
    }

    try {
      const price = await polymarketClient.getPrice(
        tokenId,
        side as "BUY" | "SELL",
      );

      const response = {
        tokenId,
        side,
        data: price,
        timestamp: new Date().toISOString(),
      };

      const responseBody = JSON.stringify(response);

      if (r) {
        await r.set(cacheKey, responseBody, { EX: 1 });
        reply.header("x-cache", "miss");
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Cache-Control",
        "public, max-age=1, stale-while-revalidate=2",
      );
      return reply.send(responseBody);
    } catch (error) {
      app.log.error({ error, tokenId, side }, "Price fetch failed");
      reply.code(500);
      return reply.send({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /price/batch
   * Get prices for multiple tokens with sides
   * Rate limit: 80 requests/10s
   */
  app.post("/price/batch", async (request, reply) => {
    const body = parseOrReply(reply, priceBatchBodySchema, request.body);
    if (!body) return;
    const requests = body.requests;

    // Check client rate limiting
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `price-batch:${clientIp}`;
    const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client

    if (!canProceed) {
      reply.code(429);
      return reply.send({
        error: "Client rate limit exceeded. Please try again later.",
      });
    }

    try {
      const prices = await polymarketClient.getPricesBatch(requests);

      const response = {
        requests,
        data: prices,
        timestamp: new Date().toISOString(),
      };

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(response);
    } catch (error) {
      app.log.error({ error, requests }, "Prices batch fetch failed");
      reply.code(500);
      return reply.send({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * GET /midpoint/{tokenId}
   * Get midpoint price for a token
   * Rate limit: 200 requests/10s
   */
  app.get("/midpoint/:tokenId", async (request, reply) => {
    const params = parseOrReply(reply, tokenIdParamsSchema, request.params);
    if (!params) return;
    const { tokenId } = params;

    // Check client rate limiting
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `midpoint:${clientIp}`;
    const canProceed = await checkRateLimit(rateLimitKey, 200, 60000); // 200 requests per minute per client

    if (!canProceed) {
      reply.code(429);
      return reply.send({
        error: "Client rate limit exceeded. Please try again later.",
      });
    }

    // Create cache key (1-second cache)
    const cacheKey = `midpoint:${tokenId}`;
    const r = await getRedis();

    if (r) {
      const cachedData = await r.get(cacheKey);
      if (cachedData) {
        reply.header("x-cache", "hit");
        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header(
          "Cache-Control",
          "public, max-age=1, stale-while-revalidate=2",
        );
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

      if (r) {
        await r.set(cacheKey, responseBody, { EX: 1 });
        reply.header("x-cache", "miss");
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Cache-Control",
        "public, max-age=1, stale-while-revalidate=2",
      );
      return reply.send(responseBody);
    } catch (error) {
      app.log.error({ error, tokenId }, "Midpoint fetch failed");
      reply.code(500);
      return reply.send({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  /**
   * POST /spreads
   * Get bid-ask spreads for multiple tokens
   * Rate limit: 200 requests/10s
   */
  app.post("/spreads", async (request, reply) => {
    const body = parseOrReply(reply, spreadsBodySchema, request.body);
    if (!body) return;

    // Check client rate limiting
    const clientIp = request.ip || "unknown";
    const rateLimitKey = `spreads:${clientIp}`;
    const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client

    if (!canProceed) {
      reply.code(429);
      return reply.send({
        error: "Client rate limit exceeded. Please try again later.",
      });
    }

    try {
      const spreads = await polymarketClient.getSpreadsBatch(body.tokenIds);

      const response = {
        tokenIds: body.tokenIds,
        data: spreads,
        timestamp: new Date().toISOString(),
      };

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(response);
    } catch (error) {
      app.log.error({ error, tokenIds: body.tokenIds }, "Spreads fetch failed");
      reply.code(500);
      return reply.send({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
};
