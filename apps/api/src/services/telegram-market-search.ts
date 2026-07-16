import type { Pool } from "@hunch/infra";

import {
  fetchFeedMarketSearchCandidateIds,
  fetchFeedMarketsDirect,
  type FeedMarketRow,
} from "../repos/unified-read.js";
import { filterVenuesForLifecycleCapability } from "./venue-lifecycle.js";

export type TelegramMarketSearchResult = {
  eventId: string;
  eventTitle: string | null;
  lastPrice: number | null;
  marketId: string;
  marketTitle: string;
  noAsk: number | null;
  venue: string;
  yesAsk: number | null;
};

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapTelegramMarketSearchResult(
  row: FeedMarketRow,
): TelegramMarketSearchResult {
  return {
    eventId: row.event_id,
    eventTitle: row.event_title,
    lastPrice: finiteNumber(row.last_price),
    marketId: row.market_uuid,
    marketTitle: row.market_title?.trim() || "Prediction market",
    noAsk: finiteNumber(row.best_ask_no),
    venue: row.venue,
    yesAsk: finiteNumber(row.best_ask_yes ?? row.best_ask),
  };
}

export async function searchTelegramMarkets(input: {
  pool: Pool;
  query?: string | null;
}): Promise<TelegramMarketSearchResult[]> {
  const query = input.query?.trim() ?? "";
  if (query && query.length < 2) return [];
  const now = new Date();
  const lifecycle = await filterVenuesForLifecycleCapability(
    input.pool,
    null,
    "discovery",
  );
  if (lifecycle.venues.length === 0) return [];
  const baseInputs = {
    limit: 5,
    offset: 0,
    minVol: 0,
    minLiquidity: 0,
    view: "markets",
    venues: lifecycle.venues,
    sort: "trending_v2",
    sortDir: "desc",
    nowParam: now.toISOString(),
    sevenDaysAgo: new Date(
      now.getTime() - 7 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
    sevenDaysFromNow: new Date(
      now.getTime() + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
  } as const;
  if (!query) {
    const rows = await fetchFeedMarketsDirect(input.pool, baseInputs);
    return rows.map(mapTelegramMarketSearchResult);
  }
  for (const candidateLimit of [25, 100]) {
    const candidateIds = await fetchFeedMarketSearchCandidateIds(input.pool, {
      limit: candidateLimit,
      now: now.toISOString(),
      query,
      venues: lifecycle.venues,
    });
    if (candidateIds.length === 0) return [];
    const rows = await fetchFeedMarketsDirect(
      input.pool,
      {
        ...baseInputs,
        limit: candidateIds.length,
        sort: undefined,
        venues: undefined,
      },
      candidateIds,
    );
    if (rows.length >= 5 || candidateIds.length < candidateLimit) {
      return rows.slice(0, 5).map(mapTelegramMarketSearchResult);
    }
  }
  return [];
}
