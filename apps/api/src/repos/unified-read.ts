import type { Pool } from "@hunch/infra";
import type { QueryResultRow } from "pg";
import { env } from "../env.js";
import { buildRenderableMarketSql } from "../lib/market-renderability.js";
import type { PgParams } from "../server-types.js";

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
const FEED_SEARCH_PREFIX_MIN_CHARS = 3;
const FEED_SEARCH_PREFIX_MAX_CHARS = 6;

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

type FeedSearchPlan = {
  hasSearch: boolean;
  rankMode: FeedSearchMode;
  searchText: string;
  prefixQueryText: string | null;
};

type FeedEventFilterInputs = Pick<
  FeedInputs,
  | "venues"
  | "category"
  | "categories"
  | "filter"
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
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
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

function buildFeedSearchDocumentExpr(alias: string): string {
  return `
    setweight(to_tsvector('english', coalesce(${alias}.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.slug, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(${alias}.category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(${alias}.description, '')), 'D')
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
  const prefixTerm =
    prefixTerms.length === 1 &&
    shouldUseFeedSearchPrefix(searchText, prefixTerms[0])
      ? prefixTerms[0]
      : null;
  return {
    hasSearch: searchText.length > 0,
    rankMode: rawTerms.length >= 2 ? "ranked" : "membership",
    searchText,
    prefixQueryText: prefixTerm ? `${prefixTerm}:*` : null,
  };
}

function buildFeedSearchMatchesSql(args: {
  mode: FeedSearchMode;
  matchLimit?: number | null;
  nowParam: string;
  nowCloseParam: string;
  eventSearchDocExpr: string;
  marketSearchDocExpr: string;
  renderableMarketExpr: string;
}): string {
  const {
    mode,
    matchLimit = null,
    nowParam,
    nowCloseParam,
    eventSearchDocExpr,
    marketSearchDocExpr,
    renderableMarketExpr,
  } = args;
  const needsScore = mode === "ranked" || matchLimit != null;
  const selectColumns = needsScore ? "id, max(rank) as rank" : "distinct id";
  const marketRankFactor = mode === "ranked" ? " * 2" : "";
  const eventRankFactor = mode === "ranked" ? " * 2" : "";
  const eventMembershipScore =
    "coalesce(e.volume_total, e.open_interest, e.liquidity, 0)";
  const marketMembershipScore =
    "coalesce(m.volume_total, m.open_interest, m.liquidity, 0)";
  const aggregateClause = needsScore
    ? `
      group by id
      order by rank desc nulls last, id
      ${matchLimit != null ? `limit ${matchLimit}` : ""}
    `
    : "";

  return `
    select
      ${selectColumns}
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
        and e.status = 'ACTIVE'
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
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
        and e.status = 'ACTIVE'
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
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
      cross join search_query sq
      where querytree(sq.query) <> ''
        and m.status = 'ACTIVE'
        and e.status = 'ACTIVE'
        and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
        and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
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
      cross join search_query sq
      where sq.prefix_query is not null
        and querytree(sq.prefix_query) <> ''
        and m.status = 'ACTIVE'
        and e.status = 'ACTIVE'
        and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
        and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
        and ${renderableMarketExpr}
        and (${marketSearchDocExpr}) @@ sq.prefix_query
    ) matches
    ${aggregateClause}
  `;
}

function buildFeedSearchContext(args: {
  add: PgParamAdder;
  q?: string;
  nowParam: string;
  nowCloseParam?: string;
  renderableMarketExpr: string;
  mode?: FeedSearchMode;
  matchLimit?: number | null;
}): FeedSearchContext {
  const {
    add,
    q,
    nowParam,
    nowCloseParam = nowParam,
    renderableMarketExpr,
    mode = "ranked",
    matchLimit = null,
  } = args;
  const plan = buildFeedSearchPlan(q);
  const searchParam = plan.hasSearch ? add(plan.searchText) : null;
  const prefixParam = plan.hasSearch ? add(plan.prefixQueryText) : null;
  const eventSearchDocExpr = buildFeedSearchDocumentExpr("e");
  const marketSearchDocExpr = buildFeedSearchDocumentExpr("m");
  const effectiveMode = mode === "ranked" ? plan.rankMode : mode;
  const searchMatchesSql = plan.hasSearch
    ? buildFeedSearchMatchesSql({
        mode: effectiveMode,
        matchLimit,
        nowParam,
        nowCloseParam,
        eventSearchDocExpr,
        marketSearchDocExpr,
        renderableMarketExpr,
      })
    : "";
  const searchCte = plan.hasSearch
    ? `
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
      ),
      search_events as materialized (
        ${searchMatchesSql}
      )
    `
    : "";

  return {
    hasSearch: plan.hasSearch,
    searchCte,
    searchEventJoin: plan.hasSearch
      ? "cross join search_query sq left join search_events se on se.id = e.id"
      : "",
    searchMarketJoin: plan.hasSearch
      ? "cross join search_query sq left join search_events se on se.id = m.event_id"
      : "",
    searchFilterExpr: plan.hasSearch
      ? "(not sq.applies or se.id is not null)"
      : "true",
    joinedRankExpr:
      plan.hasSearch && effectiveMode === "ranked"
        ? "case when sq.applies then coalesce(se.rank, 0) else 0 end"
        : "0::double precision",
  };
}

function buildFeedEventWhere(args: {
  add: PgParamAdder;
  inputs: FeedEventFilterInputs;
  nowParam: string;
  hasSearch: boolean;
  requireNamedCategory?: boolean;
  includeSearchCondition?: boolean;
  searchFilterExpr?: string;
}): string[] {
  const {
    add,
    inputs,
    nowParam,
    hasSearch,
    requireNamedCategory = false,
    includeSearchCondition = true,
    searchFilterExpr = "e.id in (select id from search_events)",
  } = args;
  const where: string[] = [
    "e.status = 'ACTIVE'",
    `(e.end_date is null or e.end_date > ${nowParam}::timestamptz)`,
  ];

  if (requireNamedCategory) {
    where.push("e.category is not null", "btrim(e.category) <> ''");
  }
  if (inputs.venues?.length) {
    where.push(`e.venue = ANY(${add(inputs.venues)}::text[])`);
  }
  if (inputs.categories?.length) {
    where.push(`lower(e.category) = ANY(${add(inputs.categories)}::text[])`);
  } else if (inputs.category) {
    where.push(`lower(e.category) = ${add(inputs.category.toLowerCase())}`);
  }
  if (hasSearch && includeSearchCondition) {
    where.push(searchFilterExpr);
  }
  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    where.push(`e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`);
  }
  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
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
    nowCloseParam,
    renderableMarketExpr,
    mode: searchMode,
    matchLimit: searchMatchLimit,
  });
  const needsMarketCount =
    inputs.eventScope === "grouped" || inputs.eventScope === "single";
  const marketCountCte = `
    market_count as (
      select m.event_id, count(*) as market_count
      from unified_markets m
      join unified_events e on e.id = m.event_id
      ${search.searchMarketJoin}
      where m.status = 'ACTIVE'
        ${marketIdsParam ? `and m.id = ANY(${marketIdsParam}::text[])` : ""}
        ${search.hasSearch ? `and ${search.searchFilterExpr}` : ""}
        and e.status = 'ACTIVE'
        and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
        and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
        and ${supportedLimitlessMarketExpr}
        and ${renderableMarketExpr}
      group by m.event_id
    )
  `;
  const where: string[] = [
    "m.status = 'ACTIVE'",
    "e.status = 'ACTIVE'",
    `(m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)`,
    `(m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)`,
    `(e.end_date is null or e.end_date > ${nowParam}::timestamptz)`,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
  ];

  if (requireNamedCategory) {
    where.push("e.category is not null", "btrim(e.category) <> ''");
  }
  if (search.hasSearch) {
    where.push(search.searchFilterExpr);
  }
  if (marketIdsParam) {
    where.push(`m.id = ANY(${marketIdsParam}::text[])`);
  }
  if (inputs.venues?.length) {
    where.push(`m.venue = ANY(${add(inputs.venues)}::text[])`);
  }
  if (inputs.categories?.length) {
    where.push(`lower(e.category) = ANY(${add(inputs.categories)}::text[])`);
  } else if (inputs.category) {
    where.push(`lower(e.category) = ${add(inputs.category.toLowerCase())}`);
  }
  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    where.push(`e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`);
  }
  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
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

  return {
    marketIdsParam,
    needsMarketCount,
    marketCountCte,
    where,
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
  inputs: Pick<FeedInputs, "category" | "categories" | "venues" | "marketIds">,
): number | null {
  if (
    inputs.category ||
    inputs.categories?.length ||
    inputs.venues?.length ||
    inputs.marketIds?.length
  ) {
    return null;
  }
  return feedSearchResultMatchLimit();
}

async function queryRowsWithLocalSettings<T extends QueryResultRow>(
  pool: Pool,
  sql: string,
  params: PgParams,
  options?: {
    useSearchHint?: boolean;
    workMem?: string | null;
    statementTimeoutMs?: number | null;
  },
): Promise<T[]> {
  const useSearchHint = options?.useSearchHint ?? false;
  const workMem = options?.workMem ?? null;
  const statementTimeoutMs = options?.statementTimeoutMs ?? null;
  if (!useSearchHint && !workMem && !statementTimeoutMs) {
    const { rows } = await pool.query<T>(sql, params);
    return rows;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (useSearchHint) {
      await client.query("SET LOCAL enable_seqscan = off");
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
): Promise<T[]> {
  return queryRowsWithLocalSettings<T>(pool, sql, params, {
    useSearchHint,
    workMem,
    statementTimeoutMs,
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
          b.best_bid,
          b.best_ask
        from unified_token_top_latest b
        join token_set ts on ts.token_id = b.token_id
        where b.ts > (${args.nowParam}::timestamptz - interval '7 days')
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
    });

    const withParts: string[] = [];
    if (marketContext.searchCte) withParts.push(marketContext.searchCte);
    if (marketContext.needsMarketCount)
      withParts.push(marketContext.marketCountCte);
    const withClause = withParts.length ? `with ${withParts.join(",\n")}` : "";
    const marketCountJoin = marketContext.needsMarketCount
      ? "join market_count emc on emc.event_id = m.event_id"
      : "";

    const sql = `
      ${withClause}
      select
        m.venue as venue,
        lower(e.category) as category,
        count(distinct m.event_id)::int as events
      from unified_markets m
      join unified_events e on e.id = m.event_id
      ${marketContext.searchEventJoin}
      ${marketCountJoin}
      where ${marketContext.where.join(" and ")}
      group by m.venue, lower(e.category)
    `;

    return await queryRowsWithSearchHint<FeedCategoryFacetRow>(
      pool,
      sql,
      params,
      marketContext.hasSearch,
      marketContext.hasSearch ? feedSearchWorkMem() : null,
      marketContext.hasSearch ? feedSearchStatementTimeoutMs() : null,
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
  });
  const eventWhere = buildFeedEventWhere({
    add,
    inputs,
    nowParam,
    hasSearch: search.hasSearch,
    requireNamedCategory: true,
    searchFilterExpr: search.searchFilterExpr,
  });
  const requiresMarketJoin = requiresFeedEventMarketJoin(inputs);

  if (!requiresMarketJoin) {
    const eventOnlyWhere = [...eventWhere];
    eventOnlyWhere.push(
      `exists (
        select 1
        from unified_markets m
        where m.event_id = e.id
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and ${supportedLimitlessMarketExpr}
          and ${renderableMarketExpr}
      )`,
    );
    if (inputs.minVol > 1e-9) {
      eventOnlyWhere.push(`${eventVolumeDisplayExpr} >= ${add(inputs.minVol)}`);
    }
    if (inputs.minLiquidity > 0) {
      eventOnlyWhere.push(
        `${eventLiquidityDisplayExpr} >= ${add(inputs.minLiquidity)}`,
      );
    }

    const sql = `
      ${search.searchCte ? `with ${search.searchCte}` : ""}
      select
        e.venue as venue,
        lower(e.category) as category,
        count(*)::int as events
      from unified_events e
      ${search.searchEventJoin}
      where ${eventOnlyWhere.join(" and ")}
      group by e.venue, lower(e.category)
    `;

    return await queryRowsWithSearchHint<FeedCategoryFacetRow>(
      pool,
      sql,
      params,
      search.hasSearch,
      search.hasSearch ? feedSearchWorkMem() : null,
      search.hasSearch ? feedSearchStatementTimeoutMs() : null,
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
  withParts.push(`
    filtered_events as (
      select
        e.id,
        e.venue,
        lower(e.category) as category
      from unified_events e
      ${search.searchEventJoin}
      join unified_markets m on m.event_id = e.id
        and m.status = 'ACTIVE'
        and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
        and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
        and ${supportedLimitlessMarketExpr}
        and ${renderableMarketExpr}
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
    search.hasSearch ? feedSearchWorkMem() : null,
    search.hasSearch ? feedSearchStatementTimeoutMs() : null,
  );
}

export async function fetchFeedEventIds(
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
  });
  const eventWhere = buildFeedEventWhere({
    add,
    inputs,
    nowParam,
    hasSearch: search.hasSearch,
    searchFilterExpr: search.searchFilterExpr,
  });
  const filterRequiresMarketJoin = requiresFeedEventMarketJoin(inputs);
  const requiresMarketJoin =
    filterRequiresMarketJoin || inputs.sort === "trending_v2";

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
    );
  }

  if (!requiresMarketJoin) {
    const eventOnlyWhere = [...eventWhere];
    eventOnlyWhere.push(
      `exists (
        select 1
        from unified_markets m
        where m.event_id = e.id
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
          and ${supportedLimitlessMarketExpr}
          and ${renderableMarketExpr}
      )`,
    );
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
      eventOnlyOrder = `e.end_date ${sortDir} nulls last, e.id`;
    else if (inputs.filter === "newest")
      eventOnlyOrder = "e.start_date desc nulls last, e.id";
    else if (inputs.filter === "endingsoon")
      eventOnlyOrder = "e.end_date asc nulls last, e.id";
    else if (inputs.sort == null || inputs.sort === "trending") {
      const sevenDaysAgo = add(inputs.sevenDaysAgo);
      const sevenDaysFromNow = add(inputs.sevenDaysFromNow);
      eventOnlyOrder = `
        ${eventOnlySearchOrder}(coalesce(${eventVolumeDisplayExpr}, 0) * 0.4 +
         coalesce(${eventLiquidityDisplayExpr}, 0) * 0.3 +
         case when e.start_date >= ${sevenDaysAgo}::timestamptz then 1000 else 0 end * 0.2 +
         case when e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
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
      search.hasSearch ? feedSearchWorkMem() : null,
      search.hasSearch ? feedSearchStatementTimeoutMs() : null,
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
    eventOrder = `e.end_date ${sortDir} nulls last, e.id`;
  else if (inputs.filter === "newest")
    eventOrder = "e.start_date desc nulls last, e.id";
  else if (inputs.filter === "endingsoon")
    eventOrder = "e.end_date asc nulls last, e.id";
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
       case when e.end_date <= ${sevenDaysFromNow}::timestamptz then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, e.id
    `;
  } else eventOrder = "e.start_date desc nulls last, e.id";

  const withParts: string[] = [];
  if (search.searchCte) withParts.push(search.searchCte);
  const withClause = withParts.length ? `with ${withParts.join(",\n")}` : "";

  const eventSql = `
    ${withClause}
    select
      e.id
    from unified_events e
    ${search.searchEventJoin}
    join unified_markets m on m.event_id = e.id
      and m.status = 'ACTIVE'
      and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
      and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
      and ${supportedLimitlessMarketExpr}
      and ${renderableMarketExpr}
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
    search.hasSearch
      ? feedSearchWorkMem()
      : inputs.sort === "change24h"
        ? FEED_HEAVY_QUERY_WORK_MEM
        : null,
    search.hasSearch ? feedSearchStatementTimeoutMs() : null,
  );
}

export type FeedMarketRow = {
  event_id: string;
  event_title: string | null;
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
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
    end
  `;
  const marketWhere: string[] = [
    // Only show ACTIVE markets - exclude CLOSED, SETTLED, and ARCHIVED
    "m.status = 'ACTIVE'",
    `m.event_id = ANY(${eventIdsParam}::text[])`,
    // Critical: Exclude expired or closed markets based on time
    // This ensures we don't show expired/closed markets even if status hasn't been updated yet
    // Use parameterized dates for index usage
    `(m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)`,
    `(m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)`,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
  ];
  if (marketIdsParam) {
    marketWhere.push(`m.id = ANY(${marketIdsParam}::text[])`);
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

  const marketOrder = "eo.ord, m.market_rank, m.venue_market_id";

  const marketRankExpr = `
    row_number() over (
      partition by m.event_id
      order by
        coalesce(${marketVolumeDisplayExpr}, 0) desc nulls last,
        coalesce(${marketLiquidityDisplayExpr}, 0) desc nulls last,
        m.venue_market_id
    ) as market_rank
  `;
  const rankedMarketSql = `
    select
      m.*,
      ${marketRankExpr}
    from unified_markets m
    where ${marketWhere.join(" and ")}
  `;

  const marketBaseSql = `
    select
      m.*,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>0)
        else m.token_yes
      end as resolved_token_yes,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>1)
        else m.token_no
      end as resolved_token_no
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
        left join unified_market_change_24h mc on mc.market_id = m.id
        where m.event_id = ANY(${eventIdsParam}::text[])
          ${marketIdsParam ? `and m.id = ANY(${marketIdsParam}::text[])` : ""}
          and m.status = 'ACTIVE'
          and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
          and (m.close_time is null or m.close_time > ${nowParam}::timestamptz)
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
  withParts.push(`event_order as (${eventOrderSql})`);
  withParts.push(`market_base as (${marketBaseSql})`);
  withParts.push(...bookSnapshot.ctes);
  const withClause = `with ${withParts.join(",\n")}`;
  const marketSql = `
    ${withClause}
    select
      e.id as event_id,
      e.title as event_title,
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
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
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
      workMem:
        inputs.sort === "change24h" ||
        inputs.sort === "trending" ||
        inputs.sort === "trending_v2"
          ? FEED_HEAVY_QUERY_WORK_MEM
          : null,
    },
  );
}

export async function fetchFeedMarketsDirect(
  pool: Pool,
  inputs: FeedInputs,
): Promise<FeedMarketRow[]> {
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
  });
  const change24hCteParts: string[] = [];
  if (inputs.sort === "change24h") {
    change24hCteParts.push(`
      market_change as (
        select
          market_id,
          change_24h
        from unified_market_change_24h
      )
    `);
  }
  const where = marketContext.where;

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
    marketOrder = `coalesce(m.close_time, m.expiration_time, e.end_date) ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.filter === "newest")
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  else if (inputs.filter === "endingsoon")
    marketOrder = "e.end_date asc nulls last, m.venue_market_id";
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
    const searchOrder = marketContext.hasSearch
      ? `${marketContext.joinedRankExpr} desc nulls last, `
      : "";
    marketOrder = `
      ${searchOrder}(coalesce(${marketVolumeDisplayExpr}, 0) * 0.4 +
       coalesce(${marketLiquidityDisplayExpr}, 0) * 0.3 +
       case when e.start_date >= (${nowParam}::timestamptz - interval '7 days') then 1000 else 0 end * 0.2 +
       case when e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
      ) ${sortDir} nulls last, m.venue_market_id
    `;
  } else marketOrder = "e.start_date desc nulls last, m.venue_market_id";

  const limitParam = add(inputs.limit);
  const offsetParam = add(inputs.offset);
  const marketCountJoin = marketContext.needsMarketCount
    ? "join market_count emc on emc.event_id = m.event_id"
    : "";
  const change24hCandidateJoin =
    inputs.sort === "change24h"
      ? "left join market_change mc on mc.market_id = m.id"
      : "";
  const tradeJoin =
    inputs.sort === "trending_v2"
      ? "left join unified_market_trade_24h trade_24h on trade_24h.market_id = m.id"
      : "";
  const change24hCandidateExpr =
    inputs.sort === "change24h" ? "mc.change_24h" : "null";

  const marketCandidatesInnerSql = `
    select
      m.id,
      m.event_id
      ${inputs.sort === "change24h" ? `, (${change24hCandidateExpr}) as change_24h` : ""}
    from unified_markets m
    join unified_events e on e.id = m.event_id
    ${marketContext.searchEventJoin}
    ${marketCountJoin}
    ${change24hCandidateJoin}
    ${tradeJoin}
    where ${where.join(" and ")}
    ${marketOrder ? `order by ${marketOrder}` : ""}
    limit ${limitParam} offset ${offsetParam}
  `;
  const marketCandidatesSql = `
    select
      page.*,
      row_number() over () as ord
    from (${marketCandidatesInnerSql}) page
  `;

  const marketBaseSql = `
    select
      m.*,
      mc.ord as ord
      ${inputs.sort === "change24h" ? ", mc.change_24h as change_24h" : ""}
      , case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>0)
        else m.token_yes
      end as resolved_token_yes,
      case
        when m.venue = 'polymarket' and m.clob_token_ids is not null
          then (m.clob_token_ids::jsonb->>1)
        else m.token_no
      end as resolved_token_no
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
  if (marketContext.searchCte) withParts.push(marketContext.searchCte);
  if (marketContext.needsMarketCount) {
    withParts.push(marketContext.marketCountCte);
  }
  if (change24hCteParts.length) withParts.push(...change24hCteParts);
  withParts.push(`market_candidates as (${marketCandidatesSql})`);
  withParts.push(`market_base as (${marketBaseSql})`);
  withParts.push(...bookSnapshot.ctes);
  const withClause = `with ${withParts.join(",\n")}`;

  const marketSql = `
    ${withClause}
    select
      e.id as event_id,
      e.title as event_title,
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
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
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
    ${marketChangeJoin}
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
        : inputs.sort === "change24h" ||
            inputs.sort === "trending" ||
            inputs.sort === "trending_v2"
          ? FEED_HEAVY_QUERY_WORK_MEM
          : null,
      statementTimeoutMs: marketContext.hasSearch
        ? feedSearchStatementTimeoutMs()
        : null,
    },
  );
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
    nowCloseParam,
    renderableMarketExpr,
  });
  const marketCountCte = `
    market_count as (
      select m.event_id, count(*) as market_count
      from unified_markets m
      join unified_events e on e.id = m.event_id
      ${search.searchMarketJoin}
      where m.status = 'ACTIVE'
        and m.id = ANY(${marketIdsParam}::text[])
        ${search.hasSearch ? `and ${search.searchFilterExpr}` : ""}
        and e.status = 'ACTIVE'
        and (m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)
        and (m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)
        and (e.end_date is null or e.end_date > ${nowParam}::timestamptz)
        and ${supportedLimitlessMarketExpr}
        and ${renderableMarketExpr}
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
      when m.best_bid is not null and m.best_ask is not null then (m.best_bid + m.best_ask) / 2
      else coalesce(m.best_bid, m.best_ask)
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
    "m.status = 'ACTIVE'",
    "e.status = 'ACTIVE'",
    `m.id = ANY(${marketIdsParam}::text[])`,
    `(m.expiration_time is null or m.expiration_time > ${nowParam}::timestamptz)`,
    `(m.close_time is null or m.close_time > ${nowCloseParam}::timestamptz)`,
    `(e.end_date is null or e.end_date > ${nowParam}::timestamptz)`,
    supportedLimitlessMarketExpr,
    renderableMarketExpr,
  ];
  if (search.hasSearch) {
    where.push(search.searchFilterExpr);
  }

  if (inputs.venues?.length) {
    where.push(`m.venue = ANY(${add(inputs.venues)}::text[])`);
  }
  if (inputs.categories?.length) {
    where.push(`lower(e.category) = ANY(${add(inputs.categories)}::text[])`);
  } else if (inputs.category) {
    where.push(`lower(e.category) = ${add(inputs.category.toLowerCase())}`);
  }
  if (inputs.filter === "newest") {
    where.push(`e.start_date >= ${add(inputs.sevenDaysAgo)}::timestamptz`);
  } else if (inputs.filter === "endingsoon") {
    where.push(`e.end_date <= ${add(inputs.sevenDaysFromNow)}::timestamptz`);
  }
  if (inputs.endWithin) {
    where.push(
      `e.end_date is not null and e.end_date <= ${add(inputs.endWithin)}::timestamptz`,
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
    marketOrder = `coalesce(m.close_time, m.expiration_time, e.end_date) ${sortDir} nulls last, m.venue_market_id`;
  else if (inputs.filter === "newest")
    marketOrder = "e.start_date desc nulls last, m.venue_market_id";
  else if (inputs.filter === "endingsoon")
    marketOrder = "e.end_date asc nulls last, m.venue_market_id";
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
       case when e.end_date <= (${nowParam}::timestamptz + interval '7 days') then 500 else 0 end * 0.1
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
  event_title: string | null;
  event_description: string | null;
  event_category: string | null;
  start_date: unknown;
  end_date: unknown;
  event_liquidity: unknown;
  event_volume: unknown;
  event_image: string | null;
  event_icon: string | null;
  event_metadata: unknown;
  market_id: string;
  venue: string;
  venue_market_id: string;
  market_title: string | null;
  market_description: string | null;
  market_type: string | null;
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
  best_bid_no: unknown;
  best_ask_no: unknown;
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
      e.title as event_title,
      e.description as event_description,
      e.category as event_category,
      e.start_date,
      e.end_date,
      e.liquidity as event_liquidity,
      e.volume_total as event_volume,
      e.image as event_image,
      e.icon as event_icon,
      e.metadata as event_metadata,
      m.id as market_id,
      m.venue,
      m.venue_market_id,
      m.title as market_title,
      m.description as market_description,
      m.market_type,
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
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
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
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>0)
          else m.token_yes
        end as token_yes,
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>1)
          else m.token_no
        end as token_no
    ) mt
    left join lateral (
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_yes
        and m.status = 'ACTIVE'
        and ts > now() - interval '7 days'
      limit 1
    ) yes_top on true
    left join lateral (
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_no
        and m.status = 'ACTIVE'
        and ts > now() - interval '7 days'
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
  best_bid_no: unknown;
  best_ask_no: unknown;
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
  market_status: string | null;
  pm_accepting_orders: boolean | null;
  close_time: unknown;
  expiration_time: unknown;
  best_bid: unknown;
  best_ask: unknown;
  best_bid_yes: unknown;
  best_ask_yes: unknown;
  best_bid_no: unknown;
  best_ask_no: unknown;
  last_price: unknown;
  resolved_outcome: string | null;
  resolved_outcome_pct: unknown;
};

export async function fetchEventDetails(
  pool: Pool,
  eventId: string,
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
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
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
      AND (e.status <> 'ACTIVE' OR m.status = 'ACTIVE')
      AND ${supportedLimitlessMarketExpr}
    LEFT JOIN LATERAL (
      select
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>0)
          else m.token_yes
        end as token_yes,
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>1)
          else m.token_no
        end as token_no
    ) mt on true
    LEFT JOIN LATERAL (
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_yes
      limit 1
    ) yes_top on true
    LEFT JOIN LATERAL (
      select best_bid, best_ask
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

  const { rows } = await pool.query<EventDetailsRow>(eventSql, [eventId]);
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
      m.status as market_status,
      pm.accepting_orders as pm_accepting_orders,
      m.close_time,
      m.expiration_time,
      m.best_bid,
      m.best_ask,
      yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,
      m.last_price,
      m.resolved_outcome,
      m.resolved_outcome_pct
    FROM unified_markets m
    LEFT JOIN LATERAL (
      select
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>0)
          else m.token_yes
        end as token_yes,
        case
          when m.venue = 'polymarket' and m.clob_token_ids is not null
            then (m.clob_token_ids::jsonb->>1)
          else m.token_no
        end as token_no
    ) mt on true
    LEFT JOIN LATERAL (
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_yes
      limit 1
    ) yes_top on true
    LEFT JOIN LATERAL (
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = mt.token_no
      limit 1
    ) no_top on true
    LEFT JOIN polymarket_markets pm
      ON m.venue = 'polymarket' AND pm.id = m.venue_market_id
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
  best_bid_no: unknown;
  best_ask_no: unknown;
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
  let venueClause = "";
  if (inputs.venue) {
    params.push(inputs.venue);
    venueClause = `and m.venue = $${params.length}`;
  }

  const includeTop = inputs.includeTop ?? true;
  const topSelect = includeTop
    ? `yes_top.best_bid as best_bid_yes,
      yes_top.best_ask as best_ask_yes,
      no_top.best_bid as best_bid_no,
      no_top.best_ask as best_ask_no,`
    : `null::numeric as best_bid_yes,
      null::numeric as best_ask_yes,
      null::numeric as best_bid_no,
      null::numeric as best_ask_no,`;
  const topJoins = includeTop
    ? `left join lateral (
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = token_yes.token_id
        and ts > now() - interval '7 days'
      limit 1
    ) yes_top on true
    left join lateral (
      select best_bid, best_ask
      from unified_token_top_latest
      where token_id = token_no.token_id
        and ts > now() - interval '7 days'
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
    token_matches as (
      select
        t.token_id,
        umt.outcome_side as side,
        umt.market_id,
        t.ordinality
      from input_tokens t
      join unified_market_tokens umt
        on umt.token_id = t.token_id
      where umt.outcome_side is not null
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
      m.condition_id,
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
    from token_matches tm
    join unified_markets m on m.id = tm.market_id
    left join unified_market_tokens token_yes
      on token_yes.market_id = m.id
     and token_yes.outcome_side = 'YES'
    left join unified_market_tokens token_no
      on token_no.market_id = m.id
     and token_no.outcome_side = 'NO'
    ${topJoins}
    left join polymarket_markets pm
      on pm.id = m.venue_market_id and m.venue = 'polymarket'
    ${negRiskParentJoin}
    left join unified_events e on e.id = m.event_id
    ${venueClause}
    order by tm.ordinality
  `;

  const { rows } = await pool.query<MarketByTokenRow>(sql, params);
  return rows;
}
