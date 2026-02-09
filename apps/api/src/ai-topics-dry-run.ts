import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { pool } from "./db.js";

type Category = "crypto" | "politics" | "sports" | "other";

type EntityType = "ticker" | "match" | "person" | "country" | "keyword";

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
  market_category: string | null;
  event_category: string | null;
  market_open_time: Date | string | null;
  market_expiration_time: Date | string | null;
  market_close_time: Date | string | null;
  event_end_date: Date | string | null;
  event_start_date: Date | string | null;
};

type TopicAggregate = {
  topicKey: string;
  category: Category;
  entityType: EntityType;
  entity: string;
  constraint: Constraint;
  constraintHash: string;
  timeBucket: string;
  venues: Set<string>;
  marketIds: Set<string>;
  eventIds: Set<string>;
  sampleEventTitle: string | null;
  sampleMarketTitle: string | null;
};

type TopicSummaryRow = {
  topicKey: string;
  category: Category;
  entityType: EntityType;
  entity: string;
  constraint: Constraint;
  constraintHash: string;
  timeBucket: string;
  marketCount: number;
  eventCount: number;
  venueCount: number;
  venues: string[];
  sampleEventTitle: string | null;
  sampleMarketTitle: string | null;
};

type Args = {
  limit: number;
  venues: string[];
  categories: Category[];
  searchCategories: Category[];
  minVolume24h: number;
  minLiquidity: number;
  maxSpread: number | null;
  requireOpenNow: boolean;
  orderBy: "trending" | "updated";
  sampling: "per-venue" | "global";
  perVenueQuota: number | null;
  showTop: number;
  showQueries: number;
  cacheHitRate: number;
  tierAMarketThreshold: number;
  tierBMarketThreshold: number;
  tierACadenceMinutes: number;
  tierBCadenceMinutes: number;
  tierCCadenceMinutes: number;
  tierAWebCount: number;
  tierAXCount: number;
  tierBWebCount: number;
  tierBXCount: number;
  tierBMode: "normal" | "shed";
  tierCWebCount: number;
  tierCXCount: number;
  tierCEnabled: boolean;
  tierALookbackHours: number;
  tierBLookbackHours: number;
  tierCLookbackHours: number;
  webExcludedDomains: string[];
  xExcludedHandles: string[];
  maxSearchTopics: number;
  json: boolean;
  out: string | null;
  help: boolean;
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
  { regex: /\bchampions league\b|\bucl\b/i, entity: "champions-league" },
  { regex: /\bworld cup\b/i, entity: "world-cup" },
  { regex: /\bolympics?\b/i, entity: "olympics" },
  { regex: /\bformula ?1\b|\bf1\b/i, entity: "formula-1" },
  { regex: /\bufc\b|\bmma\b/i, entity: "ufc" },
  {
    regex: /\bncaa\b|\bcollege football\b|\bcollege basketball\b/i,
    entity: "ncaa",
  },
];

const SPORTS_CATEGORY_HINT_PATTERN =
  /\b(nfl|nba|mlb|nhl|ncaa|soccer|football|basketball|baseball|hockey|tennis|golf|ufc|mma|olympics?|world cup|premier league|championship|playoff|super bowl|big game|final)\b/i;

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
]);

const POLITICS_ROLE_PATTERNS: Array<{ regex: RegExp; entity: string }> = [
  { regex: /\bfed chair\b/i, entity: "fed-chair" },
  { regex: /\bsupreme court\b/i, entity: "supreme-court" },
  { regex: /\bhouse of representatives\b/i, entity: "house" },
  { regex: /\bsenate\b/i, entity: "senate" },
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

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
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

function parseNonNegativeNumber(value: string | undefined, fallback: number): number {
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
    .map(entry => entry.trim().toLowerCase())
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

function parseOrderBy(value: string | undefined): "trending" | "updated" {
  return value === "updated" ? "updated" : "trending";
}

function parseTierBMode(value: string | undefined): "normal" | "shed" {
  return value === "shed" ? "shed" : "normal";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveArgs(argv: string[]): Args {
  const searchCategoriesParsed = parseCategories(parseFlag(argv, "--search-categories"));
  return {
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
    requireOpenNow: parseBoolean(parseFlag(argv, "--require-open-now"), true),
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
    cacheHitRate: parseFraction(parseFlag(argv, "--cache-hit-rate"), 0.35),
    tierAMarketThreshold: parsePositiveInt(
      parseFlag(argv, "--tier-a-market-threshold"),
      20,
    ),
    tierBMarketThreshold: parsePositiveInt(
      parseFlag(argv, "--tier-b-market-threshold"),
      5,
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
    tierAWebCount: parseNonNegativeInt(parseFlag(argv, "--tier-a-web-count"), 2),
    tierAXCount: parseNonNegativeInt(parseFlag(argv, "--tier-a-x-count"), 1),
    tierBWebCount: parseNonNegativeInt(parseFlag(argv, "--tier-b-web-count"), 1),
    tierBXCount: parseNonNegativeInt(parseFlag(argv, "--tier-b-x-count"), 1),
    tierBMode: parseTierBMode(parseFlag(argv, "--tier-b-mode")),
    tierCWebCount: parseNonNegativeInt(parseFlag(argv, "--tier-c-web-count"), 1),
    tierCXCount: parseNonNegativeInt(parseFlag(argv, "--tier-c-x-count"), 0),
    tierCEnabled: parseBoolean(parseFlag(argv, "--tier-c-enabled"), true),
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
    maxSearchTopics: parsePositiveInt(parseFlag(argv, "--max-search-topics"), 300),
    json: hasFlag(argv, "--json"),
    out: parseFlag(argv, "--out") ?? null,
    help: hasFlag(argv, "--help"),
  };
}

function printHelp(): void {
  console.log(`Usage: pnpm -C hunch-monorepo -F api run ai:topics:dry-run -- [options]

Options:
  --limit <n>            Max active market rows to scan (default: 5000)
  --venues <csv>         Filter venues, e.g. polymarket,kalshi
  --categories <csv>     Filter categories, e.g. crypto,politics,sports
  --search-categories <csv>  Categories used for search modeling (default: crypto,politics,sports)
  --min-volume24h <n>   Minimum 24h volume filter (default: 1e-9)
  --min-liquidity <n>   Minimum liquidity/open-interest proxy filter (default: 0)
  --max-spread <n>      Optional max spread filter (requires best bid+ask)
  --require-open-now <bool>  Exclude expired/closed markets by time (default: true)
  --order-by <mode>     Sampling order: trending|updated (default: trending)
  --sampling <mode>      Sampling strategy: per-venue|global (default: per-venue)
  --per-venue-quota <n>  Optional fixed quota per venue (default: auto from limit)
  --show-top <n>         Show top N topics in text mode (default: 20)
  --show-queries <n>     Show top N synthesized search queries (default: 12)
  --cache-hit-rate <f>   Estimated cache-hit rate for external search [0..1] (default: 0.35)
  --tier-a-market-threshold <n> Tier A if marketCount >= n (default: 20)
  --tier-b-market-threshold <n> Tier B if marketCount >= n (default: 5)
  --tier-a-cadence-minutes <n>  Tier A refresh cadence in minutes (default: 10)
  --tier-b-cadence-minutes <n>  Tier B refresh cadence in minutes (default: 120)
  --tier-c-cadence-minutes <n>  Tier C refresh cadence in minutes (default: 240)
  --tier-a-web-count <n>        Tier A web_search calls per refresh (default: 2)
  --tier-a-x-count <n>          Tier A x_search calls per refresh (default: 1)
  --tier-b-web-count <n>        Tier B web_search calls per refresh (default: 1)
  --tier-b-x-count <n>          Tier B x_search calls per refresh (default: 1)
  --tier-b-mode <mode>          Tier B mode: normal|shed (shed forces 2 web + 0 x)
  --tier-c-web-count <n>        Tier C web_search calls per refresh (default: 1)
  --tier-c-x-count <n>          Tier C x_search calls per refresh (default: 0)
  --tier-c-enabled <bool>       Enable Tier C search modeling (default: true)
  --tier-a-lookback-hours <n>   Tier A x_search lookback horizon (default: 24)
  --tier-b-lookback-hours <n>   Tier B x_search lookback horizon (default: 72)
  --tier-c-lookback-hours <n>   Tier C x_search lookback horizon (default: 168)
  --web-excluded-domains <csv>  web_search excluded domains (max 5)
  --x-excluded-handles <csv>    x_search excluded handles (max 10)
  --max-search-topics <n>       Max topics used in search volume model (default: 300)
  --json                 Print JSON summary instead of text table
  --out <path>           Write JSON summary to file
  --help                 Show this help
`);
}

function normalizeSlug(value: string): string {
  const asciiOnly = Array.from(value.normalize("NFKD"))
    .filter(char => char.charCodeAt(0) <= 0x7f)
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
    .filter(token => token.length >= 3)
    .filter(token => !STOPWORDS.has(token))
    .filter(token => !GENERIC_TOKENS.has(token))
    .filter(token => !MONTH_TOKENS.has(token))
    .filter(token => !DAY_TOKENS.has(token))
    .filter(token => !/^\d+$/.test(token))
    .filter(token => !/^\d+(st|nd|rd|th)$/.test(token));
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
  if (raw.includes("sport")) return "sports";
  if (raw.includes("polit")) return "politics";
  if (raw.includes("crypto") || raw.includes("token")) return "crypto";
  const lower = text.toLowerCase();
  if (
    lower.includes("bitcoin") ||
    lower.includes("btc") ||
    lower.includes("ethereum") ||
    lower.includes("eth") ||
    lower.includes("solana") ||
    lower.includes("sol ") ||
    lower.includes("dogecoin") ||
    lower.includes("doge") ||
    lower.includes("xrp") ||
    lower.includes("ripple") ||
    lower.includes("crypto")
  ) {
    return "crypto";
  }
  if (
    lower.includes("election") ||
    lower.includes("president") ||
    lower.includes("senate") ||
    lower.includes("ceasefire")
  ) {
    return "politics";
  }
  if (
    SPORTS_CATEGORY_HINT_PATTERN.test(lower) ||
    (/\b(vs\.?|@|at)\b/.test(lower) &&
      (lower.includes("match") || lower.includes("game") || lower.includes("team")))
  ) {
    return "sports";
  }
  return "other";
}

function parseDateBucket(value: Date | string | null | undefined): string | null {
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
      !hasUsd &&
      left >= 1900 &&
      left <= 2100 &&
      right >= 1900 &&
      right <= 2100;
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

  const ouLine = source.match(/\b(?:o\/u|ou|over\/under)\s*([0-9]+(?:\.[0-9]+)?)\b/i);
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

  const spread = source.match(/\b(?:spread|line)\s*([+-]?[0-9]+(?:\.[0-9]+)?)\b/i);
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

  const arrowUp = source.match(/[↑]\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)/);
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

  const arrowDown = source.match(/[↓]\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)([kKmMbB]?)/);
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
      comparator[1] === ">" ? ">=" : comparator[1] === "<" ? "<=" : comparator[1];
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
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function hashConstraint(constraint: Constraint): string {
  const stable = stableStringify(constraint);
  return createHash("sha1").update(stable).digest("hex").slice(0, 16);
}

function extractTeams(text: string): [string, string] | null {
  const match = text.match(/(.+?)\s+(?:vs\.?|@|at)\s+(.+)/i);
  if (!match) return null;
  let left = normalizeSlug(match[1]).replace(/-(before|after|by).*$/, "");
  let right = normalizeSlug(match[2]).replace(/-(before|after|by).*$/, "");
  if (!left || !right) return null;
  // Canonical ordering prevents duplicate topics for "A vs B" and "B @ A".
  if (right.localeCompare(left) < 0) {
    [left, right] = [right, left];
  }
  return [left, right];
}

function extractCapitalizedPhrases(text: string): string[] {
  const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g) ?? [];
  const cleaned: string[] = [];
  const seen = new Set<string>();

  for (const entry of matches) {
    const normalized = normalizeSlug(entry);
    if (!normalized) continue;

    const parts = normalized.split("-").filter(Boolean);
    while (parts.length > 1 && ENTITY_LEADING_NOISE.has(parts[0])) {
      parts.shift();
    }
    while (parts.length > 1 && ENTITY_TRAILING_NOISE.has(parts[parts.length - 1])) {
      parts.pop();
    }
    if (parts.length === 0) continue;

    const candidate = parts.join("-");
    if (!candidate) continue;
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
    token =>
      !QUESTION_ENTITY_BLOCKLIST.has(token) &&
      !KEYWORD_NOISE.has(token) &&
      !POLITICS_GENERIC_LABELS.has(token),
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

function resolveEntity(
  category: Category,
  eventTitle: string | null,
  marketTitle: string | null,
): { type: EntityType; value: string } {
  const rawText = `${eventTitle ?? ""} ${marketTitle ?? ""}`.trim();
  const normalizedText = normalizeTitle(rawText, category);
  const eventOnlyText = normalizeTitle(eventTitle ?? "", category);
  const marketOnlyText = normalizeTitle(marketTitle ?? "", category);
  const entitySourceText = eventOnlyText || marketOnlyText || normalizedText;
  const rawEntitySource = eventTitle?.trim() || marketTitle?.trim() || rawText;

  if (category === "crypto") {
    for (const candidate of CRYPTO_MAP) {
      if (candidate.regex.test(rawEntitySource)) {
        return { type: "ticker", value: candidate.entity };
      }
    }
    const ticker = rawEntitySource.match(/\$([A-Z]{2,10})\b/);
    if (ticker) {
      const mapped = CRYPTO_ALIAS_TO_TICKER.get(ticker[1].toLowerCase());
      if (mapped) return { type: "ticker", value: mapped };
      return { type: "ticker", value: normalizeSlug(ticker[1]) };
    }
    const cryptoTokens = tokenizeNormalized(entitySourceText);
    for (const token of cryptoTokens) {
      const mapped = CRYPTO_ALIAS_TO_TICKER.get(token);
      if (mapped) return { type: "ticker", value: mapped };
    }
    // Conservative fallback for crypto: skip unknown entities rather than
    // producing noisy generic keywords that degrade search quality.
    return { type: "keyword", value: "unknown" };
  }

  if (category === "sports") {
    const teams = extractTeams(entitySourceText);
    if (teams) {
      return { type: "match", value: `${teams[0]}-vs-${teams[1]}` };
    }
    for (const pattern of SPORTS_ENTITY_PATTERNS) {
      if (pattern.regex.test(entitySourceText)) {
        return { type: "keyword", value: pattern.entity };
      }
    }
    return { type: "keyword", value: "unknown" };
  }

  if (category === "politics") {
    const source = entitySourceText;
    const sourceTokens = tokenizeNormalized(source);
    const phrases = extractCapitalizedPhrases(source);
    const hasRoleToken = (value: string): boolean =>
      value.split("-").some(part => POLITICS_ROLE_TOKENS.has(part));

    for (const pattern of POLITICS_ROLE_PATTERNS) {
      if (pattern.regex.test(source)) {
        return { type: "keyword", value: pattern.entity };
      }
    }

    for (const phrase of phrases) {
      const mappedCountry = POLITICS_COUNTRY_ALIASES.get(phrase) ?? phrase;
      if (POLITICS_COUNTRIES.has(mappedCountry)) {
        return { type: "country", value: mappedCountry };
      }
    }

    for (const token of sourceTokens) {
      const mappedCountry = POLITICS_COUNTRY_ALIASES.get(token) ?? token;
      if (POLITICS_COUNTRIES.has(mappedCountry)) {
        return { type: "country", value: mappedCountry };
      }
    }

    const filteredPhrases = phrases.filter(
      phrase =>
        !POLITICS_GENERIC_LABELS.has(phrase) &&
        !POLITICS_GENERIC_PATTERN.test(phrase) &&
        !KEYWORD_NOISE.has(phrase) &&
        !QUESTION_ENTITY_BLOCKLIST.has(phrase) &&
        !MONTH_TOKENS.has(phrase) &&
        !DAY_TOKENS.has(phrase),
    );

    const multiWordPerson = filteredPhrases.find(
      phrase =>
        phrase.includes("-") &&
        !hasRoleToken(phrase) &&
        phrase
          .split("-")
          .every(part => !POLITICS_GENERIC_LABELS.has(part) && !KEYWORD_NOISE.has(part)),
    );
    if (multiWordPerson) {
      return { type: "person", value: multiWordPerson };
    }

    const singleWordPerson = filteredPhrases.find(phrase =>
      POLITICS_PERSON_ALLOWLIST.has(phrase),
    );
    if (singleWordPerson) {
      return { type: "person", value: singleWordPerson };
    }

    const rolePhrase = filteredPhrases.find(phrase => hasRoleToken(phrase));
    if (rolePhrase) {
      return { type: "keyword", value: rolePhrase };
    }

    const politicsKeyword = sourceTokens.find(
      token =>
        token === "election" ||
        token === "polling" ||
        token === "primary" ||
        token === "senate" ||
        token === "house" ||
        token === "ceasefire",
    );
    if (politicsKeyword) {
      return { type: "keyword", value: politicsKeyword };
    }

    return { type: "keyword", value: "unknown" };
  }

  const keyword = extractKeywordEntity(normalizedText);
  const mappedTicker = CRYPTO_ALIAS_TO_TICKER.get(keyword);
  if (mappedTicker) {
    return { type: "ticker", value: mappedTicker };
  }
  if (
    keyword === "unknown" ||
    QUESTION_ENTITY_BLOCKLIST.has(keyword) ||
    GENERIC_TOKENS.has(keyword)
  ) {
    return { type: "keyword", value: "unknown" };
  }
  return { type: "keyword", value: keyword };
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
    return "m.updated_at desc nulls last, m.id desc";
  }
  const volumeExpr = marketVolumeDisplayExpr("m");
  const liquidityExpr = marketLiquidityDisplayExpr("m");
  return `
    coalesce(${volumeExpr}, 0) desc nulls last,
    coalesce(${liquidityExpr}, 0) desc nulls last,
    m.updated_at desc nulls last,
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
    parts.push(`(m.expiration_time is null or m.expiration_time > $${nowIdx}::timestamptz)`);
    parts.push(`(m.close_time is null or m.close_time > $${nowIdx}::timestamptz)`);
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
        m.category as market_category,
        e.category as event_category,
        m.open_time as market_open_time,
        m.expiration_time as market_expiration_time,
        m.close_time as market_close_time,
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
    venues = venueRes.rows.map(row => row.venue).filter(Boolean);
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
        m.category as market_category,
        e.category as event_category,
        m.open_time as market_open_time,
        m.expiration_time as market_expiration_time,
        m.close_time as market_close_time,
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
      market_category,
      event_category,
      market_open_time,
      market_expiration_time,
      market_close_time,
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
    result.rows.map(row => row.market_id),
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
  const result = await pool.query<{ venue: string; count: number }>(sql, params);
  return result.rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.venue] = row.count;
    return acc;
  }, {});
}

function buildTopicFromRow(row: MarketRow): {
  category: Category;
  entityType: EntityType;
  entity: string;
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
  if (topic.entityType === "match") {
    return topic.entity.replace(/-vs-/g, " vs ").replace(/-/g, " ");
  }
  return topic.entity.replace(/-/g, " ");
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
  promptWebNews: string;
  promptWebDrivers: string;
  promptXSignal: string;
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
} {
  const entity = entityTerm(topic);
  const constraint = formatConstraintForQuery(topic.constraint);
  const suffix = constraint ? ` Constraint: ${constraint}.` : "";
  const lookbackHours = lookbackHoursForTier(tier, args);
  const lookbackDays = Math.max(1, Math.ceil(lookbackHours / 24));
  const fromDate = isoDateDaysAgo(lookbackDays);
  const toDate = isoDateDaysAgo(0);
  const webFilters =
    args.webExcludedDomains.length > 0
      ? { excluded_domains: args.webExcludedDomains.slice(0, 5) }
      : {};
  const xExcludedHandles =
    args.xExcludedHandles.length > 0 ? args.xExcludedHandles.slice(0, 10) : undefined;

  if (topic.category === "crypto") {
    return {
      promptWebNews:
        `Find credible web reporting from the last ${lookbackHours} hours about ${entity}. ` +
        `Focus on regulation, macro events, exchange incidents, ETF/institutional flows, and on-chain catalysts.${suffix}`,
      promptWebDrivers:
        `Summarize the strongest concrete drivers behind recent ${entity} moves in the last ${lookbackHours} hours. ` +
        `Require source-backed claims and separate confirmed facts from rumors.${suffix}`,
      promptXSignal:
        `Find high-signal X posts from the last ${lookbackHours} hours discussing catalysts for ${entity}. ` +
        `Return concise claim summaries with links and source handles.${suffix}`,
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
    };
  }
  if (topic.category === "politics") {
    const context = `${topic.sampleEventTitle ?? ""} ${topic.sampleMarketTitle ?? ""}`.toLowerCase();
    const electionLike =
      entity.includes("election") ||
      /\b(election|elect|poll|polling|primary|nominee|vote|voter|governor|president|senate|house)\b/.test(
        context,
      );
    const politicsStem = electionLike ? `${entity} election` : entity;
    const focusLine = electionLike
      ? "Focus on polling, endorsements, fundraising, legal rulings, filings, and official statements."
      : "Focus on official statements, policy/legal decisions, sanctions, diplomatic developments, and verifiable timeline changes.";
    return {
      promptWebNews:
        `Find credible web reporting from the last ${lookbackHours} hours for ${politicsStem}. ` +
        `${focusLine}${suffix}`,
      promptWebDrivers:
        `Explain the strongest new drivers for ${politicsStem} over the last ${lookbackHours} hours, ` +
        `with clear source attribution and uncertainty notes.${suffix}`,
      promptXSignal:
        `Find high-signal X posts from the last ${lookbackHours} hours about ${politicsStem}. ` +
        `Prioritize primary reporting, campaign/official accounts, and verifiable documents.${suffix}`,
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
    };
  }
  if (topic.category === "sports") {
    return {
      promptWebNews:
        `Find credible web reporting from the last ${lookbackHours} hours about ${entity}. ` +
        `Focus on injuries, lineup changes, suspensions, travel/weather, and coaching updates.${suffix}`,
      promptWebDrivers:
        `Summarize concrete pre-game or pre-event factors for ${entity} in the last ${lookbackHours} hours, ` +
        `with cited sources and confidence notes.${suffix}`,
      promptXSignal:
        `Find high-signal X posts from the last ${lookbackHours} hours about ${entity}. ` +
        `Prefer team/league reporters and official injury/status announcements.${suffix}`,
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
    };
  }
  return {
    promptWebNews:
      `Find credible web reporting from the last ${lookbackHours} hours about ${entity}.${suffix}`,
    promptWebDrivers:
      `Identify concrete, source-backed drivers and new developments about ${entity} from the last ${lookbackHours} hours.${suffix}`,
    promptXSignal:
      `Find high-signal X posts from the last ${lookbackHours} hours about ${entity}, with links and source handles.${suffix}`,
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
  };
}

function tierForTopic(
  topic: TopicSummaryRow,
  args: Args,
): "A" | "B" | "C" {
  if (topic.marketCount >= args.tierAMarketThreshold) return "A";
  if (topic.marketCount >= args.tierBMarketThreshold) return "B";
  return "C";
}

function cadenceForTier(tier: "A" | "B" | "C", args: Args): number {
  if (tier === "A") return args.tierACadenceMinutes;
  if (tier === "B") return args.tierBCadenceMinutes;
  return args.tierCCadenceMinutes;
}

function countsForTier(
  tier: "A" | "B" | "C",
  args: Args,
): { webCount: number; xCount: number } {
  if (tier === "A") {
    return { webCount: args.tierAWebCount, xCount: args.tierAXCount };
  }
  if (tier === "B") {
    if (args.tierBMode === "shed") {
      return { webCount: 2, xCount: 0 };
    }
    return { webCount: args.tierBWebCount, xCount: args.tierBXCount };
  }
  if (!args.tierCEnabled) {
    return { webCount: 0, xCount: 0 };
  }
  return { webCount: args.tierCWebCount, xCount: args.tierCXCount };
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
        constraint: built.constraint,
        constraintHash: built.constraintHash,
        timeBucket: built.timeBucket,
        venues: new Set(),
        marketIds: new Set(),
        eventIds: new Set(),
        sampleEventTitle: row.event_title,
        sampleMarketTitle: row.market_title,
      };
      topicMap.set(built.topicKey, aggregate);
    }
    aggregate.venues.add(row.venue);
    aggregate.marketIds.add(row.market_id);
    aggregate.eventIds.add(row.event_id);

    const fingerprint = `${built.category}|${built.entityType}|${built.entity}|${built.timeBucket}`;
    const set = fingerprintToConstraints.get(fingerprint) ?? new Set<string>();
    set.add(built.constraintHash);
    fingerprintToConstraints.set(fingerprint, set);
  }

  const topics: TopicSummaryRow[] = Array.from(topicMap.values())
    .map(topic => ({
      topicKey: topic.topicKey,
      category: topic.category,
      entityType: topic.entityType,
      entity: topic.entity,
      constraint: topic.constraint,
      constraintHash: topic.constraintHash,
      timeBucket: topic.timeBucket,
      marketCount: topic.marketIds.size,
      eventCount: topic.eventIds.size,
      venueCount: topic.venues.size,
      venues: Array.from(topic.venues).sort(),
      sampleEventTitle: topic.sampleEventTitle,
      sampleMarketTitle: topic.sampleMarketTitle,
    }))
    .sort((a, b) => b.marketCount - a.marketCount);

  const searchTopicMap = new Map<string, TopicSummaryRow>();
  for (const topic of topics) {
    if (topic.entity === "unknown") continue;
    if (!args.searchCategories.includes(topic.category)) continue;
    const searchKey = `${topic.category}|${topic.entityType}|${topic.entity}`;
    const existing = searchTopicMap.get(searchKey);
    if (!existing) {
      searchTopicMap.set(searchKey, { ...topic, venues: [...topic.venues] });
      continue;
    }

    const merged: TopicSummaryRow = {
      ...existing,
      marketCount: existing.marketCount + topic.marketCount,
      eventCount: existing.eventCount + topic.eventCount,
      venueCount: new Set([...existing.venues, ...topic.venues]).size,
      venues: Array.from(new Set([...existing.venues, ...topic.venues])).sort(),
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
      merged.sampleEventTitle = topic.sampleEventTitle;
      merged.sampleMarketTitle = topic.sampleMarketTitle;
    }
    searchTopicMap.set(searchKey, merged);
  }

  const searchTopics = Array.from(searchTopicMap.values())
    .sort((a, b) => b.marketCount - a.marketCount)
    .slice(0, args.maxSearchTopics);

  const tierCounts = searchTopics.reduce<Record<"A" | "B" | "C", number>>(
    (acc, topic) => {
      const tier = tierForTopic(topic, args);
      if (tier === "C" && !args.tierCEnabled) return acc;
      acc[tier] += 1;
      return acc;
    },
    { A: 0, B: 0, C: 0 },
  );

  const topicSearchPreview = searchTopics.slice(0, args.showQueries).map(topic => {
    const tier = tierForTopic(topic, args);
    const cadenceMinutes = cadenceForTier(tier, args);
    const lookback = windowForTier(tier, args);
    const queries = buildSearchQueries(topic, tier, args);
    const pack = countsForTier(tier, args);
    const enabledPrompts: string[] = [];
    if (pack.webCount > 0) {
      enabledPrompts.push("prompt_web_news");
      if (pack.webCount > 1) {
        enabledPrompts.push("prompt_web_driver");
      }
    }
    if (pack.xCount > 0) {
      enabledPrompts.push("prompt_x_signal");
    }
    return {
      topicKey: topic.topicKey,
      tier,
      cadenceMinutes,
      lookbackHours: lookback.lookbackHours,
      category: topic.category,
      entity: `${topic.entityType}:${topic.entity}`,
      marketCount: topic.marketCount,
      promptWebNews: queries.promptWebNews,
      promptWebDrivers: queries.promptWebDrivers,
      promptXSignal: queries.promptXSignal,
      webSearchTool: queries.webSearchTool,
      xSearchTool: queries.xSearchTool,
      pack: {
        webCount: pack.webCount,
        xCount: pack.xCount,
        mode: tier === "B" ? args.tierBMode : "normal",
        enabledPrompts,
      },
      xSearchWindow: {
        fromDate: lookback.fromDate,
        toDate: lookback.toDate,
        lookbackHours: lookback.lookbackHours,
      },
    };
  });

  const estimatedDailyRawByTier = searchTopics.reduce<Record<"A" | "B" | "C", number>>(
    (acc, topic) => {
      const tier = tierForTopic(topic, args);
      if (tier === "C" && !args.tierCEnabled) return acc;
      const cadence = cadenceForTier(tier, args);
      const runsPerDay = 1440 / cadence;
      const pack = countsForTier(tier, args);
      const queriesPerRefresh = pack.webCount + pack.xCount;
      acc[tier] += runsPerDay * queriesPerRefresh;
      return acc;
    },
    { A: 0, B: 0, C: 0 },
  );

  const estimatedDailyRaw =
    estimatedDailyRawByTier.A + estimatedDailyRawByTier.B + estimatedDailyRawByTier.C;
  const estimatedDailyRawCalls = estimatedDailyRaw;
  const estimatedDailyNetCalls = estimatedDailyRawCalls * (1 - args.cacheHitRate);
  const estimatedHourlyRawCalls = estimatedDailyRawCalls / 24;
  const estimatedHourlyNetCalls = estimatedDailyNetCalls / 24;

  const rowsUsed = rows.length - skippedByCategory;
  const duplicates = Math.max(0, rowsUsed - topics.length);
  const duplicateRate = rowsUsed > 0 ? duplicates / rowsUsed : 0;

  const constraintCollisions = Array.from(fingerprintToConstraints.entries())
    .filter(([, constraints]) => constraints.size > 1)
    .map(([fingerprint, constraints]) => ({
      fingerprint,
      constraintVariants: constraints.size,
    }))
    .sort((a, b) => b.constraintVariants - a.constraintVariants);

  const summary = {
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
        cacheHitRate: args.cacheHitRate,
        tierAMarketThreshold: args.tierAMarketThreshold,
        tierBMarketThreshold: args.tierBMarketThreshold,
        tierACadenceMinutes: args.tierACadenceMinutes,
        tierBCadenceMinutes: args.tierBCadenceMinutes,
        tierCCadenceMinutes: args.tierCCadenceMinutes,
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
        hourlyRaw: Number(estimatedHourlyRawCalls.toFixed(2)),
        hourlyAfterCache: Number(estimatedHourlyNetCalls.toFixed(2)),
      },
      estimatedCallsByTier: {
        A: {
          dailyRaw: Number(estimatedDailyRawByTier.A.toFixed(2)),
          dailyAfterCache: Number((estimatedDailyRawByTier.A * (1 - args.cacheHitRate)).toFixed(2)),
          hourlyRaw: Number((estimatedDailyRawByTier.A / 24).toFixed(2)),
          hourlyAfterCache: Number(((estimatedDailyRawByTier.A * (1 - args.cacheHitRate)) / 24).toFixed(2)),
        },
        B: {
          dailyRaw: Number(estimatedDailyRawByTier.B.toFixed(2)),
          dailyAfterCache: Number((estimatedDailyRawByTier.B * (1 - args.cacheHitRate)).toFixed(2)),
          hourlyRaw: Number((estimatedDailyRawByTier.B / 24).toFixed(2)),
          hourlyAfterCache: Number(((estimatedDailyRawByTier.B * (1 - args.cacheHitRate)) / 24).toFixed(2)),
        },
        C: {
          dailyRaw: Number(estimatedDailyRawByTier.C.toFixed(2)),
          dailyAfterCache: Number((estimatedDailyRawByTier.C * (1 - args.cacheHitRate)).toFixed(2)),
          hourlyRaw: Number((estimatedDailyRawByTier.C / 24).toFixed(2)),
          hourlyAfterCache: Number(((estimatedDailyRawByTier.C * (1 - args.cacheHitRate)) / 24).toFixed(2)),
        },
      },
      topicsModeled: searchTopics.length,
      queryExamples: topicSearchPreview,
    },
    topTopics: topics.slice(0, args.showTop),
    topConstraintCollisions: constraintCollisions.slice(0, args.showTop),
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
  console.log(
    `[topics:dry-run] quality_filters min_volume24h=${args.minVolume24h} min_liquidity=${args.minLiquidity} max_spread=${args.maxSpread ?? "none"} require_open_now=${args.requireOpenNow} order_by=${args.orderBy}`,
  );
  console.log(
    `[topics:dry-run] duplicate_rows=${summary.totals.duplicateRows} duplicate_rate=${(summary.totals.duplicateRate * 100).toFixed(2)}%`,
  );
  console.log(
    `[topics:dry-run] constraint_collisions=${summary.totals.constraintCollisions}`,
  );
  console.log(
    `[topics:dry-run] search_calls_per_day_raw=${summary.searchPlan.estimatedCalls.dailyRaw} search_calls_per_day_after_cache=${summary.searchPlan.estimatedCalls.dailyAfterCache}`,
  );
  console.log(
    `[topics:dry-run] search_calls_per_hour_raw=${summary.searchPlan.estimatedCalls.hourlyRaw} search_calls_per_hour_after_cache=${summary.searchPlan.estimatedCalls.hourlyAfterCache}`,
  );
  console.log(
    `[topics:dry-run] tier_calls_daily_raw A=${summary.searchPlan.estimatedCallsByTier.A.dailyRaw} B=${summary.searchPlan.estimatedCallsByTier.B.dailyRaw} C=${summary.searchPlan.estimatedCallsByTier.C.dailyRaw}`,
  );
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
    pack: `${item.pack.webCount}w/${item.pack.xCount}x`,
    mode: item.pack.mode,
    cadenceMinutes: item.cadenceMinutes,
    lookbackHours: item.lookbackHours,
    category: item.category,
    entity: item.entity,
    marketCount: item.marketCount,
    webPrompt:
      item.pack.webCount > 0 ? item.promptWebNews.slice(0, 80) : "(disabled)",
    xPrompt:
      item.pack.xCount > 0 ? item.promptXSignal.slice(0, 80) : "(disabled)",
    xDateRange: `${item.xSearchTool.from_date}->${item.xSearchTool.to_date}`,
    webExcludedDomains:
      item.webSearchTool.filters.excluded_domains?.join(",") ?? "",
    xExcludedHandles: item.xSearchTool.excluded_x_handles?.join(",") ?? "",
  }));
  console.log("[topics:dry-run] query_examples");
  console.table(queryPrintable);
}

main()
  .catch((error: unknown) => {
    console.error("[topics:dry-run] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
