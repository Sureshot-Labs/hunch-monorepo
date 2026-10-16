import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FUNDING_HANDOFF_OPERATION_PAGE_SQL,
  listFundingHandoffOperationPage,
} from "../../persistence/funding-evidence-repository.js";
import {
  FUNDING_CLASSIFICATION_REVISION_SQL,
  FundingClassificationChangedError,
} from "../../persistence/funding-classification-revisions.js";

const facts = {
  operationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  revision: "4",
};

test("handoff page cursors count unrelated/unissued work and retain other-hash candidates", async () => {
  const row = {
    operation_id: facts.operationId,
    step_id: "step",
    attempt_id: "attempt",
    attempt_outcome: "succeeded",
    reference_kind: "external_handoff",
    resolved_transaction_hash: `0x${"ef".repeat(32)}`,
    resolved_event_index: "2",
    receipt_ref_ciphertext: "opaque",
    receipt_ref_lookup_hmac: "fingerprint",
    lookup_key_version: 2,
    normalized_action: { kind: "external_handoff" },
    action_validation_result: { amountRaw: "123" },
    step_ordinal: 3,
    attempt_number: 12,
    handoff_candidate: true,
  };
  let reads = 0;
  const db = {
    query: async (sql: string, args: unknown[]) => {
      if (sql === FUNDING_CLASSIFICATION_REVISION_SQL) {
        reads++;
        return { rows: [{ revision: facts.revision }] };
      }
      assert.equal(sql, FUNDING_HANDOFF_OPERATION_PAGE_SQL);
      assert.deepEqual(args, [facts.operationId, facts.userId, 2, 11, 3]);
      return {
        rows: [
          row,
          {
            ...row,
            step_ordinal: 4,
            attempt_number: 0,
            attempt_id: null,
            handoff_candidate: false,
          },
          { ...row, step_ordinal: 5, attempt_number: 1 },
        ],
      };
    },
  };
  const page = await listFundingHandoffOperationPage(db as never, {
    facts,
    cursor: { stepOrdinal: 2, attemptNumber: 11 },
    limit: 2,
  });
  assert.equal(reads, 2);
  assert.deepEqual(page.nextCursor, { stepOrdinal: 4, attemptNumber: 0 });
  assert.equal(page.candidates.length, 1);
  assert.equal(
    page.candidates[0].resolvedTransactionHash,
    row.resolved_transaction_hash,
  );
  assert.equal(page.candidates[0].resolvedEventIndex, "2");
});

test("an empty handoff page still requires the same committed revision", async () => {
  for (const changedAt of [1, 2]) {
    let revisionReads = 0;
    let pageReads = 0;
    const db = {
      query: async (sql: string) => {
        if (sql === FUNDING_CLASSIFICATION_REVISION_SQL) {
          revisionReads++;
          return {
            rows: [{ revision: revisionReads === changedAt ? "5" : "4" }],
          };
        }
        assert.equal(sql, FUNDING_HANDOFF_OPERATION_PAGE_SQL);
        pageReads++;
        return { rows: [] };
      },
    };
    await assert.rejects(
      listFundingHandoffOperationPage(db as never, {
        facts,
        cursor: null,
        limit: 1,
      }),
      FundingClassificationChangedError,
    );
    assert.equal(pageReads, changedAt === 1 ? 0 : 1);
  }
});

test("handoff page refuses invalid resource bounds and cursors before SQL", async () => {
  const db = { query: async () => assert.fail("invalid input must not query") };
  for (const limit of [0, -1, 1.5, NaN, Infinity, 2147483646])
    await assert.rejects(
      listFundingHandoffOperationPage(db as never, {
        facts,
        cursor: null,
        limit,
      }),
    );
  for (const cursor of [
    { stepOrdinal: -1, attemptNumber: 0 },
    { stepOrdinal: 0, attemptNumber: -1 },
    { stepOrdinal: 2147483648, attemptNumber: 0 },
    { stepOrdinal: 0, attemptNumber: NaN },
  ])
    await assert.rejects(
      listFundingHandoffOperationPage(db as never, { facts, cursor, limit: 1 }),
    );
});
