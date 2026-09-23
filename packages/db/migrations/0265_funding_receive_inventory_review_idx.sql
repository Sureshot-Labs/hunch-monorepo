-- The historical inventory repair claims one receipt per run. Keep its
-- oldest-unchecked scan bounded as receive history grows; no rows are changed.
-- Its cadence must not share the spent-proof lane's per-receipt timestamp.
alter table funding_receive_receipts
  add column last_inventory_review_checked_at timestamptz;

create index funding_receive_receipts_inventory_review_checked_idx
  on funding_receive_receipts
    (coalesce(last_inventory_review_checked_at,
              '-infinity'::timestamptz), id)
  where status = 'review_required'
    and handling = 'automatic_conversion'
    and child_funding_operation_id is null
    and network_id in ('solana:mainnet', 'evm:137', 'evm:8453')
    and routing_last_error_code in (
      'child_operation_failed_before_broadcast',
      'automation_policy_exceeded',
      'economic_review_required'
    )
    and ledger_height between 0 and 9007199254740991
    and evidence #>> '{reviewQuotePlan,confirmedSourceAmount,raw}' =
        raw_amount::text;

-- Historic EVM addresses may use any case. The wallet-credit proof must
-- compare case-insensitively without a network-wide scan per reviewed row.
create index funding_receive_canonical_events_evm_wallet_asset_idx
  on funding_receive_canonical_events
    (network_id, lower(asset_id), lower(destination_address), ledger_height);

create index funding_receive_receipts_evm_wallet_asset_idx
  on funding_receive_receipts
    (user_id, network_id, lower(asset_id), lower(destination_address),
     ledger_height);

create index funding_observations_evm_wallet_credit_asset_idx
  on funding_observations
    (network_id, lower(asset_id), lower(to_address), ledger_height)
  where canonical
    and finality_status <> 'reorged'
    and kind in ('source_credit', 'destination_credit', 'refund_credit');
