# AGG Market API Notes

Last verified: 2026-05-11

AGG Market is a prediction-market aggregator API that can provide cross-venue
matched events, matched markets, live midpoints, orderbooks, charts, and route
previews. This document covers the read-only backend integration surface we can
use for the Hunch arbitrage page.

Primary docs:

- https://docs.agg.market/api/overview.md
- https://docs.agg.market/openapi/openapi.json
- https://docs.agg.market/recipes/comparing-venue-prices.md
- https://docs.agg.market/recipes/building-market-views.md

## Config

Local environment currently has these AGG variables:

```text
AGG_APP_ID
AGG_HMAC_SIGNING_KEY
AGG_API_KEY
```

Do not expose `AGG_API_KEY` or `AGG_HMAC_SIGNING_KEY` to the frontend. Keep all
AGG calls behind our backend so we can cache, normalize, gate rollout, and avoid
coupling the UI directly to an alpha API.

## Base URL

```text
https://api.agg.market
```

The OpenAPI spec also lists staging:

```text
https://api.staging.agg.market
```

## Auth Tiers

AGG uses tiered auth:

```text
x-app-id
```

Public/app-tier reads. This is enough for discovery, search, current orderbooks,
midpoints, charts, auth start flows, and route previews.

```text
x-app-id + Authorization: Bearer <jwt>
```

User-tier reads/actions. Required for user profile, balances, positions, orders,
deposit addresses, withdrawals, and executing fills.

```text
x-app-api-key
```

Server-side app-management endpoints. This key must remain backend-only.

## Useful Read-Only Endpoints

Discovery:

```text
GET /venue-events
GET /venue-events/{id}
GET /venue-markets
GET /categories
GET /search
GET /app/config
```

Live pricing and orderbooks:

```text
GET /midpoints
GET /orderbooks
GET /orderbook/outcome/{outcomeId}
GET /charts/bars
GET /orderbook/{venueMarketOutcomeId}/route
```

App management sanity checks:

```text
GET /apps/{appId}/analytics
```

Execution endpoints exist, but they are not part of this read-only arbitrage
integration:

```text
POST /execution/fill
POST /execution/orders/{orderId}/cancel
POST /execution/withdraw
POST /execution/redeem
```

## Venue Coverage

The OpenAPI venue enum currently includes:

```text
kalshi
polymarket
limitless
opinion
predict
probable
myriad
hyperliquid
```

Do not assume every venue has the same fields, depth, history, or execution
capability. Treat AGG venue data as normalized for display/routing, not as a
drop-in replacement for our raw venue indexers until fields are validated.

## Arbitrage Data Flow

AGG's documented cross-venue price comparison flow is:

1. List matched events:

```text
GET /venue-events?status=open&matchStatus=matched&matchStatus=verified&limit=50
```

2. Walk each event's `venueMarkets` and `matchedVenueMarkets` to collect
   `venueMarketId` values.

3. Fetch live marks in batches:

```text
GET /midpoints?venueMarketIds=<id>&venueMarketIds=<id>
```

`/midpoints` accepts up to 200 market IDs per call.

4. Compute spreads in our backend:

```text
spread = max(midpoint) - min(midpoint)
```

5. Optionally fetch current orderbooks for depth and venue attribution:

```text
GET /orderbooks?venueMarketIds=<id>&venueMarketIds=<id>&depth=20
```

AGG docs say `/orderbooks` is the supported public REST endpoint for current
book reads. Legacy public current-book endpoints should not be used.

## Route Preview

For one outcome, AGG can compute a route preview:

```text
GET /orderbook/{venueMarketOutcomeId}/route?maxSpend=10&compareVenues=true
```

Without a user JWT, this is useful as a preview and diagnostic surface. A tested
call returned quote metadata, fills, matched markets, and venue solo quotes, but
status was `insufficient_balance` because no funded user was attached. Executing
a quote requires user auth and `POST /execution/fill`.

Route preview is not a replacement for our arbitrage ranking by itself. Use it
after discovery/midpoint filtering, for detail views or execution preview.

## Tested Read-Only Calls

These calls worked from local backend environment using configured AGG values:

```text
GET /app/config                           200, about 958 ms
GET /venue-events matched/open limit=3    200, about 713 ms
GET /venue-markets matched/open limit=3   200, about 1485 ms
GET /midpoints for 12 market ids          200, about 554 ms
GET /orderbooks for 2 market ids          200, about 622 ms
GET /charts/bars                          200, about 500 ms
GET /orderbook/{outcomeId}/route          200, about 618 ms
GET /apps/{appId}/analytics with API key  200, about 829 ms
```

Example matched event returned by AGG:

```text
title: UEFA Champions League Winner
venues: kalshi, limitless, polymarket, predict
venueCount: 4
marketCount: 60
volume: about 253.9M
```

Example orderbook result:

```text
requested market venue: predict
matched venues: polymarket, predict
status: ok
```

## Response Shape Notes

`GET /venue-events` returns paginated event rows:

```text
data[]
nextCursor
hasMore
```

Useful event fields:

```text
id
externalIdentifier
title
description
image
venue
venues
venueCount
marketCount
volume
status
startDate
endDate
categories
venueMarkets
```

When `matchStatus=matched&matchStatus=verified` is used, AGG includes cross-venue
market data under `venueMarkets` and/or `matchedVenueMarkets`.

Useful market fields:

```text
id
venue
question
description
volume
status
venueCount
venueMarketOutcomes
matchedVenueMarkets
venueEvent
```

Useful outcome fields:

```text
id
venueMarketId
externalIdentifier
label
price
winner
matchedVenueMarketOutcomes
```

`GET /midpoints` returns one row per requested market:

```text
venueMarketId
venue
midpoint
spread
timestamp
outcomes[]
matched[]
```

The midpoint is on a 0-1 probability scale. Outcome midpoint labels matter:
some markets return `No` first and `Yes` second, so do not assume array index 0
is always Yes.

`GET /orderbooks` returns one row per requested market:

```text
venueMarketId
status
error
requestedMarket
matchedMarkets
venueOrderbooks
```

Each `venueOrderbooks[venue].orderbook` contains `bids` and `asks` with price and
size levels. `matchedMarkets[].hasOrderbook` indicates whether a sibling market
has book data.

## Mapping To Current Hunch Arbitrage API

Current frontend page:

```text
Hunch_App/src/app/arbitrage/page.client.tsx
```

It calls our API client:

```text
Hunch_App/src/lib/api/clusters.ts
```

That expects:

```text
ClusterListResponse
  generatedAt
  defaults
  items: ClusterSummary[]
```

Current backend source:

```text
hunch-monorepo/apps/api/src/routes/clusters.ts
```

This is Redis/AI-cluster based. AGG is not a 1:1 replacement because AGG returns
matched venue events/markets and live price data, while our current UI expects
AI analysis, confidence, sources, quality scores, and Hunch unified market IDs.

Implemented KISS integration:

1. Backend AGG client/service lives under `apps/api/src/services/`.
2. Backend route is `GET /clusters/agg`.
3. AGG matched markets are normalized into the existing `ClusterListResponse`
   shape so the arbitrage page can reuse existing cards.
4. Existing `/clusters` remains the Hunch fallback source.
5. `/arbitrage` defaults to AGG; `/arbitrage?source=hunch` uses the legacy Hunch
   cluster source.
6. AGG data is not written into our unified venue tables.

Current route:

```text
GET /clusters/agg
```

Prefer a separate backend service module over embedding AGG calls inside the
route handler.

## Suggested DTO

The implementation intentionally maps AGG output into the existing
`ClusterSummary`/`ClusterMarketSummary` shape because the frontend cards,
market links, images, and metric presentation are already built around that DTO.
A standalone AGG DTO remains a reasonable future option if routing/execution
needs diverge from the current cluster UI.

```ts
type AggArbitrageOpportunity = {
  id: string;
  title: string;
  image: string | null;
  venues: string[];
  venueCount: number;
  marketCount: number;
  volume: number | null;
  spread: number | null;
  generatedAt: string;
  markets: Array<{
    venueMarketId: string;
    venue: string;
    question: string;
    volume: number | null;
    status: string;
    midpoint: number | null;
    spread: number | null;
    outcomes: Array<{
      venueMarketOutcomeId: string;
      label: string;
      price: number | null;
      midpoint: number | null;
    }>;
  }>;
};
```

Current conservative mapping:

```text
id = stable agg:* hash of matched Hunch market IDs
label = AGG event title
marketCount = AGG marketCount or visible market count
venueCount = AGG venueCount
venueCounts = count markets by venue
priceSpread = computed from midpoint extrema
volume24h = Hunch venue volume_24h when positive, otherwise valid snapshot-derived 24h volume
expiresAt = nearest/representative market endDate
analysis = null
analysisStatus = null
qualityScore = null
markets = DB-matched Hunch markets overlaid with AGG midpoint pricing
```

For `ClusterMarketSummary`, production cards only include AGG members that match
a Hunch `unified_markets` row, so existing event/market links remain valid.

## Caching And Performance

Use backend caching. The measured calls are acceptable for server-side refreshes,
but too much direct fanout per user request can become slow:

- `/clusters/agg`: cache 30 seconds by default.
- `venue-markets` and `midpoints` are fetched inside that cached build.
- `orderbooks`: fetch on detail/open only, or cache for a few seconds.
- Chunk `/midpoints` by 200 market IDs.
- Bound result size before midpoint fanout.
- Set request timeouts and return controlled API errors; the frontend can still
  request `/arbitrage?source=hunch` as a fallback.

Current query shape:

```text
GET /venue-markets?status=open&matchStatus=matched&matchStatus=verified&limit=N&sortBy=volume&sortDir=desc
```

Then collect IDs only from the returned page and call `/midpoints` once or in
small chunks.

## Caveats

- AGG docs state the product is currently alpha, so APIs may change.
- `volume` semantics need validation before using it as `volume24h`.
- Outcome order is not guaranteed to be Yes first.
- AGG IDs are not our unified event/market IDs.
- Route previews can return useful fill data even when final status is
  `insufficient_balance`.
- Execution and balances require user auth and are outside this backend-only
  read integration.
- Do not assume AGG matching has the same false-positive/false-negative profile
  as our AI cluster pipeline.

## Implemented Backend Shape

Read-only services:

```text
apps/api/src/services/agg-market-client.ts
apps/api/src/services/agg-market-clusters.ts
```

They:

- read `AGG_APP_ID` server-side;
- implement typed fetch helpers for:
  - `getVenueMarkets`
  - `getMidpointsChunked`
- add timeout, status/error handling, and compact logging with no secrets.

Backend route:

```text
GET /clusters/agg
```

- Query matched open venue markets.
- Fetch midpoints for visible/matched markets.
- Compute spreads and venue counts.
- Return the stable `ClusterListResponse` DTO.
- Default to `40` cluster cards unless `limit` is provided.
- Cache the response in-process.

Frontend:

- `/arbitrage` uses AGG by default.
- `/arbitrage?source=hunch` uses the existing `/clusters` source.
- AGG credentials remain backend-only.

Ongoing quality checks:

- Compare top AGG opportunities against our existing cluster output.
- Check venue coverage and obvious bad matches.
- Validate volume semantics.
- Confirm response latency with larger limits.
