import { Interface, ethers } from "ethers";

import type { RedemptionPlan } from "../../services/redemption-plan.js";
import type {
  FundingReasonCode,
  JsonObject,
  VenueAccountBinding,
} from "../domain/types.js";
import type {
  PreparationActionTemplate,
  PreparationFactCheck,
} from "../preparation/core-adapter.js";
import type { PositionActionFacts } from "../preparation/position-action-executor.js";
import { canonicalJsonHash } from "../persistence/canonical.js";

const ERC1155 = new Interface([
  "function setApprovalForAll(address operator,bool approved)",
]);

export type RedemptionRuntimeEvidence = Readonly<{
  conditionalTokensAddress: string;
  expiresAt: string;
  observedAt: string;
  operatorApproved: boolean | null;
  ownerBinding: VenueAccountBinding;
  ownerMatchesBinding: boolean;
  plan: RedemptionPlan;
  positionRef: string;
  topology: string;
  topologySupported: boolean;
  unsupportedTopologyReason: FundingReasonCode;
  externalHandoff: Readonly<{
    handoffKind: string;
    payload: JsonObject;
  }> | null;
  venueId: string;
  walletInternal: boolean;
}>;

export const REDEMPTION_POSITION_REQUIRED_CHECKS = [
  "position_owner",
  "topology_supported",
  "rpc_fresh",
  "condition_resolved",
  "redeemable_balance",
  "redemption_operator_approval",
  "canonical_redemption_plan",
] as const;

function satisfied(checkId: string, safeLabel: string): PreparationFactCheck {
  return {
    checkId,
    status: "satisfied",
    safeLabel,
    reasonCode: null,
    actions: [],
    postcondition: { kind: checkId, safeLabel },
  };
}

function unavailable(
  checkId: string,
  safeLabel: string,
  reasonCode: FundingReasonCode,
): PreparationFactCheck {
  return {
    checkId,
    status: "unavailable",
    safeLabel,
    reasonCode,
    actions: [],
    postcondition: null,
  };
}

function required(input: {
  action: PreparationActionTemplate;
  checkId: string;
  reasonCode: FundingReasonCode;
  safeLabel: string;
  userAction: boolean;
}): PreparationFactCheck {
  return {
    checkId: input.checkId,
    status: input.userAction ? "user_action_required" : "action_required",
    safeLabel: input.safeLabel,
    reasonCode: input.reasonCode,
    actions: [input.action],
    postcondition: {
      kind: input.checkId,
      safeLabel: input.safeLabel,
    },
  };
}

function directEvmAction(input: {
  actionKey: string;
  data: string;
  evidence: RedemptionRuntimeEvidence;
  safeLabel: string;
  target: string;
  valueMoving: boolean;
}): PreparationActionTemplate {
  return {
    actionKey: input.actionKey,
    action: {
      kind: "evm_transaction",
      networkId: input.evidence.ownerBinding.settlementLocation.asset.networkId,
      senderWalletId: input.evidence.ownerBinding.executionWalletId,
      to: ethers.getAddress(input.target),
      data: ethers.hexlify(input.data),
      valueRaw: "0",
      gasLimitRaw: null,
    },
    summary: {
      kind: "evm_transaction",
      safeLabel: input.safeLabel,
      actor: "user",
      valueMoving: input.valueMoving,
      sponsorship: input.evidence.walletInternal ? "requested" : "none",
    },
  };
}

function proxyAction(input: {
  actionKey: string;
  data: string;
  evidence: RedemptionRuntimeEvidence;
  safeLabel: string;
  target: string;
  valueMoving: boolean;
}): PreparationActionTemplate {
  const handoff = input.evidence.externalHandoff;
  if (!handoff) {
    throw new Error("external redemption handoff profile is missing");
  }
  return {
    actionKey: input.actionKey,
    action: {
      kind: "external_handoff",
      networkId: input.evidence.ownerBinding.settlementLocation.asset.networkId,
      actorWalletId: input.evidence.ownerBinding.executionWalletId,
      handoffKind: handoff.handoffKind,
      payload: {
        ...handoff.payload,
        calls: [
          {
            target: ethers.getAddress(input.target),
            data: ethers.hexlify(input.data),
            value: "0",
          },
        ],
      },
    },
    summary: {
      kind: "external_handoff",
      safeLabel: input.safeLabel,
      actor: "user",
      valueMoving: input.valueMoving,
      sponsorship: input.evidence.walletInternal ? "requested" : "none",
    },
  };
}

function executionAction(input: {
  actionKey: string;
  data: string;
  evidence: RedemptionRuntimeEvidence;
  safeLabel: string;
  target: string;
  valueMoving: boolean;
}): PreparationActionTemplate {
  return input.evidence.externalHandoff
    ? proxyAction(input)
    : directEvmAction(input);
}

function reasonForPlan(plan: RedemptionPlan): FundingReasonCode {
  if (plan.reason === "condition_unresolved") return "condition_unresolved";
  if (plan.reason === "preflight_unavailable") return "rpc_unavailable";
  return "market_evidence_unavailable";
}

function positivePlanBalance(plan: RedemptionPlan): boolean {
  const values = [plan.yesBalanceRaw, plan.noBalanceRaw];
  return values.some(
    (value) =>
      typeof value === "string" &&
      /^(0|[1-9][0-9]*)$/.test(value) &&
      BigInt(value) > 0n,
  );
}

function operatorCheck(
  evidence: RedemptionRuntimeEvidence,
): PreparationFactCheck {
  const operator = evidence.plan.operatorApprovalAddress ?? null;
  if (!operator) {
    return satisfied(
      "redemption_operator_approval",
      "No separate redemption operator approval is required",
    );
  }
  if (evidence.operatorApproved === true) {
    return satisfied(
      "redemption_operator_approval",
      "Canonical redemption operator is approved",
    );
  }
  if (evidence.operatorApproved == null) {
    return unavailable(
      "redemption_operator_approval",
      "Redemption operator approval could not be verified",
      "rpc_unavailable",
    );
  }
  const data = ERC1155.encodeFunctionData("setApprovalForAll", [
    operator,
    true,
  ]);
  return required({
    checkId: "redemption_operator_approval",
    safeLabel: "Approve the canonical redemption operator",
    reasonCode: "operator_approval_required",
    userAction: !evidence.walletInternal,
    action: executionAction({
      actionKey: "approve-redemption-operator",
      data,
      evidence,
      safeLabel: "Approve redemption operator",
      target: evidence.conditionalTokensAddress,
      valueMoving: false,
    }),
  });
}

function canonicalPlanCheck(
  evidence: RedemptionRuntimeEvidence,
): PreparationFactCheck {
  if (
    !evidence.plan.redeemable ||
    !evidence.plan.targetAddress ||
    !evidence.plan.data
  ) {
    return unavailable(
      "canonical_redemption_plan",
      evidence.plan.reasonMessage ?? "Canonical redemption plan is unavailable",
      reasonForPlan(evidence.plan),
    );
  }
  return required({
    checkId: "canonical_redemption_plan",
    safeLabel: "Submit the canonical owner-bound redemption",
    reasonCode: "position_action_required",
    userAction: !evidence.walletInternal,
    action: executionAction({
      actionKey: "redeem-position",
      data: evidence.plan.data,
      evidence,
      safeLabel: "Redeem resolved position",
      target: evidence.plan.targetAddress,
      valueMoving: true,
    }),
  });
}

export function buildRedemptionPositionFacts(
  evidence: RedemptionRuntimeEvidence,
): PositionActionFacts {
  const rpcFresh = evidence.plan.reason !== "preflight_unavailable";
  const checks: PreparationFactCheck[] = [
    evidence.ownerMatchesBinding
      ? satisfied("position_owner", "Position belongs to the exact binding")
      : unavailable(
          "position_owner",
          "Position belongs to another wallet binding",
          "position_owner_mismatch",
        ),
    evidence.topologySupported
      ? satisfied(
          "topology_supported",
          "Position owner topology supports redemption",
        )
      : unavailable(
          "topology_supported",
          "Position owner topology cannot execute redemption",
          evidence.unsupportedTopologyReason,
        ),
    rpcFresh
      ? satisfied("rpc_fresh", "Fresh redemption evidence is available")
      : unavailable(
          "rpc_fresh",
          "Fresh redemption evidence is unavailable",
          "rpc_unavailable",
        ),
    evidence.plan.conditionResolved === true
      ? satisfied("condition_resolved", "Position condition is resolved")
      : unavailable(
          "condition_resolved",
          "Position condition is not resolved",
          "condition_unresolved",
        ),
    positivePlanBalance(evidence.plan) || evidence.plan.redeemable
      ? satisfied("redeemable_balance", "Redeemable position balance exists")
      : unavailable(
          "redeemable_balance",
          "No redeemable owner balance is available",
          "market_evidence_unavailable",
        ),
    operatorCheck(evidence),
    canonicalPlanCheck(evidence),
  ];
  const planDigest = canonicalJsonHash(evidence.plan);
  return {
    action: "redeem",
    venueId: evidence.venueId,
    positionRef: evidence.positionRef,
    ownerBinding: evidence.ownerBinding,
    observedAt: evidence.observedAt,
    expiresAt: evidence.expiresAt,
    evidence: {
      ownerAddress: evidence.ownerBinding.accountRef,
      topology: evidence.topology,
      planDigest,
      conditionResolved: evidence.plan.conditionResolved,
      expectedPayoutRaw: evidence.plan.expectedPayoutRaw ?? null,
      yesBalanceRaw: evidence.plan.yesBalanceRaw ?? null,
      noBalanceRaw: evidence.plan.noBalanceRaw ?? null,
      operatorApprovalRequired: Boolean(evidence.plan.operatorApprovalAddress),
      operatorApproved: evidence.operatorApproved,
    },
    checks,
  };
}
