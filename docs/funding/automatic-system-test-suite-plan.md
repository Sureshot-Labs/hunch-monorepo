# Automatic full-stack financial journey test suite

- Status: design proposal
- Date: 2026-09-04
- Scope: `Hunch_App`, `hunch-monorepo`, and selected ideas from
  `hunch-trade-bot`

This document proposes an automated test system for Hunch's authenticated
frontend and backend financial journeys. It covers receive/deposit,
conversion, trade funding, BUY, SELL, withdrawal, and asynchronous redemption
without testing card payments or browser-connected third-party wallets.

The proposal is based on the current local working trees, including active
uncommitted funding work. Capability and route assumptions must therefore be
revalidated when that work lands.

## 1. Executive decision

Build a new, standalone **financial system-test harness**. Do not turn
`hunch-trade-bot` into the test suite and do not put test-wallet private keys in
`Hunch_App` or the API.

The harness should expose one CLI and one scenario model, but run in distinct
tiers:

1. **Deterministic full-stack**: real browser, frontend, API, workers,
   PostgreSQL, and Redis; injected deterministic venue/chain/provider adapters
   and a fake clock. This is where exhaustive state, fault, restart, and
   idempotency testing belongs.
2. **No-value live**: real authentication, policies, capabilities, market
   discovery, and either strict read-only observation or explicitly journaled
   ephemeral sessions/quotes/preparation, always stopping before signature or
   broadcast.
3. **Tiny-value live canary**: dedicated test identity and capped source/sink
   wallets interacting with real supported chains and venues.
4. **Asynchronous lifecycle**: durable scenarios that can stop after acquiring
   a position and resume after the market resolves to test redemption.

The suite should discover the route graph from backend capabilities and then
compile a bounded coverage plan. It must not attempt a Cartesian product of
every asset, route, market, venue, browser, and failure mode with live money.
Exhaustive and property-based coverage belongs in deterministic tiers; live
coverage should use a minimal edge-covering set plus a few representative
multi-source cases.

## 2. Feasibility verdict

| Journey or property                                                 | Feasibility                              | Important qualification                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse an authenticated browser session                              | High                                     | A one-time visible login bootstrap is straightforward; unattended OTP login needs an approved test inbox or Privy-supported test identity mechanism.                 |
| Verify the displayed receive address                                | High                                     | Compare UI, authenticated API, expected user wallet binding, network, asset, address type, and expiry/amount only when that receive mode is strict and amount-bound. |
| Receive direct settlement assets                                    | High                                     | Use exact supported contracts and observe both canonical receipt and destination balance.                                                                            |
| Receive plus automatic conversion                                   | High when advertised                     | Compile only routes enabled by the current funding policy and live capabilities.                                                                                     |
| Deposit plus BUY                                                    | High                                     | Requires robust UI hooks and API/DB/venue oracles, not only a success toast.                                                                                         |
| BUY and SELL on Polymarket and Limitless                            | High when lifecycle and liquidity allow  | Market type, preparation, minimum order, fill, and position projection must be checked at runtime.                                                                   |
| One-, two-, and three-source shortfall                              | High deterministically; medium live      | Live cases require deliberate balance shaping and cleanup.                                                                                                           |
| More than three source balances                                     | High deterministically; selectively live | The planner considers up to 16 composite candidates; exhaustive live subsets would be expensive and unsafe.                                                          |
| Withdrawal to an owned destination                                  | High                                     | The destination must be prevalidated and allowlisted in the run manifest.                                                                                            |
| Redemption                                                          | Medium to high                           | Resolution timing is external, so the test must checkpoint and resume instead of blocking CI.                                                                        |
| Restart, duplicate-click, timeout, and ambiguous-broadcast recovery | High deterministically                   | Only safe, naturally occurring ambiguity should be observed live; do not inject dangerous live failures.                                                             |
| Every venue and direction                                           | Capability-dependent                     | Test active and exit-only behaviors according to lifecycle; an unavailable route is evidence, not a reason to force it.                                              |
| Card and browser external-wallet flows                              | Out of scope                             | The controlled wallet injects and receives test funds directly on-chain; it is never connected to the Hunch UI.                                                      |

The broad suite is feasible. The literal goal of executing every possible
combination with live funds is neither finite nor desirable. A capability-led
coverage compiler gives stronger assurance with a bounded risk budget.

## 3. Existing foundations and gaps

### 3.1 Frontend

Useful foundations already exist:

- Privy creates embedded EVM and Solana wallets as part of authenticated user
  provisioning in
  `Hunch_App/src/providers/auth/AuthPrivyProvider.tsx` and
  `Hunch_App/src/providers/auth/AuthProvider.tsx`.
- The funding controller persists operation IDs and pending action reports,
  polls durable operation state, and replays reports after reload in
  `Hunch_App/src/hooks/funding/useFundingController.ts`.
- `Hunch_App/src/lib/funding/controller-state.ts` already gives the browser
  layer a meaningful state vocabulary, from source/quote/review through
  external funds, recovery, and terminal states.
- The action executor already separates embedded EVM, embedded Solana, and
  external-wallet execution paths.
- Non-production `/__design/unibalance` scenario pages already render many
  deposit, funding, recovery, and redemption states and can seed visual and DOM
  contract coverage. They are not financial truth or a replacement for the
  full-stack simulator.
- Event pages accept explicit event, market, side, trade side, order type, and
  amount query parameters. The harness can therefore navigate directly to a
  backend-selected market rather than scrape the market table.
- Existing Bun tests cover many funding, confirmation, wallet, trade,
  withdrawal, and redemption units.

Current gaps for system automation:

- There is no Playwright system-test project or configuration in the frontend.
- Existing `data-hunch-bot` hooks cover only selected confirmation, conversion,
  portfolio, and redemption elements. Receive, funding progress, withdrawal,
  and recovery do not yet expose a complete stable automation contract.
- Desktop and mobile are separate implementations and must both satisfy the
  same semantic test contract.
- The generic funding `signature` action is currently unsupported by the
  frontend executor. Any capability that produces it must be classified as a
  product/testability blocker, not clicked through optimistically.
- Standalone conversion is not a clearly canonical public journey today;
  automatic conversion during receive/funding is the reliable initial surface.
- Browser-visible success alone is too weak for a financial assertion.

### 3.2 Backend

Useful foundations already exist:

- The funding API exposes capabilities, destinations, receive options and
  sessions, quotes, liquidity, commit/cancel/read/list, action preparation and
  reporting, and reconciliation in `apps/api/src/routes/funding.ts`.
- Durable owner-bound REDEEM execution is exposed through inspect, prepare,
  claim, report, and reconcile routes in
  `apps/api/src/routes/position-actions.ts`.
- Funding state is constrained by explicit status/stage pairs in
  `apps/api/src/funding/domain/transitions.ts`.
- Exact raw units, source choices, composite sources, destination bindings,
  steps, receipts, and observations already have domain models.
- `apps/api/src/funding/domain/local-simulator.ts` defines a constructor-only
  testability contract and intentionally has no production registration. It is
  a useful proposed seam, but there is not yet a simulator implementation or a
  runtime composition that injects it.
- Composite source enumeration is bounded to 16 candidates and already has
  deterministic ordering/selection logic in
  `apps/api/src/funding/planner/composite-source-options.ts`.
- Relay mappings pin supported source/destination assets and chains in
  `apps/api/src/funding-providers/relay/mappings.ts`.
- Polymarket and Limitless preparation adapters expose the different fund,
  BUY, SELL, REDEEM, withdrawal, standard, neg-risk, CLOB, and AMM readiness
  paths.
- The database's operation -> step -> attempt -> receipt -> observation model
  is documented in `apps/api/src/funding/FUNDING_SCHEMA.md` and is suitable for
  an independent database oracle.

Current gaps for system automation:

- Planner/runtime construction must first be refactored behind injectable
  boundaries, then the simulator/provider/RPC/indexer implementations and a
  browser-startable fixture environment must be built.
- Capability output must be captured as a versioned run artifact. The runner
  also needs an expected-capability manifest so it can distinguish an intended
  disabled path from a regression.
- Some live route activation remains policy- and evidence-dependent. Test code
  must never register the simulator or broaden policy in production.
- The system needs a read-only correlation strategy across operation,
  reservation, order, action attempt, receipt, observation, and venue result.

### 3.3 Current live capability shape

The static catalog is broader than the runtime-enabled graph. Every run must
still use `GET /funding/capabilities` and the current policy revision. The
current generic venue-funding destinations are Polymarket Polygon pUSD and
Limitless Base USDC:

| Source asset        | Polymarket / Polygon pUSD | Limitless / Base USDC  |
| ------------------- | ------------------------- | ---------------------- |
| Polygon pUSD        | Direct                    | Relay                  |
| Polygon native USDC | Relay same-chain swap     | Relay                  |
| Polygon USDC.e      | No generic route          | Relay                  |
| Base USDC           | Relay                     | Direct                 |
| Solana USDC         | Relay                     | Relay                  |
| Native SOL          | Relay                     | Relay                  |
| Polygon POL         | No venue-funding route    | No venue-funding route |

POL remains useful for gas and bounded Relay rehearsal routes, but its current
catalog destinations are not venue settlement. Symbol equality is never enough
to infer one of these routes; the exact chain and contract/mint must match.

Current venue/action constraints are also material:

| Venue        | Generic funding/shortfall             | BUY                              | SELL                                                                                          | REDEEM                |
| ------------ | ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- | --------------------- |
| Polymarket   | Yes                                   | Yes                              | Yes                                                                                           | Yes                   |
| Limitless    | Yes                                   | Yes                              | Web CLOB/AMM implementations support it, but unified automation currently advertises BUY-only | Yes                   |
| Kalshi/DFlow | No                                    | Official strict path is BUY-only | Not a supported strict automation boundary                                                    | No generic redemption |
| Hyperliquid  | Not released in the current lifecycle | No current suite path            | No current suite path                                                                         | No current suite path |

Consequently, "all venues" means testing each venue's supported lifecycle and
its explicit forbidden transitions. It does not mean forcing a full
deposit/BUY/SELL/withdraw/redeem loop where the product has no such contract.

Withdrawal is asset-targeted rather than venue-targeted. The current broad
shape is:

| Destination         | Current executable source shape                                                    |
| ------------------- | ---------------------------------------------------------------------------------- |
| Polygon pUSD        | Same-asset direct; Relay from Polygon native USDC, Base USDC, Solana USDC, or SOL  |
| Base USDC           | Same-asset direct; Relay from Polygon pUSD/native USDC/USDC.e, Solana USDC, or SOL |
| Polygon native USDC | Same-asset direct only                                                             |
| Polygon USDC.e      | Same-asset direct; Deposit Wallet pUSD handoff plus exact offramp where enabled    |
| Solana USDC         | Relay from Polygon pUSD; no direct SPL-USDC withdrawal adapter today               |
| Native SOL          | Same-asset direct only                                                             |

The missing direct Solana SPL-USDC withdrawal and the Limitless SELL capability
disagreement are concrete product/contract gaps the suite should report, not
paper over.

Composite `sourceCount` is parallel contribution, not arbitrary sequential
multi-hop routing. The planner accepts up to 16 eligible contributors, with
one exact segment per Relay contributor and at most one venue-preparation
contributor.

### 3.4 `hunch-trade-bot`

Reuse ideas, not its current scenario model:

- persistent Chromium profiles and visible initial login;
- session health checks using the authenticated Hunch origin;
- same-origin browser `fetch` for authenticated API calls and CSRF handling;
- market URL construction and a small number of existing UI hooks;
- screenshots and conservative manual/semi-auto modes.

Replace or redesign:

- signal-driven market selection;
- Polymarket-centric portfolio discovery;
- hard-coded conversion assumptions;
- a monolithic smoke flow that accepts "funding required" as success;
- UI-success-only assertions;
- local browser-profile storage as the only durable scenario record;
- selectors tied to presentation instead of a versioned semantic contract.

Specific false-positive risks make a direct extension inappropriate:

- tolerant navigation can continue on a stale page after a refused or timed-out
  navigation;
- auth checks do not bind the session to the expected user and wallet topology;
- the existing smoke suite treats several blocked/preparation-required states
  as success;
- the `trade-success` marker is not authoritative fill evidence, and the bot
  ignores the already exposed order ID;
- its Limitless redemption path cannot currently discover Limitless positions
  because portfolio fetching is Polymarket-only;
- stop/risk checks are not performed immediately before every irreversible
  boundary.

### 3.5 Existing verification assets

This plan should automate, rather than fork, the safety and evidence contracts
already defined in:

- [WP7 verification plan](./wp7/verification-plan.md), including the no-value,
  chaos, tiny-value, timing, database, and budget matrices;
- [live rehearsal harness contract](./wp0/live-rehearsal-harness.md), including
  default preflight, exact spend/output/fee bounds, fresh confirmation,
  redaction, and possible-broadcast handling;
- the WP8 Relay SVM activation runbook for native-SOL delegated execution.

The existing Relay rehearsal commands should remain narrow route-level tools.
The new harness can invoke or consume their validated primitives, but it should
not weaken their explicit live gate.

## 4. Proposed architecture

```text
                         immutable run manifest
                                  |
                         capability discovery
                                  |
                           scenario compiler
                      /           |            \
             browser driver   wallet driver   fixture control
                 |                 |                |
             Hunch_App       EVM/Solana RPC   deterministic adapters
                 |                 |                |
                 +---------- Hunch API/workers -----+
                                  |
                          PostgreSQL + Redis
                                  |
              UI + API + DB + chain/venue evidence oracles
                                  |
                    checkpoint journal and report
```

Recommended components:

1. **Scenario compiler**
   - reads the suite configuration;
   - snapshots capabilities, policies, lifecycle, market candidates, and
     balances;
   - generates only satisfiable scenarios;
   - chooses deterministic exhaustive, pairwise, or live edge-cover coverage;
   - emits an immutable plan hash before any mutation.
2. **Browser driver**
   - Playwright with a persistent, dedicated profile;
   - validates the expected Hunch user and embedded-wallet fingerprints;
   - operates the same public UI a user sees;
   - supports desktop and mobile semantic contracts.
3. **Authenticated API driver**
   - runs same-origin through the browser context where appropriate;
   - observes and correlates operations without bypassing user authorization;
   - navigates directly with backend-selected canonical IDs when the scenario
     tests execution rather than market-list discovery;
   - never replaces the UI step that a scenario claims to test.
4. **Controlled wallet driver**
   - signs exact transfers only from a tiny-balance source wallet;
   - observes controlled withdrawal sinks;
   - has no access to Privy embedded-wallet private keys;
   - supports EVM and Solana behind one constrained interface.
5. **Fixture/fault driver**
   - available only in the deterministic environment;
   - controls time, receipts, liquidity, fills, finality, provider responses,
     crashes, and ambiguous submission boundaries.
6. **Evidence oracles**
   - UI, authenticated API, read-only DB, chain/provider, and venue projections;
   - require agreement appropriate to the journey before declaring success.
7. **Checkpoint journal**
   - authoritative transactional record written before and after every
     irreversible boundary, with an append-only action log and fenced lease;
   - resumes a scenario without blind rebroadcast;
   - drives asynchronous redemption and cleanup.
8. **Safety governor**
   - validates environment, identities, allowlists, caps, quote freshness,
     balance floors, and kill switches immediately before mutation.

Create the harness as an independent package or repository, tentatively
`hunch-system-tests`. Keeping it outside application runtime dependency graphs
prevents wallet keys, Playwright, fixture controls, and live mutation commands
from leaking into production services.

Recommended implementation stack:

- TypeScript plus Playwright, matching the applications and the useful parts of
  `hunch-trade-bot`;
- generated Hunch OpenAPI types instead of hand-written response parsing;
- the same established EVM/Solana transaction libraries already used by Hunch,
  behind narrow controlled-wallet interfaces;
- PostgreSQL for transactional run state, fenced leases, nonce ownership, and
  the global budget ledger;
- schema-validated YAML for human configuration and JSON/JSONL for immutable
  plans, events, and machine reports.

## 5. Identity, browser session, and wallet custody

### 5.1 Dedicated Hunch identity

Use a small pool of dedicated Privy test users per environment, partitioned by
lifecycle lane (for example ordinary receive/trade, composites, and long-lived
redemption). Do not reuse an employee or ordinary production account. Live
financial runs remain serialized per identity and wallet bundle.

Support two bootstrap modes:

- `auth init`: launch a visible persistent browser, let an operator complete
  login once, verify `/auth/me`, selected Hunch wallet, and embedded EVM/Solana
  wallet bindings, then persist only the browser profile.
- `auth attach`: optionally attach to an explicitly provided debug-enabled
  browser session, validate origin and identity, and import/copy no cookies into
  logs. This is useful interactively but is less reliable than a dedicated
  profile for scheduling. Treat attached sessions as observe-only in live
  environments; do not spend through an arbitrary operator tab.

Every run begins with `auth doctor`. It must fail closed on an unknown user,
wallet mismatch, expired session that cannot refresh, missing CSRF state, or a
browser profile already locked by another run.

The profile contains live session material even though it contains no wallet
private key. Store it on an access-controlled/encrypted volume, lock it per
runner, exclude it from backups and artifacts unless explicitly protected, and
rotate/rebootstrap it after suspected exposure.

Fully unattended login should be added only through an approved test email/OTP
inbox integration or an official Privy test-user mechanism. Do not create a
production auth bypass for the suite.

### 5.2 Wallet roles

The word "wallet" must be split into explicit roles:

| Role                         | Custody                                                      | Purpose                                                                                 |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Hunch embedded EVM wallet    | Privy                                                        | App-owned execution on Polygon/Base and venue setup. Harness stores IDs/addresses only. |
| Hunch embedded Solana wallet | Privy                                                        | App-owned Solana receive and allowed actions. Harness stores IDs/addresses only.        |
| Controlled EVM source        | Test harness secret store                                    | Sends deposits on supported EVM networks. It is never connected to the Hunch UI.        |
| Controlled Solana source     | Test harness secret store                                    | Sends SOL/SPL deposits. It is never connected to the Hunch UI.                          |
| Controlled withdrawal sink   | Test harness secret store or observable receive-only account | Receives and proves withdrawals. Only allowlisted destinations are permitted.           |
| Treasury/top-up wallet       | Human/operations                                             | Replenishes the capped runner wallets; never loaded by the harness.                     |

One generated EVM key can have addresses on Polygon and Base, while Solana
needs a separate keypair. For clearer accounting and reduced blast radius,
source and sink roles should be separate even if the first MVP uses one
controlled address per chain family.

Private keys must live in an OS keychain or approved secret manager and be
referenced by opaque secret URI. They must not be stored in Git, the browser
profile, SQLite, JSON configuration, screenshots, traces, or test reports.

### 5.3 Required tiny inventory

The runner should inventory exact contract/mint identities, decimals, and gas
before planning. The present route policy suggests this starting set:

| Network | Gas/rent | Candidate source or settlement assets |
| ------- | -------- | ------------------------------------- |
| Polygon | POL      | pUSD, native USDC, USDC.e             |
| Base    | ETH      | USDC                                  |
| Solana  | SOL      | canonical USDC, SOL                   |

The suite must derive the live enabled subset from capabilities. It must not
infer support from a token symbol alone.

## 6. Test tiers and commands

Suggested public CLI shape:

```bash
hunch-e2e plan --suite core --environment local
hunch-e2e run --suite deterministic --environment local
hunch-e2e run --suite live-observe --environment staging-mainnet
hunch-e2e run --suite live-no-broadcast --environment staging-mainnet
hunch-e2e run --suite live-core --environment staging-mainnet \
  --authorization <one-use-envelope>
hunch-e2e resume --run <run-id>
hunch-e2e cleanup --run <run-id> --plan-only
hunch-e2e report --run <run-id>
```

`plan` and `live-observe` are strictly read-only: allowlisted GET/dry-run calls
only, followed by an asserted-zero durable-state delta. `live-no-broadcast`
never signs, broadcasts, or moves value, but may create ephemeral receive
sessions, quotes, operations, or preparation records through ordinary product
behavior; it must journal them, cancel/release them where supported, and verify
cleanup. A live-value command must require a fresh plan plus a non-derivable,
one-use signed authorization envelope. CI credentials alone must not silently
turn a plan into a broadcast.

### Tier A: unit, property, and contract

Run on every relevant pull request:

- exact-unit and decimal boundary properties;
- route and asset identity contracts;
- every valid/invalid funding status-stage pair;
- planner source selection and deterministic tie-breaking;
- exhaustive composite subsets within bounded generated fixtures;
- reservation conservation and release/consume invariants;
- operation and position-action idempotency/replay;
- old/new frontend-backend capability compatibility;
- stable UI semantic-hook contract on desktop and mobile.

### Tier B: deterministic full-stack

Run production application code in an isolated test composition against
disposable PostgreSQL/Redis, a test-only identity/session adapter, a test-only
frontend wallet-action executor, and newly implemented simulated
provider/RPC/indexer adapters behind explicit dependency-injection seams. Use
Playwright for all user actions. The auth adapter must create the same user and
embedded-wallet topology expected by the app; the normalized action executor
must exercise the same prepared-action validation and reporting contracts
without calling Privy/mainnet. Import, build, and startup gates must prove both
are unreachable in production. Real Privy authentication and browser signing
are covered in live tiers. Until these seams exist, Tier B can test only up to
action preparation, not deterministic embedded-wallet broadcast/recovery. This
tier owns:

- every state transition and recovery boundary;
- open-receive split/excess deposits; strict-route under/overpayment; wrong
  asset/network, late receipt, duplicate receipt, stale quote, and policy
  revision;
- provider/venue timeout before broadcast, confirmed broadcast, and uncertain
  broadcast;
- API, worker, browser, and process restart at each durable boundary;
- no-fill, partial fill, full fill, delayed position projection, resolution,
  redeem marker loss, and reconciliation;
- duplicate click, two tabs, browser back, close, intent change, and amount
  change;
- one-, two-, three-, and generated higher-source composite cases;
- desktop and mobile presentation behavior.

No test-only adapter may be reachable from a production composition root. Add
an import/registration test to enforce that property.

### Tier C: read-only and stateful/no-broadcast live

Run against the real configured environment but stop before signature or
broadcast. Split strict observation from stateful product inspection and report
which boundary each case uses:

Strict `live-observe`:

- authentication and wallet-binding health;
- capability and lifecycle snapshot;
- market discovery and liquidity validation;
- existing balance, position, operation, and destination state;
- asserted-zero durable product-state delta.

Stateful `live-no-broadcast`:

- receive address and QR agreement with API binding;
- route quote, expiry, fee, minimum output, refund, and destination checks;
- venue preparation inspection;
- withdrawal destination registration/inspection where needed;
- unsupported-route fail-closed checks;
- journaled cleanup or explicit expiry of every created session, quote,
  reservation, preparation, operation, and temporary destination.

### Tier D: tiny-value live

Use only dedicated identities and wallets. Start with a core canary and expand
to a weekly route-coverage suite. Every scenario must inherit the WP0 preflight
and reporting contract.

### Tier E: asynchronous lifecycle

Runs may end in `WAITING_FOR_RESOLUTION`, persist a resume condition, and be
woken later. Resolution delay is not itself a failed test. Once the venue says
the market is authoritatively resolved and redeemable, the resumer executes and
verifies REDEEM exactly once.

## 7. Capability-led scenario compilation

At run start, snapshot:

- backend funding capability version and creation mode;
- venue lifecycle: active, exit-only, or unreleased;
- exact enabled receive assets and route destinations;
- available position actions and venue/market preparation type;
- minimum order, tick, liquidity, and expiration constraints;
- wallet bindings, balances, gas/rent reserves, and active reservations;
- policy/config revision hashes;
- Git SHA and dirty-tree fingerprint for each application under test.

Compare the live snapshot to a reviewed expected-capability manifest:

- **expected and available** -> eligible for planning;
- **expected but unavailable** -> regression or environment gate;
- **not expected and unavailable** -> skip with evidence;
- **not expected but available** -> fail closed until reviewed.

This prevents the suite from silently accepting accidental capability loss or
automatically spending through a newly exposed route.

### 7.1 Define "leg" precisely

Do not use a single ambiguous `legCount`. Track at least:

- `sourceCount`: independent balances contributing to a composite option;
- `routeHopCount`: conversions/bridges between source and venue settlement;
- `executionStepCount`: all preparation, transfer, observation, and consumer
  steps in the committed operation.

The user's desired one/two/three-leg coverage should normally map to
`sourceCount = 1/2/3`. Route and execution depth are separate coverage axes.

### 7.2 Coverage strategy

Use three algorithms:

1. **Exhaustive/property generation** for pure planner and state-machine inputs.
2. **Pairwise plus boundary coverage** for deterministic browser scenarios.
3. **Weighted set cover** for live routes, selecting the smallest safe scenario
   set that covers each enabled venue, source asset, destination, action,
   preparation family, source count, and important lifecycle boundary.

For live coverage, require `sourceCount = 1`. Add a representative
`sourceCount = 2` case only after single-source routes are stable, and run
`sourceCount = 3` periodically/manual when balance shaping is safe and
economical. The planner has no simple "force exactly N" live control. Exhaust
counts and compatible subsets through 16 contributors in the deterministic
tier; do not make fragile live balance shaping a daily gate.

Across scheduled live runs, rotate the chosen edge-cover instead of repeating
one route forever. Where supported directions line up safely, order the route
set so the same small bankroll can circulate through successive destinations.
Cleanup and risk caps still take precedence over completing the schedule.

## 8. Required scenario families

The exact generated list is capability-dependent. These IDs define the stable
requirements taxonomy.

### 8.1 Authentication and identity

- `AUTH-SESSION-RESUME`: reuse a valid persistent session.
- `AUTH-SESSION-REFRESH`: recover an expired access token without changing the
  Hunch user or embedded wallets.
- `AUTH-WALLET-MISMATCH`: fail closed when the selected or embedded wallet is
  not the expected fingerprint.
- `AUTH-CONCURRENT-PROFILE`: prevent two mutating runners from sharing one
  browser profile.

### 8.2 Receive and deposit

- `RECEIVE-DIRECT-{NETWORK}-{ASSET}-{DESTINATION_KIND}`: display and verify an
  amount-free open destination, send a chosen tiny amount, and observe that
  exact canonical receipt and final balance. The session does not reserve an
  expected amount.
- `RECEIVE-CONVERT-{SOURCE}-{DESTINATION}`: receive a supported stable and
  automatically route it to venue settlement.
- `RECEIVE-VOLATILE-REVIEW`: require one fresh economic consent for a volatile
  asset; never silently auto-convert it.
- `RECEIVE-OPEN-MULTIPLE`: observe several transfers in one open receive
  session without double allocation.
- `RECEIVE-STRICT-EXACT`: only when runtime capabilities advertise an
  amount-bound committed/provider route, enforce amount, expiry, asset, refund,
  and child request correlation.
- `RECEIVE-PLAIN-SOL`: show the current managed Solana address, receive SOL as
  SOL, complete the post-receipt economic review by choosing **Keep SOL**, and
  create no conversion or BUY.
- Deterministic open-session cases: multiple/split/excess receipts are accepted
  and allocated once. Wrong token/network, duplicate observation, late arrival,
  refund, and observer outage are explicit cases. Under/overpayment rejection
  applies only to strict amount-bound routes, never ordinary open receive.

### 8.3 BUY and funding shortfall

- `BUY-ALREADY-FUNDED-{VENUE}`: one user click, one order, no funding operation.
- `BUY-DIRECT-SHORTFALL-{SOURCE}-{VENUE}`: route one eligible source and submit
  the frozen BUY exactly once.
- `BUY-DEPOSIT-AND-CONTINUE`: begin with no eligible internal source, deposit the
  frozen shortfall, reach readiness, refresh economics, and submit one BUY.
- `BUY-COMPOSITE-2` and `BUY-COMPOSITE-3`: no source alone is sufficient; one
  operation coordinates two/three contributors under one review and one
  consumer reservation. Execution ordering follows the immutable plan and is a
  separate assertion.
- `BUY-PREPARATION-{FAMILY}`: cover Polymarket standard/neg-risk and Limitless
  CLOB/AMM families as currently available.
- `BUY-ABANDON`: after readiness, Back or intent change releases the reservation
  to venue cash and submits no order.
- `BUY-NO-FILL`: definitive no-fill releases the reservation; ambiguity retains
  it for reconciliation.
- `BUY-INSUFFICIENT-GAS` and `BUY-STALE-QUOTE`: fail safely before an invalid
  spend.

### 8.4 SELL

- `SELL-PARTIAL-{VENUE}` and `SELL-FULL-{VENUE}`: exercise the venue-specific
  trade quote/submit path, order/fill/position projection, and exact remaining
  position. The current position-action claim/report API is REDEEM-only and
  must not be assumed for SELL.
- `SELL-DUPLICATE-SUBMIT`: replay/reload around the venue trade boundary creates
  no second economic action.
- `SELL-AMBIGUOUS-SUBMISSION`: venue-specific order/position reconciliation
  resolves without blind resubmit.

### 8.5 Withdrawal

- `WITHDRAW-DIRECT-{SOURCE_ASSET}-{DESTINATION_NETWORK}-{DESTINATION_ASSET}`:
  withdraw an exact small amount to the allowlisted controlled sink and prove
  source debit plus destination receipt.
- `WITHDRAW-CONVERT-{DESTINATION-ASSET}`: only where advertised, cover settlement
  conversion and final sink receipt.
- `WITHDRAW-DESTINATION-EXPIRED`, `WITHDRAW-WRONG-OWNER`, and
  `WITHDRAW-DUPLICATE-CLICK`: deterministic fail-closed and idempotency cases.

### 8.6 Redemption

- `REDEEM-AVAILABLE-{VENUE}-{MARKET-FAMILY}`: redeem a resolved owned position,
  verify exactly one position action and resulting collateral.
- `REDEEM-MARKER-LOST`: simulate a successful external action whose client
  marker/report was lost, then reconcile without resubmission.
- `REDEEM-NOT-YET-RESOLVED`: wait durably without reporting product failure.

### 8.7 Recovery and concurrency

Reload the browser and restart the API/worker at these checkpoints:

1. address displayed;
2. receipt observed;
3. child operation committed;
4. source action prepared;
5. before broadcast;
6. broadcast accepted but report not persisted;
7. destination observed;
8. reservation ready;
9. consumer action submitted;
10. fill or redeem observed but projection delayed.

At every checkpoint, assert no duplicate operation, route action, transfer,
order, position action, receipt allocation, or reservation consumption.

## 9. Market selection and lifecycle strategy

The old trade bot's holder-signal selection should not drive tests. Build a
test market selector over Hunch's own APIs and current venue lifecycle.

For ordinary BUY/SELL scenarios, require:

- venue/action currently enabled;
- active, not resolved, and enough time before expiry for funding plus cleanup;
- supported market/preparation family;
- valid tick/minimum size;
- bounded spread, sufficient executable depth, and a quote inside scenario
  slippage/fee caps;
- no test-run conflict or unexpected existing position;
- successful revalidation immediately before commit.

Rank candidates only after hard constraints pass. Before authorization, a
liquidity change may select the next candidate. After authorization, a change
to market, outcome, route, source, destination, or action requires a new plan
and authorization; never widen spend/slippage caps automatically.

For an execution scenario, the browser can use the existing direct event query
contract rather than click through discovery:

```text
BUY:
/events/{eventId}?market={marketId}&side={YES|NO}&tradeSide=BUY
  &orderType=market&amountUsd={tiny}&openTrade=1

SELL:
/events/{eventId}?market={marketId}&side={YES|NO}&tradeSide=SELL
  &orderType=market&amountShares={ownedShares}&openTrade=1
```

For SELL, use the known position acquired by the same run and its owned share
amount. Keep separate UI-discovery smoke tests so direct navigation does not
hide regressions in the market list. The mobile `/wallet/withdraw` route is a
useful direct withdrawal entry point; desktop withdrawal should still receive
its own menu-navigation smoke coverage.

### 9.1 Redemption nursery

Redemption cannot be a conventional synchronous CI test. Use a durable
"position nursery":

1. Select a short-duration, liquid market such as an eligible BTC up/down
   market with enough remaining time to fund and acquire the position.
2. Acquire the smallest practical position on one outcome by default. Buying
   both binary outcomes makes a redeemable winner deterministic, but should be
   used live only in a non-production/test-supported venue or after explicit
   review of venue terms, rewards, analytics, and market-integrity effects.
3. Persist owner, venue, market, outcome/token, position identity, expected
   resolution window, and all fingerprints in the checkpoint journal. The
   REDEEM position-action identity is created later, after resolution and
   preparation; it does not exist at BUY time.
4. Finish the current run as `WAITING_FOR_RESOLUTION`, not failed.
5. A scheduled resumer checks authoritative venue/Hunch resolution state.
6. Once redeemable, execute REDEEM through the UI, verify chain/venue/API/DB
   evidence and collateral delta, and close the original scenario.

With the default one-sided position, accept that the test proves either
redeemable-winner handling or correct losing-position finalization. The
deterministic tier should always cover both outcomes and a guaranteed winner.

## 10. Orchestration, idempotency, and safety

### 10.1 Harness state machine

Use an append-only runner state machine independent of the product state:

```text
DISCOVERED -> PLANNED -> PREFLIGHTED -> ARMED -> EXECUTING -> OBSERVING
                                                        |          |
                                                        |          +-> WAITING_FOR_RESOLUTION
                                                        +-> RECONCILE_REQUIRED

OBSERVING/RECONCILED -> ASSERTING -> VERDICT_RECORDED
    -> CLEANUP_OR_QUARANTINE -> PASSED | FAILED_SAFE | PENDING_EXTERNAL
```

Before each mutation, journal the exact planned action and an idempotency or
correlation key. After a possible broadcast, never retry merely because the UI
or RPC timed out. Query by known operation/action/transaction/order evidence
and enter reconciliation.

The authoritative runner state must live in a transactional shared control
store, separate from product tables. Use a fenced lease so only one current
writer can act for a test identity/wallet/chain. Local JSONL, traces, and
screenshots are replicated evidence, not recovery truth. Before a
controlled-wallet broadcast, durably record the signed transaction/request
fingerprint and nonce. Before an embedded-wallet action, durably record the
claimed product action/idempotency identity.

Use an explicit result taxonomy so infrastructure and market conditions cannot
masquerade as a product pass:

- `PASS`;
- `FAIL_PRODUCT`;
- `FAIL_INVARIANT`;
- `FAIL_EXTERNAL`;
- `BLOCKED_AUTH`;
- `SKIP_CAPABILITY`;
- `SKIP_LIQUIDITY`;
- `PENDING_EXTERNAL`;
- `RECONCILE_REQUIRED`.

### 10.2 Hard live guards

Live mode must require all of:

- explicit environment and chain genesis verification;
- dedicated test user and wallet fingerprints;
- expected-capability manifest approval;
- exact source, destination, asset contract/mint, decimals, and ownership;
- exact maximum input, minimum output, gas/rent, provider fee, venue fee, and
  slippage bounds;
- per-action, per-scenario, per-run, per-day, and realized-loss caps;
- an atomic global budget ledger shared by runners and resumers;
- separate raw-unit limits for gross debit, value at risk, realized loss, gas,
  and value allowed to remain stranded;
- native gas/rent reserve floors;
- destination and refund allowlists;
- quote and policy freshness;
- a fresh preflight immediately before mutation;
- a one-use signed authorization envelope binding environment, user/wallet,
  exact market/outcome/action, source and sink, raw-unit caps, minimum output,
  gas, code/config revisions, nonce, expiry, and plan hash;
- a fenced user/wallet/chain lease plus pending nonce/transaction checks;
- a global kill switch checked immediately before every signature or
  broadcast, not only once per scenario;
- an evidence and recovery path for every possible-broadcast action.

For open/variable receive only, when route precision and provider rules permit
it, give each tiny deposit a unique harmless raw-unit suffix. This makes receipt
correlation stronger than time-window matching. Never alter a strict
amount-bound transfer. The amount must still satisfy UI, token-decimal,
provider-minimum, quote, and spend constraints.

Compile the normalized plan twice before arming and require an unchanged route,
identity, asset, destination, and policy fingerprint. Quotes may legitimately
refresh; changes to the route identity or authorization boundary require a new
plan and one-use authorization.

Every exit path must enter either cleanup or quarantine. A cleanup success must
never convert a failed product/invariant assertion into `PASS`. Quarantined or
stranded value needs an owner, amount, chain/location, recovery plan, and alert
deadline. Before enabling real trades, define how known test identities are
handled by rewards, referrals, leaderboards, analytics, surveillance, and any
compliance reporting.

Suggested defaults should inherit the current WP7 envelope: approximately
$1-$3 orders where minimums allow, 20 POL and 30 pUSD as an initial circulating
wallet envelope, and a hard stop before 10 pUSD realized loss/fees. These are
configuration defaults, not authority to spend.

### 10.3 Polymarket Deposit Wallet constraint

Treat a Polymarket Deposit Wallet as a receive/funding boundary, not a general
controller wallet. Do not directly invoke its factory-only batch execution from
Privy and do not assume Privy policy can expand the Polymarket relayer
allowlist. Where recovery/routing needs value returned to the controller, use
only the supported user-authorized exact-amount pUSD transfer that the relayer
allows, followed by ordinary Hunch-controlled routing.

## 11. Evidence and pass criteria

A financial journey passes only when its required independent oracles agree.

| Oracle             | What it proves                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| UI                 | The user saw the correct address, economics, progress, recovery, and terminal result on the tested surface.                               |
| Authenticated API  | The intended user, wallet binding, capabilities, operation/action identity, and public state are correct.                                 |
| Read-only database | Durable steps, attempts, receipts, observations, reservations, order linkage, versions, and terminal semantics are internally consistent. |
| Chain/provider     | The exact source debit, canonical transaction/log/instruction, finality, destination credit or owned refund occurred.                     |
| Venue              | The order/action was accepted once and the authoritative fill, position, cash, or redemption state matches Hunch.                         |
| Accounting         | Raw-unit value changes fit the quoted input/output, gas, fees, slippage, fills, and expected residual balances.                           |

Minimum universal assertions:

- no success is inferred from an attempt or transaction hash alone;
- operation status/stage is an allowed pair and follows evidence;
- exact asset identities and raw units match at every boundary;
- no duplicate economic action or receipt allocation exists;
- active reservations equal intended obligations and are eventually consumed or
  released exactly once;
- ambiguous submissions remain non-terminal/reconciling until authoritative
  evidence arrives;
- Account Value does not double count in-transit or reserved value;
- secrets and full sensitive identifiers do not appear in artifacts.

## 12. Stable frontend automation contract

Consolidate a single versioned semantic automation contract shared by desktop
and mobile. Extend the existing `data-hunch-bot` and funding-operation hooks
first, with aliases during any later rename, instead of immediately creating a
third competing selector namespace. Do not select by CSS layout, copy text,
icon, or component nesting.

Suggested hooks:

- root auth state: combined Privy readiness, backend-session state, active
  venue, selected-wallet fingerprint, and embedded EVM/Solana presence;
- root flow and phase: `funding-flow`, `phase`;
- frozen intent fingerprint and public operation ID;
- destination venue, network, and asset identity;
- receive method/mode, address/QR, conditional expiry/expected amount, and
  receipt state;
- source option and composite source count;
- quote input/output/fee/minimum/expiry fields;
- review/confirm/back/cancel actions;
- action-request ID and execution kind;
- reservation readiness and consumer continuation state;
- trade submit, accepted, fill, and no-fill state;
- position row, sell, redeem, and reconciliation state;
- withdrawal destination binding and progress.

Expose only public or already user-visible identifiers. Never place signatures,
authorization material, raw provider calldata, private policy details, or
secrets in DOM attributes.

Add a small contract test that renders both desktop and mobile implementations
and proves the required semantic hooks and enum values are present.

Desktop/mobile selection is affected by user agent and a persistent device
override cookie. Use separate browser profiles/contexts per surface, or
explicitly reset and verify the override, so a mobile run cannot leak its mode
into a later desktop assertion.

## 13. Deterministic environment requirements

Build a test-only composition root with:

- production application modules built in an isolated test composition;
- disposable PostgreSQL and Redis;
- explicit backend dependency-injection seams plus a new implementation of the
  `LocalFundingSimulator` contract and simulated provider/RPC/indexer adapters;
- an injected frontend `AuthAdapter` and `NormalizedActionExecutor` (names
  illustrative) for hermetic identity and wallet-action execution;
- deterministic clock and seeded IDs;
- fixture control API bound only to loopback/test network;
- programmable market catalog, liquidity, balances, gas, receipts, fills,
  resolutions, refunds, and provider errors;
- API/worker kill and restart controls;
- strict startup assertion that environment is non-production;
- import graph test proving the fixture control and simulator cannot enter a
  production bundle/registry.

Fixture controls may seed/reset only the isolated test environment's canonical
market/indexer catalog, external balances, and simulated provider state before
a scenario, then inject external observations/faults as the scenario proceeds.
Funding operations, trades, receipts, reservations, and position actions must
still change through normal Hunch endpoints, workers, projectors, and
reconciliation. No fixture-control surface may exist in shared staging or
production.

Minimal supporting product/testability additions:

- a sanitized, read-only operation evidence view for non-production/admin-test
  use, exposing route/step/attempt identity, receipt/finality state, child
  operations, provider state, transaction references, and last worker
  observation without signatures or raw authorization payloads;
- optional validated `clientRunId`/`scenarioId` audit metadata, or an equivalent
  local correlation map, spanning funding, trade, and position actions;
- a shared market-candidate selector (or read-only endpoint) returning
  canonical event/market/outcome IDs, orderability, lifecycle, close time,
  minimum size, executable sides, spread/slippage, and redemption readiness;
- reusable fixture builders for account-value snapshots, wallet profiles,
  policy revisions, Relay payloads, EVM/Solana receipts and finality, venue
  orders/positions, worker leases, and the fake clock;
- scrubbed provider cassettes served by local fake HTTP/RPC processes, never by
  injecting fake events into shared staging;
- funding-specific metrics for operation age, recovery/reconciliation backlog,
  receipt-to-destination latency, duplicate suppression, and reservations.

Direct read-only database queries remain the strongest local oracle. A new
endpoint must not become a production auth bypass or permit fixture mutation.

For migration-sensitive tests, use an explicitly named disposable PostgreSQL
database and the repository's `--database-url` plus `--expect-database`
arguments. Never rely on an environment prefix that repository config may
replace.

## 14. Configuration and run artifacts

Illustrative configuration:

```yaml
schemaVersion: 1
environment:
  name: staging-mainnet
  webBaseUrl: https://example.invalid
  expectedCapabilityManifest: manifests/staging-mainnet.yaml
control:
  transactionalStoreRef: secret://hunch-e2e/control-store
  authorizationIssuer: hunch-e2e-operator
auth:
  browserProfile: profiles/staging-test-user
  expectedUserFingerprint: hmac:...
wallets:
  evmSourceKeyRef: keychain://hunch-e2e/evm-source
  solanaSourceKeyRef: keychain://hunch-e2e/solana-source
  withdrawalSinkAllowlist:
    - hmac:...
execution:
  mode: live
  maxScenarioUsd: "5"
  maxRunUsd: "30"
  maxDailyUsd: "50"
  maxRealizedLossUsd: "10"
coverage:
  venues: capability
  sourceAssets: capability
  sourceCounts: [1, 2, 3]
  surfaces: [desktop, mobile]
  suites: [receive, buy, sell, withdrawal, redemption]
```

Real configuration must use secret references and public fingerprints only.

Each run writes a gitignored mode-`0700` directory whose artifact files default
to mode `0600`, containing:

- immutable plan, hash, capability snapshot, policy/config hashes, Git SHAs,
  and dirty-tree fingerprints;
- append-only JSONL event/checkpoint journal;
- redacted API, DB, chain, and venue snapshots;
- before/after exact balance ledger;
- Playwright trace, screenshots, and video on failure;
- JUnit for CI and a concise HTML/Markdown report;
- cleanup/recovery status and any durable resume condition.

This directory is a local replica. The transactional control store is
authoritative for leases, budgets, action fingerprints, scenario state,
reconciliation, and asynchronous resume.

Use truncated HMAC fingerprints, not raw identifiers, in durable reports unless
the public address is essential evidence and storage policy explicitly allows
it.

## 15. CI and schedule

| Trigger                                                  | Suite                                                      | Mutation                                                |
| -------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| Pull request                                             | Tier A plus targeted deterministic Tier B                  | No real value                                           |
| Merge/develop nightly                                    | Full deterministic browser/state/chaos matrix              | No real value                                           |
| Scheduled daily                                          | Strict live observation                                    | Read-only calls and zero durable-state delta            |
| Scheduled daily or manual                                | Stateful live no-broadcast address, quote, and preparation | No signature/broadcast; ephemeral state is cleaned up   |
| Initially manual; later scheduled if separately approved | Small Polymarket/Limitless core canary selected by budget  | Tiny capped value                                       |
| Weekly/manual                                            | Enabled route/source/composite and withdrawal coverage set | Tiny capped value                                       |
| Frequent resumer                                         | Pending redemption/reconciliation nursery items            | Mutates only when pre-authorized condition becomes true |

Run live scenarios serially per test identity and wallet bundle. Deterministic
scenarios can run in parallel with isolated databases and browser profiles.

Production canaries, if ever enabled, should be a smaller separately approved
subset than staging-mainnet coverage. Do not make broad live-money execution a
pull-request gate.

Begin live-value runs with a human arm step. Unattended schedules should be
enabled only later under a separate, revocable auto-arm policy bound to exact
environment, scenario allowlist, identity, destinations, per-action/run/day
caps, and expiry. The scheduler must still produce and validate a fresh plan;
the standing permit must not authorize capability or policy drift.

## 16. Implementation roadmap and estimate

### Phase 0: contracts and baseline, 2-3 engineer-days

- approve identity/custody and environment model;
- freeze scenario taxonomy and capability manifest format;
- capture existing unit/integration inventory and WP7 requirements mapping;
- define semantic DOM hook contract and evidence schema.

### Phase 1: harness skeleton, 4-6 engineer-days

- standalone CLI, configuration, plan hash, checkpoint journal, reports;
- persistent browser bootstrap and `auth doctor`;
- same-origin API driver, capability discovery, and market selector;
- transactional control store, leases, budgets, and append-only action journal;
- source/sink wallet interfaces with fake signers only;
- non-mutating end-to-end smoke on desktop and mobile.

### Phase 2: deterministic full-stack, 2.5-4 engineer-weeks

- refactor backend and frontend auth/action/provider construction behind
  explicit injection seams and implement the simulator/test adapters;
- fixture/fault control, fake clock, disposable DB/Redis;
- core receive, BUY, SELL, withdrawal, redemption, restart, duplicate, and
  ambiguous-submission scenarios;
- UI/API/DB/accounting oracles and CI integration.

### Phase 3: first live value loop, 1-2 engineer-weeks

- secret-manager signer adapters and hard safety governor;
- a direct-settlement receive -> BUY -> SELL -> withdrawal pilot;
- stable receive/conversion and deposit+BUY continuation;
- robust cleanup, accounting, and operational runbook.

### Phase 4: breadth, 2-3 engineer-weeks

- Limitless CLOB/AMM and available risk families;
- Base/Solana sources, strict receive routes, one/two/three-source composites;
- pairwise/edge-cover compiler, live route reporting, mobile expansion;
- carefully bounded reconciliation observations.

### Phase 5: asynchronous lifecycle, 3-5 engineer-days

- redemption nursery, scheduler/resumer, resolution classification, and
  long-lived report closure.

A proof of architecture with the harness skeleton and one deterministic golden
flow is roughly **2-3 engineer-weeks**. A useful operational MVP with the core
deterministic recovery cases and one capped direct-settlement live loop is
roughly **5-8 engineer-weeks**. A broad, operationally safe suite is more
realistically **8-12 engineer-weeks** for one experienced engineer, depending
mainly on test-environment/auth composition, selector work, live safety review,
and which capabilities are actually activated. Parallel ownership can reduce
elapsed time, but not the verification scope.

## 17. Recommended first pilot

Implement this narrow vertical slice first:

1. Start production application code in the isolated test composition with
   disposable state and provably test-only auth/provider adapters.
2. Bootstrap the isolated test identity/session adapter and expected embedded
   wallet topology; verify real Privy session restoration separately in the
   live no-broadcast tier.
3. Open the normal token-first Add Funds flow, select the exact receive option
   whose binding targets Polymarket Polygon pUSD, and verify the returned
   network/asset/address/session/destination binding.
4. Inject a deterministic receipt and verify UI/API/DB readiness.
5. Select a liquid fixture market and submit one BUY.
6. Verify one order/fill/position across all oracles.
7. SELL the position and verify the remaining position/cash.
8. Withdraw to an allowlisted simulated sink.
9. Repeat with browser/API restarts after possible broadcast and prove no
   duplicate economic action.
10. Promote the same scenario shape to a tiny live run only after all guards
    and evidence pass.

This slice crosses identity, destination binding, receipt allocation,
operation state, reservation, venue preparation, trade submission, position
projection, action replay, withdrawal, and accounting. It therefore validates
the harness architecture before adding route breadth.

For the first live promotion, prefer direct Base USDC -> Limitless because it
has the simplest settlement topology, but only if the runtime capability and
the tested client both expose the required SELL/withdraw contract. If unified
automation still advertises Limitless as BUY-only, use it first for
receive/BUY evidence and use direct Polygon pUSD -> Polymarket for the first
full BUY/SELL loop. Do not silently rely on web implementation support that the
capability contract does not advertise.

## 18. Completion criteria

The test system is ready for routine use when:

- Tier A/B run deterministically from a clean checkout and produce repeatable
  results;
- no simulator or test-control dependency is reachable in production builds;
- both frontend surfaces implement the semantic automation contract;
- the harness can resume after every possible-broadcast checkpoint without a
  duplicate action;
- the live governor proves environment, identity, capabilities, caps,
  allowlists, and freshness immediately before spend;
- one Polymarket full live lifecycle passes, plus the enabled Limitless
  receive/BUY/REDEEM lifecycle and SELL only when the reviewed capability
  contract advertises it;
- compatible source counts and subsets through 16 contributors are proven
  deterministically; live sourceCount 1 is mandatory, while 2/3 follow the
  reviewed rotating coverage schedule;
- withdrawal reaches only a controlled allowlisted sink;
- at least one asynchronous redemption scenario closes end to end;
- every run has a complete redacted evidence bundle and exact balance
  reconciliation;
- disabled or unavailable capabilities are reported accurately and never
  forced.
