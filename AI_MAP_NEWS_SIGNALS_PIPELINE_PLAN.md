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

---

## 11) Phased Plan (Re-aligned)

## Phase 0 (Done)

- map build + map UI serving.
- search smoke with strong guardrails and prompt updates.
- signals smoke with gating and target naming.

## Phase 1 (Next, productization)

- Redis persistence contract for search outputs (not only tmp files),
- run status markers + TTL policy,
- scheduler wiring for periodic search/signals.

Acceptance:

- active run has machine-readable Redis artifacts for evidence + assignments + audit.

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

# search smoke
pnpm -C hunch-monorepo -F api run ai:map-search:smoke -- \
  --concurrency 4 \
  --max-calls 16 \
  --budget-usd 1 \
  --out /tmp/ai-map-search-smoke.json \
  --report-out /tmp/ai-map-search-smoke.md

# signals smoke
pnpm -C hunch-monorepo -F api run ai:map-signals:smoke -- \
  --in /tmp/ai-map-search-smoke.json \
  --out /tmp/ai-map-signals-smoke.json \
  --report-out /tmp/ai-map-signals-smoke.md
```

---

## 14) Open Gaps and Questions (for next discussion)

1. Redis persistence schema for search stage is still a plan item (currently artifact-first via `/tmp` in smoke).
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
