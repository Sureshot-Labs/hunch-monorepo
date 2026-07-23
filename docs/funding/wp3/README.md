# Funding WP3 implementation tracker

Status: **implemented and verified locally; not committed or deployed**

Date: 2026-07-23  
Branch: `unibalance`

## Objective

WP3 establishes the sole durable, restart-safe financial truth for new funding
operations before any production Relay adapter or executable planner is
connected.

It implements persistence, transactional repositories, exact observations,
reservations, reconciliation leases, lifecycle protection, and legacy
compatibility. It does not quote Relay, sign, broadcast, publish a funding
policy, activate a route, deploy, or mutate production.

## Already delivered

- WP1 owns provider-neutral contracts, strict schemas, normalized actions,
  transition maps, and the binary fail-closed funding policy.
- WP2 migration `0183_user_asset_funding_preferences.sql` owns
  `user_asset_funding_preferences`.
- WP3 consumes that preference table for future source ranking. It must not
  create a replacement or competing preference store.

New WP3 migrations therefore begin at `0184`.

## Delivered implementation

WP3 is implemented as an inactive durable control plane:

- the single squashed migration `0184_funding_operations_core.sql` adds the
  financial schema, lifecycle constraints, deterministic legacy tagging, user
  deactivation metadata, deferred segment-shape validation, and complete
  evidence-immutability guards;
- canonical quote/commit repositories enforce authenticated ownership,
  canonical payload hashing, exact idempotent replay, immutable consented
  plans, and transaction-wide creation of operations, steps, reservations, and
  jobs;
- an advisory transaction lock serializes concurrent commits for one
  `user_id + idempotency_key`, while database uniqueness remains the
  authoritative collision guard;
- destination, provider-request, attempt, observation, reservation, and lease
  repositories preserve encrypted-reference/HMAC separation and fail closed on
  ambiguous broadcast or allocation;
- webhook, polling, chain RPC, and venue API discoveries share one
  allocation-and-wake boundary and one reducer;
- the reducer consumes only canonical finalized observations, follows the WP1
  transition map, records actual amounts separately from consented amounts,
  releases source reservations, and handles refund/reorg recovery;
- Account Value reads active reservations, submitted debits, and durable
  in-transit claims while suppressing stale source representations;
- `finance-worker` runs the reconciliation batch independently of the legacy
  execution switch, with sidecar-local optional database configuration and
  PostgreSQL leases;
- merge, account deletion/deactivation, market retention, and legacy bridge
  creation tagging were integrated in the same lifecycle slice.

No funding HTTP commit/execute surface or provider adapter was added in WP3.
WP4 will attach provider observations and compatibility logic to these
boundaries; WP5 will add planning/route selection.

## Migrations

| Migration                          | Purpose                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0184_funding_operations_core.sql` | All WP3 tables; ownership, state, amount, evidence, lifecycle, and immutability constraints; observations, reservations, and leases; transaction-local terminal merge context; active-only destination uniqueness; one-way ciphertext shredding; user financial lifecycle fields; Telegram ownership FK; corrected deferred segment-shape validation; and deterministic legacy classification/backfill |

During local development, follow-up migrations `0185`–`0189` captured defects
found by integration tests and the final invariant audit. Before any commit or
production application, their final definitions were folded into `0184`.
The existing local database was reconciled transactionally to the same catalog
fingerprint as a clean 193-migration database, then the normal migration runner
confirmed the database was up to date. No production ledger was rewritten.

## Work slices

### WP3A — additive schema and database invariants

Add:

- `funding_quotes`;
- `funding_withdrawal_destinations`;
- `funding_operations`;
- `funding_operation_segments`;
- `funding_provider_requests`;
- `funding_operation_steps`;
- `funding_operation_step_attempts`;
- `funding_observations`;
- `balance_reservations`;
- `funding_route_observations`;
- `funding_reconciliation_jobs`;
- nullable `telegram_trade_intents.funding_operation_id`;
- safe legacy adapter-version/tag support where the frozen classifier is
  deterministic.

Mandatory database properties:

- real `users(id)` ownership with deliberate `ON DELETE RESTRICT` for durable
  financial rows;
- composite user/quote ownership;
- unique user idempotency keys and canonical payload hashes;
- one provider segment at ordinal zero in the initial product;
- exact status/stage and plan-kind constraints;
- unique observation allocation by network/transaction/event/asset;
- separately versioned lookup HMAC columns for provider references and
  addresses;
- no secret, plaintext authorization material, or provider DTO as a domain
  column.

The merge, deletion, retention, protected-reference, and crypto-shredding
rules must be updated in the same schema slice, not deferred until cleanup.

### WP3B — atomic repositories and reducer

Implement one repository transaction boundary that:

1. verifies authenticated quote ownership, expiry, policy, selected source,
   destination, venue binding, exact amounts, and plan hash;
2. rejects idempotency-key reuse with a different canonical payload;
3. creates the operation, zero-or-one segment, immutable steps, initial job,
   and reservation atomically;
4. applies only transitions declared by the WP1 transition map;
5. records actual amounts without mutating the committed plan;
6. consumes or releases reservations through an explicit linked consumer.

The API remains a thin authenticated commit/read/wake boundary. It does not own
reconciliation or provider state reduction.

### WP3C — observations, in-transit truth, and finance-worker

Implement:

- explicit source, destination, refund, and venue-readiness observations;
- deterministic allocation that never first-matches one transfer to concurrent
  operations;
- finality, canonicality, and reorg-aware derived reduction;
- source -> in-transit -> destination/refund single-representation feeds for
  Account Value;
- durable `funding_reconciliation_jobs` wake-up and leases using PostgreSQL
  `FOR UPDATE SKIP LOCKED`;
- bounded lease renewal/reclaim, duplicate wake-up, restart, timeout, and crash
  recovery;
- webhook enqueue and scheduled polling through the same idempotent reducer;
- estimated versus actual provider/network/sponsorship/rent costs.

The existing process-local finance-worker lock may remain a scheduler guard,
but it is never a financial lease or duplicate-broadcast guarantee. The worker
must use sidecar-safe optional funding configuration and must not transitively
import API-wide required-secret modules.

### WP3D — lifecycle, legacy compatibility, and operations

Implement:

- merge preflight that locks both users and rejects non-terminal movement,
  ambiguous attempts, and live reservations;
- deletion/deactivation/pseudonymization behavior from the WP0 lifecycle
  matrix;
- market-retention protected references and derived/delete reports for every
  new market/user-visible reference;
- notification events that never act as settlement evidence;
- deterministic historical Bungee/Across/deBridge classification and
  versioned reconciliation dispatch;
- additive legacy tagging only where the frozen classifier is unambiguous.

Legacy bridge rows are never rewritten into Funding Operations. Existing
reconcilers remain until terminal, retention, and support gates all pass.

## Hard safety boundaries

- Funding `creationMode` remains `off`.
- `PRODUCTION_FUNDING_REGISTRY` remains empty during WP3.
- No Relay/provider request, wallet signature, transaction, policy publication,
  production migration, deployment, or live rehearsal is part of WP3.
- Migrations are additive; rollback disables creation and never deletes active
  financial evidence.
- Unknown state, status, adapter version, observation allocation, ownership, or
  possible broadcast fails closed to reconciliation/support.

## Acceptance evidence

WP3 is complete only when:

- clean and representative pre-feature migrations pass locally;
- database integration tests prove ownership/IDOR, idempotency, atomic commit,
  transition, segment-count, observation-allocation, reservation, finality,
  reorg, lease, restart, and ambiguous-broadcast invariants;
- merge/deletion/retention tests cover every new table and reference;
- legacy classifier reports zero unknown active adapter versions and does not
  mutate historical provider identity;
- Account Value receives durable reservation/submitted-debit/in-transit feeds
  without double counting;
- API, finance-worker, type, lint, formatting, and focused regression checks
  pass;
- no provider execution path is reachable.

## Verification evidence

Completed locally on 2026-07-23:

- the final repository contains one WP3 migration, `0184`, with checksum
  `567af5581833d39f97c760506dba6ec60a48bb8a82a52aab18ccf509f8dadeec`;
- an isolated empty database applied all 193 repository migration files through
  `0184`, exposed all 11 WP3 tables and their evidence guards, and passed the
  complete WP3 persistence integration suite;
- the existing local database was transactionally reconciled from the
  development-only `0184`–`0189` ledger to the final `0184` checksum. Its
  columns, constraints, functions, indexes, lifecycle columns, and triggers
  have the exact same catalog fingerprint as the isolated database, and
  `pnpm migrate` reports `Migrations up to date`;
- concurrent identical commits produced one operation and one exact replay;
- a failure after operation insertion rolled back the operation, children,
  job, and quote consumption;
- DB integration coverage passed for IDOR/ownership, changed-payload
  idempotency conflict, one-segment enforcement, invalid state/stage,
  destination revocation/crypto-shredding, provider request identity, ambiguous
  attempt retry blocking, observation dedupe/allocation, finality, reorg,
  reservations, durable Account Value facts, stale-source suppression,
  duplicate wake-up, lease exclusion, stale-token rejection, expired-lease
  reclaim, active-route merge blocking, terminal route reassignment, hard
  deletion, active-route deletion blocking, and retention-aware deactivation;
- market-retention integration tests report `funding_operations` as a protected
  reference;
- representative local legacy data has 270 classified rows and zero unknown
  active or unknown total adapter versions;
- all WP3 integration tests clean up or roll back; the final local audit showed
  zero rows in all 11 WP3 tables;
- API fast suite passed 22/22 files, finance-worker tests passed 9/9, repository
  typecheck passed 12/12 packages, lint passed 11/11 packages, and the full
  repository build and format check passed.

The repository-wide API integration runner is not claimed as green: after
`auth-tests` passed 40/40, it stopped on the `clusters-routes-tests`
ascending-order assertion, outside the changed funding surface. The WP3
database integration suite and the dedicated market-retention integration
suite both pass independently.

The DB suite and final invariant audit exposed and repaired issues that a
schema-only review would not catch: the deferred segment-shape trigger targeted
the wrong key on operation rows; timestamp parameters needed explicit
`timestamptz` typing; terminal provider/route/attempt/observation evidence and
actual segment amounts needed stronger one-way immutability; a successful
attempt could otherwise be retried; and a finalized refund discovered without
a prior source observation needed to infer the segment submission timestamp.
All fixes now live directly in `0184` and are covered by clean-DB and
existing-DB integration tests.

The following commands are the repeatable verification surface:

From `hunch-monorepo`:

```bash
pnpm migrate
pnpm -F api run test:fast
pnpm -F api run test:integration
pnpm -F finance-worker run test
pnpm typecheck
pnpm lint
pnpm build
pnpm format:check
```

Migration and database tests run against local infrastructure only. Production
commands and live rehearsal are separate, explicitly authorized later gates.

## Completion boundary

WP3 is complete locally. Funding remains deliberately unusable:

- default `creationMode` is `off`;
- quote, commit, and start-unsubmitted-action gates are false;
- `PRODUCTION_FUNDING_REGISTRY` has no provider adapter, action validator,
  network executor, or reconciler;
- the new persistence/reconciliation modules contain no HTTP/provider,
  signing, or broadcasting call;
- no production migration, configuration change, commit, deployment, policy
  publication, or live transaction was performed.
