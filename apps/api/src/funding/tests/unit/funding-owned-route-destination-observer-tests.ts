import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  ownedRouteSatisfiedAmount,
  OwnedRouteDestinationObserver,
  type OwnedRouteDestinationTarget,
} from "../../reconciliation/owned-route-destination-observer.js";

const target: OwnedRouteDestinationTarget = {
  operationId: "00000000-0000-4000-8000-000000000001",
  segmentId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  purpose: "trade_shortfall",
  marketId: "limitless:258338",
  venueBindingOptionId: "binding-option",
  destinationLocationId: "limitless-usdc-location",
  destinationAddress: "0x0000000000000000000000000000000000000004",
  asset: {
    networkId: "evm:8453",
    assetId: "0x0000000000000000000000000000000000000005",
    decimals: 6,
  },
  requestedRaw: "1000000",
  baselineRaw: "0",
  baselineRevision: "baseline-revision",
  providerRawStatus: "success",
  providerDestinationReferenceCount: 1,
  operationVersion: 4,
  operationState: {
    status: "in_progress",
    stage: "source_action",
  },
};

assert.equal(
  ownedRouteSatisfiedAmount({
    baselineRaw: "0",
    observedRaw: "1000000",
    requestedRaw: "1000000",
  }),
  "1000000",
);
assert.equal(
  ownedRouteSatisfiedAmount({
    baselineRaw: "0",
    observedRaw: "999999",
    requestedRaw: "1000000",
  }),
  null,
);
assert.equal(
  ownedRouteSatisfiedAmount({
    baselineRaw: "500000",
    observedRaw: "1500001",
    requestedRaw: "1000000",
  }),
  "1000000",
);

let persisted = 0;
const observer = new OwnedRouteDestinationObserver({
  loadTarget: async () => target,
  observe: async () => ({
    observedRaw: "1010102",
    revision: "destination-revision",
    observedAt: "2026-07-27T01:58:00.000Z",
  }),
  persist: async (_pool, input) => {
    assert.equal(input.target.segmentId, target.segmentId);
    assert.equal(input.target.providerRawStatus, "success");
    assert.equal(input.target.providerDestinationReferenceCount, 1);
    assert.equal(input.observation.observedRaw, "1010102");
    persisted += 1;
    return true;
  },
});
assert.equal(observer.observerId, "relay_owned_destination_observation_v1");
assert.deepEqual(await observer.pollOperation({} as Pool, target.operationId), {
  destinationsPolled: 1,
});
assert.equal(persisted, 1);

const waitingForObservation = new OwnedRouteDestinationObserver({
  loadTarget: async () => target,
  observe: async () => null,
  persist: async () => {
    throw new Error("an absent observation must not persist");
  },
});
assert.deepEqual(
  await waitingForObservation.pollOperation({} as Pool, target.operationId),
  { destinationsPolled: 1 },
);

const unrelated = new OwnedRouteDestinationObserver({
  loadTarget: async () => null,
});
assert.deepEqual(
  await unrelated.pollOperation({} as Pool, target.operationId),
  { destinationsPolled: 0 },
);

console.log(
  "[funding-owned-route-destination-observer-tests] exact balance delta and scoped polling passed",
);
