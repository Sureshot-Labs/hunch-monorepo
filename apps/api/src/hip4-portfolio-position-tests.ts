import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hip4Identity } from "@hunch/shared";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  projectHip4PortfolioPositions,
  readHip4PortfolioPositions,
} from "./services/hip4-portfolio-positions.js";

const now = Date.parse("2026-10-13T10:00:00.000Z");
const source = JSON.parse(
  readFileSync(
    new URL("./fixtures/hip4/public-reads.json", import.meta.url),
    "utf8",
  ),
).observations[0];
const identity = hip4Identity("mainnet", 8775);
const market = mapHip4Market({
  ...source,
  outcome: 8775,
  settlement: null,
  fetchedAt: new Date(now).toISOString(),
  generation: "portfolio-test",
}).market;
market.quoteToken = "USDC";
market.status = "observed";
market.metadataValidUntil = new Date(now + 50000).toISOString();
market.coverage.metadata = "fresh";
market.sides.forEach((side) =>
  Object.assign(side, {
    bookState: "fresh",
    bid: side.sideIndex === 0 ? "0.6" : "0.3",
    ask: side.sideIndex === 0 ? "0.7" : "0.4",
    bookAt: new Date(now).toISOString(),
    bookValidUntil: new Date(now + 30000).toISOString(),
  }),
);
const observation = projectHip4Account({
  environment: "mainnet",
  observedAt: new Date(now).toISOString(),
  role: "user",
  mode: "disabled",
  quote: { tokenId: "USDC", index: 0, weiDecimals: 8 },
  state: {
    balances: [
      { coin: "+87750", total: "20.00001", hold: "1", entryNtl: "999" },
      { coin: "+87751", total: "10", hold: "0", entryNtl: "123" },
    ],
  },
});
const input = {
  userId: "first-user",
  address: `0x${"A".repeat(40)}`,
  environment: "mainnet" as const,
  observation,
  markets: new Map([[identity.marketId, market]]),
  snapshotMaxAgeMs: 60000,
  now,
};

test("Portfolio values exact owned side quantities, not reported entry or complementary bid", () => {
  const rows = projectHip4PortfolioPositions(input);
  assert.equal(rows[0].sizeRaw, "20.00001");
  assert.equal(rows[0].valuation.marketValue, "12.000006");
  assert.equal(rows[1].valuation.marketValue, "3");
  for (const row of rows) {
    assert.equal(row.averagePrice, null);
    assert.equal(row.unrealizedPnl, null);
    assert.equal(row.realizedPnl, null);
    assert.equal(row.valuation.validUntil, new Date(now + 30000).toISOString());
    assert.deepEqual(row.capabilities, {
      sell: false,
      redeem: false,
      hide: false,
    });
    assert.equal("positionContract" in row, false);
    assert.equal("assetContext" in row, false);
  }
});

test("account/market identity survives user merge and isolates owners/environments/sides", () => {
  const first = projectHip4PortfolioPositions(input);
  assert.notEqual(first[0].id, first[1].id);
  assert.equal(
    projectHip4PortfolioPositions({
      ...input,
      userId: "merged-user",
      address: input.address.toLowerCase(),
    })[0].id,
    first[0].id,
  );
  assert.notEqual(
    projectHip4PortfolioPositions({
      ...input,
      address: `0x${"B".repeat(40)}`,
    })[0].id,
    first[0].id,
  );
  assert.throws(
    () => projectHip4PortfolioPositions({ ...input, environment: "testnet" }),
    /identity_conflict/,
  );
  assert.throws(
    () =>
      projectHip4PortfolioPositions({
        ...input,
        observation: {
          ...observation,
          positions: [{ ...observation.positions[0], sideIndex: 1 }],
        },
      }),
    /identity_conflict/,
  );
});

test("stale snapshots preserve holdings but never current value; missing metadata does not delete them", () => {
  const stale = projectHip4PortfolioPositions({ ...input, now: now + 60000 });
  assert.equal(stale.length, 2);
  assert.equal(stale[0].observation.state, "stale");
  assert.equal(stale[0].valuation.marketValue, null);
  const missing = projectHip4PortfolioPositions({
    ...input,
    markets: new Map(),
  });
  assert.equal(missing.length, 2);
  assert.equal(missing[0].marketSummary, null);
  assert.equal(missing[0].valuation.marketValue, null);
  assert.equal(
    projectHip4PortfolioPositions({ ...input, now: now - 1 })[0].observation
      .state,
    "stale",
  );
});

test("closed/proposed extreme marks are pending; only official fractional payout values a holding", () => {
  const closed = structuredClone(market);
  closed.status = "expired";
  closed.sides[0].bid = "1";
  closed.sides[0].ask = "1";
  const rows = () =>
    projectHip4PortfolioPositions({
      ...input,
      markets: new Map([[closed.marketId, closed]]),
    });
  assert.equal(rows()[0].valuation.marketValue, null);
  closed.status = "settled";
  closed.settlement = {
    source: "settledOutcome",
    observedAt: new Date(now).toISOString(),
    details: "fractional",
  };
  closed.sides[0].payout = "0.25";
  closed.sides[1].payout = "0.75";
  assert.equal(rows()[0].valuation.marketValue, "5.0000025");
  assert.equal(rows()[1].valuation.marketValue, "7.5");
  assert.equal(rows()[0].realizedPnl, null);
  closed.sides[0].payout = "0";
  assert.equal(rows()[0].valuation.marketValue, "0");
});

test("marks need their own valid observation, matching identity and proven quote units", () => {
  for (const mutate of [
    (row: typeof market) => {
      row.sides[0].bookValidUntil = new Date(now).toISOString();
    },
    (row: typeof market) => {
      row.sides[0].bookAt = new Date(now + 1).toISOString();
    },
    (row: typeof market) => {
      row.sides[0].bid = "0.9";
    },
    (row: typeof market) => {
      row.sides[0].coin = "#9990";
    },
    (row: typeof market) => {
      row.metadataValidUntil = new Date(now).toISOString();
    },
    (row: typeof market) => {
      row.quoteToken = "UNKNOWN";
    },
    (row: typeof market) => {
      row.fetchedAt = new Date(now + 1).toISOString();
    },
    (row: typeof market) => {
      row.environment = "testnet";
    },
  ]) {
    const altered = structuredClone(market);
    mutate(altered);
    const row = projectHip4PortfolioPositions({
      ...input,
      markets: new Map([[altered.marketId, altered]]),
    })[0];
    assert.equal(row.valuation.marketValue, null);
    assert.equal(row.sizeRaw, "20.00001");
  }
});

test("non-EVM scopes do not depend on HIP policy or erase other venue PnL", async () => {
  const result = await readHip4PortfolioPositions(
    {
      query: async () => {
        throw new Error("must_not_query");
      },
    },
    { userId: "u", walletAddresses: ["solana-wallet"] },
  );
  assert.equal(result.coverage.state, "ready");
  assert.equal(result.coverage.accounts, 0);
  assert.equal(result.coverage.policyRevision, null);
});
