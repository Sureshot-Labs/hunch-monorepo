# Funding recovery: state classification and repair plan

## Scope

Production inspection is read-only. Baseline backend: `ce454039`.
This plan does not authorize production writes, replay, signing or new trades.
The new patch changes the reconciliation stop path and late receive-session
handling; no migration,
new queue, scheduled sweep or frontend implementation is introduced.

## What is actually unresolved

| Record/group                           | Evidence and interpretation                                                                                                                   | Required handling                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `9483d00f-aa04-4999-ba2c-4bb4bdb4609d` | Current pure projector returns terminal `failed`; stored cache remains recovery. Partial Polygon preparation succeeded, Buy did not complete. | Refresh through the reducer after fresh evidence preflight; preserve partial movement.                 |
| `0d3e5f56-7945-4d09-9217-893aa24b1088` | Destination credit is persisted; old source receipt mismatch prevents completion. Current verifier accepts the source transaction.            | Replace the stale source evidence through the evidence repository, then reduce.                        |
| `9a7e3edd-44c4-4a4c-b459-829a76b85fc5` | Redeem actually paid out; submission reference was lost from the journal.                                                                     | Attach the verified late reference and reconcile the same action.                                      |
| 11 preparation runs                    | All succeeded after the previous deployment.                                                                                                  | No repair or repeat approval.                                                                          |
| 44 recovery receive receipts           | All have `lateReceipt=true`, expired sessions, no child routing operation.                                                                    | Do not reroute under expired consent; these are received funds requiring review, not 44 pending sends. |
| 15 review receipts                     | Two policy-limit cases and 13 child-failed-before-broadcast review cases.                                                                     | Retain explicit user review; do not automatically resume old intent.                                   |
| 11 other recovery receipts             | Four failed children, two invalid quote plans, five routing errors.                                                                           | Inspect exact child/source evidence individually; no blanket terminal success.                         |
| 7 observed receipts                    | All Telegram, zero routing attempts; six expired sessions, one processing session with 2 raw Base USDC.                                       | Check consent/admission, not Relay settlement. Dust is $0.000002, not an ongoing large transfer.       |

At the read-only snapshot: funding jobs completed 179/dead-letter 5, no
scheduled/leased jobs; funding operations completed 131/failed 22/cancelled
29/recovery 2. Earlier verified active balance reservations: zero. Recheck this
immediately before any repair; counts are not a transactional live guarantee.

## State-machine ownership

- An unstarted, expired action can end safely only through the existing
  no-broadcast checks. Expiry does not prove a submitted transaction failed.
- A known pending transaction belongs to receipt reconciliation, not execution
  replay. Canonical failure, success or refund determines the terminal outcome.
- A missing reference after claim is manual uncertainty. Stop fruitless polling
  but accept a late positive report; never automatically send again.
- A stopped reconciliation job must publish manual recovery when the outcome is
  still unknown. If facts already prove a terminal outcome, materialize it and
  finish accounting rather than retaining an old recovery cache.
- Receive-session expiry ends the receive/consent window, not ownership of funds
  already received. Receipt review is an intentional nonterminal user decision.
- A terminal child and a terminal parent are different facts. Keep the receipt's
  child linkage and exact effects; do not label a failed conversion a refund.

## Targeted code correction

`markFundingOperationRecoveryRequiredInTransaction` wrote an incident, derived
the lifecycle, then returned without materializing it whenever the result was
not `recovery_required`. Evidence arriving during the final poll could therefore
leave a stopped job with stale public state and reservation accounting.

For a proven terminal lifecycle only, call the existing transactional reducer.
Do not run it through this branch for `ready` or other nonterminal outcomes.
This reuses ordinary accounting and does not resume a historical consumer.
The job's dead-letter diagnostic is retained; it is not itself financial status.

Regression: final receipt verification fails at the stop boundary while exact
source/destination observations arrive in the same poll. Assert completed cache
and zero active reservations. The existing unknown-outcome test must still
produce manual recovery. Both execute against disposable PostgreSQL 16.

## Exact historical repairs, separately approved

Use a bounded transaction and original immutable action/attempt identities.
Recheck expected versions and the absence of live consumers/new attempts under
the operation lock. Default to rollback in a disposable production-shaped fixture.
Do not mass-update `status`, fabricate receipts or overwrite newer evidence.

### Partial preparation: 9483d00f

1. Recheck Polygon transaction
   `0x378b0acb4fead1720b448b6e87252dd8ebca5e89f684046f7f75c52e371373fb`:
   exact 300000 pUSD internal preparation; preserve its readiness observation.
2. Recheck Relay has no input/output hash for the failed Solana leg and latest
   finalized signer history covers the attempt interval. Previously the newest
   signer transaction predated the operation. Generic client failure alone is
   not the absence proof.
3. Pin operation version 959 if unchanged, steps and attempts. Current read-only
   projection already returns `failed`, terminal, no linked consumer.
4. Run only `reduceFundingOperationInTransaction`; assert terminal `failed`,
   no active reservations/new attempts and unchanged readiness evidence.
5. Close the old job administratively only after terminal verification, retaining
   its historical error. Do not requeue it or resend the Solana leg.

### Canonical source correction: 0d3e5f56

1. Recheck source Base transaction
   `0x854367752d35119dd2281060e64c5095238cd90b65ec93845273dd2c4b520cfc`.
   Current exact-action verifier accepts 4862963 USDC source debit, log 707.
2. Recheck Polygon destination transaction
   `0xa576aa45839ab95dbaee6f508818775395c170d89b23c6bb86f8136895823fb6`:
   4813091 pUSD to `0x2dFcaa5734CA03B3917eAcCb32f9B75c7675781A`.
   This destination observation already exists; do not insert it twice.
3. Pin version 9 if unchanged, step
   `25507c48-0ffe-4f6c-8a23-0884edb7c791`, attempt and action fingerprint.
4. Apply canonical source evidence through the existing evidence repository;
   allocate source debit idempotently with original block time and event index.
   Using repair time would distort balance suppression.
5. Reduce and assert the terminal result in the disposable fixture before apply.
   No new trade/consumer reservation may be created; stop if current consumer
   facts make the result `ready` rather than the intended historical settlement.

### Redeem reference recovery: 9a7e3edd

The user's original Privy reference
`privy-transaction-v1:d0498c04-5dec-482d-90e6-e2196cf34f5b` now resolves to
`0xdc8f3de19e942f6efcc0256345f6c722eb5020078b8d361908777b5a5e4d2a77`.

Read-only Base inspection found canonical block 50893306, successful receipt,
exact committed redemption calldata in the sponsored UserOperation, ERC1155
burn at log 296, 2628726 USDC payout at log 297 and redemption event at log 298.
Owner: `0x17Cac6E4b08C8D95A2890a8DF7Cb0e7d83711387`.
Condition: `0xf2df88d1c1580259bb2258f375e4941c76fa31ec718bbcf980ec655fa9eafeb5`.

1. Revalidate through the existing venue receipt verifier against the persisted
   plan, not merely the successful bundler receipt. Check no competing action
   already consumed this exact evidence.
2. Pin original attempt number, owner binding, digest and missing-reference state.
3. Use `recordPositionActionSubmission`'s existing late-positive-report path.
   It explicitly accepts this missing-reference recovery state; no direct SQL
   state rewrite or new claim is needed.
4. Let receipt/postcondition reconciliation complete that same operation and
   its idempotent effects. It must not submit a redemption transaction.
5. Assert completed operation, successful receipt, satisfied postconditions and
   no duplicate effects. Historical notification handling requires a deliberate
   choice before running effects; do not silently send misleading fresh notices.

## Remaining limits

All seven observed Telegram receipts were checked for their exact variant:
each has a Telegram context and arrived within its window, but **none has a
consent containing that receipt variant**. This explains zero routing attempts
without assuming a stalled Relay request. Do not bypass this admission check.
Their generic `observed`/`processing` presentation needs a separately agreed
review action; it is not proof that conversion was authorized or submitted.

The eleven non-late recovery receipts have since been individually checked;
see [the receive audit](receive-recovery-audit-2026-09-08.md). All incoming
transfers are canonical, no unresolved outgoing child was found, and the old
scenarios may be closed without claiming conversion success. No historical
repair was applied. Keep the seven observed receipts out of a blind bulk repair.
No new dust threshold, expired-consent bypass or automatic rediscovery sweep is
justified by this classification alone. A manual state is valid when additional
evidence or fresh consent is genuinely required; a false promise of automatic
progress is not.

This document is a guarded repair specification, not an executed repair script.
Production has not been changed. Broader legacy bridge/authorization journals
from the earlier audit are not declared resolved by this patch.

## Patch verification

- Late non-direct receipts no longer reopen a terminal receive session. Receipt
  history and genuine ambiguous-child recovery remain intact; no old intent is
  resumed. PostgreSQL 16 receive-session persistence regression passed.
- API unit suites: 195/195 passed; embedded node tests: 82/82 passed.
- Funding persistence integration passed on disposable PostgreSQL 16.2,
  including the new stop-boundary settlement case and existing manual case.
- API typecheck and full API ESLint passed.
- No production writes, schema migration, commit, push or deployment.
