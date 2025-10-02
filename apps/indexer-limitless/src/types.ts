import { z } from "zod";

// numbers often come as strings; welcome to APIs.
const numish = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "string" ? (v.trim() ? Number(v) : NaN) : v));

export const LimitlessMarket = z
  .object({
    id: z.number(),
    address: z.string().optional().nullable(),
    conditionId: z.string().optional().nullable(),
    title: z.string(),
    description: z.string().optional().nullable(),
    collateralToken: z
      .object({
        address: z.string().optional().nullable(),
        decimals: z.number().optional().default(6),
        symbol: z.string().optional().nullable(),
      })
      .optional()
      .default({ decimals: 6 }),
    creator: z
      .object({
        name: z.string().optional().nullable(),
        imageURI: z.string().optional().nullable(),
        link: z.string().optional().nullable(),
      })
      .optional()
      .nullable(),
    prices: z.array(numish).optional().default([]), // [yes%, no%]
    categories: z.array(z.string()).optional().default([]),
    tags: z.array(z.string()).optional().default([]),
    status: z.string().optional().default("ACTIVE"),
    expired: z.boolean().optional().default(false),
    expirationDate: z.string().optional().nullable(),
    expirationTimestamp: numish.optional().nullable(),
    volume: numish.optional().nullable(), // often integer in micro units
    volumeFormatted: z.string().optional().nullable(), // "164.109293"
  })
  .passthrough();

export const LimitlessActiveResponse = z
  .object({
    data: z.array(LimitlessMarket).default([]),
    page: z.number().optional(),
    totalPages: z.number().optional(),
  })
  .passthrough();

export type TLimitlessMarket = z.infer<typeof LimitlessMarket>;
