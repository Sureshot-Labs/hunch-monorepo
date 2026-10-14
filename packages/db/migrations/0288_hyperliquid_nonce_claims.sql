-- Protocol replay protection only. Execution, leases, reservations and recovery
-- stay in the existing funding tables. No legacy rows or policy are changed.
create table hyperliquid_nonce_claims (
  environment text not null check (environment in ('mainnet', 'testnet')),
  signer_address text not null check (signer_address ~ '^0x[0-9a-f]{40}$'),
  nonce bigint not null check (nonce >= 0 and nonce <= 9007199254740991),
  action_fingerprint text not null check (action_fingerprint ~ '^[0-9a-f]{64}$'),
  funding_step_id uuid not null unique
    references funding_operation_steps(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key (environment, signer_address, nonce)
);

-- Claims outlive cancellation and wallet unlink/relink. A changed action must
-- never reuse a consumed nonce, nor may an uncertain action acquire a new one.
-- This guards future mutations of this new table; it does not assert legacy data.
create function guard_hyperliquid_nonce_claim_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Hyperliquid nonce claims are immutable'
    using errcode = '23514';
end
$$;
create trigger hyperliquid_nonce_claims_immutable
before update or delete on hyperliquid_nonce_claims
for each row execute function guard_hyperliquid_nonce_claim_immutable();
