# Wallet Intel: bounded Polymarket position discovery

## Problem and scope

The auto-tracked branch used the foreground portfolio reader: one 2-second
deadline for every page together and at most 20 pages of 500 positions. On
November 2, 2026, a read-only production probe found one portfolio needed 11
pages and about 3.1 seconds. Another exceeded 20 pages. Raising the UI timeout
alone would neither solve the second case nor preserve quick UI responses.

The job also selected protocol infrastructure as if it were a trader. The
observed HTTP 400 address is the NegRisk NO-token burn sink, not a wallet sale
or a missing RPC. Its identity is independently reproducible from the official
[NegRiskAdapter source](https://github.com/Polymarket/neg-risk-ctf-adapter/blob/main/src/NegRiskAdapter.sol):
`address(bytes20(keccak256("NO_TOKEN_BURN_ADDRESS")))`.

The original bounded-reader change affects only background auto-tracked discovery. Foreground portfolio
deadlines, quote/slippage checks, execution, schedules and publication rules are
unchanged. It adds no SQL migration, index or model call.

## Reading and recovery

- Each page has its own bounded request; a wallet gets a bounded slice of work.
  The cursor and deduplicated token IDs/average prices are checkpointed after
  every five pages and on deferral. No raw portfolio/model/account metadata is
  cached. Redis keys hash the API origin and fixed query scope including owner.
- Only reaching `next_cursor=null` returns an inventory. Deferred/excluded reads
  do not mark the wallet refreshed, emit empty holdings or authorize closeouts.
  Completed discovery still unions previous open tokens, resolves canonical
  ledgers and reads exact on-chain balances through the existing path. API
  absence alone remains insufficient evidence of a zero balance.
- The existing job-wide PG advisory lock serializes checkpoint writers. No
  change to cron, the outer flock or its concurrency policy is needed.
- Transient timeout/429/5xx responses have bounded same-cursor retries. A provider
  `Retry-After` survives restarts and inventory expiry, even with
  `retryable:false`. Expired inventory is discarded independently of that
  deadline. Redis retention may extend to the deadline; stale facts are not
  promoted to fresh facts.
- Invalid cursors and self-repeating cursors get at most one immediate restart
  inside the same slice. Persistent cycles clear the broken checkpoint; the next
  ordinary attempt can start over. Corrupt/expired checkpoints also start fresh.
- Redis connection and each operation are bounded to one second. Without Redis,
  the reader can complete a small portfolio within its slice; large partial reads
  remain unavailable until storage recovers. They never become empty portfolios.
- Successful checkpoint progress at a page/time boundary does not advance the
  failed-attempt timestamp. Actual source errors retain existing attempt backoff.
  This does not create a new cron or automatically launch extra runs.
- Row/page capacity deferral preserves the cursor. Explicitly raising the
  documented resource budget permits continuation, rather than silently
  truncating inventory. Inventory checkpoints expire after six hours by default.

Known protocol addresses, including the burn sink and configured infrastructure,
are excluded before the auto-tracked SQL `LIMIT`. Ordinary smart wallets/Safes
are not excluded just for being contracts. Unexpected provider-confirmed protocol
addresses return a typed exclusion; the job does not disable/delete DB subjects.

The refresh's single PG connection now has an explicit promise-based query queue
instead of relying on node-postgres's deprecated implicit queue. HTTP/RPC workers
remain concurrent. The queue drains and rejects late calls before pool release;
one rejected statement does not poison following queries outside a transaction.

## Shared Data API admission and 429 recovery

All native Data API V2 requests now share an origin-wide Redis admission state
across API processes and cron jobs. Endpoint families have separate rate-limit
circuits; a positions outage does not block `/trades`. The wallet-intel entrypoint
marks its requests as background work, including holder telemetry. The limiter
does not wrap trading CLOB requests, RPC, or other venues.

- Origin pacing: one start per 20 ms. Endpoint-family pacing: one per 100 ms.
  Each family allows four concurrent requests, at most two from background work,
  leaving two slots available to interactive reads. Existing caller deadlines
  include time waiting for admission; there is no unbounded waiting queue.
- A real HTTP 429 publishes feedback before its body is read. `Retry-After` is
  honored even for an empty/non-JSON response. Without a header, backoff starts
  at one second and doubles to 60 seconds, with 0–25% jitter. A longer provider
  deadline is never capped at 60 seconds.
- Concurrent 429s extend deadlines without independently doubling the same
  failure wave. After cooldown, exactly one expiring half-open lease can probe
  recovery. A successful older request cannot clear a newer 429 deadline.
- Redis Lua uses Redis time and atomic operations. State contains only the
  hashed origin, endpoint family, lease identifiers and scheduling counters;
  never wallet addresses, request query strings, portfolio rows or cursors.
- Redis connect/commands are bounded to 500 ms and reconnect is retried after
  one second. If configured shared coordination is unavailable, background
  discovery defers while preserving its checkpoint. Interactive requests use a
  process-local fallback. Observed 429 deadlines survive both fallback and
  reconnection. No new infrastructure or production env setting is required.
- Shared-limiter denials are not upstream calls and do not create an independent
  per-wallet cooldown. An actual provider 429 still persists its retry deadline
  with the wallet checkpoint. Success from another process can therefore restore
  admission without leaving unrelated wallets behind stale half-open waits.
- Caller cancellation returns promptly even during Redis work. A late admitted
  lease is released asynchronously; expired leases also have a bounded recovery
  path. Partial inventories remain unavailable until the final page, never zero.

Diagnostics distinguish `upstream` from `shared_limiter`, with retry delay,
bounded Cloudflare Ray ID and JSON/non-JSON response format. They do not log
response bodies or URLs containing wallet/cursor parameters. There is no model
call, publication, balance mutation, SQL/schema change or cron change.

The November 3 read-only investigation observed empty HTTP 429 responses on
`/v2/positions`, including a minimal documented public request from two networks,
while `/v2/status` returned 200. This is evidence of an upstream/edge restriction,
not proof of its exact cause. Local backoff avoids amplification but cannot
guarantee removal of a provider-side restriction; persistent failures need
provider investigation with the sanitized timestamp/status/Ray ID. Published
limits and endpoint contracts: [Data API overview](https://docs.polymarket.com/api-reference/data-api/overview)
and [rate limits](https://docs.polymarket.com/api-reference/rate-limits).

Offline tests exercise fifty concurrent wallets, exact Retry-After, competing
late 429s/recovery probes, Redis/local transitions, cancellation and cursor
recovery. The integration suite executes the exact Lua on local Redis using two
independent clients and a disposable PostgreSQL 16 target. It deletes only
generated test keys, never an entire Redis database. Injected HTTP transports
must supply admission explicitly when testing limiter behavior; HTTP-only
fixtures bypass runtime coordination deliberately.

## Hunch-catalog coverage and explicit repair

Auto-tracked Polymarket snapshots cover **markets in the Hunch catalog**, not
every position a wallet may hold on Polymarket. A complete Data API walk supplies
token IDs and condition IDs. Indexed lookups check existing token projections,
durable bindings and market conditions before any ledger reads:

- A token with a valid condition hint and no local market/token/binding match is
  skipped as `skippedOutsideCatalog`. No Gamma hydration, external-market import,
  or on-chain balance request is made for it.
- A local market with missing token linkage is repaired only from its canonical
  stored protocol metadata. Bindings are append-only; historical generations,
  ledger contracts and outcome indices are never overwritten. Conflicts remain
  `pendingCatalogTokens`, not an invented match.
- Previously tracked holdings are never discarded merely because a current
  token projection is missing. Complete pagination, exact on-chain zero evidence,
  hidden-position suppression and generation compatibility remain required.
- Deferred/incomplete discovery is still not a completed portfolio. An incomplete
  wallet cannot publish a new canonical snapshot: missing sides would otherwise
  become false sales/entries in later delta and exposure readers. Checkpoints
  and repaired bindings preserve progress for the next bounded attempt.
  `coverage: hunch_catalog` and the skip/pending counts identify the scope of a
  successful collector result; it is not a full-account NAV or trading balance.

Checkpoints remain version 1 and accept the previous format. New checkpoints
also contain compact condition hints. Old partial inventories without those
hints restart discovery once, preserving an unexpired provider `Retry-After`.
Neither a missing hint nor a corrupt checkpoint proves that a token is external.

An explicit repair command retries **the supplied wallet IDs**, not a re-ranked
cohort. From `apps/api`, after separately authorizing any production execution:

```sh
pnpm wallets:intel:repair --repair-wallet-ids-file=/absolute/path/wallet-ids.json
pnpm wallets:intel:repair --repair-wallet-ids-file=/absolute/path/wallet-ids.json --repair-execute
```

The manifest is a JSON string array of existing wallet UUIDs, at most 64 KiB.
`--repair-wallet-ids=uuid,uuid` is an alternative. Default mode is an enforced
read-only plan: no lock, providers, snapshots, models, or cleanup. Missing or
mistyped repair options fail rather than launching a normal refresh.

Execution uses the ordinary job's advisory lock, live venue policy, current
wallet batch cap, protocol-address exclusions, shared admission, provider
deadlines and checkpoints. Only active auto-tracked Polygon/Polymarket subjects
are eligible; disabled subjects are reported, not reactivated. Explicit IDs
bypass selection ranking, subject TTL, refresh age and attempt-selection backoff,
but never real provider backoff. Normal cron selection is unchanged.

Repairs use the actual observation timestamp rather than replaying the hourly
bucket. They do not run market/holder selection, followed/internal/global wallet
scans, AI, cleanup, or global-whale rollups. Derived artifacts are refreshed only
for successfully completed target wallets; incomplete targets retain their prior
canonical snapshot rather than manufacturing sell activity. The final
report includes the requested/eligible/refreshed counts, manifest hash, coverage
and pending/excluded IDs (never addresses or credentials). Exit 0 means every
requested wallet completed; exit 2 means at least one remains pending/excluded
or the shared refresh lock was busy. A process error is not a successful repair.

## Optional background-only configuration

All settings have defaults; no production env change is required. Invalid values
fall back to defaults. Prefix each suffix with `WALLET_INTEL_POLY_POSITIONS_`.

| Suffix              |    Default |     Allowed range |
| ------------------- | ---------: | ----------------: |
| `PAGE_TIMEOUT_MS`   |      5,000 |        100–30,000 |
| `WALLET_BUDGET_MS`  |     15,000 |     1,000–120,000 |
| `PAGES_PER_SLICE`   |         60 |             1–200 |
| `MAX_ROWS`          |    100,000 |     100–1,000,000 |
| `MAX_PAGES`         |      1,024 |          1–10,000 |
| `CHECKPOINT_TTL_MS` | 21,600,000 | 60,000–86,400,000 |
| `MAX_ATTEMPTS`      |          2 |               1–3 |

The slice budget bounds HTTP work, not all subsequent canonicalization/RPC work.
Redis deadlines add bounded overhead. The existing 55-minute outer job deadline
remains. A recommendation to change runtime budgets needs operational evidence,
not an automatic production env edit.

## Diagnostics and verification

`polymarket position discovery` logs a sanitized status/reason, page/token counts,
elapsed time, resume/checkpoint/retry information, HTTP status, safe parameter name
and provider trace ID. It does not print owner addresses, response bodies or
cursor values. `pendingPositionDiscovery` in the collector summary distinguishes
usable progress from refreshed wallets.

Tests cover paging beyond 20 pages, restart/resume, provider errors, expiry,
invalid/cyclic cursors, Retry-After including checkpoint-age boundaries, missing
Redis, recovery, capacity overrides, unchanged closeout protections and SQL
serialization. Integration tests use guarded disposable PostgreSQL 16 temp tables
and generated Redis keys (no FLUSHDB). For Redis tests, the default is localhost
port 6380; `HUNCH_WALLET_INTEL_TEST_REDIS_URL` can select another local instance.
Reconnect is disabled and connect timeout is two seconds for the fixture.

Exact SQL on production was checked inside `BEGIN READ ONLY` with 15-second
statement and two-second lock timeouts. The initial observed custom/generic plans
took 30–41 ms for 150/1,000 results, and 4.1 ms for an empty venue list. They scanned
the small tracking-subject relation and used `wallets_pkey`, not portfolio history.
These are individual SQL timings, not full-job or p95 claims. The reproducible
local scratch probe is `untracked/wallet-intel-background-validation-20261102.mjs`.

A read-only future-reader probe resumed the first portfolio after five pages and
completed 5,178 tokens in 11 requests. The second preserved 24,500 tokens after
49 pages when its slice deadline elapsed. This validates bounded progress, not
completion of the second wallet or a production cron running the new code.

After an authorized future deploy, observe the normal job's discovery/collector
summaries, final `done` and cleanup result. Partial source failures must be
reported separately from process exit status. Do not force a job, reset Redis or
infer a sale merely to make this validation green.
