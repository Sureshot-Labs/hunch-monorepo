import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  EXACT_REFUND_OBSERVER_ID,
  type FundingRefundContract,
} from "../domain/refund-settlement.js";
import { canonicalJsonHash } from "../persistence/canonical.js";
import {
  allocateFundingObservationInTransaction,
  appendFundingRefundCompletionProof,
} from "../persistence/funding-operation-repository.js";
import {
  readRefundCompletionPage,
  refundCompletionProgressSchema,
  type RefundCompletionProgress,
} from "../reconciliation/relay-refund-completion-scan.js";
import { RELAY_REQUEST_TRANSACTION_LIMIT } from "../../funding-providers/relay/request-evidence.js";

/** Only called against the manifest suite's session-local observation table.
 * No network, source execution, classification write or production data. */
export async function verifyRefundCompletionScanPg(
  db: Pick<PoolClient, "query">,
) {
  await db.query("savepoint refund_completion_scan");
  try {
    async function fixture(count: number, native = false) {
      const operationId = randomUUID(),
        segmentId = randomUUID();
      const asset = {
        networkId: native ? "hyperliquid:mainnet" : "evm:8453",
        assetId: native
          ? "0x6d1e7cde53ba9467b783cb7c530ce054"
          : `0x${"ab".repeat(20)}`,
        decimals: native ? 8 : 6,
      };
      const target = {
        locationId: randomUUID(),
        asset,
        address: `0x${"cd".repeat(20)}`,
        nativeDex: native ? ("spot" as const) : null,
      };
      const binding = {
        requestFingerprint: "a".repeat(64),
        lookupKeyVersion: 1,
        protocolOrderId: `0x${"b".repeat(64)}`,
      };
      const contract: FundingRefundContract = {
        supported: true,
        requestBinding: binding,
        locations: [target],
      };
      const identity = {
        version: 1,
        ...binding,
        refundLocationId: target.locationId,
      };
      const rows = [];
      for (let index = 0; index < count; index++) {
        const row = await allocateFundingObservationInTransaction(db, {
          operationId,
          segmentId,
          kind: "refund_credit",
          networkId: asset.networkId,
          assetId: asset.assetId,
          assetDecimals: asset.decimals,
          txHash: `0x${canonicalJsonHash([operationId, index])}`,
          eventIndex: native ? "hypercore:send:destination_credit" : "7",
          fromAddress: `0x${"ef".repeat(20)}`,
          toAddress: target.address,
          rawAmount: "4000000",
          observedAt: new Date(),
          finalizedAt: new Date(),
          ledgerHeight: native ? null : "123",
          blockHash: native ? null : `0x${"ed".repeat(32)}`,
          finalityStatus: "finalized",
          metadata: {
            observerId: EXACT_REFUND_OBSERVER_ID,
            relayRefundReceipt: identity,
            nativeDestinationDex: target.nativeDex,
          },
        });
        rows.push(row.observation);
      }
      const ids = rows.map((row) => row.id).sort();
      const proof = {
        ...identity,
        expectedReturned: { asset, raw: (4000000n * BigInt(count)).toString() },
        observationIds: ids,
      };
      const append = {
        operationId,
        segmentId,
        observationId: ids[0],
        observerId: EXACT_REFUND_OBSERVER_ID,
        proof,
      };
      const input = { operationId, segmentId, contract, limit: 1 };
      return { input, rows, proof, append };
    }
    const walk = async (
      input: Parameters<typeof readRefundCompletionPage>[1],
      maxPages = 66,
    ) => {
      let result = await readRefundCompletionPage(db, input),
        pages = 1;
      while (result.kind === "reading") {
        assert.ok(pages < maxPages, "bounded manifest must make progress");
        const checkpoint = refundCompletionProgressSchema.parse(
          JSON.parse(JSON.stringify(result)),
        );
        result = await readRefundCompletionPage(db, {
          ...input,
          progress: checkpoint,
        });
        pages++;
      }
      return { result, pages };
    };
    const unchecked = { kind: "unchecked" } as const;
    for (const native of [false, true]) {
      const f = await fixture(2, native);
      assert.deepEqual(
        (await walk({ ...f.input, progress: unchecked })).result,
        { kind: "pending", reason: "proof_missing" },
      );
      assert.equal(
        await appendFundingRefundCompletionProof(db, f.append),
        "appended",
      );
      const read = () => walk({ ...f.input, progress: unchecked });
      const complete = await read();
      assert.equal(complete.pages, 2);
      assert.deepEqual(complete.result, {
        kind: "complete_refund_set",
        anchorObservationId: f.append.observationId,
        fingerprint: canonicalJsonHash(f.proof),
        receiptCount: 2,
      });
      // Reader must not fetch the unbounded append-only proof map.
      const captured: string[] = [];
      const traced = {
        query: async (sql: string, args: unknown[]) => {
          captured.push(sql);
          return db.query(sql, args);
        },
      } as Pick<PoolClient, "query">;
      await readRefundCompletionPage(traced, {
        ...f.input,
        limit: 10,
        progress: unchecked,
      });
      assert.ok(
        captured.some((sql) =>
          sql.includes("metadata->'relayRefundCompletionProofs'->$4::text"),
        ),
      );
      assert.ok(!captured.some((sql) => /select\s+metadata\s+from/u.test(sql)));
      for (const patch of [
        { raw_amount: "4000001" },
        { asset_decimals: native ? 6 : 8 },
        { to_address: `0x${"11".repeat(20)}` },
        { from_address: null },
        { ledger_height: native ? "123" : null },
        { metadata: { observerId: "foreign" } },
        {
          metadata: {
            ...f.rows[0].metadata,
            relayRefundReceipt: {
              ...f.proof,
              requestFingerprint: "f".repeat(64),
            },
          },
        },
        {
          metadata: {
            ...f.rows[0].metadata,
            nativeDestinationDex: native ? "" : "spot",
          },
        },
        {
          canonical: false,
          finality_status: "reorged",
          reorged_at: new Date().toISOString(),
        },
      ]) {
        await db.query("savepoint refund_completion_mutation");
        await db.query(
          `update funding_observations observation_row set
          raw_amount=changed_row.raw_amount,asset_decimals=changed_row.asset_decimals,
          to_address=changed_row.to_address,from_address=changed_row.from_address,
          ledger_height=changed_row.ledger_height,metadata=changed_row.metadata,
          canonical=changed_row.canonical,finality_status=changed_row.finality_status,reorged_at=changed_row.reorged_at
          from funding_observations original_row
          cross join lateral jsonb_populate_record(null::funding_observations,to_jsonb(original_row)||$2::jsonb) changed_row
          where observation_row.id=$1 and original_row.id=observation_row.id`,
          [f.rows[0].id, patch],
        );
        assert.notEqual(
          (await read()).result.kind,
          "complete_refund_set",
          JSON.stringify(patch),
        );
        await db.query("rollback to savepoint refund_completion_mutation");
        await db.query("release savepoint refund_completion_mutation");
      }
      assert.deepEqual(
        await read(),
        complete,
        "ordinary next pass recovers after canonical repair",
      );
      await db.query("savepoint refund_completion_conflict");
      await db.query(
        "update funding_observations set metadata=jsonb_set(metadata,array['relayRefundCompletionProofs',$2::text],$3::jsonb) where id=$1",
        [
          f.append.observationId,
          canonicalJsonHash(f.proof),
          {
            ...f.proof,
            expectedReturned: { ...f.proof.expectedReturned, raw: "1" },
          },
        ],
      );
      assert.deepEqual((await read()).result, {
        kind: "pending",
        reason: "proof_conflict",
      });
      await db.query("rollback to savepoint refund_completion_conflict");
      await db.query("release savepoint refund_completion_conflict");
      assert.deepEqual(await read(), complete);
      assert.deepEqual(
        (
          await walk({
            ...f.input,
            segmentId: randomUUID(),
            progress: unchecked,
          })
        ).result,
        { kind: "pending", reason: "no_current_receipts" },
      );
    }
    const maximum = await fixture(RELAY_REQUEST_TRANSACTION_LIMIT);
    assert.equal(
      await appendFundingRefundCompletionProof(db, maximum.append),
      "appended",
    );
    const maxResult = await walk({
      ...maximum.input,
      limit: 7,
      progress: unchecked,
    });
    assert.equal(maxResult.result.kind, "complete_refund_set");
    assert.equal(
      maxResult.pages,
      Math.ceil(RELAY_REQUEST_TRANSACTION_LIMIT / 7),
    );
    const overflow = await fixture(RELAY_REQUEST_TRANSACTION_LIMIT + 1);
    assert.deepEqual(
      (await walk({ ...overflow.input, limit: 7, progress: unchecked })).result,
      { kind: "pending", reason: "manifest_exceeded" },
    );
    for (const limit of [0, -1, 0.5, Infinity, 2147483646])
      await assert.rejects(
        readRefundCompletionPage(db, {
          ...maximum.input,
          limit,
          progress: unchecked,
        }),
      );
    const first = await readRefundCompletionPage(db, {
      ...maximum.input,
      limit: 2,
      progress: unchecked,
    });
    assert.equal(first.kind, "reading");
    if (first.kind !== "reading") assert.fail("expected checkpoint");
    const corrupt: RefundCompletionProgress = {
      ...first,
      members: [first.members[0], first.members[0]],
    };
    assert.deepEqual(
      await readRefundCompletionPage(db, {
        ...maximum.input,
        progress: corrupt,
      }),
      { kind: "pending", reason: "invalid_receipt" },
    );
    console.log(
      "PASS current refund-set paging, restart round-trip, exact proof, conflicting/reorged evidence, repair and provider manifest bounds",
    );
  } finally {
    await db.query("rollback to savepoint refund_completion_scan");
    await db.query("release savepoint refund_completion_scan");
  }
}
