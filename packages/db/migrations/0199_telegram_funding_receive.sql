-- Telegram-native channel context for canonical funding Receive Sessions.
--
-- The canonical funding_receive_sessions / funding_receive_receipts tables
-- remain the financial state machine. These tables retain only private-chat
-- context, exact append-only selection evidence, and durable delivery state.

alter table funding_receive_sessions
  add column owner_channel text not null default 'web'
    check (owner_channel in ('web', 'telegram'));

alter table funding_receive_sessions
  add constraint funding_receive_sessions_owner_channel_unique
  unique (user_id, id, owner_channel);

create or replace function guard_funding_receive_session_owner_channel()
returns trigger
language plpgsql
as $$
begin
  if new.owner_channel is distinct from old.owner_channel then
    raise exception 'funding receive session owner channel is immutable';
  end if;
  return new;
end;
$$;

create trigger funding_receive_session_owner_channel_guard
before update on funding_receive_sessions
for each row execute function guard_funding_receive_session_owner_channel();

create table telegram_funding_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  telegram_account_id uuid
    references user_telegram_accounts(id) on delete set null,
  telegram_user_id text not null,
  chat_id text not null,
  telegram_message_id bigint,
  receive_session_id uuid not null unique,
  receive_owner_channel text not null default 'telegram'
    check (receive_owner_channel = 'telegram'),
  origin text not null,
  market_id text,
  event_id text,
  side text check (side in ('YES', 'NO')),
  requested_spend_usd numeric(38, 18),
  active_consent_revision integer
    check (active_consent_revision is null or active_consent_revision > 0),
  idempotency_key text not null unique,
  expires_at timestamptz not null,
  resume_generation integer not null default 0
    check (resume_generation >= 0),
  resume_intent_id uuid references telegram_trade_intents(id) on delete restrict,
  resumed_at timestamptz,
  cancelled_at timestamptz,
  progress_revision integer not null default 0
    check (progress_revision >= 0),
  progress_fingerprint text,
  latest_progress_projection jsonb,
  projected_receive_version bigint not null default 0
    check (projected_receive_version >= 0),
  projected_consent_revision integer not null default 0
    check (projected_consent_revision >= 0),
  projection_checked_at timestamptz,
  latest_terminal_revision integer
    check (latest_terminal_revision is null or latest_terminal_revision > 0),
  latest_terminal_projection jsonb,
  last_delivered_revision integer not null default 0
    check (last_delivered_revision >= 0),
  delivery_lease_outbox_id uuid,
  delivery_lease_attempt_id uuid,
  delivery_lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_funding_sessions_receive_owner_fk
    foreign key (user_id, receive_session_id, receive_owner_channel)
    references funding_receive_sessions(user_id, id, owner_channel)
    on delete restrict,
  constraint telegram_funding_sessions_private_chat_check
    check (chat_id = telegram_user_id),
  constraint telegram_funding_sessions_identity_check
    check (
      length(trim(telegram_user_id)) between 1 and 64
      and length(trim(chat_id)) between 1 and 64
      and length(trim(idempotency_key)) between 8 and 192
    ),
  constraint telegram_funding_sessions_message_check
    check (telegram_message_id is null or telegram_message_id > 0),
  constraint telegram_funding_sessions_expiry_check
    check (expires_at > created_at),
  constraint telegram_funding_sessions_origin_check
    check (
      origin in ('generic_add_funds', 'buy_return_context')
      and (
        (
        origin = 'generic_add_funds'
        and market_id is null
        and event_id is null
        and side is null
        and requested_spend_usd is null
        )
        or (
          origin = 'buy_return_context'
          and market_id is not null
          and side is not null
          and requested_spend_usd is not null
          and requested_spend_usd > 0
        )
      )
    ),
  constraint telegram_funding_sessions_progress_check
    check (
      (
        progress_revision = 0
        and progress_fingerprint is null
        and latest_progress_projection is null
      )
      or (
        progress_revision > 0
        and progress_fingerprint is not null
        and length(trim(progress_fingerprint)) between 8 and 192
        and latest_progress_projection is not null
        and jsonb_typeof(latest_progress_projection) = 'object'
      )
    ),
  constraint telegram_funding_sessions_terminal_check
    check (
      (
        latest_terminal_revision is null
        and latest_terminal_projection is null
      )
      or (
        latest_terminal_revision is not null
        and latest_terminal_revision between 1 and progress_revision
        and latest_terminal_projection is not null
        and jsonb_typeof(latest_terminal_projection) = 'object'
      )
    ),
  constraint telegram_funding_sessions_delivery_revision_check
    check (last_delivered_revision <= progress_revision),
  constraint telegram_funding_sessions_delivery_lease_check
    check (
      (
        delivery_lease_outbox_id is null
        and delivery_lease_attempt_id is null
        and delivery_lease_expires_at is null
      )
      or (
        delivery_lease_outbox_id is not null
        and delivery_lease_attempt_id is not null
        and delivery_lease_expires_at is not null
      )
    )
);

create index telegram_funding_sessions_user_active_idx
  on telegram_funding_sessions (user_id, expires_at, created_at desc)
  where cancelled_at is null;

create index telegram_funding_sessions_account_active_idx
  on telegram_funding_sessions (telegram_account_id, updated_at desc)
  where telegram_account_id is not null and cancelled_at is null;

create index telegram_funding_sessions_terminal_rearm_idx
  on telegram_funding_sessions (telegram_user_id, latest_terminal_revision)
  where latest_terminal_revision is not null;

create table telegram_funding_consents (
  id uuid primary key default gen_random_uuid(),
  telegram_funding_session_id uuid not null
    references telegram_funding_sessions(id) on delete restrict,
  revision integer not null check (revision > 0),
  selected_receive_target_id text not null,
  selected_asset_network_id text not null,
  selected_asset_id text not null,
  selected_asset_decimals integer not null
    check (selected_asset_decimals between 0 and 36),
  consented_variant_ids text[] not null,
  automation_enabled boolean not null,
  max_auto_execute_source_raw numeric(78, 0),
  automation_policy_snapshot jsonb not null,
  consent_fingerprint text not null,
  consented_at timestamptz not null default now(),
  constraint telegram_funding_consents_revision_unique
    unique (telegram_funding_session_id, revision),
  constraint telegram_funding_consents_fingerprint_unique
    unique (telegram_funding_session_id, consent_fingerprint),
  constraint telegram_funding_consents_identity_check
    check (
      length(trim(selected_receive_target_id)) between 8 and 192
      and length(trim(selected_asset_network_id)) between 2 and 96
      and length(trim(selected_asset_id)) between 1 and 192
      and cardinality(consented_variant_ids) > 0
      and length(trim(consent_fingerprint)) between 8 and 192
    ),
  constraint telegram_funding_consents_variants_check
    check (
      array_position(consented_variant_ids, null) is null
    ),
  constraint telegram_funding_consents_automation_check
    check (
      (
        automation_enabled
        and max_auto_execute_source_raw is not null
        and max_auto_execute_source_raw > 0
      )
      or (
        not automation_enabled
        and max_auto_execute_source_raw is null
      )
    ),
  constraint telegram_funding_consents_policy_check
    check (jsonb_typeof(automation_policy_snapshot) = 'object')
);

create index telegram_funding_consents_session_idx
  on telegram_funding_consents (telegram_funding_session_id, revision desc);

alter table telegram_funding_sessions
  add constraint telegram_funding_sessions_active_consent_fk
  foreign key (id, active_consent_revision)
  references telegram_funding_consents (
    telegram_funding_session_id,
    revision
  )
  on delete no action
  deferrable initially immediate;

create table telegram_funding_mutations (
  id uuid primary key default gen_random_uuid(),
  funding_context_id uuid not null
    references telegram_funding_sessions(id) on delete cascade,
  action text not null check (action in ('select_target', 'cancel')),
  idempotency_key text not null unique,
  request_fingerprint text not null,
  response_payload jsonb not null,
  consent_revision integer,
  created_at timestamptz not null default now(),
  constraint telegram_funding_mutations_identity_check
    check (
      length(trim(idempotency_key)) between 8 and 192
      and length(trim(request_fingerprint)) between 8 and 192
      and jsonb_typeof(response_payload) = 'object'
    ),
  constraint telegram_funding_mutations_action_shape_check
    check (
      (action = 'select_target' and consent_revision is not null)
      or (action = 'cancel' and consent_revision is null)
    ),
  constraint telegram_funding_mutations_consent_fk
    foreign key (funding_context_id, consent_revision)
    references telegram_funding_consents (
      telegram_funding_session_id,
      revision
    )
    on delete no action
    deferrable initially immediate
);

create index telegram_funding_mutations_context_idx
  on telegram_funding_mutations (funding_context_id, created_at);

create or replace function guard_telegram_funding_session_identity()
returns trigger
language plpgsql
as $$
begin
  if (
    new.id,
    new.user_id,
    new.telegram_user_id,
    new.chat_id,
    new.receive_session_id,
    new.receive_owner_channel,
    new.origin,
    new.market_id,
    new.event_id,
    new.side,
    new.requested_spend_usd,
    new.idempotency_key,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.id,
    old.user_id,
    old.telegram_user_id,
    old.chat_id,
    old.receive_session_id,
    old.receive_owner_channel,
    old.origin,
    old.market_id,
    old.event_id,
    old.side,
    old.requested_spend_usd,
    old.idempotency_key,
    old.expires_at,
    old.created_at
  ) then
    raise exception 'telegram funding session identity is immutable';
  end if;
  return new;
end;
$$;

create trigger telegram_funding_sessions_identity_guard
before update on telegram_funding_sessions
for each row execute function guard_telegram_funding_session_identity();

create or replace function guard_telegram_funding_consent_evidence()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
    and current_setting('hunch.telegram_funding_retention_cleanup', true) = 'on'
  then
    return old;
  end if;
  raise exception 'telegram funding consent evidence is append-only';
end;
$$;

create trigger telegram_funding_consents_evidence_guard
before update or delete on telegram_funding_consents
for each row execute function guard_telegram_funding_consent_evidence();

create trigger telegram_funding_mutations_evidence_guard
before update or delete on telegram_funding_mutations
for each row execute function guard_telegram_funding_consent_evidence();

create trigger telegram_funding_sessions_touch_updated_at
before update on telegram_funding_sessions
for each row execute function funding_touch_updated_at();

alter table telegram_bot_action_outbox
  drop constraint if exists telegram_bot_action_outbox_action_check;

alter table telegram_bot_action_outbox
  drop constraint if exists telegram_bot_action_outbox_telegram_account_id_action_key;

alter table telegram_bot_action_outbox
  drop constraint if exists telegram_bot_action_outbox_status_check;

alter table telegram_bot_action_outbox
  alter column telegram_account_id drop not null,
  add column funding_session_id uuid
    references telegram_funding_sessions(id) on delete cascade,
  add column state_revision integer,
  add column payload jsonb,
  add column delivery_attempt_id uuid,
  add column delivery_started_at timestamptz;

alter table telegram_bot_action_outbox
  add constraint telegram_bot_action_outbox_status_check
    check (
      status in (
        'pending',
        'sending',
        'retry',
        'sent',
        'skipped',
        'dead',
        'delivery_unknown'
      )
    ),
  add constraint telegram_bot_action_outbox_action_check
    check (
      action in (
        'welcome_menu',
        'funding_send',
        'funding_edit',
        'funding_replacement'
      )
    ),
  add constraint telegram_bot_action_outbox_shape_check
    check (
      (
        action = 'welcome_menu'
        and telegram_account_id is not null
        and funding_session_id is null
        and state_revision is null
        and payload is null
        and delivery_attempt_id is null
        and delivery_started_at is null
      )
      or (
        action in ('funding_send', 'funding_edit', 'funding_replacement')
        and funding_session_id is not null
        and state_revision > 0
        and jsonb_typeof(payload) = 'object'
      )
    ),
  add constraint telegram_bot_action_outbox_delivery_attempt_check
    check (
      (
        delivery_attempt_id is null
        and delivery_started_at is null
      )
      or (
        delivery_attempt_id is not null
        and delivery_started_at is not null
        and action in ('funding_send', 'funding_edit', 'funding_replacement')
      )
    ),
  add constraint telegram_bot_action_outbox_delivery_unknown_check
    check (
      status <> 'delivery_unknown'
      or action in ('welcome_menu', 'funding_send', 'funding_replacement')
    );

alter table telegram_notification_outbox
  drop constraint if exists telegram_notification_outbox_status_check;

alter table telegram_notification_outbox
  add constraint telegram_notification_outbox_status_check
    check (
      status in (
        'pending',
        'sending',
        'retry',
        'sent',
        'skipped',
        'dead',
        'delivery_unknown'
      )
    );

create index if not exists idx_telegram_bot_action_outbox_delivery_unknown
  on telegram_bot_action_outbox (updated_at)
  where status = 'delivery_unknown';

create index if not exists idx_telegram_notification_outbox_delivery_unknown
  on telegram_notification_outbox (updated_at)
  where status = 'delivery_unknown';

drop index if exists idx_telegram_bot_action_outbox_pending;

create index idx_telegram_bot_action_outbox_pending
  on telegram_bot_action_outbox (next_attempt_at, created_at)
  where action = 'welcome_menu' and status in ('pending', 'retry');

drop index if exists idx_telegram_notification_outbox_pending;

create index idx_telegram_notification_outbox_pending
  on telegram_notification_outbox (next_attempt_at, created_at)
  where status in ('pending', 'retry');

create unique index telegram_bot_action_outbox_welcome_unique
  on telegram_bot_action_outbox (telegram_account_id, action)
  where action = 'welcome_menu';

create unique index telegram_bot_action_outbox_funding_unique
  on telegram_bot_action_outbox (funding_session_id, state_revision, action)
  where action in ('funding_send', 'funding_edit', 'funding_replacement');

-- The original trigger named the full UNIQUE constraint as its conflict
-- arbiter. That constraint is replaced above by a welcome-only partial index,
-- so keep the same idempotence with a targetless conflict handler.
create or replace function enqueue_telegram_welcome_menu_on_link()
returns trigger
language plpgsql
as $$
begin
  insert into telegram_bot_action_outbox (
    action,
    telegram_account_id,
    user_id,
    telegram_user_id
  ) values (
    'welcome_menu',
    new.id,
    new.user_id,
    new.telegram_user_id
  )
  on conflict do nothing;
  return new;
end;
$$;

create index telegram_bot_action_outbox_funding_pending_idx
  on telegram_bot_action_outbox (funding_session_id, state_revision, created_at)
  where action in ('funding_send', 'funding_edit', 'funding_replacement')
    and status in ('pending', 'retry', 'sending');

create or replace function rearm_telegram_funding_delivery(
  target_telegram_user_id text,
  target_telegram_account_id uuid
)
returns integer
language plpgsql
as $$
declare
  rearmed_count integer := 0;
  affected_count integer := 0;
  recovery record;
  stale_attempt record;
begin
  -- An explicit /start or relink is itself the recovery authorization. Move
  -- only abandoned send/replacement attempts into the ambiguous quarantine
  -- here, before selecting recovery candidates, so one user action is enough.
  -- A currently active external call remains fenced by its sending row.
  for stale_attempt in
    select
      outbox.id,
      outbox.delivery_attempt_id,
      context.id as context_id
    from telegram_bot_action_outbox outbox
    join telegram_funding_sessions context
      on context.id = outbox.funding_session_id
    join user_telegram_accounts account
      on account.id = target_telegram_account_id
     and account.user_id = context.user_id
     and account.telegram_user_id = context.telegram_user_id
    where context.telegram_user_id = target_telegram_user_id
      and outbox.action in ('funding_send', 'funding_replacement')
      and outbox.status = 'sending'
      and outbox.updated_at <= now() - interval '5 minutes'
    for update of outbox, context
  loop
    update telegram_bot_action_outbox outbox
    set status = 'delivery_unknown',
        last_error = 'funding_send_outcome_unknown',
        updated_at = now()
    where outbox.id = stale_attempt.id
      and outbox.status = 'sending';

    update telegram_funding_sessions context
    set delivery_lease_outbox_id = null,
        delivery_lease_attempt_id = null,
        delivery_lease_expires_at = null
    where context.id = stale_attempt.context_id
      and context.delivery_lease_outbox_id = stale_attempt.id
      and context.delivery_lease_attempt_id = stale_attempt.delivery_attempt_id;
  end loop;

  -- Relinking restores destination ownership for every retained context,
  -- including non-terminal sessions that may become deliverable later. It
  -- does not disturb an active external delivery lease.
  update telegram_funding_sessions context
  set telegram_account_id = target_telegram_account_id
  from user_telegram_accounts account
  where account.id = target_telegram_account_id
    and account.telegram_user_id = target_telegram_user_id
    and account.user_id = context.user_id
    and context.telegram_user_id = target_telegram_user_id
    and context.telegram_account_id is distinct from target_telegram_account_id;

  for recovery in
    select
      context.id,
      context.user_id,
      context.telegram_user_id,
      case
        when exists (
          select 1
          from telegram_bot_action_outbox unknown
          where unknown.funding_session_id = context.id
            and unknown.status = 'delivery_unknown'
        ) then context.progress_revision
        else context.latest_terminal_revision
      end as delivery_revision,
      case
        when exists (
          select 1
          from telegram_bot_action_outbox unknown
          where unknown.funding_session_id = context.id
            and unknown.status = 'delivery_unknown'
        ) then context.latest_progress_projection
        else context.latest_terminal_projection
      end as delivery_projection
    from telegram_funding_sessions context
    join user_telegram_accounts account
      on account.id = target_telegram_account_id
     and account.user_id = context.user_id
     and account.telegram_user_id = context.telegram_user_id
    where context.telegram_user_id = target_telegram_user_id
      and context.latest_progress_projection is not null
      and (
        context.latest_terminal_revision > context.last_delivered_revision
        or exists (
          select 1
          from telegram_bot_action_outbox unknown
          where unknown.funding_session_id = context.id
            and unknown.status = 'delivery_unknown'
        )
      )
      and not exists (
        select 1
        from telegram_bot_action_outbox active_attempt
        where active_attempt.funding_session_id = context.id
          and active_attempt.status = 'sending'
      )
    for update of context
  loop
    update telegram_funding_sessions context
    set telegram_account_id = target_telegram_account_id,
        delivery_lease_outbox_id = null,
        delivery_lease_attempt_id = null,
        delivery_lease_expires_at = null
    where context.id = recovery.id;

    update telegram_bot_action_outbox outbox
    set status = 'skipped',
        last_error = 'funding_delivery_rearmed',
        updated_at = now()
    where outbox.funding_session_id = recovery.id
      and outbox.action in ('funding_send', 'funding_edit', 'funding_replacement')
      and outbox.status in ('pending', 'retry', 'delivery_unknown');

    insert into telegram_bot_action_outbox (
      action,
      telegram_account_id,
      user_id,
      telegram_user_id,
      funding_session_id,
      state_revision,
      payload
    ) values (
      'funding_replacement',
      target_telegram_account_id,
      recovery.user_id,
      recovery.telegram_user_id,
      recovery.id,
      recovery.delivery_revision,
      recovery.delivery_projection
    )
    on conflict (funding_session_id, state_revision, action)
      where action in ('funding_send', 'funding_edit', 'funding_replacement')
    do update
      set telegram_account_id = excluded.telegram_account_id,
          status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          last_error = null,
          delivery_attempt_id = null,
          delivery_started_at = null,
          sent_at = null,
          updated_at = now();
    get diagnostics affected_count = row_count;
    rearmed_count := rearmed_count + affected_count;
  end loop;
  return rearmed_count;
end;
$$;

create or replace function rearm_telegram_funding_terminal_on_link()
returns trigger
language plpgsql
as $$
begin
  perform rearm_telegram_funding_delivery(new.telegram_user_id, new.id);
  return new;
end;
$$;

create trigger rearm_telegram_funding_terminal_on_link
after insert on user_telegram_accounts
for each row execute function rearm_telegram_funding_terminal_on_link();
