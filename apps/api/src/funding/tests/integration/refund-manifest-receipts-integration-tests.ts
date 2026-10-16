// @requires-db — rollback-only, explicitly selected disposable PostgreSQL 16.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createIntegrationTestPool } from "../../../test-database-target.js";
import {
  FUNDING_REFUND_MANIFEST_RECEIPTS_SQL,
  FUNDING_REFUND_OUTSIDE_PROOF_SQL,
  FUNDING_CURRENT_REFUND_FIRST_PAGE_SQL,
  FUNDING_CURRENT_REFUND_NEXT_PAGE_SQL,
  FUNDING_REFUND_COMPLETION_PROOF_SQL,
  allocateFundingObservationInTransaction,
  appendFundingRefundCompletionProof,
  hasFundingRefundOutsideProof,
  listFundingRefundManifestReceipts,
} from "../../persistence/funding-operation-repository.js";
import { canonicalJsonHash } from "../../persistence/canonical.js";
import { verifyRefundCompletionScanPg } from "../refund-completion-scan-pg.js";
import { verifyRefundObservationScanPg } from "../refund-observation-scan-pg.js";
import {
  REFUND_OBSERVATION_FIRST_PAGE_SQL,
  REFUND_OBSERVATION_NEXT_PAGE_SQL,
} from "../../reconciliation/relay-refund-observation-scan.js";

const pool = await createIntegrationTestPool({
  max: 1,
  options: "-c statement_timeout=15000",
});
const db = await pool.connect();
try {
  await db.query("begin");
  assert.equal(
    (
      await db.query("show server_version_num")
    ).rows[0].server_version_num.slice(0, 2),
    "16",
  );
  assert.ok(
    (
      await db.query(
        "select to_regclass('public.funding_observations_refund_manifest_idx') as idx",
      )
    ).rows[0].idx,
    "apply additive migration 0305 first",
  );
  await db.query(
    "create temp table funding_observations (like public.funding_observations including defaults including constraints including indexes) on commit drop",
  );
  await verifyRefundCompletionScanPg(db);
  await verifyRefundObservationScanPg(db);
  const operationId = randomUUID(),
    segmentId = randomUUID();
  const base = {
    operationId,
    segmentId,
    kind: "refund_credit" as const,
    networkId: "evm:8453",
    assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    assetDecimals: 6,
    eventIndex: "7",
    fromAddress: `0x${"ab".repeat(20)}`,
    toAddress: `0x${"cd".repeat(20)}`,
    rawAmount: "4000000",
    observedAt: new Date(),
    finalizedAt: new Date(),
    ledgerHeight: "123",
    blockHash: `0x${"ed".repeat(32)}`,
    finalityStatus: "finalized" as const,
    metadata: {
      observerId: "relay_exact_refund_observation_v1",
      nativeDestinationDex: null,
    },
  };
  const hashes = ["a", "b"].map((value) => `0x${value.repeat(64)}`);
  const records = [];
  for (const txHash of hashes)
    records.push(
      (await allocateFundingObservationInTransaction(db, { ...base, txHash }))
        .observation,
    );
  const lookup = {
    operationId,
    segmentId,
    networkId: base.networkId,
    transactionHashes: hashes,
  };
  const proofInput = {
    operationId,
    segmentId,
    observationIds: records.map((row) => row.id),
  };
  assert.equal((await listFundingRefundManifestReceipts(db, lookup)).length, 2);
  assert.equal(await hasFundingRefundOutsideProof(db, proofInput), false);
  assert.equal(
    await hasFundingRefundOutsideProof(db, {
      ...proofInput,
      observationIds: [records[0].id],
    }),
    true,
  );
  assert.equal(
    await hasFundingRefundOutsideProof(db, {
      ...proofInput,
      segmentId: randomUUID(),
    }),
    false,
  );
  // N members are followed by the N+1-th conflicting row in another network.
  const outside = (
    await allocateFundingObservationInTransaction(db, {
      ...base,
      networkId: "zzz:other",
      txHash: `0x${"c".repeat(64)}`,
      metadata: { observerId: "wrong-observer" },
    })
  ).observation;
  assert.equal(await hasFundingRefundOutsideProof(db, proofInput), true);
  await db.query(
    "update funding_observations set canonical=false, finality_status='reorged', reorged_at=now() where id=$1",
    [outside.id],
  );
  assert.equal(await hasFundingRefundOutsideProof(db, proofInput), false);
  // Two witnesses survive before identity/observer filtering, never first-match.
  await db.query("savepoint manifest_collision");
  await allocateFundingObservationInTransaction(db, {
    ...base,
    txHash: hashes[0],
    eventIndex: "0",
    metadata: { observerId: "wrong-observer" },
  });
  const collision = await listFundingRefundManifestReceipts(db, {
    ...lookup,
    transactionHashes: [hashes[0]],
  });
  assert.equal(collision.length, 2);
  assert.equal(collision[0].metadata.observerId, "wrong-observer");
  await db.query("rollback to savepoint manifest_collision");
  await db.query("release savepoint manifest_collision");

  const proof = {
    version: 1,
    requestFingerprint: "a".repeat(64),
    lookupKeyVersion: 1,
    protocolOrderId: `0x${"b".repeat(64)}`,
    refundLocationId: randomUUID(),
    expectedReturned: {
      asset: { networkId: base.networkId, assetId: base.assetId, decimals: 6 },
      raw: "8000000",
    },
    observationIds: proofInput.observationIds,
  };
  const append = {
    operationId,
    segmentId,
    observationId: records[0].id,
    observerId: base.metadata.observerId,
    proof,
  };
  const proofQueries: { sql: string; values: unknown[] }[] = [];
  const proofDb = {
    query: async (sql: string, values: unknown[]) => {
      proofQueries.push({ sql, values });
      return db.query(sql, values);
    },
  } as Pick<PoolClient, "query">;
  assert.equal(
    await appendFundingRefundCompletionProof(proofDb, append),
    "appended",
  );
  const beforeReplay = (
    await db.query(
      "select ctid::text as version from funding_observations where id=$1",
      [records[0].id],
    )
  ).rows[0].version;
  assert.equal(
    await appendFundingRefundCompletionProof(proofDb, append),
    "replayed",
  );
  assert.equal(
    (
      await db.query(
        "select ctid::text as version from funding_observations where id=$1",
        [records[0].id],
      )
    ).rows[0].version,
    beforeReplay,
    "replay does not UPDATE",
  );
  await db.query("savepoint malformed_proof");
  await db.query(
    "update funding_observations set metadata=jsonb_set(metadata, array['relayRefundCompletionProofs',$2::text], 'null'::jsonb) where id=$1",
    [records[0].id, canonicalJsonHash(proof)],
  );
  assert.equal(
    await appendFundingRefundCompletionProof(db, append),
    "conflict",
  );
  await db.query(
    "update funding_observations set metadata=jsonb_set(metadata, '{relayRefundCompletionProofs}', '[]'::jsonb) where id=$1",
    [records[0].id],
  );
  assert.equal(
    await appendFundingRefundCompletionProof(db, append),
    "conflict",
  );
  await db.query("rollback to savepoint malformed_proof");
  await db.query("release savepoint malformed_proof");
  await db.query(
    `update funding_observations set metadata=jsonb_set(metadata, '{relayRefundCompletionProofs}',
    metadata->'relayRefundCompletionProofs' || (select jsonb_object_agg(md5(sample::text)||md5(sample::text), jsonb_build_object('largeAudit', repeat('x',1024))) from generate_series(1,1000) sample)) where id=$1`,
    [records[0].id],
  );
  assert.equal(
    await appendFundingRefundCompletionProof(db, append),
    "replayed",
  );
  const narrow = await listFundingRefundManifestReceipts(db, lookup);
  assert.ok(
    narrow.every(
      (row) => !Object.hasOwn(row.metadata, "relayRefundCompletionProofs"),
    ),
  );
  assert.ok(
    JSON.stringify(narrow).length < 5000,
    "large audit is not returned to the writer",
  );
  const replay = await allocateFundingObservationInTransaction(
    db,
    { ...base, txHash: hashes[0] },
    "refund_receipt",
  );
  assert.equal(replay.replayed, true);
  assert.equal(
    Object.hasOwn(replay.observation.metadata, "relayRefundCompletionProofs"),
    false,
  );
  const legacy = await allocateFundingObservationInTransaction(db, {
    ...base,
    txHash: hashes[0],
  });
  assert.ok(
    Object.hasOwn(legacy.observation.metadata, "relayRefundCompletionProofs"),
    "legacy callers retain full projection",
  );

  await db.query("savepoint nonfinal_replay");
  await db.query(
    "update funding_observations set canonical=false, finality_status='reorged', reorged_at=now() where id=$1",
    [records[0].id],
  );
  const reorged = await allocateFundingObservationInTransaction(
    db,
    { ...base, txHash: hashes[0] },
    "refund_receipt",
  );
  assert.equal(reorged.observation.canonical, false);
  assert.equal(reorged.observation.finalityStatus, "reorged");
  assert.equal(
    await appendFundingRefundCompletionProof(db, append),
    "conflict",
  );
  assert.equal((await listFundingRefundManifestReceipts(db, lookup)).length, 1);
  await db.query("rollback to savepoint nonfinal_replay");
  await db.query("release savepoint nonfinal_replay");

  // Dense same-operation history, unrelated segments and other observation
  // kinds. Copy all real production indexes, not an invented perfect index.
  await db.query(
    `insert into funding_observations
    (id,operation_id,segment_id,kind,network_id,asset_id,asset_decimals,tx_hash,event_index,
      from_address,to_address,raw_amount,observed_at,ledger_height,block_hash,finality_status,canonical,finalized_at)
    select gen_random_uuid(),$1::uuid,case when sample % 3=0 then $2::uuid else $3::uuid end,
      case when sample % 3=2 then 'source_debit' else 'refund_credit' end,
      'evm:8453',$4,6,'0x'||md5(sample::text)||md5(sample::text),'7',$5,$6,'1',now(),'123',$7,'finalized',true,now()
    from generate_series(1,150000) sample`,
    [
      operationId,
      segmentId,
      randomUUID(),
      base.assetId,
      base.fromAddress,
      base.toAddress,
      base.blockHash,
    ],
  );
  await db.query("analyze funding_observations");
  await db.query("set local plan_cache_mode=force_generic_plan");
  await db.query(
    `prepare refund_manifest_probe(uuid,uuid,text,text[]) as ${FUNDING_REFUND_MANIFEST_RECEIPTS_SQL}`,
  );
  await db.query(
    `prepare refund_outside_probe(uuid,uuid,uuid[]) as ${FUNDING_REFUND_OUTSIDE_PROOF_SQL}`,
  );
  await db.query(
    `prepare refund_current_first(uuid,uuid,integer) as ${FUNDING_CURRENT_REFUND_FIRST_PAGE_SQL}`,
  );
  await db.query(
    `prepare refund_current_next(uuid,uuid,integer,text,text,text) as ${FUNDING_CURRENT_REFUND_NEXT_PAGE_SQL}`,
  );
  await db.query(
    `prepare refund_proof_point(uuid,uuid,uuid,text,text) as ${FUNDING_REFUND_COMPLETION_PROOF_SQL}`,
  );
  await db.query(
    `prepare refund_observation_first(uuid,integer) as ${REFUND_OBSERVATION_FIRST_PAGE_SQL}`,
  );
  await db.query(
    `prepare refund_observation_next(uuid,integer,text,uuid) as ${REFUND_OBSERVATION_NEXT_PAGE_SQL}`,
  );
  type ExplainNode = {
    Plans?: ExplainNode[];
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    "Index Cond"?: string;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
    "Rows Removed by Filter"?: number;
    "Local Hit Blocks"?: number;
  };
  const walk = (node: ExplainNode): ExplainNode[] => [
    node,
    ...(node.Plans ?? []).flatMap(walk),
  ];
  for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
    await db.query(`set local plan_cache_mode=${mode}`);
    const cases: readonly [string, string][] = [
      [
        "observation-first",
        `execute refund_observation_first('${operationId}',8)`,
      ],
      [
        "observation-next",
        `execute refund_observation_next('${operationId}',8,'refund_credit','${records[0].id}')`,
      ],
      [
        "observation-empty-tail",
        `execute refund_observation_next('${operationId}',8,'venue_readiness','ffffffff-ffff-ffff-ffff-ffffffffffff')`,
      ],
      [
        "observation-foreign-operation",
        `execute refund_observation_first('${randomUUID()}',8)`,
      ],
      [
        "first",
        `execute refund_current_first('${operationId}','${segmentId}',8)`,
      ],
      [
        "next",
        `execute refund_current_next('${operationId}','${segmentId}',8,'evm:8453','${hashes[0]}','7')`,
      ],
      [
        "empty-tail",
        `execute refund_current_next('${operationId}','${segmentId}',8,'evm:8453','0x${"f".repeat(64)}','7')`,
      ],
      [
        "other-segment",
        `execute refund_current_first('${operationId}','${randomUUID()}',8)`,
      ],
      [
        "proof-hit",
        `execute refund_proof_point('${records[0].id}','${operationId}','${segmentId}','${canonicalJsonHash(proof)}','${base.metadata.observerId}')`,
      ],
      [
        "proof-miss",
        `execute refund_proof_point('${records[0].id}','${operationId}','${segmentId}','${"f".repeat(64)}','${base.metadata.observerId}')`,
      ],
    ];
    for (const [label, sql] of cases) {
      const plan: { Plan: ExplainNode; "Execution Time": number } = (
        await db.query(`explain (analyze,buffers,format json) ${sql}`)
      ).rows[0]["QUERY PLAN"][0];
      const scans = walk(plan.Plan).filter(
        (node) => node["Relation Name"] === "funding_observations",
      );
      assert.ok(scans.length > 0);
      for (const scan of scans) {
        assert.equal(scan["Node Type"], "Index Scan", `${mode}/${label}`);
        assert.match(
          scan["Index Cond"] ?? "",
          label.startsWith("proof")
            ? /\bid =/u
            : label.startsWith("observation")
              ? /operation_id/u
              : /operation_id.*segment_id/u,
        );
        assert.ok(
          (scan["Actual Rows"] ?? 0) + (scan["Rows Removed by Filter"] ?? 0) <=
            (label.startsWith("proof") ? 1 : 8),
        );
      }
      console.log(
        JSON.stringify({
          suite: "refund-current-pg16",
          mode,
          label,
          ms: plan["Execution Time"],
          buffers: plan.Plan["Local Hit Blocks"],
          scans: scans.map((scan) => ({
            index: scan["Index Name"],
            rows: scan["Actual Rows"],
          })),
        }),
      );
    }
  }
  for (const [label, sql] of [
    [
      "manifest-hit",
      `execute refund_manifest_probe('${operationId}','${segmentId}','evm:8453',ARRAY['${hashes[0]}','${hashes[1]}'])`,
    ],
    [
      "manifest-miss",
      `execute refund_manifest_probe('${operationId}','${segmentId}','evm:8453',ARRAY['0x${"0".repeat(64)}'])`,
    ],
    [
      "manifest-empty",
      `execute refund_manifest_probe('${operationId}','${segmentId}','evm:8453',ARRAY[]::text[])`,
    ],
    [
      "manifest-other-segment",
      `execute refund_manifest_probe('${operationId}','${randomUUID()}','evm:8453',ARRAY['${hashes[0]}'])`,
    ],
    [
      "outside-dense",
      `execute refund_outside_probe('${operationId}','${segmentId}',ARRAY['${records[0].id}','${records[1].id}']::uuid[])`,
    ],
    [
      "outside-empty",
      `execute refund_outside_probe('${operationId}','${randomUUID()}',ARRAY[]::uuid[])`,
    ],
  ]) {
    const plan = (
      await db.query(`explain (analyze,buffers,format json) ${sql}`)
    ).rows[0]["QUERY PLAN"][0];
    const nodes = walk(plan.Plan);
    assert.ok(
      !nodes.some(
        (node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "funding_observations",
      ),
      label,
    );
    for (const node of nodes.filter(
      (node) => node["Relation Name"] === "funding_observations",
    )) {
      assert.match(
        node["Index Cond"] ?? "",
        /operation_id.*segment_id/u,
        `${label}: index bounds both leg keys`,
      );
      assert.ok(
        (node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) <=
          (label.startsWith("manifest") ? 2 : 3),
        label,
      );
    }
    console.log(
      JSON.stringify({
        suite: "refund-manifest-pg16",
        label,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
        scans: nodes
          .filter((node) => node["Relation Name"])
          .map((node) => ({
            index: node["Index Name"],
            rows: node["Actual Rows"],
            loops: node["Actual Loops"],
          })),
      }),
    );
  }
  for (const [index, captured] of proofQueries.entries()) {
    const plan = (
      await db.query(
        `explain (analyze,buffers,format json) ${captured.sql}`,
        captured.values,
      )
    ).rows[0]["QUERY PLAN"][0];
    const scans = walk(plan.Plan).filter(
      (node) =>
        node["Relation Name"] === "funding_observations" &&
        node["Node Type"] !== "ModifyTable",
    );
    assert.ok(scans.length > 0);
    assert.ok(
      scans.every(
        (node) =>
          node["Node Type"] === "Index Scan" &&
          /\bid =/u.test(node["Index Cond"] ?? ""),
      ),
      `single proof has an exact observation-id index bound: ${JSON.stringify(scans)}`,
    );
    assert.ok(
      scans.every(
        (node) =>
          (node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) <=
          1,
      ),
    );
    console.log(
      JSON.stringify({
        suite: "refund-manifest-pg16",
        label: `proof-point-${index}`,
        ms: plan["Execution Time"],
        buffers: plan.Plan["Local Hit Blocks"],
      }),
    );
  }
  console.log(
    "PASS bounded manifest, collision witnesses, N+1 completeness, narrow allocation replay and single-proof append",
  );
} finally {
  await db.query("rollback");
  db.release();
  await pool.end();
}
