import type { PoolClient } from "@hunch/infra";
import type { ReceiveEventClassification } from "../receive/receive-event-classification.js";
import { compareFundingReceiveCanonicalEvents } from "../persistence/funding-receive-session-repository.js";
import {
  lockFundingClassificationOperations,
  type FundingClassificationRevision,
} from "../persistence/funding-classification-revisions.js";
import {
  claimArbitratedRecordedRefundEvent,
  prelockOwnedRefundEvents,
  recordedRefundRoleEvent,
  suppressRecordedOwnedRefund,
  type OwnedRefundPrelock,
  type ProtectedRecordedRefundRoleProof,
} from "./relay-owned-refund-ownership.js";
import {
  readRefundCanonicalTarget,
  readRefundWatchReceipt,
  refundWatchBindingFingerprint,
  refundWatchFacts,
  type RefundWatchRow,
} from "./relay-refund-watch-context.js";
import type { RefundCanonicalProof } from "./relay-refund-canonical-proof.js";

type Db = Pick<PoolClient, "query">;
export type RefundWatchResult = Readonly<{
  row: RefundWatchRow;
  proof: RefundCanonicalProof;
}>;

const recanonicalize = async (
  db: Db,
  receiptId: string,
  proof: Extract<RefundCanonicalProof, { kind: "canonical" }>,
  now: Date,
) =>
  db.query(
    `update funding_observations set canonical=true, finality_status='finalized',
    ledger_height=$2, block_hash=$3, finalized_at=$4, reorged_at=null,
    metadata=metadata || jsonb_build_object('exactRefundCanonicalityHistory',
      coalesce(metadata->'exactRefundCanonicalityHistory','[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'previousBlock',ledger_height,'previousBlockHash',block_hash,'reorgedAt',reorged_at,'recanonicalizedAt',$4::timestamptz)))
    where id=$1::uuid and finality_status='reorged' and not canonical`,
    [receiptId, proof.ledgerHeight, proof.blockHash, now],
  );

/** Protection only for EVM. The ENTIRE page's old physical footprint precedes
 * O, including rows which eventually fail CAS. A conflicting allocated E must
 * not prevent truthful invalidation of the recorded refund itself. Native
 * ledger verification retains its existing exact protocol. Caller owns F. */
type ProtectionInput = {
  operationId: string;
  rows: readonly RefundWatchResult[];
  now: Date;
  operationFacts?: FundingClassificationRevision;
};
export async function protectRefundCanonicalProofs(
  db: Db,
  input: ProtectionInput,
) {
  const events = input.rows
    .flatMap(({ row }) => {
      if (!readRefundCanonicalTarget(row)) return [];
      const event = recordedRefundRoleEvent(row.receipt_snapshot, input.now);
      return event ? [event] : [];
    })
    .sort(compareFundingReceiveCanonicalEvents);
  const locked = new Map<string, OwnedRefundPrelock>();
  for (const event of events) {
    const key = `${event.networkId}:${event.transactionHash}:${event.eventIndex}`;
    if (!locked.has(key))
      locked.set(key, await prelockOwnedRefundEvents(db, event, null));
  }
  await lockFundingClassificationOperations(db, [
    ...(input.operationFacts ? [input.operationFacts] : []),
    ...input.rows.map(({ row }) => refundWatchFacts(row, input.operationId)),
  ]);
  let changed = 0;
  let stale = false;
  const restorations: {
    row: RefundWatchRow;
    canonical: Extract<RefundCanonicalProof, { kind: "canonical" }>;
  }[] = [];
  for (const { row, proof } of input.rows) {
    const expected = JSON.parse(row.receipt_snapshot);
    const current = await readRefundWatchReceipt(db, {
      receiptId: expected.id,
      operationId: input.operationId,
      snapshot: row.receipt_snapshot,
      lock: true,
    });
    const target = readRefundCanonicalTarget(row);
    if (
      !current ||
      !target ||
      refundWatchBindingFingerprint(current) !==
        refundWatchBindingFingerprint(row)
    ) {
      stale = true;
      continue;
    }
    const oldEvent = recordedRefundRoleEvent(row.receipt_snapshot, input.now);
    if (oldEvent) {
      const physical = locked.get(
        `${oldEvent.networkId}:${oldEvent.transactionHash}:${oldEvent.eventIndex}`,
      );
      if (!physical) throw Error("refund watch protection footprint missing");
      await suppressRecordedOwnedRefund(db, physical);
    }
    // Known ownership protection needs no successful provider refresh. A
    // pending RPC does not retract the receipt, nor turn it into external cash.
    if (proof.kind === "pending") continue;
    const sameAnchor =
      proof.kind === "canonical" &&
      proof.ledgerHeight === target.ledgerHeight &&
      proof.blockHash?.toLowerCase() === target.blockHash?.toLowerCase();
    if (
      expected.canonical === true &&
      expected.finality_status === "finalized" &&
      sameAnchor
    )
      continue;
    if (
      expected.canonical === true &&
      expected.finality_status === "finalized"
    ) {
      await db.query(
        `update funding_observations set canonical=false,finality_status='reorged',reorged_at=$2
        where id=$1::uuid`,
        [expected.id, input.now],
      );
      changed++;
    } else if (
      expected.canonical !== false ||
      expected.finality_status !== "reorged"
    ) {
      stale = true;
      continue;
    }
    if (proof.kind === "canonical") {
      // No EVM positive writer remains here. Restoration needs the branded
      // recorded proof, joint role decision, complete O/U union and original F.
      if (target.asset.networkId.startsWith("evm:")) {
        const protectedRow = await readRefundWatchReceipt(db, {
          receiptId: expected.id,
          operationId: input.operationId,
        });
        if (!protectedRow)
          throw Error("refund watch protected receipt disappeared");
        restorations.push({ row: protectedRow, canonical: proof });
      } else
        changed +=
          (await recanonicalize(db, expected.id, proof, input.now)).rowCount ??
          0;
    }
  }
  return { changed, stale, restorations };
}

/** Compatibility effects boundary. EVM positives intentionally remain pending;
 * only the pool coordinator can commit protection then run joint publication. */
export async function persistRefundCanonicalProofs(
  db: Db,
  input: ProtectionInput,
): Promise<{ changed: number; stale: boolean }> {
  const result = await protectRefundCanonicalProofs(db, input);
  return {
    changed: result.changed,
    stale: result.stale || result.restorations.length > 0,
  };
}

/** DB-only positive effects, invoked after joint E/O/U. Never acquires a new E
 * or O and never reads provider/history. Exact receipt and source binding CAS
 * protects the immutable chain proof from a concurrent reorg or user merge. */
export async function restoreArbitratedRefundCanonicalProof(
  db: Db,
  input: {
    operationId: string;
    row: RefundWatchRow;
    now: Date;
    canonical: Extract<RefundCanonicalProof, { kind: "canonical" }>;
    physical: OwnedRefundPrelock;
    proof: ProtectedRecordedRefundRoleProof;
    classification: Extract<
      ReceiveEventClassification,
      { kind: "internal_refund" }
    >;
  },
): Promise<boolean> {
  const expected = JSON.parse(input.row.receipt_snapshot);
  const incoming = input.physical.incoming;
  if (
    input.proof.recordedObservationId !== expected.id ||
    !incoming ||
    input.canonical.ledgerHeight !== incoming.ledgerHeight ||
    input.canonical.blockHash?.toLowerCase() !==
      incoming.blockHash?.toLowerCase()
  )
    return false;
  const current = await readRefundWatchReceipt(db, {
    receiptId: expected.id,
    operationId: input.operationId,
    snapshot: input.row.receipt_snapshot,
    lock: true,
  });
  if (
    !current ||
    refundWatchBindingFingerprint(current) !==
      refundWatchBindingFingerprint(input.row) ||
    !readRefundCanonicalTarget(current)
  )
    return false;
  if (
    !(await claimArbitratedRecordedRefundEvent(db, {
      locked: input.physical,
      proof: input.proof,
      userId: input.row.user_id,
      operationId: input.operationId,
      segmentId: expected.segment_id,
      classification: input.classification,
    }))
  )
    return false;
  if (
    (await recanonicalize(db, expected.id, input.canonical, input.now))
      .rowCount !== 1
  )
    throw Error("refund watch restoration changed after CAS");
  return true;
}
