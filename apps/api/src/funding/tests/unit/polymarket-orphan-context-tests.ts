import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { buildOrphanPolymarketOrderPayload } from "../../reconciliation/polymarket-orphan-attempt-reconciler.js";
import type { PolymarketOpenOrder } from "../../../services/polymarket-clob-l2.js";

const conditionId = `0x01${"00".repeat(31)}`;
const protocol = resolvePolymarketMarketAssets({
  version: "v2",
  conditionId,
  positionIds: [
    BigInt(conditionId).toString(),
    (BigInt(conditionId) | 1n).toString(),
  ],
  outcomes: ["Yes", "No"],
  negRisk: false,
});
const context = buildPolymarketAssetContext(
  "polymarket:orphan-fixture",
  protocol,
  protocol.assets[0],
);
const order = {
  assetId: context.assetId,
  market: conditionId,
} as PolymarketOpenOrder;
const payload = {
  status: "matched",
  asset_id: context.assetId,
  original_size: "1",
};
const forbiddenDb = {
  query: async () => {
    throw new Error("frozen identity must not read replaceable projection");
  },
} as unknown as Pool;
const base = {
  db: forbiddenDb,
  marketId: context.marketId,
  marketSnapshot: { positionAssetContext: context },
  order,
  payload,
};
assert.deepEqual(await buildOrphanPolymarketOrderPayload(base), {
  ...payload,
  assetContext: context,
});
for (const change of [
  { marketId: "polymarket:foreign" },
  { order: { ...order, assetId: protocol.assets[1] } },
  { order: { ...order, market: `0x${"aa".repeat(32)}` } },
  { marketSnapshot: { positionAssetContext: { protocolVersion: "v2" } } },
])
  await assert.rejects(
    () => buildOrphanPolymarketOrderPayload({ ...base, ...change }),
    /frozen ledger scope/,
  );
const binding = {
  chain_id: 137,
  position_contract: context.positionContract,
  asset_id: context.assetId,
  market_id: context.marketId,
  protocol_version: "v2",
  asset_kind: "position_manager",
  condition_id: conditionId,
  outcome_index: 0,
  neg_risk: false,
  exchange_address: context.exchangeAddress,
  order_domain_version: "3",
  conditional_asset_type: "CONDITIONAL-V2",
};
let reads = 0;
const legacySnapshotDb = {
  query: async (sql: string) => {
    reads++;
    assert.match(sql.trim(), /^select/i);
    return {
      rows: sql.includes("from polymarket_asset_bindings") ? [binding] : [],
    };
  },
} as unknown as Pool;
assert.deepEqual(
  await buildOrphanPolymarketOrderPayload({
    ...base,
    db: legacySnapshotDb,
    marketSnapshot: {},
  }),
  { ...payload, assetContext: context },
);
assert.equal(reads, 3);
assert.equal(
  await buildOrphanPolymarketOrderPayload({
    ...base,
    db: { query: async () => ({ rows: [] }) } as unknown as Pool,
    marketSnapshot: {},
  }),
  payload,
);
console.log(
  "[polymarket-orphan-context-tests] frozen matched-FOK identity, older-snapshot canonical recovery, exact scope and unknown legacy compatibility passed",
);
