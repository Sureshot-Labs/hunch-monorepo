import type { FundingControlPlaneSnapshot } from "../policies/funding-policy-sidecar.js";
import type { PolymarketRouterExecutionConfiguration } from "./delegated-funding-config.js";
import { polymarketRouterProfileConfigured } from "./delegated-funding-config.js";

export type DelegatedFundingCapabilityDecision =
  | Readonly<{ kind: "allowed" }>
  | Readonly<{
      kind: "soft_paused";
      reasonCode:
        | "delegated_execution_paused"
        | "delegated_profile_unavailable"
        | "funding_policy_unavailable"
        | "funding_policy_paused"
        | "telegram_automation_disabled";
    }>
  | Readonly<{
      kind: "hard_invalid";
      diagnosticCode?:
        | "allowance_amount_mismatch"
        | "allowance_baseline_missing"
        | "allowance_observation_missing"
        | "allowance_owner_tx_mismatch"
        | "approval_dependency_missing"
        | "authority_missing"
        | "authority_operator_revoked"
        | "authority_runtime_mismatch"
        | "authority_snapshot_changed"
        | "prior_approval_proof_invalid"
        | "reservation_lane_missing";
      reasonCode:
        | "delegated_action_invalid"
        | "delegated_authority_invalid"
        | "delegated_quote_expired"
        | "delegated_route_changed"
        | "funding_policy_changed"
        | "funding_runtime_contract_changed";
    }>
  | Readonly<{ kind: "reconciliation_only" }>;

export type DelegatedFundingPreBroadcastDecision = Exclude<
  DelegatedFundingCapabilityDecision,
  Readonly<{ kind: "reconciliation_only" }>
>;

const ALLOWED = Object.freeze({ kind: "allowed" as const });

export function fundingPolicyRevisionMayResume(
  policy: FundingControlPlaneSnapshot,
): boolean {
  return (
    policy.invalidStoredPolicy ||
    policy.policy.paused ||
    policy.runtime.creationMode !== "on" ||
    !policy.runtime.gates.startUnsubmittedAction ||
    policy.runtime.gates.emergencyBroadcastPause
  );
}

/**
 * Classify only Hunch-owned control-plane state. Current user authority is a
 * separate DB decision because its rows must be locked at the broadcast
 * boundary.
 */
export function classifyPolymarketRouterControlPlane(input: {
  configuration: PolymarketRouterExecutionConfiguration;
  policy: FundingControlPlaneSnapshot;
}): DelegatedFundingPreBroadcastDecision {
  if (input.policy.invalidStoredPolicy) {
    return {
      kind: "soft_paused",
      reasonCode: "funding_policy_unavailable",
    };
  }
  if (input.policy.policy.paused) {
    return {
      kind: "soft_paused",
      reasonCode: "funding_policy_paused",
    };
  }
  if (
    !input.policy.policy.venues.includes("polymarket") ||
    !input.policy.policy.receive.assets.includes("polygon:pusd")
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_route_changed",
    };
  }
  if (!input.configuration.enabled) {
    return {
      kind: "soft_paused",
      reasonCode: "delegated_execution_paused",
    };
  }
  if (!polymarketRouterProfileConfigured(input.configuration)) {
    return {
      kind: "soft_paused",
      reasonCode: "delegated_profile_unavailable",
    };
  }
  if (
    input.policy.runtime.creationMode !== "on" ||
    !input.policy.runtime.gates.startUnsubmittedAction ||
    input.policy.runtime.gates.emergencyBroadcastPause
  ) {
    return {
      kind: "soft_paused",
      reasonCode: "funding_policy_paused",
    };
  }
  const venue = input.policy.runtime.venues.find(
    (candidate) => candidate.venueId === "polymarket",
  );
  if (
    !venue?.delegatedExecutionEnabled ||
    !venue.delegatedPolicyIds.includes(input.configuration.profileId)
  ) {
    return {
      kind: "hard_invalid",
      reasonCode: "delegated_route_changed",
    };
  }
  return ALLOWED;
}

export function combineDelegatedFundingDecisions(
  ...decisions: readonly DelegatedFundingPreBroadcastDecision[]
): DelegatedFundingPreBroadcastDecision {
  return (
    decisions.find((decision) => decision.kind === "hard_invalid") ??
    decisions.find((decision) => decision.kind === "soft_paused") ??
    ALLOWED
  );
}
