import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { relayExactRefundTestFixture } from "./relay-exact-refund-writer-pg.js";
import {
  allocateFundingObservationInTransaction,
  listFundingRefundManifestReceipts,
  fundingPhysicalObservationForUpdateSql,
  FUNDING_REFUND_EVM_MANIFEST_RECEIPTS_SQL,
  FundingPersistenceError,
  type FundingObservationInsert,
} from "../persistence/funding-operation-repository.js";
import { fundingPhysicalEventIsBusy } from "../persistence/funding-physical-event-gate.js";
import {
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
  RECORDED_EXACT_REFUND_EVENTS_SQL,
} from "../reconciliation/relay-exact-refund-classification.js";
import { prepareRelayExactRefundReceipts } from "../reconciliation/relay-exact-refund-receipts.js";
import { publishRelayExactRefundReceipts } from "../reconciliation/relay-exact-refund-publication.js";
import { createFundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";

type Fixture = ReturnType<typeof relayExactRefundTestFixture>;

export async function verifyFundingObservationAliasesPg(
  pool: Pool,
  fixture: () => Promise<Fixture>,
) {
  const data = await fixture();
  const prepared = await prepareRelayExactRefundReceipts(pool, {
    ...data.base,
    evmEvents: data.evm,
  });
  assert.equal(prepared.kind, "prepared");
  if (prepared.kind !== "prepared") throw Error("missing refund fixture");
  const event = data.evm[0];
  const observation: FundingObservationInsert = {
    operationId: data.base.operationId,
    segmentId: data.base.segmentId,
    kind: "refund_credit",
    networkId: event.networkId,
    assetId: event.asset.assetId,
    assetDecimals: event.asset.decimals,
    txHash: event.transactionHash,
    eventIndex: event.eventIndex,
    fromAddress: event.sourceAddress,
    toAddress: event.destinationAddress,
    rawAmount: event.rawAmount,
    observedAt: data.base.now,
    ledgerHeight: event.ledgerHeight,
    blockHash: event.blockHash,
    finalityStatus: "finalized",
    finalizedAt: data.base.now,
    metadata: {
      observerId: "relay_exact_refund_observation_v1",
      relayRefundReceipt: prepared.verification.identity,
    },
  };
  const client = await pool.connect();
  try {
    // A schema-valid historical row, not a normalizer pretending to generate
    // legacy data. Preserve its actual case, IDs, metadata and finality on replay.
    await client.query("begin");
    const legacyHash = `0X${event.transactionHash.slice(2).toUpperCase()}`;
    const legacy = (
      await client.query(
        `insert into funding_observations
      (operation_id,segment_id,kind,network_id,asset_id,asset_decimals,tx_hash,event_index,
       from_address,to_address,raw_amount,observed_at,ledger_height,block_hash,finality_status,canonical,finalized_at,metadata)
      values($1,$2,'refund_credit',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'finalized',true,$11,$14)
      returning id,to_jsonb(funding_observations)::text as snapshot`,
        [
          observation.operationId,
          observation.segmentId,
          observation.networkId,
          observation.assetId,
          observation.assetDecimals,
          legacyHash,
          observation.eventIndex,
          observation.fromAddress,
          observation.toAddress,
          observation.rawAmount,
          observation.observedAt,
          observation.ledgerHeight,
          observation.blockHash,
          observation.metadata,
        ],
      )
    ).rows[0];
    await client.query("commit");
    for (const txHash of [
      event.transactionHash,
      event.transactionHash.toUpperCase(),
      legacyHash,
    ]) {
      await client.query("begin");
      const replay = await allocateFundingObservationInTransaction(client, {
        ...observation,
        txHash,
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.observation.id, legacy.id);
      assert.equal(replay.observation.txHash, legacyHash);
      await client.query("commit");
      assert.equal(
        (
          await client.query(
            "select to_jsonb(funding_observations)::text as snapshot from funding_observations where id=$1",
            [legacy.id],
          )
        ).rows[0].snapshot,
        legacy.snapshot,
      );
    }
    const manifest = await listFundingRefundManifestReceipts(pool, {
      operationId: observation.operationId,
      segmentId: data.base.segmentId,
      networkId: event.networkId,
      transactionHashes: [event.transactionHash, legacyHash],
    });
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, legacy.id);
    const recorded = await readRecordedRelayRefundRoleEvidence(pool, {
      userId: data.base.source.accountId,
      events: [event],
    });
    assert.equal(
      recorded.get(refundCanonicalEventKey(event))?.classification.kind,
      "internal",
    );
    const transactionReferenceCodec = createFundingTransactionReferenceCodec({
      encryptionKey: Buffer.alloc(32, 53),
      lookupHmacKey: "offline-case-alias-publication-key",
      keyVersion: 1,
    });
    let result;
    for (let tick = 0; tick < 100; tick++) {
      result = await publishRelayExactRefundReceipts(pool, {
        ...data.base,
        evmEvents: data.evm,
        transactionReferenceCodec,
        work: {
          progressToken: randomUUID(),
          deadlineMs: Date.now() + 30_000,
          limit: 50,
        },
      });
      if (result.kind !== "pending") break;
    }
    assert.deepEqual(result, { kind: "complete", inserted: 1, reason: null });
    assert.equal(
      (
        await client.query(
          "select count(*)::int as n from funding_observations where operation_id=$1 and kind='refund_credit'",
          [observation.operationId],
        )
      ).rows[0].n,
      2,
    );
    assert.equal(
      (
        await client.query(
          "select tx_hash from funding_observations where id=$1",
          [legacy.id],
        )
      ).rows[0].tx_hash,
      legacyHash,
    );

    // The same physical claim in a different operation/kind/state is NEVER a
    // new credit. A rejected attempt rolls back, then an ordinary exact replay
    // remains possible; no historical evidence gets rewritten or resurrected.
    const foreign = await fixture();
    const foreignEvidence = (
      await readRecordedRelayRefundRoleEvidence(pool, {
        userId: foreign.base.source.accountId,
        events: [event],
      })
    ).get(refundCanonicalEventKey(event));
    assert.equal(foreignEvidence?.classification.kind, "recovery_required");
    assert.ok(
      foreignEvidence?.dependencies.some(
        (facts) => facts.operationId === data.base.operationId,
      ),
      "a foreign alias witness is retained before current-owner filtering",
    );
    for (const patch of [
      {
        operationId: foreign.base.operationId,
        segmentId: foreign.base.segmentId,
      },
      { kind: "destination_credit" as const },
      { rawAmount: "1" },
    ]) {
      await client.query("begin");
      await assert.rejects(
        allocateFundingObservationInTransaction(client, {
          ...observation,
          ...patch,
        }),
        (error: unknown) =>
          error instanceof FundingPersistenceError &&
          error.code === "ambiguous_duplicate_observation",
      );
      await client.query("rollback");
    }
    await client.query("begin");
    await client.query(
      `insert into funding_observations
      select copied_row.* from funding_observations prior_row
      cross join lateral jsonb_populate_record(null::funding_observations,
        to_jsonb(prior_row)||jsonb_build_object('id',gen_random_uuid(),'tx_hash',$2::text)) copied_row
      where prior_row.id=$1`,
      [legacy.id, event.transactionHash],
    );
    await client.query("savepoint corrupt_alias_attempt");
    await assert.rejects(
      allocateFundingObservationInTransaction(client, observation),
      (error: unknown) =>
        error instanceof FundingPersistenceError &&
        error.code === "ambiguous_duplicate_observation",
    );
    await client.query("rollback to savepoint corrupt_alias_attempt");
    const collision = (
      await readRecordedRelayRefundRoleEvidence(client, {
        userId: data.base.source.accountId,
        events: [event],
      })
    ).get(refundCanonicalEventKey(event));
    assert.equal(collision?.classification.kind, "recovery_required");
    assert.deepEqual(
      await prepareRelayExactRefundReceipts(client, {
        ...data.base,
        evmEvents: [event],
      }),
      {
        kind: "pending",
        reason: "refund_shared_transaction_requires_attribution",
      },
    );
    await client.query("rollback");
    await client.query("begin");
    assert.equal(
      (await allocateFundingObservationInTransaction(client, observation))
        .replayed,
      true,
    );
    await client.query("commit");
    // A writer holding the normalized gate is a fast retry, not a second alias
    // insert or an O->E wait. The fresh pass after its commit reuses one row.
    const contender = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select funding_try_lock_physical_event($1,$2,$3)", [
        event.networkId,
        legacyHash,
        event.eventIndex,
      ]);
      await contender.query("begin");
      await assert.rejects(
        allocateFundingObservationInTransaction(contender, observation),
        fundingPhysicalEventIsBusy,
      );
      await contender.query("rollback");
      await client.query("commit");
      await contender.query("begin");
      assert.equal(
        (await allocateFundingObservationInTransaction(contender, observation))
          .replayed,
        true,
      );
      await contender.query("commit");
      await client.query("begin");
      await client.query(
        "select id from funding_observations where id=$1 for update",
        [legacy.id],
      );
      await contender.query("begin");
      await assert.rejects(
        allocateFundingObservationInTransaction(contender, observation),
        fundingPhysicalEventIsBusy,
      );
      await contender.query("rollback");
      await client.query("commit");
      await contender.query("begin");
      assert.equal(
        (await allocateFundingObservationInTransaction(contender, observation))
          .replayed,
        true,
      );
      await contender.query("commit");
    } finally {
      await contender.query("rollback");
      contender.release();
    }

    // Existing native keys remain byte-for-byte distinct, including case.
    await client.query("begin");
    for (const txHash of [event.transactionHash, legacyHash]) {
      const native = await allocateFundingObservationInTransaction(client, {
        ...observation,
        networkId: "hyperliquid:mainnet",
        assetId: "USDC",
        assetDecimals: 8,
        txHash,
        eventIndex: "hypercore:send:destination_credit",
      });
      assert.equal(native.replayed, false);
      assert.equal(native.observation.txHash, txHash);
    }
    await client.query("rollback");
    console.log(
      "PASS retained EVM hash aliases: unchanged replay, manifest/recorded proof, exact joint publication, foreign/kind/value conflicts, gate retry; native exact casing preserved",
    );
  } finally {
    await client.query("rollback");
    client.release();
  }
}

/** The exact three new/changed readers over real indexed public relations.
 * Native readers are deliberately absent from these EVM-normalized plans.
 */
export async function verifyFundingObservationAliasPlansPg(pool: Pool) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query(`create temp table funding_observations(like public.funding_observations including all) on commit drop;
      create temp table funding_operations(id uuid primary key,user_id uuid,source_snapshot jsonb) on commit drop;
      create temp table funding_operation_segments(id uuid primary key,operation_id uuid,provider_id text,refund_location_snapshot jsonb,provider_quote_ref_lookup_hmac text,lookup_key_version int) on commit drop;
      create temp table funding_classification_revisions(operation_id uuid primary key,revision bigint) on commit drop;
      insert into funding_operations values('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','{}');
      insert into funding_operation_segments values('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','relay','{}','offline',1);
      insert into funding_classification_revisions values('11111111-1111-4111-8111-111111111111',7);
      insert into funding_operations select md5('alias-op-'||series_index)::uuid,'22222222-2222-4222-8222-222222222222','{}'::jsonb from generate_series(1,100000) series_index;
      insert into funding_operation_segments select md5('alias-leg-'||series_index)::uuid,md5('alias-op-'||series_index)::uuid,'relay','{}'::jsonb,'offline',1 from generate_series(1,100000) series_index;
      insert into funding_classification_revisions select id,7 from funding_operations where id<>'11111111-1111-4111-8111-111111111111';
      insert into funding_observations(operation_id,segment_id,kind,network_id,asset_id,asset_decimals,tx_hash,event_index,from_address,to_address,raw_amount,observed_at,ledger_height,block_hash,finality_status,canonical,finalized_at)
      select '11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','refund_credit','evm:8453','0x'||repeat('ab',20),6,
        '0X'||upper(repeat(md5('alias-'||series_index),2)),'7','0x'||repeat('cd',20),'0x'||repeat('ef',20),'1',now(),'123','0x'||repeat('aa',32),'finalized',true,now() from generate_series(1,100000) series_index;
      analyze funding_observations;analyze funding_operations;analyze funding_operation_segments;analyze funding_classification_revisions;`);
    const hash = (
      await db.query(
        "select lower(tx_hash) as hash from funding_observations order by id limit 1",
      )
    ).rows[0].hash as string;
    const metrics: unknown[] = [];
    for (const mode of ["force_custom_plan", "force_generic_plan"]) {
      await db.query(`set local plan_cache_mode=${mode}`);
      for (const [name, types, sql, args] of [
        [
          "allocator",
          "text,text,text",
          fundingPhysicalObservationForUpdateSql("full"),
          `'evm:8453','${hash}','7'`,
        ],
        [
          "manifest",
          "uuid,uuid,text,text[]",
          FUNDING_REFUND_EVM_MANIFEST_RECEIPTS_SQL,
          `'11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','evm:8453',array['${hash}']`,
        ],
        [
          "recorded",
          "jsonb",
          RECORDED_EXACT_REFUND_EVENTS_SQL,
          `'${JSON.stringify([{ identity: "fixture", network_id: "evm:8453", tx_hash: hash, event_index: "7" }])}'`,
        ],
      ]) {
        await db.query(`prepare alias_plan(${types}) as ${sql}`);
        for (const [sample, argumentsSql] of [
          ["hit", args],
          ["missing", args.replaceAll(hash, "0x" + "ff".repeat(32))],
        ]) {
          const report = (
            await db.query(
              `explain (analyze,buffers,format json) execute alias_plan(${argumentsSql})`,
            )
          ).rows[0]["QUERY PLAN"][0];
          assert.ok(
            (report.Plan["Local Hit Blocks"] ?? 0) < 100,
            JSON.stringify(report),
          );
          assert.ok(
            !JSON.stringify(report.Plan).includes('"Node Type":"Seq Scan"'),
            JSON.stringify(report),
          );
          metrics.push({
            mode,
            name,
            sample,
            ms: report["Execution Time"],
            buffers: report.Plan["Local Hit Blocks"],
          });
        }
        await db.query("deallocate alias_plan");
      }
    }
    console.log("PASS physical alias 100k plans", JSON.stringify(metrics));
  } finally {
    await db.query("rollback");
    db.release();
  }
}
