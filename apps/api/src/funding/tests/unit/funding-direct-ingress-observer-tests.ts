import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  directIngressSatisfiedAmount,
  DirectIngressDestinationObserver,
  parseDirectIngressObservationVariant,
  selectDirectIngressVariant,
  type DirectIngressObservationTarget,
} from "../../reconciliation/direct-ingress-observer.js";

const target: DirectIngressObservationTarget = {
  operationId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  purpose: "add_funds",
  marketId: null,
  venueBindingOptionId: "binding-option",
  requestedAsset: {
    networkId: "evm:137",
    assetId: "0x0000000000000000000000000000000000000002",
    decimals: 6,
  },
  requestedRaw: "3000000",
  operationVersion: 1,
  operationState: {
    status: "awaiting_external_funds",
    stage: "source_action",
  },
  variants: [
    {
      variantId: "variant-pusd",
      networkId: "evm:137",
      asset: {
        networkId: "evm:137",
        assetId: "0x0000000000000000000000000000000000000002",
        decimals: 6,
      },
      destinationLocationId: "location",
      destinationAddress: "0x0000000000000000000000000000000000000001",
      baselineRaw: "1000000",
      baselineRevision: "baseline-revision",
      observation: {
        adapterId: "owned_destination_spendability_v1",
        payload: {},
      },
      completion: { kind: "direct_destination_credit" },
    },
  ],
};

const retainedSolVariant = {
  ...target.variants[0],
  networkId: "solana:mainnet",
  asset: {
    networkId: "solana:mainnet",
    assetId: "11111111111111111111111111111111",
    decimals: 9,
  },
  destinationAddress: "11111111111111111111111111111111",
  completion: { kind: "retained_owned_source_credit" },
};
assert.equal(
  parseDirectIngressObservationVariant(retainedSolVariant).completion.kind,
  "retained_owned_source_credit",
);
assert.throws(
  () =>
    parseDirectIngressObservationVariant({
      ...retainedSolVariant,
      asset: {
        networkId: "solana:mainnet",
        assetId: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        decimals: 6,
      },
    }),
  /limited to native SOL/u,
);

assert.equal(
  directIngressSatisfiedAmount({
    baselineRaw: "1000000",
    observedRaw: "4000000",
    requestedRaw: "3000000",
  }),
  "3000000",
);
assert.equal(
  directIngressSatisfiedAmount({
    baselineRaw: "1000000",
    observedRaw: "3999999",
    requestedRaw: "3000000",
  }),
  null,
);
assert.equal(
  directIngressSatisfiedAmount({
    baselineRaw: "1000000",
    observedRaw: "4000001",
    requestedRaw: "3000000",
  }),
  "3000000",
);

const pusdVariant = target.variants[0];
assert.ok(pusdVariant);
const usdceVariant = {
  ...pusdVariant,
  variantId: "variant-usdce",
  asset: {
    networkId: "evm:137",
    assetId: "0x0000000000000000000000000000000000000003",
    decimals: 6,
  },
  baselineRaw: "500000",
  observation: {
    adapterId: "polymarket_deposit_wallet_assets_v1",
    payload: { field: "depositUsdceRaw" },
  },
  completion: {
    kind: "committed_venue_preparation" as const,
    stepOrdinal: 0,
  },
};
const twoVariants = [...target.variants, usdceVariant];
const usdceSelection = selectDirectIngressVariant({
  variants: twoVariants,
  requestedRaw: "3000000",
  observations: [
    {
      variantId: "variant-pusd",
      observedRaw: "1000000",
      revision: "revision-1",
      observedAt: "2026-07-24T12:00:00.000Z",
    },
    {
      variantId: "variant-usdce",
      observedRaw: "3500000",
      revision: "revision-1",
      observedAt: "2026-07-24T12:00:00.000Z",
    },
  ],
});
assert.equal(usdceSelection.kind, "satisfied");
if (usdceSelection.kind === "satisfied") {
  assert.equal(usdceSelection.variant.variantId, "variant-usdce");
}
assert.deepEqual(
  selectDirectIngressVariant({
    variants: twoVariants,
    requestedRaw: "3000000",
    observations: [
      {
        variantId: "variant-pusd",
        observedRaw: "1000001",
        revision: "revision-2",
        observedAt: "2026-07-24T12:00:01.000Z",
      },
      {
        variantId: "variant-usdce",
        observedRaw: "3500000",
        revision: "revision-2",
        observedAt: "2026-07-24T12:00:01.000Z",
      },
    ],
  }),
  {
    kind: "ambiguous",
    positiveVariantIds: ["variant-pusd", "variant-usdce"],
  },
);

let persisted = 0;
const observer = new DirectIngressDestinationObserver({
  loadTarget: async () => target,
  observe: async () => ({
    variants: [
      {
        variantId: "variant-pusd",
        observedRaw: "4000000",
        revision: "observed-revision",
        observedAt: "2026-07-24T12:00:00.000Z",
      },
    ],
  }),
  persist: async (_pool, input) => {
    assert.equal(input.target.operationId, target.operationId);
    assert.equal(input.observation.variants[0]?.observedRaw, "4000000");
    persisted += 1;
    return true;
  },
});
const result = await observer.pollOperation({} as Pool, target.operationId);
assert.deepEqual(result, {
  destinationsPolled: 1,
  destinationSatisfied: true,
});
assert.equal(persisted, 1);

let adapterObserved = 0;
const adapterDriven = new DirectIngressDestinationObserver({
  loadTarget: async () => target,
  observationAdapters: [
    {
      adapterId: "owned_destination_spendability_v1",
      observe: async (_pool, _target, variants) => {
        adapterObserved += 1;
        return variants.map((variant) => ({
          variantId: variant.variantId,
          observedRaw: "4000000",
          revision: "adapter-revision",
          observedAt: "2026-07-24T12:00:02.000Z",
        }));
      },
    },
  ],
  persist: async () => true,
});
assert.deepEqual(
  await adapterDriven.pollOperation({} as Pool, target.operationId),
  { destinationsPolled: 1, destinationSatisfied: true },
);
assert.equal(adapterObserved, 1);

const unrelated = new DirectIngressDestinationObserver({
  loadTarget: async () => null,
});
assert.deepEqual(
  await unrelated.pollOperation({} as Pool, target.operationId),
  { destinationsPolled: 0, destinationSatisfied: false },
);

console.log(
  "[funding-direct-ingress-observer-tests] variant minimum delta, pluggable observer adapter, and scoped polling passed",
);
