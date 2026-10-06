import assert from "node:assert/strict";
import type { Pool } from "@hunch/infra";
import {
  buildPolymarketAssetContext,
  POLYMARKET_PROTOCOL_CONTRACTS as contracts,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { buildPolymarketAssetBindings } from "@hunch/db";
import { env } from "./env.js";
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
