import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { fetchActiveFeePolicy } from "../repos/fee-policy.js";
import { feePolicyQuerySchema } from "../schemas/fees.js";
import { resolveLimitlessFeeShareConfig } from "../services/limitless-fee-accruals.js";
import { resolvePolymarketFeePolicySnapshot } from "../services/polymarket-builder-fees.js";

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
      const polymarketSnapshot =
        venue === "polymarket"
          ? await resolvePolymarketFeePolicySnapshot(pool)
          : null;
      const limitlessConfig =
        venue === "limitless"
          ? await resolveLimitlessFeeShareConfig(pool)
          : null;
      const activePolicy =
        venue === "polymarket" || venue === "limitless"
          ? null
          : await fetchActiveFeePolicy(pool, venue);
      const feeBpsRaw =
        polymarketSnapshot?.legacyFeeBps ??
        activePolicy?.fee_bps ??
        env.feeBpsKalshi;
      const feeBps = clampFeeBps(feeBpsRaw);
      const feeScaleRaw =
        venue === "kalshi"
          ? (activePolicy?.fee_scale ?? env.feeScaleKalshi)
          : 0;
      const feeScale = clampFeeScale(feeScaleRaw);

      const ttlMs = env.feePolicyTtlSec * MS_PER_SEC;
      const deadline = new Date(Date.now() + ttlMs).toISOString();
      const collectionMode =
        venue === "polymarket"
          ? (polymarketSnapshot?.collectionMode ?? "none")
          : venue === "limitless"
            ? limitlessConfig?.active
              ? "venue_share"
              : "none"
            : "fee_auth";
      const effectiveFeeBps =
        (venue === "polymarket" && collectionMode !== "fee_auth") ||
        venue === "limitless"
          ? 0
          : feeBps;

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue,
        feeBps: effectiveFeeBps,
        feeScale: feeScale > 0 ? feeScale : null,
        deadline,
        collectionMode,
        builderCode: polymarketSnapshot?.builderCode ?? null,
        builderTakerFeeBps: polymarketSnapshot?.builderTakerFeeBps ?? null,
        builderMakerFeeBps: polymarketSnapshot?.builderMakerFeeBps ?? null,
        builderRateSource: polymarketSnapshot?.builderRateSource ?? null,
        builderEnabled: polymarketSnapshot?.builderEnabled ?? null,
        venueFeeShareBps: limitlessConfig?.shareBps ?? null,
        collectorAddress:
          collectionMode === "fee_auth"
            ? env.feeCollectorAddress || null
            : null,
        feeAccount: venue === "kalshi" ? env.dflowFeeAccount || null : null,
      });
    },
  );
};
