-- Persistent service-request idempotency with crash-recoverable processing leases.

create table content_machine_idempotency_keys (
  id bigserial primary key,
  service_principal_id uuid not null
    references admin_service_principals(id) on delete restrict,
  operation text not null,
  idempotency_key text not null,
  request_hash text not null,
  state text not null default 'processing',
  lease_expires_at timestamptz,
  lease_owner text,
  attempt_count integer not null default 1,
  resource_type text,
  resource_id uuid,
  http_status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  constraint content_machine_idempotency_operation_check
    check (operation in ('create_article', 'create_asset_upload')),
  constraint content_machine_idempotency_key_check
    check (
      char_length(idempotency_key) between 8 and 128
      and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    ),
  constraint content_machine_idempotency_request_hash_check
    check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint content_machine_idempotency_state_check
    check (state in ('processing', 'completed', 'failed')),
  constraint content_machine_idempotency_attempt_count_check
    check (attempt_count > 0),
  constraint content_machine_idempotency_resource_type_check
    check (resource_type is null or resource_type in ('article', 'asset')),
  constraint content_machine_idempotency_http_status_check
    check (http_status is null or http_status between 200 and 499),
  constraint content_machine_idempotency_response_check
    check (
      response is null
      or (
        jsonb_typeof(response) = 'object'
        and pg_column_size(response) <= 8192
      )
    ),
  constraint content_machine_idempotency_lease_check
    check (
      (state = 'processing' and lease_expires_at is not null and lease_owner is not null)
      or (state <> 'processing' and lease_expires_at is null and lease_owner is null)
    ),
  constraint content_machine_idempotency_result_check
    check (
      (state = 'completed' and resource_type is not null and resource_id is not null and http_status is not null)
      or state <> 'completed'
    ),
  constraint content_machine_idempotency_expiry_check
    check (expires_at > created_at),
  unique (service_principal_id, operation, idempotency_key)
);

create index idx_content_machine_idempotency_expiry
  on content_machine_idempotency_keys (expires_at, id);

create index idx_content_machine_idempotency_processing_lease
  on content_machine_idempotency_keys (lease_expires_at, id)
  where state = 'processing';

create trigger content_machine_idempotency_set_updated_at
  before update on content_machine_idempotency_keys
  for each row execute function content_set_updated_at();
