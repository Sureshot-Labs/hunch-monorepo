import { z } from "zod";

const side = z.enum(["YES", "NO"]);
const timestamp = z.string().datetime();
const count = z.number().int().nonnegative();
export const intelTagCodeSchema = z.enum([
  "top_trader",
  "wallet_activity",
  "winning_bet",
  "price_update",
  "new_evidence",
]);
export const intelTagSchema = z
  .discriminatedUnion("code", [
    z.object({
      code: z.literal("top_trader"),
      label: z.literal("Top Trader"),
      basis: z.object({
        side,
        scope: z.enum(["representative_wallet", "wallet_cluster"]),
        qualifiedWalletCount: count.positive(),
        atPublication: timestamp,
        qualification: z.literal("saved_historical_qualification"),
      }),
    }),
    z.object({
      code: z.literal("wallet_activity"),
      label: z.literal("Wallet Activity"),
      basis: z.object({
        source: z.literal("observed_position_quantity_change"),
        baselineAt: timestamp,
        observedThrough: timestamp,
        sides: z
          .array(
            z.object({
              side,
              increasedWallets: count,
              reducedWallets: count,
              exitedWallets: count,
            }),
          )
          .min(1)
          .max(2),
      }),
    }),
    z.object({
      code: z.literal("winning_bet"),
      label: z.literal("Winning Bet"),
      basis: z.object({
        side,
        result: z.literal("WIN"),
        source: z.literal("canonical_market_resolution"),
      }),
    }),
    z.object({
      code: z.literal("price_update"),
      label: z.literal("Price Update"),
      basis: z.object({
        side,
        before: z.number().min(0).max(1),
        after: z.number().min(0).max(1),
        baselineAt: timestamp,
        observedAt: timestamp,
        direction: z.enum(["with_thesis", "against_thesis"]),
      }),
    }),
    z.object({
      code: z.literal("new_evidence"),
      label: z.literal("New Evidence"),
      basis: z.object({
        side,
        eventAt: timestamp,
        sourcePublishedAt: timestamp,
        source: z.object({
          id: z.string(),
          headline: z.string(),
          url: z.string().url(),
        }),
      }),
    }),
  ])
  .meta({ discriminator: { propertyName: "code" } });
export const intelTagFields = {
  tags: z.array(intelTagSchema),
  primaryTag: intelTagCodeSchema.nullable(),
  tagsVersion: z.literal(1),
};
export const intelTagsSchema = z.object(intelTagFields);
export type IntelTag = z.infer<typeof intelTagSchema>;
export type IntelTags = z.infer<typeof intelTagsSchema>;
