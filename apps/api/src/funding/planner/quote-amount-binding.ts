import { parseMoneyJson } from "../domain/money-json.js";
import type { FundingQuoteAmountBinding } from "../domain/types.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { FundingPlannerError } from "./money.js";

/**
 * The quote endpoint validates client consent against the immutable commit
 * plan. Publish those exact amounts with each selectable source so clients do
 * not have to infer a shortfall from broader account or trade totals.
 */
export function fundingQuoteAmountBindingForCommitPlan(
  plan: FundingCommitPlan,
): FundingQuoteAmountBinding {
  const binding = {
    confirmedSourceAmount: parseMoneyJson(plan.operation.requestedSourceAmount),
    requestedDestinationAmount: parseMoneyJson(
      plan.operation.requestedDestinationAmount,
    ),
  };
  if (
    binding.confirmedSourceAmount === null &&
    binding.requestedDestinationAmount === null
  ) {
    throw new FundingPlannerError(
      "invalid_policy",
      "selectable funding source plan lacks an exact quote amount binding",
    );
  }
  return binding;
}
