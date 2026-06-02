create table if not exists solana_sponsorship_ledger (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid references users(id) on delete set null,
  venue text not null,
  flow text not null,
  status text not null default 'created',
  intent_id text,
  wallet_address text,
  sponsor_address text,
  market_id text,
  input_mint text,
  output_mint text,
  amount_raw text,
  message_digest text,
  transaction_digest text,
  tx_signature text,
  estimated_sponsor_lamports numeric(38, 0) not null default 0,
  actual_sponsor_lamports numeric(38, 0),
  rent_lamports numeric(38, 0),
  rent_status text not null default 'unknown',
  error text,
  metadata jsonb not null default '{}'::jsonb,
  constraint solana_sponsorship_ledger_venue_check
    check (venue in ('kalshi', 'bridge', 'wallet')),
  constraint solana_sponsorship_ledger_flow_check
    check (flow in ('dflow', 'across', 'directTransfer', 'debridge')),
  constraint solana_sponsorship_ledger_status_check
    check (status in (
      'created',
      'intent_created',
      'user_signed',
      'failed',
      'submitted',
      'confirmed'
    )),
  constraint solana_sponsorship_ledger_rent_status_check
    check (rent_status in ('unknown', 'locked', 'returned', 'lost')),
  constraint solana_sponsorship_ledger_estimated_nonnegative_check
    check (estimated_sponsor_lamports >= 0),
  constraint solana_sponsorship_ledger_actual_nonnegative_check
    check (actual_sponsor_lamports is null or actual_sponsor_lamports >= 0),
  constraint solana_sponsorship_ledger_rent_nonnegative_check
    check (rent_lamports is null or rent_lamports >= 0)
);

create unique index if not exists idx_solana_sponsorship_ledger_intent
  on solana_sponsorship_ledger (intent_id)
  where intent_id is not null;

create index if not exists idx_solana_sponsorship_ledger_user_created
  on solana_sponsorship_ledger (user_id, created_at desc);

create index if not exists idx_solana_sponsorship_ledger_status
  on solana_sponsorship_ledger (status, updated_at);

create index if not exists idx_solana_sponsorship_ledger_wallet_flow_created
  on solana_sponsorship_ledger (wallet_address, flow, created_at desc)
  where wallet_address is not null;

create index if not exists idx_solana_sponsorship_ledger_tx_signature
  on solana_sponsorship_ledger (tx_signature)
  where tx_signature is not null;

do $$
begin
  alter table solana_sponsorship_ledger
    drop constraint if exists solana_sponsorship_ledger_venue_check;
  alter table solana_sponsorship_ledger
    add constraint solana_sponsorship_ledger_venue_check
    check (venue in ('kalshi', 'bridge', 'wallet'));

  alter table solana_sponsorship_ledger
    drop constraint if exists solana_sponsorship_ledger_flow_check;
  alter table solana_sponsorship_ledger
    add constraint solana_sponsorship_ledger_flow_check
    check (flow in ('dflow', 'across', 'directTransfer', 'debridge'));

  if not exists (
    select 1 from pg_constraint
    where conname = 'solana_sponsorship_ledger_status_check'
  ) then
    alter table solana_sponsorship_ledger
      add constraint solana_sponsorship_ledger_status_check
      check (status in (
        'created',
        'intent_created',
        'user_signed',
        'failed',
        'submitted',
        'confirmed'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'solana_sponsorship_ledger_rent_status_check'
  ) then
    alter table solana_sponsorship_ledger
      add constraint solana_sponsorship_ledger_rent_status_check
      check (rent_status in ('unknown', 'locked', 'returned', 'lost'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'solana_sponsorship_ledger_estimated_nonnegative_check'
  ) then
    alter table solana_sponsorship_ledger
      add constraint solana_sponsorship_ledger_estimated_nonnegative_check
      check (estimated_sponsor_lamports >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'solana_sponsorship_ledger_actual_nonnegative_check'
  ) then
    alter table solana_sponsorship_ledger
      add constraint solana_sponsorship_ledger_actual_nonnegative_check
      check (
        actual_sponsor_lamports is null
        or actual_sponsor_lamports >= 0
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'solana_sponsorship_ledger_rent_nonnegative_check'
  ) then
    alter table solana_sponsorship_ledger
      add constraint solana_sponsorship_ledger_rent_nonnegative_check
      check (rent_lamports is null or rent_lamports >= 0);
  end if;
end $$;
