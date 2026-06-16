import { ethers } from "ethers";

export type LockedTokenStatus = {
  lockedRaw: string;
  locked: string;
  availableAfterLockedRaw: string;
  availableAfterLocked: string;
};

export function parseOptionalBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return BigInt(Math.trunc(value));
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

export function addLockedCollateralFields<T extends Record<string, unknown>>(
  tokenStatus: T,
  lockedRaw: bigint,
): T & LockedTokenStatus {
  const decimals =
    typeof tokenStatus.decimals === "number" ? tokenStatus.decimals : 6;
  const balanceRaw = parseOptionalBigInt(tokenStatus.balanceRaw) ?? 0n;
  const normalizedLockedRaw = lockedRaw > 0n ? lockedRaw : 0n;
  const availableAfterLockedRaw =
    balanceRaw > normalizedLockedRaw ? balanceRaw - normalizedLockedRaw : 0n;

  return {
    ...tokenStatus,
    lockedRaw: normalizedLockedRaw.toString(),
    locked: ethers.formatUnits(normalizedLockedRaw, decimals),
    availableAfterLockedRaw: availableAfterLockedRaw.toString(),
    availableAfterLocked: ethers.formatUnits(
      availableAfterLockedRaw,
      decimals,
    ),
  };
}
