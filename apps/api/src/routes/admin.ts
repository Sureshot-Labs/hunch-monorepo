import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAdminMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { fetchActiveFeePolicy, insertFeePolicy } from "../repos/fee-policy.js";
import { fetchActiveRewardsPolicy } from "../repos/rewards.js";
import { getRewardsPolicy } from "../services/rewards.js";
import {
  adminFeePolicySchema,
  adminPointsSchema,
  adminRewardsPolicySchema,
} from "../schemas/admin.js";

const MAX_FEE_SCALE = 10_000;
const MAX_FEE_BPS = 10_000;

function clampFeeBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_FEE_BPS);
}

function clampFeeScale(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.min(Math.max(value, 0), MAX_FEE_SCALE);
}

async function resolveUserIdByWallet(walletAddress: string) {
  const { rows } = await pool.query<{ user_id: string }>(
    `
      select user_id
      from user_wallets
      where lower(wallet_address) = lower($1)
    `,
    [walletAddress.trim()],
  );
  const unique = Array.from(new Set(rows.map((row) => row.user_id)));
  if (unique.length === 0) return null;
  if (unique.length > 1) {
    throw new Error("Multiple users found for wallet; specify userId");
  }
  return unique[0];
}

async function fetchPrimaryWallet(userId: string) {
  const { rows } = await pool.query<{ wallet_address: string | null }>(
    `
      select wallet_address
      from user_wallets
      where user_id = $1
      order by is_primary desc, created_at asc
      limit 1
    `,
    [userId.trim()],
  );
  return rows[0]?.wallet_address ?? null;
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/admin/fees/policy",
    { preHandler: createAdminMiddleware() },
    async (_request, reply) => {
      const [poly, kalshi] = await Promise.all([
        fetchActiveFeePolicy(pool, "polymarket"),
        fetchActiveFeePolicy(pool, "kalshi"),
      ]);

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        fees: {
          polymarket: {
            feeBps: clampFeeBps(poly?.fee_bps ?? env.feeBpsPolymarket),
            feeScale: null,
            effectiveAt: poly?.effective_at ?? null,
            source: poly ? "db" : "env",
          },
          kalshi: {
            feeBps: clampFeeBps(kalshi?.fee_bps ?? env.feeBpsKalshi),
            feeScale: clampFeeScale(kalshi?.fee_scale ?? env.feeScaleKalshi),
            effectiveAt: kalshi?.effective_at ?? null,
            source: kalshi ? "db" : "env",
          },
        },
      });
    },
  );

  z.post(
    "/admin/fees/policy",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminFeePolicySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();
      const feeScale =
        body.venue === "kalshi" ? clampFeeScale(body.feeScale) : null;

      const row = await insertFeePolicy(pool, {
        venue: body.venue,
        feeBps: clampFeeBps(body.feeBps),
        feeScale,
        effectiveAt,
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          venue: row.venue,
          feeBps: row.fee_bps,
          feeScale: row.fee_scale,
          effectiveAt: row.effective_at,
          createdAt: row.created_at,
        },
      });
    },
  );

  z.get(
    "/admin/rewards/policy",
    { preHandler: createAdminMiddleware() },
    async (_request, reply) => {
      const active = await fetchActiveRewardsPolicy(pool);
      const policy = await getRewardsPolicy(pool);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy,
        active: active
          ? {
              effectiveAt: active.effective_at,
              tiers: active.tiers,
              referralBonus: active.referral_bonus,
              createdAt: active.created_at,
            }
          : null,
      });
    },
  );

  z.post(
    "/admin/rewards/policy",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminRewardsPolicySchema },
    },
    async (request, reply) => {
      const body = request.body;
      const effectiveAt = body.effectiveAt
        ? new Date(body.effectiveAt)
        : new Date();

      const { rows } = await pool.query<{
        effective_at: Date;
        created_at: Date;
      }>(
        `
          insert into rewards_policy (effective_at, tiers, referral_bonus)
          values ($1, $2, $3)
          returning effective_at, created_at
        `,
        [effectiveAt, JSON.stringify(body.tiers), JSON.stringify(body.referralBonus)],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        policy: {
          effectiveAt: rows[0]?.effective_at ?? effectiveAt,
          createdAt: rows[0]?.created_at ?? effectiveAt,
        },
      });
    },
  );

  z.post(
    "/admin/rewards/points",
    {
      preHandler: createAdminMiddleware(),
      schema: { body: adminPointsSchema },
    },
    async (request, reply) => {
      const body = request.body;
      const walletInput = body.walletAddress?.trim();
      let userId = body.userId?.trim() ?? null;
      if (!userId && walletInput) {
        try {
          userId = await resolveUserIdByWallet(walletInput);
        } catch (error) {
          reply.code(400);
          return reply.send({
            error: error instanceof Error ? error.message : "Wallet lookup failed",
          });
        }
      }

      if (!userId) {
        reply.code(404);
        return reply.send({ error: "User not found" });
      }

      const walletAddress =
        walletInput ?? (await fetchPrimaryWallet(userId)) ?? null;
      const sourceType = body.sourceType ?? "execution";
      const sourceId = body.sourceId?.trim() ?? `manual:${randomUUID()}`;
      const venue = body.venue?.trim() ?? "admin";

      const { rows } = await pool.query<{ id: string }>(
        `
          insert into volume_events (
            id,
            user_id,
            wallet_address,
            venue,
            source_type,
            source_id,
            notional_usd,
            created_at
          )
          values (
            gen_random_uuid(),
            $1, $2, $3, $4, $5, $6, now()
          )
          on conflict (user_id, source_type, source_id) do nothing
          returning id
        `,
        [userId, walletAddress, venue, sourceType, sourceId, body.amount],
      );

      if (!rows.length) {
        reply.code(409);
        return reply.send({
          error: "Volume event already exists",
          sourceId,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        event: {
          id: rows[0].id,
          userId,
          walletAddress,
          venue,
          sourceType,
          sourceId,
          amount: body.amount,
        },
      });
    },
  );
};
