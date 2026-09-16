import assert from "node:assert/strict";
import { Interface } from "ethers";

import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import { buildPolymarketPreRouteHandoffSteps } from "../../../funding-providers/relay/operation-plan.js";
import { POLYMARKET_COLLATERAL_ONRAMP } from "../../../funding-providers/relay/rehearsal.js";
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

// MAR38: an owned USDC.e preparation contributor nested inside a composite.
{
  const source = "0x1111111111111111111111111111111111111111";
  const destination = "0x2222222222222222222222222222222222222222";
  const profiles = [source, destination].map((address, index) => ({
    walletId: `wallet_mar38_${index}`,
    address,
    networkId: "evm:137",
    source: "embedded",
    signingModes: ["web_client", "privy_authorization"],
  }));
  const [sourceProfile, destinationProfile] = profiles;
  assert.ok(sourceProfile && destinationProfile);
  const plan = {
    operation: { ...boundaryPlan().operation },
    steps: [] as FundingCommitPlan["steps"],
  };
  plan.operation.planKind = "composite_route";
  plan.operation.supportMetadata = {
    ...plan.operation.supportMetadata,
    planValidation: { validatorId: "polymarket_funding_router_v1", version: 6 },
    ownedWalletTransfers: [
      { walletId: sourceProfile.walletId, address: source, raw: "1508172" },
    ],
    fundingPlan: { signerUsdceAmountRaw: "1508172" },
  };
  plan.operation.walletExecutionSnapshot = { profiles: [{ profiles }] };
  const transfer = {
    ...fundStep,
    stepKind: "transaction" as const,
    normalizedAction: {
      kind: "evm_transaction",
      actionId: "mar38_transfer_action",
      networkId: "evm:137",
      senderWalletId: sourceProfile.walletId,
      to: RELAY_PINNED_ASSETS.polygonUsdce,
      valueRaw: "0",
      gasLimitRaw: null,
      data: new Interface([
        "function transfer(address,uint256)",
      ]).encodeFunctionData("transfer", [destination, "1508172"]),
    },
    actionValidationResult: {
      ...fundStep.actionValidationResult,
      kind: "owned_wallet_controller_transfer",
      signerAddress: source,
      expectedDestinationAddress: destination,
      expectedDestinationAssetId: RELAY_PINNED_ASSETS.polygonUsdce,
      expectedDestinationRaw: "1508172",
      postconditionEvidenceKind: "exact_erc20_destination_credit_v1",
    },
  };
  plan.steps = [
    transfer,
    {
      ...fundStep,
      ordinal: 1,
      dependsOnOrdinal: 0,
      normalizedAction: {
        ...transfer.normalizedAction,
        senderWalletId: destinationProfile.walletId,
      },
      actionValidationResult: {
        ...fundStep.actionValidationResult,
        signerAddress: destination,
      },
    },
  ];
  assert.equal(
    isValidFundingCommitPlanBoundary(plan),
    true,
    "nested composite profiles",
  );
  plan.operation.walletExecutionSnapshot = { profiles };
  assert.equal(
    isValidFundingCommitPlanBoundary(plan),
    true,
    "flat legacy profiles",
  );
  for (const change of [
    { address: destination },
    { source: "external" },
    { networkId: "evm:8453" },
    { signingModes: [] },
  ]) {
    plan.operation.walletExecutionSnapshot = {
      profiles: [
        { profiles: [{ ...sourceProfile, ...change }, destinationProfile] },
      ],
    };
    assert.equal(
      isValidFundingCommitPlanBoundary(plan),
      false,
      JSON.stringify(change),
    );
  }
  plan.operation.walletExecutionSnapshot = { profiles: [{ profiles }, null] };
  assert.equal(
    isValidFundingCommitPlanBoundary(plan),
    false,
    "malformed leaves are not discarded",
  );
  plan.operation.walletExecutionSnapshot = { profiles: [{ profiles }] };
  const routerStep = plan.steps[1];
  assert.ok(routerStep);
  for (const change of [
    { expectedDestinationRaw: "1508173" },
    { expectedDestinationAddress: source },
  ]) {
    plan.steps = [
      {
        ...transfer,
        actionValidationResult: {
          ...transfer.actionValidationResult,
          ...change,
        },
      },
      routerStep,
    ];
    assert.equal(
      isValidFundingCommitPlanBoundary(plan),
      false,
      "exact transfer guards remain enforced",
    );
  }
}
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({ planKind: "composite_route" }, [
      { ...fundStep, ordinal: 2 },
    ]),
  ),
  true,
  "independent preparation after a Relay contributor uses global ordinals",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({ planKind: "composite_route" }, [
      { ...fundStep, ordinal: 2, dependsOnOrdinal: 1 },
    ]),
  ),
  false,
  "renumbering must not erase an unknown contributor dependency",
);
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
          version: 3,
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

const directUsdceSteps = buildPolymarketPreRouteHandoffSteps({
  source: {
    preRouteHandoff: {
      kind: "polymarket_deposit_wallet_to_controller_v1",
      sourceLocation: {
        kind: "venue_account",
        locationId: "location_conversion_source_12345678",
        accountId: "account_conversion_12345678",
        asset: {
          networkId: "evm:137",
          assetId: RELAY_PINNED_ASSETS.polygonUsdce,
          decimals: 6,
        },
        details: {},
      },
      funderAddress: "0x00000000000000000000000000000000000000a2",
      controllerAddress: "0x00000000000000000000000000000000000000a1",
      tokenAddress: RELAY_PINNED_ASSETS.polygonUsdce,
    },
  },
  sourceAmount: {
    asset: {
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonUsdce,
      decimals: 6,
    },
    raw: "1000000",
  },
  profile: {
    walletId: "wallet_conversion_12345678",
    controllerWalletRef: "privy_conversion_12345678",
    networkId: "evm:137",
    address: "0x00000000000000000000000000000000000000a1",
    source: "embedded",
    signingModes: ["web_client"],
    serverWalletRef: "privy_conversion_12345678",
    sponsorshipPolicyIds: [],
  },
  steps: [fundStep],
});
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan(
      {
        supportMetadata: {
          preparationKind: "polymarket_funding_router",
          adapterId: "polymarket_funding_router_v1",
          planValidation: {
            validatorId: "polymarket_funding_router_v1",
            version: 1,
          },
        },
      },
      directUsdceSteps,
    ),
  ),
  true,
  "v1 accepts one exact USDC.e Deposit Wallet handoff before Router funding",
);

// Version 2 remains a validation boundary for already-persisted conversion
// operations. New planners do not emit this three-call action anymore.
const directHandoffStep = directUsdceSteps[0];
assert.ok(directHandoffStep);
const conversionInterface = new Interface([
  "function approve(address spender,uint256 amount)",
  "function wrap(address asset,address recipient,uint256 amount)",
  "function transfer(address recipient,uint256 amount)",
]);
const conversionAmountRaw = 1_000_000n;
const conversionFunder = "0x00000000000000000000000000000000000000a2";
const conversionController = "0x00000000000000000000000000000000000000a1";
const conversionTransferData = conversionInterface.encodeFunctionData(
  "transfer",
  [conversionController, conversionAmountRaw],
);
const conversionSteps: FundingCommitPlan["steps"] = [
  {
    ...directHandoffStep,
    normalizedAction: {
      ...directHandoffStep.normalizedAction,
      payload: {
        topology: "deposit_wallet",
        funder: conversionFunder,
        recipient: conversionController,
        token: RELAY_PINNED_ASSETS.polygonPusd,
        sourceToken: RELAY_PINNED_ASSETS.polygonUsdce,
        amountRaw: conversionAmountRaw.toString(),
        conversionKind: "polymarket_usdce_to_pusd",
        calls: [
          {
            target: RELAY_PINNED_ASSETS.polygonUsdce,
            value: "0",
            data: conversionInterface.encodeFunctionData("approve", [
              POLYMARKET_COLLATERAL_ONRAMP,
              conversionAmountRaw,
            ]),
          },
          {
            target: POLYMARKET_COLLATERAL_ONRAMP,
            value: "0",
            data: conversionInterface.encodeFunctionData("wrap", [
              RELAY_PINNED_ASSETS.polygonUsdce,
              conversionFunder,
              conversionAmountRaw,
            ]),
          },
          {
            target: RELAY_PINNED_ASSETS.polygonPusd,
            value: "0",
            data: conversionTransferData,
          },
        ],
      },
    },
    actionValidationResult: {
      ...directHandoffStep.actionValidationResult,
      tokenAddress: RELAY_PINNED_ASSETS.polygonPusd,
      transferData: conversionTransferData,
      conversionKind: "polymarket_usdce_to_pusd",
      sourceTokenAddress: RELAY_PINNED_ASSETS.polygonUsdce,
      collateralOnrampAddress: POLYMARKET_COLLATERAL_ONRAMP,
    },
  },
  ...directUsdceSteps.slice(1),
];
const conversionSupportMetadata = {
  preparationKind: "polymarket_funding_router",
  adapterId: "polymarket_funding_router_v1",
  planValidation: {
    validatorId: "polymarket_funding_router_v1",
    version: 2,
  },
} as const;
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan({ supportMetadata: conversionSupportMetadata }),
  ),
  false,
  "v2 cannot be declared without the exact conversion handoff",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan(
      { supportMetadata: conversionSupportMetadata },
      conversionSteps,
    ),
  ),
  true,
  "v2 accepts the exact three-call Deposit Wallet conversion before Router funding",
);
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan(
      {
        supportMetadata: {
          ...conversionSupportMetadata,
          planValidation: {
            ...conversionSupportMetadata.planValidation,
            version: 1,
          },
        },
      },
      conversionSteps,
    ),
  ),
  false,
  "v1 does not silently inherit the new conversion call surface",
);
const conversionAction = conversionSteps[0]?.normalizedAction;
const conversionPayload = conversionAction?.payload as
  | Readonly<Record<string, unknown>>
  | undefined;
const conversionCalls = Array.isArray(conversionPayload?.calls)
  ? conversionPayload.calls
  : [];
assert.equal(
  isValidFundingCommitPlanBoundary(
    boundaryPlan(
      { supportMetadata: conversionSupportMetadata },
      conversionSteps.map((step) =>
        step.ordinal === 0
          ? {
              ...step,
              normalizedAction: {
                ...step.normalizedAction,
                payload: {
                  ...(step.normalizedAction.payload as Record<string, unknown>),
                  calls: conversionCalls.slice(1),
                },
              } as FundingCommitPlan["steps"][number]["normalizedAction"],
            }
          : step,
      ),
    ),
  ),
  false,
  "v2 rejects an incomplete conversion batch",
);

console.log(
  "[funding-commit-plan-validator-tests] explicit validator/version dispatch, single-step exact validation, generic compatibility, and multi-step fail-closed passed",
);
