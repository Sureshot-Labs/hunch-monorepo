#!/usr/bin/env tsx

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildApp } from "./app.js";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  buildFifaSpecialSearchSqlForTest,
  fetchFifaSpecialPage,
  type FifaSpecialInputs,
} from "./services/fifa-special.js";

type Venue = "polymarket" | "kalshi" | "limitless";

type SeedEvent = {
  id: string;
  venue: Venue;
  venueEventId: string;
  title: string;
  slug?: string | null;
  seriesKey?: string | null;
  seriesTitle?: string | null;
  metadata?: Record<string, unknown>;
  volumeTotal?: number;
  endDate?: Date;
};

type SeedMarket = {
  id: string;
  venue: Venue;
  venueMarketId: string;
  eventId: string;
  title: string;
  slug?: string | null;
  metadata?: Record<string, unknown>;
  volumeTotal?: number;
  closeTime?: Date;
};

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function token(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) search.set(key, String(value));
  }
  return search.toString();
}

async function captureFifaSql(inputs: FifaSpecialInputs): Promise<string[]> {
  const captured: string[] = [];
  const fakePool = {
    async query(sql: string) {
      captured.push(sql);
      if (/select\s+count\(/i.test(sql)) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [] };
    },
  };
  await fetchFifaSpecialPage(fakePool as never, inputs);
  return captured;
}

async function insertEvent(event: SeedEvent): Promise<void> {
  await pool.query(
    `
      insert into unified_events (
        id, venue, venue_event_id, title, description, category, status,
        series_key, series_title, start_date, end_date, volume_total,
        volume_24h, liquidity, open_interest, slug, metadata, created_at, updated_at
      )
      values (
        $1, $2, $3, $4, null, 'sports', 'ACTIVE',
        $5, $6, now() - interval '1 hour', $7, $8,
        10, 100, 50, $9, $10::jsonb, now(), now()
      )
    `,
    [
      event.id,
      event.venue,
      event.venueEventId,
      event.title,
      event.seriesKey ?? null,
      event.seriesTitle ?? null,
      (event.endDate ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)).toISOString(),
      event.volumeTotal ?? 100,
      event.slug ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}

async function insertMarket(market: SeedMarket): Promise<void> {
  await pool.query(
    `
      insert into unified_markets (
        id, venue, venue_market_id, event_id, title, description, category,
        status, market_type, open_time, close_time, expiration_time, best_bid,
        best_ask, last_price, volume_total, volume_24h, liquidity,
        open_interest, outcomes, token_yes, token_no, clob_token_ids, slug,
        metadata, created_at, updated_at
      )
      values (
        $1, $2, $3, $4, $5, null, 'sports',
        'ACTIVE', 'binary', now() - interval '1 hour', $6, $6,
        0.4, 0.6, 0.5, $7, 10, 100, 50, '["Yes","No"]',
        $8, $9, $10::jsonb, $11, $12::jsonb, now(), now()
      )
    `,
    [
      market.id,
      market.venue,
      market.venueMarketId,
      market.eventId,
      market.title,
      (market.closeTime ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)).toISOString(),
      market.volumeTotal ?? 100,
      token("yes"),
      token("no"),
      JSON.stringify([token("clob-yes"), token("clob-no")]),
      market.slug ?? null,
      JSON.stringify(
        market.metadata ??
          (market.venue === "kalshi" ? { dflowNativeAcceptingOrders: true } : {}),
      ),
    ],
  );
}

async function main() {
  const app = await buildApp();
  const previousFeedTtl = env.feedTtlSec;
  env.feedTtlSec = 0;
  const eventIds: string[] = [];
  const marketIds: string[] = [];
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const fixtureProviderId = `test-fixture-${suffix}`;
  const fixtureKey = "match:2026-06-30:united-states:paraguay";

  const events: SeedEvent[] = [
    {
      id: id("polymarket:fifa-match"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: "United States vs. Paraguay",
      slug: `fifwc-usa-par-2026-06-30-${suffix}`,
      seriesKey: "soccer-fifwc",
      seriesTitle: "FIFA World Cup",
      volumeTotal: 500,
    },
    {
      id: id("polymarket:fifa-props"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: "United States vs. Paraguay - More Markets",
      slug: `fifwc-usa-par-2026-06-30-more-markets-${suffix}`,
      seriesKey: "soccer-fifwc",
      seriesTitle: "FIFA World Cup",
      volumeTotal: 400,
    },
    {
      id: id("polymarket:fifa-winner"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `World Cup Winner ${suffix}`,
      slug: `world-cup-winner-${suffix}`,
      volumeTotal: 600,
    },
    {
      id: id("polymarket:friendly"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `United States vs. Senegal Friendly ${suffix}`,
      slug: `fif-usa-sen-2026-06-01-${suffix}`,
      seriesKey: "fifa-friendly",
      seriesTitle: "Fifa Friendly",
      volumeTotal: 800,
    },
    {
      id: id("kalshi:fifa-winner"),
      venue: "kalshi",
      venueEventId: `KXMENWORLDCUP-26-${suffix}`,
      title: `2026 Men's World Cup Winner ${suffix}`,
      seriesKey: "KXMENWORLDCUP",
      seriesTitle: "Men's World Cup winner",
      metadata: { competition: "FIFA", seriesCategory: "Sports", seriesTags: ["Soccer"] },
      volumeTotal: 700,
    },
    {
      id: id("kalshi:fifa-total"),
      venue: "kalshi",
      venueEventId: `KXWCTOTAL-26JUN30USAPAR-${suffix}`,
      title: "USA vs Paraguay: Total Goals",
      seriesKey: "KXWCTOTAL",
      seriesTitle: "World Cup Total",
      metadata: { seriesTags: ["Soccer"] },
      volumeTotal: 300,
    },
    {
      id: id("kalshi:fifa-special"),
      venue: "kalshi",
      venueEventId: `KXWCMENTION-26JUN30USAPAR-${suffix}`,
      title: `What will announcers say during USA vs Paraguay FIFA World Cup Match ${suffix}`,
      seriesKey: "KXWCMENTION",
      seriesTitle: "World Cup Mentions",
      metadata: { seriesTags: ["Soccer"] },
      volumeTotal: 250,
    },
    {
      id: id("limitless:fifa-winner"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `2026 FIFA World Cup Winner ${suffix}`,
      slug: `2026-fifa-world-cup-winner-${suffix}`,
      metadata: { marketType: "group" },
      volumeTotal: 200,
    },
    {
      id: id("limitless:esports"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `Esports World Cup Winner ${suffix}`,
      slug: `esports-world-cup-winner-${suffix}`,
      metadata: { marketType: "group" },
      volumeTotal: 900,
    },
    {
      id: id("polymarket:fifa-exact"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: "United States vs. Paraguay - Exact Score",
      slug: `fifwc-usa-par-2026-06-30-exact-score-${suffix}`,
      seriesKey: "soccer-fifwc",
      seriesTitle: "FIFA World Cup",
      volumeTotal: 350,
    },
    {
      id: id("polymarket:fifa-corners"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: "United States vs. Paraguay - Total Corners",
      slug: `fifwc-usa-par-2026-06-30-total-corners-${suffix}`,
      seriesKey: "soccer-fifwc",
      seriesTitle: "FIFA World Cup",
      volumeTotal: 320,
    },
    {
      id: id("polymarket:fifa-player-props"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: "United States vs. Paraguay - Player Props",
      slug: `fifwc-usa-par-2026-06-30-player-props-${suffix}`,
      seriesKey: "soccer-fifwc",
      seriesTitle: "FIFA World Cup",
      volumeTotal: 310,
    },
    {
      id: id("polymarket:fifa-group-champion"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `World Cup: Group of Champion ${suffix}`,
      slug: `world-cup-group-of-champion-${suffix}`,
      volumeTotal: 290,
    },
    {
      id: id("kalshi:fifa-group-winner"),
      venue: "kalshi",
      venueEventId: `KXWCGROUPWIN-26A-MEX-${suffix}`,
      title: `Group A Winner ${suffix}`,
      seriesKey: "KXWCGROUPWIN",
      seriesTitle: "World Cup Group Winner",
      metadata: { seriesTags: ["Soccer"] },
      volumeTotal: 280,
    },
    {
      id: id("kalshi:fifa-group-qualify"),
      venue: "kalshi",
      venueEventId: `KXWCGROUPQUAL-26A-KOR-${suffix}`,
      title: `Group A Qualifiers ${suffix}`,
      seriesKey: "KXWCGROUPQUAL",
      seriesTitle: "World Cup Group Qualifiers",
      metadata: { seriesTags: ["Soccer"] },
      volumeTotal: 270,
    },
    {
      id: id("polymarket:fifa-group-last"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `World Cup: Group A Last Place ${suffix}`,
      slug: `world-cup-group-a-last-place-${suffix}`,
      volumeTotal: 260,
    },
    {
      id: id("polymarket:fifa-group-highest-scoring"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `World Cup: Highest-Scoring Team in Group A ${suffix}`,
      slug: `world-cup-highest-scoring-team-in-group-a-${suffix}`,
      volumeTotal: 255,
    },
    {
      id: id("kalshi:fifa-spread"),
      venue: "kalshi",
      venueEventId: `KXWCSPREAD-26JUN30USAPAR-${suffix}`,
      title: `USA vs Paraguay: Spread ${suffix}`,
      seriesKey: "KXWCSPREAD",
      seriesTitle: "World Cup Spread",
      metadata: { seriesTags: ["Soccer"] },
      volumeTotal: 245,
    },
    {
      id: id("kalshi:fifa-first-half"),
      venue: "kalshi",
      venueEventId: `KXWC1H-26JUN30USAPAR-${suffix}`,
      title: `USA vs Paraguay: First Half Winner ${suffix}`,
      seriesKey: "KXWC1H",
      seriesTitle: "World Cup First Half Winner",
      metadata: { seriesTags: ["Soccer"] },
      volumeTotal: 240,
    },
    {
      id: id("polymarket:fifa-young-player-award"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `World Cup: Young Player Award Winner ${suffix}`,
      slug: `world-cup-young-player-award-winner-${suffix}`,
      volumeTotal: 235,
    },
    {
      id: id("kalshi:fifa-match"),
      venue: "kalshi",
      venueEventId: `KXWCGAME-26JUN30USAPAR-${suffix}`,
      title: `USA vs Paraguay ${suffix}`,
      seriesKey: "KXWCGAME",
      seriesTitle: "World Cup Match",
      metadata: { seriesTags: ["Soccer"] },
      volumeTotal: 230,
    },
    {
      id: id("limitless:world-cup-golden-boot"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `World Cup: Golden Boot Winner ${suffix}`,
      slug: `world-cup-golden-boot-winner-${suffix}`,
      volumeTotal: 190,
    },
    {
      id: id("limitless:world-cup-semifinals"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `World Cup: Nation To Reach Semifinals ${suffix}`,
      slug: `world-cup-nation-to-reach-semifinals-${suffix}`,
      volumeTotal: 180,
    },
    {
      id: id("limitless:world-cup-group-scoring"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `World Cup: Highest-Scoring Team in Group D ${suffix}`,
      slug: `world-cup-highest-scoring-team-in-group-d-${suffix}`,
      volumeTotal: 170,
    },
    {
      id: id("limitless:world-cup-captain"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `USA captain for the opening World Cup match vs Paraguay on June 13 ${suffix}`,
      slug: `usa-captain-for-the-opening-world-cup-match-vs-paraguay-on-june-13-${suffix}`,
      volumeTotal: 160,
    },
    {
      id: id("limitless:club-world-cup"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `Club World Cup Winner ${suffix}`,
      slug: `club-world-cup-winner-${suffix}`,
      volumeTotal: 950,
    },
    {
      id: id("limitless:world-cup-player-special"),
      venue: "limitless",
      venueEventId: id("lim-event"),
      title: `Messi to play against Ronaldo at the 2026 World Cup ${suffix}`,
      slug: `messi-to-play-against-ronaldo-at-the-2026-world-cup-${suffix}`,
      volumeTotal: 150,
    },
    {
      id: id("polymarket:fifa-stage-elimination"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `World Cup: Paraguay Stage of Elimination ${suffix}`,
      slug: `world-cup-paraguay-stage-of-elimination-${suffix}`,
      volumeTotal: 145,
    },
    {
      id: id("polymarket:fifa-netherlands-japan"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: "Netherlands vs. Japan",
      slug: `fifwc-netherlands-japan-2026-06-14-${suffix}`,
      seriesKey: "soccer-fifwc",
      seriesTitle: "FIFA World Cup",
      volumeTotal: 120,
    },
    {
      id: id("polymarket:fifa-group-f-champion"),
      venue: "polymarket",
      venueEventId: id("pm-event"),
      title: `World Cup: Group of Champion Group F ${suffix}`,
      slug: `world-cup-group-f-champion-${suffix}`,
      volumeTotal: 1_000,
    },
  ];

  const markets: SeedMarket[] = [
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[0].id,
      title: "United States",
      slug: `fifwc-usa-par-2026-06-30-usa-${suffix}`,
      volumeTotal: 500,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[1].id,
      title: "O/U 2.5",
      slug: `fifwc-usa-par-2026-06-30-total-2pt5-${suffix}`,
      volumeTotal: 400,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[2].id,
      title: "France",
      slug: `will-france-win-the-2026-fifa-world-cup-${suffix}`,
      volumeTotal: 600,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[3].id,
      title: "United States",
      slug: `fif-usa-sen-2026-06-01-usa-${suffix}`,
      volumeTotal: 800,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[4].id,
      title: "Brazil",
      volumeTotal: 700,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[5].id,
      title: `Over 2.5 ${suffix}`,
      volumeTotal: 300,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[6].id,
      title: "Penalty kick",
      volumeTotal: 250,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[7].id,
      title: "Argentina",
      slug: `argentina-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[7].venueEventId },
      volumeTotal: 200,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[8].id,
      title: "Team Liquid",
      slug: `team-liquid-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[8].venueEventId },
      volumeTotal: 900,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[9].id,
      title: "United States 2 - 1 Paraguay",
      slug: `fifwc-usa-par-2026-06-30-exact-score-usa-2-1-paraguay-${suffix}`,
      volumeTotal: 350,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[10].id,
      title: "Total Corners: O/U 9.5",
      slug: `fifwc-usa-par-2026-06-30-total-corners-total-9pt5-${suffix}`,
      volumeTotal: 320,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[11].id,
      title: "Christian Pulisic: 1+ goals",
      slug: `fifwc-usa-par-2026-06-30-player-props-pulisic-goal-${suffix}`,
      volumeTotal: 310,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[12].id,
      title: "Group A (Mexico, South Korea, South Africa, Czechia)",
      slug: `will-the-2026-fifa-world-cup-champion-be-a-nation-from-group-a-${suffix}`,
      volumeTotal: 290,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[13].id,
      title: "Mexico",
      volumeTotal: 280,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[14].id,
      title: "Korea Republic",
      volumeTotal: 270,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[15].id,
      title: "Mexico",
      volumeTotal: 260,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[16].id,
      title: "South Korea",
      volumeTotal: 255,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[17].id,
      title: "USA wins by over 1.5 goals",
      volumeTotal: 245,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[18].id,
      title: "USA",
      volumeTotal: 240,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[19].id,
      title: "Lamine Yamal",
      slug: `world-cup-young-player-award-winner-lamine-yamal-${suffix}`,
      volumeTotal: 235,
    },
    {
      id: id("kalshi-market"),
      venue: "kalshi",
      venueMarketId: id("kalshi-venue-market"),
      eventId: events[20].id,
      title: "Tie",
      volumeTotal: 230,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[21].id,
      title: "Lamine Yamal",
      slug: `lamine-yamal-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[21].venueEventId },
      volumeTotal: 190,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[22].id,
      title: "Brazil",
      slug: `brazil-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[22].venueEventId },
      volumeTotal: 180,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[23].id,
      title: "USA",
      slug: `usa-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[23].venueEventId },
      volumeTotal: 170,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[24].id,
      title: "Christian Pulisic",
      slug: `christian-pulisic-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[24].venueEventId },
      volumeTotal: 160,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[25].id,
      title: "Real Madrid",
      slug: `real-madrid-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[25].venueEventId },
      volumeTotal: 950,
    },
    {
      id: id("lim-market"),
      venue: "limitless",
      venueMarketId: id("lim-venue-market"),
      eventId: events[26].id,
      title: "Yes",
      slug: `yes-${suffix}`,
      metadata: { tradeType: "clob", groupId: events[26].venueEventId },
      volumeTotal: 150,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[0].id,
      title: "Paraguay",
      slug: `fifwc-usa-par-2026-06-30-paraguay-${suffix}`,
      volumeTotal: 490,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[0].id,
      title: "Draw (United States vs. Paraguay)",
      slug: `fifwc-usa-par-2026-06-30-draw-${suffix}`,
      volumeTotal: 480,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[2].id,
      title: "Paraguay",
      slug: `will-paraguay-win-the-2026-fifa-world-cup-${suffix}`,
      volumeTotal: 590,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[2].id,
      title: "USA",
      slug: `will-usa-win-the-2026-fifa-world-cup-${suffix}`,
      volumeTotal: 580,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[27].id,
      title: "Champion",
      slug: `will-paraguay-win-the-world-cup-${suffix}`,
      volumeTotal: 140,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[27].id,
      title: "Group Stage",
      slug: `will-paraguay-be-eliminated-in-group-stage-stage-of-the-world-cup-${suffix}`,
      volumeTotal: 130,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[27].id,
      title: "Other",
      slug: `will-paraguay-finish-in-some-other-position-in-the-world-cup-${suffix}`,
      volumeTotal: 120,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[28].id,
      title: "Netherlands",
      slug: `fifwc-netherlands-japan-2026-06-14-netherlands-${suffix}`,
      volumeTotal: 120,
    },
    {
      id: id("pm-market"),
      venue: "polymarket",
      venueMarketId: id("pm-venue-market"),
      eventId: events[29].id,
      title: "Group F (Tunisia, Japan, Netherlands, Sweden)",
      slug: `will-the-2026-fifa-world-cup-champion-be-a-nation-from-group-f-${suffix}`,
      volumeTotal: 1_000,
    },
  ];

  try {
    for (const event of events) {
      eventIds.push(event.id);
      await insertEvent(event);
    }
    for (const market of markets) {
      marketIds.push(market.id);
      await insertMarket(market);
    }
    await pool.query(
      "delete from sports_fixtures where provider = 'thesportsdb' and provider_fixture_id = $1",
      [fixtureProviderId],
    );
    await pool.query(
      `
        insert into sports_fixtures (
          sport, competition_key, season, fixture_key, provider, provider_fixture_id,
          status, kickoff_utc, local_date, local_time, group_name,
          home_team_key, home_team_name, away_team_key, away_team_name,
          venue, city, country, home_badge_url, away_badge_url, fetched_at, raw
        )
        values (
          'soccer', 'fifa_world_cup', '2026', $1, 'thesportsdb', $2,
          'NS', '2026-07-01T01:00:00Z', '2026-06-30', '18:00:00', 'D',
          'united-states', 'USA', 'paraguay', 'Paraguay',
          'SoFi Stadium', 'Inglewood, CA', 'United States',
          'https://example.com/usa.png', 'https://example.com/paraguay.png',
          '2026-06-30T22:00:00Z', '{}'::jsonb
        )
      `,
      [fixtureKey, fixtureProviderId],
    );

    {
      const searchSql = buildFifaSpecialSearchSqlForTest("Netherlands Japan");
      assert.match(searchSql.cte, /and e\.status = 'ACTIVE'/);
      assert.match(searchSql.cte, /and m\.status = 'ACTIVE'/);
      assert.match(searchSql.cte, /raw_search_events as materialized/);
      assert.match(searchSql.cte, /join lateral/);
      assert.match(searchSql.cte, /raw on not sq\.applies/);
      assert.match(searchSql.cte, /search_candidate_markets as materialized/);
      assert.equal(searchSql.predicate, "true");
      assert.ok(
        !searchSql.predicate.includes(" like "),
        "normal FIFA search predicate must not broad-scan raw LIKE",
      );
    }

    {
      const capturedSql = await captureFifaSql({
        limit: 25,
        offset: 0,
        view: "events",
        q: "usa",
        sort: "featured",
        sortDir: "desc",
        nowParam: new Date().toISOString(),
      });
      assert.equal(
        capturedSql.filter((sql) => /search_candidate_markets as materialized/.test(sql))
          .length,
        1,
        "search should build bounded candidates once",
      );
      assert.ok(
        capturedSql.every((sql) => !/select\s+count\(/i.test(sql)),
        "search should not run a separate count query",
      );
      assert.ok(
        capturedSql.every((sql) => !/group by section/i.test(sql)),
        "search should compute section facets from bounded rows",
      );
    }

    {
      const capturedSql = await captureFifaSql({
        limit: 25,
        offset: 0,
        view: "events",
        sort: "featured",
        sortDir: "desc",
        nowParam: new Date().toISOString(),
      });
      const countSql = capturedSql.find((sql) => /select\s+count\(/i.test(sql));
      assert.ok(countSql, "regular event feed should still issue an exact count");
      assert.match(countSql, /candidate_keys as materialized/);
      assert.doesNotMatch(countSql, /event_title/);
      assert.doesNotMatch(countSql, /fifa_subtype/);
      assert.doesNotMatch(countSql, /sum\(coalesce\(m\.volume_total/);
      const facetSql = capturedSql.filter((sql) =>
        /candidate_facets as materialized/.test(sql),
      );
      assert.equal(facetSql.length, 2);
      assert.ok(facetSql.every((sql) => !/fifa_subtype/.test(sql)));
    }

    {
      const response = await app.inject({
        method: "GET",
        url: "/special/fifa-2026?limit=1",
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{ ok: boolean; data: unknown[] }>();
      assert.equal(payload.ok, true);
      assert.ok(Array.isArray(payload.data));
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ limit: 50, q: suffix })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        ok: boolean;
        data: Array<{ eventId: string; fifa: { section: string }; markets: Array<{ fifa: { section: string } }> }>;
      }>();
      assert.equal(payload.ok, true);
      const ids = payload.data.map((event) => event.eventId);
      assert.ok(ids.includes(events[0].id));
      assert.ok(ids.includes(events[1].id));
      assert.ok(ids.includes(events[2].id));
      assert.ok(ids.includes(events[4].id));
      assert.ok(ids.includes(events[7].id));
      assert.ok(ids.includes(events[21].id));
      assert.ok(ids.includes(events[22].id));
      assert.ok(ids.includes(events[23].id));
      assert.ok(ids.includes(events[24].id));
      assert.ok(ids.includes(events[26].id));
      assert.ok(!ids.includes(events[3].id), "fifa-friendly should be excluded");
      assert.ok(!ids.includes(events[8].id), "generic esports World Cup should be excluded");
      assert.ok(!ids.includes(events[25].id), "Club World Cup should be excluded");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ limit: 10, q: "Netherlands Japan", venue: "polymarket" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; fifa: { section: string } }>;
      }>();
      const ids = payload.data.map((event) => event.eventId);
      assert.equal(ids[0], events[28].id);
      assert.ok(ids.includes(events[29].id));
      assert.ok(
        ids.indexOf(events[28].id) < ids.indexOf(events[29].id),
        "exact match event should rank before same-team group/tournament row",
      );
    }

    {
      const baseResponse = await app.inject({
        method: "GET",
        url: "/special/fifa-2026?view=markets&limit=1",
      });
      const fifaResponse = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 1, q: "FIFA" })}`,
      });
      const worldCupResponse = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 1, q: "2026 World Cup" })}`,
      });
      assert.equal(baseResponse.statusCode, 200, baseResponse.body);
      assert.equal(fifaResponse.statusCode, 200, fifaResponse.body);
      assert.equal(worldCupResponse.statusCode, 200, worldCupResponse.body);
      const basePayload = baseResponse.json<{ total: number }>();
      const fifaPayload = fifaResponse.json<{ total: number }>();
      const worldCupPayload = worldCupResponse.json<{ total: number }>();
      assert.equal(fifaPayload.total, basePayload.total);
      assert.equal(worldCupPayload.total, basePayload.total);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: "Paraguay", section: "winner", venue: "polymarket" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; markets: Array<{ marketTitle: string | null }> }>;
      }>();
      const winnerMarkets = payload.data
        .filter((event) => event.eventId === events[2].id)
        .flatMap((event) => event.markets.map((market) => market.marketTitle));
      assert.deepEqual(winnerMarkets, ["Paraguay"]);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ limit: 50, q: "Paraguay", section: "winner", venue: "polymarket" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; markets: Array<{ marketTitle: string | null }> }>;
      }>();
      const winnerEvent = payload.data.find((event) => event.eventId === events[2].id);
      assert.ok(winnerEvent, "market-only query should still include the parent event");
      assert.deepEqual(
        winnerEvent.markets.map((market) => market.marketTitle),
        ["Paraguay"],
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: "Paraguay", section: "match_result", venue: "polymarket" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; markets: Array<{ marketTitle: string | null }> }>;
      }>();
      const matchMarkets = payload.data
        .filter((event) => event.eventId === events[0].id)
        .flatMap((event) => event.markets.map((market) => market.marketTitle));
      assert.ok(matchMarkets.includes("United States"));
      assert.ok(matchMarkets.includes("Paraguay"));
      assert.ok(matchMarkets.includes("Draw (United States vs. Paraguay)"));
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: suffix, section: "stage", venue: "polymarket" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{
          eventId: string;
          markets: Array<{
            marketTitle: string | null;
            fifa: { section: string; subtype: string; groupKey: string };
          }>;
        }>;
      }>();
      const stageMarkets = payload.data
        .filter((event) => event.eventId === events[27].id)
        .flatMap((event) => event.markets);
      assert.deepEqual(
        stageMarkets.map((market) => market.marketTitle).sort(),
        ["Champion", "Group Stage", "Other"],
      );
      assert.ok(
        stageMarkets.every(
          (market) =>
            market.fifa.section === "stage" &&
            market.fifa.subtype === "stage_entity" &&
            market.fifa.groupKey ===
              `stage:world-cup-paraguay-stage-of-elimination-${suffix}`,
        ),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: suffix, venue: "limitless" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{
          eventId: string;
          fifa: { section: string; sourceRule: string; groupCode: string | null; groupMarketType: string | null };
          markets: Array<{
            fifa: {
              section: string;
              groupCode: string | null;
              groupMarketType: string | null;
              sourceRule: string;
            };
          }>;
        }>;
      }>();
      const ids = payload.data.map((event) => event.eventId);
      assert.ok(ids.includes(events[7].id), "exact Limitless FIFA text should remain included");
      assert.ok(ids.includes(events[21].id), "Limitless Golden Boot World Cup row should be included");
      assert.ok(ids.includes(events[22].id), "Limitless semifinal World Cup row should be included");
      assert.ok(ids.includes(events[23].id), "Limitless group-scoring World Cup row should be included");
      assert.ok(ids.includes(events[24].id), "Limitless captain World Cup row should be included");
      assert.ok(ids.includes(events[26].id), "Limitless player-special World Cup row should be included");
      assert.ok(!ids.includes(events[8].id), "Limitless esports World Cup should stay excluded");
      assert.ok(!ids.includes(events[25].id), "Limitless Club World Cup should stay excluded");

      const goldenBoot = payload.data.find((event) => event.eventId === events[21].id);
      const semifinals = payload.data.find((event) => event.eventId === events[22].id);
      const groupScoring = payload.data.find((event) => event.eventId === events[23].id);
      const captain = payload.data.find((event) => event.eventId === events[24].id);
      const playerSpecial = payload.data.find((event) => event.eventId === events[26].id);
      assert.equal(goldenBoot?.markets[0]?.fifa.section, "player_award");
      assert.equal(goldenBoot?.markets[0]?.fifa.sourceRule, "limitless_world_cup_pattern");
      assert.equal(semifinals?.markets[0]?.fifa.section, "stage");
      assert.equal(groupScoring?.markets[0]?.fifa.section, "group");
      assert.equal(groupScoring?.markets[0]?.fifa.groupCode, "D");
      assert.equal(groupScoring?.markets[0]?.fifa.groupMarketType, "highest_scoring_team");
      assert.equal(captain?.markets[0]?.fifa.section, "special");
      assert.equal(playerSpecial?.markets[0]?.fifa.section, "special");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ limit: 50, q: suffix, section: "winner", venue: "kalshi" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{
          eventId: string;
          fifa: { section: string };
          markets: Array<{ fifa: { teamName: string | null; teamGroupCode: string | null } }>;
        }>;
      }>();
      assert.deepEqual(
        payload.data.map((event) => event.eventId),
        [events[4].id],
      );
      assert.equal(payload.data[0]?.fifa.section, "winner");
      assert.equal(payload.data[0]?.markets[0]?.fifa.teamName, "Brazil");
      assert.equal(payload.data[0]?.markets[0]?.fifa.teamGroupCode, "C");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: suffix, section: "group" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{
          eventId: string;
          fifa: {
            groupCode: string | null;
            groupMarketType: string | null;
            matchFixtureKey: string | null;
          };
          markets: Array<{
            internalMarketId: string;
            venueMarketId: string;
            fifa: {
              groupKey: string;
              groupCode: string | null;
              groupTeams: string[] | null;
              groupMarketType: string | null;
              teamName: string | null;
              teamGroupCode: string | null;
              matchFixtureKey: string | null;
            };
          }>;
        }>;
      }>();
      const groupChampion = payload.data.find((event) => event.eventId === events[12].id);
      const kalshiWinner = payload.data.find((event) => event.eventId === events[13].id);
      const kalshiQualify = payload.data.find((event) => event.eventId === events[14].id);
      const groupLast = payload.data.find((event) => event.eventId === events[15].id);
      const groupHighestScoring = payload.data.find((event) => event.eventId === events[16].id);
      assert.equal(groupChampion?.fifa.groupMarketType, "champion_group");
      assert.equal(groupChampion?.fifa.matchFixtureKey, null);
      assert.equal(groupChampion?.markets[0]?.fifa.groupKey, "group:a:champion_group");
      assert.equal(groupChampion?.markets[0]?.fifa.groupCode, "A");
      assert.deepEqual(groupChampion?.markets[0]?.fifa.groupTeams, [
        "Mexico",
        "South Korea",
        "South Africa",
        "Czechia",
      ]);
      assert.equal(groupChampion?.markets[0]?.internalMarketId, markets[12].id);
      assert.equal(groupChampion?.markets[0]?.venueMarketId, markets[12].venueMarketId);
      assert.equal(kalshiWinner?.fifa.groupCode, "A");
      assert.equal(kalshiWinner?.markets[0]?.fifa.groupKey, "group:a:winner");
      assert.equal(kalshiWinner?.markets[0]?.fifa.groupMarketType, "winner");
      assert.equal(kalshiWinner?.markets[0]?.fifa.teamName, "Mexico");
      assert.equal(kalshiWinner?.markets[0]?.fifa.teamGroupCode, "A");
      assert.equal(kalshiQualify?.markets[0]?.fifa.groupKey, "group:a:qualify");
      assert.equal(kalshiQualify?.markets[0]?.fifa.groupMarketType, "qualify");
      assert.equal(kalshiQualify?.markets[0]?.fifa.teamName, "South Korea");
      assert.equal(kalshiQualify?.markets[0]?.fifa.teamGroupCode, "A");
      assert.equal(groupLast?.markets[0]?.fifa.groupKey, "group:a:last_place");
      assert.equal(groupLast?.markets[0]?.fifa.groupMarketType, "last_place");
      assert.equal(groupHighestScoring?.markets[0]?.fifa.groupKey, "group:a:highest_scoring_team");
      assert.equal(
        groupHighestScoring?.markets[0]?.fifa.groupMarketType,
        "highest_scoring_team",
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: suffix, section: "group", group_code: "a" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        facets: { sections: Array<{ section: string; events: number; markets: number }> };
        data: Array<{ markets: Array<{ fifa: { groupCode: string | null } }> }>;
      }>();
      assert.ok(payload.data.length >= 5);
      assert.deepEqual(
        payload.facets.sections.map((facet) => facet.section),
        ["group"],
      );
      assert.ok(
        payload.data.every((event) =>
          event.markets.every((market) => market.fifa.groupCode === "A"),
        ),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ limit: 50, sort: "featured", group_code: "a" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ markets: Array<{ fifa: { groupCode: string | null } }> }>;
      }>();
      assert.ok(payload.data.length >= 1);
      assert.ok(
        payload.data.every((event) =>
          event.markets.every((market) => market.fifa.groupCode === "A"),
        ),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: "Paraguay", section: "match_result", team_group_code: "d" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ markets: Array<{ fifa: { teamGroupCode: string | null } }> }>;
      }>();
      assert.ok(payload.data.length >= 2);
      assert.ok(
        payload.data.every((event) =>
          event.markets.every((market) => market.fifa.teamGroupCode === "D"),
        ),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ limit: 50, q: "Paraguay", section: "match_result,match_prop" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{
          eventId: string;
          fifa: {
            section: string;
            matchKey: string | null;
            groupKey: string | null;
            matchFixtureKey: string | null;
            fixture: {
              providerFixtureId: string;
              homeTeam: string | null;
              awayTeam: string | null;
              venue: string | null;
              localDate: string | null;
            } | null;
          };
          markets: Array<{
            fifa: {
              subtype: string | null;
              matchFixtureKey: string | null;
              teamName: string | null;
              teamGroupCode: string | null;
            };
          }>;
        }>;
      }>();
      const ids = payload.data.map((event) => event.eventId);
      assert.ok(ids.includes(events[0].id));
      assert.ok(ids.includes(events[1].id));
      assert.ok(ids.includes(events[5].id));
      assert.ok(ids.includes(events[9].id));
      assert.ok(ids.includes(events[10].id));
      assert.ok(ids.includes(events[11].id));
      assert.ok(payload.data.some((event) => event.fifa.matchKey?.includes("paraguay")));
      const polymarketMatch = payload.data.find((event) => event.eventId === events[0].id);
      const kalshiTotal = payload.data.find((event) => event.eventId === events[5].id);
      const exactScore = payload.data.find((event) => event.eventId === events[9].id);
      const totalCorners = payload.data.find((event) => event.eventId === events[10].id);
      const playerProps = payload.data.find((event) => event.eventId === events[11].id);
      assert.equal(polymarketMatch?.fifa.groupKey, "match:2026-06-30:united-states:paraguay");
      assert.equal(kalshiTotal?.fifa.groupKey, polymarketMatch?.fifa.groupKey);
      assert.equal(kalshiTotal?.markets[0]?.fifa.subtype, "total");
      assert.equal(
        totalCorners?.fifa.groupKey,
        "match:2026-06-30:united-states:paraguay-total-corners",
      );
      for (const event of [
        polymarketMatch,
        kalshiTotal,
        exactScore,
        totalCorners,
        playerProps,
      ]) {
        assert.equal(event?.fifa.matchFixtureKey, fixtureKey);
        assert.equal(event?.fifa.fixture?.providerFixtureId, fixtureProviderId);
        assert.equal(event?.fifa.fixture?.localDate, "2026-06-30");
        assert.ok(
          event?.markets.every((market) => market.fifa.matchFixtureKey === fixtureKey),
        );
      }
      assert.equal(polymarketMatch?.fifa.fixture?.homeTeam, "USA");
      assert.equal(kalshiTotal?.fifa.fixture?.awayTeam, "Paraguay");
      assert.equal(polymarketMatch?.fifa.fixture?.venue, "SoFi Stadium");
      assert.ok(
        polymarketMatch?.markets.some(
          (market) =>
            market.fifa.teamName === "USA" && market.fifa.teamGroupCode === "D",
        ),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: suffix, section: "match_prop", venue: "kalshi" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; markets: Array<{ fifa: { subtype: string | null } }> }>;
      }>();
      const spread = payload.data.find((event) => event.eventId === events[17].id);
      const firstHalf = payload.data.find((event) => event.eventId === events[18].id);
      assert.equal(spread?.markets[0]?.fifa.subtype, "spread");
      assert.equal(firstHalf?.markets[0]?.fifa.subtype, "first_half");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: suffix, section: "player_award" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; markets: Array<{ fifa: { section: string | null; subtype: string | null } }> }>;
      }>();
      const award = payload.data.find((event) => event.eventId === events[19].id);
      assert.equal(award?.markets[0]?.fifa.section, "player_award");
      assert.equal(award?.markets[0]?.fifa.subtype, "player_award_entity");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", limit: 50, q: suffix, section: "match_result", venue: "kalshi" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; markets: Array<{ fifa: { subtype: string | null; entity: string | null } }> }>;
      }>();
      const tie = payload.data.find((event) => event.eventId === events[20].id);
      assert.equal(tie?.markets[0]?.fifa.subtype, "draw");
      assert.equal(tie?.markets[0]?.fifa.entity, "Draw");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ limit: 50, q: suffix, section: "special", venue: "kalshi" })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        data: Array<{ eventId: string; fifa: { matchFixtureKey: string | null; matchDate: string | null } }>;
      }>();
      const special = payload.data.find((event) => event.eventId === events[6].id);
      assert.equal(special?.fifa.matchFixtureKey, null);
      assert.equal(special?.fifa.matchDate, null);
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/special/fifa-2026?${query({ view: "markets", q: suffix, section: "match_prop", sort: "time", limit: 10 })}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        count: number;
        data: Array<{
          markets: Array<{
            fifa: {
              section: string;
              subtype: string | null;
              line: number | null;
              matchFixtureKey: string | null;
            };
          }>;
        }>;
      }>();
      assert.ok(payload.count >= 3);
      const sections = payload.data.flatMap((event) =>
        event.markets.map((market) => market.fifa.section),
      );
      assert.deepEqual(new Set(sections), new Set(["match_prop"]));
      assert.ok(
        payload.data.every((event) =>
          event.markets.every((market) => market.fifa.matchFixtureKey === fixtureKey),
        ),
      );
      assert.ok(
        payload.data.some((event) =>
          event.markets.some((market) => market.fifa.subtype === "total"),
        ),
      );
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/events/${encodeURIComponent(events[0].id)}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        sportsFixture: {
          providerFixtureId: string;
          homeTeam: string | null;
          awayTeam: string | null;
          localDate: string | null;
        } | null;
      }>();
      assert.equal(payload.sportsFixture?.providerFixtureId, fixtureProviderId);
      assert.equal(payload.sportsFixture?.homeTeam, "USA");
      assert.equal(payload.sportsFixture?.awayTeam, "Paraguay");
      assert.equal(payload.sportsFixture?.localDate, "2026-06-30");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/events/${encodeURIComponent(events[10].id)}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        sportsFixture: {
          providerFixtureId: string;
          localDate: string | null;
        } | null;
      }>();
      assert.equal(payload.sportsFixture?.providerFixtureId, fixtureProviderId);
      assert.equal(payload.sportsFixture?.localDate, "2026-06-30");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/markets/${encodeURIComponent(markets[0].id)}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        event: {
          sportsFixture: {
            providerFixtureId: string;
            homeTeam: string | null;
            awayTeam: string | null;
            localDate: string | null;
          } | null;
        };
      }>();
      assert.equal(payload.event.sportsFixture?.providerFixtureId, fixtureProviderId);
      assert.equal(payload.event.sportsFixture?.homeTeam, "USA");
      assert.equal(payload.event.sportsFixture?.awayTeam, "Paraguay");
      assert.equal(payload.event.sportsFixture?.localDate, "2026-06-30");
    }

    {
      const response = await app.inject({
        method: "GET",
        url: `/markets/${encodeURIComponent(markets[10].id)}`,
      });
      assert.equal(response.statusCode, 200, response.body);
      const payload = response.json<{
        event: {
          sportsFixture: {
            providerFixtureId: string;
            localDate: string | null;
          } | null;
        };
      }>();
      assert.equal(payload.event.sportsFixture?.providerFixtureId, fixtureProviderId);
      assert.equal(payload.event.sportsFixture?.localDate, "2026-06-30");
    }
  } finally {
    env.feedTtlSec = previousFeedTtl;
    await pool.query(
      "delete from sports_fixtures where provider = 'thesportsdb' and provider_fixture_id = $1",
      [fixtureProviderId],
    );
    if (marketIds.length) {
      await pool.query("delete from unified_markets where id = any($1::text[])", [
        marketIds,
      ]);
    }
    if (eventIds.length) {
      await pool.query("delete from unified_events where id = any($1::text[])", [
        eventIds,
      ]);
    }
    await app.close();
  }
}

await main();
