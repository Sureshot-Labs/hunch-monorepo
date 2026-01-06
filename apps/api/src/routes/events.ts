import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { getRedis } from "../redis.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { isRecord } from "../lib/type-guards.js";
import {
  aggregateKalshiCandlesticks,
  deriveNoCandlesticksFromYes,
  formatKalshiCandlesticks,
  isLimitlessSingleSeriesPayload,
  parseKalshiCandlesticks,
  parseLimitlessCandlesticks,
  parseLimitlessCandlesticksBySide,
  parsePolymarketCandlesticks,
  resolveBaseIntervalWithCap,
  resolveKalshiBaseInterval,
  resolveLimitlessBaseInterval,
  resolveRequestedIntervalMinutes,
  shouldAggregateKalshiCandles,
  shouldAggregateLimitlessCandles,
} from "../lib/candlesticks.js";
import { fetchEventDetails, type EventDetailsRow } from "../repos/unified-read.js";
import { dflowRequest, extractDflowErrorMessage } from "../services/dflow-client.js";
import { extractLimitlessMessage, limitlessRequest } from "../services/limitless-client.js";
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

type LimitlessMeta = {
  negRiskRequestId?: string;
  negRiskMarketId?: string;
  venueAdapter?: string;
  venueExchange?: string;
};

function parseMetadata(input: unknown): Record<string, unknown> | null {
  if (!input) return null;
  if (isRecord(input)) return input;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function pickString(
  obj: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" && value.trim().length
    ? value
    : undefined;
}

function extractLimitlessMeta(
  marketMeta: unknown,
  eventMeta: unknown,
): LimitlessMeta {
  const market = parseMetadata(marketMeta);
  const event = parseMetadata(eventMeta);

  return {
    negRiskRequestId: pickString(market, "negRiskRequestId"),
    negRiskMarketId:
      pickString(market, "negRiskMarketId") ?? pickString(event, "negRiskMarketId"),
    venueAdapter:
      pickString(market, "venueAdapter") ?? pickString(event, "venueAdapter"),
    venueExchange:
      pickString(market, "venueExchange") ?? pickString(event, "venueExchange"),
  };
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

function selectLimitlessRepresentative(
  rows: EventDetailsRow[],
): EventDetailsRow | null {
  const candidates = rows.filter((row) => row.market_venue === "limitless");
  if (candidates.length === 0) return null;
  const active = candidates.find((row) => isAcceptingOrders(row));
  return active ?? candidates[0];
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

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampProbability(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function resolveYesProbability(row: EventDetailsRow): {
  value: number | null;
  source: string | null;
} {
  const yesBid = toNumber(row.best_bid_yes);
  const yesAsk = toNumber(row.best_ask_yes);
  const lastPrice = toNumber(row.last_price);

  if (yesBid != null && yesAsk != null) {
    return { value: clampProbability((yesBid + yesAsk) / 2), source: "mid" };
  }
  if (yesBid != null) {
    return { value: clampProbability(yesBid), source: "bid" };
  }
  if (yesAsk != null) {
    return { value: clampProbability(yesAsk), source: "ask" };
  }
  if (lastPrice != null) {
    return { value: clampProbability(lastPrice), source: "last" };
  }

  const noBid = toNumber(row.best_bid_no);
  const noAsk = toNumber(row.best_ask_no);
  if (noBid != null && noAsk != null) {
    return {
      value: clampProbability(1 - (noBid + noAsk) / 2),
      source: "no-mid",
    };
  }
  if (noBid != null) {
    return { value: clampProbability(1 - noBid), source: "no-bid" };
  }
  if (noAsk != null) {
    return { value: clampProbability(1 - noAsk), source: "no-ask" };
  }

  return { value: null, source: null };
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

        const eventLimitlessMeta =
          firstRow.event_venue === "limitless"
            ? extractLimitlessMeta(null, firstRow.event_metadata)
            : null;

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
          negRiskMarketId: eventLimitlessMeta?.negRiskMarketId ?? null,
          negRiskAdapter: eventLimitlessMeta?.venueAdapter ?? null,
          negRiskExchange: eventLimitlessMeta?.venueExchange ?? null,
          markets: [] as Record<string, unknown>[],
        };

        const marketRows = rows
          .map((row, index) => ({ row, index }))
          .filter((item) => item.row.market_id)
          .map((item) => ({
            row: item.row,
            index: item.index,
            probability: resolveYesProbability(item.row).value,
          }))
          .sort((a, b) => {
            const aValue = a.probability;
            const bValue = b.probability;
            if (aValue == null && bValue == null) return a.index - b.index;
            if (aValue == null) return 1;
            if (bValue == null) return -1;
            if (bValue === aValue) return a.index - b.index;
            return bValue - aValue;
          })
          .map((item) => item.row);

        // Process markets (sorted by YES probability desc)
        for (const row of marketRows) {
          const limitlessMeta =
            row.market_venue === "limitless"
              ? extractLimitlessMeta(row.market_metadata, row.event_metadata)
              : null;
          const isLimitlessNegRisk = Boolean(
            limitlessMeta?.negRiskRequestId ||
              limitlessMeta?.negRiskMarketId ||
              limitlessMeta?.venueAdapter ||
              limitlessMeta?.venueExchange,
          );
          const marketMeta = parseMetadata(row.market_metadata);
          const tradeType =
            row.market_venue === "limitless"
              ? pickString(marketMeta, "tradeType") ?? null
              : null;
          const marketAddress =
            row.market_venue === "limitless"
              ? pickString(marketMeta, "address") ?? null
              : null;

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
            tradeType,
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
            acceptingOrders:
              acceptingOrders,
            negRisk:
              row.market_venue === "polymarket"
                ? row.pm_neg_risk != null
                  ? Boolean(row.pm_neg_risk)
                  : null
                : row.market_venue === "limitless"
                  ? isLimitlessNegRisk
                  : null,
            negRiskMarketId:
              row.market_venue === "limitless"
                ? limitlessMeta?.negRiskMarketId ?? null
                : row.pm_neg_risk_market_id || null,
            negRiskParentConditionId:
              row.market_venue === "polymarket"
                ? row.pm_neg_risk_parent_condition_id || null
                : null,
            negRiskRequestId:
              row.market_venue === "limitless"
                ? limitlessMeta?.negRiskRequestId ?? null
                : row.pm_neg_risk_request_id || null,
            negRiskAdapter:
              row.market_venue === "limitless"
                ? limitlessMeta?.venueAdapter ?? null
                : null,
            negRiskExchange:
              row.market_venue === "limitless"
                ? limitlessMeta?.venueExchange ?? null
                : null,
            marketAddress,
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
      const {
        startTs,
        endTs,
        periodInterval,
        interval,
        fidelity,
        side,
        sides,
        format,
        limit,
      } = request.query;

      const clientIp = request.ip || "unknown";
      const rateLimitKey = `candlesticks:event:${clientIp}`;
      const canProceed = await checkRateLimit(rateLimitKey, 60, 60000);
      if (!canProceed) {
        reply.code(429);
        return reply.send({
          error: "Client rate limit exceeded. Please try again later.",
        });
      }

      const cacheKey = `candlesticks:event:${eventId}:${startTs ?? ""}:${endTs ?? ""}:${periodInterval ?? ""}:${interval ?? ""}:${fidelity ?? ""}:${side ?? ""}:${sides ?? ""}:${format ?? ""}:${limit ?? ""}`;
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
        const isExtended = format === "extended";
        if (isExtended) {
          const requestedMinutes = resolveRequestedIntervalMinutes({
            periodInterval,
            interval,
            fidelity,
          });
          const requestedSides = sides ?? side ?? "YES";
          const includeYes =
            requestedSides === "YES" || requestedSides === "BOTH";
          const includeNo = requestedSides === "NO" || requestedSides === "BOTH";
          const resolvedLimit = Math.min(Math.max(limit ?? 5, 1), 10);

          const fallbackStartTs = parseTimestampSeconds(event.start_date);
          const resolvedStartTs =
            startTs ??
            fallbackStartTs ??
            rows
              .map((row) => parseTimestampSeconds(row.open_time))
              .filter((value): value is number => value != null)
              .sort((a, b) => a - b)[0] ??
            null;
          const resolvedEndTs = endTs ?? Math.floor(Date.now() / 1000);

          if (resolvedStartTs == null || resolvedEndTs == null) {
            reply.code(400);
            return reply.send({
              error: "startTs and endTs are required.",
            });
          }
          if (resolvedEndTs <= resolvedStartTs) {
            reply.code(400);
            return reply.send({ error: "endTs must be greater than startTs." });
          }

          if (
            (event.event_venue === "kalshi" ||
              event.event_venue === "limitless") &&
            requestedMinutes == null
          ) {
            reply.code(400);
            return reply.send({
              error: "periodInterval or interval is required.",
            });
          }
          if (
            event.event_venue === "kalshi" &&
            env.dflowRequireApiKey &&
            !env.dflowApiKey
          ) {
            reply.code(400);
            return reply.send({ error: "Missing DFLOW_API_KEY" });
          }

          const intervalInfo =
            event.event_venue === "kalshi"
              ? resolveBaseIntervalWithCap({
                  startTs: resolvedStartTs,
                  endTs: resolvedEndTs,
                  requestedMinutes,
                  supportedMinutes: [1, 60, 1440],
                })
              : event.event_venue === "limitless"
                ? resolveBaseIntervalWithCap({
                    startTs: resolvedStartTs,
                    endTs: resolvedEndTs,
                    requestedMinutes,
                    supportedMinutes: [1, 60, 360, 1440, 10080],
                  })
                : resolveBaseIntervalWithCap({
                    startTs: resolvedStartTs,
                    endTs: resolvedEndTs,
                    requestedMinutes,
                  });

          const ranked = rows
            .filter((row) => row.market_id)
            .map((row) => ({
              row,
              probability: resolveYesProbability(row),
            }))
            .sort((a, b) => {
              const aValue = a.probability.value;
              const bValue = b.probability.value;
              if (aValue == null && bValue == null) return 0;
              if (aValue == null) return 1;
              if (bValue == null) return -1;
              return bValue - aValue;
            })
            .slice(0, resolvedLimit);

          const markets = await Promise.all(
            ranked.map(async ({ row, probability }) => {
              const tokens = resolveTokenPair(row);
              const venueMarketId = row.venue_market_id ?? null;
              const marketSlug = row.market_slug ?? null;
              const base = {
                marketId: row.market_id,
                marketTitle: row.market_title ?? null,
                venueMarketId,
                marketSlug,
                probability: probability.value,
                probabilitySource: probability.source,
                tokens,
              };

              if (row.market_venue === "kalshi") {
                if (!venueMarketId) {
                  return { ...base, series: {} };
                }

                const upstream = await dflowRequest({
                  baseUrl: env.dflowPredictionMarketsBase,
                  timeoutMs: 15_000,
                  method: "GET",
                  requestPath: `/api/v1/market/${encodeURIComponent(
                    venueMarketId,
                  )}/candlesticks`,
                  apiKey: env.dflowApiKey,
                  query: {
                    startTs: resolvedStartTs,
                    endTs: resolvedEndTs,
                    periodInterval: intervalInfo.baseMinutes,
                  },
                });

                if (!upstream.ok) {
                  return { ...base, series: {} };
                }

                const rawCandles = parseKalshiCandlesticks(upstream.payload);
                const normalizedCandles =
                  intervalInfo.normalizedMinutes === intervalInfo.baseMinutes
                    ? rawCandles.filter(
                        (candle) =>
                          candle.t >= resolvedStartTs &&
                          candle.t <= resolvedEndTs,
                      )
                    : aggregateKalshiCandlesticks(
                        rawCandles,
                        intervalInfo.normalizedMinutes,
                        resolvedStartTs,
                        resolvedEndTs,
                      );

                const series: Record<string, unknown> = {};
                if (includeYes) {
                  series.YES = {
                    tokenId: tokens.yes ?? null,
                    candles: normalizedCandles,
                  };
                }
                if (includeNo) {
                  series.NO = {
                    tokenId: tokens.no ?? null,
                    candles: deriveNoCandlesticksFromYes(normalizedCandles),
                    derived: true,
                  };
                }

                return { ...base, series };
              }

              if (row.market_venue === "limitless") {
                const slug = marketSlug ?? venueMarketId;
                if (!slug) {
                  return { ...base, series: {} };
                }

                const baseInterval = resolveLimitlessBaseInterval(
                  intervalInfo.baseMinutes,
                );
                const query = new URLSearchParams({
                  from: new Date(resolvedStartTs * 1000).toISOString(),
                  to: new Date(resolvedEndTs * 1000).toISOString(),
                  interval: baseInterval.interval,
                });

                const upstream = await limitlessRequest({
                  method: "GET",
                  requestPath: `/markets/${encodeURIComponent(
                    slug,
                  )}/historical-price?${query.toString()}`,
                });

                if (!upstream.ok) {
                  return { ...base, series: {} };
                }

                const parsedBySide = parseLimitlessCandlesticksBySide(
                  upstream.payload,
                );
                const shouldDeriveNo =
                  isLimitlessSingleSeriesPayload(upstream.payload) &&
                  parsedBySide.YES.length > 0;
                const normalize = (candles: typeof parsedBySide.YES) =>
                  intervalInfo.normalizedMinutes === intervalInfo.baseMinutes
                    ? candles.filter(
                        (candle) =>
                          candle.t >= resolvedStartTs &&
                          candle.t <= resolvedEndTs,
                      )
                    : aggregateKalshiCandlesticks(
                        candles,
                        intervalInfo.normalizedMinutes,
                        resolvedStartTs,
                        resolvedEndTs,
                      );

                const yesCandles = normalize(parsedBySide.YES);
                const rawNoCandles = normalize(parsedBySide.NO);
                const noCandles = shouldDeriveNo
                  ? deriveNoCandlesticksFromYes(yesCandles)
                  : rawNoCandles;
                const series: Record<string, unknown> = {};
                if (includeYes) {
                  series.YES = {
                    tokenId: tokens.yes ?? null,
                    candles: yesCandles,
                  };
                }
                if (includeNo) {
                  series.NO = {
                    tokenId: tokens.no ?? null,
                    candles: noCandles,
                    ...(shouldDeriveNo ? { derived: true } : {}),
                  };
                }

                return { ...base, series };
              }

              if (row.market_venue === "polymarket") {
                const historyBySide: { YES?: unknown; NO?: unknown } = {};
                const fetches: Array<Promise<void>> = [];

                if (includeYes && tokens.yes) {
                  fetches.push(
                    polymarketClient
                      .getPriceHistory(tokens.yes, {
                        startTs: resolvedStartTs,
                        endTs: resolvedEndTs,
                        interval: "max",
                        fidelity: intervalInfo.baseMinutes,
                      })
                      .then((history) => {
                        historyBySide.YES = history;
                      }),
                  );
                }

                if (includeNo && tokens.no) {
                  fetches.push(
                    polymarketClient
                      .getPriceHistory(tokens.no, {
                        startTs: resolvedStartTs,
                        endTs: resolvedEndTs,
                        interval: "max",
                        fidelity: intervalInfo.baseMinutes,
                      })
                      .then((history) => {
                        historyBySide.NO = history;
                      }),
                  );
                }

                await Promise.all(fetches);

                const normalize = (payload: unknown) => {
                  const rawCandles = parsePolymarketCandlesticks(payload);
                  if (
                    intervalInfo.normalizedMinutes === intervalInfo.baseMinutes
                  ) {
                    return rawCandles;
                  }
                  return aggregateKalshiCandlesticks(
                    rawCandles,
                    intervalInfo.normalizedMinutes,
                    resolvedStartTs,
                    resolvedEndTs,
                  );
                };

                const series: Record<string, unknown> = {};
                if (includeYes && historyBySide.YES) {
                  series.YES = {
                    tokenId: tokens.yes ?? null,
                    candles: normalize(historyBySide.YES),
                  };
                }
                if (includeNo && historyBySide.NO) {
                  series.NO = {
                    tokenId: tokens.no ?? null,
                    candles: normalize(historyBySide.NO),
                  };
                }

                return { ...base, series };
              }

              return { ...base, series: {} };
            }),
          );

          const response = {
            ok: true,
            venue: event.event_venue,
            eventId: event.event_id,
            interval: {
              requestedMinutes: intervalInfo.requestedMinutes,
              normalizedMinutes: intervalInfo.normalizedMinutes,
              baseMinutes: intervalInfo.baseMinutes,
              startTs: resolvedStartTs,
              endTs: resolvedEndTs,
            },
            limit: resolvedLimit,
            rankedBy: "yesProbability",
            markets,
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

        if (event.event_venue === "kalshi") {
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

        if (event.event_venue === "limitless") {
          if (startTs == null || endTs == null || periodInterval == null) {
            reply.code(400);
            return reply.send({
              error: "startTs, endTs, and periodInterval are required.",
            });
          }

          const representative = selectLimitlessRepresentative(rows);
          if (!representative) {
            reply.code(400);
            return reply.send({
              error: "No Limitless markets available for this event.",
            });
          }

          const slug =
            representative.market_slug ??
            representative.venue_market_id ??
            null;
          if (!slug) {
            reply.code(400);
            return reply.send({ error: "Missing Limitless market slug." });
          }

          const requestedInterval = periodInterval;
          const baseInterval = resolveLimitlessBaseInterval(requestedInterval);
          const shouldAggregate = shouldAggregateLimitlessCandles(
            requestedInterval,
            baseInterval.minutes,
          );

          const query = new URLSearchParams({
            from: new Date(startTs * 1000).toISOString(),
            to: new Date(endTs * 1000).toISOString(),
            interval: baseInterval.interval,
          });

          const upstream = await limitlessRequest({
            method: "GET",
            requestPath: `/markets/${encodeURIComponent(
              slug,
            )}/historical-price?${query.toString()}`,
          });

          if (!upstream.ok) {
            reply.code(502);
            return reply.send({
              error: "Limitless candlesticks fetch failed",
              status: upstream.status,
              message: extractLimitlessMessage(upstream.payload),
              payload: upstream.payload,
            });
          }

          const rawCandles = parseLimitlessCandlesticks(
            upstream.payload,
            "YES",
          );
          const shouldDeriveNo =
            isLimitlessSingleSeriesPayload(upstream.payload) &&
            rawCandles.length > 0;
          const yesCandles = shouldAggregate
            ? aggregateKalshiCandlesticks(
                rawCandles,
                requestedInterval,
                startTs,
                endTs,
              )
            : rawCandles;
          const noCandles = shouldDeriveNo
            ? deriveNoCandlesticksFromYes(yesCandles)
            : shouldAggregate
              ? aggregateKalshiCandlesticks(
                  parseLimitlessCandlesticks(upstream.payload, "NO"),
                  requestedInterval,
                  startTs,
                  endTs,
                )
              : parseLimitlessCandlesticks(upstream.payload, "NO");
          const data = formatKalshiCandlesticks(
            (side ?? "YES") === "NO" ? noCandles : yesCandles,
          );

          const response = {
            ok: true,
            venue: "limitless",
            eventId: event.event_id,
            marketId: representative.market_id,
            ticker: slug,
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
