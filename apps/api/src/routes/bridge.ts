import type { FastifyPluginAsync } from "fastify";
import { ethers } from "ethers";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { fetchActiveDebridgeConfig } from "../repos/debridge-config.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchSolanaSignatureStatus } from "../services/solana-rpc.js";
import {
  buildBridgeNotification,
  createNotificationSafe,
} from "../services/notifications.js";
import {
  type BridgeOrderStatus,
  canonicalizeBridgeOrderStatus,
  getBridgeNotificationStatus,
  isTerminalBridgeOrderStatus,
} from "../services/bridge-status.js";
import {
  bridgeChainsQuerySchema,
  bridgeOrderBodySchema,
  bridgeOrdersQuerySchema,
  bridgeQuoteQuerySchema,
  bridgeStatusQuerySchema,
  bridgeSubmitBodySchema,
  bridgeTokensQuerySchema,
} from "../schemas/bridge.js";
import {
  acrossChainIdForHunch,
  BridgeRequestProvider,
  BridgeSwapType,
  HUNCH_SOLANA_CHAIN_ID,
  ResolvedBridgeProvider,
  buildAcrossSuggestedFeesQuery,
  buildAcrossSwapApprovalQuery,
  getAcrossExecutionError,
  getAcrossConfig,
  normalizeAcrossEvmToSolanaQuoteResponse,
  normalizeAcrossQuoteResponse,
  normalizeAcrossSolanaSourceQuoteResponse,
  normalizeAcrossStatusPayload,
  resolveAcrossAppFeeForRoute,
  resolveAcrossRoute,
} from "../services/across-bridge.js";
import {
  acrossRequest,
  extractAcrossErrorMessage,
  isAcrossFallbackableError,
} from "../services/across-client.js";
import {
  debridgeRequest,
  extractDebridgeErrorMessage,
} from "../services/debridge-client.js";

type DebridgeChain = {
  chainId: string;
  originalChainId: string | null;
  chainName: string | null;
};

type DebridgeToken = {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  logoURI: string | null;
  tags: unknown | null;
};

type DebridgeOrderInputs = {
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
  dstChainTokenOutAmount?: string;
  slippage?: number;
  additionalTakerRewardBps?: number;
  referralCode?: number;
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
  deBridgeApp?: string;
  prependOperatingExpenses?: boolean;
  srcChainOrderAuthorityAddress?: string;
  srcChainRefundAddress?: string;
  dstChainOrderAuthorityAddress?: string;
};

const SOLANA_CHAIN_ID = HUNCH_SOLANA_CHAIN_ID;
const ETHEREUM_CHAIN_ID = "1";
const OPTIMISM_CHAIN_ID = "10";
const BSC_CHAIN_ID = "56";
const POLYGON_CHAIN_ID = "137";
const ARBITRUM_CHAIN_ID = "42161";
const AVALANCHE_CHAIN_ID = "43114";
const LINEA_CHAIN_ID = "59144";
const BASE_CHAIN_ID = "8453";
const DEBRIDGE_CHAIN_ID_ALIASES: Record<string, string> = {
  "100000001": "245022934", // Neon
  "100000002": "100", // Gnosis
  "100000008": "32769", // Zilliqa
  "100000009": "747", // Flow
  "100000013": "1514", // Story
  "100000014": "146", // Sonic
  "100000017": "2741", // Abstract
  "100000019": "25", // Cronos
  "100000020": "80094", // Berachain
  "100000021": "60808", // Bob
  "100000022": "999", // HyperEVM
  "100000023": "5000", // Mantle
  "100000025": "50104", // Sophon
  "100000026": "728126428", // Tron
  "100000027": "1329", // Sei
  "100000028": "9745", // Plasma
  "100000029": "1776", // Injective
  "100000030": "143", // Monad
  "100000031": "4326", // MegaETH
};

type DebridgeSameChainInputs = {
  chainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
  slippage?: number;
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
  deBridgeApp?: string;
};

type AffiliateDefaults = {
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
};

function resolveDebridgeChainAlias(chainId: string): string {
  return DEBRIDGE_CHAIN_ID_ALIASES[chainId] ?? chainId;
}

function resolveEvmReceiptRpcConfig(
  chainId: string,
): { rpcUrl: string; timeoutMs: number } | null {
  const resolvedChainId = resolveDebridgeChainAlias(chainId);
  const overrideRpcUrl =
    env.evmRpcUrlsByChain[chainId] ?? env.evmRpcUrlsByChain[resolvedChainId];
  if (overrideRpcUrl) {
    return {
      rpcUrl: overrideRpcUrl,
      timeoutMs: env.evmRpcTimeoutMs,
    };
  }

  if (resolvedChainId === ETHEREUM_CHAIN_ID) {
    return {
      rpcUrl: env.ethereumRpcUrl,
      timeoutMs: env.ethereumRpcTimeoutMs,
    };
  }
  if (resolvedChainId === OPTIMISM_CHAIN_ID) {
    return {
      rpcUrl: env.optimismRpcUrl,
      timeoutMs: env.evmRpcTimeoutMs,
    };
  }
  if (resolvedChainId === BSC_CHAIN_ID) {
    return {
      rpcUrl: env.bscRpcUrl,
      timeoutMs: env.evmRpcTimeoutMs,
    };
  }
  if (resolvedChainId === POLYGON_CHAIN_ID) {
    return {
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
    };
  }
  if (resolvedChainId === ARBITRUM_CHAIN_ID) {
    return {
      rpcUrl: env.arbitrumRpcUrl,
      timeoutMs: env.arbitrumRpcTimeoutMs,
    };
  }
  if (resolvedChainId === AVALANCHE_CHAIN_ID) {
    return {
      rpcUrl: env.avalancheRpcUrl,
      timeoutMs: env.evmRpcTimeoutMs,
    };
  }
  if (resolvedChainId === LINEA_CHAIN_ID) {
    return {
      rpcUrl: env.lineaRpcUrl,
      timeoutMs: env.evmRpcTimeoutMs,
    };
  }
  if (resolvedChainId === BASE_CHAIN_ID) {
    return {
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
    };
  }

  return null;
}

const FALLBACK_TOKEN_META: Record<
  string,
  Record<string, { symbol: string; decimals: number; name?: string }>
> = {
  "137": {
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": {
      symbol: "USDC.e",
      decimals: 6,
      name: "USD Coin (PoS)",
    },
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": {
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    "0x0000000000000000000000000000000000000000": {
      symbol: "MATIC",
      decimals: 18,
      name: "Polygon",
    },
  },
  "8453": {
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": {
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    "0x0000000000000000000000000000000000000000": {
      symbol: "ETH",
      decimals: 18,
      name: "Ethereum",
    },
  },
  "7565164": {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
      symbol: "USDC",
      decimals: 6,
      name: "USD Coin",
    },
    So11111111111111111111111111111111111111112: {
      symbol: "SOL",
      decimals: 9,
      name: "Solana",
    },
  },
};

function getFallbackTokenMeta(chainId: string, address: string) {
  const chainMeta = FALLBACK_TOKEN_META[chainId];
  if (!chainMeta) return null;
  const lower = address.toLowerCase();
  for (const [key, value] of Object.entries(chainMeta)) {
    if (key.toLowerCase() === lower) return value;
  }
  return null;
}

function normalizeDebridgeChains(payload: unknown): DebridgeChain[] {
  if (!isRecord(payload) || !Array.isArray(payload.chains)) return [];
  return payload.chains
    .map((entry) => {
      if (!isRecord(entry)) return null;
      const chainId = entry.chainId ?? entry.id ?? null;
      if (chainId == null) return null;
      const originalChainId =
        entry.originalChainId == null ? null : String(entry.originalChainId);
      const chainName =
        typeof entry.chainName === "string" ? entry.chainName : null;
      return {
        chainId: String(chainId),
        originalChainId,
        chainName,
      };
    })
    .filter((entry): entry is DebridgeChain => Boolean(entry));
}

function normalizeDebridgeTokens(payload: unknown): DebridgeToken[] {
  if (!isRecord(payload) || !isRecord(payload.tokens)) return [];
  const tokens: DebridgeToken[] = [];
  for (const [key, value] of Object.entries(payload.tokens)) {
    if (!isRecord(value)) continue;
    const addressRaw =
      typeof value.address === "string" && value.address.trim().length > 0
        ? value.address
        : key;
    if (!addressRaw || !addressRaw.trim()) continue;
    const symbol =
      typeof value.symbol === "string" ? value.symbol.trim() : null;
    const name = typeof value.name === "string" ? value.name.trim() : null;
    const decimalsRaw = value.decimals;
    const decimals =
      typeof decimalsRaw === "number"
        ? decimalsRaw
        : typeof decimalsRaw === "string" && decimalsRaw.trim().length
          ? Number(decimalsRaw)
          : null;
    const logoURI =
      typeof value.logoURI === "string" ? value.logoURI.trim() : null;
    const tags = value.tags ?? null;
    tokens.push({
      address: addressRaw,
      symbol: symbol && symbol.length ? symbol : null,
      name: name && name.length ? name : null,
      decimals: Number.isFinite(decimals ?? NaN) ? decimals : null,
      logoURI: logoURI && logoURI.length ? logoURI : null,
      tags,
    });
  }
  return tokens;
}

function parseAffiliateRecipientMap(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const map: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value !== "string") continue;
        const recipient = value.trim();
        if (!recipient) continue;
        map[String(key).trim()] = recipient;
      }
      return map;
    }
  } catch {
    // fall through to text parsing
  }

  const map: Record<string, string> = {};
  for (const entry of trimmed.split(",")) {
    const [chainId, recipient] = entry.split(":");
    if (!chainId || !recipient) continue;
    const chainKey = chainId.trim();
    const address = recipient.trim();
    if (!chainKey || !address) continue;
    map[chainKey] = address;
  }
  return map;
}

type DebridgeConfig = {
  dlnBase: string;
  statsBase: string;
  affiliateFeePercent: number;
  affiliateFeeRecipients: Record<string, string>;
  referralCode: number;
};

const DEBRIDGE_CONFIG_TTL_MS = 30_000;
let cachedDebridgeConfig: { value: DebridgeConfig; expiresAt: number } | null =
  null;
let debridgeConfigInflight: Promise<DebridgeConfig> | null = null;

async function getDebridgeConfig(): Promise<DebridgeConfig> {
  const now = Date.now();
  if (cachedDebridgeConfig && cachedDebridgeConfig.expiresAt > now) {
    return cachedDebridgeConfig.value;
  }
  if (debridgeConfigInflight) return debridgeConfigInflight;

  const load = async () => {
    const row = await fetchActiveDebridgeConfig(pool);
    const config: DebridgeConfig = {
      dlnBase: row?.dln_base?.trim() || env.debridgeDlnBase,
      statsBase: row?.stats_base?.trim() || env.debridgeStatsBase,
      affiliateFeePercent:
        row?.affiliate_fee_percent != null
          ? Number(row.affiliate_fee_percent)
          : env.debridgeAffiliateFeePercent,
      affiliateFeeRecipients:
        row?.affiliate_fee_recipients ??
        parseAffiliateRecipientMap(env.debridgeAffiliateFeeRecipients || ""),
      referralCode:
        row?.referral_code != null
          ? Number(row.referral_code)
          : env.debridgeReferralCode,
    };
    cachedDebridgeConfig = {
      value: config,
      expiresAt: now + DEBRIDGE_CONFIG_TTL_MS,
    };
    return config;
  };

  debridgeConfigInflight = load().finally(() => {
    debridgeConfigInflight = null;
  });
  return debridgeConfigInflight;
}

function resolveAffiliateDefaults(inputs: {
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  config: DebridgeConfig;
  affiliateFeePercent?: number;
  affiliateFeeRecipient?: string;
}): AffiliateDefaults {
  // Solana deBridge routes currently fail when we inject our generic wallet-level
  // affiliate recipient. Until we derive the exact Solana referral account shape
  // expected by deBridge, fail open by omitting default affiliate params there.
  if (inputs.srcChainId === SOLANA_CHAIN_ID) {
    return {};
  }

  if (
    inputs.affiliateFeePercent != null ||
    (inputs.affiliateFeeRecipient &&
      inputs.affiliateFeeRecipient.trim().length > 0)
  ) {
    return {
      affiliateFeePercent: inputs.affiliateFeePercent,
      affiliateFeeRecipient: inputs.affiliateFeeRecipient?.trim() || undefined,
    };
  }

  const percent = inputs.config.affiliateFeePercent;
  if (!percent || percent <= 0) return {};

  const recipients = inputs.config.affiliateFeeRecipients;
  const chainId = inputs.srcChainId;
  const recipient = recipients[chainId];
  if (!recipient) return {};
  if (chainId !== "7565164" && !ethers.isAddress(recipient)) return {};
  if (chainId === "7565164" && recipient.startsWith("0x")) return {};

  return {
    affiliateFeePercent: percent,
    affiliateFeeRecipient: recipient,
  };
}

function resolveReferralCode(
  config: DebridgeConfig,
  referralCode?: number,
): number | undefined {
  if (referralCode != null && referralCode > 0) return referralCode;
  return config.referralCode > 0 ? config.referralCode : undefined;
}

function buildDebridgeCreateTxQuery(inputs: DebridgeOrderInputs) {
  const senderAddress = inputs.senderAddress;
  const recipientAddress = inputs.recipientAddress;

  const query: Record<string, string | number | boolean> = {
    srcChainId: inputs.srcChainId,
    srcChainTokenIn: inputs.srcToken,
    srcChainTokenInAmount: inputs.amountIn,
    dstChainId: inputs.dstChainId,
    dstChainTokenOut: inputs.dstToken,
    dstChainTokenOutRecipient: recipientAddress,
    senderAddress,
    dstChainTokenOutAmount: inputs.dstChainTokenOutAmount || "auto",
    prependOperatingExpenses: inputs.prependOperatingExpenses ?? true,
    srcChainOrderAuthorityAddress:
      inputs.srcChainOrderAuthorityAddress || senderAddress,
    srcChainRefundAddress: inputs.srcChainRefundAddress || senderAddress,
    dstChainOrderAuthorityAddress:
      inputs.dstChainOrderAuthorityAddress || recipientAddress,
  };

  if (inputs.slippage != null) query.slippage = inputs.slippage;
  if (inputs.additionalTakerRewardBps != null) {
    query.additionalTakerRewardBps = inputs.additionalTakerRewardBps;
  }
  if (inputs.referralCode != null) query.referralCode = inputs.referralCode;

  if (
    inputs.affiliateFeePercent != null &&
    inputs.affiliateFeeRecipient &&
    inputs.affiliateFeeRecipient.trim().length > 0
  ) {
    query.affiliateFeePercent = inputs.affiliateFeePercent;
    query.affiliateFeeRecipient = inputs.affiliateFeeRecipient.trim();
  }

  if (inputs.deBridgeApp && inputs.deBridgeApp.trim().length > 0) {
    query.deBridgeApp = inputs.deBridgeApp.trim();
  }

  return query;
}

function buildDebridgeSameChainQuery(inputs: DebridgeSameChainInputs) {
  const query: Record<string, string | number | boolean> = {
    chainId: inputs.chainId,
    tokenIn: inputs.srcToken,
    tokenInAmount: inputs.amountIn,
    tokenOut: inputs.dstToken,
    tokenOutRecipient: inputs.recipientAddress,
    senderAddress: inputs.senderAddress,
  };

  if (inputs.slippage != null) query.slippage = inputs.slippage;
  if (
    inputs.affiliateFeePercent != null &&
    inputs.affiliateFeeRecipient &&
    inputs.affiliateFeeRecipient.trim().length > 0
  ) {
    query.affiliateFeePercent = inputs.affiliateFeePercent;
    query.affiliateFeeRecipient = inputs.affiliateFeeRecipient.trim();
  }
  if (inputs.deBridgeApp && inputs.deBridgeApp.trim().length > 0) {
    query.deBridgeApp = inputs.deBridgeApp.trim();
  }

  return query;
}

function readStringField(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  return typeof value === "string" ? value : null;
}

function decodeSerializedSolanaTransaction(payload: string): Buffer | null {
  if (payload.startsWith("0x")) {
    const hex = payload.slice(2);
    if (!hex.length || hex.length % 2 !== 0) return null;
    return Buffer.from(hex, "hex");
  }
  try {
    return Buffer.from(payload, "base64");
  } catch {
    return null;
  }
}

function getSolanaTransactionRequiredSigners(
  payload: unknown,
): string[] | null {
  if (!isRecord(payload) || !isRecord(payload.tx)) return null;
  const txData = readStringField(payload.tx, "data");
  if (!txData) return null;
  const raw = decodeSerializedSolanaTransaction(txData);
  if (!raw) return null;

  try {
    const tx = VersionedTransaction.deserialize(raw);
    return tx.message.staticAccountKeys
      .slice(0, tx.message.header.numRequiredSignatures)
      .map((key) => key.toBase58());
  } catch {
    return null;
  }
}

function validateDebridgeSameChainSolanaSigner(inputs: {
  swapType: BridgeSwapType;
  chainId: string;
  senderAddress: string;
  payload: unknown;
}): { message: string; requiredSigners: string[] } | null {
  if (inputs.swapType !== "same_chain" || inputs.chainId !== SOLANA_CHAIN_ID) {
    return null;
  }

  const requiredSigners = getSolanaTransactionRequiredSigners(inputs.payload);
  if (!requiredSigners || requiredSigners.includes(inputs.senderAddress)) {
    return null;
  }

  return {
    message:
      `deBridge returned a Solana transaction that requires ${requiredSigners.join(", ") || "no wallet"} ` +
      `to sign, but the selected source wallet is ${inputs.senderAddress}. ` +
      "This deBridge same-chain Solana route is not signable by the selected source wallet.",
    requiredSigners,
  };
}

async function fetchEvmReceiptStatus(inputs: {
  chainId: string;
  txHash: string;
}): Promise<{ status: "submitted" | "fulfilled" | "failed" } | null> {
  const rpcConfig = resolveEvmReceiptRpcConfig(inputs.chainId);
  if (!rpcConfig) return null;
  try {
    const provider = new ethers.JsonRpcProvider(rpcConfig.rpcUrl);
    const receipt = await provider.getTransactionReceipt(inputs.txHash);
    if (!receipt) return { status: "submitted" };
    if (receipt.status === 1) return { status: "fulfilled" };
    if (receipt.status === 0) return { status: "failed" };
    return { status: "submitted" };
  } catch {
    return null;
  }
}

async function fetchSolanaReceiptStatus(inputs: {
  chainId: string;
  txHash: string;
}): Promise<{ status: "submitted" | "fulfilled" | "failed" } | null> {
  if (inputs.chainId !== "7565164") return null;
  const result = await fetchSolanaSignatureStatus({
    rpcUrls: env.solanaRpcUrls,
    signature: inputs.txHash,
    timeoutMs: 10_000,
  });
  return result;
}

async function fetchSourceReceiptStatus(inputs: {
  chainId: string;
  txHash: string;
}): Promise<{ status: "submitted" | "fulfilled" | "failed" } | null> {
  return (
    (await fetchEvmReceiptStatus(inputs)) ??
    (await fetchSolanaReceiptStatus(inputs))
  );
}

async function fetchCrossChainSourceFailureStatus(inputs: {
  chainId: string | null | undefined;
  txHash: string | null | undefined;
}): Promise<"failed" | null> {
  const chainId = inputs.chainId?.trim();
  const txHash = inputs.txHash?.trim();
  if (!chainId || !txHash) return null;
  const receipt = await fetchSourceReceiptStatus({ chainId, txHash });
  if (!receipt?.status) return null;
  const canonicalStatus = canonicalizeBridgeOrderStatus(receipt.status);
  return canonicalStatus === "failed" ? canonicalStatus : null;
}

function resolveBridgeAddresses(
  senderAddress: string | undefined,
  recipientAddress: string | undefined,
  fallback: string | undefined,
): { senderAddress: string; recipientAddress: string } | null {
  const sender = senderAddress?.trim() || fallback?.trim() || "";
  const recipient = recipientAddress?.trim() || fallback?.trim() || "";
  if (!sender || !recipient) return null;
  return { senderAddress: sender, recipientAddress: recipient };
}

function normalizeWalletLookupKey(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

function isValidAddressForChain(chainId: string, address: string): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;
  if (chainId === SOLANA_CHAIN_ID) {
    try {
      new PublicKey(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return ethers.isAddress(trimmed);
}

function validateBridgeAddressInputs(inputs: {
  srcChainId: string;
  dstChainId: string;
  senderAddress: string;
  recipientAddress: string;
  srcChainOrderAuthorityAddress?: string;
  srcChainRefundAddress?: string;
  dstChainOrderAuthorityAddress?: string;
}): string | null {
  if (!isValidAddressForChain(inputs.srcChainId, inputs.senderAddress)) {
    return `senderAddress is invalid for source chain ${inputs.srcChainId}`;
  }
  if (!isValidAddressForChain(inputs.dstChainId, inputs.recipientAddress)) {
    return `recipientAddress is invalid for destination chain ${inputs.dstChainId}`;
  }
  if (
    inputs.srcChainOrderAuthorityAddress &&
    !isValidAddressForChain(
      inputs.srcChainId,
      inputs.srcChainOrderAuthorityAddress,
    )
  ) {
    return `srcChainOrderAuthorityAddress is invalid for source chain ${inputs.srcChainId}`;
  }
  if (
    inputs.srcChainRefundAddress &&
    !isValidAddressForChain(inputs.srcChainId, inputs.srcChainRefundAddress)
  ) {
    return `srcChainRefundAddress is invalid for source chain ${inputs.srcChainId}`;
  }
  if (
    inputs.dstChainOrderAuthorityAddress &&
    !isValidAddressForChain(
      inputs.dstChainId,
      inputs.dstChainOrderAuthorityAddress,
    )
  ) {
    return `dstChainOrderAuthorityAddress is invalid for destination chain ${inputs.dstChainId}`;
  }
  return null;
}

async function isAuthorizedBridgeSender(
  userId: string,
  senderAddress: string,
): Promise<boolean> {
  const senderKey = normalizeWalletLookupKey(senderAddress);
  if (!senderKey) return false;

  const linkedWallet = await AuthService.getUserWalletByAddress(
    userId,
    senderAddress,
  );
  if (linkedWallet) return true;
  if (!ethers.isAddress(senderAddress)) return false;

  const linkedWallets = await AuthService.getUserWallets(userId);
  for (const wallet of linkedWallets) {
    const isEvmWallet =
      wallet.walletType === "ethereum" ||
      ethers.isAddress(wallet.walletAddress);
    if (!isEvmWallet) continue;
    const creds = await AuthService.getVenueCredentialsInfo(
      userId,
      "polymarket",
      wallet.walletAddress,
    );
    const funderKey = creds?.funderAddress
      ? normalizeWalletLookupKey(creds.funderAddress)
      : "";
    if (funderKey && funderKey === senderKey) {
      return true;
    }
  }
  return false;
}

function resolveSwapType(
  srcChainId: string,
  dstChainId: string,
  swapType?: BridgeSwapType | null,
): BridgeSwapType | null {
  if (swapType) {
    if (swapType === "same_chain" && srcChainId !== dstChainId) return null;
    if (swapType === "cross_chain" && srcChainId === dstChainId) return null;
    return swapType;
  }
  return srcChainId === dstChainId ? "same_chain" : "cross_chain";
}

function isAcrossFallbackEligible(inputs: {
  requestedProvider: BridgeRequestProvider;
  resolvedProvider: ResolvedBridgeProvider;
  routeMode?: "swap_api" | "evm_to_solana" | "solana_source";
  srcChainId: string;
  dstChainId: string;
  status?: number;
  payload?: unknown;
}): boolean {
  if (
    inputs.requestedProvider !== "auto" ||
    inputs.resolvedProvider !== "across"
  ) {
    return false;
  }
  // Solana Across routes avoid deBridge's source-native fixed fee. Falling back
  // silently would make the user approve a materially different route/cost.
  if (
    inputs.srcChainId === HUNCH_SOLANA_CHAIN_ID ||
    inputs.dstChainId === HUNCH_SOLANA_CHAIN_ID
  ) {
    return false;
  }
  if (inputs.status == null) return true;
  return isAcrossFallbackableError({
    status: inputs.status,
    payload: inputs.payload,
  });
}

type AcrossBridgePayloadInputs = {
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
  slippage?: number;
  requireExecutable: boolean;
};

type AcrossSwapDiscoveryCache = {
  ok: true;
  expiresAt: number;
  chains: Set<string>;
  tokens: Set<string>;
};

let acrossSwapDiscoveryCache: AcrossSwapDiscoveryCache | null = null;
const ACROSS_SWAP_DISCOVERY_TTL_MS = 5 * 60 * 1000;

async function getAcrossSwapDiscovery(
  config: ReturnType<typeof getAcrossConfig>,
) {
  const now = Date.now();
  if (acrossSwapDiscoveryCache && acrossSwapDiscoveryCache.expiresAt > now) {
    return acrossSwapDiscoveryCache;
  }

  const [chainsRes, tokensRes] = await Promise.all([
    acrossRequest({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      integratorId: config.integratorId,
      timeoutMs: config.timeoutMs,
      method: "GET",
      requestPath: "/swap/chains",
    }),
    acrossRequest({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      integratorId: config.integratorId,
      timeoutMs: config.timeoutMs,
      method: "GET",
      requestPath: "/swap/tokens",
    }),
  ]);

  if (!chainsRes.ok) {
    return {
      ok: false as const,
      status: chainsRes.status,
      payload: chainsRes.payload,
      message:
        extractAcrossErrorMessage(chainsRes.payload) ||
        "Across chain discovery failed",
    };
  }
  if (!tokensRes.ok) {
    return {
      ok: false as const,
      status: tokensRes.status,
      payload: tokensRes.payload,
      message:
        extractAcrossErrorMessage(tokensRes.payload) ||
        "Across token discovery failed",
    };
  }

  const chains = new Set<string>();
  for (const entry of Array.isArray(chainsRes.payload)
    ? chainsRes.payload
    : []) {
    if (!isRecord(entry)) continue;
    const chainId =
      typeof entry.chainId === "number" || typeof entry.chainId === "string"
        ? String(entry.chainId)
        : "";
    if (chainId) chains.add(chainId);
  }

  const tokens = new Set<string>();
  for (const entry of Array.isArray(tokensRes.payload)
    ? tokensRes.payload
    : []) {
    if (!isRecord(entry)) continue;
    const chainId =
      typeof entry.chainId === "number" || typeof entry.chainId === "string"
        ? String(entry.chainId)
        : "";
    const address =
      typeof entry.address === "string"
        ? entry.address.trim().toLowerCase()
        : "";
    if (chainId && address) tokens.add(`${chainId}:${address}`);
  }

  acrossSwapDiscoveryCache = {
    ok: true,
    expiresAt: now + ACROSS_SWAP_DISCOVERY_TTL_MS,
    chains,
    tokens,
  };
  return acrossSwapDiscoveryCache;
}

async function validateAcrossSwapApiSupport(inputs: {
  config: ReturnType<typeof getAcrossConfig>;
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
}): Promise<
  | { ok: true }
  | { ok: false; status: number; payload: unknown; message: string }
> {
  const discovery = await getAcrossSwapDiscovery(inputs.config);
  if (!discovery.ok) return discovery;

  const srcAcrossChain = acrossChainIdForHunch(inputs.srcChainId);
  const dstAcrossChain = acrossChainIdForHunch(inputs.dstChainId);
  if (
    !discovery.chains.has(srcAcrossChain) ||
    !discovery.chains.has(dstAcrossChain)
  ) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: "Across Swap API does not support this chain pair",
        code: "across_swap_chain_unsupported",
      },
      message: "Across Swap API does not support this chain pair",
    };
  }

  const srcTokenKey = `${srcAcrossChain}:${inputs.srcToken.toLowerCase()}`;
  const dstTokenKey = `${dstAcrossChain}:${inputs.dstToken.toLowerCase()}`;
  if (
    !discovery.tokens.has(srcTokenKey) ||
    !discovery.tokens.has(dstTokenKey)
  ) {
    return {
      ok: false,
      status: 400,
      payload: {
        error: "Across Swap API does not support this token pair",
        code: "across_swap_token_unsupported",
      },
      message: "Across Swap API does not support this token pair",
    };
  }

  return { ok: true };
}

async function fetchAcrossBridgePayload(
  inputs: AcrossBridgePayloadInputs,
): Promise<
  | { ok: true; payload: Record<string, unknown>; providerPayload: unknown }
  | { ok: false; status: number; payload: unknown; message: string }
> {
  const route = resolveAcrossRoute(inputs);
  if (!route.ok) {
    return {
      ok: false,
      status: 400,
      payload: { error: route.message, code: route.code },
      message: route.message,
    };
  }

  const appFee = resolveAcrossAppFeeForRoute(
    route.mode,
    inputs.srcChainId,
    inputs.dstChainId,
  );
  if (!appFee.ok) {
    return {
      ok: false,
      status: 500,
      payload: { error: appFee.error, code: "across_app_fee_invalid" },
      message: appFee.error,
    };
  }

  const acrossConfig = getAcrossConfig();
  if (route.mode === "swap_api") {
    const support = await validateAcrossSwapApiSupport({
      config: acrossConfig,
      srcChainId: inputs.srcChainId,
      dstChainId: inputs.dstChainId,
      srcToken: inputs.srcToken,
      dstToken: inputs.dstToken,
    });
    if (!support.ok) return support;
  }

  const request =
    route.mode === "swap_api"
      ? {
          requestPath: "/swap/approval",
          query: buildAcrossSwapApprovalQuery({
            srcChainId: inputs.srcChainId,
            dstChainId: inputs.dstChainId,
            srcToken: inputs.srcToken,
            dstToken: inputs.dstToken,
            amountIn: inputs.amountIn,
            senderAddress: inputs.senderAddress,
            recipientAddress: inputs.recipientAddress,
            slippage: inputs.slippage,
          }),
        }
      : {
          requestPath: "/suggested-fees",
          query: buildAcrossSuggestedFeesQuery({
            srcChainId: inputs.srcChainId,
            dstChainId: inputs.dstChainId,
            srcToken: inputs.srcToken,
            dstToken: inputs.dstToken,
            amountIn: inputs.amountIn,
            recipientAddress: inputs.recipientAddress,
          }),
        };

  const upstream = await acrossRequest({
    baseUrl: acrossConfig.baseUrl,
    apiKey: acrossConfig.apiKey,
    integratorId: acrossConfig.integratorId,
    timeoutMs: acrossConfig.timeoutMs,
    method: "GET",
    requestPath: request.requestPath,
    query: request.query,
  });

  if (!upstream.ok) {
    const reason = extractAcrossErrorMessage(upstream.payload);
    return {
      ok: false,
      status: upstream.status,
      payload: upstream.payload,
      message: reason || "Across quote failed",
    };
  }

  try {
    const payload =
      route.mode === "swap_api"
        ? normalizeAcrossQuoteResponse({
            payload: upstream.payload,
            swapType: inputs.swapType,
            srcChainId: inputs.srcChainId,
            dstChainId: inputs.dstChainId,
            srcToken: inputs.srcToken,
            dstToken: inputs.dstToken,
          })
        : route.mode === "evm_to_solana"
          ? normalizeAcrossEvmToSolanaQuoteResponse({
              payload: upstream.payload,
              swapType: inputs.swapType,
              srcChainId: inputs.srcChainId,
              dstChainId: inputs.dstChainId,
              srcToken: inputs.srcToken,
              dstToken: inputs.dstToken,
              amountIn: inputs.amountIn,
              senderAddress: inputs.senderAddress,
              recipientAddress: inputs.recipientAddress,
            })
          : await normalizeAcrossSolanaSourceQuoteResponse({
              payload: upstream.payload,
              swapType: inputs.swapType,
              srcChainId: inputs.srcChainId,
              dstChainId: inputs.dstChainId,
              srcToken: inputs.srcToken,
              dstToken: inputs.dstToken,
              amountIn: inputs.amountIn,
              senderAddress: inputs.senderAddress,
              recipientAddress: inputs.recipientAddress,
              integratorId: acrossConfig.integratorId,
            });
    const executionError = inputs.requireExecutable
      ? getAcrossExecutionError(payload)
      : null;
    if (executionError) {
      return {
        ok: false,
        status: 502,
        payload: { error: executionError, code: "across_missing_tx" },
        message: executionError,
      };
    }
    return { ok: true, payload, providerPayload: upstream.payload };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Across response normalization failed";
    return {
      ok: false,
      status: 502,
      payload: { error: message, code: "across_normalization_failed" },
      message,
    };
  }
}

export const bridgeRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const notifyBridgeStatusByTx = async (
    provider: ResolvedBridgeProvider,
    txHash: string,
    statusRaw: string | null,
  ) => {
    const status = getBridgeNotificationStatus(statusRaw);
    if (!status) return;

    const { rows } = await pool.query<{
      user_id: string;
      src_chain_id: string;
      dst_chain_id: string;
      order_id: string | null;
    }>(
      `
        select user_id, src_chain_id, dst_chain_id, order_id
        from bridge_orders
        where provider = $1
          and tx_hash_src = $2
        order by updated_at desc
        limit 1
      `,
      [provider, txHash],
    );

    const row = rows[0];
    if (!row) return;
    void createNotificationSafe(
      pool,
      buildBridgeNotification({
        userId: row.user_id,
        provider,
        status,
        srcChainId: row.src_chain_id,
        dstChainId: row.dst_chain_id,
        bridgeOrderId: row.order_id ?? null,
        txHash,
      }),
      app.log,
    );
  };

  const notifyBridgeStatusByOrder = async (
    provider: ResolvedBridgeProvider,
    orderId: string,
    statusRaw: string | null,
  ) => {
    const status = getBridgeNotificationStatus(statusRaw);
    if (!status) return;

    const { rows } = await pool.query<{
      user_id: string;
      src_chain_id: string;
      dst_chain_id: string;
      tx_hash_src: string | null;
    }>(
      `
        select user_id, src_chain_id, dst_chain_id, tx_hash_src
        from bridge_orders
        where provider = $1
          and order_id = $2
        order by updated_at desc
        limit 1
      `,
      [provider, orderId],
    );

    const row = rows[0];
    if (!row) return;
    void createNotificationSafe(
      pool,
      buildBridgeNotification({
        userId: row.user_id,
        provider,
        status,
        srcChainId: row.src_chain_id,
        dstChainId: row.dst_chain_id,
        bridgeOrderId: orderId,
        txHash: row.tx_hash_src ?? null,
      }),
      app.log,
    );
  };

  const syncAcrossBridgeOrderByTx = async (inputs: {
    txHash: string;
    chainId?: string | null;
    storedStatus?: string | null;
    orderId?: string | null;
  }): Promise<{
    status: BridgeOrderStatus;
    payload: Record<string, unknown>;
    source: "across" | "indexer_pending" | "rpc";
  }> => {
    const acrossConfig = getAcrossConfig();
    const txHash = inputs.txHash.trim();
    const upstream = await acrossRequest({
      baseUrl: acrossConfig.baseUrl,
      apiKey: acrossConfig.apiKey,
      integratorId: acrossConfig.integratorId,
      includeIntegratorId: false,
      timeoutMs: acrossConfig.timeoutMs,
      method: "GET",
      requestPath: "/deposit/status",
      query: { depositTxnRef: txHash },
    });

    const persistAcrossStatus = async (
      status: BridgeOrderStatus,
      payload: Record<string, unknown>,
    ) => {
      const readPayloadString = (key: string): string | null => {
        const value = payload[key];
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        return trimmed ? trimmed : null;
      };
      const fillTxHash =
        readPayloadString("fillTxnRef") ??
        readPayloadString("fillTxHash") ??
        readPayloadString("fillTx") ??
        readPayloadString("fillTxnHash");
      const refundTxHash =
        readPayloadString("depositRefundTxnRef") ??
        readPayloadString("depositRefundTxHash") ??
        readPayloadString("refundTxHash") ??
        readPayloadString("refundTxnRef");
      const depositId = readPayloadString("depositId");

      await pool.query(
        `
          update bridge_orders
          set status = $1::text,
              tx_hash_dst = coalesce($2::text, tx_hash_dst),
              metadata = jsonb_set(
                coalesce(metadata, '{}'::jsonb),
                '{across}',
                coalesce(metadata->'across', '{}'::jsonb)
                  || jsonb_strip_nulls(jsonb_build_object(
                    'statusPayload', $3::jsonb,
                    'fillTxnRef', $2::text,
                    'depositRefundTxnRef', $4::text,
                    'depositId', $5::text,
                    'lastStatusSyncedAt', to_jsonb(now())
                  )),
                true
              ),
              updated_at = now()
          where provider = 'across'
            and tx_hash_src = $6::text
        `,
        [
          status,
          fillTxHash,
          JSON.stringify(payload),
          refundTxHash,
          depositId,
          txHash,
        ],
      );

      if (isTerminalBridgeOrderStatus(status)) {
        await notifyBridgeStatusByTx("across", txHash, status);
      }
    };

    if (!upstream.ok) {
      const chainId = inputs.chainId?.trim();
      const sourceReceipt = chainId
        ? await fetchSourceReceiptStatus({ chainId, txHash })
        : null;
      const sourceStatus = sourceReceipt?.status
        ? canonicalizeBridgeOrderStatus(sourceReceipt.status)
        : null;
      if (sourceStatus === "failed") {
        const payload = { status: "failed", source: "rpc" };
        await persistAcrossStatus("failed", payload);
        return { status: "failed", payload, source: "rpc" };
      }

      const pendingStatus = canonicalizeBridgeOrderStatus(
        inputs.storedStatus,
        "submitted",
      );
      const payload = {
        status: pendingStatus,
        source:
          sourceStatus === "fulfilled" ? "source_confirmed" : "indexer_pending",
        sourceTxStatus: sourceStatus,
        error: extractAcrossErrorMessage(upstream.payload),
      };
      await pool.query(
        `
          update bridge_orders
          set metadata = jsonb_set(
                coalesce(metadata, '{}'::jsonb),
                '{across}',
                coalesce(metadata->'across', '{}'::jsonb)
                  || jsonb_strip_nulls(jsonb_build_object(
                    'statusPayload', $1::jsonb,
                    'lastStatusSyncedAt', to_jsonb(now())
                  )),
                true
              ),
              updated_at = now()
          where provider = 'across'
            and tx_hash_src = $2::text
        `,
        [JSON.stringify(payload), txHash],
      );
      return { status: pendingStatus, payload, source: "indexer_pending" };
    }

    const payload = normalizeAcrossStatusPayload(upstream.payload);
    const status = canonicalizeBridgeOrderStatus(
      typeof payload.status === "string" ? payload.status : null,
      "submitted",
    );
    await persistAcrossStatus(status, payload);
    return { status, payload, source: "across" };
  };

  z.get(
    "/bridge/chains",
    { schema: { querystring: bridgeChainsQuerySchema } },
    async (request, reply) => {
      const { provider } = request.query;
      // Discovery still comes from the existing deBridge-backed cache/endpoints.
      if (provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }

      const debridgeConfig = await getDebridgeConfig();
      const upstream = await debridgeRequest({
        baseUrl: debridgeConfig.dlnBase,
        timeoutMs: 10_000,
        method: "GET",
        requestPath: "/supported-chains-info",
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "deBridge chains fetch failed",
          status: upstream.status,
          message: extractDebridgeErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      const chains = normalizeDebridgeChains(upstream.payload);
      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        provider,
        chains,
      });
    },
  );

  z.get(
    "/bridge/quote",
    { schema: { querystring: bridgeQuoteQuerySchema } },
    async (request, reply) => {
      const query = request.query;
      const swapType = resolveSwapType(
        query.srcChainId,
        query.dstChainId,
        query.swapType ?? null,
      );
      if (!swapType) {
        reply.code(400);
        return reply.send({
          error: "swapType does not match srcChainId/dstChainId",
        });
      }

      const addresses = resolveBridgeAddresses(
        query.senderAddress,
        query.recipientAddress,
        undefined,
      );
      if (!addresses) {
        reply.code(400);
        return reply.send({
          error: "senderAddress and recipientAddress are required",
        });
      }
      const addressValidationError = validateBridgeAddressInputs({
        srcChainId: query.srcChainId,
        dstChainId: query.dstChainId,
        senderAddress: addresses.senderAddress,
        recipientAddress: addresses.recipientAddress,
        srcChainOrderAuthorityAddress: query.srcChainOrderAuthorityAddress,
        srcChainRefundAddress: query.srcChainRefundAddress,
        dstChainOrderAuthorityAddress: query.dstChainOrderAuthorityAddress,
      });
      if (addressValidationError) {
        reply.code(400);
        return reply.send({ error: addressValidationError });
      }

      const acrossRoute = resolveAcrossRoute({
        swapType,
        srcChainId: query.srcChainId,
        dstChainId: query.dstChainId,
        srcToken: query.srcToken,
        dstToken: query.dstToken,
      });
      const resolvedProvider: ResolvedBridgeProvider =
        query.provider === "debridge"
          ? "debridge"
          : query.provider === "across"
            ? "across"
            : acrossRoute.ok
              ? "across"
              : "debridge";

      if (query.provider === "across" && !acrossRoute.ok) {
        reply.code(400);
        return reply.send({
          error: acrossRoute.message,
          code: acrossRoute.code,
        });
      }

      if (resolvedProvider === "across") {
        const acrossResult = await fetchAcrossBridgePayload({
          swapType,
          srcChainId: query.srcChainId,
          dstChainId: query.dstChainId,
          srcToken: query.srcToken,
          dstToken: query.dstToken,
          amountIn: query.amountIn,
          senderAddress: addresses.senderAddress,
          recipientAddress: addresses.recipientAddress,
          slippage: query.slippage,
          requireExecutable: false,
        });

        if (acrossResult.ok) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send(acrossResult.payload);
        }

        if (
          !isAcrossFallbackEligible({
            requestedProvider: query.provider,
            resolvedProvider,
            routeMode: acrossRoute.ok ? acrossRoute.mode : undefined,
            srcChainId: query.srcChainId,
            dstChainId: query.dstChainId,
            status: acrossResult.status,
            payload: acrossResult.payload,
          })
        ) {
          reply.code(acrossResult.status >= 500 ? 502 : acrossResult.status);
          return reply.send({
            error: acrossResult.message,
            status: acrossResult.status,
            message: acrossResult.message,
            payload: acrossResult.payload,
          });
        }
      }

      const debridgeConfig = await getDebridgeConfig();
      const affiliateDefaults = resolveAffiliateDefaults({
        swapType,
        srcChainId: query.srcChainId,
        dstChainId: query.dstChainId,
        config: debridgeConfig,
        affiliateFeePercent: query.affiliateFeePercent,
        affiliateFeeRecipient: query.affiliateFeeRecipient,
      });
      const referralCode = resolveReferralCode(
        debridgeConfig,
        query.referralCode,
      );

      const upstream =
        swapType === "same_chain"
          ? await debridgeRequest({
              baseUrl: debridgeConfig.dlnBase,
              timeoutMs: 15_000,
              method: "GET",
              requestPath: "/chain/transaction",
              query: buildDebridgeSameChainQuery({
                chainId: query.srcChainId,
                srcToken: query.srcToken,
                dstToken: query.dstToken,
                amountIn: query.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                slippage: query.slippage,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: query.deBridgeApp,
              }),
            })
          : await debridgeRequest({
              baseUrl: debridgeConfig.dlnBase,
              timeoutMs: 15_000,
              method: "GET",
              requestPath: "/dln/order/create-tx",
              query: buildDebridgeCreateTxQuery({
                srcChainId: query.srcChainId,
                dstChainId: query.dstChainId,
                srcToken: query.srcToken,
                dstToken: query.dstToken,
                amountIn: query.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                dstChainTokenOutAmount: query.dstChainTokenOutAmount,
                slippage: query.slippage,
                additionalTakerRewardBps: query.additionalTakerRewardBps,
                referralCode,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: query.deBridgeApp,
                prependOperatingExpenses: query.prependOperatingExpenses,
                srcChainOrderAuthorityAddress:
                  query.srcChainOrderAuthorityAddress,
                srcChainRefundAddress: query.srcChainRefundAddress,
                dstChainOrderAuthorityAddress:
                  query.dstChainOrderAuthorityAddress,
              }),
            });

      if (!upstream.ok) {
        const reason = extractDebridgeErrorMessage(upstream.payload);
        reply.code(502);
        return reply.send({
          error: reason || "deBridge quote failed",
          status: upstream.status,
          message: reason || "deBridge quote failed",
          payload: upstream.payload,
        });
      }

      const signerMismatch = validateDebridgeSameChainSolanaSigner({
        swapType,
        chainId: query.srcChainId,
        senderAddress: addresses.senderAddress,
        payload: upstream.payload,
      });
      if (signerMismatch) {
        reply.code(422);
        return reply.send({
          error: signerMismatch.message,
          message: signerMismatch.message,
          provider: "debridge",
          swapType,
          requiredSigners: signerMismatch.requiredSigners,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ...((isRecord(upstream.payload) ? upstream.payload : {}) as Record<
          string,
          unknown
        >),
        provider: "debridge",
        swapType,
      });
    },
  );

  z.post(
    "/bridge/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: bridgeOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;
      const swapType = resolveSwapType(
        body.srcChainId,
        body.dstChainId,
        body.swapType ?? null,
      );
      if (!swapType) {
        reply.code(400);
        return reply.send({
          error: "swapType does not match srcChainId/dstChainId",
        });
      }

      const addresses = resolveBridgeAddresses(
        body.senderAddress,
        body.recipientAddress,
        request.walletAddress,
      );
      if (!addresses) {
        reply.code(400);
        return reply.send({
          error: "senderAddress and recipientAddress are required",
        });
      }
      const addressValidationError = validateBridgeAddressInputs({
        srcChainId: body.srcChainId,
        dstChainId: body.dstChainId,
        senderAddress: addresses.senderAddress,
        recipientAddress: addresses.recipientAddress,
        srcChainOrderAuthorityAddress: body.srcChainOrderAuthorityAddress,
        srcChainRefundAddress: body.srcChainRefundAddress,
        dstChainOrderAuthorityAddress: body.dstChainOrderAuthorityAddress,
      });
      if (addressValidationError) {
        reply.code(400);
        return reply.send({ error: addressValidationError });
      }
      const senderAuthorized = await isAuthorizedBridgeSender(
        user.id,
        addresses.senderAddress,
      );
      if (!senderAuthorized) {
        reply.code(403);
        return reply.send({
          error: "senderAddress is not linked to the authenticated user",
        });
      }

      const acrossRoute = resolveAcrossRoute({
        swapType,
        srcChainId: body.srcChainId,
        dstChainId: body.dstChainId,
        srcToken: body.srcToken,
        dstToken: body.dstToken,
      });
      const resolvedProvider: ResolvedBridgeProvider =
        body.provider === "debridge"
          ? "debridge"
          : body.provider === "across"
            ? "across"
            : acrossRoute.ok
              ? "across"
              : "debridge";

      if (body.provider === "across" && !acrossRoute.ok) {
        reply.code(400);
        return reply.send({
          error: acrossRoute.message,
          code: acrossRoute.code,
        });
      }

      if (resolvedProvider === "across") {
        const acrossResult = await fetchAcrossBridgePayload({
          swapType,
          srcChainId: body.srcChainId,
          dstChainId: body.dstChainId,
          srcToken: body.srcToken,
          dstToken: body.dstToken,
          amountIn: body.amountIn,
          senderAddress: addresses.senderAddress,
          recipientAddress: addresses.recipientAddress,
          slippage: body.slippage,
          requireExecutable: true,
        });

        if (acrossResult.ok) {
          const normalizedPayload = acrossResult.payload;
          const providerPayload = isRecord(acrossResult.providerPayload)
            ? acrossResult.providerPayload
            : {};
          const txMeta =
            isRecord(normalizedPayload.tx) &&
            normalizedPayload.tx.kind === "evm"
              ? {
                  to:
                    typeof normalizedPayload.tx.to === "string"
                      ? normalizedPayload.tx.to
                      : null,
                  value:
                    typeof normalizedPayload.tx.value === "string"
                      ? normalizedPayload.tx.value
                      : null,
                  kind: normalizedPayload.tx.kind,
                }
              : isRecord(normalizedPayload.tx)
                ? { kind: normalizedPayload.tx.kind ?? null }
                : null;
          const insertResult = await pool.query<{ id: string }>(
            `
                insert into bridge_orders (
                  user_id,
                  provider,
                  swap_type,
                  src_chain_id,
                  dst_chain_id,
                  src_token,
                  dst_token,
                  amount_in,
                  slippage_bps,
                  quote_id,
                  order_id,
                  status,
                  fees,
                  metadata
                )
                values (
                  $1,
                  $2,
                  $3,
                  $4,
                  $5,
                  $6,
                  $7,
                  $8,
                  $9,
                  $10,
                  $11,
                  $12,
                  $13,
                  $14
                )
                returning id
              `,
            [
              user.id,
              "across",
              swapType,
              body.srcChainId,
              body.dstChainId,
              body.srcToken,
              body.dstToken,
              body.amountIn,
              body.slippage != null ? Math.round(body.slippage * 100) : null,
              typeof normalizedPayload.id === "string"
                ? normalizedPayload.id
                : null,
              null,
              "created",
              normalizedPayload.fees ?? null,
              {
                tx: txMeta,
                estimation: normalizedPayload.estimation ?? null,
                tokenIn: null,
                tokenOut: null,
                across: {
                  approvalTxns: normalizedPayload.approvalTxns ?? null,
                  checks: normalizedPayload.checks ?? null,
                  warnings: normalizedPayload.warnings ?? null,
                  inputAmount: normalizedPayload.inputAmount ?? null,
                  expectedOutputAmount:
                    normalizedPayload.expectedOutputAmount ?? null,
                  minOutputAmount: normalizedPayload.minOutputAmount ?? null,
                  providerPayload,
                },
              },
            ],
          );
          const bridgeOrderId = insertResult.rows[0]?.id ?? null;
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ...normalizedPayload,
            bridgeOrderId,
          });
        }

        if (
          !isAcrossFallbackEligible({
            requestedProvider: body.provider,
            resolvedProvider,
            routeMode: acrossRoute.ok ? acrossRoute.mode : undefined,
            srcChainId: body.srcChainId,
            dstChainId: body.dstChainId,
            status: acrossResult.status,
            payload: acrossResult.payload,
          })
        ) {
          reply.code(acrossResult.status >= 500 ? 502 : acrossResult.status);
          return reply.send({
            error: acrossResult.message,
            status: acrossResult.status,
            message: acrossResult.message,
            payload: acrossResult.payload,
          });
        }
      }

      const debridgeConfig = await getDebridgeConfig();
      const affiliateDefaults = resolveAffiliateDefaults({
        swapType,
        srcChainId: body.srcChainId,
        dstChainId: body.dstChainId,
        config: debridgeConfig,
        affiliateFeePercent: body.affiliateFeePercent,
        affiliateFeeRecipient: body.affiliateFeeRecipient,
      });
      const referralCode = resolveReferralCode(
        debridgeConfig,
        body.referralCode,
      );

      const upstream =
        swapType === "same_chain"
          ? await debridgeRequest({
              baseUrl: debridgeConfig.dlnBase,
              timeoutMs: 20_000,
              method: "GET",
              requestPath: "/chain/transaction",
              query: buildDebridgeSameChainQuery({
                chainId: body.srcChainId,
                srcToken: body.srcToken,
                dstToken: body.dstToken,
                amountIn: body.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                slippage: body.slippage,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: body.deBridgeApp,
              }),
            })
          : await debridgeRequest({
              baseUrl: debridgeConfig.dlnBase,
              timeoutMs: 20_000,
              method: "GET",
              requestPath: "/dln/order/create-tx",
              query: buildDebridgeCreateTxQuery({
                srcChainId: body.srcChainId,
                dstChainId: body.dstChainId,
                srcToken: body.srcToken,
                dstToken: body.dstToken,
                amountIn: body.amountIn,
                senderAddress: addresses.senderAddress,
                recipientAddress: addresses.recipientAddress,
                dstChainTokenOutAmount: body.dstChainTokenOutAmount,
                slippage: body.slippage,
                additionalTakerRewardBps: body.additionalTakerRewardBps,
                referralCode,
                affiliateFeePercent: affiliateDefaults.affiliateFeePercent,
                affiliateFeeRecipient: affiliateDefaults.affiliateFeeRecipient,
                deBridgeApp: body.deBridgeApp,
                prependOperatingExpenses: body.prependOperatingExpenses,
                srcChainOrderAuthorityAddress:
                  body.srcChainOrderAuthorityAddress,
                srcChainRefundAddress: body.srcChainRefundAddress,
                dstChainOrderAuthorityAddress:
                  body.dstChainOrderAuthorityAddress,
              }),
            });

      if (!upstream.ok) {
        const reason = extractDebridgeErrorMessage(upstream.payload);
        reply.code(502);
        return reply.send({
          error: reason || "deBridge order failed",
          status: upstream.status,
          message: reason || "deBridge order failed",
          payload: upstream.payload,
        });
      }

      const signerMismatch = validateDebridgeSameChainSolanaSigner({
        swapType,
        chainId: body.srcChainId,
        senderAddress: addresses.senderAddress,
        payload: upstream.payload,
      });
      if (signerMismatch) {
        reply.code(422);
        return reply.send({
          error: signerMismatch.message,
          message: signerMismatch.message,
          provider: "debridge",
          swapType,
          requiredSigners: signerMismatch.requiredSigners,
        });
      }

      let orderId: string | null = null;
      let txMeta: Record<string, unknown> | null = null;
      let estimation: unknown | null = null;
      let fees: unknown | null = null;
      let tokenIn: unknown | null = null;
      let tokenOut: unknown | null = null;

      if (isRecord(upstream.payload)) {
        orderId =
          typeof upstream.payload.orderId === "string"
            ? upstream.payload.orderId
            : null;
        if (isRecord(upstream.payload.tx)) {
          txMeta = {
            to:
              typeof upstream.payload.tx.to === "string"
                ? upstream.payload.tx.to
                : null,
            value:
              typeof upstream.payload.tx.value === "string"
                ? upstream.payload.tx.value
                : null,
          };
        }
        if (upstream.payload.estimation !== undefined) {
          estimation = upstream.payload.estimation;
          if (isRecord(upstream.payload.estimation)) {
            fees = upstream.payload.estimation.fees ?? null;
          }
        }
        if (swapType === "same_chain") {
          if (isRecord(upstream.payload.tokenIn)) {
            tokenIn = upstream.payload.tokenIn;
          }
          if (isRecord(upstream.payload.tokenOut)) {
            tokenOut = upstream.payload.tokenOut;
          }
        }
      }

      const insertResult = await pool.query<{ id: string }>(
        `
          insert into bridge_orders (
            user_id,
            provider,
            swap_type,
            src_chain_id,
            dst_chain_id,
            src_token,
            dst_token,
            amount_in,
            slippage_bps,
            quote_id,
            order_id,
            status,
            fees,
            metadata
          )
          values (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14
          )
          returning id
        `,
        [
          user.id,
          "debridge",
          swapType,
          body.srcChainId,
          body.dstChainId,
          body.srcToken,
          body.dstToken,
          body.amountIn,
          body.slippage != null ? Math.round(body.slippage * 100) : null,
          null,
          orderId,
          "created",
          fees,
          { tx: txMeta, estimation, tokenIn, tokenOut },
        ],
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      const bridgeOrderId = insertResult.rows[0]?.id ?? null;
      return reply.send({
        ...((isRecord(upstream.payload) ? upstream.payload : {}) as Record<
          string,
          unknown
        >),
        provider: "debridge",
        bridgeOrderId,
        swapType,
      });
    },
  );

  z.get(
    "/bridge/status",
    { schema: { querystring: bridgeStatusQuerySchema } },
    async (request, reply) => {
      const query = request.query;

      if (query.provider === "across") {
        const orderId = query.orderId?.trim();
        const txHash = query.txHash?.trim();
        if (!txHash) {
          reply.code(400);
          return reply.send({ error: "txHash is required for Across status" });
        }

        const resolvedTxHash = txHash;
        let resolvedSwapType: BridgeSwapType | null = query.swapType ?? null;
        let resolvedChainId = query.chainId?.trim() || null;
        let resolvedStoredStatus: string | null = null;

        if (!resolvedSwapType || !resolvedChainId) {
          const { rows } = await pool.query<{
            swap_type: BridgeSwapType;
            src_chain_id: string;
            tx_hash_src: string | null;
            status: string | null;
          }>(
            `
              select swap_type, src_chain_id, tx_hash_src, status
              from bridge_orders
              where provider = 'across'
                and tx_hash_src = $1
              order by updated_at desc
              limit 1
            `,
            [resolvedTxHash],
          );
          if (rows[0]) {
            resolvedSwapType = resolvedSwapType ?? rows[0].swap_type;
            resolvedChainId = resolvedChainId ?? rows[0].src_chain_id;
            resolvedStoredStatus = rows[0].status?.trim() || null;
          }
        }

        const synced = await syncAcrossBridgeOrderByTx({
          txHash: resolvedTxHash,
          chainId: resolvedChainId,
          storedStatus: resolvedStoredStatus,
          orderId,
        });

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          provider: "across",
          swapType: resolvedSwapType ?? "cross_chain",
          orderIds: orderId ? [orderId] : [],
          txLookup: null,
          orders: [
            {
              orderId: orderId ?? resolvedTxHash,
              payload: synced.payload,
            },
          ],
        });
      }

      const debridgeConfig = await getDebridgeConfig();
      const orderId = query.orderId?.trim();
      const txHash = query.txHash?.trim();
      if (!orderId && !txHash) {
        reply.code(400);
        return reply.send({ error: "orderId or txHash is required" });
      }

      let resolvedSwapType: BridgeSwapType | null = query.swapType ?? null;
      let resolvedChainId = query.chainId?.trim() || null;
      let resolvedTxHash = txHash || null;
      let resolvedStoredStatus: BridgeOrderStatus | null = null;

      const markCrossChainFailedFromSourceReceipt = async (inputs: {
        chainId: string | null;
        txHash: string | null;
        orderId?: string | null;
      }): Promise<"failed" | null> => {
        const failedStatus = await fetchCrossChainSourceFailureStatus({
          chainId: inputs.chainId,
          txHash: inputs.txHash,
        });
        if (!failedStatus) return null;
        if (inputs.orderId) {
          await pool.query(
            `
              update bridge_orders
              set status = $1, updated_at = now()
              where provider = 'debridge'
                and (order_id = $2 or tx_hash_src = $3)
            `,
            [failedStatus, inputs.orderId, inputs.txHash],
          );
          await notifyBridgeStatusByOrder(
            "debridge",
            inputs.orderId,
            failedStatus,
          );
          return failedStatus;
        }
        if (!inputs.txHash) return null;
        await pool.query(
          `
            update bridge_orders
            set status = $1, updated_at = now()
            where provider = 'debridge'
              and tx_hash_src = $2
          `,
          [failedStatus, inputs.txHash],
        );
        await notifyBridgeStatusByTx("debridge", inputs.txHash, failedStatus);
        return failedStatus;
      };

      if (!resolvedSwapType || !resolvedChainId || !resolvedTxHash) {
        const lookupColumn = orderId ? "order_id" : "tx_hash_src";
        const lookupValue = orderId ?? txHash ?? "";
        const { rows } = await pool.query<{
          swap_type: BridgeSwapType;
          src_chain_id: string;
          tx_hash_src: string | null;
          status: string | null;
        }>(
          `
            select swap_type, src_chain_id, tx_hash_src, status
            from bridge_orders
            where provider = 'debridge'
              and ${lookupColumn} = $1
            order by updated_at desc
            limit 1
          `,
          [lookupValue],
        );
        if (rows[0]) {
          resolvedSwapType = rows[0].swap_type;
          if (!resolvedChainId) {
            resolvedChainId = rows[0].src_chain_id;
          }
          if (!resolvedTxHash) {
            resolvedTxHash = rows[0].tx_hash_src?.trim() || null;
          }
          if (!resolvedStoredStatus && rows[0].status) {
            resolvedStoredStatus = canonicalizeBridgeOrderStatus(
              rows[0].status,
            );
          }
        }
      }

      if (resolvedSwapType === "same_chain") {
        if (!txHash) {
          reply.code(400);
          return reply.send({ error: "txHash is required for same-chain" });
        }
        if (!resolvedChainId) {
          reply.code(400);
          return reply.send({ error: "chainId is required for same-chain" });
        }

        const orderRes = await debridgeRequest({
          baseUrl: debridgeConfig.statsBase,
          timeoutMs: 15_000,
          method: "GET",
          requestPath: `/SameChainSwap/${resolvedChainId}/tx/${txHash}`,
        });

        if (!orderRes.ok) {
          const fallback =
            (await fetchEvmReceiptStatus({
              chainId: resolvedChainId,
              txHash,
            })) ??
            (await fetchSolanaReceiptStatus({
              chainId: resolvedChainId,
              txHash,
            }));
          if (fallback?.status) {
            const canonicalStatus = canonicalizeBridgeOrderStatus(
              fallback.status,
            );
            await pool.query(
              `
                update bridge_orders
                set status = $1, updated_at = now()
                where provider = 'debridge'
                  and tx_hash_src = $2
              `,
              [canonicalStatus, txHash],
            );
            await notifyBridgeStatusByTx("debridge", txHash, canonicalStatus);
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({
              ok: true,
              provider: query.provider,
              swapType: "same_chain",
              chainId: resolvedChainId,
              orderIds: [],
              txLookup: null,
              orders: [
                {
                  orderId: txHash,
                  payload: { status: canonicalStatus, source: "rpc" },
                },
              ],
            });
          }

          const message = extractDebridgeErrorMessage(orderRes.payload);
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            provider: query.provider,
            swapType: "same_chain",
            chainId: resolvedChainId,
            orderIds: [],
            txLookup: null,
            orders: [
              {
                orderId: txHash,
                payload: {
                  status: "submitted",
                  source: "indexer_pending",
                  error: message ?? null,
                },
              },
            ],
          });
        }

        if (isRecord(orderRes.payload)) {
          const statusRaw =
            typeof orderRes.payload.status === "string"
              ? orderRes.payload.status
              : typeof orderRes.payload.state === "string"
                ? orderRes.payload.state
                : null;
          if (statusRaw && !isTerminalBridgeOrderStatus(statusRaw)) {
            const fallback =
              (await fetchEvmReceiptStatus({
                chainId: resolvedChainId,
                txHash,
              })) ??
              (await fetchSolanaReceiptStatus({
                chainId: resolvedChainId,
                txHash,
              }));
            if (fallback?.status) {
              const canonicalStatus = canonicalizeBridgeOrderStatus(
                fallback.status,
              );
              await pool.query(
                `
                  update bridge_orders
                  set status = $1, updated_at = now()
                  where provider = 'debridge'
                    and tx_hash_src = $2
                `,
                [canonicalStatus, txHash],
              );
              await notifyBridgeStatusByTx("debridge", txHash, canonicalStatus);
              reply.header("Content-Type", "application/json; charset=utf-8");
              return reply.send({
                ok: true,
                provider: query.provider,
                swapType: "same_chain",
                chainId: resolvedChainId,
                orderIds: [],
                txLookup: null,
                orders: [
                  {
                    orderId: txHash,
                    payload: { status: canonicalStatus, source: "rpc" },
                  },
                ],
              });
            }
          }
          if (statusRaw) {
            const status = canonicalizeBridgeOrderStatus(statusRaw);
            await pool.query(
              `
                update bridge_orders
                set status = $1, updated_at = now()
                where provider = 'debridge'
                  and tx_hash_src = $2
              `,
              [status, txHash],
            );
            await notifyBridgeStatusByTx("debridge", txHash, status);
          }
        }

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          provider: query.provider,
          swapType: "same_chain",
          chainId: resolvedChainId,
          orderIds: [],
          txLookup: null,
          orders: [{ orderId: txHash, payload: orderRes.payload }],
        });
      }

      let orderIds: string[] = [];
      let txLookup: unknown = null;

      if (!orderId && resolvedTxHash) {
        const lookup = await debridgeRequest({
          baseUrl: debridgeConfig.statsBase,
          timeoutMs: 15_000,
          method: "GET",
          requestPath: `/Transaction/${resolvedTxHash}/orderIds`,
        });

        if (!lookup.ok) {
          const failedStatus = await markCrossChainFailedFromSourceReceipt({
            chainId: resolvedChainId,
            txHash: resolvedTxHash,
          });
          if (failedStatus) {
            reply.header("Content-Type", "application/json; charset=utf-8");
            return reply.send({
              ok: true,
              provider: query.provider,
              swapType: resolvedSwapType ?? "cross_chain",
              orderIds: [],
              txLookup: null,
              orders: [
                {
                  orderId: resolvedTxHash,
                  payload: { status: failedStatus, source: "rpc" },
                },
              ],
            });
          }
          reply.code(502);
          return reply.send({
            error: "deBridge order lookup failed",
            status: lookup.status,
            message: extractDebridgeErrorMessage(lookup.payload),
            payload: lookup.payload,
          });
        }

        txLookup = lookup.payload;
        if (
          isRecord(lookup.payload) &&
          Array.isArray(lookup.payload.orderIds)
        ) {
          orderIds = lookup.payload.orderIds
            .map((id) => (typeof id === "string" ? id : null))
            .filter((id): id is string => Boolean(id));
        }
      }

      if (orderId) orderIds = [orderId];
      if (!orderIds.length && resolvedTxHash) {
        const failedStatus = await markCrossChainFailedFromSourceReceipt({
          chainId: resolvedChainId,
          txHash: resolvedTxHash,
        });
        if (failedStatus) {
          reply.header("Content-Type", "application/json; charset=utf-8");
          return reply.send({
            ok: true,
            provider: query.provider,
            swapType: resolvedSwapType ?? "cross_chain",
            orderIds: [],
            txLookup,
            orders: [
              {
                orderId: resolvedTxHash,
                payload: { status: failedStatus, source: "rpc" },
              },
            ],
          });
        }
      }

      const orders: Array<{ orderId: string; payload: unknown }> = [];
      for (const id of orderIds) {
        const { rows: dbRows } = await pool.query<{
          status: string | null;
          src_chain_id: string | null;
          tx_hash_src: string | null;
        }>(
          `
            select status, src_chain_id, tx_hash_src
            from bridge_orders
            where provider = 'debridge'
              and order_id = $1
            order by updated_at desc
            limit 1
          `,
          [id],
        );
        const dbRow = dbRows[0] ?? null;
        const dbStatus = dbRow?.status
          ? canonicalizeBridgeOrderStatus(dbRow.status)
          : null;
        if (!resolvedChainId && dbRow?.src_chain_id) {
          resolvedChainId = dbRow.src_chain_id;
        }
        if (!resolvedTxHash && dbRow?.tx_hash_src) {
          resolvedTxHash = dbRow.tx_hash_src;
        }

        const orderRes = await debridgeRequest({
          baseUrl: debridgeConfig.statsBase,
          timeoutMs: 15_000,
          method: "GET",
          requestPath: `/Orders/${id}`,
        });

        if (!orderRes.ok) {
          if (dbStatus && isTerminalBridgeOrderStatus(dbStatus)) {
            orders.push({
              orderId: id,
              payload: { status: dbStatus, source: "db" },
            });
            continue;
          }
          const failedStatus = await markCrossChainFailedFromSourceReceipt({
            chainId: resolvedChainId,
            txHash: resolvedTxHash,
            orderId: id,
          });
          if (failedStatus) {
            orders.push({
              orderId: id,
              payload: { status: failedStatus, source: "rpc" },
            });
            continue;
          }
          orders.push({
            orderId: id,
            payload: {
              error: "deBridge order status failed",
              status: orderRes.status,
              payload: orderRes.payload,
            },
          });
          continue;
        }
        let payload: unknown = orderRes.payload;
        let status: BridgeOrderStatus | null = null;
        if (isRecord(orderRes.payload)) {
          const statusRaw =
            typeof orderRes.payload.status === "string"
              ? orderRes.payload.status
              : typeof orderRes.payload.state === "string"
                ? orderRes.payload.state
                : null;
          if (statusRaw) {
            status = canonicalizeBridgeOrderStatus(statusRaw);
            if (!isTerminalBridgeOrderStatus(status)) {
              const failedStatus = await markCrossChainFailedFromSourceReceipt({
                chainId: resolvedChainId,
                txHash: resolvedTxHash,
                orderId: id,
              });
              if (failedStatus) {
                status = failedStatus;
                payload = {
                  ...orderRes.payload,
                  status: failedStatus,
                  source: "rpc",
                };
              }
            }
          } else {
            if (dbStatus && isTerminalBridgeOrderStatus(dbStatus)) {
              status = dbStatus;
              payload = { ...orderRes.payload, status: dbStatus, source: "db" };
            }
            const failedStatus = await markCrossChainFailedFromSourceReceipt({
              chainId: resolvedChainId,
              txHash: resolvedTxHash,
              orderId: id,
            });
            if (failedStatus) {
              status = failedStatus;
              payload = {
                ...orderRes.payload,
                status: failedStatus,
                source: "rpc",
              };
            }
          }
          if (!status && dbStatus && isTerminalBridgeOrderStatus(dbStatus)) {
            status = dbStatus;
            payload = { ...orderRes.payload, status: dbStatus, source: "db" };
          }
          if (status) {
            await pool.query(
              `
                update bridge_orders
                set status = $1, updated_at = now()
                where provider = 'debridge' and order_id = $2
              `,
              [status, id],
            );
            await notifyBridgeStatusByOrder("debridge", id, status);
          }
        }
        orders.push({ orderId: id, payload });
      }

      if (
        !orders.length &&
        resolvedStoredStatus &&
        isTerminalBridgeOrderStatus(resolvedStoredStatus)
      ) {
        const syntheticOrderId = orderId ?? resolvedTxHash ?? "status";
        orders.push({
          orderId: syntheticOrderId,
          payload: { status: resolvedStoredStatus, source: "db" },
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        provider: query.provider,
        swapType: resolvedSwapType ?? "cross_chain",
        orderIds,
        txLookup,
        orders,
      });
    },
  );

  z.post(
    "/bridge/submit",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: bridgeSubmitBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const body = request.body;

      const bridgeOrderId = body.bridgeOrderId?.trim() || null;
      const orderId = body.orderId?.trim() || null;
      if (!bridgeOrderId && !orderId) {
        reply.code(400);
        return reply.send({ error: "bridgeOrderId or orderId is required" });
      }

      const txColumn = body.txChain === "dst" ? "tx_hash_dst" : "tx_hash_src";
      const status = canonicalizeBridgeOrderStatus(
        body.status?.trim() || "submitted",
      );

      const txHashValue = body.txHash;
      const updateQuery = bridgeOrderId
        ? `
            update bridge_orders
            set ${txColumn} = $1,
                status = $2,
                updated_at = now()
            where id = $3
              and user_id = $4
          `
        : `
            update bridge_orders
            set ${txColumn} = $1,
                status = $2,
                updated_at = now()
            where provider = $3
              and order_id = $4
              and user_id = $5
          `;
      const updateParams = bridgeOrderId
        ? [txHashValue, status, bridgeOrderId, user.id]
        : [txHashValue, status, body.provider, orderId, user.id];
      const { rowCount } = await pool.query(updateQuery, updateParams);

      if (!rowCount) {
        reply.code(404);
        return reply.send({ error: "Bridge order not found" });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true });
    },
  );

  z.get(
    "/bridge/orders",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: bridgeOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const {
        provider,
        limit = 50,
        offset = 0,
        sync,
        syncLimit,
      } = request.query;

      const debridgeConfig = await getDebridgeConfig();
      const countParams: Array<string | number> = [user.id];
      const countProviderClause = provider ? `and provider = $2` : "";
      if (provider) countParams.push(provider);

      const countRes = await pool.query<{ total: string }>(
        `
          select count(*)::text as total
          from bridge_orders
          where user_id = $1
          ${countProviderClause}
        `,
        countParams,
      );
      const total = Number(countRes.rows[0]?.total ?? 0);

      const params: Array<string | number> = [user.id, limit, offset];
      const providerClause = provider ? `and provider = $4` : "";
      if (provider) params.push(provider);

      if (sync) {
        const syncProvider = provider ?? "debridge";
        const maxSync = syncLimit ?? 3;
        const { rows: pendingRows } = await pool.query<{
          id: string;
          swap_type: BridgeSwapType;
          src_chain_id: string;
          order_id: string | null;
          tx_hash_src: string | null;
          status: string | null;
        }>(
          `
            select
              id,
              swap_type,
              src_chain_id,
              order_id,
              tx_hash_src,
              status
            from bridge_orders
            where user_id = $1
              and provider = $2
              and lower(status) in ('created', 'submitted')
              and (order_id is not null or tx_hash_src is not null)
            order by
              case when lower(status) = 'submitted' then 0 else 1 end,
              updated_at desc
            limit $3
          `,
          [user.id, syncProvider, maxSync],
        );

        const extractStatus = (payload: unknown): BridgeOrderStatus | null => {
          if (!isRecord(payload)) return null;
          const rawStatus =
            typeof payload.status === "string"
              ? payload.status
              : typeof payload.state === "string"
                ? payload.state
                : null;
          if (!rawStatus) return null;
          return canonicalizeBridgeOrderStatus(rawStatus);
        };
        const isTerminalStatus = (value: BridgeOrderStatus) => {
          return isTerminalBridgeOrderStatus(value);
        };
        const updateOrderStatus = async (
          status: BridgeOrderStatus,
          id: string,
        ) => {
          await pool.query(
            `
              update bridge_orders
              set status = $1, updated_at = now()
              where id = $2
            `,
            [status, id],
          );
        };
        const toCanonicalReceiptStatus = (
          status: string | null | undefined,
        ): BridgeOrderStatus | null => {
          if (!status) return null;
          return canonicalizeBridgeOrderStatus(status);
        };
        const resolveCrossChainFailedBySourceReceipt = async (row: {
          src_chain_id: string;
          tx_hash_src: string | null;
        }): Promise<BridgeOrderStatus | null> => {
          const failedStatus = await fetchCrossChainSourceFailureStatus({
            chainId: row.src_chain_id,
            txHash: row.tx_hash_src,
          });
          return failedStatus ? failedStatus : null;
        };

        if (syncProvider === "across") {
          for (const row of pendingRows) {
            try {
              if (!row.tx_hash_src) continue;
              await syncAcrossBridgeOrderByTx({
                txHash: row.tx_hash_src,
                chainId: row.src_chain_id,
                storedStatus: row.status,
                orderId: row.order_id,
              });
            } catch (error) {
              request.log.warn(
                { error, orderId: row.id },
                "Across sync failed",
              );
            }
          }
        } else {
          for (const row of pendingRows) {
            try {
              if (row.swap_type === "same_chain") {
                if (!row.tx_hash_src) continue;
                const orderRes = await debridgeRequest({
                  baseUrl: debridgeConfig.statsBase,
                  timeoutMs: 15_000,
                  method: "GET",
                  requestPath: `/SameChainSwap/${row.src_chain_id}/tx/${row.tx_hash_src}`,
                });

                if (orderRes.ok) {
                  const status = extractStatus(orderRes.payload);
                  if (status && isTerminalStatus(status)) {
                    await updateOrderStatus(status, row.id);
                    continue;
                  }
                  const fallback =
                    (await fetchEvmReceiptStatus({
                      chainId: row.src_chain_id,
                      txHash: row.tx_hash_src,
                    })) ??
                    (await fetchSolanaReceiptStatus({
                      chainId: row.src_chain_id,
                      txHash: row.tx_hash_src,
                    }));
                  if (fallback?.status) {
                    const canonicalStatus = toCanonicalReceiptStatus(
                      fallback.status,
                    );
                    if (canonicalStatus) {
                      await updateOrderStatus(canonicalStatus, row.id);
                    }
                  }
                  continue;
                }

                const fallback =
                  (await fetchEvmReceiptStatus({
                    chainId: row.src_chain_id,
                    txHash: row.tx_hash_src,
                  })) ??
                  (await fetchSolanaReceiptStatus({
                    chainId: row.src_chain_id,
                    txHash: row.tx_hash_src,
                  }));
                if (fallback?.status) {
                  const canonicalStatus = toCanonicalReceiptStatus(
                    fallback.status,
                  );
                  if (canonicalStatus) {
                    await updateOrderStatus(canonicalStatus, row.id);
                  }
                }
                continue;
              }

              let resolvedOrderId = row.order_id;
              if (!resolvedOrderId && row.tx_hash_src) {
                const lookup = await debridgeRequest({
                  baseUrl: debridgeConfig.statsBase,
                  timeoutMs: 15_000,
                  method: "GET",
                  requestPath: `/Transaction/${row.tx_hash_src}/orderIds`,
                });
                if (lookup.ok) {
                  const ids =
                    isRecord(lookup.payload) &&
                    Array.isArray(lookup.payload.orderIds)
                      ? lookup.payload.orderIds
                          .map((id) => (typeof id === "string" ? id : null))
                          .filter((id): id is string => Boolean(id))
                      : [];
                  if (ids[0]) {
                    resolvedOrderId = ids[0];
                    await pool.query(
                      `
                      update bridge_orders
                      set order_id = $1, updated_at = now()
                      where id = $2
                    `,
                      [resolvedOrderId, row.id],
                    );
                  }
                } else {
                  const fallbackStatus =
                    await resolveCrossChainFailedBySourceReceipt(row);
                  if (fallbackStatus) {
                    await updateOrderStatus(fallbackStatus, row.id);
                  }
                  continue;
                }
              }

              if (!resolvedOrderId) {
                const fallbackStatus =
                  await resolveCrossChainFailedBySourceReceipt(row);
                if (fallbackStatus) {
                  await updateOrderStatus(fallbackStatus, row.id);
                }
                continue;
              }
              const orderRes = await debridgeRequest({
                baseUrl: debridgeConfig.statsBase,
                timeoutMs: 15_000,
                method: "GET",
                requestPath: `/Orders/${resolvedOrderId}`,
              });
              if (!orderRes.ok) {
                const fallbackStatus =
                  await resolveCrossChainFailedBySourceReceipt(row);
                if (fallbackStatus) {
                  await updateOrderStatus(fallbackStatus, row.id);
                }
                continue;
              }

              const status = extractStatus(orderRes.payload);
              if (status && isTerminalStatus(status)) {
                await updateOrderStatus(status, row.id);
                continue;
              }
              if (!isTerminalStatus(status ?? "submitted")) {
                const fallbackStatus =
                  await resolveCrossChainFailedBySourceReceipt(row);
                if (fallbackStatus) {
                  await updateOrderStatus(fallbackStatus, row.id);
                  continue;
                }
              }
              if (status) {
                await updateOrderStatus(status, row.id);
              }
            } catch (error) {
              request.log.warn(
                { error, orderId: row.id },
                "Bridge sync failed",
              );
            }
          }
        }
      }

      const { rows } = await pool.query(
        `
          select
            id,
            provider,
            swap_type,
            src_chain_id,
            dst_chain_id,
            src_token,
            dst_token,
            amount_in,
            min_amount_out,
            slippage_bps,
            quote_id,
            order_id,
            request_hash,
            tx_hash_src,
            tx_hash_dst,
            status,
            route_name,
            fees,
            metadata,
            created_at,
            updated_at
          from bridge_orders
          where user_id = $1
          ${providerClause}
          order by created_at desc
          limit $2 offset $3
        `,
        params,
      );

      const tokenLookup = new Map<
        string,
        {
          address: string;
          symbol: string | null;
          name: string | null;
          decimals: number | null;
          logo_uri: string | null;
          tags: unknown;
        }
      >();
      const chainAddressMap = new Map<string, Set<string>>();
      const normalizeDecimals = (value: unknown) => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (!trimmed) return null;
          const parsed = Number(trimmed);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      };
      const readString = (value: unknown) =>
        typeof value === "string" ? value : null;
      for (const row of rows) {
        const srcChain = row.src_chain_id as string;
        const dstChain = row.dst_chain_id as string;
        const srcAddress = (row.src_token as string).toLowerCase();
        const dstAddress = (row.dst_token as string).toLowerCase();
        if (!chainAddressMap.has(srcChain)) {
          chainAddressMap.set(srcChain, new Set());
        }
        if (!chainAddressMap.has(dstChain)) {
          chainAddressMap.set(dstChain, new Set());
        }
        chainAddressMap.get(srcChain)?.add(srcAddress);
        chainAddressMap.get(dstChain)?.add(dstAddress);
      }

      for (const [chainId, addressSet] of chainAddressMap.entries()) {
        const addresses = Array.from(addressSet);
        if (!addresses.length) continue;
        const result = await pool.query<{
          chain_id: string;
          address: string;
          symbol: string | null;
          name: string | null;
          decimals: number | null;
          logo_uri: string | null;
          tags: unknown;
        }>(
          `
            select distinct on (address)
              chain_id, address, symbol, name, decimals, logo_uri, tags
            from bridge_token_cache
            where chain_id = $1
              and address = any($2::text[])
            order by address, updated_at desc
          `,
          [chainId, addresses],
        );
        for (const token of result.rows) {
          const key = `${token.chain_id}:${token.address.toLowerCase()}`;
          tokenLookup.set(key, token);
        }
      }

      const enrichedRows = rows.map((row) => {
        const metadata = isRecord(row.metadata) ? { ...row.metadata } : {};
        const tokenIn =
          metadata.tokenIn && isRecord(metadata.tokenIn)
            ? metadata.tokenIn
            : null;
        const tokenOut =
          metadata.tokenOut && isRecord(metadata.tokenOut)
            ? metadata.tokenOut
            : null;

        const srcKey = `${row.src_chain_id}:${row.src_token.toLowerCase()}`;
        const dstKey = `${row.dst_chain_id}:${row.dst_token.toLowerCase()}`;
        const srcToken = tokenLookup.get(srcKey);
        const dstToken = tokenLookup.get(dstKey);
        const srcFallback = getFallbackTokenMeta(
          row.src_chain_id,
          row.src_token,
        );
        const dstFallback = getFallbackTokenMeta(
          row.dst_chain_id,
          row.dst_token,
        );

        metadata.tokenIn = {
          address: readString(tokenIn?.address) ?? row.src_token,
          symbol:
            readString(tokenIn?.symbol) ??
            srcToken?.symbol ??
            srcFallback?.symbol ??
            null,
          name:
            readString(tokenIn?.name) ??
            srcToken?.name ??
            srcFallback?.name ??
            null,
          decimals:
            normalizeDecimals(tokenIn?.decimals) ??
            srcToken?.decimals ??
            srcFallback?.decimals ??
            null,
          amount: readString(tokenIn?.amount) ?? row.amount_in,
          logoURI: readString(tokenIn?.logoURI) ?? srcToken?.logo_uri ?? null,
          tags: tokenIn?.tags ?? srcToken?.tags ?? null,
        };

        metadata.tokenOut = {
          address: readString(tokenOut?.address) ?? row.dst_token,
          symbol:
            readString(tokenOut?.symbol) ??
            dstToken?.symbol ??
            dstFallback?.symbol ??
            null,
          name:
            readString(tokenOut?.name) ??
            dstToken?.name ??
            dstFallback?.name ??
            null,
          decimals:
            normalizeDecimals(tokenOut?.decimals) ??
            dstToken?.decimals ??
            dstFallback?.decimals ??
            null,
          amount: readString(tokenOut?.amount) ?? row.min_amount_out ?? null,
          logoURI: readString(tokenOut?.logoURI) ?? dstToken?.logo_uri ?? null,
          tags: tokenOut?.tags ?? dstToken?.tags ?? null,
        };

        return { ...row, metadata };
      });

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        total,
        limit,
        offset,
        orders: enrichedRows,
      });
    },
  );

  z.get(
    "/bridge/tokens",
    { schema: { querystring: bridgeTokensQuerySchema } },
    async (request, reply) => {
      const { provider, chainId, search, limit } = request.query;
      // Discovery still comes from the existing deBridge-backed cache/endpoints.
      if (provider !== "debridge") {
        reply.code(400);
        return reply.send({ error: "Unsupported bridge provider" });
      }

      const debridgeConfig = await getDebridgeConfig();
      const upstream = await debridgeRequest({
        baseUrl: debridgeConfig.dlnBase,
        timeoutMs: 15_000,
        method: "GET",
        requestPath: "/token-list",
        query: { chainId },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "deBridge token list fetch failed",
          status: upstream.status,
          message: extractDebridgeErrorMessage(upstream.payload),
          payload: upstream.payload,
        });
      }

      let tokens = normalizeDebridgeTokens(upstream.payload);
      if (search && search.trim().length) {
        const needle = search.trim().toLowerCase();
        tokens = tokens.filter((token) => {
          const address = token.address.toLowerCase();
          const symbol = token.symbol?.toLowerCase() ?? "";
          const name = token.name?.toLowerCase() ?? "";
          return (
            address.includes(needle) ||
            symbol.includes(needle) ||
            name.includes(needle)
          );
        });
      }

      const cap = limit ?? 500;
      if (tokens.length > cap) tokens = tokens.slice(0, cap);

      if (tokens.length) {
        const values: Array<string | number | null> = [];
        const placeholders = tokens.map((token, index) => {
          const offset = index * 8;
          values.push(
            provider,
            chainId,
            token.address.toLowerCase(),
            token.symbol ?? null,
            token.name ?? null,
            token.decimals ?? null,
            token.logoURI ?? null,
            JSON.stringify(token.tags ?? null),
          );
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${
            offset + 4
          }, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`;
        });

        await pool.query(
          `
            insert into bridge_token_cache (
              provider,
              chain_id,
              address,
              symbol,
              name,
              decimals,
              logo_uri,
              tags
            )
            values ${placeholders.join(", ")}
            on conflict (provider, chain_id, address) do update
            set symbol = excluded.symbol,
                name = excluded.name,
                decimals = excluded.decimals,
                logo_uri = excluded.logo_uri,
                tags = excluded.tags,
                updated_at = now()
          `,
          values,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        provider,
        chainId,
        total: tokens.length,
        tokens,
      });
    },
  );
};
