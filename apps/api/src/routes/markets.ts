import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getRedis } from "../redis.js";
import { pool } from "../db.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { marketParamsSchema } from "../schemas/market.js";
import { fetchMarketDetails } from "../repos/unified-read.js";

export const marketRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /markets/:marketId
   * Get detailed information for a specific market
   */
  z.get(
    "/markets/:marketId",
    { schema: { params: marketParamsSchema } },
    async (request, reply) => {
      const { marketId } = request.params;

      // Check client rate limiting
      const clientIp = request.ip || "unknown";
      const rateLimitKey = `market:${clientIp}`;
      const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client

      if (!canProceed) {
        reply.code(429);
        return reply.send({
          error: "Client rate limit exceeded. Please try again later.",
        });
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
          reply.header(
            "Cache-Control",
            "public, max-age=30, stale-while-revalidate=60",
          );
          return reply.send(cachedData);
        }
      }

      try {
        const rows = await fetchMarketDetails(pool, marketId);

        if (rows.length === 0) {
          reply.code(404);
          return reply.send({ error: "Market not found" });
        }

        const market = rows[0];

        const clobTokenIdsRaw =
          market.clob_token_ids ??
          market.pm_clob_token_ids ??
          null;

        // Parse token IDs based on venue
        let tokens = { yes: null as string | null, no: null as string | null };
        if (market.venue === "polymarket" && clobTokenIdsRaw) {
          try {
            const tokenIds = JSON.parse(clobTokenIdsRaw);
            tokens = {
              yes: tokenIds[0] || null,
              no: tokenIds[1] || null,
            };
          } catch {
            // Invalid JSON, keep tokens as null
          }
        } else if (market.venue === "limitless" || market.venue === "kalshi") {
          tokens = {
            yes: market.token_yes,
            no: market.token_no,
          };
        }

        // Parse outcomes if available
        let outcomes: unknown = null;
        if (market.outcomes) {
          try {
            outcomes = JSON.parse(market.outcomes);
          } catch {
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
          lastPrice:
            market.last_price != null ? Number(market.last_price) : null,
          outcomes,
          tokens,
          clobTokenIds:
            clobTokenIdsRaw != null ? clobTokenIdsRaw : null,
          orderPriceMinTickSize:
            market.pm_order_price_min_tick_size != null
              ? Number(market.pm_order_price_min_tick_size)
              : null,
          orderMinSize:
            market.pm_order_min_size != null
              ? Number(market.pm_order_min_size)
              : null,
          acceptingOrders:
            market.pm_accepting_orders != null
              ? Boolean(market.pm_accepting_orders)
              : null,
          negRisk:
            market.pm_neg_risk != null ? Boolean(market.pm_neg_risk) : null,
          marketLedger: market.market_ledger ?? null,
          settlementMint: market.settlement_mint ?? null,
          isInitialized:
            market.is_initialized != null
              ? Boolean(market.is_initialized)
              : null,
          redemptionStatus: market.redemption_status ?? null,
          conditionId: market.condition_id || null,
          category: market.market_category || null,
          marketSlug: market.slug || null,
          marketImage: market.market_image || null,
          marketIcon: market.market_icon || null,
          createdAt: market.created_at,
          updatedAt: market.updated_at,
          event: {
            eventId: market.event_id,
            eventTitle: market.event_title,
            eventDescription: market.event_description,
            category: market.event_category,
            startTime: market.start_date,
            endTime: market.end_date,
            eventLiquidity:
              market.event_liquidity != null
                ? Number(market.event_liquidity)
                : 0,
            eventVolume:
              market.event_volume != null ? Number(market.event_volume) : 0,
            eventImage: market.event_image || null,
            eventIcon: market.event_icon || null,
          },
        };

        const responseBody = JSON.stringify(response);

        // Cache for 30 seconds
        if (r) {
          await r.set(cacheKey, responseBody, { EX: 30 });
          reply.header("x-cache", "miss");
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        reply.header(
          "Cache-Control",
          "public, max-age=30, stale-while-revalidate=60",
        );
        return reply.send(responseBody);
      } catch (error) {
        app.log.error({ error, marketId }, "Market details fetch failed");
        reply.code(500);
        return reply.send({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
