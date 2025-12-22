import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getRedis } from "../redis.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { fetchMarketDetails, fetchMarketsByTokenIds } from "../repos/unified-read.js";
import { dflowRequest, extractDflowErrorMessage } from "../services/dflow-client.js";
import { polymarketClient } from "../services/polymarket-client.js";
import { candlesticksQuerySchema } from "../schemas/candlesticks.js";
import { marketParamsSchema, marketsByTokenQuerySchema } from "../schemas/market.js";

export const marketRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /markets/by-token
   * Get market summaries for a list of token IDs
   */
  z.get(
    "/markets/by-token",
    { schema: { querystring: marketsByTokenQuerySchema } },
    async (request, reply) => {
      const { tokenIds, venue } = request.query;

      if (tokenIds.length > 200) {
        reply.code(400);
        return reply.send({
          error: "tokenIds length exceeded",
          message: "Max 200 tokenIds allowed per request.",
        });
      }

      try {
        const rows = await fetchMarketsByTokenIds(pool, { tokenIds, venue });
        const now = new Date();

        const response = rows.map((row) => {
          let tokens = { yes: null as string | null, no: null as string | null };
          if (row.venue === "polymarket" && row.clob_token_ids) {
            try {
              const parsed = JSON.parse(String(row.clob_token_ids));
              if (Array.isArray(parsed)) {
                tokens = {
                  yes: parsed[0] != null ? String(parsed[0]) : null,
                  no: parsed[1] != null ? String(parsed[1]) : null,
                };
              }
            } catch {
              // keep tokens as null
            }
          } else if (row.venue === "limitless" || row.venue === "kalshi") {
            tokens = {
              yes: row.token_yes != null ? String(row.token_yes) : null,
              no: row.token_no != null ? String(row.token_no) : null,
            };
          }

          let outcomes: unknown = null;
          if (row.outcomes) {
            try {
              outcomes = JSON.parse(row.outcomes);
            } catch {
              // ignore parse errors
            }
          }

          const acceptingOrders =
            row.pm_accepting_orders != null
              ? Boolean(row.pm_accepting_orders)
              : row.market_status === "ACTIVE" &&
                (row.expiration_time == null ||
                  new Date(String(row.expiration_time)) > now) &&
                (row.close_time == null ||
                  new Date(String(row.close_time)) > now);

          return {
            tokenId: row.token_id,
            side:
              row.token_id === tokens.yes
                ? "YES"
                : row.token_id === tokens.no
                  ? "NO"
                  : row.side,
            market: {
              marketId: row.market_id,
              venue: row.venue,
              venueMarketId: row.venue_market_id,
              marketTitle: row.market_title,
              marketDescription: row.market_description,
              marketType: row.market_type,
              status: row.market_status,
              openTime: row.open_time,
              closeTime: row.close_time,
              expirationTime: row.expiration_time,
              volume24h: row.volume_24h != null ? Number(row.volume_24h) : 0,
              volumeTotal:
                row.volume_total != null ? Number(row.volume_total) : 0,
              openInterest:
                row.open_interest != null ? Number(row.open_interest) : 0,
              liquidity: row.liquidity != null ? Number(row.liquidity) : 0,
              bestBid:
                row.best_bid_yes != null
                  ? Number(row.best_bid_yes)
                  : row.best_bid != null
                    ? Number(row.best_bid)
                    : null,
              bestAsk:
                row.best_ask_yes != null
                  ? Number(row.best_ask_yes)
                  : row.best_ask != null
                    ? Number(row.best_ask)
                    : null,
              bestBidYes:
                row.best_bid_yes != null ? Number(row.best_bid_yes) : null,
              bestAskYes:
                row.best_ask_yes != null ? Number(row.best_ask_yes) : null,
              bestBidNo:
                row.best_bid_no != null ? Number(row.best_bid_no) : null,
              bestAskNo:
                row.best_ask_no != null ? Number(row.best_ask_no) : null,
              lastPrice: row.last_price != null ? Number(row.last_price) : null,
              outcomes,
              tokens,
              conditionId: row.condition_id || null,
              questionId: row.pm_question_id || null,
              marketSlug: row.slug || null,
              marketImage: row.market_image || null,
              marketIcon: row.market_icon || null,
              redemptionStatus: row.redemption_status || null,
              resolvedOutcome: row.resolved_outcome || null,
              resolvedOutcomePct:
                row.resolved_outcome_pct != null
                  ? Number(row.resolved_outcome_pct)
                  : null,
              acceptingOrders,
              negRisk: row.pm_neg_risk != null ? Boolean(row.pm_neg_risk) : null,
              negRiskMarketId: row.pm_neg_risk_market_id || null,
              negRiskParentConditionId:
                row.pm_neg_risk_parent_condition_id || null,
              negRiskRequestId: row.pm_neg_risk_request_id || null,
              event: {
                eventId: row.event_id,
                venue: row.event_venue,
                venueEventId: row.venue_event_id,
                eventTitle: row.event_title,
                eventDescription: row.event_description || null,
                category: row.event_category || null,
                status: row.event_status,
                startTime: row.start_date,
                endTime: row.end_date,
                eventLiquidity:
                  row.event_liquidity != null
                    ? Number(row.event_liquidity)
                    : 0,
                eventVolume:
                  row.event_volume_total != null
                    ? Number(row.event_volume_total)
                    : 0,
                eventVolume24h:
                  row.event_volume_24h != null
                    ? Number(row.event_volume_24h)
                    : 0,
                eventOpenInterest:
                  row.event_open_interest != null
                    ? Number(row.event_open_interest)
                    : 0,
                eventSlug: row.event_slug || null,
                image: row.event_image || null,
                icon: row.event_icon || null,
              },
            },
          };
        });

        if (tokenIds.length) {
          void markHotTokens({ tokenIds });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ data: response });
      } catch (error) {
        app.log.error(
          { error, tokenIds, venue },
          "Markets by token fetch failed",
        );
        reply.code(500);
        return reply.send({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

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
          status: market.market_status ?? null,
          openTime: market.open_time,
          closeTime: market.close_time,
          expirationTime: market.expiration_time,
          volume24h: market.volume_24h != null ? Number(market.volume_24h) : 0,
          liquidity: market.liquidity != null ? Number(market.liquidity) : 0,
          bestBid:
            market.best_bid_yes != null
              ? Number(market.best_bid_yes)
              : market.best_bid != null
                ? Number(market.best_bid)
                : null,
          bestAsk:
            market.best_ask_yes != null
              ? Number(market.best_ask_yes)
              : market.best_ask != null
                ? Number(market.best_ask)
                : null,
          bestBidYes:
            market.best_bid_yes != null ? Number(market.best_bid_yes) : null,
          bestAskYes:
            market.best_ask_yes != null ? Number(market.best_ask_yes) : null,
          bestBidNo:
            market.best_bid_no != null ? Number(market.best_bid_no) : null,
          bestAskNo:
            market.best_ask_no != null ? Number(market.best_ask_no) : null,
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
          negRiskMarketId: market.pm_neg_risk_market_id || null,
          negRiskParentConditionId:
            market.pm_neg_risk_parent_condition_id || null,
          negRiskRequestId: market.pm_neg_risk_request_id || null,
          marketLedger: market.market_ledger ?? null,
          settlementMint: market.settlement_mint ?? null,
          isInitialized:
            market.is_initialized != null
              ? Boolean(market.is_initialized)
              : null,
          redemptionStatus: market.redemption_status ?? null,
          resolvedOutcome: market.resolved_outcome ?? null,
          resolvedOutcomePct:
            market.resolved_outcome_pct != null
              ? Number(market.resolved_outcome_pct)
              : null,
          conditionId: market.condition_id || null,
          questionId: market.pm_question_id || null,
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

        const tokenIds = [tokens.yes, tokens.no].filter(
          (tokenId): tokenId is string => Boolean(tokenId),
        );
        if (tokenIds.length) {
          void markHotTokens({ tokenIds });
        }

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

  /**
   * GET /markets/:marketId/candlesticks
   * Proxy candlestick/time-series data for a specific market.
   */
  z.get(
    "/markets/:marketId/candlesticks",
    {
      schema: {
        params: marketParamsSchema,
        querystring: candlesticksQuerySchema,
      },
    },
    async (request, reply) => {
      const { marketId } = request.params;
      const { startTs, endTs, periodInterval, interval, fidelity, side } =
        request.query;

      const clientIp = request.ip || "unknown";
      const rateLimitKey = `candlesticks:market:${clientIp}`;
      const canProceed = await checkRateLimit(rateLimitKey, 60, 60000);
      if (!canProceed) {
        reply.code(429);
        return reply.send({
          error: "Client rate limit exceeded. Please try again later.",
        });
      }

      const cacheKey = `candlesticks:market:${marketId}:${startTs ?? ""}:${endTs ?? ""}:${periodInterval ?? ""}:${interval ?? ""}:${fidelity ?? ""}:${side ?? ""}`;
      const r = await getRedis();
      if (r) {
        const cached = await r.get(cacheKey);
        if (cached) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            "public, max-age=60, stale-while-revalidate=120",
          );
          return reply.send(cached);
        }
      }

      try {
        const rows = await fetchMarketDetails(pool, marketId);
        if (rows.length === 0) {
          reply.code(404);
          return reply.send({ error: "Market not found" });
        }

        const market = rows[0];
        if (market.venue === "kalshi" || market.venue === "limitless") {
          if (startTs == null || endTs == null || periodInterval == null) {
            reply.code(400);
            return reply.send({
              error: "startTs, endTs, and periodInterval are required.",
            });
          }
          if (!market.venue_market_id) {
            reply.code(400);
            return reply.send({ error: "Missing market ticker." });
          }
          if (env.dflowRequireApiKey && !env.dflowApiKey) {
            reply.code(400);
            return reply.send({ error: "Missing DFLOW_API_KEY" });
          }

          const upstream = await dflowRequest({
            baseUrl: env.dflowPredictionMarketsBase,
            timeoutMs: 15_000,
            method: "GET",
            requestPath: `/api/v1/market/${encodeURIComponent(
              market.venue_market_id,
            )}/candlesticks`,
            apiKey: env.dflowApiKey,
            query: {
              startTs,
              endTs,
              periodInterval,
            },
          });

          if (!upstream.ok) {
            reply.code(502);
            return reply.send({
              error: "Kalshi candlesticks fetch failed",
              status: upstream.status,
              message: extractDflowErrorMessage(upstream.payload),
              payload: upstream.payload,
            });
          }

          const response = {
            ok: true,
            venue: "kalshi",
            marketId: market.market_id,
            ticker: market.venue_market_id,
            data: upstream.payload,
          };
          const responseBody = JSON.stringify(response);

          if (r) {
            await r.set(cacheKey, responseBody, { EX: 60 });
            reply.header("x-cache", "miss");
          }

          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            "public, max-age=60, stale-while-revalidate=120",
          );
          return reply.send(responseBody);
        }

        if (market.venue === "polymarket") {
          const clobTokenIdsRaw =
            market.clob_token_ids ?? market.pm_clob_token_ids ?? null;
          let tokenIds: string[] = [];
          if (clobTokenIdsRaw) {
            try {
              const parsed = JSON.parse(String(clobTokenIdsRaw));
              if (Array.isArray(parsed)) {
                tokenIds = parsed
                  .map((token) => (token != null ? String(token) : null))
                  .filter((token): token is string => Boolean(token));
              }
            } catch {
              tokenIds = [];
            }
          }

          if (tokenIds.length < 1) {
            reply.code(400);
            return reply.send({ error: "Missing Polymarket token IDs." });
          }

          const resolvedSide = side ?? "YES";
          const tokenId =
            resolvedSide === "NO" && tokenIds.length > 1
              ? tokenIds[1]
              : tokenIds[0];

          const history = await polymarketClient.getPriceHistory(tokenId, {
            startTs,
            endTs,
            interval,
            fidelity,
          });

          const response = {
            ok: true,
            venue: "polymarket",
            marketId: market.market_id,
            tokenId,
            side: resolvedSide,
            data: history,
          };
          const responseBody = JSON.stringify(response);

          if (r) {
            await r.set(cacheKey, responseBody, { EX: 60 });
            reply.header("x-cache", "miss");
          }

          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            "public, max-age=60, stale-while-revalidate=120",
          );
          return reply.send(responseBody);
        }

        reply.code(400);
        return reply.send({
          error: `Candlesticks not supported for venue ${market.venue ?? "unknown"}.`,
        });
      } catch (error) {
        app.log.error({ error, marketId }, "Candlestick fetch failed");
        reply.code(500);
        return reply.send({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
