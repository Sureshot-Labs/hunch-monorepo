import type { DbQuery } from "../db.js";
import { getMatchedAlternatives } from "./matched-markets.js";
import { resolveClusterOutcomeSide } from "./clusters.js";
import { signalDeliveryCandidateFromAgg } from "./signal-bot-delivery-candidates.js";
import type { SignalDeliveryCandidate } from "./signal-delivery-target.js";

/** Uses the caller's native execution checks; never falls back to AGG. */
export async function loadMatchedSignalCandidates(input: {
  db: DbQuery;
  marketId: string | null | undefined;
  venues: string[];
  buySide: "YES" | "NO";
  nowIso: string;
  readiness: (
    marketId: string,
    side: "YES" | "NO",
  ) => Promise<{
    defer: boolean;
    orderable: boolean;
    blockers: unknown[];
    buyPrice: number | null;
    quoteAsOf?: string | null;
  }>;
}) {
  const candidates: SignalDeliveryCandidate[] = [];
  let deferred = false;
  if (!input.marketId) return { candidates, deferred, failed: false };
  try {
    const response = await getMatchedAlternatives(input.db, input.marketId, {
      venues: input.venues.join(","),
      limit: 20,
    });
    for (const market of response?.alternatives ?? []) {
      const side = resolveClusterOutcomeSide(market, input.buySide);
      if (!side || !market.orderable) continue;
      const readiness = await input.readiness(market.marketId, side);
      if (readiness.defer) {
        deferred = true;
        continue;
      }
      if (
        !readiness.orderable ||
        readiness.blockers.length ||
        readiness.buyPrice == null
      )
        continue;
      const candidate = signalDeliveryCandidateFromAgg({
        buySide: input.buySide,
        executablePrice: readiness.buyPrice,
        quoteAsOf: readiness.quoteAsOf ?? null,
        market,
        priceAsOf: input.nowIso,
      });
      if (candidate) candidates.push(candidate);
    }
    return { candidates, deferred, failed: false };
  } catch {
    return { candidates, deferred, failed: true };
  }
}
