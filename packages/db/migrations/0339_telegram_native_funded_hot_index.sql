/* no-transaction */
-- Match the hot-source predicate in repos/telegram-native-lifecycle-page.ts.
-- Cached terminal progress affects priority only. Historical repair still
-- traverses ALL funded native sources through the separate UUID index.
create index concurrently telegram_native_funded_lifecycle_hot_idx
  on telegram_trade_intents((result->'shortfallProgress' is not null),updated_at desc,id)
  where venue='hyperliquid' and delivery_mode='app_handoff' and funding_operation_id is not null
    and (result->'shortfallProgress' is null
      or (status not in ('filled','failed','cancelled','expired')
        and coalesce(result#>>'{shortfallProgress,state}','') not in ('filled','failed','cancelled','stopped','quote_expired'))
      or floor(extract(epoch from updated_at at time zone 'UTC')*1000000)::bigint >
        case when result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}' ~ '^[0-9]{1,18}$'
          then (result#>>'{shortfallProgressSourceWatermark,intentUpdatedAtUs}')::bigint else -1 end);
