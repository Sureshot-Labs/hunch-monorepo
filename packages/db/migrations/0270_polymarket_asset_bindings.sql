-- Current token maps are replaceable projections. These bindings retain the
-- asset's original ledger and condition when Gamma changes market generation.
-- Additive DDL only: no assertions/backfill against optional historical JSON.
create table polymarket_asset_bindings (
  chain_id integer not null,
  position_contract text not null,
  asset_id text not null,
  market_id text not null,
  protocol_version text not null,
  asset_kind text not null,
  condition_id text not null,
  outcome_index smallint not null,
  neg_risk boolean not null,
  exchange_address text not null,
  order_domain_version text not null,
  conditional_asset_type text not null,
  created_at timestamptz not null default now(),
  primary key (chain_id, position_contract, asset_id),
  check (chain_id = 137),
  check (position_contract ~ '^0x[0-9a-f]{40}$'),
  check (exchange_address ~ '^0x[0-9a-f]{40}$'),
  check (asset_id ~ '^(0|[1-9][0-9]{0,77})$'),
  check (condition_id ~ '^0x[0-9a-f]{64}$'),
  check (outcome_index in (0, 1)),
  check (protocol_version in ('v1', 'v2')),
  check (asset_kind in ('ctf', 'position_manager')),
  check (order_domain_version in ('2', '3')),
  check (conditional_asset_type in ('CONDITIONAL', 'CONDITIONAL-V2'))
);

create index polymarket_asset_bindings_market_idx
  on polymarket_asset_bindings (market_id);
create index polymarket_asset_bindings_asset_idx
  on polymarket_asset_bindings (asset_id);
