import { z } from "zod";
import { zCsvString, zVenue } from "./common.js";
import { ordersQuerySchema } from "./orders.js";

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
const zOptionalBool = z
  .union([z.boolean(), z.string(), z.undefined()])
  .transform((value) => value === true || value === "true")
  .catch(false);

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

export const agentWalletBalancesQuerySchema = z.object({
  walletAddress: z.string().trim().min(1).optional(),
  wallets: zCsvString("wallets is required").optional(),
  tokens: zCsvString("tokens is required").optional(),
  chains: zCsvString("chains is required").optional(),
});

export const agentVenueStatusQuerySchema = z.object({
  walletAddress: z.string().trim().min(1).optional(),
  wallets: zCsvString("wallets is required").optional(),
  includeAllWallets: zOptionalBool.optional(),
  refresh: zOptionalBool.optional(),
});

export const agentOrdersQuerySchema = ordersQuerySchema.extend({
  mint: z.string().trim().min(1).optional(),
  inputMint: z.string().trim().min(1).optional(),
  outputMint: z.string().trim().min(1).optional(),
  openOnly: zOptionalBool.optional(),
});

export const agentReadinessQuerySchema = z.object({
  walletAddress: z.string().trim().min(1).optional(),
  wallets: zCsvString("wallets is required").optional(),
  venue: zVenue.optional(),
  marketId: z.string().trim().min(1).optional(),
  eventId: z.string().trim().min(1).optional(),
  refresh: zOptionalBool.optional(),
});

export const agentDepositTargetsQuerySchema = z.object({
  walletAddress: z.string().trim().min(1).optional(),
  wallets: zCsvString("wallets is required").optional(),
  venue: zVenue.optional(),
  asset: z.string().trim().min(1).optional(),
});
