import { z } from "zod";
import {
  zEthAddress,
  zEthAddressRequired,
  zRequiredString,
  zVenue,
} from "./common.js";

export const authPrivyBodySchema = z.object({
  accessToken: zRequiredString("accessToken is required"),
  referralCode: z.string().trim().min(1).max(32).optional(),
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

export const addWalletBodySchema = z.object({
  walletAddress: zEthAddressRequired,
  walletType: z.string().optional(),
  verificationSignature: z.string().optional(),
});

export const removeWalletBodySchema = z.object({
  walletAddress: zRequiredString("walletAddress is required"),
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
