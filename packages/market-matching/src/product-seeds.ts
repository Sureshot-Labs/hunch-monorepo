import type { MarketMatchingPolicy } from "./policy.js";
import { SUPPORTED_VENUES } from "./contracts.js";

// Transport safety ceiling, sized for the largest policy-allowed feed page.
const MAX_SELECTOR_BYTES = 8_000_000;
// Read-only product selectors, owned by the matcher. No dependency on cache warming
// or public page visits. Their ranking remains implemented once, in the product API.
export type SeedSurface = "feed" | "map" | "whales";
export function productSeedPaths(
  p: MarketMatchingPolicy,
): Record<SeedSurface, string[]> {
  return {
    feed: ["trending_v2", "change24h"].map(
      (sort) =>
        `/feed?limit=${p.seedFeedDepth}&offset=0&sort=${sort}&sort_dir=desc`,
    ),
    map: [
      `/market-map/sidebars?venues=${p.venues.join(",")}&trendingLimit=${p.seedMapDepth}&volumeMoversLimit=${p.seedMapDepth}&liquidityMoversLimit=${p.seedMapDepth}&topMoversLimit=${p.seedMapDepth}&minVolume24h=${p.seedMapMinVolumeUsd}`,
    ],
    whales: [
      `/wallets/whales?limit=${p.seedWhalesDepth}&offset=0&topChanges=${p.seedWhaleChangeCount}&sort=last_activity&marketLimit=${p.seedWhaleMarketCount}&includeSummary=true&windowDays=30&windowHours=168`,
    ],
  };
}

/** Extract market references only, never bare event/wallet IDs. Bounds also cover
 * malformed responses. Venue/liveness are checked against PostgreSQL before enqueue. */
export function productMarketIds(
  payload: unknown,
  marketsPerEvent = 3,
): string[] {
  const ids = new Set<string>();
  let visited = 0;
  const add = (value: unknown) => {
    if (
      typeof value === "string" &&
      /^[^:\s]+:[^\s]{1,180}$/.test(value) &&
      SUPPORTED_VENUES.includes(value.split(":", 1)[0])
    )
      ids.add(value);
  };
  const visit = (value: unknown, marketContext = false, depth = 0) => {
    if (++visited > 10000 || depth > 12 || ids.size >= 4000) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, marketContext, depth + 1);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const activity = ["volume24h", "volumeTotal", "liquidity"].flatMap(
        (key) =>
          typeof record[key] === "number" ? [record[key] as number] : [],
      );
      if (
        marketContext &&
        activity.length &&
        activity.every((amount) => amount <= 0)
      )
        return;
      if (
        marketContext &&
        SUPPORTED_VENUES.includes(String(record.venue)) &&
        typeof record.marketId === "string" &&
        !record.marketId.includes(":")
      )
        add(`${record.venue}:${record.marketId}`);
      for (const [key, entry] of Object.entries(value)) {
        if (
          [
            "marketId",
            "market_id",
            "representativeMarketId",
            "targetMarketId",
          ].includes(key) ||
          (marketContext && key === "id")
        )
          add(entry);
        if (entry && typeof entry === "object")
          visit(
            key === "markets" && Array.isArray(entry)
              ? entry.slice(0, marketsPerEvent)
              : entry,
            ["markets", "market", "targetMarket", "topMarkets"].includes(key),
            depth + 1,
          );
      }
    }
  };
  visit(payload);
  return [...ids];
}

export async function collectProductSeeds(
  policy: MarketMatchingPolicy,
  baseUrl: string | undefined,
  fetcher: typeof fetch = fetch,
) {
  const quotas = {
    feed: policy.seedFeedCount,
    map: policy.seedMapCount,
    whales: policy.seedWhalesCount,
  };
  const pools: Record<SeedSurface, string[]> = {
    feed: [],
    map: [],
    whales: [],
  };
  const counts: Partial<Record<SeedSurface, number>> = {};
  const unavailable: SeedSurface[] = [];
  if (!baseUrl) return { pools, counts, unavailable, configured: false };
  const base = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error("invalid_matching_discovery_api_url");
  const paths = productSeedPaths(policy);
  for (const surface of Object.keys(paths) as SeedSurface[]) {
    if (!quotas[surface]) continue;
    const selections: string[][] = [];
    for (const path of paths[surface]) {
      try {
        const response = await fetcher(new URL(path, base), {
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (
          !response.ok ||
          Number(response.headers.get("content-length")) > MAX_SELECTOR_BYTES
        )
          throw new Error("selector_unavailable");
        // Stream a bounded body instead of buffering an unbounded API response.
        const reader = response.body?.getReader();
        if (!reader) throw new Error("empty_selector_response");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_SELECTOR_BYTES)
              throw new Error("selector_response_too_large");
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel();
        }
        selections.push(
          productMarketIds(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
            policy.seedMarketsPerEvent,
          ),
        );
      } catch {
        if (!unavailable.includes(surface)) unavailable.push(surface);
      }
    }
    const selected = new Set<string>();
    // Preserve ranked pools until PostgreSQL has excluded cooling/pending work.
    for (
      let rank = 0;
      rank < Math.max(0, ...selections.map((s) => s.length));
      rank++
    ) {
      for (const selection of selections)
        if (selection[rank]) selected.add(selection[rank]);
    }
    const picked = [...selected];
    counts[surface] = picked.length;
    pools[surface] = picked;
  }
  return { pools, counts, unavailable, configured: true };
}
