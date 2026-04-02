import { z } from "zod";

export const embeddedEvmTransactionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  to: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/),
  data: z
    .string()
    .trim()
    .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
    .default("0x"),
  value: z.string().trim().min(1).max(120).optional(),
  sponsor: z.boolean().optional(),
});

export const embeddedPrivyAuthorizationSignatureSchema = z.object({
  id: z.string().trim().min(1).max(80),
  signature: z.string().trim().min(1),
});

export const embeddedEvmPrepareBodySchema = z.object({
  chainId: z.number().int().positive(),
  transactions: z.array(embeddedEvmTransactionSchema).min(1).max(8),
});

export const embeddedEvmExecuteBodySchema = embeddedEvmPrepareBodySchema.extend({
  signedRequests: z.array(embeddedPrivyAuthorizationSignatureSchema).min(1),
});
