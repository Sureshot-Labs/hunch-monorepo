import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import { isRecord } from "../lib/type-guards.js";
import {
  watchlistAddBodySchema,
  watchlistListQuerySchema,
  watchlistRemoveParamsSchema,
} from "../schemas/watchlist.js";
import { fetchWatchlistPage } from "../repos/watchlist-repo.js";
import type { PgParams, TokenPair, WatchlistEvent } from "../server-types.js";

export const watchlistRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * POST /watchlist
   * Add a market to user's watchlist
   */
  z.post(
    "/watchlist",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: watchlistAddBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      try {
        const client = await pool.connect();
        try {
          const marketCheck = await client.query<{ id: string }>(
            "SELECT id FROM unified_markets WHERE id = $1",
            [body.marketId],
          );

          if (marketCheck.rows.length === 0) {
            reply.code(400);
            return reply.send({ error: "Market not found" });
          }

          const result = await client.query<{
            id: string;
            market_id: string;
            created_at: Date;
          }>(
            `INSERT INTO user_watchlist (user_id, market_id)
             VALUES ($1, $2)
             RETURNING id, market_id, created_at`,
            [user.id, body.marketId],
          );

          reply.code(201);
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            message: "Market added to watchlist successfully",
            watchlistItem: {
              id: result.rows[0].id,
              marketId: result.rows[0].market_id,
              createdAt: result.rows[0].created_at,
            },
          });
        } catch (error) {
          const code = isRecord(error) ? error["code"] : undefined;
          if (code === "23505") {
            reply.code(409);
            return reply.send({ error: "Market already in watchlist" });
          }
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        app.log.error(
          { error, userId: user.id, marketId: body.marketId },
          "Failed to add market to watchlist",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to add market to watchlist",
        });
      }
    },
  );

  /**
   * GET /watchlist
   * Get all markets in user's watchlist
   */
  z.get(
    "/watchlist",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: watchlistListQuerySchema },
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
      const includeInactive = query.include_inactive;

      try {
        const { rows, total: totalCount } = await fetchWatchlistPage(pool, {
          userId: user.id,
          limit,
          offset,
          includeInactive,
        });

        const eventMap: Record<string, WatchlistEvent> = {};
        for (const r of rows) {
          const eid = String(r.event_id);
          if (!eventMap[eid]) {
            eventMap[eid] = {
              eventId: eid,
              eventTitle: r.event_title ?? null,
              category: r.category ?? null,
              startTime: r.start_date,
              endTime: r.end_date,
              eventLiquidity:
                r.event_liquidity != null ? Number(r.event_liquidity) : 0,
              eventVolume: r.event_volume != null ? Number(r.event_volume) : 0,
              eventVolume24h:
                r.event_volume_24h != null ? Number(r.event_volume_24h) : 0,
              eventOpenInterest:
                r.event_open_interest != null
                  ? Number(r.event_open_interest)
                  : 0,
              eventSlug: r.event_slug ?? null,
              image: r.event_image ?? null,
              icon: r.event_icon ?? null,
              markets: [],
            };
          }

          let tokens: TokenPair = { yes: null, no: null };
          if (r.venue === "polymarket" && r.clob_token_ids) {
            try {
              const tokenIds = JSON.parse(String(r.clob_token_ids)) as unknown;
              if (Array.isArray(tokenIds)) {
                tokens = {
                  yes: tokenIds[0] != null ? String(tokenIds[0]) : null,
                  no: tokenIds[1] != null ? String(tokenIds[1]) : null,
                };
              }
            } catch {
              // ignore bad token id encodings
            }
          } else if (r.venue === "limitless" || r.venue === "kalshi") {
            tokens = {
              yes: r.token_yes != null ? String(r.token_yes) : null,
              no: r.token_no != null ? String(r.token_no) : null,
            };
          }

          eventMap[eid].markets.push({
            marketId: String(r.market_uuid),
            venue: String(r.venue),
            venueMarketId: String(r.venue_market_id),
            marketTitle: r.market_title ?? "",
            marketSlug: r.market_slug ?? null,
            volume24h: r.volume_24h != null ? Number(r.volume_24h) : 0,
            volumeTotal: r.volume_total != null ? Number(r.volume_total) : 0,
            openInterest: r.open_interest != null ? Number(r.open_interest) : 0,
            liquidity: r.liquidity != null ? Number(r.liquidity) : 0,
            acceptingOrders: computeAcceptingOrders({
              venue: typeof r.venue === "string" ? r.venue : null,
              status:
                typeof r.market_status === "string" ? r.market_status : null,
              closeTime: r.close_time,
              expirationTime: r.expiration_time,
              eventEndTime: r.end_date,
              pmAcceptingOrders: r.pm_accepting_orders,
              dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(
                r.market_metadata,
              ),
            }),
            tokens,
            conditionId: (r.condition_id as string | null) || null,
            category: r.market_category ?? null,
            image: r.market_image ?? null,
            icon: r.market_icon ?? null,
            status: String(r.market_status),
            top: {
              yesBid: r.best_bid != null ? Number(r.best_bid) : null,
              yesAsk: r.best_ask != null ? Number(r.best_ask) : null,
              noBid: r.best_bid != null ? Number(1 - Number(r.best_bid)) : null,
              noAsk: r.best_ask != null ? Number(1 - Number(r.best_ask)) : null,
            },
            lastUpdate: r.last_update,
            watchlistId: String(r.watchlist_id),
            watchlistCreatedAt: r.watchlist_created_at,
          });
        }

        const data = Object.values(eventMap);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          count: data.length,
          total: totalCount,
          limit,
          offset,
          data,
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to fetch watchlist");
        reply.code(500);
        return reply.send({
          error: "Failed to fetch watchlist",
        });
      }
    },
  );

  /**
   * GET /watchlist/ids
   * Lightweight list of favorited market ids for star-state hydration.
   */
  z.get(
    "/watchlist/ids",
    {
      preHandler: createAuthMiddleware(),
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const { rows } = await pool.query<{ market_id: string }>(
          `
          select market_id
          from user_watchlist
          where user_id = $1
          order by created_at desc
          `,
          [user.id],
        );

        const ids = Array.from(
          new Set(rows.map((row) => row.market_id).filter(Boolean)),
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          count: ids.length,
          ids,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id },
          "Failed to fetch watchlist ids",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch watchlist ids",
        });
      }
    },
  );

  /**
   * DELETE /watchlist/:marketId
   * Remove a market from user's watchlist
   */
  z.delete(
    "/watchlist/:marketId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: watchlistRemoveParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const { marketId } = request.params;

      try {
        const client = await pool.connect();
        try {
          let deleteQuery: string;
          let deleteParams: PgParams;

          if (marketId.includes(":")) {
            deleteQuery = `DELETE FROM user_watchlist
                           WHERE user_id = $1 AND market_id = $2
                           RETURNING id, market_id`;
            deleteParams = [user.id, marketId];
          } else {
            deleteQuery = `DELETE FROM user_watchlist
                           WHERE user_id = $1 AND market_id LIKE $2
                           RETURNING id, market_id`;
            deleteParams = [user.id, `%:${marketId}`];
          }

          const result = await client.query<{
            id: string;
            market_id: string;
          }>(deleteQuery, deleteParams);

          if (result.rows.length === 0) {
            reply.code(404);
            return reply.send({ error: "Market not found in watchlist" });
          }

          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            message: "Market removed from watchlist successfully",
            removedItem: {
              id: result.rows[0].id,
              marketId: result.rows[0].market_id,
            },
          });
        } finally {
          client.release();
        }
      } catch (error) {
        app.log.error(
          { error, userId: user.id, marketId },
          "Failed to remove market from watchlist",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to remove market from watchlist",
        });
      }
    },
  );
};
