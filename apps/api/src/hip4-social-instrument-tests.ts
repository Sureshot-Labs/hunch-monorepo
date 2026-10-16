import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hip4Identity, type Hip4ReadMarket } from "@hunch/shared";
import { mapHip4Market } from "./services/hip4-mapping.js";
import { buildSocialInstrument } from "./services/social-instrument.js";
import { factsFromEvidence, rawDecimal } from "./services/verified-buy.js";
import { verifiedBuyFactsSchema } from "./schemas/social-trade.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";

const publicFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
);
function snapshot(): Hip4ReadMarket {
  return {
    ...mapHip4Market({
      ...publicFixture.observations[0],
      outcome: 8775,
      settlement: null,
      fetchedAt: publicFixture.collectedAt,
      generation: "replaceable-read-generation",
    }).market,
    expiry: "2099-01-01T00:00:00.000Z",
    quoteToken: "USDC",
    quoteTokenId: HYPERCORE_MAINNET_USDC.assetId,
    quoteWeiDecimals: 8,
  };
}
function instrument(market = snapshot(), outcome: "YES" | "NO" = "YES") {
  return buildSocialInstrument({
    venue: "hyperliquid",
    marketId: market.marketId,
    tokenId: market.sides[outcome === "YES" ? 0 : 1].tokenId,
    outcome,
    expiry: market.expiry,
    metadata: { hip4: market },
  });
}

test("native social generation is stable across read refresh, price, activity and settlement", () => {
  const first = snapshot();
  const refreshed = structuredClone(first);
  refreshed.generation = "next-read-generation";
  refreshed.fetchedAt = "2090-01-01T00:00:00.000Z";
  refreshed.status = "settled";
  refreshed.sides[0].bid = "0.9";
  refreshed.sides[0].ask = "0.99";
  refreshed.sides[0].payout = "0.5";
  assert.ok(instrument(first));
  assert.deepEqual(instrument(first), instrument(refreshed));
});

test("native economic condition, label and expiry revisions change frozen generation", () => {
  const original = instrument();
  assert.ok(original);
  for (const change of [
    (m: Hip4ReadMarket) => {
      m.description += " changed oracle";
    },
    (m: Hip4ReadMarket) => {
      m.expiry = "2099-02-01T00:00:00.000Z";
    },
    (m: Hip4ReadMarket) => {
      m.sides[0].label = "Different condition";
    },
  ]) {
    const changed = snapshot();
    change(changed);
    assert.notEqual(instrument(changed)?.generation, original.generation);
  }
});

test("selected native token and outcome remain exact despite display labels", () => {
  const market = snapshot();
  market.sides[0].label = "Up";
  market.sides[1].label = "Down";
  const yes = instrument(market, "YES"),
    no = instrument(market, "NO");
  assert.ok(yes && no);
  assert.equal(yes.tokenId, market.sides[0].tokenId);
  assert.equal(no.tokenId, market.sides[1].tokenId);
  assert.equal(no.outcome, "NO");
  assert.equal(
    buildSocialInstrument({
      venue: "hyperliquid",
      marketId: market.marketId,
      tokenId: market.sides[0].tokenId,
      outcome: "NO",
      expiry: market.expiry,
      metadata: { hip4: market },
    }),
    null,
  );
});

test("unknown native valuation or malformed identity cannot become a USD social instrument", () => {
  for (const change of [
    (m: Hip4ReadMarket) => {
      m.quoteToken = "OTHER";
    },
    (m: Hip4ReadMarket) => {
      m.quoteTokenId = null;
    },
    (m: Hip4ReadMarket) => {
      m.quoteWeiDecimals = 6;
    },
    (m: Hip4ReadMarket) => {
      m.sides[1] = { ...m.sides[0] };
    },
    (m: Hip4ReadMarket) => {
      m.sides[0].assetId++;
    },
    (m: Hip4ReadMarket) => {
      m.marketId += "foreign";
    },
    (m: Hip4ReadMarket) => {
      m.expiry = "not-a-date";
    },
  ]) {
    const market = snapshot();
    change(market);
    assert.equal(instrument(market), null);
  }
});

test("testnet financial publication cannot reuse mainnet USD valuation", () => {
  const market = snapshot();
  const identity = hip4Identity("testnet", market.outcome);
  market.environment = "testnet";
  market.marketId = identity.marketId;
  market.sides = market.sides.map((side, i) => ({
    ...side,
    ...identity.sides[i],
  }));
  assert.equal(instrument(market), null);
});

test("database expiry must match the exact native contract expiry", () => {
  const market = snapshot();
  assert.equal(
    buildSocialInstrument({
      venue: "hyperliquid",
      marketId: market.marketId,
      tokenId: market.sides[0].tokenId,
      outcome: "YES",
      expiry: null,
      metadata: { hip4: market },
    }),
    null,
  );
});

test("native verified facts preserve 13-place gross notional, 5-place shares and signed USDC rebates", () => {
  const target = instrument();
  assert.ok(target);
  const facts = factsFromEvidence({
    canonicalPurchaseKey: "hyperliquid:purchase:v1:mainnet:fixture-owner:123",
    instrument: target,
    owner: `0x${"1".repeat(40)}`,
    notionalRaw: 100000000000001n,
    collateralDecimals: 13,
    grossSharesRaw: 2000000n,
    netSharesRaw: 2000000n,
    shareDecimals: 5,
    feesUsdRaw: -100000n,
    purchasedAt: "2026-10-16T00:00:00.000Z",
    evidenceIds: ["fill:123"],
  });
  assert.equal(facts.grossNotionalUsd, "10.0000000000001");
  assert.equal(facts.netShares, "20");
  assert.equal(facts.feesUsd, "-0.00000001");
  assert.equal(verifiedBuyFactsSchema.safeParse(facts).success, true);
  assert.equal(
    verifiedBuyFactsSchema.safeParse({
      ...facts,
      instrument: { ...target, venue: "polymarket" },
    }).success,
    false,
  );
  assert.throws(() => rawDecimal(-1n, 6), /Invalid evidence amount/u);
});
