import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import { tx, type Pool, type PoolClient } from "@hunch/infra";
import { mergeUsersById } from "../../admin-merge-user-core.js";
import { stableWalletAssetLocationIdentity } from "../../account-value/canonical.js";
import {
  loadFundingAccountValueFacts,
  loadFundingSnapshotDebits,
  fundingInvalidatedRefundComponentIds,
  fundingRefundSnapshotLagOperations,
} from "../../account-value/funding-movement-feed.js";
import type { ValuedAssetComponent } from "../domain/types.js";
import { createRelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import { relayDestinationReferenceIdentity } from "../../funding-providers/relay/destination-reference.js";
import type { AssetLocation } from "../domain/types.js";
import type { FundingCommitPlan } from "../persistence/funding-operation-repository.js";
import { reduceFundingOperationInTransaction } from "../reconciliation/funding-reducer.js";
import {
  loadRelayExactRefundContext,
  recordRelayExactRefundReceiptsInTransaction,
} from "../reconciliation/relay-exact-refund-receipts.js";
import {
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
} from "../reconciliation/relay-exact-refund-classification.js";
import { pollRelayRefundCanonicalWatch } from "../reconciliation/relay-refund-canonical-watch.js";
import { readRefundSourceActionPage } from "../reconciliation/relay-refund-source-action-scan.js";
import { recordRefundSourceDebitForTest } from "./refund-source-debit-fixture.js";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;
type Factory = (
  existing?: { userId: string; owner: string },
  beforeCommit?: (db: PoolClient, data: Fixture) => Promise<void>,
  makeSteps?: (source: AssetLocation) => FundingCommitPlan["steps"],
  evmDestination?: boolean,
  legacyDestinationOnly?: boolean,
  canonicalSource?: boolean,
) => Promise<Fixture>;

/** Real source debit/refund writers and terminal merge, then ordinary readers
 * and replay. Only chain/provider evidence is synthetic; no transport/signing. */
export async function verifyMergedRefundIdentityPg(
  pool: Pool,
  fixture: Factory,
) {
  const data = await fixture(
    undefined,
    undefined,
    undefined,
    false,
    false,
    true,
  );
  const original = data.base.source.accountId;
  const { settledIdentity } = await recordRefundSourceDebitForTest(pool, data);
  const recorded = await tx(pool, (db) =>
    recordRelayExactRefundReceiptsInTransaction(db, {
      ...data.base,
      evmEvents: data.evm,
    }),
  );
  assert.equal(recorded.kind, "complete");
  const reduction = await tx(pool, (db) =>
    reduceFundingOperationInTransaction(db, {
      operationId: data.base.operationId,
      now: data.base.now,
    }),
  );
  assert.equal(reduction.terminal, true);
  assert.equal(reduction.finalState.status, "refunded");
  assert.equal(
    (await loadFundingAccountValueFacts(pool, original)).inTransit.length,
    0,
  );
  const readFrozen = async () =>
    (
      await pool.query(
        `select operation_row.source_snapshot,
    operation_row.original_subject_lookup_hmac,operation_row.subject_lookup_key_version,
    segment_row.source_snapshot as bound_source,segment_row.refund_location_snapshot
    from funding_operations operation_row join funding_operation_segments segment_row on segment_row.operation_id=operation_row.id
    where operation_row.id=$1`,
        [data.base.operationId],
      )
    ).rows;
  const frozen = await readFrozen();
  const current = (
    await pool.query(
      "insert into users(email,is_active,is_verified) values($1,true,true) returning id",
      [`merged-refund-target-${randomUUID()}@example.com`],
    )
  ).rows[0].id as string;
  const merged = await mergeUsersById(
    original,
    current,
    { dryRun: false, keepSource: false },
    pool,
  );
  assert.equal(merged.summary.fundingOperationsMoved, 1);
  assert.equal(merged.summary.sourceUserDeleted, 1);
  assert.deepEqual(await readFrozen(), frozen);
  const currentAccountFacts = await loadFundingAccountValueFacts(pool, current);
  assert.equal(
    currentAccountFacts.inTransit.length,
    0,
    "completed refund remains complete after real terminal user merge",
  );
  const currentSourceIdentity = stableWalletAssetLocationIdentity({
    accountId: current,
    address: data.owner,
    asset: data.base.source.asset,
    balanceClass: "",
  });
  assert.equal(currentAccountFacts.refundBalanceChanges.length, 2);
  assert.ok(
    currentAccountFacts.refundBalanceChanges.every(
      (entry) => entry.locationId === currentSourceIdentity.locationId,
    ),
  );
  const currentComponent = {
    componentId: currentSourceIdentity.componentId,
    location: {
      ...data.base.source,
      accountId: current,
      locationId: currentSourceIdentity.locationId,
    },
    amount: { asset: data.base.source.asset, raw: "100000000" },
    observationFreshness: "fresh",
    observationError: null,
    observedAt: new Date(data.base.now.getTime() - 1000).toISOString(),
  } as ValuedAssetComponent;
  assert.equal(
    fundingRefundSnapshotLagOperations(
      currentAccountFacts.refundBalanceChanges,
      [currentComponent],
    ).size,
    1,
  );
  const refreshedComponent = {
    ...currentComponent,
    observedAt: new Date(data.base.now.getTime() + 10000).toISOString(),
  };
  const sourceDebits = await loadFundingSnapshotDebits(pool, current, [
    currentComponent,
  ]);
  assert.equal(
    sourceDebits.length,
    1,
    "real terminal merge retains exact source snapshot suppression",
  );
  assert.equal(sourceDebits[0].sourceComponentId, currentComponent.componentId);
  assert.equal(
    sourceDebits[0].sourceLocationId,
    currentComponent.location.locationId,
  );
  assert.equal(sourceDebits[0].amount.raw, "10000000");
  assert.equal(
    (await loadFundingSnapshotDebits(pool, current, [refreshedComponent]))
      .length,
    0,
  );
  assert.equal(
    fundingRefundSnapshotLagOperations(
      currentAccountFacts.refundBalanceChanges,
      [refreshedComponent],
    ).size,
    0,
  );

  const context = await loadRelayExactRefundContext(pool, data.base);
  assert.equal(context.kind, "ready");
  if (context.kind !== "ready")
    throw Error("merged committed context must load");
  assert.equal(context.currentOwnerUserId, current);
  assert.equal(context.expected.source.accountId, original);
  const rotated = createRelayReferenceCodec({
    encryptionKey: Buffer.alloc(32, 13),
    lookupHmacKey: "rotated-refund-identity-test-key-32chars",
    keyVersion: 2,
  });
  const afterRotation = await loadRelayExactRefundContext(pool, {
    ...data.base,
    referenceCodec: rotated,
  });
  assert.equal(afterRotation.kind, "ready");
  if (afterRotation.kind === "ready")
    assert.deepEqual(afterRotation.identity, context.identity);

  let actions = await readRefundSourceActionPage(pool, {
    identity: { ...settledIdentity, userId: current },
    continuation: null,
    event: data.evm[0],
    limit: 1,
  });
  for (let tick = 0; tick < 12; tick++) {
    if (actions.kind === "complete" && actions.observations.kind === "refunded")
      break;
    assert.equal(actions.kind, "complete");
    if (actions.kind !== "complete")
      throw Error("expected current-owner action summary");
    actions = await readRefundSourceActionPage(pool, {
      identity: { ...settledIdentity, userId: current },
      continuation: null,
      completed: actions,
      event: data.evm[0],
      limit: 1,
    });
  }
  assert.equal(actions.kind, "complete");
  if (actions.kind === "complete") {
    assert.equal(actions.facts.userId, current);
    assert.equal(actions.accounting.kind, "single_debit");
    assert.equal(actions.observations.kind, "refunded");
  }
  const evidence = await readRecordedRelayRefundRoleEvidence(pool, {
    userId: current,
    events: data.evm,
  });
  for (const event of data.evm) {
    const found = evidence.get(refundCanonicalEventKey(event));
    assert.equal(found?.classification.kind, "internal");
    assert.equal(found?.dependencies[0].userId, current);
  }
  let inspected = 0;
  for (let tick = 0; tick < 3; tick++)
    await pollRelayRefundCanonicalWatch(
      pool,
      { operationId: data.base.operationId, now: data.base.now, limit: 1 },
      async (target) => {
        inspected++;
        assert.equal(target.toAddress, data.owner);
        assert.equal(target.asset.networkId, data.base.source.asset.networkId);
        return {
          kind: "canonical",
          ledgerHeight: target.ledgerHeight,
          blockHash: target.blockHash,
        };
      },
    );
  assert.equal(inspected, 2);
  // Reorg repair uses the production canonical watcher after ownership moved.
  // Its read-view fence must hit the current component without rewriting the
  // old receipt/refund location or accidentally selecting another wallet.
  await pollRelayRefundCanonicalWatch(
    pool,
    {
      operationId: data.base.operationId,
      now: new Date(data.base.now.getTime() + 2000),
      limit: 10,
    },
    async (target) =>
      target.txHash === data.evm[0].transactionHash
        ? { kind: "reorged" }
        : {
            kind: "canonical",
            ledgerHeight: target.ledgerHeight,
            blockHash: target.blockHash,
          },
  );
  const reorgFacts = await loadFundingAccountValueFacts(pool, current);
  assert.deepEqual(
    [
      ...fundingInvalidatedRefundComponentIds(reorgFacts.refundBalanceChanges, [
        currentComponent,
      ]),
    ],
    [currentComponent.componentId],
  );
  assert.equal(
    fundingInvalidatedRefundComponentIds(reorgFacts.refundBalanceChanges, [
      refreshedComponent,
    ]).size,
    0,
  );
  for (let tick = 0; tick < 100; tick++) {
    const result = await pollRelayRefundCanonicalWatch(
      pool,
      {
        operationId: data.base.operationId,
        now: new Date(data.base.now.getTime() + 3000),
        limit: 10,
        publication: {
          referenceCodec: data.base.referenceCodec,
          transactionReferenceCodec: createFundingTransactionReferenceCodec({
            encryptionKey: Buffer.alloc(32, 95),
            lookupHmacKey: "offline-merged-watch-role-work-test-key",
            keyVersion: 1,
          }),
          work: {
            progressToken: randomUUID(),
            deadlineMs: Date.now() + 30_000,
            limit: 50,
          },
        },
      },
      async (target) => ({
        kind: "canonical",
        ledgerHeight: target.ledgerHeight,
        blockHash: target.blockHash,
      }),
    );
    if (!result.pending) break;
    assert.ok(
      tick < 99,
      "merged recorded refund watch must recover through ordinary role work",
    );
  }
  assert.equal(
    (await loadFundingAccountValueFacts(pool, current)).inTransit.length,
    0,
  );
  assert.deepEqual(await readFrozen(), frozen);
  const counts = async () =>
    (
      await pool.query(
        `select
    (select count(*)::int from funding_observations where operation_id=$1) as observations,
    (select count(*)::int from funding_receive_receipts where user_id=$2) as receipts,
    (select to_jsonb(job_row) from funding_reconciliation_jobs job_row where operation_id=$1) as job`,
        [data.base.operationId, current],
      )
    ).rows[0];
  const beforeReplay = await counts();
  assert.equal(beforeReplay.receipts, 0);
  const replay = await tx(pool, (db) =>
    recordRelayExactRefundReceiptsInTransaction(db, {
      ...data.base,
      evmEvents: data.evm,
    }),
  );
  assert.equal(replay.kind, "complete");
  if (replay.kind === "complete") assert.equal(replay.inserted, 0);
  assert.deepEqual(await counts(), beforeReplay);

  // A new exact destination owned by the CURRENT user must be visible to the
  // refund writer's competing-role reader. Querying the deleted owner misses it.
  const competitor = await fixture(
    { userId: current, owner: data.owner },
    undefined,
    undefined,
    true,
    true,
  );
  await pool.query(
    `update funding_operation_segments set raw_status='success',support_metadata=support_metadata||$2::jsonb where id=$1`,
    [
      competitor.base.segmentId,
      {
        relayTransactionReferenceFingerprints: [
          data.base.referenceCodec.fingerprint(data.evm[0].transactionHash),
        ],
        relaySuccessfulDestinationReferenceHashesV1: [
          relayDestinationReferenceIdentity(data.evm[0].transactionHash),
        ],
      },
    ],
  );
  const conflicted = await tx(pool, (db) =>
    recordRelayExactRefundReceiptsInTransaction(db, {
      ...data.base,
      evmEvents: data.evm,
    }),
  );
  assert.deepEqual(conflicted, {
    kind: "pending",
    reason: "internal_event_classification_conflict",
  });
  assert.deepEqual(await counts(), beforeReplay);
  assert.deepEqual(await readFrozen(), frozen);
  console.log(
    "PASS merged refunded operation: real debit/refund/merge, immutable lineage/key version, current-owner claim/read aliases/reorg/freshness/actions/watch/replay and competing destination",
  );
}
