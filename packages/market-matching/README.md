# Jev market matching v1

Local review implementation for Polymarket and Limitless. Nothing is enabled by
installation: the default runtime policy disables the worker, lazy demand and
every consumer. No production data, policies, schedules or secrets were changed.

## Processing

An independent matcher selector samples at most `warmBatchSize` seeds every
`warmIntervalSeconds` (defaults: 300 / 15 minutes). Source allocations default to
75 indexed trending, 75 Limitless markets with historical volume >= $1,000,
60 feed/movers, 45 Market Map and 45 whale-activity markets. Allocations sum to
at most the batch size; duplicates are skipped before consuming each allocation.

Candidate pool depths are separate policy controls: `warmPrefixCount` (1,000),
`warmLimitlessPoolSize` (500), `seedFeedDepth` (100 rows per feed sort),
`seedMapDepth` (25 per sidebar), and `seedWhalesDepth` (60 wallets).
`seedMarketsPerEvent` (3), `seedWhaleMarketCount` (5),
`seedWhaleChangeCount` (3), and `seedMapMinVolumeUsd` (1,000) control product
selection detail. API page bounds remain schema ceilings, not hidden batch caps.
Before source quotas are applied, a single bounded PostgreSQL lookup removes
closed, lifecycle-ineligible, already pending and cooling warm interests.
Existing lazy work can be promoted even at capacity; unseen markets come next,
then due markets by oldest request. Successive cycles advance through these
ranked pools; they do not crawl the entire catalog. A cycle may select fewer
than its cap when pools overlap, cool down, or exhaust their eligible rows.
Larger batches do not change inference budgets, pair limits or approval evidence.
Product sources use read-only API selections through `MATCHING_DISCOVERY_API_URL`;
the API cache warmer is unchanged and never calls Jev. Unknown liquidity/24h volume
is not treated as zero. Explicitly zero-activity product records are skipped.
There is no full-catalog scan. The indexed trending prefix is a cheap priority
signal; product API selectors retain their own ranking implementation.

Indexed full-text retrieval and deterministic context checks admit at most two
event pairs and three contract pairs per seed. Independent contract retrieval
prevents an event miss from automatically excluding a valid contract pair.
An indexed, bounded lexical rescue handles flat questions versus grouped child
claims when the strict search yields no contract. Context/selection checks still
apply, and candidate retrieval never proves payout equivalence.
Event approval never fans out all children into inference. Each pair has a
canonical order, versioned evidence and an idempotent job. Reads, inference and
publication recheck venue eligibility and evidence freshness.

There are separate event, contract and outcome links. A named candidate may map
to YES of a child binary market. Partial outcome coverage stays explicit. No
transitive closure, opponent-NO inference or proof based on negRisk is used.
Full event coverage means all currently stored child outcomes on both sides
have verified links; it is not a claim of mathematical exhaustiveness.

Authenticated POST `/markets/:marketId/alternatives/discovery` records interest,
not an immediate provider request. No caller-supplied pair, actor or priority is
accepted. Public GET, MCP and CLI reads never enqueue. Interest is deduplicated
globally, including negative discovery results, for six hours. A later search
can find new counterparts. Existing approved links have a separate bounded
revalidation cursor. Demand records expire after 24 hours and inactive interest
after seven days; matching evidence remains protected by market retention.

## One runtime policy

The `market_matching` key uses the existing versioned `runtime_policies` store
and admin API:

- GET/POST `/admin/intel/policies/market_matching`, with existing intel permissions,
  creator attribution, effective dates and policy history.
- Admin UI: App → Arbitrage → **Jev Market Matching**, existing JSON policy editor.
- The shared strict schema is `packages/shared/src/market-matching-policy.ts`.
  Unknown fields, invalid types and incompatible limits are rejected. Publishing
  stores a complete validated snapshot; a new override replaces the previous one.
- Worker and API use the same sidecar-safe parser. There is no API-wide env import.
  Invalid stored policies stop matching; they never silently select AGG.
- Policy changes apply on the next operation without restarting services. The UI
  reads `/matching/config` every 30 seconds; the server remains authoritative.
  The public endpoint exposes availability/source only, not budget or internals.

The independent `venue_lifecycle` policy remains mandatory: discovery capability
and full indexing are required in addition to a supported, policy-selected venue.
Selecting a venue in matching cannot override its lifecycle restriction.

| Operational control                                  | Default                                          | Release-owned ceiling/floor                  |
| ---------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Worker, lazy, each consumer                          | disabled                                         | boolean                                      |
| Daily dollars / provider requests, including retries | $1 / 5,000                                       | finite nonnegative budget / 100,000 requests |
| Lazy dollars / requests                              | 20% / 200                                        | 20% / 200                                    |
| Concurrent inference per worker / timeout / attempts | 2 / 15s / 3                                      | 3 / 15s / 3                                  |
| Seed allocation / interval                           | 75 trending + 75 Limitless + 150 product / 15min | 1,000 total / at least 1min                  |
| Event / contract candidates per seed                 | 2 / 3                                            | 5 / 10                                       |
| Pending / stored interest                            | 500 / 5,000                                      | 500 / 5,000                                  |
| Lazy pending / stored interest                       | 100 / 1,000                                      | 100 / 1,000                                  |
| Inference backlog / lazy backlog                     | 2,000 / 400                                      | 2,000 / 400                                  |
| New markets per actor, rolling hour / day            | 5 / 20                                           | 5 / 20                                       |
| HTTP requests per minute: IP / actor / global        | 30 / 10 / 100                                    | 30 / 10 / 100                                |
| Event and contract probability / confidence          | .95 / .90                                        | cannot lower below .95 / .90                 |

Warm volume filters, retrieval bounds/context overlap, cooldown and revalidation
cadence are also policy fields. SQL timeouts, lease durations, the 90KB request
bound, $0.01 reservation, normalization rules, model pin and prompt implementation
remain code-owned safety/semantic invariants, not arbitrary admin knobs.

`MATCHING_*_ENABLED=false` remains an emergency environment stop; `true` cannot
bypass a disabled policy. `MATCHING_DAILY_BUDGET_USD`, when present, can only
reduce the policy budget. Old frontend `NEXT_PUBLIC_MATCHING_*` switches are no
longer required. Consumer fields are `alternativesEnabled`, `eventsEnabled`,
`clustersEnabled`, `telegramEnabled`, `signalsEnabled`, and `agentsEnabled`.
Turning a consumer off explicitly selects its legacy source where one exists;
a selected native source never falls back to AGG on errors or missing links.
Agent clients use `agentClusterSource` from `/matching/config` by default, and
explicit `--source agg` remains a rollback choice. Native agent requests carry
`consumer=agents`; their enable policy is independent from the app cluster flag.

An example initial shadow override (not applied anywhere):

```json
{
  "workerEnabled": true,
  "dailyBudgetUsd": 1,
  "warmTrendingCount": 25,
  "warmLimitlessCount": 25
}
```

All unspecified consumers and lazy demand remain disabled. Worker pause preserves
existing evidence. Budget changes do not invalidate or rebill evaluated pairs.
Changes to approval thresholds, prompt or pinned model change the approval
revision: old evidence is hidden and bounded revalidation creates new jobs.
Each evaluation records its policy snapshot, prompt version, model, costs and
original request/response. In-flight publication rejects a worker stop or changed
approval revision. Backpressure waits without consuming a discovery retry.
Catalog close/expiration/event-end dates participate in fingerprints even when
both versions remain ACTIVE; prices and volumes do not. Catalog timestamps do
not replace the actual settlement deadlines in the rules.

## Approval and spending safety

Automatic contract approval requires identical normalized rules and bound event context,
unambiguous selected claims and stable outcome identities, active contracts,
no unresolved parent/external rules, the pinned returned model, and all applicable
probability/confidence gates. URL/clock presentation whitespace is normalized;
punctuation, numbers, deadlines, source URLs and operators survive cleaning. An
explicit single-slot event template plus the original question can bind a flat
market to a grouped child; generic matching questions cannot erase event context.
Unanchored market-creation windows remain in review.
The binary relation gate cannot be bypassed by confident outcome answers.
Named outcomes require explicit individual evidence; their whole-market relation
alone is not enough. Inverse and differing rule wording stay in review.

Global PostgreSQL reservations enforce daily budgets across worker instances.
Each inference reserves $0.01, settles the returned actual cost, and conservatively
charges uncertain failures. Crash reservations remain held for their UTC day.
Budget exhaustion postpones work without consuming attempts. Lazy traffic cannot
borrow the warm allocation. Redis rate-limit failures reject demand.

Unexpected returned model or cost above the reservation persists a halt. These
halts need an explicit reviewed operational reset, not a routine policy toggle.
A provider-side key spending cap is still appropriate at rollout because an
application reservation cannot guarantee an unexpected provider price change.
No provider account setting was changed here.

## Commands and packaging

Build shared/workspace dependencies before the matcher and worker. The application
Dockerfile now includes both new package manifests before its frozen install.
The worker is deliberately not added to production Compose or a schedule in this
local-only delivery. Starting a process and enabling a policy are separate actions.
The entrypoint works with the existing `run-with-secrets` bootstrap; its required
runtime credentials are DATABASE_URL and OPENROUTER_API_KEY, not API wallet keys.

```sh
pnpm -F @hunch/market-matching build
pnpm -F market-matcher build
# Explicitly select a disposable local DATABASE_URL for local runs.
node apps/market-matcher/dist/main.js status
node apps/market-matcher/dist/main.js report
node apps/market-matcher/dist/main.js scan      # bounded discovery; no inference
node apps/market-matcher/dist/main.js run-once
node apps/market-matcher/dist/main.js run
```

`status` includes effective policy, approval revision, queue, current UTC budget
and drift halts. `run` polls policy while disabled, so later policy activation
needs no restart. `scan` is a bounded warm/discovery operation, not a catalog scan.

Migration 0261 creates empty tables, without legacy-data assertions/backfills.
It and changed SQL are tested on disposable PostgreSQL 16. Matching snapshots,
event children and demand references are protected in retention selection,
delete rechecks, derived reports and foreign keys. Evidence deletion is not
silently introduced by this feature.

## Validation and rollout boundary

See [SCALE-VALIDATION.md](SCALE-VALIDATION.md) for the 1,000-market experiments and
[AGG-DISAGREEMENTS.md](AGG-DISAGREEMENTS.md) for the comparator disagreements.
See [CALIBRATION.md](CALIBRATION.md) for the frozen prompt comparison, held-out
results and limitations; [REVIEW.md](REVIEW.md) for checks and review scope;
[ROLLOUT.md](ROLLOUT.md) for deployment, activation and rollback instructions.

Prices use native quotes and remain separate from link state. Execution still
requires native direction, freshness, fee, depth and availability checks. Existing
YES/NO instruments are supported; named instruments without an execution adapter
remain informational. Missing quotes do not erase matching evidence.

A future rollout starts with the worker in shadow mode, then reviewed consumers,
then lazy demand. No production schedule, migration, user switch or AGG-secret
removal is part of this delivery. Catalog-wide recall, production load and
independent settlement adjudication are not established by this local calibration.
