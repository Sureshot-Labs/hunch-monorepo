import { z } from "zod";

/** A source is editorial context, never authority for price or trade amount. */
export const socialSourceRefSchema = z
  .object({
    kind: z.enum(["thesis", "hunch"]),
    id: z.string().uuid(),
  })
  .strict();
export type SocialSourceRef = z.infer<typeof socialSourceRefSchema>;

export const purchaseRefSchema = z
  .object({
    kind: z.enum(["order", "execution"]),
    id: z.string().uuid(),
  })
  .strict();
export type PurchaseRef = z.infer<typeof purchaseRefSchema>;

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
export const verifiedBuyFactsSchema = z
  .object({
    version: z.literal(1),
    canonicalPurchaseKey: z.string().min(1),
    instrument: z
      .object({
        marketId: z.string().min(1),
        tokenId: z.string().min(1),
        outcome: z.enum(["YES", "NO"]),
        generation: z.string().min(1),
        expiry: z.string().nullable(),
        venue: z.enum(["polymarket", "limitless", "kalshi"]),
      })
      .strict(),
    owner: z.string().min(1),
    grossNotionalUsd: decimal,
    grossShares: decimal,
    netShares: decimal,
    entryPrice: decimal,
    feesUsd: decimal.nullable(),
    purchasedAt: z.string().datetime(),
    evidenceIds: z.array(z.string().min(1)).min(1),
    evidenceRevision: z.string().min(1),
    verifiedAt: z.string().datetime(),
  })
  .strict();
export type VerifiedBuyFacts = z.infer<typeof verifiedBuyFactsSchema>;
