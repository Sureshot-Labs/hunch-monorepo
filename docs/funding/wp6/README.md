# WP6 Wallet Preparation and Position-Action Contract

Status: **contract frozen; the WP6 backend boundary is implementation-complete
and locally verified on 2026-07-24. WP7/WP8 caller migration, guarded live
rehearsal, and production activation remain separate work.**

Captured on 2026-07-24 from:

- `hunch-monorepo` revision
  `d06bf60f9494691b4f4b267eb50502786fbff521`;
- `Hunch_App` revision
  `bdf65384c1227c39580882367b61bfbe86b74ba1`.

Both repositories were on `unibalance` with clean worktrees when the contract
baseline was captured. The implementation described below is the subsequent
uncommitted local WP6 worktree. This artifact records current working behavior,
the target ownership boundary, required parity, and the evidence needed before
legacy callers can be removed. It does not authorize a transaction, policy
change, rollout, deployment, or legacy deletion.

## 0. Delivered backend boundary

WP6 now provides one backend-owned contract for wallet/venue preparation,
funding follow-up, durable action evidence, and owner-bound position actions:

- side-effect-free, purpose-aware Polymarket and Limitless inspection plus
  stale-revision rejection;
- normalized preparation actions and postcondition drivers without wallet
  provisioning or trade submission;
- exact Polymarket funding snapshots, source planning, Funding Router
  follow-up, receipt reconciliation, and CLOB-visible readiness;
- bounded multi-leg source composition whose independent legs share one
  operation, reducer, reservation model, and aggregate minimum-output gate;
- immutable action fingerprints, exact owned-wallet execution profiles,
  withdrawal-destination gates, and action-specific Privy sponsorship checks;
- durable EVM/Solana receipt references, possible-broadcast recovery,
  postconditions, reducer integration, reservation creation, expiry, release,
  and exact order/execution consumer linkage;
- owner-bound Polymarket and Limitless redemption through a generic
  `PositionActionVenueDriver` registry;
- public inspect/prepare/action-report/reconcile and
  position-action inspect/prepare/claim/report/reconcile APIs;
- no server-side Polymarket auto-funding inside trade submission: a buy may
  consume only an active, unexpired reservation from a `ready`
  `trade_shortfall` operation for the exact user, venue, and market; consuming
  the reservation atomically completes the operation, and the trade still
  passes the normal fresh quote/order boundary.

The common planner, operation state machine, receipt tables, reducer,
reservation model, and position-action runtime are venue-neutral. The
`future_venue` fixtures prove that a new stable venue ID passes the preparation
registry, position-action registry, public schema, and database persistence
without adding a core venue branch.

Production source is organized feature-first under:

```text
apps/api/src/funding/
  domain/
  planner/
  preparation/
  execution/
  persistence/
  reconciliation/
  position-actions/
  worker/
  tests/
    unit/
    integration/
```

The API test runner recursively discovers `*-tests.ts`; database suites carry
explicit `@requires-db` or `@api-integration` markers. New WP6 tests belong in
the feature test directories instead of the already crowded API `src` root.
Reorganizing unrelated legacy API files is intentionally outside WP6 because
it would create a large, behavior-free conflict surface.

This is a backend completion claim, not an activation claim. The existing web
Auth provisioning flow remains the single owner of embedded EVM/Solana wallet
creation. WP7 must migrate desktop/mobile callers to shared controllers, WP8
must migrate Telegram orchestration, and WP9 must perform guarded live parity
and activation evidence before legacy caller deletion.

## 1. Non-negotiable ownership boundaries

Wallet provisioning, venue preparation, funding, trading, and redemption are
different concerns:

| Concern                                                 | Single owner after WP6                                                                                         | Required behavior                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Privy user session and embedded EVM/Solana provisioning | existing frontend `AuthProvider` and Privy SDK                                                                 | Reuse the current idempotent provisioning path. Funding code must not create a second wallet provisioner. |
| User-wallet and Privy identity binding                  | existing backend auth and ownership resolver                                                                   | Derive `users.id` from the authenticated session and preserve verified `user_wallets` ownership.          |
| Venue binding and purpose-specific readiness            | venue `WalletPreparationAdapter`                                                                               | Inspect an exact binding and purpose without side effects; return typed evidence and required actions.    |
| Venue setup action construction                         | venue `WalletPreparationAdapter`                                                                               | Return normalized, bounded actions and postconditions; do not submit them.                                |
| Signature and transaction execution                     | existing web-client, Privy authorization, relayer, or network executor selected by the exact execution profile | Never promote a linked external address to managed execution.                                             |
| Polymarket funding follow-up                            | Polymarket preparation capability using the current Funding Router boundary                                    | Preserve nonce, cap, balance, allowance, exact-amount, and CLOB-visibility checks.                        |
| Buy/Sell order execution                                | existing venue `TradingExecutor`                                                                               | A preparation result never submits an order. Every trade uses a fresh market quote.                       |
| Redemption                                              | focused venue `PositionActionExecutor`                                                                         | Resolve the position-owning binding; never model redemption as funding or withdrawal.                     |
| Durable funding movement                                | `FundingOperation` and finance-worker                                                                          | Venue setup and redemption do not become provider segments merely because they contain transactions.      |
| UI orchestration                                        | WP7 shared controllers and thin renderers                                                                      | Call one preparation/position-action contract; do not reimplement readiness.                              |

Privy EVM/Solana wallet provisioning remains a prerequisite owned by
authentication. If it is incomplete, venue inspection returns a typed
`wallet_provisioning_pending` or `wallet_unavailable` result. It must not call
`createWallet` or `createSolanaWallet`.

## 2. Frozen target contract

The existing plan's `PreparationPurpose` remains authoritative:

```typescript
type PreparationPurpose = "fund" | "buy" | "sell" | "redeem" | "withdraw";

type PreparationStatus =
  | "ready"
  | "setup_required"
  | "user_action_required"
  | "unavailable";

type PreparationExecutionMode =
  | "web_client"
  | "privy_authorization"
  | "privy_delegated"
  | "venue_relayer";
```

`inspect` is side-effect free and returns, for one authenticated user, exact
binding, and purpose:

- opaque venue/binding IDs and a safe display label;
- signer/controller, execution wallet/funder, chain, and wallet topology;
- `internal_managed | external_ready | external_setup_available |
external_source_only | external_view_only`;
- deployment/registration/owner/threshold evidence where a contract wallet is
  involved;
- credential/profile presence, binding, validity, and freshness without
  returning secrets;
- purpose-specific balances, locks, spendability, allowances, approvals, gas,
  sponsorship, and market adapter/exchange evidence;
- exact execution mode and whether a user signature is required;
- typed reason codes, required normalized actions, postconditions, and
  freshness timestamps;
- a revision/hash that becomes stale when any security-relevant fact changes.

`prepare` re-inspects the same binding and purpose, validates the inspection
revision, and returns normalized actions only. The execution boundary submits
them. A subsequent `inspect` verifies every declared postcondition before
returning `ready`.

The contract must distinguish:

- missing setup from temporarily unavailable evidence;
- signer wallet from venue execution wallet/funder;
- general venue connection from market-type-specific readiness;
- funding-ready from buy-ready, sell-ready, redeem-ready, and withdraw-ready;
- action submission from receipt confirmation;
- receipt confirmation from venue-visible collateral/readiness;
- a recovery marker from settlement evidence.

No caller may interpret a generic `ready: true` without the exact purpose,
binding, revision, and readiness evidence.

### 2.1 Venue extension boundary

WP6 must not add venue branches to the planner, action runtime, receipt
runtime, or reducer. A venue-specific integration is split into three small
capabilities:

1. a destination/preparation adapter freezes purpose-specific binding and
   spendability facts;
2. an optional source adapter returns only the common immutable
   `plan + steps + reservations` contract;
3. an optional postcondition driver converts a finalized exact receipt plus
   venue-visible evidence into a common `venue_readiness` observation.

The composition root registers these adapters. The common quote, commit,
possible-broadcast, receipt, reservation, reducer, and consumer-linkage code
does not switch on venue ID or adapter ID. Adding a future venue may add
adapter implementations and registration, policy/location/route data, and
fixtures, but must not add another planner, operation state machine, receipt
table, balance reservation model, or caller-specific readiness path.

An adapter is accepted only when a fake independent adapter composes through
the same registry without changing core code, its provider/venue DTOs remain
inside the adapter, and unsupported facts return no selectable source rather
than falling through to another venue.

## 3. Current Privy provisioning and execution truth

### 3.1 Embedded wallet provisioning

`Hunch_App/src/providers/auth/AuthProvider.tsx` currently:

1. classifies Privy linked, embedded, smart, external, EVM, and Solana wallets;
2. refreshes the Privy user before concluding an embedded wallet is missing;
3. creates a missing embedded EVM wallet with `useCreateWallet`;
4. creates a missing embedded Solana wallet with `useCreateSolanaWallet`;
5. treats Privy's already-exists response as idempotent;
6. single-flights provisioning and reconciles the refreshed Privy snapshot with
   backend wallet rows.

WP6 must not move, duplicate, or weaken this behavior. In particular, a
funding or trading request must not create another embedded wallet, guess which
wallet is internal, or use a Privy-only wallet before backend ownership
reconciliation.

### 3.2 Wallet classification and authorization

- `Hunch_App/src/lib/auth/privy-wallets.ts` classifies wallet source and chain.
- `apps/api/src/privy-service.ts`, `apps/api/src/routes/auth.ts`, and
  `apps/api/src/auth.ts` bind the Privy user to `users` and `user_wallets`.
- `Hunch_App/src/hooks/trade/usePrivyAuthorizationRequests.ts` obtains user
  authorization for prepared Privy requests.
- `apps/api/src/services/embedded-privy.ts` validates internal wallet identity,
  builds prepared requests, and executes the exact authorized signature.
- `apps/api/src/services/api-trading-wallet-signing.ts` owns server/delegated
  authorization, action-specific policy validation, wallet ownership, and
  signing.

An external linked wallet always remains client-controlled. A wallet address,
balance, old venue credential, or previous setup is not sufficient authority
for server execution.

### 3.3 Gas readiness and sponsorship

For an exact internal EVM action, gas readiness may be proven by either:

- a fresh sufficient native-token balance for the exact execution wallet; or
- an exact Privy sponsorship capability resolved for the same wallet, network,
  action class, and immutable normalized action.

Sponsorship is not a wallet-wide property. `serverWalletRef`, internal-wallet
classification, a prior sponsored transaction, or the client requesting
`sponsor: true` is insufficient on its own. Before a committed action can carry
`payerRequirement=privy_sponsor`, the backend must:

1. resolve the same owned internal wallet profile and Privy wallet ID;
2. require the locally enabled sponsorship capability and execution mode;
3. validate the immutable transaction using its route/action-specific
   allowlist, including chain, target, selector/calldata, token, amount, native
   value, and bounded gas where applicable;
4. bind the sponsorship decision and validator result into the committed step;
5. re-resolve ownership, policy revision, action fingerprint, and sponsorship
   immediately before returning an executable authorization request;
6. treat Privy as the final policy and sponsorship enforcement boundary; and
7. reconcile the submitted transaction and destination postconditions instead
   of treating client or Privy acceptance as settlement.

An external wallet always remains `web_client` with
`payerRequirement=user`. If sponsorship evidence is absent, stale, mismatched,
or outside its cap, the action is not sponsorship-ready and must fall back to a
proven user-paid gas path or fail closed. EVM sponsorship does not grant
delegated trading authority and never permits a provider-supplied
`authorizationList`.

Solana fee sponsorship is not inferred from this EVM capability. It remains a
separate exact transaction-inspection policy with fee-payer, native transfer,
program, ATA, rent-recipient, and cap checks; otherwise sufficient user SOL is
required.

## 4. Current Polymarket truth

### 4.1 Binding topologies that must remain distinguishable

| Topology           | Current representation                                      | Execution constraints                                                                                                                  |
| ------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Signer/EOA funder  | signer equals funder; signature type 0                      | Exact signer ownership; direct client or authorized internal-wallet execution.                                                         |
| Legacy Magic proxy | `magic_proxy` or stored signature type 1                    | Canonical proxy factory and signer binding; proxy-specific transaction execution.                                                      |
| Safe-like funder   | `safe_proxy` or stored signature type 2                     | Deployed Safe-like contract, signer is an owner, supported threshold; internal automation currently requires 1/1.                      |
| Deposit Wallet     | stored signature type 3 and `deposit_wallet` execution kind | Deterministically derived for the signer, deployed/registered through the relayer, exact DepositWallet typed-data and call allowlists. |

`apps/api/src/services/polymarket-funder.ts` is the current source for
derivation, code inspection, Safe ownership/threshold, contract kind, and
signature type. A transient RPC failure is not proof that a stored funder
ceased to exist and must not clear it.

### 4.2 Internal wallet bootstrap

`AuthPolymarketWalletBootstrap` currently targets backend-linked internal EVM
wallets, prioritizes the selected wallet, and calls
`prepareEmbeddedPolymarketDepositWallet`. The current sequence is:

1. derive the canonical Deposit Wallet for the signer;
2. check deployment;
3. deploy through the Polymarket relayer when absent;
4. poll until the exact derived address is deployed;
5. connect Polymarket and persist encrypted credentials if absent;
6. bind the exact Deposit Wallet as the funder;
7. refresh account and funder derivation;
8. verify the stored funder and `deposit_wallet` execution kind;
9. apply required ERC-20 and ERC-1155 approvals through a constrained
   DepositWallet batch;
10. refresh and verify the postconditions.

The frontend and backend both use single-flight protection. Recoverable
already-deployed/duplicate responses still require on-chain postcondition
verification.

### 4.3 Credential and approval truth

Polymarket readiness currently includes:

- CLOB auth signature and encrypted API key/secret/passphrase storage;
- exact credential ownership by `(user, signer wallet, venue)`;
- stored funder address outside the encrypted secret payload;
- normal exchange, neg-risk exchange, and neg-risk adapter ERC-20 allowances;
- Conditional Tokens approvals for the normal exchange, neg-risk exchange,
  neg-risk adapter, CTF collateral adapter, and neg-risk collateral adapter;
- funder-topology-specific execution for signer, Safe, Magic proxy, and Deposit
  Wallet;
- fresh on-chain account snapshots and credential invalidation/repair.

Normal and neg-risk readiness must not be collapsed. Buy, Sell, Redeem, Fund,
and Withdraw require different subsets.

### 4.4 Funding Router follow-up

The current Funding Router plan is exact and must remain intact:

- canonical distinct Deposit Wallet and configured router;
- current `fundingNonce`;
- exact raw required amount and configured funding cap;
- Deposit Wallet pUSD and USDC.e availability after locks;
- signer pUSD and USDC.e top-up availability after locks;
- Deposit Wallet USDC.e-to-router allowance;
- signer pUSD-to-router and USDC.e-to-router allowances;
- one canonical `fund(expectedNonce,totalAmount,pUsdAmount)` call;
- actual receipt and resulting pUSD/CLOB-visible readiness before completion.

The router may use Deposit Wallet USDC.e first, then signer pUSD, then signer
USDC.e. It never sweeps unrelated funds. Router readiness is not an order
submission and is not inferred from a successful transaction alone.

### 4.5 Composite source legs

WP6 supports one backend-issued composite source option when no individual
owned source can cover the exact destination requirement but a bounded
combination can. This is not a generic token sweep and not an atomic
cross-chain transaction.

- discovery quotes every candidate leg independently through one enabled,
  pinned Relay route;
- each leg freezes one source component, exact input, expected/minimum output,
  fees, expiry, normalized actions, signer, gas or exact Privy sponsorship
  capability, and refund semantics;
- aggregate eligibility uses the sum of minimum outputs after fees/slippage;
- one SQL commit persists the ordered legs and reserves every source component;
- external legs then execute sequentially with per-leg possible-broadcast
  evidence and reconciliation;
- a confirmed leg is never broadcast again after restart;
- ambiguous submission stops the chain in `reconcile_required`;
- later failure leaves prior credits as ordinary venue cash and releases only
  unused reservations;
- full destination and venue readiness is required before completion;
- neither destination-ready nor partial funding submits a trade. Buy always
  obtains a fresh market quote and separate user confirmation.

The destination venue binding remains singular and immutable. Composite legs
may originate from different owned sources such as withdrawable Limitless cash,
an embedded EVM wallet, and a Solana USDC wallet, provided every corresponding
location has the exact source capability and executable route. Linked external
balances are never pulled without their explicit client actions.

### 4.6 Purpose matrix

| Purpose    | Minimum Polymarket evidence                                                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fund`     | Exact owned destination/funder; supported topology; deployment/registration when required; receipt observation; Funding Router postcondition where required; final pUSD visibility.                                  |
| `buy`      | `fund` evidence for the exact shortfall plus valid credentials, market-specific normal/neg-risk allowances, locks, fresh quote, and exact signer/execution path.                                                     |
| `sell`     | Position-owner binding, credentials, executable shares after locks, market-specific Conditional Tokens approvals, and exact signer/execution path. No Funding Router requirement.                                    |
| `redeem`   | Position-owner binding, canonical standard/neg-risk redemption adapter plan, operator approval where required, supported signer/Safe/Magic/Deposit Wallet execution, receipt and position/collateral reconciliation. |
| `withdraw` | Exact owner binding, supported asset/recipient, topology-specific validated call, receipt and destination observation. Buy/Sell approvals do not imply withdrawal authority.                                         |

## 5. Current Limitless truth

### 5.1 Connection has two distinct signing paths

Internal embedded wallet:

1. `AuthLimitlessWalletBootstrap` chooses a backend-linked internal EVM wallet;
2. `/embedded/ensure-ready/prepare` resolves the exact internal Privy wallet;
3. the backend obtains a fresh Limitless signing message;
4. the user authorizes the prepared Privy `personal_sign` request;
5. `/embedded/ensure-ready/execute` executes only that request;
6. the backend creates or recovers the partner account and stores its profile.

External client wallet:

1. `runLimitlessConnectFlow` requires the selected EVM wallet/provider;
2. it obtains a fresh signing message;
3. the client attempts the supported `personal_sign` parameter orders and
   bounded `eth_sign` fallback;
4. `/auth/login` binds the resulting partner profile to the same account;
5. account and wallet queries are invalidated and re-read.

Both paths use Limitless partner HMAC on the server. A `409` profile-exists
response is recoverable only when the exact account profile ID can be recovered.
Profiles bound to another account are rejected. Stored legacy rows are not
silently upgraded to partner auth.

### 5.2 CLOB and AMM preparation are separate capabilities

The current CLOB preparation checks:

- valid Limitless credentials/profile for the exact wallet;
- current market exchange resolution;
- whether a market-specific adapter is required and resolved;
- fallback/exchange lookup completion;
- fresh account snapshot;
- sufficient Base USDC;
- purpose-specific USDC allowance;
- Conditional Tokens approval for Sell;
- adapter approval when the market requires it.

The current AMM preparation checks:

- valid Limitless credentials/profile for the exact wallet;
- fresh on-chain account snapshot;
- sufficient Base USDC;
- exact AMM USDC allowance for Buy;
- Conditional Tokens/adapter approval for Sell when applicable;
- canonical market address and token/outcome mapping.

The adapter must not reuse a CLOB exchange address for AMM or omit an AMM
spender because the wallet is generally connected. Conversely, general
connection does not prove either CLOB or AMM readiness.

The existing generic wallet summary in
`apps/api/src/routes/wallets.ts`/`Hunch_App/src/lib/api/wallets.ts` exposes
`LimitlessVenueStatus.ready` from exact-wallet credentials and positive Base
USDC only. It is suitable for wallet-list/bootstrap hints, but it is not an
executable CLOB or AMM readiness verdict: it has no market, side, exchange,
adapter, spender, approval, quote, or position context. WP6 must preserve that
distinction in types and must not promote this summary to
`PreparationResult.ready`.

### 5.3 Limitless purpose matrix

| Purpose           | Minimum Limitless evidence                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fund`            | Exact owned Base USDC destination, receipt observation, locks/freshness, and typed distinction between cash received and venue ready.                            |
| `buy` CLOB        | Valid exact-wallet profile, exchange/adapter resolution, fresh account, Base USDC after locks, exact allowance, enforceable quote/slippage path.                 |
| `sell` CLOB       | Position-owner binding, valid profile, exchange/adapter resolution, executable shares after locks, Conditional Tokens/adapter approvals, enforceable order path. |
| `buy` AMM         | Valid exact-wallet profile, canonical AMM market, fresh Base USDC, exact spender allowance, bounded AMM quote and minimum output.                                |
| `sell` AMM        | Position-owner binding, canonical AMM market, fresh token balance, Conditional Tokens/adapter approvals, bounded output.                                         |
| `redeem` standard | Position-owner binding, resolved condition, exact token balance, direct Conditional Tokens redemption plan, receipt and projection reconciliation.               |
| `redeem` neg-risk | Position-owner binding, resolved condition, exact token balance, canonical adapter and operator approval, receipt and projection reconciliation.                 |
| `withdraw`        | Exact owner binding, supported Base asset and validated recipient; venue credentials do not grant transfer authority.                                            |

Telegram Limitless CLOB remains unavailable until its submitted order can
enforce the required price/slippage guard. Funding readiness must never bypass
that trading restriction.

## 6. Redemption contract for both venues

Redemption is a position action, not a funding operation:

1. resolve the exact stored position wallet and canonical venue binding;
2. require the selected/available signer to control that binding;
3. read fresh resolution, token balance, adapter, and approval state;
4. build a canonical venue plan on the backend;
5. revalidate plan target/calldata/owner immediately before execution;
6. execute through the exact supported signer, Safe, Magic proxy, Deposit
   Wallet, or internal Privy path;
7. treat an ambiguous submission as reconcile-required, never as retryable;
8. require a successful receipt and then refresh position/collateral evidence;
9. record Activity/notification idempotently;
10. never switch an externally owned position to the internal Hunch wallet.

Current web redemption uses a retrying notification marker after transaction
submission and schedules position sync. The marker is compatibility evidence,
not settlement authority. WP6 must preserve its UI/history behavior while the
focused executor makes transaction hash, receipt, owner, and reconciliation
the authoritative result. A marker failure after a successful receipt must be
recoverable without another redemption transaction.

Polymarket must preserve:

- standard and neg-risk canonical adapter validation;
- combined YES/NO payout calculation;
- Deposit Wallet relayer batches, including optional USDC.e-to-pUSD wrap;
- Safe and Magic proxy paths;
- direct/internal signer paths;
- owner and funder binding throughout.

Limitless must preserve:

- standard Conditional Tokens redemption;
- neg-risk adapter redemption and required approval;
- internal Privy and external client execution;
- exact token ID normalization and position balance;
- Base chain receipt and projection refresh.

## 7. Persistence, security, and lifecycle invariants

- `users` and verified `user_wallets` remain the identity/ownership truth.
- `user_venue_credentials` remains unique by user, wallet, and venue.
- Venue secrets remain encrypted at rest; inspection returns metadata only.
- Polymarket funder address remains distinct from credential secrets.
- Limitless stored profile must match the exact account and retain
  `partner_hmac` auth mode.
- Credential repair never changes the selected binding or position owner.
- User merge, wallet removal, deactivation, and deletion must include venue
  credentials and must not strand an in-flight setup/action.
- A funding reservation is consumed/released with the trade lifecycle; setup
  actions do not reserve or spend unrelated venue cash.
- No UI success callback, Privy modal result, relayer acceptance, notification
  marker, or cached `ready` value settles accounting.
- Every external action requires an explicit client signature.
- Every internal/delegated action requires exact wallet ownership, policy,
  action allowlist, cap, and postcondition evidence.

## 8. Side-effect and idempotency ledger

| Side effect                                 | Required idempotency/correlation                                   | Completion evidence                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Privy embedded EVM/Solana creation          | existing Privy user + wallet type; frontend single-flight          | refreshed Privy snapshot and backend wallet reconciliation                     |
| Polymarket credential creation/repair       | user + signer + prepared auth nonce/timestamp                      | encrypted exact-wallet credential row and successful verification              |
| Limitless partner profile creation/recovery | user + exact wallet + advisory lock                                | exact account profile ID persisted and verified                                |
| Deposit Wallet deployment                   | signer-derived Deposit Wallet address + single-flight              | deployed code at the same derived address                                      |
| Safe/Magic/Deposit Wallet selection         | user + signer + funder + topology revision                         | stored exact funder and fresh topology inspection                              |
| ERC-20/ERC-1155 approval                    | chain + owner/funder + token + spender/operator + purpose          | fresh allowance/approval postcondition                                         |
| Funding Router call                         | operation/intent + signer + Deposit Wallet + funding nonce         | successful receipt plus pUSD/CLOB-visible delta                                |
| Limitless venue preparation approval        | wallet + market class + exact spender/operator + purpose           | fresh account/allowance postcondition                                          |
| Trade submit                                | existing trade intent/idempotency and venue order IDs              | existing trade lifecycle/reconciliation                                        |
| Redemption submit                           | position owner + venue + condition/token + action digest           | tx hash/possible-broadcast record, receipt, position/collateral reconciliation |
| Redemption marker/activity                  | venue + tx hash, with owner/market fallback only for compatibility | idempotent Activity/notification; never settlement by itself                   |

## 9. Caller migration matrix

| Caller         | Current behavior to preserve                                                     | WP6 migration boundary                                                                                                 |
| -------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Auth bootstrap | Provisions Privy wallets; proactively prepares internal PM and Limitless wallets | Keep Privy provisioning in Auth; replace venue-specific setup bodies with exact adapter calls only after parity tests. |
| Add Funds      | Chooses destination and performs venue follow-up in Deposit/bridge branches      | WP5 selects an opaque destination; WP6 performs only the selected binding's purpose=`fund` preparation.                |
| Buy            | Mixes readiness, approvals, funding, and submit in trade hooks/services          | Inspect/prepare first; verify reservation and fresh quote; submit remains a separate executor call.                    |
| Sell           | Uses position wallet, venue approvals, and submit path                           | Purpose=`sell`; no wallet substitution and no funding-router side effect.                                              |
| Redeem         | Desktop/mobile hooks execute PM/Limitless plans and write a marker               | Focused owner-bound `PositionActionExecutor`; preserve current render/recovery until backend evidence is parity-green. |
| Withdraw       | Current Deposit withdraw paths own recipient and venue conversions               | Purpose=`withdraw`; independent gate and action allowlist.                                                             |
| Telegram       | Existing PM delegated readiness and trade-intent lifecycle                       | WP8 consumes the same adapter; unsupported Limitless CLOB and delegated redeem remain off.                             |

No old caller is deleted when an adapter merely compiles. Each row migrates
only after its current and target paths pass the same fixtures, fault
injections, local integration tests, and guarded live rehearsal where required.

## 10. Complete source touchpoint map

### Backend

Identity and execution:

- `apps/api/src/privy-service.ts`
- `apps/api/src/auth.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/wallets.ts`
- `apps/api/src/services/embedded-privy.ts`
- `apps/api/src/services/api-trading-wallet-signing.ts`

Polymarket:

- `apps/api/src/routes/polymarket-private.ts`
- `apps/api/src/services/polymarket-funder.ts`
- `apps/api/src/services/polymarket-onchain.ts`
- `apps/api/src/services/polymarket-credentials.ts`
- `apps/api/src/services/polymarket-embedded.ts`
- `apps/api/src/services/polymarket-deposit-wallet-relayer.ts`
- `apps/api/src/services/polymarket-relayer-signing.ts`
- `apps/api/src/services/polymarket-funding-router.ts`
- `apps/api/src/services/polymarket-max-spend.ts`
- `apps/api/src/services/polymarket-trading-execution-service.ts`
- `apps/api/src/services/polymarket-redemption-plan.ts`
- `apps/api/src/services/redemption-plan.ts`
- `apps/api/src/services/redemption-status.ts`

Limitless:

- `apps/api/src/routes/limitless-private.ts`
- `apps/api/src/services/limitless-auth.ts`
- `apps/api/src/services/limitless-client.ts`
- `apps/api/src/services/limitless-onchain.ts`
- `apps/api/src/services/limitless-trading-service.ts`
- `apps/api/src/services/limitless-trading-execution-service.ts`
- `apps/api/src/services/limitless-redemption-plan.ts`
- `apps/api/src/services/limitless-redemption.ts`
- `apps/api/src/services/redemption-plan.ts`
- `apps/api/src/services/redemption-status.ts`

Compatibility, Activity, and consumers:

- `apps/api/src/routes/notifications.ts`
- `apps/api/src/services/notifications.ts`
- position repositories and sync services
- `apps/api/src/services/telegram-bot-trading.ts`
- Telegram trade-intent reconciliation and action rows
- user merge, wallet removal, deactivation, deletion, and retention selectors

### Frontend

Auth and Privy:

- `src/providers/auth/AuthProvider.tsx`
- `src/providers/auth/AuthPrivyProvider.tsx`
- `src/providers/auth/AuthPolymarketWalletBootstrap.tsx`
- `src/providers/auth/AuthLimitlessWalletBootstrap.tsx`
- `src/lib/auth/privy-wallets.ts`
- `src/lib/auth/embedded-polymarket-bootstrap-rules.ts`
- `src/hooks/trade/usePrivyAuthorizationRequests.ts`
- `src/hooks/trade/useEmbeddedEvmTransactions.ts`

Polymarket:

- `src/hooks/trade/useEmbeddedPolymarketPreparation.ts`
- `src/hooks/trade/useEmbeddedPolymarketTypedDataSigner.ts`
- `src/hooks/trade/usePolymarketConnect.ts`
- `src/hooks/trade/usePolymarketFunderSelection.ts`
- `src/hooks/trade/usePolymarketRelayer.ts`
- `src/hooks/trade/usePolymarketTrade.ts`
- `src/hooks/trade/usePolymarketRedemption.ts`
- `src/lib/trade/polymarket-embedded-ready.ts`
- `src/lib/trade/embedded-polymarket-deposit-wallet.ts`
- `src/lib/trade/polymarket-funder-utils.ts`
- `src/lib/trade/polymarket-funding-router.ts`
- Polymarket Deposit/Convert/Withdraw and confirmation callers

Limitless:

- `src/hooks/trade/useLimitlessConnect.ts`
- `src/hooks/trade/useLimitlessTrade.ts`
- `src/hooks/trade/useLimitlessAmmTrade.ts`
- `src/hooks/trade/useLimitlessTradeAdapter.ts`
- `src/hooks/trade/useEmbeddedLimitlessPreparation.ts`
- `src/hooks/trade/useEmbeddedLimitlessAmmPreparation.ts`
- `src/hooks/trade/useLimitlessRedemption.ts`
- `src/lib/trade/limitless-connect-flow.ts`
- `src/lib/trade/limitless-embedded-ready.ts`
- `src/lib/trade/limitless-approval-bundle.ts`

Shared redemption and UI:

- `src/hooks/trade/useRedemptionWalletGate.ts`
- `src/hooks/trade/redemption-marker.ts`
- `src/features/Redemption/desktop/RedemptionDialog.tsx`
- `src/features/Redemption/mobile/RedemptionDrawer.tsx`
- confirmation wallet/funder models and renderers
- desktop/mobile Deposit, Convert, Bridge, and Withdraw implementations

The source map is a migration checklist. A replacement is incomplete if any
listed caller still independently computes readiness or submits an untracked
setup action.

## 11. Backend evidence and remaining cross-WP validation

The locally passing backend evidence covers:

- Privy/auth conflicts and wallet classification;
- Polymarket connect typed data and prepared authorization requests;
- signer, Safe, Magic, and Deposit Wallet topology/action validation;
- Deposit Wallet transfer/wrap/redemption call allowlists and single-flight;
- normal/neg-risk Polymarket purpose and approval readiness;
- exact Funding Router amounts, nonce, cap, balance, and allowance failures;
- receipt-success-but-not-visible, ambiguous submission, restart, and
  postcondition reconciliation;
- atomic reservation creation, expiry, release, order/execution linkage, and
  operation completion;
- Polymarket and Limitless standard/neg-risk redemption planning;
- generic position-action persistence, ownership, submission claim, receipt,
  postconditions, recovery, and independent future-venue registration;
- Limitless auth profile binding/recovery and legacy-row rejection;
- distinct Limitless CLOB/AMM facts and AMM submit-boundary behavior;
- exact sponsorship allowlists and action-fingerprint revalidation;
- multi-leg partial coverage, aggregate readiness, and partial-failure recovery;
- existing trade lifecycle, persistence, and delegated policy guards.

Local verification on 2026-07-24:

- all migrations `0000` through `0187` applied to a clean temporary database;
- focused funding/action/planning/position-action DB suites passed `5/5`;
- the complete API unit runner passed `114/114` files;
- repository format, lint, typecheck, and build gates passed;
- the deterministic production-only duplication scan over 42 WP6 core files
  (tests excluded, minimum 60 tokens/5 lines) reported Type-1 coverage
  `1.066%` with `0.540%` estimated redundancy and Type-2 coverage `7.457%`
  with `3.725%` estimated redundancy;
- venue-branch and secret-placeholder scans found no unresolved core venue
  switch or embedded secret.

The complete API integration runner still exposes one pre-existing,
WP6-unrelated assertion in `clusters-routes-tests.ts` for
`sort_dir=asc`. Its runner lifecycle was corrected so the failure is reported
instead of being hidden by `process.exit`; the unrelated cluster sorting
behavior was not changed in WP6.

The remaining validation belongs to later packages and is not silently counted
as backend evidence:

1. WP7: missing-EVM/missing-Solana/already-exists frontend provisioning races
   and desktop/mobile parity through one controller.
2. WP7: removal of web-owned preparation reducers only after per-caller parity.
3. WP8: Telegram preparation/reservation integration and delegated-policy
   mutation/revocation coverage.
4. WP9: guarded live PM/Limitless preparation, CLOB visibility, redemption,
   Privy sponsorship, and restart evidence for the exact capabilities proposed
   for activation.
5. WP9: final import-graph proof that activated Auth, Add Funds, Buy, Sell,
   Redeem, Withdraw, and Telegram callers no longer own parallel preparation
   logic.

## 12. WP5 planning prerequisite

WP5 may depend only on:

- side-effect-free preparation inspection;
- a deterministic simulator for required actions and readiness class;
- opaque destination/binding IDs;
- typed route unavailability;
- estimated setup time/cost based on frozen evidence.

WP5 must not:

- invoke Privy provisioning, connect/login, deployment, approvals, Funding
  Router, redemption, or a trade;
- plan against a generic venue-wide `ready` boolean;
- choose a different binding because it has a larger balance;
- assume successful funding means Buy-ready;
- assume credentials are required for an owner-bound on-chain redemption when
  the exact venue action does not require them;
- silently choose CLOB or AMM execution without the market binding.

WP5 originally used deterministic fixtures while real adapters were absent.
The real WP6 adapters now satisfy this local prerequisite. Planner output
remains unreachable from production transaction execution while creation
policy is off and until WP7/WP8 caller migration plus WP9 activation evidence
are complete.

## 13. Safe migration sequence

1. Freeze this contract and add missing test fixtures without changing callers.
2. Implement side-effect-free PM and Limitless inspection adapters over current
   services.
3. Implement normalized action preparation and postcondition verification as
   thin wrappers over existing execution boundaries.
4. Verify the backend matrices, persistence, recovery, and independent-adapter
   extension boundary.
5. In WP7/WP8, migrate one caller and purpose at a time behind local creation
   policy:
   Auth venue bootstrap, Add Funds, Buy, Sell, Redeem, Withdraw, then Telegram.
6. Keep old execution/reconciliation callable for already-started work.
7. In WP9, run guarded live rehearsals for exact PM settlement visibility,
   Limitless CLOB and AMM readiness, external setup, and both venue
   redemptions.
8. Remove a legacy branch only after import search, parity, recovery, type,
   lint, format, build, and live evidence are green.

## 14. Completion and review gate

The WP6 backend boundary is complete when:

- every matrix row has a typed inspection result and exact required actions;
- `inspect` has no side effects and stale revisions fail closed;
- every internal/external wallet and funder topology retains the setup, trade,
  withdrawal, and redemption behavior currently supported for that topology;
  unsupported combinations fail closed;
- Polymarket pUSD is CLOB-visible before readiness;
- Limitless CLOB and AMM have distinct, tested readiness;
- redemption always uses the position owner and survives marker failure or
  restart without duplicate broadcast;
- existing trade quote, slippage, order, lifecycle, cancellation, and
  reconciliation guards remain green;
- no legacy caller or reconciliation path is removed merely because the target
  adapter exists;
- a fake independent venue passes preparation, position-action, API schema, and
  persistence without modifying the core state machine or reducer;
- code review reports no unresolved money-safety, ownership, signing,
  idempotency, or recovery finding.

The cross-package migration is complete only after WP7/WP8 make Auth, Add
Funds, Buy, Sell, Redeem, Withdraw, and Telegram consume the shared contract
instead of copies. Live activation remains separately gated by current runtime
policy, exact Privy policies, guarded tiny-value evidence, WP9 review, and
deployment approval.
