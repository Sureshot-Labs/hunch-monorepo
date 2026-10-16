import { z } from "zod";

/** A source is editorial context, never authority for price or trade amount. */
export const socialSourceRefSchema = z
  .object({
    kind: z.enum(["thesis", "hunch"]),
    id: z.string().uuid(),
  })
  .strict();
export type SocialSourceRef = z.infer<typeof socialSourceRefSchema>;

export const socialTradeAttributionFields = {
  sourceRef: socialSourceRefSchema.optional(),
  copyIdempotencyKey: z.string().uuid().optional(),
};

/** Source attribution is one immutable pair, never a later click annotation. */
export function refineSocialTradeAttribution(
  input: {
    sourceRef?: SocialSourceRef;
    copyIdempotencyKey?: string;
    side?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (Boolean(input.sourceRef) !== Boolean(input.copyIdempotencyKey))
    ctx.addIssue({
      code: "custom",
      path: ["sourceRef"],
      message: "Copy requires both sourceRef and copyIdempotencyKey",
    });
  if (input.sourceRef && input.side !== undefined && input.side !== "BUY")
    ctx.addIssue({
      code: "custom",
      path: ["sourceRef"],
      message: "Only a BUY can be attributed as Copy",
    });
}

export const purchaseRefSchema = z
  .object({
    kind: z.enum(["order", "execution"]),
    id: z.string().uuid(),
  })
  .strict();
export type PurchaseRef = z.infer<typeof purchaseRefSchema>;

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
export const socialVenueSchema = z.enum([
  "polymarket",
  "limitless",
  "kalshi",
  "hyperliquid",
]);
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
        venue: socialVenueSchema,
      })
      .strict(),
    owner: z.string().min(1),
    grossNotionalUsd: decimal,
    grossShares: decimal,
    netShares: decimal,
    entryPrice: decimal,
    feesUsd: z
      .string()
      .regex(/^-?\d+(?:\.\d+)?$/)
      .nullable(),
    purchasedAt: z.string().datetime(),
    evidenceIds: z.array(z.string().min(1)).min(1),
    evidenceRevision: z.string().min(1),
    verifiedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((facts, ctx) => {
    // Native quote-currency maker rebates are signed. Do not broaden the
    // existing receipt adapters' nonnegative fee contract for other venues.
    if (
      facts.instrument.venue !== "hyperliquid" &&
      facts.feesUsd?.startsWith("-")
    )
      ctx.addIssue({
        code: "custom",
        path: ["feesUsd"],
        message: "Signed native rebates require Hyperliquid evidence",
      });
  });
export type VerifiedBuyFacts = z.infer<typeof verifiedBuyFactsSchema>;
