import type { PoolClient } from "@hunch/infra";
import { isRecord } from "../../lib/type-guards.js";
import type { RelayReferenceCodec } from "../../funding-providers/relay/reference-codec.js";
import type { FundingTransactionReferenceCodec } from "../execution/transaction-reference-codec.js";
import {
  CANONICAL_EVENT_OWNERSHIP_LOCK_SQL,
  REFUND_RECEIVE_ANCHOR_UPDATE_SQL,
  type CanonicalEventOwnershipRow,
} from "../persistence/canonical-event-lock-sql.js";
import {
  compareFundingReceiveCanonicalEvents,
  lockFundingReceiveCanonicalEvents,
  quarantineFundingReceiveCanonicalInternalEvent,
  isFundingReceiveClassificationRetryReason,
  type FundingReceiveCanonicalEventInput,
} from "../persistence/funding-receive-session-repository.js";
import { loadCanonicalPolymarketHandoffClassifications } from "../receive/receive-handoff-classification.js";
import { classifyOwnedRouteCanonicalDestinationEvents } from "./owned-route-destination-observer.js";
import {
  FundingClassificationChangedError,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import {
  readRecordedRelayRefundRoleEvidence,
  refundCanonicalEventKey,
} from "./relay-exact-refund-classification.js";
import type { ReceiveRefundRoleEvidence } from "../receive/receive-role-arbitration.js";
import type { ReceiveEventClassification } from "../receive/receive-event-classification.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import {
  canonicalFundingPhysicalTransactionHash,
  tryLockFundingPhysicalEvent,
} from "../persistence/funding-physical-event-gate.js";
import { FUNDING_EVM_RECEIVE_CLAIM_SQL as OWNED_REFUND_OTHER_RECEIVE_SQL } from "../persistence/funding-physical-claims.js";
export { FUNDING_EVM_RECEIVE_CLAIM_SQL as OWNED_REFUND_OTHER_RECEIVE_SQL } from "../persistence/funding-physical-claims.js";

type Db = Pick<PoolClient, "query">;
type Event = FundingReceiveCanonicalEventInput;
export const OWNED_REFUND_OBSERVER_ID = "relay_owned_refund_observation_v1";
const suppression = "internal_exact_refund_suppressed";
// Existing recorded-refund anchor exception in the DB guard. Other pending
// roles retain their own queue but cannot authorize an A -> B anchor repair.
const recordedRefundRemineReasons = [
  suppression,
  "exact_refund_receipt_not_final",
  "exact_refund_receipt_conflict",
  "internal_event_classification_conflict",
];
const key = (event: Event) =>
  [
    event.networkId,
    canonicalFundingPhysicalTransactionHash(event) ?? event.transactionHash,
    event.eventIndex,
  ].join(":");

/** Only a recorded owned refund can supply the old footprint. Do not invent
 * its sender, amount or token from the current request during reorg repair. */
export function recordedOwnedRefundEvent(
  snapshot: string | null,
  now: Date,
): Event | null {
  if (!snapshot) return null;
  const event = recordedRefundRoleEvent(snapshot, now);
  if (
    !event ||
    JSON.parse(snapshot).metadata.observerId !== OWNED_REFUND_OBSERVER_ID
  )
    return null;
  return event;
}

/** Both existing refund protocols share the physical envelope, not their
 * business verifier. A recorded snapshot alone never authorizes restoration. */
export function recordedRefundRoleEvent(
  snapshot: string | null,
  now: Date,
): Event | null {
  if (!snapshot) return null;
  const row: unknown = JSON.parse(snapshot);
  if (
    !isRecord(row) ||
    !isRecord(row.metadata) ||
    ![OWNED_REFUND_OBSERVER_ID, "relay_exact_refund_observation_v1"].includes(
      String(row.metadata.observerId),
    ) ||
    row.kind !== "refund_credit" ||
    !["finalized", "reorged"].includes(String(row.finality_status)) ||
    typeof row.network_id !== "string" ||
    !row.network_id.startsWith("evm:") ||
    typeof row.asset_id !== "string" ||
    typeof row.asset_decimals !== "number" ||
    !Number.isInteger(row.asset_decimals) ||
    typeof row.from_address !== "string" ||
    typeof row.to_address !== "string" ||
    typeof row.raw_amount !== "string" ||
    !/^\d+$/u.test(row.raw_amount) ||
    typeof row.tx_hash !== "string" ||
    !/^0x[\da-f]{64}$/iu.test(row.tx_hash) ||
    typeof row.event_index !== "string" ||
    !/^\d+$/u.test(row.event_index) ||
    typeof row.ledger_height !== "string" ||
    !/^\d+$/u.test(row.ledger_height) ||
    typeof row.block_hash !== "string" ||
    !/^0x[\da-f]{64}$/iu.test(row.block_hash)
  )
    return null;
  return {
    networkId: row.network_id,
    asset: {
      networkId: row.network_id,
      assetId: row.asset_id,
      decimals: row.asset_decimals,
    },
    sourceAddress: row.from_address,
    destinationAddress: row.to_address,
    rawAmount: row.raw_amount,
    transactionHash: row.tx_hash.toLowerCase(),
    eventIndex: row.event_index,
    ledgerHeight: row.ledger_height,
    blockHash: row.block_hash.toLowerCase(),
    observedAt: now,
    now,
  };
}

function sameValue(row: CanonicalEventOwnershipRow, event: Event): boolean {
  return (
    row.asset_id.toLowerCase() === event.asset.assetId.toLowerCase() &&
    row.asset_decimals === event.asset.decimals &&
    row.source_address?.toLowerCase() === event.sourceAddress?.toLowerCase() &&
    row.destination_address.toLowerCase() ===
      event.destinationAddress.toLowerCase() &&
    row.raw_amount === event.rawAmount
  );
}
function sameAnchor(row: CanonicalEventOwnershipRow, event: Event): boolean {
  return (
    row.ledger_height === event.ledgerHeight &&
    row.block_hash.toLowerCase() === event.blockHash?.toLowerCase()
  );
}

export type OwnedRefundPrelock = Readonly<{
  previous: Event | null;
  incoming: Event | null;
  rows: ReadonlyMap<string, CanonicalEventOwnershipRow>;
}>;

/** Entire old/new footprint before O, including invalidation with no match.
 * Existing rows are locked without overwriting their identity or anchor. */
export async function prelockOwnedRefundEvents(
  db: Db,
  previous: Event | null,
  incoming: Event | null,
): Promise<OwnedRefundPrelock> {
  const normalize = (event: Event | null) =>
    event
      ? {
          ...event,
          transactionHash:
            canonicalFundingPhysicalTransactionHash(event) ??
            event.transactionHash,
        }
      : null;
  previous = normalize(previous);
  incoming = normalize(incoming);
  const events = new Map<string, Event>();
  if (incoming) events.set(key(incoming), incoming);
  if (previous) events.set(key(previous), previous);
  const rows = new Map<string, CanonicalEventOwnershipRow>();
  for (const event of [...events.values()].sort(
    compareFundingReceiveCanonicalEvents,
  )) {
    await tryLockFundingPhysicalEvent(db, event);
    const read = () =>
      db.query<CanonicalEventOwnershipRow>(CANONICAL_EVENT_OWNERSHIP_LOCK_SQL, [
        event.networkId,
        event.transactionHash,
        event.eventIndex,
      ]);
    let row = (await read()).rows[0];
    if (!row) {
      await lockFundingReceiveCanonicalEvents(db, [event]);
      row = (await read()).rows[0];
    }
    if (!row) throw new Error("owned refund physical prelock disappeared");
    rows.set(key(event), row);
  }
  return { previous, incoming, rows };
}

/** Preserve already recorded ownership on invalidation as well as replay.
 * A conflicting historical allocation remains untouched, but cannot prevent
 * truthful invalidation of the refund observation itself. */
export async function suppressRecordedOwnedRefund(
  db: Db,
  locked: OwnedRefundPrelock,
): Promise<boolean> {
  const event = locked.previous;
  const row = event ? locked.rows.get(key(event)) : null;
  if (!event || !row || !sameValue(row, event)) return false;
  // recovery_required already prevents an unclassified external allocation.
  // Do not orphan its existing receive retry/lease by changing the reason to a
  // non-claimable suppression before that worker finishes its own evidence.
  if (
    row.allocation_status === "recovery_required" &&
    isFundingReceiveClassificationRetryReason(row.allocation_error_code)
  )
    return true;
  // Protection is not positive canonicality evidence. A legacy recorded
  // refund can predate E, whose anchor may already reflect a later scan. Keep
  // that exact stored anchor; only prevent the known physical transfer from
  // being published a second time as external cash.
  return quarantineFundingReceiveCanonicalInternalEvent(db, {
    ...event,
    ledgerHeight: row.ledger_height,
    blockHash: row.block_hash,
    reason: suppression,
  });
}

export const OWNED_REFUND_OTHER_CREDIT_SQL = `select id from funding_observations
 where network_id=$1 and tx_hash=$2 and event_index=$3
   and kind in ('destination_credit','refund_credit')
   and not (id is not distinct from $4::uuid and operation_id=$5::uuid
     and kind='refund_credit' and coalesce(metadata->>'observerId','')=$6)
 limit 1`;

export const OWNED_REFUND_OTHER_EVM_CREDIT_SQL = `select id from funding_observations
 where network_id=$1 and tx_hash is not null
   and md5(lower(tx_hash))=md5($2::text) and lower(tx_hash)=$2::text and event_index=$3
   and kind in ('destination_credit','refund_credit')
   and not (id is not distinct from $4::uuid and operation_id=$5::uuid
     and kind='refund_credit' and coalesce(metadata->>'observerId','')=$6)
 limit 1`;

const protectedRefundProof = Symbol("protected-recorded-refund-role-proof");
/** Internal derived proof for one already protected recorded physical refund.
 * Not a lease, client option, ignore-anchor flag or financial publication right.
 * Only the validating factory below can construct it. The common role adapter
 * still validates current owner/header and publication still needs O/U/F/CAS.
 */
export type ProtectedRecordedRefundRoleProof = Readonly<{
  [protectedRefundProof]: true;
  eventId: string;
  eventFingerprint: string;
  recordedObservationId: string;
  observerId: string;
  facts: FundingClassificationRevision;
  refundEvidence: ReceiveRefundRoleEvidence;
}>;

export const PROTECTED_RECORDED_REFUND_PROOF_SQL = `select event_row.id as event_id,
  operation_row.user_id,coalesce(revision_row.revision,0)::text as revision
 from funding_observations receipt_row
 cross join lateral(select id,user_id from funding_operations
   where id=receipt_row.operation_id offset 0) operation_row
 left join funding_classification_revisions revision_row on revision_row.operation_id=operation_row.id
 join funding_receive_canonical_events event_row on event_row.network_id=$1
   and event_row.tx_hash=$2 and event_row.event_index=$3
 where receipt_row.id=$4::uuid and receipt_row.operation_id=$5::uuid
   and receipt_row.segment_id=$6::uuid and to_jsonb(receipt_row)=$7::jsonb`;

export async function readProtectedRecordedRefundRoleProof(
  db: Db,
  input: {
    locked: OwnedRefundPrelock;
    receiptSnapshot: string;
    operationId: string;
    segmentId: string;
    facts: FundingClassificationRevision;
  },
): Promise<ProtectedRecordedRefundRoleProof | null> {
  const { previous, incoming } = input.locked;
  if (
    !previous ||
    !incoming ||
    key(previous) !== key(incoming) ||
    canonicalFundingPhysicalTransactionHash(incoming) === null
  )
    return null;
  const expected: unknown = JSON.parse(input.receiptSnapshot);
  if (
    !isRecord(expected) ||
    !isRecord(expected.metadata) ||
    expected.operation_id !== input.operationId ||
    expected.segment_id !== input.segmentId ||
    typeof expected.id !== "string" ||
    !(
      expected.canonical === false &&
      expected.finality_status === "reorged" &&
      typeof expected.reorged_at === "string"
    )
  )
    return null;
  const recorded = recordedRefundRoleEvent(input.receiptSnapshot, incoming.now);
  const row = input.locked.rows.get(key(incoming));
  if (
    !recorded ||
    receiveRoleEventFingerprint(recorded) !==
      receiveRoleEventFingerprint(previous) ||
    !row ||
    !sameValue(row, previous) ||
    !sameValue(row, incoming) ||
    !(sameAnchor(row, previous) || sameAnchor(row, incoming)) ||
    row.allocation_status !== "recovery_required" ||
    !(
      row.allocation_error_code === suppression ||
      isFundingReceiveClassificationRetryReason(row.allocation_error_code)
    ) ||
    row.allocated_receipt_id !== null ||
    row.allocated_receive_session_id !== null
  )
    return null;
  const current = (
    await db.query<{ event_id: string; user_id: string; revision: string }>(
      PROTECTED_RECORDED_REFUND_PROOF_SQL,
      [
        incoming.networkId,
        incoming.transactionHash,
        incoming.eventIndex,
        expected.id,
        input.operationId,
        input.segmentId,
        input.receiptSnapshot,
      ],
    )
  ).rows[0];
  if (
    !current ||
    current.user_id !== input.facts.userId ||
    current.revision !== input.facts.revision
  )
    throw new FundingClassificationChangedError();
  // Even a previously suppressed E cannot erase another recorded claim. These
  // reads are after full E and before O; the caller never locks receipt rows here.
  if (
    (
      await db.query(OWNED_REFUND_OTHER_EVM_CREDIT_SQL, [
        incoming.networkId,
        incoming.transactionHash,
        incoming.eventIndex,
        expected.id,
        input.operationId,
        expected.metadata.observerId,
      ])
    ).rowCount
  )
    return null;
  if (
    (
      await db.query(OWNED_REFUND_OTHER_RECEIVE_SQL, [
        incoming.networkId,
        incoming.transactionHash,
        incoming.eventIndex,
      ])
    ).rowCount
  )
    return null;
  const evidence = (
    await readRecordedRelayRefundRoleEvidence(db, {
      userId: input.facts.userId,
      events: [incoming],
    })
  ).get(refundCanonicalEventKey(incoming));
  if (
    !evidence ||
    evidence.eventFingerprint !== receiveRoleEventFingerprint(incoming) ||
    evidence.dependencies.length !== 1 ||
    evidence.dependencies.some(
      (facts) =>
        facts.operationId !== input.facts.operationId ||
        facts.userId !== input.facts.userId ||
        facts.revision !== input.facts.revision,
    ) ||
    (evidence.classification.kind === "internal" &&
      (evidence.classification.operationId !== input.operationId ||
        evidence.classification.segmentId !== input.segmentId))
  )
    return null;
  // A receive worker may have re-observed A before its reorg and left a
  // correlation-pending retry. It cannot use UNOWNED anchor repair for this
  // recorded refund. Only after validating the exact reorged receipt, owner,
  // economics and all competing claims may we move its existing quarantine to
  // the DB's recorded-refund remine state. Preserve retry time/token/binding.
  if (!recordedRefundRemineReasons.includes(row.allocation_error_code ?? "")) {
    if (
      !(await quarantineFundingReceiveCanonicalInternalEvent(db, {
        ...previous,
        ledgerHeight: row.ledger_height,
        blockHash: row.block_hash,
        reason: "exact_refund_receipt_not_final",
      }))
    )
      return null;
  }
  return Object.freeze({
    [protectedRefundProof]: true as const,
    eventId: current.event_id,
    eventFingerprint: receiveRoleEventFingerprint(incoming),
    recordedObservationId: expected.id,
    observerId: String(expected.metadata.observerId),
    facts: input.facts,
    refundEvidence: {
      kind: "verified_proposal" as const,
      eventFingerprint: receiveRoleEventFingerprint(incoming),
      classification: {
        kind: "internal" as const,
        operationId: input.operationId,
        segmentId: input.segmentId,
      },
      dependencies: [input.facts],
    },
  });
}

export function protectedRecordedRefundRoleProofMatches(
  proof: ProtectedRecordedRefundRoleProof,
  input: { operationId: string; userId: string; event: Event },
): boolean {
  return (
    proof[protectedRefundProof] === true &&
    proof.facts.operationId === input.operationId &&
    proof.facts.userId === input.userId &&
    proof.eventFingerprint === receiveRoleEventFingerprint(input.event)
  );
}

/** Positive publication only. Invalidation must NOT depend on this result. */
export async function claimOwnedRefundEvent(
  db: Db,
  input: {
    locked: OwnedRefundPrelock;
    userId: string;
    operationId: string;
    previousObservationId: string | null;
    previousReorged: boolean;
    previousSuppressed: boolean;
    referenceCodec: Pick<RelayReferenceCodec, "fingerprint">;
    transactionReferenceCodec?: Pick<
      FundingTransactionReferenceCodec,
      "fingerprint" | "keyVersion" | "decrypt"
    >;
  },
): Promise<boolean> {
  const event = input.locked.incoming;
  if (!event || event.sourceAddress === null) return false;
  const handoffs = await loadCanonicalPolymarketHandoffClassifications(db, {
    userId: input.userId,
    now: event.now,
    transactionReferenceCodec: input.transactionReferenceCodec,
    events: [
      {
        ...event,
        sourceAddress: event.sourceAddress,
        variant: { networkId: event.networkId, asset: event.asset },
      },
    ],
  });
  const destinations = await classifyOwnedRouteCanonicalDestinationEvents(db, {
    userId: input.userId,
    referenceCodec: input.referenceCodec,
    events: [event],
  });
  if (
    handoffs.get(key(event))?.kind !== "external" ||
    destinations.get(key(event))?.kind !== "external"
  )
    return false;
  return claimOwnedRefundPhysicalEvent(db, input);
}

/** Common physical CAS/effects after joint role publication. No role/history
 * readers, no new E/O locks and no provider IO under the caller's O union. */
export async function claimArbitratedOwnedRefundEvent(
  db: Db,
  input: Omit<
    Parameters<typeof claimOwnedRefundEvent>[1],
    "referenceCodec" | "transactionReferenceCodec"
  > & {
    segmentId: string;
    classification: Extract<
      ReceiveEventClassification,
      { kind: "internal_refund" }
    >;
  },
): Promise<boolean> {
  if (
    input.classification.match.operationId !== input.operationId ||
    input.classification.match.segmentId !== input.segmentId
  )
    return false;
  return claimOwnedRefundPhysicalEvent(db, input);
}

/** Restoration of an existing refund, not a new verifier or an ignore-anchor
 * option. The transaction-scoped proof is constructed under E; the caller must
 * still hold the complete O/U union, CAS the receipt and commit original F. */
export async function claimArbitratedRecordedRefundEvent(
  db: Db,
  input: {
    locked: OwnedRefundPrelock;
    proof: ProtectedRecordedRefundRoleProof;
    userId: string;
    operationId: string;
    segmentId: string;
    classification: Extract<
      ReceiveEventClassification,
      { kind: "internal_refund" }
    >;
  },
): Promise<boolean> {
  const event = input.locked.incoming;
  if (
    !event ||
    !protectedRecordedRefundRoleProofMatches(input.proof, {
      operationId: input.operationId,
      userId: input.userId,
      event,
    }) ||
    input.proof.refundEvidence.classification.kind !== "internal" ||
    input.proof.refundEvidence.classification.operationId !==
      input.operationId ||
    input.proof.refundEvidence.classification.segmentId !== input.segmentId ||
    input.classification.match.operationId !== input.operationId ||
    input.classification.match.segmentId !== input.segmentId
  )
    return false;
  return claimOwnedRefundPhysicalEvent(
    db,
    {
      ...input,
      previousObservationId: input.proof.recordedObservationId,
      previousReorged: true,
      previousSuppressed: true,
    },
    input.proof.observerId,
  );
}

async function claimOwnedRefundPhysicalEvent(
  db: Db,
  input: Omit<
    Parameters<typeof claimOwnedRefundEvent>[1],
    "referenceCodec" | "transactionReferenceCodec"
  >,
  observerId = OWNED_REFUND_OBSERVER_ID,
): Promise<boolean> {
  const event = input.locked.incoming;
  const row = event ? input.locked.rows.get(key(event)) : null;
  if (!event || !row || !sameValue(row, event) || event.sourceAddress === null)
    return false;
  const previous = input.locked.previous;
  // Legacy observations can predate E. Even if another observer has already
  // stored the new anchor, re-mining the same physical key cannot change the
  // economic transfer recorded by the original refund.
  if (previous && key(previous) === key(event) && !sameValue(row, previous))
    return false;
  if (
    canonicalFundingPhysicalTransactionHash(event) !== null &&
    (
      await db.query(OWNED_REFUND_OTHER_RECEIVE_SQL, [
        event.networkId,
        event.transactionHash,
        event.eventIndex,
      ])
    ).rowCount
  )
    return false;
  if (
    (
      await db.query(
        canonicalFundingPhysicalTransactionHash(event) !== null
          ? OWNED_REFUND_OTHER_EVM_CREDIT_SQL
          : OWNED_REFUND_OTHER_CREDIT_SQL,
        [
          event.networkId,
          event.transactionHash,
          event.eventIndex,
          input.previousObservationId,
          input.operationId,
          observerId,
        ],
      )
    ).rowCount
  )
    return false;
  if (!sameAnchor(row, event)) {
    if (
      !previous ||
      key(previous) !== key(event) ||
      !sameValue(row, previous) ||
      !sameAnchor(row, previous) ||
      !input.previousReorged ||
      !input.previousSuppressed
    )
      return false;
    const repaired = await db.query(REFUND_RECEIVE_ANCHOR_UPDATE_SQL, [
      event.networkId,
      event.transactionHash,
      event.eventIndex,
      event.ledgerHeight,
      event.blockHash,
    ]);
    if (repaired.rowCount !== 1) return false;
  }
  // A recorded refund can recover while its independent receive retry is
  // leased. Keep that retry reason/token; it will see the canonical receipt,
  // suppress the internal transfer and acknowledge its own lease atomically.
  if (
    previous &&
    input.previousObservationId &&
    input.previousReorged &&
    input.previousSuppressed &&
    row.allocation_status === "recovery_required" &&
    row.allocation_error_code !== suppression &&
    isFundingReceiveClassificationRetryReason(row.allocation_error_code)
  )
    return true;
  return quarantineFundingReceiveCanonicalInternalEvent(db, {
    ...event,
    reason: suppression,
  });
}
