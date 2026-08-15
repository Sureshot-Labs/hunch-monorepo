-- `unified_market_tokens` is refreshed frequently enough that the global
-- 20% vacuum threshold leaves a large amount of dead mapping rows in a table
-- whose cardinality is comparatively small.  Keep its statistics and free
-- space current without changing query indexes or running blocking maintenance
-- during this migration.  Autovacuum will perform the physical work normally.
ALTER TABLE public.unified_market_tokens
  SET (
    autovacuum_vacuum_threshold = 1000,
    autovacuum_vacuum_scale_factor = 0.005,
    autovacuum_analyze_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.0025
  );
