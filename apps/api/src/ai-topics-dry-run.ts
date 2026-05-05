import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pool } from "./db.js";

const QA_CONTRACT_VERSION = "qa_contract_v1";

type Category = "crypto" | "politics" | "sports" | "other";

type EntityType = "ticker" | "match" | "person" | "country" | "keyword";

type EntityArchetype =
  | "generic"
  | "head_to_head"
  | "candidate_list"
  | "competition_winner";

type Constraint =
  | {
      kind: "threshold";
      operator: ">=" | "<=" | "=";
      value: number;
      unit: "usd" | "points" | "percent" | "raw";
      raw: string;
    }
  | {
      kind: "range";
      min: number;
      max: number;
      unit: "usd" | "points" | "percent" | "raw";
      raw: string;
    }
  | {
      kind: "ou";
      operator: ">=" | "<=" | "=";
      value: number;
      unit: "points";
      raw: string;
    }
  | {
      kind: "spread";
      operator: "=";
      value: number;
      unit: "points";
      raw: string;
    }
  | {
      kind: "none";
    };

type MarketRow = {
  market_id: string;
  event_id: string;
  venue: string;
  market_title: string | null;
  event_title: string | null;
  event_status: string | null;
  market_category: string | null;
  event_category: string | null;
  market_open_time: Date | string | null;
  market_expiration_time: Date | string | null;
  market_close_time: Date | string | null;
  market_updated_at: Date | string | null;
  event_end_date: Date | string | null;
  event_start_date: Date | string | null;
};

type TopicAggregate = {
  topicKey: string;
  category: Category;
  entityType: EntityType;
  entity: string;
  archetype: EntityArchetype;
  entitySource: "event" | "market" | "combined" | "derived";
  unknownReason: string | null;
  constraint: Constraint;
  constraintHash: string;
  timeBucket: string;
  venues: Set<string>;
  marketIds: Set<string>;
  eventIds: Set<string>;
  sampleEventId: string;
  sampleMarketId: string;
  sampleVenue: string;
  sampleEventTitle: string | null;
  sampleMarketTitle: string | null;
  sampleEventStatus: string | null;
  sampleEventEndDate: Date | string | null;
  sampleMarketUpdatedAt: Date | string | null;
  candidateEntities: Set<string>;
  sourceTopicKeys: Set<string>;
};

type TopicSummaryRow = {
  topicKey: string;
  category: Category;
  entityType: EntityType;
  entity: string;
  archetype: EntityArchetype;
  entitySource: "event" | "market" | "combined" | "derived";
  unknownReason: string | null;
  constraint: Constraint;
  constraintHash: string;
  timeBucket: string;
  marketCount: number;
  eventCount: number;
  venueCount: number;
  venues: string[];
  sampleEventId: string;
  sampleMarketId: string;
  sampleVenue: string;
  sampleEventTitle: string | null;
  sampleMarketTitle: string | null;
  sampleEventStatus: string | null;
  sampleEventEndDate: Date | string | null;
  sampleMarketUpdatedAt: Date | string | null;
  candidateEntities: string[];
  sourceTopicKeys: string[];
  searchIntentKey?: string;
  constraintClass?: string;
};

type Args = {
  launchProfile:
    | "custom"
    | "top50_per_venue"
    | "top100_per_venue"
    | "stress500_global";
  limit: number;
  venues: string[];
  categories: Category[];
  searchCategories: Category[];
  minVolume24h: number;
  minLiquidity: number;
  maxSpread: number | null;
  requireOpenNow: boolean;
  orderBy: "trending" | "updated" | "random";
  sampling: "per-venue" | "global";
  perVenueQuota: number | null;
  showTop: number;
  showQueries: number;
  includeUnknownTopics: boolean;
  unknownMinMarketCount: number;
  searchMinMarketCount: number;
  maxMarketAgeHours: number;
  sportsKeywordMinMarketCount: number;
  cacheHitRate: number;
  tieringMode: "threshold" | "score";
  tierAMarketThreshold: number;
  tierBMarketThreshold: number;
  tierScoreAFraction: number;
  tierScoreBFraction: number;
  tierScoreAMin: number;
  tierScoreBMin: number;
  tierACadenceMinutes: number;
  tierBCadenceMinutes: number;
  tierCCadenceMinutes: number;
  tierACombinedCount: number;
  tierBCombinedCount: number;
  tierCCombinedCount: number;
  tierAWebCount: number;
  tierAXCount: number;
  tierBWebCount: number;
  tierBXCount: number;
  tierBMode: "normal" | "shed";
  tierCWebCount: number;
  tierCXCount: number;
  tierCEnabled: boolean;
  tierAutoPromoteA: boolean;
  tierAutoPromoteB: boolean;
  tierAutoPromoteBMinTopics: number;
  tierAutoPromoteBMinMarketCount: number;
  tierAutoPromoteAMinMarketCount: number;
  tierALookbackHours: number;
  tierBLookbackHours: number;
  tierCLookbackHours: number;
  webExcludedDomains: string[];
  xExcludedHandles: string[];
  maxSearchTopics: number;
  strictInvariants: boolean;
  emitDemotionPreview: boolean;
  json: boolean;
  out: string | null;
  help: boolean;
};

type TierAssignment = {
  tiers: Map<string, "A" | "B" | "C">;
  scores: Map<string, number>;
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
  "will",
  "what",
  "when",
  "where",
  "who",
  "how",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "vs",
  "v",
  "up",
  "down",
  "reach",
  "hit",
  "dip",
  "above",
  "below",
  "over",
  "under",
  "price",
  "before",
  "after",
  "what",
  "will",
]);

const MONTH_TOKENS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

const DAY_TOKENS = new Set([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "mon",
  "tue",
  "tues",
  "wed",
  "thu",
  "thur",
  "fri",
  "sat",
  "sun",
]);

const TEMPORAL_TOKENS = new Set([
  "before",
  "after",
  "by",
  "until",
  "during",
  "between",
  "within",
  "next",
  "this",
  "last",
  "today",
  "tomorrow",
  "yesterday",
]);

const GENERIC_TOKENS = new Set([
  "market",
  "markets",
  "event",
  "events",
  "series",
  "match",
  "matchup",
  "game",
  "games",
  "more",
  "next",
  "today",
  "tonight",
  "tomorrow",
  "yesterday",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "season",
  "seasons",
  "live",
  "now",
  "new",
  "latest",
  "yes",
  "no",
  "winner",
  "win",
  "lose",
  "loser",
  "draw",
  "tie",
  "final",
  "price",
  "prices",
  "odds",
  "line",
  "lines",
  "spread",
  "total",
  "over",
  "under",
  "ou",
  "prop",
  "props",
  "player",
  "players",
  "team",
  "teams",
  "first",
  "second",
  "third",
  "fourth",
  "quarter",
  "quarters",
  "half",
  "halftime",
  "full",
  "time",
]);

const QUESTION_ENTITY_BLOCKLIST = new Set([
  "who",
  "what",
  "when",
  "where",
  "how",
  "which",
  "why",
  "next",
  "markets",
  "market",
  "february",
]);

const ENTITY_LEADING_NOISE = new Set([
  "a",
  "an",
  "the",
  "will",
  "would",
  "can",
  "could",
  "should",
  "did",
  "does",
  "do",
  "is",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "what",
  "when",
  "where",
  "who",
  "why",
  "how",
  "which",
  "before",
  "after",
  "by",
  "until",
  "during",
  "between",
  "within",
  "next",
  "this",
  "last",
]);

const ENTITY_TRAILING_NOISE = new Set([
  "market",
  "markets",
  "odds",
  "price",
  "prices",
  "props",
  "prop",
  "line",
  "lines",
  "news",
  "update",
  "updates",
  "prediction",
  "predictions",
]);

const KEYWORD_NOISE = new Set([
  "announce",
  "announced",
  "announces",
  "engaged",
  "engagement",
  "winner",
  "winners",
  "loser",
  "losers",
  "champion",
  "championship",
  "run",
  "runs",
  "talk",
  "talks",
  "meet",
  "meets",
  "meeting",
  "season",
  "seasons",
  "edition",
  "cup",
  "league",
  "open",
  "closed",
  "playoff",
  "playoffs",
  "trophy",
  "award",
  "final",
  "finals",
  "group",
  "stage",
  "added",
]);

const POLITICS_PERSON_ALLOWLIST = new Set([
  "trump",
  "donald-trump",
  "kamala-harris",
  "harris",
  "joe-biden",
  "biden",
  "ron-desantis",
  "desantis",
  "gavin-newsom",
  "newsom",
  "vladimir-putin",
  "putin",
  "volodymyr-zelenskyy",
  "zelenskyy",
  "benjamin-netanyahu",
  "netanyahu",
  "elon-musk",
  "musk",
]);

const SPORTS_ENTITY_PATTERNS: Array<{ regex: RegExp; entity: string }> = [
  { regex: /\bnfl\b|\bfootball\b/i, entity: "nfl" },
  { regex: /\bnba\b|\bbasketball\b/i, entity: "nba" },
  { regex: /\bmlb\b|\bbaseball\b/i, entity: "mlb" },
  { regex: /\bnhl\b|\bhockey\b/i, entity: "nhl" },
  { regex: /\bepl\b|\bpremier league\b/i, entity: "premier-league" },
  { regex: /\bla liga\b/i, entity: "la-liga" },
  { regex: /\bserie a\b/i, entity: "serie-a" },
  { regex: /\bbundesliga\b/i, entity: "bundesliga" },
  { regex: /\bligue 1\b/i, entity: "ligue-1" },
  { regex: /\bmls\b|\bmajor league soccer\b/i, entity: "mls" },
  { regex: /\bchampions league\b|\bucl\b/i, entity: "champions-league" },
  { regex: /\bworld cup\b/i, entity: "world-cup" },
  { regex: /\bolympics?\b/i, entity: "olympics" },
  { regex: /\bpga\b|\bphoenix open\b|\bmasters\b/i, entity: "pga-tour" },
  { regex: /\batp\b|\bwta\b|\bgrand slam\b/i, entity: "tennis-tour" },
  { regex: /\bformula ?1\b|\bf1\b/i, entity: "formula-1" },
  { regex: /\bufc\b|\bmma\b/i, entity: "ufc" },
  {
    regex: /\bncaa\b|\bcollege football\b|\bcollege basketball\b/i,
    entity: "ncaa",
  },
  {
    regex:
      /\bmarch madness\b|\belite eight\b|\bsweet sixteen\b|\bfinal four\b/i,
    entity: "ncaa",
  },
];

const SPORTS_CATEGORY_HINT_PATTERN =
  /\b(nfl|nba|mlb|nhl|ncaa|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|olympics?|world cup|premier league|la liga|serie a|bundesliga|ligue 1|mls|championship|playoff|super bowl|big game|final|winner|mvp|masters|open|march madness|elite eight|sweet sixteen|final four)\b/i;

const HEAD_TO_HEAD_PATTERN = /\b(vs\.?|@|at)\b/i;

const SPORTS_COMPETITION_OR_AWARD_PATTERN =
  /\b(winner|champion|championship|mvp|stanley cup|super bowl|world series|world cup|masters|open|heisman|ballon d'or|top\s+\d+|finisher|qualifier|qualifiers)\b/i;

const POLITICS_CANDIDATE_PATTERN =
  /\b(nominee|next (?:prime minister|president|chancellor|leader)|election winner|next government|coalition|who will|who(?:'s| is) out|leaders? out|out in \d{4})\b/i;

const MENTION_MARKET_PATTERN =
  /\b(mention|mentions|mentioned|name|names|named|say|says|said|speak|speaks|spoke|speech)\b/i;

const MENTION_STOP_TOKENS = new Set([
  "mention",
  "mentions",
  "mentioned",
  "name",
  "names",
  "named",
  "during",
  "before",
  "after",
  "by",
  "state",
  "union",
]);

const SPORTS_NOISE_PATTERNS = [
  /\bmore markets?\b/gi,
  /\bmore props?\b/gi,
  /\bplayer props?\b/gi,
  /\balternate lines?\b/gi,
  /\balt lines?\b/gi,
  /\bmoneyline\b/gi,
  /\bspread\b/gi,
  /\bover\/under\b/gi,
  /\bo\/u\b/gi,
  /\b1h\b/gi,
  /\b2h\b/gi,
  /\b1q\b/gi,
  /\b2q\b/gi,
  /\b3q\b/gi,
  /\b4q\b/gi,
  /\bfirst half\b/gi,
  /\bsecond half\b/gi,
  /\bfull time\b/gi,
  /\brace to\b/gi,
  /\bfirst to\b/gi,
];

const SPORTS_TEAM_SIDE_STOP_TOKENS = new Set([
  "olympic",
  "olympics",
  "world",
  "cup",
  "playoff",
  "playoffs",
  "championship",
  "final",
  "finals",
  "round",
  "stage",
  "group",
  "league",
  "season",
  "series",
  "winner",
  "winners",
  "qualifier",
  "qualifiers",
  "game",
  "games",
  "match",
  "matches",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "before",
  "after",
  "by",
  "open",
  "masters",
  "odds",
  "spread",
  "total",
  "over",
  "under",
  "team",
  "player",
  "props",
  "prop",
  "line",
  "lines",
]);

const SPORTS_COMPETITION_SIDE_TOKENS = new Set([
  "league",
  "stage",
  "major",
  "minor",
  "open",
  "qualification",
  "qualifications",
  "qualifier",
  "qualifiers",
  "tournament",
  "event",
  "tour",
  "masters",
  "series",
  "championship",
  "playoff",
  "playoffs",
  "cup",
]);

const POLITICS_GENERIC_LABELS = new Set([
  "president",
  "presidential",
  "governor",
  "mayor",
  "house",
  "senate",
  "democratic",
  "republican",
  "primary",
  "election",
  "general",
  "party",
  "minister",
  "prime-minister",
]);

const POLITICS_GENERIC_PATTERN =
  /(governor|president|presidential|mayor|house|senate|primary|election|minister|party|parliament)/;

const POLITICS_ROLE_TOKENS = new Set([
  "fed",
  "chair",
  "court",
  "supreme",
  "house",
  "senate",
  "minister",
  "leader",
  "party",
  "parliament",
  "tariff",
]);

const POLITICS_COUNTRIES = new Set([
  "us",
  "usa",
  "united-states",
  "oman",
  "saudi-arabia",
  "united-arab-emirates",
  "uae",
  "qatar",
  "jordan",
  "lebanon",
  "syria",
  "egypt",
  "turkey",
  "china",
  "russia",
  "uk",
  "united-kingdom",
  "germany",
  "france",
  "israel",
  "iran",
  "ukraine",
  "india",
  "canada",
  "mexico",
  "taiwan",
]);

const POLITICS_COUNTRY_ALIASES = new Map<string, string>([
  ["us", "united-states"],
  ["usa", "united-states"],
  ["uk", "united-kingdom"],
  ["uae", "united-arab-emirates"],
]);

const POLITICS_ROLE_PATTERNS: Array<{ regex: RegExp; entity: string }> = [
  { regex: /\bfed chair\b/i, entity: "fed-chair" },
  { regex: /\bsupreme court\b/i, entity: "supreme-court" },
  {
    regex:
      /\b(?:us|u\.s\.|united states)\s+house(?:\s+of\s+representatives)?\b/i,
    entity: "us-house",
  },
  { regex: /\b(?:us|u\.s\.|united states)\s+senate\b/i, entity: "us-senate" },
];

const CRYPTO_MAP: Array<{ regex: RegExp; entity: string }> = [
  { regex: /\bbitcoin\b|\bbtc\b/i, entity: "bitcoin" },
  { regex: /\bethereum\b|\beth\b/i, entity: "ethereum" },
  { regex: /\bsolana\b|\bsol\b/i, entity: "solana" },
  { regex: /\bdogecoin\b|\bdoge\b/i, entity: "dogecoin" },
  { regex: /\bxrp\b|\bripple\b/i, entity: "xrp" },
  { regex: /\busdc\b/i, entity: "usdc" },
  { regex: /\busdt\b|\btether\b/i, entity: "usdt" },
];

const CRYPTO_ALIAS_TO_TICKER = new Map<string, string>([
  ["bitcoin", "bitcoin"],
  ["btc", "bitcoin"],
  ["ethereum", "ethereum"],
  ["eth", "ethereum"],
  ["solana", "solana"],
  ["sol", "solana"],
  ["dogecoin", "dogecoin"],
  ["doge", "dogecoin"],
  ["xrp", "xrp"],
  ["ripple", "xrp"],
  ["usdc", "usdc"],
  ["usdt", "usdt"],
  ["tether", "usdt"],
]);

const CRYPTO_TEXT_CUE_PATTERN =
  /\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|xrp|ripple|usdc|usdt|tether|crypto|token|blockchain|onchain|on-chain|defi|market cap|fdv)\b/i;

const POLITICS_TEXT_CUE_PATTERN =
  /\b(election|president|presidential|prime minister|government|coalition|parliament|senate|house|ceasefire|sanction|tariff|war|strike|nominee|court|fed chair|leader|state of the union|sotu|address)\b/i;

const SPORTS_TEXT_CUE_PATTERN =
  /\b(vs\.?|@|match|game|season|champion|championship|mvp|playoff|playoffs|world cup|olympics?|nba|nfl|mlb|nhl|ncaa|premier league|la liga|serie a|bundesliga|ligue 1)\b/i;

const PLACEHOLDER_ENTITY_SLUGS = new Set([
  "unknown",
  "other",
  "candidate",
  "person",
  "party",
  "actor",
  "leader",
  "company",
  "player",
  "team",
  "option",
  "choice",
  "a",
  "b",
  "c",
]);

function isPlaceholderEntitySlug(value: string): boolean {
  const normalized = normalizeSlug(value);
  if (!normalized) return true;
  if (PLACEHOLDER_ENTITY_SLUGS.has(normalized)) return true;
  if (
    /^(person|candidate|party|actor|leader|company|player|team)(-[a-z0-9]+)?$/.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/^[a-z]$/.test(normalized)) return true;
  // Keep this narrow: placeholders are usually A1/B1/C1 style buckets.
  // Broader alpha+digit filtering hides valid entities (e.g. esports teams).
  if (/^[a-c]-?\d{1,2}$/.test(normalized)) return true;
  return false;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const asInt = Math.trunc(n);
  return asInt > 0 ? asInt : fallback;
}

function parseNonNegativeInt(
  value: string | undefined,
  fallback: number,
): number {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const asInt = Math.trunc(n);
  return asInt >= 0 ? asInt : fallback;
}

function parseFraction(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0 || n > 1) return fallback;
  return n;
}

function parseNonNegativeNumber(
  value: string | undefined,
  fallback: number,
): number {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n >= 0 ? n : fallback;
}

function parseOptionalNonNegativeNumber(
  value: string | undefined,
): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseLimitedCsv(
  value: string | undefined,
  maxItems: number,
  fallback: string[],
): string[] {
  const parsed = parseCsv(value);
  const selected = parsed.length > 0 ? parsed : fallback;
  return selected.slice(0, maxItems);
}

function parseCategories(value: string | undefined): Category[] {
  const parsed = parseCsv(value).filter(
    (v): v is Category =>
      v === "crypto" || v === "politics" || v === "sports" || v === "other",
  );
  return parsed.length > 0 ? parsed : [];
}

function parseSampling(value: string | undefined): "per-venue" | "global" {
  return value === "global" ? "global" : "per-venue";
}

function parseOrderBy(
  value: string | undefined,
): "trending" | "updated" | "random" {
  if (value === "updated") return "updated";
  if (value === "random") return "random";
  return "trending";
}

function parseTierBMode(value: string | undefined): "normal" | "shed" {
  return value === "shed" ? "shed" : "normal";
}

function parseTieringMode(value: string | undefined): "threshold" | "score" {
  return value === "threshold" ? "threshold" : "score";
}

function parseLaunchProfile(value: string | undefined): Args["launchProfile"] {
  if (value === "top50_per_venue") return "top50_per_venue";
  if (value === "top100_per_venue") return "top100_per_venue";
  if (value === "stress500_global") return "stress500_global";
  return "custom";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function applyLaunchProfile(base: Args): Args {
  if (base.launchProfile === "top50_per_venue") {
    return {
      ...base,
      sampling: "per-venue",
      perVenueQuota: 50,
      maxSearchTopics: Math.min(base.maxSearchTopics, 120),
    };
  }
  if (base.launchProfile === "top100_per_venue") {
    return {
      ...base,
      sampling: "per-venue",
      perVenueQuota: 100,
      maxSearchTopics: Math.min(base.maxSearchTopics, 220),
    };
  }
  if (base.launchProfile === "stress500_global") {
    return {
      ...base,
      sampling: "global",
      limit: Math.min(base.limit, 500),
      perVenueQuota: null,
      maxSearchTopics: Math.min(base.maxSearchTopics, 300),
    };
  }
  return base;
}

function resolveArgs(argv: string[]): Args {
  const searchCategoriesParsed = parseCategories(
    parseFlag(argv, "--search-categories"),
  );
  const requireOpenNowFlag = parseFlag(argv, "--require-open-now");
  if (requireOpenNowFlag != null && !parseBoolean(requireOpenNowFlag, true)) {
    console.warn(
      "[topics:dry-run] --require-open-now=false is ignored; open-now filtering is always enforced for AI topic extraction.",
    );
  }
  const base: Args = {
    launchProfile: parseLaunchProfile(parseFlag(argv, "--launch-profile")),
    limit: parsePositiveInt(parseFlag(argv, "--limit"), 5000),
    venues: parseCsv(parseFlag(argv, "--venues")),
    categories: parseCategories(parseFlag(argv, "--categories")),
    searchCategories:
      searchCategoriesParsed.length > 0
        ? searchCategoriesParsed
        : ["crypto", "politics", "sports"],
    minVolume24h: parseNonNegativeNumber(
      parseFlag(argv, "--min-volume24h"),
      1e-9,
    ),
    minLiquidity: parseNonNegativeNumber(parseFlag(argv, "--min-liquidity"), 0),
    maxSpread: parseOptionalNonNegativeNumber(parseFlag(argv, "--max-spread")),
    // Always enforce open-now filtering in AI topic extraction.
    requireOpenNow: true,
    orderBy: parseOrderBy(parseFlag(argv, "--order-by")),
    sampling: parseSampling(parseFlag(argv, "--sampling")),
    perVenueQuota: (() => {
      const parsed = parseFlag(argv, "--per-venue-quota");
      if (!parsed) return null;
      const n = parsePositiveInt(parsed, 0);
      return n > 0 ? n : null;
    })(),
    showTop: parsePositiveInt(parseFlag(argv, "--show-top"), 20),
    showQueries: parsePositiveInt(parseFlag(argv, "--show-queries"), 12),
    includeUnknownTopics: parseBoolean(
      parseFlag(argv, "--include-unknown-topics"),
      true,
    ),
    unknownMinMarketCount: parsePositiveInt(
      parseFlag(argv, "--unknown-min-market-count"),
      3,
    ),
    searchMinMarketCount: parsePositiveInt(
      parseFlag(argv, "--search-min-market-count"),
      2,
    ),
    maxMarketAgeHours: parseNonNegativeNumber(
      parseFlag(argv, "--max-market-age-hours"),
      24,
    ),
    sportsKeywordMinMarketCount: parsePositiveInt(
      parseFlag(argv, "--sports-keyword-min-market-count"),
      3,
    ),
    cacheHitRate: parseFraction(parseFlag(argv, "--cache-hit-rate"), 0.35),
    tieringMode: parseTieringMode(parseFlag(argv, "--tiering-mode")),
    tierAMarketThreshold: parsePositiveInt(
      parseFlag(argv, "--tier-a-market-threshold"),
      20,
    ),
    tierBMarketThreshold: parsePositiveInt(
      parseFlag(argv, "--tier-b-market-threshold"),
      5,
    ),
    tierScoreAFraction: parseFraction(
      parseFlag(argv, "--tier-score-a-fraction"),
      0.08,
    ),
    tierScoreBFraction: parseFraction(
      parseFlag(argv, "--tier-score-b-fraction"),
      0.2,
    ),
    tierScoreAMin: parseNonNegativeNumber(
      parseFlag(argv, "--tier-score-a-min"),
      40,
    ),
    tierScoreBMin: parseNonNegativeNumber(
      parseFlag(argv, "--tier-score-b-min"),
      22,
    ),
    tierACadenceMinutes: parsePositiveInt(
      parseFlag(argv, "--tier-a-cadence-minutes"),
      10,
    ),
    tierBCadenceMinutes: parsePositiveInt(
      parseFlag(argv, "--tier-b-cadence-minutes"),
      120,
    ),
    tierCCadenceMinutes: parsePositiveInt(
      parseFlag(argv, "--tier-c-cadence-minutes"),
      240,
    ),
    tierACombinedCount: parseNonNegativeInt(
      parseFlag(argv, "--tier-a-combined-count"),
      1,
    ),
    tierBCombinedCount: parseNonNegativeInt(
      parseFlag(argv, "--tier-b-combined-count"),
      1,
    ),
    tierCCombinedCount: parseNonNegativeInt(
      parseFlag(argv, "--tier-c-combined-count"),
      1,
    ),
    tierAWebCount: parseNonNegativeInt(
      parseFlag(argv, "--tier-a-web-count"),
      1,
    ),
    tierAXCount: parseNonNegativeInt(parseFlag(argv, "--tier-a-x-count"), 1),
    tierBWebCount: parseNonNegativeInt(
      parseFlag(argv, "--tier-b-web-count"),
      1,
    ),
    tierBXCount: parseNonNegativeInt(parseFlag(argv, "--tier-b-x-count"), 1),
    tierBMode: parseTierBMode(parseFlag(argv, "--tier-b-mode")),
    tierCWebCount: parseNonNegativeInt(
      parseFlag(argv, "--tier-c-web-count"),
      1,
    ),
    tierCXCount: parseNonNegativeInt(parseFlag(argv, "--tier-c-x-count"), 1),
    tierCEnabled: parseBoolean(parseFlag(argv, "--tier-c-enabled"), true),
    tierAutoPromoteA: parseBoolean(
      parseFlag(argv, "--tier-auto-promote-a"),
      true,
    ),
    tierAutoPromoteB: parseBoolean(
      parseFlag(argv, "--tier-auto-promote-b"),
      true,
    ),
    tierAutoPromoteBMinTopics: parsePositiveInt(
      parseFlag(argv, "--tier-auto-promote-b-min-topics"),
      2,
    ),
    tierAutoPromoteBMinMarketCount: parsePositiveInt(
      parseFlag(argv, "--tier-auto-promote-b-min-market-count"),
      2,
    ),
    tierAutoPromoteAMinMarketCount: parsePositiveInt(
      parseFlag(argv, "--tier-auto-promote-a-min-market-count"),
      2,
    ),
    tierALookbackHours: parsePositiveInt(
      parseFlag(argv, "--tier-a-lookback-hours"),
      24,
    ),
    tierBLookbackHours: parsePositiveInt(
      parseFlag(argv, "--tier-b-lookback-hours"),
      72,
    ),
    tierCLookbackHours: parsePositiveInt(
      parseFlag(argv, "--tier-c-lookback-hours"),
      168,
    ),
    webExcludedDomains: parseLimitedCsv(
      parseFlag(argv, "--web-excluded-domains"),
      5,
      ["polymarket.com", "kalshi.com", "limitless.exchange", "hunch.trade"],
    ),
    xExcludedHandles: parseLimitedCsv(
      parseFlag(argv, "--x-excluded-handles"),
      10,
      ["polymarket", "kalshi"],
    ),
    maxSearchTopics: parsePositiveInt(
      parseFlag(argv, "--max-search-topics"),
      300,
    ),
    strictInvariants: parseBoolean(
      parseFlag(argv, "--strict-invariants"),
      false,
    ),
    emitDemotionPreview: parseBoolean(
      parseFlag(argv, "--emit-demotion-preview"),
      false,
    ),
    json: hasFlag(argv, "--json"),
    out: parseFlag(argv, "--out") ?? null,
    help: hasFlag(argv, "--help"),
  };
  return applyLaunchProfile(base);
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:topics:dry-run -- [options]

Options:
  --launch-profile <name>  Preset: top50_per_venue|top100_per_venue|stress500_global
  --limit <n>            Max active market rows to scan (default: 5000)
  --venues <csv>         Filter venues, e.g. polymarket,kalshi
  --categories <csv>     Filter categories, e.g. crypto,politics,sports
  --search-categories <csv>  Categories used for search modeling (default: crypto,politics,sports)
  --min-volume24h <n>   Minimum 24h volume filter (default: 1e-9)
  --min-liquidity <n>   Minimum liquidity/open-interest proxy filter (default: 0)
  --max-spread <n>      Optional max spread filter (requires best bid+ask)
  --require-open-now <bool>  Ignored (open-now filtering is always enabled for AI topic extraction)
  --order-by <mode>     Sampling order: trending|updated|random (default: trending)
  --sampling <mode>      Sampling strategy: per-venue|global (default: per-venue)
  --per-venue-quota <n>  Optional fixed quota per venue (default: auto from limit)
  --show-top <n>         Show top N topics in text mode (default: 20)
  --show-queries <n>     Show top N synthesized search queries (default: 12)
  --include-unknown-topics <bool> Include unknown entities in search modeling (default: true)
  --unknown-min-market-count <n>  Min marketCount for unknown topics (default: 3)
  --search-min-market-count <n>   Min marketCount for modeled search topics (default: 2)
  --max-market-age-hours <n>      Require market updated_at within this many hours (default: 24)
  --sports-keyword-min-market-count <n>  Min marketCount for sports keyword topics (default: 3)
  --cache-hit-rate <f>   Estimated cache-hit rate for external search [0..1] (default: 0.35)
  --tiering-mode <mode>  Tiering strategy: score|threshold (default: score)
  --tier-a-market-threshold <n> Tier A if marketCount >= n (default: 20)
  --tier-b-market-threshold <n> Tier B if marketCount >= n (default: 5)
  --tier-score-a-fraction <f> Target A share in score mode (default: 0.08)
  --tier-score-b-fraction <f> Target B share in score mode (default: 0.2)
  --tier-score-a-min <n> Min score to qualify for A in score mode (default: 40)
  --tier-score-b-min <n> Min score to qualify for B in score mode (default: 22)
  --tier-a-cadence-minutes <n>  Tier A refresh cadence in minutes (default: 10)
  --tier-b-cadence-minutes <n>  Tier B refresh cadence in minutes (default: 120)
  --tier-c-cadence-minutes <n>  Tier C refresh cadence in minutes (default: 240)
  --tier-a-combined-count <n>   Tier A combined web+x requests per refresh (default: 1)
  --tier-b-combined-count <n>   Tier B combined web+x requests per refresh (default: 1)
  --tier-c-combined-count <n>   Tier C combined web+x requests per refresh (default: 1)
  --tier-a-web-count <n>        Tier A web_search calls per refresh (default: 1)
  --tier-a-x-count <n>          Tier A x_search calls per refresh (default: 1)
  --tier-b-web-count <n>        Tier B web_search calls per refresh (default: 1)
  --tier-b-x-count <n>          Tier B x_search calls per refresh (default: 1)
  --tier-b-mode <mode>          Tier B mode: normal|shed (shed forces 2 web + 0 x)
  --tier-c-web-count <n>        Tier C web_search calls per refresh (default: 1)
  --tier-c-x-count <n>          Tier C x_search calls per refresh (default: 1)
  --tier-c-enabled <bool>       Enable Tier C search modeling (default: true)
  --tier-auto-promote-a <bool>  If Tier A would be empty, promote top known topic (default: true)
  --tier-auto-promote-b <bool>  If Tier B would be too small, promote top known topics (default: true)
  --tier-auto-promote-b-min-topics <n>  Minimum topic count for Tier B after promotion (default: 2)
  --tier-auto-promote-b-min-market-count <n>  Min marketCount for auto-promoted Tier B topics (default: 2)
  --tier-auto-promote-a-min-market-count <n>  Min marketCount for auto-promoted Tier A topic (default: 2)
  --tier-a-lookback-hours <n>   Tier A x_search lookback horizon (default: 24)
  --tier-b-lookback-hours <n>   Tier B x_search lookback horizon (default: 72)
  --tier-c-lookback-hours <n>   Tier C x_search lookback horizon (default: 168)
  --web-excluded-domains <csv>  web_search excluded domains (max 5)
  --x-excluded-handles <csv>    x_search excluded handles (max 10)
  --max-search-topics <n>       Max topics used in search volume model (default: 300)
  --strict-invariants <bool>    Exit non-zero when active/open-now invariants fail (default: false)
  --emit-demotion-preview <bool>  Include runtime demotion-rule preview diagnostics (default: false)
  --json                 Print JSON summary instead of text table
  --out <path>           Write JSON summary to file
  --help                 Show this help
`);
}

function normalizeSlug(value: string): string {
  const asciiOnly = Array.from(value.normalize("NFKD"))
    .filter((char) => char.charCodeAt(0) <= 0x7f)
    .join("");
  return asciiOnly
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function normalizeTitle(text: string, category: Category): string {
  let result = text.replace(/\s+/g, " ").trim();
  result = result.replace(/[–—−]/g, "-");
  result = result.replace(/\([^)]+\)/g, " ");
  result = result.replace(/\[[^\]]+\]/g, " ");
  result = result.replace(/\bmore markets?\b/gi, " ");
  result = result.replace(/\bmore props?\b/gi, " ");
  result = result.replace(/\bplayer props?\b/gi, " ");
  result = result.replace(/\balternate lines?\b/gi, " ");
  result = result.replace(/\balt lines?\b/gi, " ");
  result = result.replace(/\b\d{1,2}:\d{2}\s*(am|pm|et|ct|mt|pt)\b/gi, " ");
  result = result.replace(/\b\d{1,2}-\d{1,2}(-\d{1,2})?\b/g, " ");

  if (category === "sports") {
    for (const pattern of SPORTS_NOISE_PATTERNS) {
      result = result.replace(pattern, " ");
    }
  }

  return result.replace(/\s+/g, " ").trim();
}

function tokenizeNormalized(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length >= 3)
    .filter((token) => !STOPWORDS.has(token))
    .filter((token) => !GENERIC_TOKENS.has(token))
    .filter((token) => !MONTH_TOKENS.has(token))
    .filter((token) => !DAY_TOKENS.has(token))
    .filter((token) => !/^\d+$/.test(token))
    .filter((token) => !/^\d+(st|nd|rd|th)$/.test(token));
}

function looksLikeUsd(raw: string, suffix: string | undefined): boolean {
  return raw.includes("$") || /[kKmMbB]/.test(suffix ?? "");
}

function normalizeCategory(
  eventCategory: string | null,
  marketCategory: string | null,
  text: string,
): Category {
  const raw = `${eventCategory ?? ""} ${marketCategory ?? ""}`.toLowerCase();
  const rawSports = raw.includes("sport");
  const rawPolitics = raw.includes("polit");
  const rawCrypto = raw.includes("crypto") || raw.includes("token");

  const lower = text.toLowerCase();
  const hasCryptoCue = CRYPTO_TEXT_CUE_PATTERN.test(lower);
  const hasPoliticsCue =
    POLITICS_TEXT_CUE_PATTERN.test(lower) ||
    Array.from(POLITICS_COUNTRIES).some((country) =>
      new RegExp(`\\b${country.replace(/-/g, "\\s+")}\\b`, "i").test(lower),
    );
  const hasSportsCue =
    SPORTS_TEXT_CUE_PATTERN.test(lower) ||
    SPORTS_CATEGORY_HINT_PATTERN.test(lower);

  // Prefer strong textual cues over noisy venue/category labels.
  if (hasSportsCue) return "sports";
  if (hasPoliticsCue && !hasCryptoCue) return "politics";
  if (hasCryptoCue && !hasPoliticsCue) return "crypto";

  if (rawSports) return "sports";
  if (rawPolitics) return "politics";
  if (rawCrypto) return "crypto";

  if (
    lower.includes("bitcoin") ||
    lower.includes("ethereum") ||
    lower.includes("solana") ||
    lower.includes("dogecoin") ||
    lower.includes("ripple")
  ) {
    return "crypto";
  }
  if (
    lower.includes("election") ||
    lower.includes("president") ||
    lower.includes("senate") ||
    lower.includes("ceasefire") ||
    lower.includes("prime minister") ||
    lower.includes("government") ||
    lower.includes("coalition") ||
    lower.includes("parliament")
  ) {
    return "politics";
  }
  if (
    SPORTS_CATEGORY_HINT_PATTERN.test(lower) ||
    (/\b(vs\.?|@|at)\b/.test(lower) &&
      (lower.includes("match") ||
        lower.includes("game") ||
        lower.includes("team")))
  ) {
    return "sports";
  }
  return "other";
}

function parseDateBucket(
  value: Date | string | null | undefined,
): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function resolveTimeBucket(row: MarketRow): string {
  return (
    parseDateBucket(row.market_open_time) ??
    parseDateBucket(row.market_expiration_time) ??
    parseDateBucket(row.market_close_time) ??
    parseDateBucket(row.event_end_date) ??
    parseDateBucket(row.event_start_date) ??
    new Date().toISOString().slice(0, 10)
  );
}

function parseMagnitude(raw: string, suffix: string | undefined): number {
  const cleaned = raw.replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return Number.NaN;
  const s = (suffix ?? "").toLowerCase();
  if (s === "k") return n * 1_000;
  if (s === "m") return n * 1_000_000;
  if (s === "b") return n * 1_000_000_000;
  return n;
}

function extractConstraint(text: string): Constraint {
  const source = text.replace(/[–—−]/g, "-").replace(/\s+/g, " ").trim();

  const range = source.match(
    /\b(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)\s*(?:-|to)\s*(\$?\s*[0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)\b/i,
  );
  if (range) {
    const left = parseMagnitude(range[1], range[2]);
    const right = parseMagnitude(range[3], range[4]);
    const hasUsd = looksLikeUsd(range[0], `${range[2]}${range[4]}`);
    const looksLikeYearRange =
      !hasUsd && left >= 1900 && left <= 2100 && right >= 1900 && right <= 2100;
    if (
      Number.isFinite(left) &&
      Number.isFinite(right) &&
      left <= right &&
      !looksLikeYearRange
    ) {
      return {
        kind: "range",
        min: left,
        max: right,
        unit: hasUsd ? "usd" : "points",
        raw: range[0],
      };
    }
  }

  const ouLine = source.match(
    /\b(?:o\/u|ou|over\/under)\s*([0-9]+(?:\.[0-9]+)?)\b/i,
  );
  if (ouLine) {
    const value = Number(ouLine[1]);
    if (Number.isFinite(value)) {
      return {
        kind: "ou",
        operator: "=",
        value,
        unit: "points",
        raw: ouLine[0],
      };
    }
  }

  const ouSide = source.match(
    /\b(over|under)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:pts?|points?|goals?|runs?|sets?|games?|maps?|rounds?|touchdowns?|yards?|rebounds?|assists?|aces?|corners?|shots?|strikeouts?)?\b/i,
  );
  if (ouSide) {
    const value = Number(ouSide[2]);
    if (Number.isFinite(value)) {
      return {
        kind: "ou",
        operator: ouSide[1].toLowerCase() === "over" ? ">=" : "<=",
        value,
        unit: "points",
        raw: ouSide[0],
      };
    }
  }

  const spread = source.match(
    /\b(?:spread|line)\s*([+-]?[0-9]+(?:\.[0-9]+)?)\b/i,
  );
  if (spread) {
    const value = Number(spread[1]);
    if (Number.isFinite(value)) {
      return {
        kind: "spread",
        operator: "=",
        value,
        unit: "points",
        raw: spread[0],
      };
    }
  }

  const arrowUp = source.match(
    /[↑]\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)/,
  );
  if (arrowUp) {
    const value = parseMagnitude(arrowUp[1], arrowUp[2]);
    if (Number.isFinite(value)) {
      return {
        kind: "threshold",
        operator: ">=",
        value,
        unit: looksLikeUsd(arrowUp[0], arrowUp[2]) ? "usd" : "points",
        raw: arrowUp[0],
      };
    }
  }

  const arrowDown = source.match(
    /[↓]\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)/,
  );
  if (arrowDown) {
    const value = parseMagnitude(arrowDown[1], arrowDown[2]);
    if (Number.isFinite(value)) {
      return {
        kind: "threshold",
        operator: "<=",
        value,
        unit: looksLikeUsd(arrowDown[0], arrowDown[2]) ? "usd" : "points",
        raw: arrowDown[0],
      };
    }
  }

  const comparator = source.match(
    /\b(>=|<=|>|<)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)\b/i,
  );
  if (comparator) {
    const op =
      comparator[1] === ">"
        ? ">="
        : comparator[1] === "<"
          ? "<="
          : comparator[1];
    const value = parseMagnitude(comparator[2], comparator[3]);
    if (Number.isFinite(value)) {
      return {
        kind: "threshold",
        operator: op as ">=" | "<=",
        value,
        unit: looksLikeUsd(comparator[0], comparator[3]) ? "usd" : "points",
        raw: comparator[0],
      };
    }
  }

  const threshold = source.match(
    /(above|over|at least|no less than|reach|hit|exceed|surpass|below|under|at most|no more than|dip to|falls below|fall below|drops below|drop below|down to|up to)\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)/i,
  );
  if (threshold) {
    const op =
      /above|over|at least|no less than|reach|hit|exceed|surpass/i.test(
        threshold[1],
      )
        ? ">="
        : "<=";
    const value = parseMagnitude(threshold[2], threshold[3]);
    if (Number.isFinite(value)) {
      return {
        kind: "threshold",
        operator: op,
        value,
        unit: looksLikeUsd(threshold[0], threshold[3]) ? "usd" : "points",
        raw: threshold[0],
      };
    }
  }

  return { kind: "none" };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    (a, b) => a[0].localeCompare(b[0]),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function hashConstraint(constraint: Constraint): string {
  const stable = stableStringify(constraint);
  return createHash("sha1").update(stable).digest("hex").slice(0, 16);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeSportsTeamSlug(value: string): string {
  let parts = value.split("-").filter(Boolean);
  if (parts.length === 0) return "";

  // Keep acronym-like teams stable (e.g. U-S-A -> usa).
  if (parts.length >= 2 && parts.every((part) => part.length === 1)) {
    return parts.join("");
  }

  // Drop single-letter suffix fragments from abbreviated names.
  while (parts.length > 2 && parts[parts.length - 1].length === 1) {
    parts = parts.slice(0, -1);
  }

  return parts.join("-");
}

function isWeakSportsTeamSlug(value: string): boolean {
  if (!value) return true;
  if (isPlaceholderEntitySlug(value)) return true;
  const parts = value.split("-").filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.length === 1 && parts[0].length <= 1) return true;
  return false;
}

function pruneSportsSideTokens(tokens: string[]): string[] {
  const parts = [...tokens];
  while (
    parts.length > 1 &&
    (SPORTS_TEAM_SIDE_STOP_TOKENS.has(parts[0]) ||
      MONTH_TOKENS.has(parts[0]) ||
      DAY_TOKENS.has(parts[0]) ||
      TEMPORAL_TOKENS.has(parts[0]) ||
      KEYWORD_NOISE.has(parts[0]) ||
      /^\d+$/.test(parts[0]))
  ) {
    parts.shift();
  }
  while (
    parts.length > 1 &&
    (SPORTS_TEAM_SIDE_STOP_TOKENS.has(parts[parts.length - 1]) ||
      MONTH_TOKENS.has(parts[parts.length - 1]) ||
      DAY_TOKENS.has(parts[parts.length - 1]) ||
      TEMPORAL_TOKENS.has(parts[parts.length - 1]) ||
      KEYWORD_NOISE.has(parts[parts.length - 1]) ||
      /^\d+$/.test(parts[parts.length - 1]))
  ) {
    parts.pop();
  }
  return parts;
}

function isLikelySportsCompetitionSide(parts: string[]): boolean {
  if (parts.length === 0) return true;
  const markerCount = parts.filter((token) =>
    SPORTS_COMPETITION_SIDE_TOKENS.has(token),
  ).length;
  if (markerCount >= 2) return true;
  const hasNameLikeToken = parts.some(
    (token) =>
      token.length >= 3 &&
      !SPORTS_COMPETITION_SIDE_TOKENS.has(token) &&
      !SPORTS_TEAM_SIDE_STOP_TOKENS.has(token) &&
      !KEYWORD_NOISE.has(token) &&
      !MONTH_TOKENS.has(token) &&
      !DAY_TOKENS.has(token) &&
      !TEMPORAL_TOKENS.has(token),
  );
  if (markerCount >= 1 && !hasNameLikeToken) return true;
  if (parts.includes("qualification") || parts.includes("qualifications"))
    return true;
  return false;
}

function cleanTeamSide(value: string): string {
  const base = value
    .replace(/\([^)]*\)/g, " ")
    .replace(/[:|].*$/g, " ")
    .replace(
      /\b(total|team|player)\s+(points?|goals?|runs?|sets?|games?|maps?)\b/gi,
      " ",
    );
  const normalized = normalizeSportsTeamSlug(
    normalizeSlug(base)
      .replace(
        /^(championship|playoff|playoffs|final|finals|game|match|round|stage|group)-/,
        "",
      )
      .replace(/-(before|after|by).*$/, "")
      .replace(
        /-(total|team|player)-?(points?|goals?|runs?|sets?|games?|maps?)$/,
        "",
      )
      .replace(/-(points?|goals?|runs?|sets?|games?|maps?)$/, "")
      .replace(/-?\d+(st|nd|rd|th)?$/, "")
      .replace(/^-+|-+$/g, ""),
  );
  if (!normalized) return "";

  let parts = normalized.split("-").filter(Boolean);
  if (parts.length >= 2 && parts.every((part) => part.length === 1)) {
    return parts.join("");
  }
  if (isLikelySportsCompetitionSide(parts)) return "";

  parts = parts.filter((part) => !/^\d+$/.test(part));
  parts = pruneSportsSideTokens(parts);
  if (parts.length === 0) return "";

  const candidate = normalizeSportsTeamSlug(parts.join("-"));
  if (!candidate) return "";
  if (isWeakSportsTeamSlug(candidate)) return "";
  if (GENERIC_TOKENS.has(candidate)) return "";
  if (KEYWORD_NOISE.has(candidate)) return "";
  if (MONTH_TOKENS.has(candidate)) return "";
  if (DAY_TOKENS.has(candidate)) return "";
  if (TEMPORAL_TOKENS.has(candidate)) return "";
  if (SPORTS_TEAM_SIDE_STOP_TOKENS.has(candidate)) return "";
  return candidate;
}

function extractTeams(text: string): [string, string] | null {
  const match = text.match(/(.+?)\s+(?:vs\.?|@|at)\s+(.+)/i);
  if (!match) return null;
  let left = cleanTeamSide(match[1]);
  let right = cleanTeamSide(match[2]);
  if (!left || !right) return null;
  // Canonical ordering prevents duplicate topics for "A vs B" and "B @ A".
  if (right.localeCompare(left) < 0) {
    [left, right] = [right, left];
  }
  return [left, right];
}

function extractAcronymTokens(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Z0-9]{1,7}\b/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of matches) {
    const slug = normalizeSlug(item);
    if (!slug) continue;
    if (MONTH_TOKENS.has(slug) || DAY_TOKENS.has(slug)) continue;
    if (GENERIC_TOKENS.has(slug)) continue;
    if (KEYWORD_NOISE.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function extractSportsCandidateFallback(text: string): string | null {
  const normalized = normalizeTitle(text, "sports");
  const tokens = tokenizeNormalized(normalized).filter((token) => {
    if (STOPWORDS.has(token)) return false;
    if (GENERIC_TOKENS.has(token)) return false;
    if (KEYWORD_NOISE.has(token)) return false;
    if (MONTH_TOKENS.has(token) || DAY_TOKENS.has(token)) return false;
    if (TEMPORAL_TOKENS.has(token)) return false;
    if (SPORTS_TEAM_SIDE_STOP_TOKENS.has(token)) return false;
    if (QUESTION_ENTITY_BLOCKLIST.has(token)) return false;
    if (/^\d+$/.test(token)) return false;
    if (/^[1-4](q|h)$/.test(token)) return false;
    if (/^(q|h)[1-4]$/.test(token)) return false;
    if (isPlaceholderEntitySlug(token)) return false;
    return true;
  });
  if (tokens.length === 0) return null;
  // Keep the fallback simple and deterministic: prefer longer informative tokens.
  const [best] = tokens.sort((a, b) => b.length - a.length);
  return best && !isPlaceholderEntitySlug(best) ? best : null;
}

function detectEntityArchetype(
  category: Category,
  eventTitle: string | null,
  marketTitle: string | null,
): EntityArchetype {
  const event = `${eventTitle ?? ""}`;
  const market = `${marketTitle ?? ""}`;
  const combined = `${event} ${market}`.toLowerCase();
  if (
    (category === "politics" || category === "other") &&
    MENTION_MARKET_PATTERN.test(combined)
  ) {
    return "candidate_list";
  }
  if (category === "sports") {
    if (HEAD_TO_HEAD_PATTERN.test(combined)) return "head_to_head";
    if (SPORTS_COMPETITION_OR_AWARD_PATTERN.test(combined)) {
      return "competition_winner";
    }
    if (
      /\b(attend|attendance|starter|lineup|injury|injured|suspended)\b/i.test(
        combined,
      )
    ) {
      return "candidate_list";
    }
  }
  if (category === "politics") {
    if (POLITICS_CANDIDATE_PATTERN.test(combined)) return "candidate_list";
  }
  return "generic";
}

function extractCapitalizedPhrases(text: string): string[] {
  const matches =
    text.match(
      /\b(?:[A-Z]{2,}|[A-Z][\p{L}'’.-]+)(?:\s+(?:[A-Z]{2,}|[A-Z][\p{L}'’.-]+)){0,3}\b/gu,
    ) ?? [];
  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (const entry of matches) {
    const normalized = normalizeSlug(entry);
    if (!normalized) continue;

    const parts = normalized.split("-").filter(Boolean);
    while (parts.length > 1 && ENTITY_LEADING_NOISE.has(parts[0])) {
      parts.shift();
    }
    while (
      parts.length > 1 &&
      ENTITY_TRAILING_NOISE.has(parts[parts.length - 1])
    ) {
      parts.pop();
    }
    if (parts.length === 0) continue;

    const candidate = parts.join("-");
    if (!candidate) continue;
    if (
      parts.every(
        (part) =>
          MONTH_TOKENS.has(part) ||
          DAY_TOKENS.has(part) ||
          TEMPORAL_TOKENS.has(part) ||
          /^\d+$/.test(part),
      )
    ) {
      continue;
    }
    if (QUESTION_ENTITY_BLOCKLIST.has(candidate)) continue;
    if (GENERIC_TOKENS.has(candidate)) continue;
    if (MONTH_TOKENS.has(candidate)) continue;
    if (DAY_TOKENS.has(candidate)) continue;
    if (KEYWORD_NOISE.has(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    cleaned.push(candidate);
  }

  return cleaned;
}

function extractKeywordEntity(text: string): string {
  const tokens = tokenizeNormalized(text).filter(
    (token) =>
      !QUESTION_ENTITY_BLOCKLIST.has(token) &&
      !KEYWORD_NOISE.has(token) &&
      !POLITICS_GENERIC_LABELS.has(token) &&
      !isPlaceholderEntitySlug(token),
  );
  if (tokens.length === 0) return "unknown";
  const [first] = tokens.sort((a, b) => {
    const aTicker = CRYPTO_ALIAS_TO_TICKER.has(a) ? 1 : 0;
    const bTicker = CRYPTO_ALIAS_TO_TICKER.has(b) ? 1 : 0;
    if (aTicker !== bTicker) return bTicker - aTicker;
    return b.length - a.length;
  });
  return normalizeSlug(first);
}

function extractEventAnchorKeyword(text: string): string | null {
  const normalized = normalizeTitle(text, "other");
  if (!normalized) return null;
  const tokens = tokenizeNormalized(normalized).filter(
    (token) =>
      !KEYWORD_NOISE.has(token) &&
      !MONTH_TOKENS.has(token) &&
      !DAY_TOKENS.has(token) &&
      !TEMPORAL_TOKENS.has(token) &&
      !isPlaceholderEntitySlug(token),
  );
  if (tokens.length < 2) return null;
  const anchor = normalizeSlug(tokens.slice(0, 5).join("-"));
  if (!anchor || isPlaceholderEntitySlug(anchor)) return null;
  return anchor;
}

function extractMentionTarget(text: string): string | null {
  if (!text) return null;
  if (!MENTION_MARKET_PATTERN.test(text)) return null;

  const quoted = text.match(/["']([^"']{2,80})["']/);
  if (quoted?.[1]) {
    const slug = normalizeSlug(quoted[1]);
    if (
      slug &&
      !isPlaceholderEntitySlug(slug) &&
      !QUESTION_ENTITY_BLOCKLIST.has(slug) &&
      !KEYWORD_NOISE.has(slug) &&
      !MENTION_STOP_TOKENS.has(slug)
    ) {
      return slug;
    }
  }

  const mentionMatch = text.match(MENTION_MARKET_PATTERN);
  if (!mentionMatch || mentionMatch.index == null) return null;
  const prefix = text.slice(0, mentionMatch.index);
  const suffix = text.slice(mentionMatch.index + mentionMatch[0].length);

  const prefixPhrases = extractCapitalizedPhrases(prefix).filter(
    (phrase) =>
      !isPlaceholderEntitySlug(phrase) &&
      !QUESTION_ENTITY_BLOCKLIST.has(phrase) &&
      !KEYWORD_NOISE.has(phrase) &&
      !MENTION_STOP_TOKENS.has(phrase) &&
      !MONTH_TOKENS.has(phrase) &&
      !DAY_TOKENS.has(phrase),
  );
  if (prefixPhrases.length > 0) {
    return prefixPhrases[prefixPhrases.length - 1];
  }

  const phraseCandidates = extractCapitalizedPhrases(suffix).filter(
    (phrase) =>
      !isPlaceholderEntitySlug(phrase) &&
      !QUESTION_ENTITY_BLOCKLIST.has(phrase) &&
      !KEYWORD_NOISE.has(phrase) &&
      !MENTION_STOP_TOKENS.has(phrase) &&
      !MONTH_TOKENS.has(phrase) &&
      !DAY_TOKENS.has(phrase),
  );
  if (phraseCandidates.length > 0) {
    return phraseCandidates[0];
  }

  const prefixTokens = tokenizeNormalized(
    normalizeTitle(prefix, "other"),
  ).filter(
    (token) =>
      !QUESTION_ENTITY_BLOCKLIST.has(token) &&
      !KEYWORD_NOISE.has(token) &&
      !MENTION_STOP_TOKENS.has(token) &&
      !MONTH_TOKENS.has(token) &&
      !DAY_TOKENS.has(token) &&
      !TEMPORAL_TOKENS.has(token) &&
      !isPlaceholderEntitySlug(token),
  );
  if (prefixTokens.length > 0) {
    const anchor = normalizeSlug(prefixTokens.slice(-2).join("-"));
    if (anchor && !isPlaceholderEntitySlug(anchor)) return anchor;
  }

  const tokens = tokenizeNormalized(normalizeTitle(suffix, "other")).filter(
    (token) =>
      !QUESTION_ENTITY_BLOCKLIST.has(token) &&
      !KEYWORD_NOISE.has(token) &&
      !MENTION_STOP_TOKENS.has(token) &&
      !MONTH_TOKENS.has(token) &&
      !DAY_TOKENS.has(token) &&
      !TEMPORAL_TOKENS.has(token) &&
      !isPlaceholderEntitySlug(token),
  );
  if (tokens.length === 0) return null;
  const anchor = normalizeSlug(tokens.slice(0, 3).join("-"));
  return anchor && !isPlaceholderEntitySlug(anchor) ? anchor : null;
}

function extractCandidateEntityFromText(
  text: string,
  category: Category,
): string | null {
  const normalized = normalizeTitle(text, category);
  const phrases = extractCapitalizedPhrases(text);
  for (const phrase of phrases) {
    if (phrase.length < 3) continue;
    if (STOPWORDS.has(phrase)) continue;
    if (QUESTION_ENTITY_BLOCKLIST.has(phrase)) continue;
    if (GENERIC_TOKENS.has(phrase)) continue;
    if (KEYWORD_NOISE.has(phrase)) continue;
    if (MONTH_TOKENS.has(phrase) || DAY_TOKENS.has(phrase)) continue;
    if (TEMPORAL_TOKENS.has(phrase)) continue;
    if (isPlaceholderEntitySlug(phrase)) continue;
    return phrase;
  }
  const acronyms = extractAcronymTokens(text);
  if (acronyms.length > 0) {
    return acronyms[0];
  }
  if (category === "politics") {
    return null;
  }
  const tokens = tokenizeNormalized(normalized).filter(
    (token) => !POLITICS_GENERIC_LABELS.has(token),
  );
  if (tokens.length === 0) return null;
  return isPlaceholderEntitySlug(tokens[0]) ? null : tokens[0];
}

function extractCoalitionEntity(text: string): string | null {
  if (!/[+&/]/.test(text) && !/\band\b/i.test(text)) return null;
  const acronyms = extractAcronymTokens(text);
  if (acronyms.length < 2) return null;
  return `${acronyms.slice(0, 3).join("-")}-coalition`;
}

function isLowSignalOutcomeLabel(value: string): boolean {
  const normalized = compactWhitespace(value).toLowerCase();
  if (!normalized) return true;
  if (/^[a-z]$/.test(normalized)) return true;
  if (/^(player|team)\s+[a-z0-9-]+$/.test(normalized)) return true;
  if (
    /^(other|candidate|person|party|actor|leader|company)(\s+[a-z0-9-]+)?$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  if (/^(yes|no|over|under|true|false)$/i.test(normalized)) return true;
  if (/^[<>]=?\s*\d/.test(normalized)) return true;
  return false;
}

function searchSubjectFromUnknownTopic(topic: TopicSummaryRow): string {
  const event = compactWhitespace(topic.sampleEventTitle ?? "");
  const market = compactWhitespace(topic.sampleMarketTitle ?? "");
  if (event && market) {
    if (isLowSignalOutcomeLabel(market)) {
      return event;
    }
    const loweredEvent = event.toLowerCase();
    const loweredMarket = market.toLowerCase();
    if (!loweredEvent.includes(loweredMarket)) {
      return `${event} ${market}`;
    }
    return event;
  }
  if (event) return event;
  if (market) return market;
  return "prediction market event";
}

function hasPoliticsGenericAnchors(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      POLITICS_GENERIC_LABELS.has(token) ||
      token === "polling" ||
      token === "ceasefire",
  );
}

function resolveEntity(
  category: Category,
  eventTitle: string | null,
  marketTitle: string | null,
): {
  type: EntityType;
  value: string;
  source: "event" | "market" | "combined" | "derived";
  archetype: EntityArchetype;
  unknownReason: string | null;
} {
  const rawText = `${eventTitle ?? ""} ${marketTitle ?? ""}`.trim();
  const normalizedText = normalizeTitle(rawText, category);
  const eventOnlyText = normalizeTitle(eventTitle ?? "", category);
  const marketOnlyText = normalizeTitle(marketTitle ?? "", category);
  const archetype = detectEntityArchetype(category, eventTitle, marketTitle);
  const candidateFirst =
    archetype === "candidate_list" || archetype === "competition_winner";
  const entitySourceText = candidateFirst
    ? marketOnlyText || eventOnlyText || normalizedText
    : eventOnlyText || marketOnlyText || normalizedText;
  const rawEntitySource = candidateFirst
    ? marketTitle?.trim() || eventTitle?.trim() || rawText
    : eventTitle?.trim() || marketTitle?.trim() || rawText;

  const isMentionMarket =
    (category === "politics" || category === "other") &&
    MENTION_MARKET_PATTERN.test(rawText);
  if (isMentionMarket) {
    const marketCandidate =
      marketTitle && !isLowSignalOutcomeLabel(marketTitle)
        ? extractCandidateEntityFromText(marketTitle, category)
        : null;
    const mentionCandidate =
      extractMentionTarget(eventTitle ?? "") ??
      extractMentionTarget(rawText) ??
      extractCandidateEntityFromText(eventTitle ?? "", category) ??
      marketCandidate;
    if (mentionCandidate) {
      const normalizedCandidate = normalizeSlug(mentionCandidate);
      if (
        normalizedCandidate &&
        !QUESTION_ENTITY_BLOCKLIST.has(normalizedCandidate) &&
        !KEYWORD_NOISE.has(normalizedCandidate) &&
        !MENTION_STOP_TOKENS.has(normalizedCandidate) &&
        !isPlaceholderEntitySlug(normalizedCandidate)
      ) {
        const mappedCountry =
          POLITICS_COUNTRY_ALIASES.get(normalizedCandidate) ??
          normalizedCandidate;
        if (POLITICS_COUNTRIES.has(mappedCountry)) {
          return {
            type: "country",
            value: mappedCountry,
            source: "market",
            archetype,
            unknownReason: null,
          };
        }
        return {
          type: category === "politics" ? "person" : "keyword",
          value: normalizedCandidate,
          source: "market",
          archetype,
          unknownReason: null,
        };
      }
    }
  }

  if (category === "crypto") {
    for (const candidate of CRYPTO_MAP) {
      if (candidate.regex.test(rawEntitySource)) {
        return {
          type: "ticker",
          value: candidate.entity,
          source: "combined",
          archetype,
          unknownReason: null,
        };
      }
    }
    const ticker = rawEntitySource.match(/\$([A-Z]{2,10})\b/);
    if (ticker) {
      const normalizedTicker = normalizeSlug(ticker[1]);
      const mapped = CRYPTO_ALIAS_TO_TICKER.get(normalizedTicker);
      if (mapped) {
        return {
          type: "ticker",
          value: mapped,
          source: "combined",
          archetype,
          unknownReason: null,
        };
      }
      return {
        type: "keyword",
        value: "unknown",
        source: "combined",
        archetype,
        unknownReason: "crypto_unlisted_ticker",
      };
    }
    const cryptoTokens = tokenizeNormalized(entitySourceText);
    for (const token of cryptoTokens) {
      const mapped = CRYPTO_ALIAS_TO_TICKER.get(token);
      if (mapped) {
        return {
          type: "ticker",
          value: mapped,
          source: "combined",
          archetype,
          unknownReason: null,
        };
      }
    }

    // If we have explicit crypto cues but no mapped ticker, keep a generic
    // keyword anchor rather than dropping to unknown.
    const hasCryptoCue = CRYPTO_TEXT_CUE_PATTERN.test(rawEntitySource);
    if (hasCryptoCue) {
      const fallback = extractEventAnchorKeyword(rawEntitySource);
      if (fallback && !POLITICS_COUNTRIES.has(fallback)) {
        return {
          type: "keyword",
          value: fallback,
          source: "combined",
          archetype,
          unknownReason: null,
        };
      }
    }

    // Conservative crypto handling: skip unknown entities rather than
    // producing noisy generic keywords that degrade search quality.
    return {
      type: "keyword",
      value: "unknown",
      source: "combined",
      archetype,
      unknownReason: "crypto_unresolved",
    };
  }

  if (category === "sports") {
    const teamInputs = candidateFirst
      ? [marketOnlyText, eventOnlyText, normalizedText]
      : [eventOnlyText, marketOnlyText, normalizedText];
    const sawHeadToHead = teamInputs.some((input) =>
      HEAD_TO_HEAD_PATTERN.test(input),
    );
    const teams = teamInputs
      .map((input) => extractTeams(input))
      .find((value): value is [string, string] => value !== null);
    if (teams) {
      return {
        type: "match",
        value: `${teams[0]}-vs-${teams[1]}`,
        source: candidateFirst ? "market" : "event",
        archetype,
        unknownReason: null,
      };
    }

    if (archetype === "competition_winner" || archetype === "candidate_list") {
      const candidateFromMarket = extractCandidateEntityFromText(
        marketTitle ?? "",
        "sports",
      );
      if (candidateFromMarket) {
        const normalizedCandidate = normalizeSlug(candidateFromMarket);
        if (isPlaceholderEntitySlug(normalizedCandidate)) {
          // For placeholders like "Other", keep searching for stronger anchors.
        } else {
          return {
            type: "keyword",
            value: normalizedCandidate,
            source: "market",
            archetype,
            unknownReason: null,
          };
        }
      }
      const fallbackCandidate =
        extractSportsCandidateFallback(marketTitle ?? "") ??
        extractSportsCandidateFallback(eventTitle ?? "");
      if (fallbackCandidate) {
        return {
          type: "keyword",
          value: fallbackCandidate,
          source: marketTitle?.trim() ? "market" : "event",
          archetype,
          unknownReason: null,
        };
      }
    }
    for (const pattern of SPORTS_ENTITY_PATTERNS) {
      if (pattern.regex.test(entitySourceText)) {
        return {
          type: "keyword",
          value: pattern.entity,
          source: "event",
          archetype,
          unknownReason: null,
        };
      }
    }
    return {
      type: "keyword",
      value: "unknown",
      source: candidateFirst ? "market" : "event",
      archetype,
      unknownReason:
        archetype === "competition_winner"
          ? "sports_candidate_unresolved"
          : sawHeadToHead
            ? "sports_match_unresolved"
            : "sports_unresolved",
    };
  }

  if (category === "politics") {
    const source = entitySourceText;
    const sourceTokens = tokenizeNormalized(source);
    const phrases = extractCapitalizedPhrases(source);
    const hasRoleToken = (value: string): boolean =>
      value.split("-").some((part) => POLITICS_ROLE_TOKENS.has(part));

    if (archetype === "candidate_list") {
      const coalition = extractCoalitionEntity(marketTitle ?? "");
      if (coalition) {
        return {
          type: "keyword",
          value: coalition,
          source: "market",
          archetype,
          unknownReason: null,
        };
      }
      const candidateFromMarket = extractCandidateEntityFromText(
        marketTitle ?? "",
        "politics",
      );
      if (candidateFromMarket) {
        const normalizedCandidate = normalizeSlug(candidateFromMarket);
        if (isPlaceholderEntitySlug(normalizedCandidate)) {
          // Continue to event-level matching for placeholder outcomes.
        } else if (normalizedCandidate.includes("party")) {
          return {
            type: "keyword",
            value: normalizedCandidate,
            source: "market",
            archetype,
            unknownReason: null,
          };
        } else {
          return {
            type: "person",
            value: normalizedCandidate,
            source: "market",
            archetype,
            unknownReason: null,
          };
        }
      }
    }

    // Some politics markets encode the candidate/entity in outcomes while
    // event titles remain generic (e.g. "leaders out in 2026").
    if (archetype === "generic") {
      const marketCandidate = extractCandidateEntityFromText(
        marketTitle ?? "",
        "politics",
      );
      if (marketCandidate) {
        const normalizedCandidate = normalizeSlug(marketCandidate);
        if (isPlaceholderEntitySlug(normalizedCandidate)) {
          // Skip generic bucket labels like "Other", "Person X", "Candidate A".
        } else {
          const mappedCountry =
            POLITICS_COUNTRY_ALIASES.get(normalizedCandidate) ??
            normalizedCandidate;
          const isSingleToken = !normalizedCandidate.includes("-");
          const singleTokenIsWeak =
            isSingleToken &&
            !POLITICS_PERSON_ALLOWLIST.has(normalizedCandidate) &&
            normalizedCandidate.length < 4;
          if (
            normalizedCandidate &&
            !singleTokenIsWeak &&
            !STOPWORDS.has(normalizedCandidate) &&
            !TEMPORAL_TOKENS.has(normalizedCandidate) &&
            !MONTH_TOKENS.has(normalizedCandidate) &&
            !DAY_TOKENS.has(normalizedCandidate) &&
            !QUESTION_ENTITY_BLOCKLIST.has(normalizedCandidate) &&
            !POLITICS_GENERIC_LABELS.has(normalizedCandidate) &&
            !KEYWORD_NOISE.has(normalizedCandidate)
          ) {
            if (POLITICS_COUNTRIES.has(mappedCountry)) {
              return {
                type: "country",
                value: mappedCountry,
                source: "market",
                archetype,
                unknownReason: null,
              };
            }
            if (normalizedCandidate.includes("party")) {
              return {
                type: "keyword",
                value: normalizedCandidate,
                source: "market",
                archetype,
                unknownReason: null,
              };
            }
            return {
              type: "person",
              value: normalizedCandidate,
              source: "market",
              archetype,
              unknownReason: null,
            };
          }
        }
      }
    }

    for (const pattern of POLITICS_ROLE_PATTERNS) {
      if (pattern.regex.test(source)) {
        return {
          type: "keyword",
          value: pattern.entity,
          source: "event",
          archetype,
          unknownReason: null,
        };
      }
    }

    for (const phrase of phrases) {
      const mappedCountry = POLITICS_COUNTRY_ALIASES.get(phrase) ?? phrase;
      if (POLITICS_COUNTRIES.has(mappedCountry)) {
        return {
          type: "country",
          value: mappedCountry,
          source: "event",
          archetype,
          unknownReason: null,
        };
      }
    }

    for (const token of sourceTokens) {
      const mappedCountry = POLITICS_COUNTRY_ALIASES.get(token) ?? token;
      if (POLITICS_COUNTRIES.has(mappedCountry)) {
        return {
          type: "country",
          value: mappedCountry,
          source: "event",
          archetype,
          unknownReason: null,
        };
      }
    }

    const filteredPhrases = phrases.filter(
      (phrase) =>
        !POLITICS_GENERIC_LABELS.has(phrase) &&
        !POLITICS_GENERIC_PATTERN.test(phrase) &&
        !KEYWORD_NOISE.has(phrase) &&
        !isPlaceholderEntitySlug(phrase) &&
        !QUESTION_ENTITY_BLOCKLIST.has(phrase) &&
        !MONTH_TOKENS.has(phrase) &&
        !DAY_TOKENS.has(phrase),
    );

    const multiWordPerson = filteredPhrases.find(
      (phrase) =>
        phrase.includes("-") &&
        !hasRoleToken(phrase) &&
        phrase
          .split("-")
          .every(
            (part) =>
              !POLITICS_GENERIC_LABELS.has(part) && !KEYWORD_NOISE.has(part),
          ),
    );
    if (multiWordPerson) {
      return {
        type: "person",
        value: multiWordPerson,
        source: "event",
        archetype,
        unknownReason: null,
      };
    }

    const singleWordPerson = filteredPhrases.find(
      (phrase) =>
        POLITICS_PERSON_ALLOWLIST.has(phrase) ||
        (archetype === "candidate_list" && phrase.length >= 4),
    );
    if (singleWordPerson) {
      return {
        type: "person",
        value: singleWordPerson,
        source: "event",
        archetype,
        unknownReason: null,
      };
    }

    const rolePhrase = filteredPhrases.find((phrase) => hasRoleToken(phrase));
    if (rolePhrase) {
      return {
        type: "keyword",
        value: rolePhrase,
        source: "event",
        archetype,
        unknownReason: null,
      };
    }

    // Fallback to event-level anchor for generic/candidate politics topics
    // where outcome labels are placeholders (e.g. "Other", "No one").
    const eventAnchor = extractEventAnchorKeyword(eventOnlyText);
    if (eventAnchor) {
      return {
        type: "keyword",
        value: eventAnchor,
        source: "event",
        archetype,
        unknownReason: null,
      };
    }

    return {
      type: "keyword",
      value: "unknown",
      source: candidateFirst ? "market" : "event",
      archetype,
      unknownReason:
        archetype === "candidate_list"
          ? "politics_candidate_unresolved"
          : hasPoliticsGenericAnchors(sourceTokens)
            ? "politics_generic_anchor_only"
            : "politics_unresolved",
    };
  }

  const keyword = extractKeywordEntity(normalizedText);
  const mappedTicker = CRYPTO_ALIAS_TO_TICKER.get(keyword);
  if (mappedTicker) {
    return {
      type: "ticker",
      value: mappedTicker,
      source: "derived",
      archetype,
      unknownReason: null,
    };
  }
  if (
    keyword === "unknown" ||
    QUESTION_ENTITY_BLOCKLIST.has(keyword) ||
    GENERIC_TOKENS.has(keyword)
  ) {
    return {
      type: "keyword",
      value: "unknown",
      source: "derived",
      archetype,
      unknownReason: "generic_unresolved",
    };
  }
  return {
    type: "keyword",
    value: keyword,
    source: "derived",
    archetype,
    unknownReason: null,
  };
}

type SqlParam = string[] | number | string;

function marketVolumeDisplayExpr(alias = "m"): string {
  return `
    case
      when ${alias}.volume_24h is not null and ${alias}.volume_24h > 0 then ${alias}.volume_24h
      when ${alias}.volume_total is not null and ${alias}.volume_total > 0 then ${alias}.volume_total
      else null
    end
  `;
}

function marketLiquidityDisplayExpr(alias = "m"): string {
  return `
    coalesce(nullif(${alias}.liquidity, 0), nullif(${alias}.open_interest, 0), 0)
  `;
}

function marketOrderByClause(args: Args): string {
  if (args.orderBy === "updated") {
    return "coalesce(m.updated_at_db, m.updated_at) desc nulls last, m.id desc";
  }
  if (args.orderBy === "random") {
    return "random(), m.id";
  }
  const volumeExpr = marketVolumeDisplayExpr("m");
  const liquidityExpr = marketLiquidityDisplayExpr("m");
  return `
    coalesce(${volumeExpr}, 0) desc nulls last,
    coalesce(${liquidityExpr}, 0) desc nulls last,
    coalesce(m.updated_at_db, m.updated_at) desc nulls last,
    m.id desc
  `;
}

function buildMarketWhere(args: Args, baseParams: SqlParam[]): string {
  const volumeExpr = marketVolumeDisplayExpr("m");
  const liquidityExpr = marketLiquidityDisplayExpr("m");
  const parts: string[] = ["m.status = 'ACTIVE'", "e.status = 'ACTIVE'"];

  if (args.requireOpenNow) {
    baseParams.push(new Date().toISOString());
    const nowIdx = baseParams.length;
    parts.push(
      `(m.expiration_time is null or m.expiration_time > $${nowIdx}::timestamptz)`,
    );
    parts.push(
      `(m.close_time is null or m.close_time > $${nowIdx}::timestamptz)`,
    );
    parts.push(`(e.end_date is null or e.end_date > $${nowIdx}::timestamptz)`);
  }

  if (args.venues.length > 0) {
    baseParams.push(args.venues);
    parts.push(`m.venue = any($${baseParams.length})`);
  }

  if (args.minVolume24h > 1e-9) {
    baseParams.push(args.minVolume24h);
    parts.push(`${volumeExpr} >= $${baseParams.length}`);
  }

  if (args.minLiquidity > 0) {
    baseParams.push(args.minLiquidity);
    parts.push(`${liquidityExpr} >= $${baseParams.length}`);
  }

  if (args.maxSpread != null) {
    baseParams.push(args.maxSpread);
    parts.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= $${baseParams.length}`,
    );
  }

  if (args.maxMarketAgeHours > 0) {
    baseParams.push(args.maxMarketAgeHours);
    parts.push(
      `coalesce(m.updated_at_db, m.updated_at) is not null and coalesce(m.updated_at_db, m.updated_at) >= (now() - ($${baseParams.length}::double precision * interval '1 hour'))`,
    );
  }

  return parts.join(" and ");
}

async function fetchRows(args: Args): Promise<MarketRow[]> {
  const baseParams: SqlParam[] = [];
  const where = buildMarketWhere(args, baseParams);
  const orderBy = marketOrderByClause(args);

  const runGlobal = async (limit: number, excludeIds: string[] = []) => {
    const params: SqlParam[] = [...baseParams];
    let globalWhere = where;
    if (excludeIds.length > 0) {
      params.push(excludeIds);
      globalWhere += ` and not (m.id = any($${params.length}))`;
    }
    params.push(limit);
    const limitIdx = params.length;

    const sql = `
      select
        m.id as market_id,
        m.event_id,
        m.venue,
        m.title as market_title,
        e.title as event_title,
        e.status::text as event_status,
        m.category as market_category,
        e.category as event_category,
        m.open_time as market_open_time,
        m.expiration_time as market_expiration_time,
        m.close_time as market_close_time,
        coalesce(m.updated_at_db, m.updated_at) as market_updated_at,
        e.end_date as event_end_date,
        e.start_date as event_start_date
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where ${globalWhere}
      order by ${orderBy}
      limit $${limitIdx}
    `;
    const result = await pool.query<MarketRow>(sql, params);
    return result.rows;
  };

  if (args.sampling === "global") {
    return runGlobal(args.limit);
  }

  let venues = args.venues;
  if (venues.length === 0) {
    const venueSql = `
      select distinct m.venue
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where ${where}
      order by m.venue
    `;
    const venueRes = await pool.query<{ venue: string }>(venueSql, baseParams);
    venues = venueRes.rows.map((row) => row.venue).filter(Boolean);
  }
  if (venues.length === 0) {
    return [];
  }

  const perVenueQuota =
    args.perVenueQuota ?? Math.max(1, Math.ceil(args.limit / venues.length));
  const params: SqlParam[] = [...baseParams];
  params.push(perVenueQuota);
  const quotaIdx = params.length;
  params.push(args.limit);
  const limitIdx = params.length;

  const sql = `
    with ranked as (
      select
        m.id as market_id,
        m.event_id,
        m.venue,
        m.title as market_title,
        e.title as event_title,
        e.status::text as event_status,
        m.category as market_category,
        e.category as event_category,
        m.open_time as market_open_time,
        m.expiration_time as market_expiration_time,
        m.close_time as market_close_time,
        coalesce(m.updated_at_db, m.updated_at) as market_updated_at,
        e.end_date as event_end_date,
        e.start_date as event_start_date,
        row_number() over (
          partition by m.venue
          order by ${orderBy}
        ) as r
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where ${where}
    )
    select
      market_id,
      event_id,
      venue,
      market_title,
      event_title,
      event_status,
      market_category,
      event_category,
      market_open_time,
      market_expiration_time,
      market_close_time,
      market_updated_at,
      event_end_date,
      event_start_date
    from ranked
    where r <= $${quotaIdx}
    order by venue, r
    limit $${limitIdx}
  `;
  const result = await pool.query<MarketRow>(sql, params);
  if (result.rows.length >= args.limit) {
    return result.rows;
  }

  const topUp = await runGlobal(
    args.limit - result.rows.length,
    result.rows.map((row) => row.market_id),
  );
  return result.rows.concat(topUp);
}

async function fetchActiveVenueDistribution(
  args: Args,
): Promise<Record<string, number>> {
  const params: SqlParam[] = [];
  const where = buildMarketWhere(args, params);
  const sql = `
    select m.venue, count(*)::int as count
    from unified_markets m
    join unified_events e on e.id = m.event_id
    where ${where}
    group by m.venue
    order by count desc
  `;
  const result = await pool.query<{ venue: string; count: number }>(
    sql,
    params,
  );
  return result.rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.venue] = row.count;
    return acc;
  }, {});
}

function buildTopicFromRow(row: MarketRow): {
  category: Category;
  entityType: EntityType;
  entity: string;
  archetype: EntityArchetype;
  entitySource: "event" | "market" | "combined" | "derived";
  unknownReason: string | null;
  constraint: Constraint;
  constraintHash: string;
  timeBucket: string;
  topicKey: string;
} {
  const fullText = `${row.event_title ?? ""} ${row.market_title ?? ""}`.trim();
  const normalized = normalizeTitle(fullText, "other");
  const category = normalizeCategory(
    row.event_category,
    row.market_category,
    normalized,
  );
  const entity = resolveEntity(category, row.event_title, row.market_title);
  const constraint = extractConstraint(
    `${row.market_title ?? ""} ${row.event_title ?? ""}`.trim(),
  );
  const constraintHash = hashConstraint(constraint);
  const timeBucket = resolveTimeBucket(row);
  const topicKey = `v1:cat=${category}:ent=${entity.type}:${entity.value}:c=${constraintHash}:t=${timeBucket}`;
  return {
    category,
    entityType: entity.type,
    entity: entity.value,
    archetype: entity.archetype,
    entitySource: entity.source,
    unknownReason: entity.unknownReason,
    constraint,
    constraintHash,
    timeBucket,
    topicKey,
  };
}

function toPrintableConstraint(constraint: Constraint): string {
  if (constraint.kind === "none") return "none";
  if (constraint.kind === "range") {
    return `range:${constraint.min}-${constraint.max}`;
  }
  return `${constraint.kind}:${constraint.operator}:${constraint.value}`;
}

function formatConstraintForQuery(constraint: Constraint): string {
  if (constraint.kind === "none") return "";
  if (constraint.kind === "range") {
    return `${constraint.min}-${constraint.max}${constraint.unit === "usd" ? " usd" : ""}`;
  }
  if (constraint.kind === "spread") {
    return `spread ${constraint.value}`;
  }
  if (constraint.kind === "ou") {
    return `total ${constraint.operator} ${constraint.value}`;
  }
  return `${constraint.operator} ${constraint.value}${constraint.unit === "usd" ? " usd" : ""}`;
}

function entityTerm(topic: TopicSummaryRow): string {
  if (topic.archetype === "candidate_list") {
    const eventAnchor = candidateIntentAnchor(topic);
    if (eventAnchor) {
      return eventAnchor.replace(/-/g, " ");
    }
  }
  if (topic.entity === "unknown" || isPlaceholderEntitySlug(topic.entity)) {
    return searchSubjectFromUnknownTopic(topic);
  }
  if (topic.entityType === "match") {
    return topic.entity.replace(/-vs-/g, " vs ").replace(/-/g, " ");
  }
  return topic.entity.replace(/-/g, " ");
}

function candidateIntentAnchor(topic: TopicSummaryRow): string | null {
  if (MENTION_MARKET_PATTERN.test(topic.sampleEventTitle ?? "")) {
    const mentionAnchor =
      extractMentionTarget(topic.sampleEventTitle ?? "") ??
      extractMentionTarget(topic.sampleMarketTitle ?? "") ??
      (topic.entity !== "unknown" ? topic.entity : null);
    if (mentionAnchor) {
      return normalizeSlug(mentionAnchor);
    }
  }
  if (topic.archetype !== "candidate_list") return null;
  const source = compactWhitespace(topic.sampleEventTitle ?? "");
  if (!source) return null;
  const normalized = normalizeTitle(source, topic.category);
  const tokens = tokenizeNormalized(normalized)
    .filter((token) => !QUESTION_ENTITY_BLOCKLIST.has(token))
    .filter((token) => !KEYWORD_NOISE.has(token))
    .filter((token) => !MENTION_STOP_TOKENS.has(token))
    .filter((token) => !GENERIC_TOKENS.has(token))
    .filter((token) => !MONTH_TOKENS.has(token))
    .filter((token) => !DAY_TOKENS.has(token));
  if (tokens.length === 0) return null;
  return tokens.slice(0, 8).join("-");
}

function searchIntentKey(topic: TopicSummaryRow): string {
  const constraintClass = constraintClassForConstraint(topic.constraint);
  if (topic.entity === "unknown") {
    return `${topic.category}|unknown|${topic.topicKey}`;
  }
  if (topic.archetype === "candidate_list") {
    const anchor = candidateIntentAnchor(topic);
    if (anchor) {
      return `${topic.category}|candidate_list|${anchor}`;
    }
  }
  if (constraintClass !== "none") {
    return `${topic.category}|${topic.entityType}|${topic.entity}|${constraintClass}`;
  }
  return `${topic.category}|${topic.entityType}|${topic.entity}`;
}

function constraintClassForConstraint(constraint: Constraint): string {
  switch (constraint.kind) {
    case "threshold":
      return `threshold_${constraint.unit}_${constraint.operator}`;
    case "range":
      return `range_${constraint.unit}`;
    case "ou":
      return `ou_${constraint.operator}`;
    case "spread":
      return "spread_eq";
    default:
      return "none";
  }
}

function normalizeSearchTopicForIntent(
  topic: TopicSummaryRow,
): TopicSummaryRow {
  if (topic.archetype !== "candidate_list") return topic;
  const anchor = candidateIntentAnchor(topic);
  if (!anchor) return topic;
  return {
    ...topic,
    entityType: "keyword",
    entity: anchor,
    entitySource: "event",
    unknownReason: null,
  };
}

function isSearchTopicEligible(topic: TopicSummaryRow, args: Args): boolean {
  if (topic.marketCount < args.searchMinMarketCount) return false;
  if (topic.category === "sports" && topic.entity === "unknown") return false;
  if (
    topic.category === "sports" &&
    topic.entityType === "keyword" &&
    topic.marketCount < args.sportsKeywordMinMarketCount
  ) {
    return false;
  }
  return true;
}

function candidateContextSuffix(topic: TopicSummaryRow): string {
  if (topic.archetype !== "candidate_list") return "";
  const uniqueCandidates = Array.from(
    new Set(
      topic.candidateEntities
        .map((value) => normalizeSlug(value))
        .filter((value) => value && !isPlaceholderEntitySlug(value))
        .filter((value) => value !== "unknown"),
    ),
  );
  if (uniqueCandidates.length === 0) return "";
  const rendered = uniqueCandidates
    .slice(0, 6)
    .map((value) => value.replace(/-/g, " "));
  return ` Candidate set: ${rendered.join(", ")}.`;
}

function dedupeTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const normalized = compactWhitespace(term.toLowerCase());
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(term.trim());
  }
  return out;
}

function topicIntentAnchor(topic: TopicSummaryRow): string {
  const candidateAnchor = candidateIntentAnchor(topic);
  if (candidateAnchor) return candidateAnchor.replace(/-/g, " ");
  return entityTerm(topic);
}

function topicAliasTerms(topic: TopicSummaryRow, anchor: string): string[] {
  const context =
    `${topic.sampleEventTitle ?? ""} ${topic.sampleMarketTitle ?? ""}`.toLowerCase();
  const aliases: string[] = [];

  if (topic.category === "crypto") {
    const lowerEntity = topic.entity.toLowerCase();
    const lowerAnchor = anchor.toLowerCase();
    if (lowerEntity.includes("bitcoin") || lowerAnchor.includes("bitcoin")) {
      aliases.push("btc", "bitcoin price", "spot bitcoin");
    } else if (
      lowerEntity.includes("ethereum") ||
      lowerEntity === "eth" ||
      lowerAnchor.includes("ethereum")
    ) {
      aliases.push("eth", "ethereum price", "spot ethereum");
    } else if (
      lowerEntity.includes("solana") ||
      lowerAnchor.includes("solana")
    ) {
      aliases.push("sol", "solana price");
    } else if (
      lowerEntity.includes("dogecoin") ||
      lowerAnchor.includes("dogecoin")
    ) {
      aliases.push("doge", "dogecoin price");
    } else if (lowerEntity.includes("xrp") || lowerAnchor.includes("xrp")) {
      aliases.push("ripple", "xrp price");
    }
  }

  if (topic.category === "politics") {
    if (
      context.includes("fed chair") ||
      context.includes("federal reserve") ||
      context.includes("powell")
    ) {
      aliases.push(
        "federal reserve chair",
        "fed chair",
        "powell successor",
        "fomc leadership",
      );
    }
    if (
      /\b(election|poll|polling|primary|nominee|vote|voter|senate|house|governor|president)\b/.test(
        context,
      )
    ) {
      aliases.push("polling update", "campaign statement", "official filing");
    }
  }

  if (topic.category === "sports") {
    aliases.push("injury report", "lineup update", "official status");
  }

  return dedupeTerms(aliases).slice(0, 8);
}

function constraintTerms(topic: TopicSummaryRow): string[] {
  const constraint = formatConstraintForQuery(topic.constraint);
  if (!constraint) return [];
  return [constraint];
}

function buildTermInstruction(
  mustTerms: string[],
  optionalTerms: string[],
  aliasTerms: string[],
): string {
  const parts: string[] = [];
  if (mustTerms.length > 0) {
    parts.push(`Must terms: ${mustTerms.join(", ")}.`);
  }
  if (optionalTerms.length > 0) {
    parts.push(`Optional terms: ${optionalTerms.join(", ")}.`);
  }
  if (aliasTerms.length > 0) {
    parts.push(`Alias terms: ${aliasTerms.join(", ")}.`);
  }
  return parts.join(" ");
}

function lookbackHoursForTier(tier: "A" | "B" | "C", args: Args): number {
  if (tier === "A") return args.tierALookbackHours;
  if (tier === "B") return args.tierBLookbackHours;
  return args.tierCLookbackHours;
}

function isoDateDaysAgo(daysAgo: number): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - daysAgo);
  return now.toISOString().slice(0, 10);
}

function buildSearchQueries(
  topic: TopicSummaryRow,
  tier: "A" | "B" | "C",
  args: Args,
): {
  promptCombined: string;
  webSearchTool: {
    type: "web_search";
    filters: {
      excluded_domains?: string[];
    };
  };
  xSearchTool: {
    type: "x_search";
    from_date: string;
    to_date: string;
    excluded_x_handles?: string[];
  };
  retrievalPlan: {
    intentAnchor: string;
    mustTerms: string[];
    optionalTerms: string[];
    aliasTerms: string[];
    minEvidence: number;
    strict: {
      combinedPrompt: string;
    };
  };
} {
  const entity = entityTerm(topic);
  const constraint = formatConstraintForQuery(topic.constraint);
  const suffix = constraint ? ` Constraint: ${constraint}.` : "";
  const candidateSuffix = candidateContextSuffix(topic);
  const intentAnchor = topicIntentAnchor(topic);
  const candidateTerms = topic.candidateEntities
    .map((value) => value.replace(/-/g, " "))
    .filter((value) => value && value !== "unknown")
    .slice(0, 6);
  const mustTerms = dedupeTerms([
    intentAnchor,
    ...constraintTerms(topic),
  ]).slice(0, 4);
  const optionalTerms = dedupeTerms(candidateTerms).slice(0, 8);
  const aliasTerms = topicAliasTerms(topic, intentAnchor);
  const termInstruction = buildTermInstruction(
    mustTerms,
    optionalTerms,
    aliasTerms,
  );
  const lookbackHours = lookbackHoursForTier(tier, args);
  const lookbackDays = Math.max(1, Math.ceil(lookbackHours / 24));
  const fromDate = isoDateDaysAgo(lookbackDays);
  const toDate = isoDateDaysAgo(0);
  const webFilters =
    args.webExcludedDomains.length > 0
      ? { excluded_domains: args.webExcludedDomains.slice(0, 5) }
      : {};
  const xExcludedHandles =
    args.xExcludedHandles.length > 0
      ? args.xExcludedHandles.slice(0, 10)
      : undefined;

  const withInstructions = (base: string): string =>
    compactWhitespace(`${base} ${termInstruction}`);

  if (topic.category === "crypto") {
    const strictCombined = withInstructions(
      `Use web_search and x_search together to collect verifiable evidence from the last ${lookbackHours} hours about ${entity}. Prioritize concrete catalysts and primary sources. Return only evidence directly relevant to the topic.${candidateSuffix}${suffix}`,
    );
    return {
      promptCombined: strictCombined,
      webSearchTool: {
        type: "web_search",
        filters: webFilters,
      },
      xSearchTool: {
        type: "x_search",
        from_date: fromDate,
        to_date: toDate,
        ...(xExcludedHandles ? { excluded_x_handles: xExcludedHandles } : {}),
      },
      retrievalPlan: {
        intentAnchor,
        mustTerms,
        optionalTerms,
        aliasTerms,
        minEvidence: 2,
        strict: {
          combinedPrompt: strictCombined,
        },
      },
    };
  }
  if (topic.category === "politics") {
    const context =
      `${topic.sampleEventTitle ?? ""} ${topic.sampleMarketTitle ?? ""}`.toLowerCase();
    const electionLike =
      entity.includes("election") ||
      /\b(election|elect|poll|polling|primary|nominee|vote|voter|governor|president|senate|house)\b/.test(
        context,
      );
    const politicsStem = electionLike ? `${entity} election` : entity;
    const focusLine = electionLike
      ? "Focus on polling, endorsements, fundraising, legal rulings, filings, and official statements."
      : "Focus on official statements, policy/legal decisions, sanctions, diplomatic developments, and verifiable timeline changes.";
    const strictCombined = withInstructions(
      `Use web_search and x_search together to gather verifiable political evidence from the last ${lookbackHours} hours for ${politicsStem}. ${focusLine} Prioritize official statements, filings, and major newsroom coverage.${candidateSuffix}${suffix}`,
    );
    return {
      promptCombined: strictCombined,
      webSearchTool: {
        type: "web_search",
        filters: webFilters,
      },
      xSearchTool: {
        type: "x_search",
        from_date: fromDate,
        to_date: toDate,
        ...(xExcludedHandles ? { excluded_x_handles: xExcludedHandles } : {}),
      },
      retrievalPlan: {
        intentAnchor,
        mustTerms,
        optionalTerms,
        aliasTerms,
        minEvidence: 2,
        strict: {
          combinedPrompt: strictCombined,
        },
      },
    };
  }
  if (topic.category === "sports") {
    const strictCombined = withInstructions(
      `Use web_search and x_search together to gather sports evidence from the last ${lookbackHours} hours about ${entity}. Focus on injuries, lineup/status changes, suspensions, and official announcements.${candidateSuffix}${suffix}`,
    );
    return {
      promptCombined: strictCombined,
      webSearchTool: {
        type: "web_search",
        filters: webFilters,
      },
      xSearchTool: {
        type: "x_search",
        from_date: fromDate,
        to_date: toDate,
        ...(xExcludedHandles ? { excluded_x_handles: xExcludedHandles } : {}),
      },
      retrievalPlan: {
        intentAnchor,
        mustTerms,
        optionalTerms,
        aliasTerms,
        minEvidence: 2,
        strict: {
          combinedPrompt: strictCombined,
        },
      },
    };
  }
  const strictCombined = withInstructions(
    `Use web_search and x_search together to gather verifiable evidence from the last ${lookbackHours} hours about ${entity}. Keep only directly relevant claims with sources.${candidateSuffix}${suffix}`,
  );
  return {
    promptCombined: strictCombined,
    webSearchTool: {
      type: "web_search",
      filters: webFilters,
    },
    xSearchTool: {
      type: "x_search",
      from_date: fromDate,
      to_date: toDate,
      ...(xExcludedHandles ? { excluded_x_handles: xExcludedHandles } : {}),
    },
    retrievalPlan: {
      intentAnchor,
      mustTerms,
      optionalTerms,
      aliasTerms,
      minEvidence: 1,
      strict: {
        combinedPrompt: strictCombined,
      },
    },
  };
}

function tierForTopicThreshold(
  topic: TopicSummaryRow,
  args: Args,
): "A" | "B" | "C" {
  if (topic.marketCount >= args.tierAMarketThreshold) return "A";
  if (topic.marketCount >= args.tierBMarketThreshold) return "B";
  return "C";
}

function daysSinceTimeBucket(timeBucket: string): number {
  const parsed = new Date(`${timeBucket}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return 9999;
  const now = Date.now();
  const diffMs = now - parsed.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function entityPrecisionWeight(topic: TopicSummaryRow): number {
  if (topic.entity === "unknown") return 0;
  if (topic.entityType === "ticker") return 1;
  if (topic.entityType === "person") return 0.95;
  if (topic.entityType === "country") return 0.92;
  if (topic.entityType === "match") return 0.9;
  return 0.75;
}

function archetypeWeight(topic: TopicSummaryRow): number {
  if (topic.archetype === "generic") return 1;
  if (topic.archetype === "head_to_head") return 0.95;
  if (topic.archetype === "competition_winner") return 0.9;
  return 0.85;
}

function recencyScore(topic: TopicSummaryRow): number {
  const days = daysSinceTimeBucket(topic.timeBucket);
  if (days <= 1) return 1;
  if (days <= 7) return 0.8;
  if (days <= 30) return 0.6;
  if (days <= 90) return 0.35;
  if (days <= 365) return 0.2;
  return 0.05;
}

function topicScore(
  topic: TopicSummaryRow,
  context: {
    maxMarketCount: number;
    maxEventCount: number;
    maxVenueCount: number;
    maxCandidateCount: number;
  },
): number {
  const marketNorm = Math.sqrt(topic.marketCount / context.maxMarketCount);
  const eventNorm = Math.sqrt(topic.eventCount / context.maxEventCount);
  const venueNorm = topic.venueCount / context.maxVenueCount;
  const candidateNorm =
    context.maxCandidateCount > 0
      ? Math.min(1, topic.candidateEntities.length / context.maxCandidateCount)
      : 0;
  const constraintSignal = topic.constraint.kind === "none" ? 0 : 1;

  const raw =
    45 * marketNorm +
    20 * eventNorm +
    10 * venueNorm +
    10 * recencyScore(topic) +
    7 * candidateNorm +
    8 * constraintSignal +
    5 * entityPrecisionWeight(topic) +
    5 * archetypeWeight(topic);
  return Number(raw.toFixed(3));
}

function assignTiersByThreshold(
  topics: TopicSummaryRow[],
  args: Args,
): TierAssignment {
  const byPriority = [...topics].sort((a, b) => {
    if (b.marketCount !== a.marketCount) return b.marketCount - a.marketCount;
    if (b.eventCount !== a.eventCount) return b.eventCount - a.eventCount;
    return a.topicKey.localeCompare(b.topicKey);
  });

  const tiers = new Map<string, "A" | "B" | "C">();
  const scores = new Map<string, number>();
  for (const topic of byPriority) {
    const baseTier = tierForTopicThreshold(topic, args);
    // Keep unresolved topics out of Tier A to avoid over-refreshing low-signal entities.
    const tier =
      topic.entity === "unknown" && baseTier === "A" ? "B" : baseTier;
    tiers.set(topic.topicKey, tier);
    scores.set(topic.topicKey, topic.marketCount);
  }

  if (args.tierAutoPromoteA) {
    const hasA = Array.from(tiers.values()).includes("A");
    if (!hasA) {
      const candidate = byPriority.find((topic) => {
        if (topic.entity === "unknown") return false;
        return topic.marketCount >= args.tierAutoPromoteAMinMarketCount;
      });
      if (candidate) tiers.set(candidate.topicKey, "A");
    }
  }

  if (args.tierAutoPromoteB) {
    const currentB = Array.from(tiers.values()).filter((t) => t === "B").length;
    if (currentB < args.tierAutoPromoteBMinTopics) {
      let need = args.tierAutoPromoteBMinTopics - currentB;
      for (const topic of byPriority) {
        if (need <= 0) break;
        if (topic.entity === "unknown") continue;
        if (topic.marketCount < args.tierAutoPromoteBMinMarketCount) continue;
        const existing = tiers.get(topic.topicKey);
        if (existing !== "C") continue;
        tiers.set(topic.topicKey, "B");
        need -= 1;
      }
    }
  }

  return { tiers, scores };
}

function assignTiersByScore(
  topics: TopicSummaryRow[],
  args: Args,
): TierAssignment {
  const context = {
    maxMarketCount: Math.max(1, ...topics.map((topic) => topic.marketCount)),
    maxEventCount: Math.max(1, ...topics.map((topic) => topic.eventCount)),
    maxVenueCount: Math.max(1, ...topics.map((topic) => topic.venueCount)),
    maxCandidateCount: Math.max(
      1,
      ...topics.map((topic) => topic.candidateEntities.length),
    ),
  };

  const scored = topics
    .map((topic) => ({
      topic,
      score: topicScore(topic, context),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.topic.marketCount !== a.topic.marketCount) {
        return b.topic.marketCount - a.topic.marketCount;
      }
      if (b.topic.eventCount !== a.topic.eventCount) {
        return b.topic.eventCount - a.topic.eventCount;
      }
      return a.topic.topicKey.localeCompare(b.topic.topicKey);
    });

  const scores = new Map<string, number>();
  for (const item of scored) {
    scores.set(item.topic.topicKey, item.score);
  }

  const tiers = new Map<string, "A" | "B" | "C">();
  const totalTopics = scored.length;
  const targetA = Math.max(1, Math.ceil(totalTopics * args.tierScoreAFraction));
  const requestedB = Math.max(
    args.tierAutoPromoteBMinTopics,
    Math.ceil(totalTopics * args.tierScoreBFraction),
  );
  const targetB = Math.max(0, Math.min(totalTopics - targetA, requestedB));

  let assignedA = 0;
  let assignedB = 0;
  for (const item of scored) {
    const topic = item.topic;
    const score = item.score;
    if (topic.entity === "unknown") {
      tiers.set(topic.topicKey, "C");
      continue;
    }

    if (assignedA < targetA && score >= args.tierScoreAMin) {
      tiers.set(topic.topicKey, "A");
      assignedA += 1;
      continue;
    }

    if (assignedB < targetB && score >= args.tierScoreBMin) {
      tiers.set(topic.topicKey, "B");
      assignedB += 1;
      continue;
    }

    tiers.set(topic.topicKey, "C");
  }

  if (args.tierAutoPromoteA && assignedA === 0) {
    for (const item of scored) {
      const topic = item.topic;
      if (topic.entity === "unknown") continue;
      if (topic.marketCount < args.tierAutoPromoteAMinMarketCount) continue;
      const previous = tiers.get(topic.topicKey);
      if (previous === "B") {
        assignedB = Math.max(0, assignedB - 1);
      }
      tiers.set(topic.topicKey, "A");
      assignedA = 1;
      break;
    }
  }

  if (args.tierAutoPromoteB && assignedB < args.tierAutoPromoteBMinTopics) {
    let need = args.tierAutoPromoteBMinTopics - assignedB;
    for (const item of scored) {
      if (need <= 0) break;
      const topic = item.topic;
      if (topic.entity === "unknown") continue;
      if (topic.marketCount < args.tierAutoPromoteBMinMarketCount) continue;
      const existing = tiers.get(topic.topicKey);
      if (existing !== "C") continue;
      tiers.set(topic.topicKey, "B");
      need -= 1;
    }
  }

  return { tiers, scores };
}

function assignTiers(topics: TopicSummaryRow[], args: Args): TierAssignment {
  if (args.tieringMode === "threshold") {
    return assignTiersByThreshold(topics, args);
  }
  return assignTiersByScore(topics, args);
}

function cadenceForTier(tier: "A" | "B" | "C", args: Args): number {
  if (tier === "A") return args.tierACadenceMinutes;
  if (tier === "B") return args.tierBCadenceMinutes;
  return args.tierCCadenceMinutes;
}

function bucketMinutesForTier(tier: "A" | "B" | "C"): number {
  if (tier === "A") return 5;
  if (tier === "B") return 15;
  return 60;
}

function countsForTier(
  tier: "A" | "B" | "C",
  args: Args,
): { combinedCount: number } {
  if (tier === "C" && !args.tierCEnabled) {
    return { combinedCount: 0 };
  }

  if (tier === "A") return { combinedCount: args.tierACombinedCount };
  if (tier === "B") return { combinedCount: args.tierBCombinedCount };
  return { combinedCount: args.tierCCombinedCount };
}

function windowForTier(
  tier: "A" | "B" | "C",
  args: Args,
): { lookbackHours: number; fromDate: string; toDate: string } {
  const lookbackHours = lookbackHoursForTier(tier, args);
  const lookbackDays = Math.max(1, Math.ceil(lookbackHours / 24));
  return {
    lookbackHours,
    fromDate: isoDateDaysAgo(lookbackDays),
    toDate: isoDateDaysAgo(0),
  };
}

async function main(): Promise<void> {
  const args = resolveArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const [rows, activeVenueDistribution] = await Promise.all([
    fetchRows(args),
    fetchActiveVenueDistribution(args),
  ]);
  const sampleVenueDistribution = rows.reduce<Record<string, number>>(
    (acc, row) => {
      acc[row.venue] = (acc[row.venue] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const topicMap = new Map<string, TopicAggregate>();
  const fingerprintToConstraints = new Map<string, Set<string>>();
  let skippedByCategory = 0;

  for (const row of rows) {
    const built = buildTopicFromRow(row);
    if (
      args.categories.length > 0 &&
      !args.categories.includes(built.category)
    ) {
      skippedByCategory += 1;
      continue;
    }

    let aggregate = topicMap.get(built.topicKey);
    if (!aggregate) {
      aggregate = {
        topicKey: built.topicKey,
        category: built.category,
        entityType: built.entityType,
        entity: built.entity,
        archetype: built.archetype,
        entitySource: built.entitySource,
        unknownReason: built.unknownReason,
        constraint: built.constraint,
        constraintHash: built.constraintHash,
        timeBucket: built.timeBucket,
        venues: new Set(),
        marketIds: new Set(),
        eventIds: new Set(),
        sampleEventId: row.event_id,
        sampleMarketId: row.market_id,
        sampleVenue: row.venue,
        sampleEventTitle: row.event_title,
        sampleMarketTitle: row.market_title,
        sampleEventStatus: row.event_status,
        sampleEventEndDate: row.event_end_date,
        sampleMarketUpdatedAt: row.market_updated_at,
        candidateEntities: new Set(),
        sourceTopicKeys: new Set(),
      };
      topicMap.set(built.topicKey, aggregate);
    }
    aggregate.venues.add(row.venue);
    aggregate.marketIds.add(row.market_id);
    aggregate.eventIds.add(row.event_id);
    aggregate.sourceTopicKeys.add(built.topicKey);
    if (built.archetype === "candidate_list" && built.entity !== "unknown") {
      aggregate.candidateEntities.add(built.entity);
    }

    const fingerprint = `${built.category}|${built.entityType}|${built.entity}|${built.timeBucket}`;
    const set = fingerprintToConstraints.get(fingerprint) ?? new Set<string>();
    set.add(built.constraintHash);
    fingerprintToConstraints.set(fingerprint, set);
  }

  const topics: TopicSummaryRow[] = Array.from(topicMap.values())
    .map((topic) => ({
      topicKey: topic.topicKey,
      category: topic.category,
      entityType: topic.entityType,
      entity: topic.entity,
      archetype: topic.archetype,
      entitySource: topic.entitySource,
      unknownReason: topic.unknownReason,
      constraint: topic.constraint,
      constraintHash: topic.constraintHash,
      timeBucket: topic.timeBucket,
      marketCount: topic.marketIds.size,
      eventCount: topic.eventIds.size,
      venueCount: topic.venues.size,
      venues: Array.from(topic.venues).sort(),
      sampleEventId: topic.sampleEventId,
      sampleMarketId: topic.sampleMarketId,
      sampleVenue: topic.sampleVenue,
      sampleEventTitle: topic.sampleEventTitle,
      sampleMarketTitle: topic.sampleMarketTitle,
      sampleEventStatus: topic.sampleEventStatus,
      sampleEventEndDate: topic.sampleEventEndDate,
      sampleMarketUpdatedAt: topic.sampleMarketUpdatedAt,
      candidateEntities: Array.from(topic.candidateEntities).sort(),
      sourceTopicKeys: Array.from(topic.sourceTopicKeys).sort(),
    }))
    .sort((a, b) => b.marketCount - a.marketCount);

  const searchTopicMap = new Map<string, TopicSummaryRow>();
  for (const topic of topics) {
    if (!args.searchCategories.includes(topic.category)) continue;
    const isUnknown = topic.entity === "unknown";
    if (isUnknown && !args.includeUnknownTopics) continue;
    if (isUnknown && topic.marketCount < args.unknownMinMarketCount) continue;
    const searchKey = searchIntentKey(topic);
    const existing = searchTopicMap.get(searchKey);
    if (!existing) {
      searchTopicMap.set(searchKey, {
        ...topic,
        venues: [...topic.venues],
        candidateEntities: [...topic.candidateEntities],
        sourceTopicKeys: [...topic.sourceTopicKeys],
        searchIntentKey: searchKey,
      });
      continue;
    }

    const merged: TopicSummaryRow = {
      ...existing,
      marketCount: existing.marketCount + topic.marketCount,
      eventCount: existing.eventCount + topic.eventCount,
      venueCount: new Set([...existing.venues, ...topic.venues]).size,
      venues: Array.from(new Set([...existing.venues, ...topic.venues])).sort(),
      candidateEntities: Array.from(
        new Set([...existing.candidateEntities, ...topic.candidateEntities]),
      ).sort(),
      sourceTopicKeys: Array.from(
        new Set([...existing.sourceTopicKeys, ...topic.sourceTopicKeys]),
      ).sort(),
      searchIntentKey: searchKey,
    };

    if (
      topic.marketCount > existing.marketCount ||
      (topic.marketCount === existing.marketCount &&
        topic.topicKey.localeCompare(existing.topicKey) < 0)
    ) {
      merged.topicKey = topic.topicKey;
      merged.constraint = topic.constraint;
      merged.constraintHash = topic.constraintHash;
      merged.timeBucket = topic.timeBucket;
      merged.sampleEventId = topic.sampleEventId;
      merged.sampleMarketId = topic.sampleMarketId;
      merged.sampleVenue = topic.sampleVenue;
      merged.sampleEventTitle = topic.sampleEventTitle;
      merged.sampleMarketTitle = topic.sampleMarketTitle;
      merged.sampleEventStatus = topic.sampleEventStatus;
      merged.sampleEventEndDate = topic.sampleEventEndDate;
      merged.sampleMarketUpdatedAt = topic.sampleMarketUpdatedAt;
      merged.archetype = topic.archetype;
      merged.entitySource = topic.entitySource;
      merged.unknownReason = topic.unknownReason;
    }
    searchTopicMap.set(searchKey, merged);
  }

  const searchTopics = Array.from(searchTopicMap.values())
    .map((topic) => normalizeSearchTopicForIntent(topic))
    .filter((topic) => isSearchTopicEligible(topic, args))
    .sort((a, b) => b.marketCount - a.marketCount)
    .slice(0, args.maxSearchTopics);
  const tierAssignment = assignTiers(searchTopics, args);
  const topicTiers = tierAssignment.tiers;
  const topicScores = tierAssignment.scores;

  const tierCounts = searchTopics.reduce<Record<"A" | "B" | "C", number>>(
    (acc, topic) => {
      const tier = topicTiers.get(topic.topicKey) ?? "C";
      if (tier === "C" && !args.tierCEnabled) return acc;
      acc[tier] += 1;
      return acc;
    },
    { A: 0, B: 0, C: 0 },
  );

  const topicSearchPreview = searchTopics
    .slice(0, args.showQueries)
    .map((topic) => {
      const tier = topicTiers.get(topic.topicKey) ?? "C";
      const cadenceMinutes = cadenceForTier(tier, args);
      const lookback = windowForTier(tier, args);
      const queries = buildSearchQueries(topic, tier, args);
      const pack = countsForTier(tier, args);
      const enabledPrompts: string[] = [];
      if (pack.combinedCount > 0) {
        enabledPrompts.push("prompt_combined");
      }
      return {
        topicKey: topic.topicKey,
        tier,
        cadenceMinutes,
        lookbackHours: lookback.lookbackHours,
        category: topic.category,
        entity: `${topic.entityType}:${topic.entity}`,
        searchIntentKey: topic.searchIntentKey ?? searchIntentKey(topic),
        constraintClass: constraintClassForConstraint(topic.constraint),
        archetype: topic.archetype,
        entitySource: topic.entitySource,
        unknownReason: topic.unknownReason,
        marketCount: topic.marketCount,
        sampleEventId: topic.sampleEventId,
        sampleMarketId: topic.sampleMarketId,
        sampleVenue: topic.sampleVenue,
        sampleEventStatus: topic.sampleEventStatus,
        sampleEventEndDate: topic.sampleEventEndDate,
        sampleMarketUpdatedAt: topic.sampleMarketUpdatedAt,
        tierScore: topicScores.get(topic.topicKey) ?? null,
        candidateEntities: topic.candidateEntities.slice(0, 10),
        promptCombined: queries.promptCombined,
        retrievalPlan: queries.retrievalPlan,
        webSearchTool: queries.webSearchTool,
        xSearchTool: queries.xSearchTool,
        pack: {
          combinedCount: pack.combinedCount,
          mode: tier === "B" ? args.tierBMode : "normal",
          enabledPrompts,
        },
        xSearchWindow: {
          fromDate: lookback.fromDate,
          toDate: lookback.toDate,
          lookbackHours: lookback.lookbackHours,
        },
        schedule: {
          bucketMinutes: bucketMinutesForTier(tier),
        },
      };
    });

  const modeledTopicMarketCounts = searchTopics.map(
    (topic) => topic.marketCount,
  );
  const modeledAgesHours = searchTopics
    .map((topic) => {
      const ts = topic.sampleMarketUpdatedAt
        ? new Date(topic.sampleMarketUpdatedAt).getTime()
        : Number.NaN;
      if (!Number.isFinite(ts)) return null;
      return Math.max(0, (Date.now() - ts) / (1000 * 3600));
    })
    .filter((value): value is number => value != null);

  const modeledByCategory = searchTopics.reduce<Record<string, number>>(
    (acc, topic) => {
      acc[topic.category] = (acc[topic.category] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const modeledByVenue = searchTopics.reduce<Record<string, number>>(
    (acc, topic) => {
      for (const venue of topic.venues) {
        acc[venue] = (acc[venue] ?? 0) + 1;
      }
      return acc;
    },
    {},
  );

  const demotionPreview = args.emitDemotionPreview
    ? (() => {
        const suggestions = searchTopics
          .map((topic) => {
            const currentTier = topicTiers.get(topic.topicKey) ?? "C";
            const reasons: string[] = [];
            let riskScore = 0;

            if (topic.unknownReason) {
              reasons.push(`unknown_reason:${topic.unknownReason}`);
              riskScore += 4;
            }
            if (topic.marketCount <= 2) {
              reasons.push("low_market_count");
              riskScore += 3;
            } else if (topic.marketCount <= 4) {
              reasons.push("thin_market_count");
              riskScore += 1;
            }
            if (
              topic.category === "politics" &&
              topic.archetype === "candidate_list"
            ) {
              reasons.push("candidate_list_low_hit_risk");
              riskScore += 2;
            }
            const ageHours = topic.sampleMarketUpdatedAt
              ? Math.max(
                  0,
                  (Date.now() -
                    new Date(topic.sampleMarketUpdatedAt).getTime()) /
                    (1000 * 3600),
                )
              : null;
            if (ageHours != null && ageHours > 12) {
              reasons.push("sample_age_gt_12h");
              riskScore += 1;
            }

            let suggestedTier = currentTier;
            let action = "keep";
            if (riskScore >= 6) {
              suggestedTier =
                currentTier === "A" ? "B" : currentTier === "B" ? "C" : "C";
              action = suggestedTier === currentTier ? "monitor" : "demote";
            } else if (riskScore >= 4 && currentTier === "A") {
              suggestedTier = "B";
              action = "demote";
            }

            return {
              topicKey: topic.topicKey,
              entity: `${topic.entityType}:${topic.entity}`,
              category: topic.category,
              currentTier,
              suggestedTier,
              riskScore,
              action,
              reasons,
              marketCount: topic.marketCount,
              sampleVenue: topic.sampleVenue,
            };
          })
          .filter((item) => item.action !== "keep")
          .sort((a, b) => b.riskScore - a.riskScore);

        return {
          enabled: true,
          candidateCount: suggestions.length,
          byAction: suggestions.reduce<Record<string, number>>((acc, item) => {
            acc[item.action] = (acc[item.action] ?? 0) + 1;
            return acc;
          }, {}),
          topCandidates: suggestions.slice(0, 30),
        };
      })()
    : {
        enabled: false,
      };

  const estimatedDailyRawByTier = searchTopics.reduce<
    Record<"A" | "B" | "C", number>
  >(
    (acc, topic) => {
      const tier = topicTiers.get(topic.topicKey) ?? "C";
      if (tier === "C" && !args.tierCEnabled) return acc;
      const cadence = cadenceForTier(tier, args);
      const runsPerDay = 1440 / cadence;
      const pack = countsForTier(tier, args);
      const queriesPerRefresh = pack.combinedCount;
      acc[tier] += runsPerDay * queriesPerRefresh;
      return acc;
    },
    { A: 0, B: 0, C: 0 },
  );

  const estimatedDailyRaw =
    estimatedDailyRawByTier.A +
    estimatedDailyRawByTier.B +
    estimatedDailyRawByTier.C;
  const estimatedDailyRawCalls = estimatedDailyRaw;
  const estimatedDailyNetCalls =
    estimatedDailyRawCalls * (1 - args.cacheHitRate);
  const estimatedHourlyRawCalls = estimatedDailyRawCalls / 24;
  const estimatedHourlyNetCalls = estimatedDailyNetCalls / 24;

  const rowsUsed = rows.length - skippedByCategory;
  const duplicates = Math.max(0, rowsUsed - topics.length);
  const duplicateRate = rowsUsed > 0 ? duplicates / rowsUsed : 0;
  const nowMs = Date.now();
  const nonActiveSamples = searchTopics.filter(
    (item) => (item.sampleEventStatus ?? "").toUpperCase() !== "ACTIVE",
  ).length;
  const endedSamples = searchTopics.filter((item) => {
    if (!item.sampleEventEndDate) return false;
    const ts = new Date(item.sampleEventEndDate).getTime();
    return Number.isFinite(ts) && ts <= nowMs;
  }).length;
  const staleSamples6h = searchTopics.filter((item) => {
    if (!item.sampleMarketUpdatedAt) return false;
    const ts = new Date(item.sampleMarketUpdatedAt).getTime();
    return Number.isFinite(ts) && nowMs - ts > 6 * 3600 * 1000;
  }).length;
  const staleSamples24h = searchTopics.filter((item) => {
    if (!item.sampleMarketUpdatedAt) return false;
    const ts = new Date(item.sampleMarketUpdatedAt).getTime();
    return Number.isFinite(ts) && nowMs - ts > 24 * 3600 * 1000;
  }).length;
  const invariantViolations = nonActiveSamples + endedSamples;

  const constraintCollisions = Array.from(fingerprintToConstraints.entries())
    .filter(([, constraints]) => constraints.size > 1)
    .map(([fingerprint, constraints]) => ({
      fingerprint,
      constraintVariants: constraints.size,
    }))
    .sort((a, b) => b.constraintVariants - a.constraintVariants);

  const summary = {
    qaContract: {
      version: QA_CONTRACT_VERSION,
      script: "ai-topics-dry-run",
      generatedAt: new Date().toISOString(),
    },
    generatedAt: new Date().toISOString(),
    options: args,
    totals: {
      rowsFetched: rows.length,
      rowsUsed,
      skippedByCategory,
      uniqueTopics: topics.length,
      uniqueSearchTopics: searchTopicMap.size,
      duplicateRows: duplicates,
      duplicateRate,
      constraintCollisions: constraintCollisions.length,
    },
    venues: {
      sample: sampleVenueDistribution,
      activePopulation: activeVenueDistribution,
    },
    searchPlan: {
      assumptions: {
        searchCategories: args.searchCategories,
        minVolume24h: args.minVolume24h,
        minLiquidity: args.minLiquidity,
        maxSpread: args.maxSpread,
        requireOpenNow: args.requireOpenNow,
        orderBy: args.orderBy,
        includeUnknownTopics: args.includeUnknownTopics,
        unknownMinMarketCount: args.unknownMinMarketCount,
        searchMinMarketCount: args.searchMinMarketCount,
        maxMarketAgeHours: args.maxMarketAgeHours,
        sportsKeywordMinMarketCount: args.sportsKeywordMinMarketCount,
        cacheHitRate: args.cacheHitRate,
        tierAMarketThreshold: args.tierAMarketThreshold,
        tierBMarketThreshold: args.tierBMarketThreshold,
        tieringMode: args.tieringMode,
        tierScoreAFraction: args.tierScoreAFraction,
        tierScoreBFraction: args.tierScoreBFraction,
        tierScoreAMin: args.tierScoreAMin,
        tierScoreBMin: args.tierScoreBMin,
        tierACadenceMinutes: args.tierACadenceMinutes,
        tierBCadenceMinutes: args.tierBCadenceMinutes,
        tierCCadenceMinutes: args.tierCCadenceMinutes,
        tierACombinedCount: args.tierACombinedCount,
        tierBCombinedCount: args.tierBCombinedCount,
        tierCCombinedCount: args.tierCCombinedCount,
        tierALookbackHours: args.tierALookbackHours,
        tierBLookbackHours: args.tierBLookbackHours,
        tierCLookbackHours: args.tierCLookbackHours,
        tierAWebCount: args.tierAWebCount,
        tierAXCount: args.tierAXCount,
        tierBWebCount: args.tierBWebCount,
        tierBXCount: args.tierBXCount,
        tierBMode: args.tierBMode,
        tierCWebCount: args.tierCWebCount,
        tierCXCount: args.tierCXCount,
        tierCEnabled: args.tierCEnabled,
        tierAutoPromoteA: args.tierAutoPromoteA,
        tierAutoPromoteB: args.tierAutoPromoteB,
        tierAutoPromoteBMinTopics: args.tierAutoPromoteBMinTopics,
        tierAutoPromoteBMinMarketCount: args.tierAutoPromoteBMinMarketCount,
        tierAutoPromoteAMinMarketCount: args.tierAutoPromoteAMinMarketCount,
        webExcludedDomains: args.webExcludedDomains,
        xExcludedHandles: args.xExcludedHandles,
        maxSearchTopics: args.maxSearchTopics,
      },
      retrievalPackPolicy: {
        tierA: countsForTier("A", args),
        tierB: {
          ...countsForTier("B", args),
          mode: args.tierBMode,
        },
        tierC: {
          ...countsForTier("C", args),
          enabled: args.tierCEnabled,
        },
      },
      tierWindows: {
        A: windowForTier("A", args),
        B: windowForTier("B", args),
        C: windowForTier("C", args),
      },
      tierCounts,
      estimatedCalls: {
        dailyRaw: Number(estimatedDailyRawCalls.toFixed(2)),
        dailyAfterCache: Number(estimatedDailyNetCalls.toFixed(2)),
        dailyAfterCacheToolCalls: Number(estimatedDailyNetCalls.toFixed(2)),
        hourlyRaw: Number(estimatedHourlyRawCalls.toFixed(2)),
        hourlyAfterCache: Number(estimatedHourlyNetCalls.toFixed(2)),
        hourlyAfterCacheToolCalls: Number(estimatedHourlyNetCalls.toFixed(2)),
      },
      estimatedCallsByTier: {
        A: {
          dailyRaw: Number(estimatedDailyRawByTier.A.toFixed(2)),
          dailyAfterCache: Number(
            (estimatedDailyRawByTier.A * (1 - args.cacheHitRate)).toFixed(2),
          ),
          dailyAfterCacheToolCalls: Number(
            (estimatedDailyRawByTier.A * (1 - args.cacheHitRate)).toFixed(2),
          ),
          hourlyRaw: Number((estimatedDailyRawByTier.A / 24).toFixed(2)),
          hourlyAfterCache: Number(
            (
              (estimatedDailyRawByTier.A * (1 - args.cacheHitRate)) /
              24
            ).toFixed(2),
          ),
          hourlyAfterCacheToolCalls: Number(
            (
              (estimatedDailyRawByTier.A * (1 - args.cacheHitRate)) /
              24
            ).toFixed(2),
          ),
        },
        B: {
          dailyRaw: Number(estimatedDailyRawByTier.B.toFixed(2)),
          dailyAfterCache: Number(
            (estimatedDailyRawByTier.B * (1 - args.cacheHitRate)).toFixed(2),
          ),
          dailyAfterCacheToolCalls: Number(
            (estimatedDailyRawByTier.B * (1 - args.cacheHitRate)).toFixed(2),
          ),
          hourlyRaw: Number((estimatedDailyRawByTier.B / 24).toFixed(2)),
          hourlyAfterCache: Number(
            (
              (estimatedDailyRawByTier.B * (1 - args.cacheHitRate)) /
              24
            ).toFixed(2),
          ),
          hourlyAfterCacheToolCalls: Number(
            (
              (estimatedDailyRawByTier.B * (1 - args.cacheHitRate)) /
              24
            ).toFixed(2),
          ),
        },
        C: {
          dailyRaw: Number(estimatedDailyRawByTier.C.toFixed(2)),
          dailyAfterCache: Number(
            (estimatedDailyRawByTier.C * (1 - args.cacheHitRate)).toFixed(2),
          ),
          dailyAfterCacheToolCalls: Number(
            (estimatedDailyRawByTier.C * (1 - args.cacheHitRate)).toFixed(2),
          ),
          hourlyRaw: Number((estimatedDailyRawByTier.C / 24).toFixed(2)),
          hourlyAfterCache: Number(
            (
              (estimatedDailyRawByTier.C * (1 - args.cacheHitRate)) /
              24
            ).toFixed(2),
          ),
          hourlyAfterCacheToolCalls: Number(
            (
              (estimatedDailyRawByTier.C * (1 - args.cacheHitRate)) /
              24
            ).toFixed(2),
          ),
        },
      },
      topicsModeled: searchTopics.length,
      modeledQuality: {
        marketCount: {
          min:
            modeledTopicMarketCounts.length > 0
              ? Math.min(...modeledTopicMarketCounts)
              : 0,
          p50: percentile(modeledTopicMarketCounts, 50),
          p90: percentile(modeledTopicMarketCounts, 90),
          max:
            modeledTopicMarketCounts.length > 0
              ? Math.max(...modeledTopicMarketCounts)
              : 0,
          avg:
            modeledTopicMarketCounts.length > 0
              ? Number(
                  (
                    modeledTopicMarketCounts.reduce((sum, n) => sum + n, 0) /
                    modeledTopicMarketCounts.length
                  ).toFixed(2),
                )
              : 0,
        },
        sampleAgeHours: {
          count: modeledAgesHours.length,
          p50: percentile(modeledAgesHours, 50),
          p90: percentile(modeledAgesHours, 90),
          max:
            modeledAgesHours.length > 0
              ? Number(Math.max(...modeledAgesHours).toFixed(2))
              : 0,
          over12h: modeledAgesHours.filter((age) => age > 12).length,
          over24h: modeledAgesHours.filter((age) => age > 24).length,
        },
        byCategory: modeledByCategory,
        byVenue: modeledByVenue,
      },
      queryExamples: topicSearchPreview,
    },
    qa: {
      invariants: {
        sampleEventActiveOnly: nonActiveSamples === 0,
        sampleEventOpenNowOnly: endedSamples === 0,
      },
      violations: {
        nonActiveSamples,
        endedSamples,
      },
      freshness: {
        staleSamples6h,
        staleSamples24h,
      },
    },
    topTopics: topics.slice(0, args.showTop),
    topConstraintCollisions: constraintCollisions.slice(0, args.showTop),
    demotionPreview,
  };

  if (args.out) {
    await writeFile(args.out, JSON.stringify(summary, null, 2), "utf8");
    console.log(`[topics:dry-run] wrote ${args.out}`);
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `[topics:dry-run] rows=${summary.totals.rowsFetched} used=${summary.totals.rowsUsed} unique_topics=${summary.totals.uniqueTopics} unique_search_topics=${summary.totals.uniqueSearchTopics}`,
  );
  console.log(`[topics:dry-run] launch_profile=${args.launchProfile}`);
  console.log(
    `[topics:dry-run] quality_filters min_volume24h=${args.minVolume24h} min_liquidity=${args.minLiquidity} max_spread=${args.maxSpread ?? "none"} require_open_now=${args.requireOpenNow} order_by=${args.orderBy}`,
  );
  console.log(
    `[topics:dry-run] tiering_mode=${args.tieringMode} score_a_fraction=${args.tierScoreAFraction} score_b_fraction=${args.tierScoreBFraction} score_a_min=${args.tierScoreAMin} score_b_min=${args.tierScoreBMin}`,
  );
  console.log(
    `[topics:dry-run] duplicate_rows=${summary.totals.duplicateRows} duplicate_rate=${(summary.totals.duplicateRate * 100).toFixed(2)}%`,
  );
  console.log(
    `[topics:dry-run] constraint_collisions=${summary.totals.constraintCollisions}`,
  );
  console.log(
    `[topics:dry-run] search_calls_per_day_raw=${summary.searchPlan.estimatedCalls.dailyRaw} search_calls_per_day_after_cache_tool=${summary.searchPlan.estimatedCalls.dailyAfterCacheToolCalls}`,
  );
  console.log(
    `[topics:dry-run] search_calls_per_hour_raw=${summary.searchPlan.estimatedCalls.hourlyRaw} search_calls_per_hour_after_cache_tool=${summary.searchPlan.estimatedCalls.hourlyAfterCacheToolCalls}`,
  );
  console.log(
    `[topics:dry-run] tier_calls_daily_raw A=${summary.searchPlan.estimatedCallsByTier.A.dailyRaw} B=${summary.searchPlan.estimatedCallsByTier.B.dailyRaw} C=${summary.searchPlan.estimatedCallsByTier.C.dailyRaw}`,
  );
  console.log(
    `[topics:dry-run] qa active_only=${summary.qa.invariants.sampleEventActiveOnly} open_now_only=${summary.qa.invariants.sampleEventOpenNowOnly} stale6h=${summary.qa.freshness.staleSamples6h} stale24h=${summary.qa.freshness.staleSamples24h}`,
  );
  if (
    args.emitDemotionPreview &&
    summary.demotionPreview.enabled &&
    "candidateCount" in summary.demotionPreview
  ) {
    console.log(
      `[topics:dry-run] demotion_preview candidates=${summary.demotionPreview.candidateCount} actions=${JSON.stringify(summary.demotionPreview.byAction)}`,
    );
  }
  console.log("[topics:dry-run] sample_venue_distribution");
  console.table(
    Object.entries(sampleVenueDistribution).map(([venue, count]) => ({
      venue,
      sampled: count,
      activePopulation: activeVenueDistribution[venue] ?? 0,
    })),
  );

  const printable = topics.slice(0, args.showTop).map((topic, idx) => ({
    rank: idx + 1,
    category: topic.category,
    entity: `${topic.entityType}:${topic.entity}`,
    constraint: toPrintableConstraint(topic.constraint),
    timeBucket: topic.timeBucket,
    marketCount: topic.marketCount,
    eventCount: topic.eventCount,
    venues: topic.venues.join(","),
  }));
  console.table(printable);

  const queryPrintable = topicSearchPreview.map((item, idx) => ({
    rank: idx + 1,
    tier: item.tier,
    tierScore: item.tierScore ?? "",
    searchIntentKey: item.searchIntentKey,
    pack: `${item.pack.combinedCount}combined`,
    mode: item.pack.mode,
    cadenceMinutes: item.cadenceMinutes,
    lookbackHours: item.lookbackHours,
    category: item.category,
    entity: item.entity,
    marketCount: item.marketCount,
    sampleEventStatus: item.sampleEventStatus ?? "",
    sampleEventEndDate: item.sampleEventEndDate ?? "",
    combinedPrompt:
      item.pack.combinedCount > 0
        ? item.promptCombined.slice(0, 80)
        : "(disabled)",
    xDateRange: `${item.xSearchTool.from_date}->${item.xSearchTool.to_date}`,
    webExcludedDomains:
      item.webSearchTool.filters.excluded_domains?.join(",") ?? "",
    xExcludedHandles: item.xSearchTool.excluded_x_handles?.join(",") ?? "",
  }));
  console.log("[topics:dry-run] query_examples");
  console.table(queryPrintable);

  if (args.strictInvariants && invariantViolations > 0) {
    console.error(
      `[topics:dry-run] strict invariant failure: non_active=${nonActiveSamples} ended=${endedSamples}`,
    );
    process.exitCode = 2;
  }
}

main()
  .catch((error: unknown) => {
    console.error("[topics:dry-run] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
