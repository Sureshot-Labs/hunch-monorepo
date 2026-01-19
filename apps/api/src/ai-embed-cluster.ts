import { createHash } from "crypto";
import { createRedisClient, ensureRedis } from "@hunch/infra";
import type { RedisClientType } from "redis";
import { RESP_TYPES } from "redis";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  buildMarketSummary,
  computeClusterMetrics,
  scoreMarket,
  type ClusterMarketSummary,
} from "./services/clusters.js";

const INDEX_KEY = "ai:cluster:index";
const META_KEY = "ai:cluster:meta";
const CLUSTER_KEY_PREFIX = "ai:cluster:";
const CLUSTER_VERSION = "v1";

type SeedRow = {
  id: string;
  event_id: string;
  venue: string;
  market_title: string | null;
  event_title: string | null;
  market_type: string | null;
  volume_24h: unknown;
  volume_total: unknown;
  liquidity: unknown;
  open_interest: unknown;
  best_bid: unknown;
  best_ask: unknown;
  last_price: unknown;
  close_time: unknown;
  expiration_time: unknown;
  score: number;
};

type ClusterSeed = {
  seedEventId: string;
  seedMarketId: string;
  seedScore: number;
  seedMarketType: string | null;
  seedMarketTitle: string | null;
  seedEventTitle: string | null;
  eventIds: Set<string>;
};

type ClusterRecord = {
  id: string;
  label: string;
  score: number;
  seedMarketId: string;
  marketIds: string[];
  marketsPreview: ClusterMarketSummary[];
  marketCount: number;
  venueCounts: Record<string, number>;
  venueCount: number;
  priceSpread: number | null;
  minLiquidity: number | null;
  totalLiquidity: number | null;
  volume24h: number | null;
  expiresAt: string | null;
};

type Options = {
  seedLimit: number;
  knnLimit: number;
  neighborLimit: number;
  maxDistance: number;
  minLiquidity: number;
  minVolume24h: number;
  minVenueCount: number;
  minSpread: number;
  ttlSec: number;
  dryRun: boolean;
};

type ClusterMarketRow = {
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
};

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampNumber(
  value: number | undefined,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function resolveOptions(args: string[]): Options {
  return {
    seedLimit: clampNumber(parseNumber(parseFlag(args, "--seed-limit")), {
      min: 50,
      max: 5000,
      fallback: 500,
    }),
    knnLimit: clampNumber(parseNumber(parseFlag(args, "--knn")), {
      min: 20,
      max: 200,
      fallback: 60,
    }),
    neighborLimit: clampNumber(parseNumber(parseFlag(args, "--neighbors")), {
      min: 5,
      max: 50,
      fallback: 12,
    }),
    maxDistance: clampNumber(parseNumber(parseFlag(args, "--max-distance")), {
      min: 0.01,
      max: 1,
      fallback: 0.2,
    }),
    minLiquidity: clampNumber(parseNumber(parseFlag(args, "--min-liquidity")), {
      min: 0,
      max: 1_000_000,
      fallback: 250,
    }),
    minVolume24h: clampNumber(parseNumber(parseFlag(args, "--min-volume-24h")), {
      min: 0,
      max: 1_000_000,
      fallback: 1000,
    }),
    minVenueCount: clampNumber(parseNumber(parseFlag(args, "--min-venues")), {
      min: 1,
      max: 10,
      fallback: 2,
    }),
    minSpread: clampNumber(parseNumber(parseFlag(args, "--min-spread")), {
      min: 0,
      max: 1,
      fallback: 0.05,
    }),
    ttlSec: clampNumber(parseNumber(parseFlag(args, "--ttl-sec")), {
      min: 3600,
      max: 7 * 24 * 3600,
      fallback: 2 * 24 * 3600,
    }),
    dryRun: hasFlag(args, "--dry-run"),
  };
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:embed:clusters -- [options]

Options:
  --seed-limit <n>        Max seeds (default: 500)
  --knn <n>               KNN search size (default: 60)
  --neighbors <n>         Max neighbors per seed (default: 12)
  --max-distance <n>      Max cosine distance (default: 0.2)
  --min-liquidity <n>     Seed min liquidity (default: 250)
  --min-volume-24h <n>    Seed min 24h volume (default: 1000)
  --min-venues <n>        Min venues per cluster (default: 2)
  --min-spread <n>        Min price spread (default: 0.05)
  --ttl-sec <n>           Redis TTL seconds (default: 172800)
  --dry-run               Log counts only
  --help                  Show this help
`);
}

function buildClusterId(marketIds: string[]): string {
  const hash = createHash("sha1")
    .update(marketIds.join("|"))
    .digest("hex");
  return hash.slice(0, 12);
}

function hasAlpha(value: string): boolean {
  return /[a-z]/i.test(value);
}

function isTrivialLabel(label: string, fallback?: string | null): boolean {
  const trimmed = label.trim();
  if (!trimmed) return true;
  if (fallback && trimmed.toLowerCase() === fallback.trim().toLowerCase())
    return true;
  const lower = trimmed.toLowerCase();
  if (lower === "yes" || lower === "no") return true;
  return !hasAlpha(trimmed);
}

function resolveClusterLabel(
  markets: ClusterMarketSummary[],
  fallback?: string | null,
): string {
  for (const market of markets) {
    const eventTitle = market.eventTitle?.trim();
    if (eventTitle && !isTrivialLabel(eventTitle, market.marketTitle)) {
      return eventTitle;
    }
  }
  for (const market of markets) {
    const marketTitle = market.marketTitle?.trim();
    if (marketTitle && !isTrivialLabel(marketTitle, null)) {
      return marketTitle;
    }
  }
  return fallback?.trim() || "Untitled cluster";
}

async function fetchSeedMarkets(options: Options): Promise<SeedRow[]> {
  const scoreExpr =
    "coalesce(m.volume_24h, 0) * 2 + coalesce(m.liquidity, 0) + coalesce(m.open_interest, 0) + coalesce(m.volume_total, 0) * 0.2";
  const hasPriceExpr =
    "case when m.best_bid is not null or m.best_ask is not null or m.last_price is not null then 1 else 0 end";
  const now = new Date();
  const perVenueLimit = Math.ceil(options.seedLimit / 3);

  const { rows } = await pool.query<SeedRow>(
    `
      with candidates as (
        select distinct on (m.event_id)
          m.id,
          m.event_id,
          m.venue,
          m.title as market_title,
          e.title as event_title,
          m.market_type,
          m.volume_24h,
          m.volume_total,
          m.liquidity,
          m.open_interest,
          m.best_bid,
          m.best_ask,
          m.last_price,
          m.close_time,
          m.expiration_time,
          ${scoreExpr} as score,
          ${hasPriceExpr} as has_price,
          row_number() over (
            partition by m.venue
            order by ${hasPriceExpr} desc, ${scoreExpr} desc
          ) as venue_rank
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > $1)
          and (m.close_time is null or m.close_time > $1)
          and (
            coalesce(m.liquidity, 0) >= $2
            or coalesce(m.volume_24h, 0) >= $3
          )
        order by m.event_id, has_price desc, score desc
      )
      select *
      from candidates
      where venue_rank <= $4
      order by score desc
      limit $5
    `,
    [now, options.minLiquidity, options.minVolume24h, perVenueLimit, options.seedLimit],
  );

  return rows;
}

async function fetchTopMarketsForEvents(
  eventIds: string[],
): Promise<Map<string, ClusterMarketRow>> {
  if (!eventIds.length) return new Map();
  const scoreExpr =
    "coalesce(m.volume_24h, 0) * 2 + coalesce(m.liquidity, 0) + coalesce(m.open_interest, 0) + coalesce(m.volume_total, 0) * 0.2";
  const hasPriceExpr =
    "case when m.best_bid is not null or m.best_ask is not null or m.last_price is not null then 1 else 0 end";

  const { rows } = await pool.query<ClusterMarketRow & { rn: number }>(
    `
      select *
      from (
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
          e.title as event_title,
          row_number() over (
            partition by m.event_id
            order by ${hasPriceExpr} desc, ${scoreExpr} desc
          ) as rn
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.event_id = any($1::text[])
          and m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
      ) ranked
      where rn = 1
    `,
    [eventIds],
  );

  const map = new Map<string, ClusterMarketRow>();
  for (const row of rows) {
    map.set(row.event_id, row);
  }
  return map;
}

async function fetchEventNeighbors(
  redis: RedisClientType,
  embedding: Buffer,
  options: Options,
): Promise<Array<{ id: string; score: number }>> {
  const filterClause = "(@status:{ACTIVE})";
  const query = `${filterClause}=>[KNN ${options.knnLimit} @embedding $vec AS score]`;

  const raw = (await redis.sendCommand([
    "FT.SEARCH",
    "idx:ai:embed:event",
    query,
    "PARAMS",
    "2",
    "vec",
    embedding,
    "SORTBY",
    "score",
    "RETURN",
    "1",
    "score",
    "LIMIT",
    "0",
    String(options.knnLimit),
    "DIALECT",
    "2",
  ])) as unknown[];

  const neighbors: Array<{ id: string; score: number }> = [];
  for (let i = 1; i < raw.length; i += 2) {
    const key = raw[i];
    const fields = raw[i + 1] as unknown[];
    const id = String(key).replace("ai:embed:event:", "");
    let score = Number.POSITIVE_INFINITY;
    for (let j = 0; j < fields.length; j += 2) {
      if (String(fields[j]) === "score") {
        score = Number(fields[j + 1]);
        break;
      }
    }
    if (!Number.isFinite(score)) continue;
    neighbors.push({ id, score });
  }

  return neighbors;
}

function unionFind(size: number) {
  const parent = Array.from({ length: size }, (_, idx) => idx);
  const find = (x: number): number => {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  return { parent, find, union };
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let count = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const value of small) {
    if (large.has(value)) count += 1;
  }
  return count;
}

function scoreCluster(metrics: ReturnType<typeof computeClusterMetrics>): number {
  const spreadScore = metrics.priceSpread != null ? metrics.priceSpread * 100 : 0;
  const liquidityScore = metrics.totalLiquidity
    ? Math.log10(metrics.totalLiquidity + 1)
    : 0;
  const volumeScore = metrics.volume24h ? Math.log10(metrics.volume24h + 1) : 0;
  return spreadScore + liquidityScore + volumeScore + metrics.venueCount * 3;
}

async function buildClusters(
  redis: RedisClientType,
  seeds: SeedRow[],
  options: Options,
): Promise<ClusterRecord[]> {
  const clusters: ClusterSeed[] = [];
  const bufferClient = redis.withTypeMapping({
    [RESP_TYPES.BLOB_STRING]: Buffer,
  });

  for (const seed of seeds) {
    const embeddingRaw = (await bufferClient.hmGet(
      `ai:embed:event:${seed.event_id}`,
      ["embedding"],
    ))[0];
    const embedding = Buffer.isBuffer(embeddingRaw) ? embeddingRaw : null;
    if (!embedding) continue;

    const neighbors = await fetchEventNeighbors(redis, embedding, options);
    const eventIds = new Set<string>([seed.event_id]);
    for (const neighbor of neighbors) {
      if (neighbor.id === seed.event_id) continue;
      if (neighbor.score > options.maxDistance) continue;
      eventIds.add(neighbor.id);
      if (eventIds.size >= options.neighborLimit + 1) break;
    }

    if (eventIds.size < 2) continue;
    clusters.push({
      seedEventId: seed.event_id,
      seedMarketId: seed.id,
      seedScore: seed.score,
      seedMarketType: seed.market_type,
      seedMarketTitle: seed.market_title,
      seedEventTitle: seed.event_title,
      eventIds,
    });
  }

  if (!clusters.length) return [];

  const { find, union } = unionFind(clusters.length);
  const mergeJaccard = 0.35;
  const mergeOverlap = 3;
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      const inter = intersectionSize(clusters[i].eventIds, clusters[j].eventIds);
      if (inter === 0) continue;
      const unionSize =
        clusters[i].eventIds.size + clusters[j].eventIds.size - inter;
      const jaccard = unionSize > 0 ? inter / unionSize : 0;
      if (inter >= mergeOverlap || jaccard >= mergeJaccard) {
        union(i, j);
      }
    }
  }

  const merged = new Map<number, ClusterSeed>();
  for (let i = 0; i < clusters.length; i += 1) {
    const root = find(i);
    const current = merged.get(root);
    if (!current) {
      merged.set(root, {
        ...clusters[i],
        eventIds: new Set(clusters[i].eventIds),
      });
      continue;
    }
    for (const id of clusters[i].eventIds) current.eventIds.add(id);
    if (clusters[i].seedScore > current.seedScore) {
      current.seedEventId = clusters[i].seedEventId;
      current.seedMarketId = clusters[i].seedMarketId;
      current.seedScore = clusters[i].seedScore;
      current.seedMarketType = clusters[i].seedMarketType;
      current.seedMarketTitle = clusters[i].seedMarketTitle;
      current.seedEventTitle = clusters[i].seedEventTitle;
    }
  }

  const allEventIds = new Set<string>();
  for (const cluster of merged.values()) {
    for (const id of cluster.eventIds) allEventIds.add(id);
  }

  const marketMeta = await fetchTopMarketsForEvents(Array.from(allEventIds));
  const marketScoreById = new Map<string, number>();
  for (const meta of marketMeta.values()) {
    marketScoreById.set(meta.id, scoreMarket(meta));
  }

  const results: ClusterRecord[] = [];
  const maxPerVenue = 2;
  for (const cluster of merged.values()) {
    const summaries = Array.from(cluster.eventIds)
      .map((eventId) => marketMeta.get(eventId))
      .filter((row): row is ClusterMarketRow => Boolean(row))
      .filter((row) =>
        cluster.seedMarketType ? row.market_type === cluster.seedMarketType : true,
      )
      .map((row) => buildMarketSummary(row));

    if (summaries.length < 2) continue;

    const sorted = summaries
      .slice()
      .sort((a, b) => {
        const scoreA = marketScoreById.get(a.marketId) ?? 0;
        const scoreB = marketScoreById.get(b.marketId) ?? 0;
        return scoreB - scoreA;
      });

    const perVenueCounts = new Map<string, number>();
    const capped: ClusterMarketSummary[] = [];

    const seedSummary = sorted.find(
      (summary) => summary.marketId === cluster.seedMarketId,
    );
    if (seedSummary) {
      capped.push(seedSummary);
      perVenueCounts.set(seedSummary.venue, 1);
    }

    for (const summary of sorted) {
      if (seedSummary && summary.marketId === seedSummary.marketId) continue;
      const count = perVenueCounts.get(summary.venue) ?? 0;
      if (count >= maxPerVenue) continue;
      perVenueCounts.set(summary.venue, count + 1);
      capped.push(summary);
    }

    if (capped.length < 2) continue;

    const metrics = computeClusterMetrics(capped);
    if (metrics.venueCount < options.minVenueCount) continue;
    if (metrics.priceSpread != null && metrics.priceSpread < options.minSpread)
      continue;

    const score = scoreCluster(metrics);
    const marketIds = capped.map((summary) => summary.marketId).sort();
    const marketsPreview = capped
      .slice()
      .sort((a, b) => {
        const scoreA = marketScoreById.get(a.marketId) ?? 0;
        const scoreB = marketScoreById.get(b.marketId) ?? 0;
        return scoreB - scoreA;
      })
      .slice(0, 6);

    results.push({
      id: buildClusterId(Array.from(cluster.eventIds).sort()),
      label: resolveClusterLabel(
        marketsPreview,
        cluster.seedEventTitle ?? cluster.seedMarketTitle,
      ),
      score,
      seedMarketId: cluster.seedMarketId,
      marketIds,
      marketsPreview,
      marketCount: marketIds.length,
      venueCounts: metrics.venueCounts,
      venueCount: metrics.venueCount,
      priceSpread: metrics.priceSpread,
      minLiquidity: metrics.minLiquidity,
      totalLiquidity: metrics.totalLiquidity,
      volume24h: metrics.volume24h,
      expiresAt: metrics.expiresAt,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

async function storeClusters(
  redis: RedisClientType,
  clusters: ClusterRecord[],
  options: Options,
): Promise<void> {
  const now = new Date().toISOString();

  const existingIndex = await redis.get(INDEX_KEY);
  const multi = redis.multi();

  if (existingIndex) {
    try {
      const ids = JSON.parse(existingIndex) as string[];
      for (const id of ids) multi.del(`${CLUSTER_KEY_PREFIX}${id}`);
    } catch {
      // ignore
    }
  }

  multi.del(INDEX_KEY);
  multi.del(META_KEY);

  const indexIds = clusters.map((cluster) => cluster.id);
  for (const cluster of clusters) {
    const key = `${CLUSTER_KEY_PREFIX}${cluster.id}`;
    multi.hSet(key, {
      label: cluster.label,
      score: String(cluster.score),
      seed_market_id: cluster.seedMarketId,
      market_count: String(cluster.marketCount),
      venue_count: String(cluster.venueCount),
      venue_counts: JSON.stringify(cluster.venueCounts),
      price_spread: cluster.priceSpread != null ? String(cluster.priceSpread) : "",
      min_liquidity:
        cluster.minLiquidity != null ? String(cluster.minLiquidity) : "",
      total_liquidity:
        cluster.totalLiquidity != null ? String(cluster.totalLiquidity) : "",
      volume_24h: cluster.volume24h != null ? String(cluster.volume24h) : "",
      expires_at: cluster.expiresAt ?? "",
      market_ids: JSON.stringify(cluster.marketIds),
      markets_preview: JSON.stringify(cluster.marketsPreview),
      updated_at: now,
      version: CLUSTER_VERSION,
    });
    multi.expire(key, options.ttlSec);
  }

  multi.set(INDEX_KEY, JSON.stringify(indexIds), { EX: options.ttlSec });
  multi.hSet(META_KEY, {
    generated_at: now,
    count: String(clusters.length),
    version: CLUSTER_VERSION,
  });
  multi.expire(META_KEY, options.ttlSec);

  await multi.exec();
}

async function main() {
  const args = process.argv.slice(2);
  if (hasFlag(args, "--help")) {
    printHelp();
    return;
  }

  const options = resolveOptions(args);
  if (!env.redisUrl) {
    console.error("[cluster] Missing REDIS_URL in env.");
    process.exit(1);
  }

  const redis = createRedisClient({ url: env.redisUrl });
  redis.on("error", (e: unknown) => console.warn("[redis] err", String(e)));
  await ensureRedis(redis);

  try {
    const seeds = await fetchSeedMarkets(options);
    console.log("[cluster] seeds", { count: seeds.length });

    const clusters = await buildClusters(redis, seeds, options);
    console.log("[cluster] clusters", { count: clusters.length });

    if (!options.dryRun) {
      await storeClusters(redis, clusters, options);
      console.log("[cluster] stored", { count: clusters.length });
    }
  } finally {
    await redis.quit();
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[cluster] failed", error);
    process.exit(1);
  });
