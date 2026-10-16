import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx, type Pool } from "@hunch/infra";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { recordRelayExactRefundReceiptsInTransaction } from "../reconciliation/relay-exact-refund-receipts.js";
import { pollRelayRefundCanonicalWatch } from "../reconciliation/relay-refund-canonical-watch.js";
import {
  REFUND_CANONICAL_RECEIPT_SQL,
  REFUND_CANONICAL_PAGE_SQL,
  refundWatchFacts,
  type RefundWatchRow,
} from "../reconciliation/relay-refund-watch-context.js";
import { publishRefundCanonicalRestoration } from "../reconciliation/relay-refund-watch-publication.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { verifyRefundWatchPlansPg } from "./refund-watch-plans-pg.js";
import { FundingClassificationChangedError } from "../persistence/funding-classification-revisions.js";
import {
  prelockOwnedRefundEvents,
  readProtectedRecordedRefundRoleProof,
  recordedRefundRoleEvent,
} from "../reconciliation/relay-owned-refund-ownership.js";
import { restoreArbitratedRefundCanonicalProof } from "../reconciliation/relay-refund-watch-effects.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

/** Actual committed watch/protection/derived/publication transactions. Only
 * immutable chain responses are injected, never role decisions or authority. */
export async function verifyRefundWatchPublicationPg(
  pool: Pool,
  fixture: () => Promise<Fixture>,
) {
  const transactionReferenceCodec = createFundingTransactionReferenceCodec({
    encryptionKey: Buffer.alloc(32, 91),
    lookupHmacKey: "offline-canonical-watch-role-work",
    keyVersion: 1,
  });
  const seed = async () => {
    const data = await fixture();
    assert.equal(data.native, false);
    const result = await tx(pool, (db) =>
      recordRelayExactRefundReceiptsInTransaction(db, {
        ...data.base,
        evmEvents: data.evm,
      }),
    );
    assert.equal(result.kind, "complete");
    return data;
  };
  const rows = async (data: Fixture) =>
    (
      await pool.query<RefundWatchRow>(REFUND_CANONICAL_PAGE_SQL, [
        data.base.operationId,
        "00000000-0000-0000-0000-000000000000",
        10,
      ])
    ).rows;
  const row = async (data: Fixture) => {
    const found = (await rows(data)).find(
      (item) => JSON.parse(item.receipt_snapshot).tx_hash === data.hashes[0],
    );
    assert.ok(found);
    return found;
  };
  const publication = (data: Fixture, limit = 50) => ({
    work: {
      progressToken: randomUUID(),
      deadlineMs: Date.now() + 30_000,
      limit,
    },
    referenceCodec: data.base.referenceCodec,
    transactionReferenceCodec,
  });
  const anchor = { ledgerHeight: "150", blockHash: `0x${"cd".repeat(32)}` };
  const inspect =
    (data: Fixture) =>
    async (target: {
      txHash: string;
      ledgerHeight: string | null;
      blockHash: string | null;
    }) => ({
      kind: "canonical" as const,
      ...(target.txHash === data.hashes[0]
        ? anchor
        : { ledgerHeight: target.ledgerHeight, blockHash: target.blockHash }),
    });
  const run = (data: Fixture, db = pool, limit = 50) =>
    pollRelayRefundCanonicalWatch(
      db,
      {
        operationId: data.base.operationId,
        now: new Date(),
        limit: 10,
        publication: publication(data, limit),
      },
      inspect(data),
    );
  const drain = async (data: Fixture, db = pool, limit = 50) => {
    for (let tick = 0; tick < 100; tick++) {
      const result = await run(data, db, limit);
      const receipt = JSON.parse((await row(data)).receipt_snapshot);
      if (receipt.canonical && receipt.ledger_height === anchor.ledgerHeight)
        return result;
    }
    assert.fail("ordinary watch role ticks did not restore recorded refund");
  };
  const data = await seed();
  await pool.query(
    `update funding_receive_canonical_events set allocation_error_code='exact_refund_correlation_pending'
    where network_id=$1 and tx_hash=$2 and event_index=$3`,
    [
      data.evm[0].networkId,
      data.evm[0].transactionHash,
      data.evm[0].eventIndex,
    ],
  );
  const statements: string[] = [];
  const traced = Object.create(pool) as Pool;
  traced.query = pool.query.bind(pool);
  traced.connect = (async () => {
    const db = await pool.connect();
    return new Proxy(db, {
      get(target, name) {
        if (name === "query")
          return async (sql: string, args: unknown[]) => {
            statements.push(sql);
            return target.query(sql, args);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  await drain(data, traced, 1);
  const restored = JSON.parse((await row(data)).receipt_snapshot);
  assert.equal(restored.metadata.exactRefundCanonicalityHistory.length, 1);
  assert.equal(restored.raw_amount, data.evm[0].rawAmount);
  assert.equal(restored.tx_hash, data.hashes[0]);
  assert.equal((await rows(data)).length, 2);
  assert.equal(
    (await run(data)).pending,
    false,
    "ordinary full sweep clears diagnostic pending after immediate restore",
  );
  await pool.query(
    `update funding_receive_canonical_events set allocation_error_code='exact_refund_receipt_not_final'
    where network_id=$1 and tx_hash=$2 and event_index=$3`,
    [
      data.evm[0].networkId,
      data.evm[0].transactionHash,
      data.evm[0].eventIndex,
    ],
  );
  const pendingProtection = await pollRelayRefundCanonicalWatch(
    pool,
    {
      operationId: data.base.operationId,
      now: new Date(),
      limit: 10,
    },
    async () => ({ kind: "pending", reason: "offline_rpc" }),
  );
  assert.equal(pendingProtection.pending, true);
  assert.equal(
    JSON.parse((await row(data)).receipt_snapshot).canonical,
    true,
    "pending RPC does not retract known canonical receipt",
  );
  assert.equal(
    (
      await pool.query(
        `select allocation_error_code from funding_receive_canonical_events
    where network_id=$1 and tx_hash=$2 and event_index=$3`,
        [
          data.evm[0].networkId,
          data.evm[0].transactionHash,
          data.evm[0].eventIndex,
        ],
      )
    ).rows[0].allocation_error_code,
    "exact_refund_receipt_not_final",
    "pending RPC retains protected recovery and its independent retry",
  );
  await pool.query(
    `update funding_receive_canonical_events set allocation_error_code='exact_refund_receipt_not_final'
    where network_id=$1 and tx_hash=any($2::text[])`,
    [data.evm[0].networkId, data.hashes],
  );
  const budgetProtection = await pollRelayRefundCanonicalWatch(
    pool,
    {
      operationId: data.base.operationId,
      now: new Date(),
      limit: 10,
    },
    async () => ({ kind: "pending", reason: "refund_watch_budget_exhausted" }),
  );
  assert.deepEqual(budgetProtection, { checked: 0, changed: 0, pending: true });
  assert.ok(
    (
      await pool.query(
        `select allocation_error_code from funding_receive_canonical_events
    where network_id=$1 and tx_hash=any($2::text[])`,
        [data.evm[0].networkId, data.hashes],
      )
    ).rows.every(
      (item) => item.allocation_error_code === "exact_refund_receipt_not_final",
    ),
    "budget denial protects the bounded page without skipping verification",
  );
  for (let index = 0; index < statements.length; index++)
    if (statements[index].includes("select funding_classification_fence"))
      assert.equal(
        statements[index + 1],
        "commit",
        "raw final F immediately precedes COMMIT",
      );
  assert.ok(
    statements.filter((sql) => sql === "commit").length > 2,
    "limit-one checkpoints use real commits",
  );
  console.log(
    "PASS canonical watch committed retraction, limit-one joint restoration, replay, original F/COMMIT and no duplicate receipts",
  );

  const stale = await seed();
  let injected = false;
  const stalePool = Object.create(pool) as Pool;
  stalePool.connect = pool.connect.bind(pool);
  stalePool.query = (async (sql: string, args: unknown[]) => {
    if (sql === REFUND_CANONICAL_RECEIPT_SQL && args[2] && !injected) {
      injected = true;
      const expected = JSON.parse(String(args[2]));
      await pool.query(
        `update funding_observations set metadata=metadata||'{"afterProtectionRace":true}'::jsonb where id=$1`,
        [expected.id],
      );
    }
    return pool.query(sql, args);
  }) as Pool["query"];
  assert.equal((await run(stale, stalePool)).pending, true);
  assert.equal(injected, true);
  const protectedRow = await row(stale);
  assert.equal(
    JSON.parse(protectedRow.receipt_snapshot).canonical,
    false,
    "post-protection receipt race cannot graft old proof",
  );
  // A stale captured row cannot be used even with a fresh work token.
  const staleSnapshot = JSON.parse(protectedRow.receipt_snapshot);
  delete staleSnapshot.metadata.afterProtectionRace;
  const older = {
    ...protectedRow,
    receipt_snapshot: JSON.stringify(staleSnapshot),
  };
  assert.deepEqual(
    await publishRefundCanonicalRestoration(pool, {
      operationId: stale.base.operationId,
      row: older,
      canonical: { kind: "canonical", ...anchor },
      now: new Date(),
      publication: publication(stale),
    }),
    { changed: false, reason: "refund_watch_snapshot_changed" },
  );
  await tx(pool, async (db) => {
    const previous = recordedRefundRoleEvent(
      protectedRow.receipt_snapshot,
      new Date(),
    );
    assert.ok(previous);
    const physical = await prelockOwnedRefundEvents(db, previous, {
      ...previous,
      ...anchor,
    });
    const receipt = JSON.parse(protectedRow.receipt_snapshot);
    const proof = await readProtectedRecordedRefundRoleProof(db, {
      locked: physical,
      receiptSnapshot: protectedRow.receipt_snapshot,
      operationId: stale.base.operationId,
      segmentId: receipt.segment_id,
      facts: refundWatchFacts(protectedRow, stale.base.operationId),
    });
    assert.ok(proof);
    assert.equal(
      await restoreArbitratedRefundCanonicalProof(db, {
        operationId: stale.base.operationId,
        row: protectedRow,
        now: new Date(),
        physical,
        proof,
        canonical: {
          kind: "canonical",
          ledgerHeight: "999",
          blockHash: `0x${"ef".repeat(32)}`,
        },
        classification: {
          kind: "internal_refund",
          match: {
            kind: "internal",
            operationId: stale.base.operationId,
            segmentId: receipt.segment_id,
          },
        },
      }),
      false,
      "a genuine protected proof for B cannot authorize writing C",
    );
  });
  assert.equal(
    JSON.parse((await row(stale)).receipt_snapshot).canonical,
    false,
  );
  await drain(stale);
  console.log(
    "PASS watch exact post-protection receipt CAS and ordinary fresh-chain recovery",
  );
  // A rolled-back protection/F conflict must ESCAPE to the existing worker's
  // error/requeue path: a return-only pending would be lost at terminal cutoff.
  const fenceRace = await seed();
  const originalStatus = (
    await pool.query(
      "select raw_status from funding_operation_segments where id=$1",
      [fenceRace.base.segmentId],
    )
  ).rows[0].raw_status;
  const racePool = Object.create(pool) as Pool;
  racePool.query = pool.query.bind(pool);
  let raced = false;
  racePool.connect = (async () => {
    const db = await pool.connect();
    return new Proxy(db, {
      get(target, name) {
        if (name === "query")
          return async (sql: string, args: unknown[]) => {
            if (!raced && sql.includes("select funding_classification_fence")) {
              raced = true;
              await pool.query(
                "update funding_operation_segments set raw_status=$2 where id=$1",
                [
                  fenceRace.base.segmentId,
                  originalStatus === "pending" ? "refund" : "pending",
                ],
              );
            }
            return target.query(sql, args);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  await assert.rejects(
    run(fenceRace, racePool),
    FundingClassificationChangedError,
  );
  assert.equal(raced, true);
  assert.equal(
    JSON.parse((await row(fenceRace)).receipt_snapshot).canonical,
    true,
    "failed protection rolls back retraction",
  );
  const failedCursor = (
    await pool.query(
      "select support_metadata->'exactRefundCanonicalWatch' as watch from funding_operations where id=$1",
      [fenceRace.base.operationId],
    )
  ).rows[0].watch;
  assert.equal(
    failedCursor,
    null,
    "there is no durable pending cursor after failed F",
  );
  await pool.query(
    "update funding_operation_segments set raw_status=$2 where id=$1",
    [fenceRace.base.segmentId, originalStatus],
  );
  await drain(fenceRace);
  console.log(
    "PASS protection original-F conflict propagates rather than losing return-only pending; ordinary retry recovers",
  );
  await verifyRefundWatchPlansPg(pool, data.base.operationId);
}
