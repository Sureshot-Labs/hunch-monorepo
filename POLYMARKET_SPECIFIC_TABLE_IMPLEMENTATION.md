# Polymarket-Specific Table Implementation

## Overview
This document outlines the implementation of venue-specific tables for Polymarket data storage. The system now stores Polymarket data in dedicated tables (`polymarket_events` and `polymarket_markets`) instead of the consolidated `events` and `markets` tables.

## Changes Made

### 1. Database Migration (`packages/db/migrations/0007_polymarket_specific_table.sql`)
Created a new migration file that adds two Polymarket-specific tables:

#### `polymarket_events` Table
- Stores complete event data from Polymarket API
- Primary key: `id` (Polymarket's native event ID)
- Includes all fields from the Polymarket API response
- Stores raw JSON data in the `raw` column
- Includes timestamps for tracking (`created_at_db`, `updated_at_db`)

#### `polymarket_markets` Table
- Stores complete market data from Polymarket API
- Primary key: `id` (Polymarket's native market ID)
- Foreign key: `event_id` references `polymarket_events(id)`
- Includes all fields from the Polymarket API response
- Stores raw JSON data in the `raw` column
- Includes price tracking fields (best_bid, best_ask, spread, price changes)

### 2. Type Definitions (`apps/indexer-polymarket/src/types.ts`)
Added new Zod schemas and TypeScript types:
- `PolymarketEvent` - Schema matching the Polymarket event structure
- `PolymarketMarket` - Schema matching the Polymarket market structure
- `TPolymarketEvent` - TypeScript type for events
- `TPolymarketMarket` - TypeScript type for markets

Legacy types (`GammaEvent`, `GammaMarket`) are retained for backward compatibility.

### 3. Mapper Functions (`apps/indexer-polymarket/src/mappers.ts`)
Added new mapper functions:
- `mapPolymarketEventRow()` - Maps Polymarket API event data to database row format
- `mapPolymarketMarketRow()` - Maps Polymarket API market data to database row format

These functions handle:
- Date parsing and conversion
- Numeric value parsing
- Default value assignment
- Raw JSON preservation

### 4. Repository Functions (`apps/indexer-polymarket/src/polymarket-repo.ts`)
Created a new repository file with upsert functions:
- `upsertPolymarketEvent()` - Inserts or updates events in `polymarket_events`
- `upsertPolymarketMarket()` - Inserts or updates markets in `polymarket_markets`

Both functions use `ON CONFLICT` clauses to handle upserts and update the `updated_at_db` timestamp on conflicts.

### 5. Bootstrap Logic (`apps/indexer-polymarket/src/bootstrap.ts`)
Updated the bootstrap function to:
- Parse incoming data using `PolymarketEvent.parse()`
- Use new mapper functions for Polymarket-specific structure
- Call new repository functions to store in Polymarket-specific tables
- Extract token IDs from the `clob_token_ids` JSON string field
- Handle errors gracefully with try-catch blocks

## Next Steps

### 1. Run the Migration
```bash
cd packages/db
npm run migrate
```

This will create the new `polymarket_events` and `polymarket_markets` tables in your database.

### 2. Rebuild the Indexer
```bash
cd apps/indexer-polymarket
npm run build
```

### 3. Test the Indexer
```bash
cd apps/indexer-polymarket
npm start
```

The indexer will now:
1. Fetch events from the Polymarket/Gamma API
2. Parse and validate them using the new Polymarket schemas
3. Store them in the `polymarket_events` and `polymarket_markets` tables
4. Extract token IDs for orderbook tracking
5. Continue to snapshot orderbook data for active tokens

### 4. Verify Data Storage
After running the indexer, check the database:

```sql
-- Check events
SELECT id, title, liquidity, volume24hr, active 
FROM polymarket_events 
LIMIT 10;

-- Check markets
SELECT id, event_id, question, enable_order_book, accepting_orders 
FROM polymarket_markets 
LIMIT 10;

-- Check market count per event
SELECT event_id, COUNT(*) as market_count 
FROM polymarket_markets 
GROUP BY event_id 
ORDER BY market_count DESC 
LIMIT 10;
```

## Data Flow

```
Polymarket API
    ↓
fetchAllEvents() [gammaClient.ts]
    ↓
PolymarketEvent.parse() [types.ts - validation]
    ↓
mapPolymarketEventRow() [mappers.ts]
    ↓
upsertPolymarketEvent() [polymarket-repo.ts]
    ↓
polymarket_events table
    ↓
For each market:
    mapPolymarketMarketRow() [mappers.ts]
    ↓
    upsertPolymarketMarket() [polymarket-repo.ts]
    ↓
    polymarket_markets table
```

## Benefits

1. **Complete Data Preservation**: All fields from Polymarket API are stored
2. **Venue-Specific Schema**: Schema matches Polymarket's exact structure
3. **Easy Querying**: Direct access to Polymarket-specific fields
4. **Backward Compatible**: Legacy consolidated tables remain unchanged
5. **Scalable**: Each venue can have its own optimized schema

## No API Changes Required

As requested, **no changes were made to the API layer**. The API continues to work with the existing consolidated tables (`events`, `markets`, `tokens`). Only the indexer has been updated to use the new venue-specific tables.

## Future Enhancements

1. **API Layer Updates**: Create new API endpoints to expose Polymarket-specific data
2. **Data Sync**: Optionally sync data from `polymarket_*` tables to consolidated tables
3. **Other Venues**: Implement similar venue-specific tables for Kalshi and Limitless
4. **Analytics**: Create views or materialized views for cross-venue analytics

