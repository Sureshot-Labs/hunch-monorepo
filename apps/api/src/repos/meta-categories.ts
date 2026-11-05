// Aggregate before the default broad venue filter: the existing status index
// reads active rows in heap order instead of traversing the venue/end-date index.
// Only the small totals are materialized; public counts and ordering are exact.
export const DEFAULT_CATEGORY_COUNTS_SQL = `WITH category_totals AS MATERIALIZED (
  SELECT venue,lower(category) AS category,count(*)::int AS events
  FROM unified_events
  WHERE status='ACTIVE' AND category IS NOT NULL AND btrim(category)<>''
  GROUP BY venue,lower(category)
)
SELECT venue,category,events FROM category_totals
WHERE venue=ANY($1::text[]) ORDER BY events DESC,venue ASC,category ASC`;
