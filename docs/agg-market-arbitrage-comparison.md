# AGG Market vs Hunch Arbitrage Comparison

Last verified: 2026-05-11 10:44 Europe/Lisbon

This report compares the current production Hunch arbitrage surface with the
read-only AGG Market matched-market API. It is intended as a baseline for a
future integration plan.

## Calls Used

Hunch production arbitrage clusters, through the same public frontend proxy path
used by the browser:

```text
GET https://app.hunch.trade/api/hunch/clusters?sort_by=volume24h&sort_dir=desc&limit=24
```

AGG read-only calls:

```text
GET https://api.agg.market/venue-events?status=open&matchStatus=matched&matchStatus=verified&limit=50&sortBy=volume&sortDir=desc
GET https://api.agg.market/venue-markets?status=open&matchStatus=matched&matchStatus=verified&limit=100&sortBy=volume&sortDir=desc
GET https://api.agg.market/midpoints?venueMarketIds=...
```

AGG requests used `x-app-id` from local backend env. No write or execution calls
were made.

## Latency Snapshot

```text
Hunch /clusters via app domain: 311 ms
AGG /venue-events matched:      1005 ms
AGG /venue-markets matched:      847 ms
AGG /midpoints for 200 ids:      227 ms
```

These are one-off measurements, not a benchmark. Still, AGG midpoint fanout is
fast enough for backend refresh/cache use. AGG discovery calls should be cached
and should not be fanned out on every user request without bounds.

## Current Hunch Output

Production returned 10 clusters after current default filters:

```text
limit: 24
minVenueCount: 2
minSpread: 0.03
minQualityScore: 0.6
minAnalysisConfidence: 0.6
maxOutlierRatio: 0.4
generatedAt: 2026-05-11T08:30:45.068Z
```

Top examples:

```text
Fed Chair confirmation markets diverge on Warsh timing vs Bowman odds
venues: polymarket, kalshi
spread: 0.978
volume24h: 2,099,746.71
confidence: 0.91

China Taiwan invasion markets by June vs end of 2026
venues: polymarket, limitless
spread: 0.0875
volume24h: 392,913.90
confidence: 0.94

Fed policy path into the June 2026 meeting
venues: polymarket, kalshi
spread: 0.9615
volume24h: 167,803.41
confidence: 0.94

Democrats to control the U.S. House in 2026
venues: polymarket, kalshi
spread: 0.03
volume24h: 23,954.24
confidence: 0.97
```

Strengths:

- Already returns the DTO the frontend expects.
- Includes Hunch unified event and market IDs, so links/images/details work.
- Includes AI label, summary, confidence, quality score, diagnostics, and
  outlier handling.
- Can intentionally capture related-but-not-identical markets and explain rule
  differences.

Weaknesses:

- Batch-generated, not a live orderbook surface.
- Some high-spread examples are not directly executable arbitrage because rules,
  dates, or outcome definitions differ.
- Some venue metrics are hard to compare across venues, especially Limitless
  liquidity.
- Coverage is limited to markets we ingest and cluster.

## AGG Output

AGG returned:

```text
matched events page: 50 rows, hasMore true
matched markets page: 100 rows, hasMore true
midpoints: 200 ids requested, 200 rows returned
```

Top matched events by AGG volume:

```text
UEFA Champions League Winner
venues: kalshi, limitless, polymarket, predict
venueCount: 4
marketCount: 60
volume: 253,919,927.99

Netanyahu out by...?
venues: limitless, polymarket, predict
venueCount: 3
marketCount: 5
volume: 120,302,240.93

NBA MVP
venues: kalshi, polymarket
venueCount: 2
marketCount: 33
volume: 93,794,344.36

Will Jesus Christ return before 2027?
venues: polymarket, predict
venueCount: 2
marketCount: 1
volume: 62,274,675.99

Who will be confirmed as Fed Chair?
venues: kalshi, polymarket
venueCount: 2
marketCount: 35
volume: 51,179,472.19
```

AGG has much broader venue coverage than our current arbitrage page. It includes
venues such as `predict`, `opinion`, `probable`, `myriad`, and `hyperliquid` in
addition to Kalshi, Polymarket, and Limitless.

## Raw AGG Spread Findings

A simple midpoint spread calculation over the first 100 matched markets produced
some plausible leads but also noisy results.

Examples:

```text
US recession by end of 2026?
venues: opinion, limitless, kalshi
spread: 0.154
volume: 3,450,386.42

Flavio Bolsonaro
venues: polymarket, kalshi
spread: 0.057
volume: 5,238,033.24

10.0 or above earthquake before 2027?
venues: opinion, polymarket
spread: 0.053
volume: 2,459,297.24

Will the US confirm that aliens exist before 2027?
venues: kalshi, opinion, predict, polymarket
spread: 0.049
volume: 46,158,597.89

Fed rate hike in 2026?
venues: predict, polymarket
spread: 0.0325
volume: 6,216,289.09
```

Important noise observed:

- Some matched siblings can be `resolved` even when the primary query asks for
  `status=open`. We must filter every member, not just the primary market.
- Some matches are related but not identical, for example broader event wording
  versus a narrower deal/deadline contract.
- Some midpoint rows use a headline midpoint that is not always the Yes outcome.
  We must use outcome labels, not array position or headline midpoint alone.
- Multi-outcome markets need more careful outcome pairing than binary markets.
- Midpoint spread is not executable arbitrage. We need bid/ask depth, fees,
  settlement/rule compatibility, and venue execution constraints.

## Overlap With Hunch

The top raw AGG opportunities did not materially overlap the top Hunch clusters
by simple title matching in this sample.

This does not mean one source is wrong. It means they are different products:

- Hunch clusters are curated/AI-analyzed semantic market groups over our indexed
  venue universe.
- AGG returns broader matched venue market data with live pricing and routing
  surfaces.

AGG should not replace `/clusters` directly without a normalization and quality
layer. It is more useful as either:

1. a second arbitrage source, or
2. a live price/orderbook enrichment source for a new arbitrage experience.

## Integration Implications

Do not directly wire raw AGG `/venue-events` or `/venue-markets` into the
current arbitrage cards. Current cards expect Hunch IDs, images, venue summaries,
and stable event/market links. The implemented route only returns AGG members
that can be matched back to Hunch `unified_markets`.

Use a backend service layer:

```text
apps/api/src/services/agg-market-client.ts
apps/api/src/services/agg-market-clusters.ts
```

The service should:

- read `AGG_APP_ID` server-side;
- keep `AGG_API_KEY` server-only;
- fetch matched events/markets;
- fetch midpoints in chunks of 200;
- optionally fetch orderbooks for shortlisted candidates;
- normalize outcome labels;
- filter bad/stale/resolved members;
- compute conservative spread fields;
- cache responses.

## Implemented Direction

The current implementation follows the KISS/DRY direction from this report:

- AGG remains a backend-only integration.
- `GET /clusters/agg` returns the existing `ClusterListResponse` shape.
- The frontend reuses `ArbitrageCard` instead of adding a parallel card model.
- `/arbitrage` defaults to AGG.
- `/arbitrage?source=hunch` keeps the previous Hunch cluster source available.
- AGG data is not written into `unified_markets` or `unified_events`.

Implemented backend checks include:

- repeated query params;
- app-id header;
- outcome label normalization;
- open-status filtering on every matched member;
- midpoint chunking at 200 ids;
- DB matching by venue identifiers and condition fallback;
- duplicate-venue group drops;
- unsupported venue rejection;
- cache behavior.

Remaining QA before increasing traffic:

- Compare:
  - count of candidates;
  - overlap with Hunch clusters;
  - false positives;
  - stale/resolved member rate;
  - response latency;
  - venue distribution;
  - spread persistence over time.

## Decision

AGG is worth integrating, but only through a backend-normalized Hunch-compatible
layer.

Best path:

```text
Use AGG as the default arbitrage discovery source while keeping Hunch clusters
available as a fallback/comparison source.
```
