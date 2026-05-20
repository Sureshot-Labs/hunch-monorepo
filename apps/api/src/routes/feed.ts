import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { RESP_TYPES } from "redis";
import { createAuthMiddleware } from "../auth.js";
import { env } from "../env.js";
import { pool } from "../db.js";
import { getRedis, getRedisStatus } from "../redis.js";
import { computeAcceptingOrders } from "../lib/market-availability.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import { isSearchStatementTimeout } from "../lib/postgres-errors.js";
import type { FeedEvent, TokenPair } from "../server-types.js";
import {
  feedQuerySchema,
  resolveMinTotalVolumeFilter,
} from "../schemas/feed.js";
import { forYouQuerySchema } from "../schemas/for-you.js";
import {
  fetchFavoriteFeedEventPage,
  fetchFeedEventIds,
  fetchFeedMarkets,
  fetchFeedMarketsDirect,
  type FeedMarketRow,
} from "../repos/unified-read.js";

const FOR_YOU_MIN_VOLUME_24H = 100;
const FOR_YOU_MIN_LIQUIDITY = 1000;
const FOR_YOU_HALF_LIFE_DAYS = 14;
const FOR_YOU_KNN_PAD = 50;
const FOR_YOU_KNN_MULTIPLIER = 8;
const FOR_YOU_MAX_KNN = 300;
const FOR_YOU_RECENT_CLOSE_HOURS = 24;

function applyFeedCacheHeaders(input: {
  reply: FastifyReply;
  hit: boolean;
  cacheStatus: "disabled" | "ready" | "loading" | "error";
}) {
  input.reply.header("x-cache", input.hit ? "hit" : "miss");
  input.reply.header("x-cache-layer", input.hit ? "redis" : "none");
  input.reply.header("x-cache-status", input.cacheStatus);
}

type ForYouInteractionRow = {
  market_id: string;
  ts: Date | string | number | null;
  weight: number;
  event_id: string;
  market_status: string | null;
  event_status: string | null;
  end_date: Date | string | number | null;
};

type ForYouEventFilterMode = "volume_or_liquidity" | "volume_only" | "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectFeedTokenIdsFromData(data: unknown): string[] {
  if (!Array.isArray(data)) return [];

  const tokenIds = new Set<string>();
  for (const event of data) {
    if (!isRecord(event) || !Array.isArray(event.markets)) continue;
    for (const market of event.markets) {
      if (!isRecord(market) || !isRecord(market.tokens)) continue;
      const yes = market.tokens.yes;
      const no = market.tokens.no;
      if (typeof yes === "string" && yes.trim()) tokenIds.add(yes);
      if (typeof no === "string" && no.trim()) tokenIds.add(no);
    }
  }
  return Array.from(tokenIds);
}

function enqueueFeedMarketRefreshForData(data: unknown): void {
  const tokenIds = collectFeedTokenIdsFromData(data);
  if (!tokenIds.length) return;

  void Promise.all([
    markHotTokens({ tokenIds }),
    requestPriceRefreshForTokens({ tokenIds }),
  ]).catch((error) => {
    console.warn("[feed] market refresh enqueue failed", error);
  });
}

function enqueueFeedMarketRefreshForBody(body: string): void {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) enqueueFeedMarketRefreshForData(parsed.data);
  } catch {
    // Cache body is controlled by this route. If it is somehow invalid, skip warming.
  }
}

function parseTimestampMs(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return parsed;
}

function decayWeight(
  tsMs: number,
  nowMs: number,
  halfLifeDays: number,
): number {
  const ageMs = Math.max(0, nowMs - tsMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  const lambda = Math.log(2) / halfLifeDays;
  return Math.exp(-lambda * ageDays);
}

function parseEmbeddingBuffer(buffer: Buffer): Float32Array | null {
  if (buffer.byteLength % 4 !== 0) return null;
  const aligned = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(aligned).set(buffer);
  return new Float32Array(aligned);
}

function normalizeVector(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i += 1) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
  return vec;
}

function vectorToBuffer(vec: Float32Array): Buffer {
  const slice = vec.buffer.slice(
    vec.byteOffset,
    vec.byteOffset + vec.byteLength,
  );
  return Buffer.from(slice);
}

function buildFeedMarket(rRow: FeedMarketRow): FeedEvent["markets"][number] {
  // Parse token IDs based on venue
  let tokens: TokenPair = { yes: null, no: null };
  if (rRow.venue === "polymarket" && rRow.clob_token_ids) {
    try {
      const tokenIds = JSON.parse(String(rRow.clob_token_ids)) as unknown;
      if (Array.isArray(tokenIds)) {
        tokens = {
          yes: tokenIds[0] != null ? String(tokenIds[0]) : null,
          no: tokenIds[1] != null ? String(tokenIds[1]) : null,
        };
      }
    } catch {
      // Invalid JSON, keep tokens as null
    }
  } else if (rRow.venue === "limitless" || rRow.venue === "kalshi") {
    tokens = {
      yes: rRow.token_yes != null ? String(rRow.token_yes) : null,
      no: rRow.token_no != null ? String(rRow.token_no) : null,
    };
  }

  let outcomes: unknown = null;
  if (rRow.outcomes) {
    try {
      outcomes = JSON.parse(rRow.outcomes);
    } catch {
      // ignore parse errors
    }
  }

  const negRiskExchange =
    rRow.venue === "limitless" ? (rRow.venue_exchange ?? null) : null;
  const negRiskAdapter =
    rRow.venue === "limitless" ? (rRow.venue_adapter ?? null) : null;
  const tradeType =
    rRow.venue === "limitless" ? (rRow.trade_type ?? null) : null;
  const marketAddress =
    rRow.venue === "limitless" ? (rRow.market_address ?? null) : null;

  const marketStatus =
    typeof rRow.market_status === "string" ? rRow.market_status : null;
  const acceptingOrders = computeAcceptingOrders({
    status: marketStatus,
    closeTime: rRow.market_close_time,
    expirationTime: rRow.market_expiration_time,
    pmAcceptingOrders: rRow.pm_accepting_orders ?? null,
  });

  return {
    venue: String(rRow.venue),
    marketId: String(rRow.venue_market_id),
    marketTitle: rRow.market_title ?? "",
    marketSlug: rRow.market_slug ?? null,
    marketType: rRow.market_type ?? null,
    status: marketStatus,
    volume24h: rRow.volume_24h != null ? Number(rRow.volume_24h) : 0,
    volumeTotal: rRow.volume_total != null ? Number(rRow.volume_total) : 0,
    volumeDisplay:
      rRow.volume_display != null ? Number(rRow.volume_display) : 0,
    openInterest: rRow.open_interest != null ? Number(rRow.open_interest) : 0,
    liquidity: rRow.liquidity != null ? Number(rRow.liquidity) : 0,
    liquidityDisplay:
      rRow.liquidity_display != null ? Number(rRow.liquidity_display) : 0,
    acceptingOrders,
    tokens,
    outcomes,
    negRiskExchange,
    negRiskAdapter,
    tradeType,
    marketAddress,
    conditionId: (rRow.condition_id as string | null) || null,
    category: rRow.market_category ?? null,
    image: rRow.market_image ?? null,
    icon: rRow.market_icon ?? null,
    lastPrice: rRow.last_price != null ? Number(rRow.last_price) : null,
    resolvedOutcome: rRow.resolved_outcome ?? null,
    resolvedOutcomePct:
      rRow.resolved_outcome_pct != null
        ? Number(rRow.resolved_outcome_pct)
        : null,
    top: {
      yesBid:
        rRow.best_bid_yes != null
          ? Number(rRow.best_bid_yes)
          : rRow.best_bid != null
            ? Number(rRow.best_bid)
            : null,
      yesAsk:
        rRow.best_ask_yes != null
          ? Number(rRow.best_ask_yes)
          : rRow.best_ask != null
            ? Number(rRow.best_ask)
            : null,
      noBid:
        rRow.best_bid_no != null
          ? Number(rRow.best_bid_no)
          : rRow.best_bid_yes != null
            ? Number(1 - Number(rRow.best_bid_yes))
            : rRow.best_bid != null
              ? Number(1 - Number(rRow.best_bid))
              : null,
      noAsk:
        rRow.best_ask_no != null
          ? Number(rRow.best_ask_no)
          : rRow.best_ask_yes != null
            ? Number(1 - Number(rRow.best_ask_yes))
            : rRow.best_ask != null
              ? Number(1 - Number(rRow.best_ask))
              : null,
    },
    change24h: rRow.change_24h != null ? Number(rRow.change_24h) : null,
    createdAt: rRow.market_created_at ?? null,
    startAt: rRow.market_open_time ?? null,
    lastUpdate: rRow.last_update,
  };
}

function buildFeedEvent(rRow: FeedMarketRow): FeedEvent {
  return {
    eventId: String(rRow.event_id),
    eventTitle: rRow.event_title ?? null,
    category: rRow.category ?? null,
    startTime: rRow.start_date,
    endTime: rRow.end_date,
    eventLiquidity:
      rRow.event_liquidity != null ? Number(rRow.event_liquidity) : 0,
    eventLiquidityDisplay:
      rRow.event_liquidity_display != null
        ? Number(rRow.event_liquidity_display)
        : 0,
    eventVolume: rRow.event_volume != null ? Number(rRow.event_volume) : 0,
    eventVolume24h:
      rRow.event_volume_24h != null ? Number(rRow.event_volume_24h) : 0,
    eventVolumeDisplay:
      rRow.event_volume_display != null ? Number(rRow.event_volume_display) : 0,
    eventOpenInterest:
      rRow.event_open_interest != null ? Number(rRow.event_open_interest) : 0,
    eventSlug: rRow.event_slug ?? null,
    image: rRow.event_image ?? null,
    icon: rRow.event_icon ?? null,
    markets: [],
  };
}

export const feedRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /feed
   * Query:
   *  - limit?: number (default env.defaultLimit, max env.maxLimit)
   *  - offset?: number (default 0)
   *  - min_total_volume?: number (preferred, default > 0)
   *  - min_volume24hr?: number (legacy alias for min_total_volume)
   *  - venue?: string | string[] ("polymarket" | "kalshi" | "limitless", supports CSV)
   *  - category?: string (exact match)
   *  - sort?: string ("trending" | "trending_v2" | "totalvol" | "liquidity", default: "trending")
   *
   * Default sorting uses trending algorithm: 40% volume + 30% liquidity + 20% new events + 10% ending soon
   * trending_v2 favors recent trade volume for Polymarket/Kalshi and liquidity/book for Limitless
   * Adds ETag + Cache-Control. Uses Redis string body as the single source of truth
   * so ETag always matches the exact bytes sent.
   */
  z.get(
    "/feed",
    {
      schema: {
        querystring: feedQuerySchema,
      },
    },
    async (req, reply) => {
      const q = req.query;

      const limit = q.limit;
      const offset = q.offset;
      const minVol = resolveMinTotalVolumeFilter(q);
      const minLiquidity = q.min_liquidity;
      const search = q.q;
      const view: "events" | "markets" =
        q.view === "markets" ? "markets" : "events";
      const eventScope: "grouped" | "single" | undefined =
        q.event_scope === "grouped"
          ? "grouped"
          : q.event_scope === "single"
            ? "single"
            : undefined;
      const venues = q.venue;
      const category = q.category;
      const categories = q.categories;
      const filter = q.filter;
      const sort = q.sort;
      const sortDir: "asc" | "desc" =
        q.sort_dir === "asc" ? "asc" : sort === "time" ? "asc" : "desc";
      const minProb = q.min_prob;
      const maxProb = q.max_prob;
      const maxSpread = q.max_spread;
      const endWithinHours = q.end_within_hours;
      const ageWithinHours = q.age_within_hours;

      // Normalize category to lowercase for consistent caching
      const normalizedCategory = category ? category.toLowerCase() : "";
      const categoriesKey = categories?.length
        ? categories.join(",")
        : normalizedCategory;

      // Calculate cache TTL (default 30 seconds, can be overridden via env var)
      const cacheEnabled = env.feedTtlSec > 0;
      const cacheTtl = cacheEnabled ? env.feedTtlSec : 0;

      // Create cache key with all parameters normalized
      const venueKey = venues?.length ? venues.join(",") : "";
      const cacheKey = `feed:v18:${view}:${eventScope ?? ""}:${limit}:${offset}:${minVol}:${minLiquidity}:${search ?? ""}:${venueKey}:${categoriesKey}:${minProb ?? ""}:${maxProb ?? ""}:${maxSpread ?? ""}:${endWithinHours ?? ""}:${ageWithinHours ?? ""}:${filter ?? ""}:${sort ?? ""}:${sortDir ?? ""}`;
      const redisContext = await getRedisStatus();
      const r = redisContext.redis;
      const redisStatus = redisContext.status;

      // serve from cache if present, with proper ETag/304 handling
      if (cacheEnabled && r) {
        const cachedBody = await r.get(cacheKey);
        if (cachedBody) {
          const etag = `W/"${crypto
            .createHash("sha1")
            .update(cachedBody)
            .digest("hex")}"`;
          enqueueFeedMarketRefreshForBody(cachedBody);
          if (req.headers["if-none-match"] === etag) {
            applyFeedCacheHeaders({
              reply,
              hit: true,
              cacheStatus: redisStatus,
            });
            reply.header("ETag", etag);
            reply.code(304);
            return reply.send();
          }
          applyFeedCacheHeaders({
            reply,
            hit: true,
            cacheStatus: redisStatus,
          });
          reply.header("ETag", etag);
          reply.header(
            "Cache-Control",
            `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
          );
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedBody);
        }
      }

      // Pre-calculate now() as a parameter to allow index usage
      const nowTs = new Date();
      const nowParam = nowTs.toISOString();
      const sevenDaysAgo = new Date(
        nowTs.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const sevenDaysFromNow = new Date(
        nowTs.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();

      const endWithin =
        endWithinHours != null
          ? new Date(
              nowTs.getTime() + endWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;
      const ageSince =
        ageWithinHours != null
          ? new Date(
              nowTs.getTime() - ageWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;

      const inputs = {
        limit,
        offset,
        minVol,
        minLiquidity,
        q: search,
        view,
        eventScope,
        venues,
        category,
        categories,
        filter,
        sort,
        sortDir,
        minProb,
        maxProb,
        maxSpread,
        endWithin,
        ageSince,
        nowParam,
        sevenDaysAgo,
        sevenDaysFromNow,
      };

      let rows: FeedMarketRow[] = [];
      let eventIds: string[] = [];
      try {
        if (view === "markets") {
          rows = await fetchFeedMarketsDirect(pool, inputs);
        } else {
          const eventRows = await fetchFeedEventIds(pool, inputs);
          eventIds = eventRows.map((row) => row.id);
          if (eventIds.length) {
            rows = await fetchFeedMarkets(pool, inputs, eventIds);
          }
        }
      } catch (error) {
        if (isSearchStatementTimeout(error, search)) {
          req.log.warn(
            { error, q: search, view, sort, limit, offset },
            "Feed search timed out",
          );
          return reply.code(504).send({ error: "Search timed out" });
        }
        throw error;
      }

      if (!rows.length) {
        const payload = {
          count: 0,
          limit,
          offset,
          minVolume24h: minVol,
          data: [],
        };
        const body = JSON.stringify(payload);
        const etag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;
        applyFeedCacheHeaders({
          reply,
          hit: false,
          cacheStatus: redisStatus,
        });
        reply.header("ETag", etag);
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(body);
      }

      let data: FeedEvent[] = [];
      if (view === "markets") {
        data = rows.map((rRow) => {
          const market = buildFeedMarket(rRow);
          return { ...buildFeedEvent(rRow), markets: [market] };
        });
      } else {
        const eventMap: Record<string, FeedEvent> = {};
        for (const rRow of rows) {
          const eid = String(rRow.event_id);
          if (!eventMap[eid]) {
            eventMap[eid] = buildFeedEvent(rRow);
          }
          eventMap[eid].markets.push(buildFeedMarket(rRow));
        }

        if (r && (sort === "trending" || sort === "trending_v2")) {
          const uniqueTokenIds: string[] = [];
          const seen = new Set<string>();

          for (const eid of eventIds) {
            const event = eventMap[eid];
            if (!event) continue;
            for (const market of event.markets) {
              const tokenId = market.tokens?.yes;
              if (!tokenId) continue;
              if (seen.has(tokenId)) continue;
              seen.add(tokenId);
              uniqueTokenIds.push(tokenId);
            }
          }

          if (uniqueTokenIds.length) {
            const topKeys = uniqueTokenIds.map((id) => `top:${id}`);
            const tops = await r.mGet(topKeys);
            const hotTokenIds = new Set<string>();
            for (let i = 0; i < uniqueTokenIds.length; i += 1) {
              if (tops[i] != null) hotTokenIds.add(uniqueTokenIds[i]);
            }

            if (hotTokenIds.size) {
              for (const eid of eventIds) {
                const event = eventMap[eid];
                if (!event) continue;
                if (event.markets.length < 2) continue;

                const hotMarkets: FeedEvent["markets"] = [];
                const coldMarkets: FeedEvent["markets"] = [];
                for (const market of event.markets) {
                  const tokenId = market.tokens?.yes;
                  if (tokenId && hotTokenIds.has(tokenId))
                    hotMarkets.push(market);
                  else coldMarkets.push(market);
                }

                if (hotMarkets.length && coldMarkets.length) {
                  event.markets = [...hotMarkets, ...coldMarkets];
                }
              }

              const eventMeta = eventIds.map((eid, index) => {
                const event = eventMap[eid];
                const hotCount =
                  event?.markets.reduce((acc, market) => {
                    const tokenId = market.tokens?.yes;
                    return acc + (tokenId && hotTokenIds.has(tokenId) ? 1 : 0);
                  }, 0) ?? 0;
                return { eid, index, hotCount };
              });

              eventMeta.sort((a, b) => {
                const byHot = b.hotCount - a.hotCount;
                if (byHot) return byHot;
                return a.index - b.index;
              });
              eventIds = eventMeta.map((m) => m.eid);
            }
          }
        }

        data = eventIds.flatMap((eid) => {
          const event = eventMap[eid];
          return event ? [event] : [];
        });
      }

      const payload = {
        count: data.length,
        limit,
        offset,
        minVolume24h: minVol,
        data,
      };

      enqueueFeedMarketRefreshForData(data);

      // serialize once, hash those exact bytes for ETag, then cache/send same bytes
      const body = JSON.stringify(payload);
      const etag = `W/"${crypto.createHash("sha1").update(body).digest("hex")}"`;

      if (cacheEnabled && r) {
        // Use longer cache TTL for better performance
        await r.set(cacheKey, body, { EX: cacheTtl });
      }
      applyFeedCacheHeaders({
        reply,
        hit: false,
        cacheStatus: redisStatus,
      });

      reply.header("ETag", etag);
      reply.header(
        "Cache-Control",
        cacheEnabled
          ? `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`
          : "no-store",
      );
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(body);
    },
  );

  /**
   * GET /feed/favorites
   * Feed-like response scoped to the authenticated user's watchlist markets.
   * Keeps /watchlist unchanged for compatibility while reusing feed filters/sorting.
   */
  z.get(
    "/feed/favorites",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        querystring: feedQuerySchema,
      },
    },
    async (req, reply) => {
      const user = req.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const q = req.query;
      const limit = q.limit;
      const offset = q.offset;
      const minVol = resolveMinTotalVolumeFilter(q);
      const minLiquidity = q.min_liquidity;
      const search = q.q;
      const view: "events" | "markets" =
        q.view === "markets" ? "markets" : "events";
      const eventScope: "grouped" | "single" | undefined =
        q.event_scope === "grouped"
          ? "grouped"
          : q.event_scope === "single"
            ? "single"
            : undefined;
      const venues = q.venue;
      const category = q.category;
      const categories = q.categories;
      const filter = q.filter;
      const sort = q.sort;
      const sortDir: "asc" | "desc" =
        q.sort_dir === "asc" ? "asc" : sort === "time" ? "asc" : "desc";
      const minProb = q.min_prob;
      const maxProb = q.max_prob;
      const maxSpread = q.max_spread;
      const endWithinHours = q.end_within_hours;
      const ageWithinHours = q.age_within_hours;

      const { rows: favoriteRows } = await pool.query<{ market_id: string }>(
        `
        select w.market_id
        from user_watchlist w
        join unified_markets m on m.id = w.market_id
        where w.user_id = $1
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > now())
          and (m.close_time is null or m.close_time > now())
        `,
        [user.id],
      );

      const favoriteMarketIds = Array.from(
        new Set(favoriteRows.map((row) => row.market_id).filter(Boolean)),
      );

      if (!favoriteMarketIds.length) {
        return reply.send({
          count: 0,
          limit,
          offset,
          minVolume24h: minVol,
          data: [],
        });
      }

      const nowTs = new Date();
      const nowParam = nowTs.toISOString();
      const sevenDaysAgo = new Date(
        nowTs.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const sevenDaysFromNow = new Date(
        nowTs.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const endWithin =
        endWithinHours != null
          ? new Date(
              nowTs.getTime() + endWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;
      const ageSince =
        ageWithinHours != null
          ? new Date(
              nowTs.getTime() - ageWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;

      const baseInputs = {
        minVol,
        minLiquidity,
        marketIds: favoriteMarketIds,
        q: search,
        view,
        eventScope,
        venues,
        category,
        categories,
        filter,
        sort,
        sortDir,
        minProb,
        maxProb,
        maxSpread,
        endWithin,
        ageSince,
        nowParam,
        sevenDaysAgo,
        sevenDaysFromNow,
      };

      let data: FeedEvent[] = [];
      let responseCount = 0;
      let totalEvents = 0;
      let totalMarkets = 0;
      if (view === "markets") {
        const summary = await fetchFavoriteFeedEventPage(pool, {
          ...baseInputs,
          limit: 1,
          offset: 0,
        });
        totalEvents = summary.totalEvents;
        totalMarkets = summary.totalMarkets;
        const rows = await fetchFeedMarketsDirect(pool, {
          ...baseInputs,
          limit,
          offset,
        });
        if (!rows.length) {
          return reply.send({
            count: 0,
            limit,
            offset,
            minVolume24h: minVol,
            data: [],
          });
        }
        data = rows.map((rRow) => {
          const market = buildFeedMarket(rRow);
          return { ...buildFeedEvent(rRow), markets: [market] };
        });
        responseCount = totalMarkets;
      } else {
        // event_scope in favorites mode is favorites-relative:
        // grouped/single is evaluated on favorited markets that match filters.
        const summary = await fetchFavoriteFeedEventPage(pool, {
          ...baseInputs,
          limit,
          offset,
        });
        totalEvents = summary.totalEvents;
        totalMarkets = summary.totalMarkets;
        if (!summary.eventIds.length) {
          return reply.send({
            count: 0,
            limit,
            offset,
            minVolume24h: minVol,
            totalEvents: 0,
            totalMarkets: 0,
            data: [],
          });
        }
        const allRows = await fetchFeedMarkets(
          pool,
          {
            ...baseInputs,
            limit,
            offset,
          },
          summary.eventIds,
        );
        const eventMap: Record<string, FeedEvent> = {};
        for (const rRow of allRows) {
          const eventId = String(rRow.event_id);
          if (!eventMap[eventId]) {
            eventMap[eventId] = buildFeedEvent(rRow);
          }
          eventMap[eventId].markets.push(buildFeedMarket(rRow));
        }
        data = summary.eventIds
          .map((eventId) => eventMap[eventId])
          .filter((event): event is FeedEvent => Boolean(event));
        responseCount = totalEvents;
      }

      enqueueFeedMarketRefreshForData(data);

      return reply.send({
        count: responseCount,
        limit,
        offset,
        minVolume24h: minVol,
        totalEvents,
        totalMarkets,
        data,
      });
    },
  );

  /**
   * GET /feed/for-you/status
   * Returns whether the user has enough data to show the For You tab.
   */
  z.get(
    "/feed/for-you/status",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const nowMs = Date.now();
      const { rows: interactionRows } = await pool.query<ForYouInteractionRow>(
        `
        with interactions as (
          select w.user_id, w.market_id, w.created_at as ts, 3 as weight
          from user_watchlist w
          where w.user_id = $1
          union all
          select o.user_id, ut.market_id, o.posted_at as ts, 2 as weight
          from orders o
          join unified_tokens ut on ut.token_id = o.token_id
          where o.user_id = $1
          union all
          select p.user_id, ut.market_id, p.last_updated_at as ts, 1 as weight
          from positions p
          join unified_tokens ut on ut.token_id = p.token_id
          where p.user_id = $1
            and p.position_scope = 'own'
        )
        select
          i.market_id,
          i.ts,
          i.weight,
          m.event_id,
          m.status as market_status,
          e.status as event_status,
          e.end_date
        from interactions i
        join unified_markets m on m.id = i.market_id
        join unified_events e on e.id = m.event_id
        where i.ts is not null;
        `,
        [user.id],
      );

      const activeInteractions: ForYouInteractionRow[] = [];
      const activeEventIds = new Set<string>();
      for (const row of interactionRows) {
        const endMs = parseTimestampMs(row.end_date);
        const active =
          row.market_status === "ACTIVE" &&
          row.event_status === "ACTIVE" &&
          (endMs == null || endMs > nowMs);
        if (!active) continue;
        activeInteractions.push(row);
        activeEventIds.add(row.event_id);
      }

      const activeInteractionCount = activeInteractions.length;
      const activeEventCount = activeEventIds.size;

      let embeddedEventCount = 0;
      const redis = await getRedis();
      if (redis && activeEventIds.size) {
        const bufferClient = redis.withTypeMapping({
          [RESP_TYPES.BLOB_STRING]: Buffer,
        });
        const checks = await Promise.all(
          Array.from(activeEventIds).map((id) =>
            bufferClient.hGet(`ai:embed:event:${id}`, "embedding"),
          ),
        );
        for (const res of checks) {
          if (Buffer.isBuffer(res)) embeddedEventCount += 1;
        }
      }

      return reply.send({
        hasInteractions: activeInteractionCount > 0,
        activeInteractionCount,
        activeEventCount,
        embeddedEventCount,
      });
    },
  );

  /**
   * GET /feed/for-you
   * Event-level personalized feed. Requires auth.
   */
  z.get(
    "/feed/for-you",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: forYouQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const limit = query.limit;
      const offset = query.offset;
      const nowMs = Date.now();
      const minVol = resolveMinTotalVolumeFilter(query);
      const minLiquidity = query.min_liquidity;
      const venues = query.venue;
      const categories = query.categories;
      const minProb = query.min_prob;
      const maxProb = query.max_prob;
      const maxSpread = query.max_spread;
      const sort = query.sort;
      const sortDir: "asc" | "desc" =
        query.sort_dir === "asc" ? "asc" : sort === "time" ? "asc" : "desc";
      const endWithinHours = query.end_within_hours;
      const ageWithinHours = query.age_within_hours;
      const search = query.q;

      const { rows: interactionRows } = await pool.query<ForYouInteractionRow>(
        `
        with interactions as (
          select w.user_id, w.market_id, w.created_at as ts, 3 as weight
          from user_watchlist w
          where w.user_id = $1
          union all
          select o.user_id, ut.market_id, o.posted_at as ts, 2 as weight
          from orders o
          join unified_tokens ut on ut.token_id = o.token_id
          where o.user_id = $1
          union all
          select p.user_id, ut.market_id, p.last_updated_at as ts, 1 as weight
          from positions p
          join unified_tokens ut on ut.token_id = p.token_id
          where p.user_id = $1
            and p.position_scope = 'own'
        )
        select
          i.market_id,
          i.ts,
          i.weight,
          m.event_id,
          m.status as market_status,
          e.status as event_status,
          e.end_date
        from interactions i
        join unified_markets m on m.id = i.market_id
        join unified_events e on e.id = m.event_id
        where i.ts is not null;
        `,
        [user.id],
      );

      const activeInteractions: ForYouInteractionRow[] = [];
      const interactedEventIds = new Set<string>();
      for (const row of interactionRows) {
        const endMs = parseTimestampMs(row.end_date);
        const active =
          row.market_status === "ACTIVE" &&
          row.event_status === "ACTIVE" &&
          (endMs == null || endMs > nowMs);
        if (!active) continue;
        activeInteractions.push(row);
        interactedEventIds.add(row.event_id);
      }

      if (!activeInteractions.length) {
        return reply.send({
          count: 0,
          limit,
          offset,
          minVolume24h: 0,
          data: [],
        });
      }

      const redis = await getRedis();
      if (!redis) {
        return reply.send({
          count: 0,
          limit,
          offset,
          minVolume24h: 0,
          data: [],
        });
      }

      const bufferClient = redis.withTypeMapping({
        [RESP_TYPES.BLOB_STRING]: Buffer,
      });

      // Aggregate event weights with EMA decay.
      const eventWeights = new Map<string, number>();
      for (const row of activeInteractions) {
        const tsMs = parseTimestampMs(row.ts) ?? nowMs;
        const weight =
          row.weight * decayWeight(tsMs, nowMs, FOR_YOU_HALF_LIFE_DAYS);
        eventWeights.set(
          row.event_id,
          (eventWeights.get(row.event_id) ?? 0) + weight,
        );
      }

      let sum: Float32Array | null = null;
      let weightSum = 0;
      for (const [eventId, weight] of eventWeights.entries()) {
        const raw = await bufferClient.hGet(
          `ai:embed:event:${eventId}`,
          "embedding",
        );
        if (!Buffer.isBuffer(raw)) continue;
        const vec = parseEmbeddingBuffer(raw);
        if (!vec) continue;
        if (!sum) sum = new Float32Array(vec.length);
        if (sum.length !== vec.length) continue;
        for (let i = 0; i < vec.length; i += 1) {
          sum[i] += vec[i] * weight;
        }
        weightSum += weight;
      }

      if (!sum || weightSum <= 0) {
        return reply.send({
          count: 0,
          limit,
          offset,
          minVolume24h: 0,
          data: [],
        });
      }

      for (let i = 0; i < sum.length; i += 1) sum[i] /= weightSum;
      const userVector = normalizeVector(sum);

      // For You is rendered as ACTIVE markets/events; querying CLOSED embeddings
      // reduces recall without improving returned rows.
      const knnLimit = Math.min(
        FOR_YOU_MAX_KNN,
        Math.max(
          limit + offset + FOR_YOU_KNN_PAD,
          limit * FOR_YOU_KNN_MULTIPLIER,
          50,
        ),
      );
      const queryText = `@status:{ACTIVE}=>[KNN ${knnLimit} @embedding $vec AS score]`;

      const raw = (await redis.sendCommand([
        "FT.SEARCH",
        "idx:ai:embed:event",
        queryText,
        "PARAMS",
        "2",
        "vec",
        vectorToBuffer(userVector),
        "SORTBY",
        "score",
        "RETURN",
        "1",
        "score",
        "LIMIT",
        "0",
        String(knnLimit),
        "DIALECT",
        "2",
      ])) as unknown[];

      const candidateEventIds: string[] = [];
      for (let i = 1; i < raw.length; i += 2) {
        const key = raw[i];
        const id = String(key).replace("ai:embed:event:", "");
        if (interactedEventIds.has(id)) continue;
        candidateEventIds.push(id);
      }

      if (!candidateEventIds.length) {
        return reply.send({
          count: 0,
          limit,
          offset,
          minVolume24h: 0,
          data: [],
        });
      }

      const nowTs = new Date();
      const nowParam = nowTs.toISOString();
      const sevenDaysAgo = new Date(
        nowTs.getTime() - 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const sevenDaysFromNow = new Date(
        nowTs.getTime() + 7 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const endWithin =
        endWithinHours != null
          ? new Date(
              nowTs.getTime() + endWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;
      const ageSince =
        ageWithinHours != null
          ? new Date(
              nowTs.getTime() - ageWithinHours * 60 * 60 * 1000,
            ).toISOString()
          : undefined;

      const safeEventLiquidityExpr =
        "case when e.liquidity >= 9e16 then null else e.liquidity end";
      const eventVolumeDisplayExpr = `
        case
          when e.volume_total is not null and e.volume_total > 0 then e.volume_total
          else null
        end
      `;
      const eventLiquidityDisplayExpr = `
        coalesce(nullif(${safeEventLiquidityExpr}, 0), nullif(e.open_interest, 0))
      `;

      const shouldFilterEvents =
        (venues?.length ?? 0) > 0 ||
        (categories?.length ?? 0) > 0 ||
        endWithin != null ||
        ageSince != null ||
        minVol > 1e-9 ||
        minLiquidity > 0 ||
        search != null;

      let filteredEventIds = candidateEventIds;
      if (shouldFilterEvents) {
        const params: unknown[] = [];
        const add = (value: unknown) => {
          params.push(value);
          return `$${params.length}`;
        };
        const eventIdsParam = add(candidateEventIds);
        const nowParamSql = add(nowParam);
        const searchParam = search ? add(`%${search}%`) : null;
        const where: string[] = [
          "e.status = 'ACTIVE'",
          `(e.end_date is null or e.end_date > ${nowParamSql}::timestamptz)`,
        ];
        if (venues?.length) {
          where.push(`e.venue = ANY(${add(venues)}::text[])`);
        }
        if (categories?.length) {
          where.push(`lower(e.category) = ANY(${add(categories)}::text[])`);
        }
        if (endWithin) {
          where.push(
            `e.end_date is not null and e.end_date <= ${add(endWithin)}::timestamptz`,
          );
        }
        if (ageSince) {
          where.push(
            `e.start_date is not null and e.start_date >= ${add(ageSince)}::timestamptz`,
          );
        }
        if (minVol > 1e-9) {
          where.push(`${eventVolumeDisplayExpr} >= ${add(minVol)}`);
        }
        if (minLiquidity > 0) {
          where.push(`${eventLiquidityDisplayExpr} >= ${add(minLiquidity)}`);
        }
        if (searchParam) {
          where.push(`
            (
              e.id ilike ${searchParam}
              or e.title ilike ${searchParam}
              or e.description ilike ${searchParam}
              or e.category ilike ${searchParam}
              or e.slug ilike ${searchParam}
              or exists (
                select 1
                from unified_markets m
                where m.event_id = e.id
                  and m.status = 'ACTIVE'
                  and (m.expiration_time is null or m.expiration_time > ${nowParamSql}::timestamptz)
                  and (m.close_time is null or m.close_time > ${nowParamSql}::timestamptz)
                  and (
                    m.venue_market_id::text ilike ${searchParam}
                    or m.title ilike ${searchParam}
                    or m.description ilike ${searchParam}
                    or m.category ilike ${searchParam}
                    or m.slug ilike ${searchParam}
                  )
              )
            )
          `);
        }

        const sql = `
          select c.event_id
          from unnest(${eventIdsParam}::text[]) with ordinality as c(event_id, ord)
          join unified_events e on e.id = c.event_id
          where ${where.join(" and ")}
          order by c.ord
        `;
        const { rows } = await pool.query<{ event_id: string }>(sql, params);
        filteredEventIds = rows.map((row) => row.event_id);
      }

      if (!filteredEventIds.length) {
        return reply.send({
          count: 0,
          limit,
          offset,
          minVolume24h: 0,
          data: [],
        });
      }

      const inputs = {
        limit,
        offset,
        minVol,
        minLiquidity,
        q: search,
        view: "events" as const,
        eventScope: "grouped" as const,
        venues,
        category: undefined,
        categories,
        filter: undefined,
        sort: undefined,
        sortDir: "desc" as const,
        minProb,
        maxProb,
        maxSpread,
        endWithin,
        ageSince,
        nowParam,
        sevenDaysAgo,
        sevenDaysFromNow,
      };

      const feedRows = await fetchFeedMarkets(pool, inputs, filteredEventIds);
      if (!feedRows.length) {
        return reply.send({
          count: 0,
          limit,
          offset,
          minVolume24h: 0,
          data: [],
        });
      }

      const eventMap: Record<string, FeedEvent> = {};
      for (const rRow of feedRows) {
        const eid = String(rRow.event_id);
        if (!eventMap[eid]) {
          eventMap[eid] = buildFeedEvent(rRow);
        }
        eventMap[eid].markets.push(buildFeedMarket(rRow));
      }

      const orderedEvents: FeedEvent[] = candidateEventIds.flatMap((eid) => {
        const event = eventMap[eid];
        return event ? [event] : [];
      });

      const pickRepresentative = (event: FeedEvent) => {
        const candidates = event.markets.filter(
          (market) => market.acceptingOrders,
        );
        if (!candidates.length) return null;
        candidates.sort((a, b) => {
          const byVol24h = b.volume24h - a.volume24h;
          if (byVol24h) return byVol24h;
          const byVolTotal = b.volumeTotal - a.volumeTotal;
          if (byVolTotal) return byVolTotal;
          const byLiquidity = b.liquidity - a.liquidity;
          if (byLiquidity) return byLiquidity;
          const byOpenInterest = b.openInterest - a.openInterest;
          if (byOpenInterest) return byOpenInterest;
          return a.marketId.localeCompare(b.marketId);
        });
        return candidates[0];
      };

      const recentCloseWindowMs = FOR_YOU_RECENT_CLOSE_HOURS * 60 * 60 * 1000;

      const filterEvents = (
        mode: ForYouEventFilterMode,
        allowRecentlyClosed: boolean,
      ): FeedEvent[] => {
        const filtered: FeedEvent[] = [];
        for (const event of orderedEvents) {
          const rep = pickRepresentative(event);
          if (!rep) continue;
          const endMs = parseTimestampMs(event.endTime);
          const endOk =
            endMs == null ||
            endMs > nowMs ||
            (allowRecentlyClosed && endMs > nowMs - recentCloseWindowMs);
          if (!endOk) continue;

          let qualityOk = true;
          if (mode === "volume_or_liquidity") {
            qualityOk =
              event.eventVolume24h >= FOR_YOU_MIN_VOLUME_24H ||
              event.eventLiquidity >= FOR_YOU_MIN_LIQUIDITY;
          } else if (mode === "volume_only") {
            qualityOk = event.eventVolume24h >= FOR_YOU_MIN_VOLUME_24H;
          }
          if (!qualityOk) continue;

          filtered.push(event);
        }
        return filtered;
      };

      let filtered = filterEvents("volume_or_liquidity", false);
      if (filtered.length < limit) {
        filtered = filterEvents("volume_only", false);
      }
      if (filtered.length < limit) {
        filtered = filterEvents("none", false);
      }
      if (filtered.length < limit) {
        filtered = filterEvents("none", true);
      }

      const rankByEventId = new Map<string, number>();
      for (let i = 0; i < orderedEvents.length; i += 1) {
        rankByEventId.set(orderedEvents[i].eventId, i);
      }
      const compareNullableNumber = (
        a: number | null | undefined,
        b: number | null | undefined,
      ): number => {
        const aNullish = a == null || Number.isNaN(a);
        const bNullish = b == null || Number.isNaN(b);
        if (aNullish && bNullish) return 0;
        if (aNullish) return 1;
        if (bNullish) return -1;
        return sortDir === "asc" ? a - b : b - a;
      };
      const eventChange24hById = new Map<string, number | null>();
      if (sort === "change24h") {
        for (const event of filtered) {
          const values = event.markets
            .map((market) => market.change24h)
            .filter(
              (value): value is number =>
                value != null && Number.isFinite(value),
            );
          eventChange24hById.set(
            event.eventId,
            values.length
              ? values.reduce((sum, value) => sum + value, 0) / values.length
              : null,
          );
        }
      }
      const sorted = sort
        ? [...filtered].sort((a, b) => {
            let cmp = 0;
            if (sort === "totalvol") {
              cmp = compareNullableNumber(
                a.eventVolumeDisplay,
                b.eventVolumeDisplay,
              );
            } else if (sort === "liquidity") {
              cmp = compareNullableNumber(
                a.eventLiquidityDisplay,
                b.eventLiquidityDisplay,
              );
            } else if (sort === "openinterest") {
              cmp = compareNullableNumber(
                a.eventOpenInterest,
                b.eventOpenInterest,
              );
            } else if (sort === "change24h") {
              cmp = compareNullableNumber(
                eventChange24hById.get(a.eventId),
                eventChange24hById.get(b.eventId),
              );
            } else if (sort === "time") {
              cmp = compareNullableNumber(
                parseTimestampMs(a.endTime),
                parseTimestampMs(b.endTime),
              );
            } else if (sort === "newest") {
              cmp = compareNullableNumber(
                parseTimestampMs(a.startTime),
                parseTimestampMs(b.startTime),
              );
            }
            if (cmp !== 0) return cmp;
            return (
              (rankByEventId.get(a.eventId) ?? Number.MAX_SAFE_INTEGER) -
              (rankByEventId.get(b.eventId) ?? Number.MAX_SAFE_INTEGER)
            );
          })
        : filtered;

      const totalCount = sorted.length;
      const page = sorted.slice(offset, offset + limit);

      const payload = {
        count: totalCount,
        limit,
        offset,
        minVolume24h: 0,
        data: page,
      };

      enqueueFeedMarketRefreshForData(page);

      reply.header("Cache-Control", "no-store");
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(JSON.stringify(payload));
    },
  );
};
