/* no-transaction */
-- NULL scheduling metadata on legacy rows means due, not lost. A claim moves
-- the indexed date forward before work starts, including for failures.
create index concurrently if not exists funding_receive_classification_due_idx
  on funding_receive_canonical_events
    (coalesce(classification_retry_at, first_observed_at), id)
  where allocation_status = 'recovery_required'
    and allocation_error_code in (
      'receive_session_allocation_unavailable',
      'owned_route_destination_correlation_pending'
    );

create index concurrently if not exists funding_receive_classification_session_idx
  on funding_receive_canonical_events (classification_receive_session_id)
  where classification_receive_session_id is not null;
