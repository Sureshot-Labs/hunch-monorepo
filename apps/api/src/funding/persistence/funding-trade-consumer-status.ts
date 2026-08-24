export type PersistedTradeConsumerKind = "execution" | "web_order";
export type PersistedTradeTerminalOutcome = "failed" | "filled" | "no_fill";

/**
 * Normalises only conclusive local persistence states. A non-terminal value
 * deliberately returns null so venue reconciliation can continue instead of
 * guessing from a provider-specific intermediate label.
 */
export function persistedTradeTerminalOutcome(
  kind: PersistedTradeConsumerKind,
  status: string | null | undefined,
): PersistedTradeTerminalOutcome | null {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "filled" ||
    normalized === "matched" ||
    (kind === "execution" && normalized === "fulfilled")
  ) {
    return "filled";
  }
  if (
    normalized === "no_fill" ||
    normalized === "unmatched" ||
    normalized === "expired" ||
    normalized === "cancelled" ||
    normalized === "canceled"
  ) {
    return "no_fill";
  }
  return normalized === "failed" || normalized === "rejected" ? "failed" : null;
}
