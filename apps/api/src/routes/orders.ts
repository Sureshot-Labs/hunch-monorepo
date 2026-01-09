import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import {
  fetchUnifiedOrderById,
  fetchUnifiedOrders,
} from "../repos/unified-orders.js";
import {
  orderIdParamsSchema,
  orderIdQuerySchema,
  ordersOpenQuerySchema,
  ordersQuerySchema,
} from "../schemas/orders.js";

const toNumber = (value: string | null): number | null => {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const mapUnifiedOrder = (
  row: Awaited<ReturnType<typeof fetchUnifiedOrders>>["rows"][number],
) => ({
  id: row.id,
  kind: row.kind,
  venue: row.venue,
  walletAddress: row.wallet_address,
  venueOrderId: row.venue_order_id,
  tokenId: row.token_id,
  side: row.side,
  outcome: row.outcome,
  orderType: row.order_type,
  price: toNumber(row.price),
  size: toNumber(row.size),
  status: row.status,
  filledSize: toNumber(row.filled_size),
  averageFillPrice: toNumber(row.average_fill_price),
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  filledAt: row.filled_at,
  cancelledAt: row.cancelled_at,
  unifiedMarketId: row.unified_market_id,
  inputMint: row.input_mint,
  outputMint: row.output_mint,
  amountIn: toNumber(row.amount_in),
  amountOut: toNumber(row.amount_out),
  inputDecimals: toNumber(row.input_decimals),
  outputDecimals: toNumber(row.output_decimals),
  txSignature: row.tx_signature,
});

export const ordersRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const resolveWalletAddresses = async (
    userId: string,
    walletAddress: string | undefined,
    requestedWallets: string[] | undefined,
  ): Promise<string[]> => {
    if (requestedWallets && requestedWallets.length) {
      const wallets = await AuthService.getUserWallets(userId);
      const walletMap = new Map(
        wallets.map((wallet) => [
          wallet.walletAddress.toLowerCase(),
          wallet.walletAddress,
        ]),
      );
      const resolved = requestedWallets
        .map((address) => address.trim().toLowerCase())
        .map((address) => walletMap.get(address))
        .filter((address): address is string => Boolean(address));
      return Array.from(new Set(resolved));
    }

    if (!walletAddress) return [];
    return [walletAddress];
  };

  const resolveMarketIds = async (
    eventId: string | undefined,
  ): Promise<string[]> => {
    if (!eventId) return [];
    const { rows } = await pool.query<{ id: string }>(
      `
        select id
        from unified_markets
        where event_id = $1
      `,
      [eventId],
    );
    return rows.map((row) => row.id);
  };

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
        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const marketIds =
          query.marketId || !query.eventId
            ? []
            : await resolveMarketIds(query.eventId);
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
          message: error instanceof Error ? error.message : "Unknown error",
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
        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const marketIds =
          query.marketId || !query.eventId
            ? []
            : await resolveMarketIds(query.eventId);
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
          status: "open",
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
          message: error instanceof Error ? error.message : "Unknown error",
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
        const walletAddresses = await resolveWalletAddresses(
          user.id,
          walletAddress,
          query.wallets,
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
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );
};
