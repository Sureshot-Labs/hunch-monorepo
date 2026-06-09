-- Manual grants and referral-code drops are exact point adjustments, not
-- trading volume. Normalize any existing adjustment rows that were inserted
-- through the trade-volume multiplier path.

UPDATE volume_events
SET
  multiplier_applied = 1,
  multiplier_source = CASE
    WHEN source_id LIKE 'referral-code-visible:%'
      OR source_id LIKE 'referral-code-tier:%'
      THEN 'referral_code'
    ELSE 'user'
  END
WHERE (
    source_id LIKE 'manual:%'
    OR source_id LIKE 'manual-visible:%'
    OR source_id LIKE 'referral-code-visible:%'
    OR source_id LIKE 'referral-code-tier:%'
  )
  AND (
    multiplier_applied IS DISTINCT FROM 1
    OR multiplier_source IS DISTINCT FROM CASE
      WHEN source_id LIKE 'referral-code-visible:%'
        OR source_id LIKE 'referral-code-tier:%'
        THEN 'referral_code'
      ELSE 'user'
    END
  );
