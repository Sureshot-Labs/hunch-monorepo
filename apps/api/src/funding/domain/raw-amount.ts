import type { RawAmount } from "./types.js";

/**
 * Raw token amounts are unsigned decimal integers in their asset's smallest
 * unit. Keep this representation check independent of planner errors: it is
 * also used by persistence and execution guards that must fail closed.
 */
export function isRawAmount(value: unknown): value is RawAmount {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value);
}

/** A raw amount used as a debit, floor, or allowance must be non-zero. */
export function isPositiveRawAmount(value: unknown): value is RawAmount {
  return typeof value === "string" && /^[1-9][0-9]*$/u.test(value);
}

/**
 * Parses an untrusted positive raw amount once for comparisons. Callers keep
 * the business relation explicit (for example, floor <= amount <= cap).
 */
export function parsePositiveRawAmount(value: unknown): bigint | null {
  return isPositiveRawAmount(value) ? BigInt(value) : null;
}
