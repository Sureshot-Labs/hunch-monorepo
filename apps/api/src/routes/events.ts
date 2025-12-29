import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getRedis } from "../redis.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import {
  aggregateKalshiCandlesticks,
  formatKalshiCandlesticks,
  parseKalshiCandlesticks,
  resolveKalshiBaseInterval,
  shouldAggregateKalshiCandles,
} from "../lib/candlesticks.js";
import { fetchEventDetails, type EventDetailsRow } from "../repos/unified-read.js";
import { dflowRequest, extractDflowErrorMessage } from "../services/dflow-client.js";
import { polymarketClient } from "../services/polymarket-client.js";
import { candlesticksQuerySchema } from "../schemas/candlesticks.js";
import { eventParamsSchema } from "../schemas/event.js";
import type { TokenPair } from "../server-types.js";

type PolymarketRepresentative = {
  row: EventDetailsRow;
  tokens: TokenPair;
};

function parseTimestampSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? Math.floor(time / 1000) : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const seconds = value > 1_000_000_000_000 ? value / 1000 : value;
    return Math.floor(seconds);
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function resolveTokenPair(row: EventDetailsRow): TokenPair {
  const tokens: TokenPair = {
    yes: row.token_yes != null ? String(row.token_yes) : null,
    no: row.token_no != null ? String(row.token_no) : null,
  };

  if ((!tokens.yes || !tokens.no) && row.clob_token_ids) {
    const raw = row.clob_token_ids;
    let parsed: unknown;
    if (Array.isArray(raw)) {
      parsed = raw;
    } else {
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        parsed = null;
      }
    }
    if (Array.isArray(parsed)) {
      if (!tokens.yes && parsed[0] != null) {
        tokens.yes = String(parsed[0]);
      }
      if (!tokens.no && parsed[1] != null) {
        tokens.no = String(parsed[1]);
      }
    }
  }

  return tokens;
}

function isAcceptingOrders(row: EventDetailsRow): boolean {
  if (row.pm_accepting_orders != null) {
    return Boolean(row.pm_accepting_orders);
  }
  if (row.market_status !== "ACTIVE") return false;

  const now = Math.floor(Date.now() / 1000);
  const closeTs = parseTimestampSeconds(row.close_time);
  if (closeTs != null && closeTs <= now) return false;
  const expirationTs = parseTimestampSeconds(row.expiration_time);
  if (expirationTs != null && expirationTs <= now) return false;

  return true;
}

function selectPolymarketRepresentative(
  rows: EventDetailsRow[],
  side: "YES" | "NO",
): PolymarketRepresentative | null {
  const candidates = rows
    .filter((row) => row.market_venue === "polymarket")
    .map((row) => ({ row, tokens: resolveTokenPair(row) }))
    .filter((candidate) => candidate.tokens.yes || candidate.tokens.no);

  if (candidates.length === 0) return null;

  const sideCandidates = candidates.filter((candidate) =>
    side === "NO" ? candidate.tokens.no : candidate.tokens.yes,
  );
  const eligible = sideCandidates.length ? sideCandidates : candidates;
  const active = eligible.find((candidate) =>
    isAcceptingOrders(candidate.row),
  );

  return active ?? eligible[0];
}

export const eventRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /events/:eventId
   * Get detailed information for a specific event with all associated markets
   */
  z.get(
    "/events/:eventId",
    { schema: { params: eventParamsSchema } },
    async (request, reply) => {
      const { eventId } = request.params;

      // Check client rate limiting
      const clientIp = request.ip || "unknown";
      const rateLimitKey = `event:${clientIp}`;
      const canProceed = await checkRateLimit(rateLimitKey, 100, 60000); // 100 requests per minute per client

      if (!canProceed) {
        reply.code(429);
        return reply.send({
          error: "Client rate limit exceeded. Please try again later.",
        });
      }

      // Create cache key
      const cacheKey = `event:${eventId}`;
      const r = await getRedis();

      // Check cache first (30-second cache for event data)
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
        const rows = await fetchEventDetails(pool, eventId);

        if (rows.length === 0) {
          reply.code(404);
          return reply.send({ error: "Event not found" });
        }

        const firstRow = rows[0];

        // Build event object
        const event = {
          eventId: firstRow.event_id,
          venue: firstRow.event_venue,
          venueEventId: firstRow.venue_event_id,
          eventTitle: firstRow.event_title,
          eventDescription: firstRow.event_description || null,
          category: firstRow.event_category || null,
          startTime: firstRow.start_date,
          endTime: firstRow.end_date,
          status: firstRow.event_status,
          eventLiquidity:
            firstRow.event_liquidity != null
              ? Number(firstRow.event_liquidity)
              : 0,
          eventVolume:
            firstRow.event_volume_total != null
              ? Number(firstRow.event_volume_total)
              : 0,
          eventVolume24h:
            firstRow.event_volume_24h != null
              ? Number(firstRow.event_volume_24h)
              : 0,
          eventOpenInterest:
            firstRow.event_open_interest != null
              ? Number(firstRow.event_open_interest)
              : 0,
          eventSlug: firstRow.event_slug || null,
          image: firstRow.event_image || null,
          icon: firstRow.event_icon || null,
          createdAt: firstRow.event_created_at,
          updatedAt: firstRow.event_updated_at,
          markets: [] as Record<string, unknown>[],
        };

        // Process markets
        for (const row of rows) {
          // Skip if no market data (event exists but has no markets)
          if (!row.market_id) {
            continue;
          }

          // Parse token IDs based on venue
          let tokens: TokenPair = { yes: null, no: null };
          if (row.market_venue === "polymarket" && row.clob_token_ids) {
            try {
              const tokenIds = JSON.parse(
                String(row.clob_token_ids),
              ) as unknown;
              if (Array.isArray(tokenIds)) {
                tokens = {
                  yes: tokenIds[0] != null ? String(tokenIds[0]) : null,
                  no: tokenIds[1] != null ? String(tokenIds[1]) : null,
                };
              }
            } catch {
              // Invalid JSON, keep tokens as null
            }
          } else if (
            row.market_venue === "limitless" ||
            row.market_venue === "kalshi"
          ) {
            tokens = {
              yes: row.token_yes != null ? String(row.token_yes) : null,
              no: row.token_no != null ? String(row.token_no) : null,
            };
          }

          // Parse outcomes if available
          let outcomes: unknown = null;
          if (row.outcomes) {
            try {
              outcomes = JSON.parse(row.outcomes);
            } catch {
              // Invalid JSON, keep outcomes as null
            }
          }

          // Determine if market is accepting orders
          const acceptingOrders =
            row.pm_accepting_orders != null
              ? Boolean(row.pm_accepting_orders)
              : row.market_status === "ACTIVE" &&
                (row.expiration_time === null ||
                  new Date(String(row.expiration_time)) > new Date()) &&
                (row.close_time === null ||
                  new Date(String(row.close_time)) > new Date());

          event.markets.push({
            marketId: row.market_id,
            venue: row.market_venue,
            venueMarketId: row.venue_market_id,
            marketTitle: row.market_title,
            marketDescription: row.market_description || null,
            marketType: row.market_type,
            status: row.market_status,
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
            lastPrice: row.last_price != null ? Number(row.last_price) : null,
            outcomes,
            tokens,
            conditionId: row.condition_id || null,
            resolvedOutcome: row.resolved_outcome || null,
            resolvedOutcomePct:
              row.resolved_outcome_pct != null
                ? Number(row.resolved_outcome_pct)
                : null,
            category: row.market_category || null,
            marketSlug: row.market_slug || null,
            marketImage: row.market_image || null,
            marketIcon: row.market_icon || null,
            acceptingOrders,
            top: {
              yesBid:
                row.best_bid_yes != null
                  ? Number(row.best_bid_yes)
                  : row.best_bid != null
                    ? Number(row.best_bid)
                    : null,
              yesAsk:
                row.best_ask_yes != null
                  ? Number(row.best_ask_yes)
                  : row.best_ask != null
                    ? Number(row.best_ask)
                    : null,
              noBid:
                row.best_bid_no != null
                  ? Number(row.best_bid_no)
                  : row.best_bid_yes != null
                    ? Number(1 - Number(row.best_bid_yes))
                    : row.best_bid != null
                      ? Number(1 - Number(row.best_bid))
                      : null,
              noAsk:
                row.best_ask_no != null
                  ? Number(row.best_ask_no)
                  : row.best_ask_yes != null
                    ? Number(1 - Number(row.best_ask_yes))
                    : row.best_ask != null
                      ? Number(1 - Number(row.best_ask))
                      : null,
            },
            openTime: row.open_time,
            closeTime: row.close_time,
            expirationTime: row.expiration_time,
            createdAt: row.market_created_at,
            updatedAt: row.market_updated_at,
            lastUpdate: row.market_updated_at,
          });
        }

        const responseBody = JSON.stringify(event);

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
        app.log.error({ error, eventId }, "Event details fetch failed");
        reply.code(500);
        return reply.send({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /events/:eventId/candlesticks
   * Proxy candlestick data for a specific event.
   */
  z.get(
    "/events/:eventId/candlesticks",
    {
      schema: {
        params: eventParamsSchema,
        querystring: candlesticksQuerySchema,
      },
    },
    async (request, reply) => {
      const { eventId } = request.params;
      const { startTs, endTs, periodInterval, interval, fidelity, side } =
        request.query;

      const clientIp = request.ip || "unknown";
      const rateLimitKey = `candlesticks:event:${clientIp}`;
      const canProceed = await checkRateLimit(rateLimitKey, 60, 60000);
      if (!canProceed) {
        reply.code(429);
        return reply.send({
          error: "Client rate limit exceeded. Please try again later.",
        });
      }

      const cacheKey = `candlesticks:event:${eventId}:${startTs ?? ""}:${endTs ?? ""}:${periodInterval ?? ""}:${interval ?? ""}:${fidelity ?? ""}:${side ?? ""}`;
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
        const rows = await fetchEventDetails(pool, eventId);
        if (rows.length === 0) {
          reply.code(404);
          return reply.send({ error: "Event not found" });
        }

        const event = rows[0];
        if (event.event_venue === "kalshi" || event.event_venue === "limitless") {
          if (startTs == null || endTs == null || periodInterval == null) {
            reply.code(400);
            return reply.send({
              error: "startTs, endTs, and periodInterval are required.",
            });
          }
          if (!event.venue_event_id) {
            reply.code(400);
            return reply.send({ error: "Missing event ticker." });
          }
          if (env.dflowRequireApiKey && !env.dflowApiKey) {
            reply.code(400);
            return reply.send({ error: "Missing DFLOW_API_KEY" });
          }

          const requestedInterval = periodInterval;
          const shouldAggregate = shouldAggregateKalshiCandles(requestedInterval);
          const baseInterval = shouldAggregate
            ? resolveKalshiBaseInterval(requestedInterval)
            : requestedInterval;

          const upstream = await dflowRequest({
            baseUrl: env.dflowPredictionMarketsBase,
            timeoutMs: 15_000,
            method: "GET",
            requestPath: `/api/v1/event/${encodeURIComponent(
              event.venue_event_id,
            )}/candlesticks`,
            apiKey: env.dflowApiKey,
            query: {
              startTs,
              endTs,
              periodInterval: baseInterval,
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

          const data = shouldAggregate
            ? formatKalshiCandlesticks(
                aggregateKalshiCandlesticks(
                  parseKalshiCandlesticks(upstream.payload),
                  requestedInterval,
                  startTs,
                  endTs,
                ),
              )
            : upstream.payload;

          const response = {
            ok: true,
            venue: "kalshi",
            eventId: event.event_id,
            ticker: event.venue_event_id,
            data,
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

        if (event.event_venue === "polymarket") {
          const resolvedSide = side ?? "YES";
          const candidate = selectPolymarketRepresentative(rows, resolvedSide);
          if (!candidate) {
            reply.code(400);
            return reply.send({
              error: "No Polymarket markets available for this event.",
            });
          }

          const tokenId =
            resolvedSide === "NO"
              ? candidate.tokens.no
              : candidate.tokens.yes;
          if (!tokenId) {
            reply.code(400);
            return reply.send({
              error: `Missing Polymarket token for side ${resolvedSide}.`,
            });
          }

          const fallbackStart =
            parseTimestampSeconds(candidate.row.open_time) ??
            parseTimestampSeconds(event.start_date);
          const resolvedStartTs = startTs ?? fallbackStart ?? undefined;
          const resolvedEndTs = endTs ?? Math.floor(Date.now() / 1000);
          const resolvedFidelity = fidelity ?? periodInterval;

          const history = await polymarketClient.getPriceHistory(tokenId, {
            startTs: resolvedStartTs,
            endTs: resolvedEndTs,
            interval: interval ?? "max",
            fidelity: resolvedFidelity,
          });

          const response = {
            ok: true,
            venue: "polymarket",
            eventId: event.event_id,
            marketId: candidate.row.market_id,
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
          error: `Candlesticks not supported for venue ${event.event_venue ?? "unknown"}.`,
        });
      } catch (error) {
        app.log.error({ error, eventId }, "Event candlestick fetch failed");
        reply.code(500);
        return reply.send({
          error: "Internal server error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
