export type WalletSignalScope = "following" | "active" | "all";

export type SignalMarketWindowInput = {
  marketStatus?: string | null;
  resolvedOutcome?: string | null;
  closeTime?: Date | null;
  expirationTime?: Date | null;
};

export type SignalMarketWindowState = {
  marketStatus: string | null;
  closeAt: Date | null;
  hasValidCloseAt: boolean;
  isResolved: boolean;
  isOpenNow: boolean;
  isActiveWithInvalidClose: boolean;
};

export function mergeWalletIdsForScope(
  scope: WalletSignalScope,
  followingIds: string[],
  activeIds: string[],
): string[] {
  const merged = new Set<string>();
  if (scope === "following" || scope === "all") {
    for (const walletId of followingIds) merged.add(walletId);
  }
  if (scope === "active" || scope === "all") {
    for (const walletId of activeIds) merged.add(walletId);
  }
  return Array.from(merged);
}

export function evaluateSignalMarketWindow(
  input: SignalMarketWindowInput,
  nowMs = Date.now(),
): SignalMarketWindowState {
  const marketStatus = input.marketStatus?.trim().toUpperCase() ?? null;
  const closeAt = input.closeTime ?? input.expirationTime ?? null;
  const closeAtMs = closeAt?.getTime() ?? Number.NaN;
  const hasValidCloseAt = Number.isFinite(closeAtMs);
  const isResolved = Boolean(
    input.resolvedOutcome && String(input.resolvedOutcome).trim().length > 0,
  );
  const isOpenNow =
    marketStatus === "ACTIVE" && !isResolved && hasValidCloseAt && closeAtMs > nowMs;
  const isActiveWithInvalidClose =
    marketStatus === "ACTIVE" && (!hasValidCloseAt || closeAtMs <= nowMs);
  return {
    marketStatus,
    closeAt,
    hasValidCloseAt,
    isResolved,
    isOpenNow,
    isActiveWithInvalidClose,
  };
}
