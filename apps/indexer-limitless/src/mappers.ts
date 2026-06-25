import { v4 as uuid } from "uuid";
import type { TLimitlessMarket, TLimitlessMarketItem } from "./types.js";
import type {
  LimitlessEventRow,
  LimitlessMarketRow,
} from "./limitless-repo.js";
import { resolveLimitlessGroupId } from "./grouping.js";
import {
  deriveLimitlessDurationMinutes,
  type UnifiedEventRow,
  type UnifiedMarketRow,
} from "@hunch/db";
import { normalizeLimitlessPricePair } from "./price-normalization.js";

export type LimitlessCategory =
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

type CategoryResolutionInput = {
  categories?: string[] | null;
  tags?: string[] | null;
  title?: string | null;
  description?: string | null;
  fallbackCategories?: string[] | null;
  fallbackTags?: string[] | null;
  fallbackTitle?: string | null;
  fallbackDescription?: string | null;
};

const CATEGORY_PRIORITY: readonly LimitlessCategory[] = [
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

const IGNORE_CATEGORY_TOKENS = new Set([
  "15-min",
  "15m",
  "daily",
  "hourly",
  "monthly",
  "recurring",
  "weekly",
]);

const EXPLICIT_CATEGORY_MAP = new Map<string, LimitlessCategory>([
  ["mentions", "mentions"],
  ["mention-markets", "mentions"],
  ["tweet-markets", "mentions"],
  ["tweets-markets", "mentions"],

  ["politics", "politics"],
  ["politic", "politics"],
  ["military", "politics"],

  ["crypto", "crypto"],
  ["bitcoin", "crypto"],
  ["btc", "crypto"],
  ["ethereum", "crypto"],
  ["eth", "crypto"],
  ["solana", "crypto"],
  ["xrp", "crypto"],
  ["pre-tge", "crypto"],

  ["sports", "sports"],
  ["football", "sports"],
  ["football-matches", "sports"],
  ["football-matches-", "sports"],
  ["cricket", "sports"],
  ["f1", "sports"],
  ["nba", "sports"],
  ["nhl", "sports"],
  ["winter-olympics", "sports"],
  ["esports", "sports"],
  ["off-the-pitch", "sports"],

  ["economics", "economics"],
  ["economy", "economics"],
  ["company-news", "economics"],
  ["commodities", "economics"],
  ["oil-gas", "economics"],
  ["oil-and-gas", "economics"],
  ["korean-market", "economics"],

  ["technology", "technology"],
  ["tech", "technology"],
  ["ai", "technology"],

  ["entertainment", "entertainment"],
  ["culture", "entertainment"],

  ["weather", "weather"],
  ["climate", "weather"],

  ["health", "health"],

  ["other", "other"],
]);

const SPORTS_TAGS = new Set([
  "sports",
  "football",
  "football-matches",
  "cricket",
  "f1",
  "nba",
  "nhl",
  "winter-olympics",
  "esports",
  "off-the-pitch",
]);

const POLITICS_TAGS = new Set(["politics", "military"]);
const CRYPTO_TAGS = new Set([
  "crypto",
  "bitcoin",
  "btc",
  "ethereum",
  "eth",
  "solana",
  "xrp",
  "pre-tge",
  "nav-domain-crypto",
]);
const ECONOMICS_TAGS = new Set([
  "economy",
  "company-news",
  "commodities",
  "oil-gas",
  "oil-and-gas",
  "korean-market",
  "finance",
  "nav-domain-finance",
]);
const TECHNOLOGY_TAGS = new Set([
  "technology",
  "tech",
  "ai",
  "nav-domain-technology",
]);
const ENTERTAINMENT_TAGS = new Set(["entertainment", "culture"]);
const WEATHER_TAGS = new Set(["weather", "climate"]);
const HEALTH_TAGS = new Set(["health"]);
const MENTIONS_TAGS = new Set([
  "mentions",
  "mention-markets",
  "tweets-markets",
]);
const POLITICS_DOMAIN_TAGS = new Set([
  "nav-domain-politics",
  "nav-domain-news",
]);
const SPORTS_DOMAIN_TAGS = new Set(["nav-domain-sports", "nav-domain-sport"]);

// helper: parse volume (prefer formatted; else scale by decimals if looks integery)
function parseVolume(
  volume?: string | number | null,
  volumeFormatted?: string | null,
  decimals = 6,
): number | null {
  if (volumeFormatted && !Number.isNaN(Number(volumeFormatted)))
    return Number(volumeFormatted);
  if (volume != null && Number.isFinite(Number(volume))) {
    return Number(volume) / Math.pow(10, decimals);
  }
  return null;
}

function parseMetric(
  value?: string | number | null,
  formatted?: string | null,
  decimals = 6,
): number | null {
  if (formatted && !Number.isNaN(Number(formatted))) return Number(formatted);
  if (value != null && Number.isFinite(Number(value))) {
    return Number(value) / Math.pow(10, decimals);
  }
  return null;
}

// Limitless AMM liquidity is not comparable to venue orderbook liquidity.
function parseComparableLiquidity(
  tradeType: string | null | undefined,
  value?: string | number | null,
  formatted?: string | null,
  decimals = 6,
): number | null {
  if (tradeType?.toLowerCase() === "amm") return null;
  return parseMetric(value, formatted, decimals);
}

function normalizePositionIds(
  value?: Array<string | string[]> | null,
): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (Array.isArray(entry)) {
      for (const id of entry) {
        if (id) out.push(id);
      }
    } else if (entry) {
      out.push(entry);
    }
  }
  return out;
}

const parseDate = (dateStr?: string | null): Date | null => {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
};

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeCategoryList(values?: string[] | null): string[] {
  if (!values?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const token = normalizeToken(value);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function collectTextTokens(
  ...inputs: Array<string | null | undefined>
): Set<string> {
  const tokens = new Set<string>();
  for (const input of inputs) {
    if (!input) continue;
    for (const token of normalizeToken(input).split("-")) {
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

function scoreCategoryToken(
  token: string,
  scores: Map<LimitlessCategory, number>,
): void {
  if (IGNORE_CATEGORY_TOKENS.has(token)) return;

  const explicit = EXPLICIT_CATEGORY_MAP.get(token);
  if (explicit) {
    scores.set(explicit, (scores.get(explicit) ?? 0) + 3);
    return;
  }

  if (MENTIONS_TAGS.has(token)) {
    scores.set("mentions", (scores.get("mentions") ?? 0) + 4);
    return;
  }
  if (POLITICS_TAGS.has(token)) {
    scores.set("politics", (scores.get("politics") ?? 0) + 3);
    return;
  }
  if (POLITICS_DOMAIN_TAGS.has(token)) {
    scores.set("politics", (scores.get("politics") ?? 0) + 3);
    return;
  }
  if (CRYPTO_TAGS.has(token)) {
    scores.set("crypto", (scores.get("crypto") ?? 0) + 3);
    return;
  }
  if (SPORTS_TAGS.has(token)) {
    scores.set("sports", (scores.get("sports") ?? 0) + 3);
    return;
  }
  if (SPORTS_DOMAIN_TAGS.has(token)) {
    scores.set("sports", (scores.get("sports") ?? 0) + 3);
    return;
  }
  if (ECONOMICS_TAGS.has(token)) {
    scores.set("economics", (scores.get("economics") ?? 0) + 3);
    return;
  }
  if (TECHNOLOGY_TAGS.has(token)) {
    scores.set("technology", (scores.get("technology") ?? 0) + 3);
    return;
  }
  if (ENTERTAINMENT_TAGS.has(token)) {
    scores.set("entertainment", (scores.get("entertainment") ?? 0) + 3);
    return;
  }
  if (WEATHER_TAGS.has(token)) {
    scores.set("weather", (scores.get("weather") ?? 0) + 3);
    return;
  }
  if (HEALTH_TAGS.has(token)) {
    scores.set("health", (scores.get("health") ?? 0) + 3);
  }
}

function bestScoredCategory(
  scores: Map<LimitlessCategory, number>,
): LimitlessCategory | undefined {
  let best: LimitlessCategory | undefined;
  let bestScore = 0;
  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category) ?? 0;
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  if (!best || bestScore <= 0) return undefined;
  return best;
}

function deriveCategoryFromTokens(
  tokens: string[],
): LimitlessCategory | undefined {
  const scores = new Map<LimitlessCategory, number>();
  for (const token of tokens) {
    scoreCategoryToken(token, scores);
  }
  return bestScoredCategory(scores);
}

function deriveCategoryFromText(
  title?: string | null,
  description?: string | null,
): LimitlessCategory | undefined {
  const tokens = collectTextTokens(title, description);

  if (
    tokens.has("trump") ||
    tokens.has("president") ||
    tokens.has("election")
  ) {
    return "politics";
  }
  if (tokens.has("bitcoin") || tokens.has("ethereum") || tokens.has("solana")) {
    return "crypto";
  }
  if (tokens.has("binance") || tokens.has("token")) {
    return "crypto";
  }
  if (
    tokens.has("nba") ||
    tokens.has("nhl") ||
    tokens.has("football") ||
    tokens.has("match") ||
    tokens.has("cricket")
  ) {
    return "sports";
  }
  if (
    tokens.has("earnings") ||
    tokens.has("company") ||
    tokens.has("commodities") ||
    tokens.has("oil")
  ) {
    return "economics";
  }
  if (tokens.has("ai") || tokens.has("tech")) {
    return "technology";
  }
  return undefined;
}

export function resolveLimitlessCategory({
  categories,
  tags,
  title,
  description,
  fallbackCategories,
  fallbackTags,
  fallbackTitle,
  fallbackDescription,
}: CategoryResolutionInput): LimitlessCategory {
  const categoryTokens = normalizeCategoryList(categories);
  const tagTokens = normalizeCategoryList(tags);
  const fallbackCategoryTokens = normalizeCategoryList(fallbackCategories);
  const fallbackTagTokens = normalizeCategoryList(fallbackTags);

  return (
    deriveCategoryFromTokens(categoryTokens) ??
    deriveCategoryFromTokens(tagTokens) ??
    deriveCategoryFromTokens(fallbackCategoryTokens) ??
    deriveCategoryFromTokens(fallbackTagTokens) ??
    deriveCategoryFromText(title, description) ??
    deriveCategoryFromText(fallbackTitle, fallbackDescription) ??
    "other"
  );
}

function normalizePrices(
  prices: Array<number | undefined>,
  tradeType?: string | null,
): Array<number | undefined> {
  return normalizeLimitlessPricePair(prices, tradeType);
}

function pickImage(input: {
  ogImageURI?: string | null;
  logo?: string | null;
  creator?: { imageURI?: string | null } | null;
}): string | undefined {
  return input.ogImageURI ?? input.logo ?? input.creator?.imageURI ?? undefined;
}

function pickIcon(input: {
  logo?: string | null;
  creator?: { imageURI?: string | null } | null;
}): string | undefined {
  return input.creator?.imageURI ?? input.logo ?? undefined;
}

function extractVenueInfo(
  market: TLimitlessMarketItem | TLimitlessMarket,
): { exchange?: string; adapter?: string } | undefined {
  const venue = (
    market as {
      venue?: {
        exchange?: unknown;
        exchangeAddress?: unknown;
        adapter?: unknown;
      };
      exchange?: unknown;
      exchangeAddress?: unknown;
    }
  ).venue;
  const exchangeFromVenue =
    venue && typeof venue.exchange === "string" ? venue.exchange : undefined;
  const exchangeAddressFromVenue =
    venue && typeof venue.exchangeAddress === "string"
      ? venue.exchangeAddress
      : undefined;
  const exchangeFromRoot =
    typeof (market as { exchange?: unknown }).exchange === "string"
      ? ((market as { exchange?: string }).exchange ?? undefined)
      : undefined;
  const exchangeAddressFromRoot =
    typeof (market as { exchangeAddress?: unknown }).exchangeAddress ===
    "string"
      ? ((market as { exchangeAddress?: string }).exchangeAddress ?? undefined)
      : undefined;
  const exchange =
    exchangeFromVenue ??
    exchangeAddressFromVenue ??
    exchangeFromRoot ??
    exchangeAddressFromRoot;
  const adapter =
    venue && typeof venue.adapter === "string" ? venue.adapter : undefined;
  if (!exchange && !adapter) return undefined;
  return { exchange, adapter };
}

function prefixLimitlessToken(tokenId?: string | null): string | undefined {
  if (!tokenId) return undefined;
  return tokenId.startsWith("limitless:") ? tokenId : `limitless:${tokenId}`;
}

function normalizeOutcomeTokenId(value?: string | null): string | null {
  if (!value) return null;
  return value.startsWith("limitless:") ? value.slice(10) : value;
}

function resolveOutcomeTokens(market: {
  tokens?: { yes?: string | null; no?: string | null } | null;
  positionIds?: Array<string | string[]> | null;
}): { yes?: string; no?: string } {
  const explicitYes = market.tokens?.yes ?? null;
  const explicitNo = market.tokens?.no ?? null;
  if (explicitYes || explicitNo) {
    return {
      yes: explicitYes ?? undefined,
      no: explicitNo ?? undefined,
    };
  }
  const normalized = normalizePositionIds(market.positionIds);
  return {
    yes: normalized[0],
    no: normalized[1],
  };
}

function resolveLimitlessOutcome(
  market: TLimitlessMarketItem | TLimitlessMarket,
  outcomeTokens: { yes?: string; no?: string },
): "YES" | "NO" | undefined {
  const winningOutcomeIndex = market.winningOutcomeIndex;
  if (winningOutcomeIndex == null) return undefined;

  const orderedTokens =
    Array.isArray(market.outcomeTokens) && market.outcomeTokens.length
      ? market.outcomeTokens
      : normalizePositionIds(market.positionIds);
  const winningToken = orderedTokens[winningOutcomeIndex] ?? null;

  const normalizedWinning = normalizeOutcomeTokenId(winningToken);
  const normalizedYes = normalizeOutcomeTokenId(outcomeTokens.yes);
  const normalizedNo = normalizeOutcomeTokenId(outcomeTokens.no);

  if (normalizedWinning && normalizedWinning === normalizedYes) return "YES";
  if (normalizedWinning && normalizedWinning === normalizedNo) return "NO";
  if (winningOutcomeIndex === 0) return "YES";
  if (winningOutcomeIndex === 1) return "NO";
  return undefined;
}

function isLimitlessResolved(
  market: TLimitlessMarketItem | TLimitlessMarket,
): boolean {
  return market.status === "RESOLVED" || market.winningOutcomeIndex != null;
}

export function mapLimitlessEventRow(lm: TLimitlessMarket): LimitlessEventRow {
  const volumeTotal = parseVolume(
    lm.volume,
    lm.volumeFormatted,
    lm.collateralToken?.decimals,
  );

  return {
    id: String(lm.id),
    slug: lm.slug || null,
    title: lm.title,
    description: lm.description || null,
    tags: lm.tags || [],
    status: lm.status,
    expired: lm.expired,
    creator_name: lm.creator?.name || null,
    creator_image_uri: lm.creator?.imageURI || null,
    creator_link: lm.creator?.link || null,
    logo: lm.logo || null,
    categories: lm.categories || [],
    market_type: lm.marketType,
    proxy_title: lm.proxyTitle || null,
    condition_id: lm.conditionId || null,
    is_rewardable: lm.isRewardable || false,
    priority_index: lm.priorityIndex || 0,
    expiration_date: lm.expirationDate || null,
    expiration_timestamp: lm.expirationTimestamp || null,
    volume: lm.volume || null,
    volume_formatted: lm.volumeFormatted || null,
    volume_total: volumeTotal,
    trends_rank: lm.trends?.hourly?.rank || null,
    trends_value: lm.trends?.hourly?.value || null,
    metadata_fee: lm.metadata?.fee || false,
    metadata_is_bannered: lm.metadata?.isBannered || false,
    metadata_is_poly_arbitrage: lm.metadata?.isPolyArbitrage || false,
    metadata_should_market_make: lm.metadata?.shouldMarketMake || false,
    settings_c: lm.settings?.c || null,
    settings_min_size: lm.settings?.minSize || null,
    settings_max_spread: lm.settings?.maxSpread || null,
    settings_daily_reward: lm.settings?.dailyReward || null,
    settings_rewards_epoch: lm.settings?.rewardsEpoch || null,
    collateral_token_symbol: lm.collateralToken?.symbol || null,
    collateral_token_address: lm.collateralToken?.address || null,
    collateral_token_decimals: lm.collateralToken?.decimals || 6,
    neg_risk_request_id: lm.negRiskRequestId || null,
    neg_risk_market_id: lm.negRiskMarketId || null,
    winning_outcome_index: lm.winningOutcomeIndex ?? null,
    og_image_uri: lm.ogImageURI || null,
    daily_reward: lm.dailyReward || null,
    outcome_tokens: lm.outcomeTokens || [],
    trade_type: lm.tradeType ?? "clob",
    created_at: parseDate(lm.createdAt),
    updated_at: parseDate(lm.updatedAt),
    raw: lm,
  };
}

export function mapLimitlessMarketRow(
  eventId: string,
  market: TLimitlessMarketItem | TLimitlessMarket,
): LimitlessMarketRow {
  const volumeTotal = parseVolume(
    market.volume,
    market.volumeFormatted,
    market.collateralToken?.decimals,
  );
  const outcomeTokens = resolveOutcomeTokens(market);
  const groupId =
    resolveLimitlessGroupId(market) ??
    (eventId !== String(market.id) ? eventId : undefined);

  return {
    id: String(market.id),
    event_id: eventId,
    slug: market.slug || null,
    title: market.title,
    description: market.description || null,
    tags: market.tags || [],
    status: market.status,
    expired: market.expired,
    creator_name: market.creator?.name || null,
    creator_image_uri: market.creator?.imageURI || null,
    creator_link: market.creator?.link || null,
    logo: market.logo || null,
    categories: market.categories || [],
    market_type: market.marketType,
    proxy_title: market.proxyTitle || null,
    condition_id: market.conditionId || null,
    is_rewardable: market.isRewardable || false,
    priority_index: market.priorityIndex || 0,
    expiration_date: market.expirationDate || null,
    expiration_timestamp: market.expirationTimestamp || null,
    volume: market.volume || null,
    volume_formatted: market.volumeFormatted || null,
    volume_total: volumeTotal,
    prices: market.prices || [],
    tokens_no: outcomeTokens.no ?? null,
    tokens_yes: outcomeTokens.yes ?? null,
    metadata_fee: market.metadata?.fee || false,
    metadata_is_bannered: market.metadata?.isBannered || false,
    metadata_is_poly_arbitrage: market.metadata?.isPolyArbitrage || false,
    metadata_should_market_make: market.metadata?.shouldMarketMake || false,
    settings_c: market.settings?.c || null,
    settings_min_size: market.settings?.minSize || null,
    settings_max_spread: market.settings?.maxSpread || null,
    settings_daily_reward: market.settings?.dailyReward || null,
    settings_rewards_epoch: market.settings?.rewardsEpoch || null,
    collateral_token_symbol: market.collateralToken?.symbol || null,
    collateral_token_address: market.collateralToken?.address || null,
    collateral_token_decimals: market.collateralToken?.decimals || 6,
    neg_risk_request_id: market.negRiskRequestId || null,
    winning_outcome_index: market.winningOutcomeIndex ?? null,
    trade_type: market.tradeType ?? "clob",
    created_at: parseDate(market.createdAt),
    updated_at: parseDate(market.updatedAt),
    raw: groupId ? { ...market, groupId } : market,
  };
}

// Legacy functions for backward compatibility with existing code
export function mapEventRow(venueId: number, lm: TLimitlessMarket) {
  // This is kept for backward compatibility but not used in new implementation
  const id = uuid();
  const endTs =
    lm.expirationTimestamp != null ? Number(lm.expirationTimestamp) : NaN;
  const category = lm.categories?.[0] ?? null;

  return {
    id,
    venue_id: venueId,
    event_id: String(lm.id),
    title: lm.title,
    category,
    slug: null,
    active: !(lm.expired ?? false) && (lm.status ?? "ACTIVE") !== "RESOLVED",
    closed: (lm.expired ?? false) || (lm.status ?? "") === "RESOLVED",
    start_time: null,
    end_time: Number.isFinite(endTs) ? new Date(endTs) : null,
    liquidity: null,
    volume_total: parseVolume(
      lm.volume,
      lm.volumeFormatted,
      lm.collateralToken?.decimals,
    ),
    volume24hr: null,
    raw: lm,
  };
}

export function mapMarketRow(
  venueId: number,
  eventUuid: string,
  lm: TLimitlessMarket,
) {
  // This is kept for backward compatibility but not used in new implementation
  const id = uuid();
  const addr = (lm.conditionId ?? String(lm.id)).toLowerCase();
  const yesToken = `${addr}:YES`;
  const noToken = `${addr}:NO`;

  const yesP = lm.prices?.[0] != null ? Number(lm.prices[0]) / 100 : null;
  const noP = lm.prices?.[1] != null ? Number(lm.prices[1]) / 100 : null;

  return {
    id,
    event_id: eventUuid,
    venue_id: venueId,
    market_id: String(lm.id),
    title: lm.title,
    enable_orderbook: false,
    accepting_orders:
      (lm.status ?? "ACTIVE") === "FUNDED" ||
      (lm.status ?? "ACTIVE") === "ACTIVE",
    condition_id: lm.conditionId ?? null,
    order_price_min_tick_size: null,
    order_min_size: null,
    neg_risk: null,
    neg_risk_market_id: null,
    liquidity: null,
    volume_total: parseVolume(
      lm.volume,
      lm.volumeFormatted,
      lm.collateralToken?.decimals,
    ),
    volume24hr: null,
    clob_token_yes: yesToken,
    clob_token_no: noToken,
    raw: {
      ...lm,
      normalizedPrices: { yes: yesP, no: noP },
    },
  };
}

export function mapTokens(marketUuid: string, yes: string, no: string) {
  return [
    { token_id: yes, market_id: marketUuid, side: "YES" as const },
    { token_id: no, market_id: marketUuid, side: "NO" as const },
  ];
}

// Unified table mappers for Limitless
export function mapToUnifiedEvent(lm: TLimitlessMarket): UnifiedEventRow {
  // Map Limitless status to unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";
  if (isLimitlessResolved(lm)) status = "SETTLED";
  else if (lm.expired) status = "CLOSED";

  const volumeTotal =
    parseVolume(lm.volume, lm.volumeFormatted, lm.collateralToken?.decimals) ??
    undefined;
  const tradeType = lm.tradeType ?? "clob";
  const openInterest =
    parseMetric(
      lm.openInterest,
      lm.openInterestFormatted,
      lm.collateralToken?.decimals,
    ) ?? undefined;
  const liquidity =
    parseComparableLiquidity(
      tradeType,
      lm.liquidity,
      lm.liquidityFormatted,
      lm.collateralToken?.decimals,
    ) ?? undefined;
  const expirationDate = lm.expirationTimestamp
    ? new Date(Number(lm.expirationTimestamp))
    : undefined;
  const image = pickImage(lm);
  const icon = pickIcon(lm);
  const venueInfo = extractVenueInfo(lm);
  const groupId = resolveLimitlessGroupId(lm);
  const category = resolveLimitlessCategory({
    categories: lm.categories,
    tags: lm.tags,
    title: lm.title,
    description: lm.description,
  });
  const extra = lm as Record<string, unknown>;
  const durationMinutes = deriveLimitlessDurationMinutes({
    stableSlug: stringValue(extra.stableSlug),
    slug: lm.slug,
    title: lm.title,
  });

  return {
    id: `limitless:${lm.id}`,
    venue: "limitless",
    venue_event_id: String(lm.id),
    title: lm.title,
    description: lm.description,
    category,
    status,
    duration_minutes: durationMinutes ?? undefined,
    start_date: parseDate(lm.createdAt) || undefined,
    end_date: expirationDate,
    volume_total: volumeTotal,
    volume_24h: undefined, // Limitless doesn't provide 24h volume
    open_interest: openInterest,
    liquidity,
    metadata: {
      tradeType,
      marketType: lm.marketType,
      groupId,
      address: lm.address ?? undefined,
      negRiskRequestId: lm.negRiskRequestId ?? undefined,
      negRiskMarketId: lm.negRiskMarketId ?? undefined,
      venueExchange: venueInfo?.exchange,
      venueAdapter: venueInfo?.adapter,
    },
    slug: lm.slug || undefined,
    image,
    icon,
    created_at: parseDate(lm.createdAt) || undefined,
    updated_at: parseDate(lm.updatedAt) || undefined,
  };
}

export function mapToUnifiedMarket(
  market: TLimitlessMarketItem | TLimitlessMarket,
  eventId: string,
  event?: TLimitlessMarket,
): UnifiedMarketRow {
  // Map Limitless status to unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";
  if (isLimitlessResolved(market)) status = "SETTLED";
  else if (market.expired) status = "CLOSED";

  const volumeTotal = market.volumeFormatted
    ? parseFloat(market.volumeFormatted)
    : undefined;
  const tradeType = market.tradeType ?? "clob";
  const openInterest =
    parseMetric(
      market.openInterest,
      market.openInterestFormatted,
      market.collateralToken?.decimals,
    ) ?? undefined;
  const liquidity =
    parseComparableLiquidity(
      tradeType,
      market.liquidity,
      market.liquidityFormatted,
      market.collateralToken?.decimals,
    ) ?? undefined;
  const expirationDate = market.expirationTimestamp
    ? new Date(Number(market.expirationTimestamp))
    : undefined;

  const normalizedPrices = normalizePrices(
    [market.prices?.[0], market.prices?.[1]],
    tradeType,
  );
  const yesPrice = normalizedPrices[0];
  const lastPrice = yesPrice;
  const usePriceAsTop = tradeType.toLowerCase() === "amm" && yesPrice != null;
  const outcomeTokens = resolveOutcomeTokens(market);
  const resolvedOutcome = resolveLimitlessOutcome(market, outcomeTokens);
  const image = pickImage(market);
  const icon = pickIcon(market);
  const venueInfo = extractVenueInfo(market);
  const groupId =
    resolveLimitlessGroupId(market) ??
    (event && event.marketType === "group" ? String(event.id) : undefined);
  const category = resolveLimitlessCategory({
    categories: market.categories,
    tags: market.tags,
    title: market.title,
    description: market.description,
    fallbackCategories: event?.categories,
    fallbackTags: event?.tags,
    fallbackTitle: event?.title,
    fallbackDescription: event?.description,
  });
  const extra = market as Record<string, unknown>;
  const eventExtra = event as Record<string, unknown> | undefined;
  const durationMinutes =
    deriveLimitlessDurationMinutes({
      stableSlug: stringValue(extra.stableSlug),
      slug: market.slug,
      title: market.title,
    }) ??
    deriveLimitlessDurationMinutes({
      stableSlug: stringValue(eventExtra?.stableSlug),
      slug: event?.slug,
      title: event?.title,
    });

  return {
    id: `limitless:${market.id}`,
    venue: "limitless",
    venue_market_id: String(market.id),
    event_id: `limitless:${eventId}`,
    title: market.title,
    description: market.description,
    category,
    status,
    market_type: market.marketType === "group" ? "group" : "binary",
    duration_minutes: durationMinutes ?? undefined,
    open_time: parseDate(market.createdAt) || undefined,
    close_time: expirationDate,
    expiration_time: expirationDate,
    best_bid: usePriceAsTop ? yesPrice : undefined,
    best_ask: usePriceAsTop ? yesPrice : undefined,
    last_price: lastPrice,
    volume_total: volumeTotal,
    volume_24h: undefined, // Limitless doesn't provide 24h volume
    open_interest: openInterest,
    liquidity,
    metadata: {
      tradeType,
      marketType: market.marketType,
      groupId,
      address: market.address ?? undefined,
      negRiskRequestId: market.negRiskRequestId ?? undefined,
      negRiskMarketId:
        (market as { negRiskMarketId?: string | null }).negRiskMarketId ??
        undefined,
      venueExchange: venueInfo?.exchange,
      venueAdapter: venueInfo?.adapter,
    },
    outcomes: JSON.stringify(["YES", "NO"]), // Limitless markets are binary
    token_yes: prefixLimitlessToken(outcomeTokens.yes),
    token_no: prefixLimitlessToken(outcomeTokens.no),
    condition_id: market.conditionId ?? undefined,
    resolved_outcome: resolvedOutcome,
    slug: market.slug || undefined,
    image,
    icon,
    created_at: parseDate(market.createdAt) || undefined,
    updated_at: parseDate(market.updatedAt) || undefined,
  };
}
