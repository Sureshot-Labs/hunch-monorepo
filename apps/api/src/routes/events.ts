import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createHash } from "crypto";
import { RESP_TYPES } from "redis";
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
import {
  eventParamsSchema,
  eventSeriesQuerySchema,
  eventSimilarQuerySchema,
} from "../schemas/event.js";
import type { TokenPair } from "../server-types.js";

type PolymarketRepresentative = {
  row: EventDetailsRow;
  tokens: TokenPair;
};

type SimilarEventMarketSummary = {
  marketId: string;
  eventId: string;
  venue: string | null;
  eventTitle: string | null;
  marketTitle: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  lastPrice: number | null;
};

function parseEmbeddingBuffer(buffer: Buffer): Float32Array | null {
  if (buffer.byteLength % 4 !== 0) return null;
  const aligned = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(aligned).set(buffer);
  return new Float32Array(aligned);
}

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

async function fetchSimilarMarketSummaries(
  marketIds: string[],
  activeOnly: boolean,
): Promise<SimilarEventMarketSummary[]> {
  if (!marketIds.length) return [];
  const uniqueIds = Array.from(new Set(marketIds));
  const nowSec = Math.floor(Date.now() / 1000);
  const { rows } = await pool.query<{
    market_id: string;
    event_id: string;
    venue: string | null;
    event_title: string | null;
    market_title: string | null;
    best_bid: unknown;
    best_ask: unknown;
    last_price: unknown;
    close_time: unknown;
    expiration_time: unknown;
    end_date: unknown;
  }>(
    `
      select
        m.id as market_id,
        m.event_id,
        m.venue,
        e.title as event_title,
        m.title as market_title,
        m.best_bid,
        m.best_ask,
        m.last_price,
        m.close_time,
        m.expiration_time,
        e.end_date
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where m.id = any($1::text[])
      ${activeOnly ? "and m.status = 'ACTIVE' and e.status = 'ACTIVE'" : ""}
    `,
    [uniqueIds],
  );

  const filteredRows = activeOnly
    ? rows.filter(
        (row) =>
          !isExpiredAt(row.close_time, nowSec) &&
          !isExpiredAt(row.expiration_time, nowSec) &&
          !isExpiredAt(row.end_date, nowSec),
      )
    : rows;

  return filteredRows.map((row) => ({
    marketId: row.market_id,
    eventId: row.event_id,
    venue: row.venue ?? null,
    eventTitle: row.event_title ?? null,
    marketTitle: row.market_title ?? null,
    bestBid: toNumber(row.best_bid),
    bestAsk: toNumber(row.best_ask),
    lastPrice: toNumber(row.last_price),
  }));
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
   * GET /events/:eventId/series
   * Get series-level sibling events for a given event.
   */
  z.get(
    "/events/:eventId/series",
    { schema: { params: eventParamsSchema, querystring: eventSeriesQuerySchema } },
    async (request, reply) => {
      const { eventId } = request.params;
      const { statuses } = request.query;

      const base = await pool.query(
        `
          select
            id,
            venue,
            venue_event_id,
            title,
            slug,
            series_key,
            series_title
          from unified_events
          where id = $1
        `,
        [eventId],
      );

      if (base.rows.length === 0) {
        reply.code(404);
        return reply.send({ error: "Event not found" });
      }

      const row = base.rows[0] as {
        id: string;
        venue: string;
        venue_event_id: string;
        title: string;
        slug: string | null;
        series_key: string | null;
        series_title: string | null;
      };

      if (!row.series_key) {
        return reply.send({
          eventId: row.id,
          venue: row.venue,
          seriesKey: null,
          seriesTitle: null,
          events: [],
        });
      }

      const allowedStatuses = new Set([
        "ACTIVE",
        "CLOSED",
        "SETTLED",
        "ARCHIVED",
      ]);
      const parsedStatuses = typeof statuses === "string" ? statuses : "";
      const requested = parsedStatuses
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map((value) => value.toUpperCase());
      const invalid = requested.filter((value) => !allowedStatuses.has(value));

      if (invalid.length > 0) {
        reply.code(400);
        return reply.send({
          error: "Invalid statuses filter",
          invalid,
        });
      }

      const statusFilter = (requested.length ? requested : ["ACTIVE"]) as string[];

      const seriesRows = await pool.query(
        `
          select
            id,
            venue_event_id,
            title,
            slug,
            start_date,
            end_date,
            status,
            image,
            icon
          from unified_events
          where venue = $1
            and series_key = $2
            and status = any($3::unified_status[])
          order by start_date nulls last, end_date nulls last, title asc
        `,
        [row.venue, row.series_key, statusFilter],
      );

      return reply.send({
        eventId: row.id,
        venue: row.venue,
        seriesKey: row.series_key,
        seriesTitle: row.series_title,
        events: seriesRows.rows.map((s) => ({
          eventId: s.id as string,
          venueEventId: s.venue_event_id as string,
          title: s.title as string,
          slug: (s.slug as string | null) ?? null,
          startTime: s.start_date ?? null,
          endTime: s.end_date ?? null,
          status: s.status as string,
          image: (s.image as string | null) ?? null,
          icon: (s.icon as string | null) ?? null,
        })),
      });
    },
  );

  /**
   * GET /events/:eventId/similar
   * Get similar events using Redis vector search
   */
  z.get(
    "/events/:eventId/similar",
    { schema: { params: eventParamsSchema, querystring: eventSimilarQuerySchema } },
    async (request, reply) => {
      const { eventId } = request.params;
      const {
        limit,
        venue,
        activeOnly,
        cutoff,
        excludeEvents,
        marketId,
        includeDetails,
      } = request.query;
      const cappedLimit = Math.min(200, Math.max(1, limit ?? 20));
      const active = activeOnly ?? true;
      const withDetails = includeDetails ?? false;
      const maxScore =
        cutoff != null && Number.isFinite(cutoff) ? cutoff : undefined;
      const now = new Date();
      const nowSec = Math.floor(now.getTime() / 1000);
      const excludeEventSet = new Set(
        (excludeEvents ?? []).filter((entry) => entry !== eventId),
      );
      excludeEventSet.add(eventId);

      const redis = await getRedis();
      if (!redis) {
        return reply.send({ items: [], cache_status: "disabled" as const });
      }

      const bufferClient = redis.withTypeMapping({
        [RESP_TYPES.BLOB_STRING]: Buffer,
      });
      const [embeddingRaw, textHashRaw, embedVersionRaw] =
        await bufferClient.hmGet(`ai:embed:event:${eventId}`, [
          "embedding",
          "text_hash",
          "embedding_version",
        ]);
      const embedding = Buffer.isBuffer(embeddingRaw) ? embeddingRaw : null;
      if (!embedding) {
        return reply.send({ items: [], cache_status: "miss" as const });
      }

      let baseSeriesKey: string | null = null;
      try {
        const { rows } = await pool.query(
          `select series_key from unified_events where id = $1 limit 1`,
          [eventId],
        );
        if (rows.length) {
          baseSeriesKey = rows[0].series_key ?? null;
        }
      } catch (err) {
        app.log.warn({ err, eventId }, "Similar events base series lookup failed");
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
            selectorVersion: "v7",
            textHash,
            embeddingVersion,
            limit: cappedLimit,
            active,
            venue: venue ?? "",
            maxScore: maxScore ?? null,
            marketId: marketId ?? "",
            seriesKey: baseSeriesKey ?? "",
            includeDetails: withDetails,
            excludeEvents: Array.from(excludeEventSet).sort(),
          }),
        )
        .digest("hex")
        .slice(0, 16);
      const cacheKey = `ai:similar:event:${eventId}:${cacheHash}`;

      if (cacheTtlSec > 0) {
        const cached = await redis.get(cacheKey);
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as
              | Array<{
                  eventId: string;
                  marketId: string | null;
                  score: number;
                }>
              | {
                  items: Array<{
                    eventId: string;
                    marketId: string | null;
                    score: number;
                  }>;
                  markets?: SimilarEventMarketSummary[];
                };
            const items = Array.isArray(parsed) ? parsed : parsed.items;
            const markets = Array.isArray(parsed) ? undefined : parsed.markets;
            return reply.send({
              items,
              markets: markets ?? undefined,
              cache_status: "hit" as const,
              cache_source: "cache",
            });
          } catch {
            // fall through to recompute
          }
        }
      }

      try {
        const baseMarketEmbeddingRaw =
          marketId != null
            ? (await bufferClient.hmGet(`ai:embed:market:${marketId}`, [
                "embedding",
              ]))[0]
            : null;
        const baseMarketBuffer = Buffer.isBuffer(baseMarketEmbeddingRaw)
          ? baseMarketEmbeddingRaw
          : null;
        const baseMarketVector = baseMarketBuffer
          ? parseEmbeddingBuffer(baseMarketBuffer)
          : null;

        if (marketId && baseMarketBuffer && baseMarketVector) {
          const filters: string[] = [];
          if (active) filters.push("@status:{ACTIVE}");
          if (venue) filters.push(`@venue:{${venue}}`);
          const filterClause = filters.length ? `(${filters.join(" ")})` : "*";
          const marketSearchLimit = Math.min(
            300,
            Math.max(50, cappedLimit * 25),
          );
          const query = `${filterClause}=>[KNN ${marketSearchLimit} @embedding $vec AS score]`;

          const raw = (await redis.sendCommand([
            "FT.SEARCH",
            "idx:ai:embed:market",
            query,
            "PARAMS",
            "2",
            "vec",
            baseMarketBuffer,
            "SORTBY",
            "score",
            "RETURN",
            "1",
            "score",
            "LIMIT",
            "0",
            String(marketSearchLimit),
            "DIALECT",
            "2",
          ])) as unknown[];

          const marketHits: Array<{ marketId: string; score: number }> = [];
          for (let i = 1; i < raw.length; i += 2) {
            const key = raw[i];
            const fields = raw[i + 1] as unknown[];
            const id = String(key).replace("ai:embed:market:", "");
            let score = Number.POSITIVE_INFINITY;
            for (let j = 0; j < fields.length; j += 2) {
              if (String(fields[j]) === "score") {
                score = Number(fields[j + 1]);
                break;
              }
            }
            if (!Number.isFinite(score)) continue;
            if (maxScore != null && score > maxScore) continue;
            marketHits.push({ marketId: id, score });
          }

          if (marketHits.length) {
            const marketIds = marketHits.map((item) => item.marketId);
            const { rows } = await pool.query(
              `
              select m.id as market_id,
                     m.event_id,
                     m.close_time,
                     m.expiration_time,
                     e.venue,
                     e.series_key,
                     e.status as event_status,
                     e.end_date
              from unified_markets m
              join unified_events e on e.id = m.event_id
              where m.id = any($1)
              ${active ? "and e.status = 'ACTIVE'" : ""}
              `,
              [marketIds],
            );

            const marketMeta = new Map<
              string,
              {
                eventId: string;
                venue: string | null;
                seriesKey: string | null;
                isExpired: boolean;
              }
            >();
            for (const row of rows) {
              const isExpired =
                active &&
                (isExpiredAt(row.close_time, nowSec) ||
                  isExpiredAt(row.expiration_time, nowSec) ||
                  isExpiredAt(row.end_date, nowSec));
              marketMeta.set(row.market_id as string, {
                eventId: row.event_id as string,
                venue: row.venue ?? null,
                seriesKey: row.series_key ?? null,
                isExpired,
              });
            }

            const bestByEvent = new Map<
              string,
              { marketId: string; score: number; venue: string | null }
            >();
            for (const hit of marketHits) {
              const meta = marketMeta.get(hit.marketId);
              if (!meta) continue;
              if (meta.isExpired) continue;
              if (excludeEventSet.has(meta.eventId)) continue;
              if (baseSeriesKey && meta.seriesKey === baseSeriesKey) continue;
              const current = bestByEvent.get(meta.eventId);
              if (!current || hit.score < current.score) {
                bestByEvent.set(meta.eventId, {
                  marketId: hit.marketId,
                  score: hit.score,
                  venue: meta.venue ?? null,
                });
              }
            }

            let eventItems = Array.from(bestByEvent.entries()).map(
              ([eventIdKey, best]) => ({
                eventId: eventIdKey,
                marketId: best.marketId,
                score: best.score,
                venue: best.venue ?? "unknown",
              }),
            );

            if (!venue && eventItems.length > 0) {
              const byVenue = new Map<
                string,
                Array<{ eventId: string; marketId: string; score: number; venue: string }>
              >();
              for (const item of eventItems) {
                const list = byVenue.get(item.venue) ?? [];
                list.push(item);
                byVenue.set(item.venue, list);
              }
              for (const list of byVenue.values()) {
                list.sort((a, b) => a.score - b.score);
              }
              const venueOrder = Array.from(byVenue.entries())
                .sort((a, b) => (a[1][0]?.score ?? 0) - (b[1][0]?.score ?? 0))
                .map(([v]) => v);
              const diversified: Array<{
                eventId: string;
                marketId: string;
                score: number;
                venue: string;
              }> = [];
              let added = true;
              while (added && diversified.length < eventItems.length) {
                added = false;
                for (const v of venueOrder) {
                  const list = byVenue.get(v);
                  if (!list || list.length === 0) continue;
                  const item = list.shift();
                  if (item) {
                    diversified.push(item);
                    added = true;
                  }
                }
              }
              eventItems = diversified;
            } else {
              eventItems.sort((a, b) => a.score - b.score);
            }

            const responseItems = eventItems.slice(0, cappedLimit).map((item) => ({
              eventId: item.eventId,
              marketId: item.marketId,
              score: item.score,
            }));

            const markets = withDetails
              ? await fetchSimilarMarketSummaries(
                  responseItems
                    .map((entry) => entry.marketId)
                    .filter(Boolean) as string[],
                  active,
                )
              : undefined;

            if (cacheTtlSec > 0) {
              const payload = withDetails
                ? {
                    items: responseItems,
                    markets,
                  }
                : responseItems;
              await redis.set(cacheKey, JSON.stringify(payload), {
                EX: cacheTtlSec,
              });
            }

            return reply.send({
              items: responseItems,
              markets,
              cache_status: "hit" as const,
              cache_source: "knn",
            });
          }
        }

        const searchVenues = venue
          ? [venue]
          : (["polymarket", "kalshi", "limitless"] as const);
        const perVenueLimit = venue
          ? cappedLimit
          : Math.min(
              200,
              Math.max(5, Math.ceil(cappedLimit / searchVenues.length) * 2),
            );

        const items: Array<{ eventId: string; score: number }> = [];
        for (const venueFilter of searchVenues) {
          const filters: string[] = [];
          if (active) filters.push("@status:{ACTIVE}");
          if (venueFilter) filters.push(`@venue:{${venueFilter}}`);
          const filterClause = filters.length ? `(${filters.join(" ")})` : "*";
          const query = `${filterClause}=>[KNN ${perVenueLimit} @embedding $vec AS score]`;

          const raw = (await redis.sendCommand([
            "FT.SEARCH",
            "idx:ai:embed:event",
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
            String(perVenueLimit),
            "DIALECT",
            "2",
          ])) as unknown[];

          for (let i = 1; i < raw.length; i += 2) {
            const key = raw[i];
            const fields = raw[i + 1] as unknown[];
            const id = String(key).replace("ai:embed:event:", "");
            if (excludeEventSet.has(id)) continue;
            let score = Number.POSITIVE_INFINITY;
            for (let j = 0; j < fields.length; j += 2) {
              if (String(fields[j]) === "score") {
                score = Number(fields[j + 1]);
                break;
              }
            }
            if (!Number.isFinite(score)) continue;
            items.push({ eventId: id, score });
          }
        }

        const uniqueByEvent = new Map<string, number>();
        for (const item of items) {
          const current = uniqueByEvent.get(item.eventId);
          if (current == null || item.score < current) {
            uniqueByEvent.set(item.eventId, item.score);
          }
        }
        const dedupedItems = Array.from(uniqueByEvent.entries()).map(
          ([eventId, score]) => ({ eventId, score }),
        );

        let filteredItems =
          maxScore != null
            ? dedupedItems.filter((item) => item.score <= maxScore)
            : dedupedItems;

        const eventIds = filteredItems.map((item) => item.eventId);
        const eventMeta = new Map<
          string,
          { venue: string | null; seriesKey: string | null; endDate: unknown }
        >();
        if (eventIds.length) {
          const { rows } = await pool.query(
            `
              select id, venue, series_key, end_date
              from unified_events
              where id = any($1)
            `,
            [eventIds],
          );
          for (const row of rows) {
            eventMeta.set(row.id as string, {
              venue: row.venue ?? null,
              seriesKey: row.series_key ?? null,
              endDate: row.end_date ?? null,
            });
          }
        }

        if (active && filteredItems.length > 0) {
          filteredItems = filteredItems.filter((item) => {
            const meta = eventMeta.get(item.eventId);
            if (!meta) return true;
            return !isExpiredAt(meta.endDate, nowSec);
          });
        }

        if (baseSeriesKey && filteredItems.length > 0) {
          filteredItems = filteredItems.filter((item) => {
            const meta = eventMeta.get(item.eventId);
            return meta?.seriesKey !== baseSeriesKey;
          });
        }

        if (!venue && filteredItems.length > 0) {
          const byVenue = new Map<string, Array<{ eventId: string; score: number }>>();
          for (const item of filteredItems) {
            const meta = eventMeta.get(item.eventId);
            const v = meta?.venue ?? "unknown";
            const list = byVenue.get(v) ?? [];
            list.push(item);
            byVenue.set(v, list);
          }
          for (const list of byVenue.values()) {
            list.sort((a, b) => a.score - b.score);
          }
          const venueOrder = Array.from(byVenue.entries())
            .sort((a, b) => (a[1][0]?.score ?? 0) - (b[1][0]?.score ?? 0))
            .map(([v]) => v);
          const diversified: Array<{ eventId: string; score: number }> = [];
          let added = true;
          while (added && diversified.length < filteredItems.length) {
            added = false;
            for (const v of venueOrder) {
              const list = byVenue.get(v);
              if (!list || list.length === 0) continue;
              const item = list.shift();
              if (item) {
                diversified.push(item);
                added = true;
              }
            }
          }
          filteredItems = diversified;
        }

        if (filteredItems.length > 0) {
          const candidateEventIds = filteredItems.map((item) => item.eventId);
          const marketFilterSql = `
            select distinct event_id
            from unified_markets
            where event_id = any($1)
            ${
              active
                ? "and status = 'ACTIVE' and (close_time is null or close_time > $2) and (expiration_time is null or expiration_time > $2)"
                : ""
            }
          `;
          const marketParams = active
            ? [candidateEventIds, now]
            : [candidateEventIds];
          const { rows } = await pool.query(marketFilterSql, marketParams);
          const eventIdsWithMarkets = new Set(
            rows.map((row) => row.event_id as string),
          );
          filteredItems = filteredItems.filter((item) =>
            eventIdsWithMarkets.has(item.eventId),
          );
        }

        const finalItems = filteredItems.slice(0, cappedLimit);
        const finalEventIds = finalItems.map((item) => item.eventId);
        const marketByEvent = new Map<string, string | null>();
        if (finalEventIds.length && baseMarketVector) {
          const marketVectorSql = `
            select m.id as market_id, m.event_id
            from unified_markets m
            where m.event_id = any($1)
            ${
              active
                ? "and m.status = 'ACTIVE' and (m.close_time is null or m.close_time > $2) and (m.expiration_time is null or m.expiration_time > $2)"
                : ""
            }
          `;
          const marketVectorParams = active
            ? [finalEventIds, now]
            : [finalEventIds];
          const { rows } = await pool.query(marketVectorSql, marketVectorParams);
          const embeddings = await Promise.all(
            rows.map((row) =>
              bufferClient.hmGet(`ai:embed:market:${row.market_id}`, [
                "embedding",
              ]),
            ),
          );

          const bestByEvent = new Map<
            string,
            { marketId: string; distance: number }
          >();
          for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            const res = embeddings[i] as Array<unknown> | null | undefined;
            const embeddingRaw = res?.[0];
            if (!Buffer.isBuffer(embeddingRaw)) continue;
            const vector = parseEmbeddingBuffer(embeddingRaw);
            if (!vector) continue;
            if (vector.length !== baseMarketVector.length) continue;
            let dot = 0;
            for (let j = 0; j < vector.length; j += 1) {
              dot += vector[j] * baseMarketVector[j];
            }
            const distance = 1 - dot;
            const current = bestByEvent.get(row.event_id as string);
            if (!current || distance < current.distance) {
              bestByEvent.set(row.event_id as string, {
                marketId: row.market_id as string,
                distance,
              });
            }
          }
          for (const [eventIdKey, best] of bestByEvent.entries()) {
            marketByEvent.set(eventIdKey, best.marketId);
          }
        }

        const missingEventIds = finalEventIds.filter(
          (id) => !marketByEvent.has(id),
        );
        if (missingEventIds.length) {
          const { rows } = await pool.query(
            `
            with ranked as (
              select
                m.event_id,
                m.id as market_id,
                row_number() over (
                  partition by m.event_id
                  order by
                    case
                      when lower(m.title) = lower(e.title) then 3
                      when lower(m.title) like lower(e.title) || '%' then 2
                      when lower(m.title) like '%' || lower(e.title) || '%' then 1
                      else 0
                    end desc,
                    m.volume_24h desc nulls last,
                    m.liquidity desc nulls last,
                    m.id asc
                ) as rn
              from unified_markets m
              join unified_events e on e.id = m.event_id
              where m.event_id = any($1)
                and m.status = 'ACTIVE'
                and (m.close_time is null or m.close_time > $2)
                and (m.expiration_time is null or m.expiration_time > $2)
            )
            select event_id, market_id from ranked where rn = 1;
            `,
            [missingEventIds, now],
          );
          for (const row of rows) {
            marketByEvent.set(row.event_id as string, row.market_id as string);
          }
        }

        const stillMissingEventIds = finalEventIds.filter(
          (id) => !marketByEvent.has(id),
        );
        if (stillMissingEventIds.length) {
          const fallbackSql = `
            with ranked as (
              select
                m.event_id,
                m.id as market_id,
                row_number() over (
                  partition by m.event_id
                  order by
                    case m.status
                      when 'ACTIVE' then 3
                      when 'CLOSED' then 2
                      when 'SETTLED' then 1
                      else 0
                    end desc,
                    coalesce(m.updated_at, m.created_at, m.updated_at_db, m.created_at_db) desc nulls last,
                    m.id asc
                ) as rn
              from unified_markets m
              join unified_events e on e.id = m.event_id
              where m.event_id = any($1)
              ${
                active
                  ? "and (m.close_time is null or m.close_time > $2) and (m.expiration_time is null or m.expiration_time > $2)"
                  : ""
              }
            )
            select event_id, market_id from ranked where rn = 1;
          `;
          const fallbackParams = active
            ? [stillMissingEventIds, now]
            : [stillMissingEventIds];
          const { rows } = await pool.query(fallbackSql, fallbackParams);
          for (const row of rows) {
            marketByEvent.set(row.event_id as string, row.market_id as string);
          }
        }

        const responseItems = finalItems.map((item) => ({
          eventId: item.eventId,
          marketId: marketByEvent.get(item.eventId) ?? null,
          score: item.score,
        }));

        const markets = withDetails
          ? await fetchSimilarMarketSummaries(
              responseItems
                .map((entry) => entry.marketId)
                .filter(Boolean) as string[],
              active,
            )
          : undefined;

        if (cacheTtlSec > 0) {
          const payload = withDetails
            ? {
                items: responseItems,
                markets,
              }
            : responseItems;
          await redis.set(cacheKey, JSON.stringify(payload), {
            EX: cacheTtlSec,
          });
        }

        return reply.send({
          items: responseItems,
          markets,
          cache_status: "hit" as const,
          cache_source: "knn",
        });
      } catch (err) {
        app.log.warn({ err, eventId }, "Similar events lookup failed");
        return reply.send({ items: [], cache_status: "error" as const });
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
