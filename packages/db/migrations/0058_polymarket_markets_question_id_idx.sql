/* no-transaction */

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_polymarket_markets_question_id
  ON polymarket_markets (question_id);
