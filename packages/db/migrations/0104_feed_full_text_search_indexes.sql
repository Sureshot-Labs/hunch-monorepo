/* no-transaction */
SET statement_timeout = 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_events_feed_search_fts
  ON unified_events
  USING gin ((
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'D')
  ))
  WHERE status = 'ACTIVE';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_unified_markets_feed_search_fts
  ON unified_markets
  USING gin ((
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'D')
  ))
  WHERE status = 'ACTIVE';
