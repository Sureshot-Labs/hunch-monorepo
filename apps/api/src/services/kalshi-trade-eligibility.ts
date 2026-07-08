import { isRecord } from "../lib/type-guards.js";
import type { KalshiTradeEligibility } from "./trading-types.js";

export type KalshiProofRequirement =
  | { decision: "bypassed" | "disabled" | "not_buy"; requiresProof: false }
  | { decision: "requires_proof" | "unknown_intent"; requiresProof: true };

export function normalizeKalshiTradeEligibility(
  value: unknown,
): KalshiTradeEligibility | null {
  if (!isRecord(value)) return null;
  const eligibility = isRecord(value.kalshiEligibility)
    ? value.kalshiEligibility
    : value;
  if (!isRecord(eligibility)) return null;
  return {
    checkedAt:
      typeof eligibility.checkedAt === "string" && eligibility.checkedAt.trim()
        ? eligibility.checkedAt
        : null,
    expiresAt:
      typeof eligibility.expiresAt === "string" && eligibility.expiresAt.trim()
        ? eligibility.expiresAt
        : null,
    geoAllowed:
      typeof eligibility.geoAllowed === "boolean"
        ? eligibility.geoAllowed
        : null,
    proofVerified:
      typeof eligibility.proofVerified === "boolean"
        ? eligibility.proofVerified
        : null,
  };
}

export function hasFreshKalshiTradeEligibility(
  eligibility: KalshiTradeEligibility | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!eligibility) return false;
  if (eligibility.geoAllowed !== true || eligibility.proofVerified !== true) {
    return false;
  }
  const expiresAt = eligibility.expiresAt
    ? Date.parse(eligibility.expiresAt)
    : NaN;
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

export function kalshiTradeEligibilityMessage(
  eligibility: KalshiTradeEligibility | null | undefined,
): string {
  if (eligibility?.geoAllowed === false) {
    return "Kalshi trading is not available in your region.";
  }
  if (eligibility?.proofVerified === false) {
    return "Kalshi bot trading requires verified Proof eligibility.";
  }
  return "Open Hunch to refresh Kalshi eligibility before bot trading.";
}

export function resolveKalshiProofRequirement(input: {
  hasDeterministicIntent: boolean;
  inputMint: string | null | undefined;
  proofBypassed: boolean;
  proofEnabled: boolean;
  usdcMint: string;
}): KalshiProofRequirement {
  if (!input.proofEnabled) return { decision: "disabled", requiresProof: false };
  if (input.proofBypassed) {
    return { decision: "bypassed", requiresProof: false };
  }
  if (!input.hasDeterministicIntent || !input.inputMint) {
    return { decision: "unknown_intent", requiresProof: true };
  }
  if (input.inputMint !== input.usdcMint) {
    return { decision: "not_buy", requiresProof: false };
  }
  return { decision: "requires_proof", requiresProof: true };
}
