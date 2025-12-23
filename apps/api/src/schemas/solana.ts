import { z } from "zod";
import { zCsvString, zRequiredString } from "./common.js";

export const solanaMintsQuerySchema = z.object({
  ids: zCsvString("ids is required").refine((ids) => ids.length <= 50, {
    message: "ids must contain 50 or fewer mints",
  }),
});

export const solanaBlockhashQuerySchema = z.object({
  walletAddress: z.string().optional(),
});

export const solanaBalanceQuerySchema = z.object({
  walletAddress: z.string().optional(),
  mint: zRequiredString("mint is required"),
});

export const solanaSubmitBodySchema = z.object({
  signedTransaction: zRequiredString("signedTransaction is required"),
  skipPreflight: z.boolean().optional(),
  maxRetries: z.coerce.number().int().min(0).optional(),
  walletAddress: z.string().optional(),
});
