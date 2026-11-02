# Wallet Intel whale-market selection

## November 2, 2026 investigation

The hourly production refresh failed at 10:00 and 11:00 UTC with PostgreSQL
`57014` (statement timeout). The deployed stack pointed to the whale-market
selection query, before holder fetching. Its existing timeout is 300 seconds;
the fix does not increase it or change schedules.

The original CTE was inlined. PostgreSQL estimated 107 eligible market rows
where a materialized diagnostic plan observed 190,798. It chose a nested loop
whose inner side was the full seven-day activity aggregation. That inner work
could be repeated for each outer market, rather than computed once. Whale tag
cardinality was also overestimated (87,685 estimated versus 3,540 actual).
Auto-analyze was active; this is not evidence that vacuum/analyze was disabled.
No production maintenance settings were changed.

## Fix and preserved semantics

`apps/api/src/services/wallet-intel-whale-selection.ts` is the SQL executed by
`wallet-intel-refresh.ts`:

- Materialize the complete distinct market-ID set from seven days of whale
  `delta`/`trade` activity. Do not cap or sample this intermediate set.
- Hydrate those IDs with a parameterized lateral primary-key lookup. The
  `OFFSET 0` fence prevents the planner from replacing this with a broad scan of
  all active markets; it is not pagination or a data limit.
- Preserve market/event status, resolution, close/expiry, venue and initialization
  rules. Preserve the final policy limit and volume ordering; market ID breaks
  previously unspecified equal-volume ties deterministically.
- No new indexes, migrations, collection, model calls or production writes.

## Production read-only validation

Exact SQL from the source module was prepared on PostgreSQL 16, inside
`BEGIN READ ONLY`, with a 15-second statement timeout and two-second lock timeout.
The reference activity cutoff was November 2, 2026 at 11:00 UTC. These are
individual executions, not p95 estimates or a completed cron end-to-end test.

| Query                                                       |  Execution time | Result                                                                |
| ----------------------------------------------------------- | --------------: | --------------------------------------------------------------------- |
| Original SQL                                                | Stopped at 15 s | Production cron had separately timed out at 300 s                     |
| Materialization alone                                       |        3,772 ms | Still scanned 190,798 eligible markets and spilled to temporary files |
| Exact fixed SQL, custom plan, first observed pass, limit 50 |        2,941 ms | 50 rows, no temporary spill                                           |
| Exact fixed SQL, generic plan, subsequent pass, limit 50    |        1,339 ms | 50 rows, no temporary spill                                           |
| Fixed SQL, generic plan, warmed, limit 500                  |          266 ms | 500 rows                                                              |
| Fixed SQL, Limitless-only filter, warmed                    |          206 ms | Correctly empty on this slice                                         |
| Fixed SQL, empty venues, warmed                             |          217 ms | Empty                                                                 |
| Fixed SQL, zero limit                                       |         0.68 ms | No source scan executed                                               |

The fixed plans computed 10,308 distinct market IDs once from 172,667 activity
rows, then used `unified_markets_pkey` and `unified_events_pkey`. They did not
scan all active markets. The first fixed pass read 13,962 shared blocks, compared
with 148,302 in the materialization-only diagnostic. Warm runs are not evidence
of cold-cache latency, and no cache was flushed for this investigation.

Set comparison against the original semantics with only its aggregation
materialized returned zero old-only and zero new-only rows for the top 50
(with the same deterministic tie-breaker). All production probes were SELECTs;
the refresh job itself was not run manually.

`wallet-intel-whale-selection-integration-tests.ts` validates the exact SQL on a
guarded disposable PostgreSQL 16 database under Node and Bun: seven-day boundary,
whale qualification, trade/delta versus holder activity, duplicate markets,
missing/closed/resolved markets, event and timestamp boundaries, allowed venues,
initialization, null-volume ordering, post-filter limits and empty results.
Both custom and generic `EXPLAIN ANALYZE` plans are exercised. Temporary fixture
tables are rolled back; these tests do not need production data or new indexes.
