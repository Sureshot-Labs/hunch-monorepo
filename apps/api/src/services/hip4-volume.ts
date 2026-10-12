import { z } from "zod";
import {
  hip4DecimalSchema,
  hip4ProbabilitySchema,
  type Hip4ReadMarket,
} from "@hunch/shared";

const contextSchema = z.object({
  coin: z.string(),
  dayNtlVlm: hip4DecimalSchema,
});

// Spot contexts also contain HIP-4 coins not present in spot universe. Never
// zip the two arrays by index. Keep duplicate identities invalid, not last-win.
export function indexHip4AssetContexts(
  payload: unknown,
): Map<string, unknown[]> | null {
  if (!Array.isArray(payload)) return null;
  const index = new Map<string, unknown[]>();
  for (const row of payload) {
    if (!row || typeof row !== "object" || typeof row.coin !== "string")
      continue;
    if (!row.coin.startsWith("#")) continue;
    const entries = index.get(row.coin) ?? [];
    entries.push(row);
    index.set(row.coin, entries);
  }
  return index;
}

export function applyHip4Volume(
  market: Hip4ReadMarket,
  contexts: ReturnType<typeof indexHip4AssetContexts>,
  observedAt: string,
  maxAgeMs: number,
  priceMaxAgeMs = maxAgeMs,
): Hip4ReadMarket {
  // Match the first-party outcome-list convention and our canonical trade
  // ledger: quote notional of side 0 only. NO is a complementary representation
  // of the same executions, not an additional set of market trades.
  const coin = market.sides.find((side) => side.sideIndex === 0)?.coin;
  const entries = coin ? contexts?.get(coin) : undefined;
  const parsed =
    entries?.length === 1 ? contextSchema.safeParse(entries[0]) : null;
  const result =
    market.quoteToken !== "USDC" || !coin
      ? "wrong_identity"
      : contexts == null ||
          (entries && (!parsed?.success || entries.length !== 1))
        ? "invalid_response"
        : !entries
          ? "metadata_missing"
          : "ok";
  const prices = market.sides.flatMap((side) => {
    const rows = contexts?.get(side.coin);
    if (rows?.length !== 1) return [];
    const price = z.object({ midPx: hip4ProbabilitySchema }).safeParse(rows[0]);
    return price.success ? [{ coin: side.coin, price: price.data.midPx }] : [];
  });
  return {
    ...market,
    volumeAttempt: { at: observedAt, result },
    // Indicative midpoints are not executable books and never settle a market.
    // Null/missing midPx is not substituted with a provider default mark.
    indicativePrices: prices.length
      ? {
          source: "spotMetaAndAssetCtxs",
          prices,
          observedAt,
          validUntil: new Date(
            Date.parse(observedAt) + priceMaxAgeMs,
          ).toISOString(),
        }
      : (market.indicativePrices ?? null),
    volume24h:
      result === "ok" && parsed?.success
        ? {
            usd: parsed.data.dayNtlVlm,
            source: "spotMetaAndAssetCtxs",
            basis: "primary_outcome",
            coin: parsed.data.coin,
            observedAt,
            validUntil: new Date(
              Date.parse(observedAt) + maxAgeMs,
            ).toISOString(),
          }
        : (market.volume24h ?? null),
  };
}

// Shared by the atomic REST/WS write boundary. A newer book or metadata
// generation cannot replace a newer volume observation with an old snapshot.
export function mergeHip4Volume(
  previous: Hip4ReadMarket,
  incoming: Hip4ReadMarket,
) {
  const prev = previous.volume24h;
  const next = incoming.volume24h;
  return {
    indicativePrices:
      (previous.indicativePrices?.observedAt ?? "") >=
      (incoming.indicativePrices?.observedAt ?? "")
        ? (previous.indicativePrices ?? null)
        : (incoming.indicativePrices ?? null),
    volume24h:
      (prev?.observedAt ?? "") >= (next?.observedAt ?? "")
        ? (prev ?? null)
        : (next ?? null),
    volumeAttempt:
      (previous.volumeAttempt?.at ?? "") >= (incoming.volumeAttempt?.at ?? "")
        ? previous.volumeAttempt
        : incoming.volumeAttempt,
  };
}
