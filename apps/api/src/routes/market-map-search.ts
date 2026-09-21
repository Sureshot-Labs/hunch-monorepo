import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
import { getRedisStatus } from "../redis.js";
import { marketMapSearchQuerySchema } from "../schemas/market-map.js";
import { resolveMarketMapPolicy } from "../services/runtime-policies.js";
import { filterVenuesForLifecycleCapability } from "../services/venue-lifecycle.js";
import {
  marketMapActiveKey,
  marketMapRunNodesGlobalKey,
  marketMapRunNodeEventsKey,
  parseMarketMapVenuesQuery,
  safeJsonParse,
  type MarketMapNode,
  type MarketMapEventSummary,
} from "../services/market-map.js";
import {
  buildMapSearchDocuments,
  searchMapDocuments,
  type MapSearchDocument,
} from "../services/market-map-text-search.js";

export const marketMapSearchRoutes: FastifyPluginAsync = async (app) => {
  // One bounded snapshot cache, shared across queries and concurrent requests.
  // Never cache arbitrary user query strings or create one Redis key per query.
  let cache:
    | {
        runId: string;
        expiresAt: number;
        documents: Promise<MapSearchDocument[]>;
      }
    | undefined;
  app.withTypeProvider<ZodTypeProvider>().get(
    "/market-map/search",
    {
      schema: { querystring: marketMapSearchQuerySchema },
    },
    async (request, reply) => {
      const { redis } = await getRedisStatus();
      if (!redis) return reply.code(503).send({ error: "Redis unavailable" });
      const policy = await resolveMarketMapPolicy(pool);
      const { q, limit, offset } = request.query;
      const empty = {
        runId: null,
        mode: "text" as const,
        q,
        limit,
        offset,
        total: 0,
        nodes: [],
        items: [],
      };
      if (!policy.effective.enabled) return { enabled: false, ...empty };
      const requested = parseMarketMapVenuesQuery(request.query.venues);
      const policyVenues = policy.effective.venuesEnabled.filter(
        (venue) => !requested.length || requested.includes(venue),
      );
      const { venues } = await filterVenuesForLifecycleCapability(
        pool,
        policyVenues,
        "discovery",
      );
      if (!venues.length)
        return reply
          .code(400)
          .send({ error: "No enabled venues selected for market map" });
      const runId = await redis.get(marketMapActiveKey());
      if (!runId) return { enabled: true, ...empty };
      if (!cache || cache.runId !== runId || cache.expiresAt <= Date.now()) {
        const documents = (async () => {
          const rawNodes = await redis.get(marketMapRunNodesGlobalKey(runId));
          if (!rawNodes) throw new Error("Map snapshot unavailable; retry");
          const nodes = safeJsonParse<MarketMapNode[]>(rawNodes);
          if (!nodes) throw new Error("Map snapshot invalid; retry");
          const leaves = nodes.filter((node) => node.childIds.length === 0);
          const events = new Map<string, MarketMapEventSummary[]>();
          for (let start = 0; start < leaves.length; start += 100) {
            const batch = leaves.slice(start, start + 100);
            const pipeline = redis.multi();
            for (const leaf of batch)
              pipeline.get(marketMapRunNodeEventsKey(runId, leaf.id));
            const values = (await pipeline.exec()) as unknown as Array<
              string | null
            >;
            for (const [index, leaf] of batch.entries()) {
              const parsed = safeJsonParse<MarketMapEventSummary[]>(
                values[index],
              );
              if (!parsed) throw new Error("Map snapshot expired; retry");
              events.set(leaf.id, parsed);
            }
          }
          return buildMapSearchDocuments(nodes, events);
        })();
        cache = { runId, expiresAt: Date.now() + 60000, documents };
      }
      const selectedCache = cache;
      try {
        const documents = await selectedCache.documents;
        return {
          enabled: true,
          runId,
          mode: "text" as const,
          q,
          limit,
          offset,
          ...searchMapDocuments(documents, q, venues, limit, offset),
        };
      } catch (error) {
        if (cache === selectedCache) cache = undefined;
        request.log.warn({ err: error }, "market map text search unavailable");
        return reply
          .code(503)
          .send({ error: "Map snapshot unavailable; retry" });
      }
    },
  );
};
