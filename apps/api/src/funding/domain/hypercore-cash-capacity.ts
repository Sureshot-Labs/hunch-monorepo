import { hip4RawUnits } from "@hunch/shared";
import type { Hip4AccountObservation } from "../../schemas/hip4-account.js";
import { isHypercoreMainnetUsdc } from "./hypercore-identity.js";

/** Provider cash capacity before Hunch reservations/debits. This is neither a
 * signing capability nor admission to submit. Only the native Standard spot
 * balance is supported here: unified collateral needs transferable-capacity
 * evidence, and a spot snapshot cannot stand in for a perps balance. */
export function hypercoreSpotCashCapacity(input: {
  observation: Hip4AccountObservation;
  environment: "mainnet" | "testnet";
  snapshotMaxAgeMs: number;
  now: number;
}):
  | { known: true; totalRaw: string; lockedRaw: string; availableRaw: string }
  | {
      known: false;
      reason:
        | "stale_snapshot"
        | "unsupported_cash_mode"
        | "invalid_cash_identity"
        | "unverified_cash";
    } {
  const { observation } = input;
  const observedAt = Date.parse(observation.observedAt);
  if (
    !Number.isFinite(input.now) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(input.snapshotMaxAgeMs) ||
    input.snapshotMaxAgeMs <= 0 ||
    observedAt > input.now ||
    observedAt + input.snapshotMaxAgeMs <= input.now
  )
    return { known: false, reason: "stale_snapshot" };
  const { cash } = observation;
  if (
    !isHypercoreMainnetUsdc({
      networkId: `hyperliquid:${input.environment}`,
      assetId: cash.assetId,
      decimals: cash.decimals,
    })
  )
    return { known: false, reason: "invalid_cash_identity" };
  if (observation.mode !== "disabled")
    return { known: false, reason: "unsupported_cash_mode" };
  try {
    const total = hip4RawUnits(cash.total, 8);
    const held = hip4RawUnits(cash.held, 8);
    if (
      observation.role !== "user" ||
      cash.unheld == null ||
      cash.ownedCash == null ||
      total < 0n ||
      held < 0n ||
      held > total ||
      (cash.borrowed != null && hip4RawUnits(cash.borrowed, 8) !== 0n) ||
      (cash.supplied != null && hip4RawUnits(cash.supplied, 8) !== 0n) ||
      total - held !== hip4RawUnits(cash.unheld, 8) ||
      total - held !== hip4RawUnits(cash.ownedCash, 8)
    )
      return { known: false, reason: "unverified_cash" };
    return {
      known: true,
      totalRaw: total.toString(),
      lockedRaw: held.toString(),
      availableRaw: (total - held).toString(),
    };
  } catch {
    return { known: false, reason: "unverified_cash" };
  }
}

/** Receive/BUY-funding readiness is not authority to spend. An exactly empty,
 * freshly observed missing/default account has known zero cash and can receive
 * its first deposit. Financial admission continues to require Standard mode. */
export function hypercoreRecipientCashCapacity(
  input: Parameters<typeof hypercoreSpotCashCapacity>[0],
) {
  const capacity = hypercoreSpotCashCapacity(input);
  if (capacity.known)
    return { ...capacity, topology: "native_standard_spot" as const };
  const { observation } = input;
  const { cash } = observation;
  if (
    capacity.reason === "unsupported_cash_mode" &&
    observation.role === "missing" &&
    observation.mode === "default" &&
    observation.balances.length === 0 &&
    observation.positions.length === 0 &&
    observation.unresolvedBalances.length === 0 &&
    cash.total === "0" &&
    cash.held === "0" &&
    cash.unheld === "0" &&
    cash.ownedCash == null &&
    cash.borrowed == null &&
    cash.supplied == null &&
    cash.availableAfterMaintenance == null
  )
    return {
      known: true as const,
      totalRaw: "0",
      lockedRaw: "0",
      availableRaw: "0",
      topology: "native_uninitialized_recipient" as const,
    };
  return capacity;
}
