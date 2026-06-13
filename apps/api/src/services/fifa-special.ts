import type { Pool } from "@hunch/infra";
import { buildRenderableMarketSql } from "../lib/market-renderability.js";
import type { PgParams, TokenPair } from "../server-types.js";
import type { FifaSection } from "../schemas/special.js";
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

function buildNativeTradableMarketSql(alias: string): string {
  return `(
    ${alias}.venue <> 'kalshi'
    or lower(coalesce(${alias}.metadata->>'dflowNativeAcceptingOrders', 'false')) = 'true'
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
      and (
        lower(coalesce(e.title, '')) like '%fifa world cup%'
        or lower(coalesce(e.slug, '')) like '%fifa-world-cup%'
        or lower(coalesce(e.title, '')) like '%2026 fifa world cup%'
        or lower(coalesce(e.slug, '')) like '%2026-fifa-world-cup%'
      )
    )
  )`;
}

function buildFifaSectionSql(): string {
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
      when lower(coalesce(e.title, '') || ' ' || coalesce(m.title, '') || ' ' || coalesce(e.slug, '') || ' ' || coalesce(m.slug, '')) like '%group%' then 'group'
      when lower(coalesce(e.title, '') || ' ' || coalesce(m.title, '') || ' ' || coalesce(e.slug, '') || ' ' || coalesce(m.slug, '')) ~ '(reach|advance|knockout|round of|quarterfinal|semifinal|final)' then 'stage'
      when lower(coalesce(e.title, '') || ' ' || coalesce(m.title, '') || ' ' || coalesce(e.slug, '') || ' ' || coalesce(m.slug, '')) ~ '(award|golden boot|golden ball|top goalscorer|most assists|goal leader|score 5|assist)' then 'player_award'
      when lower(coalesce(e.title, '') || ' ' || coalesce(m.title, '') || ' ' || coalesce(e.slug, '') || ' ' || coalesce(m.slug, '')) ~ '(squad|\\mplay\\M)' then 'squad'
      when lower(coalesce(e.title, '') || ' ' || coalesce(m.title, '') || ' ' || coalesce(e.slug, '') || ' ' || coalesce(m.slug, '')) ~ '(winner|champion|continent will win)' then 'winner'
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
      when e.venue = 'limitless' then 'limitless_exact_fifa_text'
      else 'fallback'
    end
  `;
}

function buildSearchSql(q: string | undefined, add: ParamBuilder["add"]): {
  cte: string;
  join: string;
  predicate: string;
  rankExpr: string;
} {
  if (!q) {
    return { cte: "", join: "", predicate: "true", rankExpr: "0" };
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
  const docExpr = `
    setweight(to_tsvector('english', coalesce(e.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(e.slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(m.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(m.slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(e.series_title, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(e.category, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(e.description, '')), 'D') ||
    setweight(to_tsvector('english', coalesce(m.description, '')), 'D')
  `;
  return {
    cte: `
      search_query as materialized (
        select
          websearch_to_tsquery('english', ${searchParam}::text) as query,
          case
            when ${prefixParam}::text is null then null::tsquery
            else to_tsquery('english', ${prefixParam}::text)
          end as prefix_query
      )
    `,
    join: "cross join search_query sq",
    predicate: `(
      (querytree(sq.query) <> '' and (${docExpr}) @@ sq.query)
      or (sq.prefix_query is not null and querytree(sq.prefix_query) <> '' and (${docExpr}) @@ sq.prefix_query)
    )`,
    rankExpr: `
      greatest(
        case when querytree(sq.query) <> '' then ts_rank_cd((${docExpr}), sq.query) else 0 end,
        case when sq.prefix_query is not null and querytree(sq.prefix_query) <> '' then ts_rank_cd((${docExpr}), sq.prefix_query) else 0 end
      )
    `,
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
  searchRankExpr: string;
} {
  const { inputs, add, ignoreSections = false, ignoreVenues = false } = args;
  const nowParam = add(inputs.nowParam);
  const sectionExpr = buildFifaSectionSql();
  const subtypeExpr = buildFifaSubtypeSql();
  const sourceRuleExpr = buildFifaSourceRuleSql();
  const search = buildSearchSql(inputs.q, add);
  const where = [
    "e.status = 'ACTIVE'",
    "m.status = 'ACTIVE'",
    `(e.end_date is null or e.end_date > ${nowParam}::timestamptz)`,
    `(m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)`,
    `(m.close_time is null or m.close_time > ${nowParam}::timestamptz)`,
    buildNativeTradableMarketSql("m"),
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
    searchRankExpr: search.rankExpr,
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

function hasMetadataFilters(inputs: FifaSpecialInputs): boolean {
  return Boolean(inputs.groupCodes?.length || inputs.teamGroupCodes?.length);
}

function rowMatchesMetadataFilters(row: FifaSpecialRow, inputs: FifaSpecialInputs): boolean {
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

function paginateFilteredRows(
  rows: FifaSpecialRow[],
  inputs: FifaSpecialInputs,
): { rows: FifaSpecialRow[]; total: number } {
  const filtered = rows.filter((row) => rowMatchesMetadataFilters(row, inputs));
  if (inputs.view === "markets") {
    return {
      rows: filtered.slice(inputs.offset, inputs.offset + inputs.limit),
      total: filtered.length,
    };
  }

  const selectedEventIds = new Set<string>();
  const eventOrder: string[] = [];
  for (const row of filtered) {
    if (selectedEventIds.has(row.event_id)) continue;
    selectedEventIds.add(row.event_id);
    eventOrder.push(row.event_id);
  }
  const pageEventIds = new Set(
    eventOrder.slice(inputs.offset, inputs.offset + inputs.limit),
  );
  return {
    rows: filtered.filter((row) => pageEventIds.has(row.event_id)),
    total: eventOrder.length,
  };
}

function buildCandidateProjection(base: ReturnType<typeof buildBaseSql>): string {
  return `
    select
      e.id as event_id,
      e.title as event_title,
      e.duration_minutes as event_duration_minutes,
      e.category,
      e.start_date,
      e.end_date,
      case when e.liquidity >= 9e16 then null else e.liquidity end as event_liquidity,
      coalesce(nullif(case when e.liquidity >= 9e16 then null else e.liquidity end, 0), nullif(e.open_interest, 0)) as event_liquidity_display,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      coalesce(nullif(e.volume_total, 0), nullif(sum(coalesce(m.volume_total, 0)) over (partition by e.id), 0)) as event_volume_display,
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
      case when m.volume_total is not null and m.volume_total > 0 then m.volume_total else null end as volume_display,
      m.open_interest,
      m.liquidity,
      coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0)) as liquidity_display,
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
      coalesce(m.volume_24h, 0) as volume_24h_display,
      (${base.sectionExpr})::text as fifa_section,
      (${base.subtypeExpr})::text as fifa_subtype,
      (${base.sourceRuleExpr})::text as fifa_source_rule,
      case
        when e.venue in ('polymarket', 'kalshi') then 'high'
        when e.venue = 'limitless' then 'medium'
        else 'low'
      end::text as fifa_confidence,
      (${base.searchRankExpr}) as search_rank
    from unified_events e
    join unified_markets m on m.event_id = e.id
    ${base.cte ? "cross join search_query sq" : ""}
    left join polymarket_markets pm on pm.id = m.venue_market_id and m.venue = 'polymarket'
    left join unified_token_top_latest yes_top on yes_top.token_id = (
      case when m.venue = 'polymarket' and m.clob_token_ids is not null then (m.clob_token_ids::jsonb->>0) else m.token_yes end
    )
    left join unified_token_top_latest no_top on no_top.token_id = (
      case when m.venue = 'polymarket' and m.clob_token_ids is not null then (m.clob_token_ids::jsonb->>1) else m.token_no end
    )
    where ${base.where.join(" and ")}
  `;
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
    ${sectionBase.cte ? `with ${sectionBase.cte}` : ""}
    select
      (${sectionBase.sectionExpr})::text as section,
      count(distinct e.id)::int as events,
      count(distinct m.id)::int as markets
    from unified_events e
    join unified_markets m on m.event_id = e.id
    ${sectionBase.cte ? "cross join search_query sq" : ""}
    where ${sectionBase.where.join(" and ")}
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
    ${venueBase.cte ? `with ${venueBase.cte}` : ""}
    select
      m.venue as venue,
      count(distinct e.id)::int as events,
      count(distinct m.id)::int as markets
    from unified_events e
    join unified_markets m on m.event_id = e.id
    ${venueBase.cte ? "cross join search_query sq" : ""}
    where ${venueBase.where.join(" and ")}
    group by m.venue
    order by markets desc, venue
  `;

  const [sectionResult, venueResult] = await Promise.all([
    pool.query(sectionSql, sectionBuilder.params),
    pool.query(venueSql, venueBuilder.params),
  ]);
  return {
    sectionFacets: sectionResult.rows as FifaSpecialPage["sectionFacets"],
    venueFacets: venueResult.rows as FifaSpecialPage["venueFacets"],
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
      candidate_markets as materialized (${buildCandidateProjection(base)})
      select *
      from candidate_markets
    `;
    const result = await pool.query<FifaSpecialRow>(sql, builder.params);
    return result.rows.filter((row) => rowMatchesMetadataFilters(row, inputs));
  };

  const [sectionRows, venueRows] = await Promise.all([
    buildRows({ ignoreSections: true }),
    buildRows({ ignoreVenues: true }),
  ]);

  const sectionCounts = new Map<
    string,
    { eventIds: Set<string>; marketIds: Set<string> }
  >();
  for (const row of sectionRows) {
    const key = row.fifa_section;
    const entry =
      sectionCounts.get(key) ??
      { eventIds: new Set<string>(), marketIds: new Set<string>() };
    entry.eventIds.add(row.event_id);
    entry.marketIds.add(row.market_uuid);
    sectionCounts.set(key, entry);
  }

  const venueCounts = new Map<
    string,
    { eventIds: Set<string>; marketIds: Set<string> }
  >();
  for (const row of venueRows) {
    const key = row.venue;
    const entry =
      venueCounts.get(key) ??
      { eventIds: new Set<string>(), marketIds: new Set<string>() };
    entry.eventIds.add(row.event_id);
    entry.marketIds.add(row.market_uuid);
    venueCounts.set(key, entry);
  }

  return {
    sectionFacets: Array.from(sectionCounts.entries())
      .map(([section, counts]) => ({
        section: section as FifaSection,
        events: counts.eventIds.size,
        markets: counts.marketIds.size,
      }))
      .sort((a, b) => b.markets - a.markets || a.section.localeCompare(b.section)),
    venueFacets: Array.from(venueCounts.entries())
      .map(([venue, counts]) => ({
        venue,
        events: counts.eventIds.size,
        markets: counts.marketIds.size,
      }))
      .sort((a, b) => b.markets - a.markets || a.venue.localeCompare(b.venue)),
  };
}

export async function fetchFifaSpecialPage(
  pool: Pool,
  inputs: FifaSpecialInputs,
): Promise<FifaSpecialPage> {
  const builder = createParamBuilder();
  const base = buildBaseSql({ inputs, add: builder.add });
  const candidateProjection = buildCandidateProjection(base);
  const orderSql = buildOrderSql(inputs, inputs.view === "markets" ? "market" : "event");
  const withParts: string[] = [];
  if (base.cte) withParts.push(base.cte);
  withParts.push(`candidate_markets as materialized (${candidateProjection})`);

  let pageCte: string;
  let rowSelect: string;
  if (hasMetadataFilters(inputs)) {
    if (inputs.view === "markets") {
      pageCte = "";
      rowSelect = `
        select *
        from candidate_markets
        order by ${orderSql}
      `;
    } else {
      pageCte = `
        page_events as (
          select page.*, row_number() over () as ord
          from (
            select
              event_id,
              max(search_rank) as search_rank,
              min(fifa_section) as section,
              max(coalesce(event_volume_display, 0)) as volume_display,
              max(coalesce(event_volume_24h, 0)) as volume_24h_display,
              max(coalesce(event_liquidity_display, 0)) as liquidity_display,
              min(sort_time) as sort_time,
              min(market_created_at) as created_at
            from candidate_markets
            group by event_id
            order by ${orderSql}
          ) page
        ),
        ranked_event_markets as (
          select
            c.*,
            p.ord,
            row_number() over (
              partition by c.event_id
              order by coalesce(c.volume_display, 0) desc, c.market_uuid
            ) as market_rank
          from candidate_markets c
          join page_events p on p.event_id = c.event_id
        )
      `;
      rowSelect = `
        select *
        from ranked_event_markets
        order by
          ord,
          market_rank,
          market_uuid
      `;
    }
  } else if (inputs.view === "markets") {
    const limitParam = builder.add(inputs.limit);
    const offsetParam = builder.add(inputs.offset);
    pageCte = `
      page_markets as (
        select market_uuid
        from candidate_markets
        order by ${orderSql}
        limit ${limitParam} offset ${offsetParam}
      )
    `;
    rowSelect = `
      select c.*
      from page_markets p
      join candidate_markets c on c.market_uuid = p.market_uuid
      order by ${orderSql}
    `;
  } else {
    const limitParam = builder.add(inputs.limit);
    const offsetParam = builder.add(inputs.offset);
    pageCte = `
      page_events as (
        select page.*, row_number() over () as ord
        from (
          select *
          from (
            select
              event_id,
              max(search_rank) as search_rank,
              min(fifa_section) as section,
              max(coalesce(event_volume_display, 0)) as volume_display,
              max(coalesce(event_volume_24h, 0)) as volume_24h_display,
              max(coalesce(event_liquidity_display, 0)) as liquidity_display,
              min(sort_time) as sort_time,
              min(market_created_at) as created_at
            from candidate_markets
            group by event_id
          ) grouped_events
          order by ${orderSql}
          limit ${limitParam} offset ${offsetParam}
        ) page
      ),
      ranked_event_markets as (
        select
          c.*,
          p.ord,
          row_number() over (
            partition by c.event_id
            order by coalesce(c.volume_display, 0) desc, c.market_uuid
          ) as market_rank
        from candidate_markets c
        join page_events p on p.event_id = c.event_id
      )
    `;
    rowSelect = `
      select *
      from ranked_event_markets
      where market_rank <= 100
      order by
        ord,
        market_rank,
        market_uuid
    `;
  }
  if (pageCte) withParts.push(pageCte);
  const totalSql =
    inputs.view === "markets"
      ? "select count(*)::int as total from candidate_markets"
      : "select count(distinct event_id)::int as total from candidate_markets";
  const sql = `
    with ${withParts.join(",\n")}
    ${rowSelect};
  `;
  const countBuilder = createParamBuilder();
  const countBase = buildBaseSql({ inputs, add: countBuilder.add });
  const countSql = `
    with ${countBase.cte ? `${countBase.cte},` : ""}
    candidate_markets as materialized (${buildCandidateProjection(countBase)})
    ${totalSql};
  `;

  const [rowsResult, countResult, facets] = await Promise.all([
    pool.query<FifaSpecialRow>(sql, builder.params),
    hasMetadataFilters(inputs)
      ? Promise.resolve({ rows: [{ total: 0 }] } as { rows: Array<{ total: number }> })
      : pool.query<{ total: number }>(countSql, countBuilder.params),
    fetchFacets(pool, inputs),
  ]);
  const filteredPage = hasMetadataFilters(inputs)
    ? paginateFilteredRows(rowsResult.rows, inputs)
    : null;

  return {
    rows: filteredPage?.rows ?? rowsResult.rows,
    total: filteredPage?.total ?? countResult.rows[0]?.total ?? 0,
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

function resolveGroupInfo(row: FifaSpecialRow, scope: FifaMetaScope): {
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

function parseLine(row: FifaSpecialRow): number | null {
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

function resolveEntity(row: FifaSpecialRow): string | null {
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
  row: FifaSpecialRow,
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
