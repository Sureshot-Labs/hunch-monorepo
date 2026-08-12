-- Funding authorizations are retained as historical evidence, but a retained
-- row must not prevent ordinary Privy wallet unlink/replacement. The immutable
-- wallet id may therefore be cleared by its FK while the snapshotted Privy id
-- and address remain intact; an active row is revoked in the same update.

alter table telegram_funding_authorizations
  drop constraint telegram_funding_authorizations_user_wallet_id_fkey;

alter table telegram_funding_authorizations
  alter column user_wallet_id drop not null;

alter table telegram_funding_authorizations
  add constraint telegram_funding_authorizations_user_wallet_id_fkey
  foreign key (user_wallet_id) references user_wallets(id) on delete set null;

-- An explicit operator revoke is an emergency stop, not a transient absence of
-- an active row. Automatic provisioning must honor it until an operator
-- explicitly grants the profile again.
alter table telegram_bot_trading_preferences
  add column funding_operator_revoked_at timestamptz;

-- A review quote is a receipt-bound capability. Keeping that scope on the
-- quote lets the generic commit core reject it without learning channel or
-- receipt tables; only the scoped receipt transaction may consume it.
alter table funding_quotes
  add column commit_scope jsonb;

-- Operation lifetime and action validity are different clocks. Existing
-- steps inherit their old operation/segment deadline; new adapters may store
-- NULL only when their reviewed action contract has no time-based validity
-- boundary (the exact Polymarket receipt transform is the first such profile).
-- Keep every ALTER before the UPDATE: funding_operation_steps has an initially
-- deferred shape trigger, and queued trigger events make a later ALTER fail.
alter table funding_operation_steps
  add column action_expires_at timestamptz;

alter table funding_operation_steps
  add constraint funding_operation_steps_action_expiry_check
  check (action_expires_at is null or action_expires_at > created_at);

create index funding_operation_steps_action_claim_idx
  on funding_operation_steps (executor_id, action_expires_at, created_at)
  where state = 'action_required';

update funding_operation_steps step
set action_expires_at = case
  when step.executor_id = 'polymarket_deposit_usdce_wrap_v1'
    and operation.support_metadata ->> 'preparationKind' =
        'polymarket_funding_router'
    then null
  else least(
    operation.expires_at,
    coalesce(
      (
        select segment.quote_expires_at
        from funding_operation_segments segment
        where segment.id = step.segment_id
          and segment.operation_id = step.operation_id
      ),
      operation.expires_at
    )
  )
end
from funding_operations operation
where operation.id = step.operation_id;

update funding_quotes quote
set commit_scope = jsonb_build_object(
  'kind', 'receive_receipt_review_v1',
  'ownerChannel', session.owner_channel,
  'receiveSessionId', receipt.receive_session_id,
  'receiptId', receipt.id
)
from funding_receive_receipts receipt
join funding_receive_sessions session on session.id = receipt.receive_session_id
where receipt.review_quote_id = quote.id
  and quote.commit_scope is null;

alter table funding_quotes
  add constraint funding_quotes_commit_scope_check
  check (
    commit_scope is null
    or (
      jsonb_typeof(commit_scope) = 'object'
      and (
        commit_scope
        - 'kind'
        - 'ownerChannel'
        - 'receiveSessionId'
        - 'receiptId'
      ) = '{}'::jsonb
      and commit_scope ->> 'kind' = 'receive_receipt_review_v1'
      and commit_scope ->> 'ownerChannel' in ('web', 'telegram')
      and commit_scope ->> 'receiveSessionId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and commit_scope ->> 'receiptId'
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

create unique index funding_receive_receipts_review_quote_unique_idx
  on funding_receive_receipts (review_quote_id)
  where review_quote_id is not null;

create or replace function funding_prevent_quote_commit_scope_mutation()
returns trigger
language plpgsql
as $$
begin
  if new.commit_scope is distinct from old.commit_scope then
    raise exception 'funding quote commit scope is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger funding_quotes_immutable_commit_scope
before update on funding_quotes
for each row execute function funding_prevent_quote_commit_scope_mutation();

-- Keep SQL evidence matching identical to the domain identity contract:
-- checksum/lowercase EVM addresses are aliases only when both values are
-- valid addresses on a valid EVM network. Solana and malformed values remain
-- byte-sensitive and therefore fail closed.
create or replace function funding_account_identifier_equal(
  identity_scope text,
  left_identifier text,
  right_identifier text
)
returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when (
      identity_scope = 'ethereum'
      or identity_scope ~ '^evm:[1-9][0-9]*$'
    )
      and left_identifier ~ '^0x[0-9a-fA-F]{40}$'
      and right_identifier ~ '^0x[0-9a-fA-F]{40}$'
      then lower(left_identifier) = lower(right_identifier)
    else left_identifier = right_identifier
  end
$$;

-- SQL selectors must agree with the TypeScript evidence parsers. Presence of
-- both keys is insufficient: a version-skewed or corrupted object must return
-- to adapter-owned disposition repair instead of becoming an actionless review.
create or replace function funding_receive_money_is_valid(candidate jsonb)
returns boolean
language sql
immutable
parallel safe
as $$
  select case
    when jsonb_typeof(candidate) = 'object'
      and jsonb_typeof(candidate -> 'asset') = 'object'
      and jsonb_typeof(candidate -> 'asset' -> 'networkId') = 'string'
      and length(btrim(candidate -> 'asset' ->> 'networkId')) > 0
      and jsonb_typeof(candidate -> 'asset' -> 'assetId') = 'string'
      and length(btrim(candidate -> 'asset' ->> 'assetId')) > 0
      and jsonb_typeof(candidate -> 'asset' -> 'decimals') = 'number'
      and jsonb_typeof(candidate -> 'raw') = 'string'
      and candidate ->> 'raw' ~ '^(0|[1-9][0-9]*)$'
      then
        (candidate -> 'asset' ->> 'decimals')::numeric =
          trunc((candidate -> 'asset' ->> 'decimals')::numeric)
        and (candidate -> 'asset' ->> 'decimals')::numeric between 0 and 255
    else false
  end
$$;

create or replace function funding_receive_review_evidence_is_valid(
  evidence jsonb
)
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(
    jsonb_typeof(evidence) = 'object'
    and jsonb_typeof(evidence -> 'reviewContinuation') = 'object'
    and evidence -> 'reviewContinuation' -> 'version' = '1'::jsonb
    and evidence -> 'reviewContinuation' ->> 'kind' = 'convert'
    and evidence -> 'reviewContinuation' ->> 'confirmation' = 'fresh_quote'
    and jsonb_typeof(evidence -> 'reviewContinuation' -> 'label') = 'string'
    and length(btrim(evidence -> 'reviewContinuation' ->> 'label'))
      between 1 and 64
    and jsonb_typeof(evidence -> 'reviewQuotePlan') = 'object'
    and evidence -> 'reviewQuotePlan' -> 'version' = '1'::jsonb
    and evidence -> 'reviewQuotePlan' ? 'confirmedSourceAmount'
    and (
      evidence -> 'reviewQuotePlan' -> 'confirmedSourceAmount' = 'null'::jsonb
      or funding_receive_money_is_valid(
        evidence -> 'reviewQuotePlan' -> 'confirmedSourceAmount'
      )
    )
    and funding_receive_money_is_valid(
      evidence -> 'reviewQuotePlan' -> 'requestedDestinationAmount'
    )
    and jsonb_typeof(
      evidence -> 'reviewQuotePlan' -> 'venuePreparation'
    ) = 'boolean',
    false
  )
$$;

-- Replace the legacy "all non-Solana is lowercase" key. Only a syntactically
-- valid EVM address is case-insensitive; malformed and future-chain values
-- retain exact identity.
alter table user_wallets
  add column wallet_address_identity_key text
  generated always as (
    case
      when wallet_type = 'ethereum'
        and wallet_address ~ '^0x[0-9a-fA-F]{40}$'
        then lower(wallet_address)
      else wallet_address
    end
  ) stored;

create unique index idx_user_wallets_wallet_identity_key
  on user_wallets (wallet_type, wallet_address_identity_key);

drop index idx_user_wallets_wallet_norm;

alter table user_wallets
  drop column wallet_address_norm;

alter table user_wallets
  rename column wallet_address_identity_key to wallet_address_norm;

alter index idx_user_wallets_wallet_identity_key
  rename to idx_user_wallets_wallet_norm;

create or replace function funding_receive_receipt_matches_frozen_variant(
  candidate funding_receive_receipts
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from funding_receive_sessions receive
    cross join lateral jsonb_array_elements(receive.observation_variants) variant
    where receive.id = candidate.receive_session_id
      and receive.user_id = candidate.user_id
      and variant ->> 'variantId' = candidate.variant_id
      and variant ->> 'networkId' = candidate.network_id
      and variant -> 'asset' ->> 'networkId' = candidate.network_id
      and (variant -> 'asset' ->> 'decimals')::integer = candidate.asset_decimals
      and funding_account_identifier_equal(
        candidate.network_id,
        variant -> 'asset' ->> 'assetId',
        candidate.asset_id
      )
      and funding_account_identifier_equal(
        candidate.network_id,
        variant ->> 'destinationAddress',
        candidate.destination_address
      )
      and (
        candidate.handling <> 'direct'
        or variant -> 'completion' ->> 'kind' = 'direct_destination_credit'
      )
  )
$$;

create or replace function guard_telegram_funding_authorization_update()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting(
      'hunch.telegram_funding_retention_cleanup',
      true
    ) is distinct from 'on' then
      raise exception 'telegram funding authorizations are retained evidence'
        using errcode = '23514';
    end if;
    return old;
  end if;
  if (
    new.id,
    new.user_id,
    new.telegram_user_id,
    new.privy_wallet_id,
    case
      when new.wallet_chain = 'ethereum'
        and new.wallet_address ~ '^0x[0-9a-fA-F]{40}$'
        then lower(new.wallet_address)
      else new.wallet_address
    end,
    new.wallet_chain,
    new.profile_id,
    new.security_class,
    new.signer_id,
    new.signer_fingerprint,
    new.policy_id,
    new.policy_fingerprint,
    new.venue_id,
    new.destination_option_id,
    new.venue_binding_option_id,
    new.source_network_id,
    case
      when new.source_network_id ~ '^evm:[1-9][0-9]*$'
        and new.source_asset_id ~ '^0x[0-9a-fA-F]{40}$'
        then lower(new.source_asset_id)
      else new.source_asset_id
    end,
    new.source_asset_decimals,
    new.destination_network_id,
    case
      when new.destination_network_id ~ '^evm:[1-9][0-9]*$'
        and new.destination_asset_id ~ '^0x[0-9a-fA-F]{40}$'
        then lower(new.destination_asset_id)
      else new.destination_asset_id
    end,
    new.destination_asset_decimals,
    new.granted_at,
    new.expires_at,
    new.created_at
  ) is distinct from (
    old.id,
    old.user_id,
    old.telegram_user_id,
    old.privy_wallet_id,
    case
      when old.wallet_chain = 'ethereum'
        and old.wallet_address ~ '^0x[0-9a-fA-F]{40}$'
        then lower(old.wallet_address)
      else old.wallet_address
    end,
    old.wallet_chain,
    old.profile_id,
    old.security_class,
    old.signer_id,
    old.signer_fingerprint,
    old.policy_id,
    old.policy_fingerprint,
    old.venue_id,
    old.destination_option_id,
    old.venue_binding_option_id,
    old.source_network_id,
    case
      when old.source_network_id ~ '^evm:[1-9][0-9]*$'
        and old.source_asset_id ~ '^0x[0-9a-fA-F]{40}$'
        then lower(old.source_asset_id)
      else old.source_asset_id
    end,
    old.source_asset_decimals,
    old.destination_network_id,
    case
      when old.destination_network_id ~ '^evm:[1-9][0-9]*$'
        and old.destination_asset_id ~ '^0x[0-9a-fA-F]{40}$'
        then lower(old.destination_asset_id)
      else old.destination_asset_id
    end,
    old.destination_asset_decimals,
    old.granted_at,
    old.expires_at,
    old.created_at
  ) then
    raise exception 'telegram funding authorization identity is immutable'
      using errcode = '23514';
  end if;
  if new.user_wallet_id is distinct from old.user_wallet_id then
    if old.user_wallet_id is not null and new.user_wallet_id is null then
      if old.revoked_at is null then
        new.revoked_at := greatest(transaction_timestamp(), old.granted_at);
        new.updated_at := greatest(new.updated_at, new.revoked_at);
      end if;
    else
      raise exception 'telegram funding authorization wallet link is immutable'
        using errcode = '23514';
    end if;
  end if;
  if new.telegram_account_id is distinct from old.telegram_account_id
     and not (
       old.telegram_account_id is not null
       and new.telegram_account_id is null
     ) then
    raise exception 'telegram funding authorization account link is immutable'
      using errcode = '23514';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'telegram funding authorization revocation is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Slice C originally froze only the exact presentation mode. Backfill those
-- two known immutable modes once; runtime code must never infer presentation
-- from live capability or newer route constants.
--
-- Consent evidence is append-only at runtime. This migration is the one
-- controlled exception: the trigger is disabled only around a deterministic
-- enrichment from fields already frozen in the same row. PostgreSQL executes
-- migrations transactionally, so the trigger cannot remain disabled after a
-- failed migration.
alter table telegram_funding_consents
  disable trigger telegram_funding_consents_evidence_guard;

update telegram_funding_consents
set automation_policy_snapshot = jsonb_set(
  automation_policy_snapshot,
  '{presentation}',
  case automation_policy_snapshot ->> 'presentationMode'
    when 'pusd_direct' then jsonb_build_object(
      'version', 1,
      'routeKey', 'polymarket_polygon_pusd_direct_v1',
      'venueId', 'polymarket',
      'venueLabel', 'Polymarket',
      'networkId', 'evm:137',
      'networkLabel', 'Polygon',
      'destinationAssetSymbol', 'pUSD',
      'acceptedAssetSymbols', jsonb_build_array('pUSD'),
      'selectionButtonLabel', 'pUSD on Polygon — direct',
      'settlementLabel', 'Direct',
      'instructions', jsonb_build_array(
        'Send only pUSD on Polygon.',
        'Other assets cannot be routed from this Telegram flow.'
      ),
      'decimals', 6
    )
    when 'pusd_or_usdce_automatic' then jsonb_build_object(
      'version', 1,
      'routeKey', 'polymarket_polygon_pusd_usdce_v1',
      'venueId', 'polymarket',
      'venueLabel', 'Polymarket',
      'networkId', 'evm:137',
      'networkLabel', 'Polygon',
      'destinationAssetSymbol', 'pUSD',
      'acceptedAssetSymbols', jsonb_build_array('pUSD', 'USDC.e'),
      'automaticSourceAssetSymbol', 'USDC.e',
      'selectionButtonLabel', 'pUSD / USDC.e on Polygon',
      'settlementLabel', 'Direct / automatic 1:1 conversion',
      'instructions', jsonb_build_array(
        'Send pUSD or USDC.e on Polygon.',
        'pUSD is credited directly.',
        'USDC.e is automatically converted 1:1 to pUSD.'
      ),
      'decimals', 6
    )
  end,
  true
)
where not (automation_policy_snapshot ? 'presentation')
  and automation_policy_snapshot ->> 'presentationMode' in (
    'pusd_direct',
    'pusd_or_usdce_automatic'
  );

alter table telegram_funding_consents
  enable trigger telegram_funding_consents_evidence_guard;

-- Historical v1 projections did not carry the presentation they rendered.
-- Upgrade only the current and retained terminal projections from the exact
-- consent revision that produced them. Runtime parsing can then reject v1
-- outright instead of reconstructing history from today's route constants.
with frozen_presentation as (
  select
    context.id as funding_session_id,
    consent.automation_policy_snapshot -> 'presentation' as presentation
  from telegram_funding_sessions context
  join telegram_funding_consents consent
    on consent.telegram_funding_session_id = context.id
   and consent.revision = case
     when context.projected_consent_revision > 0
       then context.projected_consent_revision
     else context.active_consent_revision
   end
  where jsonb_typeof(
    consent.automation_policy_snapshot -> 'presentation'
  ) = 'object'
)
update telegram_funding_sessions context
set latest_progress_projection = case
      when context.latest_progress_projection ->> 'version' = '1' then
        jsonb_set(
          jsonb_set(
            context.latest_progress_projection,
            '{version}',
            '2'::jsonb,
            false
          ),
          '{presentation}',
          frozen.presentation,
          true
        )
      else context.latest_progress_projection
    end,
    latest_terminal_projection = case
      when context.latest_terminal_projection ->> 'version' = '1' then
        jsonb_set(
          jsonb_set(
            context.latest_terminal_projection,
            '{version}',
            '2'::jsonb,
            false
          ),
          '{presentation}',
          frozen.presentation,
          true
        )
      else context.latest_terminal_projection
    end,
    -- Force one generic re-projection after deploy. The projector replaces
    -- this marker with the canonical v2 fingerprint.
    progress_fingerprint = case
      when context.latest_progress_projection ->> 'version' = '1'
        then 'migration-0206-reproject'
      else context.progress_fingerprint
    end,
    projection_checked_at = case
      when context.latest_progress_projection ->> 'version' = '1'
        then null
      else context.projection_checked_at
    end
from frozen_presentation frozen
where context.id = frozen.funding_session_id
  and (
    context.latest_progress_projection ->> 'version' = '1'
    or context.latest_terminal_projection ->> 'version' = '1'
  );

with frozen_presentation as (
  select
    context.id as funding_session_id,
    context.progress_revision,
    context.latest_terminal_revision,
    consent.automation_policy_snapshot -> 'presentation' as presentation
  from telegram_funding_sessions context
  join telegram_funding_consents consent
    on consent.telegram_funding_session_id = context.id
   and consent.revision = case
     when context.projected_consent_revision > 0
       then context.projected_consent_revision
     else context.active_consent_revision
   end
  where jsonb_typeof(
    consent.automation_policy_snapshot -> 'presentation'
  ) = 'object'
)
update telegram_bot_action_outbox outbox
set payload = jsonb_set(
  jsonb_set(outbox.payload, '{version}', '2'::jsonb, false),
  '{presentation}',
  frozen.presentation,
  true
)
from frozen_presentation frozen
where outbox.funding_session_id = frozen.funding_session_id
  and outbox.state_revision in (
    frozen.progress_revision,
    frozen.latest_terminal_revision
  )
  and outbox.payload ->> 'version' = '1';

-- Terminal evidence is absorbing for one receive context. Older application
-- versions could retain an address-free terminal projection while replacing
-- the current projection with an address-bearing nonterminal one. Repair the
-- split state synchronously so no delivery or QR callback can race the first
-- post-deploy projector pass.
update telegram_funding_sessions context
set latest_progress_projection = context.latest_terminal_projection,
    progress_fingerprint = 'migration-0206-terminal-absorbed',
    projection_checked_at = null,
    updated_at = now()
where context.latest_terminal_projection is not null
  and context.latest_progress_projection is distinct from
      context.latest_terminal_projection;

-- Address disclosure is proven only by a successful durable Telegram CAS.
-- The message id captured when a callback opens a context is merely an edit
-- target and must never be treated as evidence that an address was shown.
alter table telegram_funding_sessions
  add column address_disclosure_attempt_revision integer not null default 0,
  add column address_disclosure_message_id bigint,
  add column address_delivered_revision integer not null default 0,
  add column address_redacted_revision integer not null default 0,
  add constraint telegram_funding_sessions_address_delivery_check
    check (
      address_disclosure_attempt_revision >= 0
      and address_disclosure_attempt_revision <= progress_revision
      and address_delivered_revision >= 0
      and address_delivered_revision <= progress_revision
      and address_delivered_revision <= address_disclosure_attempt_revision
      and address_redacted_revision >= 0
      and address_redacted_revision <= progress_revision
      and (
        address_delivered_revision = 0
        or address_disclosure_message_id is not null
      )
      and (
        address_redacted_revision = 0
        or (
          address_disclosure_message_id is not null
          and address_redacted_revision > address_disclosure_attempt_revision
        )
      )
    );

-- A Telegram request may have succeeded even when the process died before it
-- could record the response. Preserve an obligation only when its exact card
-- is known and unambiguous; targetless historical attempts cannot be redacted
-- safely and must not block an availability-critical migration.
with attempted as (
  select
    address_attempt.funding_session_id,
    address_attempt.state_revision,
    address_attempt.telegram_message_id
  from telegram_bot_action_outbox address_attempt
  where address_attempt.action in (
    'funding_send',
    'funding_edit',
    'funding_replacement',
    'funding_qr'
  )
    and jsonb_typeof(address_attempt.payload -> 'receiveAddress') = 'string'
    and length(trim(address_attempt.payload ->> 'receiveAddress')) > 0
    and (
      address_attempt.attempt_count > 0
      or address_attempt.delivery_attempt_id is not null
      or address_attempt.delivery_started_at is not null
      or address_attempt.sent_at is not null
      or address_attempt.status in ('sending', 'delivery_unknown', 'sent')
    )
), unresolved as (
  select attempted.*
  from attempted
  where attempted.telegram_message_id is null
     or not exists (
       select 1
       from telegram_bot_action_outbox redaction
       where redaction.funding_session_id = attempted.funding_session_id
         and redaction.action = 'funding_edit'
         and redaction.status = 'sent'
         and redaction.telegram_message_id = attempted.telegram_message_id
         and redaction.state_revision > attempted.state_revision
         and (
           not (redaction.payload ? 'receiveAddress')
           or redaction.payload -> 'receiveAddress' = 'null'::jsonb
         )
     )
), outstanding as (
  select
    funding_session_id,
    max(state_revision) as revision,
    min(telegram_message_id) as telegram_message_id
  from unresolved
  where telegram_message_id is not null
  group by funding_session_id
  having count(distinct telegram_message_id) = 1
)
update telegram_funding_sessions context
set address_disclosure_attempt_revision = attempted.revision,
    address_disclosure_message_id = attempted.telegram_message_id
from outstanding attempted
where context.id = attempted.funding_session_id;

update telegram_funding_sessions context
set address_delivered_revision = delivered.revision
from (
  select
    outbox.funding_session_id,
    max(outbox.state_revision) as revision
  from telegram_bot_action_outbox outbox
  join telegram_funding_sessions context
    on context.id = outbox.funding_session_id
  where outbox.action in ('funding_send', 'funding_edit', 'funding_replacement')
    and outbox.status = 'sent'
    and outbox.telegram_message_id = context.address_disclosure_message_id
    and jsonb_typeof(outbox.payload->'receiveAddress') = 'string'
    and length(trim(outbox.payload->>'receiveAddress')) > 0
  group by outbox.funding_session_id
) delivered
where context.id = delivered.funding_session_id;

-- A newer notification or replacement does not prove that the disclosed card
-- was overwritten. Only a confirmed address-free edit of that same immutable
-- Telegram message is redaction evidence.
update telegram_funding_sessions context
set address_redacted_revision = redacted.revision
from (
  select
    outbox.funding_session_id,
    max(outbox.state_revision) as revision
  from telegram_bot_action_outbox outbox
  join telegram_funding_sessions context
    on context.id = outbox.funding_session_id
  where outbox.action = 'funding_edit'
    and outbox.status = 'sent'
    and outbox.telegram_message_id = context.address_disclosure_message_id
    and outbox.state_revision > context.address_disclosure_attempt_revision
    and (
      not (outbox.payload ? 'receiveAddress')
      or outbox.payload -> 'receiveAddress' = 'null'::jsonb
    )
  group by outbox.funding_session_id
) redacted
where context.id = redacted.funding_session_id;

-- Preserve the evidence above before replacing unsafe queued payloads. Reuse
-- an exact current edit when possible, suppress every other pending address
-- payload, then ensure an outstanding disclosure has an immediate durable
-- address-free edit at the current revision.
update telegram_funding_sessions context
set progress_revision = context.progress_revision + 1,
    latest_terminal_revision = context.progress_revision + 1,
    latest_progress_projection = context.latest_terminal_projection,
    projection_checked_at = null,
    updated_at = now()
where context.latest_terminal_projection is not null
  and (
    context.progress_fingerprint = 'migration-0206-terminal-absorbed'
    or context.address_disclosure_attempt_revision >
       context.address_redacted_revision
  );

update telegram_bot_action_outbox outbox
set payload = context.latest_terminal_projection,
    status = 'pending',
    attempt_count = 0,
    next_attempt_at = now(),
    telegram_message_id = null,
    last_error = null,
    sent_at = null,
    delivery_attempt_id = null,
    delivery_started_at = null,
    updated_at = now()
from telegram_funding_sessions context
where context.id = outbox.funding_session_id
  and context.latest_terminal_projection is not null
  and outbox.action = 'funding_edit'
  and outbox.state_revision = context.progress_revision
  and outbox.status in ('pending', 'retry')
  and jsonb_typeof(outbox.payload -> 'receiveAddress') = 'string'
  and length(trim(outbox.payload ->> 'receiveAddress')) > 0;

update telegram_bot_action_outbox outbox
set status = 'skipped',
    last_error = 'funding_terminal_absorbed',
    updated_at = now()
from telegram_funding_sessions context
where context.id = outbox.funding_session_id
  and context.latest_terminal_projection is not null
  and outbox.status in ('pending', 'retry')
  and jsonb_typeof(outbox.payload -> 'receiveAddress') = 'string'
  and length(trim(outbox.payload ->> 'receiveAddress')) > 0;

insert into telegram_bot_action_outbox (
  action,
  telegram_account_id,
  user_id,
  telegram_user_id,
  funding_session_id,
  state_revision,
  payload
)
select
  'funding_edit',
  context.telegram_account_id,
  context.user_id,
  context.telegram_user_id,
  context.id,
  context.progress_revision,
  context.latest_terminal_projection
from telegram_funding_sessions context
where context.latest_terminal_projection is not null
  and context.address_disclosure_attempt_revision >
      context.address_redacted_revision
  and context.address_disclosure_message_id is not null
on conflict do nothing;

-- Relinking may rearm ordinary terminal delivery, but it must never replace a
-- card whose address redaction is still unproven. In that case only a frozen,
-- address-free edit of the known message id is eligible for retry. If no such
-- edit exists yet, the projector remains responsible for creating it.
create or replace function rearm_telegram_funding_delivery(
  target_telegram_user_id text,
  target_telegram_account_id uuid
)
returns integer
language plpgsql
as $$
declare
  rearmed_count integer := 0;
  affected_count integer := 0;
  recovery record;
  stale_attempt record;
begin
  for stale_attempt in
    select
      outbox.id,
      outbox.delivery_attempt_id,
      context.id as context_id
    from telegram_bot_action_outbox outbox
    join telegram_funding_sessions context
      on context.id = outbox.funding_session_id
    join user_telegram_accounts account
      on account.id = target_telegram_account_id
     and account.user_id = context.user_id
     and account.telegram_user_id = context.telegram_user_id
    where context.telegram_user_id = target_telegram_user_id
      and outbox.action in ('funding_send', 'funding_replacement')
      and outbox.status = 'sending'
      and outbox.updated_at <= now() - interval '5 minutes'
    for update of outbox, context
  loop
    update telegram_bot_action_outbox outbox
    set status = 'delivery_unknown',
        last_error = 'funding_send_outcome_unknown',
        updated_at = now()
    where outbox.id = stale_attempt.id
      and outbox.status = 'sending';

    update telegram_funding_sessions context
    set delivery_lease_outbox_id = null,
        delivery_lease_attempt_id = null,
        delivery_lease_expires_at = null
    where context.id = stale_attempt.context_id
      and context.delivery_lease_outbox_id = stale_attempt.id
      and context.delivery_lease_attempt_id = stale_attempt.delivery_attempt_id;
  end loop;

  update telegram_funding_sessions context
  set telegram_account_id = target_telegram_account_id
  from user_telegram_accounts account
  where account.id = target_telegram_account_id
    and account.telegram_user_id = target_telegram_user_id
    and account.user_id = context.user_id
    and context.telegram_user_id = target_telegram_user_id
    and context.telegram_account_id is distinct from target_telegram_account_id;

  for recovery in
    select
      context.id,
      context.user_id,
      context.telegram_user_id,
      case
        when context.address_disclosure_attempt_revision >
             context.address_redacted_revision
          then 'funding_edit'
        else 'funding_replacement'
      end as delivery_action,
      case
        when context.address_disclosure_attempt_revision >
             context.address_redacted_revision
          then redaction.state_revision
        when exists (
          select 1
          from telegram_bot_action_outbox unknown
          where unknown.funding_session_id = context.id
            and unknown.status = 'delivery_unknown'
        ) then context.progress_revision
        else context.latest_terminal_revision
      end as delivery_revision,
      case
        when context.address_disclosure_attempt_revision >
             context.address_redacted_revision
          then redaction.payload
        when exists (
          select 1
          from telegram_bot_action_outbox unknown
          where unknown.funding_session_id = context.id
            and unknown.status = 'delivery_unknown'
        ) then context.latest_progress_projection
        else context.latest_terminal_projection
      end as delivery_projection
    from telegram_funding_sessions context
    join user_telegram_accounts account
      on account.id = target_telegram_account_id
     and account.user_id = context.user_id
     and account.telegram_user_id = context.telegram_user_id
    left join lateral (
      select outbox.state_revision, outbox.payload
      from telegram_bot_action_outbox outbox
      where outbox.funding_session_id = context.id
        and outbox.action = 'funding_edit'
        and outbox.state_revision > context.address_disclosure_attempt_revision
        and outbox.payload ->> 'terminal' = 'true'
        and (
          not (outbox.payload ? 'receiveAddress')
          or outbox.payload -> 'receiveAddress' = 'null'::jsonb
        )
      order by outbox.state_revision desc, outbox.created_at desc
      limit 1
    ) redaction on true
    where context.telegram_user_id = target_telegram_user_id
      and context.latest_progress_projection is not null
      and (
        (
          context.address_disclosure_attempt_revision >
            context.address_redacted_revision
          and context.address_disclosure_message_id is not null
          and redaction.state_revision is not null
        )
        or (
          context.address_disclosure_attempt_revision <=
            context.address_redacted_revision
          and (
            (
              (
                context.latest_terminal_revision > context.last_delivered_revision
                or (
                  context.latest_terminal_revision is not null
                  and not exists (
                    select 1
                    from telegram_bot_action_outbox delivered
                    where delivered.funding_session_id = context.id
                      and delivered.state_revision = context.latest_terminal_revision
                      and delivered.telegram_account_id = target_telegram_account_id
                      and delivered.action in (
                        'funding_send',
                        'funding_edit',
                        'funding_replacement'
                      )
                      and delivered.status = 'sent'
                  )
                )
              )
              and (
                not (context.latest_terminal_projection ? 'receiveAddress')
                or context.latest_terminal_projection -> 'receiveAddress' =
                    'null'::jsonb
              )
            )
            or (
              exists (
                select 1
                from telegram_bot_action_outbox unknown
                where unknown.funding_session_id = context.id
                  and unknown.status = 'delivery_unknown'
              )
              and (
                not (context.latest_progress_projection ? 'receiveAddress')
                or context.latest_progress_projection -> 'receiveAddress' =
                    'null'::jsonb
              )
            )
          )
        )
      )
      and not exists (
        select 1
        from telegram_bot_action_outbox active_attempt
        where active_attempt.funding_session_id = context.id
          and active_attempt.status = 'sending'
      )
    for update of context
  loop
    update telegram_funding_sessions context
    set telegram_account_id = target_telegram_account_id,
        delivery_lease_outbox_id = null,
        delivery_lease_attempt_id = null,
        delivery_lease_expires_at = null
    where context.id = recovery.id;

    update telegram_bot_action_outbox outbox
    set status = 'skipped',
        last_error = 'funding_delivery_rearmed',
        updated_at = now()
    where outbox.funding_session_id = recovery.id
      and outbox.action in ('funding_send', 'funding_edit', 'funding_replacement')
      and outbox.status in ('pending', 'retry', 'delivery_unknown');

    insert into telegram_bot_action_outbox (
      action,
      telegram_account_id,
      user_id,
      telegram_user_id,
      funding_session_id,
      state_revision,
      payload
    ) values (
      recovery.delivery_action,
      target_telegram_account_id,
      recovery.user_id,
      recovery.telegram_user_id,
      recovery.id,
      recovery.delivery_revision,
      recovery.delivery_projection
    )
    on conflict (funding_session_id, state_revision, action)
      where action in ('funding_send', 'funding_edit', 'funding_replacement')
    do update
      set telegram_account_id = excluded.telegram_account_id,
          payload = excluded.payload,
          status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          last_error = null,
          delivery_attempt_id = null,
          delivery_started_at = null,
          sent_at = null,
          updated_at = now();
    get diagnostics affected_count = row_count;
    rearmed_count := rearmed_count + affected_count;
  end loop;
  return rearmed_count;
end;
$$;

-- Funding QR is an edit of the already-known funding card, never a new photo
-- message. That keeps the delivery outcome recoverable and gives revocation one
-- exact message id to overwrite.
alter table telegram_bot_action_outbox
  drop constraint telegram_bot_action_outbox_action_check,
  drop constraint telegram_bot_action_outbox_shape_check,
  drop constraint telegram_bot_action_outbox_delivery_attempt_check;

alter table telegram_bot_action_outbox
  add constraint telegram_bot_action_outbox_action_check
    check (
      action in (
        'welcome_menu',
        'funding_send',
        'funding_edit',
        'funding_replacement',
        'funding_qr'
      )
    ),
  add constraint telegram_bot_action_outbox_shape_check
    check (
      (
        action = 'welcome_menu'
        and telegram_account_id is not null
        and funding_session_id is null
        and state_revision is null
        and payload is null
        and delivery_attempt_id is null
        and delivery_started_at is null
      )
      or (
        action in (
          'funding_send',
          'funding_edit',
          'funding_replacement',
          'funding_qr'
        )
        and funding_session_id is not null
        and state_revision > 0
        and jsonb_typeof(payload) = 'object'
      )
    ),
  add constraint telegram_bot_action_outbox_delivery_attempt_check
    check (
      (
        delivery_attempt_id is null
        and delivery_started_at is null
      )
      or (
        delivery_attempt_id is not null
        and delivery_started_at is not null
        and action in (
          'funding_send',
          'funding_edit',
          'funding_replacement',
          'funding_qr'
        )
      )
    ),
  -- Address disclosure is never a new or replacement message: only an edit of
  -- the immutable message id already retained by the funding session. NOT
  -- VALID preserves any pre-migration evidence rows while enforcing the rule
  -- for every new/updated row immediately.
  add constraint telegram_bot_action_outbox_address_egress_check
    check (
      action not in ('funding_send', 'funding_replacement')
      or not (payload ? 'receiveAddress')
      or payload -> 'receiveAddress' = 'null'::jsonb
    ) not valid;

create unique index telegram_bot_action_outbox_funding_qr_unique
  on telegram_bot_action_outbox (funding_session_id, action)
  where action = 'funding_qr';

-- Telegram callbacks are delivered at least once. Retain the exact conversion
-- review response so replay cannot replace its own quote/consent token.
alter table telegram_funding_mutations
  add column review_receipt_id uuid,
  add column review_quote_id uuid,
  add constraint telegram_funding_mutations_review_receipt_fk
    foreign key (review_receipt_id)
    references funding_receive_receipts(id) on delete restrict,
  add constraint telegram_funding_mutations_review_quote_fk
    foreign key (review_quote_id)
    references funding_quotes(id) on delete restrict;

alter table telegram_funding_mutations
  drop constraint telegram_funding_mutations_action_check,
  drop constraint telegram_funding_mutations_action_shape_check;

alter table telegram_funding_mutations
  add constraint telegram_funding_mutations_action_check check (
    action in (
      'open',
      'select_target',
      'cancel',
      'set_buy_return',
      'resume_buy',
      'review_conversion'
    )
  ),
  add constraint telegram_funding_mutations_action_shape_check check (
    (action = 'select_target' and consent_revision is not null
      and buy_return_revision is null and resume_generation is null
      and resume_intent_id is null and continuation_id is null
      and review_receipt_id is null and review_quote_id is null)
    or (action = 'set_buy_return' and consent_revision is null
      and buy_return_revision is not null and resume_generation is null
      and resume_intent_id is null and continuation_id is null
      and review_receipt_id is null and review_quote_id is null)
    or (action = 'resume_buy' and consent_revision is null
      and buy_return_revision is not null and resume_generation is not null
      and resume_intent_id is not null and continuation_id is not null
      and review_receipt_id is null and review_quote_id is null)
    or (action = 'review_conversion' and consent_revision is null
      and buy_return_revision is null and resume_generation is null
      and resume_intent_id is null and continuation_id is null
      and review_receipt_id is not null and review_quote_id is not null)
    or (action in ('open', 'cancel') and consent_revision is null
      and buy_return_revision is null and resume_generation is null
      and resume_intent_id is null and continuation_id is null
      and review_receipt_id is null and review_quote_id is null)
  );
