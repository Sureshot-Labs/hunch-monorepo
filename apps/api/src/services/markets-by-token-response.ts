import { computeAcceptingOrders } from "../lib/market-availability.js";
import {
  parseMetadata,
  pickString,
  resolveEventDescription,
  resolveMarketDescription,
} from "../lib/metadata-description.js";
import { isRecord } from "../lib/type-guards.js";
import type { MarketByTokenRow } from "../repos/unified-read.js";

type LimitlessMeta = {
  negRiskRequestId?: string;
  negRiskMarketId?: string;
  venueAdapter?: string;
  venueExchange?: string;
  marketAddress?: string;
  tradeType?: string;
};

function pickFirstString(
  obj: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = pickString(obj, key);
    if (value) return value;
  }
  return undefined;
}

function pickVenueField(
  obj: Record<string, unknown> | null,
  key: string,
): string | undefined {
  if (!obj) return undefined;
  const venue = obj.venue;
  if (!isRecord(venue)) return undefined;
  const value = venue[key];
  return typeof value === "string" && value.trim().length ? value : undefined;
}

function extractLimitlessMeta(
  marketMeta: unknown,
  eventMeta: unknown,
): LimitlessMeta {
  const market = parseMetadata(marketMeta);
  const event = parseMetadata(eventMeta);
  const venueExchange =
    pickFirstString(market, [
      "venueExchange",
      "exchangeAddress",
      "exchange",
      "negRiskExchange",
    ]) ??
    pickVenueField(market, "exchange") ??
    pickVenueField(market, "exchangeAddress") ??
    pickFirstString(event, [
      "venueExchange",
      "exchangeAddress",
      "exchange",
      "negRiskExchange",
    ]) ??
    pickVenueField(event, "exchange") ??
    pickVenueField(event, "exchangeAddress");

  return {
    negRiskRequestId: pickString(market, "negRiskRequestId"),
    negRiskMarketId:
      pickString(market, "negRiskMarketId") ??
      pickString(event, "negRiskMarketId"),
    venueAdapter:
      pickString(market, "venueAdapter") ?? pickString(event, "venueAdapter"),
    venueExchange,
    marketAddress: pickString(market, "address"),
    tradeType: pickString(market, "tradeType"),
  };
}

export function mapMarketsByTokenRows(
  rows: MarketByTokenRow[],
  options: { now?: Date } = {},
) {
  const now = options.now ?? new Date();

  return rows.map((row) => {
    const marketMetadata = parseMetadata(row.market_metadata);
    const eventMetadata = parseMetadata(row.event_metadata);
    const limitlessMeta =
      row.venue === "limitless"
        ? extractLimitlessMeta(marketMetadata, eventMetadata)
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
      status: row.market_status,
      closeTime: row.close_time,
      expirationTime: row.expiration_time,
      pmAcceptingOrders: row.pm_accepting_orders,
      nowMs: now.getTime(),
    });
    const tradeType =
      row.venue === "limitless" ? (limitlessMeta?.tradeType ?? null) : null;
    const marketAddress =
      row.venue === "limitless" ? (limitlessMeta?.marketAddress ?? null) : null;

    return {
      tokenId: row.token_id,
      side:
        row.token_id === tokens.yes
          ? "YES"
          : row.token_id === tokens.no
            ? "NO"
            : row.side,
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
        tradeType,
        status: row.market_status,
        openTime: row.open_time,
        closeTime: row.close_time,
        expirationTime: row.expiration_time,
        volume24h: row.volume_24h != null ? Number(row.volume_24h) : 0,
        volumeTotal: row.volume_total != null ? Number(row.volume_total) : 0,
        openInterest: row.open_interest != null ? Number(row.open_interest) : 0,
        liquidity: row.liquidity != null ? Number(row.liquidity) : 0,
        bestBid:
          row.best_bid_yes != null
            ? Number(row.best_bid_yes)
            : row.best_bid != null
              ? Number(row.best_bid)
              : null,
        bestAsk:
          row.best_ask_yes != null
            ? Number(row.best_ask_yes)
            : row.best_ask != null
              ? Number(row.best_ask)
              : null,
        bestBidYes:
          row.best_bid_yes != null ? Number(row.best_bid_yes) : null,
        bestAskYes:
          row.best_ask_yes != null ? Number(row.best_ask_yes) : null,
        bestBidNo: row.best_bid_no != null ? Number(row.best_bid_no) : null,
        bestAskNo: row.best_ask_no != null ? Number(row.best_ask_no) : null,
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
        resolvedOutcome: row.resolved_outcome || null,
        resolvedOutcomePct:
          row.resolved_outcome_pct != null
            ? Number(row.resolved_outcome_pct)
            : null,
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
          category: row.event_category || null,
          status: row.event_status,
          startTime: row.start_date,
          endTime: row.end_date,
          eventLiquidity:
            row.event_liquidity != null ? Number(row.event_liquidity) : 0,
          eventVolume:
            row.event_volume_total != null
              ? Number(row.event_volume_total)
              : 0,
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
