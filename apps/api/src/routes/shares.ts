import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { resolveRequestedWalletAddresses } from "../lib/resolve-wallets.js";
import {
  shareIdParamsSchema,
  portfolioPnlShareCreateBodySchema,
  tradePnlShareCreateBodySchema,
} from "../schemas/shares.js";
import {
  cacheTradePnlShare,
  getCachedTradePnlShare,
  ShareCreateGuardError,
  type ShareCreateKind,
  withShareCreateGuard,
} from "../services/share-create-guard.js";
import {
  createPortfolioPnlShare,
  createTradePnlShare,
  getPublicShareSnapshot,
  ShareSnapshotError,
} from "../services/share-snapshots.js";

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

function sendShareCreateThrottle(
  reply: FastifyReply,
  error: ShareCreateGuardError,
) {
  reply.header("Retry-After", String(error.retryAfterSec));
  reply.code(error.statusCode);
  return reply.send({ error: "rate_limit_exceeded" });
}

export const sharesRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  function logShareCreateThrottle(inputs: {
    userId: string;
    kind: ShareCreateKind;
    error: ShareCreateGuardError;
  }): void {
    app.log.warn(
      {
        userId: inputs.userId,
        kind: inputs.kind,
        reason: inputs.error.reason,
      },
      "Share create throttled",
    );
  }

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

      const body = request.body;
      try {
        const share = await withShareCreateGuard(
          { userId: user.id, kind: "portfolio_pnl" },
          async () => {
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
              throw new ShareSnapshotError(
                400,
                "No wallets available to query.",
              );
            }

            return createPortfolioPnlShare(pool, {
              userId: user.id,
              walletAddresses,
              referralCode: body.referralCode,
              venue: body.venue,
              venues: body.venues,
              topPositionId: body.topPositionId,
            });
          },
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(share);
      } catch (error) {
        if (error instanceof ShareCreateGuardError) {
          logShareCreateThrottle({
            userId: user.id,
            kind: "portfolio_pnl",
            error,
          });
          return sendShareCreateThrottle(reply, error);
        }
        const statusCode = errorStatusCode(error);
        if (statusCode >= 500) {
          app.log.error(
            { error, userId: user.id },
            "Failed to create PnL share",
          );
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

      try {
        const cachedShare = await getCachedTradePnlShare({
          userId: user.id,
          positionId: request.body.positionId,
          referralCode: request.body.referralCode,
        });
        if (cachedShare) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedShare);
        }

        const share = await withShareCreateGuard(
          { userId: user.id, kind: "trade_pnl" },
          () =>
            createTradePnlShare(pool, {
              userId: user.id,
              positionId: request.body.positionId,
              referralCode: request.body.referralCode,
            }),
        );
        await cacheTradePnlShare(
          {
            userId: user.id,
            positionId: request.body.positionId,
            referralCode: request.body.referralCode,
          },
          share,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send(share);
      } catch (error) {
        if (error instanceof ShareCreateGuardError) {
          logShareCreateThrottle({
            userId: user.id,
            kind: "trade_pnl",
            error,
          });
          return sendShareCreateThrottle(reply, error);
        }
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
