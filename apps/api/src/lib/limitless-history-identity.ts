import { isRecord } from "./type-guards.js";

export function extractHistoryMarketSlug(
  entry: Record<string, unknown>,
): string | null {
  const market = isRecord(entry.market) ? entry.market : null;
  const value =
    market?.slug ??
    market?.marketSlug ??
    market?.market_slug ??
    entry.marketSlug ??
    entry.market_slug;
  return typeof value === "string" ? value.trim() || null : null;
}

export function normalizeHistorySide(
  strategy: string | null,
): "BUY" | "SELL" | null {
  const value = strategy?.trim().toLowerCase();
  if (!value) return null;
  if (value.includes("buy")) return "BUY";
  if (value.includes("sell")) return "SELL";
  return null;
}

const NON_ORDER_HISTORY_TYPES = new Set([
  "split",
  "merge",
  "convert",
  "conversion",
  "redeem",
  "redemption",
]);
export function isLimitlessNonOrderHistoryEntry(
  entry: Record<string, unknown>,
): boolean {
  return [entry.strategy, entry.type].some(
    (value) =>
      typeof value === "string" &&
      NON_ORDER_HISTORY_TYPES.has(value.trim().toLowerCase()),
  );
}
