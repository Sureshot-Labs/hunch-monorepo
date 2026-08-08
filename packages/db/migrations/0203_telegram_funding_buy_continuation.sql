-- Append-only Telegram funding Buy-return and resume evidence.

-- A receipt is financial evidence for exactly one frozen observation variant.
-- Enforce that identity once at the database boundary so projectors, routing,
-- and Buy continuation do not grow their own subtly different predicates.
create or replace function funding_receive_receipt_matches_frozen_variant(
  candidate funding_receive_receipts
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from funding_receive_sessions receive
    cross join lateral jsonb_array_elements(receive.observation_variants) variant
    where receive.id = candidate.receive_session_id
      and receive.user_id = candidate.user_id
      and variant ->> 'variantId' = candidate.variant_id
      and variant ->> 'networkId' = candidate.network_id
      and variant -> 'asset' ->> 'networkId' = candidate.network_id
      and (variant -> 'asset' ->> 'decimals')::integer = candidate.asset_decimals
      and (
        (
          candidate.network_id like 'evm:%'
          and lower(variant -> 'asset' ->> 'assetId') = lower(candidate.asset_id)
          and lower(variant ->> 'destinationAddress') = lower(candidate.destination_address)
        )
        or (
          candidate.network_id not like 'evm:%'
          and variant -> 'asset' ->> 'assetId' = candidate.asset_id
          and variant ->> 'destinationAddress' = candidate.destination_address
        )
      )
      and (
        candidate.handling <> 'direct'
        or variant -> 'completion' ->> 'kind' = 'direct_destination_credit'
      )
  )
$$;

create table telegram_funding_buy_return_revisions (
  telegram_funding_session_id uuid not null
    references telegram_funding_sessions(id) on delete cascade,
  revision integer not null check (revision > 0),
  parent_revision integer,
  telegram_account_id_snapshot uuid not null,
  market_id text not null references unified_markets(id) on delete restrict,
  event_id text,
  side text not null check (side in ('YES', 'NO')),
  requested_spend_usd numeric(18, 6) not null check (requested_spend_usd > 0),
  source_shortfall_intent_id uuid,
  source_authority_fingerprint text not null,
  venue_id text not null,
  destination_option_id text not null,
  venue_binding_option_id text not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (telegram_funding_session_id, revision),
  unique (telegram_funding_session_id, request_fingerprint),
  constraint telegram_funding_buy_returns_parent_shape_check check (
    (revision = 1 and parent_revision is null)
    or (revision > 1 and parent_revision = revision - 1)
  ),
  constraint telegram_funding_buy_returns_parent_fk foreign key (
    telegram_funding_session_id, parent_revision
  ) references telegram_funding_buy_return_revisions (
    telegram_funding_session_id, revision
  ) on delete cascade deferrable initially immediate,
  constraint telegram_funding_buy_returns_identity_check check (
    length(trim(venue_id)) between 1 and 64
    and length(trim(destination_option_id)) between 1 and 192
    and length(trim(venue_binding_option_id)) between 1 and 192
    and length(trim(request_fingerprint)) between 8 and 192
    and length(trim(source_authority_fingerprint)) between 8 and 192
  )
);

alter table telegram_funding_sessions
  add column active_buy_return_revision integer
    check (active_buy_return_revision is null or active_buy_return_revision > 0);

alter table telegram_funding_sessions
  add column projected_buy_return_revision integer not null default 0
    check (projected_buy_return_revision >= 0),
  add column projected_buy_policy_revision text;

alter table telegram_funding_sessions
  add constraint telegram_funding_sessions_buy_projection_check check (
    (
      projected_buy_return_revision = 0
      and (
        projected_buy_policy_revision is null
        or length(trim(projected_buy_policy_revision)) between 1 and 192
      )
    )
    or (
      projected_buy_return_revision > 0
      and projected_buy_policy_revision is not null
      and length(trim(projected_buy_policy_revision)) between 1 and 192
      and active_buy_return_revision is not null
      and projected_buy_return_revision <= active_buy_return_revision
    )
  );

alter table telegram_funding_sessions
  add constraint telegram_funding_sessions_active_buy_return_fk foreign key (
    id, active_buy_return_revision
  ) references telegram_funding_buy_return_revisions (
    telegram_funding_session_id, revision
  ) on delete no action deferrable initially immediate;

create index telegram_funding_buy_returns_market_idx
  on telegram_funding_buy_return_revisions (market_id);
create index telegram_funding_buy_returns_event_idx
  on telegram_funding_buy_return_revisions (event_id)
  where event_id is not null;
create index telegram_funding_buy_returns_session_desc_idx
  on telegram_funding_buy_return_revisions (
    telegram_funding_session_id, revision desc
  );

create or replace function validate_telegram_funding_buy_return_binding()
returns trigger language plpgsql as $$
begin
  if not exists (
    select 1
    from telegram_funding_sessions context
    join funding_receive_sessions receive
      on receive.id = context.receive_session_id
     and receive.user_id = context.user_id
     and receive.owner_channel = context.receive_owner_channel
    join unified_markets market on market.id = new.market_id
    where context.id = new.telegram_funding_session_id
      and context.receive_owner_channel = 'telegram'
      and receive.venue_id = new.venue_id
      and receive.destination_option_id = new.destination_option_id
      and receive.venue_binding_option_id = new.venue_binding_option_id
      and market.venue::text = new.venue_id
  ) then
    raise exception 'Telegram funding Buy return binding is not current';
  end if;
  return new;
end;
$$;

create trigger telegram_funding_buy_returns_binding_guard
before insert on telegram_funding_buy_return_revisions
for each row execute function validate_telegram_funding_buy_return_binding();

create table telegram_funding_buy_continuations (
  id uuid primary key default gen_random_uuid(),
  telegram_funding_session_id uuid not null
    references telegram_funding_sessions(id) on delete cascade,
  buy_return_revision integer not null check (buy_return_revision > 0),
  ready_progress_revision integer not null check (ready_progress_revision > 0),
  ready_receive_version bigint not null check (ready_receive_version > 0),
  token_hash text not null unique,
  binding_fingerprint text not null,
  policy_revision text not null,
  telegram_account_id uuid
    references user_telegram_accounts(id) on delete set null,
  telegram_user_id text not null,
  chat_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (
    id,
    telegram_funding_session_id,
    buy_return_revision,
    ready_progress_revision
  ),
  unique (
    id,
    telegram_funding_session_id,
    buy_return_revision
  ),
  constraint telegram_funding_buy_continuations_return_fk foreign key (
    telegram_funding_session_id, buy_return_revision
  ) references telegram_funding_buy_return_revisions (
    telegram_funding_session_id, revision
  ) on delete cascade,
  constraint telegram_funding_buy_continuations_identity_check check (
    chat_id = telegram_user_id
    and length(trim(telegram_user_id)) between 1 and 64
    and length(trim(token_hash)) between 8 and 192
    and length(trim(binding_fingerprint)) between 8 and 192
  ),
  constraint telegram_funding_buy_continuations_expiry_check
    check (expires_at > created_at)
);

create index telegram_funding_buy_continuations_expiry_idx
  on telegram_funding_buy_continuations (expires_at);
create index telegram_funding_buy_continuations_account_idx
  on telegram_funding_buy_continuations (telegram_account_id, created_at desc)
  where telegram_account_id is not null;

create table telegram_funding_buy_resume_generations (
  telegram_funding_session_id uuid not null
    references telegram_funding_sessions(id) on delete cascade,
  generation integer not null check (generation > 0),
  parent_generation integer,
  buy_return_revision integer not null check (buy_return_revision > 0),
  continuation_id uuid not null,
  ready_progress_revision integer not null check (ready_progress_revision > 0),
  telegram_account_id_snapshot uuid not null,
  trade_intent_id uuid not null unique
    references telegram_trade_intents(id) on delete restrict,
  idempotency_key text not null unique,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  primary key (telegram_funding_session_id, generation),
  unique (
    telegram_funding_session_id,
    generation,
    buy_return_revision,
    trade_intent_id
  ),
  constraint telegram_funding_buy_generations_parent_shape_check check (
    (generation = 1 and parent_generation is null)
    or (generation > 1 and parent_generation = generation - 1)
  ),
  constraint telegram_funding_buy_generations_parent_fk foreign key (
    telegram_funding_session_id, parent_generation
  ) references telegram_funding_buy_resume_generations (
    telegram_funding_session_id, generation
  ) on delete cascade deferrable initially immediate,
  constraint telegram_funding_buy_generations_return_fk foreign key (
    telegram_funding_session_id, buy_return_revision
  ) references telegram_funding_buy_return_revisions (
    telegram_funding_session_id, revision
  ) on delete cascade,
  constraint telegram_funding_buy_generations_continuation_fk foreign key (
    continuation_id,
    telegram_funding_session_id,
    buy_return_revision,
    ready_progress_revision
  ) references telegram_funding_buy_continuations (
    id,
    telegram_funding_session_id,
    buy_return_revision,
    ready_progress_revision
  ) on delete cascade,
  constraint telegram_funding_buy_generations_identity_check check (
    length(trim(idempotency_key)) between 8 and 192
    and length(trim(request_fingerprint)) between 8 and 192
  )
);

create index telegram_funding_buy_generations_session_desc_idx
  on telegram_funding_buy_resume_generations (
    telegram_funding_session_id, generation desc
  );

alter table telegram_funding_mutations
  add column buy_return_revision integer,
  add column resume_generation integer,
  add column resume_intent_id uuid references telegram_trade_intents(id) on delete restrict,
  add column continuation_id uuid references telegram_funding_buy_continuations(id) on delete restrict;

alter table telegram_funding_mutations
  add constraint telegram_funding_mutations_buy_return_fk foreign key (
    funding_context_id, buy_return_revision
  ) references telegram_funding_buy_return_revisions (
    telegram_funding_session_id, revision
  ) on delete no action deferrable initially immediate,
  add constraint telegram_funding_mutations_resume_generation_fk foreign key (
    funding_context_id,
    resume_generation,
    buy_return_revision,
    resume_intent_id
  ) references telegram_funding_buy_resume_generations (
    telegram_funding_session_id,
    generation,
    buy_return_revision,
    trade_intent_id
  ) on delete no action deferrable initially immediate,
  add constraint telegram_funding_mutations_resume_continuation_fk foreign key (
    continuation_id,
    funding_context_id,
    buy_return_revision
  ) references telegram_funding_buy_continuations (
    id,
    telegram_funding_session_id,
    buy_return_revision
  ) on delete no action deferrable initially immediate;

alter table telegram_funding_mutations
  drop constraint telegram_funding_mutations_action_check,
  drop constraint telegram_funding_mutations_action_shape_check;

alter table telegram_funding_mutations
  add constraint telegram_funding_mutations_action_check check (
    action in ('open', 'select_target', 'cancel', 'set_buy_return', 'resume_buy')
  ),
  add constraint telegram_funding_mutations_action_shape_check check (
    (action = 'select_target' and consent_revision is not null
      and buy_return_revision is null and resume_generation is null
      and resume_intent_id is null and continuation_id is null)
    or (action = 'set_buy_return' and consent_revision is null
      and buy_return_revision is not null and resume_generation is null
      and resume_intent_id is null and continuation_id is null)
    or (action = 'resume_buy' and consent_revision is null
      and buy_return_revision is not null and resume_generation is not null
      and resume_intent_id is not null and continuation_id is not null)
    or (action in ('open', 'cancel') and consent_revision is null
      and buy_return_revision is null and resume_generation is null
      and resume_intent_id is null and continuation_id is null)
  );

create or replace function guard_telegram_funding_buy_evidence()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE'
    and tg_table_name = 'telegram_funding_buy_continuations'
    and to_jsonb(old) -> 'telegram_account_id' <> 'null'::jsonb
    and to_jsonb(new) -> 'telegram_account_id' = 'null'::jsonb
    and (to_jsonb(new) - 'telegram_account_id') =
      (to_jsonb(old) - 'telegram_account_id')
  then
    return new;
  end if;
  if tg_op = 'DELETE'
    and current_setting('hunch.telegram_funding_retention_cleanup', true) = 'on'
  then
    return old;
  end if;
  raise exception 'telegram funding Buy continuation evidence is append-only';
end;
$$;

create trigger telegram_funding_buy_returns_evidence_guard
before update or delete on telegram_funding_buy_return_revisions
for each row execute function guard_telegram_funding_buy_evidence();
create trigger telegram_funding_buy_continuations_evidence_guard
before update or delete on telegram_funding_buy_continuations
for each row execute function guard_telegram_funding_buy_evidence();
create trigger telegram_funding_buy_generations_evidence_guard
before update or delete on telegram_funding_buy_resume_generations
for each row execute function guard_telegram_funding_buy_evidence();

-- A terminal card delivered to an old Telegram account-link generation is not
-- a delivery to a subsequently relinked account. Rearm one replacement for the
-- new link even when the financial terminal revision itself did not change.
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
        or (
          context.latest_terminal_revision is not null
          and not exists (
            select 1
            from telegram_bot_action_outbox delivered
            where delivered.funding_session_id = context.id
              and delivered.state_revision = context.latest_terminal_revision
              and delivered.telegram_account_id = target_telegram_account_id
              and delivered.action in (
                'funding_send',
                'funding_edit',
                'funding_replacement'
              )
              and delivered.status = 'sent'
          )
        )
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
