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
  market_category: string | null;
  event_category: string | null;
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
  end_date: unknown;
  score: number;
};

type ClusterSeed = {
  seedEventId: string;
  seedMarketId: string;
  seedScore: number;
  seedMarketType: string | null;
  seedMarketTitle: string | null;
  seedEventTitle: string | null;
  seedSignature: Signature;
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
  analysis: string | null;
  analysisStatus: string | null;
  analysisUpdatedAt: string | null;
  qualityScore: number | null;
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

type NeighborMarketRow = {
  id: string;
  event_id: string;
  venue: string;
  market_title: string | null;
  event_title: string | null;
  market_category: string | null;
  event_category: string | null;
  market_type: string | null;
  close_time: unknown;
  expiration_time: unknown;
  end_date: unknown;
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
      fallback: 1200,
    }),
    knnLimit: clampNumber(parseNumber(parseFlag(args, "--knn")), {
      min: 20,
      max: 200,
      fallback: 80,
    }),
    neighborLimit: clampNumber(parseNumber(parseFlag(args, "--neighbors")), {
      min: 5,
      max: 50,
      fallback: 12,
    }),
    maxDistance: clampNumber(parseNumber(parseFlag(args, "--max-distance")), {
      min: 0.01,
      max: 1,
      fallback: 0.15,
    }),
    minLiquidity: clampNumber(parseNumber(parseFlag(args, "--min-liquidity")), {
      min: 0,
      max: 1_000_000,
      fallback: 50,
    }),
    minVolume24h: clampNumber(parseNumber(parseFlag(args, "--min-volume-24h")), {
      min: 0,
      max: 1_000_000,
      fallback: 200,
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
  --seed-limit <n>        Max seeds (default: 1200)
  --knn <n>               KNN search size (default: 80)
  --neighbors <n>         Max neighbors per seed (default: 12)
  --max-distance <n>      Max cosine distance (default: 0.15)
  --min-liquidity <n>     Seed min liquidity (default: 50)
  --min-volume-24h <n>    Seed min 24h volume (default: 200)
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

type CoarseCategory =
  | "sports"
  | "politics"
  | "crypto"
  | "macro"
  | "entertainment";

type QuestionType =
  | "mention"
  | "price"
  | "winner"
  | "match"
  | "performance"
  | "count"
  | "occurrence"
  | "other";

type Signature = {
  type: QuestionType;
  category: CoarseCategory | null;
  tokens: Set<string>;
  entityTokens: Set<string>;
  years: Set<number>;
  months: Set<string>;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "of",
  "in",
  "to",
  "for",
  "on",
  "at",
  "by",
  "before",
  "after",
  "between",
  "within",
  "from",
  "with",
  "without",
  "vs",
  "v",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "do",
  "does",
  "did",
  "doing",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "if",
  "then",
  "than",
  "over",
  "under",
  "above",
  "below",
  "around",
  "about",
  "into",
  "out",
  "as",
  "per",
  "not",
  "no",
  "yes",
  "up",
  "down",
  "this",
  "that",
  "these",
  "those",
  "today",
  "tomorrow",
  "yesterday",
  "year",
  "month",
  "week",
  "day",
  "q1",
  "q2",
  "q3",
  "q4",
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "may",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "sept",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december",
]);

const SHORT_TOKENS = new Set(["ai", "btc", "eth", "sol", "epl", "nfl", "nba", "mlb", "nhl", "fed", "cpi", "gdp"]);

const CATEGORY_KEYWORDS: Record<CoarseCategory, Set<string>> = {
  sports: new Set([
    "nfl",
    "nba",
    "mlb",
    "nhl",
    "epl",
    "uefa",
    "champions",
    "league",
    "laliga",
    "serie",
    "cup",
    "championship",
    "mvp",
    "goalscorer",
    "goal",
    "score",
    "match",
    "season",
    "football",
    "soccer",
    "baseball",
    "basketball",
    "hockey",
    "tennis",
    "golf",
  ]),
  politics: new Set([
    "president",
    "election",
    "senate",
    "house",
    "nominee",
    "trump",
    "biden",
    "vote",
    "voting",
    "party",
    "democratic",
    "republican",
    "congress",
    "governor",
    "parliament",
    "prime",
    "minister",
  ]),
  crypto: new Set([
    "bitcoin",
    "btc",
    "eth",
    "ethereum",
    "sol",
    "solana",
    "crypto",
    "token",
    "airdrop",
    "fdv",
    "marketcap",
    "chain",
    "defi",
    "stablecoin",
    "stablecoins",
    "usdc",
    "usdt",
  ]),
  macro: new Set([
    "fed",
    "cpi",
    "inflation",
    "gdp",
    "interest",
    "rates",
    "rate",
    "recession",
    "economy",
    "unemployment",
    "treasury",
    "yield",
  ]),
  entertainment: new Set([
    "movie",
    "film",
    "album",
    "music",
    "song",
    "boxoffice",
    "oscar",
    "grammy",
    "gta",
    "game",
    "tv",
    "series",
    "season",
    "actor",
    "actress",
    "rottentomatoes",
    "rt",
  ]),
};

function extractTopicTokens(text: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  const matches = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of matches) {
    if (STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (token.length < 2) continue;
    if (token.length === 2 && !SHORT_TOKENS.has(token)) continue;
    if (token.length >= 3 && /\d/.test(token) && !SHORT_TOKENS.has(token)) {
      continue;
    }
    tokens.add(token);
  }
  return tokens;
}

const MONTH_TOKENS = new Set([
  "jan",
  "january",
  "feb",
  "february",
  "mar",
  "march",
  "apr",
  "april",
  "may",
  "jun",
  "june",
  "jul",
  "july",
  "aug",
  "august",
  "sep",
  "sept",
  "september",
  "oct",
  "october",
  "nov",
  "november",
  "dec",
  "december",
]);

function extractEntityTokens(text: string | null | undefined): Set<string> {
  const entities = new Set<string>();
  if (!text) return entities;
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9'’.-]*/g) ?? [];
  for (const raw of matches) {
    const cleaned = raw.replace(/['’.-]+$/g, "");
    if (cleaned.length < 3) continue;
    if (/^\d+$/.test(cleaned)) continue;
    const isAllCaps =
      cleaned.toUpperCase() === cleaned && /[A-Z]/.test(cleaned);
    const isTitle = cleaned[0] === cleaned[0]?.toUpperCase();
    if (isAllCaps || isTitle) {
      entities.add(cleaned.toLowerCase());
    }
  }
  return entities;
}

function extractYears(text: string | null | undefined): Set<number> {
  const years = new Set<number>();
  if (!text) return years;
  const matches = text.match(/\b(20\d{2})\b/g) ?? [];
  for (const match of matches) {
    const year = Number(match);
    if (Number.isFinite(year)) years.add(year);
  }
  return years;
}

function extractMonths(text: string | null | undefined): Set<string> {
  const months = new Set<string>();
  if (!text) return months;
  const matches = text.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const token of matches) {
    if (MONTH_TOKENS.has(token)) months.add(token);
  }
  return months;
}

function classifyQuestionType(text: string | null | undefined): QuestionType {
  if (!text) return "other";
  const lower = text.toLowerCase();
  if (
    lower.includes("say ") ||
    lower.includes("mention") ||
    lower.includes("tweet") ||
    lower.includes("announce") ||
    lower.includes("earnings call") ||
    lower.includes("call")
  ) {
    return "mention";
  }
  if (
    lower.includes("$") ||
    lower.includes("price") ||
    lower.includes("hit") ||
    lower.includes("above") ||
    lower.includes("below") ||
    lower.includes("over") ||
    lower.includes("under") ||
    lower.includes("at least") ||
    lower.includes("at most") ||
    lower.includes("fdv") ||
    lower.includes("market cap") ||
    lower.includes("valuation")
  ) {
    return "price";
  }
  if (
    lower.includes("winner") ||
    lower.includes("wins") ||
    lower.includes("champion") ||
    lower.includes("nominee") ||
    lower.includes("nomination") ||
    lower.includes("elected") ||
    lower.includes("election")
  ) {
    return "winner";
  }
  if (
    lower.includes("vs ") ||
    lower.includes(" vs") ||
    lower.includes("versus") ||
    lower.includes("match") ||
    lower.includes("game") ||
    lower.includes("fixture")
  ) {
    return "match";
  }
  if (
    lower.includes("score") ||
    lower.includes("goals") ||
    lower.includes("points") ||
    lower.includes("shots") ||
    lower.includes("assists") ||
    lower.includes("rebounds") ||
    lower.includes("yards") ||
    lower.includes("touchdowns")
  ) {
    return "performance";
  }
  if (
    lower.includes("how many") ||
    lower.includes("number of") ||
    lower.includes("count") ||
    lower.includes("total") ||
    lower.includes("#")
  ) {
    return "count";
  }
  if (
    lower.includes("will ") ||
    lower.includes("does ") ||
    lower.includes("do ") ||
    lower.includes("is ") ||
    lower.includes("are ")
  ) {
    return "occurrence";
  }
  return "other";
}

function buildSignature(params: {
  eventTitle: string | null | undefined;
  marketTitle: string | null | undefined;
  eventCategory: string | null | undefined;
  marketCategory: string | null | undefined;
  dates?: Array<unknown>;
}): Signature {
  const text = `${params.eventTitle ?? ""} ${params.marketTitle ?? ""}`.trim();
  const tokens = extractTopicTokens(text);
  const entityTokens = extractEntityTokens(text);
  if (entityTokens.size === 0) {
    const fallback = Array.from(tokens).filter((token) => token.length >= 5);
    for (const token of fallback.slice(0, 6)) entityTokens.add(token);
  }
  const years = extractYears(text);
  const months = extractMonths(text);
  if (params.dates?.length) {
    for (const value of params.dates) {
      if (!value) continue;
      const date = value instanceof Date ? value : new Date(String(value));
      if (!Number.isNaN(date.getTime())) years.add(date.getUTCFullYear());
    }
  }
  const category = resolveCategory(
    params.eventCategory,
    params.marketCategory,
    tokens,
  );
  const type = classifyQuestionType(text);

  return {
    type,
    category,
    tokens,
    entityTokens,
    years,
    months,
  };
}

function timeCompatible(a: Signature, b: Signature): boolean {
  if (a.years.size === 0 || b.years.size === 0) return true;
  for (const year of a.years) {
    if (b.years.has(year)) return true;
  }
  let minDiff = Number.POSITIVE_INFINITY;
  for (const year of a.years) {
    for (const other of b.years) {
      minDiff = Math.min(minDiff, Math.abs(year - other));
    }
  }
  return minDiff <= 1;
}

function scoreSignatureMatch(a: Signature, b: Signature, embedScore: number): number {
  const embedSim = Math.max(0, Math.min(1, 1 - embedScore));
  const { intersection, jaccard } = computeTopicOverlap(a.tokens, b.tokens);
  const entityOverlap = intersectionSize(a.entityTokens, b.entityTokens);
  const typeScore = a.type === b.type ? 1 : 0;
  const categoryScore =
    a.category && b.category ? (a.category === b.category ? 1 : 0) : 0.5;
  const timeScore = timeCompatible(a, b) ? 1 : 0;
  const entityScore = entityOverlap > 0 ? 1 : 0;
  const lexicalScore =
    intersection >= 2 ? 1 : jaccard >= 0.15 ? 0.6 : jaccard;

  return (
    embedSim * 0.45 +
    lexicalScore * 0.25 +
    entityScore * 0.15 +
    typeScore * 0.1 +
    categoryScore * 0.05 +
    timeScore * 0.05
  );
}

function scoreSignatureSimilarity(a: Signature, b: Signature): number {
  const { intersection, jaccard } = computeTopicOverlap(a.tokens, b.tokens);
  const entityOverlap = intersectionSize(a.entityTokens, b.entityTokens);
  const typeScore = a.type === b.type ? 1 : 0;
  const categoryScore =
    a.category && b.category ? (a.category === b.category ? 1 : 0) : 0.5;
  const timeScore = timeCompatible(a, b) ? 1 : 0;
  const entityScore = entityOverlap > 0 ? 1 : 0;
  const lexicalScore =
    intersection >= 2 ? 1 : jaccard >= 0.15 ? 0.6 : jaccard;

  return (
    lexicalScore * 0.4 +
    entityScore * 0.2 +
    typeScore * 0.2 +
    categoryScore * 0.1 +
    timeScore * 0.1
  );
}

function isSignatureCompatible(a: Signature, b: Signature): boolean {
  if (a.type !== b.type) return false;
  if (a.category && b.category && a.category !== b.category) return false;
  if (!timeCompatible(a, b)) return false;
  const { intersection, jaccard } = computeTopicOverlap(a.tokens, b.tokens);
  const entityOverlap = intersectionSize(a.entityTokens, b.entityTokens);
  if (entityOverlap < 1 && intersection < 2 && jaccard < 0.12) return false;
  return true;
}

function computeTopicOverlap(a: Set<string>, b: Set<string>) {
  if (a.size === 0 || b.size === 0) return { intersection: 0, jaccard: 0 };
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  const jaccard = union > 0 ? intersection / union : 0;
  return { intersection, jaccard };
}

function normalizeCategory(raw?: string | null): CoarseCategory | null {
  if (!raw) return null;
  const value = raw.toLowerCase();
  if (value.includes("sport")) return "sports";
  if (value.includes("polit")) return "politics";
  if (value.includes("crypto") || value.includes("token")) return "crypto";
  if (value.includes("econom") || value.includes("macro") || value.includes("finance"))
    return "macro";
  if (value.includes("entertain") || value.includes("culture")) return "entertainment";
  return null;
}

function deriveCategory(tokens: Set<string>): CoarseCategory | null {
  let best: { category: CoarseCategory; count: number } | null = null;
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as Array<
    [CoarseCategory, Set<string>]
  >) {
    let count = 0;
    for (const token of tokens) {
      if (keywords.has(token)) count += 1;
    }
    if (count === 0) continue;
    if (!best || count > best.count) {
      best = { category, count };
    }
  }
  return best ? best.category : null;
}

function resolveCategory(
  eventCategory: string | null | undefined,
  marketCategory: string | null | undefined,
  tokens: Set<string>,
): CoarseCategory | null {
  return (
    normalizeCategory(eventCategory) ??
    normalizeCategory(marketCategory) ??
    deriveCategory(tokens)
  );
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
          m.category as market_category,
          e.category as event_category,
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
          e.end_date,
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
          and (e.end_date is null or e.end_date > $1)
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
  const now = new Date();

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
          and (e.end_date is null or e.end_date > $2)
          and (m.expiration_time is null or m.expiration_time > $2)
          and (m.close_time is null or m.close_time > $2)
      ) ranked
      where rn = 1
    `,
    [eventIds, now],
  );

  const map = new Map<string, ClusterMarketRow>();
  for (const row of rows) {
    map.set(row.event_id, row);
  }
  return map;
}

async function fetchMarketNeighbors(
  redis: RedisClientType,
  embedding: Buffer,
  options: Options,
): Promise<Array<{ id: string; score: number }>> {
  const filterClause = "(@status:{ACTIVE})";
  const query = `${filterClause}=>[KNN ${options.knnLimit} @embedding $vec AS score]`;

  const raw = (await redis.sendCommand([
    "FT.SEARCH",
    "idx:ai:embed:market",
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
    const id = String(key).replace("ai:embed:market:", "");
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

type ClusterAnalysis = {
  summary: string;
  status: string;
  updatedAt: string;
  qualityScore: number | null;
};

async function runClusterAnalysis(
  _cluster: ClusterRecord,
): Promise<ClusterAnalysis | null> {
  if (process.env.AI_CLUSTER_ANALYSIS_ENABLED !== "true") return null;
  return {
    summary: "",
    status: "pending",
    updatedAt: new Date().toISOString(),
    qualityScore: null,
  };
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
    const seedSignature = buildSignature({
      eventTitle: seed.event_title,
      marketTitle: seed.market_title,
      eventCategory: seed.event_category,
      marketCategory: seed.market_category,
      dates: [seed.end_date, seed.expiration_time, seed.close_time],
    });
    const embeddingRaw = (await bufferClient.hmGet(
      `ai:embed:market:${seed.id}`,
      ["embedding"],
    ))[0];
    const embedding = Buffer.isBuffer(embeddingRaw) ? embeddingRaw : null;
    if (!embedding) continue;

    const neighbors = await fetchMarketNeighbors(redis, embedding, options);
    const candidateIds = Array.from(
      new Set(
        neighbors
          .filter((neighbor) => neighbor.score <= options.maxDistance)
          .map((neighbor) => neighbor.id)
          .concat(seed.id),
      ),
    );

    if (candidateIds.length === 0) continue;

    const now = new Date();
    const { rows } = await pool.query<NeighborMarketRow>(
      `
        select
          m.id,
          m.event_id,
          m.venue,
          m.title as market_title,
          e.title as event_title,
          m.category as market_category,
          e.category as event_category,
          m.market_type,
          m.close_time,
          m.expiration_time,
          e.end_date
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.id = any($1::text[])
          and m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and (e.end_date is null or e.end_date > $2)
          and (m.expiration_time is null or m.expiration_time > $2)
          and (m.close_time is null or m.close_time > $2)
      `,
      [candidateIds, now],
    );

    const metaById = new Map<string, NeighborMarketRow>();
    const signatureById = new Map<string, Signature>();
    for (const row of rows) {
      metaById.set(row.id, row);
      signatureById.set(
        row.id,
        buildSignature({
          eventTitle: row.event_title,
          marketTitle: row.market_title,
          eventCategory: row.event_category,
          marketCategory: row.market_category,
          dates: [row.end_date, row.expiration_time, row.close_time],
        }),
      );
    }

    const bestByEvent = new Map<
      string,
      { matchScore: number; eventId: string }
    >();

    for (const neighbor of neighbors) {
      if (neighbor.score > options.maxDistance) continue;
      const meta = metaById.get(neighbor.id);
      if (!meta) continue;
      if (meta.event_id === seed.event_id) continue;
      if (
        seed.market_type &&
        meta.market_type &&
        meta.market_type !== seed.market_type
      )
        continue;

      const signature = signatureById.get(neighbor.id);
      if (!signature) continue;
      if (!isSignatureCompatible(seedSignature, signature)) continue;

      const matchScore = scoreSignatureMatch(
        seedSignature,
        signature,
        neighbor.score,
      );
      const existing = bestByEvent.get(meta.event_id);
      if (!existing || matchScore > existing.matchScore) {
        bestByEvent.set(meta.event_id, {
          matchScore,
          eventId: meta.event_id,
        });
      }
    }

    const eventIds = new Set<string>([seed.event_id]);
    const ranked = Array.from(bestByEvent.values())
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, options.neighborLimit);

    for (const entry of ranked) {
      eventIds.add(entry.eventId);
    }

    if (eventIds.size < 2) continue;
    clusters.push({
      seedEventId: seed.event_id,
      seedMarketId: seed.id,
      seedScore: seed.score,
      seedMarketType: seed.market_type,
      seedMarketTitle: seed.market_title,
      seedEventTitle: seed.event_title,
      seedSignature,
      eventIds,
    });
  }

  if (!clusters.length) return [];

  const { find, union } = unionFind(clusters.length);
  const mergeJaccard = 0.25;
  const mergeOverlap = 2;
  for (let i = 0; i < clusters.length; i += 1) {
    for (let j = i + 1; j < clusters.length; j += 1) {
      if (!isSignatureCompatible(clusters[i].seedSignature, clusters[j].seedSignature))
        continue;
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
      current.seedSignature = clusters[i].seedSignature;
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

    const priced = capped.filter((summary) => summary.yesMid != null);
    if (priced.length < 2) continue;
    const pricedVenueCount = new Set(priced.map((summary) => summary.venue)).size;
    if (pricedVenueCount < options.minVenueCount) continue;

    const metrics = computeClusterMetrics(priced);
    if (metrics.venueCount < options.minVenueCount) continue;
    if (metrics.priceSpread != null && metrics.priceSpread < options.minSpread)
      continue;

    const score = scoreCluster(metrics);
    const marketIds = priced.map((summary) => summary.marketId).sort();
    const marketsPreview = priced
      .slice()
      .sort((a, b) => {
        const scoreA = marketScoreById.get(a.marketId) ?? 0;
        const scoreB = marketScoreById.get(b.marketId) ?? 0;
        return scoreB - scoreA;
      })
      .slice(0, 6);

    const qualityScores = priced.map((summary) =>
      scoreSignatureSimilarity(
        cluster.seedSignature,
        buildSignature({
          eventTitle: summary.eventTitle,
          marketTitle: summary.marketTitle,
          eventCategory: null,
          marketCategory: null,
          dates: [summary.expiresAt],
        }),
      ),
    );
    const qualityScore =
      qualityScores.length > 0
        ? qualityScores.reduce((sum, value) => sum + value, 0) /
          qualityScores.length
        : null;

    const record: ClusterRecord = {
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
      analysis: null,
      analysisStatus: null,
      analysisUpdatedAt: null,
      qualityScore,
    };

    const analysis = await runClusterAnalysis(record);
    if (analysis) {
      record.analysis = analysis.summary;
      record.analysisStatus = analysis.status;
      record.analysisUpdatedAt = analysis.updatedAt;
      record.qualityScore = analysis.qualityScore;
    }

    results.push(record);
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
      analysis: cluster.analysis ?? "",
      analysis_status: cluster.analysisStatus ?? "",
      analysis_updated_at: cluster.analysisUpdatedAt ?? "",
      quality_score:
        cluster.qualityScore != null ? String(cluster.qualityScore) : "",
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
  await ensureRedis(redis, { waitForReady: true, logLabel: "ai-embed-cluster" });

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
