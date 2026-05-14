import { z } from "zod";
import { zVenue } from "./common.js";

const zOptionalString = z
  .string()
  .trim()
  .transform((value) => (value.length ? value : undefined))
  .optional();

const zScope = z.enum([
  "read:account",
  "read:wallets",
  "read:orders",
  "read:positions",
  "read:funding",
  "read:notifications",
]);

const zWalletAddress = z.string().trim().min(1).max(128);

const zLimits = z.record(z.string(), z.unknown()).optional();

export const agentDeviceStartBodySchema = z.object({
  requestedScopes: z.array(zScope).min(1).optional(),
  requestedWalletAddresses: z.array(zWalletAddress).optional(),
  requestedVenues: z.array(zVenue).optional(),
  requestedLimits: zLimits,
  clientName: zOptionalString,
  clientVersion: zOptionalString,
  clientKind: zOptionalString,
  profileLabel: zOptionalString,
  grantName: zOptionalString,
});

export const agentDeviceTokenBodySchema = z.object({
  deviceCode: z.string().trim().min(16),
});

export const agentApprovalTokenParamsSchema = z.object({
  approvalToken: z.string().trim().min(16),
});

export const agentApproveBodySchema = z.object({
  approvalToken: z.string().trim().min(16),
  scopes: z.array(zScope).min(1),
  walletAddresses: z.array(zWalletAddress).optional(),
  venues: z.array(zVenue).optional(),
  limits: zLimits,
  expiresInDays: z.union([
    z.literal(1),
    z.literal(7),
    z.literal(30),
    z.literal(90),
  ]),
  grantName: zOptionalString,
});

export const agentDenyBodySchema = z.object({
  approvalToken: z.string().trim().min(16),
});

export const agentGrantParamsSchema = z.object({
  id: z.string().uuid(),
});

export const agentAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
