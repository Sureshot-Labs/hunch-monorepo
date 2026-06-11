import { env } from "../env.js";

function normalizeWallet(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

export function hasHyperliquidTradingAllowlist(): boolean {
  return (
    env.hyperliquidTradingAllowedUserIds.length > 0 ||
    env.hyperliquidTradingAllowedWallets.length > 0
  );
}

export function isHyperliquidTradingPubliclyEnabled(): boolean {
  return env.hyperliquidTradingEnabled && !hasHyperliquidTradingAllowlist();
}

export function isHyperliquidTradingAllowed(input: {
  userId?: string | null;
  walletAddress?: string | null;
}): boolean {
  if (!env.hyperliquidTradingEnabled) return false;
  if (!hasHyperliquidTradingAllowlist()) return true;

  const userId = normalizeId(input.userId);
  if (
    userId &&
    env.hyperliquidTradingAllowedUserIds.some(
      (allowed) => normalizeId(allowed) === userId,
    )
  ) {
    return true;
  }

  const walletAddress = normalizeWallet(input.walletAddress);
  if (
    walletAddress &&
    env.hyperliquidTradingAllowedWallets.some(
      (allowed) => normalizeWallet(allowed) === walletAddress,
    )
  ) {
    return true;
  }

  return false;
}

export function assertHyperliquidTradingAllowed(input: {
  userId?: string | null;
  walletAddress?: string | null;
}) {
  if (isHyperliquidTradingAllowed(input)) return;

  const error = new Error(
    env.hyperliquidTradingEnabled
      ? "Hyperliquid trading is not enabled for this account."
      : "Hyperliquid trading is disabled.",
  );
  (error as { code?: string }).code = env.hyperliquidTradingEnabled
    ? "hyperliquid_trading_not_allowed"
    : "hyperliquid_trading_disabled";
  throw error;
}
