import type { Pool } from "@hunch/infra";
import type { QueryResultRow } from "pg";
import {
  buildBroadOrderableMarketSql,
  buildEventHasBroadOrderableMarketSql,
} from "../lib/market-availability.js";
import { buildRenderableMarketSql } from "../lib/market-renderability.js";
import type { PgParams, TokenPair } from "../server-types.js";
import type { FifaSection } from "../schemas/special.js";
import { queryRowsWithLocalSettings } from "../repos/unified-read.js";
import {
  buildMatchFixtureKey,
  canonicalSportsTeamKey,
  parseSportsMatchTeamsFromTitle,
  slugifySportsKey,
} from "./sports-fixture-keys.js";

export type FifaSpecialView = "events" | "markets";
export type FifaSpecialSort =
  | "featured"
  | "volume"
  | "volume24h"
  | "liquidity"
  | "time"
  | "newest";

export type FifaSpecialInputs = {
  limit: number;
  offset: number;
  view: FifaSpecialView;
  q?: string;
  venues?: string[];
  sections?: FifaSection[];
  groupCodes?: string[];
  teamGroupCodes?: string[];
  sort: FifaSpecialSort;
  sortDir: "asc" | "desc";
  nowParam: string;
};

export type FifaGroupType =
  | "match"
  | "outright"
  | "group"
  | "stage"
  | "match_result"
  | "match_prop"
  | "player_award"
  | "squad"
  | "special";

export type FifaMeta = {
  section: FifaSection;
  subtype: string | null;
  groupType: FifaGroupType;
  groupKey: string;
  groupLabel: string;
  groupCode: string | null;
  groupTeams: string[] | null;
  groupMarketType:
    | "winner"
    | "qualify"
    | "bottom"
    | "order"
    | "champion_group"
    | "second_place"
    | "last_place"
    | "highest_scoring_team"
    | "unknown"
    | null;
  matchKey: string | null;
  matchFixtureKey: string | null;
  matchDate: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  teamName: string | null;
  teamGroupCode: string | null;
  entity: string | null;
  line: number | null;
  sourceRule: string;
  confidence: "high" | "medium" | "low";
};

export type FifaFacetRow = {
  section?: FifaSection;
  venue?: string;
  events: number;
  markets: number;
};

export type FifaSpecialRow = {
  event_id: string;
  event_title: string | null;
  event_duration_minutes: number | null;
  category: string | null;
  start_date: unknown;
  end_date: unknown;
  event_liquidity: unknown;
  event_liquidity_display: unknown;
  event_volume: unknown;
  event_volume_24h: unknown;
  event_volume_display: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_venue: string;
  venue_event_id: string | null;
  event_series_key: string | null;
  event_series_title: string | null;
  market_uuid: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_type: string | null;
  market_duration_minutes: number | null;
  market_status: string | null;
  pm_accepting_orders: boolean | null;
  market_open_time: unknown;
  market_close_time: unknown;
  market_expiration_time: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  volume_display: unknown;
  open_interest: unknown;
  liquidity: unknown;
  liquidity_display: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  last_price: unknown;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  change_24h: unknown;
  outcomes: string | null;
  token_yes: unknown;
  token_no: unknown;
  clob_token_ids: unknown;
  condition_id: unknown;
  market_slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_metadata: unknown;
  venue_exchange: string | null;
  venue_adapter: string | null;
  market_address: string | null;
  trade_type: string | null;
  last_update: unknown;
  market_created_at: unknown;
  fifa_section: FifaSection;
  fifa_subtype: string | null;
  fifa_source_rule: string;
  fifa_confidence: "high" | "medium" | "low";
};

type FifaMetaRow = Pick<
  FifaSpecialRow,
  | "event_title"
  | "event_slug"
  | "venue_event_id"
  | "market_title"
  | "market_slug"
  | "venue_market_id"
  | "fifa_section"
  | "fifa_subtype"
  | "fifa_source_rule"
  | "fifa_confidence"
>;

type FifaCandidateRow = FifaMetaRow &
  Pick<FifaSpecialRow, "event_id" | "market_uuid" | "venue"> & {
    event_volume_display: unknown;
    event_volume_24h: unknown;
    event_liquidity_display: unknown;
    volume_display: unknown;
    volume_24h_display: unknown;
    liquidity_display: unknown;
    sort_time: unknown;
    market_created_at: unknown;
    search_rank: unknown;
    match_intent_rank: unknown;
    ord?: unknown;
    market_rank?: unknown;
  };

type FifaCandidateProjectionMode = "page" | "count" | "facet";

type FifaFacetCandidateRow = Pick<
  FifaCandidateRow,
  "event_id" | "market_uuid" | "venue" | "fifa_section"
>;

type FifaEventSortRow = {
  event_id: string;
  search_rank: number | null;
  match_intent_rank: number | null;
  section: string;
  volume_display: number;
  volume_24h_display: number;
  liquidity_display: number;
  sort_time: unknown;
  created_at: unknown;
};

export type FifaSpecialPage = {
  rows: FifaSpecialRow[];
  total: number;
  sectionFacets: Array<Required<Pick<FifaFacetRow, "section">> & Omit<FifaFacetRow, "section" | "venue">>;
  venueFacets: Array<Required<Pick<FifaFacetRow, "venue">> & Omit<FifaFacetRow, "section" | "venue">>;
};

type ParamBuilder = {
  params: PgParams;
  add: (value: PgParams[number]) => string;
};

function createParamBuilder(): ParamBuilder {
  const params: PgParams = [];
  const add = (value: PgParams[number]): string => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, add };
}

async function queryFifaRows<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: PgParams,
): Promise<T[]> {
  if (typeof (pool as { connect?: unknown }).connect !== "function") {
    const { rows } = await pool.query<T>(sql, params);
    return rows;
  }
  return queryRowsWithLocalSettings<T>(pool, sql, params, {
    workMem: FIFA_SPECIAL_WORK_MEM,
    jitOff: true,
  });
}

const FIFA_SEARCH_MATCH_LIMIT = 2000;
const FIFA_SPECIAL_WORK_MEM = "32MB";

export function normalizeFifaSpecialSearchQuery(q: string | undefined): string | undefined {
  const trimmed = q?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized === "fifa" ||
    normalized === "world cup" ||
    normalized === "fifa world cup" ||
    normalized === "2026 world cup" ||
    normalized === "2026 fifa world cup"
    ? undefined
    : trimmed;
}

function buildLowerTextSql(parts: string[]): string {
  return `
    lower(
      ${parts.map((part) => `coalesce(${part}, '')`).join(" || ' ' || ")}
    )
  `;
}

function buildEventTextSql(options: { includeDescription?: boolean } = {}): string {
  return buildLowerTextSql([
    "e.title",
    "e.slug",
    ...(options.includeDescription ? ["e.description"] : []),
  ]);
}

function buildMarketTextSql(options: { includeDescription?: boolean } = {}): string {
  return buildLowerTextSql([
    "m.title",
    "m.slug",
    ...(options.includeDescription ? ["m.description"] : []),
  ]);
}

function buildTeamIntentRegex(value: string): string {
  return `(^|[^a-z0-9])${value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "[-[:space:]]+")}([^a-z0-9]|$)`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function teamIntentPatterns(teamKey: string): string[] {
  const known = TEAM_TO_GROUP.get(teamKey);
  const values = new Set<string>([
    teamKey,
    teamKey.replace(/-/g, " "),
    known?.team ?? "",
  ]);

  if (teamKey === "united-states") {
    values.add("usa");
    values.add("us");
    values.add("united states");
  }
  if (teamKey === "south-korea") {
    values.add("korea republic");
    values.add("republic of korea");
    values.add("south korea");
  }
  if (teamKey === "turkiye") {
    values.add("turkey");
    values.add("turkiye");
  }
  if (teamKey === "congo-dr") {
    values.add("dr congo");
    values.add("congo dr");
  }
  if (teamKey === "ivory-coast") {
    values.add("cote d ivoire");
    values.add("ivory coast");
  }

  return Array.from(values)
    .map((value) => value.trim())
    .filter(Boolean)
    .map(buildTeamIntentRegex);
}

function parseFifaMatchIntentQuery(q: string | undefined):
  | { teamARegex: string; teamBRegex: string }
  | null {
  const terms = q?.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (terms.length === 0) return null;

  const matched = new Map<string, { start: number; end: number }>();
  for (let start = 0; start < terms.length; start += 1) {
    for (let end = start + 1; end <= Math.min(terms.length, start + 4); end += 1) {
      const phrase = terms.slice(start, end).join(" ");
      const key = canonicalSportsTeamKey(phrase);
      if (!TEAM_TO_GROUP.has(key)) continue;
      const current = matched.get(key);
      if (!current || end - start > current.end - current.start) {
        matched.set(key, { start, end });
      }
    }
  }

  const teamKeys = Array.from(matched.entries())
    .sort((left, right) => left[1].start - right[1].start || left[1].end - right[1].end)
    .map(([key]) => key);
  const uniqueTeamKeys = Array.from(new Set(teamKeys));
  if (uniqueTeamKeys.length !== 2) return null;

  return {
    teamARegex: teamIntentPatterns(uniqueTeamKeys[0]).join("|"),
    teamBRegex: teamIntentPatterns(uniqueTeamKeys[1]).join("|"),
  };
}

function buildFifaEventHasOrderableMarketSql(nowParam: string): string {
  return buildEventHasBroadOrderableMarketSql({
    eventAlias: "e",
    nowParam,
    renderableMarketSql: buildRenderableMarketSql({ alias: "om" }),
  });
}

function buildCombinedFifaTextSql(options: { includeDescription?: boolean } = {}): string {
  return `
    lower(
      coalesce(e.title, '') || ' ' ||
      coalesce(e.slug, '') || ' ' ||
      ${
        options.includeDescription
          ? "coalesce(e.description, '') || ' ' ||"
          : ""
      }
      coalesce(m.title, '') || ' ' ||
      coalesce(m.slug, '')
      ${options.includeDescription ? " || ' ' || coalesce(m.description, '')" : ""}
    )
  `;
}

function buildLimitlessFifaCandidateSql(): string {
  const text = buildCombinedFifaTextSql();
  return `(
    lower(coalesce(e.title, '')) like '%fifa world cup%'
    or lower(coalesce(e.slug, '')) like '%fifa-world-cup%'
    or lower(coalesce(e.title, '')) like '%2026 fifa world cup%'
    or lower(coalesce(e.slug, '')) like '%2026-fifa-world-cup%'
    or (
      ${text} like '%world cup%'
      and ${text} !~ '(club world cup|icc|t20|cricket|rugby|esports|\\mlol\\M|league of legends|dota|counter-strike|valorant)'
      and ${text} ~ '(golden boot|silver boot|bronze boot|golden ball|silver ball|bronze ball|golden glove|fair play|furthest advancing|nation to reach (quarterfinals|semifinals)|reach a later stage|highest[-\\s]scoring team|captain for the opening world cup match|goalkeeper to score|messi|ronaldo|neymar)'
    )
  )`;
}

function buildFifaCandidateSql(): string {
  const worldCupSeries = [
    "KXMENWORLDCUP",
    "KXWCGAME",
    "KXWCTOTAL",
    "KXWCSPREAD",
    "KXWCBTTS",
    "KXWCSCORE",
    "KXWC1H",
    "KXWC1HBTTS",
    "KXWC1HTOTAL",
    "KXWCGOAL",
    "KXWCTEAMTOTAL",
    "KXWC1HSPREAD",
    "KXWCCORNERS",
    "KXWCSOA",
    "KXWCTCORNERS",
    "KXWCFTTS",
    "KXWCFIRSTGOAL",
    "KXWCGROUPWIN",
    "KXWCGROUPQUAL",
    "KXWCROUND",
    "KXWCAWARD",
    "KXWCSQUAD",
    "KXWCCONTINENT",
    "KXWCFURTHESTADVANCING",
    "KXWCGOALLEADER",
    "KXWCAST",
    "KXWCFIFATOP10",
    "KXWCGROUPBOTTOM",
    "KXWCGROUPORDER",
    "KXWCGROUPWINNER",
    "KXWCSTAGEOFELIM",
    "KXWCTOTALGOAL",
    "KXWCMENTION",
    "KXWCOCMEX",
    "KXWORLDCUPHALFTIME",
  ];
  const seriesList = worldCupSeries.map((key) => `'${key}'`).join(",");
  return `(
    (
      e.venue = 'polymarket'
      and (
        e.series_key = 'soccer-fifwc'
        or e.slug like 'fifwc-%'
        or e.slug like 'world-cup-%'
        or e.slug in ('world-cup-winner', 'which-continent-will-win-the-world-cup')
      )
      and coalesce(e.series_key, '') <> 'fifa-friendly'
    )
    or (
      e.venue = 'kalshi'
      and (
        e.series_key in (${seriesList})
        or (
          coalesce(e.metadata->>'competition', '') = 'FIFA'
          and lower(coalesce(e.metadata->>'seriesCategory', '')) = 'sports'
          and coalesce(e.series_key, '') not in ('KXWT20WORLDCUP', 'KXWCCREG')
        )
      )
    )
    or (
      e.venue = 'limitless'
      and ${buildLimitlessFifaCandidateSql()}
    )
  )`;
}

function buildFifaSectionSql(): string {
  const text = buildCombinedFifaTextSql();
  return `
    case
      when e.venue = 'kalshi' and e.series_key in ('KXWCMENTION', 'KXWCOCMEX', 'KXWORLDCUPHALFTIME') then 'special'
      when e.venue = 'kalshi' and e.series_key in ('KXWCGAME', 'KXFIFAGAME') then 'match_result'
      when e.venue = 'kalshi' and e.series_key in (
        'KXWCTOTAL', 'KXWCSPREAD', 'KXWCBTTS', 'KXWCSCORE', 'KXWC1H',
        'KXWC1HBTTS', 'KXWC1HTOTAL', 'KXWCGOAL', 'KXWCTEAMTOTAL',
        'KXWC1HSPREAD', 'KXWCCORNERS', 'KXWCSOA', 'KXWCTCORNERS',
        'KXWCFTTS', 'KXWCFIRSTGOAL'
      ) then 'match_prop'
      when e.venue = 'kalshi' and e.series_key in ('KXMENWORLDCUP', 'KXWCCONTINENT') then 'winner'
      when e.venue = 'kalshi' and e.series_key in ('KXWCGROUPWIN', 'KXWCGROUPQUAL', 'KXWCGROUPBOTTOM', 'KXWCGROUPORDER', 'KXWCGROUPWINNER') then 'group'
      when e.venue = 'kalshi' and e.series_key in ('KXWCROUND', 'KXWCFURTHESTADVANCING', 'KXWCSTAGEOFELIM') then 'stage'
      when e.venue = 'kalshi' and e.series_key in ('KXWCAWARD', 'KXWCGOALLEADER', 'KXWCAST', 'KXWCFIFATOP10', 'KXWCTOTALGOAL') then 'player_award'
      when e.venue = 'kalshi' and e.series_key = 'KXWCSQUAD' then 'squad'
      when e.venue = 'polymarket' and e.slug like 'fifwc-%' and (
        e.slug like '%-more-markets'
        or e.slug like '%-exact-score'
        or e.slug like '%-halftime-result'
        or e.slug like '%-second-half-result'
        or e.slug like '%-first-to-score'
        or e.slug like '%-total-corners'
        or e.slug like '%-player-props'
        or m.slug like '%-total-%'
        or m.slug like '%-spread-%'
        or m.slug like '%-team-total-%'
        or m.slug like '%-btts%'
        or m.slug like '%-first-half%'
        or m.slug like '%-second-half%'
      ) then 'match_prop'
      when e.venue = 'polymarket' and e.slug like 'fifwc-%' then 'match_result'
      when lower(coalesce(e.title, '') || ' ' || coalesce(e.slug, '')) like '%stage of elimination%' then 'stage'
      when ${text} like '%group%' then 'group'
      when ${text} ~ '(reach|advance|knockout|round of|quarterfinal|semifinal|final)' then 'stage'
      when ${text} ~ '(award|golden boot|silver boot|bronze boot|golden ball|silver ball|bronze ball|golden glove|fair play|top goalscorer|most assists|goal leader|score 5|assist)' then 'player_award'
      when e.venue = 'limitless' and ${text} ~ '(captain for the opening world cup match|goalkeeper to score|messi|ronaldo|neymar)' then 'special'
      when ${text} ~ '(squad|\\mplay\\M)' then 'squad'
      when ${text} ~ '(winner|champion|continent will win)' then 'winner'
      else 'special'
    end
  `;
}

function buildFifaSubtypeSql(): string {
  return `
    case
      when e.venue = 'kalshi' and e.series_key = 'KXWC1H' then 'first_half'
      when e.venue = 'kalshi' and e.series_key in ('KXWCSPREAD', 'KXWC1HSPREAD') then 'spread'
      when e.venue = 'kalshi' and e.series_key in ('KXWCTOTAL', 'KXWC1HTOTAL') then 'total'
      when e.venue = 'kalshi' and e.series_key = 'KXWCTEAMTOTAL' then 'team_total'
      when e.venue = 'kalshi' and e.series_key in ('KXWCBTTS', 'KXWC1HBTTS') then 'btts'
      when e.venue = 'kalshi' and e.series_key = 'KXWCSCORE' then 'correct_score'
      when e.venue = 'kalshi' and e.series_key in ('KXWCCORNERS', 'KXWCTCORNERS') then 'corners'
      when e.venue = 'kalshi' and e.series_key in ('KXWCFTTS', 'KXWCFIRSTGOAL') then 'first_team_to_score'
      when e.venue = 'kalshi' and e.series_key in ('KXWCGOAL', 'KXWCSOA', 'KXWCAST') then 'player_goal_or_assist'
      when m.slug like '%-spread-%' or lower(coalesce(m.title, '')) like 'spread:%' then 'spread'
      when m.slug like '%team-total%' then 'team_total'
      when m.slug like '%-total-%' or lower(coalesce(m.title, '')) like 'o/u%' then 'total'
      when m.slug like '%btts%' or lower(coalesce(m.title, '')) like '%both teams to score%' then 'btts'
      when m.slug like '%exact-score%' then 'correct_score'
      when m.slug like '%first-half%' or m.slug like '%halftime%' then 'first_half'
      when m.slug like '%second-half%' then 'second_half'
      when m.slug like '%corners%' then 'corners'
      when m.slug like '%first-to-score%' then 'first_team_to_score'
      when m.slug like '%player-props%' or lower(coalesce(m.title, '')) ~ '(goal|assist)' then 'player_goal_or_assist'
      when (${buildFifaSectionSql()}) = 'match_result' and lower(coalesce(m.title, '')) in ('draw', 'tie') then 'draw'
      when (${buildFifaSectionSql()}) = 'match_result' and lower(coalesce(m.title, '')) like 'draw %' then 'draw'
      when (${buildFifaSectionSql()}) = 'match_result' then 'moneyline'
      when (${buildFifaSectionSql()}) = 'winner' then 'outright_entity'
      when (${buildFifaSectionSql()}) = 'group' then 'group_entity'
      when (${buildFifaSectionSql()}) = 'stage' then 'stage_entity'
      when (${buildFifaSectionSql()}) = 'squad' then 'squad_entity'
      when (${buildFifaSectionSql()}) = 'player_award' then 'player_award_entity'
      else 'special'
    end
  `;
}

function buildFifaSourceRuleSql(): string {
  return `
    case
      when e.venue = 'polymarket' and e.slug like 'fifwc-%' then 'polymarket_fifwc_slug'
      when e.venue = 'polymarket' and e.slug like 'world-cup-%' then 'polymarket_world_cup_slug'
      when e.venue = 'polymarket' and e.series_key = 'soccer-fifwc' then 'polymarket_series_key'
      when e.venue = 'kalshi' and e.series_key is not null then 'kalshi_series_key'
      when e.venue = 'kalshi' and coalesce(e.metadata->>'competition', '') = 'FIFA' then 'kalshi_competition_metadata'
      when e.venue = 'limitless' and (
        lower(coalesce(e.title, '')) like '%fifa world cup%'
        or lower(coalesce(e.slug, '')) like '%fifa-world-cup%'
        or lower(coalesce(e.title, '')) like '%2026 fifa world cup%'
        or lower(coalesce(e.slug, '')) like '%2026-fifa-world-cup%'
      ) then 'limitless_exact_fifa_text'
      when e.venue = 'limitless' then 'limitless_world_cup_pattern'
      else 'fallback'
    end
  `;
}

function buildSearchDocumentExpr(alias: string): string {
  return `
    setweight(to_tsvector('english', coalesce(${alias}.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(${alias}.description, '')), 'D')
  `;
}

function buildSearchSql(
  q: string | undefined,
  add: ParamBuilder["add"],
  nowParam: string,
): {
  cte: string;
  join: string;
  predicate: string;
  rankExpr: string;
  matchIntentRankExpr: string;
} {
  if (!q) {
    return {
      cte: "",
      join: "",
      predicate: "true",
      rankExpr: "0",
      matchIntentRankExpr: "0",
    };
  }

  const searchParam = add(q);
  const terms = q.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const prefixTerm =
    terms.length === 1 &&
    terms[0].length >= 3 &&
    terms[0].length <= 6 &&
    !/^\d+$/.test(terms[0])
      ? `${terms[0]}:*`
      : null;
  const prefixParam = add(prefixTerm);
  const searchLimitParam = add(FIFA_SEARCH_MATCH_LIMIT);
  const rawLikeParam = add(`%${q.toLowerCase()}%`);
  const eventDocExpr = buildSearchDocumentExpr("e");
  const marketDocExpr = buildSearchDocumentExpr("m");
  const eventRawExpr = buildEventTextSql({ includeDescription: true });
  const marketRawExpr = buildMarketTextSql({ includeDescription: true });
  const matchIntent = parseFifaMatchIntentQuery(q);
  const teamALiteral = matchIntent
    ? sqlStringLiteral(matchIntent.teamARegex)
    : null;
  const teamBLiteral = matchIntent
    ? sqlStringLiteral(matchIntent.teamBRegex)
    : null;
  const eventTextExpr = buildEventTextSql();
  const combinedTextExpr = buildCombinedFifaTextSql();
  const matchIntentRankExpr =
    teamALiteral && teamBLiteral
      ? `
        case
          when (${buildFifaSectionSql()}) in ('match_result', 'match_prop')
            and ${eventTextExpr} ~ ${teamALiteral}::text
            and ${eventTextExpr} ~ ${teamBLiteral}::text
          then 100
          when ${combinedTextExpr} ~ ${teamALiteral}::text
            and ${combinedTextExpr} ~ ${teamBLiteral}::text
          then 10
          else 0
        end
      `
      : "0";
  return {
    cte: `
      search_query as materialized (
        select
          prepared.query,
          prepared.prefix_query,
          (
            querytree(prepared.query) <> ''
            or (prepared.prefix_query is not null and querytree(prepared.prefix_query) <> '')
          ) as applies
        from (
          select
            raw.query,
            case
              when querytree(raw.query) = '' then null::tsquery
              else raw.prefix_query
            end as prefix_query
          from (
            select
              websearch_to_tsquery('english', ${searchParam}::text) as query,
              case
                when ${prefixParam}::text is null then null::tsquery
                else to_tsquery('english', ${prefixParam}::text)
              end as prefix_query
          ) raw
        ) prepared
      )
      ,
      matched_search_events as materialized (
        select id, max(rank) as search_rank
        from (
          select
            e.id,
            ts_rank_cd((${eventDocExpr}), sq.query) as rank
          from unified_events e
          cross join search_query sq
          where sq.applies
            and querytree(sq.query) <> ''
            and e.status = 'ACTIVE'
            and ${buildFifaEventHasOrderableMarketSql(nowParam)}
            and (${eventDocExpr}) @@ sq.query
          union all
          select
            e.id,
            ts_rank_cd((${eventDocExpr}), sq.prefix_query) as rank
          from unified_events e
          cross join search_query sq
          where sq.prefix_query is not null
            and sq.applies
            and querytree(sq.prefix_query) <> ''
            and e.status = 'ACTIVE'
            and ${buildFifaEventHasOrderableMarketSql(nowParam)}
            and (${eventDocExpr}) @@ sq.prefix_query
        ) hits
        group by id
        order by max(rank) desc nulls last, id
        limit ${searchLimitParam}::int
      )
      ,
      matched_search_markets as materialized (
        select market_id, event_id, max(rank) as search_rank
        from (
          select
            m.id as market_id,
            m.event_id,
            ts_rank_cd((${marketDocExpr}), sq.query) * 2 as rank
          from unified_markets m
          join unified_events e on e.id = m.event_id
          left join polymarket_markets pm_search
            on pm_search.id = m.venue_market_id and m.venue = 'polymarket'
          cross join search_query sq
          where sq.applies
            and querytree(sq.query) <> ''
            and e.status = 'ACTIVE'
            and m.status = 'ACTIVE'
            and ${buildBroadOrderableMarketSql({
              marketAlias: "m",
              eventAlias: "e",
              nowParam,
              pmAlias: "pm_search",
            })}
            and (${marketDocExpr}) @@ sq.query
          union all
          select
            m.id as market_id,
            m.event_id,
            ts_rank_cd((${marketDocExpr}), sq.prefix_query) * 2 as rank
          from unified_markets m
          join unified_events e on e.id = m.event_id
          left join polymarket_markets pm_search
            on pm_search.id = m.venue_market_id and m.venue = 'polymarket'
          cross join search_query sq
          where sq.prefix_query is not null
            and sq.applies
            and querytree(sq.prefix_query) <> ''
            and e.status = 'ACTIVE'
            and m.status = 'ACTIVE'
            and ${buildBroadOrderableMarketSql({
              marketAlias: "m",
              eventAlias: "e",
              nowParam,
              pmAlias: "pm_search",
            })}
            and (${marketDocExpr}) @@ sq.prefix_query
        ) hits
        group by market_id, event_id
        order by max(rank) desc nulls last, market_id
        limit ${searchLimitParam}::int
      )
      ,
      raw_search_events as materialized (
        select raw.id, raw.search_rank
        from search_query sq
        join lateral (
          select e.id, 0.000001::double precision as search_rank
          from unified_events e
          join unified_markets m on m.event_id = e.id
          left join polymarket_markets pm_raw
            on pm_raw.id = m.venue_market_id and m.venue = 'polymarket'
          where e.status = 'ACTIVE'
            and m.status = 'ACTIVE'
            and ${buildBroadOrderableMarketSql({
              marketAlias: "m",
              eventAlias: "e",
              nowParam,
              pmAlias: "pm_raw",
            })}
            and ${buildRenderableMarketSql({ alias: "m" })}
            and ${buildFifaCandidateSql()}
            and ${eventRawExpr} like ${rawLikeParam}::text
          group by e.id
          order by e.id
          limit ${searchLimitParam}::int
        ) raw on not sq.applies
      )
      ,
      raw_search_markets as materialized (
        select raw.market_id, raw.event_id, raw.search_rank
        from search_query sq
        join lateral (
          select m.id as market_id, m.event_id, 0.000002::double precision as search_rank
          from unified_markets m
          join unified_events e on e.id = m.event_id
          left join polymarket_markets pm_raw
            on pm_raw.id = m.venue_market_id and m.venue = 'polymarket'
          where e.status = 'ACTIVE'
            and m.status = 'ACTIVE'
            and ${buildBroadOrderableMarketSql({
              marketAlias: "m",
              eventAlias: "e",
              nowParam,
              pmAlias: "pm_raw",
            })}
            and ${buildRenderableMarketSql({ alias: "m" })}
            and ${buildFifaCandidateSql()}
            and ${marketRawExpr} like ${rawLikeParam}::text
          order by m.id
          limit ${searchLimitParam}::int
        ) raw on not sq.applies
      )
      ,
      search_candidate_markets as materialized (
        select market_id, event_id, max(search_rank) as search_rank
        from (
          select m_event.id as market_id, m_event.event_id, se.search_rank::double precision as search_rank
          from matched_search_events se
          join unified_markets m_event on m_event.event_id = se.id
          union all
          select sm.market_id, sm.event_id, sm.search_rank::double precision as search_rank
          from matched_search_markets sm
          union all
          select m_event.id as market_id, m_event.event_id, re.search_rank
          from raw_search_events re
          join unified_markets m_event on m_event.event_id = re.id
          union all
          select rm.market_id, rm.event_id, rm.search_rank
          from raw_search_markets rm
        ) hits
        group by market_id, event_id
      )
    `,
    join: `
      join search_candidate_markets sc on sc.market_id = m.id
    `,
    predicate: "true",
    rankExpr: "coalesce(sc.search_rank, 0)",
    matchIntentRankExpr,
  };
}

export function buildFifaSpecialSearchSqlForTest(q: string): {
  cte: string;
  predicate: string;
} {
  const builder = createParamBuilder();
  const search = buildSearchSql(q, builder.add, "$now");
  return {
    cte: search.cte,
    predicate: search.predicate,
  };
}

function buildBaseSql(args: {
  inputs: FifaSpecialInputs;
  add: ParamBuilder["add"];
  ignoreSections?: boolean;
  ignoreVenues?: boolean;
}): {
  cte: string;
  where: string[];
  sectionExpr: string;
  subtypeExpr: string;
  sourceRuleExpr: string;
  searchJoin: string;
  searchRankExpr: string;
  matchIntentRankExpr: string;
} {
  const { inputs, add, ignoreSections = false, ignoreVenues = false } = args;
  const nowParam = add(inputs.nowParam);
  const sectionExpr = buildFifaSectionSql();
  const subtypeExpr = buildFifaSubtypeSql();
  const sourceRuleExpr = buildFifaSourceRuleSql();
  const search = buildSearchSql(inputs.q, add, nowParam);
  const where = [
    buildBroadOrderableMarketSql({
      marketAlias: "m",
      eventAlias: "e",
      nowParam,
      pmAlias: "pm_filter",
    }),
    buildRenderableMarketSql({ alias: "m" }),
    buildFifaCandidateSql(),
    search.predicate,
  ];

  if (!ignoreVenues && inputs.venues?.length) {
    where.push(`m.venue = ANY(${add(inputs.venues)}::text[])`);
  }
  if (!ignoreSections && inputs.sections?.length) {
    where.push(`(${sectionExpr}) = ANY(${add(inputs.sections)}::text[])`);
  }

  return {
    cte: search.cte,
    where,
    sectionExpr,
    subtypeExpr,
    sourceRuleExpr,
    searchJoin: search.join,
    searchRankExpr: search.rankExpr,
    matchIntentRankExpr: search.matchIntentRankExpr,
  };
}

function sortDirectionSql(inputs: FifaSpecialInputs): "asc" | "desc" {
  return inputs.sortDir === "asc" ? "asc" : "desc";
}

function buildOrderSql(inputs: FifaSpecialInputs, alias: "event" | "market") {
  const dir = sortDirectionSql(inputs);
  if (inputs.sort === "time") {
    return `sort_time ${dir} nulls last, ${alias === "event" ? "event_id" : "market_uuid"}`;
  }
  if (inputs.sort === "newest") {
    return `${alias === "event" ? "created_at" : "market_created_at"} ${dir} nulls last, ${alias === "event" ? "event_id" : "market_uuid"}`;
  }
  if (inputs.sort === "volume") {
    return `volume_display ${dir} nulls last, ${alias === "event" ? "event_id" : "market_uuid"}`;
  }
  if (inputs.sort === "volume24h") {
    return `volume_24h_display ${dir} nulls last, ${alias === "event" ? "event_id" : "market_uuid"}`;
  }
  if (inputs.sort === "liquidity") {
    return `liquidity_display ${dir} nulls last, ${alias === "event" ? "event_id" : "market_uuid"}`;
  }
  return `
    match_intent_rank desc nulls last,
    search_rank desc nulls last,
    case ${alias === "event" ? "section" : "fifa_section"}
      when 'winner' then 90
      when 'match_result' then 80
      when 'match_prop' then 70
      when 'stage' then 60
      when 'group' then 50
      when 'player_award' then 40
      when 'squad' then 30
      else 10
    end desc,
    volume_display desc nulls last,
    sort_time asc nulls last,
    ${alias === "event" ? "event_id" : "market_uuid"}
  `;
}

function buildGroupedEventCandidatesSql(source: string): string {
  return `
    select
      event_id,
      max(search_rank) as search_rank,
      max(match_intent_rank) as match_intent_rank,
      min(fifa_section) as section,
      max(coalesce(event_volume_display, 0)) as volume_display,
      max(coalesce(event_volume_24h, 0)) as volume_24h_display,
      max(coalesce(event_liquidity_display, 0)) as liquidity_display,
      min(sort_time) as sort_time,
      min(market_created_at) as created_at
    from ${source}
    group by event_id
  `;
}

function hasMetadataFilters(inputs: FifaSpecialInputs): boolean {
  return Boolean(inputs.groupCodes?.length || inputs.teamGroupCodes?.length);
}

function rowMatchesMetadataFilters(row: FifaMetaRow, inputs: FifaSpecialInputs): boolean {
  if (!hasMetadataFilters(inputs)) return true;
  const fifa = buildFifaMeta(row, { scope: "market" });
  if (inputs.groupCodes?.length) {
    if (!fifa.groupCode || !inputs.groupCodes.includes(fifa.groupCode)) {
      return false;
    }
  }
  if (inputs.teamGroupCodes?.length) {
    if (
      !fifa.teamGroupCode ||
      !inputs.teamGroupCodes.includes(fifa.teamGroupCode)
    ) {
      return false;
    }
  }
  return true;
}

function candidateNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function candidateTime(value: unknown): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : null;
}

function compareNullableNumbers(
  a: unknown,
  b: unknown,
  direction: "asc" | "desc",
): number {
  const left = candidateNumber(a);
  const right = candidateNumber(b);
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function compareNullableTimes(
  a: unknown,
  b: unknown,
  direction: "asc" | "desc",
): number {
  const left = candidateTime(a);
  const right = candidateTime(b);
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sectionFeaturedScore(section: string | null | undefined): number {
  switch (section) {
    case "winner":
      return 90;
    case "match_result":
      return 80;
    case "match_prop":
      return 70;
    case "stage":
      return 60;
    case "group":
      return 50;
    case "player_award":
      return 40;
    case "squad":
      return 30;
    default:
      return 10;
  }
}

function compareCandidateMarkets(
  inputs: FifaSpecialInputs,
  a: FifaCandidateRow,
  b: FifaCandidateRow,
): number {
  const dir = sortDirectionSql(inputs);
  if (inputs.sort === "time") {
    return (
      compareNullableTimes(a.sort_time, b.sort_time, dir) ||
      compareText(a.market_uuid, b.market_uuid)
    );
  }
  if (inputs.sort === "newest") {
    return (
      compareNullableTimes(a.market_created_at, b.market_created_at, dir) ||
      compareText(a.market_uuid, b.market_uuid)
    );
  }
  if (inputs.sort === "volume") {
    return (
      compareNullableNumbers(a.volume_display, b.volume_display, dir) ||
      compareText(a.market_uuid, b.market_uuid)
    );
  }
  if (inputs.sort === "volume24h") {
    return (
      compareNullableNumbers(a.volume_24h_display, b.volume_24h_display, dir) ||
      compareText(a.market_uuid, b.market_uuid)
    );
  }
  if (inputs.sort === "liquidity") {
    return (
      compareNullableNumbers(a.liquidity_display, b.liquidity_display, dir) ||
      compareText(a.market_uuid, b.market_uuid)
    );
  }
  return (
    compareNullableNumbers(a.match_intent_rank, b.match_intent_rank, "desc") ||
    compareNullableNumbers(a.search_rank, b.search_rank, "desc") ||
    sectionFeaturedScore(b.fifa_section) - sectionFeaturedScore(a.fifa_section) ||
    compareNullableNumbers(a.volume_display, b.volume_display, "desc") ||
    compareNullableTimes(a.sort_time, b.sort_time, "asc") ||
    compareText(a.market_uuid, b.market_uuid)
  );
}

function maxNullableNumber(current: number | null, value: unknown): number | null {
  const next = candidateNumber(value);
  if (next == null) return current;
  return current == null || next > current ? next : current;
}

function minNullableTime(current: unknown, value: unknown): unknown {
  const currentTime = candidateTime(current);
  const nextTime = candidateTime(value);
  if (nextTime == null) return current;
  if (currentTime == null || nextTime < currentTime) return value;
  return current;
}

function buildEventSortRows(rows: FifaCandidateRow[]): FifaEventSortRow[] {
  const events = new Map<string, FifaEventSortRow>();
  for (const row of rows) {
    const existing = events.get(row.event_id);
    const rowSection = row.fifa_section ?? "special";
    if (!existing) {
      events.set(row.event_id, {
        event_id: row.event_id,
        search_rank: candidateNumber(row.search_rank),
        match_intent_rank: candidateNumber(row.match_intent_rank),
        section: rowSection,
        volume_display: candidateNumber(row.event_volume_display) ?? 0,
        volume_24h_display: candidateNumber(row.event_volume_24h) ?? 0,
        liquidity_display: candidateNumber(row.event_liquidity_display) ?? 0,
        sort_time: row.sort_time,
        created_at: row.market_created_at,
      });
      continue;
    }
    existing.search_rank = maxNullableNumber(existing.search_rank, row.search_rank);
    existing.match_intent_rank = maxNullableNumber(
      existing.match_intent_rank,
      row.match_intent_rank,
    );
    if (compareText(rowSection, existing.section) < 0) {
      existing.section = rowSection;
    }
    existing.volume_display = Math.max(
      existing.volume_display,
      candidateNumber(row.event_volume_display) ?? 0,
    );
    existing.volume_24h_display = Math.max(
      existing.volume_24h_display,
      candidateNumber(row.event_volume_24h) ?? 0,
    );
    existing.liquidity_display = Math.max(
      existing.liquidity_display,
      candidateNumber(row.event_liquidity_display) ?? 0,
    );
    existing.sort_time = minNullableTime(existing.sort_time, row.sort_time);
    existing.created_at = minNullableTime(existing.created_at, row.market_created_at);
  }
  return Array.from(events.values());
}

function compareEventSortRows(
  inputs: FifaSpecialInputs,
  a: FifaEventSortRow,
  b: FifaEventSortRow,
): number {
  const dir = sortDirectionSql(inputs);
  if (inputs.sort === "time") {
    return (
      compareNullableTimes(a.sort_time, b.sort_time, dir) ||
      compareText(a.event_id, b.event_id)
    );
  }
  if (inputs.sort === "newest") {
    return (
      compareNullableTimes(a.created_at, b.created_at, dir) ||
      compareText(a.event_id, b.event_id)
    );
  }
  if (inputs.sort === "volume") {
    return (
      compareNullableNumbers(a.volume_display, b.volume_display, dir) ||
      compareText(a.event_id, b.event_id)
    );
  }
  if (inputs.sort === "volume24h") {
    return (
      compareNullableNumbers(a.volume_24h_display, b.volume_24h_display, dir) ||
      compareText(a.event_id, b.event_id)
    );
  }
  if (inputs.sort === "liquidity") {
    return (
      compareNullableNumbers(a.liquidity_display, b.liquidity_display, dir) ||
      compareText(a.event_id, b.event_id)
    );
  }
  return (
    compareNullableNumbers(a.match_intent_rank, b.match_intent_rank, "desc") ||
    compareNullableNumbers(a.search_rank, b.search_rank, "desc") ||
    sectionFeaturedScore(b.section) - sectionFeaturedScore(a.section) ||
    compareNullableNumbers(a.volume_display, b.volume_display, "desc") ||
    compareNullableTimes(a.sort_time, b.sort_time, "asc") ||
    compareText(a.event_id, b.event_id)
  );
}

function orderCandidateRows(
  rows: FifaCandidateRow[],
  inputs: FifaSpecialInputs,
): FifaCandidateRow[] {
  if (inputs.view === "markets") {
    return [...rows]
      .sort((a, b) => compareCandidateMarkets(inputs, a, b))
      .map((row, index) => ({ ...row, ord: index + 1, market_rank: 1 }));
  }

  const rowsByEvent = new Map<string, FifaCandidateRow[]>();
  for (const row of rows) {
    const eventRows = rowsByEvent.get(row.event_id) ?? [];
    eventRows.push(row);
    rowsByEvent.set(row.event_id, eventRows);
  }
  const orderedEvents = buildEventSortRows(rows).sort((a, b) =>
    compareEventSortRows(inputs, a, b),
  );
  const orderedRows: FifaCandidateRow[] = [];
  for (const [eventIndex, event] of orderedEvents.entries()) {
    const eventRows = [...(rowsByEvent.get(event.event_id) ?? [])].sort(
      (a, b) =>
        compareNullableNumbers(a.volume_display ?? 0, b.volume_display ?? 0, "desc") ||
        compareText(a.market_uuid, b.market_uuid),
    );
    for (const [marketIndex, row] of eventRows.entries()) {
      orderedRows.push({
        ...row,
        ord: eventIndex + 1,
        market_rank: marketIndex + 1,
      });
    }
  }
  return orderedRows;
}

function rowMatchesRuntimeFilters(
  row: FifaCandidateRow,
  inputs: FifaSpecialInputs,
  options: {
    ignoreSections?: boolean;
    ignoreVenues?: boolean;
    applyMetadata?: boolean;
  } = {},
): boolean {
  if (!options.ignoreVenues && inputs.venues?.length && !inputs.venues.includes(row.venue)) {
    return false;
  }
  if (
    !options.ignoreSections &&
    inputs.sections?.length &&
    !inputs.sections.includes(row.fifa_section)
  ) {
    return false;
  }
  if (options.applyMetadata && !rowMatchesMetadataFilters(row, inputs)) {
    return false;
  }
  return true;
}

function paginateOrderedRows(
  orderedRows: FifaCandidateRow[],
  inputs: FifaSpecialInputs,
  options: { capEventMarkets: boolean },
): { rows: FifaCandidateRow[]; total: number } {
  if (inputs.view === "markets") {
    return {
      rows: orderedRows.slice(inputs.offset, inputs.offset + inputs.limit),
      total: orderedRows.length,
    };
  }

  const eventOrder: string[] = [];
  const seenEvents = new Set<string>();
  for (const row of orderedRows) {
    if (seenEvents.has(row.event_id)) continue;
    seenEvents.add(row.event_id);
    eventOrder.push(row.event_id);
  }
  const pageEventIds = new Set(
    eventOrder.slice(inputs.offset, inputs.offset + inputs.limit),
  );
  const rows = orderedRows.filter((row) => {
    if (!pageEventIds.has(row.event_id)) return false;
    if (!options.capEventMarkets) return true;
    return (candidateNumber(row.market_rank) ?? 1) <= 100;
  });
  return { rows, total: eventOrder.length };
}

function buildCandidateKeyProjection(
  base: ReturnType<typeof buildBaseSql>,
  mode: FifaCandidateProjectionMode = "page",
): string {
  const fromSql = `
    from unified_events e
    join unified_markets m on m.event_id = e.id
    left join polymarket_markets pm_filter
      on pm_filter.id = m.venue_market_id and m.venue = 'polymarket'
    ${base.searchJoin}
    where ${base.where.join(" and ")}
  `;

  if (mode === "count") {
    return `
      select
        e.id as event_id,
        m.id as market_uuid
      ${fromSql}
    `;
  }

  if (mode === "facet") {
    return `
      select
        e.id as event_id,
        m.id as market_uuid,
        m.venue,
        (${base.sectionExpr})::text as fifa_section
      ${fromSql}
    `;
  }

  return `
    select
      e.id as event_id,
      e.title as event_title,
      e.slug as event_slug,
      e.venue_event_id,
      e.volume_24h as event_volume_24h,
      coalesce(nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0), nullif(e.open_interest, 0)) as event_liquidity_display,
      coalesce(nullif(e.volume_total, 0), nullif(sum(coalesce(m.volume_total, 0)) over (partition by e.id), 0)) as event_volume_display,
      m.id as market_uuid,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.slug as market_slug,
      case when m.volume_total is not null and m.volume_total > 0 then m.volume_total else null end as volume_display,
      coalesce(m.volume_24h, 0) as volume_24h_display,
      coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0)) as liquidity_display,
      coalesce(m.close_time, m.expiration_time, e.end_date) as sort_time,
      m.created_at as market_created_at,
      (${base.sectionExpr})::text as fifa_section,
      (${base.subtypeExpr})::text as fifa_subtype,
      (${base.sourceRuleExpr})::text as fifa_source_rule,
      case
        when e.venue in ('polymarket', 'kalshi') then 'high'
        when e.venue = 'limitless' then 'medium'
        else 'low'
      end::text as fifa_confidence,
      (${base.searchRankExpr}) as search_rank,
      (${base.matchIntentRankExpr}) as match_intent_rank
    ${fromSql}
  `;
}

function selectedMarketKeysFromJson(jsonParam: string): string {
  return `
    select *
    from jsonb_to_recordset(${jsonParam}::jsonb) as k(
      ord int,
      market_rank int,
      market_uuid text,
      event_id text,
      event_volume_display numeric,
      event_liquidity_display numeric,
      volume_display numeric,
      volume_24h_display numeric,
      liquidity_display numeric,
      fifa_section text,
      fifa_subtype text,
      fifa_source_rule text,
      fifa_confidence text,
      search_rank numeric,
      match_intent_rank numeric
    )
  `;
}

function serializeSelectedCandidateRows(rows: FifaCandidateRow[]): string {
  return JSON.stringify(
    rows.map((row, index) => ({
      ord: candidateNumber(row.ord) ?? index + 1,
      market_rank: candidateNumber(row.market_rank) ?? index + 1,
      market_uuid: row.market_uuid,
      event_id: row.event_id,
      event_volume_display: row.event_volume_display ?? null,
      event_liquidity_display: row.event_liquidity_display ?? null,
      volume_display: row.volume_display ?? null,
      volume_24h_display: row.volume_24h_display ?? null,
      liquidity_display: row.liquidity_display ?? null,
      fifa_section: row.fifa_section,
      fifa_subtype: row.fifa_subtype,
      fifa_source_rule: row.fifa_source_rule,
      fifa_confidence: row.fifa_confidence,
      search_rank: row.search_rank ?? null,
      match_intent_rank: row.match_intent_rank ?? null,
    })),
  );
}

function buildHydratedProjection(keySource: string): string {
  return `
    select
      e.id as event_id,
      e.title as event_title,
      e.duration_minutes as event_duration_minutes,
      e.category,
      e.start_date,
      e.end_date,
      case when e.liquidity >= 9e16 then null else e.liquidity end as event_liquidity,
      k.event_liquidity_display as event_liquidity_display,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      k.event_volume_display as event_volume_display,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      e.venue as event_venue,
      e.venue_event_id,
      e.series_key as event_series_key,
      e.series_title as event_series_title,
      m.id as market_uuid,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.market_type as market_type,
      m.duration_minutes as market_duration_minutes,
      m.status as market_status,
      pm.accepting_orders as pm_accepting_orders,
      m.open_time as market_open_time,
      m.close_time as market_close_time,
      m.expiration_time as market_expiration_time,
      m.volume_24h,
      m.volume_total,
      k.volume_display as volume_display,
      m.open_interest,
      m.liquidity,
      k.liquidity_display as liquidity_display,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      m.last_price,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      null::numeric as change_24h,
      m.outcomes,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null then (m.clob_token_ids::jsonb->>0)
        else m.token_yes
      end as token_yes,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null then (m.clob_token_ids::jsonb->>1)
        else m.token_no
      end as token_no,
      m.clob_token_ids,
      m.condition_id,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata as market_metadata,
      coalesce(m.metadata->>'venueExchange', e.metadata->>'venueExchange') as venue_exchange,
      coalesce(m.metadata->>'venueAdapter', e.metadata->>'venueAdapter') as venue_adapter,
      m.metadata->>'address' as market_address,
      m.metadata->>'tradeType' as trade_type,
      m.updated_at as last_update,
      m.created_at as market_created_at,
      coalesce(m.close_time, m.expiration_time, e.end_date) as sort_time,
      k.volume_24h_display as volume_24h_display,
      k.fifa_section::text as fifa_section,
      k.fifa_subtype::text as fifa_subtype,
      k.fifa_source_rule::text as fifa_source_rule,
      k.fifa_confidence::text as fifa_confidence,
      k.search_rank as search_rank,
      k.ord as ord,
      coalesce(k.market_rank, 1) as market_rank
    from ${keySource} k
    join unified_markets m on m.id = k.market_uuid
    join unified_events e on e.id = k.event_id
    left join polymarket_markets pm on pm.id = m.venue_market_id and m.venue = 'polymarket'
    left join unified_token_top_latest yes_top on yes_top.token_id = (
      case when m.venue = 'polymarket' and m.clob_token_ids is not null then (m.clob_token_ids::jsonb->>0) else m.token_yes end
    )
    left join unified_token_top_latest no_top on no_top.token_id = (
      case when m.venue = 'polymarket' and m.clob_token_ids is not null then (m.clob_token_ids::jsonb->>1) else m.token_no end
    )
  `;
}

function buildSectionFacetsFromRows(
  rows: FifaFacetCandidateRow[],
): FifaSpecialPage["sectionFacets"] {
  const counts = new Map<
    string,
    { eventIds: Set<string>; marketIds: Set<string> }
  >();
  for (const row of rows) {
    const key = row.fifa_section;
    const entry =
      counts.get(key) ??
      { eventIds: new Set<string>(), marketIds: new Set<string>() };
    entry.eventIds.add(row.event_id);
    entry.marketIds.add(row.market_uuid);
    counts.set(key, entry);
  }
  return Array.from(counts.entries())
    .map(([section, entry]) => ({
      section: section as FifaSection,
      events: entry.eventIds.size,
      markets: entry.marketIds.size,
    }))
    .sort((a, b) => b.markets - a.markets || a.section.localeCompare(b.section));
}

function buildVenueFacetsFromRows(
  rows: FifaFacetCandidateRow[],
): FifaSpecialPage["venueFacets"] {
  const counts = new Map<
    string,
    { eventIds: Set<string>; marketIds: Set<string> }
  >();
  for (const row of rows) {
    const key = row.venue;
    const entry =
      counts.get(key) ??
      { eventIds: new Set<string>(), marketIds: new Set<string>() };
    entry.eventIds.add(row.event_id);
    entry.marketIds.add(row.market_uuid);
    counts.set(key, entry);
  }
  return Array.from(counts.entries())
    .map(([venue, entry]) => ({
      venue,
      events: entry.eventIds.size,
      markets: entry.marketIds.size,
    }))
    .sort((a, b) => b.markets - a.markets || a.venue.localeCompare(b.venue));
}

async function fetchFacets(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<Pick<FifaSpecialPage, "sectionFacets" | "venueFacets">> {
  if (hasMetadataFilters(inputs)) {
    return fetchMetadataFilteredFacets(pool, inputs);
  }

  const sectionBuilder = createParamBuilder();
  const sectionBase = buildBaseSql({
    inputs,
    add: sectionBuilder.add,
    ignoreSections: true,
  });
  const sectionSql = `
    with ${sectionBase.cte ? `${sectionBase.cte},` : ""}
    candidate_facets as materialized (${buildCandidateKeyProjection(sectionBase, "facet")})
    select
      fifa_section as section,
      count(distinct event_id)::int as events,
      count(distinct market_uuid)::int as markets
    from candidate_facets
    group by section
    order by markets desc, section
  `;

  const venueBuilder = createParamBuilder();
  const venueBase = buildBaseSql({
    inputs,
    add: venueBuilder.add,
    ignoreVenues: true,
  });
  const venueSql = `
    with ${venueBase.cte ? `${venueBase.cte},` : ""}
    candidate_facets as materialized (${buildCandidateKeyProjection(venueBase, "facet")})
    select
      venue,
      count(distinct event_id)::int as events,
      count(distinct market_uuid)::int as markets
    from candidate_facets
    group by venue
    order by markets desc, venue
  `;

  const [sectionResult, venueResult] = await Promise.all([
    queryFifaRows<FifaSpecialPage["sectionFacets"][number]>(
      pool,
      sectionSql,
      sectionBuilder.params,
    ),
    queryFifaRows<FifaSpecialPage["venueFacets"][number]>(
      pool,
      venueSql,
      venueBuilder.params,
    ),
  ]);
  return {
    sectionFacets: sectionResult as FifaSpecialPage["sectionFacets"],
    venueFacets: venueResult as FifaSpecialPage["venueFacets"],
  };
}

async function fetchMetadataFilteredFacets(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<Pick<FifaSpecialPage, "sectionFacets" | "venueFacets">> {
  const buildRows = async (options: { ignoreSections?: boolean; ignoreVenues?: boolean }) => {
    const builder = createParamBuilder();
    const base = buildBaseSql({
      inputs,
      add: builder.add,
      ignoreSections: options.ignoreSections,
      ignoreVenues: options.ignoreVenues,
    });
    const sql = `
      with ${base.cte ? `${base.cte},` : ""}
      candidate_markets as materialized (${buildCandidateKeyProjection(base)})
      select *
      from candidate_markets
    `;
    const rows = await queryFifaRows<FifaCandidateRow>(pool, sql, builder.params);
    return rows.filter((row) => rowMatchesMetadataFilters(row, inputs));
  };

  const [sectionRows, venueRows] = await Promise.all([
    buildRows({ ignoreSections: true }),
    buildRows({ ignoreVenues: true }),
  ]);

  return {
    sectionFacets: buildSectionFacetsFromRows(sectionRows),
    venueFacets: buildVenueFacetsFromRows(venueRows),
  };
}

async function hydrateSelectedCandidateRows(
  pool: Pool,
  rows: FifaCandidateRow[],
): Promise<FifaSpecialRow[]> {
  if (rows.length === 0) return [];
  const builder = createParamBuilder();
  const selectedRowsParam = builder.add(serializeSelectedCandidateRows(rows));
  const sql = `
    with selected_market_keys as materialized (${selectedMarketKeysFromJson(selectedRowsParam)})
    select *
    from (${buildHydratedProjection("selected_market_keys")}) hydrated
    order by ord, market_rank, market_uuid
  `;
  return queryFifaRows<FifaSpecialRow>(pool, sql, builder.params);
}

function selectedEventKeysFromJson(jsonParam: string): string {
  return `
    select *
    from jsonb_to_recordset(${jsonParam}::jsonb) as e(
      ord int,
      event_id text
    )
  `;
}

function serializeSelectedEventRows(rows: Array<{ event_id: string; ord: unknown }>): string {
  return JSON.stringify(
    rows.map((row, index) => ({
      ord: candidateNumber(row.ord) ?? index + 1,
      event_id: row.event_id,
    })),
  );
}

async function fetchCandidateRows(
  pool: Pool,
  inputs: FifaSpecialInputs,
  options: { ignoreSections?: boolean; ignoreVenues?: boolean } = {},
): Promise<FifaCandidateRow[]> {
  const builder = createParamBuilder();
  const base = buildBaseSql({
    inputs,
    add: builder.add,
    ignoreSections: options.ignoreSections,
    ignoreVenues: options.ignoreVenues,
  });
  const sql = `
    with ${base.cte ? `${base.cte},` : ""}
    candidate_keys as materialized (${buildCandidateKeyProjection(base)})
    select *
    from candidate_keys
  `;
  return queryFifaRows<FifaCandidateRow>(pool, sql, builder.params);
}

async function fetchCount(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<number> {
  const builder = createParamBuilder();
  const base = buildBaseSql({ inputs, add: builder.add });
  const totalSql =
    inputs.view === "markets"
      ? "select count(*)::int as total from candidate_keys"
      : "select count(distinct event_id)::int as total from candidate_keys";
  const sql = `
    with ${base.cte ? `${base.cte},` : ""}
    candidate_keys as materialized (${buildCandidateKeyProjection(base, "count")})
    ${totalSql};
  `;
  const rows = await queryFifaRows<{ total: number }>(pool, sql, builder.params);
  return rows[0]?.total ?? 0;
}

async function fetchMarketPageCandidateRows(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<FifaCandidateRow[]> {
  const builder = createParamBuilder();
  const base = buildBaseSql({ inputs, add: builder.add });
  const orderSql = buildOrderSql(inputs, "market");
  const limitParam = builder.add(inputs.limit);
  const offsetParam = builder.add(inputs.offset);
  const sql = `
    with ${base.cte ? `${base.cte},` : ""}
    candidate_keys as materialized (${buildCandidateKeyProjection(base)}),
      page_markets as materialized (
        select page.*, row_number() over () as ord
        from (
          select market_uuid
          from candidate_keys
          order by ${orderSql}
          limit ${limitParam} offset ${offsetParam}
        ) page
      ),
      selected_market_keys as materialized (
        select c.*, p.ord, 1::int as market_rank
        from page_markets p
        join candidate_keys c on c.market_uuid = p.market_uuid
      )
    select *
    from selected_market_keys
    order by ord, market_uuid
  `;
  return queryFifaRows<FifaCandidateRow>(pool, sql, builder.params);
}

async function fetchEventPageEvents(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<Array<{ event_id: string; ord: number }>> {
  const builder = createParamBuilder();
  const base = buildBaseSql({ inputs, add: builder.add });
  const orderSql = buildOrderSql(inputs, "event");
  const limitParam = builder.add(inputs.limit);
  const offsetParam = builder.add(inputs.offset);
  const sql = `
    with ${base.cte ? `${base.cte},` : ""}
    candidate_keys as materialized (${buildCandidateKeyProjection(base)}),
      page_events as materialized (
        select page.*, row_number() over () as ord
        from (
          select *
          from (${buildGroupedEventCandidatesSql("candidate_keys")}) grouped_events
          order by ${orderSql}
          limit ${limitParam} offset ${offsetParam}
        ) page
      )
    select event_id, ord
    from page_events
    order by ord
  `;
  return queryFifaRows<{ event_id: string; ord: number }>(
    pool,
    sql,
    builder.params,
  );
}

async function fetchEventCandidateRowsForEvents(
  pool: Pool,
  inputs: FifaSpecialInputs,
  pageEvents: Array<{ event_id: string; ord: unknown }>,
): Promise<FifaCandidateRow[]> {
  if (pageEvents.length === 0) return [];
  const builder = createParamBuilder();
  const pageEventsParam = builder.add(serializeSelectedEventRows(pageEvents));
  const eventIdsParam = builder.add(pageEvents.map((event) => event.event_id));
  const base = buildBaseSql({ inputs, add: builder.add });
  base.where.push(`e.id = ANY(${eventIdsParam}::text[])`);
  const sql = `
    with page_events as materialized (${selectedEventKeysFromJson(pageEventsParam)}),
    ${base.cte ? `${base.cte},` : ""}
    candidate_keys as materialized (${buildCandidateKeyProjection(base)}),
      selected_market_keys as materialized (
        select
          c.*,
          p.ord,
          row_number() over (
            partition by c.event_id
            order by coalesce(c.volume_display, 0) desc, c.market_uuid
          ) as market_rank
        from page_events p
        join candidate_keys c on c.event_id = p.event_id
      )
    select *
    from selected_market_keys
    where market_rank <= 100
    order by
      ord,
      market_rank,
      market_uuid
  `;
  return queryFifaRows<FifaCandidateRow>(pool, sql, builder.params);
}

async function fetchEventPageCandidateRows(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<FifaCandidateRow[]> {
  const pageEvents = await fetchEventPageEvents(pool, inputs);
  return fetchEventCandidateRowsForEvents(pool, inputs, pageEvents);
}

async function fetchSearchFifaSpecialPage(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<FifaSpecialPage> {
  const allRows = await fetchCandidateRows(pool, inputs, {
    ignoreSections: true,
    ignoreVenues: true,
  });
  const pageBaseRows = allRows.filter((row) =>
    rowMatchesRuntimeFilters(row, inputs, {
      applyMetadata: false,
    }),
  );
  const orderedRows = orderCandidateRows(pageBaseRows, inputs);
  const metadataFilteredRows = hasMetadataFilters(inputs)
    ? orderedRows.filter((row) => rowMatchesMetadataFilters(row, inputs))
    : orderedRows;
  const page = paginateOrderedRows(metadataFilteredRows, inputs, {
    capEventMarkets: inputs.view === "events" && !hasMetadataFilters(inputs),
  });

  const sectionFacetRows = allRows.filter((row) =>
    rowMatchesRuntimeFilters(row, inputs, {
      ignoreSections: true,
      applyMetadata: true,
    }),
  );
  const venueFacetRows = allRows.filter((row) =>
    rowMatchesRuntimeFilters(row, inputs, {
      ignoreVenues: true,
      applyMetadata: true,
    }),
  );
  const rows = await hydrateSelectedCandidateRows(pool, page.rows);
  return {
    rows,
    total: page.total,
    sectionFacets: buildSectionFacetsFromRows(sectionFacetRows),
    venueFacets: buildVenueFacetsFromRows(venueFacetRows),
  };
}

async function fetchMetadataFilteredPage(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<FifaSpecialPage> {
  const [candidateRows, facets] = await Promise.all([
    fetchCandidateRows(pool, inputs, { ignoreSections: true }),
    fetchMetadataFilteredFacets(pool, inputs),
  ]);
  const pageBaseRows = candidateRows.filter((row) =>
    rowMatchesRuntimeFilters(row, inputs, {
      applyMetadata: false,
    }),
  );
  const orderedRows = orderCandidateRows(pageBaseRows, inputs);
  const filteredRows = orderedRows.filter((row) =>
    rowMatchesMetadataFilters(row, inputs),
  );
  const page = paginateOrderedRows(filteredRows, inputs, {
    capEventMarkets: false,
  });
  const rows = await hydrateSelectedCandidateRows(pool, page.rows);
  return {
    rows,
    total: page.total,
    ...facets,
  };
}

export async function fetchFifaSpecialPage(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<FifaSpecialPage> {
  if (inputs.q) {
    return fetchSearchFifaSpecialPage(pool, inputs);
  }

  if (hasMetadataFilters(inputs)) {
    return fetchMetadataFilteredPage(pool, inputs);
  }

  const [candidateRows, total, facets] = await Promise.all([
    inputs.view === "markets"
      ? fetchMarketPageCandidateRows(pool, inputs)
      : fetchEventPageCandidateRows(pool, inputs),
    fetchCount(pool, inputs),
    fetchFacets(pool, inputs),
  ]);
  const rows = await hydrateSelectedCandidateRows(pool, candidateRows);

  return {
    rows,
    total,
    ...facets,
  };
}

function parseDateFromPolymarketSlug(slug: string | null): string | null {
  return slug?.match(/(20\d{2}-\d{2}-\d{2})/)?.[1] ?? null;
}

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

const FIFA_2026_GROUPS: Record<string, string[]> = {
  A: ["Mexico", "South Korea", "South Africa", "Czechia"],
  B: ["Canada", "Qatar", "Bosnia and Herzegovina", "Switzerland"],
  C: ["Scotland", "Brazil", "Haiti", "Morocco"],
  D: ["Paraguay", "Turkiye", "USA", "Australia"],
  E: ["Curacao", "Ecuador", "Germany", "Ivory Coast"],
  F: ["Tunisia", "Japan", "Netherlands", "Sweden"],
  G: ["New Zealand", "Iran", "Egypt", "Belgium"],
  H: ["Cape Verde", "Uruguay", "Spain", "Saudi Arabia"],
  I: ["Senegal", "Norway", "France", "Iraq"],
  J: ["Algeria", "Jordan", "Argentina", "Austria"],
  K: ["Colombia", "Congo DR", "Portugal", "Uzbekistan"],
  L: ["England", "Ghana", "Croatia", "Panama"],
};

const TEAM_TO_GROUP = new Map(
  Object.entries(FIFA_2026_GROUPS).flatMap(([groupCode, teams]) =>
    teams.map((team) => [canonicalSportsTeamKey(team), { groupCode, team }] as const),
  ),
);

function parseDateFromKalshiTicker(ticker: string | null): string | null {
  const match = ticker?.match(/-26([A-Z]{3})(\d{2})/);
  if (!match) return null;
  const month = MONTHS[match[1]];
  if (!month) return null;
  return `2026-${month}-${match[2]}`;
}

function parseTeamsFromTitle(title: string | null): {
  homeTeam: string | null;
  awayTeam: string | null;
} {
  if (!title) return { homeTeam: null, awayTeam: null };
  const clean = title
    .replace(
      /\s+-\s+(More Markets|Exact Score|First Team to Score|First to Score|Player Props|Corners|Halftime|First Half)$/i,
      "",
    )
    .split(":")[0]
    ?.trim();
  const match = clean.match(/^(.+?)\s+vs\.?\s+(.+?)$/i);
  if (!match) return { homeTeam: null, awayTeam: null };
  return { homeTeam: match[1].trim(), awayTeam: match[2].trim() };
}

function slugifyKey(value: string): string {
  return slugifySportsKey(value);
}

type FifaMetaScope = "event" | "market";

function parseGroupCodeFromText(value: string): string | null {
  const match = value.match(/\bgroup\s+([a-l])\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function parseGroupCodeFromKalshiTicker(value: string | null): string | null {
  const match = value?.match(/\bKXWCGROUP(?:WIN|QUAL|BOTTOM|ORDER|WINNER)-26([A-L])(?:-|$)/i);
  return match?.[1]?.toUpperCase() ?? null;
}

function parseGroupTeamsFromText(value: string): string[] | null {
  const match = value.match(/\bgroup\s+[a-l]\s*\(([^)]+)\)/i);
  if (!match) return null;
  const teams = match[1]
    .split(",")
    .map((team) => team.trim())
    .filter(Boolean);
  return teams.length ? teams : null;
}

function resolveGroupMarketType(value: string):
  | "winner"
  | "qualify"
  | "bottom"
  | "order"
  | "champion_group"
  | "second_place"
  | "last_place"
  | "highest_scoring_team"
  | "unknown" {
  if (/\bgroup\s+of\s+champion\b/i.test(value)) return "champion_group";
  if (/\bhighest[-\s]scoring\s+team\b/i.test(value)) return "highest_scoring_team";
  if (/\bsecond\s+place\b/i.test(value)) return "second_place";
  if (/\b(last\s+place|bottom)\b/i.test(value)) return "last_place";
  if (/\bqualif/i.test(value)) return "qualify";
  if (/\bbottom\b/i.test(value)) return "bottom";
  if (/\border\b/i.test(value)) return "order";
  if (/\bwinners?\b|\bwin\b/i.test(value)) return "winner";
  return "unknown";
}

function resolveGroupInfo(row: FifaMetaRow, scope: FifaMetaScope): {
  groupCode: string | null;
  groupTeams: string[] | null;
  groupMarketType: FifaMeta["groupMarketType"];
} {
  if (row.fifa_section !== "group") {
    return { groupCode: null, groupTeams: null, groupMarketType: null };
  }
  const eventText = `${row.event_title ?? ""} ${row.event_slug ?? ""} ${row.venue_event_id ?? ""}`;
  const marketText = `${row.market_title ?? ""} ${row.market_slug ?? ""} ${row.venue_market_id ?? ""}`;
  const text = scope === "market" ? `${eventText} ${marketText}` : eventText;
  const groupCode =
    parseGroupCodeFromText(text) ??
    parseGroupCodeFromKalshiTicker(row.venue_event_id) ??
    (scope === "market" ? parseGroupCodeFromText(marketText) : null);
  const groupTeams =
    (scope === "market" ? parseGroupTeamsFromText(marketText) : null) ??
    (groupCode ? FIFA_2026_GROUPS[groupCode] ?? null : null);
  return {
    groupCode,
    groupTeams,
    groupMarketType: resolveGroupMarketType(text),
  };
}

function resolveKnownTeamName(value: string | null): { teamName: string; teamGroupCode: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || /^draw\b/i.test(trimmed)) return null;
  const known = TEAM_TO_GROUP.get(canonicalSportsTeamKey(trimmed));
  if (!known) return null;
  return { teamName: known.team, teamGroupCode: known.groupCode };
}

function buildGroupMeta(input: {
  section: FifaSection;
  matchDate: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  eventTitle: string | null;
  groupCode: string | null;
  groupMarketType: FifaMeta["groupMarketType"];
}): Pick<FifaMeta, "groupType" | "groupKey" | "groupLabel"> {
  const title = input.eventTitle?.trim() || input.section;
  if (input.matchDate && input.homeTeam && input.awayTeam) {
    return {
      groupType: "match",
      groupKey: buildMatchFixtureKey({
        localDate: input.matchDate,
        homeTeam: input.homeTeam,
        awayTeam: input.awayTeam,
      }),
      groupLabel: `${input.homeTeam} vs. ${input.awayTeam}`,
    };
  }

  if (input.section === "winner") {
    const continent = /continent/i.test(title);
    return {
      groupType: "outright",
      groupKey: continent ? "outright:continent-winner" : "outright:world-cup-winner",
      groupLabel: continent ? "World Cup Continent Winner" : "World Cup Winner",
    };
  }

  if (input.section === "group") {
    const group =
      input.groupCode ?? title.match(/\bgroup\s+([a-l])\b/i)?.[1]?.toUpperCase();
    const kind =
      input.groupMarketType && input.groupMarketType !== "unknown"
        ? input.groupMarketType
        : /qualif/i.test(title)
          ? "qualify"
          : null;
    const groupKey = group
      ? `group:${group.toLowerCase()}${kind ? `:${kind}` : ""}`
      : `group:${slugifyKey(title)}`;
    const kindLabel =
      kind === "qualify"
        ? "Qualify"
        : kind === "champion_group"
          ? "Champion Group"
          : kind === "bottom"
            ? "Bottom"
            : kind === "last_place"
              ? "Last Place"
              : kind === "second_place"
                ? "Second Place"
                : kind === "highest_scoring_team"
                  ? "Highest-Scoring Team"
            : kind === "order"
              ? "Order"
              : kind === "winner"
                ? "Winner"
                : "Markets";
    return {
      groupType: "group",
      groupKey,
      groupLabel: group ? `Group ${group} ${kindLabel}` : title,
    };
  }

  return {
    groupType: input.section,
    groupKey: `${input.section}:${slugifyKey(title)}`,
    groupLabel: title,
  };
}

function parseLine(row: FifaMetaRow): number | null {
  const title = row.market_title ?? "";
  const slug = row.market_slug ?? "";
  const subtype = row.fifa_subtype;

  if (subtype === "total" || subtype === "team_total") {
    const titleMatch = title.match(/\b(?:O\/U|Over\/Under|Over|Under)\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (titleMatch) return Number(titleMatch[1]);
    const slugMatch = slug.match(/\b(?:o-u|over-under|over|under)-(\d+)(?:pt(\d+))?\b/i);
    if (slugMatch) return Number(slugMatch[2] ? `${slugMatch[1]}.${slugMatch[2]}` : slugMatch[1]);
  }

  if (subtype === "spread") {
    const titleMatch = title.match(/\(([+-]\d+(?:\.\d+)?)\)/);
    if (titleMatch) return Number(titleMatch[1]);
  }

  if (subtype === "player_goal_or_assist") {
    const titleMatch = title.match(/\b([0-9]+(?:\.[0-9]+)?)\s+(?:or\s+more|goals?|assists?)\b/i);
    if (titleMatch) return Number(titleMatch[1]);
  }

  return null;
}

function resolveEntity(row: FifaMetaRow): string | null {
  const title = row.market_title?.trim();
  if (!title) return null;
  if (row.fifa_section === "match_prop") {
    const totalMatch = title.match(/^(.+?)\s+O\/U\s+/i);
    if (totalMatch) return totalMatch[1].trim();
    return null;
  }
  const lower = title.toLowerCase();
  if (lower === "tie" || lower === "draw" || lower.startsWith("draw ")) {
    return "Draw";
  }
  return title;
}

export function buildFifaMeta(
  row: FifaMetaRow,
  options: { scope?: FifaMetaScope } = {},
): FifaMeta {
  const scope = options.scope ?? "event";
  const isRealMatchSection =
    row.fifa_section === "match_result" || row.fifa_section === "match_prop";
  const matchDate =
    isRealMatchSection
      ? parseDateFromPolymarketSlug(row.event_slug) ??
        parseDateFromKalshiTicker(row.venue_event_id) ??
        parseDateFromPolymarketSlug(row.market_slug)
      : null;
  const teams = parseTeamsFromTitle(row.event_title);
  const fixtureTeams = parseSportsMatchTeamsFromTitle(row.event_title);
  const matchKey =
    matchDate && teams.homeTeam && teams.awayTeam
      ? `${matchDate}:${slugifyKey(teams.homeTeam)}:${slugifyKey(teams.awayTeam)}`
      : null;
  const matchFixtureKey =
    matchDate && fixtureTeams.homeTeam && fixtureTeams.awayTeam
      ? buildMatchFixtureKey({
          localDate: matchDate,
          homeTeam: fixtureTeams.homeTeam,
          awayTeam: fixtureTeams.awayTeam,
        })
      : null;
  const groupInfo = resolveGroupInfo(row, scope);
  const entity = resolveEntity(row);
  const team = scope === "market" ? resolveKnownTeamName(entity) : null;
  const group = buildGroupMeta({
    section: row.fifa_section,
    matchDate,
    homeTeam: teams.homeTeam,
    awayTeam: teams.awayTeam,
    eventTitle: row.event_title,
    groupCode: groupInfo.groupCode,
    groupMarketType: groupInfo.groupMarketType,
  });
  return {
    section: row.fifa_section,
    subtype: row.fifa_subtype,
    ...group,
    groupCode: groupInfo.groupCode,
    groupTeams: groupInfo.groupTeams,
    groupMarketType: groupInfo.groupMarketType,
    matchKey,
    matchFixtureKey,
    matchDate,
    homeTeam: isRealMatchSection ? fixtureTeams.homeTeam ?? teams.homeTeam : null,
    awayTeam: isRealMatchSection ? fixtureTeams.awayTeam ?? teams.awayTeam : null,
    teamName: team?.teamName ?? null,
    teamGroupCode: team?.teamGroupCode ?? null,
    entity,
    line: parseLine(row),
    sourceRule: row.fifa_source_rule,
    confidence: row.fifa_confidence,
  };
}

export function resolveTokenPair(row: Pick<FifaSpecialRow, "token_yes" | "token_no" | "clob_token_ids">): TokenPair {
  const tokens: TokenPair = {
    yes: row.token_yes != null ? String(row.token_yes) : null,
    no: row.token_no != null ? String(row.token_no) : null,
  };
  if ((!tokens.yes || !tokens.no) && row.clob_token_ids) {
    try {
      const parsed = Array.isArray(row.clob_token_ids)
        ? row.clob_token_ids
        : JSON.parse(String(row.clob_token_ids));
      if (Array.isArray(parsed)) {
        if (!tokens.yes && parsed[0] != null) tokens.yes = String(parsed[0]);
        if (!tokens.no && parsed[1] != null) tokens.no = String(parsed[1]);
      }
    } catch {
      // Ignore malformed venue token metadata.
    }
  }
  return tokens;
}
