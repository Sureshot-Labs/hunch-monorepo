-- Persist the Privy wallet classification reconciled during authentication.
-- WP6 preparation must not guess embedded/external authority from an address,
-- balance, or venue credential and must not require a fresh Privy API call for
-- every read-only readiness inspection.

alter table user_wallets
  add column privy_wallet_id text,
  add column wallet_source text not null default 'unknown',
  add column is_internal_wallet boolean not null default false,
  add column privy_profile_updated_at timestamptz;

alter table user_wallets
  add constraint user_wallets_wallet_source_check
  check (wallet_source in ('embedded', 'smart', 'external', 'unknown')),
  add constraint user_wallets_internal_source_check
  check (
    not is_internal_wallet
    or wallet_source in ('embedded', 'smart')
  ),
  add constraint user_wallets_privy_profile_time_check
  check (
    (wallet_source = 'unknown' and privy_profile_updated_at is null)
    or (wallet_source <> 'unknown' and privy_profile_updated_at is not null)
  );

create unique index user_wallets_privy_wallet_id_unique
  on user_wallets (privy_wallet_id)
  where privy_wallet_id is not null;

create index user_wallets_internal_execution_idx
  on user_wallets (user_id, wallet_type, updated_at desc)
  where is_verified = true and is_internal_wallet = true;
