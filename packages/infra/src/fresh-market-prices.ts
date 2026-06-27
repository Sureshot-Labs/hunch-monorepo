import {
  buildMarketPriceState,
  type MarketPriceSide,
  type MarketPriceState,
} from "@hunch/shared";

import {
  enqueuePriceRefreshTokens,
  inferPriceRefreshVenue,
  type PriceRefreshRedis,
  type PriceRefreshVenue,
} from "./price-refresh.js";

export type FreshMarketPriceDb = {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
};

export type FreshMarketPriceTokenRef = {
  marketId?: string | null;
  side?: MarketPriceSide | null;
  tokenId: string | null | undefined;
  venue?: string | null;
};

export type VenuePriceRefreshAdapter = (input: {
  marketIds: string[];
  minFreshAt: Date;
  tokenIds: string[];
  venue: PriceRefreshVenue;
}) => Promise<void>;

export type FreshMarketPriceMarketState = {
  fresh: boolean;
  marketId: string;
  priceState: MarketPriceState;
  tokenIds: string[];
  venue: string | null;
};

export type FreshMarketPriceResult = {
  enqueued: number;
  freshTokenIds: string[];
  marketStates: Map<string, FreshMarketPriceMarketState>;
  requestedTokenIds: string[];
  timedOut: boolean;
};

export type FreshMarketPriceOptions = {
  maxBuyPrice?: number;
  terminalPp?: number;
};

type MarketRow = {
  best_ask: string | number | null;
  best_bid: string | number | null;
  clob_token_ids: string | null;
  id: string;
  last_price: string | number | null;
  token_no: string | null;
  token_yes: string | null;
  venue: string | null;
};

type MarketTokenRow = {
  market_id: string;
  outcome_side: string | null;
  token_id: string | null;
  venue: string | null;
};

type TokenTopRow = {
  best_ask: string | number | null;
  best_bid: string | number | null;
  token_id: string;
  ts: Date | string | null;
};

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSide(
  value: string | null | undefined,
): MarketPriceSide | null {
  const upper = value?.trim().toUpperCase();
  return upper === "YES" || upper === "NO" ? upper : null;
}

function normalizeVenue(
  value: string | null | undefined,
): PriceRefreshVenue | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "polymarket") return "polymarket";
  if (normalized === "limitless") return "limitless";
  if (normalized === "dflow" || normalized === "kalshi") return "dflow";
  return null;
}

function parsePolymarketClobTokenIds(value: string | null): {
  no: string | null;
  yes: string | null;
} {
  if (!value) return { yes: null, no: null };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return { yes: null, no: null };
    const yes = typeof parsed[0] === "string" ? normalizeId(parsed[0]) : null;
    const no = typeof parsed[1] === "string" ? normalizeId(parsed[1]) : null;
    return { yes, no };
  } catch {
    return { yes: null, no: null };
  }
}

function venueForToken(
  tokenId: string,
  venue: string | null | undefined,
): PriceRefreshVenue | null {
  return normalizeVenue(venue) ?? inferPriceRefreshVenue(tokenId);
}

function tokenTopIsFresh(
  row: TokenTopRow | undefined,
  minFreshAt: Date,
): boolean {
  if (!row?.ts) return false;
  const tsMs = row.ts instanceof Date ? row.ts.getTime() : Date.parse(row.ts);
  if (!Number.isFinite(tsMs) || tsMs < minFreshAt.getTime()) return false;
  const bid = row.best_bid == null ? null : Number(row.best_bid);
  const ask = row.best_ask == null ? null : Number(row.best_ask);
  return Number.isFinite(bid) || Number.isFinite(ask);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadMarketRows(
  db: FreshMarketPriceDb,
  marketIds: string[],
): Promise<MarketRow[]> {
  if (marketIds.length === 0) return [];
  const { rows } = await db.query<MarketRow>(
    `
      select
        id,
        venue,
        token_yes,
        token_no,
        clob_token_ids,
        best_bid,
        best_ask,
        last_price
      from unified_markets
      where id = any($1::text[])
    `,
    [marketIds],
  );
  return rows;
}

async function loadMarketTokenRows(
  db: FreshMarketPriceDb,
  marketIds: string[],
): Promise<MarketTokenRow[]> {
  if (marketIds.length === 0) return [];
  const { rows } = await db.query<MarketTokenRow>(
    `
      select market_id, venue, outcome_side, token_id
      from unified_market_tokens
      where market_id = any($1::text[])
        and token_id is not null
        and token_id <> ''
    `,
    [marketIds],
  );
  return rows;
}

async function loadTokenTops(
  db: FreshMarketPriceDb,
  tokenIds: string[],
): Promise<Map<string, TokenTopRow>> {
  if (tokenIds.length === 0) return new Map();
  const { rows } = await db.query<TokenTopRow>(
    `
      select token_id, ts, best_bid, best_ask
      from unified_token_top_latest
      where token_id = any($1::text[])
    `,
    [tokenIds],
  );
  return new Map(rows.map((row) => [row.token_id, row]));
}

function addTokenRef(
  refs: FreshMarketPriceTokenRef[],
  input: FreshMarketPriceTokenRef,
): void {
  const tokenId = normalizeId(input.tokenId);
  if (!tokenId) return;
  refs.push({
    marketId: normalizeId(input.marketId ?? undefined),
    side: input.side ?? null,
    tokenId,
    venue: input.venue ?? null,
  });
}

function buildTokenRefs(
  inputRefs: FreshMarketPriceTokenRef[],
  marketRows: MarketRow[],
  marketTokenRows: MarketTokenRow[],
): FreshMarketPriceTokenRef[] {
  const refs: FreshMarketPriceTokenRef[] = [];
  for (const ref of inputRefs) addTokenRef(refs, ref);
  for (const row of marketRows) {
    const clob =
      row.venue === "polymarket"
        ? parsePolymarketClobTokenIds(row.clob_token_ids)
        : null;
    addTokenRef(refs, {
      marketId: row.id,
      side: "YES",
      tokenId: clob?.yes ?? row.token_yes,
      venue: row.venue,
    });
    addTokenRef(refs, {
      marketId: row.id,
      side: "NO",
      tokenId: clob?.no ?? row.token_no,
      venue: row.venue,
    });
  }
  for (const row of marketTokenRows) {
    addTokenRef(refs, {
      marketId: row.market_id,
      side: normalizeSide(row.outcome_side),
      tokenId: row.token_id,
      venue: row.venue,
    });
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const tokenId = normalizeId(ref.tokenId);
    if (!tokenId) return false;
    const key = `${ref.marketId ?? ""}:${ref.side ?? ""}:${tokenId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function capTokenRefs(
  refs: FreshMarketPriceTokenRef[],
  maxTokens: number | undefined,
): FreshMarketPriceTokenRef[] {
  const limit =
    maxTokens != null && Number.isFinite(maxTokens)
      ? Math.max(0, Math.trunc(maxTokens))
      : Number.POSITIVE_INFINITY;
  const accepted = new Set<string>();
  const out: FreshMarketPriceTokenRef[] = [];
  for (const ref of refs) {
    const tokenId = normalizeId(ref.tokenId);
    if (!tokenId) continue;
    if (!accepted.has(tokenId)) {
      if (accepted.size >= limit) continue;
      accepted.add(tokenId);
    }
    out.push(ref);
  }
  return out;
}

function groupTokensByVenue(
  refs: FreshMarketPriceTokenRef[],
): Map<PriceRefreshVenue, string[]> {
  const grouped = new Map<PriceRefreshVenue, Set<string>>();
  for (const ref of refs) {
    const tokenId = normalizeId(ref.tokenId);
    if (!tokenId) continue;
    const venue = venueForToken(tokenId, ref.venue);
    if (!venue) continue;
    const bucket = grouped.get(venue) ?? new Set<string>();
    bucket.add(tokenId);
    grouped.set(venue, bucket);
  }
  return new Map(
    Array.from(grouped.entries()).map(([venue, tokenIds]) => [
      venue,
      Array.from(tokenIds),
    ]),
  );
}

function buildMarketStates(input: {
  freshTokenIds: Set<string>;
  marketRows: MarketRow[];
  priceOptions?: FreshMarketPriceOptions;
  tokenRefs: FreshMarketPriceTokenRef[];
  tokenTops: Map<string, TokenTopRow>;
}): Map<string, FreshMarketPriceMarketState> {
  const refsByMarket = new Map<string, FreshMarketPriceTokenRef[]>();
  for (const ref of input.tokenRefs) {
    const marketId = normalizeId(ref.marketId ?? undefined);
    if (!marketId) continue;
    const refs = refsByMarket.get(marketId) ?? [];
    refs.push(ref);
    refsByMarket.set(marketId, refs);
  }

  const states = new Map<string, FreshMarketPriceMarketState>();
  for (const market of input.marketRows) {
    const refs = refsByMarket.get(market.id) ?? [];
    const yesRef = refs.find((ref) => ref.side === "YES");
    const noRef = refs.find((ref) => ref.side === "NO");
    const yesToken = normalizeId(yesRef?.tokenId);
    const noToken = normalizeId(noRef?.tokenId);
    const tokenIds = Array.from(
      new Set([yesToken, noToken].filter(Boolean) as string[]),
    );
    const yesTop = yesToken ? input.tokenTops.get(yesToken) : null;
    const noTop = noToken ? input.tokenTops.get(noToken) : null;
    const fresh =
      tokenIds.length > 0 &&
      tokenIds.every((tokenId) => input.freshTokenIds.has(tokenId));
    states.set(market.id, {
      fresh,
      marketId: market.id,
      priceState: buildMarketPriceState({
        marketBestAsk: market.best_ask,
        marketBestBid: market.best_bid,
        lastPrice: market.last_price,
        maxBuyPrice: input.priceOptions?.maxBuyPrice,
        noTop: noTop
          ? {
              bestAsk: noTop.best_ask,
              bestBid: noTop.best_bid,
              ts: noTop.ts,
            }
          : null,
        terminalPp: input.priceOptions?.terminalPp,
        yesTop: yesTop
          ? {
              bestAsk: yesTop.best_ask,
              bestBid: yesTop.best_bid,
              ts: yesTop.ts,
            }
          : null,
      }),
      tokenIds,
      venue: market.venue,
    });
  }
  return states;
}

async function loadSnapshot(input: {
  db: FreshMarketPriceDb;
  marketRows: MarketRow[];
  minFreshAt: Date;
  priceOptions?: FreshMarketPriceOptions;
  tokenIds: string[];
  tokenRefs: FreshMarketPriceTokenRef[];
}): Promise<{
  freshTokenIds: Set<string>;
  marketStates: Map<string, FreshMarketPriceMarketState>;
  tokenTops: Map<string, TokenTopRow>;
}> {
  const tokenTops = await loadTokenTops(input.db, input.tokenIds);
  const freshTokenIds = new Set(
    input.tokenIds.filter((tokenId) =>
      tokenTopIsFresh(tokenTops.get(tokenId), input.minFreshAt),
    ),
  );
  return {
    freshTokenIds,
    marketStates: buildMarketStates({
      freshTokenIds,
      marketRows: input.marketRows,
      priceOptions: input.priceOptions,
      tokenRefs: input.tokenRefs,
      tokenTops,
    }),
    tokenTops,
  };
}

export async function requestFreshMarketPrices(input: {
  db: FreshMarketPriceDb;
  enqueue?: boolean;
  marketIds?: string[];
  maxTokens?: number;
  maxBuyPrice?: number;
  minFreshAt?: Date;
  pollMs?: number;
  priority?: "high" | "normal";
  redis?: PriceRefreshRedis | null;
  terminalPp?: number;
  timeoutMs?: number;
  tokenRefs?: FreshMarketPriceTokenRef[];
  venueAdapters?: Partial<Record<PriceRefreshVenue, VenuePriceRefreshAdapter>>;
}): Promise<FreshMarketPriceResult> {
  const marketIds = Array.from(
    new Set(
      (input.marketIds ?? []).map(normalizeId).filter(Boolean) as string[],
    ),
  );
  const minFreshAt = input.minFreshAt ?? new Date();
  // Callers may pass a single pg PoolClient, so DB reads here must stay
  // sequential unless the caller explicitly provides a pool-safe wrapper.
  const marketRows = await loadMarketRows(input.db, marketIds);
  const marketTokenRows = await loadMarketTokenRows(input.db, marketIds);
  const tokenRefs = capTokenRefs(
    buildTokenRefs(input.tokenRefs ?? [], marketRows, marketTokenRows),
    input.maxTokens,
  );
  const tokenIds = Array.from(
    new Set(
      tokenRefs
        .map((ref) => normalizeId(ref.tokenId))
        .filter(Boolean) as string[],
    ),
  );
  const grouped = groupTokensByVenue(tokenRefs);
  let enqueued = 0;

  await Promise.all(
    Array.from(grouped.entries()).map(async ([venue, venueTokenIds]) => {
      const adapter = input.venueAdapters?.[venue];
      if (adapter) {
        await adapter({
          marketIds,
          minFreshAt,
          tokenIds: venueTokenIds,
          venue,
        });
      }
      if (input.enqueue !== false && input.redis) {
        const result = await enqueuePriceRefreshTokens(input.redis, {
          tokenIds: venueTokenIds,
          venue,
          maxTokens: venueTokenIds.length,
          priority: input.priority,
        });
        enqueued += result.enqueued;
      }
    }),
  );

  const timeoutMs = Math.max(0, Math.trunc(input.timeoutMs ?? 0));
  const pollMs = Math.max(25, Math.trunc(input.pollMs ?? 250));
  const deadline = Date.now() + timeoutMs;
  let snapshot = await loadSnapshot({
    db: input.db,
    marketRows,
    minFreshAt,
    priceOptions: {
      maxBuyPrice: input.maxBuyPrice,
      terminalPp: input.terminalPp,
    },
    tokenIds,
    tokenRefs,
  });
  const allFresh = () =>
    tokenIds.length === 0 ||
    tokenIds.every((tokenId) => snapshot.freshTokenIds.has(tokenId));

  while (timeoutMs > 0 && !allFresh() && Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    snapshot = await loadSnapshot({
      db: input.db,
      marketRows,
      minFreshAt,
      priceOptions: {
        maxBuyPrice: input.maxBuyPrice,
        terminalPp: input.terminalPp,
      },
      tokenIds,
      tokenRefs,
    });
  }

  return {
    enqueued,
    freshTokenIds: Array.from(snapshot.freshTokenIds),
    marketStates: snapshot.marketStates,
    requestedTokenIds: tokenIds,
    timedOut: tokenIds.length > 0 && !allFresh(),
  };
}
