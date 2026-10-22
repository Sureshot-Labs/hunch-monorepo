# Maintenance and storage follow-up — 2026-10-22

Local patch only. No production data, policy, schedule, service, or log file is
changed by preparing this patch. Compression remains at **7 days**.

## Repair and whale-profile failures

Market repair distinguishes verified results, deferred missing records, and
operational errors. A confirmed-active Kalshi fallback is verified even if DFlow
was stale. Limitless retries a 404 slug using the stable venue ID, at most once;
the returned ID must match. Existing shared 429 backoff remains in place.
These new deferred paths (Gamma, Limitless, public Kalshi) do not close a market
or authorize deletion. The pre-existing DFlow batch-omission → ARCHIVED handling
is outside this change and remains unchanged.

Deferred rows remain ACTIVE and protected, are visible in the report, and are
revisited after the cursor wraps. An entirely deferred page can advance; an
entirely failed provider page cannot. Mixed provider errors still yield nonzero
exit status after processing the verified rows. `completed_with_deferred` is a
successful bounded sweep, **not** a claim that every old market was repaired.
The maintenance shell still runs the remaining cleanup stages and reports real
stage failures. No retention rules, protected references, or SQL update paths
were changed.

Whale-profile defaults use low reasoning for recognized modern models, retaining
high for legacy families (including 5.4-pro). Explicit saved effort remains honored
on the first call. One existing compact fallback uses the lowest supported
effort for recognized modern OpenAI models (Luna: none), keeping the configured
fallback token cap. Legacy families keep their configured effort. Invalid JSON
and schema-invalid profiles can use this fallback; there is no third call.
Transport failures/timeouts are not retried. Requests have a 120-second timeout.
Existing valid profiles are not overwritten on failure.

Reason: reasoning tokens share the generated-token limit with visible output;
the audited failures consumed all 1600 tokens on reasoning, then all 1000 on the
unchanged high-effort retry. See [OpenAI's reasoning guide](https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning).
Tests use mocked completions; no live paid model calls were made for this patch.

## Log limits and later installation

- All 13 services in backend Compose have `json-file`, `max-size: 20m`,
  `max-file: 3`: approximately 60 MB of retained Docker logs per container.
- `ops/logrotate/hunch-cron` covers the 11 previously unrotated cron files:
  daily, maxsize 20M, 14 rotations, immediate compression, copytruncate.
- `ops/logrotate/hunch-nginx` replaces the existing nginx policy: daily plus
  **maxsize**, not `size` (which overrides daily), and no delaycompress.
- The existing separate agent-theses rotation is deliberately not duplicated.
- The frontend `hunch-web` belongs to another repository and is not changed here.

Logrotate thresholds are evaluated when its existing daily timer runs; these are
retention limits, **not hard per-file caps between timer invocations**. Fourteen
rotations means roughly fourteen daily archives, not fourteen days guaranteed.
Copytruncate preserves open cron/nginx file descriptors, with the usual small
copy/truncate race where concurrent log lines can be lost. No job is restarted.

After separate rollout approval:

1. Inspect installed logrotate files for overlapping paths, the timer, root
   crontab and current file ownership. Run `sudo logrotate --debug` against each
   proposed file; do not use `--force` on production as a validation step.
2. Back up the exact existing nginx file and any existing `hunch-cron` file, then
   install the two reviewed configs as root-owned 0644. Validate the complete
   `/etc/logrotate.conf` in debug mode to catch duplicate paths. Do not alter the
   separate agent-theses config, schedules, or unrelated policies.
3. Docker options take effect only on **recreation**, not restart. Normal backend
   rollout recreates app containers, but keeps PostgreSQL/Redis with
   `--no-recreate`. Do not change that for logging. Applying their limits requires
   a separately approved infrastructure maintenance window. Verify each running
   container's `HostConfig.LogConfig`; source YAML alone is not proof of rollout.
4. Observe the next natural rotation and cron completions. Roll back configs from
   their backups if necessary; no old log or data deletion is part of this patch.

## Earlier quote compression: research, not an enabled policy

Read-only production inventory at 17:43–17:53 UTC on October 22 found 87 GiB free
on the 290 GiB root filesystem. PostgreSQL accounted for about 189 GiB on disk.
Raw `unified_book_top` used about 38 GiB: eight daily uncompressed chunks used
37 GiB, while older compressed chunks recorded 47 GiB before / 1.83 GiB after
compression. Jobs were succeeding. The opportunity is warm quote history, not
unused Docker images (none identified), WAL removal, or blind index deletion.

The observed October 15–19 chunks total about 20 GiB; including October 19–20
adds about 4 GiB. Moving 7 → 3 days could reclaim roughly **19–20 GiB**, and
7 → 2 days roughly **23–24 GiB**, using the old compression ratio. These are
time-sensitive estimates, not guaranteed freed bytes. One daily chunk straddles
the cutoff and remains warm until its **end** is older than the threshold.

`quote-compression-report.sql` is a bounded read-only catalog/size report with
15s statement / 2s lock timeouts. It scans no raw quote rows. It compares 7/3/2
days and reports historical compression ratio and estimated eligible bytes.
Use it only against an explicitly selected database; no policy-changing command
is included.

`quote-compression-probe.sql` is **only for a fresh local disposable database**
named `storage_maintenance_test`, PG16 / TimescaleDB 2.14.2. It generates 1 million
synthetic quotes (100 tokens, 10 days), uses the deployed indexes/segmentation,
and checks row count/value preservation, time-range and empty reads, late batch
inserts with an initial duplicate, update/delete, and continuous-aggregate refresh.
It creates no scheduled jobs. Never run the probe on production.

Local result with current migrated indexes: 171.2 MB → about 61 MB total with seven of ten chunks
compressed. Late insert/update/delete and
aggregate reconciliation passed. Warm recent/empty reads were below 0.4 ms;
one-token old-day aggregation was about 0.4 ms, using segment index filtering.
These are synthetic, warm-cache timings, **not production load benchmarks**.

Recommendation: **3 days first**, not 2, only after a separately approved rollout
plan. Before enabling, measure the real late-quote age distribution and replay
representative token-repair/retention batches under ingestion load. Recompression
and broad deletes can cost more on this older Timescale version. Verify partial
chunks are recompressed by the policy, compare indexer lag/DB CPU and query p95,
and change only `unified_book_top`, leaving last-trade and retention unchanged.
Reverting the threshold to 7 days stops earlier future compression but does not
decompress existing chunks; bulk decompression must not be used as automatic
rollback because it needs substantial disk space and locks.

The [Timescale mutation documentation](https://docs.timescale.com/use-timescale/latest/compression/modify-compressed-data/)
supports writes to compressed chunks on this major generation. Version-specific
behavior still needs testing: [upstream issue #7672](https://github.com/timescale/timescaledb/issues/7672)
reports lost batch inserts on a different version (2.17.2). The duplicate-first
regression test passed here on 2.14.2; this is not a blanket Timescale security or
performance clearance.

## Verification for this local patch

- Full backend workspace build, typecheck and lint: 47/47 tasks.
- Focused provider, policy, repair-sweep and whale suites under Node and Bun 1.4.4;
  mocked HTTP/model calls only. Separate logging config regression tests.
- The final SQL probe and read-only report executed on disposable PG16.2 /
  TimescaleDB 2.14.2, with one million generated quotes and current indexes.
- Both proposed logrotate configs parsed successfully with the server's installed
  parser in `--debug`, using anonymous memory files and `/dev/null` state. No
  config installation, file rotation, truncation or state write occurred.
- Independent review GO after fixes for model-only effort overrides, malformed
  Kalshi responses, probe index parity, and aggregate value assertions.

No dependencies or lockfiles changed. The local pnpm/Turbo fallback emitted its
pre-existing node_modules/lockfile sync warning; no installation was performed.
No commit, push, deployment, production SQL write, live paid call or policy
activation is included. Natural production job outcomes must be checked after
an explicitly approved rollout.
