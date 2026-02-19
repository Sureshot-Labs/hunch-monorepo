import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { tx } from "@hunch/infra";
import type { PoolClient } from "pg";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { acquireRewardsUserAdvisoryXactLock } from "../lib/rewards-user-lock.js";
import {
  parseUsdcToMicro,
  usdcDecimalStringHasValidScale,
  usdcMicroToDecimalString,
} from "../lib/usdc.js";
import {
  rewardsClaimBodySchema,
  rewardsReferralAttachBodySchema,
  rewardsLeaderboardQuerySchema,
  rewardsReferralCodeUpdateBodySchema,
  rewardsReferralsQuerySchema,
} from "../schemas/rewards.js";
import {
  attachReferralCodeForExistingUser,
  createRewardClaim,
  getOrCreateReferralCode,
  getRewardsLeaderboard,
  getRewardsPolicy,
  getReferralAttachmentStatus,
  getRewardsClaimableByChainMicro,
  getRewardsReferrals,
  getRewardsSummary,
  setReferralCodeForUser,
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

  z.patch(
    "/rewards/referral-code",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: rewardsReferralCodeUpdateBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      try {
        const result = await tx(pool, async (client: PoolClient) => {
          await acquireRewardsUserAdvisoryXactLock(client, user.id);
          return setReferralCodeForUser(client, {
            userId: user.id,
            referralCode: request.body.code,
            forceTransfer: false,
          });
        });
        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({ ok: true, code: result.code });
      } catch (error) {
        const statusCode =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof (error as { statusCode?: unknown }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
        const message =
          error instanceof Error ? error.message : "Failed to set referral code";
        reply.code(statusCode);
        return reply.send({ error: message });
      }
    },
  );

  z.get(
    "/rewards/referral/status",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const referral = await getReferralAttachmentStatus(pool, { userId: user.id });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, referral });
    },
  );

  z.post(
    "/rewards/referral/attach",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: rewardsReferralAttachBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const result = await tx(pool, async (client: PoolClient) => {
        await acquireRewardsUserAdvisoryXactLock(client, user.id);
        return attachReferralCodeForExistingUser(client, {
          userId: user.id,
          referralCode: request.body.code,
        });
      });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, ...result });
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

  z.get(
    "/rewards/leaderboard",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: rewardsLeaderboardQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const leaderboard = await getRewardsLeaderboard(pool, {
        userId: user.id,
        metric: query.metric,
        interval: query.interval,
        limit: query.limit,
        offset: query.offset,
      });
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, leaderboard });
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

      const chainId = body.chainId;
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
          await acquireRewardsUserAdvisoryXactLock(client, user.id);

          const claimableByChain = await getRewardsClaimableByChainMicro(
            client,
            { userId: user.id },
          );
          const claimableMicro = claimableByChain[chainId] ?? 0n;
          if (claimableMicro <= 0n) {
            const error = new Error("No claimable cashback available");
            (error as Error & { statusCode?: number }).statusCode = 400;
            throw error;
          }

          if (body.amount && !usdcDecimalStringHasValidScale(body.amount)) {
            const error = new Error("Claim amount supports up to 6 decimals");
            (error as Error & { statusCode?: number }).statusCode = 400;
            throw error;
          }

          const requestedAmountMicro = body.amount
            ? parseUsdcToMicro(body.amount)
            : claimableMicro;
          if (!requestedAmountMicro || requestedAmountMicro <= 0n) {
            const error = new Error("Invalid claim amount");
            (error as Error & { statusCode?: number }).statusCode = 400;
            throw error;
          }

          if (requestedAmountMicro > claimableMicro) {
            const error = new Error("Claim amount exceeds claimable balance");
            (error as Error & { statusCode?: number }).statusCode = 400;
            throw error;
          }

          const requestedAmountUsd = usdcMicroToDecimalString(requestedAmountMicro);

          const claim = await createRewardClaim(client, {
            userId: user.id,
            walletAddress: targetWallet,
            chainId,
            amountUsd: requestedAmountUsd,
          });
          return { claimId: claim.claimId, amountUsd: requestedAmountUsd };
        });

        const amountNumber = Number(claim.amountUsd);

        void createNotificationSafe(
          pool,
          buildRewardNotification({
            userId: user.id,
            status: "submitted",
            amountUsd: Number.isFinite(amountNumber) ? amountNumber : 0,
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
            amount: Number.isFinite(amountNumber) ? amountNumber : 0,
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
