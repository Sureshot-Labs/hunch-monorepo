SET statement_timeout = 0;

-- Raw analytics events power the admin audit/explorer views, but they should
-- not grow forever. Keep cleanup bounded so an ops cron can prune in small
-- batches without taking a long table lock.
CREATE OR REPLACE FUNCTION cleanup_analytics_server_events(
  p_retention interval DEFAULT interval '395 days',
  p_limit integer DEFAULT 50000
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted integer := 0;
  v_limit integer := greatest(1, coalesce(p_limit, 50000));
  v_retention interval := coalesce(p_retention, interval '395 days');
BEGIN
  WITH doomed AS (
    SELECT ctid
    FROM analytics_server_events
    WHERE created_at < now() - v_retention
    ORDER BY created_at ASC
    LIMIT v_limit
  )
  DELETE FROM analytics_server_events e
  USING doomed d
  WHERE e.ctid = d.ctid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
