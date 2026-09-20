# Parent evidence audit — September 20, 2026

## Observed failure

The 2028 presidential election event matched across Polymarket and Limitless,
but its candidate contracts were held for review. The market rules were equal;
Polymarket's event description additionally contained an explicit binary
negative branch. Treating every parent/child textual difference as a conflict
both blocked publication and confused the model's evidence comparison.

## Read-only production sample

- Audited 232 persisted contract pairs and their actual inference evidence.
- Read the first 25 events from both `trending_v2` and `change24h` feed rankings.
  These yielded 103 market references before cross-feed deduplication;
  100 unique references had matching-interest records, and 14 audited pairs
  intersected those selections. This is a bounded sample, not a catalog recall
  or precision estimate. A first attempt at 100-event pages timed out.
- 49 pairs included `unresolved_parent_rules`; blocker counts overlap.
- Other failures included real deadline/source differences, unanchored
  creation-time windows, different event context, weak model decisions, and
  named outcomes without an authoritative token/label binding. These remain
  review cases; no array-position mapping or lower confidence threshold is added.

## Change and limits

Parent descriptions that repeat the event title are context rather than a
second settlement rule. The only calendar-title alias recognized is
`in YYYY?` versus `before YYYY+1?`; arbitrary dates are not rewritten.

For binary YES/NO winner templates, a standalone `Otherwise ... No` branch
immediately after the winner statement is redundant only when removing that
exact branch makes the entire parent text equal to a market rule. Every other
source, deadline, exception, numeric operator and punctuation remains intact.
Named outcomes cannot use this exception. Original parent text remains in the
stored snapshot and fingerprint; only inference evidence removes redundancy.

No global prompt/model/approval revision changes. Affected contracts acquire
new fingerprints through their changed blocker set, so unrelated approvals
remain valid. The existing bounded revalidation cursor also visits reviews
with the parent-rule blocker. Exact unchanged job keys stay completed and do
not incur another model call.

## Live calibration

33 inference calls against the captured data cost **$0.00275310**. These calls
did not write production links or queues; the local experiment cap was $0.05.

- The narrow normalization removed the parent blocker in 28 of the 232 pairs.
- Replaying old answers immediately admitted six of those pairs.
- Fresh inference admitted 14 of the 33 calibration pairs: seven election
  candidate pairs and seven price-threshold pairs.
- All seven same-candidate election pairs scored 0.99 probability and 0.98
  confidence. JD Vance had previously scored 0.61/0.49.
- Donald Trump versus Donald Trump Jr. remained rejected.
- Five additional unchanged-parent-conflict controls (Kharg Island and F1)
  remained rejected; mismatched weekly/monthly price windows also stayed out.

This targeted calibration is not an independent estimate of population error.
`fixtures/parent-rule-calibration.json` retains representative positive and
negative provider decisions for deterministic replay. Adversarial unit tests
cover changed year, source, deadline, YES versus NO, split settlement and named
outcomes. PostgreSQL 16 tests cover review recovery and repeated-job idempotence.

## Consumer and rollout behavior

Existing Compare panels retain verified alternatives when prices or liquidity
are unavailable, with no executable link. Lazy/auth gates govern discovery,
not access to known comparisons. Search status distinguishes cached no-match,
pending work, rate limiting and temporary failure within the existing panel.

Production currently runs `hunch-market-matcher` separately from backend
Compose. Pushing API/frontend changes alone does not replace that container.
The matcher must use the updated backend image before its normal revalidation
loop can recover these reviews. No bulk requeue, database rewrite, model
threshold change or runtime budget increase is required.
