// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import type { Pool } from "@hunch/infra";
import {
  deleteHistoryOrder,
  claimLimitlessDirectOrderJournal,
  readLimitlessDirectOrderJournal,
  hasPositionDeltaApplied,
  inheritLimitlessPositionDeltaFromOrderAlias,
  noteLimitlessDirectOrderLocator,
  promoteLimitlessDirectOrderJournal,
  storeOrder,
  updateOrderFromHistory,
  type StoreOrderInput,
} from "./repos/orders-repo.js";
import {
  buildLimitlessClobSubmissionContext,
  directLimitlessClobClientOrderId,
  limitlessClobFrozenContext,
  limitlessClobSubmittedOrder,
  readLimitlessHistoryTxHashes,
  resolveLimitlessClobEvidenceIdentity,
} from "./services/limitless-clob-evidence-identity.js";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  insertVerifiedLimitlessCollateralAccruals,
  markVenueFeeBackfillAttempts,
  upsertVenueFeeAccruals,
  type VenueFeeAccrualInput,
} from "./services/venue-fee-accruals.js";
import {
  backfillLimitlessVenueShareAccruals,
  verifyLimitlessVenueShareAccruals,
} from "./services/limitless-fee-accruals.js";
import { fetchActiveFeePolicy } from "./repos/fee-policy.js";
import {
  readLimitlessObservedLocator,
  type LimitlessHistoryScan,
} from "./repos/limitless-observed-locator.js";
import { reconcileStaleTelegramTradeIntents } from "./services/telegram-bot-trading.js";
import { reconcileTelegramVenueIntents } from "./services/telegram-bot-trading-venue-reconcile.js";
import { deterministicLimitlessDirectHandoffClientOrderId } from "./services/limitless-order-identity.js";
import {
  parseLimitlessDirectHistoryPage,
  readDirectLimitlessHistory,
  reconcileLimitlessDirectOrderJournals,
} from "./funding/reconciliation/limitless-trade-attempt-reconciler.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const userId = randomUUID();
const owner = `0x${"1".repeat(40)}`;
const exchange = `0x${"2".repeat(40)}`;
const otherExchange = `0x${"3".repeat(40)}`;
const txHash = `0x${"a".repeat(64)}`;
const marker = "2026-10-08T00:00:00.000Z";
const signedOrder = {
  salt: "71",
  maker: owner,
  signer: owner,
  taker: `0x${"0".repeat(40)}`,
  tokenId: "123",
  makerAmount: "10000000",
  takerAmount: "20000000",
  expiration: "0",
  nonce: "0",
  feeRateBps: "0",
  side: 0,
  signatureType: 0,
  signature: "0xsigned",
  source: "server-prepared",
  clientOrderId: "local-client-order",
};
const context = buildLimitlessClobSubmissionContext(exchange, signedOrder);
const baseInput: StoreOrderInput = {
  userId,
  walletAddress: owner,
  venue: "limitless",
  venueOrderId: `context:${randomUUID()}`,
  tokenId: "limitless:123",
  side: "BUY",
  orderType: "FOK",
  price: 0.5,
  size: 20,
  status: "submitted",
  errorMessage: null,
  rawError: null,
  orderHash: txHash,
  fundingRecoveryMode: "explicit_only",
};
const calls: { sql: string; values: unknown[] }[] = [];
let transactionDepth = 0;
const session = {
  query: async (sql: string, values: unknown[] = []) => {
    if (sql.toLowerCase() === "begin")
      return client.query(`savepoint clob_context_${++transactionDepth}`);
    if (sql.toLowerCase() === "commit")
      return client.query(
        `release savepoint clob_context_${transactionDepth--}`,
      );
    if (sql.toLowerCase() === "rollback") {
      const result = await client.query(
        `rollback to savepoint clob_context_${transactionDepth}`,
      );
      await client.query(
        `release savepoint clob_context_${transactionDepth--}`,
      );
      return result;
    }
    calls.push({ sql, values });
    return client.query(sql, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
async function readOrder(id: string) {
  const result = await client.query<{
    order_payload: Record<string, unknown> | null;
    order_hash: string | null;
    verified_buy_facts: Record<string, unknown> | null;
    token_id: string;
    price: string | null;
    size: string | null;
    status: string;
    client_order_id: string | null;
  }>(
    `select order_payload,order_hash,verified_buy_facts,token_id,price,size,status,
      coalesce(order_payload->>'clientOrderId',order_payload->'submitted'->>'clientOrderId',
        order_payload->'_hunchSubmitted'->>'clientOrderId') as client_order_id
     from orders where id=$1`,
    [id],
  );
  assert.ok(result.rows[0]);
  return result.rows[0];
}
function assertFrozen(
  payload: Record<string, unknown> | null,
): asserts payload is Record<string, unknown> {
  assert.ok(payload);
  assert.deepEqual(limitlessClobFrozenContext(payload), context);
  assert.deepEqual(limitlessClobSubmittedOrder(payload), signedOrder);
  assert.deepEqual(
    resolveLimitlessClobEvidenceIdentity({
      orderPayload: payload,
      marketMetadata: { venueExchange: otherExchange },
      legacyExchangeAddress: otherExchange,
      providerOrder: { orderHash: context.orderHash },
    }),
    { exchangeAddress: exchange, orderHash: context.orderHash },
  );
}
async function applyHistory(id: string) {
  await updateOrderFromHistory(db, {
    id,
    status: "filled",
    price: 0.5,
    size: 20,
    filledAt: new Date(marker),
    lastUpdate: new Date(marker),
    orderHash: txHash,
    orderPayload: {
      source: "foo",
      _hunchLimitlessClob: { spoof: "root" },
      submitted: { _hunchLimitlessClob: { spoof: "submitted" } },
      _hunchUpstream: {
        data: { order: { _hunchLimitlessClob: { spoof: "provider" } } },
      },
      keep: "upstream history",
    },
  });
}
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const walkPlan = (node: PlanNode): PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(walkPlan),
];

try {
  assert.equal(
    Math.floor(
      Number(
        (await client.query("show server_version_num")).rows[0]
          .server_version_num,
      ) / 10000,
    ),
    16,
    "This fixture targets PostgreSQL 16",
  );
  await client.query("begin");
  await client.query("set local statement_timeout='120s'");
  await client.query("set local lock_timeout='5s'");
  await client.query(
    "insert into users(id,display_name) values($1,'CLOB context fixture')",
    [userId],
  );
  await client.query(
    `insert into orders(user_id,venue,venue_order_id,status)
     select $1,'limitless',$2||sequence_row::text,'submitted'
     from generate_series(1,50000) sequence_row`,
    [userId, `unrelated:${randomUUID()}:`],
  );
  await client.query("analyze orders");

  const fresh = await storeOrder(db, {
    ...baseInput,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: context,
  });
  assert.equal(fresh.kind, "stored");
  assertFrozen((await readOrder(fresh.order.id)).order_payload);
  const frozenBeforeRetry = await readOrder(fresh.order.id);
  assert.equal(
    (
      await storeOrder(db, {
        ...baseInput,
        orderPayload: signedOrder,
        limitlessClobSubmissionContext: context,
      })
    ).kind,
    "exists",
  );
  assert.deepEqual(await readOrder(fresh.order.id), frozenBeforeRetry);
  console.log(
    "ok - PG16 fresh trusted insert and identical retry preserve frozen order",
  );

  const collateralContext = buildLimitlessClobSubmissionContext(
    exchange,
    signedOrder,
    `0x${"4".repeat(40)}`,
  );
  const collateralOrder = await storeOrder(db, {
    ...baseInput,
    venueOrderId: `collateral:${randomUUID()}`,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: collateralContext,
  });
  await applyHistory(collateralOrder.order.id);
  const collateralPayload = (await readOrder(collateralOrder.order.id))
    .order_payload;
  assert.ok(collateralPayload);
  assert.deepEqual(
    limitlessClobFrozenContext(collateralPayload),
    collateralContext,
  );
  assert.equal(
    limitlessClobSubmittedOrder(collateralPayload)?.signature,
    undefined,
  );
  const primaryVenueId = randomUUID();
  const primaryOrder = await storeOrder(db, {
    ...baseInput,
    venueOrderId: primaryVenueId,
    orderHash: null,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: collateralContext,
  });
  const historyAliasOrder = await storeOrder(db, {
    ...baseInput,
    venueOrderId: `history:${txHash}:0:buy-position-marker`,
    status: "filled",
    orderPayload: {
      orderId: primaryVenueId,
      _hunchPositionDeltaAppliedAt: marker,
    },
  });
  assert.equal(
    await inheritLimitlessPositionDeltaFromOrderAlias(
      client,
      primaryOrder.order.id,
    ),
    "inherited",
  );
  assert.equal(
    await inheritLimitlessPositionDeltaFromOrderAlias(
      client,
      primaryOrder.order.id,
    ),
    "none",
  );
  const historyVenueId = historyAliasOrder.order.venue_order_id;
  assert.ok(historyVenueId);
  await deleteHistoryOrder(db, {
    userId,
    venue: "limitless",
    venueOrderId: historyVenueId,
    replacementOrderId: primaryOrder.order.id,
  });
  assert.equal(
    hasPositionDeltaApplied(
      (await readOrder(primaryOrder.order.id)).order_payload,
    ),
    true,
  );
  const refreshedHistoryAlias = await storeOrder(db, {
    ...baseInput,
    venueOrderId: `history:${txHash}:0:buy-position-marker`,
    status: "filled",
    orderPayload: { orderId: primaryVenueId },
  });
  await updateOrderFromHistory(db, {
    id: primaryOrder.order.id,
    status: "filled",
    price: 0.5,
    size: 20,
    filledAt: new Date(),
    lastUpdate: new Date(),
    orderHash: txHash,
    orderPayload: {},
  });
  assert.equal(
    await inheritLimitlessPositionDeltaFromOrderAlias(
      client,
      refreshedHistoryAlias.order.id,
    ),
    "inherited",
  );
  const unboundHistoryAlias = await storeOrder(db, {
    ...baseInput,
    venueOrderId: `history:${txHash}:2:buy-position-marker`,
    status: "filled",
    orderPayload: {},
  });
  assert.equal(
    await inheritLimitlessPositionDeltaFromOrderAlias(
      client,
      unboundHistoryAlias.order.id,
    ),
    "unbound",
  );
  assert.equal(
    hasPositionDeltaApplied(
      (await readOrder(unboundHistoryAlias.order.id)).order_payload,
    ),
    false,
  );
  const staleHistoryTx = `0x${"b".repeat(64)}`;
  for (const hash of [staleHistoryTx, txHash, staleHistoryTx]) {
    await updateOrderFromHistory(db, {
      id: primaryOrder.order.id,
      status: "filled",
      orderHash: hash,
      orderPayload: { transactionHash: hash },
      price: 0.5,
      size: 20,
      filledAt: new Date(),
      lastUpdate: new Date(),
    });
  }
  const primaryAfterHistory = await readOrder(primaryOrder.order.id);
  assert.equal(primaryAfterHistory.order_hash, txHash);
  assert.deepEqual(
    readLimitlessHistoryTxHashes(primaryAfterHistory.order_payload),
    [staleHistoryTx, txHash],
  );
  const latePrimary = await storeOrder(db, {
    ...baseInput,
    venueOrderId: randomUUID(),
    orderHash: staleHistoryTx,
    orderPayload: { ...signedOrder, clientOrderId: "late-history-client" },
    limitlessClobSubmissionContext: collateralContext,
  });
  const lateAlias = await storeOrder(db, {
    ...baseInput,
    venueOrderId: `history:${staleHistoryTx}:0:buy-late-id`,
    status: "filled",
    orderHash: staleHistoryTx,
    orderPayload: { _hunchPositionDeltaAppliedAt: marker },
  });
  const lateVenueOrderId = latePrimary.order.venue_order_id;
  const lateAliasVenueId = lateAlias.order.venue_order_id;
  assert.ok(lateVenueOrderId && lateAliasVenueId);
  await deleteHistoryOrder(db, {
    userId,
    venue: "limitless",
    venueOrderId: lateAliasVenueId,
    replacementOrderId: latePrimary.order.id,
    latestLimitlessHistory: {
      providerOrderId: lateVenueOrderId,
      clientOrderId: null,
      txHash: staleHistoryTx,
    },
  });
  assert.equal(
    hasPositionDeltaApplied(
      (await readOrder(latePrimary.order.id)).order_payload,
    ),
    true,
  );
  assert.equal(
    (
      await client.query("select id from orders where id=$1", [
        lateAlias.order.id,
      ])
    ).rowCount,
    0,
  );
  console.log(
    "ok - PG16 provider history cannot erase frozen fee context or viable receipt locators",
  );

  const alias = await storeOrder(db, {
    ...baseInput,
    venueOrderId: `collateral-alias:${randomUUID()}`,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: collateralContext,
  });
  const debit: VenueFeeAccrualInput = {
    userId,
    walletAddress: owner,
    signerAddress: owner,
    venue: "limitless",
    feeProgram: "venue_share",
    chainId: "8453",
    orderId: collateralOrder.order.id,
    orderHash: collateralContext.orderHash,
    venueOrderId: collateralOrder.order.venue_order_id,
    venueFillId: `collateral:${txHash}:86`,
    venueTradeId: collateralContext.orderHash,
    txHash,
    tokenId: "limitless:123",
    side: "SELL",
    role: "taker",
    attributionCode: null,
    feeRateBps: 1000,
    feeBasis: "venue_fee_share",
    notionalAmountRaw: "2109120",
    notionalAmount: "2.109120",
    feeAmountRaw: "6159",
    feeAmount: "0.006159",
    feeAsset: "USDC",
    venueFeeRateBps: 0,
    venueFeeAmountRaw: "61590",
    venueFeeAmount: "0.061590",
    filledAt: new Date(marker),
  };
  const aliasDebit = {
    ...debit,
    orderId: alias.order.id,
    venueOrderId: alias.order.venue_order_id,
  };
  assert.deepEqual(
    await insertVerifiedLimitlessCollateralAccruals(db, [debit, aliasDebit]),
    {
      upserted: 1,
      orderIds: [debit.orderId],
    },
  );
  assert.deepEqual(
    await insertVerifiedLimitlessCollateralAccruals(db, [aliasDebit]),
    {
      upserted: 0,
      orderIds: [],
    },
  );
  assert.deepEqual(
    await upsertVenueFeeAccruals(db, [
      { ...debit, venueFillId: "legacy-fixture" },
    ]),
    { upserted: 1 },
  );
  const feeRows = (
    await client.query<{
      venue_fill_id: string;
      status: string;
      verified: boolean;
    }>(
      `select venue_fill_id, status, chain_verified_at is not null as verified
       from venue_fee_accruals where order_id = any($1::uuid[]) order by venue_fill_id`,
      [[debit.orderId, aliasDebit.orderId]],
    )
  ).rows;
  assert.deepEqual(feeRows, [
    { venue_fill_id: debit.venueFillId, status: "verified", verified: true },
    { venue_fill_id: "legacy-fixture", status: "accrued", verified: false },
  ]);
  const write = calls.find(
    (call) =>
      call.sql.includes("existing_debit.tx_hash") &&
      call.values.at(-1) === true,
  );
  assert.ok(write);
  await client.query(`explain (format json) ${write.sql}`, write.values);
  console.log(
    "ok - PG16 exact debit aliases dedupe before treasury; legacy status unchanged",
  );

  const fillTime = new Date(Date.now() - 3_600_000);
  await client.query(
    `insert into fee_policy (venue,fee_bps,limitless_fee_share_bps,effective_at)
    values ('limitless',0,800,$1),('limitless',0,1200,$2)`,
    [new Date(fillTime.getTime() - 1000), new Date(fillTime.getTime() + 1000)],
  );
  assert.equal(
    (await fetchActiveFeePolicy(db, "limitless", fillTime))
      ?.limitless_fee_share_bps,
    800,
  );
  const delayedFeeSignedOrder = {
    ...signedOrder,
    clientOrderId: `fee-delay-${randomUUID()}`,
    salt: "60",
  };
  const delayedFeeOrder = await storeOrder(db, {
    ...baseInput,
    venueOrderId: randomUUID(),
    status: "filled",
    filledAt: fillTime,
    orderHash: null,
    orderPayload: delayedFeeSignedOrder,
    limitlessClobSubmissionContext: buildLimitlessClobSubmissionContext(
      exchange,
      delayedFeeSignedOrder,
      collateralContext.collateralFeeModule,
    ),
  });
  const feeScopeDb = {
    ...db,
    query: async (sql: string, values: unknown[] = []) => {
      const result = await session.query(sql, values);
      if (!sql.includes("with candidates as not materialized (")) return result;
      const rows = result.rows.filter(
        (row) => row.id === delayedFeeOrder.order.id,
      );
      return { ...result, rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  const discoveredFeeHash = `0x${"5".repeat(64)}`;
  const checkedFeeHashes: string[] = [];
  const delayedFeeOptions = {
    limit: 50,
    collateralReceiptProvider: {
      getTransactionReceipt: async (hash: string) => {
        checkedFeeHashes.push(hash);
        return null;
      },
      getBlock: async () => null,
    },
  };
  await backfillLimitlessVenueShareAccruals(feeScopeDb, {
    ...delayedFeeOptions,
    fetchStatusBatch: async () =>
      new Map([
        [
          delayedFeeOrder.order.venue_order_id,
          {
            orderId: delayedFeeOrder.order.venue_order_id,
            payload: { execution: { txHash: discoveredFeeHash } },
          },
        ],
      ]),
  });
  const pendingFeeOrder = await readOrder(delayedFeeOrder.order.id);
  assert.equal(pendingFeeOrder.order_hash, null);
  assert.deepEqual(
    readLimitlessHistoryTxHashes(pendingFeeOrder.order_payload),
    [discoveredFeeHash],
  );
  await client.query(
    `update venue_fee_backfill_attempts set next_attempt_at=now()-interval '1 second' where order_id=$1`,
    [delayedFeeOrder.order.id],
  );
  await backfillLimitlessVenueShareAccruals(feeScopeDb, {
    ...delayedFeeOptions,
    fetchStatusBatch: async () => new Map(),
  });
  assert.deepEqual(
    checkedFeeHashes,
    [discoveredFeeHash, discoveredFeeHash],
    "a later empty provider status cannot erase the worker's saved receipt request",
  );
  console.log(
    "ok - PG16 finance-worker retains an unfinalized fresh status locator across batches",
  );
  const gtc = await storeOrder(db, {
    ...baseInput,
    venueOrderId: randomUUID(),
    orderType: "GTC",
    status: "filled",
    filledAt: fillTime,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: collateralContext,
  });
  const priorFee = {
    ...debit,
    orderId: gtc.order.id,
    venueOrderId: gtc.order.venue_order_id,
    venueFillId: "stale-provider-fee",
  };
  await upsertVenueFeeAccruals(db, [priorFee]);
  const missingProvenance = {
    venue: "limitless",
    feeProgram: "venue_share",
    orderId: gtc.order.id,
    venueOrderId: gtc.order.venue_order_id,
    status: "retry" as const,
    reason: "Limitless collateral fee provenance missing",
  };
  for (let i = 0; i < 2; i++)
    await markVenueFeeBackfillAttempts(db, [missingProvenance], {
      maxRetryAttempts: 2,
    });
  const deferredFee = {
    venue: "limitless",
    feeProgram: "venue_share_collateral",
    orderId: alias.order.id,
    venueOrderId: alias.order.venue_order_id,
    status: "retry" as const,
    reason: "Limitless collateral fee RPC budget exhausted",
    nextAttemptAt: new Date(Date.now() + 60_000),
    consumeAttempt: false,
  };
  await markVenueFeeBackfillAttempts(
    db,
    [{ ...deferredFee, consumeAttempt: true }],
    { maxRetryAttempts: 2 },
  );
  for (let i = 0; i < 3; i++)
    await markVenueFeeBackfillAttempts(db, [deferredFee], {
      maxRetryAttempts: 2,
    });
  assert.deepEqual(
    (
      await client.query(
        `select status,attempts from venue_fee_backfill_attempts where order_id=$1`,
        [alias.order.id],
      )
    ).rows,
    [{ status: "retry", attempts: 1 }],
  );
  await client.query(
    `update venue_fee_backfill_attempts set status='failed',attempts=8,next_attempt_at=null
     where venue='limitless' and fee_program='venue_share_collateral' and order_id=$1`,
    [alias.order.id],
  );
  const feeWake = {
    id: alias.order.id,
    status: "filled",
    price: null,
    size: null,
    filledAt: null,
    lastUpdate: null,
    orderHash: `0x${"f".repeat(64)}`,
  };
  await updateOrderFromHistory(db, feeWake);
  const readFeeWake = async () =>
    (
      await client.query(
        `select status,attempts,next_attempt_at
    from venue_fee_backfill_attempts where venue='limitless' and fee_program='venue_share_collateral' and order_id=$1`,
        [alias.order.id],
      )
    ).rows[0];
  const woken = await readFeeWake();
  assert.equal(woken.status, "retry");
  assert.equal(woken.attempts, 0);
  await updateOrderFromHistory(db, feeWake);
  assert.deepEqual(
    await readFeeWake(),
    woken,
    "unchanged history must not repeatedly wake fee reconciliation",
  );
  const fixtureDb = {
    ...db,
    query: async (sql: string, values: unknown[] = []) => {
      const result = await session.query(sql, values);
      if (
        sql.includes("with candidates as not materialized (") ||
        sql.includes("from venue_fee_accruals a\n      left join orders")
      ) {
        const rows = result.rows.filter(
          (row) => row.id === gtc.order.id || row.order_id === gtc.order.id,
        );
        return { ...result, rows, rowCount: rows.length };
      }
      return result;
    },
  } as unknown as Pool;
  assert.deepEqual(await backfillLimitlessVenueShareAccruals(fixtureDb), {
    checked: 1,
    upserted: 0,
    skipped: 1,
  });
  const candidateQuery = calls.find(
    (call) =>
      call.sql.includes("with candidates as not materialized (") &&
      call.sql.includes("collateralFeeModule"),
  );
  assert.ok(candidateQuery);
  await client.query(
    `explain (analyze,buffers,format json) ${candidateQuery.sql}`,
    candidateQuery.values,
  );
  assert.deepEqual(
    (
      await client.query(
        `select fee_program, status, reason, attempts
    from venue_fee_backfill_attempts where order_id=$1 order by fee_program`,
        [gtc.order.id],
      )
    ).rows,
    [
      {
        fee_program: "venue_share",
        status: "failed",
        reason:
          "Limitless collateral fee provenance missing (max attempts reached)",
        attempts: 2,
      },
      {
        fee_program: "venue_share_collateral",
        status: "skipped",
        reason: "Limitless collateral GTC fee reconciliation unsupported",
        attempts: 1,
      },
    ],
  );
  assert.equal(
    (
      await client.query(
        `select status from venue_fee_accruals where order_id=$1 and venue_fill_id=$2`,
        [gtc.order.id, priorFee.venueFillId],
      )
    ).rows[0]?.status,
    "failed",
  );
  await upsertVenueFeeAccruals(db, [
    {
      ...debit,
      orderId: gtc.order.id,
      venueOrderId: gtc.order.venue_order_id,
      venueFillId: "stale-provisional",
    },
  ]);
  assert.deepEqual(await verifyLimitlessVenueShareAccruals(fixtureDb), {
    checked: 1,
    verified: 0,
    failed: 1,
    skipped: 0,
  });
  const providerOnly = await storeOrder(db, {
    ...baseInput,
    venueOrderId: randomUUID(),
    status: "filled",
    filledAt: fillTime,
    orderHash: null,
    orderPayload: {
      _hunchUpstream: {
        execution: {
          matched: true,
          settlementStatus: "CONFIRMED",
          feeRateBps: 300,
          txHash,
          totalsRaw: { usdGross: "1000000", usdFee: "4700" },
        },
      },
    },
  });
  const queuedCollateral = await storeOrder(db, {
    ...baseInput,
    venueOrderId: randomUUID(),
    status: "submitted",
    postedAt: new Date(fillTime.getTime() + 1_000),
    lastUpdate: new Date(fillTime.getTime() + 1_000),
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: collateralContext,
  });
  const admissionSql = candidateQuery.sql.replace(
    "where o.venue = 'limitless'",
    "where o.venue = 'limitless' and o.id=any($7::uuid[])",
  );
  const admissionValues = [
    ...candidateQuery.values,
    [queuedCollateral.order.id, providerOnly.order.id],
  ];
  admissionValues[1] = 1;
  assert.deepEqual(
    (await client.query(admissionSql, admissionValues)).rows.map(
      (row) => row.id,
    ),
    [queuedCollateral.order.id],
  );
  admissionValues[1] = 2;
  assert.deepEqual(
    (await client.query(admissionSql, admissionValues)).rows.map(
      (row) => row.id,
    ),
    [queuedCollateral.order.id, providerOnly.order.id],
  );
  await upsertVenueFeeAccruals(db, [
    {
      ...debit,
      orderId: providerOnly.order.id,
      venueOrderId: providerOnly.order.venue_order_id,
      orderHash: "provider-status-only",
      txHash: null,
      venueFillId: "status-only",
    },
  ]);
  const providerOnlyDb = {
    ...db,
    query: async (sql: string, values: unknown[] = []) => {
      const result = await session.query(sql, values);
      if (!sql.includes("from venue_fee_accruals a\n      left join orders"))
        return result;
      const rows = result.rows.filter(
        (row) => row.order_id === providerOnly.order.id,
      );
      return { ...result, rows, rowCount: rows.length };
    },
  } as unknown as Pool;
  const noStatusRPC = async () => ({ statuses: new Map(), unavailable: false });
  assert.deepEqual(
    await verifyLimitlessVenueShareAccruals(providerOnlyDb, {
      fetchStatuses: noStatusRPC,
    }),
    { checked: 1, verified: 0, failed: 0, skipped: 1 },
  );
  assert.deepEqual(
    (
      await client.query(
        `select status, verification_error from venue_fee_accruals where order_id=$1`,
        [providerOnly.order.id],
      )
    ).rows,
    [
      {
        status: "accrued",
        verification_error: "Limitless USD fee receipt required",
      },
    ],
  );
  assert.equal(
    (
      await verifyLimitlessVenueShareAccruals(providerOnlyDb, {
        fetchStatuses: noStatusRPC,
      })
    ).checked,
    0,
  );
  console.log(
    "ok - PG16 settlement-time policy, bounded backfill selection, GTC and stale provisional records",
  );

  const marketId = `collateral-market:${randomUUID()}`;
  const telegramUserId = `${Date.now()}`;
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status)
    values($1,'limitless',$1,'Telegram collateral fixture','ACTIVE')`,
    [marketId],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type)
    values($1,'limitless',$1,$1,'Telegram collateral fixture','ACTIVE','binary')`,
    [marketId],
  );
  const telegramRows = new Map<string, string>();
  for (const withModule of [true, false]) {
    const clientOrderId = randomUUID();
    const staleHistory = await storeOrder(db, {
      ...baseInput,
      venueOrderId: randomUUID(),
      status: "filled",
      orderPayload: { clientOrderId },
      filledAt: fillTime,
    });
    const { rows } = await client.query<{ id: string }>(
      `insert into telegram_trade_intents (
      telegram_user_id, user_id, venue, action, market_id, side, amount_usd, status, expires_at,
      idempotency_key, delivery_mode, prepared_snapshot, submit_started_at, result
    ) values ($1,$2,'limitless','buy',$3,'YES',1,'executing',now()+interval '10 minutes',$4,'app_handoff',$5::jsonb,now(),$6::jsonb) returning id`,
      [
        telegramUserId,
        userId,
        marketId,
        randomUUID(),
        {
          reconcileKeys: { clientOrderId },
          recoveryPayload: {
            ...(withModule ? { submissionContext: collateralContext } : {}),
          },
        },
        {
          appHandoffExecution: {
            version: 2,
            kind: "direct_trade",
            handoffId: randomUUID(),
            committedAt: fillTime.toISOString(),
          },
        },
      ],
    );
    assert.ok(rows[0]?.id);
    telegramRows.set(rows[0].id, withModule ? "" : staleHistory.order.id);
  }
  assert.equal(
    (await reconcileStaleTelegramTradeIntents(db, { telegramUserId }))
      .backfilledOrderRefs,
    1,
  );
  for (const [intentId, expectedOrder] of telegramRows) {
    const row = (
      await client.query(
        `select order_id, status from telegram_trade_intents where id=$1`,
        [intentId],
      )
    ).rows[0];
    assert.equal(row?.order_id, expectedOrder || null);
    assert.equal(row?.status, expectedOrder ? "filled" : "executing");
  }
  const sealedIntentId = [...telegramRows].find(([, orderId]) => !orderId)?.[0];
  assert.ok(sealedIntentId);
  const handoffId = randomUUID();
  const sealedClientId =
    deterministicLimitlessDirectHandoffClientOrderId(handoffId);
  await client.query(
    `update telegram_trade_intents
      set prepared_snapshot=$2::jsonb, submit_started_at=now()-interval '10 minutes',
          result=result || $3::jsonb where id=$1`,
    [
      sealedIntentId,
      {
        authorizationMode: "client_signed",
        preparedId: `handoff-v2:${handoffId}`,
        reconcileKeys: { clientOrderId: sealedClientId, tradeType: "clob" },
        recoveryPayload: {
          submissionContext: collateralContext,
          orderPayload: signedOrder,
          tokenId: baseInput.tokenId,
        },
      },
      {
        appHandoffDirectTradeClaim: {
          version: 2,
          handoffId,
          planFingerprint: "fixture",
        },
      },
    ],
  );
  await storeOrder(db, {
    ...baseInput,
    venueOrderId: `history:${txHash}:1:buy-telegram`,
    status: "filled",
    orderPayload: { clientOrderId: sealedClientId },
  });
  const conflicted = await reconcileTelegramVenueIntents(
    db,
    {} as never,
    {
      intentId: sealedIntentId,
      dryRun: false,
    },
    {
      inspectVenueSubmit: async () => ({
        state: "limitless_clob_not_found",
        submitResult: null,
      }),
    },
  );
  assert.equal(conflicted.failedVerified, 0);
  assert.equal(
    conflicted.items[0]?.venueState,
    "limitless_clob_history_conflict",
  );
  assert.equal(
    (
      await client.query(
        "select status from telegram_trade_intents where id=$1",
        [sealedIntentId],
      )
    ).rows[0]?.status,
    "executing",
  );
  console.log(
    "ok - PG16 Telegram history cannot finalize a collateral intent before exact recovery",
  );
  const directClientId = `hunch-direct-${randomUUID().replaceAll("-", "")}`;
  const directSignedOrder = {
    ...signedOrder,
    takerAmount: "1",
    clientOrderId: directClientId,
    ownerId: 7,
  };
  assert.equal(
    directLimitlessClobClientOrderId(directSignedOrder),
    directLimitlessClobClientOrderId({
      ...directSignedOrder,
      salt: "0071",
      unrelated: "changed",
      signature: "0xignored",
    }),
  );
  const directContext = buildLimitlessClobSubmissionContext(
    exchange,
    directSignedOrder,
    `0x${"4".repeat(40)}`,
  );
  const directInput = {
    ...baseInput,
    orderHash: null,
    orderPayload: directSignedOrder,
    limitlessClobSubmissionContext: directContext,
  };
  const directClaim = await claimLimitlessDirectOrderJournal(
    db,
    directClientId,
    directInput,
  );
  assert.ok(directClaim?.kind === "stored");
  assert.equal(
    await claimLimitlessDirectOrderJournal(db, directClientId, directInput),
    null,
  );
  const secondId = `hunch-direct-${randomUUID().replaceAll("-", "")}`;
  const secondOrder = {
    ...directSignedOrder,
    clientOrderId: secondId,
    salt: "72",
  };
  const secondInput = {
    ...directInput,
    orderPayload: secondOrder,
    limitlessClobSubmissionContext: buildLimitlessClobSubmissionContext(
      exchange,
      secondOrder,
      `0x${"4".repeat(40)}`,
    ),
  };
  assert.deepEqual(
    await claimLimitlessDirectOrderJournal(db, secondId, secondInput),
    { kind: "prior_pending", clientOrderId: directClientId },
  );
  const pendingOrderPayload = (await readOrder(directClaim.order.id))
    .order_payload;
  assert.ok(pendingOrderPayload);
  assert.equal(
    limitlessClobSubmittedOrder(pendingOrderPayload)?.signature,
    undefined,
  );
  const actualDirectVenueId = randomUUID();
  const receipts = new Interface([
    "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)",
  ]);
  const encoded = receipts.encodeEventLog("OrderFilled", [
    directContext.orderHash,
    owner,
    otherExchange,
    0n,
    123n,
    10_000_000n,
    20_000_000n,
    0n,
  ]);
  const pollTime = new Date(Date.now() + 60_000);
  const fixtureConfig = {
    apiBase: "https://unused.invalid",
    hmacSecret: "unused",
    hmacTokenId: "unused",
  };
  const historyCalls: string[] = [];
  const portfolioScope = {
    ownerId: 7,
    clientOrderId: randomUUID(),
    postedAt: pollTime,
  };
  const simulatedHistory: typeof fetch = async (url) => {
    const search = new URL(String(url)).search;
    historyCalls.push(search);
    return Response.json(
      search.includes("cursor=")
        ? {
            data: [
              {
                clientOrderId: portfolioScope.clientOrderId,
                orderId: actualDirectVenueId,
                transactionHash: txHash,
                createdAt: new Date(pollTime.getTime() - 1).toISOString(),
              },
            ],
            totalCount: 30,
          }
        : {
            data: [
              {
                createdAt: new Date(pollTime.getTime() + 1_000).toISOString(),
                type: "split",
              },
            ],
            totalCount: 30,
            nextCursor: "opaque_tail",
          },
    );
  };
  const firstHistoryPage = await readDirectLimitlessHistory(
    fixtureConfig,
    portfolioScope,
    simulatedHistory,
  );
  assert.equal(firstHistoryPage?.coversSubmission, false);
  const nextHistoryPage = await readDirectLimitlessHistory(
    fixtureConfig,
    { ...portfolioScope, historyScan: firstHistoryPage?.nextScan },
    simulatedHistory,
  );
  assert.deepEqual(historyCalls, [
    "?limit=25&page=1",
    "?limit=25&cursor=opaque_tail",
  ]);
  assert.equal(
    nextHistoryPage?.coversSubmission,
    false,
    "a tail page can prove a fill but not absence by itself",
  );
  assert.deepEqual(nextHistoryPage?.locators, [
    { tx_hash: txHash, provider_order_id: actualDirectVenueId },
  ]);
  assert.equal(nextHistoryPage?.nextScan, null);
  for (const data of [
    [],
    [{ createdAt: new Date(pollTime.getTime() + 1_000).toISOString() }],
  ]) {
    const lastNumericPage = await readDirectLimitlessHistory(
      fixtureConfig,
      { ...portfolioScope, historyScan: { page: 2 } },
      async (url) => {
        assert.equal(new URL(String(url)).searchParams.get("page"), "2");
        return Response.json({ data, totalCount: 26 });
      },
    );
    assert.equal(
      lastNumericPage?.coversSubmission,
      false,
      "empty/short numeric tails cannot prove absence",
    );
    assert.equal(
      lastNumericPage?.nextScan,
      null,
      "page offsets use total count, not the length of only this page",
    );
  }
  const backlog = Array.from({ length: 65 }, (_, index) => ({
    scope: { ...portfolioScope, ownerId: index + 10 },
    progress: null as LimitlessHistoryScan | null,
  }));
  historyCalls.length = 0;
  for (let turn = 0; turn < 2; turn++) {
    for (const item of backlog) {
      const page = await readDirectLimitlessHistory(
        fixtureConfig,
        {
          ...item.scope,
          historyScan: item.progress,
        },
        simulatedHistory,
      );
      assert.equal(
        page?.locators.length,
        turn,
        "page two continues after the full backlog has rotated",
      );
      item.progress = page?.nextScan ?? null;
    }
  }
  assert.equal(
    historyCalls.filter((value) => value.includes("cursor")).length,
    65,
  );
  const retryOrder = {
    userId,
    journalId: directClaim.order.id,
    clientOrderId: directClientId,
  };
  const locatorKey = "_hunchLimitlessDirectLocator";
  const pageTwo = { page: 2, cursor: "opaque_tail" };
  await noteLimitlessDirectOrderLocator(db, {
    ...retryOrder,
    providerOrderId: null,
    history: { hashes: [], scan: { previous: null, next: pageTwo } },
  });
  const readCursor = async () =>
    readLimitlessObservedLocator(
      (await readOrder(retryOrder.journalId)).order_payload?.[locatorKey],
    );
  assert.deepEqual((await readCursor()).historyScan, pageTwo);
  const pageThree = { page: 3, cursor: "next" };
  await noteLimitlessDirectOrderLocator(db, {
    ...retryOrder,
    providerOrderId: null,
    history: { hashes: [], scan: { previous: pageTwo, next: pageThree } },
  });
  await noteLimitlessDirectOrderLocator(db, {
    ...retryOrder,
    providerOrderId: null,
    history: { hashes: [txHash], scan: { previous: pageTwo, next: null } },
  });
  assert.deepEqual(
    (await readCursor()).historyScan,
    pageThree,
    "stale page cannot erase progress",
  );
  assert.deepEqual(
    (await readCursor()).hashes,
    [txHash],
    "stale concurrent exact locators still merge",
  );
  await client.query(
    `update orders set order_payload=order_payload - $2::text where id=$1`,
    [retryOrder.journalId, locatorKey],
  );
  const otherMarketMissingHash = parseLimitlessDirectHistoryPage(
    {
      data: [
        {
          market: { slug: "other-market" },
          createdAt: new Date(pollTime.getTime() + 1).toISOString(),
        },
      ],
      totalCount: 1,
    },
    {
      ...portfolioScope,
      marketSlug: "bound-market",
      tokenId: "123",
      side: "BUY",
    },
  );
  assert.equal(otherMarketMissingHash?.coversSubmission, true);
  assert.equal(
    otherMarketMissingHash?.unboundMissingTx,
    undefined,
    "a different token cannot block this funded order",
  );
  const portfolioSplit = {
    market: { slug: "bound-market" },
    strategy: "Split",
    blockTimestamp: Math.trunc(pollTime.getTime() / 1_000) + 10,
  };
  const splitScope = { ...portfolioScope, marketSlug: "bound-market" };
  const recentSplit = parseLimitlessDirectHistoryPage(
    { data: [portfolioSplit], totalCount: 1 },
    splitScope,
  );
  assert.equal(
    recentSplit?.unboundMissingTx,
    undefined,
    "same-market wallet splits are not possible order fills",
  );
  assert.equal(
    parseLimitlessDirectHistoryPage(
      {
        data: [{ ...portfolioSplit, clientOrderId: splitScope.clientOrderId }],
      },
      splitScope,
    )?.exactClientFound,
    true,
    "even an odd history type cannot erase an exact binding",
  );
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      config: fixtureConfig,
      now: pollTime,
      lookup: async () =>
        new Map([
          [
            directClientId,
            {
              kind: "found",
              item: {
                clientOrderId: directClientId,
                orderId: actualDirectVenueId,
                providerOrderId: actualDirectVenueId,
                payload: {
                  data: {
                    order: {
                      order: { status: "submitted" },
                      execution: {
                        matched: false,
                        settlementStatus: "DELAYED",
                      },
                    },
                  },
                },
              },
            },
          ],
        ]),
      readFreshHistory: async () => null,
    }),
    0,
  );
  assert.equal(
    (await readLimitlessDirectOrderJournal(db, userId, directClientId))
      ?.venue_order_id,
    `client:${directClientId}`,
  );
  assert.deepEqual(
    await claimLimitlessDirectOrderJournal(db, secondId, secondInput),
    { kind: "prior_pending", clientOrderId: directClientId },
  );
  const syncedProviderOrder = await storeOrder(db, {
    ...baseInput,
    venueOrderId: actualDirectVenueId,
    orderHash: null,
    orderPayload: { orderId: actualDirectVenueId },
  });
  let observed = 0;
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      config: {
        apiBase: "https://unused.invalid",
        hmacSecret: "unused",
        hmacTokenId: "unused",
      },
      now: new Date(pollTime.getTime() + 31_000),
      lookup: async (ids) => {
        assert.deepEqual(ids, [directClientId]);
        return new Map([[directClientId, { kind: "not_found" }]]);
      },
      readFreshHistory: async (request) => {
        assert.equal(request.ownerId, 7);
        assert.equal(request.clientOrderId, directClientId);
        assert.equal(request.providerOrderId, actualDirectVenueId);
        const page = parseLimitlessDirectHistoryPage(
          {
            data: [
              {
                orderId: actualDirectVenueId,
                transactionHash: txHash,
              },
            ],
          },
          request,
        );
        assert.equal(
          page?.exactClientFound,
          true,
          "fresh wallet history may omit clientOrderId",
        );
        return page;
      },
      readHistoryReceipt: async (hash) => {
        observed++;
        assert.equal(hash, txHash);
        return {
          receipt: {
            hash,
            status: 1,
            logs: [{ address: exchange, index: 1, ...encoded }],
          },
          canonicalBlock: { number: 1, hash: txHash },
          timestamp: fillTime.toISOString(),
        };
      },
    }),
    1,
  );
  assert.equal(observed, 1);
  const directResult = await readLimitlessDirectOrderJournal(
    db,
    userId,
    directClientId,
  );
  assert.deepEqual(directResult, {
    id: syncedProviderOrder.order.id,
    status: "filled",
    venue_order_id: actualDirectVenueId,
  });
  assert.equal(
    await readLimitlessDirectOrderJournal(
      db,
      userId,
      directClientId,
      otherExchange,
    ),
    null,
  );
  assert.deepEqual(
    limitlessClobFrozenContext(
      (await readOrder(syncedProviderOrder.order.id)).order_payload as Record<
        string,
        unknown
      >,
    ),
    directContext,
  );
  assert.equal(
    await claimLimitlessDirectOrderJournal(db, directClientId, directInput),
    null,
  );
  const secondClaim = await claimLimitlessDirectOrderJournal(
    db,
    secondId,
    secondInput,
  );
  assert.ok(
    secondClaim?.kind === "stored",
    "verified resolution releases the scope for a new intentional order",
  );
  await db.query("SAVEPOINT direct_history_fairness");
  const allDue = [secondId];
  for (const extraWallet of [exchange, otherExchange]) {
    const extraId = `hunch-direct-${randomUUID().replaceAll("-", "")}`;
    const extra = {
      ...secondOrder,
      clientOrderId: extraId,
      maker: extraWallet,
      signer: extraWallet,
    };
    assert.equal(
      (
        await claimLimitlessDirectOrderJournal(db, extraId, {
          ...secondInput,
          walletAddress: extraWallet,
          signerAddress: extraWallet,
          orderPayload: extra,
          limitlessClobSubmissionContext: buildLimitlessClobSubmissionContext(
            exchange,
            extra,
            `0x${"4".repeat(40)}`,
          ),
        })
      )?.kind,
      "stored",
    );
    allDue.push(extraId);
  }
  const visited = new Set<string>();
  for (const delay of [100_000, 131_000]) {
    await reconcileLimitlessDirectOrderJournals(db, {
      config: fixtureConfig,
      now: new Date(pollTime.getTime() + delay),
      lookup: async () => new Map(),
      readFreshHistory: async (request) => {
        visited.add(request.clientOrderId);
        return null;
      },
    });
  }
  assert.deepEqual(
    [...visited].sort(),
    allDue.sort(),
    "two history slots must cover three unresolved journals in successive passes",
  );
  await db.query("ROLLBACK TO SAVEPOINT direct_history_fairness");
  await db.query("RELEASE SAVEPOINT direct_history_fairness");

  const secondVenueId = randomUUID();
  const secondTx = `0x${"b".repeat(64)}`;
  const secondEncoded = receipts.encodeEventLog("OrderFilled", [
    secondInput.limitlessClobSubmissionContext.orderHash,
    owner,
    otherExchange,
    0n,
    123n,
    10_000_000n,
    20_000_000n,
    0n,
  ]);
  const lostResponse = {
    config: fixtureConfig,
    lookup: async (ids: readonly string[]) => {
      assert.deepEqual(ids, [secondId]);
      return new Map([[secondId, { kind: "not_found" as const }]]);
    },
    readFreshHistory: async (
      request: Parameters<typeof parseLimitlessDirectHistoryPage>[1],
    ) => {
      assert.equal(request.providerOrderId, null);
      assert.equal(
        parseLimitlessDirectHistoryPage({ data: [], totalCount: 1 }, request)
          ?.coversSubmission,
        false,
      );
      return parseLimitlessDirectHistoryPage(
        {
          data: [
            ...[1, 2, 3, 4, 5].map((suffix) => ({
              createdAt: pollTime.toISOString(),
              details: {
                orderId: randomUUID(),
                transactionHash: `0x${String(suffix).repeat(64)}`,
              },
            })),
            {
              createdAt: pollTime.toISOString(),
              details: {
                orderId: secondVenueId,
                transactionHash: secondTx,
              },
            },
          ],
          totalCount: 6,
        },
        request,
      );
    },
  };
  const maturePoll = new Date(pollTime.getTime() + 6 * 60_000);
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      ...lostResponse,
      now: maturePoll,
      readHistoryReceipt: async () => null,
    }),
    0,
  );
  assert.deepEqual(
    await claimLimitlessDirectOrderJournal(
      db,
      `hunch-direct-${randomUUID().replaceAll("-", "")}`,
      directInput,
    ),
    { kind: "prior_pending", clientOrderId: secondId },
  );
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      ...lostResponse,
      now: new Date(maturePoll.getTime() + 31_000),
      readHistoryReceipt: async (hash) => ({
        receipt: {
          hash,
          status: 1,
          logs:
            hash === secondTx
              ? [{ address: exchange, index: 1, ...secondEncoded }]
              : [],
        },
        canonicalBlock: { number: 2, hash: secondTx },
        timestamp: fillTime.toISOString(),
      }),
    }),
    1,
  );
  assert.deepEqual(
    await readLimitlessDirectOrderJournal(db, userId, secondId),
    {
      id: secondClaim.order.id,
      status: "filled",
      venue_order_id: secondVenueId,
    },
  );
  const contradictoryId = `hunch-direct-${randomUUID().replaceAll("-", "")}`;
  const contradictoryVenueId = randomUUID();
  const contradictoryTx = `0x${"8".repeat(64)}`;
  const contradictoryOrder = {
    ...directSignedOrder,
    clientOrderId: contradictoryId,
    salt: "73",
  };
  const contradictoryContext = buildLimitlessClobSubmissionContext(
    exchange,
    contradictoryOrder,
    `0x${"4".repeat(40)}`,
  );
  const contradictoryClaim = await claimLimitlessDirectOrderJournal(
    db,
    contradictoryId,
    {
      ...directInput,
      orderPayload: contradictoryOrder,
      limitlessClobSubmissionContext: contradictoryContext,
    },
  );
  assert.ok(contradictoryClaim?.kind === "stored");
  const firstContradictoryTx = `0x${"9".repeat(64)}`;
  await noteLimitlessDirectOrderLocator(db, {
    userId,
    journalId: contradictoryClaim.order.id,
    clientOrderId: contradictoryId,
    providerOrderId: contradictoryVenueId,
    txHash: firstContradictoryTx,
  });
  const emptyHistory = async () => ({
    exactClientFound: false,
    coversSubmission: true,
    locators: [],
  });
  const contradictoryPoll = new Date(maturePoll.getTime() + 62_000);
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      config: fixtureConfig,
      now: contradictoryPoll,
      lookup: async () =>
        new Map([
          [
            contradictoryId,
            {
              kind: "found",
              item: {
                orderId: contradictoryVenueId,
                providerOrderId: contradictoryVenueId,
                clientOrderId: contradictoryId,
                payload: {
                  order: { status: "failed" },
                  execution: { txHash: contradictoryTx },
                },
              },
            },
          ],
        ]),
      readFreshHistory: emptyHistory,
      readHistoryReceipt: async (hash) =>
        hash === firstContradictoryTx
          ? {
              receipt: { hash, status: 0, logs: [] },
              canonicalBlock: { number: 3, hash },
              timestamp: fillTime.toISOString(),
            }
          : null,
    }),
    0,
    "FAILED with an unclassified transaction must remain unresolved",
  );
  const contradictoryEncoded = receipts.encodeEventLog("OrderFilled", [
    contradictoryContext.orderHash,
    owner,
    otherExchange,
    0n,
    123n,
    10_000_000n,
    20_000_000n,
    0n,
  ]);
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      config: fixtureConfig,
      now: new Date(contradictoryPoll.getTime() + 31_000),
      lookup: async () => new Map([[contradictoryId, { kind: "not_found" }]]),
      readFreshHistory: emptyHistory,
      readHistoryReceipt: async (hash) => ({
        receipt: {
          hash,
          status: hash === firstContradictoryTx ? 0 : 1,
          logs:
            hash === contradictoryTx
              ? [{ address: exchange, index: 1, ...contradictoryEncoded }]
              : [],
        },
        canonicalBlock: { number: 3, hash: contradictoryTx },
        timestamp: fillTime.toISOString(),
      }),
    }),
    1,
    "the retained locator remains usable when the next exact lookup has no result",
  );
  assert.deepEqual(
    await readLimitlessDirectOrderJournal(db, userId, contradictoryId),
    {
      id: contradictoryClaim.order.id,
      status: "filled",
      venue_order_id: contradictoryVenueId,
    },
  );
  console.log(
    "ok - PG16 independent retries cannot dispatch while pending; fresh exact history and finalized receipt restore the original order",
  );

  const historyOnlyClientId = `hunch-direct-${randomUUID().replaceAll("-", "")}`;
  const historyOnlyProviderId = randomUUID();
  const historyOnlyOrder = {
    ...directSignedOrder,
    clientOrderId: historyOnlyClientId,
    salt: "76",
  };
  const historyOnlyContext = buildLimitlessClobSubmissionContext(
    exchange,
    historyOnlyOrder,
    directContext.collateralFeeModule,
  );
  const historyOnlyClaim = await claimLimitlessDirectOrderJournal(
    db,
    historyOnlyClientId,
    {
      ...directInput,
      orderPayload: historyOnlyOrder,
      limitlessClobSubmissionContext: historyOnlyContext,
    },
  );
  assert.ok(historyOnlyClaim?.kind === "stored");
  const lookupHistoryOnly = async () =>
    new Map([[historyOnlyClientId, { kind: "not_found" as const }]]);
  const historyOnlyHash = `0x${"6".repeat(64)}`;
  const historyOnlyPoll = new Date(contradictoryPoll.getTime() + 85_000);
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      config: fixtureConfig,
      now: historyOnlyPoll,
      lookup: lookupHistoryOnly,
      readFreshHistory: async () => ({
        ...(await emptyHistory()),
        exactClientFound: true,
        locators: [
          {
            tx_hash: historyOnlyHash,
            provider_order_id: historyOnlyProviderId,
          },
        ],
      }),
      readHistoryReceipt: async () => null,
    }),
    0,
  );
  const retainedHistoryOnly = readLimitlessObservedLocator(
    (await readOrder(historyOnlyClaim.order.id)).order_payload?.[locatorKey],
  );
  assert.deepEqual(retainedHistoryOnly.hashes, [historyOnlyHash]);
  assert.equal(retainedHistoryOnly.providerOrderId, historyOnlyProviderId);
  const conflictingHistoryProvider = randomUUID();
  const lookupConflictingHistory = async () =>
    new Map([
      [
        historyOnlyClientId,
        {
          kind: "found" as const,
          item: {
            orderId: conflictingHistoryProvider,
            clientOrderId: historyOnlyClientId,
            providerOrderId: conflictingHistoryProvider,
            payload: {
              order: {
                id: conflictingHistoryProvider,
                status: "failed",
                maker: otherExchange,
              },
            },
          },
        },
      ],
    ]);
  const historyOnlyFill = receipts.encodeEventLog("OrderFilled", [
    historyOnlyContext.orderHash,
    owner,
    otherExchange,
    0n,
    123n,
    10_000_000n,
    20_000_000n,
    0n,
  ]);
  assert.equal(
    await reconcileLimitlessDirectOrderJournals(db, {
      config: fixtureConfig,
      now: new Date(historyOnlyPoll.getTime() + 31_000),
      lookup: lookupConflictingHistory,
      readFreshHistory: emptyHistory,
      readHistoryReceipt: async (hash) => ({
        receipt: {
          hash,
          status: 1,
          logs: [{ address: exchange, index: 1, ...historyOnlyFill }],
        },
        canonicalBlock: { number: 1, hash },
        timestamp: fillTime.toISOString(),
      }),
    }),
    1,
    "an inconsistent later order response cannot suppress exact previously retained history proof",
  );
  assert.equal(
    (await readOrder(historyOnlyClaim.order.id)).order_hash,
    historyOnlyHash,
  );

  for (const historyFirst of [false, true]) {
    const clientOrderId = `hunch-direct-${randomUUID().replaceAll("-", "")}`;
    const providerOrderId = randomUUID();
    const originalOrder = {
      ...directSignedOrder,
      clientOrderId,
      salt: historyFirst ? "75" : "74",
    };
    const submission = buildLimitlessClobSubmissionContext(
      exchange,
      originalOrder,
      directContext.collateralFeeModule,
    );
    const claim = await claimLimitlessDirectOrderJournal(db, clientOrderId, {
      ...directInput,
      orderPayload: originalOrder,
      limitlessClobSubmissionContext: submission,
    });
    assert.ok(claim?.kind === "stored");
    {
      const exactFill = receipts.encodeEventLog("OrderFilled", [
        submission.orderHash,
        owner,
        otherExchange,
        0n,
        123n,
        10_000_000n,
        20_000_000n,
        0n,
      ]);
      const withFailedPromotion = {
        ...db,
        connect: async () => ({
          ...session,
          query: async (sql: string, values: unknown[] = []) => {
            if (sql.includes("update orders journal_order"))
              throw new Error("fixture failed promotion");
            return session.query(sql, values);
          },
        }),
      } as unknown as Pool;
      await assert.rejects(
        () =>
          reconcileLimitlessDirectOrderJournals(withFailedPromotion, {
            config: fixtureConfig,
            now: new Date(historyOnlyPoll.getTime() + 85_000),
            lookup: async () =>
              new Map([
                [
                  clientOrderId,
                  historyFirst
                    ? { kind: "not_found" as const }
                    : {
                        kind: "found" as const,
                        item: {
                          orderId: providerOrderId,
                          providerOrderId,
                          clientOrderId,
                          payload: {
                            order: { status: "filled" },
                            execution: {
                              matched: true,
                              settlementStatus: "MINED",
                              txHash: contradictoryTx,
                            },
                          },
                        },
                      },
                ],
              ]),
            readFreshHistory: async () =>
              historyFirst
                ? {
                    ...(await emptyHistory()),
                    unboundLocators: [
                      {
                        tx_hash: contradictoryTx,
                        provider_order_id: providerOrderId,
                      },
                    ],
                    nextScan: { page: 2, cursor: "fixture_page_2" },
                  }
                : await emptyHistory(),
            readHistoryReceipt: async (hash) =>
              historyFirst
                ? {
                    receipt: {
                      hash,
                      status: 1,
                      logs: [{ address: exchange, index: 1, ...exactFill }],
                    },
                    canonicalBlock: { number: 1, hash },
                    timestamp: fillTime.toISOString(),
                  }
                : null,
          }),
        /fixture failed promotion/,
      );
      assert.deepEqual(
        readLimitlessHistoryTxHashes(
          (await readOrder(claim.order.id)).order_payload,
        ),
        [contradictoryTx],
      );
      assert.equal((await readOrder(claim.order.id)).status, "submitted");
    }
    const existing = historyFirst
      ? await storeOrder(db, {
          ...directInput,
          limitlessClobSubmissionContext: undefined,
          venueOrderId: providerOrderId,
          orderPayload: {
            clientOrderId,
            _hunchLimitlessReceiptLocatorHashes: [firstContradictoryTx],
          },
        })
      : null;
    assert.equal(
      await promoteLimitlessDirectOrderJournal(db, {
        userId,
        journalId: claim.order.id,
        clientOrderId,
        providerOrderId,
        status: "filled",
        orderHash: null,
      }),
      true,
    );
    const persisted = await readOrder(existing?.order.id ?? claim.order.id);
    assert.equal(
      persisted.order_hash,
      null,
      "locator alone must not become the settled transaction",
    );
    assert.deepEqual(readLimitlessHistoryTxHashes(persisted.order_payload), [
      contradictoryTx,
    ]);
  }
  console.log(
    "ok - PG16 a hashless settled response preserves a candidate for canonical fee receipts, including history adoption",
  );

  const raceInput = {
    ...baseInput,
    venueOrderId: `history-first:${randomUUID()}`,
  };
  const historyPayload = {
    source: "foo",
    upstreamId: "provider-history",
    payload: { _hunchPositionDeltaAppliedAt: marker, keep: "nested marker" },
    _hunchLimitlessClob: { spoof: "root" },
    submitted: {
      order: {
        ...signedOrder,
        salt: "provider-value",
        _hunchLimitlessClob: context,
      },
    },
  };
  const race = await storeOrder(db, {
    ...raceInput,
    orderPayload: historyPayload,
  });
  const beforeEnrichment = await readOrder(race.order.id);
  assert.ok(beforeEnrichment.order_payload);
  assert.equal(
    limitlessClobFrozenContext(beforeEnrichment.order_payload),
    undefined,
  );
  assert.equal(
    "_hunchLimitlessClob" in
      ((beforeEnrichment.order_payload.submitted as Record<string, unknown>)
        .order as Record<string, unknown>),
    false,
  );
  const canonicalFacts = {
    canonicalPurchaseKey: `limitless:clob:8453:${raceInput.venueOrderId}`,
    instrument: {
      venue: "limitless",
      tokenId: "limitless:123",
      generation: "original-generation",
      outcome: "YES",
    },
  };
  await client.query(
    "update orders set verified_buy_facts=$2::jsonb where id=$1",
    [race.order.id, JSON.stringify(canonicalFacts)],
  );
  const enriched = await storeOrder(db, {
    ...raceInput,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: context,
  });
  assert.equal(enriched.kind, "exists");
  assert.equal(enriched.order.position_delta_applied, true);
  const raceRow = await readOrder(race.order.id);
  assertFrozen(raceRow.order_payload);
  assert.equal(raceRow.client_order_id, signedOrder.clientOrderId);
  assert.equal(raceRow.order_payload.source, "foo");
  assert.equal(raceRow.order_payload.upstreamId, "provider-history");
  assert.deepEqual(raceRow.order_payload.payload, historyPayload.payload);
  assert.deepEqual(raceRow.verified_buy_facts, canonicalFacts);
  assert.equal(
    raceRow.order_hash,
    txHash,
    "legacy transaction hash must not become EIP-712 hash",
  );
  console.log(
    "ok - PG16 history-first enrichment preserves provider data, markers, canonical facts and exact client identity",
  );

  await applyHistory(race.order.id);
  await applyHistory(race.order.id);
  const afterHistory = await readOrder(race.order.id);
  assertFrozen(afterHistory.order_payload);
  assert.equal(afterHistory.client_order_id, signedOrder.clientOrderId);
  assert.equal(hasPositionDeltaApplied(afterHistory.order_payload), true);
  assert.deepEqual(
    (afterHistory.order_payload.submitted as Record<string, unknown>).payload,
    historyPayload.payload,
  );
  assert.deepEqual(afterHistory.order_payload.history, {
    source: "foo",
    submitted: {},
    _hunchUpstream: { data: { order: {} } },
    keep: "upstream history",
  });
  assert.deepEqual(afterHistory.verified_buy_facts, canonicalFacts);
  assert.equal(afterHistory.token_id, "limitless:123");
  assertFrozen(
    (
      await readOrder(
        (
          await storeOrder(db, {
            ...raceInput,
            orderPayload: signedOrder,
            limitlessClobSubmissionContext: context,
          })
        ).order.id,
      )
    ).order_payload,
  );
  console.log(
    "ok - PG16 history wrapping and repeated sync retain signed identity without accepting provider context",
  );

  await client.query("update orders set price=null,size=null where id=$1", [
    race.order.id,
  ]);
  const beforeConflict = await readOrder(race.order.id);
  const callCount = calls.length;
  await assert.rejects(
    storeOrder(db, {
      ...raceInput,
      orderPayload: signedOrder,
      limitlessClobSubmissionContext: buildLimitlessClobSubmissionContext(
        otherExchange,
        signedOrder,
      ),
    }),
    /conflicts with its stored/,
  );
  assert.deepEqual(await readOrder(race.order.id), beforeConflict);
  assert.equal(
    calls
      .slice(callCount)
      .some((call) => /^\s*(insert|update)\b/i.test(call.sql)),
    false,
  );
  await assert.rejects(
    storeOrder(db, {
      ...baseInput,
      venueOrderId: `invalid:${randomUUID()}`,
      orderPayload: { ...signedOrder, salt: "72" },
      limitlessClobSubmissionContext: context,
    }),
    /does not match signed order/,
  );
  console.log(
    "ok - PG16 conflicting context rolls back before enrichment; invalid local signed hash is rejected",
  );

  const emptyInput = {
    ...baseInput,
    venueOrderId: `empty:${randomUUID()}`,
    orderPayload: null,
  };
  const empty = await storeOrder(db, emptyInput);
  await storeOrder(db, {
    ...emptyInput,
    orderPayload: signedOrder,
    limitlessClobSubmissionContext: context,
  });
  assertFrozen((await readOrder(empty.order.id)).order_payload);
  const historyOnly = await storeOrder(db, {
    ...emptyInput,
    venueOrderId: `history-only:${randomUUID()}`,
  });
  await applyHistory(historyOnly.order.id);
  const historyOnlyPayload = (await readOrder(historyOnly.order.id))
    .order_payload;
  assert.ok(historyOnlyPayload);
  assert.equal(limitlessClobFrozenContext(historyOnlyPayload), undefined);
  console.log(
    "ok - PG16 empty-payload enrichment and history-only update enforce separate trust paths",
  );

  // Execute every repository SQL branch above, then plan each emitted DML form
  // without executing it again. Point updates must remain indexed lookups
  // by primary key or by the exact venue order key.
  const statements = new Map<string, unknown[]>();
  for (const call of calls)
    if (
      /^\s*(insert into orders|update orders|with (target_scope|primary_scope) as materialized)/i.test(
        call.sql,
      )
    )
      statements.set(call.sql, call.values);
  for (const [sql, values] of statements) {
    const explained = await client.query(
      `explain (format json) ${sql}`,
      values,
    );
    const nodes = walkPlan(explained.rows[0]["QUERY PLAN"][0].Plan);
    if (/^\s*(update|with (target_scope|primary_scope))/i.test(sql))
      assert.ok(
        nodes.some(
          (node) =>
            node["Index Name"] === "orders_pkey" ||
            node["Index Name"] === "idx_orders_venue_order_id",
        ),
        JSON.stringify({
          statement: sql.trim().slice(0, 95),
          indexes: nodes.map((node) => node["Index Name"]).filter(Boolean),
        }),
      );
  }
  const explainedRead = await client.query(
    "explain (analyze,buffers,format json) select order_payload from orders where id=$1",
    [race.order.id],
  );
  const planResult = explainedRead.rows[0]["QUERY PLAN"][0];
  assert.equal(planResult.Plan["Index Name"], "orders_pkey");
  assert.equal(planResult.Plan["Actual Rows"], 1);
  console.log(
    JSON.stringify({
      sqlFormsExecutedAndPlanned: statements.size,
      unrelatedOrders: 50000,
      pointReadIndex: planResult.Plan["Index Name"],
      actualRows: planResult.Plan["Actual Rows"],
      sharedHitBlocks: planResult.Plan["Shared Hit Blocks"],
      executionMs: planResult["Execution Time"],
    }),
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
