#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";

import { POLYMARKET_FUNDING_ROUTER } from "@hunch/contracts";
import { Interface } from "ethers";

import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import type { NormalizedAction } from "../../domain/types.js";
import {
  createPolymarketWrapDelegatedFundingProfile,
  delegatedFundingProfileOrder,
} from "../../execution/delegated-funding-executor.js";
import {
  loadPolymarketWrapExecutionConfiguration,
  polymarketWrapExecutorEnvironmentReady,
} from "../../execution/delegated-funding-config.js";
import {
  classifyPolymarketWrapControlPlane,
  combineDelegatedFundingDecisions,
  fundingPolicyRevisionMayResume,
} from "../../execution/delegated-funding-capability.js";
import {
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  delegatedFundingProfile,
  validatePolymarketDepositUsdceWrapAction,
  validatePolymarketDepositUsdceWrapPolicy,
} from "../../execution/delegated-funding-profiles.js";
import {
  createPrivyDelegatedFundingDriver,
  PrivyDelegatedFundingDriver,
  PrivyDelegatedFundingProfileInvalidError,
  resolvePrivyProfileInspectionFailure,
  resolvePrivyDelegatedFundingSubmission,
  selectPrivyDelegatedFundingReference,
} from "../../execution/privy-delegated-funding-driver.js";
import {
  knownPrivyPolicyFingerprint,
  polymarketKnownSignerRuntimeSpecs,
  polymarketKnownSignerSpecs,
  privyKeyQuorumFingerprint,
  validateKnownPrivySignerRuntime,
  validateKnownPrivyWalletSigners,
} from "../../execution/known-privy-wallet-signers.js";
import { derivePrivyAuthorizationPublicKey } from "../../execution/privy-authorization-key.js";
import { lockTelegramFundingLinkLifecycle } from "../../execution/telegram-funding-link-lifecycle-lock.js";
import {
  parseTelegramFundingAutomationPolicyV2,
  telegramFundingReceiptIsProspectivelyAuthorized,
} from "../../execution/telegram-funding-automation-policy.js";
import type { ResolvedFundingPolicy } from "../../policies/funding-policy-service.js";
import {
  claimFundingReceiveReceiptOperationLinkInTransaction,
  linkFundingReceiveReceiptOperationInTransaction,
} from "../../persistence/funding-receive-session-repository.js";
import {
  compileFundingIntentPolicy,
  type FundingIntentPolicy,
} from "../../policies/funding-policy-v2.js";

const ROUTER = "0x1111111111111111111111111111111111111111";
const WALLET_ID = "wallet_pm_wrap_12345678";
const AUTHORIZATION_PRIVATE_KEY = crypto
  .generateKeyPairSync("ec", { namedCurve: "P-256" })
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
const FUND_ABI = [
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "expectedNonce", type: "uint256" },
      { name: "totalAmount", type: "uint256" },
      { name: "pUsdAmount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
const fundInterface = new Interface(FUND_ABI);

{
  const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
  await lockTelegramFundingLinkLifecycle(
    {
      query: async (sql: string, params?: readonly unknown[]) => {
        queries.push({ sql, params: params ?? [] });
        return { rowCount: 1, rows: [{}] };
      },
    } as never,
    "user-lifecycle-1",
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0]?.sql ?? "", /pg_advisory_xact_lock/u);
  assert.deepEqual(queries[0]?.params, [
    "telegram-funding-link-lifecycle:user-lifecycle-1",
  ]);
}

{
  const queries: Array<{ params: readonly unknown[]; sql: string }> = [];
  assert.equal(
    await claimFundingReceiveReceiptOperationLinkInTransaction(
      {
        query: async (sql: string, params?: readonly unknown[]) => {
          queries.push({ sql, params: params ?? [] });
          return { rowCount: 1, rows: [{ "?column?": 1 }] };
        },
      } as never,
      { receiptId: "receipt-claim-1", userId: "user-claim-1" },
    ),
    true,
  );
  const query = queries[0];
  assert.ok(query);
  assert.match(query.sql, /status = 'observed'/u);
  assert.match(query.sql, /handling = 'automatic_conversion'/u);
  assert.match(query.sql, /for update/u);
  assert.deepEqual(query.params, ["receipt-claim-1", "user-claim-1"]);
}

{
  const queries: string[] = [];
  await assert.rejects(
    linkFundingReceiveReceiptOperationInTransaction(
      {
        query: async (sql: string) => {
          queries.push(sql);
          if (/update funding_receive_receipts/u.test(sql)) {
            return {
              rowCount: 1,
              rows: [
                {
                  asset_decimals: 6,
                  asset_id: ROUTER,
                  block_hash: `0x${"1".repeat(64)}`,
                  destination_address: ROUTER,
                  event_index: "1",
                  ledger_height: "1",
                  network_id: "evm:137",
                  observed_at: new Date(),
                  raw_amount: "1000000",
                  receive_session_id: "receive-session-1",
                  source_address: ROUTER,
                  tx_hash: `0x${"2".repeat(64)}`,
                  variant_id: "variant-1",
                },
              ],
            };
          }
          return { rowCount: 0, rows: [] };
        },
      } as never,
      {
        receiptId: "receipt-link-1",
        userId: "user-link-1",
        childFundingOperationId: "operation-link-1",
        authorizationId: "authorization-link-1",
        authorizationFingerprint: "a".repeat(64),
        telegramFundingConsentId: "consent-link-1",
        telegramFundingConsentFingerprint: "b".repeat(64),
        now: new Date(),
      },
    ),
    /not bound to exact receipt evidence/u,
  );
  const exactLinkQuery = queries.find((sql) => /select step\.id/u.test(sql));
  assert.ok(exactLinkQuery);
  assert.match(
    exactLinkQuery,
    /operation\.policy_revision\s*=\s*funding_consent\.automation_policy_snapshot\s*->>\s*'fundingPolicyRevision'/u,
    "the atomic receipt link must bind the operation to the consent's frozen Funding Policy revision",
  );
}

function condition(
  field: string,
  fieldSource: string,
  value: string,
  abi = false,
) {
  return {
    ...(abi ? { abi: FUND_ABI } : {}),
    field,
    field_source: fieldSource,
    operator: "eq",
    value,
  };
}

function wrapPolicy() {
  return {
    chainType: "ethereum" as const,
    id: "policy_pm_wrap_v1",
    rules: [
      {
        id: "allow_exact_pm_wrap",
        name: "Hunch Polymarket Deposit USDC.e Wrap v1",
        action: "ALLOW",
        method: "eth_sendTransaction",
        conditions: [
          condition("chain_id", "ethereum_transaction", "137"),
          condition("to", "ethereum_transaction", ROUTER),
          condition("value", "ethereum_transaction", "0x0"),
          condition("function_name", "ethereum_calldata", "fund", true),
          condition("fund.pUsdAmount", "ethereum_calldata", "0", true),
        ],
      },
    ],
  };
}

function setPolicyConditionValue(
  policy: ReturnType<typeof wrapPolicy>,
  index: number,
  value: string,
): void {
  const rule = policy.rules[0];
  assert.ok(rule, "wrap policy must contain its single allow rule");
  const selectedCondition = rule.conditions[index];
  assert.ok(selectedCondition, `wrap policy condition ${index} must exist`);
  selectedCondition.value = value;
}

function action(
  totalAmount: bigint,
  pUsdAmount = 0n,
): Extract<NormalizedAction, { kind: "evm_transaction" }> {
  return {
    kind: "evm_transaction",
    actionId: "wrap_full_receipt",
    networkId: "evm:137",
    senderWalletId: WALLET_ID,
    to: ROUTER,
    data: fundInterface.encodeFunctionData("fund", [
      77n,
      totalAmount,
      pUsdAmount,
    ]),
    valueRaw: "0",
    gasLimitRaw: null,
  };
}

const validatedPolicy = validatePolymarketDepositUsdceWrapPolicy({
  policy: wrapPolicy(),
  policyId: "policy_pm_wrap_v1",
  routerAddress: ROUTER,
});
assert.equal(validatedPolicy.valid, true, validatedPolicy.issues.join("; "));

for (const [label, mutate] of [
  [
    "chain",
    (policy: ReturnType<typeof wrapPolicy>) => {
      setPolicyConditionValue(policy, 0, "1");
    },
  ],
  [
    "router",
    (policy: ReturnType<typeof wrapPolicy>) => {
      setPolicyConditionValue(
        policy,
        1,
        "0x2222222222222222222222222222222222222222",
      );
    },
  ],
  [
    "native value",
    (policy: ReturnType<typeof wrapPolicy>) => {
      setPolicyConditionValue(policy, 2, "0x1");
    },
  ],
  [
    "function",
    (policy: ReturnType<typeof wrapPolicy>) => {
      setPolicyConditionValue(policy, 3, "transfer");
    },
  ],
  [
    "pUSD input",
    (policy: ReturnType<typeof wrapPolicy>) => {
      setPolicyConditionValue(policy, 4, "1");
    },
  ],
] as const) {
  const candidate = wrapPolicy();
  mutate(candidate);
  assert.equal(
    validatePolymarketDepositUsdceWrapPolicy({
      policy: candidate,
      policyId: candidate.id,
      routerAddress: ROUTER,
    }).valid,
    false,
    `${label} must remain exact`,
  );
}

const cappedPolicy = wrapPolicy();
cappedPolicy.rules[0]?.conditions.push({
  ...condition("fund.totalAmount", "ethereum_calldata", "1000000", true),
  operator: "lte",
});
assert.equal(
  validatePolymarketDepositUsdceWrapPolicy({
    policy: cappedPolicy,
    policyId: cappedPolicy.id,
    routerAddress: ROUTER,
  }).valid,
  false,
  "the wrap-only policy must leave totalAmount unrestricted",
);

const veryLargeRaw = (2n ** 255n).toString();
assert.deepEqual(
  validatePolymarketDepositUsdceWrapAction({
    action: action(BigInt(veryLargeRaw)),
    expectedRaw: veryLargeRaw,
    routerAddress: ROUTER,
    walletId: WALLET_ID,
  }),
  { expectedNonce: 77n, totalAmount: BigInt(veryLargeRaw) },
);
assert.throws(
  () =>
    validatePolymarketDepositUsdceWrapAction({
      action: action(BigInt(veryLargeRaw) - 1n),
      expectedRaw: veryLargeRaw,
      routerAddress: ROUTER,
      walletId: WALLET_ID,
    }),
  /full USDC\.e receipt/u,
);
assert.throws(
  () =>
    validatePolymarketDepositUsdceWrapAction({
      action: { ...action(1n), networkId: "evm:1" },
      expectedRaw: "1",
      routerAddress: ROUTER,
      walletId: WALLET_ID,
    }),
  /closed-destination profile/u,
);
assert.throws(
  () =>
    validatePolymarketDepositUsdceWrapAction({
      action: {
        ...action(1n),
        to: "0x2222222222222222222222222222222222222222",
      },
      expectedRaw: "1",
      routerAddress: ROUTER,
      walletId: WALLET_ID,
    }),
  /closed-destination profile/u,
);
assert.throws(
  () =>
    validatePolymarketDepositUsdceWrapAction({
      action: action(BigInt(veryLargeRaw), 1n),
      expectedRaw: veryLargeRaw,
      routerAddress: ROUTER,
      walletId: WALLET_ID,
    }),
  /full USDC\.e receipt/u,
);

const snapshot = parseTelegramFundingAutomationPolicyV2({
  version: 2,
  kind: "polymarket_usdce_full_receipt_wrap",
  profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  fullReceipt: true,
  authorizationId: "authorization_12345678",
  authorizationFingerprint: "a".repeat(64),
  signerId: "signer_12345678",
  signerFingerprint: "b".repeat(64),
  policyId: "policy_12345678",
  policyFingerprint: "c".repeat(64),
  fundingPolicyRevision: "funding_policy_revision_12345678",
  venueId: "polymarket",
  destinationOptionId: "destination_pm_12345678",
  venueBindingOptionId: "binding_pm_12345678",
  sourceAsset: {
    networkId: "evm:137",
    assetId: RELAY_PINNED_ASSETS.polygonUsdce,
    decimals: 6,
  },
  destinationAsset: {
    networkId: "evm:137",
    assetId: RELAY_PINNED_ASSETS.polygonPusd,
    decimals: 6,
  },
  variantCursors: [
    {
      variantId: "variant_usdce_12345678",
      networkId: "evm:137",
      ledgerHeightExclusive: "123456789",
    },
  ],
});
assert.ok(snapshot);
assert.equal(
  snapshot.fundingPolicyRevision,
  "funding_policy_revision_12345678",
);
assert.equal(
  parseTelegramFundingAutomationPolicyV2({
    ...snapshot,
    fundingPolicyRevision: undefined,
  }),
  null,
  "automatic consent without its frozen Funding Policy revision must fail closed",
);
assert.equal(
  telegramFundingReceiptIsProspectivelyAuthorized({
    policy: snapshot,
    variantId: "variant_usdce_12345678",
    ledgerHeight: "123456789",
  }),
  false,
  "a transfer at the frozen consent cursor is never prospective",
);
assert.equal(
  telegramFundingReceiptIsProspectivelyAuthorized({
    policy: snapshot,
    variantId: "variant_usdce_12345678",
    ledgerHeight: "123456790",
  }),
  true,
);

assert.deepEqual(
  delegatedFundingProfile(POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID),
  {
    profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
    securityClass: "closed_destination_transform",
    networkId: "evm:137",
    venueId: "polymarket",
    executorId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  },
);
assert.equal(delegatedFundingProfile("future_unknown_profile"), null);
assert.deepEqual(
  delegatedFundingProfileOrder(["wrap", "relay", "venue"], 1),
  ["relay", "venue", "wrap"],
  "a limit-one batch can advance its start profile instead of starving later profiles",
);

const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const submissionDependencies = {
  transactionById: async (transactionId: string) => ({
    status: "broadcasted",
    transaction_hash: transactionId === "transaction-1" ? HASH_A : null,
  }),
  userOperationTransactionHash: async (userOperationHash: string) =>
    userOperationHash === HASH_B ? HASH_A : null,
};
assert.deepEqual(
  await resolvePrivyDelegatedFundingSubmission(
    { hash: HASH_A },
    submissionDependencies,
  ),
  { kind: "submitted", transactionReference: HASH_A },
);
assert.deepEqual(
  await resolvePrivyDelegatedFundingSubmission(
    { transaction_id: "transaction-1" },
    submissionDependencies,
  ),
  { kind: "submitted", transactionReference: HASH_A },
);
assert.deepEqual(
  await resolvePrivyDelegatedFundingSubmission(
    { user_operation_hash: HASH_B },
    submissionDependencies,
  ),
  { kind: "submitted", transactionReference: HASH_A },
);
assert.deepEqual(
  await resolvePrivyDelegatedFundingSubmission(
    { status: "provider_error" },
    submissionDependencies,
  ),
  { kind: "pending" },
  "a provider status without a transaction hash is not non-broadcast proof",
);
assert.deepEqual(
  await resolvePrivyDelegatedFundingSubmission(
    { reference_id: "attempt-1" },
    submissionDependencies,
  ),
  { kind: "pending" },
);
assert.deepEqual(
  selectPrivyDelegatedFundingReference(
    {
      transactions: [
        { reference_id: "other-attempt", transaction_hash: HASH_B },
        { reference_id: "attempt-1", transaction_hash: HASH_A },
      ],
    },
    "attempt-1",
  ),
  { reference_id: "attempt-1", transaction_hash: HASH_A },
);
assert.equal(
  selectPrivyDelegatedFundingReference(
    [{ reference_id: "other-attempt", transaction_hash: HASH_A }],
    "attempt-1",
  ),
  null,
  "recovery must never adopt another attempt's transaction",
);
assert.throws(
  () =>
    selectPrivyDelegatedFundingReference(
      [{ reference_id: "attempt-1" }, { reference_id: "attempt-1" }],
      "attempt-1",
    ),
  /duplicate transactions/u,
);

const knownSignerSpecs = polymarketKnownSignerSpecs(
  {
    PRIVY_WALLET_AUTHORIZATION_ID: "trade-signer",
    PRIVY_POLYMARKET_BOT_BUY_POLICY_ID: "buy-policy",
    PRIVY_POLYMARKET_BOT_SELL_POLICY_ID: "sell-policy",
  },
  { signerId: "wrap-signer", policyId: "wrap-policy" },
);
assert.equal(
  validateKnownPrivyWalletSigners({
    specs: knownSignerSpecs,
    signers: [
      { signerId: "trade-signer", overridePolicyIds: ["buy-policy"] },
      { signerId: "wrap-signer", overridePolicyIds: ["wrap-policy"] },
    ],
    requiredPurposes: ["polymarket_deposit_usdce_wrap"],
  }).valid,
  true,
);
for (const signers of [
  [{ signerId: "foreign", overridePolicyIds: ["foreign-policy"] }],
  [
    { signerId: "wrap-signer", overridePolicyIds: ["wrap-policy"] },
    { signerId: "wrap-signer", overridePolicyIds: ["wrap-policy"] },
  ],
  [{ signerId: "wrap-signer", overridePolicyIds: ["buy-policy"] }],
]) {
  assert.equal(
    validateKnownPrivyWalletSigners({
      specs: knownSignerSpecs,
      signers,
      requiredPurposes: ["polymarket_deposit_usdce_wrap"],
    }).valid,
    false,
  );
}

const authorizationPublicKey = derivePrivyAuthorizationPublicKey(
  AUTHORIZATION_PRIVATE_KEY,
);
const tradeQuorum = {
  authorizationPublicKeys: [authorizationPublicKey],
  authorizationThreshold: 1,
  id: "trade-signer",
  nestedKeyQuorumIds: [] as string[],
  userIds: [] as string[],
};
const tradePolicyFingerprint = knownPrivyPolicyFingerprint({
  chainType: "ethereum",
  id: "buy-policy",
  rules: [{ action: "ALLOW", method: "eth_sendTransaction" }],
});
const runtimeSignerSpecs = polymarketKnownSignerRuntimeSpecs(
  {
    PRIVY_WALLET_AUTHORIZATION_ID: "trade-signer",
    PRIVY_WALLET_AUTHORIZATION_KEY: AUTHORIZATION_PRIVATE_KEY,
    PRIVY_WALLET_AUTHORIZATION_FINGERPRINT:
      privyKeyQuorumFingerprint(tradeQuorum),
    PRIVY_POLYMARKET_BOT_BUY_POLICY_ID: "buy-policy",
    PRIVY_POLYMARKET_BOT_BUY_POLICY_FINGERPRINT: tradePolicyFingerprint,
  },
  {
    authorizationPublicKey,
    signerId: "wrap-signer",
    signerFingerprint: "a".repeat(64),
    policyId: "wrap-policy",
    policyFingerprint: "b".repeat(64),
  },
);
const tradeRuntimeSpec = runtimeSignerSpecs.find(
  (spec) => spec.purpose === "polymarket_trade",
);
assert.ok(tradeRuntimeSpec);
assert.equal(
  validateKnownPrivySignerRuntime({
    attachedPolicyId: "buy-policy",
    policyChainType: "ethereum",
    policyFingerprint: tradePolicyFingerprint,
    quorum: tradeQuorum,
    spec: tradeRuntimeSpec,
  }),
  true,
);
assert.equal(
  validateKnownPrivySignerRuntime({
    attachedPolicyId: "buy-policy",
    policyChainType: "ethereum",
    policyFingerprint: tradePolicyFingerprint,
    quorum: { ...tradeQuorum, authorizationThreshold: 2 },
    spec: tradeRuntimeSpec,
  }),
  false,
  "a known co-signer with quorum drift must fail closed",
);
assert.equal(
  validateKnownPrivySignerRuntime({
    attachedPolicyId: "buy-policy",
    policyChainType: "ethereum",
    policyFingerprint: "f".repeat(64),
    quorum: tradeQuorum,
    spec: tradeRuntimeSpec,
  }),
  false,
  "a known co-signer with policy drift must fail closed",
);
const incompleteRuntimeSignerSpecs = polymarketKnownSignerRuntimeSpecs(
  {
    PRIVY_WALLET_AUTHORIZATION_ID: "trade-signer",
    PRIVY_WALLET_AUTHORIZATION_KEY: AUTHORIZATION_PRIVATE_KEY,
    PRIVY_POLYMARKET_BOT_BUY_POLICY_ID: "buy-policy",
  },
  {
    authorizationPublicKey,
    signerId: "wrap-signer",
    signerFingerprint: "a".repeat(64),
    policyId: "wrap-policy",
    policyFingerprint: "b".repeat(64),
  },
);
assert.equal(
  validateKnownPrivyWalletSigners({
    specs: incompleteRuntimeSignerSpecs,
    signers: [
      { signerId: "trade-signer", overridePolicyIds: ["buy-policy"] },
      { signerId: "wrap-signer", overridePolicyIds: ["wrap-policy"] },
    ],
    requiredPurposes: ["polymarket_deposit_usdce_wrap"],
  }).valid,
  false,
  "an attached co-signer without complete runtime fingerprints must be unknown",
);

const configuredProfile = {
  enabled: true,
  profileId: POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  signerId: "signer_12345678",
  signerFingerprint: "a".repeat(64),
  policyId: "policy_12345678",
  policyFingerprint: "b".repeat(64),
} as const;
const activeFundingPolicy: FundingIntentPolicy = {
  version: 2,
  venues: ["polymarket"],
  receive: {
    assets: ["polygon:pusd", "polygon:usdce"],
    privy: false,
  },
  paused: false,
};
const resolvedFundingPolicy = (input: {
  policy?: FundingIntentPolicy;
  invalidStoredPolicy?: boolean;
}): ResolvedFundingPolicy => {
  const policy = input.policy ?? activeFundingPolicy;
  return {
    source: "db" as const,
    policy,
    runtime: compileFundingIntentPolicy(policy),
    revision: "test-revision",
    effectiveAt: null,
    createdAt: null,
    createdBy: null,
    invalidStoredPolicy: input.invalidStoredPolicy ?? false,
    validationIssues: [],
  };
};
assert.deepEqual(
  classifyPolymarketWrapControlPlane({
    configuration: configuredProfile,
    policy: resolvedFundingPolicy({}),
  }),
  { kind: "allowed" },
);
assert.deepEqual(
  classifyPolymarketWrapControlPlane({
    configuration: { ...configuredProfile, enabled: false },
    policy: resolvedFundingPolicy({}),
  }),
  { kind: "soft_paused", reasonCode: "delegated_execution_paused" },
);
assert.deepEqual(
  classifyPolymarketWrapControlPlane({
    configuration: configuredProfile,
    policy: resolvedFundingPolicy({
      policy: { ...activeFundingPolicy, paused: true },
    }),
  }),
  { kind: "soft_paused", reasonCode: "funding_policy_paused" },
);
assert.deepEqual(
  classifyPolymarketWrapControlPlane({
    configuration: configuredProfile,
    policy: resolvedFundingPolicy({
      policy: { ...activeFundingPolicy, venues: [], paused: true },
    }),
  }),
  { kind: "soft_paused", reasonCode: "funding_policy_paused" },
  "a paused replacement cannot hard-invalidate a route it temporarily omits",
);
assert.equal(
  fundingPolicyRevisionMayResume(
    resolvedFundingPolicy({
      policy: { ...activeFundingPolicy, paused: true },
    }),
  ),
  true,
  "a frozen revision mismatch remains resumable while the current policy is paused",
);
assert.equal(
  fundingPolicyRevisionMayResume(resolvedFundingPolicy({})),
  false,
  "an enabled replacement revision must not inherit old consent",
);
assert.deepEqual(
  classifyPolymarketWrapControlPlane({
    configuration: configuredProfile,
    policy: resolvedFundingPolicy({
      policy: { ...activeFundingPolicy, venues: [] },
    }),
  }),
  { kind: "hard_invalid", reasonCode: "delegated_route_changed" },
);
assert.deepEqual(
  combineDelegatedFundingDecisions(
    { kind: "soft_paused", reasonCode: "funding_policy_paused" },
    { kind: "hard_invalid", reasonCode: "delegated_authority_invalid" },
  ),
  { kind: "hard_invalid", reasonCode: "delegated_authority_invalid" },
  "hard-invalid authority must win over a simultaneous soft pause",
);
assert.equal(
  loadPolymarketWrapExecutionConfiguration({
    HUNCH_FINANCE_EXECUTE: "false",
    HUNCH_FUNDING_PM_WRAP_EXECUTE: "true",
  }).enabled,
  false,
);
assert.equal(
  loadPolymarketWrapExecutionConfiguration({
    HUNCH_FINANCE_EXECUTE: "true",
    HUNCH_FUNDING_PM_WRAP_EXECUTE: "true",
  }).enabled,
  true,
);
assert.equal(
  polymarketWrapExecutorEnvironmentReady({
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    PRIVY_POLYMARKET_WRAP_AUTHORIZATION_KEY: AUTHORIZATION_PRIVATE_KEY,
    CREDENTIALS_ENCRYPTION_KEY: "encryption",
    FUNDING_REFERENCE_LOOKUP_HMAC_KEY: "hmac",
    POLYMARKET_FUNDING_ROUTER_ADDRESS: POLYMARKET_FUNDING_ROUTER.polygon,
  }),
  true,
);
assert.equal(
  polymarketWrapExecutorEnvironmentReady({
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    PRIVY_POLYMARKET_WRAP_AUTHORIZATION_KEY: AUTHORIZATION_PRIVATE_KEY,
    CREDENTIALS_ENCRYPTION_KEY: "encryption",
    FUNDING_REFERENCE_LOOKUP_HMAC_KEY: "hmac",
  }),
  false,
  "a missing Funding Router address must soft-pause delegated routing",
);
assert.equal(
  polymarketWrapExecutorEnvironmentReady({
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    PRIVY_POLYMARKET_WRAP_AUTHORIZATION_KEY: AUTHORIZATION_PRIVATE_KEY,
    CREDENTIALS_ENCRYPTION_KEY: "encryption",
    FUNDING_REFERENCE_LOOKUP_HMAC_KEY: "hmac",
    POLYMARKET_FUNDING_ROUTER_ADDRESS:
      "0x0000000000000000000000000000000000000001",
  }),
  false,
  "delegated routing requires the exact immutable Funding Router",
);
assert.equal(
  polymarketWrapExecutorEnvironmentReady({
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
    PRIVY_POLYMARKET_WRAP_AUTHORIZATION_KEY: "malformed",
    CREDENTIALS_ENCRYPTION_KEY: "encryption",
    FUNDING_REFERENCE_LOOKUP_HMAC_KEY: "hmac",
    POLYMARKET_FUNDING_ROUTER_ADDRESS: POLYMARKET_FUNDING_ROUTER.polygon,
  }),
  false,
);
assert.deepEqual(
  resolvePrivyProfileInspectionFailure(new Error("Privy timeout"), false),
  { kind: "pending" },
  "transport failures do not prove that the durable provider call was absent",
);
assert.deepEqual(
  resolvePrivyProfileInspectionFailure(
    new PrivyDelegatedFundingProfileInvalidError("fingerprint changed"),
    false,
  ),
  {
    kind: "proven_nonbroadcast_failure",
    reasonCode: "delegated_profile_invalid",
  },
  "a completely fetched invalid profile can fail before sendTransaction",
);
assert.deepEqual(
  resolvePrivyProfileInspectionFailure(
    new PrivyDelegatedFundingProfileInvalidError("fingerprint changed"),
    true,
  ),
  { kind: "pending" },
  "profile invalidation cannot terminalize an already-crossed provider boundary",
);
{
  const driver = new PrivyDelegatedFundingDriver({
    appId: "app",
    appSecret: "secret",
    authorizationPrivateKey: AUTHORIZATION_PRIVATE_KEY,
    configuration: configuredProfile,
  });
  const internals = driver as unknown as {
    lookupByReference: () => Promise<null>;
    verifyLiveProfile: () => Promise<void>;
  };
  internals.verifyLiveProfile = async () => {
    throw new PrivyDelegatedFundingProfileInvalidError(
      "profile changed before provider submission",
    );
  };
  internals.lookupByReference = async () => null;
  const claim = {
    attemptId: "attempt_fresh_vs_recovery_12345678",
    walletAddress: "0x1111111111111111111111111111111111111111",
    privyWalletId: "privy-wallet-fresh-vs-recovery",
    policyFingerprint: configuredProfile.policyFingerprint,
    policyId: configuredProfile.policyId,
    signerFingerprint: configuredProfile.signerFingerprint,
    signerId: configuredProfile.signerId,
  } as never;
  assert.deepEqual(await driver.execute(claim), {
    kind: "proven_nonbroadcast_failure",
    reasonCode: "delegated_profile_invalid",
  });
  assert.deepEqual(
    await driver.recover(claim),
    { kind: "pending" },
    "recovery must stay ambiguous when a prior provider call may have occurred",
  );
}
assert.equal(
  createPrivyDelegatedFundingDriver({
    appId: "app",
    appSecret: "secret",
    authorizationPrivateKey: "malformed",
    configuration: configuredProfile,
  }),
  null,
  "a malformed sidecar key must disable delegated execution without crashing the worker",
);
assert.equal(
  polymarketWrapExecutorEnvironmentReady({
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
  }),
  false,
);
assert.equal(
  createPolymarketWrapDelegatedFundingProfile({
    configuration: { ...configuredProfile, enabled: false, signerId: "" },
    driver: {
      execute: async () => ({ kind: "ambiguous" }),
      recover: async () => ({ kind: "ambiguous" }),
    },
  }).profileId,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
  "execution OFF and a profile-ID rollback must leave recovery mounted",
);
assert.equal(
  createPolymarketWrapDelegatedFundingProfile({
    configuration: configuredProfile,
    driver: {
      execute: async () => ({ kind: "ambiguous" }),
      recover: async () => ({ kind: "ambiguous" }),
    },
  })?.profileId,
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
);

const compiled = compileFundingIntentPolicy({
  version: 2,
  venues: ["polymarket"],
  receive: { assets: ["polygon:pusd", "polygon:usdce"], privy: false },
  paused: false,
});
const polymarket = compiled.venues.find(
  (venue) => venue.venueId === "polymarket",
);
assert.ok(polymarket);
assert.equal(polymarket.delegatedExecutionEnabled, true);
assert.deepEqual(polymarket.delegatedPolicyIds, [
  POLYMARKET_DEPOSIT_USDCE_WRAP_PROFILE_ID,
]);
assert.equal(polymarket.delegatedDailyCapUsd, null);

console.log(
  "[funding-delegated-execution-tests] unlimited policy, exact full-receipt action, cursor authority, and V2 registry passed",
);
