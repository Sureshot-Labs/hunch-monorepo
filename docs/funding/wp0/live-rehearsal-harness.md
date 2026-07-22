# Live Rehearsal Harness contract

Owner: `FinanceOperationsOwner`  
Security co-owner: `WalletPolicyOwner`  
Implementation owner: `FundingPlatformOwner`

Status: **manual runbook and safety contract captured; executable runner and
live runs are not present.** Read-only WP0A did not create requests, sign,
broadcast, spend, or alter secrets/configuration. This is the remaining WP0
implementation item, not evidence of route readiness.

## Required runner behavior

The future runner must be a separate explicit command, never imported by API,
workers, deploy scripts, migrations, startup, or CI. Default mode is read-only
preflight. Live mode requires all of:

1. an explicit scenario ID;
2. `--live`;
3. an exact `--max-spend-raw` in the source asset;
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
| `privy-sponsored-pm-buy`            | delegated tiny BUY under cap                                  | Dashboard policy ID/hash, exact EIP-712 domain/message/action, sponsorship decision | tx/order correlation and resulting execution state                                  | `WalletPolicyOwner`      |
| `privy-sponsored-pm-sell`           | tiny owner-bound SELL                                         | position owner binding, exact SELL policy, no wallet substitution                   | accepted owner-bound sell and position/order observation                            | `WalletPolicyOwner`      |
| `pm-owner-bound-redeem`             | redeem a tiny resolved PM position                            | owner binding, redemption plan validator, explicit signing path                     | chain receipt and collateral observation                                            | `VenueIntegrationOwner`  |
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

This artifact becomes `executable` only when a repository command implements
the contract, its source is reviewed, default preflight is proven, secret-log
negative tests pass, and a redacted dry-run report is checked in or attached.
Each live scenario still needs separate spend authorization; WP0A authorization
does not authorize it.
