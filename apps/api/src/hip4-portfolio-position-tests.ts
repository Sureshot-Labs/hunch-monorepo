import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { projectHip4AccountValue } from "./account-value/hip4-account-value.js";
import { projectAccountValue } from "./account-value/account-value-projector.js";
import { accountAssetsResponseSchema } from "./schemas/account-value.js";
import { hip4Identity } from "@hunch/shared";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { projectHip4Account } from "./services/hip4-account-projection.js";
import { mapHip4Market } from "./services/hip4-mapping.js";
import {
  projectHip4PortfolioPositions,
  readHip4PortfolioPositions,
  type Hip4OwnedPortfolioRead,
} from "./services/hip4-portfolio-positions.js";
import {
  mergePositionPnlSummary,
  EMPTY_LEGACY_POSITION_PNL,
  unavailableHip4PositionRead,
} from "./services/position-read-scope.js";

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
  quote: { tokenId: HYPERCORE_MAINNET_USDC.assetId, index: 0, weiDecimals: 8 },
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

test("verified current-lot basis joins only its exact snapshot and expires PnL with the mark", () => {
  const accounting = {
    version: 1,
    observedAt: observation.observedAt,
    method: "observed_zero_anchor_weighted_average",
    feeTreatment: "buy_fees_in_basis_sell_fees_in_realized",
    allTimeComplete: false,
    positions: [
      {
        coin: "+87750",
        quantity: "20.00001",
        costBasis: "10.000005",
        realizedSinceAnchor: "1",
        anchorTime: now - 1000,
        reason: "verified",
      },
    ],
  };
  const rows = projectHip4PortfolioPositions({ ...input, accounting });
  assert.equal(rows[0].costBasisRaw, "10.000005");
  assert.equal(rows[0].averagePriceRaw, "0.5");
  assert.equal(rows[0].unrealizedPnlRaw, "2.000001");
  assert.equal(rows[0].realizedPnl, null);
  assert.equal(rows[1].costBasisRaw, null);
  const summaryInput = {
    positions: [rows[0]],
    coverage: {
      ...unavailableHip4PositionRead().coverage,
      state: "ready" as const,
      accounts: 1,
    },
  };
  const summary = mergePositionPnlSummary(
    EMPTY_LEGACY_POSITION_PNL,
    summaryInput,
  );
  assert.equal(summary.unrealizedCostBasisCurrent, 10.000005);
  assert.equal(summary.unrealizedPnlCurrent, 2.000001);
  assert.equal(summary.realizedPnlAllTime, null);
  const unpriced = mergePositionPnlSummary(EMPTY_LEGACY_POSITION_PNL, {
    ...summaryInput,
    positions: [{ ...rows[0], unrealizedPnl: null }],
    coverage: { ...summaryInput.coverage, unpricedPositions: 1 },
  });
  assert.equal(unpriced.unrealizedCostBasisCurrent, 10.000005);
  assert.equal(unpriced.unrealizedPnlCurrent, null);
  assert.equal(unpriced.unrealizedPnlPercentCurrent, null);
  assert.equal(
    projectHip4PortfolioPositions({ ...input, accounting, now: now + 30000 })[0]
      .unrealizedPnl,
    null,
  );
  assert.equal(
    projectHip4PortfolioPositions({
      ...input,
      accounting: {
        ...accounting,
        observedAt: new Date(now - 1).toISOString(),
      },
    })[0].costBasisRaw,
    null,
  );
  assert.equal(
    projectHip4PortfolioPositions({
      ...input,
      accounting: {
        ...accounting,
        positions: [{ ...accounting.positions[0], quantity: "99" }],
      },
    })[0].costBasisRaw,
    null,
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

function accountRead(observed = observation, at = now): Hip4OwnedPortfolioRead {
  return {
    environment: "mainnet",
    snapshotMaxAgeMs: 60000,
    accounts: [{ address: input.address, observation: observed }],
    positions: projectHip4PortfolioPositions({
      ...input,
      observation: observed,
      now: at,
    }),
    coverage: {
      state: "ready",
      policyRevision: "test",
      accounts: 1,
      missingAccounts: 0,
      staleAccounts: 0,
      unresolvedBalances: 0,
      missingCostBasis: 2,
      unpricedPositions: 0,
    },
  };
}

test("Account Value shares native side marks and counts held cash once without funding authority", () => {
  const observed = structuredClone(observation);
  Object.assign(observed.cash, {
    total: "23.00000001",
    held: "3",
    unheld: "20.00000001",
    ownedCash: "20.00000001",
  });
  const result = projectHip4AccountValue({
    userId: input.userId,
    read: accountRead(observed),
    now,
  });
  assert.equal(result.assets[0].amount.raw, "2300000001");
  assert.equal(result.assets[0].estimatedUsd?.value, "23.00000001");
  assert.equal(result.assets[0].executionEligibility, "ineligible");
  assert.equal(result.assets[0].location.kind, "venue_account");
  assert.equal(
    result.assets[0].location.asset.networkId,
    "hyperliquid:mainnet",
  );
  assert.equal(result.assets[0].location.details.controllerWalletId, null);
  assert.equal(result.assets[0].location.details.ownedTotal, "23.00000001");
  assert.equal(result.assets[0].location.details.held, "3");
  assert.equal(result.assets[0].location.details.unheld, "20.00000001");
  assert.equal(
    result.assets[0].location.details.positionCount,
    observed.positions.length,
  );
  assert.equal(result.positions[0].estimatedUsd?.value, "12.000006");
  assert.equal(result.positions[1].estimatedUsd?.value, "3");
  assert.ok(result.positions.every((row) => row.positionActionRef === null));
  const projected = projectAccountValue({
    accountId: input.userId,
    headlineMode: "liquid_plus_positions",
    components: result.assets,
    positionComponents: result.positions,
    collectorErrors: result.errors,
    asOf: observation.observedAt,
  });
  assert.equal(projected.totalPortfolioEstimatedUsd, "38.00000601");
  assert.equal(projected.valuationCompleteness, "complete");
  accountAssetsResponseSchema.parse({
    ok: true,
    asOf: projected.asOf,
    valuationCompleteness: projected.valuationCompleteness,
    valuationFreshness: projected.valuationFreshness,
    collectorErrors: result.errors,
    items: [...result.assets, ...result.positions],
    total: 3,
    nextCursor: null,
  });
});

test("Account Value excludes testnet and disabled reads, then recovers on the next snapshot", () => {
  const read = accountRead();
  const project = () =>
    projectHip4AccountValue({ userId: input.userId, read, now });
  read.environment = "testnet";
  assert.deepEqual(project(), {
    assets: [],
    positions: [],
    errors: [],
    availability: [],
  });
  read.environment = "mainnet";
  read.coverage.state = "disabled";
  assert.equal(project().positions.length, 0);
  read.coverage.state = "ready";
  assert.equal(project().positions[0].estimatedUsd?.value, "12.000006");
});

test("Account Value never turns stale, missing, margin or borrowed facts into net owned dollars", () => {
  for (const at of [now - 1, now + 60000]) {
    const result = projectHip4AccountValue({
      userId: input.userId,
      read: accountRead(observation, at),
      now: at,
    });
    assert.equal(result.assets[0].estimatedUsd, null);
    assert.ok(result.positions.every((row) => row.estimatedUsd === null));
  }
  for (const mutate of [
    (row: typeof observation) => {
      row.mode = "portfolioMargin";
    },
    (row: typeof observation) => {
      row.mode = "default";
    },
    (row: typeof observation) => {
      row.mode = "dexAbstraction";
    },
    (row: typeof observation) => {
      row.mode = "unifiedAccount";
      row.cash.borrowed = null;
    },
    (row: typeof observation) => {
      row.cash.borrowed = "1";
    },
    (row: typeof observation) => {
      row.cash.total = "-1";
    },
    (row: typeof observation) => {
      row.cash.ownedCash = "999";
    },
    (row: typeof observation) => {
      row.cash.held = "1";
    },
  ]) {
    const observed = structuredClone(observation);
    mutate(observed);
    const result = projectHip4AccountValue({
      userId: input.userId,
      read: accountRead(observed),
      now,
    });
    assert.ok(result.assets.every((row) => row.estimatedUsd === null));
    assert.ok(result.positions.every((row) => row.estimatedUsd === null));
    assert.ok(
      result.errors.some((error) => error.code === "owned_cash_unverified"),
    );
  }
  const missing = accountRead();
  missing.accounts[0].observation = null;
  missing.positions = [];
  const result = projectHip4AccountValue({
    userId: input.userId,
    read: missing,
    now,
  });
  assert.ok(
    result.errors.some((error) => error.code === "position_inventory_unknown"),
  );
});

test("zero, unified debt-free cash and official fractional payouts are not missing valuations", () => {
  const observed = structuredClone(observation);
  observed.mode = "unifiedAccount";
  observed.cash.borrowed = "0";
  const read = accountRead(observed);
  read.positions[0].valuation = {
    markPrice: "0.25",
    marketValue: "5.0000025",
    source: "official_payout",
    observedAt: observation.observedAt,
    validUntil: new Date(now + 30000).toISOString(),
  };
  read.positions[1].valuation = {
    ...read.positions[0].valuation,
    markPrice: "0",
    marketValue: "0",
  };
  const result = projectHip4AccountValue({ userId: input.userId, read, now });
  assert.equal(result.assets[0].estimatedUsd?.value, "0");
  assert.equal(result.positions[0].estimatedUsd?.value, "5.0000025");
  assert.equal(result.positions[1].estimatedUsd?.value, "0");
  assert.equal(result.positions[1].valuationEligibility, "included");
});

test("a native position value without observation provenance is not an account estimate", () => {
  const read = accountRead();
  read.positions[0].valuation.observedAt = null;
  const result = projectHip4AccountValue({ userId: input.userId, read, now });
  assert.equal(result.positions[0].estimatedUsd, null);
  assert.equal(result.positions[0].valuationEligibility, "unpriced");
});
