# Retired-market history cleanup: proposed release, not an enabled feature

Status: design and disposable PostgreSQL 16 / TimescaleDB 2.14.2 feasibility
fixture only. This patch does not create production manifests, modify readers,
change policies, or delete data. Production implementation and execution each
require separate approval. It must not be bundled with the wallet-intel fix.

## Goal and existing contracts

Remove history of **provably deleted markets**, without shortening history of
existing or protected instruments. Keep raw book/trades at 30 days, minute
aggregates at 60 days, and hourly/daily aggregates at 365 days. Catalog
maintenance currently removes eligible terminal markets after 90 days and
preserves protected references. Raw retention therefore normally precedes
catalog deletion; a second per-token raw purge is not the first optimization.

Hourly CAGGs also serve candles, sparklines and wallet-intel price/trade reads.
All those consumers must be inventoried and switched together. Cleaning a
chart-only loader while changing the physical CAGG would be incomplete.

The November 4 read-only sample found 605/879 old hourly-series tokens without
current catalog/binding links, but none in the sampled recent hourly/raw data.
Those are **unknown provenance**, not a deletion manifest or a global reclaim
estimate. Allocated hourly-price history was ~6.8 GiB; minute-price history
~16.3 GiB; raw top-of-book ~42 GiB. These are whole-relation sizes, not garbage
sizes. The first natural three-day compression saved 4.69 GiB independently.

## 1. Establish deletion provenance before deleting catalog rows

A future additive migration introduces an append-only deletion manifest and
bounded archive progress. It contains deletion-batch identity, market/event,
venue, token aliases from every existing token source, chain/contract,
protocol generation, condition/outcome, terminal/deletion time, protected-ref
validation version and manifest checksum. Save it in the same transaction as
the final catalog deletion, after the existing protected-reference recheck.
Failed deletion transactions must not leave confirmed manifests.

Update the retention selector's protected refs, reports and deletion path for
these new tables. Confirmed manifest rows survive catalog deletion; do not
attach an ON DELETE CASCADE that removes the only proof.

No manifest is inferred from a missing current token. Existing orphan series
stay `unknown`, retain current TTL, and appear in a separate report. Recover
proof only from independently verified retained manifests/backups; do not
silently reconstruct it from AI, current names or an upstream search result.

Raw/history identity is only venue + token + time, not a full ledger. If one
numeric token can belong to another live/protected generation, or its time
ownership is ambiguous, retain the series and report the ambiguity. This is a
per-series exclusion, not a blocker for unrelated proven retirements.

## 2. Read-only selection and cost report

Default CLI behavior is read-only. Require an explicit deletion manifest and
time/chunk bounds; never scan all raw rows to discover candidates. Page exact
manifest keys, probe existing token/time indexes, and inventory chunk/catalog
sizes. Bound each statement to 15s with 2s lock timeout. No provider calls,
compression/decompression, models or jobs during inventory.

Report separately: confirmed retirements, unknown series, protected or
reintroduced identities, eligible rows/chunks, bytes physically allocated,
estimated retained-copy bytes, temporary archive/rollback overhead, WAL, and
expected net reclamation. Do not multiply an old sample percentage by all
history or treat DELETE row counts as bytes returned to the filesystem.

The execute command is a later release: fresh dry-run, exact manifest hash,
explicit --execute --confirm-delete, and unchanged-scope verification. An old
report or a broad prefix is not execution authority.

## 3. Supported cold-history/shadow path for CAGGs

Do **not** DELETE from `_timescaledb_internal` materialization tables, rebuild
year-old aggregates from 30-day raw data, or lower the global history TTL.

Instead archive the existing, already aggregated cold rows into ordinary
hypertables with the same columns/precision. Each copy covers one exact whole
source chunk, using keyset pages of at most 10,000 rows ordered by
venue/token/bucket. Retain existing, protected and unknown series; exclude only
confirmed unambiguous retirements. Copy aggregate values verbatim, including
sample counts; do not average averages or change OHLC interpretation.

Use a persisted per-chunk fence and unique (venue, token_id, bucket) key. The
reader combines cold archive below that fence with the existing CAGG at/above
it, with no overlap or gap. No public response shape changes. Archive retention
continues to enforce the existing 365-day window, not unlimited storage.

Keep a full rollback copy/export of the exact source chunk, including retired
rows, before any physical removal. Verify its durable checksum and restore
readability. Reserve space for source + retained archive + full rollback copy,
indexes and WAL; approve a measured headroom budget from the dry-run, rather
than assuming current free disk is enough. Temporary disk can grow first.

For every chunk, copy -> checkpoint -> catch up late changes -> revalidate
manifest/current protected refs -> compare all retained keys/values -> switch
read fence -> observe -> remove the archived source chunk through the public
Timescale `drop_chunks` API only. At most one source chunk is removed per
operator-approved batch. Resume by exact chunk/manifest identity; copying and
upserting the same page twice must be harmless.

Late writes or renewed catalog ownership invalidate the affected exclusion
before cutover. Coordinate catalog/import writers and source CAGG refresh with
the archive lease/fence; a stale repeatable-read snapshot is not a final
ownership check. Retention/refresh jobs must not remove or rewrite a source
chunk between validation and drop. No automatic shorter retention policy may
drop unarchived chunks. A returned market resumes normal ingestion; an old
tombstone must never suppress its new quotes. Previously approved deletion is
not a promise of permanent recovery after rollback backups are retired.

If source raw rows expire, do not refresh their historical window: that can
erase still-needed CAGG values. Verify refresh windows against raw retention
before rollout. Mixed source chunks can be removed only after **all retained
rows** are safely archived, not merely the candidate retired rows.

Rollback before physical removal is a reader/fence reversal. After removal,
route cold reads to the verified full rollback archive/export plus hot CAGG;
do not depend on raw reconstruction or internal CAGG writes. Keep rollback
storage until a separately approved disposal after at least seven days of
healthy reads and a tested restore. No claimed filesystem saving includes
rollback bytes that are still retained.

## 4. Acceptance and rollout gates

The local feasibility test exercises copying an actual CAGG into an ordinary
shadow hypertable, raw expiry, late-write reconciliation, reappearance,
unknown/protected series, idempotent copying, interruption rollback, public
drop_chunks and a full reader rollback on PG16/TS2.14.2. It proves API feasibility,
not production load safety, coordinated concurrent writers or a release GO.

Before a future production release: representative volume restore, exact
selector/archive SQL EXPLAIN ANALYZE custom/generic plans, crash/concurrent
writer/refresh/retention races, all price/trade aggregate grains, golden
candles/sparklines/intel comparisons, WAL/replica lag and archive indexes.
No migrations may introduce historical-row hard failures during downtime.

Begin with a read-only manifest inventory. Separately approve one small cold
chunk pilot; monitor API errors/p95, chart equality, indexer lag, PG locks/I/O,
WAL and disk throughout. Stop without advancing the fence on any mismatch or
ownership ambiguity. Unknown rows remain visible and do not block unrelated
eligible progress. Broad index removal, wallet-history cleanup, retention
changes and bulk decompression are explicitly outside this plan.
