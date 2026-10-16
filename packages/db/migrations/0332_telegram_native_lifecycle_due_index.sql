/* no-transaction */
-- Derived lifecycle work only. Do not repeatedly scan terminal native history
-- or reinterpret optional legacy JSON as a deployment-blocking invariant.
-- Keep predicate aligned with repos/telegram-native-lifecycle-due.ts.
drop index concurrently if exists telegram_native_lifecycle_due_idx;
create index concurrently telegram_native_lifecycle_due_idx
  on telegram_trade_intents((result->'shortfallProgress' is not null),updated_at desc,id)
  where venue='hyperliquid'
    and delivery_mode='app_handoff'
    and (
      result->'shortfallProgress' is null
      or status not in ('filled','failed','cancelled','expired')
      or floor(extract(epoch from updated_at at time zone 'UTC')*1000000)::bigint >
        case when result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}' ~ '^[0-9]{1,18}$'
          then (result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}')::bigint
          else -1 end
      or funding_operation_id is not null
    );
