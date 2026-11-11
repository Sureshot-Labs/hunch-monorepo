/** Fresh settlement gets prompt observations; canonical outcomes need only the
 * normal canonicality recheck. Explicit refresh always bypasses either delay. */
export function verifiedBuyRetrySeconds(input: {
  state: "pending" | "verified" | "revoked";
  reason: string | null;
  attempts: number;
  retrySeconds: number;
  verifiedRecheckSeconds: number;
}): number {
  if (
    input.state === "verified" ||
    input.reason === "finalized_receipt_failed" ||
    input.reason === "receipt_exact_fill_unavailable" ||
    input.reason === "amm_exact_fill_unavailable"
  )
    return input.verifiedRecheckSeconds;
  const settling =
    input.reason === "provider_settlement_pending" ||
    input.reason === "fill_transaction_identity_missing";
  if (input.state === "pending" && settling && input.attempts <= 3)
    return Math.min(input.retrySeconds, 5);
  if (
    input.state === "pending" &&
    (settling || input.reason === "provider_order_pending")
  )
    return Math.min(
      input.verifiedRecheckSeconds,
      input.retrySeconds *
        2 ** Math.min(12, Math.floor(Math.max(0, input.attempts - 4) / 4)),
    );
  // Cursor progress stays on normal cadence, not exponentially slowed by
  // old housekeeping attempts. Explicit refresh already fences/wakes due-now.
  return input.retrySeconds;
}
