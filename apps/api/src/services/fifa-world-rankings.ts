import { FIFA_2026_GROUPS } from "./fifa-special.js";
import { canonicalSportsTeamKey } from "./sports-fixture-keys.js";

export const FIFA_WORLD_RANKING_SOURCE_NAME =
  "FIFA/Coca-Cola Men's World Ranking";
export const FIFA_WORLD_RANKING_SOURCE_URL =
  "https://inside.fifa.com/fifa-world-ranking/men";
export const FIFA_WORLD_RANKING_ROWS_URL =
  "https://api.fifa.com/api/v3/rankings?gender=1&count=250";

export const FIFA_2026_TEAMS_RANKING_CACHE_KEY =
  "special:fifa-2026:teams-rankings:v1";
export const FIFA_2026_TEAMS_RANKING_STALE_CACHE_KEY =
  "special:fifa-2026:teams-rankings:v1:stale";
export const FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY =
  "special:fifa-2026:teams-rankings:v1:refresh";

export const FIFA_2026_TEAMS_RANKING_FRESH_TTL_SEC = 24 * 60 * 60;
export const FIFA_2026_TEAMS_RANKING_STALE_TTL_SEC = 30 * 24 * 60 * 60;
export const FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_TTL_SEC = 5 * 60;
export const FIFA_2026_TEAMS_RANKING_REFRESH_AHEAD_SEC = 60 * 60;
export const FIFA_2026_TEAMS_RANKING_HTTP_HIT_MAX_AGE_SEC = 5 * 60;
export const FIFA_2026_TEAMS_RANKING_HTTP_HIT_STALE_SEC = 15 * 60;
export const FIFA_2026_TEAMS_RANKING_HTTP_FALLBACK_MAX_AGE_SEC = 60;
export const FIFA_2026_TEAMS_RANKING_HTTP_FALLBACK_STALE_SEC = 5 * 60;

export type FifaRankingCacheStatus =
  | "hit"
  | "stale"
  | "fallback"
  | "refreshing"
  | "disabled";

export type FifaWorldRanking = {
  rank: number;
  points: number;
  previousRank: number;
  rankChange: number;
};

export type Fifa2026TeamRanking = {
  countryKey: string;
  teamName: string;
  fifaTeamName: string;
  groupCode: string;
  worldRanking: FifaWorldRanking | null;
};

export type Fifa2026TeamsRankingPayload = {
  ok: true;
  special: "fifa_2026";
  source: {
    name: typeof FIFA_WORLD_RANKING_SOURCE_NAME;
    url: typeof FIFA_WORLD_RANKING_SOURCE_URL;
    lastOfficialUpdate: string;
    nextOfficialUpdate: string;
    fetchedAt: string;
    cacheStatus: FifaRankingCacheStatus;
  };
  teams: Fifa2026TeamRanking[];
};

export type NormalizedFifaRankingRow = {
  fifaTeamName: string;
  rank: number;
  points: number;
  previousRank: number;
};

export type FifaRankingRedis = {
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
  set(
    key: string,
    value: string,
    options: { EX: number; NX?: boolean },
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

type LogLike = {
  warn(input: unknown, message?: string): void;
};

type FetchLike = typeof fetch;

type OfficialFifaSourceMetadata = {
  lastOfficialUpdate: string;
  nextOfficialUpdate: string;
};

type FifaTeamSeedRanking = {
  teamName: string;
  fifaTeamName: string;
  rank: number;
  points: number;
  previousRank: number;
};

export const FIFA_2026_RANKING_FALLBACK_ROWS: readonly FifaTeamSeedRanking[] = [
  {
    teamName: "Mexico",
    fifaTeamName: "Mexico",
    rank: 14,
    points: 1687.48,
    previousRank: 15,
  },
  {
    teamName: "South Korea",
    fifaTeamName: "Korea Republic",
    rank: 25,
    points: 1591.63,
    previousRank: 25,
  },
  {
    teamName: "South Africa",
    fifaTeamName: "South Africa",
    rank: 60,
    points: 1428.38,
    previousRank: 60,
  },
  {
    teamName: "Czechia",
    fifaTeamName: "Czechia",
    rank: 40,
    points: 1505.74,
    previousRank: 41,
  },
  {
    teamName: "Canada",
    fifaTeamName: "Canada",
    rank: 30,
    points: 1559.48,
    previousRank: 30,
  },
  {
    teamName: "Qatar",
    fifaTeamName: "Qatar",
    rank: 56,
    points: 1450.31,
    previousRank: 55,
  },
  {
    teamName: "Bosnia and Herzegovina",
    fifaTeamName: "Bosnia and Herzegovina",
    rank: 64,
    points: 1387.22,
    previousRank: 65,
  },
  {
    teamName: "Switzerland",
    fifaTeamName: "Switzerland",
    rank: 19,
    points: 1650.06,
    previousRank: 19,
  },
  {
    teamName: "Scotland",
    fifaTeamName: "Scotland",
    rank: 42,
    points: 1503.34,
    previousRank: 43,
  },
  {
    teamName: "Brazil",
    fifaTeamName: "Brazil",
    rank: 6,
    points: 1765.86,
    previousRank: 6,
  },
  {
    teamName: "Haiti",
    fifaTeamName: "Haiti",
    rank: 83,
    points: 1293.1,
    previousRank: 83,
  },
  {
    teamName: "Morocco",
    fifaTeamName: "Morocco",
    rank: 7,
    points: 1755.1,
    previousRank: 8,
  },
  {
    teamName: "Paraguay",
    fifaTeamName: "Paraguay",
    rank: 41,
    points: 1505.35,
    previousRank: 40,
  },
  {
    teamName: "Turkiye",
    fifaTeamName: "Türkiye",
    rank: 22,
    points: 1605.73,
    previousRank: 22,
  },
  {
    teamName: "USA",
    fifaTeamName: "USA",
    rank: 17,
    points: 1671.23,
    previousRank: 16,
  },
  {
    teamName: "Australia",
    fifaTeamName: "Australia",
    rank: 27,
    points: 1579.34,
    previousRank: 27,
  },
  {
    teamName: "Curacao",
    fifaTeamName: "Curaçao",
    rank: 82,
    points: 1294.77,
    previousRank: 82,
  },
  {
    teamName: "Ecuador",
    fifaTeamName: "Ecuador",
    rank: 23,
    points: 1598.52,
    previousRank: 23,
  },
  {
    teamName: "Germany",
    fifaTeamName: "Germany",
    rank: 10,
    points: 1735.77,
    previousRank: 10,
  },
  {
    teamName: "Ivory Coast",
    fifaTeamName: "Côte d'Ivoire",
    rank: 33,
    points: 1540.87,
    previousRank: 34,
  },
  {
    teamName: "Tunisia",
    fifaTeamName: "Tunisia",
    rank: 45,
    points: 1476.41,
    previousRank: 44,
  },
  {
    teamName: "Japan",
    fifaTeamName: "Japan",
    rank: 18,
    points: 1661.58,
    previousRank: 18,
  },
  {
    teamName: "Netherlands",
    fifaTeamName: "Netherlands",
    rank: 8,
    points: 1753.57,
    previousRank: 7,
  },
  {
    teamName: "Sweden",
    fifaTeamName: "Sweden",
    rank: 38,
    points: 1509.79,
    previousRank: 38,
  },
  {
    teamName: "New Zealand",
    fifaTeamName: "New Zealand",
    rank: 85,
    points: 1275.58,
    previousRank: 85,
  },
  {
    teamName: "Iran",
    fifaTeamName: "IR Iran",
    rank: 20,
    points: 1619.58,
    previousRank: 21,
  },
  {
    teamName: "Egypt",
    fifaTeamName: "Egypt",
    rank: 29,
    points: 1562.37,
    previousRank: 29,
  },
  {
    teamName: "Belgium",
    fifaTeamName: "Belgium",
    rank: 9,
    points: 1742.24,
    previousRank: 9,
  },
  {
    teamName: "Cape Verde",
    fifaTeamName: "Cabo Verde",
    rank: 67,
    points: 1371.11,
    previousRank: 69,
  },
  {
    teamName: "Uruguay",
    fifaTeamName: "Uruguay",
    rank: 16,
    points: 1673.07,
    previousRank: 17,
  },
  {
    teamName: "Spain",
    fifaTeamName: "Spain",
    rank: 2,
    points: 1874.71,
    previousRank: 2,
  },
  {
    teamName: "Saudi Arabia",
    fifaTeamName: "Saudi Arabia",
    rank: 61,
    points: 1423.88,
    previousRank: 61,
  },
  {
    teamName: "Senegal",
    fifaTeamName: "Senegal",
    rank: 15,
    points: 1684.07,
    previousRank: 14,
  },
  {
    teamName: "Norway",
    fifaTeamName: "Norway",
    rank: 31,
    points: 1557.44,
    previousRank: 31,
  },
  {
    teamName: "France",
    fifaTeamName: "France",
    rank: 3,
    points: 1870.7,
    previousRank: 1,
  },
  {
    teamName: "Iraq",
    fifaTeamName: "Iraq",
    rank: 57,
    points: 1446.28,
    previousRank: 57,
  },
  {
    teamName: "Algeria",
    fifaTeamName: "Algeria",
    rank: 28,
    points: 1571.03,
    previousRank: 28,
  },
  {
    teamName: "Jordan",
    fifaTeamName: "Jordan",
    rank: 63,
    points: 1387.74,
    previousRank: 63,
  },
  {
    teamName: "Argentina",
    fifaTeamName: "Argentina",
    rank: 1,
    points: 1877.27,
    previousRank: 3,
  },
  {
    teamName: "Austria",
    fifaTeamName: "Austria",
    rank: 24,
    points: 1597.4,
    previousRank: 24,
  },
  {
    teamName: "Colombia",
    fifaTeamName: "Colombia",
    rank: 13,
    points: 1698.35,
    previousRank: 13,
  },
  {
    teamName: "Congo DR",
    fifaTeamName: "Congo DR",
    rank: 46,
    points: 1474.43,
    previousRank: 46,
  },
  {
    teamName: "Portugal",
    fifaTeamName: "Portugal",
    rank: 5,
    points: 1767.85,
    previousRank: 5,
  },
  {
    teamName: "Uzbekistan",
    fifaTeamName: "Uzbekistan",
    rank: 50,
    points: 1458.73,
    previousRank: 50,
  },
  {
    teamName: "England",
    fifaTeamName: "England",
    rank: 4,
    points: 1828.02,
    previousRank: 4,
  },
  {
    teamName: "Ghana",
    fifaTeamName: "Ghana",
    rank: 73,
    points: 1346.88,
    previousRank: 74,
  },
  {
    teamName: "Croatia",
    fifaTeamName: "Croatia",
    rank: 11,
    points: 1714.87,
    previousRank: 11,
  },
  {
    teamName: "Panama",
    fifaTeamName: "Panama",
    rank: 34,
    points: 1539.16,
    previousRank: 33,
  },
] as const;

const BUNDLED_FALLBACK_SOURCE = {
  lastOfficialUpdate: "2026-06-11",
  nextOfficialUpdate: "2026-07-20",
  fetchedAt: "2026-06-19T00:00:00.000Z",
};

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function readLocalizedName(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return null;
  const entries = value.filter(
    (entry): entry is { Locale?: unknown; Description?: unknown } =>
      entry != null && typeof entry === "object",
  );
  const preferred =
    entries.find((entry) => entry.Locale === "en-GB") ??
    entries.find((entry) => entry.Locale === "en") ??
    entries[0];
  return typeof preferred?.Description === "string" &&
    preferred.Description.trim()
    ? preferred.Description.trim()
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readNestedRecord(
  value: Record<string, unknown> | null,
  keys: string[],
): Record<string, unknown> | null {
  let current: Record<string, unknown> | null = value;
  for (const key of keys) {
    current = readRecord(current?.[key]);
    if (!current) return null;
  }
  return current;
}

export function fifa2026CountryKey(teamName: string): string {
  const canonical = canonicalSportsTeamKey(teamName);
  if (canonical === "united-states") return "usa";
  return canonical.replace(/-/g, " ");
}

export function listFifa2026Teams(): Fifa2026TeamRanking[] {
  return Object.entries(FIFA_2026_GROUPS).flatMap(([groupCode, teams]) =>
    teams.map((teamName) => ({
      countryKey: fifa2026CountryKey(teamName),
      teamName,
      fifaTeamName: teamName,
      groupCode,
      worldRanking: null,
    })),
  );
}

export function parseOfficialFifaPageMetadata(
  html: string,
): OfficialFifaSourceMetadata {
  const nextDataMatch = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
  );
  if (!nextDataMatch) {
    throw new Error("FIFA ranking page metadata missing __NEXT_DATA__");
  }
  const nextData = JSON.parse(
    decodeBasicHtmlEntities(nextDataMatch[1]),
  ) as unknown;
  const ranking = readNestedRecord(readRecord(nextData), [
    "props",
    "pageProps",
    "pageData",
    "ranking",
  ]);
  const lastOfficialUpdate = dateOnly(ranking?.lastUpdateDate);
  const nextOfficialUpdate = dateOnly(ranking?.nextUpdateDate);
  if (!lastOfficialUpdate || !nextOfficialUpdate) {
    throw new Error("FIFA ranking page metadata missing update dates");
  }
  return { lastOfficialUpdate, nextOfficialUpdate };
}

export function parseOfficialFifaRankingRowsPayload(
  payload: unknown,
): NormalizedFifaRankingRow[] {
  const record = readRecord(payload);
  const rawRows = Array.isArray(record?.Results)
    ? record.Results
    : Array.isArray(record?.rankings)
      ? record.rankings
      : null;
  if (!rawRows) {
    throw new Error("FIFA ranking rows payload missing rows");
  }

  return rawRows
    .map((row): NormalizedFifaRankingRow | null => {
      const item = readRecord(row);
      if (!item) return null;
      const fifaTeamName =
        readLocalizedName(item.TeamName) ?? readLocalizedName(item.teamName);
      const rank = finiteNumber(item.Rank ?? item.rank);
      const points = finiteNumber(
        item.DecimalTotalPoints ?? item.totalPoints ?? item.TotalPoints,
      );
      const previousRank =
        finiteNumber(item.PrevRank ?? item.previousRank) ?? rank;
      if (!fifaTeamName || !rank || points == null || !previousRank)
        return null;
      return {
        fifaTeamName,
        rank,
        points,
        previousRank,
      };
    })
    .filter((row): row is NormalizedFifaRankingRow => row != null);
}

function buildRankingRowByTeamKey(
  rows: readonly NormalizedFifaRankingRow[],
): Map<string, NormalizedFifaRankingRow> {
  const byKey = new Map<string, NormalizedFifaRankingRow>();
  for (const row of rows) {
    byKey.set(canonicalSportsTeamKey(row.fifaTeamName), row);
  }
  return byKey;
}

export function buildFifa2026TeamsRankingPayload(input: {
  rows: readonly NormalizedFifaRankingRow[];
  source: {
    lastOfficialUpdate: string;
    nextOfficialUpdate: string;
    fetchedAt: string;
  };
  cacheStatus: FifaRankingCacheStatus;
}): Fifa2026TeamsRankingPayload {
  const byKey = buildRankingRowByTeamKey(input.rows);
  const missingTeams: string[] = [];
  const teams = listFifa2026Teams().map((team) => {
    const rankingRow = byKey.get(canonicalSportsTeamKey(team.teamName));
    if (!rankingRow) {
      missingTeams.push(team.teamName);
      return team;
    }
    return {
      ...team,
      fifaTeamName: rankingRow.fifaTeamName,
      worldRanking: {
        rank: rankingRow.rank,
        points: rankingRow.points,
        previousRank: rankingRow.previousRank,
        rankChange: rankingRow.previousRank - rankingRow.rank,
      },
    };
  });

  if (missingTeams.length > 0) {
    throw new Error(
      `FIFA ranking snapshot did not match all 48 teams: ${missingTeams.join(", ")}`,
    );
  }

  return {
    ok: true,
    special: "fifa_2026",
    source: {
      name: FIFA_WORLD_RANKING_SOURCE_NAME,
      url: FIFA_WORLD_RANKING_SOURCE_URL,
      lastOfficialUpdate: input.source.lastOfficialUpdate,
      nextOfficialUpdate: input.source.nextOfficialUpdate,
      fetchedAt: input.source.fetchedAt,
      cacheStatus: input.cacheStatus,
    },
    teams,
  };
}

export function buildBundledFifa2026TeamsRankingPayload(
  cacheStatus: FifaRankingCacheStatus = "fallback",
): Fifa2026TeamsRankingPayload {
  return buildFifa2026TeamsRankingPayload({
    rows: FIFA_2026_RANKING_FALLBACK_ROWS.map((row) => ({
      fifaTeamName: row.fifaTeamName,
      rank: row.rank,
      points: row.points,
      previousRank: row.previousRank,
    })),
    source: BUNDLED_FALLBACK_SOURCE,
    cacheStatus,
  });
}

function withCacheStatus(
  payload: Fifa2026TeamsRankingPayload,
  cacheStatus: FifaRankingCacheStatus,
): Fifa2026TeamsRankingPayload {
  return {
    ...payload,
    source: {
      ...payload.source,
      cacheStatus,
    },
  };
}

function parseCachedPayload(
  raw: string | null,
): Fifa2026TeamsRankingPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Fifa2026TeamsRankingPayload;
    if (
      parsed?.ok === true &&
      parsed.special === "fifa_2026" &&
      Array.isArray(parsed.teams) &&
      parsed.teams.length === 48 &&
      parsed.teams.every((team) => team.worldRanking?.rank != null)
    ) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

export function getFifa2026TeamsRankingCacheControl(
  cacheStatus: FifaRankingCacheStatus,
): string {
  const maxAge =
    cacheStatus === "hit"
      ? FIFA_2026_TEAMS_RANKING_HTTP_HIT_MAX_AGE_SEC
      : FIFA_2026_TEAMS_RANKING_HTTP_FALLBACK_MAX_AGE_SEC;
  const staleWindow =
    cacheStatus === "hit"
      ? FIFA_2026_TEAMS_RANKING_HTTP_HIT_STALE_SEC
      : FIFA_2026_TEAMS_RANKING_HTTP_FALLBACK_STALE_SEC;
  return `public, max-age=${maxAge}, stale-while-revalidate=${staleWindow}`;
}

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
    },
  });
  if (!response.ok) {
    throw new Error(`FIFA ranking request failed: ${response.status}`);
  }
  return response.json();
}

async function fetchText(fetchImpl: FetchLike, url: string): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0",
    },
  });
  if (!response.ok) {
    throw new Error(`FIFA ranking metadata request failed: ${response.status}`);
  }
  return response.text();
}

export async function fetchOfficialFifa2026TeamsRankingPayload(
  fetchImpl: FetchLike = fetch,
): Promise<Fifa2026TeamsRankingPayload> {
  const [metadataHtml, rowsPayload] = await Promise.all([
    fetchText(fetchImpl, FIFA_WORLD_RANKING_SOURCE_URL),
    fetchJson(fetchImpl, FIFA_WORLD_RANKING_ROWS_URL),
  ]);
  const metadata = parseOfficialFifaPageMetadata(metadataHtml);
  const rows = parseOfficialFifaRankingRowsPayload(rowsPayload);
  return buildFifa2026TeamsRankingPayload({
    rows,
    source: {
      ...metadata,
      fetchedAt: new Date().toISOString(),
    },
    cacheStatus: "hit",
  });
}

async function storeRankingPayload(
  redis: FifaRankingRedis,
  payload: Fifa2026TeamsRankingPayload,
): Promise<void> {
  const body = JSON.stringify(payload);
  await Promise.all([
    redis.set(FIFA_2026_TEAMS_RANKING_CACHE_KEY, body, {
      EX: FIFA_2026_TEAMS_RANKING_FRESH_TTL_SEC,
    }),
    redis.set(FIFA_2026_TEAMS_RANKING_STALE_CACHE_KEY, body, {
      EX: FIFA_2026_TEAMS_RANKING_STALE_TTL_SEC,
    }),
  ]);
}

async function refreshRankingCache(input: {
  redis: FifaRankingRedis;
  fetchImpl: FetchLike;
  log?: LogLike;
}): Promise<void> {
  try {
    const payload = await fetchOfficialFifa2026TeamsRankingPayload(
      input.fetchImpl,
    );
    await storeRankingPayload(input.redis, payload);
  } catch (error) {
    input.log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "FIFA 2026 team ranking refresh failed",
    );
  } finally {
    await input.redis
      .del(FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY)
      .catch(() => undefined);
  }
}

async function startRankingRefresh(input: {
  redis: FifaRankingRedis;
  fetchImpl: FetchLike;
  log?: LogLike;
  background?: (task: Promise<void>) => void;
}): Promise<boolean> {
  const locked = await input.redis.set(
    FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_KEY,
    "1",
    {
      NX: true,
      EX: FIFA_2026_TEAMS_RANKING_REFRESH_LOCK_TTL_SEC,
    },
  );
  if (!locked) return false;
  const task = refreshRankingCache({
    redis: input.redis,
    fetchImpl: input.fetchImpl,
    log: input.log,
  });
  if (input.background) {
    input.background(task);
  } else {
    void task;
  }
  return true;
}

async function refreshFreshCacheAheadIfNeeded(input: {
  redis: FifaRankingRedis;
  fetchImpl: FetchLike;
  log?: LogLike;
  background?: (task: Promise<void>) => void;
}): Promise<void> {
  let ttl: number;
  try {
    ttl = await input.redis.ttl(FIFA_2026_TEAMS_RANKING_CACHE_KEY);
  } catch (error) {
    input.log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "FIFA 2026 team ranking fresh cache ttl read failed",
    );
    return;
  }

  if (ttl > FIFA_2026_TEAMS_RANKING_REFRESH_AHEAD_SEC) return;

  await startRankingRefresh({
    redis: input.redis,
    fetchImpl: input.fetchImpl,
    log: input.log,
    background: input.background,
  }).catch((error) => {
    input.log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "FIFA 2026 team ranking refresh-ahead lock failed",
    );
  });
}

export async function getFifa2026TeamsRankingPayload(input: {
  redis: FifaRankingRedis | null;
  redisStatus: "disabled" | "ready" | "loading" | "error";
  fetchImpl?: FetchLike;
  log?: LogLike;
  background?: (task: Promise<void>) => void;
}): Promise<Fifa2026TeamsRankingPayload> {
  const fetchImpl = input.fetchImpl ?? fetch;
  if (!input.redis) {
    return buildBundledFifa2026TeamsRankingPayload("disabled");
  }

  try {
    const fresh = parseCachedPayload(
      await input.redis.get(FIFA_2026_TEAMS_RANKING_CACHE_KEY),
    );
    if (fresh) {
      await refreshFreshCacheAheadIfNeeded({
        redis: input.redis,
        fetchImpl,
        log: input.log,
        background: input.background,
      });
      return withCacheStatus(fresh, "hit");
    }
  } catch (error) {
    input.log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "FIFA 2026 team ranking fresh cache read failed",
    );
  }

  try {
    const stale = parseCachedPayload(
      await input.redis.get(FIFA_2026_TEAMS_RANKING_STALE_CACHE_KEY),
    );
    if (stale) {
      const refreshing = !(await startRankingRefresh({
        redis: input.redis,
        fetchImpl,
        log: input.log,
        background: input.background,
      }));
      return withCacheStatus(stale, refreshing ? "refreshing" : "stale");
    }
  } catch (error) {
    input.log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "FIFA 2026 team ranking stale cache read failed",
    );
  }

  await startRankingRefresh({
    redis: input.redis,
    fetchImpl,
    log: input.log,
    background: input.background,
  }).catch((error) => {
    input.log?.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "FIFA 2026 team ranking refresh lock failed",
    );
  });

  return buildBundledFifa2026TeamsRankingPayload(
    input.redisStatus === "ready" ? "fallback" : "disabled",
  );
}

export function fifaRankingRowsForTestFromFallback(): NormalizedFifaRankingRow[] {
  return FIFA_2026_RANKING_FALLBACK_ROWS.map((row) => ({
    fifaTeamName: row.fifaTeamName,
    rank: row.rank,
    points: row.points,
    previousRank: row.previousRank,
  }));
}
