import { getAddress } from "ethers";
import { isRecord } from "../lib/type-guards.js";

/** Shared by execution and observation; no API-wide configuration imports. */
export function readLimitlessAmmMarketAddress(
  metadata: unknown,
  legacyAddress?: unknown,
): string | null {
  const fields = isRecord(metadata) ? metadata : {};
  const selected = [
    fields.address,
    fields.marketAddress,
    fields.market_address,
    fields.ammAddress,
    fields.amm_address,
    legacyAddress,
  ].find((value) => typeof value === "string" && value.trim());
  if (typeof selected !== "string") return null;
  // Preserve execution's first-present alias priority, including invalid values:
  // a malformed authoritative address must not silently select another contract.
  try {
    return getAddress(selected.trim());
  } catch {
    return null;
  }
}
