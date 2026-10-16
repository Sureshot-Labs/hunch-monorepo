-- Derived, resumable work owned by the existing canonical-event retry queue.
-- No historical financial rows are classified, credited or backfilled here.
create table funding_receive_refund_scans (
  event_id uuid primary key
    references funding_receive_canonical_events(id) on delete restrict,
  contract_version integer not null check (contract_version > 0),
  user_id uuid not null,
  receive_session_id uuid not null,
  variant_id text not null,
  scan_before timestamptz not null default clock_timestamp(),
  source_cursor_created_at timestamptz,
  source_cursor_id uuid,
  source_exhausted boolean not null default false,
  progress_revision bigint not null default 0 check (progress_revision >= 0),
  last_lease_token uuid,
  cleanup_ready boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  constraint funding_receive_refund_scan_cursor_pair check (
    (source_cursor_created_at is null) = (source_cursor_id is null)
  )
);

-- IDs below are captured dependencies, not live ownership FKs. Deleting or
-- reparenting a source must leave an unresolved candidate, never silently drop
-- it through a cascade. No candidate write takes a source operation/reservation
-- lock. Owner/session are revalidated against the frozen canonical-event binding
-- on every page. The existing session evidence already protects user lifecycle.
create table funding_receive_refund_candidates (
  event_id uuid not null
    references funding_receive_refund_scans(event_id) on delete restrict,
  reservation_id uuid not null,
  operation_id uuid not null,
  segment_id uuid,
  envelope_kind text not null check (envelope_kind in ('candidate', 'invalid', 'unrelated')),
  handoff_possible boolean not null default false,
  destination_possible boolean not null default false,
  next_role text not null default 'refund' check (next_role in ('refund','handoff','destination')),
  action_continuation jsonb,
  action_result jsonb,
  handoff_progress jsonb,
  destination_progress jsonb,
  diagnostic_code text,
  last_checked_revision bigint not null default 0 check (last_checked_revision >= 0),
  primary key (event_id, reservation_id),
  constraint funding_receive_refund_candidate_progress_shape check (
    (action_continuation is null or jsonb_typeof(action_continuation) = 'object')
    and (action_result is null or jsonb_typeof(action_result) = 'object')
    and (action_continuation is null or action_result is null)
    and (handoff_progress is null or jsonb_typeof(handoff_progress) = 'object')
    and (destination_progress is null or jsonb_typeof(destination_progress) = 'object')
  )
);

create index funding_receive_refund_candidate_work_idx
  on funding_receive_refund_candidates
    (event_id, last_checked_revision, reservation_id);

-- Cleanup is derived work on the existing receive worker tick, not a financial
-- retry and not a new scheduler. Mark in the allocation transaction so a crash
-- after COMMIT cannot strand a header outside the canonical retry predicate.
create index funding_receive_refund_cleanup_idx
  on funding_receive_refund_scans (updated_at, event_id) where cleanup_ready;

create function funding_receive_refund_mark_cleanup() returns trigger
language plpgsql as $$
begin
  update funding_receive_refund_scans
  set cleanup_ready=true, updated_at=clock_timestamp()
  where event_id=new.id and not cleanup_ready;
  return new;
end;
$$;

create trigger funding_receive_refund_allocation_cleanup
after update of allocation_status on funding_receive_canonical_events
for each row when (new.allocation_status='allocated'
  and old.allocation_status is distinct from new.allocation_status)
execute function funding_receive_refund_mark_cleanup();

-- This is not a second financial job queue. Classification uses the existing
-- event lease; cleanup uses the same worker tick and locks allocated E first.
-- Rows have no market/token payload or private provider references. Cleanup is
-- bounded by exact event and removes children before the header; source/history
-- cleanup must not erase unresolved candidates. Enumeration exhaustion and an
-- action result are not authorization to allocate an external deposit.
-- The existing source-input page also captures reverse-handoff operations and
-- route destinations. Per-role summaries share the same event lease and fair
-- candidate rotation, with no separate queue. Flags are immutable membership,
-- not a financial classification. All negative dependencies require a final
-- revision fence before any future external-allocation integration.
