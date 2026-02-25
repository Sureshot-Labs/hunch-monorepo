import { z } from "zod";
import { zCsvString } from "./common.js";

const zOptionalBool = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((v) => v === true || v === "true")
  .catch(false);

const WALLET_BALANCES_TOKENS_MAX = 60;
const WALLET_BALANCES_BATCH_TOKENS_MAX = 120;

const zWalletBalanceTokens = zCsvString("tokens is required").refine(
  (tokens) => tokens.length <= WALLET_BALANCES_TOKENS_MAX,
  {
    message: `tokens exceeds max size (${WALLET_BALANCES_TOKENS_MAX})`,
  },
);

const zWalletBalanceBatchTokens = zCsvString("tokens is required").refine(
  (tokens) => tokens.length <= WALLET_BALANCES_BATCH_TOKENS_MAX,
  {
    message: `tokens exceeds max size (${WALLET_BALANCES_BATCH_TOKENS_MAX})`,
  },
);

export const walletBalancesQuerySchema = z.object({
  walletAddress: z.string().optional(),
  tokens: zWalletBalanceTokens.optional(),
  chains: zCsvString("chains is required").optional(),
});

export const walletBalancesBatchQuerySchema = z.object({
  wallets: zCsvString("wallets is required"),
  tokens: zWalletBalanceBatchTokens.optional(),
  chains: zCsvString("chains is required").optional(),
});

export const walletVenueStatusQuerySchema = z.object({
  walletAddress: z.string().optional(),
  wallets: zCsvString("wallets is required").optional(),
  includeAllWallets: zOptionalBool.optional(),
  refresh: zOptionalBool.optional(),
});
