import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "@hunch/infra";

/** The real observation trigger, using a receipt produced by the exact writer.
 * Recovery may replace only canonicality/anchor evidence, never economic identity.
 * Every probe is isolated and rolled back; no trigger or constraints are disabled.
 */
export async function verifyExactRefundRemineGuardPg(
  db: Pick<PoolClient, "query">,
  input: { operationId: string; transactionHash: string; now: Date },
) {
  const receipt = (
    await db.query<{ id: string; asset_id: string; raw_amount: string }>(
      `select id,asset_id,raw_amount from funding_observations
       where operation_id=$1::uuid and tx_hash=$2 and kind='refund_credit'
         and metadata->>'observerId'='relay_exact_refund_observation_v1'`,
      [input.operationId, input.transactionHash],
    )
  ).rows;
  assert.equal(receipt.length, 1);
  const original = receipt[0];
  const recanonicalize = async (
    id: string,
    mutation: Record<string, unknown>,
    removeMetadataKeys: string[] = [],
  ) => {
    await db.query(
      `update funding_observations set canonical=false,finality_status='reorged',reorged_at=$2
       where id=$1::uuid`,
      [id, input.now],
    );
    return db.query(
      `update funding_observations observation_row
       set (kind,network_id,asset_id,asset_decimals,tx_hash,event_index,from_address,
            to_address,raw_amount,observed_at,ledger_height,block_hash,canonical,
            finality_status,finalized_at,reorged_at,metadata) = (
         select changed_row.kind,changed_row.network_id,changed_row.asset_id,
           changed_row.asset_decimals,changed_row.tx_hash,changed_row.event_index,
           changed_row.from_address,changed_row.to_address,changed_row.raw_amount,
           changed_row.observed_at,changed_row.ledger_height,changed_row.block_hash,
           changed_row.canonical,changed_row.finality_status,changed_row.finalized_at,
           changed_row.reorged_at,changed_row.metadata
         from jsonb_populate_record(null::funding_observations,
           to_jsonb(observation_row) || jsonb_build_object(
             'ledger_height','4321','block_hash',$3::text,'canonical',true,
             'finality_status','finalized','finalized_at',$4::timestamptz,'reorged_at',null,
             'metadata',(observation_row.metadata || jsonb_build_object(
               'exactRefundCanonicalityHistory',coalesce(observation_row.metadata->'exactRefundCanonicalityHistory','[]'::jsonb)
                 || jsonb_build_array(jsonb_build_object('previousBlock',observation_row.ledger_height,
                   'previousBlockHash',observation_row.block_hash,'reorgedAt',observation_row.reorged_at,
                   'recanonicalizedAt',$4::timestamptz)))) - $5::text[]) || $2::jsonb) changed_row
       ) where observation_row.id=$1::uuid`,
      [
        id,
        mutation,
        `0x${"ab".repeat(32)}`,
        new Date(input.now.getTime() + 1000),
        removeMetadataKeys,
      ],
    );
  };
  const reject = async (
    mutation: Record<string, unknown>,
    id = original.id,
    removeMetadataKeys: string[] = [],
  ) => {
    await db.query("savepoint exact_refund_remine_rejection");
    try {
      await assert.rejects(
        recanonicalize(id, mutation, removeMetadataKeys),
        (error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "23514",
      );
    } finally {
      await db.query("rollback to savepoint exact_refund_remine_rejection");
      await db.query("release savepoint exact_refund_remine_rejection");
    }
  };
  for (const mutation of [
    { raw_amount: "1" },
    { asset_id: `0x${"a1".repeat(20)}` },
    { asset_decimals: 18 },
    { network_id: "evm:1" },
    { from_address: `0x${"a2".repeat(20)}` },
    { to_address: `0x${"a3".repeat(20)}` },
    { tx_hash: `0x${"a4".repeat(32)}` },
    { event_index: "9876" },
    { kind: "destination_credit" },
    { observed_at: new Date(input.now.getTime() + 5000).toISOString() },
    { metadata: {} },
  ])
    await reject(mutation);
  // Keep a correct prior-anchor history while removing immutable provenance.
  // This isolates metadata containment instead of relying on a missing-history
  // failure to masquerade as an append-only metadata test.
  await reject({}, original.id, ["observerId"]);
  await reject({}, original.id, ["relayRefundReceipt"]);
  await reject({ ledger_height: null });
  await reject({ block_hash: null });

  // The new exception is not an arbitrary ERC20 re-mining permission, even if
  // a historical unknown token row has the exact-observer metadata shape.
  await db.query("savepoint unsupported_exact_refund_remine");
  try {
    const unsupported = randomUUID();
    await db.query(
      `insert into funding_observations
       select (jsonb_populate_record(null::funding_observations,to_jsonb(observation_row)
         || jsonb_build_object('id',$2::uuid,'tx_hash',$3::text,'asset_id',$4::text))).*
       from funding_observations observation_row where id=$1::uuid`,
      [
        original.id,
        unsupported,
        `0x${randomUUID().replaceAll("-", "").repeat(2)}`,
        `0x${"a5".repeat(20)}`,
      ],
    );
    await reject({}, unsupported);
  } finally {
    await db.query("rollback to savepoint unsupported_exact_refund_remine");
    await db.query("release savepoint unsupported_exact_refund_remine");
  }

  await db.query("savepoint exact_refund_remine_acceptance");
  try {
    assert.equal((await recanonicalize(original.id, {})).rowCount, 1);
    const updated = (
      await db.query(
        "select asset_id,raw_amount,canonical,finality_status,ledger_height from funding_observations where id=$1",
        [original.id],
      )
    ).rows[0];
    assert.equal(updated.asset_id, original.asset_id);
    assert.equal(updated.raw_amount, original.raw_amount);
    assert.equal(updated.canonical, true);
    assert.equal(updated.finality_status, "finalized");
    assert.equal(updated.ledger_height, "4321");
  } finally {
    await db.query("rollback to savepoint exact_refund_remine_acceptance");
    await db.query("release savepoint exact_refund_remine_acceptance");
  }
}
