import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { env } from "../env.js";
import { feePolicyQuerySchema } from "../schemas/fees.js";

const MAX_FEE_BPS = 10_000;
const POLICY_TTL_MS = 5 * 60 * 1000;

function clampFeeBps(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), MAX_FEE_BPS);
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
      const feeBpsRaw =
        venue === "polymarket" ? env.feeBpsPolymarket : env.feeBpsKalshi;
      const feeBps = clampFeeBps(feeBpsRaw);

      const deadline = new Date(Date.now() + POLICY_TTL_MS).toISOString();

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue,
        feeBps,
        deadline,
        collectorAddress: env.feeCollectorAddress || null,
        feeAccount: venue === "kalshi" ? env.dflowFeeAccount || null : null,
      });
    },
  );
};
