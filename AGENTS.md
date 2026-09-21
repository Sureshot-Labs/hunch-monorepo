# Production SQL performance

This is a production database with millions of rows. Small fixtures, typechecks,
and SQL syntax checks do not establish acceptable query performance.

- Every new or changed SQL statement must run against the matching PostgreSQL
  major version and have its execution plan checked at representative scale.
- With explicit permission, use bounded read-only production `EXPLAIN ANALYZE`
  probes. Otherwise use a representative disposable restore and clearly report
  missing production verification; do not claim production performance readiness.
- Check sparse/selective filters, first and resumed pages, empty tails, join
  fanout, and generic prepared plans where applicable. Record actual time,
  buffers, scanned rows, and index use, not just the number of returned rows.
- `LIMIT` after filtering does not bound scanned work. Background scans need
  bounded source pages, durable cursors, throttling, and failure backoff; a
  housekeeping timeout must not starve unrelated live work.
- Do not raise timeouts instead of fixing bad plans. Never run mutating
  `EXPLAIN ANALYZE`, unbounded stress tests, cache flushes, or production DDL as
  part of a read-only diagnostic.
