import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import {
  CLAIM_RECEIVE_CLASSIFICATION_RETRIES_SQL,
  RECEIVE_CLASSIFICATION_RETRY_REASONS,
  claimFundingReceiveClassificationRetries,
  fundingReceiveClassificationRetryTarget,
  type FundingReceiveClassificationRetry,
} from "../persistence/funding-receive-session-repository.js";

/** Runs after verifyReceiveCanonicalLocksPg in its session-local temp table.
 * No durable rows, provider traffic, or production EXPLAIN writes. */
export async function verifyReceiveClassificationRetryPg(
  db: Pick<PoolClient, "query">,
) {
  const dueIndex = (
    await db.query(`select pg_get_expr(index_row.indpred,index_row.indrelid) as predicate
      from pg_index index_row
      where index_row.indexrelid='public.funding_receive_classification_due_v5_idx'::regclass
        and index_row.indisvalid`)
  ).rows[0];
  assert.ok(dueIndex, "current retry index must be valid after migration");
  const indexedReasons = [...dueIndex.predicate.matchAll(/'([^']+)'::text/g)]
    .map((match) => match[1])
    .filter((value) => value !== "recovery_required")
    .sort();
  assert.deepEqual(
    indexedReasons,
    [...RECEIVE_CLASSIFICATION_RETRY_REASONS].sort(),
  );
  const now = new Date("2026-10-14T00:10:00Z");
  await db.query(
    `update funding_receive_canonical_events
    set allocation_status='recovery_required',
      allocation_error_code='owned_route_destination_correlation_pending',
      classification_retry_at=$1::timestamptz+interval '1 hour',
      classification_lease_token=gen_random_uuid()
    where allocation_status='pending'
      or allocation_error_code='internal_exact_refund_suppressed'`,
    [now],
  );
  await db.query(
    `insert into funding_receive_canonical_events
    (network_id,asset_id,asset_decimals,destination_address,source_address,raw_amount,
     tx_hash,event_index,ledger_height,block_hash,observed_at,first_observed_at,
     allocation_status,allocation_error_code)
    select 'evm:8453','0x'||repeat('a',40),6,'0x'||repeat('b',40),'0x'||repeat('c',40),1,
      'retry-'||fixture_ordinal,'0',1,'0x'||repeat('d',64),$1::timestamptz,$1::timestamptz-interval '1 hour',
      'recovery_required',($2::text[])[1+(fixture_ordinal % cardinality($2::text[]))]
    from generate_series(1,70) fixture_ordinal`,
    [now, RECEIVE_CLASSIFICATION_RETRY_REASONS],
  );
  await db.query("analyze funding_receive_canonical_events");
  const claimed = new Set<string>();
  for (const expected of [25, 25, 20, 0]) {
    const page = await claimFundingReceiveClassificationRetries(db, {
      now,
      limit: 25,
      retryDelayMs: 1000,
    });
    assert.equal(page.length, expected);
    for (const row of page) {
      assert.ok(
        !claimed.has(row.eventId),
        "unresolved oldest 25 must rotate, not starve the tail",
      );
      assert.equal(row.boundSessionId, null, "a claim cannot invent ownership");
      claimed.add(row.eventId);
    }
  }
  const reclaimed = await claimFundingReceiveClassificationRetries(db, {
    now: new Date(now.getTime() + 1000),
    limit: 25,
    retryDelayMs: 1000,
  });
  assert.equal(
    reclaimed.length,
    25,
    "crashed claims return after their bounded delay",
  );
  assert.ok(reclaimed.every((row) => claimed.has(row.eventId)));
  await db.query("set local plan_cache_mode=force_generic_plan");
  await db.query(
    `prepare receive_retry_due_plan(timestamptz,integer,timestamptz) as ${CLAIM_RECEIVE_CLASSIFICATION_RETRIES_SQL}`,
  );
  const metrics: unknown[] = [];
  for (const [name, date] of [
    ["leased_prefix", "2026-10-14T00:10:01Z"],
    ["empty_due", "2026-10-14T00:00:00Z"],
  ]) {
    const explanation = (
      await db.query(`explain(analyze,buffers,format json)
      execute receive_retry_due_plan('${date}',25,'2026-10-14T00:10:10Z')`)
    ).rows[0]["QUERY PLAN"][0];
    const nodes: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[])
        visit(child);
    };
    visit(explanation.Plan);
    assert.ok(
      !nodes.some((node) => node["Node Type"] === "Seq Scan"),
      "retry claim must not scan the leased/unrelated prefix",
    );
    const blocks =
      Number(explanation.Plan["Local Hit Blocks"] ?? 0) +
      Number(explanation.Plan["Local Read Blocks"] ?? 0);
    assert.ok(
      blocks < 2000,
      "bounded 25-event claim must not read the 50k leased prefix",
    );
    metrics.push({
      name,
      ms: explanation["Execution Time"],
      localBlocks: blocks,
      nodes: nodes.map((node) => ({
        type: node["Node Type"],
        index: node["Index Name"],
        rows: node["Actual Rows"],
      })),
    });
  }
  await db.query("deallocate receive_retry_due_plan");
  return metrics;
}

/** Bound PK and unbound exact-envelope lookup at representative session volume. */
export async function verifyReceiveClassificationSessionLookupPg(
  db: Pick<PoolClient, "query">,
  retry: FundingReceiveClassificationRetry,
) {
  assert.ok(retry.boundSessionId);
  await db.query(
    "create temporary table funding_receive_sessions (like public.funding_receive_sessions including all) on commit drop",
  );
  await db.query(
    "insert into funding_receive_sessions select * from public.funding_receive_sessions where id=$1",
    [retry.boundSessionId],
  );
  await db.query(
    `insert into funding_receive_sessions
    select copied_row.* from funding_receive_sessions template_row
    cross join generate_series(1,50000) fixture_ordinal
    cross join lateral jsonb_populate_record(null::funding_receive_sessions,
      to_jsonb(template_row) || jsonb_build_object('id',gen_random_uuid(),'user_id',gen_random_uuid(),
        'status','completed','closed_at',template_row.opened_at,'observation_start_variants',
          jsonb_set(template_row.observation_start_variants,'{0,destinationAddress}',to_jsonb(md5(fixture_ordinal::text))))) copied_row
    where template_row.id=$1`,
    [retry.boundSessionId],
  );
  await db.query("analyze funding_receive_sessions");
  await db.query("set local plan_cache_mode=force_generic_plan");
  const metrics: unknown[] = [];
  for (const [name, input] of [
    ["bound", retry],
    [
      "unbound-envelope",
      { ...retry, boundSessionId: null, boundVariantId: null },
    ],
    [
      "empty-envelope",
      {
        ...retry,
        boundSessionId: null,
        boundVariantId: null,
        destinationAddress: "missing",
      },
    ],
    [
      "wrong-decimals",
      {
        ...retry,
        boundSessionId: null,
        boundVariantId: null,
        asset: { ...retry.asset, decimals: 5 },
      },
    ],
  ] as const) {
    let sql = "";
    let args: unknown[] = [];
    const target = await fundingReceiveClassificationRetryTarget(
      {
        query: async (query: string, values: unknown[]) => {
          sql = query;
          args = values;
          return db.query(query, values);
        },
      } as never,
      input,
    );
    assert.equal(
      Boolean(target),
      name === "bound" || name === "unbound-envelope",
    );
    const firstType = input.boundSessionId ? "uuid" : "timestamptz";
    await db.query(
      `prepare receive_retry_session_plan(${firstType},text,text,text,text) as ${sql}`,
    );
    const literal = (value: unknown) =>
      `'${(value instanceof Date ? value.toISOString() : String(value)).replaceAll("'", "''")}'`;
    const explanation = (
      await db.query(
        `explain(analyze,buffers,format json) execute receive_retry_session_plan(${args.map(literal).join(",")})`,
      )
    ).rows[0]["QUERY PLAN"][0];
    const nodes: Record<string, unknown>[] = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Record<string, unknown>[])
        visit(child);
    };
    visit(explanation.Plan);
    assert.ok(
      !nodes.some((node) => node["Node Type"] === "Seq Scan"),
      "exact session lookup cannot scan unrelated owners",
    );
    const blocks =
      Number(explanation.Plan["Local Hit Blocks"] ?? 0) +
      Number(explanation.Plan["Local Read Blocks"] ?? 0);
    assert.ok(blocks < 200, "exact tuple must not scan 50k unrelated sessions");
    metrics.push({
      name,
      ms: explanation["Execution Time"],
      localBlocks: blocks,
      nodes: nodes.map((node) => ({
        type: node["Node Type"],
        index: node["Index Name"],
        rows: node["Actual Rows"],
      })),
    });
    await db.query("deallocate receive_retry_session_plan");
  }
  for (const value of [null, {}, 42, [null, {}, 42], { unexpected: true }]) {
    assert.deepEqual(
      (
        await db.query(
          "select funding_receive_start_envelope_keys($1::jsonb) as keys",
          [JSON.stringify(value)],
        )
      ).rows[0].keys,
      [],
    );
  }
  const mixed = {
    networkId: "evm:137",
    asset: { assetId: `0x${"Ab".repeat(20)}`, decimals: 6 },
    destinationAddress: `0x${"Cd".repeat(20)}`,
  };
  const lowered = {
    ...mixed,
    asset: { ...mixed.asset, assetId: mixed.asset.assetId.toLowerCase() },
    destinationAddress: mixed.destinationAddress.toLowerCase(),
  };
  assert.equal(
    (
      await db.query(
        "select funding_receive_start_envelope_keys($1::jsonb)=funding_receive_start_envelope_keys($2::jsonb) as same_keys",
        [JSON.stringify([mixed]), JSON.stringify([lowered])],
      )
    ).rows[0].same_keys,
    true,
  );
  return metrics;
}
