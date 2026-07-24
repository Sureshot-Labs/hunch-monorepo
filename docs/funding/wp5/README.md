# WP5 Destination, Placement, Intent Liquidity, and Planner

Status: **implementation-complete and locally verified on 2026-07-24. The WP6
real-adapter prerequisite is now satisfied locally; activation remains blocked
by WP7/WP8 caller migration, WP9 evidence, and runtime policy.**

This evidence is based on the `unibalance` worktree after committed baseline
revision `52029b0`; the baseline documents through WP4 are already committed.
The current WP5 implementation and WP5 evidence changes were not committed or
deployed by Codex. Local migration `0185_funding_planner.sql` was applied to the
development database for integration verification.

## 1. Delivered boundary

WP5 now provides:

- pure exact-raw-unit Placement Policy for Add Funds, trade shortfall,
  conversion, and withdrawal;
- exact collateral-to-USD valuation from fresh frozen price evidence, with no
  JavaScript floating-point arithmetic and no invented zero-dollar success;
- destination spendability derived from observed cash minus explicit locks,
  reservations, and submitted debits, with revision and expiry validation;
- an explicitly requested trade buffer bounded independently by raw percentage
  and USD policy caps; no blanket maximum buffer is added;
- an explicit rejection of manual/automatic rebalance and chained funding where
  one route spends another route's output;
- opaque destination enumeration and deterministic recommendation without
  treating a recommendation as consent;
- deterministic current-intent Trading Wallet precedence that never considers
  balance size;
- frozen side-effect-free Polymarket and Limitless destination adapters over
  the WP6 inspection contract;
- distinct Polymarket signer, Magic proxy, Safe-like, and Deposit Wallet
  topology facts;
- distinct Limitless CLOB and AMM market-class facts;
- a dependency-injected Relay-first source orchestrator that consumes only
  fresh, owned, transferable, risk-eligible, execution-ready source facts,
  resolves one exact source/destination location-pattern route, and calls no
  fallback provider;
- Relay-only exact route validation by route ID, capability, adapter/version,
  source/destination patterns and assets, output, fees, slippage, encrypted
  provider reference, and expiry;
- route economics using the lower of absolute and percentage warning/rejection
  thresholds, a minimum one-dollar destination value, and fail-closed
  destination pricing;
- a 1.5-second per-Relay-quote budget and a 3.5-second total source-planning
  budget, enforced with abort signals and without hedged or fallback calls;
- measured route classification from durable
  `funding_route_observations`; missing or insufficient evidence is
  `prepare_first`;
- immutable, owned, expiring Intent Liquidity projection persistence;
- immutable quote creation with one selected source option, exact raw amounts
  for each frozen source leg, plan hash, and an opaque consent token;
- idempotent operation commit with policy and ownership revalidation inside
  the commit transaction;
- authenticated, user-scoped, fail-closed public endpoints for destinations,
  liquidity, quotes, commit, operation read, and operation history;
- fail-closed per-user endpoint rate limits;
- safe public operation summaries that omit internal plan/provider snapshots;
- projection cleanup for expiry, account deletion, and user merge;
- market-retention protection for live projections and explicit dry-run/delete
  cleanup of expired projection references;
- admin policy typing for measured route-experience thresholds.

At WP5 completion the production destination runtime deliberately returned no
invented PM or Limitless readiness fact and the production funding registry had
no network executor. WP6 may register exact wallet-profile executors only behind
its owner-bound action boundary. Creation gates remain off by default; the WP5
planner itself cannot broadcast, prepare a wallet, provision, connect, approve,
trade, redeem, or deploy.

## 2. Acceptance evidence

| WP5 criterion                                                             | Evidence                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add Funds 100 is not reduced to a viewed trade or existing-cash shortfall | Exact tests keep `100000000` raw for Add Funds while a 5-unit trade with 2 available produces `3000000` raw shortfall.                                                                                      |
| No Base parking or automatic rebalance                                    | Placement rejects `manual_rebalance`; every leg is one exact route to the immutable destination and no leg spends another leg's output.                                                                     |
| Client cannot choose provider or destination address                      | Strict request schemas reject extra `providerId` and `destinationAddress`; quote accepts only owned opaque projection/source IDs.                                                                           |
| Multiple no-context destinations require a choice                         | Planner returns `destination_selection_required` even when one internal destination competes with a much larger external balance.                                                                           |
| Quote freezes one source and exact amounts                                | Quote tests reject changed raw amounts, source mismatch, destination/binding/placement mismatch, stale ownership, and stale policy.                                                                         |
| Balance size does not choose Trading Wallet                               | Binding precedence consumes only position ownership, explicit current-intent choice, and internal default; balances are not an input.                                                                       |
| PM topology remains distinct                                              | Frozen adapter fixtures cover signer/EOA, Magic proxy, Safe-like, and Deposit Wallet.                                                                                                                       |
| Limitless CLOB and AMM remain distinct                                    | Separate market-class fixtures and inspection revisions are required; generic wallet readiness is not consumed.                                                                                             |
| Unknown route speed is Prepare Funds                                      | Null/insufficient observations classify as `prepare_first`; actual local DB observations are aggregated into count, success, and p95 latency.                                                               |
| Relay is asked first without a provider menu                              | The source orchestrator ignores non-Relay routes, skips ineligible source facts before quoting, calls one exact Relay route, and rejects ambiguous duplicate mappings.                                      |
| Disabled/unfundable route fails closed                                    | Disabled route/provider/capability, unknown fee/price, excess absolute or percentage cost, excess slippage, stale expiry, insufficient output, or non-Relay/staged plan becomes unavailable or is rejected. |
| Cash and USD fields are truthful                                          | Fresh spendability evidence subtracts locks/reservations/submitted debits; stale or incomplete evidence prevents quoting; exact unit-price tests return nonzero USD values.                                 |
| Quote calls are bounded                                                   | Tests prove the 1.5-second Relay timeout input and abort an unresolved quote under a tightened test budget before route observations are read.                                                              |
| New market references satisfy retention                                   | A live `planner_snapshot.marketContext.marketId` protects the market; an expired projection is reported as cleanup-derived state and does not protect deletion.                                             |
| No WP6 side effects                                                       | Destination adapters consume frozen `PreparationResult` snapshots only; production wiring does not call `prepare`.                                                                                          |

## 3. Persistence

Migration `0185_funding_planner.sql` adds
`funding_liquidity_projections`:

- opaque projection ID plus authenticated `user_id`;
- canonical request, public projection, and internal planner snapshots;
- policy and ownership revisions;
- strict expiry and JSON object checks;
- an immutable-update trigger;
- user/expiry indexes;
- `on delete cascade` because unquoted discovery is ephemeral, not financial
  evidence.

Live projection market-context references participate in the market-retention
protected set. Expired references are reported by the retention dry-run and are
deleted transactionally before a selected market is deleted. Post-delete
validation rechecks the same protected-reference query to catch races.

Quotes remain independent immutable evidence. Expired projections may be
deleted after quote creation because every selected source, route, placement,
destination, binding, policy revision, and exact amount is frozen into
`funding_quotes`.

## 4. Public API delivered in WP5

```text
GET  /funding/destinations
POST /funding/liquidity
POST /funding/quotes
POST /funding/operations
GET  /funding/operations/:id
GET  /funding/operations
```

WP6 owns preparation/action endpoints. WP5 does not add a transaction submit
surface.

## 5. Verification record

Passing checks:

- `pnpm format:check`;
- `pnpm typecheck`;
- `pnpm lint`;
- `pnpm build`;
- `pnpm -F api run test:fast` — 29/29 selected API files, including the new
  planner and public-route suites;
- `node --import tsx apps/api/src/funding-planning-integration-tests.ts`;
- `node --import tsx apps/api/src/market-retention-tests.ts`;
- `hunch-admin: npm run format:check`;
- `hunch-admin: npm run lint`;
- `hunch-admin: npm run check:unimported`;
- `hunch-admin: npm run build`.

The local DB verification covered projection ownership isolation, immutable
updates, expiry, cleanup, and aggregation of three completed route
observations into count, success count, and p95 latency. It also covered live
projection market protection and expired-projection cleanup reporting. Tests
cleaned their temporary rows.

The deterministic read-only duplication audit used Type 1 and Type 2,
`min-tokens=60`, and `min-lines=5` over 15 WP5 production files (planner,
persistence, routes, schemas, and admin policy surface):

- Type 1 final: 0 clone classes, 0% duplicate coverage;
- Type 2 review baseline: 5.87% duplicate coverage;
- Type 2 final after consolidating route authorization/rate-limit/error
  handling: 5.55% duplicate coverage.

Remaining Type 2 matches are declarative Fastify route registrations and small
schema/runtime boundary shapes. They contain no copied placement, provider,
venue-status, authorization, or error-mapping business logic.

## 6. Review findings closed before handoff

The final review corrected:

- backward compatibility for previously stored policies without the new
  route-experience object;
- an over-broad internal-default filter that could have hidden a legitimate
  second no-context destination;
- purpose, owner, settlement-location, asset, topology, and inspection-revision
  checks on frozen venue facts;
- exact policy-to-quote route capability, adapter/version, and asset matching;
- the missing orchestration boundary between eligible source facts and the
  Relay quote adapter, including duplicate exact-route publication rejection;
- unknown fee, fee cap, and slippage fail-closed handling;
- exact USD valuation and locked/reserved/submitted-debit spendability instead
  of placeholder liquidity values;
- requested-only buffer handling with both raw and USD caps;
- absolute/percentage warning and hard fee limits, minimum destination value,
  and fail-closed destination pricing;
- bounded Relay and total planner quote time;
- preservation of exact but economically unavailable Relay quotes as typed
  unselectable source options rather than silent omission;
- source-option uniqueness, expiry, output, and exact single-leg/composite-leg
  shape validation in core, independent of adapter behavior;
- quote-to-source/destination/binding/market/placement canonical equality;
- consent-token prefixing to satisfy the opaque-ID contract deterministically;
- policy and ownership revalidation under the locked quote transaction;
- safe public operation history without internal provider or address
  snapshots;
- market-retention protection, cleanup reporting, delete ordering, and
  post-delete validation for the projection JSON market reference;
- duplicated public-route authorization/rate-limit/error wrappers.

## 7. WP6 handoff

WP6 may now install real side-effect-free PM/Limitless inspection adapters and
action construction behind the frozen contracts. It must not weaken any WP5
selection, ownership, amount, route, economics, quote, or commit guard.

The first WP6 integration milestone is fixture parity only:

1. bind current PM/Limitless facts to `FrozenPreparationDestination`;
2. keep `inspect` side-effect free;
3. preserve exact purpose, market class, topology, and inspection revision;
4. leave creation policy off;
5. prove preparation postconditions before enabling any action executor.
