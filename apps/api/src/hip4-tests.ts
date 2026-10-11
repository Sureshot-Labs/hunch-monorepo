import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEFAULT_HIP4_READ_POLICY,
  hip4Complement,
  hip4BinaryPayout,
  hip4Identity,
  isHip4CanaryId,
  hip4RawUnits,
  hip4ReadMarketSchema,
  hip4ReadPolicySchema,
  hip4TradeSchema,
  parseHip4Coin,
} from "@hunch/shared";
import {
  ageHip4Market,
  applyHip4Book,
  mapHip4Market,
} from "./services/hip4-mapping.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../src/fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
const main = fixture.observations[0];
const date = fixture.collectedAt;
function mapped(outcome = 8775) {
  return mapHip4Market({
    ...main,
    settlement: null,
    fetchedAt: date,
    generation: "test",
    outcome,
  });
}
test("HIP identities separate environment, instance, side and native protocol encodings", () => {
  const mainnet = hip4Identity("mainnet", 123);
  assert.notEqual(mainnet.marketId, hip4Identity("testnet", 123).marketId);
  assert.deepEqual(mainnet.sides[1], {
    sideIndex: 1,
    tokenId: "hyperliquid:mainnet:1231",
    coin: "#1231",
    tokenName: "+1231",
    assetId: 100001231,
  });
  assert.deepEqual(parseHip4Coin("#1231"), { outcome: 123, sideIndex: 1 });
  for (const value of ["+1231", "#1232", "#01230", "#1e4", "#-1"])
    assert.throws(() => parseHip4Coin(value));
  assert.throws(() => hip4Identity("mainnet", 1.2));
  assert.equal(isHip4CanaryId("hyperliquid:mainnet:1230"), true);
  assert.equal(isHip4CanaryId("hyperliquid:1230"), false);
});
test("exact decimal conversions never round a raw unit up or down", () => {
  assert.equal(hip4RawUnits("1.000001", 6), 1000001n);
  assert.equal(hip4RawUnits("1.000001", 8), 100000100n);
  assert.equal(
    hip4RawUnits("9007199254740993.01", 8),
    900719925474099301000000n,
  );
  assert.throws(() => hip4RawUnits("0.00000001", 6));
  assert.equal(hip4Complement("0.375"), "0.625");
  assert.throws(() => hip4Complement("1.1"));
  assert.throws(() => hip4Complement("1.0000000000000000001"));
  assert.equal(hip4BinaryPayout("0.99999999999999999999"), null);
  assert.equal(hip4BinaryPayout("0.00000000000000000001"), null);
  assert.equal(hip4BinaryPayout("1.00000"), 1);
});
test("observed mainnet templates resolve side labels and preserve unknown token precision", () => {
  const { market } = mapped();
  hip4ReadMarketSchema.parse(market);
  assert.equal(market.title, "Detroit Lions vs Arizona Cardinals");
  assert.deepEqual(
    market.sides.map((side) => side.label),
    ["Lions", "Cardinals"],
  );
  assert.equal(market.quoteWeiDecimals, 8);
  assert.equal(market.sides[0].szDecimals, null);
  assert.equal(market.volumeUsd, null);
  assert.equal(market.capabilities.trade, false);
});
test("question fallback belongs to the same event, not a standalone market", () => {
  const fallback = mapped(11116).market;
  const named = mapped(11117).market;
  assert.equal(fallback.isFallback, true);
  assert.equal(fallback.eventId, named.eventId);
  assert.notEqual(fallback.marketId, named.marketId);
  assert.equal(named.title, "FK Bodo/Glimt");
  assert.equal(fallback.title, "Other");
});
test("expiry and 0/1 books cannot produce an official outcome; fractional payouts stay fractional", () => {
  const expired = ageHip4Market(
    mapped().market,
    Date.parse("2027-01-01"),
    DEFAULT_HIP4_READ_POLICY,
  );
  assert.equal(expired.status, "expired");
  assert.equal(expired.sides[0].payout, null);
  const settled = mapHip4Market({
    ...main,
    outcome: 95,
    fetchedAt: date,
    generation: "test",
    settlement: { ...main.settlement, settleFraction: "0.375" },
  }).market;
  assert.equal(settled.status, "settled");
  assert.deepEqual(
    settled.sides.map((s) => s.payout),
    ["0.375", "0.625"],
  );
  assert.throws(() =>
    mapHip4Market({
      ...main,
      outcome: 95,
      fetchedAt: date,
      generation: "test",
      settlement: {
        ...main.settlement,
        spec: { ...main.settlement.spec, outcome: 96 },
      },
    }),
  );
});
test("books distinguish empty/stale/error from valid zero, reject wrong identity and crossed books", () => {
  const market = mapped().market;
  const now = Date.parse(date);
  const book = {
    coin: market.sides[0].coin,
    time: now,
    levels: [[{ px: "0", sz: "1", n: 1 }], [{ px: "1", sz: "2", n: 1 }]],
  };
  const priced = applyHip4Book(market, 0, book, now, 1000);
  assert.equal(priced.sides[0].bid, "0");
  assert.equal(priced.sides[0].bookState, "fresh");
  assert.equal(
    applyHip4Book(market, 0, { ...book, levels: [[], []] }, now, 1000).sides[0]
      .bookState,
    "empty",
  );
  assert.equal(
    applyHip4Book(market, 0, book, now + 1001, 1000).sides[0].bookState,
    "stale",
  );
  assert.throws(() => applyHip4Book(market, 1, book, now, 1000));
  assert.throws(() =>
    applyHip4Book(
      market,
      0,
      {
        ...book,
        levels: [
          [{ px: "0.8", sz: "1", n: 1 }],
          [{ px: "0.2", sz: "1", n: 1 }],
        ],
      },
      now,
      1000,
    ),
  );
});
test("observed testnet custom labels are not rewritten YES/NO; participants are not retained", () => {
  const observation = fixture.observations[1];
  const { market } = mapHip4Market({
    ...observation,
    outcome: 10225,
    fetchedAt: date,
    generation: "test",
  });
  assert.deepEqual(
    market.sides.map((s) => s.label),
    ["Change", "No Change"],
  );
  const trade = hip4TradeSchema.parse({
    ...main.trades[0],
    users: ["private", "private"],
  });
  assert.equal("users" in trade, false);
});
test("canary is off by default and policy does not admit financial switches", () => {
  assert.equal(DEFAULT_HIP4_READ_POLICY.enabled, false);
  assert.throws(() => hip4ReadPolicySchema.parse({ tradeEnabled: true }));
  assert.throws(() =>
    hip4ReadPolicySchema.parse({ requestWeightPerMinute: 1201 }),
  );
});
