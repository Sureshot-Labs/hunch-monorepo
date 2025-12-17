import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import crypto from "node:crypto";
import { env } from "../env.js";
import { pool } from "../db.js";
import { getRedis } from "../redis.js";
import type { FeedEvent, TokenPair } from "../server-types.js";
import { feedQuerySchema } from "../schemas/feed.js";
import { fetchFeedEventIds, fetchFeedMarkets } from "../repos/unified-read.js";

export const feedRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /feed
   * Query:
   *  - limit?: number (default env.defaultLimit, max env.maxLimit)
   *  - offset?: number (default 0)
   *  - min_volume24hr?: number (default > 0)
   *  - venue?: string | string[] ("polymarket" | "kalshi" | "limitless", supports CSV)
   *  - category?: string (exact match)
   *  - sort?: string ("trending" | "totalvol" | "liquidity", default: "trending")
   *
   * Default sorting uses trending algorithm: 40% volume + 30% liquidity + 20% new events + 10% ending soon
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
      const minVol = q.min_volume24hr;
      const minLiquidity = q.min_liquidity;
      const venues = q.venue;
      const category = q.category;
      const filter = q.filter;
      const sort = q.sort;

      // Normalize category to lowercase for consistent caching
      const normalizedCategory = category ? category.toLowerCase() : "";

      // Calculate cache TTL (default 30 seconds, can be overridden via env var)
      const cacheTtl = env.feedTtlSec > 0 ? env.feedTtlSec : 30;

      // Create cache key with all parameters normalized
      const venueKey = venues?.length ? venues.join(",") : "";
      const cacheKey = `feed:v10:${limit}:${offset}:${minVol}:${minLiquidity}:${venueKey}:${normalizedCategory}:${filter ?? ""}:${sort ?? ""}`;
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

      // 1. Get event IDs matching filters, with limit/offset
      const eventRows = await fetchFeedEventIds(pool, {
        limit,
        offset,
        minVol,
        minLiquidity,
        venues,
        category,
        filter,
        sort,
        nowParam,
        sevenDaysAgo,
        sevenDaysFromNow,
      });
      let eventIds = eventRows.map((row) => row.id);

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
      const rows = await fetchFeedMarkets(
        pool,
        {
          limit,
          offset,
          minVol,
          minLiquidity,
          venues,
          category,
          filter,
          sort,
          nowParam,
          sevenDaysAgo,
          sevenDaysFromNow,
        },
        eventIds,
      );

      // Group markets under their events
      const eventMap: Record<string, FeedEvent> = {};
      for (const rRow of rows) {
        const eid = String(rRow.event_id);
        if (!eventMap[eid]) {
          eventMap[eid] = {
            eventId: eid,
            eventTitle: rRow.event_title ?? null,
            category: rRow.category ?? null,
            startTime: rRow.start_date,
            endTime: rRow.end_date,
            eventLiquidity:
              rRow.event_liquidity != null ? Number(rRow.event_liquidity) : 0,
            eventVolume:
              rRow.event_volume != null ? Number(rRow.event_volume) : 0,
            eventOpenInterest:
              rRow.event_open_interest != null
                ? Number(rRow.event_open_interest)
                : 0,
            eventSlug: rRow.event_slug ?? null,
            image: rRow.event_image ?? null,
            icon: rRow.event_icon ?? null,
            markets: [],
          };
        }

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

        eventMap[eid].markets.push({
          venue: String(rRow.venue),
          marketId: String(rRow.venue_market_id),
          marketTitle: rRow.market_title ?? "",
          marketSlug: rRow.market_slug ?? null,
          volume24h: rRow.volume_24h != null ? Number(rRow.volume_24h) : 0,
          volumeTotal:
            rRow.volume_total != null ? Number(rRow.volume_total) : 0,
          openInterest:
            rRow.open_interest != null ? Number(rRow.open_interest) : 0,
          liquidity: rRow.liquidity != null ? Number(rRow.liquidity) : 0,
          acceptingOrders: true, // Always true for active markets in unified table
          tokens,
          conditionId: (rRow.condition_id as string | null) || null,
          category: rRow.market_category ?? null,
          image: rRow.market_image ?? null,
          icon: rRow.market_icon ?? null,
          top: {
            yesBid: rRow.best_bid != null ? Number(rRow.best_bid) : null,
            yesAsk: rRow.best_ask != null ? Number(rRow.best_ask) : null,
            noBid:
              rRow.best_bid != null ? Number(1 - Number(rRow.best_bid)) : null,
            noAsk:
              rRow.best_ask != null ? Number(1 - Number(rRow.best_ask)) : null,
          },
          lastUpdate: rRow.last_update,
        });
      }

      // When explicitly requesting trending, bias the ordering to SSE-updatable markets
      // by floating markets/events whose YES token has an active Redis `top:<tokenId>` entry.
      if (r && sort === "trending") {
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
                if (tokenId && hotTokenIds.has(tokenId)) hotMarkets.push(market);
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
            image: null,
            icon: null,
            markets: [],
          },
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
        // Use longer cache TTL for better performance
        await r.set(cacheKey, body, { EX: cacheTtl });
        reply.header("x-cache", "miss");
      }

      reply.header("ETag", etag);
      reply.header(
        "Cache-Control",
        `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
      );
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(body);
    },
  );
};
