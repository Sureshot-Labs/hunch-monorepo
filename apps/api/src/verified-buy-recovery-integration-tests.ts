// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import type { Pool } from "@hunch/infra";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  createVerifiedBuyObserver,
  type VerifiedBuyObserverDependencies,
} from "./services/verified-buy-observer.js";
import {
  repairVerifiedBuys,
  requestVerifiedBuyRefresh,
  readVerifiedBuy,
} from "./services/verified-buy.js";
import { storePolymarketFillEvidence } from "./services/verified-buy-fill-wake.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const captured: Array<{ sql: string; values: unknown[] }> = [];
const sourceRowsPerRead: number[] = [];
const db = {
  query: async (sql: string, values: unknown[] = []) => {
    captured.push({ sql, values: [...values] });
    const result = await client.query(sql, values);
    if (sql.includes("from order_fills where"))
      sourceRowsPerRead.push(result.rows.length);
    return result;
  },
} as Pick<Pool, "query">;
const userId = randomUUID(),
  polyOrder = randomUUID(),
  ammOrder = randomUUID();
const marketId = `limitless:recovery:${randomUUID()}`,
  eventId = `limitless:recovery-event:${randomUUID()}`;
const owner = `0x${"1".repeat(40)}`,
  position = `0x${"3".repeat(40)}`,
  amm = `0x${"4".repeat(40)}`;
const orderHash = `0x${"a".repeat(64)}`,
  txHash = `0x${"b".repeat(64)}`;
const context = buildPolymarketAssetContext(
  "polymarket:recovery",
  resolvePolymarketMarketAssets({
    version: "v1",
    conditionId: `0x${"c".repeat(64)}`,
    clobTokenIds: ["123", "456"],
    outcomes: ["YES", "NO"],
    negRisk: false,
  }),
  "123",
);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const clobFill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)",
]);
const ammFill = new Interface([
  "event FPMMBuy(address indexed buyer,uint256 investmentAmount,uint256 feeAmount,uint256 indexed outcomeIndex,uint256 outcomeTokensBought)",
]);
let receiptState: "valid" | "pending" | "failed" = "valid",
  providerReads = 0;
const deps: VerifiedBuyObserverDependencies = {
  maxEvidenceItems: 2,
  limitlessPositionContract: position,
  limitlessExchangeAddress: amm,
  solanaCollateralMint: "usd",
  readLimitlessOrder: async () => {
    throw Error("Unexpected provider read");
  },
  readDflowOrder: async () => {
    throw Error("Unexpected provider read");
  },
  readFinalizedSolanaTransaction: async () => {
    throw Error("Unexpected RPC read");
  },
  readPolymarketFills: async () => {
    providerReads++;
    return { state: "unavailable" };
  },
  readEvmReceipt: async (chainId, hash) => {
    assert.equal(hash, txHash);
    if (receiptState === "pending") return null;
    const poly = chainId === 137;
    return {
      timestamp: "2026-10-20T15:38:59.000Z",
      receipt: {
        hash,
        status: receiptState === "failed" ? 0 : 1,
        logs: [
          poly
            ? {
                address: context.exchangeAddress,
                index: 0,
                ...clobFill.encodeEventLog("OrderFilled", [
                  orderHash,
                  owner,
                  context.exchangeAddress,
                  0,
                  123,
                  10000000,
                  20000000,
                  0,
                ]),
              }
            : {
                address: amm,
                index: 0,
                ...ammFill.encodeEventLog("FPMMBuy", [
                  owner,
                  10000000,
                  0,
                  0,
                  20000000,
                ]),
              },
          {
            address: poly ? context.positionContract : position,
            index: 1,
            ...transfer.encodeEventLog("TransferSingle", [
              amm,
              amm,
              owner,
              123,
              20000000,
            ]),
          },
        ],
      },
    };
  },
};
const policy = {
  batchSize: 1,
  concurrency: 1,
  leaseSeconds: 120,
  retrySeconds: 30,
  verifiedRecheckSeconds: 3600,
};
try {
  await client.query("begin");
  await client.query("set local statement_timeout='15s'");
  await client.query("set local lock_timeout='2s'");
  await client.query(
    "insert into users(id,display_name) values($1,'BUY recovery fixture')",
    [userId],
  );
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Recovery','ACTIVE')",
    [eventId],
  );
  await client.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes,metadata,token_yes,token_no) values($1,'limitless',$1,$2,'Recovery','ACTIVE','binary','[\"YES\",\"NO\"]',$3::jsonb,'limitless:123','limitless:456')",
    [marketId, eventId, JSON.stringify({ tradeType: "amm", address: amm })],
  );
  await client.query(
    "insert into unified_tokens(token_id,venue,market_id,side) values('limitless:123','limitless',$1,'YES')",
    [marketId],
  );
  await client.query(
    "insert into orders(id,user_id,venue,side,status,token_id,wallet_address,venue_order_id) values($1,$2,'limitless','BUY','filled','limitless:123',$3,$4)",
    [ammOrder, userId, owner, `amm:${txHash}:fixture`],
  );
  const observer = createVerifiedBuyObserver(db, deps);
  const ammObserved = await observer({
    purchaseRef: { kind: "order", id: ammOrder },
    userId,
    leaseToken: randomUUID(),
    attempts: 1,
  });
  assert.equal(
    ammObserved.state,
    "verified",
    "metadata.address-only AMM must reach exact receipt verification",
  );
  await client.query("update orders set verified_buy_due_at=null where id=$1", [
    ammOrder,
  ]);
  const polyEvent = `${context.marketId}:event`;
  await client.query(
    "insert into unified_events(id,venue,venue_event_id,title,status) values($1,'polymarket',$1,'Recovery','ACTIVE')",
    [polyEvent],
  );
  await client.query(
    "insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes) values($1,'polymarket',$1,$2,'Recovery','ACTIVE','binary','[\"YES\",\"NO\"]')",
    [context.marketId, polyEvent],
  );
  await client.query(
    "insert into unified_tokens(token_id,venue,market_id,side) values('123','polymarket',$1,'YES')",
    [context.marketId],
  );
  await client.query(
    "insert into orders(id,user_id,venue,side,status,token_id,wallet_address,venue_order_id,order_hash,order_payload) values($1,$2,'polymarket','BUY','matched','123',$3,$4,$4,$5::jsonb)",
    [
      polyOrder,
      userId,
      owner,
      orderHash,
      JSON.stringify({ assetContext: context }),
    ],
  );
  const backgroundUser = randomUUID();
  await client.query(
    "insert into users(id,display_name) values($1,'Unrelated fill scale fixture')",
    [backgroundUser],
  );
  await client.query(
    "insert into orders(user_id,venue,side,status) select $1,'polymarket','SELL','filled' from generate_series(1,1000) as fixture_row(ordinality)",
    [backgroundUser],
  );
  await client.query(
    "insert into order_fills(order_id,venue_fill_id,fill_size,fill_price,fill_side,filled_at) select purchase_row.id,'background-'||fixture_row.ordinality,1,0.5,'SELL',now() from orders purchase_row cross join generate_series(1,100) as fixture_row(ordinality) where purchase_row.user_id=$1",
    [backgroundUser],
  );
  // More local rows than maxEvidenceItems, all within one receipt. Never truncate.
  await client.query(
    "insert into order_fills(order_id,venue_fill_id,venue_trade_id,fill_size,fill_price,fill_side,filled_at,provider_tx_hash,provider_status) select $1,'trade-'||fixture_row.ordinality,'trade-'||fixture_row.ordinality,1,0.5,'BUY',now(),$2,'MINED' from generate_series(0,999) as fixture_row(ordinality)",
    [polyOrder, txHash],
  );
  await client.query("analyze order_fills");
  const first = await repairVerifiedBuys(db, { ...policy, observe: observer });
  assert.equal(first.verified, 1);
  assert.deepEqual(
    sourceRowsPerRead,
    [1000],
    "the entire observation acquires its 1000 known fill rows exactly once, not once per output page",
  );
  assert.equal(providerReads, 0);
  const previous = await readVerifiedBuy(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(
    previous.facts?.grossShares,
    "20",
    "facts are receipt quantities, never fill_size aggregates",
  );
  assert.ok(previous.facts);
  const thesisId = randomUUID(),
    copyId = randomUUID(),
    proofKey = randomUUID();
  await client.query(
    "insert into user_theses(id,author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash) values($1,$2,$3,$4,$5,$6,'123','YES',$7,'Proof fixture',$8::jsonb,'defaults',10,$9,$9)",
    [
      thesisId,
      userId,
      previous.facts.canonicalPurchaseKey,
      polyOrder,
      context.marketId,
      polyEvent,
      previous.facts.instrument.generation,
      JSON.stringify(previous.facts),
      proofKey,
    ],
  );
  await client.query(
    "insert into copy_attributions(id,copier_user_id,source_thesis_id,source_snapshot,instrument,idempotency_key,payload_hash,prepared_fingerprint,provider_reference,canonical_purchase_key,order_id,state,facts_revision,execution_facts,created_at) values($1,$2,$3,'{}',$4::jsonb,$5,$5,$5,$5,$6,$7,'confirmed',$8,$9::jsonb,'2026-10-20T15:38:58Z')",
    [
      copyId,
      userId,
      thesisId,
      JSON.stringify(previous.facts.instrument),
      randomUUID(),
      previous.facts.canonicalPurchaseKey,
      polyOrder,
      previous.facts.evidenceRevision,
      JSON.stringify(previous.facts),
    ],
  );
  const proofState = async () =>
    (
      await client.query(
        "select thesis_row.proof_invalidated_at is not null as invalidated,copy_row.state as copy_state from user_theses thesis_row join copy_attributions copy_row on copy_row.id=$2 where thesis_row.id=$1",
        [thesisId, copyId],
      )
    ).rows[0];
  await client.query(
    "insert into order_fills(order_id,venue_fill_id,venue_trade_id,fill_size,fill_price,fill_side,filled_at) values($1,'missing','missing',1,0.5,'BUY',now())",
    [polyOrder],
  );
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).pending,
    1,
  );
  const blocked = await readVerifiedBuy(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(blocked.reason, "fill_transaction_identity_missing");
  assert.deepEqual(blocked.facts, previous.facts);
  receiptState = "failed";
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  const lateNegative = await repairVerifiedBuys(db, {
    ...policy,
    observe: async (claim) => {
      const result = await observer(claim);
      await requestVerifiedBuyRefresh(db, {
        userId,
        purchaseRef: claim.purchaseRef,
      });
      return result;
    },
  });
  assert.equal(lateNegative.leaseLost, 1);
  assert.deepEqual(
    await proofState(),
    { invalidated: false, copy_state: "confirmed" },
    "lost lease must not apply stale negative projections",
  );
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).pending,
    1,
  );
  assert.deepEqual(
    await proofState(),
    { invalidated: true, copy_state: "revoked" },
    "failed canonical prior receipt invalidates its public proof despite a new fill still awaiting identity",
  );
  receiptState = "pending";
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).pending,
    1,
  );
  assert.deepEqual(await proofState(), {
    invalidated: true,
    copy_state: "revoked",
  });
  receiptState = "valid";
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).pending,
    1,
  );
  assert.deepEqual(
    await proofState(),
    { invalidated: true, copy_state: "revoked" },
    "an incomplete observation must not clear invalidation",
  );
  assert.equal(
    await storePolymarketFillEvidence(db, {
      orderIds: [polyOrder],
      insertedOrderIds: [],
      tradeEvidence: [
        { id: "missing", transactionHash: txHash, status: "MINED" },
      ],
    }),
    1,
  );
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).verified,
    1,
  );
  assert.deepEqual(
    await proofState(),
    { invalidated: false, copy_state: "confirmed" },
    "complete canonical proof recovery can reinstate projections without a new order",
  );
  await client.query(
    "update orders set verified_buy_due_at=now()+interval '1 hour',verified_buy_lease_token=gen_random_uuid(),verified_buy_lease_until=now()+interval '1 minute' where id=$1",
    [polyOrder],
  );
  assert.equal(
    await storePolymarketFillEvidence(db, {
      orderIds: [polyOrder],
      insertedOrderIds: [],
      tradeEvidence: [
        { id: "missing", transactionHash: txHash, status: "MINED" },
      ],
    }),
    0,
  );
  assert.equal(
    (
      await client.query(
        "select verified_buy_due_at>now() as deferred,verified_buy_lease_token is not null as leased from orders where id=$1",
        [polyOrder],
      )
    ).rows[0].leased,
    true,
  );
  // A refresh during observation invalidates the old lease; its late store must
  // not swallow the refresh or change facts/projections.
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  const raced = await repairVerifiedBuys(db, {
    ...policy,
    observe: async (claim) => {
      const result = await observer(claim);
      await requestVerifiedBuyRefresh(db, {
        userId,
        purchaseRef: claim.purchaseRef,
      });
      return result;
    },
  });
  assert.equal(raced.leaseLost, 1);
  assert.equal(
    (
      await client.query(
        "select verified_buy_due_at<=now() as due from orders where id=$1",
        [polyOrder],
      )
    ).rows[0].due,
    true,
  );
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).verified,
    1,
  );
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  const changedDuringObservation = await repairVerifiedBuys(db, {
    ...policy,
    observe: async (claim) => {
      const result = await observer(claim);
      await storePolymarketFillEvidence(db, {
        orderIds: [polyOrder],
        insertedOrderIds: [],
        tradeEvidence: [
          { id: "missing", transactionHash: txHash, status: "CONFIRMED" },
        ],
      });
      return result;
    },
  });
  assert.equal(
    changedDuringObservation.leaseLost,
    1,
    "source revision must fence the old proof writer",
  );
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).verified,
    1,
  );
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  let reportEntered = () => {},
    releaseObserver = () => {};
  const entered = new Promise<void>((resolve) => {
    reportEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseObserver = resolve;
  });
  const firstWorker = repairVerifiedBuys(db, {
    ...policy,
    observe: async (claim) => {
      reportEntered();
      await released;
      return observer(claim);
    },
  });
  await entered;
  const secondWorker = await repairVerifiedBuys(db, {
    ...policy,
    observe: observer,
  });
  assert.equal(
    secondWorker.claimed,
    0,
    "a concurrent worker must not reclaim an active lease",
  );
  releaseObserver();
  assert.equal((await firstWorker).verified, 1);
  receiptState = "pending";
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).pending,
    1,
  );
  receiptState = "failed";
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).revoked,
    1,
  );
  assert.equal(
    (
      await client.query(
        "select verified_buy_due_at>=now()+interval '59 minutes' as canonical_recheck from orders where id=$1",
        [polyOrder],
      )
    ).rows[0].canonical_recheck,
    true,
  );
  receiptState = "valid";
  await requestVerifiedBuyRefresh(db, {
    userId,
    purchaseRef: { kind: "order", id: polyOrder },
  });
  assert.equal(
    (await repairVerifiedBuys(db, { ...policy, observe: observer })).verified,
    1,
  );
  assert.equal(
    Number(
      (
        await client.query(
          "select count(*) as count from orders where user_id=$1",
          [userId],
        )
      ).rows[0].count,
    ),
    2,
    "manual recovery must never create another order",
  );
  const fillSource = captured.find((sample) =>
    sample.sql.includes("from order_fills where"),
  );
  const sourceRead = captured.find((sample) =>
    sample.sql.includes("from orders purchase_row"),
  );
  const evidenceWrite = captured.find((sample) =>
    sample.sql.startsWith("update order_fills fill_row"),
  );
  const evidenceWake = captured.find((sample) =>
    sample.sql.startsWith("update orders set verified_buy_due_at=now()"),
  );
  const explicitWake = captured.find((sample) =>
    sample.sql.includes("where id = $1 and user_id = $2 returning id"),
  );
  const storedProof = captured.find((sample) =>
    sample.sql.startsWith("with stored_purchase as"),
  );
  const negativeProof = captured.find(
    (sample) =>
      sample.sql.startsWith("with stored_purchase as") &&
      Array.isArray(sample.values[7]) &&
      sample.values[7].length > 0,
  );
  assert.ok(
    fillSource &&
      sourceRead &&
      evidenceWrite &&
      evidenceWake &&
      explicitWake &&
      storedProof &&
      negativeProof,
  );
  const scenarios = [
    { name: "fill_source", sample: fillSource },
    {
      name: "fill_empty",
      sample: { sql: fillSource.sql, values: [randomUUID()] },
    },
    { name: "source", sample: sourceRead },
    { name: "evidence", sample: evidenceWrite },
    { name: "evidence_wake", sample: evidenceWake },
    { name: "explicit_wake", sample: explicitWake },
    { name: "proof_store", sample: storedProof },
    { name: "negative_proof_store", sample: negativeProof },
  ];
  type PlanNode = { [key: string]: unknown; Plans?: PlanNode[] };
  const walk = (node: PlanNode): PlanNode[] => [
    node,
    ...(node.Plans ?? []).flatMap(walk),
  ];
  let ordinal = 0;
  for (const scenario of scenarios)
    for (const generic of [false, true]) {
      const statementName = `buy_recovery_plan_${ordinal++}`;
      await client.query("savepoint recovery_plan");
      if (scenario.name.endsWith("proof_store"))
        await client.query(
          "update orders set verified_buy_lease_token=$2::uuid,verified_buy_lease_until=now()+interval '1 minute' where id=$1",
          [polyOrder, scenario.sample.values[6]],
        );
      await client.query(
        `set local plan_cache_mode=${generic ? "force_generic_plan" : "force_custom_plan"}`,
      );
      await client.query(`prepare ${statementName} as ${scenario.sample.sql}`);
      const literals: string[] = [];
      for (const value of scenario.sample.values)
        literals.push(
          (
            await client.query("select quote_nullable($1::text) as quoted", [
              value,
            ])
          ).rows[0].quoted,
        );
      const explained = (
        await client.query(
          `explain (analyze,buffers,format json) execute ${statementName}(${literals.join(",")})`,
        )
      ).rows[0]["QUERY PLAN"][0];
      if (generic)
        assert.ok(
          Number(
            (
              await client.query(
                "select generic_plans from pg_prepared_statements where name=$1",
                [statementName],
              )
            ).rows[0].generic_plans,
          ) > 0,
        );
      const nodes = walk(explained.Plan);
      const fillScans = nodes.filter(
        (node) => node["Relation Name"] === "order_fills",
      );
      assert.ok(
        !fillScans.some((node) => node["Node Type"] === "Seq Scan"),
        "exact-order evidence must not scan 100k unrelated fills",
      );
      const fillRowsExamined = fillScans.reduce(
        (total, node) =>
          total +
          Number(node["Actual Rows"] ?? 0) +
          Number(node["Rows Removed by Filter"] ?? 0),
        0,
      );
      assert.ok(
        fillRowsExamined <= 1100,
        "generic empty tails must remain bounded to the selected purchase, not unrelated fills",
      );
      console.log(
        JSON.stringify({
          scenario: scenario.name,
          generic,
          unrelatedFills: 100000,
          sourceQueriesPerObservation: 1,
          executionMs: explained["Execution Time"],
          sharedHits: explained.Plan["Shared Hit Blocks"],
          fillRowsExamined,
        }),
      );
      await client.query("rollback to savepoint recovery_plan");
      await client.query("release savepoint recovery_plan");
      await client.query(`deallocate ${statementName}`);
    }
  console.log(
    "ok - PG16 BUY recovery: alias address, single exact source acquisition, MINED/previous proof, missing identity recovery, no-op sync, refresh fencing, revocation/recovery",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
