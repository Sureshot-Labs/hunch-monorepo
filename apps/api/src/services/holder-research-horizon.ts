import { z } from "zod";

import {
  marketSegmentCategoryFamily,
  type MarketSegment,
} from "./market-type-classifier.js";

export const HOLDER_RESEARCH_HORIZON_CATEGORIES = [
  "single_game_sports",
  "sports_outright",
  "politics_geo",
  "crypto",
  "macro",
  "technology",
  "weather",
  "health",
  "culture",
  "mentions",
  "other",
] as const;

export type HolderResearchHorizonCategory =
  (typeof HOLDER_RESEARCH_HORIZON_CATEGORIES)[number];

export const holderResearchCategoryHorizonsSchema = z.partialRecord(
  z.enum(HOLDER_RESEARCH_HORIZON_CATEGORIES),
  z
    .number()
    .int()
    .min(1)
    .max(24 * 365 * 10),
);

export type HolderResearchCategoryHorizons = z.infer<
  typeof holderResearchCategoryHorizonsSchema
>;

export const DEFAULT_HOLDER_RESEARCH_CATEGORY_HORIZONS: HolderResearchCategoryHorizons =
  {
    macro: 24 * 60,
    politics_geo: 24 * 60,
  };

export function holderResearchHorizonCategory(
  marketSegment: MarketSegment,
): HolderResearchHorizonCategory {
  if (marketSegment === "politics_geo") return "politics_geo";
  if (marketSegment === "sports_outright") return "sports_outright";
  const family = marketSegmentCategoryFamily(marketSegment);
  if (family === "sports") return "single_game_sports";
  // Politics is handled above; other known families retain their shared names.
  if (family === "politics") return "politics_geo";
  return family ?? "other";
}

/** Resolve one category rule, without changing unrelated publication checks. */
export function resolveHolderResearchPublishHorizon(input: {
  policy: {
    maxPublishHorizonHours: number;
    maxPublishHorizonHoursByCategory?: HolderResearchCategoryHorizons;
  };
  marketSegment: MarketSegment;
}): {
  category: HolderResearchHorizonCategory;
  maxHours: number;
  source: "category" | "fallback";
} {
  const category = holderResearchHorizonCategory(input.marketSegment);
  const categoryHours =
    input.policy.maxPublishHorizonHoursByCategory?.[category];
  return {
    category,
    maxHours: categoryHours ?? input.policy.maxPublishHorizonHours,
    source: categoryHours == null ? "fallback" : "category",
  };
}
