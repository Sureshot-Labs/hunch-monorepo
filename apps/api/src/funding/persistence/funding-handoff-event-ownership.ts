import type { PoolClient } from "@hunch/infra";
import { RELAY_ROUTE_SPECS } from "../../funding-providers/relay/mappings.js";
import { normalizedActionSchema } from "../domain/schemas.js";
import type { JsonValue, NormalizedAction } from "../domain/types.js";
import { polymarketDepositWalletHandoffExpectation } from "../execution/polymarket-deposit-wallet-handoff.js";
import { canonicalJsonHash } from "./canonical.js";
import { FundingClassificationChangedError } from "./funding-classification-revisions.js";
import {
  lockFundingReceiveCanonicalEvents,
  compareFundingReceiveCanonicalEvents,
  quarantineFundingReceiveCanonicalInternalEvent,
  type FundingReceiveCanonicalEventInput,
} from "./funding-receive-session-repository.js";
import type { FundingStepReceiptEvidence } from "./funding-step-receipt-repository.js";
import {
  CANONICAL_EVENT_OWNERSHIP_LOCK_SQL,
  type CanonicalEventOwnershipRow,
} from "./canonical-event-lock-sql.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;
type Database = Pick<PoolClient, "query">;
type Snapshot = Readonly<{
  normalized_action: JsonRecord;
  action_validation_result: JsonRecord;
  previous_receipt: FundingStepReceiptEvidence | null;
}>;

// Exact identities only. OFFSET 0 keeps generic plans on the step/attempt PKs
// before the cross-owner binding checks, rather than scanning an owner's past.
export const HANDOFF_EVENT_SNAPSHOT_SQL = `
select step_row.normalized_action, step_row.action_validation_result,
  case when receipt_row.attempt_id is null then null else jsonb_build_object(
    'status',receipt_row.status, 'actionMatch',receipt_row.action_match,
    'ledgerHeight',receipt_row.ledger_height, 'blockHash',receipt_row.block_hash,
    'canonical',receipt_row.canonical, 'failureCode',receipt_row.failure_code,
    'evidence',receipt_row.evidence) end as previous_receipt
from (select * from funding_operation_steps where id=$2::uuid offset 0) step_row
cross join (select * from funding_operation_step_attempts where id=$3::uuid offset 0) attempt_row
left join funding_step_receipt_observations receipt_row on receipt_row.attempt_id=attempt_row.id
where step_row.operation_id=$1::uuid and attempt_row.step_id=step_row.id
  and step_row.step_kind='external_handoff'
  and step_row.normalized_action->>'handoffKind' in
    ('polymarket_deposit_wallet_transfer','polymarket_safe_transfer')
  and attempt_row.broadcast_may_have_occurred`;

export const HANDOFF_EVENT_OTHER_CREDIT_SQL = `
select operation_id,kind from funding_observations
where network_id=$1 and tx_hash=$2 and event_index=$3
  and kind in ('destination_credit','refund_credit')
limit 1`;

export const HANDOFF_EXISTING_EVENT_LOCK_SQL =
  CANONICAL_EVENT_OWNERSHIP_LOCK_SQL;

export const HANDOFF_EVENT_ANCHOR_REPAIR_SQL = `update funding_receive_canonical_events
 set ledger_height=$4::numeric,block_hash=$5
 where network_id=$1 and tx_hash=$2 and event_index=$3
   and ledger_height=$6::numeric and block_hash=$7
   and allocation_status='recovery_required' and allocation_error_code='internal_handoff_suppressed'
   and allocated_receipt_id is null and allocated_receive_session_id is null`;

function positive(receipt: FundingStepReceiptEvidence): boolean {
  return (
    (receipt.status === "confirmed" || receipt.status === "finalized") &&
    receipt.canonical &&
    receipt.actionMatch === true &&
    receipt.failureCode === null
  );
}

function eventForReceipt(
  snapshot: Snapshot,
  receipt: FundingStepReceiptEvidence | null,
  now: Date,
): FundingReceiveCanonicalEventInput | null {
  if (!receipt) return null;
  const parsed = normalizedActionSchema.safeParse(snapshot.normalized_action);
  if (!parsed.success) return null;
  const expectation = polymarketDepositWalletHandoffExpectation(
    parsed.data as NormalizedAction,
    snapshot.action_validation_result,
  );
  if (!expectation) return null;
  // The output token can differ from the source during USDCE -> pUSD wrapping.
  // Resolve its precision from the existing immutable route registry, not the
  // requested source amount or an assumed decimal count.
  const asset = Object.values(RELAY_ROUTE_SPECS)
    .flatMap((route) => [route.source, route.destination])
    .find(
      (item) =>
        item.networkId === "evm:137" &&
        item.assetId.toLowerCase() === expectation.tokenAddress.toLowerCase(),
    );
  const hash = receipt.evidence.transactionHash;
  const index = receipt.evidence.handoffEventIndex;
  if (
    !asset ||
    typeof hash !== "string" ||
    !/^0x[\da-f]{64}$/iu.test(hash) ||
    typeof index !== "string" ||
    !/^\d+$/u.test(index) ||
    typeof receipt.ledgerHeight !== "string" ||
    !/^\d+$/u.test(receipt.ledgerHeight) ||
    typeof receipt.blockHash !== "string" ||
    !/^0x[\da-f]{64}$/iu.test(receipt.blockHash)
  )
    return null;
  return {
    networkId: asset.networkId,
    asset,
    sourceAddress: expectation.funderAddress,
    destinationAddress: expectation.recipientAddress,
    rawAmount: expectation.amountRaw.toString(),
    transactionHash: hash.toLowerCase(),
    eventIndex: BigInt(index).toString(),
    ledgerHeight: receipt.ledgerHeight,
    blockHash: receipt.blockHash.toLowerCase(),
    observedAt: now,
    now,
  };
}

function samePhysicalKey(
  a: FundingReceiveCanonicalEventInput,
  b: FundingReceiveCanonicalEventInput,
) {
  return (
    a.networkId === b.networkId &&
    a.transactionHash === b.transactionHash &&
    a.eventIndex === b.eventIndex
  );
}

export type HandoffEventPrelock = Readonly<{
  snapshot: string | null;
  incoming: FundingReceiveCanonicalEventInput | null;
  changedAnchor: boolean;
  identityConflict?: boolean;
  previous?: FundingReceiveCanonicalEventInput | null;
  repairFrom?: FundingReceiveCanonicalEventInput | null;
}>;

export function handoffOwnedPhysicalEvent(
  event: FundingReceiveCanonicalEventInput,
): JsonRecord {
  return {
    transactionHash: event.transactionHash,
    handoffEventIndex: event.eventIndex,
    ledgerHeight: event.ledgerHeight,
    blockHash: event.blockHash,
  };
}

/** Must run before O/step/attempt locks. Reorg evidence locks the PREVIOUS owned
 * physical event without releasing it. A nonfinal confirmed anchor may move
 * only under the same ownership, exact receipt snapshot and economic envelope. */
export async function prelockFundingHandoffEvent(
  db: Database,
  input: Readonly<{
    operationId: string;
    stepId: string;
    attemptId: string;
    networkId: string;
    receipt: FundingStepReceiptEvidence;
    now: Date;
  }>,
): Promise<HandoffEventPrelock> {
  if (input.networkId !== "evm:137")
    return { snapshot: null, incoming: null, changedAnchor: false };
  const { rows } = await db.query<Snapshot>(HANDOFF_EVENT_SNAPSHOT_SQL, [
    input.operationId,
    input.stepId,
    input.attemptId,
  ]);
  const row = rows[0];
  if (!row) return { snapshot: null, incoming: null, changedAnchor: false };
  const old = row.previous_receipt;
  const owned = old?.evidence.handoffOwnedPhysicalEventV1;
  const saved =
    owned && typeof owned === "object" && !Array.isArray(owned)
      ? (owned as JsonRecord)
      : null;
  const previous =
    saved && old
      ? eventForReceipt(
          row,
          {
            ...old,
            ledgerHeight:
              typeof saved.ledgerHeight === "string"
                ? saved.ledgerHeight
                : null,
            blockHash:
              typeof saved.blockHash === "string" ? saved.blockHash : null,
            evidence: saved,
          },
          input.now,
        )
      : old && positive(old)
        ? eventForReceipt(row, old, input.now)
        : null;
  const incoming = positive(input.receipt)
    ? eventForReceipt(row, input.receipt, input.now)
    : null;
  let changedAnchor = Boolean(
    previous &&
    incoming &&
    samePhysicalKey(previous, incoming) &&
    (previous.ledgerHeight !== incoming.ledgerHeight ||
      previous.blockHash !== incoming.blockHash),
  );
  let identityConflict = false;
  let repairFrom: FundingReceiveCanonicalEventInput | null = null;
  const events = [
    ...(previous ? [previous] : []),
    ...(incoming && !changedAnchor ? [incoming] : []),
  ].sort(compareFundingReceiveCanonicalEvents);
  for (const event of events) {
    const readLocked = () =>
      db.query<CanonicalEventOwnershipRow>(HANDOFF_EXISTING_EVENT_LOCK_SQL, [
        event.networkId,
        event.transactionHash,
        event.eventIndex,
      ]);
    let locked = (await readLocked()).rows[0];
    if (!locked) {
      // A legacy confirmed receipt did not necessarily own an E row. When
      // there is no prior claim, install the currently inspected anchor, not
      // a stale pre-finality anchor that would create its own repair barrier.
      const firstClaim =
        !saved &&
        old?.status === "confirmed" &&
        incoming &&
        samePhysicalKey(event, incoming)
          ? incoming
          : event;
      await lockFundingReceiveCanonicalEvents(db, [firstClaim]);
      locked = (await readLocked()).rows[0];
      if (!locked) throw new Error("handoff physical prelock disappeared");
      if (
        firstClaim === incoming &&
        locked.ledger_height === incoming.ledgerHeight &&
        locked.block_hash === incoming.blockHash
      )
        changedAnchor = false;
    }
    // Reorg invalidation locks the existing physical row without replacing its
    // anchor. A positive update at a different anchor requires explicit repair.
    if (incoming && samePhysicalKey(event, incoming)) {
      const differsFromIncoming =
        locked.ledger_height !== incoming.ledgerHeight ||
        locked.block_hash.toLowerCase() !== incoming.blockHash.toLowerCase();
      // Legacy confirmed evidence alone did not freeze ownership. A receive
      // poll may already have installed the new, currently canonical anchor.
      changedAnchor =
        !saved && old?.status === "confirmed"
          ? differsFromIncoming
          : changedAnchor || differsFromIncoming;
      identityConflict ||=
        locked.asset_id.toLowerCase() !==
          incoming.asset.assetId.toLowerCase() ||
        locked.asset_decimals !== incoming.asset.decimals ||
        locked.source_address?.toLowerCase() !==
          incoming.sourceAddress?.toLowerCase() ||
        locked.destination_address.toLowerCase() !==
          incoming.destinationAddress.toLowerCase() ||
        locked.raw_amount !== incoming.rawAmount;
      if (
        changedAnchor &&
        !identityConflict &&
        old?.status === "confirmed" &&
        (positive(old) ||
          (saved !== null &&
            old.evidence.handoffPhysicalIdentityConflict !== true)) &&
        previous &&
        samePhysicalKey(previous, incoming) &&
        locked.ledger_height === previous.ledgerHeight &&
        locked.block_hash === previous.blockHash &&
        locked.allocation_status === "recovery_required" &&
        locked.allocation_error_code === "internal_handoff_suppressed" &&
        locked.allocated_receipt_id === null &&
        locked.allocated_receive_session_id === null
      ) {
        repairFrom = previous;
      }
    }
  }
  return {
    snapshot: canonicalJsonHash(row),
    incoming,
    changedAnchor,
    identityConflict,
    previous,
    repairFrom,
  };
}

/** Re-read only exact immutable bindings/current receipt after O. A waiter may
 * not discover a new E while holding O: restart the ordinary reconciliation. */
export async function revalidateFundingHandoffEvent(
  db: Database,
  input: Readonly<{
    operationId: string;
    stepId: string;
    attemptId: string;
    networkId: string;
  }>,
  prelock: HandoffEventPrelock,
): Promise<void> {
  if (input.networkId !== "evm:137") return;
  const { rows } = await db.query<Snapshot>(HANDOFF_EVENT_SNAPSHOT_SQL, [
    input.operationId,
    input.stepId,
    input.attemptId,
  ]);
  if ((rows[0] ? canonicalJsonHash(rows[0]) : null) !== prelock.snapshot)
    throw new FundingClassificationChangedError();
}

/** Called only for an accepted positive receipt, after same-attempt replay and
 * competing-handoff checks. Historical refund/destination claims retain their
 * ownership even when their legacy writer never installed a canonical E row. */
export async function claimFundingHandoffEvent(
  db: Database,
  prelock: HandoffEventPrelock,
): Promise<"claimed" | "not_applicable" | "conflict" | "anchor_changed"> {
  if (prelock.snapshot === null) return "not_applicable";
  if (prelock.identityConflict) return "conflict";
  if (prelock.changedAnchor && !prelock.repairFrom) return "anchor_changed";
  const event = prelock.incoming;
  if (!event) return "conflict";
  const { rows } = await db.query(HANDOFF_EVENT_OTHER_CREDIT_SQL, [
    event.networkId,
    event.transactionHash,
    event.eventIndex,
  ]);
  if (rows.length) return "conflict";
  if (prelock.repairFrom) {
    const repaired = await db.query(HANDOFF_EVENT_ANCHOR_REPAIR_SQL, [
      event.networkId,
      event.transactionHash,
      event.eventIndex,
      event.ledgerHeight,
      event.blockHash,
      prelock.repairFrom.ledgerHeight,
      prelock.repairFrom.blockHash,
    ]);
    if (repaired.rowCount !== 1) return "anchor_changed";
  }
  return (await quarantineFundingReceiveCanonicalInternalEvent(db, {
    ...event,
    reason: "internal_handoff_suppressed",
  }))
    ? "claimed"
    : "conflict";
}
