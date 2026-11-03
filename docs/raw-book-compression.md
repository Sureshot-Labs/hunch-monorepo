# Raw quote compression after three days

Migration `0293_raw_book_compression_three_days.sql` updates only the existing
compression policy for `public.unified_book_top`: `compress_after = 3 days` and
`maxchunks_to_compress = 1`. It does not run compression during deploy. The
installed job identity, enabled state, schedule, next start, retries and runtime
settings are preserved. A missing/alternative optional policy is a no-op, not
an availability-blocking migration assertion.

This is historical top-of-book data, not full orderbooks or the live quote cache.
The 30-day raw retention, minute/hour aggregates, indexes, trading and quote
slippage rules are unchanged. No data is intentionally deleted/downsampled.

## Effect and initial backlog

The November 3 production read-only snapshot measured 43.1 GiB of raw-book
storage. Four newly eligible daily chunks occupy 22.7 GiB; the historical 96.9%
compression reduction projects approximately **22.0 GiB saved**. It is an
estimate, not a guarantee or an immediate deploy result.

Only a daily chunk whose end is older than three days qualifies. The existing
12-hour job processes at most one chunk per invocation, including partial-chunk
recompression. It therefore drains the initial backlog gradually over several
days while new daily chunks become eligible. Three days is the eligibility
threshold, **not an absolute maximum uncompressed age while catching up**.
The next existing start was November 4 around 04:42 UTC at preflight; applying
the migration does not bring it forward or launch a manual job.

This cap prevents the new threshold from processing the entire 22.7 GiB backlog
in one run. It does not cap the cost of one chunk: compression still uses CPU,
I/O, WAL and temporary space. Indexer lag, API health, insert latency, hourly
aggregate refresh and free space must be observed at the next natural run.

## Compatibility and recovery

TimescaleDB 2.14.2 / PostgreSQL 16 supports late writes into compressed chunks.
Token/time-targeted filters align with `segmentby=token_id`, `orderby=ts`.
Minute refresh covers 24 hours, hourly refresh seven days; compressed raw source
is distinct from compressing the aggregate's own active storage. Broad repair
deletes and uniqueness checks can cause extra decompression work.

The integration test executes the exact migration, tests missing/idempotent and
disabled policy behavior, preserves unrelated jobs/retention/scheduling, and
runs the actual capped policy on one million quotes. It checks lossless values,
late duplicate-first batches, update/delete, aggregate reconciliation and bounded
recompression/backlog continuation on PG16/Timescale2.14.2. Synthetic timings are
not production p95 or a full-size-chunk load benchmark.

Read-only inspection remains available through `ops/quote-compression-report.sql`.
Confirm the deployed migration checksum and actual job config before claiming
activation. After the next scheduled run, inspect chunk/compression/job stats
and server health. Do not manually compress chunks merely to make a check green.

If a full-size chunk exceeds practical resource limits or a regression appears,
an authorized operator can pause this exact compression job or restore its
`compress_after` to seven days using `alter_job`, retaining other config fields.
Neither action decompresses already compressed chunks. Bulk decompression is
not an automatic rollback: it needs disk space and locks. Failed work is retried
by the existing job retry policy; partial chunks retain a recompression path.
Do not change last-trade, aggregates, retention or cron as incidental recovery.
