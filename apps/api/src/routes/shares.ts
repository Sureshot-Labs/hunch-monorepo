import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { resolveRequestedWalletAddresses } from "../lib/resolve-wallets.js";
import {
  shareIdParamsSchema,
  portfolioPnlShareCreateBodySchema,
  tradePnlShareCreateBodySchema,
} from "../schemas/shares.js";
import {
  createPortfolioPnlShare,
  createTradePnlShare,
  getPublicShareSnapshot,
  ShareSnapshotError,
} from "../services/share-snapshots.js";

const SHARE_CREATE_RATE_LIMIT_MAX = 60;
const SHARE_CREATE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

async function enforceShareCreateRateLimit(userId: string): Promise<boolean> {
  return checkRateLimit(
    `shares:create:${userId}`,
    SHARE_CREATE_RATE_LIMIT_MAX,
    SHARE_CREATE_RATE_LIMIT_WINDOW_MS,
    { onError: "fail_open" },
  );
}

function errorStatusCode(error: unknown): number {
  if (error instanceof ShareSnapshotError) return error.statusCode;
  return 500;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

export const sharesRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.post(
    "/shares/portfolio-pnl",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: portfolioPnlShareCreateBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const allowed = await enforceShareCreateRateLimit(user.id);
      if (!allowed) {
        reply.code(429);
        return reply.send({ error: "rate_limit_exceeded" });
      }

      const body = request.body;
      try {
        const allowPolymarketFunders =
          body.venue === "polymarket" ||
          body.venues?.includes("polymarket") ||
          (!body.venue && (!body.venues || body.venues.length === 0));
        const walletAddresses = await resolveRequestedWalletAddresses(
          user.id,
          walletAddress,
          body.wallets,
          { allowPolymarketFunders },
        );
        if (walletAddresses.length === 0) {
          reply.code(400);
          return reply.send({ error: "No wallets available to query." });
        }

        const share = await createPortfolioPnlShare(pool, {
          userId: user.id,
          walletAddresses,
          referralCode: body.referralCode,
          venue: body.venue,
          venues: body.venues,
          topPositionId: body.topPositionId,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(share);
      } catch (error) {
        const statusCode = errorStatusCode(error);
        if (statusCode >= 500) {
          app.log.error({ error, userId: user.id }, "Failed to create PnL share");
        }
        reply.code(statusCode);
        return reply.send({
          error: errorMessage(error, "Failed to create PnL share"),
        });
      }
    },
  );

  z.post(
    "/shares/trade-pnl",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: tradePnlShareCreateBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const allowed = await enforceShareCreateRateLimit(user.id);
      if (!allowed) {
        reply.code(429);
        return reply.send({ error: "rate_limit_exceeded" });
      }

      try {
        const share = await createTradePnlShare(pool, {
          userId: user.id,
          positionId: request.body.positionId,
          referralCode: request.body.referralCode,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(share);
      } catch (error) {
        const statusCode = errorStatusCode(error);
        if (statusCode >= 500) {
          app.log.error(
            { error, userId: user.id },
            "Failed to create trade PnL share",
          );
        }
        reply.code(statusCode);
        return reply.send({
          error: errorMessage(error, "Failed to create trade PnL share"),
        });
      }
    },
  );

  z.get(
    "/shares/portfolio-pnl/:shareId",
    { schema: { params: shareIdParamsSchema } },
    async (request, reply) => {
      const share = await getPublicShareSnapshot(pool, {
        id: request.params.shareId,
        kind: "portfolio_pnl",
      });
      if (!share) {
        reply.code(404);
        return reply.send({ error: "Share not found" });
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(share);
    },
  );

  z.get(
    "/shares/trade-pnl/:shareId",
    { schema: { params: shareIdParamsSchema } },
    async (request, reply) => {
      const share = await getPublicShareSnapshot(pool, {
        id: request.params.shareId,
        kind: "trade_pnl",
      });
      if (!share) {
        reply.code(404);
        return reply.send({ error: "Share not found" });
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(share);
    },
  );

  z.get(
    "/shares/:shareId",
    { schema: { params: shareIdParamsSchema } },
    async (request, reply) => {
      const share = await getPublicShareSnapshot(pool, {
        id: request.params.shareId,
      });
      if (!share) {
        reply.code(404);
        return reply.send({ error: "Share not found" });
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send(share);
    },
  );
};
