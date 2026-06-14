# FIFA 2026 Special API Handoff

This document describes the backend contract for building a FIFA 2026 page in
the frontend.

The endpoint is public and read-only. It reuses feed-style market data, adds
FIFA-specific classification metadata, and optionally enriches match rows with
cached sports fixtures.

## Endpoint

`GET /special/fifa-2026`

Query params:

- `limit`: page size, same clamp behavior as `/feed`.
- `offset`: page offset.
- `view`: `events` or `markets`. Defaults to `events`.
- `q`: search inside FIFA candidates.
- `venue`: CSV or repeated values, e.g. `polymarket,kalshi`.
- `section`: CSV or repeated values:
  - `winner`
  - `group`
  - `stage`
  - `match_result`
  - `match_prop`
  - `player_award`
  - `squad`
  - `special`
- `sort`: `featured`, `volume`, `volume24h`, `liquidity`, `time`, or
  `newest`.
- `sort_dir`: `asc` or `desc`. `time` defaults to ascending; other sorts
  default to descending.

Useful examples:

```text
/special/fifa-2026?limit=25
/special/fifa-2026?section=match_result,match_prop&sort=time
/special/fifa-2026?section=winner&venue=kalshi
/special/fifa-2026?q=Paraguay&section=match_result,match_prop
/special/fifa-2026?view=markets&section=match_prop&sort=time
```

## Response Shape

The response wrapper:

```json
{
  "ok": true,
  "special": "fifa_2026",
  "count": 25,
  "total": 100,
  "limit": 25,
  "offset": 0,
  "hasMore": true,
  "facets": {
    "sections": [{ "section": "match_result", "events": 42, "markets": 126 }],
    "venues": [{ "venue": "polymarket", "events": 12, "markets": 48 }]
  },
  "data": []
}
```

`view=events` returns one item per venue event, with up to 100 markets nested
under each event. `view=markets` returns one market per item, wrapped in the
same event-shaped object with a single-item `markets` array.

The event object has normal feed/event fields plus:

```json
{
  "fifa": {
    "section": "match_prop",
    "groupType": "match",
    "groupKey": "match:2026-06-12:united-states:paraguay-total-corners",
    "groupLabel": "United States vs. Paraguay - Total Corners",
    "groupCode": null,
    "groupTeams": null,
    "groupMarketType": null,
    "matchKey": null,
    "matchFixtureKey": "match:2026-06-12:united-states:paraguay",
    "matchDate": "2026-06-12",
    "homeTeam": "United States",
    "awayTeam": "Paraguay",
    "teamName": null,
    "teamGroupCode": null,
    "sourceRule": "polymarket_fifwc_slug",
    "confidence": "high",
    "fixture": {
      "provider": "thesportsdb",
      "providerFixtureId": "2391729",
      "status": "NS",
      "kickoffUtc": "2026-06-13T01:00:00.000Z",
      "localDate": "2026-06-12",
      "localTime": "18:00:00",
      "stage": null,
      "groupName": "D",
      "homeTeam": "USA",
      "awayTeam": "Paraguay",
      "homeScore": null,
      "awayScore": null,
      "venue": "SoFi Stadium",
      "city": "Inglewood, CA",
      "country": "United States",
      "homeBadgeUrl": "https://...",
      "awayBadgeUrl": "https://...",
      "fetchedAt": "2026-06-12T22:00:00.000Z"
    }
  }
}
```

The market object has normal market fields plus:

```json
{
  "fifa": {
    "section": "match_prop",
    "subtype": "corners",
    "groupType": "match",
    "groupKey": "match:2026-06-12:united-states:paraguay-total-corners",
    "groupLabel": "United States vs. Paraguay - Total Corners",
    "groupCode": null,
    "groupTeams": null,
    "groupMarketType": null,
    "entity": null,
    "line": 9.5,
    "matchKey": null,
    "matchFixtureKey": "match:2026-06-12:united-states:paraguay",
    "teamName": null,
    "teamGroupCode": null,
    "sourceRule": "polymarket_fifwc_slug",
    "confidence": "high"
  }
}
```

## Grouping Guidance

Use `fifa.matchFixtureKey` as the canonical key for grouping the same real
match across venues and derivative events.

Examples that should share one frontend match section:

- `United States vs. Paraguay`
- `United States vs. Paraguay - Exact Score`
- `United States vs. Paraguay - More Markets`
- `United States vs. Paraguay - Total Corners`
- `United States vs. Paraguay - Player Props`
- Kalshi `USA vs Paraguay: Total Goals`

These can have different `groupKey` values for compatibility and section-level
presentation, but they share the same `matchFixtureKey`.

Use `groupKey` for non-match sections such as outright winner, group winner,
stage markets, squad markets, and special/media markets.

For group and team pages, use the nullable structured fields when present:

- `groupCode`: FIFA group code, `A` through `L`.
- `groupTeams`: ordered teams in that group.
- `groupMarketType`: `winner`, `qualify`, `bottom`, `order`,
  `champion_group`, or `unknown`.
- `teamName`: normalized team/entity name when the market is about one known
  team.
- `teamGroupCode`: FIFA group code for `teamName`.

Examples:

- `World Cup Group A Winner => Mexico` returns `groupKey=group:a:winner`,
  `groupCode=A`, `teamName=Mexico`, and `teamGroupCode=A`.
- `World Cup: Group of Champion => Group A (...)` returns market-level
  `groupKey=group:a:champion_group`, `groupCode=A`, and `groupTeams`.
- `World Cup Winner => USA` returns `teamName=USA` and `teamGroupCode=D`.

## Fixture Enrichment

Fixtures are stored in `sports_fixtures` and served from the database only.
External provider calls never block `/special/fifa-2026`, `/events/:id`, or
`/markets/:id`.

If a visible match fixture is missing and Redis is available, the API queues a
best-effort background fill through TheSportsDB. Missing fixtures are returned
as `fixture: null`.

`sportsFixture.localDate` and `fifa.fixture.localDate` are plain
`YYYY-MM-DD`. `kickoffUtc` and `fetchedAt` remain timestamp strings.

Event detail and market detail responses also expose fixture data when the
event maps to a FIFA 2026 match:

- `GET /events/:id` returns top-level `sportsFixture`.
- `GET /markets/:id` returns `event.sportsFixture`.

## Frontend Page Suggestions

Recommended top-level tabs or filters:

- `Matches`: request `section=match_result,match_prop&sort=time`.
- `Winner`: request `section=winner`.
- `Groups`: request `section=group`.
- `Knockout / Stage`: request `section=stage`.
- `Players`: request `section=player_award`.
- `Squads`: request `section=squad`.
- `Specials`: request `section=special`.

For a match page or accordion, group rows by `matchFixtureKey`, then show:

- fixture date/time, venue, city, badges, and score/status when present;
- best match-result markets first;
- prop markets grouped by `subtype` such as `total`, `spread`, `corners`,
  `correct_score`, and `player_goal_or_assist`;
- venue badges or labels using the existing market `venue` field.

Facets can drive counts in the UI without extra calls. Search can be combined
with section and venue filters.

If the frontend uses generated API types, regenerate them after the backend
OpenAPI dump is updated. If the generator does not infer the response body for
this route, add a small local response type matching this document in the
frontend API wrapper.

## Ops

Migration:

```bash
pnpm -C hunch-monorepo migrate
```

Optional fixture refresh:

```bash
pnpm -C hunch-monorepo -F api run sports:fixtures:refresh -- --sport=soccer --competition=fifa_world_cup --season=2026
```

Config defaults:

- `SPORTS_FIXTURES_PROVIDER=thesportsdb`
- `THESPORTSDB_API_KEY=123`
- `SPORTS_FIXTURES_REFRESH_TTL_SEC=900`
- `SPORTS_FIXTURES_BACKGROUND_FILL_ENABLED=true`

The free TheSportsDB key works locally. Provider failures should not break the
public APIs.

## Compatibility

Existing `/feed`, `/events`, and `/markets` behavior remains compatible. The
new fields are additive:

- `/special/fifa-2026` is a new route.
- `/events/:id` adds nullable `sportsFixture`.
- `/markets/:id` adds nullable `event.sportsFixture`.

Older clients can ignore the new fields.
