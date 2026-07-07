import type { Pool } from "@hunch/infra";
import {
  deleteHistoryOrder,
  findLimitlessHistoryMatch,
  storeOrder,
  updateOrderFromHistory,
} from "../repos/orders-repo.js";
import {
  normalizeLimitlessRawTokenId,
  normalizeLimitlessScopedTokenId,
} from "../lib/limitless-token.js";
import { isRecord } from "../lib/type-guards.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./limitless-client.js";
import {
  buildLimitlessRequestAuthInputs,
  type LimitlessAuthContext,
} from "./limitless-auth.js";
import { normalizeLimitlessHistoryAmount } from "./limitless-order-normalization.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./notifications.js";
import { applyOptimisticPositionTradeOnce } from "./positions-optimistic.js";
import { recordLimitlessVolumeEvent } from "./limitless-volume-events.js";

export type LimitlessHistorySyncStats = {
  fetched: number;
  nextCursor: string | null;
  storedNew: number;
  alreadyKnown: number;
  positionUpdates: number;
  positionUpdateErrors: number;
  volumeEventsInserted: number;
  volumeEventErrors: number;
  skippedNoId: number;
  skippedNoSide: number;
  skippedNoOutcome: number;
  skippedNoMarket: number;
  skippedNoToken: number;
  sampleVenueOrderIds: string[];
};

function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeOrderId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return null;
}

function extractLimitlessHistoryEntries(
  payload: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    const collection =
      payload.data ?? payload.history ?? payload.items ?? payload.results;
    if (Array.isArray(collection)) {
      return collection.filter(isRecord);
    }
    if (isRecord(collection)) {
      return [collection];
    }
  }
  return [];
}

function extractLimitlessNextCursor(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (typeof payload.nextCursor !== "string") return null;
  const cursor = payload.nextCursor.trim();
  return cursor.length ? cursor : null;
}

function normalizeHistoryStrategy(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function normalizeHistorySide(strategy: string | null): "BUY" | "SELL" | null {
  if (!strategy) return null;
  const normalized = strategy.trim().toLowerCase();
  if (normalized.includes("buy")) return "BUY";
  if (normalized.includes("sell")) return "SELL";
  return null;
}

function normalizeHistoryOrderType(
  strategy: string | null,
): "GTC" | "FOK" | null {
  if (!strategy) return null;
  const normalized = strategy.trim().toLowerCase();
  if (normalized.includes("limit")) return "GTC";
  if (normalized.includes("market")) return "FOK";
  return null;
}

function normalizeHistoryOutcomeIndex(value: unknown): number | null {
  const parsed = parseNumberish(value);
  if (parsed == null) return null;
  const index = Math.trunc(parsed);
  return Number.isFinite(index) ? index : null;
}

function normalizeHistoryPrice(value: unknown): number | null {
  const parsed = parseNumberish(value);
  if (parsed == null) return null;
  const normalized = parsed > 1 ? parsed / 100 : parsed;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    return null;
  }
  return normalized;
}

function normalizeHistoryAmount(value: unknown): number | null {
  return normalizeLimitlessHistoryAmount(value);
}

function normalizeHistorySize(
  outcomeAmount: unknown,
  price: number | null,
  collateralAmount: unknown,
): number | null {
  const outcome = normalizeHistoryAmount(outcomeAmount);
  if (outcome != null && outcome > 0) return outcome;
  if (price != null && price > 0) {
    const collateral = normalizeHistoryAmount(collateralAmount);
    if (collateral != null && collateral > 0) {
      return collateral / price;
    }
  }
  return null;
}

function deriveHistoryNotionalUsd(inputs: {
  collateralAmount: unknown;
  price: number | null;
  size: number | null;
}): number | null {
  const collateral = normalizeHistoryAmount(inputs.collateralAmount);
  if (collateral != null && collateral > 0) return collateral;
  if (
    inputs.price != null &&
    inputs.price > 0 &&
    inputs.size != null &&
    inputs.size > 0
  ) {
    const notional = inputs.price * inputs.size;
    return Number.isFinite(notional) && notional > 0 ? notional : null;
  }
  return null;
}

function normalizeHistoryTimestamp(value: unknown): Date | null {
  const parsed = parseNumberish(value);
  if (parsed == null) return null;
  const tsMs = parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
  const date = new Date(tsMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function applyConfirmedHistoryFillToPosition(
  pool: Pool,
  inputs: {
    orderId: string;
    userId: string;
    walletAddress: string;
    tokenId: string;
    side: "BUY" | "SELL";
    price: number | null;
    size: number | null;
    collateralAmount: unknown;
  },
): Promise<boolean> {
  if (inputs.size == null || inputs.size <= 0) return false;
  const notionalUsd = deriveHistoryNotionalUsd({
    collateralAmount: inputs.collateralAmount,
    price: inputs.price,
    size: inputs.size,
  });
  if (notionalUsd == null || notionalUsd <= 0) return false;

  const result = await applyOptimisticPositionTradeOnce(pool, {
    orderId: inputs.orderId,
    userId: inputs.userId,
    walletAddress: inputs.walletAddress,
    venue: "limitless",
    tokenId: inputs.tokenId,
    side: inputs.side,
    shares: inputs.size,
    notionalUsd,
  });
  return result.applied;
}

function extractHistoryMarketId(entry: Record<string, unknown>): string | null {
  const market = isRecord(entry.market) ? entry.market : null;
  const raw =
    (market && (market.id ?? market.marketId ?? market.market_id)) ??
    entry.marketId ??
    entry.market_id;
  return normalizeOrderId(raw);
}

function extractHistoryMarketSlug(
  entry: Record<string, unknown>,
): string | null {
  const market = isRecord(entry.market) ? entry.market : null;
  const raw =
    (market && (market.slug ?? market.marketSlug ?? market.market_slug)) ??
    entry.marketSlug ??
    entry.market_slug;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function extractHistoryTxHash(entry: Record<string, unknown>): string | null {
  const raw = entry.transactionHash ?? entry.txHash ?? entry.tx_hash;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

type LimitlessTokenPair = { tokenYes: string | null; tokenNo: string | null };

function shouldNotifyHistoryFill(previousStatus: string | null): boolean {
  const normalized = previousStatus?.trim().toLowerCase();
  return normalized !== "filled" && normalized !== "matched";
}

function normalizeLimitlessMarketContextId(
  marketId: string | null,
): string | null {
  if (!marketId) return null;
  return marketId.startsWith("limitless:") ? marketId : `limitless:${marketId}`;
}

function normalizeRawLimitlessTokenIdFromUnknown(
  value: unknown,
): string | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
    ? normalizeLimitlessRawTokenId(value)
    : null;
}

function extractLimitlessPositionTokenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeRawLimitlessTokenIdFromUnknown(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function extractLimitlessTokenPairFromMarket(
  market: Record<string, unknown> | null,
): LimitlessTokenPair | null {
  if (!market) return null;
  const tokensRecord = isRecord(market.tokens)
    ? market.tokens
    : isRecord(market.token)
      ? market.token
      : null;
  const positionIds = extractLimitlessPositionTokenIds(
    market.position_ids ?? market.positionIds,
  );

  const tokenYes =
    normalizeRawLimitlessTokenIdFromUnknown(
      tokensRecord
        ? (tokensRecord.yes ?? tokensRecord.YES ?? tokensRecord[0])
        : null,
    ) ??
    positionIds[0] ??
    null;
  const tokenNo =
    normalizeRawLimitlessTokenIdFromUnknown(
      tokensRecord
        ? (tokensRecord.no ?? tokensRecord.NO ?? tokensRecord[1])
        : null,
    ) ??
    positionIds[1] ??
    null;

  if (!tokenYes && !tokenNo) return null;
  return { tokenYes, tokenNo };
}

function extractLimitlessTokenPairFromHistoryEntry(
  entry: Record<string, unknown>,
): LimitlessTokenPair | null {
  const market = isRecord(entry.market) ? entry.market : null;
  return extractLimitlessTokenPairFromMarket(market);
}

function mergeLimitlessTokenPair(
  primary: LimitlessTokenPair | null,
  fallback: LimitlessTokenPair | null,
): LimitlessTokenPair | null {
  if (!primary && !fallback) return null;
  const tokenYes = primary?.tokenYes ?? fallback?.tokenYes ?? null;
  const tokenNo = primary?.tokenNo ?? fallback?.tokenNo ?? null;
  if (!tokenYes && !tokenNo) return null;
  return { tokenYes, tokenNo };
}

async function fetchLimitlessTokenPairBySlug(inputs: {
  slug: string;
  authContext: LimitlessAuthContext;
}): Promise<LimitlessTokenPair | null> {
  const slug = inputs.slug.trim();
  if (!slug) return null;
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
    ...buildLimitlessRequestAuthInputs(inputs.authContext),
  });
  if (!upstream.ok) return null;
  const payload = upstream.payload;
  const market = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  return extractLimitlessTokenPairFromMarket(market);
}

function buildHistoryVenueOrderId(
  entry: Record<string, unknown>,
  strategy: string | null,
  outcomeIndex: number | null,
): string | null {
  const txHash = extractHistoryTxHash(entry);
  const suffix = outcomeIndex != null ? outcomeIndex.toString() : "x";
  const strat = strategy
    ? strategy.trim().toLowerCase().replace(/\s+/g, "-")
    : "unknown";
  if (txHash) {
    return `history:${txHash}:${suffix}:${strat}`;
  }
  const marketKey =
    extractHistoryMarketId(entry) ?? extractHistoryMarketSlug(entry);
  const ts = parseNumberish(
    entry.blockTimestamp ?? entry.block_timestamp ?? entry.timestamp,
  );
  if (!marketKey || ts == null) return null;
  return `history:${marketKey}:${ts}:${suffix}:${strat}`;
}

function buildHistoryVolumeSourceId(inputs: {
  entry: Record<string, unknown>;
  strategy: string | null;
  tokenId: string;
  venueOrderId: string;
}): string {
  const txHash = extractHistoryTxHash(inputs.entry);
  const strategy = inputs.strategy?.trim().toLowerCase();
  if (txHash && (strategy === "buy" || strategy === "sell")) {
    return `amm:${txHash}:${inputs.tokenId}`;
  }
  return inputs.venueOrderId;
}

export async function syncLimitlessHistoryForWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    authContext: LimitlessAuthContext;
    limit: number;
    cursor?: string;
  },
): Promise<LimitlessHistorySyncStats> {
  const params = new URLSearchParams({ limit: String(inputs.limit) });
  if (inputs.cursor?.trim()) params.set("cursor", inputs.cursor.trim());

  const profileId = inputs.authContext.storedProfile?.id;
  const headers =
    profileId != null ? { "x-on-behalf-of": String(profileId) } : undefined;

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/portfolio/history?${params.toString()}`,
    ...buildLimitlessRequestAuthInputs(inputs.authContext),
    headers,
  });

  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    throw new Error(
      message
        ? `Limitless history sync failed (${upstream.status}): ${message}`
        : `Limitless history sync failed (${upstream.status}).`,
    );
  }

  const entries = extractLimitlessHistoryEntries(upstream.payload);
  const nextCursor = extractLimitlessNextCursor(upstream.payload);
  const marketIds = new Set<string>();
  const marketSlugs = new Set<string>();
  for (const entry of entries) {
    const marketId = extractHistoryMarketId(entry);
    if (marketId) marketIds.add(marketId);
    const slug = extractHistoryMarketSlug(entry);
    if (slug) marketSlugs.add(slug);
  }

  const tokensByMarketId = new Map<
    string,
    { tokenYes: string | null; tokenNo: string | null }
  >();
  const tokensBySlug = new Map<
    string,
    { tokenYes: string | null; tokenNo: string | null }
  >();

  if (marketIds.size || marketSlugs.size) {
    const { rows } = await pool.query<{
      venue_market_id: string;
      slug: string | null;
      token_yes: string | null;
      token_no: string | null;
    }>(
      `
        select venue_market_id, slug, token_yes, token_no
        from unified_markets
        where venue = 'limitless'
          and (venue_market_id = any($1::text[]) or slug = any($2::text[]))
      `,
      [Array.from(marketIds), Array.from(marketSlugs)],
    );

    for (const row of rows) {
      tokensByMarketId.set(row.venue_market_id, {
        tokenYes: normalizeLimitlessRawTokenId(row.token_yes),
        tokenNo: normalizeLimitlessRawTokenId(row.token_no),
      });
      if (row.slug) {
        tokensBySlug.set(row.slug, {
          tokenYes: normalizeLimitlessRawTokenId(row.token_yes),
          tokenNo: normalizeLimitlessRawTokenId(row.token_no),
        });
      }
    }
  }
  const fetchedBySlug = new Map<string, LimitlessTokenPair | null>();

  let storedNew = 0;
  let alreadyKnown = 0;
  let positionUpdates = 0;
  let positionUpdateErrors = 0;
  let volumeEventsInserted = 0;
  let volumeEventErrors = 0;
  let skippedNoId = 0;
  let skippedNoSide = 0;
  let skippedNoOutcome = 0;
  let skippedNoMarket = 0;
  let skippedNoToken = 0;
  const sampleVenueOrderIds: string[] = [];

  for (const entry of entries) {
    const strategy = normalizeHistoryStrategy(entry.strategy);
    const side = normalizeHistorySide(strategy);
    if (!side) {
      skippedNoSide += 1;
      continue;
    }

    const outcomeIndex = normalizeHistoryOutcomeIndex(
      entry.outcomeIndex ?? entry.outcome_index,
    );
    if (outcomeIndex == null) {
      skippedNoOutcome += 1;
      continue;
    }

    const venueOrderId = buildHistoryVenueOrderId(
      entry,
      strategy,
      outcomeIndex,
    );
    if (!venueOrderId) {
      skippedNoId += 1;
      continue;
    }
    if (sampleVenueOrderIds.length < 10) {
      sampleVenueOrderIds.push(venueOrderId);
    }

    const marketId = extractHistoryMarketId(entry);
    const marketSlug = extractHistoryMarketSlug(entry);
    let tokenMeta =
      (marketId ? tokensByMarketId.get(marketId) : undefined) ??
      (marketSlug ? tokensBySlug.get(marketSlug) : undefined) ??
      extractLimitlessTokenPairFromHistoryEntry(entry);
    if (marketSlug && (!tokenMeta?.tokenYes || !tokenMeta?.tokenNo)) {
      if (!fetchedBySlug.has(marketSlug)) {
        fetchedBySlug.set(
          marketSlug,
          await fetchLimitlessTokenPairBySlug({
            slug: marketSlug,
            authContext: inputs.authContext,
          }),
        );
      }
      tokenMeta = mergeLimitlessTokenPair(
        tokenMeta ?? null,
        fetchedBySlug.get(marketSlug) ?? null,
      );
      if (tokenMeta) {
        tokensBySlug.set(marketSlug, tokenMeta);
        if (marketId) tokensByMarketId.set(marketId, tokenMeta);
      }
    }
    if (!tokenMeta) {
      skippedNoMarket += 1;
      continue;
    }

    const rawTokenId =
      outcomeIndex === 0
        ? tokenMeta.tokenYes
        : outcomeIndex === 1
          ? tokenMeta.tokenNo
          : null;
    const tokenId = normalizeLimitlessScopedTokenId(rawTokenId);
    if (!tokenId) {
      skippedNoToken += 1;
      continue;
    }

    const price = normalizeHistoryPrice(
      entry.outcomeTokenPrice ?? entry.outcome_token_price,
    );
    let size = normalizeHistorySize(
      entry.outcomeTokenAmount ?? entry.outcome_token_amount,
      price,
      entry.collateralAmount ?? entry.collateral_amount,
    );
    if (size != null && size <= 0) size = null;

    const timestamp = normalizeHistoryTimestamp(
      entry.blockTimestamp ?? entry.block_timestamp ?? entry.timestamp,
    );
    const orderType = normalizeHistoryOrderType(strategy);
    const orderHash = extractHistoryTxHash(entry);
    const notionalUsd = deriveHistoryNotionalUsd({
      collateralAmount: entry.collateralAmount ?? entry.collateral_amount,
      price,
      size,
    });
    const volumeSourceId = buildHistoryVolumeSourceId({
      entry,
      strategy,
      tokenId,
      venueOrderId,
    });

    async function recordHistoryVolumeEvent(): Promise<void> {
      try {
        volumeEventsInserted += await recordLimitlessVolumeEvent(pool, {
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          sourceId: volumeSourceId,
          notionalUsd,
          createdAt: timestamp,
        });
      } catch {
        volumeEventErrors += 1;
      }
    }

    if (timestamp) {
      const match = await findLimitlessHistoryMatch(pool, {
        userId: inputs.userId,
        walletAddress: inputs.walletAddress,
        tokenId,
        side,
        orderType: orderType ?? null,
        postedAt: timestamp,
      });
      if (match) {
        const shouldNotifyFill = shouldNotifyHistoryFill(match.status);
        const shouldApplyPositionFill = !match.positionDeltaApplied;
        await updateOrderFromHistory(pool, {
          id: match.id,
          status: "filled",
          price,
          size,
          filledAt: timestamp,
          lastUpdate: timestamp,
          orderHash,
          orderPayload: entry,
        });
        if (shouldNotifyFill) {
          void createNotificationSafe(
            pool,
            buildOrderNotification({
              userId: inputs.userId,
              venue: "limitless",
              status: "filled",
              side,
              size,
              price,
              orderId: match.venueOrderId ?? match.id,
              marketId: normalizeLimitlessMarketContextId(marketId),
              tokenId,
              walletAddress: inputs.walletAddress,
            }),
          );
        }
        await deleteHistoryOrder(pool, {
          userId: inputs.userId,
          venue: "limitless",
          venueOrderId,
        });
        if (shouldApplyPositionFill) {
          try {
            const applied = await applyConfirmedHistoryFillToPosition(pool, {
              orderId: match.id,
              userId: inputs.userId,
              walletAddress: inputs.walletAddress,
              tokenId,
              side,
              price,
              size,
              collateralAmount:
                entry.collateralAmount ?? entry.collateral_amount,
            });
            if (applied) {
              positionUpdates += 1;
            }
          } catch {
            positionUpdateErrors += 1;
          }
        }
        await recordHistoryVolumeEvent();
        alreadyKnown += 1;
        continue;
      }
    }

    const result = await storeOrder(pool, {
      userId: inputs.userId,
      walletAddress: inputs.walletAddress,
      signerAddress: inputs.walletAddress,
      venue: "limitless",
      venueOrderId,
      tokenId,
      side,
      orderType: orderType ?? null,
      price,
      size,
      status: "filled",
      errorMessage: null,
      rawError: null,
      orderPayload: entry,
      orderHash,
      postedAt: timestamp,
      lastUpdate: timestamp,
      filledAt: timestamp,
    });

    if (result.kind === "stored") storedNew += 1;
    if (result.kind === "exists") alreadyKnown += 1;
    if (result.kind === "stored") {
      try {
        const applied = await applyConfirmedHistoryFillToPosition(pool, {
          orderId: result.order.id,
          userId: inputs.userId,
          walletAddress: inputs.walletAddress,
          tokenId,
          side,
          price,
          size,
          collateralAmount: entry.collateralAmount ?? entry.collateral_amount,
        });
        if (applied) {
          positionUpdates += 1;
        }
      } catch {
        positionUpdateErrors += 1;
      }
    }
    await recordHistoryVolumeEvent();
  }

  return {
    fetched: entries.length,
    nextCursor,
    storedNew,
    alreadyKnown,
    positionUpdates,
    positionUpdateErrors,
    volumeEventsInserted,
    volumeEventErrors,
    skippedNoId,
    skippedNoSide,
    skippedNoOutcome,
    skippedNoMarket,
    skippedNoToken,
    sampleVenueOrderIds,
  };
}
