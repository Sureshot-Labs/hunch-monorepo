/* no-transaction */
-- Build the wider retry index before removing its predecessor. No historical
-- suppressed event is reclassified or assigned a speculative receive owner.
create index concurrently if not exists funding_receive_classification_due_v2_idx
  on funding_receive_canonical_events
    (coalesce(classification_retry_at, first_observed_at), id)
  where allocation_status = 'recovery_required'
    and allocation_error_code in (
      'receive_session_allocation_unavailable',
      'owned_route_destination_correlation_pending',
      'handoff_correlation_pending',
      'handoff_reference_unavailable'
    );

drop index concurrently if exists funding_receive_classification_due_idx;
