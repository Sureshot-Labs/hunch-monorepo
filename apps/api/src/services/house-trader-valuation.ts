import {
  buildCanonicalMarketTop,
  DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS,
  parsePolymarketAssetContext,
  type PolymarketAssetContext,
} from "@hunch/shared";
import {
  positionAssetKey,
  positionStorageContract,
} from "../lib/position-asset-context.js";
import {
  loadPolymarketHoldingMarkRows,
  type PolymarketHoldingMarkRow,
} from "./polymarket-holding-marks.js";
import type { Action } from "./house-trader-store.js";

const scale = 1_000_000n;
const maxAgeMs = DEFAULT_CANONICAL_MARKET_TOP_MAX_AGE_MS;

export function houseValuationContext(
  position: Pick<Action, "token_id" | "market_id" | "outcome" | "result">,
) {
  const asset = parsePolymarketAssetContext(position.result.assetContext);
  return asset &&
    position.token_id === asset.assetId &&
    position.market_id === asset.marketId &&
    position.outcome === (asset.outcomeIndex === 0 ? "YES" : "NO")
    ? asset
    : null;
}

export function houseMarkKey(asset: PolymarketAssetContext) {
  return positionAssetKey(
    asset.assetId,
    positionStorageContract({
      venue: "polymarket",
      tokenId: asset.assetId,
      assetContext: asset,
    }),
  );
}

export function loadHousePositionMarks(
  db: Parameters<typeof loadPolymarketHoldingMarkRows>[0],
  assets: readonly PolymarketAssetContext[],
) {
  return loadPolymarketHoldingMarkRows(
    db,
    assets.map((assetContext) => ({
      tokenId: assetContext.assetId,
      assetContext,
    })),
  );
}

export type HousePositionValuation = {
  source: "best_bid" | "settlement";
  priceRaw: string;
  valueRaw: string;
  pnlRaw: string;
  asOf: string;
  validUntil: string;
};

/** Display-only valuation. The trade path still quotes and checks execution
 * independently. Top-of-book cannot guarantee depth, fees, or proceeds. */
export function valueHousePosition(input: {
  asset: PolymarketAssetContext;
  mark: PolymarketHoldingMarkRow | undefined;
  shares: bigint;
  cost: bigint | null;
  balanceCheckedAt: number;
  now: number;
}): HousePositionValuation | null {
  const { asset, mark, shares, cost, balanceCheckedAt, now } = input;
  const side = asset.outcomeIndex === 0 ? "YES" : "NO";
  if (
    !mark ||
    mark.token_id !== asset.assetId ||
    mark.market_id !== asset.marketId ||
    mark.outcome_side !== side ||
    shares <= 0n ||
    cost === null ||
    cost <= 0n ||
    !Number.isFinite(balanceCheckedAt) ||
    balanceCheckedAt > now ||
    balanceCheckedAt + maxAgeMs <= now
  )
    return null;

  let price: number;
  let asOf: number;
  let source: HousePositionValuation["source"];
  if (mark.status === "SETTLED") {
    if (mark.resolved_outcome === "YES" || mark.resolved_outcome === "NO") {
      price = mark.resolved_outcome === side ? 1 : 0;
    } else {
      const yesBps = mark.resolved_outcome_pct?.trim()
        ? Number(mark.resolved_outcome_pct)
        : NaN;
      if (!Number.isFinite(yesBps) || yesBps < 0 || yesBps > 10_000)
        return null;
      price = (side === "YES" ? yesBps : 10_000 - yesBps) / 10_000;
    }
    source = "settlement";
    asOf = now;
  } else {
    // A replacement token may share the same outcome but its bid is not a
    // price for this position. Never fall back to midpoint, ask, or last trade.
    if (
      mark.status !== "ACTIVE" ||
      mark.current_token_id !== asset.assetId ||
      mark.resolved_outcome !== null ||
      mark.resolved_outcome_pct !== null
    )
      return null;
    const top = buildCanonicalMarketTop({
      yesTop: {
        bestBid: mark.best_bid,
        bestAsk: mark.best_ask,
        ts: mark.top_ts,
      },
      now,
    });
    const at = top.topAsOf.YES;
    if (
      top.yesBid === null ||
      top.yesBid <= 0 ||
      top.yesBid >= 1 ||
      at === null
    )
      return null;
    source = "best_bid";
    price = top.yesBid;
    asOf = Date.parse(at);
  }
  const expiry = Math.min(balanceCheckedAt, asOf) + maxAgeMs;
  if (expiry <= now) return null;
  const priceRaw = BigInt(Math.round(price * Number(scale)));
  const value = (shares * priceRaw) / scale;
  return {
    source,
    priceRaw: priceRaw.toString(),
    valueRaw: value.toString(),
    pnlRaw: (value - cost).toString(),
    asOf: new Date(asOf).toISOString(),
    validUntil: new Date(expiry).toISOString(),
  };
}

export function summarizeHouseValuations(
  positionIds: readonly string[],
  positions: ReadonlyMap<
    string,
    { balanceUnavailable?: unknown; valuation?: HousePositionValuation | null }
  >,
  now: number,
) {
  let value = 0n;
  let pnl = 0n;
  let valuedPositions = 0;
  let expires = now + maxAgeMs;
  for (const id of positionIds) {
    const position = positions.get(id);
    const mark = position?.valuation;
    if (!mark || position?.balanceUnavailable) continue;
    const expiry = Date.parse(mark.validUntil);
    if (!(expiry > now)) continue;
    expires = Math.min(expires, expiry);
    value += BigInt(mark.valueRaw);
    pnl += BigInt(mark.pnlRaw);
    valuedPositions++;
  }
  const hasValue = valuedPositions > 0 || positionIds.length === 0;
  return {
    valueRaw: hasValue ? value.toString() : null,
    pnlRaw: hasValue ? pnl.toString() : null,
    valuedPositions,
    openPositions: positionIds.length,
    validUntil: hasValue ? new Date(expires).toISOString() : null,
  };
}
