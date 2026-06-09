# AGG Market Cluster Page Integration Plan

Last updated: 2026-05-11

## Goal

Use AGG Market as a backend-normalized source for live cross-venue matched
markets, initially limited to:

```text
polymarket
kalshi
limitless
```

The first product surface is the existing arbitrage/cluster page. The current
implementation keeps the Hunch `/clusters` pipeline intact, adds a separate
`/clusters/agg` source, and makes AGG the default `/arbitrage` source. The
legacy Hunch cluster source remains available through `/arbitrage?source=hunch`.

## Current Anchors To Reuse

Backend:

```text
apps/api/src/routes/clusters.ts
apps/api/src/schemas/clusters.ts
apps/api/src/services/clusters.ts
```

Frontend:

```text
Hunch_App/src/lib/api/clusters.ts
Hunch_App/src/lib/api/clusters.server.ts
Hunch_App/src/app/arbitrage/page.tsx
Hunch_App/src/app/arbitrage/page.client.tsx
Hunch_App/src/components/Arbitrage/ArbitrageCard/*
```

Database:

```text
unified_markets
unified_events
```

Important existing helpers:

- `buildMarketSummary(row)` already maps DB rows to `ClusterMarketSummary`.
- `computeClusterMetrics(markets)` already computes venue counts, spreads,
  liquidity, volume, and expiry for current card data.
- Frontend `ArbitrageCard` already renders `ClusterSummary`.

Do not introduce a second card model unless AGG forces it. The first version
should adapt AGG into the existing `ClusterListResponse`.

## Non-Goals For V1

- Do not replace `/clusters`; keep it available as the Hunch fallback source.
- Do not write AGG data into `unified_markets` or `unified_events`.
- Do not add a durable mapping table until match-rate QA shows it is needed.
- Do not expose AGG credentials to the frontend.
- Do not include AGG venues outside `polymarket`, `kalshi`, and `limitless`.
- Do not treat AGG midpoint spread as executable arbitrage.
- Do not rely on AGG `volume` as Hunch `volume24h` until its semantics are
  validated against venue data.

## Architecture

Add a separate backend route:

```text
GET /clusters/agg
```

Return the same high-level shape as `/clusters`:

```ts
type ClusterListResponse = {
  generatedAt: string | null;
  defaults?: {
    limit: number;
    minVenueCount: number;
    minSpread: number;
    minQualityScore: number;
    minAnalysisConfidence: number;
    maxOutlierRatio: number;
  };
  items: ClusterSummary[];
};
```

Add optional metadata to `ClusterSummary` and `ClusterMarketSummary` only where
needed:

```ts
source?: "hunch" | "agg";
pricingSource?: "hunch_db" | "agg_midpoint" | "agg_orderbook";
aggVenueMarketId?: string | null;
aggVenueEventId?: string | null;
matchMethod?: string | null;
```

Existing consumers can ignore these fields. The arbitrage page can use
`source === "agg"` to hide AI-analysis UI that does not apply.

## Backend Data Flow

1. Fetch AGG matched open markets.

   ```text
   GET /venue-markets?status=open&matchStatus=matched&matchStatus=verified&limit=N&sortBy=volume&sortDir=desc
   ```

2. Build candidate groups from each primary market plus
   `matchedVenueMarkets`.

3. Filter every group member, not just the primary:
   - venue is one of `polymarket`, `kalshi`, `limitless`;
   - status is open;
   - market has usable outcomes;
   - at least two venues remain;
   - binary markets first for v1;
   - the selected side can be identified safely.

4. Collect AGG market IDs and fetch live midpoints in chunks of 200.

   ```text
   GET /midpoints?venueMarketIds=<id>&venueMarketIds=<id>
   ```

5. Resolve the selected-side midpoint. For simple participant contracts this is
   the labeled Yes outcome; for aligned head-to-head markets it may require
   inverting an opposite-side row to `No`. Do not assume outcome index `0` is
   Yes.

6. Match AGG markets to Hunch DB rows.

7. Fetch matched `unified_markets` plus `unified_events` in one DB query.

8. Convert DB rows with `buildMarketSummary(row)`.

9. Overlay AGG live pricing on the DB summary:
   - set `yesMid` from AGG labeled Yes midpoint;
   - set `noMid = 1 - yesMid`;
   - set `pricingSource = "agg_midpoint"`;
   - keep DB identity, event IDs, images, volume, liquidity, open interest, and
     expiry.

10. Compute cluster metrics with `computeClusterMetrics(markets)`.

11. Apply query filters.

12. Return `ClusterListResponse`.

## Outcome Handling

V1 should support binary contracts, not only questions literally worded as
Yes/No markets.

AGG examples checked on 2026-05-11 show that sports futures are commonly
represented as one binary contract per participant:

```text
Champions League Winner -> PSG -> Yes/No
Champions League Winner -> Arsenal -> Yes/No
World Cup Winner -> France -> Yes/No
NBA MVP -> Victor Wembanyama -> Yes/No
NHL/Super Bowl futures -> team name -> Yes/No
```

These are safe when the market question/title identifies the selected
participant and every matched venue row represents the same participant.

Head-to-head sports markets are riskier. AGG can return one Polymarket binary
market such as:

```text
Thunder vs. Lakers -> Yes/No
```

matched to two separate Kalshi binary markets:

```text
Oklahoma City -> Yes/No
Los Angeles L -> Yes/No
```

For these, a plain "use the Yes price" rule is not enough. The normalizer must
either:

- use AGG outcome matching metadata to align the same participant across venues;
- use the existing Hunch participant-selection logic and invert to `No` when the
  matched row represents the opposite side; or
- drop the group until alignment is implemented and tested.

Markets whose tradable outcomes are team labels instead of Yes/No, for example
`Los Angeles Lakers` vs `Oklahoma City Thunder`, were observed on AGG venues
outside the initial allowlist. They are out of scope for the initial
`polymarket`, `kalshi`, `limitless` rollout.

## Matching Strategy

The matcher must be conservative. Production cards should only include markets
that resolve to a Hunch `unified_markets.id`.

AGG fields seen in docs and read-only probes include:

```text
id
venue
externalIdentifier
conditionId
venueEventId
venueMarketOutcomes[].externalIdentifier
```

Use exact identifiers first:

1. `unified_markets.venue = agg.venue`
2. `unified_markets.venue_market_id = agg.externalIdentifier`

Venue fallbacks:

- Polymarket:
  - `unified_markets.condition_id = agg.conditionId`, when present;
  - outcome external identifiers matching stored CLOB token IDs, if AGG exposes
    them consistently.
- Kalshi:
  - `venue_market_id = agg.externalIdentifier`, expected to be the ticker;
  - if AGG includes a prefixed ticker, strip only known prefixes in a tested
    normalizer.
- Limitless:
  - `venue_market_id = agg.externalIdentifier`, expected to be the market ID;
  - `condition_id = agg.conditionId`, when present.

Do not production-match by title similarity. Use title similarity only for a
debug report that explains unmatched AGG rows.

If any member in a candidate group cannot be matched, drop that member. If fewer
than two venues remain after DB matching, drop the group from the product
response.

## Query Parameters

Support the existing cluster filters where they make sense:

```text
limit
minLiquidity
minVenueCount
minSpread
sort_by
sort_dir
```

Add AGG-specific optional params:

```text
venues=polymarket,kalshi,limitless
sourceLimit=100
```

Validation:

- `venues` must be a subset of the server allowlist:
  `polymarket,kalshi,limitless`.
- default `venues` is the full allowlist.
- default `limit` is `40` cluster cards.
- `sourceLimit` caps AGG discovery fanout before midpoint calls.

Sorting:

- Keep `sort_by=volume24h` for compatibility.
- Add `sort_by=spread` for AGG cluster discovery.
- Default AGG sort is `volume24h desc`, then `spread desc`, then `id asc`, so
  the page favors markets with meaningful observed activity.

## Caching And Performance

Do not fan out to AGG per card or per market row from the frontend.

Backend cache rules:

- Cache the full `/clusters/agg` response for 15-30 seconds.
- Include query params and venue allowlist in the cache key.
- Use a short request timeout for AGG discovery, around 3-5 seconds.
- Chunk `/midpoints` at 200 IDs.
- Bound `sourceLimit` so one request cannot fetch unbounded AGG data.
- Fetch DB rows with set-based queries, not one query per market.

Initial implementation can use in-memory API-process cache. If this becomes a
shared production surface, move the cache to Redis.

Expected request budget:

```text
1 AGG venue-markets call
1-2 AGG midpoints calls for normal limits
1 DB query for unified market/event rows
0 frontend AGG calls
```

This should stay comfortably below direct uncached multi-second fanout once the
route cache is warm.

## Frontend Plan

Add source-aware cluster client helpers:

```ts
fetchClusters(params: ClusterListParams): Promise<ClusterListResponse>
```

Add a query-key source segment:

```ts
clusterKeys.list({ source: "agg", ...params });
```

Support the internal Hunch fallback switch for the arbitrage page:

```text
/arbitrage?source=hunch
```

Default `/arbitrage` uses AGG.

Minimal UI adjustments:

- Reuse `ArbitrageCard`.
- If `cluster.source === "agg"` and `analysis == null`, hide
  `ArbitrageCardAnalysis` instead of showing "Analysis pending."
- Keep market rows linked to Hunch event pages because only DB-matched markets
  are returned.
- Show `pricingSource` only in debug/internal views, not on the user card.

## Tests

Backend unit tests:

- AGG query builder serializes repeated `matchStatus` and `venueMarketIds`.
- AGG client sends `x-app-id` and never logs secrets.
- Venue allowlist rejects unsupported venues.
- Group filter removes resolved or non-open siblings.
- Outcome parser finds Yes by label, not array index.
- Midpoint chunking splits at 200 IDs.
- Matcher maps:
  - Polymarket by `externalIdentifier`;
  - Kalshi by ticker;
  - Limitless by market ID;
  - fallback by `conditionId` where supported.
- Unmatched members are dropped.
- Groups with fewer than two matched venues are dropped.
- `computeClusterMetrics` uses overlaid AGG midpoint values.

Backend route tests:

- `/clusters/agg` returns `ClusterListResponse`.
- `venues=polymarket,kalshi` excludes Limitless.
- `venues=opinion` returns 400.
- `sort_by=spread` sorts by computed spread.
- AGG timeout returns a controlled 503 or cached stale response.
- Missing `AGG_APP_ID` disables the route with a controlled 503.

Frontend tests/checks:

- `fetchAggClusters` builds the correct URL.
- Arbitrage page can render `ClusterSummary` with `source="agg"` and
  `analysis=null`.
- Current `/arbitrage` default calls `/clusters/agg`.
- `/arbitrage?source=hunch` calls `/clusters`.

Manual QA:

- Compare `/clusters` and `/clusters/agg` side by side.
- Record AGG DB match rate by venue.
- Inspect top 20 AGG cards for rule mismatches.
- Verify market links open valid Hunch event pages.
- Verify Limitless liquidity display uses Hunch DB fields, not AGG volume.
- Check cold and warm endpoint latency.

## Phased Delivery

### Phase 0: Fixtures And Match-Rate Harness

Add a local-only script or test fixture path that:

- reads saved AGG `venue-markets` and `midpoints` fixtures;
- normalizes candidates;
- attempts DB matching;
- prints match rate by venue and drop reasons.

No route and no frontend changes in this phase.

### Phase 1: AGG Client And Normalizer

Add:

```text
apps/api/src/services/agg-market-client.ts
apps/api/src/services/agg-market-clusters.ts
```

Responsibilities:

- typed fetch helpers;
- auth header handling;
- timeout/error handling;
- response normalization;
- outcome midpoint selection;
- venue allowlist filtering.

### Phase 2: DB Matcher

Add a set-based matcher that accepts normalized AGG markets and returns Hunch
market rows.

Keep it independent from the HTTP client so it is testable with fixtures.

### Phase 3: Backend Endpoint

Add:

```text
GET /clusters/agg
```

The route returns `ClusterListResponse`, uses cache, and is consumed by the
default arbitrage page source.

### Phase 4: Frontend Default And Fallback

Add:

```text
/arbitrage
/arbitrage?source=hunch
```

Reuse `ArbitrageCard`. Hide analysis for AGG cards. Keep the Hunch source
available by query parameter for comparison and fallback.

### Phase 5: Shadow QA And Rollout Decision

Run shadow checks before promoting:

- match rate by venue;
- false-positive rate in top results;
- latency p50/p95;
- AGG failure rate;
- overlap with existing Hunch clusters;
- distribution of spreads and stale/resolved drops.

Use this data to decide whether AGG remains:

- the default arbitrage page source;
- an alternate tab/source;
- a live price enrichment layer for existing Hunch clusters.

## Deployment Readiness Checklist

- `AGG_APP_ID` configured in API env.
- `AGG_API_KEY` remains unused for public read route unless a server-management
  endpoint is explicitly needed.
- Route returns controlled errors when AGG config is missing.
- Warm route latency checked with production-like `sourceLimit`.
- No frontend bundle contains AGG credentials.
- OpenAPI/types regenerated if the API route is public in generated docs.
- Tests pass for API and frontend typecheck.
- Current `/clusters` behavior unchanged.
