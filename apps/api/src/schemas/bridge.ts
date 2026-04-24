import { z } from "zod";
import { zRequiredString } from "./common.js";

export const zBridgeDiscoveryProvider = z.literal("debridge");
export const zBridgeProvider = z.enum(["debridge", "across"]);
export const zBridgeRequestProvider = z.enum(["auto", "debridge", "across"]);
export const zBridgeSwapType = z.enum(["cross_chain", "same_chain"]);

const zChainId = z.preprocess(
  (value) => (value == null ? "" : String(value).trim()),
  z.string().min(1, "chainId is required"),
);

export const bridgeChainsQuerySchema = z.object({
  provider: zBridgeDiscoveryProvider.default("debridge"),
});

export const bridgeTokensQuerySchema = z.object({
  provider: zBridgeDiscoveryProvider.default("debridge"),
  chainId: zChainId,
  search: z.string().optional(),
  limit: z
    .preprocess(
      (value) =>
        value == null || value === "" ? undefined : Number(value),
      z.number().int().min(1).max(1000),
    )
    .optional(),
});

const zOptionalBool = z.preprocess((value) => {
  if (value == null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}, z.boolean());

export const bridgeQuoteQuerySchema = z.object({
  provider: zBridgeRequestProvider.default("debridge"),
  swapType: zBridgeSwapType.optional(),
  srcChainId: zChainId,
  dstChainId: zChainId,
  srcToken: zRequiredString("srcToken is required"),
  dstToken: zRequiredString("dstToken is required"),
  amountIn: zRequiredString("amountIn is required"),
  senderAddress: z.string().optional(),
  recipientAddress: z.string().optional(),
  dstChainTokenOutAmount: z.string().optional(),
  slippage: z.coerce.number().min(0).max(100).optional(),
  additionalTakerRewardBps: z.coerce.number().int().min(0).optional(),
  referralCode: z.coerce.number().int().min(0).optional(),
  affiliateFeePercent: z.coerce.number().min(0).max(100).optional(),
  affiliateFeeRecipient: z.string().optional(),
  deBridgeApp: z.string().optional(),
  prependOperatingExpenses: zOptionalBool.optional(),
  srcChainOrderAuthorityAddress: z.string().optional(),
  srcChainRefundAddress: z.string().optional(),
  dstChainOrderAuthorityAddress: z.string().optional(),
});

export const bridgeOrderBodySchema = bridgeQuoteQuerySchema.extend({
  provider: zBridgeRequestProvider.default("debridge"),
});

export const bridgeStatusQuerySchema = z.object({
  provider: zBridgeProvider.default("debridge"),
  swapType: zBridgeSwapType.optional(),
  chainId: zChainId.optional(),
  orderId: z.string().optional(),
  txHash: z.string().optional(),
});

export const bridgeSubmitBodySchema = z.object({
  provider: zBridgeProvider.default("debridge"),
  swapType: zBridgeSwapType.optional(),
  bridgeOrderId: z.string().nullable().optional(),
  orderId: z.string().nullable().optional(),
  txHash: zRequiredString("txHash is required"),
  txChain: z.enum(["src", "dst"]).optional(),
  status: z.string().optional(),
});

export const bridgeOrdersQuerySchema = z.object({
  provider: zBridgeProvider.optional(),
  sync: zOptionalBool.optional(),
  syncLimit: z
    .preprocess(
      (value) =>
        value == null || value === "" ? undefined : Number(value),
      z.number().int().min(1).max(20),
    )
    .optional(),
  limit: z
    .preprocess(
      (value) =>
        value == null || value === "" ? undefined : Number(value),
      z.number().int().min(1).max(200),
    )
    .optional(),
  offset: z
    .preprocess(
      (value) =>
        value == null || value === "" ? undefined : Number(value),
      z.number().int().min(0).max(10_000),
    )
    .optional(),
});
