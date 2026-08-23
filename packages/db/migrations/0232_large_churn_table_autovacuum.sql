-- The global 20% vacuum scale factor permits millions of dead rows in the
-- wallet snapshot tables before autovacuum starts. Retention removes rows
-- continuously, so vacuum these tables after roughly 2% churn instead.
--
-- Keep the existing analyze settings: production statistics show that
-- autoanalyze already runs regularly, and lowering its threshold would add
-- work without addressing the observed dead-row accumulation.
ALTER TABLE public.wallet_position_snapshots
  SET (
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_scale_factor = 0.02
  );

ALTER TABLE public.wallet_metrics_snapshots
  SET (
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_scale_factor = 0.02
  );

-- unified_tokens is maintained with insert/delete replacement rather than
-- updates. A 5% threshold keeps deleted token rows and their index entries
-- reusable without approaching the global 20% threshold.
ALTER TABLE public.unified_tokens
  SET (
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_scale_factor = 0.05
  );

-- These hot feed tables already receive autovacuum, but the global 20%
-- threshold still allows substantial dead-row accumulation. Use a moderate
-- 10% threshold to reduce bloat without quadrupling vacuum frequency.
ALTER TABLE public.unified_markets
  SET (
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_scale_factor = 0.10
  );

ALTER TABLE public.polymarket_markets
  SET (
    autovacuum_vacuum_threshold = 10000,
    autovacuum_vacuum_scale_factor = 0.10
  );

ALTER TABLE public.unified_events
  SET (
    autovacuum_vacuum_threshold = 5000,
    autovacuum_vacuum_scale_factor = 0.10
  );
