import { SafeEvmReadError } from "./safe-evm-read.js";

export type RedemptionPlanReason =
  | "ready"
  | "condition_unresolved"
  | "no_redeemable_balance"
  | "missing_condition_id"
  | "missing_token_id"
  | "outcome_required"
  | "adapter_unavailable"
  | "preflight_unavailable";

export type RedemptionResolvedOutcome = "YES" | "NO" | null;

export type RedemptionPlan = {
  ok: true;
  venue: "polymarket" | "limitless";
  chainId: number;
  redeemable: boolean;
  reason: RedemptionPlanReason | null;
  reasonMessage: string | null;
  targetAddress: string | null;
  data: string | null;
  conditionResolved: boolean | null;
  resolvedOutcome: RedemptionResolvedOutcome;
  resolvedOutcomePct: number | null;
  diagnostics?: {
    functionName?: string | null;
    targetAddress?: string | null;
    readReason?: string | null;
  };
};

export function buildUnavailableRedemptionPlan(inputs: {
  venue: "polymarket" | "limitless";
  chainId: number;
  reason: Exclude<RedemptionPlanReason, "ready">;
  reasonMessage: string;
  conditionResolved?: boolean | null;
  resolvedOutcome?: RedemptionResolvedOutcome;
  resolvedOutcomePct?: number | null;
  diagnostics?: RedemptionPlan["diagnostics"];
}): RedemptionPlan {
  return {
    ok: true,
    venue: inputs.venue,
    chainId: inputs.chainId,
    redeemable: false,
    reason: inputs.reason,
    reasonMessage: inputs.reasonMessage,
    targetAddress: null,
    data: null,
    conditionResolved: inputs.conditionResolved ?? null,
    resolvedOutcome: inputs.resolvedOutcome ?? null,
    resolvedOutcomePct: inputs.resolvedOutcomePct ?? null,
    ...(inputs.diagnostics ? { diagnostics: inputs.diagnostics } : {}),
  };
}

export function buildReadyRedemptionPlan(inputs: {
  venue: "polymarket" | "limitless";
  chainId: number;
  targetAddress: string;
  data: string;
  conditionResolved?: boolean | null;
  resolvedOutcome?: RedemptionResolvedOutcome;
  resolvedOutcomePct?: number | null;
}): RedemptionPlan {
  return {
    ok: true,
    venue: inputs.venue,
    chainId: inputs.chainId,
    redeemable: true,
    reason: "ready",
    reasonMessage: null,
    targetAddress: inputs.targetAddress,
    data: inputs.data,
    conditionResolved: inputs.conditionResolved ?? null,
    resolvedOutcome: inputs.resolvedOutcome ?? null,
    resolvedOutcomePct: inputs.resolvedOutcomePct ?? null,
  };
}

export function buildPreflightFailurePlan(inputs: {
  venue: "polymarket" | "limitless";
  chainId: number;
  error: SafeEvmReadError;
}): RedemptionPlan {
  return buildUnavailableRedemptionPlan({
    venue: inputs.venue,
    chainId: inputs.chainId,
    reason: "preflight_unavailable",
    reasonMessage:
      inputs.error.reason === "no_code" ||
      inputs.error.reason === "empty_result" ||
      inputs.error.reason === "decode_failed"
        ? "Unable to read redemption state on-chain. Retry in a moment."
        : "Unable to prepare redemption on-chain. Retry in a moment.",
    diagnostics: {
      functionName: inputs.error.functionName,
      targetAddress: inputs.error.targetAddress,
      readReason: inputs.error.reason,
    },
  });
}
