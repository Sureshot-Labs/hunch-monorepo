# Funding WP3 implementation tracker

Status: **entry contract frozen; implementation not started**

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

## Planned verification

From `hunch-monorepo`:

```bash
pnpm migrate
pnpm -F api run test:fast
pnpm -F api run test:integration
pnpm -F api run typecheck
pnpm -F finance-worker run test
pnpm -F finance-worker run typecheck
pnpm -F finance-worker run lint
pnpm lint
pnpm exec prettier --check <WP3 touched files>
```

Migration and database tests run against local infrastructure only. Production
commands and live rehearsal are separate, explicitly authorized later gates.
The repository-wide format baseline currently has unrelated committed warnings;
WP3 uses a deterministic touched-file check and must not silently reformat
unrelated files. The full repository check remains a deliberate handoff gate.
