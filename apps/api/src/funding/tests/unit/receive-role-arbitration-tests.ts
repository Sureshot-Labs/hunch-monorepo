import assert from "node:assert/strict";
import { test } from "node:test";
import {
  arbitrateReceiveRoleCandidates,
  type ReceiveRoleCandidate,
  type ReceiveRefundRoleEvidence,
} from "../../receive/receive-role-arbitration.js";
import { receiveRoleEventFingerprint } from "../../receive/receive-role-progress.js";
import { receiveHandoffReferenceContext } from "../../receive/receive-handoff-action-scan.js";
import { receiveDestinationReferenceContext } from "../../receive/receive-destination-action-scan.js";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userId = id(1),
  operationId = id(2),
  segmentId = id(3),
  reservationId = id(4);
const event = {
  networkId: "evm:8453",
  asset: {
    networkId: "evm:8453",
    assetId: `0x${"11".repeat(20)}`,
    decimals: 6,
  },
  sourceAddress: `0x${"22".repeat(20)}`,
  destinationAddress: `0x${"33".repeat(20)}`,
  rawAmount: "1000000",
  transactionHash: `0x${"aa".repeat(32)}`,
  eventIndex: "0",
  ledgerHeight: "100",
  blockHash: `0x${"bb".repeat(32)}`,
  observedAt: new Date(0),
};
const transactionReferenceCodec = {
  keyVersion: 1,
  fingerprint: () => "f".repeat(64),
};
const referenceCodec = { fingerprint: () => "e".repeat(64) };
const facts = { userId, operationId, revision: "5" };
const base = {
  version: 1,
  kind: "complete",
  facts,
  eventFingerprint: receiveRoleEventFingerprint(event),
  cursor: null,
};
const h = {
  ...base,
  role: "handoff",
  codecContext: receiveHandoffReferenceContext(event, transactionReferenceCodec)
    .codecContext,
  referenceRetryRequired: false,
  classification: { kind: "external", reason: null },
};
const d = {
  ...base,
  role: "destination",
  segmentId,
  codecContext: receiveDestinationReferenceContext(event, referenceCodec)
    .codecContext,
  referenceRetryRequired: false,
  sourceMayBeMoving: false,
  match: "unrelated",
};
const r = {
  kind: "complete",
  version: 2,
  identity: { userId, operationId, segmentId, reservationId },
  facts,
  exposure: { kind: "no_live_attempt" },
  accounting: { kind: "none" },
  refundSet: { kind: "unchecked" },
  observationVersion: 1,
  observations: { kind: "empty" },
};
const row: ReceiveRoleCandidate = {
  reservation_id: reservationId,
  operation_id: operationId,
  segment_id: segmentId,
  envelope_kind: "candidate",
  handoff_possible: true,
  destination_possible: true,
  handoff_progress: h,
  destination_progress: d,
  action_result: r,
};
const miss: ReceiveRefundRoleEvidence = {
  kind: "recorded",
  eventFingerprint: receiveRoleEventFingerprint(event),
  classification: { kind: "unmatched" },
  dependencies: [],
};
const evaluate = (
  candidates:
    | Iterable<ReceiveRoleCandidate>
    | AsyncIterable<ReceiveRoleCandidate>,
  refundEvidence: ReceiveRefundRoleEvidence = miss,
) =>
  arbitrateReceiveRoleCandidates({
    userId,
    event,
    enumerationComplete: true,
    candidates,
    refundEvidence,
    referenceCodec,
    transactionReferenceCodec,
  });

test("joint summary retains negative facts, deduplicates operations and streams pages without a new durable fold", async () => {
  async function* pages() {
    for (let i = 0; i < 1000; i++) yield row;
  }
  assert.deepEqual(await evaluate(pages()), {
    kind: "ready_for_fence",
    classification: { kind: "external" },
    dependencies: [facts],
  });
  assert.deepEqual(
    await arbitrateReceiveRoleCandidates({
      userId,
      event,
      enumerationComplete: false,
      candidates: [],
      refundEvidence: miss,
    }),
    { kind: "incomplete", reason: "source_enumeration_pending" },
  );
});

test("reservationless destination witnesses coexist with source rows without fabricating refund provenance", async () => {
  const legacy: ReceiveRoleCandidate = {
    ...row,
    reservation_id: null,
    envelope_kind: "unrelated",
    handoff_possible: false,
    handoff_progress: null,
    action_result: null,
  };
  for (const candidates of [[legacy], [row, legacy], [legacy, row]])
    assert.deepEqual(await evaluate(candidates), {
      kind: "ready_for_fence",
      classification: { kind: "external" },
      dependencies: [facts],
    });
  assert.deepEqual(
    await evaluate([{ ...legacy, envelope_kind: "candidate" }]),
    {
      kind: "incomplete",
      reason: "candidate_identity_invalid",
    },
  );
  assert.deepEqual(
    await evaluate([
      row,
      {
        ...legacy,
        destination_progress: { ...d, facts: { ...facts, revision: "6" } },
      },
    ]),
    { kind: "incomplete", reason: "mixed_facts_revision" },
  );
});

test("exact fallback is loaded only after complete candidates, retaining their negative dependencies", async () => {
  let reads = 0;
  const loadExactRoleEvidence = async (
    destinations: ReadonlyMap<string, unknown>,
  ) => {
    reads++;
    assert.equal(destinations.size, 1);
    assert.deepEqual(destinations.get(`${operationId}:${segmentId}`), d);
    return {
      eventFingerprint: receiveRoleEventFingerprint(event),
      handoffCodecContext: h.codecContext,
      destinationCodecContext: d.codecContext,
      pendingDestinations: [],
      handoff: { kind: "external" as const, reason: null },
      destination: { kind: "external" as const },
      dependencies: [facts],
    };
  };
  const common = {
    userId,
    event,
    enumerationComplete: true,
    refundEvidence: miss,
    referenceCodec,
    transactionReferenceCodec,
    loadExactRoleEvidence,
  };
  assert.equal(
    (
      await arbitrateReceiveRoleCandidates({
        ...common,
        candidates: [{ ...row, handoff_progress: null }],
      })
    ).kind,
    "incomplete",
  );
  assert.equal(reads, 0);
  const result = await arbitrateReceiveRoleCandidates({
    ...common,
    candidates: [row, row],
  });
  assert.equal(result.kind, "ready_for_fence");
  assert.equal(reads, 1);
  if (result.kind === "ready_for_fence")
    assert.deepEqual(result.dependencies, [facts]);
  await assert.rejects(
    arbitrateReceiveRoleCandidates({
      ...common,
      candidates: [row],
      loadExactRoleEvidence: async () => {
        throw Error("exact lookup unavailable");
      },
    }),
    /exact lookup unavailable/,
  );
});

test("exact destination does not wait for its own credit, but retains other legs and positive role conflicts", async () => {
  const exact = {
    ...row,
    destination_progress: { ...d, match: "exact" },
    action_result: null,
  };
  const expected = {
    kind: "ready_for_fence",
    classification: {
      kind: "internal_destination",
      match: {
        kind: "internal",
        operationId,
        segmentId,
        transactionReferenceFingerprint: referenceCodec.fingerprint(),
      },
    },
    dependencies: [facts],
  };
  assert.deepEqual(await evaluate([exact]), expected);
  assert.deepEqual(
    await evaluate([
      {
        ...exact,
        action_result: { ...r, observations: { kind: "unchecked" } },
      },
    ]),
    expected,
  );
  const otherLeg = {
    ...row,
    reservation_id: id(9),
    segment_id: id(10),
    destination_possible: false,
    action_result: null,
  };
  for (const candidates of [
    [exact, otherLeg],
    [otherLeg, exact],
  ]) {
    assert.deepEqual(await evaluate(candidates), {
      kind: "incomplete",
      reason: "candidate_facts_pending",
    });
  }
  const contender = {
    ...otherLeg,
    action_result: {
      ...r,
      identity: { ...r.identity, segmentId: id(10), reservationId: id(9) },
      observations: { kind: "unchecked" },
    },
  };
  const conflict = {
    kind: "ready_for_fence",
    classification: {
      kind: "recovery_required",
      reason: "internal_event_classification_conflict",
    },
    dependencies: [facts],
  };
  assert.deepEqual(await evaluate([exact, contender]), conflict);
  assert.deepEqual(await evaluate([contender, exact]), conflict);
  for (const kind of ["recorded", "verified_proposal"] as const) {
    assert.deepEqual(
      await evaluate([exact], {
        kind,
        eventFingerprint: receiveRoleEventFingerprint(event),
        classification: { kind: "internal", operationId, segmentId },
        dependencies: [facts],
      }),
      conflict,
    );
  }
  assert.deepEqual(
    await evaluate([
      {
        ...exact,
        handoff_progress: {
          ...h,
          classification: {
            kind: "internal",
            reason: null,
            reference: "exact",
            operationId,
            attemptId: id(11),
          },
        },
      },
    ]),
    conflict,
  );
  assert.deepEqual(
    await evaluate([
      { ...exact, destination_progress: { ...d, match: "possible" } },
    ]),
    {
      kind: "incomplete",
      reason: "candidate_facts_pending",
    },
  );
});

test("partial recorded and proposed refunds use exact positive facts before requiring own settlement, never competitors", async () => {
  for (const kind of ["recorded", "verified_proposal"] as const) {
    const proof: ReceiveRefundRoleEvidence = {
      kind,
      eventFingerprint: receiveRoleEventFingerprint(event),
      classification: { kind: "internal", operationId, segmentId },
      dependencies: [facts],
    };
    const partial = { ...row, action_result: null };
    assert.deepEqual(await evaluate([partial], proof), {
      kind: "ready_for_fence",
      classification: { kind: "internal_refund", match: proof.classification },
      dependencies: [facts],
    });
    assert.equal(
      (await evaluate([partial], { ...proof, dependencies: [] })).kind,
      "incomplete",
    );
    assert.equal(
      (
        await evaluate(
          [{ ...partial, segment_id: id(10), destination_possible: false }],
          proof,
        )
      ).kind,
      "incomplete",
    );
    assert.equal(
      (await evaluate([{ ...partial, handoff_progress: null }], proof)).kind,
      "incomplete",
    );
    const contender = {
      ...row,
      segment_id: id(10),
      destination_possible: false,
      action_result: {
        ...r,
        identity: { ...r.identity, segmentId: id(10) },
        observations: { kind: "unchecked" },
      },
    };
    const result = await evaluate([partial, contender], proof);
    assert.equal(result.kind, "ready_for_fence");
    if (result.kind === "ready_for_fence")
      assert.deepEqual(result.classification, {
        kind: "recovery_required",
        reason: "internal_event_classification_conflict",
      });
  }
});

test("unsettled debit, old observation version and invalid membership never become external; normal repaired summary recovers", async () => {
  for (const patch of [
    { observations: { kind: "unchecked" } },
    { observations: { kind: "pending", reason: "unexpected_observation" } },
  ]) {
    const result = await evaluate([
      { ...row, action_result: { ...r, ...patch } },
    ]);
    assert.equal(result.kind, "ready_for_fence");
    if (result.kind === "ready_for_fence")
      assert.deepEqual(result.classification, {
        kind: "recovery_required",
        reason: "exact_refund_correlation_pending",
      });
  }
  for (const patch of [
    { observationVersion: 0 },
    { observationVersion: undefined },
    { version: 1 },
    { identity: { ...r.identity, reservationId: id(99) } },
  ])
    assert.equal(
      (await evaluate([{ ...row, action_result: { ...r, ...patch } }])).kind,
      "incomplete",
    );
  const invalid = await evaluate([{ ...row, envelope_kind: "invalid" }]);
  assert.equal(invalid.kind, "ready_for_fence");
  if (invalid.kind === "ready_for_fence")
    assert.equal(invalid.classification.kind, "recovery_required");
  assert.equal((await evaluate([row])).kind, "ready_for_fence");
});

test("only complete exact refund or native delivery settlement excludes a single physical debit", async () => {
  const debit = {
    observationId: id(20),
    networkId: event.networkId,
    transactionHash: event.transactionHash,
    eventIndex: "2",
  };
  const spent = {
    ...r,
    exposure: { kind: "possible", stepIds: [id(21)] },
    accounting: { kind: "single_debit", debit },
  };
  for (const patch of [
    {
      refundSet: {
        kind: "complete_refund_set",
        anchorObservationId: id(22),
        fingerprint: "a".repeat(64),
        receiptCount: 2,
      },
      observations: { kind: "refunded" },
    },
    {
      refundSet: { kind: "pending", reason: "no_current_receipts" },
      observations: { kind: "delivered" },
    },
  ]) {
    assert.deepEqual(
      await evaluate([{ ...row, action_result: { ...spent, ...patch } }]),
      {
        kind: "ready_for_fence",
        classification: { kind: "external" },
        dependencies: [facts],
      },
    );
    assert.equal(
      (
        await evaluate([
          {
            ...row,
            action_result: {
              ...spent,
              ...patch,
              refundSet: { kind: "unchecked" },
            },
          },
        ])
      ).kind,
      "incomplete",
    );
  }
  const unresolved = await evaluate([
    {
      ...row,
      action_result: { ...spent, observations: { kind: "unchecked" } },
    },
  ]);
  assert.equal(unresolved.kind, "ready_for_fence");
  if (unresolved.kind === "ready_for_fence")
    assert.equal(unresolved.classification.kind, "recovery_required");
});

test("destination exact wins possible, duplicate aliases do not conflict and distinct exact legs do", async () => {
  const exact = {
    ...row,
    envelope_kind: "unrelated" as const,
    handoff_possible: false,
    destination_progress: { ...d, match: "exact" },
  };
  const possible = {
    ...exact,
    segment_id: id(30),
    destination_progress: {
      ...d,
      segmentId: id(30),
      match: "possible",
      sourceMayBeMoving: true,
    },
  };
  for (const rows of [
    [exact, exact, possible],
    [possible, exact, exact],
  ]) {
    const result = await evaluate(rows);
    assert.equal(result.kind, "ready_for_fence");
    if (result.kind === "ready_for_fence")
      assert.deepEqual(result.classification, {
        kind: "internal_destination",
        match: {
          kind: "internal",
          operationId,
          segmentId,
          transactionReferenceFingerprint: referenceCodec.fingerprint(),
        },
      });
  }
  const result = await evaluate([
    exact,
    {
      ...possible,
      destination_progress: { ...d, segmentId: id(30), match: "exact" },
    },
  ]);
  assert.equal(result.kind, "ready_for_fence");
  if (result.kind === "ready_for_fence")
    assert.deepEqual(result.classification, {
      kind: "recovery_required",
      reason: "owned_route_destination_ambiguous",
    });
});

test("exact handoff and another role conflict; retryable unresolved handoff cannot be dropped by later pages", async () => {
  const exact = {
    ...row,
    handoff_progress: {
      ...h,
      classification: {
        kind: "internal",
        reason: null,
        reference: "exact",
        operationId,
        attemptId: id(40),
      },
    },
  };
  for (const rows of [[exact, exact], [exact]]) {
    const result = await evaluate(rows);
    assert.equal(result.kind, "ready_for_fence");
    if (result.kind === "ready_for_fence")
      assert.equal(result.classification.kind, "internal_handoff");
  }
  const pending = {
    ...row,
    handoff_progress: {
      ...h,
      classification: {
        kind: "recovery_required",
        reason: "handoff_correlation_pending",
      },
    },
  };
  for (const rows of [
    [exact, pending],
    [pending, exact],
  ]) {
    const result = await evaluate(rows);
    assert.equal(result.kind, "ready_for_fence");
    if (result.kind === "ready_for_fence")
      assert.deepEqual(result.classification, {
        kind: "recovery_required",
        reason: "handoff_correlation_pending",
      });
  }
  const conflict = await evaluate([
    { ...exact, destination_progress: { ...d, match: "exact" } },
  ]);
  assert.equal(conflict.kind, "ready_for_fence");
  if (conflict.kind === "ready_for_fence")
    assert.deepEqual(conflict.classification, {
      kind: "recovery_required",
      reason: "internal_event_classification_conflict",
    });
});

test("mixed revisions, changed owner/envelope/codec and incomplete pages require ordinary retry", async () => {
  for (const patch of [
    { handoff_progress: { ...h, facts: { ...facts, revision: "6" } } },
    { handoff_progress: { ...h, facts: { ...facts, userId: id(99) } } },
    { handoff_progress: { ...h, eventFingerprint: "a".repeat(64) } },
    { handoff_progress: { ...h, codecContext: "a".repeat(64) } },
    { handoff_progress: { ...h, referenceRetryRequired: true } },
    {
      handoff_progress: {
        ...h,
        kind: "continuation",
        cursor: { stepOrdinal: 1, attemptNumber: 2 },
      },
    },
    { destination_progress: { ...d, referenceRetryRequired: true } },
    { destination_progress: { ...d, segmentId: id(99) } },
    { destination_progress: { ...d, facts: { ...facts, revision: "6" } } },
    { action_result: { ...r, facts: { ...facts, revision: "6" } } },
  ])
    assert.equal((await evaluate([{ ...row, ...patch }])).kind, "incomplete");
  assert.equal((await evaluate([row])).kind, "ready_for_fence");
  const changed = await arbitrateReceiveRoleCandidates({
    userId,
    event,
    enumerationComplete: true,
    candidates: [row],
    refundEvidence: miss,
    referenceCodec,
    transactionReferenceCodec: { ...transactionReferenceCodec, keyVersion: 2 },
  });
  assert.equal(changed.kind, "incomplete");
});

test("recorded reorg/conflict never becomes external even when source history is clear", async () => {
  for (const reason of [
    "exact_refund_receipt_conflict",
    "exact_refund_receipt_not_final",
  ] as const) {
    const result = await evaluate([row], {
      kind: "recorded",
      eventFingerprint: receiveRoleEventFingerprint(event),
      classification: { kind: "recovery_required", reason },
      dependencies: [facts],
    });
    assert.equal(result.kind, "ready_for_fence");
    if (result.kind === "ready_for_fence")
      assert.deepEqual(result.classification, {
        kind: "recovery_required",
        reason,
      });
  }
});

test("recorded or proposed proof cannot cross a re-mined block at unchanged operation revision", async () => {
  for (const kind of ["recorded", "verified_proposal"] as const) {
    const proof: ReceiveRefundRoleEvidence = {
      kind,
      eventFingerprint: receiveRoleEventFingerprint(event),
      classification: { kind: "internal", operationId, segmentId },
      dependencies: [facts],
    };
    const partial = { ...row, action_result: null };
    for (const anchor of [
      { ledgerHeight: "101" },
      { blockHash: `0x${"ef".repeat(32)}` },
    ]) {
      const moved = { ...event, ...anchor };
      assert.deepEqual(
        await arbitrateReceiveRoleCandidates({
          userId,
          event: moved,
          enumerationComplete: true,
          candidates: [partial],
          refundEvidence: proof,
          referenceCodec,
          transactionReferenceCodec,
        }),
        { kind: "incomplete", reason: "candidate_context_changed" },
      );
      const refreshed = {
        ...partial,
        handoff_progress: {
          ...h,
          eventFingerprint: receiveRoleEventFingerprint(moved),
        },
        destination_progress: {
          ...d,
          eventFingerprint: receiveRoleEventFingerprint(moved),
        },
      };
      const result = await arbitrateReceiveRoleCandidates({
        userId,
        event: moved,
        enumerationComplete: true,
        candidates: [refreshed],
        refundEvidence: {
          ...proof,
          eventFingerprint: receiveRoleEventFingerprint(moved),
        },
        referenceCodec,
        transactionReferenceCodec,
      });
      assert.equal(result.kind, "ready_for_fence");
      if (result.kind === "ready_for_fence")
        assert.equal(result.classification.kind, "internal_refund");
    }
  }
});
