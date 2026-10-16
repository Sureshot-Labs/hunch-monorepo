import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx, type Pool } from "@hunch/infra";
import {
  bindFundingReceiveCanonicalEventSession,
  createOrReuseFundingReceiveSession,
  lockFundingReceiveSessionScope,
  lockFundingReceiveCanonicalEvents,
  quarantineFundingReceiveCanonicalInternalEvent,
  LOCK_BOUND_RECEIVE_CLASSIFICATION_RETRY_SQL,
} from "../persistence/funding-receive-session-repository.js";
import {
  advanceReceiveRefundScan,
  clearReceiveRefundScanPageInTransaction,
  NEXT_RECEIVE_REFUND_CANDIDATE_SQL,
  READ_RECEIVE_REFUND_SCAN_SQL,
  DELETE_RECEIVE_REFUND_CANDIDATE_PAGE_SQL,
  RECEIVE_REFUND_CLEANUP_PAGE_SQL,
  readReceiveRoleArbitrationInTransaction,
  RECEIVE_ROLE_CANDIDATES_FIRST_PAGE_SQL,
  RECEIVE_ROLE_CANDIDATES_NEXT_PAGE_SQL,
  INSERT_RECEIVE_ROLE_CONTINUATIONS_SQL,
  RECEIVE_ROLE_SCAN_CONTRACT_VERSION,
} from "../receive/receive-refund-scan.js";
import type { verifyRefundSourceActionScanPg } from "./refund-source-action-scan-pg.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import {
  recordedRoleObserverFixture,
  withCanonicalRetryFixtureQueue,
} from "./recorded-role-observer-fixture.js";
import { refundCanonicalEventKey } from "../reconciliation/relay-exact-refund-classification.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import { receiveHandoffReferenceContext } from "../receive/receive-handoff-action-scan.js";
import { receiveDestinationReferenceContext } from "../receive/receive-destination-action-scan.js";

function queryFailurePool(pool: Pool, statement: string): Pool {
  const failed = Object.create(pool) as Pool;
  failed.query = pool.query.bind(pool);
  failed.connect = (async () => {
    const db = await pool.connect();
    return new Proxy(db, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, args?: unknown[]) => {
            if (sql.includes(statement))
              throw new Error("injected_checkpoint_failure");
            return target.query(sql, args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  return failed;
}

/** Explicit disposable PG16 suite. Real commits/leases and DB-only fixtures.
 * Not an allocation-authority or live financial test. */
export async function verifyReceiveRefundScanPg(
  pool: Pool,
  setup: Awaited<ReturnType<typeof verifyRefundSourceActionScanPg>>,
  sibling: ReturnType<typeof relayExactRefundTestFixture>,
) {
  const { data, identity } = setup;
  const event = { ...data.evm[0], now: data.base.now };
  const variantId = randomUUID();
  const receiveTargetId = randomUUID();
  const destinationOptionId = randomUUID();
  const venueBindingOptionId = randomUUID();
  const receiveTarget = {
    receiveTargetId,
    networkId: event.networkId,
    destinationAddress: event.destinationAddress,
    acceptedAssets: [{ asset: event.asset, handling: "direct" as const }],
    safeInstructions: [],
  };
  const session = await createOrReuseFundingReceiveSession(pool, {
    userId: identity.userId,
    venueId: "hyperliquid",
    destinationOptionId,
    venueBindingOptionId,
    destinationAsset: event.asset,
    destinationTargetSnapshot: {},
    venueBindingSnapshot: {},
    methods: [
      {
        methodId: randomUUID(),
        kind: "manual",
        safeLabel: "Test only",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [receiveTarget],
          recommendedReceiveTargetId: receiveTargetId,
          destinationOptionId,
          destinationAddress: event.destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(event.now.getTime() + 60000).toISOString(),
          safeInstructions: [],
        },
      },
    ],
    receiveTargets: [receiveTarget],
    selectedReceiveTargetId: receiveTargetId,
    observationVariants: [
      {
        variantId,
        networkId: event.networkId,
        asset: event.asset,
        destinationAddress: event.destinationAddress,
        destinationLocationId: data.base.source.locationId,
        baselineRaw: "0",
        baselineRevision: "offline",
        observation: {
          adapterId: "owned_wallet_liquid_balances_v1",
          payload: {
            eventCursorBlock: "100",
            eventConfirmations: 2,
            eventIdentity: "evm_erc20_transfer_v1",
          },
        },
        completion: { kind: "child_funding_operation" },
      },
    ],
    automationPolicy: {
      stableConversion: "automatic_within_caps",
      volatileConversion: "review_required",
      maximumFeeUsd: "1",
      maximumFeeBps: 500,
      maximumSlippageBps: 100,
    },
    policyVersion: 1,
    policyRevision: "offline-test",
    ownershipRevision: "offline-test",
    expiresAt: new Date(event.now.getTime() + 60000),
    observeUntil: new Date(event.now.getTime() + 120000),
    now: event.now,
  });
  const sessionId = session.snapshot.session.receiveSessionId;
  await tx(pool, async (db) => {
    await lockFundingReceiveSessionScope(db, {
      userId: identity.userId,
      destinationOptionId,
      venueBindingOptionId,
    });
    await lockFundingReceiveCanonicalEvents(db, [event]);
    await bindFundingReceiveCanonicalEventSession(db, event);
    await quarantineFundingReceiveCanonicalInternalEvent(db, {
      ...event,
      reason: "exact_refund_correlation_pending",
    });
  });
  const eventId = (
    await pool.query(
      "select id from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
      [event.networkId, event.transactionHash, event.eventIndex],
    )
  ).rows[0].id as string;
  // Isolate this fixture without claiming other tests' queued events. This is
  // the same token replacement serialized by E as the real indexed claimant.
  const claim = async () => {
    const leaseToken = randomUUID();
    await pool.query(
      "update funding_receive_canonical_events set classification_lease_token=$2 where id=$1",
      [eventId, leaseToken],
    );
    return {
      eventId,
      leaseToken,
      boundSessionId: sessionId,
      boundVariantId: variantId,
    };
  };
  const header = async () =>
    (await pool.query(READ_RECEIVE_REFUND_SCAN_SQL, [eventId])).rows[0];
  const candidates = async () =>
    (
      await pool.query(
        "select * from funding_receive_refund_candidates where event_id=$1 order by reservation_id",
        [eventId],
      )
    ).rows;
  const run = async (
    options: { restartEnumeration?: boolean; limit?: number } = {},
  ) =>
    advanceReceiveRefundScan(pool, {
      retry: await claim(),
      userId: identity.userId,
      limit: options.limit ?? 7,
      restartEnumeration: options.restartEnumeration,
    });
  try {
    const firstLease = await claim();
    assert.equal(
      (
        await advanceReceiveRefundScan(pool, {
          retry: firstLease,
          userId: randomUUID(),
          limit: 1,
        })
      ).kind,
      "unavailable",
    );
    assert.equal(
      await header(),
      undefined,
      "wrong owner cannot create a checkpoint",
    );
    assert.equal(
      (
        await advanceReceiveRefundScan(pool, {
          retry: { ...firstLease, boundVariantId: "wrong" },
          userId: identity.userId,
          limit: 1,
        })
      ).kind,
      "unavailable",
    );
    // Simulate process death after inserting children but before advancing the
    // source cursor. The same lease must still work because the entire tx rolls back.
    const faultPool = queryFailurePool(pool, "set source_cursor_created_at=$2");
    await assert.rejects(
      advanceReceiveRefundScan(faultPool, {
        retry: firstLease,
        userId: identity.userId,
        limit: 1,
      }),
      /injected_checkpoint_failure/,
    );
    assert.equal(await header(), undefined);
    assert.equal((await candidates()).length, 0);
    const replayRace = await Promise.all(
      [1, 2].map(() =>
        advanceReceiveRefundScan(pool, {
          retry: firstLease,
          userId: identity.userId,
          limit: 1,
        }),
      ),
    );
    assert.deepEqual(replayRace.map((r) => r.kind).sort(), [
      "replayed",
      "source_page",
    ]);
    assert.equal((await header()).progress_revision, "1");
    assert.match((await header()).source_cursor_created_at, /\.\d{6}Z$/);
    assert.equal((await candidates()).length, 1);
    const second = await run({ limit: 1 });
    assert.equal(second.kind, "source_page");
    assert.equal((await candidates()).length, 2);

    // Exercise the production retry caller, not just the standalone page API.
    // Only the unresolved recorded-role verdict is substituted: real claiming,
    // frozen-target lookup, event lease, checkpoint and acknowledgment run on PG.
    // An expired receive window must not rescan the chain or revive a Buy.
    const late = new Date(event.now.getTime() + 180000);
    await pool.query(
      "update funding_receive_sessions set status='expired',closed_at=$2 where id=$1",
      [sessionId, late],
    );
    const sessionState = async () =>
      (
        await pool.query(
          `select status,version,expires_at,observe_until,observation_variants,
            observation_start_variants from funding_receive_sessions where id=$1`,
          [sessionId],
        )
      ).rows[0];
    const beforeRetry = await sessionState();
    let scannerCalls = 0;
    const observer = recordedRoleObserverFixture({
      scanCanonicalEvents: async () => {
        scannerCalls++;
        throw new Error("known retry must not scan chain history");
      },
      scanCanonicalEventsBatch: async () => {
        scannerCalls++;
        throw new Error("known retry must not scan chain history");
      },
      listPotentialPolymarketHandoffs: async () => [],
      classifyRecordedRefunds: async (_db, input) =>
        new Map(
          input.events.map((entry) => [
            refundCanonicalEventKey(entry),
            {
              kind: "recovery_required" as const,
              reason: "exact_refund_receipt_not_final" as const,
            },
          ]),
        ),
    });
    // Keep unrelated retained fixture jobs outside this ONE retry assertion by
    // exercising the real claimant's SKIP LOCKED behavior. No queue timestamps,
    // tokens, production limits or financial authority are rewritten. The
    // separate timed-worker suite verifies global queue progress/fairness.
    await withCanonicalRetryFixtureQueue(
      pool,
      { sessionId, through: new Date(late.getTime() + 2000) },
      async () => {
        const firstPoll = await observer.pollKnownCanonicalRetryBatch(pool, {
          limit: 7,
          retryDelayMs: 1000,
          now: late,
        });
        assert.equal(firstPoll.retryableErrors, 0);
        assert.equal(firstPoll.refundScanErrors, 0);
        assert.ok(firstPoll.refundScanPages >= 1);
        assert.equal(firstPoll.receiptsRecorded, 0);
        assert.equal((await header()).progress_revision, "3");
        const retryAuthority = async () =>
          (
            await pool.query(
              "select classification_lease_token::text,classification_retry_at::text from funding_receive_canonical_events where id=$1",
              [eventId],
            )
          ).rows[0];
        const beforeSameTick = await retryAuthority();
        await observer.pollKnownCanonicalRetryBatch(pool, {
          limit: 7,
          retryDelayMs: 1000,
          now: late,
        });
        // The shared queue can legitimately advance other retained fixtures. Prove
        // this event was not reclaimed, rather than assuming a globally empty queue.
        assert.deepEqual(await retryAuthority(), beforeSameTick);
        assert.equal((await header()).progress_revision, "3");

        // A derived-checkpoint failure is reported separately and cannot disable
        // existing recorded-evidence repair. The ordinary next lease resumes it.
        const failedScanPool = queryFailurePool(
          pool,
          "insert into funding_receive_refund_scans",
        );
        const failedPoll = await observer.pollKnownCanonicalRetryBatch(
          failedScanPool,
          {
            limit: 7,
            retryDelayMs: 1000,
            now: new Date(late.getTime() + 1000),
          },
        );
        assert.equal(failedPoll.retryableErrors, 0);
        assert.ok(failedPoll.refundScanErrors >= 1);
        assert.equal(failedPoll.receiptsRecorded, 0);
        assert.equal((await header()).progress_revision, "3");
        const resumedPoll = await observer.pollKnownCanonicalRetryBatch(pool, {
          limit: 7,
          retryDelayMs: 1000,
          now: new Date(late.getTime() + 2000),
        });
        assert.equal(resumedPoll.refundScanErrors, 0);
        assert.equal(resumedPoll.retryableErrors, 0);
        assert.equal(resumedPoll.receiptsRecorded, 0);
        assert.equal((await header()).progress_revision, "4");
        assert.deepEqual(await sessionState(), beforeRetry);
        assert.equal(scannerCalls, 0);
        assert.equal((await header()).source_exhausted, true);
      },
    );
    assert.equal(
      (
        await advanceReceiveRefundScan(pool, {
          retry: firstLease,
          userId: identity.userId,
          limit: 1,
        })
      ).kind,
      "unavailable",
    );
    assert.equal(
      (await header()).progress_revision,
      "4",
      "reclaimed worker cannot overwrite progress",
    );
    await tx(pool, async (db) => {
      assert.equal(
        (
          await clearReceiveRefundScanPageInTransaction(db, {
            eventId,
            limit: 1,
          })
        ).kind,
        "retained",
      );
    });
    assert.equal((await candidates()).length, 2);

    const unavailableId = randomUUID();
    // A captured destination dependency outside this event's current envelope
    // must be checked and retained as a revision-bound negative, not dropped.
    // This also exercises the destination update lane under the actual E lease.
    await pool.query(
      "update funding_receive_refund_candidates set destination_possible=true where event_id=$1 and reservation_id=$2",
      [eventId, identity.reservationId],
    );
    await pool.query(
      `insert into funding_receive_refund_candidates
    (event_id,reservation_id,operation_id,segment_id,envelope_kind)
    values($1,$2,$3,$4,'candidate')`,
      [eventId, unavailableId, randomUUID(), randomUUID()],
    );
    // An unavailable tombstone cannot monopolize the lane. The dense valid source
    // eventually completes, retaining all candidates for later debit/fence checks.
    for (
      let i = 0;
      i < 100 &&
      !(await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      )?.action_result;
      i++
    ) {
      assert.equal((await run()).kind, "action_page");
    }
    const completed = (await candidates()).find(
      (r) => r.reservation_id === identity.reservationId,
    );
    assert.equal(completed.action_result.kind, "complete");
    assert.equal(completed.action_result.exposure.kind, "possible");
    assert.equal(completed.handoff_possible, true);
    assert.ok(
      completed.handoff_progress,
      "handoff cannot starve behind a dense refund page",
    );
    assert.equal(completed.destination_progress.kind, "complete");
    assert.equal(completed.destination_progress.match, "unrelated");
    assert.equal(completed.destination_progress.referenceRetryRequired, false);
    assert.equal(
      (await candidates()).find((r) => r.reservation_id === unavailableId)
        .diagnostic_code,
      "source_unavailable",
    );
    assert.equal(
      (await candidates()).length,
      3,
      "missing source is never dropped",
    );
    // Actual captured rows -> paged shared arbitration. The tombstone prevents
    // a verdict; isolating it in a rollback-only fixture shows ordinary ready
    // summaries retain BOTH positive and negative operation dependencies.
    for (let i = 0; i < 12; i++) await run();
    const arbitrationLease = await claim();
    await tx(pool, async (db) => {
      const input = {
        retry: arbitrationLease,
        userId: identity.userId,
        limit: 1,
        // Isolate the compact summary reader from exact indexed lanes here.
        // The latter have their own real-PG fixtures; missing codecs must not
        // silently turn a production exact lookup into an empty set.
        exactRoleEvidence: {
          eventFingerprint: receiveRoleEventFingerprint(event),
          handoffCodecContext:
            receiveHandoffReferenceContext(event).codecContext,
          destinationCodecContext:
            receiveDestinationReferenceContext(event).codecContext,
          pendingDestinations: [],
          handoff: { kind: "external" as const, reason: null },
          destination: { kind: "external" as const },
          dependencies: [],
        },
        refundEvidence: {
          kind: "recorded" as const,
          eventFingerprint: receiveRoleEventFingerprint(event),
          classification: { kind: "unmatched" as const },
          dependencies: [],
        },
      };
      assert.equal(
        (await readReceiveRoleArbitrationInTransaction(db, input)).kind,
        "incomplete",
      );
      await db.query("savepoint isolated_arbitration_fixture");
      try {
        const removed = await db.query(
          "delete from funding_receive_refund_candidates where event_id=$1 and reservation_id=$2",
          [eventId, unavailableId],
        );
        assert.equal(removed.rowCount, 1);
        const result = await readReceiveRoleArbitrationInTransaction(db, input);
        assert.equal(result.kind, "ready_for_fence", JSON.stringify(result));
        if (result.kind === "ready_for_fence") {
          assert.equal(result.classification.kind, "recovery_required");
          assert.deepEqual(
            result.dependencies.map((facts) => facts.operationId).sort(),
            [identity.operationId, sibling.base.operationId].sort(),
          );
        }
        const actualEvidence = await readReceiveRoleArbitrationInTransaction(
          db,
          {
            retry: arbitrationLease,
            userId: identity.userId,
            limit: 1,
            exactRoleEvidence: input.exactRoleEvidence,
          },
        );
        assert.deepEqual(
          await readReceiveRoleArbitrationInTransaction(db, {
            retry: arbitrationLease,
            userId: identity.userId,
            limit: 1,
          }),
          { kind: "incomplete", reason: "reference_recovery_pending" },
        );
        assert.equal(
          actualEvidence.kind,
          "ready_for_fence",
          JSON.stringify(actualEvidence),
        );
        if (actualEvidence.kind === "ready_for_fence") {
          assert.notEqual(actualEvidence.classification.kind, "external");
          assert.deepEqual(
            actualEvidence.dependencies
              .map((facts) => facts.operationId)
              .sort(),
            [identity.operationId, sibling.base.operationId].sort(),
          );
        }
        const wrongOwner = await readReceiveRoleArbitrationInTransaction(db, {
          ...input,
          userId: randomUUID(),
        });
        assert.equal(wrongOwner.kind, "incomplete");
        const stale = await readReceiveRoleArbitrationInTransaction(db, {
          ...input,
          retry: { ...arbitrationLease, leaseToken: randomUUID() },
        });
        assert.equal(stale.kind, "incomplete");
      } finally {
        await db.query("rollback to savepoint isolated_arbitration_fixture");
      }
    });
    assert.equal(
      (await candidates()).length,
      3,
      "the production dependency set is unchanged by rollback-only fixture isolation",
    );
    const oldRevision = completed.action_result.facts.revision;

    // Upgrade an existing v1 derived header without shrinking old membership or
    // requiring housekeeping deletion. Next ordinary lease re-enumerates.
    await pool.query(
      "update funding_receive_refund_scans set contract_version=1 where event_id=$1",
      [eventId],
    );
    assert.equal((await run()).kind, "source_restart");
    assert.equal(
      (await header()).contract_version,
      RECEIVE_ROLE_SCAN_CONTRACT_VERSION,
    );
    assert.equal((await candidates()).length, 3);
    assert.equal((await run()).kind, "source_page");
    assert.equal(
      (await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).action_result.facts.revision,
      oldRevision,
    );

    // Repair enumeration never purges dependencies. Unchanged rows keep their
    // revision-bound results, while newly valid envelopes can be rediscovered.
    assert.equal(
      (await run({ restartEnumeration: true })).kind,
      "source_restart",
    );
    assert.equal((await candidates()).length, 3);
    assert.equal((await header()).source_exhausted, false);
    assert.equal((await run()).kind, "source_page");
    assert.equal(
      (await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).action_result.facts.revision,
      oldRevision,
    );

    // Completed results are revisited too. Semantic action changes invalidate
    // only their candidate; ordinary queue turns rebuild it without a reset.
    await pool.query(
      `insert into funding_operation_step_attempts
    (step_id,attempt_number,canonical_action_fingerprint,executor_id)
    select step_id,52,canonical_action_fingerprint,executor_id from funding_operation_step_attempts
    where step_id=$1 and attempt_number=1`,
      [setup.stepIds[1]],
    );
    for (
      let i = 0;
      i < 9 &&
      (await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).action_result;
      i++
    )
      await run();
    assert.equal(
      (await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).action_result,
      null,
    );
    for (
      let i = 0;
      i < 100 &&
      !(await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).action_result;
      i++
    )
      await run();
    const refreshed = (await candidates()).find(
      (r) => r.reservation_id === identity.reservationId,
    ).action_result;
    assert.equal(refreshed.exposure.kind, "possible");
    assert.notEqual(refreshed.facts.revision, oldRevision);

    // Corrupted continuation restarts locally; other candidates/results survive.
    const siblingCandidate = (await candidates()).find(
      (r) => r.operation_id === sibling.base.operationId,
    );
    await pool.query(
      `update funding_receive_refund_candidates set action_result=null,
    action_continuation='{"version":999}',last_checked_revision=0,next_role='refund' where event_id=$1 and reservation_id=$2`,
      [eventId, siblingCandidate.reservation_id],
    );
    await run();
    assert.equal(
      (await candidates()).find(
        (r) => r.reservation_id === siblingCandidate.reservation_id,
      ).diagnostic_code,
      "facts_changed",
    );
    assert.equal(
      (await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).action_result.facts.revision,
      refreshed.facts.revision,
    );

    // Reproduce a previously captured dependency that no longer matches the
    // live source. Do not disable immutable-plan guards to reparent real money.
    // A new enumeration must retain the old identity, not silently overwrite it.
    const capturedOperationId = randomUUID();
    await pool.query(
      `update funding_receive_refund_candidates set operation_id=$3,
    action_result=null,action_continuation=null where event_id=$1 and reservation_id=$2`,
      [eventId, identity.reservationId, capturedOperationId],
    );
    await run({ restartEnumeration: true });
    await run();
    const mismatched = (await candidates()).find(
      (r) => r.reservation_id === identity.reservationId,
    );
    assert.equal(mismatched.operation_id, capturedOperationId);
    assert.equal(mismatched.diagnostic_code, "source_identity_changed");
    assert.equal(mismatched.action_result, null);
    for (let i = 0; i < 3; i++) await run();
    assert.equal(
      (await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).operation_id,
      capturedOperationId,
    );
    assert.equal(
      (await candidates()).find(
        (r) => r.reservation_id === identity.reservationId,
      ).action_result,
      null,
    );

    // Checkpoint persistence cannot create receipt, reservation or allocation.
    const finalEvent = (
      await pool.query(
        "select * from funding_receive_canonical_events where id=$1",
        [eventId],
      )
    ).rows[0];
    assert.equal(finalEvent.allocation_status, "recovery_required");
    assert.equal(finalEvent.allocated_receipt_id, null);
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from funding_receive_receipts where receive_session_id=$1",
          [sessionId],
        )
      ).rows[0].n,
      0,
    );
    await pool.query(
      "update funding_receive_canonical_events set allocation_error_code='internal_exact_refund_suppressed' where id=$1",
      [eventId],
    );
    assert.equal(
      (await run()).kind,
      "unavailable",
      "suppression cannot be revived by a claim token alone",
    );
    await tx(pool, async (db) => {
      assert.equal(
        (
          await clearReceiveRefundScanPageInTransaction(db, {
            eventId,
            limit: 1,
          })
        ).kind,
        "retained",
      );
      await quarantineFundingReceiveCanonicalInternalEvent(db, {
        ...event,
        reason: "exact_refund_receipt_not_final",
      });
    });
    assert.equal(
      (await candidates()).length,
      3,
      "reversible suppression must retain every dependency",
    );
    assert.equal((await run()).kind, "action_page");
    // Include an actual reservationless derived row in the existing committed
    // allocation/cleanup acceptance. This is checkpoint membership only; the
    // financial role verdict is substituted below, not proved by this fixture.
    await pool.query(
      `insert into funding_receive_refund_candidates
      (event_id,operation_id,segment_id,envelope_kind,destination_possible,next_role)
      values($1,$2,$3,'unrelated',true,'destination')`,
      [eventId, sibling.base.operationId, sibling.base.segmentId],
    );
    // This fixture isolates real finalization + durable cleanup by explicitly
    // substituting its financial verdict. Real joint authority is exercised by
    // receive-joint-publication-integration-tests, not this cleanup-only case.
    const allocatingObserver = recordedRoleObserverFixture({
      listPotentialPolymarketHandoffs: async () => [],
      classifyRecordedRefunds: async () => new Map(),
    });
    // This one-event cleanup fixture must win its own ordinary queue claim
    // even when prior retained test fixtures are due. Product ranking/claim SQL
    // is unchanged; the other PG/unit cases exercise fair real queue rotation.
    await pool.query(
      "update funding_receive_canonical_events set classification_retry_at='1970-01-01' where id=$1",
      [eventId],
    );
    const allocated = await allocatingObserver.pollKnownCanonicalRetryBatch(
      pool,
      {
        limit: 1,
        retryDelayMs: 1000,
        now: new Date(late.getTime() + 4000),
      },
    );
    assert.equal(allocated.retryableErrors, 0);
    assert.equal(allocated.receiptsRecorded, 1);
    assert.equal(
      (
        await pool.query(
          "select cleanup_ready from funding_receive_refund_scans where event_id=$1",
          [eventId],
        )
      ).rows[0].cleanup_ready,
      true,
    );
    assert.equal((await candidates()).length, 4);
    // Allocation is COMMITTED. A restart with a new observer instance must
    // reach cleanup even though this E can never enter the retry queue again.
    const cleanupObserver = recordedRoleObserverFixture();
    // Cleanup has no due-clock requirement. Keep classification admission
    // before every retained fixture so this cleanup-only case cannot consume
    // unrelated pending transfers left by a previous disposable suite run.
    const cleanupClock = new Date("1900-01-01T00:00:00Z");
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select id from funding_receive_canonical_events where id=$1 for update",
        [eventId],
      );
      const skipped = await cleanupObserver.pollKnownCanonicalRetryBatch(pool, {
        limit: 1,
        retryDelayMs: 1000,
        now: cleanupClock,
      });
      assert.equal(skipped.refundScanCleanupEvents, 0);
      assert.equal(skipped.refundScanCleanupErrors, 0);
      assert.equal((await candidates()).length, 4);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
    const cleanupFailure = await cleanupObserver.pollKnownCanonicalRetryBatch(
      queryFailurePool(
        pool,
        "update funding_receive_refund_scans set updated_at=clock_timestamp()",
      ),
      { limit: 1, retryDelayMs: 1000, now: cleanupClock },
    );
    assert.equal(cleanupFailure.refundScanCleanupErrors, 1);
    assert.equal(cleanupFailure.refundScanCleanupRows, 0);
    assert.equal(
      (await candidates()).length,
      4,
      "failed cleanup page rolls back all child deletes",
    );
    for (let i = 0; i < 4; i++) {
      const cleared = await cleanupObserver.pollKnownCanonicalRetryBatch(pool, {
        limit: 1,
        retryDelayMs: 1000,
        now: new Date(cleanupClock.getTime() + i * 1000),
      });
      assert.equal(cleared.eventsChecked, 0);
      assert.equal(cleared.refundScanCleanupErrors, 0);
      assert.equal(cleared.refundScanCleanupEvents, 1);
      assert.equal(cleared.refundScanCleanupRows, 1);
      assert.equal((await candidates()).length, 3 - i);
      assert.equal(Boolean(await header()), i !== 3);
    }
    console.log(
      "PASS durable refund scan: real expired retry caller, page failure/recovery, fair dense actions, real allocation and postcommit bounded cleanup/rollback/lock skip",
    );
    await verifyReceiveRefundScanPlans(pool, eventId, firstLease);
  } finally {
    // Disposable-fixture teardown, NOT a production financial deletion path.
    // Do not leak an open session into another suite's global observer batch.
    await tx(pool, async (db) => {
      const owned = await db.query(
        "select id from funding_receive_sessions where id=$1 and user_id=$2",
        [sessionId, identity.userId],
      );
      assert.equal(owned.rowCount, 1);
      await db.query("set local session_replication_role=replica");
      await db.query(
        "delete from funding_receive_refund_candidates where event_id=$1",
        [eventId],
      );
      await db.query(
        "delete from funding_receive_refund_scans where event_id=$1",
        [eventId],
      );
      await db.query(
        "delete from funding_receive_canonical_events where id=$1 and classification_receive_session_id=$2",
        [eventId, sessionId],
      );
      await db.query(
        "delete from funding_receive_receipts where receive_session_id=$1 and user_id=$2",
        [sessionId, identity.userId],
      );
      await db.query(
        "delete from funding_receive_sessions where id=$1 and user_id=$2",
        [sessionId, identity.userId],
      );
    });
  }
}

async function verifyReceiveRefundScanPlans(
  pool: Pool,
  eventId: string,
  retry: {
    eventId: string;
    leaseToken: string;
    boundSessionId: string;
    boundVariantId: string;
  },
) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    // Session-local copies keep performance fixtures out of durable test facts.
    for (const table of [
      "funding_receive_canonical_events",
      "funding_receive_refund_scans",
      "funding_receive_refund_candidates",
    ]) {
      await db.query(
        `create temp table ${table} (like public.${table} including all) on commit drop`,
      );
    }
    await db.query(
      `insert into funding_receive_canonical_events select * from public.funding_receive_canonical_events where id=$1`,
      [eventId],
    );
    await db.query(
      `update funding_receive_canonical_events set classification_lease_token=$2,
       allocation_status='recovery_required',allocated_receive_session_id=null,allocated_receipt_id=null,allocated_at=null,
       allocation_error_code='exact_refund_correlation_pending' where id=$1`,
      [eventId, retry.leaseToken],
    );
    await db.query(`insert into funding_receive_refund_scans(event_id,contract_version,user_id,receive_session_id,variant_id)
      select md5('scan:'||fixture_number)::uuid,1,gen_random_uuid(),gen_random_uuid(),'v'
      from generate_series(1,50000) fixture_number`);
    await db.query(`update funding_receive_refund_scans set cleanup_ready=true
      where event_id in (select event_id from funding_receive_refund_scans order by event_id limit 10)`);
    await db.query(
      `insert into funding_receive_refund_scans(event_id,contract_version,user_id,receive_session_id,variant_id)
      values($1,1,$2,$3,'v')`,
      [eventId, randomUUID(), retry.boundSessionId],
    );
    await db.query(`insert into funding_receive_refund_candidates
      (event_id,reservation_id,operation_id,segment_id,envelope_kind,action_result,last_checked_revision)
      select event_id,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'candidate',null,0
      from funding_receive_refund_scans`);
    await db.query(
      `insert into funding_receive_refund_candidates
      (event_id,reservation_id,operation_id,segment_id,envelope_kind,action_result,last_checked_revision,destination_possible,next_role)
      select $1,case when fixture_number%2=0 then null else gen_random_uuid() end,
        gen_random_uuid(),gen_random_uuid(),case when fixture_number%2=0 then 'unrelated' else 'candidate' end,
        case when fixture_number%2=1 then '{}'::jsonb else null end,fixture_number,
        fixture_number%2=0,case when fixture_number%2=0 then 'destination' else 'refund' end
      from generate_series(1,50000) fixture_number`,
      [eventId],
    );
    for (const table of [
      "funding_receive_canonical_events",
      "funding_receive_refund_scans",
      "funding_receive_refund_candidates",
    ])
      await db.query(`analyze ${table}`);
    const literal = (v: string) => `'${v.replaceAll("'", "''")}'`;
    await db.query(
      `prepare receive_scan_header(uuid) as ${READ_RECEIVE_REFUND_SCAN_SQL}`,
    );
    await db.query(
      `prepare receive_scan_candidate(uuid) as ${NEXT_RECEIVE_REFUND_CANDIDATE_SQL}`,
    );
    await db.query(
      `prepare receive_scan_lease(uuid,uuid,uuid,text) as ${LOCK_BOUND_RECEIVE_CLASSIFICATION_RETRY_SQL}`,
    );
    await db.query(
      `prepare receive_scan_cleanup(uuid,integer) as ${DELETE_RECEIVE_REFUND_CANDIDATE_PAGE_SQL}`,
    );
    await db.query(
      `prepare receive_scan_cleanup_due(integer) as ${RECEIVE_REFUND_CLEANUP_PAGE_SQL}`,
    );
    await db.query(
      `prepare receive_role_first(uuid,integer) as ${RECEIVE_ROLE_CANDIDATES_FIRST_PAGE_SQL}`,
    );
    await db.query(
      `prepare receive_role_next(uuid,integer,uuid) as ${RECEIVE_ROLE_CANDIDATES_NEXT_PAGE_SQL}`,
    );
    await db.query(
      `prepare receive_role_checkpoint(uuid,jsonb) as ${INSERT_RECEIVE_ROLE_CONTINUATIONS_SQL}`,
    );
    const resumeId = (
      await db.query(
        "select candidate_id from funding_receive_refund_candidates where event_id=$1 order by candidate_id offset 25000 limit 1",
        [eventId],
      )
    ).rows[0].candidate_id as string;
    const lastId = (
      await db.query(
        "select candidate_id from funding_receive_refund_candidates where event_id=$1 order by candidate_id desc limit 1",
        [eventId],
      )
    ).rows[0].candidate_id as string;
    // A one-row event table legitimately selects seqscan; enlarge it before
    // requiring indexed exact-lease probes on custom and generic plans.
    await db.query(
      `insert into funding_receive_canonical_events select copied_row.*
      from generate_series(1,50000) fixture_number cross join funding_receive_canonical_events template_row
      cross join lateral jsonb_populate_record(null::funding_receive_canonical_events,
        to_jsonb(template_row)||jsonb_build_object('id',gen_random_uuid(),'tx_hash','fixture:'||fixture_number)) copied_row
      where template_row.id=$1`,
      [eventId],
    );
    await db.query("analyze funding_receive_canonical_events");
    const legacyIndex = (
      await db.query(`select index_row.relname from pg_index index_spec
      join pg_class index_row on index_row.oid=index_spec.indexrelid
      where index_spec.indrelid='pg_temp.funding_receive_refund_candidates'::regclass
        and index_spec.indisunique and pg_get_expr(index_spec.indpred,index_spec.indrelid)='(reservation_id IS NULL)'`)
    ).rows[0].relname as string;
    const summaries: unknown[] = [];
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      await db.query(`set local plan_cache_mode=${mode}`);
      await db.query("savepoint checkpoint_insert_plan");
      const witness = {
        operation_id: randomUUID(),
        segment_id: randomUUID(),
        progress: {},
      };
      for (const duplicate of [false, true]) {
        // Session-local copied table only. The actual statement's conflict
        // arbiter must use the exact partial unique index, including replay.
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute receive_role_checkpoint(${literal(eventId)},${literal(JSON.stringify([witness]))})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        assert.deepEqual(plan.Plan["Conflict Arbiter Indexes"], [legacyIndex]);
        assert.equal(plan.Plan["Tuples Inserted"], duplicate ? 0 : 1);
        assert.equal(plan.Plan["Conflicting Tuples"], duplicate ? 1 : 0);
        summaries.push({
          name: duplicate
            ? "legacy-checkpoint-replay"
            : "legacy-checkpoint-insert",
          mode,
          ms: plan["Execution Time"],
          buffers:
            plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"],
        });
      }
      await db.query("rollback to savepoint checkpoint_insert_plan");
      for (const [name, prepared, args] of [
        ["header-hit", "receive_scan_header", [eventId]],
        ["header-miss", "receive_scan_header", [randomUUID()]],
        ["sparse-pending", "receive_scan_candidate", [eventId]],
        ["empty", "receive_scan_candidate", [randomUUID()]],
        ["cleanup-due", "receive_scan_cleanup_due", ["1"]],
        [
          "lease-hit",
          "receive_scan_lease",
          [
            eventId,
            retry.leaseToken,
            retry.boundSessionId,
            retry.boundVariantId,
          ],
        ],
        [
          "lease-stale",
          "receive_scan_lease",
          [eventId, randomUUID(), retry.boundSessionId, retry.boundVariantId],
        ],
      ] as const) {
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${prepared}(${args.map(literal).join(",")})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const visit = (node: Record<string, unknown>) => {
          assert.notEqual(node["Node Type"], "Seq Scan", name);
          if (node["Relation Name"]) {
            assert.ok(
              Number(node["Actual Rows"]) * Number(node["Actual Loops"]) <= 1,
              name,
            );
            assert.ok(Number(node["Rows Removed by Filter"] ?? 0) <= 1, name);
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            visit(child);
        };
        visit(plan.Plan);
        summaries.push({
          name,
          mode,
          ms: plan["Execution Time"],
          buffers:
            plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"],
        });
      }
    }
    for (const mode of ["force_custom_plan", "force_generic_plan"] as const) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const [name, prepared, args] of [
        ["role-first", "receive_role_first", [eventId, "51"]],
        ["role-resumed", "receive_role_next", [eventId, "51", resumeId]],
        ["role-empty-tail", "receive_role_next", [eventId, "51", lastId]],
        ["role-foreign", "receive_role_first", [randomUUID(), "51"]],
      ] as const) {
        const plan = (
          await db.query(
            `explain(analyze,buffers,format json) execute ${prepared}(${args.map(literal).join(",")})`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const verify = (node: Record<string, unknown>) => {
          assert.notEqual(node["Node Type"], "Seq Scan", name);
          if (node["Relation Name"]) {
            assert.ok(
              Number(node["Actual Rows"]) * Number(node["Actual Loops"]) <= 51,
              name,
            );
            assert.equal(Number(node["Rows Removed by Filter"] ?? 0), 0, name);
          }
          for (const child of (node.Plans ?? []) as Record<string, unknown>[])
            verify(child);
        };
        verify(plan.Plan);
        summaries.push({
          name,
          mode,
          ms: plan["Execution Time"],
          buffers:
            plan.Plan["Local Hit Blocks"] + plan.Plan["Local Read Blocks"],
        });
      }
      await db.query("savepoint bounded_cleanup_plan");
      const cleanup = (
        await db.query(
          `explain(analyze,buffers,format json) execute receive_scan_cleanup(${literal(eventId)},50)`,
        )
      ).rows[0]["QUERY PLAN"][0];
      const verifyCleanup = (node: Record<string, unknown>) => {
        assert.notEqual(
          node["Node Type"],
          "Seq Scan",
          "cleanup must not scan the entire candidate history",
        );
        if (node["Relation Name"])
          assert.ok(
            Number(node["Actual Rows"]) * Number(node["Actual Loops"]) <= 50,
            "cleanup must visit only its bounded page",
          );
        for (const child of (node.Plans ?? []) as Record<string, unknown>[])
          verifyCleanup(child);
      };
      verifyCleanup(cleanup.Plan);
      summaries.push({
        name: "cleanup-page",
        mode,
        ms: cleanup["Execution Time"],
        buffers:
          cleanup.Plan["Local Hit Blocks"] + cleanup.Plan["Local Read Blocks"],
      });
      await db.query("rollback to savepoint bounded_cleanup_plan");
    }
    for (const prepared of [
      "receive_scan_header",
      "receive_scan_candidate",
      "receive_scan_lease",
      "receive_scan_cleanup",
      "receive_scan_cleanup_due",
      "receive_role_first",
      "receive_role_next",
      "receive_role_checkpoint",
    ])
      await db.query(`deallocate ${prepared}`);
    console.log(
      "Receive refund scan PG16 representative plans",
      JSON.stringify(summaries),
    );
  } finally {
    await db.query("rollback");
    db.release();
  }
}
