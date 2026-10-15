/* no-transaction */
-- An unresolved source/refund correlation uses the same bounded known-event
-- repair queue as other receive classifications. Build before replacing the
-- previous index so retries keep an indexed path throughout rollout.
create index concurrently if not exists funding_receive_classification_due_v5_idx
  on funding_receive_canonical_events
    (coalesce(classification_retry_at, first_observed_at), id)
  where allocation_status = 'recovery_required'
    and allocation_error_code in (
      'receive_session_allocation_unavailable',
      'owned_route_destination_correlation_pending',
      'handoff_correlation_pending',
      'handoff_reference_unavailable',
      'internal_event_classification_conflict',
      'exact_refund_correlation_pending',
      'exact_refund_receipt_conflict',
      'exact_refund_receipt_not_final'
    );

drop index concurrently if exists funding_receive_classification_due_v4_idx;
