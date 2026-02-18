import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { env } from "../env.js";
import { getRedis } from "../redis.js";
import { holdersQuerySchema } from "../schemas/holders.js";
import { fetchMarketHolderData } from "../services/holders-core.js";

type HolderRow = {
  rank: number;
  wallet: string;
  market: string;
  outcome: string;
  shares: number;
  price: number | null;
  value: number | null;
};

export const holdersRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/holders",
    {
      schema: { querystring: holdersQuerySchema },
    },
    async (request, reply) => {
      const { marketId, limit } = request.query;

      if (!marketId) {
        reply.code(400);
        return { error: "marketId is required" };
      }

      const isPolymarket = marketId.startsWith("polymarket:");
      const cacheKey = `holders:v1:${marketId}:${limit}`;
      const cacheTtl = isPolymarket
        ? env.holdersTtlSecPolymarket > 0
          ? env.holdersTtlSecPolymarket
          : 60
        : env.holdersTtlSec > 0
          ? env.holdersTtlSec
          : 300;
      const r = await getRedis();

      if (r) {
        const cached = await r.get(cacheKey);
        if (cached) {
          reply.header("x-cache", "hit");
          reply.header("Content-Type", "application/json; charset=utf-8");
          reply.header(
            "Cache-Control",
            `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
          );
          return reply.send(cached);
        }
      }

      let data: Awaited<ReturnType<typeof fetchMarketHolderData>>;
      try {
        data = await fetchMarketHolderData({ marketId, limit });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.toLowerCase().includes("market not found")) {
          reply.code(404);
          return { error: "Market not found" };
        }
        throw error;
      }

      const holders = data.holders.map((entry, index): HolderRow => {
        const price = data.priceBySide[entry.side];
        const value =
          price != null ? Number((price * entry.shares).toFixed(6)) : null;
        return {
          rank: index + 1,
          wallet: entry.wallet,
          market: data.market.title,
          outcome: data.outcomeLabels[entry.side],
          shares: entry.shares,
          price,
          value,
        };
      });

      const response = {
        marketId,
        venue: data.market.venue,
        asOf: data.asOf,
        holders,
        source: data.source,
      };

      const responseBody = JSON.stringify(response);
      if (r) {
        await r.set(cacheKey, responseBody, { EX: cacheTtl });
        reply.header("x-cache", "miss");
      }
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Cache-Control",
        `private, max-age=${cacheTtl}, stale-while-revalidate=${cacheTtl * 2}`,
      );
      return reply.send(responseBody);
    },
  );
};
