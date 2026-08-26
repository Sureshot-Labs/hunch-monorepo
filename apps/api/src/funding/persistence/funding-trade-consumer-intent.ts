import type { AssetRef, Money } from "../domain/types.js";
import { canonicalAssetId, sameAsset } from "../domain/asset-identity.js";
import {
  isPositiveRawAmount,
  parsePositiveRawAmount,
} from "../domain/raw-amount.js";
import {
  assertVenueLocalMarketContextId,
  isCanonicalUnifiedMarketId,
} from "../domain/market-identity.js";
import { canonicalJsonHash } from "./canonical.js";

export type FundingTradeConsumerIntent = Readonly<{
  venueId: string;
  /** Canonical unified market ID in venue:venue_market_id form. */
  marketId: string;
  marketContextId: string;
  side: "BUY";
  spend: Money;
  fingerprint: string;
}>;

export type FundingTradeConsumerIntentInput = Omit<
  FundingTradeConsumerIntent,
  "fingerprint" | "side"
>;

function assertPositiveRaw(raw: string): void {
  if (!isPositiveRawAmount(raw)) {
    throw new Error("funding trade spend must be a positive raw-unit integer");
  }
}

function assertCanonicalMarketId(venueId: string, marketId: string): void {
  if (!isCanonicalUnifiedMarketId(venueId, marketId)) {
    throw new Error(
      "funding trade marketId must be a canonical unified market ID",
    );
  }
}

export function buildFundingTradeConsumerIntent(
  input: FundingTradeConsumerIntentInput,
): FundingTradeConsumerIntent {
  assertPositiveRaw(input.spend.raw);
  assertCanonicalMarketId(input.venueId, input.marketId);
  assertVenueLocalMarketContextId(input.venueId, input.marketContextId);
  const canonical = {
    venueId: input.venueId,
    marketId: input.marketId,
    marketContextId: input.marketContextId,
    side: "BUY" as const,
    spend: {
      asset: {
        ...input.spend.asset,
        assetId: canonicalAssetId(input.spend.asset),
      },
      raw: input.spend.raw,
    },
  };
  return {
    ...canonical,
    fingerprint: `funding_trade_intent_${canonicalJsonHash(canonical)}`,
  };
}

export function sameFundingTradeConsumerIntent(
  left: FundingTradeConsumerIntent,
  right: FundingTradeConsumerIntent,
): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.venueId === right.venueId &&
    left.marketId === right.marketId &&
    left.marketContextId === right.marketContextId &&
    left.side === right.side &&
    left.spend.raw === right.spend.raw &&
    sameAsset(left.spend.asset, right.spend.asset)
  );
}

/**
 * Compare a freshly normalized fee-inclusive Buy spend with the immutable
 * consumer scope that funded it. The fresh required spend may be lower than
 * the confirmed maximum, but every other identity field remains exact and
 * the confirmed spend cap may never be exceeded. Callers must not pass a
 * venue's nominal order amount when fees are charged separately.
 */
export function compareFundingTradeConsumerIntentToConfirmedBound(
  confirmed: FundingTradeConsumerIntent,
  actual: FundingTradeConsumerIntent,
): "matched" | "scope_mismatch" | "spend_exceeded" {
  if (
    confirmed.venueId !== actual.venueId ||
    confirmed.marketId !== actual.marketId ||
    confirmed.marketContextId !== actual.marketContextId ||
    confirmed.side !== actual.side ||
    !sameAsset(confirmed.spend.asset, actual.spend.asset)
  ) {
    return "scope_mismatch";
  }
  return BigInt(actual.spend.raw) <= BigInt(confirmed.spend.raw)
    ? "matched"
    : "spend_exceeded";
}

type StoredTradeFundingIntent = Readonly<{
  operationVenueId: string | null;
  operationMarketId: string | null;
  marketContextSnapshot: unknown;
  requestedDestinationAmount: unknown;
  reservationAsset: AssetRef;
  reservationRawAmount: string;
}>;

export type StoredFundingTradeConsumerIntentRow = Readonly<{
  venue_id: string | null;
  market_id: string | null;
  market_context_snapshot: unknown;
  requested_destination_amount: unknown;
  network_id: string;
  asset_id: string;
  asset_decimals: number;
  raw_amount: string;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readAsset(value: unknown): AssetRef | null {
  const record = readRecord(value);
  return record &&
    typeof record.networkId === "string" &&
    typeof record.assetId === "string" &&
    Number.isInteger(record.decimals) &&
    Number(record.decimals) >= 0 &&
    Number(record.decimals) <= 36
    ? {
        networkId: record.networkId,
        assetId: record.assetId,
        decimals: Number(record.decimals),
      }
    : null;
}

export function storedFundingTradeConsumerIntent(
  stored: StoredTradeFundingIntent,
): FundingTradeConsumerIntent | null {
  const context = readRecord(stored.marketContextSnapshot);
  const requestedFunding = readRecord(stored.requestedDestinationAmount);
  const requestedFundingAsset = readAsset(requestedFunding?.asset);
  const collateralAsset = readAsset(context?.collateralAsset);
  if (
    !context ||
    !requestedFunding ||
    !requestedFundingAsset ||
    !collateralAsset ||
    typeof context.marketContextId !== "string" ||
    typeof context.venueId !== "string" ||
    typeof context.marketId !== "string" ||
    !isPositiveRawAmount(context.requestedCollateralRaw) ||
    !isPositiveRawAmount(requestedFunding.raw) ||
    stored.operationVenueId !== context.venueId ||
    stored.operationMarketId !== context.marketId ||
    !sameAsset(collateralAsset, requestedFundingAsset) ||
    !sameAsset(collateralAsset, stored.reservationAsset) ||
    !isPositiveRawAmount(stored.reservationRawAmount)
  ) {
    return null;
  }
  const reservationRaw = parsePositiveRawAmount(stored.reservationRawAmount);
  const requestedFundingRaw = parsePositiveRawAmount(requestedFunding.raw);
  if (reservationRaw == null || requestedFundingRaw == null) return null;
  if (reservationRaw < requestedFundingRaw) return null;
  try {
    return buildFundingTradeConsumerIntent({
      venueId: context.venueId,
      marketId: context.marketId,
      marketContextId: context.marketContextId,
      spend: {
        asset: collateralAsset,
        raw: context.requestedCollateralRaw,
      },
    });
  } catch {
    return null;
  }
}

export function storedFundingTradeConsumerIntentFromRow(
  row: StoredFundingTradeConsumerIntentRow,
): FundingTradeConsumerIntent | null {
  return storedFundingTradeConsumerIntent({
    operationVenueId: row.venue_id,
    operationMarketId: row.market_id,
    marketContextSnapshot: row.market_context_snapshot,
    requestedDestinationAmount: row.requested_destination_amount,
    reservationAsset: {
      networkId: row.network_id,
      assetId: row.asset_id,
      decimals: row.asset_decimals,
    },
    reservationRawAmount: row.raw_amount,
  });
}
