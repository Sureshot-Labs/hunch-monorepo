import { v4 as uuid } from "uuid";
import type {
  TEvent,
  TMarket,
  TPolymarketEvent,
  TPolymarketMarket,
} from "./types";
import type {
  UnifiedEventRow,
  UnifiedMarketRow,
} from "../../../packages/db/src/unified-repo";

const n = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const x = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(x as number) ? (x as number) : null;
};

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
    category: e.category ?? null,
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

export function mapPolymarketMarketRow(eventId: string, m: TPolymarketMarket) {
  return {
    id: m.id,
    event_id: eventId,
    question: m.question,
    condition_id: m.conditionId,
    slug: m.slug,
    resolution_source: m.resolutionSource,
    end_date: m.endDate ? new Date(m.endDate) : null,
    category: m.category ?? null,
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
// Category extraction function for Polymarket
function extractCategoryFromTitle(
  title: string,
  description?: string | null,
): string | undefined {
  const text = `${title} ${description || ""}`.toLowerCase();

  // Define category keywords
  const categories = {
    Politics: [
      "election",
      "president",
      "congress",
      "senate",
      "vote",
      "candidate",
      "political",
      "government",
      "policy",
      "democrat",
      "republican",
      "biden",
      "trump",
    ],
    Crypto: [
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
    ],
    Sports: [
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
      "super bowl",
    ],
    Economics: [
      "gdp",
      "inflation",
      "recession",
      "fed",
      "interest rate",
      "unemployment",
      "market",
      "economy",
      "financial",
    ],
    Technology: [
      "ai",
      "artificial intelligence",
      "tech",
      "apple",
      "google",
      "microsoft",
      "tesla",
      "meta",
      "amazon",
    ],
    Entertainment: [
      "movie",
      "film",
      "oscar",
      "netflix",
      "disney",
      "marvel",
      "star wars",
      "entertainment",
      "celebrity",
    ],
    Weather: [
      "hurricane",
      "tornado",
      "weather",
      "climate",
      "temperature",
      "rain",
      "snow",
      "storm",
    ],
    Health: [
      "covid",
      "pandemic",
      "vaccine",
      "health",
      "medical",
      "disease",
      "hospital",
    ],
  };

  // Find the category with the most keyword matches
  let bestCategory: string | undefined;
  let maxMatches = 0;

  for (const [category, keywords] of Object.entries(categories)) {
    const matches = keywords.filter((keyword) => text.includes(keyword)).length;
    if (matches > maxMatches) {
      maxMatches = matches;
      bestCategory = category;
    }
  }

  return maxMatches > 0 ? bestCategory : undefined;
}

export function mapToUnifiedEvent(e: TPolymarketEvent): UnifiedEventRow {
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
    category: e.category ?? extractCategoryFromTitle(e.title, e.description), // Use API category if available, else extract from title/description
    status,
    start_date: e.startDate ? new Date(e.startDate) : undefined,
    end_date: e.endDate ? new Date(e.endDate) : undefined,
    volume_total: n(e.volume) ?? undefined,
    volume_24h: n(e.volume24hr) ?? undefined,
    open_interest: n(e.openInterest) ?? undefined,
    liquidity: n(e.liquidity) ?? undefined,
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
): UnifiedMarketRow {
  // Map Polymarket status to unified status
  let status: "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED" = "ACTIVE";

  const endDate = m.endDate ? new Date(m.endDate) : null;
  const isExpired = endDate && endDate < new Date();

  if (m.archived) {
    status = "ARCHIVED";
  } else if (m.closed || (m.active && m.closed) || isExpired) {
    // Mark as CLOSED if:
    // 1. closed flag is true, OR
    // 2. both active=true and closed=true (contradictory state - treat as closed), OR
    // 3. endDate has passed (expired)
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

  return {
    id: `polymarket:${m.id}`,
    venue: "polymarket",
    venue_market_id: m.id,
    event_id: `polymarket:${eventId}`,
    title: m.question,
    description: m.description ?? undefined,
    category: m.category ?? extractCategoryFromTitle(m.question, m.description), // Use API category if available, else extract from question/description
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
    outcomes: m.outcomes ?? undefined, // Already JSON string
    clob_token_ids: clobTokenIds,
    condition_id: m.conditionId ?? undefined,
    slug: m.slug ?? undefined,
    image: m.image ?? undefined,
    icon: m.icon ?? undefined,
    created_at: m.createdAt ? new Date(m.createdAt) : undefined,
    updated_at: m.updatedAt ? new Date(m.updatedAt) : undefined,
  };
}
