# AI Market/Event Insights and Signals Pipeline (Deep Dive)

## 1) Objective

Design a production-safe pipeline that generates actionable market/event insights and signals using AI, with:

- low-latency updates for high-impact markets,
- cost controls (model/tool budget),
- reproducible outputs (versioned prompts + source snapshots),
- clear quality gates before surfacing to users.
- topic-first retrieval so one news/search pass can serve many markets/events.

This plan is grounded in the current Hunch stack (indexers, Redis, Postgres, Timescale, wallet intel, embeddings, For You, clusters).

## 2) Current State (What already exists)

### 2.1 Data and infra already in place

- Unified market/event data in Postgres:
  - `unified_events`, `unified_markets`, `unified_tokens`, `unified_market_tokens`
- Time-series market activity:
  - `unified_book_top`, `unified_last_trade`
  - CAGGs: `unified_book_top_1m`, `unified_last_trade_1m`, `unified_book_top_1h`, `unified_last_trade_1h`, `unified_last_trade_24h`
  - rollups: `unified_market_trade_24h`, `unified_event_trade_24h`
- Wallet intel/whale data:
  - `wallet_activity_events`, `wallet_position_snapshots`, `wallet_activity_hourly`, `wallet_position_exposure`, `wallet_inferred_outcomes`, `wallet_profiles`
- Indexers already enqueue embedding jobs:
  - Polymarket, DFlow/Kalshi, Limitless all call `enqueueEmbedItems(...)`

### 2.2 AI foundation already in place

- AI worker exists (`apps/ai-worker`) and already:
  - consumes Redis stream (`ai:embed:queue:active` by default),
  - computes embeddings,
  - writes vectors to Redis (`ai:embed:market:*`, `ai:embed:event:*`),
  - maintains vector indexes (`idx:ai:embed:market`, `idx:ai:embed:event`).
- Similarity endpoints already exist:
  - `/events/:eventId/similar`, `/markets/:marketId/similar`
- Personalized retrieval exists:
  - `/feed/for-you` computes user vector from watchlist/orders/positions + event embeddings.
- Cluster analysis path exists:
  - `ai-embed-cluster.ts`, `/clusters`, optional web context, model controls in env.

### 2.3 Implication

You do not need a greenfield AI system. You need a second layer on top of existing embeddings + market/wallet telemetry:

1. selection,
2. triggering,
3. analysis generation,
4. serving + UX.

### 2.4 Production DB reality check (verified on 2026-02-09 UTC)

This section validates assumptions in this plan against the live production database.

Core footprint:

- `unified_markets`: ~522k rows, ~2.7 GB
- `unified_events`: ~215k rows, ~623 MB
- `unified_market_tokens`: ~1.04M rows, ~810 MB
- `wallet_position_snapshots`: ~1.60M rows, ~1.17 GB
- `wallet_activity_events`: ~125k rows, ~109 MB

Freshness (max timestamps observed):

- `unified_book_top`: `2026-02-09 14:41:31+00`
- `unified_last_trade`: `2026-02-09 14:41:31+00`
- `unified_book_top_1m`: `2026-02-09 14:38:00+00`
- `unified_last_trade_1m`: `2026-02-09 14:38:00+00`
- `unified_market_trade_24h`: `2026-02-09 14:37:24+00`
- `unified_event_trade_24h`: `2026-02-09 14:36:00+00`
- wallet-intel derived tables (`wallet_*`): around `2026-02-09 14:00-14:07+00`

Timescale policy settings (prod at time of check):

- Raw hypertable retention:
  - `unified_book_top`: `drop_after = 30 days`
  - `unified_last_trade`: `drop_after = 30 days`
- Compression:
  - `unified_book_top`: `compress_after = 7 days`
  - `unified_last_trade`: `compress_after = 7 days`
- CAGG refresh cadence:
  - `unified_book_top_1m`: every `1 minute` (`start_offset=24h`, `end_offset=1m`)
  - `unified_last_trade_1m`: every `1 minute` (`start_offset=24h`, `end_offset=1m`)
  - `unified_last_trade_1h`: every `10 minutes` (`start_offset=7d`, `end_offset=10m`)
  - `unified_last_trade_24h`: every `1 hour` (`start_offset=30d`, `end_offset=10m`)
  - `unified_book_top_1h`: every `1 hour` (`start_offset=7d`, `end_offset=10m`)

Venue/status shape:

- Markets:
  - `polymarket`: 459,686 total, 42,201 active
  - `kalshi`: 50,984 total, 39,657 active
  - `limitless`: 11,872 total, 11,339 active
- Events:
  - `polymarket`: 193,402 total, 5,810 active
  - `kalshi`: 10,544 total, 10,544 active
  - `limitless`: 10,847 total, 10,540 active

Data sparsity and quality constraints:

- `volume_24h` is sparse in base tables:
  - `unified_events`: Polymarket ~95.28% null, Limitless 100% null, Kalshi 0% null
  - `unified_markets`: Polymarket ~78.49% null, Limitless 100% null, Kalshi 0% null
- Active market BBO fields in `unified_markets` are not reliable for all venues:
  - Kalshi active rows with both `best_bid` and `best_ask` null: 22,125
  - Polymarket active rows with both null: 0
- `unified_last_trade.tx_hash` is mostly null (~6.40M of ~6.78M rows).
- 24h rollups are sparse by design (only markets/events with recent trade activity):
  - Active market coverage via `unified_market_trade_24h`: Polymarket ~12.58%, Kalshi ~2.85%, Limitless 0%
  - Active event coverage via `unified_event_trade_24h`: Polymarket ~23.68%, Kalshi ~1.12%, Limitless 0%

Wallet-intel coverage notes:

- Distinct wallets in snapshots: 18,216
- Distinct wallets with profiles: 171 (~0.94% coverage)
- Activity composition currently dominated by `activity_type='delta'` (`wallet_activity_events`)
- Snapshot source mix includes `polymarket`, `alchemy`, `followed_wallet`, `solana`, `snapshot_zero`

### 2.5 Plan adjustments required by production reality

- Treat `unified_events.volume_24h` and `unified_markets.volume_24h` as optional, not primary.
- Build volume features from rollups/CAGGs first, with null-safe fallback to 0.
- For microstructure features, use `unified_book_top`/`unified_book_top_1m` as the canonical source, not `unified_markets.best_bid/best_ask`.
- Keep event-first synthesis as default:
  - Kalshi has high fan-out (`avg ~32.6` active markets/event, max observed `1024`), so market-by-market LLM generation is expensive and noisy.
- Use profile-driven language only when `wallet_profiles` exists; otherwise use deterministic wallet stats.

### 2.6 Production sample rows (for external research context)

Representative rows captured from prod:

```json
{
  "unified_events": {
    "id": "polymarket:192350",
    "venue": "polymarket",
    "title": "Kilmarnock FC vs. St Mirren FC",
    "status": "ACTIVE",
    "category": null,
    "volume_24h": null,
    "liquidity": 197262.6666,
    "updated_at": "2026-02-09T14:39:33.307+00:00"
  },
  "unified_markets": {
    "id": "polymarket:579978",
    "venue": "polymarket",
    "event_id": "polymarket:39268",
    "title": "Big Game - Winning Conference ",
    "status": "CLOSED",
    "best_bid": null,
    "best_ask": 0.001,
    "volume_24h": 14322.315611,
    "updated_at": "2026-02-09T14:39:26.984+00:00"
  },
  "unified_book_top": {
    "token_id": "110752240302764069094765844423880883510535883699501945614788674265037755854960",
    "venue": "polymarket",
    "ts": "2026-02-09T14:44:17.063+00:00",
    "best_bid": 0.998,
    "best_ask": null,
    "mid": null,
    "spread": null
  },
  "unified_last_trade": {
    "token_id": "22604399103182620992495158628033019116941241848533861703219866848788343475423",
    "venue": "polymarket",
    "ts": "2026-02-09T14:44:16.837+00:00",
    "side": "BUY",
    "size": 10,
    "price": 0.65,
    "tx_hash": null
  },
  "wallet_activity_events": {
    "wallet_id": "006382c8-a19e-4d72-b5e1-138f58e9fa7a",
    "venue": "polymarket",
    "market_id": "polymarket:916732",
    "outcome_side": "YES",
    "action": "SELL",
    "activity_type": "delta",
    "delta_shares": 9810.823332,
    "size_usd": 1716.894083,
    "occurred_at": "2026-02-09T14:00:00+00:00"
  },
  "wallet_position_snapshots": {
    "wallet_id": "75b2e735-d6c3-4e37-820f-588a264d4d6e",
    "venue": "kalshi",
    "market_id": "kalshi:RECSSNBER-25",
    "outcome_side": "YES",
    "shares": 92,
    "size_usd": 0.92,
    "snapshot_at": "2026-02-09T14:00:00+00:00"
  }
}
```

These examples are intentionally raw, because nullability/sparsity patterns directly affect feature engineering and confidence gating.

## 3) Research Questions (inferred from your goal)

1. Which markets/events deserve expensive AI analysis first?
2. How often should each item be re-analyzed (freshness tiers)?
3. What should trigger updates: time schedule, market moves, whale flow, or all?
4. How to combine internal telemetry + external news/tools without exploding cost?
5. How to make outputs deterministic enough for debugging and trust?
6. How to avoid stale/duplicate insight churn?
7. How to expose confidence and evidence without overclaiming?
8. How to evaluate quality before broad rollout?
9. How to prevent high-load impact on core feed/positions latency?
10. How to rollout incrementally with reversible steps?

## 4) Target Output Types

### 4.1 Event insight (primary object)

- Human-readable summary of what is moving and why (short, concrete).
- Key drivers (price/volume/whale/news).
- Contradictions/outliers across venues/markets.
- Confidence and staleness metadata.

### 4.2 Market signal (secondary object)

Structured fields for programmatic ranking/filtering:

- `move_type`: breakout, mean-revert, flow-shock, news-shock, drift
- `horizon`: intraday, 24h, multi-day
- `confidence`: 0..1
- `support_metrics`: spread, liquidity, 24h vol acceleration, whale net flow
- `risk_flags`: thin-liquidity, one-venue dependency, stale-book

### 4.3 Why event-first

Your UI and discovery are event-centric in many places; event-level insight avoids duplicating near-identical text for each market and reduces model calls.

## 5) Selection Strategy (topic-first, then event/market mapping)

Use a scored topic queue first, then map retrieved evidence to concrete events/markets.
This is the key cost lever: one search cycle can support many markets.

### 5.1 Topic generation from live market universe

Build a canonical topic graph from `unified_events` + `unified_markets`:

- deterministic extraction:
  - entities (countries, people, teams, protocols, tickers),
  - numeric thresholds (`BTC > 150k`, `SOL < 60`),
  - time windows/deadlines,
  - category and venue.
- canonical topic key:
  - `<category>:<entity>:<constraint>:<time_bucket>`
- market sampling should be feed-like (top/trending-biased), not "all active":
  - base status/time gates:
    - `m.status='ACTIVE'`, `e.status='ACTIVE'`
    - `(m.expiration_time is null or m.expiration_time > now)`
    - `(m.close_time is null or m.close_time > now)`
    - `(e.end_date is null or e.end_date > now)`
  - quality gates:
    - `marketVolumeDisplay >= min_volume24h`
    - `marketLiquidityDisplay >= min_liquidity`
    - optional spread gate:
      - `best_bid is not null and best_ask is not null and (best_ask - best_bid) <= max_spread`
  - ranking order for topic extraction input:
    - `coalesce(marketVolumeDisplay,0) desc`
    - `coalesce(marketLiquidityDisplay,0) desc`
    - `m.updated_at desc`
- optional LLM expansion:
  - add paraphrases and adjacent terms for recall,
  - bounded to top-N expansions per topic to avoid drift.
- optional embedding/KNN merge:
  - merge near-duplicate topics into one retrieval target.

### 5.1.1 Implemented status (current)

The following is implemented in `apps/api/src/ai-topics-dry-run.ts` and validated on local DB:

- feed-like market gating is configurable:
  - `--min-volume24h`
  - `--min-liquidity`
  - `--max-spread` (optional)
  - `--require-open-now` (time/status guards)
- top-market sampling supports:
  - `--sampling global|per-venue`
  - `--order-by trending|updated`
- deterministic external retrieval pack generation is active:
  - launch prompt set (`prompt_combined`) with strict no-fallback execution
  - one combined retrieval call per topic run (`web_search + x_search`)
  - xAI tool payload shape with:
    - `web_search.filters.excluded_domains`
    - `x_search.from_date`
    - `x_search.to_date`
    - `x_search.excluded_x_handles`
- search-intent dedupe is active before cost estimation:
  - dedupe key:
    - default: `category|entity_type|entity`
    - threshold/time-sensitive topics: `category|entity_type|entity|constraint_class`
  - original topic granularity retained for internal diagnostics.

Validation snapshot (same quality gates, global sampling, trending order):

- top-50 markets:
  - `uniqueSearchTopics=39`
  - `dailyAfterCacheToolCalls=152.1`
- top-100 markets:
  - `uniqueSearchTopics=75`
  - `dailyAfterCacheToolCalls=304.2`
- top-200 markets:
  - `uniqueSearchTopics=144`
  - `dailyAfterCacheToolCalls=585.0`
- top-50 markets (per-venue sampling):
  - `uniqueSearchTopics=29`
  - `dailyAfterCacheToolCalls=113.1`

Cost implication from tool invocations only (`$5 / 1000` calls, token costs excluded):

- top-50 global: about `$0.76/day`
- top-100 global: about `$1.52/day`
- top-200 global: about `$2.93/day`
- top-50 per-venue: about `$0.57/day`

### 5.1.2 End-to-end retrieval probe (10-topic sample, 2026-02-10)

Executed with current launch contract:

- 10 executable topics (A=2, B=2, C=6)
- exactly 1 combined call per topic (`web_search + x_search`)
- no fallback prompts and no extra driver pass

Observed outcome (`/tmp/ai-search-10-results.json`, simulated mapping in `AI_SEARCH_10_SIMULATION.md`):

- parse status:
  - `OK=6`, `PARTIAL=1`, `NO_EVIDENCE=3`
- support threshold:
  - pass `7/10`, fail `3/10`
- provenance gate:
  - pass `10/10` (all runs had citations/tool metadata)
- average tool calls per topic:
  - `9.0`
- average latency per topic:
  - `43.8s`
- full-cost estimate (tools + tokens):
  - total `$0.503924` for 10 topics
  - average `$0.050392` per topic

Simulated next-stage decision quality (same 10 topics):

- `publish_candidate=2`
- `publish_context_only=4`
- `store_weak_signal=1`
- `skip_external_publish=3`

Implications for launch:

- current retrieval quality is usable, but only a subset is directly actionable.
- sports C-tier dominates call volume and should remain aggressively shed first.
- `NO_EVIDENCE` topics should not trigger fallback calls in launch mode.
- if local odds are already extreme, keep output as context-only even when external evidence is strong.

Cost-first operating point from measured data:

- at `92` topics/day: about `$4.64/day` expected.
- at `100` topics/day: about `$5.04/day` expected.
- this already includes token spend from the probe profile.

### 5.2 Topic score and ranking

Proposed topic score:

- `T = a1*coverage_z + a2*activity_z + a3*volatility_z + a4*user_interest_z + a5*novelty_need_z - a6*staleness_penalty`

Where:

- `coverage_z`: how many active events/markets depend on this topic.
- `activity_z`: aggregate recent volume/liquidity of linked markets.
- `volatility_z`: recent price/flow instability from `unified_book_top_1m` and wallet activity.
- `user_interest_z`: watchlist/positions/order overlap for signed-in population.
- `novelty_need_z`: time since last high-quality evidence refresh.
- `staleness_penalty`: penalize topics with low market freshness.

### 5.3 Retrieval cadence by topic tier

- Tier A topics: every 10-15 minutes (launch default currently 12m).
- Tier B topics: every 120 minutes (launch default; tighten to 60m only after budget/quality calibration).
- Tier C topics: every 4-6 hours or on-demand.
- Event-driven boost: temporarily promote affected topics to Tier A.

### 5.4 Evidence to market/event mapping

Map each evidence item in two steps:

1. Candidate retrieval:
- lexical match over title/slug/category/entities/threshold aliases,
- embedding similarity against event/market vectors,
- time-window and venue compatibility filters.

2. Strict rerank/classification:
- features: entity overlap, numeric threshold overlap, time alignment, category match, venue compatibility,
- output: `link_confidence`, `link_type` (`event`, `market`, `both`), `reasons`.

Only high-confidence links feed signal generation.

### 5.5 Hard filters (first pass)

- active, not expired event/market only,
- minimum activity thresholds (`volume`, `liquidity`, or recent top/trade updates),
- reject unsupported links (no threshold/time/entity match).

## 6) Triggering Model (hybrid)

Use hybrid scheduling. Pure schedule is stale; pure event-driven is noisy.

### 6.1 Time-driven topic refresh

- run per tier cadence from section 5.3,
- refresh topics, not individual markets,
- hydrate linked events/markets from cached evidence.

### 6.2 Event-driven boost triggers

Promote related topics when any fire:

- significant price move in any constituent market (`abs(delta yes-mid) >= X` in Y min),
- abrupt volume acceleration,
- whale flow spike (`wallet_activity_hourly` burst),
- event status transition / market status transition,
- cluster outlier change (if cluster analysis enabled).

### 6.3 Dedup and cooldown

Use dedup keys:

- `topic:refresh:<topicKey>:<bucket_by_tier>`
- `insight:recalc:<eventId>:<bucket_by_tier>`

and cooldown windows to prevent retrigger storms.

### 6.4 Backpressure behavior

When queue pressure rises:

- drop Tier C runs first,
- widen Tier B interval,
- keep Tier A topic refresh and only recompute linked high-impact events.

### 6.5 Scheduler/Queue execution model (recommended)

Use a split model:

- Postgres scheduler state as source of truth:
  - stores topic cadence and due-time state (`next_run_at`, `tier`, `priority`, `enabled`) in a dedicated schedule contract (see Section 8),
  - remains queryable/auditable and easy to operate.
- Redis queue/stream as execution transport:
  - dispatcher enqueues due topics in bounded batches,
  - workers consume with concurrency limits and retries.

Why this model:

- avoids replay storms after downtime,
- preserves deterministic scheduling/audit in SQL,
- allows horizontal worker scaling without losing run control.

Core timing rules:

- planner job updates topic metadata periodically (for example every 6-24h),
- dispatcher tick runs every 30-60s:
  - selects due rows ordered by `priority desc, next_run_at asc`,
  - enqueues at most `N` topics per tick (`max_topics_per_tick`),
  - uses row leasing/locking to avoid duplicate dispatch.
- workers process queue continuously and write results to Postgres.

Anti-burst/catch-up policy (required):

- after each run (success or fail), schedule from wall-clock:
  - `next_run_at = now() + cadence`
  - not `previous_next_run_at + cadence`.
- optional one-time immediate catch-up allowed at most once per topic after long pause (`max_catchup=1`),
- never replay every missed interval.

Backlog/budget guards:

- hard caps:
  - `max_topics_per_tick`,
  - `max_external_calls_per_tick`,
  - `max_external_calls_per_hour`.
- shedding order under pressure:
  1. drop Tier C,
  2. widen Tier B cadence,
  3. keep Tier A only for highest-priority intents.

Idempotency/locking:

- run idempotency key: `topic_key + time_bucket + stage_version`,
- queue claim with lease + heartbeat,
- DB uniqueness guard on `ai_insight_runs(run_key)`.

## 7) Agent/Tool Architecture

### 7.1 Canonical stage taxonomy (single source of truth)

Use these stage names everywhere (logs, run rows, dashboards, alerts, code):

1. `TopicBuild`
- deterministic topic extraction + ranking.
- output: ranked topic queue with cadence and constraints.

2. `ExternalRetrieval`
- pull broad evidence for each scheduled topic (`web_search + x_search` in launch mode),
- normalize + dedup + trust/recency scoring.

3. `Mapping`
- topic-to-event/market candidate retrieval + rerank,
- emit high-confidence links with reason metadata.

4. `SynthesisLite`
- cheap structured synthesis (`gpt-5-nano` class) for mapped events,
- requires internal feature pack; uses external evidence only when gate-eligible.

5. `SynthesisRich` (optional)
- richer synthesis (`gpt-5.2` class) only for high-impact/high-uncertainty items under quota.

6. `PublishGate`
- deterministic, non-LLM gate on confidence + freshness + evidence quality + internal corroboration.

7. `Serve`
- write latest insight snapshot and serve via API/UI with freshness/confidence metadata.

Legacy labels (`Stage0/1/2/3`) are deprecated and should not be used in new implementations.

### 7.2 Tool set

Internal tools (must-have first):

- event/market snapshot (`unified_events`, `unified_markets`)
- top-of-book and last-trade rollups (`_1m`, `_1h`, 24h rollups)
- wallet activity summary/top changes (`wallet_activity_hourly`, `wallet_activity_events`)
- related/similar context from embedding KNN (`idx:ai:embed:event/market`)
- cluster context (optional)

External tools (phase 2+):

- web/news retrieval with strict budget + source whitelist,
- X/social signal adapters only after reliability review.

Implementation rule for external retrieval:

- Use xAI tool parameters for filtering/range control.
- Do not rely on old search-engine query operators (`site:`, `-site:`, custom DSL) for core policy behavior.

### 7.3 External news provider strategy (xAI-first)

Use xAI tools as the primary external retrieval layer at launch.

Launch stack:

1. Primary retrieval: xAI Web Search + xAI X Search
- Purpose: broad web coverage + social/X coverage through one tooling surface.
- Why: single-provider operational model, unified billing, and lower integration overhead for MVP.
- Rule: all external evidence in MVP is retrieved via xAI tools, with launch mode fixed to `web_search + x_search`.

2. Optional overlay (post-MVP): direct premium feeds
- Candidates: licensed finance/news feeds if quality or latency requires it.
- Rule: introduce only after baseline precision/cost targets are measured with xAI-only retrieval.

3. Degraded mode policy
- If xAI tools degrade or exceed budget, pipeline switches to internal-only mode (no external claims).
- Rule: do not publish high-confidence external-driven insights while external retrieval is disabled.

Retrieval mode contract (must be explicit in ops and publish rules):

- `combined` (launch default): `web_search + x_search`.
- `web_only`: allowed for budget/prov-degrade shedding; publish only with stricter confidence/evidence thresholds.
- `internal_only`: no external claims; only internal-context insights allowed.

### 7.4 xAI tool contract (validated against current docs)

Use only the documented server-side tool parameters below in production request builders.

`web_search`:

- Supported controls:
  - `allowed_domains` (max 5)
  - `excluded_domains` (max 5)
  - `enable_image_understanding`
- Constraint:
  - `allowed_domains` and `excluded_domains` are mutually exclusive.
- OpenAI-compatible payload note:
  - domain filters are passed under `tools[].filters` for `web_search`.

`x_search`:

- Supported controls:
  - `allowed_x_handles` (max 10)
  - `excluded_x_handles` (max 10)
  - `from_date` (ISO8601 `YYYY-MM-DD`)
  - `to_date` (ISO8601 `YYYY-MM-DD`)
  - `enable_image_understanding`
  - `enable_video_understanding`
- Constraints:
  - `allowed_x_handles` and `excluded_x_handles` are mutually exclusive.
  - Date range should be bounded per tier (A/B/C), not open-ended.

Prompt/query policy:

- Query strings are natural-language prompts describing intent; they are not a filter DSL.
- Domain exclusion/inclusion must be applied via tool parameters, not query operators.
- Date windows must be encoded in `from_date`/`to_date` for `x_search`, and in prompt text for `web_search` only as context.

### 7.5 External retrieval query policy (deterministic)

Per topic, generate a deterministic retrieval pack:

1. `prompt_combined`
- intent: gather verifiable current facts and key drivers relevant to entity + constraint, using `web_search` and `x_search` in one request.

Launch rule:

- strict one-call pattern per executable topic run: exactly `1 combined` request with both tools enabled
- no fallback prompt family and no extra driver call during launch

Tool policy attached to each pack:

- `web_search.filters.excluded_domains`: prediction-market/self domains configured centrally.
- `x_search.from_date/to_date`: tier-based lookback windows.
- `x_search.excluded_x_handles`: optional market-platform handles (configurable).

Search dedupe rule (required before scheduling):

- Build a search-intent key:
  - default: `category|entity_type|entity`
  - threshold/time-sensitive topics: `category|entity_type|entity|constraint_class`
- Never collapse across opposite numeric direction (`above` vs `below`) or materially different threshold classes.
- Keep original topic granularity for internal scoring, but execute external retrieval once per search-intent key per cadence window.

Minimum pack by tier (launch default):

- Tier A: `1 combined`
- Tier B: `1 combined`
- Tier C: `1 combined` (or disabled by scheduler)

Budget is controlled by cadence, per-run topic caps, and tier shedding, not by adding/removing query families.

### 7.6 External evidence normalization and trust policy

Normalize all external results into one internal shape:

- `provider`, `source_domain`, `headline`, `published_at`, `url`, `summary`, `language`, `entities`.

Add trust and recency scoring:

- `trust_weight`: static per provider/domain (configured list).
- `recency_weight`: decays by age.
- `cross_source_bonus`: same claim seen across independent sources.
- `rumor_penalty`: social-only or single-source claims.

Use these in `news_novelty_z` and publish gating:

- high novelty requires either
  - at least 2 independent sources, or
  - 1 high-trust source + strong internal market/flow corroboration.
- otherwise insight remains low confidence or suppressed.

Operational definitions (required to avoid implementation drift):

- `independent_sources`:
  - must be distinct `eTLD+1`,
  - and distinct `publisher_group_id` (maintained mapping),
  - and for factual/causal claims, X-only posts do not count as independent corroboration.
- `high_trust_source`:
  - `allowed=true` in `ai_domain_policies`,
  - `trust_weight >= TRUST_PUBLISH_THRESHOLD` (config).
- `strong_internal_corroboration`:
  - freshness gates pass,
  - and at least one deterministic trigger passes (`price_move`, `flow_spike`, or `volume_acceleration`) with locked thresholds.

### 7.7 Determinism and reproducibility

Persist for each run:

- prompt version,
- model id,
- tool outputs snapshot hashes,
- timing,
- token usage,
- final structured signal + narrative.

Without this, production debugging will be painful.

### 7.8 `SynthesisLite` prompt contract (internal-first grounding)

Yes: this should be explicitly part of the plan. `SynthesisLite` is intentionally grounded in internal market data first; external evidence is an augment, not a replacement.

Prompt shape (recommended):

System prompt (stable, versioned):

- You are a market-insight synthesizer for prediction markets.
- Use provided structured inputs only; do not invent facts, prices, or timestamps.
- Internal telemetry (`event`, `markets`, `freshness`, `microstructure`, `wallet`) is primary.
- External evidence is secondary and must be cited via evidence IDs.
- If evidence is weak/contradictory/stale, return a low-confidence or non-publish decision.
- Output strictly valid JSON following `SynthesisOutputV1`.

User payload (runtime JSON):

- `topic`:
  - `topic_key`, `tier`, `category`, `entity`, `intent_anchor`
- `event`:
  - `event_id`, `venue`, `title`, `status`, `volume_24h`, `liquidity`, `end_date`
- `markets`:
  - sample market + top market snapshots (`best_bid`, `best_ask`, `last_price`, `volume_24h`, `liquidity`)
- `freshness`:
  - source ages and boolean freshness flags
- `mapping`:
  - `link_confidence`, `reasons`
- `external_evidence`:
  - `status`, `supports_topic_count`, `evidence_count`, and normalized evidence items
- `policy`:
  - `min_evidence`, `min_confidence`, `min_link_confidence`

Required model behavior:

1. Decide if evidence meets policy threshold.
2. Evaluate if current local pricing is already extreme (`~<=0.08` or `~>=0.92`) and downgrade edge claims.
3. Produce:
  - `summary_short`, `summary_long`,
  - structured `signals[]`,
  - `confidence`, `quality_score`, `risk_flags[]`,
  - `publish_recommendation.decision` with reason codes.
4. Return `INSUFFICIENT_EVIDENCE` or `STALE` when gates fail.

`SynthesisLite` output JSON contract:

- must match `SynthesisOutputV1` (Section 4 objects + serving contracts in Sections 8/9),
- must include `publish_recommendation` and `evidence_refs`,
- must include explicit `reason_codes` for explainability/debugging.

Draft implementation artifacts:

- `apps/api/src/schemas/ai-synthesis.ts`
  - `synthesisInputV1Schema`
  - `synthesisOutputV1Schema`
  - `buildSynthesisSystemPromptV1()` (embeds explicit output JSON Schema)
  - `buildSynthesisUserPromptV1(input)`

## 8) Proposed Storage Additions

Add additive tables (no breaking schema changes):

1. `ai_topics`
- `topic_key` PK, `category`, `entity`, `constraint_jsonb`, `time_bucket`
- `tier`, `score`, `active_links_count`, `last_refreshed_at`, `updated_at`

2. `ai_topic_schedule` (scheduler source of truth)
- `topic_key` FK, `next_run_at`, `cadence_sec`, `priority`, `enabled`
- `lease_expires_at`, `last_run_at`, `last_status`, `last_error`
- unique key on `topic_key`

3. `ai_topic_queries`
- `id`, `topic_key`, `query_text`, `query_kind`, `version`, `enabled`
- keeps deterministic + LLM-expanded query variants auditable.

4. `ai_topic_evidence`
- `id`, `topic_key`, `provider`, `source_domain`, `headline`, `published_at`, `url`
- `summary`, `trust_weight`, `recency_weight`, `dedup_hash`, `raw_jsonb`
- unique index on `(topic_key, dedup_hash)` to prevent intra-topic repeats while allowing cross-topic reuse.
- `raw_jsonb` is short-lived debug storage only (default TTL 7 days); long-lived records should keep references/hashes + normalized fields.

5. `ai_topic_links`
- `id`, `topic_key`, `event_id` nullable, `market_id` nullable
- `link_type`, `link_confidence`, `reasons_jsonb`, `created_at`

6. `ai_insight_runs`
- `id`, `run_key`, `stage`, `topic_key` nullable, `event_id` nullable, `market_id` nullable, `trigger_type`, `tier`, `status`
- `synthesis_lite_model`, `synthesis_rich_model`, `prompt_version`
- `started_at`, `finished_at`, `latency_ms`
- `input_hash`, `tool_snapshot_jsonb`
- `token_in`, `token_out`, `cost_usd_est`, `error` nullable

7. `ai_event_insights`
- `event_id` PK
- `latest_run_key`, `latest_stage`
- `insight_version`, `signal_version`
- `summary_short`, `summary_long`
- `signals_jsonb`, `confidence`, `quality_score`
- `evidence_jsonb` (internal + external with provenance)
- `stale_at`, `updated_at`

8. `ai_market_signals` (optional split)
- keyed by `(market_id, signal_type)`
- structured payload + confidence + freshness

9. `ai_domain_policies`
- `source_domain` PK, `allowed`, `trust_weight`, `notes`, `updated_at`
- provider/domain trust and allow/deny enforcement.

10. `ai_provider_status`
- `provider` PK, `enabled`, `last_ok_at`, `last_error_at`, `error_rate_5m`, `p95_latency_ms_5m`, `updated_at`
- circuit-breaker and health tracking for xAI tools.

11. `ai_insight_dlq`
- failed run payload metadata for replay operations (`run_key`, `stage`, `payload_hash`, `error`, `created_at`).

Indexes:

- `ai_topics(tier, score desc)`
- `ai_topic_schedule(next_run_at, priority desc)`
- `ai_topic_evidence(topic_key, published_at desc)`
- `ai_topic_links(event_id, link_confidence desc)`
- `ai_topic_links(market_id, link_confidence desc)`
- `ai_event_insights(updated_at desc)`
- `ai_insight_runs(stage, started_at desc)`
- `ai_insight_runs(event_id, started_at desc)`
- `ai_insight_runs(run_key)` unique
- `ai_topic_evidence(source_domain, published_at desc)`

## 9) API and Serving

Add read APIs first:

- `GET /events/:eventId/insight`
- `GET /markets/:marketId/signals`
- `GET /insights/feed` (ranked by impact/confidence/freshness)
- optional debug/readiness endpoints:
  - `GET /insights/topics/:topicKey`
  - `GET /insights/events/:eventId/evidence`

Serving rules:

- never block core event/market endpoints on AI path,
- return stale-but-valid insight if refresh in progress,
- include metadata:
  - `updatedAt`, `staleAt`, `confidence`, `sourceCount`, `runId`, `topicKey`.

## 10) Cost Controls

### 10.1 Budget policy

- Daily budget cap (`AI_INSIGHTS_DAILY_BUDGET_USD`)
- Per-run max tokens `SynthesisLite`/`SynthesisRich`
- Billable unit for retrieval is `server_side_tool_calls` (not request count).
- Bound tool-call explosion with `max_turns` and observed tool-usage caps (do not assume one tool call per request).
- Hard cap on topic refreshes per cycle (e.g. max 200 topics/hour)
- External news call cap per topic window (e.g. max 1-2 pulls per 10-15m bucket)
- Provider-level quotas (web vs X vs premium API)

Launch budget baseline (measured):

- average external retrieval cost is currently ~`$0.050/topic` under one-call combined mode.
- with a cost-first target of `~100 topics/day`, expected retrieval spend is about `$5/day`.
- keep default daily cap at `<= $10/day` until mapping + publish gates are calibrated on larger samples.

### 10.2 Priority shedding

When budget/queue pressure rises:

- keep Tier A,
- reduce Tier B frequency,
- disable `SynthesisRich` for low-impact items,
- disable external news enrichment first,
- keep using cached external evidence before making new calls.

### 10.3 Caching

Cache tool responses by key + short TTL:

- event snapshot cache (1-3m)
- wallet summary cache (1-5m)
- topic evidence cache (5-15m, provider-normalized key by `topic_key + recency_bucket`)
- mapped-link cache (short TTL, invalidated by major market status/price events)

## 11) Quality and Safety Gates

### 11.1 Pre-publish gate

`PublishGate` is deterministic (non-LLM). It evaluates structured outputs + metadata only.

Do not publish insight if:

- confidence below threshold,
- contradictory evidence unresolved,
- missing minimum evidence count,
- stale market data beyond threshold,
- link confidence below mapping threshold for event/market attachment.

Gate primitives (must be configured, measured, and logged with reason codes):

- `independent_sources_count`:
  - distinct `eTLD+1` and distinct `publisher_group_id`,
  - X-only sources cannot satisfy factual-independence on their own.
- `high_trust_source`:
  - source allowed and `trust_weight >= TRUST_PUBLISH_THRESHOLD`.
- `strong_internal_corroboration`:
  - freshness passes,
  - and deterministic movement/flow trigger(s) pass configured thresholds.
- `data_completeness_score`:
  - minimum required before making venue-comparative claims (avoid treating unknown as zero).

### 11.2 Hallucination control

- Evidence-first prompt format,
- explicit unknown/uncertain state allowed,
- source provenance attached to each key claim,
- penalize unsupported claims in quality scoring,
- require topic->event/market link reasons in structured output.

### 11.3 Evaluation

Offline backtest set:

- pick representative events across venues/categories,
- compare signal quality vs realized short-horizon movement,
- measure calibration (confidence vs hit rate).

## 12) Rollout Plan

Phase 0: topic and evidence foundation (1 week)

- Add topic/evidence/link tables.
- Build deterministic topic graph from live events/markets.
- Add lightweight orchestrator worker (no UI dependencies yet).

Phase 1: retrieval + mapping MVP (1-2 weeks)

- Run tiered topic refresh schedule.
- Implement evidence normalization + dedup + trust scoring.
- Implement topic->event/market mapping with confidence scoring.
- Add debug endpoints for topic/evidence/link inspection.

Phase 2: event insights MVP (1-2 weeks)

- Stage 1 insight generation from mapped evidence.
- `/events/:eventId/insight` endpoint + event-page card.
- Strict publish gating (confidence + evidence + freshness).

Phase 3: market signals + feed integration (1-2 weeks)

- Add `/insights/feed` and optional `/markets/:marketId/signals`.
- Enable `SynthesisRich` only for high-impact candidates.
- Add UI affordances for confidence and freshness.

Phase 4: external source expansion + optimization

- Optimize xAI tool usage and quotas, then optionally add direct premium feed overlays if needed.
- Auto-tune thresholds by observed precision/latency/cost.
- Add venue/category-specific tuning profiles.

## 13) SQL/Performance Guidance (important)

- Reuse existing rollups (`unified_*_1m`, `*_1h`, `*_trade_24h`) for candidate scoring.
- Treat base-table `volume_24h` and `liquidity` as nullable; always `coalesce(...)` with explicit fallback.
- Expect sparse membership in `unified_market_trade_24h` / `unified_event_trade_24h`; left join with explicit completeness flags.
- Do not treat missing venue metrics as hard zero for user-facing comparative claims (`unknown` != `0`).
- Use `unified_book_top` / `unified_book_top_1m` for BBO-derived features across venues (do not assume `unified_markets.best_bid/best_ask` is populated).
- Avoid running heavy raw hypertable scans inside AI worker.
- Use batched event IDs in queries (`unnest($1::text[])`) and order-preserving joins.
- Add bounded windows for wallet-intel joins.
- Gate profile-conditioned prompt branches by profile existence (`wallet_profiles`) and use deterministic fallback otherwise.
- Keep AI writes isolated from hot feed query paths.
- Surface `data_completeness_score` in synthesis input/output and apply stricter publish gating when completeness is low.

## 14) Risks and Mitigations

1. Cost runaway
- Mitigation: strict budget caps + tier shedding + stage gating.

2. Noisy trigger storms
- Mitigation: dedup keys + cooldown + minimum delta thresholds.

3. Stale insight shown as fresh
- Mitigation: `stale_at` and explicit freshness metadata in API.

4. Model over-interpretation
- Mitigation: structured evidence requirements + low-confidence suppression.

5. DB pressure
- Mitigation: rely on aggregates, avoid full raw scans, cap queue throughput.

## 15) Recommended Defaults (starting values)

- `AI_INSIGHTS_ENABLED=true`
- `AI_INSIGHTS_MAX_CONCURRENCY=2`
- `AI_INSIGHTS_STAGE1_MODEL=openai/gpt-5-nano`
- `AI_INSIGHTS_STAGE2_MODEL=openai/gpt-5.2`
- `AI_INSIGHTS_DAILY_BUDGET_USD=10`
- `AI_INSIGHTS_MAX_SERVER_SIDE_TOOL_CALLS_PER_DAY=1800`
- `AI_INSIGHTS_MAX_SERVER_SIDE_TOOL_CALLS_PER_HOUR=120`
- `AI_INSIGHTS_TOPIC_REFRESH_MAX_PER_HOUR=30`
- `AI_INSIGHTS_TOPIC_EXPANSION_MAX=8`
- `AI_INSIGHTS_TIER_A_REFRESH_MIN=12`
- `AI_INSIGHTS_TIER_B_REFRESH_MIN=120`
- `AI_INSIGHTS_MIN_CONFIDENCE=0.62`
- `AI_INSIGHTS_MIN_LINK_CONFIDENCE=0.70`
- `AI_INSIGHTS_MAX_EXTERNAL_CALLS=1`
- `AI_INSIGHTS_NEWS_PROVIDER=xai_tools`
- `AI_INSIGHTS_XAI_TOOLS=web_search,x_search`
- `XAI_API_KEY=<secret>`
- `AI_INSIGHTS_NEWS_CACHE_TTL_SEC=900`
- `AI_INSIGHTS_RAW_EVIDENCE_TTL_HOURS=168`
- `AI_INSIGHTS_NEWS_MAX_CALLS_PER_TOPIC_WINDOW=1`
- `AI_INSIGHTS_TARGET_TOPICS_PER_DAY=90`
- `AI_INSIGHTS_RETRIEVAL_MODE=combined_only`
- `AI_INSIGHTS_RETRIEVAL_MODE_FALLBACK=web_only`
- `AI_INSIGHTS_DEGRADED_MODE=internal_only`
- `AI_INSIGHTS_WEB_EXCLUDED_DOMAINS=polymarket.com,kalshi.com,limitless.exchange,hunch.trade`
- `AI_INSIGHTS_X_EXCLUDED_HANDLES=polymarket,kalshi`
- `AI_INSIGHTS_TIER_A_LOOKBACK_HOURS=24`
- `AI_INSIGHTS_TIER_B_LOOKBACK_HOURS=72`
- `AI_INSIGHTS_TIER_C_LOOKBACK_HOURS=168`

These are launch defaults for shadow/canary, not broad-publish tuning.
`AI_INSIGHTS_MIN_CONFIDENCE` and `AI_INSIGHTS_MIN_LINK_CONFIDENCE` remain placeholders until calibration gates pass.

## 16) Recommended First Implementation Slice

Lowest-risk/highest-value first slice:

1. Deterministic topic graph for active crypto/politics/sports topics.
2. Topic-level retrieval using xAI Web/X tools as the primary external source.
3. Topic->event mapping with strict confidence threshold and audit logs.
4. Stage 1-only event insight output with confidence/evidence.
5. Serve on event page with freshness badge.

This gives user-visible value quickly while staying operationally safe.

## 17) Open Decisions to lock before implementation

1. Locked: launch with `web_search + x_search`.
2. Locked: mapping default is lexical + embedding agreement, with strictly bounded exceptions.
3. Locked: MVP templates are category-specific (`crypto`, `politics`, `sports`), not global.
4. Locked: publish requires `2 independent sources` OR `1 high-trust source + strong internal corroboration` using deterministic definitions in Sections 7.6 and 11.1.
5. Locked: `SynthesisRich` is allowed for ambiguous high-impact candidates, quota-limited.
6. Locked: retrieval modes are explicit (`combined`, `web_only`, `internal_only`) with stricter publish rules as mode degrades.
7. Locked: MVP insight scope is event-level (not user-segmented).
8. Locked: store references/hashes + short-lived raw payload cache (not full long-term raw content).
9. Remaining: whether to keep full event insight history from day 1 or latest-only plus run logs.
10. Remaining: whether market-level signals should be separate table in MVP or nested under event payload.
11. Remaining: exact production budget cap target (daily/weekly) after first shadow-week telemetry.

## 18) Final Recommendation

Adopt a topic-first retrieval architecture on top of your existing embeddings and wallet-intel pipeline: generate canonical topics from markets/events, retrieve broad evidence on a tiered schedule, map evidence to concrete events/markets with strict confidence, then generate insights/signals. This gives better cost scaling than per-market search and remains additive to the current stack.

## 19) Validation Query Kit (prod)

Use this query kit to re-validate assumptions before implementation starts:

1. Table presence + estimated size
- Check the plan's table set exists and estimate footprint from `pg_total_relation_size`.

2. Freshness scan
- For each source table, check `max(ts|bucket|updated_at)` and recent row counts (`1h`, `24h`).

3. Nullability scan
- Measure null rates for `volume_24h`, `liquidity`, `best_bid`, `best_ask`, `tx_hash`.

4. Coverage scan
- Active market/event coverage in `unified_market_trade_24h` and `unified_event_trade_24h`.

5. Wallet-intel coverage
- Distinct wallets in snapshots vs profiles, plus source composition and venue composition.

6. Index sanity
- Confirm hot query indexes on:
  - `unified_book_top (token_id, ts)` + `ts desc`
  - `unified_last_trade (token_id, ts)` + `ts desc`
  - `wallet_activity_events (wallet_id, market_id, occurred_at desc)`
  - `wallet_position_snapshots (wallet_id, venue, market_id, snapshot_at desc)`

7. Timescale policy audit
- Verify refresh intervals, retention windows, and compression windows for CAGGs and raw hypertables.

Starter SQL snippets:

```sql
-- Freshness and short-window activity
select 'unified_book_top' as table_name,
       max(ts) as max_ts,
       count(*) filter (where ts > now() - interval '1 hour') as rows_1h,
       count(*) filter (where ts > now() - interval '24 hours') as rows_24h
from unified_book_top
union all
select 'unified_last_trade',
       max(ts),
       count(*) filter (where ts > now() - interval '1 hour'),
       count(*) filter (where ts > now() - interval '24 hours')
from unified_last_trade;

-- Nullability profile on key features
select venue,
       count(*) as active_markets,
       count(*) filter (where volume_24h is null) as active_null_volume_24h,
       count(*) filter (where best_bid is null and best_ask is null) as active_bbo_both_null
from unified_markets
where status = 'ACTIVE'
group by venue
order by venue;

-- 24h rollup coverage for active markets
select m.venue,
       count(*) as active_markets,
       count(mt.market_id) as active_markets_with_trade24h,
       round(100.0 * count(mt.market_id) / nullif(count(*),0), 2) as coverage_pct
from unified_markets m
left join unified_market_trade_24h mt on mt.market_id = m.id
where m.status = 'ACTIVE'
group by m.venue
order by m.venue;
```

## 20) Gap Review (critical before implementation)

This section captures the remaining execution gaps after contracts were specified.

1. Topic canonicalization implementation is pending.
- Contract is now defined (Section 26), but parser + alias/merge logic still needs implementation and QA.

2. Mapping quality framework implementation is pending.
- Method and thresholds are now defined (Section 25), but labeled dataset + evaluator + CI gate are not yet built.

3. Provider reliability policy is not operationalized.
- Need to wire `ai_domain_policies`, `ai_provider_status`, and automatic degrade-to-internal-only behavior into runtime controls.

4. Scheduling ownership is not fully specified.
- Need one scheduler contract for periodic refresh and one trigger contract for event-driven boosts.
- Need idempotency guarantees per run key.

5. Publish gate thresholds are not calibrated yet.
- `AI_INSIGHTS_MIN_CONFIDENCE` and `AI_INSIGHTS_MIN_LINK_CONFIDENCE` are placeholders.
- Must calibrate on historical data before enabling public signals.

6. Signal taxonomy is defined, but scoring formulas are not finalized.
- Need exact formulas and normalization windows per `move_type`.
- Need venue/category overrides where data sparsity differs.

7. Freshness semantics need implementation validation.
- Freshness contract is defined (Sections 26 and 29), but source-specific threshold checks and UI semantics are not fully wired.

8. Failure handling path is not fully defined.
- Need explicit retry policy, dead-letter queue consumption, and replay tools for failed runs.
- Need operator runbooks for provider incidents and queue saturation.

9. Security/compliance controls for external evidence are missing.
- Need explicit content retention policy for raw external payloads.
- Need PII/sensitive-content guardrails for stored evidence blobs.

10. Cost observability is incomplete.
- Need per-stage and per-tool cost attribution in one dashboard.
- Need automatic hard-stop behavior when budget caps are hit.

## 21) Additional Open Questions (must lock before coding)

1. Should MVP persist full historical versions in `ai_event_insights_history`, or rely on `ai_insight_runs` + latest snapshot only?
2. Should `ai_market_signals` be physically separate in MVP or nested in `ai_event_insights.signals_jsonb`?
3. What exact daily/weekly budget cap should production enforce after first-week spend telemetry?
4. What exact `SynthesisRich` quota should be used for launch (percentage of mapped events and absolute hourly cap)?
5. Should any category start with stricter publish thresholds (for example politics) than global defaults?

## 22) Execution Pseudocode (inputs/outputs and orchestration)

Inputs:

- Market graph snapshot:
  - `unified_events`, `unified_markets`, `unified_market_tokens`
- Internal telemetry:
  - `unified_book_top_1m`, `unified_last_trade_1m`, `unified_market_trade_24h`, `wallet_activity_hourly`
- Existing vectors:
  - `idx:ai:embed:event`, `idx:ai:embed:market`
- Topic state:
  - `ai_topics`, `ai_topic_queries`
- Budget/config state:
  - env limits, provider quotas, cadence config
- Optional external evidence:
  - xAI tool calls (`web_search`, `x_search`)

Outputs:

- `ai_topic_evidence` (normalized + deduped evidence)
- `ai_topic_links` (event/market linkage + confidence)
- `ai_insight_runs` (audit trail)
- `ai_event_insights` and optionally `ai_market_signals` (serving objects)

```pseudo
function schedulerTick(now):
  budgets = loadBudgetState(now)
  if budgets.hardStop:
    return

  topics = selectTopicsForWindow(
    now=now,
    topicTable=ai_topics,
    maxTopicsPerHour=CFG.TOPIC_REFRESH_MAX_PER_HOUR,
    tierCadence=CFG.TIER_CADENCE
  )

  for topic in topics:
    if !acquireRunLock("topic:refresh:" + topic.key + ":" + timeBucketByTier(now, topic.tier)):
      continue

    evidence = loadEvidenceFromCache(topic.key, now)
    if evidence is empty:
      evidence = fetchExternalEvidence(
        topic=topic,
        queries=getTopicQueries(topic.key),
        providerPolicy=CFG.PROVIDER_POLICY,
        perTopicCallLimit=CFG.NEWS_MAX_CALLS_PER_TOPIC_WINDOW,
        budgets=budgets
      )
      evidence = normalizeAndDedupEvidence(evidence)
      persist(ai_topic_evidence, evidence)

    candidates = buildLinkCandidates(
      topic=topic,
      evidence=evidence,
      eventIndex=vectorIndexEvents,
      marketIndex=vectorIndexMarkets
    )

    links = rerankAndClassifyLinks(
      candidates=candidates,
      minLinkConfidence=CFG.MIN_LINK_CONFIDENCE
    )
    persist(ai_topic_links, links)

    groupedEvents = groupLinksByEvent(links)
    topEvents = selectTopEventsByImpact(groupedEvents, maxEvents=CFG.MAX_EVENTS_PER_TOPIC_RUN)
    for eventId in topEvents:
      features = loadInternalEventFeatures(eventId, now)
      # SynthesisLite is always grounded in internal features.
      # External evidence augments, but does not replace, internal data.
      payload = buildSynthesisLiteInput(topic, evidence, links[eventId], features)

      run = startInsightRun(eventId, topic.key, stage="SynthesisLite")
      lite = callSynthesisLiteModel(payload)
      updateInsightRun(run, lite.usage, lite.latency)

      if shouldRunSynthesisRich(lite, features, CFG):
        run2 = startInsightRun(eventId, topic.key, stage="SynthesisRich")
        rich = callSynthesisRichModel(buildSynthesisRichInput(lite, payload))
        updateInsightRun(run2, rich.usage, rich.latency)
        finalInsight = mergeStageOutputs(lite, rich)
      else:
        finalInsight = synthesisLiteToInsight(lite)

      gate = evaluatePublishGate(
        insight=finalInsight,
        minConfidence=CFG.MIN_CONFIDENCE,
        minLinkConfidence=CFG.MIN_LINK_CONFIDENCE,
        freshness=features.freshness,
        evidenceQuality=computeEvidenceQuality(evidence)
      )

      if gate.publish:
        upsert(ai_event_insights, materializeEventInsight(finalInsight, gate))
        maybeUpsertMarketSignals(finalInsight, gate)
      else:
        persistSuppressedInsight(run, gate.reason)

function onMarketTrigger(event):
  topicKeys = findImpactedTopics(event)
  for key in topicKeys:
    promoteTopicToTierA(key, ttl=CFG.BOOST_TTL)
```

## 23) Flow Diagram (logical)

```text
[Market/Event DB + Telemetry + Wallet Intel] ----+
                                                  |
                                                  +--------------------+
                                                  |                    |
                                                  v                    v
                                       [Topic Graph Builder]   [Internal Feature Pack Builder]
                                                  |                    |
                                                  v                    |
                                       [Tiered Topic Scheduler]        |
                                                  |                    |
                                                  v                    |
                                       [External Retrieval]            |
                                                  |                    |
                                                  v                    |
                                [Evidence Normalize + Dedup + Trust Score]
                                                  |
                                                  v
                               [Topic -> Event/Market Mapping + Confidence]
                                                  |
                       +--------------------------+--------------------------+
                       |                                                     |
                       v                                                     v
        [SynthesisLite (Internal Features + Mapped Evidence)]    [Suppressed/Retry]
                       |
                (optional SynthesisRich)
                       |
                       v
   [Publish Gate (confidence + freshness + evidence quality + internal corroboration)]
                       |
          +------------+--------------------+
          |                                 |
          v                                 v
 [ai_event_insights / ai_market_signals]   [Run Logs + Audit + Cost Metrics]
          |
          v
      [API/UI Serving]
```

## 24) External Review Integration (2026-02-09)

External architecture review verdict: `GO-WITH-CONDITIONS`.
This plan adopts that verdict and adds explicit launch gates:

1. Mapping precision gate (hard blocker):
- no broad publish until mapping metrics reach target thresholds.

2. Publish-gate calibration gate (hard blocker):
- confidence must be calibrated against realized outcomes and canary behavior.

3. Provider reliability gate:
- automatic degrade-to-internal-only mode when xAI retrieval health degrades.

4. Budget hard-stop gate:
- spend forecast + shedding must prevent cap breaches.

5. Failure/compliance gate:
- DLQ/replay path and external evidence retention rules must be active before public rollout.

Contract consistency changes integrated from review:

- canonical stage taxonomy (`TopicBuild`, `ExternalRetrieval`, `Mapping`, `SynthesisLite`, `SynthesisRich`, `PublishGate`, `Serve`),
- tier-aware idempotency buckets (A=5m, B=15m, C=60m),
- scheduler state contract (`ai_topic_schedule`) and explicit `run_key`/`stage` in `ai_insight_runs`,
- billable-unit cost language standardized to `server_side_tool_calls`,
- explicit publish-gate definitions for source independence, trust, and internal corroboration,
- completeness-aware multi-venue policy (`unknown` distinct from zero).

## 25) Mapping Quality Contract (launch-critical)

Mapping method for MVP:

1. Candidate generation:
- lexical retrieval over event/market titles + aliases,
- embedding KNN against event/market vectors,
- deterministic constraints: entity, threshold, time-window compatibility.

2. Link scoring:
- weighted deterministic scorer with reasons (`lex`, `embed`, `entity_overlap`, `numeric_match`, `time_alignment`, `category_match`, `venue_compat`).

3. Threshold policy:
- default requires lexical + embedding agreement,
- embedding-only path allowed only under strict hard constraints and higher threshold,
- low-confidence links can exist for debugging but cannot drive high-confidence publish.

MVP acceptance targets (must pass before broad publish):

- `precision@1 >= 0.92`
- `false_link_rate <= 0.5%` among links above publish threshold
- `ECE <= 0.07` (confidence calibration)
- Tier A mapping coverage `>= 25%` with abstain behavior enabled

GA targets:

- `precision@1 >= 0.95`
- `false_link_rate <= 0.2%`
- `ECE <= 0.05`
- Tier A mapping coverage `>= 40%`

## 26) Deterministic Contracts (v1)

### 26.1 Topic key

Use versioned canonical topic keys:

- `topic_key = "v1:" + category + ":" + entity_type + ":" + entity_norm + ":" + constraint_hash + ":" + time_bucket`
- include merge/alias table for near-equivalent topics:
  - `ai_topic_aliases(topic_key_alias, topic_key_canonical)`

### 26.2 Internal feature pack (required for `SynthesisLite`)

`SynthesisLite` input must always include:

- event identity + status metadata,
- freshness bundle (`book_top_max_ts`, `last_trade_max_ts`, `wallet_max_ts`, freshness booleans),
- market aggregate metrics (trade24h, liquidity estimate, venue mix),
- microstructure stats (spread, mid changes, dispersion, stale/thin flags),
- wallet flow summaries.

### 26.3 Publish gate I/O

Publish gate input includes:

- feature pack,
- mapped evidence bundle with trust/recency/source count,
- link confidence + reasons,
- stage output payload.

Publish gate output includes:

- `publish` boolean,
- `confidence`,
- `quality_score`,
- `stale_at`,
- `reason_codes`,
- `risk_flags`.

Additional deterministic gate requirements:

- `independent_sources_count` must pass policy definition (Section 7.6, Section 11.1).
- `high_trust_source` and `strong_internal_corroboration` are explicit booleans in gate input.
- if required gate primitives are missing (`unknown`), fail closed (`publish=false`).

### 26.4 Idempotency keys

Run keys:

- `topic_refresh_key = topic_refresh:v1:<topic_key>:<bucket_by_tier>`
- `event_insight_key = event_insight:v1:<event_id>:<bucket_by_tier>:<prompt_version>:<stage>`

Launch bucket guidance:

- Tier A: 5m bucket
- Tier B: 15m bucket
- Tier C: 60m bucket

Enforce via Redis lock + unique DB constraint on `ai_insight_runs(run_key)`.

## 27) Cost Model and Shedding Policy

Cost model (per day):

- `DailyCost = topic_retrieval_cost + embedding_cost + synthesis_lite_cost + synthesis_rich_cost`
- retrieval term is driven by:
  - topics processed,
  - `server_side_tool_calls` (billable),
- cache hit rate.

Observed launch baseline from live smoke tests (xAI tools, strict no-fallback):

- per topic run (`1 combined` request with `tools=[web_search,x_search]`):
  - observed server-side tool calls: ~`10 web + 9 x` (can vary by topic/prompt),
  - estimated cost per topic: `~$0.1087` (tool + token),
  - tool cost dominates token cost.
- with `$10/day` cap and this baseline:
  - effective capacity is about `~92 topics/day` before safety margin.
- implication:
  - scheduler/topic cadence must be set by observed `num_server_side_tools_used` and `server_side_tool_usage_details`, not by request count alone.

Operational rule:

- budget is forecast-driven first, topic-count second.
- keep an operational hard ceiling (for example `200`) as emergency cap; launch default is lower (`30`) and should be tuned from spend telemetry.

Scenario planning (required in ops dashboard):

1. Conservative:
- shadow/canary mode, low `SynthesisRich` fraction, strict topic caps.

2. Base:
- target steady-state production mode aligned to daily budget cap.

3. Aggressive:
- high topic volume and higher `SynthesisRich` ratio; used for stress tests only.

Each scenario must include:

- expected topics/hour,
- expected `server_side_tool_calls/topic` (p50/p95),
- expected mapped events/topic,
- `SynthesisRich` promotion rate,
- projected daily/monthly spend,
- shedding trigger point.

Hard fanout controls (required):

- `MAX_EVENTS_PER_TOPIC_RUN`
- `MAX_SYNTHESIS_LITE_RUNS_PER_HOUR`
- `MAX_SYNTHESIS_RICH_RUNS_PER_HOUR`

Shedding ladder:

1. At `>= 80%` budget or aggressive next-hour forecast:
- mode: `combined -> web_only`.

2. At `>= 85%` budget:
- disable `SynthesisRich`, raise link threshold.

3. At high queue lag (for example `> 5m` sustained):
- drop Tier C, widen Tier B interval, keep Tier A only.

4. At `>= 98%` budget:
- mode: `web_only -> internal_only`; hard-stop new external/model runs and serve stale/latest only.

All shedding/hard-stop actions must be logged with reason + config snapshot.

## 28) 30/60/90 Readiness Gates

### Day 0-30: Shadow mode

- publish off, run full pipeline with audit logs only.
- complete labeled mapping dataset + offline eval.
- validate DB/load/cost behavior.

DoD:

- mapping metrics hit MVP targets,
- no measurable regression on core feed/event API latency,
- forecast error bounded (for example within +/-20%).

### Day 31-60: Canary publish

- publish to limited audience,
- enable reason codes and freshness surfacing,
- validate kill switches and replay tooling.

DoD:

- low false-link incident rate in canary,
- budget caps never exceeded,
- no freshness label violations.

### Day 61-90: Scaled rollout

- enable insights feed ranking + selective `SynthesisRich` for high-impact ambiguity.
- tune thresholds by venue/category.

DoD:

- stable SLOs,
- calibration trend improving,
- canary-to-broad ramp approved by quality and cost gates.

## 29) Baseline SLO/SLI Targets

Serving:

- `/events/:eventId/insight` read latency p95 `< 50ms` (data already materialized)
- insight endpoint availability `>= 99.9%`

Pipeline:

- Tier A trigger->publish latency p95 `< 5 min`
- queue lag p95 `< 3 min` steady state
- DLQ rate `< 1%` steady state
- budget cap breach days `= 0`

## 30) Extractor Improvement Plan (implemented + next)

Goal: keep topic/query generation deterministic and high-precision before wiring live retrieval execution.

### 30.1 What is now implemented in `ai-topics-dry-run.ts`

Implemented deterministic hardening (P0 + P1):

- resolver archetypes: `generic`, `head_to_head`, `candidate_list`, `competition_winner`
- source-aware entity extraction (`event` vs `market` vs `derived`) with provenance fields
- politics candidate/cohort extraction from market outcomes (coalitions and person names)
- sports head-to-head parsing expansion and winner/candidate handling
- stricter unknown handling (`includeUnknownFallback`, `unknownMinMarketCount`)
- low-signal outcome label guard for unknown topics (`A/B`, `Player X`, `Team N`, `Yes/No`), using event-only subject when needed
- random sampling mode (`--order-by random`) for stress testing
- improved crypto symbol resolver (`MegaETH`-style detection) without generic token bleed
- open-now gating is now enforced as a hard invariant in extraction (no opt-out for live planning)
- freshness gating is now defaulted in extraction (`maxMarketAgeHours=24`) and propagated into modeled query metadata (`sampleMarketUpdatedAt`)

### 30.2 Before/after quality on the same benchmark slice

Benchmark command family:

- `limit=100`
- `sampling=per-venue`
- `order-by=trending`
- `show-top=500`

| Metric | Before hardening | After hardening |
|---|---:|---:|
| `rowsUsed` | `100` | `100` |
| `uniqueTopics` | `67` | `86` |
| `unknownTopics` | `17` (`25.37%`) | `0` (`0%`) |
| `unknownMarketCoverage` | `29/100` (`29%`) | `0/100` (`0%`) |
| `uniqueSearchTopics` | `26` | `62` |
| `server-side tool calls/day after cache (est)` | `113.1` | `253.5` |
| `tool cost/day` (`$0.005/call`) | `$0.57` | `$1.27` |

Interpretation:

- quality improved materially (unknown coverage eliminated on the benchmark slice),
- cost increased because more markets now resolve into executable topics,
- still far below the `$10/day` launch ceiling.

### 30.3 Launch profile matrix (2026-02-10, deterministic trending runs)

Command used:

- `hunch-monorepo/scripts/ai-topics-matrix.sh --mode wide --wide-limits "50 100 200"`
- output dir example: `/tmp/ai-topics-matrix-20260210201446`

All profiles below:

- `search-categories=crypto,politics,sports`
- default tiers (`A>=20`, `B>=5`)
- default cadences (`A=10m`, `B=120m`, `C=240m`)
- tool price model only: `$0.005/call`

| Profile | rows | uniqueSearchTopics | unknownMarketCoverage | server-side tool calls/day after cache (est) | tool $/day | tier A/B/C |
|---|---:|---:|---:|---:|---:|---|
| `wide_global_50` | 50 | 25 | `0/50` (`0%`) | 241.8 | 1.209 | `1/2/8` |
| `wide_global_100` | 100 | 54 | `0/100` (`0%`) | 265.2 | 1.326 | `2/4/12` |
| `wide_global_200` | 200 | 111 | `0/200` (`0%`) | 444.6 | 2.223 | `3/8/26` |
| `wide_pervenue_50` | 50 | 15 | `1/50` (`2%`) | 117.0 | 0.585 | `1/2/2` |
| `wide_pervenue_100` | 100 | 39 | `2/100` (`2%`) | 245.7 | 1.229 | `2/3/9` |
| `wide_pervenue_200` | 200 | 93 | `8/200` (`4%`) | 257.4 | 1.287 | `2/4/10` |

Conclusion:

- `per-venue limit=50` is the best low-cost deterministic launch slice.
- `global` runs create many more search topics at small limits and consume budget much faster.
- tier auto-promotion is active and keeps A/B non-zero (`1/2/2` on top50 per-venue).

### 30.4 Random-stress validation (2026-02-10 matrix, hardened resolver)

Command used:

- `hunch-monorepo/scripts/ai-topics-matrix.sh --mode random --random-limit 200 --random-runs 3`

Matrix: 6 runs (`limit=200`, `order-by=random`):

- 3x `sampling=global`
- 3x `sampling=per-venue`

Average results:

| Group | avg unknown topic % | avg unknown market % | avg uniqueSearchTopics | avg server-side tool calls/day after cache (est) | tool $/day |
|---|---:|---:|---:|---:|---:|
| `global` | `24.76%` (`25.67/103.67`) | `18.50%` (`37.0/200`) | `103.67` | `141.7` | `0.709` |
| `per-venue` | `21.28%` (`21.0/98.67`) | `14.17%` (`28.33/200`) | `98.67` | `130.0` | `0.650` |

Residual unknowns are concentrated in low-information placeholders:

- election outcomes represented as `A/B/C/D` or generic `Party X`,
- sports awards/rosters with anonymized `Player X`, `Team N`,
- qualifier/group markets where entity is not explicit in title/outcome.

Important hardening outcome:

- placeholder topics are now effectively suppressed (`placeholderTopics=0` across matrix outputs),
- unresolved topics remain as `unknown` with explicit `unknownReason` so they can be handled by a separate bounded unknown-resolution lane.

### 30.5 Recommended cost-first launch configuration

Recommended initial execution mode:

- `sampling=per-venue`
- `limit=50` (top per-venue trending slice)
- `search-categories=crypto,politics,sports`
- keep unknown suppression enabled for live deterministic execution

Cadence/options:

- query packs assume one combined query per topic run with both tools enabled (`web + x` in one request).
- balancing promotion (current default):
  - `tier-auto-promote-a=true`, `tier-auto-promote-a-min-market-count=2`
  - `tier-auto-promote-b=true`, `tier-auto-promote-b-min-topics=2`, `tier-auto-promote-b-min-market-count=2`
  - effect: if static thresholds produce only C, we promote to maintain non-zero A/B.

Measured top50 result with balancing enabled:

- baseline (`A=10m`, `B=120m`, `C=240m`): `tier A/B/C = 1/2/2`, `server-side tool calls/day after cache (est) = 117.0`, tool cost/day `~$0.585`
- tuned target for ~100/day: `A=12m`, `B=120m`, `C=240m`:
  - `tier A/B/C = 1/2/2`
  - `server-side tool calls/day after cache (est) = 101.4`
  - tool cost/day `~$0.507`

Both are below `$10/day` for tool invocations only; token/model budget remains separately capped via hard budget + shedding.

### 30.6 Next high-impact improvements

1. Placeholder-aware routing (non-LLM)
   - detect `A/B/C`, `Player X`, `Team N` outcomes,
   - anchor entity to event-level object (district/tournament) instead of forcing person/team extraction.

2. District and tournament canonicalizers (non-LLM)
   - parse `CA-38`, `VA-02`, etc. into canonical district entities,
   - add sports event-family resolver for qualifiers and award ladders.

3. Search-intent execution caps
   - add per-event and per-category caps in executor (not extractor),
   - prevent one taxonomy from consuming full budget during spikes.

4. Unknown resolver lane (strictly bounded, no fallback retrieval)
   - only for unresolved, high-impact topics (`marketCount>=3` or promoted tier),
   - deterministic parser first; optional LLM extraction only with strict schema and hard daily cap,
   - does not trigger extra external retrieval calls by itself.

5. Prompt quality lint
   - normalize synonyms and aliases,
   - enforce no duplicated terms and no prediction-market-domain leakage.

### 30.6.1 P0 execution plan (strict no-fallback retrieval path)

This locks the five launch-critical gaps requested for the first production pass.

1. Provenance gate (required)
   - Rule: mark external evidence valid only when tool provenance is present and parseable (`citations` and/or `server_side_tool_usage` with provider metadata).
   - Implementation: add `provenanceOk` and `provenanceReason` fields to normalized evidence rows and block publish when false.
   - Acceptance: zero published insights with missing provenance metadata.

2. Crypto entity hardening (required)
   - Rule: accept `ticker:*` only from allowlist/symbol map; otherwise downgrade to `keyword:*` or reject topic at extraction time.
   - Implementation: enforce in topic resolver before query generation; emit `unknownReason=unmapped_ticker` when rejected.
   - Acceptance: no generated `ticker:*` topics outside allowlist; unknown rate tracked separately.

3. Sports keyword pruning (required)
   - Rule: keep `match:*` as preferred path; for free-form `keyword:*` sports topics require stronger eligibility (`marketCount` + score threshold).
   - Implementation: add minimum thresholds for sports keyword topics and demote low-confidence keyword-only topics to non-executable.
   - Acceptance: sports unknown/noise topics drop while coverage of actionable match topics remains stable.

4. Threshold-aware support checks (required)
   - Rule: for numeric markets (`>=`, `<=`, "above", "below"), evidence can set `supports_topic=true` only when numeric + temporal constraints are satisfied.
   - Implementation: add deterministic comparator parser and time-window check in evidence evaluation.
   - Acceptance: `supports_topic=true` rows for threshold topics always include parsed numeric/time match metadata.

5. Budget safety (required)
   - Rule: keep launch mode under `$10/day` tool-call budget before token costs.
   - Implementation: cap to top per-venue slice, keep one web + one x query per topic run, enforce per-tier cadence caps and hard-stop shedding.
   - Acceptance: projected tool-call cost remains under budget on weekly matrix runs.

### 30.7 Mapping-readiness hooks

Keep extractor output mapping-friendly:

- preserve entity provenance (`entitySource`, `unknownReason`, `archetype`),
- keep deterministic constraints/time buckets in each topic,
- allow canary gating by provenance class (e.g., `static` only).

### 30.8 Reporting cadence

Run weekly replay matrix (`top50/top100/top200` + random stress):

- use `hunch-monorepo/scripts/ai-topics-matrix.sh --mode both --wide-limits "50 100 200" --random-limit 200 --random-runs 5`

- unknown topic ratio,
- unknown market coverage,
- venue/category share,
- calls/day and cost/day,
- false-entity QA examples.

### 30.9 Real retrieval smoke test (xAI tools)

Use this before wiring scheduler/worker execution:

1. Generate topic/query plan JSON from current local DB:

- `pnpm -C hunch-monorepo -F api run ai:topics:dry-run -- --limit 50 --sampling per-venue --show-top 200 --show-queries 30 --json --out /tmp/ai-topics-smoke.json`

2. Execute live xAI tool calls for top tiers:

- `XAI_API_KEY=... pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file /tmp/ai-topics-smoke.json --tiers A,B --max-topics 8 --mode combined --out /tmp/ai-search-smoke.json --verbose`

3. Optional dry-run to inspect payload shape only:

- `pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file /tmp/ai-topics-smoke.json --tiers A,B --max-topics 4 --mode combined --dry-run`

Notes:

- `ai:search:smoke` sends one tool-enabled request per topic using `tools=[web_search, x_search]` with system-level JSON enforcement.
- It records HTTP status, latency, citations count, server-side tool usage, provenance pass/fail, and cost estimates.

### 30.10 Focused QA on real retrieval (selected topics 4, 8, 1)

Run setup:

- source plan: `/tmp/ai-topics-picked-4-8-1.json`
- smoke output: `/tmp/ai-search-smoke-picked-4-8-1.json`
- olympics web retry output: `/tmp/ai-search-smoke-olympics-web-retry.json`
- calls: strict combined retrieval (`web_search + x_search` in one request), `maxTopics=3`, no fallback lane

Observed outcomes:

| Topic | Combined result | Expected Stage-3/4 action |
|---|---|---|
| `keyword:busan-mayoral-election` | `NO_EVIDENCE (0/2)` | suppress topic (no mapping, no publish) |
| `keyword:prime-minister-israel-election` | support threshold met (`OK/PARTIAL`) | proceed to mapping for Israel PM event/candidate markets |
| `keyword:olympics` | transient provider errors still possible; bounded retry required | proceed only when support threshold passes |

Interpretation:

- evidence gating behaves correctly: no-evidence topics are suppressed instead of forcing low-quality insights
- mixed-source topics pass only when support threshold is met
- provider-transient failures must be handled by bounded retry policy in scheduler/worker layer

### 30.11 Next implementation steps (immediate)

1. Add provenance gate in worker execution path (`citations` and `server_side_tool_usage` required before publish eligibility).
2. Add bounded retry + idempotency for external calls (`max_retries=1`, jittered backoff, no fan-out amplification).
3. Wire strict threshold-aware support checks for numeric markets before `supports_topic=true`.
4. Run weekly `top50 per-venue` replay matrix and track suppression/pass ratios by category/tier.
5. Start mapping-stage canary using only topics that pass combined support + provenance thresholds.

### 30.12 Cost baseline and retrieval-mode decision (updated)

Current baseline (from live smoke instrumentation):

- combined mode (`tools=[web_search,x_search]`) is now the smoke-path default.
- observed combined sample:
  - successful server-side tool calls can still fan out (example run: `14` successful calls),
  - estimated cost for that sample: `~$0.07824`,
  - provenance gate passed via citations + tool usage.

Cost-first baseline for launch remains:

- target budget cap: `$10/day` total retrieval budget (tool + token),
- conservative practical capacity: `~92 topics/day` (from earlier measured split baseline),
- current deterministic launch target (`per-venue limit=50`, `A=12m`) projects `~101.4 server-side tool calls/day after cache (est)` before model-token adjustments.

Next validation required:

1. run matched replay (`N >= 30` topics) on combined mode only,
2. capture `cost/topic` p50/p95, tool-call distribution, provenance pass rate, latency p95,
3. set hard scheduler caps from p95 costs (not mean-only).

### 30.13 Post-hardening topic quality audit (2026-02-11)

Audit run:

- command profile: `limit=500`, `sampling=per-venue`, `order-by=trending`, `maxMarketAgeHours=24`
- artifact: `/tmp/ai_topics_audit.json`

Observed extractor output:

- `rows=500`, `used=500`
- `uniqueTopics=412`
- `uniqueSearchTopics=176`
- executable modeled topics (`searchPlan.queryExamples`): `34`
- tier mix in modeled topics: `A=3`, `B=7`, `C=24`
- category mix in modeled topics: `crypto=3`, `politics=10`, `sports=21`
- venue mix in modeled topics: `kalshi=24`, `polymarket=8`, `limitless=2`
- modeled `marketCount` distribution:
  - `min=2`, `p50=2`, `p90=18`, `max=23`, `avg=5.74`
- freshness on modeled topics (from `sampleMarketUpdatedAt`):
  - `count=34`, `missing=0`
  - `max age ~22.52h`
  - `p90 age ~22.02h`
  - `>24h = 0`
  - `>12h = 10`

Cost model for this audit shape (not launch-capped):

- estimated calls/day raw: `660`
- estimated server-side tool calls/day after cache (est): `429`
- per-tier raw calls/day: `A=432`, `B=84`, `C=144`

Interpretation:

- freshness/open-now hardening is working for modeled topics (`0` modeled topics older than 24h).
- unknown topics are no longer promoted into modeled query execution.
- modeled set is still skewed toward sports+Kalshi long tail in C-tier.
- this 500-row stress profile is useful for quality diagnostics but exceeds cost-first launch envelope unless topic caps are enforced.

### 30.14 Immediate tuning actions from this audit

1. Keep launch scheduler on capped modeled set (`~top50 per-venue`) and do not schedule all modeled topics from stress profiles.
2. Rebalance modeled-topic selection with venue/category quotas (reduce sports/Kalshi C-tail dominance).
3. Raise C-tier eligibility (`marketCount >= 3`) unless topic score is above an explicit override threshold.
4. Tighten A/B freshness windows (for example, A<=12h) while keeping C<=24h.
5. Continue weekly matrix + random audits with the same metric pack and add drift alerts for:
   - category share,
   - venue share,
   - p90 sample age,
   - estimated server-side tool calls/day after cache (est).

### 30.15 Low-yield demotion rule (runtime scheduler, not smoke scripts)

Purpose:
- reduce wasted calls on topics that repeatedly return `NO_EVIDENCE`,
- keep A-tier fresh for high-yield topics under strict budget.

Scope:
- this belongs to production scheduling/state (`ai_topic_schedule` + run history),
- smoke scripts should only simulate and report expected demotions/promotions.

State fields to track per topic:
- `consecutive_no_evidence`
- `rolling_runs_7d`
- `rolling_hits_7d` (`parsed.status=OK` and `evidence_count >= min_evidence`)
- `last_hit_at`
- `cooldown_until`
- `current_tier` (`A|B|C`)
- `pinned` (never auto-demote)

Demotion policy (initial deterministic contract):
- `A -> B` when `consecutive_no_evidence >= 3` OR `rolling_hits_7d / rolling_runs_7d < 0.20` (min 6 runs)
- `B -> C` when `consecutive_no_evidence >= 5` OR `rolling_hits_7d / rolling_runs_7d < 0.15` (min 10 runs)
- `C -> paused` when `consecutive_no_evidence >= 8` (pause for 7 days, then re-probe once)

Promotion policy:
- `C -> B` when last 5 runs have `>=2` hits and at least one trusted source hit
- `B -> A` when last 5 runs have `>=3` hits and p95 cost/topic stays within budget envelope

Safety guards:
- never demote pinned/high-priority compliance topics,
- max one tier change per topic per 24h,
- max global demotions per hour to avoid oscillation during provider incidents.

Acceptance criteria:
- reduce `NO_EVIDENCE` call share by at least 30% week-over-week on the same launch profile,
- keep A-tier hit rate above 60%,
- maintain budget cap with no hard-stop days.

### 30.16 Script behavior improvement plan (`ai-topics-dry-run`, `ai-search-smoke`, `ai-synthesis-smoke`)

Goal:
- make scripts reliable QA/calibration tools for runtime policy, not one-off probes.

1) Cross-script contract alignment
- define shared output contract version (e.g., `qa_contract_v1`) with stable key names:
  - run metadata, topic id/tier, freshness, parsed status, evidence counts, cost, gate decision
- add strict schema checks between script stages; fail fast on contract drift.

2) `ai-topics-dry-run` upgrades
- add `--launch-profile` presets (`top50_per_venue`, `top100_per_venue`, `stress500_global`)
- add optional `--emit-demotion-preview` to estimate which topics would demote under 30.15 rules
- add explicit modeled-topic quality summary:
  - per-tier hit priors, category/venue share, p50/p90 `marketCount`, age distribution
- keep unknown/unresolved topics visible in diagnostics, excluded from modeled execution by default.

3) `ai-search-smoke` upgrades
- classify outcomes explicitly:
  - `OK`, `NO_EVIDENCE`, `PROVIDER_LIMIT`, `PROVIDER_ERROR`, `TIMEOUT`, `SCHEMA_INVALID`
- separate topic-quality misses from provider failures in summary tables
- keep strict provenance gate and include exact reason counters
- add deterministic sampling seed for repeatable matrix comparisons
- export full raw response option (`--save-raw`) for forensic QA.

4) `ai-synthesis-smoke` upgrades
- enforce user-facing language lint in QA mode:
  - reject internal jargon/fallback-source wording in `summary_short/summary_long`
- require claim-to-evidence linkage (`signals[].evidence_refs` non-empty for non-`none` signals)
- standardize gate output summary:
  - `publish_context_only`, `skip_external_publish`, `skip_stale`, `skip_low_confidence`
- add freshness decision trace block to simplify stale-case debugging.

5) New combined harness (`ai-e2e-smoke`)
- orchestrate topics -> search -> synthesis in one run id
- produce one consolidated JSON + markdown report
- include:
  - cost envelope, hit-rate, stale-rate, gate distribution, top failures, recommended config deltas.

Execution order:
1. contract alignment,
2. search/synthesis error taxonomy and gate summaries,
3. demotion-preview outputs,
4. combined harness.
