#!/usr/bin/env tsx

import assert from "node:assert/strict";

import type { Pool } from "@hunch/infra";

import {
  buildPolymarketBuilderFeeAccrual,
  calculatePolymarketBuilderFeeRaw,
  clearPolymarketBuilderRateCacheForTests,
  resolvePolymarketBuilderFeeConfig,
  resolvePolymarketFeePolicySnapshot,
  type PolymarketBuilderFeeConfig,
  type PolymarketFeePolicySnapshot,
  validatePolymarketOrderBuilderCodeForConfig,
} from "./services/polymarket-builder-fees.js";

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const fallbackConfig: PolymarketBuilderFeeConfig = {
  active: true,
  builderCode:
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  takerFeeBps: 100,
  makerFeeBps: 50,
};

const builderSnapshot: PolymarketFeePolicySnapshot = {
  venue: "polymarket",
  collectionMode: "builder",
  builderCode:
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  builderTakerFeeBps: 50,
  builderMakerFeeBps: 25,
  builderRateSource: "polymarket",
  builderEnabled: true,
  legacyFeeBps: 0,
  feePolicyId: "policy-1",
  capturedAt: "2026-05-19T00:00:00.000Z",
};

const policyBuilderCode =
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function fakePolicyPool(): Pool {
  return {
    query: async () => ({
      rows: [
        {
          id: "policy-live",
          venue: "polymarket",
          fee_bps: 0,
          fee_scale: null,
          polymarket_builder_code: policyBuilderCode,
          polymarket_builder_taker_fee_bps: 25,
          polymarket_builder_maker_fee_bps: 15,
          limitless_fee_share_bps: null,
          effective_at: new Date("2026-05-19T00:00:00.000Z"),
          created_at: new Date("2026-05-19T00:00:00.000Z"),
        },
      ],
    }),
  } as unknown as Pool;
}

async function withMockFetch(fetchImpl: typeof fetch, fn: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  clearPolymarketBuilderRateCacheForTests();
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    clearPolymarketBuilderRateCacheForTests();
  }
}

function baseInput() {
  return {
    userId: "00000000-0000-4000-8000-000000000001",
    walletAddress: "0x1111111111111111111111111111111111111111",
    signerAddress: "0x2222222222222222222222222222222222222222",
    orderId: "00000000-0000-4000-8000-000000000002",
    orderHash:
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    venueOrderId: "order-1",
    venueFillId: "trade-1:taker",
    venueTradeId: "trade-1",
    txHash:
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    tokenId: "123",
    side: "BUY" as const,
    role: "taker" as const,
    size: "4",
    price: "0.249",
    filledAt: new Date("2026-05-19T00:01:00.000Z"),
    orderBuilderCode: builderSnapshot.builderCode,
    feePolicySnapshot: builderSnapshot,
  };
}

await test("uses frozen builder policy snapshot for accrual math", () => {
  const accrual = buildPolymarketBuilderFeeAccrual(baseInput(), fallbackConfig);

  assert.ok(accrual);
  assert.equal(accrual.attributionCode, builderSnapshot.builderCode);
  assert.equal(accrual.feeRateBps, 50);
  assert.equal(accrual.notionalAmountRaw, "996000");
  assert.equal(accrual.notionalAmount, "0.996000");
  assert.equal(accrual.feeAmountRaw, "4980");
  assert.equal(accrual.feeAmount, "0.004980");
});

await test("does not accrue when frozen policy was legacy fee-auth", () => {
  const accrual = buildPolymarketBuilderFeeAccrual(
    {
      ...baseInput(),
      feePolicySnapshot: {
        ...builderSnapshot,
        collectionMode: "fee_auth",
      },
      orderBuilderCode: fallbackConfig.builderCode,
    },
    fallbackConfig,
  );

  assert.equal(accrual, null);
});

await test("builder fee math floors instead of over-accruing", () => {
  assert.equal(
    calculatePolymarketBuilderFeeRaw(999_999n, 100).toString(),
    "9990",
  );
  assert.equal(
    calculatePolymarketBuilderFeeRaw(996_000n, 50).toString(),
    "4980",
  );
});

await test("uses live Polymarket builder rates when enabled", async () => {
  await withMockFetch(
    (async () =>
      new Response(
        JSON.stringify({
          enabled: true,
          builder_maker_fee_rate_bps: 50,
          builder_taker_fee_rate_bps: 100,
        }),
        { status: 200 },
      )) as typeof fetch,
    async () => {
      const snapshot =
        await resolvePolymarketFeePolicySnapshot(fakePolicyPool());
      assert.equal(snapshot.collectionMode, "builder");
      assert.equal(snapshot.builderRateSource, "polymarket");
      assert.equal(snapshot.builderEnabled, true);
      assert.equal(snapshot.builderMakerFeeBps, 50);
      assert.equal(snapshot.builderTakerFeeBps, 100);
    },
  );
});

await test("falls back to local builder bps on live rate errors", async () => {
  await withMockFetch(
    (async () => {
      throw new Error("network unavailable");
    }) as typeof fetch,
    async () => {
      const snapshot =
        await resolvePolymarketFeePolicySnapshot(fakePolicyPool());
      assert.equal(snapshot.collectionMode, "builder");
      assert.equal(snapshot.builderRateSource, "fallback");
      assert.equal(snapshot.builderEnabled, true);
      assert.equal(snapshot.builderMakerFeeBps, 15);
      assert.equal(snapshot.builderTakerFeeBps, 25);
    },
  );
});

await test("disables builder mode when Polymarket disables the builder code", async () => {
  await withMockFetch(
    (async () =>
      new Response(JSON.stringify({ enabled: false }), {
        status: 200,
      })) as typeof fetch,
    async () => {
      const snapshot =
        await resolvePolymarketFeePolicySnapshot(fakePolicyPool());
      assert.equal(snapshot.collectionMode, "none");
      assert.equal(snapshot.builderRateSource, "disabled");
      assert.equal(snapshot.builderEnabled, false);
      assert.equal(snapshot.builderMakerFeeBps, 0);
      assert.equal(snapshot.builderTakerFeeBps, 0);
      const config = await resolvePolymarketBuilderFeeConfig(fakePolicyPool());
      assert.equal(config.active, false);
      assert.equal(config.rateSource, "disabled");
      assert.equal(config.builderEnabled, false);
    },
  );
});

await test("falls back to current config only for older orders without a snapshot", () => {
  const accrual = buildPolymarketBuilderFeeAccrual(
    {
      ...baseInput(),
      orderBuilderCode: fallbackConfig.builderCode,
      feePolicySnapshot: null,
    },
    fallbackConfig,
  );

  assert.ok(accrual);
  assert.equal(accrual.attributionCode, fallbackConfig.builderCode);
  assert.equal(accrual.feeRateBps, fallbackConfig.takerFeeBps);
});

await test("allows builder attribution when configured rates are zero", () => {
  const zeroRateConfig: PolymarketBuilderFeeConfig = {
    active: true,
    builderCode:
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    takerFeeBps: 0,
    makerFeeBps: 0,
  };

  const validation = validatePolymarketOrderBuilderCodeForConfig(
    zeroRateConfig.builderCode,
    zeroRateConfig,
  );
  assert.equal(validation.ok, true);

  const accrual = buildPolymarketBuilderFeeAccrual(
    {
      ...baseInput(),
      orderBuilderCode: zeroRateConfig.builderCode,
      feePolicySnapshot: {
        ...builderSnapshot,
        builderCode: zeroRateConfig.builderCode,
        builderTakerFeeBps: 0,
        builderMakerFeeBps: 0,
      },
    },
    zeroRateConfig,
  );
  assert.equal(accrual, null);
});
