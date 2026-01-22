import { z } from "zod";

import { zVenue } from "./common.js";

const zChain = z.enum(["polygon", "base", "solana"]);

export const walletFollowBodySchema = z.object({
  address: z.string().min(4),
  chain: zChain,
  label: z.string().min(1).max(120).optional(),
});

export const walletFollowParamsSchema = z.object({
  address: z.string().min(4),
});

export const walletFollowDeleteQuerySchema = z.object({
  chain: zChain,
});

export const walletFollowingQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletProfileParamsSchema = z.object({
  walletId: z.string().uuid(),
});

export const walletActivityQuerySchema = z.object({
  walletId: z.string().uuid().optional(),
  venue: zVenue.optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletPositionsQuerySchema = z.object({
  walletId: z.string().uuid().optional(),
  venue: zVenue.optional(),
  since: z.string().datetime().optional(),
  latest: z.coerce.boolean().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const walletWhalesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  marketLimit: z.coerce.number().int().min(1).max(20).default(5),
  windowDays: z.coerce.number().int().min(1).max(365).default(30),
  sort: z
    .enum([
      "last_activity",
      "volume_30d",
      "trades_30d",
      "exposure_usd",
      "winrate",
    ])
    .default("last_activity"),
});
