import {
  enabledConsumer,
  resolveMarketLinks,
  resolveMarketLinkIds,
  resolveEventLinks,
  type ResolvedLink,
} from "@hunch/market-matching";
import type { Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  buildMarketSummary,
  resolveClusterOutcomeSide,
  computeClusterMetrics,
  type ClusterMarketSummary,
} from "./clusters.js";
import { loadClusterMarketNativeQuotes } from "./cluster-execution-quotes.js";
import {
  CLUSTER_EXECUTION_QUOTE_MAX_AGE_MS,
  buildClusterExecution,
  type ClusterNativeTop,
} from "./cluster-execution.js";
import type {
  AggMarketAlternativesQueryInput,
  AggMarketAlternativesResponse,
  AggClusterListResponse,
  AggClustersQueryInput,
  AggClusterSummary,
} from "./agg-market-clusters.js";

export { enabledConsumer, resolveEventLinks };
function freshMid(top: ClusterNativeTop, now: number): number | null {
  const time = top.asOf ? Date.parse(top.asOf) : NaN;
  return Number.isFinite(time) &&
    time <= now + 5000 &&
    now - time <= CLUSTER_EXECUTION_QUOTE_MAX_AGE_MS &&
    top.bid !== null &&
    top.ask !== null &&
    top.bid >= 0 &&
    top.ask <= 1 &&
    top.bid <= top.ask
    ? (top.bid + top.ask) / 2
    : null;
}
function binaryMapping(link: ResolvedLink): "YES" | "NO" | null {
  if (link.source.outcomes.length !== 2 || link.target.outcomes.length !== 2)
    return null;
  const sides = verifiedSides(link);
  return sides.YES === "YES" && sides.NO === "NO"
    ? "YES"
    : sides.YES === "NO" && sides.NO === "YES"
      ? "NO"
      : null;
}
function verifiedSides(
  link: ResolvedLink,
): NonNullable<ClusterMarketSummary["verifiedOutcomeMapping"]> {
  const result: NonNullable<ClusterMarketSummary["verifiedOutcomeMapping"]> = {
    YES: null,
    NO: null,
  };
  for (const side of ["YES", "NO"] as const) {
    const source = link.source.outcomes.find((o) => o.side === side);
    if (!source) continue;
    const targets = link.outcomes
      .filter((o) => o.sourceOutcomeId === source.id)
      .map(
        (o) =>
          link.target.outcomes.find((target) => target.id === o.targetOutcomeId)
            ?.side,
      )
      .filter(
        (target): target is "YES" | "NO" => target === "YES" || target === "NO",
      );
    if (targets.length === 1) result[side] = targets[0];
  }
  return result;
}
function outcomeLinks(links: ResolvedLink[]) {
  return links.flatMap((link) =>
    link.outcomes.map((mapping) => ({
      ...mapping,
      sourceMarketId: link.source.id,
      targetMarketId: link.target.id,
    })),
  );
}
type MarketSummaryRow = Parameters<typeof buildMarketSummary>[0];
async function loadSummaryRows(db: DbQuery, ids: string[]) {
  return await db.query<Parameters<typeof buildMarketSummary>[0]>(
    `select m.*,m.category as market_category,e.title as event_title,e.description as event_description,
    e.slug as event_slug,e.image as event_image,e.icon as event_icon,e.category as event_category
    from unified_markets m join unified_events e on e.id=m.event_id where m.id=any($1::text[])`,
    [ids],
  );
}
function matchedMarkets(
  rows: MarketSummaryRow[],
  quotes: Awaited<ReturnType<typeof loadClusterMarketNativeQuotes>>,
  marketId: string,
  links: ResolvedLink[],
  now: number,
) {
  const summaries: ClusterMarketSummary[] = rows.map((row) => {
    const summary = buildMarketSummary(row),
      native = quotes.get(row.id);
    const link = links.find((x) => x.target.id === row.id);
    const mapped = link
      ? binaryMapping(link)
      : links.some(binaryMapping)
        ? "YES"
        : null;
    const source = links[0]?.source;
    const verifiedOutcomeMapping = link
      ? verifiedSides(link)
      : {
          YES: source?.outcomes.some((o) => o.side === "YES")
            ? ("YES" as const)
            : null,
          NO: source?.outcomes.some((o) => o.side === "NO")
            ? ("NO" as const)
            : null,
        };
    const yesMid = native ? freshMid(native.yes, now) : null,
      noMid = native ? freshMid(native.no, now) : null;
    const displayQuote = (top: ClusterNativeTop) => ({
      ...top,
      fresh:
        !!top.asOf &&
        Date.parse(top.asOf) <= now + 5000 &&
        now - Date.parse(top.asOf) <= CLUSTER_EXECUTION_QUOTE_MAX_AGE_MS,
    });
    return {
      ...summary,
      source: "hunch_matcher",
      pricingSource: "native_orderbook",
      matchMethod: "verified_outcome_link",
      outcomeMapping: mapped
        ? {
            confidence: 1,
            method: "verified_outcome_link",
            sourceYesTo: mapped,
          }
        : null,
      verifiedOutcomeMapping,
      nativeQuotes: native
        ? { yes: displayQuote(native.yes), no: displayQuote(native.no) }
        : undefined,
      active: native?.active ?? false,
      orderable:
        !!(verifiedOutcomeMapping.YES || verifiedOutcomeMapping.NO) &&
        (native?.orderable ?? false),
      yesBid: yesMid !== null ? (native?.yes.bid ?? null) : null,
      yesAsk: yesMid !== null ? (native?.yes.ask ?? null) : null,
      yesMid,
      noMid,
      priceAsOf: yesMid !== null ? (native?.yes.asOf ?? null) : null,
    };
  });
  const { markets } = buildClusterExecution({
    cluster: {
      id: marketId,
      seedMarketId: marketId,
      markets: summaries,
      priceSpread: computeClusterMetrics(summaries).priceSpread,
    },
    nativeQuotesByMarketId: quotes,
    now: new Date(now),
  });
  return markets;
}
export async function getMatchedAlternatives(
  db: DbQuery,
  marketId: string,
  query: AggMarketAlternativesQueryInput = {},
): Promise<AggMarketAlternativesResponse | null> {
  const found = await db.query<{ event_id: string }>(
    "select event_id from unified_markets where id=$1",
    [marketId],
  );
  if (!found.rows[0]) return null;
  const allowed = query.venues
    ? new Set(query.venues.split(",").map((x) => x.trim()))
    : null;
  const links = (await resolveMarketLinks(db, marketId, 100))
    .filter((x) => !allowed || allowed.has(x.target.venue))
    .slice(0, Math.min(100, Math.max(1, query.limit ?? 20)));
  const ids = [...new Set([marketId, ...links.map((x) => x.target.id)])];
  const result = await loadSummaryRows(db, ids);
  const quotes = await loadClusterMarketNativeQuotes(db, ids);
  const now = Date.now();
  const markets = matchedMarkets(result.rows, quotes, marketId, links, now);
  const alternatives = markets.filter((x) => x.marketId !== marketId);
  const lowest = (side: "yesMid" | "noMid") => {
    const canonicalMid = (market: ClusterMarketSummary) => {
      const native = resolveClusterOutcomeSide(
        market,
        side === "yesMid" ? "YES" : "NO",
      );
      return native === "YES"
        ? market.yesMid
        : native === "NO"
          ? market.noMid
          : null;
    };
    const selected = markets
      .filter((x) => canonicalMid(x) !== null)
      .sort((a, b) => (canonicalMid(a) ?? 0) - (canonicalMid(b) ?? 0))[0];
    return selected
      ? {
          marketId: selected.marketId,
          eventId: selected.eventId,
          venue: selected.venue,
          yesMid: selected.yesMid,
          noMid: selected.noMid,
          outcomeMapping: selected.outcomeMapping,
          verifiedOutcomeMapping: selected.verifiedOutcomeMapping,
        }
      : null;
  };
  return {
    generatedAt: new Date(now).toISOString(),
    source: "hunch_matcher",
    pricingSource: "native_orderbook",
    marketId,
    eventId: found.rows[0].event_id,
    status: alternatives.length ? "matched" : "not_found",
    markets,
    alternatives,
    outcomeLinks: outcomeLinks(links),
    priceSpread: computeClusterMetrics(markets).priceSpread,
    lowestYesMid: lowest("yesMid"),
    lowestNoMid: lowest("noMid"),
    matchDiagnostics: {
      source: "hunch_matcher",
      sourceMarketIds: [marketId],
      matchedMarketIds: alternatives.map((x) => x.marketId),
      venues: [...new Set(links.map((x) => x.target.venue))] as (
        | "polymarket"
        | "limitless"
      )[],
    },
    diagnostics: {
      aggNoMatch: 0,
      targetSearchEmpty: 0,
      externalMatchUnindexed: 0,
      canonicalMarketInactive: 0,
      outcomeMappingMissing: markets.filter((x) => !x.outcomeMapping).length,
      priceUnavailable: markets.filter((x) => x.yesMid === null).length,
    },
  };
}
export async function getMatchedClusters(
  db: Pool,
  query: AggClustersQueryInput,
  enrichExecutions: (
    db: Pool,
    items: AggClusterSummary[],
  ) => Promise<AggClusterSummary[]>,
): Promise<AggClusterListResponse> {
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const rows = await db.query<{
    id: string;
    left_id: string;
    right_id: string;
  }>(
    "select id,left_id,right_id from market_links where disposition='approved' and id>$1 order by id limit $2",
    [query.cursor ?? "", Math.min(100, query.sourceLimit ?? 100)],
  );
  const allowed = query.venues
    ? new Set(query.venues.split(",").map((v) => v.trim()))
    : null;
  const resolved = (
    await resolveMarketLinkIds(
      db,
      rows.rows.map((link) => link.id),
    )
  ).filter(
    (link) =>
      !allowed ||
      (allowed.has(link.source.venue) && allowed.has(link.target.venue)),
  );
  const byLinkId = new Map(resolved.map((link) => [link.link.id, link]));
  const ids = [
    ...new Set(resolved.flatMap((link) => [link.source.id, link.target.id])),
  ];
  const summaries = await loadSummaryRows(db, ids);
  const byMarketId = new Map(summaries.rows.map((row) => [row.id, row]));
  const quotes = await loadClusterMarketNativeQuotes(db, ids);
  const now = Date.now();
  const items: AggClusterSummary[] = [];
  let consumed = 0;
  for (const link of rows.rows) {
    consumed += 1;
    const resolvedLink = byLinkId.get(link.id);
    if (!resolvedLink) continue;
    const pairRows = [
      byMarketId.get(link.left_id),
      byMarketId.get(link.right_id),
    ].filter((row): row is MarketSummaryRow => !!row);
    if (pairRows.length !== 2) continue;
    const markets = matchedMarkets(
      pairRows,
      quotes,
      link.left_id,
      [resolvedLink],
      now,
    );
    const metrics = computeClusterMetrics(markets);
    if (
      metrics.venueCount < (query.minVenueCount ?? 2) ||
      (metrics.minLiquidity ?? 0) < (query.minLiquidity ?? 0) ||
      (metrics.priceSpread ?? 0) < (query.minSpread ?? 0)
    )
      continue;
    items.push({
      id: link.id,
      label: markets[0].marketTitle ?? "Matched market",
      score: 1,
      source: "hunch_matcher",
      category: markets[0].marketCategory,
      seedMarketId: link.left_id,
      marketCount: 2,
      ...metrics,
      analysis: null,
      analysisStatus: null,
      analysisUpdatedAt: null,
      analysisConfidence: null,
      analysisModel: null,
      qualityScore: null,
      matchDiagnostics: {
        source: "hunch_matcher",
        sourceMarketIds: [link.left_id],
        matchedMarketIds: [link.right_id],
        venues: [resolvedLink.source.venue, resolvedLink.target.venue] as (
          | "polymarket"
          | "limitless"
        )[],
      },
      markets,
      outcomeLinks: outcomeLinks([resolvedLink]),
      updatedAt: new Date(now).toISOString(),
      version: "matching-v1",
    });
    if (items.length >= limit) break;
  }
  // The API caller owns verification; shared sidecar reads must not import API env.
  const enriched = await enrichExecutions(db, items);
  if (query.sort_by)
    enriched.sort(
      (a, b) =>
        ((query.sort_by === "volume24h" ? a.volume24h : a.priceSpread) ?? 0) -
        ((query.sort_by === "volume24h" ? b.volume24h : b.priceSpread) ?? 0),
    );
  if (query.sort_by && query.sort_dir !== "asc") enriched.reverse();
  const complete =
    consumed === rows.rows.length &&
    rows.rows.length < Math.min(100, query.sourceLimit ?? 100);
  return {
    generatedAt: new Date().toISOString(),
    defaults: {
      limit,
      minVenueCount: 2,
      minSpread: 0,
      minQualityScore: 0,
      minAnalysisConfidence: 0,
      maxOutlierRatio: 0,
    },
    items: enriched,
    coverage: {
      complete,
      nextCursor: complete ? null : (rows.rows[consumed - 1]?.id ?? null),
      pagesFetched: 1,
      sourceMarkets: consumed,
    },
  };
}
