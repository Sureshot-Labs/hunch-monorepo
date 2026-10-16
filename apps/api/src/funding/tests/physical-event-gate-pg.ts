import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import {
  fundingPhysicalEventIsBusy,
  tryLockFundingPhysicalEvent,
} from "../persistence/funding-physical-event-gate.js";
import { allocateFundingObservationInTransaction } from "../persistence/funding-operation-repository.js";
import { lockFundingReceiveCanonicalEvents } from "../persistence/funding-receive-session-repository.js";
import { recordRefundSourceDebitForTest } from "./refund-source-debit-fixture.js";
import { runFundingReconciliationBatch } from "../reconciliation/funding-reducer.js";
import { reconcileRelayDestinationReceipts } from "../reconciliation/relay-destination-receipts.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

/** Actual two-session insertion/legacy-upsert races. The try-only gate is a
 * serialization prerequisite, NOT proof that pending-anchor repair is ready. */
export async function verifyFundingPhysicalEventGatePg(
  pool: Pool,
  fixture: () => Promise<Fixture>,
) {
  const data = await fixture();
  const event = { ...data.evm[0], now: data.base.now };
  assert.ok(event.ledgerHeight && event.blockHash);
  const physical = {
    networkId: event.networkId,
    transactionHash: event.transactionHash,
    eventIndex: event.eventIndex,
  };
  const insertOwner = (db: PoolClient, txHash = event.transactionHash) =>
    allocateFundingObservationInTransaction(db, {
      operationId: data.base.operationId,
      segmentId: data.base.segmentId,
      kind: "destination_credit",
      networkId: event.networkId,
      assetId: event.asset.assetId,
      assetDecimals: event.asset.decimals,
      txHash,
      eventIndex: event.eventIndex,
      fromAddress: event.sourceAddress,
      toAddress: event.destinationAddress,
      rawAmount: event.rawAmount,
      observedAt: event.observedAt,
      ledgerHeight: event.ledgerHeight,
      blockHash: event.blockHash,
      finalityStatus: "finalized",
      finalizedAt: data.base.now,
      metadata: { test: "physical-event-gate" },
    });
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    // Case aliases include the prefix itself. The explicit handoff gate and
    // trigger adapter must agree before a negative owner read can be trusted.
    for (const networkId of ["evm:137", "evm:8453"]) {
      const lower = event.transactionHash.toLowerCase();
      for (const alias of [
        "0x" + lower.slice(2).toUpperCase(),
        lower.toUpperCase(),
      ]) {
        await a.query("begin");
        await b.query("begin");
        await a.query("select funding_try_lock_evm_physical_event($1,$2,$3)", [
          networkId,
          alias,
          event.eventIndex,
        ]);
        await assert.rejects(
          tryLockFundingPhysicalEvent(b, {
            ...physical,
            networkId,
            transactionHash: lower,
          }),
          fundingPhysicalEventIsBusy,
        );
        await b.query("rollback");
        await a.query("rollback");
        await a.query("begin");
        await b.query("begin");
        await tryLockFundingPhysicalEvent(a, {
          ...physical,
          networkId,
          transactionHash: alias,
        });
        await assert.rejects(
          b.query("select funding_try_lock_evm_physical_event($1,$2,$3)", [
            networkId,
            lower,
            event.eventIndex,
          ]),
          fundingPhysicalEventIsBusy,
        );
        await b.query("rollback");
        await a.query("rollback");
      }
    }
    await a.query("begin");
    await b.query("begin");
    await tryLockFundingPhysicalEvent(a, {
      ...physical,
      networkId: "hyperliquid:mainnet",
      eventIndex: "hypercore:send:source_debit",
    });
    await tryLockFundingPhysicalEvent(b, {
      ...physical,
      networkId: "hyperliquid:mainnet",
      transactionHash: physical.transactionHash.toUpperCase(),
      eventIndex: "hypercore:send:source_debit",
    });
    await b.query("rollback");
    await a.query("rollback");
    await a.query("begin");
    await b.query("begin");
    await insertOwner(a, physical.transactionHash.toUpperCase());
    await assert.rejects(
      lockFundingReceiveCanonicalEvents(b, [event]),
      fundingPhysicalEventIsBusy,
      "a legacy-cased observation gates the normal canonical checkpoint",
    );
    await b.query("rollback");
    await a.query("rollback");
    await a.query("begin");
    await b.query("begin");
    await lockFundingReceiveCanonicalEvents(a, [event]);
    await assert.rejects(
      insertOwner(b, physical.transactionHash.toUpperCase()),
      fundingPhysicalEventIsBusy,
      "canonical checkpoint first also gates a legacy-cased observation",
    );
    await b.query("rollback");
    await a.query("rollback");
    // A generic legacy owner creates no E and already holds O. Its insertion
    // still serializes with a concurrent new canonical checkpoint.
    await a.query("begin");
    await b.query("begin");
    await a.query("select id from funding_operations where id=$1 for update", [
      data.base.operationId,
    ]);
    await insertOwner(a);
    await assert.rejects(
      lockFundingReceiveCanonicalEvents(b, [event]),
      fundingPhysicalEventIsBusy,
    );
    await b.query("rollback");
    const busyQueries: string[] = [];
    const publisherPool = Object.create(pool) as Pool;
    publisherPool.query = pool.query.bind(pool);
    publisherPool.connect = (async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(client, key) {
          if (key === "query")
            return (sql: string, args?: unknown[]) => {
              busyQueries.push(sql);
              return client.query(sql, args);
            };
          const value = Reflect.get(client, key);
          return typeof value === "function" ? value.bind(client) : value;
        },
      });
    }) as Pool["connect"];
    assert.deepEqual(
      await reconcileRelayDestinationReceipts(
        publisherPool,
        {
          operationId: data.base.operationId,
          segmentId: data.base.segmentId,
          transactionHashes: [event.transactionHash],
          now: data.base.now,
          referenceCodec: data.base.referenceCodec,
          work: {
            progressToken: randomUUID(),
            deadlineMs: Date.now() + 5000,
            limit: 1,
          },
        },
        async () => [event],
      ),
      { roleScanPending: true, reason: "role_physical_evidence_busy" },
    );
    assert.equal(
      busyQueries.at(-1),
      "rollback",
      "the publisher reports busy only after completing rollback",
    );
    assert.equal(
      busyQueries.some((sql) => sql.includes("order by id for update")),
      false,
      "busy first E never acquires O",
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as event_count from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
          [event.networkId, event.transactionHash, event.eventIndex],
        )
      ).rows[0].event_count,
      0,
    );
    await a.query("rollback");

    // The opposite order cannot wait O -> E: the exact owner insert fails
    // immediately, rolls back its O, and succeeds on an ordinary fresh pass.
    await a.query("begin");
    await lockFundingReceiveCanonicalEvents(a, [event]);
    await b.query("begin");
    await b.query("select id from funding_operations where id=$1 for update", [
      data.base.operationId,
    ]);
    await assert.rejects(insertOwner(b), fundingPhysicalEventIsBusy);
    await b.query("rollback");
    await a.query("commit");
    await b.query("begin");
    await insertOwner(b);
    await b.query("commit");

    // BEFORE INSERT also runs on a duplicate ON CONFLICT replay. No fallback
    // may interpret a busy gate as an absent observation or external deposit.
    await a.query("begin");
    await tryLockFundingPhysicalEvent(a, physical);
    await b.query("begin");
    await assert.rejects(insertOwner(b), fundingPhysicalEventIsBusy);
    await b.query("rollback");
    await a.query("rollback");
    await b.query("begin");
    assert.equal((await insertOwner(b)).replayed, true);
    await b.query("rollback");

    // An old handoff root can SELECT existing E FOR UPDATE without running an
    // insert trigger. Another upsert then owns the gate and really waits on E.
    // Its later handoff acquisition MUST be try-only, never the old wait lock.
    await a.query("begin");
    await a.query(
      `select id from funding_receive_canonical_events
       where network_id=$1 and tx_hash=$2 and event_index=$3 for update`,
      [physical.networkId, physical.transactionHash, physical.eventIndex],
    );
    await a.query("select id from funding_operations where id=$1 for update", [
      data.base.operationId,
    ]);
    await b.query("begin");
    const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    const waiting = lockFundingReceiveCanonicalEvents(b, [event]);
    void waiting.catch(() => undefined);
    try {
      let blocked = false;
      for (let tick = 0; tick < 100; tick++) {
        if (
          (
            await pool.query(
              "select cardinality(pg_blocking_pids($1))>0 as blocked",
              [pid],
            )
          ).rows[0].blocked
        ) {
          blocked = true;
          break;
        }
      }
      assert.equal(blocked, true, "the legacy E/upsert gate cycle is real");
      await assert.rejects(
        tryLockFundingPhysicalEvent(a, physical),
        fundingPhysicalEventIsBusy,
      );
    } finally {
      await a.query("rollback");
      await waiting;
      await b.query("commit");
    }

    // The explicit old handoff namespace includes native source identities.
    // Trigger scope may be EVM-only, but the TS replacement cannot drop native.
    const native = {
      ...physical,
      networkId: "hyperliquid:mainnet",
      eventIndex: "hypercore:send:source_debit",
    };
    await a.query("begin");
    await b.query("begin");
    await tryLockFundingPhysicalEvent(a, native);
    assert.equal(
      (
        await b.query(
          "select pg_try_advisory_xact_lock(hashtextextended($1,0)) as acquired",
          [
            [native.networkId, native.transactionHash, native.eventIndex].join(
              ":",
            ),
          ],
        )
      ).rows[0].acquired,
      false,
      "exactly the previous namespace, not another native gate",
    );
    await assert.rejects(
      tryLockFundingPhysicalEvent(b, native),
      fundingPhysicalEventIsBusy,
    );
    await b.query("rollback");
    await a.query("rollback");
  } finally {
    await a.query("rollback");
    await b.query("rollback");
    a.release();
    b.release();
  }

  const source = await fixture();
  await recordRefundSourceDebitForTest(pool, source);
  const owned = (item: Fixture["evm"][number]) => ({
    transactionHash: item.transactionHash,
    handoffEventIndex: item.eventIndex,
    ledgerHeight: item.ledgerHeight,
    blockHash: item.blockHash,
  });
  const receiptId = (
    await pool.query(
      "select id from funding_step_receipt_observations where operation_id=$1",
      [source.base.operationId],
    )
  ).rows[0].id;
  await pool.query(
    `update funding_step_receipt_observations set evidence=evidence ||
      jsonb_build_object('transactionHash',null,'handoffOwnedPhysicalEventV1',$2::jsonb) where id=$1`,
    [receiptId, owned(source.evm[0])],
  );
  const holder = await pool.connect(),
    writer = await pool.connect();
  try {
    for (const held of source.evm) {
      await holder.query("begin");
      await tryLockFundingPhysicalEvent(holder, held);
      await writer.query("begin");
      await assert.rejects(
        writer.query(
          `update funding_step_receipt_observations set evidence=evidence ||
            jsonb_build_object('handoffOwnedPhysicalEventV1',$2::jsonb) where id=$1`,
          [receiptId, owned(source.evm[1])],
        ),
        fundingPhysicalEventIsBusy,
        "both the old and new stored marker key are protected even without outer tx hash",
      );
      await writer.query("rollback");
      await writer.query("begin");
      await writer.query(
        "update funding_step_receipt_observations set evidence=evidence || '{\"diagnosticOnly\":true}'::jsonb where id=$1",
        [receiptId],
      );
      await writer.query("rollback");
      await writer.query("begin");
      await writer.query(
        "update funding_step_receipt_observations set status='reorged',canonical=false,finalized_at=null,reorged_at=now() where id=$1",
        [receiptId],
      );
      await writer.query("rollback");
      await holder.query("rollback");
    }
  } finally {
    await holder.query("rollback");
    await writer.query("rollback");
    holder.release();
    writer.release();
  }
  console.log(
    "PASS shared physical try gate: absent E both orders, duplicate replay, real legacy E/gate cycle, native namespace, old/new markers, diagnostic/invalidation bypass",
  );
  const retry = await fixture();
  await recordRefundSourceDebitForTest(pool, retry);
  await pool.query(
    `update funding_operation_segments set raw_status='success',
    support_metadata=support_metadata || $2::jsonb where id=$1`,
    [
      retry.base.segmentId,
      {
        relayStatusCategory: "provider_success",
        destinationTransactionReferenceCount: retry.hashes.length,
        relaySuccessfulDestinationReferenceHashesV1: retry.hashes.map(
          relayDestinationReferenceIdentity,
        ),
      },
    ],
  );
  const transactionReferenceCodec = createFundingTransactionReferenceCodec({
    encryptionKey: Buffer.alloc(32, 29),
    lookupHmacKey: "offline-destination-publication-test-key",
    keyVersion: 1,
  });
  const now = new Date();
  const busyHolder = await pool.connect();
  const retryKey = retry.evm[0];
  let providerCalls = 0;
  const runWorker = (at: Date) =>
    runFundingReconciliationBatch(pool, {
      workerId: `physical-busy-${randomUUID()}`,
      limit: 1,
      concurrency: 1,
      leaseSeconds: 30,
      pollDelayMs: 2000,
      retryDelayMs: 30000,
      terminalTimeoutMs: 90000,
      now: at,
      providerPoll: async (operationId, observedAt, work) => {
        assert.equal(operationId, retry.base.operationId);
        providerCalls++;
        assert.ok(work);
        // Real tagged DB contention at the early evidence boundary, followed
        // on normal retry by the actual canonical destination publisher.
        await tryLockFundingPhysicalEvent(pool, retryKey);
        await reconcileRelayDestinationReceipts(
          pool,
          {
            operationId,
            segmentId: retry.base.segmentId,
            transactionHashes: retry.hashes,
            now: observedAt,
            referenceCodec: retry.base.referenceCodec,
            transactionReferenceCodec,
            work: { ...work, limit: 25 },
          },
          async () => retry.evm,
        );
        return { requestsPolled: 1 };
      },
    });
  try {
    await pool.query(
      `update funding_reconciliation_jobs set priority=1000001,due_at=$2,
      status='scheduled',lease_owner=null,lease_token=null,lease_until=null where operation_id=$1`,
      [retry.base.operationId, now],
    );
    await busyHolder.query("begin");
    await tryLockFundingPhysicalEvent(busyHolder, retryKey);
    assert.equal((await runWorker(now)).failed, 1);
    const job = (
      await pool.query(
        "select status,due_at,last_error_code,lease_token from funding_reconciliation_jobs where operation_id=$1",
        [retry.base.operationId],
      )
    ).rows[0];
    assert.equal(job.status, "scheduled");
    assert.equal(job.last_error_code, "funding_physical_event_busy");
    assert.equal(job.lease_token, null);
    assert.equal(
      job.due_at.getTime() - now.getTime(),
      2000,
      "expected gate contention uses ordinary active cadence, not a new 30s evidence failure",
    );
    await busyHolder.query("rollback");
    let dueAt = job.due_at;
    let completed = false;
    for (let tick = 0; tick < 10; tick++) {
      const recovered = await runWorker(dueAt);
      assert.equal(recovered.failed, 0);
      const operation = (
        await pool.query(
          `select operation_row.status,operation_row.error_code,job_row.due_at,
        (select count(*)::int from funding_observations observation_row where observation_row.operation_id=operation_row.id
          and observation_row.kind='destination_credit') as credits from funding_operations operation_row
        join funding_reconciliation_jobs job_row on job_row.operation_id=operation_row.id where operation_row.id=$1`,
          [retry.base.operationId],
        )
      ).rows[0];
      assert.notEqual(operation.status, "recovery_required");
      assert.notEqual(operation.error_code, "reconciliation_evidence_timeout");
      if (operation.credits === 2) {
        assert.equal(operation.status, "completed");
        completed = true;
        break;
      }
      assert.equal(operation.credits, 0);
      assert.equal(operation.due_at.getTime() - dueAt.getTime(), 2000);
      dueAt = operation.due_at;
    }
    assert.equal(
      completed,
      true,
      "ordinary due job resumes the actual atomic evidence publisher and reducer, not only callback dispatch",
    );
    assert.ok(providerCalls >= 2);
  } finally {
    await busyHolder.query("rollback");
    busyHolder.release();
    await pool.query(
      `update funding_reconciliation_jobs set priority=0,due_at=greatest(due_at,$2::timestamptz+interval '1 day') where operation_id=$1 and lease_token is null`,
      [retry.base.operationId, now],
    );
  }
  console.log(
    "PASS actual worker physical gate busy -> ordinary 2s due jobs -> atomic destination credits and completed reducer, no signing/submission",
  );
}
