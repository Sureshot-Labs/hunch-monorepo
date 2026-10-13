import { z } from "zod";

/** Editorial comparison, not a probability forecast or permission to trade. */
export const holderPublicationComparisonSchema = z
  .object({
    baselineNoteId: z.string().uuid().nullable(),
    kind: z.enum(["first", "update", "opposing", "repeat"]),
    reason: z.string().trim().min(8).max(320),
    materialChange: z.boolean(),
    evidenceIds: z.array(z.string().min(1).max(2_100)).max(4),
  })
  .strict()
  .nullable()
  .optional();

export type HolderPublicationComparison = z.infer<
  typeof holderPublicationComparisonSchema
>;
