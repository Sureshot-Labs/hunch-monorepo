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
  TRADE_PNL_SHARE_REQUEST_TIMEOUT_MS,
  type ShareCreateKind,
  withShareCreateGuard,
  withTradePnlShareSingleflight,
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
  return reply.send({ error: error.message });
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

      const startedAt = Date.now();
      const requestDeadlineAt = startedAt + TRADE_PNL_SHARE_REQUEST_TIMEOUT_MS;
      let cacheLookupFinishedAt = startedAt;
      let snapshotStartedAt: number | null = null;
      let snapshotFinishedAt: number | null = null;
      let cacheWriteStartedAt: number | null = null;
      try {
        const cachedShare = await getCachedTradePnlShare({
          userId: user.id,
          positionId: request.body.positionId,
          referralCode: request.body.referralCode,
        });
        cacheLookupFinishedAt = Date.now();
        if (cachedShare) {
          app.log.info(
            {
              cacheHit: true,
              cacheLookupMs: cacheLookupFinishedAt - startedAt,
              positionId: request.body.positionId,
              totalMs: Date.now() - startedAt,
              userId: user.id,
            },
            "Trade PnL share latency",
          );
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(cachedShare);
        }

        const share = await withTradePnlShareSingleflight(
          {
            userId: user.id,
            positionId: request.body.positionId,
            referralCode: request.body.referralCode,
          },
          async () => {
            const cacheInputs = {
              userId: user.id,
              positionId: request.body.positionId,
              referralCode: request.body.referralCode,
            };
            // A follower may have observed a cache miss immediately before a
            // leader completed and left process-local singleflight. Recheck
            // inside the producer so that timing window cannot create a
            // duplicate snapshot.
            const racedCachedShare = await getCachedTradePnlShare(cacheInputs);
            if (racedCachedShare) return racedCachedShare;

            let created;
            try {
              created = await withShareCreateGuard(
                { userId: user.id, kind: "trade_pnl" },
                async () => {
                  // The distributed slot is the cross-process creation
                  // boundary. Recheck and populate the shared cache while the
                  // slot is still held, so no peer can create a second row in
                  // an unlock-before-cache-write window.
                  const guardedCachedShare =
                    await getCachedTradePnlShare(cacheInputs);
                  if (guardedCachedShare) return guardedCachedShare;

                  snapshotStartedAt = Date.now();
                  const snapshot = await createTradePnlShare(
                    pool,
                    cacheInputs,
                    {
                      statementTimeoutMs: 900,
                    },
                  );
                  snapshotFinishedAt = Date.now();
                  cacheWriteStartedAt = Date.now();
                  await cacheTradePnlShare(cacheInputs, snapshot);
                  return snapshot;
                },
              );
            } catch (error) {
              if (
                !(error instanceof ShareCreateGuardError) ||
                error.reason !== "user_inflight"
              ) {
                throw error;
              }
              // Another API process may own this exact request. Its cache
              // write happens before slot release; wait only within this
              // request's absolute deadline and reuse the result when ready.
              while (Date.now() < requestDeadlineAt) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                const completedShare =
                  await getCachedTradePnlShare(cacheInputs);
                if (completedShare) return completedShare;
              }
              throw error;
            }
            return created;
          },
          requestDeadlineAt,
        );

        const finishedAt = Date.now();
        app.log.info(
          {
            cacheHit: false,
            cacheLookupMs: cacheLookupFinishedAt - startedAt,
            cacheWriteMs:
              cacheWriteStartedAt == null
                ? null
                : finishedAt - cacheWriteStartedAt,
            guardAndSnapshotMs: finishedAt - cacheLookupFinishedAt,
            positionId: request.body.positionId,
            snapshotMs:
              snapshotStartedAt == null || snapshotFinishedAt == null
                ? null
                : snapshotFinishedAt - snapshotStartedAt,
            totalMs: finishedAt - startedAt,
            userId: user.id,
          },
          "Trade PnL share latency",
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
          app.log.warn(
            {
              cacheLookupMs: cacheLookupFinishedAt - startedAt,
              guardReason: error.reason,
              positionId: request.body.positionId,
              totalMs: Date.now() - startedAt,
              userId: user.id,
            },
            "Trade PnL share failed with latency",
          );
          return sendShareCreateThrottle(reply, error);
        }
        const statusCode = errorStatusCode(error);
        if (statusCode >= 500) {
          app.log.error(
            { error, userId: user.id },
            "Failed to create trade PnL share",
          );
        }
        app.log.warn(
          {
            cacheLookupMs: cacheLookupFinishedAt - startedAt,
            errorName: error instanceof Error ? error.name : "unknown",
            positionId: request.body.positionId,
            snapshotMs:
              snapshotStartedAt == null || snapshotFinishedAt == null
                ? null
                : snapshotFinishedAt - snapshotStartedAt,
            totalMs: Date.now() - startedAt,
            userId: user.id,
          },
          "Trade PnL share failed with latency",
        );
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
