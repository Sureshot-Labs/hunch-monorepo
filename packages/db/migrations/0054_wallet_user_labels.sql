create table if not exists wallet_user_labels (
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, wallet_id)
);

create index if not exists wallet_user_labels_wallet_id_idx
  on wallet_user_labels (wallet_id);
