-- WP3 durable funding operations, observations, reservations, leases, and
-- user lifecycle protections.
--
-- This migration is additive for new funding data. Existing bridge_orders
-- remain the legacy ledger and receive only a deterministic adapter tag plus
-- the user-retention FK change required by the funding lifecycle contract.

create table funding_quotes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  discovery_projection_id text not null,
  selected_source_option_snapshot jsonb not null,
  market_context_snapshot jsonb,
  destination_option_snapshot jsonb not null,
  venue_binding_snapshot jsonb,
  plan_snapshot jsonb not null,
  policy_version bigint not null check (policy_version > 0),
  policy_revision text not null,
  canonical_request_hash text not null,
  plan_hash text not null,
  consent_token_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_quotes_user_id_id_unique unique (user_id, id),
  constraint funding_quotes_user_consent_unique
    unique (user_id, consent_token_hash),
  constraint funding_quotes_source_snapshot_object_check
    check (jsonb_typeof(selected_source_option_snapshot) = 'object'),
  constraint funding_quotes_market_snapshot_object_check
    check (
      market_context_snapshot is null
      or jsonb_typeof(market_context_snapshot) = 'object'
    ),
  constraint funding_quotes_destination_snapshot_object_check
    check (jsonb_typeof(destination_option_snapshot) = 'object'),
  constraint funding_quotes_binding_snapshot_object_check
    check (
      venue_binding_snapshot is null
      or jsonb_typeof(venue_binding_snapshot) = 'object'
    ),
  constraint funding_quotes_plan_snapshot_object_check
    check (jsonb_typeof(plan_snapshot) = 'object'),
  constraint funding_quotes_hashes_check
    check (
      length(canonical_request_hash) between 32 and 192
      and length(plan_hash) between 32 and 192
      and length(consent_token_hash) between 32 and 192
    ),
  constraint funding_quotes_expiry_check
    check (expires_at > created_at),
  constraint funding_quotes_consumption_check
    check (consumed_at is null or invalidated_at is null),
  constraint funding_quotes_invalidation_reason_check
    check (
      (invalidated_at is null and invalidation_reason is null)
      or (
        invalidated_at is not null
        and invalidation_reason is not null
        and length(trim(invalidation_reason)) > 0
      )
    )
);

create index funding_quotes_user_created_idx
  on funding_quotes (user_id, created_at desc);
create index funding_quotes_expiry_idx
  on funding_quotes (expires_at)
  where consumed_at is null and invalidated_at is null;

create table funding_withdrawal_destinations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  network_id text not null,
  asset_id text not null,
  asset_decimals smallint not null check (asset_decimals between 0 and 36),
  address_ciphertext text,
  address_lookup_hmac text not null,
  lookup_key_version integer not null check (lookup_key_version > 0),
  validation_evidence jsonb not null,
  policy_version bigint not null check (policy_version > 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_withdrawal_destinations_user_id_id_unique
    unique (user_id, id),
  constraint funding_withdrawal_destinations_lookup_check
    check (length(address_lookup_hmac) between 32 and 192),
  constraint funding_withdrawal_destinations_validation_object_check
    check (jsonb_typeof(validation_evidence) = 'object'),
  constraint funding_withdrawal_destinations_expiry_check
    check (expires_at > created_at),
  constraint funding_withdrawal_destinations_active_ciphertext_check
    check (revoked_at is not null or address_ciphertext is not null),
  constraint funding_withdrawal_destinations_revocation_check
    check (
      (revoked_at is null and revocation_reason is null)
      or (
        revoked_at is not null
        and revocation_reason is not null
        and length(trim(revocation_reason)) > 0
      )
    )
);

create index funding_withdrawal_destinations_user_active_idx
  on funding_withdrawal_destinations (user_id, expires_at)
  where revoked_at is null;
create unique index funding_withdrawal_destinations_active_lookup_unique
  on funding_withdrawal_destinations (
    user_id,
    network_id,
    asset_id,
    address_lookup_hmac,
    lookup_key_version
  )
  where revoked_at is null;
create index funding_withdrawal_destinations_lookup_idx
  on funding_withdrawal_destinations (
    address_lookup_hmac,
    lookup_key_version
  );

create table funding_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  quote_id uuid not null,
  purpose text not null,
  status text not null,
  progress_stage text not null,
  experience_mode text not null,
  plan_kind text not null,
  idempotency_key text not null,
  commit_request_hash text not null,
  plan_hash text not null,
  policy_version bigint not null check (policy_version > 0),
  policy_revision text not null,
  source_snapshot jsonb,
  destination_target_snapshot jsonb not null,
  external_recipient_id uuid,
  venue_id text,
  market_id text references unified_markets(id) on delete restrict,
  market_context_snapshot jsonb,
  venue_binding_snapshot jsonb,
  wallet_execution_snapshot jsonb,
  placement_snapshot jsonb not null,
  requested_source_amount jsonb,
  requested_destination_amount jsonb,
  actual_source_amount jsonb,
  actual_destination_amount jsonb,
  quote_snapshot jsonb not null,
  consent_snapshot jsonb not null,
  error_code text,
  support_metadata jsonb not null default '{}'::jsonb,
  original_subject_lookup_hmac text not null,
  subject_lookup_key_version integer not null
    check (subject_lookup_key_version > 0),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint funding_operations_user_id_id_unique unique (user_id, id),
  constraint funding_operations_quote_unique unique (quote_id),
  constraint funding_operations_user_idempotency_unique
    unique (user_id, idempotency_key),
  constraint funding_operations_quote_ownership_fk
    foreign key (user_id, quote_id)
    references funding_quotes(user_id, id)
    on delete restrict
    deferrable initially immediate,
  constraint funding_operations_recipient_ownership_fk
    foreign key (user_id, external_recipient_id)
    references funding_withdrawal_destinations(user_id, id)
    on delete restrict
    deferrable initially immediate,
  constraint funding_operations_purpose_check
    check (
      purpose in (
        'add_funds',
        'trade_shortfall',
        'convert_asset',
        'withdrawal',
        'manual_rebalance'
      )
    ),
  constraint funding_operations_state_stage_check
    check (
      (status, progress_stage) in (
        ('awaiting_user', 'committed'),
        ('awaiting_user', 'source_action'),
        ('awaiting_external_funds', 'committed'),
        ('awaiting_external_funds', 'source_action'),
        ('in_progress', 'committed'),
        ('in_progress', 'source_action'),
        ('in_progress', 'source_observed'),
        ('in_progress', 'routing'),
        ('in_progress', 'intermediate_observed'),
        ('in_progress', 'destination_observed'),
        ('in_progress', 'venue_preparation'),
        ('ready', 'ready_for_consumer'),
        ('reconcile_required', 'source_action'),
        ('reconcile_required', 'source_observed'),
        ('reconcile_required', 'routing'),
        ('reconcile_required', 'intermediate_observed'),
        ('reconcile_required', 'destination_observed'),
        ('reconcile_required', 'venue_preparation'),
        ('reconcile_required', 'ready_for_consumer'),
        ('reconcile_required', 'refunding'),
        ('recovery_required', 'source_action'),
        ('recovery_required', 'source_observed'),
        ('recovery_required', 'routing'),
        ('recovery_required', 'intermediate_observed'),
        ('recovery_required', 'destination_observed'),
        ('recovery_required', 'venue_preparation'),
        ('recovery_required', 'ready_for_consumer'),
        ('recovery_required', 'refunding'),
        ('completed', 'terminal'),
        ('refunded', 'terminal'),
        ('failed', 'terminal'),
        ('cancelled', 'terminal')
      )
    ),
  constraint funding_operations_experience_mode_check
    check (experience_mode in ('instant', 'inline', 'prepare_first')),
  constraint funding_operations_plan_kind_check
    check (
      plan_kind in (
        'wallet_route',
        'relay_deposit_address',
        'direct_external_handoff',
        'already_available',
        'venue_preparation',
        'composite_route'
      )
    ),
  constraint funding_operations_hashes_check
    check (
      length(commit_request_hash) between 32 and 192
      and length(plan_hash) between 32 and 192
      and length(original_subject_lookup_hmac) between 32 and 192
    ),
  constraint funding_operations_source_snapshot_object_check
    check (
      source_snapshot is null or jsonb_typeof(source_snapshot) = 'object'
    ),
  constraint funding_operations_destination_snapshot_object_check
    check (jsonb_typeof(destination_target_snapshot) = 'object'),
  constraint funding_operations_market_snapshot_object_check
    check (
      market_context_snapshot is null
      or jsonb_typeof(market_context_snapshot) = 'object'
    ),
  constraint funding_operations_binding_snapshot_object_check
    check (
      venue_binding_snapshot is null
      or jsonb_typeof(venue_binding_snapshot) = 'object'
    ),
  constraint funding_operations_execution_snapshot_object_check
    check (
      wallet_execution_snapshot is null
      or jsonb_typeof(wallet_execution_snapshot) = 'object'
    ),
  constraint funding_operations_placement_snapshot_object_check
    check (jsonb_typeof(placement_snapshot) = 'object'),
  constraint funding_operations_requested_source_object_check
    check (
      requested_source_amount is null
      or jsonb_typeof(requested_source_amount) = 'object'
    ),
  constraint funding_operations_requested_destination_object_check
    check (
      requested_destination_amount is null
      or jsonb_typeof(requested_destination_amount) = 'object'
    ),
  constraint funding_operations_actual_source_object_check
    check (
      actual_source_amount is null
      or jsonb_typeof(actual_source_amount) = 'object'
    ),
  constraint funding_operations_actual_destination_object_check
    check (
      actual_destination_amount is null
      or jsonb_typeof(actual_destination_amount) = 'object'
    ),
  constraint funding_operations_quote_snapshot_object_check
    check (jsonb_typeof(quote_snapshot) = 'object'),
  constraint funding_operations_consent_snapshot_object_check
    check (jsonb_typeof(consent_snapshot) = 'object'),
  constraint funding_operations_support_metadata_object_check
    check (jsonb_typeof(support_metadata) = 'object'),
  constraint funding_operations_terminal_timestamp_check
    check (
      (status in ('completed', 'refunded', 'failed', 'cancelled'))
      = (completed_at is not null)
    )
);

create index funding_operations_user_created_idx
  on funding_operations (user_id, created_at desc);
create index funding_operations_non_terminal_idx
  on funding_operations (updated_at, user_id)
  where status not in ('completed', 'refunded', 'failed', 'cancelled');
create index funding_operations_market_idx
  on funding_operations (market_id)
  where market_id is not null;

create table funding_operation_segments (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references funding_operations(id) on delete restrict,
  ordinal smallint not null check (ordinal >= 0),
  provider_id text not null,
  adapter_id text not null,
  adapter_version integer not null check (adapter_version > 0),
  segment_kind text not null,
  status text not null,
  source_snapshot jsonb not null,
  destination_target_snapshot jsonb not null,
  quoted_input jsonb not null,
  quoted_expected_output jsonb not null,
  quoted_min_output jsonb not null,
  actual_input jsonb,
  actual_output jsonb,
  provider_quote_ref_ciphertext text,
  provider_quote_ref_lookup_hmac text,
  deposit_address_ciphertext text,
  deposit_address_lookup_hmac text,
  lookup_key_version integer not null check (lookup_key_version > 0),
  refund_location_snapshot jsonb,
  quote_expires_at timestamptz not null,
  submitted_at timestamptz,
  settled_at timestamptz,
  raw_status text,
  support_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_operation_segments_operation_ordinal_unique
    unique (operation_id, ordinal),
  constraint funding_operation_segments_operation_id_id_unique
    unique (operation_id, id),
  constraint funding_operation_segments_kind_check
    check (
      segment_kind in (
        'same_network_swap',
        'cross_network_transfer',
        'cross_network_swap',
        'deposit_address'
      )
    ),
  constraint funding_operation_segments_status_check
    check (
      status in (
        'planned',
        'awaiting_source',
        'submitted',
        'settling',
        'succeeded',
        'reconcile_required',
        'recovery_required',
        'refunding',
        'refunded',
        'failed'
      )
    ),
  constraint funding_operation_segments_snapshots_check
    check (
      jsonb_typeof(source_snapshot) = 'object'
      and jsonb_typeof(destination_target_snapshot) = 'object'
      and jsonb_typeof(quoted_input) = 'object'
      and jsonb_typeof(quoted_expected_output) = 'object'
      and jsonb_typeof(quoted_min_output) = 'object'
      and (
        actual_input is null or jsonb_typeof(actual_input) = 'object'
      )
      and (
        actual_output is null or jsonb_typeof(actual_output) = 'object'
      )
      and (
        refund_location_snapshot is null
        or jsonb_typeof(refund_location_snapshot) = 'object'
      )
      and jsonb_typeof(support_metadata) = 'object'
    ),
  constraint funding_operation_segments_provider_quote_lookup_check
    check (
      (
        provider_quote_ref_ciphertext is null
        and provider_quote_ref_lookup_hmac is null
      )
      or (
        provider_quote_ref_lookup_hmac is not null
        and length(provider_quote_ref_lookup_hmac) between 32 and 192
      )
    ),
  constraint funding_operation_segments_deposit_lookup_check
    check (
      (
        deposit_address_ciphertext is null
        and deposit_address_lookup_hmac is null
      )
      or (
        deposit_address_lookup_hmac is not null
        and length(deposit_address_lookup_hmac) between 32 and 192
      )
    ),
  constraint funding_operation_segments_time_check
    check (
      (submitted_at is null or submitted_at >= created_at)
      and (settled_at is null or submitted_at is not null)
      and (settled_at is null or settled_at >= submitted_at)
    )
);

create index funding_operation_segments_provider_quote_lookup_idx
  on funding_operation_segments (
    provider_quote_ref_lookup_hmac,
    lookup_key_version
  )
  where provider_quote_ref_lookup_hmac is not null;
create index funding_operation_segments_deposit_lookup_idx
  on funding_operation_segments (
    deposit_address_lookup_hmac,
    lookup_key_version
  )
  where deposit_address_lookup_hmac is not null;
create index funding_operation_segments_reconcile_idx
  on funding_operation_segments (status, updated_at)
  where status in (
    'submitted',
    'settling',
    'reconcile_required',
    'recovery_required',
    'refunding'
  );

create table funding_provider_requests (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null
    references funding_operation_segments(id) on delete restrict,
  request_kind text not null check (request_kind in ('initial', 'child')),
  request_ref_ciphertext text,
  request_ref_lookup_hmac text not null,
  raw_status text,
  discovery_source text not null,
  lookup_key_version integer not null check (lookup_key_version > 0),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  support_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_provider_requests_segment_lookup_unique
    unique (segment_id, request_ref_lookup_hmac),
  constraint funding_provider_requests_lookup_check
    check (length(request_ref_lookup_hmac) between 32 and 192),
  constraint funding_provider_requests_time_check
    check (last_seen_at >= first_seen_at),
  constraint funding_provider_requests_support_metadata_object_check
    check (jsonb_typeof(support_metadata) = 'object')
);

create index funding_provider_requests_lookup_idx
  on funding_provider_requests (
    request_ref_lookup_hmac,
    lookup_key_version
  );

create table funding_operation_steps (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references funding_operations(id) on delete restrict,
  segment_id uuid,
  ordinal smallint not null check (ordinal >= 0),
  step_kind text not null,
  state text not null default 'planned',
  action_fingerprint text not null,
  executor_id text not null,
  payer_requirement text not null,
  depends_on_step_id uuid,
  normalized_action jsonb not null,
  action_validation_result jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_operation_steps_operation_ordinal_unique
    unique (operation_id, ordinal),
  constraint funding_operation_steps_operation_fingerprint_unique
    unique (operation_id, action_fingerprint),
  constraint funding_operation_steps_operation_id_id_unique
    unique (operation_id, id),
  constraint funding_operation_steps_segment_same_operation_fk
    foreign key (operation_id, segment_id)
    references funding_operation_segments(operation_id, id)
    on delete restrict,
  constraint funding_operation_steps_dependency_same_operation_fk
    foreign key (operation_id, depends_on_step_id)
    references funding_operation_steps(operation_id, id)
    on delete restrict,
  constraint funding_operation_steps_kind_check
    check (
      step_kind in (
        'approval',
        'transaction',
        'signature',
        'external_handoff',
        'server_action',
        'venue_preparation'
      )
    ),
  constraint funding_operation_steps_state_check
    check (
      state in (
        'planned',
        'action_required',
        'submitted',
        'succeeded',
        'reconcile_required',
        'recovery_required',
        'failed',
        'cancelled'
      )
    ),
  constraint funding_operation_steps_payer_check
    check (
      payer_requirement in (
        'none',
        'user',
        'provider',
        'privy_sponsor',
        'hunch_sponsor'
      )
    ),
  constraint funding_operation_steps_fingerprint_check
    check (length(action_fingerprint) between 32 and 192),
  constraint funding_operation_steps_action_object_check
    check (
      jsonb_typeof(normalized_action) = 'object'
      and jsonb_typeof(action_validation_result) = 'object'
    ),
  constraint funding_operation_steps_dependency_order_check
    check (depends_on_step_id is null or ordinal > 0)
);

create table funding_operation_step_attempts (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references funding_operation_steps(id) on delete restrict,
  attempt_number integer not null check (attempt_number > 0),
  canonical_action_fingerprint text not null,
  executor_id text not null,
  outcome text not null default 'started',
  broadcast_may_have_occurred boolean not null default false,
  reference_kind text,
  receipt_ref_ciphertext text,
  receipt_ref_lookup_hmac text,
  lookup_key_version integer,
  actual_costs jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_operation_step_attempts_step_number_unique
    unique (step_id, attempt_number),
  constraint funding_operation_step_attempts_step_id_id_unique
    unique (step_id, id),
  constraint funding_operation_step_attempts_outcome_check
    check (
      outcome in (
        'started',
        'submitted',
        'succeeded',
        'failed',
        'ambiguous',
        'cancelled'
      )
    ),
  constraint funding_operation_step_attempts_reference_kind_check
    check (
      reference_kind is null
      or reference_kind in (
        'transaction',
        'signature',
        'provider_receipt',
        'external_handoff'
      )
    ),
  constraint funding_operation_step_attempts_fingerprint_check
    check (length(canonical_action_fingerprint) between 32 and 192),
  constraint funding_operation_step_attempts_reference_check
    check (
      (
        reference_kind is null
        and receipt_ref_ciphertext is null
        and receipt_ref_lookup_hmac is null
        and lookup_key_version is null
      )
      or (
        reference_kind is not null
        and receipt_ref_lookup_hmac is not null
        and length(receipt_ref_lookup_hmac) between 32 and 192
        and lookup_key_version > 0
      )
    ),
  constraint funding_operation_step_attempts_broadcast_state_check
    check (
      broadcast_may_have_occurred
      = (outcome in ('submitted', 'ambiguous'))
    ),
  constraint funding_operation_step_attempts_finished_check
    check (
      (outcome = 'started' and finished_at is null)
      or (outcome <> 'started' and finished_at is not null)
    ),
  constraint funding_operation_step_attempts_actual_costs_object_check
    check (jsonb_typeof(actual_costs) = 'object')
);

create index funding_operation_step_attempts_lookup_idx
  on funding_operation_step_attempts (
    receipt_ref_lookup_hmac,
    lookup_key_version
  )
  where receipt_ref_lookup_hmac is not null;
create index funding_operation_step_attempts_ambiguous_idx
  on funding_operation_step_attempts (updated_at)
  where outcome = 'ambiguous' or broadcast_may_have_occurred;

create table funding_step_receipt_observations (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null,
  step_id uuid not null,
  attempt_id uuid not null,
  network_id text not null,
  status text not null,
  action_match boolean,
  ledger_height text,
  block_hash text,
  canonical boolean not null default true,
  failure_code text,
  evidence jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null,
  observed_at timestamptz not null,
  finalized_at timestamptz,
  reorged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_step_receipt_observations_attempt_unique
    unique (attempt_id),
  constraint funding_step_receipt_observations_step_attempt_fk
    foreign key (step_id, attempt_id)
    references funding_operation_step_attempts(step_id, id)
    on delete restrict,
  constraint funding_step_receipt_observations_operation_step_fk
    foreign key (operation_id, step_id)
    references funding_operation_steps(operation_id, id)
    on delete restrict,
  constraint funding_step_receipt_observations_status_check
    check (
      status in (
        'pending',
        'confirmed',
        'finalized',
        'failed',
        'mismatch',
        'reorged'
      )
    ),
  constraint funding_step_receipt_observations_match_check
    check (
      (status = 'mismatch' and action_match = false)
      or (
        status = 'pending'
        and (action_match is null or action_match = true)
      )
      or (status not in ('pending', 'mismatch') and action_match = true)
    ),
  constraint funding_step_receipt_observations_canonicality_check
    check (
      (status = 'reorged' and canonical = false and reorged_at is not null)
      or (status <> 'reorged' and canonical = true and reorged_at is null)
    ),
  constraint funding_step_receipt_observations_finalized_check
    check (
      (status = 'finalized' and finalized_at is not null)
      or (status <> 'finalized' and finalized_at is null)
    ),
  constraint funding_step_receipt_observations_time_check
    check (observed_at >= first_seen_at),
  constraint funding_step_receipt_observations_evidence_object_check
    check (jsonb_typeof(evidence) = 'object')
);

create index funding_step_receipt_observations_operation_status_idx
  on funding_step_receipt_observations (operation_id, status, observed_at);
create index funding_step_receipt_observations_pending_idx
  on funding_step_receipt_observations (observed_at)
  where status in ('pending', 'confirmed');

create table funding_observations (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references funding_operations(id) on delete restrict,
  segment_id uuid,
  kind text not null,
  network_id text not null,
  asset_id text not null,
  tx_hash text not null,
  event_index text not null,
  from_address text,
  to_address text not null,
  raw_amount text not null,
  observed_at timestamptz not null,
  ledger_height text,
  block_hash text,
  finality_status text not null,
  canonical boolean not null default true,
  reorged_at timestamptz,
  finalized_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_observations_segment_same_operation_fk
    foreign key (operation_id, segment_id)
    references funding_operation_segments(operation_id, id)
    on delete restrict,
  constraint funding_observations_transfer_unique
    unique (network_id, tx_hash, event_index, asset_id),
  constraint funding_observations_kind_check
    check (
      kind in (
        'source_debit',
        'source_credit',
        'intermediate_transfer',
        'destination_credit',
        'refund_credit',
        'venue_readiness'
      )
    ),
  constraint funding_observations_amount_check
    check (raw_amount ~ '^(0|[1-9][0-9]*)$'),
  constraint funding_observations_finality_check
    check (
      finality_status in ('observed', 'confirmed', 'finalized', 'reorged')
    ),
  constraint funding_observations_canonicality_check
    check (
      (
        finality_status = 'reorged'
        and canonical = false
        and reorged_at is not null
      )
      or (
        finality_status <> 'reorged'
        and canonical = true
        and reorged_at is null
      )
    ),
  constraint funding_observations_finalized_check
    check (
      finality_status not in ('finalized', 'reorged')
      or finalized_at is not null
      or finality_status = 'reorged'
    ),
  constraint funding_observations_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create index funding_observations_operation_kind_idx
  on funding_observations (operation_id, kind, observed_at);
create index funding_observations_unfinalized_idx
  on funding_observations (observed_at)
  where canonical and finality_status <> 'finalized';

create table balance_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  operation_id uuid not null,
  segment_id uuid,
  component_id text not null,
  location_id text not null,
  network_id text not null,
  asset_id text not null,
  asset_decimals smallint not null check (asset_decimals between 0 and 36),
  raw_amount text not null,
  mode text not null,
  state text not null default 'active',
  expires_at timestamptz not null,
  consumer_kind text,
  consumer_ref text,
  outcome_reason text,
  consumed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint balance_reservations_operation_ownership_fk
    foreign key (user_id, operation_id)
    references funding_operations(user_id, id)
    on delete restrict
    deferrable initially immediate,
  constraint balance_reservations_segment_same_operation_fk
    foreign key (operation_id, segment_id)
    references funding_operation_segments(operation_id, id)
    on delete restrict,
  constraint balance_reservations_operation_component_mode_unique
    unique (operation_id, component_id, mode),
  constraint balance_reservations_user_operation_id_unique
    unique (user_id, operation_id, id),
  constraint balance_reservations_amount_check
    check (raw_amount ~ '^(0|[1-9][0-9]*)$' and raw_amount <> '0'),
  constraint balance_reservations_mode_check
    check (
      mode in (
        'subtract_available',
        'advisory_destination',
        'settled_for_consumer'
      )
    ),
  constraint balance_reservations_segment_mode_check
    check (
      mode = 'subtract_available'
      or segment_id is null
    ),
  constraint balance_reservations_state_check
    check (state in ('active', 'consumed', 'released')),
  constraint balance_reservations_state_timestamp_check
    check (
      (
        state = 'active'
        and consumed_at is null
        and released_at is null
        and outcome_reason is null
      )
      or (
        state = 'consumed'
        and consumed_at is not null
        and released_at is null
        and consumer_kind is not null
        and consumer_ref is not null
        and outcome_reason is not null
      )
      or (
        state = 'released'
        and consumed_at is null
        and released_at is not null
        and outcome_reason is not null
      )
    )
);

create index balance_reservations_user_component_active_idx
  on balance_reservations (user_id, component_id)
  where state = 'active';
create index balance_reservations_expiry_active_idx
  on balance_reservations (expires_at)
  where state = 'active';
create index balance_reservations_segment_idx
  on balance_reservations (segment_id, state)
  where segment_id is not null;

create table funding_route_observations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  operation_id uuid not null,
  route_key_hmac text not null,
  route_key_version integer not null check (route_key_version > 0),
  provider_id text not null,
  adapter_version integer not null check (adapter_version > 0),
  amount_band text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  latency_stages jsonb not null default '{}'::jsonb,
  outcome text not null,
  refund_observed boolean not null default false,
  recovery_required boolean not null default false,
  policy_revision text not null,
  reason_codes text[] not null default '{}'::text[],
  support_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_route_observations_operation_ownership_fk
    foreign key (user_id, operation_id)
    references funding_operations(user_id, id)
    on delete restrict
    deferrable initially immediate,
  constraint funding_route_observations_lookup_check
    check (length(route_key_hmac) between 32 and 192),
  constraint funding_route_observations_outcome_check
    check (
      outcome in (
        'in_progress',
        'succeeded',
        'refunded',
        'failed',
        'reconcile_required',
        'recovery_required',
        'cancelled'
      )
    ),
  constraint funding_route_observations_time_check
    check (finished_at is null or finished_at >= started_at),
  constraint funding_route_observations_completion_shape_check
    check (
      (
        outcome = 'in_progress'
        and finished_at is null
      )
      or (
        outcome <> 'in_progress'
        and finished_at is not null
      )
    ),
  constraint funding_route_observations_objects_check
    check (
      jsonb_typeof(latency_stages) = 'object'
      and jsonb_typeof(support_metadata) = 'object'
    )
);

create index funding_route_observations_route_idx
  on funding_route_observations (
    route_key_hmac,
    route_key_version,
    started_at desc
  );

create table funding_reconciliation_jobs (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null
    references funding_operations(id) on delete restrict,
  status text not null default 'scheduled',
  due_at timestamptz not null,
  priority integer not null default 0,
  lease_owner text,
  lease_token uuid,
  lease_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text,
  last_error_summary text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint funding_reconciliation_jobs_operation_unique unique (operation_id),
  constraint funding_reconciliation_jobs_status_check
    check (status in ('scheduled', 'leased', 'completed', 'dead_letter')),
  constraint funding_reconciliation_jobs_lease_check
    check (
      (
        status = 'leased'
        and lease_owner is not null
        and lease_token is not null
        and lease_until is not null
        and completed_at is null
      )
      or (
        status <> 'leased'
        and lease_owner is null
        and lease_token is null
        and lease_until is null
      )
    ),
  constraint funding_reconciliation_jobs_completion_check
    check (
      (status in ('completed', 'dead_letter')) = (completed_at is not null)
    )
);

create index funding_reconciliation_jobs_claim_idx
  on funding_reconciliation_jobs (priority desc, due_at, id)
  where status = 'scheduled';
create index funding_reconciliation_jobs_expired_lease_idx
  on funding_reconciliation_jobs (lease_until, id)
  where status = 'leased';

alter table orders
  add column funding_operation_id uuid,
  add column funding_reservation_id uuid;

alter table orders
  add constraint orders_funding_link_pair_check
  check (
    (funding_operation_id is null) = (funding_reservation_id is null)
  ),
  add constraint orders_funding_reservation_ownership_fk
  foreign key (user_id, funding_operation_id, funding_reservation_id)
  references balance_reservations(user_id, operation_id, id)
  on delete restrict
  deferrable initially immediate;

create index orders_funding_operation_idx
  on orders (funding_operation_id)
  where funding_operation_id is not null;

alter table executions
  add column funding_operation_id uuid,
  add column funding_reservation_id uuid;

alter table executions
  add constraint executions_funding_link_pair_check
  check (
    (funding_operation_id is null) = (funding_reservation_id is null)
  ),
  add constraint executions_funding_reservation_ownership_fk
  foreign key (user_id, funding_operation_id, funding_reservation_id)
  references balance_reservations(user_id, operation_id, id)
  on delete restrict
  deferrable initially immediate;

create index executions_funding_operation_idx
  on executions (funding_operation_id)
  where funding_operation_id is not null;

alter table telegram_trade_intents
  add column funding_operation_id uuid,
  add column funding_reservation_id uuid;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_funding_user_check
  check (
    funding_operation_id is null
    or user_id is not null
  ),
  add constraint telegram_trade_intents_funding_reservation_requires_operation_check
  check (
    funding_reservation_id is null
    or funding_operation_id is not null
  );

alter table telegram_trade_intents
  add constraint telegram_trade_intents_funding_operation_ownership_fk
  foreign key (user_id, funding_operation_id)
  references funding_operations(user_id, id)
  on delete restrict
  deferrable initially immediate;

alter table telegram_trade_intents
  add constraint telegram_trade_intents_funding_reservation_ownership_fk
  foreign key (user_id, funding_operation_id, funding_reservation_id)
  references balance_reservations(user_id, operation_id, id)
  on delete restrict
  deferrable initially immediate;

create index telegram_trade_intents_funding_operation_idx
  on telegram_trade_intents (funding_operation_id)
  where funding_operation_id is not null;

alter table users
  add column financial_deactivated_at timestamptz,
  add column financial_pseudonymized_at timestamptz,
  add column financial_deactivation_reason text,
  add column privy_deletion_pending boolean not null default false;

alter table users
  add constraint users_financial_deactivation_check
  check (
    (
      financial_deactivated_at is null
      and financial_pseudonymized_at is null
      and financial_deactivation_reason is null
      and privy_deletion_pending = false
    )
    or (
      is_active = false
      and financial_deactivated_at is not null
      and financial_pseudonymized_at is not null
      and financial_deactivation_reason is not null
      and length(trim(financial_deactivation_reason)) > 0
    )
  );

create index users_privy_deletion_pending_idx
  on users (financial_deactivated_at)
  where privy_deletion_pending = true;

create or replace function funding_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger funding_quotes_touch_updated_at
before update on funding_quotes
for each row execute function funding_touch_updated_at();

create trigger funding_withdrawal_destinations_touch_updated_at
before update on funding_withdrawal_destinations
for each row execute function funding_touch_updated_at();

create trigger funding_operations_touch_updated_at
before update on funding_operations
for each row execute function funding_touch_updated_at();

create trigger funding_operation_segments_touch_updated_at
before update on funding_operation_segments
for each row execute function funding_touch_updated_at();

create trigger funding_provider_requests_touch_updated_at
before update on funding_provider_requests
for each row execute function funding_touch_updated_at();

create trigger funding_operation_steps_touch_updated_at
before update on funding_operation_steps
for each row execute function funding_touch_updated_at();

create trigger funding_operation_step_attempts_touch_updated_at
before update on funding_operation_step_attempts
for each row execute function funding_touch_updated_at();

create trigger funding_step_receipt_observations_touch_updated_at
before update on funding_step_receipt_observations
for each row execute function funding_touch_updated_at();

create trigger funding_observations_touch_updated_at
before update on funding_observations
for each row execute function funding_touch_updated_at();

create trigger balance_reservations_touch_updated_at
before update on balance_reservations
for each row execute function funding_touch_updated_at();

create trigger funding_route_observations_touch_updated_at
before update on funding_route_observations
for each row execute function funding_touch_updated_at();

create trigger funding_reconciliation_jobs_touch_updated_at
before update on funding_reconciliation_jobs
for each row execute function funding_touch_updated_at();

create or replace function funding_user_merge_context_active()
returns boolean
language sql
stable
as $$
  select coalesce(
    current_setting('hunch.funding_user_merge', true),
    'off'
  ) = 'on'
$$;

create or replace function funding_prevent_quote_plan_mutation()
returns trigger
language plpgsql
as $$
declare
  merge_reassignment boolean;
begin
  merge_reassignment :=
    funding_user_merge_context_active()
    and new.user_id is distinct from old.user_id
    and (old.consumed_at is not null or old.invalidated_at is not null);

  if (
    new.discovery_projection_id,
    new.selected_source_option_snapshot,
    new.market_context_snapshot,
    new.destination_option_snapshot,
    new.venue_binding_snapshot,
    new.plan_snapshot,
    new.policy_version,
    new.policy_revision,
    new.canonical_request_hash,
    new.plan_hash,
    new.consent_token_hash,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.discovery_projection_id,
    old.selected_source_option_snapshot,
    old.market_context_snapshot,
    old.destination_option_snapshot,
    old.venue_binding_snapshot,
    old.plan_snapshot,
    old.policy_version,
    old.policy_revision,
    old.canonical_request_hash,
    old.plan_hash,
    old.consent_token_hash,
    old.expires_at,
    old.created_at
  ) or (
    new.user_id is distinct from old.user_id and not merge_reassignment
  ) then
    raise exception 'funding quote plan is immutable'
      using errcode = '23514';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'consumed funding quote cannot be rewritten'
      using errcode = '23514';
  end if;
  if old.invalidated_at is not null and (
    new.invalidated_at is distinct from old.invalidated_at
    or new.invalidation_reason is distinct from old.invalidation_reason
  ) then
    raise exception 'invalidated funding quote cannot be rewritten'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_quotes_immutable_plan
before update on funding_quotes
for each row execute function funding_prevent_quote_plan_mutation();

create or replace function funding_prevent_destination_identity_mutation()
returns trigger
language plpgsql
as $$
declare
  merge_reassignment boolean;
begin
  merge_reassignment :=
    funding_user_merge_context_active()
    and new.user_id is distinct from old.user_id
    and old.revoked_at is not null;

  if (
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.address_lookup_hmac,
    new.lookup_key_version,
    new.validation_evidence,
    new.policy_version,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.network_id,
    old.asset_id,
    old.asset_decimals,
    old.address_lookup_hmac,
    old.lookup_key_version,
    old.validation_evidence,
    old.policy_version,
    old.expires_at,
    old.created_at
  ) or (
    new.user_id is distinct from old.user_id and not merge_reassignment
  ) then
    raise exception 'funding withdrawal destination identity is immutable'
      using errcode = '23514';
  end if;
  if old.revoked_at is not null and (
    new.revoked_at is distinct from old.revoked_at
    or new.revocation_reason is distinct from old.revocation_reason
  ) then
    raise exception 'revoked funding withdrawal destination cannot be rewritten'
      using errcode = '23514';
  end if;
  if new.address_ciphertext is distinct from old.address_ciphertext
    and new.address_ciphertext is not null then
    raise exception 'destination ciphertext cannot be rewritten or restored'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_withdrawal_destinations_immutable_identity
before update on funding_withdrawal_destinations
for each row execute function funding_prevent_destination_identity_mutation();

create or replace function funding_prevent_operation_plan_mutation()
returns trigger
language plpgsql
as $$
declare
  merge_reassignment boolean;
begin
  merge_reassignment :=
    funding_user_merge_context_active()
    and new.user_id is distinct from old.user_id
    and old.status in ('completed', 'refunded', 'failed', 'cancelled')
    and new.status = old.status
    and new.progress_stage = old.progress_stage;

  if (
    new.quote_id,
    new.purpose,
    new.experience_mode,
    new.plan_kind,
    new.idempotency_key,
    new.commit_request_hash,
    new.plan_hash,
    new.policy_version,
    new.policy_revision,
    new.source_snapshot,
    new.destination_target_snapshot,
    new.external_recipient_id,
    new.venue_id,
    new.market_id,
    new.market_context_snapshot,
    new.venue_binding_snapshot,
    new.wallet_execution_snapshot,
    new.placement_snapshot,
    new.requested_source_amount,
    new.requested_destination_amount,
    new.quote_snapshot,
    new.consent_snapshot,
    new.original_subject_lookup_hmac,
    new.subject_lookup_key_version,
    new.created_at
  ) is distinct from (
    old.quote_id,
    old.purpose,
    old.experience_mode,
    old.plan_kind,
    old.idempotency_key,
    old.commit_request_hash,
    old.plan_hash,
    old.policy_version,
    old.policy_revision,
    old.source_snapshot,
    old.destination_target_snapshot,
    old.external_recipient_id,
    old.venue_id,
    old.market_id,
    old.market_context_snapshot,
    old.venue_binding_snapshot,
    old.wallet_execution_snapshot,
    old.placement_snapshot,
    old.requested_source_amount,
    old.requested_destination_amount,
    old.quote_snapshot,
    old.consent_snapshot,
    old.original_subject_lookup_hmac,
    old.subject_lookup_key_version,
    old.created_at
  ) or (
    new.user_id is distinct from old.user_id and not merge_reassignment
  ) then
    raise exception 'committed funding operation plan is immutable'
      using errcode = '23514';
  end if;
  if new.version <= old.version then
    raise exception 'funding operation version must increase'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_operations_immutable_plan
before update on funding_operations
for each row execute function funding_prevent_operation_plan_mutation();

create or replace function funding_prevent_segment_plan_mutation()
returns trigger
language plpgsql
as $$
begin
  if (
    new.operation_id,
    new.id,
    new.ordinal,
    new.provider_id,
    new.adapter_id,
    new.adapter_version,
    new.segment_kind,
    new.source_snapshot,
    new.destination_target_snapshot,
    new.quoted_input,
    new.quoted_expected_output,
    new.quoted_min_output,
    new.provider_quote_ref_lookup_hmac,
    new.deposit_address_lookup_hmac,
    new.lookup_key_version,
    new.refund_location_snapshot,
    new.quote_expires_at,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.id,
    old.ordinal,
    old.provider_id,
    old.adapter_id,
    old.adapter_version,
    old.segment_kind,
    old.source_snapshot,
    old.destination_target_snapshot,
    old.quoted_input,
    old.quoted_expected_output,
    old.quoted_min_output,
    old.provider_quote_ref_lookup_hmac,
    old.deposit_address_lookup_hmac,
    old.lookup_key_version,
    old.refund_location_snapshot,
    old.quote_expires_at,
    old.created_at
  ) then
    raise exception 'funding operation segment plan is immutable'
      using errcode = '23514';
  end if;
  if (
    new.provider_quote_ref_ciphertext
      is distinct from old.provider_quote_ref_ciphertext
    and (
      new.provider_quote_ref_ciphertext is not null
      or new.status not in ('succeeded', 'refunded', 'failed')
    )
  ) then
    raise exception 'provider quote ciphertext can only be shredded after terminal settlement'
      using errcode = '23514';
  end if;
  if (
    new.deposit_address_ciphertext
      is distinct from old.deposit_address_ciphertext
    and (
      new.deposit_address_ciphertext is not null
      or new.status not in ('succeeded', 'refunded', 'failed')
    )
  ) then
    raise exception 'deposit address ciphertext can only be shredded after terminal settlement'
      using errcode = '23514';
  end if;
  if old.actual_input is not null
    and new.actual_input is distinct from old.actual_input then
    raise exception 'funding segment actual input is immutable once recorded'
      using errcode = '23514';
  end if;
  if old.actual_output is not null
    and new.actual_output is distinct from old.actual_output then
    raise exception 'funding segment actual output is immutable once recorded'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_operation_segments_immutable_plan
before update on funding_operation_segments
for each row execute function funding_prevent_segment_plan_mutation();

create or replace function funding_prevent_step_plan_mutation()
returns trigger
language plpgsql
as $$
begin
  if (
    new.operation_id,
    new.segment_id,
    new.ordinal,
    new.step_kind,
    new.action_fingerprint,
    new.executor_id,
    new.payer_requirement,
    new.depends_on_step_id,
    new.normalized_action,
    new.action_validation_result,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.segment_id,
    old.ordinal,
    old.step_kind,
    old.action_fingerprint,
    old.executor_id,
    old.payer_requirement,
    old.depends_on_step_id,
    old.normalized_action,
    old.action_validation_result,
    old.created_at
  ) then
    raise exception 'funding operation step plan is immutable'
      using errcode = '23514';
  end if;
  if new.state is distinct from old.state
    and not (
      (old.state = 'planned' and new.state in (
        'action_required',
        'submitted',
        'reconcile_required',
        'failed',
        'cancelled'
      ))
      or (old.state = 'action_required' and new.state in (
        'submitted',
        'reconcile_required',
        'failed',
        'cancelled'
      ))
      or (old.state = 'submitted' and new.state in (
        'action_required',
        'succeeded',
        'reconcile_required',
        'recovery_required',
        'failed'
      ))
      or (old.state = 'reconcile_required' and new.state in (
        'action_required',
        'submitted',
        'succeeded',
        'recovery_required',
        'failed'
      ))
      or (old.state = 'succeeded' and new.state = 'recovery_required')
      or (old.state = 'recovery_required' and new.state in (
        'succeeded',
        'failed'
      ))
    ) then
    raise exception 'invalid funding operation step state transition: % -> %',
      old.state,
      new.state
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_operation_steps_immutable_plan
before update on funding_operation_steps
for each row execute function funding_prevent_step_plan_mutation();

create or replace function funding_guard_attempt_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'funding operation attempts are append-only'
      using errcode = '23514';
  end if;
  if (
    new.step_id,
    new.attempt_number,
    new.canonical_action_fingerprint,
    new.executor_id,
    new.started_at,
    new.created_at
  ) is distinct from (
    old.step_id,
    old.attempt_number,
    old.canonical_action_fingerprint,
    old.executor_id,
    old.started_at,
    old.created_at
  ) then
    raise exception 'funding operation attempt identity is immutable'
      using errcode = '23514';
  end if;
  if old.outcome <> 'started' and (
    new.outcome,
    new.broadcast_may_have_occurred,
    new.reference_kind,
    new.receipt_ref_lookup_hmac,
    new.lookup_key_version,
    new.actual_costs,
    new.finished_at
  ) is distinct from (
    old.outcome,
    old.broadcast_may_have_occurred,
    old.reference_kind,
    old.receipt_ref_lookup_hmac,
    old.lookup_key_version,
    old.actual_costs,
    old.finished_at
  ) then
    raise exception 'finished funding operation attempt cannot be rewritten'
      using errcode = '23514';
  end if;
  if old.outcome <> 'started'
    and new.receipt_ref_ciphertext is distinct from old.receipt_ref_ciphertext
    and new.receipt_ref_ciphertext is not null then
    raise exception 'attempt receipt ciphertext cannot be rewritten or restored'
      using errcode = '23514';
  end if;
  if old.outcome = 'started' and new.outcome = 'started' and (
    new.broadcast_may_have_occurred,
    new.reference_kind,
    new.receipt_ref_ciphertext,
    new.receipt_ref_lookup_hmac,
    new.lookup_key_version,
    new.actual_costs,
    new.finished_at
  ) is distinct from (
    old.broadcast_may_have_occurred,
    old.reference_kind,
    old.receipt_ref_ciphertext,
    old.receipt_ref_lookup_hmac,
    old.lookup_key_version,
    old.actual_costs,
    old.finished_at
  ) then
    raise exception 'started funding operation attempt cannot record terminal evidence'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_operation_step_attempts_guard_update
before update or delete on funding_operation_step_attempts
for each row execute function funding_guard_attempt_update();

create or replace function funding_guard_step_receipt_observation_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'funding step receipt observations cannot be deleted'
      using errcode = '23514';
  end if;
  if (
    new.operation_id,
    new.step_id,
    new.attempt_id,
    new.network_id,
    new.first_seen_at,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.step_id,
    old.attempt_id,
    old.network_id,
    old.first_seen_at,
    old.created_at
  ) then
    raise exception 'funding step receipt observation identity is immutable'
      using errcode = '23514';
  end if;
  if new.status is distinct from old.status
    and not (
      (old.status = 'pending' and new.status in (
        'confirmed',
        'finalized',
        'failed',
        'mismatch',
        'reorged'
      ))
      or (old.status = 'confirmed' and new.status in (
        'finalized',
        'failed',
        'mismatch',
        'reorged'
      ))
      or (old.status = 'finalized' and new.status = 'reorged')
    ) then
    raise exception 'invalid funding step receipt transition: % -> %',
      old.status,
      new.status
      using errcode = '23514';
  end if;
  if old.status in ('failed', 'mismatch', 'reorged') and (
    new.status,
    new.action_match,
    new.ledger_height,
    new.block_hash,
    new.canonical,
    new.failure_code,
    new.evidence,
    new.observed_at,
    new.finalized_at,
    new.reorged_at
  ) is distinct from (
    old.status,
    old.action_match,
    old.ledger_height,
    old.block_hash,
    old.canonical,
    old.failure_code,
    old.evidence,
    old.observed_at,
    old.finalized_at,
    old.reorged_at
  ) then
    raise exception 'terminal funding step receipt observation is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_step_receipt_observations_guard_update
before update or delete on funding_step_receipt_observations
for each row execute function funding_guard_step_receipt_observation_update();

create or replace function funding_guard_observation_update()
returns trigger
language plpgsql
as $$
declare
  transition_allowed boolean;
begin
  if (
    new.operation_id,
    new.segment_id,
    new.kind,
    new.network_id,
    new.asset_id,
    new.tx_hash,
    new.event_index,
    new.from_address,
    new.to_address,
    new.raw_amount,
    new.observed_at,
    new.ledger_height,
    new.block_hash,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.segment_id,
    old.kind,
    old.network_id,
    old.asset_id,
    old.tx_hash,
    old.event_index,
    old.from_address,
    old.to_address,
    old.raw_amount,
    old.observed_at,
    old.ledger_height,
    old.block_hash,
    old.created_at
  ) then
    raise exception 'funding observation allocation and transfer identity are immutable'
      using errcode = '23514';
  end if;

  transition_allowed :=
    new.finality_status = old.finality_status
    or (old.finality_status = 'observed' and new.finality_status in ('confirmed', 'finalized', 'reorged'))
    or (old.finality_status = 'confirmed' and new.finality_status in ('finalized', 'reorged'))
    or (old.finality_status = 'finalized' and new.finality_status = 'reorged');
  if not transition_allowed then
    raise exception 'invalid funding observation finality transition: % -> %',
      old.finality_status,
      new.finality_status
      using errcode = '23514';
  end if;
  if new.finality_status = old.finality_status and (
    new.canonical,
    new.finalized_at,
    new.reorged_at
  ) is distinct from (
    old.canonical,
    old.finalized_at,
    old.reorged_at
  ) then
    raise exception 'funding observation finality evidence cannot change without a transition'
      using errcode = '23514';
  end if;
  if old.finalized_at is not null
    and new.finalized_at is distinct from old.finalized_at then
    raise exception 'funding observation finalized_at is immutable'
      using errcode = '23514';
  end if;
  if old.reorged_at is not null
    and new.reorged_at is distinct from old.reorged_at then
    raise exception 'funding observation reorged_at is immutable'
      using errcode = '23514';
  end if;
  if not (new.metadata @> old.metadata) then
    raise exception 'funding observation metadata is append-only'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_observations_guard_update
before update on funding_observations
for each row execute function funding_guard_observation_update();

create or replace function funding_guard_reservation_update()
returns trigger
language plpgsql
as $$
declare
  merge_reassignment boolean;
begin
  merge_reassignment :=
    funding_user_merge_context_active()
    and new.user_id is distinct from old.user_id
    and old.state in ('consumed', 'released')
    and new.state = old.state;

  if (
    new.operation_id,
    new.component_id,
    new.location_id,
    new.network_id,
    new.asset_id,
    new.asset_decimals,
    new.raw_amount,
    new.mode,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.component_id,
    old.location_id,
    old.network_id,
    old.asset_id,
    old.asset_decimals,
    old.raw_amount,
    old.mode,
    old.expires_at,
    old.created_at
  ) or (
    new.user_id is distinct from old.user_id and not merge_reassignment
  ) then
    raise exception 'funding reservation amount and ownership are immutable'
      using errcode = '23514';
  end if;
  if old.state <> 'active' and new.state is distinct from old.state then
    raise exception 'terminal funding reservation cannot transition'
      using errcode = '23514';
  end if;
  if old.state <> 'active' and (
    new.consumer_kind is distinct from old.consumer_kind
    or new.consumer_ref is distinct from old.consumer_ref
    or new.outcome_reason is distinct from old.outcome_reason
    or new.consumed_at is distinct from old.consumed_at
    or new.released_at is distinct from old.released_at
  ) then
    raise exception 'terminal funding reservation outcome is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger balance_reservations_guard_update
before update on balance_reservations
for each row execute function funding_guard_reservation_update();

create or replace function funding_guard_provider_request_update()
returns trigger
language plpgsql
as $$
begin
  if (
    new.segment_id,
    new.request_kind,
    new.request_ref_lookup_hmac,
    new.discovery_source,
    new.lookup_key_version,
    new.first_seen_at,
    new.created_at
  ) is distinct from (
    old.segment_id,
    old.request_kind,
    old.request_ref_lookup_hmac,
    old.discovery_source,
    old.lookup_key_version,
    old.first_seen_at,
    old.created_at
  ) then
    raise exception 'funding provider request identity is immutable'
      using errcode = '23514';
  end if;
  if new.request_ref_ciphertext is distinct from old.request_ref_ciphertext
    and new.request_ref_ciphertext is not null then
    raise exception 'provider request ciphertext cannot be rewritten or restored'
      using errcode = '23514';
  end if;
  if new.last_seen_at < old.last_seen_at then
    raise exception 'funding provider request last_seen_at cannot regress'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_provider_requests_guard_update
before update on funding_provider_requests
for each row execute function funding_guard_provider_request_update();

create or replace function funding_guard_route_observation_update()
returns trigger
language plpgsql
as $$
declare
  merge_reassignment boolean;
begin
  merge_reassignment :=
    funding_user_merge_context_active()
    and new.user_id is distinct from old.user_id
    and old.outcome <> 'in_progress'
    and old.finished_at is not null;

  if (
    new.operation_id,
    new.route_key_hmac,
    new.route_key_version,
    new.provider_id,
    new.adapter_version,
    new.amount_band,
    new.started_at,
    new.policy_revision,
    new.created_at
  ) is distinct from (
    old.operation_id,
    old.route_key_hmac,
    old.route_key_version,
    old.provider_id,
    old.adapter_version,
    old.amount_band,
    old.started_at,
    old.policy_revision,
    old.created_at
  ) or (
    new.user_id is distinct from old.user_id and not merge_reassignment
  ) then
    raise exception 'funding route observation identity is immutable'
      using errcode = '23514';
  end if;

  if old.outcome <> 'in_progress' and (
    new.finished_at,
    new.latency_stages,
    new.outcome,
    new.refund_observed,
    new.recovery_required,
    new.reason_codes,
    new.support_metadata
  ) is distinct from (
    old.finished_at,
    old.latency_stages,
    old.outcome,
    old.refund_observed,
    old.recovery_required,
    old.reason_codes,
    old.support_metadata
  ) then
    raise exception 'terminal funding route observation cannot be rewritten'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_route_observations_guard_update
before update on funding_route_observations
for each row execute function funding_guard_route_observation_update();

create or replace function funding_validate_operation_segment_shape(
  target_operation_id uuid
)
returns void
language plpgsql
as $$
declare
  operation_plan_kind text;
  segment_count integer;
  relay_segment_count integer;
  relay_deposit_segment_count integer;
  minimum_ordinal integer;
  maximum_ordinal integer;
  step_count integer;
  unbound_step_count integer;
  venue_preparation_step_count integer;
  minimum_step_ordinal integer;
  maximum_step_ordinal integer;
  segment_without_step_count integer;
  segment_without_reservation_count integer;
  invalid_observation_binding_count integer;
  invalid_reservation_binding_count integer;
  source_reservation_count integer;
begin
  select plan_kind
  into operation_plan_kind
  from funding_operations
  where id = target_operation_id;

  if operation_plan_kind is null then
    return;
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where provider_id = 'relay'
    )::integer,
    count(*) filter (
      where provider_id = 'relay' and segment_kind = 'deposit_address'
    )::integer,
    min(ordinal)::integer,
    max(ordinal)::integer
  into
    segment_count,
    relay_segment_count,
    relay_deposit_segment_count,
    minimum_ordinal,
    maximum_ordinal
  from funding_operation_segments
  where operation_id = target_operation_id;

  if operation_plan_kind in ('wallet_route', 'relay_deposit_address')
    and segment_count <> 1 then
    raise exception 'funding plan % requires exactly one segment, found %',
      operation_plan_kind,
      segment_count
      using errcode = '23514';
  end if;

  if operation_plan_kind in (
    'direct_external_handoff',
    'already_available',
    'venue_preparation'
  )
    and segment_count <> 0 then
    raise exception 'funding plan % requires zero segments, found %',
      operation_plan_kind,
      segment_count
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'composite_route' then
    if segment_count < 2 then
      raise exception 'composite funding plan requires at least two segments'
        using errcode = '23514';
    end if;
    if relay_segment_count <> segment_count then
      raise exception 'composite funding plan currently supports Relay legs only'
        using errcode = '23514';
    end if;
  end if;

  if segment_count > 0
    and (minimum_ordinal <> 0 or maximum_ordinal <> segment_count - 1) then
    raise exception 'funding segments must have contiguous ordinals from zero'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'relay_deposit_address'
    and relay_deposit_segment_count <> 1 then
    raise exception 'Relay deposit-address plan requires one Relay deposit-address segment'
      using errcode = '23514';
  end if;

  select
    count(*)::integer,
    count(*) filter (where segment_id is null)::integer,
    count(*) filter (where step_kind = 'venue_preparation')::integer,
    min(ordinal)::integer,
    max(ordinal)::integer
  into
    step_count,
    unbound_step_count,
    venue_preparation_step_count,
    minimum_step_ordinal,
    maximum_step_ordinal
  from funding_operation_steps
  where operation_id = target_operation_id;

  if step_count > 0
    and (
      minimum_step_ordinal <> 0
      or maximum_step_ordinal <> step_count - 1
    ) then
    raise exception 'funding steps must have contiguous ordinals from zero'
      using errcode = '23514';
  end if;

  if operation_plan_kind in (
    'wallet_route',
    'relay_deposit_address',
    'composite_route'
  ) and unbound_step_count <> 0 then
    raise exception 'provider route steps must bind to an exact segment'
      using errcode = '23514';
  end if;

  if operation_plan_kind in (
    'direct_external_handoff',
    'already_available',
    'venue_preparation'
  ) and unbound_step_count <> step_count then
    raise exception 'zero-provider plan cannot bind a step to a segment'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'venue_preparation'
    and (step_count <> 1 or venue_preparation_step_count <> 1) then
    raise exception 'venue preparation plan requires one exact preparation step'
      using errcode = '23514';
  end if;

  if operation_plan_kind <> 'venue_preparation'
    and venue_preparation_step_count <> 0 then
    raise exception 'venue preparation step requires a venue preparation plan'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'composite_route' then
    select count(*)::integer
    into segment_without_step_count
    from funding_operation_segments segment
    where segment.operation_id = target_operation_id
      and not exists (
        select 1
        from funding_operation_steps step
        where step.operation_id = segment.operation_id
          and step.segment_id = segment.id
      );
    if segment_without_step_count <> 0 then
      raise exception 'every composite segment requires at least one bound step'
      using errcode = '23514';
    end if;
  end if;

  if operation_plan_kind in (
    'wallet_route',
    'relay_deposit_address',
    'composite_route'
  ) then
    select count(*)::integer
    into invalid_reservation_binding_count
    from balance_reservations reservation
    where reservation.operation_id = target_operation_id
      and reservation.mode = 'subtract_available'
      and reservation.segment_id is null;
  else
    select count(*)::integer
    into invalid_reservation_binding_count
    from balance_reservations reservation
    where reservation.operation_id = target_operation_id
      and reservation.segment_id is not null;
  end if;
  if invalid_reservation_binding_count <> 0 then
    raise exception 'funding reservation is not bound to the exact plan shape'
      using errcode = '23514';
  end if;

  if operation_plan_kind = 'venue_preparation' then
    select count(*)::integer
    into source_reservation_count
    from balance_reservations reservation
    where reservation.operation_id = target_operation_id
      and reservation.mode = 'subtract_available';
    if source_reservation_count < 1 then
      raise exception 'venue preparation plan requires reserved exact inputs'
        using errcode = '23514';
    end if;
  end if;

  if operation_plan_kind in ('wallet_route', 'composite_route') then
    select count(*)::integer
    into segment_without_reservation_count
    from funding_operation_segments segment
    where segment.operation_id = target_operation_id
      and (
        select count(*)
        from balance_reservations reservation
        where reservation.operation_id = segment.operation_id
          and reservation.segment_id = segment.id
          and reservation.mode = 'subtract_available'
      ) <> 1;
    if segment_without_reservation_count <> 0 then
      raise exception 'each wallet-route segment requires one source reservation'
        using errcode = '23514';
    end if;
  end if;

  if operation_plan_kind in (
    'wallet_route',
    'relay_deposit_address',
    'composite_route'
  ) then
    select count(*)::integer
    into invalid_observation_binding_count
    from funding_observations observation
    where observation.operation_id = target_operation_id
      and (
        (
          observation.kind = 'venue_readiness'
          and observation.segment_id is not null
        )
        or (
          observation.kind <> 'venue_readiness'
          and observation.segment_id is null
        )
      );
  else
    select count(*)::integer
    into invalid_observation_binding_count
    from funding_observations observation
    where observation.operation_id = target_operation_id
      and observation.segment_id is not null;
  end if;
  if invalid_observation_binding_count <> 0 then
    raise exception 'funding observation is not bound to the exact plan shape'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function funding_validate_operation_segment_shape_trigger()
returns trigger
language plpgsql
as $$
declare
  target_operation_id uuid;
begin
  if tg_table_name = 'funding_operations' then
    target_operation_id :=
      case when tg_op = 'DELETE' then old.id else new.id end;
  elsif tg_table_name = 'funding_operation_segments' then
    target_operation_id :=
      case when tg_op = 'DELETE' then old.operation_id else new.operation_id end;
  elsif tg_table_name = 'funding_operation_steps' then
    target_operation_id :=
      case when tg_op = 'DELETE' then old.operation_id else new.operation_id end;
  elsif tg_table_name = 'funding_observations' then
    target_operation_id :=
      case when tg_op = 'DELETE' then old.operation_id else new.operation_id end;
  elsif tg_table_name = 'balance_reservations' then
    target_operation_id :=
      case when tg_op = 'DELETE' then old.operation_id else new.operation_id end;
  else
    raise exception 'unexpected funding segment-shape trigger table: %',
      tg_table_name
      using errcode = '23514';
  end if;

  perform funding_validate_operation_segment_shape(target_operation_id);
  return null;
end;
$$;

create constraint trigger funding_operations_segment_shape
after insert or update on funding_operations
deferrable initially deferred
for each row execute function funding_validate_operation_segment_shape_trigger();

create constraint trigger funding_operation_segments_shape
after insert or update or delete on funding_operation_segments
deferrable initially deferred
for each row execute function funding_validate_operation_segment_shape_trigger();

create constraint trigger funding_operation_steps_shape
after insert or update or delete on funding_operation_steps
deferrable initially deferred
for each row execute function funding_validate_operation_segment_shape_trigger();

create constraint trigger funding_observations_shape
after insert or update or delete on funding_observations
deferrable initially deferred
for each row execute function funding_validate_operation_segment_shape_trigger();

create constraint trigger balance_reservations_shape
after insert or update or delete on balance_reservations
deferrable initially deferred
for each row execute function funding_validate_operation_segment_shape_trigger();

create or replace function classify_legacy_bridge_adapter(
  bridge_provider text,
  bridge_swap_type text,
  bridge_order_id text,
  bridge_metadata jsonb
)
returns text
language sql
immutable
as $$
  select case
    when bridge_provider = 'across'
      and (bridge_metadata #> '{across,providerPayload,swapTx}') is not null
      then 'across_swap_api_v1'
    when bridge_provider = 'across'
      and (bridge_metadata #> '{across,providerPayload,capitalFeePct}') is not null
      then 'across_suggested_fees_v1'
    when bridge_provider = 'debridge'
      and bridge_swap_type = 'cross_chain'
      and bridge_order_id is not null
      and jsonb_typeof(bridge_metadata->'estimation') = 'object'
      then 'debridge_dln_create_tx_v1'
    when bridge_provider = 'debridge'
      and bridge_swap_type = 'same_chain'
      and jsonb_typeof(bridge_metadata->'tokenIn') = 'object'
      and jsonb_typeof(bridge_metadata->'tokenOut') = 'object'
      then 'debridge_same_chain_v1'
    when bridge_provider = 'debridge'
      and bridge_swap_type = 'same_chain'
      and jsonb_typeof(bridge_metadata->'tx') = 'object'
      then 'debridge_same_chain_tx_v0'
    when bridge_provider = 'bungee'
      then 'bungee_legacy_v1'
    else null
  end
$$;

alter table bridge_orders
  add column adapter_version text,
  add column adapter_classified_at timestamptz;

do $$
declare
  unknown_count bigint;
begin
  select count(*)
  into unknown_count
  from bridge_orders
  where classify_legacy_bridge_adapter(
    provider,
    swap_type,
    order_id,
    metadata
  ) is null;

  if unknown_count <> 0 then
    raise exception 'legacy bridge classifier has % unknown rows', unknown_count;
  end if;
end;
$$;

update bridge_orders
set adapter_version = classify_legacy_bridge_adapter(
      provider,
      swap_type,
      order_id,
      metadata
    ),
    adapter_classified_at = now()
where adapter_version is null;

alter table bridge_orders
  add constraint bridge_orders_adapter_version_check
  check (
    adapter_version is null
    or adapter_version in (
      'across_swap_api_v1',
      'across_suggested_fees_v1',
      'debridge_dln_create_tx_v1',
      'debridge_same_chain_v1',
      'debridge_same_chain_tx_v0',
      'bungee_legacy_v1'
    )
  );

create index bridge_orders_adapter_status_idx
  on bridge_orders (adapter_version, status, updated_at);

alter table bridge_orders
  drop constraint if exists bridge_orders_user_id_fkey;

alter table bridge_orders
  add constraint bridge_orders_user_id_fkey
  foreign key (user_id) references users(id) on delete restrict;
