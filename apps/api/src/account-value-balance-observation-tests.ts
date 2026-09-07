import assert from "node:assert/strict";

import { projectAccountValue } from "./account-value/account-value-projector.js";
import { projectCashAvailability } from "./account-value/cash-availability-projector.js";
import {
  applyFundingSourceDebitSuppression,
  buildFundingInTransitObservations,
  type FundingInTransitFact,
} from "./account-value/funding-movement-feed.js";
import { buildAccountValueObservation } from "./account-value/runtime-service.js";
import {
  EXACT_STABLE_PRICE_POLICY_ID,
  ExactStablePriceAdapter,
  ValuationService,
} from "./account-value/valuation-service.js";
import { canonicalAssetKey } from "./account-value/canonical.js";
import { RpcReadCoordinator } from "./services/rpc-read-coordinator.js";
import { readCachedWalletBalanceObservation } from "./services/wallet-balance-observation.js";
import type { AssetRef } from "./funding/domain/types.js";

const originalNow = Date.now;
let nowMs = Date.parse("2026-09-07T20:00:00.000Z");
Date.now = () => nowMs;

try {
  const coordinator = new RpcReadCoordinator(16);
  let rpcReads = 0;
  let rawBalance = 100_000_000n;
  const readEntry = () =>
    readCachedWalletBalanceObservation(
      "base-usdc-observation-fixture",
      async () => {
        rpcReads++;
        return rawBalance;
      },
      { coordinator, now: () => new Date(nowMs) },
    );
  const readResult = (key: string) =>
    coordinator.memo(key, { ttlMs: 5_000 }, async () => [await readEntry()]);

  const [first] = await readResult("full-inventory");
  assert.ok(first);
  nowMs += 1_000;
  rawBalance = 60_000_000n;
  const debitAt = new Date(nowMs).toISOString();
  nowMs += 1_000;
  const [outerHit] = await readResult("full-inventory");
  const [innerHit] = await readResult("different-token-subset");
  assert.ok(outerHit && innerHit);
  assert.equal(rpcReads, 1);
  assert.equal(outerHit.observedAt, first.observedAt);
  assert.equal(innerHit.observedAt, first.observedAt);

  const asset: AssetRef = {
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    decimals: 6,
  };
  const owner = "0x0000000000000000000000000000000000000011";
  const observation = buildAccountValueObservation({
    accountId: "balance-observation-account",
    resolution: {
      walletAddress: owner,
      walletType: "ethereum",
      linkedWalletAddress: owner,
      source: "linked",
    },
    balance: {
      chainId: "8453",
      address: asset.assetId,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      balanceRaw: innerHit.value.toString(),
      balance: "100",
      isNative: false,
      observedAt: innerHit.observedAt,
    },
    entry: {
      asset,
      category: "cash",
      symbol: "USDC",
      venueId: "limitless",
      pricePolicyId: EXACT_STABLE_PRICE_POLICY_ID,
      verified: true,
    },
  });
  assert.equal(observation.observedAt, first.observedAt);
  const debit: FundingInTransitFact = {
    operationId: "source-operation",
    segmentId: "source-segment",
    sourceComponentId: observation.componentId,
    sourceLocationId: observation.location.locationId,
    amount: { asset, raw: "40000000" },
    observedAt: debitAt,
  };
  const policies = [
    {
      asset,
      category: "cash" as const,
      pricePolicyId: EXACT_STABLE_PRICE_POLICY_ID,
      maximumObservationAgeMs: 30_000,
      executionEligibility: "unknown" as const,
    },
  ];
  const adapters = [
    new ExactStablePriceAdapter(
      new Map([[canonicalAssetKey(asset), { status: "healthy" as const }]]),
    ),
  ];
  const valued = await new ValuationService({ policies, adapters }).value(
    [observation],
    new Date(nowMs),
  );
  const inTransit = await new ValuationService({
    policies: policies.map((policy) => ({ ...policy, category: "in_transit" })),
    adapters,
  }).value(
    buildFundingInTransitObservations("balance-observation-account", [debit]),
    new Date(nowMs),
  );
  const projection = projectAccountValue({
    accountId: "balance-observation-account",
    headlineMode: "liquid_only",
    components: [
      ...applyFundingSourceDebitSuppression(valued, [debit]),
      ...inTransit,
    ],
    positionComponents: [],
    asOf: new Date(nowMs).toISOString(),
  });
  assert.equal(projection.cashEstimatedUsd, "60");
  assert.equal(projection.inTransitEstimatedUsd, "40");
  assert.equal(projection.liquidAssetsEstimatedUsd, "100");
  const cash = projectCashAvailability({
    components: valued,
    adjustments: [
      {
        componentId: observation.componentId,
        venueId: "limitless",
        venueBindingId: null,
        lockedRaw: "0",
        reservedRaw: "0",
        submittedDebitRaw:
          Date.parse(observation.observedAt) < Date.parse(debitAt)
            ? debit.amount.raw
            : "0",
      },
    ],
    asOf: new Date(nowMs).toISOString(),
  });
  assert.equal(cash.cashAvailableEstimatedUsd, "60");

  nowMs += 4_000;
  const refreshed = await readEntry();
  assert.equal(rpcReads, 2);
  assert.equal(refreshed.value, 60_000_000n);
  assert.equal(refreshed.observedAt, new Date(nowMs).toISOString());

  // Stamp at read start, not completion, even when the RPC spans a receipt.
  const startedAt = nowMs;
  const delayed = await readCachedWalletBalanceObservation(
    "delayed",
    async () => {
      nowMs += 1_000;
      return 1n;
    },
    { coordinator, now: () => new Date(nowMs) },
  );
  assert.equal(delayed.observedAt, new Date(startedAt).toISOString());
} finally {
  Date.now = originalNow;
}

console.log("account-value balance observation tests passed");
