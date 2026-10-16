import assert from "node:assert/strict";
import { fundingPhysicalEventIsBusy } from "../persistence/funding-physical-event-gate.js";
import { randomBytes, randomUUID } from "node:crypto";
import { tx, type Pool } from "@hunch/infra";
import {
  BASE_USDC,
  RELAY_DEPOSITORY_V2,
} from "../../funding-providers/relay/rehearsal.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  createFundingQuote,
  commitFundingOperation,
  type FundingCommitPlan,
} from "../persistence/funding-operation-repository.js";
import { FundingClassificationChangedError } from "../persistence/funding-classification-revisions.js";
import {
  claimFundingReceiveCanonicalEventAllocation,
  lockFundingReceiveCanonicalEvents,
} from "../persistence/funding-receive-session-repository.js";
import { RelayOwnedRefundObserver } from "../reconciliation/relay-owned-refund-observer.js";
import { OWNED_REFUND_OTHER_EVM_CREDIT_SQL } from "../reconciliation/relay-owned-refund-ownership.js";
import { ownedRefundRoleWorkFixture } from "./recorded-role-observer-fixture.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import { verifyOwnedRefundPlansPg } from "./owned-refund-plans-pg.js";
import { verifyOwnedRefundReceiveRacePg } from "./owned-refund-receive-race-pg.js";

type Fixture = {
  operationId: string;
  walletAddress: string;
  base: { userId: string };
  plan: FundingCommitPlan;
};
type Prepared = { segmentId: string; preparedAt: Date };
const hash = () => `0x${randomBytes(32).toString("hex")}`;
const asset = { networkId: "evm:8453", assetId: BASE_USDC, decimals: 6 };

/** Real committed observer transactions and competing writers. Only public
 * chain IO is injected; no signing or production wallet/Telegram interaction. */
export async function verifyOwnedRefundPublicationPg<T extends Fixture>(input: {
  pool: Pool;
  createFixture: () => Promise<T>;
  prepare: (
    fixture: T,
    options: {
      refundTransactionHash: string;
      refundBlockHash: string;
      referenceTransactionHashes: readonly string[];
      initialRefund?: boolean;
    },
  ) => Promise<Prepared>;
  referenceCodec: FundingTransactionReferenceCodec;
  registerOperation: (id: string) => void;
  registerQuote: (id: string) => void;
}) {
  const { pool } = input;
  const make = async (
    initialRefund = false,
    replacement = false,
    uppercaseLog = false,
  ) => {
    const fixture = await input.createFixture();
    const originalHash = hash();
    const transactionHash = replacement ? hash() : originalHash;
    const originalBlockHash = hash();
    const prepared = await input.prepare(fixture, {
      refundTransactionHash: originalHash,
      refundBlockHash: originalBlockHash,
      referenceTransactionHashes: [originalHash, transactionHash],
      initialRefund,
    });
    let blockHash = replacement ? hash() : originalBlockHash;
    let blockNumber = 120n;
    const log = () => ({
      transactionHash: uppercaseLog
        ? transactionHash.toUpperCase()
        : transactionHash,
      logIndex: 0,
      blockNumber,
      blockHash,
      fromAddress: RELAY_DEPOSITORY_V2,
      toAddress: fixture.walletAddress,
      rawAmount: 2_000_000n,
    });
    const observer = new RelayOwnedRefundObserver(
      input.referenceCodec,
      {
        blockNumber: async () => 125n,
        transferLogs: async () => [log()],
      },
      input.referenceCodec,
    );
    return {
      fixture,
      prepared,
      originalHash,
      transactionHash,
      log,
      observer,
      remine: () => {
        blockHash = hash();
        blockNumber = 121n;
      },
      poll: (db = pool, limit = 50) =>
        observer.pollOperation(db, fixture.operationId, prepared.preparedAt, {
          ...ownedRefundRoleWorkFixture(limit),
          inspectCanonicalAnchor: async ({ expected }) => ({
            kind: "replacement_verified",
            eventFingerprint: receiveRoleEventFingerprint(expected),
            previousCanonicalHash: hash(),
            ledgerHeight: blockNumber.toString(),
            blockHash,
          }),
        }),
    };
  };
  const eventRows = async (transactionHash: string) =>
    (
      await pool.query(
        `select ledger_height::text,block_hash,allocation_status,allocation_error_code
      from funding_receive_canonical_events where network_id=$1 and tx_hash=$2 and event_index='0'`,
        [asset.networkId, transactionHash],
      )
    ).rows;
  const credits = async (fixture: Fixture) =>
    (
      await pool.query(
        `select tx_hash,canonical,finality_status,block_hash
      from funding_observations where operation_id=$1 and kind='refund_credit'
      order by observed_at,id`,
        [fixture.operationId],
      )
    ).rows;
  const assertClaimed = async (data: Awaited<ReturnType<typeof make>>) => {
    assert.deepEqual(await eventRows(data.transactionHash), [
      {
        ledger_height: data.log().blockNumber.toString(),
        block_hash: data.log().blockHash,
        allocation_status: "recovery_required",
        allocation_error_code: "internal_exact_refund_suppressed",
      },
    ]);
    const claim = await tx(pool, (db) =>
      claimFundingReceiveCanonicalEventAllocation(db, {
        networkId: asset.networkId,
        asset,
        rawAmount: "2000000",
        transactionHash: data.transactionHash,
        eventIndex: "0",
        ledgerHeight: data.log().blockNumber.toString(),
        blockHash: data.log().blockHash,
        sourceAddress: RELAY_DEPOSITORY_V2,
        destinationAddress: data.fixture.walletAddress,
        now: data.prepared.preparedAt,
        observedAt: data.prepared.preparedAt,
      }),
    );
    assert.equal(
      claim.status,
      "recovery_required",
      "a refund cannot become a second external receive",
    );
  };

  // A real overlapping, unresolved destination (not a mocked classification).
  const pending = await make();
  const amount = { asset, raw: "2000000" };
  const destination = {
    kind: "owned_location",
    location: {
      kind: "wallet",
      locationId: randomUUID(),
      accountId: pending.fixture.base.userId,
      asset,
      details: { address: pending.fixture.walletAddress },
    },
  };
  const plan: FundingCommitPlan = {
    ...pending.fixture.plan,
    operation: {
      ...pending.fixture.plan.operation,
      destinationTargetSnapshot: destination,
      requestedDestinationAmount: amount,
    },
    segments: pending.fixture.plan.segments.map((segment) => ({
      ...segment,
      destinationTargetSnapshot: destination,
      quotedExpectedOutput: amount,
      quotedMinOutput: amount,
    })),
    steps: [],
  };
  const consentToken = randomUUID();
  assert.ok(plan.operation.sourceSnapshot);
  const quote = await createFundingQuote(pool, {
    userId: pending.fixture.base.userId,
    discoveryProjectionId: randomUUID(),
    selectedSourceOptionSnapshot: plan.operation.sourceSnapshot,
    marketContextSnapshot: null,
    destinationOptionSnapshot: destination,
    venueBindingSnapshot: plan.operation.venueBindingSnapshot,
    planSnapshot: plan,
    policyVersion: 1,
    policyRevision: "owned-refund-pg",
    canonicalRequest: { test: "pending-owned-refund", id: randomUUID() },
    consentToken,
    expiresAt: new Date(Date.now() + 60000),
  });
  input.registerQuote(quote.id);
  const competitor = await commitFundingOperation(pool, {
    userId: pending.fixture.base.userId,
    quoteId: quote.id,
    consentToken,
    idempotencyKey: randomUUID(),
    plan,
    subjectLookupHmac: hash().slice(2),
    subjectLookupKeyVersion: 1,
    now: pending.prepared.preparedAt,
    // This synthetic competing route has independently funded source capacity;
    // balance/provider IO is not the subject of the publication race test.
    verifySharedSourceCapacity: async () => {},
  });
  input.registerOperation(competitor.operation.id);
  await pool.query(
    `update funding_operation_segments set support_metadata=
    support_metadata || '{"originTransactionReferenceCount":1}'::jsonb where operation_id=$1`,
    [competitor.operation.id],
  );
  assert.equal((await pending.poll()).refundSatisfied, false);
  assert.equal(
    (await eventRows(pending.transactionHash)).length,
    1,
    "bounded checkpoint retains E, not money",
  );
  assert.deepEqual(await credits(pending.fixture), []);
  await pool.query(
    `update funding_operation_segments set support_metadata=
    support_metadata || '{"originTransactionReferenceCount":0}'::jsonb where operation_id=$1`,
    [competitor.operation.id],
  );
  pending.remine();
  assert.equal(
    (await pending.poll()).refundSatisfied,
    false,
    "unowned pending A -> B repair is metadata only; publication retries normally",
  );
  assert.equal(
    (await pending.poll()).refundSatisfied,
    true,
    "pending -> clear -> new anchor recovers normally",
  );
  assert.equal((await pending.poll()).refundSatisfied, true);
  assert.equal((await credits(pending.fixture)).length, 1);
  await assertClaimed(pending);

  const replacement = await make(true, true);
  assert.equal((await replacement.poll()).refundSatisfied, false);
  assert.equal(
    (await credits(replacement.fixture))[0].finality_status,
    "reorged",
  );
  assert.deepEqual(
    await eventRows(replacement.transactionHash),
    [],
    "invalidation does not publish a replacement footprint",
  );
  assert.equal(
    (await eventRows(replacement.originalHash))[0].allocation_error_code,
    "internal_exact_refund_suppressed",
  );
  replacement.remine();
  assert.equal((await replacement.poll()).refundSatisfied, true);
  assert.equal(
    (await credits(replacement.fixture)).filter((row) => row.canonical).length,
    1,
  );
  await assertClaimed(replacement);

  const staged = await make(true);
  staged.remine();
  assert.equal(
    (await staged.poll(pool, 1)).refundSatisfied,
    false,
    "truthful retraction commits before any positive role work",
  );
  const stagedFirst = await staged.poll(pool, 1);
  assert.equal(
    stagedFirst.refundSatisfied,
    false,
    "one bounded page cannot publish incomplete restoration",
  );
  assert.equal((await credits(staged.fixture))[0].canonical, false);
  assert.equal(
    (await eventRows(staged.transactionHash))[0].ledger_height,
    "120",
    "checkpoint must retain old protected E anchor A",
  );
  let stagedTicks = 0;
  let stagedResult = stagedFirst;
  while (!stagedResult.refundSatisfied && stagedTicks++ < 20)
    stagedResult = await staged.poll(pool, 1);
  assert.equal(
    stagedResult.refundSatisfied,
    true,
    "ordinary bounded ticks finish protected A->B, without manual state edits",
  );
  assert.ok(stagedTicks > 1);
  assert.equal((await credits(staged.fixture)).length, 1);
  await assertClaimed(staged);

  // Legacy refund observations can predate physical ownership rows. A receive
  // scan may already have stored E at the new anchor. Its economics must still
  // equal the recorded refund before the old observation can be restored.
  for (const sameSender of [true, false]) {
    const legacy = await make(true);
    legacy.remine();
    await pool.query(
      `update funding_observations set finality_status='reorged',canonical=false,
      reorged_at=date_trunc('milliseconds',now()) + interval '123 microseconds'
      where operation_id=$1 and kind='refund_credit'`,
      [legacy.fixture.operationId],
    );
    const newLog = {
      ...legacy.log(),
      fromAddress: sameSender ? RELAY_DEPOSITORY_V2 : `0x${"32".repeat(20)}`,
    };
    await tx(pool, (db) =>
      lockFundingReceiveCanonicalEvents(db, [
        {
          networkId: asset.networkId,
          asset,
          rawAmount: "2000000",
          transactionHash: legacy.transactionHash,
          eventIndex: "0",
          ledgerHeight: newLog.blockNumber.toString(),
          blockHash: newLog.blockHash,
          sourceAddress: newLog.fromAddress,
          destinationAddress: legacy.fixture.walletAddress,
          now: legacy.prepared.preparedAt,
          observedAt: legacy.prepared.preparedAt,
        },
      ]),
    );
    const observer = new RelayOwnedRefundObserver(
      input.referenceCodec,
      {
        blockNumber: async () => 125n,
        transferLogs: async () => [newLog],
      },
      input.referenceCodec,
    );
    assert.equal(
      (
        await observer.pollOperation(
          pool,
          legacy.fixture.operationId,
          legacy.prepared.preparedAt,
          ownedRefundRoleWorkFixture(),
        )
      ).refundSatisfied,
      sameSender,
    );
    assert.equal((await credits(legacy.fixture))[0].canonical, sameSender);
    assert.equal(
      (
        await pool.query(
          `select from_address from funding_observations
      where operation_id=$1 and kind='refund_credit'`,
          [legacy.fixture.operationId],
        )
      ).rows[0].from_address,
      RELAY_DEPOSITORY_V2.toLowerCase(),
    );
    if (sameSender) await assertClaimed(legacy);
    else
      assert.equal(
        (await eventRows(legacy.transactionHash))[0].allocation_status,
        "pending",
      );
  }

  // Change a real dependency after E acquisition but before O: the stale read
  // must not publish, and a fresh ordinary poll must recover without manual repair.
  let targetSql: string | undefined;
  for (const injection of ["before-O", "after-snapshot"] as const) {
    const changed = await make();
    const traced = Object.create(pool) as Pool;
    traced.query = pool.query.bind(pool);
    let intercepted = false;
    const statements: string[] = [];
    traced.connect = (async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              statements.push(sql);
              if (
                !intercepted &&
                (injection === "before-O"
                  ? sql.includes("for update of operation, reservation")
                  : sql === OWNED_REFUND_OTHER_EVM_CREDIT_SQL)
              ) {
                intercepted = true;
                await pool.query(
                  `update funding_operation_segments set support_metadata=
            support_metadata || '{"relayStatusCategory":"provider_pending"}'::jsonb where id=$1`,
                  [changed.prepared.segmentId],
                );
              }
              return target.query(sql, values);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as Pool["connect"];
    await assert.rejects(
      changed.poll(traced),
      FundingClassificationChangedError,
    );
    assert.ok(intercepted);
    assert.ok(
      statements.findIndex((sql) =>
        sql.includes("insert into funding_receive_canonical_events"),
      ) <
        statements.findIndex((sql) =>
          sql.includes("for update of operation, reservation"),
        ),
    );
    assert.equal(
      (await eventRows(changed.transactionHash)).length,
      1,
      "earlier derived checkpoint survives a later financial rollback",
    );
    await pool.query(
      `update funding_operation_segments set support_metadata=
    support_metadata || '{"relayStatusCategory":"refund_in_progress"}'::jsonb where id=$1`,
      [changed.prepared.segmentId],
    );
    assert.equal((await changed.poll()).refundSatisfied, true);
    await assertClaimed(changed);
    await changed.poll(traced);
    assert.equal(statements.at(-1), "commit");
    assert.ok(statements.at(-2)?.includes("funding_classification_fence"));
    targetSql = statements.find((sql) =>
      sql.includes("as publication_snapshot"),
    );
  }

  // A canonical refund can exist while the lifecycle projector has not yet
  // changed the reservation to refunded. Replacement must invalidate first.
  const unprojected = await make();
  assert.equal((await unprojected.poll()).refundSatisfied, true);
  assert.equal(
    (
      await pool.query(
        `select status from telegram_funding_authorization_reservations
    where funding_operation_id=$1`,
        [unprojected.fixture.operationId],
      )
    ).rows[0].status,
    "reserved",
  );
  const replacementHash = hash();
  await pool.query(
    `update funding_operation_segments set support_metadata=support_metadata ||
    jsonb_build_object('relayTransactionReferenceFingerprints',$2::jsonb) where id=$1`,
    [
      unprojected.prepared.segmentId,
      JSON.stringify(
        [unprojected.transactionHash, replacementHash].map(
          input.referenceCodec.fingerprint,
        ),
      ),
    ],
  );
  const replacementLog = {
    ...unprojected.log(),
    transactionHash: replacementHash,
    blockHash: hash(),
  };
  const unprojectedObserver = new RelayOwnedRefundObserver(
    input.referenceCodec,
    {
      blockNumber: async () => 125n,
      transferLogs: async () => [replacementLog],
    },
    input.referenceCodec,
  );
  const pollUnprojected = () =>
    unprojectedObserver.pollOperation(
      pool,
      unprojected.fixture.operationId,
      unprojected.prepared.preparedAt,
      ownedRefundRoleWorkFixture(),
    );
  assert.equal((await pollUnprojected()).refundSatisfied, false);
  assert.deepEqual(await eventRows(replacementHash), []);
  assert.equal(
    (await credits(unprojected.fixture)).filter((row) => row.canonical).length,
    0,
  );
  replacementLog.blockHash = hash();
  assert.equal((await pollUnprojected()).refundSatisfied, true);
  assert.equal(
    (await credits(unprojected.fixture)).filter((row) => row.canonical).length,
    1,
  );

  // Both polls read the same absent-refund snapshot. The first-key try gate or
  // post-O snapshot fence allows one credit, not two independent successes.
  const concurrent = await make();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const observer = new RelayOwnedRefundObserver(
    input.referenceCodec,
    {
      blockNumber: async () => 125n,
      transferLogs: async () => {
        if (++entered === 2) release();
        await gate;
        return [concurrent.log()];
      },
    },
    input.referenceCodec,
  );
  const results = await Promise.allSettled(
    [0, 1].map(() =>
      observer.pollOperation(
        pool,
        concurrent.fixture.operationId,
        concurrent.prepared.preparedAt,
        ownedRefundRoleWorkFixture(),
      ),
    ),
  );
  assert.equal(
    results.filter(
      (result) => result.status === "fulfilled" && result.value.refundSatisfied,
    ).length,
    1,
  );
  const refusal = results.find(
    (result) => result.status === "rejected" || !result.value.refundSatisfied,
  );
  assert.ok(
    (refusal?.status === "fulfilled" && !refusal.value.refundSatisfied) ||
      (refusal?.status === "rejected" &&
        (refusal.reason instanceof FundingClassificationChangedError ||
          fundingPhysicalEventIsBusy(refusal.reason))),
  );
  assert.equal((await concurrent.poll()).refundSatisfied, true);
  assert.equal((await credits(concurrent.fixture)).length, 1);
  await assertClaimed(concurrent);
  for (const scenario of ["receive", "refund", "receive-alias"] as const) {
    const first = scenario === "refund" ? "refund" : "receive";
    const data = await make();
    await verifyOwnedRefundReceiveRacePg(pool, {
      first,
      legacyReceiveAlias: scenario === "receive-alias",
      userId: data.fixture.base.userId,
      poll: data.poll,
      event: {
        networkId: asset.networkId,
        asset,
        rawAmount: "2000000",
        transactionHash: data.transactionHash,
        eventIndex: "0",
        ledgerHeight: data.log().blockNumber.toString(),
        blockHash: data.log().blockHash,
        sourceAddress: RELAY_DEPOSITORY_V2,
        destinationAddress: data.fixture.walletAddress,
        now: data.prepared.preparedAt,
        observedAt: data.prepared.preparedAt,
      },
    });
    assert.equal(
      (await credits(data.fixture)).length,
      first === "refund" ? 1 : 0,
    );
  }
  // The original receipt's casing is provenance, not a second physical event.
  // A->B repair must work without changing its immutable hash or economics.
  for (const uppercaseLog of [false, true]) {
    const alias = await make(false, false, uppercaseLog);
    const legacyHash = `0X${alias.transactionHash.slice(2).toUpperCase()}`;
    await pool.query(
      `insert into funding_observations
    (operation_id,segment_id,kind,network_id,asset_id,asset_decimals,tx_hash,event_index,
     from_address,to_address,raw_amount,observed_at,ledger_height,block_hash,finality_status,canonical,finalized_at,metadata)
    values($1,$2,'refund_credit',$3,$4,6,$5,'0',$6,$7,'2000000',$8,'120',$9,'finalized',true,$8,$10)`,
      [
        alias.fixture.operationId,
        alias.prepared.segmentId,
        asset.networkId,
        asset.assetId,
        legacyHash,
        RELAY_DEPOSITORY_V2.toLowerCase(),
        alias.fixture.walletAddress.toLowerCase(),
        alias.prepared.preparedAt,
        alias.log().blockHash,
        {
          observerId: "relay_owned_refund_observation_v1",
          relayTransactionReferenceMatched: true,
        },
      ],
    );
    await pool.query(
      `update funding_operation_segments set support_metadata=support_metadata ||
    '{"relayTransactionReferenceFingerprints":[]}'::jsonb where id=$1`,
      [alias.prepared.segmentId],
    );
    assert.equal(
      (await alias.poll()).refundSatisfied,
      true,
      "unchanged historical receipt with no current provider refs uses durable semantic hash, not a false reorg",
    );
    alias.remine();
    assert.equal(
      (await alias.poll()).refundSatisfied,
      false,
      "old uppercase receipt is independently retracted",
    );
    assert.equal(
      (await alias.poll()).refundSatisfied,
      true,
      "next ordinary tick restores A->B through alias-aware narrow anchor guard",
    );
    const aliasCredits = await credits(alias.fixture);
    assert.equal(aliasCredits.length, 1);
    assert.equal(aliasCredits[0].tx_hash, legacyHash);
    assert.equal(aliasCredits[0].canonical, true);
    await assertClaimed(alias);
  }
  assert.ok(targetSql);
  await verifyOwnedRefundPlansPg(pool, {
    targetSql,
    operationId: concurrent.fixture.operationId,
    transactionHash: concurrent.transactionHash,
  });
  console.log(
    "[owned-refund-publication-pg] pending/re-mine, replacement/re-mine, snapshot rollback, duplicate writers and receive exclusion passed",
  );
}
