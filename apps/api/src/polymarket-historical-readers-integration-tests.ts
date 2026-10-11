// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { upsertUnifiedEvent, upsertUnifiedMarket } from "@hunch/db";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
  POLYMARKET_PROTOCOL_CONTRACTS,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { loadTelegramTradeHistory } from "./services/telegram-bot-trade-history.js";
import { fetchUserMarketInteractions } from "./repos/user-market-interactions.js";
import { POSITION_TOKEN_MARKET_JOIN_SQL } from "./lib/pnl-sql.js";
import { SCOPED_MARKET_HOLDING_ASSETS_SQL } from "./lib/market-holding-assets-sql.js";
import {
  polymarketOrderStorageContractSql,
  polymarketOrderBindingJoinSql,
  polymarketOrderMarketIdSql,
} from "./lib/polymarket-order-ledger-sql.js";
import { buildHiddenOwnPositionSnapshotSuppressionSql } from "./lib/hidden-own-position-snapshot-sql.js";

// Execute the production query text, not a second implementation of its
// selection logic. Private worker orchestration is deliberately not run: this
// fixture must neither send messages nor resume a historical Buy.
function productionSql(file: string, owner: string, marker: string): string {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let template: ts.Node | undefined;
  const visit = (node: ts.Node, inside = false) => {
    const owned =
      inside || (ts.isFunctionDeclaration(node) && node.name?.text === owner);
    if (
      owned &&
      (ts.isTemplateExpression(node) ||
        ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.getText(ast).includes(marker)
    )
      template = node;
    ts.forEachChild(node, (child) => visit(child, owned));
  };
  visit(ast);
  assert.ok(template, `${owner}: actual query exists`);
  return runInNewContext(template.getText(ast), {
    POSITION_TOKEN_MARKET_JOIN_SQL,
    SCOPED_MARKET_HOLDING_ASSETS_SQL,
    POLYMARKET_PROTOCOL_CONTRACTS,
    polymarketOrderStorageContractSql,
    polymarketOrderBindingJoinSql,
    polymarketOrderMarketIdSql,
    walletClause: "lower(wallet_address) = lower($2)",
    tokenLikeClause: "",
    staleParam: 5,
  });
}

const db = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=10000 -c jit=off",
});
const client = await db.connect();
const suffix = randomUUID();
const ctfUser = randomUUID();
const pmUser = randomUUID();
const wallet = `0x${suffix.replaceAll("-", "").padStart(40, "0")}`;
const noteId = randomUUID();
const markets = [0, 1].map(
  (index) => `polymarket:history-read-${suffix}-${index}`,
);
const base = (1n << 248n) | (BigInt(`0x${suffix.replaceAll("-", "")}`) << 120n);
const ctfTokens = [(base | 1n).toString(), (base | 2n).toString()];
const v2 = resolvePolymarketMarketAssets({
  version: "v2",
  conditionId: `0x${base.toString(16).padStart(64, "0")}`,
  positionIds: [base.toString(), (base | 1n).toString()],
  outcomes: ["Yes", "No"],
  negRisk: false,
});
const pmContract = POLYMARKET_PROTOCOL_CONTRACTS.positionManager.toLowerCase();
const signalSql = productionSql(
  "./services/telegram-notification-delivery.ts",
  "enqueueTelegramPositionSignals",
  "array_agg(distinct",
);
const interestSql = productionSql(
  "./services/telegram-hunch-interests.ts",
  "insertInterestRecipients",
  "with scoped_markets",
);
const notificationSql = productionSql(
  "./services/telegram-notification-delivery.ts",
  "loadTelegramNotificationMarket",
  "market.id as market_id",
);
const recoverySql = productionSql(
  "./services/telegram-bot-trading-venue-reconcile.ts",
  "inspectLinkedLocalOrder",
  "select stored_order.status",
);
const suppression = buildHiddenOwnPositionSnapshotSuppressionSql({
  snapshotAlias: "ws",
  walletAlias: "w",
});
const refreshSql = productionSql(
  "./services/positions-sync.ts",
  "fetchOpenPositionTokenIdsForRefresh",
  "select distinct case",
);

try {
  await client.query("begin");
  await client.query(
    "insert into users(id,is_active) values($1,true),($2,true)",
    [ctfUser, pmUser],
  );
  for (const userId of [ctfUser, pmUser]) {
    await client.query(
      "insert into user_telegram_accounts(user_id,privy_user_id,telegram_user_id) values($1,$2,$3)",
      [userId, `privy:${userId}`, `telegram:${userId}`],
    );
    await client.query(
      "update telegram_notification_preferences set reachable=true, position_signals=true, interest_signals=true, position_signals_enabled_at=now()-interval '1 day', interest_signals_enabled_at=now()-interval '1 day' where user_id=$1",
      [userId],
    );
  }
  for (const [index, marketId] of markets.entries()) {
    await upsertUnifiedEvent(db, {
      id: `${marketId}:event`,
      venue: "polymarket",
      venue_event_id: `${suffix}-${index}`,
      title: `Event ${index}`,
      status: "ACTIVE",
    });
    if (index === 0) {
      const legacy = resolvePolymarketMarketAssets({
        version: "v1",
        conditionId: `0x${(base ^ (1n << 120n)).toString(16).padStart(64, "0")}`,
        clobTokenIds: ctfTokens,
        outcomes: ["Yes", "No"],
        negRisk: false,
      });
      await upsertUnifiedMarket(db, {
        id: marketId,
        venue: "polymarket",
        venue_market_id: `${suffix}-${index}`,
        event_id: `${marketId}:event`,
        title: `Market ${index}`,
        status: "ACTIVE",
        market_type: "binary",
        outcomes: '["Yes","No"]',
        condition_id: legacy.conditionId,
        clob_token_ids: JSON.stringify(ctfTokens),
        metadata: { polymarketProtocol: legacy },
      });
    }
    const protocol =
      index === 1
        ? v2
        : resolvePolymarketMarketAssets({
            version: "v2",
            conditionId: `0x${(base ^ (1n << 120n)).toString(16).padStart(64, "0")}`,
            positionIds: [
              (base ^ (1n << 120n)).toString(),
              ((base ^ (1n << 120n)) | 1n).toString(),
            ],
            outcomes: ["Yes", "No"],
            negRisk: false,
          });
    await upsertUnifiedMarket(db, {
      id: marketId,
      venue: "polymarket",
      venue_market_id: `${suffix}-${index}`,
      event_id: `${marketId}:event`,
      title: `Market ${index}`,
      status: "ACTIVE",
      market_type: "binary",
      outcomes: '["Yes","No"]',
      condition_id: protocol.conditionId,
      clob_token_ids: JSON.stringify(protocol.assets),
      metadata: { polymarketProtocol: protocol },
    });
  }
  const ctfToken = ctfTokens[0];
  const ctfMarket = markets[0];
  const pmMarket = markets[1];
  assert.ok(ctfToken && ctfMarket && pmMarket);
  const pmContext = buildPolymarketAssetContext(pmMarket, v2, ctfToken);
  await client.query(
    `insert into positions(user_id,wallet_address,venue,token_id,side,size,position_contract,asset_context)
    values($1,$3,'polymarket',$4,'LONG',5,'',null),($2,$3,'polymarket',$4,'LONG',2,$5,$6::jsonb)`,
    [ctfUser, pmUser, wallet, ctfToken, pmContract, JSON.stringify(pmContext)],
  );
  const orderIds: string[] = [];
  for (const [index, userId] of [ctfUser, pmUser].entries()) {
    const orderId = randomUUID();
    orderIds.push(orderId);
    await client.query(
      `insert into orders(id,user_id,venue,venue_order_id,token_id,side,order_type,price,size,status,filled_size,order_payload)
      values($1::uuid,$2,'polymarket',$1::text,$3,'BUY','GTC',0.5,1,'matched',1,$4::jsonb)`,
      [
        orderId,
        userId,
        ctfToken,
        index === 1 ? JSON.stringify({ assetContext: pmContext }) : null,
      ],
    );
  }
  // The current projection now belongs to another market/outcome/ledger.
  const projection = await client.query(
    "select market_id,side from unified_tokens where token_id=$1 and venue='polymarket'",
    [ctfToken],
  );
  assert.deepEqual(projection.rows, [{ market_id: pmMarket, side: "NO" }]);
  // Pool-shaped adapter keeps all reads inside this rollback-only transaction.
  for (const [index, userId] of [ctfUser, pmUser].entries()) {
    const history = await loadTelegramTradeHistory({
      pool: client as never,
      telegramUserId: `telegram:${userId}`,
    });
    assert.equal(history.linked, true);
    assert.equal(history.snapshot.trades[0]?.marketTitle, `Market ${index}`);
    assert.equal(history.snapshot.trades[0]?.eventTitle, `Event ${index}`);
    assert.equal(
      history.snapshot.trades[0]?.outcome,
      index === 0 ? "YES" : "NO",
    );
    const interactions = await fetchUserMarketInteractions(client, userId);
    assert.deepEqual(
      interactions.map((row) => [row.market_id, row.weight]).sort(),
      [
        [markets[index], 1],
        [markets[index], 2],
      ],
    );
    const linked = await client.query(recoverySql, [
      orderIds[index],
      userId,
      "polymarket",
      "BUY",
      markets[index],
      null,
      null,
    ]);
    assert.equal(linked.rows.length, 1);
    const wrong = await client.query(recoverySql, [
      orderIds[index],
      userId,
      "polymarket",
      "BUY",
      markets[1 - index],
      null,
      null,
    ]);
    assert.equal(wrong.rows.length, 0);
    const notification = await client.query(notificationSql, [
      null,
      ctfToken,
      "polymarket",
      index === 0
        ? POLYMARKET_PROTOCOL_CONTRACTS.conditionalTokens.toLowerCase()
        : pmContract,
    ]);
    assert.equal(notification.rows[0]?.market_id, markets[index]);
    assert.equal(notification.rows[0]?.side, index === 0 ? "YES" : "NO");
  }
  const now = new Date().toISOString();
  await client.query(
    "update unified_markets set expiration_time=now()-interval '1 hour' where id=$1",
    [ctfMarket],
  );
  const refresh = await client.query(refreshSql, [
    ctfUser,
    wallet,
    "polymarket",
    "own",
    "15",
  ]);
  const currentPrice = await client.query(
    "select token_id from unified_market_tokens where market_id=$1 and outcome_side='YES'",
    [ctfMarket],
  );
  assert.deepEqual(
    refresh.rows,
    currentPrice.rows,
    "historical CTF refresh targets the current pricing asset of its own market, not a colliding PM market",
  );
  await client.query(
    "insert into ai_notes(id,note_key,note_type,title,description,producer_type,producer_run_id) values($1,$2,'signal','Test','Test','holder_research',$2)",
    [noteId, `note:${suffix}`],
  );
  for (const [index, marketId] of markets.entries()) {
    const recipients = await client.query(signalSql, [
      marketId,
      now,
      noteId,
      "initial",
    ]);
    assert.deepEqual(
      recipients.rows.map((row) => [row.user_id, row.held_sides]),
      [[index === 0 ? ctfUser : pmUser, [index === 0 ? "YES" : "NO"]]],
    );
    const interests = await client.query(interestSql, [
      marketId,
      [`${marketId}:event`],
      `${marketId}:event`,
      now,
      `interest:${index}:${suffix}`,
      noteId,
      "polymarket",
      "initial",
      noteId,
    ]);
    assert.equal(Number(interests.rows[0]?.inserted_count), 1);
    const outbox = await client.query(
      "select user_id from telegram_notification_outbox where event_key=$1",
      [`interest:${index}:${suffix}`],
    );
    assert.deepEqual(
      outbox.rows.map((row) => row.user_id),
      [index === 0 ? ctfUser : pmUser],
    );
  }
  await client.query("update positions set is_hidden=true where user_id=$1", [
    pmUser,
  ]);
  await client.query(
    `insert into positions(user_id,wallet_address,venue,token_id,side,size)
    select $1::uuid,$2,'polymarket','noise:'||$1::text||':'||n::text,'LONG',1 from generate_series(1,20000) n`,
    [ctfUser, wallet],
  );
  await client.query("analyze positions");
  type PlanNode = {
    "Relation Name"?: string;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
    "Rows Removed by Filter"?: number;
    Plans?: PlanNode[];
  };
  const plan = await client.query<{
    "QUERY PLAN": Array<{ Plan: PlanNode; "Execution Time": number }>;
  }>(`explain (analyze,buffers,format json) ${signalSql}`, [
    ctfMarket,
    now,
    noteId,
    "initial",
  ]);
  let visitedPositions = 0;
  const visitPlan = (node: PlanNode) => {
    if (node["Relation Name"] === "positions")
      visitedPositions +=
        ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0);
    for (const child of node.Plans ?? []) visitPlan(child);
  };
  const rootPlan = plan.rows[0]?.["QUERY PLAN"][0];
  assert.ok(rootPlan);
  assert.deepEqual(
    (
      await client.query(signalSql, [ctfMarket, now, noteId, "initial"])
    ).rows.map((row) => row.user_id),
    [ctfUser],
    "the scale fixture must still have an eligible recipient",
  );
  visitPlan(rootPlan.Plan);
  assert.ok(
    visitedPositions < 1000,
    "recipient selection must not walk 20000 unrelated holdings",
  );
  console.log(
    `[polymarket-historical-readers] bounded recipient EXPLAIN: ${visitedPositions} position rows visited, ${rootPlan["Execution Time"]}ms`,
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,market_type,status)
    select 'polymarket:noise:'||$1::text||':'||n::text,'polymarket','noise:'||$1::text||':'||n::text,$2,'Noise','binary','ACTIVE' from generate_series(1,10000) n`,
    [ctfUser, `${ctfMarket}:event`],
  );
  const notificationPlan = await client.query<{
    "QUERY PLAN": Array<{ Plan: PlanNode }>;
  }>(`explain (analyze,buffers,format json) ${notificationSql}`, [
    null,
    `unknown:${suffix}`,
    "polymarket",
    pmContract,
  ]);
  let visitedMarkets = 0;
  const visitMarkets = (node: PlanNode) => {
    if (node["Relation Name"] === "unified_markets")
      visitedMarkets +=
        ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) *
        (node["Actual Loops"] ?? 0);
    for (const child of node.Plans ?? []) visitMarkets(child);
  };
  const notificationRoot = notificationPlan.rows[0]?.["QUERY PLAN"][0]?.Plan;
  assert.ok(notificationRoot);
  visitMarkets(notificationRoot);
  assert.ok(
    visitedMarkets < 1000,
    "notification lookup must not walk 10000 unrelated markets",
  );
  const visible = async (
    metadata: unknown,
    venue = "polymarket",
    address = wallet,
    chain = "polygon",
  ) => {
    const result = await client.query(
      `select ${suppression} as visible from (select $1::jsonb as metadata,$2::text as venue) ws cross join (select $3::text as address,$4::text as chain) w`,
      [JSON.stringify(metadata), venue, address, chain],
    );
    return result.rows[0]?.visible;
  };
  const ctfAsset = { tokenId: ctfToken, positionContract: "", shares: 5 };
  const pmAsset = {
    tokenId: ctfToken,
    positionContract: pmContract,
    shares: 2,
  };
  assert.equal(
    await visible({ tokenId: ctfToken, assets: [ctfAsset] }),
    true,
    "hidden PM price token cannot suppress visible CTF exposure",
  );
  assert.equal(await visible({ tokenId: ctfToken, assets: [pmAsset] }), false);
  assert.equal(
    await visible({ tokenId: ctfToken, assets: [ctfAsset, pmAsset] }),
    true,
  );
  assert.equal(
    await visible(
      { tokenId: ctfToken, assets: [pmAsset] },
      "polymarket",
      `0x${"1".repeat(40)}`,
    ),
    true,
  );
  await client.query("update positions set is_hidden=true where user_id=$1", [
    ctfUser,
  ]);
  assert.equal(
    await visible({ tokenId: ctfToken, assets: [ctfAsset, pmAsset] }),
    false,
  );
  for (const assets of [undefined, null, {}, "bad", [], [null]]) {
    assert.equal(
      await visible({ tokenId: ctfToken, assets }),
      false,
      "legacy/malformed metadata keeps suppression without a SQL exception",
    );
  }
  assert.equal(
    await visible({ tokenId: ctfToken }),
    false,
    "legacy CTF single-token suppression is preserved",
  );
  const afterHidden = await client.query(signalSql, [
    ctfMarket,
    now,
    noteId,
    "initial",
  ]);
  assert.equal(afterHidden.rows.length, 0);
  await client.query("update positions set is_hidden=false where user_id=$1", [
    ctfUser,
  ]);
  await client.query(
    "update telegram_notification_preferences set reachable=false where user_id=$1",
    [ctfUser],
  );
  assert.equal(
    (await client.query(signalSql, [ctfMarket, now, noteId, "initial"])).rows
      .length,
    0,
  );
  assert.equal(
    Number(
      (
        await client.query(interestSql, [
          ctfMarket,
          [`${ctfMarket}:event`],
          `${ctfMarket}:event`,
          now,
          `unreachable:${suffix}`,
          noteId,
          "polymarket",
          "initial",
          noteId,
        ])
      ).rows[0]?.inserted_count,
    ),
    0,
  );
  console.log(
    "[polymarket-historical-readers] CTF/PM collision: history, feed, signals, interests, recovery, notification and snapshot visibility passed; no send/resume/network; rolled back",
  );
} finally {
  await client.query("rollback");
  client.release();
  await db.query(
    "delete from polymarket_asset_bindings where market_id=any($1::text[])",
    [markets],
  );
  await db.query("delete from unified_tokens where market_id=any($1::text[])", [
    markets,
  ]);
  await db.query(
    "delete from unified_market_tokens where market_id=any($1::text[])",
    [markets],
  );
  await db.query("delete from unified_markets where id=any($1::text[])", [
    markets,
  ]);
  await db.query("delete from unified_events where id=any($1::text[])", [
    markets.map((id) => `${id}:event`),
  ]);
  await db.end();
}
