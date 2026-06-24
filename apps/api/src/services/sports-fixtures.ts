import type { Pool } from "@hunch/infra";
import { env } from "../env.js";
import {
  buildMatchFixtureKey,
  canonicalSportsTeamKey,
  parseSportsMatchTeamsFromTitle,
  slugifySportsKey,
} from "./sports-fixture-keys.js";

export type SportsFixtureProviderName = "thesportsdb";

export type SportsCompetitionConfig = {
  sport: string;
  competitionKey: string;
  season: string;
  provider: SportsFixtureProviderName;
  theSportsDbLeagueId: string;
};

export type NormalizedSportsFixture = {
  sport: string;
  competitionKey: string;
  season: string;
  fixtureKey: string;
  provider: SportsFixtureProviderName;
  providerFixtureId: string;
  status: string | null;
  kickoffUtc: string | null;
  localDate: string | null;
  localTime: string | null;
  stage: string | null;
  groupName: string | null;
  homeTeamKey: string | null;
  homeTeamName: string | null;
  awayTeamKey: string | null;
  awayTeamName: string | null;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
  city: string | null;
  country: string | null;
  homeBadgeUrl: string | null;
  awayBadgeUrl: string | null;
  sourceUpdatedAt: string | null;
  fetchedAt: string;
  raw: Record<string, unknown>;
};

export type SportsFixtureRow = {
  sport: string;
  competition_key: string;
  season: string;
  fixture_key: string;
  provider: string;
  provider_fixture_id: string;
  status: string | null;
  kickoff_utc: string | Date | null;
  local_date: string | Date | null;
  local_time: string | null;
  stage: string | null;
  group_name: string | null;
  home_team_key: string | null;
  home_team_name: string | null;
  away_team_key: string | null;
  away_team_name: string | null;
  home_score: number | null;
  away_score: number | null;
  venue: string | null;
  city: string | null;
  country: string | null;
  home_badge_url: string | null;
  away_badge_url: string | null;
  fetched_at: string | Date;
};

export type SportsFixtureApi = {
  provider: string;
  providerFixtureId: string;
  status: string | null;
  kickoffUtc: string | null;
  localDate: string | null;
  localTime: string | null;
  stage: string | null;
  groupName: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  homeScore: number | null;
  awayScore: number | null;
  venue: string | null;
  city: string | null;
  country: string | null;
  homeBadgeUrl: string | null;
  awayBadgeUrl: string | null;
  fetchedAt: string;
};

export type SportsFixtureProvider = {
  fetchCompetitionSeason: (
    competition: SportsCompetitionConfig,
  ) => Promise<NormalizedSportsFixture[]>;
  searchFixture: (
    competition: SportsCompetitionConfig,
    fixtureKey: string,
  ) => Promise<NormalizedSportsFixture[]>;
};

export type SportsFixtureRefreshResult = {
  provider: SportsFixtureProviderName;
  sport: string;
  competitionKey: string;
  season: string;
  fetched: number;
  upserted: number;
  dryRun: boolean;
};

type TheSportsDbEvent = Record<string, unknown>;

type RedisLockClient = {
  set: (
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ) => Promise<string | null>;
};

const FIFA_2026: SportsCompetitionConfig = {
  sport: "soccer",
  competitionKey: "fifa_world_cup",
  season: "2026",
  provider: "thesportsdb",
  theSportsDbLeagueId: "4429",
};

const SEARCH_TEAM_ALIASES: Record<string, string[]> = {
  "bosnia-and-herzegovina": ["Bosnia-Herzegovina", "Bosnia and Herzegovina"],
  "cape-verde": ["Cape Verde", "Cabo Verde"],
  "congo-dr": ["DR Congo", "Congo DR"],
  curacao: ["Curacao", "Curaçao"],
  czechia: ["Czech Republic", "Czechia"],
  iran: ["Iran", "IR Iran"],
  "ivory-coast": ["Ivory Coast", "Côte d'Ivoire", "Cote d'Ivoire"],
  "south-korea": ["South Korea", "Korea Republic", "Republic of Korea"],
  turkiye: ["Turkey", "Turkiye", "Türkiye"],
  "united-states": ["USA", "United States"],
};

const MONTHS: Record<string, string> = {
  JAN: "01",
  FEB: "02",
  MAR: "03",
  APR: "04",
  MAY: "05",
  JUN: "06",
  JUL: "07",
  AUG: "08",
  SEP: "09",
  OCT: "10",
  NOV: "11",
  DEC: "12",
};

const THESPORTSDB_TIMEOUT_MS = 10_000;
const THESPORTSDB_FIXTURE_SEARCH_QUERY_LIMIT = 8;

export function resolveSportsCompetition(input: {
  sport: string;
  competitionKey: string;
  season: string;
}): SportsCompetitionConfig {
  if (
    input.sport === FIFA_2026.sport &&
    input.competitionKey === FIFA_2026.competitionKey &&
    input.season === FIFA_2026.season
  ) {
    return { ...FIFA_2026, provider: env.sportsFixturesProvider };
  }
  throw new Error(
    `unsupported sports fixture competition: ${input.sport}/${input.competitionKey}/${input.season}`,
  );
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asInt(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseKickoffUtc(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value.endsWith("Z") ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function eventLocalDate(event: TheSportsDbEvent, kickoffUtc: string | null): string | null {
  const localDate = asString(event.dateEventLocal);
  if (localDate) return localDate;
  const dateEvent = asString(event.dateEvent);
  if (dateEvent) return dateEvent;
  return kickoffUtc?.slice(0, 10) ?? null;
}

function parseFifaDateFromSlug(slug: string | null | undefined): string | null {
  return slug?.match(/(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
}

function parseFifaDateFromKalshiTicker(ticker: string | null | undefined): string | null {
  const match = ticker?.match(/-26([A-Z]{3})(\d{2})/);
  if (!match) return null;
  const month = MONTHS[match[1]];
  if (!month) return null;
  return `2026-${month}-${match[2]}`;
}

export function deriveFifa2026FixtureKeyFromEvent(input: {
  eventTitle: string | null | undefined;
  eventSlug?: string | null;
  venueEventId?: string | null;
}): string | null {
  const slug = input.eventSlug?.toLowerCase() ?? "";
  const venueEventId = input.venueEventId?.toUpperCase() ?? "";
  const title = input.eventTitle?.toLowerCase() ?? "";
  const isFifa2026 =
    slug.startsWith("fifwc-") ||
    venueEventId.startsWith("KXWC") ||
    venueEventId.startsWith("KXFIFA") ||
    title.includes("fifa world cup");
  if (!isFifa2026) return null;
  const localDate =
    parseFifaDateFromSlug(input.eventSlug) ??
    parseFifaDateFromKalshiTicker(input.venueEventId);
  if (!localDate) return null;
  const teams = parseSportsMatchTeamsFromTitle(input.eventTitle);
  if (!teams.homeTeam || !teams.awayTeam) return null;
  return buildMatchFixtureKey({
    localDate,
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
  });
}

export function normalizeTheSportsDbEvent(
  event: TheSportsDbEvent,
  competition: SportsCompetitionConfig = FIFA_2026,
  fetchedAt = new Date().toISOString(),
): NormalizedSportsFixture | null {
  const providerFixtureId = asString(event.idEvent);
  const homeTeamName = asString(event.strHomeTeam);
  const awayTeamName = asString(event.strAwayTeam);
  if (!providerFixtureId || !homeTeamName || !awayTeamName) return null;

  const kickoffUtc = parseKickoffUtc(asString(event.strTimestamp));
  const localDate = eventLocalDate(event, kickoffUtc);
  if (!localDate) return null;

  return {
    sport: competition.sport,
    competitionKey: competition.competitionKey,
    season: competition.season,
    fixtureKey: buildMatchFixtureKey({
      localDate,
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
    }),
    provider: competition.provider,
    providerFixtureId,
    status: asString(event.strStatus),
    kickoffUtc,
    localDate,
    localTime: asString(event.strTimeLocal) ?? asString(event.strTime),
    stage: asString(event.strRound),
    groupName: asString(event.strGroup),
    homeTeamKey: canonicalSportsTeamKey(homeTeamName),
    homeTeamName,
    awayTeamKey: canonicalSportsTeamKey(awayTeamName),
    awayTeamName,
    homeScore: asInt(event.intHomeScore),
    awayScore: asInt(event.intAwayScore),
    venue: asString(event.strVenue),
    city: asString(event.strCity),
    country: asString(event.strCountry),
    homeBadgeUrl: asString(event.strHomeTeamBadge),
    awayBadgeUrl: asString(event.strAwayTeamBadge),
    sourceUpdatedAt: null,
    fetchedAt,
    raw: event,
  };
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function humanizeTeamKey(key: string): string {
  return key
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function sportsFixtureSearchNameCandidates(teamKey: string): string[] {
  return dedupeStrings([
    ...(SEARCH_TEAM_ALIASES[teamKey] ?? []),
    humanizeTeamKey(teamKey),
  ]);
}

export function fixtureKeyToSearchQueries(fixtureKey: string): string[] {
  const parts = fixtureKey.split(":");
  if (parts.length !== 4 || parts[0] !== "match") return [];
  const [, , homeKey, awayKey] = parts;
  const homeCandidates = sportsFixtureSearchNameCandidates(homeKey);
  const awayCandidates = sportsFixtureSearchNameCandidates(awayKey);
  const queries: string[] = [];
  for (const home of homeCandidates) {
    for (const away of awayCandidates) {
      queries.push(`${home}_vs_${away}`.replace(/\s+/g, "_"));
    }
  }
  return dedupeStrings(queries).slice(0, THESPORTSDB_FIXTURE_SEARCH_QUERY_LIMIT);
}

async function fetchTheSportsDbJson(path: string, params: Record<string, string>) {
  const url = new URL(
    `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(env.theSportsDbApiKey)}/${path}`,
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(THESPORTSDB_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`TheSportsDB request failed: ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function normalizeEventsPayload(
  payload: Record<string, unknown>,
  competition: SportsCompetitionConfig,
): NormalizedSportsFixture[] {
  const rawEvents = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(payload.event)
      ? payload.event
      : [];
  return rawEvents
    .map((event) =>
      event && typeof event === "object"
        ? normalizeTheSportsDbEvent(event as TheSportsDbEvent, competition)
        : null,
    )
    .filter((fixture): fixture is NormalizedSportsFixture => fixture != null);
}

function dedupeFixturesByProviderId(
  fixtures: NormalizedSportsFixture[],
): NormalizedSportsFixture[] {
  const byProviderId = new Map<string, NormalizedSportsFixture>();
  for (const fixture of fixtures) {
    byProviderId.set(`${fixture.provider}:${fixture.providerFixtureId}`, fixture);
  }
  return Array.from(byProviderId.values());
}

async function fetchTheSportsDbEndpointFixtures(
  competition: SportsCompetitionConfig,
  path: string,
  params: Record<string, string>,
): Promise<NormalizedSportsFixture[]> {
  const payload = await fetchTheSportsDbJson(path, params);
  return normalizeEventsPayload(payload, competition);
}

async function fetchTheSportsDbOptionalEndpoints(
  endpoints: Array<{ path: string; params: Record<string, string> }>,
  competition: SportsCompetitionConfig,
): Promise<NormalizedSportsFixture[]> {
  const settled = await Promise.allSettled(
    endpoints.map((endpoint) =>
      fetchTheSportsDbEndpointFixtures(competition, endpoint.path, endpoint.params),
    ),
  );
  const fulfilled = settled.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (settled.some((result) => result.status === "fulfilled")) {
    return fulfilled;
  }
  const firstRejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  throw firstRejected?.reason ?? new Error("TheSportsDB fixture request failed");
}

function filterFixturesByKey(
  fixtures: NormalizedSportsFixture[],
  fixtureKey: string,
): NormalizedSportsFixture[] {
  return dedupeFixturesByProviderId(
    fixtures.filter((fixture) => fixture.fixtureKey === fixtureKey),
  );
}

export const theSportsDbProvider: SportsFixtureProvider = {
  async fetchCompetitionSeason(competition) {
    return dedupeFixturesByProviderId(
      await fetchTheSportsDbOptionalEndpoints(
        [
          {
            path: "eventsseason.php",
            params: {
              id: competition.theSportsDbLeagueId,
              s: competition.season,
            },
          },
          {
            path: "eventspastleague.php",
            params: { id: competition.theSportsDbLeagueId },
          },
          {
            path: "eventsnextleague.php",
            params: { id: competition.theSportsDbLeagueId },
          },
        ],
        competition,
      ),
    );
  },
  async searchFixture(competition, fixtureKey) {
    const queries = fixtureKeyToSearchQueries(fixtureKey);
    if (!queries.length) return [];

    for (const query of queries) {
      const fixtures = await fetchTheSportsDbEndpointFixtures(
        competition,
        "searchevents.php",
        {
          e: query,
          s: competition.season,
        },
      );
      const matched = filterFixturesByKey(fixtures, fixtureKey);
      if (matched.length > 0) return matched;
    }

    const leagueFixtures = await fetchTheSportsDbOptionalEndpoints(
      [
        {
          path: "eventspastleague.php",
          params: { id: competition.theSportsDbLeagueId },
        },
        {
          path: "eventsnextleague.php",
          params: { id: competition.theSportsDbLeagueId },
        },
      ],
      competition,
    );
    return filterFixturesByKey(leagueFixtures, fixtureKey);
  },
};

function resolveProvider(provider: SportsFixtureProviderName): SportsFixtureProvider {
  switch (provider) {
    case "thesportsdb":
      return theSportsDbProvider;
  }
}

export async function upsertSportsFixtures(
  pool: Pick<Pool, "query">,
  fixtures: NormalizedSportsFixture[],
): Promise<number> {
  let upserted = 0;
  for (const fixture of fixtures) {
    await pool.query(
      `
        insert into sports_fixtures (
          sport, competition_key, season, fixture_key, provider, provider_fixture_id,
          status, kickoff_utc, local_date, local_time, stage, group_name,
          home_team_key, home_team_name, away_team_key, away_team_name,
          home_score, away_score, venue, city, country, home_badge_url,
          away_badge_url, source_updated_at, fetched_at, raw, created_at, updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16,
          $17, $18, $19, $20, $21, $22,
          $23, $24, $25, $26::jsonb, now(), now()
        )
        on conflict (provider, provider_fixture_id) do update set
          sport = excluded.sport,
          competition_key = excluded.competition_key,
          season = excluded.season,
          fixture_key = excluded.fixture_key,
          status = excluded.status,
          kickoff_utc = excluded.kickoff_utc,
          local_date = excluded.local_date,
          local_time = excluded.local_time,
          stage = excluded.stage,
          group_name = excluded.group_name,
          home_team_key = excluded.home_team_key,
          home_team_name = excluded.home_team_name,
          away_team_key = excluded.away_team_key,
          away_team_name = excluded.away_team_name,
          home_score = excluded.home_score,
          away_score = excluded.away_score,
          venue = excluded.venue,
          city = excluded.city,
          country = excluded.country,
          home_badge_url = excluded.home_badge_url,
          away_badge_url = excluded.away_badge_url,
          source_updated_at = excluded.source_updated_at,
          fetched_at = excluded.fetched_at,
          raw = excluded.raw,
          updated_at = now()
      `,
      [
        fixture.sport,
        fixture.competitionKey,
        fixture.season,
        fixture.fixtureKey,
        fixture.provider,
        fixture.providerFixtureId,
        fixture.status,
        fixture.kickoffUtc,
        fixture.localDate,
        fixture.localTime,
        fixture.stage,
        fixture.groupName,
        fixture.homeTeamKey,
        fixture.homeTeamName,
        fixture.awayTeamKey,
        fixture.awayTeamName,
        fixture.homeScore,
        fixture.awayScore,
        fixture.venue,
        fixture.city,
        fixture.country,
        fixture.homeBadgeUrl,
        fixture.awayBadgeUrl,
        fixture.sourceUpdatedAt,
        fixture.fetchedAt,
        JSON.stringify(fixture.raw),
      ],
    );
    upserted += 1;
  }
  return upserted;
}

export async function fetchSportsFixturesByKeys(
  pool: Pick<Pool, "query">,
  input: {
    sport: string;
    competitionKey: string;
    season: string;
    fixtureKeys: string[];
  },
): Promise<Map<string, SportsFixtureRow>> {
  const uniqueKeys = Array.from(new Set(input.fixtureKeys)).filter(Boolean);
  if (!uniqueKeys.length) return new Map();
  try {
    const { rows } = await pool.query<SportsFixtureRow>(
      `
        select
          sport, competition_key, season, fixture_key, provider, provider_fixture_id,
          status, kickoff_utc, local_date::text as local_date, local_time, stage, group_name,
          home_team_key, home_team_name, away_team_key, away_team_name,
          home_score, away_score, venue, city, country, home_badge_url,
          away_badge_url, fetched_at
        from sports_fixtures
        where sport = $1
          and competition_key = $2
          and season = $3
          and fixture_key = any($4::text[])
      `,
      [input.sport, input.competitionKey, input.season, uniqueKeys],
    );
    return new Map(rows.map((row) => [row.fixture_key, row]));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "42P01"
    ) {
      return new Map();
    }
    throw error;
  }
}

export function formatSportsFixtureForApi(row: SportsFixtureRow): SportsFixtureApi {
  const toIsoTimestamp = (value: string | Date | null): string | null =>
    value instanceof Date ? value.toISOString() : value;
  const toDateOnly = (value: string | Date | null): string | null => {
    if (value == null) return null;
    if (value instanceof Date) {
      const year = value.getFullYear();
      const month = String(value.getMonth() + 1).padStart(2, "0");
      const day = String(value.getDate()).padStart(2, "0");
      return `${year}-${month}-${day}`;
    }
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    return match?.[0] ?? value;
  };
  return {
    provider: row.provider,
    providerFixtureId: row.provider_fixture_id,
    status: row.status,
    kickoffUtc: toIsoTimestamp(row.kickoff_utc),
    localDate: toDateOnly(row.local_date),
    localTime: row.local_time,
    stage: row.stage,
    groupName: row.group_name,
    homeTeam: row.home_team_name,
    awayTeam: row.away_team_name,
    homeScore: row.home_score,
    awayScore: row.away_score,
    venue: row.venue,
    city: row.city,
    country: row.country,
    homeBadgeUrl: row.home_badge_url,
    awayBadgeUrl: row.away_badge_url,
    fetchedAt: toIsoTimestamp(row.fetched_at) ?? "",
  };
}

export async function fetchFifa2026SportsFixtureForEvent(
  pool: Pick<Pool, "query">,
  input: {
    eventTitle: string | null | undefined;
    eventSlug?: string | null;
    venueEventId?: string | null;
  },
): Promise<{ fixtureKey: string | null; fixture: SportsFixtureApi | null }> {
  const fixtureKey = deriveFifa2026FixtureKeyFromEvent(input);
  if (!fixtureKey) return { fixtureKey: null, fixture: null };
  const fixtures = await fetchSportsFixturesByKeys(pool, {
    sport: "soccer",
    competitionKey: "fifa_world_cup",
    season: "2026",
    fixtureKeys: [fixtureKey],
  });
  const row = fixtures.get(fixtureKey);
  return {
    fixtureKey,
    fixture: row ? formatSportsFixtureForApi(row) : null,
  };
}

export async function refreshSportsFixtures(
  pool: Pick<Pool, "query">,
  input: {
    sport: string;
    competitionKey: string;
    season: string;
    fixtureKey?: string;
    dryRun?: boolean;
    provider?: SportsFixtureProvider;
  },
): Promise<SportsFixtureRefreshResult> {
  const competition = resolveSportsCompetition({
    sport: input.sport,
    competitionKey: input.competitionKey,
    season: input.season,
  });
  const provider = input.provider ?? resolveProvider(competition.provider);
  const fixtures = input.fixtureKey
    ? await provider.searchFixture(competition, input.fixtureKey)
    : await provider.fetchCompetitionSeason(competition);
  if (input.fixtureKey && fixtures.length === 0) {
    console.warn("[sports-fixtures] fixture refresh returned no rows", {
      provider: competition.provider,
      sport: competition.sport,
      competitionKey: competition.competitionKey,
      season: competition.season,
      fixtureKey: input.fixtureKey,
    });
  }
  const upserted = input.dryRun ? 0 : await upsertSportsFixtures(pool, fixtures);
  return {
    provider: competition.provider,
    sport: competition.sport,
    competitionKey: competition.competitionKey,
    season: competition.season,
    fetched: fixtures.length,
    upserted,
    dryRun: input.dryRun ?? false,
  };
}

export async function fillMissingSportsFixturesInBackground(input: {
  pool: Pick<Pool, "query">;
  redis: RedisLockClient | null;
  sport: string;
  competitionKey: string;
  season: string;
  fixtureKeys: string[];
}): Promise<void> {
  if (!input.redis || !input.fixtureKeys.length) return;
  const uniqueKeys = Array.from(new Set(input.fixtureKeys)).filter((key) =>
    key.startsWith("match:"),
  );
  for (const fixtureKey of uniqueKeys) {
    const redisKey = `sports-fixtures:fill:v1:${input.sport}:${input.competitionKey}:${input.season}:${slugifySportsKey(fixtureKey)}`;
    const locked = await input.redis.set(redisKey, "1", {
      NX: true,
      EX: env.sportsFixturesRefreshTtlSec,
    });
    if (locked !== "OK") continue;
    try {
      await refreshSportsFixtures(input.pool, {
        sport: input.sport,
        competitionKey: input.competitionKey,
        season: input.season,
        fixtureKey,
      });
    } catch (error) {
      console.warn("[sports-fixtures] background fill failed", {
        fixtureKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
