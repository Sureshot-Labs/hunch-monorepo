import { buildObservedCanonicalMarketTop } from "@hunch/shared";
import {
  type PolymarketOrderabilityMode,
  computeAcceptingOrders,
  readDflowNativeAcceptingOrders,
} from "../lib/market-availability.js";
import {
  parseMetadata,
  resolveEventDescription,
  resolveMarketDescription,
} from "../lib/metadata-description.js";
import { extractLimitlessMetadata } from "../lib/limitless-metadata.js";
import type { MarketByTokenRow } from "../repos/unified-read.js";
import { normalizeRedemptionStatus } from "./redemption-status.js";

export function mapMarketsByTokenRows(
  rows: MarketByTokenRow[],
  options: {
    now?: Date;
    polymarketOrderabilityMode?: PolymarketOrderabilityMode;
  } = {},
) {
  const now = options.now ?? new Date();

  return rows.map((row) => {
    const marketMetadata = parseMetadata(row.market_metadata);
    const eventMetadata = parseMetadata(row.event_metadata);
    const limitlessMeta =
      row.venue === "limitless"
        ? extractLimitlessMetadata(marketMetadata, eventMetadata)
        : null;
    const isLimitlessNegRisk = Boolean(
      limitlessMeta?.negRiskRequestId ||
      limitlessMeta?.negRiskMarketId ||
      limitlessMeta?.venueAdapter ||
      limitlessMeta?.venueExchange,
    );

    let tokens = {
      yes: null as string | null,
      no: null as string | null,
    };
    if (row.venue === "polymarket" && row.clob_token_ids) {
      try {
        const parsed = JSON.parse(String(row.clob_token_ids));
        if (Array.isArray(parsed)) {
          tokens = {
            yes: parsed[0] != null ? String(parsed[0]) : null,
            no: parsed[1] != null ? String(parsed[1]) : null,
          };
        }
      } catch {
        // keep tokens as null
      }
    } else if (row.venue === "limitless" || row.venue === "kalshi") {
      tokens = {
        yes: row.token_yes != null ? String(row.token_yes) : null,
        no: row.token_no != null ? String(row.token_no) : null,
      };
    }

    let outcomes: unknown = null;
    if (row.outcomes) {
      try {
        outcomes = JSON.parse(row.outcomes);
      } catch {
        // ignore parse errors
      }
    }

    const acceptingOrders = computeAcceptingOrders({
      venue: row.venue,
      status: row.market_status,
      closeTime: row.close_time,
      expirationTime: row.expiration_time,
      eventEndTime: row.end_date,
      pmAcceptingOrders: row.pm_accepting_orders,
      polymarketOrderabilityMode: options.polymarketOrderabilityMode,
      dflowNativeAcceptingOrders: readDflowNativeAcceptingOrders(
        row.market_metadata,
      ),
      nowMs: now.getTime(),
    });
    const tradeType =
      row.venue === "limitless" ? (limitlessMeta?.tradeType ?? null) : null;
    const marketAddress =
      row.venue === "limitless" ? (limitlessMeta?.marketAddress ?? null) : null;

    const outcomeSide =
      row.token_id === tokens.yes
        ? "YES"
        : row.token_id === tokens.no
          ? "NO"
          : row.side;
    const resolvedOutcomePct =
      row.resolved_outcome_pct != null
        ? Number(row.resolved_outcome_pct)
        : null;
    const observedTop = buildObservedCanonicalMarketTop({
      yesTop: {
        bestBid: row.best_bid_yes,
        bestAsk: row.best_ask_yes,
        ts: row.top_ts_yes as Date | string | number | null,
      },
      noTop: {
        bestBid: row.best_bid_no,
        bestAsk: row.best_ask_no,
        ts: row.top_ts_no as Date | string | number | null,
      },
    });

    return {
      tokenId: row.token_id,
      side: outcomeSide,
      market: {
        marketId: row.market_id,
        venue: row.venue,
        venueMarketId: row.venue_market_id,
        marketTitle: row.market_title,
        marketDescription: resolveMarketDescription(
          row.market_description,
          marketMetadata,
        ),
        marketMetadata,
        marketType: row.market_type,
        durationMinutes: row.market_duration_minutes ?? null,
        tradeType,
        status: row.market_status,
        openTime: row.open_time,
        closeTime: row.close_time,
        expirationTime: row.expiration_time,
        volume24h: row.volume_24h != null ? Number(row.volume_24h) : 0,
        volumeTotal: row.volume_total != null ? Number(row.volume_total) : 0,
        openInterest: row.open_interest != null ? Number(row.open_interest) : 0,
        liquidity: row.liquidity != null ? Number(row.liquidity) : 0,
        bestBid: observedTop.yesBid,
        bestAsk: observedTop.yesAsk,
        bestBidYes: observedTop.yesBid,
        bestAskYes: observedTop.yesAsk,
        bestBidNo: observedTop.noBid,
        bestAskNo: observedTop.noAsk,
        topAsOf: observedTop.topAsOf,
        lastPrice: row.last_price != null ? Number(row.last_price) : null,
        outcomes,
        tokens,
        conditionId: row.condition_id || null,
        questionId: row.pm_question_id || null,
        marketSlug: row.slug || null,
        marketImage: row.market_image || null,
        marketIcon: row.market_icon || null,
        marketAddress,
        redemptionStatus: row.redemption_status || null,
        redemption: normalizeRedemptionStatus({
          venue: row.venue,
          marketStatus: row.market_status,
          closeTime: row.close_time,
          expirationTime: row.expiration_time,
          eventEndTime: row.end_date,
          rawStatus: row.redemption_status,
          resolvedOutcome: row.resolved_outcome,
          resolvedOutcomePct,
          outcomeSide,
        }),
        resolvedOutcome: row.resolved_outcome || null,
        resolvedOutcomePct,
        acceptingOrders,
        negRisk:
          row.venue === "polymarket"
            ? row.pm_neg_risk != null
              ? Boolean(row.pm_neg_risk)
              : null
            : row.venue === "limitless"
              ? isLimitlessNegRisk
              : null,
        negRiskMarketId:
          row.venue === "limitless"
            ? (limitlessMeta?.negRiskMarketId ?? null)
            : row.pm_neg_risk_market_id || null,
        negRiskParentConditionId:
          row.venue === "polymarket"
            ? row.pm_neg_risk_parent_condition_id || null
            : null,
        negRiskRequestId:
          row.venue === "limitless"
            ? (limitlessMeta?.negRiskRequestId ?? null)
            : row.pm_neg_risk_request_id || null,
        negRiskAdapter:
          row.venue === "limitless"
            ? (limitlessMeta?.venueAdapter ?? null)
            : null,
        negRiskExchange:
          row.venue === "limitless"
            ? (limitlessMeta?.venueExchange ?? null)
            : null,
        event: {
          eventId: row.event_id,
          venue: row.event_venue,
          venueEventId: row.venue_event_id,
          eventTitle: row.event_title,
          eventDescription: resolveEventDescription(
            row.event_description,
            eventMetadata,
          ),
          eventMetadata,
          durationMinutes: row.event_duration_minutes ?? null,
          category: row.event_category || null,
          status: row.event_status,
          startTime: row.start_date,
          endTime: row.end_date,
          eventLiquidity:
            row.event_liquidity != null ? Number(row.event_liquidity) : 0,
          eventVolume:
            row.event_volume_total != null ? Number(row.event_volume_total) : 0,
          eventVolume24h:
            row.event_volume_24h != null ? Number(row.event_volume_24h) : 0,
          eventOpenInterest:
            row.event_open_interest != null
              ? Number(row.event_open_interest)
              : 0,
          eventSlug: row.event_slug || null,
          image: row.event_image || null,
          icon: row.event_icon || null,
          negRiskMarketId:
            row.venue === "limitless"
              ? (limitlessMeta?.negRiskMarketId ?? null)
              : null,
          negRiskAdapter:
            row.venue === "limitless"
              ? (limitlessMeta?.venueAdapter ?? null)
              : null,
        },
      },
    };
  });
}
