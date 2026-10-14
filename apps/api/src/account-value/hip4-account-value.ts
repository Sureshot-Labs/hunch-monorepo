import type { Pool } from "pg";
import { hip4RawUnits } from "@hunch/shared";
import type {
  AssetLocation,
  ValuedAssetComponent,
  ValuedPositionComponent,
} from "../funding/domain/types.js";
import type { Hip4AccountObservation } from "../schemas/hip4-account.js";
import {
  readHip4OwnedPortfolio,
  type Hip4OwnedPortfolioRead,
} from "../services/hip4-portfolio-positions.js";
import type { CollectorError } from "./account-value-projector.js";
import { canonicalLocationKey, stableOpaqueId } from "./canonical.js";
import { normalizeUnsignedDecimal } from "./decimal.js";

export type Hip4AccountValue = {
  assets: ValuedAssetComponent[];
  positions: ValuedPositionComponent[];
  errors: CollectorError[];
};

/** ownedCash proves unheld ownership, NOT the total or trading capacity.
 * Add held cash back only when the same snapshot proves the full equation.
 * Borrowing/margin capacity must never inflate the account's USD headline. */
function ownedTotal(observation: Hip4AccountObservation): string | null {
  const { cash, mode } = observation;
  if (cash.decimals !== 8 || !cash.assetId || cash.total.startsWith("-"))
    return null;
  if (
    observation.role === "missing" &&
    observation.balances.length === 0 &&
    observation.positions.length === 0 &&
    cash.total === "0" &&
    cash.held === "0"
  )
    return "0";
  if (
    !["disabled", "unifiedAccount"].includes(mode) ||
    cash.ownedCash == null ||
    cash.unheld == null ||
    (mode === "unifiedAccount" && cash.borrowed == null) ||
    (cash.borrowed != null && hip4RawUnits(cash.borrowed, 8) !== 0n)
  )
    return null;
  const total = hip4RawUnits(cash.total, 8);
  const held = hip4RawUnits(cash.held, 8);
  return total >= held &&
    total - held === hip4RawUnits(cash.ownedCash, 8) &&
    total - held === hip4RawUnits(cash.unheld, 8)
    ? normalizeUnsignedDecimal(cash.total)
    : null;
}

/** Pure projection of the same verified, scoped facts used by /positions.
 * These components are valuation-only: no execution binding or funding
 * source is manufactured from the existence of a native account balance. */
export function projectHip4AccountValue(input: {
  userId: string;
  read: Hip4OwnedPortfolioRead;
  now: number;
}): Hip4AccountValue {
  const result: Hip4AccountValue = { assets: [], positions: [], errors: [] };
  const { read } = input;
  // Testnet units are not USD assets. Keep them in the scoped venue reader.
  if (read.coverage.state === "disabled" || read.environment !== "mainnet")
    return result;
  const incomplete = (collectorId: string, code: string) => {
    if (!result.errors.some((error) => error.code === code))
      result.errors.push({ collectorId, code, retryable: false });
  };
  const accountsWithOwnedCash = new Set<string>();
  for (const { address, observation } of read.accounts) {
    if (!observation) {
      incomplete("hyperliquid-account-value", "account_snapshot_missing");
      incomplete("hyperliquid-position-value", "position_inventory_unknown");
      continue;
    }
    const observedTime = Date.parse(observation.observedAt);
    const fresh =
      observedTime <= input.now &&
      observedTime + read.snapshotMaxAgeMs > input.now;
    const value = ownedTotal(observation);
    if (value != null) accountsWithOwnedCash.add(address.toLowerCase());
    else incomplete("hyperliquid-account-value", "owned_cash_unverified");
    // Preserve unknowns rather than silently ignoring unsupported spot assets
    // or liabilities. HIP side balances below are valued as positions once.
    const positionCoins = new Set(
      observation.positions.map((position) => position.coin),
    );
    if (
      observation.unresolvedBalances.length ||
      observation.balances.some(
        (row) =>
          row.coin !== "USDC" &&
          !positionCoins.has(row.coin) &&
          !/^0(?:\.0+)?$/.test(row.total),
      )
    )
      incomplete("hyperliquid-account-value", "native_assets_unpriced");
    if (observation.unresolvedBalances.length)
      incomplete("hyperliquid-position-value", "position_inventory_unresolved");
    if (observation.cash.total.startsWith("-")) continue;
    const asset = {
      networkId: "hyperliquid:mainnet",
      assetId: observation.cash.assetId,
      decimals: observation.cash.decimals,
    };
    const location: AssetLocation = {
      kind: "venue_account",
      accountId: input.userId,
      locationId: stableOpaqueId(
        "location",
        `${input.userId}:hyperliquid:mainnet:${address.toLowerCase()}:${asset.assetId}`,
      ),
      asset,
      details: {
        venueId: "hyperliquid",
        accountRef: address.toLowerCase(),
        address: address.toLowerCase(),
        controllerWalletId: null,
        environment: "mainnet",
        symbol: "USDC",
        // Presentation facts from this same observation, never funding authority.
        ownedTotal: value,
        held: observation.cash.held,
        unheld: observation.cash.unheld,
        positionCount: observation.unresolvedBalances.length
          ? null
          : observation.positions.length,
        validUntil: new Date(
          observedTime + read.snapshotMaxAgeMs,
        ).toISOString(),
      },
    };
    result.assets.push({
      componentId: stableOpaqueId("asset", canonicalLocationKey(location)),
      location,
      amount: {
        asset,
        raw: hip4RawUnits(observation.cash.total, asset.decimals).toString(),
      },
      category: "cash",
      estimatedUsd:
        fresh && value != null
          ? {
              value,
              asOf: observation.observedAt,
              priceSource: "hyperliquid-owned-usdc",
              confidence: "high",
              policyId: "hyperliquid-owned-cash-v1",
            }
          : null,
      observedAt: observation.observedAt,
      observationFreshness: fresh ? "fresh" : "stale",
      observationError: null,
      valuationEligibility: !fresh
        ? "stale"
        : value == null
          ? "unpriced"
          : "included",
      executionEligibility: "ineligible",
      reasonCodes: !fresh
        ? ["balance_observation_stale"]
        : value == null
          ? ["asset_unpriced"]
          : [],
    });
  }
  for (const position of read.positions) {
    const owned = accountsWithOwnedCash.has(
      position.walletAddress.toLowerCase(),
    );
    const fresh = position.observation.state === "fresh";
    const valuationObservedAt = position.valuation.observedAt;
    const value =
      owned && valuationObservedAt != null
        ? position.valuation.marketValue
        : null;
    const identity = `${position.walletAddress.toLowerCase()}:${position.tokenId}`;
    result.positions.push({
      componentId: stableOpaqueId("position", identity),
      venueId: "hyperliquid",
      venueBindingId: stableOpaqueId(
        "binding",
        `${input.userId}:hyperliquid:mainnet:${position.walletAddress.toLowerCase()}`,
      ),
      positionRef: identity,
      positionActionRef: null,
      estimatedUsd:
        value == null || valuationObservedAt == null
          ? null
          : {
              value,
              asOf: valuationObservedAt,
              priceSource: `hyperliquid-${position.valuation.source}`,
              confidence:
                position.valuation.source === "official_payout"
                  ? "high"
                  : "medium",
              policyId: "hyperliquid-position-mark-v1",
            },
      valuationMethod: position.valuation.source ?? "unavailable",
      observedAt: position.lastUpdatedAt,
      observationFreshness: fresh ? "fresh" : "stale",
      observationError: null,
      valuationEligibility: !fresh
        ? "stale"
        : value == null
          ? "unpriced"
          : "included",
      reasonCodes: !fresh
        ? ["stale_projection"]
        : value == null
          ? ["asset_unpriced"]
          : [],
    });
  }
  return result;
}

export async function collectHip4AccountValue(input: {
  pool: Pick<Pool, "query">;
  userId: string;
  walletAddresses: readonly string[];
  now: Date;
}): Promise<Hip4AccountValue> {
  const read = await readHip4OwnedPortfolio(input.pool, {
    userId: input.userId,
    walletAddresses: input.walletAddresses,
    now: input.now.getTime(),
  });
  return projectHip4AccountValue({
    userId: input.userId,
    read,
    now: input.now.getTime(),
  });
}
