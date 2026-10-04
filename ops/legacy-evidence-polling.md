# Stop historical evidence polling without inventing a financial outcome

The `legacyEvidencePolling` metadata control stops **new evidence leases only**.
It does not cancel a venue order, change an amount/status/reservation, or prevent
an already leased worker from saving a positive canonical receipt. There is no
automatic age-based closing of ambiguous transactions.

Deploy code supporting this control **before** considering polling stopped.
Old images ignore the control. No migration or scheduler change is required.

Confirmed October 4, 2026 scope (UTC cutoff September 1):

- Polymarket attempt `57e72ba3-4637-4a27-8e3f-30d3187e0def`, operation
  `d2338926-dd39-4ca3-8bba-e599ad08f389`: funding completed, no current lock,
  CLOB lookup returned no order. That is unknown, not proven rejection.
- deBridge `31c73ec6-78f4-4674-b7ee-94d0f4e7486a` and
  `eea63c47-a8a7-45d7-93ad-1ac92babc8dd`: source transactions exist, canonical
  destination evidence is incomplete. Do not label either failed/not sent.

## Fresh read-only preflight

Use bounded timeouts and an explicit read-only transaction. All three records
must still meet the criteria below; inspect the output before any update.
Otherwise stop and investigate the changed record, rather than broadening scope.

```sql
begin read only;
set local statement_timeout = '8s';
select attempt.id, attempt.state, operation_row.status,
       operation_row.support_metadata -> 'legacyEvidencePolling' as polling_control,
       exists (select 1 from balance_reservations reservation_row
         where reservation_row.operation_id = operation_row.id
           and reservation_row.state = 'active' and reservation_row.expires_at > now()) as current_lock,
       exists (select 1 from orders stored_order
         where stored_order.user_id = attempt.user_id
           and stored_order.funding_trade_attempt_id = attempt.id) as linked_order
from funding_trade_attempts attempt join funding_operations operation_row
  on operation_row.id = attempt.operation_id and operation_row.user_id = attempt.user_id
where attempt.id = '57e72ba3-4637-4a27-8e3f-30d3187e0def';
select id, status, adapter_version, created_at,
       metadata -> 'legacyEvidencePolling' as polling_control,
       metadata #>> '{legacyEvidenceRecovery,evidence}' as destination_evidence
from bridge_orders where id in ('31c73ec6-78f4-4674-b7ee-94d0f4e7486a', 'eea63c47-a8a7-45d7-93ad-1ac92babc8dd');
rollback;
```

## Scoped operational annotation

After explicit operational authorization and deployment, run the following in a
transaction with `statement_timeout = '8s'` and `lock_timeout = '3s'`. Inspect
RETURNING output: one operation and two bridges, financial states unchanged.
If the counts differ, ROLLBACK. This is maintenance, **not a deploy migration**.

```sql
update funding_operations operation_row
set support_metadata = jsonb_set(coalesce(operation_row.support_metadata, '{}'::jsonb), '{legacyEvidencePolling}',
  jsonb_build_object('version', 1, 'state', 'paused', 'kind', 'polymarket_orphan_attempt',
    'recordId', '57e72ba3-4637-4a27-8e3f-30d3187e0def', 'reason', 'historical_unknown', 'changedAt', now())),
    version = operation_row.version + 1, updated_at = clock_timestamp()
where operation_row.id = 'd2338926-dd39-4ca3-8bba-e599ad08f389' and operation_row.status = 'completed'
  and jsonb_typeof(coalesce(operation_row.support_metadata, '{}'::jsonb)) = 'object'
  and exists (select 1 from funding_trade_attempts attempt
    where attempt.id = '57e72ba3-4637-4a27-8e3f-30d3187e0def' and attempt.operation_id = operation_row.id
      and attempt.user_id = operation_row.user_id and attempt.execution_path = 'polymarket_clob'
      and attempt.created_at < '2026-09-01T00:00:00Z' and attempt.state = 'ambiguous'
      and attempt.broadcast_may_have_occurred and attempt.external_reference ~ '^0x[0-9a-fA-F]{64}$'
      and not exists (select 1 from orders stored_order where stored_order.user_id = attempt.user_id
        and stored_order.funding_trade_attempt_id = attempt.id))
  and not exists (select 1 from balance_reservations reservation_row
    where reservation_row.operation_id = operation_row.id
      and reservation_row.state = 'active' and reservation_row.expires_at > now())
returning id, status, support_metadata -> 'legacyEvidencePolling' as polling_control;

update bridge_orders bridge_row
set metadata = jsonb_set(coalesce(bridge_row.metadata, '{}'::jsonb), '{legacyEvidencePolling}',
  jsonb_build_object('version', 1, 'state', 'paused', 'kind', 'legacy_debridge',
    'recordId', bridge_row.id::text, 'reason', 'historical_unknown', 'changedAt', now()))
where bridge_row.id in ('31c73ec6-78f4-4674-b7ee-94d0f4e7486a', 'eea63c47-a8a7-45d7-93ad-1ac92babc8dd')
  and bridge_row.provider = 'debridge' and bridge_row.status = 'submitted'
  and bridge_row.created_at < '2026-09-01T00:00:00Z' and bridge_row.tx_hash_src is not null
  and bridge_row.adapter_version in ('debridge_dln_create_tx_v1', 'debridge_same_chain_v1', 'debridge_same_chain_tx_v0')
  and jsonb_typeof(coalesce(bridge_row.metadata, '{}'::jsonb)) = 'object'
  and bridge_row.metadata #>> '{legacyEvidenceRecovery,evidence}' is distinct from 'canonical_destination_receipt_v1'
returning id, status, metadata -> 'legacyEvidencePolling' as polling_control;
```

## Resume and verification

For the exact annotated ID, change only
`{legacyEvidencePolling,state}` to JSON string `"active"`, retaining the audit
fields; verify the current control's version/kind/recordId before updating.
For `funding_operations`, also increment `version` and update `updated_at`, as
required by its immutable-plan trigger; do not disable that trigger.
This re-enables ordinary evidence leases when any **existing** in-flight lease
expires (at most its normal five minutes). Do not reset a claim token/lease or
revive the historical Buy. A bridge without an in-flight lease is immediately
eligible. Positive evidence can still complete a paused record.

After pause and the existing leases expire, check that the three records stop
receiving new claim tokens / `legacyEvidenceRecovery.leaseToken` updates. Fresh
unannotated attempts and bridges must continue through their existing paths.
Leave dead-letter jobs on completed operations and unrelated receive receipts
alone. Do not use this control to hide unknown venue orders in Open Orders.
