import type { Pool } from "@hunch/infra";

import type {
  FundingReasonCode,
  ValuedPositionComponent,
} from "../funding/domain/types.js";
import type { Position } from "../order-types.js";
import { fetchPositionsForUserWallet } from "../repos/positions-repo.js";
import {
  fetchMarketsByTokenIds,
  type MarketByTokenRow,
} from "../repos/unified-read.js";
import { mapMarketsByTokenRows } from "../services/markets-by-token-response.js";
import { deduplicatePositionComponents, stableOpaqueId } from "./canonical.js";
import {
  multiplyUnsignedDecimals,
  normalizeUnsignedDecimal,
  subtractUnsignedDecimals,
} from "./decimal.js";

type SupportedValuedVenue = "polymarket" | "limitless";

type MarketEntry = ReturnType<typeof mapMarketsByTokenRows>[number];
type ExactMarketEntry = Readonly<{
  mapped: MarketEntry;
  raw: MarketByTokenRow;
}>;

function normalizePositionToken(venue: string, tokenId: string): string {
  if (venue === "limitless") {
    return tokenId.startsWith("limitless:")
      ? tokenId.slice("limitless:".length)
      : tokenId;
  }
  return tokenId;
}

function positionIdentity(position: Position): string {
  const wallet = position.walletAddress?.startsWith("0x")
    ? position.walletAddress.toLowerCase()
    : (position.walletAddress ?? "unknown");
  return [
    position.venue,
    wallet,
    normalizePositionToken(position.venue, position.tokenId).toLowerCase(),
  ].join(":");
}

function positionBindingId(position: Position): string {
  return stableOpaqueId(
    "binding",
    `${position.userId}:${position.venue}:${position.walletAddress?.toLowerCase() ?? "unknown"}`,
  );
}

function readExactProbability(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const normalized = normalizeUnsignedDecimal(value);
    subtractUnsignedDecimals("1", normalized);
    return normalized;
  } catch {
    return null;
  }
}

export function readResolvedPositionProbability(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const normalized = normalizeUnsignedDecimal(value);
    try {
      subtractUnsignedDecimals("1", normalized);
      return normalized;
    } catch {
      const probability = multiplyUnsignedDecimals(normalized, "0.0001");
      subtractUnsignedDecimals("1", probability);
      return probability;
    }
  } catch {
    return null;
  }
}

export function estimatePositionUsdFromExactText(inputs: {
  size: string;
  price: string;
}): string | null {
  try {
    return multiplyUnsignedDecimals(
      normalizeUnsignedDecimal(inputs.size),
      normalizeUnsignedDecimal(inputs.price),
    );
  } catch {
    return null;
  }
}

function resolvePositionMark(
  position: Position,
  entry: ExactMarketEntry | undefined,
): Readonly<{
  price: string | null;
  asOf: string;
  confidence: "high" | "medium";
  source: string;
  reasonCode: FundingReasonCode | null;
}> {
  const positionAsOf = position.lastUpdatedAt.toISOString();
  if (!entry) {
    return {
      price: null,
      asOf: positionAsOf,
      confidence: "medium",
      source: "position-market-mapping",
      reasonCode: "asset_unpriced",
    };
  }
  const resolved = entry.mapped.market.resolvedOutcome?.toUpperCase() ?? null;
  const side =
    entry.mapped.side === "YES" || entry.mapped.side === "NO"
      ? entry.mapped.side
      : null;
  if (resolved === "YES" || resolved === "NO") {
    return {
      price: side === resolved ? "1" : "0",
      asOf: positionAsOf,
      confidence: "high",
      source: "venue-resolution",
      reasonCode: null,
    };
  }
  const yesResolutionPrice = readResolvedPositionProbability(
    entry.raw.resolved_outcome_pct,
  );
  if (yesResolutionPrice != null && side) {
    return {
      price:
        side === "YES"
          ? yesResolutionPrice
          : subtractUnsignedDecimals("1", yesResolutionPrice),
      asOf: positionAsOf,
      confidence: "high",
      source: "venue-resolution-percentage",
      reasonCode: null,
    };
  }
  const status = entry.mapped.market.status?.toUpperCase() ?? "";
  if (status === "CLOSED" || status === "SETTLED") {
    return {
      price: null,
      asOf: positionAsOf,
      confidence: "medium",
      source: "position-market-top",
      reasonCode: "asset_unpriced",
    };
  }
  const price =
    side === "YES"
      ? readExactProbability(entry.raw.best_bid_yes)
      : side === "NO"
        ? readExactProbability(entry.raw.best_bid_no)
        : null;
  return {
    price,
    asOf: (side ? entry.mapped.market.topAsOf?.[side] : null) ?? positionAsOf,
    confidence: "medium",
    source: "canonical-top-of-book-bid",
    reasonCode: price != null ? null : "asset_unpriced",
  };
}

function buildComponent(inputs: {
  position: Position;
  entry: ExactMarketEntry | undefined;
  now: Date;
  freshnessMs: number;
}): ValuedPositionComponent {
  const identity = positionIdentity(inputs.position);
  const mark = resolvePositionMark(inputs.position, inputs.entry);
  const observedAtMs = Date.parse(mark.asOf);
  const stale =
    !Number.isFinite(observedAtMs) ||
    inputs.now.getTime() - observedAtMs > inputs.freshnessMs;
  const estimatedValue =
    mark.price != null && inputs.position.sizeRaw
      ? estimatePositionUsdFromExactText({
          size: inputs.position.sizeRaw,
          price: mark.price,
        })
      : null;
  const valuationEligibility = stale
    ? "stale"
    : estimatedValue == null
      ? "unpriced"
      : "included";
  const reasonCodes: FundingReasonCode[] = [];
  if (stale) reasonCodes.push("stale_projection");
  if (mark.reasonCode) reasonCodes.push(mark.reasonCode);
  if (!stale && estimatedValue == null && !mark.reasonCode) {
    reasonCodes.push("asset_unpriced");
  }

  return {
    componentId: stableOpaqueId("position", identity),
    venueId: inputs.position.venue,
    venueBindingId: positionBindingId(inputs.position),
    positionRef: identity,
    estimatedUsd:
      estimatedValue == null
        ? null
        : {
            value: estimatedValue,
            asOf: mark.asOf,
            priceSource: mark.source,
            confidence: mark.confidence,
            policyId: `${inputs.position.venue}-position-mark-v1`,
          },
    valuationMethod: mark.source,
    observedAt: mark.asOf,
    observationFreshness: stale ? "stale" : "fresh",
    observationError: null,
    valuationEligibility,
    reasonCodes,
  };
}

export async function collectVenuePositionValues(inputs: {
  pool: Pool;
  userId: string;
  walletAddresses: readonly string[];
  venue: SupportedValuedVenue;
  now: Date;
  freshnessMs: number;
}): Promise<readonly ValuedPositionComponent[]> {
  const positions = await fetchPositionsForUserWallet(inputs.pool, {
    userId: inputs.userId,
    walletAddresses: [...inputs.walletAddresses],
    venue: inputs.venue,
    includeHidden: false,
    includeResolved: false,
  });
  if (positions.length === 0) return [];
  const tokenIds = Array.from(
    new Set(positions.map((position) => position.tokenId)),
  );
  const rows = await fetchMarketsByTokenIds(inputs.pool, {
    tokenIds,
    venue: inputs.venue,
    includeTop: true,
  });
  const mappedEntries = mapMarketsByTokenRows(rows, {
    now: inputs.now,
    polymarketOrderabilityMode: "trust_accepting_orders",
  });
  const byToken = new Map<string, ExactMarketEntry>();
  for (const [index, mapped] of mappedEntries.entries()) {
    const raw = rows[index];
    if (!raw) continue;
    const entry = { mapped, raw };
    byToken.set(mapped.tokenId, entry);
    byToken.set(normalizePositionToken(inputs.venue, mapped.tokenId), entry);
    byToken.set(raw.token_id, entry);
    byToken.set(normalizePositionToken(inputs.venue, raw.token_id), entry);
  }
  const components = positions.map((position) =>
    buildComponent({
      position,
      entry:
        byToken.get(position.tokenId) ??
        byToken.get(normalizePositionToken(inputs.venue, position.tokenId)),
      now: inputs.now,
      freshnessMs: inputs.freshnessMs,
    }),
  );
  return deduplicatePositionComponents(components).components;
}

export async function collectUnpricedKalshiPositions(inputs: {
  pool: Pool;
  userId: string;
  walletAddresses: readonly string[];
  now: Date;
  freshnessMs: number;
}): Promise<readonly ValuedPositionComponent[]> {
  const positions = await fetchPositionsForUserWallet(inputs.pool, {
    userId: inputs.userId,
    walletAddresses: [...inputs.walletAddresses],
    venue: "kalshi",
    includeHidden: false,
    includeResolved: false,
  });
  const components = positions.map((position) => {
    const identity = positionIdentity(position);
    const observedAt = position.lastUpdatedAt.toISOString();
    const stale =
      inputs.now.getTime() - position.lastUpdatedAt.getTime() >
      inputs.freshnessMs;
    return {
      componentId: stableOpaqueId("position", identity),
      venueId: "kalshi",
      venueBindingId: positionBindingId(position),
      positionRef: identity,
      estimatedUsd: null,
      valuationMethod: "unavailable",
      observedAt,
      observationFreshness: stale ? "stale" : "fresh",
      observationError: null,
      valuationEligibility: stale ? "stale" : "unpriced",
      reasonCodes: [stale ? "stale_projection" : "asset_unpriced"],
    } satisfies ValuedPositionComponent;
  });
  return deduplicatePositionComponents(components).components;
}
