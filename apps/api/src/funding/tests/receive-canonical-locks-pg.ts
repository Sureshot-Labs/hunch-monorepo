import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { REFUND_RECEIVE_ANCHOR_UPDATE_SQL } from "../reconciliation/relay-refund-canonical-watch.js";
import {
  lockFundingReceiveCanonicalEvents,
  quarantineFundingReceiveCanonicalInternalEvent,
} from "../persistence/funding-receive-session-repository.js";

/** Outer HIP suite owns a rollback-only transaction. All benchmark writes and
 * mutating EXPLAINs below target this session-local table, never durable rows. */
export async function verifyReceiveCanonicalLocksPg(
  db: Pick<PoolClient, "query">,
) {
  await db.query(
    "create temporary table funding_receive_canonical_events (like public.funding_receive_canonical_events including all) on commit drop",
  );
  await db.query(`insert into funding_receive_canonical_events
    (network_id,asset_id,asset_decimals,destination_address,source_address,raw_amount,
     tx_hash,event_index,ledger_height,block_hash,observed_at)
    select 'evm:8453','0x'||repeat('a',40),6,'0x'||repeat('b',40),'0x'||repeat('c',40),1,
      '0x'||md5(fixture_ordinal::text)||md5(fixture_ordinal::text),'0',1,'0x'||repeat('d',64),now()
    from generate_series(1,50000) fixture_ordinal`);
  await db.query("analyze funding_receive_canonical_events");
  const event = {
    networkId: "evm:8453",
    asset: {
      networkId: "evm:8453",
      assetId: `0x${"a".repeat(40)}`,
      decimals: 6,
    },
    destinationAddress: `0x${"b".repeat(40)}`,
    sourceAddress: `0x${"c".repeat(40)}`,
    rawAmount: "1",
    transactionHash: `0x${"e".repeat(64)}`,
    eventIndex: "0",
    ledgerHeight: "1",
    blockHash: `0x${"d".repeat(64)}`,
    observedAt: new Date("2026-10-14T00:00:00Z"),
    now: new Date("2026-10-14T00:00:01Z"),
  };
  let actualSql = "";
  let actualArgs: readonly unknown[] = [];
  await lockFundingReceiveCanonicalEvents(
    {
      query: async (sql: string, args: unknown[]) => {
        actualSql = sql;
        actualArgs = args;
        return db.query(sql, args);
      },
    } as never,
    [event, event],
  );
  assert.ok(actualSql);
  assert.equal(
    await quarantineFundingReceiveCanonicalInternalEvent(db, {
      ...event,
      reason: "internal_exact_refund_suppressed",
    }),
    true,
  );
  await lockFundingReceiveCanonicalEvents(db, [event]);
  const row = await db.query(
    "select allocation_status,allocation_error_code,allocated_receipt_id from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
    [event.networkId, event.transactionHash, event.eventIndex],
  );
  assert.deepEqual(row.rows, [
    {
      allocation_status: "recovery_required",
      allocation_error_code: "internal_exact_refund_suppressed",
      allocated_receipt_id: null,
    },
  ]);
  await assert.rejects(
    lockFundingReceiveCanonicalEvents(db, [{ ...event, rawAmount: "2" }]),
    /identity collision/,
  );

  const literal = (value: unknown): string =>
    value === null
      ? "null"
      : typeof value === "number"
        ? String(value)
        : `'${(value instanceof Date ? value.toISOString() : String(value)).replaceAll("'", "''")}'`;
  await db.query("set local plan_cache_mode=force_generic_plan");
  await db.query(
    `prepare canonical_prelock_plan(text,text,integer,text,text,numeric,text,text,numeric,text,timestamptz,text,timestamptz) as ${actualSql}`,
  );
  const metrics: unknown[] = [];
  for (const hit of [false, true]) {
    const args = [...actualArgs];
    args[6] = hit ? event.transactionHash : `0x${"f".repeat(64)}`;
    const explanation = (
      await db.query(
        `explain(analyze,buffers,format json) execute canonical_prelock_plan(${args.map(literal).join(",")})`,
      )
    ).rows[0]["QUERY PLAN"][0];
    const plan = explanation.Plan;
    assert.equal(plan["Node Type"], "ModifyTable");
    assert.equal(plan["Tuples Inserted"], hit ? 0 : 1);
    assert.equal(plan["Conflicting Tuples"], hit ? 1 : 0);
    assert.equal(plan["Conflict Arbiter Indexes"].length, 1);
    assert.equal(plan.Plans.length, 1);
    assert.equal(plan.Plans[0]["Node Type"], "Result");
    assert.equal(plan.Plans[0]["Actual Rows"], 1);
    const blocks =
      Number(plan["Local Hit Blocks"] ?? 0) +
      Number(plan["Local Read Blocks"] ?? 0);
    assert.ok(
      blocks < 100,
      "single-key upsert must not scan 50k unrelated canonical events",
    );
    metrics.push({
      mode: hit ? "replay" : "insert",
      ms: explanation["Execution Time"],
      localBlocks: blocks,
      arbiter: plan["Conflict Arbiter Indexes"],
    });
  }
  await db.query("deallocate canonical_prelock_plan");
  let transitionSql = "";
  let transitionArgs: unknown[] = [];
  for (const reason of [
    "exact_refund_receipt_not_final",
    "exact_refund_receipt_conflict",
    "internal_event_classification_conflict",
  ]) {
    assert.equal(
      await quarantineFundingReceiveCanonicalInternalEvent(
        {
          query: async (sql: string, args: unknown[]) => {
            if (
              sql
                .trimStart()
                .startsWith("update funding_receive_canonical_events")
            ) {
              transitionSql = sql;
              transitionArgs = args;
            }
            return db.query(sql, args);
          },
        } as never,
        { ...event, reason },
      ),
      true,
    );
    assert.equal(
      await quarantineFundingReceiveCanonicalInternalEvent(db, {
        ...event,
        reason: "internal_exact_refund_suppressed",
      }),
      true,
    );
  }
  assert.equal(
    await quarantineFundingReceiveCanonicalInternalEvent(db, {
      ...event,
      reason: "handoff_correlation_pending",
    }),
    false,
    "an unrelated pending role cannot erase exact refund suppression",
  );
  assert.ok(transitionSql);
  // Most real audit rows may already be suppressed rather than pending. A
  // generic anchor plan must still use exact identity, not scan that state.
  await db.query(`update funding_receive_canonical_events
    set allocation_status='recovery_required',
      allocation_error_code='internal_exact_refund_suppressed'
    where allocation_status='pending'`);
  await db.query("analyze funding_receive_canonical_events");
  await db.query(
    `prepare recorded_refund_retry_plan(uuid,text,timestamptz,boolean) as ${transitionSql}`,
  );
  await db.query(
    `prepare recorded_refund_anchor_plan(text,text,text,numeric,text) as ${REFUND_RECEIVE_ANCHOR_UPDATE_SQL}`,
  );
  for (const [name, planArgs] of [
    ["recorded_refund_retry_plan", transitionArgs],
    [
      "recorded_refund_anchor_plan",
      [
        event.networkId,
        event.transactionHash,
        event.eventIndex,
        event.ledgerHeight,
        event.blockHash,
      ],
    ],
  ] as const) {
    for (const hit of [true, false]) {
      const args = [...planArgs];
      if (!hit)
        args[name === "recorded_refund_retry_plan" ? 0 : 1] =
          name === "recorded_refund_retry_plan"
            ? "00000000-0000-0000-0000-000000000000"
            : "missing-hash";
      const explanation = (
        await db.query(
          `explain(analyze,buffers,format json) execute ${name}(${args.map(literal).join(",")})`,
        )
      ).rows[0]["QUERY PLAN"][0];
      const nodes: Record<string, unknown>[] = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          visit(child);
      };
      visit(explanation.Plan);
      assert.ok(!nodes.some((node) => node["Node Type"] === "Seq Scan"));
      const index = nodes.find((node) => node["Node Type"] === "Index Scan");
      assert.ok(index);
      assert.equal(index["Actual Rows"], hit ? 1 : 0);
      const blocks =
        Number(explanation.Plan["Local Hit Blocks"] ?? 0) +
        Number(explanation.Plan["Local Read Blocks"] ?? 0);
      assert.ok(
        blocks < 100,
        "refund retry/remine must address one physical row, not scan 50k others",
      );
      metrics.push({
        mode: `${name}:${hit ? "hit" : "empty"}`,
        ms: explanation["Execution Time"],
        localBlocks: blocks,
        index: index["Index Name"],
      });
    }
    await db.query(`deallocate ${name}`);
  }
  // The next fixture enumerates exactly its 70 due events in this same TEMP
  // table. Do not leave the EXPLAIN's synthetic pending row in that queue.
  assert.equal(
    await quarantineFundingReceiveCanonicalInternalEvent(db, {
      ...event,
      reason: "internal_exact_refund_suppressed",
    }),
    true,
  );
  return metrics;
}
