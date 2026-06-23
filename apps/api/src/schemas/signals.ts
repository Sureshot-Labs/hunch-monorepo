import { z } from "zod";
import { zVenue } from "./common.js";

const zOptionalBool = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => {
    if (value === undefined) return undefined;
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return undefined;
  });

export const signalScopeSchema = z.enum([
  "all",
  "market",
  "event",
  "node",
  "wallet",
]);
export const signalStatusFilterSchema = z.enum([
  "all",
  "active",
  "superseded",
  "retracted",
]);
export const signalTypeFilterSchema = z.enum(["catalyst", "risk", "update"]);
export const signalDirectionFilterSchema = z.enum(["up", "down", "mixed"]);

export const signalsQuerySchema = z.object({
  scope: signalScopeSchema.optional(),
  targetId: z.string().trim().min(1).optional(),
  status: signalStatusFilterSchema.optional(),
  signalType: signalTypeFilterSchema.optional(),
  direction: signalDirectionFilterSchema.optional(),
  venue: zVenue.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  includeSimilarMarkets: zOptionalBool.optional(),
  similarLimit: z.coerce.number().int().min(1).max(12).optional(),
  includeTraders: zOptionalBool.optional(),
  traderLimit: z.coerce.number().int().min(1).max(10).optional(),
});

export const scopedSignalsQuerySchema = signalsQuerySchema.omit({
  scope: true,
  targetId: true,
});

export const holderResearchWalletNotesBodySchema = z.object({
  walletIds: z.array(z.string().uuid()).min(1).max(200),
  limitPerWallet: z.coerce.number().int().min(0).max(10).optional(),
  compact: zOptionalBool.optional(),
});

export type SignalsQuery = z.infer<typeof signalsQuerySchema>;
export type ScopedSignalsQuery = z.infer<typeof scopedSignalsQuerySchema>;
export type HolderResearchWalletNotesBody = z.infer<
  typeof holderResearchWalletNotesBodySchema
>;
