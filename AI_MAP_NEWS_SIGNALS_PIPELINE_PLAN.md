# AI Map News + Signals Pipeline Plan (Redis-First, Map-Run Scoped)

## 1) Objective

Build a production-safe, map-first AI pipeline with four independent jobs, keyed by `runId`:

1. `map-build` (implemented): build hierarchical market-map snapshot.
2. `news-search` (implemented as smoke, productizing next): collect and assign fresh evidence.
3. `signal-generate` (implemented as smoke, productizing next): generate market/event signals.
4. `cluster-summary-generate` (planned): generate cluster digests.

Design goals:

- deterministic and auditable per `runId`,
- strict budget/token/tool guards,
- good branch coverage with low waste,
- clear serving contract for map UI,
- Redis-first search stage (no Postgres writes in search stage).

---

## 2) Scope and Non-Goals

### In scope

- Evidence retrieval + assignment to map hierarchy.
- Signal generation from assigned evidence + candidate markets.
- Cluster summaries from assigned evidence.
- Rollover behavior across new map runs.
- Serving contracts for map UI consumption.

### Out of scope

- Global feed ranking policy.
- Notification strategy.
- Long-term warehouse/historical BI modeling.

---

## 3) Current State (Implemented)

## 3.1 Map build + serving

- Build script: `pnpm -C hunch-monorepo -F api run ai:embed:market-map`.
- Active run metadata and nodes stored in Redis:
  - `ai:market_map:v1:active`
  - `ai:market_map:v1:run:<runId>:meta`
  - `ai:market_map:v1:run:<runId>:nodes`
  - node + node-events keys for drilldown.
- API routes are live:
  - `GET /market-map`
  - `GET /market-map/node/:id`
  - `GET /market-map/node/:id/events`
- Frontend cluster/treemap drilldown implemented in `Hunch_App/src/app/market-map`.

## 3.2 Search smoke (`ai:map-search:smoke`)

Implemented behavior:

- node-priority traversal over active run,
- xAI tools (`web_search` + `x_search`),
- strict JSON schema parse,
- post-parse freshness filtering (level-aware windows),
- source-domain denylist and source caps,
- assignment routing via lexical + semantic hybrid,
- leaf assignment invariant (`assignedNodeId=node.id` for no-child nodes),
- per-run guardrails: USD budget, max calls, token guards, tool-attempt guards,
- prompt improvements:
  - per-call context only (`window_hours_for_this_call`, `soft_tool_cap_this_call`),
  - branch ranking + pivot guidance,
  - `event | representative_market` samples,
  - prompt length trimming to reduce token waste.

## 3.3 Signals smoke (`ai:map-signals:smoke`)

Implemented behavior:

- consumes search artifact + map snapshot,
- candidate markets scored by affinity (hybrid lexical+semantic),
- model synthesis using `openai/gpt-5.2`,
- strict post-model gates (`LOW_CONFIRMED`, affinity, target validity, etc.),
- output includes target event/market names and evidence refs,
- latest improvements:
  - market target tie-break: affinity -> liquidity -> open interest -> volume -> score,
  - stronger social near-duplicate suppression before generation.

## 3.4 Cost Accounting (Normalized)

Implemented normalization across map/search/signals:

- provider-reported cost preferred when present (`usage.cost`, `usage.cost_in_usd_ticks`),
- estimated fallback retained for compatibility,
- charged cost = provider-reported OR estimated fallback,
- outputs now carry both `estimated` and `charged` totals plus source breakdown.

New shared helpers:

- `apps/api/src/lib/ai-cost.ts`
- `apps/api/src/lib/ai-pricing.ts`

Verified OpenRouter pricing defaults (captured 2026-02-27):

| Model | Input $ / 1M | Output $ / 1M | Notes |
|---|---:|---:|---|
| `openai/gpt-5.2` | `1.75` | `14.00` | from OpenRouter model metadata + live probe |
| `openai/gpt-5-nano` | `0.05` | `0.40` | from OpenRouter model metadata + live probe |
| `openai/text-embedding-3-small` | `0.02` | `0.00` | from live embeddings probe (`usage.cost`) |

---

## 4) Latest QA Baseline (2026-02-27, post prompt + ranking updates)

## 4.1 Search run

Input artifact:

- `/tmp/ai-map-search-smoke.json` generated `2026-02-27T18:45:38.261Z`

Observed:

- calls: `16`
- accepted evidence: `62`
- estimated cost: `$0.650705`
- tokens: `input=310,180`, `output=87,337`
- tool attempts: `109` (avg `6.81` per call)
- freshness drops: `32`
- source-cap drops: `0`
- domain-policy drops: `0`
- parse validity: `16/16 valid`
- level spread: `L1=6`, `L2=5`, `L3=5`
- evidence source diversity: `42` unique domains
- routing:
  - `assigned_child=38`
  - `low_margin=12`
  - `leaf_self=12`
  - assigned similarity (n=38): median `~0.751`, range `0.695..0.812`

Interpretation:

1. Stability is strong (no parse failures).
2. Coverage and diversity are strong.
3. Freshness filtering still costs recall (32 dropped), but is materially better than older runs.
4. Routing quality is now usable for downstream signal generation.

## 4.2 Signals run

Input artifact:

- `/tmp/ai-map-signals-smoke.json` generated `2026-02-27T18:47:35.188Z`

Observed:

- generated signals: `15`
- publish candidates: `14`
- context only: `1`
- skipped: `0`
- model publish count: `15`
- downgraded from publish: `1` (`LOW_CONFIRMED`)
- token cost: `$0.012278`
- publish-candidate target names present: `14/14` event + market titles
- output naming quality:
  - missing `target_market_name`: `0`
  - missing `target_event_name`: `0`

Interpretation:

1. Signal pipeline is functionally healthy.
2. Downgrade gate is working as intended.
3. There is still occasional low-depth publish evidence (`1 evidence / 1 domain`) depending on active thresholds.

---

## 5) Target Architecture (Updated)

## 5.1 Job A: `map-build` (independent)

Input:

- market/event universe + embeddings + runtime policy.

Output:

- map snapshot in Redis with active `runId`.

## 5.2 Job B: `news-search` (Redis-only output)

Input:

- active `runId`,
- search model/tool config and budget policy.

Output (Redis + artifact):

- run-scoped evidence objects,
- run-scoped assignments (`assignedNodeId`, similarity, routing reason),
- run-scoped audit metrics.

**Important:** this stage does **not** write to Postgres.

## 5.3 Job C: `signal-generate` (consumer + publisher)

Input:

- run evidence + assignments + map candidate markets.

Output:

- run-scoped signal objects for serving,
- publish-ready candidates for market/event publishing path.

## 5.4 Job D: `cluster-summary-generate` (consumer)

Input:

- run evidence/assignments by node.

Output:

- run-scoped cluster summaries (with refs and confidence).

---

## 6) Storage Contract (Redis-First)

## 6.1 Current contract direction

- Current smoke implementation reads map snapshot from Redis and writes artifacts to JSON files (`/tmp`).
- Phase 1 target is to persist search artifacts in Redis with run-scoped keys.
- Only publish stage should write durable external-facing signal records.

## 6.2 Suggested key families

- `ai:map_search:v1:run:<runId>:evidence`
- `ai:map_search:v1:run:<runId>:assignments`
- `ai:map_search:v1:run:<runId>:calls`
- `ai:map_search:v1:run:<runId>:audit`
- `ai:map_signals:v1:run:<runId>:signals`
- `ai:map_summary:v1:run:<runId>:nodes`
- `ai:map_pipeline:v1:run:<runId>:status`

Phase-1 concrete keys (search persistence + reuse):

- `ai:map_search:v1:run:<runId>:artifact`
  - compact JSON artifact (same logical content as `/tmp/ai-map-search-smoke.json`).
- `ai:map_search:v1:run:<runId>:state`
  - resumable scheduler state: `queue`, `queuedSet`, `visitedSet`, `budgetState`, `consecutiveLowYieldHighTools`, `consecutiveTransportFailures`, counters.
- `ai:map_search:v1:run:<runId>:status`
  - hash fields: `state`, `startedAt`, `completedAt`, `callsExecuted`, `evidenceTotal`, `spentUsd`, `inputTokens`, `outputTokens`, `toolAttempts`, `error`.
- `ai:map_search:v1:run:<runId>:evidence_ids`
  - set of evidence ids in the run.
- `ai:map_search:v1:run:<runId>:node:<nodeId>:evidence_ids`
  - set of evidence ids assigned to a node.
- `ai:map_search:v1:run:<runId>:node:<nodeId>:headlines`
  - capped list used for dedupe/nudge context.
- `ai:map_search:v1:latest`
  - pointer to latest completed search `runId`.
- `ai:map_search:v1:map_run:<runId>:latest_search`
  - pointer to latest search attempt for a map run.
- `ai:embed:news:v1:<evidenceId>`
  - hash: `embedding` (binary), `headline`, `summary`, `sourceDomain`, `publishedAt`, `createdAt`.
- `ai:map_search:v1:recent_evidence`
  - sorted-set index for fresh evidence ids (`score = publishedAt epoch ms`) used by warm-start reroute.
- `ai:map_search:v1:run:<runId>:lock`
  - distributed lock key for single-writer execution.
- `ai:map_signals:v1:last_input_digest`
  - digest of latest consumed search artifact/map run for no-change skip checks.
- `ai:map_signals:v1:run:<runId>:input_digest`
  - run-scoped input digest used by signals job.
- `ai:map_signals:v1:publish:<signalKey>`
  - idempotency key for publish path (`SETNX`/upsert guard).
- `ai:map_signals:v1:publish:cooldown:<signalKey>`
  - optional cooldown key to suppress near-identical republish noise.

Status fields:

- `map_ready`
- `search_complete`
- `signals_complete`
- `summary_complete`
- `publish_complete`

## 6.3 Durability note

- Optional future phase: add Postgres canonical evidence tables.
- Not required for initial productized flow.

---

## 7) Dataflow

```text
map-build -> active runId snapshot (Redis)
        -> news-search (Redis-only evidence + assignments + audit)
        -> signal-generate (Redis read; publish candidates)
        -> cluster-summary-generate (Redis read; node summaries)
        -> serving APIs (news/signals/summaries by active runId)
```

On map rollover:

```text
new runId -> fresh search traversal
optional: best-effort reroute from recent run evidence cache when available
```

Signals execution rule:

1. signals job reads latest completed search artifact for active map run.
2. compute `input_digest` from (`mapRunId`, `searchRunId`, normalized evidence/assignment snapshot version).
3. if `input_digest == last_input_digest`, skip run with status `skipped_no_input_change`.
4. if changed, run signals and update `last_input_digest`.

Search reuse modes:

1. `cold_start`
   - no prior run state loaded.
2. `resume_same_run`
   - load `run:<runId>:state`; if missing, load `run:<runId>:artifact`; if both missing, fall back to cold start.
3. `warm_start_prior_run`
   - load fresh recent evidence from prior run ids, reroute by embedding similarity to current run nodes, then start search with seeded priorities.

Persistence modes:

1. `artifact_only` (Phase 1a)
   - write/read `artifact` + `state` + `status` keys only.
2. `normalized_keys` (Phase 1b)
   - additionally maintain normalized `evidence/assignments/calls/audit` keys.

Source of truth rule:

- `artifact_only`: `run:<runId>:artifact` is canonical.
- `normalized_keys`: normalized keys are canonical; artifact is derived/debug-only.

Warm-start reroute algorithm (KISS):

1. read recent evidence ids from `ai:map_search:v1:recent_evidence` bounded by freshness windows.
2. load `ai:embed:news:v1:<evidenceId>` embedding.
3. score against current node centroids (same hybrid policy already used for assignment).
4. if score passes threshold, attach as prior context and add branch priority seed.
5. never auto-accept old evidence as new run output; old evidence only nudges traversal/prompt context.

Run execution contract (single writer + resume safety):

1. acquire lock via `SET ai:map_search:v1:run:<runId>:lock <owner> NX EX <ttlSec>`.
2. heartbeat lock every `lockHeartbeatSec`; if heartbeat fails, worker aborts.
3. write checkpoint (`state` + `status`) after each completed call batch.
4. on restart with `resume_same_run`, load in canonical order: `state -> artifact -> cold_start`.
5. if active map run changes during execution, stop with `map_run_changed` and do not publish partial artifacts as completed.

---

## 8) Recency, Routing, and Quality Policy

## 8.1 Freshness policy

- use source `published_at` first,
- level-aware windows:
  - L1: `96h`
  - L2: `72h`
  - L3: `24h`
- strict acceptance filter after parse.

## 8.2 Routing policy

- hybrid assignment (semantic + lexical + route margin),
- keep `low_margin` evidence for context/summaries,
- prefer `assigned_child` evidence for publish-grade signals.

## 8.3 Social/source hygiene

- maintain source denylist in search stage,
- cap unconfirmed evidence per call,
- dedupe social near-duplicates before signal generation.

Default denylist currently includes:

- `polymarket.com`, `kalshi.com`, `limitless.exchange`,
- `hunch.trade`, `app.hunch.trade`,
- `instagram.com`, `facebook.com`, `tiktok.com`,
- `mexc.com`, `mexc.co`, `kucoin.com`.

---

## 9) Generation Contracts

## 9.1 `signal-generate`

Input:

- assigned evidence + candidate markets with odds/liquidity/open interest.

Output:

- `publish_candidate` | `context_only` | `skip`,
- `signal_type`, `direction`, `confidence`,
- `target_event_id`, `target_market_id`, names, evidence refs, reason codes.

Current gate profile:

- smoke profile is intentionally permissive for exploration (`minEvidence/minConfirmed/minDistinctDomains` can be `1`).
- publish profile should be stricter in production presets.

## 9.2 `cluster-summary-generate`

Input:

- direct assigned node evidence (+ optional descendant rollup).

Output:

- concise node summary + confidence + refs + freshness markers.

Serving should explicitly label:

- `direct` evidence vs `descendant` rollup evidence.

---

## 10) Budget and Cost Controls

Keep:

- max calls,
- max total input/output tokens,
- max tool attempts,
- USD budget with expected-next-call guards.

Budget scopes (required):

1. per-run budget
- hard cap for a single execution (`budgetUsd`).
2. rolling window budget
- cap spend in a rolling time window (`budgetWindowMinutes`, `budgetWindowUsd`).
3. optional daily cap
- safety ceiling for 24h (`dayBudgetUsd`).
4. optional slot budgets
- UTC slot caps (example: `00:00-06:00`, `06:00-12:00`, each with own USD cap).

Run-rate scopes (required for heartbeat mode):

1. min interval gate
- do not run if `now - lastStartedAt < pollIntervalSec`.
2. rolling run-count cap
- cap run starts per rolling window (`runWindowMinutes`, `maxRunsPerWindow`).
3. optional daily run cap
- cap run starts per UTC day (`maxRunsPerDay`, optional).

Trigger model (required):

1. `triggerMode = interval` (default)
- run loop wakes every `pollIntervalSec`, then budget/lock gates decide run/skip.
2. `triggerMode = cron` (optional compatibility)
- cron tick invokes same gate logic.
3. recommendation:
- search uses slower interval, signals uses faster interval.

Budget ledger keys (required for scheduler):

- `ai:map_budget:v1:search:spend_log`
  - sorted set of run spend records (score: run end epoch ms, member: JSON/ref containing runId + usd).
- `ai:map_budget:v1:signals:spend_log`
  - same shape for signals stage.
- `ai:map_budget:v1:search:day:<YYYY-MM-DD>`
  - optional daily accumulator for O(1) day checks.
- `ai:map_budget:v1:signals:day:<YYYY-MM-DD>`
  - optional daily accumulator for O(1) day checks.

Run-rate ledger keys (required for scheduler):

- `ai:map_runs:v1:search:start_log`
  - sorted set; score=`startedAt epoch ms`, member=`runId` (or `runId:attempt`).
- `ai:map_runs:v1:signals:start_log`
  - same for signals.
- `ai:map_runs:v1:summary:start_log`
  - same for summaries.
- `ai:map_runs:v1:search:day:<YYYY-MM-DD>`
  - optional daily run-start accumulator.
- `ai:map_runs:v1:signals:day:<YYYY-MM-DD>`
  - optional daily run-start accumulator.
- `ai:map_runs:v1:summary:day:<YYYY-MM-DD>`
  - optional daily run-start accumulator.

Scheduler decision flow (KISS):

1. read runtime policy.
2. check lock status.
3. check run-rate gates:
   - min-interval gate (`pollIntervalSec`),
   - rolling run-count cap (`runWindowMinutes` + `maxRunsPerWindow`),
   - optional day run cap (`maxRunsPerDay`).
4. if run-rate blocked: write status (`skipped_min_interval` | `skipped_run_rate_window` | `skipped_run_rate_day`) and exit.
5. read budget ledger and compute:
   - rolling window spend (`now - budgetWindowMinutes`),
   - current UTC day spend,
   - active UTC slot spend (if slot budgets configured).
6. if over budget: write status `skipped_budget_window` and exit cleanly.
7. if allowed: run with normal per-run guards.
8. on run start: append run-start record to run-rate logs.
9. on completion: append spend record to spend log and update day accumulator.

CLI behavior:

- scheduler mode must enforce policy budgets.
- manual CLI may bypass budget-window checks via explicit flag:
  - `--ignore-policy-budget` (or `--force`).
- per-run hard safety caps still apply unless explicitly overridden.

Operational additions:

1. per-level quotas to avoid starving L3,
2. branch cooldown for repeated low-yield branches,
3. dynamic expected-output EWMA by model,
4. per-call tool cap (already provided to prompt as context).

Current operating profile used in QA:

- search: `--concurrency 4 --max-calls 16 --budget-usd 1`,
- freshness windows: `L1=96h, L2=72h, L3=24h`,
- routing thresholds: `L1=0.20, L2=0.24, L3=0.28`,
- route min margins: `L1=0.015, L2=0.02, L3=0.025`.

Runtime policy knobs required (search stage):

- minimal operator knobs:
  - `enabled` (bool)
  - `triggerMode` (`interval | cron`)
  - `pollIntervalSec` (int)
  - `scheduleCron` (string, optional when `triggerMode=cron`)
  - `profile` (`safe | balanced | aggressive`)
  - `runWindowMinutes` (int)
  - `maxRunsPerWindow` (int)
  - `maxRunsPerDay` (int, optional)
  - `budgetWindowMinutes` (int)
  - `budgetWindowUsd` (number)
  - `dayBudgetUsd` (number, optional)
  - `slotBudgetsUtc` (array, optional; `{ startHHMM, endHHMM, budgetUsd }`)
  - `reuseMode` (`cold_start | resume_same_run | warm_start_prior_run`)
- advanced knobs (`advanced.search`):
  - `dryRun` (bool)
  - `persistenceMode` (`artifact_only | normalized_keys`)
  - `model` (string)
  - `embedModel` (string)
  - `toolMode` (`both | web | x`)
  - `strictSchema` (bool)
  - `requireDistinctDomains` (bool)
  - `maxCalls` (int)
  - `maxTurns` (int)
  - `concurrency` (int)
  - `budgetUsd` (number)
  - `timeoutSec` (int)
  - `maxRetries` (int)
  - `retryBaseMs` (int)
  - `maxTotalInputTokens` (int)
  - `maxTotalOutputTokens` (int)
  - `maxTotalToolAttempts` (int)
  - `maxToolAttemptsPerCall` (int)
  - `maxEvidencePerCall` (int)
  - `maxEvidenceTotal` (int)
  - `windowHoursL1`, `windowHoursL2`, `windowHoursL3` (int)
  - `recentHoursHint` (int)
  - `enforceFreshness` (bool)
  - `routeThresholdL1`, `routeThresholdL2`, `routeThresholdL3` (number)
  - `routeMinSimilarity` (number)
  - `routeMinMarginL1`, `routeMinMarginL2`, `routeMinMarginL3` (number)
  - `branchPerCall` (int)
  - `topRootCount` (int)
  - `eventSampleLimit`, `childSampleLimit`, `siblingSampleLimit` (int)
  - `sourceAllowDomains` (string[])
  - `sourceDenyDomains` (string[])
  - `maxXEvidencePerCall` (int)
  - `maxUnconfirmedEvidencePerCall` (int)
  - `lowYieldToolAttemptThreshold` (int)
  - `lowYieldConsecutiveThreshold` (int)
  - `ewmaAlpha` (number)
  - `bootstrapExpectedInputTokens` (int)
  - `bootstrapExpectedOutputTokens` (int)
  - `bootstrapExpectedCallCostUsd` (number)
  - `lockTtlSec` (int)
  - `lockHeartbeatSec` (int)
  - `artifactTtlSec` (int)
  - `newsEmbeddingTtlSec` (int)
  - `recentEvidenceTtlSec` (int)
  - `warmStartEvidenceCap` (int)
  - `warmStartMinSimilarity` (number)

Runtime policy knobs required (signals stage):

- minimal operator knobs:
  - `enabled` (bool)
  - `triggerMode` (`interval | cron`)
  - `pollIntervalSec` (int)
  - `scheduleCron` (string, optional when `triggerMode=cron`)
  - `profile` (`safe | balanced | aggressive`)
  - `runWindowMinutes` (int)
  - `maxRunsPerWindow` (int)
  - `maxRunsPerDay` (int, optional)
  - `budgetWindowMinutes` (int)
  - `budgetWindowUsd` (number)
  - `dayBudgetUsd` (number, optional)
  - `slotBudgetsUtc` (array, optional; `{ startHHMM, endHHMM, budgetUsd }`)
- advanced knobs (`advanced.signals`):
  - `dryRun` (bool)
  - `model` (string)
  - `embedModel` (string)
  - `maxNodes`, `maxSignals` (int)
  - `maxEvidencePerNode`, `maxMarketsPerNode` (int)
  - `minEvidence`, `minConfirmed`, `minDistinctDomains` (int)
  - `minEvidenceIdsForPublish` (int)
  - `minAffinityForPublish` (number)
  - `concurrency` (int)
  - `maxOutputTokens` (int)
  - `timeoutSec` (int)
  - `budgetUsd` (number)

KISS policy shape (required):

1. expose only minimal top-level controls to operators.
2. keep all other controls under `advanced.search` / `advanced.signals`.
3. profile presets map to defaults:
- `safe`: lower concurrency/tool caps, stricter publish thresholds.
- `balanced`: current baseline.
- `aggressive`: higher concurrency/coverage for exploration.
4. for scheduling, prefer `triggerMode=interval`; use cron only when needed by ops.

---

## 11) Phased Plan (Re-aligned)

## Phase 0 (Done)

- map build + map UI serving.
- search smoke with strong guardrails and prompt updates.
- signals smoke with gating and target naming.

## Phase 1A (Next, minimal productization)

- Redis persistence contract for search outputs (not only tmp files),
- run status markers + TTL policy,
- scheduler wiring for periodic search/signals.
- runtime policy schema + admin read/write API (minimal knobs + advanced block).
- startup load order for jobs: `runtime policy -> map active runId -> reuse mode -> execute`.
- budget-window enforcement in scheduler (rolling + optional slot/day caps).
- CLI override flags for manual runs (`--ignore-policy-budget` / `--force`).
- production runners from smoke core.
- signals no-change skip (`input_digest`) logic.
- publish idempotency keys (`signalKey`) + cooldown suppression.

Acceptance:

- active run has machine-readable Redis artifacts + resumable `state`.
- search job can `resume_same_run` without restarting from root.
- scheduler skips runs cleanly when budget window is exhausted, with explicit status reason.
- scheduler skips runs cleanly on run-rate gates with explicit status reason.
- signals skips cleanly when input digest unchanged (`skipped_no_input_change`).
- manual CLI can run outside scheduler windows when explicitly forced.
- publish path is idempotent for same `signalKey`.

Measurable acceptance (Phase 1A):

1. Resume correctness:
   - duplicate ratio denominator = `count(distinct evidence.id)` in final run artifact.
   - requirement: `duplicates / distinct_evidence <= 1%`.
2. Budget-window enforcement:
   - in over-budget slots, `0` runs start and status contains `skipped_budget_window`.
3. Run-rate enforcement:
   - if `maxRunsPerWindow` exceeded, next poll produces `skipped_run_rate_window`.
4. Stability:
   - across 5 runs, parse-valid call ratio `>= 95%`.
5. Signals no-change efficiency:
   - with unchanged input digest across 10 polls, `10/10` runs skip with `skipped_no_input_change`.
6. Publish idempotency:
   - repeated publish attempts for same `signalKey` create at most one active record (upsert-only behavior).

## Phase 1B (reuse optimization)

- warm-start (`warm_start_prior_run`) nudging from recent evidence embeddings.
- normalized key mode (`normalized_keys`) as optional canonical mode.

Measurable acceptance (Phase 1B):

1. Warm-start efficiency:
   - across 5 paired runs on same map conditions, median `toolAttempts` improves by `>= 15%` vs cold-start.
2. Warm-start quality guard:
   - accepted evidence count drop `<= 10%` vs cold-start median.
3. Routing guard:
   - `assigned_child / evidence_total` degradation `<= 5pp` vs cold-start median.
4. Cost guard:
   - median `spent_usd / accepted_evidence` degradation `<= 10%`.

## Phase 2

- cluster-summary job + serving endpoint.

## Phase 3

- publish pipeline integration for signal candidates (idempotent publish keys).

## Phase 4 (Optional)

- Postgres durability for canonical evidence/assignments if long-retention or analytics needs justify it.

---

## 12) Immediate Improvements Applied

From recent iterations:

1. Prompt made less confusing:
- per-call context only, no whole-job budget/call context.

2. Prompt relevance boosted:
- includes event|market samples and explicit pivot strategy.

3. Prompt token waste reduced:
- length trimming for labels and sample lines.

4. Signals target precision improved:
- tie-break favors deeper/liquid markets when affinity is close.

5. Social noise reduced:
- near-duplicate social evidence suppression before generation.

6. Publish precision safeguards retained:
- `LOW_CONFIRMED` downgrade gate remains active,
- publish target choice now affinity-first with liquidity/open-interest tie-breaks.

---

## 13) Commands

```bash
# map build
pnpm -C hunch-monorepo -F api run ai:embed:market-map -- --force

# search smoke (QA/debug)
pnpm -C hunch-monorepo -F api run ai:map-search:smoke -- \
  --concurrency 4 \
  --max-calls 16 \
  --budget-usd 1 \
  --out /tmp/ai-map-search-smoke.json \
  --report-out /tmp/ai-map-search-smoke.md

# signals smoke (QA/debug)
pnpm -C hunch-monorepo -F api run ai:map-signals:smoke -- \
  --in /tmp/ai-map-search-smoke.json \
  --out /tmp/ai-map-signals-smoke.json \
  --report-out /tmp/ai-map-signals-smoke.md

# production runners (policy-driven; to be added in Phase 1)
# pnpm -C hunch-monorepo -F api run ai:map-search:run
# pnpm -C hunch-monorepo -F api run ai:map-signals:run

# API policy/unit tests (runtime policy + scheduler guard normalization)
pnpm -C hunch-monorepo -F api run test intel
```

---

## 14) Test Coverage (Updated)

Implemented now:

1. `apps/api/src/intel-tests.ts` includes market-map runtime policy coverage for:
   - deprecated override-key sanitization (`projectionAlgo`, `layoutMode`),
   - scheduler/projection normalization clamps (`pollIntervalSec`, `lockTtlSec`, `k1/k2/k3`, projection bounds),
   - fallback behavior (`labelLevels=[] -> [1,2,3]`, invalid venues -> default venues set).
2. Existing `apps/api/src/test-runner.ts` auto-discovers these tests (`*-tests.ts`), so no harness changes are required.

Next test-runner additions (Phase 1A):

1. Search artifact contract test (`ai-map-search-smoke`) with fixture output:
   - required fields present,
   - routing invariants hold (`leaf_self` assignment consistency),
   - budget/guard stop reason is machine-readable.
2. Signals artifact contract test (`ai-map-signals-smoke`) with fixture output:
   - publish/context decisions valid against gate reasons,
   - target name/id consistency checks.

---

## 15) Open Gaps and Questions (for next discussion)

1. Redis persistence schema for search stage is still a plan item (currently artifact-first via `/tmp` in smoke).
1. Phase-1A persistence is not implemented yet:
   - Redis artifact/state/status writes,
   - lock/heartbeat,
   - resume load path.
2. Rollover policy decision:
   - strict fresh re-search every run, or
   - partial reroute from recent run cache before new search.
3. Publish profile thresholds:
   - keep permissive (`1/1/1`) for coverage, or raise for precision in production preset.
4. Summary stage policy:
   - include `low_margin` evidence by default or only as secondary context.
5. Serving API contract:
   - exact response shape and TTL semantics for `news`, `signals`, `summary`.
6. Search efficiency policy:
   - how aggressively to cut low-yield, tool-heavy branches without losing useful recall.
7. Freshness vs cost policy:
   - whether L1/L2 windows should remain wide (`96h/72h`) or tighten by branch class.
8. Publish precision policy:
   - when to move from exploratory gates (`1/1/1`, affinity `0.15`) to stricter production defaults.
9. Runtime policy ownership:
   - single shared policy document vs separate `search` and `signals` policy docs.
10. Redis footprint limits:
   - exact TTL/size caps for artifacts, embeddings, and per-node headline caches.
