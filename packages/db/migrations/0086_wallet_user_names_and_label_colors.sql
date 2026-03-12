create table if not exists wallet_user_names (
  user_id uuid not null references users(id) on delete cascade,
  wallet_id uuid not null references wallets(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, wallet_id),
  check (btrim(name) <> '')
);

create index if not exists wallet_user_names_wallet_id_idx
  on wallet_user_names (wallet_id);

alter table wallet_user_labels
  add column if not exists color text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'wallet_user_labels_color_check'
  ) then
    alter table wallet_user_labels
      add constraint wallet_user_labels_color_check
      check (color is null or color in ('orange', 'cyan', 'green', 'gold', 'pink'));
  end if;
end $$;
