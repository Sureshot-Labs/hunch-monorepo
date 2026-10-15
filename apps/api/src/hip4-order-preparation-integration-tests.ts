// @requires-db
// Synthetic unsigned records only, explicit disposable PG16 target; no signer,
// credentials, exchange requests or funding movements. Most fixtures roll back.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createIntegrationTestPool } from "./test-database-target.js";
import {
  persistHip4OrderPreparationInTransaction as prepare,
  persistHip4CancelPreparationInTransaction as cancel,
  HIP4_PREPARATION_LOOKUP_SQL,
  HIP4_OWNED_ORDER_ACTION_SQL,
} from "./repos/hip4-order-preparation.js";
import { deleteHistoryOrder } from "./repos/orders-repo.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { hip4OrderProtectedRefsSql } from "./services/hip4-retention.js";
import { fetchUserFinancialLifecycleSummary } from "./services/user-financial-lifecycle.js";
import { hip4OrderTestFixture as fixture } from "./hip4-order-test-fixture.js";

const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=10000",
});
const client = await pool.connect();
async function rejects(work: () => Promise<unknown>, pattern: RegExp) {
  await client.query("savepoint expected_rejection");
  await assert.rejects(work, pattern);
  await client.query("rollback to savepoint expected_rejection");
}
try {
  assert.match(
    (await client.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  await client.query("begin");
  const input = await fixture(client);
  const first = await prepare(client, input);
  assert.equal(first.envelope.action.type, "order");
  if (first.envelope.action.type !== "order") throw new Error("expected order");
  assert.equal(first.envelope.action.orders[0].p, "0.33333");
  assert.equal(first.envelope.action.orders[0].s, "4");
  assert.equal(first.envelope.action.orders[0].a % 10, 1);
  const stored = (
    await client.query(
      `select price::text,size::text,venue_order_id,status,
    funding_operation_id,funding_reservation_id,order_payload from orders where id=$1`,
      [first.orderId],
    )
  ).rows[0];
  assert.deepEqual(stored, {
    price: "0.33333",
    size: "4",
    venue_order_id: null,
    status: "prepared",
    funding_operation_id: null,
    funding_reservation_id: null,
    order_payload: null,
  });
  const saved = await prepare(client, {
    ...input,
    nonce: input.nonce + 99,
    feeCapRaw: null,
  });
  assert.deepEqual(
    saved,
    first,
    "same request returns frozen preparation before changed quote/policy validation",
  );
  assert.deepEqual(
    await prepare(client, {
      ...input,
      userId: input.userId.toUpperCase(),
      request: {
        ...input.request,
        requestKey: input.request.requestKey.toUpperCase(),
        controllerWalletRef: input.request.controllerWalletRef.toUpperCase(),
      },
    }),
    first,
    "UUID casing has PostgreSQL identity semantics before hashing and locking",
  );
  assert.equal(
    prepareHip4TradeSigning(saved.envelope).digest,
    prepareHip4TradeSigning(first.envelope).digest,
  );
  await rejects(
    () =>
      prepare(client, {
        ...input,
        request: { ...input.request, quantity: "5" },
      }),
    /preparation_conflict/u,
  );
  await rejects(
    () => prepare(client, { ...input, userId: randomUUID() }),
    /preparation_conflict/u,
  );
  await rejects(
    () =>
      prepare(client, {
        ...input,
        request: { ...input.request, requestKey: randomUUID() },
      }),
    /nonce.*bound/u,
  );
  assert.equal(
    (
      await client.query(
        "select count(*)::int as n from orders where user_id=$1",
        [input.userId],
      )
    ).rows[0].n,
    1,
  );
  await rejects(
    () =>
      prepare(client, {
        ...input,
        nonce: input.nonce + 1,
        request: { ...input.request, requestKey: randomUUID(), quantity: "1" },
      }),
    /buy_below_minimum/u,
  );
  const sell = await prepare(client, {
    ...input,
    nonce: input.nonce + 1,
    feeCapRaw: "0",
    request: {
      ...input.request,
      requestKey: randomUUID(),
      side: "SELL",
      quantity: "1",
      consentedDebitCapRaw: "100000",
      timeInForce: "Alo",
    },
  });
  assert.equal(
    sell.envelope.action.type === "order" && sell.envelope.action.orders[0].p,
    "0.33334",
  );
  await client.query("update unified_markets set status='CLOSED' where id=$1", [
    input.request.marketId,
  ]);
  const cancellation = {
    userId: input.userId,
    orderId: first.orderId,
    requestKey: randomUUID(),
    profile: input.profile,
    nonce: input.nonce + 2,
    expiresAfter: input.expiresAfter,
  };
  const cancelled = await cancel(client, cancellation);
  assert.equal(cancelled.orderId, first.orderId);
  assert.equal(cancelled.cloid, first.cloid);
  assert.deepEqual(cancelled.envelope.action, {
    type: "cancelByCloid",
    cancels: [
      {
        asset: first.envelope.action.orders[0].a,
        cloid: first.cloid,
      },
    ],
  });
  assert.deepEqual(
    await cancel(client, { ...cancellation, nonce: input.nonce + 3 }),
    cancelled,
  );
  assert.deepEqual(
    await cancel(client, {
      ...cancellation,
      requestKey: cancellation.requestKey.toUpperCase(),
      orderId: cancellation.orderId.toUpperCase(),
      userId: cancellation.userId.toUpperCase(),
    }),
    cancelled,
  );
  assert.equal(
    (
      await client.query("select status from orders where id=$1", [
        first.orderId,
      ])
    ).rows[0].status,
    "prepared",
  );
  await rejects(
    () =>
      cancel(client, {
        ...cancellation,
        requestKey: randomUUID(),
        userId: randomUUID(),
      }),
    /controller wallet changed/u,
  );
  await client.query("update user_wallets set is_verified=false where id=$1", [
    input.profile.controllerWalletRef,
  ]);
  await rejects(
    () =>
      cancel(client, {
        ...cancellation,
        requestKey: randomUUID(),
        nonce: input.nonce + 4,
      }),
    /controller wallet changed/u,
  );
  await rejects(
    () =>
      client.query("update hip4_order_actions set nonce=nonce+1 where id=$1", [
        first.actionId,
      ]),
    /immutable/u,
  );
  await rejects(
    () => client.query("delete from orders where id=$1", [first.orderId]),
    /foreign key/u,
  );
  const lifecycle = await fetchUserFinancialLifecycleSummary(client, [
    input.userId,
  ]);
  assert.equal(lifecycle.protectedEvidence, true);
  assert.equal(
    lifecycle.activeMovement,
    false,
    "unsigned preparations are not money in flight",
  );
  await client.query(
    "create temp table candidate_pool(market_id text primary key) on commit drop",
  );
  await client.query("insert into candidate_pool values($1)", [
    input.request.marketId,
  ]);
  assert.deepEqual(
    (await client.query(hip4OrderProtectedRefsSql("candidate_pool"))).rows,
    [{ market_id: input.request.marketId, reason: "hip4_order_actions" }],
  );
  const mergedOwner = randomUUID();
  await client.query("insert into users(id,is_active) values($1,true)", [
    mergedOwner,
  ]);
  await client.query("update orders set user_id=$2 where user_id=$1", [
    input.userId,
    mergedOwner,
  ]);
  assert.deepEqual(
    await prepare(client, { ...input, userId: mergedOwner }),
    first,
    "ownership follows the existing order merge, no stale child user ID",
  );
  await rejects(() => prepare(client, input), /preparation_conflict/u);
  await client.query(
    "update hip4_order_actions set state='abandoned' where id=$1",
    [first.actionId],
  );
  assert.equal(
    (await prepare(client, { ...input, userId: mergedOwner })).state,
    "abandoned",
  );
  await rejects(
    () =>
      client.query(
        "update hip4_order_actions set state='prepared' where id=$1",
        [first.actionId],
      ),
    /cannot be revived/u,
  );

  // Exact production lookup + retention SQL at 50k rows, including sparse/miss,
  // forced generic plans. Only connection-local shadow relations are modified.
  await client.query(
    "create temp table orders(like public.orders including indexes including defaults) on commit drop",
  );
  await client.query(
    "create temp table hip4_order_actions(like public.hip4_order_actions including indexes including defaults) on commit drop",
  );
  await client.query(
    `insert into orders(id,user_id,venue,status)
    select md5('prep-order-'||entry)::uuid,$1,'hyperliquid','prepared' from generate_series(1,50000) entry`,
    [mergedOwner],
  );
  await client.query(
    `insert into hip4_order_actions
    select md5('prep-action-'||entry)::uuid,md5('prep-order-'||entry)::uuid,md5('prep-key-'||entry)::uuid,
      source_row.request_fingerprint,'order',source_row.environment,source_row.signer_address,
      case when entry=123 then source_row.canonical_market_id else 'unrelated-'||entry end,
      source_row.token_id,'0x'||md5('prep-cloid-'||entry),entry,source_row.action_fingerprint,
      source_row.unsigned_envelope,source_row.preparation_snapshot,'prepared',now()
      from public.hip4_order_actions source_row cross join generate_series(1,50000) entry where source_row.id=$1`,
    [first.actionId],
  );
  await client.query("analyze orders");
  await client.query("analyze hip4_order_actions");
  await client.query("set local plan_cache_mode=force_generic_plan");
  await client.query(
    `prepare hip4_prepare_lookup(uuid) as ${HIP4_PREPARATION_LOOKUP_SQL}`,
  );
  for (const entry of [123, 50000, 50001]) {
    const plan = (
      await client.query(
        `explain(analyze,buffers,format json) execute hip4_prepare_lookup(md5('prep-key-${entry}')::uuid)`,
      )
    ).rows[0]["QUERY PLAN"][0];
    assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
    assert.equal(plan.Plan["Actual Rows"], entry === 50001 ? 0 : 1);
    console.log(
      "[hip4-prepare-plan]",
      JSON.stringify({
        entry,
        ms: plan["Execution Time"],
        blocks: plan.Plan["Local Hit Blocks"],
      }),
    );
  }
  const retentionPlan = (
    await client.query(
      `explain(analyze,buffers,format json) ${hip4OrderProtectedRefsSql("candidate_pool")}`,
    )
  ).rows[0]["QUERY PLAN"][0];
  assert.match(JSON.stringify(retentionPlan), /canonical_market_id/u);
  await client.query("deallocate hip4_prepare_lookup");
  await client.query(
    `prepare hip4_owned_cancel_lookup(uuid,uuid) as ${HIP4_OWNED_ORDER_ACTION_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await client.query(`set local plan_cache_mode=${mode}`);
    for (const [entry, owner] of [
      [123, mergedOwner],
      [50000, mergedOwner],
      [50001, mergedOwner],
      [123, randomUUID()],
    ] as const) {
      const plan = (
        await client.query(
          `explain(analyze,buffers,format json) execute hip4_owned_cancel_lookup(md5('prep-order-${entry}')::uuid,'${owner}'::uuid)`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      assert.equal(
        plan.Plan["Actual Rows"],
        entry <= 50000 && owner === mergedOwner ? 1 : 0,
      );
      console.log("[hip4-cancel-lookup-plan]", {
        mode,
        entry,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
      });
    }
  }
  await client.query("deallocate hip4_owned_cancel_lookup");
  await client.query("rollback");

  // True two-connection retry: winner rolls back (lost prepare), waiter then
  // creates exactly one fresh record. No committed financial fixture remains.
  await client.query("begin");
  const concurrent = await fixture(client);
  await client.query("commit");
  const waiter = await pool.connect();
  let durable: Awaited<ReturnType<typeof prepare>> | undefined;
  try {
    const lockerPid = (await client.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    const waiterPid = (await waiter.query("select pg_backend_pid() as pid"))
      .rows[0].pid;
    for (const commitWinner of [false, true]) {
      await client.query("begin");
      await waiter.query("begin");
      const winner = await prepare(client, concurrent);
      const pending = prepare(waiter, {
        ...concurrent,
        request: {
          ...concurrent.request,
          requestKey: concurrent.request.requestKey.toUpperCase(),
        },
      });
      void pending.catch(() => undefined);
      let blocked = false;
      const deadline = Date.now() + 5000;
      while (!blocked && Date.now() < deadline) {
        blocked = (
          await pool.query(
            "select $1::int=any(pg_blocking_pids($2::int)) as blocked",
            [lockerPid, waiterPid],
          )
        ).rows[0].blocked;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(
        blocked,
        "mixed-case retry must wait at the same database serialization boundary",
      );
      await client.query(commitWinner ? "commit" : "rollback");
      const recovered = await pending;
      assert.equal(
        (
          await waiter.query(
            "select count(*)::int as n from orders where user_id=$1",
            [concurrent.userId],
          )
        ).rows[0].n,
        1,
      );
      if (commitWinner) assert.deepEqual(recovered, winner);
      await waiter.query("rollback");
      durable = winner;
    }
  } finally {
    await client.query("rollback");
    await waiter.query("rollback");
    waiter.release();
  }
  // Keep the committed synthetic unsigned record for public cleanup checks.
  assert.ok(durable);
  await client.query("update orders set venue_order_id=$2 where id=$1", [
    durable.orderId,
    `history:${durable.cloid}`,
  ]);
  await deleteHistoryOrder(pool, {
    userId: concurrent.userId,
    venue: "hyperliquid",
    venueOrderId: `history:${durable.cloid}`,
  });
  assert.equal(
    (
      await client.query("select count(*)::int as n from orders where id=$1", [
        durable.orderId,
      ])
    ).rows[0].n,
    1,
  );
  // Claims intentionally survive history cleanup; immutable synthetic evidence
  // stays in this disposable database, never in application/production data.
  console.log(
    "[hip4-order-preparation] unsigned BUY/SELL/cancel, replay, exact decimals, ownership, nonce conflict, merge, retention and rollback recovery passed",
  );
} finally {
  await client.query("rollback");
  client.release();
  await pool.end();
}
