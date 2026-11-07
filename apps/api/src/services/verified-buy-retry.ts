/** Give fresh provider settlement a few prompt observations; long finality,
 * provider failures and historical repairs retain the configured backoff. */
export function verifiedBuyRetrySeconds(input: {
  state: "pending" | "verified" | "revoked";
  reason: string | null;
  attempts: number;
  retrySeconds: number;
  verifiedRecheckSeconds: number;
}): number {
  if (input.state === "verified") return input.verifiedRecheckSeconds;
  const settling =
    input.reason === "provider_settlement_pending" ||
    input.reason === "fill_transaction_identity_missing";
  if (input.state === "pending" && settling && input.attempts <= 3)
    return Math.min(input.retrySeconds, 5);
  return input.retrySeconds;
}
