-- Generic token-first Add Funds can replay an already-created exact receive
-- session after the short-lived catalogue token expires. A session may be
-- reached through more than one caller idempotency key, so this mapping is
-- deliberately separate from funding_receive_sessions.

create table funding_receive_open_idempotency (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  owner_channel text not null check (owner_channel in ('web', 'telegram')),
  idempotency_key text not null,
  request_fingerprint text not null,
  receive_session_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_receive_open_idempotency_key_check
    check (length(trim(idempotency_key)) between 8 and 256),
  constraint funding_receive_open_idempotency_fingerprint_check
    check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint funding_receive_open_idempotency_session_owner_fkey
    foreign key (user_id, receive_session_id, owner_channel)
    references funding_receive_sessions (user_id, id, owner_channel)
    on delete restrict,
  constraint funding_receive_open_idempotency_unique
    unique (user_id, owner_channel, idempotency_key)
);

create index funding_receive_open_idempotency_session_idx
  on funding_receive_open_idempotency (user_id, receive_session_id, owner_channel);
