import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import {
  CLAIM_STAGED_RECEIVE_CLASSIFICATION_SQL,
  bindFundingReceiveCanonicalEventSession,
  claimFundingReceiveClassificationRetries,
  finishFundingReceiveClassificationRetry,
  lockBoundFundingReceiveClassificationRetry,
  lockFundingReceiveCanonicalEvents,
  lockFundingReceiveSessionScope,
  quarantineFundingReceiveCanonicalInternalEvent,
  stageFundingReceiveClassificationBatch,
  type FundingReceiveCanonicalEventInput,
} from "../persistence/funding-receive-session-repository.js";

/** Real staging commit and recovery, using an existing isolated session fixture.
 * No fabricated exhausted scans, financial writes or provider traffic. */
export async function verifyReceiveClassificationStagingPg(
  pool: Pool,
  input: {
    scope: Parameters<
      typeof stageFundingReceiveClassificationBatch
    >[1]["scope"];
    event: FundingReceiveCanonicalEventInput;
    sessionId: string;
    variantId: string;
  },
) {
  const events = Array.from({ length: 5 }, () => ({
    ...input.event,
    transactionHash: `0x${randomBytes(32).toString("hex")}`,
  }));
  const now = input.event.now;
  const stage = (
    values = events.slice(0, 2),
    at = now,
    db = pool,
    scope = input.scope,
  ) =>
    stageFundingReceiveClassificationBatch(db, {
      scope,
      events: values,
      now: at,
      retryDelayMs: 1000,
    });
  const state = async () =>
    (
      await pool.query(
        `select id,allocation_status,allocation_error_code,classification_receive_session_id,
      classification_variant_id,classification_lease_token,classification_retry_at
      from funding_receive_canonical_events where tx_hash=any($1::text[]) order by id`,
        [events.map((v) => v.transactionHash)],
      )
    ).rows;
  const counts = async () =>
    (
      await pool.query(
        `select
      (select count(*)::int from funding_receive_receipts where receive_session_id=$1) as receipts,
      (select count(*)::int from notifications where user_id=$2) as notices,
      (select count(*)::int from funding_observations observation_row join funding_operations operation_row
        on operation_row.id=observation_row.operation_id where operation_row.user_id=$2) as observations`,
        [input.sessionId, input.scope.userId],
      )
    ).rows[0];
  try {
    const before = await counts();
    const staged = await stage([events[1], events[0], events[1]]);
    assert.equal(staged.length, 2);
    assert.ok(staged.every((v) => v.kind === "claimed"));
    const first = staged[0];
    assert.equal(first.kind, "claimed");
    if (first.kind !== "claimed")
      assert.fail("first stage must acquire a lease");
    assert.equal(first.retry.boundSessionId, input.sessionId);
    assert.equal(first.retry.boundVariantId, input.variantId);
    const firstState = await state();
    assert.deepEqual(await counts(), before);
    assert.ok(
      firstState.every(
        (v) => v.allocation_error_code === "exact_refund_correlation_pending",
      ),
    );
    assert.ok((await stage()).every((v) => v.kind === "deferred"));
    assert.deepEqual(
      await state(),
      firstState,
      "replay cannot extend or replace the lease",
    );

    // Acknowledgment removes a token but MUST NOT let a rescan skip its due time.
    await tx(pool, (db) =>
      finishFundingReceiveClassificationRetry(db, {
        retry: first.retry,
        receiveSessionId: input.sessionId,
        receiptsRecorded: 0,
      }),
    );
    const acknowledged = await state();
    assert.ok((await stage()).every((v) => v.kind === "deferred"));
    assert.deepEqual(await state(), acknowledged);
    const worker = await claimFundingReceiveClassificationRetries(pool, {
      now: new Date(now.getTime() + 1000),
      limit: 100,
      retryDelayMs: 1000,
    });
    for (const row of firstState) {
      const recovered = worker.find((v) => v.eventId === row.id);
      assert.ok(recovered, "ordinary worker must reclaim the staged event");
      assert.notEqual(recovered.leaseToken, row.classification_lease_token);
    }
    await tx(pool, async (db) => {
      assert.equal(
        await lockBoundFundingReceiveClassificationRetry(db, {
          retry: first.retry,
          userId: input.scope.userId,
        }),
        null,
        "old staged worker cannot consume a reclaimed lease",
      );
      await quarantineFundingReceiveCanonicalInternalEvent(db, {
        ...events[0],
        reason: "internal_handoff_suppressed",
      });
    });
    assert.equal(
      (await stage([events[0]], new Date(now.getTime() + 3000)))[0].kind,
      "settled",
    );

    // Same physical key with a different economic envelope rolls back the ENTIRE batch.
    const beforeCollision = await state();
    await assert.rejects(
      stage([
        events[2],
        {
          ...events[2],
          rawAmount: (BigInt(events[2].rawAmount) + 1n).toString(),
        },
      ]),
      /canonical receive event identity collision/,
    );
    assert.deepEqual(await state(), beforeCollision);

    // Failure after the exact claim has executed cannot leave a binding/lease.
    let failedClaims = 0;
    const failing = Object.create(pool) as Pool;
    failing.query = pool.query.bind(pool);
    failing.connect = (async () => {
      const db = await pool.connect();
      return new Proxy(db, {
        get(target, key) {
          if (key === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (sql === CLAIM_STAGED_RECEIVE_CLASSIFICATION_SQL) {
                failedClaims++;
                assert.equal(result.rowCount, 1);
                if (failedClaims === 2)
                  throw Error("fixture-stage-after-claim");
              }
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    }) as Pool["connect"];
    await assert.rejects(
      stage([events[2], events[3]], now, failing),
      /fixture-stage-after-claim/,
    );
    assert.equal(failedClaims, 2);
    assert.deepEqual(await state(), beforeCollision);

    const foreign = await stage([events[2]], now, pool, {
      ...input.scope,
      userId: randomUUID(),
    });
    assert.equal(foreign[0].kind, "foreign_owner");
    assert.equal(
      (await state()).find(
        (v) => v.id === (foreign[0] as { eventId: string }).eventId,
      ).classification_receive_session_id,
      null,
    );
    const recoveredForeign = await stage([events[2]]);
    assert.equal(
      recoveredForeign[0].kind,
      "claimed",
      "real selected owner can recover normally",
    );
    const missing = await stage([
      {
        ...events[3],
        destinationAddress: `0x${randomBytes(20).toString("hex")}`,
      },
    ]);
    assert.equal(missing[0].kind, "unbound");
    const missingRow = (await state()).find(
      (v) => v.id === (missing[0] as { eventId: string }).eventId,
    );
    assert.equal(missingRow.classification_receive_session_id, null);
    assert.equal(missingRow.classification_lease_token, null);
    await verifyStageWorkerClaimRace(pool, { ...input, event: events[4] });
    assert.deepEqual(await counts(), before);
    await verifyStagedClaimPlans(
      pool,
      first.retry.eventId,
      input.scope.userId,
      new Date(now.getTime() + 5000),
    );
    console.log(
      "PASS initial staging: frozen owner, duplicate/reversed replay, due lease/worker recovery, stale lease, final suppression, conflicting-envelope rollback, foreign/unbound and no financial effects",
    );
  } finally {
    await tx(pool, async (db) => {
      // Exact synthetic fixture cleanup, never an application deletion path.
      await db.query("set local session_replication_role=replica");
      await db.query(
        "delete from funding_receive_canonical_events where tx_hash=any($1::text[]) and allocated_receipt_id is null",
        [events.map((v) => v.transactionHash)],
      );
    });
  }
}

async function verifyStageWorkerClaimRace(
  pool: Pool,
  input: Parameters<typeof verifyReceiveClassificationStagingPg>[1],
) {
  await tx(pool, async (db) => {
    await lockFundingReceiveSessionScope(db, input.scope);
    await lockFundingReceiveCanonicalEvents(db, [input.event]);
    await bindFundingReceiveCanonicalEventSession(
      db,
      input.event,
      input.scope.userId,
    );
    await quarantineFundingReceiveCanonicalInternalEvent(db, {
      ...input.event,
      reason: "exact_refund_correlation_pending",
    });
  });
  let claimed: (id: string) => void = () => undefined;
  const claimReached = new Promise<string>((resolve) => {
    claimed = resolve;
  });
  let release: () => void = () => undefined;
  const continueStage = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = Object.create(pool) as Pool;
  held.query = pool.query.bind(pool);
  held.connect = (async () => {
    const db = await pool.connect();
    return new Proxy(db, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            const result = await target.query(sql, values);
            if (sql === CLAIM_STAGED_RECEIVE_CLASSIFICATION_SQL) {
              assert.equal(result.rowCount, 1);
              claimed(result.rows[0].id);
              await continueStage;
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PoolClient;
  }) as Pool["connect"];
  const now = input.event.now;
  const staging = stageFundingReceiveClassificationBatch(held, {
    scope: input.scope,
    events: [input.event],
    retryDelayMs: 1000,
    now,
  });
  try {
    const id = await Promise.race([
      claimReached,
      staging.then(() => {
        throw Error("staging finished before claim barrier");
      }),
    ]);
    await assert.rejects(
      tx(pool, async (db) => {
        await db.query(
          "select id from funding_receive_canonical_events where id=$1 for update nowait",
          [id],
        );
      }),
      (error: unknown) => (error as { code?: string }).code === "55P03",
    );
    const worker = await claimFundingReceiveClassificationRetries(pool, {
      now,
      limit: 100,
      retryDelayMs: 1000,
    });
    assert.ok(
      !worker.some((v) => v.eventId === id),
      "worker must skip the staged E lock",
    );
    release();
    const result = (await staging)[0];
    assert.equal(result.kind, "claimed");
    if (result.kind !== "claimed") assert.fail("expected committed stage");
    const retained = (
      await pool.query(
        "select classification_lease_token from funding_receive_canonical_events where id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(retained.classification_lease_token, result.retry.leaseToken);
    const next = new Date(now.getTime() + 1000);
    const reclaimed = (
      await claimFundingReceiveClassificationRetries(pool, {
        now: next,
        limit: 100,
        retryDelayMs: 1000,
      })
    ).find((v) => v.eventId === id);
    assert.ok(reclaimed);
    const replay = await stageFundingReceiveClassificationBatch(pool, {
      scope: input.scope,
      events: [input.event],
      retryDelayMs: 1000,
      now: next,
    });
    assert.equal(replay[0].kind, "deferred");
    assert.equal(
      (
        await pool.query(
          "select classification_lease_token from funding_receive_canonical_events where id=$1",
          [id],
        )
      ).rows[0].classification_lease_token,
      reclaimed.leaseToken,
    );
  } finally {
    release();
    await staging.catch(() => undefined);
  }
}

async function verifyStagedClaimPlans(
  pool: Pool,
  eventId: string,
  userId: string,
  now: Date,
) {
  await tx(pool, async (db) => {
    await db.query(
      "create temporary table funding_receive_canonical_events (like public.funding_receive_canonical_events including all) on commit drop",
    );
    await db.query(
      "create temporary table funding_receive_sessions (like public.funding_receive_sessions including all) on commit drop",
    );
    await db.query(
      "insert into funding_receive_canonical_events select * from public.funding_receive_canonical_events where id=$1",
      [eventId],
    );
    await db.query(
      "update funding_receive_canonical_events set allocation_status='recovery_required',allocation_error_code='exact_refund_correlation_pending'",
    );
    await db.query(
      "insert into funding_receive_sessions select * from public.funding_receive_sessions where id=(select classification_receive_session_id from funding_receive_canonical_events where id=$1)",
      [eventId],
    );
    await db.query(
      `insert into funding_receive_canonical_events select copied_row.*
      from funding_receive_canonical_events template_row cross join generate_series(1,50000) fixture_ordinal
      cross join lateral jsonb_populate_record(null::funding_receive_canonical_events,to_jsonb(template_row)||
        jsonb_build_object('id',gen_random_uuid(),'tx_hash','staged-plan-'||fixture_ordinal)) copied_row
      where template_row.id=$1`,
      [eventId],
    );
    await db.query(`insert into funding_receive_sessions select copied_row.*
      from funding_receive_sessions template_row cross join generate_series(1,50000) fixture_ordinal
      cross join lateral jsonb_populate_record(null::funding_receive_sessions,to_jsonb(template_row)||
        jsonb_build_object('id',md5(template_row.id::text||'-staged-'||fixture_ordinal)::uuid,'user_id',gen_random_uuid(),'destination_option_id',gen_random_uuid(),
          'venue_binding_option_id',gen_random_uuid(),'status','completed','closed_at',template_row.opened_at)) copied_row`);
    await db.query("analyze funding_receive_canonical_events");
    await db.query("analyze funding_receive_sessions");
    const metrics: unknown[] = [];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query(
        `prepare staged_claim_plan(uuid,uuid,timestamptz,timestamptz) as ${CLAIM_STAGED_RECEIVE_CLASSIFICATION_SQL}`,
      );
      for (const [name, id, owner, due] of [
        ["hit", eventId, userId, now],
        ["missing", randomUUID(), userId, now],
        ["foreign", eventId, randomUUID(), now],
        ["not_due", eventId, userId, new Date(0)],
      ] as const) {
        await db.query("savepoint stage_plan");
        // Values here are fixture-owned UUIDs and ISO dates, not request input.
        const plan = (
          await db.query(`explain(analyze,buffers,format json)
          execute staged_claim_plan('${id}','${owner}','${due.toISOString()}','${new Date(now.getTime() + 1000).toISOString()}')`)
        ).rows[0]["QUERY PLAN"][0];
        const nodes: Record<string, unknown>[] = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(plan.Plan);
        assert.ok(!nodes.some((v) => v["Node Type"] === "Seq Scan"));
        const buffers =
          Number(plan.Plan["Local Hit Blocks"] ?? 0) +
          Number(plan.Plan["Local Read Blocks"] ?? 0);
        assert.ok(
          buffers < 40,
          `exact staging query must stay PK-bounded: ${buffers}`,
        );
        assert.equal(plan.Plan["Actual Rows"], name === "hit" ? 1 : 0);
        metrics.push({ mode, name, buffers, ms: plan["Execution Time"] });
        await db.query("rollback to savepoint stage_plan");
      }
      await db.query("deallocate staged_claim_plan");
    }
    console.log("Receive initial staging PG16 plans", JSON.stringify(metrics));
  });
}
