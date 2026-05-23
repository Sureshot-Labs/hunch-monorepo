create table if not exists limitless_contract_fee_receivables (
  id uuid primary key default gen_random_uuid(),
  venue text not null default 'limitless',
  fee_program text not null default 'venue_share',
  chain_id text not null default '8453',
  user_id uuid not null references users(id) on delete cascade,
  wallet_address text,
  signer_address text,
  order_id uuid not null references orders(id) on delete cascade,
  order_hash text not null,
  venue_order_id text,
  tx_hash text not null,
  log_index integer not null,
  fee_charged_log_index integer,
  fee_refunded_log_index integer,
  fee_receiver_address text,
  market_id text,
  event_id text,
  condition_id text,
  raw_token_id text not null,
  token_id text not null,
  outcome_side text check (outcome_side in ('YES', 'NO')),
  side text not null check (side in ('BUY', 'SELL')),
  role text not null check (role in ('maker', 'taker')),
  fee_rate_bps integer not null check (fee_rate_bps >= 0 and fee_rate_bps <= 10000),
  gross_token_amount_raw text not null check (gross_token_amount_raw ~ '^[0-9]+$'),
  receivable_token_amount_raw text not null check (receivable_token_amount_raw ~ '^[0-9]+$'),
  resolved_outcome text check (resolved_outcome in ('YES', 'NO')),
  resolution_source text,
  resolved_usdc_amount_raw text check (resolved_usdc_amount_raw is null or resolved_usdc_amount_raw ~ '^[0-9]+$'),
  resolved_usdc_amount numeric,
  fee_event_id uuid references fee_events(id),
  status text not null default 'pending_resolution' check (
    status in (
      'pending_resolution',
      'resolved_payable',
      'converted_to_fee_event',
      'settled_zero',
      'refunded',
      'failed'
    )
  ),
  next_resolution_check_at timestamptz,
  last_resolution_checked_at timestamptz,
  resolution_attempts integer not null default 0 check (resolution_attempts >= 0),
  resolution_error text,
  filled_at timestamptz not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (venue, fee_program, tx_hash, log_index, token_id)
);

create index if not exists idx_limitless_contract_fee_receivables_status_next
  on limitless_contract_fee_receivables(status, next_resolution_check_at, id)
  where status in ('pending_resolution', 'resolved_payable');

create index if not exists idx_limitless_contract_fee_receivables_order
  on limitless_contract_fee_receivables(order_id);

create index if not exists idx_limitless_contract_fee_receivables_tx
  on limitless_contract_fee_receivables(tx_hash, log_index);

create index if not exists idx_limitless_contract_fee_receivables_fee_event
  on limitless_contract_fee_receivables(fee_event_id)
  where fee_event_id is not null;

create index if not exists idx_limitless_contract_fee_receivables_token
  on limitless_contract_fee_receivables(token_id);

create index if not exists idx_limitless_contract_fee_receivables_market
  on limitless_contract_fee_receivables(market_id)
  where market_id is not null;

create index if not exists idx_limitless_contract_fee_receivables_wallet_recent
  on limitless_contract_fee_receivables(lower(wallet_address), filled_at desc, id desc)
  where wallet_address is not null;

create or replace function update_limitless_contract_fee_receivables_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_limitless_contract_fee_receivables_updated_at
  on limitless_contract_fee_receivables;

create trigger trg_limitless_contract_fee_receivables_updated_at
before update on limitless_contract_fee_receivables
for each row execute function update_limitless_contract_fee_receivables_updated_at();
