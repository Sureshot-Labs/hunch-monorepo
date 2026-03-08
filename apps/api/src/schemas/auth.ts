import { z } from "zod";
import { zEthAddress, zRequiredString, zVenue } from "./common.js";

export const authPrivyBodySchema = z.object({
  accessToken: zRequiredString("accessToken is required"),
  referralCode: z.string().trim().min(1).max(32).optional(),
  inviteConfirmed: z.boolean().optional(),
});

export const inviteReasonSchema = z.enum([
  "missing_code",
  "invalid_code",
  "not_found",
  "self_referral",
]);

export const authErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export const authInviteRequiredResponseSchema = z.object({
  error: z.literal("invite_required"),
  reason: inviteReasonSchema,
  inviteOnly: z.literal(true),
  invitePolicyVersion: z.string(),
});

export const authPrivyTerminalErrorCodeSchema = z.enum([
  "account_recovery_required",
  "account_merge_required",
  "email_conflict",
  "wallet_conflict",
]);

export const authPrivyTerminalErrorResponseSchema = z.object({
  error: authPrivyTerminalErrorCodeSchema,
  message: z.string(),
});

export const authPrivySuccessResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string().optional(),
    username: z.string().optional(),
    displayName: z.string().optional(),
    avatarUrl: z.string().optional(),
    isAdmin: z.boolean(),
    isActive: z.boolean(),
    isVerified: z.boolean(),
    createdAt: z.string(),
    lastLoginAt: z.string().optional(),
  }),
  session: z.object({
    token: z.string(),
    expiresAt: z.string(),
    csrfToken: z.string(),
  }),
  walletAddresses: z.array(z.string()),
  primaryWalletAddress: z.string(),
  privyUserId: z.string(),
  invitePrompt: z.boolean().optional(),
  inviteReason: inviteReasonSchema.optional(),
  invitePolicyVersion: z.string().optional(),
});

export const venueCredentialsBodySchema = z.object({
  venue: zVenue,
  apiKey: zRequiredString("apiKey is required"),
  apiSecret: zRequiredString("apiSecret is required"),
  additionalData: z.unknown().optional(),
});

export const polymarketCredentialsBodySchema = z.object({
  apiKey: zRequiredString("apiKey is required"),
  apiSecret: zRequiredString("apiSecret is required"),
});

export const walletNonceBodySchema = z.object({
  walletAddress: zRequiredString("walletAddress is required"),
  walletType: z.string().optional(),
});

export const addWalletBodySchema = z.object({
  walletAddress: zRequiredString("walletAddress is required"),
  walletType: z.string().optional(),
  nonce: zRequiredString("nonce is required"),
  verificationSignature: zRequiredString("verificationSignature is required"),
});

export const removeWalletBodySchema = z.object({
  walletAddress: zRequiredString("walletAddress is required"),
});

export const updateWalletNameBodySchema = z.object({
  walletAddress: zRequiredString("walletAddress is required"),
  name: z.string().nullable(),
});

export const polymarketConnectBodySchema = z.object({
  signature: zRequiredString("signature is required"),
  timestamp: zRequiredString("timestamp is required"),
  nonce: z.number().int().nonnegative(),
  funderAddress: zEthAddress.optional(),
});

export const polymarketFunderBodySchema = z.object({
  funderAddress: zEthAddress.nullable(),
});

const relayerMethodSchema = z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]);
const relayerPathSchema = z.enum([
  "/nonce",
  "/relay-payload",
  "/transaction",
  "/transactions",
  "/submit",
  "/deployed",
]);

export const polymarketRelayerSignBodySchema = z.object({
  method: relayerMethodSchema,
  path: relayerPathSchema,
  body: z.unknown().optional(),
  timestamp: z.number().int().positive().optional(),
});

export const polymarketRelayerStatusResponseSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().optional(),
});
