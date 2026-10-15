// @requires-db — synthetic records, disposable PG16, rollback; no provider IO.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { hip4Identity } from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import {
  persistHip4OrderPreparationInTransaction as prepare,
  persistHip4CancelPreparationInTransaction as cancel,
} from "./repos/hip4-order-preparation.js";
import {
  fetchUnifiedOrders,
  fetchUnifiedOrderById,
  mapUnifiedOrder,
} from "./repos/unified-orders.js";
import { unifiedOrderReadSchema } from "./schemas/orders.js";
import { projectHip4OpenOrders } from "./services/hip4-open-orders.js";
import { checkHip4NativeOrderReadPlans } from "./hip4-native-order-read-plans-pg.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const db = await pool.connect();
const readPool = db as unknown as Pool;
try {
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  await db.query("begin");
  const fixture = await hip4OrderTestFixture(db);
  const token = hip4Identity(
    "mainnet",
    Number(fixture.request.marketId.split(":").at(-1)),
  ).sides[1];
  let ordinal = 0;
  const makeOrder = () =>
    prepare(db, {
      ...fixture,
      nonce: fixture.nonce + ++ordinal,
      request: { ...fixture.request, requestKey: randomUUID() },
    });
  const cancelled = await makeOrder();
  const filled = await makeOrder();
  const ambiguousA = await makeOrder();
  const ambiguousB = await makeOrder();
  const unsigned = await makeOrder();
  const rejected = await makeOrder();
  const terminalAt = Date.now() - 1000;
  const terminal = (status: string) => ({
    status,
    terminal: true,
    balanceBarrier: { state: "terminal_observed", responseAt: terminalAt },
  });
  const admit = async (
    actionId: string,
    state: string,
    observation: unknown = null,
  ) => {
    await db.query(
      `insert into hip4_order_submissions(action_id,signature_fingerprint,
      admission_snapshot,signer_address,state,order_observation)
      values($1,$2,'{}',$3,$4,$5)`,
      [actionId, "a".repeat(64), fixture.profile.address, state, observation],
    );
  };
  await admit(cancelled.actionId, "reconcile_required", terminal("canceled"));
  await admit(filled.actionId, "reconcile_required", terminal("filled"));
  await admit(ambiguousA.actionId, "submission_started");
  await admit(ambiguousB.actionId, "reconcile_required");
  await admit(rejected.actionId, "rejected");
  const cancellation = await cancel(db, {
    userId: fixture.userId,
    requestKey: randomUUID(),
    orderId: unsigned.orderId,
    profile: fixture.profile,
    nonce: fixture.nonce + ++ordinal,
    expiresAfter: fixture.expiresAfter,
  });
  await admit(cancellation.actionId, "reconcile_required");
  await db.query(
    `update orders set status='submitted',posted_at=clock_timestamp()
    where id=any($1::uuid[])`,
    [
      [
        cancelled.orderId,
        filled.orderId,
        ambiguousA.orderId,
        ambiguousB.orderId,
        rejected.orderId,
      ],
    ],
  );
  await db.query(
    `update orders set status='partially_filled',filled_size=1.25,average_fill_price=0.3,
    venue_order_id='123' where id=$1`,
    [cancelled.orderId],
  );
  await db.query("update orders set venue_order_id='124' where id=$1", [
    filled.orderId,
  ]);

  const scope = {
    userId: fixture.userId,
    walletAddresses: [fixture.profile.address],
    venue: "hyperliquid",
    limit: 50,
    offset: 0,
  };
  const page = await fetchUnifiedOrders(readPool, scope);
  assert.equal(
    page.total,
    5,
    "no collapsing null-OID actions, no unsigned/cancel-only order",
  );
  const read = async (id: string) => {
    const row = await fetchUnifiedOrderById(readPool, { ...scope, id });
    assert.ok(row);
    return unifiedOrderReadSchema.parse(mapUnifiedOrder(row));
  };
  const closed = await read(cancelled.orderId);
  assert.equal(closed.nativeOrder?.cloid, cancelled.cloid);
  assert.equal(closed.nativeOrder?.openConfirmed, false);
  await db.query("savepoint native_open_projection");
  for (const [observation, expected] of [
    [null, false],
    [{ status: "open", terminal: false }, false],
    [
      {
        status: "open",
        terminal: false,
        balanceBarrier: { state: "accepted_observed", responseAt: terminalAt },
      },
      true,
    ],
    [
      {
        status: "open",
        terminal: false,
        balanceBarrier: {
          state: "accepted_observed",
          responseAt: Date.now() + 60000,
        },
      },
      false,
    ],
    [
      {
        status: "open",
        terminal: false,
        balanceBarrier: { state: "invalidated", responseAt: terminalAt },
      },
      false,
    ],
    [
      {
        status: "filled",
        terminal: true,
        balanceBarrier: { state: "accepted_observed", responseAt: terminalAt },
      },
      false,
    ],
  ] as const) {
    await db.query(
      "update hip4_order_submissions set order_observation=$2 where action_id=$1",
      [ambiguousA.actionId, observation],
    );
    assert.equal(
      (await read(ambiguousA.orderId)).nativeOrder?.openConfirmed,
      expected,
    );
  }
  await db.query(
    "update hip4_order_submissions set order_observation=$2 where action_id=$1",
    [
      rejected.actionId,
      {
        status: "open",
        terminal: false,
        balanceBarrier: { state: "accepted_observed", responseAt: terminalAt },
      },
    ],
  );
  assert.equal(
    (await read(rejected.orderId)).nativeOrder?.openConfirmed,
    false,
    "rejected cannot prove open",
  );
  await db.query("rollback to savepoint native_open_projection");
  assert.equal(closed.status, "cancelled");
  assert.equal(closed.outcome, "NO");
  assert.equal(closed.filledSize, 1.25);
  assert.equal(closed.nativeOrder?.filledQuantity, "1.25");
  assert.equal(closed.nativeOrder?.terminalConfirmed, true);
  assert.equal(closed.nativeOrder?.fullQuantityObserved, false);
  assert.ok(closed.nativeOrder?.terminalObservedAt);
  assert.equal(Date.parse(closed.nativeOrder.terminalObservedAt), terminalAt);
  const complete = await read(filled.orderId);
  assert.equal(complete.nativeOrder?.cloid, filled.cloid);
  assert.equal(complete.status, "filled");
  assert.equal(
    complete.filledSize,
    null,
    "native filled status cannot fabricate fill quantity",
  );
  assert.equal(complete.nativeOrder?.filledQuantity, null);
  assert.equal((await read(ambiguousA.orderId)).filledSize, null);
  assert.equal((await read(rejected.orderId)).filledSize, 0);
  await db.query(
    "update hip4_order_submissions set fills_observation=$2 where action_id=$1",
    [
      ambiguousA.actionId,
      {
        quantityRaw: "0",
        fullQuantityObserved: false,
        historyCoverage: "not_asserted",
      },
    ],
  );
  const observedZero = await read(ambiguousA.orderId);
  assert.equal(observedZero.filledSize, 0);
  assert.equal(observedZero.nativeOrder?.filledQuantity, "0");
  assert.equal(observedZero.nativeOrder?.fullQuantityObserved, false);
  assert.equal(complete.nativeOrder?.fillHistoryCoverage, "not_asserted");
  assert.equal((await read(rejected.orderId)).status, "rejected");
  assert.equal(
    (await fetchUnifiedOrders(readPool, { ...scope, status: "cancelled" }))
      .total,
    1,
  );
  assert.equal(
    (await fetchUnifiedOrders(readPool, { ...scope, status: "filled" })).total,
    1,
  );
  assert.equal(
    (await fetchUnifiedOrders(readPool, { ...scope, type: "order" })).total,
    5,
  );
  assert.equal(
    (await fetchUnifiedOrders(readPool, { ...scope, type: "execution" })).total,
    0,
  );
  assert.equal(
    (await fetchUnifiedOrders(readPool, { ...scope, type: "swap" })).total,
    0,
  );
  assert.equal(
    (
      await fetchUnifiedOrders(readPool, {
        ...scope,
        walletAddresses: ["0x" + "f".repeat(40)],
      })
    ).total,
    0,
  );
  assert.equal(
    await fetchUnifiedOrderById(readPool, {
      ...scope,
      id: cancelled.orderId,
      userId: randomUUID(),
    }),
    null,
  );
  assert.equal(
    await fetchUnifiedOrderById(readPool, { ...scope, id: unsigned.orderId }),
    null,
  );
  assert.equal(
    (await fetchUnifiedOrders(readPool, { ...scope, q: "Synthetic P4" })).total,
    5,
  );
  assert.equal(
    (
      await fetchUnifiedOrders(readPool, {
        ...scope,
        tokenId: token.tokenId,
      })
    ).total,
    5,
  );
  assert.equal(
    (
      await fetchUnifiedOrders(readPool, {
        ...scope,
        marketIds: [fixture.request.marketId],
      })
    ).total,
    5,
  );
  assert.equal(
    (
      await fetchUnifiedOrders(readPool, {
        ...scope,
        from: new Date(Date.now() + 100000),
      })
    ).total,
    0,
  );

  const openScope = {
    ...scope,
    openOnly: true,
    includeObservedHip4: true,
    hip4OpenOrderMaxAgeMs: 3_600_000,
  };
  const coin = token.coin;
  const snapshot = projectHip4OpenOrders(
    "mainnet",
    [123, 124, 125].map((oid) => ({
      coin,
      oid,
      side: "B",
      limitPx: "0.33333",
      sz: "4",
      origSz: "4",
      timestamp: terminalAt - 1000,
      orderType: "Limit",
      isTrigger: false,
      reduceOnly: false,
    })),
    terminalAt - 500,
  );
  await db.query(
    `insert into hip4_account_snapshots(environment,account_address,history)
    values('mainnet',$1,$2)`,
    [fixture.profile.address, { openOrders: snapshot }],
  );
  const open = await fetchUnifiedOrders(readPool, openScope);
  assert.equal(
    open.total,
    3,
    "old provider snapshot cannot resurrect two native terminal orders",
  );
  assert.equal(
    open.rows.filter((row) => row.kind === "observed_order").length,
    1,
  );
  assert.equal(
    await fetchUnifiedOrderById(readPool, {
      ...openScope,
      id: `hyperliquid:order:${fixture.profile.address}:123`,
    }),
    null,
  );
  // Invalidation/future or malformed barriers must keep exposure visible. Fixing
  // the exact observation restores terminal status without housekeeping delay.
  for (const barrier of [
    null,
    { state: "invalidated", responseAt: terminalAt },
    { state: "terminal_observed", responseAt: Date.now() + 60000 },
    { state: "terminal_observed", responseAt: "broken" },
  ]) {
    await db.query(
      "update hip4_order_submissions set order_observation=$2 where action_id=$1",
      [
        cancelled.actionId,
        { ...terminal("canceled"), balanceBarrier: barrier },
      ],
    );
    assert.equal((await read(cancelled.orderId)).status, "partially_filled");
    assert.equal((await fetchUnifiedOrders(readPool, openScope)).total, 4);
  }
  await db.query(
    "update hip4_order_submissions set order_observation=$2 where action_id=$1",
    [cancelled.actionId, terminal("canceled")],
  );
  assert.equal((await fetchUnifiedOrders(readPool, openScope)).total, 3);
  // A cancel ACK of the originally ambiguous native order also cannot close it.
  await db.query(
    "update hip4_order_submissions set reply_summary=$2 where action_id=$1",
    [ambiguousA.actionId, { state: "accepted" }],
  );
  assert.equal((await fetchUnifiedOrders(readPool, openScope)).total, 3);
  const stored = (
    await db.query("select status,filled_size::text from orders where id=$1", [
      cancelled.orderId,
    ])
  ).rows[0];
  assert.deepEqual(
    stored,
    { status: "partially_filled", filled_size: "1.25" },
    "reads do not mutate economic facts",
  );
  const legacyId = randomUUID();
  await db.query(
    `insert into orders(id,user_id,venue,wallet_address,status,venue_order_id,posted_at)
    values($1,$2,'limitless',$3,'live','legacy-read-model',clock_timestamp())`,
    [legacyId, fixture.userId, fixture.profile.address],
  );
  const mixed = await fetchUnifiedOrders(readPool, {
    ...scope,
    venue: undefined,
  });
  assert.equal(mixed.total, 6);
  const legacy = await fetchUnifiedOrderById(readPool, {
    ...scope,
    venue: undefined,
    id: legacyId,
  });
  assert.ok(legacy);
  assert.equal(mapUnifiedOrder(legacy).status, "live");
  assert.equal("nativeOrder" in mapUnifiedOrder(legacy), false);
  console.log(
    "HIP native order projection: lifecycle, ownership, replay/dedup and legacy checks passed",
  );
  await checkHip4NativeOrderReadPlans(db, {
    userId: fixture.userId,
    actionId: cancelled.actionId,
    address: fixture.profile.address,
  });
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
