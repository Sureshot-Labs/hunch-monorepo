import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readReceiveExactRoleEvidence,
  RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL,
  RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL,
  receiveDestinationRoleKey,
} from "../../receive/receive-exact-role-evidence.js";
import {
  destinationActionProgressSchema,
  receiveDestinationReferenceContext,
} from "../../receive/receive-destination-action-scan.js";
import { FundingClassificationChangedError } from "../../persistence/funding-classification-revisions.js";
import { arbitrateReceiveRoleCandidates } from "../../receive/receive-role-arbitration.js";
import { receiveRoleEventFingerprint } from "../../receive/receive-role-progress.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1),
  operationId = id(2),
  segmentId = id(3);
const asset = {
  networkId: "evm:8453",
  assetId: `0x${"12".repeat(20)}`,
  decimals: 6,
};
const event = {
  networkId: asset.networkId,
  asset,
  sourceAddress: `0x${"34".repeat(20)}`,
  destinationAddress: `0x${"56".repeat(20)}`,
  rawAmount: "1000000",
  transactionHash: `0x${"78".repeat(32)}`,
  eventIndex: "1",
  ledgerHeight: "10",
  blockHash: `0x${"90".repeat(32)}`,
  observedAt: new Date(0),
};
const transactionReferenceCodec = {
  keyVersion: 1,
  fingerprint: () => "f".repeat(64),
  decrypt: () => event.transactionHash,
};
const referenceCodec = { fingerprint: () => "e".repeat(64) };
const input = {
  userId,
  event,
  transactionReferenceCodec,
  referenceCodec,
  limit: 10,
};
const destination = {
  user_id: userId,
  operation_user_id: userId,
  operation_id: operationId,
  segment_id: segmentId,
  operation_plan_kind: "wallet_route",
  provider_id: "relay",
  operation_status: "in_progress",
  operation_destination_target_snapshot: {
    location: { asset, details: { address: event.destinationAddress } },
  },
  quoted_min_output: { asset, raw: "1" },
  classification_revision: "7",
  source_may_be_moving: false,
  destination_known: false,
  exact_reference: true,
  source_attempt_exposed: false,
};

function database(
  handoffs: unknown[],
  destinations: Record<string, unknown>[],
) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    query: async (sql: string) => {
      calls++;
      if (sql === RECEIVE_EXACT_HANDOFF_EVIDENCE_SQL) return { rows: handoffs };
      assert.equal(sql, RECEIVE_EXACT_DESTINATION_EVIDENCE_SQL);
      return { rows: destinations };
    },
  };
}

test("exact reference reader preserves negative scope/status witnesses from the same query, without a second revision read", async () => {
  const db = database(
    [
      {
        user_id: userId,
        operation_id: id(4),
        classification_revision: "3",
        handoff_candidate: false,
      },
    ],
    [
      { ...destination, operation_status: "completed", exact_reference: false },
      {
        ...destination,
        operation_id: id(5),
        operation_destination_target_snapshot: {},
      },
    ],
  );
  const result = await readReceiveExactRoleEvidence(db as never, input);
  assert.equal(db.calls, 2);
  assert.equal(result.handoff.kind, "external");
  assert.equal(result.destination.kind, "external");
  assert.deepEqual(result.dependencies, [
    { userId, operationId: id(4), revision: "3" },
    { userId, operationId, revision: "7" },
    { userId, operationId: id(5), revision: "7" },
  ]);
});

test("completed destination summaries eliminate negative history rereads, but stale facts retry", async () => {
  const progress = destinationActionProgressSchema.parse({
    version: 1,
    role: "destination",
    kind: "complete",
    cursor: null,
    eventFingerprint: receiveRoleEventFingerprint(event),
    facts: { userId, operationId, revision: "7" },
    segmentId,
    codecContext: receiveDestinationReferenceContext(event, referenceCodec)
      .codecContext,
    referenceRetryRequired: false,
    sourceMayBeMoving: false,
    match: "unrelated",
  });
  const key = receiveDestinationRoleKey(operationId, segmentId);
  const db = database([], [{ ...destination, exact_reference: false }]);
  const read = (value = progress) =>
    readReceiveExactRoleEvidence(db as never, {
      ...input,
      destinationProgress: new Map([[key, value]]),
    });
  assert.equal((await read()).destination.kind, "external");
  assert.equal(db.calls, 2, "only the exact indexed witnesses are read");
  await assert.rejects(
    read({ ...progress, facts: { ...progress.facts, revision: "6" } }),
    FundingClassificationChangedError,
  );
  await assert.rejects(
    read({ ...progress, referenceRetryRequired: true }),
    FundingClassificationChangedError,
  );
  assert.equal(
    (await read({ ...progress, sourceMayBeMoving: true, match: "possible" }))
      .destination.kind,
    "recovery_required",
  );
  assert.equal(db.calls, 8, "none of these reads falls back to a history scan");
});

test("exact fallback destination wins over possible, but distinct exact legs are ambiguous", async () => {
  for (const [extraExact, expected] of [
    [false, "internal"],
    [true, "recovery_required"],
  ] as const) {
    const db = database(
      [],
      [
        destination,
        {
          ...destination,
          segment_id: id(6),
          exact_reference: extraExact,
          source_may_be_moving: true,
        },
      ],
    );
    const result = await readReceiveExactRoleEvidence(db as never, input);
    assert.equal(result.destination.kind, expected);
    assert.equal(result.dependencies.length, 2);
  }
  const possible = await readReceiveExactRoleEvidence(
    database(
      [],
      [
        {
          ...destination,
          exact_reference: false,
          source_may_be_moving: true,
        },
      ],
    ) as never,
    input,
  );
  assert.deepEqual(possible.destination, {
    kind: "recovery_required",
    reason: "owned_route_destination_correlation_pending",
  });
});

test("malformed legacy handoff remains a conflict, with its dependency retained", async () => {
  const db = database(
    [
      {
        user_id: userId,
        operation_id: operationId,
        classification_revision: "7",
        handoff_candidate: true,
        step_id: id(4),
        attempt_id: id(5),
        attempt_outcome: "submitted",
        reference_kind: "transaction",
        receipt_ref_lookup_hmac: "f".repeat(64),
        receipt_ref_ciphertext: null,
        lookup_key_version: 1,
        resolved_transaction_hash: event.transactionHash,
        resolved_event_index: event.eventIndex,
        normalized_action: {
          kind: "external_handoff",
          networkId: asset.networkId,
        },
        action_validation_result: {
          tokenAddress: asset.assetId,
          funderAddress: event.sourceAddress,
          recipientAddress: event.destinationAddress,
          amountRaw: event.rawAmount,
        },
      },
    ],
    [],
  );
  const result = await readReceiveExactRoleEvidence(db as never, input);
  assert.deepEqual(result.handoff, {
    kind: "recovery_required",
    reason: "handoff_reference_envelope_mismatch",
  });
  assert.equal(result.dependencies[0]?.revision, "7");
});

test("joint arbitration merges exact witnesses and rejects old physical envelope/mixed revisions", async () => {
  const evidence = await readReceiveExactRoleEvidence(
    database([], [destination]) as never,
    input,
  );
  const run = (
    exactRoleEvidence = evidence,
    dependencies = evidence.dependencies,
  ) =>
    arbitrateReceiveRoleCandidates({
      ...input,
      enumerationComplete: true,
      candidates: [],
      exactRoleEvidence,
      refundEvidence: {
        kind: "recorded",
        eventFingerprint: receiveRoleEventFingerprint(event),
        classification: { kind: "unmatched" },
        dependencies,
      },
    });
  const ready = await run();
  assert.equal(ready.kind, "ready_for_fence");
  if (ready.kind !== "ready_for_fence") throw Error("missing ready verdict");
  assert.equal(ready.classification.kind, "internal_destination");
  assert.equal(ready.dependencies.length, 1);
  assert.deepEqual(
    await run(evidence, [{ userId, operationId, revision: "8" }]),
    { kind: "incomplete", reason: "mixed_facts_revision" },
  );
  assert.deepEqual(
    await run({ ...evidence, eventFingerprint: "0".repeat(64) }),
    { kind: "incomplete", reason: "candidate_context_changed" },
  );
  assert.deepEqual(await run({ ...evidence, dependencies: [] }, []), {
    kind: "incomplete",
    reason: "candidate_facts_pending",
  });
  for (const stale of [
    { ...evidence, handoffCodecContext: "0".repeat(64) },
    { ...evidence, destinationCodecContext: "0".repeat(64) },
  ])
    assert.deepEqual(await run(stale), {
      kind: "incomplete",
      reason: "candidate_context_changed",
    });
  const negative = {
    ...evidence,
    destination: { kind: "external" as const },
    dependencies: [],
  };
  assert.deepEqual(
    await arbitrateReceiveRoleCandidates({
      ...input,
      referenceCodec: { fingerprint: () => "a".repeat(64) },
      enumerationComplete: true,
      candidates: [],
      exactRoleEvidence: negative,
      refundEvidence: {
        kind: "recorded",
        eventFingerprint: receiveRoleEventFingerprint(event),
        classification: { kind: "unmatched" },
        dependencies: [],
      },
    }),
    { kind: "incomplete", reason: "candidate_context_changed" },
  );
});

test("codec outage cannot become a negative witness; retry with same key recovers", async () => {
  const db = database([], []);
  await assert.rejects(
    readReceiveExactRoleEvidence(db as never, {
      ...input,
      referenceCodec: {
        fingerprint: () => {
          throw Error("offline");
        },
      },
    }),
  );
  assert.equal(db.calls, 0);
  assert.equal(
    (await readReceiveExactRoleEvidence(db as never, input)).destination.kind,
    "external",
  );
  for (const bad of [
    { ...event, sourceAddress: null },
    { ...event, networkId: "solana:mainnet" },
  ]) {
    const untouched = database([], []);
    await assert.rejects(
      readReceiveExactRoleEvidence(untouched as never, {
        ...input,
        event: bad,
      }),
    );
    assert.equal(untouched.calls, 0);
  }
});
