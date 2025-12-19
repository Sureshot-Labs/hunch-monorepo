# @hunch/contracts (Polymarket Fee Collector v2)

Fee collector contracts + demos for Polymarket on Polygon. v2 supports per-order fee bps, exchange allowlist, and EIP-1271 contract signers.

## Layout

- `src/PolymarketFeeCollector.sol` — v2 fee collector (per-order `feeBps`, exchange allowlist, EIP-1271).
- `src/PolymarketInterfaces.sol` — minimal CTF Exchange interface.
- `src/mocks/*` — Hardhat mocks used in tests.
- `scripts/deploy.ts` — deployer (Polygon mainnet).
- `scripts/export-abis.ts` — exports minimal ABI JSONs to `src/abis`.
- `demo/` — local HTML demos (unchanged, for manual testing).

## Default Polygon addresses

- Exchange: `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Neg-risk exchange: `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- USDC: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`

## Build & test

```bash
pnpm -C packages/contracts compile
pnpm -C packages/contracts test
pnpm -C packages/contracts typechain
pnpm -C packages/contracts abi:export
```

## Deploy (Hardhat)

Set:

```
POLYGON_RPC_URL=...
POLYGON_DEPLOYER_KEY=...
```

Then:

```bash
pnpm -C packages/contracts deploy -- --network polygon \
  --treasury 0xYourTreasury \
  --collateral 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
  --exchange 0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E \
  --negRiskExchange 0xC5d563A36AE78145C45a50134d48A1215220f80a
```

You can also pass an explicit allowlist:

```bash
pnpm -C packages/contracts deploy -- --network polygon \
  --treasury 0xYourTreasury \
  --collateral 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
  --exchanges 0x4bFb...,0xC5d5...
```

## v2 fee flow (high level)

```
User signs Polymarket Order (EIP-712, CTF Exchange domain)
User signs FeeAuth (EIP-712, FeeCollector domain: exchange, orderHash, feeBps, nonce, deadline)
Vault/Safe approves FeeCollector for USDC
Order fills on-chain
Backend calls collectFee(order, feeAuth, feeAuthSig)
Collector:
  orderHash = EXCHANGE(hash).hashOrder(order)
  makerFilled from getOrderStatus(orderHash)
  delta = makerFilled - makerFilledCharged[orderHash]
  collateralDelta = BUY: delta; SELL: delta * takerAmount / makerAmount
  fee = collateralDelta * feeBps / 10_000
  transferFrom(order.maker -> treasury, fee)
```

Notes:
- Use a single collector with an exchange allowlist (standard + neg-risk).
- FeeAuth signatures support EOA and EIP-1271 contract signers.
