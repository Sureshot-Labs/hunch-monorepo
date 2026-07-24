import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  directIngressExactDelta,
  DirectIngressDestinationObserver,
  type DirectIngressObservationTarget,
} from "../../reconciliation/direct-ingress-observer.js";

const target: DirectIngressObservationTarget = {
  operationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  purpose: "add_funds",
  marketId: null,
  venueBindingOptionId: "binding-option",
  destinationLocationId: "location",
  destinationAddress: "0x0000000000000000000000000000000000000001",
  requestedAsset: {
    networkId: "evm:137",
    assetId: "0x0000000000000000000000000000000000000002",
    decimals: 6,
  },
  requestedRaw: "3000000",
  baselineRaw: "1000000",
  baselineRevision: "baseline-revision",
};

assert.equal(
  directIngressExactDelta({
    baselineRaw: "1000000",
    observedRaw: "4000000",
    requestedRaw: "3000000",
  }),
  "3000000",
);
assert.equal(
  directIngressExactDelta({
    baselineRaw: "1000000",
    observedRaw: "3999999",
    requestedRaw: "3000000",
  }),
  null,
);
assert.equal(
  directIngressExactDelta({
    baselineRaw: "1000000",
    observedRaw: "4000001",
    requestedRaw: "3000000",
  }),
  null,
);

let persisted = 0;
const observer = new DirectIngressDestinationObserver({
  loadTarget: async () => target,
  observe: async () => ({
    observedRaw: "4000000",
    revision: "observed-revision",
    observedAt: "2026-07-24T12:00:00.000Z",
  }),
  persist: async (_pool, input) => {
    assert.equal(input.target.operationId, target.operationId);
    assert.equal(input.observation.observedRaw, "4000000");
    persisted += 1;
    return true;
  },
});
const result = await observer.pollOperation({} as Pool, target.operationId);
assert.deepEqual(result, { destinationsPolled: 1 });
assert.equal(persisted, 1);

const unrelated = new DirectIngressDestinationObserver({
  loadTarget: async () => null,
});
assert.deepEqual(
  await unrelated.pollOperation({} as Pool, target.operationId),
  { destinationsPolled: 0 },
);

console.log(
  "[funding-direct-ingress-observer-tests] exact delta and scoped polling passed",
);
