# Funding lifecycle refactor trace

## Status

This is the implementation trace for replacing the current overlapping
funding state machines with one deterministic backend lifecycle projector.

It is intentionally a **backend-only** document:

- do not change the frontend, OpenAPI response shapes, or public status
  strings as part of this project;
- historical operations do not need to remain executable under the new
  runtime, but no operation with possible real-world movement may be deleted
  or released without evidence;
- every existing supported flow must retain its behavior; every existing test
  remains in scope, even if an implementation-coupled fixture has to create
  facts rather than a removed status column.

This document is the checklist for the refactor. A trace item is not complete
until its replacement, tests, and reader/writer cutover are all checked off.
Before Changeset 1, a mechanical inventory must enumerate every production
read and write of the removed aggregate fields, plus each caller's side effect
and test. The tables below seed that inventory; the implementation must fail
the changeset if a grep/AST inventory contains an unclassified reader or
writer.

## Stage 1 cutover ledger — in progress

The tables below are the pre-cutover inventory; their historical line numbers
are intentionally retained so each former branch remains traceable. The live
cutover status is:

- Complete: `deriveFundingLifecycle(facts)` is pure and does not read an
  operation, action, or segment projection cache. The common reducer writes
  all three caches only after deriving it.
- Complete: authenticated action start, cancellation/report handling,
  reconciliation, Telegram activation and Router continuation re-derive under
  their normal locks. No production caller invokes
  `transitionFundingOperation*`.
- Complete: receipt polling selects durable broadcast-capable attempt facts,
  not `funding_operations.status` or `funding_operation_steps.state`; a late
  transaction reference therefore remains observable after a stale terminal
  cache.
- Complete: the former 550-line reducer/path-walking lifecycle calculator and
  its implementation-coupled test were removed. Its money/reorg/multi-leg
  cases are covered by `funding-lifecycle-projector-tests`.
- Complete: delegated Router and Relay execution, cleanup, and recovery scan
  immutable authority/reservation/attempt facts, lock a bounded candidate
  set, then use the projector for start/recovery eligibility. Relay
  source-debit allocation likewise trusts its canonical receipt rather than a
  step cache. Integration tests deliberately stale those caches and prove the
  valid action/evidence still progresses.
- Complete: Relay's pre-broadcast decision uses the projector's explicit
  pre-start counterfactual for its own locked attempt. That preserves the
  old safety check without treating `action_required` as authority, while
  keeping concurrent cancellation, authority, receipt/reorg, and sibling
  movement facts visible.
- Complete: verified receive ingress and Relay allowance postconditions write
  source/receipt facts and call the common reducer. There are no remaining
  production writers that directly assign a funding step state other than the
  reducer's projection-cache materializer. Router control-plane rejection
  also checks projector actionability before recording its intentional
  non-broadcast invalid-action fact.
- Complete: reducer reservation release and its finalized-receipt worker hint
  use lifecycle facts plus the projector, not a prior `step.state`. A
  finalized receipt can therefore wake reduction even when a cache write was
  delayed, while a finalized money observation remains mandatory before any
  source reservation can be released.
- Complete: Relay allowance-maintenance, cleanup, and pre-broadcast binding
  use one pure action/attempt-budget helper plus locked projector facts. The
  shared allowance lane is held only by an authorization-reservation lease;
  terminal fact reduction releases it before a later claim. Neither query has
  an operation/step cache predicate.
- Complete: receive receipt routing derives its child operation disposition
  from projector facts. Polymarket handoff attribution and chain-scan
  collision detection likewise use the projector for unbroadcast `started`
  candidates while retaining submitted/ambiguous broadcast candidates. A
  deliberately stale terminal cache cannot hide a potential physical transfer.
- Complete: the unreferenced operation/segment transition APIs and their
  transition maps were removed. The remaining state-key whitelist validates
  public projection shapes only; it cannot choose a next state. The reducer
  returns its fact-derived target to the worker even after cache materialization
  and after consumer-reservation expiry.
- Complete: the shared lifecycle read model is the one boundary used by the
  funding API runtime, Relay receive-link validation, Privy sponsorship,
  Telegram retry/auto-resume/card/delivery selectors, and account
  merge/deletion checks. These readers no longer choose behavior from a stored
  operation, step, or segment aggregate cache.
- Complete: Relay-output deposit classification, Telegram receive-session
  liveness, and Telegram Buy cancellation now use that same factual boundary.
  A stale terminal cache cannot reclassify a proven Relay output as an
  unrelated wallet deposit, close an observed/routing receive lease while its
  child operation is still live, or make cancellation treat an executed action
  as pristine.
- Complete: API step presentation exposes the projector's exact `actionable`
  result. A reconcile-required sibling no longer hides an independent action;
  the response shape and public status strings are unchanged.
- Complete: account merge and Privy deletion inspect every linked operation's
  facts serially under their existing transaction. This deliberately favors
  safe destructive-action blocking over a stale terminal cache or unsafe
  concurrent `pg` calls on one transaction client.
- Complete: account merge locks the source user's funding rows before its
  factual audit and moves that frozen source set only after every operation is
  proven terminal. The ownership update has no second `status` eligibility
  predicate; it first refreshes the existing cache from the factual projector
  solely to satisfy the current immutable-plan trigger, so a delayed cache
  cannot disagree with the audit.
- Complete: `funding-persistence-tests` prevents the service-level lifecycle
  readers from reintroducing `operation.status`, `step.state`, or
  `segment.status` as decision inputs. An integration fixture corrupts a
  terminal cache and proves the account lifecycle still sees the live
  operation from attempt facts.
- Complete: the Stage 1 cache-reader inventory is classified below and the
  full fast suite plus the 16 lifecycle integration flows pass against the
  single disposable PostgreSQL database. The regression suite includes a
  deliberately stale terminal cache, independent action lanes, cancellation,
  reconciliation, receipt/reorg, receive, direct withdrawal, Relay, and
  Telegram continuation paths.
- In progress: independent review. Stage 2 receive/preparation aggregate
  deletion and Stage 3 schema work remain explicitly out of scope.
- Not started: receive/preparation aggregate deletion and final schema work
  belong to Stages 2 and 3, not this cutover.

Current proof for the completed items:

```text
pnpm -F api run typecheck
pnpm -F api run test:unit -- admin-merge-user deposit-events telegram-funding \
  funding-persistence funding-lifecycle-projector
pnpm -F api run test:fast
pnpm -F api run test:integration -- --database-url …hunch_receipt_poll_test \
  --expect-database hunch_receipt_poll_test funding-delegated-execution \
  funding-composite-action-race funding-planning telegram-funding-receive \
  funding-persistence funding-receive-internal-handoff funding-direct-withdrawal \
  funding-receive-notification funding-operation-action-persistence reconciliation \
  telegram-funding-buy-continuation telegram-funding-buy-return-source \
  telegram-app-handoff-consent telegram-bot-trading-lifecycle \
  telegram-bot-trading-market telegram-bot-trading-managed
```

### Mechanical cache-reader inventory (2026-09-04)

The Stage-1 inventory command is intentionally narrow enough to be rerun
without interpretation:

```text
rg -l --glob '*.ts' --glob '!**/*test*.ts' \
  "operation\\.status|step\\.state|segment\\.status|funding_operations[^\\n]*(status|progress_stage)|funding_operation_steps[^\\n]*state|funding_operation_segments[^\\n]*status" \
  apps/api/src
```

Every remaining production hit is classified below. It is not a live funding
lifecycle decision outside the projector:

| Location                                                                                             | Classification                         | Why it remains in Stage 1                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `funding/lifecycle/funding-lifecycle-projector.ts`, `funding-lifecycle-facts-repository.ts`          | Projector contract/documentation       | The strings distinguish immutable plan state from forbidden cache input; neither file reads a mutable aggregate status.             |
| `funding/persistence/funding-operation-repository.ts`, `funding-evidence-repository.ts`              | Cache materialization/transport        | They map or write public cache fields after fact derivation; step reads overlay the projector's state and actionability.            |
| `funding/reconciliation/funding-reducer.ts`                                                          | Diagnostic/cache comparison            | `initialState` is returned only for reduction diagnostics and cache-write reporting; target selection is fact-derived.              |
| `routes/funding.ts`                                                                                  | Public serialization                   | Runtime operations and step reads are already projector-backed; the route does not choose actionability from the serialized fields. |
| `funding/planner/planning-types.ts`, `funding/validation/polymarket-router-commit-plan-validator.ts` | Immutable pre-commit plan              | These inspect the proposed action DAG before persistence, not `funding_operation_steps.state` from a committed operation.           |
| `funding/position-actions/**`, `routes/position-actions.ts`                                          | Separate position-action state machine | It has its own financial facts and is deliberately outside funding-operation lifecycle scope.                                       |
| `funding-migration-preflight.ts`                                                                     | Historical read-only audit             | It classifies old rows for later migration work and cannot execute, reserve, or release funds.                                      |
| Tests                                                                                                | Characterization                       | Tests intentionally corrupt cache fields to prove facts dominate them.                                                              |

The service directory is additionally guarded by a unit test: no sponsorship,
Telegram, or user-financial lifecycle service may add a direct funding cache
predicate. Any new exception must be added to this table and justified with a
separate test.

## Non-negotiable target

There will be exactly one decision-maker for funding lifecycle state:

```text
immutable operation plan
+ immutable action DAG
+ monotonic attempt, receipt, route, and transfer facts
+ canonical step/transfer evidence
+ reservation and consumer facts
+ current time
                 |
                 v
       deriveFundingLifecycle(facts)
                 |
                 v
existing public status/progress/actionability fields
```

The projector is pure: it performs no SQL, RPC, provider call, clock read, or
mutation. It must **not** accept a previous operation/step/segment/session
aggregate status as an input. The only time input is explicit.

The existing response vocabulary stays unchanged. In particular, the projector
continues to produce `action_required`, `reconcile_required`,
`recovery_required`, `ready`, `completed`, `failed`, `cancelled`, and the
existing progress-stage strings.

## What is a fact and what is a projection

| Entity                                                  | Keep as source of truth? | Why                                                                                                     | Final role                                                                                         |
| ------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `funding_operations` immutable plan/consent/amounts     | Yes                      | Exact authorized economic intent and operation identity                                                 | Header plus one materialized public projection cache                                               |
| `funding_operation_segments` route/quote binding        | Yes                      | Exact provider leg and quoted route data                                                                | Immutable route-leg definition                                                                     |
| `funding_operation_steps` action/dependency/fingerprint | Yes                      | Exact action DAG, owner, payer, expiry                                                                  | Immutable action definition                                                                        |
| `funding_operation_step_attempts`                       | Yes                      | Durable proof that a call was attempted and might have broadcast                                        | Immutable identity with legal monotonic outcome/broadcast updates                                  |
| step receipt observations                               | Yes                      | Canonical action outcome/finality/reorg evidence                                                        | Immutable identity with legal canonicality/finality/status updates                                 |
| `funding_observations`                                  | Yes                      | Canonical debit, credit, readiness, refund evidence                                                     | Immutable identity with legal canonicality/finality/status updates                                 |
| `funding_route_observations`                            | Yes                      | Provider quote/route observations explain what was proposed or verified                                 | Immutable identity with legal outcome/refund/recovery updates; never an aggregate lifecycle status |
| `funding_provider_requests`                             | Yes                      | Provider request identity/recovery lookup                                                               | Immutable request identity with provider-recovery updates                                          |
| `balance_reservations`                                  | Yes                      | Prevents competing spend and represents consumer ownership                                              | Small independent lock lifecycle                                                                   |
| `telegram_funding_authorization_reservations`           | Yes                      | A delegated allowance/authorization may require cleanup, refund, or release after the funding operation | Separate authorization-resource lifecycle; it is not an operation status                           |
| `funding_trade_attempts`                                | Yes                      | Consumer-side order submission and venue outcome require their own idempotency and audit trail          | Trade-consumer facts; linked to, but never used to mutate, funding evidence                        |
| `funding_reconciliation_jobs`                           | Yes, operationally       | Worker lease/schedule, not money truth                                                                  | Queue state only                                                                                   |
| receive address/session data                            | Yes                      | Address scope, expiry, late-observation window                                                          | Address lease, no lifecycle authority                                                              |
| receive receipt/canonical event data                    | Yes                      | Immutable inbound-money fact and allocation                                                             | Inbound receipt facts                                                                              |
| `funding_operations.status/progress_stage`              | Temporarily              | Fast public/worker projection                                                                           | Cache written only by the lifecycle boundary                                                       |
| `funding_operation_steps.state`                         | No                       | Derivable from dependency, attempts, evidence and time                                                  | Delete                                                                                             |
| `funding_operation_segments.status`                     | No                       | Derivable from attempts/evidence                                                                        | Delete                                                                                             |
| segment actual amount/timestamps                        | No                       | Derivable from immutable evidence/attempt timestamps                                                    | Delete after reader cutover                                                                        |
| `funding_preparation_runs` + action attempts            | No                       | Duplicates operation/actions/attempts                                                                   | Replace with `planKind = venue_preparation`                                                        |
| receive-session mutable status                          | No                       | It is an aggregate of receipt state while also controlling an address lease                             | Derive at read time; session stores close facts only                                               |
| receive-receipt mutable status                          | No                       | Derivable from receipt facts, handling and linked child operation                                       | Derive at read time                                                                                |
| Telegram funding sub-status                             | No                       | Telegram is a presentation/intent surface, not funding authority                                        | Project from operation                                                                             |

`balance_reservations` and reconciliation jobs are intentionally **not**
folded into a universal lifecycle enum. They solve different problems:

```text
reservation:       active -> consumed | released
authorization:     reserved -> cleanup/refund/release terminal outcome
job:               scheduled -> leased -> completed | dead_letter
funding projection: derived from financial/execution facts
```

“Fact” here does **not** mean physically append-only. Attempt outcome,
broadcast marker, receipt/transfer canonicality and finality, and route
recovery/refund outcomes have narrowly defined **monotonic legal mutations**.
The future lifecycle boundary must retain those transition rules verbatim (or
write a separately append-only history before changing them). It may delete
only derived aggregate status, never finality/reorg semantics.

The authorization reservation is deliberately separate from
`balance_reservations`: it represents a provider-side permission/allowance
cleanup obligation, not ownership of a spendable balance. Likewise, a trade
attempt is the consumer's order lifecycle, not proof that source funds moved.
The projector may read their immutable outcome facts to decide whether a
consumer hand-off is complete, but it must never collapse any of these three
state machines into the funding projection.

## Current graph and why it drifts

```text
operation status + stage ─┐
step state               ├─ current code independently reads/writes several
segment status            │  of these aggregates
preparation run state    │
receive session status   │
receive receipt status   │
Telegram intent status  ─┘

attempts + receipts + observations + reservations
  are the underlying facts, but are not the sole decision input today.
```

The operation graph has 32 permitted `status:stage` pairs in
`apps/api/src/funding/domain/transitions.ts`. Its terminal values can reopen
into `recovery_required`, which makes "terminal" an unreliable public and
internal concept. Segment, step, receive, preparation, and Telegram states
repeat parts of the same uncertainty.

## Canonical projector contract

Create `apps/api/src/funding/lifecycle/funding-lifecycle-projector.ts`.
The exact type names may differ, but its input/output boundaries must remain
this small and explicit.

```ts
type FundingLifecycleFacts = Readonly<{
  operation: ImmutableOperationPlan;
  segments: readonly ImmutableSegment[];
  actions: readonly ImmutableAction[];
  attempts: readonly ActionAttemptFact[];
  stepEvidence: readonly StepEvidenceFact[];
  transferEvidence: readonly TransferEvidenceFact[];
  routeObservations: readonly RouteObservationFact[];
  reservations: readonly ReservationFact[];
  authorizationReservations: readonly AuthorizationReservationFact[];
  consumer: ConsumerFact | null;
  tradeAttempts: readonly TradeAttemptFact[];
  receive: ReceiveFact | null;
  now: Date;
}>;

type FundingLifecycleProjection = Readonly<{
  // Existing external vocabulary returned directly by the projector.
  status: ExistingFundingOperationStatus;
  progressStage: ExistingFundingProgressStage;
  recoveryMode: ExistingFundingRecoveryMode | null;
  errorCode: string | null;

  actions: readonly Readonly<{
    stepId: string;
    publicState: ExistingFundingStepState;
    actionable: boolean;
  }>;
  segments: readonly Readonly<{
    segmentId: string;
    publicStatus: ExistingSegmentStatus;
    actualInput: Money | null;
    actualOutput: Money | null;
  }>;

  safety: Readonly<{
    moneyMayHaveMoved: boolean;
    retryAllowed: boolean;
    cancelAllowed: boolean;
    reservationsMayRelease: boolean;
    requiresWorker: boolean;
    requiresManualRecovery: boolean;
    nextWakeAt: Date | null;
    terminal: boolean;
  }>;
}>;
```

### Projector precedence

The order below is mandatory. It removes history-dependent branches while
preserving the safety purpose of the existing conditions.

1. Canonicality/reorg conflict, a previously unknown debit/credit, or any
   unresolved attempt where a broadcast may have occurred.
2. Finalized refund evidence.
3. Finalized destination/venue-readiness evidence and amount sufficiency.
4. Finalized source/intermediate evidence.
5. A cancellation attempt for every action, with proof that no money moved.
6. Definitive finalized action failure with proof that no money moved.
7. The full **set** of dependency-satisfied, unexpired actions that may run
   concurrently under the immutable DAG.
8. External receive window still open.
9. Otherwise typed manual recovery; never an inferred safe terminal state.

No terminal-decision table or incident state machine is introduced. A late
provider hash, receipt, reorg, or canonical debit simply changes existing
attempt/receipt/transfer facts; the next projection becomes
`reconcile_required` or `recovery_required` and wakes the already-existing
reconciliation job. A cancellation is itself an existing cancelled action
attempt. The cancellation projection is valid only while there is neither
movement evidence nor a broadcast-possible attempt. This avoids a second
terminal journal and makes late evidence a normal recomputation, not a special
child workflow.

The following liveness invariant is a required assertion in the projector and
in integration tests:

```text
Every nonterminal operation has at least one, and only compatible, owners:

1. one or more dependency-satisfied actions from the immutable DAG;
2. one or more unresolved broadcasts with a leased/scheduled reconciliation job and
   a bounded deadline;
3. an open external receive window;
4. a ready consumer reservation; or
5. an explicit manual-recovery task with a typed reason.

Independent root actions may coexist (for example a composite/multi-source
route). A dependent action remains non-actionable until every predecessor is
proven successful. The invariant rejects incompatible ownership of the **same
money/action**, not legal parallel actions on distinct legs.
```

If none applies, the projector must produce an internal invariant failure and
an alert. It must not invent another public status.

## Trace inventory

The IDs below seed the implementation surface for lifecycle decisions. They
become exhaustive only when the mandatory mechanical reader/writer inventory
has classified every production occurrence of a removed aggregate field. Search
for the trace ID during implementation and add a completion note below it
rather than silently deleting a branch.

### A. Domain transition maps and public mapping

| ID          | Current location                                 | Current condition/behavior                                                                 | Replacement                                                                                                            | Required proof                                                                 |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| FLC-DOM-001 | `apps/api/src/funding/domain/transitions.ts:1`   | Ten operation status strings plus ten progress stages create a 32-node allowed-pair graph. | Keep strings only in `mapProjectionToPublicStatus`; remove the operation transition graph.                             | Projector table test produces every externally supported pair.                 |
| FLC-DOM-002 | `apps/api/src/funding/domain/transitions.ts:57`  | Transition validity depends on the previously persisted pair.                              | No prior pair input; derive directly from facts.                                                                       | Same facts in different historic aggregate states produce the same projection. |
| FLC-DOM-003 | `apps/api/src/funding/domain/transitions.ts:217` | `completed`, `refunded`, `failed`, and `cancelled` may reopen into recovery.               | A terminal value is a projection, not a stored decision. Changed canonical facts recompute to reconciliation/recovery. | Reorg-after-terminal test; no release before the recomputed safety result.     |
| FLC-DOM-004 | `apps/api/src/funding/domain/transitions.ts:260` | Segment has ten independent states and a transition map.                                   | Map segment display from actions/evidence; delete stored lifecycle status and `SEGMENT_TRANSITIONS`.                   | Per-segment evidence matrix.                                                   |
| FLC-DOM-005 | `apps/api/src/funding/domain/types.ts:603`       | Receive session type exposes seven stored status values.                                   | Session response maps address lease + receipt/child-operation projection to the unchanged public strings.              | Session read-contract snapshots.                                               |

### B. Operation reducer: exact current decision order

The following traces cover every branch in the current primary operation
reducer. They are the highest-risk migration surface.

| ID          | Current location                                              | Exact condition                                                                                                 | Required projector rule                                                                                        |
| ----------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| FLC-RED-001 | `apps/api/src/funding/reconciliation/funding-reducer.ts:295`  | `deriveTargetState` reads `operation.status/progressStage` before deriving a target.                            | Remove aggregate state from inputs.                                                                            |
| FLC-RED-002 | `apps/api/src/funding/reconciliation/funding-reducer.ts:305`  | All segments succeed/refund only if stored segment state or a state-transition path reaches the terminal value. | Derive each leg from canonical evidence only; no transition path.                                              |
| FLC-RED-003 | `apps/api/src/funding/reconciliation/funding-reducer.ts:327`  | Destination must be at least requested raw amount; composite routes require total amount proof.                 | Keep exact asset/location-aware amount comparison.                                                             |
| FLC-RED-004 | `apps/api/src/funding/reconciliation/funding-reducer.ts:343`  | Delegated Relay requires successful expected steps and finalized source debit; client atomic batch is exempt.   | Preserve as executor-profile evidence policy, not generic lifecycle branching.                                 |
| FLC-RED-005 | `apps/api/src/funding/reconciliation/funding-reducer.ts:360`  | Recovery target is selected from the previous stage/status and falls back to `recovery_required`.               | Replace with `requiresManualRecovery` or `requiresWorker`; the projector returns the existing public status.   |
| FLC-RED-006 | `apps/api/src/funding/reconciliation/funding-reducer.ts:380`  | Unresolved started/broadcast attempt maps to reconcile only if current aggregate is not recovery/terminal.      | Any unresolved `broadcastMayHaveOccurred` maps to bounded reconciliation, independent of old aggregate labels. |
| FLC-RED-007 | `apps/api/src/funding/reconciliation/funding-reducer.ts:395`  | Canonicality loss special-cases terminal refund and may reopen another terminal operation.                      | Record evidence dispute. Do not mutate primary terminal outcome.                                               |
| FLC-RED-008 | `apps/api/src/funding/reconciliation/funding-reducer.ts:421`  | Failed/cancelled operation plus a reconcile/recovery step becomes recovery.                                     | Terminal decision is a fact; unresolved movement evidence wins as a separate dispute condition.                |
| FLC-RED-009 | `apps/api/src/funding/reconciliation/funding-reducer.ts:438`  | Existing completed/refunded operation immediately returns current aggregate.                                    | Project from consumer/refund evidence, not stored status.                                                      |
| FLC-RED-010 | `apps/api/src/funding/reconciliation/funding-reducer.ts:447`  | Any step in recovery/reconcile escalates operation aggregate to the same class.                                 | Calculate action state from attempts/evidence; do not let a stale step label dominate.                         |
| FLC-RED-011 | `apps/api/src/funding/reconciliation/funding-reducer.ts:469`  | Automatic evidence recovery re-arms failed action when canonical failure proves no money moved.                 | Keep exact rule: finalized no-movement failure permits one safe retry.                                         |
| FLC-RED-012 | `apps/api/src/funding/reconciliation/funding-reducer.ts:490`  | Failed/cancelled action ends operation only if no financial evidence exists.                                    | Keep; evidence presence means reconcile/compensate, never fake terminal cancellation.                          |
| FLC-RED-013 | `apps/api/src/funding/reconciliation/funding-reducer.ts:505`  | Final refund credit ends operation unless a composite leg remains unresolved.                                   | Keep refund evidence; model continuation as compensation/remaining leg facts.                                  |
| FLC-RED-014 | `apps/api/src/funding/reconciliation/funding-reducer.ts:521`  | Venue readiness plus delegated Relay proof and composite amount sufficiency gives ready/completed.              | Keep as `destinationReady` fact plus consumer policy.                                                          |
| FLC-RED-015 | `apps/api/src/funding/reconciliation/funding-reducer.ts:539`  | Destination credit gives venue preparation, ready, or completed.                                                | Keep milestone mapping; action DAG decides whether preparation action exists.                                  |
| FLC-RED-016 | `apps/api/src/funding/reconciliation/funding-reducer.ts:559`  | Partial composite destination evidence returns routing.                                                         | Keep `partialFunding` fact; no status loop.                                                                    |
| FLC-RED-017 | `apps/api/src/funding/reconciliation/funding-reducer.ts:565`  | Intermediate transfer evidence returns `intermediate_observed`.                                                 | Keep as derived progress milestone only.                                                                       |
| FLC-RED-018 | `apps/api/src/funding/reconciliation/funding-reducer.ts:572`  | Source debit/credit returns `source_observed`.                                                                  | Keep as derived progress milestone only.                                                                       |
| FLC-RED-019 | `apps/api/src/funding/reconciliation/funding-reducer.ts:580`  | Submitted/succeeded action returns `source_action`; otherwise reducer returns the old current status.           | Return a projection from facts; never return old aggregate as a fallback.                                      |
| FLC-RED-020 | `apps/api/src/funding/reconciliation/funding-reducer.ts:591`  | Segment reducer interprets reorg, refund, destination minimum, intermediate and source evidence.                | Move verbatim fact predicates into projector's leg derivation.                                                 |
| FLC-RED-021 | `apps/api/src/funding/reconciliation/funding-reducer.ts:635`  | Amount summation selects observations by kind and asset/amount shape.                                           | Retain exact identity/dedup rules; add property tests for duplicate/reordered evidence.                        |
| FLC-RED-022 | `apps/api/src/funding/reconciliation/funding-reducer.ts:718`  | Source reservations release after source/destination/refund evidence.                                           | Projector emits `reservationEffects`; lifecycle writer applies them once.                                      |
| FLC-RED-023 | `apps/api/src/funding/reconciliation/funding-reducer.ts:774`  | Venue-preparation source reservations release only after readiness.                                             | Preserve exact consumer safety condition.                                                                      |
| FLC-RED-024 | `apps/api/src/funding/reconciliation/funding-reducer.ts:800`  | Recovery releases unused stopped-step reservations.                                                             | Retain only for facts proving no broadcast; never release a possibly moved source.                             |
| FLC-RED-025 | `apps/api/src/funding/reconciliation/funding-reducer.ts:858`  | Terminal release rules vary by outcome.                                                                         | Make effects explicit and exhaustively tested.                                                                 |
| FLC-RED-026 | `apps/api/src/funding/reconciliation/funding-reducer.ts:884`  | Ready operation creates a settled consumer reservation.                                                         | Keep as the sole ownership hand-off into a trade consumer.                                                     |
| FLC-RED-027 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1037` | Expired consumer reservation may release/cleanup the ready operation.                                           | Preserve deadline and trade-abandonment behavior.                                                              |
| FLC-RED-028 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1180` | Bound steps are reconciled per segment and written before operation reduction.                                  | Replace with projector-derived public step states; attempts/evidence remain immutable.                         |
| FLC-RED-029 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1209` | Segment reduction walks old-to-new paths and writes segment status/actual amounts.                              | Delete path walking and status mutation; materialize display cache only if query performance requires it.      |
| FLC-RED-030 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1282` | Operation reducer writes state path, records actual amounts, performs reservations and Telegram resolution.     | Replace with the single `recordFactAndProject` transaction boundary.                                           |

### C. Reconciliation timing, recovery, and worker ownership

| ID          | Current location                                                   | Current condition                                                                                               | Projector/worker replacement                                                                        |
| ----------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| FLC-WRK-001 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1677`      | Active states are selected by status labels.                                                                    | Queue selection uses unresolved attempt/evidence deadlines and operation projection cache only.     |
| FLC-WRK-002 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1702`      | 90-second terminal reconciliation timeout.                                                                      | Preserve as explicit `nextWakeAt`/deadline policy.                                                  |
| FLC-WRK-003 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1715`      | `recovery_required` may requeue for automatic evidence; other values complete/requeue based on aggregate state. | Projector exposes `requiresWorker` and `requiresManualRecovery`; worker does not infer from labels. |
| FLC-WRK-004 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1891`      | Final step evidence may need a bounded reduction grace.                                                         | Preserve grace as evidence-consumption timing, not status transition.                               |
| FLC-WRK-005 | `apps/api/src/funding/reconciliation/funding-reducer.ts:1923`      | Unbroadcast action report wait and expiry gate retry.                                                           | Keep as attempt fact + deadline.                                                                    |
| FLC-WRK-006 | `apps/api/src/funding/reconciliation/funding-reducer.ts:2037`      | Non-transient error allowlist can force manual recovery.                                                        | Preserve typed error policy in lifecycle policy module.                                             |
| FLC-WRK-007 | `apps/api/src/funding/reconciliation/funding-reducer.ts:2064`      | Poll delay changes for recovery, broadcast-evidence and idle wait.                                              | Derive `nextWakeAt`; the worker only schedules it.                                                  |
| FLC-WRK-008 | `apps/api/src/funding/reconciliation/funding-reducer.ts:2095`      | Polling decides receipt, provider, postcondition and destination ordering.                                      | Keep polling sequence; make it consume projector facts after every append.                          |
| FLC-WRK-009 | `apps/api/src/funding/reconciliation/funding-reducer.ts:2294`      | Expiry of an unbroadcast action wait terminalizes safe no-movement work.                                        | Preserve exact no-broadcast proof requirement.                                                      |
| FLC-WRK-010 | `apps/api/src/funding/reconciliation/funding-reducer.ts:2379`      | Timeout marks operation `recovery_required` with automatic evidence.                                            | Replace mutation with projector result and retained deadline.                                       |
| FLC-WRK-011 | `apps/api/src/funding/reconciliation/funding-reducer.ts:2448`      | Non-transient errors mark manual review/dead letter.                                                            | Preserve as typed manual-recovery fact.                                                             |
| FLC-WRK-012 | `apps/api/src/funding/reconciliation/funding-reducer.ts:2505`      | One lease handles evidence, reduction, reorg watch, timeout and retry.                                          | Keep lease ownership; route all lifecycle mutations through one writer.                             |
| FLC-WRK-013 | `apps/api/src/funding/worker/funding-reconciliation-worker.ts:356` | Worker starts from reconciliation-job leases.                                                                   | Keep; job status is an operational queue state, not a funding status.                               |

### D. API actionability and cancellation

| ID          | Current location                                                            | Current condition                                                                                                                            | Required replacement                                                                                                                                             |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLC-API-001 | `apps/api/src/routes/funding.ts:392`                                        | Any operation `ready`, `reconcile_required`, `recovery_required`, terminal status, or any step in a stop-state disables every public action. | Use `projection.actions.find(action => action.stepId === step.id)?.actionable === true`; only the exact unresolved/money-moving action blocks its own successor. |
| FLC-API-002 | `apps/api/src/routes/funding.ts:420`                                        | Step actionability depends on stored operation/step status and dependency stored state.                                                      | Depend on that step's projection and immutable dependency graph; expose all legally parallel root actions.                                                       |
| FLC-CAN-001 | `apps/api/src/funding/reconciliation/funding-operation-cancellation.ts:12`  | Step-less ingress is cancellable only when direct external handoff is awaiting external funds at source action.                              | Preserve semantic rule through facts: no steps, no attempt, no evidence, receive window open.                                                                    |
| FLC-CAN-002 | `apps/api/src/funding/reconciliation/funding-operation-cancellation.ts:112` | Terminal operation returns immediately.                                                                                                      | Return terminal projection only when facts still prove it; late movement recomputes to reconciliation before any release.                                        |
| FLC-CAN-003 | `apps/api/src/funding/reconciliation/funding-operation-cancellation.ts:121` | Ready consumer reservation is released as abandoned trade.                                                                                   | Keep exact one-active-consumer-reservation assertion and release effect.                                                                                         |
| FLC-CAN-004 | `apps/api/src/funding/reconciliation/funding-operation-cancellation.ts:186` | Any non-planned/action-required step, any attempt, or any observation forbids cancellation.                                                  | Use `moneyMayHaveMoved` plus unresolved attempt/evidence, not stored step labels.                                                                                |
| FLC-CAN-005 | `apps/api/src/funding/reconciliation/funding-operation-cancellation.ts:213` | Safe cancellation writes every planned/action-required step as cancelled.                                                                    | Record a cancelled attempt for each untouched action; public step states derive from the attempt facts.                                                          |
| FLC-CAN-006 | `apps/api/src/funding/reconciliation/funding-operation-cancellation.ts:37`  | Cancellation separately changes Telegram handoff intent.                                                                                     | Telegram reads common projection; only its business intent closure remains a side effect.                                                                        |

### E. Persistence and mutation boundaries

| ID          | Current location                                                        | Current behavior                                                                               | Required replacement                                                                                                                 |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| FLC-PER-001 | `apps/api/src/funding/persistence/funding-operation-repository.ts:710`  | Commit inserts route segments with initial status.                                             | Insert immutable route leg only.                                                                                                     |
| FLC-PER-002 | `apps/api/src/funding/persistence/funding-operation-repository.ts:819`  | Commit inserts mutable step state.                                                             | Insert immutable action DAG only.                                                                                                    |
| FLC-PER-003 | `apps/api/src/funding/persistence/funding-operation-repository.ts:893`  | Commit creates source/future-credit reservations.                                              | Keep exact economic reservations and their ownership checks.                                                                         |
| FLC-PER-004 | `apps/api/src/funding/persistence/funding-operation-repository.ts:1087` | Commit creates operation, plan, segments, steps, reservations, and wake job.                   | Keep atomic commit, but initialize only facts and then materialize projection through the writer.                                    |
| FLC-PER-005 | `apps/api/src/funding/persistence/funding-operation-repository.ts:1407` | `transitionFundingOperationInTransaction` validates old/new pair and mutates aggregate status. | Replace with `recordFactAndProjectInTransaction`; no old/new state parameter.                                                        |
| FLC-PER-006 | `apps/api/src/funding/persistence/funding-operation-repository.ts:1571` | Segment transition validates old status path and writes actual amounts/status.                 | Delete after all readers use projector.                                                                                              |
| FLC-PER-007 | `apps/api/src/funding/persistence/funding-operation-repository.ts:1771` | Observation allocation is durable and scoped to operation/segment.                             | Keep; it is a fact append boundary.                                                                                                  |
| FLC-PER-008 | `apps/api/src/funding/persistence/funding-operation-repository.ts:1885` | Observation finality changes canonical evidence.                                               | Keep; lifecycle recomputes after every finality change.                                                                              |
| FLC-PER-009 | `apps/api/src/funding/persistence/funding-operation-repository.ts:1991` | Reservation is consumed only from active and is idempotent for the same consumer.              | Keep unchanged.                                                                                                                      |
| FLC-PER-010 | `apps/api/src/funding/persistence/funding-operation-repository.ts:2060` | Reservation release only transitions active to released.                                       | Keep unchanged; writer decides when it is allowed.                                                                                   |
| FLC-PER-011 | `apps/api/src/funding/persistence/funding-operation-repository.ts:2127` | Reconciliation job is woken/leased independently.                                              | Keep queue semantics, but feed it only from projector's `nextWakeAt`.                                                                |
| FLC-PER-012 | `funding_operation_step_attempts` cancellation writer                   | Cancellation currently writes a derived step state.                                            | Record one idempotent cancelled attempt per untouched action; the projection then derives cancellation without reading a step state. |
| FLC-PER-013 | Existing receipt/observation writer                                     | Late broadcast, receipt, canonicality change, or reorg is already durable evidence.            | Recompute and wake the existing operation reconciliation job. No additional incident table or lifecycle is introduced.               |

### F. Direct execution, evidence and decision-reader cutover

The writer boundary is insufficient unless all command and worker **readers**
stop deciding from stale operation/step/session labels. Each row below must be
implemented through the lifecycle fact loader/projector or documented as an
independent resource state machine before a column is dropped.

| ID          | Current location                                                                                                                    | Current condition and side effect                                                                                                        | Required replacement and proof                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLC-EXE-001 | `apps/api/src/funding/execution/relay-evm-delegated-executor-profile.ts`                                                            | Delegated execution evaluates step/attempt/receipt state and authorization cleanup, including the no-receipt/no-possible-broadcast path. | Load projection facts under the same lock; retain authorization cleanup/refund/release decision as FLC-ADJ-002. Test report loss, late receipt and cleanup after every provider outcome. |
| FLC-EXE-002 | `apps/api/src/funding/persistence/funding-evidence-repository.ts:1134` and `:1361`                                                  | Late provider evidence updates step/operation state and wakes reconciliation.                                                            | Append legal evidence mutation, derive projection, wake the existing operation job. Test late hash after cancel/fail and no premature release.                                           |
| FLC-EXE-003 | `apps/api/src/funding/persistence/funding-step-receipt-repository.ts:838`, `:1025`, `:1045`                                         | Receipt finality changes step state and activates a dependent Router fund action.                                                        | Receipt fact writer recomputes the whole ready-action set; test dependent activation and two simultaneous independent roots.                                                             |
| FLC-EXE-004 | `apps/api/src/funding/reconciliation/direct-ingress-observer.ts:422`                                                                | Direct deposit evidence transitions operation and makes next action `action_required`.                                                   | Append ingress evidence then derive every enabled successor; test ingress does not expose dependent action before exact evidence.                                                        |
| FLC-EXE-005 | `apps/api/src/funding/reconciliation/telegram-router-continuation-committer.ts:497`                                                 | Telegram continuation selects by trade-intent/funding state and commits Router continuation.                                             | Gate with linked operation projection plus trade-consumer facts; test stale Telegram card cannot submit or block a new valid action.                                                     |
| FLC-EXE-006 | `apps/api/src/funding/preparation/polymarket-funding-reconciler.ts:199` and `:342`                                                  | Preparation reconciler reads/writes step state from final receipt and activates/settles work.                                            | Route receipt fact through the common projector; retain exact Polymarket postcondition evidence test.                                                                                    |
| FLC-EXE-007 | `apps/api/src/funding/execution/operation-action-runtime.ts` and `apps/api/src/funding/execution/delegated-funding-executor.ts:502` | Action execution queries `action_required` state and predecessor state directly before an external call.                                 | Query `projection.actions` under action/operation lock; persist attempt before call; test a stale cache cannot send duplicate or hide a parallel legal action.                           |
| FLC-EXE-008 | `apps/api/src/funding-providers/relay/reconciliation.ts`                                                                            | Provider reconciliation classifies submitted/unknown provider calls independently of the operation projection.                           | Preserve provider-specific evidence retrieval/order, append its result through the common writer, and test polling completes without webhook.                                            |
| FLC-EXE-009 | `apps/api/src/funding/execution/telegram-trade-shortfall-activation.ts`                                                             | Trade-shortfall activation reads funding/intent state to decide whether it may create/continue a consumer.                               | Classify as a decision reader before cutover; it must use ready consumer facts and be covered by consumer-idempotency tests.                                                             |

**Inventory gate:** before each changeset, generate and check in a machine
readable report of every production occurrence of `funding_operations.status`,
`progress_stage`, `funding_operation_steps.state`,
`funding_operation_segments.status`, `funding_receive_sessions.status`, and
`funding_receive_receipts.status` in SQL and TypeScript. For each occurrence,
the report records `FLC-*` owner, `read|write`, side effect, replacement, and
test. The count of unclassified occurrences must be zero. Exclude migrations
only after their dependency manifest is attached (FLC-SQL-013).

### G. Receive session, late deposits, and receipt routing

| ID          | Current location                                                              | Exact condition                                                                                                                        | Required replacement                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLC-RCV-001 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:200`  | Session `processing/review_required/recovery_required` is derived from receipt status.                                                 | Do not persist this aggregate; derive it at response time.                                                                                                  |
| FLC-RCV-002 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:237`  | Effective session status changes to completed if closed, late receipt, or successor exists.                                            | Persist `closed_at` + `close_reason`; derive public completed state.                                                                                        |
| FLC-RCV-003 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:313`  | Derived session status is written back to the same row.                                                                                | Delete `refreshFundingReceiveSessionStatus`.                                                                                                                |
| FLC-RCV-004 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:552`  | A session owns a cross-channel selection lease when it has in-flight receipt state.                                                    | Preserve as receipt/operation fact, not session aggregate status.                                                                                           |
| FLC-RCV-005 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:584`  | Query selects open/processing/review/recovery sessions and late closed sessions.                                                       | Query open address lease (`closed_at is null`) plus receipt-level in-flight work.                                                                           |
| FLC-RCV-006 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:647`  | Replay conflicts if another channel owns a current in-flight selection.                                                                | Keep exact cross-channel protection.                                                                                                                        |
| FLC-RCV-007 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:753`  | Same-channel replay, stale expiry, review/recovery release and cross-channel supersession use status branches.                         | Rewrite using `leaseOpen`, receipt facts, `observe_until`, and scope lock.                                                                                  |
| FLC-RCV-008 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:880`  | A fresh channel cancels an unspent cross-channel `open` session; observed/routing receipt causes conflict.                             | Preserve exactly: supersede only empty address lease, never an inbound movement.                                                                            |
| FLC-RCV-009 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1115` | Expiry mutates active session states.                                                                                                  | Set close fact once; derive public expiry.                                                                                                                  |
| FLC-RCV-010 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1134` | Observer prioritizes status classes and polls closed sessions through `observe_until`.                                                 | Schedule from lease/receipt facts; retain late-observation cadence.                                                                                         |
| FLC-RCV-011 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1968` | Receipt insertion assigns status/handling and links session.                                                                           | Retain immutable receipt identity plus its independent routing/handling facts; derive only display aggregate status.                                        |
| FLC-RCV-012 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:2290` | Receipt routing target is selected from status/handling/child operation link.                                                          | Preserve deterministic target-selection/allocation policy over receipt + child-operation facts; it is inbound-money authority, not an operation projection. |
| FLC-RCV-013 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:2541` | Routing disposition writes receipt and session status.                                                                                 | Retain monotonic routing/child-operation result facts and retry ownership; recompute only public receipt/session projection.                                |
| FLC-RCV-014 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:3348` | Receipt routing settlement writes terminal receipt/session state.                                                                      | Record settlement/allocation result; receipt projection derives `ready`/recovery while its routing queue stays independently durable.                       |
| FLC-RCV-015 | `apps/api/src/funding/receive/receive-session-observer.ts:404`                | Completed/expired/cancelled sessions are late-observable.                                                                              | `closed_at != null && observe_until > now` is the late-observation predicate.                                                                               |
| FLC-RCV-016 | `apps/api/src/funding/receive/receive-session-observer.ts:414`                | Invalid variants move active session to recovery but closed session uses a special update path.                                        | Record the validation result as receipt evidence; derive receive recovery directly from that fact.                                                          |
| FLC-RCV-017 | `apps/api/src/funding/receive/receive-session-observer.ts:447`                | Late non-direct receipt becomes recovery; direct receipt becomes ready; review handling becomes review; otherwise observed/processing. | Preserve exact public mapping as a pure receipt projection.                                                                                                 |
| FLC-RCV-018 | `apps/api/src/funding/receive/receive-session-observer.ts:490`                | No positive delta waits; more than one positive delta is ambiguous; exactly one becomes receipt.                                       | Keep exact delta/baseline rule and ambiguity safety.                                                                                                        |
| FLC-RCV-019 | `apps/api/src/funding/receive/receive-session-observer.ts:523`                | Baselines advance for negative-only/all-changed modes.                                                                                 | Keep as address-observation fact maintenance.                                                                                                               |
| FLC-RCV-020 | `apps/api/src/funding/receive/receive-receipt-router.ts:1`                    | Router dispatches direct, automatic conversion, review and recovery receipt paths.                                                     | Route from receipt facts plus lifecycle projection; no independent receipt/session state writes.                                                            |
| FLC-RCV-021 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1374` | Canonical inbound event carries `pending/allocated/recovery_required`, error and retry information.                                    | Keep this allocation/retry state machine and canonical-event identity; do not label it an operation status or delete it with receipt display status.        |
| FLC-RCV-022 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1403` | Bounded retry backlog owns canonical events whose target session was temporarily unavailable.                                          | Preserve retry selection, ownership-unavailable quarantine, and safe suppression; test retry cannot allocate an event twice.                                |
| FLC-RCV-023 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1737` | Upsert deduplicates canonical event identity and advances legal allocation state.                                                      | Preserve identity/canonicality rules and monotonic legal update set exactly.                                                                                |
| FLC-RCV-024 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1845` | Allocation selects the canonical target or writes typed recovery for ambiguity/unavailability.                                         | Keep selection error classification and worker ownership; a projector may display it but cannot erase or reallocate it.                                     |
| FLC-RCV-025 | `apps/api/src/funding/persistence/funding-receive-session-repository.ts:1885` | Retry may defer allocation when the matching session changes.                                                                          | Preserve bounded retry/cursor semantics and exact target binding.                                                                                           |

### H. Standalone preparation duplication

| ID          | Current location                                                             | Current condition/behavior                                                                       | Required replacement                                                                                                    |
| ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| FLC-PRP-001 | `packages/db/migrations/0193_funding_preparation_runs.sql:3`                 | A separate run table repeats action lifecycle statuses.                                          | New run is a normal operation with `planKind = venue_preparation`.                                                      |
| FLC-PRP-002 | `packages/db/migrations/0193_funding_preparation_runs.sql:44`                | Separate action-attempt table repeats action report/broadcast uncertainty.                       | Use `funding_operation_step_attempts`.                                                                                  |
| FLC-PRP-003 | `apps/api/src/funding/persistence/funding-preparation-run-repository.ts:152` | Only an `action_required` run expires.                                                           | Action expiry is an immutable action deadline evaluated by projector.                                                   |
| FLC-PRP-004 | `apps/api/src/funding/persistence/funding-preparation-run-repository.ts:329` | Run status priority is ambiguous > submitted > action_required > failed > cancelled > succeeded. | Serialize the common lifecycle projection into the existing preparation response (`reconcile_required` -> `ambiguous`). |
| FLC-PRP-005 | `apps/api/src/funding/persistence/funding-preparation-run-repository.ts:345` | Action report mutates separate run/action state.                                                 | Record a normal action attempt/report through lifecycle writer.                                                         |
| FLC-PRP-006 | `apps/api/src/funding/persistence/funding-preparation-run-repository.ts:442` | Resolve marks all active preparation actions succeeded.                                          | Consumer/evidence result resolves common actions.                                                                       |
| FLC-PRP-007 | `apps/api/src/routes/funding.ts:340`                                         | API serializes a standalone preparation run.                                                     | Serializer reads the operation projection and emits the unchanged run response.                                         |

### I. Telegram and cross-surface continuation

Telegram retains the lifecycle of the **trade intent**, but not authority over
funding state. The following readers/writers must be cut over to common
projection before any state deletion.

| ID          | Current locations                                                                                                           | Current behavior                                                                     | Required replacement                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| FLC-TLG-001 | `packages/db/migrations/0216_telegram_trade_shortfall_funding.sql:10`                                                       | Intent status includes `funding`, `external_handoff`, and `reconcile_required`.      | Keep strings only as compatibility/display mapping; trade intent does not decide funding actionability.                                     |
| FLC-TLG-002 | `apps/api/src/funding/reconciliation/funding-operation-cancellation.ts:37`                                                  | Safe cancellation writes linked Telegram intent.                                     | Keep business cancellation side effect after common projection says safe.                                                                   |
| FLC-TLG-003 | `apps/api/src/funding/persistence/funding-evidence-repository.ts:1758`                                                      | Evidence repository advances Telegram intent on funding evidence.                    | It may notify/update trade business state, but must not independently classify funding.                                                     |
| FLC-TLG-004 | `apps/api/src/funding/reconciliation/telegram-router-continuation-committer.ts:497`                                         | Router continuation commits only when intent status is `funding`.                    | Gate on linked operation's `ready` consumer fact.                                                                                           |
| FLC-TLG-005 | `apps/api/src/services/telegram-trade-shortfall-auto-resume.ts:54`                                                          | Auto-resume selects `intent.status = funding`.                                       | Select linked operation whose projection is ready/actionable.                                                                               |
| FLC-TLG-006 | `apps/api/src/services/telegram-trade-lifecycle-progress.ts:386`                                                            | Telegram progress mutates/read-maps intent and funding conditions.                   | Render only common operation projection plus business trade outcome.                                                                        |
| FLC-TLG-007 | `apps/api/src/services/telegram-bot-trading.ts:11976`                                                                       | Bot blocks/retries based on several intent status branches.                          | Replace funding-related conditions with common `actionable`, `terminal`, and `blockingMoneyMovement`.                                       |
| FLC-TLG-008 | `apps/api/src/services/telegram-app-handoff-v2.ts:1514`                                                                     | Handoff moves intent into funding/external-handoff state.                            | Link immutable operation and render common projection; retain handoff consent facts.                                                        |
| FLC-TLG-009 | `apps/api/src/repos/telegram-app-handoff-v2-direct-trade-repository.ts:406`                                                 | Direct trade repository reads executing/submitted/reconcile intent states.           | Trade submission remains business-specific; funding uncertainty comes only from operation.                                                  |
| FLC-TLG-010 | `apps/api/src/services/telegram-funding-sessions.ts:1074`                                                                   | Telegram session replay/supersession protects `observed/routing` receipt ownership.  | Use common receive lease/receipt facts; preserve cross-channel selection lock and never supersede money-bearing receipt work.               |
| FLC-TLG-011 | `apps/api/src/services/telegram-funding-sessions.ts:1180`                                                                   | Session release and current-selection checks branch on receipt/session state.        | Read the receive lease and canonical allocation/routing facts; preserve exact `Deposit already active` vs safe-new-deposit behavior.        |
| FLC-TLG-012 | `apps/api/src/services/telegram-bot-deposit.ts:94`                                                                          | BOT9/POR15 entry decides whether an active deposit blocks a new one.                 | Query only a real in-flight receipt/allocation or movement; empty/closed/late-observed session must not block.                              |
| FLC-TLG-013 | `apps/api/src/services/deposit-events.ts:629`                                                                               | Deposit-event matching and notification classify canonical receipt/provider outcome. | Retain canonical matching, outbox idempotency and notification generation; delivery failure never changes funding/receipt authority.        |
| FLC-TLG-014 | `apps/api/src/services/telegram-funding-progress-projector.ts:1` and `apps/api/src/services/telegram-funding-delivery.ts:1` | Progress and delivery independently cache/retry user-facing funding state.           | Render common operation/receipt projections into an idempotent outbox; delivery state is strictly one-way and cannot control actionability. |

### J. Adjacent resource and consumer state machines

These are intentionally retained. They are commonly adjacent to a funding
operation, but are not duplicate operation status and must not be deleted or
folded into the projector during the lifecycle cutover.

| ID          | Current location                                                                                                  | Current authority                                                    | Boundary to preserve                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLC-ADJ-001 | `packages/db/migrations/0184_funding_operations_core.sql:859` (`funding_route_observations`)                      | Provider route/quote observations and their diagnostic linkage       | Retain immutable identity, legal monotonic outcome/refund/recovery updates, and idempotency/source identity. The projector may consume an observation only through an explicit evidence policy. |
| FLC-ADJ-002 | `packages/db/migrations/0208_relay_evm_delegated_funding.sql:279` (`telegram_funding_authorization_reservations`) | Delegated authorization, allowance cleanup, refund/release evidence  | Retain its independently validated lifecycle and cleanup worker. A funding terminal outcome must schedule or await required cleanup without pretending this resource is a funding segment.      |
| FLC-ADJ-003 | `apps/api/src/funding/persistence/funding-trade-attempt-repository.ts:1`                                          | Consumer order idempotency, venue submission and final order outcome | Retain unchanged as the consumer of a ready reservation. It consumes/releases once; a failed or unknown venue submission is a trade recovery concern, not permission to re-spend source funds.  |
| FLC-ADJ-004 | Funding notification/outbox callers                                                                               | Delivery idempotency and user-visible progress                       | Keep notifications derived from a projection transition/outbox fact. Delivery/retry status must not feed back into money or actionability.                                                      |

### K. Account value and balance-conservation readers

Funding lifecycle does not own account-value presentation, but account value
must continue to consume the exact same reservation and evidence facts. This
is a money-safety boundary, not optional UI coverage.

| ID          | Current location                                                                    | Current condition                                                                                                     | Required replacement and proof                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLC-ACC-001 | `apps/api/src/account-value/funding-movement-feed.ts:1`                             | Reservations and finalized funding observations suppress source value and expose in-transit/destination/refund value. | Preserve exact movement feed semantics from canonical facts, never projection cache. Test reservation once, debit once, destination/refund once, reorg reversal and parallel-source no-double-subtract. |
| FLC-ACC-002 | Account-value API readers of the movement feed (resolve exact callers in inventory) | Display and routable balances consume movement classification while funding is in flight.                             | Add Web/Telegram/account-scope characterization fixtures for MAR15/MAR17/MAR19: stale projection cannot make money both available and reserved, or hide source value after finalized debit.             |

### L. SQL constraints and triggers

SQL must preserve structural/data-integrity guarantees, but it must not be a
venue lifecycle engine.

| ID          | Current location                                                                                                                    | Current condition                                                                                                  | Keep / move / delete                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLC-SQL-001 | `packages/db/migrations/0184_funding_operations_core.sql:130`                                                                       | Operation schema stores status/stage pair and validates allowed combinations.                                      | Keep operation header; replace pair check with a materialized projection-cache shape. No terminal-decision fields are added.                                                                                  |
| FLC-SQL-002 | `packages/db/migrations/0184_funding_operations_core.sql:330`                                                                       | Segment status check and actual/timestamp shape.                                                                   | Keep immutable segment shape and quote binding; delete mutable status/actual/timestamp fields.                                                                                                                |
| FLC-SQL-003 | `packages/db/migrations/0184_funding_operations_core.sql:430`                                                                       | Step state check, dependencies, immutable plan.                                                                    | Keep immutable plan/fingerprint/dependency FK; delete step state constraint/transition trigger.                                                                                                               |
| FLC-SQL-004 | `packages/db/migrations/0184_funding_operations_core.sql:760`                                                                       | Reservation ownership, amount, mode, state and timestamps.                                                         | Keep all reservation integrity rules.                                                                                                                                                                         |
| FLC-SQL-005 | `packages/db/migrations/0184_funding_operations_core.sql:1450`                                                                      | Step trigger both prevents plan mutation and validates mutable state transitions.                                  | Split: retain immutable-plan trigger, remove state-transition half.                                                                                                                                           |
| FLC-SQL-006 | `packages/db/migrations/0184_funding_operations_core.sql:2246`                                                                      | Deferred shape trigger invokes operation/segment validation.                                                       | Replace with venue-neutral graph/ownership/ordinal constraints only.                                                                                                                                          |
| FLC-SQL-007 | `packages/db/migrations/0190_funding_receive_sessions.sql:8`                                                                        | Session status both controls lease and represents routing/recovery.                                                | Drop status column; add `close_reason`, retain `closed_at`, expiry and observe window.                                                                                                                        |
| FLC-SQL-008 | `packages/db/migrations/0190_funding_receive_sessions.sql:112`                                                                      | Receipt status stores routing/review/ready/recovery projection.                                                    | Replace with immutable handling/link/result facts; public status derives.                                                                                                                                     |
| FLC-SQL-009 | `packages/db/migrations/0243_funding_receive_selection_lease.sql:11`                                                                | Lease/supersession semantics depend on session status.                                                             | Express indexes/query predicates through `closed_at`, receipt in-flight facts and `observe_until`.                                                                                                            |
| FLC-SQL-010 | `packages/db/migrations/0246_funding_polymarket_router_lifecycle.sql:49`                                                            | General shape function contains specific `polymarket_deposit_wallet_relayer_v1`, handoff kind and topology checks. | Remove venue topology from SQL. A versioned application validator runs inside the same immutable-commit transaction and persists `validatorId` + `validatorVersion` with the plan.                            |
| FLC-SQL-011 | `packages/db/migrations/0246_funding_polymarket_router_lifecycle.sql:178`                                                           | SQL forces unbound preparation-chain cardinality/order.                                                            | Keep only generic DAG acyclicity/ordinal/dependency structure; venue action topology moves to the frozen typed validator.                                                                                     |
| FLC-SQL-012 | `packages/db/migrations/0246_funding_polymarket_router_lifecycle.sql:363`                                                           | Reservation/observation binding is specialized by plan kind and venue chain.                                       | Preserve generic ownership and source identity; move route semantic cardinality to the typed validator.                                                                                                       |
| FLC-SQL-013 | All migrations, indexes, triggers, functions, deferred validators, policies, views and later migrations referencing deleted columns | A drop can fail or silently remove a query/index invariant if a dependent object is omitted.                       | Before any DDL, produce a checked-in dependency manifest with object name, defining migration, dependency, replacement/drop order, and disposable-PostgreSQL proof. The manifest is a release gate.           |
| FLC-SQL-014 | Every operation commit path                                                                                                         | A typed topology validator can be bypassed if another writer inserts a plan without invoking it.                   | Enforce a single `validateAndCommitFundingPlan` entrypoint; persist validator identity/version in immutable metadata in the same transaction. Add malformed-topology tests for every writer, not just Router. |

## One writer boundary

Create `recordFundingLifecycleFactInTransaction` in a dedicated lifecycle
repository. It is the only production path allowed to:

1. append an attempt/report/evidence;
2. lock the operation and required reservations;
3. load all projector facts;
4. call `deriveFundingLifecycle`;
5. apply idempotent reservation effects;
6. update the operation's materialized public projection and its
   `facts_revision` cache marker;
7. schedule, renew, complete, or dead-letter the reconciliation job;
8. publish presentation/outbox side effects after the projection is known.

Canonical receive-event allocation and authorization-reservation cleanup retain
their own writers (FLC-RCV-021..025 and FLC-ADJ-002), but each must invoke this
boundary after it records a fact that can affect funding actionability or
balance reservation. They may not directly update an operation/step/segment
projection. A trade-attempt writer similarly remains independent, but its
consume/release result must enter through this boundary before the next spend
is allowed.

The following writes must be eliminated or routed through that boundary:

```text
UPDATE funding_operations ... status/progress_stage
UPDATE funding_operation_steps ... state
UPDATE funding_operation_segments ... status/actual_*/timestamps
UPDATE funding_receive_sessions ... status
UPDATE funding_receive_receipts ... status
UPDATE funding_preparation_runs ... status
UPDATE funding_preparation_action_attempts ... state
```

Add an architecture test that searches production source for the expressions
above and allows them only in the lifecycle repository/migration files. This
is intentionally stricter than a code-review convention.

## Public response boundary

No frontend source needs to change. The API continues serializing the current
shape from one projector:

```text
FundingLifecycleProjection
  -> publicOperation()
  -> publicOperationSteps()
  -> publicPreparationRun() serializer
  -> receive session/receipt serializers
  -> Telegram card/progress serializer
```

The current global stop-list in
`apps/api/src/routes/funding.ts:392` is deleted. The replacement is exactly:

```ts
actionable = projection.actions.some(
  (action) => action.stepId === step.id && action.actionable,
);
```

There is no rule of the form "a stale aggregate status disables every action".

## Refactor order

This is three reviewable implementation changesets, not a long-lived dual
runtime and not one unsafe schema rewrite.

### Changeset 1 — characterize and centralize decisions

1. Add projector and exhaustive table tests.
2. Extract all `FLC-RED-*`, `FLC-WRK-*`, `FLC-API-*`, and `FLC-CAN-*`
   predicates into it without changing external behavior.
3. Add a `facts_revision` marker to identify stale materialized projection.
4. Change reducer, route actionability, cancellation, worker scheduling, and
   Telegram presentation to call it.
5. Existing mutable columns remain only as write-through cache temporarily.
6. Add differential tests: old current behavior and new projector output must
   match for every existing fixture/scenario before old path is removed.
7. Generate the FLC mechanical reader/writer inventory and classify every
   occurrence before changing its source-of-truth boundary.

**Exit gate:** all current unit/integration tests pass; Web and Telegram
projection parity passes; no unclassified reader/writer exists; and no reader
makes decisions directly from materialized aggregate state.

### Changeset 2 — remove duplicate preparation and receive authority

1. Materialize new preparation requests as normal `venue_preparation`
   operations/actions/attempts.
2. Adapt preparation endpoints to the unchanged run response.
3. Convert receive session to address lease and receipt to immutable inbound
   fact; derive their current public strings.
4. Convert Telegram funding branches to operation projection.
5. Stop all writes to preparation/session/receipt aggregate status fields.

**Exit gate:** preparation, direct receive, automatic conversion,
review-required conversion, session supersession, late receipt, Web/Telegram
handoff, Polymarket Router, Limitless, Relay EVM and Relay SVM scenario tests
pass unchanged in behavior.

### Changeset 3 — schema and LOC deletion

1. Run a read-only **zero-unsafe-money** preflight over every nonterminal
   operation and every terminal operation still within a provider/chain
   evidence window. The classifier must join action attempts and their
   broadcast outcome, step receipts and transfer evidence canonicality/finality,
   `funding_trade_attempts`, `balance_reservations`,
   `telegram_funding_authorization_reservations`, receive receipt/canonical
   allocation, and active reconciliation-job lease/deadline.
2. Preflight emits one of: `proven_no_money`, `settled`, `needs_reconcile`,
   `needs_manual_resolution`, or `unsafe_unknown`, with operation IDs and
   exact blocking facts. It is a deploy **release gate**: it must exit nonzero
   unless `needs_reconcile`, `needs_manual_resolution`, and `unsafe_unknown`
   have reached a settled/explicitly resolved outcome before services stop.
   The migration itself never raises on historical data.
3. Only `proven_no_money` rows may be terminalized automatically, and only
   after release effects are verified. Any possibly moved-money row completes
   reconciliation/compensation or a durable manual decision first; it is never
   force-terminalized for schema convenience.
4. Attach the FLC-SQL-013 dependency manifest, run the exact disposable
   PostgreSQL migration, and inspect the resulting dependency graph.
5. Apply one migration that removes only dead mutable projection columns,
   preparation tables, transition triggers/maps, and venue-specific lifecycle
   SQL.
6. Delete old repositories and status refresh/path-walk code.
7. Preserve generic FK, ownership, idempotency, immutable plan, reservation,
   dependency and JSON/amount constraints.

**Migration rule:** production deployment stops services for migrations. The
migration must not contain data-dependent `RAISE EXCEPTION` or speculative
legacy assertion. Preflight determines the exact cleanup scope before deploy.

## Required regression matrix

Every row below needs a traceable test. Existing tests cover many rows; the
refactor adds tests where coverage is only local or implementation-coupled.

| Scenario                                         | Mandatory assertions                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct internal funding                          | Exact source reservation, destination proof, ready/complete and release/consume exactly once.                                                                                |
| Relay EVM and SVM                                | Timeout after call never permits duplicate broadcast; polling reaches evidence without webhook.                                                                              |
| Composite/multi-source                           | pUSD + Polygon USDC.e + Base USDC sums only exact credited amounts; partial completion remains safe.                                                                         |
| Parallel root actions                            | Two independent funded legs are both actionable; a dependent leg activates only after every required predecessor succeeds.                                                   |
| Limitless                                        | Venue readiness and consumer reservation correctly gate Buy; no stuck prepare-only state.                                                                                    |
| Polymarket Router                                | Deposit-wallet pre-route, Router, Relay, external-wallet exclusion and production policy validator all preserve exact action scope.                                          |
| Preparation                                      | Existing endpoint response remains compatible while using common operation/actions/attempts.                                                                                 |
| Delegated authorization cleanup                  | Every reserved authorization reaches a verifiable cleaned, refunded, released, or explicit manual-recovery outcome; a terminal funding projection cannot silently orphan it. |
| Consumer trade attempt                           | Ready reservation is consumed once by one idempotent trade attempt; unknown/failed venue submission cannot make the source spendable twice.                                  |
| Pre-broadcast failure/cancel                     | No-money operation releases every affected reservation and cannot block a new Buy/Deposit.                                                                                   |
| Safe cancel before broadcast                     | An unexpired immutable action under a compatible safe terminal cancellation yields terminal/cancelled, zero actionable actions, and action-start rejects it.                 |
| Possible broadcast                               | Exact source remains protected; cancellation is reconciliation, never a false safe cancellation.                                                                             |
| Quote expiry                                     | Expiry before broadcast safely ends/requotes; expiry after broadcast never erases movement evidence.                                                                         |
| Provider timeout/late hash                       | Late provider reference binds to existing attempt only; never produces a second attempt.                                                                                     |
| Reordered/duplicate evidence                     | Same canonical facts yield identical projection; asset/location identity prevents double sum.                                                                                |
| Reorg                                            | Changed receipt/transfer canonicality recomputes the projection to reconciliation/recovery; it never re-executes an action.                                                  |
| Late broadcast/evidence after terminal candidate | No affected reservation is released until the recomputed safety projection proves that no money can still move.                                                              |
| Consumer expiry                                  | Ready consumer credit is released/abandoned exactly once and underlying operation is not left blocking.                                                                      |
| Receive supersession                             | Fresh Web/Telegram session replaces only empty old lease.                                                                                                                    |
| Late receive                                     | Transfer to closed address is detected until `observe_until`; cannot resurrect old address lease.                                                                            |
| Receive conversion/review                        | Receipt processing/review/recovery does not block a new receive address.                                                                                                     |
| Receive canonical allocation/retry               | Event identity deduplicates; allocation ambiguity/unavailability is retryable only through its bounded queue and never routes funds twice.                                   |
| Account-value conservation                       | Active reservation reduces availability once; finalized debit moves value once; destination/refund/reorg restores or remaps it exactly once across parallel sources.         |
| Cross surface parity                             | Web and Telegram return the same actionable, terminal and blocking-money classification for one operation.                                                                   |
| Concurrency                                      | Report vs observer, cancel vs broadcast, webhook vs poll, and two identical requests remain idempotent.                                                                      |
| Crash injection                                  | Crash before external call, after call before report, after report before evidence, and after evidence before projection converge safely.                                    |
| Liveness                                         | Every nonterminal operation has one or more compatible action/worker/receive/consumer/manual-recovery owners; valid parallel root actions remain visible.                    |

## Required commands before merge

Run from `hunch-monorepo/` after each changeset:

```bash
pnpm check
pnpm -F api run test:unit
pnpm -F api run test:integration -- \
  --database-url <disposable-url> --expect-database <database>
pnpm migrate -- --database-url <disposable-url> --expect-database <database>
pnpm -F api run funding:lifecycle-refactor-preflight -- \
  --database-url <disposable-url> --expect-database <database>
```

The integration/migration checks must target a disposable PostgreSQL database
with the same major version as production. Do not rely on TypeScript, unit
tests, or SQL string inspection to validate a changed SQL boundary.

`funding:lifecycle-refactor-preflight` is a required new read-only command,
not an alias for the current `funding:migration:preflight`: it must parse and
verify the explicit disposable/production target, emit the Changeset-3
zero-unsafe-money classifications, and return a nonzero exit code for any
unsafe row. It must never mutate production data.

## Completion checklist

- [ ] FLC-DOM traces migrated and old transition maps deleted.
- [ ] FLC-RED traces are pure projector predicates with no aggregate-status input.
- [ ] FLC-WRK traces schedule from explicit projection deadline/worker need.
- [ ] FLC-API and FLC-CAN use projector safety/actionability only.
- [ ] FLC-PER has one mutation boundary and an architecture test enforcing it.
- [ ] FLC-PER cancellation attempts and late-evidence recomputation are durable, idempotent and covered by tests.
- [ ] FLC-RCV uses address lease and receipt facts, not mutable session status.
- [ ] FLC-PRP tables/runtime removed and endpoint serializer preserves contract.
- [ ] FLC-TLG funding decisions consume common operation projection.
- [ ] FLC-ADJ resource/consumer state machines retain their own idempotency, cleanup and audit boundaries.
- [ ] FLC-ACC balance-conservation readers use canonical reservation/evidence facts.
- [ ] FLC-SQL dependency manifest is complete; generic structural constraints remain and venue semantics are frozen versioned validators.
- [ ] FLC-SQL existing attempt/evidence constraints and reconciliation-job ownership are proven in PostgreSQL.
- [ ] Changeset-3 zero-unsafe-money preflight passes before backend services are stopped.
- [ ] All regression-matrix cases and all pre-existing tests are green.
- [ ] Independent code review verifies no deleted state is still read or written.

## Expected LOC reduction

The exact count must be measured after implementation, but the planned
deletions include:

- the 32-node operation transition graph;
- segment transition graph and status path walking;
- standalone preparation repository/table lifecycle;
- receive-session derived-status refresh/write paths;
- duplicate Telegram funding status decision branches;
- venue-specific lifecycle logic from the generic SQL shape function.

The acceptance criterion is not a cosmetic LOC number. It is that every
funding lifecycle decision has one traceable predicate in the projector and
one mutation boundary, with fewer independent mutable state stores than the
current system.
