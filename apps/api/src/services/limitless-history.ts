import type { Pool } from "@hunch/infra";
import { storeOrder } from "../repos/orders-repo.js";
import { isRecord } from "../lib/type-guards.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "./limitless-client.js";

export type LimitlessHistorySyncStats = {
  fetched: number;
  storedNew: number;
  alreadyKnown: number;
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

function normalizeLimitlessTokenId(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("limitless:") ? trimmed : `limitless:${trimmed}`;
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
  const parsed = parseNumberish(value);
  if (parsed == null) return null;
  const normalized = parsed > 1_000_000 ? parsed / 1_000_000 : parsed;
  if (!Number.isFinite(normalized)) return null;
  return normalized;
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

function normalizeHistoryTimestamp(value: unknown): Date | null {
  const parsed = parseNumberish(value);
  if (parsed == null) return null;
  const tsMs = parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
  const date = new Date(tsMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractHistoryMarketId(entry: Record<string, unknown>): string | null {
  const market = isRecord(entry.market) ? entry.market : null;
  const raw =
    (market && (market.id ?? market.marketId ?? market.market_id)) ??
    entry.marketId ??
    entry.market_id;
  return normalizeOrderId(raw);
}

function extractHistoryMarketSlug(entry: Record<string, unknown>): string | null {
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
  const marketKey = extractHistoryMarketId(entry) ?? extractHistoryMarketSlug(entry);
  const ts = parseNumberish(
    entry.blockTimestamp ?? entry.block_timestamp ?? entry.timestamp,
  );
  if (!marketKey || ts == null) return null;
  return `history:${marketKey}:${ts}:${suffix}:${strat}`;
}

export async function syncLimitlessHistoryForWallet(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddress: string;
    sessionCookie: string;
    page: number;
    limit: number;
    from?: string;
    to?: string;
  },
): Promise<LimitlessHistorySyncStats> {
  const params = new URLSearchParams({
    page: String(inputs.page),
    limit: String(inputs.limit),
  });
  if (inputs.from?.trim()) params.set("from", inputs.from.trim());
  if (inputs.to?.trim()) params.set("to", inputs.to.trim());

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/portfolio/history?${params.toString()}`,
    sessionCookie: inputs.sessionCookie,
  });

  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    throw new Error(
      message
        ? `Limitless history sync failed: ${message}`
        : "Limitless history sync failed.",
    );
  }

  const entries = extractLimitlessHistoryEntries(upstream.payload);
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
        tokenYes: row.token_yes,
        tokenNo: row.token_no,
      });
      if (row.slug) {
        tokensBySlug.set(row.slug, {
          tokenYes: row.token_yes,
          tokenNo: row.token_no,
        });
      }
    }
  }

  let storedNew = 0;
  let alreadyKnown = 0;
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
    const tokenMeta =
      (marketId ? tokensByMarketId.get(marketId) : undefined) ??
      (marketSlug ? tokensBySlug.get(marketSlug) : undefined);
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
    const tokenId = normalizeLimitlessTokenId(rawTokenId);
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
      postedAt: timestamp,
      lastUpdate: timestamp,
      filledAt: timestamp,
    });

    if (result.kind === "stored") storedNew += 1;
    if (result.kind === "exists") alreadyKnown += 1;
  }

  return {
    fetched: entries.length,
    storedNew,
    alreadyKnown,
    skippedNoId,
    skippedNoSide,
    skippedNoOutcome,
    skippedNoMarket,
    skippedNoToken,
    sampleVenueOrderIds,
  };
}
