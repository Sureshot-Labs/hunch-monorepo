// @requires-db — explicit disposable PG16 only. Retains uniquely named test
// fixtures to exercise real commits/two-session visibility, never production.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import { createRelayReferenceCodec } from "../../../funding-providers/relay/reference-codec.js";
import { HYPERCORE_MAINNET_USDC } from "../../domain/hypercore-identity.js";
import { EXACT_REFUND_RECEIPTS_CONTRACT } from "../../domain/refund-settlement.js";
import type { AssetLocation } from "../../domain/types.js";
import {
  createFundingQuoteInTransaction,
  commitFundingOperationInTransaction,
  listFundingObservationsForOperation,
  type FundingCommitPlan,
} from "../../persistence/funding-operation-repository.js";
import {
  claimFundingReceiveCanonicalEventAllocation,
  compareFundingReceiveCanonicalEvents,
  lockFundingReceiveCanonicalEvents,
} from "../../persistence/funding-receive-session-repository.js";
import { recordRelayExactRefundReceiptsInTransaction } from "../../reconciliation/relay-exact-refund-receipts.js";
import { reconcileRelayExactRefundReceipts } from "../../reconciliation/relay-exact-refund-runtime.js";
import { loadFundingLifecycleFactsForOperationInTransaction } from "../../lifecycle/funding-lifecycle-facts-repository.js";
import { deriveFundingLifecycle } from "../../lifecycle/funding-lifecycle-projector.js";
import { relayExactRefundTestFixture } from "../relay-exact-refund-writer-pg.js";

const pool = await createIntegrationTestPool({
  max: 3,
  options: "-c statement_timeout=10000 -c lock_timeout=8000",
});
const codec = createRelayReferenceCodec({
  encryptionKey: Buffer.alloc(32, 13),
  lookupHmacKey: "offline-refund-concurrency-test-key-32chars",
  keyVersion: 1,
});

async function fixture() {
  const db = await pool.connect();
  try {
    await db.query("begin");
    assert.equal(
      (
        await db.query("show server_version_num")
      ).rows[0].server_version_num.slice(0, 2),
      "16",
    );
    const userId = (
      await db.query(
        "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
        [`exact-refund-race-${randomUUID()}@example.com`],
      )
    ).rows[0].id;
    const owner = `0x${randomBytes(20).toString("hex")}`;
    const source: AssetLocation = {
      kind: "wallet",
      accountId: userId,
      locationId: randomUUID(),
      asset: {
        networkId: "evm:8453",
        assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        decimals: 6,
      },
      details: { address: owner },
    };
    const sourceSnapshot = { kind: "owned_location", location: source };
    const destinationSnapshot = {
      kind: "owned_location",
      location: {
        ...source,
        kind: "venue_account",
        locationId: randomUUID(),
        asset: HYPERCORE_MAINNET_USDC,
        details: { address: owner, nativeSourceDex: "spot" },
      },
    };
    const requestId = `refund-race-${randomUUID()}`;
    const protocolOrderId = `0x${randomBytes(32).toString("hex")}`;
    const now = new Date();
    const sourceAmount = { asset: source.asset, raw: "10000000" };
    const destinationAmount = {
      asset: HYPERCORE_MAINNET_USDC,
      raw: "980000000",
    };
    // This fixture isolates allocator concurrency. Normalized real inbound and
    // native plans are separately covered in hip4-funding-receipt integration.
    const plan: FundingCommitPlan = {
      operation: {
        purpose: "add_funds",
        initialState: { status: "in_progress", stage: "committed" },
        experienceMode: "prepare_first",
        planKind: "wallet_route",
        sourceSnapshot,
        destinationTargetSnapshot: destinationSnapshot,
        externalRecipientId: null,
        venueId: "hyperliquid",
        marketId: null,
        marketContextSnapshot: null,
        venueBindingSnapshot: null,
        walletExecutionSnapshot: null,
        placementSnapshot: {},
        requestedSourceAmount: sourceAmount,
        requestedDestinationAmount: destinationAmount,
        supportMetadata: { test: "exact-refund-concurrency" },
      },
      segments: [
        {
          providerId: "relay",
          adapterId: "offline-refund-race",
          adapterVersion: 1,
          segmentKind: "cross_network_transfer",
          status: "planned",
          sourceSnapshot,
          destinationTargetSnapshot: destinationSnapshot,
          quotedInput: sourceAmount,
          quotedExpectedOutput: destinationAmount,
          quotedMinOutput: destinationAmount,
          providerQuoteRefCiphertext: codec.encrypt(requestId),
          providerQuoteRefLookupHmac: codec.fingerprint(requestId),
          depositAddressCiphertext: null,
          depositAddressLookupHmac: null,
          lookupKeyVersion: 1,
          refundLocationSnapshot: {
            ...source,
            refundEvidenceContract: EXACT_REFUND_RECEIPTS_CONTRACT,
            relayProtocolOrderId: protocolOrderId,
          },
          quoteExpiresAt: new Date(now.getTime() + 60000).toISOString(),
        },
      ],
      steps: [],
      reservations: [
        {
          segmentOrdinal: 0,
          componentId: randomUUID(),
          locationId: source.locationId,
          networkId: source.asset.networkId,
          assetId: source.asset.assetId,
          assetDecimals: source.asset.decimals,
          rawAmount: sourceAmount.raw,
          mode: "subtract_available",
          expiresAt: new Date(now.getTime() + 60000).toISOString(),
        },
      ],
    };
    const consentToken = randomUUID();
    const quote = await createFundingQuoteInTransaction(db, {
      userId,
      discoveryProjectionId: randomUUID(),
      selectedSourceOptionSnapshot: sourceSnapshot,
      marketContextSnapshot: null,
      destinationOptionSnapshot: destinationSnapshot,
      venueBindingSnapshot: null,
      planSnapshot: plan,
      policyVersion: 1,
      policyRevision: "offline-concurrency",
      canonicalRequest: { test: true },
      consentToken,
      expiresAt: new Date(now.getTime() + 60000),
    });
    const committed = await commitFundingOperationInTransaction(db, {
      userId,
      quoteId: quote.id,
      consentToken,
      idempotencyKey: randomUUID(),
      plan,
      subjectLookupHmac: "a".repeat(64),
      subjectLookupKeyVersion: 1,
    });
    const operationId = committed.operation.id;
    const segmentId = (
      await db.query(
        "select id from funding_operation_segments where operation_id=$1",
        [operationId],
      )
    ).rows[0].id;
    await db.query("commit");
    return relayExactRefundTestFixture({
      operationId,
      segmentId,
      requestId,
      referenceCodec: codec,
      protocolOrderId,
      source,
      target: source,
      now,
    });
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}

/** Assert a real PostgreSQL lock wait before allowing A to commit; no guessed
 * sleep is used to pretend two writers actually overlapped. */
async function race<T, U>(
  first: (db: PoolClient) => Promise<T>,
  second: (db: PoolClient) => Promise<U>,
  secondOwnsTransaction = false,
): Promise<[T, U]> {
  const a = await pool.connect();
  const b = await pool.connect();
  let secondResult:
    | Promise<{ ok: true; value: U } | { ok: false; error: unknown }>
    | undefined;
  try {
    await a.query("begin");
    if (!secondOwnsTransaction) await b.query("begin");
    const pid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    const firstResult = await first(a);
    secondResult = second(b).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    let blocked = false;
    for (let probe = 0; probe < 100; probe += 1) {
      const row = (
        await pool.query(
          "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
          [pid],
        )
      ).rows[0];
      if (row.blocked) {
        blocked = true;
        break;
      }
    }
    assert.ok(
      blocked,
      "second connection must really contend on PostgreSQL locks",
    );
    await a.query("commit");
    const result = await secondResult;
    if (!result.ok) throw result.error;
    if (!secondOwnsTransaction) await b.query("commit");
    return [firstResult, result.value];
  } finally {
    await a.query("rollback");
    if (secondResult) await secondResult;
    await b.query("rollback");
    a.release();
    b.release();
  }
}

function observePartial(
  data: Awaited<ReturnType<typeof fixture>>,
  index: number,
) {
  return async () => ({
    kind: "observed" as const,
    request: data.base.request,
    nativeLedger: [],
    evmEvents: [data.evm[index]],
    reason: null,
  });
}

const unusedRelay = {
  requestEvidence: async () => {
    throw new Error("Unexpected provider IO");
  },
};

/** Force the old cycle's exact interleaving, not merely contention after one
 * writer already finished. Receive holds A, refund holds B before taking O,
 * then receive must wait for B while O is still unlocked. */
async function staggeredBatchRace() {
  const data = await fixture();
  const events = [...data.evm].sort(compareFundingReceiveCanonicalEvents);
  const a = await pool.connect();
  const b = await pool.connect();
  const barrier = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  const firstKeyHeld = barrier();
  const continueReceive = barrier();
  const refundBeforeOperation = barrier();
  const continueRefund = barrier();
  let receiveTask: Promise<unknown> | undefined;
  let refundTask: Promise<unknown> | undefined;
  const transaction = async (db: PoolClient, run: () => Promise<void>) => {
    await db.query("begin");
    try {
      await run();
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  };
  const bounded = async (promise: Promise<void>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Missing PostgreSQL barrier: ${label}`)),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    const aPid = (await a.query("select pg_backend_pid() as pid")).rows[0].pid;
    const bPid = (await b.query("select pg_backend_pid() as pid")).rows[0].pid;
    let locks = 0;
    receiveTask = transaction(a, async () => {
      await lockFundingReceiveCanonicalEvents(
        {
          query: async (sql: string, args: unknown[]) => {
            const result = await a.query(sql, args);
            if (
              sql.includes("insert into funding_receive_canonical_events") &&
              ++locks === 1
            ) {
              firstKeyHeld.release();
              await continueReceive.promise;
            }
            return result;
          },
        } as never,
        [...events]
          .reverse()
          .map((event) => ({ ...event, now: data.base.now })),
      );
      await a.query(
        "select id from funding_operations where id=$1 for update",
        [data.base.operationId],
      );
    });
    // Attach rejection handlers immediately; the finally block still awaits
    // the original tasks and closes both transactions on any assertion error.
    void receiveTask.catch(() => undefined);
    await bounded(firstKeyHeld.promise, "receive A");
    refundTask = transaction(b, async () => {
      const result = await recordRelayExactRefundReceiptsInTransaction(
        {
          query: async (sql: string, args: unknown[]) => {
            if (
              sql.includes("select id from funding_operations") &&
              sql.includes("for update")
            ) {
              refundBeforeOperation.release();
              await continueRefund.promise;
            }
            return b.query(sql, args);
          },
        } as never,
        { ...data.base, evmEvents: [events[1]] },
      );
      assert.equal(result.kind, "partial");
    });
    void refundTask.catch(() => undefined);
    await bounded(refundBeforeOperation.promise, "refund B before O");
    continueReceive.release();
    let waitingForB = false;
    for (let probe = 0; probe < 100; probe++) {
      const row = (
        await pool.query(
          "select $2::int=any(pg_blocking_pids($1)) as blocked",
          [aPid, bPid],
        )
      ).rows[0];
      if (row.blocked) {
        waitingForB = true;
        break;
      }
    }
    assert.equal(
      waitingForB,
      true,
      "receive must wait on B before any operation lock",
    );
    const probe = await pool.connect();
    try {
      await probe.query("begin");
      const unlocked = await probe.query(
        "select id from funding_operations where id=$1 for update nowait",
        [data.base.operationId],
      );
      assert.equal(
        unlocked.rowCount,
        1,
        "O must still be available while receive waits on B",
      );
    } finally {
      await probe.query("rollback");
      probe.release();
    }
    continueRefund.release();
    await Promise.all([receiveTask, refundTask]);
    console.log(
      "PASS staggered receive A -> refund B -> receive waits B with O unlocked -> refund O -> both commit",
    );
  } finally {
    continueReceive.release();
    continueRefund.release();
    await Promise.allSettled(
      [receiveTask, refundTask].filter((task) => task !== undefined),
    );
    a.release();
    b.release();
  }
}

try {
  await staggeredBatchRace();
  for (const duplicate of [false, true]) {
    const data = await fixture();
    const statements: string[] = [];
    const results = await race(
      (db) =>
        recordRelayExactRefundReceiptsInTransaction(db, {
          ...data.base,
          evmEvents: [data.evm[0]],
        }),
      (db) => {
        const query = (sql: string, values?: unknown[]) => {
          statements.push(sql);
          return db.query(sql, values);
        };
        const dedicatedPool = {
          query,
          connect: async () => ({ query, release() {} }),
        } as unknown as Pool;
        return reconcileRelayExactRefundReceipts(
          dedicatedPool,
          unusedRelay,
          data.base,
          observePartial(data, duplicate ? 0 : 1),
        );
      },
      true,
    );
    assert.equal("inserted" in results[0] && results[0].inserted, 1);
    if (duplicate) {
      assert.deepEqual(results[1], {
        kind: "partial",
        inserted: 0,
        reason: "refund_receipts_incomplete",
      });
      assert.equal(statements.includes("rollback"), false);
      assert.equal(
        statements.some((sql) =>
          sql.includes("insert into funding_reconciliation_jobs"),
        ),
        false,
      );
    } else {
      assert.deepEqual(results[1], {
        kind: "pending",
        reason: "refund_evidence_changed_retry",
      });
      const rollback = statements.indexOf("rollback");
      assert.ok(rollback > statements.indexOf("begin"));
      const diagnostic = statements.findIndex((sql) =>
        sql.includes("set support_metadata=jsonb_set"),
      );
      assert.ok(
        diagnostic > rollback,
        "retry diagnostics follow the completed rollback",
      );
      const lock = statements.findIndex(
        (sql) =>
          sql.includes("select id from funding_operations") &&
          sql.includes("for update"),
      );
      assert.ok(lock >= 0);
      assert.equal(
        statements
          .slice(lock, rollback)
          .some(
            (sql) =>
              sql.includes("insert into funding_receive_canonical_events") ||
              sql.includes("insert into funding_observations") ||
              sql.includes("update funding_receive_canonical_events") ||
              sql.includes("update funding_observations") ||
              sql.includes("insert into funding_reconciliation_jobs"),
          ),
        false,
        "no new physical locks, quarantine, allocation, proof or wake after O on a stale snapshot",
      );
      assert.equal(
        (
          await pool.query(
            "select id from funding_receive_canonical_events where network_id=$1 and tx_hash=$2",
            [data.evm[1].networkId, data.hashes[1]],
          )
        ).rowCount,
        0,
        "stale attempt's newly inserted pending canonical row rolls back",
      );
      assert.equal(
        (
          await listFundingObservationsForOperation(pool, data.base.operationId)
        ).filter((row) => row.kind === "refund_credit").length,
        1,
      );
      const retry = await reconcileRelayExactRefundReceipts(
        pool,
        unusedRelay,
        data.base,
        observePartial(data, 1),
      );
      assert.deepEqual(
        retry,
        { kind: "complete", inserted: 1, reason: null },
        "next ordinary poll completes without a cooldown or manual repair",
      );
    }
    const rows = (
      await listFundingObservationsForOperation(pool, data.base.operationId)
    ).filter((row) => row.kind === "refund_credit");
    assert.equal(rows.length, duplicate ? 1 : 2);
    assert.equal(
      rows.reduce((sum, row) => sum + BigInt(row.rawAmount), 0n),
      duplicate ? 4000000n : 9800000n,
    );
    const facts = await loadFundingLifecycleFactsForOperationInTransaction(
      pool,
      data.base,
    );
    assert.ok(facts);
    const state = deriveFundingLifecycle(facts);
    assert.equal(state.status === "refunded", !duplicate);
    console.log(
      `PASS actual two-session ${duplicate ? "duplicate" : "disjoint partial"} refund writers`,
    );
  }
  const data = await fixture();
  const [refund, receive] = await race(
    (db) =>
      recordRelayExactRefundReceiptsInTransaction(db, {
        ...data.base,
        evmEvents: [data.evm[0]],
      }),
    (db) =>
      claimFundingReceiveCanonicalEventAllocation(db, {
        ...data.evm[0],
        now: data.base.now,
      }),
  );
  assert.equal(refund.kind, "partial");
  assert.equal(receive.status, "recovery_required");
  assert.equal(receive.errorCode, "internal_exact_refund_suppressed");
  assert.equal(receive.allocatedReceiptId, null);
  assert.equal(receive.targetReceiveSessionId, null);
  console.log(
    "PASS actual refund-first / receive-claim race: committed quarantine short-circuits the claim",
  );
  for (const refundFirst of [false, true]) {
    const batch = await fixture();
    const receiveBatch = async (db: PoolClient) => {
      await lockFundingReceiveCanonicalEvents(
        db,
        [...batch.evm]
          .reverse()
          .map((event) => ({ ...event, now: batch.base.now })),
      );
      // The receive allocator can only enter operation-owned work AFTER the
      // entire physical batch. This mirrors its real observer ordering.
      await db.query(
        "select id from funding_operations where id=$1 for update",
        [batch.base.operationId],
      );
      const events = await db.query(
        "select allocation_status,allocated_receipt_id from funding_receive_canonical_events where network_id=$1 and tx_hash=any($2::text[])",
        [batch.evm[0].networkId, batch.hashes],
      );
      assert.equal(events.rowCount, 2);
      assert.ok(events.rows.every((row) => row.allocated_receipt_id === null));
      return "prelocked";
    };
    const refundBatch = (db: PoolClient) =>
      recordRelayExactRefundReceiptsInTransaction(db, {
        ...batch.base,
        evmEvents: batch.evm,
      });
    if (refundFirst) {
      const [result, locked] = await race(refundBatch, receiveBatch);
      assert.equal(result.kind, "complete");
      assert.equal(locked, "prelocked");
    } else {
      const [locked, result] = await race(receiveBatch, refundBatch);
      assert.equal(locked, "prelocked");
      assert.equal(result.kind, "complete");
    }
    const proof = await pool.query(
      "select allocation_status,allocation_error_code,allocated_receipt_id from funding_receive_canonical_events where network_id=$1 and tx_hash=any($2::text[])",
      [batch.evm[0].networkId, batch.hashes],
    );
    assert.equal(proof.rowCount, 2);
    assert.ok(
      proof.rows.every(
        (row) =>
          row.allocation_status === "recovery_required" &&
          row.allocation_error_code === "internal_exact_refund_suppressed" &&
          row.allocated_receipt_id === null,
      ),
    );
    console.log(
      `PASS actual reversed multi-event ${refundFirst ? "refund-first" : "receive-prelock-first"} lock contention`,
    );
  }
  console.log(
    "NOTE full receive-session allocation (including receive-first), reorg/re-mining and worker wiring remain separate acceptance gates",
  );
} finally {
  await pool.end();
}
