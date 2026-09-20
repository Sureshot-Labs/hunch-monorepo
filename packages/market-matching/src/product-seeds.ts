import type { MarketMatchingPolicy } from "./policy.js";
import { SUPPORTED_VENUES } from "./contracts.js";

// Read-only product selectors, owned by the matcher. No dependency on cache warming
// or public page visits. Their ranking remains implemented once, in the product API.
export const PRODUCT_SEED_PATHS = {
  feed: [
    "/feed?limit=25&offset=0&sort=trending_v2&sort_dir=desc",
    "/feed?limit=25&offset=0&sort=change24h&sort_dir=desc",
  ],
  map: [
    `/market-map/sidebars?venues=${SUPPORTED_VENUES.join(",")}&trendingLimit=10&volumeMoversLimit=10&liquidityMoversLimit=10&topMoversLimit=10&minVolume24h=1000`,
  ],
  whales: [
    "/wallets/whales?limit=30&offset=0&topChanges=3&sort=last_activity&marketLimit=5&includeSummary=true&windowDays=30&windowHours=168",
  ],
} as const;
export type SeedSurface = keyof typeof PRODUCT_SEED_PATHS;

/** Extract market references only, never bare event/wallet IDs. Bounds also cover
 * malformed responses. Venue/liveness are checked against PostgreSQL before enqueue. */
export function productMarketIds(payload: unknown): string[] {
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
    if (++visited > 10000 || depth > 12 || ids.size >= 500) return;
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
              ? entry.slice(0, 3)
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
  const ids: string[] = [];
  const counts: Partial<Record<SeedSurface, number>> = {};
  const unavailable: SeedSurface[] = [];
  if (!baseUrl) return { ids, counts, unavailable, configured: false };
  const base = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error("invalid_matching_discovery_api_url");
  for (const surface of Object.keys(PRODUCT_SEED_PATHS) as SeedSurface[]) {
    if (!quotas[surface]) continue;
    const selections: string[][] = [];
    for (const path of PRODUCT_SEED_PATHS[surface]) {
      try {
        const response = await fetcher(new URL(path, base), {
          signal: AbortSignal.timeout(10000),
          redirect: "error",
        });
        if (
          !response.ok ||
          Number(response.headers.get("content-length")) > 2_000_000
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
            if (bytes > 2_000_000)
              throw new Error("selector_response_too_large");
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel();
        }
        selections.push(
          productMarketIds(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        );
      } catch {
        if (!unavailable.includes(surface)) unavailable.push(surface);
      }
    }
    const selected = new Set<string>();
    for (let rank = 0; rank < 500 && selected.size < quotas[surface]; rank++) {
      for (const selection of selections)
        if (selection[rank]) selected.add(selection[rank]);
    }
    const picked = [...selected].slice(0, quotas[surface]);
    counts[surface] = picked.length;
    ids.push(...picked);
  }
  return { ids: [...new Set(ids)], counts, unavailable, configured: true };
}
