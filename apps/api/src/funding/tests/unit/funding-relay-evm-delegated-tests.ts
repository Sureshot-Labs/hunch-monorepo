import assert from "node:assert/strict";
import { Interface } from "ethers";

import { stableWalletOpaqueId } from "../../../account-value/canonical.js";
import {
  BASE_USDC,
  POLYGON_PUSD,
  POLYGON_USDC,
  POLYGON_USDCE_LEGACY,
  RELAY_DEPOSITORY_V2,
  RELAY_SELF_DEPOSITOR,
} from "../../../funding-providers/relay/rehearsal.js";
import {
  groupRelayExecutableActions,
  buildPolymarketPreRouteHandoffSteps,
  relayDelegatedCommitSteps,
} from "../../../funding-providers/relay/operation-plan.js";
import type { RelayEligibleSourceFact } from "../../planner/source-options.js";
import {
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
  validateRelayEvmPolicyRules,
} from "../../execution/delegated-funding-profiles.js";
import { validateRelayDelegatedEvmAction } from "../../execution/relay-evm-delegated-profile.js";
import {
  RELAY_EVM_FUNDING_PROFILE_SPECS,
  type RelayEvmFundingProfileSpec,
} from "../../execution/relay-evm-profile-specs.js";
import {
  classifyRelayCleanupAllowance,
  parseRelayEvmAllowanceObservation,
} from "../../execution/relay-evm-allowance-state.js";
import {
  captureRelayEvmAllowanceBaseline,
  relayEvmAllowanceBaselineSupportMetadata,
} from "../../execution/relay-evm-allowance-baseline.js";
import { relayEvmUsdCapMatchesRaw } from "../../execution/delegated-funding-capability-resolver.js";
import {
  buildTelegramRelayEvmAutomationPolicyV3,
  parseTelegramRelayEvmAutomationPolicyV3,
  telegramRelayEvmReceiptIsAuthorized,
} from "../../execution/telegram-funding-automation-policy.js";
import {
  compileFundingIntentPolicy,
  validateFundingIntentPolicy,
} from "../../policies/funding-policy-v2.js";
import { relayOwnedRefundEventMatches } from "../../reconciliation/relay-owned-refund-observer.js";
import { canTransitionFundingOperation } from "../../domain/transitions.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const WALLET_ID = stableWalletOpaqueId({
  walletType: "ethereum",
  networkId: "evm:8453",
  address: WALLET,
});
const RAW = "2000000";
const CAP = "10000000";

const anchoredAllowance = {
  raw: RAW,
  blockNumber: "123",
  blockHash: `0x${"ab".repeat(32)}`,
  finality: "latest" as const,
  revision: "c".repeat(64),
  ownershipRevision: "e".repeat(64),
  lastMutationTransactionHash: `0x${"51".repeat(32)}`,
};
const relayProfile =
  RELAY_EVM_FUNDING_PROFILE_SPECS[TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID];
assert.ok(relayProfile);
const capturedAllowanceBaseline = await captureRelayEvmAllowanceBaseline(
  relayProfile,
  {
    owner: WALLET,
    reader: async (input) => {
      assert.deepEqual(input, { owner: WALLET, blockNumber: null });
      return anchoredAllowance;
    },
  },
);
assert.equal(capturedAllowanceBaseline, anchoredAllowance);
assert.deepEqual(
  relayEvmAllowanceBaselineSupportMetadata(capturedAllowanceBaseline),
  {
    relayApprovalBaselineAllowanceRaw: RAW,
    relayApprovalBaselineAllowanceBlock: "123",
    relayApprovalBaselineAllowanceBlockHash: `0x${"ab".repeat(32)}`,
    relayApprovalBaselineAllowanceRevision: "c".repeat(64),
  },
  "every Relay origin must persist the same pre-approval ownership baseline",
);
assert.deepEqual(
  parseRelayEvmAllowanceObservation(anchoredAllowance),
  anchoredAllowance,
);
assert.equal(
  classifyRelayCleanupAllowance({
    currentRaw: RAW,
    currentRevision: anchoredAllowance.ownershipRevision,
    ownedRaw: RAW,
    ownedRevision: anchoredAllowance.ownershipRevision,
    actionOwnedRaw: RAW,
    actionOwnedRevision: anchoredAllowance.ownershipRevision,
  }),
  "owned_residual",
);
assert.equal(
  classifyRelayCleanupAllowance({
    currentRaw: "0",
    currentRevision: "d".repeat(64),
    ownedRaw: RAW,
    ownedRevision: anchoredAllowance.revision,
    actionOwnedRaw: RAW,
    actionOwnedRevision: anchoredAllowance.revision,
  }),
  "already_zero",
);
assert.equal(
  classifyRelayCleanupAllowance({
    currentRaw: "3000000",
    currentRevision: anchoredAllowance.revision,
    ownedRaw: RAW,
    ownedRevision: anchoredAllowance.revision,
    actionOwnedRaw: RAW,
    actionOwnedRevision: anchoredAllowance.revision,
  }),
  "foreign_drift",
);
assert.equal(
  classifyRelayCleanupAllowance({
    currentRaw: RAW,
    currentRevision: "d".repeat(64),
    ownedRaw: RAW,
    ownedRevision: anchoredAllowance.revision,
    actionOwnedRaw: RAW,
    actionOwnedRevision: anchoredAllowance.revision,
  }),
  "foreign_drift",
);

assert.equal(relayEvmUsdCapMatchesRaw("10", CAP), true);
assert.equal(relayEvmUsdCapMatchesRaw("10.000001", CAP), false);
assert.equal(relayEvmUsdCapMatchesRaw(null, CAP), false);

assert.equal(
  canTransitionFundingOperation(
    { status: "in_progress", stage: "source_action" },
    { status: "completed", stage: "terminal" },
  ),
  true,
  "a finalized non-value maintenance action can terminate its own operation",
);
const APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
const DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositErc20",
    stateMutability: "nonpayable",
    inputs: [
      { name: "depositor", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "id", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

function condition(
  field: string,
  fieldSource: string,
  operator: string,
  value: string,
  abi?: readonly unknown[],
) {
  return {
    field,
    field_source: fieldSource,
    operator,
    value,
    ...(abi ? { abi } : {}),
  };
}

const common = [
  condition("chain_id", "ethereum_transaction", "eq", "8453"),
  condition("value", "ethereum_transaction", "eq", "0x0"),
];
const approveRule = {
  action: "ALLOW",
  method: "eth_sendTransaction",
  conditions: [
    ...common,
    condition("to", "ethereum_transaction", "eq", BASE_USDC),
    condition(
      "function_name",
      "ethereum_calldata",
      "eq",
      "approve",
      APPROVE_ABI,
    ),
    condition(
      "approve.spender",
      "ethereum_calldata",
      "eq",
      RELAY_DEPOSITORY_V2,
      APPROVE_ABI,
    ),
    condition("approve.amount", "ethereum_calldata", "lte", CAP, APPROVE_ABI),
  ],
};
const depositRule = {
  action: "ALLOW",
  method: "eth_sendTransaction",
  conditions: [
    ...common,
    condition("to", "ethereum_transaction", "eq", RELAY_DEPOSITORY_V2),
    condition(
      "function_name",
      "ethereum_calldata",
      "eq",
      "depositErc20",
      DEPOSIT_ABI,
    ),
    condition(
      "depositErc20.depositor",
      "ethereum_calldata",
      "eq",
      RELAY_SELF_DEPOSITOR,
      DEPOSIT_ABI,
    ),
    condition(
      "depositErc20.token",
      "ethereum_calldata",
      "eq",
      BASE_USDC,
      DEPOSIT_ABI,
    ),
    condition(
      "depositErc20.amount",
      "ethereum_calldata",
      "lte",
      CAP,
      DEPOSIT_ABI,
    ),
  ],
};
const foreignDepositRule = {
  ...depositRule,
  conditions: depositRule.conditions.map((entry) =>
    entry.field === "depositErc20.depositor"
      ? { ...entry, value: WALLET }
      : entry,
  ),
};

assert.deepEqual(validateRelayEvmPolicyRules([approveRule, depositRule]), {
  valid: true,
  maxSourceRaw: BigInt(CAP),
  issues: [],
});
function relayPolicyPair(chainId: string, token: string) {
  const rewrite = (entry: (typeof approveRule.conditions)[number]) =>
    entry.field === "chain_id"
      ? { ...entry, value: chainId }
      : entry.field === "to" && entry.field_source === "ethereum_transaction"
        ? { ...entry, value: token }
        : entry;
  return [
    { ...approveRule, conditions: approveRule.conditions.map(rewrite) },
    {
      ...depositRule,
      conditions: depositRule.conditions.map((entry) =>
        entry.field === "chain_id"
          ? { ...entry, value: chainId }
          : entry.field === "depositErc20.token"
            ? { ...entry, value: token }
            : entry,
      ),
    },
  ] as const;
}
const polygonRelayRules = [
  POLYGON_PUSD,
  POLYGON_USDC,
  POLYGON_USDCE_LEGACY,
].flatMap((token) => relayPolicyPair("137", token));
assert.deepEqual(
  validateRelayEvmPolicyRules([approveRule, depositRule, ...polygonRelayRules]),
  { valid: true, maxSourceRaw: BigInt(CAP), issues: [] },
  "one combined policy accepts exactly one equal-cap pair for every supported EVM source asset",
);
assert.equal(
  validateRelayEvmPolicyRules([
    approveRule,
    depositRule,
    ...polygonRelayRules.map((rule, index) =>
      index === 1
        ? {
            ...rule,
            conditions: rule.conditions.map((entry) =>
              entry.field === "depositErc20.amount"
                ? { ...entry, value: String(BigInt(CAP) - 1n) }
                : entry,
            ),
          }
        : rule,
    ),
  ]).valid,
  false,
  "all Base and Polygon Relay pairs must share the same global cap",
);
const privyApproveAbi = APPROVE_ABI.map((abiEntry) => ({
  ...abiEntry,
  inputs: abiEntry.inputs.map((parameter) => ({
    ...parameter,
    internalType: parameter.type,
  })),
  outputs: abiEntry.outputs.map((parameter) => ({
    ...parameter,
    internalType: parameter.type,
  })),
}));
const privyDepositAbi = DEPOSIT_ABI.map((abiEntry) => ({
  ...abiEntry,
  inputs: abiEntry.inputs.map((parameter) => ({
    ...parameter,
    internalType: parameter.type,
  })),
  outputs: abiEntry.outputs,
}));
const approveRuleFromPrivy = {
  ...approveRule,
  conditions: approveRule.conditions.map((entry) =>
    entry.abi ? { ...entry, abi: privyApproveAbi } : entry,
  ),
};
const depositRuleFromPrivy = {
  ...depositRule,
  conditions: depositRule.conditions.map((entry) =>
    entry.abi ? { ...entry, abi: privyDepositAbi } : entry,
  ),
};
const mismatchedPrivyDepositAbi = privyDepositAbi.map((abiEntry) => ({
  ...abiEntry,
  inputs: abiEntry.inputs.map((parameter, index) =>
    index === 0 ? { ...parameter, internalType: "address payable" } : parameter,
  ),
}));
assert.equal(
  validateRelayEvmPolicyRules([approveRuleFromPrivy, depositRuleFromPrivy])
    .valid,
  true,
  "Privy read-back internalType metadata must preserve the exact ABI",
);
assert.equal(
  validateRelayEvmPolicyRules([
    approveRuleFromPrivy,
    {
      ...depositRuleFromPrivy,
      conditions: depositRuleFromPrivy.conditions.map((entry) =>
        entry.abi ? { ...entry, abi: mismatchedPrivyDepositAbi } : entry,
      ),
    },
  ]).valid,
  false,
  "Privy ABI internalType metadata cannot change the declared parameter type",
);
assert.equal(
  validateRelayEvmPolicyRules([
    approveRule,
    {
      ...depositRule,
      conditions: depositRule.conditions.map((entry) =>
        entry.field === "depositErc20.amount"
          ? { ...entry, value: "9999999" }
          : entry,
      ),
    },
  ]).valid,
  false,
  "approve and deposit policy caps cannot drift",
);
assert.equal(
  validateRelayEvmPolicyRules([approveRule, foreignDepositRule]).valid,
  false,
  "Relay policy depositor must be the contract self-binding zero address",
);
assert.equal(
  validateRelayEvmPolicyRules([approveRule, depositRule, depositRule]).valid,
  false,
  "duplicate self-bound deposit rules broaden the Relay policy",
);

const approve = new Interface(APPROVE_ABI);
const deposit = new Interface(DEPOSIT_ABI);
const actionBase = {
  kind: "evm_transaction" as const,
  networkId: "evm:8453",
  senderWalletId: WALLET_ID,
  valueRaw: "0",
  gasLimitRaw: null,
};
assert.equal(
  validateRelayDelegatedEvmAction({
    action: {
      ...actionBase,
      actionId: "relay-approve",
      to: BASE_USDC,
      data: approve.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, RAW]),
    },
    actionValidationResult: { relayStepKind: "approve" },
    expectedRaw: RAW,
    walletAddress: WALLET,
    walletId: WALLET_ID,
  }).kind,
  "approve",
);
const orderId = `0x${"12".repeat(32)}`;
assert.deepEqual(
  validateRelayDelegatedEvmAction({
    action: {
      ...actionBase,
      actionId: "relay-deposit",
      to: RELAY_DEPOSITORY_V2,
      data: deposit.encodeFunctionData("depositErc20", [
        RELAY_SELF_DEPOSITOR,
        BASE_USDC,
        RAW,
        orderId,
      ]),
    },
    actionValidationResult: { relayStepKind: "deposit" },
    expectedRaw: RAW,
    walletAddress: WALLET,
    walletId: WALLET_ID,
  }),
  { kind: "deposit", orderId },
);
assert.equal(
  validateRelayDelegatedEvmAction({
    action: {
      ...actionBase,
      actionId: "relay-cleanup",
      to: BASE_USDC,
      data: approve.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, 0n]),
    },
    actionValidationResult: { relayStepKind: "cleanup" },
    expectedRaw: RAW,
    walletAddress: WALLET,
    walletId: WALLET_ID,
  }).kind,
  "cleanup",
);
assert.throws(() =>
  validateRelayDelegatedEvmAction({
    action: {
      ...actionBase,
      actionId: "relay-over-cap-action",
      to: BASE_USDC,
      data: approve.encodeFunctionData("approve", [
        "0x2222222222222222222222222222222222222222",
        RAW,
      ]),
    },
    actionValidationResult: { relayStepKind: "approve" },
    expectedRaw: RAW,
    walletAddress: WALLET,
    walletId: WALLET_ID,
  }),
);
for (const profile of Object.values(RELAY_EVM_FUNDING_PROFILE_SPECS).filter(
  (candidate) => candidate.sourceAsset.networkId === "evm:137",
)) {
  const polygonAction = {
    ...actionBase,
    networkId: "evm:137",
    actionId: `relay-polygon-approve:${profile.profileId}`,
    to: profile.sourceAsset.assetId,
    data: approve.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, RAW]),
  };
  assert.equal(
    validateRelayDelegatedEvmAction({
      action: polygonAction,
      actionValidationResult: { relayStepKind: "approve" },
      expectedRaw: RAW,
      profile,
      walletAddress: WALLET,
      walletId: WALLET_ID,
    }).kind,
    "approve",
  );
  assert.throws(() =>
    validateRelayDelegatedEvmAction({
      action: { ...polygonAction, networkId: "evm:8453" },
      actionValidationResult: { relayStepKind: "approve" },
      expectedRaw: RAW,
      profile: profile as RelayEvmFundingProfileSpec,
      walletAddress: WALLET,
      walletId: WALLET_ID,
    }),
  );
}

const atomicWalletProfile = {
  walletId: WALLET_ID,
  controllerWalletRef: "controller-wallet",
  networkId: "evm:8453",
  address: WALLET,
  source: "embedded" as const,
  signingModes: ["privy_delegated" as const],
  serverWalletRef: "privy-wallet",
  sponsorshipPolicyIds: [],
  evmAtomicBatchMode: "privy_wallet_send_calls" as const,
};
const quotedRelayActions = [
  {
    ...actionBase,
    actionId: "relay:fixture:approve",
    to: BASE_USDC,
    data: approve.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, RAW]),
  },
  {
    ...actionBase,
    actionId: "relay:fixture:deposit",
    to: RELAY_DEPOSITORY_V2,
    data: deposit.encodeFunctionData("depositErc20", [
      WALLET,
      BASE_USDC,
      RAW,
      orderId,
    ]),
  },
];
assert.equal(
  groupRelayExecutableActions({
    actions: quotedRelayActions,
    preserveActionBoundaries: false,
    profile: atomicWalletProfile,
  }).length,
  1,
  "ordinary client execution may atomically batch the Relay calls",
);
assert.deepEqual(
  groupRelayExecutableActions({
    actions: quotedRelayActions,
    preserveActionBoundaries: true,
    profile: atomicWalletProfile,
  }).map(({ action }) => action.actionId),
  ["relay:fixture:approve", "relay:fixture:deposit"],
  "delegated Relay execution preserves the durable approve/deposit boundary",
);

const delegatedSteps = relayDelegatedCommitSteps({
  steps: [
    {
      ordinal: 0,
      segmentOrdinal: 0,
      stepKind: "transaction",
      state: "action_required",
      actionFingerprint: "approve-fingerprint",
      executorId: "web",
      payerRequirement: "privy_sponsor",
      dependsOnOrdinal: null,
      normalizedAction: {
        ...actionBase,
        actionId: "relay:fixture:approve",
        to: BASE_USDC,
        data: approve.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, RAW]),
      },
      actionValidationResult: {},
    },
    {
      ordinal: 1,
      segmentOrdinal: 0,
      stepKind: "transaction",
      state: "action_required",
      actionFingerprint: "deposit-fingerprint",
      executorId: "web",
      payerRequirement: "privy_sponsor",
      dependsOnOrdinal: 0,
      normalizedAction: {
        ...actionBase,
        actionId: "relay:fixture:deposit",
        to: RELAY_DEPOSITORY_V2,
        data: deposit.encodeFunctionData("depositErc20", [
          WALLET,
          BASE_USDC,
          RAW,
          orderId,
        ]),
      },
      actionValidationResult: {},
    },
  ],
  sourceAmount: {
    asset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    raw: RAW,
  },
  profile: atomicWalletProfile,
  serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
});
assert.deepEqual(
  delegatedSteps.map((step) => [step.state, step.dependsOnOrdinal]),
  [
    ["planned", null],
    ["planned", 0],
  ],
  "both steps remain inert until the atomic receipt link activates approve",
);

const persistentDelegatedSteps = relayDelegatedCommitSteps({
  steps: delegatedSteps.map((step, ordinal) => ({
    ...step,
    state: "action_required" as const,
    ...(ordinal === 1
      ? {
          normalizedAction: {
            ...step.normalizedAction,
            data: deposit.encodeFunctionData("depositErc20", [
              WALLET,
              BASE_USDC,
              RAW,
              orderId,
            ]),
          },
        }
      : {}),
  })),
  sourceAmount: {
    asset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    raw: RAW,
  },
  profile: atomicWalletProfile,
  serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
  persistentApprovalCapRaw: CAP,
});
const persistentApprove = persistentDelegatedSteps[0];
const persistentDeposit = persistentDelegatedSteps[1];
assert.ok(persistentApprove && persistentDeposit);
assert.equal(
  approve.decodeFunctionData(
    "approve",
    String(persistentApprove.normalizedAction.data),
  ).amount,
  BigInt(CAP),
  "the first delegated route approves only the authorization policy cap",
);
assert.equal(
  persistentApprove.actionValidationResult.relayApprovalCapRaw,
  CAP,
);
assert.equal(
  persistentDeposit.actionValidationResult.relayAllowanceMode,
  "preexisting",
  "the dependent exact deposit consumes the bounded allowance like a later deposit-only route",
);
assert.doesNotThrow(() =>
  validateRelayDelegatedEvmAction({
    action: persistentApprove.normalizedAction as never,
    actionValidationResult: persistentApprove.actionValidationResult,
    expectedRaw: RAW,
    walletAddress: WALLET,
    walletId: WALLET_ID,
    profile: relayProfile,
  }),
  "validator accepts the cap only when it is durably attached to this approval step",
);

const delegatedDepositOnlySteps = relayDelegatedCommitSteps({
  steps: [
    {
      ordinal: 0,
      segmentOrdinal: 0,
      stepKind: "transaction",
      state: "action_required",
      actionFingerprint: "deposit-only-fingerprint",
      executorId: "web",
      payerRequirement: "privy_sponsor",
      dependsOnOrdinal: null,
      normalizedAction: {
        ...actionBase,
        actionId: "relay:fixture:deposit",
        to: RELAY_DEPOSITORY_V2,
        data: deposit.encodeFunctionData("depositErc20", [
          WALLET,
          BASE_USDC,
          RAW,
          orderId,
        ]),
      },
      actionValidationResult: {},
    },
  ],
  sourceAmount: {
    asset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    raw: RAW,
  },
  profile: atomicWalletProfile,
  serverExecutionProfileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
});
assert.deepEqual(
  delegatedDepositOnlySteps.map((step) => [
    step.actionValidationResult.relayStepKind,
    step.actionValidationResult.relayAllowanceMode,
    step.dependsOnOrdinal,
  ]),
  [["deposit", "preexisting", null]],
  "an exact Relay deposit-only quote is a root action when the controller already has allowance",
);

const depositWallet = "0x7777777777777777777777777777777777777777";
const polygonActionBase = { ...actionBase, networkId: "evm:137" };
const delegatedApproveStep = delegatedSteps[0];
const delegatedDepositStep = delegatedSteps[1];
assert.ok(delegatedApproveStep && delegatedDepositStep);
const reverseHandoffSource = {
  componentId: "component:deposit-wallet-pusd",
  sourceLocationPatternId: "venue_polymarket_polygon_pusd",
  safeLabel: "Polymarket balance",
  source: {
    kind: "owned_location",
    location: {
      kind: "venue_account",
      locationId: "location:deposit-wallet",
      accountId: "account:test",
      asset: {
        networkId: "evm:137",
        assetId: POLYGON_PUSD,
        decimals: 6,
      },
      details: {
        venueId: "polymarket",
        accountRef: "polymarket:test",
        controllerWalletId: WALLET_ID,
        address: depositWallet,
      },
    },
  },
  quoteInputAmount: {
    asset: { networkId: "evm:137", assetId: POLYGON_PUSD, decimals: 6 },
    raw: RAW,
  },
  maximumSourceRaw: RAW,
  maximumSlippageBps: 100,
  estimatedUsd: "2",
  transferable: true,
  riskEligible: true,
  walletExecutionReady: true,
  nativeGasReady: true,
  freshness: "fresh",
  preRouteHandoff: {
    kind: "polymarket_deposit_wallet_to_controller_v1",
    sourceLocation: {
      kind: "venue_account",
      locationId: "location:deposit-wallet",
      accountId: "account:test",
      asset: {
        networkId: "evm:137",
        assetId: POLYGON_PUSD,
        decimals: 6,
      },
      details: {
        venueId: "polymarket",
        accountRef: "polymarket:test",
        controllerWalletId: WALLET_ID,
        address: depositWallet,
      },
    },
    funderAddress: depositWallet,
    controllerAddress: WALLET,
    tokenAddress: POLYGON_PUSD,
  },
} satisfies RelayEligibleSourceFact;

const reverseHandoffSteps = buildPolymarketPreRouteHandoffSteps({
  source: reverseHandoffSource,
  sourceAmount: {
    asset: { networkId: "evm:137", assetId: POLYGON_PUSD, decimals: 6 },
    raw: RAW,
  },
  profile: atomicWalletProfile,
  steps: [],
});
assert.equal(reverseHandoffSteps.length, 1);
assert.equal(reverseHandoffSteps[0]?.stepKind, "external_handoff");
assert.equal(
  reverseHandoffSteps[0]?.segmentOrdinal,
  null,
  "the exact Deposit Wallet handoff must not inherit the short Relay quote deadline",
);

const reverseDelegatedSteps = relayDelegatedCommitSteps({
  steps: [
    {
      ...delegatedApproveStep,
      ordinal: 0,
      normalizedAction: {
        ...polygonActionBase,
        actionId: "relay:reverse:approve",
        to: POLYGON_PUSD,
        data: approve.encodeFunctionData("approve", [RELAY_DEPOSITORY_V2, RAW]),
      },
    },
    {
      ...delegatedDepositStep,
      ordinal: 1,
      normalizedAction: {
        ...polygonActionBase,
        actionId: "relay:reverse:deposit",
        to: RELAY_DEPOSITORY_V2,
        data: deposit.encodeFunctionData("depositErc20", [
          WALLET,
          POLYGON_PUSD,
          RAW,
          orderId,
        ]),
      },
    },
  ],
  sourceAmount: {
    asset: { networkId: "evm:137", assetId: POLYGON_PUSD, decimals: 6 },
    raw: RAW,
  },
  profile: atomicWalletProfile,
  serverExecutionProfileId: TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
});
assert.deepEqual(
  reverseDelegatedSteps.map((step) => [
    step.actionValidationResult.relayStepKind,
    step.dependsOnOrdinal,
  ]),
  [
    ["approve", null],
    ["deposit", 0],
  ],
  "Relay approval and deposit remain exact after the user-authorized handoff",
);
assert.equal(
  delegatedSteps[1]?.actionValidationResult.postconditionEvidenceKind,
  "exact_erc20_source_debit_v1",
);
const committedDepositData = delegatedSteps[1]?.normalizedAction.data;
assert.equal(typeof committedDepositData, "string");
const committedDeposit = deposit.decodeFunctionData(
  "depositErc20",
  String(committedDepositData),
);
assert.equal(
  String(committedDeposit.depositor).toLowerCase(),
  RELAY_SELF_DEPOSITOR,
  "the durable Relay action uses Depository V2 msg.sender self-binding",
);
assert.equal(
  delegatedSteps[1]?.actionValidationResult.quotedDepositorAddress,
  WALLET,
);
assert.equal(
  delegatedSteps[1]?.actionValidationResult.committedDepositorMode,
  "msg_sender_via_zero",
);
assert.equal(
  delegatedSteps[1]?.actionValidationResult.quotedActionFingerprint,
  "deposit-fingerprint",
);
assert.notEqual(
  delegatedSteps[1]?.actionFingerprint,
  "deposit-fingerprint",
  "canonical zero-depositor calldata receives its own durable fingerprint",
);
assert.throws(
  () =>
    validateRelayDelegatedEvmAction({
      action: {
        ...actionBase,
        actionId: "relay-explicit-wallet-deposit",
        to: RELAY_DEPOSITORY_V2,
        data: deposit.encodeFunctionData("depositErc20", [
          WALLET,
          BASE_USDC,
          RAW,
          orderId,
        ]),
      },
      actionValidationResult: { relayStepKind: "deposit" },
      expectedRaw: RAW,
      walletAddress: WALLET,
      walletId: WALLET_ID,
    }),
  "runtime must reject the original explicit-wallet quote envelope",
);
assert.equal(
  delegatedSteps[0]?.actionValidationResult.requiresSingleOperationBundle,
  true,
);
assert.equal(
  delegatedSteps[1]?.actionValidationResult.requiresSingleOperationBundle,
  true,
);

const basePolicy = {
  version: 2 as const,
  venues: ["polymarket" as const],
  receive: { assets: ["base:usdc" as const], privy: false },
  paused: false,
};
const withoutExplicitCap = compileFundingIntentPolicy(basePolicy);
assert.equal(withoutExplicitCap.venues[0]?.delegatedExecutionEnabled, false);
const withExplicitCap = compileFundingIntentPolicy({
  ...basePolicy,
  receive: {
    ...basePolicy.receive,
    delegatedRelayEvmDailyCapUsd: "25",
  },
});
assert.equal(withExplicitCap.venues[0]?.delegatedExecutionEnabled, true);
assert.deepEqual(withExplicitCap.venues[0]?.delegatedPolicyIds, [
  TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
]);
assert.equal(withExplicitCap.venues[0]?.delegatedDailyCapUsd, "25");
assert.equal(
  validateFundingIntentPolicy({
    ...basePolicy,
    receive: {
      ...basePolicy.receive,
      delegatedRelayEvmDailyCapUsd: "not-money",
    },
  }).ok,
  false,
);

const automationV3 = buildTelegramRelayEvmAutomationPolicyV3({
  authorization: {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    telegramAccountId: "33333333-3333-4333-8333-333333333333",
    telegramUserId: "42",
    userWalletId: "44444444-4444-4444-8444-444444444444",
    privyWalletId: "privy-wallet",
    walletAddress: WALLET,
    walletChain: "ethereum",
    profileId: TELEGRAM_RELAY_EVM_FUNDING_PROFILE_ID,
    securityClass: "routed_value_movement",
    maxSourceRaw: CAP,
    signerId: "signer",
    signerFingerprint: "a".repeat(64),
    policyId: "policy",
    policyFingerprint: "b".repeat(64),
    venueId: "polymarket",
    destinationOptionId: "destination",
    venueBindingOptionId: "binding",
    sourceAsset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
    destinationAsset: {
      networkId: "evm:137",
      assetId: "0x0000000000000000000000000000000000000001",
      decimals: 6,
    },
    grantedAt: new Date(0).toISOString(),
    expiresAt: null,
  },
  fundingPolicyRevision: "funding-policy-revision",
  destinationAsset: {
    networkId: "evm:137",
    assetId: "0x0000000000000000000000000000000000000001",
    decimals: 6,
  },
  sourceAsset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
  variants: [
    {
      variantId: "base-usdc-variant",
      networkId: "evm:8453",
      asset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
      destinationAddress: WALLET,
      destinationLocationId: "base-wallet",
      baselineRaw: "0",
      baselineRevision: "baseline",
      observation: {
        adapterId: "evm_erc20_transfer_v1",
        payload: { eventCursorBlock: "100" },
      },
      completion: { kind: "child_funding_operation" },
    },
  ],
});
assert.deepEqual(
  parseTelegramRelayEvmAutomationPolicyV3(automationV3),
  automationV3,
);
assert.equal(
  telegramRelayEvmReceiptIsAuthorized({
    policy: automationV3,
    variantId: "base-usdc-variant",
    ledgerHeight: "101",
    rawAmount: RAW,
  }),
  true,
);
assert.equal(
  telegramRelayEvmReceiptIsAuthorized({
    policy: automationV3,
    variantId: "base-usdc-variant",
    ledgerHeight: "101",
    rawAmount: (BigInt(CAP) + 1n).toString(),
  }),
  false,
  "V3 consent cannot route a receipt beyond its immutable raw cap",
);

const polygonPusdAutomationV3 = buildTelegramRelayEvmAutomationPolicyV3({
  authorization: {
    id: "55555555-5555-4555-8555-555555555555",
    userId: "22222222-2222-4222-8222-222222222222",
    telegramAccountId: "33333333-3333-4333-8333-333333333333",
    telegramUserId: "42",
    userWalletId: "44444444-4444-4444-8444-444444444444",
    privyWalletId: "privy-wallet",
    walletAddress: WALLET,
    walletChain: "ethereum",
    profileId: TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
    securityClass: "routed_value_movement",
    maxSourceRaw: CAP,
    signerId: "signer",
    signerFingerprint: "a".repeat(64),
    policyId: "policy",
    policyFingerprint: "b".repeat(64),
    venueId: "limitless",
    destinationOptionId: "limitless-destination",
    venueBindingOptionId: "limitless-binding",
    sourceAsset: { networkId: "evm:137", assetId: POLYGON_PUSD, decimals: 6 },
    destinationAsset: {
      networkId: "evm:8453",
      assetId: BASE_USDC,
      decimals: 6,
    },
    grantedAt: new Date(0).toISOString(),
    expiresAt: null,
  },
  fundingPolicyRevision: "funding-policy-revision",
  destinationAsset: { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 },
  sourceAsset: { networkId: "evm:137", assetId: POLYGON_PUSD, decimals: 6 },
  variants: [
    {
      variantId: "polygon-pusd-variant",
      networkId: "evm:137",
      asset: { networkId: "evm:137", assetId: POLYGON_PUSD, decimals: 6 },
      destinationAddress: WALLET,
      destinationLocationId: "polygon-wallet",
      baselineRaw: "0",
      baselineRevision: "baseline",
      observation: {
        adapterId: "evm_erc20_transfer_v1",
        payload: { eventCursorBlock: "100" },
      },
      completion: { kind: "child_funding_operation" },
    },
  ],
});
assert.equal(
  polygonPusdAutomationV3.profileId,
  TELEGRAM_RELAY_POLYGON_PUSD_PROFILE_ID,
);
assert.equal(polygonPusdAutomationV3.venueId, "limitless");
assert.equal(polygonPusdAutomationV3.variantCursors[0]?.networkId, "evm:137");
assert.deepEqual(
  parseTelegramRelayEvmAutomationPolicyV3(polygonPusdAutomationV3),
  polygonPusdAutomationV3,
  "Polygon relay consent must retain its exact profile, venue, and source cursor",
);
assert.equal(
  telegramRelayEvmReceiptIsAuthorized({
    policy: polygonPusdAutomationV3,
    variantId: "polygon-pusd-variant",
    ledgerHeight: "101",
    rawAmount: RAW,
  }),
  true,
);

const event = {
  variant: {} as never,
  transactionHash: `0x${"34".repeat(32)}`,
  eventIndex: "2",
  blockNumber: "101",
  blockHash: `0x${"56".repeat(32)}`,
  sourceAddress: "0x2222222222222222222222222222222222222222",
  destinationAddress: WALLET,
  rawAmount: RAW,
  observedAt: new Date(0).toISOString(),
};
assert.equal(
  relayOwnedRefundEventMatches({
    event,
    expectedRaw: RAW,
    sourceBlock: "100",
    sourceEventIndex: "1",
    transactionReferenceFingerprints: [`fp:${event.transactionHash}`],
    walletAddress: WALLET,
    fingerprint: (reference) => `fp:${reference}`,
  }),
  true,
);
assert.equal(
  relayOwnedRefundEventMatches({
    event,
    expectedRaw: RAW,
    sourceBlock: "102",
    sourceEventIndex: "1",
    transactionReferenceFingerprints: [`fp:${event.transactionHash}`],
    walletAddress: WALLET,
    fingerprint: (reference) => `fp:${reference}`,
  }),
  false,
  "pre-debit transfers cannot be attributed as refunds",
);

console.log(
  "[funding-relay-evm-delegated-tests] exact policy, actions, explicit cap, cleanup, and owned refund correlation passed",
);
