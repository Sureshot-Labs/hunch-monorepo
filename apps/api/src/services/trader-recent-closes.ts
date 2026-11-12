import type { ObservedClose } from "../schemas/trader-collections.js";
import { DAY, UNIT, fmt, type Close } from "./trader-collection-ledger.js";

export const qualifiesForStreak = (c: Close, dust: bigint) =>
  c.net !== 0n && c.stake >= dust && c.stake * UNIT <= 900000n * c.shares;

// Simultaneous observations have no economic order. Break ties only for
// reproducible presentation; never feed this tie-breaker into the streak length.
export const closeOrder = (a: Close, b: Close) =>
  b.at - a.at ||
  a.instrument.marketId.localeCompare(b.instrument.marketId, "en") ||
  a.instrument.tokenId.localeCompare(b.instrument.tokenId, "en") ||
  a.instrument.generation.localeCompare(b.instrument.generation, "en") ||
  (a.net < b.net ? -1 : a.net > b.net ? 1 : 0);

export function topObservedCloses(
  series: Iterable<readonly Close[]>,
  end: number,
  after = end - 30 * DAY,
): Close[] {
  const top: Close[] = [];
  for (const rows of series)
    for (const c of rows) {
      if (c.at <= after || c.at > end) continue;
      if (top.length === 10 && closeOrder(c, top[9]) >= 0) continue;
      let i = top.length;
      while (i && closeOrder(c, top[i - 1]) < 0) i--;
      top.splice(i, 0, c);
      if (top.length > 10) top.pop();
    }
  return top;
}
export function recentObservedCloses(
  series: Iterable<readonly Close[]>,
  end: number,
  dust: bigint,
  after = end - 30 * DAY,
): ObservedClose[] {
  return topObservedCloses(series, end, after).map((c) => ({
    ...(c.basis ? { basis: c.basis } : {}),
    instrument: c.instrument,
    completedAt: new Date(c.at * 1000).toISOString(),
    estimatedEpisodePnlUsd: fmt(c.net),
    result: c.net > 0n ? "win" : c.net < 0n ? "loss" : "flat",
    qualifiesForStreak: qualifiesForStreak(c, dust),
  }));
}
