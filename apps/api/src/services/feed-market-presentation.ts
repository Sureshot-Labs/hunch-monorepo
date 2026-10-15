import { buildObservedCanonicalMarketTop } from "@hunch/shared";
import type { FeedEvent, TokenPair } from "../server-types.js";
import type { FeedMarketRow } from "../repos/unified-read.js";
import {
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import {
  applyFeedReadPresentation,
  type FeedReadContext,
} from "./feed-read-presentation.js";

// Shared presentation only: no query, cache, ranking or provider work.
export function buildFeedMarket(
  rRow: FeedMarketRow,
  context: FeedReadContext,
): FeedEvent["markets"][number] {
  const tokens: TokenPair = {
    yes: rRow.token_yes != null ? String(rRow.token_yes) : null,
    no: rRow.token_no != null ? String(rRow.token_no) : null,
  };

  let outcomes: unknown = null;
  if (rRow.outcomes) {
    try {
      outcomes = JSON.parse(rRow.outcomes);
    } catch {
      // ignore parse errors
    }
  }

  const negRiskExchange =
    rRow.venue === "limitless" ? (rRow.venue_exchange ?? null) : null;
  const negRiskAdapter =
    rRow.venue === "limitless" ? (rRow.venue_adapter ?? null) : null;
  const tradeType =
    rRow.venue === "limitless" ? (rRow.trade_type ?? null) : null;
  const marketAddress =
    rRow.venue === "limitless" ? (rRow.market_address ?? null) : null;

  const marketStatus =
    typeof rRow.market_status === "string" ? rRow.market_status : null;
  const acceptingOrders = computeAcceptingOrders({
    venue: rRow.venue,
    status: marketStatus,
    closeTime: rRow.market_close_time,
    expirationTime: rRow.market_expiration_time,
    eventEndTime: rRow.end_date,
    pmAcceptingOrders: rRow.pm_accepting_orders ?? null,
    dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(
      rRow.market_metadata,
    ),
  });
  const observedTop = buildObservedCanonicalMarketTop({
    yesTop: {
      bestBid: rRow.best_bid_yes,
      bestAsk: rRow.best_ask_yes,
      ts: rRow.top_ts_yes as Date | string | number | null,
    },
    noTop: {
      bestBid: rRow.best_bid_no,
      bestAsk: rRow.best_ask_no,
      ts: rRow.top_ts_no as Date | string | number | null,
    },
  });

  const market: FeedEvent["markets"][number] = {
    venue: String(rRow.venue),
    marketId: String(rRow.venue_market_id),
    marketTitle: rRow.market_title ?? "",
    marketSlug: rRow.market_slug ?? null,
    marketType: rRow.market_type ?? null,
    durationMinutes: rRow.market_duration_minutes ?? null,
    status: marketStatus,
    volume24h: rRow.volume_24h != null ? Number(rRow.volume_24h) : 0,
    volumeTotal: rRow.volume_total != null ? Number(rRow.volume_total) : 0,
    volumeDisplay:
      rRow.volume_display != null ? Number(rRow.volume_display) : 0,
    openInterest: rRow.open_interest != null ? Number(rRow.open_interest) : 0,
    liquidity: rRow.liquidity != null ? Number(rRow.liquidity) : 0,
    liquidityDisplay:
      rRow.liquidity_display != null ? Number(rRow.liquidity_display) : 0,
    acceptingOrders,
    tokens,
    outcomes,
    negRiskExchange,
    negRiskAdapter,
    tradeType,
    marketAddress,
    conditionId: (rRow.condition_id as string | null) || null,
    category: rRow.market_category ?? null,
    image: rRow.market_image ?? null,
    icon: rRow.market_icon ?? null,
    lastPrice: rRow.last_price != null ? Number(rRow.last_price) : null,
    resolvedOutcome: rRow.resolved_outcome ?? null,
    resolvedOutcomePct:
      rRow.resolved_outcome_pct != null
        ? Number(rRow.resolved_outcome_pct)
        : null,
    top: {
      yesBid: observedTop.yesBid,
      yesAsk: observedTop.yesAsk,
      noBid: observedTop.noBid,
      noAsk: observedTop.noAsk,
    },
    topAsOf: observedTop.topAsOf,
    change24h: rRow.change_24h != null ? Number(rRow.change_24h) : null,
    createdAt: rRow.market_created_at ?? null,
    startAt: rRow.market_open_time ?? null,
    lastUpdate: rRow.last_update,
  };
  return applyFeedReadPresentation(
    market,
    String(rRow.event_id),
    rRow.market_metadata,
    context,
  );
}
