/** Pure shared SQL: importing physical-event locks must not initialize RPC or
 * API-wide configuration. These statements require the caller's transaction. */
export const CANONICAL_EVENT_OWNERSHIP_READ_SQL = `
select network_id,tx_hash,event_index,asset_id,asset_decimals,source_address,destination_address,
  raw_amount::text,ledger_height::text,block_hash
  ,allocation_status,allocation_error_code,allocated_receipt_id,allocated_receive_session_id
from funding_receive_canonical_events
where network_id=$1 and tx_hash=$2 and event_index=$3`;

export const CANONICAL_EVENT_OWNERSHIP_LOCK_SQL = `${CANONICAL_EVENT_OWNERSHIP_READ_SQL} for update`;

export type CanonicalEventOwnershipRow = {
  asset_id: string;
  asset_decimals: number;
  source_address: string | null;
  destination_address: string;
  raw_amount: string;
  ledger_height: string;
  block_hash: string;
  allocation_status: string;
  allocation_error_code: string | null;
  allocated_receipt_id: string | null;
  allocated_receive_session_id: string | null;
};

export const REFUND_CANONICAL_LOCK_SQL = `select (asset_id=lower($4) and asset_decimals=$5 and raw_amount=$6::numeric
  and source_address=lower($7) and destination_address=lower($8)
  and ledger_height=$9::numeric and lower(block_hash)=lower($10)) as snapshot_matches
 from funding_receive_canonical_events
 where network_id=$1 and tx_hash=$2 and event_index=$3 for update`;
export const REFUND_RECEIVE_ANCHOR_UPDATE_SQL = `update funding_receive_canonical_events
  set ledger_height=$4::numeric, block_hash=$5
  where network_id=$1 and tx_hash=$2 and event_index=$3
    and allocation_status='recovery_required' and allocation_error_code in (
      'internal_exact_refund_suppressed','exact_refund_receipt_not_final',
      'exact_refund_receipt_conflict','internal_event_classification_conflict')
    and allocated_receipt_id is null and allocated_receive_session_id is null`;
