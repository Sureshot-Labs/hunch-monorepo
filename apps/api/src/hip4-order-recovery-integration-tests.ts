// @requires-db — disposable PG16 only; offline signatures, no provider transport.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import {
  persistHip4OrderPreparationInTransaction as prepare,
  persistHip4CancelPreparationInTransaction as prepareCancel,
} from "./repos/hip4-order-preparation.js";
import { admitHip4OrderActionInTransaction as admit } from "./repos/hip4-order-admission.js";
import {
  readHip4OrderRecovery as read,
  abandonHip4OrderPreparation as abandon,
  abandonHip4OrderPreparationInTransaction,
  HIP4_ORDER_RECOVERY_SQL,
} from "./repos/hip4-order-recovery.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";

const pool = await createIntegrationTestPool({
  max: 4,
  options: "-c statement_timeout=10000",
});
const db = await pool.connect();
const wallet = Wallet.createRandom();
const submittedIds: string[] = [];
try {
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  await db.query("begin");
  const fixture = await hip4OrderTestFixture(db, wallet.address);
  const make = async (nonceOffset: number) =>
    prepare(db, {
      ...fixture,
      nonce: fixture.nonce + nonceOffset,
      request: { ...fixture.request, requestKey: randomUUID() },
    });
  const lost = await make(-100),
    rejected = await make(-99),
    raced = await make(-98),
    cancelOrder = await make(-97);
  await db.query("commit");
  const ref = { userId: fixture.userId, actionId: lost.actionId };
  const before = await read(pool, ref);
  assert.equal(before.state, "prepared");
  assert.equal(before.submissionState, null);
  assert.equal(before.orderId, lost.orderId);
  assert.deepEqual(
    Object.keys(before).sort(),
    [
      "actionId",
      "orderId",
      "requestKey",
      "kind",
      "state",
      "submissionState",
      "expiresAt",
    ].sort(),
  );
  await assert.rejects(
    read(pool, { ...ref, userId: randomUUID() }),
    /not_found/u,
  );
  await assert.rejects(
    abandon(pool, { ...ref, userId: randomUUID() }),
    /not_found/u,
  );
  assert.equal((await abandon(pool, ref)).state, "abandoned");
  assert.deepEqual(await abandon(pool, ref), await read(pool, ref));
  assert.equal(
    (await pool.query("select status from orders where id=$1", [lost.orderId]))
      .rows[0].status,
    "abandoned",
  );
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from hyperliquid_nonce_claims where order_action_id=$1",
        [lost.actionId],
      )
    ).rows[0].n,
    1,
  );
  const signed = async (prepared: typeof lost) => {
    const signing = prepareHip4TradeSigning(prepared.envelope);
    return {
      userId: fixture.userId,
      actionId: prepared.actionId,
      actor: "web_app",
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
          availableRaw: "100000000000",
          observedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
    };
  };
  await db.query("begin");
  await assert.rejects(
    admit(db, await signed(lost), () => true),
    /preparation_unavailable/u,
  );
  await db.query("rollback");

  // Winner A: admission holds shared locks before abandon. Discard MUST return
  // pending and cannot cancel a possibly submitted order or release cash.
  await db.query("begin");
  await admit(db, await signed(rejected), () => true);
  submittedIds.push(rejected.actionId);
  let completed = false;
  const queuedDiscard = abandon(pool, {
    ...ref,
    actionId: rejected.actionId,
  }).then((value) => {
    completed = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(completed, false);
  await db.query("commit");
  const submitted = await queuedDiscard;
  assert.equal(submitted.state, "prepared");
  assert.equal(submitted.submissionState, "submission_started");

  // Winner B: discard commits first. A delayed browser submit must fail; no
  // new submission row is created even with the original valid signature.
  await db.query("begin");
  await abandonHip4OrderPreparationInTransaction(db, {
    ...ref,
    actionId: raced.actionId,
  });
  const other = await pool.connect();
  await other.query("begin");
  const queuedAdmission = admit(other, await signed(raced), () => true).then(
    () => "accepted",
    (error) => String(error),
  );
  await db.query("commit");
  assert.match(await queuedAdmission, /preparation_unavailable/u);
  await other.query("rollback");
  other.release();
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from hip4_order_submissions where action_id=$1",
        [raced.actionId],
      )
    ).rows[0].n,
    0,
  );

  // Cancel discard affects only its unsigned action, not the parent's state.
  await db.query("begin");
  const cancellation = await prepareCancel(db, {
    userId: fixture.userId,
    orderId: cancelOrder.orderId,
    requestKey: randomUUID(),
    profile: fixture.profile,
    nonce: fixture.nonce - 96,
    expiresAfter: fixture.expiresAfter,
  });
  await db.query("commit");
  const discardedCancel = await abandon(pool, {
    ...ref,
    actionId: cancellation.actionId,
  });
  assert.equal(discardedCancel.kind, "cancelByCloid");
  assert.equal(discardedCancel.state, "abandoned");
  assert.equal(
    (
      await pool.query("select status from orders where id=$1", [
        cancelOrder.orderId,
      ])
    ).rows[0].status,
    "prepared",
  );
  await pool.query(
    "update hip4_order_submissions set state='rejected' where action_id=$1",
    [rejected.actionId],
  );
  assert.equal(
    (await abandon(pool, { ...ref, actionId: rejected.actionId }))
      .submissionState,
    "rejected",
  );
  for (const mode of ["force_generic_plan", "force_custom_plan"]) {
    await db.query(`set plan_cache_mode=${mode}`);
    await db.query(
      `prepare hip4_recovery_plan(uuid,uuid) as ${HIP4_ORDER_RECOVERY_SQL}`,
    );
    for (const id of [lost.actionId, randomUUID()]) {
      const plan = await db.query(
        `explain (analyze,buffers,format json) execute hip4_recovery_plan('${id}','${fixture.userId}')`,
      );
      assert.ok(plan.rows[0]["QUERY PLAN"]);
    }
    await db.query("deallocate hip4_recovery_plan");
  }
  console.log(
    "[hip4-recovery] PG16 ownership, exact identity, lock races both ways, nonce preservation, cancel isolation, empty/custom/generic plans passed",
  );
} finally {
  await db.query("rollback");
  for (const id of submittedIds)
    await db.query(
      "update hip4_order_submissions set reconcile_after='infinity' where action_id=$1",
      [id],
    );
  db.release();
  await pool.end();
}
