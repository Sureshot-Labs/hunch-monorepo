import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import {
  bindFundingReceiveCanonicalEventSession,
  createOrReuseFundingReceiveSession,
  lockFundingReceiveCanonicalEvents,
  lockFundingReceiveSessionScope,
  quarantineFundingReceiveCanonicalInternalEvent,
} from "../persistence/funding-receive-session-repository.js";
import {
  advanceReceiveRefundScan,
  checkpointReceiveRoleArbitrationInTransaction,
  readReceiveRoleArbitrationInTransaction,
  RECEIVE_ROLE_SCAN_CONTRACT_VERSION,
} from "../receive/receive-refund-scan.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { FundingReceiveSessionObserver } from "../receive/receive-session-observer.js";
import {
  syntheticCanonicalAnchor,
  withCanonicalRetryFixtureQueue,
} from "./recorded-role-observer-fixture.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import { verifyReceiveClassificationStagingPg } from "./receive-classification-staging-pg.js";

/** Actual exact reader -> committed checkpoint -> ordinary bounded worker page.
 * Synthetic legacy membership predates this operation; no financial authority
 * is inferred from the intentionally old source cutoff used by this fixture.
 * The input is a real legacy destination plan without a new exact-refund
 * contract; dummy unsubmitted steps test paging, not verified refund debits.
 */
export async function createRoleCheckpointTestSession(
  pool: Pool,
  data: ReturnType<typeof relayExactRefundTestFixture>,
) {
  const event = { ...data.evm[0], now: data.base.now };
  const userId = data.base.source.accountId;
  const variantId = randomUUID(),
    destinationOptionId = randomUUID(),
    venueBindingOptionId = randomUUID();
  const receiveTargetId = randomUUID();
  const target = {
    receiveTargetId,
    networkId: event.networkId,
    destinationAddress: event.destinationAddress,
    acceptedAssets: [{ asset: event.asset, handling: "direct" as const }],
    safeInstructions: [],
  };
  const session = await createOrReuseFundingReceiveSession(pool, {
    userId,
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
        safeLabel: "Offline test",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [target],
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
    receiveTargets: [target],
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
  return {
    event,
    userId,
    variantId,
    destinationOptionId,
    venueBindingOptionId,
    sessionId,
  };
}

export async function verifyReceiveLegacyRoleCheckpointPg(
  pool: Pool,
  data: ReturnType<typeof relayExactRefundTestFixture>,
  markedRefundSource = false,
) {
  const {
    event,
    userId,
    variantId,
    destinationOptionId,
    venueBindingOptionId,
    sessionId,
  } = await createRoleCheckpointTestSession(pool, data);
  let eventId: string | undefined;
  try {
    await verifyReceiveClassificationStagingPg(pool, {
      scope: { userId, destinationOptionId, venueBindingOptionId },
      event,
      sessionId,
      variantId,
    });
    await tx(pool, async (db) => {
      await lockFundingReceiveSessionScope(db, {
        userId,
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
    eventId = (
      await pool.query(
        "select id from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
        [event.networkId, event.transactionHash, event.eventIndex],
      )
    ).rows[0].id;
    assert.ok(eventId);
    const exactEventId = eventId;
    await pool.query(
      `insert into funding_receive_refund_scans
      (event_id,contract_version,user_id,receive_session_id,variant_id,scan_before,event_fingerprint)
      values($1,${RECEIVE_ROLE_SCAN_CONTRACT_VERSION},$2,$3,$4,'1970-01-01',$5)`,
      [
        eventId,
        userId,
        sessionId,
        variantId,
        receiveRoleEventFingerprint(event),
      ],
    );
    // Unsubmitted actions require multiple pages but imply no debit.
    await pool.query(
      `insert into funding_operation_steps
      (operation_id,segment_id,ordinal,step_kind,action_fingerprint,executor_id,payer_requirement,normalized_action,action_validation_result)
      select $1,$2,fixture_ordinal,'transaction',md5(fixture_ordinal::text),'wallet_profile_evm_v1','user',
        $3::jsonb||jsonb_build_object('actionId','legacy-checkpoint:'||fixture_ordinal),'{}'::jsonb from generate_series(0,3) fixture_ordinal`,
      [
        data.base.operationId,
        data.base.segmentId,
        {
          kind: "evm_transaction",
          networkId: event.networkId,
          senderWalletId: "offline-controller",
          to: event.asset.assetId,
          data: "0x",
          valueRaw: "0",
          gasLimitRaw: null,
        },
      ],
    );
    const referenceCodec = data.base.referenceCodec;
    await pool.query(
      `update funding_operation_segments set raw_status='pending',support_metadata=
      support_metadata||jsonb_build_object('relayTransactionReferenceFingerprints',jsonb_build_array($2::text)) where id=$1`,
      [data.base.segmentId, referenceCodec.fingerprint(event.transactionHash)],
    );
    const transactionReferenceCodec = {
      keyVersion: 1,
      fingerprint: () => "c".repeat(64),
      decrypt: () => {
        throw Error("no handoff");
      },
    };
    const claim = async () => {
      const leaseToken = randomUUID();
      await pool.query(
        "update funding_receive_canonical_events set classification_lease_token=$2 where id=$1",
        [eventId, leaseToken],
      );
      return {
        eventId: exactEventId,
        leaseToken,
        boundSessionId: sessionId,
        boundVariantId: variantId,
      };
    };
    const rows = async () =>
      (
        await pool.query(
          "select * from funding_receive_refund_candidates where event_id=$1 order by candidate_id",
          [eventId],
        )
      ).rows;
    const input = {
      userId,
      limit: 1,
      referenceCodec,
      transactionReferenceCodec,
    };
    const advance = async (extra = {}) =>
      advanceReceiveRefundScan(pool, {
        ...input,
        ...extra,
        retry: await claim(),
      });
    assert.equal((await advance()).kind, "source_page");
    assert.equal((await rows()).length, 0);
    const lease = await claim();
    // Failure after INSERT must not save half a checkpoint; same lease retries.
    await assert.rejects(
      tx(pool, async (db) => {
        const pending = await checkpointReceiveRoleArbitrationInTransaction(
          db,
          { ...input, retry: lease },
        );
        assert.equal(pending.kind, "incomplete");
        if (pending.kind === "incomplete")
          assert.equal(pending.pendingDestinations?.length, 1);
        throw Error("checkpoint-crash");
      }),
      /checkpoint-crash/,
    );
    assert.equal((await rows()).length, 0);
    const pending = await tx(pool, (db) =>
      checkpointReceiveRoleArbitrationInTransaction(db, {
        ...input,
        retry: lease,
      }),
    );
    assert.equal(pending.kind, "incomplete");
    const saved = (await rows())[0];
    assert.equal(saved.reservation_id, null);
    assert.equal(saved.operation_id, data.base.operationId);
    assert.equal(saved.segment_id, data.base.segmentId);
    assert.equal(saved.destination_progress.kind, "continuation");
    assert.equal(saved.destination_progress.cursor.stepOrdinal, 0);
    assert.equal(
      (
        await tx(pool, (db) =>
          checkpointReceiveRoleArbitrationInTransaction(db, {
            ...input,
            retry: lease,
          }),
        )
      ).kind,
      "incomplete",
    );
    assert.equal((await rows()).length, 1);
    assert.equal((await rows())[0].candidate_id, saved.candidate_id);
    // Fresh process/lease uses the committed cursor, not first-page replay.
    assert.equal((await advance()).kind, "action_page");
    assert.equal((await rows())[0].destination_progress.cursor.stepOrdinal, 1);
    for (let i = 0; i < 2; i++) await advance();
    assert.equal((await rows())[0].destination_progress.kind, "complete");
    const read = async () => {
      const retry = await claim();
      return tx(pool, (db) =>
        readReceiveRoleArbitrationInTransaction(db, { ...input, retry }),
      );
    };
    const complete = await read();
    assert.equal(complete.kind, "ready_for_fence", JSON.stringify(complete));
    if (complete.kind === "ready_for_fence")
      assert.deepEqual(
        complete.dependencies.map((v) => v.operationId),
        [data.base.operationId],
      );
    // A semantic update forces a normal local restart, retaining identity.
    await pool.query(
      "update funding_operation_segments set support_metadata=support_metadata||'{\"originTransactionReferenceCount\":1}' where id=$1",
      [data.base.segmentId],
    );
    await advance();
    assert.equal((await rows())[0].destination_progress, null);
    await advance();
    assert.equal((await rows())[0].destination_progress.match, "possible");
    await pool.query(
      "update funding_operation_segments set support_metadata=support_metadata-'originTransactionReferenceCount' where id=$1",
      [data.base.segmentId],
    );
    for (let i = 0; i < 5; i++) await advance();
    assert.equal((await rows())[0].destination_progress.kind, "complete");
    // Missing codec is diagnostic; restoring it rebuilds without manual clear.
    await advance({ referenceCodec: undefined });
    assert.equal(
      (await rows())[0].destination_progress.referenceRetryRequired,
      true,
    );
    for (let i = 0; i < 4; i++) await advance();
    assert.equal(
      (await rows())[0].destination_progress.referenceRetryRequired,
      false,
    );
    // Re-enumeration captures a real source reservation alongside—not instead
    // of—the prior exact witness. Neither captured dependency is deleted/rekeyed.
    await advance({ restartEnumeration: true });
    await advance();
    assert.equal((await rows()).length, 2);
    assert.equal(
      (await rows()).find((v) => v.reservation_id === null).candidate_id,
      saved.candidate_id,
    );
    for (let i = 0; i < 24; i++) await advance();
    const combined = await read();
    assert.equal(combined.kind, "ready_for_fence", JSON.stringify(combined));
    if (combined.kind === "ready_for_fence") {
      assert.equal(combined.dependencies.length, 1);
      assert.equal(
        combined.classification.kind,
        markedRefundSource ? "recovery_required" : "external",
      );
      if (markedRefundSource) {
        assert.deepEqual(combined.classification, {
          kind: "recovery_required",
          reason: "exact_refund_correlation_pending",
        });
        assert.ok(
          (await rows()).some(
            (candidate) =>
              candidate.reservation_id !== null &&
              candidate.envelope_kind === "candidate",
          ),
          "the real same-leg refund candidate must be captured before the first credit",
        );
      }
    }
    assert.equal(
      (
        await pool.query(
          "select allocated_receipt_id from funding_receive_canonical_events where id=$1",
          [eventId],
        )
      ).rows[0].allocated_receipt_id,
      null,
    );
    assert.equal(
      (
        await pool.query(
          "select count(*)::int as n from funding_receive_receipts where receive_session_id=$1",
          [sessionId],
        )
      ).rows[0].n,
      0,
    );
    console.log(
      "PASS committed legacy role continuation: exact discovery, crash/replay, bounded resume, revision/codec recovery, duplicate membership and no financial effects",
    );

    // Exercise the real joint publisher after changing provider facts. Existing
    // bounded retries must rebuild the invalidated summaries before effects.
    // Only the chain scan is synthetic; role readers, allocator and job wake run.
    await pool.query(
      `update funding_operation_segments set raw_status='success',support_metadata=
      support_metadata||$2::jsonb where id=$1`,
      [
        data.base.segmentId,
        {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: data.hashes.length,
          relaySuccessfulDestinationReferenceHashesV1: data.hashes.map(
            relayDestinationReferenceIdentity,
          ),
        },
      ],
    );
    const publicationCounts = async () =>
      (
        await pool.query(
          `select
      (select count(*)::int from funding_observations where operation_id=$1 and kind='destination_credit') as credits,
      (select count(*)::int from funding_receive_receipts where receive_session_id=$2) as receipts,
      (select count(*)::int from notifications where user_id=$3) as notifications,
      (select count(*)::int from funding_reconciliation_jobs where operation_id=$1) as jobs`,
          [data.base.operationId, sessionId, userId],
        )
      ).rows[0];
    let initialScanCalls = 0;
    let failedCreditWrites = 0;
    let lastPublicationDecision: unknown;
    const observer = new FundingReceiveSessionObserver({
      inspectCanonicalAnchor: syntheticCanonicalAnchor,
      transactionReferenceCodec,
      relayReferenceCodec: referenceCodec,
      readRoleArbitration: async (db, input) => {
        const decision = await checkpointReceiveRoleArbitrationInTransaction(
          db,
          input,
        );
        if (input.retry.eventId === eventId) lastPublicationDecision = decision;
        return decision;
      },
      scanCanonicalEvents: async (variants) => {
        initialScanCalls++;
        return {
          events: [data.evm[1], data.evm[1]].map((entry) => {
            assert.ok(
              entry.ledgerHeight && entry.blockHash && entry.sourceAddress,
            );
            return {
              variant: variants[0],
              transactionHash: entry.transactionHash,
              eventIndex: entry.eventIndex,
              blockNumber: entry.ledgerHeight,
              blockHash: entry.blockHash,
              sourceAddress: entry.sourceAddress,
              destinationAddress: entry.destinationAddress,
              rawAmount: entry.rawAmount,
              observedAt: entry.observedAt.toISOString(),
            };
          }),
          variants,
          cursorAdvanced: true,
        };
      },
    });
    const beforePublish = await publicationCounts();
    const failCreditPool = Object.create(pool) as Pool;
    failCreditPool.query = pool.query.bind(pool);
    failCreditPool.connect = (async () => {
      const db = await pool.connect();
      return new Proxy(db, {
        get(target, key) {
          if (key === "query")
            return async (sql: string, values?: unknown[]) => {
              if (
                sql.includes("insert into funding_observations") &&
                values?.[0] === data.base.operationId
              ) {
                failedCreditWrites++;
                throw Error("fixture-credit-write-failure");
              }
              return target.query(sql, values);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as PoolClient;
    }) as Pool["connect"];
    let publicationTick = 1;
    const nextNow = () =>
      new Date(event.now.getTime() + publicationTick++ * 1000);
    let failedPublicationErrors = 0;
    await withCanonicalRetryFixtureQueue(
      pool,
      { sessionId, through: new Date(event.now.getTime() + 120000) },
      async () => {
        for (let tick = 0; tick < 30 && !failedCreditWrites; tick++) {
          const result = await observer.pollKnownCanonicalRetryBatch(
            failCreditPool,
            {
              limit: 100,
              retryDelayMs: 1000,
              now: nextNow(),
            },
          );
          failedPublicationErrors += result.retryableErrors;
          assert.equal(result.receiptsRecorded, 0);
        }
        assert.equal(
          failedPublicationErrors,
          1,
          JSON.stringify({ lastPublicationDecision, candidates: await rows() }),
        );
        assert.equal(failedCreditWrites, 1);
        assert.equal(
          (lastPublicationDecision as { classification?: { kind?: string } })
            .classification?.kind,
          "internal_destination",
        );
        assert.equal(initialScanCalls, 0);
        assert.deepEqual(await publicationCounts(), beforePublish);
        assert.equal(
          (
            await pool.query(
              "select allocation_error_code from funding_receive_canonical_events where id=$1",
              [eventId],
            )
          ).rows[0].allocation_error_code,
          "exact_refund_correlation_pending",
        );
        const repairedPublish = await observer.pollKnownCanonicalRetryBatch(
          pool,
          {
            limit: 100,
            retryDelayMs: 1000,
            now: nextNow(),
          },
        );
        assert.equal(repairedPublish.retryableErrors, 0);
        assert.equal(repairedPublish.receiptsRecorded, 0);
        assert.equal(
          (await publicationCounts()).credits,
          beforePublish.credits + 1,
        );
        assert.deepEqual(
          (
            await pool.query(
              "select allocation_error_code,classification_lease_token from funding_receive_canonical_events where id=$1",
              [eventId],
            )
          ).rows[0],
          {
            allocation_error_code:
              "internal_owned_route_destination_suppressed",
            classification_lease_token: null,
          },
        );
        // Initial observation takes the same effects branch, including duplicate
        // physical input and replay. It must not create an external receipt/notice.
        for (let pass = 0; pass < 2; pass++) {
          const beforeCalls = initialScanCalls;
          for (let tick = 0; tick < 30; tick++) {
            const initial = await observer.pollBatch(pool, {
              limit: 100,
              minimumPollIntervalMs: 0,
              classificationRetryDelayMs: 1000,
              now: nextNow(),
            });
            assert.equal(initial.retryableErrors, 0);
            assert.equal(initial.receiptsRecorded, 0);
            if (
              (await publicationCounts()).credits ===
              beforePublish.credits + 2
            )
              break;
          }
          assert.ok(initialScanCalls > beforeCalls);
          assert.deepEqual(await publicationCounts(), {
            ...beforePublish,
            credits: beforePublish.credits + 2,
            jobs: 1,
          });
        }
        console.log(
          `PASS joint receive publisher (${markedRefundSource ? "same-leg exact destination excludes own pending refund" : "legacy destination"}): bounded actual retry and initial credit, replay, failed-credit rollback, no external receipt/notification`,
        );
      },
    );
  } finally {
    // Exact synthetic fixture cleanup, never an application lifecycle claim.
    await tx(pool, async (db) => {
      await db.query("set local session_replication_role=replica");
      // Initial publication creates a second event/header. Scope cleanup to
      // this generated owner/session, not only the historical retry event.
      const headers = await db.query<{ event_id: string }>(
        "select event_id from funding_receive_refund_scans where user_id=$1 and receive_session_id=$2",
        [userId, sessionId],
      );
      assert.ok(headers.rows.length <= data.hashes.length);
      await db.query(
        "delete from funding_receive_refund_candidates where event_id=any($1::uuid[])",
        [headers.rows.map((row) => row.event_id)],
      );
      await db.query(
        "delete from funding_receive_refund_scans where user_id=$1 and receive_session_id=$2",
        [userId, sessionId],
      );
      if (eventId) {
        await db.query(
          "delete from funding_receive_canonical_events where network_id=$1 and tx_hash=any($2::text[]) and (classification_receive_session_id=$3 or classification_receive_session_id is null)",
          [event.networkId, data.hashes, sessionId],
        );
      }
      await db.query(
        "delete from funding_receive_sessions where id=$1 and user_id=$2",
        [sessionId, userId],
      );
    });
  }
}
