# DFlow -> Unified Market Storage Notes

This document summarizes what the DFlow indexer stores in the unified DB tables and what is ignored, based on current mapping logic.

Sources:
- `hunch-monorepo/apps/indexer-dflow/src/mappers.ts`
- `hunch-monorepo/apps/indexer-dflow/src/bootstrap.ts`
- `hunch-monorepo/apps/indexer-dflow/src/types.ts`
- `hunch-monorepo/packages/db/src/unified-repo.ts`
- `hunch-monorepo/packages/db/migrations/0010_unified_tables.sql`
- `hunch-monorepo/packages/db/migrations/0015_add_open_interest_to_unified.sql`
- `hunch-monorepo/packages/db/migrations/0028_add_dflow_execution_fields.sql`
- `hunch-monorepo/packages/db/migrations/0031_add_metadata_to_unified.sql`

## High-level behavior

- Markets are stored for all statuses (ACTIVE/CLOSED/SETTLED/ARCHIVED) as long as the USDC instrument is present.
- Closed markets are retained in `unified_markets`; feed queries should filter by status instead of relying on deletion.
- Event status is derived from the status mix of its markets.
- Event metrics (volume, liquidity, open interest) are stored at event level. If missing, they are derived as sums of market metrics.
- DFlow sometimes returns u64 sentinel values for missing metrics. Any numeric value >= ~9e18 is treated as missing by the mapper.

## Unified Events

Fields stored in `unified_events`:
- `id`: `kalshi:${event_ticker}`
- `venue`: `kalshi`
- `venue_event_id`: event ticker (from `event_ticker`, `eventTicker`, `ticker`, or `id`)
- `title`: event title; if missing, falls back to ticker
- `description`: stored if provided
- `category`: stored if provided
- `status`: derived from market statuses
- `start_date`: event start/open time if present, else earliest market open time
- `end_date`: event end/close time if present, else latest market expiration/close time
- `volume_total`: event `volume` or sum of market `volume`
- `volume_24h`: event `volume24h` or sum of market `volume24h`
- `liquidity`: event `liquidity` or sum of market `liquidity`
- `open_interest`: event `openInterest` or sum of market `openInterest`
- `metadata`: JSONB with `seriesTicker`, `subtitle`, `competition`, `competitionScope`, `strikeDate`, `strikePeriod`, `settlementSources`
- `slug`, `image`, `icon`: pulled from event payload if present

## Unified Markets

Identity + linkage:
- `id`: `kalshi:${market.ticker}`
- `venue`: `kalshi`
- `venue_market_id`: `market.ticker`
- `event_id`: unified event id
- `market_type`: forced to `binary`

Status + timing:
- `status`: mapped from DFlow status (ACTIVE/CLOSED/SETTLED/ARCHIVED)
- `open_time`, `close_time`, `expiration_time`: parsed from DFlow timestamps

Prices:
- `best_bid`: `yesBid`
- `best_ask`: `yesAsk`
- `last_price`: mid of yes bid/ask if both are present
- Note: `noBid` / `noAsk` are not stored on `unified_markets`

Metrics:
- `volume_total`: from `volume` / `volumeTotal` / `volume_total` / `volumeNum`
- `volume_24h`: from `volume24h` (normalized to `0` when missing)
- `liquidity`: from `liquidity` (cents → USD by `/100`, normalized to `0` when missing)
- `open_interest`: from `openInterest`

Outcomes + tokens:
- `outcomes`: `["YES", "NO"]`
- `token_yes`: `sol:${yesMint}`
- `token_no`: `sol:${noMint}`
- `unified_tokens`: YES/NO tokens are also inserted into `unified_tokens`

DFlow execution fields (Solana):
- `market_ledger`: from account `marketLedger`
- `settlement_mint`: the USDC mint used for the account
- `is_initialized`: from account `isInitialized`
- `redemption_status`: from account `redemptionStatus`

Metadata + media:
- `metadata`: JSONB with `subtitle`, `yesSubTitle`, `noSubTitle`, `rulesPrimary`, `rulesSecondary`, `earlyCloseCondition`, `canCloseEarly`, `result`, `marketType`
- `slug`, `image`, `icon`: pulled from market payload if present

## What is NOT stored

The following values in the DFlow API response are currently ignored:
- Market account info for non-USDC settlements (only the USDC account is used).
- `noBid` / `noAsk` in `unified_markets` (they are only used in book-top snapshots).

## Book-top snapshots (Redis + unified_book_top)

During hot refresh, the indexer publishes best bid/ask for YES/NO tokens:
- Redis: `book:<tokenId>`, `top:<tokenId>`, `prices:<tokenId>`
- DB timeseries: `unified_book_top` via `writeUnifiedBookTop` (token_id, best_bid, best_ask, mid, spread)

## Implications vs sample API response

From a typical DFlow event response, these metrics are stored:
- Event: `volume`, `volume24h`, `liquidity`, `openInterest` (or derived sums)
- Market: `volume`, `volume24h`, `liquidity`, `openInterest`, `yesBid`, `yesAsk`

Finalized markets in the response are stored with a non-ACTIVE status and filtered in feed queries.
