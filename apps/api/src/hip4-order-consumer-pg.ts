import assert from "node:assert/strict";
import type { PoolClient } from "@hunch/infra";
import {
  HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
  recordHip4OrderObservationInTransaction,
} from "./repos/hip4-order-observation.js";
import { recordHip4SubmissionReplyInTransaction } from "./services/hip4-order-submission.js";
import { readHip4OrderHoldRaw } from "./repos/hip4-order-holds.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";

/** Exact common-consumer semantics against the caller's disposable admitted
 * fixture. Every case rolls back; no provider or signing IO. */
export async function testHip4OrderConsumerAcceptance(
  db: PoolClient,
  input: {
    actionId: string;
    orderId: string;
    userId: string;
    address: string;
    reservationId: string;
    marketId: string;
    response: (status?: string) => unknown;
  },
) {
  const attempt = async () =>
    (
      await db.query(
        "select state from funding_trade_attempts where reservation_id=$1",
        [input.reservationId],
      )
    ).rows[0].state;
  const claim = async () =>
    (
      await db.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        input.actionId,
        60000,
        60000,
      ])
    ).rows[0];
  const observe = async (body: unknown, phase?: "status" | "fills") =>
    recordHip4OrderObservationInTransaction(db, {
      claim: await claim(),
      userId: input.userId,
      body,
      phase,
      responseAt: Date.now(),
      maxRows: 100,
      retryMs: 60000,
    });
  const hold = () =>
    readHip4OrderHoldRaw(
      db,
      input.userId,
      input.address,
      HYPERCORE_MAINNET_USDC.assetId,
    );
  const initialHold = await hold();
  const addPartialFill = async () => {
    const raw = input.response() as {
      order: {
        order: {
          coin: string;
          oid: number;
          cloid: string;
          limitPx: string;
          timestamp: number;
        };
      };
    };
    const wire = raw.order.order;
    const fill = {
      coin: wire.coin,
      oid: wire.oid,
      cloid: wire.cloid,
      side: "B",
      dir: "Buy",
      px: wire.limitPx,
      sz: "1",
      time: wire.timestamp,
      tid: 91,
      startPosition: "0",
      closedPnl: "0",
      hash: `0x${"ef".repeat(32)}`,
      crossed: false,
      fee: "0",
      feeToken: "USDC",
    };
    const execution = projectHip4Execution("mainnet", input.address, fill);
    await db.query(
      "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1)",
      [input.address],
    );
    await db.query(
      `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,market_id,execution,fingerprint,provider_fill)
      values('mainnet',$1,$2,$3,$4,$5,$6,$6,$7,$8,$9)`,
      [
        input.address,
        fill.time,
        fill.coin,
        fill.tid,
        fill.oid,
        input.marketId,
        execution,
        canonicalJsonHash(execution),
        fill,
      ],
    );
  };
  assert.ok(initialHold > 0n);
  await db.query("savepoint consumer_acceptance");
  for (const ambiguous of [false, true]) {
    for (const status of [
      "open",
      "filled",
      "canceled",
      "scheduledCancel",
      "delistedCanceled",
      "selfTradeCanceled",
      "outcomeSettledCanceled",
      "internalCancel",
    ]) {
      if (ambiguous)
        await recordHip4SubmissionReplyInTransaction(db, {
          userId: input.userId,
          actionId: input.actionId,
          body: null,
        });
      assert.equal(
        await attempt(),
        ambiguous ? "ambiguous" : "submission_started",
      );
      assert.equal(
        (await observe(input.response(status))).error,
        "account_history_unavailable",
      );
      assert.equal(await attempt(), "accepted", status);
      assert.equal(
        await hold(),
        initialHold,
        "acceptance is not balance inclusion",
      );
      assert.equal(
        (
          await db.query("select state from balance_reservations where id=$1", [
            input.reservationId,
          ])
        ).rows[0].state,
        "consumed",
      );
      const stored = (
        await db.query(
          "select status,coalesce(filled_size,0)::text as filled_size from orders where id=$1",
          [input.orderId],
        )
      ).rows[0];
      assert.equal(stored.filled_size, "0");
      assert.equal(
        stored.status,
        "submitted",
        "native canceled never becomes generic no_fill",
      );
      await observe(input.response(status));
      assert.equal(await attempt(), "accepted", "same consumer replay");
      await db.query("rollback to savepoint consumer_acceptance");
    }
    for (const status of [
      "rejected",
      "tickRejected",
      "minTradeNtlRejected",
      "badAloPxRejected",
      "iocCancelRejected",
      "marketOrderNoLiquidityRejected",
      "insufficientSpotBalanceRejected",
      "tooManyOpenOrdersRejected",
    ]) {
      if (ambiguous)
        await recordHip4SubmissionReplyInTransaction(db, {
          userId: input.userId,
          actionId: input.actionId,
          body: null,
        });
      assert.equal((await observe(input.response(status))).error, null);
      assert.equal(await attempt(), "definitive_failure", status);
      assert.equal(
        (
          await db.query("select state from balance_reservations where id=$1", [
            input.reservationId,
          ])
        ).rows[0].state,
        "released",
      );
      assert.equal(await hold(), 0n);
      assert.equal(
        (
          await db.query("select status from orders where id=$1", [
            input.orderId,
          ])
        ).rows[0].status,
        "failed",
      );
      assert.equal(
        await claim(),
        undefined,
        "terminal placement rejection stops order repair, not a new purchase",
      );
      await db.query("rollback to savepoint consumer_acceptance");
    }
    if (ambiguous)
      await recordHip4SubmissionReplyInTransaction(db, {
        userId: input.userId,
        actionId: input.actionId,
        body: null,
      });
    await addPartialFill();
    assert.equal(
      (await observe(input.response("iocCancelRejected"))).error,
      "rejected_order_execution_conflict",
    );
    assert.equal(
      await attempt(),
      ambiguous ? "ambiguous" : "submission_started",
    );
    assert.equal(
      await readHip4OrderHoldRaw(
        db,
        input.userId,
        input.address,
        HYPERCORE_MAINNET_USDC.assetId,
        new Date().toISOString(),
      ),
      initialHold,
      "contradictory rejection cannot release native exposure",
    );
    assert.equal((await observe(input.response("open"))).error, null);
    assert.equal(
      await attempt(),
      "accepted",
      "a corrected exact accepted status immediately repairs contradictory rejection",
    );
    await db.query("rollback to savepoint consumer_acceptance");
  }
  for (const body of [
    null,
    { status: "unknownOid" },
    input.response("futureUnknownStatus"),
  ]) {
    await observe(body);
    assert.equal(await attempt(), "submission_started");
    await db.query("rollback to savepoint consumer_acceptance");
  }
  // The normal worker saves status before making its fill-history request.
  assert.equal((await observe(input.response("open"), "status")).error, null);
  assert.equal(await attempt(), "accepted");
  await db.query("rollback to savepoint consumer_acceptance");
  await observe(input.response("open"));
  assert.equal(
    (await observe(input.response("minTradeNtlRejected"))).error,
    "order_status_regression",
    "an already accepted order cannot later become a placement rejection",
  );
  assert.equal(await attempt(), "accepted");
  assert.equal(await hold(), initialHold);
  await db.query("rollback to savepoint consumer_acceptance");
  // A previously exact terminal fact can be used without inventing a fresh
  // status read, but an invalidated cached fact cannot newly accept a consumer.
  await db.query("savepoint cached_fixture");
  await observe(input.response("canceled"));
  const cached = (
    await db.query(
      "select order_observation from hip4_order_submissions where action_id=$1",
      [input.actionId],
    )
  ).rows[0].order_observation;
  await db.query("rollback to savepoint cached_fixture");
  for (const invalidated of [false, true]) {
    const proof = structuredClone(cached);
    if (invalidated) proof.balanceBarrier.state = "invalidated";
    await db.query(
      "update hip4_order_submissions set order_observation=$2 where action_id=$1",
      [input.actionId, proof],
    );
    await observe({ status: "unknownOid" });
    assert.equal(
      await attempt(),
      invalidated ? "submission_started" : "accepted",
    );
    const after = (
      await db.query(
        "select order_observation from hip4_order_submissions where action_id=$1",
        [input.actionId],
      )
    ).rows[0].order_observation;
    assert.deepEqual(after.balanceBarrier, proof.balanceBarrier);
    await db.query("rollback to savepoint consumer_acceptance");
  }
  for (const invalidated of [false, true]) {
    const proof = structuredClone(cached);
    if (invalidated) proof.balanceBarrier.state = "invalidated";
    else delete proof.balanceBarrier; // previous exact observer schema
    await db.query(
      "update hip4_order_submissions set order_observation=$2 where action_id=$1",
      [input.actionId, proof],
    );
    await addPartialFill();
    await observe({ status: "unknownOid" });
    assert.equal(
      await attempt(),
      invalidated ? "submission_started" : "accepted",
      "legacy positive fills can repair an unresolved consumer, not contradict an invalidation",
    );
    if (invalidated) {
      await observe(input.response("canceled"));
      assert.equal(
        await attempt(),
        "accepted",
        "new exact observation repairs invalidated cache",
      );
    }
    await db.query("rollback to savepoint consumer_acceptance");
  }
  const stale = await claim();
  await db.query(
    "update hip4_order_submissions set reconcile_lease_until=clock_timestamp()-interval '1 second' where action_id=$1",
    [input.actionId],
  );
  await claim();
  assert.deepEqual(
    await recordHip4OrderObservationInTransaction(db, {
      claim: stale,
      userId: input.userId,
      body: input.response("open"),
      responseAt: Date.now(),
      maxRows: 100,
      retryMs: 60000,
      phase: "status",
    }),
    { saved: false },
  );
  assert.equal(await attempt(), "submission_started");
  await db.query("rollback to savepoint consumer_acceptance");
  await db.query("release savepoint consumer_acceptance");
}
