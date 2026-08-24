create table if not exists signal_bot_editorial_media_jobs (
  id uuid primary key default gen_random_uuid(),
  signal_bot_message_id uuid not null
    references signal_bot_messages(id) on delete cascade,
  delivery_attempt_id uuid not null,
  chat_id text not null,
  status text not null default 'queued',
  payload jsonb not null,
  result jsonb not null default '{}'::jsonb,
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint signal_bot_editorial_media_jobs_message_unique
    unique (signal_bot_message_id),
  constraint signal_bot_editorial_media_jobs_status_check check (
    status in (
      'queued',
      'rendering',
      'retry',
      'sent',
      'failed',
      'blocked',
      'delivery_unknown'
    )
  ),
  constraint signal_bot_editorial_media_jobs_attempts_check check (
    attempt_count >= 0 and max_attempts between 1 and 10
  )
);

create index if not exists idx_signal_bot_editorial_media_jobs_claim
  on signal_bot_editorial_media_jobs (available_at, created_at)
  where status in ('queued', 'retry', 'rendering');
