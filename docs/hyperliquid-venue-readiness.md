# Hyperliquid Read-Only Indexer Readiness

## Current Status

The Hyperliquid indexer is ready for local and controlled canary testing as a
read-only market metadata and top-of-book writer. It is not ready to be exposed
as a first-class venue in the product UI or trading flows.

The indexer currently writes:

- raw HIP metadata: `hyperliquid_questions`, `hyperliquid_outcomes`,
  `hyperliquid_outcome_assets`
- unified discovery rows: `unified_events`, `unified_markets`,
  `unified_tokens`, `unified_market_tokens`
- top-of-book time series: `unified_book_top`
- Redis live keys/channels: `top:hyperliquid:*`, `book:hyperliquid:*`,
  `prices:hyperliquid:*`

The indexer does not currently write comparable liquidity, open interest,
cumulative volume, trades, positions, orders, or venue credentials.

## Important Side Effects If Enabled

Enabling only the service with `HYPERLIQUID_ENABLED=true` and leaving
`HYPERLIQUID_WRITE_DB=false` has no DB write side effects.

Enabling DB writes with `HYPERLIQUID_WRITE_DB=true` creates public unified rows.
That has these effects:

- Generic DB readers can see Hyperliquid events and markets by ID.
- Feed/discovery-style reads that do not apply a venue allowlist can rank
  Hyperliquid rows because the markets have `volume_24h` and `last_price`.
- Query params that use the shared `zVenue` schema still reject `hyperliquid`,
  so clients cannot reliably filter to or from Hyperliquid through those APIs.
- Market-map routes do not include Hyperliquid by default because the market-map
  policy default is still `polymarket,kalshi,limitless`.
- Market-map sidebars exclude Hyperliquid liquidity movers because liquidity is
  intentionally not comparable yet.
- Market-map volume movers will not be useful for Hyperliquid until we have a
  cumulative `volume_total`; the current HIP source exposes rolling day notional,
  which we map to `volume_24h`.
- Price movement and SSE can work from `unified_book_top`/Redis once clients
  subscribe to Hyperliquid token IDs.
- Candlestick APIs currently return "unsupported venue" for Hyperliquid even
  though `unified_book_top` has enough data for a future internal implementation.
- Wallet intel currently excludes Hyperliquid through hardcoded venue filters.
- Trading, positions, orders, fees, rewards, deposits, and portfolio venue
  balances do not support Hyperliquid.

Practical implication: if the prod goal is indexer-only validation, keep
`HYPERLIQUID_WRITE_DB=false` or add a temporary public-read gate before enabling
writes. If DB writes are enabled without API/frontend work, Hyperliquid may leak
into generic feed surfaces with incomplete icons, links, charts, and actions.

## Hardcoded Venue Touchpoints

Backend venue schemas and types:

- `apps/api/src/schemas/common.ts`: `zVenue` is limited to
  `polymarket`, `kalshi`, `limitless`.
- `apps/api/src/order-types.ts`: order and position venue types are limited to
  the same three venues.
- `apps/api/src/auth.ts`: user venue credentials types are limited to the same
  three venues.
- `apps/api/src/routes/positions.ts`: request handling and credential filtering
  use an explicit three-venue allowlist.
- `apps/api/src/schemas/fees.ts` and `apps/api/src/schemas/admin.ts`: fee policy
  venues are intentionally limited to `polymarket` and `kalshi`.

Backend DB constraints:

- `packages/db/migrations/0003_auth_user_management.sql`
- `packages/db/migrations/0004_multi_venue_support.sql`
- `packages/db/migrations/0006_order_management.sql`
- `packages/db/migrations/0015_recreate_orders_table.sql`
- `packages/db/migrations/0029_add_executions.sql`
- `packages/db/migrations/0042_admin_fee_policy.sql`

These constraints affect auth, orders, executions, and fee policy tables. They
do not block the Hyperliquid read-only indexer because it writes raw HIP tables
and unified market/event/token tables.

Backend discovery and market map:

- `apps/api/src/env.ts`: `AI_MARKET_MAP_VENUES_ENABLED` defaults to
  `polymarket,kalshi,limitless`.
- `apps/api/src/services/runtime-policies.ts`: market-map default policy and
  wallet attribution defaults use the same venue set.
- `apps/api/src/services/market-map.ts`: default market-map venues exclude
  Hyperliquid, although venue normalization itself accepts generic lowercase
  venue IDs.
- `apps/api/src/routes/market-map.ts`: comparable liquidity movers are limited
  to venues in `MARKET_MAP_COMPARABLE_LIQUIDITY_VENUES`, currently
  `polymarket`.
- `apps/api/src/lib/hot-tokens.ts`: Hyperliquid is already included for hot
  token tracking.

Backend wallet/intel:

- `apps/api/src/wallet-intel-refresh.ts`: market selection filters venues to
  `polymarket`, `limitless`, `kalshi`.
- `apps/api/src/wallet-intel-experiments.ts`: CLI venue parsing is limited to
  the same three.
- `apps/api/src/services/wallet-attribution.ts` and
  `apps/api/src/services/runtime-policies.ts`: attribution venue keys and fixed
  venue order are limited to the same three.

Backend embeddings and AI map:

- Polymarket, DFlow/Kalshi, and Limitless indexers enqueue embedding items.
- The Hyperliquid indexer does not yet enqueue event or market embeddings.
- Market-map build needs event embeddings, so adding Hyperliquid to the
  market-map venue policy also requires embed backfill or enqueue support.

Frontend venue types and display:

- `Hunch_App/src/lib/api/types.ts`: `Venue` excludes Hyperliquid.
- `Hunch_App/src/lib/api/openapi.ts`: generated API types currently expose the
  old venue union in many response shapes.
- `Hunch_App/src/app/discovery/page.client.tsx` and
  `Hunch_App/src/features/market-map/useMarketMapNavigation.ts`: known venue
  sort order excludes Hyperliquid.
- `Hunch_App/src/components/Markets/MarketsTable/MarketsTableVenue.tsx` and
  `MarketsTableHeaderVenue.tsx`: icons/filter options exclude Hyperliquid.
- Tracking, portfolio, events, arbitrage, and OpenGraph venue icon helpers have
  the same three-venue switch behavior.
- `Hunch_App/src/utils/markets/venueMarketUrl.ts`: no Hyperliquid external URL
  builder exists.
- `Hunch_App/src/hooks/markets/useCandlesticks.ts`: the frontend candlestick
  support guard excludes Hyperliquid.
- `Hunch_App/src/hooks/trade/venueTradeAdapter.ts` and
  `useVenueTradeAdapters.ts`: trading adapters exclude Hyperliquid.
- Deposit, bridge, wallet gate, confirmation, portfolio breakdown, and auth
  wallet venue types exclude Hyperliquid.

## Deployment Recommendation

For a safe pre-product canary:

1. Deploy code with `HYPERLIQUID_ENABLED=false`.
2. Run live no-write diagnostics from the container with `--dry-run-top-books`.
3. If DB writes are desired in prod, first decide whether public API/feed
   surfaces may show Hyperliquid. If not, add a public-read gate before enabling
   writes.
4. Start with `HYPERLIQUID_SYNC_TOP_BOOKS=false` to validate metadata writes.
5. Then enable `HYPERLIQUID_SYNC_TOP_BOOKS=true` with a small
   `HYPERLIQUID_MAX_TOP_BOOK_SYNC_TOKENS` value.
6. Monitor row counts, `unified_book_top` write rate, Redis key counts, and API
   feed responses.

Before first-class product exposure:

1. Add a central venue registry or extend the existing venue helpers so
   hardcoded frontend/backend venue lists are not updated piecemeal.
2. Decide which public APIs should accept `venue=hyperliquid`.
3. Add Hyperliquid icon/label/link handling.
4. Add embed enqueue or run embed backfill before including Hyperliquid in
   market-map builds.
5. Add internal candlestick support from `unified_book_top`.
6. Keep liquidity/open-interest discovery metrics disabled unless Hyperliquid
   exposes comparable values.
7. Keep trading, positions, orders, fees, rewards, and wallet funding disabled
   until there is a separate write/trade integration.
