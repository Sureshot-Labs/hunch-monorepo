# Admin Rewards Payout Wallets Handoff

This document describes the rewards payout wallet diagnostics exposed for the
separate admin frontend.

## Endpoint

`GET /admin/overview`

Permission follows the existing admin overview route.

The response includes `rewardsHotWallets` with chain entries for:

- `polygon`
- `base`
- `solana`

Each chain entry includes the existing hot-wallet, treasury math, configured
cold wallet, and cold-wallet balance diagnostics.

## Cold Wallet Fields

Cold-wallet fields are nullable and read-only:

- `coldAddress`: configured cold wallet address.
- `coldNativeBalance`: formatted native gas token balance.
- `coldNativeBalanceRaw`: raw native gas token balance.
- `coldUsdcBalance`: formatted configured payout token balance.
- `coldUsdcBalanceRaw`: raw configured payout token balance.
- `coldError`: RPC or balance-fetch error for cold diagnostics only.

Polygon also includes:

- `coldUsdceBalance`: formatted `USDC.e` diagnostic balance.
- `coldUsdceBalanceRaw`: raw `USDC.e` diagnostic balance.

Use the existing chain labels to display assets:

- `nativeAsset`: `POL`, `ETH`, or `SOL`.
- `payoutAsset`: `pUSD` or `USDC`.

## Display Guidance

Show cold balances near the existing cold wallet address in the payout wallet
card.

Recommended labels:

- `Cold {nativeAsset} balance`
- `Cold {payoutAsset} balance`
- `Cold USDC.e balance` for Polygon only

If `coldError` is set, show it as a diagnostic warning but keep the rest of the
card visible.

Do not derive these fields from cold balances:

- `Claimable now`
- `Excess`
- `Reserve deficit`
- reward liabilities
- fee reserve fields

Those values continue to come from treasury math based on the controlled hot
wallet and reward liabilities. Cold balances are informational only.

## Treasury Runs And Builder Sweeps

These endpoints expose read-only operational wallet movement diagnostics. They
require `finance:read`.

### Treasury Runs

`GET /admin/fees/ledger/treasury-runs`

Returns paginated rows from `reward_treasury_runs`. Use this to inspect
hot-to-cold sweep planning/execution, reserve math snapshots, per-chain actions,
and the embedded Polymarket builder sweep result for a run.

Supported filters:

- `q`
- `status`
- `chainId`
- `txHash`
- `from`
- `to`
- `limit`
- `offset`

Important row fields:

- `id`
- `mode`: `dry_run` or `execute`.
- `status`: `completed`, `partial`, `failed`, or `skipped`.
- `liabilityMode`: currently `event_time_frozen`.
- `report`: treasury report snapshot.
- `actions`: per-chain sweep actions from the run payload.
- `polymarketBuilderSweep`: embedded builder-to-hot sweep result when present.
- `error`
- `startedAt`
- `finishedAt`

`GET /admin/fees/ledger/treasury-runs/:id`

Returns a single treasury run row, or `404` when not found.

### Builder Sweeps

`GET /admin/fees/ledger/builder-sweeps`

Returns paginated rows from `polymarket_builder_sweeps`. Use this to inspect
`pUSD` movement from the Polymarket builder/deposit wallet into the rewards hot
wallet.

Supported filters:

- `q`
- `status`
- `chainId`
- `txHash`
- `builderAddress`
- `destinationAddress`
- `relayerTransactionId`
- `from`
- `to`
- `limit`
- `offset`

Important row fields:

- `id`
- `state`: `preparing`, `submitted`, `broadcast`, `confirmed`, `failed`, or
  `skipped`.
- `amount`
- `amountRaw`
- `tokenSymbol`
- `builderAddress`: source builder/deposit wallet.
- `ownerAddress`: owner that signed the relayer batch.
- `destinationAddress`: rewards hot wallet.
- `tokenAddress`
- `preBuilderBalance` / `preBuilderBalanceRaw`
- `postBuilderBalance` / `postBuilderBalanceRaw`
- `preHotBalance` / `preHotBalanceRaw`
- `postHotBalance` / `postHotBalanceRaw`
- `relayerTransactionId`
- `relayerState`
- `txHash`
- `error`
- `submittedAt`
- `broadcastAt`
- `confirmedAt`
- `failedAt`

`GET /admin/fees/ledger/builder-sweeps/:id`

Returns a single builder sweep row, or `404` when not found.

## Compatibility

No API route or response wrapper changed. The fields were added under existing
chain objects in `rewardsHotWallets`, so older clients can ignore them.

The treasury-run and builder-sweep endpoints are additive. Existing payout
wallet fields, finance ledger endpoints, and overview payloads are unchanged.
External admin clients can ignore these endpoints until they want to display
sweep diagnostics.
