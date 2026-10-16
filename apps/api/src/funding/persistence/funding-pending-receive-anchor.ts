import type { Pool } from "@hunch/infra";
import type { FundingReceiveCanonicalEventInput } from "./funding-receive-session-repository.js";
import type { EvmFundingReceiveAnchorProof } from "../receive/evm-receive-anchor-proof.js";
import { receiveRoleEventFingerprint } from "../receive/receive-role-progress.js";
import { fundingEvidenceBudgetClient } from "../reconciliation/funding-evidence-budget.js";
import { tryLockFundingPhysicalEvent } from "./funding-physical-event-gate.js";

export const READ_PENDING_RECEIVE_ANCHOR_SQL = `select event_row.id,
  to_jsonb(event_row)::text as snapshot,
  event_row.network_id,event_row.asset_id,event_row.asset_decimals,
  event_row.destination_address,event_row.source_address,event_row.raw_amount::text,
  event_row.tx_hash,event_row.event_index,event_row.ledger_height::text,event_row.block_hash,
  event_row.observed_at
  from funding_receive_canonical_events event_row where event_row.id=$1::uuid`;

export type PendingReceiveAnchorCandidate = Readonly<{
  eventId: string;
  /** PostgreSQL's exact numeric/timestamp representation, never round-tripped
   * through JS numbers/Date. A changed binding/lease/diagnostic also invalidates
   * this CAS; a chain proof is not permission to overwrite concurrent work. */
  snapshot: string;
  event: FundingReceiveCanonicalEventInput;
}>;

export async function readPendingReceiveAnchorCandidate(
  db: Pick<Pool, "query">,
  eventId: string,
): Promise<PendingReceiveAnchorCandidate | null> {
  const row = (
    await db.query<{
      id: string;
      snapshot: string;
      network_id: string;
      asset_id: string;
      asset_decimals: number;
      destination_address: string;
      source_address: string | null;
      raw_amount: string;
      tx_hash: string;
      event_index: string;
      ledger_height: string;
      block_hash: string;
      observed_at: Date;
    }>(READ_PENDING_RECEIVE_ANCHOR_SQL, [eventId])
  ).rows[0];
  return row
    ? {
        eventId: row.id,
        snapshot: row.snapshot,
        event: {
          networkId: row.network_id,
          asset: {
            networkId: row.network_id,
            assetId: row.asset_id,
            decimals: row.asset_decimals,
          },
          destinationAddress: row.destination_address,
          sourceAddress: row.source_address,
          rawAmount: row.raw_amount,
          transactionHash: row.tx_hash,
          eventIndex: row.event_index,
          ledgerHeight: row.ledger_height,
          blockHash: row.block_hash,
          observedAt: row.observed_at,
          now: new Date(),
        },
      }
    : null;
}

export const LOCK_PENDING_RECEIVE_ANCHOR_SQL = `select
  to_jsonb(event_row)=$2::jsonb as snapshot_matches,
  (event_row.allocation_status='pending' or
    (event_row.allocation_status='recovery_required' and event_row.allocation_error_code in
      ('receive_session_allocation_unavailable','owned_route_destination_correlation_pending',
       'handoff_correlation_pending','handoff_reference_unavailable','exact_refund_correlation_pending')))
    and event_row.allocated_receipt_id is null and event_row.allocated_receive_session_id is null
    as repairable
  from funding_receive_canonical_events event_row where event_row.id=$1::uuid for update`;

export const REPAIR_PENDING_RECEIVE_ANCHOR_SQL = `update funding_receive_canonical_events event_row
  set ledger_height=$3::numeric,block_hash=$4,classification_lease_token=null,
    anchor_repair_provenance=coalesce(anchor_repair_provenance,'[]'::jsonb)||$5::jsonb
  where event_row.id=$1::uuid and to_jsonb(event_row)=$2::jsonb returning event_row.id`;

export const RESET_REANCHORED_RECEIVE_SCAN_SQL = `update funding_receive_refund_scans
  set event_fingerprint=null,last_lease_token=null,source_exhausted=false,
    scan_before=clock_timestamp(),source_cursor_created_at=null,source_cursor_id=null,
    updated_at=clock_timestamp()
  where event_id=$1::uuid`;

/** Metadata-only recovery. Gate -> E -> a NEW READ COMMITTED ownership snapshot
 * -> exact envelope CAS. No O, receipt, balance, allocation, acknowledgment or
 * consumer execution. Keep the just-scheduled retry date: never reclaim the
 * same event repeatedly within a fixed logical test/worker clock. */
export async function repairPendingReceiveAnchor(
  pool: Pool,
  input: {
    candidate: PendingReceiveAnchorCandidate;
    proof: EvmFundingReceiveAnchorProof;
    deadlineMs: number;
  },
): Promise<"reanchored" | "stale" | "owned" | "unavailable"> {
  const { candidate, proof } = input;
  const event = candidate.event;
  if (
    proof.kind !== "replacement_verified" ||
    proof.eventFingerprint !== receiveRoleEventFingerprint(event) ||
    !["evm:137", "evm:8453"].includes(event.networkId) ||
    !/^0x[0-9a-f]{64}$/u.test(proof.blockHash) ||
    !/^0x[0-9a-f]{64}$/u.test(proof.previousCanonicalHash) ||
    proof.previousCanonicalHash === event.blockHash.toLowerCase() ||
    !/^(0|[1-9][0-9]*)$/u.test(proof.ledgerHeight) ||
    !Number.isSafeInteger(Number(proof.ledgerHeight)) ||
    (proof.ledgerHeight === event.ledgerHeight &&
      proof.blockHash !== proof.previousCanonicalHash)
  )
    return "unavailable";
  const raw = await pool.connect();
  try {
    await raw.query("begin");
    await raw.query("set transaction isolation level read committed");
    const db = fundingEvidenceBudgetClient(raw, input.deadlineMs);
    await tryLockFundingPhysicalEvent(db, event);
    const locked = (
      await db.query<{ snapshot_matches: boolean; repairable: boolean }>(
        LOCK_PENDING_RECEIVE_ANCHOR_SQL,
        [candidate.eventId, candidate.snapshot],
      )
    ).rows[0];
    if (!locked?.snapshot_matches || !locked.repairable) {
      await raw.query("rollback");
      return locked?.snapshot_matches ? "unavailable" : "stale";
    }
    // Separate statement AFTER the gate/E locks: an ownership insert that won
    // before the gate must be visible, including retracted/legacy/other-user
    // facts and retained H markers. Missing hints are not negative proof.
    const ownership = await db.query<{ owned: boolean }>(
      "select funding_receive_physical_event_is_owned($1,$2,$3) as owned",
      [event.networkId, event.transactionHash, event.eventIndex],
    );
    if (ownership.rows[0]?.owned !== false) {
      await raw.query("rollback");
      return "owned";
    }
    const provenance = {
      version: 1,
      eventFingerprint: proof.eventFingerprint,
      previous: {
        ledgerHeight: event.ledgerHeight,
        blockHash: event.blockHash,
      },
      replacement: {
        ledgerHeight: proof.ledgerHeight,
        blockHash: proof.blockHash,
      },
      previousCanonicalHash: proof.previousCanonicalHash,
      recordedAt: new Date().toISOString(),
    };
    const changed = await db.query(REPAIR_PENDING_RECEIVE_ANCHOR_SQL, [
      candidate.eventId,
      candidate.snapshot,
      proof.ledgerHeight,
      proof.blockHash,
      JSON.stringify([provenance]),
    ]);
    if (changed.rowCount !== 1) {
      await raw.query("rollback");
      return "stale";
    }
    await db.query(RESET_REANCHORED_RECEIVE_SCAN_SQL, [candidate.eventId]);
    await raw.query("commit");
    return "reanchored";
  } catch (error) {
    await raw.query("rollback");
    throw error;
  } finally {
    raw.release();
  }
}
