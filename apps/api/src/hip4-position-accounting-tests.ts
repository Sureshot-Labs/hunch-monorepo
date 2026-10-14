import assert from "node:assert/strict";
import { test } from "node:test";
import { projectHip4PositionBasis } from "./services/hip4-position-accounting.js";

const buy = {
  coin: "#87750",
  px: "0.4",
  sz: "10",
  side: "B",
  time: 1000,
  startPosition: "0",
  dir: "Buy",
  closedPnl: "999",
  hash: `0x${"1".repeat(64)}`,
  oid: 1,
  tid: 1,
  crossed: true,
  fee: "0.1",
  feeToken: "USDC",
  builderFee: "0.05",
};
const second = {
  ...buy,
  oid: 2,
  tid: 2,
  time: 2000,
  startPosition: "10",
  px: "0.6",
};
const sale = {
  ...buy,
  oid: 3,
  tid: 3,
  time: 3000,
  dir: "Sell",
  side: "A",
  startPosition: "20",
  sz: "5",
  px: "0.8",
  fee: "0.05",
};
const input = {
  positions: [{ coin: "+87750", quantity: "15" }],
  fills: [buy, second, sale],
  ledger: [],
  quoteLedgerToken: "USDC:exact-quote-id",
  observedTime: 4000,
  coveredFrom: 0,
  coveredThrough: 4000,
  gaps: [],
  incomplete: false,
};
test("zero-anchor weighted basis retains exact buy fees, releases partial basis and never adds builder fee twice", () => {
  const result = projectHip4PositionBasis(input)[0];
  assert.equal(result.reason, "verified");
  assert.equal(result.costBasis, "7.65");
  assert.equal(result.realizedSinceAnchor, "1.4");
  assert.equal(result.anchorTime, 1000);
  assert.deepEqual(
    projectHip4PositionBasis({ ...input, fills: [...input.fills, buy] }),
    [result],
  );
  assert.deepEqual(
    projectHip4PositionBasis({
      ...input,
      fills: [...input.fills, { ...buy, px: "0.400", sz: "10.00000" }],
    }),
    [result],
  );
});
test("tied timestamps use startPosition chain and ambiguous aliases never inflate financial totals", () => {
  const sameTime = { ...second, time: buy.time };
  assert.equal(
    projectHip4PositionBasis({ ...input, fills: [sameTime, buy, sale] })[0]
      .costBasis,
    "7.65",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, fills: [buy, { ...buy, tid: 99 }] })[0]
      .reason,
    "ambiguous_execution_sequence",
  );
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      positions: [{ coin: "+87750", quantity: "10" }],
      fills: [buy, { ...buy, px: "0.9" }],
    })[0].reason,
    "execution_identity_conflict",
  );
});
test("settlement uses fractional actual proceeds, while missing valuation is not handled by the ledger", () => {
  const result = projectHip4PositionBasis({
    ...input,
    fills: [buy, second, { ...sale, dir: "Settlement", px: "0.25" }],
  })[0];
  assert.equal(result.costBasis, "7.65");
  assert.equal(result.realizedSinceAnchor, "-1.35");
});
test("merge, negate, expansion, transfers and unproven fees stay unknown, recoverable after a new zero anchor", () => {
  for (const dir of [
    "Merge Outcome",
    "Split Outcome",
    "Negate Outcome",
    "Expansion",
    "New Kind",
  ]) {
    const result = projectHip4PositionBasis({
      ...input,
      fills: [buy, second, { ...sale, dir }],
    })[0];
    assert.equal(result.costBasis, null);
    assert.equal(result.reason, "unsupported_economic_event");
  }
  for (const delta of [
    { type: "spotTransfer", token: "+87750" },
    { type: "futureKind" },
  ]) {
    assert.equal(
      projectHip4PositionBasis({ ...input, ledger: [{ time: 2000, delta }] })[0]
        .reason,
      "unsupported_economic_event",
    );
  }
  const quoteTransfer = {
    time: 2000,
    delta: { type: "send", token: input.quoteLedgerToken },
  };
  assert.equal(
    projectHip4PositionBasis({ ...input, ledger: [quoteTransfer] })[0]
      .costBasis,
    "7.65",
  );
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      fills: [buy, second, { ...sale, feeToken: "" }],
    })[0].reason,
    "unknown_fee_asset",
  );
  const reset = { ...buy, time: 3500, oid: 9, tid: 9, sz: "15" };
  const recovered = projectHip4PositionBasis({
    ...input,
    fills: [buy, { ...second, dir: "Negate Outcome" }, reset],
  })[0];
  assert.equal(recovered.reason, "verified");
  assert.equal(recovered.costBasis, "6.1");
  assert.equal(recovered.anchorTime, 3500);
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      fills: [reset],
      conflicts: { "#87750": 2000 },
    })[0].reason,
    "verified",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, conflicts: { "#87750": 2000 } })[0]
      .reason,
    "execution_identity_conflict",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, conflicts: { "#87751": 2000 } })[0]
      .reason,
    "verified",
  );
});
test("history gaps, missing source, provider retention and balance mismatches cannot prove a zero-cost position", () => {
  for (const partial of [
    { incomplete: true },
    { coveredFrom: null },
    { coveredThrough: 3999 },
    { coveredFrom: 1500 },
    { gaps: [2500] },
    { fills: [null] },
  ])
    assert.equal(
      projectHip4PositionBasis({ ...input, ...partial })[0].reason,
      "history_incomplete",
    );
  assert.equal(
    projectHip4PositionBasis({ ...input, gaps: [500] })[0].reason,
    "verified",
  );
  assert.equal(
    projectHip4PositionBasis({ ...input, fills: [second, sale] })[0].costBasis,
    null,
  );
  assert.equal(
    projectHip4PositionBasis({
      ...input,
      positions: [{ coin: "+87750", quantity: "16" }],
    })[0].reason,
    "position_mismatch",
  );
});
test("opposite side legs sharing a hash are distinct holdings, not hash-level duplicates", () => {
  const no = { ...buy, coin: "#87751", tid: 2, oid: 2, px: "0.6" };
  const results = projectHip4PositionBasis({
    ...input,
    positions: [
      { coin: "+87750", quantity: "10" },
      { coin: "+87751", quantity: "10" },
    ],
    fills: [buy, no],
  });
  assert.deepEqual(
    results.map((row) => row.costBasis),
    ["4.1", "6.1"],
  );
});
