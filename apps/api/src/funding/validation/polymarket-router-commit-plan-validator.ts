import { POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID } from "../execution/delegated-funding-profile-ids.js";
import { polymarketDepositWalletHandoffExpectation } from "../execution/polymarket-deposit-wallet-handoff.js";
import { sameAccountAddress } from "../domain/asset-identity.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { POLYMARKET_FUNDING_SOURCE_ADAPTER_ID } from "../preparation/polymarket-funding-snapshot.js";
import { RELAY_PINNED_ASSETS } from "../../funding-providers/relay/mappings.js";

const CONTROLLER_ROUTER_APPROVAL_KINDS = new Set([
  "controller_pusd_router_approval",
  "controller_usdce_router_approval",
]);
const POLYMARKET_DEPOSIT_WALLET_HANDOFF_EXECUTOR_ID =
  "polymarket_deposit_wallet_relayer_v1";
const CLIENT_EVM_WALLET_EXECUTOR_ID = "wallet_profile_evm_v1";

/**
 * Version 1 of the Polymarket Router commit contract. It owns the exact
 * executor, action, initial-state and dependency topology accepted at commit.
 * Later lifecycle changes are governed by the generic step transition rules.
 */
function isPolymarketRouterCommitPlanVersion(
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
  acceptsHandoff: (step: FundingCommitPlan["steps"][number]) => boolean,
  requiresHandoff = false,
): boolean {
  if (
    !["venue_preparation", "composite_route"].includes(
      plan.operation.planKind,
    ) ||
    plan.operation.venueId !== "polymarket" ||
    plan.operation.supportMetadata?.preparationKind !==
      "polymarket_funding_router" ||
    plan.operation.supportMetadata?.adapterId !==
      POLYMARKET_FUNDING_SOURCE_ADAPTER_ID
  ) {
    return false;
  }
  const steps =
    plan.operation.planKind === "composite_route"
      ? plan.steps.filter((step) => step.segmentOrdinal === null)
      : plan.steps;
  if (steps.length < 1 || steps.length > 4) return false;
  const first = steps[0];
  const hasPreRouteHandoff =
    first?.stepKind === "external_handoff" &&
    first.state === "action_required" &&
    first.segmentOrdinal === null &&
    first.executorId === POLYMARKET_DEPOSIT_WALLET_HANDOFF_EXECUTOR_ID &&
    first.dependsOnOrdinal === null &&
    first.normalizedAction.kind === "external_handoff" &&
    first.normalizedAction.handoffKind ===
      "polymarket_deposit_wallet_transfer" &&
    acceptsHandoff(first);
  if (requiresHandoff && !hasPreRouteHandoff) return false;
  const approvalStart = hasPreRouteHandoff ? 1 : 0;
  const approvals = steps.slice(approvalStart, -1);
  if (approvals.length > 2) return false;
  const fund = steps.at(-1);
  if (!fund) return false;
  const clientExecution = fund.executorId === CLIENT_EVM_WALLET_EXECUTOR_ID;
  const delegatedExecution =
    fund.executorId === POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID;
  if (
    (!clientExecution && !delegatedExecution) ||
    (hasPreRouteHandoff && !clientExecution)
  ) {
    return false;
  }
  const downstreamState = clientExecution ? "action_required" : "planned";
  const downstreamExecutorId = clientExecution
    ? CLIENT_EVM_WALLET_EXECUTOR_ID
    : POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID;
  const approvalKinds = new Set<string>();
  for (const [index, step] of approvals.entries()) {
    const ordinal = approvalStart + index;
    const kind = step.actionValidationResult.kind;
    if (
      step.ordinal !== ordinal ||
      step.stepKind !== "transaction" ||
      step.state !== downstreamState ||
      step.segmentOrdinal !== null ||
      step.executorId !== downstreamExecutorId ||
      step.dependsOnOrdinal !== (ordinal === 0 ? null : ordinal - 1) ||
      typeof kind !== "string" ||
      !CONTROLLER_ROUTER_APPROVAL_KINDS.has(kind) ||
      step.actionValidationResult.valid !== true ||
      step.actionValidationResult.validatorId !==
        POLYMARKET_FUNDING_SOURCE_ADAPTER_ID ||
      approvalKinds.has(kind)
    ) {
      return false;
    }
    approvalKinds.add(kind);
  }
  const fundOrdinal = steps.length - 1;
  return (
    fund.ordinal === fundOrdinal &&
    fund.stepKind === "venue_preparation" &&
    fund.state === downstreamState &&
    fund.segmentOrdinal === null &&
    fund.executorId === downstreamExecutorId &&
    fund.dependsOnOrdinal === (fundOrdinal === 0 ? null : fundOrdinal - 1) &&
    fund.normalizedAction.kind === "evm_transaction" &&
    fund.actionValidationResult.valid === true &&
    fund.actionValidationResult.validatorId ===
      POLYMARKET_FUNDING_SOURCE_ADAPTER_ID
  );
}

export function isPolymarketRouterV1CommitPlan(
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
): boolean {
  return isPolymarketRouterCommitPlanVersion(plan, (step) => {
    const action = normalizedActionSchema.safeParse(step.normalizedAction);
    const expectation = action.success
      ? polymarketDepositWalletHandoffExpectation(
          action.data as NormalizedAction,
          step.actionValidationResult,
        )
      : null;
    return (
      action.success &&
      action.data.kind === "external_handoff" &&
      action.data.payload.conversionKind !== "polymarket_usdce_to_pusd" &&
      expectation !== null &&
      [
        RELAY_PINNED_ASSETS.polygonPusd,
        RELAY_PINNED_ASSETS.polygonUsdce,
      ].includes(expectation.tokenAddress.toLowerCase()) &&
      typeof step.actionValidationResult.signerAddress === "string" &&
      sameAccountAddress(
        "evm:137",
        expectation.recipientAddress,
        step.actionValidationResult.signerAddress,
      )
    );
  });
}

export function isPolymarketRouterV2CommitPlan(
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
): boolean {
  return isPolymarketRouterCommitPlanVersion(
    plan,
    (step) => {
      const action = normalizedActionSchema.safeParse(step.normalizedAction);
      return (
        action.success &&
        action.data.kind === "external_handoff" &&
        action.data.payload.conversionKind === "polymarket_usdce_to_pusd" &&
        polymarketDepositWalletHandoffExpectation(
          action.data as NormalizedAction,
          step.actionValidationResult,
        ) !== null
      );
    },
    true,
  );
}

export function isPolymarketRouterCommitPlan(
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
): boolean {
  const declaration = plan.operation.supportMetadata?.planValidation;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  ) {
    return false;
  }
  const declarationRecord = declaration as Readonly<Record<string, JsonValue>>;
  if (declarationRecord.validatorId !== POLYMARKET_FUNDING_SOURCE_ADAPTER_ID) {
    return false;
  }
  return declarationRecord.version === 1
    ? isPolymarketRouterV1CommitPlan(plan)
    : declarationRecord.version === 2
      ? isPolymarketRouterV2CommitPlan(plan)
      : false;
}
