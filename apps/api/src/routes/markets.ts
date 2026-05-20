import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createHash } from "crypto";
import { RESP_TYPES } from "redis";
import { getRedis } from "../redis.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { resolveSecurityClientIp } from "../lib/request-ip.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import { isRecord } from "../lib/type-guards.js";
import {
  parseMetadata,
  pickString,
  resolveEventDescription,
  resolveMarketDescription,
} from "../lib/metadata-description.js";
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
import {
  fetchMarketDetails,
  fetchMarketsByTokenIds,
} from "../repos/unified-read.js";
import {
  dflowRequest,
  extractDflowErrorMessage,
} from "../services/dflow-client.js";
import {
  type AggMarketClient,
  AggMarketHttpError,
  createAggMarketClient,
} from "../services/agg-market-client.js";
import { getAggMarketAlternativesResponseCached } from "../services/agg-market-clusters.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "../services/limitless-client.js";
import { mapMarketsByTokenRows } from "../services/markets-by-token-response.js";
import { polymarketClient } from "../services/polymarket-client.js";
import { candlesticksQuerySchema } from "../schemas/candlesticks.js";
import {
  marketAlternativesQuerySchema,
  marketParamsSchema,
  marketsByTokenQuerySchema,
  marketSimilarQuerySchema,
} from "../schemas/market.js";
import type { DbQuery } from "../db.js";

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

function isExpiredAt(value: unknown, nowSec: number): boolean {
  const ts = parseTimestampSeconds(value);
  return ts != null && ts <= nowSec;
}

type LimitlessMeta = {
  negRiskRequestId?: string;
  negRiskMarketId?: string;
  venueAdapter?: string;
  venueExchange?: string;
  marketAddress?: string;
  tradeType?: string;
};

function pickFirstString(
  obj: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = pickString(obj, key);
    if (value) return value;
  }
  return undefined;
}

function pickVenueField(
  obj: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (!obj) return undefined;
  const venue = obj.venue;
  if (!isRecord(venue)) return undefined;
  const value = venue[key];
  return typeof value === "string" && value.trim().length ? value : undefined;
}

function extractLimitlessMeta(
  marketMeta: unknown,
  eventMeta: unknown,
): LimitlessMeta {
  const market = parseMetadata(marketMeta);
  const event = parseMetadata(eventMeta);
  const venueExchange =
    pickFirstString(market, [
      "venueExchange",
      "exchangeAddress",
      "exchange",
      "negRiskExchange",
    ]) ??
    pickVenueField(market, "exchange") ??
    pickVenueField(market, "exchangeAddress") ??
    pickFirstString(event, [
      "venueExchange",
      "exchangeAddress",
      "exchange",
      "negRiskExchange",
    ]) ??
    pickVenueField(event, "exchange") ??
    pickVenueField(event, "exchangeAddress");

  return {
    negRiskRequestId: pickString(market, "negRiskRequestId"),
    negRiskMarketId:
      pickString(market, "negRiskMarketId") ??
      pickString(event, "negRiskMarketId"),
    venueAdapter:
      pickString(market, "venueAdapter") ?? pickString(event, "venueAdapter"),
    venueExchange,
    marketAddress: pickString(market, "address"),
    tradeType: pickString(market, "tradeType"),
  };
}

type MarketRoutesOptions = {
  aggMarketAppId?: string;
  aggMarketBaseUrl?: string;
  aggMarketTimeoutMs?: number;
  aggMarketAlternativesCacheTtlSec?: number;
  aggMarketAlternativesDb?: DbQuery;
  createAggMarketClient?: (config: {
    appId: string;
    baseUrl?: string;
    timeoutMs?: number;
  }) => AggMarketClient;
};

function extractTokenIdsFromTokenPair(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return [value.yes, value.no].filter(
    (tokenId): tokenId is string =>
      typeof tokenId === "string" && tokenId.length > 0,
  );
}

function enqueuePriceRefreshFromCachedMarket(cachedData: string): void {
  try {
    const parsed = JSON.parse(cachedData) as unknown;
    if (!isRecord(parsed)) return;
    const tokenIds = extractTokenIdsFromTokenPair(parsed.tokens);
    if (tokenIds.length) void requestPriceRefreshForTokens({ tokenIds });
  } catch {
    // Ignore stale or non-JSON cache entries.
  }
}

export const marketRoutes: FastifyPluginAsync<MarketRoutesOptions> = async (
  app,
  options,
) => {
  const z = app.withTypeProvider<ZodTypeProvider>();
  const createAggClient =
    options.createAggMarketClient ?? createAggMarketClient;
  const aggAlternativesDb = options.aggMarketAlternativesDb ?? pool;

  /**
   * GET /markets/by-token
   * Get market summaries for a list of token IDs
   */
  z.get(
    "/markets/by-token",
    { schema: { querystring: marketsByTokenQuerySchema } },
    async (request, reply) => {
      const { tokenIds, venue, includeTop } = request.query;

      if (tokenIds.length > 200) {
        reply.code(400);
        return reply.send({
          error: "tokenIds length exceeded",
          message: "Max 200 tokenIds allowed per request.",
        });
      }

      try {
        const startedAt = Date.now();
        const rows = await fetchMarketsByTokenIds(pool, {
          tokenIds,
          venue,
          includeTop,
        });
        const durationMs = Date.now() - startedAt;
        if (durationMs > 2000) {
          app.log.warn(
            {
              durationMs,
              tokenCount: tokenIds.length,
              tokenSample: tokenIds.slice(0, 8),
              venue,
            },
            "Markets by token slow",
          );
        }
        const response = mapMarketsByTokenRows(rows);

        if (tokenIds.length) {
          void markHotTokens({ tokenIds });
          void requestPriceRefreshForTokens({ tokenIds });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ data: response });
      } catch (error) {
        const err = error as { code?: unknown } | null;
        const timeout = err?.code === "57014";
        app.log.error(
          {
            error,
            tokenCount: tokenIds.length,
            tokenSample: tokenIds.slice(0, 8),
            venue,
            timeout,
          },
          timeout
            ? "Markets by token timed out"
            : "Markets by token fetch failed",
        );
        reply.code(500);
        return reply.send({
          error: "Internal server error",
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
      const clientIp = resolveSecurityClientIp(request);
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
          enqueuePriceRefreshFromCachedMarket(cachedData);
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
        const marketMetadata = parseMetadata(market.market_metadata);
        const eventMetadata = parseMetadata(market.event_metadata);
        const limitlessMeta =
          market.venue === "limitless"
            ? extractLimitlessMeta(marketMetadata, eventMetadata)
            : null;
        const isLimitlessNegRisk = Boolean(
          limitlessMeta?.negRiskRequestId ||
          limitlessMeta?.negRiskMarketId ||
          limitlessMeta?.venueAdapter ||
          limitlessMeta?.venueExchange,
        );

        const clobTokenIdsRaw =
          market.clob_token_ids ?? market.pm_clob_token_ids ?? null;

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
          marketDescription: resolveMarketDescription(
            market.market_description,
            marketMetadata,
          ),
          marketMetadata,
          marketType: market.market_type,
          tradeType:
            market.venue === "limitless"
              ? (limitlessMeta?.tradeType ?? null)
              : null,
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
          clobTokenIds: clobTokenIdsRaw != null ? clobTokenIdsRaw : null,
          orderPriceMinTickSize:
            market.pm_order_price_min_tick_size != null
              ? Number(market.pm_order_price_min_tick_size)
              : null,
          orderMinSize:
            market.pm_order_min_size != null
              ? Number(market.pm_order_min_size)
              : null,
          acceptingOrders: computeAcceptingOrders({
            venue: market.venue,
            status: market.market_status,
            closeTime: market.close_time,
            expirationTime: market.expiration_time,
            pmAcceptingOrders: market.pm_accepting_orders,
            dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(
              market.market_metadata,
            ),
          }),
          negRisk:
            market.venue === "polymarket"
              ? market.pm_neg_risk != null
                ? Boolean(market.pm_neg_risk)
                : null
              : market.venue === "limitless"
                ? isLimitlessNegRisk
                : null,
          negRiskMarketId:
            market.venue === "limitless"
              ? (limitlessMeta?.negRiskMarketId ?? null)
              : market.pm_neg_risk_market_id || null,
          negRiskParentConditionId:
            market.venue === "polymarket"
              ? market.pm_neg_risk_parent_condition_id || null
              : null,
          negRiskRequestId:
            market.venue === "limitless"
              ? (limitlessMeta?.negRiskRequestId ?? null)
              : market.pm_neg_risk_request_id || null,
          negRiskAdapter:
            market.venue === "limitless"
              ? (limitlessMeta?.venueAdapter ?? null)
              : null,
          negRiskExchange:
            market.venue === "limitless"
              ? (limitlessMeta?.venueExchange ?? null)
              : null,
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
          marketAddress:
            market.venue === "limitless"
              ? (limitlessMeta?.marketAddress ?? null)
              : null,
          createdAt: market.created_at,
          updatedAt: market.updated_at,
          event: {
            eventId: market.event_id,
            eventTitle: market.event_title,
            eventDescription: resolveEventDescription(
              market.event_description,
              eventMetadata,
            ),
            eventMetadata,
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
            negRiskMarketId:
              market.venue === "limitless"
                ? (limitlessMeta?.negRiskMarketId ?? null)
                : null,
            negRiskAdapter:
              market.venue === "limitless"
                ? (limitlessMeta?.venueAdapter ?? null)
                : null,
          },
        };

        const tokenIds = [tokens.yes, tokens.no].filter(
          (tokenId): tokenId is string => Boolean(tokenId),
        );
        if (tokenIds.length) {
          void markHotTokens({ tokenIds });
          void requestPriceRefreshForTokens({ tokenIds });
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
        });
      }
    },
  );

  /**
   * GET /markets/:marketId/alternatives
   * Get exact cross-venue alternatives using AGG matched markets.
   */
  z.get(
    "/markets/:marketId/alternatives",
    {
      schema: {
        params: marketParamsSchema,
        querystring: marketAlternativesQuerySchema,
      },
    },
    async (request, reply) => {
      const aggMarketAppId = options.aggMarketAppId ?? env.aggMarketAppId;
      if (!aggMarketAppId) {
        return reply.code(503).send({ error: "AGG Market is not configured" });
      }

      try {
        const client = createAggClient({
          appId: aggMarketAppId,
          baseUrl: options.aggMarketBaseUrl ?? env.aggMarketBaseUrl,
          timeoutMs: options.aggMarketTimeoutMs ?? env.aggMarketTimeoutMs,
        });
        const response = await getAggMarketAlternativesResponseCached({
          marketId: request.params.marketId,
          query: request.query,
          client,
          db: aggAlternativesDb,
          ttlSec:
            options.aggMarketAlternativesCacheTtlSec ??
            env.aggClustersCacheTtlSec,
        });
        if (!response) {
          return reply.code(404).send({ error: "Market not found" });
        }
        return response;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("Unsupported AGG venues:")
        ) {
          return reply.code(400).send({ error: error.message });
        }
        if (error instanceof AggMarketHttpError) {
          request.log.warn(
            { status: error.status },
            "AGG Market alternatives request failed",
          );
          return reply
            .code(error.status >= 500 ? 502 : 400)
            .send({ error: "AGG Market request failed" });
        }
        if (error instanceof Error && error.name === "AbortError") {
          request.log.warn("AGG Market alternatives request timed out");
          return reply
            .code(504)
            .send({ error: "AGG Market request timed out" });
        }
        request.log.error({ error }, "AGG Market alternatives build failed");
        return reply
          .code(500)
          .send({ error: "Failed to build market alternatives" });
      }
    },
  );

  /**
   * GET /markets/:marketId/similar
   * Get similar markets using Redis vector search
   */
  z.get(
    "/markets/:marketId/similar",
    {
      schema: {
        params: marketParamsSchema,
        querystring: marketSimilarQuerySchema,
      },
    },
    async (request, reply) => {
      const { marketId } = request.params;
      const {
        limit,
        venue,
        activeOnly,
        cutoff,
        excludeMarkets,
        excludeEvents,
      } = request.query;
      const cappedLimit = Math.min(200, Math.max(1, limit ?? 20));
      const active = activeOnly ?? true;
      const maxScore =
        cutoff != null && Number.isFinite(cutoff) ? cutoff : undefined;
      const excludeMarketSet = new Set(
        (excludeMarkets ?? []).filter((entry) => entry !== marketId),
      );
      const excludeEventSet = new Set(excludeEvents ?? []);
      let baseEventId: string | null = null;
      let baseSeriesKey: string | null = null;

      const redis = await getRedis();
      if (!redis) {
        return reply.send({ items: [], cache_status: "disabled" as const });
      }

      const bufferClient = redis.withTypeMapping({
        [RESP_TYPES.BLOB_STRING]: Buffer,
      });
      const [embeddingRaw, textHashRaw, embedVersionRaw] =
        await bufferClient.hmGet(`ai:embed:market:${marketId}`, [
          "embedding",
          "text_hash",
          "embedding_version",
        ]);
      const embedding = Buffer.isBuffer(embeddingRaw) ? embeddingRaw : null;
      if (!embedding) {
        return reply.send({ items: [], cache_status: "miss" as const });
      }

      try {
        const { rows } = await pool.query(
          `
          select m.event_id as event_id, e.series_key as series_key
          from unified_markets m
          left join unified_events e on e.id = m.event_id
          where m.id = $1
          limit 1;
        `,
          [marketId],
        );
        if (rows.length) {
          baseEventId = rows[0].event_id ?? null;
          baseSeriesKey = rows[0].series_key ?? null;
          if (baseEventId) excludeEventSet.add(baseEventId);
        }
      } catch (err) {
        app.log.warn(
          { err, marketId },
          "Similar markets base event lookup failed",
        );
      }

      const textHash = textHashRaw
        ? Buffer.isBuffer(textHashRaw)
          ? textHashRaw.toString()
          : String(textHashRaw)
        : "";
      const embeddingVersion = embedVersionRaw
        ? Buffer.isBuffer(embedVersionRaw)
          ? embedVersionRaw.toString()
          : String(embedVersionRaw)
        : "";
      const cacheTtlSec = env.similarMarketsCacheTtlSec;
      const cacheHash = createHash("sha256")
        .update(
          JSON.stringify({
            textHash,
            embeddingVersion,
            limit: cappedLimit,
            active,
            venue: venue ?? "",
            maxScore: maxScore ?? null,
            seriesKey: baseSeriesKey ?? "",
            excludeMarkets: Array.from(excludeMarketSet).sort(),
            excludeEvents: Array.from(excludeEventSet).sort(),
          }),
        )
        .digest("hex")
        .slice(0, 16);
      const cacheKey = `ai:similar:market:${marketId}:${cacheHash}`;

      if (cacheTtlSec > 0) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          try {
            const items = JSON.parse(cached) as Array<{
              id: string;
              score: number;
            }>;
            return reply.send({
              items,
              cache_status: "hit" as const,
              cache_source: "cache",
            });
          } catch {
            // fall through to recompute
          }
        }
      }

      const filters: string[] = [];
      if (active) filters.push("@status:{ACTIVE}");
      if (venue) filters.push(`@venue:{${venue}}`);
      const filterClause = filters.length ? `(${filters.join(" ")})` : "*";
      const query = `${filterClause}=>[KNN ${cappedLimit} @embedding $vec AS score]`;

      try {
        const raw = (await redis.sendCommand([
          "FT.SEARCH",
          "idx:ai:embed:market",
          query,
          "PARAMS",
          "2",
          "vec",
          embedding,
          "SORTBY",
          "score",
          "RETURN",
          "1",
          "score",
          "LIMIT",
          "0",
          String(cappedLimit),
          "DIALECT",
          "2",
        ])) as unknown[];

        const items: Array<{ id: string; score: number }> = [];
        for (let i = 1; i < raw.length; i += 2) {
          const key = raw[i];
          const fields = raw[i + 1] as unknown[];
          const id = String(key).replace("ai:embed:market:", "");
          if (id === marketId) continue;
          let score = Number.POSITIVE_INFINITY;
          for (let j = 0; j < fields.length; j += 2) {
            if (String(fields[j]) === "score") {
              score = Number(fields[j + 1]);
              break;
            }
          }
          if (!Number.isFinite(score)) continue;
          items.push({ id, score });
        }

        let filteredItems =
          maxScore != null
            ? items.filter((item) => item.score <= maxScore)
            : items;

        if (excludeMarketSet.size > 0) {
          filteredItems = filteredItems.filter(
            (item) => !excludeMarketSet.has(item.id),
          );
        }

        let eventById: Map<string, string | null> | null = null;
        if (
          (excludeEventSet.size > 0 || baseSeriesKey || active) &&
          filteredItems.length > 0
        ) {
          const ids = filteredItems.map((item) => item.id);
          const nowSec = Math.floor(Date.now() / 1000);
          const { rows } = await pool.query(
            `
            select m.id, m.event_id, m.close_time, m.expiration_time, e.end_date
            from unified_markets m
            left join unified_events e on e.id = m.event_id
            where m.id = any($1)
          `,
            [ids],
          );
          eventById = new Map<string, string | null>(
            rows.map((row) => [
              row.id as string,
              row.event_id as string | null,
            ]),
          );
          if (active && rows.length > 0) {
            const expiredMarketIds = new Set<string>();
            for (const row of rows) {
              if (
                isExpiredAt(row.close_time, nowSec) ||
                isExpiredAt(row.expiration_time, nowSec) ||
                isExpiredAt(row.end_date, nowSec)
              ) {
                expiredMarketIds.add(row.id as string);
              }
            }
            if (expiredMarketIds.size > 0) {
              filteredItems = filteredItems.filter(
                (item) => !expiredMarketIds.has(item.id),
              );
            }
          }
          if (excludeEventSet.size > 0) {
            filteredItems = filteredItems.filter((item) => {
              const eventId = eventById?.get(item.id);
              if (!eventId) return true;
              return !excludeEventSet.has(eventId);
            });
          }
        }

        if (baseSeriesKey && filteredItems.length > 0 && eventById) {
          const eventIds = Array.from(
            new Set(
              filteredItems
                .map((item) => eventById?.get(item.id))
                .filter(Boolean),
            ),
          ) as string[];
          if (eventIds.length) {
            const { rows } = await pool.query(
              `select id, series_key from unified_events where id = any($1)`,
              [eventIds],
            );
            const seriesByEvent = new Map<string, string | null>(
              rows.map((row) => [
                row.id as string,
                row.series_key as string | null,
              ]),
            );
            filteredItems = filteredItems.filter((item) => {
              const eventId = eventById?.get(item.id);
              if (!eventId) return true;
              return seriesByEvent.get(eventId) !== baseSeriesKey;
            });
          }
        }

        if (cacheTtlSec > 0) {
          await redis.set(cacheKey, JSON.stringify(filteredItems), {
            EX: cacheTtlSec,
          });
        }

        return reply.send({
          items: filteredItems,
          cache_status: "hit" as const,
          cache_source: "knn",
        });
      } catch (err) {
        app.log.warn({ err, marketId }, "Similar markets lookup failed");
        return reply.send({ items: [], cache_status: "error" as const });
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
      const {
        startTs,
        endTs,
        periodInterval,
        interval,
        fidelity,
        side,
        sides,
        format,
      } = request.query;

      const clientIp = resolveSecurityClientIp(request);
      const rateLimitKey = `candlesticks:market:${clientIp}`;
      const canProceed = await checkRateLimit(rateLimitKey, 60, 60000);
      if (!canProceed) {
        reply.code(429);
        return reply.send({
          error: "Client rate limit exceeded. Please try again later.",
        });
      }

      const cacheKey = `candlesticks:market:${marketId}:${startTs ?? ""}:${endTs ?? ""}:${periodInterval ?? ""}:${interval ?? ""}:${fidelity ?? ""}:${side ?? ""}:${sides ?? ""}:${format ?? ""}`;
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
          const includeNo =
            requestedSides === "NO" || requestedSides === "BOTH";

          const resolvedStartTs =
            startTs ?? parseTimestampSeconds(market.open_time);
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

          if (market.venue === "kalshi") {
            if (requestedMinutes == null) {
              reply.code(400);
              return reply.send({
                error: "periodInterval or interval is required.",
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

            const intervalInfo = resolveBaseIntervalWithCap({
              startTs: resolvedStartTs,
              endTs: resolvedEndTs,
              requestedMinutes,
              supportedMinutes: [1, 60, 1440],
            });

            const upstream = await dflowRequest({
              baseUrl: env.dflowPredictionMarketsBase,
              timeoutMs: 15_000,
              method: "GET",
              requestPath: `/api/v1/market/${encodeURIComponent(
                market.venue_market_id,
              )}/candlesticks`,
              apiKey: env.dflowApiKey,
              query: {
                startTs: resolvedStartTs,
                endTs: resolvedEndTs,
                periodInterval: intervalInfo.baseMinutes,
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

            const rawCandles = parseKalshiCandlesticks(upstream.payload);
            const normalizedCandles =
              intervalInfo.normalizedMinutes === intervalInfo.baseMinutes
                ? rawCandles.filter(
                    (candle) =>
                      candle.t >= resolvedStartTs && candle.t <= resolvedEndTs,
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
                tokenId: market.token_yes ?? null,
                candles: normalizedCandles,
              };
            }
            if (includeNo) {
              series.NO = {
                tokenId: market.token_no ?? null,
                candles: deriveNoCandlesticksFromYes(normalizedCandles),
                derived: true,
              };
            }

            const data =
              intervalInfo.normalizedMinutes === intervalInfo.baseMinutes
                ? upstream.payload
                : formatKalshiCandlesticks(normalizedCandles);

            const response = {
              ok: true,
              venue: "kalshi",
              marketId: market.market_id,
              ticker: market.venue_market_id,
              data,
              interval: {
                requestedMinutes: intervalInfo.requestedMinutes,
                normalizedMinutes: intervalInfo.normalizedMinutes,
                baseMinutes: intervalInfo.baseMinutes,
                startTs: resolvedStartTs,
                endTs: resolvedEndTs,
              },
              series,
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

          if (market.venue === "limitless") {
            if (requestedMinutes == null) {
              reply.code(400);
              return reply.send({
                error: "periodInterval or interval is required.",
              });
            }

            const slug = market.slug ?? market.venue_market_id ?? null;
            if (!slug) {
              reply.code(400);
              return reply.send({ error: "Missing Limitless market slug." });
            }

            const intervalInfo = resolveBaseIntervalWithCap({
              startTs: resolvedStartTs,
              endTs: resolvedEndTs,
              requestedMinutes,
              supportedMinutes: [1, 60, 360, 1440, 10080],
            });
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
              reply.code(502);
              return reply.send({
                error: "Limitless candlesticks fetch failed",
                status: upstream.status,
                message: extractLimitlessMessage(upstream.payload),
                payload: upstream.payload,
              });
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
                      candle.t >= resolvedStartTs && candle.t <= resolvedEndTs,
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
                tokenId: market.token_yes ?? null,
                candles: yesCandles,
              };
            }
            if (includeNo) {
              series.NO = {
                tokenId: market.token_no ?? null,
                candles: noCandles,
                ...(shouldDeriveNo ? { derived: true } : {}),
              };
            }

            const legacySide = side ?? "YES";
            const legacyCandles = legacySide === "NO" ? noCandles : yesCandles;
            const data = formatKalshiCandlesticks(legacyCandles);

            const response = {
              ok: true,
              venue: "limitless",
              marketId: market.market_id,
              ticker: slug,
              data,
              interval: {
                requestedMinutes: intervalInfo.requestedMinutes,
                normalizedMinutes: intervalInfo.normalizedMinutes,
                baseMinutes: intervalInfo.baseMinutes,
                startTs: resolvedStartTs,
                endTs: resolvedEndTs,
              },
              series,
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

            const yesTokenId = tokenIds[0] ?? null;
            const noTokenId = tokenIds[1] ?? null;

            const intervalInfo = resolveBaseIntervalWithCap({
              startTs: resolvedStartTs,
              endTs: resolvedEndTs,
              requestedMinutes,
            });

            const historyBySide: {
              YES?: unknown;
              NO?: unknown;
            } = {};
            const fetches: Array<Promise<void>> = [];

            if (includeYes && yesTokenId) {
              fetches.push(
                polymarketClient
                  .getPriceHistory(yesTokenId, {
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

            if (includeNo && noTokenId) {
              fetches.push(
                polymarketClient
                  .getPriceHistory(noTokenId, {
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
              if (intervalInfo.normalizedMinutes === intervalInfo.baseMinutes) {
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
                tokenId: yesTokenId,
                candles: normalize(historyBySide.YES),
              };
            }
            if (includeNo && historyBySide.NO) {
              series.NO = {
                tokenId: noTokenId,
                candles: normalize(historyBySide.NO),
              };
            }

            const legacySide = side ?? "YES";
            const legacyHistory =
              legacySide === "NO"
                ? (historyBySide.NO ?? historyBySide.YES)
                : (historyBySide.YES ?? historyBySide.NO);
            if (!legacyHistory) {
              reply.code(400);
              return reply.send({
                error: "Missing Polymarket price history for requested side.",
              });
            }

            const legacyTokenId =
              legacySide === "NO" ? (noTokenId ?? yesTokenId) : yesTokenId;

            const response = {
              ok: true,
              venue: "polymarket",
              marketId: market.market_id,
              tokenId: legacyTokenId ?? undefined,
              side: legacySide,
              data: legacyHistory,
              interval: {
                requestedMinutes: intervalInfo.requestedMinutes,
                normalizedMinutes: intervalInfo.normalizedMinutes,
                baseMinutes: intervalInfo.baseMinutes,
                startTs: resolvedStartTs,
                endTs: resolvedEndTs,
              },
              series,
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
        }

        if (market.venue === "kalshi") {
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

          const requestedInterval = periodInterval;
          const shouldAggregate =
            shouldAggregateKalshiCandles(requestedInterval);
          const baseInterval = shouldAggregate
            ? resolveKalshiBaseInterval(requestedInterval)
            : requestedInterval;

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
            marketId: market.market_id,
            ticker: market.venue_market_id,
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

        if (market.venue === "limitless") {
          if (startTs == null || endTs == null || periodInterval == null) {
            reply.code(400);
            return reply.send({
              error: "startTs, endTs, and periodInterval are required.",
            });
          }

          const slug = market.slug ?? market.venue_market_id ?? null;
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
            marketId: market.market_id,
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
        });
      }
    },
  );
};
