import assert from "node:assert/strict";

import type { FundingCommitPlan } from "../../persistence/funding-operation-repository.js";
import { isValidFundingCommitPlanBoundary } from "../../validation/funding-commit-plan-validator.js";

const fundStep = {
  ordinal: 0,
  segmentOrdinal: null,
  stepKind: "venue_preparation",
  state: "action_required",
  actionFingerprint: "fingerprint_router_fund_12345678",
  executorId: "wallet_profile_evm_v1",
  payerRequirement: "user",
  dependsOnOrdinal: null,
  normalizedAction: { kind: "evm_transaction" },
  actionValidationResult: {
    valid: true,
    validatorId: "polymarket_funding_router_v1",
  },
} as const;

function boundaryPlan(
  overrides: Partial<FundingCommitPlan["operation"]> = {},
  steps: FundingCommitPlan["steps"] = [fundStep],
): Pick<FundingCommitPlan, "operation" | "steps"> {
  return {
    operation: {
      planKind: "venue_preparation",
      venueId: "polymarket",
      supportMetadata: {
        preparationKind: "polymarket_funding_router",
        adapterId: "polymarket_funding_router_v1",
        planValidation: {
          validatorId: "polymarket_funding_router_v1",
          version: 1,
        },
      },
      ...overrides,
    } as FundingCommitPlan["operation"],
    steps,
  };
}

assert.equal(isValidFundingCommitPlanBoundary(boundaryPlan()), true);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({}, [
      {
        ...fundStep,
        actionValidationResult: {
          ...fundStep.actionValidationResult,
          valid: false,
        },
      },
    ]),
  ),
  false,
  "a declared single-step Router fund must still pass its exact validator",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({
      supportMetadata: {
        preparationKind: "polymarket_funding_router",
        adapterId: "polymarket_funding_router_v1",
        planValidation: {
          validatorId: "polymarket_funding_router_v1",
          version: 2,
        },
      },
    }),
  ),
  false,
  "an unknown validator version must fail closed",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({ supportMetadata: { test: true } }, [
      {
        ...fundStep,
        actionValidationResult: { valid: true },
      },
    ]),
  ),
  true,
  "a generic single venue-preparation step remains backward compatible",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({
      supportMetadata: {
        preparationKind: "polymarket_funding_router",
        adapterId: "polymarket_funding_router_v1",
      },
    }),
  ),
  false,
  "a known Router identity cannot omit its explicit validator declaration",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({ planKind: "direct_external_handoff" }),
  ),
  false,
  "a registered validator cannot be bypassed by relabeling the plan kind",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({ supportMetadata: { test: true } }, [
      {
        ...fundStep,
        ordinal: 0,
        stepKind: "transaction",
      },
      {
        ...fundStep,
        ordinal: 1,
        dependsOnOrdinal: 0,
      },
    ]),
  ),
  false,
  "a multi-action unbound chain cannot bypass the versioned boundary",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan(
      {
        planKind: "composite_route",
        supportMetadata: { preRouteHandoff: true },
      },
      [
        {
          ...fundStep,
          stepKind: "external_handoff",
          normalizedAction: {
            kind: "external_handoff",
            handoffKind: "polymarket_deposit_wallet_transfer",
          },
          actionValidationResult: {
            executionEnvelope: "polymarket_deposit_wallet_to_controller_v1",
          },
          executorId: "polymarket_deposit_wallet_relayer_v1",
          payerRequirement: "provider",
        },
        {
          ...fundStep,
          ordinal: 1,
          segmentOrdinal: 0,
          stepKind: "transaction",
          dependsOnOrdinal: 0,
          actionValidationResult: { valid: true },
        },
      ],
    ),
  ),
  true,
  "a legacy composite pre-route handoff remains on its existing SQL contract",
);

console.log(
  "[funding-commit-plan-validator-tests] explicit validator/version dispatch, single-step exact validation, generic compatibility, and multi-step fail-closed passed",
);
