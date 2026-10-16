import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hip4TrackedFillFingerprint,
  hip4WalletIntelIdentity,
  normalizeHip4KnownWalletFill,
  projectHip4KnownWalletIntel,
} from "./services/hip4-wallet-intel.js";
import { walletFollowBodySchema } from "./schemas/wallet-intel.js";

const identity = hip4WalletIntelIdentity(
  "mainnet",
  "0x000000000000000000000000000000000000Ab12",
);
const now = Date.parse("2026-10-16T12:00:00.000Z");
const observedAt = new Date(now).toISOString();
const fill = (overrides: Record<string, unknown> = {}) => ({
  coin: "#410",
  px: "0.125",
  sz: "8",
  side: "B",
  time: now - 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "0",
  hash: `0x${"1".repeat(64)}`,
  oid: 100,
  crossed: true,
  fee: "-0.001",
  tid: 200,
  feeToken: "USDC",
  ...overrides,
});
const observation = (value: unknown) => ({
  available: true as const,
  observedAt,
  value,
});
const inputs = () => ({
  identity,
  role: { role: "user" },
  abstraction: "disabled",
  quote: { tokenId: "quote-usdc", index: 0, weiDecimals: 8 },
  positions: observation({
    balances: [{ coin: "+410", total: "8", hold: "2", entryNtl: "1" }],
  }),
  openOrders: observation([]),
  fills: observation([fill()]),
  quoteTokensByMarket: new Map([["hyperliquid:mainnet:outcome:41", "USDC"]]),
});

test("known-wallet chains isolate environments without accepting funding network aliases", () => {
  assert.equal(identity.chain, "hypercore:mainnet");
  assert.equal(identity.address, "0x000000000000000000000000000000000000ab12");
  for (const chain of ["hypercore:mainnet", "hypercore:testnet"])
    assert(
      walletFollowBodySchema.safeParse({ address: identity.address, chain })
        .success,
    );
  for (const chain of ["hyperliquid:mainnet", "ethereum", "hypercore"])
    assert(
      !walletFollowBodySchema.safeParse({ address: identity.address, chain })
        .success,
    );
  assert.notEqual(
    identity.chain,
    hip4WalletIntelIdentity("testnet", identity.address).chain,
  );
  assert.throws(() =>
    hip4WalletIntelIdentity("mainnet", "0x" + "0".repeat(40)),
  );
  assert.throws(() => hip4WalletIntelIdentity("mainnet", "not-an-account"));
});

test("native fill identity preserves tied fills, exact side and money, and replay", () => {
  const input = inputs();
  input.fills = observation([
    fill(),
    fill(),
    fill({ tid: 201 }),
    fill({ coin: "#411" }),
  ]);
  const result = projectHip4KnownWalletIntel(input);
  assert.equal(result.activities.length, 3);
  assert.equal(
    new Set(result.activities.map((row) => row.sourceEventKey)).size,
    3,
  );
  const primary = result.activities.find(
    (row) => row.tradeId === "200" && row.outcomeSide === "YES",
  );
  assert.ok(primary);
  assert.equal(primary.sizeUsd, "1");
  assert.equal(primary.fee, "-0.001");
  assert.equal(primary.tokenId, "hyperliquid:mainnet:410");
  assert.equal(primary.deltaShares, "8");
  assert.equal(new Set(result.activities.map((row) => row.occurredAt)).size, 1);
  const repeated = projectHip4KnownWalletIntel(input);
  assert.deepEqual(result.activities, repeated.activities);
  assert.equal(result.coverage.scope, "known_wallet_only");
  assert.equal(result.coverage.fills.completeHistory, false);
  assert.equal(result.coverage.globalHolders.status, "unavailable");
  assert.equal(result.coverage.historicalPerformance.status, "unavailable");
});

test("USD value is unknown without authoritative outcome quote metadata", () => {
  const parsed = normalizeHip4KnownWalletFill({
    identity,
    value: fill(),
    observedAt,
  });
  assert.equal(parsed.kind, "trade");
  if (parsed.kind !== "trade") return;
  assert.equal(parsed.activity.sizeUsd, null);
  assert.equal(parsed.activity.quoteNotional, "1");
  assert.equal(parsed.activity.quoteToken, null);
  const priced = normalizeHip4KnownWalletFill({
    identity,
    value: fill(),
    observedAt,
    quoteTokensByMarket: inputs().quoteTokensByMarket,
  });
  assert.equal(priced.kind, "trade");
  if (priced.kind === "trade")
    assert.equal(
      hip4TrackedFillFingerprint(parsed.activity),
      hip4TrackedFillFingerprint(priced.activity),
    );
});

test("native account projection does not convert balances or open orders into outcome trades", () => {
  const input = inputs();
  input.fills = observation([
    fill({ coin: "BTC", dir: "Liquidated Cross Long" }),
    fill({ dir: "Settlement" }),
    fill({ dir: "Merge Outcome" }),
    fill({ dir: "Future native kind" }),
  ]);
  const result = projectHip4KnownWalletIntel(input);
  assert.equal(result.activities.length, 0);
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].costBasis, null);
  assert.equal(result.positions[0].realizedPnl, null);
  assert.equal(result.canReplacePreviousPositions, true);
});

test("conflicting same fill identity is diagnostic and neither version wins", () => {
  const input = inputs();
  input.fills = observation([fill(), fill({ px: "0.25" }), fill({ tid: 202 })]);
  const result = projectHip4KnownWalletIntel(input);
  assert.equal(result.activities.length, 1);
  assert.equal(result.activities[0].tradeId, "202");
  assert.equal(result.coverage.fills.conflictingIdentities, 1);
  assert.equal(result.coverage.fills.reason, "conflicting_fill_identity");
  assert.equal(result.positions.length, 1);
});

test("failed history and unresolved balance coverage do not erase independently useful positions", () => {
  const input = inputs();
  const result = projectHip4KnownWalletIntel({
    ...input,
    fills: {
      available: false,
      attemptedAt: observedAt,
      reason: "budget_exhausted",
    },
  });
  assert.equal(result.positions.length, 1);
  assert.equal(result.coverage.fills.status, "unavailable");
  assert.equal(result.coverage.fills.reason, "budget_exhausted");
  const partial = projectHip4KnownWalletIntel({
    ...input,
    positions: observation({
      balances: [
        { coin: "+410", total: "8", hold: "0", entryNtl: "1" },
        { coin: "o41", total: "3", hold: "0", entryNtl: "0" },
      ],
    }),
  });
  assert.equal(partial.positions.length, 1);
  assert.equal(partial.canReplacePreviousPositions, false);
  assert.equal(partial.coverage.positions.status, "partial");
  const roleFailure = projectHip4KnownWalletIntel({
    ...input,
    role: null,
    roleFailure: "budget_exhausted",
  });
  assert.equal(roleFailure.coverage.positions.reason, "budget_exhausted");
  assert.equal(roleFailure.coverage.accountRole, "unknown");
});

test("agent/subaccount/vault roles are explicit unavailable accounts, never owner grants", () => {
  for (const role of [
    { role: "agent", data: { user: identity.address } },
    { role: "subAccount", data: { master: identity.address } },
    { role: "vault" },
  ]) {
    const result = projectHip4KnownWalletIntel({ ...inputs(), role });
    assert.equal(result.activities.length, 0);
    assert.equal(result.positions.length, 0);
    assert.equal(result.canReplacePreviousPositions, false);
    assert.equal(result.coverage.positions.reason, "unsupported_account_role");
    assert.equal(result.coverage.accountRole, role.role);
  }
});

test("provider cap counts non-outcome rows; malformed future/conflicting actions remain partial", () => {
  const input = inputs();
  input.fills = observation(
    Array.from({ length: 2000 }, () => fill({ coin: "BTC" })),
  );
  assert.equal(
    projectHip4KnownWalletIntel(input).coverage.fills.providerCapped,
    true,
  );
  input.fills = observation([
    fill({ side: "A" }),
    fill({ time: now + 1 }),
    fill({ sz: "0" }),
    fill({ tid: 202 }),
  ]);
  const result = projectHip4KnownWalletIntel(input);
  assert.equal(result.coverage.fills.invalidRows, 3);
  assert.equal(result.activities.length, 1);
  assert.equal(result.coverage.fills.status, "partial");
});
