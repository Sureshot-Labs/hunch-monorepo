/* no-transaction */
-- Exact order pages must not scan unrelated account history before LIMIT.
-- Retrying an interrupted concurrent build must replace its invalid artifact,
-- not silently skip it via IF NOT EXISTS. This new migration owns this name.
drop index concurrently if exists hip4_account_executions_order_idx;
create index concurrently hip4_account_executions_order_idx
  on hip4_account_executions(environment,account_address,coin,oid,time_ms,tid);
