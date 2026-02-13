import { v4 as uuid } from "uuid";
import type { TLimitlessMarket, TLimitlessMarketItem } from "./types.js";
import type {
  LimitlessEventRow,
  LimitlessMarketRow,
} from "./limitless-repo.js";
import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";

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

function normalizePriceValue(
  value: number | undefined,
  tradeType?: string | null,
): number | undefined {
  if (value == null || Number.isNaN(value)) return undefined;
  const shouldScale =
    tradeType?.toLowerCase() === "amm" || (!tradeType && value > 1);
  return shouldScale ? value / 100 : value;
}

function normalizePrices(
  prices: Array<number | undefined>,
  tradeType?: string | null,
): Array<number | undefined> {
  return prices.map((value) => normalizePriceValue(value, tradeType));
}

function pickImage(input: {
  ogImageURI?: string | null;
  logo?: string | null;
  creator?: { imageURI?: string | null } | null;
}): string | undefined {
  return (
    input.ogImageURI ??
    input.logo ??
    input.creator?.imageURI ??
    undefined
  );
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
    typeof (market as { exchangeAddress?: unknown }).exchangeAddress === "string"
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
  if (market.status !== "RESOLVED") return undefined;
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
    winning_outcome_index: lm.winningOutcomeIndex || null,
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
    winning_outcome_index: market.winningOutcomeIndex || null,
    trade_type: market.tradeType ?? "clob",
    created_at: parseDate(market.createdAt),
    updated_at: parseDate(market.updatedAt),
    raw: market,
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
  if (lm.expired) status = "CLOSED";
  else if (lm.status === "RESOLVED") status = "SETTLED";

  const volumeTotal =
    parseVolume(lm.volume, lm.volumeFormatted, lm.collateralToken?.decimals) ??
    undefined;
  const openInterest =
    parseMetric(
      lm.openInterest,
      lm.openInterestFormatted,
      lm.collateralToken?.decimals,
    ) ?? undefined;
  const liquidity =
    parseMetric(
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

  return {
    id: `limitless:${lm.id}`,
    venue: "limitless",
    venue_event_id: String(lm.id),
    title: lm.title,
    description: lm.description,
    category: lm.categories?.[0], // First category
    status,
    start_date: parseDate(lm.createdAt) || undefined,
    end_date: expirationDate,
    volume_total: volumeTotal,
    volume_24h: undefined, // Limitless doesn't provide 24h volume
    open_interest: openInterest,
    liquidity,
    metadata: {
      tradeType: lm.tradeType ?? "clob",
      marketType: lm.marketType,
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
): UnifiedMarketRow {
  // Map Limitless status to unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";
  if (market.expired) status = "CLOSED";
  else if (market.status === "RESOLVED") status = "SETTLED";

  const volumeTotal = market.volumeFormatted
    ? parseFloat(market.volumeFormatted)
    : undefined;
  const openInterest =
    parseMetric(
      market.openInterest,
      market.openInterestFormatted,
      market.collateralToken?.decimals,
    ) ?? undefined;
  const liquidity =
    parseMetric(
      market.liquidity,
      market.liquidityFormatted,
      market.collateralToken?.decimals,
    ) ?? undefined;
  const expirationDate = market.expirationTimestamp
    ? new Date(Number(market.expirationTimestamp))
    : undefined;

  const tradeType = market.tradeType ?? "clob";
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

  return {
    id: `limitless:${market.id}`,
    venue: "limitless",
    venue_market_id: String(market.id),
    event_id: `limitless:${eventId}`,
    title: market.title,
    description: market.description,
    category: market.categories?.[0], // First category
    status,
    market_type: market.marketType === "group" ? "group" : "binary",
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
      address: market.address ?? undefined,
      negRiskRequestId: market.negRiskRequestId ?? undefined,
      negRiskMarketId: (market as { negRiskMarketId?: string | null })
        .negRiskMarketId ?? undefined,
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
