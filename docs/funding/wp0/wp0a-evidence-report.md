# WP0A read-only evidence report

Audit date: **2026-07-23**  
Normative plan: `docs/unified-account-value-relay-funding-plan-v2.md`  
Scope: local source, production host/Postgres/schedules/logs, Privy Dashboard,
official provider documentation, and deterministic duplicate analysis.

## Safety and method

All remote actions were reads. SQL returned schemas and aggregates only; no
wallet addresses, user identities, payload bodies, secrets, or signing material
are reproduced here. Privy was inspected without clicking Edit, Save, Create,
Test, or Delete. No branch, code, configuration, deployment, database row,
policy, webhook, or schedule was changed.

## Pinned source revisions

| Repository        | Branch at capture                                      | Revision                                   |
| ----------------- | ------------------------------------------------------ | ------------------------------------------ |
| `hunch-monorepo`  | `develop` (one local commit ahead of `origin/develop`) | `5b1407d840ff7565f07d5e23bb4efa1bbfac3de7` |
| `Hunch_App`       | `develop`                                              | `61653f29184cf9fd4256e4ca22d9f3dd492a4717` |
| `hunch-admin`     | `master`                                               | `f33e5d67c9a3b98779400e1399b5a862f2b858cf` |
| `hunch-trade-bot` | `main`                                                 | `8bde25ae41e26c2e0907d65e105fe62f6c392142` |

Production was running frontend image `hunch-web:61653f2` and backend image
`hunch-backend:072d25a`. The latest applied DB migration was schema revision
191, `0182_telegram_bot_action_outbox.sql`, applied 2026-07-22 14:22:09 UTC.

## Current touchpoint inventory

| Area                                | Current source owners                                                                                                                                                                                                            | Finding / WP replacement owner                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge API and persistence          | `apps/api/src/routes/bridge.ts`; `apps/api/src/schemas/bridge.ts`; migrations `0034`, `0035`, `0096`                                                                                                                             | Legacy quote/create/list/sync surface. Keep reconciliation compatibility only; `FundingPlatformOwner` owns replacement.                 |
| Across                              | `apps/api/src/services/across-bridge.ts`; `apps/api/src/services/bridge-status.ts`                                                                                                                                               | Production contains both legacy Suggested Fees and Swap API shapes. Split versioned reconcilers; no new Suggested Fees creation.        |
| deBridge/Bungee                     | `apps/api/src/services/debridge-client.ts`; bridge route/status code                                                                                                                                                             | deBridge cross- and same-chain historical shapes are active. Bungee has no production rows and remains legacy-only.                     |
| Privy deposits                      | `apps/api/src/routes/privy-webhooks.ts`; `apps/api/src/services/deposit-events.ts`; migrations `0097`, `0100`, `0116`                                                                                                            | Idempotent incoming deposit ingestion exists. Only funds-deposited is enabled; outgoing settlement needs executor/receipt observation.  |
| Authentication and wallet ownership | `apps/api/src/auth.ts`; `apps/api/src/routes/auth.ts`; `apps/api/src/lib/resolve-wallets.ts`; `apps/api/src/routes/wallets.ts`; `apps/api/src/services/embedded-privy.ts`                                                        | Reuse `users.id` and current wallet facts; no second account registry.                                                                  |
| Polymarket                          | `apps/api/src/services/polymarket-trading-execution-service.ts`; `polymarket-funder.ts`; `polymarket-funding-router.ts`; `polymarket-embedded.ts`; `polymarket-redemption-plan.ts`; `redemption-plan.ts`; `redemption-status.ts` | Split readiness, destination, trade, position, and redemption capabilities. Preserve Safe/deposit-wallet owner binding.                 |
| Limitless                           | `apps/api/src/services/limitless-trading-execution-service.ts`; `limitless-client.ts`; `limitless-onchain.ts`; `limitless-auth.ts`; `limitless-redemption-plan.ts`; `limitless-redemption.ts`                                    | Split readiness, destination, trade, position, and redemption capabilities.                                                             |
| Solana/Kalshi                       | `apps/api/src/services/kalshi-dflow-transaction-safety.ts`; `packages/shared/src/venue-lifecycle.ts`; `apps/api/src/routes/embedded-wallets.ts`                                                                                  | Solana sponsorship must validate exact actions. Kalshi/DFlow is maintenance/exit-only and is not a new funding destination.             |
| Telegram                            | `apps/api/src/routes/telegram-bot-trading.ts`; `apps/api/src/services/telegram-bot-trading.ts`; `telegram-trade-intents-reconcile.ts`; migrations `0166`, `0167`, `0168`, `0172`, `0181`, `0182`                                 | Schema supports buy/sell/redeem, but production has no delegated redeem policy. Redeem remains fail-closed.                             |
| Notifications                       | `apps/api/src/services/notifications.ts`; notification routes/repository; Telegram delivery code                                                                                                                                 | Reuse one durable operation status vocabulary; do not create a provider-specific notification state machine.                            |
| Admin and runtime policy            | `apps/api/src/routes/admin.ts`; `apps/api/src/admin-merge-user-core.ts`; `hunch-admin` finance/wallet/user panels                                                                                                                | Add typed funding policy read/diff/confirm/publish; update merge coverage for all new tables.                                           |
| Retention/deletion                  | `apps/api/src/market-retention-selector.ts`; analytics retention; `apps/api/src/auth.ts`                                                                                                                                         | Current user deletion hard-deletes `users`, while `bridge_orders` cascades. New finance records require block/pseudonymize semantics.   |
| Finance worker                      | `apps/finance-worker/src/main.ts`; `apps/finance-worker/src/scheduler.ts`; `apps/finance-worker/src/finance-jobs.ts`; `apps/finance-worker/src/locks.ts`                                                                         | Current periodic lock is process-local. WP3 requires durable leases and restart-safe queues. No current bridge polling schedule exists. |
| Web funding UI                      | `Hunch_App/src/components/Deposit*`; `src/lib/deposit/*`; `src/lib/bridge/*`; `src/features/Header/desktop/HeaderWallet*`; `src/features/Wallet/*`                                                                               | Desktop/mobile Deposit/Convert/Withdraw implementations are heavily duplicated. Replace with one controller/reducer and shared views.   |
| Web trade/position UI               | `Hunch_App/src/hooks/trade/*`; confirmation model; portfolio hooks; redemption hooks                                                                                                                                             | Preserve currently working PM/Limitless Buy/Sell/Redeem paths until parity evidence exists.                                             |
| Local bot                           | `hunch-trade-bot/src/polymarket-funds.ts`; `positions.ts`; `redeem.ts`                                                                                                                                                           | Keep web-controlled Privy signing; integrate only through the same readiness/recovery contracts.                                        |

## Frozen production legacy adapter classifier

Classifier order is significant. It classifies all 255 production rows and has
**zero unknown rows** as of the audit.

| `adapter_version`           | Deterministic predicate                                                        | Rows | Current status distribution                                    |
| --------------------------- | ------------------------------------------------------------------------------ | ---: | -------------------------------------------------------------- |
| `across_swap_api_v1`        | `provider='across'` and `metadata.across.providerPayload.swapTx` exists        |   56 | 4 created, 52 fulfilled                                        |
| `across_suggested_fees_v1`  | `provider='across'` and `metadata.across.providerPayload.capitalFeePct` exists |   87 | 24 created, 63 fulfilled                                       |
| `debridge_dln_create_tx_v1` | deBridge + `cross_chain` + non-null `order_id` + object `metadata.estimation`  |   84 | 2 `Fulfilled`, 66 created, 1 failed, 13 fulfilled, 2 submitted |
| `debridge_same_chain_v1`    | deBridge + `same_chain` + object `metadata.tokenIn` and `metadata.tokenOut`    |   28 | 6 created, 1 failed, 17 fulfilled, 4 submitted                 |
| `bungee_legacy_v1`          | `provider='bungee'`                                                            |    0 | none                                                           |

Status spelling is already inconsistent (`Fulfilled` and `fulfilled`). The
current canonicalizer maps provider-created/pending/fulfilled/refund/failure
families, so database spelling must not be used as the future domain state.

Additive backfill rule: add nullable `adapter_version`, run this classifier as a
read-only report and require unknown count zero, then update only
`adapter_version`. Do not rewrite payload, status, amounts, hashes, or ownership,
and do not turn historical rows into `funding_operations`.

### Non-terminal inventory

There are **106** rows in normalized `created/submitted`: 100 created and 6
submitted. Age from `updated_at`:

| Version                     | Active | <1 day | 1–7 days | 7–30 days | >=30 days |
| --------------------------- | -----: | -----: | -------: | --------: | --------: |
| `across_suggested_fees_v1`  |     24 |      0 |        0 |         1 |        23 |
| `across_swap_api_v1`        |      4 |      0 |        0 |         0 |         4 |
| `debridge_dln_create_tx_v1` |     68 |      0 |        0 |         0 |        68 |
| `debridge_same_chain_v1`    |     10 |      0 |        1 |         0 |         9 |

The oldest non-terminal update is 2026-02-16; the newest is 2026-07-16.
This is a reconciliation backlog signal, not proof of 106 live transfers.
Deletion of a legacy reconciler requires provider/chain re-query plus terminal
or explicitly adjudicated disposition for every applicable row.

## Deposit, Telegram, and policy facts

- `deposit_events`: 910 rows; 468 notified, 83 ignored bridge, 78 ignored
  internal, 259 ignored venue, 22 unresolved; duplicate source/idempotency keys: 0. Fourteen ignored bridge events are linked to `bridge_orders`.
- All observed deposit payloads share the stable core keys for amount, asset,
  block, CAIP-2, idempotency, recipient, sender, transaction hash, type, and
  wallet ID; 389 also include transaction fee.
- Production Telegram has an enabled Ethereum/Polymarket delegated
  authorization. Existing intents include working buy/sell histories; there
  are no redeem intent rows.
- Production has no funding runtime-policy key and no Relay environment key.
  Relay is therefore not configured or active.
- Privy policy IDs configured in production match the Dashboard BUY, SELL, and
  BUY+SELL policies. A delegated redeem policy ID is absent.

## Privy Dashboard evidence

Dashboard app: `cmlqtinem00da0clar38oe5wx`, inspected 2026-07-23.

- Three EVM policies exist and their configured production IDs match:

  | Policy   | Privy policy ID            | Dashboard rule groups                                                             |
  | -------- | -------------------------- | --------------------------------------------------------------------------------- |
  | BUY      | `c32pajqwgiu8fjxmgkav0oxx` | CLOB auth, Direct BUY, Deposit Wallet BUY, Funding Router v2                      |
  | SELL     | `l8soyqbvci6ope8lkq5fy2mj` | Deposit Wallet SELL, CLOB auth                                                    |
  | BUY+SELL | `a1wdu3z0sx25ulei75ennc3p` | Funding Router v2, CLOB auth, Deposit Wallet SELL, Deposit Wallet BUY, Direct BUY |

- All EIP-712 order domains constrain Polygon chain ID 137.
- Deposit-wallet rules constrain the known Polymarket exchange contracts.
- Deposit-wallet BUY constrains side 0, signature type 3, builder, and raw maker
  amount at or below 25,000,000.
- Direct BUY constrains side 0, signature type 2, and the same raw maker cap.
- Deposit-wallet SELL constrains side 1, signature type 3, and builder; it has
  no amount cap because the action reduces an owned position.
- Funding Router v2 constrains Polygon, exact router, zero native value,
  `fund(expectedNonce,totalAmount,pUsdAmount)`, and total amount at or below
  50,000,000.
- CLOB auth constrains chain ID 137 and exact message content. It does not carry
  a verifying-contract condition; this is a review item for
  `WalletPolicyOwner`, not evidence that the policy is unsafe.
- Policy default is deny. Dashboard JSON is read-only and its Edit action is
  marked “Coming soon”.
- The active webhook points to the production Privy endpoint, has a masked
  signing secret, and subscribes to `wallet.funds_deposited` only.
  `wallet.funds_withdrawn` is not enabled.
- The asset watchlist includes Polygon USDC.e, native USDC and pUSD; Base USDC;
  and Solana USDC.
- The Third-party Integrations page shows the Bridge integration switch checked,
  while both Bridge API-key controls display `Add` with no stored value exposed.
  That proves neither a usable production key nor an enabled user-facing method.
- The Account Funding/Onramps page has Fiat onramps enabled. MoonPay is the only
  provider explicitly labeled `Enabled`. Stripe shows `Enable`; Meld, Coinbase,
  and Bridge show `Configure`, so none is recorded as enabled by this audit.
- The only visible Funding asset setup row is Ethereum with `0.00033 ETH`.
  Privy's Deposit address switch is off.
- Current frontend code in
  `Hunch_App/src/hooks/deposit/useDepositFundWallet.ts` invokes Privy's funding
  UI for EVM 1/56/137/8453/42161 and Solana mainnet, passing the exact destination
  wallet, amount, and native/USDC/ERC-20 asset at call time. This pins Hunch's
  invocation request, but the Dashboard-proven onramp configuration is only the
  Ethereum/ETH/MoonPay row above. Other invocation shapes must fail cleanly or
  use an independently proven funding method; they are not configuration proof.

Consequence: incoming deposit delivery is proven by 910 stored events. Outgoing
withdrawal/funding settlement cannot rely on a Privy funds-withdrawn webhook
today; it must use executor transaction/receipt/on-chain observation, or a later
separately approved webhook configuration change.

## Frozen canonical identities and contracts

| Canonical ID          | Network               | Exact identifier                               | Initial role                                         |
| --------------------- | --------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `polygon-usdce`       | EVM 137               | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`   | source/intermediate; PM router input                 |
| `polygon-usdc-native` | EVM 137               | `0x3c499c542cef5e3811e1192ce70d8cc03d5c3359`   | supported wallet asset, not PM settlement collateral |
| `polygon-pusd`        | EVM 137               | `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`   | Polymarket settlement collateral                     |
| `base-usdc`           | EVM 8453              | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`   | Limitless settlement collateral                      |
| `solana-usdc`         | Hunch network 7565164 | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | supported Solana source; Kalshi exit-only collateral |

Identity is `(networkId, exact asset identifier, decimals)`, never symbol. The
initial settlement destinations are Polymarket pUSD on Polygon and Limitless
USDC on Base. Kalshi/DFlow provides no new-exposure destination.

Location capabilities are exact-pattern properties: `observe`, `value`,
`execution_source`, `venue_settlement`, `intermediate`, and
`withdrawal_source`. An owned/view-only wallet may be observable and valuable
without being executable. Arbitrary withdrawal recipients are validated opaque
recipients, not owned value locations.

Trading Wallet precedence is frozen as: position owner for Sell/Redeem,
explicit valid current-intent choice, internal Hunch wallet, then other
setup-capable alternatives. Readiness is one of `internal_managed`,
`external_ready`, `external_setup_available`, `external_source_only`, or
`external_view_only`. Preparation purpose is exactly `fund`, `buy`, `sell`,
`redeem`, or `withdraw`.

Canonical route key v1 is the ordered tuple:

```text
v1 | purpose | source-location-pattern | source-network | source-asset |
destination-option | venue-binding | amount-mode | amount-band |
provider-adapter-version | action-count | preparation-profile
```

It contains stable opaque/canonical IDs, never raw user addresses. Route
measurements cannot be shared across a changed destination binding, amount
band, adapter version, or action count.

Price policy is exact-contract and display-only: adapter source, timestamp,
confidence, and policy ID are mandatory; symbol-based $1 assumptions are
forbidden; stable impairment is explicit; Relay/Across prices are secondary
route context and never overwrite Account Value.

## Latency and economics evidence

The following are production historical proxies, not provider SLAs:

| Shape                | Fulfilled rows | `updated-created` p50 |     p90 | Median gross input/output delta\* |
| -------------------- | -------------: | --------------------: | ------: | --------------------------------: |
| Across cross-chain   |            115 |                29.7 s | 233.3 s |                           0.2486% |
| deBridge cross-chain |             15 |                27.3 s | 256.5 s |                           0.2984% |
| deBridge same-chain  |             17 |                18.5 s |  23.0 s |                           0.1837% |

`*` Same-decimal rows only. It is not a fee because source and destination may
be different assets. Across average time is heavily skewed by stale sync/outlier
updates. No route qualifies as `inline_funding` from these aggregates alone;
exact route-key rehearsals and destination-observed success rates are required.

## Official external evidence pin

Every row was retrieved 2026-07-23. Where a page does not publish a content
revision, the revision pin is the named API/doc version plus URL and retrieval
date; no unversioned schema is inferred beyond the page.

| Provider | Revision pin and source                                                                                                                                                                                                                                                                                                                                                            | Claim used by the plan                                                                                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay    | [Deposit Addresses guide](https://docs.relay.link/features/deposit-addresses), retrieved 2026-07-23                                                                                                                                                                                                                                                                                | Standard path is exact-input; open addresses are reusable and may create child request IDs; strict addresses are fixed and require `refundTo`; CEX hot-wallet sender is unsafe for auto-refund; wrong tokens may be unrecoverable; destination calldata is unsupported. |
| Relay    | [Quote API](https://docs.relay.link/references/api/get-quote), current endpoint page, retrieved 2026-07-23                                                                                                                                                                                                                                                                         | Quote is the pinned planning boundary; Hunch must normalize and validate returned actions.                                                                                                                                                                              |
| Relay    | [Intent Status API v3](https://docs.relay.link/references/api/get-intents-status-v3), v3, retrieved 2026-07-23                                                                                                                                                                                                                                                                     | Reconciliation uses provider progress but requires owned destination/refund observation for Hunch settlement.                                                                                                                                                           |
| Relay    | [Webhooks guide](https://docs.relay.link/references/api/api_guides/webhooks), retrieved 2026-07-23                                                                                                                                                                                                                                                                                 | HMAC covers timestamp plus body; delivery retries exist; status vocabulary must be mapped fail-closed.                                                                                                                                                                  |
| Privy    | [Funding overview](https://docs.privy.io/wallets/funding/overview), retrieved 2026-07-23                                                                                                                                                                                                                                                                                           | Funding method configuration and wallet destination are separate from Hunch settlement proof.                                                                                                                                                                           |
| Privy    | [Funding configuration](https://docs.privy.io/wallets/funding/configuration), retrieved 2026-07-23                                                                                                                                                                                                                                                                                 | User-visible methods are enabled on Account Funding; integration-key presence alone does not prove method enablement.                                                                                                                                                   |
| Privy    | [`wallet.funds_deposited`](https://docs.privy.io/api-reference/webhooks/wallet/funds_deposited), event revision by name, retrieved 2026-07-23                                                                                                                                                                                                                                      | Incoming asset event shape and idempotent ingestion basis.                                                                                                                                                                                                              |
| Privy    | [Webhook overview](https://docs.privy.io/api-reference/webhooks/overview), retrieved 2026-07-23                                                                                                                                                                                                                                                                                    | At-least-once Svix delivery, idempotency, retries, and endpoint-disable risk require dedupe and reconciliation.                                                                                                                                                         |
| Privy    | [Policies and controls](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls), retrieved 2026-07-23                                                                                                                                                                                                                                                            | Policy is an action constraint, not ownership, routing, or settlement evidence.                                                                                                                                                                                         |
| Across   | [Swap API](https://docs.across.to/introduction/swap-api), retrieved 2026-07-23                                                                                                                                                                                                                                                                                                     | Current new-integration API family; keep version separate from historical Suggested Fees.                                                                                                                                                                               |
| Across   | [Suggested Fees](https://docs.across.to/api-reference/suggested-fees/get), legacy label, retrieved 2026-07-23                                                                                                                                                                                                                                                                      | Officially legacy/not actively maintained; prohibit new creation through this version.                                                                                                                                                                                  |
| Across   | [Deposit Status](https://docs.across.to/api-reference/deposit/status/get) and [tracking](https://docs.across.to/introduction/tracking-deposits), retrieved 2026-07-23                                                                                                                                                                                                              | Legacy rows remain reconcilable by their versioned identifiers.                                                                                                                                                                                                         |
| deBridge | [DLN create transaction](https://docs.debridge.com/api-reference/dln/this-endpoint-returns-the-data-for-a-transaction-to-place-a-cross-chain-dln-order), retrieved 2026-07-23                                                                                                                                                                                                      | Cross-chain creation shape is distinct from same-chain data.                                                                                                                                                                                                            |
| deBridge | [Order endpoint](https://docs.debridge.com/api-reference/dln/this-endpoint-returns-the-data-of-order), [tracking](https://docs.debridge.com/dln-details/integration-guidelines/order-creation/order-tracking-api/tracking-orders), and [states](https://docs.debridge.com/dln-details/integration-guidelines/order-creation/order-tracking-api/order-states), retrieved 2026-07-23 | States include Created, Fulfilled, SentUnlock, ClaimedUnlock, and cancellation families; map versioned/fail-closed.                                                                                                                                                     |
| Bungee   | [Manual integration](https://docs.bungee.exchange/bungee-api/integration-guides/manual-integration) and [Quote v1](https://docs.bungee.exchange/bungee-api/api-reference/bungee-controller-quote-v-1), v1 pages retrieved 2026-07-23                                                                                                                                               | Preserve status-by-hash compatibility only; zero production rows means no creation adapter is justified.                                                                                                                                                                |

## Requirements-to-evidence ownership

| Requirement                            | Fixture/test evidence                                                                         | Command or inspection owner                   |
| -------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| No value double count                  | projector property tests: source → in-transit → destination/refund                            | `FundingPlatformOwner`, backend test command  |
| Quote/commit ownership and idempotency | cross-user, replay, hash mismatch and stale projection tests                                  | `FundingPlatformOwner`, API integration suite |
| Relay exact actions/status             | sanitized Quote/Status/Webhook/Deposit Address fixtures plus negative mutations               | `FundingPlatformOwner`, guarded harness       |
| Privy action limits                    | policy JSON snapshot, validator fixtures, Dashboard read-only check                           | `WalletPolicyOwner`                           |
| PM/Limitless readiness                 | internal/external/Safe/deposit-wallet matrices and tiny-value visibility rehearsal            | `VenueIntegrationOwner`                       |
| Solana sponsorship                     | fee payer, transfer, ATA/rent, close destination and cap mutation tests                       | `WalletPolicyOwner`                           |
| Telegram parity                        | buy/sell/redeem/funding/recovery contract tests; redeem stays unavailable until policy exists | `TelegramTradingOwner`                        |
| Legacy convergence                     | classifier zero-unknown query; per-adapter terminal replay and age report                     | `FinanceOperationsOwner`                      |
| Merge/delete/retention                 | DB FK, merge conflict, deletion hold, crypto-shred, market-protected-reference tests          | `DataLifecycleOwner`                          |
| Shared UI state                        | desktop/mobile journey suite over one controller; clone baseline comparison                   | `FundingUIOwner`                              |

## Audit conclusions

1. The plan's architecture is materially correct and better grounded after
   WP0A, especially its separation of ownership value, spendability, routing,
   and venue binding.
2. Relay must remain off until fixtures and exact live rehearsals exist; no
   Relay configuration was found in production.
3. Legacy reconciliation is a hard migration dependency because 106 records are
   non-terminal and 104 are older than 30 days.
4. Privy BUY/SELL/funding controls are concrete and restrictive, but delegated
   redeem is not configured and outgoing webhook observation is absent.
5. Privy Account Funding is currently narrow: MoonPay fiat onramp to the
   configured Ethereum/ETH setup. It is not evidence for stablecoin settlement,
   cross-chain ingress, or Privy Deposit Address support.
6. The current web funding UI has enough exact duplication that a shared
   controller is a prerequisite, not optional cleanup.
7. WP1 implementation may begin only after the executable harness/fixture gap is
   accepted as an explicit remaining WP0 item or completed. Production route
   activation must wait for the full WP0 gate.
