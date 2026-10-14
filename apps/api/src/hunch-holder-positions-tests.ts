import assert from "node:assert/strict";
import {
  buildHunchHolderPosition,
  type HunchPositionRow,
} from "./services/hunch-holder-positions.js";
import { replayWalletPositionLedgerRows } from "./services/wallet-position-ledger.js";

const row: HunchPositionRow = {
  wallet_id: "f25ad810-cd02-4a7a-803c-6fb95eed01c7",
  market_id: "polymarket:5404885",
  outcome_side: "NO",
  shares: "24999.951542",
  size_usd: "24974.95159",
  price: "0.999",
  snapshot_at: new Date("2026-10-08T15:00:00Z"),
  wallet_snapshot_at: new Date("2026-10-14T15:00:00Z"),
  market_status: "CLOSED",
  resolved_outcome: "NO",
  resolved_outcome_pct: null,
  resolution_observed_at: new Date("2026-10-08T16:00:00Z"),
  quote_price: null,
  quote_at: null,
};
function ledger(events: Array<[string, number, number]>, source = "trade") {
  return replayWalletPositionLedgerRows(
    events.map(([action, shares, dollars], index) => ({
      walletId: row.wallet_id,
      marketId: row.market_id,
      outcomeSide: "NO",
      action,
      deltaShares: String(shares),
      sizeUsd: String(dollars),
      price: String(dollars / shares),
      source,
      occurredAt: new Date(
        `2026-10-08T${String(index).padStart(2, "0")}:00:00Z`,
      ),
      createdAt: null,
      id: String(index),
    })),
  );
}
const jd = ledger(
  [
    ["BUY", 2052.138462, 1528.843154],
    ["BUY", 13361.87077, 9954.593724],
    ["BUY", 4585.94231, 3416.527021],
    ["BUY", 5000, 2075],
  ],
  "snapshot_delta",
);
const jdResult = buildHunchHolderPosition(row, jd);
assert.equal(
  jdResult.positionSizeUsd,
  null,
  "closed holding is not resurrected as a live position",
);
assert.ok(jdResult.positionResult);
assert.ok(Math.abs(jdResult.positionResult.pnlUsd - 8024.987643) < 1e-6);
assert.equal(jdResult.positionResult?.approximate, true);
assert.equal(jdResult.positionResult?.source, "snapshot_delta");
assert.equal(jdResult.positionResult?.valuation, "resolution");
assert.equal(jdResult.positionResult?.priceAsOf, "2026-10-08T16:00:00.000Z");

const buying = ledger([["BUY", 100, 60]]);
const partial = ledger([
  ["BUY", 100, 60],
  ["SELL", 40, 32],
]);
const sold = ledger([
  ["BUY", 100, 60],
  ["SELL", 100, 80],
]);
const expected: Array<[HunchPositionRow, typeof buying, number]> = [
  [row, buying, 40],
  [{ ...row, resolved_outcome: "YES" }, buying, -60],
  [{ ...row, outcome_side: "YES", resolved_outcome: "YES" }, buying, 40],
  [row, partial, 32], // $8 realized + $24 remainder
  [{ ...row, resolved_outcome: "YES" }, partial, -28],
  [row, sold, 20],
  [{ ...row, resolved_outcome: "YES" }, sold, 20], // sale wins over later resolution
  [
    { ...row, resolved_outcome: null, resolved_outcome_pct: "2500" },
    buying,
    15,
  ],
];
for (const [input, activity, pnl] of expected) {
  assert.equal(
    buildHunchHolderPosition(input, activity).positionResult?.pnlUsd,
    pnl,
  );
}
const open: HunchPositionRow = {
  ...row,
  market_status: "ACTIVE",
  resolved_outcome: null,
  quote_price: "0.8",
  quote_at: new Date("2026-10-14T15:00:00Z"),
};
assert.equal(buildHunchHolderPosition(open, buying).positionResult?.pnlUsd, 20);
assert.equal(
  buildHunchHolderPosition(open, buying).positionResult?.valuation,
  "quote",
);
assert.equal(
  buildHunchHolderPosition({ ...open, quote_price: "0" }, buying).positionResult
    ?.pnlUsd,
  -60,
);
assert.equal(
  buildHunchHolderPosition(
    { ...open, quote_at: new Date("2026-10-07") },
    buying,
  ).positionResult?.valuation,
  "position_snapshot",
);
const noPrice = { ...open, quote_price: null, price: null };
assert.equal(
  buildHunchHolderPosition(noPrice, partial).positionResult,
  null,
  "unvalued remainder is not a realized subtotal",
);
assert.equal(
  buildHunchHolderPosition(noPrice, sold).positionResult?.pnlUsd,
  20,
);
assert.equal(
  buildHunchHolderPosition(noPrice, sold).positionResult?.valuation,
  "realized",
);
assert.equal(
  buildHunchHolderPosition(row).positionResult,
  null,
  "snapshot mark is not an invented entry price",
);
assert.equal(
  buildHunchHolderPosition(
    { ...open, market_status: "CANCELLED", quote_price: "1" },
    buying,
  ).positionResult,
  null,
);
assert.equal(
  buildHunchHolderPosition({ ...open, quote_price: "1" }, buying).positionResult
    ?.valuation,
  "quote",
  "endpoint price is not a confirmed resolution",
);
assert.equal(
  buildHunchHolderPosition({ ...open, snapshot_at: null, price: null }, buying)
    .positionResult?.pnlUsd,
  20,
  "ledger-only positions remain calculable",
);
assert.equal(
  buildHunchHolderPosition(
    { ...row, shares: "0", size_usd: "0", wallet_snapshot_at: row.snapshot_at },
    sold,
  ).positionResult?.pnlUsd,
  20,
);
console.log("hunch-holder-positions: 23 calculation assertions passed");
