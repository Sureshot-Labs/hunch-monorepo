SET statement_timeout = 0;

-- These refresh functions compare relatively small candidate sets against a
-- large current-hour Timescale bucket. With default nested-loop planning,
-- PL/pgSQL can repeatedly rescan the materialized bucket and spill tens of GB
-- of temp reads. Restrict the planner only for these maintenance functions.
ALTER FUNCTION refresh_unified_market_activity_snapshots_1h_incremental(interval)
  SET enable_nestloop = off;

ALTER FUNCTION refresh_unified_market_activity_metrics_1h()
  SET enable_nestloop = off;
