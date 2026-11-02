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

This patch changes only background auto-tracked discovery. Foreground portfolio
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
