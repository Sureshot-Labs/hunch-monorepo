-- Classification facts, not operation progress or a second financial ledger.
-- No backfill: absent means revision 0. Retain UUID-only tombstones on deletion
-- so a vanished/recreated operation cannot make an old scan current again.
create table funding_classification_revisions (
  operation_id uuid primary key,
  revision bigint not null check (revision >= 0)
);

-- Private to the writing transaction. The deferred drain removes every row
-- before commit; rollback removes both staging and any speculative increment.
-- No FK here or above: an F -> operation lock would invert the existing order.
create table funding_classification_touches (
  transaction_id xid8 not null,
  operation_id uuid not null,
  primary key (transaction_id, operation_id)
);

create function funding_classification_pick(fact_row jsonb, field_names text[])
returns jsonb language sql immutable parallel safe as $$
  select coalesce(jsonb_object_agg(fact_field.key, fact_field.value), '{}'::jsonb)
  from jsonb_each(fact_row) fact_field where fact_field.key = any(field_names)
$$;

-- This allowlist is the dependency contract for source actions, recorded
-- refunds, exact handoff and owned-route destination classification. Expanding
-- those readers requires expanding this projection in a new migration too.
-- Poll timestamps/confirmations, watch cursors and error diagnostics are not
-- financial facts; changing only those must not restart a dense paged scan.
create function funding_classification_projection(relation_name text, fact_row jsonb)
returns jsonb language plpgsql immutable parallel safe as $$
begin
  if fact_row is null then return null; end if;
  case relation_name
    when 'funding_operations' then
      return funding_classification_pick(fact_row, array[
        'id','user_id','plan_kind','status','source_snapshot','destination_target_snapshot']);
    when 'funding_operation_segments' then
      return funding_classification_pick(fact_row, array[
        'id','operation_id','provider_id','segment_kind','source_snapshot',
        'destination_target_snapshot','refund_location_snapshot','quoted_input',
        'quoted_expected_output','quoted_min_output','provider_quote_ref_ciphertext',
        'provider_quote_ref_lookup_hmac','lookup_key_version','raw_status'])
        || jsonb_build_object('provider_facts', funding_classification_pick(fact_row->'support_metadata', array[
          'relayStatusCategory','originTransactionReferenceCount','destinationTransactionReferenceCount',
          'relayTransactionReferenceFingerprints','relaySuccessfulDestinationReferenceHashesV1']));
    when 'funding_operation_steps' then
      return funding_classification_pick(fact_row, array[
        'id','operation_id','segment_id','ordinal','step_kind','executor_id',
        'action_fingerprint','normalized_action','action_validation_result']);
    when 'funding_operation_step_attempts' then
      return funding_classification_pick(fact_row, array[
        'id','step_id','attempt_number','canonical_action_fingerprint','executor_id',
        'outcome','broadcast_may_have_occurred','reference_kind','receipt_ref_ciphertext',
        'receipt_ref_lookup_hmac','lookup_key_version','started_at','finished_at'])
        || jsonb_build_object('submission_facts', funding_classification_pick(fact_row->'actual_costs',
          array['embeddedSubmission','safeSubmission']),
          'exact_synthetic_cancellation', fact_row->'actual_costs' = '{"reasonCode":"cancelled_after_safe_evidence"}'::jsonb);
    when 'funding_step_receipt_observations' then
      return funding_classification_pick(fact_row, array[
        'id','operation_id','step_id','attempt_id','network_id','status','canonical',
        'action_match','failure_code','ledger_height','block_hash'])
        || jsonb_build_object('receipt_facts', funding_classification_pick(fact_row->'evidence', array[
          'transactionHash','transactionSignature','handoffEventIndex','failureFinalized',
          'attributedSourceRaw','sourceDebitEventIndex','attributedDestinationRaw',
          'destinationCreditTransfers','nativeSourceEvidence']));
    when 'funding_observations' then
      return funding_classification_pick(fact_row, array[
        'id','operation_id','segment_id','kind','network_id','asset_id','asset_decimals',
        'tx_hash','event_index','from_address','to_address','raw_amount','ledger_height',
        'block_hash','canonical','finality_status'])
        || jsonb_build_object('observation_facts', funding_classification_pick(fact_row->'metadata', array[
          'observerId','receiptAttemptId','relayRefundReceipt','relayRefundCompletionProofs',
          'replacementForRefundObservationId','nativeDestinationDex']));
    when 'balance_reservations' then
      if fact_row->>'economic_role' is distinct from 'source_input' then return null; end if;
      return funding_classification_pick(fact_row, array[
        'id','user_id','operation_id','segment_id','economic_role','created_at',
        'location_id','network_id','asset_id','asset_decimals','raw_amount','mode']);
    else return null;
  end case;
end
$$;

create function funding_classification_touch() returns trigger language plpgsql as $$
declare
  previous_fact jsonb;
  next_fact jsonb;
  changed_fact jsonb;
  changed_operation uuid;
begin
  if tg_op <> 'INSERT' then
    previous_fact := funding_classification_projection(tg_table_name, to_jsonb(old));
  end if;
  if tg_op <> 'DELETE' then
    next_fact := funding_classification_projection(tg_table_name, to_jsonb(new));
  end if;
  if previous_fact is not distinct from next_fact then return null; end if;
  foreach changed_fact in array array[previous_fact, next_fact] loop
    if changed_fact is null then continue; end if;
    if tg_table_name = 'funding_operations' then
      changed_operation := (changed_fact->>'id')::uuid;
    elsif tg_table_name = 'funding_operation_step_attempts' then
      select operation_id into changed_operation from public.funding_operation_steps
      where id = (changed_fact->>'step_id')::uuid;
    else
      changed_operation := (changed_fact->>'operation_id')::uuid;
    end if;
    if changed_operation is not null then
      insert into public.funding_classification_touches (transaction_id, operation_id)
      values (pg_current_xact_id(), changed_operation) on conflict do nothing;
    end if;
  end loop;
  return null;
end
$$;

-- Drain deferred RI work before any revision lock. SET ALL IMMEDIATE would
-- also fire our deferred trigger early, so enumerate only foreign keys. This
-- is also used by the final publication fence after all DB effects are done.
create function funding_classification_finish_foreign_keys() returns void language plpgsql as $$
declare fk_names text;
begin
  select string_agg(format('%I.%I', schema_row.nspname, fk_row.conname), ','
    order by schema_row.nspname, fk_row.conname) into fk_names
  from pg_constraint fk_row join pg_namespace schema_row on schema_row.oid=fk_row.connamespace
  where fk_row.contype='f' and fk_row.condeferrable and schema_row.nspname='public';
  if fk_names is not null then execute 'set constraints ' || fk_names || ' immediate'; end if;
end
$$;

create function funding_classification_flush() returns trigger language plpgsql as $$
declare changed_operation uuid;
begin
  if not exists (select 1 from public.funding_classification_touches
    where transaction_id=pg_current_xact_id()) then return null; end if;
  perform funding_classification_finish_foreign_keys();
  -- Global transaction order, NOT the order of individual row-trigger events.
  for changed_operation in select operation_id from public.funding_classification_touches
    where transaction_id=pg_current_xact_id() order by operation_id
  loop
    insert into public.funding_classification_revisions as revision_row (operation_id, revision)
    values (changed_operation, 1)
    on conflict (operation_id) do update set revision=revision_row.revision+1;
  end loop;
  delete from public.funding_classification_touches where transaction_id=pg_current_xact_id();
  return null;
end
$$;

create constraint trigger funding_classification_deferred_flush
after insert on funding_classification_touches deferrable initially deferred
for each row execute function funding_classification_flush();

create trigger funding_classification_touch after insert or update or delete on funding_operations
for each row execute function funding_classification_touch();
create trigger funding_classification_touch after insert or update or delete on funding_operation_segments
for each row execute function funding_classification_touch();
create trigger funding_classification_touch after insert or update or delete on funding_operation_steps
for each row execute function funding_classification_touch();
create trigger funding_classification_touch after insert or update or delete on funding_operation_step_attempts
for each row execute function funding_classification_touch();
create trigger funding_classification_touch after insert or update or delete on funding_step_receipt_observations
for each row execute function funding_classification_touch();
create trigger funding_classification_touch after insert or update or delete on funding_observations
for each row execute function funding_classification_touch();
create trigger funding_classification_touch after insert or update or delete on balance_reservations
for each row execute function funding_classification_touch();

-- Final transaction statement before COMMIT. Callers already own physical
-- event locks, then operation locks, and have finished all financial writes.
-- Include staged-only IDs so commit cannot acquire an earlier F after a later F.
create function funding_classification_fence(expected_facts jsonb)
returns boolean language plpgsql as $$
declare
  fence_scope record;
  current_revision bigint;
  expected_revision bigint;
begin
  if jsonb_typeof(expected_facts) is distinct from 'array' then return false; end if;
  perform funding_classification_finish_foreign_keys();
  for fence_scope in
    with expected_rows as materialized (
      select (expected_fact->>'operationId')::uuid as operation_id,
        (expected_fact->>'revision')::bigint as revision
      from jsonb_array_elements(expected_facts) expected_fact
    ), fence_ids as (
      select operation_id from expected_rows
      union
      select operation_id from public.funding_classification_touches
        where transaction_id=pg_current_xact_id()
    )
    select fence_ids.operation_id,
      array_agg(expected_rows.revision) filter (where expected_rows.operation_id is not null) as expected_revisions
    from fence_ids left join expected_rows using (operation_id)
    group by fence_ids.operation_id order by fence_ids.operation_id
  loop
    -- Insert/lock each ID in the SAME order, including absent revision zero.
    insert into public.funding_classification_revisions (operation_id, revision)
    values (fence_scope.operation_id, 0) on conflict do nothing;
    select revision into current_revision from public.funding_classification_revisions
      where operation_id=fence_scope.operation_id for update;
    foreach expected_revision in array coalesce(fence_scope.expected_revisions, array[]::bigint[])
    loop
      if current_revision is distinct from expected_revision then return false; end if;
    end loop;
  end loop;
  return true;
end
$$;
