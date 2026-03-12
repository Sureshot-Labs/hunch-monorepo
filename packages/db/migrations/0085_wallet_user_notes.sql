create table if not exists wallet_user_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  note text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (btrim(note) <> '')
);

create index if not exists wallet_user_notes_user_wallet_created_idx
  on wallet_user_notes (user_id, wallet_id, created_at desc);

create index if not exists wallet_user_notes_wallet_id_idx
  on wallet_user_notes (wallet_id);
