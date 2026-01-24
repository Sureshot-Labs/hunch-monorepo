# API Ops Notes

Short operational notes for the Fastify API and wallet intel tooling.

## Wallet intel refresh
Runs market holder scans, wallet snapshots, delta inference, and whale tagging.

```bash
pnpm -C hunch-monorepo -F api run wallets:intel:refresh
```

Key behavior:
- Scans markets from global volume, per-venue caps, watchlist, and whale-held markets.
- Backfills Limitless prices for missing `best_bid/best_ask/last_price` when possible.
- Writes wallet position snapshots + activity events.

## Kalshi mint audit
Audits Kalshi outcome mints against Solana RPC and updates `is_initialized` plus
`metadata.mint_exists*` fields.

```bash
pnpm -C hunch-monorepo -F api run kalshi:mint-audit
```

Common flags:
- `--limit=50000` total rows to check
- `--batch=500` batch size
- `--delay=50` per-mint delay (ms)
- `--retry=2` retry count on 429/AbortError
- `--backoff=250` backoff base (ms)
- `--dry-run` no writes
- `--after=<marketId>` resume cursor
- `--legacy-only` convert old audit rows (only `mint_exists`) to new `mint_exists_yes/no`
- `--include-audited` recheck everything (use until legacy rows are converted)

## Solana RPC coverage check
Spot-check Solana mint existence or holders for a sample of markets.

```bash
pnpm -C hunch-monorepo -F api exec -- tsx src/solana-rpc-check.ts \
  --venue=kalshi --status=ACTIVE --check=existence --limit=200 --sample=50
```

## Environment
Wallet intel limits and thresholds are set in `hunch-monorepo/.env`.
See `apps/api/src/env.ts` for defaults.
