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
  return input.retrySeconds;
}
