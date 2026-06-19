import type { Pool } from "pg";

import { markHotTokens } from "./hot-tokens.js";
import { requestPriceRefreshForTokens } from "./price-refresh.js";

type MarketRefreshVenue = "polymarket" | "dflow" | "limitless";
type Queryable = Pick<Pool, "query">;
type MarketRefreshTokenRow = {
  venue: string | null;
  token_id: string | null;
};
type PendingMarketRefreshBatch = {
  db: Queryable;
  marketIds: Set<string>;
  eventIds: Set<string>;
  tokenRefs: MarketRefreshTokenRef[];
  logLabels: Set<string>;
};

export type MarketRefreshTokenRef = {
  tokenId: string | null | undefined;
  venue?: string | null | undefined;
};

const MARKET_REFRESH_BATCH_DELAY_MS = 250;
const DEFAULT_VISIBLE_MARKET_REFRESH_MAX_MARKETS = 100;

let pendingMarketRefreshBatch: PendingMarketRefreshBatch | null = null;
let pendingMarketRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let marketRefreshFlushChain: Promise<void> = Promise.resolve();

function normalizeId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function collectMarketIdsFromPayloadValue(
  value: unknown,
  input: {
    fields: readonly string[];
    marketIds: Set<string>;
    maxMarkets: number;
    seen: WeakSet<object>;
  },
): void {
  if (input.marketIds.size >= input.maxMarkets) return;
  if (value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMarketIdsFromPayloadValue(item, input);
      if (input.marketIds.size >= input.maxMarkets) return;
    }
    return;
  }

  if (typeof value !== "object") return;
  if (input.seen.has(value)) return;
  input.seen.add(value);

  const record = value as Record<string, unknown>;
  for (const field of input.fields) {
    const id = typeof record[field] === "string" ? normalizeId(record[field]) : null;
    if (id) input.marketIds.add(id);
    if (input.marketIds.size >= input.maxMarkets) return;
  }

  for (const child of Object.values(record)) {
    collectMarketIdsFromPayloadValue(child, input);
    if (input.marketIds.size >= input.maxMarkets) return;
  }
}

export function collectMarketRefreshMarketIdsFromPayload(
  payload: unknown,
  options: {
    fields?: readonly string[];
    maxMarkets?: number;
  } = {},
): string[] {
  const maxMarkets = Math.max(
    0,
    Math.trunc(options.maxMarkets ?? DEFAULT_VISIBLE_MARKET_REFRESH_MAX_MARKETS),
  );
  if (maxMarkets <= 0) return [];

  const fields = options.fields?.length ? options.fields : ["marketId"];
  const marketIds = new Set<string>();
  collectMarketIdsFromPayloadValue(payload, {
    fields,
    marketIds,
    maxMarkets,
    seen: new WeakSet<object>(),
  });
  return Array.from(marketIds);
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

function mergeTokenRowIntoGrouped(
  grouped: Map<MarketRefreshVenue | null, string[]>,
  row: MarketRefreshTokenRow,
): void {
  const tokenId = normalizeId(row.token_id);
  if (!tokenId) return;
  const venue = toMarketRefreshVenue(row.venue);
  const bucket = grouped.get(venue) ?? [];
  if (!bucket.includes(tokenId)) bucket.push(tokenId);
  grouped.set(venue, bucket);
}

function batchLogLabel(batch: PendingMarketRefreshBatch): string {
  const labels = Array.from(batch.logLabels).filter(Boolean);
  if (!labels.length) return "market-refresh";
  if (labels.length === 1) return labels[0] ?? "market-refresh";
  const shown = labels.slice(0, 3);
  const suffix =
    labels.length > shown.length ? `+${labels.length - shown.length}` : "";
  return `${shown.join(",")}${suffix}`;
}

async function fetchMarketRefreshTokenRows(
  db: Queryable,
  marketIds: string[],
  eventIds: string[],
): Promise<MarketRefreshTokenRow[]> {
  if (!marketIds.length && !eventIds.length) return [];

  const { rows } = await db.query<MarketRefreshTokenRow>(
    `
      with input_market_ids as (
        select distinct id
        from unnest($1::text[]) as input(id)
        where id is not null and id <> ''
      ),
      input_event_ids as (
        select distinct id
        from unnest($2::text[]) as input(id)
        where id is not null and id <> ''
      ),
      selected_markets as (
        select m.id
        from input_market_ids im
        join unified_markets m on m.id = im.id
        union
        select m.id
        from input_event_ids ie
        join unified_markets m on m.event_id = ie.id
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

  return rows;
}

async function flushMarketRefreshBatch(
  batch: PendingMarketRefreshBatch,
): Promise<void> {
  const grouped = groupTokenRefsByVenue(batch.tokenRefs);
  const marketIds = Array.from(batch.marketIds);
  const eventIds = Array.from(batch.eventIds);

  for (const row of await fetchMarketRefreshTokenRows(
    batch.db,
    marketIds,
    eventIds,
  )) {
    mergeTokenRowIntoGrouped(grouped, row);
  }

  await enqueueGroupedMarketRefresh(grouped);
}

function queueMarketRefreshBatchFlush(batch: PendingMarketRefreshBatch): void {
  marketRefreshFlushChain = marketRefreshFlushChain
    .then(() => flushMarketRefreshBatch(batch))
    .catch((error) => {
      console.warn(
        `[${batchLogLabel(batch)}] market refresh enqueue failed`,
        error,
      );
    });
}

function scheduleMarketRefreshBatch(): void {
  if (pendingMarketRefreshTimer) return;
  pendingMarketRefreshTimer = setTimeout(() => {
    const batch = pendingMarketRefreshBatch;
    pendingMarketRefreshBatch = null;
    pendingMarketRefreshTimer = null;
    if (!batch) return;

    queueMarketRefreshBatchFlush(batch);
  }, MARKET_REFRESH_BATCH_DELAY_MS);
}

export async function flushPendingMarketRefreshes(): Promise<void> {
  if (pendingMarketRefreshTimer) {
    clearTimeout(pendingMarketRefreshTimer);
    pendingMarketRefreshTimer = null;
  }

  const batch = pendingMarketRefreshBatch;
  pendingMarketRefreshBatch = null;
  if (batch) {
    queueMarketRefreshBatchFlush(batch);
  }

  await marketRefreshFlushChain;
}

export function requestMarketRefreshForTokenRefs(inputs: {
  tokenRefs: MarketRefreshTokenRef[];
  logLabel: string;
}): void {
  if (!inputs.tokenRefs.length) return;
  void enqueueGroupedMarketRefresh(
    groupTokenRefsByVenue(inputs.tokenRefs),
  ).catch((error) => {
    console.warn(`[${inputs.logLabel}] market refresh enqueue failed`, error);
  });
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

  if (pendingMarketRefreshBatch && pendingMarketRefreshBatch.db !== inputs.db) {
    if (pendingMarketRefreshTimer) clearTimeout(pendingMarketRefreshTimer);
    queueMarketRefreshBatchFlush(pendingMarketRefreshBatch);
    pendingMarketRefreshBatch = null;
    pendingMarketRefreshTimer = null;
  }

  const batch =
    pendingMarketRefreshBatch ??
    ({
      db: inputs.db,
      marketIds: new Set<string>(),
      eventIds: new Set<string>(),
      tokenRefs: [],
      logLabels: new Set<string>(),
    } satisfies PendingMarketRefreshBatch);

  for (const marketId of marketIds) batch.marketIds.add(marketId);
  for (const eventId of eventIds) batch.eventIds.add(eventId);
  batch.tokenRefs.push(...tokenRefs);
  batch.logLabels.add(inputs.logLabel);

  pendingMarketRefreshBatch = batch;
  scheduleMarketRefreshBatch();
}
