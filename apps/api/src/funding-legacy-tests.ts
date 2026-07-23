#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  classifyLegacyBridgeAdapter,
  legacyBridgeCreationAllowed,
  LEGACY_BRIDGE_ADAPTER_VERSIONS,
  resolveLegacyBridgeReconciler,
  resolveLegacyCreationAdapterVersion,
} from "./funding/legacy/bridge-adapter-classifier.js";

const fixtures = [
  {
    expected: "across_swap_api_v1",
    input: {
      provider: "across",
      swapType: "cross_chain",
      orderId: null,
      metadata: { across: { providerPayload: { swapTx: null } } },
    },
  },
  {
    expected: "across_suggested_fees_v1",
    input: {
      provider: "across",
      swapType: "cross_chain",
      orderId: null,
      metadata: { across: { providerPayload: { capitalFeePct: "0.1" } } },
    },
  },
  {
    expected: "debridge_dln_create_tx_v1",
    input: {
      provider: "debridge",
      swapType: "cross_chain",
      orderId: "order-1",
      metadata: { estimation: {} },
    },
  },
  {
    expected: "debridge_same_chain_v1",
    input: {
      provider: "debridge",
      swapType: "same_chain",
      orderId: null,
      metadata: { tokenIn: {}, tokenOut: {}, tx: {} },
    },
  },
  {
    expected: "debridge_same_chain_tx_v0",
    input: {
      provider: "debridge",
      swapType: "same_chain",
      orderId: null,
      metadata: { estimation: null, tx: {} },
    },
  },
  {
    expected: "bungee_legacy_v1",
    input: {
      provider: "bungee",
      swapType: "cross_chain",
      orderId: null,
      metadata: null,
    },
  },
] as const;

for (const fixture of fixtures) {
  assert.equal(classifyLegacyBridgeAdapter(fixture.input), fixture.expected);
}

assert.equal(
  classifyLegacyBridgeAdapter({
    provider: "debridge",
    swapType: "cross_chain",
    orderId: null,
    metadata: {},
  }),
  null,
);
assert.equal(
  resolveLegacyCreationAdapterVersion({
    provider: "debridge",
    swapType: "same_chain",
  }),
  "debridge_same_chain_v1",
);
assert.throws(
  () =>
    resolveLegacyCreationAdapterVersion({
      provider: "across",
      swapType: "cross_chain",
      providerPayload: {},
    }),
  /unclassifiable Across/,
);

for (const version of LEGACY_BRIDGE_ADAPTER_VERSIONS) {
  assert.ok(resolveLegacyBridgeReconciler(version));
  assert.equal(legacyBridgeCreationAllowed(version), false);
}
assert.equal(resolveLegacyBridgeReconciler("unknown_v99"), null);

console.log(
  `[funding-legacy-tests] passed ${fixtures.length + 5}/${fixtures.length + 5}`,
);
