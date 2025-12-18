import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import type { Order } from "../order-types.js";
import {
  fetchOrderHistoryRows,
  fetchOrdersForUser,
  findOrderVenueForUser,
  storeOrder,
} from "../repos/orders-repo.js";
import { fetchPositionsForUserWallet } from "../repos/positions-repo.js";
import { syncPositionsForUserWallet } from "../services/positions-sync.js";
import { VenueOrderManagerFactory } from "../venue-order-manager-factory.js";
import {
  orderHistoryQuerySchema,
  orderIdParamsSchema,
  ordersForWalletParamsSchema,
  ordersForWalletQuerySchema,
  ordersListQuerySchema,
  placeOrderBodySchema,
  positionsQuerySchema,
  storeOrderBodySchema,
} from "../schemas/orders.js";

export const orderRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * POST /orders
   * Place a new order
   */
  z.post(
    "/orders",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: placeOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      const l1Headers = {
        l1Signature: request.headers["poly_signature"] as string,
        l1Timestamp: request.headers["poly_timestamp"] as string,
        l1Nonce: request.headers["poly_nonce"] as string,
      };

      try {
        const result = await VenueOrderManagerFactory.placeOrder(
          body.venue,
          user.id,
          walletAddress,
          request.headers,
          {
            tokenId: body.tokenId,
            side: body.side,
            orderType: body.orderType,
            price: body.price,
            size: body.size,
            expiresAt: body.expiresAt,
            l1Signature: l1Headers.l1Signature || body.l1Signature,
            l1Timestamp: l1Headers.l1Timestamp || body.l1Timestamp,
            l1Nonce: l1Headers.l1Nonce || body.l1Nonce,
          },
        );

        if (result.success) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            message: "Order placed successfully",
            orderId: result.orderId,
            venueOrderId: result.venueOrderId,
            status: result.status,
          });
        }

        reply.code(400);
        return reply.send({
          error: result.errorMessage || "Failed to place order",
          rawError: result.rawError,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, body },
          "Failed to place order",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to place order",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /orders
   * Get active orders for the user
   */
  z.get(
    "/orders",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: ordersListQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const venue = query.venue;

      try {
        if (venue) {
          const result = await VenueOrderManagerFactory.getActiveOrders(
            venue,
            user.id,
            walletAddress,
          );

          if (result.success) {
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({ orders: result.orders, venue });
          }

          reply.code(400);
          return reply.send({
            error: result.errorMessage || "Failed to fetch orders",
          });
        }

        const allOrders: Order[] = [];
        for (const v of ["polymarket", "kalshi", "limitless"] as const) {
          try {
            const result = await VenueOrderManagerFactory.getActiveOrders(
              v,
              user.id,
              walletAddress,
            );
            if (result.success) allOrders.push(...result.orders);
          } catch (error) {
            app.log.warn(
              { error, venue: v, userId: user.id },
              `Failed to fetch orders for ${v}`,
            );
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ orders: allOrders });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch orders",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch orders",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /orders/:id
   * Get specific order details
   */
  z.get(
    "/orders/:id",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: orderIdParamsSchema,
        querystring: ordersListQuerySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const params = request.params;
      const query = request.query;
      const venueQuery = query.venue;

      try {
        const venueFromDb = await findOrderVenueForUser(pool, {
          orderId: params.id,
          userId: user.id,
          walletAddress,
        });

        if (!venueFromDb) {
          reply.code(404);
          return reply.send({ error: "Order not found" });
        }

        const venueFromDbTyped = venueFromDb as
          | "polymarket"
          | "kalshi"
          | "limitless";

        if (venueQuery && venueQuery !== venueFromDbTyped) {
          reply.code(400);
          return reply.send({
            error: "Venue mismatch for order",
            venue: venueFromDbTyped,
          });
        }

        const venue = venueQuery ?? venueFromDbTyped;
        const result = await VenueOrderManagerFactory.getOrder(
          venue,
          user.id,
          walletAddress,
          params.id,
        );

        if (result.success) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({ order: result.order });
        }

        reply.code(400);
        return reply.send({
          error: result.errorMessage || "Failed to fetch order",
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, orderId: params.id },
          "Failed to fetch order",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch order",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * DELETE /orders/:id
   * Cancel an order
   */
  z.delete(
    "/orders/:id",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: orderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const params = request.params;

      try {
        const venueFromDb = await findOrderVenueForUser(pool, {
          orderId: params.id,
          userId: user.id,
          walletAddress,
        });

        if (!venueFromDb) {
          reply.code(404);
          return reply.send({ error: "Order not found" });
        }

        const result = await VenueOrderManagerFactory.cancelOrder(
          venueFromDb as "polymarket" | "kalshi" | "limitless",
          user.id,
          walletAddress,
          params.id,
        );

        if (result.success) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({ message: "Order cancelled successfully" });
        }

        reply.code(400);
        return reply.send({
          error: result.errorMessage || "Failed to cancel order",
          rawError: result.rawError,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress, orderId: params.id },
          "Failed to cancel order",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to cancel order",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /orders/history
   * Get order history for the user
   */
  z.get(
    "/orders/history",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: orderHistoryQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const limit = query.limit;
        const offset = query.offset;

        const rows = await fetchOrderHistoryRows(pool, {
          userId: user.id,
          walletAddress,
          venue: query.venue,
          status: query.status,
          limit,
          offset,
        });

        const orders = rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          venue: row.venue,
          venueOrderId: row.venue_order_id,
          tokenId: row.token_id,
          side: row.side,
          orderType: row.order_type,
          price: parseFloat(row.price),
          size: parseFloat(row.size),
          status: row.status,
          filledSize: parseFloat(row.filled_size || "0"),
          averageFillPrice: row.average_fill_price
            ? parseFloat(row.average_fill_price)
            : null,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          filledAt: row.filled_at,
          cancelledAt: row.cancelled_at,
          errorMessage: row.error_message,
          rawError: row.raw_error,
        }));

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          orders,
          pagination: {
            limit,
            offset,
            hasMore: orders.length === limit,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id },
          "Failed to fetch order history",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch order history",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /positions
   * Get user positions
   */
  z.get(
    "/positions",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: positionsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const venue = query.venue;

      try {
        const positions = await fetchPositionsForUserWallet(pool, {
          userId: user.id,
          walletAddress,
          venue,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        if (venue) return reply.send({ positions, venue });
        return reply.send({ positions });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch positions",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch positions",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /positions/sync
   * Sync cached positions for the selected wallet
   */
  z.post(
    "/positions/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: positionsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const result = await syncPositionsForUserWallet(pool, {
          userId: user.id,
          walletAddress,
          venue: query.venue,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Positions synced",
          ...result,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        const messageLower = message.toLowerCase();
        const statusCode = messageLower.includes("not implemented")
          ? 501
          : messageLower.includes("select a solana") ||
              messageLower.includes("evm address")
            ? 400
            : 500;

        if (statusCode >= 500) {
          app.log.error(
            { error, userId: user.id, walletAddress, venue: query.venue },
            "Failed to sync positions",
          );
        }

        reply.code(statusCode);
        return reply.send({ error: message });
      }
    },
  );

  /**
   * POST /orders/store
   * Store order data after user performs the order on frontend
   */
  z.post(
    "/orders/store",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: storeOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const authedWalletAddress = request.walletAddress;
      if (!user || !authedWalletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      if (
        body.walletAddress.toLowerCase() !== authedWalletAddress.toLowerCase()
      ) {
        reply.code(403);
        return reply.send({
          error: "walletAddress does not match authenticated session",
        });
      }

      try {
        const result = await storeOrder(pool, {
          userId: user.id,
          walletAddress: authedWalletAddress,
          venue: body.venue ?? "polymarket",
          venueOrderId: body.orderID,
          tokenId: body.tokenId ?? null,
          side: body.side ?? null,
          price: body.price ?? null,
          size: body.size ?? null,
          status: body.status || "live",
          errorMessage: body.errorMsg ?? null,
          rawError: body.success === false ? JSON.stringify(body) : null,
        });

        if (result.kind === "exists") {
          reply.code(409);
          return reply.send({ error: "Order already exists" });
        }

        const newOrder = result.order;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          message: "Order stored successfully",
          order: {
            id: newOrder.id,
            orderID: newOrder.venue_order_id,
            status: newOrder.status,
            storedAt: newOrder.posted_at,
          },
        });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            walletAddress: body.walletAddress,
            orderID: body.orderID,
          },
          "Failed to store order",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to store order",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /orders/user/:walletAddress
   * Get order IDs for a specific wallet address
   */
  z.get(
    "/orders/user/:walletAddress",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: ordersForWalletParamsSchema,
        querystring: ordersForWalletQuerySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      const authedWalletAddress = request.walletAddress;
      if (!user || !authedWalletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const { walletAddress } = request.params;
      const query = request.query;

      if (walletAddress.toLowerCase() !== authedWalletAddress.toLowerCase()) {
        reply.code(403);
        return reply.send({
          error: "walletAddress does not match authenticated session",
        });
      }

      try {
        const limit = query.limit;
        const offset = query.offset;

        const result = await fetchOrdersForUser(pool, {
          userId: user.id,
          walletAddress: authedWalletAddress,
          status: query.status,
          venue: query.venue,
          limit,
          offset,
        });

        const orders = result.rows.map((row) => ({
          id: row.id,
          orderID: row.venue_order_id,
          venue: row.venue,
          tokenId: row.token_id,
          side: row.side,
          orderType: row.order_type,
          price: row.price ? parseFloat(row.price) : null,
          size: row.size ? parseFloat(row.size) : null,
          status: row.status,
          filledSize: row.filled_size ? parseFloat(row.filled_size) : 0,
          averageFillPrice: row.average_fill_price
            ? parseFloat(row.average_fill_price)
            : null,
          postedAt: row.posted_at,
          lastUpdate: row.last_update,
          filledAt: row.filled_at,
          cancelledAt: row.cancelled_at,
        }));

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          walletAddress,
          orders,
          pagination: {
            total: result.total,
            limit,
            offset,
            hasMore: offset + limit < result.total,
          },
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, walletAddress },
          "Failed to fetch orders for wallet address",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to fetch orders",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
