#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pool } from "./db.js";
import {
  deriveFifa2026FixtureKeyFromEvent,
  fetchSportsFixturesByKeys,
  formatSportsFixtureForApi,
  normalizeTheSportsDbEvent,
  refreshSportsFixtures,
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

async function main() {
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
    await pool.end();
  }
}

await main();
