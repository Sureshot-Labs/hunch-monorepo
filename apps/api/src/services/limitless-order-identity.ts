import { createHash } from "node:crypto";

/**
 * Stable provider identity for an exact Limitless CLOB submission.
 * Keep this pure so API request and background reconciliation paths cannot
 * drift or pull process-wide environment configuration into sidecars.
 */
export function deterministicLimitlessClientOrderId(
  idempotencyKey: string,
): string {
  return `hunch-${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 32)}`;
}

export function deterministicLimitlessDirectHandoffClientOrderId(
  handoffId: string,
): string {
  return `hunch-th2-${handoffId.trim().toLowerCase()}`;
}
