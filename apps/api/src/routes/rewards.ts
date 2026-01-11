import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { tx } from "@hunch/infra";
import type { PoolClient } from "pg";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import {
  rewardsClaimBodySchema,
  rewardsReferralsQuerySchema,
} from "../schemas/rewards.js";
import {
  createRewardClaim,
  getOrCreateReferralCode,
  getRewardsPolicy,
  getRewardsReferrals,
  getRewardsSummary,
} from "../services/rewards.js";
import {
  buildRewardNotification,
  createNotificationSafe,
} from "../services/notifications.js";

export const rewardsRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/rewards/policy",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const policy = await getRewardsPolicy(pool);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, policy });
    },
  );

  z.get(
    "/rewards/summary",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const summary = await getRewardsSummary(pool, { userId: user.id });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, summary });
    },
  );

  z.get(
    "/rewards/referral-code",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const code = await getOrCreateReferralCode(pool, user.id);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, code });
    },
  );

  z.get(
    "/rewards/referrals",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: rewardsReferralsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const data = await getRewardsReferrals(pool, {
        userId: user.id,
        limit: query.limit,
        offset: query.offset,
      });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, ...data });
    },
  );

  z.post(
    "/rewards/claim",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: rewardsClaimBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const targetWallet =
        body.walletAddress?.trim() || walletAddress.trim();
      if (!targetWallet) {
        reply.code(400);
        return reply.send({ error: "Missing wallet address" });
      }

      const wallet = await AuthService.getUserWalletByAddress(
        user.id,
        targetWallet,
      );
      if (!wallet) {
        reply.code(403);
        return reply.send({
          error: "Wallet is not linked to this user",
        });
      }

      const chainId = body.chainId.trim();
      const walletType = wallet.walletType?.toLowerCase() ?? "";
      const isSolanaChain = chainId === "solana";
      if (isSolanaChain && walletType !== "solana") {
        reply.code(400);
        return reply.send({
          error: "Solana payouts require a Solana wallet",
        });
      }
      if (!isSolanaChain && walletType === "solana") {
        reply.code(400);
        return reply.send({
          error: "EVM payouts require an EVM wallet",
        });
      }

      try {
        const claim = await tx(pool, async (client: PoolClient) => {
          await client.query(
            "select pg_advisory_xact_lock(hashtext($1)::bigint)",
            [user.id],
          );

          const summary = await getRewardsSummary(
            client,
            { userId: user.id },
            { skipReconcile: true },
          );
          const claimable =
            summary.cashback.byChain?.[chainId]?.claimable ?? 0;
          if (claimable <= 0) {
            const error = new Error("No claimable cashback available");
            (error as Error & { statusCode?: number }).statusCode = 400;
            throw error;
          }

          const requestedAmount = body.amount ?? claimable;
          if (requestedAmount <= 0) {
            const error = new Error("Invalid claim amount");
            (error as Error & { statusCode?: number }).statusCode = 400;
            throw error;
          }

          if (requestedAmount > claimable) {
            const error = new Error("Claim amount exceeds claimable balance");
            (error as Error & { statusCode?: number }).statusCode = 400;
            throw error;
          }

          const claim = await createRewardClaim(client, {
            userId: user.id,
            walletAddress: targetWallet,
            chainId,
            amountUsd: requestedAmount,
          });
          return { claimId: claim.claimId, amount: requestedAmount };
        });

        void createNotificationSafe(
          pool,
          buildRewardNotification({
            userId: user.id,
            status: "submitted",
            amountUsd: claim.amount,
            chainId,
            claimId: claim.claimId,
            walletAddress: targetWallet,
          }),
          request.log,
        );

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          claim: {
            id: claim.claimId,
            amount: claim.amount,
            status: "pending",
          },
        });
      } catch (error) {
        const statusCode =
          typeof error === "object" && error && "statusCode" in error
            ? Number((error as { statusCode?: number }).statusCode ?? 500)
            : 500;
        reply.code(Number.isFinite(statusCode) ? statusCode : 500);
        return reply.send({
          error:
            error instanceof Error && error.message
              ? error.message
              : "Failed to create claim",
        });
      }
    },
  );
};
