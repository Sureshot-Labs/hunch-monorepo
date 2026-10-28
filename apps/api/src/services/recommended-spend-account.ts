import type { AccountValueReadModel } from "../account-value/runtime-service.js";
import type { AssetRef } from "../funding/domain/types.js";
import { canonicalAssetKey } from "../funding/domain/asset-identity.js";
import type { PreparationResult } from "../funding/domain/contracts.js";

/** Advisory-only: direct funded cash does not require controller top-up routes.
 * Never changes preparation/execution requirements of an actual trade. */
export function readyForDirectCollateral(
  preparation: PreparationResult,
  now: number,
): boolean {
  const expires = Date.parse(preparation.expiresAt);
  if (
    !Number.isFinite(expires) ||
    expires <= now ||
    !["internal_managed", "external_ready"].includes(preparation.readinessClass)
  )
    return false;
  const topUpOnly = new Set([
    "funding_router_ready",
    "funding_router_signer_pusd_allowance",
    "funding_router_signer_usdce_allowance",
  ]);
  const checks = preparation.evidence.checks.filter(
    (check) =>
      preparation.binding.venueId !== "polymarket" ||
      !topUpOnly.has(check.checkId),
  );
  return (
    checks.length > 0 && checks.every((check) => check.status === "satisfied")
  );
}

/** Exact economic component only. Never sum venue/account USD totals or wallets. */
export function selectedReadyCollateral(input: {
  account: AccountValueReadModel;
  address: string;
  asset: AssetRef;
  observedRaw: string;
  liveLockedRaw: bigint;
  allowanceRaw?: bigint;
  now: number;
}): { availableRaw: bigint; asOf: string } | null {
  const byId = new Map(
    input.account.projection.components.map((row) => [row.componentId, row]),
  );
  const matches = input.account.cashAvailability.components.filter((row) => {
    const component = byId.get(row.componentId);
    return (
      component?.category === "cash" &&
      component.valuationEligibility === "included" &&
      canonicalAssetKey(row.amount.asset) === canonicalAssetKey(input.asset) &&
      typeof component.location.details.address === "string" &&
      component.location.details.address.toLowerCase() ===
        input.address.toLowerCase()
    );
  });
  if (matches.length !== 1) return null; // absent inventory is not proof of a zero balance
  const row = matches[0];
  if (!row) return null;
  const observedAt = Date.parse(row.asOf);
  if (
    row.freshness !== "fresh" ||
    row.reasonCodes.includes("cash_availability_unknown") ||
    !Number.isFinite(observedAt) ||
    observedAt > input.now + 1_000 ||
    input.now - observedAt > 30_000
  )
    return null;
  let raw =
    BigInt(row.amount.raw) < BigInt(input.observedRaw)
      ? BigInt(row.amount.raw)
      : BigInt(input.observedRaw);
  if (input.allowanceRaw != null && input.allowanceRaw < raw)
    raw = input.allowanceRaw;
  const locked =
    BigInt(row.lockedRaw) > input.liveLockedRaw
      ? BigInt(row.lockedRaw)
      : input.liveLockedRaw;
  const deductions =
    locked + BigInt(row.reservedRaw) + BigInt(row.submittedDebitRaw);
  return {
    availableRaw: raw > deductions ? raw - deductions : 0n,
    asOf: row.asOf,
  };
}
