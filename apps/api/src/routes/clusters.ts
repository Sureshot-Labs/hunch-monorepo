import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pool } from "../db.js";
import { getRedisStatus } from "../redis.js";
import {
  buildMarketSummary,
  type ClusterMarketSummary,
} from "../services/clusters.js";
import {
  clusterParamsSchema,
  clustersQuerySchema,
} from "../schemas/clusters.js";

const INDEX_KEY = "ai:cluster:index";
const META_KEY = "ai:cluster:meta";
const CLUSTER_KEY_PREFIX = "ai:cluster:";

type ClusterHash = {
  label: string;
  score: string;
  seed_market_id: string;
  market_count: string;
  venue_count: string;
  venue_counts: string;
  price_spread: string;
  min_liquidity: string;
  total_liquidity: string;
  volume_24h: string;
  expires_at: string;
  analysis: string;
  analysis_status: string;
  analysis_updated_at: string;
  quality_score: string;
  market_ids: string;
  markets_preview: string;
  updated_at: string;
  version: string;
};

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function formatClusterSummary(id: string, hash: ClusterHash) {
  const venueCounts = parseJson<Record<string, number>>(hash.venue_counts, {});
  const marketsPreview = parseJson<ClusterMarketSummary[]>(
    hash.markets_preview,
    [],
  );

  return {
    id,
    label: hash.label || "Untitled cluster",
    score: parseNumber(hash.score) ?? 0,
    seedMarketId: hash.seed_market_id || null,
    marketCount: parseNumber(hash.market_count) ?? marketsPreview.length,
    venueCount: parseNumber(hash.venue_count) ?? Object.keys(venueCounts).length,
    venueCounts,
    priceSpread: parseNumber(hash.price_spread),
    minLiquidity: parseNumber(hash.min_liquidity),
    totalLiquidity: parseNumber(hash.total_liquidity),
    volume24h: parseNumber(hash.volume_24h),
    expiresAt: hash.expires_at || null,
    analysis: hash.analysis || null,
    analysisStatus: hash.analysis_status || null,
    analysisUpdatedAt: hash.analysis_updated_at || null,
    qualityScore: parseNumber(hash.quality_score),
    markets: marketsPreview,
    updatedAt: hash.updated_at || null,
    version: hash.version || null,
  };
}

export const clustersRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  z.get(
    "/clusters",
    { schema: { querystring: clustersQuerySchema } },
    async (request, reply) => {
      const query = request.query;
      const { redis, status } = await getRedisStatus();
      if (!redis) {
        const error =
          status === "loading" ? "Redis loading, retry" : "Redis unavailable";
        return reply.code(503).send({ error });
      }

      const [indexRaw, meta] = await Promise.all([
        redis.get(INDEX_KEY),
        redis.hGetAll(META_KEY),
      ]);

      const generatedAt = meta.generated_at ?? null;
      if (!indexRaw) {
        return { items: [], generatedAt };
      }

      const ids = parseJson<string[]>(indexRaw, []);
      if (!ids.length) {
        return { items: [], generatedAt };
      }

      const fields: Array<keyof ClusterHash> = [
        "label",
        "score",
        "seed_market_id",
        "market_count",
        "venue_count",
        "venue_counts",
        "price_spread",
        "min_liquidity",
        "total_liquidity",
        "volume_24h",
        "expires_at",
        "analysis",
        "analysis_status",
        "analysis_updated_at",
        "quality_score",
        "market_ids",
        "markets_preview",
        "updated_at",
        "version",
      ];

      const pipeline = redis.multi();
      for (const id of ids) {
        pipeline.hmGet(`${CLUSTER_KEY_PREFIX}${id}`, fields);
      }
      const raw = (await pipeline.exec()) as unknown as Array<
        Array<string | null>
      >;

      const summaries = raw
        .map((values, idx) => {
          const hash = Object.fromEntries(
            fields.map((field, fieldIdx) => [
              field,
              values?.[fieldIdx] ?? "",
            ]),
          ) as ClusterHash;
          return formatClusterSummary(ids[idx], hash);
        })
        .filter((cluster) => cluster.marketCount > 0);

      let filtered = summaries;
      const minLiquidity = query.minLiquidity;
      if (minLiquidity != null) {
        filtered = filtered.filter(
          (cluster) =>
            cluster.minLiquidity != null &&
            cluster.minLiquidity >= minLiquidity,
        );
      }
      const minVenueCount = query.minVenueCount;
      if (minVenueCount != null) {
        filtered = filtered.filter(
          (cluster) => cluster.venueCount >= minVenueCount,
        );
      }
      const minSpread = query.minSpread;
      if (minSpread != null) {
        filtered = filtered.filter(
          (cluster) =>
            cluster.priceSpread != null &&
            cluster.priceSpread >= minSpread,
        );
      }

      const limit = query.limit ?? 20;
      return {
        generatedAt,
        items: filtered.slice(0, limit),
      };
    },
  );

  z.get(
    "/clusters/:id",
    { schema: { params: clusterParamsSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const { redis, status } = await getRedisStatus();
      if (!redis) {
        const error =
          status === "loading" ? "Redis loading, retry" : "Redis unavailable";
        return reply.code(503).send({ error });
      }

      const hash = (await redis.hGetAll(
        `${CLUSTER_KEY_PREFIX}${id}`,
      )) as ClusterHash;

      if (!hash || Object.keys(hash).length === 0) {
        return reply.code(404).send({ error: "Cluster not found" });
      }

      const cluster = formatClusterSummary(id, hash);
      const marketIds = parseJson<string[]>(hash.market_ids, []);
      if (!marketIds.length) {
        return { cluster, markets: [] };
      }

      const { rows } = await pool.query<{
        id: string;
        event_id: string;
        venue: string;
        title: string | null;
        market_type: string | null;
        best_bid: unknown;
        best_ask: unknown;
        last_price: unknown;
        volume_24h: unknown;
        volume_total: unknown;
        liquidity: unknown;
        open_interest: unknown;
        close_time: unknown;
        expiration_time: unknown;
        event_title: string | null;
      }>(
        `
          select
            m.id,
            m.event_id,
            m.venue,
            m.title,
            m.market_type,
            m.best_bid,
            m.best_ask,
            m.last_price,
            m.volume_24h,
            m.volume_total,
            m.liquidity,
            m.open_interest,
            m.close_time,
            m.expiration_time,
            e.title as event_title
          from unified_markets m
          join unified_events e on e.id = m.event_id
          where m.id = any($1::text[])
            and m.status = 'ACTIVE'
            and e.status = 'ACTIVE'
        `,
        [marketIds],
      );

      const byId = new Map<string, ClusterMarketSummary>();
      for (const row of rows) {
        byId.set(row.id, buildMarketSummary(row));
      }

      const ordered = marketIds
        .map((marketId) => byId.get(marketId))
        .filter((row): row is ClusterMarketSummary => Boolean(row));

      return { cluster, markets: ordered };
    },
  );
};
