import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { Interface } from "ethers";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  advanceSessionlessFundingRoleScan,
  advanceReceiveRefundScan,
  checkpointSessionlessFundingRoleArbitrationInTransaction,
  readReceiveRoleArbitrationInTransaction,
  SESSIONLESS_FUNDING_ROLE_EVENT_SQL,
  RESTART_RECEIVE_ROLE_SCAN_SQL,
  RECEIVE_ROLE_SCAN_CONTRACT_VERSION,
} from "../receive/receive-refund-scan.js";
import { stageFundingReceiveClassificationBatch } from "../persistence/funding-receive-session-repository.js";
import { createRoleCheckpointTestSession } from "./receive-legacy-role-checkpoint-pg.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { mergeUsersById } from "../../admin-merge-user-core.js";
import { cancelFundingOperationForUser } from "../reconciliation/funding-operation-cancellation.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import type { AssetLocation } from "../domain/types.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;
type FixtureFactory = (
  existing?: { userId: string; owner: string },
  beforeCommit?: (db: PoolClient, data: Fixture) => Promise<void>,
  makeSteps?: (source: AssetLocation) => FundingCommitPlan["steps"],
) => Promise<Fixture>;

/** Checkpoint adapter acceptance only, NOT sessionless financial publication or
 * a proof of merge-safe source membership. No transport or financial effects. */
export async function verifySessionlessRoleCheckpointPg(
  pool: Pool,
  data: Fixture,
  mergeScenario?: {
    beforeReceive: () => Promise<string[]>;
  },
) {
  const raw = data.evm[0];
  assert.ok(raw.ledgerHeight && raw.blockHash);
  const event = {
    ...raw,
    ledgerHeight: raw.ledgerHeight,
    blockHash: raw.blockHash,
    now: data.base.now,
  };
  const userId = data.base.source.accountId;
  const input = {
    userId,
    operationId: data.base.operationId,
    event,
    limit: 1,
    progressToken: randomUUID(),
    referenceCodec: data.base.referenceCodec,
    transactionReferenceCodec: createFundingTransactionReferenceCodec({
      encryptionKey: Buffer.alloc(32, 19),
      lookupHmacKey: "offline-sessionless-checkpoint-key-32chars",
      keyVersion: 1,
    }),
  };
  let sessionId: string | undefined;
  let eventId: string | undefined;
  const counts = async () =>
    (
      await pool.query(
        `select
    (select count(*)::int from funding_receive_sessions where user_id=$1) as sessions,
    (select count(*)::int from funding_receive_receipts where user_id=$1) as receipts,
    (select count(*)::int from funding_observations where operation_id=$2) as observations,
    (select count(*)::int from funding_reconciliation_jobs where operation_id=$2) as jobs`,
        [userId, input.operationId],
      )
    ).rows[0];
  const before = await counts();
  assert.equal(before.sessions, 0);
  try {
    assert.deepEqual(
      await advanceSessionlessFundingRoleScan(pool, {
        ...input,
        userId: randomUUID(),
      }),
      { kind: "unavailable" },
    );
    assert.equal(
      (await advanceSessionlessFundingRoleScan(pool, input)).kind,
      "source_page",
    );
    const header = (
      await pool.query(
        "select * from funding_receive_refund_scans where user_id=$1",
        [userId],
      )
    ).rows[0];
    eventId = header.event_id;
    assert.equal(header.receive_session_id, null);
    assert.equal(header.variant_id, null);
    assert.deepEqual(await advanceSessionlessFundingRoleScan(pool, input), {
      kind: "replayed",
      revision: header.progress_revision,
    });
    await assert.rejects(
      advanceSessionlessFundingRoleScan(pool, {
        ...input,
        progressToken: randomUUID(),
        event: { ...event, rawAmount: "123456789" },
      }),
      /canonical receive event identity collision/,
    );
    assert.equal(
      (
        await pool.query(
          "select progress_revision from funding_receive_refund_scans where event_id=$1",
          [eventId],
        )
      ).rows[0].progress_revision,
      header.progress_revision,
    );

    let result = await tx(pool, (db) =>
      checkpointSessionlessFundingRoleArbitrationInTransaction(db, input),
    );
    let ticks = 0;
    while (result.kind === "incomplete" && ticks++ < 20) {
      const next = { ...input, progressToken: randomUUID() };
      const progressed = await advanceSessionlessFundingRoleScan(pool, next);
      assert.notEqual(progressed.kind, "unavailable");
      result = await tx(pool, (db) =>
        checkpointSessionlessFundingRoleArbitrationInTransaction(db, next),
      );
    }
    assert.equal(result.kind, "ready_for_fence", JSON.stringify(result));
    assert.ok(
      ticks > 1,
      "actual source/role pages must resume across work identities",
    );
    if (result.kind === "ready_for_fence") {
      // These synthetic source envelopes lack a fully verified refund contract.
      // Exhaustion/cancellation does not turn that uncertainty into proof of an
      // unrelated external deposit.
      assert.deepEqual(result.classification, {
        kind: "recovery_required",
        reason: "exact_refund_correlation_pending",
      });
      assert.deepEqual(
        result.dependencies.map((entry) => entry.operationId),
        [input.operationId],
      );
    }
    assert.deepEqual(
      await counts(),
      before,
      "scan cannot create session, credit, receipt or wake",
    );
    const physical = (
      await pool.query(
        "select allocation_status,classification_receive_session_id,classification_lease_token from funding_receive_canonical_events where id=$1",
        [eventId],
      )
    ).rows[0];
    assert.deepEqual(physical, {
      allocation_status: "pending",
      classification_receive_session_id: null,
      classification_lease_token: null,
    });

    const missing = await tx(pool, (db) =>
      checkpointSessionlessFundingRoleArbitrationInTransaction(db, {
        ...input,
        transactionReferenceCodec: undefined,
      }),
    );
    assert.equal(missing.kind, "incomplete");
    assert.deepEqual(
      await tx(pool, (db) =>
        checkpointSessionlessFundingRoleArbitrationInTransaction(db, input),
      ),
      result,
    );

    const additionalOperations = (await mergeScenario?.beforeReceive()) ?? [];
    const originalCandidates = (
      await pool.query(
        "select candidate_id from funding_receive_refund_candidates where event_id=$1 order by candidate_id",
        [eventId],
      )
    ).rows.map((row) => row.candidate_id);

    // A real subsequently opened receive session may reuse derived work, but
    // only its ordinary exact lease authorizes the receive-side reader.
    const session = await createRoleCheckpointTestSession(pool, data);
    sessionId = session.sessionId;
    const [staged] = await stageFundingReceiveClassificationBatch(pool, {
      scope: {
        userId,
        destinationOptionId: session.destinationOptionId,
        venueBindingOptionId: session.venueBindingOptionId,
      },
      events: [event],
      retryDelayMs: 1000,
      now: event.now,
    });
    assert.equal(staged.kind, "claimed");
    if (staged.kind !== "claimed") throw Error("expected actual receive lease");
    const bound = { ...input, retry: staged.retry };
    assert.deepEqual(
      await tx(pool, (db) =>
        readReceiveRoleArbitrationInTransaction(db, bound),
      ),
      { kind: "incomplete", reason: "source_enumeration_pending" },
    );
    assert.equal(
      (await advanceReceiveRefundScan(pool, bound)).kind,
      "source_restart",
    );
    const adopted = (
      await pool.query(
        "select receive_session_id,variant_id,source_exhausted from funding_receive_refund_scans where event_id=$1",
        [eventId],
      )
    ).rows[0];
    assert.deepEqual(adopted, {
      receive_session_id: sessionId,
      variant_id: session.variantId,
      source_exhausted: false,
    });
    assert.deepEqual(
      (
        await pool.query(
          "select candidate_id from funding_receive_refund_candidates where event_id=$1 order by candidate_id",
          [eventId],
        )
      ).rows.map((row) => row.candidate_id),
      originalCandidates,
    );
    assert.equal(
      (await advanceReceiveRefundScan(pool, bound)).kind,
      "replayed",
    );
    let rebound = await tx(pool, (db) =>
      readReceiveRoleArbitrationInTransaction(db, bound),
    );
    for (let tick = 1; rebound.kind === "incomplete" && tick <= 30; tick++) {
      const [next] = await stageFundingReceiveClassificationBatch(pool, {
        scope: {
          userId,
          destinationOptionId: session.destinationOptionId,
          venueBindingOptionId: session.venueBindingOptionId,
        },
        events: [event],
        retryDelayMs: 1000,
        now: new Date(event.now.getTime() + tick * 1001),
      });
      assert.equal(next.kind, "claimed");
      if (next.kind !== "claimed")
        throw Error("expected next actual receive lease");
      const nextInput = { ...input, retry: next.retry };
      await advanceReceiveRefundScan(pool, nextInput);
      rebound = await tx(pool, (db) =>
        readReceiveRoleArbitrationInTransaction(db, nextInput),
      );
    }
    const sourceRows = (
      await pool.query(
        "select operation_id,envelope_kind,action_result from funding_receive_refund_candidates where event_id=$1 order by operation_id",
        [eventId],
      )
    ).rows;
    assert.deepEqual(
      sourceRows.map((row) => row.operation_id).sort(),
      [input.operationId, ...additionalOperations].sort(),
    );
    if (mergeScenario) {
      // Relational ownership moved, while the committed operation anchors the
      // original source/refund identity. Ordinary bounded reads now converge.
      assert.equal(rebound.kind, "ready_for_fence", JSON.stringify(rebound));
      for (const id of additionalOperations) {
        const imported = sourceRows.find((row) => row.operation_id === id);
        assert.equal(imported?.envelope_kind, "candidate");
        assert.notEqual(imported?.action_result, null);
      }
    } else {
      assert.equal(rebound.kind, "ready_for_fence", JSON.stringify(rebound));
    }
    if (rebound.kind === "ready_for_fence") {
      assert.deepEqual(
        rebound.dependencies.map((entry) => entry.operationId).sort(),
        [input.operationId, ...additionalOperations].sort(),
      );
    }
    assert.deepEqual(
      await tx(pool, (db) =>
        readReceiveRoleArbitrationInTransaction(db, {
          ...bound,
          retry: { ...staged.retry, leaseToken: randomUUID() },
        }),
      ),
      { kind: "incomplete", reason: "candidate_context_changed" },
    );
    assert.deepEqual(await counts(), { ...before, sessions: 1 });
    if (!mergeScenario) await verifySessionlessEventPlans(pool);
    console.log(
      `PASS sessionless checkpoint${mergeScenario ? " with actual terminal-source merge and converged original-owner classification" : ""}: real owner, E identity, per-tick resume, codec recovery, no financial effects and bound-lease re-enumeration`,
    );
  } finally {
    await tx(pool, async (db) => {
      // Exact generated fixture rows only; no runtime cleanup/merge claim.
      await db.query("set local session_replication_role=replica");
      if (eventId) {
        await db.query(
          "delete from funding_receive_refund_candidates where event_id=$1",
          [eventId],
        );
        await db.query(
          "delete from funding_receive_refund_scans where event_id=$1 and user_id=$2",
          [eventId, userId],
        );
        await db.query(
          "delete from funding_receive_canonical_events where id=$1",
          [eventId],
        );
      }
      if (sessionId)
        await db.query(
          "delete from funding_receive_sessions where id=$1 and user_id=$2",
          [sessionId, userId],
        );
    });
  }
}

async function verifySessionlessEventPlans(pool: Pool) {
  await tx(pool, async (db) => {
    // Production SQL on representative temporary relations. Financial guards
    // and real ownership are tested above; no public fixture rows are altered.
    await db.query(`create temp table funding_receive_sessions (
      id uuid primary key, user_id uuid not null) on commit drop`);
    await db.query(`create temp table funding_receive_canonical_events (
      id uuid primary key, network_id text not null, tx_hash text not null,
      event_index text not null, allocation_status text not null,
      classification_receive_session_id uuid,
      unique(network_id,tx_hash,event_index)) on commit drop`);
    const owner = randomUUID();
    await db.query(
      `insert into funding_receive_sessions
      select md5('role-session-'||ordinal)::uuid,$1::uuid
      from generate_series(1,50000) series_row(ordinal)`,
      [owner],
    );
    await db.query(`insert into funding_receive_canonical_events
      select md5('role-event-'||ordinal)::uuid,'evm:8453',md5(ordinal::text),'0',
        case when ordinal=2 then 'allocated' else 'pending' end,
        case when ordinal=3 then null else md5('role-session-'||ordinal)::uuid end
      from generate_series(1,50000) series_row(ordinal)`);
    await db.query("analyze funding_receive_sessions");
    await db.query("analyze funding_receive_canonical_events");
    await db.query(`create temp table funding_receive_refund_scans
      (like public.funding_receive_refund_scans including all) on commit drop`);
    await db.query(
      `insert into funding_receive_refund_scans
      (event_id,contract_version,user_id,receive_session_id,variant_id,source_exhausted)
      select id,2,$1,null,null,true from funding_receive_canonical_events`,
      [owner],
    );
    await db.query("analyze funding_receive_refund_scans");
    const metrics = [];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        `prepare role_event_plan(text,text,text,uuid) as ${SESSIONLESS_FUNDING_ROLE_EVENT_SQL}`,
      );
      for (const [name, ordinal, userId, rows] of [
        ["bound", 1, owner, 1],
        ["foreign", 1, randomUUID(), 1],
        ["allocated", 2, owner, 0],
        ["unbound", 3, owner, 1],
        ["missing", 50001, owner, 0],
      ] as const) {
        const plan = (
          await db.query(`explain(analyze,buffers,format json)
          execute role_event_plan('evm:8453',md5('${ordinal}'),'0','${userId}')`)
        ).rows[0]["QUERY PLAN"][0];
        const nodes: Record<string, unknown>[] = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(plan.Plan);
        assert.ok(!nodes.some((node) => node["Node Type"] === "Seq Scan"));
        assert.equal(plan.Plan["Actual Rows"], rows);
        const buffers =
          Number(plan.Plan["Local Hit Blocks"] ?? 0) +
          Number(plan.Plan["Local Read Blocks"] ?? 0);
        assert.ok(
          buffers <= 10,
          `exact event lookup must stay indexed: ${buffers}`,
        );
        metrics.push({ mode, name, buffers, ms: plan["Execution Time"] });
      }
      await db.query("deallocate role_event_plan");
      await db.query(
        `prepare role_adopt_plan(uuid,uuid,text,text) as ${RESTART_RECEIVE_ROLE_SCAN_SQL}`,
      );
      for (const [name, ordinal] of [
        ["adopt", 1],
        ["adopt-missing", 50001],
      ] as const) {
        await db.query("savepoint adoption_plan");
        const plan = (
          await db.query(`explain(analyze,buffers,format json)
          execute role_adopt_plan(md5('role-event-${ordinal}')::uuid,'${owner}','bound-test','test-fingerprint')`)
        ).rows[0]["QUERY PLAN"][0];
        const buffers =
          Number(plan.Plan["Local Hit Blocks"] ?? 0) +
          Number(plan.Plan["Local Read Blocks"] ?? 0);
        const indexed = plan.Plan.Plans[0];
        assert.equal(indexed["Node Type"], "Index Scan");
        assert.equal(indexed["Actual Rows"], name === "adopt" ? 1 : 0);
        assert.ok(
          buffers < 20,
          `adoption must update only the exact header: ${buffers}`,
        );
        metrics.push({ mode, name, buffers, ms: plan["Execution Time"] });
        await db.query("rollback to savepoint adoption_plan");
      }
      await db.query("deallocate role_adopt_plan");
    }
    console.log("Sessionless checkpoint PG16 plans", JSON.stringify(metrics));
  });
}

export function sessionlessCancellableSourceSteps(
  source: AssetLocation,
): FundingCommitPlan["steps"] {
  const action = {
    kind: "evm_transaction" as const,
    actionId: randomUUID(),
    networkId: source.asset.networkId,
    senderWalletId: randomUUID(),
    to: source.asset.assetId,
    data: new Interface([
      "function transfer(address to,uint256 amount) returns (bool)",
    ]).encodeFunctionData("transfer", [`0x${"ab".repeat(20)}`, 10000000n]),
    valueRaw: "0",
    gasLimitRaw: "100000",
  };
  return [
    {
      ordinal: 0,
      segmentOrdinal: 0,
      stepKind: "transaction",
      state: "action_required",
      actionFingerprint: canonicalJsonHash(action),
      executorId: "wallet_profile_evm_v1",
      payerRequirement: "privy_sponsor",
      dependsOnOrdinal: null,
      normalizedAction: action,
      actionValidationResult: { signerAddress: source.details.address },
    },
  ];
}

/** A real allowed merge imports an older source after enumeration. The receive
 * session must re-enumerate it, not reuse pre-session negative membership. */
export async function verifySessionlessMergeAdoptionPg(
  pool: Pool,
  fixture: FixtureFactory,
) {
  const steps = sessionlessCancellableSourceSteps;
  const anchor = await fixture(undefined, undefined, steps);
  const sourceId = (
    await pool.query(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`sessionless-merge-${randomUUID()}@example.com`],
    )
  ).rows[0].id;
  const imported = await fixture(
    { userId: sourceId, owner: anchor.owner },
    undefined,
    steps,
  );
  for (const item of [anchor, imported]) {
    const cancelled = await cancelFundingOperationForUser(pool, {
      userId: item.base.source.accountId,
      operationId: item.base.operationId,
    });
    assert.equal(cancelled.status, "cancelled");
    const reservations = (
      await pool.query(
        "select state from balance_reservations where operation_id=$1",
        [item.base.operationId],
      )
    ).rows;
    assert.ok(
      reservations.length > 0 &&
        reservations.every((row) => row.state === "released"),
    );
  }
  await verifySessionlessRoleCheckpointPg(pool, anchor, {
    beforeReceive: async () => {
      const result = await mergeUsersById(
        sourceId,
        anchor.base.source.accountId,
        { dryRun: false, keepSource: false },
        pool,
      );
      assert.equal(result.summary.fundingOperationsMoved, 1);
      assert.equal(result.summary.fundingReservationsMoved, 1);
      assert.equal(result.summary.sourceUserDeleted, 1);
      const moved = (
        await pool.query(
          `select operation_row.user_id,
          segment_row.source_snapshot#>>'{location,accountId}' as original_source_owner,
          segment_row.refund_location_snapshot->>'accountId' as original_refund_owner,
          reservation_row.created_at <= scan_row.scan_before as predates_checkpoint
         from funding_operations operation_row
         join funding_operation_segments segment_row on segment_row.operation_id=operation_row.id
         join balance_reservations reservation_row on reservation_row.operation_id=operation_row.id
         join funding_receive_refund_scans scan_row on scan_row.user_id=$2
         where operation_row.id=$1 and reservation_row.economic_role='source_input'`,
          [imported.base.operationId, anchor.base.source.accountId],
        )
      ).rows;
      assert.deepEqual(moved, [
        {
          user_id: anchor.base.source.accountId,
          original_source_owner: sourceId,
          original_refund_owner: sourceId,
          predates_checkpoint: true,
        },
      ]);
      // Represent an already committed v2 invalid result from before this
      // reader repair. Reusing its work token must still upgrade semantics.
      const prior = (
        await pool.query(
          "select event_id,last_lease_token from funding_receive_refund_scans where user_id=$1",
          [anchor.base.source.accountId],
        )
      ).rows[0];
      await pool.query(
        `insert into funding_receive_refund_candidates
        (event_id,reservation_id,operation_id,segment_id,envelope_kind,handoff_possible)
        select $1,id,operation_id,segment_id,'invalid',true from balance_reservations
        where operation_id=$2 and economic_role='source_input'`,
        [prior.event_id, imported.base.operationId],
      );
      await pool.query(
        "update funding_receive_refund_scans set contract_version=2 where event_id=$1",
        [prior.event_id],
      );
      const raw = anchor.evm[0];
      assert.ok(raw.ledgerHeight && raw.blockHash);
      const upgraded = await advanceSessionlessFundingRoleScan(pool, {
        userId: anchor.base.source.accountId,
        operationId: anchor.base.operationId,
        event: {
          ...raw,
          ledgerHeight: raw.ledgerHeight,
          blockHash: raw.blockHash,
          now: anchor.base.now,
        },
        limit: 1,
        progressToken: prior.last_lease_token ?? randomUUID(),
        referenceCodec: anchor.base.referenceCodec,
      });
      assert.equal(upgraded.kind, "source_restart");
      const after = (
        await pool.query(
          "select contract_version,source_exhausted from funding_receive_refund_scans where event_id=$1",
          [prior.event_id],
        )
      ).rows[0];
      assert.deepEqual(after, {
        contract_version: RECEIVE_ROLE_SCAN_CONTRACT_VERSION,
        source_exhausted: false,
      });
      return [imported.base.operationId];
    },
  });
}
