import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  buildPolymarketAssetContext,
  POLYMARKET_PROTOCOL_CONTRACTS as contracts,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { buildPolymarketAssetBindings } from "@hunch/db";
import { env } from "./env.js";
import {
  selectPolymarketSyncedOrderContext,
  type PolymarketHoldingLedger,
} from "./services/polymarket-asset-context.js";
import { polymarketTradingExecutionTestHooks as hooks } from "./services/polymarket-trading-execution-service.js";

const marketId = "polymarket:order-recovery-fixture";
const condition = (1n << 248n) | (0xaan << 120n);
const conditionId = `0x${condition.toString(16).padStart(64, "0")}`;
const legacy = resolvePolymarketMarketAssets({
  version: "v1",
  conditionId,
  clobTokenIds: [condition.toString(), (condition | 1n).toString()],
  outcomes: ["Yes", "No"],
  negRisk: true,
});
const current = resolvePolymarketMarketAssets({
  version: "v2",
  conditionId,
  positionIds: legacy.assets,
  outcomes: ["Yes", "No"],
  negRisk: false,
});
const v1 = buildPolymarketAssetContext(marketId, legacy, legacy.assets[0]);
const v2 = buildPolymarketAssetContext(marketId, current, current.assets[0]);
const ledger = (context: typeof v1): PolymarketHoldingLedger => ({
  contractAddress: context.positionContract,
  storageContract:
    context.protocolVersion === "v1"
      ? ""
      : context.positionContract.toLowerCase(),
  tokenContexts: new Map([[context.assetId, context]]),
});
assert.equal(
  selectPolymarketSyncedOrderContext([ledger(v2)], v2.assetId, v2.conditionId),
  v2,
);
assert.equal(
  selectPolymarketSyncedOrderContext([ledger(v1)], v1.assetId, null),
  v1,
);
assert.equal(selectPolymarketSyncedOrderContext([], "7", null), null);
assert.throws(
  () =>
    selectPolymarketSyncedOrderContext(
      [ledger(v1), ledger(v2)],
      v2.assetId,
      v2.conditionId,
    ),
  /unambiguous/,
);
assert.throws(
  () =>
    selectPolymarketSyncedOrderContext(
      [ledger(v2)],
      v2.assetId,
      `0x${"ff".repeat(32)}`,
    ),
  /unambiguous/,
);
const oldCondition = { ...v1, conditionId: `0x${"aa".repeat(32)}` };
assert.equal(
  selectPolymarketSyncedOrderContext(
    [ledger(oldCondition), ledger(v2)],
    v2.assetId,
    oldCondition.conditionId,
  ),
  oldCondition,
);
assert.equal(
  selectPolymarketSyncedOrderContext(
    [ledger(oldCondition), ledger(v2)],
    v2.assetId,
    v2.conditionId,
  ),
  v2,
);
const [binding] = buildPolymarketAssetBindings({
  id: marketId,
  venue: "polymarket",
  metadata: { polymarketProtocol: legacy },
});
assert.ok(binding);
let bindingReads = 0;
let marketReads = 0;
const frozenDb = {
  query: async (sql: string, params: unknown[]) => {
    assert.match(sql, /from polymarket_asset_bindings/);
    assert.deepEqual(params, [
      137,
      legacy.assets[0],
      contracts.conditionalTokens.toLowerCase(),
    ]);
    bindingReads++;
    return { rows: [binding] };
  },
} as unknown as Pool;
const contextlessOrder = {
  tokenId: legacy.assets[0],
  // This pre-migration CLOB shape still uses domain 2, not protocol V2/domain 3.
  timestamp: "1",
  metadata: "0x00",
  builder: "0x00",
};
assert.equal(
  await hooks.resolveOrderExchangeAddress(
    { tokenId: ` ${legacy.assets[0]} `, orderPayload: contextlessOrder },
    frozenDb,
  ),
  contracts.negRiskExchangeV2,
);
assert.equal(bindingReads, 1);

// Exact stored context takes precedence without any current-market lookup.
for (const protocol of [legacy, current]) {
  const context = buildPolymarketAssetContext(
    marketId,
    protocol,
    protocol.assets[0],
  );
  const inputs = {
    tokenId: context.assetId,
    orderPayload: { ...contextlessOrder, assetContext: context },
  };
  assert.equal(
    await hooks.resolveOrderExchangeAddress(inputs, frozenDb),
    context.exchangeAddress,
  );
  await assert.rejects(
    hooks.resolveOrderExchangeAddress(
      { ...inputs, tokenId: protocol.assets[1] },
      frozenDb,
    ),
    /recovery scope/,
  );
  await assert.rejects(
    hooks.resolveOrderExchangeAddress(
      { ...inputs, explicitExchangeAddress: contracts.router },
      frozenDb,
    ),
    /recovery scope/,
  );
}
assert.equal(bindingReads, 1);
await assert.rejects(
  hooks.resolveOrderExchangeAddress(
    {
      tokenId: legacy.assets[0],
      orderPayload: { assetContext: { protocolVersion: "v2" } },
    },
    frozenDb,
  ),
  /inconsistent/,
);
await assert.rejects(
  hooks.resolveOrderExchangeAddress(
    { tokenId: legacy.assets[0], orderPayload: contextlessOrder },
    {
      query: async () => ({
        rows: [{ ...binding, exchange_address: contracts.exchangeV3 }],
      }),
    } as unknown as Pool,
  ),
  /binding is inconsistent/,
);

// No binding yet: retain legacy current-metadata/default/explicit behavior.
for (const negRisk of [true, false, null]) {
  const db = {
    query: async (sql: string) => {
      if (sql.includes("from polymarket_asset_bindings")) return { rows: [] };
      marketReads++;
      return { rows: negRisk == null ? [] : [{ neg_risk: negRisk }] };
    },
  } as unknown as Pool;
  assert.equal(
    await hooks.resolveOrderExchangeAddress(
      { tokenId: "7", orderPayload: { tokenId: "7" } },
      db,
    ),
    negRisk
      ? env.polymarketNegRiskExchangeAddress
      : env.polymarketExchangeAddress,
  );
}
assert.equal(marketReads, 4);
assert.equal(
  await hooks.resolveOrderExchangeAddress(
    { explicitExchangeAddress: env.polymarketNegRiskExchangeAddress },
    frozenDb,
  ),
  env.polymarketNegRiskExchangeAddress,
);
assert.equal(
  await hooks.resolveOrderExchangeAddress({}, frozenDb),
  env.polymarketExchangeAddress,
);
assert.equal(bindingReads, 1);
console.log(
  "[polymarket-order-recovery-context] frozen legacy exchange, stored V2 context, collisions and fallbacks passed",
);
