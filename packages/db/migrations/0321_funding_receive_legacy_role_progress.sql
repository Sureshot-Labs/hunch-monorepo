-- Extend the existing derived E-owned checkpoint, not the financial ledger or
-- queue. Legacy exact destination witnesses can lack a source reservation.
-- Preserve their real operation/segment identity instead of inventing one.
alter table funding_receive_refund_candidates
  add column candidate_id uuid not null default gen_random_uuid();
alter table funding_receive_refund_candidates
  drop constraint funding_receive_refund_candidates_pkey;
alter table funding_receive_refund_candidates
  alter column reservation_id drop not null,
  add primary key (event_id, candidate_id),
  add unique (event_id, reservation_id),
  add constraint funding_receive_legacy_role_identity check (
    reservation_id is not null or
    (segment_id is not null and envelope_kind='unrelated'
      and destination_possible and not handoff_possible and next_role='destination'
      and action_continuation is null and action_result is null and handoff_progress is null)
  );
create unique index funding_receive_legacy_destination_key
  on funding_receive_refund_candidates(event_id, operation_id, segment_id)
  where reservation_id is null;
drop index funding_receive_refund_candidate_work_idx;
create index funding_receive_refund_candidate_work_idx
  on funding_receive_refund_candidates(event_id, last_checked_revision, candidate_id);
-- Existing reservation rows remain valid and keep their old upsert identity.
-- Cleanup still follows E -> derived children -> header; no source FK/cascade
-- may silently remove a captured negative dependency.
