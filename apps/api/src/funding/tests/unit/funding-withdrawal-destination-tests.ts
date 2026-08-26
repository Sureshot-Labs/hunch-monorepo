#!/usr/bin/env tsx

import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";

import { RELAY_PINNED_ASSETS } from "../../../funding-providers/relay/mappings.js";
import {
  DEFAULT_FUNDING_RUNTIME_POLICY,
  FUNDING_ROUTE_EXPERIENCE,
  FUNDING_TTL,
} from "../../policies/funding-policy.js";
import {
  compileFundingIntentPolicy,
  FUNDING_RECEIVE_ASSET_IDS,
  type FundingIntentPolicy,
} from "../../policies/funding-policy-v2.js";
import { createWithdrawalDestinationCodec } from "../../execution/withdrawal-destination-codec.js";
import {
  assertWithdrawalRecipientContract,
  classifyEvmWithdrawalAddressCode,
  inspectWithdrawalAddress,
  WithdrawalDestinationError,
  WithdrawalDestinationRuntime,
} from "../../execution/withdrawal-destination-runtime.js";
import {
  WITHDRAWAL_DESTINATION_CONTRACT_REVISION,
  WITHDRAWAL_DESTINATION_CONTRACT_VERSION,
  withWithdrawalPlanningContract,
} from "../../domain/withdrawal-contract.js";

const NOW = new Date("2026-07-24T12:00:00.000Z");
const ASSET = {
  networkId: "evm:137",
  assetId: RELAY_PINNED_ASSETS.polygonPusd,
  decimals: 6,
} as const;
const ADDRESS = "0x00000000000000000000000000000000000000A2";
const FINGERPRINT = "f".repeat(64);
const FULL_POLICY: FundingIntentPolicy = {
  version: 2,
  venues: ["polymarket", "limitless"],
  receive: { assets: [...FUNDING_RECEIVE_ASSET_IDS], privy: true },
  paused: false,
};

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

assert.doesNotThrow(() => assertWithdrawalRecipientContract(ASSET));
assert.throws(
  () =>
    assertWithdrawalRecipientContract({
      ...ASSET,
      assetId: "0x00000000000000000000000000000000000000a3",
    }),
  (error: unknown) =>
    error instanceof WithdrawalDestinationError &&
    error.code === "withdrawal_destination_unsupported",
);
assert.throws(
  () =>
    assertWithdrawalRecipientContract({
      networkId: "evm:137",
      assetId: RELAY_PINNED_ASSETS.polygonUsdc,
      decimals: 6,
    }),
  (error: unknown) =>
    error instanceof WithdrawalDestinationError &&
    error.code === "withdrawal_destination_unsupported",
);

const withdrawalPlanningPolicy = withWithdrawalPlanningContract(
  {
    ...DEFAULT_FUNDING_RUNTIME_POLICY,
    placement: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.placement,
      maximumFeeUsd: "0",
      maximumSlippageBps: 0,
    },
    routeExperience: {
      ...DEFAULT_FUNDING_RUNTIME_POLICY.routeExperience,
      minimumInlineObservationCount: 999,
    },
    ttl: { ...DEFAULT_FUNDING_RUNTIME_POLICY.ttl, quoteMs: 1 },
  },
  ASSET,
);
assert.equal(withdrawalPlanningPolicy.creationMode, "off");
assert.equal(withdrawalPlanningPolicy.gates.quoteCreation, false);
assert.deepEqual(withdrawalPlanningPolicy.assets, []);
assert.equal(
  withdrawalPlanningPolicy.locations.some(
    (location) =>
      location.locationPatternId === "wallet-base-usdc-v1" &&
      location.capabilities.includes("withdrawal_source"),
  ),
  true,
);
assert.deepEqual(
  withdrawalPlanningPolicy.placement,
  DEFAULT_FUNDING_RUNTIME_POLICY.placement,
);
assert.deepEqual(
  withdrawalPlanningPolicy.routeExperience,
  FUNDING_ROUTE_EXPERIENCE,
);
assert.deepEqual(withdrawalPlanningPolicy.ttl, FUNDING_TTL);
assert.equal(
  withdrawalPlanningPolicy.providers.some(
    (provider) =>
      provider.providerId === "relay" &&
      provider.enabledCapabilities.includes("cross_network_swap"),
  ),
  true,
);
assert.equal(
  withdrawalPlanningPolicy.routes.some(
    (route) =>
      route.routeId === "base-usdc-to-polygon-pusd" &&
      route.destinationLocationPatternId === "withdrawal-polygon-pusd-v1",
  ),
  true,
);

const activeWithdrawalPolicy = withWithdrawalPlanningContract(
  compileFundingIntentPolicy(FULL_POLICY),
  ASSET,
);
assert.equal(
  new Set(activeWithdrawalPolicy.routes.map((route) => route.routeId)).size,
  activeWithdrawalPolicy.routes.length,
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
assert.deepEqual(classifyEvmWithdrawalAddressCode("0x"), {
  addressKind: "evm_eoa",
  evidenceRevision:
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
});
assert.deepEqual(classifyEvmWithdrawalAddressCode("0x0"), {
  addressKind: "evm_eoa",
  evidenceRevision:
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
});
assert.deepEqual(classifyEvmWithdrawalAddressCode("0x6000"), {
  addressKind: "evm_contract",
  evidenceRevision:
    "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d",
});
await assert.rejects(
  inspectWithdrawalAddress({
    networkId: "solana:mainnet",
    address: "11111111111111111111111111111111",
  }),
  (error: unknown) =>
    error instanceof WithdrawalDestinationError &&
    error.code === "withdrawal_destination_invalid",
);

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
        policyRevision: WITHDRAWAL_DESTINATION_CONTRACT_REVISION,
        validatedAt: NOW.toISOString(),
      },
      policyVersion: WITHDRAWAL_DESTINATION_CONTRACT_VERSION,
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
  "[funding-withdrawal-destination-tests] code-owned asset contract, policy-independent Relay planning, encrypted opaque registration, address guards, and owner-scoped resolution passed",
);
