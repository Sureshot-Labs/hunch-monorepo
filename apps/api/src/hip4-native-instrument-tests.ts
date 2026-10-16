import assert from "node:assert/strict";
import { test } from "node:test";
import { hip4Identity, type Hip4ReadMarket } from "@hunch/shared";
import { hip4OrderTestMarket } from "./hip4-order-test-fixture.js";
import {
  buildHip4NativeInstrument,
  currentHip4NativeInstrument,
  hip4NativeExpiryOpen,
  hip4NativeMarketOpen,
} from "./services/hip4-native-instrument.js";

const now = Date.parse("2026-10-16T12:00:00.000Z");
const identity = hip4Identity("mainnet", 8775);
const futureExpiry = new Date(now + 60000).toISOString();

test("native expiry availability distinguishes explicit null from missing, malformed and elapsed values", () => {
  assert.equal(hip4NativeExpiryOpen(null, now), true);
  assert.equal(hip4NativeExpiryOpen(futureExpiry, now), true);
  for (const expiry of [
    undefined,
    "",
    " ",
    "invalid",
    new Date(now).toISOString(),
    new Date(now - 1).toISOString(),
    0,
    new Date(now + 60000),
  ])
    assert.equal(hip4NativeExpiryOpen(expiry, now), false);
  for (const invalidClock of [NaN, Infinity, -Infinity]) {
    assert.equal(hip4NativeExpiryOpen(null, invalidClock), false);
    assert.equal(hip4NativeExpiryOpen(futureExpiry, invalidClock), false);
  }
});

function snapshot() {
  return hip4OrderTestMarket(identity, now);
}

function current(
  market = snapshot(),
  outcome: "YES" | "NO" = "YES",
  expiry = market.expiry,
) {
  return currentHip4NativeInstrument({
    marketId: identity.marketId,
    tokenId: identity.sides[outcome === "YES" ? 0 : 1].tokenId,
    outcome,
    expiry,
    metadata: { hip4: market },
    status: "ACTIVE",
    now,
  });
}

test("ordinary native admissibility supports exact mainnet USDC8 identities on both sides without a known expiry", () => {
  const market = snapshot();
  assert.equal(market.expiry, null);
  assert.equal(hip4NativeMarketOpen({ hip4: market }, now), true);
  for (const outcome of ["YES", "NO"] as const) {
    const instrument = current(market, outcome);
    assert.ok(instrument);
    assert.equal(instrument.venue, "hyperliquid");
    assert.equal(instrument.marketId, identity.marketId);
    assert.equal(
      instrument.tokenId,
      identity.sides[outcome === "YES" ? 0 : 1].tokenId,
    );
    assert.equal(instrument.outcome, outcome);
    assert.equal(instrument.expiry, null);
    assert.match(
      instrument.generation,
      /^hyperliquid:instrument:v1:[a-f0-9]{64}$/u,
    );
  }
});

test("current native instruments require matching canonical and native future expiry", () => {
  const market = snapshot();
  market.expiry = futureExpiry;
  assert.equal(current(market)?.expiry, futureExpiry);
  assert.equal(current(market, "YES", null), null);
  assert.equal(
    current(market, "YES", new Date(now + 120000).toISOString()),
    null,
  );
  market.expiry = null;
  assert.equal(current(market, "YES", futureExpiry), null);
});

test("known expiry is exclusive and stale ACTIVE status cannot admit an expired native instrument", () => {
  for (const expiredAt of [now, now - 1]) {
    const market = snapshot();
    market.expiry = new Date(expiredAt).toISOString();
    assert.equal(hip4NativeMarketOpen({ hip4: market }, now), false);
    assert.equal(current(market), null);
    assert.ok(
      buildHip4NativeInstrument({
        marketId: identity.marketId,
        tokenId: identity.sides[0].tokenId,
        outcome: "YES",
        expiry: market.expiry,
        snapshot: market,
      }),
      "frozen identity remains reconstructible independently of current admission",
    );
  }
});

test("malformed and empty expiry never become the supported null-expiry contract", () => {
  for (const invalid of ["", "not-a-date"]) {
    const market = snapshot();
    market.expiry = invalid;
    assert.equal(current(market), null);
    assert.equal(
      buildHip4NativeInstrument({
        marketId: identity.marketId,
        tokenId: identity.sides[0].tokenId,
        outcome: "YES",
        expiry: invalid,
        snapshot: market,
      }),
      null,
    );
    assert.equal(current(snapshot(), "YES", invalid), null);
  }
});

test("native first admission requires fresh nonfuture metadata and unsettled observed state", () => {
  const changes: Array<(market: Hip4ReadMarket) => void> = [
    (market) => {
      market.status = "expired";
    },
    (market) => {
      market.status = "settled";
    },
    (market) => {
      market.settlement = {
        source: "settledOutcome",
        observedAt: new Date(now - 1).toISOString(),
        details: "Synthetic settlement",
      };
    },
    (market) => {
      market.coverage.metadata = "stale";
    },
    (market) => {
      market.fetchedAt = new Date(now + 1).toISOString();
    },
    (market) => {
      market.fetchedAt = "invalid";
    },
    (market) => {
      market.metadataValidUntil = undefined;
    },
    (market) => {
      market.metadataValidUntil = "invalid";
    },
    (market) => {
      market.metadataValidUntil = new Date(now).toISOString();
    },
    (market) => {
      market.metadataValidUntil = new Date(now - 1).toISOString();
    },
  ];
  for (const change of changes) {
    const market = snapshot();
    change(market);
    assert.equal(hip4NativeMarketOpen({ hip4: market }, now), false);
    assert.equal(current(market), null);
  }
  assert.equal(hip4NativeMarketOpen(null, now), false);
  assert.equal(hip4NativeMarketOpen({ hip4: {} }, now), false);
});

test("canonical closed state rejects a still-observed native snapshot", () => {
  const market = snapshot();
  for (const status of ["CLOSED", "RESOLVED", "UNKNOWN"]) {
    assert.equal(
      currentHip4NativeInstrument({
        marketId: identity.marketId,
        tokenId: identity.sides[0].tokenId,
        outcome: "YES",
        expiry: null,
        metadata: { hip4: market },
        status,
        now,
      }),
      null,
    );
  }
});

test("native admission rejects foreign environments, collateral and side identities", () => {
  const changes: Array<(market: Hip4ReadMarket) => void> = [
    (market) => {
      market.environment = "testnet";
    },
    (market) => {
      market.marketId = hip4Identity("mainnet", 8776).marketId;
    },
    (market) => {
      market.outcome++;
    },
    (market) => {
      market.quoteToken = "OTHER";
    },
    (market) => {
      market.quoteTokenId = null;
    },
    (market) => {
      market.quoteTokenId = `0x${"0".repeat(32)}`;
    },
    (market) => {
      market.quoteWeiDecimals = 6;
    },
    (market) => {
      market.sides[1] = { ...market.sides[0] };
    },
    (market) => {
      market.sides[1].tokenId = identity.sides[0].tokenId;
    },
    (market) => {
      market.sides[0].assetId++;
    },
    (market) => {
      market.sides[0].coin += "foreign";
    },
    (market) => {
      market.sides[0].tokenName += "foreign";
    },
  ];
  for (const change of changes) {
    const market = snapshot();
    change(market);
    assert.equal(current(market, "YES"), null);
    assert.equal(current(market, "NO"), null);
  }
  assert.equal(
    currentHip4NativeInstrument({
      marketId: identity.marketId,
      tokenId: identity.sides[0].tokenId,
      outcome: "NO",
      expiry: null,
      metadata: { hip4: snapshot() },
      status: "ACTIVE",
      now,
    }),
    null,
  );
});

test("raw contract condition, side labels, known expiry and legacy title revisions change the frozen native generation", () => {
  const original = current();
  assert.ok(original);
  const changes: Array<(market: Hip4ReadMarket) => void> = [
    (market) => {
      market.description += " changed resolution source";
    },
    (market) => {
      market.sides[0].label = "Different YES condition";
    },
    (market) => {
      market.sides[1].label = "Different NO condition";
    },
    (market) => {
      market.expiry = futureExpiry;
    },
    (market) => {
      market.title += " corrected legacy title";
    },
  ];
  for (const change of changes) {
    const market = snapshot();
    change(market);
    const revised = current(market);
    assert.ok(revised);
    assert.notEqual(revised.generation, original.generation);
  }
});

test("read refresh UUID, fresh timestamps and book updates do not change the native economic generation", () => {
  const original = snapshot();
  const refreshed = structuredClone(original);
  refreshed.generation = "next-replaceable-read-uuid";
  refreshed.fetchedAt = new Date(now - 1).toISOString();
  refreshed.metadataValidUntil = new Date(now + 120000).toISOString();
  refreshed.sides[0].bid = "0.49";
  refreshed.sides[0].ask = "0.51";
  refreshed.sides[0].bookState = "fresh";
  refreshed.sides[0].bookAt = new Date(now).toISOString();
  refreshed.sides[0].bookValidUntil = new Date(now + 10000).toISOString();
  for (const outcome of ["YES", "NO"] as const) {
    assert.ok(current(original, outcome));
    assert.deepEqual(current(refreshed, outcome), current(original, outcome));
  }
});
