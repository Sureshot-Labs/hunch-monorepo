// @api-integration
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { upsertUnifiedEvent, upsertUnifiedMarket } from "@hunch/db";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";

import { createIntegrationTestPool } from "./test-database-target.js";
import {
  fetchPositionsForUserWallet,
  fetchPositionPnlSummaryForUserWallet,
  syncWalletPositionsFromTokenBalances,
  updatePositionMetrics,
} from "./repos/positions-repo.js";
import {
  applyOptimisticPositionTrade,
  reconcileExactPositionBalance,
} from "./services/positions-optimistic.js";
import { loadPolymarketHoldingLedgers } from "./services/polymarket-asset-context.js";
import { loadPolymarketHoldingMarkRows } from "./services/polymarket-holding-marks.js";
import { positionAssetKey } from "./lib/position-asset-context.js";
import { fetchMarketsByTokenIds } from "./repos/unified-read.js";
import {
  collectAutoTrackedWalletSnapshotRows,
  snapshotFollowedWalletHoldingsEvm,
  snapshotInternalHunchWalletPositions,
  backfillInternalHunchOrderFillActivity,
} from "./wallet-intel-refresh.js";
import { fetchPolymarketOpenOrderPositionLocks } from "./services/open-order-collateral.js";
import { env } from "./env.js";
import { Interface } from "ethers";
import { verifyPolymarketBuilderFeeAccruals } from "./services/polymarket-builder-fees.js";
import type { Pool } from "@hunch/infra";
import { POLYMARKET_FILL_NOTIFICATION_ORDERS_SQL } from "./services/positions-sync.js";
import { notifyResolvedPositions } from "./services/positions-notifications.js";
import { fetchPositionMarketRows } from "./services/position-market-rows.js";
import { mapMarketsByTokenRows } from "./services/markets-by-token-response.js";
import { buildTelegramPositionDetail } from "./services/telegram-bot-positions.js";
import { loadOwnedPolymarketPositionSelection } from "./services/polymarket-position-selection.js";
import { polymarketTradingExecutionTestHooks } from "./services/polymarket-trading-execution-service.js";

const db = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=10000",
});
const suffix = randomUUID();
const marketId = `polymarket:position-ledger-${suffix}`;
const eventId = `polymarket:position-ledger-event-${suffix}`;
const condition =
  (1n << 248n) | (BigInt(`0x${suffix.replaceAll("-", "")}`) << 120n);
// Old CTF YES collides with the new PM NO; the packed PM ordering stays valid.
const tokenId = (condition | 1n).toString();
const sibling = condition.toString();
const conditionId = `0x${condition.toString(16).padStart(64, "0")}`;
const wallet = `0x${suffix.replaceAll("-", "").padStart(40, "0")}`;
const legacy = resolvePolymarketMarketAssets({
  version: "v1",
  conditionId,
  clobTokenIds: [tokenId, sibling],
  outcomes: ["Yes", "No"],
  negRisk: false,
});
// Synthetic storage collision, not a claim of live PositionManager acceptance.
const next = resolvePolymarketMarketAssets({
  version: "v2",
  conditionId,
  positionIds: [sibling, tokenId],
  outcomes: ["Yes", "No"],
  negRisk: false,
});
const legacyContext = buildPolymarketAssetContext(marketId, legacy, tokenId);
const nextContext = buildPolymarketAssetContext(marketId, next, tokenId);
let userId: string | null = null;
let walletId: string | null = null;
const originalFetch = globalThis.fetch;
const originalPriceRefreshQueueEnabled = env.priceRefreshQueueEnabled;
try {
  await db.query(POLYMARKET_FILL_NOTIFICATION_ORDERS_SQL, [[]]);
  await notifyResolvedPositions(
    {
      query: async (sql: string, params: unknown[]) => {
        await db.query(sql, params);
        return { rows: [] };
      },
    } as unknown as Pool,
    {
      userId: randomUUID(),
      walletAddress: wallet,
      venue: "polymarket",
    },
  );
  // Parse/execute the verifier's actual SELECT on PG16 without fetching receipts
  // or mutating any accruals that another fixture might have left behind.
  await verifyPolymarketBuilderFeeAccruals({
    query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /select fee_row\.\*/);
      await db.query(sql, params);
      return { rows: [] };
    },
  } as unknown as Pool);
  userId =
    (
      await db.query<{ id: string }>(
        "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
        [`position-ledgers-${suffix}@example.com`],
      )
    ).rows[0]?.id ?? null;
  assert.ok(userId);
  walletId =
    (
      await db.query<{ id: string }>(
        "insert into wallets(address,chain) values($1,'polygon') returning id",
        [wallet],
      )
    ).rows[0]?.id ?? null;
  assert.ok(walletId);
  const trackedWalletId = walletId;
  await upsertUnifiedEvent(db, {
    id: eventId,
    venue: "polymarket",
    venue_event_id: suffix,
    title: "Position ledger fixture",
    status: "ACTIVE",
  });
  const market = {
    id: marketId,
    venue: "polymarket",
    venue_market_id: suffix,
    event_id: eventId,
    title: "Position ledger fixture",
    status: "ACTIVE" as const,
    market_type: "binary",
    condition_id: conditionId,
    outcomes: '["Yes","No"]',
  };
  await upsertUnifiedMarket(db, {
    ...market,
    clob_token_ids: JSON.stringify(legacy.assets),
    metadata: { polymarketProtocol: legacy },
  });
  await syncWalletPositionsFromTokenBalances(db, {
    userId,
    walletAddress: wallet,
    venue: "polymarket",
    tokenBalances: [
      { tokenId, size: "3", averagePrice: "0.3", assetContext: legacyContext },
    ],
  });
  await upsertUnifiedMarket(db, {
    ...market,
    clob_token_ids: JSON.stringify(next.assets),
    metadata: {
      version: "v2",
      positionIds: next.assets,
      polymarketProtocol: next,
    },
  });
  await db.query(
    "insert into unified_token_top_latest(token_id,venue,ts,best_bid,best_ask,mid) values($1,'polymarket',now(),.3,.3,.3),($2,'polymarket',now(),.7,.7,.7)",
    [tokenId, sibling],
  );
  await syncWalletPositionsFromTokenBalances(db, {
    userId,
    walletAddress: wallet,
    venue: "polymarket",
    positionContract: next.positionContract.toLowerCase(),
    tokenBalances: [
      { tokenId, size: "2", averagePrice: "0.4", assetContext: nextContext },
    ],
  });
  let positions = await fetchPositionsForUserWallet(db, {
    userId,
    walletAddresses: [wallet],
    venue: "polymarket",
  });
  assert.equal(
    positions.length,
    2,
    "same uint256 ID is two independent ledger holdings",
  );
  assert.deepEqual(positions.map((row) => row.size).sort(), [2, 3]);
  assert.deepEqual(
    positions.map((row) => row.assetContext?.outcomeIndex).sort(),
    [0, 1],
  );
  const frozenMarkets = mapMarketsByTokenRows(
    await fetchPositionMarketRows(db, positions),
  );
  assert.equal(
    frozenMarkets.length,
    2,
    "public metadata keeps both ledger identities for a colliding uint256",
  );
  for (const position of positions) {
    assert.deepEqual(
      await polymarketTradingExecutionTestHooks.resolveReadinessAssetContext(
        db,
        position.assetContext,
      ),
      position.assetContext,
      "deferred SELL readiness validates the same frozen generation without a balance probe",
    );
    const selected = await loadOwnedPolymarketPositionSelection(db, {
      userId,
      positionRef: position.id,
      marketId,
      expectedWallet: wallet,
    });
    assert.deepEqual(
      selected?.assetContext,
      position.assetContext,
      "a private position UUID preserves its historical ledger and side",
    );
    assert.equal(
      await loadOwnedPolymarketPositionSelection(db, {
        userId: randomUUID(),
        positionRef: position.id,
        marketId,
        expectedWallet: wallet,
      }),
      null,
    );
    assert.equal(
      await loadOwnedPolymarketPositionSelection(db, {
        userId,
        positionRef: position.id,
        marketId,
        expectedWallet: `0x${"ff".repeat(20)}`,
      }),
      null,
    );
    assert.equal(
      await loadOwnedPolymarketPositionSelection(db, {
        userId,
        positionRef: position.id,
        marketId: "polymarket:other",
        expectedWallet: wallet,
      }),
      null,
    );
    const entry = frozenMarkets.find(
      (row) =>
        positionAssetKey(row.tokenId, row.positionContract) ===
        positionAssetKey(position.tokenId, position.positionContract),
    );
    assert.ok(entry);
    const expectedSide =
      position.assetContext?.outcomeIndex === 0 ? "YES" : "NO";
    assert.equal(entry.side, expectedSide);
    assert.equal(
      entry.market.tokens[expectedSide === "YES" ? "yes" : "no"],
      tokenId,
    );
    assert.equal(
      entry.assetContext?.protocolVersion,
      position.assetContext?.protocolVersion,
    );
    const detail = buildTelegramPositionDetail(position, entry);
    assert.equal(
      detail.side,
      expectedSide,
      "Telegram does not take the current colliding token's side",
    );
    assert.equal(detail.marketId, marketId);
    assert.equal(
      detail.markPrice,
      expectedSide === "YES" ? 0.7 : 0.3,
      "marks use the current underlying outcome, not the colliding asset ID",
    );
  }
  await assert.rejects(
    () =>
      polymarketTradingExecutionTestHooks.resolveReadinessAssetContext(
        db,
        legacyContext,
        nextContext,
      ),
    /inconsistent/,
  );
  const legacyMarketRows = await fetchMarketsByTokenIds(db, {
    tokenIds: [tokenId],
    venue: "polymarket",
    includeTop: false,
    marketAssetBinding: { marketId, side: "YES" },
  });
  assert.equal(legacyMarketRows.length, 1);
  assert.equal(
    legacyMarketRows[0]?.side,
    "YES",
    "historical redemption uses frozen side, not current colliding NO mapping",
  );
  const ledgers = await loadPolymarketHoldingLedgers(db, [tokenId]);
  assert.equal(ledgers.length, 2);
  assert.equal(
    ledgers
      .find((row) => row.storageContract === "")
      ?.tokenContexts.get(tokenId)?.outcomeIndex,
    0,
  );
  assert.equal(
    ledgers
      .find((row) => row.storageContract !== "")
      ?.tokenContexts.get(tokenId)?.outcomeIndex,
    1,
  );
  const held = [
    { tokenId, size: "3", assetContext: legacyContext },
    { tokenId, size: "2", assetContext: nextContext },
    {
      tokenId: sibling,
      size: "7",
      assetContext: buildPolymarketAssetContext(marketId, next, sibling),
    },
  ];
  const marks = await loadPolymarketHoldingMarkRows(db, held);
  assert.equal(
    Number(marks.get(positionAssetKey(tokenId))?.best_bid),
    0.7,
    "historical YES mark follows current YES asset, not colliding NO ID",
  );
  assert.equal(
    Number(
      marks.get(positionAssetKey(tokenId, next.positionContract.toLowerCase()))
        ?.best_bid,
    ),
    0.3,
  );
  const snapshotAt = new Date("2026-10-05T12:00:00.000Z");
  await snapshotFollowedWalletHoldingsEvm(db, {
    walletId,
    address: wallet,
    venue: "polymarket",
    rpcUrl: "unused",
    rpcTimeoutMs: 1000,
    contractAddress: legacy.positionContract,
    tokenIds: [tokenId, sibling],
    tokenIndex: new Map(),
    occurredAt: snapshotAt,
    prefetchedBalances: held,
  });
  const readSnapshots = async (at: Date) =>
    (
      await db.query<{
        outcome_side: string;
        shares: string;
        metadata: Record<string, unknown>;
      }>(
        "select outcome_side,shares::text,metadata from wallet_position_snapshots where wallet_id=$1 and snapshot_at=$2 order by outcome_side",
        [walletId, at],
      )
    ).rows;
  const followed = await readSnapshots(snapshotAt);
  assert.deepEqual(
    followed.map((row) => [row.outcome_side, Number(row.shares)]),
    [
      ["NO", 2],
      ["YES", 10],
    ],
  );
  assert.equal(
    (
      followed.find((row) => row.outcome_side === "YES")?.metadata
        .assets as unknown[]
    ).length,
    2,
  );
  const iface = new Interface([
    "function balanceOfBatch(address[] accounts,uint256[] ids) view returns(uint256[])",
  ]);
  let incompleteRpc = false;
  let rpcCalls = 0;
  env.priceRefreshQueueEnabled = false;
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST")
      return new Response(
        JSON.stringify({
          data: [tokenId, sibling].map((id, outcomeIndex) => ({
            token_id: id,
            proxy_wallet: wallet,
            condition_id: conditionId,
            current_size: 2,
            avg_price: 0.4,
            outcome_index: outcomeIndex,
            redeemable: false,
          })),
          pagination: { next_cursor: null },
        }),
        { status: 200 },
      );
    rpcCalls += 1;
    const body = JSON.parse(String(init.body)) as {
      params: [{ to: string; data: string }];
    };
    const [, ids] = iface.decodeFunctionData(
      "balanceOfBatch",
      body.params[0].data,
    );
    const isPm =
      body.params[0].to.toLowerCase() === next.positionContract.toLowerCase();
    const balances = incompleteRpc
      ? []
      : [...ids].map((id: bigint) =>
          isPm
            ? id.toString() === tokenId
              ? 2_000_000n
              : 7_000_000n
            : id.toString() === tokenId
              ? 3_000_000n
              : 0n,
        );
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: iface.encodeFunctionResult("balanceOfBatch", [balances]),
      }),
      { status: 200 },
    );
  };
  const autoInputs = (at: Date) => ({
    autoTrackedWallets: [
      {
        wallet_id: trackedWalletId,
        address: wallet,
        chain: "polygon" as const,
        venue: "polymarket" as const,
        sources: ["recent_top_holder" as const],
        priority: 100,
      },
    ],
    previousOpenPositions: [],
    snapshotAt: at,
    tokenIdsByVenue: { polymarket: [], limitless: [], kalshi: [] },
    tokenIndexByVenue: {
      polymarket: new Map(),
      limitless: new Map(),
      kalshi: new Map(),
    },
    telemetry: {} as never,
    autoTrackedWalletFetchConcurrency: 1,
    touchedWalletIds: new Set<string>(),
  });
  const autoAt = new Date(snapshotAt.getTime() + 1000);
  const auto = await collectAutoTrackedWalletSnapshotRows(
    db,
    autoInputs(autoAt),
  );
  assert.equal(auto.refreshedWallets.length, 1);
  assert.equal(rpcCalls, 2, "one read per real holding ledger");
  assert.deepEqual(
    (await readSnapshots(autoAt)).map((row) => [
      row.outcome_side,
      Number(row.shares),
    ]),
    [
      ["NO", 2],
      ["YES", 10],
    ],
  );
  const partialAt = new Date(autoAt.getTime() + 500);
  const partialIndexDb = {
    query: async (sql: string, params: unknown[]) => {
      const result = await db.query(sql, params);
      if (sql.includes("resolved_assets as")) {
        return {
          ...result,
          rows: result.rows.filter((row) => row.position_contract === ""),
        };
      }
      return result;
    },
  } as unknown as typeof db;
  const partialIndex = await collectAutoTrackedWalletSnapshotRows(
    partialIndexDb,
    {
      ...autoInputs(partialAt),
      previousOpenPositions: [
        {
          wallet_id: trackedWalletId,
          venue: "polymarket",
          market_id: marketId,
          outcome_side: "NO",
          token_id: tokenId,
          price: "0.7",
        },
      ],
    },
  );
  assert.equal(
    partialIndex.refreshedWallets.length,
    0,
    "missing positive PM mark is not a complete inventory scan",
  );
  assert.equal(
    partialIndex.previousOpenMarketKeys.length,
    0,
    "incomplete index cannot zero a previously open PM position",
  );
  await db.query(
    "update positions set is_hidden=true,hidden_reason='auto_lost' where user_id=$1 and position_contract=''",
    [userId],
  );
  const hiddenAt = new Date(autoAt.getTime() + 1000);
  await collectAutoTrackedWalletSnapshotRows(db, autoInputs(hiddenAt));
  assert.deepEqual(
    (await readSnapshots(hiddenAt)).map((row) => [
      row.outcome_side,
      Number(row.shares),
    ]),
    [
      ["NO", 2],
      ["YES", 7],
    ],
    "hidden CTF cannot suppress PM contribution",
  );
  await db.query(
    "update positions set is_hidden=false,hidden_reason=null where user_id=$1",
    [userId],
  );
  const internalAt = new Date(hiddenAt.getTime() + 1000);
  await snapshotInternalHunchWalletPositions(db, {
    userId,
    walletId,
    walletAddress: wallet,
    venue: "polymarket",
    chain: "polygon",
    occurredAt: internalAt,
  });
  assert.deepEqual(
    (await readSnapshots(internalAt)).map((row) => [
      row.outcome_side,
      Number(row.shares),
    ]),
    [
      ["NO", 2],
      ["YES", 3],
    ],
  );
  const replayAt = new Date(internalAt.getTime() + 10_000);
  for (const [index, context] of [legacyContext, nextContext].entries()) {
    const order = (
      await db.query<{ id: string }>(
        "insert into orders(user_id,wallet_address,venue,token_id,side,order_type,price,size,status,order_payload) values($1,$2,'polymarket',$3,'BUY','FOK',.4,1,'matched',$4::jsonb) returning id",
        [
          userId,
          wallet,
          tokenId,
          JSON.stringify({
            tokenId,
            maker: wallet,
            makerAmount: "400000",
            takerAmount: "1000000",
            assetContext: context,
          }),
        ],
      )
    ).rows[0];
    assert.ok(order);
    await db.query(
      "insert into order_fills(order_id,fill_size,fill_price,fill_side,filled_at) values($1,1,.4,'BUY',$2)",
      [order.id, new Date(replayAt.getTime() - 3000 + index * 1000)],
    );
  }
  const replay = await backfillInternalHunchOrderFillActivity(db, {
    userId,
    walletId: trackedWalletId,
    walletAddress: wallet,
    chain: "polygon",
    venue: "polymarket",
    snapshotAt: replayAt,
    fillLimit: 10,
  });
  assert.equal(
    replay.rows,
    2,
    "historical CTF and PM fills each produce one activity event",
  );
  const events = (
    await db.query<{
      outcome_side: string;
      metadata: {
        prevShares: number;
        currShares: number;
        positionContract?: string;
      };
    }>(
      "select outcome_side,metadata from wallet_activity_events where wallet_id=$1 and source='hunch_order_fill' order by outcome_side",
      [trackedWalletId],
    )
  ).rows;
  assert.deepEqual(
    events.map((row) => [
      row.outcome_side,
      row.metadata.prevShares,
      row.metadata.currShares,
    ]),
    [
      ["NO", 0, 1],
      ["YES", 0, 1],
    ],
    "frozen-side replay never combines distinct ledger running shares",
  );
  assert.equal(
    events[0]?.metadata.positionContract,
    next.positionContract.toLowerCase(),
  );
  const sellOrder = (
    await db.query<{ id: string }>(
      "insert into orders(user_id,wallet_address,venue,token_id,side,order_type,price,size,status,order_payload) values($1,$2,'polymarket',$3,'SELL','FOK',.4,.5,'matched',$4::jsonb) returning id",
      [
        userId,
        wallet,
        tokenId,
        JSON.stringify({
          tokenId,
          maker: wallet,
          makerAmount: "500000",
          takerAmount: "200000",
          assetContext: nextContext,
        }),
      ],
    )
  ).rows[0];
  assert.ok(sellOrder);
  const sellAt = new Date(replayAt.getTime() + 1000);
  await db.query(
    "insert into order_fills(order_id,fill_size,fill_price,fill_side,filled_at) values($1,.5,.4,'SELL',$2)",
    [sellOrder.id, sellAt],
  );
  await backfillInternalHunchOrderFillActivity(db, {
    userId,
    walletId: trackedWalletId,
    walletAddress: wallet,
    chain: "polygon",
    venue: "polymarket",
    snapshotAt: new Date(sellAt.getTime() + 1000),
    fillLimit: 1,
  });
  const priorReplay = (
    await db.query<{ metadata: { prevShares: number; currShares: number } }>(
      "select metadata from wallet_activity_events where wallet_id=$1 and source='hunch_order_fill' and occurred_at=$2",
      [trackedWalletId, sellAt],
    )
  ).rows;
  assert.equal(priorReplay.length, 1);
  assert.equal(
    priorReplay[0]?.metadata.prevShares,
    1,
    "prior-fill SQL is scoped to PM, not PM plus old CTF",
  );
  assert.equal(priorReplay[0]?.metadata.currShares, 0.5);
  for (const context of [legacyContext, nextContext]) {
    await db.query(
      "insert into orders(user_id,wallet_address,venue,token_id,side,order_type,price,size,status,order_payload) values($1,$2,'polymarket',$3,'SELL','GTC',.4,2,'live',$4::jsonb)",
      [
        userId,
        wallet,
        tokenId,
        JSON.stringify({
          tokenId,
          maker: wallet,
          makerAmount: context === legacyContext ? "1000000" : "2000000",
          takerAmount: "800000",
          assetContext: context,
        }),
      ],
    );
  }
  const legacyLocks = await fetchPolymarketOpenOrderPositionLocks(db, {
    userId,
    wallet,
    positionContract: "",
  });
  const pmLocks = await fetchPolymarketOpenOrderPositionLocks(db, {
    userId,
    wallet,
    positionContract: next.positionContract.toLowerCase(),
  });
  assert.equal(
    legacyLocks.get(`${wallet.toLowerCase()}:${tokenId}`),
    1_000_000n,
  );
  assert.equal(pmLocks.get(`${wallet.toLowerCase()}:${tokenId}`), 2_000_000n);
  incompleteRpc = true;
  const failedAt = new Date(internalAt.getTime() + 1000);
  const failed = await collectAutoTrackedWalletSnapshotRows(
    db,
    autoInputs(failedAt),
  );
  assert.equal(failed.refreshedWallets.length, 0);
  assert.equal(failed.previousOpenMarketKeys.length, 0);
  assert.equal(
    (await readSnapshots(failedAt)).length,
    0,
    "partial RPC response cannot write an empty holding snapshot",
  );
  await updatePositionMetrics(db, {
    userId,
    walletAddress: wallet,
    venue: "polymarket",
    metrics: [
      { tokenId, averagePrice: 0.3, realizedPnl: 0, unrealizedPnl: 1 },
      {
        tokenId,
        positionContract: next.positionContract.toLowerCase(),
        averagePrice: 0.4,
        realizedPnl: 0,
        unrealizedPnl: 2,
      },
    ],
  });
  positions = await fetchPositionsForUserWallet(db, {
    userId,
    walletAddresses: [wallet],
    venue: "polymarket",
  });
  assert.equal(
    positions.find((row) => !row.positionContract)?.unrealizedPnl,
    1,
  );
  assert.equal(positions.find((row) => row.positionContract)?.unrealizedPnl, 2);
  await db.query(
    "update unified_markets set resolved_outcome='YES', status='SETTLED' where id=$1",
    [marketId],
  );
  const pnl = await fetchPositionPnlSummaryForUserWallet(db, {
    userId,
    walletAddresses: [wallet],
    venue: "polymarket",
  });
  assert.ok(
    Math.abs(pnl.realizedPnlAllTime - 1.3) < 1e-9,
    "legacy YES and current V2 NO resolve with their frozen side",
  );
  await db.query(
    "update unified_markets set resolved_outcome=null, status='ACTIVE' where id=$1",
    [marketId],
  );
  await applyOptimisticPositionTrade(db, {
    userId,
    walletAddress: wallet,
    venue: "polymarket",
    tokenId,
    assetContext: nextContext,
    side: "BUY",
    shares: 1,
    notionalUsd: 0.4,
  });
  assert.equal(
    (
      await db.query(
        "select size::text from positions where user_id=$1 and position_contract=''",
        [userId],
      )
    ).rows[0].size,
    "3",
    "V2 optimistic fill does not change CTF",
  );
  await reconcileExactPositionBalance(db, {
    userId,
    walletAddress: wallet,
    venue: "polymarket",
    tokenId,
    assetContext: nextContext,
    size: 2,
    averagePrice: 0.4,
  });
  await syncWalletPositionsFromTokenBalances(db, {
    userId,
    walletAddress: wallet,
    venue: "polymarket",
    tokenBalances: [],
    flattenMissingTokenIds: [tokenId],
  });
  positions = await fetchPositionsForUserWallet(db, {
    userId,
    walletAddresses: [wallet],
    venue: "polymarket",
  });
  assert.equal(positions.length, 1, "complete CTF zero cannot flatten V2");
  assert.equal(positions[0]?.assetContext?.assetKind, "position_manager");
  assert.equal(positions[0]?.size, 2);
  console.log(
    "[polymarket-position-ledgers] ledger collision, frozen-side PNL, scoped metrics/optimistic/sync and exact reconciliation passed",
  );
} finally {
  globalThis.fetch = originalFetch;
  env.priceRefreshQueueEnabled = originalPriceRefreshQueueEnabled;
  if (walletId) await db.query("delete from wallets where id=$1", [walletId]);
  if (userId) {
    await db.query("delete from orders where user_id=$1", [userId]);
    await db.query("delete from positions where user_id=$1", [userId]);
    await db.query("delete from users where id=$1", [userId]);
  }
  await db.query("delete from polymarket_asset_bindings where market_id=$1", [
    marketId,
  ]);
  await db.query(
    "delete from unified_token_top_latest where token_id=any($1::text[])",
    [[tokenId, sibling]],
  );
  await db.query("delete from unified_tokens where market_id=$1", [marketId]);
  await db.query("delete from unified_market_tokens where market_id=$1", [
    marketId,
  ]);
  await db.query("delete from unified_markets where id=$1", [marketId]);
  await db.query("delete from unified_events where id=$1", [eventId]);
  await db.end();
}
