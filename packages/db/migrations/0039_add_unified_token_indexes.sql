-- Add indexes to speed up markets-by-token lookups.

DO $$
BEGIN
  IF to_regclass('public.unified_tokens') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_unified_tokens_token_id ON unified_tokens(token_id)';
  END IF;

  IF to_regclass('public.unified_markets') IS NOT NULL THEN
    EXECUTE $sql$
      CREATE INDEX IF NOT EXISTS idx_unified_markets_clob_tokens_gin
        ON unified_markets
        USING GIN ((clob_token_ids::jsonb))
        WHERE venue = 'polymarket'
          AND clob_token_ids IS NOT NULL
          AND clob_token_ids <> ''
          AND clob_token_ids <> '[]'
    $sql$;
  END IF;
END $$;
