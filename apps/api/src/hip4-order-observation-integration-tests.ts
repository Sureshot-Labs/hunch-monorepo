// @requires-db — exact PG16, offline ephemeral key, no provider or Telegram IO.
import assert from "node:assert/strict";
import { randomUUID, randomInt } from "node:crypto";
import { Wallet } from "ethers";
import {
  hip4Identity,
  DEFAULT_VENUE_LIFECYCLE_POLICY,
  venueHasLifecycleCapability,
} from "@hunch/shared";
import { createIntegrationTestPool } from "./test-database-target.js";
import { hip4OrderTestFixture } from "./hip4-order-test-fixture.js";
import { hip4FundedOrderTestFixture } from "./hip4-funded-order-test-fixture.js";
import { persistHip4OrderPreparationInTransaction as prepare } from "./repos/hip4-order-preparation.js";
import { admitHip4OrderActionInTransaction as admit } from "./repos/hip4-order-admission.js";
import { prepareHip4TradeSigning } from "./services/hip4-trade-signing.js";
import { projectHip4Execution } from "./services/hip4-account-projection.js";
import { canonicalJsonHash } from "./funding/persistence/canonical.js";
import { HYPERCORE_MAINNET_USDC } from "./funding/domain/hypercore-identity.js";
import {
  HIP4_EXACT_ORDER_FILLS_SQL,
  HIP4_REJECTED_ORDER_EXECUTION_CONFLICT_SQL,
  HIP4_CLAIM_ORDER_OBSERVATION_SQL,
  HIP4_CLAIM_COMPLETED_ORDER_OBSERVATION_SQL,
  HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL,
  HIP4_ORDER_OBSERVATION_CONTEXT_SQL,
  recordHip4OrderObservationInTransaction as record,
  failHip4OrderObservation,
} from "./repos/hip4-order-observation.js";
import { readHip4OrderHoldRaw } from "./repos/hip4-order-holds.js";
import { recordHip4SubmissionReplyInTransaction } from "./services/hip4-order-submission.js";
import { observeHip4ClaimedOrder } from "./services/hip4-order-observer.js";
import {
  testHip4FundedOrderObservationRaces,
  testHip4TerminalOrderMergeRace,
} from "./hip4-order-observation-race-pg.js";
import { runHip4FinancialReadPass } from "./hip4-account-worker-entry.js";
import { testHip4ObserverSharedBudget } from "./hip4-order-observer-budget-pg.js";
import { loadHypercorePreparationAvailability } from "./funding/preparation/hypercore-availability.js";
import { hypercoreSpotAccountLocation } from "./account-value/canonical.js";
import { fetchUserFinancialLifecycleSummary } from "./services/user-financial-lifecycle.js";
import { testHip4OrderConsumerAcceptance } from "./hip4-order-consumer-pg.js";
import { testHip4OpenOrderHolds } from "./hip4-open-order-holds-pg.js";
import { HIP4_COMPLETED_ORDER_OBSERVATION_SQL } from "./services/hip4-order-observation-schedule.js";

const pool = await createIntegrationTestPool({
  max: 2,
  options: "-c statement_timeout=15000",
});
const db = await pool.connect();
const wallet = Wallet.createRandom();
const nativeOid = randomInt(1_000_000_000, 10_000_000_000);
const testCapability: typeof venueHasLifecycleCapability = (
  policy,
  _venue,
  capability,
) =>
  venueHasLifecycleCapability(
    {
      ...policy,
      venues: { ...policy.venues, polymarket: policy.venues.hyperliquid },
    },
    "polymarket",
    capability,
  );
try {
  await db.query("begin");
  assert.match(
    (await db.query("show server_version")).rows[0].server_version,
    /^16\./u,
  );
  const lifecycle = structuredClone(DEFAULT_VENUE_LIFECYCLE_POLICY);
  lifecycle.venues.hyperliquid = { lifecycle: "active", indexerMode: "off" };
  await db.query(
    "insert into runtime_policies(policy_key,payload,effective_at) values('venue_lifecycle',$1,clock_timestamp())",
    [lifecycle],
  );
  const fixture = await hip4OrderTestFixture(db, wallet.address);
  fixture.nonce -= 10000;
  const prepared = await prepare(db, fixture);
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
  const typed = prepareHip4TradeSigning(prepared.envelope).typedData;
  const signature = await wallet.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  );
  await admit(
    db,
    {
      userId: fixture.userId,
      actionId: prepared.actionId,
      signature,
      actor: "web_app",
      funding,
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
    testCapability,
  );
  const envelope = prepareHip4TradeSigning(prepared.envelope);
  assert.equal(envelope.action.type, "order");
  if (envelope.action.type !== "order") throw new Error("fixture");
  const wire = envelope.action.orders[0],
    coin = `#${wire.a - 100000000}`;
  const orderTime = fixture.nonce + 100,
    terminalTime = fixture.nonce + 300;
  const response = (status = "open", stamp = orderTime) => ({
    status: "order",
    order: {
      status,
      statusTimestamp: stamp,
      order: {
        coin,
        oid: nativeOid,
        cloid: wire.c,
        side: "B",
        limitPx: wire.p,
        sz: wire.s,
        origSz: wire.s,
        timestamp: orderTime,
        orderType: "Limit",
        reduceOnly: false,
        tif: "Ioc",
      },
    },
  });
  const claim = async () => {
    const row = (
      await db.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        prepared.actionId,
        60000,
        60000,
      ])
    ).rows[0];
    assert.ok(row);
    return row;
  };
  const recordBody = async (
    body: unknown,
    maxRows = 100,
    responseAt = Date.now(),
  ) =>
    record(db, {
      claim: await claim(),
      userId: fixture.userId,
      body,
      responseAt,
      maxRows,
      retryMs: 60000,
    });
  const attemptState = async () =>
    (
      await db.query(
        "select state from funding_trade_attempts where reservation_id=$1",
        [funding.reservationId],
      )
    ).rows[0].state;
  const orderRow = async () =>
    (
      await db.query(
        "select venue_order_id,status,filled_size from orders where id=$1",
        [prepared.orderId],
      )
    ).rows[0];
  assert.equal(
    (await recordBody({ status: "unknownOid" })).error,
    "order_not_observed",
  );
  assert.equal((await orderRow()).venue_order_id, null);
  assert.equal(await attemptState(), "submission_started");
  await testHip4OrderConsumerAcceptance(db, {
    actionId: prepared.actionId,
    orderId: prepared.orderId,
    userId: fixture.userId,
    address: fixture.profile.address,
    reservationId: funding.reservationId,
    marketId: identity.marketId,
    response,
  });
  await testHip4OpenOrderHolds(db, {
    actionId: prepared.actionId,
    userId: fixture.userId,
    profile: fixture.profile,
    feeCapRaw: fixture.feeCapRaw,
    response,
  });
  assert.equal(
    (await recordBody(response())).error,
    "account_history_unavailable",
  );
  assert.equal((await orderRow()).venue_order_id, String(nativeOid));
  const lifecycleSummary = () =>
    fetchUserFinancialLifecycleSummary(db, [fixture.userId]);
  assert.ok(
    (await lifecycleSummary()).activeReasons.includes("active_hip4_submission"),
  );
  await db.query(
    "insert into hip4_account_snapshots(environment,account_address) values('mainnet',$1)",
    [fixture.profile.address],
  );
  const terminalResponseAt = Date.now() - 5;
  const empty = await recordBody(
    response("canceled", terminalTime),
    100,
    terminalResponseAt,
  );
  assert.equal(empty.error, null);
  const terminalLifecycle = await lifecycleSummary();
  assert.equal(
    terminalLifecycle.activeReasons.includes("active_hip4_submission"),
    false,
  );
  assert.equal(
    terminalLifecycle.activeReasons.includes("active_funding_movement"),
    false,
    "confirmed consumer does not leave shared funding permanently unresolved",
  );
  assert.equal(terminalLifecycle.protectedEvidence, true);
  assert.ok(terminalLifecycle.protectedReasons.includes("trading_evidence"));
  assert.equal(
    await attemptState(),
    "accepted",
    "native cancellation proves acceptance, not zero fills",
  );
  await db.query("savepoint independent_funding");
  await hip4FundedOrderTestFixture(db, {
    userId: fixture.userId,
    profile: fixture.profile,
    marketId: fixture.request.marketId,
    tokenId: identity.sides[1].tokenId,
  });
  assert.ok(
    (await lifecycleSummary()).activeReasons.includes(
      "active_funding_movement",
    ),
    "other unresolved shared funding remains independent from native exposure",
  );
  await db.query("rollback to savepoint independent_funding");
  const hold = await readHip4OrderHoldRaw(
    db,
    fixture.userId,
    fixture.profile.address,
    HYPERCORE_MAINNET_USDC.assetId,
  );
  assert.ok(hold > 0n);
  const nativeHold = (snapshotAt: number) =>
    readHip4OrderHoldRaw(
      db,
      fixture.userId,
      fixture.profile.address,
      HYPERCORE_MAINNET_USDC.assetId,
      new Date(snapshotAt).toISOString(),
    );
  const { location } = hypercoreSpotAccountLocation({
    accountId: fixture.userId,
    address: fixture.profile.address,
    controllerWalletId: fixture.profile.walletId,
  });
  const plannedHolds = (snapshotAt: number) =>
    loadHypercorePreparationAvailability(db, {
      accountId: fixture.userId,
      location,
      observedAt: new Date(snapshotAt).toISOString(),
    });
  assert.equal(
    await nativeHold(terminalResponseAt - 1),
    hold,
    "slow overlapping balance read is not subsequent",
  );
  assert.equal(
    await nativeHold(terminalResponseAt),
    hold,
    "equal millisecond is not subsequent",
  );
  assert.equal(
    await nativeHold(terminalResponseAt + 1),
    0n,
    "terminal API observation then later capacity read",
  );
  assert.equal(
    (await plannedHolds(terminalResponseAt)).reservedRaw,
    String(hold),
    "shortfall includes admitted order, replacing its funding reserve exactly once",
  );
  assert.equal(
    (await plannedHolds(terminalResponseAt + 1)).reservedRaw,
    "0",
    "post-terminal native balance does not retain obsolete local/consumer holds",
  );
  assert.equal(
    await readHip4OrderHoldRaw(
      db,
      fixture.userId,
      fixture.profile.address,
      identity.sides[0].tokenId,
    ),
    0n,
    "USDC BUY hold is not a side-token SELL hold",
  );
  assert.equal((await recordBody(response())).error, "order_status_regression");
  assert.ok(
    (await lifecycleSummary()).activeReasons.includes("active_hip4_submission"),
  );
  assert.equal(
    await nativeHold(Date.now()),
    hold,
    "contradiction invalidates prior terminal barrier",
  );
  assert.equal(
    (await recordBody({ status: "unknownOid" })).error,
    "order_not_observed",
  );
  assert.equal(
    await nativeHold(Date.now()),
    hold,
    "unknownOid cannot repair invalidated inclusion",
  );
  const interveningSnapshot = Date.now() - 2;
  const repairedAt = Date.now() - 1;
  await recordBody(response("canceled", terminalTime), 100, repairedAt);
  assert.equal(
    (await lifecycleSummary()).activeReasons.includes("active_hip4_submission"),
    false,
  );
  assert.equal(
    await nativeHold(interveningSnapshot),
    hold,
    "repair never reuses pre-contradiction barrier",
  );
  assert.equal(await nativeHold(repairedAt), hold);
  assert.equal(await nativeHold(Date.now()), 0n);
  await db.query("savepoint malformed_inclusion");
  for (const proof of [
    null,
    { state: "terminal_observed", responseAt: "1" },
    { state: "terminal_observed", responseAt: "broken" },
    { state: "terminal_observed", responseAt: -1 },
    { state: "terminal_observed", responseAt: Number.MAX_SAFE_INTEGER + 1 },
    { state: "terminal_observed", responseAt: Date.now() + 60000 },
  ]) {
    await db.query(
      `update hip4_order_submissions set order_observation=jsonb_set(order_observation,'{balanceBarrier}',$2::jsonb)
      where action_id=$1`,
      [prepared.actionId, JSON.stringify(proof)],
    );
    assert.equal(
      await nativeHold(Date.now()),
      hold,
      "malformed/legacy inclusion retains capacity hold",
    );
    assert.ok(
      (await lifecycleSummary()).activeReasons.includes(
        "active_hip4_submission",
      ),
    );
  }
  await db.query("rollback to savepoint malformed_inclusion");
  await db.query("savepoint malformed_terminal");
  for (const terminal of ["true", [true]]) {
    await db.query(
      "update hip4_order_submissions set order_observation=jsonb_set(order_observation,'{terminal}',$2::jsonb) where action_id=$1",
      [prepared.actionId, JSON.stringify(terminal)],
    );
    assert.equal(await nativeHold(Date.now()), hold);
    assert.ok(
      (await lifecycleSummary()).activeReasons.includes(
        "active_hip4_submission",
      ),
    );
  }
  await db.query("rollback to savepoint malformed_terminal");
  assert.equal(
    (
      await db.query(
        "select order_observation->>'status' as status from hip4_order_submissions where action_id=$1",
        [prepared.actionId],
      )
    ).rows[0].status,
    "canceled",
  );
  await db.query("savepoint fill_cases");
  const addFill = async (tid: number, patch: Record<string, unknown> = {}) => {
    const fill = {
      coin,
      oid: nativeOid,
      cloid: wire.c,
      side: "B",
      px: "0.3",
      sz: "2",
      time: orderTime + tid,
      tid,
      startPosition: "0",
      dir: "Buy",
      closedPnl: "0",
      hash: `0x${"ef".repeat(32)}`,
      crossed: false,
      fee: "0",
      feeToken: "USDC",
      ...patch,
    };
    const execution = projectHip4Execution(
      "mainnet",
      fixture.profile.address,
      fill,
    );
    await db.query(
      `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,market_id,execution,fingerprint,provider_fill)
      values('mainnet',$1,$2,$3,$4,$9,$5,$5,$6,$7,$8)`,
      [
        fixture.profile.address,
        fill.time,
        coin,
        tid,
        identity.marketId,
        execution,
        canonicalJsonHash(execution),
        fill,
        nativeOid,
      ],
    );
  };
  // A positive exact partial fill proves the consumer even while the order
  // remains open. It must not imply complete history. Only a later provider
  // balance accounts for spent/resting principal, not the partial fill itself.
  await addFill(1);
  await db.query("savepoint rejected_fill");
  await db.query(
    "update hip4_order_submissions set order_observation=null where action_id=$1",
    [prepared.actionId],
  );
  assert.equal(
    (await recordBody(response("iocCancelRejected", terminalTime))).error,
    "rejected_order_execution_conflict",
  );
  assert.equal((await orderRow()).filled_size, "0");
  await db.query("rollback to savepoint rejected_fill");
  await db.query(
    "update hip4_order_submissions set order_observation=null where action_id=$1",
    [prepared.actionId],
  );
  const partialOpenAt = Date.now() - 2;
  assert.equal(
    (await recordBody(response("open"), 100, partialOpenAt)).error,
    null,
  );
  assert.equal(await attemptState(), "accepted");
  assert.equal((await orderRow()).status, "partially_filled");
  assert.ok(
    (await lifecycleSummary()).activeReasons.includes("active_hip4_submission"),
  );
  assert.equal(
    await readHip4OrderHoldRaw(
      db,
      fixture.userId,
      fixture.profile.address,
      HYPERCORE_MAINNET_USDC.assetId,
      new Date(partialOpenAt + 1).toISOString(),
    ),
    BigInt(fixture.feeCapRaw),
    "subsequent balance includes the open partial order's principal, not its conservative fee cap",
  );
  assert.equal(
    await nativeHold(partialOpenAt),
    hold,
    "partial fills alone do not remove the local cap",
  );
  await db.query("savepoint continued_repair");
  assert.ok(
    await claim(),
    "accepted consumer remains in the native order repair queue",
  );
  await db.query("rollback to savepoint continued_repair");
  await db.query("rollback to savepoint fill_cases");
  await addFill(1);
  assert.equal(
    (await recordBody(response("canceled", terminalTime))).error,
    null,
  );
  assert.equal((await orderRow()).filled_size, "2");
  assert.equal(await attemptState(), "accepted");
  assert.equal(
    (await lifecycleSummary()).activeReasons.includes("active_hip4_submission"),
    false,
  );
  const partialObservation = (
    await db.query(
      "select fills_observation from hip4_order_submissions where action_id=$1",
      [prepared.actionId],
    )
  ).rows[0].fills_observation;
  assert.equal(partialObservation.fullQuantityObserved, false);
  assert.equal(partialObservation.historyCoverage, "not_asserted");
  assert.equal(partialObservation.executionSummary.quantity, "2");
  assert.equal(partialObservation.executionSummary.fullQuantityObserved, false);
  assert.equal(
    partialObservation.executionSummary.source,
    "hyperliquid_user_fills",
  );
  assert.equal(
    await readHip4OrderHoldRaw(
      db,
      fixture.userId,
      fixture.profile.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ),
    hold,
  );
  await addFill(2);
  assert.equal(
    (await recordBody(response("canceled", terminalTime), 1)).error,
    "order_fills_page_incomplete",
  );
  assert.equal(
    (
      await db.query(
        "select fills_observation->'executionSummary' as summary from hip4_order_submissions where action_id=$1",
        [prepared.actionId],
      )
    ).rows[0].summary,
    null,
    "an incomplete repair invalidates the previous receipt, not just its error label",
  );
  assert.equal(
    await attemptState(),
    "accepted",
    "a later incomplete page cannot erase the confirmed consumer",
  );
  const full = await recordBody({ status: "unknownOid" });
  assert.equal(
    full.error,
    "order_not_observed",
    "cached terminal identity permits positive repair without claiming a new status check",
  );
  assert.equal((await orderRow()).filled_size, "4");
  assert.equal(await attemptState(), "accepted");
  await db.query("savepoint receipt_status_recovery");
  await record(db, {
    claim: await claim(),
    userId: fixture.userId,
    body: response("canceled", terminalTime),
    responseAt: Date.now(),
    maxRows: 100,
    retryMs: 60000,
    phase: "status",
  });
  assert.equal(
    (
      await db.query(
        "select fills_observation->'executionSummary' as summary from hip4_order_submissions where action_id=$1",
        [prepared.actionId],
      )
    ).rows[0].summary,
    null,
    "a successful status-only phase cannot resurrect a failed receipt observation",
  );
  await db.query("rollback to savepoint receipt_status_recovery");
  await recordHip4SubmissionReplyInTransaction(db, {
    userId: fixture.userId,
    actionId: prepared.actionId,
    body: {
      status: "ok",
      response: {
        type: "order",
        data: {
          statuses: [{ error: "Order has insufficient spot balance to trade" }],
        },
      },
    },
  });
  assert.equal(
    (await orderRow()).status,
    "filled",
    "delayed ACK/rejection cannot regress exact observed fills",
  );
  assert.equal(await attemptState(), "accepted");
  assert.equal(
    (
      await db.query("select state from balance_reservations where id=$1", [
        funding.reservationId,
      ])
    ).rows[0].state,
    "consumed",
  );
  assert.equal(
    await readHip4OrderHoldRaw(
      db,
      fixture.userId,
      fixture.profile.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ),
    hold,
    "consumer completion is not balance-inclusion proof and cannot release the native hold",
  );
  assert.equal(
    (await recordBody(response("canceled", terminalTime))).error,
    null,
    "idempotent funded replay",
  );
  const repairedSummary = (
    await db.query(
      "select fills_observation->'executionSummary' as summary from hip4_order_submissions where action_id=$1",
      [prepared.actionId],
    )
  ).rows[0].summary;
  assert.equal(repairedSummary.quantity, "4");
  assert.equal(repairedSummary.executionCount, 2);
  assert.equal(repairedSummary.fullQuantityObserved, true);
  const completedSchedule = (
    await db.query(
      `select ${HIP4_COMPLETED_ORDER_OBSERVATION_SQL} as completed_lane,
    extract(epoch from (reconcile_after-clock_timestamp()))*1000 as remaining_ms
    from hip4_order_submissions where action_id=$1`,
      [prepared.actionId],
    )
  ).rows[0];
  assert.equal(completedSchedule.completed_lane, true);
  assert.ok(
    Number(completedSchedule.remaining_ms) > 3_500_000,
    "complete full-fill rechecks use the current policy cold interval",
  );
  await db.query("savepoint cold_repair_recovery");
  const coldClaim = await claim();
  assert.equal(
    await failHip4OrderObservation(db, coldClaim, "timeout", 60000),
    true,
    "explicit exact repair bypasses cold due time",
  );
  assert.equal(
    (
      await db.query(
        `select ${HIP4_COMPLETED_ORDER_OBSERVATION_SQL} as completed_lane from hip4_order_submissions where action_id=$1`,
        [prepared.actionId],
      )
    ).rows[0].completed_lane,
    false,
    "failed recheck re-enters the hot repair lane without releasing financial holds",
  );
  await db.query("rollback to savepoint cold_repair_recovery");
  await db.query("rollback to savepoint fill_cases");
  await addFill(1, { sz: "4", feeToken: "UNKNOWN" });
  assert.equal(
    (await recordBody(response("canceled", terminalTime))).error,
    null,
  );
  assert.equal(
    await attemptState(),
    "accepted",
    "unknown fee asset does not erase the exact consumer",
  );
  const unknownFees = (
    await db.query(
      "select fills_observation from hip4_order_submissions where action_id=$1",
      [prepared.actionId],
    )
  ).rows[0].fills_observation;
  assert.equal(unknownFees.feeCoverage, "unknown");
  assert.equal(unknownFees.executionSummary.fee, null);
  assert.equal(unknownFees.executionSummary.netQuoteCash, null);
  assert.equal(unknownFees.historyCoverage, "not_asserted");
  assert.equal(
    await readHip4OrderHoldRaw(
      db,
      fixture.userId,
      fixture.profile.address,
      HYPERCORE_MAINNET_USDC.assetId,
    ),
    hold,
  );
  await db.query("rollback to savepoint fill_cases");
  await addFill(1, { sz: "4" });
  await db.query(
    "update hip4_account_snapshots set history=$2 where environment='mainnet' and account_address=$1",
    [fixture.profile.address, { accountingConflicts: { [coin]: orderTime } }],
  );
  assert.equal(
    (await recordBody(response("canceled", terminalTime))).error,
    "execution_identity_conflict",
  );
  await db.query(
    "update hip4_account_snapshots set history=$2 where environment='mainnet' and account_address=$1",
    [
      fixture.profile.address,
      { accountingConflicts: { [coin]: terminalTime + 1000 } },
    ],
  );
  assert.equal(
    (await recordBody(response("canceled", terminalTime))).error,
    "execution_identity_conflict",
    "lossy max conflict metadata cannot rule out an earlier conflict in this order",
  );
  await db.query(
    "update hip4_account_snapshots set history=$2 where environment='mainnet' and account_address=$1",
    [
      fixture.profile.address,
      { accountingConflicts: { [coin]: orderTime - 1 } },
    ],
  );
  assert.equal(
    (await recordBody(response("canceled", terminalTime))).error,
    null,
    "an old unrelated coin conflict cannot poison this order",
  );
  assert.equal(await attemptState(), "accepted");
  await db.query("rollback to savepoint fill_cases");
  await addFill(1, { sz: "4" });
  await db.query(
    "update hip4_account_executions set execution=jsonb_set(execution,'{quantity}','\"3\"') where account_address=$1",
    [fixture.profile.address],
  );
  assert.equal(
    (await recordBody(response("canceled", terminalTime))).error,
    "execution_projection_conflict",
  );
  await db.query("rollback to savepoint fill_cases");
  const staleClaim = await claim();
  assert.equal(
    (
      await db.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        prepared.actionId,
        60000,
        60000,
      ])
    ).rowCount,
    0,
  );
  await db.query(
    "update hip4_order_submissions set reconcile_lease_until=clock_timestamp()-interval '1 second' where action_id=$1",
    [prepared.actionId],
  );
  const currentClaim = await claim();
  assert.deepEqual(
    await record(db, {
      claim: staleClaim,
      userId: fixture.userId,
      body: response(),
      responseAt: Date.now(),
      maxRows: 100,
      retryMs: 60000,
    }),
    { saved: false },
  );
  assert.equal(
    await failHip4OrderObservation(db, staleClaim, "timeout", 60000),
    false,
  );
  assert.equal(
    await failHip4OrderObservation(db, currentClaim, "timeout", 60000),
    true,
  );
  assert.equal(
    (
      await db.query(
        "select order_observation->>'status' as status from hip4_order_submissions where action_id=$1",
        [prepared.actionId],
      )
    ).rows[0].status,
    "canceled",
  );
  const ownerClaim = await claim();
  assert.deepEqual(
    await record(db, {
      claim: ownerClaim,
      userId: randomUUID(),
      body: response(),
      responseAt: Date.now(),
      maxRows: 100,
      retryMs: 60000,
    }),
    { saved: false },
  );
  await failHip4OrderObservation(db, ownerClaim, "owner_changed", 60000);
  // Parse every changed SQL including normal/empty queue selection on PG16.
  await db.query("savepoint due_scan");
  await db.query(HIP4_CLAIM_ORDER_OBSERVATION_SQL, [60000, 60000]);
  await db.query("rollback to savepoint due_scan");
  await db.query("rollback");

  // Representative equality-prefix plans: unrelated history cannot be scanned.
  await db.query("begin");
  await db.query(
    "create temp table hip4_account_executions(like public.hip4_account_executions including all) on commit drop",
  );
  await db.query(
    `insert into hip4_account_executions(environment,account_address,time_ms,coin,tid,oid,canonical_market_id,execution,fingerprint)
    select 'mainnet',$1,100000+n,'#14731',n,n%5000,'synthetic','{}','test' from generate_series(1,100000) as fixture_rows(n)`,
    [fixture.profile.address],
  );
  await db.query("analyze hip4_account_executions");
  await db.query(
    `prepare exact_fills(text,text,text,bigint,int) as ${HIP4_EXACT_ORDER_FILLS_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query(`set local plan_cache_mode=${mode}`);
    for (const oid of [1, 5001]) {
      const plan = (
        await db.query(
          `explain(analyze,buffers,format json) execute exact_fills('mainnet','${fixture.profile.address}','#14731',${oid},101)`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      assert.equal(plan.Plan["Actual Rows"], oid === 1 ? 20 : 0);
      console.log("[hip4-order-fills-plan]", {
        mode,
        oid,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
      });
    }
  }
  await db.query("deallocate exact_fills");
  await db.query(
    `prepare rejection_execution_conflict(text,text,text,bigint,uuid) as ${HIP4_REJECTED_ORDER_EXECUTION_CONFLICT_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query(`set local plan_cache_mode=${mode}`);
    for (const oid of [1, 5001]) {
      const plan = (
        await db.query(
          `explain(analyze,buffers,format json) execute rejection_execution_conflict('mainnet','${fixture.profile.address}','#14731',${oid},'${prepared.orderId}')`,
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.equal(plan.Plan["Actual Rows"], oid === 1 ? 1 : 0);
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      console.log("[hip4-rejection-conflict-plan]", {
        mode,
        oid,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
      });
    }
  }
  await db.query("deallocate rejection_execution_conflict");
  // Context PK join is parsed with empty tail as well.
  assert.equal(
    (
      await db.query(HIP4_ORDER_OBSERVATION_CONTEXT_SQL, [
        randomUUID(),
        randomUUID(),
      ])
    ).rowCount,
    0,
  );
  // Due/leased/sparse queue plans use their time index, including the empty tail.
  await db.query(
    "create temp table hip4_order_submissions(like public.hip4_order_submissions including all) on commit drop",
  );
  await db.query(
    `insert into hip4_order_submissions(action_id,signature_fingerprint,admission_snapshot,signer_address,debit_asset_id,debit_decimals,debit_raw,reconcile_after)
    select gen_random_uuid(),repeat('a',64),'{}',$1,'USDC',8,'1',statement_timestamp()+interval '1 day'
    from generate_series(1,50000)`,
    [fixture.profile.address],
  );
  await db.query("analyze hip4_order_submissions");
  await db.query(
    `prepare due_order_observation(int,int) as ${HIP4_CLAIM_ORDER_OBSERVATION_SQL}`,
  );
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query(`set local plan_cache_mode=${mode}`);
    for (const due of [true, false]) {
      if (due)
        await db.query(
          "update hip4_order_submissions set reconcile_after='-infinity',reconcile_lease_token=null,reconcile_lease_until=null where action_id=(select action_id from hip4_order_submissions order by action_id limit 1)",
        );
      const plan = (
        await db.query(
          "explain(analyze,buffers,format json) execute due_order_observation(60000,1000)",
        )
      ).rows[0]["QUERY PLAN"][0];
      assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
      assert.equal(plan.Plan["Actual Rows"], due ? 1 : 0);
      console.log("[hip4-order-due-plan]", {
        mode,
        due,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
      });
    }
  }
  await db.query("deallocate due_order_observation");
  // Dense completed history must not be scanned to find one new/ambiguous
  // action. Both lanes retain bounded first/resumed/empty indexed plans.
  await db.query(`update hip4_order_submissions set reconcile_after=clock_timestamp()+interval '1 day',
    reconcile_lease_token=null,reconcile_lease_until=null,reconcile_error=null,
    order_observation='{"terminal":true,"balanceBarrier":{"state":"terminal_observed"}}',
    fills_observation='{"fullQuantityObserved":true,"feeCoverage":"known","executionSummary":{}}'`);
  const hotAction = (
    await db.query(
      "select action_id from hip4_order_submissions order by action_id limit 1",
    )
  ).rows[0].action_id as string;
  await db.query(
    "update hip4_order_submissions set fills_observation=null where action_id=$1",
    [hotAction],
  );
  await db.query("analyze hip4_order_submissions");
  const completedAction = (
    await db.query(
      "select action_id from hip4_order_submissions where action_id<>$1 order by action_id limit 1",
      [hotAction],
    )
  ).rows[0].action_id as string;
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await db.query(`set local plan_cache_mode=${mode}`);
    for (const [lane, sql] of [
      ["hot", HIP4_CLAIM_ORDER_OBSERVATION_SQL],
      ["completed", HIP4_CLAIM_COMPLETED_ORDER_OBSERVATION_SQL],
    ] as const) {
      const statement = `due_${lane}_${mode}`;
      await db.query(`prepare ${statement}(int,int) as ${sql}`);
      for (const due of [true, false]) {
        await db.query(
          `update hip4_order_submissions set reconcile_after=case when $1 then '-infinity'::timestamptz else 'infinity'::timestamptz end,reconcile_lease_token=null,reconcile_lease_until=null
            where action_id=$2`,
          [due, lane === "completed" ? completedAction : hotAction],
        );
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${statement}(60000,1000)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(plan.Plan["Actual Rows"], due ? 1 : 0);
        assert.doesNotMatch(JSON.stringify(plan), /Seq Scan/u);
        const buffers =
          Number(plan.Plan["Local Hit Blocks"] ?? 0) +
          Number(plan.Plan["Local Read Blocks"] ?? 0);
        console.log("[hip4-reconcile-lane-plan]", {
          mode,
          lane,
          due,
          ms: plan["Execution Time"],
          buffers,
        });
        assert.ok(
          buffers < 128,
          "lane claim must not scan 50k completed records",
        );
      }
      await db.query(`deallocate ${statement}`);
    }
  }
  await db.query("rollback");
  // Real committed runtime with max=1 pool and shared request-budget SQL;
  // provider transport is in-memory. No external endpoint is contacted.
  const runtime = await createIntegrationTestPool({
    max: 1,
    options: "-c statement_timeout=15000",
  });
  let runtimePolicyId: string | null = null;
  let disabledLifecycleId: string | null = null;
  let runtimeActionId: string | null = null;
  try {
    const setup = await runtime.connect();
    let runtimePrepared: Awaited<ReturnType<typeof prepare>>;
    let runtimeFixture: Awaited<ReturnType<typeof hip4OrderTestFixture>>;
    try {
      await setup.query("begin");
      await setup.query(
        "create temp table hip4_request_budget(like public.hip4_request_budget including all)",
      );
      runtimeFixture = await hip4OrderTestFixture(setup, wallet.address);
      runtimeFixture.nonce -= 10000;
      runtimePrepared = await prepare(setup, runtimeFixture);
      runtimeActionId = runtimePrepared.actionId;
      const signing = prepareHip4TradeSigning(
        runtimePrepared.envelope,
      ).typedData;
      // The runtime/merge fixture has no common funding attempt: that existing
      // cross-venue merge restriction is separate from native order exposure.
      // Funded acceptance and P2 concurrency run in their own fixture below.
      await admit(
        setup,
        {
          userId: runtimeFixture.userId,
          actionId: runtimePrepared.actionId,
          actor: "web_app",
          signature: await wallet.signTypedData(
            signing.domain,
            signing.types,
            signing.message,
          ),
          context: {
            profile: runtimeFixture.profile,
            feeCapRaw: runtimeFixture.feeCapRaw,
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
      runtimePolicyId = (
        await setup.query(
          "insert into runtime_policies(policy_key,payload,effective_at) values('hip4_read',$1,clock_timestamp()) returning id",
          [{ environment: "testnet", requestWeightPerMinute: 1200 }],
        )
      ).rows[0].id;
      await setup.query("commit");
    } finally {
      await setup.query("rollback");
      setup.release();
    }
    let calls = 0;
    const runtimeEnvelope = prepareHip4TradeSigning(runtimePrepared.envelope);
    if (runtimeEnvelope.action.type !== "order") throw new Error("fixture");
    const native = runtimeEnvelope.action.orders[0];
    const pending = await Promise.all(
      [1, 2].map(() =>
        runtime.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
          runtimePrepared.actionId,
          60000,
          60000,
        ]),
      ),
    );
    assert.equal(
      pending.reduce((sum, row) => sum + (row.rowCount ?? 0), 0),
      1,
      "concurrent admission leases one exact observation",
    );
    const runtimeClaim = pending.flatMap((row) => row.rows)[0];
    let runtimeStatus = "open";
    let runtimeFills: Record<string, unknown>[] = [];
    let failRepair = false;
    let expireDuringRepair = false;
    const barriersSeenDuringHttp: unknown[] = [];
    const fake: typeof fetch = async (url, options) => {
      assert.equal(
        url,
        "https://api.hyperliquid.xyz/info",
        "stored mainnet order cannot migrate to discovery's testnet",
      );
      const request = JSON.parse(String(options?.body));
      if (request.type === "userFillsByTime") {
        assert.equal(request.user, runtimeFixture.profile.address);
        assert.equal(request.startTime, runtimeFixture.nonce);
        assert.ok(request.endTime <= Date.now());
        assert.equal(request.aggregateByTime, false);
        calls++;
        if (failRepair) {
          const stagedStatus = (
            await runtime.query(
              "select order_observation->'balanceBarrier' as barrier from hip4_order_submissions where action_id=$1",
              [runtimePrepared.actionId],
            )
          ).rows[0].barrier;
          barriersSeenDuringHttp.push(stagedStatus?.state ?? null);
          if (expireDuringRepair)
            await runtime.query(
              "update hip4_order_submissions set reconcile_lease_until=clock_timestamp()-interval '1 millisecond' where action_id=$1",
              [runtimePrepared.actionId],
            );
          return new Response("temporary failure", { status: 503 });
        }
        return Response.json(runtimeFills);
      }
      assert.deepEqual(request, {
        type: "orderStatus",
        user: runtimeFixture.profile.address,
        oid: native.c,
      });
      calls++;
      return Response.json({
        status: "order",
        order: {
          status: runtimeStatus,
          statusTimestamp:
            runtimeFixture.nonce + (runtimeStatus === "open" ? 100 : 300),
          order: {
            coin: `#${native.a - 100000000}`,
            oid: nativeOid,
            cloid: native.c,
            side: "B",
            limitPx: native.p,
            sz: native.s,
            origSz: native.s,
            timestamp: runtimeFixture.nonce + 100,
            orderType: "Limit",
            reduceOnly: false,
            tif: "Ioc",
          },
        },
      });
    };
    const observedRuntime = await observeHip4ClaimedOrder(
      runtime,
      runtimeClaim,
      100,
      60000,
      fake,
    );
    assert.equal(observedRuntime.saved, true);
    assert.equal(observedRuntime.error, null);
    assert.equal(calls, 2);
    assert.equal(
      (await observeHip4ClaimedOrder(runtime, runtimeClaim, 100, 60000, fake))
        .saved,
      false,
    );
    assert.equal(calls, 2, "completed claim cannot reread provider");
    const budget = (
      await runtime.query(
        "select admissions from hip4_request_budget where scope='public-info'",
      )
    ).rows[0].admissions;
    assert.equal(budget.length, 2);
    assert.equal(budget[0].weight, 2);
    assert.equal(budget[1].weight, 120);
    const accountRow = (
      await runtime.query(
        "select attempt_at,observed_at,observation from hip4_account_snapshots where environment='mainnet' and account_address=$1",
        [runtimeFixture.profile.address],
      )
    ).rows[0];
    assert.equal(
      accountRow.attempt_at,
      null,
      "targeted fills cannot postpone the ordinary balance refresh",
    );
    assert.equal(accountRow.observed_at, null);
    assert.equal(
      accountRow.observation,
      null,
      "fill repair never manufactures a balance",
    );
    assert.equal(
      (
        await runtime.query(
          "select fills_observation->'repair'->'nextTime' as next_time from hip4_order_submissions where action_id=$1",
          [runtimePrepared.actionId],
        )
      ).rows[0].next_time,
      null,
    );
    failRepair = true;
    runtimeStatus = "filled";
    const repairFailureClaim = (
      await runtime.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        runtimePrepared.actionId,
        60000,
        60000,
      ])
    ).rows[0];
    const failedRepairResult = await observeHip4ClaimedOrder(
      runtime,
      repairFailureClaim,
      100,
      60000,
      fake,
    );
    assert.equal(failedRepairResult.saved, true);
    assert.equal(failedRepairResult.error, "http_error");
    assert.deepEqual(barriersSeenDuringHttp, ["terminal_observed"]);
    const barrierAfterFailure = (
      await runtime.query(
        "select order_observation->'balanceBarrier' as barrier from hip4_order_submissions where action_id=$1",
        [runtimePrepared.actionId],
      )
    ).rows[0].barrier;
    assert.equal(barrierAfterFailure.state, "terminal_observed");
    assert.notEqual(
      (
        await runtime.query("select status from orders where id=$1", [
          runtimePrepared.orderId,
        ])
      ).rows[0].status,
      "filled",
      "native terminal status is not a fabricated execution",
    );
    runtimeStatus = "open";
    expireDuringRepair = true;
    const expiredRepairClaim = (
      await runtime.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        runtimePrepared.actionId,
        60000,
        60000,
      ])
    ).rows[0];
    assert.equal(
      (
        await observeHip4ClaimedOrder(
          runtime,
          expiredRepairClaim,
          100,
          60000,
          fake,
        )
      ).saved,
      false,
    );
    assert.deepEqual(barriersSeenDuringHttp, [
      "terminal_observed",
      "invalidated",
    ]);
    assert.equal(
      (
        await runtime.query(
          "select order_observation->'balanceBarrier'->>'state' as state from hip4_order_submissions where action_id=$1",
          [runtimePrepared.actionId],
        )
      ).rows[0].state,
      "invalidated",
      "contradiction remains durable after lease loss during fill repair",
    );
    assert.deepEqual(
      await observeHip4ClaimedOrder(
        runtime,
        expiredRepairClaim,
        100,
        60000,
        fake,
      ),
      { saved: false },
      "old claimant cannot restore inclusion",
    );
    failRepair = false;
    expireDuringRepair = false;
    runtimeStatus = "filled";
    const racePool = await createIntegrationTestPool({
      max: 2,
      options: "-c statement_timeout=15000",
    });
    const fullFill = {
      coin: `#${native.a - 100000000}`,
      oid: nativeOid,
      cloid: native.c,
      side: "B",
      px: native.p,
      sz: native.s,
      time: runtimeFixture.nonce + 200,
      tid: 1,
      startPosition: "0",
      dir: "Buy",
      closedPnl: "0",
      hash: `0x${"ef".repeat(32)}`,
      crossed: false,
      fee: "0",
      feeToken: "USDC",
    };
    try {
      await testHip4FundedOrderObservationRaces(racePool);
    } finally {
      await racePool.end();
    }
    runtimeStatus = "filled";
    runtimeFills = [fullFill];
    // Repair the canonical committed action before the following session-local
    // queue fixture. Merge below must inspect real facts, not that temporary copy.
    const canonicalClaim = (
      await runtime.query(HIP4_CLAIM_EXACT_ORDER_OBSERVATION_SQL, [
        runtimePrepared.actionId,
        60000,
        60000,
      ])
    ).rows[0];
    assert.ok(canonicalClaim);
    assert.equal(
      (await observeHip4ClaimedOrder(runtime, canonicalClaim, 100, 60000, fake))
        .saved,
      true,
    );
    // The exact scheduled entry continues admitted recovery after common venue
    // disabling, but does not enable general wallet reads or switch environment.
    // Session-local queue contains only this synthetic committed action.
    await runtime.query(
      "create temp table hip4_order_submissions(like public.hip4_order_submissions including all)",
    );
    await runtime.query(
      "insert into hip4_order_submissions select * from public.hip4_order_submissions where action_id=$1",
      [runtimePrepared.actionId],
    );
    await runtime.query(
      "update hip4_order_submissions set reconcile_after='-infinity' where action_id=$1",
      [runtimePrepared.actionId],
    );
    disabledLifecycleId = (
      await runtime.query(
        "insert into runtime_policies(policy_key,payload,effective_at) values('venue_lifecycle',$1,clock_timestamp()) returning id",
        [DEFAULT_VENUE_LIFECYCLE_POLICY],
      )
    ).rows[0].id;
    const recovered = await runHip4FinancialReadPass(runtime, fake);
    assert.equal(
      recovered.claimed,
      0,
      "disabled general account reads remain disabled",
    );
    assert.deepEqual(recovered.orderObservation, {
      claimed: 1,
      saved: 1,
      errors: 0,
      leaseLost: 0,
      budgetExhausted: 0,
      completedClaimed: 1,
    });
    assert.equal(
      (
        await runtime.query(
          "select count(*)::int as n from hip4_account_executions where environment='mainnet' and account_address=$1",
          [runtimeFixture.profile.address],
        )
      ).rows[0].n,
      1,
      "provider replay uses the existing P2 execution identity",
    );
    assert.equal(
      (
        await runtime.query(
          "select attempt_at from hip4_account_snapshots where environment='mainnet' and account_address=$1",
          [runtimeFixture.profile.address],
        )
      ).rows[0].attempt_at,
      null,
    );
    const mergePool = await createIntegrationTestPool({
      max: 2,
      options: "-c statement_timeout=15000",
    });
    try {
      const terminalBody = await (
        await fake("https://api.hyperliquid.xyz/info", {
          body: JSON.stringify({
            type: "orderStatus",
            user: runtimeFixture.profile.address,
            oid: native.c,
          }),
        })
      ).json();
      await testHip4TerminalOrderMergeRace(mergePool, {
        actionId: runtimePrepared.actionId,
        userId: runtimeFixture.userId,
        body: terminalBody,
      });
    } finally {
      await mergePool.end();
    }
  } finally {
    if (disabledLifecycleId)
      await runtime.query("delete from runtime_policies where id=$1", [
        disabledLifecycleId,
      ]);
    if (runtimePolicyId)
      await runtime.query("delete from runtime_policies where id=$1", [
        runtimePolicyId,
      ]);
    // Retain synthetic immutable financial fixture, but take it out of unrelated
    // queue tests in this disposable database. No user/production row is touched.
    if (runtimeActionId)
      await runtime.query(
        "update public.hip4_order_submissions set reconcile_after='infinity' where action_id=$1",
        [runtimeActionId],
      );
    await runtime.end();
  }
  await testHip4ObserverSharedBudget();
  console.log(
    "[hip4-order-observation] exact facts, common consumer, pending recovery, lease and 100k indexed plans passed",
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
