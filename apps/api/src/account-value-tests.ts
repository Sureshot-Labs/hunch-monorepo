#!/usr/bin/env tsx

import assert from "node:assert/strict";
import { BN, BorshAccountsCoder } from "@coral-xyz/anchor";
import { IDL as PYTH_SOLANA_RECEIVER_IDL } from "@pythnetwork/pyth-solana-receiver/idl/pyth_solana_receiver";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import {
  projectAccountValue,
  resolveEffectiveHeadline,
} from "./account-value/account-value-projector.js";
import {
  rankAssetsForSuggestion,
  type StoredAssetFundingPreference,
} from "./account-value/asset-preferences.js";
import {
  deduplicateObservedAssets,
  deduplicatePositionComponents,
} from "./account-value/canonical.js";
import { projectCashAvailability } from "./account-value/cash-availability-projector.js";
import {
  addUnsignedDecimals,
  multiplyRawByUnitPrice,
  scaleUnsignedDecimalByRawRatio,
  subtractUnsignedDecimals,
} from "./account-value/decimal.js";
import {
  ExactStablePriceAdapter,
  PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE,
  PYTH_SOL_USD_PRICE_POLICY_ID,
  resolveStableImpairmentState,
  ValuationService,
} from "./account-value/valuation-service.js";
import {
  estimatePositionUsdFromExactText,
  readResolvedPositionProbability,
} from "./account-value/position-value-collectors.js";
import { ExistingFactsOwnershipResolver } from "./account-value/ownership-resolver.js";
import { createAccountValueSnapshotLoader } from "./account-value/snapshot-loader.js";
import {
  decodePythSolUsdPrice,
  PythSolUsdPriceAdapter,
  PYTH_SOLANA_RECEIVER_PROGRAM_ID,
  PYTH_SOL_USD_ACCOUNT,
  PYTH_SOL_USD_FEED_ID,
  type PythSolUsdCacheFence,
  type PythSolUsdLastKnownStore,
  type PythSolUsdPriceRecord,
} from "./account-value/pyth-sol-usd-price-adapter.js";
import { createPythSolUsdLastKnownStore } from "./account-value/pyth-sol-usd-last-known-store.js";
import type { PriceAdapter } from "./funding/domain/contracts.js";
import type {
  AssetLocation,
  AssetRef,
  ObservedAsset,
  ValuedAssetComponent,
  ValuedPositionComponent,
} from "./funding/domain/types.js";
import { DEFAULT_FUNDING_RUNTIME_POLICY } from "./funding/policies/funding-policy.js";
import {
  registerAccountValueRoutes,
  type AccountValueRouteDependencies,
} from "./routes/account-value.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const PYTH_FIXTURE_NOW = new Date("2026-08-24T23:48:00.000Z");
const PYTH_SOL_USD_FIXTURE = Buffer.from(
  "IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1baZJnEsCAAAAX/FdAAAAAAD4////H9iMagAAAAAe2IxqAAAAAJDdWEYCAAAABqdDAAAAAABH11AaAAAAAAA=",
  "base64",
);
const pythFixtureCoder = new BorshAccountsCoder(PYTH_SOLANA_RECEIVER_IDL);

async function mutatePythFixture(
  mutate: (priceMessage: {
    conf: BN;
    exponent: number;
    price: BN;
    publishTime: BN;
  }) => void,
): Promise<Buffer> {
  const decoded = pythFixtureCoder.decode(
    "priceUpdateV2",
    PYTH_SOL_USD_FIXTURE,
  ) as {
    priceMessage: { conf: BN; exponent: number; price: BN; publishTime: BN };
  };
  mutate(decoded.priceMessage);
  return pythFixtureCoder.encode("priceUpdateV2", decoded);
}
const USDC: AssetRef = {
  networkId: "evm:137",
  assetId: "0x0000000000000000000000000000000000000001",
  decimals: 6,
};

function location(
  id: string,
  details: Record<string, string> = {},
): AssetLocation {
  return {
    kind: "wallet",
    locationId: `location_${id.padEnd(8, "0")}`,
    accountId: "account_00000001",
    asset: USDC,
    details: {
      address: "0x00000000000000000000000000000000000000aa",
      ...details,
    },
  };
}

function observation(inputs: {
  id: string;
  raw?: string;
  observedAt?: string;
  location?: AssetLocation;
}): ObservedAsset {
  const resolvedLocation = inputs.location ?? location(inputs.id);
  return {
    componentId: `asset_${inputs.id.padEnd(8, "0")}`,
    location: resolvedLocation,
    amount: { asset: USDC, raw: inputs.raw ?? "1000000" },
    ownershipEvidenceId: `evidence_${inputs.id.padEnd(8, "0")}`,
    observedAt: inputs.observedAt ?? NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    metadataRisk: "verified",
  };
}

async function valuedAsset(inputs: {
  id: string;
  raw?: string;
  category?: "cash" | "token" | "in_transit";
  details?: Record<string, string>;
  executionEligibility?: ValuedAssetComponent["executionEligibility"];
}): Promise<ValuedAssetComponent> {
  const stableStates = new Map([
    [
      "evm:137:0x0000000000000000000000000000000000000001:6",
      {
        status: "healthy" as const,
      },
    ],
  ]);
  const service = new ValuationService({
    policies: [
      {
        asset: USDC,
        category: inputs.category ?? "cash",
        pricePolicyId: "exact-stable-policy-v1",
        maximumObservationAgeMs: 60_000,
        executionEligibility: inputs.executionEligibility ?? "unknown",
      },
    ],
    adapters: [new ExactStablePriceAdapter(stableStates)],
    stableStates,
  });
  const [component] = await service.value(
    [
      observation({
        id: inputs.id,
        raw: inputs.raw,
        location: location(inputs.id, inputs.details),
      }),
    ],
    NOW,
  );
  if (!component) throw new Error("valued fixture missing");
  return component;
}

async function test(name: string, fn: () => Promise<void> | void) {
  await fn();
  console.log(`[account-value-tests] ok ${name}`);
}

await test("decimal arithmetic never depends on JavaScript floating point", () => {
  assert.equal(
    addUnsignedDecimals(["0.1", "0.2", "1000000000000000000.000001"]),
    "1000000000000000000.300001",
  );
  assert.equal(
    multiplyRawByUnitPrice({
      raw: "1234567",
      decimals: 6,
      unitPriceUsd: "0.9995",
    }),
    "1.2339497165",
  );
  assert.equal(subtractUnsignedDecimals("1", "0.3333"), "0.6667");
  assert.equal(
    scaleUnsignedDecimalByRawRatio({
      value: "25",
      numeratorRaw: "80",
      denominatorRaw: "100",
    }),
    "20",
  );
});

await test("official Pyth decoder validates the pinned SOL/USD contract", async () => {
  const decoded = decodePythSolUsdPrice({
    data: PYTH_SOL_USD_FIXTURE,
    owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    now: PYTH_FIXTURE_NOW,
  });
  assert.deepEqual(decoded, {
    unitPriceUsd: "98.58468262",
    asOf: "2026-08-24T23:47:43.000Z",
    confidence: "high",
  });
  assert.throws(() =>
    decodePythSolUsdPrice({
      data: PYTH_SOL_USD_FIXTURE,
      owner: "11111111111111111111111111111111",
      now: PYTH_FIXTURE_NOW,
    }),
  );
  assert.throws(() =>
    decodePythSolUsdPrice({
      data: PYTH_SOL_USD_FIXTURE,
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      now: new Date("2026-08-24T23:49:00.000Z"),
    }),
  );
  assert.throws(() =>
    decodePythSolUsdPrice({
      data: PYTH_SOL_USD_FIXTURE,
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      now: new Date("2026-08-24T23:47:00.000Z"),
    }),
  );
  assert.throws(() =>
    decodePythSolUsdPrice({
      data: Buffer.from([1, 2, 3]),
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      now: PYTH_FIXTURE_NOW,
    }),
  );
  for (const data of [
    await mutatePythFixture((message) => {
      message.price = new BN(0);
    }),
    await mutatePythFixture((message) => {
      message.price = new BN(-1);
    }),
    await mutatePythFixture((message) => {
      message.exponent = -19;
    }),
    await mutatePythFixture((message) => {
      message.conf = message.price.div(new BN(10));
    }),
  ]) {
    assert.throws(() =>
      decodePythSolUsdPrice({
        data,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
        now: PYTH_FIXTURE_NOW,
      }),
    );
  }
});

function pythFenceGeneration(index: number): string {
  return index.toString(16).padStart(32, "0");
}

function copyPythFence(fence: PythSolUsdCacheFence): PythSolUsdCacheFence {
  return {
    ...fence,
    price: fence.price ? { ...fence.price } : null,
  };
}

function pythPublishSeconds(price: PythSolUsdPriceRecord): bigint {
  return BigInt(Math.floor(Date.parse(price.asOf) / 1_000));
}

function createInMemoryPythStore(): Readonly<{
  snapshot: () => PythSolUsdCacheFence;
  store: PythSolUsdLastKnownStore;
}> {
  let generationIndex = 1;
  let fence: PythSolUsdCacheFence = {
    generation: pythFenceGeneration(generationIndex),
    state: "empty",
    barrierSeconds: null,
    price: null,
  };
  const store: PythSolUsdLastKnownStore = {
    readFence: async () => copyPythFence(fence),
    commitPrice: async (request) => {
      if (request.expectedGeneration !== fence.generation) return "rejected";
      const candidatePublish = pythPublishSeconds(request.price);
      if (
        fence.state === "quarantine" &&
        candidatePublish <= BigInt(fence.barrierSeconds ?? "0")
      ) {
        return "rejected";
      }
      if (fence.state === "price" && fence.price) {
        const currentPublish = pythPublishSeconds(fence.price);
        if (candidatePublish < currentPublish) return "rejected";
        if (
          candidatePublish === currentPublish &&
          (request.price.unitPriceUsd !== fence.price.unitPriceUsd ||
            request.price.asOf !== fence.price.asOf ||
            request.price.confidence !== fence.price.confidence)
        ) {
          return "rejected";
        }
      }
      fence = {
        generation: fence.generation,
        state: "price",
        barrierSeconds: null,
        price: { ...request.price },
      };
      return "accepted";
    },
    quarantine: async (request) => {
      let barrier = BigInt(request.trustedPublishBarrierSeconds);
      if (fence.state === "price" && fence.price) {
        const current = pythPublishSeconds(fence.price);
        if (current > barrier) barrier = current;
      } else if (fence.state === "quarantine") {
        const current = BigInt(fence.barrierSeconds ?? "0");
        if (current > barrier) barrier = current;
      }
      generationIndex += 1;
      fence = {
        generation: pythFenceGeneration(generationIndex),
        state: "quarantine",
        barrierSeconds: barrier.toString(),
        price: null,
      };
      return "accepted";
    },
  };
  return {
    snapshot: () => copyPythFence(fence),
    store,
  };
}

await test("Pyth SOL/USD validates after the fence and preserves display-only last-known values", async () => {
  let reads = 0;
  let valuationNow = PYTH_FIXTURE_NOW;
  const adapter = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:success:" + crypto.randomUUID(),
    loadAccount: async () => {
      reads += 1;
      await Promise.resolve();
      return {
        data: PYTH_SOL_USD_FIXTURE,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => valuationNow,
  });
  const request = {
    amount: {
      asset: {
        networkId: "solana:mainnet",
        assetId: "11111111111111111111111111111111",
        decimals: 9,
      },
      raw: "52000000",
    },
    observedAt: PYTH_FIXTURE_NOW.toISOString(),
    policyId: PYTH_SOL_USD_PRICE_POLICY_ID,
  } as const;
  const estimates = await Promise.all([
    adapter.value(request),
    adapter.value(request),
    adapter.value(request),
  ]);
  assert.equal(reads, 1);
  assert.equal(estimates[0]?.value, "5.12640349624");
  assert.deepEqual(estimates[1], estimates[0]);

  valuationNow = new Date("2026-08-24T23:49:00.000Z");
  const lastKnown = await adapter.value(request);
  assert.equal(reads, 2);
  assert.equal(lastKnown?.value, "5.12640349624");
  assert.equal(lastKnown?.asOf, "2026-08-24T23:47:43.000Z");
  assert.equal(lastKnown?.priceSource, PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE);
  assert.equal(await adapter.freshValue(request), null);
  assert.equal(reads, 3);

  const generationFlight = createInMemoryPythStore();
  let releasePreQuarantineValidation: () => void = () => undefined;
  let markPreQuarantineValidationStarted: () => void = () => undefined;
  const preQuarantineValidationStarted = new Promise<void>((resolve) => {
    markPreQuarantineValidationStarted = resolve;
  });
  const preQuarantineValidationGate = new Promise<void>((resolve) => {
    releasePreQuarantineValidation = resolve;
  });
  const generationBoundCacheKey =
    "test:pyth:generation-flight:" + crypto.randomUUID();
  const preQuarantineAdapter = new PythSolUsdPriceAdapter({
    cacheKey: generationBoundCacheKey,
    lastKnownStore: generationFlight.store,
    loadAccount: async () => {
      markPreQuarantineValidationStarted();
      await preQuarantineValidationGate;
      return {
        data: PYTH_SOL_USD_FIXTURE,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => new Date("2026-08-24T23:48:02.000Z"),
  });
  const postFenceFixture = await mutatePythFixture((message) => {
    message.publishTime = new BN(
      Math.floor(Date.parse("2026-08-24T23:48:01.000Z") / 1_000),
    );
  });
  let postQuarantineReads = 0;
  const postQuarantineAdapter = new PythSolUsdPriceAdapter({
    cacheKey: generationBoundCacheKey,
    lastKnownStore: generationFlight.store,
    loadAccount: async () => {
      postQuarantineReads += 1;
      return {
        data: postFenceFixture,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => new Date("2026-08-24T23:48:02.000Z"),
  });
  const preQuarantineResult = preQuarantineAdapter.value(request);
  await preQuarantineValidationStarted;
  assert.equal(
    await generationFlight.store.quarantine({
      reason: "feed_contract_changed",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  const postQuarantineResult = await postQuarantineAdapter.value(request);
  releasePreQuarantineValidation();
  const rejectedPreQuarantineResult = await preQuarantineResult;
  assert.equal(postQuarantineReads, 1);
  assert.equal(postQuarantineResult?.priceSource, PYTH_SOL_USD_PRICE_POLICY_ID);
  assert.equal(rejectedPreQuarantineResult, null);

  const persisted = createInMemoryPythStore();
  const persistentWriter = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:persistent-writer:" + crypto.randomUUID(),
    lastKnownStore: persisted.store,
    loadAccount: async () => ({
      data: PYTH_SOL_USD_FIXTURE,
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    }),
    now: () => PYTH_FIXTURE_NOW,
  });
  assert.equal(
    (await persistentWriter.value(request))?.priceSource,
    PYTH_SOL_USD_PRICE_POLICY_ID,
  );
  assert.equal(persisted.snapshot().state, "price");

  const afterRestartTimeout = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:persistent-reader:" + crypto.randomUUID(),
    lastKnownStore: persisted.store,
    loadAccount: async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    },
    now: () => new Date("2026-08-24T23:49:00.000Z"),
  });
  const persistedFallback = await afterRestartTimeout.value(request);
  assert.equal(
    persistedFallback?.priceSource,
    PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE,
  );
  assert.equal(await afterRestartTimeout.freshValue(request), null);

  const preQuarantineGeneration = persisted.snapshot().generation;
  let unsafeMode = true;
  let unsafeNow = new Date("2026-08-24T23:49:00.000Z");
  const unsafeFeedFailure = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:unsafe-reader:" + crypto.randomUUID(),
    lastKnownStore: persisted.store,
    loadAccount: async () => {
      if (unsafeMode) {
        throw new Error("Pyth SOL/USD account owner changed");
      }
      throw new DOMException("This operation was aborted", "AbortError");
    },
    now: () => unsafeNow,
  });
  assert.equal(await unsafeFeedFailure.value(request), null);
  const quarantineFence = persisted.snapshot();
  assert.equal(quarantineFence.state, "quarantine");
  assert.notEqual(quarantineFence.generation, preQuarantineGeneration);

  assert.equal(
    await persisted.store.commitPrice({
      expectedGeneration: preQuarantineGeneration,
      price: {
        unitPriceUsd: "98.58468262",
        asOf: "2026-08-24T23:49:02.000Z",
        confidence: "high",
      },
    }),
    "rejected",
  );

  const transientAfterQuarantine = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:quarantined-reader:" + crypto.randomUUID(),
    lastKnownStore: persisted.store,
    loadAccount: async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    },
    now: () => new Date("2026-08-24T23:49:01.000Z"),
  });
  assert.equal(await transientAfterQuarantine.value(request), null);

  const crossWorkerCachedPrice = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:quarantined-live-reader:" + crypto.randomUUID(),
    lastKnownStore: persisted.store,
    loadAccount: async () => ({
      data: PYTH_SOL_USD_FIXTURE,
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    }),
    now: () => PYTH_FIXTURE_NOW,
  });
  assert.equal(await crossWorkerCachedPrice.value(request), null);

  const newerPublishTime = new Date("2026-08-24T23:49:02.000Z");
  const newerFixture = await mutatePythFixture((message) => {
    message.publishTime = new BN(
      Math.floor(newerPublishTime.getTime() / 1_000),
    );
  });
  const recoveredAfterNewPublish = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:recovered-live-reader:" + crypto.randomUUID(),
    lastKnownStore: persisted.store,
    loadAccount: async () => ({
      data: newerFixture,
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    }),
    now: () => new Date("2026-08-24T23:49:03.000Z"),
  });
  assert.equal(
    (await recoveredAfterNewPublish.value(request))?.priceSource,
    PYTH_SOL_USD_PRICE_POLICY_ID,
  );
  assert.equal(persisted.snapshot().state, "price");
  unsafeMode = false;
  unsafeNow = new Date("2026-08-24T23:49:03.000Z");
  assert.equal(
    (await unsafeFeedFailure.value(request))?.priceSource,
    PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE,
  );

  const unknownQuarantineBase = createInMemoryPythStore();
  const unknownInitialFence = await unknownQuarantineBase.store.readFence();
  if (!unknownInitialFence) {
    throw new Error("missing unknown-quarantine initial fence");
  }
  assert.equal(
    await unknownQuarantineBase.store.commitPrice({
      expectedGeneration: unknownInitialFence.generation,
      price: {
        unitPriceUsd: "98.58468262",
        asOf: "2026-08-24T23:47:43.000Z",
        confidence: "high",
      },
    }),
    "accepted",
  );
  let unknownQuarantineUnsafe = true;
  let unknownQuarantineLoads = 0;
  let unknownQuarantineCalls = 0;
  let unknownReadMode: "available" | "null" | "throw" = "available";
  const unknownQuarantineStore: PythSolUsdLastKnownStore = {
    readFence: () => {
      if (unknownReadMode === "null") return Promise.resolve(null);
      if (unknownReadMode === "throw") {
        return Promise.reject(new Error("test primary fence unavailable"));
      }
      return unknownQuarantineBase.store.readFence();
    },
    commitPrice: unknownQuarantineBase.store.commitPrice,
    quarantine: async (quarantineRequest) => {
      unknownQuarantineCalls += 1;
      return unknownQuarantineCalls < 3
        ? "unavailable"
        : unknownQuarantineBase.store.quarantine(quarantineRequest);
    },
  };
  const unknownQuarantineAdapter = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:unknown-quarantine:" + crypto.randomUUID(),
    lastKnownStore: unknownQuarantineStore,
    loadAccount: async () => {
      unknownQuarantineLoads += 1;
      if (unknownQuarantineUnsafe) {
        throw new Error("Pyth SOL/USD account owner changed");
      }
      return {
        data: newerFixture,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => new Date("2026-08-24T23:49:03.000Z"),
  });
  assert.equal(await unknownQuarantineAdapter.value(request), null);
  unknownQuarantineUnsafe = false;
  unknownReadMode = "null";
  assert.equal(await unknownQuarantineAdapter.value(request), null);
  unknownReadMode = "throw";
  assert.equal(await unknownQuarantineAdapter.value(request), null);
  assert.equal(unknownQuarantineLoads, 1);
  assert.equal(unknownQuarantineCalls, 3);
  assert.equal(unknownQuarantineBase.snapshot().state, "quarantine");
  unknownReadMode = "available";
  assert.equal(
    (await unknownQuarantineAdapter.value(request))?.priceSource,
    PYTH_SOL_USD_PRICE_POLICY_ID,
  );
  assert.equal(unknownQuarantineLoads, 2);

  const existingQuarantineBase = createInMemoryPythStore();
  const existingQuarantineInitial =
    await existingQuarantineBase.store.readFence();
  if (!existingQuarantineInitial) {
    throw new Error("missing existing-quarantine initial fence");
  }
  assert.equal(
    await existingQuarantineBase.store.commitPrice({
      expectedGeneration: existingQuarantineInitial.generation,
      price: {
        unitPriceUsd: "98.58468262",
        asOf: "2026-08-24T23:47:43.000Z",
        confidence: "high",
      },
    }),
    "accepted",
  );
  assert.equal(
    await existingQuarantineBase.store.quarantine({
      reason: "feed_contract_changed",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  let releaseExistingQuarantineWriter: () => void = () => undefined;
  let markExistingQuarantineWriterStarted: () => void = () => undefined;
  const existingQuarantineWriterStarted = new Promise<void>((resolve) => {
    markExistingQuarantineWriterStarted = resolve;
  });
  const existingQuarantineWriterGate = new Promise<void>((resolve) => {
    releaseExistingQuarantineWriter = resolve;
  });
  const existingQuarantineWriter = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:existing-q-writer:" + crypto.randomUUID(),
    lastKnownStore: existingQuarantineBase.store,
    loadAccount: async () => {
      markExistingQuarantineWriterStarted();
      await existingQuarantineWriterGate;
      return {
        data: newerFixture,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => new Date("2026-08-24T23:49:03.000Z"),
  });
  const existingQuarantineWriterResult =
    existingQuarantineWriter.value(request);
  await existingQuarantineWriterStarted;
  const newestFixture = await mutatePythFixture((message) => {
    message.publishTime = new BN(
      Math.floor(Date.parse("2026-08-24T23:49:04.000Z") / 1_000),
    );
  });
  let existingQuarantineUnsafe = true;
  let existingQuarantineReaderLoads = 0;
  const existingQuarantineReader = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:existing-q-reader:" + crypto.randomUUID(),
    lastKnownStore: {
      readFence: existingQuarantineBase.store.readFence,
      commitPrice: existingQuarantineBase.store.commitPrice,
      quarantine: async () => "unavailable",
    },
    loadAccount: async () => {
      existingQuarantineReaderLoads += 1;
      if (existingQuarantineUnsafe) {
        throw new Error("Pyth SOL/USD account owner changed");
      }
      return {
        data: newestFixture,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => new Date("2026-08-24T23:49:05.000Z"),
  });
  assert.equal(await existingQuarantineReader.value(request), null);
  existingQuarantineUnsafe = false;
  assert.equal(await existingQuarantineReader.value(request), null);
  assert.equal(existingQuarantineReaderLoads, 1);
  releaseExistingQuarantineWriter();
  assert.equal(
    (await existingQuarantineWriterResult)?.priceSource,
    PYTH_SOL_USD_PRICE_POLICY_ID,
  );
  assert.equal(await existingQuarantineReader.value(request), null);
  assert.equal(existingQuarantineReaderLoads, 1);
  assert.equal(
    await existingQuarantineBase.store.quarantine({
      reason: "price_invalid",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  assert.equal(
    (await existingQuarantineReader.value(request))?.priceSource,
    PYTH_SOL_USD_PRICE_POLICY_ID,
  );
  assert.equal(existingQuarantineReaderLoads, 2);

  const quarantineEpochBase = createInMemoryPythStore();
  const quarantineEpochInitial = await quarantineEpochBase.store.readFence();
  if (!quarantineEpochInitial) {
    throw new Error("missing quarantine-epoch initial fence");
  }
  assert.equal(
    await quarantineEpochBase.store.commitPrice({
      expectedGeneration: quarantineEpochInitial.generation,
      price: {
        unitPriceUsd: "98.58468262",
        asOf: "2026-08-24T23:47:43.000Z",
        confidence: "high",
      },
    }),
    "accepted",
  );
  let releaseOldQuarantineReply: () => void = () => undefined;
  let markOldQuarantineExecuted: () => void = () => undefined;
  const oldQuarantineExecuted = new Promise<void>((resolve) => {
    markOldQuarantineExecuted = resolve;
  });
  const oldQuarantineReplyGate = new Promise<void>((resolve) => {
    releaseOldQuarantineReply = resolve;
  });
  let quarantineEpochCalls = 0;
  const quarantineEpochStore: PythSolUsdLastKnownStore = {
    readFence: quarantineEpochBase.store.readFence,
    commitPrice: quarantineEpochBase.store.commitPrice,
    quarantine: async (quarantineRequest) => {
      quarantineEpochCalls += 1;
      if (quarantineEpochCalls !== 1) return "unavailable";
      const result =
        await quarantineEpochBase.store.quarantine(quarantineRequest);
      markOldQuarantineExecuted();
      await oldQuarantineReplyGate;
      return result;
    },
  };
  let quarantineEpochLoads = 0;
  let quarantineEpochUnsafe = true;
  const quarantineEpochAdapter = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:quarantine-epoch:" + crypto.randomUUID(),
    lastKnownStore: quarantineEpochStore,
    loadAccount: async () => {
      quarantineEpochLoads += 1;
      if (quarantineEpochUnsafe) {
        throw new Error("Pyth SOL/USD account owner changed");
      }
      return {
        data: newestFixture,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => new Date("2026-08-24T23:49:05.000Z"),
  });
  const oldQuarantineResult = quarantineEpochAdapter.value(request);
  await oldQuarantineExecuted;

  let releaseQuarantineEpochWriter: () => void = () => undefined;
  let markQuarantineEpochWriterStarted: () => void = () => undefined;
  const quarantineEpochWriterStarted = new Promise<void>((resolve) => {
    markQuarantineEpochWriterStarted = resolve;
  });
  const quarantineEpochWriterGate = new Promise<void>((resolve) => {
    releaseQuarantineEpochWriter = resolve;
  });
  const quarantineEpochWriter = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:quarantine-epoch-writer:" + crypto.randomUUID(),
    lastKnownStore: quarantineEpochBase.store,
    loadAccount: async () => {
      markQuarantineEpochWriterStarted();
      await quarantineEpochWriterGate;
      return {
        data: newerFixture,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => new Date("2026-08-24T23:49:03.000Z"),
  });
  const quarantineEpochWriterResult = quarantineEpochWriter.value(request);
  await quarantineEpochWriterStarted;
  assert.equal(await quarantineEpochAdapter.value(request), null);
  assert.equal(quarantineEpochCalls, 2);
  releaseOldQuarantineReply();
  assert.equal(await oldQuarantineResult, null);
  releaseQuarantineEpochWriter();
  assert.equal(
    (await quarantineEpochWriterResult)?.priceSource,
    PYTH_SOL_USD_PRICE_POLICY_ID,
  );
  quarantineEpochUnsafe = false;
  assert.equal(await quarantineEpochAdapter.value(request), null);
  assert.equal(quarantineEpochLoads, 2);
  assert.equal(
    await quarantineEpochBase.store.quarantine({
      reason: "price_invalid",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  assert.equal(
    (await quarantineEpochAdapter.value(request))?.priceSource,
    PYTH_SOL_USD_PRICE_POLICY_ID,
  );
  assert.equal(quarantineEpochLoads, 3);

  const corruptFences: readonly (PythSolUsdCacheFence | null)[] = [
    {
      generation: pythFenceGeneration(20),
      state: "price",
      barrierSeconds: null,
      price: null,
    },
    {
      generation: pythFenceGeneration(21),
      state: "quarantine",
      barrierSeconds: "0",
      price: null,
    },
    null,
  ];
  for (const corruptFence of corruptFences) {
    let corruptReads = 0;
    const corruptPersistentStore = new PythSolUsdPriceAdapter({
      cacheKey: "test:pyth:corrupt-reader:" + crypto.randomUUID(),
      lastKnownStore: {
        readFence: async () =>
          corruptFence ? copyPythFence(corruptFence) : null,
        commitPrice: async () => "rejected",
        quarantine: async () => "accepted",
      },
      loadAccount: async () => {
        corruptReads += 1;
        throw new DOMException("This operation was aborted", "AbortError");
      },
      now: () => new Date("2026-08-24T23:49:00.000Z"),
    });
    assert.equal(await corruptPersistentStore.value(request), null);
    assert.equal(corruptReads, corruptFence ? 1 : 0);
  }

  let retryReads = 0;
  const unavailableCodes: string[] = [];
  const retrying = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:retry:" + crypto.randomUUID(),
    loadAccount: async () => {
      retryReads += 1;
      if (retryReads === 1) throw new Error("temporary RPC error");
      return {
        data: PYTH_SOL_USD_FIXTURE,
        owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
      };
    },
    now: () => PYTH_FIXTURE_NOW,
    onUnavailable: ({ code }) => unavailableCodes.push(code),
  });
  assert.equal(await retrying.value(request), null);
  assert.deepEqual(unavailableCodes, ["rpc_unavailable"]);
  assert.equal((await retrying.value(request))?.value, "5.12640349624");
  assert.equal(retryReads, 2);

  let diagnosticReads = 0;
  const diagnosticCodes: string[] = [];
  const diagnostics = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:diagnostics:" + crypto.randomUUID(),
    loadAccount: async () => {
      diagnosticReads += 1;
      throw new Error(
        diagnosticReads < 3
          ? "temporary RPC error"
          : "Pyth SOL/USD account owner changed",
      );
    },
    now: () => PYTH_FIXTURE_NOW,
    onUnavailable: ({ code }) => diagnosticCodes.push(code),
  });
  assert.equal(await diagnostics.value(request), null);
  assert.equal(await diagnostics.value(request), null);
  assert.equal(await diagnostics.value(request), null);
  assert.deepEqual(diagnosticCodes, [
    "rpc_unavailable",
    "feed_contract_changed",
  ]);
});

await test("Pyth SOL/USD generation fences reject late writers and bound stalled Redis work", async () => {
  type RedisHash = Record<string, string>;
  const redisNowSeconds = Math.floor(
    Date.parse("2026-08-24T23:50:00.000Z") / 1_000,
  );
  let redisHash: RedisHash | null = null;

  const validUint = (value: string | undefined, allowZero: boolean) =>
    Boolean(
      value && /^(0|[1-9]\d*)$/.test(value) && (allowZero || value !== "0"),
    );
  const metadataValid = (hash: RedisHash | null) =>
    Boolean(
      hash &&
      hash.schema === "3" &&
      /^[0-9a-f]{32}$/.test(hash.generation ?? "") &&
      (hash.state === "empty" ||
        hash.state === "price" ||
        hash.state === "quarantine") &&
      hash.account === PYTH_SOL_USD_ACCOUNT &&
      hash.feedId === PYTH_SOL_USD_FEED_ID,
    );
  const evaluate = async (
    script: string,
    options: Readonly<{ arguments: string[]; keys: string[] }>,
  ): Promise<unknown> => {
    const args = options.arguments;
    if (script.includes("pyth-sol-usd-read-fence-v3")) {
      if (!metadataValid(redisHash)) {
        redisHash = {
          schema: "3",
          state: "empty",
          generation: args[0] ?? "",
          account: args[1] ?? "",
          feedId: args[2] ?? "",
        };
      }
      const state = redisHash?.state ?? "empty";
      const generation = redisHash?.generation ?? "";
      if (state === "quarantine") {
        const barrier = redisHash?.barrierSeconds;
        const trusted =
          validUint(barrier, true) &&
          Number(barrier) <= redisNowSeconds + Number(args[3] ?? "0")
            ? barrier
            : "0";
        return ["quarantine", generation, trusted ?? "0", "", "", "", ""];
      }
      if (state === "price") {
        const publish = redisHash?.publishTimeSeconds;
        const trusted =
          validUint(publish, false) &&
          Number(publish) <= redisNowSeconds + Number(args[3] ?? "0")
            ? publish
            : "0";
        return [
          "price",
          generation,
          "0",
          trusted ?? "0",
          redisHash?.unitPriceUsd ?? "",
          redisHash?.asOf ?? "",
          redisHash?.confidence ?? "",
        ];
      }
      return ["empty", generation, "0", "0", "", "", ""];
    }

    if (script.includes("pyth-sol-usd-commit-price-v3")) {
      const [
        expectedGeneration,
        candidatePublish,
        unitPriceUsd,
        asOf,
        confidence,
        account,
        feedId,
        maximumFutureSkew,
      ] = args;
      if (
        !metadataValid(redisHash) ||
        redisHash?.generation !== expectedGeneration ||
        account !== PYTH_SOL_USD_ACCOUNT ||
        feedId !== PYTH_SOL_USD_FEED_ID ||
        !validUint(candidatePublish, false) ||
        Number(candidatePublish) >
          redisNowSeconds + Number(maximumFutureSkew ?? "0")
      ) {
        return 0;
      }
      if (redisHash?.state === "quarantine") {
        const barrier =
          validUint(redisHash.barrierSeconds, true) &&
          Number(redisHash.barrierSeconds) <=
            redisNowSeconds + Number(maximumFutureSkew ?? "0")
            ? Number(redisHash.barrierSeconds)
            : 0;
        if (Number(candidatePublish) <= barrier) return 0;
      } else if (redisHash?.state === "price") {
        const currentPublish = redisHash.publishTimeSeconds;
        if (
          validUint(currentPublish, false) &&
          Number(currentPublish) <=
            redisNowSeconds + Number(maximumFutureSkew ?? "0")
        ) {
          if (Number(candidatePublish) < Number(currentPublish)) return 0;
          if (
            candidatePublish === currentPublish &&
            redisHash.unitPriceUsd === unitPriceUsd &&
            redisHash.asOf === asOf &&
            redisHash.confidence === confidence
          ) {
            return 2;
          }
        }
      }
      redisHash = {
        schema: "3",
        state: "price",
        generation: expectedGeneration ?? "",
        account: account ?? "",
        feedId: feedId ?? "",
        publishTimeSeconds: candidatePublish ?? "",
        unitPriceUsd: unitPriceUsd ?? "",
        asOf: asOf ?? "",
        confidence: confidence ?? "",
      };
      return 1;
    }

    if (script.includes("pyth-sol-usd-quarantine-v3")) {
      const [
        nextGeneration,
        reason,
        trustedBarrier,
        account,
        feedId,
        maximumFutureSkew,
      ] = args;
      let barrier = validUint(trustedBarrier, true)
        ? Number(trustedBarrier)
        : 0;
      if (metadataValid(redisHash)) {
        const currentClock =
          redisHash?.state === "price"
            ? redisHash.publishTimeSeconds
            : redisHash?.state === "quarantine"
              ? redisHash.barrierSeconds
              : undefined;
        if (
          validUint(currentClock, true) &&
          Number(currentClock) <=
            redisNowSeconds + Number(maximumFutureSkew ?? "0") &&
          Number(currentClock) > barrier
        ) {
          barrier = Number(currentClock);
        }
      }
      redisHash = {
        schema: "3",
        state: "quarantine",
        generation: nextGeneration ?? "",
        account: account ?? "",
        feedId: feedId ?? "",
        barrierSeconds: barrier.toString(),
        reason: reason ?? "",
      };
      return 1;
    }
    throw new Error("unknown Pyth cache script");
  };

  let delayNextCommit = false;
  let releaseDelayedCommit: () => void = () => undefined;
  let markDelayedCommitStarted: () => void = () => undefined;
  const delayedCommitStarted = new Promise<void>((resolve) => {
    markDelayedCommitStarted = resolve;
  });
  const delayedCommitGate = new Promise<void>((resolve) => {
    releaseDelayedCommit = resolve;
  });
  const primaryClient = {
    eval: async (
      script: string,
      options: Readonly<{ arguments: string[]; keys: string[] }>,
    ) => {
      if (delayNextCommit && script.includes("pyth-sol-usd-commit-price-v3")) {
        delayNextCommit = false;
        markDelayedCommitStarted();
        await delayedCommitGate;
      }
      return evaluate(script, options);
    },
  };
  const quarantineClient = { eval: evaluate };
  const store = createPythSolUsdLastKnownStore({
    cacheKey: "test:pyth:generation-fence",
    deadlineMs: 100,
    expectedAccount: PYTH_SOL_USD_ACCOUNT,
    expectedFeedId: PYTH_SOL_USD_FEED_ID,
    getClient: async () => primaryClient,
    getQuarantineClient: async () => quarantineClient,
  });
  const initialFence = await store.readFence();
  assert.equal(initialFence?.state, "empty");
  if (!initialFence) throw new Error("missing initial Pyth fence");
  const originalPrice: PythSolUsdPriceRecord = {
    unitPriceUsd: "98.58468262",
    asOf: "2026-08-24T23:47:43.000Z",
    confidence: "high",
  };
  assert.equal(
    await store.commitPrice({
      expectedGeneration: initialFence.generation,
      price: originalPrice,
    }),
    "accepted",
  );
  const priceFence = await store.readFence();
  assert.equal(priceFence?.state, "price");
  if (!priceFence) throw new Error("missing Pyth price fence");

  const newerPrice: PythSolUsdPriceRecord = {
    ...originalPrice,
    asOf: "2026-08-24T23:49:02.000Z",
  };
  delayNextCommit = true;
  const lateCommit = store.commitPrice({
    expectedGeneration: priceFence.generation,
    price: newerPrice,
  });
  await delayedCommitStarted;
  assert.equal(
    await store.quarantine({
      reason: "feed_contract_changed",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  const quarantined = await store.readFence();
  assert.equal(quarantined?.state, "quarantine");
  assert.notEqual(quarantined?.generation, priceFence.generation);
  releaseDelayedCommit();
  assert.equal(await lateCommit, "rejected");
  if (!quarantined) throw new Error("missing Pyth quarantine fence");

  assert.equal(
    await store.commitPrice({
      expectedGeneration: quarantined.generation,
      price: originalPrice,
    }),
    "rejected",
  );
  assert.equal(
    await store.commitPrice({
      expectedGeneration: quarantined.generation,
      price: newerPrice,
    }),
    "accepted",
  );

  assert.equal(
    await store.quarantine({
      reason: "price_invalid",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  const firstRepeatedQuarantine = await store.readFence();
  assert.equal(
    await store.quarantine({
      reason: "feed_contract_changed",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  const secondRepeatedQuarantine = await store.readFence();
  assert.notEqual(
    firstRepeatedQuarantine?.generation,
    secondRepeatedQuarantine?.generation,
  );
  assert.equal(
    firstRepeatedQuarantine?.barrierSeconds,
    secondRepeatedQuarantine?.barrierSeconds,
  );
  if (!firstRepeatedQuarantine) {
    throw new Error("missing repeated Pyth quarantine fence");
  }
  assert.equal(
    await store.commitPrice({
      expectedGeneration: firstRepeatedQuarantine.generation,
      price: newerPrice,
    }),
    "rejected",
  );

  redisHash = null;
  let delayedQuarantineCalls = 0;
  let releaseFirstQuarantineReply: () => void = () => undefined;
  let markFirstQuarantineExecuted: () => void = () => undefined;
  const firstQuarantineExecuted = new Promise<void>((resolve) => {
    markFirstQuarantineExecuted = resolve;
  });
  const firstQuarantineReplyGate = new Promise<void>((resolve) => {
    releaseFirstQuarantineReply = resolve;
  });
  const delayedQuarantineClient = {
    eval: async (
      script: string,
      options: Readonly<{ arguments: string[]; keys: string[] }>,
    ) => {
      const result = await evaluate(script, options);
      if (script.includes("pyth-sol-usd-quarantine-v3")) {
        delayedQuarantineCalls += 1;
        if (delayedQuarantineCalls === 1) {
          markFirstQuarantineExecuted();
          await firstQuarantineReplyGate;
        }
      }
      return result;
    },
  };
  const repeatedRaceStore = createPythSolUsdLastKnownStore({
    cacheKey: "test:pyth:repeated-quarantine-race",
    deadlineMs: 1_000,
    expectedAccount: PYTH_SOL_USD_ACCOUNT,
    expectedFeedId: PYTH_SOL_USD_FEED_ID,
    getClient: async () => primaryClient,
    getQuarantineClient: async () => delayedQuarantineClient,
  });
  const repeatedRaceInitial = await repeatedRaceStore.readFence();
  if (!repeatedRaceInitial) {
    throw new Error("missing repeated-quarantine race fence");
  }
  assert.equal(
    await repeatedRaceStore.commitPrice({
      expectedGeneration: repeatedRaceInitial.generation,
      price: originalPrice,
    }),
    "accepted",
  );
  const firstQuarantine = repeatedRaceStore.quarantine({
    reason: "feed_contract_changed",
    trustedPublishBarrierSeconds: "0",
  });
  await firstQuarantineExecuted;
  const firstQuarantineFence = await repeatedRaceStore.readFence();
  assert.equal(firstQuarantineFence?.state, "quarantine");
  if (!firstQuarantineFence) {
    throw new Error("missing first delayed quarantine fence");
  }
  assert.equal(
    await repeatedRaceStore.commitPrice({
      expectedGeneration: firstQuarantineFence.generation,
      price: newerPrice,
    }),
    "accepted",
  );
  const recoveredBetweenQuarantines = await repeatedRaceStore.readFence();
  assert.equal(recoveredBetweenQuarantines?.state, "price");
  assert.equal(
    await repeatedRaceStore.quarantine({
      reason: "price_invalid",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  const secondQuarantineFence = await repeatedRaceStore.readFence();
  assert.equal(secondQuarantineFence?.state, "quarantine");
  assert.notEqual(
    secondQuarantineFence?.generation,
    recoveredBetweenQuarantines?.generation,
  );
  releaseFirstQuarantineReply();
  assert.equal(await firstQuarantine, "accepted");
  assert.equal(delayedQuarantineCalls, 2);
  assert.equal((await repeatedRaceStore.readFence())?.state, "quarantine");

  const repairGeneration = pythFenceGeneration(100);
  redisHash = {
    schema: "3",
    state: "price",
    generation: repairGeneration,
    account: PYTH_SOL_USD_ACCOUNT,
    feedId: PYTH_SOL_USD_FEED_ID,
    publishTimeSeconds: pythPublishSeconds(newerPrice).toString(),
    unitPriceUsd: "not-a-price",
    asOf: newerPrice.asOf,
    confidence: newerPrice.confidence,
  };
  const malformedPriceFence = await store.readFence();
  assert.equal(malformedPriceFence?.state, "price");
  assert.equal(malformedPriceFence?.price, null);
  assert.equal(
    await store.commitPrice({
      expectedGeneration: repairGeneration,
      price: newerPrice,
    }),
    "accepted",
  );
  assert.deepEqual((await store.readFence())?.price, newerPrice);

  const futureGeneration = pythFenceGeneration(101);
  const futurePublish = (redisNowSeconds + 600).toString();
  redisHash = {
    schema: "3",
    state: "price",
    generation: futureGeneration,
    account: PYTH_SOL_USD_ACCOUNT,
    feedId: PYTH_SOL_USD_FEED_ID,
    publishTimeSeconds: futurePublish,
    unitPriceUsd: originalPrice.unitPriceUsd,
    asOf: new Date(Number(futurePublish) * 1_000).toISOString(),
    confidence: originalPrice.confidence,
  };
  const futurePriceFence = await store.readFence();
  assert.equal(futurePriceFence?.state, "price");
  assert.equal(futurePriceFence?.price, null);
  assert.equal(
    await store.commitPrice({
      expectedGeneration: futureGeneration,
      price: newerPrice,
    }),
    "accepted",
  );

  const futureQuarantineGeneration = pythFenceGeneration(102);
  redisHash = {
    schema: "3",
    state: "quarantine",
    generation: futureQuarantineGeneration,
    account: PYTH_SOL_USD_ACCOUNT,
    feedId: PYTH_SOL_USD_FEED_ID,
    barrierSeconds: futurePublish,
    reason: "feed_contract_changed",
  };
  const futureQuarantineFence = await store.readFence();
  assert.equal(futureQuarantineFence?.state, "quarantine");
  assert.equal(futureQuarantineFence?.barrierSeconds, "0");
  assert.equal(
    await store.commitPrice({
      expectedGeneration: futureQuarantineGeneration,
      price: originalPrice,
    }),
    "accepted",
  );

  redisHash = {
    schema: "3",
    state: "price",
    generation: pythFenceGeneration(103),
    account: "unexpected-account",
    feedId: PYTH_SOL_USD_FEED_ID,
  };
  const repairedMetadata = await store.readFence();
  assert.equal(repairedMetadata?.state, "empty");
  assert.equal(redisHash?.account, PYTH_SOL_USD_ACCOUNT);

  let hangingCommitCalls = 0;
  let hangingCommitInvalidations = 0;
  let rejectHangingCommit: ((reason: Error) => void) | null = null;
  let hangNextCommit = true;
  let quarantineCalls = 0;
  let hangingHash: RedisHash | null = null;
  const hangingEvaluate = async (
    script: string,
    options: Readonly<{ arguments: string[]; keys: string[] }>,
  ): Promise<unknown> => {
    if (script.includes("pyth-sol-usd-read-fence-v3")) {
      if (!hangingHash) {
        hangingHash = {
          schema: "3",
          state: "empty",
          generation: options.arguments[0] ?? "",
          account: PYTH_SOL_USD_ACCOUNT,
          feedId: PYTH_SOL_USD_FEED_ID,
        };
      }
      return [
        hangingHash.state,
        hangingHash.generation,
        hangingHash.barrierSeconds ?? "0",
        "0",
        "",
        "",
        "",
      ];
    }
    if (script.includes("pyth-sol-usd-commit-price-v3")) {
      hangingCommitCalls += 1;
      if (hangNextCommit) {
        hangNextCommit = false;
        return new Promise<never>((_resolve, reject) => {
          rejectHangingCommit = reject;
        });
      }
      const [
        expectedGeneration,
        publishTimeSeconds,
        unitPriceUsd,
        asOf,
        confidence,
      ] = options.arguments;
      if (hangingHash?.generation !== expectedGeneration) return 0;
      hangingHash = {
        schema: "3",
        state: "price",
        generation: expectedGeneration ?? "",
        account: PYTH_SOL_USD_ACCOUNT,
        feedId: PYTH_SOL_USD_FEED_ID,
        publishTimeSeconds: publishTimeSeconds ?? "",
        unitPriceUsd: unitPriceUsd ?? "",
        asOf: asOf ?? "",
        confidence: confidence ?? "",
      };
      return 1;
    }
    if (script.includes("pyth-sol-usd-quarantine-v3")) {
      quarantineCalls += 1;
      hangingHash = {
        schema: "3",
        state: "quarantine",
        generation: options.arguments[0] ?? "",
        account: PYTH_SOL_USD_ACCOUNT,
        feedId: PYTH_SOL_USD_FEED_ID,
        barrierSeconds: options.arguments[2] ?? "0",
      };
      return 1;
    }
    throw new Error("unknown hanging Pyth cache script");
  };
  const hangingStore = createPythSolUsdLastKnownStore({
    cacheKey: "test:pyth:hanging-commit",
    deadlineMs: 5,
    expectedAccount: PYTH_SOL_USD_ACCOUNT,
    expectedFeedId: PYTH_SOL_USD_FEED_ID,
    getClient: async () => ({
      eval: hangingEvaluate,
      invalidate: () => {
        hangingCommitInvalidations += 1;
        rejectHangingCommit?.(new Error("test Redis client invalidated"));
        rejectHangingCommit = null;
      },
    }),
    getQuarantineClient: async () => ({ eval: hangingEvaluate }),
  });
  const request = {
    amount: {
      asset: {
        networkId: "solana:mainnet",
        assetId: "11111111111111111111111111111111",
        decimals: 9,
      },
      raw: "52000000",
    },
    observedAt: PYTH_FIXTURE_NOW.toISOString(),
    policyId: PYTH_SOL_USD_PRICE_POLICY_ID,
  } as const;
  const unknownCommitAdapter = new PythSolUsdPriceAdapter({
    cacheKey: "test:pyth:unknown-commit:" + crypto.randomUUID(),
    lastKnownStore: hangingStore,
    loadAccount: async () => ({
      data: PYTH_SOL_USD_FIXTURE,
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    }),
    now: () => PYTH_FIXTURE_NOW,
  });
  assert.equal(await unknownCommitAdapter.value(request), null);
  assert.equal(hangingCommitCalls, 1);
  assert.equal(hangingCommitInvalidations, 1);
  await Promise.resolve();
  const recoveredCommitFence = await hangingStore.readFence();
  if (!recoveredCommitFence) {
    throw new Error("missing recovered Pyth commit fence");
  }
  assert.equal(
    await hangingStore.commitPrice({
      expectedGeneration: recoveredCommitFence.generation,
      price: originalPrice,
    }),
    "accepted",
  );
  assert.equal(hangingCommitCalls, 2);
  assert.equal(
    await hangingStore.quarantine({
      reason: "feed_contract_changed",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  assert.equal(quarantineCalls, 1);
  assert.equal(Reflect.get(hangingHash ?? {}, "state"), "quarantine");

  let hangingReadCalls = 0;
  let hangingReadInvalidations = 0;
  let rejectHangingRead: ((reason: Error) => void) | null = null;
  let hangNextRead = true;
  const hangingReadStore = createPythSolUsdLastKnownStore({
    cacheKey: "test:pyth:hanging-read",
    deadlineMs: 5,
    expectedAccount: PYTH_SOL_USD_ACCOUNT,
    expectedFeedId: PYTH_SOL_USD_FEED_ID,
    getClient: async () => ({
      eval: async (script, options) => {
        hangingReadCalls += 1;
        if (hangNextRead) {
          hangNextRead = false;
          return new Promise<never>((_resolve, reject) => {
            rejectHangingRead = reject;
          });
        }
        return evaluate(script, options);
      },
      invalidate: () => {
        hangingReadInvalidations += 1;
        rejectHangingRead?.(new Error("test Redis client invalidated"));
        rejectHangingRead = null;
      },
    }),
    getQuarantineClient: async () => quarantineClient,
  });
  assert.deepEqual(
    await Promise.all([
      hangingReadStore.readFence(),
      hangingReadStore.readFence(),
      hangingReadStore.readFence(),
    ]),
    [null, null, null],
  );
  assert.equal(hangingReadCalls, 1);
  assert.equal(hangingReadInvalidations, 1);
  await Promise.resolve();
  assert.notEqual(await hangingReadStore.readFence(), null);
  assert.equal(hangingReadCalls, 2);

  let hangingQuarantineCalls = 0;
  let hangingQuarantineInvalidations = 0;
  let rejectHangingQuarantine: ((reason: Error) => void) | null = null;
  let hangNextQuarantine = true;
  const retryingQuarantineStore = createPythSolUsdLastKnownStore({
    cacheKey: "test:pyth:hanging-quarantine",
    deadlineMs: 5,
    expectedAccount: PYTH_SOL_USD_ACCOUNT,
    expectedFeedId: PYTH_SOL_USD_FEED_ID,
    getClient: async () => primaryClient,
    getQuarantineClient: async () => ({
      eval: async (script, options) => {
        hangingQuarantineCalls += 1;
        if (hangNextQuarantine) {
          hangNextQuarantine = false;
          return new Promise<never>((_resolve, reject) => {
            rejectHangingQuarantine = reject;
          });
        }
        return evaluate(script, options);
      },
      invalidate: () => {
        hangingQuarantineInvalidations += 1;
        rejectHangingQuarantine?.(
          new Error("test quarantine Redis client invalidated"),
        );
        rejectHangingQuarantine = null;
      },
    }),
  });
  assert.equal(
    await retryingQuarantineStore.quarantine({
      reason: "feed_contract_changed",
      trustedPublishBarrierSeconds: "0",
    }),
    "unavailable",
  );
  assert.equal(hangingQuarantineInvalidations, 1);
  await Promise.resolve();
  assert.equal(
    await retryingQuarantineStore.quarantine({
      reason: "feed_contract_changed",
      trustedPublishBarrierSeconds: "0",
    }),
    "accepted",
  );
  assert.equal(hangingQuarantineCalls, 2);
});
await test("SOL valuation contributes exact totals and degrades to partial", async () => {
  const sol: AssetRef = {
    networkId: "solana:mainnet",
    assetId: "11111111111111111111111111111111",
    decimals: 9,
  };
  const solObservation: ObservedAsset = {
    componentId: "asset_sol_00000001",
    location: {
      kind: "wallet",
      locationId: "location_sol_00000001",
      accountId: "account_00000001",
      asset: sol,
      details: { address: "11111111111111111111111111111111" },
    },
    amount: { asset: sol, raw: "52000000" },
    ownershipEvidenceId: "evidence_sol_00000001",
    observedAt: PYTH_FIXTURE_NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    metadataRisk: "verified",
  };
  const policy = {
    asset: sol,
    category: "cash" as const,
    pricePolicyId: PYTH_SOL_USD_PRICE_POLICY_ID,
    maximumObservationAgeMs: 60_000,
    executionEligibility: "eligible" as const,
  };
  const pricedAdapter = new PythSolUsdPriceAdapter({
    cacheKey: `test:pyth:projection:${crypto.randomUUID()}`,
    loadAccount: async () => ({
      data: PYTH_SOL_USD_FIXTURE,
      owner: PYTH_SOLANA_RECEIVER_PROGRAM_ID,
    }),
    now: () => PYTH_FIXTURE_NOW,
  });
  const [priced] = await new ValuationService({
    policies: [policy],
    adapters: [pricedAdapter],
  }).value([solObservation], PYTH_FIXTURE_NOW);
  if (!priced) throw new Error("priced SOL fixture missing");
  const complete = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [priced],
    positionComponents: [],
    asOf: PYTH_FIXTURE_NOW.toISOString(),
  });
  assert.equal(complete.liquidAssetsEstimatedUsd, "5.12640349624");
  assert.equal(complete.valuationCompleteness, "complete");

  const [lastKnown] = await new ValuationService({
    policies: [policy],
    adapters: [
      {
        adapterId: PYTH_SOL_USD_PRICE_POLICY_ID,
        value: async () => ({
          value: "5.12640349624",
          asOf: "2026-08-24T23:47:43.000Z",
          priceSource: PYTH_SOL_USD_LAST_KNOWN_PRICE_SOURCE,
          confidence: "high",
          policyId: PYTH_SOL_USD_PRICE_POLICY_ID,
        }),
      },
    ],
  }).value([solObservation], new Date("2026-08-24T23:49:00.000Z"));
  if (!lastKnown) throw new Error("last-known SOL fixture missing");
  assert.equal(lastKnown.valuationEligibility, "stale");
  assert.equal(lastKnown.executionEligibility, "temporarily_unavailable");
  assert.deepEqual(lastKnown.reasonCodes, ["trusted_price_stale"]);
  const staleDisplay = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [lastKnown],
    positionComponents: [],
    asOf: "2026-08-24T23:49:00.000Z",
  });
  assert.equal(staleDisplay.liquidAssetsEstimatedUsd, "5.12640349624");
  assert.equal(staleDisplay.valuationCompleteness, "complete");
  assert.equal(staleDisplay.valuationFreshness, "stale");
  const staleCash = projectCashAvailability({
    components: [lastKnown],
    adjustments: [
      {
        componentId: lastKnown.componentId,
        venueId: null,
        venueBindingId: null,
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
      },
    ],
    asOf: "2026-08-24T23:49:00.000Z",
  });
  assert.equal(staleCash.cashAvailableEstimatedUsd, "5.12640349624");
  assert.equal(staleCash.components[0]?.freshness, "stale");
  assert.equal(staleCash.freshness, "stale");

  const [unpriced] = await new ValuationService({
    policies: [policy],
    adapters: [],
  }).value([solObservation], PYTH_FIXTURE_NOW);
  if (!unpriced) throw new Error("unpriced SOL fixture missing");
  assert.equal(unpriced.amount.raw, "52000000");
  assert.equal(unpriced.estimatedUsd, null);
  assert.equal(unpriced.executionEligibility, "eligible");
  const partial = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [unpriced],
    positionComponents: [],
    asOf: PYTH_FIXTURE_NOW.toISOString(),
  });
  assert.equal(partial.valuationCompleteness, "partial");
});

await test("duplicate ownership evidence counts one canonical balance", () => {
  const sharedLocation = location("dedupe");
  const result = deduplicateObservedAssets([
    observation({ id: "a", location: sharedLocation }),
    observation({ id: "b", location: sharedLocation }),
  ]);
  assert.equal(result.observations.length, 1);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.ambiguousComponentIds, []);
});

await test("conflicting same-time duplicates fail closed", () => {
  const sharedLocation = location("conflict");
  const result = deduplicateObservedAssets([
    observation({ id: "a", raw: "1000000", location: sharedLocation }),
    observation({ id: "b", raw: "2000000", location: sharedLocation }),
  ]);
  assert.equal(result.observations.length, 1);
  assert.equal(
    result.observations[0]?.observationError?.code,
    "ambiguous_duplicate_observation",
  );
});

await test("ownership profiles and venue bindings have canonical unique ids", async () => {
  const resolver = new ExistingFactsOwnershipResolver({
    wallets: [
      {
        address: "0x00000000000000000000000000000000000000aa",
        walletType: "ethereum",
        source: "external",
        linkedAddress: "0x00000000000000000000000000000000000000aa",
        serverWalletRef: null,
      },
    ],
    venueBindings: [
      {
        venueId: "polymarket",
        controllerAddress: "0x00000000000000000000000000000000000000aa",
        executionAddress: "0x00000000000000000000000000000000000000aa",
        accountRef: "0x00000000000000000000000000000000000000aa",
        settlementAsset: USDC,
        signingMode: "web_client",
      },
    ],
    now: () => NOW,
  });
  const graph = await resolver.resolve("account_00000001");
  assert.equal(graph.wallets.length, 2);
  assert.equal(new Set(graph.wallets.map((wallet) => wallet.walletId)).size, 2);
  assert.equal(graph.venueBindings.length, 1);
  assert.equal(graph.venueBindings[0]?.venueId, "polymarket");
});

await test("source-only smart accounts do not inherit controller execution", async () => {
  const resolver = new ExistingFactsOwnershipResolver({
    wallets: [
      {
        address: "0x00000000000000000000000000000000000000bb",
        walletType: "ethereum",
        source: "smart",
        linkedAddress: "0x00000000000000000000000000000000000000aa",
        controllerWalletRef: "00000000-0000-4000-8000-000000000001",
        serverWalletRef: null,
      },
    ],
    venueBindings: [],
    now: () => NOW,
  });
  const graph = await resolver.resolve("account_00000001");
  assert.equal(graph.wallets.length, 2);
  assert.ok(graph.wallets.every((wallet) => wallet.signingModes.length === 0));
  assert.ok(
    graph.wallets.every((wallet) => wallet.sponsorshipPolicyIds.length === 0),
  );
});

await test("exact stable policy values only the configured contract", async () => {
  const component = await valuedAsset({ id: "stable", raw: "1234567" });
  assert.equal(component.estimatedUsd?.value, "1.234567");
  assert.equal(component.valuationEligibility, "included");

  const impairedStates = new Map([
    [
      "evm:137:0x0000000000000000000000000000000000000001:6",
      {
        status: "impaired" as const,
        reasonCode: "asset_unpriced" as const,
        observedAt: NOW.toISOString(),
      },
    ],
  ]);
  const impairedService = new ValuationService({
    policies: [
      {
        asset: USDC,
        category: "cash",
        pricePolicyId: "exact-stable-policy-v1",
        maximumObservationAgeMs: 60_000,
        executionEligibility: "eligible",
      },
    ],
    adapters: [new ExactStablePriceAdapter(impairedStates)],
    stableStates: impairedStates,
  });
  const [impaired] = await impairedService.value(
    [observation({ id: "impaired" })],
    NOW,
  );
  assert.equal(impaired?.estimatedUsd, null);
  assert.equal(impaired?.valuationEligibility, "unpriced");
  assert.equal(impaired?.executionEligibility, "ineligible");
  assert.equal(
    resolveStableImpairmentState("stable-impaired-v1", NOW.toISOString())
      .status,
    "impaired",
  );
});

await test("priced token contributes to estimated assets but never cash availability", async () => {
  const token: AssetRef = {
    networkId: "evm:8453",
    assetId: "0x0000000000000000000000000000000000000002",
    decimals: 18,
  };
  const tokenLocation: AssetLocation = {
    kind: "wallet",
    locationId: "location_token_00000001",
    accountId: "account_00000001",
    asset: token,
    details: {
      address: "0x00000000000000000000000000000000000000aa",
    },
  };
  const adapter: PriceAdapter = {
    adapterId: "test-token-price",
    async value(input) {
      if (input.policyId !== "test-token-price") return null;
      return {
        value: "25",
        asOf: input.observedAt,
        priceSource: "test-token-price",
        confidence: "medium",
        policyId: input.policyId,
      };
    },
  };
  const service = new ValuationService({
    policies: [
      {
        asset: token,
        category: "token",
        pricePolicyId: "test-token-price",
        maximumObservationAgeMs: 60_000,
        executionEligibility: "ineligible",
      },
    ],
    adapters: [adapter],
  });
  const [component] = await service.value(
    [
      {
        componentId: "asset_token_00000001",
        location: tokenLocation,
        amount: { asset: token, raw: "1000000000000000000" },
        ownershipEvidenceId: "evidence_token_00000001",
        observedAt: NOW.toISOString(),
        observationFreshness: "fresh",
        observationError: null,
        metadataRisk: "verified",
      },
    ],
    NOW,
  );
  if (!component) throw new Error("priced token fixture missing");
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [component],
    positionComponents: [],
    asOf: NOW.toISOString(),
  });
  const cashAvailability = projectCashAvailability({
    components: [component],
    adjustments: [],
    asOf: NOW.toISOString(),
  });
  assert.equal(projection.tokenEstimatedUsd, "25");
  assert.equal(projection.liquidAssetsEstimatedUsd, "25");
  assert.equal(component.executionEligibility, "ineligible");
  assert.equal(cashAvailability.cashAvailableEstimatedUsd, "0");
});

await test("locks reduce availability but never Account Value", async () => {
  const cash = await valuedAsset({ id: "cash", raw: "10000000" });
  const account = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash],
    positionComponents: [],
    asOf: NOW.toISOString(),
  });
  const availability = projectCashAvailability({
    components: [cash],
    adjustments: [
      {
        componentId: cash.componentId,
        venueId: "polymarket",
        venueBindingId: "binding_00000001",
        lockedRaw: "3000000",
        reservedRaw: "1000000",
        submittedDebitRaw: "500000",
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(account.liquidAssetsEstimatedUsd, "10");
  assert.equal(availability.cashAvailableEstimatedUsd, "5.5");
});

await test("availability scales non-stable estimates without floating point", async () => {
  const cash = {
    ...(await valuedAsset({ id: "ratio", raw: "100" })),
    estimatedUsd: {
      value: "25",
      asOf: NOW.toISOString(),
      priceSource: "test-token-price",
      confidence: "medium" as const,
      policyId: "test-token-policy",
    },
  };
  const availability = projectCashAvailability({
    components: [cash],
    adjustments: [
      {
        componentId: cash.componentId,
        venueId: "limitless",
        venueBindingId: "binding_00000001",
        lockedRaw: "20",
        reservedRaw: "0",
        submittedDebitRaw: "0",
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(availability.cashAvailableEstimatedUsd, "20");
});

await test("unknown venue locks fail availability closed without reducing value", async () => {
  const cash = await valuedAsset({ id: "unknown-locks", raw: "10000000" });
  const availability = projectCashAvailability({
    components: [cash],
    adjustments: [
      {
        componentId: cash.componentId,
        venueId: "polymarket",
        venueBindingId: "binding_00000001",
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw: "0",
        availabilityKnown: false,
      },
    ],
    collectorErrors: [
      {
        collectorId: "cash-availability-locks",
        code: "cash_lock_collection_failed",
        retryable: true,
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(availability.cashAvailableEstimatedUsd, "0");
  assert.equal(availability.components[0]?.availableEstimatedUsd, null);
  assert.equal(availability.completeness, "partial");
  assert.equal(availability.freshness, "stale");
  assert.equal(cash.estimatedUsd?.value, "10");
});

await test("headline mode changes presentation only", async () => {
  const cash = await valuedAsset({ id: "headline", raw: "10000000" });
  const position: ValuedPositionComponent = {
    componentId: "position_00000001",
    venueId: "polymarket",
    venueBindingId: "binding_00000001",
    positionRef: "polymarket:wallet:token",
    positionActionRef: "00000000-0000-4000-8000-000000000001",
    estimatedUsd: {
      value: "3",
      asOf: NOW.toISOString(),
      priceSource: "test",
      confidence: "medium",
      policyId: "position-test",
    },
    valuationMethod: "test",
    observedAt: NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "included",
    reasonCodes: [],
  };
  const liquid = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash],
    positionComponents: [position],
    asOf: NOW.toISOString(),
  });
  const portfolio = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_plus_positions",
    components: [cash],
    positionComponents: [position],
    asOf: NOW.toISOString(),
  });
  assert.equal(
    liquid.liquidAssetsEstimatedUsd,
    portfolio.liquidAssetsEstimatedUsd,
  );
  assert.equal(liquid.positionsEstimatedUsd, portfolio.positionsEstimatedUsd);
  assert.equal(liquid.totalPortfolioEstimatedUsd, "13");
  assert.equal(resolveEffectiveHeadline(liquid).estimatedUsd, "10");
  assert.equal(resolveEffectiveHeadline(portfolio).estimatedUsd, "13");
});

await test("partial collector failure preserves known value and reports partial", async () => {
  const cash = await valuedAsset({ id: "partial", raw: "10000000" });
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash],
    positionComponents: [],
    collectorErrors: [
      {
        collectorId: "wallet-inventory",
        code: "wallet_balance_collection_failed",
        retryable: true,
      },
    ],
    asOf: NOW.toISOString(),
  });
  assert.equal(projection.liquidAssetsEstimatedUsd, "10");
  assert.equal(projection.valuationCompleteness, "partial");
});

await test("source, in-transit, and destination representations count once", async () => {
  const source = await valuedAsset({
    id: "move-src",
    raw: "5000000",
    details: { movementId: "operation_1", representationStage: "source" },
  });
  const transit = await valuedAsset({
    id: "move-mid",
    raw: "4900000",
    category: "in_transit",
    details: {
      movementId: "operation_1",
      representationStage: "in_transit",
    },
  });
  const destination = await valuedAsset({
    id: "move-dst",
    raw: "4800000",
    details: {
      movementId: "operation_1",
      representationStage: "destination",
    },
  });
  const staleSource = {
    ...source,
    valuationEligibility: "stale" as const,
    executionEligibility: "temporarily_unavailable" as const,
    reasonCodes: ["trusted_price_stale" as const],
  };
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [staleSource, transit, destination],
    positionComponents: [],
    asOf: NOW.toISOString(),
  });
  assert.equal(projection.liquidAssetsEstimatedUsd, "4.8");
  assert.equal(
    projection.components.filter(
      (component) => component.valuationEligibility === "included",
    ).length,
    1,
  );
  const availability = projectCashAvailability({
    components: [staleSource, transit, destination],
    adjustments: [],
    asOf: NOW.toISOString(),
  });
  assert.equal(availability.cashAvailableEstimatedUsd, "4.8");
  assert.equal(availability.components.length, 1);
});

await test("duplicate positions count once and conflicting marks fail closed", () => {
  assert.equal(readResolvedPositionProbability("0.25"), "0.25");
  assert.equal(readResolvedPositionProbability("2500"), "0.25");
  assert.equal(
    estimatePositionUsdFromExactText({
      size: "9007199254740993.123456",
      price: "0.5",
    }),
    "4503599627370496.561728",
  );
  const base: ValuedPositionComponent = {
    componentId: "position_00000001",
    venueId: "limitless",
    venueBindingId: "binding_00000001",
    positionRef: "limitless:wallet:token",
    positionActionRef: "00000000-0000-4000-8000-000000000001",
    estimatedUsd: {
      value: "2",
      asOf: NOW.toISOString(),
      priceSource: "test",
      confidence: "medium",
      policyId: "position-test",
    },
    valuationMethod: "test",
    observedAt: NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "included",
    reasonCodes: [],
  };
  const same = deduplicatePositionComponents([
    base,
    { ...base, componentId: "position_00000002" },
  ]);
  assert.equal(same.components.length, 1);
  assert.equal(same.duplicateCount, 1);

  const baseEstimate = base.estimatedUsd;
  if (!baseEstimate) throw new Error("position estimate fixture is missing");
  const conflict = deduplicatePositionComponents([
    base,
    {
      ...base,
      componentId: "position_00000003",
      estimatedUsd: { ...baseEstimate, value: "3" },
    },
  ]);
  assert.equal(conflict.components[0]?.valuationEligibility, "excluded");
  assert.equal(conflict.components[0]?.estimatedUsd, null);
});

await test("suggestion preference ranks only and grants no execution eligibility", async () => {
  const suggested = await valuedAsset({
    id: "suggested",
    category: "token",
    executionEligibility: "temporarily_unavailable",
  });
  const ordinary = await valuedAsset({
    id: "ordinary",
    category: "token",
    executionEligibility: "unknown",
  });
  const preferences: Record<string, StoredAssetFundingPreference> = {
    [suggested.componentId]: {
      componentId: suggested.componentId,
      preference: "suggest",
      revision: "1",
    },
  };
  const ranked = rankAssetsForSuggestion({
    components: [ordinary, suggested],
    preferences,
  });
  assert.equal(ranked[0]?.componentId, suggested.componentId);
  assert.equal(ranked[0]?.executionEligibility, "temporarily_unavailable");
  assert.equal(ranked[0]?.amount.raw, suggested.amount.raw);
});

await test("account routes require auth and preference response denies authority", async () => {
  const cash = await valuedAsset({ id: "route", raw: "1000000" });
  const secondCash = await valuedAsset({ id: "route-second", raw: "1000000" });
  const position: ValuedPositionComponent = {
    componentId: "position_route_0001",
    venueId: "polymarket",
    venueBindingId: "binding_route_0001",
    positionRef: "polymarket:wallet:token",
    positionActionRef: "00000000-0000-4000-8000-000000000099",
    estimatedUsd: null,
    valuationMethod: "unavailable",
    observedAt: NOW.toISOString(),
    observationFreshness: "fresh",
    observationError: null,
    valuationEligibility: "unpriced",
    reasonCodes: ["asset_unpriced"],
  };
  const projection = projectAccountValue({
    accountId: "account_00000001",
    headlineMode: "liquid_only",
    components: [cash, secondCash],
    positionComponents: [position],
    asOf: NOW.toISOString(),
  });
  const account = {
    projection,
    headline: resolveEffectiveHeadline(projection),
    cashAvailability: projectCashAvailability({
      components: [cash, secondCash],
      adjustments: [],
      asOf: NOW.toISOString(),
    }),
    venues: {
      polymarket: {
        cashEstimatedUsd: "2",
        cashAvailableEstimatedUsd: "2",
        positionsEstimatedUsd: "0",
        totalPortfolioEstimatedUsd: "2",
      },
    },
    policy: {
      creationMode: "off" as const,
      revision: "revision_00000001",
      source: "default" as const,
      invalidStoredPolicy: false,
    },
    runtimePolicy: DEFAULT_FUNDING_RUNTIME_POLICY,
    ownershipEvidenceRevision: "a".repeat(64),
    ownership: {
      accountId: "account_00000001",
      wallets: [],
      venueBindings: [],
      evidenceRevision: "a".repeat(64),
      asOf: NOW.toISOString(),
    },
    duplicateAssetObservationCount: 0,
    assetPreferences: {},
  };
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const dependencies: AccountValueRouteDependencies = {
    authenticate: async (request) => {
      if (request.headers.authorization !== "test") return;
      request.user = { id: "account_00000001" } as NonNullable<
        typeof request.user
      >;
    },
    build: async () => account,
    setPreference: async (_userId, component, preference) => ({
      componentId: component.componentId,
      preference,
      revision: "1",
    }),
  };
  registerAccountValueRoutes(app, dependencies);
  await app.ready();

  const anonymous = await app.inject({
    method: "GET",
    url: "/account/value",
  });
  assert.equal(anonymous.statusCode, 401);

  const value = await app.inject({
    method: "GET",
    url: "/account/value",
    headers: { authorization: "test" },
  });
  assert.equal(value.statusCode, 200);
  assert.equal(value.json().account.headline.estimatedUsd, "2");
  assert.equal("runtimePolicy" in value.json().account, false);
  assert.equal("ownership" in value.json().account, false);

  const firstAssetsPage = await app.inject({
    method: "GET",
    url: "/account/assets?category=cash&limit=1",
    headers: { authorization: "test" },
  });
  assert.equal(firstAssetsPage.statusCode, 200);
  assert.equal(firstAssetsPage.json().items.length, 1);
  assert.equal(firstAssetsPage.json().total, 2);
  assert.equal(typeof firstAssetsPage.json().nextCursor, "string");
  assert.equal(firstAssetsPage.json().valuationCompleteness, "complete");
  assert.equal(firstAssetsPage.json().valuationFreshness, "fresh");
  assert.deepEqual(firstAssetsPage.json().collectorErrors, []);

  const secondAssetsPage = await app.inject({
    method: "GET",
    url: `/account/assets?category=cash&limit=1&cursor=${encodeURIComponent(
      String(firstAssetsPage.json().nextCursor),
    )}`,
    headers: { authorization: "test" },
  });
  assert.equal(secondAssetsPage.statusCode, 200);
  assert.equal(secondAssetsPage.json().items.length, 1);
  assert.equal(secondAssetsPage.json().nextCursor, null);

  const exactPosition = await app.inject({
    method: "GET",
    url:
      "/account/assets?category=position&positionActionRef=" +
      position.positionActionRef,
    headers: { authorization: "test" },
  });
  assert.equal(exactPosition.statusCode, 200);
  assert.equal(exactPosition.json().items.length, 1);
  assert.equal(
    exactPosition.json().items[0].positionActionRef,
    position.positionActionRef,
  );

  const preference = await app.inject({
    method: "PATCH",
    url: `/account/assets/${cash.componentId}/funding-preference`,
    headers: { authorization: "test" },
    payload: { preference: "suggest" },
  });
  assert.equal(preference.statusCode, 200);
  assert.equal(preference.json().grantsTransactionAuthority, false);
  await app.close();
});

await test("account value snapshots coalesce and expire per user", async () => {
  let builds = 0;
  let now = 1_000;
  const loader = createAccountValueSnapshotLoader(
    async (userId) => {
      builds += 1;
      await Promise.resolve();
      return `${userId}:${builds}`;
    },
    { now: () => now, ttlMs: 2_000 },
  );
  const [first, concurrent] = await Promise.all([
    loader.load("user-1"),
    loader.load("user-1"),
  ]);
  assert.equal(first, concurrent);
  assert.equal(builds, 1);
  assert.equal(await loader.load("user-1"), first);
  assert.equal(builds, 1);
  now += 2_001;
  assert.notEqual(await loader.load("user-1"), first);
  assert.equal(builds, 2);
  loader.invalidate("user-1");
  await loader.load("user-1");
  assert.equal(builds, 3);
});

console.log("[account-value-tests] complete");
