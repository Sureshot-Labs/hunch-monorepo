#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { ExistingFactsOwnershipResolver } from "../../../account-value/ownership-resolver.js";
import type {
  EvmTransactionAction,
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
  "[funding-sponsorship-policy-tests] exact internal EVM sponsorship and mutation guards passed",
);
