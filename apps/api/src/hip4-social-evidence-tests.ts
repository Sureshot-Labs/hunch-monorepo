import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import {
  hip4SocialProviderReference,
  hip4SocialPurchaseKey,
  interpretHip4SocialPurchase,
  parseHip4SocialProviderReference,
  parseHip4SocialPurchaseKey,
  type Hip4SocialPurchaseResult,
} from "./services/hip4-social-evidence.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/hip4/social-evidence-v1-20261016.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
function input(): Parameters<typeof interpretHip4SocialPurchase>[0] {
  return {
    accountAddress: fixture.canonicalContract.owner,
    envelope: structuredClone(fixture.syntheticEnvelope),
    knownPrimaryOrderId: fixture.canonicalContract.primaryOrderId,
    orderStatus: structuredClone(fixture.originalPartialBuy.orderStatus),
    fills: structuredClone(fixture.originalPartialBuy.fills),
    instrument: structuredClone(fixture.syntheticInstrument),
    quoteAsset: { ...HYPERCORE_MAINNET_USDC },
    observedAt:
      fixture.originalPartialBuy.orderStatus.order.statusTimestamp + 1000,
    maxEvidenceItems: 100,
  };
}
function observed(result: Hip4SocialPurchaseResult) {
  assert.equal(result.kind, "observed");
  if (result.kind !== "observed") throw new Error(JSON.stringify(result));
  return result;
}
function fill(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
function statusOrder(value: unknown): Record<string, unknown> {
  return (value as { order: { order: Record<string, unknown> } }).order.order;
}

test("HIP social v1 fixture pins scoped primary-OID and pre-submit cloid spellings", () => {
  const contract = fixture.canonicalContract;
  assert.equal(
    hip4SocialPurchaseKey({
      environment: "mainnet",
      accountAddress: contract.owner,
      primaryOrderId: contract.primaryOrderId,
    }),
    contract.purchaseKey,
  );
  assert.equal(
    hip4SocialProviderReference({
      environment: "mainnet",
      accountAddress: contract.owner,
      cloid: contract.cloid,
    }),
    contract.providerReference,
  );
  assert.deepEqual(parseHip4SocialPurchaseKey(contract.purchaseKey), {
    environment: "mainnet",
    accountAddress: contract.owner,
    primaryOrderId: "1",
  });
  assert.deepEqual(
    parseHip4SocialProviderReference(contract.providerReference),
    {
      environment: "mainnet",
      accountAddress: contract.owner,
      cloid: contract.cloid,
    },
  );
});

test("builders normalize addresses and cloids but canonical parsers reject aliases", () => {
  const owner = `0x${"aB".repeat(20)}`;
  const cloid = `0x${"cD".repeat(16)}`;
  const key = hip4SocialPurchaseKey({
    environment: "mainnet",
    accountAddress: owner,
    primaryOrderId: "0",
  });
  const reference = hip4SocialProviderReference({
    environment: "mainnet",
    accountAddress: owner,
    cloid,
  });
  assert.ok(key.includes(owner.toLowerCase()));
  assert.ok(reference.endsWith(cloid.toLowerCase()));
  assert.equal(parseHip4SocialPurchaseKey(key.replace(/:0$/u, ":00")), null);
  assert.equal(parseHip4SocialPurchaseKey(key.replace(":v1:", ":v2:")), null);
  assert.equal(
    parseHip4SocialPurchaseKey(key.replace(owner.toLowerCase(), owner)),
    null,
  );
  assert.equal(
    parseHip4SocialProviderReference(
      reference.replace(cloid.toLowerCase(), cloid),
    ),
    null,
  );
  assert.equal(parseHip4SocialProviderReference(`${reference}:extra`), null);
  assert.equal(parseHip4SocialProviderReference(key), null);
});

test("purchase and provider identities remain separate across environments and owners", () => {
  const identity = {
    environment: "mainnet" as const,
    accountAddress: fixture.canonicalContract.owner,
    primaryOrderId: "1",
    cloid: fixture.canonicalContract.cloid,
  };
  for (const changed of [
    { ...identity, environment: "testnet" as const },
    { ...identity, accountAddress: `0x${"2".repeat(40)}` },
  ]) {
    assert.notEqual(
      hip4SocialPurchaseKey(identity),
      hip4SocialPurchaseKey(changed),
    );
    assert.notEqual(
      hip4SocialProviderReference(identity),
      hip4SocialProviderReference(changed),
    );
  }
  assert.throws(() =>
    hip4SocialPurchaseKey({ ...identity, primaryOrderId: "01" }),
  );
  assert.throws(() =>
    hip4SocialPurchaseKey({ ...identity, primaryOrderId: "9007199254740992" }),
  );
  assert.equal(
    parseHip4SocialPurchaseKey(
      fixture.canonicalContract.purchaseKey.replace(
        /:1$/u,
        ":9007199254740992",
      ),
    ),
    null,
  );
});

test("observed cancelled-remainder BUY proves only its executed original shares/notional", () => {
  const result = observed(interpretHip4SocialPurchase(input()));
  const expected = fixture.originalPartialBuy.expected;
  assert.equal(result.evidence.notionalRaw.toString(), expected.notionalRaw);
  assert.equal(result.evidence.grossSharesRaw.toString(), expected.sharesRaw);
  assert.equal(result.evidence.netSharesRaw, result.evidence.grossSharesRaw);
  assert.equal(result.evidence.feesUsdRaw?.toString(), expected.feesUsdRaw);
  assert.equal(result.evidence.collateralDecimals, 13);
  assert.equal(result.evidence.shareDecimals, 5);
  assert.equal(
    result.evidence.canonicalPurchaseKey,
    fixture.canonicalContract.purchaseKey,
  );
  assert.equal(
    result.providerReference,
    fixture.canonicalContract.providerReference,
  );
  assert.equal(
    result.actionFingerprint,
    fixture.canonicalContract.syntheticActionFingerprint,
  );
  assert.equal(result.evidence.purchasedAt, "2026-10-16T19:10:14.778Z");
  assert.deepEqual(result.coverage, {
    historyCompleteness: "not_asserted",
    dualAliases: "unverified",
    unrelatedFillCount: 0,
    uncountedRepresentationCount: 0,
  });
});

test("full account fill pages never aggregate another order to meet eligibility", () => {
  const request = input();
  request.fills = [
    ...request.fills,
    ...structuredClone(fixture.originalFilledBuy.fills),
    { oid: 123, coin: "BTC", dir: "Open Long" },
  ];
  const result = observed(interpretHip4SocialPurchase(request));
  assert.equal(result.evidence.notionalRaw, 70_200_000_000_000n);
  assert.equal(result.evidence.grossSharesRaw, 2_700_000n);
  assert.equal(result.coverage.unrelatedFillCount, 2);
});

test("the real observed full BUY joins its authoritative OID/cloid rather than another purchase", () => {
  const request = input();
  const observedOrder = fixture.originalFilledBuy.orderStatus.order.order;
  if (request.envelope.action.type !== "order") throw new Error("fixture");
  Object.assign(request.envelope.action.orders[0], {
    c: observedOrder.cloid,
    p: observedOrder.limitPx,
    s: "50",
    t: { limit: { tif: "Ioc" } },
  });
  request.envelope.nonce = observedOrder.timestamp;
  request.envelope.expiresAfter = observedOrder.timestamp + 60000;
  request.knownPrimaryOrderId = "2";
  request.orderStatus = structuredClone(fixture.originalFilledBuy.orderStatus);
  request.fills = structuredClone(fixture.originalFilledBuy.fills);
  const result = observed(interpretHip4SocialPurchase(request));
  assert.equal(result.primaryOrderId, "2");
  assert.equal(result.evidence.notionalRaw, 220_000_000_000_000n);
  assert.equal(result.evidence.grossSharesRaw, 5_000_000n);
  assert.notEqual(
    result.evidence.canonicalPurchaseKey,
    fixture.canonicalContract.purchaseKey,
  );
});

test("an exact cloid status observation may establish the first authoritative OID", () => {
  const result = observed(
    interpretHip4SocialPurchase({ ...input(), knownPrimaryOrderId: null }),
  );
  assert.equal(result.primaryOrderId, "1");
  assert.equal(
    result.evidence.canonicalPurchaseKey,
    fixture.canonicalContract.purchaseKey,
  );
});

test("exact replay deduplicates existing P2 fill identities", () => {
  const original = observed(interpretHip4SocialPurchase(input()));
  const request = input();
  request.fills = [...request.fills, ...structuredClone(request.fills)];
  const replay = observed(interpretHip4SocialPurchase(request));
  assert.deepEqual(replay.evidence, original.evidence);
});

test("one transaction hash can contain two real tids for the same purchase", () => {
  const request = input();
  const second = {
    ...fill(request.fills[0]),
    tid: 3,
    sz: "1.0",
    startPosition: "77.0",
  };
  request.fills = [...request.fills, second];
  const result = observed(interpretHip4SocialPurchase(request));
  assert.equal(result.evidence.grossSharesRaw, 2_800_000n);
  assert.equal(result.evidence.notionalRaw, 72_800_000_000_000n);
  assert.equal(result.evidence.evidenceIds.length, 2);
  const reverse = observed(
    interpretHip4SocialPurchase({
      ...request,
      fills: [...request.fills].reverse(),
    }),
  );
  assert.deepEqual(reverse.evidence, result.evidence);
});

test("a conflicting replay of an exact provider fill is a positive contradiction", () => {
  const request = input();
  request.fills = [
    ...request.fills,
    { ...fill(request.fills[0]), fee: "0.01" },
  ];
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "invalid",
    reason: "fill_identity_conflict",
  });
});

test("executions beyond the frozen original quantity cannot become social proof", () => {
  const request = input();
  request.fills = [{ ...fill(request.fills[0]), sz: "57.0" }];
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "invalid",
    reason: "fill_quantity_exceeded",
  });
});

test("a BUY above the bound limit is positive contradictory evidence", () => {
  const request = input();
  request.fills = [{ ...fill(request.fills[0]), px: "0.27" }];
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "invalid",
    reason: "fill_amount_conflict",
  });
});

test("authoritative order OID/cloid contradictions are invalid; another fill cloid is uncounted", () => {
  const wrongOid = input();
  wrongOid.knownPrimaryOrderId = "2";
  assert.deepEqual(interpretHip4SocialPurchase(wrongOid), {
    kind: "invalid",
    reason: "order_identity_conflict",
  });
  const wrongCloid = input();
  statusOrder(wrongCloid.orderStatus).cloid = `0x${"2".repeat(32)}`;
  assert.deepEqual(interpretHip4SocialPurchase(wrongCloid), {
    kind: "invalid",
    reason: "order_identity_conflict",
  });
  const wrongFillCloid = input();
  wrongFillCloid.fills = [
    { ...fill(wrongFillCloid.fills[0]), cloid: `0x${"2".repeat(32)}` },
  ];
  assert.deepEqual(interpretHip4SocialPurchase(wrongFillCloid), {
    kind: "pending",
    reason: "hip4_social_dual_alias_unverified",
  });
});

test("missing or malformed native status remains repairable pending evidence", () => {
  assert.deepEqual(
    interpretHip4SocialPurchase({
      ...input(),
      orderStatus: { status: "unknownOid" },
    }),
    { kind: "pending", reason: "order_not_observed" },
  );
  assert.deepEqual(
    interpretHip4SocialPurchase({ ...input(), orderStatus: {} }),
    { kind: "pending", reason: "invalid_order_status" },
  );
});

test("cancelled remainder and terminal status cannot manufacture missing fill quantities", () => {
  assert.deepEqual(interpretHip4SocialPurchase({ ...input(), fills: [] }), {
    kind: "pending",
    reason: "hip4_social_original_fills_not_observed",
  });
});

test("unknown fee currency stays null without removing observed shares/gross notional", () => {
  const request = input();
  request.fills = [
    { ...fill(request.fills[0]), fee: "0.01", feeToken: "UNKNOWN" },
  ];
  const result = observed(interpretHip4SocialPurchase(request));
  assert.equal(result.evidence.feesUsdRaw, null);
  assert.equal(result.evidence.notionalRaw, 70_200_000_000_000n);
  assert.equal(result.evidence.netSharesRaw, 2_700_000n);
});

test("USDC8 charged fee is exact at notional scale and builderFee is not charged twice", () => {
  const request = input();
  request.fills = [
    { ...fill(request.fills[0]), fee: "0.01234567", builderFee: "0.01" },
  ];
  const result = observed(interpretHip4SocialPurchase(request));
  assert.equal(result.evidence.feesUsdRaw, 123_456_700_000n);
  assert.equal(result.evidence.notionalRaw, 70_200_000_000_000n);
});

test("signed rebates retain native precision instead of becoming positive fees or zero", () => {
  const request = input();
  request.fills = [{ ...fill(request.fills[0]), fee: "-0.00000001" }];
  assert.equal(
    observed(interpretHip4SocialPurchase(request)).evidence.feesUsdRaw,
    -100_000n,
  );
});

test("tiny partial fills keep gross notional13 and shares5 without Number conversion", () => {
  const request = input();
  request.fills = [{ ...fill(request.fills[0]), px: "0.12345", sz: "0.00001" }];
  const result = observed(interpretHip4SocialPurchase(request));
  assert.equal(result.evidence.notionalRaw, 12_345_000n);
  assert.equal(result.evidence.grossSharesRaw, 1n);
});

test("unproved alternate-side rows are uncounted, not evidence against original BUY", () => {
  const request = input();
  const original = observed(interpretHip4SocialPurchase(request));
  const dual = {
    ...fill(request.fills[0]),
    coin: "#133431",
    side: "A",
    dir: "Sell",
    px: "0.74",
    tid: 999,
  };
  request.fills = [...request.fills, dual];
  const result = observed(interpretHip4SocialPurchase(request));
  assert.deepEqual(result.evidence, original.evidence);
  assert.equal(result.coverage.uncountedRepresentationCount, 1);
  assert.equal(result.coverage.dualAliases, "unverified");
  assert.deepEqual(interpretHip4SocialPurchase({ ...request, fills: [dual] }), {
    kind: "pending",
    reason: "hip4_social_dual_alias_unverified",
  });
});

test("a raw opposite-side status cannot prove a primary order alias or revoke money", () => {
  const request = input();
  Object.assign(statusOrder(request.orderStatus), {
    coin: "#133431",
    side: "A",
    limitPx: "0.74",
  });
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "pending",
    reason: "hip4_social_dual_alias_unverified",
  });
});

test("unsupported native economic representations are not relabeled ordinary BUYs", () => {
  const request = input();
  const unsupported = {
    ...fill(request.fills[0]),
    dir: "Merge Outcome",
    side: "A",
    tid: 999,
  };
  const result = observed(
    interpretHip4SocialPurchase({
      ...request,
      fills: [...request.fills, unsupported],
    }),
  );
  assert.equal(result.evidence.grossSharesRaw, 2_700_000n);
  assert.equal(result.coverage.uncountedRepresentationCount, 1);
});

test("original fills must lie inside exact native order lifetime evidence", () => {
  const before = input();
  before.envelope.nonce -= 100;
  before.fills = [
    { ...fill(before.fills[0]), time: fixture.syntheticEnvelope.nonce - 1 },
  ];
  assert.deepEqual(interpretHip4SocialPurchase(before), {
    kind: "invalid",
    reason: "fill_time_conflict",
  });
  const after = input();
  after.fills = [{ ...fill(after.fills[0]), time: after.observedAt }];
  assert.deepEqual(interpretHip4SocialPurchase(after), {
    kind: "invalid",
    reason: "fill_time_conflict",
  });
});

test("later original fills revise evidence but not the economic key", () => {
  const request = input();
  const original = observed(interpretHip4SocialPurchase(request));
  const wrapper = request.orderStatus as {
    order: { status: string; statusTimestamp: number };
  };
  wrapper.order.status = "open";
  wrapper.order.statusTimestamp = fixture.syntheticEnvelope.nonce;
  const later = {
    ...fill(request.fills[0]),
    time: request.observedAt - 1,
    tid: 99,
    sz: "1.0",
  };
  const result = observed(
    interpretHip4SocialPurchase({
      ...request,
      fills: [...request.fills, later],
    }),
  );
  assert.equal(
    result.evidence.canonicalPurchaseKey,
    original.evidence.canonicalPurchaseKey,
  );
  assert.equal(result.providerReference, original.providerReference);
  assert.equal(result.evidence.purchasedAt, original.evidence.purchasedAt);
  assert.equal(result.evidence.evidenceIds.length, 2);
  assert.equal(original.evidence.evidenceIds.length, 1);
  assert.notEqual(result.evidence.notionalRaw, original.evidence.notionalRaw);
});

test("only the exact supported native quote is USD-valued social evidence", () => {
  for (const quoteAsset of [
    { ...HYPERCORE_MAINNET_USDC, assetId: `0x${"1".repeat(32)}` },
    { ...HYPERCORE_MAINNET_USDC, decimals: 6 },
    { ...HYPERCORE_MAINNET_USDC, networkId: "hyperliquid:testnet" },
  ])
    assert.deepEqual(interpretHip4SocialPurchase({ ...input(), quoteAsset }), {
      kind: "pending",
      reason: "hip4_social_quote_valuation_unsupported",
    });
});

test("scoped evidence budgets count the whole supplied page before filtering", () => {
  const request = input();
  request.maxEvidenceItems = 1;
  request.fills = [...request.fills, ...fixture.originalFilledBuy.fills];
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "pending",
    reason: "hip4_social_evidence_budget_exhausted",
  });
});

test("bound instrument conflicts never silently change the published outcome", () => {
  const request = input();
  request.instrument.outcome = "NO";
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "invalid",
    reason: "hip4_social_instrument_binding_conflict",
  });
});

test("positive exact placement rejection differs from unavailable historical evidence", () => {
  const request = input();
  const wrapper = request.orderStatus as { order: { status: string } };
  wrapper.order.status = "iocCancelRejected";
  assert.deepEqual(interpretHip4SocialPurchase({ ...request, fills: [] }), {
    kind: "invalid",
    reason: "provider_order_rejected",
  });
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "invalid",
    reason: "rejected_order_execution_conflict",
  });
});

test("future status and malformed exact fill amounts are repairable, not revocation", () => {
  assert.deepEqual(interpretHip4SocialPurchase({ ...input(), observedAt: 0 }), {
    kind: "pending",
    reason: "hip4_social_order_status_in_future",
  });
  const request = input();
  request.fills = [{ ...fill(request.fills[0]), sz: "not-a-number" }];
  assert.deepEqual(interpretHip4SocialPurchase(request), {
    kind: "pending",
    reason: "fill_invalid",
  });
});
