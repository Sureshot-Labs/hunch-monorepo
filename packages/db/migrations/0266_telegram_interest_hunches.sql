-- Opt-in related Hunch deliveries alongside existing position notifications.
alter table telegram_notification_preferences
  add column if not exists interest_signals boolean not null default false,
  add column if not exists interest_signals_enabled_at timestamptz not null default now();

alter table telegram_notification_outbox
  drop constraint if exists telegram_notification_outbox_topic_check;
-- The prior validated seven-topic check is a subset of this one. NOT VALID
-- avoids scanning the outbox during deploy while still enforcing new writes.
alter table telegram_notification_outbox
  add constraint telegram_notification_outbox_topic_check check (
    topic in (
      'order_filled', 'order_issues', 'position_resolved',
      'deposit_received', 'bridge_updates', 'payouts_rewards',
      'position_signals', 'interest_signals'
    )
  ) not valid;

-- Fences a reclaimed preparation from the worker that held the previous claim.
alter table telegram_notification_outbox
  add column if not exists claim_token uuid;

-- A note can arrive before its event embedding. Keep only the note identity;
-- the next attempt reloads current data and never re-runs holder research.
create table if not exists telegram_interest_semantic_repair (
  note_id uuid primary key references ai_notes(id) on delete cascade,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
