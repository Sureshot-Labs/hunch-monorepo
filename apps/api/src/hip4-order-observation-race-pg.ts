import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import type { Pool, PoolClient } from "@hunch/infra";
import {
  HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
  failHip4OrderObservation,
  readHip4OrderObservationContext,
  recordHip4OrderObservationInTransaction,
} from "./repos/hip4-order-observation.js";
import { recordHip4SubmissionReplyInTransaction } from "./services/hip4-order-submission.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { mergeUsersById } from "./admin-merge-user-core.js";
import { fetchUserFinancialLifecycleSummary } from "./services/user-financial-lifecycle.js";
import { readHip4OrderHoldRaw } from "./repos/hip4-order-holds.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { Wallet } from "ethers";
import { hip4Identity } from "@hunch/shared";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import { persistHip4OrderPreparationInTransaction } from "./repos/hip4-order-preparation.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { admitHip4OrderActionInTransaction } from "./repos/hip4-order-admission.js";

export async function testHip4FundedOrderObservationRaces(pool: Pool) {
  const db = await pool.connect();
  let actionId: string | null = null;
  let input: Parameters<typeof testHip4OrderObservationRaces>[1];
  try {
    await db.query("begin");
    const wallet = Wallet.createRandom();
    const nativeOid = randomInt(1_000_000_000, 10_000_000_000);
    const fixture = await hip4OrderTestFixture(db, wallet.address);
    fixture.nonce -= 10000;
    const prepared = await persistHip4OrderPreparationInTransaction(
      db,
      fixture,
    );
    actionId = prepared.actionId;
    const identity = hip4Identity(
      "mainnet",
      Number(fixture.request.marketId.split(":").at(-1)),
    );
    const funding = await hip4FundedOrderTestFixture(db, {
      userId: fixture.userId,
      profile: fixture.profile,
      marketId: fixture.request.marketId,
      tokenId: identity.sides[1].tokenId,
    });
    const signing = prepareHip4TradeSigning(prepared.envelope);
    await admitHip4OrderActionInTransaction(
      db,
      {
        userId: fixture.userId,
        actionId,
        actor: "web_app",
        funding,
        signature: await wallet.signTypedData(
          signing.typedData.domain,
          signing.typedData.types,
          signing.typedData.message,
        ),
        context: {
          profile: fixture.profile,
          feeCapRaw: fixture.feeCapRaw,
          capacity: {
            assetId: HYPERCORE_MAINNET_USDC.assetId,
            decimals: 8,
            availableRaw: "150000000",
            observedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          },
        },
      },
      () => true,
    );
    if (signing.action.type !== "order") throw new Error("fixture");
    const wire = signing.action.orders[0],
      coin = `#${wire.a - 100000000}`;
    const body = {
      status: "order",
      order: {
        status: "filled",
        statusTimestamp: fixture.nonce + 300,
        order: {
          coin,
          oid: nativeOid,
          cloid: wire.c,
          side: "B",
          limitPx: wire.p,
          sz: wire.s,
          origSz: wire.s,
          timestamp: fixture.nonce + 100,
          orderType: "Limit",
          reduceOnly: false,
          tif: "Ioc",
        },
      },
    };
    const fill = {
      coin,
      oid: nativeOid,
      cloid: wire.c,
      side: "B",
      px: wire.p,
      sz: wire.s,
      time: fixture.nonce + 200,
      tid: 1,
      startPosition: "0",
      dir: "Buy",
      closedPnl: "0",
      hash: `0x${"ef".repeat(32)}`,
      crossed: false,
      fee: "0",
      feeToken: "USDC",
    };
    input = {
      actionId,
      orderId: prepared.orderId,
      userId: fixture.userId,
      address: fixture.profile.address,
      marketId: fixture.request.marketId,
      body,
      fill,
    };
    await db.query("commit");
  } finally {
    await db.query("rollback");
    db.release();
  }
  try {
    await testHip4OrderObservationRaces(pool, input);
  } finally {
    if (actionId)
      await pool.query(
        "update hip4_order_submissions set reconcile_after='infinity' where action_id=$1",
        [actionId],
      );
  }
}

async function waitForBlock(db: PoolClient, blockedPid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await db.query(
          "select pg_backend_pid()=any(pg_blocking_pids($1::int)) as blocked",
          [blockedPid],
        )
      ).rows[0].blocked
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("expected a real cross-connection PostgreSQL lock wait");
}

/** Merge commits while an already-claimed provider read is outstanding. Only
 * the synthetic caller fixture is moved; the production merge function runs. */
export async function testHip4TerminalOrderMergeRace(
  pool: Pool,
  input: { actionId: string; userId: string; body: unknown },
) {
  const stale = await pool.connect();
  try {
    const target = (
      await stale.query(
        "insert into users(is_active) values(true) returning id",
      )
    ).rows[0].id as string;
    const claim = (
      await stale.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        input.actionId,
        60000,
        60000,
      ])
    ).rows[0];
    assert.ok(claim);
    const oldContext = await readHip4OrderObservationContext(stale, claim);
    assert.ok(oldContext);
    assert.equal(oldContext.user_id, input.userId);
    assert.equal(
      (
        await fetchUserFinancialLifecycleSummary(stale, [input.userId])
      ).activeReasons.includes("active_hip4_submission"),
      false,
    );
    await mergeUsersById(
      input.userId,
      target,
      { dryRun: false, keepSource: true },
      pool,
    );
    await stale.query("begin");
    assert.deepEqual(
      await recordHip4OrderObservationInTransaction(stale, {
        claim,
        userId: oldContext.user_id,
        body: input.body,
        responseAt: Date.now(),
        maxRows: 100,
        retryMs: 60000,
      }),
      { saved: false },
      "pre-merge provider context cannot publish under the old user",
    );
    await stale.query("commit");
    assert.equal(
      (await readHip4OrderObservationContext(stale, claim))?.user_id,
      target,
    );
    await stale.query(
      "update hip4_order_submissions set reconcile_lease_until=clock_timestamp()-interval '1 second' where action_id=$1",
      [input.actionId],
    );
    const recovered = (
      await stale.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        input.actionId,
        60000,
        60000,
      ])
    ).rows[0];
    assert.ok(recovered);
    await stale.query("begin");
    assert.equal(
      (
        await recordHip4OrderObservationInTransaction(stale, {
          claim: recovered,
          userId: target,
          body: input.body,
          responseAt: Date.now(),
          maxRows: 100,
          retryMs: 60000,
        })
      ).saved,
      true,
    );
    await stale.query("commit");
    const lifecycle = await fetchUserFinancialLifecycleSummary(stale, [target]);
    assert.equal(
      lifecycle.activeReasons.includes("active_hip4_submission"),
      false,
    );
    assert.ok(lifecycle.protectedReasons.includes("trading_evidence"));
    console.log(
      "[hip4-terminal-merge] real keepSource merge rejects stale observation and new-owner repair succeeds",
    );
  } finally {
    await stale.query("rollback");
    stale.release();
  }
}

/** Uses committed synthetic fixtures only. No transport/signing/production IO. */
export async function testHip4OrderObservationRaces(
  pool: Pool,
  input: {
    actionId: string;
    orderId: string;
    userId: string;
    address: string;
    marketId: string;
    body: unknown;
    fill: Record<string, unknown>;
  },
) {
  const first = await pool.connect();
  const second = await pool.connect();
  let pending: Promise<unknown> | null = null;
  let blocker: PoolClient | null = null;
  try {
    const firstPid = (await first.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    const secondPid = (await second.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    assert.notEqual(firstPid, secondPid);
    const claim = (db: PoolClient) =>
      db.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        input.actionId,
        60000,
        60000,
      ]);
    await first.query("begin");
    let oldClaim = (await claim(first)).rows[0];
    assert.ok(oldClaim);
    blocker = first;
    pending = claim(second);
    await waitForBlock(first, secondPid);
    await first.query("commit");
    assert.equal(((await pending) as { rowCount: number }).rowCount, 0);
    pending = null;
    blocker = null;

    // Positive fill would update the economic order if the final lease fence
    // were missing. Lock the account AFTER the stale writer has read context.
    const execution = projectHip4Execution(
      "mainnet",
      input.address,
      input.fill,
    );
    await first.query("begin");
    await first.query(
      "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1) on conflict do nothing",
      [input.address],
    );
    await first.query(
      "select account_address from hip4_account_snapshots where environment='mainnet' and account_address=$1 for update",
      [input.address],
    );
    await first.query(
      `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,market_id,execution,fingerprint,provider_fill)
       values('mainnet',$1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
      [
        input.address,
        execution.time,
        execution.coin,
        execution.tradeId,
        execution.orderId,
        input.marketId,
        execution,
        canonicalJsonHash(execution),
        input.fill,
      ],
    );
    // Match the real P2 lock/write transaction: the observer must wait and
    // then see this exact fill, not permanently reject while it is uncommitted.
    const rejectedBody = structuredClone(input.body) as {
      order: { status: string };
    };
    rejectedBody.order.status = "minTradeNtlRejected";
    await second.query("begin");
    blocker = first;
    pending = recordHip4OrderObservationInTransaction(second, {
      claim: oldClaim,
      userId: input.userId,
      body: rejectedBody,
      responseAt: Date.now(),
      maxRows: 100,
      retryMs: 60000,
      phase: "status",
    });
    await waitForBlock(first, secondPid);
    await first.query("commit");
    assert.equal(
      ((await pending) as { error: string }).error,
      "rejected_order_execution_conflict",
    );
    pending = null;
    blocker = null;
    await second.query("commit");
    assert.ok(
      (await readHip4OrderHoldRaw(
        first,
        input.userId,
        input.address,
        HYPERCORE_MAINNET_USDC.assetId,
        new Date().toISOString(),
      )) > 0n,
    );
    assert.equal(
      (
        await first.query(
          "select attempt_row.state from funding_trade_attempts attempt_row join hip4_order_submissions submission_row on submission_row.funding_trade_attempt_id=attempt_row.id where submission_row.action_id=$1",
          [input.actionId],
        )
      ).rows[0].state,
      "submission_started",
    );
    await failHip4OrderObservation(
      first,
      oldClaim,
      "fill_conflict_repair",
      60000,
    );
    oldClaim = (await claim(first)).rows[0];
    assert.ok(oldClaim);
    await first.query("begin");
    await first.query(
      "select account_address from hip4_account_snapshots where environment='mainnet' and account_address=$1 for update",
      [input.address],
    );
    await second.query("begin");
    const record = (db: PoolClient, currentClaim: typeof oldClaim) =>
      recordHip4OrderObservationInTransaction(db, {
        claim: currentClaim,
        userId: input.userId,
        body: input.body,
        responseAt: Date.now(),
        maxRows: 100,
        retryMs: 60000,
      });
    blocker = first;
    pending = record(second, oldClaim);
    await waitForBlock(first, secondPid);
    await first.query(
      "update hip4_order_submissions set reconcile_lease_until=clock_timestamp()-interval '1 second' where action_id=$1",
      [input.actionId],
    );
    const newClaim = (await claim(first)).rows[0];
    assert.ok(newClaim);
    assert.notEqual(
      newClaim.reconcile_lease_token,
      oldClaim.reconcile_lease_token,
    );
    await first.query("commit");
    assert.deepEqual(await pending, { saved: false });
    pending = null;
    blocker = null;
    await second.query("commit");
    assert.equal(
      await failHip4OrderObservation(first, oldClaim, "timeout", 60000),
      false,
    );
    assert.equal(
      (
        await first.query(
          "select coalesce(filled_size,0)::text as filled from orders where id=$1",
          [input.orderId],
        )
      ).rows[0].filled,
      "0",
    );

    // The new observer publishes while a late submit reply waits on the owner
    // lock. On resumption the reply must see reconciliation, not regress it.
    await second.query("begin");
    assert.equal((await record(second, newClaim)).saved, true);
    await first.query("begin");
    blocker = second;
    pending = recordHip4SubmissionReplyInTransaction(first, {
      userId: input.userId,
      actionId: input.actionId,
      body: {
        status: "ok",
        response: {
          type: "order",
          data: {
            statuses: [
              { error: "Order has insufficient spot balance to trade" },
            ],
          },
        },
      },
    });
    await waitForBlock(second, firstPid);
    await second.query("commit");
    await pending;
    pending = null;
    blocker = null;
    await first.query("commit");
    assert.equal(
      (
        await first.query("select status from orders where id=$1", [
          input.orderId,
        ])
      ).rows[0].status,
      "filled",
    );
    assert.equal(
      (
        await first.query(
          "select attempt_row.state from funding_trade_attempts attempt_row join hip4_order_submissions submission_row on submission_row.funding_trade_attempt_id=attempt_row.id where submission_row.action_id=$1",
          [input.actionId],
        )
      ).rows[0].state,
      "accepted",
      "fresh exact status repairs the known-conflicted rejection through the common funded consumer",
    );
  } finally {
    // Release the blocker before waiting for the other connection's promise.
    if (blocker) await blocker.query("rollback");
    if (pending) await pending.catch(() => undefined);
    await first.query("rollback");
    await second.query("rollback");
    first.release();
    second.release();
  }
}
