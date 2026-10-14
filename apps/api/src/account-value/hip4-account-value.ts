import type { Pool } from "pg";
import { hip4RawUnits } from "@hunch/shared";
import type {
  AssetLocation,
  ValuedAssetComponent,
  ValuedPositionComponent,
  WalletExecutionProfile,
} from "../funding/domain/types.js";
import {
  HYPERCORE_FUNDING_NETWORKS,
  isHypercoreMainnetUsdc,
} from "../funding/domain/hypercore-identity.js";
import { hypercoreSpotCashCapacity } from "../funding/domain/hypercore-cash-capacity.js";
import type { CashAvailabilityAdjustment } from "./cash-availability-projector.js";
import type { Hip4AccountObservation } from "../schemas/hip4-account.js";
import {
  readHip4OwnedPortfolio,
  type Hip4OwnedPortfolioRead,
} from "../services/hip4-portfolio-positions.js";
import type { CollectorError } from "./account-value-projector.js";
import {
  canonicalLocationKey,
  stableOpaqueId,
  hypercoreSpotAccountLocation,
} from "./canonical.js";
import { normalizeUnsignedDecimal } from "./decimal.js";
import type { StableImpairmentState } from "./valuation-service.js";

export type Hip4AccountValue = {
  assets: ValuedAssetComponent[];
  positions: ValuedPositionComponent[];
  errors: CollectorError[];
  /** Hunch reservations/debits are merged by the common Account Value reader. */
  availability: Omit<
    CashAvailabilityAdjustment,
    "reservedRaw" | "submittedDebitRaw"
  >[];
};

/** ownedCash proves unheld ownership, NOT the total or trading capacity.
 * Add held cash back only when the same snapshot proves the full equation.
 * Borrowing/margin capacity must never inflate the account's USD headline. */
function ownedTotal(observation: Hip4AccountObservation): string | null {
  const { cash, mode } = observation;
  if (
    !isHypercoreMainnetUsdc({
      networkId: HYPERCORE_FUNDING_NETWORKS.mainnet,
      assetId: cash.assetId,
      decimals: cash.decimals,
    }) ||
    cash.total.startsWith("-")
  )
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
  wallets?: readonly WalletExecutionProfile[];
  stableState?: StableImpairmentState;
}): Hip4AccountValue {
  const result: Hip4AccountValue = {
    assets: [],
    positions: [],
    errors: [],
    availability: [],
  };
  const { read } = input;
  const impaired = input.stableState?.status === "impaired";
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
      networkId: HYPERCORE_FUNDING_NETWORKS.mainnet,
      assetId: observation.cash.assetId,
      decimals: observation.cash.decimals,
    };
    const profiles =
      input.wallets?.filter(
        (wallet) =>
          wallet.networkId === asset.networkId &&
          wallet.address.toLowerCase() === address.toLowerCase() &&
          wallet.controllerWalletRef &&
          (wallet.source === "external" || wallet.source === "embedded"),
      ) ?? [];
    const profile = profiles.length === 1 ? profiles[0] : null;
    const capacity = hypercoreSpotCashCapacity({
      observation,
      environment: read.environment,
      snapshotMaxAgeMs: read.snapshotMaxAgeMs,
      now: input.now,
    });
    const binding = hypercoreSpotAccountLocation({
      accountId: input.userId,
      address,
      controllerWalletId: profile?.walletId ?? null,
    });
    const location: AssetLocation = {
      ...binding.location,
      // Preserve a mismatched observed asset as unpriced, never relabel it USDC.
      asset,
      details: {
        ...binding.location.details,
        // One spot location across account modes. Never duplicate unified cash
        // into a second perps component. Existing P2 location identity is kept.
        nativeSourceDex: "spot",
        nativeAccountMode: observation.mode,
        cashCapacityReason: capacity.known ? null : capacity.reason,
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
    const componentId = stableOpaqueId("asset", canonicalLocationKey(location));
    result.availability.push({
      componentId,
      venueId: "hyperliquid",
      venueBindingId: binding.bindingId,
      lockedRaw: capacity.known ? capacity.lockedRaw : "0",
      availabilityKnown: capacity.known,
    });
    result.assets.push({
      componentId,
      location,
      amount: {
        asset,
        raw: hip4RawUnits(observation.cash.total, asset.decimals).toString(),
      },
      category: "cash",
      estimatedUsd:
        fresh && value != null && !impaired
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
        : value == null || impaired
          ? "unpriced"
          : "included",
      executionEligibility: "ineligible",
      reasonCodes: !fresh
        ? ["balance_observation_stale"]
        : input.stableState?.status === "impaired"
          ? ["stable_asset_impaired", input.stableState.reasonCode]
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
      owned && valuationObservedAt != null && !impaired
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
  wallets?: readonly WalletExecutionProfile[];
  stableState?: StableImpairmentState;
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
    wallets: input.wallets,
    stableState: input.stableState,
  });
}
