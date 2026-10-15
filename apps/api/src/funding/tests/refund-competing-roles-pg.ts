import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Interface } from "ethers";
import type { PoolClient } from "pg";
import {
  recordRelayExactRefundReceiptsInTransaction,
  type RecordRelayExactRefundInput,
} from "../reconciliation/relay-exact-refund-receipts.js";
import type { AssetLocation } from "../domain/types.js";
import { loadCanonicalPolymarketHandoffClassifications } from "../receive/receive-handoff-classification.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import { classifyOwnedRouteCanonicalDestinationEvents } from "../reconciliation/owned-route-destination-observer.js";

/** Real shared classifiers and real writer, isolated table shadows for the
 * competing envelopes only. Public allocation/receipt/proof tables remain real;
 * conflicting-role cases must not mutate them. Outer suite always rolls back. */
export async function verifyRefundCompetingRolesPg(
  db: Pick<PoolClient, "query">,
  input: RecordRelayExactRefundInput,
  target: AssetLocation,
) {
  const event = input.evmEvents?.[0];
  if (!event || event.sourceAddress === null) return;
  await db.query("savepoint refund_competing_roles");
  try {
    for (const table of [
      "funding_operations",
      "funding_operation_segments",
      "funding_operation_steps",
      "funding_operation_step_attempts",
      "funding_step_receipt_observations",
    ]) {
      await db.query(
        `create temporary table ${table} (like public.${table} including all) on commit drop`,
      );
    }
    await db.query(
      "insert into funding_operations select * from public.funding_operations where id=$1",
      [input.operationId],
    );
    await db.query(
      "insert into funding_operation_segments select * from public.funding_operation_segments where id=$1",
      [input.segmentId],
    );
    const competingOperationId = randomUUID();
    const competingSegmentId = randomUUID();
    await db.query(
      `insert into funding_operations select copied_row.*
      from funding_operations template_row
      cross join lateral jsonb_populate_record(null::funding_operations,
        to_jsonb(template_row)||jsonb_build_object('id',$2::uuid,'quote_id',gen_random_uuid(),
          'idempotency_key',$2::text,'destination_target_snapshot',jsonb_build_object('location',$3::jsonb))) copied_row
      where template_row.id=$1`,
      [input.operationId, competingOperationId, target],
    );
    await db.query(
      `insert into funding_operation_segments select copied_row.*
      from funding_operation_segments template_row
      cross join lateral jsonb_populate_record(null::funding_operation_segments,
        to_jsonb(template_row)||jsonb_build_object('id',$2::uuid,'operation_id',$3::uuid,
          'quoted_min_output',jsonb_build_object('asset',$4::jsonb,'raw',$5::text))) copied_row
      where template_row.id=$1`,
      [
        input.segmentId,
        competingSegmentId,
        competingOperationId,
        target.asset,
        event.rawAmount,
      ],
    );
    const effectCounts = async () =>
      (
        await db.query(
          `select
      (select count(*) from public.funding_observations where operation_id=$1) as observations,
      (select count(*) from funding_receive_canonical_events
        where network_id=$2 and tx_hash=$3 and allocation_status='recovery_required'
          and allocation_error_code='internal_exact_refund_suppressed') as suppressions,
      (select row_to_json(job_row) from funding_reconciliation_jobs job_row
        where operation_id=$1 limit 1) as job_snapshot`,
          [input.operationId, event.networkId, event.transactionHash],
        )
      ).rows[0];
    const before = await effectCounts();
    let destinationQuery: { sql: string; values: unknown[] } | undefined;
    const tracedDb = {
      query: async (sql: string, values: unknown[]) => {
        if (sql.includes("with candidate_event as"))
          destinationQuery = { sql, values };
        return db.query(sql, values);
      },
    } as unknown as Pick<PoolClient, "query">;
    const expectConflict = async (name: string) => {
      assert.deepEqual(
        await recordRelayExactRefundReceiptsInTransaction(tracedDb, input),
        {
          kind: "pending",
          reason: "internal_event_classification_conflict",
        },
        name,
      );
      assert.deepEqual(
        await effectCounts(),
        before,
        `${name}: no allocation, proof, suppression or job wake`,
      );
    };
    await db.query(
      `update funding_operation_segments set raw_status='success',support_metadata=$2::jsonb where id=$1`,
      [
        competingSegmentId,
        {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: 1,
          relayTransactionReferenceFingerprints: [
            input.referenceCodec.fingerprint(event.transactionHash),
          ],
        },
      ],
    );
    await expectConflict("exact owned destination cannot be stolen by refund");
    await db.query(
      `update funding_operation_segments set raw_status='refund',support_metadata=$2::jsonb where id=$1`,
      [
        competingSegmentId,
        {
          relayStatusCategory: "refund_observed",
          destinationTransactionReferenceCount: 0,
          relayTransactionReferenceFingerprints: ["old-key-fingerprint"],
          relaySuccessfulDestinationReferenceHashesV1: [
            relayDestinationReferenceIdentity(event.transactionHash),
          ],
        },
      ],
    );
    await db.query(
      "update funding_operations set status='completed',progress_stage='terminal',completed_at=$2 where id=$1",
      [competingOperationId, input.now],
    );
    await expectConflict(
      "recorded successful destination identity survives key rotation, sparse status and terminal operation",
    );
    assert.ok(destinationQuery);
    await db.query("savepoint destination_reference_plans");
    try {
      // Same production reader and indexes. Include 5,000 historical routes
      // for this owner and 45,000 for others; LIMIT 2 is not a scan bound.
      await db.query(
        `insert into funding_operations select copied_row.*
        from funding_operations template_row cross join generate_series(1,50000) fixture_sequence
        cross join lateral jsonb_populate_record(null::funding_operations,
          to_jsonb(template_row)||jsonb_build_object(
            'id',md5('destination-plan-operation-'||fixture_sequence)::uuid,
            'user_id',case when fixture_sequence<=5000 then template_row.user_id else md5('destination-plan-user-'||fixture_sequence)::uuid end,
            'quote_id',gen_random_uuid(),'idempotency_key','destination-plan-'||fixture_sequence,
            'status','completed')) copied_row
        where template_row.id=$1`,
        [competingOperationId],
      );
      await db.query(
        `insert into funding_operation_segments select copied_row.*
        from funding_operation_segments template_row cross join generate_series(1,50000) fixture_sequence
        cross join lateral jsonb_populate_record(null::funding_operation_segments,
          to_jsonb(template_row)||jsonb_build_object(
            'id',md5('destination-plan-segment-'||fixture_sequence)::uuid,
            'operation_id',md5('destination-plan-operation-'||fixture_sequence)::uuid,
            'raw_status','success',
            'support_metadata',jsonb_build_object(
              'relayStatusCategory','provider_success','destinationTransactionReferenceCount',1,
              'relayTransactionReferenceFingerprints',jsonb_build_array(repeat(md5('legacy-'||fixture_sequence),2)),
              'relaySuccessfulDestinationReferenceHashesV1',jsonb_build_array(repeat(md5('positive-'||fixture_sequence),2))))) copied_row
        where template_row.id=$1`,
        [competingSegmentId],
      );
      await db.query("analyze funding_operations");
      await db.query("analyze funding_operation_segments");
      await db.query("set local plan_cache_mode=force_generic_plan");
      await db.query(
        `prepare destination_reference_probe(uuid,jsonb) as ${destinationQuery.sql}`,
      );
      const rows = JSON.parse(String(destinationQuery.values[1])) as Record<
        string,
        unknown
      >[];
      const missing = rows.map((row) => ({
        ...row,
        transactionReferenceFingerprint: "no-match",
        successfulDestinationReferenceIdentity: "no-match",
      }));
      for (const [name, owner, events, expected] of [
        ["hit", destinationQuery.values[0], rows, 1],
        ["same-owner-miss", destinationQuery.values[0], missing, 0],
        ["sparse-owner", randomUUID(), rows, 0],
        ["empty", destinationQuery.values[0], [], 0],
      ] as const) {
        // Literals are synthetic UUIDs/JSON produced here, escaped as SQL text.
        const json = JSON.stringify(events).replaceAll("'", "''");
        const plan = (
          await db.query(`explain(analyze,buffers,format json)
          execute destination_reference_probe('${owner}','${json}')`)
        ).rows[0]["QUERY PLAN"][0];
        assert.equal(plan.Plan["Actual Rows"], expected);
        const scannedNodes: Record<string, unknown>[] = [];
        const inspect = (node: Record<string, unknown>) => {
          if (node["Relation Name"] || node["Index Name"])
            scannedNodes.push({
              type: node["Node Type"],
              relation: node["Relation Name"],
              index: node["Index Name"],
              rows: node["Actual Rows"],
              loops: node["Actual Loops"],
              removed: node["Rows Removed by Filter"],
              recheck: node["Rows Removed by Index Recheck"],
              buffers: node["Local Hit Blocks"],
            });
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            inspect(child);
        };
        inspect(plan.Plan);
        for (const node of scannedNodes) {
          if (
            node.relation === "funding_operations" ||
            node.relation === "funding_operation_segments"
          )
            assert.notEqual(node.type, "Seq Scan");
          assert.ok(
            (Number(node.rows) + Number(node.removed ?? 0)) *
              Number(node.loops) <
              16,
            `single-reference lookup must not scan historical rows: ${JSON.stringify(node)}`,
          );
        }
        assert.ok(
          plan.Plan["Local Hit Blocks"] < 2000,
          "no historical fanout (includes fresh GIN pending-list reads)",
        );
        console.log(
          `[destination-reference-plans] ${event.networkId}/${name}: ${plan["Execution Time"]}ms, ${plan.Plan["Local Hit Blocks"]} local hits ${JSON.stringify({ cost: plan.Plan["Total Cost"], jit: plan.JIT, nodes: scannedNodes })}`,
        );
      }
      const currentQuery = destinationQuery;
      const queryRows = async (events = rows) =>
        (
          await db.query(currentQuery.sql, [
            currentQuery.values[0],
            JSON.stringify(events),
          ])
        ).rows;
      const hmac = input.referenceCodec.fingerprint(event.transactionHash);
      const exactMetadata = {
        relayStatusCategory: "provider_success",
        destinationTransactionReferenceCount: "0001",
        relayTransactionReferenceFingerprints: [hmac],
        relaySuccessfulDestinationReferenceHashesV1: [
          relayDestinationReferenceIdentity(event.transactionHash),
        ],
      };
      await db.query(
        "update funding_operation_segments set raw_status='success',support_metadata=$2::jsonb where id=$1",
        [competingSegmentId, exactMetadata],
      );
      assert.equal(
        (await queryRows()).length,
        1,
        "overlapping exact lanes deduplicate",
      );
      const legacyMetadata = {
        ...exactMetadata,
        relaySuccessfulDestinationReferenceHashesV1: [],
      };
      await db.query(
        "update funding_operation_segments set support_metadata=$2::jsonb where id=$1",
        [competingSegmentId, legacyMetadata],
      );
      assert.equal(
        (await queryRows()).length,
        1,
        "legacy-only exact still works with leading-zero count",
      );
      await db.query(
        "update funding_operation_segments set support_metadata=$2::jsonb where id=$1",
        [
          competingSegmentId,
          {
            ...legacyMetadata,
            destinationTransactionReferenceCount: "9".repeat(80),
          },
        ],
      );
      assert.equal(
        (await queryRows()).length,
        1,
        "oversized legacy count must not throw integer overflow",
      );
      // The previous matcher stringified non-string JSON array members.
      await db.query(
        "update funding_operation_segments set support_metadata=$2::jsonb where id=$1",
        [
          competingSegmentId,
          { ...legacyMetadata, relayTransactionReferenceFingerprints: [123] },
        ],
      );
      assert.equal(
        (
          await queryRows(
            rows.map((row) => ({
              ...row,
              transactionReferenceFingerprint: "123",
            })),
          )
        ).length,
        1,
      );
      assert.equal(
        (
          await queryRows(
            rows.map((row) => ({
              ...row,
              transactionReferenceFingerprint: "0123",
            })),
          )
        ).length,
        0,
        "numeric index hint is not exact text proof",
      );
      await db.query(
        "update funding_operation_segments set support_metadata=$2::jsonb where id=$1",
        [competingSegmentId, exactMetadata],
      );
      // Other owners' same-transaction hits must not exhaust a pre-scope cap.
      await db.query(
        `update funding_operation_segments set support_metadata=$1::jsonb
        where id in (md5('destination-plan-segment-5001')::uuid,md5('destination-plan-segment-5002')::uuid)`,
        [exactMetadata],
      );
      assert.equal(
        (await queryRows()).length,
        1,
        "out-of-scope references cannot hide valid hit",
      );
      const batch = await classifyOwnedRouteCanonicalDestinationEvents(db, {
        userId: String(currentQuery.values[0]),
        events: [event, { ...event, transactionHash: `0x${"cc".repeat(32)}` }],
        referenceCodec: input.referenceCodec,
      });
      assert.deepEqual(
        [...batch.values()].map((row) => row.kind),
        ["internal", "external"],
        "different events retain independent identity",
      );
      // Exercise the actual dynamic input-cardinality query at full receive
      // batch sizes, without disabling JIT or raising statement timeouts.
      for (const mode of ["force_generic_plan", "force_custom_plan"] as const) {
        await db.query(`set local plan_cache_mode=${mode}`);
        for (const [count, distinct] of [
          [1, false],
          [16, false],
          [64, false],
          [16, true],
          [64, true],
        ] as const) {
          const events = Array.from({ length: count }, (_, ordinal) => ({
            ...event,
            eventIndex: String(ordinal),
            transactionHash:
              distinct && ordinal > 0
                ? `0x${ordinal.toString(16).padStart(64, "0")}`
                : event.transactionHash,
          }));
          const result = await classifyOwnedRouteCanonicalDestinationEvents(
            tracedDb,
            {
              userId: String(currentQuery.values[0]),
              events,
              referenceCodec: input.referenceCodec,
            },
          );
          assert.equal(result.size, count);
          assert.equal(
            [...result.values()].filter((row) => row.kind === "internal")
              .length,
            distinct ? 1 : count,
          );
          assert.ok(destinationQuery);
          await db.query(
            `prepare destination_batch_probe(uuid,jsonb) as ${destinationQuery.sql}`,
          );
          try {
            const json: string = String(destinationQuery.values[1]).replaceAll(
              "'",
              "''",
            );
            const plan: {
              Plan: Record<string, unknown>;
              JIT?: { Timing: unknown };
              "Execution Time": number;
            } = (
              await db.query(
                `explain(analyze,buffers,format json) execute destination_batch_probe('${currentQuery.values[0]}','${json}')`,
              )
            ).rows[0]["QUERY PLAN"][0];
            assert.equal(plan.Plan["Actual Rows"], distinct ? 1 : count);
            const inspectBatch = (node: Record<string, unknown>) => {
              if (
                node["Relation Name"] === "funding_operations" ||
                node["Relation Name"] === "funding_operation_segments"
              ) {
                assert.notEqual(node["Node Type"], "Seq Scan");
                assert.ok(
                  (Number(node["Actual Rows"]) +
                    Number(node["Rows Removed by Filter"] ?? 0)) *
                    Number(node["Actual Loops"]) <
                    16 * count,
                  "batch must not revisit historical routes",
                );
              }
              for (const child of (node.Plans ?? []) as Record<
                string,
                unknown
              >[])
                inspectBatch(child);
            };
            inspectBatch(plan.Plan);
            console.log(
              `[destination-batch-plans] ${event.networkId}/${mode}/${count}/${distinct ? "sparse" : "same-tx"}: ${plan["Execution Time"]}ms, ${plan.Plan["Local Hit Blocks"]} local hits, JIT ${JSON.stringify(plan.JIT?.Timing ?? null)}`,
            );
          } finally {
            await db.query("deallocate destination_batch_probe");
          }
        }
      }
      await db.query(
        `update funding_operation_segments set support_metadata=$1::jsonb
        where id=md5('destination-plan-segment-1')::uuid`,
        [exactMetadata],
      );
      const ambiguous = await queryRows();
      assert.equal(ambiguous.length, 2, "two scoped exact legs stay ambiguous");
      assert.ok(ambiguous.every((row) => row.match_kind === "exact"));
      assert.equal(new Set(ambiguous.map((row) => row.segment_id)).size, 2);
      await db.query(`update funding_operations set destination_target_snapshot=jsonb_set(destination_target_snapshot,
        '{location,details,address}','"0x1111111111111111111111111111111111111111"'::jsonb)
        where id=md5('destination-plan-operation-1')::uuid`);
      assert.equal(
        (await queryRows()).length,
        1,
        "exact hash cannot override recipient",
      );
      await db.query(`update funding_operations set status='in_progress',progress_stage='source_action',completed_at=null
        where id=md5('destination-plan-operation-2')::uuid`);
      await db.query(`update funding_operation_segments set raw_status='pending',support_metadata='{"originTransactionReferenceCount":1}'::jsonb
        where id=md5('destination-plan-segment-2')::uuid`);
      const withPossible = await queryRows();
      assert.deepEqual(withPossible.map((row) => row.match_kind).sort(), [
        "exact",
        "possible",
      ]);
      const precedence = await classifyOwnedRouteCanonicalDestinationEvents(
        db,
        {
          userId: String(currentQuery.values[0]),
          events: [event],
          referenceCodec: input.referenceCodec,
        },
      );
      assert.equal(
        [...precedence.values()][0]?.kind,
        "internal",
        "exact reference retains precedence over possible route",
      );
      await db.query(`update funding_operations set status='ready',progress_stage='ready_for_consumer'
        where id=md5('destination-plan-operation-2')::uuid`);
      assert.equal(
        (await queryRows(missing)).length,
        0,
        "ready route is not an unresolved destination candidate",
      );
    } finally {
      await db.query("rollback to savepoint destination_reference_plans");
      await db.query("release savepoint destination_reference_plans");
      await db.query("deallocate destination_reference_probe");
    }
    await db.query(
      `update funding_operations set status='in_progress',progress_stage='source_action',completed_at=null where id=$1`,
      [competingOperationId],
    );
    await db.query(
      `update funding_operation_segments set raw_status='pending',support_metadata=$2::jsonb where id=$1`,
      [competingSegmentId, { originTransactionReferenceCount: 1 }],
    );
    await expectConflict(
      "unresolved owned destination cannot be bypassed by refund",
    );
    // Clear only the competing test destination. Normal real-reader recovery is
    // checked by the caller immediately after this savepoint rolls back.
    await db.query("delete from funding_operation_segments where id=$1", [
      competingSegmentId,
    ]);
    if (event.networkId === "evm:137") {
      const stepId = randomUUID(),
        attemptId = randomUUID();
      const data = new Interface([
        "function transfer(address recipient,uint256 amount)",
      ]).encodeFunctionData("transfer", [
        event.destinationAddress,
        BigInt(event.rawAmount),
      ]);
      const action = {
        kind: "external_handoff",
        actionId: stepId,
        networkId: event.networkId,
        actorWalletId: "test-wallet",
        handoffKind: "polymarket_deposit_wallet_transfer",
        payload: {
          topology: "deposit_wallet",
          funder: event.sourceAddress,
          recipient: event.destinationAddress,
          token: event.asset.assetId,
          amountRaw: event.rawAmount,
          calls: [{ target: event.asset.assetId, value: "0", data }],
        },
      };
      const validation = {
        executionEnvelope: "polymarket_deposit_wallet_to_controller_v1",
        funderAddress: event.sourceAddress,
        recipientAddress: event.destinationAddress,
        tokenAddress: event.asset.assetId,
        amountRaw: event.rawAmount,
        transferData: data,
      };
      await db.query(
        `insert into funding_operation_steps select copied_row.*
        from public.funding_operation_steps template_row
        cross join lateral jsonb_populate_record(null::funding_operation_steps,
          to_jsonb(template_row)||jsonb_build_object('id',$2::uuid,'operation_id',$3::uuid,
            'segment_id',null,'normalized_action',$4::jsonb,'action_validation_result',$5::jsonb)) copied_row
        where template_row.operation_id=$1 order by template_row.ordinal limit 1`,
        [input.operationId, stepId, competingOperationId, action, validation],
      );
      // Real PG type/default/check constraints; use an existing legal attempt as
      // a template while keeping all physical reference fields explicit.
      await db.query(
        `insert into funding_operation_step_attempts select copied_row.*
        from public.funding_operation_step_attempts template_row
        cross join lateral jsonb_populate_record(null::funding_operation_step_attempts,
          to_jsonb(template_row)||jsonb_build_object('id',$2::uuid,'step_id',$3::uuid,
            'outcome','started','finished_at',null,'reference_kind',null,
            'receipt_ref_ciphertext',null,'receipt_ref_lookup_hmac',null,'lookup_key_version',null,
            'actual_costs','{}'::jsonb,'broadcast_may_have_occurred',false)) copied_row
        join public.funding_operation_steps step_row on step_row.id=template_row.step_id
        where step_row.operation_id=$1 order by step_row.ordinal,template_row.attempt_number limit 1`,
        [input.operationId, attemptId, stepId],
      );
      assert.equal(
        (
          await db.query(
            "select count(*)::int as n from funding_operation_step_attempts where id=$1",
            [attemptId],
          )
        ).rows[0].n,
        1,
      );
      await expectConflict(
        "unreported handoff remains a conflicting role even without codec",
      );
      await db.query(
        `insert into funding_step_receipt_observations
        (operation_id,step_id,attempt_id,network_id,status,action_match,
         canonical,evidence,first_seen_at,observed_at)
        values ($1,$2,$3,$4,'confirmed',true,true,$5::jsonb,$6,$6)`,
        [
          competingOperationId,
          stepId,
          attemptId,
          event.networkId,
          {
            transactionHash: event.transactionHash,
            handoffEventIndex: event.eventIndex,
          },
          input.now,
        ],
      );
      const classify = () =>
        loadCanonicalPolymarketHandoffClassifications(db, {
          userId: target.accountId,
          now: input.now,
          events: [
            {
              ...event,
              sourceAddress: event.sourceAddress as string,
              variant: { networkId: event.networkId, asset: event.asset },
            },
          ],
        });
      const identity = [
        event.networkId,
        event.transactionHash,
        event.eventIndex,
      ].join(":");
      assert.equal((await classify()).get(identity)?.kind, "internal");
      await expectConflict(
        "exact handoff and refund are not first-match winners",
      );
      await db.query(
        `update funding_step_receipt_observations set
        evidence=jsonb_set(evidence,'{transactionHash}',to_jsonb($2::text)) where attempt_id=$1`,
        [attemptId, `0x${"cc".repeat(32)}`],
      );
      assert.equal((await classify()).get(identity)?.kind, "external");
      assert.equal(
        (await recordRelayExactRefundReceiptsInTransaction(db, input)).kind,
        "partial",
        "exact evidence for a different transaction repairs the conflict on the ordinary next attempt",
      );
    }
  } finally {
    await db.query("rollback to savepoint refund_competing_roles");
    await db.query("release savepoint refund_competing_roles");
  }
}
