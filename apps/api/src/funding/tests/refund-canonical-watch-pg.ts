import assert from "node:assert/strict";
import type { Pool, PoolClient } from "pg";
import {
  pollRelayRefundCanonicalWatch,
  REFUND_CANONICAL_PAGE_SQL,
  REFUND_CANONICAL_LOCK_SQL,
  exactRefundWatchPending,
  type RefundWatchRow,
} from "../reconciliation/relay-refund-canonical-watch.js";
import { persistRefundCanonicalProofsFixture as persistRefundCanonicalProofs } from "./refund-canonical-effects-fixture.js";
import {
  pollFundingReconciliationEvidence,
  runFundingReconciliationBatch,
} from "../reconciliation/funding-reducer.js";
import { listFundingObservationsForOperation } from "../persistence/funding-operation-repository.js";

/** Runs inside the HIP fixture transaction and rolls back its own mutations. */
export async function verifyRefundCanonicalWatchPg(
  db: Pick<PoolClient, "query">,
  pool: Pool,
  input: { operationId: string; segmentId: string; now: Date; native: boolean },
) {
  await db.query("savepoint exact_refund_watch");
  try {
    const rows = () =>
      db.query<RefundWatchRow>(REFUND_CANONICAL_PAGE_SQL, [
        input.operationId,
        "00000000-0000-0000-0000-000000000000",
        25,
      ]);
    const before = (await rows()).rows;
    const rowForId = async (id: string) => {
      const row = (await rows()).rows.find(
        (item) => JSON.parse(item.receipt_snapshot).id === id,
      );
      assert.ok(row);
      return row;
    };
    assert.equal(before.length, 2);
    const late = new Date(input.now.getTime() + 20 * 60_000);
    let calls = 0;
    const run = (failFirst = false) =>
      pollRelayRefundCanonicalWatch(
        pool,
        { ...input, now: late, limit: 1 },
        async (target) => {
          if (failFirst && calls++ === 0)
            return { kind: "pending", reason: "offline_rpc" };
          return {
            kind: "canonical",
            ledgerHeight: target.ledgerHeight,
            blockHash: target.blockHash,
          };
        },
      );
    const state = async () =>
      (
        await db.query(
          "select support_metadata from funding_operations where id=$1",
          [input.operationId],
        )
      ).rows[0].support_metadata;
    assert.equal((await run(true)).pending, true);
    assert.equal((await run()).pending, true);
    assert.equal(
      (await run()).pending,
      true,
      "successful empty tail must retain earlier outage",
    );
    assert.equal(exactRefundWatchPending(await state()), true);
    assert.equal((await run()).pending, true);
    assert.equal((await run()).pending, true);
    assert.equal(
      (await run()).pending,
      false,
      "fresh full successful sweep clears outage after watch window",
    );
    assert.equal(exactRefundWatchPending(await state()), false);
    // One native admission per pass with page size 25: denied B resumes after
    // A, not after the whole page and not from A again on every retry.
    const seen: string[] = [];
    for (let pass = 0; pass < 2; pass++) {
      let allowed = 1;
      const result = await pollRelayRefundCanonicalWatch(
        pool,
        { ...input, now: late, limit: 25 },
        async (target) => {
          if (!allowed--)
            return { kind: "pending", reason: "refund_watch_budget_exhausted" };
          seen.push(target.txHash);
          return {
            kind: "canonical",
            ledgerHeight: target.ledgerHeight,
            blockHash: target.blockHash,
          };
        },
      );
      assert.equal(result.pending, pass === 0);
    }
    assert.equal(new Set(seen).size, 2);
    let clock = 0;
    let inspected = 0;
    const timed = await pollRelayRefundCanonicalWatch(
      pool,
      { ...input, now: late, limit: 25, deadlineMs: 5 },
      async (target) => {
        inspected++;
        clock = 5;
        return {
          kind: "canonical",
          ledgerHeight: target.ledgerHeight,
          blockHash: target.blockHash,
        };
      },
      () => clock,
    );
    assert.equal(timed.pending, true);
    assert.equal(
      inspected,
      1,
      "no second RPC starts after this pass's lease-derived deadline",
    );
    assert.equal(
      (
        await pollRelayRefundCanonicalWatch(
          pool,
          { ...input, now: late, limit: 25 },
          async (target) => ({
            kind: "canonical",
            ledgerHeight: target.ledgerHeight,
            blockHash: target.blockHash,
          }),
        )
      ).pending,
      false,
    );
    const stale = before[0];
    const expected = JSON.parse(stale.receipt_snapshot);
    await db.query(
      "update funding_observations set metadata=metadata || '{\"concurrentDiagnostic\":true}'::jsonb where id=$1",
      [expected.id],
    );
    assert.deepEqual(
      await persistRefundCanonicalProofs(db, {
        ...input,
        rows: [{ row: stale, proof: { kind: "reorged" } }],
      }),
      { changed: 0, stale: true },
      "stale RPC observation cannot overwrite newer facts",
    );
    let current = await rowForId(expected.id);
    assert.equal(
      (
        await persistRefundCanonicalProofs(db, {
          ...input,
          rows: [{ row: current, proof: { kind: "reorged" } }],
        })
      ).changed,
      1,
    );
    current = await rowForId(expected.id);
    const moved = input.native
      ? { ledgerHeight: null, blockHash: null }
      : { ledgerHeight: "234", blockHash: `0x${"ab".repeat(32)}` };
    assert.equal(
      (
        await persistRefundCanonicalProofs(db, {
          ...input,
          now: late,
          rows: [{ row: current, proof: { kind: "canonical", ...moved } }],
        })
      ).changed,
      1,
    );
    const restored = JSON.parse((await rowForId(expected.id)).receipt_snapshot);
    assert.equal(restored.id, expected.id);
    assert.equal(restored.raw_amount, expected.raw_amount);
    assert.equal(restored.finality_status, "finalized");
    assert.equal(restored.canonical, true);
    assert.deepEqual(
      restored.metadata.relayRefundCompletionProofs,
      expected.metadata.relayRefundCompletionProofs,
    );
    assert.equal(restored.metadata.exactRefundCanonicalityHistory.length, 1);
    assert.deepEqual(
      await persistRefundCanonicalProofs(db, {
        ...input,
        rows: [{ row: current, proof: { kind: "reorged" } }],
      }),
      { changed: 0, stale: true },
      "RPC started before another watcher's remine cannot retract the new anchor",
    );
    const afterRace = await rowForId(expected.id);
    assert.deepEqual(
      await persistRefundCanonicalProofs(db, {
        ...input,
        rows: [{ row: afterRace, proof: { kind: "canonical", ...moved } }],
      }),
      { changed: 0, stale: false },
      "ordinary re-read recovers from stale-anchor race without manual repair",
    );
    if (!input.native) {
      assert.deepEqual(
        (
          await db.query(
            `select ledger_height::text, block_hash, allocation_status, allocation_error_code
        from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3`,
            [restored.network_id, restored.tx_hash, restored.event_index],
          )
        ).rows[0],
        {
          ledger_height: moved.ledgerHeight,
          block_hash: moved.blockHash,
          allocation_status: "recovery_required",
          allocation_error_code: "internal_exact_refund_suppressed",
        },
      );
    }
    assert.equal(
      (await listFundingObservationsForOperation(db, input.operationId)).filter(
        (row) => row.kind === "refund_credit",
      ).length,
      2,
    );
    // Real poll composition must still inspect local proof when Relay is down.
    let watched = 0;
    await pollFundingReconciliationEvidence({
      operationId: input.operationId,
      now: late,
      state: { status: "refunded", stage: "terminal" },
      terminalRelayRefundWatch: true,
      providerPoll: async () => {
        throw new Error("offline Relay");
      },
      refundCanonicalPoll: async () => {
        watched++;
        await pollRelayRefundCanonicalWatch(
          pool,
          { ...input, now: late, limit: 25 },
          async (target) => ({
            kind: "canonical",
            ledgerHeight: target.ledgerHeight,
            blockHash: target.blockHash,
          }),
        );
        return { checked: 2 };
      },
    });
    assert.equal(watched, 1);
    // Actual leased reducer, beyond the terminal watch window, no Relay client.
    // Only this synthetic job is prioritized; all effects roll back below.
    const muchLater = new Date(input.now.getTime() + 60 * 60_000);
    await pollRelayRefundCanonicalWatch(
      pool,
      { ...input, now: muchLater, limit: 1 },
      async () => ({ kind: "pending", reason: "offline_rpc" }),
    );
    await db.query(
      `update funding_reconciliation_jobs set status='scheduled',priority=2147483647,
      due_at='1900-01-01',lease_owner=null,lease_token=null,lease_until=null,completed_at=null
      where operation_id=$1`,
      [input.operationId],
    );
    const batch = await runFundingReconciliationBatch(pool, {
      workerId: "exact-refund-watch-offline",
      limit: 1,
      concurrency: 1,
      now: muchLater,
      receiptPoll: async () => {
        throw new Error("source RPC unavailable");
      },
      refundCanonicalPoll: async (operationId) => {
        assert.equal(operationId, input.operationId);
        await pollRelayRefundCanonicalWatch(
          pool,
          { operationId, now: muchLater, limit: 1 },
          async () => ({ kind: "pending", reason: "offline_rpc" }),
        );
        return { checked: 1 };
      },
    });
    assert.deepEqual(batch.operationIds, [input.operationId]);
    assert.equal(batch.deadLettered, 0);
    assert.equal(batch.completed, 0);
    assert.equal(batch.requeued, 1);
    assert.equal(exactRefundWatchPending(await state()), true);
    await db.query("savepoint refund_watch_source_reorg");
    try {
      const attempt = (
        await db.query<{ id: string; step_id: string }>(
          `insert into funding_operation_step_attempts
          (step_id,attempt_number,canonical_action_fingerprint,executor_id,outcome,
           broadcast_may_have_occurred,actual_costs,started_at,finished_at)
         select step_row.id,
           coalesce((select max(attempt_number) from funding_operation_step_attempts
             where step_id=step_row.id),0)+1,
           step_row.action_fingerprint,step_row.executor_id,'ambiguous',true,'{}'::jsonb,$2,$2
         from funding_operation_steps step_row where step_row.operation_id=$1
         order by step_row.ordinal limit 1 returning id,step_id`,
          [input.operationId, input.now],
        )
      ).rows[0];
      assert.ok(attempt);
      await db.query(
        `insert into funding_step_receipt_observations
          (operation_id,step_id,attempt_id,network_id,status,action_match,canonical,
           first_seen_at,observed_at,reorged_at,evidence)
         values($1,$2,$3,$4,'reorged',true,false,$5,$5,$5,'{}'::jsonb)`,
        [
          input.operationId,
          attempt.step_id,
          attempt.id,
          expected.network_id,
          input.now,
        ],
      );
      const runReorg = async () => {
        await db.query(
          "update funding_reconciliation_jobs set due_at='1900-01-01' where operation_id=$1",
          [input.operationId],
        );
        return runFundingReconciliationBatch(pool, {
          workerId: "refund-watch-source-reorg",
          limit: 1,
          concurrency: 1,
          now: muchLater,
          receiptPoll: async () => ({ receiptsPolled: 0 }),
        });
      };
      const reorgPending = await runReorg();
      assert.equal(
        reorgPending.requeued,
        1,
        "source reorg timeout must not dead-letter unresolved exact refund verification",
      );
      assert.equal(reorgPending.deadLettered, 0);
      await db.query(
        `update funding_operations set version=version+1,
           support_metadata=support_metadata-'exactRefundCanonicalWatch' where id=$1`,
        [input.operationId],
      );
      const reorgWithoutWatch = await runReorg();
      assert.equal(
        reorgWithoutWatch.deadLettered,
        1,
        "legacy source-reorg incident stop remains intact without pending exact watch",
      );
    } finally {
      await db.query("rollback to savepoint refund_watch_source_reorg");
    }
    // Generic plans: lots of same-operation legacy receipts must not be filtered
    // before the page boundary. Every row remains reachable by immutable id.
    // One synthetic transaction with distinct log indices preserves 50k real
    // physical keys/index rows without reserving 50k additional transaction
    // gates inside this rollback-only plan fixture. Runtime batches remain
    // policy-bounded; do not raise server lock memory to seed this fixture.
    await db.query(
      `insert into funding_observations(operation_id,segment_id,kind,network_id,asset_id,asset_decimals,
      tx_hash,event_index,to_address,raw_amount,observed_at,finality_status,canonical,finalized_at,metadata)
      select $1::uuid,$2::uuid,'refund_credit','evm:8453','0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',6,
        '0x'||repeat(md5('watch-fixture-'||$1::text),2),source_row::text,'0x${"12".repeat(20)}','1',now(),'finalized',true,now(),'{}'::jsonb
      from generate_series(1,50000) source_row`,
      [input.operationId, input.segmentId],
    );
    await db.query("analyze funding_observations");
    if (!input.native) {
      await db.query(
        `insert into funding_receive_canonical_events
        (network_id,asset_id,asset_decimals,destination_address,source_address,raw_amount,
         tx_hash,event_index,ledger_height,block_hash,observed_at,allocation_status,first_observed_at,last_observed_at)
        select network_id,asset_id,asset_decimals,to_address,'0x${"34".repeat(20)}',raw_amount::numeric,
          tx_hash,event_index,100,'0x${"56".repeat(32)}',observed_at,'pending',observed_at,observed_at
        from funding_observations where operation_id=$1 and kind='refund_credit' and metadata='{}'::jsonb`,
        [input.operationId],
      );
      await db.query("analyze funding_receive_canonical_events");
      for (const txHash of [restored.tx_hash, `0x${"01".repeat(32)}`]) {
        const plan = (
          await db.query(
            `explain (analyze,buffers,format json) ${REFUND_CANONICAL_LOCK_SQL}`,
            [
              restored.network_id,
              txHash,
              restored.event_index,
              restored.asset_id,
              restored.asset_decimals,
              restored.raw_amount,
              restored.from_address,
              restored.to_address,
              moved.ledgerHeight,
              moved.blockHash,
            ],
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.ok(JSON.stringify(plan).includes("Index Scan"));
        assert.ok(!JSON.stringify(plan).includes("Seq Scan"));
        assert.equal(
          plan.Plan["Actual Rows"],
          txHash === restored.tx_hash ? 1 : 0,
        );
        console.log(
          "[refund-watch-prelock]",
          JSON.stringify({
            hit: txHash === restored.tx_hash,
            ms: plan["Execution Time"],
            buffers:
              plan.Plan["Shared Hit Blocks"] + plan.Plan["Local Hit Blocks"],
          }),
        );
      }
    }
    await db.query("set local plan_cache_mode=force_generic_plan");
    await db.query(
      `prepare exact_refund_watch_page(uuid,uuid,integer) as ${REFUND_CANONICAL_PAGE_SQL}`,
    );
    try {
      const middle = (
        await db.query(
          "select id from funding_observations where operation_id=$1 and kind='refund_credit' order by id offset 25000 limit 1",
          [input.operationId],
        )
      ).rows[0].id;
      for (const after of [
        "00000000-0000-0000-0000-000000000000",
        middle,
        "ffffffff-ffff-ffff-ffff-ffffffffffff",
      ]) {
        const plan = (
          await db.query(
            `explain (analyze,buffers,format json) execute exact_refund_watch_page('${input.operationId}','${after}',25)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const json = JSON.stringify(plan);
        assert.ok(json.includes("funding_observations_operation_kind_id_idx"));
        const nodes: Record<string, unknown>[] = [];
        const walk = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            walk(child);
        };
        walk(plan.Plan);
        assert.ok(
          !nodes.some(
            (node) =>
              node["Node Type"] === "Seq Scan" &&
              node["Relation Name"] === "funding_observations",
          ),
          json,
        );
        console.log(
          "[refund-watch-page]",
          JSON.stringify({
            after:
              after === middle
                ? "resumed"
                : after.startsWith("0")
                  ? "first"
                  : "empty",
            ms: plan["Execution Time"],
            rows: plan.Plan["Actual Rows"],
            buffers:
              plan.Plan["Shared Hit Blocks"] + plan.Plan["Local Hit Blocks"],
          }),
        );
      }
    } finally {
      await db.query("deallocate exact_refund_watch_page");
    }
  } finally {
    await db.query("rollback to savepoint exact_refund_watch");
  }
}
