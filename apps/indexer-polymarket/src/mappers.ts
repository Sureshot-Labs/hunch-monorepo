import { v4 as uuid } from "uuid";
import type {
  TEvent,
  TMarket,
  TPolymarketEvent,
  TPolymarketMarket,
} from "./types.js";
import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";

type PolymarketCategory =
  | "politics"
  | "crypto"
  | "sports"
  | "economics"
  | "technology"
  | "entertainment"
  | "weather"
  | "health"
  | "mentions"
  | "other";

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x as number) ? (x as number) : null;
};

const s = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
};

const nOrUndefined = (v: unknown): number | undefined => {
  const parsed = n(v);
  return parsed === null ? undefined : parsed;
};

const bool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

const compactMetadata = (
  values: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value == null) continue;
    if (typeof value === "string" && value.trim().length === 0) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
};

type PolymarketTagInput =
  | string
  | { label?: string | null; slug?: string | null }
  | null
  | undefined;

const CATEGORY_PRIORITY: readonly PolymarketCategory[] = [
  "mentions",
  "politics",
  "crypto",
  "sports",
  "economics",
  "technology",
  "entertainment",
  "weather",
  "health",
  "other",
];

const MENTION_TAGS = new Set(["mention-markets", "tweets-markets"]);

const EXPLICIT_CATEGORY_MAP = new Map<string, PolymarketCategory>([
  ["mentions", "mentions"],
  ["mention", "mentions"],
  ["mention-markets", "mentions"],
  ["tweets-markets", "mentions"],

  ["politics", "politics"],
  ["politic", "politics"],
  ["geopolitics", "politics"],
  ["global-politics", "politics"],
  ["global politics", "politics"],
  ["foreign-policy", "politics"],
  ["foreign policy", "politics"],
  ["world", "politics"],
  ["macro-geopolitics", "politics"],
  ["macro geopolitics", "politics"],
  ["ukraine", "politics"],
  ["ukraine-&-russia", "politics"],
  ["ukraine & russia", "politics"],
  ["iran", "politics"],
  ["israel", "politics"],
  ["middle-east", "politics"],
  ["middle east", "politics"],
  ["us-current-affairs", "politics"],
  ["current-affairs", "politics"],
  ["elections", "politics"],

  ["crypto", "crypto"],
  ["cryptocurrency", "crypto"],
  ["crypto-prices", "crypto"],
  ["crypto prices", "crypto"],
  ["bitcoin", "crypto"],
  ["ethereum", "crypto"],
  ["solana", "crypto"],
  ["nft", "crypto"],
  ["nfts", "crypto"],

  ["sports", "sports"],
  ["sport", "sports"],
  ["games", "sports"],
  ["football matches", "sports"],
  ["nba playoffs", "sports"],
  ["olympics", "sports"],
  ["chess", "sports"],
  ["poker", "sports"],
  ["cricket", "sports"],
  ["esports", "sports"],

  ["economics", "economics"],
  ["economy", "economics"],
  ["finance", "economics"],
  ["financials", "economics"],
  ["business", "economics"],
  ["companies", "economics"],
  ["company-news", "economics"],
  ["company news", "economics"],
  ["oil-gas", "economics"],
  ["oil & gas", "economics"],

  ["technology", "technology"],
  ["tech", "technology"],
  ["science", "technology"],
  ["science-and-technology", "technology"],
  ["science and technology", "technology"],
  ["space", "technology"],

  ["entertainment", "entertainment"],
  ["pop-culture", "entertainment"],
  ["pop culture", "entertainment"],
  ["culture", "entertainment"],
  ["art", "entertainment"],

  ["weather", "weather"],
  ["climate", "weather"],
  ["climate-and-weather", "weather"],
  ["climate and weather", "weather"],

  ["health", "health"],
  ["coronavirus", "health"],

  ["other", "other"],
]);

const SPORTS_TAGS = new Set([
  "sports",
  "nba",
  "nfl",
  "nhl",
  "mlb",
  "soccer",
  "football",
  "basketball",
  "baseball",
  "hockey",
  "tennis",
  "cricket",
  "ufc",
  "ncaa",
  "ncaa-basketball",
  "cwbb",
  "cbb",
  "cfb",
  "epl",
  "premier-league",
  "efl-championship",
  "international-cricket",
  "la-liga",
  "mls",
  "bundesliga",
  "ligue-1",
  "khl",
  "ucl",
  "uel",
  "wnba",
  "brazil-serie-a",
  "saudi-professional-league",
  "serie-b",
  "champions-league",
  "euroleague-basketball",
  "primeira-liga",
  "fa-cup",
  "ligue-2",
  "fifa-friendly",
  "esports",
  "counter-strike",
  "counter-strike-2",
  "cs2",
  "dota-2",
  "league-of-legends",
  "lol",
  "valorant",
  "honor-of-kings",
  "chess",
  "poker",
  "olympics",
]);

const POLITICS_TAGS = new Set([
  "politics",
  "geopolitics",
  "foreign-policy",
  "macro-geopolitics",
  "ukraine",
  "iran",
  "israel",
  "middle-east",
  "putin",
  "trump",
  "midterms",
  "house-elections",
  "global-elections",
  "us-election",
  "nov-4-elections",
  "primaries",
  "breaking-news",
  "world",
]);

const ECONOMICS_TAGS = new Set([
  "finance",
  "economy",
  "economics",
  "equities",
  "stocks",
  "stock-prices",
  "earnings",
  "commodities",
  "business",
  "financials",
  "companies",
  "company-news",
  "indicies",
  "oil-gas",
]);

const TECHNOLOGY_TAGS = new Set([
  "tech",
  "big-tech",
  "ai",
  "science",
  "science-and-technology",
  "space",
]);

const ENTERTAINMENT_TAGS = new Set([
  "pop-culture",
  "movies",
  "music",
  "awards",
  "celebrities",
  "art",
  "culture",
]);

const WEATHER_TAGS = new Set([
  "weather",
  "temperature",
  "climate",
  "climate-and-weather",
]);

const HEALTH_TAGS = new Set([
  "health",
  "medical",
  "covid",
  "coronavirus",
  "pandemic",
  "biotech",
]);

function normalizeTagToken(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.replace(/[_\s]+/g, "-");
}

function normalizeExplicitCategory(
  value: string | null | undefined,
): PolymarketCategory | undefined {
  const trimmed = s(value);
  if (!trimmed) return undefined;
  const normalized =
    EXPLICIT_CATEGORY_MAP.get(trimmed.toLowerCase()) ??
    EXPLICIT_CATEGORY_MAP.get(normalizeTagToken(trimmed) ?? "");
  return normalized;
}

function extractTagTokens(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const out = new Set<string>();
  for (const tag of tags as PolymarketTagInput[]) {
    if (typeof tag === "string") {
      const normalized = normalizeTagToken(tag);
      if (normalized) out.add(normalized);
      continue;
    }
    if (!tag || typeof tag !== "object") continue;
    const normalizedSlug = normalizeTagToken(tag.slug);
    const normalizedLabel = normalizeTagToken(tag.label);
    if (normalizedSlug) out.add(normalizedSlug);
    if (normalizedLabel) out.add(normalizedLabel);
  }
  return Array.from(out);
}

function scoreTagCategory(tag: string): { category: PolymarketCategory; weight: number } | null {
  if (!tag) return null;

  if (MENTION_TAGS.has(tag)) {
    return { category: "mentions", weight: 10 };
  }

  if (
    POLITICS_TAGS.has(tag) ||
    tag.includes("election") ||
    tag.includes("presidency") ||
    tag.includes("foreign-policy") ||
    tag.includes("peace-deal") ||
    tag.includes("geopolitics") ||
    tag.includes("current-affairs")
  ) {
    return { category: "politics", weight: 3 };
  }
  if (tag === "world") return { category: "politics", weight: 1 };

  if (
    tag === "crypto" ||
    tag === "crypto-prices" ||
    tag === "bitcoin" ||
    tag === "ethereum" ||
    tag === "solana" ||
    tag === "xrp" ||
    tag === "ripple" ||
    tag === "defi" ||
    tag === "nft" ||
    tag === "nfts" ||
    tag.includes("up-or-down")
  ) {
    return { category: "crypto", weight: 3 };
  }

  if (SPORTS_TAGS.has(tag)) return { category: "sports", weight: 3 };
  if (tag === "games") return { category: "sports", weight: 1 };

  if (ECONOMICS_TAGS.has(tag)) return { category: "economics", weight: 3 };

  if (TECHNOLOGY_TAGS.has(tag)) return { category: "technology", weight: 3 };

  if (ENTERTAINMENT_TAGS.has(tag)) {
    return { category: "entertainment", weight: 3 };
  }

  if (WEATHER_TAGS.has(tag)) return { category: "weather", weight: 3 };

  if (HEALTH_TAGS.has(tag)) return { category: "health", weight: 3 };

  return null;
}

export function deriveCategoryFromTags(tags: unknown): PolymarketCategory | undefined {
  const tokens = extractTagTokens(tags);
  if (!tokens.length) return undefined;

  const scores = new Map<PolymarketCategory, number>();
  for (const token of tokens) {
    const scored = scoreTagCategory(token);
    if (!scored) continue;
    scores.set(scored.category, (scores.get(scored.category) ?? 0) + scored.weight);
  }
  if (!scores.size) return undefined;

  let best: { category: PolymarketCategory; score: number } | null = null;
  let tied = false;
  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category);
    if (score == null) continue;
    if (!best || score > best.score) {
      best = { category, score };
      tied = false;
      continue;
    }
    if (best && score === best.score) tied = true;
  }

  if (!best || tied) return undefined;
  return best.category;
}

function tokenizeText(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  return new Set(tokens);
}

function countTextMatches(
  tokens: Set<string>,
  text: string,
  patterns: readonly (string | RegExp)[],
): number {
  let matches = 0;
  for (const pattern of patterns) {
    if (typeof pattern === "string") {
      if (tokens.has(pattern)) matches += 1;
      continue;
    }
    if (pattern.test(text)) matches += 1;
  }
  return matches;
}

function parseOutcomePrices(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const parsed = raw
      .map((value) => n(value))
      .filter((value): value is number => value != null);
    return parsed.length ? parsed : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const values = parsed
          .map((value) => n(value))
          .filter((value): value is number => value != null);
        return values.length ? values : null;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function resolveBinaryOutcome(
  prices: number[] | null,
): "YES" | "NO" | undefined {
  if (!prices || prices.length < 2) return undefined;
  const yes = prices[0];
  const no = prices[1];
  if (yes == null || no == null) return undefined;
  const winThreshold = 0.999;
  const loseThreshold = 0.001;
  if (yes >= winThreshold && no <= loseThreshold) return "YES";
  if (no >= winThreshold && yes <= loseThreshold) return "NO";
  return undefined;
}

export function mapEventRow(venueId: number, e: TEvent) {
  const id = uuid();
  return {
    id,
    venue_id: venueId,
    event_id: e.id,
    title: e.title,
    category: null, // Gamma has categories elsewhere; set later if you need
    slug: e.slug ?? null,
    active: e.active ?? true,
    closed: e.closed ?? false,
    start_time: e.startDate ? new Date(e.startDate) : null,
    end_time: e.endDate ? new Date(e.endDate) : null,
    liquidity: n(e.liquidity),
    volume_total: n(e.volume),
    volume24hr: n(e.volume24hr),
    raw: e,
  };
}

export function mapMarketRow(venueId: number, eventUuid: string, m: TMarket) {
  const id = uuid();
  // prefer numeric *_Num fields if present, else parse the string/number fields
  const liquidity = n(m.liquidityNum ?? m.liquidity);
  const volume_total = n(m.volumeNum ?? m.volume);
  const [yes, no] = m.clobTokenIds ?? [];

  return {
    id,
    event_id: eventUuid,
    venue_id: venueId,
    market_id: m.id,
    title: m.question,
    enable_orderbook: m.enableOrderBook ?? true,
    accepting_orders: m.acceptingOrders ?? true,
    condition_id: m.conditionId ?? null,
    order_price_min_tick_size: n(m.orderPriceMinTickSize),
    order_min_size: n(m.orderMinSize),
    neg_risk: m.negRisk ?? null,
    neg_risk_market_id: m.negRiskMarketID ?? null,
    liquidity,
    volume_total,
    volume24hr: n(m.volume24hr),
    clob_token_yes: yes ?? null,
    clob_token_no: no ?? null,
    raw: m,
  };
}

export function mapTokens(
  marketUuid: string,
  yes?: string | null,
  no?: string | null,
) {
  const rows: Array<{
    token_id: string;
    market_id: string;
    side: "YES" | "NO";
  }> = [];
  if (yes)
    rows.push({ token_id: yes, market_id: marketUuid, side: "YES" as const });
  if (no)
    rows.push({ token_id: no, market_id: marketUuid, side: "NO" as const });
  return rows;
}

// New Polymarket-specific mappers
export function mapPolymarketEventRow(e: TPolymarketEvent) {
  const extra = e as Record<string, unknown>;
  return {
    id: e.id,
    ticker: e.ticker,
    slug: e.slug,
    title: e.title,
    description: e.description,
    resolution_source: e.resolutionSource,
    start_date: e.startDate ? new Date(e.startDate) : null,
    creation_date: e.creationDate ? new Date(e.creationDate) : null,
    end_date: e.endDate ? new Date(e.endDate) : null,
    category:
      resolvePolymarketCategory({
        explicitCategory: e.category,
        tags: extra.tags,
        title: e.title,
        description: e.description,
      }) ?? null,
    image: e.image,
    icon: e.icon,
    active: e.active ?? true,
    closed: e.closed ?? false,
    archived: e.archived ?? false,
    new: e.new ?? false,
    featured: e.featured ?? false,
    restricted: e.restricted ?? false,
    liquidity: n(e.liquidity),
    volume: n(e.volume),
    open_interest: n(e.openInterest),
    created_by: e.createdBy,
    created_at: e.createdAt ? new Date(e.createdAt) : null,
    updated_at: e.updatedAt ? new Date(e.updatedAt) : null,
    competitive: n(e.competitive),
    volume24hr: n(e.volume24hr),
    volume1wk: n(e.volume1wk),
    volume1mo: n(e.volume1mo),
    volume1yr: n(e.volume1yr),
    enable_order_book: e.enableOrderBook ?? true,
    liquidity_clob: n(e.liquidityClob),
    neg_risk: e.negRisk ?? false,
    comment_count: n(e.commentCount),
    raw: e,
  };
}

export function mapPolymarketMarketRow(
  eventId: string,
  m: TPolymarketMarket,
  event?: TPolymarketEvent,
) {
  const extra = m as Record<string, unknown>;
  return {
    id: m.id,
    event_id: eventId,
    question: m.question,
    condition_id: m.conditionId,
    slug: m.slug,
    resolution_source: m.resolutionSource,
    end_date: m.endDate ? new Date(m.endDate) : null,
    category:
      resolvePolymarketCategory({
        explicitCategory: m.category ?? event?.category ?? null,
        tags:
          (Array.isArray(extra.tags) && extra.tags) ||
          ((event as Record<string, unknown> | undefined)?.tags as unknown),
        title: m.question,
        description: m.description,
      }) ?? null,
    liquidity: m.liquidity,
    start_date: m.startDate ? new Date(m.startDate) : null,
    image: m.image,
    icon: m.icon,
    description: m.description,
    outcomes: m.outcomes,
    outcome_prices: m.outcomePrices,
    volume: m.volume,
    active: m.active ?? true,
    closed: m.closed ?? false,
    market_maker_address: m.marketMakerAddress,
    created_at: m.createdAt ? new Date(m.createdAt) : null,
    updated_at: m.updatedAt ? new Date(m.updatedAt) : null,
    new: m.new ?? false,
    featured: m.featured ?? false,
    submitted_by: m.submitted_by,
    archived: m.archived ?? false,
    resolved_by: m.resolvedBy,
    restricted: m.restricted ?? false,
    group_item_title: m.groupItemTitle,
    group_item_threshold: m.groupItemThreshold,
    question_id: m.questionID,
    enable_order_book: m.enableOrderBook ?? true,
    order_price_min_tick_size: n(m.orderPriceMinTickSize),
    order_min_size: n(m.orderMinSize),
    volume_num: n(m.volumeNum),
    liquidity_num: n(m.liquidityNum),
    end_date_iso: m.endDateIso,
    start_date_iso: m.startDateIso,
    has_reviewed_dates: m.hasReviewedDates ?? false,
    volume24hr: n(m.volume24hr),
    volume1wk: n(m.volume1wk),
    volume1mo: n(m.volume1mo),
    volume1yr: n(m.volume1yr),
    clob_token_ids: Array.isArray(m.clobTokenIds)
      ? JSON.stringify(m.clobTokenIds)
      : m.clobTokenIds,
    uma_bond: m.umaBond,
    uma_reward: m.umaReward,
    volume24hr_clob: n(m.volume24hrClob),
    volume1wk_clob: n(m.volume1wkClob),
    volume1mo_clob: n(m.volume1moClob),
    volume1yr_clob: n(m.volume1yrClob),
    volume_clob: n(m.volumeClob),
    liquidity_clob: n(m.liquidityClob),
    custom_liveness: n(m.customLiveness),
    accepting_orders: m.acceptingOrders ?? true,
    neg_risk: m.negRisk ?? false,
    neg_risk_market_id: m.negRiskMarketID ?? null,
    neg_risk_request_id: m.negRiskRequestID,
    ready: m.ready ?? false,
    funded: m.funded ?? false,
    accepting_orders_timestamp: m.acceptingOrdersTimestamp
      ? new Date(m.acceptingOrdersTimestamp)
      : null,
    cyom: m.cyom ?? false,
    competitive: n(m.competitive),
    pager_duty_notification_enabled: m.pagerDutyNotificationEnabled ?? false,
    approved: m.approved ?? false,
    rewards_min_size: n(m.rewardsMinSize),
    rewards_max_spread: n(m.rewardsMaxSpread),
    spread: n(m.spread),
    one_day_price_change: n(m.oneDayPriceChange),
    one_hour_price_change: n(m.oneHourPriceChange),
    one_week_price_change: n(m.oneWeekPriceChange),
    one_month_price_change: n(m.oneMonthPriceChange),
    last_trade_price: n(m.lastTradePrice),
    best_bid: n(m.bestBid),
    best_ask: n(m.bestAsk),
    automatically_active: m.automaticallyActive ?? true,
    clear_book_on_start: m.clearBookOnStart ?? true,
    series_color: m.seriesColor,
    show_gmp_series: m.showGmpSeries ?? false,
    show_gmp_outcome: m.showGmpOutcome ?? false,
    manual_activation: m.manualActivation ?? false,
    neg_risk_other: m.negRiskOther ?? false,
    uma_resolution_statuses: m.umaResolutionStatuses,
    pending_deployment: m.pendingDeployment ?? false,
    deploying: m.deploying ?? false,
    deploying_timestamp: m.deployingTimestamp
      ? new Date(m.deployingTimestamp)
      : null,
    rfq_enabled: m.rfqEnabled ?? false,
    holding_rewards_enabled: m.holdingRewardsEnabled ?? false,
    fees_enabled: m.feesEnabled ?? false,
    raw: m,
  };
}

// Unified table mappers for Polymarket
function extractCategoryFromTitle(
  title: string,
  description?: string | null,
): PolymarketCategory | undefined {
  const text = `${title} ${description || ""}`.toLowerCase();
  const tokens = tokenizeText(text);

  const scores = new Map<PolymarketCategory, number>();
  const addScore = (
    category: PolymarketCategory,
    patterns: readonly (string | RegExp)[],
  ) => {
    const score = countTextMatches(tokens, text, patterns);
    if (score > 0) scores.set(category, (scores.get(category) ?? 0) + score);
  };

  addScore("politics", [
    "election",
    "elections",
    "president",
    "congress",
    "senate",
    "vote",
    "candidate",
    "government",
    "policy",
    "democrat",
    "republican",
    "biden",
    "trump",
    "iran",
    "israel",
    "ukraine",
    "russia",
    "ceasefire",
    "war",
    "strike",
    "leader",
    "sanctions",
    /foreign policy/,
    /middle east/,
  ]);
  addScore("crypto", [
    "bitcoin",
    "ethereum",
    "crypto",
    "blockchain",
    "defi",
    "nft",
    "altcoin",
    "dogecoin",
    "solana",
    "cardano",
    "polygon",
    "token",
  ]);
  addScore("sports", [
    "nfl",
    "nba",
    "mlb",
    "soccer",
    "football",
    "basketball",
    "baseball",
    "hockey",
    "olympics",
    "championship",
    "playoff",
    /super bowl/,
  ]);
  addScore("economics", [
    "gdp",
    "inflation",
    "recession",
    "fed",
    "economy",
    "financial",
    /interest rate/,
    "unemployment",
    "stocks",
    "earnings",
  ]);
  addScore("technology", [
    "ai",
    "tech",
    "apple",
    "google",
    "microsoft",
    "tesla",
    "meta",
    "amazon",
    /artificial intelligence/,
  ]);
  addScore("entertainment", [
    "movie",
    "film",
    "oscar",
    "netflix",
    "disney",
    "marvel",
    "celebrity",
    "music",
    "award",
    /star wars/,
  ]);
  addScore("weather", [
    "hurricane",
    "tornado",
    "weather",
    "climate",
    "temperature",
    "snow",
    "storm",
    "rain",
  ]);
  addScore("health", [
    "covid",
    "pandemic",
    "vaccine",
    "health",
    "medical",
    "disease",
    "hospital",
    "biotech",
  ]);

  if (!scores.size) return undefined;

  let best: { category: PolymarketCategory; score: number } | null = null;
  let tied = false;
  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category);
    if (score == null) continue;
    if (!best || score > best.score) {
      best = { category, score };
      tied = false;
      continue;
    }
    if (best && score === best.score) tied = true;
  }

  if (!best || tied) return undefined;
  return best.category;
}

export function resolvePolymarketCategory(input: {
  explicitCategory?: string | null;
  tags?: unknown;
  title: string;
  description?: string | null;
}): PolymarketCategory {
  return (
    normalizeExplicitCategory(input.explicitCategory) ??
    deriveCategoryFromTags(input.tags) ??
    extractCategoryFromTitle(input.title, input.description) ??
    "other"
  );
}

export function resolvePolymarketCategoryFromRaw(
  raw: unknown,
  fallback: {
    explicitCategory?: string | null;
    title?: string | null;
    description?: string | null;
  } = {},
): PolymarketCategory {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const explicitCategory =
    (typeof record.category === "string" ? record.category : undefined) ??
    fallback.explicitCategory;
  const title =
    (typeof record.title === "string" ? record.title : undefined) ??
    (typeof record.question === "string" ? record.question : undefined) ??
    fallback.title;
  if (!title) return normalizeExplicitCategory(explicitCategory) ?? "other";
  const description =
    (typeof record.description === "string" ? record.description : undefined) ??
    fallback.description;
  return resolvePolymarketCategory({
    explicitCategory,
    tags: record.tags,
    title,
    description,
  });
}

export function mapToUnifiedEvent(e: TPolymarketEvent): UnifiedEventRow {
  const extra = e as Record<string, unknown>;
  const seriesList = Array.isArray(extra.series) ? extra.series : [];
  const series0 =
    seriesList.length > 0 && typeof seriesList[0] === "object"
      ? (seriesList[0] as Record<string, unknown>)
      : null;
  const seriesKey =
    s(series0?.slug) ??
    s(series0?.ticker) ??
    s(extra.seriesSlug) ??
    s(extra.series_slug);
  const seriesTitle =
    s(series0?.title) ?? s(extra.seriesTitle) ?? s(extra.series_title);
  const metadata = compactMetadata({
    ticker: s(extra.ticker),
    resolutionSource: s(extra.resolutionSource),
    creationDate: s(extra.creationDate),
    createdBy: s(extra.createdBy),
    sponsorName: s(extra.sponsorName),
    sponsorImage: s(extra.sponsorImage),
    twitterCardImage: s(extra.twitterCardImage),
    competitive: nOrUndefined(extra.competitive),
    volume1wk: nOrUndefined(extra.volume1wk),
    volume1mo: nOrUndefined(extra.volume1mo),
    volume1yr: nOrUndefined(extra.volume1yr),
    enableOrderBook: bool(extra.enableOrderBook),
    liquidityClob: nOrUndefined(extra.liquidityClob),
    negRisk: bool(extra.negRisk),
    commentCount: nOrUndefined(extra.commentCount),
  });

  // Map Polymarket status to unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";

  const endDate = e.endDate ? new Date(e.endDate) : null;
  const isExpired = endDate && endDate < new Date();

  if (e.archived) {
    status = "ARCHIVED";
  } else if (e.closed || (e.active && e.closed) || isExpired) {
    // Mark as CLOSED if:
    // 1. closed flag is true, OR
    // 2. both active=true and closed=true (contradictory state - treat as closed), OR
    // 3. endDate has passed (expired)
    status = "CLOSED";
  }

  return {
    id: `polymarket:${e.id}`,
    venue: "polymarket",
    venue_event_id: e.id,
    title: e.title,
    description: e.description ?? undefined,
    category: resolvePolymarketCategory({
      explicitCategory: e.category,
      tags: extra.tags,
      title: e.title,
      description: e.description,
    }),
    status,
    series_key: seriesKey ?? undefined,
    series_title: seriesTitle ?? undefined,
    start_date: e.startDate ? new Date(e.startDate) : undefined,
    end_date: e.endDate ? new Date(e.endDate) : undefined,
    volume_total: n(e.volume) ?? undefined,
    volume_24h: n(e.volume24hr) ?? undefined,
    open_interest: n(e.openInterest) ?? undefined,
    liquidity: n(e.liquidity) ?? undefined,
    metadata,
    slug: e.slug ?? undefined,
    image: e.image ?? undefined,
    icon: e.icon ?? undefined,
    created_at: e.createdAt ? new Date(e.createdAt) : undefined,
    updated_at: e.updatedAt ? new Date(e.updatedAt) : undefined,
  };
}

export function mapToUnifiedMarket(
  m: TPolymarketMarket,
  eventId: string,
  event?: TPolymarketEvent,
): UnifiedMarketRow {
  const extra = m as Record<string, unknown>;

  // Map Polymarket status to unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";

  if (m.archived) {
    status = "ARCHIVED";
  } else if (m.closed || (m.active && m.closed)) {
    // Prefer explicit close flags over endDate since Polymarket can
    // keep accepting orders after the scheduled end time.
    status = "CLOSED";
  } else if (m.acceptingOrders === false) {
    status = "CLOSED";
  }

  // Handle clob_token_ids - convert to JSON string if it's an array
  let clobTokenIds: string | undefined = undefined;
  if (m.clobTokenIds) {
    if (Array.isArray(m.clobTokenIds)) {
      clobTokenIds = JSON.stringify(m.clobTokenIds);
    } else {
      clobTokenIds = m.clobTokenIds;
    }
  }

  const title = (() => {
    const groupItemTitle =
      typeof m.groupItemTitle === "string" ? m.groupItemTitle.trim() : "";
    if (groupItemTitle) return groupItemTitle;
    return m.question;
  })();

  const outcomePrices = parseOutcomePrices(m.outcomePrices ?? extra.outcomePrices);
  const resolvedOutcome =
    status !== "ACTIVE" ? resolveBinaryOutcome(outcomePrices) : undefined;

  const metadata = compactMetadata({
    question: s(extra.question),
    resolutionSource: s(extra.resolutionSource),
    outcomes: s(extra.outcomes),
    outcomePrices: s(extra.outcomePrices),
    fee: nOrUndefined(extra.fee),
    marketMakerAddress: s(extra.marketMakerAddress),
    clobTokenIds: Array.isArray(m.clobTokenIds) ? m.clobTokenIds : undefined,
    groupItemTitle: s(extra.groupItemTitle),
    groupItemThreshold: s(extra.groupItemThreshold),
    questionId: s(extra.questionID),
    enableOrderBook: bool(extra.enableOrderBook),
    orderPriceMinTickSize: nOrUndefined(extra.orderPriceMinTickSize),
    orderMinSize: nOrUndefined(extra.orderMinSize),
    volume1wk: nOrUndefined(extra.volume1wk),
    volume1mo: nOrUndefined(extra.volume1mo),
    volume1yr: nOrUndefined(extra.volume1yr),
    volume24hrClob: nOrUndefined(extra.volume24hrClob),
    volume1wkClob: nOrUndefined(extra.volume1wkClob),
    volume1moClob: nOrUndefined(extra.volume1moClob),
    volume1yrClob: nOrUndefined(extra.volume1yrClob),
    volumeClob: nOrUndefined(extra.volumeClob),
    volumeAmm: nOrUndefined(extra.volumeAmm),
    liquidityClob: nOrUndefined(extra.liquidityClob),
    liquidityAmm: nOrUndefined(extra.liquidityAmm),
    acceptingOrders: bool(extra.acceptingOrders),
    acceptingOrdersTimestamp: s(extra.acceptingOrdersTimestamp),
    ready: bool(extra.ready),
    funded: bool(extra.funded),
    negRisk: bool(extra.negRisk),
    negRiskRequestId: s(extra.negRiskRequestID),
    umaBond: s(extra.umaBond),
    umaReward: s(extra.umaReward),
    umaResolutionStatuses: s(extra.umaResolutionStatuses),
    customLiveness: nOrUndefined(extra.customLiveness),
    ammType: s(extra.ammType),
    denominationToken: s(extra.denominationToken),
    lowerBound: s(extra.lowerBound),
    upperBound: s(extra.upperBound),
    lowerBoundDate: s(extra.lowerBoundDate),
    upperBoundDate: s(extra.upperBoundDate),
    marketType: s(extra.marketType),
    formatType: s(extra.formatType),
  });

  return {
    id: `polymarket:${m.id}`,
    venue: "polymarket",
    venue_market_id: m.id,
    event_id: `polymarket:${eventId}`,
    title,
    description: m.description ?? undefined,
    category: resolvePolymarketCategory({
      explicitCategory: m.category ?? event?.category ?? null,
      tags:
        (Array.isArray(extra.tags) && extra.tags) ||
        ((event as Record<string, unknown> | undefined)?.tags as unknown),
      title: m.question,
      description: m.description,
    }),
    status,
    market_type: "binary", // Polymarket markets are binary
    open_time: m.startDate ? new Date(m.startDate) : undefined,
    close_time: m.endDate ? new Date(m.endDate) : undefined,
    expiration_time: m.endDate ? new Date(m.endDate) : undefined,
    best_bid: n(m.bestBid) ?? undefined,
    best_ask: n(m.bestAsk) ?? undefined,
    last_price: n(m.lastTradePrice) ?? undefined,
    volume_total: n(m.volume) ?? undefined,
    volume_24h: n(m.volume24hr) ?? undefined,
    open_interest: n(m.openInterest) ?? undefined,
    liquidity: n(m.liquidity) ?? undefined,
    metadata,
    outcomes: m.outcomes ?? undefined, // Already JSON string
    clob_token_ids: clobTokenIds,
    condition_id: m.conditionId ?? undefined,
    resolved_outcome: resolvedOutcome,
    resolved_outcome_pct: undefined,
    slug: m.slug ?? undefined,
    image: m.image ?? undefined,
    icon: m.icon ?? undefined,
    created_at: m.createdAt ? new Date(m.createdAt) : undefined,
    updated_at: m.updatedAt ? new Date(m.updatedAt) : undefined,
  };
}
