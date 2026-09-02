-- A receive session owns the destination-selection slot only while it is open.
-- Processing is protected by receipt-level selection checks. Review/recovery
-- sessions must remain resumable without preventing a fresh deposit session,
-- including when an older review is resumed after the new session is opened.

-- In-flight/review/recovery work remains resumable by session id after its
-- address-selection lease is released. `closed_at` is therefore also the
-- durable supersession marker for those non-open states: NULL means no
-- successor has replaced the address yet, non-NULL means settlement must
-- finish as completed rather than reopening that old address.
alter table funding_receive_sessions
  drop constraint funding_receive_sessions_closed_check;

alter table funding_receive_sessions
  add constraint funding_receive_sessions_closed_check
    check (
      (status = 'open' and closed_at is null)
      or status in ('processing', 'review_required', 'recovery_required')
      or (
        status in ('completed', 'expired', 'cancelled')
        and closed_at is not null
      )
    );

drop index if exists funding_receive_sessions_one_open_destination_idx;

create unique index funding_receive_sessions_one_open_destination_idx
  on funding_receive_sessions (
    user_id,
    destination_option_id,
    venue_binding_option_id
  )
  where status = 'open';

-- A released session remains a late-deposit observation target through its
-- existing grace window, just like an expired or explicitly cancelled one.
drop index if exists funding_receive_sessions_observation_grace_idx;

create index funding_receive_sessions_observation_grace_idx
  on funding_receive_sessions (observe_until, updated_at)
  where status in ('completed', 'expired', 'cancelled');
