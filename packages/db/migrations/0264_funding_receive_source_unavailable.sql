-- A received asset can remain in the user's wallet when its automatic
-- conversion did not start. Later finalized spending from that same wallet
-- can make the original exact-input review impossible without making the
-- conversion successful or erasing the deposit evidence.
alter table funding_receive_sessions
  add column last_spent_review_checked_at timestamptz;

create index funding_receive_sessions_spent_review_checked_idx
  on funding_receive_sessions (last_spent_review_checked_at, id)
  where status in ('review_required', 'recovery_required', 'expired',
                   'cancelled', 'completed');

-- Historical repair starts from this eligible-receipt partial index, so
-- unrelated old sessions cannot delay an actionable review.
alter table funding_receive_receipts
  add column last_spent_review_checked_at timestamptz;

create index funding_receive_receipts_spent_review_eligible_idx
  on funding_receive_receipts
    (receive_session_id, user_id, last_spent_review_checked_at,
     created_at, id)
  where status = 'review_required'
    and handling = 'automatic_conversion'
    and child_funding_operation_id is null
    and network_id = 'solana:mainnet'
    and ledger_height is not null
    and routing_last_error_code in (
      'child_operation_failed_before_broadcast',
      'automation_policy_exceeded',
      'economic_review_required'
    );

-- A physical wallet/asset can appear under more than one component ID.
-- Both commit admission and the review repair look up this physical scope.
create index balance_reservations_physical_source_idx
  on balance_reservations
    (user_id, location_id, network_id, asset_id, operation_id)
  where mode = 'subtract_available';

create index funding_receive_canonical_events_wallet_asset_idx
  on funding_receive_canonical_events
    (network_id, asset_id, destination_address);

create index funding_observations_wallet_credit_asset_idx
  on funding_observations
    (network_id, asset_id, to_address)
  where canonical
    and finality_status <> 'reorged'
    and kind in ('source_credit', 'destination_credit', 'refund_credit');
