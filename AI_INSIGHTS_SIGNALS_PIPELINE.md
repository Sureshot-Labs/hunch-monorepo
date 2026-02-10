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
  - launch prompt set (`prompt_web_news`, `prompt_x_signal`) with strict no-fallback execution
  - legacy `prompt_web_driver` remains code-path-compatible but is intentionally disabled in launch profile
  - xAI tool payload shape with:
    - `web_search.filters.excluded_domains`
    - `x_search.from_date`
    - `x_search.to_date`
    - `x_search.excluded_x_handles`
- search-intent dedupe is active before cost estimation:
  - dedupe key: `category|entity_type|entity`
  - original topic granularity retained for internal diagnostics.

Validation snapshot (same quality gates, global sampling, trending order):

- top-50 markets:
  - `uniqueSearchTopics=39`
  - `dailyAfterCacheCalls=152.1`
- top-100 markets:
  - `uniqueSearchTopics=75`
  - `dailyAfterCacheCalls=304.2`
- top-200 markets:
  - `uniqueSearchTopics=144`
  - `dailyAfterCacheCalls=585.0`
- top-50 markets (per-venue sampling):
  - `uniqueSearchTopics=29`
  - `dailyAfterCacheCalls=113.1`

Cost implication from tool invocations only (`$5 / 1000` calls, token costs excluded):

- top-50 global: about `$0.76/day`
- top-100 global: about `$1.52/day`
- top-200 global: about `$2.93/day`
- top-50 per-venue: about `$0.57/day`

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

- Tier A topics: every 10-15 minutes.
- Tier B topics: every 60 minutes.
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

- `topic:refresh:<topicKey>:<bucket>`
- `insight:recalc:<eventId>:<bucket>`

and cooldown windows to prevent retrigger storms.

### 6.4 Backpressure behavior

When queue pressure rises:

- drop Tier C runs first,
- widen Tier B interval,
- keep Tier A topic refresh and only recompute linked high-impact events.

### 6.5 Scheduler/Queue execution model (recommended)

Use a split model:

- Postgres scheduler state as source of truth:
  - stores topic cadence and due-time state (`next_run_at`, `tier`, `priority`, `enabled`),
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

### 7.1 Four-stage analysis flow

Stage 0: Topic graph build (deterministic + optional LLM expansion)

- output: ranked topic queue with cadence and constraints.

Stage 1: Topic retrieval (external + internal evidence)

- pull broad evidence for each topic (news/web/X if enabled),
- normalize + dedup + trust score.

Stage 2: Topic-to-market/event mapping

- run candidate + rerank flow,
- emit high-confidence links with reasons.

Stage 3: Insight/signal synthesis (conditional)

- stage 3a cheap structured pass (`gpt-5-nano` class) for all linked events,
- stage 3a input must include internal market/event/wallet feature pack (required) plus mapped external evidence (optional),
- stage 3b richer synthesis (`gpt-5.2` class) only for high-impact/high-uncertainty items.

This preserves quality while keeping cost bounded.

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

1. `prompt_web_news`
- intent: current facts and key drivers relevant to entity + constraint.

2. `prompt_x_signal`
- intent: real-time social signal and source-linked claims.

Launch rule:

- strict two-call pattern per executable topic run: exactly `1 web_news + 1 x_signal`
- no fallback prompt family and no extra driver call during launch

Tool policy attached to each pack:

- `web_search.filters.excluded_domains`: prediction-market/self domains configured centrally.
- `x_search.from_date/to_date`: tier-based lookback windows.
- `x_search.excluded_x_handles`: optional market-platform handles (configurable).

Search dedupe rule (required before scheduling):

- Build a search-intent key `category|entity_type|entity` and collapse duplicate market topics across time buckets/constraints for external retrieval planning.
- Keep original topic granularity for internal scoring, but execute external retrieval once per search-intent key per cadence window.

Minimum pack by tier (launch default):

- Tier A: `1 web + 1 x`
- Tier B: `1 web + 1 x`
- Tier C: `1 web + 1 x` (or disabled by scheduler)

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

### 7.7 Determinism and reproducibility

Persist for each run:

- prompt version,
- model id,
- tool outputs snapshot hashes,
- timing,
- token usage,
- final structured signal + narrative.

Without this, production debugging will be painful.

## 8) Proposed Storage Additions

Add additive tables (no breaking schema changes):

1. `ai_topics`
- `topic_key` PK, `category`, `entity`, `constraint_jsonb`, `time_bucket`
- `tier`, `score`, `active_links_count`, `last_refreshed_at`, `updated_at`

2. `ai_topic_queries`
- `id`, `topic_key`, `query_text`, `query_kind`, `version`, `enabled`
- keeps deterministic + LLM-expanded query variants auditable.

3. `ai_topic_evidence`
- `id`, `topic_key`, `provider`, `source_domain`, `headline`, `published_at`, `url`
- `summary`, `trust_weight`, `recency_weight`, `dedup_hash`, `raw_jsonb`
- unique index on `dedup_hash` to prevent repeats.

4. `ai_topic_links`
- `id`, `topic_key`, `event_id` nullable, `market_id` nullable
- `link_type`, `link_confidence`, `reasons_jsonb`, `created_at`

5. `ai_insight_runs`
- `id`, `topic_key` nullable, `event_id` nullable, `market_id` nullable, `trigger_type`, `tier`, `status`
- `stage1_model`, `stage2_model`, `prompt_version`
- `started_at`, `finished_at`, `latency_ms`
- `input_hash`, `tool_snapshot_jsonb`
- `token_in`, `token_out`, `cost_usd_est`, `error` nullable

6. `ai_event_insights`
- `event_id` PK
- `insight_version`, `signal_version`
- `summary_short`, `summary_long`
- `signals_jsonb`, `confidence`, `quality_score`
- `evidence_jsonb` (internal + external with provenance)
- `stale_at`, `updated_at`

7. `ai_market_signals` (optional split)
- keyed by `(market_id, signal_type)`
- structured payload + confidence + freshness

8. `ai_domain_policies`
- `source_domain` PK, `allowed`, `trust_weight`, `notes`, `updated_at`
- provider/domain trust and allow/deny enforcement.

9. `ai_provider_status`
- `provider` PK, `enabled`, `last_ok_at`, `last_error_at`, `error_rate_5m`, `p95_latency_ms_5m`, `updated_at`
- circuit-breaker and health tracking for xAI tools.

10. `ai_insight_dlq`
- failed run payload metadata for replay operations (`run_key`, `stage`, `payload_hash`, `error`, `created_at`).

Indexes:

- `ai_topics(tier, score desc)`
- `ai_topic_evidence(topic_key, published_at desc)`
- `ai_topic_links(event_id, link_confidence desc)`
- `ai_topic_links(market_id, link_confidence desc)`
- `ai_event_insights(updated_at desc)`
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
- Per-run max tokens stage1/stage2
- Hard cap on external tool calls per run (e.g. max 3)
- Hard cap on topic refreshes per cycle (e.g. max 200 topics/hour)
- External news call cap per topic window (e.g. max 1-2 pulls per 10-15m bucket)
- Provider-level quotas (web vs X vs premium API)

### 10.2 Priority shedding

When budget/queue pressure rises:

- keep Tier A,
- reduce Tier B frequency,
- disable Stage 2 for low-impact items,
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

Do not publish insight if:

- confidence below threshold,
- contradictory evidence unresolved,
- missing minimum evidence count,
- stale market data beyond threshold,
- link confidence below mapping threshold for event/market attachment.

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
- Enable Stage 2 synthesis only for high-impact candidates.
- Add UI affordances for confidence and freshness.

Phase 4: external source expansion + optimization

- Optimize xAI tool usage and quotas, then optionally add direct premium feed overlays if needed.
- Auto-tune thresholds by observed precision/latency/cost.
- Add venue/category-specific tuning profiles.

## 13) SQL/Performance Guidance (important)

- Reuse existing rollups (`unified_*_1m`, `*_1h`, `*_trade_24h`) for candidate scoring.
- Treat base-table `volume_24h` and `liquidity` as nullable; always `coalesce(...)` with explicit fallback.
- Expect sparse membership in `unified_market_trade_24h` / `unified_event_trade_24h`; left join and default missing rows to zero.
- Use `unified_book_top` / `unified_book_top_1m` for BBO-derived features across venues (do not assume `unified_markets.best_bid/best_ask` is populated).
- Avoid running heavy raw hypertable scans inside AI worker.
- Use batched event IDs in queries (`unnest($1::text[])`) and order-preserving joins.
- Add bounded windows for wallet-intel joins.
- Gate profile-conditioned prompt branches by profile existence (`wallet_profiles`) and use deterministic fallback otherwise.
- Keep AI writes isolated from hot feed query paths.

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
- `AI_INSIGHTS_DAILY_BUDGET_USD=25`
- `AI_INSIGHTS_TOPIC_REFRESH_MAX_PER_HOUR=200`
- `AI_INSIGHTS_TOPIC_EXPANSION_MAX=8`
- `AI_INSIGHTS_TIER_A_REFRESH_MIN=10`
- `AI_INSIGHTS_TIER_B_REFRESH_MIN=120`
- `AI_INSIGHTS_MIN_CONFIDENCE=0.62`
- `AI_INSIGHTS_MIN_LINK_CONFIDENCE=0.70`
- `AI_INSIGHTS_MAX_EXTERNAL_CALLS=3`
- `AI_INSIGHTS_NEWS_PROVIDER=xai_tools`
- `AI_INSIGHTS_XAI_TOOLS=web_search,x_search`
- `XAI_API_KEY=<secret>`
- `AI_INSIGHTS_NEWS_CACHE_TTL_SEC=900`
- `AI_INSIGHTS_NEWS_MAX_CALLS_PER_TOPIC_WINDOW=2`
- `AI_INSIGHTS_WEB_EXCLUDED_DOMAINS=polymarket.com,kalshi.com,limitless.exchange,hunch.trade`
- `AI_INSIGHTS_X_EXCLUDED_HANDLES=polymarket,kalshi`
- `AI_INSIGHTS_TIER_A_LOOKBACK_HOURS=24`
- `AI_INSIGHTS_TIER_B_LOOKBACK_HOURS=72`
- `AI_INSIGHTS_TIER_C_LOOKBACK_HOURS=168`

These are safe launch defaults, not final tuning.

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
4. Locked: publish requires `2 independent sources` OR `1 high-trust source + strong internal corroboration`.
5. Locked: Stage2 is allowed for ambiguous high-impact candidates, quota-limited.
6. Locked: MVP insight scope is event-level (not user-segmented).
7. Locked: store references/hashes + short-lived raw payload cache (not full long-term raw content).
8. Remaining: whether to keep full event insight history from day 1 or latest-only plus run logs.
9. Remaining: whether market-level signals should be separate table in MVP or nested under event payload.
10. Remaining: exact production budget cap target (daily/weekly) after first shadow-week telemetry.

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
4. What exact Stage2 quota should be used for launch (percentage of mapped events and absolute hourly cap)?
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
    if !acquireRunLock("topic:refresh:" + topic.key + ":" + timeBucket(now)):
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
    for eventId in groupedEvents:
      features = loadInternalEventFeatures(eventId, now)
      # Stage 1 synthesis is always grounded in internal features.
      # External evidence augments, but does not replace, internal data.
      payload = buildStage1Input(topic, evidence, links[eventId], features)

      run = startInsightRun(eventId, topic.key, stage="stage1")
      stage1 = callStage1Model(payload)
      updateInsightRun(run, stage1.usage, stage1.latency)

      if shouldRunStage2(stage1, features, CFG):
        run2 = startInsightRun(eventId, topic.key, stage="stage2")
        stage2 = callStage2Model(buildStage2Input(stage1, payload))
        updateInsightRun(run2, stage2.usage, stage2.latency)
        finalInsight = mergeStageOutputs(stage1, stage2)
      else:
        finalInsight = stage1ToInsight(stage1)

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
        [Stage1 Synthesis (Internal Features + Mapped Evidence)]    [Suppressed/Retry]
                       |
                (optional Stage2)
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

### 26.2 Internal feature pack (required for Stage1)

Stage1 input must always include:

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

### 26.4 Idempotency keys

Run keys:

- `topic_refresh_key = topic_refresh:v1:<topic_key>:<15m_bucket>`
- `event_insight_key = event_insight:v1:<event_id>:<15m_bucket>:<prompt_version>:<stage>`

Enforce via Redis lock + unique DB constraint on `ai_insight_runs(run_key)`.

## 27) Cost Model and Shedding Policy

Cost model (per day):

- `DailyCost = topic_retrieval_cost + embedding_cost + stage1_cost + stage2_cost`
- retrieval term is driven by:
  - topics processed,
  - `web_search` calls,
  - `x_search` calls,
  - cache hit rate.

Operational rule:

- budget is forecast-driven first, topic-count second.
- keep `AI_INSIGHTS_TOPIC_REFRESH_MAX_PER_HOUR=200` as hard ceiling, but schedule below that based on spend forecast.

Scenario planning (required in ops dashboard):

1. Conservative:
- shadow/canary mode, low Stage2 fraction, strict topic caps.

2. Base:
- target steady-state production mode aligned to daily budget cap.

3. Aggressive:
- high topic volume and higher Stage2 ratio; used for stress tests only.

Each scenario must include:

- expected topics/hour,
- expected external calls/topic (web + x),
- expected mapped events/topic,
- Stage2 promotion rate,
- projected daily/monthly spend,
- shedding trigger point.

Shedding ladder:

1. At `>= 80%` budget or aggressive next-hour forecast:
- disable/reduce `x_search` first, keep web + internal.

2. At `>= 85%` budget:
- disable Stage2, raise link threshold.

3. At high queue lag (for example `> 5m` sustained):
- drop Tier C, widen Tier B interval, keep Tier A only.

4. At `>= 98%` budget:
- hard-stop new external/model runs, serve stale/latest only.

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

- enable insights feed ranking + selective Stage2 for high-impact ambiguity.
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

## 30) Extractor Improvement Plan (next)

Goal: improve topic/query precision before connecting dry-run outputs to real external retrieval.

Observed gaps from current dry-run output:

- entity noise still appears (`person:will`, `keyword:attend`, `keyword:wahlberg`, etc.),
- category balance is skewed (sports-heavy in top-N),
- market fan-out can overweight one event/league family,
- cost scales quickly with `N` even after dedupe.

<<<<<<< Updated upstream
### 30.1 Phase 1: entity normalization hardening (low risk, high value)
=======
- resolver archetypes: `generic`, `head_to_head`, `candidate_list`, `competition_winner`
- source-aware entity extraction (`event` vs `market` vs `derived`) with provenance fields
- politics candidate/cohort extraction from market outcomes (coalitions and person names)
- sports head-to-head parsing expansion and winner/candidate handling
- stricter unknown handling (`includeUnknownFallback`, `unknownMinMarketCount`)
- low-signal outcome label guard for unknown topics (`A/B`, `Player X`, `Team N`, `Yes/No`), using event-only subject when needed
- random sampling mode (`--order-by random`) for stress testing
- improved crypto symbol resolver (`MegaETH`-style detection) without generic token bleed
>>>>>>> Stashed changes

Changes:

- add blocklists for pronouns/aux verbs/common non-entities,
- require stronger evidence for `person:*` extraction:
  - minimum token length,
  - title-case phrase checks,
  - optional whitelist hit for politics persons/countries,
- convert uncertain entity picks to `unknown` and suppress from search-intent execution.

Acceptance:

- reduce noisy query-entity rate by at least 70% vs current top-50 baseline,
- keep top-50 `uniqueSearchTopics` within +/-20% of baseline (avoid over-pruning).

### 30.2 Phase 2: market-to-topic balancing controls

Changes:

<<<<<<< Updated upstream
- add `--per-event-cap` to limit max sampled markets per event in extraction input,
- add per-category caps for search execution (for example `sports <= 50%` of active search intents),
- add venue-aware balancing option if one venue dominates sampled rows.
=======
### 30.3 Launch profile matrix (2026-02-10, deterministic trending runs)

Command used:

- `hunch-monorepo/scripts/ai-topics-matrix.sh --mode wide --wide-limits "50 100 200"`
- output dir example: `/tmp/ai-topics-matrix-20260210021328`
>>>>>>> Stashed changes

Acceptance:

<<<<<<< Updated upstream
- no single event contributes more than configured cap in sampled input,
- category distribution remains within configured guardrails for top-50/top-100 runs.

### 30.3 Phase 3: feed-exact selector integration
=======
- `search-categories=crypto,politics,sports`
- default tiers (`A>=20`, `B>=5`)
- default cadences (`A=10m`, `B=120m`, `C=240m`)
- tool price model only: `$0.005/call`

| Profile | rows | uniqueSearchTopics | unknownMarketCoverage | calls/day after cache | tool $/day | tier A/B/C | sample kalshi/poly/limitless |
|---|---:|---:|---:|---:|---:|---|---|
| `wide_global_50` | 50 | 39 | `0/50` (`0%`) | 152.1 | 0.761 | `0/0/39` | `47/2/1` |
| `wide_global_100` | 100 | 75 | `0/100` (`0%`) | 304.2 | 1.521 | `0/1/74` | `94/5/1` |
| `wide_global_200` | 200 | 144 | `0/200` (`0%`) | 585.0 | 2.925 | `0/2/142` | `189/10/1` |
| `wide_pervenue_50` | 50 | 29 | `0/50` (`0%`) | 113.1 | 0.566 | `0/0/29` | `17/16/17` |
| `wide_pervenue_100` | 100 | 63 | `0/100` (`0%`) | 257.4 | 1.287 | `0/1/62` | `34/32/34` |
| `wide_pervenue_200` | 200 | 122 | `2/200` (`1%`) | 487.5 | 2.438 | `0/1/121` | `67/66/67` |
>>>>>>> Stashed changes

Changes:

<<<<<<< Updated upstream
- add optional mode that seeds extractor from feed-selected IDs:
  - `mode=feed_top_n`
  - uses the same repo path as feed ranking (`trending` / `trending_v2`) instead of approximate SQL ordering.

Acceptance:
=======
- `global` remains heavily Kalshi-skewed at top limits.
- `per-venue` keeps cross-venue diversity while staying well under a `$10/day` tool budget.
- static threshold-only tiering is not enough on small top-N slices; balancing promotion is required for non-zero A/B.

### 30.4 Random-stress validation (2026-02-10 matrix, hardened resolver)

Command used:

- `hunch-monorepo/scripts/ai-topics-matrix.sh --mode random --random-limit 200 --random-runs 5`
>>>>>>> Stashed changes

- overlap between feed top-N IDs and extractor input IDs >= 95% in `feed_top_n` mode.

### 30.4 Phase 4: retrieval-pack cost shaping

Changes:

<<<<<<< Updated upstream
- dynamic pack policy by confidence/impact:
  - Tier A high-confidence intent: `1 web + 1 x`
  - Tier A uncertain intent: `2 web + 1 x`
  - Tier B shed mode default: `2 web + 0 x`
- keep hard cap by expected spend, not just topic count.
=======
| Group | avg unknown topic % | avg unknown market % | avg uniqueSearchTopics | avg calls/day after cache | tool $/day |
|---|---:|---:|---:|---:|---:|
| `global` | `12.79%` (`13.2/103.2`) | `12.10%` (`24.2/200`) | `103.2` | `435.24` | `2.176` |
| `per-venue` | `7.59%` (`8.8/116.0`) | `6.60%` (`13.2/200`) | `116.0` | `471.12` | `2.356` |
>>>>>>> Stashed changes

Acceptance:

<<<<<<< Updated upstream
- top-50 mode remains below configured daily tool budget cap,
- no budget-cap breach in simulation runs across 7-day replay.

### 30.5 Phase 5: mapping-readiness hooks (before publish)
=======
- election outcomes represented as `A/B/C/D` or generic `Party X`,
- sports awards/rosters with anonymized `Player X`, `Team N`,
- qualifier/group markets where entity is not explicit in title/outcome.

Important hardening outcome:

- placeholder topics are now effectively suppressed (`placeholderTopics=0` across matrix outputs),
- unresolved topics remain as `unknown` with explicit `unknownReason` so they can be handled by a separate bounded unknown-resolution lane.
>>>>>>> Stashed changes

Changes:

- emit deterministic `mapping_input_candidates` from extractor output:
  - lexical candidates,
  - embedding candidate ids (when available),
  - constraint/time match features.
- this bridges extractor output directly into mapping evaluation harness.

<<<<<<< Updated upstream
Acceptance:

- extractor output can be consumed by offline mapping eval without adapter scripts,
- mapping eval reports precision/coverage per category from extractor-produced intents.

### 30.6 Suggested default launch profile (cost-first)

For the initial external-retrieval launch:
=======
- `sampling=per-venue`
- `limit=50` (top per-venue trending slice)
- `search-categories=crypto,politics,sports`
- keep unknown suppression enabled for live deterministic execution

Cadence/options:

- default query packs now assume both tools for all tiers (`web + x`) to keep source diversity consistent.
- balancing promotion (current default):
  - `tier-auto-promote-a=true`, `tier-auto-promote-a-min-market-count=2`
  - `tier-auto-promote-b=true`, `tier-auto-promote-b-min-topics=2`, `tier-auto-promote-b-min-market-count=2`
  - effect: if static thresholds produce only C, we promote to maintain non-zero A/B.

Measured top50 result with balancing enabled:

- `wide_global_50`: `tier A/B/C = 1/2/36`, `calls/day after cache = 592.8`, tool cost/day `~$2.964`
- `wide_pervenue_50`: `tier A/B/C = 1/2/23`, `calls/day after cache = 491.4`, tool cost/day `~$2.457`

This is still below `$10/day` for tool invocations only; token/model budget remains separately capped via hard budget + shedding.
>>>>>>> Stashed changes

- start with top-50 (`--limit 50`) and strict quality gates,
- run hourly (`tier-a-cadence-minutes=60`),
- keep Tier C off,
- if daily spend drifts upward, first reduce pack size, then reduce N.

Operational note:

<<<<<<< Updated upstream
- maintain a weekly top-50/top-100/top-200 comparison report to track:
  - topic quality drift,
  - category skew,
  - estimated cost drift,
  - noise-entity rate.
=======
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

- `XAI_API_KEY=... pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file /tmp/ai-topics-smoke.json --tiers A,B --max-topics 8 --mode both --out /tmp/ai-search-smoke.json --verbose`

3. Optional dry-run to inspect payload shape only:

- `pnpm -C hunch-monorepo -F api run ai:search:smoke -- --topics-file /tmp/ai-topics-smoke.json --tiers A,B --max-topics 4 --mode both --dry-run`

Notes:

- `ai:search:smoke` sends one tool-enabled request per planned prompt (`web_news`, `x_signal`) with system-level JSON enforcement.
- It records HTTP status, latency, citations count, and output preview for quick quality/cost checks.

### 30.10 Focused QA on real retrieval (selected topics 4, 8, 1)

Run setup:

- source plan: `/tmp/ai-topics-picked-4-8-1.json`
- smoke output: `/tmp/ai-search-smoke-picked-4-8-1.json`
- olympics web retry output: `/tmp/ai-search-smoke-olympics-web-retry.json`
- calls: strict `web_news + x_signal`, `maxTopics=3`, no fallback lane

Observed outcomes:

| Topic | Web | X | Expected Stage-3/4 action |
|---|---|---|---|
| `keyword:busan-mayoral-election` | `NO_EVIDENCE (0/2)` | `NO_EVIDENCE (0/2)` | suppress topic (no mapping, no publish) |
| `keyword:prime-minister-israel-election` | `PARTIAL (3/2)` | `OK (6/2)` | proceed to mapping for Israel PM event/candidate markets |
| `keyword:olympics` | first call `502`, retry `OK (6/2)` | `OK (5/2)` | proceed to mapping; tag transient provider error for reliability metrics |

Interpretation:

- evidence gating behaves correctly: no-evidence topics are suppressed instead of forcing low-quality insights
- mixed-source topics pass only when support threshold is met
- provider-transient failures must be handled by bounded retry policy in scheduler/worker layer

### 30.11 Next implementation steps (immediate)

1. Add provenance gate in worker execution path (`citations` and `server_side_tool_usage` required before publish eligibility).
2. Add bounded retry + idempotency for external calls (`max_retries=1`, jittered backoff, no fan-out amplification).
3. Wire strict threshold-aware support checks for numeric markets before `supports_topic=true`.
4. Run weekly `top50 per-venue` replay matrix and track suppression/pass ratios by category/tier.
5. Start mapping-stage canary using only topics that pass both web and x support thresholds.
>>>>>>> Stashed changes
