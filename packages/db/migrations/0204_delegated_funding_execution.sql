-- Durable authority for server-executed funding actions.
--
-- Amount limits intentionally do not live on closed-destination transforms:
-- the exact action shape and destination are the security boundary. Routed
-- value movement profiles may add their own bounded authority in later slices.

create table telegram_funding_authorizations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  telegram_account_id uuid
    references user_telegram_accounts(id) on delete set null,
  telegram_user_id text not null,
  user_wallet_id uuid not null references user_wallets(id) on delete restrict,
  privy_wallet_id text not null,
  wallet_address text not null,
  wallet_chain text not null check (wallet_chain = 'ethereum'),
  profile_id text not null,
  security_class text not null check (
    security_class in (
      'closed_destination_transform',
      'routed_value_movement',
      'venue_execution'
    )
  ),
  signer_id text not null,
  signer_fingerprint text not null,
  policy_id text not null,
  policy_fingerprint text not null,
  venue_id text not null,
  destination_option_id text not null,
  venue_binding_option_id text not null,
  source_network_id text not null,
  source_asset_id text not null,
  source_asset_decimals integer not null check (
    source_asset_decimals between 0 and 36
  ),
  destination_network_id text not null,
  destination_asset_id text not null,
  destination_asset_decimals integer not null check (
    destination_asset_decimals between 0 and 36
  ),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_funding_authorizations_identity_check check (
    length(trim(telegram_user_id)) between 1 and 64
    and length(trim(privy_wallet_id)) between 3 and 192
    and wallet_address ~ '^0x[0-9a-fA-F]{40}$'
    and length(trim(profile_id)) between 3 and 120
    and length(trim(signer_id)) between 3 and 192
    and length(trim(signer_fingerprint)) between 32 and 192
    and length(trim(policy_id)) between 3 and 192
    and length(trim(policy_fingerprint)) between 32 and 192
    and length(trim(venue_id)) between 1 and 64
    and length(trim(destination_option_id)) between 8 and 192
    and length(trim(venue_binding_option_id)) between 8 and 192
    and length(trim(source_network_id)) between 2 and 96
    and length(trim(source_asset_id)) between 1 and 192
    and length(trim(destination_network_id)) between 2 and 96
    and length(trim(destination_asset_id)) between 1 and 192
  ),
  constraint telegram_funding_authorizations_time_check check (
    (expires_at is null or expires_at > granted_at)
    and (revoked_at is null or revoked_at >= granted_at)
  )
);

create unique index telegram_funding_authorizations_active_profile_idx
  on telegram_funding_authorizations (
    user_id,
    profile_id,
    venue_binding_option_id
  )
  where revoked_at is null;

create index telegram_funding_authorizations_account_idx
  on telegram_funding_authorizations (telegram_account_id, granted_at desc)
  where telegram_account_id is not null;

create index telegram_funding_authorizations_wallet_idx
  on telegram_funding_authorizations (user_wallet_id, granted_at desc);

create or replace function guard_telegram_funding_authorization_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting(
      'hunch.telegram_funding_retention_cleanup',
      true
    ) is distinct from 'on' then
      raise exception 'telegram funding authorizations are retained evidence'
        using errcode = '23514';
    end if;
    return old;
  end if;
  if (
    new.id,
    new.user_id,
    new.telegram_user_id,
    new.user_wallet_id,
    new.privy_wallet_id,
    lower(new.wallet_address),
    new.wallet_chain,
    new.profile_id,
    new.security_class,
    new.signer_id,
    new.signer_fingerprint,
    new.policy_id,
    new.policy_fingerprint,
    new.venue_id,
    new.destination_option_id,
    new.venue_binding_option_id,
    new.source_network_id,
    lower(new.source_asset_id),
    new.source_asset_decimals,
    new.destination_network_id,
    lower(new.destination_asset_id),
    new.destination_asset_decimals,
    new.granted_at,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.id,
    old.user_id,
    old.telegram_user_id,
    old.user_wallet_id,
    old.privy_wallet_id,
    lower(old.wallet_address),
    old.wallet_chain,
    old.profile_id,
    old.security_class,
    old.signer_id,
    old.signer_fingerprint,
    old.policy_id,
    old.policy_fingerprint,
    old.venue_id,
    old.destination_option_id,
    old.venue_binding_option_id,
    old.source_network_id,
    lower(old.source_asset_id),
    old.source_asset_decimals,
    old.destination_network_id,
    lower(old.destination_asset_id),
    old.destination_asset_decimals,
    old.granted_at,
    old.expires_at,
    old.created_at
  ) then
    raise exception 'telegram funding authorization identity is immutable'
      using errcode = '23514';
  end if;
  if new.telegram_account_id is distinct from old.telegram_account_id
     and not (
       old.telegram_account_id is not null
       and new.telegram_account_id is null
     ) then
    raise exception 'telegram funding authorization account link is immutable'
      using errcode = '23514';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'telegram funding authorization revocation is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger telegram_funding_authorizations_guard
before update or delete on telegram_funding_authorizations
for each row execute function guard_telegram_funding_authorization_update();

-- A delegated provider reference is durable before the external call. The
-- only permitted enrichment of finished attempt evidence is resolving that
-- exact provider reference to either an EVM transaction hash or a definitive
-- provider failure. All other finished-attempt fields remain immutable.
create or replace function funding_guard_attempt_update()
returns trigger
language plpgsql
as $$
declare
  provider_reference_resolved boolean;
  provider_failure_resolved boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'funding operation attempts are append-only'
      using errcode = '23514';
  end if;
  if (
    new.step_id,
    new.attempt_number,
    new.canonical_action_fingerprint,
    new.executor_id,
    new.started_at,
    new.created_at
  ) is distinct from (
    old.step_id,
    old.attempt_number,
    old.canonical_action_fingerprint,
    old.executor_id,
    old.started_at,
    old.created_at
  ) then
    raise exception 'funding operation attempt identity is immutable'
      using errcode = '23514';
  end if;

  provider_reference_resolved :=
    old.outcome = 'ambiguous'
    and old.broadcast_may_have_occurred
    and old.reference_kind = 'provider_receipt'
    and old.receipt_ref_ciphertext is not null
    and old.receipt_ref_lookup_hmac is not null
    and old.lookup_key_version is not null
    and new.outcome = 'ambiguous'
    and new.broadcast_may_have_occurred
    and new.reference_kind = 'transaction'
    and new.receipt_ref_ciphertext is not null
    and new.receipt_ref_lookup_hmac is not null
    and new.lookup_key_version is not null
    and new.actual_costs = old.actual_costs
    and new.finished_at = old.finished_at;

  provider_failure_resolved :=
    old.outcome = 'ambiguous'
    and old.broadcast_may_have_occurred
    and old.reference_kind = 'provider_receipt'
    and old.receipt_ref_ciphertext is not null
    and old.receipt_ref_lookup_hmac is not null
    and old.lookup_key_version is not null
    and new.outcome = 'failed'
    and not new.broadcast_may_have_occurred
    and new.reference_kind is null
    and new.receipt_ref_ciphertext is null
    and new.receipt_ref_lookup_hmac is null
    and new.lookup_key_version is null
    and new.finished_at = old.finished_at;

  if provider_reference_resolved or provider_failure_resolved then
    return new;
  end if;

  if old.outcome <> 'started' and (
    new.outcome,
    new.broadcast_may_have_occurred,
    new.reference_kind,
    new.receipt_ref_lookup_hmac,
    new.lookup_key_version,
    new.actual_costs,
    new.finished_at
  ) is distinct from (
    old.outcome,
    old.broadcast_may_have_occurred,
    old.reference_kind,
    old.receipt_ref_lookup_hmac,
    old.lookup_key_version,
    old.actual_costs,
    old.finished_at
  ) then
    raise exception 'finished funding operation attempt cannot be rewritten'
      using errcode = '23514';
  end if;
  if old.outcome <> 'started'
    and new.receipt_ref_ciphertext is distinct from old.receipt_ref_ciphertext
    and new.receipt_ref_ciphertext is not null then
    raise exception 'attempt receipt ciphertext cannot be rewritten or restored'
      using errcode = '23514';
  end if;
  if old.outcome = 'started' and new.outcome = 'started' and (
    new.broadcast_may_have_occurred,
    new.reference_kind,
    new.receipt_ref_ciphertext,
    new.receipt_ref_lookup_hmac,
    new.lookup_key_version,
    new.actual_costs,
    new.finished_at
  ) is distinct from (
    old.broadcast_may_have_occurred,
    old.reference_kind,
    old.receipt_ref_ciphertext,
    old.receipt_ref_lookup_hmac,
    old.lookup_key_version,
    old.actual_costs,
    old.finished_at
  ) then
    raise exception 'started funding operation attempt cannot record terminal evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- V1 automation used a numeric cap. V2 closed-destination transforms authorize
-- the exact full receipt and therefore deliberately have no amount cap.
alter table telegram_funding_consents
  drop constraint telegram_funding_consents_automation_check;

alter table telegram_funding_consents
  add constraint telegram_funding_consents_automation_check check (
    (
      automation_enabled
      and (
        max_auto_execute_source_raw > 0
        or (
          max_auto_execute_source_raw is null
          and automation_policy_snapshot ->> 'version' = '2'
          and automation_policy_snapshot ->> 'kind' =
                'polymarket_usdce_full_receipt_wrap'
          and automation_policy_snapshot ->> 'fullReceipt' = 'true'
        )
      )
    )
    or (
      not automation_enabled
      and max_auto_execute_source_raw is null
    )
  );
