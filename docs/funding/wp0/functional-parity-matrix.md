# Functional Parity Matrix

Owner: `FundingUIOwner`  
Backend co-owner: `FundingPlatformOwner`  
Venue co-owner: `VenueIntegrationOwner`

Rollout states used here: `legacy-live`, `shadow-only`, `off`, and
`exit-only`. No row is marked replaced without evidence.

| Current working journey                     | Current implementation                                   | New path/evidence                                                    | Current rollout state         | Legacy removal condition                                                                           |
| ------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| See Header/Wallet balances                  | frontend-local wallet/venue sums                         | backend Account Value, component dedupe/freshness, shadow comparison | `legacy-live`                 | All surfaces consume one projection; double-count/stale/unpriced tests and shadow thresholds pass. |
| View positions/portfolio                    | venue/frontend totals                                    | separate backend position components and portfolio projection        | `legacy-live`                 | PM/Limitless uniqueness, locks-vs-positions, partial/stale tests pass.                             |
| Add funds to Polymarket internal wallet     | Deposit/bridge/PM funding branches                       | opaque PM destination + source quote + operation + readiness         | `legacy-live`                 | Exact internal/deposit-wallet/Safe rehearsals and recovery/UI parity pass.                         |
| Add funds to Limitless                      | Deposit/bridge/Limitless branches                        | opaque Limitless binding/destination and operation                   | `legacy-live`                 | Base USDC settlement visibility, auth/readiness and recovery pass.                                 |
| Deposit through Privy                       | Privy funding UI + `funds_deposited` webhook             | direct external handoff to frozen owned destination + observation    | `legacy-live`                 | Configured methods/destinations fixture and webhook replay/dedupe/terminal observation pass.       |
| Bridge/convert supported wallet asset       | desktop/mobile bridge orchestration                      | selected opaque source → quote → normalized action → operation       | `legacy-live`                 | Per route-key fixture plus tiny-value evidence; no provider DTO/UI choice; shared controller live. |
| Strict receive from controlled wallet       | no Relay path                                            | gated strict Relay Deposit Address operation                         | `off`                         | Harness executable; refund/child/wrong-token tests and tiny-value destination/refund run pass.     |
| Exchange/manual stablecoin deposit          | receive instructions/Privy event handling                | direct owned Receive; exact asset/network; observation               | `legacy-live`                 | CEX refund hazard excluded; exact instructions and correlation/recovery pass.                      |
| Polymarket BUY                              | existing trade execution and Privy policies              | same executor behind intent liquidity/readiness and fresh quote      | `legacy-live`                 | Available-now only enables Buy; internal/external binding and delegated policy tests pass.         |
| Polymarket SELL                             | existing owner wallet execution                          | owner-bound position action capability                               | `legacy-live`                 | No wallet substitution; direct/deposit-wallet/Safe and delegated policy evidence pass.             |
| Polymarket Redeem                           | current redemption planner/executor                      | owner-bound `PositionActionExecutor`, not Funding Operation          | `legacy-live`                 | Owner proof, validator, receipt/collateral and web recovery pass.                                  |
| Limitless BUY/SELL                          | existing CLOB/AMM trade hooks/services                   | Limitless readiness and trading capability                           | `legacy-live`                 | CLOB/AMM fixture matrix, locks, auth and owner binding pass.                                       |
| Limitless Redeem                            | current redemption path                                  | owner-bound Limitless position action                                | `legacy-live`                 | Resolved-position, receipt and collateral visibility evidence pass.                                |
| Kalshi/DFlow close/redeem existing exposure | maintenance lifecycle paths                              | unchanged exit capability; no new funding destination                | `exit-only`                   | Removal is a separate venue lifecycle decision; funding project must preserve exit.                |
| Telegram PM BUY/SELL                        | delegated auth + intents + reconcile                     | shared liquidity/readiness/operation/activity contracts              | `legacy-live`                 | Web/Telegram status equivalence, replay/recovery, limits and policy tests pass.                    |
| Telegram Redeem                             | schema supports action; no production policy/run history | explicit unavailable reason and web handoff                          | `off`                         | Separate delegated redeem policy and owner-bound live evidence; otherwise remains off.             |
| Withdraw from supported internal location   | current Withdraw flows/venue services                    | opaque validated recipient + exact operation and observation         | `legacy-live`                 | Registration/expiry/IDOR, ambiguous broadcast, destination observation and recovery pass.          |
| External wallet funds internal Hunch wallet | signed source path where supported                       | `external_source_only` option and explicit action                    | `legacy-live` where supported | No silent pull; signer/action and receipt/settlement rehearsal passes.                             |
| Select/setup external Trading Wallet        | fragmented linked wallet/Safe setup                      | explicit current-intent binding and purpose-aware preparation        | `legacy-live` where supported | Setup/readiness matrix passes; no balance-based selection or remembered preference.                |
| Resume/recover pending movement             | bridge order sync/activity and notifications             | durable operation Activity from web/Telegram                         | `legacy-live`                 | Restart/timeout/webhook-loss simulations converge and deep links restore exact operation.          |
| Admin inspect user finance state            | current user/wallet/fee/reward panels                    | typed funding operation/policy views                                 | `legacy-live`                 | Permissions, redaction, audit and no-mutation view tests pass.                                     |

## Product decisions frozen by parity

- Polymarket is a recommendation only when several valid no-context
  destinations exist; it never commits itself.
- Internal Hunch Trading Wallet is primary. External setup is secondary and
  appears only after explicit interest.
- Add Funds moves the full confirmed receipt. Trade Shortfall moves only the
  shortfall plus a disclosed bounded buffer.
- Route speed is `prepare_first` until exact route-key evidence proves inline
  safety. Provider success/modal completion is not settlement.
- Relay is first for proposed new routes. Across/deBridge remain legacy
  reconciliation or explicitly disabled fallback tests; Bungee has no creator.
