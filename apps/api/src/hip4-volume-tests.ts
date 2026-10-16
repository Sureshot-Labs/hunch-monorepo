import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  hip4ReadMarketSchema,
  DEFAULT_HIP4_READ_POLICY,
  hip4RawUnits,
} from "@hunch/shared";
import {
  applyHip4Volume,
  indexHip4AssetContexts,
  mergeHip4Volume,
} from "./services/hip4-volume.js";
import { mapHip4Market, ageHip4Market } from "./services/hip4-mapping.js";
import { hip4CatalogProjection } from "./services/hip4-catalog-projection.js";
const read = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/hip4/${name}`, import.meta.url), "utf8"),
  );
const fixture = read("volume-observations-20261012.json");
const base = read("public-reads.json");
const at = "2026-10-12T16:00:00.000Z";
const market = mapHip4Market({
  ...base.observations[0],
  settlement: null,
  outcome: 8775,
  fetchedAt: at,
  generation: "volume-test",
}).market;
const ctx = (value: string) =>
  indexHip4AssetContexts([{ coin: "#87750", dayNtlVlm: value }]);

test("the common catalog receives primary-side 24h notional, never summed YES/NO or invented lifetime volume", () => {
  const observed = applyHip4Volume(
    market,
    indexHip4AssetContexts([
      { coin: "#87750", dayNtlVlm: "24.30617", midPx: "0.4" },
      { coin: "#87751", dayNtlVlm: "35.69383", midPx: "0.6" },
    ]),
    at,
    300000,
  );
  assert.deepEqual(hip4CatalogProjection(observed), {
    volume24h: "24.30617",
    bestBid: null,
    bestAsk: null,
    priceObservedAt: null,
  });
  assert.equal(hip4CatalogProjection(market).volume24h, null);
  assert.equal(
    hip4CatalogProjection({ ...observed, quoteToken: "USDH" }).volume24h,
    null,
  );
  assert.ok(observed.volume24h);
  assert.equal(
    hip4CatalogProjection({
      ...observed,
      volume24h: { ...observed.volume24h, coin: "#87751" },
    }).volume24h,
    null,
  );
  assert.equal(
    hip4CatalogProjection(applyHip4Volume(market, ctx("0"), at, 300000))
      .volume24h,
    "0",
  );
});

test("the common catalog preserves the actual primary book and its observation time", () => {
  const observed = {
    ...market,
    sides: market.sides.map((side) => ({
      ...side,
      bid: side.sideIndex === 0 ? "0.35" : "0.6",
      ask: side.sideIndex === 0 ? "0.4" : "0.65",
      bookAt: at,
    })),
  };
  assert.deepEqual(hip4CatalogProjection(observed), {
    volume24h: null,
    bestBid: "0.35",
    bestAsk: "0.4",
    priceObservedAt: at,
  });
});

test("bulk indicative midpoints are exact-side observations, never executable books or settlement", () => {
  const result = applyHip4Volume(
    market,
    indexHip4AssetContexts([
      { coin: "#87750", dayNtlVlm: "10", midPx: "0.4" },
      { coin: "#87751", dayNtlVlm: "15", midPx: "0.6" },
    ]),
    at,
    300000,
    60000,
  );
  assert.deepEqual(
    result.indicativePrices?.prices.map((row) => row.price),
    ["0.4", "0.6"],
  );
  assert.equal(result.indicativePrices?.validUntil, "2026-10-12T16:01:00.000Z");
  assert.equal(result.sides[0].bookState, "missing");
  assert.equal(result.settlement, null);
  const missing = applyHip4Volume(
    market,
    indexHip4AssetContexts([
      { coin: "#87750", dayNtlVlm: "10", midPx: null, markPx: "0" },
    ]),
    at,
    300000,
  );
  assert.equal(missing.indicativePrices, null);
  assert.deepEqual(
    mergeHip4Volume(result, market).indicativePrices,
    result.indicativePrices,
  );
});

test("live mirrored executions have distinct tids but cannot double primary-book volume", () => {
  const [yes, no] = fixture.trades;
  assert.equal(yes.time, no.time);
  assert.equal(yes.sz, no.sz);
  assert.notEqual(yes.tid, no.tid);
  assert.equal(hip4RawUnits(yes.px, 5) + hip4RawUnits(no.px, 5), 100000n);
  assert.equal(
    hip4RawUnits(yes.px, 5) * hip4RawUnits(yes.sz, 0),
    hip4RawUnits(fixture.contexts[0].dayNtlVlm, 5),
  );
  const actual = {
    ...market,
    ...{
      outcome: fixture.outcome,
      sides: market.sides.map((s, i) => ({
        ...s,
        coin: fixture.contexts[i].coin,
      })),
    },
  };
  const result = applyHip4Volume(
    actual,
    indexHip4AssetContexts([...fixture.contexts].reverse()),
    at,
    300000,
  );
  assert.equal(result.volume24h?.usd, "24.30617");
  assert.equal(result.volume24h?.coin, "#115290");
  assert.equal(result.volumeUsd, null);
});
test("volume preserves exact decimals and a real zero; never substitutes the other side or an array index", () => {
  for (const value of ["0", "12345678901234567890.123456789"]) {
    assert.equal(
      applyHip4Volume(market, ctx(value), at, 300000).volume24h?.usd,
      value,
    );
  }
  const wrong = indexHip4AssetContexts([
    { coin: "#87751", dayNtlVlm: "500" },
    { coin: "#1230", dayNtlVlm: "100" },
  ]);
  assert.equal(applyHip4Volume(market, wrong, at, 300000).volume24h, null);
  assert.equal(
    applyHip4Volume({ ...market, quoteToken: "USDH" }, ctx("1"), at, 300000)
      .volumeAttempt?.result,
    "wrong_identity",
  );
});
test("invalid or missing volume cannot kill metadata or erase a last good observation; next valid read recovers", () => {
  const good = applyHip4Volume(market, ctx("24.30617"), at, 300000);
  for (const payload of [
    null,
    [],
    [{ coin: "#87750", dayNtlVlm: "-1" }],
    [{ coin: "#87750", dayNtlVlm: "NaN" }],
    [
      { coin: "#87750", dayNtlVlm: "1" },
      { coin: "#87750", dayNtlVlm: "2" },
    ],
  ]) {
    const failed = applyHip4Volume(
      good,
      indexHip4AssetContexts(payload),
      "2026-10-12T16:01:00.000Z",
      300000,
    );
    assert.equal(failed.volume24h?.usd, "24.30617");
    assert.equal(failed.volume24h?.observedAt, at);
    assert.notEqual(failed.volumeAttempt?.result, "ok");
    assert.equal(failed.title, good.title);
    assert.equal(
      applyHip4Volume(failed, ctx("2"), "2026-10-12T16:02:00.000Z", 300000)
        .volume24h?.usd,
      "2",
    );
  }
});
test("REST and WS observations merge by volume time, not metadata/book time, and policy can shorten freshness", () => {
  const old = applyHip4Volume(market, ctx("1"), at, 300000);
  const fresh = applyHip4Volume(
    market,
    ctx("2"),
    "2026-10-12T16:01:00.000Z",
    300000,
  );
  assert.equal(mergeHip4Volume(fresh, old).volume24h?.usd, "2");
  assert.equal(mergeHip4Volume(old, fresh).volume24h?.usd, "2");
  assert.equal(mergeHip4Volume(fresh, market).volume24h?.usd, "2");
  const aged = ageHip4Market(old, Date.parse(at), {
    ...DEFAULT_HIP4_READ_POLICY,
    volumeMaxAgeMs: 1000,
  });
  assert.equal(aged.volume24h?.validUntil, "2026-10-12T16:00:01.000Z");
  assert.doesNotThrow(() => hip4ReadMarketSchema.parse(market));
  assert.doesNotThrow(() => hip4ReadMarketSchema.parse(fresh));
});
