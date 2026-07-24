# Live Rehearsal Harness contract

Owner: `FinanceOperationsOwner`  
Security co-owner: `WalletPolicyOwner`  
Implementation owner: `FundingPlatformOwner`

Status: **executable for the bounded Relay wallet subset; six live wallet
routes completed. Other catalog scenarios remain off and unimplemented.**

The commands are:

```bash
pnpm -F api run relay:rehearsal -- --scenario <id> --amount-raw <n> \
  --minimum-output-raw <n> --max-gas-raw <n>
pnpm -F api run relay:solana:rehearsal -- --amount-raw <n> \
  --minimum-output-raw <n> --max-fee-lamports <n>
```

Both default to preflight. Live mode additionally requires `--live` and the
exact confirmation string printed by a fresh preflight. Implementations live in
`apps/api/src/relay-live-rehearsal.ts` and
`apps/api/src/relay-solana-live-rehearsal.ts`; pure action validators and
negative tests are under `apps/api/src/funding-providers/relay/`.

## Completed bounded evidence

| Route                      | Input     | Actual output            | Broadcasts | Observed wall-clock evidence                       |
| -------------------------- | --------- | ------------------------ | ---------: | -------------------------------------------------- |
| Polygon POL → Base ETH     | 1 POL     | 0.000030180139399958 ETH |          1 | source/destination block delta 1.0 s               |
| Polygon pUSD → Base USDC   | 1 pUSD    | 0.969156 USDC            |          2 | deposit block→destination 2.0 s; runner 12.878 s   |
| Base USDC → Polygon pUSD   | 0.5 USDC  | 0.451150 pUSD            |          2 | broadcast→destination 10.106 s; runner 18.701 s    |
| Polygon POL → Solana SOL   | 2 POL     | 0.001514964 SOL          |          1 | broadcast→balance 4.772 s; runner 6.812 s          |
| Polygon pUSD → Solana USDC | 0.5 pUSD  | 0.284047 USDC            |          2 | deposit broadcast→balance 4.623 s; runner 13.593 s |
| Solana USDC → Polygon pUSD | 0.25 USDC | 0.201796 pUSD            |          1 | broadcast→destination block 5.034 s; route 8.180 s |

All outputs exceeded the caller-authorized floors. All eight EVM receipts and
the one Solana transaction succeeded; the Solana transaction finalized with a
5,000-lamport fee. Exact remaining ERC-20 allowances are zero. Raw local reports
remain gitignored and mode `0600`; checked-in evidence contains fingerprints
only.

The Solana run also pinned two operational constraints:

- instruction data is hex without `0x`, matching Relay's official SVM adapter;
- Alchemy HTTP RPC finalized the transaction, but its derived WebSocket endpoint
  did not support `signatureSubscribe`. The runner therefore uses HTTP
  `getSignatureStatuses` polling and never blindly resubmits after broadcast.

## Required runner behavior

The runner must remain a separate explicit command, never imported by API,
workers, deploy scripts, migrations, startup, or CI. Default mode is read-only
preflight. Live mode requires all of:

1. an explicit scenario ID;
2. `--live`;
3. an exact `--amount-raw` in the source asset, treated as the hard maximum
   spend for that invocation;
4. a fresh confirmation containing scenario, source/destination labels,
   maximum spend, expected minimum output, fee bound, and signer mode;
5. a dedicated rehearsal account/wallet and environment;
6. a redacted output path under a local ignored directory;
7. a policy/config revision hash and clean preflight repeated immediately
   before the first mutation.

The runner reads secret values only from the process environment or approved
secret store. It may record whether a required key is present, never its value,
ID material that grants authority, authorization header, signature, raw
calldata containing user identifiers, or complete wallet addresses.

## Universal preflight

Every scenario must report and stop on failure for:

- environment identity and chain/genesis identity;
- exact canonical source/destination asset IDs and decimals;
- source ownership and signer/controller mode;
- destination binding ownership/readiness;
- native gas/rent and sponsorship policy;
- route/provider adapter version and quote expiry;
- normalized action allowlist validation;
- exact input/max input, minimum output, all fees, and spend cap;
- refund ownership and observation path;
- idempotency key and operation correlation;
- DB/provider/webhook/polling observation availability;
- no production fixture/mock adapter registration;
- an abort plan before and after possible broadcast.

## Scenario catalog

| Scenario ID                         | Tiny-value path                                               | Read-only proof required first                                                      | Live success evidence                                                               | Owner                    |
| ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `relay-wallet-solana-usdc-to-pm`    | controlled Solana USDC → Relay → PM settlement                | exact Quote fixture, Solana action validation, PM binding/readiness, refund path    | source debit, provider request, destination pUSD/ready observation, no double count | `FundingPlatformOwner`   |
| `relay-wallet-evm-stable-to-pm`     | controlled EVM supported stable → Relay → PM                  | exact asset/chain mapping, allowance/action validation, net min output              | receipt plus PM settlement visibility and final operation state                     | `FundingPlatformOwner`   |
| `relay-strict-deposit-address`      | controlled wallet exact amount → strict Relay address         | strict mode, fixed amount, Hunch-controlled `refundTo`, child request polling       | request/deposit/child correlation and destination or refund observation             | `FinanceOperationsOwner` |
| `pm-settlement-visibility`          | existing PM wallet funding action                             | owner/deposit-wallet/Safe binding and Funding Router policy match                   | exact pUSD delta, readiness transition, no market order                             | `VenueIntegrationOwner`  |
| `limitless-settlement-visibility`   | existing Limitless funding path                               | Base USDC asset, account binding, auth/readiness                                    | exact cash visibility and operation completion                                      | `VenueIntegrationOwner`  |
| `limitless-internal-clob-ready`     | internal wallet connection plus tiny CLOB preparation         | prepared Privy auth, exact profile, exchange/adapter, approvals, locks, quote guard | exact profile and CLOB readiness; no order submission                               | `VenueIntegrationOwner`  |
| `limitless-internal-amm-ready`      | internal wallet connection plus tiny AMM preparation          | prepared Privy auth, canonical AMM/spender/outcome, approvals, bounded quote        | exact AMM readiness and allowance postconditions; no order submission               | `VenueIntegrationOwner`  |
| `limitless-external-connect`        | explicit external client wallet Limitless connection          | fresh signing message, selected-wallet signature, exact-account profile binding     | verified external profile; no managed/delegated promotion                           | `VenueIntegrationOwner`  |
| `privy-sponsored-pm-buy`            | delegated tiny BUY under cap                                  | Dashboard policy ID/hash, exact EIP-712 domain/message/action, sponsorship decision | tx/order correlation and resulting execution state                                  | `WalletPolicyOwner`      |
| `privy-sponsored-pm-sell`           | tiny owner-bound SELL                                         | position owner binding, exact SELL policy, no wallet substitution                   | accepted owner-bound sell and position/order observation                            | `WalletPolicyOwner`      |
| `pm-owner-bound-redeem`             | redeem a tiny resolved PM position                            | owner binding, redemption plan validator, explicit signing path                     | chain receipt and collateral observation                                            | `VenueIntegrationOwner`  |
| `limitless-owner-bound-redeem`      | redeem tiny standard and neg-risk Limitless positions         | owner binding, canonical CTF/adapter plan, required approval, exact signer path     | Base receipt, position/collateral refresh, marker-failure recovery without resubmit | `VenueIntegrationOwner`  |
| `external-wallet-pm-setup`          | explicit external signer sets up supported PM binding         | signer connected, Safe threshold, deposit-wallet registration and approvals         | readiness becomes `external_ready`; no silent transfer                              | `VenueIntegrationOwner`  |
| `withdrawal-controlled-destination` | exact small withdrawal to prevalidated owned test destination | opaque recipient ownership/expiry, action/fee/refund checks                         | source debit and destination observation; funds-withdrawn webhook not assumed       | `FundingPlatformOwner`   |
| `reconcile-after-ambiguous-timeout` | induce timeout after possible submission in controlled test   | deterministic fault point and idempotency                                           | `reconcile_required` converges without duplicate broadcast                          | `FinanceOperationsOwner` |

Privy delegated redeem is excluded from the live catalog because production has
no redeem policy ID. It remains unavailable until a policy is designed,
reviewed, created with separate approval, and validated.

## Relay Deposit Address hard gates

- Strict/exact mode only for initial activation.
- Sender must be a controlled wallet; no exchange/CEX sender.
- `refundTo` must be owned and observable by Hunch.
- Query by deposit address with child requests; do not assume transaction-hash
  lookup recovers the parent request.
- Reject unsupported/wrong token and any destination calldata composition.
- Open/variable addresses and Privy-to-Relay composition remain off.

## Redacted report schema

```json
{
  "schemaVersion": 1,
  "scenarioId": "relay-strict-deposit-address",
  "mode": "preflight",
  "startedAt": "2026-07-23T00:00:00Z",
  "sourceAssetId": "solana-usdc",
  "destinationOptionIdHash": "sha256:56d6e1f9",
  "adapterVersion": "relay-deposit-address-v1",
  "maxSpendRaw": "1000000",
  "policyRevisionHash": "sha256:8f3f0d50",
  "checksPassed": 14,
  "checksFailed": 0,
  "broadcastAttempted": false,
  "terminalResult": "preflight_only"
}
```

Hash examples are synthetic and grant no authority. Live reports use truncated
HMAC fingerprints generated by the runner, not raw addresses or request IDs.

## Completion gate

The Relay wallet subset has passed the executable gate: repository commands
implement default preflight, exact live confirmation, budget/output/fee checks,
EVM and Solana action validation, simulation, redacted reports, and
destination reconciliation. Each remaining catalog scenario must independently
meet the same gate and obtain spend authorization before activation. The
completed wallet routes do not authorize Deposit Address, venue, Privy,
withdrawal, redemption, or fault-injection live actions.
