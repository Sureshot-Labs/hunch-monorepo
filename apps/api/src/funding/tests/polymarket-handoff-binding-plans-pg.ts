import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import {
  loadFrozenPolymarketHandoffBinding,
  POLYMARKET_HANDOFF_BINDING_SQL,
  type StoredPolymarketHandoffBinding,
} from "../persistence/polymarket-handoff-binding-repository.js";
import { FUNDING_HANDOFF_SNAPSHOT_TAIL_SQL } from "../../account-value/funding-handoff-snapshots.js";

/** Read-query scale only. TEMP relations inherit the exact lookup columns and
 * index predicates, not production triggers. Caller rolls the savepoint back. */
export async function verifyHandoffBindingLookupPlans(
  db: PoolClient,
  input: {
    userId: string;
    operationId: string;
    segmentId: string;
    sourceReservationId: string;
  },
  plan: FundingCommitPlan,
  binding: StoredPolymarketHandoffBinding,
  observedAt: Date,
) {
  const quoteId = (
    await db.query("select quote_id from funding_operations where id=$1", [
      input.operationId,
    ])
  ).rows[0].quote_id;
  await db.query(`
    create temp table funding_operations(id uuid primary key,user_id uuid,quote_id uuid,source_snapshot jsonb,wallet_execution_snapshot jsonb,plan_hash text);
    create temp table funding_quotes(id uuid primary key,user_id uuid,consumed_at timestamptz,plan_snapshot jsonb,plan_hash text);
    create temp table funding_operation_segments(id uuid primary key,operation_id uuid,ordinal integer,provider_id text,source_snapshot jsonb,quoted_input jsonb);
    create temp table balance_reservations(id uuid primary key,user_id uuid,operation_id uuid,segment_id uuid,economic_role text,mode text,component_id text,location_id text,network_id text,asset_id text,asset_decimals integer,raw_amount text);
    create index handoff_fence_physical_probe on balance_reservations(user_id,location_id,network_id,asset_id,operation_id) where mode='subtract_available';
  `);
  await db.query("insert into funding_operations values($1,$2,$3,$4,$5,$6)", [
    input.operationId,
    input.userId,
    quoteId,
    plan.operation.sourceSnapshot,
    plan.operation.walletExecutionSnapshot,
    canonicalJsonHash(plan),
  ]);
  await db.query("insert into funding_quotes values($1,$2,now(),$3,$4)", [
    quoteId,
    input.userId,
    plan,
    canonicalJsonHash(plan),
  ]);
  await db.query(
    "insert into funding_operation_segments values($1,$2,0,'relay',$3,$4)",
    [
      input.segmentId,
      input.operationId,
      plan.segments[0].sourceSnapshot,
      plan.segments[0].quotedInput,
    ],
  );
  for (const [id, reservation, segmentId] of [
    [
      input.sourceReservationId,
      binding.binding.sourceReservation,
      input.segmentId,
    ],
    [binding.controllerFenceId, binding.binding.controllerFence, null],
  ] as const)
    await db.query(
      "insert into balance_reservations values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        id,
        input.userId,
        input.operationId,
        segmentId,
        reservation.economicRole ?? "source_input",
        reservation.mode,
        reservation.componentId,
        reservation.locationId,
        reservation.networkId,
        reservation.assetId,
        reservation.assetDecimals,
        reservation.rawAmount,
      ],
    );
  const fence = binding.binding.controllerFence;
  await db.query(
    `insert into balance_reservations select gen_random_uuid(),$1::uuid,gen_random_uuid(),null,'future_credit_fence','subtract_available','noise-'||probe_row::text,$2,$3,$4,6,'10000000' from generate_series(1,100000) probe_row`,
    [input.userId, fence.locationId, fence.networkId, fence.assetId],
  );
  await db.query(
    "insert into funding_operations select gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}'::jsonb,'{}'::jsonb,'noise' from generate_series(1,50000)",
  );
  await db.query(
    "insert into funding_operation_segments select gen_random_uuid(),gen_random_uuid(),0,'relay','{}'::jsonb,'{}'::jsonb from generate_series(1,50000)",
  );
  await db.query(
    "insert into funding_quotes select gen_random_uuid(),gen_random_uuid(),now(),'{}'::jsonb,'noise' from generate_series(1,50000)",
  );
  for (const relation of [
    "funding_operations",
    "funding_quotes",
    "funding_operation_segments",
    "balance_reservations",
  ])
    await db.query(`analyze ${relation}`);
  await db.query(
    `prepare handoff_binding_probe(uuid,uuid,uuid,uuid) as ${POLYMARKET_HANDOFF_BINDING_SQL}`,
  );
  try {
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const scenario of ["hit", "missing-source", "foreign-owner"]) {
        const ids = [
          scenario === "foreign-owner" ? randomUUID() : input.userId,
          input.operationId,
          input.segmentId,
          scenario === "missing-source"
            ? randomUUID()
            : input.sourceReservationId,
        ];
        ids.forEach((id) => assert.match(id, /^[0-9a-f-]{36}$/));
        const explained = (
          await db.query(
            `explain (analyze,buffers,format json) execute handoff_binding_probe(${ids.map((id) => `'${id}'`).join(",")})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const nodes = (
          node: Record<string, unknown>,
        ): Record<string, unknown>[] => [
          node,
          ...(
            (node.Plans as Record<string, unknown>[] | undefined) ?? []
          ).flatMap(nodes),
        ];
        assert.equal(explained.Plan["Actual Rows"], scenario === "hit" ? 1 : 0);
        assert.ok(
          nodes(explained.Plan).every(
            (node) => node["Node Type"] !== "Seq Scan",
          ),
        );
        console.log(
          "[handoff-binding-dense-plan]",
          JSON.stringify({
            mode,
            scenario,
            ms: explained["Execution Time"],
            buffers: explained.Plan["Local Hit Blocks"],
            indexes: nodes(explained.Plan).flatMap((node) =>
              typeof node["Index Name"] === "string"
                ? [node["Index Name"]]
                : [],
            ),
          }),
        );
      }
    }
    assert.ok(await loadFrozenPolymarketHandoffBinding(db, input));
  } finally {
    await db.query("deallocate handoff_binding_probe");
  }
  await db.query(
    `create temp table funding_step_receipt_observations (like public.funding_step_receipt_observations including defaults)`,
  );
  await db.query(
    "insert into funding_step_receipt_observations select * from public.funding_step_receipt_observations where operation_id=$1",
    [input.operationId],
  );
  for (const side of ["source", "controller"]) {
    const indexName = `funding_receipts_handoff_${side}_tail_idx`;
    const definition = (
      await db.query<{ definition: string }>(
        "select pg_get_indexdef(indexrelid) as definition from pg_index where indexrelid=$1::regclass",
        [`public.${indexName}`],
      )
    ).rows[0]?.definition;
    assert.ok(definition);
    const original = `CREATE INDEX ${indexName} ON public.funding_step_receipt_observations`;
    assert.ok(
      definition.startsWith(original),
      "exact disposable index target only",
    );
    await db.query(
      definition.replace(
        original,
        `CREATE INDEX handoff_${side}_tail_probe ON pg_temp.funding_step_receipt_observations`,
      ),
    );
  }
  const hint = {
    version: 1,
    assetId: binding.binding.economicSource.asset.assetId,
    sourceAddress: binding.binding.economicSource.details.address,
    controllerAddress: binding.binding.executionSource.details.address,
  };
  // Same physical source, old tail: LIMIT or a per-owner history scan cannot
  // substitute for the actual address/asset/time indexes.
  await db.query(
    `insert into funding_step_receipt_observations(operation_id,step_id,attempt_id,network_id,status,canonical,action_match,evidence,first_seen_at,observed_at,finalized_at)
    select gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'evm:137','finalized',true,true,jsonb_build_object('polymarketHandoffReadV1',$1::jsonb),$2::timestamptz-interval '1 day',$2::timestamptz-interval '1 day',$2::timestamptz-interval '1 day' from generate_series(1,100000) probe_row`,
    [hint, observedAt],
  );
  await db.query("analyze funding_step_receipt_observations");
  await db.query(
    `prepare handoff_physical_tail_probe(uuid,jsonb) as ${FUNDING_HANDOFF_SNAPSHOT_TAIL_SQL}`,
  );
  try {
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const nodes = (
      node: Record<string, unknown>,
    ): Record<string, unknown>[] => [
      node,
      ...((node.Plans as Record<string, unknown>[] | undefined) ?? []).flatMap(
        nodes,
      ),
    ];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const scenario of [
        "hit",
        "fresh-empty",
        "foreign-owner",
        "sparse-address",
      ]) {
        const snapshots = [
          [
            binding.binding.economicSource,
            binding.binding.sourceReservation.componentId,
          ],
          [
            binding.binding.executionSource,
            binding.binding.controllerFence.componentId,
          ],
        ].map(([location, componentId]) => {
          const entry = location as typeof binding.binding.economicSource;
          return {
            component_id: componentId,
            location_id: entry.locationId,
            address:
              scenario === "sparse-address"
                ? `0x${"ee".repeat(20)}`
                : String(entry.details.address).toLowerCase(),
            network_id: entry.asset.networkId,
            asset_id: entry.asset.assetId.toLowerCase(),
            asset_decimals: entry.asset.decimals,
            snapshot_at: new Date(
              observedAt.getTime() +
                (scenario === "fresh-empty" ? 1000 : -1000),
            ).toISOString(),
          };
        });
        const owner =
          scenario === "foreign-owner" ? randomUUID() : input.userId;
        const explained = (
          await db.query(
            `explain (analyze,buffers,format json) execute handoff_physical_tail_probe(${literal(owner)}::uuid,${literal(JSON.stringify(snapshots))}::jsonb)`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(explained.Plan["Actual Rows"], scenario === "hit" ? 2 : 0);
        const receiptScans = nodes(explained.Plan).filter(
          (node) =>
            node["Relation Name"] === "funding_step_receipt_observations",
        );
        assert.ok(
          receiptScans.length > 0 &&
            receiptScans.every((node) => node["Node Type"] !== "Seq Scan"),
        );
        assert.ok(
          receiptScans.every(
            (node) =>
              Number(node["Actual Rows"]) <= 1 &&
              Number(node["Rows Removed by Filter"] ?? 0) <= 1,
          ),
        );
        assert.ok(
          receiptScans.every(
            (node) => Number(node["Local Hit Blocks"] ?? 0) <= 32,
          ),
          "a redundant leading network key must not make empty physical tails walk old index leaves",
        );
        console.log(
          "[handoff-physical-dense-plan]",
          JSON.stringify({
            mode,
            scenario,
            ms: explained["Execution Time"],
            buffers: explained.Plan["Local Hit Blocks"],
            indexes: receiptScans.map((node) => node["Index Name"]),
            receiptReadBuffers: receiptScans.map(
              (node) => node["Local Hit Blocks"],
            ),
          }),
        );
      }
    }
  } finally {
    await db.query("deallocate handoff_physical_tail_probe");
  }
}
