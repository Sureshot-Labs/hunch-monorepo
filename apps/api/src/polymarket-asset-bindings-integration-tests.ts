// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  fetchPolymarketAssetBindings,
  preservePolymarketAssetBindings,
  upsertUnifiedEvent,
  upsertUnifiedMarket,
  upsertUnifiedMarkets,
  type UnifiedMarketRow,
} from "@hunch/db";
import {
  resolvePolymarketMarketAssets,
  buildPolymarketAssetContext,
} from "@hunch/shared";
import { fetchPolymarketMarketInfo } from "./repos/polymarket-markets.js";
import {
  resolvePolymarketAssetContext,
  readPolymarketStoredOrderContext,
} from "./services/polymarket-asset-context.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { polymarketTradingExecutionTestHooks as executionHooks } from "./services/polymarket-trading-execution-service.js";

const db = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=10000",
});
const suffix = randomUUID();
const marketId = `polymarket:protocol-bindings-${suffix}`;
const eventId = `polymarket:protocol-bindings-event-${suffix}`;
const condition =
  (1n << 248n) | (BigInt(`0x${suffix.replaceAll("-", "")}`) << 120n);
const nextCondition = condition ^ (1n << 120n);
const firstId = condition.toString();
const ids = [firstId, (BigInt(firstId) + 1n).toString()];
const nextIds = [nextCondition.toString(), (nextCondition | 1n).toString()];
const conditionId = `0x${condition.toString(16).padStart(64, "0")}`;
const nextConditionId = `0x${nextCondition.toString(16).padStart(64, "0")}`;
const legacy = resolvePolymarketMarketAssets({
  version: "v1",
  conditionId,
  clobTokenIds: ids,
  outcomes: '["Yes","No"]',
  negRisk: true,
});
const next = resolvePolymarketMarketAssets({
  version: "v2",
  conditionId: nextConditionId,
  positionIds: nextIds,
  outcomes: '["Yes","No"]',
  negRisk: false,
});
const market: UnifiedMarketRow = {
  id: marketId,
  venue: "polymarket",
  venue_market_id: `protocol-bindings-${suffix}`,
  event_id: eventId,
  title: "Protocol binding fixture",
  status: "ACTIVE",
  market_type: "binary",
  condition_id: conditionId,
  clob_token_ids: JSON.stringify(ids),
  outcomes: '["Yes","No"]',
  metadata: { polymarketProtocol: legacy },
};
const currentIds = async (table: "unified_tokens" | "unified_market_tokens") =>
  (
    await db.query(
      `select token_id from ${table} where market_id=$1 order by token_id`,
      [marketId],
    )
  ).rows
    .map((row) => row.token_id)
    .sort();

try {
  assert.equal(
    (
      await db.query(
        "select current_setting('server_version_num')::int as version",
      )
    ).rows[0].version >= 160000,
    true,
  );
  await upsertUnifiedEvent(db, {
    id: eventId,
    venue: "polymarket",
    venue_event_id: `protocol-bindings-event-${suffix}`,
    title: "Binding fixture",
    status: "ACTIVE",
  });
  await db.query(
    "insert into polymarket_events(id,title,raw) values($1,$2,'{}')",
    [eventId, "Source fixture"],
  );
  await db.query(
    "insert into polymarket_markets(id,event_id,question,condition_id,clob_token_ids,outcomes,neg_risk,raw) values($1,$2,$3,$4,$5,$6,true,$7::jsonb)",
    [
      market.venue_market_id,
      eventId,
      "Source fixture",
      conditionId,
      JSON.stringify(ids),
      market.outcomes,
      JSON.stringify({ version: "v1" }),
    ],
  );
  await upsertUnifiedMarket(db, market);
  assert.deepEqual(await currentIds("unified_tokens"), [...ids].sort());
  // Model a pre-migration row: no durable binding yet, only the stored CTF
  // projection. Its provenance must survive the very first V2 update.
  await db.query("delete from polymarket_asset_bindings where market_id=$1", [
    marketId,
  ]);
  await db.query(
    "update unified_markets set metadata = '{\"negRisk\":true}'::jsonb where id=$1",
    [marketId],
  );
  const nextMarket = {
    ...market,
    clob_token_ids: JSON.stringify(nextIds),
    metadata: { version: "v2", positionIds: nextIds, polymarketProtocol: next },
  };
  await upsertUnifiedMarkets(db, [nextMarket], { filterUnchanged: true });
  const currentInfo = await fetchPolymarketMarketInfo(db, {
    tokenId: nextIds[0],
  });
  const currentContext = await resolvePolymarketAssetContext(
    db,
    nextIds[0],
    currentInfo,
  );
  assert.equal(
    currentContext?.protocolVersion,
    "v2",
    "unified V2 context beats lagging source v1 metadata",
  );
  assert.equal(currentContext?.assetId, nextIds[0]);
  assert.equal(
    (await fetchPolymarketMarketInfo(db, { marketId }))?.protocol_metadata !=
      null,
    true,
  );
  assert.equal(
    (await fetchPolymarketMarketInfo(db, { conditionId }))?.condition_id,
    conditionId,
  );
  assert.deepEqual(await currentIds("unified_tokens"), [...nextIds].sort());
  assert.deepEqual(
    await currentIds("unified_market_tokens"),
    [...nextIds].sort(),
  );
  assert.equal(await fetchPolymarketMarketInfo(db, { tokenId: firstId }), null);
  assert.equal(
    await executionHooks.resolveOrderExchangeAddress(
      { tokenId: firstId, orderPayload: { tokenId: firstId } },
      db,
    ),
    legacy.exchangeAddress,
    "contextless neg-risk recovery keeps its exchange after V2 token replacement",
  );
  const oldBinding = await fetchPolymarketAssetBindings(db, firstId);
  assert.equal(oldBinding[0]?.protocol_version, "v1");
  assert.equal(
    oldBinding[0]?.position_contract,
    legacy.positionContract.toLowerCase(),
  );
  assert.equal(
    (await fetchPolymarketAssetBindings(db, next.assets[0]))[0]
      ?.protocol_version,
    "v2",
  );
  await preservePolymarketAssetBindings(db, [
    {
      ...market,
      metadata: {
        polymarketProtocol: {
          ...legacy,
          negRisk: true,
          exchangeAddress: "bogus",
        },
      },
    },
  ]);
  assert.deepEqual(
    await fetchPolymarketAssetBindings(db, firstId),
    oldBinding,
    "invalid/conflicting metadata cannot mutate a binding",
  );
  const before = (
    await db.query(
      "select count(*)::int as count from polymarket_asset_bindings where market_id=$1",
      [marketId],
    )
  ).rows[0].count;
  await Promise.all([
    upsertUnifiedMarkets(db, [market], { filterUnchanged: false }),
    upsertUnifiedMarkets(db, [nextMarket], { filterUnchanged: false }),
  ]);
  assert.equal(
    (
      await db.query(
        "select count(*)::int as count from polymarket_asset_bindings where market_id=$1",
        [marketId],
      )
    ).rows[0].count,
    before,
  );
  const current = (
    await db.query("select clob_token_ids from unified_markets where id=$1", [
      marketId,
    ])
  ).rows[0];
  assert.deepEqual(
    await currentIds("unified_tokens"),
    JSON.parse(current.clob_token_ids).sort(),
    "concurrent current maps match the committed market",
  );
  assert.deepEqual(
    await currentIds("unified_market_tokens"),
    await currentIds("unified_tokens"),
  );
  // Equal uint256 values on two ledgers are different identities. A token-only
  // reader receives both and must not silently pick the first result.
  const equalIdV2 = resolvePolymarketMarketAssets({
    version: "v2",
    conditionId,
    positionIds: ids,
    outcomes: '["Yes","No"]',
  });
  await preservePolymarketAssetBindings(db, [
    { ...market, metadata: { polymarketProtocol: equalIdV2 } },
  ]);
  assert.equal((await fetchPolymarketAssetBindings(db, firstId)).length, 2);
  const oldContext = buildPolymarketAssetContext(marketId, legacy, firstId);
  await assert.rejects(
    () => resolvePolymarketAssetContext(db, firstId, null),
    /ledger context/,
  );
  assert.equal(
    (await resolvePolymarketAssetContext(db, firstId, null, oldContext))
      ?.protocolVersion,
    "v1",
  );
  await upsertUnifiedMarket(db, {
    ...market,
    metadata: {
      version: "v2",
      positionIds: ids,
      polymarketProtocol: equalIdV2,
    },
  });
  const collisionInfo = await fetchPolymarketMarketInfo(db, {
    tokenId: firstId,
  });
  assert.equal(collisionInfo?.neg_risk, false);
  assert.equal(
    await executionHooks.resolveOrderExchangeAddress(
      { tokenId: firstId, orderPayload: { tokenId: firstId } },
      db,
    ),
    legacy.exchangeAddress,
    "a colliding current PM ID cannot change the legacy neg-risk exchange",
  );
  assert.equal(
    (
      await resolvePolymarketAssetContext(
        db,
        firstId,
        collisionInfo,
        oldContext,
      )
    )?.protocolVersion,
    "v1",
    "explicit historical ledger survives equal numeric ID in current V2 projection",
  );
  const storedContext = readPolymarketStoredOrderContext({
    tokenId: firstId,
    assetContext: oldContext,
  });
  assert.deepEqual(
    storedContext,
    await resolvePolymarketAssetContext(db, firstId, null, oldContext),
  );
  assert.throws(
    () =>
      readPolymarketStoredOrderContext({
        tokenId: nextIds[0],
        assetContext: oldContext,
      }),
    /inconsistent/,
  );
  assert.throws(
    () =>
      readPolymarketStoredOrderContext({
        tokenId: firstId,
        assetContext: { ...oldContext, orderDomainVersion: "3" },
      }),
    /inconsistent/,
  );
  assert.equal(readPolymarketStoredOrderContext({ tokenId: firstId }), null);
  assert.equal(
    (await fetchPolymarketAssetBindings(db, firstId, legacy.positionContract))
      .length,
    1,
  );
  await upsertUnifiedMarket(db, {
    ...nextMarket,
    clob_token_ids: "[]",
    metadata: {
      version: "v3",
      positionIds: nextIds,
      polymarketProtocolIncomplete: true,
    },
  });
  assert.deepEqual(await currentIds("unified_tokens"), []);
  assert.deepEqual(await currentIds("unified_market_tokens"), []);
  assert.equal((await fetchPolymarketAssetBindings(db, firstId)).length, 2);
  console.log(
    "[polymarket-asset-bindings] legacy/V2 preservation, retries, ledger collisions and concurrent projection tests passed",
  );
} finally {
  // Exact fixture IDs on a guarded disposable database only.
  await db.query("delete from unified_tokens where market_id=$1", [marketId]);
  await db.query("delete from unified_market_tokens where market_id=$1", [
    marketId,
  ]);
  await db.query("delete from polymarket_asset_bindings where market_id=$1", [
    marketId,
  ]);
  await db.query("delete from unified_markets where id=$1", [marketId]);
  await db.query("delete from unified_events where id=$1", [eventId]);
  await db.query("delete from polymarket_markets where id=$1", [
    market.venue_market_id,
  ]);
  await db.query("delete from polymarket_events where id=$1", [eventId]);
  await db.end();
}
