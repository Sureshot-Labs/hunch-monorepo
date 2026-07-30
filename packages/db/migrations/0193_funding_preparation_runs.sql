-- Durable, server-owned idempotency journal for standalone venue preparation.

create table funding_preparation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  request_fingerprint text not null,
  request_snapshot jsonb not null,
  inspection_revision text not null,
  controller_wallet_ref uuid,
  status text not null,
  expires_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_preparation_runs_user_request_unique
    unique (user_id, request_fingerprint),
  constraint funding_preparation_runs_user_id_id_unique
    unique (user_id, id),
  constraint funding_preparation_runs_status_check
    check (
      status in (
        'action_required',
        'submitted',
        'ambiguous',
        'failed',
        'cancelled',
        'succeeded',
        'expired'
      )
    ),
  constraint funding_preparation_runs_request_check
    check (
      jsonb_typeof(request_snapshot) = 'object'
      and length(request_fingerprint) between 32 and 192
      and length(inspection_revision) between 8 and 192
    ),
  constraint funding_preparation_runs_resolution_check
    check (
      (status in ('succeeded', 'expired') and resolved_at is not null)
      or (
        status not in ('succeeded', 'expired')
        and resolved_at is null
      )
    )
);

create index funding_preparation_runs_user_updated_idx
  on funding_preparation_runs (user_id, updated_at desc);

create table funding_preparation_action_attempts (
  action_id text primary key,
  run_id uuid not null references funding_preparation_runs(id) on delete restrict,
  ordinal smallint not null check (ordinal >= 0),
  action_fingerprint text not null,
  normalized_action jsonb not null,
  state text not null default 'action_required',
  broadcast_may_have_occurred boolean not null default false,
  transaction_reference text,
  report_snapshot jsonb,
  reported_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_preparation_action_attempts_run_ordinal_unique
    unique (run_id, ordinal),
  constraint funding_preparation_action_attempts_run_fingerprint_unique
    unique (run_id, action_fingerprint),
  constraint funding_preparation_action_attempts_state_check
    check (
      state in (
        'action_required',
        'submitted',
        'ambiguous',
        'failed',
        'cancelled',
        'succeeded'
      )
    ),
  constraint funding_preparation_action_attempts_shape_check
    check (
      jsonb_typeof(normalized_action) = 'object'
      and length(action_id) between 8 and 192
      and length(action_fingerprint) between 32 and 192
      and (
        report_snapshot is null
        or jsonb_typeof(report_snapshot) = 'object'
      )
    ),
  constraint funding_preparation_action_attempts_report_check
    check (
      (
        state = 'action_required'
        and not broadcast_may_have_occurred
        and report_snapshot is null
        and reported_at is null
        and resolved_at is null
      )
      or (
        state in ('submitted', 'ambiguous')
        and broadcast_may_have_occurred
        and report_snapshot is not null
        and reported_at is not null
        and resolved_at is null
      )
      or (
        state in ('failed', 'cancelled')
        and not broadcast_may_have_occurred
        and report_snapshot is not null
        and reported_at is not null
        and resolved_at is not null
      )
      or (
        state = 'succeeded'
        and (
          (
            broadcast_may_have_occurred
            and report_snapshot is not null
            and reported_at is not null
          )
          or (
            not broadcast_may_have_occurred
            and report_snapshot is null
            and reported_at is null
          )
        )
        and resolved_at is not null
      )
    )
);

create index funding_preparation_action_attempts_run_idx
  on funding_preparation_action_attempts (run_id, ordinal);

create trigger funding_preparation_runs_touch_updated_at
before update on funding_preparation_runs
for each row execute function funding_touch_updated_at();

create trigger funding_preparation_action_attempts_touch_updated_at
before update on funding_preparation_action_attempts
for each row execute function funding_touch_updated_at();
