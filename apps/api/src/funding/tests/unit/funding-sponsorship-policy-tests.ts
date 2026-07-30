#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { ExistingFactsOwnershipResolver } from "../../../account-value/ownership-resolver.js";
import type {
  EvmTransactionAction,
  EvmTransactionBatchAction,
  SvmTransactionAction,
  WalletExecutionProfile,
} from "../../domain/types.js";
import {
  PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
  resolveActionSponsorship,
} from "../../execution/sponsorship-policy.js";

const ACTION: EvmTransactionAction = {
  kind: "evm_transaction",
  actionId: "action_sponsorship_12345678",
  networkId: "evm:137",
  senderWalletId: "wallet_sponsorship_12345678",
  to: "0x0000000000000000000000000000000000000001",
  data: "0x",
  valueRaw: "0",
  gasLimitRaw: "21000",
};
const BATCH_ACTION: EvmTransactionBatchAction = {
  kind: "evm_transaction_batch",
  actionId: "action_batch_sponsorship_12345678",
  networkId: ACTION.networkId,
  senderWalletId: ACTION.senderWalletId,
  calls: [
    {
      actionId: ACTION.actionId,
      to: ACTION.to,
      data: ACTION.data,
      valueRaw: ACTION.valueRaw,
    },
    {
      actionId: "action_batch_call_2_12345678",
      to: "0x0000000000000000000000000000000000000003",
      data: "0x1234",
      valueRaw: "0",
    },
  ],
};
const SVM_ACTION: SvmTransactionAction = {
  kind: "svm_transaction",
  actionId: "action_svm_sponsorship_12345678",
  networkId: "solana:mainnet",
  signerWalletId: "wallet_svm_sponsorship_12345678",
  instructions: [
    {
      programId: "11111111111111111111111111111111",
      accounts: [],
      data: "",
      dataEncoding: "hex",
    },
  ],
  addressLookupTables: [],
};

function profile(
  overrides: Partial<WalletExecutionProfile> = {},
): WalletExecutionProfile {
  return {
    walletId: ACTION.senderWalletId,
    networkId: ACTION.networkId,
    address: "0x0000000000000000000000000000000000000002",
    source: "embedded",
    signingModes: ["web_client", "privy_authorization"],
    serverWalletRef: "privy_wallet_12345678",
    sponsorshipPolicyIds: [PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID],
    ...overrides,
  };
}

assert.deepEqual(
  resolveActionSponsorship({ action: ACTION, profile: profile() }),
  {
    payerRequirement: "privy_sponsor",
    policyId: PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
    signingMode: "privy_authorization",
  },
);
assert.deepEqual(
  resolveActionSponsorship({
    action: BATCH_ACTION,
    profile: profile({
      evmAtomicBatchMode: "privy_wallet_send_calls",
    }),
  }),
  {
    payerRequirement: "privy_sponsor",
    policyId: PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
    signingMode: "privy_authorization",
  },
);
assert.throws(
  () =>
    resolveActionSponsorship({
      action: BATCH_ACTION,
      profile: profile(),
    }),
  /cannot execute an atomic EVM batch/,
);

assert.deepEqual(
  resolveActionSponsorship({
    action: ACTION,
    profile: profile({
      source: "external",
      signingModes: ["web_client"],
      serverWalletRef: null,
    }),
  }),
  {
    payerRequirement: "user",
    policyId: null,
    signingMode: "web_client",
  },
);

assert.deepEqual(
  resolveActionSponsorship({
    action: ACTION,
    profile: profile({ sponsorshipPolicyIds: [] }),
  }),
  {
    payerRequirement: "user",
    policyId: null,
    signingMode: "web_client",
  },
);
assert.deepEqual(
  resolveActionSponsorship({
    action: SVM_ACTION,
    profile: profile({
      walletId: SVM_ACTION.signerWalletId,
      networkId: SVM_ACTION.networkId,
      address: "11111111111111111111111111111111",
      sponsorshipPolicyIds: [],
    }),
  }),
  {
    payerRequirement: "user",
    policyId: null,
    signingMode: "privy_authorization",
  },
);
assert.deepEqual(
  resolveActionSponsorship({
    action: SVM_ACTION,
    profile: profile({
      walletId: SVM_ACTION.signerWalletId,
      networkId: SVM_ACTION.networkId,
      address: "11111111111111111111111111111111",
      source: "external",
      signingModes: ["web_client"],
      serverWalletRef: null,
      sponsorshipPolicyIds: [],
    }),
  }),
  {
    payerRequirement: "user",
    policyId: null,
    signingMode: "web_client",
  },
);
for (const incompleteProfile of [
  profile({
    walletId: SVM_ACTION.signerWalletId,
    networkId: SVM_ACTION.networkId,
    address: "11111111111111111111111111111111",
    serverWalletRef: null,
    sponsorshipPolicyIds: [],
  }),
  profile({
    walletId: SVM_ACTION.signerWalletId,
    networkId: SVM_ACTION.networkId,
    address: "11111111111111111111111111111111",
    signingModes: ["web_client"],
    sponsorshipPolicyIds: [],
  }),
]) {
  assert.deepEqual(
    resolveActionSponsorship({
      action: SVM_ACTION,
      profile: incompleteProfile,
    }),
    {
      payerRequirement: "user",
      policyId: null,
      signingMode: "web_client",
    },
  );
}

assert.throws(
  () =>
    resolveActionSponsorship({
      action: { ...ACTION, gasLimitRaw: "3000001" },
      profile: profile(),
    }),
  /outside policy/,
);
assert.throws(
  () =>
    resolveActionSponsorship({
      action: ACTION,
      profile: profile({ networkId: "evm:8453" }),
    }),
  /exact action signer and network/,
);

const ownership = await new ExistingFactsOwnershipResolver({
  wallets: [
    {
      address: "0x0000000000000000000000000000000000000002",
      walletType: "ethereum",
      source: "embedded",
      linkedAddress: "0x0000000000000000000000000000000000000002",
      serverWalletRef: "privy_wallet_internal_12345678",
    },
    {
      address: "0x0000000000000000000000000000000000000003",
      walletType: "ethereum",
      source: "external",
      linkedAddress: "0x0000000000000000000000000000000000000003",
      serverWalletRef: null,
    },
    {
      address: "11111111111111111111111111111111",
      walletType: "solana",
      source: "embedded",
      linkedAddress: "11111111111111111111111111111111",
      serverWalletRef: "privy_solana_internal_12345678",
    },
  ],
  venueBindings: [],
}).resolve("account_sponsorship_12345678");

const internalEvm = ownership.wallets.filter(
  (wallet) =>
    wallet.source === "embedded" && wallet.networkId.startsWith("evm:"),
);
assert.equal(internalEvm.length, 2);
assert.ok(
  internalEvm.every((wallet) =>
    wallet.sponsorshipPolicyIds.includes(
      PRIVY_USER_AUTHORIZED_EVM_SPONSORSHIP_POLICY_ID,
    ),
  ),
);
assert.ok(
  ownership.wallets
    .filter(
      (wallet) =>
        wallet.source === "external" || wallet.networkId === "solana:mainnet",
    )
    .every((wallet) => wallet.sponsorshipPolicyIds.length === 0),
);

console.log(
  "[funding-sponsorship-policy-tests] exact signing custody, sponsorship, and mutation guards passed",
);
