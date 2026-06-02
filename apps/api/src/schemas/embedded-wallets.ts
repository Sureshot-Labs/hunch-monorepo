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
  sponsorshipIntentId: z.string().trim().min(1).max(120).optional(),
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

export const embeddedSolanaDirectTransferSponsorshipIntentBodySchema = z.object(
  {
    transaction: z.string().trim().min(1),
    mint: z.string().trim().min(1).max(80),
    amountRaw: z.string().trim().regex(/^\d+$/),
    recipientAddress: z.string().trim().min(32).max(64),
  },
);

export const embeddedSolanaSponsorshipLedgerRepairBodySchema = z.object({
  sponsorshipIntentId: z.string().trim().min(1).max(120),
  signature: z.string().trim().min(1).max(180),
  transactionId: z.string().trim().min(1).max(180).optional(),
  requestId: z.string().trim().min(1).max(80).optional(),
});
