import { z } from "zod";
import { env } from "../env.js";
import { zVenue } from "./common.js";

const zCsvList = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((value) => {
    const parts = Array.isArray(value) ? value : value == null ? [] : [value];
    const out = parts
      .filter((part): part is string => typeof part === "string")
      .flatMap((part) => part.split(","))
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    return out.length ? out : undefined;
  }, z.array(item).optional());

const zVenueQuery = zCsvList(zVenue).transform((venues) => {
  if (!venues?.length) return undefined;
  const unique = Array.from(new Set(venues)).sort();
  return unique.length === zVenue.options.length ? undefined : unique;
});

export const fifaSectionSchema = z.enum([
  "winner",
  "group",
  "stage",
  "match_result",
  "match_prop",
  "player_award",
  "squad",
  "special",
]);

const zSectionQuery = zCsvList(fifaSectionSchema).transform((sections) => {
  if (!sections?.length) return undefined;
  return Array.from(new Set(sections)).sort();
});

const zGroupCodeQuery = zCsvList(
  z.enum(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]),
).transform((codes) => {
  if (!codes?.length) return undefined;
  return Array.from(new Set(codes.map((code) => code.toUpperCase()))).sort();
});

export const fifaSpecialQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .catch(env.defaultLimit)
    .transform((n) => Math.min(Math.max(n, 1), env.maxLimit)),
  offset: z.coerce
    .number()
    .int()
    .catch(0)
    .transform((n) => Math.max(n, 0)),
  view: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "markets" || v === "events" ? v : undefined)),
  q: z
    .preprocess((v) => (typeof v === "string" ? v.trim() : v), z.string())
    .optional()
    .transform((v) => (v && v.length ? v : undefined)),
  venue: zVenueQuery,
  section: zSectionQuery,
  group_code: zGroupCodeQuery,
  team_group_code: zGroupCodeQuery,
  sort: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) =>
      v === "featured" ||
      v === "volume" ||
      v === "volume24h" ||
      v === "liquidity" ||
      v === "time" ||
      v === "newest"
        ? v
        : undefined,
    ),
  sort_dir: z
    .preprocess(
      (v) => (typeof v === "string" ? v.toLowerCase() : v),
      z.string(),
    )
    .optional()
    .transform((v) => (v === "asc" || v === "desc" ? v : undefined)),
});

export type FifaSpecialQuery = z.infer<typeof fifaSpecialQuerySchema>;
export type FifaSection = z.infer<typeof fifaSectionSchema>;
