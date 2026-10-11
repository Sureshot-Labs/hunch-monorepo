// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { upsertUnifiedEvent, upsertUnifiedMarket } from "@hunch/db";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { AuthService } from "./auth.js";
import { buildApp } from "./app.js";
import { env } from "./env.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import { runPositionResolutionNotificationProducer } from "./services/position-resolution-producer.js";
import type { ResolvedPositionRow } from "./services/positions-notifications.js";
import { fetchPositionShareSourceById } from "./repos/shares.js";
import { fetchUnifiedOrders } from "./repos/unified-orders.js";
import { storeOrder } from "./repos/orders-repo.js";

const db = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=10000",
});
const suffix = randomUUID();
const wallet = `0x${suffix.replaceAll("-", "").padStart(40, "0")}`;
const marketIds = [0, 1].map((index) => `polymarket:read-${suffix}-${index}`);
const eventIds = marketIds.map((id) => `${id}-event`);
const conditions = [0n, 1n].map(
  (index) =>
    (1n << 248n) |
    ((BigInt(`0x${suffix.replaceAll("-", "")}`) ^ index) << 120n),
);
const secondCondition = conditions[1];
assert.ok(secondCondition);
// Synthetic storage collision: market A's old CTF YES becomes market B's PM NO.
const oldTokens = [
  (secondCondition | 1n).toString(),
  (secondCondition | 2n).toString(),
];
const protocols = conditions.map((condition) =>
  resolvePolymarketMarketAssets({
    version: "v2",
    conditionId: `0x${condition.toString(16).padStart(64, "0")}`,
    positionIds: [condition.toString(), (condition | 1n).toString()],
    outcomes: ["Yes", "No"],
    negRisk: false,
  }),
);
const originalFetch = globalThis.fetch;
const originalHotTokensMax = env.hotTokensMax;
const originalPriceRefresh = env.priceRefreshQueueEnabled;
let userId: string | undefined;
const app = await buildApp();
try {
  env.hotTokensMax = 0;
  env.priceRefreshQueueEnabled = false;
  globalThis.fetch = (async () => {
    throw new Error("position reads must not call external APIs");
  }) as typeof fetch;
  userId = (
    await db.query<{ id: string }>(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`position-market-read-${suffix}@example.com`],
    )
  ).rows[0]?.id;
  assert.ok(userId);
  await db.query(
    "insert into user_wallets(user_id,wallet_address,wallet_type,is_primary,is_verified) values($1,$2,'ethereum',true,true)",
    [userId, wallet],
  );
  const token = AuthService.generateToken(userId);
  const userAgent = "polymarket-position-market-read-tests";
  const session = await AuthService.createSession(
    userId,
    wallet,
    token,
    "127.0.0.1",
    userAgent,
  );
  const headers = {
    authorization: `Bearer ${token}`,
    "user-agent": userAgent,
    "x-csrf-token": session.csrfToken,
  };
  for (const [index, protocol] of protocols.entries()) {
    const marketId = marketIds[index];
    const eventId = eventIds[index];
    assert.ok(marketId && eventId);
    await upsertUnifiedEvent(db, {
      id: eventId,
      venue: "polymarket",
      venue_event_id: `${suffix}-${index}`,
      title: index === 0 ? "Historical event A" : "Current event B",
      status: "ACTIVE",
    });
    const market = {
      id: marketId,
      venue: "polymarket",
      venue_market_id: `${suffix}-${index}`,
      event_id: eventId,
      title: index === 0 ? "Historical market A" : "Current market B",
      status: index === 0 ? ("CLOSED" as const) : ("ACTIVE" as const),
      market_type: "binary",
      condition_id: protocol.conditionId,
      outcomes: '["Yes","No"]',
      resolved_outcome: index === 0 ? "YES" : undefined,
    };
    if (index === 0) {
      const legacy = resolvePolymarketMarketAssets({
        version: "v1",
        conditionId: market.condition_id,
        clobTokenIds: oldTokens,
        outcomes: ["Yes", "No"],
        negRisk: false,
      });
      await upsertUnifiedMarket(db, {
        ...market,
        clob_token_ids: JSON.stringify(oldTokens),
        metadata: { polymarketProtocol: legacy },
      });
    }
    await upsertUnifiedMarket(db, {
      ...market,
      clob_token_ids: JSON.stringify(protocol.assets),
      metadata: { polymarketProtocol: protocol },
    });
  }
  const secondMarketId = marketIds[1];
  const secondProtocol = protocols[1];
  const collisionToken = oldTokens[0];
  assert.ok(secondMarketId && secondProtocol && collisionToken);
  const pmContext = buildPolymarketAssetContext(
    secondMarketId,
    secondProtocol,
    collisionToken,
  );
  await db.query(
    `insert into positions(user_id,wallet_address,venue,token_id,side,size,realized_pnl,position_contract,asset_context)
    values($1,$2,'polymarket',$3,'LONG',5,0,'',null),
          ($1,$2,'polymarket',$4,'FLAT',0,1,'',null),
          ($1,$2,'polymarket',$3,'LONG',2,0,$5,$6::jsonb)`,
    [
      userId,
      wallet,
      ...oldTokens,
      pmContext.positionContract.toLowerCase(),
      JSON.stringify(pmContext),
    ],
  );
  await db.query(
    "insert into notifications(user_id,type,title,body,data) values($1,'redemption_completed','Test','Test',$2::jsonb)",
    [
      userId,
      JSON.stringify({
        venue: "polymarket",
        walletAddress: wallet,
        tokenId: oldTokens[1],
      }),
    ],
  );
  const sharePositions = (
    await db.query<{ id: string; position_contract: string; token_id: string }>(
      "select id, position_contract, token_id from positions where user_id=$1",
      [userId],
    )
  ).rows;
  for (const position of sharePositions) {
    const share = await fetchPositionShareSourceById(db, {
      userId,
      positionId: position.id,
    });
    assert.ok(share);
    assert.equal(
      share.market_id,
      position.position_contract ? marketIds[1] : marketIds[0],
    );
    assert.equal(
      share.outcome_side,
      position.position_contract || position.token_id === oldTokens[1]
        ? "NO"
        : "YES",
    );
  }
  for (const [index, orderToken] of [
    oldTokens[0],
    oldTokens[1],
    collisionToken,
  ].entries()) {
    assert.ok(orderToken);
    await storeOrder(db, {
      userId,
      walletAddress: wallet,
      venue: "polymarket",
      venueOrderId: `history-${suffix}-${index}`,
      tokenId: orderToken,
      side: "SELL",
      orderType: "GTC",
      price: 0.5,
      size: 1,
      status: "live",
      errorMessage: null,
      rawError: null,
      orderPayload: index === 2 ? { assetContext: pmContext } : null,
    });
  }
  const historicalMarketId = marketIds[0];
  assert.ok(historicalMarketId);
  for (const filter of [
    { marketId: historicalMarketId },
    { marketIds: [historicalMarketId] },
    { q: "Historical event A" },
  ]) {
    const history = await fetchUnifiedOrders(db, {
      userId,
      type: "order",
      limit: 10,
      offset: 0,
      ...filter,
    });
    assert.equal(
      history.total,
      2,
      "CTF history survives projection replacement and a cross-market token collision",
    );
    assert.ok(
      history.rows.every((row) => row.unified_market_id === marketIds[0]),
    );
    assert.deepEqual(history.rows.map((row) => row.outcome).sort(), [
      "NO",
      "YES",
    ]);
  }
  const pmHistory = await fetchUnifiedOrders(db, {
    userId,
    type: "order",
    marketId: marketIds[1],
    openOnly: true,
    limit: 10,
    offset: 0,
  });
  assert.equal(pmHistory.total, 1);
  assert.equal(pmHistory.rows[0]?.outcome, "NO");
  const read = async (extra: string) => {
    const response = await app.inject({
      method: "GET",
      url: `/positions?wallets=${wallet}&venue=polymarket&minSize=0&${extra}`,
      headers,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const all = await read("includeMarkets=true&includeResolved=true");
  assert.equal(all.positions.length, 3);
  const oldMetadata = all.marketsByToken.filter(
    (entry: { positionContract?: string }) => !entry.positionContract,
  );
  assert.equal(
    oldMetadata.length,
    2,
    "both active and FLAT contextless CTF holdings retain metadata",
  );
  assert.ok(
    oldMetadata.every(
      (entry: { market: { marketId: string } }) =>
        entry.market.marketId === marketIds[0],
    ),
  );
  assert.equal(
    oldMetadata.find(
      (entry: { tokenId: string }) => entry.tokenId === oldTokens[0],
    ).side,
    "YES",
    "a current PM collision cannot replace the frozen CTF outcome",
  );
  const historicalMarket = await read(`marketId=${marketIds[0]}`);
  assert.equal(historicalMarket.positions.length, 1);
  assert.equal(historicalMarket.positions[0].positionContract, undefined);
  assert.equal(historicalMarket.positions[0].size, 5);
  const historicalEvent = await read(
    `eventId=${eventIds[0]}&includeResolved=true`,
  );
  assert.equal(historicalEvent.positions.length, 2);
  assert.ok(
    historicalEvent.positions.every(
      (position: { positionContract?: string }) => !position.positionContract,
    ),
  );
  const currentMarket = await read(`marketId=${marketIds[1]}`);
  assert.equal(
    currentMarket.positions.length,
    1,
    "a shared numeric ID cannot include another market's CTF holding",
  );
  assert.equal(
    currentMarket.positions[0].positionContract,
    pmContext.positionContract.toLowerCase(),
  );
  const precedence = await read(
    `marketId=${marketIds[0]}&eventId=${eventIds[1]}`,
  );
  assert.equal(
    precedence.positions.length,
    1,
    "existing marketId precedence over eventId is preserved",
  );
  assert.equal((await read("eventId=polymarket:missing")).positions.length, 0);
  const searched = await read(
    "includeMarkets=true&includeResolved=true&q=Historical%20market%20A",
  );
  assert.equal(searched.positions.length, 2);
  assert.equal(
    searched.marketsByToken.length,
    2,
    "search metadata is filtered by ledger identity, not numeric token alone",
  );
  assert.ok(
    searched.marketsByToken.every(
      (entry: { market: { marketId: string } }) =>
        entry.market.marketId === marketIds[0],
    ),
  );
  const stored = await db.query(
    "select asset_context from positions where user_id=$1 and position_contract=''",
    [userId],
  );
  assert.ok(
    stored.rows.every((row) => row.asset_context === null),
    "read repair never backfills or rewrites financial rows",
  );
  await db.query(
    "update unified_markets set resolved_outcome='NO' where id=$1",
    [secondMarketId],
  );
  const produced: ResolvedPositionRow[] = [];
  const producer = await runPositionResolutionNotificationProducer({
    pool: db,
    resolvePolicy: async () => ({
      effectiveAt: new Date(Date.now() - 60000).toISOString(),
      invalidOverride: false,
      source: "db",
      policy: {
        version: 1,
        positionResolutionProducerEnabled: true,
        activityEnqueueEnabled: false,
        positionSignalEnqueueEnabled: false,
        interestSignalEnqueueEnabled: false,
        deliveryEnabled: false,
      },
    }),
    createNotification: async (_pool, input) => {
      if (input.userId !== userId) return null;
      produced.push(input.position);
      return { id: randomUUID() } as never;
    },
    allowsLifecycle: async () => true,
    syncPositions: async () => undefined as never,
  });
  assert.equal(producer.notificationsCreated, 2);
  assert.deepEqual(
    produced
      .map((row) => [row.market_id, row.outcome_side, row.resolved_outcome])
      .sort(),
    [
      [marketIds[0], "YES", "YES"],
      [marketIds[1], "NO", "NO"],
    ],
    "background resolution keeps the old holding's market/outcome and never occupies its dedupe key with the colliding PM result",
  );
  console.log(
    "[polymarket-position-market-read] contextless legacy metadata, FLAT history, market/event filters and cross-market ledger collisions passed",
  );
} finally {
  await app.close();
  globalThis.fetch = originalFetch;
  env.hotTokensMax = originalHotTokensMax;
  env.priceRefreshQueueEnabled = originalPriceRefresh;
  if (userId) {
    await db.query("delete from orders where user_id=$1", [userId]);
    await db.query("delete from notifications where user_id=$1", [userId]);
    await db.query("delete from positions where user_id=$1", [userId]);
    await db.query("delete from user_sessions where user_id=$1", [userId]);
    await db.query("delete from user_wallets where user_id=$1", [userId]);
    await db.query("delete from users where id=$1", [userId]);
  }
  await db.query(
    "delete from polymarket_asset_bindings where market_id=any($1::text[])",
    [marketIds],
  );
  await db.query("delete from unified_tokens where market_id=any($1::text[])", [
    marketIds,
  ]);
  await db.query(
    "delete from unified_market_tokens where market_id=any($1::text[])",
    [marketIds],
  );
  await db.query("delete from unified_markets where id=any($1::text[])", [
    marketIds,
  ]);
  await db.query("delete from unified_events where id=any($1::text[])", [
    eventIds,
  ]);
  await db.end();
}
