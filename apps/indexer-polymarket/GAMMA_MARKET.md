# Gamma (Polymarket) -> DB Storage Notes

This document summarizes what the Polymarket indexer pulls from the Gamma API and how the data is stored in the venue-specific and unified tables.

Sources:

- `hunch-monorepo/apps/indexer-polymarket/src/gammaClient.ts`
- `hunch-monorepo/apps/indexer-polymarket/src/types.ts`
- `hunch-monorepo/apps/indexer-polymarket/src/mappers.ts`
- `hunch-monorepo/apps/indexer-polymarket/src/bootstrap.ts`
- `hunch-monorepo/apps/indexer-polymarket/src/polymarket-repo.ts`
- `hunch-monorepo/packages/db/src/unified-repo.ts`
- `hunch-monorepo/packages/db/migrations/0007_polymarket_specific_table.sql`
- `hunch-monorepo/packages/db/migrations/0019_add_category_to_polymarket_tables.sql`

## What we fetch from Gamma

- Endpoint: `GET {POLYMARKET_GAMMA_BASE}/events`
- Query params used: `offset`, `limit`, `order`, `ascending`, `active`, `archived`, `closed`, `tag_id`, `exclude_tag_id`, `tag_slug`, `related_tags`, `start_date_min`, `start_date_max`, `end_date_min`, `end_date_max`.
- Response shape accepted:
  - Either a raw array of events, or `{ events: [...] }`, or `{ data: [...] }`.
- Each event is expected to include a `markets` array.

Note: the sample payload you provided looks like a market object with nested `events/series/collections`. The indexer does **not** call `/markets`; it only pulls `/events` and expects `event.markets`.

## Parsing behavior

- `GammaEvent` / `GammaMarket` and `PolymarketEvent` / `PolymarketMarket` are both permissive (`.passthrough()`), so extra fields from Gamma are preserved in the parsed object.
- Numbers arrive as strings or numbers. The `num` helper coerces strings to numbers.
- `clobTokenIds` can be a JSON string or an array; it is normalized to an array and then stringified when written to DB.

## Writes: Polymarket-specific tables

Data is written into `polymarket_events` and `polymarket_markets`. Market rows store the full market raw JSON. Event rows store event-level raw JSON, but omit the nested `markets` array because each market already has its own raw row in `polymarket_markets`.

### `polymarket_events` (from each event)

Mapped columns include:

- `id`, `ticker`, `slug`, `title`, `description`, `resolution_source`
- `start_date`, `creation_date`, `end_date`
- `category`, `image`, `icon`
- `active`, `closed`, `archived`, `new`, `featured`, `restricted`
- `liquidity`, `volume`, `open_interest`
- `created_by`, `created_at`, `updated_at`
- `competitive`, `volume24hr`, `volume1wk`, `volume1mo`, `volume1yr`
- `enable_order_book`, `liquidity_clob`, `neg_risk`, `comment_count`
- `raw` (entire event JSON)

### `polymarket_markets` (from each event.market)

Mapped columns include:

- IDs and text: `id`, `event_id`, `question`, `condition_id`, `slug`, `resolution_source`, `description`
- Timing: `start_date`, `end_date`, `created_at`, `updated_at`, `accepting_orders_timestamp`
- Status and flags: `active`, `closed`, `archived`, `new`, `featured`, `restricted`, `enable_order_book`, `accepting_orders`, `ready`, `funded`, `cyom`, `approved`, `automatically_active`, `clear_book_on_start`, `pending_deployment`, `deploying`, `rfq_enabled`, `holding_rewards_enabled`, `fees_enabled`
- Liquidity and volume: `liquidity`, `volume`, `volume24hr`, `volume1wk`, `volume1mo`, `volume1yr`, `volume_num`, `liquidity_num`
- CLOB metrics: `clob_token_ids`, `volume24hr_clob`, `volume1wk_clob`, `volume1mo_clob`, `volume1yr_clob`, `volume_clob`, `liquidity_clob`
- Order parameters: `order_price_min_tick_size`, `order_min_size`
- Market metadata: `market_maker_address`, `group_item_title`, `group_item_threshold`, `question_id`, `category`, `image`, `icon`, `outcomes`, `outcome_prices`, `uma_bond`, `uma_reward`, `custom_liveness`, `neg_risk`, `neg_risk_request_id`, `competitive`
- Pricing: `spread`, `one_day_price_change`, `one_hour_price_change`, `one_week_price_change`, `one_month_price_change`, `last_trade_price`, `best_bid`, `best_ask`
- UI flags: `series_color`, `show_gmp_series`, `show_gmp_outcome`, `manual_activation`, `neg_risk_other`, `uma_resolution_statuses`
- `raw` (entire market JSON)

## Writes: Unified tables

### `unified_events`

Mapped columns:

- `id`: `polymarket:${event.id}`
- `venue`: `polymarket`
- `venue_event_id`: event.id
- `title`, `description`, `slug`, `image`, `icon`
- `category`: Gamma category if present, else inferred from keywords in title/description
- `status`: ACTIVE by default; CLOSED if `closed` or `endDate` has passed; ARCHIVED if `archived`
- `start_date`, `end_date`
- `volume_total` (`volume`), `volume_24h` (`volume24hr`), `liquidity`, `open_interest`
- `created_at`, `updated_at`
- `metadata`: JSONB with `resolutionSource`, `creationDate`, `sponsorName`, `sponsorImage`, `twitterCardImage`, `competitive`, `volume1wk`, `volume1mo`, `volume1yr`, `enableOrderBook`, `liquidityClob`, `negRisk`, `commentCount`

### `unified_markets`

Mapped columns:

- `id`: `polymarket:${market.id}`
- `venue`: `polymarket`
- `venue_market_id`: market.id
- `event_id`: `polymarket:${event.id}`
- `title`: `groupItemTitle` if present, else `question`
- `description`, `slug`, `image`, `icon`
- `category`: Gamma category if present, else inferred from keywords in question/description
- `status`: ACTIVE by default; CLOSED if `closed` or `endDate` has passed; ARCHIVED if `archived`
- `market_type`: `binary`
- `open_time` (startDate), `close_time` (endDate), `expiration_time` (endDate)
- `best_bid`, `best_ask`, `last_price`
- `volume_total` (`volume`), `volume_24h` (`volume24hr`), `liquidity`
- `open_interest`: uses `openInterest` if present on the market payload (often missing)
- `outcomes` (JSON string)
- `clob_token_ids` (JSON string)
- `condition_id`
- `metadata`: JSONB with `resolutionSource`, `outcomePrices`, `fee`, `marketMakerAddress`, `clobTokenIds`, `groupItemTitle`, `groupItemThreshold`, `questionId`, orderbook params, volume/liquidity breakdowns, UMA fields, `ammType`, bounds, `marketType`, `formatType`

Important behavior: closed/archived markets are **retained** in `unified_markets` and should be filtered out at query time (status/time filters).

## Book snapshots and Redis

- Book snapshots are pulled via `postBooksOnce` for selected CLOB token IDs.
- These snapshots are written to `unified_book_top` and cached in Redis (`book:<token>`, `top:<token>`).

## Fields not mapped to columns (but preserved in raw)

Gamma provides many fields that are not normalized into columns or unified metadata. Examples (not exhaustive):

- `xAxisValue`, `yAxisValue`, `denominationToken`
- `closedTime`, `wideFormat`, `mailchimpTag`, `curationOrder`
- `makerBaseFee`, `takerBaseFee`, `notificationsEnabled`, `score`
- Event-level expansions like `events`, `series`, `collections`, `tags`, `categories`, `imageOptimized`, `iconOptimized`

These values are still available in `polymarket_events.raw` or `polymarket_markets.raw`.
