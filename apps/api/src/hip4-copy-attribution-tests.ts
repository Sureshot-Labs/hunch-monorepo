import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import {
  buildFundingTradeConsumerIntent,
  compareFundingTradeConsumerIntentToConfirmedBound,
  storedFundingTradeConsumerIntent,
} from "./funding/persistence/funding-trade-consumer-intent.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import {
  hip4OrderPreparationRequestSchema,
  hip4CancelPreparationRequestSchema,
} from "./repos/hip4-order-preparation.js";
import {
  hip4TradingSubmitBodySchema,
  hip4TradingCancelSubmitBodySchema,
} from "./schemas/hip4-trading.js";
import {
  assertHip4CopyAttribution,
  buildHip4CopyPreparedTrade,
  readHip4CopyAttribution,
} from "./services/hip4-copy-attribution.js";
import { buildHip4SocialInstrument } from "./services/hip4-social-instrument.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  copyPayloadHash,
  requireSameInstrument,
} from "./services/social-copy.js";
import { DEFAULT_SOCIAL_POLICY } from "./services/social-policy.js";
import { calculateHip4OrderAmounts } from "./services/hip4-order-amounts.js";
import { sizeHip4MarketOrder } from "./services/hip4-market-order.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
function copyInput() {
  const market = mapHip4Market({
    ...fixture.observations[0],
    outcome: 8775,
    settlement: null,
    fetchedAt: fixture.collectedAt,
    generation: "replaceable-read",
  }).market;
  Object.assign(market, {
    quoteToken: "USDC",
    quoteTokenId: HYPERCORE_MAINNET_USDC.assetId,
    quoteWeiDecimals: 8,
    expiry: "2099-01-01T00:00:00.000Z",
  });
  const token = market.sides[0];
  const instrument = buildHip4SocialInstrument({
    marketId: market.marketId,
    tokenId: token.tokenId,
    outcome: "YES",
    expiry: market.expiry,
    snapshot: market,
  });
  assert.ok(instrument);
  const cloid = `0x${randomUUID().replaceAll("-", "")}`;
  const envelope = {
    environment: "mainnet" as const,
    action: {
      type: "order" as const,
      grouping: "na" as const,
      orders: [
        {
          a: token.assetId,
          b: true,
          p: "0.5",
          s: "3",
          r: false as const,
          t: { limit: { tif: "Ioc" as const } },
          c: cloid,
        },
      ],
    },
    nonce: 1000,
    vaultAddress: null,
    expiresAfter: 2000,
  };
  return {
    userId: randomUUID(),
    actionId: randomUUID(),
    marketId: market.marketId,
    tokenId: token.tokenId,
    signerAddress: `0x${"1".repeat(40)}`,
    cloid,
    actionFingerprint: canonicalJsonHash(envelope),
    envelope,
    snapshot: {
      sourceRef: { kind: "thesis" as const, id: randomUUID() },
      copyIdempotencyKey: randomUUID(),
      socialInstrument: instrument,
      socialInstrumentSnapshot: market,
      profile: { controllerWalletRef: randomUUID() },
      consentedDebitCapRaw: "150000000",
    },
  };
}
function prepared(input = copyInput()) {
  const result = buildHip4CopyPreparedTrade(input);
  assert.ok(result);
  return result;
}

test("ordinary native BUY has no source attribution and the one-dollar trading floor is not publication's ten dollars", () => {
  assert.equal(readHip4CopyAttribution({}), null);
  const input = copyInput();
  assert.equal(buildHip4CopyPreparedTrade({ ...input, snapshot: {} }), null);
  const amounts = calculateHip4OrderAmounts({
    environment: "mainnet",
    side: "BUY",
    timeInForce: "Ioc",
    quantity: "2",
    limitPrice: "0.5",
    policy: { revision: "test", minimumBuyNotionalUsd: "1.00" },
    feeCapRaw: "0",
    consentedDebitCapRaw: "100000000",
  });
  assert.equal(amounts.kind, "calculated");
  if (amounts.kind !== "calculated") throw new Error("fixture");
  assert.equal(amounts.validation.valid, true);
  assert.equal(DEFAULT_SOCIAL_POLICY.minimumNotionalUsd, "10.00");
});

test("Copy source and HTTP Copy idempotency key form one required pair", () => {
  const input = copyInput();
  assert.throws(() =>
    readHip4CopyAttribution({ sourceRef: input.snapshot.sourceRef }),
  );
  assert.throws(() =>
    readHip4CopyAttribution({
      copyIdempotencyKey: input.snapshot.copyIdempotencyKey,
    }),
  );
  assert.deepEqual(readHip4CopyAttribution(input.snapshot), {
    sourceRef: input.snapshot.sourceRef,
    copyIdempotencyKey: input.snapshot.copyIdempotencyKey,
  });
});

test("native Copy adapter preserves selected exact amount, not source author's original notional", () => {
  const input = copyInput();
  const result = prepared(input);
  assert.deepEqual(result.prepared.intent.amount, {
    type: "shares",
    value: "3",
  });
  assert.equal(result.prepared.intent.nativeOrder?.limitPrice, "0.5");
  assert.equal(
    result.prepared.intent.nativeOrder?.consentedDebitCapRaw,
    "150000000",
  );
  assert.equal(
    result.prepared.intent.idempotencyKey,
    input.snapshot.copyIdempotencyKey,
  );
  assert.deepEqual(result.prepared.intent.sourceRef, input.snapshot.sourceRef);
  assert.equal(result.preparedFingerprint, input.actionFingerprint);
  assert.match(result.providerReference, /^hyperliquid:cloid:v1:mainnet:/u);
});

test("request/preparation/submit reject half pairs and SELL/cancel reject Copy", () => {
  const input = copyInput();
  const request = {
    requestKey: randomUUID(),
    marketId: input.marketId,
    controllerWalletRef: randomUUID(),
    side: "BUY",
    outcomeSide: "YES",
    timeInForce: "Ioc",
    limitPrice: "0.5",
    quantity: "3",
    consentedDebitCapRaw: "150000000",
  };
  assert.equal(
    hip4OrderPreparationRequestSchema.safeParse(request).success,
    true,
  );
  assert.equal(
    hip4OrderPreparationRequestSchema.safeParse({
      ...request,
      ...readHip4CopyAttribution(input.snapshot),
    }).success,
    true,
  );
  assert.equal(
    hip4OrderPreparationRequestSchema.safeParse({
      ...request,
      sourceRef: input.snapshot.sourceRef,
    }).success,
    false,
  );
  assert.equal(
    hip4OrderPreparationRequestSchema.safeParse({
      ...request,
      ...readHip4CopyAttribution(input.snapshot),
      side: "SELL",
    }).success,
    false,
  );
  const submit = {
    actionId: input.actionId,
    signature: `0x${"1".repeat(130)}`,
  };
  assert.equal(hip4TradingSubmitBodySchema.safeParse(submit).success, true);
  assert.equal(
    hip4TradingSubmitBodySchema.safeParse({
      ...submit,
      sourceRef: input.snapshot.sourceRef,
    }).success,
    false,
  );
  assert.equal(
    hip4TradingSubmitBodySchema.safeParse({
      ...submit,
      ...readHip4CopyAttribution(input.snapshot),
    }).success,
    true,
  );
  assert.equal(
    hip4CancelPreparationRequestSchema.safeParse({
      requestKey: randomUUID(),
      orderId: randomUUID(),
      sourceRef: input.snapshot.sourceRef,
    }).success,
    false,
  );
  assert.equal(
    hip4TradingCancelSubmitBodySchema.safeParse({
      ...submit,
      orderId: randomUUID(),
      ...readHip4CopyAttribution(input.snapshot),
    }).success,
    false,
  );
});

test("same prepared Copy pair replays, while changed/missing source or key is a new scope", () => {
  const input = copyInput();
  const pair = readHip4CopyAttribution(input.snapshot);
  assert.ok(pair);
  assert.deepEqual(assertHip4CopyAttribution(pair, input.snapshot), pair);
  for (const changed of [
    {},
    { ...pair, sourceRef: { kind: "thesis" as const, id: randomUUID() } },
    { ...pair, copyIdempotencyKey: randomUUID() },
  ])
    assert.throws(
      () => assertHip4CopyAttribution(changed, input.snapshot),
      /hip4_copy_scope_changed/u,
    );
});

test("native frozen generation and current exact instrument must agree", () => {
  const input = copyInput();
  const result = prepared(input);
  requireSameInstrument(result.prepared, result.hip4Instrument, {
    hip4Instrument: result.hip4Instrument,
  });
  assert.throws(
    () =>
      requireSameInstrument(
        result.prepared,
        { ...result.hip4Instrument, generation: "different-generation" },
        { hip4Instrument: result.hip4Instrument },
      ),
    /copy_generation_mismatch/u,
  );
  input.snapshot.socialInstrumentSnapshot.description += " changed oracle";
  assert.throws(
    () => buildHip4CopyPreparedTrade(input),
    /hip4_copy_instrument_unavailable/u,
  );
});

test("native Copy hash binds exact decimal price and cap without Number coercion", () => {
  const original = prepared().prepared;
  const changed = structuredClone(original);
  assert.ok(changed.intent.nativeOrder);
  changed.intent.nativeOrder = {
    ...changed.intent.nativeOrder,
    limitPrice: "0.50001",
  };
  assert.notEqual(copyPayloadHash(original), copyPayloadHash(changed));
  changed.intent.nativeOrder = {
    ...changed.intent.nativeOrder,
    limitPrice: original.intent.nativeOrder?.limitPrice ?? "",
    consentedDebitCapRaw: "150000001",
  };
  assert.notEqual(copyPayloadHash(original), copyPayloadHash(changed));
});

test("market sizing carries attribution into the final original native preparation", () => {
  const input = copyInput();
  const now = Date.now();
  const result = sizeHip4MarketOrder({
    request: {
      requestKey: randomUUID(),
      marketId: input.marketId,
      outcomeSide: "YES",
      side: "BUY",
      controllerWalletRef: randomUUID(),
      consentedDebitCapRaw: "150000000",
      slippageBps: 0,
      ...readHip4CopyAttribution(input.snapshot),
    },
    book: {
      coin: input.snapshot.socialInstrumentSnapshot.sides[0].coin,
      time: now,
      levels: [
        [{ px: "0.49", sz: "10", n: 1 }],
        [{ px: "0.5", sz: "10", n: 1 }],
      ],
    },
    now,
    bookMaxAgeMs: 1000,
  });
  assert.deepEqual(
    result.preparationRequest.sourceRef,
    input.snapshot.sourceRef,
  );
  assert.equal(
    result.preparationRequest.copyIdempotencyKey,
    input.snapshot.copyIdempotencyKey,
  );
  assert.equal(result.preparationRequest.quantity, "3");
});

test("funding consumer preserves absent-pair fingerprint compatibility and seals exact Copy pair", () => {
  const copy = copyInput();
  const base = {
    venueId: "hyperliquid",
    marketId: copy.marketId,
    marketContextId: copy.tokenId.slice("hyperliquid:".length),
    spend: { asset: HYPERCORE_MAINNET_USDC, raw: "150000000" },
  };
  const ordinary = buildFundingTradeConsumerIntent(base);
  assert.equal(
    ordinary.fingerprint,
    `funding_trade_intent_${canonicalJsonHash({ ...base, side: "BUY" })}`,
  );
  const pair = readHip4CopyAttribution(copy.snapshot);
  assert.ok(pair);
  const attributed = buildFundingTradeConsumerIntent({ ...base, ...pair });
  assert.notEqual(attributed.fingerprint, ordinary.fingerprint);
  assert.equal(
    compareFundingTradeConsumerIntentToConfirmedBound(
      attributed,
      buildFundingTradeConsumerIntent({
        ...base,
        ...pair,
        spend: { ...base.spend, raw: "120000000" },
      }),
    ),
    "matched",
  );
  assert.equal(
    compareFundingTradeConsumerIntentToConfirmedBound(attributed, ordinary),
    "scope_mismatch",
  );
  assert.equal(
    compareFundingTradeConsumerIntentToConfirmedBound(
      attributed,
      buildFundingTradeConsumerIntent({
        ...base,
        ...pair,
        copyIdempotencyKey: randomUUID(),
      }),
    ),
    "scope_mismatch",
  );
  assert.equal(
    compareFundingTradeConsumerIntentToConfirmedBound(
      attributed,
      buildFundingTradeConsumerIntent({
        ...base,
        ...pair,
        sourceRef: { kind: "thesis", id: randomUUID() },
      }),
    ),
    "scope_mismatch",
  );
});

test("stored funded scope reconstructs the original pair and rejects malformed half-pair snapshots", () => {
  const copy = copyInput();
  const pair = readHip4CopyAttribution(copy.snapshot);
  assert.ok(pair);
  const context = {
    venueId: "hyperliquid",
    marketId: copy.marketId,
    marketContextId: copy.tokenId.slice("hyperliquid:".length),
    collateralAsset: HYPERCORE_MAINNET_USDC,
    requestedCollateralRaw: "150000000",
    ...pair,
  };
  const stored = {
    operationVenueId: "hyperliquid",
    operationMarketId: copy.marketId,
    marketContextSnapshot: context,
    requestedDestinationAmount: {
      asset: HYPERCORE_MAINNET_USDC,
      raw: "150000000",
    },
    reservationAsset: HYPERCORE_MAINNET_USDC,
    reservationRawAmount: "150000000",
  };
  assert.deepEqual(
    storedFundingTradeConsumerIntent(stored)?.sourceRef,
    pair.sourceRef,
  );
  assert.equal(
    storedFundingTradeConsumerIntent(stored)?.copyIdempotencyKey,
    pair.copyIdempotencyKey,
  );
  assert.equal(
    storedFundingTradeConsumerIntent({
      ...stored,
      marketContextSnapshot: { ...context, copyIdempotencyKey: undefined },
    }),
    null,
  );
});
