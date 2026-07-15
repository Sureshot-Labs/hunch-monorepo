ALTER TABLE unified_markets
  ADD COLUMN IF NOT EXISTS resolution_observed_at timestamptz;

COMMENT ON COLUMN unified_markets.resolution_observed_at IS
  'First time Hunch observed this market transition from unresolved to resolved. Existing resolved rows are intentionally not backfilled.';

CREATE OR REPLACE FUNCTION set_unified_market_resolution_observed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.resolution_observed_at IS NULL
     AND (NEW.resolved_outcome IS NOT NULL OR NEW.resolved_outcome_pct IS NOT NULL) THEN
    IF TG_OP = 'INSERT'
       OR (OLD.resolved_outcome IS NULL AND OLD.resolved_outcome_pct IS NULL) THEN
      NEW.resolution_observed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_unified_market_resolution_observed_at
  ON unified_markets;

CREATE TRIGGER trg_unified_market_resolution_observed_at
BEFORE INSERT OR UPDATE OF resolved_outcome, resolved_outcome_pct
ON unified_markets
FOR EACH ROW
EXECUTE FUNCTION set_unified_market_resolution_observed_at();
