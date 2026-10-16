import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { reconcileRelayDestinationReceipts } from "../reconciliation/relay-destination-receipts.js";
import { recordRelayExactRefundReceiptsInTransaction } from "../reconciliation/relay-exact-refund-receipts.js";
import {
  createOrReuseFundingReceiveSession,
  finalizeFundingReceiveCanonicalEventAllocation,
  insertFundingReceiveReceipt,
  lockFundingReceiveCanonicalEvents,
} from "../persistence/funding-receive-session-repository.js";
import { FundingClassificationChangedError } from "../persistence/funding-classification-revisions.js";
import { HYPERCORE_MAINNET_USDC } from "../domain/hypercore-identity.js";
import { hypercoreDestinationEvent } from "../../funding-providers/relay/hypercore-transfer-evidence.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import type { OwnedRouteCanonicalDestinationEvent } from "../reconciliation/owned-route-destination-observer.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { recordRefundSourceActionForTest } from "./refund-source-debit-fixture.js";
import { verifyDestinationTimedWorkerPg } from "./destination-timed-worker-pg.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

/** Real committed destination writer and E/O/F boundaries. Only the public
 * chain observer is substituted; no network, signatures or production data. */
export async function verifyDestinationReceiptPublicationPg(
  pool: Pool,
  fixture: (
    evm: boolean,
    existing?: { userId: string; owner: string },
  ) => Promise<Fixture>,
) {
  const publishMetadata = async (data: Fixture, hashes = data.hashes) => {
    await pool.query(
      `update funding_operation_segments set raw_status='success',
       support_metadata=support_metadata || $2::jsonb where id=$1`,
      [
        data.base.segmentId,
        {
          relayStatusCategory: "provider_success",
          destinationTransactionReferenceCount: hashes.length,
          relaySuccessfulDestinationReferenceHashesV1: hashes.map(
            relayDestinationReferenceIdentity,
          ),
        },
      ],
    );
  };
  const transactionReferenceCodec = createFundingTransactionReferenceCodec({
    encryptionKey: Buffer.alloc(32, 29),
    lookupHmacKey: "offline-destination-publication-test-key",
    keyVersion: 1,
  });
  const runOnce = (
    db: Pool,
    data: Fixture,
    events: readonly OwnedRouteCanonicalDestinationEvent[],
    deadlineMs = Date.now() + 60_000,
    limit = 1,
    onObservation?: () => void,
  ) =>
    reconcileRelayDestinationReceipts(
      db,
      {
        operationId: data.base.operationId,
        segmentId: data.base.segmentId,
        transactionHashes: events.map((event) => event.transactionHash),
        now: data.base.now,
        referenceCodec: data.base.referenceCodec,
        transactionReferenceCodec,
        work: {
          progressToken: randomUUID(),
          deadlineMs,
          limit,
        },
        requestId: data.base.requestId,
        status: {
          requestId: data.base.requestId,
          status: "success",
          txHashes: data.hashes,
        },
      },
      async () => {
        onObservation?.();
        return events;
      },
    );
  const run = async (
    db: Pool,
    data: Fixture,
    events: readonly OwnedRouteCanonicalDestinationEvent[],
  ) => {
    for (let tick = 0; tick < 100; tick++) {
      const result = await runOnce(db, data, events);
      if (!result.roleScanPending) return;
    }
    assert.fail(
      "ordinary destination job ticks did not finish bounded role work",
    );
  };
  const counts = async (data: Fixture) =>
    (
      await pool.query(
        `select
       (select count(*)::int from funding_observations where operation_id=$1 and kind='destination_credit') as credits,
       (select count(*)::int from funding_receive_canonical_events
         where tx_hash=any($2::text[]) and allocation_error_code='internal_owned_route_destination_suppressed') as suppressions,
       (select row_to_json(job_row) from funding_reconciliation_jobs job_row where operation_id=$1) as job_snapshot`,
        [data.base.operationId, data.hashes],
      )
    ).rows[0];

  const data = await fixture(true);
  await publishMetadata(data);
  const statements: string[] = [];
  const traced = Object.create(pool) as Pool;
  traced.query = pool.query.bind(pool);
  traced.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return (sql: string, values?: unknown[]) => {
            statements.push(sql);
            return target.query(sql, values);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  // Repeat one key and reverse input ordering: no missing prelock or double credit.
  await run(traced, data, [data.evm[1], data.evm[0], data.evm[1]]);
  const operationLock = statements.findIndex((sql) =>
    sql.includes("order by id for update"),
  );
  // Derived pages commit without O. The first financial transaction still
  // prelocks all three raw envelopes before its pure readers reacquire E.
  const financialBegin = statements.lastIndexOf("begin", operationLock);
  assert.ok(
    statements
      .slice(financialBegin, operationLock)
      .filter((sql) =>
        sql.includes("insert into funding_receive_canonical_events"),
      ).length >= 3,
  );
  let transaction: string[] = [];
  for (const sql of statements) {
    if (sql === "begin") transaction = [];
    transaction.push(sql);
    if (
      sql === "commit" &&
      !transaction.some((query) =>
        query.includes("select funding_classification_fence"),
      )
    )
      assert.equal(
        transaction.some((query) => query.includes("order by id for update")),
        false,
        "checkpoint transaction cannot acquire O after U",
      );
  }
  assert.ok(operationLock > 0);
  const lastFence = statements.findIndex((sql) =>
    sql.includes("select funding_classification_fence"),
  );
  assert.equal(statements[lastFence + 1], "commit");
  assert.equal(lastFence + 2, statements.length);
  assert.equal((await counts(data)).credits, 2);
  assert.equal((await counts(data)).suppressions, 2);
  await run(pool, data, data.evm);
  assert.equal(
    (await counts(data)).credits,
    2,
    "ordinary replay never doubles the physical credit",
  );

  // A codec outage is not evidence of an external transfer. Resume the SAME
  // physical event through ordinary job ticks once configuration recovers.
  const codecRecovery = await fixture(true);
  await publishMetadata(codecRecovery);
  const missingCodec = await reconcileRelayDestinationReceipts(
    pool,
    {
      operationId: codecRecovery.base.operationId,
      segmentId: codecRecovery.base.segmentId,
      transactionHashes: codecRecovery.hashes,
      now: codecRecovery.base.now,
      referenceCodec: codecRecovery.base.referenceCodec,
      work: {
        progressToken: randomUUID(),
        deadlineMs: Date.now() + 60_000,
        limit: 1,
      },
    },
    async () => codecRecovery.evm,
  );
  assert.equal(missingCodec.roleScanPending, true);
  assert.equal((await counts(codecRecovery)).credits, 0);
  await run(pool, codecRecovery, codecRecovery.evm);
  assert.equal((await counts(codecRecovery)).credits, 2);

  // The actual worker's runtime batch size must permit bounded local drain;
  // one page per two-second queue tick can otherwise manufacture a 90s timeout.
  const drained = await fixture(true);
  await publishMetadata(drained);
  let drainObservations = 0;
  assert.equal(
    (
      await runOnce(pool, drained, drained.evm, Date.now() + 30_000, 25, () => {
        drainObservations++;
      })
    ).roleScanPending,
    false,
    "all ordinary source/role pages and publication finish under one real lease deadline",
  );
  assert.equal((await counts(drained)).credits, 2);
  assert.equal(
    drainObservations,
    1,
    "bounded local pages never repeat provider/RPC observation",
  );
  const totalPages = Number(
    (
      await pool.query(
        `select coalesce(sum(scan_row.progress_revision),0)::text as total_pages
    from funding_receive_refund_scans scan_row join funding_receive_canonical_events event_row on event_row.id=scan_row.event_id
    where event_row.network_id=$1 and event_row.tx_hash=any($2::text[])`,
        [drained.evm[0].networkId, drained.hashes],
      )
    ).rows[0].total_pages,
  );
  assert.ok(
    totalPages > 1 && totalPages <= 25,
    "derived pages respect the configured invocation budget",
  );

  // A checkpoint is NOT anchor-repair authority. Strict upsert still rejects
  // remine until exact-chain proof and the common unowned CAS repair succeed.
  const pendingAnchor = await fixture(true);
  await publishMetadata(pendingAnchor);
  assert.equal(
    (await runOnce(pool, pendingAnchor, pendingAnchor.evm)).roleScanPending,
    true,
  );
  const anchorClient = await pool.connect();
  const anchorEvent = pendingAnchor.evm[0];
  assert.ok(anchorEvent.ledgerHeight && anchorEvent.blockHash);
  try {
    await anchorClient.query("begin");
    await assert.rejects(
      lockFundingReceiveCanonicalEvents(anchorClient, [
        {
          ...anchorEvent,
          ledgerHeight: (BigInt(anchorEvent.ledgerHeight) + 1n).toString(),
          blockHash: `0x${"c8".repeat(32)}`,
          now: pendingAnchor.base.now,
        },
      ]),
      /canonical receive event identity collision/,
    );
    await anchorClient.query("rollback");
    assert.equal((await counts(pendingAnchor)).credits, 0);
    const stored = (
      await pool.query(
        "select ledger_height::text,block_hash from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
        [
          anchorEvent.networkId,
          anchorEvent.transactionHash,
          anchorEvent.eventIndex,
        ],
      )
    ).rows[0];
    assert.deepEqual(stored, {
      ledger_height: anchorEvent.ledgerHeight,
      block_hash: anchorEvent.blockHash,
    });
    const replacementEvent = {
      ...anchorEvent,
      ledgerHeight: (BigInt(anchorEvent.ledgerHeight) + 1n).toString(),
      blockHash: `0x${"c8".repeat(32)}`,
    };
    let inspections = 0;
    const repaired = await reconcileRelayDestinationReceipts(
      pool,
      {
        operationId: pendingAnchor.base.operationId,
        segmentId: pendingAnchor.base.segmentId,
        transactionHashes: [anchorEvent.transactionHash],
        now: pendingAnchor.base.now,
        referenceCodec: pendingAnchor.base.referenceCodec,
        transactionReferenceCodec,
        work: {
          progressToken: randomUUID(),
          deadlineMs: Date.now() + 5000,
          limit: 1,
        },
        inspectCanonicalAnchor: async ({ expected }) => {
          inspections++;
          assert.equal(expected.blockHash, anchorEvent.blockHash);
          return {
            kind: "replacement_verified",
            eventFingerprint: receiveRoleEventFingerprint(expected),
            previousCanonicalHash: `0x${"d9".repeat(32)}`,
            ledgerHeight: replacementEvent.ledgerHeight,
            blockHash: replacementEvent.blockHash,
          };
        },
      },
      async () => [replacementEvent],
    );
    assert.deepEqual(repaired, {
      roleScanPending: true,
      reason: "role_canonical_anchor_pending",
    });
    assert.equal(inspections, 1);
    assert.equal(
      (await counts(pendingAnchor)).credits,
      0,
      "remine metadata transaction cannot publish money",
    );
    await run(pool, pendingAnchor, [replacementEvent]);
    assert.equal(
      (await counts(pendingAnchor)).credits,
      1,
      "next ordinary sessionless job publishes B exactly once",
    );
    assert.deepEqual(
      (
        await pool.query(
          `select ledger_height,block_hash from funding_observations
      where operation_id=$1 and kind='destination_credit' and tx_hash=$2 and event_index=$3`,
          [
            pendingAnchor.base.operationId,
            replacementEvent.transactionHash,
            replacementEvent.eventIndex,
          ],
        )
      ).rows,
      [
        {
          ledger_height: replacementEvent.ledgerHeight,
          block_hash: replacementEvent.blockHash,
        },
      ],
    );
    await run(pool, pendingAnchor, [replacementEvent]);
    assert.equal((await counts(pendingAnchor)).credits, 1);
  } finally {
    await anchorClient.query("rollback");
    anchorClient.release();
  }

  const deadlineRecovery = await fixture(true);
  await publishMetadata(deadlineRecovery);
  const expired = await runOnce(
    pool,
    deadlineRecovery,
    deadlineRecovery.evm,
    Date.now() - 1,
  );
  assert.deepEqual(expired, {
    roleScanPending: true,
    reason: "role_work_budget_exhausted",
  });
  assert.equal((await counts(deadlineRecovery)).credits, 0);
  const deadlineHolder = await pool.connect();
  try {
    await deadlineHolder.query("begin");
    await lockFundingReceiveCanonicalEvents(
      deadlineHolder,
      deadlineRecovery.evm.map((event) => {
        assert.ok(event.ledgerHeight && event.blockHash);
        return {
          ...event,
          ledgerHeight: event.ledgerHeight,
          blockHash: event.blockHash,
          now: deadlineRecovery.base.now,
        };
      }),
    );
    await deadlineHolder.query("commit");
    await deadlineHolder.query("begin");
    await deadlineHolder.query(
      `select id from funding_receive_canonical_events
       where network_id=$1 and tx_hash=any($2::text[])
       order by tx_hash,event_index for update`,
      [deadlineRecovery.evm[0].networkId, deadlineRecovery.hashes],
    );
    const timedOut = await runOnce(
      pool,
      deadlineRecovery,
      deadlineRecovery.evm,
      Date.now() + 100,
    );
    assert.deepEqual(
      timedOut,
      { roleScanPending: true, reason: "role_work_budget_exhausted" },
      "E wait uses the existing remaining lease budget",
    );
    assert.equal((await counts(deadlineRecovery)).credits, 0);
  } finally {
    await deadlineHolder.query("rollback");
    deadlineHolder.release();
  }
  await run(pool, deadlineRecovery, deadlineRecovery.evm);
  assert.equal(
    (await counts(deadlineRecovery)).credits,
    2,
    "fresh ordinary work deadline recovers without clearing summaries",
  );

  // A negative sibling is a real dependency even though it has no attempt,
  // reference or positive match. A no-O supported writer changes that negative
  // after the publication effects and before F; the entire batch must roll back.
  const negativeTarget = await fixture(true);
  const negative = await fixture(true, {
    userId: negativeTarget.base.source.accountId,
    owner: negativeTarget.owner,
  });
  await recordRefundSourceActionForTest(pool, negative, "unsubmitted");
  await publishMetadata(negativeTarget);
  let negativeChanged = false;
  let fencedIds: string[] = [];
  const negativeRace = Object.create(pool) as Pool;
  negativeRace.query = pool.query.bind(pool);
  negativeRace.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            if (
              !negativeChanged &&
              sql.includes("select funding_classification_fence")
            ) {
              fencedIds = JSON.parse(String(values?.[0])).map(
                (facts: { operationId: string }) => facts.operationId,
              );
              assert.ok(
                fencedIds.includes(negative.base.operationId),
                "negative sibling participates in final F",
              );
              await pool.query(
                "update funding_operation_segments set raw_status='pending' where id=$1",
                [negative.base.segmentId],
              );
              negativeChanged = true;
            }
            return target.query(sql, values);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  const negativeBefore = await counts(negativeTarget);
  await assert.rejects(
    run(negativeRace, negativeTarget, negativeTarget.evm),
    FundingClassificationChangedError,
  );
  assert.equal(negativeChanged, true);
  assert.deepEqual(await counts(negativeTarget), negativeBefore);
  await run(pool, negativeTarget, negativeTarget.evm);
  assert.equal(
    (await counts(negativeTarget)).credits,
    2,
    "changed negative resumes without new route or signature",
  );

  const collision = await fixture(true);
  const refundClient = await pool.connect();
  try {
    await refundClient.query("begin");
    assert.equal(
      (
        await recordRelayExactRefundReceiptsInTransaction(refundClient, {
          ...collision.base,
          evmEvents: [collision.evm[0]],
        })
      ).kind,
      "partial",
    );
    await refundClient.query("commit");
  } finally {
    await refundClient.query("rollback");
    refundClient.release();
  }
  await publishMetadata(collision);
  const before = await counts(collision);
  // A later batch member's conflict rolls back the earlier speculative credit too.
  let conflictReason: string | undefined;
  for (let tick = 0; tick < 100; tick++) {
    const publication = await runOnce(pool, collision, [
      collision.evm[1],
      collision.evm[0],
    ]);
    assert.equal(publication.roleScanPending, true);
    conflictReason = publication.reason;
    if (conflictReason === "internal_event_classification_conflict") break;
  }
  assert.equal(conflictReason, "internal_event_classification_conflict");
  assert.deepEqual(
    await counts(collision),
    before,
    "no destination receipt, suppression or wake on conflict",
  );

  const allocated = await fixture(true);
  const received = allocated.evm[0];
  const scopeId = randomUUID();
  const target = {
    receiveTargetId: scopeId,
    networkId: received.networkId,
    destinationAddress: received.destinationAddress,
    acceptedAssets: [{ asset: received.asset, handling: "direct" as const }],
    safeInstructions: [],
  };
  const session = await createOrReuseFundingReceiveSession(pool, {
    userId: allocated.base.source.accountId,
    venueId: "limitless",
    destinationOptionId: scopeId,
    venueBindingOptionId: scopeId,
    destinationAsset: received.asset,
    destinationTargetSnapshot: {},
    venueBindingSnapshot: {},
    methods: [
      {
        methodId: scopeId,
        kind: "manual",
        safeLabel: "Test only",
        ingress: {
          ingressKind: "manual",
          sourceNetworkId: null,
          sourceAsset: null,
          receiveTargets: [target],
          recommendedReceiveTargetId: scopeId,
          destinationOptionId: scopeId,
          destinationAddress: received.destinationAddress,
          requestedAmount: null,
          amountSemantics: "minimum",
          expiresAt: new Date(allocated.baseTime + 60000).toISOString(),
          safeInstructions: [],
        },
      },
    ],
    receiveTargets: [target],
    selectedReceiveTargetId: scopeId,
    observationVariants: [
      {
        variantId: scopeId,
        networkId: received.networkId,
        asset: received.asset,
        destinationAddress: received.destinationAddress,
        destinationLocationId: scopeId,
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
        completion: { kind: "direct_destination_credit" },
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
    now: allocated.base.now,
    expiresAt: new Date(allocated.baseTime + 60000),
    observeUntil: new Date(allocated.baseTime + 120000),
  });
  const sessionId = session.snapshot.session.receiveSessionId;
  const allocator = await pool.connect();
  try {
    await allocator.query("begin");
    await lockFundingReceiveCanonicalEvents(allocator, [
      { ...received, now: allocated.base.now },
    ]);
    const receipt = await insertFundingReceiveReceipt(allocator, {
      receiveSessionId: sessionId,
      userId: allocated.base.source.accountId,
      variantId: scopeId,
      asset: received.asset,
      destinationAddress: received.destinationAddress,
      rawAmount: received.rawAmount,
      observationRevision: scopeId,
      observedAt: received.observedAt,
      handling: "direct",
      status: "ready",
      evidence: {},
      now: allocated.base.now,
      canonicalEvent: received,
    });
    const eventId = (
      await allocator.query(
        "select id from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
        [received.networkId, received.transactionHash, received.eventIndex],
      )
    ).rows[0].id;
    assert.equal(
      await finalizeFundingReceiveCanonicalEventAllocation(allocator, {
        eventId,
        receiveSessionId: sessionId,
        receiptId: receipt.receipt.receiptId,
        now: allocated.base.now,
      }),
      true,
    );
    await allocator.query("commit");
    await publishMetadata(allocated);
    const allocatedBefore = await counts(allocated);
    assert.equal(
      (await runOnce(pool, allocated, [allocated.evm[1], received]))
        .roleScanPending,
      true,
    );
    assert.deepEqual(
      await counts(allocated),
      allocatedBefore,
      "already-external credit rolls back whole destination batch",
    );
    assert.equal(
      (
        await pool.query(
          "select allocation_status from funding_receive_canonical_events where id=$1",
          [eventId],
        )
      ).rows[0].allocation_status,
      "allocated",
    );
  } finally {
    await allocator.query("rollback");
    // Exact disposable fixture cleanup, not a production lifecycle/delete test.
    await allocator.query("begin");
    await allocator.query("set local session_replication_role=replica");
    await allocator.query(
      "delete from funding_receive_canonical_events where allocated_receive_session_id=$1",
      [sessionId],
    );
    await allocator.query(
      "delete from funding_receive_receipts where receive_session_id=$1",
      [sessionId],
    );
    await allocator.query("delete from funding_receive_sessions where id=$1", [
      sessionId,
    ]);
    await allocator.query("commit");
    allocator.release();
  }

  const stale = await fixture(true);
  await publishMetadata(stale);
  let changed = false;
  const concurrent = Object.create(pool) as Pool;
  concurrent.query = pool.query.bind(pool);
  concurrent.connect = (async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === "query")
          return async (sql: string, values?: unknown[]) => {
            if (
              !changed &&
              sql.includes("select funding_classification_fence")
            ) {
              changed = true;
              // Real supported segment writer without O; its deferred F touch
              // commits after classification but before the publication fence.
              await publishMetadata(stale, []);
            }
            return target.query(sql, values);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as Pool["connect"];
  const staleBefore = await counts(stale);
  await assert.rejects(
    run(concurrent, stale, stale.evm),
    FundingClassificationChangedError,
  );
  assert.equal(changed, true);
  assert.deepEqual(
    await counts(stale),
    staleBefore,
    "stale target fence rolls back all effects",
  );
  await publishMetadata(stale);
  await run(pool, stale, stale.evm);
  assert.equal(
    (await counts(stale)).credits,
    2,
    "ordinary retry recovers without a new route or delay",
  );

  const held = await fixture(true);
  await publishMetadata(held);
  const holder = await pool.connect();
  const waiter = await pool.connect();
  let pending: Promise<void> | undefined;
  try {
    await holder.query("begin");
    await lockFundingReceiveCanonicalEvents(
      holder,
      held.evm.map((event) => ({ ...event, now: held.base.now })),
    );
    await holder.query("commit");
    await holder.query("begin");
    await holder.query(
      `select id from funding_receive_canonical_events
       where network_id=$1 and tx_hash=any($2::text[])
       order by tx_hash,event_index for update`,
      [held.evm[0].networkId, held.hashes],
    );
    const pid = (await waiter.query("select pg_backend_pid() as pid")).rows[0]
      .pid;
    const dedicated = {
      query: waiter.query.bind(waiter),
      connect: async () => ({ query: waiter.query.bind(waiter), release() {} }),
    } as unknown as Pool;
    pending = run(dedicated, held, [...held.evm].reverse());
    void pending.catch(() => undefined);
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        (
          await pool.query(
            "select cardinality(pg_blocking_pids($1)) > 0 as blocked",
            [pid],
          )
        ).rows[0].blocked
      ) {
        blocked = true;
        break;
      }
    }
    assert.equal(
      blocked,
      true,
      "destination publication really waits for the receive E lock",
    );
    await holder.query("commit");
    await pending;
    assert.equal((await counts(held)).credits, 2);
  } finally {
    await holder.query("rollback");
    if (pending) await pending;
    holder.release();
    waiter.release();
  }

  const native = await fixture(false);
  await publishMetadata(native);
  const event = hypercoreDestinationEvent(
    {
      networkId: HYPERCORE_MAINNET_USDC.networkId,
      asset: HYPERCORE_MAINNET_USDC,
      owner: native.owner,
      direction: "credit",
      transactionHash: native.hashes[0],
      nonce: native.baseTime,
      sourceAddress: `0x${"ab".repeat(20)}`,
      destinationAddress: native.owner,
      sourceDex: "",
      destinationDex: "spot",
      rawAmount: "980000000",
      ledgerTime: native.baseTime,
      providerBlock: 123,
      evidenceFingerprint: "d".repeat(64),
    },
    native.base.now,
  );
  await run(pool, native, [event]);
  await run(pool, native, [event]);
  assert.equal(
    (await counts(native)).credits,
    1,
    "native positive control survives unsupported EVM role readers",
  );
  assert.equal(
    (await counts(native)).suppressions,
    0,
    "native ledger does not fabricate an EVM canonical event",
  );
  await verifyDestinationTimedWorkerPg(pool, {
    fixture,
    publishMetadata,
    transactionReferenceCodec,
  });
  console.log(
    "PASS destination publication: full E footprint, replay, conflict atomicity, no-O target race/recovery, real E lock wait, native credit",
  );
}
