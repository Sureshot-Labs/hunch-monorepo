import type { FastifyPluginAsync } from "fastify";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { parseOrReply } from "../lib/zod.js";
import type { Order, Position } from "../order-types.js";
import {
  fetchOrderHistoryRows,
  fetchOrdersForUser,
  findOrderVenueForUser,
  storeOrder,
} from "../repos/orders-repo.js";
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
  /**
   * POST /orders
   * Place a new order
   */
  app.post(
    "/orders",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = parseOrReply(reply, placeOrderBodySchema, request.body);
      if (!body) return;

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
  app.get(
    "/orders",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = parseOrReply(reply, ordersListQuerySchema, request.query);
      if (!query) return;
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
  app.get(
    "/orders/:id",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const params = parseOrReply(reply, orderIdParamsSchema, request.params);
      if (!params) return;
      const query = parseOrReply(reply, ordersListQuerySchema, request.query);
      if (!query) return;
      const venueQuery = query.venue;

      try {
        const venueFromDb = await findOrderVenueForUser(pool, {
          orderId: params.id,
          userId: user.id,
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
  app.delete(
    "/orders/:id",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const params = parseOrReply(reply, orderIdParamsSchema, request.params);
      if (!params) return;

      try {
        const venueFromDb = await findOrderVenueForUser(pool, {
          orderId: params.id,
          userId: user.id,
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
  app.get(
    "/orders/history",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = parseOrReply(reply, orderHistoryQuerySchema, request.query);
      if (!query) return;

      try {
        const limit = query.limit;
        const offset = query.offset;

        const rows = await fetchOrderHistoryRows(pool, {
          userId: user.id,
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
  app.get(
    "/positions",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = parseOrReply(reply, positionsQuerySchema, request.query);
      if (!query) return;
      const venue = query.venue;

      try {
        if (venue) {
          const result = await VenueOrderManagerFactory.getPositions(
            venue,
            user.id,
            walletAddress,
          );

          if (result.success) {
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({ positions: result.positions, venue });
          }

          reply.code(400);
          return reply.send({
            error: result.errorMessage || "Failed to fetch positions",
          });
        }

        const allPositions: Position[] = [];
        for (const v of ["polymarket", "kalshi", "limitless"] as const) {
          try {
            const result = await VenueOrderManagerFactory.getPositions(
              v,
              user.id,
              walletAddress,
            );
            if (result.success) allPositions.push(...result.positions);
          } catch (error) {
            app.log.warn(
              { error, venue: v, userId: user.id },
              `Failed to fetch positions for ${v}`,
            );
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ positions: allPositions });
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
   * POST /orders/store
   * Store order data after user performs the order on frontend
   */
  app.post(
    "/orders/store",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const authedWalletAddress = request.walletAddress;
      if (!user || !authedWalletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = parseOrReply(reply, storeOrderBodySchema, request.body);
      if (!body) return;

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
  app.get(
    "/orders/user/:walletAddress",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const authedWalletAddress = request.walletAddress;
      if (!user || !authedWalletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const paramsParsed = parseOrReply(
        reply,
        ordersForWalletParamsSchema,
        request.params,
      );
      if (!paramsParsed) return;
      const { walletAddress } = paramsParsed;

      const query = parseOrReply(
        reply,
        ordersForWalletQuerySchema,
        request.query,
      );
      if (!query) return;

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
