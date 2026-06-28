#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "./db.js";
import {
  deriveFifa2026FixtureKeyFromEvent,
  fetchSportsFixturesByKeys,
  fixtureKeyToSearchQueries,
  formatSportsFixtureForApi,
  normalizeTheSportsDbEvent,
  refreshSportsFixtures,
  sportsFixtureSearchNameCandidates,
  theSportsDbProvider,
  upsertSportsFixtures,
  type SportsCompetitionConfig,
} from "./services/sports-fixtures.js";
import {
  buildMatchFixtureKey,
  parseSportsMatchTeamsFromTitle,
} from "./services/sports-fixture-keys.js";

const competition: SportsCompetitionConfig = {
  sport: "soccer",
  competitionKey: "fifa_world_cup",
  season: "2026",
  provider: "thesportsdb",
  theSportsDbLeagueId: "4429",
};

type FetchRoute = (url: URL) => Record<string, unknown>;

async function withFakeFetch<T>(
  route: FetchRoute,
  fn: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    return new Response(JSON.stringify(route(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function sampleEvent(id: string) {
  return {
    idEvent: id,
    strTimestamp: "2026-06-13T01:00:00",
    strEvent: "USA vs Paraguay",
    strSeason: "2026",
    idLeague: "4429",
    strLeague: "FIFA World Cup",
    strSport: "Soccer",
    strHomeTeam: "USA",
    strAwayTeam: "Paraguay",
    intHomeScore: null,
    intAwayScore: null,
    dateEvent: "2026-06-13",
    dateEventLocal: "2026-06-12",
    strTime: "01:00:00",
    strTimeLocal: "18:00:00",
    strGroup: "D",
    strHomeTeamBadge: "https://example.com/usa.png",
    strAwayTeamBadge: "https://example.com/paraguay.png",
    strVenue: "SoFi Stadium",
    strCountry: "United States",
    strCity: "Inglewood, CA",
    strStatus: "NS",
  };
}

function sportsDbEvent(input: {
  id: string;
  home: string;
  away: string;
  localDate: string;
  timestamp: string;
  status?: string | null;
}) {
  return {
    idEvent: input.id,
    strTimestamp: input.timestamp,
    strEvent: `${input.home} vs ${input.away}`,
    strSeason: "2026",
    idLeague: "4429",
    strLeague: "FIFA World Cup",
    strSport: "Soccer",
    strHomeTeam: input.home,
    strAwayTeam: input.away,
    intHomeScore: null,
    intAwayScore: null,
    dateEvent: input.localDate,
    dateEventLocal: input.localDate,
    strTime: "19:00:00",
    strTimeLocal: "12:00:00",
    strGroup: "A",
    strStatus: input.status ?? "NS",
  };
}

async function main() {
  assert.deepEqual(sportsFixtureSearchNameCandidates("czechia").slice(0, 2), [
    "Czech Republic",
    "Czechia",
  ]);
  assert.ok(
    fixtureKeyToSearchQueries(
      "match:2026-06-24:bosnia-and-herzegovina:qatar",
    ).includes("Bosnia-Herzegovina_vs_Qatar"),
  );
  assert.ok(
    fixtureKeyToSearchQueries("match:2026-06-24:czechia:mexico").includes(
      "Czech_Republic_vs_Mexico",
    ),
  );
  assert.ok(
    fixtureKeyToSearchQueries("match:2026-06-25:curacao:ivory-coast").includes(
      "Curacao_vs_Ivory_Coast",
    ),
  );
  assert.ok(
    fixtureKeyToSearchQueries(
      "match:2026-06-26:cape-verde:saudi-arabia",
    ).includes("Cape_Verde_vs_Saudi_Arabia"),
  );
  assert.ok(
    fixtureKeyToSearchQueries("match:2026-06-24:colombia:congo-dr").includes(
      "Colombia_vs_DR_Congo",
    ),
  );
  assert.ok(
    fixtureKeyToSearchQueries(
      "match:2026-06-24:south-africa:south-korea",
    ).includes("South_Africa_vs_South_Korea"),
  );
  assert.ok(
    fixtureKeyToSearchQueries(
      "match:2026-06-25:turkiye:united-states",
    ).includes("Turkey_vs_USA"),
  );
  assert.ok(
    fixtureKeyToSearchQueries("match:2026-06-26:egypt:iran").includes(
      "Egypt_vs_Iran",
    ),
  );

  await withFakeFetch(
    (url) => {
      if (
        url.pathname.endsWith("/searchevents.php") &&
        url.searchParams.get("e") === "Czech_Republic_vs_Mexico"
      ) {
        return {
          event: [
            sportsDbEvent({
              id: "czechia-mexico",
              home: "Czech Republic",
              away: "Mexico",
              localDate: "2026-06-24",
              timestamp: "2026-06-25T01:00:00",
            }),
          ],
        };
      }
      return { event: [] };
    },
    async () => {
      const fixtures = await theSportsDbProvider.searchFixture(
        competition,
        "match:2026-06-24:czechia:mexico",
      );
      assert.equal(fixtures.length, 1);
      assert.equal(fixtures[0]?.providerFixtureId, "czechia-mexico");
    },
  );

  await withFakeFetch(
    (url) => {
      if (
        url.pathname.endsWith("/searchevents.php") &&
        url.searchParams.get("e") === "Curacao_vs_Ivory_Coast"
      ) {
        return {
          event: [
            sportsDbEvent({
              id: "curacao-ivory-coast",
              home: "Curaçao",
              away: "Ivory Coast",
              localDate: "2026-06-25",
              timestamp: "2026-06-25T20:00:00",
            }),
          ],
        };
      }
      return { event: [] };
    },
    async () => {
      const fixtures = await theSportsDbProvider.searchFixture(
        competition,
        "match:2026-06-25:curacao:ivory-coast",
      );
      assert.equal(fixtures.length, 1);
      assert.equal(fixtures[0]?.providerFixtureId, "curacao-ivory-coast");
    },
  );

  await withFakeFetch(
    (url) => {
      if (url.pathname.endsWith("/eventspastleague.php")) {
        return {
          events: [
            sportsDbEvent({
              id: "bosnia-qatar",
              home: "Bosnia-Herzegovina",
              away: "Qatar",
              localDate: "2026-06-24",
              timestamp: "2026-06-24T19:00:00",
              status: "2H",
            }),
          ],
        };
      }
      return { event: [] };
    },
    async () => {
      const fixtures = await theSportsDbProvider.searchFixture(
        competition,
        "match:2026-06-24:bosnia-and-herzegovina:qatar",
      );
      assert.equal(fixtures.length, 1);
      assert.equal(fixtures[0]?.providerFixtureId, "bosnia-qatar");
      assert.equal(fixtures[0]?.status, "2H");
    },
  );

  await withFakeFetch(
    (url) => {
      if (url.pathname.endsWith("/eventsseason.php")) {
        return {
          events: [
            sportsDbEvent({
              id: "shared-fixture",
              home: "Switzerland",
              away: "Canada",
              localDate: "2026-06-24",
              timestamp: "2026-06-24T19:00:00",
              status: "NS",
            }),
          ],
        };
      }
      if (url.pathname.endsWith("/eventspastleague.php")) {
        return {
          events: [
            sportsDbEvent({
              id: "shared-fixture",
              home: "Switzerland",
              away: "Canada",
              localDate: "2026-06-24",
              timestamp: "2026-06-24T19:00:00",
              status: "2H",
            }),
          ],
        };
      }
      if (url.pathname.endsWith("/eventsnextleague.php")) {
        return {
          events: [
            sportsDbEvent({
              id: "next-fixture",
              home: "Morocco",
              away: "Haiti",
              localDate: "2026-06-24",
              timestamp: "2026-06-24T22:00:00",
              status: "NS",
            }),
          ],
        };
      }
      return { events: [] };
    },
    async () => {
      const fixtures =
        await theSportsDbProvider.fetchCompetitionSeason(competition);
      assert.equal(fixtures.length, 2);
      assert.equal(
        fixtures.find(
          (fixture) => fixture.providerFixtureId === "shared-fixture",
        )?.status,
        "2H",
      );
      assert.ok(
        fixtures.some(
          (fixture) => fixture.providerFixtureId === "next-fixture",
        ),
      );
    },
  );

  const providerId = `test-${crypto.randomUUID()}`;
  const fixture = normalizeTheSportsDbEvent(
    sampleEvent(providerId),
    competition,
    "2026-06-12T22:00:00.000Z",
  );
  assert.ok(fixture);
  assert.equal(fixture.fixtureKey, "match:2026-06-12:united-states:paraguay");
  assert.equal(fixture.kickoffUtc, "2026-06-13T01:00:00.000Z");
  assert.equal(fixture.localDate, "2026-06-12");
  assert.equal(fixture.localTime, "18:00:00");
  assert.equal(fixture.groupName, "D");
  assert.equal(fixture.venue, "SoFi Stadium");
  assert.equal(fixture.city, "Inglewood, CA");
  assert.equal(fixture.country, "United States");
  assert.equal(fixture.homeBadgeUrl, "https://example.com/usa.png");
  assert.equal(fixture.awayBadgeUrl, "https://example.com/paraguay.png");

  const derivativeTitles = [
    "United States vs. Paraguay - Total Corners",
    "United States vs. Paraguay - Halftime Result",
    "United States vs. Paraguay - Player Props",
    "United States vs. Paraguay - Exact Score",
    "USA vs Paraguay: Total Goals",
  ];
  for (const title of derivativeTitles) {
    const teams = parseSportsMatchTeamsFromTitle(title);
    assert.ok(teams.homeTeam, title);
    assert.ok(teams.awayTeam, title);
    assert.equal(
      buildMatchFixtureKey({
        localDate: "2026-06-12",
        homeTeam: teams.homeTeam,
        awayTeam: teams.awayTeam,
      }),
      "match:2026-06-12:united-states:paraguay",
      title,
    );
  }
  assert.equal(
    deriveFifa2026FixtureKeyFromEvent({
      eventTitle: "United States vs. Paraguay - Total Corners",
      eventSlug: "fifwc-usa-par-2026-06-12-total-corners",
    }),
    "match:2026-06-12:united-states:paraguay",
  );
  assert.equal(
    deriveFifa2026FixtureKeyFromEvent({
      eventTitle: "USA vs Paraguay: Total Goals",
      venueEventId: "KXWCTOTAL-26JUN12USAPAR",
    }),
    "match:2026-06-12:united-states:paraguay",
  );
  const dbFixture = normalizeTheSportsDbEvent(
    {
      ...sampleEvent(providerId),
      strTimestamp: "2026-06-30T01:00:00",
      dateEvent: "2026-06-30",
      dateEventLocal: "2026-06-30",
    },
    competition,
    "2026-06-30T22:00:00.000Z",
  );
  assert.ok(dbFixture);

  try {
    await pool.query(
      "delete from sports_fixtures where provider = 'thesportsdb' and provider_fixture_id = $1",
      [providerId],
    );

    const dryRun = await refreshSportsFixtures(pool, {
      sport: "soccer",
      competitionKey: "fifa_world_cup",
      season: "2026",
      fixtureKey: dbFixture.fixtureKey,
      dryRun: true,
      provider: {
        fetchCompetitionSeason: async () => [dbFixture],
        searchFixture: async () => [dbFixture],
      },
    });
    assert.equal(dryRun.fetched, 1);
    assert.equal(dryRun.upserted, 0);

    let countRows = await pool.query<{ count: string }>(
      "select count(*)::text as count from sports_fixtures where provider_fixture_id = $1",
      [providerId],
    );
    assert.equal(countRows.rows[0]?.count, "0");

    assert.equal(await upsertSportsFixtures(pool, [dbFixture]), 1);

    const updated = {
      ...dbFixture,
      status: "FT",
      homeScore: 2,
      awayScore: 1,
      fetchedAt: "2026-06-13T03:00:00.000Z",
    };
    assert.equal(await upsertSportsFixtures(pool, [updated]), 1);
    const movedFixtureKey = "match:2026-07-01:united-states:paraguay";
    assert.equal(
      await upsertSportsFixtures(pool, [
        {
          ...updated,
          fixtureKey: movedFixtureKey,
        },
      ]),
      1,
    );

    const rows = await pool.query<{
      fixture_key: string;
      status: string | null;
      home_score: number | null;
      away_score: number | null;
    }>(
      `
        select fixture_key, status, home_score, away_score
        from sports_fixtures
        where provider = 'thesportsdb' and provider_fixture_id = $1
      `,
      [providerId],
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.fixture_key, movedFixtureKey);
    assert.equal(rows.rows[0]?.status, "FT");
    assert.equal(rows.rows[0]?.home_score, 2);
    assert.equal(rows.rows[0]?.away_score, 1);

    const fetchedFixtures = await fetchSportsFixturesByKeys(pool, {
      sport: competition.sport,
      competitionKey: competition.competitionKey,
      season: competition.season,
      fixtureKeys: [movedFixtureKey],
    });
    const fetched = fetchedFixtures.get(movedFixtureKey);
    assert.ok(fetched);
    const formatted = formatSportsFixtureForApi(fetched);
    assert.equal(formatted.localDate, "2026-06-30");
    assert.equal(
      formatSportsFixtureForApi({
        ...fetched,
        local_date: new Date(2026, 5, 12),
      }).localDate,
      "2026-06-12",
    );

    countRows = await pool.query<{ count: string }>(
      "select count(*)::text as count from sports_fixtures where provider_fixture_id = $1",
      [providerId],
    );
    assert.equal(countRows.rows[0]?.count, "1");
  } finally {
    await pool.query(
      "delete from sports_fixtures where provider = 'thesportsdb' and provider_fixture_id = $1",
      [providerId],
    );
  }
}

await main();
