# WP6 Wallet Preparation and Position-Action Contract

Status: **pre-implementation contract frozen for WP5 planning and WP6
implementation; no caller has been migrated by this document.**

Captured on 2026-07-24 from:

- `hunch-monorepo` revision
  `d06bf60f9494691b4f4b267eb50502786fbff521`;
- `Hunch_App` revision
  `bdf65384c1227c39580882367b61bfbe86b74ba1`.

Both repositories were on `unibalance` with clean worktrees at capture time.
This artifact records current working behavior, the target ownership boundary,
required parity, and the evidence needed before legacy callers can be removed.
It does not authorize a transaction, policy change, rollout, deployment, or
legacy deletion.

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

### 4.5 Purpose matrix

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

## 11. Existing evidence and mandatory missing tests

Existing tests already cover parts of the contract:

- Privy/auth conflicts and wallet classification;
- embedded Polymarket bootstrap selection;
- Polymarket connect typed data and prepared authorization requests;
- signer, Safe, Magic, and Deposit Wallet action validation;
- Deposit Wallet transfer/wrap/redemption call allowlists and single-flight;
- normal/neg-risk Polymarket approval readiness;
- exact Funding Router amounts, nonce, cap, balance, and allowance failures;
- Polymarket standard/neg-risk redemption plan validation;
- Limitless auth profile binding/recovery and legacy-row rejection;
- Limitless AMM submit-boundary behavior;
- existing trade lifecycle, persistence, and delegated policy guards.

WP6 cannot be marked complete until the following explicit gaps are covered:

1. Privy provisioning tests for missing EVM only, missing Solana only, both
   missing, already-exists races, refresh failure, and backend reconciliation.
2. A table-driven Polymarket matrix for every preparation purpose across
   signer, Deposit Wallet, supported 1/1 Safe, Magic proxy, unsupported Safe
   threshold, undeployed contract, stale credential, and RPC uncertainty.
3. Separate normal and neg-risk Buy/Sell approval mutation suites.
4. Funding Router receipt-success-but-CLOB-not-visible, stale nonce, ambiguous
   broadcast, cap, lock, and reservation-release tests.
5. Limitless internal prepared-auth and external client-connect parity,
   including stale/foreign profile, recoverable/unrecoverable `409`, concurrent
   connect, and forced reconnect.
6. Separate Limitless CLOB and AMM preparation matrices covering exchange,
   adapter, approval, account freshness, balance/locks, quote/slippage, and
   unavailable upstream evidence.
7. Limitless standard and neg-risk redemption plan unit tests; the repository
   currently has no focused `limitless-redemption-plan-tests.ts`.
8. PM and Limitless redemption execution tests for internal and external
   owners, missing operator approval, wrong wallet, reverted receipt, ambiguous
   submit, marker failure after success, restart, and idempotent reconciliation.
9. Desktop/mobile parity tests proving both surfaces call one controller and do
   not contain venue readiness reducers after WP7 migration.
10. Import-graph and duplication checks proving Auth, Add Funds, Buy, Sell,
    Redeem, Withdraw, and Telegram no longer own copies of venue preparation.

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

If the adapter implementation is not yet present, WP5 uses deterministic
fixtures conforming to this contract. The planner output remains unreachable
from transaction execution until WP6 is parity-green.

## 13. Safe migration sequence

1. Freeze this contract and add missing test fixtures without changing callers.
2. Implement side-effect-free PM and Limitless inspection adapters over current
   services.
3. Implement normalized action preparation and postcondition verification as
   thin wrappers over existing execution boundaries.
4. Run old-versus-new parity tests for every matrix row.
5. Migrate one caller and purpose at a time behind local creation policy:
   Auth venue bootstrap, Add Funds, Buy, Sell, Redeem, Withdraw, then Telegram.
6. Keep old execution/reconciliation callable for already-started work.
7. Run guarded live rehearsals for exact PM settlement visibility, Limitless
   CLOB and AMM readiness, external setup, and both venue redemptions.
8. Remove a legacy branch only after import search, parity, recovery, type,
   lint, format, build, and live evidence are green.

## 14. Completion and review gate

WP6 is complete only when:

- every matrix row has a typed inspection result and exact required actions;
- `inspect` has no side effects and stale revisions fail closed;
- every internal/external wallet and funder topology retains the setup, trade,
  withdrawal, and redemption behavior currently supported for that topology;
  unsupported combinations fail closed;
- Polymarket pUSD is CLOB-visible before readiness;
- Limitless CLOB and AMM have distinct, tested readiness;
- redemption always uses the position owner and survives marker failure or
  restart without duplicate broadcast;
- Auth, Add Funds, Buy, Sell, Redeem, Withdraw, and Telegram consume one
  preparation contract instead of copies;
- existing trade quote, slippage, order, lifecycle, cancellation, and
  reconciliation guards remain green;
- no legacy caller or reconciliation path is removed merely because the target
  adapter exists;
- code review reports no unresolved money-safety, ownership, signing,
  idempotency, or recovery finding.

Live activation remains separately gated by current runtime policy, exact
Privy policies, guarded tiny-value evidence, and deployment approval.
