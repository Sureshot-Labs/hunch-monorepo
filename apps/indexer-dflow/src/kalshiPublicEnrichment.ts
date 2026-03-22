import type { DflowMappedMarket } from "./mappers.js";
import type { KalshiPublicEventData } from "./kalshiPublicClient.js";

export type KalshiPublicEnrichmentResult = {
  mappedMarkets: DflowMappedMarket[];
  matchedMarkets: number;
  updatedMarkets: number;
  filledBestBid: number;
  filledBestAsk: number;
  filledLastPrice: number;
  updatedVolumeTotal: number;
  updatedVolume24h: number;
  updatedOpenInterest: number;
  updatedLiquidity: number;
};

function differs(a: number | null | undefined, b: number | null | undefined): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === right) return false;
  if (left == null || right == null) return true;
  return Math.abs(left - right) > 1e-9;
}

export function applyKalshiPublicEventToMappedMarkets(
  mappedMarkets: DflowMappedMarket[],
  publicEvent: KalshiPublicEventData,
): KalshiPublicEnrichmentResult {
  const result: KalshiPublicEnrichmentResult = {
    mappedMarkets: [],
    matchedMarkets: 0,
    updatedMarkets: 0,
    filledBestBid: 0,
    filledBestAsk: 0,
    filledLastPrice: 0,
    updatedVolumeTotal: 0,
    updatedVolume24h: 0,
    updatedOpenInterest: 0,
    updatedLiquidity: 0,
  };

  for (const mapped of mappedMarkets) {
    const publicMarket = publicEvent.marketsByTicker.get(
      mapped.marketRow.venue_market_id,
    );
    if (!publicMarket) {
      result.mappedMarkets.push(mapped);
      continue;
    }

    result.matchedMarkets += 1;

    let row = mapped.marketRow;
    let snapshot = mapped.snapshot;
    let updated = false;

    if (row.best_bid == null && publicMarket.bestBid != null) {
      row = { ...row, best_bid: publicMarket.bestBid };
      result.filledBestBid += 1;
      updated = true;
    }
    if (row.best_ask == null && publicMarket.bestAsk != null) {
      row = { ...row, best_ask: publicMarket.bestAsk };
      result.filledBestAsk += 1;
      updated = true;
    }
    if (row.last_price == null && publicMarket.lastPrice != null) {
      row = { ...row, last_price: publicMarket.lastPrice };
      result.filledLastPrice += 1;
      updated = true;
    }
    if (
      publicMarket.volumeTotal != null &&
      differs(publicMarket.volumeTotal, row.volume_total)
    ) {
      row = { ...row, volume_total: publicMarket.volumeTotal };
      result.updatedVolumeTotal += 1;
      updated = true;
    }
    if (
      publicMarket.volume24h != null &&
      differs(publicMarket.volume24h, row.volume_24h)
    ) {
      row = { ...row, volume_24h: publicMarket.volume24h };
      result.updatedVolume24h += 1;
      updated = true;
    }
    if (
      publicMarket.openInterest != null &&
      differs(publicMarket.openInterest, row.open_interest)
    ) {
      row = { ...row, open_interest: publicMarket.openInterest };
      result.updatedOpenInterest += 1;
      updated = true;
    }
    if (
      publicMarket.liquidity != null &&
      differs(publicMarket.liquidity, row.liquidity)
    ) {
      row = { ...row, liquidity: publicMarket.liquidity };
      result.updatedLiquidity += 1;
      updated = true;
    }

    if (snapshot) {
      const nextSnapshot = { ...snapshot };
      let snapshotUpdated = false;

      if (snapshot.yesBid == null && publicMarket.bestBid != null) {
        nextSnapshot.yesBid = publicMarket.bestBid;
        snapshotUpdated = true;
      }
      if (snapshot.yesAsk == null && publicMarket.bestAsk != null) {
        nextSnapshot.yesAsk = publicMarket.bestAsk;
        snapshotUpdated = true;
      }
      if (snapshot.noBid == null && publicMarket.noBid != null) {
        nextSnapshot.noBid = publicMarket.noBid;
        snapshotUpdated = true;
      }
      if (snapshot.noAsk == null && publicMarket.noAsk != null) {
        nextSnapshot.noAsk = publicMarket.noAsk;
        snapshotUpdated = true;
      }
      if (
        publicMarket.volumeTotal != null &&
        differs(publicMarket.volumeTotal, snapshot.volumeTotal)
      ) {
        nextSnapshot.volumeTotal = publicMarket.volumeTotal;
        snapshotUpdated = true;
      }
      if (
        publicMarket.volume24h != null &&
        differs(publicMarket.volume24h, snapshot.volume24h)
      ) {
        nextSnapshot.volume24h = publicMarket.volume24h;
        snapshotUpdated = true;
      }
      if (
        publicMarket.openInterest != null &&
        differs(publicMarket.openInterest, snapshot.openInterest)
      ) {
        nextSnapshot.openInterest = publicMarket.openInterest;
        snapshotUpdated = true;
      }
      if (
        publicMarket.liquidity != null &&
        differs(publicMarket.liquidity, snapshot.liquidity)
      ) {
        nextSnapshot.liquidity = publicMarket.liquidity;
        snapshotUpdated = true;
      }

      if (snapshotUpdated) {
        snapshot = nextSnapshot;
        updated = true;
      }
    }

    if (updated) result.updatedMarkets += 1;
    result.mappedMarkets.push(
      updated ? { ...mapped, marketRow: row, snapshot } : mapped,
    );
  }

  return result;
}
