/* no-transaction */
-- Keep direct/legacy probes from scanning the funded native source rotation.
-- Same tolerant derived-work predicate as 0332, narrowed to the direct lane.
create index concurrently telegram_native_direct_lifecycle_due_idx
  on telegram_trade_intents((result->'shortfallProgress' is not null),updated_at desc,id)
  where venue='hyperliquid' and delivery_mode='app_handoff'
    and funding_operation_id is null
    and (
      result->'shortfallProgress' is null
      or status not in ('filled','failed','cancelled','expired')
      or floor(extract(epoch from updated_at at time zone 'UTC')*1000000)::bigint >
        case when result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}' ~ '^[0-9]{1,18}$'
          then (result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}')::bigint
          else -1 end
      or funding_operation_id is not null
    );
create index concurrently telegram_legacy_lifecycle_branch_idx
  on telegram_trade_intents(updated_at desc,id)
  where venue<>'hyperliquid';
