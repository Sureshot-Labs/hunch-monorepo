import {
  buildObservedCanonicalMarketTop,
  parsePolymarketAssetContext,
  hip4ReadMarketSchema,
} from "@hunch/shared";
import { positionStorageContract } from "../lib/position-asset-context.js";
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
import {
  extractLimitlessMetadata,
  isLimitlessNegRiskMetadata,
} from "../lib/limitless-metadata.js";
import type { MarketByTokenRow } from "../repos/unified-read.js";
import { hip4CatalogProjection } from "./hip4-catalog-projection.js";
import { normalizeRedemptionStatus } from "./redemption-status.js";

export function mapMarketsByTokenRows(
  rows: MarketByTokenRow[],
  options: {
    now?: Date;
    polymarketOrderabilityMode?: PolymarketOrderabilityMode;
    includeTop?: boolean;
  } = {},
) {
  const now = options.now ?? new Date();

  return rows.map((row) => {
    const assetContext = parsePolymarketAssetContext(row.asset_context);
    if (
      row.asset_context != null &&
      (!assetContext ||
        assetContext.assetId !== row.token_id ||
        assetContext.marketId !== row.market_id)
    )
      throw new Error(
        "Position market metadata conflicts with its frozen context.",
      );
    const marketMetadata = parseMetadata(row.market_metadata);
    const eventMetadata = parseMetadata(row.event_metadata);
    const native =
      row.venue === "hyperliquid"
        ? hip4ReadMarketSchema.parse(marketMetadata?.hip4)
        : null;
    const metric = (value: unknown) =>
      value != null ? Number(value) : native ? null : 0;
    const limitlessMeta =
      row.venue === "limitless"
        ? extractLimitlessMetadata(marketMetadata, eventMetadata)
        : null;
    const isLimitlessNegRisk = isLimitlessNegRiskMetadata(limitlessMeta);

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
    } else if (row.venue === "limitless" || row.venue === "kalshi" || native) {
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

    const nativeOpen =
      native !== null &&
      native.status === "observed" &&
      native.settlement === null &&
      native.coverage.metadata === "fresh" &&
      Date.parse(native.fetchedAt) <= now.getTime() &&
      Date.parse(native.metadataValidUntil ?? "") > now.getTime() &&
      (native.expiry == null || Date.parse(native.expiry) > now.getTime());
    const nativeCatalog = native ? hip4CatalogProjection(native) : null;
    const acceptingOrders = native
      ? nativeOpen
      : computeAcceptingOrders({
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

    const outcomeSide = assetContext
      ? assetContext.outcomeIndex === 0
        ? "YES"
        : "NO"
      : row.token_id === tokens.yes
        ? "YES"
        : row.token_id === tokens.no
          ? "NO"
          : row.side;
    const resolvedOutcomePct =
      row.resolved_outcome_pct != null
        ? Number(row.resolved_outcome_pct)
        : null;
    const nativeTop = (index: number) => {
      const side = native?.sides.find((item) => item.sideIndex === index);
      return options.includeTop !== false &&
        nativeOpen &&
        side &&
        side.bookState === "fresh" &&
        Date.parse(side.bookAt ?? "") <= now.getTime() &&
        Date.parse(side.bookValidUntil ?? "") > now.getTime()
        ? {
            bid: side.bid == null ? null : Number(side.bid),
            ask: side.ask == null ? null : Number(side.ask),
            at: side.bookAt,
          }
        : { bid: null, ask: null, at: null };
    };
    const nativeYes = nativeTop(0),
      nativeNo = nativeTop(1);
    const observedTop = buildObservedCanonicalMarketTop(
      native
        ? {
            yesTop: {
              bestBid: nativeYes.bid,
              bestAsk: nativeYes.ask,
              ts: nativeYes.at,
            },
            noTop: {
              bestBid: nativeNo.bid,
              bestAsk: nativeNo.ask,
              ts: nativeNo.at,
            },
          }
        : {
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
          },
    );

    return {
      tokenId: row.token_id,
      ...(assetContext
        ? {
            assetContext,
            positionContract: positionStorageContract({
              venue: row.venue,
              tokenId: row.token_id,
              assetContext,
            }),
          }
        : {}),
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
        volume24h: native
          ? nativeCatalog?.volume24h != null &&
            native.volume24h &&
            Date.parse(native.volume24h.observedAt) <= now.getTime() &&
            Date.parse(native.volume24h.validUntil) > now.getTime()
            ? Number(nativeCatalog.volume24h)
            : null
          : metric(row.volume_24h),
        volumeTotal: metric(row.volume_total),
        openInterest: metric(row.open_interest),
        liquidity: metric(row.liquidity),
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
        ...(assetContext
          ? { priceTokens: { yes: row.token_yes, no: row.token_no } }
          : {}),
        conditionId: assetContext?.conditionId ?? row.condition_id ?? null,
        questionId: row.pm_question_id || null,
        marketSlug: row.slug || null,
        marketImage: row.market_image || null,
        marketIcon: row.market_icon || null,
        marketAddress,
        redemptionStatus: row.redemption_status || null,
        redemption: native
          ? {
              status:
                native.status === "settled"
                  ? ("resolved_not_redeemable" as const)
                  : native.status === "expired"
                    ? ("pending_resolution" as const)
                    : ("market_open" as const),
              reasonCode: "native_read_only_automatic_settlement",
              reason:
                "Native outcome settlement is observed separately; this read does not grant manual redemption.",
              redeemableAt: null,
              resolvedOutcome:
                row.resolved_outcome === "YES" || row.resolved_outcome === "NO"
                  ? row.resolved_outcome
                  : null,
              resolvedOutcomePct,
              rawStatus: row.redemption_status,
            }
          : normalizeRedemptionStatus({
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
          eventLiquidity: metric(row.event_liquidity),
          eventVolume: metric(row.event_volume_total),
          eventVolume24h: metric(row.event_volume_24h),
          eventOpenInterest: metric(row.event_open_interest),
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
