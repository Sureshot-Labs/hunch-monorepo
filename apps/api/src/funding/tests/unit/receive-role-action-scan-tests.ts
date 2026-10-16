import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { FUNDING_CLASSIFICATION_REVISION_SQL } from "../../persistence/funding-classification-revisions.js";
import { FUNDING_HANDOFF_OPERATION_PAGE_SQL } from "../../persistence/funding-evidence-repository.js";
import { classifyPolymarketHandoffEvents } from "../../receive/receive-handoff-classification.js";
import {
  handoffActionProgressSchema,
  mergeHandoffPageClassification,
  readReceiveHandoffActionPage,
} from "../../receive/receive-handoff-action-scan.js";
import {
  destinationActionProgressSchema,
  readReceiveDestinationActionPage,
  RECEIVE_DESTINATION_HEADER_SQL,
  RECEIVE_DESTINATION_ACTION_PAGE_SQL,
} from "../../receive/receive-destination-action-scan.js";
import {
  immutableReceiveDestinationMatches,
  receiveSourceRoleMembership,
} from "../../receive/receive-role-membership.js";
import { receiveRoleEventFingerprint } from "../../receive/receive-role-progress.js";
import type { RefundSourceCandidateRow } from "../../reconciliation/relay-refund-source-candidates.js";

const userId = "11111111-1111-4111-8111-111111111111",
  operationId = "22222222-2222-4222-8222-222222222222";
const segmentId = "33333333-3333-4333-8333-333333333333",
  attemptId = "44444444-4444-4444-8444-444444444444";
const asset = {
  networkId: "evm:137",
  assetId: `0x${"11".repeat(20)}`,
  decimals: 6,
};
const event = {
  networkId: asset.networkId,
  asset,
  sourceAddress: `0x${"22".repeat(20)}`,
  destinationAddress: `0x${"33".repeat(20)}`,
  rawAmount: "10000000",
  transactionHash: `0x${"ab".repeat(32)}`,
  eventIndex: "1",
  ledgerHeight: "100",
  blockHash: `0x${"cd".repeat(32)}`,
  observedAt: new Date(),
};
const transferData = new ethers.Interface([
  "function transfer(address recipient,uint256 amount)",
]).encodeFunctionData("transfer", [event.destinationAddress, event.rawAmount]);
const action = {
  kind: "external_handoff",
  actionId: "action_valid_12345678",
  networkId: asset.networkId,
  actorWalletId: "wallet_valid_12345678",
  handoffKind: "polymarket_deposit_wallet_transfer",
  payload: {
    topology: "deposit_wallet",
    funder: event.sourceAddress,
    recipient: event.destinationAddress,
    token: asset.assetId,
    amountRaw: event.rawAmount,
    calls: [{ target: asset.assetId, value: "0", data: transferData }],
  },
};
const validation = {
  executionEnvelope: "polymarket_deposit_wallet_to_controller_v1",
  funderAddress: event.sourceAddress,
  recipientAddress: event.destinationAddress,
  tokenAddress: asset.assetId,
  amountRaw: event.rawAmount,
  transferData,
};
const candidate = {
  operationId,
  attemptId,
  stepId: segmentId,
  attemptOutcome: "submitted" as const,
  referenceKind: "transaction" as const,
  normalizedAction: action,
  actionValidationResult: validation,
  receiptRefCiphertext: "encrypted",
  receiptRefLookupHmac: null,
  lookupKeyVersion: 1,
  resolvedTransactionHash: event.transactionHash,
  resolvedEventIndex: event.eventIndex,
};
const dbRow = {
  operation_id: operationId,
  attempt_id: attemptId,
  step_id: segmentId,
  step_ordinal: 0,
  attempt_number: 1,
  handoff_candidate: true,
  attempt_outcome: "submitted",
  reference_kind: "transaction",
  normalized_action: action,
  action_validation_result: validation,
  receipt_ref_ciphertext: "encrypted",
  receipt_ref_lookup_hmac: null,
  lookup_key_version: 1,
  resolved_transaction_hash: null,
  resolved_event_index: "1",
};
const header = {
  user_id: userId,
  operation_user_id: userId,
  operation_plan_kind: "wallet_route",
  operation_status: "in_progress",
  segment_id: segmentId,
  provider_id: "relay",
  operation_destination_target_snapshot: {
    location: { asset, details: { address: event.destinationAddress } },
  },
  quoted_min_output: { asset, raw: "1" },
  source_may_be_moving: false,
  destination_known: false,
  exact_reference: false,
};

test("partial transaction handoff mismatch remains retryable until exact log evidence excludes it", () => {
  const referenced = {
    ...event,
    variant: { networkId: asset.networkId, asset },
  };
  const sibling = { ...referenced, rawAmount: "42", eventIndex: "2" };
  const unresolved = { ...candidate, resolvedEventIndex: null };
  const fingerprinted = (entry: typeof referenced) => ({
    event: entry,
    receiptRefLookupHmac: null,
  });
  const identity = `${event.networkId}:${event.transactionHash}:2`;
  assert.equal(
    classifyPolymarketHandoffEvents(
      [fingerprinted(referenced), fingerprinted(sibling)],
      [unresolved],
    ).get(identity)?.kind,
    "external",
  );
  const partial = classifyPolymarketHandoffEvents(
    [fingerprinted(sibling)],
    [unresolved],
    null,
    { eventSubset: true },
  ).get(identity);
  assert.deepEqual(partial, {
    kind: "recovery_required",
    reason: "handoff_correlation_pending",
  });
  assert.deepEqual(
    classifyPolymarketHandoffEvents(
      [fingerprinted(sibling)],
      [candidate],
      null,
      { eventSubset: true },
    ).get(identity),
    { kind: "external", reason: null },
  );
});

test("membership uses operation final target, preserves legacy assets and unrelated source handoffs", () => {
  assert.ok(immutableReceiveDestinationMatches(userId, event, header));
  const legacyAsset = { ...asset, decimals: "6", label: "legacy extension" };
  assert.ok(
    immutableReceiveDestinationMatches(userId, event, {
      ...header,
      operation_destination_target_snapshot: {
        location: {
          asset: legacyAsset,
          details: { address: event.destinationAddress },
        },
      },
      quoted_min_output: { asset: legacyAsset },
    }),
  );
  for (const patch of [
    { operation_user_id: operationId },
    { provider_id: "other" },
    { segment_id: null },
    { operation_plan_kind: "venue_preparation" },
    { quoted_min_output: { asset: { ...asset, decimals: 8 } } },
    {
      operation_destination_target_snapshot: {
        location: { asset, details: { address: event.sourceAddress } },
      },
    },
  ])
    assert.equal(
      immutableReceiveDestinationMatches(userId, event, {
        ...header,
        ...patch,
      }),
      false,
    );
  const source = {
    ...header,
    operation_id: operationId,
    reservation_id: attemptId,
    source_snapshot: null,
    refund_location_snapshot: null,
    network_id: "unrelated",
    asset_id: "unrelated",
  } as unknown as RefundSourceCandidateRow;
  for (const plan of ["wallet_route", "composite_route", "venue_preparation"])
    assert.equal(
      receiveSourceRoleMembership(userId, event, {
        ...source,
        operation_plan_kind: plan,
      }).handoff,
      true,
    );
  assert.equal(
    receiveSourceRoleMembership(userId, event, {
      ...source,
      user_id: operationId,
    }).handoff,
    false,
  );
});

test("event fingerprint ignores polling time, preserves physical envelope and normalizes EVM case", () => {
  assert.equal(
    receiveRoleEventFingerprint(event),
    receiveRoleEventFingerprint({
      ...event,
      observedAt: new Date(0),
      destinationAddress: event.destinationAddress.toUpperCase(),
      transactionHash: event.transactionHash.toUpperCase(),
    }),
  );
  for (const patch of [
    { eventIndex: "2" },
    { rawAmount: "10000001" },
    { sourceAddress: null },
    { asset: { ...asset, decimals: 8 } },
    { ledgerHeight: "101" },
    { blockHash: `0x${"ef".repeat(32)}` },
  ])
    assert.notEqual(
      receiveRoleEventFingerprint(event),
      receiveRoleEventFingerprint({ ...event, ...patch }),
    );
});

test("handoff page partitions preserve retryable whole-set verdict for exact/exact/pending", () => {
  const candidates = [
    candidate,
    { ...candidate, attemptId: segmentId },
    { ...candidate, attemptId: userId, resolvedEventIndex: null },
  ];
  const wrapped = {
    event: { ...event, variant: { networkId: event.networkId, asset } },
    receiptRefLookupHmac: null,
  };
  const classify = (values: typeof candidates) =>
    [...classifyPolymarketHandoffEvents([wrapped], values).values()][0];
  const expected = classify(candidates);
  assert.deepEqual(expected, {
    kind: "recovery_required",
    reason: "handoff_correlation_pending",
  });
  for (const order of [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])
    for (const size of [1, 2, 3]) {
      let result = classify([]);
      for (let i = 0; i < 3; i += size)
        result = mergeHandoffPageClassification(
          result,
          classify(order.slice(i, i + size).map((index) => candidates[index])),
        );
      assert.deepEqual(result, expected);
    }
  assert.deepEqual(
    mergeHandoffPageClassification(
      classify([candidate]),
      classify([candidate]),
    ),
    classify([candidate]),
  );
});

test("handoff same-revision codec recovery, context changes and frozen identity restart", async () => {
  let pageReads = 0,
    revision = "1",
    decryptWorks = false;
  const codec = {
    keyVersion: 1,
    fingerprint: () => "f".repeat(64),
    decrypt: () => {
      if (!decryptWorks) throw Error("temporary");
      return event.transactionHash;
    },
  };
  const db = {
    query: async (sql: string) => {
      if (sql === FUNDING_CLASSIFICATION_REVISION_SQL)
        return { rows: [{ revision }] };
      assert.equal(sql, FUNDING_HANDOFF_OPERATION_PAGE_SQL);
      pageReads++;
      return { rows: [dbRow] };
    },
  };
  const input = {
    userId,
    operationId,
    event,
    progress: null,
    limit: 2,
    transactionReferenceCodec: codec,
  };
  const failed = await readReceiveHandoffActionPage(db as never, input);
  assert.equal(failed.kind, "complete");
  if (failed.kind !== "complete") return;
  assert.equal(failed.referenceRetryRequired, true);
  assert.ok(handoffActionProgressSchema.safeParse(failed).success);
  assert.deepEqual(Object.keys(failed.facts).sort(), [
    "operationId",
    "revision",
    "userId",
  ]);
  decryptWorks = true;
  const repaired = await readReceiveHandoffActionPage(db as never, {
    ...input,
    progress: failed,
  });
  assert.equal(pageReads, 2);
  assert.equal(repaired.kind, "complete");
  if (repaired.kind !== "complete") return;
  assert.equal(repaired.referenceRetryRequired, false);
  assert.equal(repaired.classification.kind, "internal");
  assert.deepEqual(
    await readReceiveHandoffActionPage(db as never, {
      ...input,
      progress: repaired,
    }),
    repaired,
  );
  assert.equal(pageReads, 2);
  await readReceiveHandoffActionPage(db as never, {
    ...input,
    progress: repaired,
    transactionReferenceCodec: { ...codec, keyVersion: 2 },
  });
  assert.equal(pageReads, 3);
  assert.deepEqual(
    await readReceiveHandoffActionPage(db as never, {
      ...input,
      progress: repaired,
      event: { ...event, rawAmount: "2" },
    }),
    { kind: "restart" },
  );
  revision = "2";
  assert.deepEqual(
    await readReceiveHandoffActionPage(db as never, {
      ...input,
      progress: repaired,
    }),
    { kind: "restart" },
  );
});

test("destination pages retain negative dependencies, exact wins and recovery requires current facts", async () => {
  let pageReads = 0,
    revision = "5";
  let current = { ...header };
  const db = {
    query: async (sql: string, args: unknown[]) => {
      if (sql === FUNDING_CLASSIFICATION_REVISION_SQL)
        return { rows: [{ revision }] };
      if (sql === RECEIVE_DESTINATION_HEADER_SQL) return { rows: [current] };
      assert.equal(sql, RECEIVE_DESTINATION_ACTION_PAGE_SQL);
      pageReads++;
      assert.equal(args[0], operationId);
      assert.equal(args[1], segmentId);
      return {
        rows:
          args[3] === -1
            ? [
                {
                  step_ordinal: 0,
                  attempt_number: 1,
                  source_may_be_moving: false,
                },
                {
                  step_ordinal: 1,
                  attempt_number: 1,
                  source_may_be_moving: true,
                },
              ]
            : [
                {
                  step_ordinal: 1,
                  attempt_number: 1,
                  source_may_be_moving: true,
                },
              ],
      };
    },
  };
  const input = {
    userId,
    operationId,
    segmentId,
    event,
    progress: null,
    limit: 1,
    referenceCodec: { fingerprint: () => "f".repeat(64) },
  };
  const first = await readReceiveDestinationActionPage(db as never, input);
  assert.equal(first.kind, "continuation");
  if (first.kind !== "continuation") return;
  assert.deepEqual(first.cursor, { stepOrdinal: 0, attemptNumber: 1 });
  assert.ok(destinationActionProgressSchema.safeParse(first).success);
  const possible = await readReceiveDestinationActionPage(db as never, {
    ...input,
    progress: first,
  });
  assert.equal(possible.kind, "complete");
  if (possible.kind !== "complete") return;
  assert.equal(possible.match, "possible");
  current = { ...header, exact_reference: true };
  revision = "6";
  assert.deepEqual(
    await readReceiveDestinationActionPage(db as never, {
      ...input,
      progress: possible,
    }),
    { kind: "restart" },
  );
  const exact = await readReceiveDestinationActionPage(db as never, input);
  assert.equal(exact.kind, "complete");
  if (exact.kind !== "complete") return;
  assert.equal(exact.match, "exact");
  assert.equal(pageReads, 2);
  for (const patch of [
    { destination_known: true },
    { operation_status: "completed" },
  ]) {
    current = { ...header, ...patch };
    const negative = await readReceiveDestinationActionPage(db as never, input);
    assert.equal(negative.kind, "complete");
    if (negative.kind !== "complete") return;
    assert.equal(negative.match, "unrelated");
    assert.equal(negative.facts.revision, "6");
    assert.equal(pageReads, 2);
  }
  current = { ...header, destination_known: true };
  const noCodec = await readReceiveDestinationActionPage(db as never, {
    ...input,
    referenceCodec: undefined,
  });
  assert.equal(noCodec.kind, "complete");
  if (noCodec.kind !== "complete") return;
  assert.equal(noCodec.referenceRetryRequired, true);
  const recovered = await readReceiveDestinationActionPage(db as never, {
    ...input,
    progress: noCodec,
  });
  assert.equal(recovered.kind, "complete");
  if (recovered.kind !== "complete") return;
  assert.equal(recovered.referenceRetryRequired, false);
});

test("destination mid-page revision change never publishes a mixed summary", async () => {
  let reads = 0;
  const db = {
    query: async (sql: string) => {
      if (sql === FUNDING_CLASSIFICATION_REVISION_SQL)
        return { rows: [{ revision: ++reads === 3 ? "2" : "1" }] };
      assert.equal(sql, RECEIVE_DESTINATION_HEADER_SQL);
      return { rows: [{ ...header, exact_reference: true }] };
    },
  };
  assert.deepEqual(
    await readReceiveDestinationActionPage(db as never, {
      userId,
      operationId,
      segmentId,
      event,
      progress: null,
      limit: 1,
    }),
    { kind: "restart" },
  );
});
