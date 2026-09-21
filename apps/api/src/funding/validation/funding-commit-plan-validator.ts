import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { POLYMARKET_FUNDING_SOURCE_ADAPTER_ID } from "../preparation/polymarket-funding-snapshot.js";
import {
  isPolymarketRouterV1CommitPlan,
  isPolymarketRouterV2CommitPlan,
  isPolymarketRouterV3CommitPlan,
  isPolymarketRouterV4CommitPlan,
  isPolymarketRouterV5CommitPlan,
  isPolymarketRouterV6CommitPlan,
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
      [3, isPolymarketRouterV3CommitPlan],
      [4, isPolymarketRouterV4CommitPlan],
      [5, isPolymarketRouterV5CommitPlan],
      [6, isPolymarketRouterV6CommitPlan],
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

/** A null segment means an action is not a provider quote action, not that
 * it belongs to the Router. Provider contributors can have their own wallet
 * handoff prefix. Keep those prefixes with their dependent provider steps. */
function versionedContributorPlan(
  plan: Pick<FundingCommitPlan, "operation" | "steps">,
): Pick<FundingCommitPlan, "operation" | "steps"> | null {
  if (plan.operation.planKind !== "composite_route") return plan;
  const preparation = plan.steps.filter(
    (step) => step.stepKind === "venue_preparation",
  );
  const legId = preparation[0]?.actionValidationResult.compositeSourceLegId;
  // Preserve the existing contract for historical, untagged plans.
  if (legId == null) return plan;
  if (
    typeof legId !== "string" ||
    !legId ||
    preparation.some(
      (step) => step.actionValidationResult.compositeSourceLegId !== legId,
    )
  )
    return null;
  const byOrdinal = new Map(plan.steps.map((step) => [step.ordinal, step]));
  if (byOrdinal.size !== plan.steps.length) return null;
  const providerLegs = new Map<number, string>();
  const providerSegments = new Map<string, number>();
  for (const step of plan.steps) {
    const metadata = step.actionValidationResult;
    const stepLeg = metadata.compositeSourceLegId;
    const segment = metadata.compositeSegmentOrdinal;
    if (typeof stepLeg !== "string" || !stepLeg) return null;
    if (step.dependsOnOrdinal != null) {
      const parent = byOrdinal.get(step.dependsOnOrdinal);
      if (
        !parent ||
        parent.ordinal >= step.ordinal ||
        parent.actionValidationResult.compositeSourceLegId !== stepLeg
      )
        return null;
    }
    if (stepLeg === legId) {
      if (step.segmentOrdinal !== null || segment !== null) return null;
      continue;
    }
    if (
      typeof segment !== "number" ||
      !Number.isSafeInteger(segment) ||
      segment < 0
    )
      return null;
    if (
      (providerLegs.has(segment) && providerLegs.get(segment) !== stepLeg) ||
      (providerSegments.has(stepLeg) &&
        providerSegments.get(stepLeg) !== segment)
    )
      return null;
    providerLegs.set(segment, stepLeg);
    providerSegments.set(stepLeg, segment);
    if (step.segmentOrdinal !== null) {
      if (step.segmentOrdinal !== segment) return null;
      continue;
    }
    if (step.stepKind !== "external_handoff") return null;
    // Do not discard an orphan handoff or relabel a Router action as a
    // provider prefix. It must actually lead to this contributor's segment.
    const linked = plan.steps.some((candidate) => {
      if (
        candidate.segmentOrdinal !== segment ||
        candidate.actionValidationResult.compositeSourceLegId !== stepLeg
      )
        return false;
      let parentOrdinal = candidate.dependsOnOrdinal;
      const visited = new Set<number>();
      while (parentOrdinal != null && !visited.has(parentOrdinal)) {
        if (parentOrdinal === step.ordinal) return true;
        visited.add(parentOrdinal);
        parentOrdinal = byOrdinal.get(parentOrdinal)?.dependsOnOrdinal ?? null;
      }
      return false;
    });
    if (!linked) return null;
  }
  return {
    ...plan,
    steps: plan.steps.filter(
      (step) => step.actionValidationResult.compositeSourceLegId === legId,
    ),
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
  const contributorPlan = versionedContributorPlan(plan);
  if (!contributorPlan) return false;
  return (
    VERSIONED_COMMIT_PLAN_VALIDATORS.get(declaration.validatorId)?.get(
      declaration.version,
    )?.(contributorPlan) === true
  );
}
