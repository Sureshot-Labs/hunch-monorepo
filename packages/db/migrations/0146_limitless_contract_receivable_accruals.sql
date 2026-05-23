alter table limitless_contract_fee_receivables
add column if not exists accrual_id uuid references venue_fee_accruals(id);

create index if not exists idx_limitless_contract_fee_receivables_accrual
  on limitless_contract_fee_receivables(accrual_id)
  where accrual_id is not null;

with candidates as (
  select
    r.id,
    r.user_id,
    r.wallet_address,
    r.signer_address,
    r.chain_id,
    r.order_id,
    r.order_hash,
    r.venue_order_id,
    r.tx_hash,
    r.log_index,
    r.token_id,
    r.side,
    r.role,
    r.fee_rate_bps,
    r.resolved_usdc_amount_raw,
    coalesce(r.resolved_usdc_amount, (r.resolved_usdc_amount_raw::numeric / 1000000)) as resolved_usdc_amount,
    r.filled_at,
    coalesce(r.resolved_at, r.last_resolution_checked_at, now()) as chain_verified_at
  from limitless_contract_fee_receivables r
  where r.status = 'converted_to_fee_event'
    and r.accrual_id is null
    and r.resolved_usdc_amount_raw ~ '^[0-9]+$'
    and r.resolved_usdc_amount_raw::numeric > 0
),
upserted as (
  insert into venue_fee_accruals (
    user_id,
    wallet_address,
    signer_address,
    venue,
    fee_program,
    chain_id,
    order_id,
    order_hash,
    venue_order_id,
    venue_fill_id,
    venue_trade_id,
    tx_hash,
    log_index,
    token_id,
    side,
    role,
    attribution_code,
    fee_rate_bps,
    fee_basis,
    notional_amount,
    notional_amount_raw,
    fee_amount,
    fee_amount_raw,
    fee_asset,
    filled_at,
    chain_verified_at,
    status,
    created_at,
    updated_at
  )
  select
    user_id,
    wallet_address,
    signer_address,
    'limitless',
    'venue_share_contract',
    chain_id,
    order_id,
    order_hash,
    venue_order_id,
    log_index::text,
    null,
    tx_hash,
    log_index,
    token_id,
    side,
    role,
    null,
    fee_rate_bps,
    'venue_fee_share',
    resolved_usdc_amount,
    resolved_usdc_amount_raw,
    resolved_usdc_amount,
    resolved_usdc_amount_raw,
    'USDC',
    filled_at,
    chain_verified_at,
    'verified',
    now(),
    now()
  from candidates
  on conflict (venue, fee_program, order_id, venue_fill_id)
  do update set
    tx_hash = coalesce(excluded.tx_hash, venue_fee_accruals.tx_hash),
    log_index = coalesce(excluded.log_index, venue_fee_accruals.log_index),
    token_id = excluded.token_id,
    fee_rate_bps = excluded.fee_rate_bps,
    fee_basis = excluded.fee_basis,
    notional_amount = excluded.notional_amount,
    notional_amount_raw = excluded.notional_amount_raw,
    fee_amount = excluded.fee_amount,
    fee_amount_raw = excluded.fee_amount_raw,
    fee_asset = excluded.fee_asset,
    filled_at = excluded.filled_at,
    chain_verified_at = coalesce(venue_fee_accruals.chain_verified_at, excluded.chain_verified_at),
    status = case
      when venue_fee_accruals.status = 'accrued' then 'verified'
      else venue_fee_accruals.status
    end,
    updated_at = now()
  where venue_fee_accruals.status in ('accrued', 'verified')
  returning id, order_id, venue_fill_id
),
matched as (
  select distinct on (receivable_id) receivable_id, accrual_id
  from (
    select r.id as receivable_id, u.id as accrual_id
    from candidates r
    join upserted u
      on u.order_id = r.order_id
     and u.venue_fill_id = r.log_index::text
    union all
    select r.id as receivable_id, a.id as accrual_id
    from candidates r
    join venue_fee_accruals a
      on a.venue = 'limitless'
     and a.fee_program = 'venue_share_contract'
     and a.order_id = r.order_id
     and a.venue_fill_id = r.log_index::text
     and a.status in ('accrued', 'verified', 'collected')
  ) links
  order by receivable_id
),
updated as (
  update limitless_contract_fee_receivables r
  set accrual_id = matched.accrual_id,
      status = 'resolved_payable',
      updated_at = now()
  from matched
  where r.id = matched.receivable_id
    and r.accrual_id is null
  returning r.id
)
select count(*) from updated;
