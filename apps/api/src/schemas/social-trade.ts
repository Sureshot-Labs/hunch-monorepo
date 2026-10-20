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
/** Position arithmetic and instrument identity are shared; trade proof is not. */
export const socialBuySnapshotSchema = z
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
    grossNotionalUsd: decimal,
    grossShares: decimal,
    netShares: decimal,
    entryPrice: decimal,
    feesUsd: decimal.nullable(),
    purchasedAt: z.string().datetime(),
  })
  .strict();
export const verifiedBuyFactsSchema = socialBuySnapshotSchema
  .extend({
    owner: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).min(1),
    evidenceRevision: z.string().min(1),
    verifiedAt: z.string().datetime(),
  })
  .strict();
export type VerifiedBuyFacts = z.infer<typeof verifiedBuyFactsSchema>;
export type SocialBuySnapshot = z.infer<typeof socialBuySnapshotSchema>;

export const thesisSourceSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      "market",
      "external_summary",
      "hunch_analysis",
      "holder_summary",
    ]),
    title: z.string().max(240),
    excerpt: z.string().max(1200),
    url: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//i.test(value))
      .nullable(),
    asOf: z.string().datetime().nullable(),
    caveats: z.array(z.string().max(300)).max(3).optional(),
    citedSources: z
      .array(
        z
          .object({
            title: z.string().max(160),
            url: z
              .string()
              .url()
              .refine((value) => /^https?:\/\//i.test(value)),
            asOf: z.string().datetime().nullable(),
          })
          .strict(),
      )
      .max(3)
      .optional(),
    confirmation: z.enum(["confirmed", "developing", "unconfirmed"]).optional(),
    sourceTier: z
      .enum([
        "official",
        "wire",
        "major_media",
        "specialist",
        "social",
        "unknown",
      ])
      .optional(),
  })
  .strict();
export type ThesisSource = z.infer<typeof thesisSourceSchema>;

export const paperBuySnapshotSchema = socialBuySnapshotSchema
  .extend({
    canonicalPurchaseKey: z.string().startsWith("paper:"),
    quoteAsOf: z.string().datetime(),
    simulation: z.literal("top_ask_no_depth_fees_or_slippage"),
    provenance: z
      .object({
        sources: z.array(thesisSourceSchema).max(8),
        policyRevision: z.string(),
        playbookVersion: z.string(),
        model: z.string(),
        angle: z.string().max(600),
        counterargument: z.string().max(1200),
        changeReason: z.string().max(1200).nullable(),
        previousThesisId: z.string().uuid().nullable(),
        argumentKey: z.string(),
      })
      .strict(),
  })
  .strict();
export type PaperBuySnapshot = z.infer<typeof paperBuySnapshotSchema>;
export const thesisBuySnapshotSchema = z.union([
  verifiedBuyFactsSchema,
  paperBuySnapshotSchema,
]);
