CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_unified_events_title_trgm
  ON unified_events USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_unified_events_description_trgm
  ON unified_events USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_unified_events_category_trgm
  ON unified_events USING gin (category gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_unified_events_slug_trgm
  ON unified_events USING gin (slug gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_unified_markets_title_trgm
  ON unified_markets USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_unified_markets_description_trgm
  ON unified_markets USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_unified_markets_category_trgm
  ON unified_markets USING gin (category gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_unified_markets_slug_trgm
  ON unified_markets USING gin (slug gin_trgm_ops);
