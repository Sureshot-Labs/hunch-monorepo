import { createHash } from "crypto";
import { pathToFileURL } from "node:url";
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
import {
  getIntelPolicyDefaults,
  resolveAiClustersPolicy,
  type AiClustersPolicy,
} from "./services/runtime-policies.js";

const INDEX_KEY = "ai:cluster:index";
const META_KEY = "ai:cluster:meta";
const CLUSTER_KEY_PREFIX = "ai:cluster:";
const CLUSTER_VERSION = "v2";

let aiClustersPolicy: AiClustersPolicy = getIntelPolicyDefaults("ai_clusters");

type SeedRow = {
  id: string;
  event_id: string;
  venue: string;
  market_title: string | null;
  event_title: string | null;
  market_slug: string | null;
  event_slug: string | null;
  market_category: string | null;
  event_category: string | null;
  series_key: string | null;
  series_title: string | null;
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

type MatchTier =
  | "seed"
  | "structuredExact"
  | "lexicalExact"
  | "marketEmbedding";

type ClusterMatchDetail = {
  marketId: string;
  score: number;
  tier: MatchTier;
};

type ClusterMatchDiagnostics = {
  family: ComparatorFamily;
  category: CoarseCategory | null;
  matchTierCounts: Record<MatchTier, number>;
  weakestMatchScore: number | null;
  medianMatchScore: number | null;
  meanMatchScore: number | null;
  exactMatchRatio: number | null;
  prePruneOutlierRatio: number | null;
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
  matchedMarketsByEvent: Map<string, ClusterMatchDetail>;
};

type ClusterRecord = {
  id: string;
  label: string;
  score: number;
  seedMarketId: string;
  seedSignature: Signature;
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
  analysisConfidence: number | null;
  analysisModel: string | null;
  qualityScore: number | null;
  matchDetails: ClusterMatchDetail[];
  matchDiagnostics: ClusterMatchDiagnostics | null;
};

type AnalysisMarketInput = {
  marketId: string;
  venue: string;
  eventTitle: string | null;
  marketTitle: string | null;
  eventDescription: string | null;
  marketDescription: string | null;
  yesMid: number | null;
  liquidity: number | null;
  volume24h: number | null;
  expiresAt: string | null;
};

type AnalysisInput = {
  clusterId: string;
  label: string;
  priceSpread: number | null;
  minLiquidity: number | null;
  volume24h: number | null;
  expiresAt: string | null;
  venueCounts: Record<string, number>;
  marketCount: number;
  markets: AnalysisMarketInput[];
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
  noAnalysis: boolean;
};

type ClusterMarketRow = {
  id: string;
  event_id: string;
  venue: string;
  title: string | null;
  description: string | null;
  slug: string | null;
  image: string | null;
  icon: string | null;
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
  event_description: string | null;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
};

type NeighborMarketRow = {
  id: string;
  event_id: string;
  venue: string;
  market_title: string | null;
  event_title: string | null;
  market_slug: string | null;
  event_slug: string | null;
  market_category: string | null;
  event_category: string | null;
  series_key: string | null;
  series_title: string | null;
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
      fallback: aiClustersPolicy.analysisMinVenueCount,
    }),
    minSpread: clampNumber(parseNumber(parseFlag(args, "--min-spread")), {
      min: 0,
      max: 1,
      fallback: aiClustersPolicy.analysisMinSpread,
    }),
    ttlSec: clampNumber(parseNumber(parseFlag(args, "--ttl-sec")), {
      min: 3600,
      max: 7 * 24 * 3600,
      fallback: 2 * 24 * 3600,
    }),
    dryRun: hasFlag(args, "--dry-run"),
    noAnalysis: hasFlag(args, "--no-analysis"),
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
  --no-analysis           Skip AI analysis and store raw clusters
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

type ComparatorFamily =
  | "alien_confirmation"
  | "religious_return"
  | "territorial_acquisition"
  | "regime_change"
  | "military_action"
  | "diplomatic_visit"
  | "office_exit"
  | "election_candidate_entry"
  | "election_nominee"
  | "election_winner"
  | "office_holder_after_election"
  | "event_winner"
  | "appearance_role"
  | "tournament_winner"
  | "conference_champion"
  | "group_winner"
  | "season_champion"
  | "race_winner"
  | "tournament_stage_advancement"
  | "match_result"
  | "match_halftime"
  | "match_margin_state"
  | "match_exact_score"
  | "match_total_threshold"
  | "match_discipline_threshold"
  | "match_stat_threshold"
  | "match_scoring_prop"
  | "match_officiating_prop"
  | "match_lineup"
  | "player_award"
  | "player_stat_threshold"
  | "team_stat_threshold"
  | "odds_threshold"
  | "fdv_threshold"
  | "token_launch_deadline"
  | "price_hit_window"
  | "price_by_deadline"
  | "price_at_time"
  | "price_first_touch"
  | "price_level"
  | "layoffs_trend"
  | "company_metric_threshold"
  | "fed_policy_decision"
  | "other";

type TimeScopeKind =
  | "point_in_time"
  | "deadline"
  | "week_horizon"
  | "quarter_horizon"
  | "year_horizon"
  | "period"
  | "unknown";

type PriceContractMode =
  | "above_threshold"
  | "below_threshold"
  | "range_bin"
  | "other";

type Signature = {
  type: QuestionType;
  family: ComparatorFamily;
  category: CoarseCategory | null;
  tokens: Set<string>;
  entityTokens: Set<string>;
  subjectTokens: Set<string>;
  officeTokens: Set<string>;
  selectionTokens: Set<string>;
  outcomeScopeTokens: Set<string>;
  participantGroups: Array<Set<string>>;
  years: Set<number>;
  months: Set<string>;
  dateKeys: Set<string>;
  timeScope: TimeScopeKind;
  priceMode: PriceContractMode | null;
};

type StructuredIdentityInput = {
  eventTitle?: string | null;
  marketTitle?: string | null;
  eventSlug?: string | null;
  marketSlug?: string | null;
  seriesKey?: string | null;
  seriesTitle?: string | null;
};

type StructuredIdentity = {
  eventTitleKey: string | null;
  marketTitleKey: string | null;
  eventSlugKey: string | null;
  marketSlugKey: string | null;
  seriesKey: string | null;
  seriesTitleKey: string | null;
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

const SHORT_TOKENS = new Set([
  "ai",
  "btc",
  "eth",
  "sol",
  "epl",
  "nfl",
  "nba",
  "mlb",
  "nhl",
  "f1",
  "fed",
  "cpi",
  "gdp",
  "us",
  "uk",
  "eu",
]);

const NON_ENTITY_TOKENS = new Set([
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "will",
  "would",
  "could",
  "should",
  "can",
  "is",
  "are",
  "was",
  "were",
  "odds",
  "market",
  "markets",
  "more",
  "exact",
  "price",
  "score",
  "result",
  "results",
  "winner",
  "winners",
  "match",
  "game",
  "lead",
  "halftime",
  "before",
  "after",
  "during",
  "season",
  "tournament",
  "series",
  "year",
  "month",
  "day",
  "week",
  "than",
  "up",
  "down",
  "high",
  "low",
  "get",
  "gets",
  "start",
  "starting",
  "starts",
  "utc",
  "q1",
  "q2",
  "q3",
  "q4",
  "election",
  "elections",
  "parliamentary",
  "presidential",
  "prime",
  "minister",
  "president",
  "nominee",
  "nomination",
  "party",
  "parties",
  "office",
  "yes",
  "no",
  "hit",
  "above",
  "below",
  "over",
  "under",
  "reach",
  "reaches",
]);

const LOW_VALUE_SUBJECT_TOKENS = new Set([
  ...NON_ENTITY_TOKENS,
  "usd",
  "eur",
  "gbp",
  "jpy",
  "cny",
  "krw",
  "cad",
  "aud",
  "chf",
  "nzd",
  "hkd",
  "sgd",
  "q1",
  "q2",
  "q3",
  "q4",
  "close",
  "closes",
  "closing",
  "open",
  "opening",
  "end",
  "final",
  "upper",
  "lower",
  "reach",
  "reaches",
  "meeting",
  "winner",
  "winners",
  "champion",
  "championship",
  "race",
  "sprint",
  "grand",
  "prix",
  "rate",
  "rates",
  "tech",
]);

const OUTCOME_SCOPE_PATTERNS: Array<[string, RegExp]> = [
  ["drivers", /\bdrivers?\b/],
  ["constructors", /\bconstructors?\b/],
  ["division", /\bdivision\b/],
  ["conference", /\bconference\b/],
  ["group", /\bgroup\b/],
  ["stanley_cup", /\bstanley cup\b/],
  ["world_cup", /\bworld cup\b/],
  ["cup", /\bcup\b/],
  ["playoffs", /\bplayoffs?\b/],
  ["title", /\btitle\b/],
  ["championship", /\bchampionship\b/],
  ["champion", /\bchampions?\b/],
  ["final", /\bgrand final\b|\bupper final\b|\bfinals?\b/],
  ["semifinal", /\bsemi[- ]?finals?\b/],
  ["quarterfinal", /\bquarter[- ]?finals?\b/],
  ["promotion", /\bpromotion\b/],
  ["relegation", /\brelegation\b/],
];

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

const MONTH_NORMALIZATION: Record<string, string> = {
  jan: "january",
  january: "january",
  feb: "february",
  february: "february",
  mar: "march",
  march: "march",
  apr: "april",
  april: "april",
  may: "may",
  jun: "june",
  june: "june",
  jul: "july",
  july: "july",
  aug: "august",
  august: "august",
  sep: "september",
  sept: "september",
  september: "september",
  oct: "october",
  october: "october",
  nov: "november",
  november: "november",
  dec: "december",
  december: "december",
};

function extractEntityTokens(text: string | null | undefined): Set<string> {
  const entities = new Set<string>();
  if (!text) return entities;
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9'’.-]*/g) ?? [];
  for (const raw of matches) {
    const cleaned = raw.replace(/['’.-]+$/g, "");
    const normalized = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!normalized) continue;
    if (/^\d+$/.test(normalized)) continue;
    if (normalized.length < 3 && !SHORT_TOKENS.has(normalized)) continue;
    if (MONTH_TOKENS.has(normalized)) continue;
    if (NON_ENTITY_TOKENS.has(normalized)) continue;
    const isAllCaps =
      cleaned.toUpperCase() === cleaned && /[A-Z]/.test(cleaned);
    const isTitle = cleaned[0] === cleaned[0]?.toUpperCase();
    if (isAllCaps || isTitle) {
      entities.add(normalized);
    }
  }
  return entities;
}

function extractOfficeTokens(text: string | null | undefined): Set<string> {
  const office = new Set<string>();
  if (!text) return office;
  const lower = text.toLowerCase();
  if (
    lower.includes("vice president") ||
    lower.includes("vice presidential") ||
    lower.includes(" vp ")
  ) {
    office.add("vice_president");
  }
  if (lower.includes("president") && !office.has("vice_president")) {
    office.add("president");
  }
  if (lower.includes("prime minister")) office.add("prime_minister");
  if (lower.includes("governor")) office.add("governor");
  if (lower.includes("senate") || lower.includes("senator")) office.add("senate");
  if (lower.includes("house")) office.add("house");
  if (lower.includes("parliament")) office.add("parliament");
  if (lower.includes("mayor")) office.add("mayor");
  return office;
}

function extractSelectionTokens(text: string | null | undefined): Set<string> {
  const selection = new Set<string>();
  if (!text) return selection;
  const normalized = text.trim().toLowerCase();
  if (
    normalized === "yes" ||
    normalized === "no" ||
    normalized === "draw" ||
    normalized === "other"
  ) {
    return selection;
  }
  for (const token of extractEntityTokens(text)) {
    if (NON_ENTITY_TOKENS.has(token)) continue;
    selection.add(token);
  }
  if (selection.size > 0) return selection;
  for (const token of extractTopicTokens(text)) {
    if (NON_ENTITY_TOKENS.has(token)) continue;
    if (LOW_VALUE_SUBJECT_TOKENS.has(token)) continue;
    selection.add(token);
  }
  return selection;
}

function extractOutcomeScopeTokens(text: string | null | undefined): Set<string> {
  const scope = new Set<string>();
  if (!text) return scope;
  const lower = text.toLowerCase().replace(/['’]/g, "");
  for (const [token, pattern] of OUTCOME_SCOPE_PATTERNS) {
    if (pattern.test(lower)) {
      scope.add(token);
    }
  }
  if (/\b(?:reach|qualify|advance|make)\b/.test(lower)) {
    if (
      scope.has("final") ||
      scope.has("semifinal") ||
      scope.has("quarterfinal") ||
      scope.has("championship")
    ) {
      scope.add("advancement");
    }
  }
  return scope;
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
    if (MONTH_TOKENS.has(token)) months.add(MONTH_NORMALIZATION[token] ?? token);
  }
  return months;
}

function extractDateKeys(values: Array<unknown> | undefined): Set<string> {
  const keys = new Set<string>();
  if (!values?.length) return keys;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) continue;
    keys.add(date.toISOString().slice(0, 10));
  }
  return keys;
}

function classifyTimeScope(text: string | null | undefined): TimeScopeKind {
  if (!text) return "unknown";
  const lower = text.toLowerCase();
  if (lower.includes("week of")) return "week_horizon";
  if (
    /\bq[1-4]\b/.test(lower) ||
    lower.includes("quarter") ||
    lower.includes("end of q")
  ) {
    return "quarter_horizon";
  }
  if (
    /\b(on|at)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\b/.test(
      lower,
    ) ||
    /\b\d{1,2}:\d{2}\b/.test(lower)
  ) {
    return "point_in_time";
  }
  if (lower.includes("before ") || lower.includes(" by ")) {
    return "deadline";
  }
  if (
    /\bin\s+20\d{2}\b/.test(lower) ||
    lower.includes("end of 20") ||
    lower.includes("through 20")
  ) {
    return "year_horizon";
  }
  if (lower.includes("end of ") || lower.includes("during ")) {
    return "period";
  }
  return "unknown";
}

function classifyPriceContractMode(
  text: string | null | undefined,
): PriceContractMode | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (
    /\$\s*\d+(\.\d+)?\s*-\s*\$?\s*\d+(\.\d+)?/.test(lower) ||
    lower.includes("between")
  ) {
    return "range_bin";
  }
  if (/\b(?:above|over|at least|close above|closes above)\b/.test(lower)) {
    return "above_threshold";
  }
  if (/\b(?:below|under|at most|close below|closes below)\b/.test(lower)) {
    return "below_threshold";
  }
  return "other";
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

function classifyComparatorFamily(text: string | null | undefined): ComparatorFamily {
  if (!text) return "other";
  const lower = text.toLowerCase();
  const normalized = lower.replace(/['’]/g, "");

  if (
    (normalized.includes("confirm") || normalized.includes("official")) &&
    (normalized.includes("alien") ||
      normalized.includes("ufo") ||
      normalized.includes("extraterrestrial"))
  ) {
    return "alien_confirmation";
  }

  if (
    normalized.includes("jesus christ return") ||
    normalized.includes("second coming")
  ) {
    return "religious_return";
  }

  if (
    normalized.includes("acquire greenland") ||
    normalized.includes("acquire any new territory") ||
    normalized.includes("new territory") ||
    normalized.includes("take control of any part of greenland") ||
    normalized.includes("acquire part of greenland")
  ) {
    return "territorial_acquisition";
  }

  if (
    normalized.includes("out as president") ||
    normalized.includes("out as prime minister") ||
    normalized.includes("resign") ||
    normalized.includes("resignation") ||
    normalized.includes("step down") ||
    normalized.includes("removed from office") ||
    normalized.includes("removed as president") ||
    normalized.includes("removed as prime minister")
  ) {
    return "office_exit";
  }

  if (normalized.includes("regime fall") || normalized.includes("regime-fall")) {
    return "regime_change";
  }

  if (
    normalized.includes("invade") ||
    normalized.includes("forces enter") ||
    normalized.includes("enter iran") ||
    normalized.includes("military")
  ) {
    return "military_action";
  }

  if (
    normalized.includes("fed decision") ||
    normalized.includes("fed rate hike") ||
    normalized.includes("fed rate cut") ||
    normalized.includes("next fed rate hike")
  ) {
    return "fed_policy_decision";
  }

  if (normalized.includes("visit china") || normalized.includes(" visit ")) {
    return "diplomatic_visit";
  }

  if (
    normalized.includes("prime minister of") &&
    normalized.includes("after the") &&
    normalized.includes("election")
  ) {
    return "office_holder_after_election";
  }

  if (
    normalized.includes("who will run for") ||
    normalized.includes("run for the republican presidential nomination") ||
    normalized.includes("run for the democratic presidential nomination") ||
    normalized.includes("run for the presidential nomination")
  ) {
    return "election_candidate_entry";
  }

  if (
    normalized.includes("nominee") ||
    normalized.includes("nomination") ||
    normalized.includes("primary winner") ||
    normalized.includes("primary nominee")
  ) {
    return "election_nominee";
  }

  if (
    normalized.includes("election winner") ||
    normalized.includes("presidential election winner") ||
    normalized.includes("parliamentary election winner") ||
    normalized.includes("senate winner")
  ) {
    return "election_winner";
  }

  if (normalized.includes("conference champion")) {
    return "conference_champion";
  }

  if (normalized.includes("group") && normalized.includes("winner")) {
    return "group_winner";
  }

  if (
    normalized.includes("grand prix") &&
    normalized.includes("winner")
  ) {
    return "race_winner";
  }

  if (
    normalized.includes("world cup winner") ||
    normalized.includes("cup winner") ||
    normalized.includes("tournament champion")
  ) {
    return "tournament_winner";
  }

  if (normalized.includes("open winner") || normalized.includes("winner?")) {
    return "event_winner";
  }

  if (
    /\b(?:reach|qualify|advance|make)\b.*\b(?:grand final|upper final|final|upper semifinal|semifinal|quarterfinal|championship)\b/.test(
      normalized,
    )
  ) {
    return "tournament_stage_advancement";
  }

  if (
    normalized.includes("drivers champion") ||
    normalized.includes("constructors champion") ||
    normalized.includes("season champion") ||
    normalized.includes("stanley cup champion") ||
    normalized.includes("nba champion") ||
    normalized.includes("mls cup champion")
  ) {
    return "season_champion";
  }

  if (
    lower.includes("appear as an analyst") ||
    lower.includes("appear as analyst") ||
    lower.includes("listed as an analyst")
  ) {
    return "appearance_role";
  }

  if (lower.includes("halftime")) return "match_halftime";
  if (
    lower.includes("starting xi") ||
    lower.includes("listed in the starting xi") ||
    lower.includes(" start ")
  ) {
    return "match_lineup";
  }
  if (
    (lower.includes(" vs ") || lower.includes("versus")) &&
    (lower.includes("var") || lower.includes("goal check"))
  ) {
    return "match_officiating_prop";
  }
  if (
    lower.includes("red card") ||
    lower.includes("yellow cards") ||
    lower.includes("yellow card") ||
    lower.includes("booking") ||
    lower.includes("bookings") ||
    lower.includes("fouls") ||
    lower.includes("corners")
  ) {
    return "match_discipline_threshold";
  }
  if (
    lower.includes("stoppage time") ||
    lower.includes("added time") ||
    lower.includes("injury time")
  ) {
    return "match_stat_threshold";
  }
  if (
    lower.includes("shots on target") ||
    lower.includes("shot on target") ||
    lower.includes(" s.o.t") ||
    lower.includes(" sot ") ||
    lower.includes("possession") ||
    lower.includes("shots outside box") ||
    lower.includes("outside box") ||
    lower.includes("saves") ||
    lower.includes("offsides")
  ) {
    return "match_stat_threshold";
  }
  if (
    lower.includes("goal after") ||
    lower.includes("both teams to score") ||
    lower.includes("clean sheet")
  ) {
    return "match_scoring_prop";
  }
  if (
    lower.includes("o/u") ||
    lower.includes("over/under") ||
    lower.includes("combine to score") ||
    lower.includes("total goals") ||
    lower.includes("both teams to score")
  ) {
    return "match_total_threshold";
  }
  if (
    lower.includes("lead by 2") ||
    lower.includes("lead by 2+") ||
    lower.includes("at any point")
  ) {
    return "match_margin_state";
  }
  if (lower.includes("exact score")) return "match_exact_score";
  if (
    lower.includes("draw") ||
    lower.includes("match winner") ||
    lower.includes("fixture") ||
    lower.includes(" vs ") ||
    lower.includes(" vs.") ||
    lower.includes("versus")
  ) {
    return "match_result";
  }

  if (
    lower.includes("top goalscorer") ||
    lower.includes("top scorer") ||
    lower.includes("mvp")
  ) {
    return "player_award";
  }

  if (
    lower.includes("score ") ||
    lower.includes("goals in") ||
    lower.includes("shots on target") ||
    lower.includes("rebounds") ||
    lower.includes("assists")
  ) {
    return "player_stat_threshold";
  }

  if (
    lower.includes("reach 90 points") ||
    lower.includes("reach at least") ||
    lower.includes("team reach")
  ) {
    return "team_stat_threshold";
  }

  if (lower.includes("fdv")) return "fdv_threshold";
  if (/\blaunch (?:a )?(?:token|coin) by\b/.test(lower)) {
    return "token_launch_deadline";
  }
  if (lower.includes("layoffs")) return "layoffs_trend";
  if (lower.includes("deliveries")) return "company_metric_threshold";
  if (lower.includes("odds ") && lower.includes(" hit ")) {
    return "odds_threshold";
  }
  if (
    /\b(?:above|below|over|under)\b/.test(lower) &&
    (lower.includes(" on ") ||
      lower.includes(" end of ") ||
      lower.includes("close above") ||
      lower.includes("close below") ||
      lower.includes("closes above") ||
      lower.includes("closes below") ||
      lower.includes("opening price") ||
      lower.includes("closing price"))
  ) {
    return "price_at_time";
  }
  if (
    (lower.includes("above") || lower.includes("below")) &&
    lower.includes(" by ")
  ) {
    return "price_by_deadline";
  }
  if (lower.includes("hit") && lower.includes(" first")) {
    return "price_first_touch";
  }
  if (lower.includes("how high will") || lower.includes("how low will")) {
    return "price_hit_window";
  }
  if (
    lower.includes("when will") ||
    lower.includes("before ") ||
    lower.includes("cross $")
  ) {
    return "price_by_deadline";
  }
  if (
    lower.includes("price on ") ||
    lower.includes("price at ") ||
    lower.includes("end of 2026") ||
    lower.includes("end of 2027")
  ) {
    return "price_at_time";
  }
  if (
    lower.includes("what price will") ||
    lower.includes(" hit in ") ||
    lower.includes(" hit march") ||
    lower.includes(" hit in march")
  ) {
    return "price_hit_window";
  }
  if (
    lower.includes("price") ||
    lower.includes(" hit") ||
    lower.includes("above ___") ||
    lower.includes("below ___")
  ) {
    return "price_level";
  }

  return "other";
}

function extractParticipantGroups(text: string | null | undefined): Array<Set<string>> {
  if (!text) return [];
  const parts = text
    .replace(/[–—]/g, " vs ")
    .split(/\b(?:vs\.?|versus)\b/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length !== 2) return [];
  return parts
    .map((part) => {
      const group = new Set<string>();
      for (const token of extractEntityTokens(part)) {
        if (!NON_ENTITY_TOKENS.has(token) && !MONTH_TOKENS.has(token)) {
          group.add(token);
        }
      }
      if (group.size === 0) {
        for (const token of extractTopicTokens(part)) {
          if (!NON_ENTITY_TOKENS.has(token) && !MONTH_TOKENS.has(token)) {
            group.add(token);
          }
        }
      }
      return group;
    })
    .filter((group) => group.size > 0);
}

function extractSubjectTokens(
  primaryText: string | null | undefined,
  fallbackText: string | null | undefined,
): Set<string> {
  const subject = new Set<string>();
  const sources = [primaryText, fallbackText].filter(
    (value): value is string => Boolean(value),
  );

  for (const source of sources) {
    for (const token of extractEntityTokens(source)) {
      if (LOW_VALUE_SUBJECT_TOKENS.has(token) || MONTH_TOKENS.has(token)) continue;
      subject.add(token);
    }
    for (const token of extractTopicTokens(source)) {
      if (LOW_VALUE_SUBJECT_TOKENS.has(token) || MONTH_TOKENS.has(token)) continue;
      subject.add(token);
    }
  }

  return subject;
}

export function buildSignature(params: {
  eventTitle: string | null | undefined;
  marketTitle: string | null | undefined;
  eventCategory: string | null | undefined;
  marketCategory: string | null | undefined;
  dates?: Array<unknown>;
}): Signature {
  const text = `${params.eventTitle ?? ""} ${params.marketTitle ?? ""}`.trim();
  const tokens = extractTopicTokens(text);
  const entityTokens = extractEntityTokens(text);
  if (entityTokens.size < 2) {
    const fallback = Array.from(tokens).filter(
      (token) => token.length >= 5 && !NON_ENTITY_TOKENS.has(token),
    );
    for (const token of fallback.slice(0, 6)) entityTokens.add(token);
  }
  const years = extractYears(text);
  const months = extractMonths(text);
  const dateKeys = extractDateKeys(params.dates);
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
  const family = classifyComparatorFamily(text);
  const timeScope = classifyTimeScope(text);
  const priceMode =
    type === "price" ? classifyPriceContractMode(`${params.eventTitle ?? ""} ${params.marketTitle ?? ""}`) : null;
  const subjectTokens = extractSubjectTokens(
    params.eventTitle,
    params.marketTitle,
  );
  const officeTokens = extractOfficeTokens(params.eventTitle);
  const selectionTokens = extractSelectionTokens(params.marketTitle);
  const outcomeScopeTokens = extractOutcomeScopeTokens(text);
  const participantGroups = extractParticipantGroups(
    params.eventTitle ?? params.marketTitle ?? text,
  );

  return {
    type,
    family,
    category,
    tokens,
    entityTokens,
    subjectTokens,
    officeTokens,
    selectionTokens,
    outcomeScopeTokens,
    participantGroups,
    years,
    months,
    dateKeys,
    timeScope,
    priceMode,
  };
}

function familyRequiresExplicitMonthMatch(signature: Signature): boolean {
  return (
    signature.family === "price_hit_window" ||
    signature.family === "fed_policy_decision" ||
    signature.family === "layoffs_trend"
  );
}

function familyRequiresScopeMatch(signature: Signature): boolean {
  return (
    signature.family === "office_exit" ||
    signature.family === "territorial_acquisition" ||
    signature.family === "regime_change" ||
    signature.family === "military_action" ||
    signature.family === "diplomatic_visit" ||
    signature.family === "layoffs_trend" ||
    signature.family === "price_hit_window" ||
    signature.family === "price_by_deadline" ||
    signature.family === "price_at_time" ||
    signature.family === "price_first_touch" ||
    signature.family === "price_level"
  );
}

function familyRequiresExactDateMatch(signature: Signature): boolean {
  return (
    signature.family === "office_exit" ||
    signature.family === "price_at_time"
  );
}

function timeCompatible(a: Signature, b: Signature): boolean {
  if (
    (familyRequiresScopeMatch(a) || familyRequiresScopeMatch(b)) &&
    a.timeScope !== "unknown" &&
    b.timeScope !== "unknown" &&
    a.timeScope !== b.timeScope
  ) {
    return false;
  }
  if (
    (familyRequiresExactDateMatch(a) || familyRequiresExactDateMatch(b)) &&
    a.dateKeys.size > 0 &&
    b.dateKeys.size > 0
  ) {
    let hasExactDateOverlap = false;
    for (const key of a.dateKeys) {
      if (b.dateKeys.has(key)) {
        hasExactDateOverlap = true;
        break;
      }
    }
    if (!hasExactDateOverlap) return false;
  }
  if (
    familyRequiresExplicitMonthMatch(a) ||
    familyRequiresExplicitMonthMatch(b)
  ) {
    if (a.months.size !== b.months.size && (a.months.size > 0 || b.months.size > 0)) {
      return false;
    }
    if (a.months.size > 0 && b.months.size > 0 && a.years.size > 0 && b.years.size > 0) {
      let yearOverlap = false;
      for (const year of a.years) {
        if (b.years.has(year)) {
          yearOverlap = true;
          break;
        }
      }
      if (!yearOverlap) return false;
    }
  }
  if (a.months.size > 0 && b.months.size > 0) {
    let monthOverlap = false;
    for (const month of a.months) {
      if (b.months.has(month)) {
        monthOverlap = true;
        break;
      }
    }
    if (!monthOverlap) return false;
  }
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

function normalizeTitleKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  return normalized.length > 0 ? normalized : null;
}

function buildStructuredIdentity(
  input: StructuredIdentityInput,
): StructuredIdentity {
  return {
    eventTitleKey: normalizeTitleKey(input.eventTitle),
    marketTitleKey: normalizeTitleKey(input.marketTitle),
    eventSlugKey: normalizeTitleKey(input.eventSlug),
    marketSlugKey: normalizeTitleKey(input.marketSlug),
    seriesKey: input.seriesKey?.trim().toLowerCase() || null,
    seriesTitleKey: normalizeTitleKey(input.seriesTitle),
  };
}

function selectSearchAnchorTokens(signature: Signature): string[] {
  const anchors = new Set<string>();
  for (const token of signature.subjectTokens) {
    if (LOW_VALUE_SUBJECT_TOKENS.has(token)) continue;
    if (token.length < 3 && !SHORT_TOKENS.has(token)) continue;
    anchors.add(token);
    if (anchors.size >= 4) break;
  }
  for (const token of signature.entityTokens) {
    if (NON_ENTITY_TOKENS.has(token)) continue;
    if (token.length < 3 && !SHORT_TOKENS.has(token)) continue;
    anchors.add(token);
    if (anchors.size >= 4) break;
  }
  if (anchors.size < 2) {
    for (const token of signature.tokens) {
      if (NON_ENTITY_TOKENS.has(token)) continue;
      if (token.length < 4 && !SHORT_TOKENS.has(token)) continue;
      anchors.add(token);
      if (anchors.size >= 4) break;
    }
  }
  return Array.from(anchors);
}

function scoreSignatureMatch(a: Signature, b: Signature, embedScore: number): number {
  const embedSim = Math.max(0, Math.min(1, 1 - embedScore));
  const { intersection, jaccard } = computeTopicOverlap(a.tokens, b.tokens);
  const entityOverlap = intersectionSize(a.entityTokens, b.entityTokens);
  const typeScore = a.type === b.type ? 1 : 0;
  const familyScore = a.family === b.family ? 1 : 0;
  const categoryScore =
    a.category && b.category ? (a.category === b.category ? 1 : 0) : 0.5;
  const timeScore = timeCompatible(a, b) ? 1 : 0;
  const entityScore = entityOverlap > 0 ? 1 : 0;
  const lexicalScore =
    intersection >= 2 ? 1 : jaccard >= 0.15 ? 0.6 : jaccard;

  return (
    embedSim * 0.4 +
    lexicalScore * 0.2 +
    entityScore * 0.15 +
    typeScore * 0.1 +
    familyScore * 0.1 +
    categoryScore * 0.05 +
    timeScore * 0.05
  );
}

function scoreSignatureSimilarity(a: Signature, b: Signature): number {
  const { intersection, jaccard } = computeTopicOverlap(a.tokens, b.tokens);
  const entityOverlap = intersectionSize(a.entityTokens, b.entityTokens);
  const typeScore = a.type === b.type ? 1 : 0;
  const familyScore = a.family === b.family ? 1 : 0;
  const categoryScore =
    a.category && b.category ? (a.category === b.category ? 1 : 0) : 0.5;
  const timeScore = timeCompatible(a, b) ? 1 : 0;
  const entityScore = entityOverlap > 0 ? 1 : 0;
  const lexicalScore =
    intersection >= 2 ? 1 : jaccard >= 0.15 ? 0.6 : jaccard;

  return (
    lexicalScore * 0.3 +
    entityScore * 0.2 +
    typeScore * 0.15 +
    familyScore * 0.15 +
    categoryScore * 0.1 +
    timeScore * 0.1
  );
}

function requiresStrictEntityOverlap(signature: Signature): boolean {
  return (
    signature.family === "match_result" ||
    signature.family === "match_halftime" ||
    signature.family === "match_margin_state" ||
    signature.family === "match_exact_score" ||
    signature.family === "match_total_threshold" ||
    signature.family === "match_discipline_threshold" ||
    signature.family === "match_lineup" ||
    signature.family === "diplomatic_visit"
  );
}

function requiresAtLeastOneEntityOverlap(signature: Signature): boolean {
  return (
    signature.family === "price_hit_window" ||
    signature.family === "price_by_deadline" ||
    signature.family === "price_at_time" ||
    signature.family === "price_first_touch" ||
    signature.family === "price_level" ||
    signature.family === "odds_threshold" ||
    signature.family === "fdv_threshold" ||
    signature.family === "token_launch_deadline" ||
    signature.family === "company_metric_threshold" ||
    signature.family === "player_award" ||
    signature.family === "player_stat_threshold"
  );
}

function requiresSubjectOverlap(signature: Signature): boolean {
  return (
    signature.type === "mention" ||
    signature.type === "winner" ||
    signature.family === "alien_confirmation" ||
    signature.family === "religious_return" ||
    signature.family === "territorial_acquisition" ||
    signature.family === "regime_change" ||
    signature.family === "military_action" ||
    signature.family === "diplomatic_visit" ||
    signature.family === "tournament_stage_advancement" ||
    signature.family === "price_hit_window" ||
    signature.family === "price_by_deadline" ||
    signature.family === "price_at_time" ||
    signature.family === "price_first_touch" ||
    signature.family === "price_level" ||
    signature.family === "odds_threshold" ||
    signature.family === "fdv_threshold" ||
    signature.family === "token_launch_deadline" ||
    signature.family === "company_metric_threshold" ||
    signature.family === "layoffs_trend" ||
    signature.family === "fed_policy_decision"
  );
}

function requiresStrongerSubjectOverlap(signature: Signature): boolean {
  return (
    signature.family === "season_champion" ||
    signature.family === "tournament_winner" ||
    signature.family === "event_winner" ||
    signature.family === "conference_champion" ||
    signature.family === "group_winner"
  );
}

function requiresOfficeOverlap(signature: Signature): boolean {
  return (
    signature.family === "election_nominee" ||
    signature.family === "election_winner" ||
    signature.family === "office_holder_after_election"
  );
}

function requiresSelectionOverlap(signature: Signature): boolean {
  return (
    signature.family === "election_nominee" ||
    signature.family === "election_winner" ||
    signature.family === "event_winner" ||
    signature.family === "tournament_winner" ||
    signature.family === "conference_champion" ||
    signature.family === "group_winner" ||
    signature.family === "season_champion" ||
    signature.family === "race_winner"
  );
}

function requiresOutcomeScopeOverlap(signature: Signature): boolean {
  return (
    signature.type === "winner" ||
    signature.family === "tournament_stage_advancement"
  );
}

function participantGroupOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

function participantGroupsCompatible(a: Signature, b: Signature): boolean {
  if (a.participantGroups.length < 2 || b.participantGroups.length < 2) {
    return true;
  }
  const direct =
    participantGroupOverlap(a.participantGroups[0], b.participantGroups[0]) &&
    participantGroupOverlap(a.participantGroups[1], b.participantGroups[1]);
  const swapped =
    participantGroupOverlap(a.participantGroups[0], b.participantGroups[1]) &&
    participantGroupOverlap(a.participantGroups[1], b.participantGroups[0]);
  return direct || swapped;
}

const MATCH_STRUCTURE_FAMILIES = new Set<ComparatorFamily>([
  "match_result",
  "match_halftime",
  "match_margin_state",
  "match_exact_score",
  "match_total_threshold",
  "match_discipline_threshold",
  "match_stat_threshold",
  "match_scoring_prop",
  "match_officiating_prop",
  "match_lineup",
]);

const ELECTION_PROCESS_FAMILIES = new Set<ComparatorFamily>([
  "election_candidate_entry",
  "election_nominee",
  "election_winner",
  "office_holder_after_election",
]);

const WINNER_SCOPE_FAMILIES = new Set<ComparatorFamily>([
  "event_winner",
  "tournament_winner",
  "conference_champion",
  "group_winner",
  "season_champion",
  "race_winner",
  "tournament_stage_advancement",
]);

function hasGroupConflict(
  a: ComparatorFamily,
  b: ComparatorFamily,
  group: Set<ComparatorFamily>,
): boolean {
  return group.has(a) && group.has(b) && a !== b;
}

function hasHardStructuralConflict(a: Signature, b: Signature): boolean {
  return (
    hasGroupConflict(a.family, b.family, MATCH_STRUCTURE_FAMILIES) ||
    hasGroupConflict(a.family, b.family, ELECTION_PROCESS_FAMILIES) ||
    hasGroupConflict(a.family, b.family, WINNER_SCOPE_FAMILIES)
  );
}

function requiresTwoSubjectTokens(signature: Signature): boolean {
  return (
    signature.family === "alien_confirmation" ||
    signature.family === "religious_return" ||
    signature.family === "territorial_acquisition" ||
    signature.family === "regime_change" ||
    signature.family === "military_action" ||
    signature.family === "diplomatic_visit" ||
    signature.family === "office_exit" ||
    signature.family === "token_launch_deadline"
  );
}

export function isSignatureCompatible(a: Signature, b: Signature): boolean {
  if (a.type !== b.type) return false;
  if (hasHardStructuralConflict(a, b)) {
    return false;
  }
  if (
    a.type === "price" &&
    b.type === "price" &&
    a.priceMode &&
    b.priceMode &&
    a.priceMode !== "other" &&
    b.priceMode !== "other" &&
    a.priceMode !== b.priceMode
  ) {
    return false;
  }
  if (a.category && b.category && a.category !== b.category) return false;
  if (!timeCompatible(a, b)) return false;
  if (
    requiresStrictEntityOverlap(a) ||
    requiresStrictEntityOverlap(b)
  ) {
    if (!participantGroupsCompatible(a, b)) return false;
  }
  const { intersection, jaccard } = computeTopicOverlap(a.tokens, b.tokens);
  const entityOverlap = intersectionSize(a.entityTokens, b.entityTokens);
  const subjectOverlap = intersectionSize(a.subjectTokens, b.subjectTokens);
  if (
    requiresStrictEntityOverlap(a) ||
    requiresStrictEntityOverlap(b)
  ) {
    if (entityOverlap < 2) return false;
  }
  if (
    requiresAtLeastOneEntityOverlap(a) ||
    requiresAtLeastOneEntityOverlap(b)
  ) {
    if (entityOverlap < 1) return false;
  }
  if (
    requiresSubjectOverlap(a) ||
    requiresSubjectOverlap(b)
  ) {
    const minSubjectOverlap =
      requiresStrongerSubjectOverlap(a) || requiresStrongerSubjectOverlap(b)
        ? Math.min(2, Math.max(1, Math.min(a.subjectTokens.size, b.subjectTokens.size)))
        : 1;
    if (subjectOverlap < minSubjectOverlap) return false;
  }
  if (
    requiresOfficeOverlap(a) ||
    requiresOfficeOverlap(b)
  ) {
    if (
      a.officeTokens.size > 0 &&
      b.officeTokens.size > 0 &&
      intersectionSize(a.officeTokens, b.officeTokens) < 1
    ) {
      return false;
    }
  }
  if (
    requiresSelectionOverlap(a) ||
    requiresSelectionOverlap(b)
  ) {
    if (
      a.selectionTokens.size > 0 &&
      b.selectionTokens.size > 0 &&
      intersectionSize(a.selectionTokens, b.selectionTokens) < 1
    ) {
      return false;
    }
  }
  if (
    (requiresOutcomeScopeOverlap(a) || requiresOutcomeScopeOverlap(b)) &&
    a.outcomeScopeTokens.size > 0 &&
    b.outcomeScopeTokens.size > 0 &&
    intersectionSize(a.outcomeScopeTokens, b.outcomeScopeTokens) < 1
  ) {
    return false;
  }
  if (
    (requiresOutcomeScopeOverlap(a) || requiresOutcomeScopeOverlap(b)) &&
    a.outcomeScopeTokens.has("advancement") !==
      b.outcomeScopeTokens.has("advancement")
  ) {
    return false;
  }
  if (
    a.type === "winner" &&
    b.type === "winner" &&
    a.selectionTokens.size > 0 &&
    b.selectionTokens.size > 0 &&
    intersectionSize(a.selectionTokens, b.selectionTokens) < 1
  ) {
    return false;
  }
  if (
    (requiresTwoSubjectTokens(a) || requiresTwoSubjectTokens(b)) &&
    a.subjectTokens.size >= 2 &&
    b.subjectTokens.size >= 2 &&
    subjectOverlap < 2
  ) {
    return false;
  }
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
      with ranked as (
        select
          m.id,
          m.event_id,
          m.venue,
          m.title as market_title,
          e.title as event_title,
          m.slug as market_slug,
          e.slug as event_slug,
          m.category as market_category,
          e.category as event_category,
          e.series_key,
          e.series_title,
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
          ) as venue_rank,
          row_number() over (
            partition by m.event_id
            order by ${hasPriceExpr} desc, ${scoreExpr} desc
          ) as event_rank
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
      )
      select *
      from ranked
      where venue_rank <= $4
        and event_rank <= 3
      order by has_price desc, score desc
      limit $5
    `,
    [
      now,
      options.minLiquidity,
      options.minVolume24h,
      perVenueLimit,
      options.seedLimit * 6,
    ],
  );

  const selected: SeedRow[] = [];
  const seen = new Set<string>();
  const venueCounts = new Map<string, number>();

  for (const row of rows) {
    const signature = buildSignature({
      eventTitle: row.event_title,
      marketTitle: row.market_title,
      eventCategory: row.event_category,
      marketCategory: row.market_category,
      dates: [row.end_date, row.expiration_time, row.close_time],
    });
    const monthKey =
      familyRequiresExplicitMonthMatch(signature) && signature.months.size > 0
        ? [...signature.months].sort().join(",")
        : "";
    const seedKey = [
      row.event_id,
      signature.family,
      row.market_type ?? "",
      monthKey,
    ].join("|");
    if (seen.has(seedKey)) continue;
    const venueCount = venueCounts.get(row.venue) ?? 0;
    if (venueCount >= perVenueLimit) continue;
    seen.add(seedKey);
    venueCounts.set(row.venue, venueCount + 1);
    selected.push(row);
    if (selected.length >= options.seedLimit) break;
  }

  return selected;
}

async function fetchMarketsByIds(
  marketIds: string[],
): Promise<Map<string, ClusterMarketRow>> {
  if (!marketIds.length) return new Map();
  const now = new Date();

  const { rows } = await pool.query<ClusterMarketRow>(
    `
        select
          m.id,
          m.event_id,
          m.venue,
          m.title,
          m.description,
          m.slug,
          m.image,
          m.icon,
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
          e.description as event_description,
          e.slug as event_slug,
          e.image as event_image,
          e.icon as event_icon
        from unified_markets m
      join unified_events e on e.id = m.event_id
      where m.id = any($1::text[])
        and m.status = 'ACTIVE'
        and e.status = 'ACTIVE'
        and (e.end_date is null or e.end_date > $2)
        and (m.expiration_time is null or m.expiration_time > $2)
        and (m.close_time is null or m.close_time > $2)
    `,
    [marketIds, now],
  );

  const map = new Map<string, ClusterMarketRow>();
  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

type CandidateRow = NeighborMarketRow & {
  hint_score: number | null;
  rn: number;
};

async function fetchCandidateRows(
  seed: SeedRow,
  whereClause: string,
  params: unknown[],
  hintExpr: string,
  limit: number,
): Promise<CandidateRow[]> {
  const scoreExpr =
    "coalesce(m.volume_24h, 0) * 2 + coalesce(m.liquidity, 0) + coalesce(m.open_interest, 0) + coalesce(m.volume_total, 0) * 0.2";
  const hasPriceExpr =
    "case when m.best_bid is not null or m.best_ask is not null or m.last_price is not null then 1 else 0 end";
  const queryParams = [new Date(), ...params];

  if (seed.market_type) {
    queryParams.push(seed.market_type);
  }

  const { rows } = await pool.query<CandidateRow>(
    `
      select *
      from (
        select
          m.id,
          m.event_id,
          m.venue,
          m.title as market_title,
          e.title as event_title,
          m.slug as market_slug,
          e.slug as event_slug,
          m.category as market_category,
          e.category as event_category,
          e.series_key,
          e.series_title,
          m.market_type,
          m.close_time,
          m.expiration_time,
          e.end_date,
          ${hintExpr}::double precision as hint_score,
          row_number() over (
            partition by m.event_id
            order by ${hintExpr} desc nulls last, ${hasPriceExpr} desc, ${scoreExpr} desc
          ) as rn
        from unified_markets m
        join unified_events e on e.id = m.event_id
        where m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and (e.end_date is null or e.end_date > $1)
          and (m.expiration_time is null or m.expiration_time > $1)
          and (m.close_time is null or m.close_time > $1)
          and (${whereClause})
          ${seed.market_type ? `and m.market_type = $${queryParams.length}` : ""}
      ) ranked
      where rn <= 3
      order by hint_score desc nulls last, event_id, rn
      limit ${limit}
    `,
    queryParams,
  );

  return rows;
}

function buildCandidateScore(
  seedSignature: Signature,
  signature: Signature,
  hintScore: number | null,
  bonus: number,
): number {
  return Math.max(scoreSignatureSimilarity(seedSignature, signature), hintScore ?? 0) + bonus;
}

function scoreStructuredCandidates(
  rows: CandidateRow[],
  seed: SeedRow,
  seedSignature: Signature,
  seedIdentity: StructuredIdentity,
): Array<{ id: string; matchScore: number; tier: MatchTier }> {
  const candidates: Array<{ id: string; matchScore: number; tier: MatchTier }> = [];

  for (const row of rows) {
    if (row.event_id === seed.event_id) continue;
    const signature = buildSignature({
      eventTitle: row.event_title,
      marketTitle: row.market_title,
      eventCategory: row.event_category,
      marketCategory: row.market_category,
      dates: [row.end_date, row.expiration_time, row.close_time],
    });
    if (!isSignatureCompatible(seedSignature, signature)) continue;

    const candidateIdentity = buildStructuredIdentity({
      eventTitle: row.event_title,
      marketTitle: row.market_title,
      eventSlug: row.event_slug,
      marketSlug: row.market_slug,
      seriesKey: row.series_key,
      seriesTitle: row.series_title,
    });

    let structuredHits = 0;
    if (seedIdentity.seriesKey && candidateIdentity.seriesKey === seedIdentity.seriesKey) {
      structuredHits += 2;
    }
    if (
      seedIdentity.seriesTitleKey &&
      candidateIdentity.seriesTitleKey === seedIdentity.seriesTitleKey
    ) {
      structuredHits += 1;
    }
    if (seedIdentity.eventSlugKey && candidateIdentity.eventSlugKey === seedIdentity.eventSlugKey) {
      structuredHits += 2;
    }
    if (seedIdentity.marketSlugKey && candidateIdentity.marketSlugKey === seedIdentity.marketSlugKey) {
      structuredHits += 2;
    }
    if (
      seedIdentity.eventTitleKey &&
      candidateIdentity.eventTitleKey === seedIdentity.eventTitleKey
    ) {
      structuredHits += 1;
    }
    if (
      seedIdentity.marketTitleKey &&
      candidateIdentity.marketTitleKey === seedIdentity.marketTitleKey
    ) {
      structuredHits += 1;
    }
    if (structuredHits === 0) continue;

    const bonus = Math.min(0.4, structuredHits * 0.08);
    candidates.push({
      id: row.id,
      matchScore: buildCandidateScore(seedSignature, signature, row.hint_score, bonus),
      tier: "structuredExact",
    });
  }

  return candidates;
}

function scoreLexicalCandidates(
  rows: CandidateRow[],
  seed: SeedRow,
  seedSignature: Signature,
): Array<{ id: string; matchScore: number; tier: MatchTier }> {
  const exactTitleKeys = Array.from(
    new Set(
      [normalizeTitleKey(seed.event_title), normalizeTitleKey(seed.market_title)].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );
  const anchorTokens = selectSearchAnchorTokens(seedSignature);
  const candidates: Array<{ id: string; matchScore: number; tier: MatchTier }> = [];

  for (const row of rows) {
    if (row.event_id === seed.event_id) continue;
    const signature = buildSignature({
      eventTitle: row.event_title,
      marketTitle: row.market_title,
      eventCategory: row.event_category,
      marketCategory: row.market_category,
      dates: [row.end_date, row.expiration_time, row.close_time],
    });
    if (!isSignatureCompatible(seedSignature, signature)) continue;

    const normalizedEventKey = normalizeTitleKey(row.event_title);
    const normalizedMarketKey = normalizeTitleKey(row.market_title);
    const exactTitleMatch =
      (normalizedEventKey != null && exactTitleKeys.includes(normalizedEventKey)) ||
      (normalizedMarketKey != null && exactTitleKeys.includes(normalizedMarketKey));

    const candidateTokens = new Set<string>([
      ...signature.tokens,
      ...signature.entityTokens,
      ...signature.subjectTokens,
    ]);
    const anchorHits = anchorTokens.filter((token) => candidateTokens.has(token)).length;
    if (!exactTitleMatch && anchorTokens.length >= 2 && anchorHits < 2) continue;

    let bonus = Math.min(0.24, Math.max(0, row.hint_score ?? 0) * 0.25);
    if (exactTitleMatch) bonus += 0.18;
    else if (anchorHits >= 2) bonus += 0.1;
    else if (anchorHits === 1) bonus += 0.03;

    candidates.push({
      id: row.id,
      matchScore: buildCandidateScore(seedSignature, signature, row.hint_score, bonus),
      tier: "lexicalExact",
    });
  }

  return candidates;
}

async function fetchStructuredCandidateMarkets(
  seed: SeedRow,
  seedSignature: Signature,
): Promise<Array<{ id: string; matchScore: number; tier: MatchTier }>> {
  const seedIdentity = buildStructuredIdentity({
    eventTitle: seed.event_title,
    marketTitle: seed.market_title,
    eventSlug: seed.event_slug,
    marketSlug: seed.market_slug,
    seriesKey: seed.series_key,
    seriesTitle: seed.series_title,
  });

  const normalizedEventExpr =
    "regexp_replace(lower(coalesce(e.title, '')), '[^a-z0-9]+', '', 'g')";
  const normalizedMarketExpr =
    "regexp_replace(lower(coalesce(m.title, '')), '[^a-z0-9]+', '', 'g')";
  const normalizedEventSlugExpr =
    "regexp_replace(lower(coalesce(e.slug, '')), '[^a-z0-9]+', '', 'g')";
  const normalizedMarketSlugExpr =
    "regexp_replace(lower(coalesce(m.slug, '')), '[^a-z0-9]+', '', 'g')";
  const normalizedSeriesTitleExpr =
    "regexp_replace(lower(coalesce(e.series_title, '')), '[^a-z0-9]+', '', 'g')";

  const params: unknown[] = [];
  const clauses: string[] = [];
  const scoreParts: string[] = [];

  if (seedIdentity.seriesKey) {
    params.push(seedIdentity.seriesKey);
    const idx = params.length + 1;
    clauses.push(`coalesce(lower(e.series_key), '') = $${idx}`);
    scoreParts.push(`case when coalesce(lower(e.series_key), '') = $${idx} then 1.2 else 0 end`);
  }
  if (seedIdentity.seriesTitleKey) {
    params.push(seedIdentity.seriesTitleKey);
    const idx = params.length + 1;
    clauses.push(`${normalizedSeriesTitleExpr} = $${idx}`);
    scoreParts.push(`case when ${normalizedSeriesTitleExpr} = $${idx} then 0.95 else 0 end`);
  }
  if (seedIdentity.eventSlugKey) {
    params.push(seedIdentity.eventSlugKey);
    const idx = params.length + 1;
    clauses.push(`${normalizedEventSlugExpr} = $${idx}`);
    scoreParts.push(`case when ${normalizedEventSlugExpr} = $${idx} then 1.1 else 0 end`);
  }
  if (seedIdentity.marketSlugKey) {
    params.push(seedIdentity.marketSlugKey);
    const idx = params.length + 1;
    clauses.push(`${normalizedMarketSlugExpr} = $${idx}`);
    scoreParts.push(`case when ${normalizedMarketSlugExpr} = $${idx} then 1.05 else 0 end`);
  }
  if (seedIdentity.eventTitleKey) {
    params.push(seedIdentity.eventTitleKey);
    const idx = params.length + 1;
    clauses.push(`${normalizedEventExpr} = $${idx}`);
    scoreParts.push(`case when ${normalizedEventExpr} = $${idx} then 0.85 else 0 end`);
  }
  if (seedIdentity.marketTitleKey) {
    params.push(seedIdentity.marketTitleKey);
    const idx = params.length + 1;
    clauses.push(`${normalizedMarketExpr} = $${idx}`);
    scoreParts.push(`case when ${normalizedMarketExpr} = $${idx} then 0.8 else 0 end`);
  }

  if (clauses.length === 0 || scoreParts.length === 0) return [];

  const rows = await fetchCandidateRows(
    seed,
    clauses.join(" or "),
    params,
    scoreParts.join(" + "),
    80,
  );
  return scoreStructuredCandidates(rows, seed, seedSignature, seedIdentity)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, Math.max(12, aiClustersPolicy.analysisMinVenueCount * 8));
}

async function fetchLexicalCandidateMarkets(
  seed: SeedRow,
  seedSignature: Signature,
): Promise<Array<{ id: string; matchScore: number; tier: MatchTier }>> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const similarityTerms: string[] = [];

  if (seed.event_title?.trim()) {
    params.push(seed.event_title.trim());
    const idx = params.length + 1;
    clauses.push(`coalesce(e.title, '') % $${idx}`);
    similarityTerms.push(`similarity(coalesce(e.title, ''), $${idx})`);
  }
  if (seed.market_title?.trim()) {
    params.push(seed.market_title.trim());
    const idx = params.length + 1;
    clauses.push(`coalesce(m.title, '') % $${idx}`);
    similarityTerms.push(`similarity(coalesce(m.title, ''), $${idx})`);
  }
  if (seed.event_slug?.trim()) {
    params.push(seed.event_slug.trim());
    const idx = params.length + 1;
    clauses.push(`coalesce(e.slug, '') % $${idx}`);
    similarityTerms.push(`similarity(coalesce(e.slug, ''), $${idx})`);
  }
  if (seed.market_slug?.trim()) {
    params.push(seed.market_slug.trim());
    const idx = params.length + 1;
    clauses.push(`coalesce(m.slug, '') % $${idx}`);
    similarityTerms.push(`similarity(coalesce(m.slug, ''), $${idx})`);
  }
  if (seed.series_title?.trim()) {
    params.push(seed.series_title.trim());
    const idx = params.length + 1;
    clauses.push(`coalesce(e.series_title, '') % $${idx}`);
    similarityTerms.push(`similarity(coalesce(e.series_title, ''), $${idx})`);
  }

  if (clauses.length === 0 || similarityTerms.length === 0) return [];

  const rows = await fetchCandidateRows(
    seed,
    clauses.join(" or "),
    params,
    `greatest(${similarityTerms.join(", ")})`,
    80,
  );
  return scoreLexicalCandidates(rows, seed, seedSignature)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, Math.max(12, aiClustersPolicy.analysisMinVenueCount * 8));
}

async function fetchExactCandidateMarkets(
  seed: SeedRow,
  seedSignature: Signature,
): Promise<Array<{ id: string; matchScore: number; tier: MatchTier }>> {
  const [structured, lexical] = await Promise.all([
    fetchStructuredCandidateMarkets(seed, seedSignature),
    fetchLexicalCandidateMarkets(seed, seedSignature),
  ]);

  const best = new Map<string, { id: string; matchScore: number; tier: MatchTier }>();
  for (const candidate of [...structured, ...lexical]) {
    const existing = best.get(candidate.id);
    if (!existing || candidate.matchScore > existing.matchScore) {
      best.set(candidate.id, candidate);
    }
  }

  return Array.from(best.values())
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, Math.max(12, aiClustersPolicy.analysisMinVenueCount * 8));
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

function scoreMarketSummary(summary: ClusterMarketSummary): number {
  return (
    (summary.volume24h ?? 0) * 2 +
    (summary.liquidity ?? 0) +
    (summary.openInterest ?? 0) +
    (summary.volumeTotal ?? 0) * 0.2
  );
}

function computeClusterQuality(
  seedSignature: Signature,
  summaries: ClusterMarketSummary[],
): number | null {
  const qualityScores = summaries.map((summary) =>
    scoreSignatureSimilarity(
      seedSignature,
      buildSignature({
        eventTitle: summary.eventTitle,
        marketTitle: summary.marketTitle,
        eventCategory: null,
        marketCategory: null,
        dates: [summary.expiresAt],
      }),
    ),
  );
  if (qualityScores.length === 0) return null;
  const mean =
    qualityScores.reduce((sum, value) => sum + value, 0) / qualityScores.length;
  const min = Math.min(...qualityScores);
  return mean * 0.7 + min * 0.3;
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function buildMatchDiagnostics(
  seedSignature: Signature,
  matchDetails: ClusterMatchDetail[],
  prePruneOutlierRatio: number | null = null,
): ClusterMatchDiagnostics {
  const details = matchDetails.filter((detail) => detail.tier !== "seed");
  const scores = details.map((detail) => detail.score).filter(Number.isFinite);
  const matchTierCounts: Record<MatchTier, number> = {
    seed: 0,
    structuredExact: 0,
    lexicalExact: 0,
    marketEmbedding: 0,
  };
  for (const detail of matchDetails) {
    matchTierCounts[detail.tier] += 1;
  }
  const exactCount =
    matchTierCounts.structuredExact + matchTierCounts.lexicalExact;

  return {
    family: seedSignature.family,
    category: seedSignature.category,
    matchTierCounts,
    weakestMatchScore: scores.length > 0 ? Math.min(...scores) : null,
    medianMatchScore: computeMedian(scores),
    meanMatchScore:
      scores.length > 0
        ? scores.reduce((sum, value) => sum + value, 0) / scores.length
        : null,
    exactMatchRatio:
      details.length > 0 ? exactCount / details.length : null,
    prePruneOutlierRatio,
  };
}

type ClusterAnalysis = {
  label: string;
  summary: string;
  category: string;
  outliers: string[];
  confidence: number;
  query?: string | null;
  sources?: AnalysisSource[] | null;
  model: string;
  stage: "fast" | "smart";
};

type AnalysisSource = {
  title: string;
  url: string;
  snippet?: string | null;
};

const ANALYSIS_CATEGORIES = [
  "macro",
  "politics",
  "sports",
  "crypto",
  "tech",
  "culture",
  "entertainment",
  "climate",
  "finance",
  "other",
] as const;

type AnalysisCategory = (typeof ANALYSIS_CATEGORIES)[number];

function normalizeAnalysisCategory(value: unknown): AnalysisCategory {
  if (typeof value !== "string") return "other";
  const trimmed = value.trim().toLowerCase();
  return ANALYSIS_CATEGORIES.includes(trimmed as AnalysisCategory)
    ? (trimmed as AnalysisCategory)
    : "other";
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

function normalizeOutliers(
  value: unknown,
  validIds: Set<string>,
): string[] {
  if (!Array.isArray(value)) return [];
  const items = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0 && validIds.has(entry));
  return Array.from(new Set(items));
}

function safeJsonParse<T>(raw: string): T | null {
  const attempt = (text: string) => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  };

  const trimmed = raw.trim();
  const direct = attempt(trimmed);
  if (direct) return direct;

  const withoutFence = trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const fenced = attempt(withoutFence);
  if (fenced) return fenced;

  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const sliced = withoutFence.slice(start, end + 1);
    return attempt(sliced);
  }
  return null;
}

function truncateSummary(text: string, maxLen: number): string {
  const normalized = text
    .trim()
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
  if (normalized.length <= maxLen) return normalized;
  const flat = normalized.replace(/\n/g, " ");
  const slice = flat.slice(0, maxLen);
  const lastStop = Math.max(
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
  );
  if (lastStop > Math.floor(maxLen * 0.6)) {
    return slice.slice(0, lastStop + 1).trim();
  }
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > 0) return slice.slice(0, lastSpace).trim();
  return slice.trim();
}

function truncateInputText(text: string | null | undefined, maxLen: number): string | null {
  if (!text) return null;
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= maxLen) return trimmed;
  const slice = trimmed.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  return lastSpace > 0 ? slice.slice(0, lastSpace).trim() : slice.trim();
}

function sanitizeDescription(text: string | null | undefined): string | null {
  if (!text) return null;
  let cleaned = text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  cleaned = cleaned.replace(/https?:\/\/\S+/gi, "").trim();
  if (!cleaned) return null;

  const clauseMatch = cleaned.match(
    /(?:resolve(?:s)?(?:\s+to)?|resolves)\s+["'\u201c\u201d\u2018\u2019]?yes["'\u201c\u201d\u2018\u2019]?\s+if\s+(.+?)(?:\.|\bOtherwise\b|\bThe resolution source\b|$)/i,
  );
  if (clauseMatch?.[1]) {
    const clause = clauseMatch[1].trim();
    return clause.length > 0 ? clause : null;
  }

  cleaned = cleaned
    .replace(/\bOtherwise,?\s+this market will resolve to.*$/i, "")
    .replace(/\bThis market will remain open.*$/i, "")
    .replace(/\bThe (primary )?resolution source.*$/i, "")
    .replace(/\bThe market will resolve.*$/i, "")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

function buildOutlierSafeQuery(
  label: string,
  markets: AnalysisMarketInput[],
  outliers: string[],
  maxTitles = 2,
  maxLen = 160,
): string | null {
  const outlierSet = new Set(outliers);
  const parts: string[] = [];
  const seen = new Set<string>();

  const addPart = (value: string) => {
    const cleaned = value.trim().replace(/\s+/g, " ");
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(cleaned);
  };

  if (label && hasAlpha(label)) {
    addPart(label);
  }

  let titleCount = 0;
  for (const market of markets) {
    if (outlierSet.has(market.marketId)) continue;
    const title = market.eventTitle ?? market.marketTitle;
    if (!title || !hasAlpha(title)) continue;
    addPart(title);
    titleCount += 1;
    if (titleCount >= maxTitles) break;
  }

  if (parts.length === 0) return null;
  const query = parts.join(" ");
  return truncateInputText(query, maxLen);
}

function buildAnalysisInputFromMarkets(
  cluster: ClusterRecord,
  markets: ClusterMarketSummary[],
): AnalysisInput {
  const metrics = computeClusterMetrics(markets);
  const analysisMarkets = markets.map((market) => ({
    marketId: market.marketId,
    venue: market.venue,
    eventTitle: market.eventTitle ?? null,
    marketTitle: market.marketTitle ?? null,
    eventDescription: truncateInputText(
      sanitizeDescription(market.eventDescription),
      240,
    ),
    marketDescription: truncateInputText(
      sanitizeDescription(market.marketDescription),
      240,
    ),
    yesMid: market.yesMid ?? market.yesBid ?? market.yesAsk ?? null,
    liquidity: market.liquidity ?? market.openInterest ?? null,
    volume24h: market.volume24h ?? null,
    expiresAt: market.expiresAt ?? null,
  }));

  return {
    clusterId: cluster.id,
    label: cluster.label,
    priceSpread: metrics.priceSpread,
    minLiquidity: metrics.minLiquidity,
    volume24h: metrics.volume24h,
    expiresAt: metrics.expiresAt,
    venueCounts: metrics.venueCounts,
    marketCount: analysisMarkets.length,
    markets: analysisMarkets,
  };
}

function buildAnalysisInput(cluster: ClusterRecord): AnalysisInput {
  return buildAnalysisInputFromMarkets(cluster, cluster.marketsPreview);
}

async function fetchMarketSummariesByIds(
  marketIds: string[],
): Promise<ClusterMarketSummary[]> {
  if (marketIds.length === 0) return [];

  const { rows } = await pool.query<ClusterMarketRow>(
    `
      select
        m.id,
        m.event_id,
        m.venue,
        m.title,
        m.description,
        m.slug,
        m.image,
        m.icon,
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
        e.description as event_description,
        e.slug as event_slug,
        e.image as event_image,
        e.icon as event_icon
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

  return marketIds
    .map((marketId) => byId.get(marketId))
    .filter((row): row is ClusterMarketSummary => Boolean(row));
}

function rebuildClusterRecord(
  cluster: ClusterRecord,
  summaries: ClusterMarketSummary[],
): ClusterRecord | null {
  const maxPerVenue = 2;
  const sorted = summaries
    .slice()
    .sort((a, b) => scoreMarketSummary(b) - scoreMarketSummary(a));

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

  const priced = capped.filter((summary) => summary.yesMid != null);
  if (priced.length < 2) return null;

  const metrics = computeClusterMetrics(priced);
  if (metrics.venueCount < 2) return null;
  const marketIds = priced.map((summary) => summary.marketId).sort();
  const matchDetails = cluster.matchDetails.filter((detail) =>
    marketIds.includes(detail.marketId),
  );
  const matchDiagnostics = buildMatchDiagnostics(
    cluster.seedSignature,
    matchDetails,
    cluster.matchDiagnostics?.prePruneOutlierRatio ?? null,
  );

  return {
    ...cluster,
    marketIds,
    marketsPreview: priced.slice().sort((a, b) => scoreMarketSummary(b) - scoreMarketSummary(a)).slice(0, 6),
    marketCount: priced.length,
    venueCounts: metrics.venueCounts,
    venueCount: metrics.venueCount,
    priceSpread: metrics.priceSpread,
    minLiquidity: metrics.minLiquidity,
    totalLiquidity: metrics.totalLiquidity,
    volume24h: metrics.volume24h,
    expiresAt: metrics.expiresAt,
    score: scoreCluster(metrics),
    qualityScore: computeClusterQuality(cluster.seedSignature, priced),
    matchDetails,
    matchDiagnostics,
  };
}

async function pruneClusterOutliers(
  cluster: ClusterRecord,
  analysis: ClusterAnalysis,
): Promise<ClusterRecord | null> {
  if (!analysis.outliers || analysis.outliers.length === 0) return cluster;
  const outlierRatio =
    cluster.marketIds.length > 0
      ? analysis.outliers.length / cluster.marketIds.length
      : null;
  const outlierSet = new Set(analysis.outliers);
  const remainingIds = cluster.marketIds.filter((marketId) => !outlierSet.has(marketId));
  if (remainingIds.length < 2) return null;
  const summaries = await fetchMarketSummariesByIds(remainingIds);
  if (summaries.length < 2) return null;
  const rebuilt = rebuildClusterRecord(cluster, summaries);
  if (!rebuilt) return null;
  rebuilt.matchDiagnostics = buildMatchDiagnostics(
    rebuilt.seedSignature,
    rebuilt.matchDetails,
    outlierRatio,
  );
  return rebuilt;
}

async function callOpenRouter(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  maxTokens: number,
  responseFormat?: { type: "json_object" },
): Promise<string> {
  if (!env.openRouterKey) {
    throw new Error("OPENROUTER_API_KEY missing");
  }

  if (aiClustersPolicy.debugLogs) {
    const system = messages.find((message) => message.role === "system");
    const user = messages.find((message) => message.role === "user");
    console.info("[cluster] openrouter request", {
      model,
      maxTokens,
      system: system?.content.slice(0, 800),
      user: user?.content.slice(0, 2000),
    });
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openRouterKey}`,
      "Content-Type": "application/json",
      "X-Title": "Hunch Cluster Analysis",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      reasoning: { effort: "low" },
      response_format: responseFormat,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  if (aiClustersPolicy.debugLogs) {
    console.info("[cluster] openrouter response", {
      model,
      payload: JSON.stringify(payload).slice(0, 2000),
    });
  }
  const content = payload.choices?.[0]?.message?.content;

  const unwrapText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "value" in value) {
      const inner = (value as { value?: unknown }).value;
      return typeof inner === "string" ? inner : "";
    }
    return "";
  };
  const extractPart = (part: unknown): string => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if ("text" in part) {
      return unwrapText((part as { text?: unknown }).text);
    }
    if ("content" in part) {
      return unwrapText((part as { content?: unknown }).content);
    }
    if ("refusal" in part) {
      const refusal = (part as { refusal?: unknown }).refusal;
      return typeof refusal === "string" ? refusal : "";
    }
    return "";
  };

  if (typeof content === "string") {
    if (aiClustersPolicy.debugLogs && content.trim().length === 0) {
      console.warn("[cluster] openrouter empty content", {
        model,
        payload: JSON.stringify(payload).slice(0, 2000),
      });
    }
    const trimmed = content.trim();
    if (trimmed.length > 0) return content;
    return "";
  }
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => extractPart(part))
      .join("");
    if (joined.trim().length > 0) return joined;
    if (aiClustersPolicy.debugLogs) {
      console.warn("[cluster] openrouter empty content", {
        model,
        payload: JSON.stringify(payload).slice(0, 2000),
      });
    }
    return "";
  }
  if (content && typeof content === "object" && "text" in content) {
    const text = (content as { text?: unknown }).text;
    const unwrapped = unwrapText(text);
    if (unwrapped) return unwrapped;
    return "";
  }
  if (aiClustersPolicy.debugLogs) {
    console.warn("[cluster] openrouter response missing content", {
      model,
      payload: JSON.stringify(payload).slice(0, 2000),
    });
  }
  return "";
}

let fastParseFailures = 0;

async function runStageAAnalysis(
  cluster: ClusterRecord,
  input: AnalysisInput,
): Promise<ClusterAnalysis | null> {
  const system =
    "You are an analyst. Return strict JSON only. No extra text.";
  const user = `Given a cluster of prediction markets, identify the shared claim.\nReturn:\n- label: a short title (max 80 chars)\n- category: one of [macro, politics, sports, crypto, tech, culture, entertainment, climate, finance, other]\n- outliers: list of marketIds that do not match the shared claim\n- confidence: 0-1\n- query: a short web search query to find context\nRules:\n- label should be short, concrete, and degen-friendly\n- if the label matches a market title exactly, shorten it\n- do not include odds or prices in the label\n- only list outliers, not inliers\n- be conservative: only list outliers when clearly unrelated\n- query must be based on the label/theme only, never outliers\n\nCluster data (JSON):\n${JSON.stringify(input)}`;

  const fallbackModel =
    aiClustersPolicy.modelFallback &&
    aiClustersPolicy.modelFallback !== aiClustersPolicy.modelFast
      ? aiClustersPolicy.modelFallback
      : null;
  const parseRaw = (raw: string) =>
    safeJsonParse<{
      label?: unknown;
      category?: unknown;
      outliers?: unknown;
      confidence?: unknown;
      query?: unknown;
    }>(raw);

  const attempt = async (model: string) => {
    try {
      const raw = await callOpenRouter(
        model,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        800,
        { type: "json_object" },
      );
      return { raw, parsed: parseRaw(raw), model, error: null };
    } catch (error) {
      if (aiClustersPolicy.debugLogs) {
        console.warn("[cluster] fast request failed", {
          clusterId: cluster.id,
          model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        raw: "",
        parsed: null,
        model,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  let result = await attempt(aiClustersPolicy.modelFast);
  if (!result.parsed && fallbackModel) {
    if (aiClustersPolicy.debugLogs) {
      console.warn("[cluster] fast fallback", {
        clusterId: cluster.id,
        model: aiClustersPolicy.modelFast,
        fallbackModel,
      });
    }
    result = await attempt(fallbackModel);
  }

  if (!result.parsed) {
    const shouldLog = aiClustersPolicy.debugLogs || fastParseFailures < 3;
    if (shouldLog) {
      console.warn("[cluster] fast parse failed", {
        clusterId: cluster.id,
        model: result.model,
        sample: result.raw.slice(0, 2000),
        error: result.error ?? null,
      });
      if (aiClustersPolicy.debugLogs) {
        console.warn("[cluster] fast prompt", {
          clusterId: cluster.id,
          prompt: user.slice(0, 2000),
        });
      }
      fastParseFailures += 1;
    }
    return null;
  }

  const parsed = result.parsed;

  const validIds = new Set(cluster.marketIds);
  const label =
    typeof parsed.label === "string" && parsed.label.trim().length > 0
      ? parsed.label.trim().slice(0, 120)
      : cluster.label;
  const category = normalizeAnalysisCategory(parsed.category);
  const outliers = normalizeOutliers(parsed.outliers, validIds);
  const confidence = clampConfidence(parsed.confidence);
  const safeLabel = isTrivialLabel(label, cluster.label) ? cluster.label : label;
  const query = buildOutlierSafeQuery(safeLabel, input.markets, outliers);

  return {
    label,
    summary: "",
    category,
    outliers,
    confidence,
    query,
    model: result.model,
    stage: "fast",
  };
}

async function fetchDuckDuckGoResults(
  query: string,
  maxResults: number,
): Promise<AnalysisSource[]> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_redirect", "1");
  url.searchParams.set("no_html", "1");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`DuckDuckGo ${response.status}`);
  }
  const data = (await response.json()) as {
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{
      Text?: string;
      FirstURL?: string;
      Topics?: Array<{ Text?: string; FirstURL?: string }>;
    }>;
  };

  const results: AnalysisSource[] = [];
  if (data.AbstractURL && data.AbstractText) {
    results.push({
      title: data.AbstractText.slice(0, 120),
      url: data.AbstractURL,
      snippet: data.AbstractText.slice(0, 240),
    });
  }

  const flattenTopics = (topics: typeof data.RelatedTopics) => {
    if (!topics) return;
    for (const topic of topics) {
      if (results.length >= maxResults) return;
      if (topic.Topics) {
        flattenTopics(topic.Topics);
        continue;
      }
      if (topic.FirstURL && topic.Text) {
        results.push({
          title: topic.Text.slice(0, 120),
          url: topic.FirstURL,
          snippet: topic.Text.slice(0, 240),
        });
      }
    }
  };

  flattenTopics(data.RelatedTopics);
  return results.slice(0, maxResults);
}

async function runStageBAnalysis(
  cluster: ClusterRecord,
  input: AnalysisInput,
): Promise<ClusterAnalysis | null> {
  const system =
    "You write short spread notes for a prediction market trading product. Return strict JSON only. Write like a fast trader note: concise, comparative, easy to scan, and useful in a card UI. No hype, no filler, no academic tone.";
  const user = `Given a cluster of prediction markets, return strict JSON with:\n- label (max 80 chars)\n- summary (exactly 1 short lead sentence followed by exactly 3 bullet lines in one string:\n  Lead sentence.\n  - Key Difference: ...\n  - Why It May Be Mispriced: ...\n  - What to Watch: ...)\n- category (one of [macro, politics, sports, crypto, tech, culture, entertainment, climate, finance, other])\n- outliers (list of marketIds)\n- confidence (0-1)\nRules:\n- first identify outliers; be conservative, only clearly unrelated\n- label and summary must reflect inliers only\n- never mention outliers or their topics in the summary\n- do not include market IDs in label or summary\n- if referencing markets, use plain titles or venue names only\n- keep each summary line short\n- do not write a paragraph\n- do not repeat the same point across lines\n- do not add a Breakdown heading inside the summary\n- the first line must be a normal sentence, not a bullet\n- the next 3 lines must begin with "- "\n- the lead sentence should explain the shared theme in plain language\n- focus on comparability, structure, wording, timing, liquidity, and resolution differences\n- explain the main structural difference between them\n- explain one plausible reason the spread exists when obvious\n- explain the main thing a trader should verify before acting\n- keep it factual, no hype, no disclaimers\n- avoid generic filler and academic phrasing\n- avoid parentheses, percentages, and stat-heavy wording unless essential\nExample summary:\nBoth markets price whether the Fed cuts at the next meeting.\n- Key Difference: One resolves on the official decision, while the other uses a broader timing window.\n- Why It May Be Mispriced: Traders may be treating the contracts as equivalent despite different resolution rules.\n- What to Watch: Verify the exact resolution source and whether liquidity is deep enough on both sides.\n\nCluster data (JSON):\n${JSON.stringify(input)}`;

  const fallbackModel =
    aiClustersPolicy.modelFallback &&
    aiClustersPolicy.modelFallback !== aiClustersPolicy.modelFinal
      ? aiClustersPolicy.modelFallback
      : null;
  const parseRaw = (raw: string) =>
    safeJsonParse<{
      label?: unknown;
      summary?: unknown;
      category?: unknown;
      outliers?: unknown;
      confidence?: unknown;
    }>(raw);

  const attempt = async (model: string) => {
    try {
      const raw = await callOpenRouter(
        model,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        800,
        { type: "json_object" },
      );
      return { raw, parsed: parseRaw(raw), model, error: null };
    } catch (error) {
      if (aiClustersPolicy.debugLogs) {
        console.warn("[cluster] smart request failed", {
          clusterId: cluster.id,
          model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        raw: "",
        parsed: null,
        model,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  let result = await attempt(aiClustersPolicy.modelFinal);
  if (!result.parsed && fallbackModel) {
    if (aiClustersPolicy.debugLogs) {
      console.warn("[cluster] smart fallback", {
        clusterId: cluster.id,
        model: aiClustersPolicy.modelFinal,
        fallbackModel,
      });
    }
    result = await attempt(fallbackModel);
  }

  if (!result.parsed) {
    if (aiClustersPolicy.debugLogs) {
      console.warn("[cluster] smart parse failed", {
        clusterId: cluster.id,
        model: result.model,
        sample: result.raw.slice(0, 2000),
        error: result.error ?? null,
      });
      console.warn("[cluster] smart prompt", {
        clusterId: cluster.id,
        prompt: user.slice(0, 2000),
      });
    }
    return null;
  }

  const parsed = result.parsed;
  const validIds = new Set(cluster.marketIds);
  const label =
    typeof parsed.label === "string" && parsed.label.trim().length > 0
      ? parsed.label.trim().slice(0, 120)
      : cluster.label;
  const summary =
    typeof parsed.summary === "string" && parsed.summary.trim().length > 0
      ? truncateSummary(parsed.summary, 1200)
      : "";
  const category = normalizeAnalysisCategory(parsed.category);
  const outliers = normalizeOutliers(parsed.outliers, validIds);
  const confidence = clampConfidence(parsed.confidence);

  const outlierSet = new Set(outliers);
  const inlierMarkets = input.markets.filter(
    (market) => !outlierSet.has(market.marketId),
  );
  const safeLabel = isTrivialLabel(label, cluster.label) ? cluster.label : label;
  const query = buildOutlierSafeQuery(safeLabel, inlierMarkets, outliers);

  let sources: AnalysisSource[] | null = null;
  if (aiClustersPolicy.useWebContext && query) {
    try {
      sources = await fetchDuckDuckGoResults(
        query,
        aiClustersPolicy.webMaxResults,
      );
    } catch (error) {
      console.warn(
        "[cluster] web context fetch failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    label,
    summary,
    category,
    outliers,
    confidence,
    query,
    sources,
    model: result.model,
    stage: "smart",
  };
}

function shouldAnalyzeCluster(cluster: ClusterRecord): boolean {
  if (cluster.venueCount < aiClustersPolicy.analysisMinVenueCount) return false;
  const spread = cluster.priceSpread ?? 0;
  if (spread < aiClustersPolicy.analysisMinSpread) return false;
  const quality = cluster.qualityScore ?? 0;
  if (quality < aiClustersPolicy.analysisMinQuality) return false;
  return true;
}

function scoreStageB(cluster: ClusterRecord): number {
  const spread = cluster.priceSpread ?? 0;
  const liquidity = cluster.minLiquidity ?? 0;
  const volume = cluster.volume24h ?? 0;
  return spread * Math.log1p(liquidity + volume);
}

function shouldReuseAnalysis(
  cluster: ClusterRecord,
  existing: {
    analysis: string | null;
    analysisStatus: string | null;
    analysisUpdatedAt: string | null;
    marketIds: string | null;
    version: string | null;
  } | undefined,
): ClusterAnalysis | null {
  if (!existing?.analysis || existing.analysisStatus !== "ready") return null;
  if (!existing.analysisUpdatedAt) return null;
  if (existing.version !== CLUSTER_VERSION) return null;
  if (existing.marketIds !== JSON.stringify(cluster.marketIds)) return null;
  if (aiClustersPolicy.reanalyzeHours === 0) return null;

  const updatedAt = new Date(existing.analysisUpdatedAt);
  if (Number.isNaN(updatedAt.getTime())) return null;
  const ageMs = Date.now() - updatedAt.getTime();
  if (ageMs > aiClustersPolicy.reanalyzeHours * 3600 * 1000) return null;

  const parsed = safeJsonParse<ClusterAnalysis>(existing.analysis);
  return parsed ?? null;
}

async function applyClusterAnalysis(
  redis: RedisClientType,
  clusters: ClusterRecord[],
): Promise<void> {
  if (!aiClustersPolicy.analysisEnabled) return;
  if (!env.openRouterKey) {
    console.warn("[cluster] OPENROUTER_API_KEY missing, skipping analysis");
    return;
  }

  const candidates = clusters.filter(shouldAnalyzeCluster);
  if (candidates.length === 0) return;

  const totalCandidates = candidates.length;
  const maxStageB = Math.max(1, aiClustersPolicy.maxStageB);
  const sortedForStageB = candidates
    .slice()
    .sort((a, b) => scoreStageB(b) - scoreStageB(a));
  const smartTargets = new Set<string>(
    (candidates.length <= maxStageB
      ? candidates
      : sortedForStageB.slice(0, maxStageB)
    ).map((cluster) => cluster.id),
  );

  const pipeline = redis.multi();
  for (const cluster of candidates) {
    pipeline.hmGet(`${CLUSTER_KEY_PREFIX}${cluster.id}`, [
      "analysis",
      "analysis_status",
      "analysis_updated_at",
      "market_ids",
      "version",
    ]);
  }
  const existingRaw = (await pipeline.exec()) as unknown as Array<
    Array<string | null>
  >;
  const existingMap = new Map<
    string,
    {
      analysis: string | null;
      analysisStatus: string | null;
      analysisUpdatedAt: string | null;
      marketIds: string | null;
      version: string | null;
    }
  >();
  existingRaw.forEach((values, idx) => {
    const cluster = candidates[idx];
    existingMap.set(cluster.id, {
      analysis: values?.[0] ?? null,
      analysisStatus: values?.[1] ?? null,
      analysisUpdatedAt: values?.[2] ?? null,
      marketIds: values?.[3] ?? null,
      version: values?.[4] ?? null,
    });
  });

  const pending = candidates.filter((cluster) => {
    const reused = shouldReuseAnalysis(cluster, existingMap.get(cluster.id));
    if (!reused) return true;
    cluster.analysis = JSON.stringify(reused);
    cluster.analysisStatus = "ready";
    cluster.analysisUpdatedAt = new Date().toISOString();
    cluster.analysisConfidence = reused.confidence;
    cluster.analysisModel = reused.model;
    cluster.label = reused.label || cluster.label;
    return false;
  });

  const reusedCount = totalCandidates - pending.length;
  console.info("[cluster] analysis start", {
    candidates: totalCandidates,
    pending: pending.length,
    reused: reusedCount,
    smartTargets: smartTargets.size,
    concurrency: aiClustersPolicy.analysisConcurrency,
    reanalyzeHours: aiClustersPolicy.reanalyzeHours,
    modelFast: aiClustersPolicy.modelFast,
    modelSmart: aiClustersPolicy.modelFinal,
    webContext: aiClustersPolicy.useWebContext,
  });

  if (pending.length === 0) return;

  const concurrency = Math.max(1, aiClustersPolicy.analysisConcurrency);
  const totalPending = pending.length;
  const startedAt = Date.now();
  let processed = 0;
  let fastCount = 0;
  let smartCount = 0;
  let failedCount = 0;
  let filteredCount = 0;
  const logProgress = (force = false) => {
    if (!force && processed % 10 !== 0 && processed !== totalPending) return;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    console.info("[cluster] analysis progress", {
      processed,
      total: totalPending,
      fast: fastCount,
      smart: smartCount,
      failed: failedCount,
      filtered: filteredCount,
      elapsedSec,
    });
  };

  const queue = pending.slice();
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const cluster = queue.shift();
      if (!cluster) return;

      try {
        const input = buildAnalysisInput(cluster);
        let analysis: ClusterAnalysis | null = null;

        if (smartTargets.has(cluster.id)) {
          const stageB = await runStageBAnalysis(cluster, input);
          if (stageB) {
            analysis = stageB;
            smartCount += 1;
          }
        }

        if (!analysis) {
          const stageA = await runStageAAnalysis(cluster, input);
          if (!stageA) {
            cluster.analysisStatus = "failed";
            cluster.analysisUpdatedAt = new Date().toISOString();
            failedCount += 1;
            processed += 1;
            logProgress();
            continue;
          }
          analysis = stageA;
          fastCount += 1;
        }

        const outlierRatio =
          cluster.marketCount > 0
            ? (analysis.outliers?.length ?? 0) / cluster.marketCount
            : 0;
        cluster.matchDiagnostics = buildMatchDiagnostics(
          cluster.seedSignature,
          cluster.matchDetails,
          outlierRatio,
        );
        const passesConfidence =
          analysis.confidence >= aiClustersPolicy.minConfidence;

        cluster.analysis = JSON.stringify(analysis);
        cluster.analysisUpdatedAt = new Date().toISOString();
        cluster.analysisConfidence = analysis.confidence;
        cluster.analysisModel = analysis.model;
        if (!passesConfidence) {
          cluster.analysisStatus = "filtered";
          filteredCount += 1;
          processed += 1;
          logProgress();
          continue;
        }

        const pruned = await pruneClusterOutliers(cluster, analysis);
        if (!pruned) {
          cluster.analysisStatus = "filtered";
          filteredCount += 1;
          processed += 1;
          logProgress();
          continue;
        }

        Object.assign(cluster, pruned);
        analysis.outliers = analysis.outliers.filter((marketId) =>
          cluster.marketIds.includes(marketId),
        );
        cluster.analysis = JSON.stringify(analysis);
        cluster.analysisStatus = "ready";
        cluster.label = analysis.label || cluster.label;
        processed += 1;
        logProgress();
      } catch (error) {
        console.warn(
          "[cluster] analysis failed",
          error instanceof Error ? error.message : String(error),
        );
        cluster.analysisStatus = "failed";
        cluster.analysisUpdatedAt = new Date().toISOString();
        failedCount += 1;
        processed += 1;
        logProgress();
      }
    }
  });

  await Promise.all(workers);
  logProgress(true);
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

    const exactCandidates = await fetchExactCandidateMarkets(seed, seedSignature);
    const neighbors = await fetchMarketNeighbors(redis, embedding, options);
    const exactScoreById = new Map(
      exactCandidates.map((candidate) => [candidate.id, candidate.matchScore]),
    );
    const exactTierById = new Map(
      exactCandidates.map((candidate) => [candidate.id, candidate.tier]),
    );
    const neighborScoreById = new Map(
      neighbors
        .filter((neighbor) => neighbor.score <= options.maxDistance)
        .map((neighbor) => [neighbor.id, neighbor.score]),
    );
    const candidateIds = Array.from(
      new Set(
        neighbors
          .filter((neighbor) => neighbor.score <= options.maxDistance)
          .map((neighbor) => neighbor.id)
          .concat(exactCandidates.map((candidate) => candidate.id))
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
          m.slug as market_slug,
          e.slug as event_slug,
          m.category as market_category,
          e.category as event_category,
          e.series_key,
          e.series_title,
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
      { matchScore: number; eventId: string; marketId: string; tier: MatchTier }
    >();

    for (const candidateId of candidateIds) {
      const meta = metaById.get(candidateId);
      if (!meta) continue;
      if (meta.event_id === seed.event_id) continue;
      if (
        seed.market_type &&
        meta.market_type &&
        meta.market_type !== seed.market_type
      )
        continue;

      const signature = signatureById.get(candidateId);
      if (!signature) continue;
      if (!isSignatureCompatible(seedSignature, signature)) continue;

      const embedScore = neighborScoreById.get(candidateId);
      const exactScore = exactScoreById.get(candidateId);
      const embedMatchScore =
        embedScore != null
          ? scoreSignatureMatch(seedSignature, signature, embedScore)
          : null;
      const matchScore =
        exactScore != null
          ? Math.max(
              exactScore,
              embedMatchScore ?? scoreSignatureSimilarity(seedSignature, signature),
            )
          : embedMatchScore != null
            ? embedMatchScore
            : scoreSignatureSimilarity(seedSignature, signature);
      const tier: MatchTier =
        exactScore != null && exactScore >= (embedMatchScore ?? Number.NEGATIVE_INFINITY)
          ? (exactTierById.get(candidateId) ?? "structuredExact")
          : "marketEmbedding";
      const existing = bestByEvent.get(meta.event_id);
      if (!existing || matchScore > existing.matchScore) {
        bestByEvent.set(meta.event_id, {
          matchScore,
          eventId: meta.event_id,
          marketId: candidateId,
          tier,
        });
      }
    }

    const eventIds = new Set<string>([seed.event_id]);
    const matchedMarketsByEvent = new Map<string, ClusterMatchDetail>([
      [seed.event_id, { marketId: seed.id, score: 1, tier: "seed" }],
    ]);
    const ranked = Array.from(bestByEvent.values())
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, options.neighborLimit);

    for (const entry of ranked) {
      eventIds.add(entry.eventId);
      matchedMarketsByEvent.set(entry.eventId, {
        marketId: entry.marketId,
        score: entry.matchScore,
        tier: entry.tier,
      });
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
      matchedMarketsByEvent,
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
        matchedMarketsByEvent: new Map(clusters[i].matchedMarketsByEvent),
      });
      continue;
    }
    for (const id of clusters[i].eventIds) current.eventIds.add(id);
    for (const [eventId, match] of clusters[i].matchedMarketsByEvent) {
      const existing = current.matchedMarketsByEvent.get(eventId);
      if (!existing || match.score > existing.score) {
        current.matchedMarketsByEvent.set(eventId, match);
      }
    }
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

  const allMarketIds = new Set<string>();
  for (const cluster of merged.values()) {
    for (const match of cluster.matchedMarketsByEvent.values()) {
      allMarketIds.add(match.marketId);
    }
  }

  const marketMeta = await fetchMarketsByIds(Array.from(allMarketIds));
  const marketScoreById = new Map<string, number>();
  for (const meta of marketMeta.values()) {
    marketScoreById.set(meta.id, scoreMarket(meta));
  }

  const results: ClusterRecord[] = [];
  const maxPerVenue = 2;
  for (const cluster of merged.values()) {
    const summaries = Array.from(cluster.matchedMarketsByEvent.values())
      .map((match) => marketMeta.get(match.marketId))
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

    const score = scoreCluster(metrics);
    const marketIds = priced.map((summary) => summary.marketId).sort();
    const matchDetails = Array.from(cluster.matchedMarketsByEvent.values()).filter((detail) =>
      marketIds.includes(detail.marketId),
    );
    const marketsPreview = priced
      .slice()
      .sort((a, b) => {
        const scoreA = marketScoreById.get(a.marketId) ?? 0;
        const scoreB = marketScoreById.get(b.marketId) ?? 0;
        return scoreB - scoreA;
      })
      .slice(0, 6);

    const qualityScore = computeClusterQuality(cluster.seedSignature, priced);
    const matchDiagnostics = buildMatchDiagnostics(
      cluster.seedSignature,
      matchDetails,
    );

    const record: ClusterRecord = {
      id: buildClusterId(Array.from(cluster.eventIds).sort()),
      label: resolveClusterLabel(
        marketsPreview,
        cluster.seedEventTitle ?? cluster.seedMarketTitle,
      ),
      score,
      seedMarketId: cluster.seedMarketId,
      seedSignature: cluster.seedSignature,
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
      analysisConfidence: null,
      analysisModel: null,
      qualityScore,
      matchDetails,
      matchDiagnostics,
    };

    results.push(record);
  }

  results.sort((a, b) => b.score - a.score);
  const maxClusters = Math.max(1, aiClustersPolicy.maxClustersPerRun);
  return results.slice(0, maxClusters);
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
      analysis_confidence:
        cluster.analysisConfidence != null
          ? String(cluster.analysisConfidence)
          : "",
      analysis_model: cluster.analysisModel ?? "",
      quality_score:
        cluster.qualityScore != null ? String(cluster.qualityScore) : "",
      match_details: JSON.stringify(cluster.matchDetails),
      match_diagnostics: JSON.stringify(cluster.matchDiagnostics),
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
  const policy = await resolveAiClustersPolicy(pool);
  aiClustersPolicy = policy.effective;

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
      if (!options.noAnalysis) {
        await applyClusterAnalysis(redis, clusters);
      }
      await storeClusters(redis, clusters, options);
      console.log("[cluster] stored", { count: clusters.length });
    }
  } finally {
    await redis.quit();
    await pool.end();
  }
}

const directRunArg = process.argv[1];
const isDirectRun =
  typeof directRunArg === "string" &&
  import.meta.url === pathToFileURL(directRunArg).href;

if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("[cluster] failed", error);
      process.exit(1);
    });
}
