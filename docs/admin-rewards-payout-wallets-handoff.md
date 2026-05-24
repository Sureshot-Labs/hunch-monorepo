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

## Compatibility

No API route or response wrapper changed. The fields were added under existing
chain objects in `rewardsHotWallets`, so older clients can ignore them.
