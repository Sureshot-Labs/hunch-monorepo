import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { fetchActiveFeePolicy } from "../repos/fee-policy.js";
import { feePolicyQuerySchema } from "../schemas/fees.js";

const MAX_FEE_BPS = 10_000;
const MAX_FEE_SCALE = 10_000;
const MS_PER_SEC = 1000;

function clampFeeBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_FEE_BPS);
}

function clampFeeScale(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), MAX_FEE_SCALE);
}

export const feesRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /fees/policy
   * Return a per-venue fee policy for Quick Buy.
   */
  z.get(
    "/fees/policy",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: feePolicyQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const venue = request.query.venue;
      const activePolicy = await fetchActiveFeePolicy(pool, venue);
      const feeBpsRaw =
        activePolicy?.fee_bps ??
        (venue === "polymarket" ? env.feeBpsPolymarket : env.feeBpsKalshi);
      const feeBps = clampFeeBps(feeBpsRaw);
      const feeScaleRaw =
        venue === "kalshi"
          ? (activePolicy?.fee_scale ?? env.feeScaleKalshi)
          : 0;
      const feeScale = clampFeeScale(feeScaleRaw);

      const ttlMs = env.feePolicyTtlSec * MS_PER_SEC;
      const deadline = new Date(Date.now() + ttlMs).toISOString();

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue,
        feeBps,
        feeScale: feeScale > 0 ? feeScale : null,
        deadline,
        collectorAddress: env.feeCollectorAddress || null,
        feeAccount: venue === "kalshi" ? env.dflowFeeAccount || null : null,
      });
    },
  );
};
