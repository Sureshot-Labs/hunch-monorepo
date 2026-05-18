import { createHash } from "node:crypto";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createApproveCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { ethers } from "ethers";

import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchSolanaLatestBlockhash,
  fetchSolanaMintDecimals,
} from "./solana-rpc.js";

export type ResolvedBridgeProvider = "debridge" | "across";
export type BridgeRequestProvider = ResolvedBridgeProvider | "auto";
export type BridgeSwapType = "cross_chain" | "same_chain";
export type AcrossRouteMode = "swap_api" | "evm_to_solana" | "solana_source";

export const HUNCH_SOLANA_CHAIN_ID = "7565164";
export const ACROSS_SOLANA_CHAIN_ID = "34268394551451";
const ACROSS_SOLANA_SPOKE_POOL = "DLv3NggMiSaef97YCkew5xKUHDh13tVGZ7tydt3ZeAru";
const ACROSS_SOLANA_STATE_SEED = 0n;
const SOLANA_MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const ACROSS_SUPPORTED_TOKEN_ADDRESSES: Record<string, Set<string>> = {
  "137": new Set([
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
    normalizeAddress(env.polymarketPusdAddress),
  ]),
  "8453": new Set(["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]),
  [HUNCH_SOLANA_CHAIN_ID]: new Set([
    "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v",
  ]),
};
const SOLANA_NATIVE_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "so11111111111111111111111111111111111111112",
]);

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function parseAddressMap(raw: string): Record<string, string> {
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

function isValidAddressForChain(chainId: string, address: string): boolean {
  const trimmed = address.trim();
  if (!trimmed) return false;
  if (chainId === HUNCH_SOLANA_CHAIN_ID) {
    try {
      new PublicKey(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return ethers.isAddress(trimmed);
}

export function acrossChainIdForHunch(chainId: string): string {
  return chainId === HUNCH_SOLANA_CHAIN_ID ? ACROSS_SOLANA_CHAIN_ID : chainId;
}

export function hunchChainIdForAcross(chainId: string): string {
  return chainId === ACROSS_SOLANA_CHAIN_ID ? HUNCH_SOLANA_CHAIN_ID : chainId;
}

export function isAcrossSolanaRoute(inputs: {
  srcChainId: string;
  dstChainId: string;
}): boolean {
  return (
    inputs.srcChainId === HUNCH_SOLANA_CHAIN_ID ||
    inputs.dstChainId === HUNCH_SOLANA_CHAIN_ID
  );
}

export function isAcrossSupportedToken(
  chainId: string,
  tokenAddress: string,
): boolean {
  const supported = ACROSS_SUPPORTED_TOKEN_ADDRESSES[chainId];
  if (!supported) return false;
  return supported.has(normalizeAddress(tokenAddress));
}

function isSolanaNativeToken(chainId: string, tokenAddress: string): boolean {
  return (
    chainId === HUNCH_SOLANA_CHAIN_ID &&
    SOLANA_NATIVE_ADDRESSES.has(normalizeAddress(tokenAddress))
  );
}

function isAcrossAllowlistedRoute(inputs: {
  srcChainId: string;
  dstChainId: string;
}): boolean {
  if (!env.acrossRouteAllowlist.length) return true;
  const exactPair = `${inputs.srcChainId}:${inputs.dstChainId}`;
  const usdcPair = `${inputs.srcChainId}:${inputs.dstChainId}:USDC`;
  return (
    env.acrossRouteAllowlist.includes(exactPair) ||
    env.acrossRouteAllowlist.includes(usdcPair)
  );
}

export function resolveAcrossRoute(inputs: {
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
}):
  | { ok: true; mode: AcrossRouteMode }
  | { ok: false; code: string; message: string } {
  if (!env.bridgeAcrossEnabled) {
    return {
      ok: false,
      code: "across_disabled",
      message: "Across bridge routing is disabled",
    };
  }
  if (!env.acrossIntegratorId) {
    return {
      ok: false,
      code: "across_integrator_missing",
      message: "Across integratorId is not configured",
    };
  }
  if (inputs.swapType !== "cross_chain") {
    return {
      ok: false,
      code: "across_same_chain_unsupported",
      message: "Across is only available for cross-chain routes",
    };
  }
  if (!isAcrossAllowlistedRoute(inputs)) {
    return {
      ok: false,
      code: "across_route_not_allowlisted",
      message: "Across route is not allowlisted",
    };
  }
  const sourceIsAcrossToken = isAcrossSupportedToken(
    inputs.srcChainId,
    inputs.srcToken,
  );
  const destinationIsAcrossToken = isAcrossSupportedToken(
    inputs.dstChainId,
    inputs.dstToken,
  );
  const sourceIsSolanaNative = isSolanaNativeToken(
    inputs.srcChainId,
    inputs.srcToken,
  );

  if (
    !(sourceIsAcrossToken || sourceIsSolanaNative) ||
    !destinationIsAcrossToken
  ) {
    return {
      ok: false,
      code: "across_token_unsupported",
      message: "Across route is not supported for the selected tokens",
    };
  }
  if (sourceIsSolanaNative) {
    return { ok: true, mode: "swap_api" };
  }
  if (inputs.srcChainId === HUNCH_SOLANA_CHAIN_ID) {
    return { ok: true, mode: "solana_source" };
  }
  return { ok: true, mode: "swap_api" };
}

export function getAcrossConfig() {
  return {
    baseUrl: env.acrossApiBase,
    apiKey: env.acrossApiKey,
    integratorId: env.acrossIntegratorId,
    timeoutMs: env.acrossTimeoutMs,
    appFee: env.acrossAppFee,
    appFeeRecipients: parseAddressMap(env.acrossAppFeeRecipients),
  };
}

export function resolveAcrossAppFee(dstChainId: string):
  | {
      ok: true;
      appFee?: number;
      appFeeRecipient?: string;
    }
  | { ok: false; error: string } {
  const config = getAcrossConfig();
  if (!config.appFee || config.appFee <= 0) return { ok: true };
  const recipient = config.appFeeRecipients[dstChainId]?.trim();
  if (!recipient) {
    return {
      ok: false,
      error: `Across app fee recipient is not configured for destination chain ${dstChainId}`,
    };
  }
  if (!isValidAddressForChain(dstChainId, recipient)) {
    return {
      ok: false,
      error: `Across app fee recipient is invalid for destination chain ${dstChainId}`,
    };
  }
  return {
    ok: true,
    appFee: config.appFee,
    appFeeRecipient: recipient,
  };
}

export function resolveAcrossAppFeeForRoute(
  mode: AcrossRouteMode,
  srcChainId: string,
  dstChainId: string,
):
  | {
      ok: true;
      appFee?: number;
      appFeeRecipient?: string;
    }
  | { ok: false; error: string } {
  if (
    mode !== "swap_api" ||
    srcChainId === HUNCH_SOLANA_CHAIN_ID ||
    dstChainId === HUNCH_SOLANA_CHAIN_ID
  ) {
    return { ok: true };
  }
  return resolveAcrossAppFee(dstChainId);
}

export function acrossSlippageFromPercent(
  value: number | null | undefined,
): string | undefined {
  if (value == null || !Number.isFinite(value) || value < 0) return undefined;
  const asDecimal = value / 100;
  return asDecimal.toString();
}

export function buildAcrossSwapApprovalQuery(inputs: {
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
  slippage?: number;
}): Record<string, string | number | boolean | undefined> {
  const config = getAcrossConfig();
  const appFee =
    inputs.srcChainId === HUNCH_SOLANA_CHAIN_ID ||
    inputs.dstChainId === HUNCH_SOLANA_CHAIN_ID
      ? { ok: true as const }
      : resolveAcrossAppFee(inputs.dstChainId);
  if (!appFee.ok) throw new Error(appFee.error);
  return {
    tradeType: "exactInput",
    originChainId: acrossChainIdForHunch(inputs.srcChainId),
    destinationChainId: acrossChainIdForHunch(inputs.dstChainId),
    inputToken: inputs.srcToken,
    outputToken: inputs.dstToken,
    amount: inputs.amountIn,
    depositor: inputs.senderAddress,
    recipient: inputs.recipientAddress,
    refundAddress: inputs.senderAddress,
    integratorId: config.integratorId || undefined,
    slippage: acrossSlippageFromPercent(inputs.slippage),
    strictTradeType: true,
    appFee: appFee.appFee,
    appFeeRecipient: appFee.appFeeRecipient,
  };
}

export function buildAcrossSuggestedFeesQuery(inputs: {
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  recipientAddress: string;
}): Record<string, string | number | boolean | undefined> {
  return {
    originChainId: acrossChainIdForHunch(inputs.srcChainId),
    destinationChainId: acrossChainIdForHunch(inputs.dstChainId),
    inputToken: inputs.srcToken,
    outputToken: inputs.dstToken,
    amount: inputs.amountIn,
    recipient: inputs.recipientAddress,
    allowUnmatchedDecimals: false,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function readNumberishString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readBigIntString(value: unknown): string | null {
  const raw = readNumberishString(value);
  if (!raw) return null;
  try {
    return BigInt(raw).toString();
  } catch {
    return null;
  }
}

function u32Le(value: number | bigint): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(Number(value), 0);
  return output;
}

function u64Le(value: bigint): Buffer {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error("value does not fit u64");
  }
  const output = Buffer.alloc(8);
  output.writeBigUInt64LE(value, 0);
  return output;
}

function intToBytes32Be(value: bigint): Buffer {
  if (value < 0n) throw new Error("value must be non-negative");
  const hex = value.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("value does not fit bytes32");
  return Buffer.from(hex, "hex");
}

function evmAddressToBytes32(address: string): Buffer {
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  return Buffer.from(ethers.zeroPadValue(address, 32).slice(2), "hex");
}

function bytes32ToPublicKey(bytes: Buffer): PublicKey {
  if (bytes.length !== 32)
    throw new Error("bytes32 public key buffer required");
  return new PublicKey(bytes);
}

function addressOrBase58ToBytes32(address: string): Buffer {
  if (ethers.isAddress(address)) return evmAddressToBytes32(address);
  try {
    return new PublicKey(address).toBuffer();
  } catch {
    throw new Error(`Invalid Across bytes32 address: ${address}`);
  }
}

function addressOrBase58ToPublicKey(address: string): PublicKey {
  return bytes32ToPublicKey(addressOrBase58ToBytes32(address));
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function encodeBorshBytes(bytes: Buffer): Buffer {
  return Buffer.concat([u32Le(bytes.length), bytes]);
}

function deriveSolanaDepositSeedHash(inputs: {
  depositor: PublicKey;
  recipient: PublicKey;
  inputToken: PublicKey;
  outputToken: PublicKey;
  inputAmount: bigint;
  outputAmount: Buffer;
  destinationChainId: bigint;
  exclusiveRelayer: PublicKey;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityParameter: number;
  message: Buffer;
}): Buffer {
  const serialized = Buffer.concat([
    inputs.depositor.toBuffer(),
    inputs.recipient.toBuffer(),
    inputs.inputToken.toBuffer(),
    inputs.outputToken.toBuffer(),
    u64Le(inputs.inputAmount),
    inputs.outputAmount,
    u64Le(inputs.destinationChainId),
    inputs.exclusiveRelayer.toBuffer(),
    u32Le(inputs.quoteTimestamp),
    u32Le(inputs.fillDeadline),
    u32Le(inputs.exclusivityParameter),
    encodeBorshBytes(inputs.message),
  ]);
  return Buffer.from(ethers.keccak256(serialized).slice(2), "hex");
}

function buildSolanaDepositInstructionData(inputs: {
  depositor: PublicKey;
  recipient: PublicKey;
  inputToken: PublicKey;
  outputToken: PublicKey;
  inputAmount: bigint;
  outputAmount: Buffer;
  destinationChainId: bigint;
  exclusiveRelayer: PublicKey;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityParameter: number;
  message: Buffer;
}): Buffer {
  return Buffer.concat([
    anchorDiscriminator("deposit"),
    inputs.depositor.toBuffer(),
    inputs.recipient.toBuffer(),
    inputs.inputToken.toBuffer(),
    inputs.outputToken.toBuffer(),
    u64Le(inputs.inputAmount),
    inputs.outputAmount,
    u64Le(inputs.destinationChainId),
    inputs.exclusiveRelayer.toBuffer(),
    u32Le(inputs.quoteTimestamp),
    u32Le(inputs.fillDeadline),
    u32Le(inputs.exclusivityParameter),
    encodeBorshBytes(inputs.message),
  ]);
}

function parseAcrossSuggestedFeeFields(payload: unknown): {
  id: string | null;
  timestamp: number;
  fillDeadline: number;
  exclusivityParameter: number;
  exclusiveRelayerRaw: string | null;
  spokePoolAddress: string | null;
  outputAmount: string;
} {
  const record = isRecord(payload) ? payload : {};
  const timestampRaw = readNumberishString(record.timestamp);
  const fillDeadlineRaw = readNumberishString(record.fillDeadline);
  const outputAmount = readBigIntString(record.outputAmount);
  if (!timestampRaw || !fillDeadlineRaw || !outputAmount) {
    throw new Error(
      "Across suggested-fees response is missing executable quote fields",
    );
  }
  const timestamp = Math.trunc(Number(timestampRaw));
  const fillDeadline = Math.trunc(Number(fillDeadlineRaw));
  if (!Number.isFinite(timestamp) || !Number.isFinite(fillDeadline)) {
    throw new Error(
      "Across suggested-fees response has invalid quote timestamps",
    );
  }

  const exclusiveRelayerRaw = readString(record.exclusiveRelayer);
  const exclusivityDeadline = readOptionalNumber(record.exclusivityDeadline);
  const exclusivityParameter =
    exclusiveRelayerRaw && exclusivityDeadline != null
      ? Math.max(0, Math.trunc(exclusivityDeadline))
      : 0;

  return {
    id: readString(record.id),
    timestamp,
    fillDeadline,
    exclusivityParameter,
    exclusiveRelayerRaw:
      exclusiveRelayerRaw && exclusivityParameter > 0
        ? exclusiveRelayerRaw
        : null,
    spokePoolAddress: readString(record.spokePoolAddress),
    outputAmount,
  };
}

function normalizeAcrossTx(
  value: unknown,
  srcChainId: string,
): {
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  chainId?: string;
  kind: "evm" | "solana";
} | null {
  if (srcChainId === HUNCH_SOLANA_CHAIN_ID) {
    if (typeof value === "string" && value.trim().length) {
      return { kind: "solana", data: value.trim(), chainId: srcChainId };
    }
    if (!isRecord(value)) return null;
    const data =
      readString(value.transaction) ??
      readString(value.serializedTransaction) ??
      readString(value.data);
    if (!data) return null;
    return {
      kind: "solana",
      data,
      chainId: srcChainId,
    };
  }

  if (!isRecord(value)) return null;
  const to = readString(value.to) ?? readString(value.target);
  if (!to) return null;
  return {
    kind: "evm",
    to,
    data: readString(value.data) ?? "0x",
    value: readNumberishString(value.value) ?? undefined,
    gas: readNumberishString(value.gas) ?? undefined,
    chainId:
      readNumberishString(value.chainId) ??
      readNumberishString(value.originChainId) ??
      srcChainId,
  };
}

function normalizeAcrossApprovalTxns(
  value: unknown,
  srcChainId: string,
): Array<{
  to: string;
  data: string;
  value?: string;
  gas?: string;
  chainId?: string;
}> {
  if (!Array.isArray(value)) return [];
  const normalized: Array<{
    to: string;
    data: string;
    value?: string;
    gas?: string;
    chainId?: string;
  }> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const to = readString(entry.to) ?? readString(entry.target);
    if (!to) continue;
    normalized.push({
      to,
      data: readString(entry.data) ?? "0x",
      value: readNumberishString(entry.value) ?? undefined,
      gas: readNumberishString(entry.gas) ?? undefined,
      chainId:
        readNumberishString(entry.chainId) ??
        readNumberishString(entry.originChainId) ??
        srcChainId,
    });
  }
  return normalized;
}

const ERC20_INTERFACE = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);

const ACROSS_EVM_SPOKE_INTERFACE = new ethers.Interface([
  "function deposit(bytes32 depositor,bytes32 recipient,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes message) payable",
]);

function normalizeAcrossSuggestedFeeWarnings(payload: unknown): Array<{
  code: string;
  message: string;
}> {
  const record = isRecord(payload) ? payload : {};
  const warnings: Array<{ code: string; message: string }> = [];
  if (record.isAmountTooLow === true) {
    warnings.push({
      code: "across_amount_too_low",
      message: "Amount is below Across route minimum.",
    });
  }
  return warnings;
}

function buildAcrossSuggestedFeesBase(inputs: {
  payload: unknown;
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
}): {
  fields: ReturnType<typeof parseAcrossSuggestedFeeFields>;
  quote: Record<string, unknown>;
} {
  const payload = isRecord(inputs.payload) ? inputs.payload : {};
  const fields = parseAcrossSuggestedFeeFields(payload);
  const inputToken = isRecord(payload.inputToken) ? payload.inputToken : null;
  const outputToken = isRecord(payload.outputToken)
    ? payload.outputToken
    : null;

  return {
    fields,
    quote: {
      provider: "across",
      swapType: inputs.swapType,
      id: fields.id,
      checks: null,
      fees: payload,
      inputAmount: inputs.amountIn,
      expectedOutputAmount: fields.outputAmount,
      minOutputAmount: fields.outputAmount,
      quoteExpiryTimestamp: fields.fillDeadline,
      estimation: {
        srcChainTokenIn: {
          address: inputs.srcToken,
          chainId: Number(inputs.srcChainId),
          amount: inputs.amountIn,
          decimals: readOptionalNumber(inputToken?.decimals) ?? 6,
          name: readString(inputToken?.name),
          symbol: readString(inputToken?.symbol) ?? "USDC",
        },
        dstChainTokenOut: {
          address: inputs.dstToken,
          chainId: Number(inputs.dstChainId),
          amount: fields.outputAmount,
          decimals: readOptionalNumber(outputToken?.decimals) ?? 6,
          name: readString(outputToken?.name),
          symbol: readString(outputToken?.symbol) ?? "USDC",
        },
      },
      warnings: normalizeAcrossSuggestedFeeWarnings(payload),
      fixFee: null,
      protocolFee: null,
    },
  };
}

export function normalizeAcrossEvmToSolanaQuoteResponse(inputs: {
  payload: unknown;
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
}): Record<string, unknown> {
  const { fields, quote } = buildAcrossSuggestedFeesBase(inputs);
  const spokePoolAddress = fields.spokePoolAddress;
  if (!spokePoolAddress || !ethers.isAddress(spokePoolAddress)) {
    throw new Error(
      "Across suggested-fees response is missing EVM SpokePool address",
    );
  }

  const inputAmount = BigInt(inputs.amountIn);
  const outputAmount = BigInt(fields.outputAmount);
  const exclusiveRelayer = fields.exclusiveRelayerRaw
    ? addressOrBase58ToBytes32(fields.exclusiveRelayerRaw)
    : Buffer.alloc(32);
  const data = ACROSS_EVM_SPOKE_INTERFACE.encodeFunctionData("deposit", [
    `0x${evmAddressToBytes32(inputs.senderAddress).toString("hex")}`,
    `0x${addressOrBase58ToBytes32(inputs.recipientAddress).toString("hex")}`,
    `0x${evmAddressToBytes32(inputs.srcToken).toString("hex")}`,
    `0x${addressOrBase58ToBytes32(inputs.dstToken).toString("hex")}`,
    inputAmount,
    outputAmount,
    BigInt(acrossChainIdForHunch(inputs.dstChainId)),
    `0x${exclusiveRelayer.toString("hex")}`,
    fields.timestamp,
    fields.fillDeadline,
    fields.exclusivityParameter,
    "0x",
  ]);
  const approvalData = ERC20_INTERFACE.encodeFunctionData("approve", [
    spokePoolAddress,
    inputAmount,
  ]);

  return {
    ...quote,
    tx: {
      kind: "evm",
      to: spokePoolAddress,
      data,
      value: "0",
      chainId: inputs.srcChainId,
    },
    approvalTxns: [
      {
        to: inputs.srcToken,
        data: approvalData,
        value: "0",
        chainId: inputs.srcChainId,
      },
    ],
  };
}

export async function normalizeAcrossSolanaSourceQuoteResponse(inputs: {
  payload: unknown;
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
  amountIn: string;
  senderAddress: string;
  recipientAddress: string;
  integratorId: string;
  latestBlockhash?: { blockhash: string; lastValidBlockHeight: number } | null;
}): Promise<Record<string, unknown>> {
  const { fields, quote } = buildAcrossSuggestedFeesBase(inputs);
  const signer = new PublicKey(inputs.senderAddress);
  const recipient = addressOrBase58ToPublicKey(inputs.recipientAddress);
  const inputToken = new PublicKey(inputs.srcToken);
  const outputToken = addressOrBase58ToPublicKey(inputs.dstToken);
  const inputAmount = BigInt(inputs.amountIn);
  const outputAmount = intToBytes32Be(BigInt(fields.outputAmount));
  const destinationChainId = BigInt(acrossChainIdForHunch(inputs.dstChainId));
  const exclusiveRelayer = fields.exclusiveRelayerRaw
    ? addressOrBase58ToPublicKey(fields.exclusiveRelayerRaw)
    : PublicKey.default;
  const message = Buffer.alloc(0);
  const programId = new PublicKey(ACROSS_SOLANA_SPOKE_POOL);
  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("state"), u64Le(ACROSS_SOLANA_STATE_SEED)],
    programId,
  );
  const depositData = {
    depositor: signer,
    recipient,
    inputToken,
    outputToken,
    inputAmount,
    outputAmount,
    destinationChainId,
    exclusiveRelayer,
    quoteTimestamp: fields.timestamp,
    fillDeadline: fields.fillDeadline,
    exclusivityParameter: fields.exclusivityParameter,
    message,
  };
  const seedHash = deriveSolanaDepositSeedHash(depositData);
  const [delegatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("delegate"), seedHash],
    programId,
  );
  const depositorTokenAccount = getAssociatedTokenAddressSync(
    inputToken,
    signer,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const vault = getAssociatedTokenAddressSync(
    inputToken,
    statePda,
    true,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const decimals =
    normalizeAddress(inputs.srcToken) ===
    "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v"
      ? 6
      : await fetchSolanaMintDecimals({
          rpcUrls: env.solanaRpcUrls,
          mint: inputs.srcToken,
          timeoutMs: env.solanaRpcTimeoutMs,
        });
  const approveIx = createApproveCheckedInstruction(
    depositorTokenAccount,
    inputToken,
    delegatePda,
    signer,
    inputAmount,
    decimals,
    [],
    TOKEN_PROGRAM_ID,
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId,
  );
  const depositIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: delegatePda, isSigner: false, isWritable: false },
      { pubkey: depositorTokenAccount, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: inputToken, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
    ],
    data: buildSolanaDepositInstructionData(depositData),
  });
  const tx = new Transaction().add(approveIx, depositIx);
  if (inputs.integratorId.trim()) {
    tx.add(
      new TransactionInstruction({
        programId: new PublicKey(SOLANA_MEMO_PROGRAM_ID),
        keys: [{ pubkey: signer, isSigner: true, isWritable: true }],
        data: Buffer.from(inputs.integratorId.trim(), "utf8"),
      }),
    );
  }
  const blockhash =
    inputs.latestBlockhash ??
    (await fetchSolanaLatestBlockhash({
      rpcUrls: env.solanaRpcUrls,
      timeoutMs: env.solanaRpcTimeoutMs,
    }));
  if (!blockhash) {
    throw new Error("Solana RPC did not return latest blockhash");
  }
  tx.feePayer = signer;
  tx.recentBlockhash = blockhash.blockhash;
  const serialized = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");

  return {
    ...quote,
    tx: {
      kind: "solana",
      data: serialized,
      chainId: inputs.srcChainId,
    },
    approvalTxns: [],
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  };
}

function normalizeAcrossWarnings(payload: unknown): Array<{
  code: string;
  message: string;
}> {
  if (!isRecord(payload) || !isRecord(payload.checks)) return [];
  const warnings: Array<{ code: string; message: string }> = [];
  const checks = payload.checks;
  for (const [key, value] of Object.entries(checks)) {
    if (!isRecord(value)) continue;
    const isSatisfied =
      typeof value.isSatisfied === "boolean"
        ? value.isSatisfied
        : typeof value.ok === "boolean"
          ? value.ok
          : true;
    if (isSatisfied) continue;
    const message =
      readString(value.message) ??
      readString(value.reason) ??
      `${key} check failed`;
    warnings.push({ code: `across_${key}`, message });
  }
  return warnings;
}

export function normalizeAcrossQuoteResponse(inputs: {
  payload: unknown;
  swapType: BridgeSwapType;
  srcChainId: string;
  dstChainId: string;
  srcToken: string;
  dstToken: string;
}): Record<string, unknown> {
  const payload = isRecord(inputs.payload) ? inputs.payload : {};
  const normalizedTx = normalizeAcrossTx(payload.swapTx, inputs.srcChainId);
  const approvalTxns = normalizeAcrossApprovalTxns(
    payload.approvalTxns,
    inputs.srcChainId,
  );
  const inputAmount = readNumberishString(payload.inputAmount);
  const expectedOutputAmount = readNumberishString(
    payload.expectedOutputAmount,
  );
  const minOutputAmount = readNumberishString(payload.minOutputAmount);
  const inputToken = isRecord(payload.inputToken) ? payload.inputToken : null;
  const outputToken = isRecord(payload.outputToken)
    ? payload.outputToken
    : null;

  return {
    provider: "across",
    swapType: inputs.swapType,
    id: readString(payload.id),
    tx: normalizedTx,
    approvalTxns,
    checks: payload.checks ?? null,
    fees: payload.fees ?? null,
    inputAmount,
    expectedOutputAmount,
    minOutputAmount,
    quoteExpiryTimestamp: readOptionalNumber(payload.quoteExpiryTimestamp),
    estimation: {
      srcChainTokenIn: {
        address: inputs.srcToken,
        chainId: Number(inputs.srcChainId),
        amount: inputAmount,
        decimals: readOptionalNumber(inputToken?.decimals),
        name: readString(inputToken?.name),
        symbol: readString(inputToken?.symbol),
      },
      dstChainTokenOut: {
        address: inputs.dstToken,
        chainId: Number(inputs.dstChainId),
        amount: minOutputAmount ?? expectedOutputAmount,
        decimals: readOptionalNumber(outputToken?.decimals),
        name: readString(outputToken?.name),
        symbol: readString(outputToken?.symbol),
      },
    },
    warnings: normalizeAcrossWarnings(payload),
    fixFee: null,
    protocolFee: null,
  };
}

export function getAcrossExecutionError(
  payload: Record<string, unknown>,
): string | null {
  const tx = payload.tx;
  if (!isRecord(tx))
    return "Across response did not include an executable transaction";
  const kind = tx.kind;
  if (kind === "solana") {
    return typeof tx.data === "string" && tx.data.trim().length > 0
      ? null
      : "Across Solana response did not include a serialized transaction";
  }
  if (kind === "evm") {
    if (typeof tx.to !== "string" || !ethers.isAddress(tx.to)) {
      return "Across EVM response did not include a valid target address";
    }
    if (typeof tx.data !== "string" || !tx.data.startsWith("0x")) {
      return "Across EVM response did not include valid calldata";
    }
    return null;
  }
  return "Across response returned an unsupported transaction kind";
}

export function normalizeAcrossStatus(
  status: string | null | undefined,
): string | null {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "filled") return "fulfilled";
  if (normalized === "pending") return "submitted";
  if (normalized === "expired") return "expired";
  if (normalized === "refunded") return "refunded";
  if (normalized === "failed") return "failed";
  return normalized;
}

export function normalizeAcrossStatusPayload(
  payload: unknown,
): Record<string, unknown> {
  const record = isRecord(payload) ? { ...payload } : {};
  const providerStatus = readString(record.status);
  const normalizedStatus = normalizeAcrossStatus(providerStatus);
  return {
    ...record,
    providerStatus,
    status: normalizedStatus ?? providerStatus ?? "submitted",
  };
}
