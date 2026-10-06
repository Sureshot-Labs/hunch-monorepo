import { z } from "zod";

export const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  unreadOnly: z.coerce.boolean().optional(),
});

export const notificationReadParamsSchema = z.object({
  id: z.string().uuid(),
});

export const notificationRedemptionSchema = z.object({
  venue: z.string().min(1),
  amountUsd: z.coerce.number().nullable().optional(),
  marketId: z.string().nullable().optional(),
  tokenId: z.string().nullable().optional(),
  positionId: z.string().uuid().optional(),
  positionContract: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  txHash: z.string().nullable().optional(),
  walletAddress: z.string().nullable().optional(),
});
