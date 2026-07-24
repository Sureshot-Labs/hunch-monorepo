#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";

import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  type FundingRuntimePolicy,
} from "../../policies/funding-policy.js";
import { createWithdrawalDestinationCodec } from "../../execution/withdrawal-destination-codec.js";
import {
  assertWithdrawalRecipientPolicy,
  inspectWithdrawalAddress,
  WithdrawalDestinationError,
  WithdrawalDestinationRuntime,
} from "../../execution/withdrawal-destination-runtime.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const ASSET = {
  networkId: "evm:137",
  assetId: "0x00000000000000000000000000000000000000a1",
  decimals: 6,
} as const;
const ADDRESS = "0x00000000000000000000000000000000000000A2";
const FINGERPRINT = "f".repeat(64);

function enabledPolicy(): FundingRuntimePolicy {
  const policy = structuredClone(
    DEFAULT_FUNDING_RUNTIME_POLICY,
  ) as FundingRuntimePolicy;
  return {
    ...policy,
    creationMode: "on",
    gates: {
      ...policy.gates,
      withdrawalExecution: true,
      withdrawalRegistration: true,
    },
    assets: [
      {
        asset: ASSET,
        enabled: true,
        observationEnabled: true,
        valuationEnabled: false,
        pricePolicyId: null,
      },
    ],
    locations: [
      {
        locationPatternId: "polygon_external_recipient_v1",
        locationKind: "wallet",
        asset: ASSET,
        ownership: "external_recipient",
        observable: false,
        capabilities: [],
        enabled: true,
      },
    ],
  };
}

const codec = createWithdrawalDestinationCodec({
  encryptionKey: Buffer.alloc(32, 7),
  lookupHmacKey: "lookup-key-for-withdrawal-tests-1234567890",
  keyVersion: 3,
});
const ciphertext = codec.encrypt(ADDRESS);
assert.equal(codec.decrypt(ciphertext), ADDRESS);
assert.equal(codec.fingerprint(ADDRESS), codec.fingerprint(` ${ADDRESS} `));
assert.notEqual(
  codec.fingerprint(ADDRESS),
  codec.fingerprint(ADDRESS.toLowerCase()),
);

assert.throws(
  () =>
    assertWithdrawalRecipientPolicy(
      DEFAULT_FUNDING_RUNTIME_POLICY,
      ASSET,
      "withdrawalRegistration",
    ),
  (error: unknown) =>
    error instanceof WithdrawalDestinationError &&
    error.code === "withdrawal_destination_policy_disabled",
);
assert.doesNotThrow(() =>
  assertWithdrawalRecipientPolicy(
    enabledPolicy(),
    ASSET,
    "withdrawalRegistration",
  ),
);
assert.throws(
  () =>
    assertWithdrawalRecipientPolicy(
      enabledPolicy(),
      { ...ASSET, assetId: "0x00000000000000000000000000000000000000a3" },
      "withdrawalRegistration",
    ),
  (error: unknown) =>
    error instanceof WithdrawalDestinationError &&
    error.code === "withdrawal_destination_unsupported",
);

await assert.rejects(
  inspectWithdrawalAddress({
    networkId: "evm:137",
    address: "0x0000000000000000000000000000000000000000",
  }),
  (error: unknown) =>
    error instanceof WithdrawalDestinationError &&
    error.code === "withdrawal_destination_invalid",
);
await assert.rejects(
  inspectWithdrawalAddress({
    networkId: "solana:mainnet",
    address: "11111111111111111111111111111111",
  }),
  (error: unknown) =>
    error instanceof WithdrawalDestinationError &&
    error.code === "withdrawal_destination_invalid",
);

const resolvedPolicy = {
  source: "db" as const,
  policy: enabledPolicy(),
  revision: "withdrawal_policy_revision_12345678",
  effectiveAt: NOW,
  createdAt: NOW,
  createdBy: "test",
  invalidStoredPolicy: false,
  validationIssues: [],
};
let persistedUserId: string | null = null;
let persistedCiphertext: string | null = null;
const runtimeCodec = {
  keyVersion: 1,
  encrypt: (address: string) => `enc:${address}`,
  decrypt: (value: string) => value.slice("enc:".length),
  fingerprint: () => FINGERPRINT,
};
const runtime = new WithdrawalDestinationRuntime({} as Pool, {
  codec: runtimeCodec,
  now: () => NOW,
  inspectAddress: async () => ({
    normalizedAddress: ADDRESS,
    addressKind: "evm_eoa",
    evidenceRevision: "code_hash_12345678",
  }),
  resolvePolicy: async () => resolvedPolicy,
  registerDestination: async (_, input) => {
    persistedUserId = input.userId;
    persistedCiphertext = input.addressCiphertext;
    return {
      replayed: false,
      destination: {
        id: "recipient_withdrawal_12345678",
        userId: input.userId,
        networkId: input.networkId,
        assetId: input.assetId,
        assetDecimals: input.assetDecimals,
        addressCiphertext: input.addressCiphertext,
        addressLookupHmac: input.addressLookupHmac,
        lookupKeyVersion: input.lookupKeyVersion,
        validationEvidence: input.validationEvidence,
        policyVersion: input.policyVersion,
        expiresAt: input.expiresAt,
        revokedAt: null,
        revocationReason: null,
      },
    };
  },
});
const registered = await runtime.register("account_withdrawal_12345678", {
  asset: ASSET,
  address: ADDRESS.toLowerCase(),
});
assert.equal(persistedUserId, "account_withdrawal_12345678");
assert.equal(persistedCiphertext, `enc:${ADDRESS}`);
assert.equal(registered.recipientId, "recipient_withdrawal_12345678");
assert.equal(registered.safeAddress, "0x000000…0000A2");
assert.equal(JSON.stringify(registered).includes(ADDRESS), false);

const resolved = await new WithdrawalDestinationRuntime({} as Pool, {
  codec: runtimeCodec,
  now: () => NOW,
  resolvePolicy: async () => resolvedPolicy,
  fetchDestination: async (_, input) => {
    assert.equal(input.userId, "account_withdrawal_12345678");
    return {
      id: input.destinationId,
      userId: input.userId,
      networkId: ASSET.networkId,
      assetId: ASSET.assetId,
      assetDecimals: ASSET.decimals,
      addressCiphertext: `enc:${ADDRESS}`,
      addressLookupHmac: FINGERPRINT,
      lookupKeyVersion: 1,
      validationEvidence: {
        policyRevision: resolvedPolicy.revision,
        validatedAt: NOW.toISOString(),
      },
      policyVersion: 1,
      expiresAt: new Date(NOW.getTime() + 60_000),
      revokedAt: null,
      revocationReason: null,
    };
  },
}).resolve("account_withdrawal_12345678", "recipient_withdrawal_12345678");
assert.equal(resolved.accountId, "account_withdrawal_12345678");
assert.equal(resolved.address, ADDRESS);
assert.equal(resolved.addressFingerprint, FINGERPRINT);

console.log(
  "[funding-withdrawal-destination-tests] exact policy gate, encrypted opaque registration, address guards, and owner-scoped resolution passed",
);
