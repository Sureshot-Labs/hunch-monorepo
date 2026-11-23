# Holder signal quality: readout and release checks

The October–November 2026 audit is exploratory. Its results are not thresholds, financial advice or proof of trader skill.

## What changed

- Triage can defer an already delivered thesis before the paid external search and final synthesis. It must name the exact public note. Unknown history, a possible change in side, new dated evidence, material quote movement on the same contract, or observed position changes send it back into normal investigation. The defer is not a permanent cache entry.
- The final prompt sees the last delivered side, time and frozen ask next to the proposed side and fresh ask. It distinguishes a new direction, an update, and context. This changes neither execution checks nor the rule for independently verified evidence on a public reversal.
- Single-match signals can enter ordinary ranking without a cluster only if the selected-side primary holder meets the existing strict single-trader requirements and has sufficient positive outcome edge in a recognized sport segment. Before ranking, enrich a shortlist bounded by the existing candidate budget. Missing specialization and the miscellaneous sports segment do not qualify. Final and commit checks require an explicit citation of the qualifying holder. Fresh price, horizon, budget, and other existing gates still apply. `sports_specialist_selection` logs the number selected for the usual research path; it is not a publish count.
- `candidateFunnel.editorialDeferredBeforeSearch` and `editorialRepeatReopened` count early decisions. Existing log totals still carry late duplicates and charged costs. Early defer counts are not billed costs or savings.

## Read-only scorecard

```sh
pnpm -F api ai:holder-research:audit --scorecard --lookback-days=30 --limit=1000
```

Only confirmed Telegram initial receipts count; X drafts and follow-ups never count as forecast outcomes. Binary wins and losses share one denominator; unknown, open and partial payouts are unscored for hit rate. Settled gross ROI uses an equal hypothetical $1 per known outcome with a valid frozen ask. Event weighting reduces repeated-contract dependence but does not de-correlate events from one election campaign. For campaign analysis group known related events manually and keep unfamiliar mappings unknown. The report uses retained catalog identity; deletions can make the historical delivery ledger larger than the evaluable cohort. Check `truncated` before comparing periods.

The Polymarket +4h and +24h probes use the exact side token and the last complete two-sided minute in a 10-minute window. Coverage is explicit: elapsed horizon, valid entry, probed count, already observed settlement, and measured bid. The minute average is not an executable exit. Missing history, ambiguous binding, and missing entry are not zero returns. Nothing is persisted by the scorecard.

## How to evaluate the release

1. Before looking at results, choose two nonoverlapping weekly enrollment windows, record the code/prompt revision, and use only observations made in each window. Report settlement coverage after a common maturity cutoff. Match against the previous ordinary selection on venue, category, price band and time to close; use one observation per market/side per event episode and show event-weighted results. Do not recruit candidates after seeing outcomes.
2. Compare at the same candidate, model and publishing capacity. Grade editorial novelty blind to the result: precise contract/stage, checkable new fact or observed change, price relevance, best contrary evidence, and whether an update is more useful than another stand-alone alert. Include the 18 measurable explicit historical refusals and similar examples that were correctly held back, but keep this replay separate from the forward evaluation.
3. Before expanding beyond the narrow specialist exception, check whether event-weighted, priced improvement has the same sign in both weekly windows, survives +1¢ and removal of the strongest event or holder, and is not explained by quote/outcome coverage. Report counts and uncertainty.
4. For cost, sum charged run components and late duplicate attribution over each window, and divide total cost by confirmed new delivered ideas from the same runs, not by recommendations, notes, or updates. Check recovered changes in side/news against the pre-change rate. A reduction in paid work without improved outcomes supports an efficiency claim only, not an alpha claim.

No schema, retention, periodic jobs, numerical thresholds or Telegram win/loss subscriptions are changed by this patch.
