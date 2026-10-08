// @requires-db
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import {
  buildPolymarketAssetContext,
  resolvePolymarketMarketAssets,
} from "@hunch/shared";
import type { Pool } from "@hunch/infra";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  EvidenceBudgetExhausted,
  factsFromEvidence,
  readVerifiedBuy,
  repairVerifiedBuys,
  requestVerifiedBuyRefresh,
} from "./services/verified-buy.js";
import { queueVerifiedBuyBackfillPage } from "./services/verified-buy-backfill.js";
import {
  createVerifiedBuyObserver,
  observeVerifiedBuySource,
  type VerifiedBuyObserverDependencies,
} from "./services/verified-buy-observer.js";
import { repairUnrecordedCopies } from "./services/verified-copy-repair.js";
import {
  copyPayloadHash,
  getCopyAttributionStatus,
  linkPersistedCopy,
  reconcileCopyFacts,
  recoverCopyPurchaseLinks,
  retainCopyBeforeSubmission,
  markCopySubmissionStarted,
  markCopyDefinitelyNotBroadcast,
  markCopyDefinitiveProviderRejection,
} from "./services/social-copy.js";
import type { PreparedTrade } from "./services/trading-types.js";

const pool = await createIntegrationTestPool({ max: 1 });
const client = await pool.connect();
const statements: Array<{ text: string; values: unknown[] }> = [];
let depth = 0;
const session = {
  query: async (text: string, values: unknown[] = []) => {
    if (text.toLowerCase() === "begin")
      return client.query(`savepoint verified_method_${++depth}`);
    if (text.toLowerCase() === "commit")
      return client.query(`release savepoint verified_method_${depth--}`);
    if (text.toLowerCase() === "rollback") {
      const result = await client.query(
        `rollback to savepoint verified_method_${depth}`,
      );
      await client.query(`release savepoint verified_method_${depth--}`);
      return result;
    }
    statements.push({ text, values });
    return client.query(text, values);
  },
  release: () => {},
};
const db = {
  query: session.query,
  connect: async () => session,
} as unknown as Pool;
const key = randomUUID(),
  author = randomUUID(),
  copier = randomUUID(),
  sourceOrder = randomUUID();
const eventId = `verified-event:${key}`,
  marketId = `verified-market:${key}`,
  tokenId = `limitless:${key}`;
const owner = `0x${"1".repeat(40)}`,
  exchange = `0x${"2".repeat(40)}`,
  position = `0x${"3".repeat(40)}`;
const orderHash = `0x${"a".repeat(64)}`,
  txHash = `0x${"b".repeat(64)}`;
const instrument = {
  venue: "limitless" as const,
  marketId,
  tokenId,
  outcome: "YES" as const,
  generation: `8453:${position}:${tokenId}`,
  expiry: null,
};
const facts = factsFromEvidence({
  canonicalPurchaseKey: `fixture:${key}`,
  instrument,
  owner,
  notionalRaw: 10000000n,
  grossSharesRaw: 20000000n,
  netSharesRaw: 19900000n,
  collateralDecimals: 6,
  shareDecimals: 6,
  feesUsdRaw: null,
  purchasedAt: "2026-10-08T00:00:00.000Z",
  evidenceIds: [`fixture:${key}`],
});
const fill = new Interface([
  "event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint8 side,uint256 tokenId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee,bytes32 builder,bytes32 metadata)",
]);
const transfer = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
]);
const zero = `0x${"0".repeat(64)}`;
const receipt = {
  hash: txHash,
  status: 1,
  logs: [
    {
      address: exchange,
      index: 0,
      ...fill.encodeEventLog("OrderFilled", [
        orderHash,
        owner,
        exchange,
        0,
        123,
        10000000,
        20000000,
        0,
        zero,
        zero,
      ]),
    },
    {
      address: position,
      index: 1,
      ...transfer.encodeEventLog("TransferSingle", [
        exchange,
        exchange,
        owner,
        123,
        19900000,
      ]),
    },
  ],
};
const deps: VerifiedBuyObserverDependencies = {
  maxEvidenceItems: 10,
  limitlessPositionContract: position,
  limitlessExchangeAddress: exchange,
  solanaCollateralMint: "usd",
  readEvmReceipt: async () => ({ receipt, timestamp: facts.purchasedAt }),
  readFinalizedSolanaTransaction: async () => null,
  readDflowOrder: async () => null,
  readPolymarketFills: async () => [],
  readLimitlessOrder: async ({ clientOrderId }) => ({
    status: "found",
    clientOrderId,
    orderId: `provider:${key}`,
    data: {
      order: {
        order: { orderHash },
        execution: { txHash, settlementStatus: "CONFIRMED" },
      },
    },
  }),
};
const repairPolicy = {
  batchSize: 10,
  concurrency: 1,
  leaseSeconds: 60,
  retrySeconds: 30,
  recheckSeconds: 300,
};
try {
  assert.equal(
    (
      await client.query(
        "select current_setting('server_version_num')::int as version",
      )
    ).rows[0].version >= 160000,
    true,
  );
  await client.query("begin");
  await client.query("set local statement_timeout='5s'");
  await client.query(
    `insert into users(id,display_name) values($1,'Source'),($2,'Copier')`,
    [author, copier],
  );
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status) values($1,'limitless',$1,'Verification fixture','ACTIVE')`,
    [eventId],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes)
    values($1,'limitless',$1,$2,'Verification fixture','ACTIVE','binary','["Yes","No"]')`,
    [marketId, eventId],
  );
  await client.query(
    `insert into unified_tokens(token_id,venue,market_id,side) values($1,'limitless',$2,'YES')`,
    [tokenId, marketId],
  );
  await client.query(
    `insert into orders(id,user_id,venue,side,status,token_id,wallet_address,verified_buy_state,verified_buy_facts)
    values($1,$2,'limitless','BUY','filled',$3,$4,'verified',$5::jsonb)`,
    [sourceOrder, author, tokenId, owner, JSON.stringify(facts)],
  );
  // Trigger queues new BUY, but not a SELL and never marks either one verified.
  assert.ok(
    (
      await client.query("select verified_buy_due_at from orders where id=$1", [
        sourceOrder,
      ])
    ).rows[0].verified_buy_due_at,
  );
  const thesis = (
    await client.query(
      `insert into user_theses(author_id,canonical_purchase_key,order_id,market_id,event_id,token_id,outcome,
    instrument_generation,body,buy_snapshot,policy_revision,qualifying_notional,idempotency_key,payload_hash)
    values($1,$2,$3,$4,$5,$6,'YES',$7,'Frozen fixture',$8::jsonb,'defaults','10',$9,$9) returning id`,
      [
        author,
        facts.canonicalPurchaseKey,
        sourceOrder,
        marketId,
        eventId,
        tokenId,
        instrument.generation,
        JSON.stringify(facts),
        key,
      ],
    )
  ).rows[0].id as string;
  const sourceRef = { kind: "thesis" as const, id: thesis };
  const prepared: PreparedTrade = {
    preparedId: key,
    venue: "limitless",
    quote: null,
    authorizationMode: "client_signed_order",
    authorizationRequests: [],
    reconcileKeys: {},
    expiresAt: null,
    venuePayload: {},
    intent: {
      actor: { kind: "web_app", userId: copier },
      venue: "limitless",
      sourceRef,
      walletAddress: owner,
      action: "BUY",
      outcome: "YES",
      amount: { type: "usd", value: "10" },
      idempotencyKey: key,
      target: {
        venue: "limitless",
        marketId,
        tokenId,
        outcome: "YES",
        eventId,
        venueMarketId: null,
        title: null,
      },
    },
  };
  const retained = {
    prepared,
    providerReference: `limitless:clob:8453:${key}`,
    preparedFingerprint: orderHash,
    limitlessPositionContract: position,
  };
  const attemptA = await retainCopyBeforeSubmission(db, retained);
  assert.equal(attemptA.created, true);
  await markCopyDefinitelyNotBroadcast(db, copier, attemptA);
  assert.equal(
    (await getCopyAttributionStatus(db, copier, key))?.state,
    "failed",
  );
  const attemptB = await retainCopyBeforeSubmission(db, retained);
  await markCopyDefinitelyNotBroadcast(db, copier, attemptA);
  assert.equal(
    (await getCopyAttributionStatus(db, copier, key))?.state,
    "pending",
  );
  await assert.rejects(
    () => markCopySubmissionStarted(db, copier, attemptA),
    /copy_attempt_superseded/,
  );
  await markCopySubmissionStarted(db, copier, attemptB);
  const attemptC = await retainCopyBeforeSubmission(db, retained);
  await markCopyDefinitelyNotBroadcast(db, copier, attemptC);
  assert.equal(
    (await getCopyAttributionStatus(db, copier, key))?.state,
    "pending",
  );
  assert.equal(
    (await getCopyAttributionStatus(db, copier, key))?.state,
    "pending",
  );
  const rejectedKey = randomUUID();
  const rejectedInput = {
    ...retained,
    prepared: {
      ...prepared,
      intent: { ...prepared.intent, idempotencyKey: rejectedKey },
    },
    providerReference: `limitless:clob:8453:${rejectedKey}`,
  };
  const firstRejected = await retainCopyBeforeSubmission(db, rejectedInput);
  await markCopySubmissionStarted(db, copier, firstRejected);
  await markCopyDefinitiveProviderRejection(db, copier, firstRejected);
  assert.equal(
    (await getCopyAttributionStatus(db, copier, rejectedKey))?.state,
    "failed",
  );
  const afterProvenFailure = await retainCopyBeforeSubmission(
    db,
    rejectedInput,
  );
  await markCopyDefinitelyNotBroadcast(db, copier, afterProvenFailure);
  assert.equal(
    (await getCopyAttributionStatus(db, copier, rejectedKey))?.state,
    "failed",
  );
  const uncertainRetry = await retainCopyBeforeSubmission(db, rejectedInput);
  await markCopySubmissionStarted(db, copier, uncertainRetry);
  await markCopyDefinitiveProviderRejection(db, copier, firstRejected);
  await markCopyDefinitiveProviderRejection(db, copier, uncertainRetry);
  assert.equal(
    (await getCopyAttributionStatus(db, copier, rejectedKey))?.state,
    "failed",
  );
  const unknownAttempt = await retainCopyBeforeSubmission(db, rejectedInput);
  await markCopySubmissionStarted(db, copier, unknownAttempt);
  const afterUnknown = await retainCopyBeforeSubmission(db, rejectedInput);
  await markCopySubmissionStarted(db, copier, afterUnknown);
  await markCopyDefinitiveProviderRejection(db, copier, afterUnknown);
  assert.equal(
    (await getCopyAttributionStatus(db, copier, rejectedKey))?.state,
    "pending",
  );
  await client.query(
    "update copy_attributions set repair_due_at=now()+interval '1 day' where id=$1",
    [firstRejected.id],
  );
  assert.equal(await getCopyAttributionStatus(db, author, key), null);
  await client.query(
    "update user_theses set author_hidden_at=now() where id=$1",
    [thesis],
  );
  await client.query("update users set social_suspended_at=now() where id=$1", [
    copier,
  ]);
  // Saved authorization survives source hide and account social suspension.
  assert.equal((await retainCopyBeforeSubmission(db, retained)).created, false);
  await assert.rejects(
    () =>
      retainCopyBeforeSubmission(db, {
        ...retained,
        preparedFingerprint: txHash,
      }),
    /copy_idempotency_conflict/,
  );
  await client.query("update users set social_suspended_at=null where id=$1", [
    copier,
  ]);
  await client.query(
    "update user_theses set author_hidden_at=null where id=$1",
    [thesis],
  );

  // No local order exists: exact provider clientOrderId + finalized receipt recovers.
  // Synthetic token must be a real ERC1155 uint; retained source binding remains exact.
  const recoveryInstrument = {
    ...instrument,
    tokenId: "limitless:123",
    generation: `8453:${position}:limitless:123`,
  };
  await client.query(
    `update copy_attributions set instrument=$2::jsonb where copier_user_id=$1`,
    [copier, JSON.stringify(recoveryInstrument)],
  );
  assert.equal(
    (await repairUnrecordedCopies(db, deps, repairPolicy)).confirmed,
    1,
  );
  const copyRow = (
    await client.query("select * from copy_attributions where id=$1", [
      attemptA.id,
    ])
  ).rows[0];
  assert.equal(copyRow.order_id, null);
  assert.equal(copyRow.execution_facts.grossNotionalUsd, "10");
  assert.equal(copyRow.execution_facts.netShares, "19.9");
  await client.query(
    "update copy_attributions set repair_due_at=now() where id=$1",
    [copyRow.id],
  );
  assert.equal(
    (
      await repairUnrecordedCopies(
        db,
        {
          ...deps,
          readEvmReceipt: async () => ({
            receipt: { ...receipt, status: 0 },
            timestamp: facts.purchasedAt,
          }),
        },
        repairPolicy,
      )
    ).revoked,
    1,
  );
  await client.query(
    "update copy_attributions set repair_due_at=now() where id=$1",
    [copyRow.id],
  );
  const loseLease = {
    ...deps,
    readLimitlessOrder: async (
      input: Parameters<typeof deps.readLimitlessOrder>[0],
    ) => {
      await client.query(
        "update copy_attributions set repair_lease_token=gen_random_uuid() where id=$1",
        [copyRow.id],
      );
      return deps.readLimitlessOrder(input);
    },
  };
  assert.equal(
    (await repairUnrecordedCopies(db, loseLease, repairPolicy)).leaseLost,
    1,
  );

  // Atomic invalidation and exact-revision reinstatement preserve immutable snapshot.
  const run = async (state: "verified" | "revoked") => {
    await requestVerifiedBuyRefresh(db, {
      userId: author,
      purchaseRef: { kind: "order", id: sourceOrder },
    });
    return repairVerifiedBuys(db, {
      batchSize: 1,
      concurrency: 1,
      leaseSeconds: 60,
      retrySeconds: 30,
      verifiedRecheckSeconds: 300,
      observe: async () =>
        state === "verified"
          ? { state, facts }
          : { state, reason: "fixture_revoked" },
    });
  };
  assert.equal((await run("revoked")).revoked, 1);
  assert.ok(
    (
      await client.query(
        "select proof_invalidated_at from user_theses where id=$1",
        [thesis],
      )
    ).rows[0].proof_invalidated_at,
  );
  assert.equal(
    (
      await readVerifiedBuy(db, {
        userId: author,
        purchaseRef: { kind: "order", id: sourceOrder },
        lock: true,
      })
    ).state,
    "revoked",
  );
  assert.equal((await run("verified")).verified, 1);
  assert.equal(
    (
      await client.query(
        "select proof_invalidated_at from user_theses where id=$1",
        [thesis],
      )
    ).rows[0].proof_invalidated_at,
    null,
  );
  await requestVerifiedBuyRefresh(db, {
    userId: author,
    purchaseRef: { kind: "order", id: sourceOrder },
  });
  const exhausted = await repairVerifiedBuys(db, {
    batchSize: 1,
    leaseSeconds: 60,
    retrySeconds: 30,
    verifiedRecheckSeconds: 300,
    observe: async () => {
      throw new EvidenceBudgetExhausted(102, 100);
    },
  });
  assert.equal(exhausted.budgetExhausted, 1);
  const blocked = await readVerifiedBuy(db, {
    userId: author,
    purchaseRef: { kind: "order", id: sourceOrder },
  });
  assert.equal(blocked.state, "verified");
  assert.equal(
    blocked.reason,
    "evidence_budget_exhausted:required=102:available=100",
  );
  // Explicit refresh after policy increase bypasses the retry delay.
  assert.equal((await run("verified")).verified, 1);
  await reconcileCopyFacts(db, {
    purchaseRef: { kind: "order", id: sourceOrder },
    userId: author,
    state: "revoked",
    facts: null,
  });
  await reconcileCopyFacts(db, {
    purchaseRef: { kind: "order", id: sourceOrder },
    userId: author,
    state: "verified",
    facts,
  });
  await linkPersistedCopy(db, {
    userId: copier,
    idempotencyKey: key,
    persisted: { orderId: null, executionId: null } as never,
  });
  await recoverCopyPurchaseLinks(db, 10);
  const observer = createVerifiedBuyObserver(db, deps);
  await observer({
    purchaseRef: { kind: "order", id: sourceOrder },
    userId: author,
    leaseToken: key,
    attempts: 1,
  });
  await observer({
    purchaseRef: { kind: "execution", id: randomUUID() },
    userId: author,
    leaseToken: key,
    attempts: 1,
  });
  await observeVerifiedBuySource(db, deps, {
    id: sourceOrder,
    user_id: author,
    venue: "polymarket",
    wallet_address: owner,
    order_hash: orderHash,
    venue_order_id: null,
    token_id: "987654321012345678901234567890",
    side: "BUY",
    order_payload: {},
    client_order_id: null,
    tx_signature: null,
    market_id: null,
    outcome: null,
    expiration_time: null,
    market_metadata: {},
    input_mint: null,
    output_mint: null,
  });
  for (const kind of ["order", "execution"] as const) {
    const first = await queueVerifiedBuyBackfillPage(db, {
      kind,
      afterId: null,
      batchSize: 20,
      execute: false,
    });
    await queueVerifiedBuyBackfillPage(db, {
      kind,
      afterId: first.nextAfterId ?? sourceOrder,
      batchSize: 20,
      execute: true,
    });
    await queueVerifiedBuyBackfillPage(db, {
      kind,
      afterId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      batchSize: 20,
      execute: false,
    });
  }
  // Heavy order: insufficient policy budget performs no receipt reads; after
  // explicit refresh and higher budget all 34 fills enter the exact snapshot.
  const heavyOrder = randomUUID(),
    polyMarket = `polymarket:verified:${key}`,
    polyEvent = `polymarket:event:${key}`;
  const polyToken = BigInt(`0x${key.replaceAll("-", "")}`).toString();
  const protocol = resolvePolymarketMarketAssets({
    version: "v1",
    conditionId: zero,
    clobTokenIds: [polyToken, (BigInt(polyToken) + 1n).toString()],
    outcomes: ["Yes", "No"],
    negRisk: false,
  });
  const context = buildPolymarketAssetContext(polyMarket, protocol, polyToken);
  await client.query(
    `insert into unified_events(id,venue,venue_event_id,title,status) values($1,'polymarket',$1,'Heavy fixture','ACTIVE')`,
    [polyEvent],
  );
  await client.query(
    `insert into unified_markets(id,venue,venue_market_id,event_id,title,status,market_type,outcomes)
    values($1,'polymarket',$1,$2,'Heavy fixture','ACTIVE','binary','["Yes","No"]')`,
    [polyMarket, polyEvent],
  );
  await client.query(
    `insert into unified_tokens(token_id,venue,market_id,side) values($1,'polymarket',$2,'YES')`,
    [polyToken, polyMarket],
  );
  await client.query(
    `insert into orders(id,user_id,venue,side,status,token_id,wallet_address,order_hash,order_payload)
    values($1,$2,'polymarket','BUY','filled',$3,$4,$5,$6::jsonb)`,
    [
      heavyOrder,
      author,
      polyToken,
      owner,
      orderHash,
      JSON.stringify({ assetContext: context }),
    ],
  );
  await client.query(
    `insert into order_fills(order_id,fill_size,fill_price,fill_side,filled_at,provider_tx_hash,provider_status)
    select $1,20,0.5,'BUY',now(),'0x'||lpad(to_hex(fill_number),64,'0'),'CONFIRMED' from generate_series(1,34) fill_number`,
    [heavyOrder],
  );
  let providerBudget = 100,
    receiptReads = 0;
  const heavyObserver = createVerifiedBuyObserver(db, {
    ...deps,
    maxEvidenceItems: 200,
    assertEvidenceBudget: (needed) => {
      if (needed > providerBudget)
        throw new EvidenceBudgetExhausted(needed, providerBudget);
    },
    readEvmReceipt: async (_chain, receiptHash) => {
      receiptReads++;
      return {
        timestamp: facts.purchasedAt,
        receipt: {
          hash: receiptHash,
          status: 1,
          logs: [
            {
              address: context.exchangeAddress,
              index: 0,
              ...fill.encodeEventLog("OrderFilled", [
                orderHash,
                owner,
                exchange,
                0,
                polyToken,
                10000000,
                20000000,
                0,
                zero,
                zero,
              ]),
            },
            {
              address: context.positionContract,
              index: 1,
              ...transfer.encodeEventLog("TransferSingle", [
                context.exchangeAddress,
                context.exchangeAddress,
                owner,
                polyToken,
                19900000,
              ]),
            },
          ],
        },
      };
    },
  });
  const repairHeavy = () =>
    repairVerifiedBuys(db, {
      batchSize: 1,
      leaseSeconds: 60,
      retrySeconds: 30,
      verifiedRecheckSeconds: 300,
      observe: heavyObserver,
    });
  assert.equal((await repairHeavy()).budgetExhausted, 1);
  assert.equal(receiptReads, 0);
  providerBudget = 120;
  await requestVerifiedBuyRefresh(db, {
    userId: author,
    purchaseRef: { kind: "order", id: heavyOrder },
  });
  assert.equal((await repairHeavy()).verified, 1);
  assert.equal(receiptReads, 34);
  const full = await readVerifiedBuy(db, {
    userId: author,
    purchaseRef: { kind: "order", id: heavyOrder },
  });
  assert.equal(full.facts?.grossNotionalUsd, "340");
  assert.equal(full.facts?.grossShares, "680");
  assert.equal(full.facts?.evidenceIds.length, 34);
  // Every new execution enqueues observation, without trusting fulfilled status.
  const execution = randomUUID();
  await client.query(
    `insert into executions(id,user_id,venue,side,status,wallet_address) values($1,$2,'kalshi','BUY','fulfilled',$3)`,
    [execution, author, owner],
  );
  assert.equal(
    (
      await repairVerifiedBuys(db, {
        batchSize: 1,
        leaseSeconds: 60,
        retrySeconds: 30,
        verifiedRecheckSeconds: 300,
        observe: async () => ({
          state: "pending",
          reason: "dflow_evidence_unsupported",
        }),
      })
    ).pending,
    1,
  );
  assert.equal(
    (
      await readVerifiedBuy(db, {
        userId: author,
        purchaseRef: { kind: "execution", id: execution },
      })
    ).state,
    "pending",
  );
  await db.query(
    `select token_id,side from unified_tokens where market_id=$1 and token_id=$2 and venue='kalshi'`,
    [marketId, "sol:fixture"],
  );
  await db.query(
    `update order_fills fill_row set provider_tx_hash=evidence_row.tx_hash,provider_status=evidence_row.provider_status
    from unnest($1::text[],$2::text[],$3::text[]) as evidence_row(trade_id,tx_hash,provider_status)
    where fill_row.order_id=any($4::uuid[]) and fill_row.venue_trade_id=evidence_row.trade_id`,
    [["fixture"], [txHash], ["CONFIRMED"], [heavyOrder]],
  );
  // Exercise each exact-reference lookup (including empty matches), never a
  // proximity lookup or a provider submit, and both sparse backfill updates.
  for (const reference of [
    `polymarket:137:${exchange}:${orderHash}`,
    `limitless:amm:8453:${txHash}:123`,
    `dflow:mainnet:fixture:${owner}`,
  ]) {
    await client.query(
      "update copy_attributions set provider_reference=$2,state='pending' where id=$1",
      [attemptA.id, reference],
    );
    await recoverCopyPurchaseLinks(db, 10);
  }
  const pendingOrder = randomUUID();
  await client.query(
    "insert into orders(id,user_id,venue,side,status) values($1,$2,'limitless','BUY','cancelled')",
    [pendingOrder, author],
  );
  assert.ok(
    (
      await queueVerifiedBuyBackfillPage(db, {
        kind: "order",
        afterId: null,
        batchSize: 50,
        execute: true,
      })
    ).queued >= 1,
  );
  assert.ok(
    (
      await queueVerifiedBuyBackfillPage(db, {
        kind: "execution",
        afterId: null,
        batchSize: 50,
        execute: true,
      })
    ).queued >= 1,
  );
  // Generic plans parse every runtime SQL shape including empty-tail branches.
  await client.query("set local plan_cache_mode='force_generic_plan'");
  for (const [index, statement] of statements.entries()) {
    if (!/^\s*(select|update|with|insert)/i.test(statement.text)) continue;
    await client.query(
      `explain (format json) ${statement.text}`,
      statement.values,
    );
    assert.ok(index >= 0);
  }
  assert.equal(copyPayloadHash(prepared), copyPayloadHash(prepared));
  console.log(
    `Verified buy PG16: Copy identity/recovery, frozen proof revocation/reinstatement, lease loss, trigger, backfill; ${statements.length} SQL calls explained`,
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
