import { z } from "zod";
import { zCsvString } from "./common.js";

const zOptionalBool = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((v) => v === true || v === "true")
  .catch(false);

export const walletBalancesQuerySchema = z.object({
  walletAddress: z.string().optional(),
  tokens: zCsvString("tokens is required").optional(),
  chains: zCsvString("chains is required").optional(),
});

export const walletVenueStatusQuerySchema = z.object({
  walletAddress: z.string().optional(),
  wallets: zCsvString("wallets is required").optional(),
  includeAllWallets: zOptionalBool.optional(),
  refresh: zOptionalBool.optional(),
});
