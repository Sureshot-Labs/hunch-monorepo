/* no-transaction */
-- Exact per-manifest receipt lookup and N+1 completion witness. No historical
-- rewrite, new financial fact or data-dependent rollout failure.
create index concurrently if not exists funding_observations_refund_manifest_idx
  on funding_observations (operation_id, segment_id, network_id, tx_hash, event_index)
  where kind = 'refund_credit' and canonical and finality_status = 'finalized';
