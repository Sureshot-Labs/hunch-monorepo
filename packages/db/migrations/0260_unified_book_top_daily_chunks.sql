-- Only future chunks change; existing chunks and all retention/compression
-- policies remain unchanged. Keep seven days uncompressed for aggregate refresh.
SELECT set_chunk_time_interval(
  'public.unified_book_top'::regclass,
  INTERVAL '1 day'
);
