# 1,000-market validation — September 20, 2026

Production access was read-only: bounded API reads and PostgreSQL `BEGIN READ ONLY`
with statement timeouts. Matching tables, policies, queues, schedules and prices
were not changed in production. Jev inference was authorized, bounded separately
and recorded locally. Full raw evidence is under `untracked/`; compact summaries
and selected regression cases are in `fixtures/`.

## Selection, retrieval and fixed-cohort refinement

| Measurement                       | Initial capture | Candidate-selection fix |   Normalization fix | Final source-link fix |
| --------------------------------- | --------------: | ----------------------: | ------------------: | --------------------: |
| Seed markets                      |           1,000 |                   1,000 |          same 1,000 |            same 1,000 |
| Poly / Limitless                  |       828 / 172 |               827 / 173 |                same |                  same |
| Seeds finding contract candidates |             255 |                     313 | fixed candidate set |   fixed candidate set |
| Unique event pairs                |             108 |                     109 |                 109 |                   109 |
| Unique contract pairs             |             213 |                     271 |                 271 |                   271 |
| Approved event links              |              58 |                      59 |                  59 |                    61 |
| Approved contract links           |              69 |                      62 |                  86 |                    92 |
| New paid requests                 |             321 |                      73 |                  26 |                   109 |
| Incremental provider charge       |    $0.025950624 |            $0.004928952 |        $0.002366742 |          $0.009598974 |
| Cost if every pair were new       |    $0.025950624 |            $0.029709876 |        $0.030535428 |          $0.030536310 |

The candidate fix recognizes feed records containing venue plus short market ID,
round-robins trending/movers quotas, and adds bounded indexed retrieval for flat
questions versus grouped children. The first capture's feed extractor missed those
short IDs; map, whales and DB-ranked seeds still supplied that initial cohort.
The two captures are not identical samples: 69 → 62 is not an accuracy regression
estimate. Both later comparisons use the fixed 380-pair cohort. Independent review
found HTML anchor destinations were lost from rules. Read-only rule recapture for
1,209 recorded contracts and 198 events found anchors in 136 markets/eight events;
the corrected extraction changed 116 market rule sets/seven event rule sets and
109 inference payloads. Those were evaluated once; 271 exact payloads were reused.
This repairs evidence for the recorded cohort, not a fresh current-catalog scan.

Final approval: 92 contract links across 42 event groups, with 171 explicit outcome
mappings. 79 links have both binary sides verified; 13 have only one verified side
and therefore do not receive the current complete-binary execution adapter. Named
outcome support is separately exercised by the labelled calibration fixtures.
Event coverage is computed from current child links, not from Jev's event answer.

All 380 recorded final responses were replayed through actual local PostgreSQL 16
versions, queue, leases, publication and resolver. Results: 153 approved evaluations
(92 contract + 61 event), 227 review; all 92 approved contract links resolved.
Replay made zero external inference calls. Initial 321 and intermediate 380
responses were also replayed independently. Exact inference payload hashes were
checked, so changed requests could not silently reuse an unrelated answer.

## Comparison and quality limits

The AGG response had 83 open Limitless rows. 31 Poly/Limitless pairs intersected the
seed cohort. Our indexed retrieval recovered 23 initially, then 26. Final strict
approval accepts ten of those pairs and 82 pairs absent from that AGG sample.
This is **not** evidence that all 82 are absent from AGG globally or that our
overall coverage/precision is better. See [AGG-DISAGREEMENTS.md](AGG-DISAGREEMENTS.md)
for actual rule differences, our false-negative mechanisms and stale counterparts.

Developer inspection grouped repeated child markets by event to avoid pretending
correlated child approvals were independent quality observations. No incorrect
approval was identified in the inspected supplied rules, but there is no
independent venue/oracle adjudication or defensible catalog-wide precision bound.
The normalization round intentionally removed one former approval: identical rules
referencing market creation did not establish a common start time. The later
href-preserving recheck added ten contracts and removed four on the unchanged model
gate. Probability shifts on changed inputs are not evidence of improved precision.
No thresholds were lowered or weak unchanged requests rerolled to gain approval.

There were 13 `related` event decisions and **zero** met .95 probability/.90
confidence. Optional similar-market boosting is tested but its live utility is
unproven; it stays disabled. `different` and uncertain contracts do not become
recommendations. The original development/holdout and named-outcome experiment
results remain separately reported in [CALIBRATION.md](CALIBRATION.md).

## Cost and reasonable defaults

The scale/refinement experiments used **529 paid requests for $0.042845292**.
Together with the earlier 172-request prompt calibration: **701 requests,
$0.053608716**. This total excludes older exploratory work documented separately.
Costs are returned provider usage, not a token-price assumption or OpenRouter
balance estimate. All responses returned the expected pinned model.

The final cold-cohort mean is about **$0.00008036/request**: roughly **$0.080 per
1,000** or **$0.40 per 5,000** at this payload mix. A dollar corresponds to about
12,400 such requests, not a guaranteed quota. Payload length, retries, failures
and provider pricing can change this. A 1,000-seed pass needed 380 unique pair
checks, not 1,000 inferences or the full market catalog.

Recommended defaults: $1/day; a separate 5,000-attempt/day traffic guard; concurrency
2; at most 2 event + 3 contract candidates per seed; 100 allocated seed slots every
15 minutes; global six-hour discovery cooldown and version-based inference reuse.
Lazy stays off initially, with 200/day and at most 20% budget when enabled. Budgets
above $2 are allowed through policy. No data justifies a hard $2 ceiling.

Unchanged pairs do not rebill on every selection cycle. We have not measured a
24-hour production churn trace, so a precise steady-state daily bill is unknown.
The dollar reservation limit remains authoritative even if the request guard is
raised. The pessimistic no-reuse maximum is capped; the selector does not promise
that every requested market gets inferred immediately.

## SQL and quotes

Production retrieval completed 5,465 bounded reads in the corrected capture.
Twelve `EXPLAIN (ANALYZE, BUFFERS)` samples used the existing primary full-text
GIN indexes; execution times ranged **0.219–8.434 ms**. This is a small indexed-query
sample, not a full API latency/load benchmark. SSH wall time is not DB execution
time. No new full-catalog scan or automatic event-child fanout was introduced.
The native cluster reader now batches link validation, snapshots, summaries and
quotes: a local integration assertion bounds a page to nine DB reads before any
eligible orderbook verification work, rather than one resolver call per link.

The price audit preceded the source-link correction and read actual native tops
for **172 markets** across that round's 86 approved pairs. Limitless: 86 fresh YES /
85 fresh NO; Polymarket: 2 fresh YES/NO,
84 stale at that instant. All were marked orderable in native catalog state, which
does not itself imply a fresh executable quote. Eight actual API resolver responses
using local links plus read-only production tops retained matches and marked stale
offers nonfresh. Missing prices did not manufacture NO prices or delete links.

API alternatives, matched clusters and Telegram search hand visible IDs to the
existing refresh/hot-token path. Signal delivery runs its own freshness/readiness
guard and can defer for refresh. Browser alternatives poll every 15 seconds even
when the cached response is AGG, so open views observe a policy switch;
native arbitrage every 30 seconds while visible. Local tests verify subsequent
changed prices, stale/missing sides and refresh handoff. Production refresh was
not triggered, so a live end-to-end refresh after deployment remains a shadow
acceptance check, not something established by this read-only audit.

## Reproducibility artifacts

- `fixtures/scale-summary.json`: machine-readable counts and costs.
- `fixtures/normalization-regressions.json`: five selected captured regressions,
  explicitly not an independent holdout.
- `untracked/matching-scale-20260920/`: initial capture, AGG response/comparison,
  SQL plans, provider replies, local replay and first price audit.
- `untracked/matching-scale-candidate-20260920/`: corrected selection/retrieval,
  replies with exact-request reuse and local replay.
- `untracked/matching-normalization-20260920/`: earlier fixed-cohort plan,
  replies, replay and native price audit.
- `untracked/matching-source-links-final-20260920/`: read-only raw rule recapture,
  corrected normalized capture, fixed request plan, final responses and PG16 replay.

The local delivery is suitable for review and a disabled rollout followed by
bounded shadow operation. **Blanket replacement of AGG without coverage loss is
not established.** Native errors never silently fall back to AGG; rollback is an
explicit policy change. Deployment steps are in [ROLLOUT.md](ROLLOUT.md).
