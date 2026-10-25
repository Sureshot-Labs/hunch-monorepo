# Discovery API for mobile clients

Discovery returns three prepared, public market collections with current market and instrument checks. It does not generate research, create orders or record purchases. Use the existing trading API for executable prices, depth, fees, approvals and order submission.

Mobile integration guide (Russian), including request/response examples and UI semantics: [Discovery API client guide](discovery-api-client-guide.md).

## Endpoints and filters

| GET endpoint             | Selection                                                       | Additional filter                      |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------- |
| `/discovery/quick-wins`  | Near-term markets with high-priced, narrow-spread outcomes      | `horizonHours=24\|72\|168`, default 72 |
| `/discovery/smart-money` | Observed position increases by qualified, distinct owner groups | None                                   |
| `/discovery/hidden-gems` | Recent public, quality-gated holder research                    | None                                   |

Common parameters: `limit` (1–50, default 20), `cursor`, `q` (at most 100 characters), comma-separated `categories` and `venues`. Venue values are `polymarket`, `limitless`, `kalshi`; live venue lifecycle policy still controls availability. Category identifiers use lowercase letters, digits, underscores and hyphens; an absent category returns an empty collection. Search normalizes case, accents and whitespace and requires every query term in the event, market or outcome name. There is no translation or semantic search.

`withResearch=true` restricts Quick Wins and Smart Money to markets with a current public approved directional research note. Hidden Gems already requires that research. Filters apply before choosing an event representative and before pagination. Changing filters requires a new traversal; changing `limit` is allowed.

Research presence is not endorsement of the selected side: for Quick Wins and Smart Money, `research.side` may differ from `selection.side`. Display the research as an opposing view in that case, not as support for the selected ticket. Research has its own instrument and dated price; never silently use its price or side for the Discovery selection.

Example: `GET /discovery/quick-wins?limit=20&horizonHours=72&categories=politics&withResearch=true`.

## Response and navigation

The executable contract is in `apps/api/src/schemas/discovery.ts`; `apps/api/openapi.json` contains all three paths. `reason` is a discriminated union using `kind`, with separate Quick Wins, Smart Money and Hidden Gems metrics. Monetary values and prices are decimal strings. Missing values are `null`, never fabricated zeroes.

The envelope contains `items`, `nextCursor`, `snapshotId`, `generatedAt`, `freshness` and `page`. `freshness.sourceAsOf` dates the prepared evidence; quotes have their own `asOf`. `projectionRefreshedAt` reports the last successful activity projection refresh for Quick Wins, not the modification time of an unchanged metric row.

Each item contains:

- `market`: `marketId`, `eventId`, both titles, category, venue, image and `resolutionCondition`. Always show the parent event alongside short names such as “30–34”.
- `selection`: canonical YES/NO, `outcomeLabel`, and the explicit instrument with token, generation and expiry. NO on a negatively worded proposition is still NO to that exact proposition.
- `quote`: selected-side bid, ask, midpoint, timestamp and `fresh|stale|unavailable` status. These are top-of-book observations, not an executable order quote.
- `timing`: source market expiration, trading close and event end. `settlementAt` is null and the timing basis explicitly does not promise settlement or payout at expiration or match start.
- `research`: current public note ID, headline, full public summary, side, strength, dated research price, safe source citations, caveats and research instrument. Internal prompts and model metadata are not returned.
- `copyAvailable`: whether current instrument and price checks permit opening the existing ticket. It is not order authorization; Hidden Gems disables it for stale/missing quotes or a changed research instrument/expiry.

Use `marketId`/`eventId` for existing market/event screens, `research.noteId` for research detail, and `reason.traders[].walletId` for public wallet profiles. Display names are optional public labels, not private user identities. Discovery introduces no new page IDs or trading action.

## Collection semantics

### Quick Wins

Both YES and NO are evaluated. The market must be active and orderable, expire within the requested horizon, have positive valid 24-hour volume, known liquidity of at least $1,000, rules and a current instrument. The selected side needs midpoint and ask between **0.85 and 0.95 inclusive**, spread at most 0.03, noncrossed bid/ask and a quote at most five minutes old. Resolved, proposed or disputed outcomes are excluded.

Ranking is expiration ascending, spread ascending, liquidity descending, stable ID. The first currently eligible representative of each event is returned. `grossReturnIfWin = 1 / ask - 1` excludes fees, depth and slippage. Do not label it expected, risk-free or guaranteed return. Available rules have not been reviewed by a human for clarity. Missing liquidity is not estimated; venue coverage can therefore be uneven.

The price band leaves approximately 5.26–17.65% gross return **if the selected outcome wins**, compared with 2.04% at a 0.98 ask. This is not a net-return floor or a calibrated 85–95% win probability. Trading fees vary and must come from the trading quote; lower-priced outcomes also carry more market-implied loss risk.

### Smart Money

Qualified wallets were active within seven days, have metrics within 24 hours, positive approximate 30-day PnL, at least 20 resolved observations and positive historical price-relative edge. Existing market-maker exclusion rules and runtime thresholds apply. Historical PnL includes marked open positions and is not a probability for this market.

The full 24-hour `snapshot_delta` window is used. BUY adds absolute shares and SELL subtracts them; trade records are not added again. Fresh current holdings must confirm the increase. Known linked wallets are grouped before netting SELL offsets and hedge vetoes. Nonqualifying known siblings can reduce or veto an owner's support but cannot qualify a new owner or inflate qualified inflow. Current and retained-increase value must each reach $100; opposite holdings of at least $100 exclude that owner/market. At least two qualifying owner groups are needed.

Call this an **observed position increase**, not a confirmed purchase. The response gives owner-group count, approximate retained increase value, observation time, up to three public qualified wallet summaries and opposite-side support. `opposingViews=true` means do not claim consensus. Rank by owner-group count, then increase value, then stable ID; collapse repeated events.

### Hidden Gems

Only `holder_research`, `signal`, `active`, explicit `PUBLISH` quality-gate notes from the last seven days qualify. The latest active public signal per market is checked again when reading. Strong precedes good, then newest first, then stable ID. Map signals are not substituted. A low price alone is not proof of mispricing.

The research price and current quote are separate. The research remains readable when a quote becomes stale; current quote values are then null and Copy is unavailable. A replaced token/generation/expiry also disables Copy. Retracted, superseded or no-longer-public research is removed during hydration.

## Pagination and recovery

Pass `nextCursor` unchanged with the same normalized filters. The cursor binds collection version, filters and traversal position. Versions live for 15 minutes and retain their original ranking; current quotes and availability are always rechecked. Disabling a venue does not shift cursor positions. Results can disappear as markets close or research is withdrawn.

A request checks batches of `max(40, 2 × limit)` candidates, at most 100 per batch and 200 per request. If it reaches the work budget, an empty/short page can still have `nextCursor`. Continue while it is non-null; do not treat an empty `items` array alone as the end. `page.scanBudgetReached` explains this case. No SQL OFFSET pagination is used.

| Status and code                | Client behavior                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------- |
| 400 `discovery_invalid_cursor` | Discard cursor; restart with consistent filters. Validation errors also use 400. |
| 409 `discovery_cursor_expired` | Start a new traversal. The server never silently swaps its version.              |
| 503 `discovery_unavailable`    | Respect `Retry-After: 15`. Do not show “no opportunities”.                       |

Quick Wins and Hidden Gems refresh each minute; Smart Money refreshes every five minutes. Quick Wins' base pool refreshes every five minutes, with minute-level price screening. On refresh failure the last complete version remains available for at most five minutes (Quick Wins/Gems) or 15 minutes (Smart Money), marked stale. Older frozen cursor versions are readable only while the current source collection still meets this availability bound.

### Quote refresh demand

Reading a page marks the current canonical tokens for both sides of the checked markets hot and enqueues normal price-refresh demand, using the same shared mechanism as the feed. This happens before stale candidates are excluded, including stale Hidden Gems kept for reading. Background collection preparation also enqueues stale or missing quotes from its bounded batches, including Quick Wins candidates that have not entered a snapshot. Background demand does not mark the whole source pool hot or requeue already-fresh quotes.

Each batch contains at most 100 markets / 200 distinct token references; existing queue enablement, per-request and total-queue caps, deduplication and indexer scheduling still apply. No new direct venue fetch or synchronous quote wait is added to the HTTP path. Redis enqueue failures do not fail a page or relax validation. A refresh request is not proof of freshness: only a subsequent stored observation can pass the five-minute check. Newly recovered candidates can appear in a later completed snapshot; an existing cursor retains its frozen candidate list.

## Operations and validation

`server.ts` starts preparation after the API begins listening; closing the server stops it. Building a Fastify app or generating OpenAPI does not start preparation. Redis is required for Discovery, not a trigger to run heavy SQL synchronously on cache misses. Cold requests can request one asynchronous refresh. No new container, cron, PostgreSQL table, index or migration is needed.

Discovery-owned Redis state is confined to `discovery:v1:*`: immutable snapshots, current pointers, Quick Wins base pool, per-section checkpoints and renewable owner-fenced leases. Quote demand additionally uses the existing shared hot-token sets and price-refresh queues. A worker turn is bounded to 20 seconds, source cursors survive restart, failed refreshes retry with 15-second backoff and only complete snapshots are atomically published. Database reads use `BEGIN READ ONLY`, statement and lock timeouts. Quote/position history is accessed by existing per-token/per-wallet indexes; metadata-only wallet owner links are scanned in resumable PK pages because they have no dedicated expression index.

### Price-band validation on 25 October 2026

A read-only comparison at 19:03 UTC used all 770 markets in the price-agnostic Quick Wins source pool, current canonical quote rows and the same instrument/lifecycle/rules/liquidity checks. Counts below are distinct events after ranking, not raw sides. Both bands used the same captured observations; no production queues or prices were changed.

| Horizon            | Previous 0.90–0.98 | Revised 0.85–0.95 |
| ------------------ | -----------------: | ----------------: |
| 24 hours           |                  6 |                 6 |
| 72 hours (default) |                 10 |                11 |
| 168 hours          |                 22 |                20 |

The default horizon gained a BTC price-threshold event and additional lower-priced sports outcomes; several 0.958–0.967 entries dropped out. The new band improves payout headroom and marginally increases default-horizon coverage in this sample, not every horizon or future sample. Of 1,526 lifecycle-eligible sides, 370 quotes were fresh, 820 stale and 336 unavailable. Those coverage gaps motivated queue integration, not accepting old quotes as fresh. Resolution deadlines embedded in rules may still differ from source expiration, and separate venue events may describe the same match; this change does not claim to solve either issue.

Relevant verification files are `discovery-domain-tests.ts`, `discovery-service-tests.ts`, `discovery-openapi-tests.ts` and `discovery-integration-tests.ts`. The integration suite requires an explicit disposable PostgreSQL 16 target and a local Redis namespace. It exercises exact SQL, normal/generic plans, rollup fallback, Redis Lua, HTTP serialization and read-only protection. Set `HUNCH_DISCOVERY_SCALE_ROWS=1000000` for the historical-growth case. It must never point to production.

Run the domain, service and OpenAPI suites through the same sequential runner as the other API tests:

```sh
node --import tsx apps/api/src/test-runner.ts --unit discovery
bun apps/api/src/test-runner.ts --unit discovery
```

These executable test modules await every asynchronous assertion before returning to the runner; they do not require a separate `bun test` invocation.

Generate the Discovery OpenAPI paths without initializing application services using `node --import tsx apps/api/src/discovery-openapi-tests.ts --write`; use `--compare` to check a generated local artifact for drift. With no flags the test validates the executable contract without requiring the gitignored generated file. The ordinary complete OpenAPI exporter remains supported.

### Initial release verification — 2026-10-25

The complete workspace build, typecheck and lint passed (47 tasks). The domain/service suites passed under Node and Bun 1.4.4 (21 tests each), as did the OpenAPI contract checks. PostgreSQL 16 and Redis integration passed in both runtimes, including one million historical position rows, ordinary and generic prepared plans, rollup fallback, public-note retraction, owner-family hedges and PostgreSQL read-only enforcement. Independent review gave GO after corrections to owner netting, venue-stable pagination and lightweight DFlow availability checks.

Bounded production `EXPLAIN ANALYZE` checks used read-only transactions, a 15-second statement timeout, a two-second lock timeout and no load generation. Representative execution times for the final SQL are below; these are individual SQL measurements, not API p95 or a latency guarantee.

| Operation                                         | Execution | Existing access path                                |
| ------------------------------------------------- | --------: | --------------------------------------------------- |
| Quick Wins source page, 500 rows                  |    328 ms | Partial positive-volume index; market PK            |
| Qualified-wallet source page, 500 raw rows        |    285 ms | Last-activity index; wallet/owner PK lookups        |
| Smart Money inputs, 500 wallets                   |  1,214 ms | Exposure PK; wallet/type/time activity index        |
| Smart Money forced snapshot fallback, 500 wallets |  3,430 ms | Wallet/venue/time and wallet/time snapshot indexes  |
| Current cards, 20 markets                         |     12 ms | Market PK; canonical token and latest-quote indexes |
| Current cards, 100 markets (generic)              |    101 ms | Same indexed batch joins                            |
| Public research source (generic)                  |     96 ms | Existing public-note partial index                  |
| Current public research, 100 market IDs (generic) |      7 ms | Existing public market-note partial index           |
| Metadata-only owner links, 2,000 raw rows         |    963 ms | Resumable wallet PK page                            |

Resumed and empty source pages were also checked; empty Quick Wins/wallet tails completed in approximately 2 ms. No new production index was needed, and neither position nor quote history required a full scan. Metadata-only ownership discovery deliberately traverses wallet PK pages in the background, not the position history or request path. The activity projection had a successful refresh approximately four minutes before the final metadata check.

On the disposable local fixture, 30 warm Fastify-injected HTTP requests measured p95 of approximately 9–17 ms for 20 cards and 11–16 ms for 50 cards across Node/Bun. Four waves of eight concurrent requests measured p95 of 58–68 ms for 20 cards and 77–84 ms for 50 cards, below the 300/700 ms targets. These tests include Redis, PostgreSQL, routing and serialization, but not the production proxy/network or representative production traffic; production end-to-end p95 remains a post-release measurement. The large-history check and load tests ran only on the disposable database.

### Price-band and quote-demand follow-up verification

The 0.85–0.95 follow-up passed the full 47-task build/typecheck/lint and five targeted test files under Node and Bun: domain, OpenAPI, quote-demand recovery, service/pagination and the shared price-refresh queue. Regression checks cover inclusive boundaries on both sides, midpoint versus ask, stale candidates recovering in a later build, current canonical tokens, disabled venues, deduplication, the 200-token batch bound and pending/failed enqueue calls not blocking HTTP. PostgreSQL 16/Redis integration and ordinary/generic plans passed again in both runtimes (1,000 historical fixture rows for this rerun; production SQL was unchanged). Warm local p95 was 9–11 ms for 20 cards and 12–14 ms for 50; with eight concurrent requests it was 54 ms and 73–83 ms respectively. Quote-demand effects on live production coverage require the separate production release; no queues or indexers were manually triggered for this comparison.
