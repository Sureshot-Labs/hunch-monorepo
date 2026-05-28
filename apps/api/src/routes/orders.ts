import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { resolveRequestedWalletAddresses } from "../lib/resolve-wallets.js";
import {
  fetchUnifiedMarketIdsByEventId,
  fetchUnifiedOrderById,
  fetchUnifiedOrders,
  mapUnifiedOrder,
} from "../repos/unified-orders.js";
import {
  orderIdParamsSchema,
  orderIdQuerySchema,
  ordersOpenQuerySchema,
  ordersQuerySchema,
} from "../schemas/orders.js";

const OPEN_ORDER_STATUSES: string[] = [
  "pending",
  "submitted",
  "live",
  "partially_filled",
  "delayed",
  "unconfirmed",
  "open",
];

export const ordersRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /orders
   * List unified orders (orders + swaps) for the current user.
   */
  z.get(
    "/orders",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: ordersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const walletAddresses = await resolveRequestedWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          { allowPolymarketFunders: true },
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const marketIds =
          query.marketId || !query.eventId
            ? []
            : await fetchUnifiedMarketIdsByEventId(pool, query.eventId);
        if (query.eventId && !query.marketId && marketIds.length === 0) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            orders: [],
            pagination: {
              total: 0,
              limit: query.limit,
              offset: query.offset,
              hasMore: false,
            },
          });
        }

        const result = await fetchUnifiedOrders(pool, {
          userId: user.id,
          walletAddresses,
          venue: query.venue,
          marketId: query.marketId,
          marketIds: marketIds.length ? marketIds : undefined,
          tokenId: query.tokenId,
          status: query.status,
          type: query.type,
          limit: query.limit,
          offset: query.offset,
        });

        const orders = result.rows.map(mapUnifiedOrder);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          orders,
          pagination: {
            total: result.total,
            limit: query.limit,
            offset: query.offset,
            hasMore: query.offset + query.limit < result.total,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch orders",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch orders",
        });
      }
    },
  );

  /**
   * GET /orders/open
   * List open orders for the current user.
   */
  z.get(
    "/orders/open",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: ordersOpenQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const walletAddresses = await resolveRequestedWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          { allowPolymarketFunders: true },
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const marketIds =
          query.marketId || !query.eventId
            ? []
            : await fetchUnifiedMarketIdsByEventId(pool, query.eventId);
        if (query.eventId && !query.marketId && marketIds.length === 0) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            orders: [],
            pagination: {
              total: 0,
              limit: query.limit,
              offset: query.offset,
              hasMore: false,
            },
          });
        }

        const result = await fetchUnifiedOrders(pool, {
          userId: user.id,
          walletAddresses,
          venue: query.venue,
          marketId: query.marketId,
          marketIds: marketIds.length ? marketIds : undefined,
          tokenId: query.tokenId,
          status: OPEN_ORDER_STATUSES,
          openOnly: true,
          type: "order",
          limit: query.limit,
          offset: query.offset,
        });

        const orders = result.rows.map(mapUnifiedOrder);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          orders,
          pagination: {
            total: result.total,
            limit: query.limit,
            offset: query.offset,
            hasMore: query.offset + query.limit < result.total,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch open orders",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch open orders",
        });
      }
    },
  );

  /**
   * GET /orders/:id
   * Fetch a single unified order by id.
   */
  z.get(
    "/orders/:id",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: orderIdParamsSchema, querystring: orderIdQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const walletAddresses = await resolveRequestedWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
          { allowPolymarketFunders: true },
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const row = await fetchUnifiedOrderById(pool, {
          userId: user.id,
          walletAddresses,
          venue: undefined,
          status: undefined,
          id: request.params.id,
        });

        if (!row) {
          reply.code(404);
          return reply.send({ error: "Order not found" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ order: mapUnifiedOrder(row) });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, orderId: request.params.id },
          "Failed to fetch order",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch order",
        });
      }
    },
  );
};
