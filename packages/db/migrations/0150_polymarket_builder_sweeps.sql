create table if not exists polymarket_builder_sweeps (
  id uuid primary key default gen_random_uuid(),
  builder_address text not null,
  owner_address text not null,
  destination_address text not null,
  token_address text not null,
  token_symbol text not null default 'pUSD',
  amount_raw text not null check (amount_raw ~ '^[0-9]+$'),
  amount numeric not null check (amount >= 0),
  pre_builder_balance_raw text check (pre_builder_balance_raw is null or pre_builder_balance_raw ~ '^[0-9]+$'),
  post_builder_balance_raw text check (post_builder_balance_raw is null or post_builder_balance_raw ~ '^[0-9]+$'),
  pre_hot_balance_raw text check (pre_hot_balance_raw is null or pre_hot_balance_raw ~ '^[0-9]+$'),
  post_hot_balance_raw text check (post_hot_balance_raw is null or post_hot_balance_raw ~ '^[0-9]+$'),
  relayer_transaction_id text,
  tx_hash text,
  state text not null check (
    state in (
      'preparing',
      'submitted',
      'broadcast',
      'confirmed',
      'failed',
      'skipped'
    )
  ),
  relayer_state text,
  error text,
  submitted_at timestamptz,
  broadcast_at timestamptz,
  confirmed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_polymarket_builder_sweeps_inflight
  on polymarket_builder_sweeps (
    lower(builder_address),
    lower(token_address),
    lower(destination_address)
  )
  where state in ('preparing', 'submitted', 'broadcast');

create index if not exists idx_polymarket_builder_sweeps_state_created
  on polymarket_builder_sweeps(state, created_at desc, id desc);

create index if not exists idx_polymarket_builder_sweeps_builder_token_created
  on polymarket_builder_sweeps(lower(builder_address), lower(token_address), created_at desc, id desc);

create index if not exists idx_polymarket_builder_sweeps_relayer_transaction
  on polymarket_builder_sweeps(relayer_transaction_id)
  where relayer_transaction_id is not null;

create index if not exists idx_polymarket_builder_sweeps_tx_hash
  on polymarket_builder_sweeps(tx_hash)
  where tx_hash is not null;

do $$
begin
  if to_regprocedure('public.update_updated_at_column()') is not null then
    drop trigger if exists update_polymarket_builder_sweeps_updated_at
      on polymarket_builder_sweeps;

    create trigger update_polymarket_builder_sweeps_updated_at
    before update on polymarket_builder_sweeps
    for each row execute function update_updated_at_column();
  end if;
end $$;
