# Production SQL performance

## Proportionate safeguards

- Never add unjustified blocking guards, arbitrary waiting periods, or perfect
  coverage requirements that delay useful work without preventing a concrete
  material failure. Explain the failure being prevented and why blocking is
  preferable to a warning and bounded background repair.
- For partial derived data (such as embeddings), prefer visible gap counts and
  resumable repair over blocking publication. Explicit repair requests must not
  be trapped behind a stale housekeeping delay.
- Preserve safeguards for financial execution, data integrity, vector-space
  compatibility, concurrent writers, and actual resource/budget exhaustion.
- Test recovery as well as rejection; a safeguard without a practical recovery
  path is incomplete. Do not remove unrelated safeguards to fix one bad guard.

## Build verification

- Before giving a commit/deploy GO for backend changes, complete the full workspace
  build and check its exit code; targeted API typecheck does not cover every build
  input and is not a substitute.
- In a network-restricted local workspace, `pnpm build` may try to download the
  pinned pnpm version. From this repository root, the non-installing fallback is:
  `PNPM_CONFIG_PM_ON_FAIL=ignore PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=warn ./node_modules/.bin/turbo run build --env-mode=loose`
- Turbo needs `--env-mode=loose` so child `pnpm` processes inherit those settings.
  Check any dependency-state warning; never claim GO if the build failed or did
  not finish. Do not run an automatic install/purge merely to satisfy the check.

## SQL verification

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
