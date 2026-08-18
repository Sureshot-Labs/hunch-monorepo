-- Revocable API identities for non-human admin workflows.

create or replace function admin_service_text_array_unique(values_to_check text[])
returns boolean
language sql
immutable
strict
as $$
  select cardinality(values_to_check) = (
    select count(distinct value)
    from unnest(values_to_check) as value
  )
$$;

create table admin_service_principals (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  display_name text not null,
  status text not null default 'active'
    constraint admin_service_principals_status_check
    check (status in ('active', 'disabled')),
  created_by_admin_id uuid references admin_accounts(id) on delete set null,
  disabled_by_admin_id uuid references admin_accounts(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  constraint admin_service_principals_key_check
    check (
      char_length(key) between 3 and 80
      and key ~ '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$'
    ),
  constraint admin_service_principals_display_name_check
    check (char_length(display_name) between 1 and 160),
  constraint admin_service_principals_metadata_check
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384),
  constraint admin_service_principals_disabled_check
    check (
      (status = 'active' and disabled_at is null and disabled_by_admin_id is null)
      or (status = 'disabled' and disabled_at is not null)
    )
);

create trigger admin_service_principals_set_updated_at
  before update on admin_service_principals
  for each row execute function update_updated_at_column();

create table admin_service_credentials (
  id uuid primary key,
  service_principal_id uuid not null
    references admin_service_principals(id) on delete restrict,
  token_hmac text not null unique,
  token_prefix text not null,
  token_last_four text not null,
  permissions text[] not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_by_admin_id uuid references admin_accounts(id) on delete set null,
  revoked_by_admin_id uuid references admin_accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  created_note text not null,
  revoked_reason text,
  constraint admin_service_credentials_token_hmac_check
    check (token_hmac ~ '^[a-f0-9]{64}$'),
  constraint admin_service_credentials_token_prefix_check
    check (char_length(token_prefix) between 8 and 32),
  constraint admin_service_credentials_token_last_four_check
    check (char_length(token_last_four) = 4),
  constraint admin_service_credentials_permissions_check
    check (
      cardinality(permissions) between 1 and 3
      and permissions <@ array[
        'content:read',
        'content:write',
        'content:publish'
      ]::text[]
      and admin_service_text_array_unique(permissions)
    ),
  constraint admin_service_credentials_expiry_check
    check (expires_at > created_at),
  constraint admin_service_credentials_created_note_check
    check (char_length(created_note) between 1 and 500),
  constraint admin_service_credentials_revocation_check
    check (
      (revoked_at is null and revoked_by_admin_id is null and revoked_reason is null)
      or (
        revoked_at is not null
        and revoked_reason is not null
        and char_length(revoked_reason) between 1 and 500
      )
    )
);

create index idx_admin_service_credentials_principal_created
  on admin_service_credentials (service_principal_id, created_at desc, id desc);
