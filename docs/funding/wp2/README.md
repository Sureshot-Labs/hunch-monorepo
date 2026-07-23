# Funding WP2 implementation status

Status: **code and contract implementation complete; migration, runtime policy,
deployment, and product activation have not been performed.**

Date: 2026-07-23  
Branches: `unibalance` in `hunch-monorepo`, `Hunch_App`, and `hunch-admin`

## Implemented

### Backend domain and runtime

- `ExistingFactsOwnershipResolver` builds network-scoped wallet profiles,
  venue-account bindings, opaque identifiers, and a deterministic evidence
  revision from existing linked-wallet, derived-funder, and venue-credential
  facts. It does not create a second account registry or grant signing rights.
- Inventory reuses the existing balance-wallet resolver and balance collectors.
  It observes only positive balances for exact configured assets, validates
  returned decimals, records collector failures, and canonicalizes by account,
  economic location, exact network/asset identity, and balance class.
- Same-location observations and same-position components are deduplicated.
  Conflicting observations with the same timestamp fail closed instead of
  choosing a value.
- All value arithmetic uses raw strings and `bigint`-backed decimal helpers.
  JavaScript floating point is not used for backend value, lock, position, or
  projection arithmetic.
- `ValuationService` owns the ordered price-adapter boundary, freshness,
  metadata risk, stable impairment, valuation eligibility, and execution
  eligibility. Exact-contract stable policies cover:
  - Polygon pUSD, USDC.e, and native USDC;
  - Base USDC;
  - Solana USDC.
- A policy can disable observation or valuation for an exact asset, mark an
  exact stable as impaired, or register an additional token. A registered token
  remains unpriced until an explicit production price adapter supports its
  policy ID.
- `AccountValueProjector` returns cash, token, in-transit, total liquid,
  positions, and total portfolio estimates separately. The effective headline
  is a display-only view over those components.
- `CashAvailabilityProjector` subtracts open-order locks, reservations, and
  submitted debits without reducing Account Value. Unknown lock state yields
  no available estimate and marks the projection partial/stale.
- Source, in-transit, destination, and refund representations sharing one
  movement ID are mutually suppressing, so only the most advanced observed
  representation contributes to value or availability.
- Thin Polymarket and Limitless position collectors reuse the positions and
  canonical market repositories. They value unresolved positions from the
  side-specific bid, resolved positions from exact outcome evidence, preserve
  raw database numeric text, deduplicate backend representations, and propagate
  stale/unpriced state. Kalshi positions remain visible but deliberately
  unpriced.
- The read model returns per-venue cash, available cash, position, and portfolio
  summaries plus completeness, freshness, collector errors, policy revision,
  ownership evidence revision, and duplicate count.

### Authenticated API

- `GET /account/value`
- `GET /account/assets`
  - category and valuation-eligibility filters;
  - bounded `limit` of 1–200;
  - opaque component cursor and `nextCursor`.
- `PATCH /account/assets/:componentId/funding-preference`
  - accepts only `ask`, `suggest`, or `never_suggest`;
  - first proves that the component belongs to the authenticated projection;
  - explicitly returns `grantsTransactionAuthority: false`.

The API is strict-schema validated. Projection failure returns an unavailable
response; it never substitutes a successful zero-valued account.

### Preference lifecycle

Migration `0183_user_asset_funding_preferences.sql` adds the user-scoped
preference table with an exact component primary key, canonical selector
fields, constrained values, monotonic revision, and `users(id)` cascade delete.

The account-merge path now copies source preferences to the target. Identical
preferences are retained; conflicting preferences reset to `ask` and advance
the revision. A normal merge removes the source rows, while `keepSource`
preserves them. This implements the WP0 user-data lifecycle rule.

Preferences only rank future suggestions. They cannot change execution
eligibility, authorize a transaction, mutate an operation snapshot, or select
a wallet.

### Frontend

- One React Query client reads the backend Account Value model.
- Header, desktop/mobile Wallet, and desktop/mobile Portfolio now consume the
  backend headline and venue summaries instead of recomputing value locally.
- The old `wallet-venue-totals` business calculation and its tests were
  removed. Header-local total functions were removed as well.
- Positions remain a separate API component and a separate displayed total
  regardless of headline mode.
- Partial, stale, unpriced, loading, and unavailable states have distinct
  presentation. A first-load failure renders unavailable, never `$0`.
- Cached data is marked stale after a refetch error.
- Non-Polymarket trade surfaces select cash for the exact active wallet and
  venue binding. A missing, stale, unpriced, or errored cash projection fails
  closed. Polymarket Buy retains its existing funder-aware buying-power
  resolver because signer/deposit-wallet/funder execution topology is more
  specific than the WP2 account projection.
- Account Value is invalidated after portfolio synchronization.

## WP2 completion evidence

| Requirement                                      | Evidence                                            | Result |
| ------------------------------------------------ | --------------------------------------------------- | ------ |
| Value, availability, and dedup property tests    | `account-value-tests.ts`                            | Pass   |
| Exact token price boundary without Buy authority | priced-token projection test                        | Pass   |
| Headline mode cannot change liquidity            | backend and frontend selector tests                 | Pass   |
| Partial/stale/unpriced rendering                 | API flags and desktop/mobile consumers              | Pass   |
| No local headline recomputation                  | removed helpers plus source search                  | Pass   |
| Auth and component ownership                     | Fastify injection tests                             | Pass   |
| Preference lifecycle                             | merge tests and migration                           | Pass   |
| Ordinary regression suite                        | API `test:fast`, frontend `bun test`                | Pass   |
| Production builds                                | API TypeScript build path and Next production build | Pass   |

## Verification

From `hunch-monorepo`:

```bash
pnpm -F api exec tsx src/account-value-tests.ts
pnpm -F api exec tsx src/admin-merge-user-tests.ts
pnpm -F api run test:fast
pnpm -F api run typecheck
pnpm -F api run lint
pnpm exec prettier --check \
  apps/api/src/account-value \
  apps/api/src/account-value-tests.ts \
  apps/api/src/routes/account-value.ts \
  apps/api/src/schemas/account-value.ts
```

Final results:

- Account Value focused tests: 15/15.
- User-merge focused tests: 4/4.
- API fast suite: 20/20 test files.
- API typecheck, lint, and formatting: pass.

From `Hunch_App`:

```bash
bun test
bun run type-check
bun run lint
bun run format:check
bun run build
```

Final results:

- Tests: 533/533.
- Typecheck, lint, and formatting: pass.
- Next.js production build: pass.

No live RPC, provider, wallet, transaction, deployment, or production database
mutation was part of WP2 verification.

## Deliberately inactive or deferred

- Migration `0183` exists but has not been applied.
- No funding policy row was published and the WP1 production registry remains
  empty. No quote, commit, Relay route, or executable Funding Operation is
  activated.
- Generic non-stable token pricing has a production adapter boundary but no
  registered runtime adapter. Such tokens are truthfully unpriced.
- The in-transit projector is implemented, but live in-transit inputs require
  WP3 durable operations and observations.
- Reservation and submitted-debit fields are modeled; their durable runtime
  feeds belong to WP3.
- Embedded/smart/external classification is conservative when the persisted
  wallet facts do not carry a Privy profile source. Unproven wallets receive
  web-client signing only, with no delegated or sponsorship authority. A cached
  Privy-profile evidence port should enrich this before managed execution in
  WP5.
- The runtime currently reuses balance helpers exported by the wallet route
  module. Moving those helpers to a focused inventory port would improve module
  ownership without changing behavior.
- The read model relies on underlying short-lived wallet caches and frontend
  query caching. A component-revision keyed derived Account Value cache remains
  a performance improvement before broad rollout.
- The code returns the effective `creationMode`, but deployment sequencing must
  still respect the activation ladder: compare in `shadow`, then expose only in
  an approved `internal` or later stage. This branch was not activated.

## WP2 completion boundary

WP2 is complete as a code, schema, API, projection, frontend-integration, and
test milestone. It is not a claim that unified funding is production-ready.
WP3 must add durable operations, observations, reservations, and reconciliation
before WP4 can safely connect Relay execution.
