# Funding WP1 implementation status

Status: **domain, fail-closed control plane, authenticated route tests, and
operator UI implemented; no product route or policy has been activated.**

Date: 2026-07-23  
Branch: `unibalance`

## Implemented

- Provider/venue-neutral domain vocabulary for exact assets, raw-unit money,
  capability-bearing locations, ownership, projections, funding intents,
  opaque source/destination/binding options, normalized actions, execution
  plans, preparation, position actions, provider adapters, action validators,
  and network executors.
- Strict authenticated discovery, selected-source quote, commit, market-context,
  money, location, recipient, and normalized-action schemas. Client authority
  fields are rejected by strict request schemas.
- A single operation `(status, stage)` transition map plus segment transitions.
  Invalid combinations, terminal regressions, and undeclared states fail closed.
- Pure current-intent Trading Wallet selection. Position-owner binding is
  mandatory for Sell/Redeem; an explicit valid current-intent choice beats the
  internal default; observed external balance never selects a wallet.
- Pure destination selection. One valid destination may be selected
  automatically; multiple valid destinations require an opaque explicit choice.
  `recommended` is never treated as authorization.
- Immutable funding runtime policy v1 with a conservative default:
  `creationMode=off`, quote/commit/unsubmitted-action gates closed, and
  reconciliation/webhook/polling/refund/recovery/worker-drain gates open.
- Static production component registry. An enabled route must bind exact
  production adapter, validator, executor, reconciler, refund, observer, and
  fixture IDs. Fixture/simulator components cannot be published.
- Section 21 cross-field validation for exact asset/location capability,
  venue lifecycle/readiness, delegated caps/policies, route evidence, strict
  Deposit Address rules, fallback bans, inline evidence, owner binding, and
  initial product invariants.
- Constructor-injected local simulator interfaces kept outside the production
  policy registry/import graph.
- Dedicated admin permissions and API:
  - `GET /admin/funding/policy` — `funding:read`;
  - `POST /admin/funding/policy/diff` — `funding:write`;
  - `POST /admin/funding/policy/publish` — `funding:write`.
- Publication recomputes the candidate revision under a PostgreSQL advisory
  transaction lock, compares the current revision, requires the exact diff
  confirmation string, and appends an immutable `runtime_policies` row.
  Invalid stored policy falls back to the frozen `off` default.
- Dedicated `hunch-admin` Funding Control Plane page:
  - viewers can read the effective source, revision, creation status, gates,
    configuration counts, and complete JSON;
  - admin/sadmin writers edit a complete snapshot and must obtain a normalized
    server-side validation/diff before publication;
  - any draft edit invalidates the preview;
  - publication stays disabled for an invalid/no-op/stale preview and requires
    the exact server phrase bound to current and candidate revisions;
  - a `409` stale-revision response discards the preview and forces refresh.
- Fastify injection tests cover unauthenticated read rejection, viewer read,
  viewer write rejection, write CSRF, valid preview, exact confirmation,
  admin-account actor attribution, and stale-revision conflict.

No database migration was required: publication reuses the existing immutable
`runtime_policies` table under the key `funding_control_plane`.

## Deliberately inactive

`PRODUCTION_FUNDING_REGISTRY` contains no provider adapter, action validator,
network executor, reconciler, refund implementation, destination observer, or
route fixture registration yet. Consequently no route can pass publication.
Those concrete registrations belong to later adapter/execution work packages.

No funding policy row was published while implementing WP1. The effective
runtime behavior remains the in-code fail-closed default.

## Verification

```bash
pnpm -F api exec node --import tsx src/funding-domain-tests.ts
pnpm -F api exec node --import tsx src/admin-funding-routes-tests.ts
pnpm -F api exec node --import tsx src/admin-auth-tests.ts
pnpm -F api run test:fast
pnpm -F api run typecheck
```

From `hunch-admin`:

```bash
npm run build
npm run lint
npm run format:check
npm run check:unimported
```

The funding contract suite is included in API `test:fast`. It covers raw-unit
arithmetic boundaries, strict request authority, custom location extensibility,
opaque wallet/destination selection, all declared transitions, creation-off
behavior, Section 21 publication failures, fixture-adapter exclusion, strict
Deposit Address rejection, deterministic revisions/diffs, append-only
publication, invalid-row fallback, dedicated admin route permissions, and the
authenticated HTTP route flow.

## WP1 completion boundary

WP1 code and acceptance evidence are complete. This does not authorize policy
publication or route activation. The first non-empty production component
registrations must be reviewed during WP4; until then the empty production
registry intentionally rejects every active route.
