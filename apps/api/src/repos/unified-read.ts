import type { Pool } from "@hunch/infra";
import type { QueryResultRow } from "pg";
import { env } from "../env.js";
import {
  buildBroadOrderableMarketSql,
  buildEventHasBroadOrderableMarketSql,
  buildOrderableEventFreshnessSql,
  buildOrderableMarketSql,
  buildPolymarketGraceMarketSql,
  POLYMARKET_ACCEPTING_ORDERS_GRACE_INTERVAL_SQL,
  buildStrictIndexedMarketSql,
} from "../lib/market-availability.js";
import { buildRenderableMarketSql } from "../lib/market-renderability.js";
import type { PgParams } from "../server-types.js";
import { canonicalMarketTokenIdSql } from "./canonical-market-token-sql.js";

export type FeedInputs = {
  limit: number;
  offset: number;
  minVol: number;
  minLiquidity: number;
  marketIds?: string[];
  q?: string;
  view?: "events" | "markets";
  eventScope?: "grouped" | "single";
  venues?: string[];
  category?: string;
  categories?: string[];
  filter?: string;
  sort?: string;
  sortDir?: "asc" | "desc";
  minProb?: number;
  maxProb?: number;
  maxSpread?: number;
  durationMinutes?: number[];
  endWithin?: string;
  ageSince?: string;
  nowParam: string;
  sevenDaysAgo: string;
  sevenDaysFromNow: string;
};

export type FeedFacetInputs = Omit<
  FeedInputs,
  "limit" | "offset" | "sort" | "sortDir" | "category" | "categories"
>;

export type FeedCategoryFacetRow = {
  venue: string;
  category: string;
  events: number;
};

export type FavoriteFeedEventPage = {
  eventIds: string[];
  totalEvents: number;
  totalMarkets: number;
};

const LIMITLESS_AMM_STALE_FALLBACK_INTERVAL = "interval '15 minutes'";
const FEED_HEAVY_QUERY_WORK_MEM = "32MB";
const FEED_EVENT_FAST_MIN_CANDIDATES = 1000;
const FEED_EVENT_FAST_CANDIDATE_FACTOR = 20;
const FEED_EVENT_FAST_MAX_CANDIDATES = 10000;
const FEED_CANDIDATE_EXPANSION_FACTOR = 4;
const FEED_SEARCH_PREFIX_MIN_CHARS = 3;
const FEED_SEARCH_PREFIX_MAX_CHARS = 6;
const FEED_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "will",
  "with",
]);

function buildLimitlessAmmFallbackAllowedExpr(
  nowParam: string,
  yesAlias: string,
  noAlias: string,
): string {
  return `
    not (
      m.venue = 'limitless'
      and coalesce(m.metadata->>'tradeType', 'clob') = 'amm'
      and coalesce(${yesAlias}.best_bid, ${yesAlias}.best_ask, ${noAlias}.best_bid, ${noAlias}.best_ask) is null
      and (m.updated_at is null or m.updated_at <= (${nowParam}::timestamptz - ${LIMITLESS_AMM_STALE_FALLBACK_INTERVAL}))
    )
  `;
}

function createParamBuilder() {
  const params: PgParams = [];
  const add = (value: PgParams[number]): string => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, add };
}

type PgParamAdder = ReturnType<typeof createParamBuilder>["add"];

function buildMarketDurationSql(
  inputs: Pick<FeedInputs, "durationMinutes">,
  add: PgParamAdder,
  alias = "m",
): string | null {
  if (!inputs.durationMinutes?.length) return null;
  return `${alias}.duration_minutes = ANY(${add(inputs.durationMinutes)}::int[])`;
}

function buildFutureEventEndSortSql(alias: string, nowParam: string): string {
  return `case
    when ${alias}.end_date is not null and ${alias}.end_date > ${nowParam}::timestamptz then ${alias}.end_date
    else null
  end`;
}

function buildFutureMarketEndSortSql(nowParam: string): string {
  const sortTime = "coalesce(m.close_time, m.expiration_time, e.end_date)";
  return `case
    when ${sortTime} is not null and ${sortTime} > ${nowParam}::timestamptz then ${sortTime}
    else null
  end`;
}

function buildEventHasOrderableMarketSql(args: {
  eventAlias?: string;
  nowParam: string;
  nowCloseParam?: string;
}): string {
  return buildEventHasBroadOrderableMarketSql({
    ...args,
    renderableMarketSql: buildRenderableMarketSql({ alias: "om" }),
  });
}

export function buildEventDurationExistsSql(args: {
  inputs: Pick<FeedInputs, "durationMinutes">;
  add: PgParamAdder;
  nowParam: string;
}): string | null {
  const durationSql = buildMarketDurationSql(args.inputs, args.add, "dm");
  if (!durationSql) return null;
  return `(
    exists (
      select 1
      from unified_markets dm
      where dm.event_id = e.id
        and ${buildStrictIndexedMarketSql({
          marketAlias: "dm",
          eventAlias: "e",
          nowParam: args.nowParam,
        })}
        and ${buildRenderableMarketSql({ alias: "dm" })}
        and ${durationSql}
    )
    or exists (
      select 1
      from unified_markets dm
      join polymarket_markets pm_dm
        on pm_dm.id = dm.venue_market_id
       and dm.venue = 'polymarket'
      where dm.event_id = e.id
        and ${buildPolymarketGraceMarketSql({
          marketAlias: "dm",
          eventAlias: "e",
          nowParam: args.nowParam,
          pmAlias: "pm_dm",
        })}
        and ${buildRenderableMarketSql({ alias: "dm" })}
        and ${durationSql}
    )
  )`;
}

function buildBroadOrderableMarketCandidatesCte(args: {
  cteName?: string;
  materialized?: boolean;
  nowParam: string;
  nowCloseParam?: string;
  extraMarketSql?: string[];
}): string {
  const cteName = args.cteName ?? "orderable_market_candidates";
  const materialized = args.materialized ? " as materialized" : " as";
  const safeCtePrefix = cteName.replace(/[^a-zA-Z0-9_]/g, "_");
  const strictMarketBaseCte = `${safeCtePrefix}_strict_market_base`;
  const strictCandidatesCte = `${safeCtePrefix}_strict_candidates`;
  const pmRecentCandidatesCte = `${safeCtePrefix}_pm_recent_candidates`;
  const pmGraceCandidatesCte = `${safeCtePrefix}_pm_grace_candidates`;
  const extraSql = (args.extraMarketSql ?? [])
    .filter(Boolean)
    .map((clause) => `and ${clause}`)
    .join("\n        ");
  return `
    ${strictMarketBaseCte} as materialized (
      select
        m.id as market_id,
        m.event_id
      from unified_markets m
      where ${buildStrictIndexedMarketSql({
        marketAlias: "m",
        nowParam: args.nowParam,
        nowCloseParam: args.nowCloseParam,
      })}
    ),
    ${strictCandidatesCte} as materialized (
      select
        c.market_id,
        c.event_id
      from ${strictMarketBaseCte} c
      join unified_markets m on m.id = c.market_id
      join unified_events e on e.id = c.event_id
      where e.status = 'ACTIVE'
        and (e.end_date is null or e.end_date > ${args.nowParam}::timestamptz)
        ${extraSql}
    ),
    ${pmRecentCandidatesCte} as materialized (
      select
        m.id as market_id,
        m.event_id,
        m.venue_market_id
      from unified_markets m
      where m.status = 'ACTIVE'
        and m.venue = 'polymarket'
        and m.close_time is not null
        and m.close_time <= ${args.nowParam}::timestamptz
        and m.close_time > (${args.nowParam}::timestamptz - ${POLYMARKET_ACCEPTING_ORDERS_GRACE_INTERVAL_SQL})
      union all
      select
        m.id as market_id,
        m.event_id,
        m.venue_market_id
      from unified_markets m
      where m.status = 'ACTIVE'
        and m.venue = 'polymarket'
        and m.expiration_time is not null
        and m.expiration_time <= ${args.nowParam}::timestamptz
        and m.expiration_time > (${args.nowParam}::timestamptz - ${POLYMARKET_ACCEPTING_ORDERS_GRACE_INTERVAL_SQL})
      union all
      select
        m.id as market_id,
        m.event_id,
        m.venue_market_id
      from unified_events e
      join unified_markets m on m.event_id = e.id
      where e.status = 'ACTIVE'
        and e.end_date is not null
        and e.end_date <= ${args.nowParam}::timestamptz
        and e.end_date > (${args.nowParam}::timestamptz - ${POLYMARKET_ACCEPTING_ORDERS_GRACE_INTERVAL_SQL})
        and m.status = 'ACTIVE'
        and m.venue = 'polymarket'
    ),
    ${pmGraceCandidatesCte} as materialized (
      select distinct
        m.id as market_id,
        m.event_id
      from ${pmRecentCandidatesCte} c
      join unified_markets m on m.id = c.market_id
      join unified_events e on e.id = m.event_id
      join lateral (
        select
          pm.id,
          pm.accepting_orders,
          pm.active,
          pm.closed,
          pm.archived
        from polymarket_markets pm
        where pm.id = c.venue_market_id
        limit 1
      ) pm_filter on true
      where ${buildPolymarketGraceMarketSql({
        marketAlias: "m",
        eventAlias: "e",
        nowParam: args.nowParam,
        pmAlias: "pm_filter",
      })}
        ${extraSql}
    ),
    ${cteName}${materialized} (
      select market_id, event_id
      from ${strictCandidatesCte}
      union all
      select market_id, event_id
      from ${pmGraceCandidatesCte}
    )
  `;
}

type FeedSqlExpressions = {
  safeEventLiquidityExpr: string;
  eventVolumeDisplayExpr: string;
  marketVolumeDisplayExpr: string;
  eventLiquidityDisplayExpr: string;
  marketLiquidityDisplayExpr: string;
  eventOpenInterestExpr: string;
  eventVolumeSortExpr: string;
  supportedLimitlessMarketExpr: string;
  renderableMarketExpr: string;
  yesMidExpr: string;
};

type FeedSearchContext = {
  hasSearch: boolean;
  searchCte: string;
  searchEventJoin: string;
  searchMarketJoin: string;
  searchFilterExpr: string;
  joinedRankExpr: string;
};

type FeedSearchMode = "ranked" | "membership";
type FeedSearchProfile = "primary" | "full";
type FeedSearchStrategy = "primary_with_fallback" | "full";
type FeedSearchVenueFilterTarget = "event" | "market";

type FeedSearchPlan = {
  hasSearch: boolean;
  rankMode: FeedSearchMode;
  strategy: FeedSearchStrategy;
  searchText: string;
  prefixQueryText: string | null;
};

type FeedSearchEarlyFilterInputs = Pick<
  FeedInputs,
  "venues" | "category" | "categories" | "endWithin" | "ageSince"
>;

type FeedSearchEarlyFilterSql = {
  eventWhere: string[];
  marketWhere: string[];
  fallbackEventWhere: string[];
  fallbackMarketWhere: string[];
  hasDeferredFallbackFilters: boolean;
};

export type FeedCandidateEventSearchFilter = {
  hasSearch: boolean;
  searchCte: string;
  searchEventJoin: string;
  searchFilterExpr: string;
};

export type FeedSearchResultWindow = {
  matchLimit: number | null;
  fallbackThreshold: number | null;
};

type FeedEventFilterInputs = Pick<
  FeedInputs,
  | "venues"
  | "category"
  | "categories"
  | "filter"
  | "durationMinutes"
  | "endWithin"
  | "ageSince"
  | "sevenDaysAgo"
  | "sevenDaysFromNow"
>;

function buildFeedSqlExpressions(): FeedSqlExpressions {
  const safeEventLiquidityExpr =
    "case when e.liquidity >= 9e16 then null else e.liquidity end";
  const eventVolumeDisplayExpr = `
    case
      when e.volume_total is not null and e.volume_total > 0 then e.volume_total
      else null
    end
  `;
  const marketVolumeDisplayExpr = `
    case
      when m.volume_total is not null and m.volume_total > 0 then m.volume_total
      else null
    end
  `;
  const eventLiquidityDisplayExpr = `
    coalesce(nullif(${safeEventLiquidityExpr}, 0), nullif(e.open_interest, 0))
  `;
  const marketLiquidityDisplayExpr = `
    coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0))
  `;
  const eventOpenInterestExpr = `
    coalesce(nullif(e.open_interest, 0), nullif(sum(coalesce(m.open_interest, 0)), 0))
  `;
  const eventVolumeSortExpr = `
    coalesce(${eventVolumeDisplayExpr}, sum(coalesce(${marketVolumeDisplayExpr}, 0)))
  `;
  const supportedLimitlessMarketExpr = "true";
  const renderableMarketExpr = buildRenderableMarketSql({ alias: "m" });
  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null
        then (m.best_bid + m.best_ask) / 2
      else null
    end
  `;

  return {
    safeEventLiquidityExpr,
    eventVolumeDisplayExpr,
    marketVolumeDisplayExpr,
    eventLiquidityDisplayExpr,
    marketLiquidityDisplayExpr,
    eventOpenInterestExpr,
    eventVolumeSortExpr,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
    yesMidExpr,
  };
}

function buildFeedMarketCandidateExtraSql(args: {
  add: PgParamAdder;
  inputs: FeedEventFilterInputs & Pick<FeedInputs, "marketIds">;
  nowParam: string;
  venueTarget: FeedSearchVenueFilterTarget;
  renderableMarketExpr: string;
  supportedLimitlessMarketExpr: string;
  marketIdsParam?: string | null;
  hasSearch?: boolean;
  requireNamedCategory?: boolean;
}): string[] {
  const {
    add,
    inputs,
    nowParam,
    venueTarget,
    renderableMarketExpr,
    supportedLimitlessMarketExpr,
    marketIdsParam = null,
    hasSearch = false,
    requireNamedCategory = false,
  } = args;
  const clauses: string[] = [
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
  ];

  if (requireNamedCategory) {
    clauses.push("e.category is not null", "btrim(e.category) <> ''");
  }
  if (marketIdsParam) {
    clauses.push(`m.id = ANY(${marketIdsParam}::text[])`);
  }
  if (hasSearch) {
    clauses.push("m.event_id in (select id from search_events)");
  }
  if (inputs.venues) {
    clauses.push(
      inputs.venues.length
        ? `${venueTarget === "market" ? "m" : "e"}.venue = ANY(${add(inputs.venues)}::text[])`
        : "false",
    );
  }
  if (inputs.categories?.length) {
    clauses.push(`lower(e.category) = ANY(${add(inputs.categories)}::text[])`);
  } else if (inputs.category) {
    clauses.push(`lower(e.category) = ${add(inputs.category.toLowerCase())}`);
  }
  if (inputs.filter === "newest") {
    clauses.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    clauses.push(
      `e.end_date is not null and e.end_date > ${nowParam}::timestamptz and e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`,
    );
  }
  if (inputs.endWithin) {
    clauses.push(
      `e.end_date is not null and e.end_date > ${nowParam}::timestamptz and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
    );
  }
  if (inputs.ageSince) {
    clauses.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}::timestamptz`,
    );
  }
  const durationSql = buildMarketDurationSql(inputs, add);
  if (durationSql) {
    clauses.push(durationSql);
  }

  return clauses;
}

function buildFeedSearchDocumentExpr(
  alias: string,
  profile: FeedSearchProfile,
): string {
  const primary = `
    setweight(to_tsvector('english', coalesce(${alias}.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.category, '')), 'B')
  `;

  if (profile === "primary") return primary;

  return `
    setweight(to_tsvector('english', coalesce(${alias}.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(${alias}.description, '')), 'D')
  `;
}

function buildFeedDirectMarketSearchDocumentExpr(alias: string): string {
  return `
    setweight(to_tsvector('english', coalesce(${alias}.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.outcomes, '')), 'A')
  `;
}

function extractFeedSearchPrefixTerms(q?: string): string[] {
  const terms = (q?.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (term) => term.length >= 2,
  );
  return Array.from(new Set(terms)).slice(0, 8);
}

function shouldUseFeedSearchPrefix(
  q: string | undefined,
  term: string,
): boolean {
  const rawTerms = q?.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return (
    rawTerms.length === 1 &&
    term.length >= FEED_SEARCH_PREFIX_MIN_CHARS &&
    term.length <= FEED_SEARCH_PREFIX_MAX_CHARS &&
    !/^\d+$/.test(term)
  );
}

function buildFeedSearchPlan(q?: string): FeedSearchPlan {
  const searchText = q?.trim() ?? "";
  const prefixTerms = extractFeedSearchPrefixTerms(searchText);
  const rawTerms = searchText.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const hasEffectiveTerms =
    rawTerms.length > 0 &&
    rawTerms.some((term) => !FEED_SEARCH_STOP_WORDS.has(term));
  const prefixTerm =
    prefixTerms.length === 1 &&
    hasEffectiveTerms &&
    shouldUseFeedSearchPrefix(searchText, prefixTerms[0])
      ? prefixTerms[0]
      : null;
  return {
    hasSearch: searchText.length > 0 && hasEffectiveTerms,
    rankMode: rawTerms.length >= 2 ? "ranked" : "membership",
    strategy: rawTerms.length <= 1 ? "primary_with_fallback" : "full",
    searchText,
    prefixQueryText: prefixTerm ? `${prefixTerm}:*` : null,
  };
}

function buildFeedDirectMarketRelaxedQueryText(q?: string): string | null {
  const terms = q?.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const relaxedTerms = Array.from(
    new Set(
      terms.filter(
        (term) => term.length >= 4 && !FEED_SEARCH_STOP_WORDS.has(term),
      ),
    ),
  ).slice(0, 2);

  if (relaxedTerms.length < 2) return null;
  return relaxedTerms.join(" | ");
}

function buildFeedSearchQueryCte(searchParam: string, prefixParam: string) {
  return `
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
    `;
}

function buildFeedSearchEarlyFilterSql(args: {
  add: PgParamAdder;
  inputs?: FeedSearchEarlyFilterInputs;
  venueTarget?: FeedSearchVenueFilterTarget;
}): FeedSearchEarlyFilterSql {
  const { add, inputs, venueTarget = "event" } = args;
  const eventWhere: string[] = [];
  const marketWhere: string[] = [];
  const fallbackEventWhere: string[] = [];
  const fallbackMarketWhere: string[] = [];
  let hasDeferredFallbackFilters = false;
  if (!inputs) {
    return {
      eventWhere,
      marketWhere,
      fallbackEventWhere,
      fallbackMarketWhere,
      hasDeferredFallbackFilters,
    };
  }

  const pushFilter = (
    eventClause: string,
    marketClause: string,
    options?: { deferFromFallback?: boolean },
  ) => {
    eventWhere.push(eventClause);
    marketWhere.push(marketClause);
    if (!options?.deferFromFallback) {
      fallbackEventWhere.push(eventClause);
      fallbackMarketWhere.push(marketClause);
    } else {
      hasDeferredFallbackFilters = true;
    }
  };

  if (inputs.venues) {
    if (inputs.venues.length) {
      const venuesParam = add(inputs.venues);
      pushFilter(
        `e.venue = ANY(${venuesParam}::text[])`,
        `${venueTarget === "market" ? "m" : "e"}.venue = ANY(${venuesParam}::text[])`,
      );
    } else {
      pushFilter("false", "false");
    }
  }
  if (inputs.categories?.length) {
    const categoriesParam = add(inputs.categories);
    pushFilter(
      `lower(e.category) = ANY(${categoriesParam}::text[])`,
      `lower(e.category) = ANY(${categoriesParam}::text[])`,
      { deferFromFallback: true },
    );
  } else if (inputs.category) {
    const categoryParam = add(inputs.category.toLowerCase());
    pushFilter(
      `lower(e.category) = ${categoryParam}`,
      `lower(e.category) = ${categoryParam}`,
      { deferFromFallback: true },
    );
  }
  if (inputs.endWithin) {
    const endWithinParam = add(inputs.endWithin);
    pushFilter(
      `e.end_date is not null and e.end_date <= ${endWithinParam}::timestamptz`,
      `e.end_date is not null and e.end_date <= ${endWithinParam}::timestamptz`,
    );
  }
  if (inputs.ageSince) {
    const ageSinceParam = add(inputs.ageSince);
    pushFilter(
      `e.start_date is not null and e.start_date >= ${ageSinceParam}::timestamptz`,
      `e.start_date is not null and e.start_date >= ${ageSinceParam}::timestamptz`,
    );
  }

  return {
    eventWhere,
    marketWhere,
    fallbackEventWhere,
    fallbackMarketWhere,
    hasDeferredFallbackFilters,
  };
}

function buildFeedSearchLimitClause(limit: number | null): string {
  return limit != null ? `limit ${limit}` : "";
}

function buildFeedSearchMatchesSql(args: {
  mode: FeedSearchMode;
  matchLimit?: number | null;
  fallbackThreshold?: number | null;
  primaryEventSearchDocExpr: string;
  primaryMarketSearchDocExpr: string;
  fullEventSearchDocExpr: string;
  fullMarketSearchDocExpr: string;
  renderableMarketExpr: string;
  orderableMarketExpr: string;
  strategy: FeedSearchStrategy;
  earlyFilters?: FeedSearchEarlyFilterSql;
}): string {
  const {
    mode,
    matchLimit = null,
    fallbackThreshold = null,
    primaryEventSearchDocExpr,
    primaryMarketSearchDocExpr,
    fullEventSearchDocExpr,
    fullMarketSearchDocExpr,
    renderableMarketExpr,
    orderableMarketExpr,
    strategy,
    earlyFilters,
  } = args;
  const marketRankFactor = mode === "ranked" ? " * 2" : "";
  const eventRankFactor = mode === "ranked" ? " * 2" : "";
  const eventMembershipScore =
    "coalesce(e.volume_total, e.open_interest, e.liquidity, 0)";
  const marketMembershipScore =
    "coalesce(m.volume_total, m.open_interest, m.liquidity, 0)";
  const finalMatchLimit =
    matchLimit != null ? Math.max(1, Math.floor(matchLimit)) : null;
  const fallbackMatchLimit =
    finalMatchLimit != null &&
    strategy === "primary_with_fallback" &&
    earlyFilters?.hasDeferredFallbackFilters
      ? Math.min(feedSearchResultMatchLimit(), Math.max(finalMatchLimit, 500))
      : finalMatchLimit;
  const finalLimitClause = buildFeedSearchLimitClause(finalMatchLimit);
  const fallbackLimitClause = buildFeedSearchLimitClause(fallbackMatchLimit);
  const searchEventsLimitClause =
    buildFeedSearchLimitClause(fallbackMatchLimit);
  const fallbackRunExpr =
    fallbackThreshold != null
      ? `(select matched from primary_search_state) < ${Math.max(1, Math.floor(fallbackThreshold))}`
      : "false";

  const buildProfileSql = (
    profile: FeedSearchProfile,
    sourcePriority: 1 | 0,
    profileLimitClause: string,
  ) => {
    const eventSearchDocExpr =
      profile === "primary"
        ? primaryEventSearchDocExpr
        : fullEventSearchDocExpr;
    const marketSearchDocExpr =
      profile === "primary"
        ? primaryMarketSearchDocExpr
        : fullMarketSearchDocExpr;
    const profileGate =
      profile === "full" && strategy === "primary_with_fallback"
        ? `and ${fallbackRunExpr}`
        : "";
    const useFallbackEarlyFilters =
      profile === "full" && strategy === "primary_with_fallback";
    const eventEarlyClauses = useFallbackEarlyFilters
      ? earlyFilters?.fallbackEventWhere
      : earlyFilters?.eventWhere;
    const marketEarlyClauses = useFallbackEarlyFilters
      ? earlyFilters?.fallbackMarketWhere
      : earlyFilters?.marketWhere;
    const eventEarlyWhere = eventEarlyClauses?.length
      ? `and ${eventEarlyClauses.join(" and ")}`
      : "";
    const marketEarlyWhere = marketEarlyClauses?.length
      ? `and ${marketEarlyClauses.join(" and ")}`
      : "";

    return `
      select id, max(rank) as rank, ${sourcePriority}::int as search_priority
      from (
        select
          e.id,
          ${
            mode === "ranked"
              ? `ts_rank_cd((${eventSearchDocExpr}), sq.query)${eventRankFactor}`
              : eventMembershipScore
          } as rank
        from unified_events e
        cross join search_query sq
        where querytree(sq.query) <> ''
          ${profileGate}
          and e.status = 'ACTIVE'
          ${eventEarlyWhere}
          and (${eventSearchDocExpr}) @@ sq.query
        union all
        select
          e.id,
          ${
            mode === "ranked"
              ? `ts_rank_cd((${eventSearchDocExpr}), sq.prefix_query)`
              : eventMembershipScore
          } as rank
        from unified_events e
        cross join search_query sq
        where sq.prefix_query is not null
          and querytree(sq.prefix_query) <> ''
          ${profileGate}
          and e.status = 'ACTIVE'
          ${eventEarlyWhere}
          and (${eventSearchDocExpr}) @@ sq.prefix_query
        union all
        select
          m.event_id as id,
          ${
            mode === "ranked"
              ? `ts_rank_cd((${marketSearchDocExpr}), sq.query)${marketRankFactor}`
              : marketMembershipScore
          } as rank
        from unified_markets m
        join unified_events e on e.id = m.event_id
        left join polymarket_markets pm_search
          on pm_search.id = m.venue_market_id
         and m.venue = 'polymarket'
        cross join search_query sq
        where querytree(sq.query) <> ''
          ${profileGate}
          and ${orderableMarketExpr}
          ${marketEarlyWhere}
          and ${renderableMarketExpr}
          and (${marketSearchDocExpr}) @@ sq.query
        union all
        select
          m.event_id as id,
          ${
            mode === "ranked"
              ? `ts_rank_cd((${marketSearchDocExpr}), sq.prefix_query)`
              : marketMembershipScore
          } as rank
        from unified_markets m
        join unified_events e on e.id = m.event_id
        left join polymarket_markets pm_search
          on pm_search.id = m.venue_market_id
         and m.venue = 'polymarket'
        cross join search_query sq
        where sq.prefix_query is not null
          and querytree(sq.prefix_query) <> ''
          ${profileGate}
          and ${orderableMarketExpr}
          ${marketEarlyWhere}
          and ${renderableMarketExpr}
          and (${marketSearchDocExpr}) @@ sq.prefix_query
      ) matches
      group by id
      order by search_priority desc, rank desc nulls last, id
      ${profileLimitClause}
    `;
  };

  if (strategy === "full") {
    return `
      search_events as materialized (
        ${buildProfileSql("full", 1, finalLimitClause)}
      )
    `;
  }

  const primarySql = buildProfileSql("primary", 1, finalLimitClause);
  const fallbackSql = buildProfileSql("full", 0, fallbackLimitClause);
  return `
    primary_search_events as materialized (
      ${primarySql}
    ),
    primary_search_state as materialized (
      select count(*)::int as matched from primary_search_events
    ),
    fallback_search_events as materialized (
      ${fallbackSql}
    ),
    search_events as materialized (
      select id, rank, search_priority
      from (
        select id, rank, search_priority
        from primary_search_events
        union all
        select f.id, f.rank, f.search_priority
        from fallback_search_events f
        where not exists (
          select 1
          from primary_search_events p
          where p.id = f.id
        )
      ) merged_search_events
      order by search_priority desc, rank desc nulls last, id
      ${searchEventsLimitClause}
    )
  `;
}

function buildFeedSearchContext(args: {
  add: PgParamAdder;
  q?: string;
  nowParam: string;
  renderableMarketExpr: string;
  mode?: FeedSearchMode;
  matchLimit?: number | null;
  fallbackThreshold?: number | null;
  earlyFilterInputs?: FeedSearchEarlyFilterInputs;
  venueFilterTarget?: FeedSearchVenueFilterTarget;
}): FeedSearchContext {
  const {
    add,
    q,
    nowParam,
    renderableMarketExpr,
    mode = "ranked",
    matchLimit = null,
    fallbackThreshold = null,
    earlyFilterInputs,
    venueFilterTarget = "event",
  } = args;
  const plan = buildFeedSearchPlan(q);
  const searchParam = plan.hasSearch ? add(plan.searchText) : null;
  const prefixParam = plan.hasSearch ? add(plan.prefixQueryText) : null;
  const primaryEventSearchDocExpr = buildFeedSearchDocumentExpr("e", "primary");
  const primaryMarketSearchDocExpr = buildFeedSearchDocumentExpr(
    "m",
    "primary",
  );
  const fullEventSearchDocExpr = buildFeedSearchDocumentExpr("e", "full");
  const fullMarketSearchDocExpr = buildFeedSearchDocumentExpr("m", "full");
  const effectiveMode = mode === "ranked" ? plan.rankMode : mode;
  const orderableMarketExpr = buildOrderableMarketSql({
    marketAlias: "m",
    eventAlias: "e",
    nowParam,
    pmAlias: "pm_search",
  });
  const earlyFilters = plan.hasSearch
    ? buildFeedSearchEarlyFilterSql({
        add,
        inputs: earlyFilterInputs,
        venueTarget: venueFilterTarget,
      })
    : undefined;
  const searchMatchesSql = plan.hasSearch
    ? buildFeedSearchMatchesSql({
        mode: effectiveMode,
        matchLimit,
        fallbackThreshold,
        primaryEventSearchDocExpr,
        primaryMarketSearchDocExpr,
        fullEventSearchDocExpr,
        fullMarketSearchDocExpr,
        renderableMarketExpr,
        orderableMarketExpr,
        strategy: plan.strategy,
        earlyFilters,
      })
    : "";
  let searchCte = "";
  if (plan.hasSearch) {
    if (!searchParam || !prefixParam) {
      throw new Error("Feed search params were not initialized");
    }
    searchCte = `
      ${buildFeedSearchQueryCte(searchParam, prefixParam)},
      ${searchMatchesSql}
    `;
  }

  return {
    hasSearch: plan.hasSearch,
    searchCte,
    searchEventJoin: plan.hasSearch
      ? "join search_events se on se.id = e.id"
      : "",
    searchMarketJoin: plan.hasSearch
      ? "join search_events se on se.id = m.event_id"
      : "",
    searchFilterExpr: plan.hasSearch ? "true" : "true",
    joinedRankExpr: plan.hasSearch
      ? "(coalesce(se.search_priority, 0) * 1000000000000000000000000000000::numeric + coalesce(se.rank, 0))"
      : "0::double precision",
  };
}

export function buildFeedCandidateEventSearchFilter(args: {
  add: (value: PgParams[number]) => string;
  q?: string;
  nowParam: string;
  nowCloseParam?: string;
  matchLimit?: number | null;
  fallbackThreshold?: number | null;
  earlyFilterInputs?: FeedSearchEarlyFilterInputs;
}): FeedCandidateEventSearchFilter {
  const context = buildFeedSearchContext({
    add: args.add,
    q: args.q,
    nowParam: args.nowParam,
    renderableMarketExpr: buildRenderableMarketSql({ alias: "m" }),
    mode: "membership",
    matchLimit: args.matchLimit,
    fallbackThreshold: args.fallbackThreshold,
    earlyFilterInputs: args.earlyFilterInputs,
  });

  return {
    hasSearch: context.hasSearch,
    searchCte: context.searchCte,
    searchEventJoin: context.searchEventJoin,
    searchFilterExpr: context.searchFilterExpr,
  };
}

function buildFeedEventWhere(args: {
  add: PgParamAdder;
  inputs: FeedEventFilterInputs;
  nowParam: string;
  hasSearch: boolean;
  requireNamedCategory?: boolean;
  includeOrderableExists?: boolean;
  includeDurationExists?: boolean;
  includeSearchCondition?: boolean;
  searchFilterExpr?: string;
}): string[] {
  const {
    add,
    inputs,
    nowParam,
    hasSearch,
    requireNamedCategory = false,
    includeOrderableExists = true,
    includeDurationExists = true,
    includeSearchCondition = true,
    searchFilterExpr = "e.id in (select id from search_events)",
  } = args;
  const where: string[] = ["e.status = 'ACTIVE'"];
  if (includeOrderableExists) {
    where.push(buildOrderableEventFreshnessSql({ eventAlias: "e", nowParam }));
    where.push(buildEventHasOrderableMarketSql({ eventAlias: "e", nowParam }));
  }

  if (requireNamedCategory) {
    where.push("e.category is not null", "btrim(e.category) <> ''");
  }
  if (inputs.venues) {
    where.push(
      inputs.venues.length
        ? `e.venue = ANY(${add(inputs.venues)}::text[])`
        : "false",
    );
  }
  if (inputs.categories?.length) {
    where.push(`lower(e.category) = ANY(${add(inputs.categories)}::text[])`);
  } else if (inputs.category) {
    where.push(`lower(e.category) = ${add(inputs.category.toLowerCase())}`);
  }
  if (includeDurationExists) {
    const durationExistsSql = buildEventDurationExistsSql({
      inputs,
      add,
      nowParam,
    });
    if (durationExistsSql) {
      where.push(durationExistsSql);
    }
  }
  if (hasSearch && includeSearchCondition) {
    where.push(searchFilterExpr);
  }
  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    where.push(
      `e.end_date is not null and e.end_date > ${nowParam}::timestamptz and e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`,
    );
  }
  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date > ${nowParam}::timestamptz and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
    );
  }
  if (inputs.ageSince) {
    where.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}::timestamptz`,
    );
  }

  return where;
}

function requiresFeedEventMarketJoin(
  inputs: Pick<FeedInputs, "minProb" | "maxProb" | "maxSpread" | "eventScope">,
): boolean {
  return (
    inputs.minProb != null ||
    inputs.maxProb != null ||
    inputs.maxSpread != null ||
    inputs.eventScope != null
  );
}

function buildFeedEventJoinHaving(args: {
  add: PgParamAdder;
  inputs: Pick<
    FeedInputs,
    | "minVol"
    | "minLiquidity"
    | "minProb"
    | "maxProb"
    | "maxSpread"
    | "eventScope"
  >;
  eventVolumeSortExpr: string;
  marketLiquidityDisplayExpr: string;
  yesMidExpr: string;
}) {
  const {
    add,
    inputs,
    eventVolumeSortExpr,
    marketLiquidityDisplayExpr,
    yesMidExpr,
  } = args;
  const marketQual: string[] = [];

  if (inputs.minLiquidity > 0) {
    marketQual.push(
      `${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
    );
  }
  if (inputs.minProb != null) {
    marketQual.push(`(${yesMidExpr}) >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    marketQual.push(`(${yesMidExpr}) <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    marketQual.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }
  const marketQualSql = marketQual.length
    ? marketQual.map((clause) => `(${clause})`).join(" and ")
    : "true";

  const having: string[] = [];
  if (inputs.minVol > 1e-9) {
    having.push(`${eventVolumeSortExpr} >= ${add(inputs.minVol)}`);
  }
  having.push(`bool_or(${marketQualSql})`);
  if (inputs.eventScope === "grouped") {
    having.push("count(m.id) > 1");
  } else if (inputs.eventScope === "single") {
    having.push("count(m.id) = 1");
  }

  return having;
}

function feedEventFastCandidateLimit(
  inputs: Pick<FeedInputs, "limit" | "offset" | "sort">,
): number {
  const pageTarget = inputs.limit + inputs.offset;
  const minCandidates =
    inputs.sort === "liquidity"
      ? FEED_EVENT_FAST_MAX_CANDIDATES
      : FEED_EVENT_FAST_MIN_CANDIDATES;
  return Math.max(minCandidates, pageTarget * FEED_EVENT_FAST_CANDIDATE_FACTOR);
}

function expandFeedCandidateLimit(candidateLimit: number): number {
  return candidateLimit * FEED_CANDIDATE_EXPANSION_FACTOR;
}

function isFeedEventFastPathSort(
  inputs: Pick<FeedInputs, "sort" | "filter" | "sortDir">,
): boolean {
  if (inputs.sort === "trending_v2") {
    return inputs.sortDir !== "asc";
  }
  if (
    inputs.sort == null ||
    inputs.sort === "trending" ||
    inputs.sort === "totalvol" ||
    inputs.sort === "liquidity" ||
    inputs.sort === "openinterest" ||
    inputs.sort === "time" ||
    inputs.sort === "change24h"
  ) {
    return true;
  }
  return inputs.filter === "newest" || inputs.filter === "endingsoon";
}

async function fetchFeedEventIdsFast(
  pool: Pool,
  inputs: FeedInputs,
): Promise<Array<{ id: string }> | null> {
  if (!isFeedEventFastPathSort(inputs)) return null;
  if (requiresFeedEventMarketJoin(inputs)) return null;
  if (buildFeedSearchPlan(inputs.q).hasSearch) return null;

  const pageTarget = inputs.limit + inputs.offset;
  let candidateLimit = feedEventFastCandidateLimit(inputs);

  const { params, add } = createParamBuilder();
  const expressions = buildFeedSqlExpressions();
  const { eventVolumeDisplayExpr, eventLiquidityDisplayExpr } = expressions;
  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";
  const nowParam = add(inputs.nowParam);
  const eventWhere = buildFeedEventWhere({
    add,
    inputs,
    nowParam,
    hasSearch: false,
    includeOrderableExists: false,
  });
  eventWhere.push(
    buildOrderableEventFreshnessSql({ eventAlias: "e", nowParam }),
  );
  if (inputs.minVol > 1e-9) {
    eventWhere.push(`${eventVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
  }
  if (inputs.minLiquidity > 0) {
    eventWhere.push(
      `${eventLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
    );
  }
  const eventWhereSql = eventWhere.length ? eventWhere.join(" and ") : "true";
  const candidateLimitParam = add(candidateLimit);
  const candidateLimitParamIndex = params.length - 1;
  const targetParam = add(pageTarget);

  const eventOpenInterestSortExpr = "coalesce(nullif(e.open_interest, 0), 0)";
  let candidateSourceSql: string | null = null;

  if (inputs.sort === "change24h") {
    candidateSourceSql = `
      select
        e.id,
        row_number() over (
          order by ec.change_24h ${sortDir} nulls last, e.id
        ) as full_ord
      from unified_event_change_24h ec
      join unified_events e on e.id = ec.event_id
      where ${eventWhereSql}
        and ec.change_24h is not null
      order by ec.change_24h ${sortDir} nulls last, e.id
      limit ${candidateLimitParam}
    `;
  } else if (inputs.sort === "trending_v2") {
    const limitlessTrendExpr = `(coalesce(${eventLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${eventVolumeDisplayExpr}, 0))`;
    candidateSourceSql = `
      select
        candidate.id,
        row_number() over (
          order by candidate.trend_score ${sortDir} nulls last, candidate.id
        ) as full_ord
      from (
        select
          e.id,
          et.volume_24h as trend_score
        from unified_event_trade_24h et
        join unified_events e on e.id = et.event_id
        where ${eventWhereSql}
          and e.venue <> 'limitless'
          and et.volume_24h > 0
        union all
        select
          e.id,
          ${limitlessTrendExpr} as trend_score
        from unified_events e
        where ${eventWhereSql}
          and e.venue = 'limitless'
          and ${limitlessTrendExpr} > 0
      ) candidate
      order by candidate.trend_score ${sortDir} nulls last, candidate.id
      limit ${candidateLimitParam}
    `;
  } else {
    let eventOrder = "";
    if (inputs.sort === "totalvol")
      eventOrder = `(${eventVolumeDisplayExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "liquidity")
      eventOrder = `(${eventLiquidityDisplayExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "openinterest")
      eventOrder = `(${eventOpenInterestSortExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "time")
      eventOrder = `${buildFutureEventEndSortSql("e", nowParam)} ${sortDir} nulls last, e.id`;
    else if (inputs.filter === "newest")
      eventOrder = "e.start_date desc nulls last, e.id";
    else if (inputs.filter === "endingsoon")
      eventOrder = `${buildFutureEventEndSortSql("e", nowParam)} asc nulls last, e.id`;
    else if (inputs.sort == null || inputs.sort === "trending") {
      const sevenDaysAgo = add(inputs.sevenDaysAgo);
      const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
      eventOrder = `
        (coalesce(${eventVolumeDisplayExpr}, 0) * 0.4 +
         coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
         case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
         case when e.end_date > ${nowParam}::timestamptz and e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
        ) ${sortDir} nulls last, e.id
      `;
    }

    if (eventOrder) {
      candidateSourceSql = `
        select
          e.id,
          row_number() over (order by ${eventOrder}) as full_ord
        from unified_events e
        where ${eventWhereSql}
        order by ${eventOrder}
        limit ${candidateLimitParam}
      `;
    }
  }

  if (!candidateSourceSql) return null;

  const sql = `
    with ranked_event_candidates as materialized (
      ${candidateSourceSql}
    ),
    valid_ranked_events as materialized (
      select
        c.id,
        c.full_ord
      from ranked_event_candidates c
      join unified_events e on e.id = c.id
      where ${buildEventHasOrderableMarketSql({ eventAlias: "e", nowParam })}
    )
    select
      coalesce(
        (
          select array_agg(page.id order by page.full_ord)
          from (
            select id, full_ord
            from valid_ranked_events
            order by full_ord
            limit ${targetParam}
          ) page
        ),
        '{}'::text[]
      ) as ids,
      (select count(*)::int from ranked_event_candidates) as candidate_count
  `;

  for (;;) {
    params[candidateLimitParamIndex] = candidateLimit;
    const rows = await queryRowsWithSearchHint<{
      ids: string[];
      candidate_count: number;
    }>(pool, sql, params, false, FEED_HEAVY_QUERY_WORK_MEM, null, true);
    const ids = rows[0]?.ids ?? [];
    const candidateCount = Number(rows[0]?.candidate_count ?? 0);
    if (ids.length >= pageTarget) {
      return ids
        .slice(inputs.offset, inputs.offset + inputs.limit)
        .map((id) => ({
          id,
        }));
    }
    if (candidateCount < candidateLimit) {
      if (inputs.sort === "change24h" || inputs.sort === "trending_v2") {
        return null;
      }
      return ids
        .slice(inputs.offset, inputs.offset + inputs.limit)
        .map((id) => ({
          id,
        }));
    }
    candidateLimit = expandFeedCandidateLimit(candidateLimit);
  }
}

function buildFeedMarketViewContext(args: {
  add: PgParamAdder;
  inputs: FeedEventFilterInputs &
    Pick<
      FeedInputs,
      | "marketIds"
      | "minVol"
      | "minLiquidity"
      | "minProb"
      | "maxProb"
      | "maxSpread"
      | "eventScope"
      | "q"
    >;
  nowParam: string;
  nowCloseParam: string;
  expressions: FeedSqlExpressions;
  requireNamedCategory?: boolean;
  searchMode?: FeedSearchMode;
  searchMatchLimit?: number | null;
  searchFallbackThreshold?: number | null;
  venueFilterTarget?: FeedSearchVenueFilterTarget;
}) {
  const {
    add,
    inputs,
    nowParam,
    nowCloseParam,
    expressions,
    requireNamedCategory = false,
    searchMode = "ranked",
    searchMatchLimit = null,
    searchFallbackThreshold = null,
    venueFilterTarget = "market",
  } = args;
  const {
    marketVolumeDisplayExpr,
    marketLiquidityDisplayExpr,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
    yesMidExpr,
  } = expressions;
  const marketIdsParam = inputs.marketIds?.length
    ? add(inputs.marketIds)
    : null;
  const search = buildFeedSearchContext({
    add,
    q: inputs.q,
    nowParam,
    renderableMarketExpr,
    mode: searchMode,
    matchLimit: searchMatchLimit,
    fallbackThreshold: searchFallbackThreshold,
    earlyFilterInputs: inputs,
    venueFilterTarget,
  });
  const needsMarketCount =
    inputs.eventScope === "grouped" || inputs.eventScope === "single";
  const orderableMarketCandidatesCte = buildBroadOrderableMarketCandidatesCte({
    materialized: true,
    nowParam,
    nowCloseParam,
    extraMarketSql: buildFeedMarketCandidateExtraSql({
      add,
      inputs,
      nowParam,
      venueTarget: venueFilterTarget,
      renderableMarketExpr,
      supportedLimitlessMarketExpr,
      marketIdsParam,
      hasSearch: search.hasSearch,
      requireNamedCategory,
    }),
  });
  const scopedOrderableMarketCandidatesCte = needsMarketCount
    ? `
    scoped_orderable_market_candidates as materialized (
      select market_id, event_id
      from (
        select
          omc.market_id,
          omc.event_id,
          count(*) over (partition by omc.event_id) as market_count
        from orderable_market_candidates omc
      ) counted
      where market_count ${inputs.eventScope === "grouped" ? "> 1" : "= 1"}
    )
  `
    : "";
  const orderableMarketCandidateSource = needsMarketCount
    ? "scoped_orderable_market_candidates"
    : "orderable_market_candidates";
  const where: string[] = [];
  if (inputs.minLiquidity > 0) {
    where.push(`${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`);
  }
  if (inputs.minVol > 1e-9) {
    where.push(`${marketVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
  }
  if (inputs.minProb != null) {
    where.push(`${yesMidExpr} >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    where.push(`${yesMidExpr} <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    where.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }

  return {
    marketIdsParam,
    orderableMarketCandidatesCte,
    scopedOrderableMarketCandidatesCte,
    orderableMarketCandidateSource,
    where: where.length ? where : ["true"],
    ...search,
  };
}

function isSafeLocalWorkMem(value: string): boolean {
  return /^[1-9][0-9]*(kB|MB|GB)$/i.test(value);
}

function isSafeStatementTimeoutMs(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 120_000;
}

function feedSearchWorkMem(): string {
  return `${env.feedSearchWorkMemMb}MB`;
}

function feedSearchStatementTimeoutMs(): number {
  return env.feedSearchTimeoutMs;
}

function feedSearchResultMatchLimit(): number {
  return env.feedSearchResultMatchLimit;
}

function feedSearchResultMatchLimitForInputs(
  inputs: Pick<
    FeedInputs,
    "limit" | "offset" | "marketIds" | "sort" | "filter"
  >,
): number | null {
  if (inputs.marketIds?.length) return null;
  if (
    inputs.sort === "time" ||
    inputs.filter === "endingsoon" ||
    inputs.filter === "newest"
  ) {
    return null;
  }
  return feedSearchResultMatchLimit();
}

function feedSearchFallbackThresholdForInputs(
  inputs: Pick<
    FeedInputs,
    "limit" | "offset" | "marketIds" | "sort" | "filter"
  >,
): number | null {
  const matchLimit = feedSearchResultMatchLimitForInputs(inputs);
  if (matchLimit == null) return null;
  return Math.min(matchLimit, 50);
}

export function buildFeedSearchResultWindow(
  inputs: Pick<
    FeedInputs,
    "limit" | "offset" | "marketIds" | "sort" | "filter"
  >,
): FeedSearchResultWindow {
  return {
    matchLimit: feedSearchResultMatchLimitForInputs(inputs),
    fallbackThreshold: feedSearchFallbackThresholdForInputs(inputs),
  };
}

export async function queryRowsWithLocalSettings<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: PgParams,
  options?: {
    useSearchHint?: boolean;
    workMem?: string | null;
    statementTimeoutMs?: number | null;
    jitOff?: boolean;
  },
): Promise<T[]> {
  const useSearchHint = options?.useSearchHint ?? false;
  const workMem = options?.workMem ?? null;
  const statementTimeoutMs = options?.statementTimeoutMs ?? null;
  const jitOff = options?.jitOff ?? false;
  if (!useSearchHint && !workMem && !statementTimeoutMs && !jitOff) {
    const { rows } = await pool.query<T>(sql, params);
    return rows;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (useSearchHint) {
      await client.query("SET LOCAL enable_seqscan = off");
    }
    if (jitOff) {
      await client.query("SET LOCAL jit = off");
    }
    if (workMem) {
      if (!isSafeLocalWorkMem(workMem)) {
        throw new Error(`Unsafe local work_mem value: ${workMem}`);
      }
      await client.query(`SET LOCAL work_mem = '${workMem}'`);
    }
    if (statementTimeoutMs) {
      if (!isSafeStatementTimeoutMs(statementTimeoutMs)) {
        throw new Error(
          `Unsafe local statement_timeout value: ${statementTimeoutMs}`,
        );
      }
      await client.query(
        `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`,
      );
    }
    const { rows } = await client.query<T>(sql, params);
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback for failed search hints.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function queryRowsWithSearchHint<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: PgParams,
  useSearchHint: boolean,
  workMem?: string | null,
  statementTimeoutMs?: number | null,
  jitOff?: boolean,
): Promise<T[]> {
  return queryRowsWithLocalSettings<T>(pool, sql, params, {
    useSearchHint,
    workMem,
    statementTimeoutMs,
    jitOff,
  });
}

function buildFeedBookSnapshotCtes(args: {
  nowParam: string;
  include24h: boolean;
  sourceCteName?: string;
  tokenYesColumn?: string;
  tokenNoColumn?: string;
}): {
  ctes: string[];
  yesTopJoin: string;
  noTopJoin: string;
  yes24hJoin: string;
} {
  const sourceCteName = args.sourceCteName ?? "market_base";
  const tokenYesColumn = args.tokenYesColumn ?? "resolved_token_yes";
  const tokenNoColumn = args.tokenNoColumn ?? "resolved_token_no";
  const ctes = [
    `
      token_set as materialized (
        select ${tokenYesColumn} as token_id
        from ${sourceCteName}
        where ${tokenYesColumn} is not null
        union
        select ${tokenNoColumn} as token_id
        from ${sourceCteName}
        where ${tokenNoColumn} is not null
      )
    `,
    `
      latest_book as materialized (
        select
          b.token_id,
          b.ts,
          b.best_bid,
          b.best_ask
        from unified_token_top_latest b
        join token_set ts on ts.token_id = b.token_id
        where b.ts >= (${args.nowParam}::timestamptz - interval '10 minutes')
      )
    `,
  ];
  if (args.include24h) {
    ctes.push(`
      book_24h as materialized (
        select
          b.token_id,
          b.avg_mid_24h as avg_mid
        from unified_token_change_24h b
        join token_set ts on ts.token_id = b.token_id
        where b.avg_mid_24h is not null
      )
    `);
  }
  return {
    ctes,
    yesTopJoin: `left join latest_book yes_top on yes_top.token_id = m.${tokenYesColumn}`,
    noTopJoin: `left join latest_book no_top on no_top.token_id = m.${tokenNoColumn}`,
    yes24hJoin: args.include24h
      ? `left join book_24h yes_24h on yes_24h.token_id = m.${tokenYesColumn}`
      : "",
  };
}

export async function fetchFeedCategoryFacetRows(
  pool: Pool,
  inputs: FeedFacetInputs,
): Promise<FeedCategoryFacetRow[]> {
  const view: "events" | "markets" =
    inputs.view === "markets" ? "markets" : "events";
  const expressions = buildFeedSqlExpressions();

  if (view === "markets") {
    const { params, add } = createParamBuilder();
    const nowParam = add(inputs.nowParam);
    const nowCloseParam = add(inputs.nowParam);
    const marketContext = buildFeedMarketViewContext({
      add,
      inputs,
      nowParam,
      nowCloseParam,
      expressions,
      requireNamedCategory: true,
      searchMode: "membership",
      venueFilterTarget: "market",
    });

    const withParts: string[] = [];
    if (marketContext.searchCte) withParts.push(marketContext.searchCte);
    withParts.push(marketContext.orderableMarketCandidatesCte);
    if (marketContext.scopedOrderableMarketCandidatesCte) {
      withParts.push(marketContext.scopedOrderableMarketCandidatesCte);
    }
    const withClause = withParts.length ? `with ${withParts.join(",\n")}` : "";

    const sql = `
      ${withClause}
      select
        m.venue as venue,
        lower(e.category) as category,
        count(distinct m.event_id)::int as events
      from ${marketContext.orderableMarketCandidateSource} omc
      join unified_markets m on m.id = omc.market_id
      join unified_events e on e.id = omc.event_id
      ${marketContext.searchEventJoin}
      where ${marketContext.where.join(" and ")}
      group by m.venue, lower(e.category)
    `;

    return await queryRowsWithSearchHint<FeedCategoryFacetRow>(
      pool,
      sql,
      params,
      marketContext.hasSearch,
      marketContext.hasSearch ? feedSearchWorkMem() : FEED_HEAVY_QUERY_WORK_MEM,
      marketContext.hasSearch ? feedSearchStatementTimeoutMs() : null,
      true,
    );
  }

  const { params, add } = createParamBuilder();
  const {
    eventVolumeDisplayExpr,
    eventLiquidityDisplayExpr,
    marketLiquidityDisplayExpr,
    eventVolumeSortExpr,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
    yesMidExpr,
  } = expressions;
  const nowParam = add(inputs.nowParam);
  const search = buildFeedSearchContext({
    add,
    q: inputs.q,
    nowParam,
    renderableMarketExpr,
    mode: "membership",
    earlyFilterInputs: inputs,
    venueFilterTarget: "event",
  });
  const requiresMarketJoin = requiresFeedEventMarketJoin(inputs);
  const eventWhere = buildFeedEventWhere({
    add,
    inputs,
    nowParam,
    hasSearch: search.hasSearch,
    requireNamedCategory: true,
    includeOrderableExists: false,
    includeDurationExists: false,
    searchFilterExpr: search.searchFilterExpr,
  });

  if (!requiresMarketJoin) {
    const eventOnlyWhere = [...eventWhere];
    if (inputs.minVol > 1e-9) {
      eventOnlyWhere.push(`${eventVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
    }
    if (inputs.minLiquidity > 0) {
      eventOnlyWhere.push(
        `${eventLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
      );
    }

    const withParts: string[] = [];
    if (search.searchCte) withParts.push(search.searchCte);
    withParts.push(
      buildBroadOrderableMarketCandidatesCte({
        materialized: true,
        nowParam,
        extraMarketSql: [
          ...buildFeedMarketCandidateExtraSql({
            add,
            inputs,
            nowParam,
            venueTarget: "event",
            renderableMarketExpr,
            supportedLimitlessMarketExpr,
            hasSearch: search.hasSearch,
            requireNamedCategory: true,
          }),
        ],
      }),
    );
    withParts.push(`
      orderable_events as materialized (
        select distinct event_id
        from orderable_market_candidates
      )
    `);
    const withClause = `with ${withParts.join(",\n")}`;

    const sql = `
      ${withClause}
      select
        e.venue as venue,
        lower(e.category) as category,
        count(*)::int as events
      from orderable_events oe
      join unified_events e on e.id = oe.event_id
      ${search.searchEventJoin}
      where ${eventOnlyWhere.join(" and ")}
      group by e.venue, lower(e.category)
    `;

    return await queryRowsWithSearchHint<FeedCategoryFacetRow>(
      pool,
      sql,
      params,
      search.hasSearch,
      search.hasSearch ? feedSearchWorkMem() : FEED_HEAVY_QUERY_WORK_MEM,
      search.hasSearch ? feedSearchStatementTimeoutMs() : null,
      true,
    );
  }

  const having = buildFeedEventJoinHaving({
    add,
    inputs,
    eventVolumeSortExpr,
    marketLiquidityDisplayExpr,
    yesMidExpr,
  });
  const withParts: string[] = [];
  if (search.searchCte) withParts.push(search.searchCte);
  withParts.push(
    buildBroadOrderableMarketCandidatesCte({
      materialized: true,
      nowParam,
      extraMarketSql: [
        ...buildFeedMarketCandidateExtraSql({
          add,
          inputs,
          nowParam,
          venueTarget: "event",
          renderableMarketExpr,
          supportedLimitlessMarketExpr,
          hasSearch: search.hasSearch,
          requireNamedCategory: true,
        }),
      ],
    }),
  );
  withParts.push(`
    filtered_events as (
      select
        e.id,
        e.venue,
        lower(e.category) as category
      from unified_events e
      ${search.searchEventJoin}
      join orderable_market_candidates omc on omc.event_id = e.id
      join unified_markets m on m.id = omc.market_id
      where ${eventWhere.join(" and ")}
      group by
        e.id,
        e.venue,
        lower(e.category),
        e.volume_total,
        e.liquidity,
        e.open_interest
      having ${having.map((clause) => `(${clause})`).join(" and ")}
    )
  `);
  const withClause = `with ${withParts.join(",\n")}`;
  const sql = `
    ${withClause}
    select
      venue,
      category,
      count(*)::int as events
    from filtered_events
    group by venue, category
  `;

  return await queryRowsWithSearchHint<FeedCategoryFacetRow>(
    pool,
    sql,
    params,
    search.hasSearch,
    search.hasSearch ? feedSearchWorkMem() : FEED_HEAVY_QUERY_WORK_MEM,
    search.hasSearch ? feedSearchStatementTimeoutMs() : null,
    true,
  );
}

async function fetchFeedEventIdsExact(
  pool: Pool,
  inputs: FeedInputs,
): Promise<Array<{ id: string }>> {
  const { params, add } = createParamBuilder();
  const expressions = buildFeedSqlExpressions();
  const {
    eventVolumeDisplayExpr,
    eventLiquidityDisplayExpr,
    marketLiquidityDisplayExpr,
    eventOpenInterestExpr,
    eventVolumeSortExpr,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
    yesMidExpr,
  } = expressions;
  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";
  const nowParam = add(inputs.nowParam);
  const search = buildFeedSearchContext({
    add,
    q: inputs.q,
    nowParam,
    renderableMarketExpr,
    matchLimit: feedSearchResultMatchLimitForInputs(inputs),
    fallbackThreshold: feedSearchFallbackThresholdForInputs(inputs),
    earlyFilterInputs: inputs,
    venueFilterTarget: "event",
  });
  const filterRequiresMarketJoin = requiresFeedEventMarketJoin(inputs);
  const requiresMarketJoin =
    filterRequiresMarketJoin || inputs.sort === "trending_v2";
  const eventWhere = buildFeedEventWhere({
    add,
    inputs,
    nowParam,
    hasSearch: search.hasSearch,
    includeOrderableExists: !requiresMarketJoin,
    includeDurationExists: !requiresMarketJoin,
    searchFilterExpr: search.searchFilterExpr,
  });

  if (inputs.sort === "change24h" && !requiresMarketJoin) {
    const eventChangeWhere = [...eventWhere];
    if (inputs.minVol > 1e-9) {
      eventChangeWhere.push(
        `${eventVolumeDisplayExpr} >= ${add(inputs.minVol)}`,
      );
    }
    if (inputs.minLiquidity > 0) {
      eventChangeWhere.push(
        `${eventLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
      );
    }

    const change24hParts: string[] = [];
    if (search.searchCte) change24hParts.push(search.searchCte);
    change24hParts.push(`
      filtered_events as (
        select e.id
        from unified_events e
        ${search.searchEventJoin}
        ${eventChangeWhere.length ? "where " + eventChangeWhere.join(" and ") : ""}
      )
    `);

    const withClause = `with ${change24hParts.join(",\n")}`;
    const eventChangeSql = `
      ${withClause}
      select e.id
      from unified_events e
      join filtered_events fe on fe.id = e.id
      left join unified_event_change_24h ec on ec.event_id = e.id
      order by ec.change_24h ${sortDir} nulls last, e.id
      limit ${inputs.limit} offset ${inputs.offset}
    `;

    return await queryRowsWithSearchHint<{ id: string }>(
      pool,
      eventChangeSql,
      params,
      search.hasSearch,
      search.hasSearch ? feedSearchWorkMem() : FEED_HEAVY_QUERY_WORK_MEM,
      search.hasSearch ? feedSearchStatementTimeoutMs() : null,
      true,
    );
  }

  if (!requiresMarketJoin) {
    const eventOnlyWhere = [...eventWhere];
    if (inputs.minVol > 1e-9) {
      eventOnlyWhere.push(`${eventVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
    }
    if (inputs.minLiquidity > 0) {
      eventOnlyWhere.push(
        `${eventLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
      );
    }

    const eventOpenInterestSortExpr = "coalesce(nullif(e.open_interest, 0), 0)";
    let eventOnlyOrder = "";
    const eventOnlySearchOrder = search.hasSearch
      ? `${search.joinedRankExpr} desc nulls last, `
      : "";
    if (inputs.sort === "totalvol")
      eventOnlyOrder = `(${eventVolumeDisplayExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "liquidity")
      eventOnlyOrder = `(${eventLiquidityDisplayExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "openinterest")
      eventOnlyOrder = `(${eventOpenInterestSortExpr}) ${sortDir} nulls last, e.id`;
    else if (inputs.sort === "time")
      eventOnlyOrder = `${buildFutureEventEndSortSql("e", nowParam)} ${sortDir} nulls last, e.id`;
    else if (inputs.filter === "newest")
      eventOnlyOrder = "e.start_date desc nulls last, e.id";
    else if (inputs.filter === "endingsoon")
      eventOnlyOrder = `${buildFutureEventEndSortSql("e", nowParam)} asc nulls last, e.id`;
    else if (inputs.sort == null || inputs.sort === "trending") {
      const sevenDaysAgo = add(inputs.sevenDaysAgo);
      const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
      eventOnlyOrder = `
        ${eventOnlySearchOrder}(coalesce(${eventVolumeDisplayExpr}, 0) * 0.4 +
         coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
         case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
         case when e.end_date > ${nowParam}::timestamptz and e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
        ) ${sortDir} nulls last, e.id
      `;
    } else eventOnlyOrder = "e.start_date desc nulls last, e.id";

    const eventOnlySql = `
      ${search.searchCte ? `with ${search.searchCte}` : ""}
      select
        e.id
      from unified_events e
      ${search.searchEventJoin}
      ${eventOnlyWhere.length ? "where " + eventOnlyWhere.join(" and ") : ""}
      ${eventOnlyOrder ? `order by ${eventOnlyOrder}` : ""}
      limit ${inputs.limit} offset ${inputs.offset}
    `;

    return await queryRowsWithSearchHint<{ id: string }>(
      pool,
      eventOnlySql,
      params,
      search.hasSearch,
      search.hasSearch ? feedSearchWorkMem() : FEED_HEAVY_QUERY_WORK_MEM,
      search.hasSearch ? feedSearchStatementTimeoutMs() : null,
      true,
    );
  }
  const having = buildFeedEventJoinHaving({
    add,
    inputs,
    eventVolumeSortExpr,
    marketLiquidityDisplayExpr,
    yesMidExpr,
  });
  const eventChangeJoin =
    inputs.sort === "change24h"
      ? "left join unified_event_change_24h ec on ec.event_id = e.id"
      : "";
  const tradeJoin =
    inputs.sort === "trending_v2"
      ? "left join unified_event_trade_24h et on et.event_id = e.id"
      : "";

  let eventOrder = "";
  const eventSearchOrder = search.hasSearch
    ? `max(${search.joinedRankExpr}) desc nulls last, `
    : "";
  if (inputs.sort === "totalvol")
    eventOrder = `(${eventVolumeSortExpr}) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "liquidity")
    eventOrder = `(${eventLiquidityDisplayExpr}) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "openinterest")
    eventOrder = `(${eventOpenInterestExpr}) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "change24h")
    eventOrder = `max(ec.change_24h) ${sortDir} nulls last, e.id`;
  else if (inputs.sort === "time")
    eventOrder = `${buildFutureEventEndSortSql("e", nowParam)} ${sortDir} nulls last, e.id`;
  else if (inputs.filter === "newest")
    eventOrder = "e.start_date desc nulls last, e.id";
  else if (inputs.filter === "endingsoon")
    eventOrder = `${buildFutureEventEndSortSql("e", nowParam)} asc nulls last, e.id`;
  else if (inputs.sort === "trending_v2") {
    eventOrder = `
      case
        when e.venue = 'limitless'
          then max(coalesce(${eventLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${eventVolumeDisplayExpr}, 0))
        else coalesce(max(et.volume_24h), 0)
      end ${sortDir} nulls last, e.id
    `;
  } else if (inputs.sort == null || inputs.sort === "trending") {
    const sevenDaysAgo = add(inputs.sevenDaysAgo);
    const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
    eventOrder = `
      ${eventSearchOrder}(coalesce(${eventVolumeSortExpr}, 0) * 0.4 +
       coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
       case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
       case when e.end_date > ${nowParam}::timestamptz and e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, e.id
    `;
  } else eventOrder = "e.start_date desc nulls last, e.id";

  const withParts: string[] = [];
  if (search.searchCte) withParts.push(search.searchCte);
  withParts.push(
    buildBroadOrderableMarketCandidatesCte({
      materialized: true,
      nowParam,
      extraMarketSql: [
        ...buildFeedMarketCandidateExtraSql({
          add,
          inputs,
          nowParam,
          venueTarget: "event",
          renderableMarketExpr,
          supportedLimitlessMarketExpr,
          hasSearch: search.hasSearch,
        }),
      ],
    }),
  );
  const withClause = withParts.length ? `with ${withParts.join(",\n")}` : "";

  const eventSql = `
    ${withClause}
    select
      e.id
    from unified_events e
    ${search.searchEventJoin}
    join orderable_market_candidates omc on omc.event_id = e.id
    join unified_markets m on m.id = omc.market_id
    ${eventChangeJoin}
    ${tradeJoin}
    ${eventWhere.length ? "where " + eventWhere.join(" and ") : ""}
    group by e.id, e.start_date, e.end_date, e.liquidity
    having ${having.map((clause) => `(${clause})`).join(" and ")}
    ${eventOrder ? `order by ${eventOrder}` : ""}
    limit ${inputs.limit} offset ${inputs.offset}
  `;

  return await queryRowsWithSearchHint<{ id: string }>(
    pool,
    eventSql,
    params,
    search.hasSearch,
    search.hasSearch ? feedSearchWorkMem() : FEED_HEAVY_QUERY_WORK_MEM,
    search.hasSearch ? feedSearchStatementTimeoutMs() : null,
    true,
  );
}

export async function fetchFeedEventIds(
  pool: Pool,
  inputs: FeedInputs,
): Promise<Array<{ id: string }>> {
  const fastRows = await fetchFeedEventIdsFast(pool, inputs);
  if (fastRows) return fastRows;
  return fetchFeedEventIdsExact(pool, inputs);
}

export type FeedMarketRow = {
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
  top_ts_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  top_ts_no: unknown;
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
};

export async function fetchFeedMarkets(
  pool: Pool,
  inputs: FeedInputs,
  eventIds: string[],
): Promise<FeedMarketRow[]> {
  const { params, add } = createParamBuilder();
  // Cap markets per event in feed responses to avoid timeouts on large events.
  const perEventMarketLimit = 100;
  const safeEventLiquidityExpr =
    "case when e.liquidity >= 9e16 then null else e.liquidity end";
  const eventVolumeDisplayExpr = `
    case
      when e.volume_total is not null and e.volume_total > 0 then e.volume_total
      else null
    end
  `;
  const marketVolumeDisplayExpr = `
    case
      when m.volume_total is not null and m.volume_total > 0 then m.volume_total
      else null
    end
  `;
  const eventLiquidityDisplayExpr = `
    coalesce(nullif(${safeEventLiquidityExpr}, 0), nullif(e.open_interest, 0))
  `;
  const marketLiquidityDisplayExpr = `
    coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0))
  `;
  const supportedLimitlessMarketExpr = "true";
  const renderableMarketExpr = buildRenderableMarketSql({ alias: "m" });
  const eventVolumeWindowExpr = `
    coalesce(
      ${eventVolumeDisplayExpr},
      nullif(sum(coalesce(${marketVolumeDisplayExpr}, 0)) over (partition by e.id), 0)
    )
  `;
  const eventLiquidityWindowExpr = `
    coalesce(
      ${eventLiquidityDisplayExpr},
      nullif(
        sum(
          coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0), 0)
        ) over (partition by e.id),
        0
      )
    )
  `;

  const eventIdsParam = add(eventIds);
  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const marketIdsParam = inputs.marketIds?.length
    ? add(inputs.marketIds)
    : null;
  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null
        then (m.best_bid + m.best_ask) / 2
      else null
    end
  `;
  const marketWhere: string[] = [
    buildOrderableMarketSql({
      marketAlias: "m",
      nowParam,
      nowCloseParam,
      pmAlias: "pm_filter",
    }),
    `m.event_id = ANY(${eventIdsParam}::text[])`,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
  ];
  if (marketIdsParam) {
    marketWhere.push(`m.id = ANY(${marketIdsParam}::text[])`);
  }
  const durationSql = buildMarketDurationSql(inputs, add);
  if (durationSql) {
    marketWhere.push(durationSql);
  }

  if (inputs.minLiquidity > 0) {
    marketWhere.push(
      `${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
    );
  }

  if (inputs.minProb != null) {
    marketWhere.push(`${yesMidExpr} >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    marketWhere.push(`${yesMidExpr} <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    marketWhere.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }

  const directMarketSearchPlan = buildFeedSearchPlan(inputs.q);
  const directMarketSearchParam = directMarketSearchPlan.hasSearch
    ? add(directMarketSearchPlan.searchText)
    : null;
  const directMarketPrefixParam = directMarketSearchPlan.hasSearch
    ? add(directMarketSearchPlan.prefixQueryText)
    : null;
  const directMarketRelaxedQueryText = directMarketSearchPlan.hasSearch
    ? buildFeedDirectMarketRelaxedQueryText(inputs.q)
    : null;
  const directMarketRelaxedParam = directMarketRelaxedQueryText
    ? add(directMarketRelaxedQueryText)
    : null;
  const directMarketSearchDocExpr =
    buildFeedDirectMarketSearchDocumentExpr("m");
  const directMarketExactExpr = directMarketSearchParam
    ? `
      lower(regexp_replace(btrim(coalesce(m.title, '')), '\\s+', ' ', 'g')) =
        lower(regexp_replace(btrim(${directMarketSearchParam}::text), '\\s+', ' ', 'g'))
      or exists (
        select 1
        from jsonb_array_elements_text(
          case
            when m.outcomes is not null and btrim(m.outcomes) <> '' then m.outcomes::jsonb
            else '[]'::jsonb
          end
        ) as outcome(label)
        where lower(regexp_replace(btrim(outcome.label), '\\s+', ' ', 'g')) =
          lower(regexp_replace(btrim(${directMarketSearchParam}::text), '\\s+', ' ', 'g'))
      )
    `
    : "false";
  const directMarketRankExpr =
    directMarketSearchPlan.rankMode === "ranked"
      ? `ts_rank_cd((${directMarketSearchDocExpr}), SEARCH_QUERY_PLACEHOLDER) * 2`
      : "coalesce(m.volume_total, m.open_interest, m.liquidity, 0)";
  const buildDirectMarketMatchesSql = (
    queryExpr: "sq.query" | "sq.prefix_query",
    matchKind: "strict" | "relaxed" = "strict",
  ) => `
        select
          m.id as market_id,
          m.event_id,
          (${directMarketExactExpr}) as exact_match,
          ${matchKind === "strict" ? "true" : "false"} as strict_match,
          ${matchKind === "relaxed" ? "true" : "false"} as relaxed_match,
          ${directMarketRankExpr.replace("SEARCH_QUERY_PLACEHOLDER", queryExpr)} as rank
        from unified_markets m
        left join polymarket_markets pm_filter
          on pm_filter.id = m.venue_market_id and m.venue = 'polymarket'
        cross join search_query sq
        where ${queryExpr === "sq.query" ? "querytree(sq.query) <> ''" : "sq.prefix_query is not null and querytree(sq.prefix_query) <> ''"}
          and ${marketWhere.join(" and ")}
          and (${directMarketSearchDocExpr}) @@ ${queryExpr}
      `;
  const directMarketRelaxedMatchesSql = directMarketRelaxedParam
    ? `
        select
          m.id as market_id,
          m.event_id,
          false as exact_match,
          false as strict_match,
          true as relaxed_match,
          coalesce(m.volume_total, m.open_interest, m.liquidity, 0) as rank
        from unified_markets m
        left join polymarket_markets pm_filter
          on pm_filter.id = m.venue_market_id and m.venue = 'polymarket'
        where ${marketWhere.join(" and ")}
          and (${directMarketSearchDocExpr}) @@ to_tsquery('english', ${directMarketRelaxedParam}::text)
      `
    : null;
  const directMarketSearchCtes =
    directMarketSearchPlan.hasSearch &&
    directMarketSearchParam &&
    directMarketPrefixParam
      ? [
          buildFeedSearchQueryCte(
            directMarketSearchParam,
            directMarketPrefixParam,
          ),
          `
      direct_market_matches as materialized (
        select
          market_id,
          event_id,
          bool_or(exact_match) as exact_match,
          bool_or(strict_match) as strict_match,
          bool_or(relaxed_match) as relaxed_match,
          max(rank) as rank
        from (
          ${buildDirectMarketMatchesSql("sq.query")}
          union all
          ${buildDirectMarketMatchesSql("sq.prefix_query")}
          ${
            directMarketRelaxedMatchesSql
              ? `union all
          ${directMarketRelaxedMatchesSql}`
              : ""
          }
        ) matches
        group by market_id, event_id
      )
    `,
          `
      events_with_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
      )
    `,
          `
      events_with_exact_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
        where exact_match
      )
    `,
          `
      events_with_strict_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
        where strict_match
      )
    `,
          `
      events_with_relaxed_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
        where relaxed_match
      )
    `,
        ]
      : [];

  const marketOrder = "eo.ord, m.market_rank, m.venue_market_id";

  const marketRankExpr = `
    row_number() over (
      partition by m.event_id
      order by
        ${
          directMarketSearchPlan.hasSearch
            ? `case when dmm.exact_match then 0 when dmm.strict_match then 1 when dmm.relaxed_match then 2 else 3 end,
        dmm.rank desc nulls last,`
            : ""
        }
        coalesce(${marketVolumeDisplayExpr}, 0) desc nulls last,
        coalesce(${marketLiquidityDisplayExpr}, 0) desc nulls last,
        m.venue_market_id
    ) as market_rank
  `;
  const directMarketJoin = directMarketSearchPlan.hasSearch
    ? "left join direct_market_matches dmm on dmm.market_id = m.id"
    : "";
  const directMarketFilter = directMarketSearchPlan.hasSearch
    ? `
      and (
        (
          exists (
            select 1
            from events_with_exact_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and dmm.exact_match
        )
        or (
          not exists (
            select 1
            from events_with_exact_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and exists (
            select 1
            from events_with_strict_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and dmm.strict_match
        )
        or (
          not exists (
            select 1
            from events_with_exact_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and not exists (
            select 1
            from events_with_strict_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and exists (
            select 1
            from events_with_relaxed_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and dmm.relaxed_match
        )
        or not exists (
          select 1
          from events_with_direct_market_matches edm
          where edm.event_id = m.event_id
        )
      )
    `
    : "";
  const rankedMarketSql = `
    select
      m.*,
      ${marketRankExpr}
    from unified_markets m
    left join polymarket_markets pm_filter
      on pm_filter.id = m.venue_market_id and m.venue = 'polymarket'
    ${directMarketJoin}
    where ${marketWhere.join(" and ")}
    ${directMarketFilter}
  `;

  const marketBaseSql = `
    select
      m.*,
      ${canonicalMarketTokenIdSql("m", "YES")} as resolved_token_yes,
      ${canonicalMarketTokenIdSql("m", "NO")} as resolved_token_no
    from (${rankedMarketSql}) m
    where m.market_rank <= ${add(perEventMarketLimit)}
  `;
  const change24hCteParts: string[] = [];
  if (inputs.sort === "change24h") {
    change24hCteParts.push(`
      market_change as (
        select
          m.id as market_id,
          mc.change_24h
        from unified_markets m
        left join polymarket_markets pm_filter
          on pm_filter.id = m.venue_market_id and m.venue = 'polymarket'
        left join unified_market_change_24h mc on mc.market_id = m.id
        where m.event_id = ANY(${eventIdsParam}::text[])
          ${marketIdsParam ? `and m.id = ANY(${marketIdsParam}::text[])` : ""}
          and ${buildOrderableMarketSql({
            marketAlias: "m",
            nowParam,
            pmAlias: "pm_filter",
          })}
          and ${supportedLimitlessMarketExpr}
      )
    `);
  }
  const currentYesMidExpr = `
    case
      when yes_top.best_bid is not null and yes_top.best_ask is not null
        then (yes_top.best_bid + yes_top.best_ask) / 2
      else coalesce(yes_top.best_bid, yes_top.best_ask, m.best_bid, m.best_ask)
    end
  `;
  const change24hExpr =
    inputs.sort === "change24h"
      ? "mc.change_24h"
      : `
    case
      when ${currentYesMidExpr} is null or yes_24h.avg_mid is null or yes_24h.avg_mid = 0 then null
      else (${currentYesMidExpr} - yes_24h.avg_mid) / yes_24h.avg_mid
    end
  `;

  const eventOrderSql = `
    select
      event_id,
      ord
    from unnest(${eventIdsParam}::text[]) with ordinality as t(event_id, ord)
  `;
  const bookSnapshot = buildFeedBookSnapshotCtes({
    nowParam,
    include24h: inputs.sort !== "change24h",
  });
  const marketChangeJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const limitlessAmmFallbackAllowedExpr = buildLimitlessAmmFallbackAllowedExpr(
    nowParam,
    "yes_top",
    "no_top",
  );
  const marketBestBidExpr = `case when ${limitlessAmmFallbackAllowedExpr} then m.best_bid else null end`;
  const marketBestAskExpr = `case when ${limitlessAmmFallbackAllowedExpr} then m.best_ask else null end`;
  const marketLastPriceExpr = `case when ${limitlessAmmFallbackAllowedExpr} then m.last_price else null end`;
  const withParts: string[] = [];
  if (change24hCteParts.length) withParts.push(...change24hCteParts);
  if (directMarketSearchCtes.length) withParts.push(...directMarketSearchCtes);
  withParts.push(`event_order as (${eventOrderSql})`);
  withParts.push(`market_base as (${marketBaseSql})`);
  withParts.push(...bookSnapshot.ctes);
  const withClause = `with ${withParts.join(",\n")}`;
  const marketSql = `
    ${withClause}
    select
      e.id as event_id,
      e.title as event_title,
      e.duration_minutes as event_duration_minutes,
      e.category,
      e.start_date,
      e.end_date,
      (${safeEventLiquidityExpr}) as event_liquidity,
      (${eventLiquidityWindowExpr}) as event_liquidity_display,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      (${eventVolumeWindowExpr}) as event_volume_display,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
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
      (${marketVolumeDisplayExpr}) as volume_display,
      m.open_interest,
      m.liquidity,
      (${marketLiquidityDisplayExpr}) as liquidity_display,
      ${marketBestBidExpr} as best_bid,
      ${marketBestAskExpr} as best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      yes_top.ts as top_ts_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      no_top.ts as top_ts_no,
      ${marketLastPriceExpr} as last_price,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      (${change24hExpr}) as change_24h,
      m.outcomes,
      m.resolved_token_yes as token_yes,
      m.resolved_token_no as token_no,
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
      m.created_at as market_created_at
    from event_order eo
    join unified_events e on e.id = eo.event_id
    join market_base m on m.event_id = e.id
    left join polymarket_markets pm
      on pm.id = m.venue_market_id and m.venue = 'polymarket'
    ${bookSnapshot.yesTopJoin}
    ${bookSnapshot.yes24hJoin}
    ${marketChangeJoin}
    ${bookSnapshot.noTopJoin}
    ${marketOrder ? `order by ${marketOrder}` : ""}
  `;

  return await queryRowsWithLocalSettings<FeedMarketRow>(
    pool,
    marketSql,
    params,
    {
      workMem: FEED_HEAVY_QUERY_WORK_MEM,
      jitOff: true,
    },
  );
}

type FeedMarketCandidateStateRow = {
  ids: string[];
  candidate_count: number;
};

type FeedTrendingV2CandidateStateRow = {
  ids: string[];
  non_limitless_candidate_count: number;
  non_limitless_valid_count: number;
  limitless_candidate_count: number;
  limitless_valid_count: number;
};

type FeedTrendingV2ScoreRow = {
  id: string;
  venue_market_id: string;
  trend_score: string | number;
};

async function fetchFeedMarketIdsFast(
  pool: Pool,
  inputs: FeedInputs,
  options?: { acceptPartialMetricPage?: boolean },
): Promise<string[] | null> {
  if (inputs.marketIds?.length || inputs.eventScope) return null;
  if (buildFeedSearchPlan(inputs.q).hasSearch) return null;

  const isMetricSort =
    inputs.sort === "change24h" || inputs.sort === "trending_v2";
  const isLegacyTrending = inputs.sort == null || inputs.sort === "trending";
  if (!isMetricSort && !isLegacyTrending) return null;
  if (isMetricSort && inputs.sortDir === "asc") return null;
  if (
    isLegacyTrending &&
    (inputs.filter === "newest" || inputs.filter === "endingsoon")
  ) {
    return null;
  }

  const pageTarget = inputs.limit + inputs.offset;
  const mixedTrendingV2Venues =
    inputs.sort === "trending_v2" &&
    inputs.venues?.includes("limitless") &&
    inputs.venues.some((venue) => venue !== "limitless");
  if (mixedTrendingV2Venues) {
    const nonLimitlessVenues = inputs.venues?.filter(
      (venue) => venue !== "limitless",
    );
    const streamInputs = {
      ...inputs,
      limit: pageTarget,
      offset: 0,
    };
    const [nonLimitlessIds, limitlessIds] = await Promise.all([
      fetchFeedMarketIdsFast(
        pool,
        { ...streamInputs, venues: nonLimitlessVenues },
        { acceptPartialMetricPage: true },
      ),
      fetchFeedMarketIdsFast(
        pool,
        { ...streamInputs, venues: ["limitless"] },
        { acceptPartialMetricPage: true },
      ),
    ]);
    if (!nonLimitlessIds || !limitlessIds) return null;
    const candidateIds = [...new Set([...nonLimitlessIds, ...limitlessIds])];
    if (candidateIds.length === 0) {
      return options?.acceptPartialMetricPage ? [] : null;
    }
    const expressions = buildFeedSqlExpressions();
    const limitlessTrendExpr = `(coalesce(${expressions.marketLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${expressions.marketVolumeDisplayExpr}, 0))`;
    const scoreRows = await queryRowsWithLocalSettings<FeedTrendingV2ScoreRow>(
      pool,
      `
        select
          m.id,
          m.venue_market_id,
          case
            when m.venue = 'limitless' then ${limitlessTrendExpr}
            else metric.volume_24h
          end as trend_score
        from unified_markets m
        left join unified_market_trade_24h metric on metric.market_id = m.id
        where m.id = any($1::text[])
      `,
      [candidateIds],
      { jitOff: true },
    );
    const ids = scoreRows
      .sort((left, right) => {
        const scoreDelta = Number(right.trend_score) - Number(left.trend_score);
        if (scoreDelta !== 0) return scoreDelta;
        return left.venue_market_id.localeCompare(right.venue_market_id);
      })
      .map((row) => row.id)
      .slice(inputs.offset, inputs.offset + inputs.limit);
    return ids.length === inputs.limit || options?.acceptPartialMetricPage
      ? ids
      : null;
  }

  const { params, add } = createParamBuilder();
  const expressions = buildFeedSqlExpressions();
  const {
    marketVolumeDisplayExpr,
    marketLiquidityDisplayExpr,
    renderableMarketExpr,
    supportedLimitlessMarketExpr,
    yesMidExpr,
  } = expressions;
  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const candidateWhere = buildFeedMarketCandidateExtraSql({
    add,
    inputs,
    nowParam,
    venueTarget: "market",
    renderableMarketExpr,
    supportedLimitlessMarketExpr,
  });
  if (inputs.minLiquidity > 0) {
    candidateWhere.push(
      `${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
    );
  }
  if (inputs.minVol > 1e-9) {
    candidateWhere.push(`${marketVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
  }
  if (inputs.minProb != null) {
    candidateWhere.push(`${yesMidExpr} >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    candidateWhere.push(`${yesMidExpr} <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    candidateWhere.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }

  const availabilitySql = buildBroadOrderableMarketSql({
    marketAlias: "m",
    eventAlias: "e",
    nowParam,
    nowCloseParam,
    pmAlias: "pm_filter",
  });
  const candidateWhereSql = candidateWhere.join(" and ");
  const limitParam = add(inputs.limit);
  const offsetParam = add(inputs.offset);

  if (inputs.sort === "change24h") {
    const rows = await queryRowsWithLocalSettings<{ id: string }>(
      pool,
      `
        select candidate.id
        from unified_market_change_24h metric
        cross join lateral (
          select m.id, m.venue_market_id
          from unified_markets m
          join unified_events e on e.id = m.event_id
          left join polymarket_markets pm_filter
            on pm_filter.id = m.venue_market_id
           and m.venue = 'polymarket'
          where m.id = metric.market_id
            and ${candidateWhereSql}
            and ${availabilitySql}
          limit 1
        ) candidate
        where metric.change_24h is not null
        order by metric.change_24h desc nulls last, candidate.venue_market_id
        limit ${limitParam} offset ${offsetParam}
      `,
      params,
      { workMem: FEED_HEAVY_QUERY_WORK_MEM, jitOff: true },
    );
    const ids = rows.map((row) => row.id);
    return ids.length === inputs.limit || options?.acceptPartialMetricPage
      ? ids
      : null;
  }

  if (inputs.sort === "trending_v2") {
    const streamTargetParam = add(pageTarget);
    const limitlessTrendExpr = `(coalesce(${marketLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${marketVolumeDisplayExpr}, 0))`;
    const includeNonLimitless =
      !inputs.venues || inputs.venues.some((venue) => venue !== "limitless");
    const includeLimitless =
      !inputs.venues || inputs.venues.includes("limitless");
    const nonLimitlessVenues = inputs.venues?.filter(
      (venue) => venue !== "limitless",
    );
    const nonLimitlessVenuesParam = nonLimitlessVenues?.length
      ? add(nonLimitlessVenues)
      : null;
    const metricRenderableMarketExpr = buildRenderableMarketSql({
      alias: "metric_market",
    });
    let streamCandidateLimit = Math.max(
      FEED_EVENT_FAST_MIN_CANDIDATES,
      pageTarget * FEED_EVENT_FAST_CANDIDATE_FACTOR,
    );
    const streamCandidateLimitParam = add(streamCandidateLimit);
    const streamCandidateLimitParamIndex = params.length - 1;
    const sql = `
        with non_limitless_ranked_candidates as materialized (
          ${
            includeNonLimitless
              ? `
          select
            metric.market_id as id,
            metric.volume_24h as trend_score,
            row_number() over (
              order by metric.volume_24h desc nulls last, metric.market_id
            ) as full_ord
          from unified_market_trade_24h metric
          join unified_markets metric_market on metric_market.id = metric.market_id
          where metric.volume_24h > 0
            and metric_market.venue <> 'limitless'
            and metric_market.status = 'ACTIVE'
            and ${metricRenderableMarketExpr}
            ${
              nonLimitlessVenuesParam
                ? `and metric_market.venue = ANY(${nonLimitlessVenuesParam}::text[])`
                : ""
            }
          order by metric.volume_24h desc nulls last, metric.market_id
          limit ${streamCandidateLimitParam}
          `
              : `
          select
            null::text as id,
            null::numeric as trend_score,
            null::bigint as full_ord
          where ${streamCandidateLimitParam}::integer >= 0 and false
          `
          }
        ),
        non_limitless_candidates as materialized (
          select
            m.id,
            m.venue_market_id,
            ranked.trend_score
          from non_limitless_ranked_candidates ranked
          join unified_markets m on m.id = ranked.id
          join unified_events e on e.id = m.event_id
          left join polymarket_markets pm_filter
            on pm_filter.id = m.venue_market_id
           and m.venue = 'polymarket'
          where m.venue <> 'limitless'
            ${
              nonLimitlessVenuesParam
                ? `and m.venue = ANY(${nonLimitlessVenuesParam}::text[])`
                : ""
            }
            and ${candidateWhereSql}
            and ${availabilitySql}
          order by ranked.full_ord
          limit ${streamTargetParam}
        ),
        limitless_ranked_candidates as materialized (
          ${
            includeLimitless
              ? `
          select
            m.id,
            m.venue_market_id,
            row_number() over (
              order by ${limitlessTrendExpr} desc nulls last, m.venue_market_id
            ) as full_ord
          from unified_markets m
          where m.venue = 'limitless'
            and m.status = 'ACTIVE'
            and ${renderableMarketExpr}
            and ${limitlessTrendExpr} > 0
          order by ${limitlessTrendExpr} desc nulls last, m.venue_market_id
          limit ${streamCandidateLimitParam}
          `
              : `
          select
            null::text as id,
            null::text as venue_market_id,
            null::bigint as full_ord
          where ${streamCandidateLimitParam}::integer >= 0 and false
          `
          }
        ),
        limitless_candidates as materialized (
          select
            m.id,
            m.venue_market_id,
            ${limitlessTrendExpr} as trend_score
          from limitless_ranked_candidates ranked
          join unified_markets m on m.id = ranked.id
          join unified_events e on e.id = m.event_id
          left join polymarket_markets pm_filter
            on pm_filter.id = m.venue_market_id
           and m.venue = 'polymarket'
          where m.venue = 'limitless'
            and ${candidateWhereSql}
            and ${availabilitySql}
          order by ranked.full_ord
          limit ${streamTargetParam}
        ),
        combined_page as materialized (
          select *
          from (
            select * from non_limitless_candidates
            union all
            select * from limitless_candidates
          ) combined
          order by combined.trend_score desc nulls last, combined.venue_market_id
          limit ${streamTargetParam}
        )
        select
          coalesce(
            (select array_agg(id order by trend_score desc nulls last, venue_market_id) from combined_page),
            '{}'::text[]
          ) as ids,
          (select count(*)::int from non_limitless_ranked_candidates) as non_limitless_candidate_count,
          (select count(*)::int from non_limitless_candidates) as non_limitless_valid_count,
          (select count(*)::int from limitless_ranked_candidates) as limitless_candidate_count,
          (select count(*)::int from limitless_candidates) as limitless_valid_count,
          ${limitParam}::integer as requested_limit,
          ${offsetParam}::integer as requested_offset
      `;

    for (;;) {
      params[streamCandidateLimitParamIndex] = streamCandidateLimit;
      const rows =
        await queryRowsWithLocalSettings<FeedTrendingV2CandidateStateRow>(
          pool,
          sql,
          params,
          { workMem: FEED_HEAVY_QUERY_WORK_MEM, jitOff: true },
        );
      const state = rows[0];
      const ids = state?.ids ?? [];
      const nonLimitlessCandidateCount = Number(
        state?.non_limitless_candidate_count ?? 0,
      );
      const nonLimitlessValidCount = Number(
        state?.non_limitless_valid_count ?? 0,
      );
      const limitlessCandidateCount = Number(
        state?.limitless_candidate_count ?? 0,
      );
      const limitlessValidCount = Number(state?.limitless_valid_count ?? 0);
      if (
        (includeNonLimitless &&
          nonLimitlessValidCount < pageTarget &&
          nonLimitlessCandidateCount >= streamCandidateLimit) ||
        (includeLimitless &&
          limitlessValidCount < pageTarget &&
          limitlessCandidateCount >= streamCandidateLimit)
      ) {
        streamCandidateLimit = expandFeedCandidateLimit(streamCandidateLimit);
        continue;
      }
      const pageIds = ids.slice(inputs.offset, inputs.offset + inputs.limit);
      return pageIds.length === inputs.limit || options?.acceptPartialMetricPage
        ? pageIds
        : null;
    }
  }

  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";
  const sevenDaysAgoParam = add(inputs.sevenDaysAgo);
  const sevenDaysFromNowParam = add(inputs.sevenDaysFromNow);
  const trendScoreExpr = `(
    coalesce(${marketVolumeDisplayExpr}, 0) * 0.4
    + coalesce(${marketLiquidityDisplayExpr}, 0) * 0.3
    + case when e.start_date >= ${sevenDaysAgoParam}::timestamptz then 1000 else 0 end * 0.2
    + case
        when e.end_date > ${nowParam}::timestamptz
         and e.end_date <= ${sevenDaysFromNowParam}::timestamptz
          then 500
        else 0
      end * 0.1
  )`;
  let candidateLimit = Math.max(
    FEED_EVENT_FAST_MIN_CANDIDATES,
    pageTarget * FEED_EVENT_FAST_CANDIDATE_FACTOR,
  );
  const candidateLimitParam = add(candidateLimit);
  const candidateLimitParamIndex = params.length - 1;
  const targetParam = add(pageTarget);
  const sql = `
    with ranked_market_candidates as materialized (
      select
        m.id,
        m.venue_market_id,
        row_number() over (
          order by ${trendScoreExpr} ${sortDir} nulls last, m.venue_market_id
        ) as full_ord
      from unified_markets m
      join unified_events e on e.id = m.event_id
      where m.status = 'ACTIVE'
        and e.status = 'ACTIVE'
        and ${candidateWhereSql}
        and ${limitParam}::integer >= 0
        and ${offsetParam}::integer >= 0
      order by ${trendScoreExpr} ${sortDir} nulls last, m.venue_market_id
      limit ${candidateLimitParam}
    ),
    valid_ranked_markets as materialized (
      select ranked.id, ranked.full_ord
      from ranked_market_candidates ranked
      join unified_markets m on m.id = ranked.id
      join unified_events e on e.id = m.event_id
      left join polymarket_markets pm_filter
        on pm_filter.id = m.venue_market_id
       and m.venue = 'polymarket'
      where ${availabilitySql}
    )
    select
      coalesce(
        (
          select array_agg(page.id order by page.full_ord)
          from (
            select id, full_ord
            from valid_ranked_markets
            order by full_ord
            limit ${targetParam}
          ) page
        ),
        '{}'::text[]
      ) as ids,
      (select count(*)::int from ranked_market_candidates) as candidate_count
  `;

  for (;;) {
    params[candidateLimitParamIndex] = candidateLimit;
    const rows = await queryRowsWithLocalSettings<FeedMarketCandidateStateRow>(
      pool,
      sql,
      params,
      { workMem: FEED_HEAVY_QUERY_WORK_MEM, jitOff: true },
    );
    const ids = rows[0]?.ids ?? [];
    const candidateCount = Number(rows[0]?.candidate_count ?? 0);
    if (ids.length >= pageTarget || candidateCount < candidateLimit) {
      return ids.slice(inputs.offset, inputs.offset + inputs.limit);
    }
    candidateLimit = expandFeedCandidateLimit(candidateLimit);
  }
}

export async function fetchFeedMarketsDirect(
  pool: Pool,
  inputs: FeedInputs,
  preselectedMarketIds?: string[],
): Promise<FeedMarketRow[]> {
  if (!preselectedMarketIds) {
    const fastMarketIds = await fetchFeedMarketIdsFast(pool, inputs);
    if (fastMarketIds) {
      if (fastMarketIds.length === 0) return [];
      return fetchFeedMarketsDirect(
        pool,
        {
          ...inputs,
          marketIds: undefined,
          q: undefined,
          eventScope: undefined,
          venues: undefined,
          category: undefined,
          categories: undefined,
          filter: undefined,
          durationMinutes: undefined,
          endWithin: undefined,
          ageSince: undefined,
          minVol: 0,
          minLiquidity: 0,
          minProb: undefined,
          maxProb: undefined,
          maxSpread: undefined,
        },
        fastMarketIds,
      );
    }
  }
  const { params, add } = createParamBuilder();
  const expressions = buildFeedSqlExpressions();
  const {
    safeEventLiquidityExpr,
    eventVolumeDisplayExpr,
    marketVolumeDisplayExpr,
    eventLiquidityDisplayExpr,
    marketLiquidityDisplayExpr,
  } = expressions;
  const eventVolumeWindowExpr = `
    coalesce(
      ${eventVolumeDisplayExpr},
      nullif(sum(coalesce(${marketVolumeDisplayExpr}, 0)) over (partition by e.id), 0)
    )
  `;
  const eventLiquidityWindowExpr = `
    coalesce(
      ${eventLiquidityDisplayExpr},
      nullif(
        sum(
          coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0), 0)
        ) over (partition by e.id),
        0
      )
    )
  `;
  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";
  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const marketContext = buildFeedMarketViewContext({
    add,
    inputs,
    nowParam,
    nowCloseParam,
    expressions,
    searchMatchLimit: feedSearchResultMatchLimitForInputs(inputs),
    searchFallbackThreshold: feedSearchFallbackThresholdForInputs(inputs),
    venueFilterTarget: "market",
  });
  const where = marketContext.where;

  const directMarketSearchPlan = buildFeedSearchPlan(inputs.q);
  const directMarketSearchParam = directMarketSearchPlan.hasSearch
    ? add(directMarketSearchPlan.searchText)
    : null;
  const directMarketRelaxedQueryText = directMarketSearchPlan.hasSearch
    ? buildFeedDirectMarketRelaxedQueryText(inputs.q)
    : null;
  const directMarketRelaxedParam = directMarketRelaxedQueryText
    ? add(directMarketRelaxedQueryText)
    : null;
  const directMarketSearchDocExpr =
    buildFeedDirectMarketSearchDocumentExpr("m");
  const directMarketExactExpr = directMarketSearchParam
    ? `
      lower(regexp_replace(btrim(coalesce(m.title, '')), '\\s+', ' ', 'g')) =
        lower(regexp_replace(btrim(${directMarketSearchParam}::text), '\\s+', ' ', 'g'))
      or exists (
        select 1
        from jsonb_array_elements_text(
          case
            when m.outcomes is not null and btrim(m.outcomes) <> '' then m.outcomes::jsonb
            else '[]'::jsonb
          end
        ) as outcome(label)
        where lower(regexp_replace(btrim(outcome.label), '\\s+', ' ', 'g')) =
          lower(regexp_replace(btrim(${directMarketSearchParam}::text), '\\s+', ' ', 'g'))
      )
    `
    : "false";
  const directMarketRankExpr =
    directMarketSearchPlan.rankMode === "ranked"
      ? `ts_rank_cd((${directMarketSearchDocExpr}), SEARCH_QUERY_PLACEHOLDER) * 2`
      : "coalesce(m.volume_total, m.open_interest, m.liquidity, 0)";
  const buildDirectMarketViewMatchesSql = (
    queryExpr: "sq.query" | "sq.prefix_query",
    matchKind: "strict" | "relaxed" = "strict",
  ) => `
        select
          m.id as market_id,
          m.event_id,
          (${directMarketExactExpr}) as exact_match,
          ${matchKind === "strict" ? "true" : "false"} as strict_match,
          ${matchKind === "relaxed" ? "true" : "false"} as relaxed_match,
          ${directMarketRankExpr.replace("SEARCH_QUERY_PLACEHOLDER", queryExpr)} as rank
        from ${marketContext.orderableMarketCandidateSource} omc
        join unified_markets m on m.id = omc.market_id
        join unified_events e on e.id = omc.event_id
        cross join search_query sq
        where ${queryExpr === "sq.query" ? "querytree(sq.query) <> ''" : "sq.prefix_query is not null and querytree(sq.prefix_query) <> ''"}
          and ${where.join(" and ")}
          and (${directMarketSearchDocExpr}) @@ ${queryExpr}
      `;
  const directMarketRelaxedMatchesSql = directMarketRelaxedParam
    ? `
        select
          m.id as market_id,
          m.event_id,
          false as exact_match,
          false as strict_match,
          true as relaxed_match,
          coalesce(m.volume_total, m.open_interest, m.liquidity, 0) as rank
        from ${marketContext.orderableMarketCandidateSource} omc
        join unified_markets m on m.id = omc.market_id
        join unified_events e on e.id = omc.event_id
        where ${where.join(" and ")}
          and (${directMarketSearchDocExpr}) @@ to_tsquery('english', ${directMarketRelaxedParam}::text)
      `
    : null;
  const directMarketSearchCtes =
    directMarketSearchPlan.hasSearch && directMarketSearchParam
      ? [
          `
      direct_market_matches as materialized (
        select
          market_id,
          event_id,
          bool_or(exact_match) as exact_match,
          bool_or(strict_match) as strict_match,
          bool_or(relaxed_match) as relaxed_match,
          max(rank) as rank
        from (
          ${buildDirectMarketViewMatchesSql("sq.query")}
          union all
          ${buildDirectMarketViewMatchesSql("sq.prefix_query")}
          ${
            directMarketRelaxedMatchesSql
              ? `union all
          ${directMarketRelaxedMatchesSql}`
              : ""
          }
        ) matches
        group by market_id, event_id
      )
    `,
          `
      events_with_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
      )
    `,
          `
      events_with_exact_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
        where exact_match
      )
    `,
          `
      events_with_strict_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
        where strict_match
      )
    `,
          `
      events_with_relaxed_direct_market_matches as materialized (
        select distinct event_id
        from direct_market_matches
        where relaxed_match
      )
    `,
        ]
      : [];
  const directMarketJoin = directMarketSearchPlan.hasSearch
    ? "left join direct_market_matches dmm on dmm.market_id = m.id"
    : "";
  const directMarketFilter = directMarketSearchPlan.hasSearch
    ? `
      and (
        (
          exists (
            select 1
            from events_with_exact_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and dmm.exact_match
        )
        or (
          not exists (
            select 1
            from events_with_exact_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and exists (
            select 1
            from events_with_strict_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and dmm.strict_match
        )
        or (
          not exists (
            select 1
            from events_with_exact_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and not exists (
            select 1
            from events_with_strict_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and exists (
            select 1
            from events_with_relaxed_direct_market_matches edm
            where edm.event_id = m.event_id
          )
          and dmm.relaxed_match
        )
        or not exists (
          select 1
          from events_with_direct_market_matches edm
          where edm.event_id = m.event_id
        )
      )
    `
    : "";

  let marketOrder = "";
  if (inputs.sort === "totalvol")
    marketOrder = `${marketVolumeDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "liquidity")
    marketOrder = `${marketLiquidityDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "openinterest")
    marketOrder = `m.open_interest ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "change24h")
    marketOrder = `change_24h ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "time")
    marketOrder = `${buildFutureMarketEndSortSql(nowParam)} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.filter === "newest")
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  else if (inputs.filter === "endingsoon")
    marketOrder = `${buildFutureEventEndSortSql("e", nowParam)} asc nulls last, m.venue_market_id`;
  else if (inputs.sort === "trending_v2") {
    const marketTrendExpr = `
      case
        when m.venue = 'limitless'
          then (coalesce(${marketLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${marketVolumeDisplayExpr}, 0))
        else coalesce(trade_24h.volume_24h, 0)
      end
    `;
    marketOrder = `${marketTrendExpr} ${sortDir} nulls last, m.venue_market_id`;
  } else if (inputs.sort == null || inputs.sort === "trending") {
    const directSearchOrder = directMarketSearchPlan.hasSearch
      ? `case when dmm.exact_match then 0 when dmm.strict_match then 1 when dmm.relaxed_match then 2 else 3 end,
         dmm.rank desc nulls last, `
      : "";
    const searchOrder = marketContext.hasSearch
      ? `${directSearchOrder}${marketContext.joinedRankExpr} desc nulls last, `
      : "";
    marketOrder = `
      ${searchOrder}(coalesce(${marketVolumeDisplayExpr}, 0) * 0.4 +
       coalesce(${marketLiquidityDisplayExpr}, 0) * 0.3 +
       case when e.start_date >= (${nowParam}::timestamptz - interval '7 days') then 1000 else 0 end * 0.2 +
       case when e.end_date > ${nowParam}::timestamptz and e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id";

  const preselectedMarketIdsParam = preselectedMarketIds
    ? add(preselectedMarketIds)
    : null;
  const limitParam = add(inputs.limit);
  const offsetParam = add(inputs.offset);
  const change24hCandidateJoin =
    inputs.sort === "change24h"
      ? "left join unified_market_change_24h mc on mc.market_id = m.id"
      : "";
  const tradeJoin =
    inputs.sort === "trending_v2"
      ? "left join unified_market_trade_24h trade_24h on trade_24h.market_id = m.id"
      : "";
  const change24hCandidateExpr =
    inputs.sort === "change24h" ? "mc.change_24h" : "null";

  const buildMarketCandidatesInnerSql = (extraWhere: string[] = []) => `
      select
        m.id,
        m.event_id
        ${inputs.sort === "change24h" ? `, (${change24hCandidateExpr}) as change_24h` : ""}
      from ${marketContext.orderableMarketCandidateSource} omc
      join unified_markets m on m.id = omc.market_id
      join unified_events e on e.id = omc.event_id
      ${marketContext.searchEventJoin}
      ${directMarketJoin}
      ${change24hCandidateJoin}
      ${tradeJoin}
      where ${[...where, ...extraWhere].join(" and ")}
      ${directMarketFilter}
      ${marketOrder ? `order by ${marketOrder}` : ""}
      limit ${limitParam} offset ${offsetParam}
    `;
  const buildExactMarketCandidatesSql = (extraWhere: string[] = []) => `
    select
      page.*,
      row_number() over () as ord
    from (${buildMarketCandidatesInnerSql(extraWhere)}) page
  `;
  const marketCandidatesSql = buildExactMarketCandidatesSql();

  const metricFirstTargetParam =
    !preselectedMarketIdsParam &&
    sortDir === "desc" &&
    (inputs.sort === "change24h" || inputs.sort === "trending_v2")
      ? add(inputs.limit + inputs.offset)
      : null;
  let metricFirstMarketCandidateCtes: string[] | null = null;
  if (metricFirstTargetParam && inputs.sort === "change24h") {
    const metricStateCountExpr =
      "(select candidate_count from metric_market_candidate_state)";
    metricFirstMarketCandidateCtes = [
      `
        metric_market_candidates as materialized (
          select
            m.id,
            m.event_id,
            mc.change_24h,
            row_number() over (
              order by mc.change_24h ${sortDir} nulls last, m.venue_market_id
            ) as full_ord
          from unified_market_change_24h mc
          join ${marketContext.orderableMarketCandidateSource} omc on omc.market_id = mc.market_id
          join unified_markets m on m.id = omc.market_id
          join unified_events e on e.id = omc.event_id
          ${marketContext.searchEventJoin}
          ${directMarketJoin}
          where ${where.join(" and ")}
            ${directMarketFilter}
            and mc.change_24h is not null
          order by mc.change_24h ${sortDir} nulls last, m.venue_market_id
          limit ${metricFirstTargetParam}
        )
      `,
      `
        metric_market_candidate_state as materialized (
          select count(*)::int as candidate_count
          from metric_market_candidates
        )
      `,
      `
        metric_market_candidate_page as materialized (
          select
            page.id,
            page.event_id,
            page.change_24h,
            row_number() over (order by page.full_ord) as ord
          from metric_market_candidates page
          where ${metricStateCountExpr} >= ${metricFirstTargetParam}
            and page.full_ord > ${offsetParam}
          order by page.full_ord
          limit ${limitParam}
        )
      `,
      `
        exact_market_candidate_page as materialized (${buildExactMarketCandidatesSql(
          [`${metricStateCountExpr} < ${metricFirstTargetParam}`],
        )})
      `,
      `
        market_candidates as (
          select * from metric_market_candidate_page
          union all
          select * from exact_market_candidate_page
        )
      `,
    ];
  } else if (metricFirstTargetParam && inputs.sort === "trending_v2") {
    const metricStateCountExpr =
      "(select candidate_count from metric_market_candidate_state)";
    const limitlessTrendExpr = `(coalesce(${marketLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${marketVolumeDisplayExpr}, 0))`;
    metricFirstMarketCandidateCtes = [
      `
        metric_market_candidate_pool as materialized (
          select
            candidate.id,
            candidate.event_id,
            row_number() over (
              order by candidate.trend_score ${sortDir} nulls last, candidate.venue_market_id
            ) as full_ord
          from (
            select
              m.id,
              m.event_id,
              m.venue_market_id,
              trade_24h.volume_24h as trend_score
            from unified_market_trade_24h trade_24h
            join ${marketContext.orderableMarketCandidateSource} omc on omc.market_id = trade_24h.market_id
            join unified_markets m on m.id = omc.market_id
            join unified_events e on e.id = omc.event_id
            ${marketContext.searchEventJoin}
            ${directMarketJoin}
            where ${where.join(" and ")}
              ${directMarketFilter}
              and m.venue <> 'limitless'
              and trade_24h.volume_24h > 0
            union all
            select
              m.id,
              m.event_id,
              m.venue_market_id,
              ${limitlessTrendExpr} as trend_score
            from ${marketContext.orderableMarketCandidateSource} omc
            join unified_markets m on m.id = omc.market_id
            join unified_events e on e.id = omc.event_id
            ${marketContext.searchEventJoin}
            ${directMarketJoin}
            where ${where.join(" and ")}
              ${directMarketFilter}
              and m.venue = 'limitless'
              and ${limitlessTrendExpr} > 0
          ) candidate
          order by candidate.trend_score ${sortDir} nulls last, candidate.venue_market_id
          limit ${metricFirstTargetParam}
        )
      `,
      `
        metric_market_candidate_state as materialized (
          select count(*)::int as candidate_count
          from metric_market_candidate_pool
        )
      `,
      `
        metric_market_candidate_page as materialized (
          select
            page.id,
            page.event_id,
            row_number() over (order by page.full_ord) as ord
          from metric_market_candidate_pool page
          where ${metricStateCountExpr} >= ${metricFirstTargetParam}
            and page.full_ord > ${offsetParam}
          order by page.full_ord
          limit ${limitParam}
        )
      `,
      `
        exact_market_candidate_page as materialized (${buildExactMarketCandidatesSql(
          [`${metricStateCountExpr} < ${metricFirstTargetParam}`],
        )})
      `,
      `
        market_candidates as (
          select * from metric_market_candidate_page
          union all
          select * from exact_market_candidate_page
        )
      `,
    ];
  }

  const preselectedMarketCandidatesSql = preselectedMarketIdsParam
    ? `
      select
        m.id,
        m.event_id
        ${inputs.sort === "change24h" ? ", metric.change_24h" : ""},
        selected.ord::bigint as ord
      from unnest(${preselectedMarketIdsParam}::text[])
        with ordinality selected(id, ord)
      join unified_markets m on m.id = selected.id
      ${
        inputs.sort === "change24h"
          ? "left join unified_market_change_24h metric on metric.market_id = m.id"
          : ""
      }
      where ${limitParam}::integer >= 0
        and ${offsetParam}::integer >= 0
        and ${nowParam}::timestamptz is not null
        and ${nowCloseParam}::timestamptz is not null
      order by selected.ord
    `
    : null;

  const marketBaseSql = `
    select
      m.*,
      mc.ord as ord
      ${inputs.sort === "change24h" ? ", mc.change_24h as change_24h" : ""}
      , ${canonicalMarketTokenIdSql("m", "YES")} as resolved_token_yes,
      ${canonicalMarketTokenIdSql("m", "NO")} as resolved_token_no
    from unified_markets m
    join market_candidates mc on mc.id = m.id
  `;
  const currentYesMidExpr = `
    case
      when yes_top.best_bid is not null and yes_top.best_ask is not null
        then (yes_top.best_bid + yes_top.best_ask) / 2
      else coalesce(yes_top.best_bid, yes_top.best_ask, m.best_bid, m.best_ask)
    end
  `;
  const change24hExpr = `
    ${
      inputs.sort === "change24h"
        ? "m.change_24h"
        : `case
      when ${currentYesMidExpr} is null or yes_24h.avg_mid is null or yes_24h.avg_mid = 0 then null
      else (${currentYesMidExpr} - yes_24h.avg_mid) / yes_24h.avg_mid
    end`
    }
  `;
  const bookSnapshot = buildFeedBookSnapshotCtes({
    nowParam,
    include24h: inputs.sort !== "change24h",
  });
  const limitlessAmmFallbackAllowedExpr = buildLimitlessAmmFallbackAllowedExpr(
    nowParam,
    "yes_top",
    "no_top",
  );
  const marketBestBidExpr = `case when ${limitlessAmmFallbackAllowedExpr} then m.best_bid else null end`;
  const marketBestAskExpr = `case when ${limitlessAmmFallbackAllowedExpr} then m.best_ask else null end`;
  const marketLastPriceExpr = `case when ${limitlessAmmFallbackAllowedExpr} then m.last_price else null end`;
  const withParts: string[] = [];
  if (preselectedMarketCandidatesSql) {
    withParts.push(
      `market_candidates as materialized (${preselectedMarketCandidatesSql})`,
    );
  } else {
    if (marketContext.searchCte) withParts.push(marketContext.searchCte);
    withParts.push(marketContext.orderableMarketCandidatesCte);
    if (marketContext.scopedOrderableMarketCandidatesCte) {
      withParts.push(marketContext.scopedOrderableMarketCandidatesCte);
    }
    if (directMarketSearchCtes.length)
      withParts.push(...directMarketSearchCtes);
    if (metricFirstMarketCandidateCtes) {
      withParts.push(...metricFirstMarketCandidateCtes);
    } else {
      withParts.push(`market_candidates as (${marketCandidatesSql})`);
    }
  }
  withParts.push(`market_base as (${marketBaseSql})`);
  withParts.push(...bookSnapshot.ctes);
  const withClause = `with ${withParts.join(",\n")}`;

  const marketSql = `
    ${withClause}
    select
      e.id as event_id,
      e.title as event_title,
      e.duration_minutes as event_duration_minutes,
      e.category,
      e.start_date,
      e.end_date,
      (${safeEventLiquidityExpr}) as event_liquidity,
      (${eventLiquidityWindowExpr}) as event_liquidity_display,
      e.volume_total as event_volume,
      e.volume_24h as event_volume_24h,
      (${eventVolumeWindowExpr}) as event_volume_display,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
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
      (${marketVolumeDisplayExpr}) as volume_display,
      m.open_interest,
      m.liquidity,
      (${marketLiquidityDisplayExpr}) as liquidity_display,
      ${marketBestBidExpr} as best_bid,
      ${marketBestAskExpr} as best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      yes_top.ts as top_ts_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      no_top.ts as top_ts_no,
      ${marketLastPriceExpr} as last_price,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      (${change24hExpr}) as change_24h,
      m.outcomes,
      m.resolved_token_yes as token_yes,
      m.resolved_token_no as token_no,
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
      m.created_at as market_created_at
    from unified_events e
    join market_base m on m.event_id = e.id
    left join polymarket_markets pm
      on pm.id = m.venue_market_id and m.venue = 'polymarket'
    ${bookSnapshot.yesTopJoin}
    ${bookSnapshot.yes24hJoin}
    ${bookSnapshot.noTopJoin}
    order by m.ord, m.venue_market_id
  `;

  return await queryRowsWithLocalSettings<FeedMarketRow>(
    pool,
    marketSql,
    params,
    {
      useSearchHint: marketContext.hasSearch,
      workMem: marketContext.hasSearch
        ? feedSearchWorkMem()
        : FEED_HEAVY_QUERY_WORK_MEM,
      statementTimeoutMs: marketContext.hasSearch
        ? feedSearchStatementTimeoutMs()
        : null,
      jitOff: true,
    },
  );
}

export async function fetchFeedMarketSearchCandidateIds(
  pool: Pool,
  input: {
    limit: number;
    now: string;
    query: string;
    venues: string[];
  },
): Promise<string[]> {
  if (input.limit <= 0 || input.venues.length === 0) return [];
  const query = input.query.trim();
  if (!query) return [];
  const { params, add } = createParamBuilder();
  const queryParam = add(query);
  const venuesParam = add(input.venues);
  const nowParam = add(input.now);
  const limitParam = add(input.limit);
  const eventDocument = buildFeedSearchDocumentExpr("e", "primary");
  const marketDocument = buildFeedSearchDocumentExpr("m", "primary");
  const orderable = buildOrderableMarketSql({
    eventAlias: "e",
    marketAlias: "m",
    nowCloseParam: nowParam,
    nowParam,
    pmAlias: "pm_filter",
  });
  const renderable = buildRenderableMarketSql({ alias: "m" });
  const rows = await queryRowsWithLocalSettings<{ id: string }>(
    pool,
    `
      with search_query as materialized (
        select websearch_to_tsquery('english', ${queryParam}::text) as value
      ),
      candidate_hits as materialized (
        select
          m.id,
          0 as source_priority,
          ts_rank_cd((${marketDocument}), search_query.value) as search_rank
        from unified_markets m
        join unified_events e on e.id = m.event_id
        left join polymarket_markets pm_filter
          on pm_filter.id = m.venue_market_id
         and m.venue = 'polymarket'
        cross join search_query
        where m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and m.venue = any(${venuesParam}::text[])
          and (${marketDocument}) @@ search_query.value
          and ${orderable}
          and ${renderable}
        union all
        select
          m.id,
          1 as source_priority,
          ts_rank_cd((${eventDocument}), search_query.value) as search_rank
        from unified_events e
        join unified_markets m on m.event_id = e.id
        left join polymarket_markets pm_filter
          on pm_filter.id = m.venue_market_id
         and m.venue = 'polymarket'
        cross join search_query
        where m.status = 'ACTIVE'
          and e.status = 'ACTIVE'
          and m.venue = any(${venuesParam}::text[])
          and (${eventDocument}) @@ search_query.value
          and ${orderable}
          and ${renderable}
      ),
      ranked as (
        select
          id,
          min(source_priority) as source_priority,
          max(search_rank) as search_rank
        from candidate_hits
        group by id
      )
      select id
      from ranked
      order by source_priority, search_rank desc nulls last, id
      limit ${limitParam}
    `,
    params,
    {
      jitOff: true,
      statementTimeoutMs: 4_000,
      useSearchHint: true,
      workMem: feedSearchWorkMem(),
    },
  );
  return rows.map((row) => row.id);
}

export async function fetchFavoriteFeedEventPage(
  pool: Pool,
  inputs: FeedInputs,
): Promise<FavoriteFeedEventPage> {
  if (!inputs.marketIds?.length) {
    return { eventIds: [], totalEvents: 0, totalMarkets: 0 };
  }

  const { params, add } = createParamBuilder();
  const supportedLimitlessMarketExpr = "true";
  const renderableMarketExpr = buildRenderableMarketSql({ alias: "m" });
  const sortDir = inputs.sortDir === "asc" ? "asc" : "desc";
  const marketIdsParam = add(inputs.marketIds);
  const nowParam = add(inputs.nowParam);
  const nowCloseParam = add(inputs.nowParam);
  const search = buildFeedSearchContext({
    add,
    q: inputs.q,
    nowParam,
    renderableMarketExpr,
    earlyFilterInputs: inputs,
    venueFilterTarget: "market",
  });
  const favoriteDurationSql = buildMarketDurationSql(inputs, add);
  const marketCountCte = `
    market_count as (
      select m.event_id, count(*) as market_count
      from unified_markets m
      join unified_events e on e.id = m.event_id
      left join polymarket_markets pm_filter
        on pm_filter.id = m.venue_market_id and m.venue = 'polymarket'
      ${search.searchMarketJoin}
      where ${buildOrderableMarketSql({
        marketAlias: "m",
        eventAlias: "e",
        nowParam,
        nowCloseParam,
        pmAlias: "pm_filter",
      })}
        and m.id = ANY(${marketIdsParam}::text[])
        ${search.hasSearch ? `and ${search.searchFilterExpr}` : ""}
        and ${supportedLimitlessMarketExpr}
        and ${renderableMarketExpr}
        ${favoriteDurationSql ? `and ${favoriteDurationSql}` : ""}
      group by m.event_id
    )
  `;
  const marketVolumeDisplayExpr = `
    case
      when m.volume_total is not null and m.volume_total > 0 then m.volume_total
      else null
    end
  `;
  const marketLiquidityDisplayExpr = `
    coalesce(nullif(m.liquidity, 0), nullif(m.open_interest, 0))
  `;
  const yesMidExpr = `
    case
      when m.best_bid is not null and m.best_ask is not null
        then (m.best_bid + m.best_ask) / 2
      else null
    end
  `;
  const change24hCteParts: string[] = [];
  if (inputs.sort === "change24h") {
    change24hCteParts.push(`
      market_change as (
        select market_id, change_24h
        from unified_market_change_24h
      )
    `);
  }
  const where: string[] = [
    buildOrderableMarketSql({
      marketAlias: "m",
      eventAlias: "e",
      nowParam,
      nowCloseParam,
      pmAlias: "pm_filter",
    }),
    `m.id = ANY(${marketIdsParam}::text[])`,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
  ];
  if (search.hasSearch) {
    where.push(search.searchFilterExpr);
  }
  if (favoriteDurationSql) {
    where.push(favoriteDurationSql);
  }

  if (inputs.venues) {
    where.push(
      inputs.venues.length
        ? `m.venue = ANY(${add(inputs.venues)}::text[])`
        : "false",
    );
  }
  if (inputs.categories?.length) {
    where.push(`lower(e.category) = ANY(${add(inputs.categories)}::text[])`);
  } else if (inputs.category) {
    where.push(`lower(e.category) = ${add(inputs.category.toLowerCase())}`);
  }
  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    where.push(
      `e.end_date is not null and e.end_date > ${nowParam}::timestamptz and e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`,
    );
  }
  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date > ${nowParam}::timestamptz and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
    );
  }
  if (inputs.ageSince) {
    where.push(
      `e.start_date is not null and e.start_date >= ${add(inputs.ageSince)}::timestamptz`,
    );
  }
  if (inputs.minLiquidity > 0) {
    where.push(`${marketLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`);
  }
  if (inputs.minVol > 1e-9) {
    where.push(`${marketVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
  }
  if (inputs.minProb != null) {
    where.push(`${yesMidExpr} >= ${add(inputs.minProb)}`);
  }
  if (inputs.maxProb != null) {
    where.push(`${yesMidExpr} <= ${add(inputs.maxProb)}`);
  }
  if (inputs.maxSpread != null) {
    where.push(
      `m.best_bid is not null and m.best_ask is not null and (m.best_ask - m.best_bid) <= ${add(inputs.maxSpread)}`,
    );
  }
  if (inputs.eventScope === "grouped") {
    where.push("emc.market_count > 1");
  } else if (inputs.eventScope === "single") {
    where.push("emc.market_count = 1");
  }

  let marketOrder = "";
  if (inputs.sort === "totalvol")
    marketOrder = `${marketVolumeDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "liquidity")
    marketOrder = `${marketLiquidityDisplayExpr} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "openinterest")
    marketOrder = `m.open_interest ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "change24h")
    marketOrder = `change_24h ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.sort === "time")
    marketOrder = `${buildFutureMarketEndSortSql(nowParam)} ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.filter === "newest")
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  else if (inputs.filter === "endingsoon")
    marketOrder = `${buildFutureEventEndSortSql("e", nowParam)} asc nulls last, m.venue_market_id`;
  else if (inputs.sort === "trending_v2") {
    const marketTrendExpr = `
      case
        when m.venue = 'limitless'
          then (coalesce(${marketLiquidityDisplayExpr}, 0) + 0.5 * coalesce(${marketVolumeDisplayExpr}, 0))
        else coalesce(trade_24h.volume_24h, 0)
      end
    `;
    marketOrder = `${marketTrendExpr} ${sortDir} nulls last, m.venue_market_id`;
  } else if (inputs.sort == null || inputs.sort === "trending") {
    const searchOrder = search.hasSearch
      ? `${search.joinedRankExpr} desc nulls last, `
      : "";
    marketOrder = `
      ${searchOrder}(coalesce(${marketVolumeDisplayExpr}, 0) * 0.4 +
       coalesce(${marketLiquidityDisplayExpr}, 0) * 0.3 +
       case when e.start_date >= (${nowParam}::timestamptz - interval '7 days') then 1000 else 0 end * 0.2 +
       case when e.end_date > ${nowParam}::timestamptz and e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id";

  const needsMarketCount =
    inputs.eventScope === "grouped" || inputs.eventScope === "single";
  const marketCountJoin = needsMarketCount
    ? "join market_count emc on emc.event_id = m.event_id"
    : "";
  const change24hCandidateJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const tradeJoin =
    inputs.sort === "trending_v2"
      ? `left join lateral (
          select t.volume_24h
          from unified_market_trade_24h t
          where t.market_id = m.id
          limit 1
        ) trade_24h on true`
      : "";
  const change24hCandidateExpr =
    inputs.sort === "change24h" ? "mc.change_24h" : "null";
  const marketOrderExpr = marketOrder || "m.venue_market_id";
  const limitParam = add(inputs.limit);
  const offsetParam = add(inputs.offset);

  const marketCandidatesSql = `
    select
      m.id,
      m.event_id
      ${inputs.sort === "change24h" ? `, (${change24hCandidateExpr}) as change_24h` : ""}
      , row_number() over (order by ${marketOrderExpr}) as ord
    from unified_markets m
    join unified_events e on e.id = m.event_id
    left join polymarket_markets pm_filter
      on pm_filter.id = m.venue_market_id and m.venue = 'polymarket'
    ${search.searchEventJoin}
    ${marketCountJoin}
    ${change24hCandidateJoin}
    ${tradeJoin}
    where ${where.join(" and ")}
  `;

  const withParts: string[] = [];
  if (search.searchCte) withParts.push(search.searchCte);
  if (needsMarketCount) withParts.push(marketCountCte);
  if (change24hCteParts.length) withParts.push(...change24hCteParts);
  withParts.push(`market_candidates as (${marketCandidatesSql})`);
  const withClause = `with ${withParts.join(",\n")}`;

  const sql = `
    ${withClause}
    select
      coalesce((select count(*) from market_candidates), 0)::int as total_markets,
      coalesce((select count(*) from (select distinct event_id from market_candidates) t), 0)::int as total_events,
      coalesce(
        (
          select array_agg(page.event_id order by page.first_ord)
          from (
            select event_id, min(ord) as first_ord
            from market_candidates
            group by event_id
            order by first_ord
            limit ${limitParam} offset ${offsetParam}
          ) page
        ),
        '{}'::text[]
      ) as event_ids
  `;

  const rows = await queryRowsWithSearchHint<{
    total_markets: number;
    total_events: number;
    event_ids: string[] | null;
  }>(
    pool,
    sql,
    params,
    search.hasSearch,
    search.hasSearch ? feedSearchWorkMem() : null,
    search.hasSearch ? feedSearchStatementTimeoutMs() : null,
  );
  const row = rows[0];
  if (!row) return { eventIds: [], totalEvents: 0, totalMarkets: 0 };

  return {
    eventIds: Array.isArray(row.event_ids) ? row.event_ids : [],
    totalEvents: Number(row.total_events ?? 0),
    totalMarkets: Number(row.total_markets ?? 0),
  };
}

export type MarketDetailsRow = {
  event_id: string;
  venue_event_id: string | null;
  event_title: string | null;
  event_description: string | null;
  event_category: string | null;
  event_duration_minutes: number | null;
  start_date: unknown;
  end_date: unknown;
  event_liquidity: unknown;
  event_volume: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_metadata: unknown;
  market_id: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_description: string | null;
  market_type: string | null;
  market_duration_minutes: number | null;
  market_status: string | null;
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  top_ts_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  top_ts_no: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
  condition_id: string | null;
  market_ledger: string | null;
  settlement_mint: string | null;
  is_initialized: boolean | null;
  redemption_status: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  pm_order_price_min_tick_size: unknown;
  pm_order_min_size: unknown;
  pm_accepting_orders: boolean | null;
  pm_neg_risk: boolean | null;
  pm_neg_risk_market_id: string | null;
  pm_neg_risk_parent_condition_id: string | null;
  pm_neg_risk_request_id: string | null;
  pm_question_id: string | null;
  pm_clob_token_ids: string | null;
  slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
};

export async function fetchMarketDetails(
  pool: Pool,
  marketId: string,
): Promise<MarketDetailsRow[]> {
  // Query for market details with event information
  const marketSql = `
    SELECT
      e.id as event_id,
      e.venue_event_id,
      e.title as event_title,
      e.description as event_description,
      e.category as event_category,
      e.duration_minutes as event_duration_minutes,
      e.start_date,
      e.end_date,
      e.liquidity as event_liquidity,
      e.volume_total as event_volume,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      e.metadata as event_metadata,
      m.id as market_id,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.description as market_description,
      m.market_type,
      m.duration_minutes as market_duration_minutes,
      m.status as market_status,
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      yes_top.ts as top_ts_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      no_top.ts as top_ts_no,
      m.last_price,
      m.outcomes,
      mt.token_yes,
      mt.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.market_ledger,
      m.settlement_mint,
      m.is_initialized,
      m.redemption_status,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      pm.order_price_min_tick_size as pm_order_price_min_tick_size,
      pm.order_min_size as pm_order_min_size,
      pm.accepting_orders as pm_accepting_orders,
      pm.neg_risk as pm_neg_risk,
      coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID') as pm_neg_risk_market_id,
      pm_parent.condition_id as pm_neg_risk_parent_condition_id,
      pm.neg_risk_request_id as pm_neg_risk_request_id,
      pm.question_id as pm_question_id,
      pm.clob_token_ids as pm_clob_token_ids,
      m.slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata as market_metadata,
      m.created_at,
      m.updated_at
    FROM unified_events e
    JOIN unified_markets m ON m.event_id = e.id
    cross join lateral (
      select
        ${canonicalMarketTokenIdSql("m", "YES")} as token_yes,
        ${canonicalMarketTokenIdSql("m", "NO")} as token_no
    ) mt
    left join lateral (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_yes
        and m.status = 'ACTIVE'
        and ts >= now() - interval '10 minutes'
      limit 1
    ) yes_top on true
    left join lateral (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_no
        and m.status = 'ACTIVE'
        and ts >= now() - interval '10 minutes'
      limit 1
    ) no_top on true
    LEFT JOIN polymarket_markets pm
      ON m.venue = 'polymarket' AND pm.id = m.venue_market_id
    LEFT JOIN polymarket_markets pm_parent
      ON pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')
    WHERE m.id = $1 OR m.venue_market_id = $1
  `;

  const { rows } = await pool.query<MarketDetailsRow>(marketSql, [marketId]);
  return rows;
}

export type EventDetailsRow = {
  event_id: string;
  event_venue: string | null;
  venue_event_id: string | null;
  event_title: string | null;
  event_description: string | null;
  event_category: string | null;
  event_status: string | null;
  event_duration_minutes: number | null;
  start_date: unknown;
  end_date: unknown;
  event_volume_total: unknown;
  event_volume_24h: unknown;
  event_liquidity: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_metadata: unknown;
  event_created_at: unknown;
  event_updated_at: unknown;
  market_id: string | null;
  market_venue: string | null;
  venue_market_id: string | null;
  market_title: string | null;
  market_description: string | null;
  market_type: string | null;
  market_duration_minutes: number | null;
  market_status: string | null;
  pm_accepting_orders: boolean | null;
  pm_neg_risk: boolean | null;
  pm_neg_risk_market_id: string | null;
  pm_neg_risk_parent_condition_id: string | null;
  pm_neg_risk_request_id: string | null;
  pm_question_id: string | null;
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  open_interest: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  top_ts_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  top_ts_no: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: unknown;
  token_no: unknown;
  clob_token_ids: unknown;
  condition_id: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  market_slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_metadata: unknown;
  market_created_at: unknown;
  market_updated_at: unknown;
};

export type MarketSignalPricingRow = {
  market_id: string;
  venue: string;
  market_status: string | null;
  pm_accepting_orders: boolean | null;
  close_time: unknown;
  expiration_time: unknown;
  event_end_time: unknown;
  best_bid: unknown;
  best_ask: unknown;
  token_yes: string | null;
  token_no: string | null;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  top_ts_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  top_ts_no: unknown;
  last_price: unknown;
  market_metadata: unknown;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
};

export async function fetchEventDetails(
  pool: Pool,
  eventId: string,
  selectedMarketId?: string | null,
): Promise<EventDetailsRow[]> {
  // Query for event details with all associated markets
  const supportedLimitlessMarketExpr = "true";
  const eventSql = `
    SELECT
      e.id as event_id,
      e.venue as event_venue,
      e.venue_event_id,
      e.title as event_title,
      e.description as event_description,
      e.category as event_category,
      e.status as event_status,
      e.duration_minutes as event_duration_minutes,
      e.start_date,
      e.end_date,
      e.volume_total as event_volume_total,
      e.volume_24h as event_volume_24h,
      e.liquidity as event_liquidity,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      e.metadata as event_metadata,
      e.created_at as event_created_at,
      e.updated_at as event_updated_at,
      m.id as market_id,
      m.venue as market_venue,
      m.venue_market_id,
      m.title as market_title,
      m.description as market_description,
      m.market_type,
      m.duration_minutes as market_duration_minutes,
      m.status as market_status,
      pm.accepting_orders as pm_accepting_orders,
      pm.neg_risk as pm_neg_risk,
      coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID') as pm_neg_risk_market_id,
      pm_parent.condition_id as pm_neg_risk_parent_condition_id,
      pm.neg_risk_request_id as pm_neg_risk_request_id,
      pm.question_id as pm_question_id,
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      yes_top.ts as top_ts_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      no_top.ts as top_ts_no,
      m.last_price,
      m.outcomes,
      mt.token_yes,
      mt.token_no,
      m.clob_token_ids,
      m.condition_id,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      m.slug as market_slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata as market_metadata,
      m.created_at as market_created_at,
      m.updated_at as market_updated_at
    FROM unified_events e
    LEFT JOIN unified_markets m ON m.event_id = e.id
      AND (
        e.status <> 'ACTIVE'
        OR m.status = 'ACTIVE'
        OR (
          $2::text is not null
          AND (
            m.id = $2::text
            OR m.slug = $2::text
            OR m.venue_market_id = $2::text
          )
        )
      )
      AND ${supportedLimitlessMarketExpr}
    LEFT JOIN LATERAL (
      select
        ${canonicalMarketTokenIdSql("m", "YES")} as token_yes,
        ${canonicalMarketTokenIdSql("m", "NO")} as token_no
    ) mt on true
    LEFT JOIN LATERAL (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_yes
      limit 1
    ) yes_top on true
    LEFT JOIN LATERAL (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_no
      limit 1
    ) no_top on true
    LEFT JOIN polymarket_markets pm
      ON m.venue = 'polymarket' AND pm.id = m.venue_market_id
    LEFT JOIN polymarket_markets pm_parent
      ON pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')
    WHERE e.id = $1 OR e.venue_event_id = $1
    ORDER BY m.volume_24h DESC NULLS LAST, m.liquidity DESC NULLS LAST, m.venue_market_id
  `;

  const { rows } = await pool.query<EventDetailsRow>(eventSql, [
    eventId,
    selectedMarketId?.trim() || null,
  ]);
  return rows;
}

export async function fetchMarketSignalPricingByIds(
  pool: Pool,
  marketIds: string[],
): Promise<MarketSignalPricingRow[]> {
  const uniqueIds = Array.from(
    new Set(marketIds.map((marketId) => marketId.trim()).filter(Boolean)),
  );
  if (uniqueIds.length === 0) return [];

  const sql = `
    SELECT
      m.id as market_id,
      m.venue,
      m.status as market_status,
      pm.accepting_orders as pm_accepting_orders,
      m.close_time,
      m.expiration_time,
      e.end_date as event_end_time,
      m.best_bid,
      m.best_ask,
      mt.token_yes,
      mt.token_no,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      yes_top.ts as top_ts_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      no_top.ts as top_ts_no,
      m.last_price,
      m.metadata as market_metadata,
      m.resolved_outcome,
      m.resolved_outcome_pct
    FROM unified_markets m
    LEFT JOIN LATERAL (
      select
        ${canonicalMarketTokenIdSql("m", "YES")} as token_yes,
        ${canonicalMarketTokenIdSql("m", "NO")} as token_no
    ) mt on true
    LEFT JOIN LATERAL (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_yes
      limit 1
    ) yes_top on true
    LEFT JOIN LATERAL (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_no
      limit 1
    ) no_top on true
    LEFT JOIN polymarket_markets pm
      ON m.venue = 'polymarket' AND pm.id = m.venue_market_id
    LEFT JOIN unified_events e
      ON e.id = m.event_id
    WHERE m.id = any($1::text[])
  `;

  const { rows } = await pool.query<MarketSignalPricingRow>(sql, [uniqueIds]);
  return rows;
}

export type MarketByTokenRow = {
  token_id: string;
  side: string | null;
  market_id: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_description: string | null;
  market_type: string | null;
  market_duration_minutes: number | null;
  market_status: string | null;
  pm_accepting_orders: boolean | null;
  pm_neg_risk: boolean | null;
  pm_neg_risk_market_id: string | null;
  pm_neg_risk_parent_condition_id: string | null;
  pm_neg_risk_request_id: string | null;
  pm_question_id: string | null;
  open_time: unknown;
  close_time: unknown;
  expiration_time: unknown;
  volume_24h: unknown;
  volume_total: unknown;
  open_interest: unknown;
  liquidity: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  top_ts_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  top_ts_no: unknown;
  last_price: unknown;
  outcomes: string | null;
  token_yes: string | null;
  token_no: string | null;
  clob_token_ids: string | null;
  condition_id: string | null;
  market_ledger: string | null;
  settlement_mint: string | null;
  is_initialized: boolean | null;
  redemption_status: string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
  slug: string | null;
  market_category: string | null;
  market_image: string | null;
  market_icon: string | null;
  market_metadata: unknown;
  created_at: unknown;
  updated_at: unknown;
  event_id: string | null;
  event_venue: string | null;
  venue_event_id: string | null;
  event_title: string | null;
  event_description: string | null;
  event_category: string | null;
  event_status: string | null;
  event_duration_minutes: number | null;
  start_date: unknown;
  end_date: unknown;
  event_volume_total: unknown;
  event_volume_24h: unknown;
  event_liquidity: unknown;
  event_open_interest: unknown;
  event_slug: string | null;
  event_image: string | null;
  event_icon: string | null;
  event_metadata: unknown;
};

export async function fetchMarketsByTokenIds(
  pool: Pool,
  inputs: { tokenIds: string[]; venue?: string; includeTop?: boolean },
): Promise<MarketByTokenRow[]> {
  if (inputs.tokenIds.length === 0) return [];

  const params: PgParams = [inputs.tokenIds];
  const rawLimitlessLookupSql =
    inputs.venue === "limitless"
      ? `
        union all
        select
          t.token_id,
          'limitless:' || t.token_id as lookup_token_id,
          t.ordinality,
          1 as lookup_rank
        from input_tokens t
        where t.token_id not like '%:%'
      `
      : "";
  let venueClause = "";
  if (inputs.venue) {
    params.push(inputs.venue);
    venueClause = `and m.venue = $${params.length}`;
  }
  const venueRankSql = (alias: string) =>
    inputs.venue ? `case when ${alias}.venue = $2 then 0 else 1 end` : "0";

  const includeTop = inputs.includeTop ?? true;
  const topSelect = includeTop
    ? `yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      yes_top.ts as top_ts_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      no_top.ts as top_ts_no,`
    : `null::numeric as best_bid_yes,
      null::numeric as best_ask_yes,
      null::timestamptz as top_ts_yes,
      null::numeric as best_bid_no,
      null::numeric as best_ask_no,
      null::timestamptz as top_ts_no,`;
  const topJoins = includeTop
    ? `left join lateral (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = token_yes.token_id
        and ts >= now() - interval '10 minutes'
      limit 1
    ) yes_top on true
    left join lateral (
      select ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = token_no.token_id
        and ts >= now() - interval '10 minutes'
      limit 1
    ) no_top on true`
    : "";

  const negRiskParentSelect = `pm_parent.condition_id as pm_neg_risk_parent_condition_id,`;
  const negRiskParentJoin = `left join polymarket_markets pm_parent
      on pm_parent.question_id = coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID')`;

  const sql = `
    with input_tokens as (
      select token_id, min(ordinality) as ordinality
      from unnest($1::text[]) with ordinality as t(token_id, ordinality)
      where token_id is not null and token_id <> ''
      group by token_id
    ),
    lookup_tokens as (
      select
        t.token_id,
        t.token_id as lookup_token_id,
        t.ordinality,
        0 as lookup_rank
      from input_tokens t

      union all

      select
        t.token_id,
        substring(t.token_id from 11) as lookup_token_id,
        t.ordinality,
        1 as lookup_rank
      from input_tokens t
      where t.token_id like 'limitless:%'

      ${rawLimitlessLookupSql}
    ),
    token_matches as (
      select
        lt.token_id,
        upper(umt.outcome_side) as side,
        umt.market_id,
        lt.ordinality,
        lt.lookup_rank,
        ${venueRankSql("umt")} as venue_rank,
        umt.updated_at,
        0 as source_rank
      from lookup_tokens lt
      join unified_market_tokens umt
        on umt.token_id = lt.lookup_token_id
      where umt.outcome_side is not null

      union all

      select
        lt.token_id,
        upper(ut.side) as side,
        ut.market_id,
        lt.ordinality,
        lt.lookup_rank,
        ${venueRankSql("ut")} as venue_rank,
        ut.updated_at,
        1 as source_rank
      from lookup_tokens lt
      join unified_tokens ut
        on ut.token_id = lt.lookup_token_id
      where ut.side is not null

      union all

      select
        lt.token_id,
        'YES' as side,
        m_yes.id as market_id,
        lt.ordinality,
        lt.lookup_rank,
        ${venueRankSql("m_yes")} as venue_rank,
        m_yes.updated_at,
        2 as source_rank
      from lookup_tokens lt
      join unified_markets m_yes
        on m_yes.token_yes = lt.lookup_token_id

      union all

      select
        lt.token_id,
        'NO' as side,
        m_no.id as market_id,
        lt.ordinality,
        lt.lookup_rank,
        ${venueRankSql("m_no")} as venue_rank,
        m_no.updated_at,
        2 as source_rank
      from lookup_tokens lt
      join unified_markets m_no
        on m_no.token_no = lt.lookup_token_id
    ),
    ranked_token_matches as (
      select *
      from (
        select
          token_matches.*,
          row_number() over (
            partition by token_matches.token_id
            order by
              token_matches.lookup_rank asc,
              token_matches.venue_rank asc,
              token_matches.updated_at desc nulls last,
              token_matches.source_rank asc,
              token_matches.market_id asc
          ) as match_rank
        from token_matches
        where token_matches.side in ('YES', 'NO')
      ) ranked
      where ranked.match_rank = 1
    )
    select
      tm.token_id,
      tm.side,
      m.id as market_id,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.description as market_description,
      m.market_type,
      m.duration_minutes as market_duration_minutes,
      m.status as market_status,
      pm.accepting_orders as pm_accepting_orders,
      pm.neg_risk as pm_neg_risk,
      coalesce(pm.neg_risk_market_id, pm.raw->>'negRiskMarketID') as pm_neg_risk_market_id,
      ${negRiskParentSelect}
      pm.neg_risk_request_id as pm_neg_risk_request_id,
      pm.question_id as pm_question_id,
      m.open_time,
      m.close_time,
      m.expiration_time,
      m.volume_24h,
      m.volume_total,
      m.open_interest,
      m.liquidity,
      m.best_bid,
      m.best_ask,
      ${topSelect}
      m.last_price,
      m.outcomes,
      token_yes.token_id as token_yes,
      token_no.token_id as token_no,
      m.clob_token_ids,
      coalesce(m.condition_id, pm.condition_id) as condition_id,
      m.market_ledger,
      m.settlement_mint,
      m.is_initialized,
      m.redemption_status,
      m.resolved_outcome,
      m.resolved_outcome_pct,
      m.slug,
      m.category as market_category,
      m.image as market_image,
      m.icon as market_icon,
      m.metadata as market_metadata,
      m.created_at,
      m.updated_at,
      e.id as event_id,
      e.venue as event_venue,
      e.venue_event_id,
      e.title as event_title,
      e.description as event_description,
      e.category as event_category,
      e.status as event_status,
      e.duration_minutes as event_duration_minutes,
      e.start_date,
      e.end_date,
      e.volume_total as event_volume_total,
      e.volume_24h as event_volume_24h,
      e.liquidity as event_liquidity,
      e.open_interest as event_open_interest,
      e.slug as event_slug,
      e.image as event_image,
      e.icon as event_icon,
      e.metadata as event_metadata
    from ranked_token_matches tm
    join unified_markets m on m.id = tm.market_id
    left join lateral (
      select umt.token_id
      from unified_market_tokens umt
      where umt.market_id = m.id
        and umt.outcome_side = 'YES'
      order by umt.updated_at desc nulls last, umt.token_id asc
      limit 1
    ) token_yes on true
    left join lateral (
      select umt.token_id
      from unified_market_tokens umt
      where umt.market_id = m.id
        and umt.outcome_side = 'NO'
      order by umt.updated_at desc nulls last, umt.token_id asc
      limit 1
    ) token_no on true
    ${topJoins}
    left join polymarket_markets pm
      on pm.id = m.venue_market_id and m.venue = 'polymarket'
    ${negRiskParentJoin}
    left join unified_events e on e.id = m.event_id
    where true
    ${venueClause}
    order by tm.ordinality
  `;

  const { rows } = await pool.query<MarketByTokenRow>(sql, params);
  return rows;
}
