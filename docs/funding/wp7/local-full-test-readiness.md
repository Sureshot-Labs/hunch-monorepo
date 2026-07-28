# WP7 local full-test readiness

Date: 2026-07-28

Scope: the `unibalance` frontend and backend branches, compared with
`develop`. This document records local static/unit evidence only. It does not
authorize production activation and does not replace the database and
tiny-value matrices in [`verification-plan.md`](./verification-plan.md).

## Readiness decision

WP7 is ready to enter the local full-test matrix.

The source, type, lint, format, unit, and production-build gates are green.
Database-backed integration, restart/concurrency, and tiny-value venue tests
remain required before production activation because they need a migrated
Postgres instance and live/local venue fixtures.

## Correctness closures

| Area                    | Implemented invariant                                                                                                                                                                            | Local evidence                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Trade submission        | A settled reservation is claimed by one durable trade attempt before any external submit. `claimed` has a short owner lease; `submission_started` is the irreversible boundary.                  | Repository, schema, service, route, and frontend contracts compile; backend unit suite is green.                                               |
| Cancel/submit race      | Cancellation and submission lock the operation in the same order. Cancellation may release only a pre-submit claim; a started or ambiguous submission remains reconciling.                       | Targeted funding/trading tests and full backend unit suite are green. Database concurrency case is defined but still needs Postgres execution. |
| Order/execution linkage | Orders and executions carry the attempt identifier. Exact external identifiers can recover and consume an unresolved attempt even after the reservation TTL.                                     | Repository contracts and trade-link schema tests are green.                                                                                    |
| Limitless AMM           | Claim and start are separate server calls. The browser marks submission started before wallet broadcast and records an ambiguous transaction hash immediately after broadcast.                   | Frontend funding tests, backend schema tests, typecheck, and builds are green.                                                                 |
| Receive attribution     | Session start cursors are immutable. Polling covers overlapping sessions and canonical event allocation is persisted once. Cross-user ambiguity fails to recovery instead of guessing ownership. | Receive-session unit suite is green; persistence integration case is present and awaits Postgres.                                              |
| Receipt routing         | Routing persists attempts, bounded exponential retry, review/recovery disposition, error code, and worker counters.                                                                              | Receive routing unit contracts and finance-worker suite are green.                                                                             |
| User lifecycle          | Receive evidence, positions, and trade attempts prevent unsafe hard deletion/merge. Receive ownership FKs use `RESTRICT`.                                                                        | Auth/admin unit tests and migration review are green; database FK execution awaits Postgres.                                                   |
| Frontend rollout        | The frontend reads an explicit capability contract. Legacy fallback is limited to missing rollout endpoints (`404`), never arbitrary `5xx` failures.                                             | Funding compatibility tests are green.                                                                                                         |
| Mobile boundary         | Mobile funding uses a native mobile selector and does not import the root `@/ui` barrel. Desktop uses the desktop select implementation directly.                                                | Static boundary check, lint, typecheck, tests, and build are green.                                                                            |
| Finance worker          | The reconciliation worker module starts without importing API-wide secrets. API planning remains lazy and a routing failure is bounded/persisted rather than crashing the worker.                | Minimal-secret child-process import test and finance-worker suite are green. See the residual activation gate below.                           |

## Local verification results

| Gate                                    | Result                                                        |
| --------------------------------------- | ------------------------------------------------------------- |
| Backend API typecheck                   | Pass                                                          |
| Finance-worker typecheck                | Pass                                                          |
| Frontend typecheck                      | Pass                                                          |
| Backend API lint                        | Pass                                                          |
| Finance-worker lint                     | Pass                                                          |
| Frontend lint                           | Pass                                                          |
| Backend format check                    | Pass                                                          |
| Frontend format check                   | Pass                                                          |
| Backend targeted funding/trading suites | Pass, 5/5 suites                                              |
| Backend complete unit runner            | Pass, 121/121 files                                           |
| Finance-worker tests                    | Pass, 14/14                                                   |
| Frontend funding tests                  | Pass, 81/81                                                   |
| Frontend complete tests                 | Pass, 625/625                                                 |
| Backend API production build            | Pass                                                          |
| Finance-worker production build         | Pass                                                          |
| Frontend production build               | Pass with webpack; only existing optional-dependency warnings |
| Diff whitespace check                   | Pass in both repositories                                     |

The default Turbopack build attempt failed because the restricted local sandbox
forbids the helper process from binding a port. The webpack production build
completed successfully, so this was classified as an environment limitation,
not a source failure.

## Deterministic duplication audit

The bundled read-only analyzer was run with Type 1 and Type 2 normalization,
minimum 60 tokens and five code lines. Backend tests were excluded so test
fixtures did not dominate implementation metrics.

| Target                          | Mode   | Files / lines | Duplicate coverage | Redundancy ratio |
| ------------------------------- | ------ | ------------- | ------------------ | ---------------- |
| Frontend funding implementation | Type 1 | 43 / 7,231    | 0.00%              | 0.00%            |
| Frontend funding implementation | Type 2 | 43 / 7,231    | 6.44%              | 3.53%            |
| Backend funding + account value | Type 1 | 85 / 33,441   | 2.25%              | 1.12%            |
| Backend funding + account value | Type 2 | 85 / 33,441   | 11.58%             | 6.52%            |

The highest-impact frontend Type 2 candidates are repeated API mappers and
controller/position-state shapes. The highest-impact backend candidates are
repository row mappers, ingress adapters, observers, and receipt reconciliation
branches. Type 2 equality does not establish semantic equivalence; SQL lock
order, ownership scope, venue semantics, and terminal-state behavior must be
compared before extraction.

These metrics do not block the local correctness matrix. They do establish a
refactoring baseline: future structural work should reduce the Type 2
redundancy ratio without increasing Type 1 duplication or weakening
venue-specific invariants.

## Required local full-test sequence

1. Apply migration `0191_funding_wp7_correctness_closure.sql` to a disposable
   local Postgres instance.
2. Run the funding persistence and receive-session integration suites,
   including concurrent claim/start/cancel, stale claim lease, duplicate event,
   overlapping session, cross-user ambiguity, delete, and merge cases.
3. Start API, finance-worker, and frontend with the intended local secret
   profiles. Confirm that finance-worker boot does not require JWT/Privy
   secrets.
4. Execute receipt routing with at least one real observed receipt. The current
   lazy planning path still imports the API planning graph; if the finance
   process intentionally lacks API JWT/Privy configuration, the receipt must
   enter bounded retry/recovery and the worker must continue. Production
   activation of automatic child-operation creation remains blocked until this
   path has a dedicated sidecar-safe planning dependency graph or the process
   secret boundary is explicitly redesigned.
5. Execute the desktop/mobile, Buy/Sell, cancellation, reload, late-receipt,
   cross-chain, native SOL review, and tiny-value venue cases in
   [`verification-plan.md`](./verification-plan.md).
6. Verify database terminal states and absence of duplicate attempts, orders,
   executions, canonical receive events, and child operations.

## Activation blockers

The following are not source/unit blockers for local testing, but they remain
production blockers:

- migration `0191_funding_wp7_correctness_closure.sql` and the integration
  tests have not been executed against Postgres in this restricted review
  environment;
- no Docker, RPC, provider, venue, or tiny-value live call was made;
- the lazy receipt-planning graph is not yet fully sidecar-safe without
  API-wide configuration;
- the visual/timing matrix and restart evidence have not been collected;
- Type 2 duplication and the large Funding/preparation runtime files remain
  maintainability debt, not a proven runtime defect.
