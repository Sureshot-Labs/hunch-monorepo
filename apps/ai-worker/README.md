# Generation-aware embeddings

`ai_embeddings` in the runtime-policy editor owns the desired model, dimensions,
text version, build budget and throughput. The worker polls it every 30 seconds.
Only E5 and Qwen3-Embedding-8B at 1024 dimensions are admitted. Model env overrides
and per-map `embedModel` policies no longer select a separate vector space.
Queue/group environment settings retain their existing meaning.

The first release now defaults directly to **Qwen3-Embedding-8B / 1024 /
clean-v1**, following the approved public-corpus comparison. Existing legacy E5
continues serving while Qwen is prepared; there is no intermediate E5 clean build.
An explicit `ai_embeddings.model` DB override still takes precedence. E5 remains
a supported adapter for pinned old consumers and an explicit policy choice.
See `packages/embeddings/QUALITY-RESULTS.md` for measured gains and limitations.

## First startup and subsequent changes

1. Register the existing E5 hashes/indexes as `legacy-e5`, without copying them.
2. Save compact old-DLQ diagnostics and incrementally trim that stream to seven
   days / approximately 10,000 entries. Historical payloads are not replayed.
3. Maintain the serving generation while building the desired generation from
   canonical eligible DB rows. ACTIVE means lifecycle-enabled for discovery; an
   event also needs an eligible ACTIVE child. No volume filter is added.
4. Verify current text hashes, queue watermark, lifecycle configuration, index
   dimensions and an actual KNN query; only then atomically change the active
   pointer if auto-activation remains enabled. Invalid/unavailable policy blocks
   switching, not existing reads.

There are no DB migrations or new containers/schedules. The new shared package's
manifest must be included in the image's frozen-lockfile dependency stage. Its
tokenizers are local, pinned assets; neither API nor worker downloads model files.

Each request/job captures one generation. After activation, published old maps
can remain visible as static snapshots, but new search/signals jobs skip them
with `stale_embedding_generation` until the next normal map build. They never
substitute a new-model vector into an old snapshot. No map rebuild is forced.

## Recovery and limits

- One leased worker owns publication and activation; every mutation is fenced.
  Pending messages are reclaimed. If a message body was lost, reconciliation is
  requested. Queue overflow requests reconciliation instead of trimming unread
  work. Stream trimming respects every consumer group and its oldest pending ID.
- Quiet ACTIVE vectors are checked and renewed without inference; a provider
  circuit or paused replacement does not stop this maintenance.
- A full serving reconciliation runs at most once per six hours unless explicitly
  requested or invalidated. Checkpoints and conservative monetary reservations
  survive restarts. Live messages take priority over bounded DB pages.
- Source scans page **only ACTIVE rows in allowed venues**, using the existing
  `(venue, end_date)` and `(venue, expiration_time, close_time)` partial indexes.
  ID only breaks ties within a date group. Seek branches handle NULL dates
  explicitly, without OFFSET or an OR-filtered walk over the previous pages.
  Up to 500 candidates are returned per page; same-date ties may read more rows
  inside that ACTIVE group. Empty orphan-event pages still advance the cursor.
  The worker uses a shared resumable source census (cached for six hours), not
  full-table startup COUNT queries. Background building waits for complete census
  totals before applying the pilot's projected-memory admission.
- Worker and CLI SQL have a 15-second safety timeout. Background PostgreSQL
  timeout/lock/connection failures retry after 60 seconds without blocking live
  queue ACKs; the status reason identifies the deferred stage and SQLSTATE.
  Provider, budget, memory, lease and verification failures remain fail-closed.
  On upgrade to time cursors, old scan/census/maintenance checkpoints restart
  against the ACTIVE set. Existing vectors and monetary reservations are retained,
  not reset/rebilled. No migration or new index is needed.
- A provider request makes at most four attempts, reserving before each attempt.
  Exhausted failures are deduplicated per content hash and cooled down for six
  hours before reconciliation retries. Auth/credit errors open a five-minute
  circuit instead of flooding the DLQ. A longer Retry-After is respected.
- Unknown charges remain conservatively reserved; they are not reported as
  actual zero cost. An observed charge above its estimate pauses further calls
  for that generation (`embedding_provider_cost_drift`), requiring a reviewed
  pricing correction, not blind automatic retries.
- Raising `generationBudgetUsd` resumes a budget-limited build. A memory pause
  requires recovered headroom: Redis estimate at most 6 GiB and at least 2 GiB
  available to the worker. These checks are not a guarantee against unrelated
  host memory pressure. Admin also shows Redis/worker RSS and persistence work.
- Retired generations have **no mandatory grace period**. Published snapshots
  do not retain their vectors; legacy `map:*` snapshot pins are removed in bounded
  batches. Cleanup starts once in-flight request/job pins have drained. Jobs use
  unique renewable five-minute pins, release in `finally`, and fail closed on
  pin loss. New jobs may acquire only the active generation; an already running
  job may renew its captured generation after a switch. A crashed job therefore
  delays cleanup by at most its remaining pin TTL, not its artifact lifetime.
  Eligible pinned vectors receive extended TTL. CLOSED seeds keep at most their
  prior 48-hour allowance **within retained generations**, not a minimum delay
  before generation deletion. At most two full generations coexist; a third
  waits for safe bounded cleanup. Once collected, a rollback requires rebuilding.
- New failures have compact, seven-day deduplication records. DLQ entries contain
  IDs/error codes, not full market payloads. Approximate Redis stream trimming may
  temporarily exceed the count/time target while bounded cleanup catches up.

`ai:embed:control:status` is exposed through the existing admin Vector Index page.
Check `updatedAt`: this is a worker snapshot, not a continuously measured proof of
coverage. Redis index counts alone are not coverage. The CLI backfill command is
read-only by default; `--execute` requests the same worker reconciliation rather
than starting a second independent publisher.

## Local verification

Core/provider/text tests and HTTP consumer tests use fakes and make no paid calls:

```sh
node --conditions=source --import tsx --test packages/embeddings/src/core-tests.ts
node --conditions=source --experimental-test-module-mocks --import tsx --test apps/api/src/embedding-*-tests.ts
```

The worker integration test intentionally uses **dedicated disposable** endpoints:
PostgreSQL 16 at `127.0.0.1:55439`, database `embedding_test`, and Redis Stack at
`127.0.0.1:56439/0`. It truncates its fixture tables and flushes that Redis database.
Never repoint it at shared development or production data. It executes real SQL,
Redis Lua/indexes/streams, restart/fencing/activation/GC recovery scenarios; model
responses are mocked. Run it only after verifying those containers and ports:

```sh
node --conditions=source --import tsx --test apps/ai-worker/src/embedding-integration.test.ts
```

The separate public-corpus quality evaluator is dry-run by default and requires
an explicit execute flag and local provider key for paid inference. Its results
are a limited retrieval/Similar check, not proof of trading or clustering quality.
