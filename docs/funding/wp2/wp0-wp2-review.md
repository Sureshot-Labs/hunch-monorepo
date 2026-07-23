# Unified funding review: WP0 through WP2

Date: 2026-07-23  
Scope: committed WP0/WP1 work plus the then-uncommitted WP2 implementation
Original safety boundary: no commit, push, deployment, migration application,
policy publication, Privy change, or live transaction. A post-review addendum
below records the later local migration and read-only DB/RPC validation.

## Executive verdict

WP0 through WP2 form a coherent and largely correct foundation. The domain has
one owner for value, separates ownership value from spendability, preserves
exact asset identity, fails closed on ambiguity and stale execution inputs, and
removes the conflicting frontend totals that motivated this phase.

There are no known P0 or P1 code-correctness defects in the reviewed WP2
implementation after lifecycle and stale-cache fixes. The system is still not
ready to activate unified funding: WP3 persistence/reconciliation and the
remaining route-specific WP0 live gates are intentionally absent.

Overall assessment:

- WP0 evidence quality: strong and sufficient for implementation.
- WP1 contract/control-plane quality: complete and safely inactive.
- WP2 code/contract quality: complete for the planned milestone.
- Production funding readiness: not ready, by design.
- Foundation quality through WP2: approximately 8.5/10. The remaining work is
  mostly durable financial state, provider execution, and activation evidence,
  not a need to redesign the foundation.

## Requirement review

| Work package | Required outcome                                                                   | Evidence                                                                              | Verdict                                                |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| WP0          | Freeze current facts, contracts, legacy exit, parity, lifecycle, and live evidence | `docs/funding/wp0`, six Relay rehearsals, sanitized fixtures                          | Sufficient to implement; route activation gates remain |
| WP1          | Provider-neutral domain and fail-closed runtime policy                             | domain tests, strict schemas, empty production registry, admin read/diff/publish UI   | Complete and inactive                                  |
| WP2          | Ownership resolver over existing truth                                             | network-scoped profiles, venue bindings, evidence revision                            | Complete with conservative Privy-source fallback       |
| WP2          | Inventory and canonical dedup                                                      | existing wallet resolver, exact asset catalog, decimal validation, conflict rejection | Complete                                               |
| WP2          | Price boundary, impairment, freshness                                              | `PriceAdapter`, exact stable adapter, policy impairment and stale tests               | Complete; generic production token adapter deferred    |
| WP2          | Account Value and availability separation                                          | separate projectors and lock tests                                                    | Complete                                               |
| WP2          | In-transit single representation                                                   | movement-stage suppression and property test                                          | Projector complete; runtime feed waits for WP3         |
| WP2          | Separate positions and display-only headline                                       | separate components/totals and invariance tests                                       | Complete                                               |
| WP2          | Polymarket/Limitless position value                                                | thin exact-text collectors and canonical market marks                                 | Complete                                               |
| WP2          | Asset suggestion preferences                                                       | authenticated API, migration, merge rule, non-authority test, local DB rollback smoke | Complete; migration applied locally only               |
| WP2          | Replace frontend-local totals                                                      | shared query, removed local total owner, desktop/mobile integration                   | Complete                                               |
| WP2          | Truthful degraded states                                                           | partial/stale/unpriced/unavailable UI and fail-closed trade selector                  | Complete                                               |

## Correctness and safety findings

### Resolved during review

1. **User merge lifecycle**

   The new user-owned preference table initially had no merge handling. The
   merge path now copies preferences, retains identical choices, resets
   conflicts to `ask`, preserves source rows for `keepSource`, and removes them
   for a normal merge. Focused tests cover the SQL contract.

2. **Unknown lock state**

   A failed open-order lock collector now produces null available estimates,
   zero fail-closed aggregate availability, and partial/stale state. It never
   reduces Account Value.

3. **Cached frontend error**

   Trade selectors no longer use cached Account Value after a query error.
   Compact balance UI shows unknown instead of `$0`; non-transactional account
   views may retain the last value but mark it stale.

4. **Exact position arithmetic**

   Position values use raw PostgreSQL numeric text rather than the legacy
   JavaScript-number presentation fields. Resolution percentage and basis-point
   representations are both bounded and normalized.

5. **Movement double counting**

   Source, in-transit, destination, and refund representations are suppressed
   by movement progression in both value and availability projections.

### Remaining bounded risks and debt

1. **WP3 is a hard activation prerequisite**

   Reservations, submitted debits, live in-transit claims, durable attempts,
   exact observations, restart-safe reconciliation, reorg/finality handling,
   and legacy dispatch do not exist yet. No Relay execution should be connected
   before those invariants are implemented.

2. **Route-specific live evidence remains incomplete**

   WP0 proved bounded wallet routes, but strict Deposit Address recovery,
   Polymarket/Limitless settlement visibility, Privy delegated actions,
   withdrawal, redemption, and fault injection remain capability-specific
   activation gates.

3. **Non-stable runtime pricing is intentionally absent**

   The adapter boundary and property behavior are proven, but production
   runtime registers only exact stable pricing. Policy-added tokens remain
   unpriced and cannot inflate value or enable Buy. Register a trusted adapter
   only with explicit freshness and confidence policy.

4. **Privy source enrichment is conservative**

   Persisted `user_wallets` facts do not contain the current Privy
   embedded/smart/external classification. The WP2 runtime therefore grants
   only web-client signing and no sponsorship/delegation when that evidence is
   absent. A short-lived cached Privy-profile evidence port is needed before
   WP5 managed execution; this does not affect current value ownership.

5. **Polymarket execution retains its specialized owner**

   Account Value is used for display, while Polymarket Buy still uses the
   existing funder/deposit-wallet-aware buying-power resolver. Replacing it with
   a generic Account Value number would be unsafe. WP5 Intent Liquidity should
   consume the same binding and lock facts through a focused port.

6. **Derived read caching is not yet implemented**

   Underlying wallet calls and the frontend query have short-lived caches, but
   the plan's component-revision keyed Account Value cache is absent. This is a
   performance and provider-load risk for broad rollout, not a value-correctness
   defect.

7. **Module boundary can be cleaner**

   The Account Value runtime imports exported balance helpers from
   `routes/wallets.ts`. Behavior is reused rather than duplicated, but the
   helpers should eventually live in a focused inventory service so domain
   runtime does not depend on an HTTP route module.

8. **Account Value rollout is deployment-owned**

   Account Value is a read-only product projection and does not use the funding
   creation switch. It is verified locally and deployed normally; rollback uses
   the previous backend/frontend deployment. Funding creation remains
   independently fail-closed until WP3-WP6 and exact route gates pass.

9. **Pagination is deterministic but not snapshot-bound**

   `/account/assets` uses stable component ordering and an opaque cursor, but a
   changing live inventory can move between pages. This is acceptable for the
   current read-only inventory; a projection-revision cursor is preferable if
   callers later require snapshot semantics.

## Security review

- All Account Value surfaces require the existing authenticated user.
- Preference writes re-project the user's inventory and reject a component not
  owned by that projection.
- Opaque component IDs are stable hashes of canonical owned locations; raw
  recipient input is not accepted.
- Suggestion preference is explicitly non-authoritative in domain behavior and
  API response.
- Exact network, contract/mint, and decimals defeat symbol spoofing.
- Stable impairment, stale price, stale observation, unpriced asset, ambiguous
  duplicate, and unknown locks all fail closed.
- Wallet/profile evidence does not grant delegated signing or sponsorship.
- The original review touched no provider calldata, private key, live wallet,
  production policy, or external state. The later validation used only
  read-only RPC and a local SQL transaction that was fully rolled back.

## Data and arithmetic review

- Backend sums, multiplication, ratios, and deductions use unsigned decimal
  strings plus `bigint`.
- Open-order locks affect cash availability only.
- Positions use exact raw numeric text from the database.
- Same-time conflicting asset or position evidence contributes no estimate.
- Excluded spam/unregistered components and unpriced/stale components do not
  inflate totals.
- A priced token can contribute to estimated assets while remaining ineligible
  for execution and absent from cash availability.
- Preference storage is user-scoped, revisioned, merge-aware, and
  cascade-deleted with the user.

## Duplication audit

The deterministic analyzer from the `code-duplication-audit` skill was run with
Type 1 and Type 2 normalization, minimum 60 tokens and 5 code lines.

Frontend touched-surface baseline versus final:

| Metric                    | Baseline |    Final |     Change |
| ------------------------- | -------: | -------: | ---------: |
| Files                     |      252 |      254 |         +2 |
| Source lines              |   67,985 |   67,855 |       -130 |
| Type 1 clone classes      |      245 |      245 |          0 |
| Type 1 occurrences        |      533 |      532 |         -1 |
| Type 1 duplicate coverage | 13.9663% | 13.8958% | -0.0705 pp |
| Type 1 redundancy         |  7.5987% |  7.5470% | -0.0517 pp |
| Type 2 clone classes      |      543 |      542 |         -1 |
| Type 2 occurrences        |    1,349 |    1,344 |         -5 |
| Type 2 duplicate coverage | 25.9881% | 25.9215% | -0.0666 pp |
| Type 2 redundancy         | 14.8297% | 14.7683% | -0.0614 pp |

These final numbers were captured after the stale/error-state fixes.

The WP2 backend-focused scan found only within-file structural repetition:
strict schema shapes, route error handling, asset/position dedup algorithms,
catalog entries, and test fixtures. No clone class duplicates provider,
placement, value, or operation-state ownership. Extracting a generic framework
solely for these metrics would make the financial contracts less explicit.

## Verification review

Passing checks:

- Account Value tests: 15/15.
- Admin user-merge tests: 4/4.
- API fast suite: 20/20 test files.
- API typecheck and lint.
- Targeted backend formatting.
- Frontend tests: 533/533 across 111 files.
- Frontend typecheck, lint, and format check.
- Next.js production build.
- `git diff --check` for both changed repositories.
- `hunch-admin` remains clean; its committed WP1 build, lint, format, and
  unimported checks passed during the WP1/WP2 review.

## Post-review local validation addendum

Migration `0183_user_asset_funding_preferences.sql` was subsequently applied to
the local development database only. Schema inspection and a real local
Account Value read proved the migration/repository/runtime boundary with 5
linked wallets, 12 asset components, `65.613572` USD liquid/cash available,
complete/fresh asset state, and no collector errors. Eighteen stale position
components remained separate and were excluded fail-closed from effective
value. Preference revision, enum constraint, ranking, and rollback behavior
passed; zero smoke rows remained. The API fast suite passed 20/20 test files.

The rollout decision was also simplified: there is no production
background-comparison rollout stage. Account Value follows local verification,
ordinary deployment, and deployment rollback. Funding creation uses a binary
`off`/`on` control plus independent exact route/capability gates.

## What is ahead

1. **WP3 — durable financial truth**
   - additive schema for quotes, destinations, operations, segments, requests,
     steps, attempts, observations, reservations, route history, and jobs;
   - idempotent commit and transition repositories;
   - exact observation allocation and in-transit claims;
   - finance-worker leases, polling, webhook enqueue, recovery, finality, reorg,
     cost, retention, and notifications;
   - legacy Bungee/Across/deBridge classification and dispatch.

2. **WP4 — Relay compatibility adapter**
   - map frozen Relay Quote/Status/Deposit Address shapes into WP1 contracts;
   - normalize and validate EVM/Solana actions;
   - register only exact rehearsed capabilities;
   - preserve legacy reconcilers.

3. **WP5 and later — intent liquidity and product orchestration**
   - binding-specific liquidity and shortfall placement;
   - purpose-aware wallet preparation;
   - one web funding controller and Telegram handoff;
   - withdrawals, recovery, notifications, and route-by-route activation.

The next safe implementation step is WP3. Starting Relay execution before WP3
would discard the strongest safety property established by WP0–WP2: one
durable, restart-safe source of financial truth.
