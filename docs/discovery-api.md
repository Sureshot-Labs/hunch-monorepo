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

The executable contract is in `apps/api/src/schemas/discovery.ts`; generated `apps/api/openapi.json` contains the three collection paths and the Smart Money trader drilldown. `reason` is a discriminated union using `kind`, with separate Quick Wins, Smart Money and Hidden Gems metrics. Monetary values and prices are decimal strings. Missing values are `null`, never fabricated zeroes.

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

For a hypothetical $100 stake, compute `payoutMultiplier = 1 / ask`, `grossPayoutIfWinUsd = 100 / ask`, and `grossProfitIfWinUsd = grossPayoutIfWinUsd - 100`, using decimal arithmetic and the selected side's ask. At 0.90 these are approximately 1.1111×, $111.11 and $11.11, respectively. The payout includes the stake; neither payout nor profit is an expected return. `research` is nullable in both Quick Wins and Smart Money: hide an optional Signal block when it is absent.

### Smart Money

Qualified wallets were active within seven days, have metrics within 24 hours, positive approximate 30-day PnL, at least 20 resolved observations and positive historical price-relative edge. Existing market-maker exclusion rules and runtime thresholds apply. Historical PnL includes marked open positions and is not a probability for this market.

The full 24-hour `snapshot_delta` window is used. BUY adds absolute shares and SELL subtracts them; trade records are not added again. Fresh current holdings must confirm the increase. Known linked wallets are grouped before netting SELL offsets and hedge vetoes. Nonqualifying known siblings can reduce or veto an owner's support but cannot qualify a new owner or inflate qualified inflow. Current and retained-increase value must each reach $100; opposite holdings of at least $100 exclude that owner/market. At least two qualifying owner groups are needed.

Call this an **observed position increase**, not a confirmed purchase. The response gives owner-group count, approximate retained increase value, observation time, up to three public qualified wallet summaries and opposite-side support. `opposingViews=true` means do not claim consensus. Rank by owner-group count, then increase value, then stable ID; collapse repeated events.

#### Same-cohort positioning and See Traders

New snapshots add optional `reason.positioning`. Its `selected` and `opposite` objects each contain `side`, `ownerGroups`, `walletCount`, `positionValueUsd` and `observedIncreaseValueUsd`. `selectedIncreaseShare` is the selected increase divided by both sides' total increase (a decimal ratio, not a win probability); `windowHours` is 24. `oldestSnapshotAt` and `latestSnapshotAt` date the retained holdings. The basis is `qualified_owner_groups_with_retained_snapshot_increase`.

These totals and the trader pages use exactly the same Discovery owner cohort, including qualified opposing groups even if fewer than two support that side. A group is admitted through its qualified representative, then related holdings and offsets are consolidated. `walletCount` counts positive-position wallets within those admitted groups, including known siblings; it does **not** claim that every individual wallet independently passed the profitability rules. Nonqualifying siblings cannot increase qualified inflow. Historical metrics belong to the representative alone, not a sum of related wallets' samples. Do not mix these values with legacy wallet-positioning endpoints.

```text
GET /discovery/smart-money/:marketId/traders?snapshotId=<uuid>&side=YES&limit=20
```

- Pass the collection's `snapshotId` and the card's `selection.side`. `side` is optional for compatibility; without it the first matching representative in snapshot order is used. Explicit side prevents ambiguity when both sides exist in the prepared pool.
- `limit` defaults to 20, maximum 50; `cursor` is an opaque continuation bound to this snapshot, market and side. Keep those parameters unchanged; page size may change.
- Response: `snapshotId`, `marketId`, `selectedSide`, `generatedAt`, the same `positioning`, `items`, `nextCursor`.
- One item is one owner group: opaque `groupId`, `side`, `walletCount`, both value fields, `oldestSnapshotAt`, `latestSnapshotAt`, `observedAt`, and `representative` with the existing safe public trader fields. Internal account links, member addresses and private owner IDs are not exposed.
- All groups on both sides are returned across pages, selected side first, retained increase descending, stable group ID. The old three-representative summary is unchanged.
- Version lifetime is 15 minutes. Expiration returns 409; a missing market, disabled venue, closed market or changed instrument returns 404. A stale quote alone does not invalidate this dated, read-only cohort list. There is no order action in this response.
- Snapshots created by old code remain readable as collection pages. If they lack the new full cohort, drilldown returns 503; refresh the parent collection after the normal background rebuild and use its new snapshot. Retrying an old snapshot cannot invent missing members.

### Hidden Gems

Only `holder_research`, `signal`, `active`, explicit `PUBLISH` quality-gate notes from the last seven days qualify. The latest active public signal per market is checked again when reading. Strong precedes good, then newest first, then stable ID. Map signals are not substituted. A low price alone is not proof of mispricing.

The research price and current quote are separate. The research remains readable when a quote becomes stale; current quote values are then null and Copy is unavailable. A replaced token/generation/expiry also disables Copy. Retracted, superseded or no-longer-public research is removed during hydration.

#### Experimental estimate (`research-odds-v1`)

Hidden Gems can add `estimate` and nullable `valuation` without changing eligibility or ranking. **Display “Experimental estimate”, not “true probability”, calibrated prediction or promised upside.** The method uses the selected side's current midpoint; it never anchors an old probability to a newly fallen ask.

Let `p` be current midpoint, `a` current ask, `w` the representative trader's actual 30-day resolved win rate, `b` its historical entry-price-implied win rate, `n` its resolved sample size, and `ageDays` the research age. `S` and `O` are the research's saved qualified dollar support on the selected and opposite sides.

```text
wAdjusted = (n*w + 50*b) / (n + 50)
delta = clamp(logit(wAdjusted) - logit(b), 0, ln(2))
balance = (sqrt(S) - sqrt(O)) / (sqrt(S) + sqrt(O))
decay = 2^(-ageDays / 7)
pEstimate = logistic(logit(p) + delta*balance*decay)
```

`logit(x) = ln(x/(1-x))`; `logistic(x) = 1/(1+exp(-x))`. Parameters **50 observations, 2× odds cap and seven-day half-life are fixed heuristics**, not fitted coefficients. Negative historical edge produces no inverse-trader strategy. Equal known support, including two known zeroes, produces zero adjustment. Unknown bilateral support uses `balance=1`, `coverage: representative_only` and a warning, never a consensus claim. Opposing saved support can make the adjustment negative.

Use the explicitly saved representative wallet target when available; otherwise use the first wallet target by `target_rank,target_id`. Never select the best historical edge after seeing the outcome. The estimate evaluates the **published research's historical positioning evidence**, not continued ownership. Missing, zero or stale current holdings do not suppress the estimate. Keep the saved representative/side and research instrument checks, metrics within 24 hours and a valid fresh quote within five minutes. Missing identity/metrics or an incompatible instrument can still suppress only the estimate, not the readable research. No new collection, model calls or repair jobs are triggered.

`positionBasis: published_research` describes that historical basis. Optional `currentPositionStatus` is informational: `confirmed` means positive matched-asset shares in a recent retained snapshot; `not_confirmed` means no positive match in that recent batch, **not proof of a sale**; `stale` means the observation is too old or future-dated; `unavailable` means no observation time. `positionAsOf` remains the latest retained batch time, not a reconstructed sale time. Token/contract/binding checks still protect the current-ownership diagnostic. They do not turn incomplete portfolio coverage into withdrawal of a published idea.

`estimate` includes `status`, `reason`, `method`, `version: 1`, `calibrated: false`, `side`, decimal nullable `probability` and `marketProbability`, nullable `representativeWalletId` and `sampleSize`, source times (`researchAsOf`, `metricsAsOf`, `positionAsOf`, `quoteAsOf`), `calculatedAt`, `coverage` and warnings. All probabilities refer to `side`, never implicitly YES.

| Status                          | Meaning                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `available` / `adjusted`        | Nonzero heuristic adjustment; may be below the market                                                         |
| `market_only` / `no_adjustment` | Estimate equals midpoint, not independent confirmation                                                        |
| `unavailable`                   | No numeric estimate; reason identifies missing/stale inputs, side/instrument mismatch or quote unavailability |

Unavailable reasons are `inputs_unavailable`, `representative_unavailable`, `side_mismatch`, `instrument_changed`, `quote_unavailable`, `metrics_unavailable`, `metrics_stale`, `invalid_research_time`. `position_unavailable` and `position_stale` remain accepted for old responses but are no longer emitted as estimate blockers. Existing cached input versions are recalculated on read with the new ownership-independent rule; snapshots without any estimate inputs still report `inputs_unavailable` until a background version exists.

Keep the three `valuation` fields distinct:

| Field                     | Formula                        | Unit / meaning                                                             |
| ------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `probabilityDifferencePp` | `100 * (pEstimate - midpoint)` | Percentage points                                                          |
| `modelUpsideRatio`        | `pEstimate / ask - 1`          | Model-implied gross net return per stake; ratio, not a promised price move |
| `grossReturnIfWin`        | `1 / ask - 1`                  | Conditional gross profit per stake if the selected side wins               |

Ratios and amounts use existing decimal arithmetic; the bounded log-odds transform uses floating point rounded to 12 decimal places. This numerical precision is not forecast certainty. Preserve negative values. `basis` is `top_ask_excludes_depth_fees_slippage`; valuation is null when the estimate is unavailable. Inputs are batch-loaded in the background, but the formula and ratios are recomputed from current quotes on each read. Research evidence dates are not upgraded to quote dates.

#### Optional public context

`research.sourceCount` counts the actually returned safe public sources. `research.contextHighlight` is nullable: `{kind: "news", sourceId, headline, url, publishedAt}` from an existing public citation, not a newly fetched article. A publication date is **not** a future catalyst date. No source means no headline or fabricated source count.

`research.evidenceMetrics` contains only typed, whitelisted existing evidence: `kind`, `scope`, scalar/range decimal `measurement` with unit, nullable `horizonDays` and `sampleSize`, `asOf`, nullable public `sourceId`, and basis `saved_research_evidence_not_current_probability`. External metrics require an approved public source. Internal prompts, wallet links and arbitrary model metadata are excluded. Dated price-relative edge is not an independent current probability.

Use the existing `summary`, `caveats`, `sources` and `/hunches/:noteId`; this patch does not create a long-form article, calendar or notification subscription. New fields are optional so old clients and in-flight snapshot versions continue working.

## Pagination and recovery

Pass `nextCursor` unchanged with the same normalized filters. The cursor binds collection version, filters and traversal position. Versions live for 15 minutes and retain their original ranking; current quotes and availability are always rechecked. Disabling a venue does not shift cursor positions. Results can disappear as markets close or research is withdrawn.

A request checks batches of `max(40, 2 × limit)` candidates, at most 100 per batch and 200 per request. If it reaches the work budget, an empty/short page can still have `nextCursor`. Continue while it is non-null; do not treat an empty `items` array alone as the end. `page.scanBudgetReached` explains this case. No SQL OFFSET pagination is used.

| Status and code                  | Client behavior                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| 400 `discovery_invalid_cursor`   | Discard cursor; restart with consistent filters. Validation errors also use 400.   |
| 404 `discovery_market_not_found` | Trader drilldown no longer available for that market/side; refresh the collection. |
| 409 `discovery_cursor_expired`   | Start a new traversal. The server never silently swaps its version.                |
| 503 `discovery_unavailable`      | Respect `Retry-After: 15`. Do not show “no opportunities”.                         |

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

### Card enrichment verification — 2026-10-26, local patch (not deployed)

Seven focused files passed under Node and Bun 1.4.4: discovery domain, service, enrichment, estimate evaluation, OpenAPI, quote-refresh and shared price-refresh queue. PostgreSQL 16/Redis integration passed in both runtimes with one million historical position rows, exact custom/generic queries, 20/50-card enrichment, empty inputs and existing rollup fallback. The full workspace build, typecheck and lint passed **47/47**. Independent review gave GO after instrument-identity, live trader-drilldown and source-URL corrections; it did not independently repeat database-scale or full-build measurements.

Regression coverage includes flat and aggregated asset metadata, explicit old/current contracts, ambiguous legacy Polymarket bindings, latest batches missing the former position, stale metrics/quotes, YES/NO, negative model return, 69¢→2¢ repricing, owner-family totals, both-side pagination, old-version compatibility/recovery and public-field projection. Query and serialization paths remain PostgreSQL read-only; no models or trading clients were added. A matching explicit contract can recover the estimate even when an old binding remains, while identity-less ambiguous rows cannot silently qualify.

On a final Node local run, warm Fastify+Redis+PostgreSQL p95 at concurrency eight was approximately **92 ms / 85 ms** for 20/50 enriched Gems; the ordinary collection checks were **129 ms / 189 ms**. All Node/Bun 20/50 checks passed the 300/700 ms targets. These are disposable-fixture measurements, not production traffic or network p95.

Final compiled enrichment SQL was also executed read-only on production (50 recent public notes, no load generation, 15-second statement and two-second lock timeouts):

| Batch / plan               |  Execution |  Planning |
| -------------------------- | ---------: | --------: |
| 20, custom                 | 241.929 ms | 10.512 ms |
| 50, custom                 | 180.315 ms |  3.497 ms |
| 50, forced generic, warmed |  44.095 ms |  2.593 ms |
| Empty, generic             |   0.245 ms |  0.024 ms |

The first custom reads included disk reads; these are not directly comparable cold/warm timings. All used existing note/target/selector/snapshot/asset-binding indexes, with **no sequential scans**. This enrichment runs during background preparation, not in the collection HTTP request. No new index or migration was introduced.

#### Reproducible probability diagnostic

`discovery-estimate-evaluation-tests.ts` calls the actual estimator using `fixtures/discovery-odds-20261026.json`: a numeric-only projection of 67 resolved markets in 50 events from the previously inspected public research cohort. It checks that metrics existed by publication, takes one earliest publication per market, weights each event equally, and reports a chronological last-17-event subset. No coefficients were fitted or selected from these results.

| Event-weighted metric    |  Market | `research-odds-v1` core | Naive price + edge |
| ------------------------ | ------: | ----------------------: | -----------------: |
| All 50 events: Brier     | 0.20221 |                 0.20669 |            0.22787 |
| All 50 events: log loss  | 0.58010 |                 0.58808 |            0.76533 |
| Last 17 events: Brier    | 0.22150 |                 0.21966 |            0.25057 |
| Last 17 events: log loss | 0.62113 |                 0.61131 |            0.95017 |

The core did **not** beat the market over the whole sample. The small chronological subset is not a held-out proof of advantage. The test prints reliability bins using individual predictions weighted within events (not averaged mutually exclusive outcomes), bin coverage, and prior/cap sensitivity over 25/50/100 observations and 1.5×/2×/3× odds. Empty or small bins are explicit. Brier is not a calibration-only score; examine the reliability curve and log loss too ([calibration methodology](https://scikit-learn.org/stable/auto_examples/calibration/plot_calibration_curve.html)).

Limitations: selected published cohort and few resolved events; historical position completeness is not reconstructed. This diagnostic assumes positive position evidence to isolate the transform at publication. It does **not** validate aged live forecasts, the seven-day decay parameter, execution costs or a trading strategy. Half-life behavior is covered by arithmetic tests, not an empirical historical-age claim. A later prospective, chronological evaluation with archived inputs is required before changing `calibrated:false` or claiming superior forecasts.

Reproduce the focused diagnostic without network or model calls:

```sh
node --import tsx apps/api/src/discovery-estimate-evaluation-tests.ts
bun apps/api/src/discovery-estimate-evaluation-tests.ts
node --import tsx apps/api/src/discovery-enrichment-tests.ts
node --import tsx apps/api/src/discovery-openapi-tests.ts --compare
```

No production data, policies, schedules, model configuration or collection logic were changed by this patch's validation. Commit and deployment require a separate action.
