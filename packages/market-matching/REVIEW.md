# Jev matching v1 — local review, 2026-09-20

All changes are local on `jev-matching` in backend, frontend, admin and public
agent tools. No commits, pushes, deployments, production writes, schedule or venue
policy changes. All new features default off. This is readiness for a disabled
rollout and bounded shadow acceptance; unrestricted replacement of AGG with no
coverage loss has not been demonstrated.

## Evidence

The corrected 1,000-market production sample contains 827 Polymarket and 173
Limitless markets. Retrieval admitted 271 contract and 109 event pairs. The final
fixed-cohort source-link recheck approved 92 contract links / 171 explicit outcome
mappings and 61 event links. All 380 decisions replayed through real local
PostgreSQL 16 queue, publication and resolver; every approved contract resolved.
Of the 92 links, 79 map both binary sides and 13 only one outcome. Matching is
separate from execution.

AGG comparison: 26/31 supplied pairs retrieved, 10 auto-approved. AGG is not gold.
Formatting/context-binding defects were fixed; semantic wording differences,
ambiguous parent rules and model thresholds still reduce automatic coverage.
See [AGG-DISAGREEMENTS.md](AGG-DISAGREEMENTS.md).

Earlier prompt calibration and scale/refinement used 701 paid calls costing
$0.053608716. Cold evaluation of the final 380 pairs costs $0.030536310. Default
$1/day and 5,000 attempts/day are independent controls; there is no $2 ceiling.
No representative 24-hour churn measurement or independent production precision/
recall label set exists. Selected regressions are not a holdout.

Read-only native quote audit on the earlier 86-pair round: 172 linked markets;
Limitless 86 fresh YES / 85 NO,
Polymarket 2 fresh both / 84 stale at capture. Eight real-data API service reads
retained links while withholding stale prices. Local tests prove refresh handoff
and subsequent updates; production refresh was not triggered.

Counts, SQL plans and raw artifact paths: [SCALE-VALIDATION.md](SCALE-VALIDATION.md)
and [CALIBRATION.md](CALIBRATION.md).

## Consumer review

| Consumer                           | Policy switch                  | Checked behavior                                                                                                                                                          |
| ---------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API / desktop and mobile Smart Buy | alternativesEnabled            | Explicit mapping and fresh executable offers; refresh handoff; 15-second visible polling; target action uses offer nativeOutcome, including YES→NO.                       |
| Event API                          | eventsEnabled                  | Current versions, verified child links, full/partial coverage, bounded child-link batch. Frontend typed helper exists; no dedicated event comparison panel was added.     |
| Arbitrage API / desktop and mobile | clustersEnabled                | Bounded 100-link candidate page, batched summaries/quotes, explicit outcome links, native fee/depth verification, refresh handoff and 30-second visible polling.          |
| Telegram search                    | telegramEnabled                | Native branch precedes AGG construction; refresh handoff; legacy YES-price picker excludes inverted/partial mappings; cards show their own native outcomes.               |
| Signal bot                         | signalsEnabled                 | Mapped-side readiness/refresh deferral, destination lifecycle/capabilities; no AGG call on native empty/error responses.                                                  |
| MCP / CLI                          | agentsEnabled                  | Independent source; market/event alternatives and clusters; compact output retains outcome IDs/direction, executable offers and pagination. GET never queues Jev.         |
| Similar markets                    | similarEnabled                 | Up to three existing embedding candidates promoted, no new inference or changed membership/scores. Zero qualifying live related decisions; utility unproven, default off. |
| Admin                              | existing runtime policy editor | Shared validated defaults, complete snapshots/history, separate flags/budget.                                                                                             |

Native errors never silently fall back to AGG. Rollback is an explicit policy
change. Existing price refresh, quote/execution and retention systems are reused;
the API cache warmer and embeddings worker are unchanged.

## Inverse, same venue and extension limits

Inverse model decisions are saved for review and never auto-approved in v1.
Cancellation/tie/split settlement must also be complements. Tests seed explicit
inverse outcome mappings to test consumers independently of model approval; this
is not live inverse calibration or a manual approval workflow.

sameVenueEnabled defaults false. Opt-in bounded discovery/queue admits distinct
same-venue markets under the same budget/strict gates. It is checked before
inference, publication and reads; disabling hides links without deleting history.
Controlled PG16 tests cover it; the live sample remains cross-venue. Smart Buy has
one row per venue and does not surface intra-venue alternatives. Arbitrage defaults
to two venues and its live verifier excludes same-venue bundles. API/MCP links can
be inspected without claiming unsupported execution coverage.

The shared validated venue registry drives policy, eligibility and product IDs.
A new venue needs validated unified metadata/stable outcomes, native quote and
execution adapters, lifecycle support and fixtures/calibration. It does not require
rewriting queue, budgets, Jev requests or storage. Policy alone cannot implement an
adapter. See [ROLLOUT.md](ROLLOUT.md).

## Final checks and independent review

- Matching/API/Telegram: 65/65, actual migration 0261 and queue/retrieval/publication/resolver/
  retention SQL on disposable PostgreSQL 16.2. Fresh isolated schema per run.
- Signal bot: 265 assertions; Telegram search: 20; native Telegram route test;
  cluster execution: 11; existing alternatives routes: 9; refresh queue: 23.
- Frontend: 13 arbitrage/source/Smart Buy tests, TypeScript and production webpack
  build passed, including native-direction changes. Build retains existing optional
  dependency warnings from Privy/viem; types are checked separately.
- Public agent tools: 50 tests, TypeScript build and scoped lint.
- Shared, matcher, worker and API TypeScript; scoped backend/frontend lint;
  admin TypeScript/build/lint. No full workspace suite or new image build.

Three independent reviewers were started without conversation history after the
implementation. They reported one P1 and six P2 findings, all fixed and re-reviewed:

| Severity | Finding                                                      | Correction and evidence                                                                                                                                                                |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | HTML cleanup discarded settlement-source URLs                | Preserve actual href destinations, including malformed/quoted-attribute edge cases; invalidate prior evidence revision; unit regressions and 109 changed real-data requests rechecked. |
| P2       | Trusted selection could leave work trapped in the lazy quota | Promote existing queued work before cooldown/capacity checks, preserving backoff/attempts and running leases; PG16 full-queue/cooldown regressions.                                    |
| P2       | Retention omitted historical contract event references       | Protect historical event_id alongside market_id; PG16 market-move regression.                                                                                                          |
| P2       | Reducing retry limits stranded queued jobs                   | Retire exhausted queued and expired-running jobs during claim; PG16 regression.                                                                                                        |
| P2       | Agent alternatives followed the app consumer flag            | Explicit consumer=agents routing and request tests.                                                                                                                                    |
| P2       | Legacy Telegram picker could compare the wrong inverse side  | Admit identity YES mappings only in that picker; no silent direction conversion; route tests.                                                                                          |
| P2       | A cached AGG response never observed a source switch         | Poll visible alternatives every 15 seconds regardless of cached source; frontend regression.                                                                                           |

No remaining P0–P3 findings were reported in those reviews. Follow-up reviewers
confirmed their scoped fixes; they did not independently repeat paid calibration
or PG16 integration. Those were run by the primary agent. This is scoped review,
not a claim that unobserved defects cannot exist.

Deterministic duplication audit of 16 core runtime files (3,171 source lines,
19,622 tokens), excluding tests, with 60-token/5-line thresholds: Type 1 has zero
clones; Type 2 coverage 1.86% (59 lines), redundancy 0.95% (30 lines). Two within-file
classes are intentional policy fields and symmetric event coverage checks; no
cross-file clone met the threshold. This is structural analysis, not proof of
semantic equivalence or the absence of every possible duplication.

Provider/readiness tests use mocks where stated; they do not prove production
execution. Production startup/supervision, refresh latency and day-long budget/
coverage observation remain deployment-stage acceptance checks. No production
actions are part of this local delivery.
