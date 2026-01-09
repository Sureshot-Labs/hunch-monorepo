-- Add index to speed up 24h change lookups by token_id + bucket
CREATE INDEX IF NOT EXISTS idx_unified_book_top_1m_token_bucket
  ON unified_book_top_1m (token_id, bucket DESC);
