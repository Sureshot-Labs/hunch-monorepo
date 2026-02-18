-- Runtime policy overrides (effective-dated JSON payloads).

create table if not exists runtime_policies (
  id uuid primary key default gen_random_uuid(),
  policy_key text not null,
  effective_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (policy_key, effective_at)
);

create index if not exists idx_runtime_policies_key_effective
  on runtime_policies(policy_key, effective_at desc, created_at desc);

