import { POLYMARKET_DEPOSIT_PUSD_FUND_PROFILE_ID } from "../execution/delegated-funding-profile-ids.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { POLYMARKET_FUNDING_SOURCE_ADAPTER_ID } from "../preparation/polymarket-funding-snapshot.js";

const CONTROLLER_ROUTER_APPROVAL_KINDS = new Set([
  "controller_pusd_router_approval",
  "controller_usdce_router_approval",
]);
const POLYMARKET_DEPOSIT_WALLET_HANDOFF_EXECUTOR_ID =
  "polymarket_deposit_wallet_relayer_v1";
const CLIENT_EVM_WALLET_EXECUTOR_ID = "wallet_profile_evm_v1";

/**
 * A Polymarket Router preparation is one linear action chain. Client execution
 * may first move one exact Deposit Wallet balance back to its controller, then
 * add either controller approval, before the single Router fund call. Server
 * execution may add only the reviewed controller approvals. Exact action
 * validators still bind every address, token and amount; this helper validates
 * only that the durable dependency topology cannot skip or reorder a leg.
 */
export function isPolymarketRouterPreparationStepChain(
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
): boolean {
  if (
    plan.operation.planKind !== "venue_preparation" ||
    plan.operation.venueId !== "polymarket" ||
    plan.operation.supportMetadata?.preparationKind !==
      "polymarket_funding_router" ||
    plan.operation.supportMetadata?.adapterId !==
      POLYMARKET_FUNDING_SOURCE_ADAPTER_ID
  ) {
    return false;
  }
  const steps = plan.steps;
  if (steps.length < 2 || steps.length > 4) return false;
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
    first.actionValidationResult.executionEnvelope ===
      "polymarket_deposit_wallet_to_controller_v1";
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
    fund.dependsOnOrdinal === fundOrdinal - 1 &&
    fund.normalizedAction.kind === "evm_transaction" &&
    fund.actionValidationResult.validatorId ===
      POLYMARKET_FUNDING_SOURCE_ADAPTER_ID
  );
}
