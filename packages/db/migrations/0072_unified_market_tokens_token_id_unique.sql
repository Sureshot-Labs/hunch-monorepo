DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM unified_market_tokens
    GROUP BY token_id
    HAVING COUNT(*) > 1
    LIMIT 1
  ) THEN
    RAISE EXCEPTION
      'Cannot add unique index on unified_market_tokens(token_id): duplicate token_id rows exist';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_unified_market_tokens_token_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unified_market_tokens_token_id_unique
  ON unified_market_tokens(token_id);
