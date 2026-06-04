import { z } from "zod";

export const embeddedEvmTransactionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  to: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{40}$/),
  data: z
    .string()
    .trim()
    .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
    .default("0x"),
  value: z.string().trim().min(1).max(120).optional(),
  gas: z.string().trim().min(1).max(120).optional(),
  sponsor: z.boolean().optional(),
});

export const embeddedPrivyAuthorizationSignatureSchema = z.object({
  id: z.string().trim().min(1).max(80),
  signature: z.string().trim().min(1),
});

const embeddedExecutionKeySchema = z.string().trim().min(1).max(160);
const zSolanaBigintString = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .min(1)
  .max(80);
const zSolanaReadinessBlockingReason = z
  .enum([
    "market_not_initialized",
    "prefund_disabled",
    "insufficient_usdc_for_prefund",
  ])
  .nullable();

export const embeddedWalletErrorResponseSchema = z.object({
  error: z.string(),
  debug: z.unknown().optional(),
});

export const solanaPrefundOperationSchema = z.enum([
  "dflow_buy",
  "dflow_sell",
  "dflow_redeem",
  "across",
  "debridge",
  "direct_transfer",
]);

export const embeddedEvmPrepareBodySchema = z.object({
  chainId: z.number().int().positive(),
  transactions: z.array(embeddedEvmTransactionSchema).min(1).max(8),
});

export const embeddedEvmExecuteBodySchema = embeddedEvmPrepareBodySchema.extend(
  {
    executionKey: embeddedExecutionKeySchema,
    signedRequests: z.array(embeddedPrivyAuthorizationSignatureSchema).min(1),
  },
);

export const embeddedSolanaTransactionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  transaction: z.string().trim().min(1),
  encoding: z.enum(["base64"]).default("base64"),
  sponsor: z.boolean().optional(),
  caip2: z
    .string()
    .trim()
    .regex(/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/)
    .optional(),
});

export const embeddedSolanaPrepareBodySchema = z.object({
  executionKey: embeddedExecutionKeySchema.optional(),
  transactions: z.array(embeddedSolanaTransactionSchema).min(1).max(8),
});

export const embeddedSolanaExecuteBodySchema =
  embeddedSolanaPrepareBodySchema.extend({
    executionKey: embeddedExecutionKeySchema,
    signedRequests: z.array(embeddedPrivyAuthorizationSignatureSchema).min(1),
  });

export const solanaReadinessBodySchema = z.object({
  walletAddress: z.string().trim().min(1).optional(),
  operation: solanaPrefundOperationSchema,
  marketId: z.string().trim().min(1).max(160).optional(),
  inputMint: z.string().trim().min(1).max(120).optional(),
  outputMint: z.string().trim().min(1).max(120).optional(),
  amountRaw: zSolanaBigintString.optional(),
});

export const solanaPrefundPrepareBodySchema = z.object({
  walletAddress: z.string().trim().min(1).optional(),
  operation: solanaPrefundOperationSchema,
  marketId: z.string().trim().min(1).max(160).optional(),
  inputMint: z.string().trim().min(1).max(120).optional(),
  outputMint: z.string().trim().min(1).max(120).optional(),
  amountRaw: zSolanaBigintString.optional(),
  amountInRaw: zSolanaBigintString,
  executionKey: embeddedExecutionKeySchema.optional(),
});

export const solanaPrefundExecuteBodySchema = z.object({
  walletAddress: z.string().trim().min(1).optional(),
  executionKey: embeddedExecutionKeySchema,
  signedRequests: z.array(embeddedPrivyAuthorizationSignatureSchema).min(1),
});

export const solanaReadinessResponseSchema = z.object({
  ok: z.boolean(),
  walletAddress: z.string(),
  operation: solanaPrefundOperationSchema,
  solBalanceLamports: zSolanaBigintString,
  solBalance: z.string(),
  usdcBalanceRaw: zSolanaBigintString,
  usdcBalance: z.string(),
  minSolLamports: zSolanaBigintString,
  targetSolLamports: zSolanaBigintString,
  maxTopUpLamports: zSolanaBigintString,
  needsPrefund: z.boolean(),
  prefundAvailable: z.boolean(),
  blockingReason: zSolanaReadinessBlockingReason,
});

export const solanaPrefundPrepareResponseSchema = z.object({
  ok: z.boolean(),
  signer: z.string(),
  executionKey: embeddedExecutionKeySchema,
  operation: solanaPrefundOperationSchema,
  amountInRaw: zSolanaBigintString,
  estimatedOutLamports: zSolanaBigintString,
  transactionDigest: z.string(),
  quote: z.unknown(),
  requests: z.array(z.unknown()),
});

export const solanaPrefundExecuteResponseSchema = z.object({
  ok: z.boolean(),
  signer: z.string(),
  operation: solanaPrefundOperationSchema,
  amountInRaw: zSolanaBigintString,
  estimatedOutLamports: zSolanaBigintString,
  signatures: z.array(z.string()),
});
