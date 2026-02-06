-- Keep planner stats fresh on hot feed tables to reduce plan instability.
ALTER TABLE unified_events
  SET (
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 1000
  );

ALTER TABLE unified_markets
  SET (
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 1000
  );
