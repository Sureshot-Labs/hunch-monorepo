import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { tx } from "@hunch/infra";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import { recordRefundSourceDebitForTest } from "./refund-source-debit-fixture.js";
import { createRoleCheckpointTestSession } from "./receive-legacy-role-checkpoint-pg.js";
import {
  lockFundingReceiveCanonicalEvents,
  stageFundingReceiveClassificationBatch,
  type FundingReceiveCanonicalEventInput,
} from "../persistence/funding-receive-session-repository.js";
import {
  readPendingReceiveAnchorCandidate,
  repairPendingReceiveAnchor,
  type PendingReceiveAnchorCandidate,
} from "../persistence/funding-pending-receive-anchor.js";
import {
  tryLockFundingPhysicalEvent,
  fundingPhysicalEventIsBusy,
} from "../persistence/funding-physical-event-gate.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import { FundingReceiveSessionObserver } from "../receive/receive-session-observer.js";
import { allocateFundingObservationInTransaction } from "../persistence/funding-operation-repository.js";
import type { EvmFundingReceiveAnchorProof } from "../receive/evm-receive-anchor-proof.js";
import { prepareReceiveAnchors } from "../receive/prepare-receive-anchors.js";

const hash = () => `0x${randomBytes(32).toString("hex")}`;
type Fixture = ReturnType<typeof relayExactRefundTestFixture>;
const replacement = (
  candidate: PendingReceiveAnchorCandidate,
): EvmFundingReceiveAnchorProof => ({
  kind: "replacement_verified",
  eventFingerprint: receiveRoleEventFingerprint(candidate.event),
  previousCanonicalHash: hash(),
  ledgerHeight: (BigInt(candidate.event.ledgerHeight) + 1n).toString(),
  blockHash: hash(),
});

/** Actual PG16 commits, old lease revocation, all-status/case/legacy ownership,
 * and two-session broad-footprint contention. No provider or financial submit. */
export async function verifyPendingReceiveAnchorPg(
  pool: Pool,
  fixture: () => Promise<Fixture>,
) {
  const data = await fixture();
  const seed: FundingReceiveCanonicalEventInput = {
    ...data.evm[0],
    now: data.base.now,
  };
  const create = async (networkId = seed.networkId) => {
    const event = {
      ...seed,
      networkId,
      asset: { ...seed.asset, networkId },
      transactionHash: hash(),
    };
    await tx(pool, (db) => lockFundingReceiveCanonicalEvents(db, [event]));
    const row = (
      await pool.query<{ id: string }>(
        "select id from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index=$3",
        [networkId, event.transactionHash, event.eventIndex],
      )
    ).rows[0];
    const candidate = await readPendingReceiveAnchorCandidate(pool, row.id);
    assert.ok(candidate);
    return candidate;
  };
  const repair = (
    candidate: PendingReceiveAnchorCandidate,
    proof = replacement(candidate),
  ) =>
    repairPendingReceiveAnchor(pool, {
      candidate,
      proof,
      deadlineMs: Date.now() + 5000,
    });
  const effects = async () =>
    (
      await pool.query(`select
    (select count(*) from funding_observations) as observations,
    (select count(*) from funding_receive_receipts) as receipts,
    (select count(*) from funding_operations) as operations,
    (select count(*) from balance_reservations) as reservations`)
    ).rows[0];
  for (const network of ["evm:137", "evm:8453"]) {
    const candidate = await create(network);
    const lease = randomUUID(),
      retryAt = new Date(Date.now() + 60000);
    await pool.query(
      `update funding_receive_canonical_events set allocation_status='recovery_required',
      allocation_error_code='exact_refund_correlation_pending',classification_lease_token=$2,
      classification_retry_at=$3 where id=$1`,
      [candidate.eventId, lease, retryAt],
    );
    await pool.query(
      `insert into funding_receive_refund_scans
      (event_id,contract_version,user_id,receive_session_id,variant_id,source_exhausted,last_lease_token,event_fingerprint)
      values($1,4,$2,null,null,true,$3,$4)`,
      [
        candidate.eventId,
        data.base.source.accountId,
        lease,
        receiveRoleEventFingerprint(candidate.event),
      ],
    );
    const candidateId = randomUUID();
    await pool.query(
      `insert into funding_receive_refund_candidates
      (candidate_id,event_id,reservation_id,operation_id,envelope_kind)
      values($1,$2,$3,$4,'invalid')`,
      [candidateId, candidate.eventId, randomUUID(), data.base.operationId],
    );
    const current = await readPendingReceiveAnchorCandidate(
      pool,
      candidate.eventId,
    );
    assert.ok(current);
    const before = JSON.parse(current.snapshot);
    const proof = replacement(current);
    assert.equal(proof.kind, "replacement_verified");
    if (proof.kind !== "replacement_verified") assert.fail();
    const beforeEffects = await effects();
    assert.equal(await repair(current, proof), "reanchored");
    assert.deepEqual(
      await effects(),
      beforeEffects,
      "anchor repair creates no monetary/consumer effects",
    );
    const updated = await readPendingReceiveAnchorCandidate(
      pool,
      current.eventId,
    );
    assert.ok(updated);
    const after = JSON.parse(updated.snapshot);
    for (const field of [
      "id",
      "network_id",
      "asset_id",
      "asset_decimals",
      "destination_address",
      "source_address",
      "raw_amount",
      "tx_hash",
      "event_index",
      "observed_at",
      "first_observed_at",
      "classification_receive_session_id",
      "classification_variant_id",
      "classification_retry_at",
      "allocation_status",
      "allocation_error_code",
    ])
      assert.deepEqual(after[field], before[field], `preserve ${field}`);
    assert.equal(after.classification_lease_token, null);
    assert.equal(after.block_hash, proof.blockHash);
    assert.equal(String(after.ledger_height), proof.ledgerHeight);
    assert.equal(after.anchor_repair_provenance.length, 1);
    const header = (
      await pool.query(
        "select * from funding_receive_refund_scans where event_id=$1",
        [current.eventId],
      )
    ).rows[0];
    assert.equal(header.source_exhausted, false);
    assert.equal(header.last_lease_token, null);
    assert.equal(header.event_fingerprint, null);
    assert.equal(
      (
        await pool.query(
          "select candidate_id from funding_receive_refund_candidates where event_id=$1",
          [current.eventId],
        )
      ).rows[0].candidate_id,
      candidateId,
    );
    assert.equal(
      await repair(current, proof),
      "stale",
      "old exact snapshot cannot rewrite B",
    );
    assert.equal(
      await repair(updated, proof),
      "unavailable",
      "old proof cannot authorize a new envelope",
    );
    const invalidProof = { ...proof, eventFingerprint: "0".repeat(64) };
    assert.equal(await repair(updated, invalidProof), "unavailable");
    await assert.rejects(
      pool.query(
        "update funding_receive_canonical_events set block_hash=$2 where id=$1",
        [current.eventId, hash()],
      ),
      /identity is immutable/,
    );
    await assert.rejects(
      pool.query(
        "update funding_receive_canonical_events set anchor_repair_provenance='[]'::jsonb where id=$1",
        [current.eventId],
      ),
      /append-only/,
    );
  }
  // A valid-looking legacy owner with a different economic envelope and casing
  // still owns the physical transfer. Finality/retraction is not non-ownership.
  const owned = await create();
  await tx(pool, async (db) => {
    await allocateFundingObservationInTransaction(db, {
      operationId: data.base.operationId,
      segmentId: data.base.segmentId,
      kind: "source_debit",
      networkId: owned.event.networkId,
      assetId: `0x${"ef".repeat(20)}`,
      assetDecimals: 6,
      txHash: owned.event.transactionHash.toUpperCase(),
      eventIndex: owned.event.eventIndex,
      fromAddress: null,
      toAddress: owned.event.destinationAddress,
      rawAmount: "1",
      observedAt: seed.observedAt,
      ledgerHeight: seed.ledgerHeight,
      blockHash: seed.blockHash,
      finalityStatus: "finalized",
      finalizedAt: seed.now,
    });
    await db.query(
      `update funding_observations set finality_status='reorged',canonical=false,
      reorged_at=clock_timestamp() where network_id=$1 and tx_hash=$2`,
      [owned.event.networkId, owned.event.transactionHash.toUpperCase()],
    );
  });
  assert.equal(await repair(owned), "owned");
  const stale = await create();
  await pool.query(
    "update funding_receive_canonical_events set classification_lease_token=gen_random_uuid() where id=$1",
    [stale.eventId],
  );
  assert.equal(await repair(stale), "stale");

  const discovered = await create();
  let proofReads = 0;
  const inspect = async () => {
    proofReads++;
    return replacement(discovered);
  };
  assert.equal(
    await prepareReceiveAnchors(pool, { events: [discovered.event], inspect }),
    "ready",
  );
  assert.equal(proofReads, 0, "same-anchor discovery makes no extra RPC calls");
  const remine = replacement(discovered);
  assert.equal(remine.kind, "replacement_verified");
  if (remine.kind !== "replacement_verified") assert.fail();
  const newEvent = {
    ...discovered.event,
    ledgerHeight: remine.ledgerHeight,
    blockHash: remine.blockHash,
  };
  assert.equal(
    await prepareReceiveAnchors(pool, { events: [newEvent], inspect }),
    "pending",
  );
  assert.equal(
    proofReads,
    0,
    "missing work deadline cannot authorize unbounded proof IO",
  );
  assert.equal(
    await prepareReceiveAnchors(pool, {
      events: [newEvent],
      deadlineMs: Date.now() + 5000,
      inspect: async () => {
        proofReads++;
        return remine;
      },
    }),
    "pending",
  );
  assert.equal(proofReads, 1);
  assert.equal(
    await prepareReceiveAnchors(pool, {
      events: [newEvent],
      deadlineMs: Date.now() + 5000,
      inspect,
    }),
    "ready",
    "next ordinary scanner/provider pass sees committed B",
  );
  assert.equal(proofReads, 1);
  const collision = await create();
  assert.equal(
    await prepareReceiveAnchors(pool, {
      events: [{ ...collision.event, blockHash: hash(), rawAmount: "1" }],
      deadlineMs: Date.now() + 5000,
      inspect,
    }),
    "ready",
  );
  await assert.rejects(
    tx(pool, (db) =>
      lockFundingReceiveCanonicalEvents(db, [
        { ...collision.event, blockHash: hash(), rawAmount: "1" },
      ]),
    ),
    /identity collision/,
  );
  assert.equal(
    proofReads,
    1,
    "economic collisions retain strict upsert rejection without proof IO",
  );

  // Get one ordinary frozen source step/attempt to clone only fixture attempts.
  await recordRefundSourceDebitForTest(pool, data);
  const template = (
    await pool.query(
      `select attempt_row.id,attempt_row.step_id
    from funding_operation_step_attempts attempt_row join funding_operation_steps step_row on step_row.id=attempt_row.step_id
    where step_row.operation_id=$1 order by attempt_number limit 1`,
      [data.base.operationId],
    )
  ).rows[0];
  let attemptNumber = 1;
  const insertStep = async (
    db: PoolClient,
    event: FundingReceiveCanonicalEventInput,
    evidence: Record<string, unknown>,
  ) => {
    const attemptId = randomUUID();
    await db.query(
      `insert into funding_operation_step_attempts select copied_row.*
      from funding_operation_step_attempts template_row cross join lateral jsonb_populate_record(
      null::funding_operation_step_attempts,to_jsonb(template_row)||jsonb_build_object('id',$2::uuid,'attempt_number',$3::integer)) copied_row
      where template_row.id=$1`,
      [template.id, attemptId, ++attemptNumber],
    );
    return (
      await db.query<{ id: string }>(
        `insert into funding_step_receipt_observations
      (operation_id,step_id,attempt_id,network_id,status,first_seen_at,observed_at,evidence)
      values($1,$2,$3,$4,'pending',now(),now(),$5::jsonb) returning id`,
        [
          data.base.operationId,
          template.step_id,
          attemptId,
          event.networkId,
          JSON.stringify(evidence),
        ],
      )
    ).rows[0].id;
  };
  const a = await pool.connect(),
    b = await pool.connect();
  try {
    for (const kind of ["missing", "malformed", "retained"]) {
      const candidate = await create();
      const evidence =
        kind === "retained"
          ? {
              handoffOwnedPhysicalEventV1: {
                transactionHash: candidate.event.transactionHash.toUpperCase(),
              },
            }
          : {
              transactionHash: candidate.event.transactionHash.toUpperCase(),
              ...(kind === "malformed" ? { sourceDebitEventIndex: "?" } : {}),
            };
      await a.query("begin");
      await insertStep(a, candidate.event, evidence);
      await assert.rejects(
        repair(candidate),
        fundingPhysicalEventIsBusy,
        "uncommitted broad legacy owner gates repair",
      );
      await a.query("commit");
      assert.equal(
        await repair(candidate),
        "owned",
        "next ordinary repair sees committed broad owner",
      );
      const reverse = await create();
      await a.query("begin");
      await tryLockFundingPhysicalEvent(a, reverse.event);
      await b.query("begin");
      await assert.rejects(
        insertStep(b, reverse.event, {
          transactionHash: reverse.event.transactionHash,
        }),
        fundingPhysicalEventIsBusy,
      );
      await b.query("rollback");
      await a.query("rollback");
      await b.query("begin");
      await insertStep(b, reverse.event, {
        transactionHash: reverse.event.transactionHash,
      });
      await b.query("commit");
      assert.equal(await repair(reverse), "owned");
    }
    const candidate = await create();
    await b.query("begin");
    const receiptId = await insertStep(b, candidate.event, {
      transactionHash: hash(),
      handoffEventIndex: "1",
    });
    await b.query("commit");
    await a.query("begin");
    await tryLockFundingPhysicalEvent(a, candidate.event);
    await b.query("begin");
    await assert.rejects(
      b.query(
        `update funding_step_receipt_observations set status='reorged',canonical=false,
      action_match=true,reorged_at=clock_timestamp(),evidence=$2::jsonb where id=$1`,
        [
          receiptId,
          JSON.stringify({ transactionHash: candidate.event.transactionHash }),
        ],
      ),
      fundingPhysicalEventIsBusy,
      "a retraction cannot introduce new ownership without gating",
    );
    await b.query("rollback");
    await a.query("rollback");
  } finally {
    await a.query("rollback");
    await b.query("rollback");
    a.release();
    b.release();
  }

  // Runtime wiring: known A -> exact chain proof -> metadata-only B -> revoke
  // old token. The next normal claim reads B; deferred proof never reaches role
  // classification. No re-scan, quote or old Buy/consumer continuation.
  const session = await createRoleCheckpointTestSession(pool, await fixture());
  const staged = await stageFundingReceiveClassificationBatch(pool, {
    scope: session,
    events: [session.event],
    now: session.event.now,
    retryDelayMs: 1000,
  });
  assert.equal(staged[0].kind, "claimed");
  const seen: string[] = [];
  const observer = new FundingReceiveSessionObserver({
    inspectCanonicalAnchor: async ({ expected }) => {
      seen.push(expected.blockHash);
      return seen.length === 1
        ? replacement({ eventId: "", snapshot: "", event: expected })
        : { kind: "deferred", reason: "fixture_waiting" };
    },
    readRoleArbitration: async () => {
      assert.fail("deferred/reanchored proof must not publish");
    },
  });
  // Exclude unrelated retained test fixtures from THIS exact runtime test only.
  const isolated = Object.create(pool) as Pool;
  isolated.query = (async (sql: string, values: unknown[]) => {
    if (sql.includes("with due_events as materialized"))
      sql = sql.replace(
        "where allocation_status='recovery_required'",
        `where tx_hash='${session.event.transactionHash}' and allocation_status='recovery_required'`,
      );
    return pool.query(sql, values);
  }) as Pool["query"];
  isolated.connect = pool.connect.bind(pool);
  const clock = new Date(session.event.now.getTime() + 1000);
  const first = await observer.pollKnownCanonicalRetryBatch(isolated, {
    limit: 10,
    retryDelayMs: 1000,
    now: clock,
  });
  assert.equal(first.eventsChecked, 1);
  assert.equal(first.anchorsRepaired, 1);
  assert.equal(first.receiptsRecorded, 0);
  assert.equal(
    (
      await observer.pollKnownCanonicalRetryBatch(isolated, {
        limit: 10,
        retryDelayMs: 1000,
        now: clock,
      })
    ).eventsChecked,
    0,
  );
  const next = await observer.pollKnownCanonicalRetryBatch(isolated, {
    limit: 10,
    retryDelayMs: 1000,
    now: new Date(clock.getTime() + 1000),
  });
  assert.equal(next.eventsChecked, 1);
  assert.equal(next.anchorsDeferred, 1);
  assert.notEqual(seen[0], seen[1]);
  console.log(
    "PASS pending receive exact-anchor CAS, immutable economics/timestamps/binding/due, revoked lease, retained candidates, global legacy ownership, broad-footprint races and ordinary runtime retry",
  );
}
