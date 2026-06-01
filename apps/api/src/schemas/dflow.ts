import { z } from "zod";
import { zRequiredString } from "./common.js";

export const dflowExecutionStatusSchema = z.enum([
  "submitted",
  "open",
  "pending_close",
  "fulfilled",
  "no_fill",
  "failed",
]);

export const dflowQuoteQuerySchema = z.object({
  inputMint: zRequiredString("inputMint is required"),
  outputMint: zRequiredString("outputMint is required"),
  amount: zRequiredString("amount is required"),
  slippageBps: z.coerce.number().int().min(0).max(10000).optional(),
  platformFeeBps: z.coerce.number().int().min(0).max(10000).optional(),
  platformFeeScale: z.coerce.number().min(0).max(10000).optional(),
  platformFeeMode: z.enum(["inputMint", "outputMint"]).optional(),
  feeAccount: z.string().optional(),
});

export const dflowOrderQuerySchema = z.object({
  inputMint: zRequiredString("inputMint is required"),
  outputMint: zRequiredString("outputMint is required"),
  amount: zRequiredString("amount is required"),
  userPublicKey: z.string().optional(),
  slippageBps: z.coerce.number().int().min(0).max(10000).optional(),
  platformFeeBps: z.coerce.number().int().min(0).max(10000).optional(),
  platformFeeScale: z.coerce.number().min(0).max(10000).optional(),
  platformFeeMode: z.enum(["inputMint", "outputMint"]).optional(),
  feeAccount: z.string().optional(),
});

export const dflowOrderStatusQuerySchema = z.object({
  signature: zRequiredString("signature is required"),
});

export const dflowSwapBodySchema = z.object({
  userPublicKey: zRequiredString("userPublicKey is required"),
  quoteResponse: z.unknown(),
  dynamicComputeUnitLimit: z.boolean().optional(),
  prioritizationFeeLamports: z.coerce.number().int().min(0).optional(),
});

export const dflowSubmitBodySchema = z.object({
  signedTransaction: zRequiredString("signedTransaction is required"),
  skipPreflight: z.boolean().optional(),
  maxRetries: z.coerce.number().int().min(0).optional(),
});

export const dflowSponsoredSubmitBodySchema = z.object({
  sponsorshipIntentId: zRequiredString("sponsorshipIntentId is required"),
  signedTransaction: zRequiredString("signedTransaction is required"),
  maxRetries: z.coerce.number().int().min(0).optional(),
});

export const dflowPredictionMarketInitBodySchema = z.object({
  outcomeMint: zRequiredString("outcomeMint is required"),
  maxRetries: z.coerce.number().int().min(0).optional(),
});

const zNumberish = z.union([z.string(), z.number()]);

export const dflowExecutionBodySchema = z.object({
  marketId: z.string().optional(),
  purpose: z.enum(["trade", "redeem"]).optional(),
  walletAddress: z.string().optional(),
  inputMint: zRequiredString("inputMint is required"),
  outputMint: zRequiredString("outputMint is required"),
  amountIn: zNumberish.optional(),
  amountOut: zNumberish.optional(),
  inputDecimals: z.coerce.number().int().min(0).max(18).optional(),
  outputDecimals: z.coerce.number().int().min(0).max(18).optional(),
  quoteId: z.string().optional(),
  venueOrderId: z.string().optional(),
  txSignature: zRequiredString("txSignature is required"),
  status: dflowExecutionStatusSchema.optional(),
  side: z.enum(["BUY", "SELL"]).optional(),
  raw: z.unknown().optional(),
});
