import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx, type Pool } from "@hunch/infra";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { reconcileRelayExactRefundReceipts } from "../reconciliation/relay-exact-refund-runtime.js";
import { publishRelayExactRefundReceipts } from "../reconciliation/relay-exact-refund-publication.js";
import { recordRelayExactRefundReceiptsInTransaction } from "../reconciliation/relay-exact-refund-receipts.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { RelayClient } from "../../funding-providers/relay/client.js";
import { RelayReconciliationDriver } from "../../funding-providers/relay/reconciliation.js";
import { createRelayDepositAddressCodec } from "../../funding-providers/relay/reference-codec.js";
import { createRefundReceiveSessionFixture } from "./owned-refund-receive-race-pg.js";
import { insertFundingReceiveReceipt } from "../persistence/funding-receive-session-repository.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;
export async function verifyExactRefundRuntimePg(
  pool: Pool,
  fixture: () => Promise<Fixture>,
) {
  const transactionReferenceCodec = createFundingTransactionReferenceCodec({
    encryptionKey: Buffer.alloc(32, 77),
    lookupHmacKey: "offline-exact-runtime-transaction-key",
    keyVersion: 1,
  });
  const work = (limit = 50) => ({
    progressToken: randomUUID(),
    deadlineMs: Date.now() + 30_000,
    limit,
  });
  const refunds = async (data: Fixture) =>
    (
      await pool.query(
        `select to_jsonb(observation_row)::text as snapshot from funding_observations observation_row
    where operation_id=$1 and kind='refund_credit' order by id`,
        [data.base.operationId],
      )
    ).rows;
  const job = async (data: Fixture) =>
    (
      await pool.query(
        "select to_jsonb(job_row)::text as snapshot from funding_reconciliation_jobs job_row where operation_id=$1",
        [data.base.operationId],
      )
    ).rows[0]?.snapshot;

  // The actual existing driver's FIFTH callback, original lease context, real
  // status persistence, runtime observation, joint publisher and raw commits.
  const data = await fixture();
  let indices = [0];
  let observations = 0;
  const originalWork = work();
  const relay = new RelayClient({
    apiKey: "offline-exact-runtime",
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      assert.equal(pathname, "/intents/status/v3");
      return Response.json(data.status);
    },
  });
  const driver = new RelayReconciliationDriver(
    relay,
    data.base.referenceCodec,
    createRelayDepositAddressCodec({
      encryptionKey: Buffer.alloc(32, 78),
      lookupHmacKey: "offline-exact-runtime-deposit-key",
      keyVersion: 1,
    }),
    async () => assert.fail("refund status reached destination callback"),
    async (db, target) => {
      assert.ok(target.work);
      assert.deepEqual(target.work, originalWork);
      assert.equal(
        (
          await db.query(
            "select raw_status from funding_operation_segments where id=$1",
            [target.segmentId],
          )
        ).rows[0].raw_status,
        "refund",
      );
      const result = await reconcileRelayExactRefundReceipts(
        db,
        relay,
        {
          ...data.base,
          ...target,
          transactionReferenceCodec,
          work: { ...target.work, limit: 50 },
        },
        async (_pool, _relay, read) => {
          observations++;
          assert.equal(read.expected.requestId, data.base.requestId);
          assert.ok(read.deadlineMs !== undefined);
          assert.ok(
            read.deadlineMs <= originalWork.deadlineMs &&
              read.deadlineMs > Date.now(),
          );
          return {
            kind: "observed",
            request: data.request,
            evmEvents: indices.map((index) => data.evm[index]),
            nativeLedger: [],
            reason: null,
          };
        },
      );
      assert.ok(["pending", "partial", "complete"].includes(result.kind));
    },
  );
  for (let tick = 0; tick < 100; tick++) {
    await driver.pollOperation(
      pool,
      data.base.operationId,
      data.base.now,
      originalWork,
    );
    if ((await refunds(data)).length === 1) break;
    assert.ok(tick < 99, "actual driver/runtime first partial must converge");
  }
  assert.equal((await refunds(data)).length, 1);
  indices = [1];
  for (let tick = 0; tick < 100; tick++) {
    await driver.pollOperation(
      pool,
      data.base.operationId,
      data.base.now,
      originalWork,
    );
    if ((await refunds(data)).length === 2) break;
    assert.ok(tick < 99, "actual driver/runtime completion must converge");
  }
  assert.equal((await refunds(data)).length, 2);
  const diagnostic = (
    await pool.query(
      "select support_metadata from funding_operation_segments where id=$1",
      [data.base.segmentId],
    )
  ).rows[0].support_metadata.exactRefundReceipts;
  assert.equal(diagnostic.result, "complete");
  assert.equal(diagnostic.reason, null);
  assert.ok(observations >= 2);
  // Internal derived transactions must not re-read provider evidence; each
  // driver observation invokes the transport adapter exactly once per poll.
  const beforeReplay = await refunds(data);
  await driver.pollOperation(
    pool,
    data.base.operationId,
    data.base.now,
    originalWork,
  );
  assert.deepEqual(await refunds(data), beforeReplay);
  console.log(
    "PASS actual fifth Relay callback -> persisted status -> runtime -> joint exact partial/completion/replay with original work",
  );

  for (const status of [
    "observed",
    "review_required",
    "routing",
    "ready",
    "recovery_required",
  ] as const) {
    const blocked = await fixture();
    const foreign = await fixture();
    const raw = blocked.evm[1];
    assert.ok(raw.ledgerHeight && raw.blockHash);
    const event = {
      ...raw,
      ledgerHeight: raw.ledgerHeight,
      blockHash: raw.blockHash,
      now: blocked.base.now,
    };
    const receive = await createRefundReceiveSessionFixture(pool, {
      userId: foreign.base.source.accountId,
      event,
    });
    await tx(pool, (db) =>
      insertFundingReceiveReceipt(db, {
        receiveSessionId: receive.sessionId,
        userId: foreign.base.source.accountId,
        variantId: receive.scopeId,
        asset: raw.asset,
        destinationAddress: raw.destinationAddress,
        rawAmount: raw.rawAmount,
        observationRevision: receive.scopeId,
        canonicalEvent: {
          ...event,
          transactionHash: event.transactionHash.toUpperCase(),
        },
        observedAt: raw.observedAt,
        handling: "direct",
        status,
        evidence: { offlineHistoricalClaim: true },
        now: blocked.base.now,
      }),
    );
    await pool.query(
      "update funding_receive_sessions set status='expired',closed_at=$2,version=version+1 where id=$1",
      [receive.sessionId, blocked.base.now],
    );
    const snapshot = (
      await pool.query(
        "select to_jsonb(receipt_row)::text as snapshot from funding_receive_receipts receipt_row where receive_session_id=$1",
        [receive.sessionId],
      )
    ).rows[0].snapshot;
    const beforeJob = await job(blocked);
    let result;
    for (let tick = 0; tick < 100; tick++) {
      result = await publishRelayExactRefundReceipts(pool, {
        ...blocked.base,
        evmEvents: blocked.evm,
        transactionReferenceCodec,
        work: work(),
      });
      if (
        result.kind === "pending" &&
        result.reason === "refund_receive_claim_conflict"
      )
        break;
      assert.ok(
        tick < 99,
        `expected exact all-state receive conflict, got ${JSON.stringify(result)}`,
      );
    }
    assert.deepEqual(result, {
      kind: "pending",
      reason: "refund_receive_claim_conflict",
    });
    assert.equal(
      (await refunds(blocked)).length,
      0,
      "later conflicting event cannot leave earlier refund credit/proof",
    );
    assert.equal(await job(blocked), beforeJob, "conflict creates no wake");
    assert.deepEqual(
      await tx(pool, (db) =>
        recordRelayExactRefundReceiptsInTransaction(db, {
          ...blocked.base,
          evmEvents: blocked.evm,
          transactionReferenceCodec,
        }),
      ),
      result,
      "compatibility apply boundary shares the ownership guard",
    );
    assert.equal(
      (
        await pool.query(
          "select to_jsonb(receipt_row)::text as snapshot from funding_receive_receipts receipt_row where receive_session_id=$1",
          [receive.sessionId],
        )
      ).rows[0].snapshot,
      snapshot,
    );
  }
  console.log(
    "PASS exact refund excludes all five retained receive states/closed sessions/foreign owner/uppercase aliases before any credit/proof/wake",
  );
}

/** Native USDC8 work-bearing publisher uses real commits, original target F
 * and the same exact runtime; no approximate/savepoint-owned transaction. */
export async function verifyExactRefundNativeRuntimePg(
  pool: Pool,
  fixture: () => Promise<Fixture>,
) {
  const data = await fixture();
  assert.equal(data.native, true);
  const statements: string[] = [];
  let beforeQuery: ((sql: string) => Promise<void>) | undefined;
  const traced = Object.create(pool) as Pool;
  traced.query = pool.query.bind(pool);
  traced.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            statements.push(sql);
            await beforeQuery?.(sql);
            return target.query(sql, values);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  const receipts = async (item: Fixture) =>
    (
      await pool.query(
        "select to_jsonb(observation_row)::text as snapshot from funding_observations observation_row where operation_id=$1 and kind='refund_credit' order by id",
        [item.base.operationId],
      )
    ).rows;
  let reads = 0;
  const run = (item: Fixture, indices: number[]) =>
    reconcileRelayExactRefundReceipts(
      traced,
      {
        requestEvidence: async () => assert.fail("unexpected real Relay read"),
      },
      {
        ...item.base,
        work: {
          progressToken: randomUUID(),
          deadlineMs: Date.now() + 30_000,
          limit: 25,
        },
      },
      async () => {
        reads++;
        return {
          kind: "observed",
          request: item.request,
          nativeLedger: indices.map((index) => item.ledger[index]),
          evmEvents: [],
          reason: null,
        };
      },
    );
  assert.deepEqual(await run(data, [0]), {
    kind: "partial",
    inserted: 1,
    reason: "native_ledger_missing",
  });
  assert.deepEqual(await run(data, [1]), {
    kind: "complete",
    inserted: 1,
    reason: null,
  });
  const snapshot = await receipts(data);
  assert.equal(snapshot.length, 2);
  assert.deepEqual(await run(data, [0, 1]), {
    kind: "complete",
    inserted: 0,
    reason: null,
  });
  assert.deepEqual(await receipts(data), snapshot);
  assert.equal(reads, 3, "no native provider re-read within publication");
  assert.equal(
    statements.some((sql) =>
      sql.includes("insert into funding_receive_canonical_events"),
    ),
    false,
    "native ledger never invents an EVM receive key",
  );
  const fences = statements.flatMap((sql, index) =>
    sql.includes("select funding_classification_fence") ? [index] : [],
  );
  assert.equal(fences.length, 3);
  for (const index of fences)
    assert.equal(
      statements[index + 1],
      "commit",
      "original native F immediately COMMIT",
    );

  const stale = await fixture();
  let changed = false;
  beforeQuery = async (sql) => {
    if (!changed && sql.includes("order by id for update")) {
      changed = true;
      await pool.query(
        "update funding_operation_segments set raw_status='pending' where id=$1",
        [stale.base.segmentId],
      );
    }
  };
  assert.deepEqual(await run(stale, [0, 1]), {
    kind: "pending",
    reason: "candidate_facts_changed",
  });
  assert.equal(changed, true);
  assert.equal(
    (await receipts(stale)).length,
    0,
    "stale original F rolls back every native receipt/proof/wake",
  );
  beforeQuery = undefined;
  assert.deepEqual(
    await run(stale, [0, 1]),
    { kind: "complete", inserted: 2, reason: null },
    "ordinary native retry recovers on fresh original facts",
  );
  const expired = await fixture();
  const beforeExpiredReads = reads;
  statements.length = 0;
  assert.deepEqual(
    await reconcileRelayExactRefundReceipts(
      traced,
      { requestEvidence: async () => assert.fail("expired Relay") },
      {
        ...expired.base,
        work: {
          progressToken: randomUUID(),
          deadlineMs: Date.now(),
          limit: 25,
        },
      },
      async () => {
        reads++;
        assert.fail("expired native observer");
      },
    ),
    { kind: "pending", reason: "role_work_budget_exhausted" },
  );
  assert.equal(reads, beforeExpiredReads);
  assert.equal(statements.length, 0);
  assert.equal((await receipts(expired)).length, 0);
  console.log(
    "PASS committed native exact runtime with work: USDC8 partial/complete/replay, original F rollback/recovery, expired budget no effects",
  );
}
