import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { createAuthMiddleware } from "../auth.js";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import { fetchSolanaMintDecimals } from "../services/solana-rpc.js";
import { solanaMintsQuerySchema } from "../schemas/solana.js";

const DECIMALS_CACHE_TTL_SEC = 60 * 60 * 24;

export const solanaRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  /**
   * GET /solana/mints
   * Returns mint decimals for a list of SPL token mints.
   */
  z.get(
    "/solana/mints",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: solanaMintsQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const walletAddress = request.walletAddress;
      if (!user || !walletAddress) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const ids = request.query.ids;
      const r = await getRedis();

      const results: Array<{ mint: string; decimals: number | null }> = [];
      for (const mint of ids) {
        const cacheKey = `solana:mint-decimals:${mint}`;
        if (r) {
          const cached = await r.get(cacheKey);
          if (cached) {
            const cachedNum = Number(cached);
            results.push({
              mint,
              decimals: Number.isFinite(cachedNum) ? cachedNum : null,
            });
            continue;
          }
        }

        let decimals: number | null = null;
        try {
          decimals = await fetchSolanaMintDecimals({
            rpcUrl: env.solanaRpcUrl,
            timeoutMs: env.solanaRpcTimeoutMs,
            mint,
          });
        } catch (error) {
          app.log.warn({ error, mint }, "Failed to fetch mint decimals");
        }

        if (r && decimals != null) {
          await r.set(cacheKey, String(decimals), {
            EX: DECIMALS_CACHE_TTL_SEC,
          });
        }

        results.push({ mint, decimals });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ mints: results });
    },
  );
};
