import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "@hunch/infra";
import { DEFAULT_VENUE_LIFECYCLE_POLICY } from "@hunch/shared";
import { hip4FeeTestObservation } from "./hip4-fee-test-fixture.js";
import {
  assertHip4CurrentFeeConsent,
  quoteHip4OrderFees,
  readHip4OrderFeeObservation,
} from "./services/hip4-order-fees.js";
import { calculateHip4OrderAmounts } from "./services/hip4-order-amounts.js";

const action = (
  side: "BUY" | "SELL" = "SELL",
  tif: "Ioc" | "Alo" | "Gtc" = "Ioc",
  price = "0.5",
  quantity = "2",
) => ({
  type: "order",
  grouping: "na",
  orders: [
    {
      a: 100014730,
      b: side === "BUY",
      p: price,
      s: quantity,
      r: false,
      t: { limit: { tif } },
      c: `0x${"ab".repeat(16)}`,
    },
  ],
});
function quote(observation = hip4FeeTestObservation(), order = action()) {
  return quoteHip4OrderFees({
    observation,
    action: order,
    address: observation.address,
  });
}

test("opening zero is an explicit no-builder outcome contract, not missing SELL terms fallback", () => {
  const result = quote(
    hip4FeeTestObservation({ side: "BUY", closing: null }),
    action("BUY"),
  );
  assert.equal(result.buyFeeCapRaw, "0");
  assert.equal(result.estimatedFeeAtLimitRaw, "0");
  assert.equal(result.lifetimeFeeCapRaw, null);
  assert.equal(result.fundingCostsIncluded, false);
  assert.equal(result.builderFeesEnabled, false);
  assert.throws(() =>
    quoteHip4OrderFees({
      observation: hip4FeeTestObservation({ side: "BUY", closing: null }),
      address: hip4FeeTestObservation().address,
      action: {
        ...action("BUY"),
        builder: { b: hip4FeeTestObservation().address, f: 10 },
      },
    }),
  );
  assert.throws(
    () => quote(hip4FeeTestObservation({ closing: null })),
    /terms_unavailable/u,
  );
});

test("current outcome rates use maker/taker explicitly, referral once and no assumed alignment discount", () => {
  for (const [tif, rate, fee, role] of [
    ["Ioc", "0.0014", "140000", "taker"],
    ["Alo", "0.0008", "80000", "maker"],
    ["Gtc", "0.0014", "140000", "maker_or_taker"],
  ] as const) {
    const result = quote(undefined, action("SELL", tif));
    assert.equal(result.currentRateUpperBound, rate);
    assert.equal(result.estimatedFeeAtLimitRaw, fee);
    assert.equal(result.feeRoleAssumption, role);
    assert.equal(result.buyFeeCapRaw, null);
    assert.equal(result.alignmentTreatment, "undiscounted_upper_rate");
  }
  const observation = hip4FeeTestObservation();
  assert.ok(observation.closing);
  observation.closing.userFees = {
    userSpotAddRate: "-0.00001",
    userSpotCrossRate: "0.000672",
    activeReferralDiscount: "0.05",
  };
  assert.equal(quote(observation).currentRateUpperBound, "0.0012768");
  assert.equal(
    quote(observation, action("SELL", "Alo")).estimatedFeeAtLimitRaw,
    "0",
  );
  observation.closing.deployerFeeScale = "2";
  assert.equal(quote(observation).currentRateUpperBound, "0.0025536");
  observation.closing.feeScale = "0";
  assert.equal(quote(observation).currentRateUpperBound, "0");
});

test("SELL price improvement and per-fill rounding are not represented as a hard total cap", () => {
  const atLimit = quote(undefined, action("SELL", "Ioc", "0.00304", "100"));
  const atExecution = quote(undefined, action("SELL", "Ioc", "0.00333", "100"));
  assert.ok(
    BigInt(atExecution.estimatedFeeAtLimitRaw) >
      BigInt(atLimit.estimatedFeeAtLimitRaw),
  );
  assert.equal(atLimit.lifetimeFeeCapRaw, null);
  assert.equal(atLimit.feeAccounting, "actual_execution_fee");
  const calculated = calculateHip4OrderAmounts({
    environment: "mainnet",
    side: "SELL",
    timeInForce: "Ioc",
    limitPrice: "0.00304",
    quantity: "100",
    feeCapRaw: null,
    sellFeeEstimateAtLimitRaw: atLimit.estimatedFeeAtLimitRaw,
    consentedDebitCapRaw: "10000000",
  });
  assert.equal(calculated.kind, "calculated");
  if (calculated.kind !== "calculated") return;
  assert.equal(calculated.validation.valid, true);
  assert.equal(calculated.feeCapRaw, null);
  assert.equal(calculated.minimumNetProceedsRaw, null);
  assert.equal(
    calculated.estimatedNetProceedsAtLimitRaw,
    atLimit.estimatedNetProceedsAtLimitRaw,
  );
  assert.equal(calculated.debitCapRaw, "10000000");
});

test("fee estimates keep sub-atom and huge quantities exact without float conversion", () => {
  const tiny = hip4FeeTestObservation();
  assert.ok(tiny.closing);
  tiny.closing.userFees.userSpotCrossRate = "0.000000000001";
  assert.equal(
    quote(tiny, action("SELL", "Ioc", "0.00001", "1")).estimatedFeeAtLimitRaw,
    "1",
  );
  const quantity = "9007199254740993";
  assert.equal(
    quote(undefined, action("SELL", "Ioc", "0.5", quantity))
      .estimatedFeeAtLimitRaw,
    (BigInt(quantity) * 70000n).toString(),
  );
});

test("scope, signed action, freshness and increased current rate require renewed review with repair", () => {
  const old = hip4FeeTestObservation();
  const previous = quote(old);
  const raised = structuredClone(old);
  assert.ok(raised.closing);
  raised.closing.userFees.userSpotCrossRate = "0.0008";
  assert.throws(
    () => assertHip4CurrentFeeConsent(previous, quote(raised)),
    /fee_consent_changed/u,
  );
  raised.closing.userFees.userSpotCrossRate = "0.0006";
  assertHip4CurrentFeeConsent(previous, quote(raised));
  assert.throws(
    () =>
      assertHip4CurrentFeeConsent(
        previous,
        quote(old, action("SELL", "Ioc", "0.6")),
      ),
    /fee_consent_changed/u,
  );
  assert.throws(() => quote({ ...old, side: "BUY" }), /identity_mismatch/u);
  assert.throws(
    () => quote({ ...old, marketId: "hyperliquid:mainnet:outcome:1474" }),
    /identity_mismatch/u,
  );
  assert.throws(
    () => quote({ ...old, expiresAt: new Date(Date.now() - 1).toISOString() }),
    /observation_unavailable/u,
  );
  assert.throws(
    () =>
      quote({ ...old, observedAt: new Date(Date.now() + 10000).toISOString() }),
    /observation_unavailable/u,
  );
  assert.throws(
    () =>
      quoteHip4OrderFees({
        observation: old,
        address: `0x${"cd".repeat(20)}`,
        action: action(),
      }),
    /observation_unavailable/u,
  );
  assert.doesNotThrow(() => quote(old));
  assert.throws(
    () =>
      quoteHip4OrderFees({
        observation: old,
        action: action(),
        address: old.address,
        now: NaN,
      }),
    /observation_unavailable/u,
  );
});

function readerFixture() {
  const observation = hip4FeeTestObservation();
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "full" };
  const policies: Record<string, unknown> = {
    venue_lifecycle: lifecycle,
    hip4_read: {},
    hip4_account: { snapshotMaxAgeMs: 1000 },
  };
  const responses: Record<string, unknown> = {
    outcomeMeta: {
      outcomes: [
        {
          outcome: 1473,
          name: "Synthetic",
          description: "",
          sideSpecs: [{ name: "Yes" }, { name: "No" }],
          quoteToken: "USDC",
          deployerFeeScale: "1",
        },
      ],
      feeScale: "1",
    },
    spotMeta: {
      tokens: [
        {
          index: 0,
          name: "USDC",
          tokenId: observation.quoteAssetId,
          szDecimals: 8,
          weiDecimals: 8,
        },
      ],
    },
    userFees: observation.closing?.userFees,
  };
  const weights: number[] = [],
    calls: string[] = [];
  let budget = true,
    responseHook = () => {};
  const pool = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes("from runtime_policies"))
        return { rows: [{ id: args[0], payload: policies[String(args[0])] }] };
      assert.ok(sql.includes("insert into hip4_request_budget"));
      weights.push(Number(args[0]));
      return { rows: [], rowCount: budget ? 1 : 0 };
    },
  } as unknown as Pick<Pool, "query">;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    const request = JSON.parse(String(init?.body));
    calls.push(request.type);
    if (request.type === "userFees")
      assert.equal(request.user, observation.address);
    responseHook();
    return Response.json(responses[request.type]);
  };
  return {
    pool,
    fetcher,
    responses,
    policies,
    weights,
    calls,
    input: {
      address: observation.address,
      marketId: observation.marketId,
      side: "SELL" as const,
    },
    setBudget: (value: boolean) => {
      budget = value;
    },
    setHook: (value: () => void) => {
      responseHook = value;
    },
  };
}

test("fresh fee reader uses common lifecycle and budget, not default rates or another funding path", async () => {
  const f = readerFixture();
  const sell = await readHip4OrderFeeObservation(f.pool, f.input, f.fetcher);
  assert.deepEqual(f.calls, ["outcomeMeta", "spotMeta", "userFees"]);
  assert.deepEqual(f.weights, [20, 20, 20]);
  assert.equal(quote(sell).currentRateUpperBound, "0.0014");
  f.responses.userFees = null;
  f.responses.outcomeMeta = {
    ...(f.responses.outcomeMeta as object),
    feeScale: undefined,
  };
  const buy = await readHip4OrderFeeObservation(
    f.pool,
    { ...f.input, side: "BUY" },
    f.fetcher,
  );
  assert.equal(quote(buy, action("BUY")).buyFeeCapRaw, "0");
  assert.deepEqual(f.calls.slice(3), ["outcomeMeta", "spotMeta"]);
  await assert.rejects(readHip4OrderFeeObservation(f.pool, f.input, f.fetcher));
  f.setBudget(false);
  const before = f.calls.length;
  await assert.rejects(
    readHip4OrderFeeObservation(f.pool, f.input, f.fetcher),
    /budget_exhausted/u,
  );
  assert.equal(f.calls.length, before);
  f.setBudget(true);
  assert.equal(
    (
      await readHip4OrderFeeObservation(
        f.pool,
        { ...f.input, side: "BUY" },
        f.fetcher,
      )
    ).side,
    "BUY",
  );
});

test("fee read failures, identity mismatches and slow IO never create a fresh zero fee", async (t) => {
  for (const field of [
    "userSpotCrossRate",
    "userSpotAddRate",
    "activeReferralDiscount",
  ]) {
    const f = readerFixture();
    f.responses.userFees = {
      ...(f.responses.userFees as object),
      [field]: "NaN",
    };
    await assert.rejects(
      readHip4OrderFeeObservation(f.pool, f.input, f.fetcher),
    );
  }
  const f = readerFixture();
  f.policies.venue_lifecycle = DEFAULT_VENUE_LIFECYCLE_POLICY;
  await assert.rejects(
    readHip4OrderFeeObservation(f.pool, f.input, f.fetcher),
    /read_unavailable/u,
  );
  assert.equal(f.calls.length, 0);
  const foreign = readerFixture();
  foreign.responses.spotMeta = { tokens: [] };
  await assert.rejects(
    readHip4OrderFeeObservation(foreign.pool, foreign.input, foreign.fetcher),
    /identity_mismatch/u,
  );
  const slow = readerFixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  slow.setHook(() => {
    now += 400;
  });
  await assert.rejects(
    readHip4OrderFeeObservation(slow.pool, slow.input, slow.fetcher),
    /observation_expired/u,
  );
});
