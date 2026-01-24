create table if not exists wallet_profiles (
  wallet_id uuid primary key references wallets(id) on delete cascade,
  profile jsonb not null,
  features_hash text not null,
  model text not null,
  version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists wallet_profiles_updated_at_idx
  on wallet_profiles (updated_at desc);
