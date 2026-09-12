-- Preserve client reports and broadcast facts when exact chain evidence proves
-- an approval reverted. Existing rows remain valid; unknown attempts are untouched.
alter table funding_preparation_action_attempts
  add column receipt_evidence jsonb;

alter table funding_preparation_action_attempts
  drop constraint funding_preparation_action_attempts_report_check,
  add constraint funding_preparation_action_attempts_report_check check (
    (state = 'action_required' and not broadcast_may_have_occurred
      and report_snapshot is null and reported_at is null and resolved_at is null)
    or (state in ('submitted', 'ambiguous') and broadcast_may_have_occurred
      and report_snapshot is not null and reported_at is not null and resolved_at is null)
    or (state in ('failed', 'cancelled') and not broadcast_may_have_occurred
      and report_snapshot is not null and reported_at is not null and resolved_at is not null)
    or (state = 'succeeded'
      and ((broadcast_may_have_occurred and report_snapshot is not null and reported_at is not null)
        or (not broadcast_may_have_occurred and report_snapshot is null and reported_at is null))
      and resolved_at is not null)
    or (state = 'failed' and broadcast_may_have_occurred
      and report_snapshot is not null and reported_at is not null and resolved_at is not null
      and transaction_reference is not null
      and coalesce(
        jsonb_typeof(receipt_evidence) = 'object'
        and receipt_evidence->>'failureFinalized' = 'true'
        and receipt_evidence->>'canonical' = 'true'
        and receipt_evidence->>'actionMatch' = 'true'
        and receipt_evidence->>'transactionReference' = transaction_reference,
        false))
  );

-- Legacy pre-broadcast failed runs can keep their null resolution timestamp.
alter table funding_preparation_runs
  drop constraint funding_preparation_runs_resolution_check,
  add constraint funding_preparation_runs_resolution_check check (
    (status in ('succeeded', 'expired') and resolved_at is not null)
    or status = 'failed'
    or (status not in ('succeeded', 'expired', 'failed') and resolved_at is null)
  );
