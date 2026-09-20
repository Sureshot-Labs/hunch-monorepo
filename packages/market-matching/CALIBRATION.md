# Jev calibration — 2026-09-20

## Decision

The original calibration selected the `evidence` prompt (`matching-evidence-v2`), canonical pair order,
and unchanged .95 probability / .90 confidence floors. Retain exact-rule,
context, activity, parent-conflict, external-rule and outcome-identity guards.
The dedicated `outcomes` prompt variant was rejected. Do not weaken the gates
or retry opposite orientations to obtain a more favorable approval.

This is enough for a conservative local v1 and a future bounded shadow trial.
It does not establish production-wide recall, independently adjudicated
settlement equivalence or readiness to replace AGG for every user.

## Scope and reproducibility

172 real provider requests across seven preplanned runs cost **$0.010763424**.
All returned `typesafe/jev-1.13-20260917`; no transport/shape failures occurred.
Latency: median 357.5ms, p95 599ms, maximum 853ms. This is a small experiment,
not a provider throughput/SLA claim.

The main frozen fixture has 61 cases: 29 real contract pairs from the existing
read-only 2026-09-20 capture and 32 controlled examples. One real pair is unscored.
The development/holdout split joins real pairs sharing event IDs, preventing
those groups from crossing the split. These real records were used in earlier
research, so this is not an entirely unseen benchmark. Controlled examples share
templates and are not independent observations. Labels concern supplied text,
not independently researched venue-wide legal/oracle terms.

A separate post-freeze set has 10 controlled named-outcome cases. No production
reads or writes were needed during this round: captured public market data was
reused locally. The only external requests were the authorized Jev evaluations.

Tracked artifacts:

- `fixtures/calibration-v1.json`: frozen cases, evidence, labels and split.
- `fixtures/calibration-outcomes-v1.json`: separate named-outcome validation.
- `fixtures/calibration-summary.json`: exact per-run counts and costs.
- `fixtures/calibration-replay.json`: nine approved recorded examples for local
  pipeline replay; selected after evaluation, not a new quality benchmark.

Local raw plans/responses and the frozen selection rationale are in
`untracked/matching-calibration-20260920/`. The runner refuses to overwrite a
paid run, validates the fixture/payload hash against a prior plan, enforces a
100-request / $0.25 run bound and stops on errors without automatic retries.

```sh
# From repository root; plans never spend credits.
node --import tsx apps/market-matcher/src/calibrate.ts plan \
  packages/market-matching/fixtures/calibration-v1.json \
  untracked/my-reviewed-run evidence holdout
# With an explicitly supplied OPENROUTER_API_KEY, run the exact reviewed plan:
node --import tsx apps/market-matcher/src/calibrate.ts run \
  packages/market-matching/fixtures/calibration-v1.json \
  untracked/my-reviewed-run evidence holdout
node --import tsx apps/market-matcher/src/calibrate.ts report \
  packages/market-matching/fixtures/calibration-v1.json \
  untracked/my-reviewed-run evidence holdout
```

## Development comparison

All variants saw the same 30 development cases: six events and 24 contracts,
with 43 separately labelled outcome questions. No labels were sent to Jev.

| Prompt                                    | Event agreements | Contract relation agreements | Outcome agreements | Approved contract pairs / wrong | Raw wrong outcome links |
| ----------------------------------------- | ---------------- | ---------------------------- | ------------------ | ------------------------------- | ----------------------- |
| Previous baseline                         | 6/6              | 22/24                        | 43/43              | 0 / 0                           | 0                       |
| Evidence — selected                       | 6/6              | 23/24                        | 42/43              | 5 / 0                           | 1                       |
| Dedicated outcome instructions — rejected | 6/6              | 23/24                        | 38/43              | 3 / 0                           | 5                       |

The selected five approvals include three real pairs and two controlled pairs.
The improvement comes from specifying how supplied selection and parent context
bind the rules, not from discarding parent evidence or lowering thresholds.
The more aggressive outcome instructions increased raw false links; the
production gate rejected them, but this was still an inferior prompt choice.

The baseline's high outcome agreement did not make it useful: low joint
probability/confidence meant it approved no contracts. Measure usefulness after
all gates, not just the model's selected class.

## Frozen validation

The main holdout has six event cases and 25 contract cases, one unscored.

| Orientation              | Event agreements / approved | Contract relation agreements | Outcome agreements | Approved scored contract pairs / wrong |
| ------------------------ | --------------------------- | ---------------------------- | ------------------ | -------------------------------------- |
| Canonical captured order | 6/6 / 2                     | 22/24                        | 34/36              | 5 / 0                                  |
| A/B swapped              | 6/6 / 2                     | 22/24                        | 35/36              | 2 / 0                                  |

Canonical holdout approvals include three real pairs and two controlled pairs.
Together with development, **six captured real contract pairs** passed all gates:
Greenland acquisition, Stripe/PayPal, US Ethereum reserve, the Democratic and
Republican 2028 presidential winner contracts, and Borussia Dortmund champion.
These six pairs span five event groups; they are not six independent legal
adjudications. The selection is enriched with known matches.

Swapping A/B caused all three holdout real approvals to fall below threshold.
This is material order sensitivity. Production fixes order by stable IDs before
creating its deduplicated job, so user navigation direction cannot select a more
favorable answer. Coverage remains conservative and orientation-dependent.

Across the 12 distinct controlled event cases, relation agreement was 12/12,
with four same-event links approved. Related stages, different years/offices,
partial/reordered candidates and unanchored relative events were covered. This
small set does not establish real-catalog event precision.

For the separate named-outcome set:

| Orientation       | Outcome agreements | Raw wrong outcome links | Approved pair mappings / wrong |
| ----------------- | ------------------ | ----------------------- | ------------------------------ |
| Forward           | 9/11               | 1                       | 3 / 0                          |
| Canonical swapped | 8/11               | 3                       | 3 / 0                          |

An approved partial pair is scored using its explicit expected outcome mappings,
not by claiming the whole multi-outcome market equals a child binary contract.
Each direction approved four individual mappings across three pairs. The
remaining cases stayed in review, including rule/source/cancellation differences,
missing material rules or unstable identity. These are synthetic named
instruments; live named-instrument execution coverage is not established.

**No wrong automatic approval was observed against these provisional labels.**
Raw model mistakes remain and are why deterministic guards are retained. The
accepted sample is too small, selected and correlated to claim a production
false-positive rate or a high-precision statistical guarantee.

## Pipeline replay, retrieval and cost

Nine recorded approvals (six real, three named controlled examples in canonical
orientation) are replayed through disposable PostgreSQL 16: normalization,
version snapshots, deduplicated queue, budget reservation, publication, explicit
outcome links and resolver. Tests require the provider input and questions to
match the recorded request exactly. Responses are replayed unchanged, never
fabricated by swapping A/B. A rule mutation must then hide every stored link.
These integration tests make no paid call and do not count as extra calibration
observations.

Decision fixtures do not measure retrieval recall. The earlier bounded
read-only retrieval experiment found 20/20 known active positive pairs, but it
was a selected sample and is not catalog recall. Its report remains at
`untracked/matching-selection-20260920/REPORT.md`. There is no new full-catalog
scan or production load claim in this round.

Observed averages: contract request $0.00007076 (maximum $0.000122682); event
request $0.000023835. At this mix, 1,000 contract requests are about $0.071,
excluding future pricing changes and uncertain/retried calls. The default
runtime limits are now $1 and 5,000 provider requests per UTC day, with a
separate 20% lazy budget. Only new candidate/version decisions consume inference;
warm reads and cached duplicates do not rebill completed pairs.

## Subsequent fixed-cohort normalization check

See [SCALE-VALIDATION.md](SCALE-VALIDATION.md). This earlier round recorded interpretation
revision `matching-v3` and request revision `matching-evidence-v3`. Instruction
wording and .95/.90 gates are unchanged; explicit flat/group binding adds outcome
questions where an event template proves the selected claim. Cosmetic URL/clock
whitespace no longer blocks otherwise equal rules, while unanchored market-creation
windows are now blocked. 26 changed requests were evaluated; 354 exact request
payloads reused recorded replies. This is a development recheck, not a new holdout.
Five captured diagnostic cases are retained in `fixtures/normalization-regressions.json`.

## Final source-link correction after independent review

Interpretation revision is now `matching-v3-source-links`; product and policy schema
remain v1. HTML anchor destinations are settlement evidence and must survive
normalization. Bounded read-only recapture of rules for the recorded cohort found
anchors in 136 markets and eight events. The corrected extraction changed 109 of
380 exact inference payloads: these were evaluated once for $0.009598974; the other
271 reused identical requests. No thresholds changed. Final results are 92 contract
and 61 event approvals, versus 86/59 before this correction. Ten contracts were
added and four fell below the model gate; more approvals do not prove better accuracy.
This is evidence repair of a development cohort, not a new independent holdout.
