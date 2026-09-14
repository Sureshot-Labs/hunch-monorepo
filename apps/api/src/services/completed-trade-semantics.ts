export const COMPLETED_ORDER_STATUSES = ["filled", "matched"] as const;

export const COMPLETED_EXECUTION_STATUSES = [
  "fulfilled",
  "filled",
  "closed",
] as const;

export function normalizeTradeAction(value: unknown): "BUY" | "SELL" | null {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (normalized === "BUY" || normalized === "SELL") return normalized;
  }
  if (typeof value === "number") {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }
  return null;
}
