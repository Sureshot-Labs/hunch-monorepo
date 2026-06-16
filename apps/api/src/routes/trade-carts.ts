import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import {
  addTradeCartItemIdempotent,
  createTradeCart,
  getTradeCartDetail,
  listTradeCarts,
  patchTradeCartItem,
} from "../repos/trade-carts-repo.js";
import {
  allocateTradeCart,
  TradeCartAllocationError,
} from "../services/trade-cart-allocation.js";
import {
  preflightTradeCart,
  TradeCartPreflightError,
} from "../services/trade-cart-preflight.js";
import {
  tradeCartAllocateBodySchema,
  tradeCartCreateBodySchema,
  tradeCartItemCreateBodySchema,
  tradeCartItemParamsSchema,
  tradeCartItemPatchBodySchema,
  tradeCartPreflightBodySchema,
  tradeCartsListQuerySchema,
  uuidParamsSchema,
} from "../schemas/trade-carts.js";

export const tradeCartRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.post(
    "/trade-carts",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: tradeCartCreateBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const body = request.body;
        const cart = await createTradeCart(pool, {
          userId: user.id,
          name: body.name,
          sourceType: body.sourceType,
          sourceId: body.sourceId,
          metadata: body.metadata,
        });

        reply.code(201);
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, cart });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to create trade cart");
        reply.code(500);
        return reply.send({ error: "Failed to create trade cart" });
      }
    },
  );

  z.get(
    "/trade-carts",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: tradeCartsListQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;

      try {
        const result = await listTradeCarts(pool, {
          userId: user.id,
          status: query.status,
          limit: query.limit,
          offset: query.offset,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          carts: result.carts,
          pagination: {
            total: result.total,
            limit: query.limit,
            offset: query.offset,
            hasMore: query.offset + query.limit < result.total,
          },
        });
      } catch (error) {
        app.log.error({ error, userId: user.id }, "Failed to list trade carts");
        reply.code(500);
        return reply.send({ error: "Failed to list trade carts" });
      }
    },
  );

  z.get(
    "/trade-carts/:cartId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: uuidParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const detail = await getTradeCartDetail(pool, {
          userId: user.id,
          cartId: request.params.cartId,
        });

        if (!detail) {
          reply.code(404);
          return reply.send({ error: "Trade cart not found" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, ...detail });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, cartId: request.params.cartId },
          "Failed to fetch trade cart",
        );
        reply.code(500);
        return reply.send({ error: "Failed to fetch trade cart" });
      }
    },
  );

  z.post(
    "/trade-carts/:cartId/items",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: uuidParamsSchema, body: tradeCartItemCreateBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      try {
        const item = await addTradeCartItemIdempotent(pool, {
          userId: user.id,
          cartId: request.params.cartId,
          clientItemId: body.clientItemId,
          venue: body.venue,
          marketId: body.marketId,
          tokenId: body.tokenId,
          marketSlug: body.marketSlug,
          outcome: body.outcome,
          side: body.side,
          orderType: body.orderType,
          limitPrice: body.limitPrice,
          amountRaw: body.amountRaw,
          allocationWeight: body.allocationWeight,
          walletAddress: body.walletAddress,
          signerAddress: body.signerAddress,
          funderAddress: body.funderAddress,
          intentSnapshot: body.intentSnapshot,
        });

        if (!item) {
          reply.code(404);
          return reply.send({ error: "Trade cart not found" });
        }

        reply.code(201);
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, item });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, cartId: request.params.cartId },
          "Failed to add trade cart item",
        );
        reply.code(500);
        return reply.send({ error: "Failed to add trade cart item" });
      }
    },
  );

  z.patch(
    "/trade-carts/:cartId/items/:itemId",
    {
      preHandler: createAuthMiddleware(),
      schema: {
        params: tradeCartItemParamsSchema,
        body: tradeCartItemPatchBodySchema,
      },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const item = await patchTradeCartItem(pool, {
          userId: user.id,
          cartId: request.params.cartId,
          itemId: request.params.itemId,
          patch: request.body,
        });

        if (!item) {
          reply.code(404);
          return reply.send({ error: "Trade cart item not found" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, item });
      } catch (error) {
        app.log.error(
          {
            error,
            userId: user.id,
            cartId: request.params.cartId,
            itemId: request.params.itemId,
          },
          "Failed to update trade cart item",
        );
        reply.code(500);
        return reply.send({ error: "Failed to update trade cart item" });
      }
    },
  );

  z.post(
    "/trade-carts/:cartId/allocate",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: uuidParamsSchema, body: tradeCartAllocateBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const allocation = await allocateTradeCart(pool, {
          userId: user.id,
          cartId: request.params.cartId,
          mode: request.body.mode,
          totalAmountRaw: request.body.totalAmountRaw,
          itemAmounts: request.body.itemAmounts,
          itemWeights: request.body.itemWeights,
        });

        if (!allocation) {
          reply.code(404);
          return reply.send({ error: "Trade cart not found" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, ...allocation });
      } catch (error) {
        if (error instanceof TradeCartAllocationError) {
          reply.code(error.statusCode);
          return reply.send({ error: error.message });
        }
        app.log.error(
          { error, userId: user.id, cartId: request.params.cartId },
          "Failed to allocate trade cart",
        );
        reply.code(500);
        return reply.send({ error: "Failed to allocate trade cart" });
      }
    },
  );

  z.post(
    "/trade-carts/:cartId/preflight",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: uuidParamsSchema, body: tradeCartPreflightBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const result = await preflightTradeCart(pool, {
          userId: user.id,
          cartId: request.params.cartId,
          itemIds: request.body.itemIds,
          refresh: request.body.refresh,
        });

        if (!result) {
          reply.code(404);
          return reply.send({ error: "Trade cart not found" });
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ cart: result.cart, ...result.preflight });
      } catch (error) {
        if (error instanceof TradeCartPreflightError) {
          reply.code(error.statusCode);
          return reply.send({ error: error.message });
        }
        app.log.error(
          { error, userId: user.id, cartId: request.params.cartId },
          "Failed to preflight trade cart",
        );
        reply.code(500);
        return reply.send({ error: "Failed to preflight trade cart" });
      }
    },
  );
};
