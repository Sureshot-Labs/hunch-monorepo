import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { POLYMARKET_FUNDING_SOURCE_ADAPTER_ID } from "../preparation/polymarket-funding-snapshot.js";
import {
  isPolymarketRouterV1CommitPlan,
  isPolymarketRouterV2CommitPlan,
} from "./polymarket-router-commit-plan-validator.js";

type CommitPlanValidator = (
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
) => boolean;

const VERSIONED_COMMIT_PLAN_VALIDATORS = new Map<
  string,
  ReadonlyMap<number, CommitPlanValidator>
>([
  [
    POLYMARKET_FUNDING_SOURCE_ADAPTER_ID,
    new Map([
      [1, isPolymarketRouterV1CommitPlan],
      [2, isPolymarketRouterV2CommitPlan],
    ]),
  ],
]);

function declaredCommitPlanValidator(
  plan: Pick<FundingCommitPlan, "operation">,
): Readonly<{ validatorId: string; version: number }> | null {
  const declaration = plan.operation.supportMetadata?.planValidation;
  if (
    !declaration ||
    typeof declaration !== "object" ||
    Array.isArray(declaration)
  ) {
    return null;
  }
  const record = declaration as Readonly<Record<string, unknown>>;
  if (
    typeof record.validatorId !== "string" ||
    !Number.isSafeInteger(record.version) ||
    Number(record.version) < 1
  ) {
    return null;
  }
  return {
    validatorId: record.validatorId,
    version: Number(record.version),
  };
}

/**
 * Multi-action, unbound preparation chains must opt into an exact versioned
 * validator before persistence. Simple single-step preparation remains on the
 * generic contract; provider-segment steps are validated by their bindings.
 */
export function isValidFundingCommitPlanBoundary(
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
): boolean {
  const unboundSteps = plan.steps.filter(
    (step) => step.segmentOrdinal === null,
  );
  const referencesRegisteredValidator =
    (typeof plan.operation.supportMetadata?.adapterId === "string" &&
      VERSIONED_COMMIT_PLAN_VALIDATORS.has(
        plan.operation.supportMetadata.adapterId,
      )) ||
    unboundSteps.some(
      (step) =>
        typeof step.actionValidationResult.validatorId === "string" &&
        VERSIONED_COMMIT_PLAN_VALIDATORS.has(
          step.actionValidationResult.validatorId,
        ),
    );
  const containsUnboundVenuePreparation = unboundSteps.some(
    (step) => step.stepKind === "venue_preparation",
  );
  const requiresVersionedValidation =
    referencesRegisteredValidator ||
    (plan.operation.planKind === "venue_preparation" &&
      (unboundSteps.length > 1 ||
        unboundSteps.some((step) => step.stepKind !== "venue_preparation"))) ||
    (plan.operation.planKind === "composite_route" &&
      containsUnboundVenuePreparation &&
      unboundSteps.length > 1);
  const declaration = declaredCommitPlanValidator(plan);
  if (!declaration) return !requiresVersionedValidation;
  return (
    VERSIONED_COMMIT_PLAN_VALIDATORS.get(declaration.validatorId)?.get(
      declaration.version,
    )?.(plan) === true
  );
}
