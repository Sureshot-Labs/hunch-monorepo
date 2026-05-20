import type { Pool } from "pg";

import { markHotTokens } from "./hot-tokens.js";
import { requestPriceRefreshForTokens } from "./price-refresh.js";

type MarketRefreshVenue = "polymarket" | "dflow" | "limitless";
type Queryable = Pick<Pool, "query">;

export type MarketRefreshTokenRef = {
  tokenId: string | null | undefined;
  venue?: string | null | undefined;
};

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toMarketRefreshVenue(
  venue: string | null | undefined,
): MarketRefreshVenue | null {
  const normalized = venue?.trim().toLowerCase();
  if (normalized === "polymarket") return "polymarket";
  if (normalized === "limitless") return "limitless";
  if (normalized === "kalshi" || normalized === "dflow") return "dflow";
  return null;
}

function groupTokenRefsByVenue(
  tokenRefs: MarketRefreshTokenRef[],
): Map<MarketRefreshVenue | null, string[]> {
  const grouped = new Map<MarketRefreshVenue | null, Set<string>>();
  for (const ref of tokenRefs) {
    const tokenId = normalizeId(ref.tokenId);
    if (!tokenId) continue;
    const venue = toMarketRefreshVenue(ref.venue);
    const bucket = grouped.get(venue) ?? new Set<string>();
    bucket.add(tokenId);
    grouped.set(venue, bucket);
  }

  return new Map(
    Array.from(grouped.entries()).map(([venue, tokens]) => [
      venue,
      Array.from(tokens),
    ]),
  );
}

async function enqueueGroupedMarketRefresh(
  grouped: Map<MarketRefreshVenue | null, string[]>,
): Promise<void> {
  await Promise.all(
    Array.from(grouped.entries()).map(async ([venue, tokenIds]) => {
      if (!tokenIds.length) return;
      if (venue) {
        await Promise.all([
          markHotTokens({ tokenIds, venue }),
          requestPriceRefreshForTokens({ tokenIds, venue }),
        ]);
        return;
      }
      await Promise.all([
        markHotTokens({ tokenIds }),
        requestPriceRefreshForTokens({ tokenIds }),
      ]);
    }),
  );
}

export function requestMarketRefreshForTokenRefs(inputs: {
  tokenRefs: MarketRefreshTokenRef[];
  logLabel: string;
}): void {
  if (!inputs.tokenRefs.length) return;
  void enqueueGroupedMarketRefresh(groupTokenRefsByVenue(inputs.tokenRefs)).catch(
    (error) => {
      console.warn(`[${inputs.logLabel}] market refresh enqueue failed`, error);
    },
  );
}

export function requestMarketRefreshForMarketRefs(inputs: {
  db: Queryable;
  marketIds?: Array<string | null | undefined>;
  eventIds?: Array<string | null | undefined>;
  tokenRefs?: MarketRefreshTokenRef[];
  logLabel: string;
}): void {
  const marketIds = Array.from(
    new Set((inputs.marketIds ?? []).map(normalizeId).filter(Boolean)),
  ) as string[];
  const eventIds = Array.from(
    new Set((inputs.eventIds ?? []).map(normalizeId).filter(Boolean)),
  ) as string[];
  const tokenRefs = inputs.tokenRefs ?? [];

  if (!marketIds.length && !eventIds.length && !tokenRefs.length) return;

  void (async () => {
    const grouped = groupTokenRefsByVenue(tokenRefs);
    if (marketIds.length || eventIds.length) {
      const { rows } = await inputs.db.query<{
        venue: string | null;
        token_id: string | null;
      }>(
        `
          with input_market_ids as (
            select id
            from unnest($1::text[]) as input(id)
            where id is not null and id <> ''
          ),
          input_event_ids as (
            select id
            from unnest($2::text[]) as input(id)
            where id is not null and id <> ''
          ),
          selected_markets as (
            select distinct m.id
            from unified_markets m
            left join input_market_ids im on im.id = m.id
            left join input_event_ids ie on ie.id = m.event_id
            where im.id is not null or ie.id is not null
          ),
          token_refs as (
            select mt.venue, mt.token_id
            from selected_markets sm
            join unified_market_tokens mt on mt.market_id = sm.id
            union
            select ut.venue, ut.token_id
            from selected_markets sm
            join unified_tokens ut on ut.market_id = sm.id
          )
          select distinct venue, token_id
          from token_refs
          where token_id is not null and token_id <> ''
        `,
        [marketIds, eventIds],
      );

      for (const row of rows) {
        const tokenId = normalizeId(row.token_id);
        if (!tokenId) continue;
        const venue = toMarketRefreshVenue(row.venue);
        const bucket = grouped.get(venue) ?? [];
        bucket.push(tokenId);
        grouped.set(venue, Array.from(new Set(bucket)));
      }
    }

    await enqueueGroupedMarketRefresh(grouped);
  })().catch((error) => {
    console.warn(`[${inputs.logLabel}] market refresh enqueue failed`, error);
  });
}
