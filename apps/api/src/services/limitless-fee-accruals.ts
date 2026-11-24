import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";
import { env } from "../env.js";
import {
  normalizeLimitlessRawTokenId,
  normalizeLimitlessScopedTokenId,
} from "../lib/limitless-token.js";
import { withRewardsChainLocks } from "../lib/rewards-locks.js";
import { usdcMicroToDecimalString } from "../lib/usdc.js";
import { fetchActiveFeePolicy } from "../repos/fee-policy.js";
import { retainLimitlessFeeReceiptLocators } from "../repos/orders-repo.js";
import {
  fetchLimitlessHistoryReceiptLocators,
  limitlessFrozenCollateralSql,
} from "../repos/limitless-history-receipt-locators.js";
import { isRecord } from "../lib/type-guards.js";
import { createEvmRpcProvider } from "./rpc-client-factory.js";
import { parseLimitlessOrderResult } from "./limitless-order-result.js";
import {
  buildLimitlessClobSubmissionContext,
  LIMITLESS_COLLATERAL_ATTEMPT_PROGRAM,
  limitlessClobFrozenContext,
  limitlessClobSubmittedOrder,
  readLimitlessHistoryTxHashes,
  resolveLimitlessClobEvidenceIdentity,
} from "./limitless-clob-evidence-identity.js";
import { resolveLimitlessMarketExchangeAddress } from "./limitless-market-contracts.js";
import {
  readCanonicalFinalizedBuyReceipt,
  type VerifiedBuyEvmProvider,
} from "./verified-buy-evm-receipt.js";
import {
  fetchLimitlessOrderStatusBatch as fetchSharedLimitlessOrderStatusBatch,
  type LimitlessOrderStatusItem,
} from "./limitless-order-status.js";
import {
  clearVenueFeeBackfillAttempts,
  markVenueFeeBackfillAttempts,
  insertVerifiedLimitlessCollateralAccruals,
  unlockVenueFeeAccruals,
  upsertVenueFeeAccruals,
  type VenueFeeBackfillAttemptInput,
  type VenueFeeAccrualInput,
} from "./venue-fee-accruals.js";
import {
  buildLimitlessContractFeeReceivableInput,
  reconcileLimitlessContractFeeReceivables,
  syncLimitlessContractReceivablesFromAccruals,
  upsertLimitlessContractFeeReceivables,
  type LimitlessContractFeeReceivableInput,
} from "./limitless-contract-fee-receivables.js";

const BASE_CHAIN_ID = "8453";
const LIMITLESS_VENUE = "limitless";
const LIMITLESS_FEE_PROGRAM = "venue_share";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTLED_STATUSES = new Set(["MINED", "CONFIRMED"]);
const FAILED_STATUSES = new Set(["FAILED"]);
const BACKFILL_RETRY_DELAY_MS = 15 * 60 * 1000;
const COLLATERAL_CAPACITY_RETRY_MS = 2 * 60_000;
const feeObservationCursor = new Map<string, string>();
const MAX_FEE_LOCATOR_CURSORS = 512;
const BACKFILL_MAX_RETRY_ATTEMPTS = 8;
const COLLATERAL_RPC_BUDGET_EXHAUSTED =
  "Limitless collateral fee RPC budget exhausted";
const LIMITLESS_USD_FEE_RECEIPT_REQUIRED = "Limitless USD fee receipt required";
const ZERO_ASSET_ID = "0";
const LIMITLESS_ORDER_FILLED_EVENT =
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)";
const LIMITLESS_FEE_CHARGED_EVENT =
  "event FeeCharged(address indexed receiver, uint256 tokenId, uint256 amount)";
const LIMITLESS_FEE_REFUNDED_EVENT =
  "event FeeRefunded(address token, address to, uint256 id, uint256 amount)";
const limitlessOrderFilledInterface = new ethers.Interface([
  LIMITLESS_ORDER_FILLED_EVENT,
]);
const limitlessFeeChargedInterface = new ethers.Interface([
  LIMITLESS_FEE_CHARGED_EVENT,
]);
const limitlessFeeRefundedInterface = new ethers.Interface([
  LIMITLESS_FEE_REFUNDED_EVENT,
]);
const collateralFeeTopic =
  "0x363a587c4640b524767666acd46b6600a7308a3692b1c11c2f5a930318e04866";
const erc20TransferInterface = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const erc20TransferTopic = ethers.id("Transfer(address,address,uint256)");

function collateralFeeContext(
  payload: unknown,
): Record<string, unknown> | null {
  const context = isRecord(payload)
    ? limitlessClobFrozenContext(payload)
    : null;
  return isRecord(context) && Object.hasOwn(context, "collateralFeeModule")
    ? context
    : null;
}

export type LimitlessFeeShareConfig = {
  active: boolean;
  shareBps: number;
  effectiveAt: Date | null;
  source: "db" | "env";
};

export type { LimitlessOrderStatusItem } from "./limitless-order-status.js";

export type LimitlessAccrualOrderRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  signer_address: string | null;
  venue_order_id: string;
  order_hash: string | null;
  token_id: string | null;
  side: "BUY" | "SELL" | null;
  order_type?: string | null;
  filled_at: Date | null;
  last_update: Date | null;
  posted_at: Date | null;
  order_payload?: unknown | null;
  client_order_id?: string | null;
  fee_share_bps?: number | null;
};

type LimitlessAccrualRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  signer_address: string | null;
  order_id: string;
  order_hash: string;
  venue_order_id: string | null;
  token_id: string | null;
  side: "BUY" | "SELL" | null;
  fee_rate_bps: number;
  filled_at: Date | null;
  last_update: Date | null;
  posted_at: Date | null;
  tx_hash: string | null;
  order_payload?: unknown | null;
};

type LimitlessAccrualBuildResult = {
  accrual: VenueFeeAccrualInput | null;
  receivable: LimitlessContractFeeReceivableInput | null;
  attempt: {
    status: VenueFeeBackfillAttemptInput["status"];
    reason: string;
    retryable: boolean;
  } | null;
};

type LimitlessLogLike = {
  address: string;
  topics: readonly string[];
  data: string;
  index?: number;
};

type ParsedLimitlessOrderFilledLog = {
  address: string;
  logIndex: number;
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee: bigint;
};

type ParsedLimitlessFeeChargedLog = {
  address: string;
  logIndex: number;
  receiver: string;
  tokenId: string;
  amount: bigint;
};

type ParsedLimitlessFeeRefundedLog = {
  address: string;
  logIndex: number;
  token: string;
  to: string;
  id: string;
  amount: bigint;
};

function hasPositiveContractsFee(totals: Record<string, unknown>): boolean {
  const contractsFee = rawDigits(totals.contractsFee);
  return contractsFee != null && contractsFee > 0n;
}

function limitlessUsdFeeFailureReason(
  totals: Record<string, unknown> | null,
  venueFeeRaw: bigint | null,
  notionalRaw: bigint | null,
): string {
  if (!totals) return "Limitless fee totals missing";
  if (venueFeeRaw == null) return "Limitless USD fee total missing";
  if (venueFeeRaw <= 0n && hasPositiveContractsFee(totals)) {
    return "Limitless fee was contract-denominated; not unlockable as USDC";
  }
  if (venueFeeRaw <= 0n) return "Limitless USD fee is zero";
  if (notionalRaw == null || notionalRaw <= 0n) {
    return "Limitless USD notional missing or zero";
  }
  return "Limitless fee totals missing or zero";
}

function clampShareBps(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return 0;
  return Math.min(Math.max(Math.trunc(value ?? 0), 0), 10_000);
}

function rawDigits(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return ethers.getAddress(value).toLowerCase();
  } catch {
    return null;
  }
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (normalized === "BUY") return "BUY";
    if (normalized === "SELL") return "SELL";
  }
  const parsed = numberOrNull(value);
  if (parsed === 0) return "BUY";
  if (parsed === 1) return "SELL";
  return null;
}

function extractStatusData(
  result: Record<string, unknown>,
): Record<string, unknown> | null {
  const data = isRecord(result.data) ? result.data : null;
  return data;
}

function extractOrderRecord(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const orderWrapper = isRecord(data.order) ? data.order : null;
  if (orderWrapper && isRecord(orderWrapper.order)) return orderWrapper.order;
  return orderWrapper;
}

function extractExecutionRecord(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  if (isRecord(data.execution)) return data.execution;
  const orderWrapper = isRecord(data.order) ? data.order : null;
  if (orderWrapper && isRecord(orderWrapper.execution)) {
    return orderWrapper.execution;
  }
  return null;
}

/** Old/provider-only records have no trusted module. A zero signing rate
 * paired with a positive USD fee cannot use legacy status-only verification. */
function statusNeedsCollateralProof(
  data: Record<string, unknown>,
  execution: Record<string, unknown>,
): boolean {
  const usdFee = rawDigits(extractTotalsRaw(execution)?.usdFee) ?? 0n;
  const rates = [execution.feeRateBps, extractOrderRecord(data)?.feeRateBps]
    .map(numberOrNull)
    .filter((value): value is number => value != null);
  return usdFee > 0n && (!rates.length || rates.some((value) => value <= 0));
}

/** A provider execution rate is not the signed fee policy. Only a locally
 * frozen positive-rate order is eligible for the legacy no-tx lane. */
export function hasTrustedLimitlessLegacyFeeRate(payload: unknown): boolean {
  return trustedLimitlessLegacyIdentity(payload) !== null;
}

function trustedLimitlessLegacyIdentity(payload: unknown) {
  if (!isRecord(payload) || collateralFeeContext(payload)) return null;
  const context = limitlessClobFrozenContext(payload);
  const localOrder = limitlessClobSubmittedOrder(payload);
  if (
    !isRecord(context) ||
    !localOrder ||
    (rawDigits(localOrder.feeRateBps) ?? 0n) <= 0n
  )
    return null;
  return resolveLimitlessClobEvidenceIdentity({
    orderPayload: payload,
    marketMetadata: null,
    legacyExchangeAddress: "",
    providerOrder: {},
  });
}

/** Before fee context was frozen for all direct orders, the server stored
 * the original signed request under order/submitted. The current catalog
 * is only a domain candidate: require its exact signature and receipt fill.
 * Never import a signing domain, fee rate or signature from the status API. */
async function recoverLegacyFeeOrderPayload(
  db: Pick<Pool, "query">,
  order: Pick<
    LimitlessAccrualOrderRow,
    "order_payload" | "wallet_address" | "signer_address" | "token_id" | "side"
  >,
): Promise<unknown> {
  const payload = order.order_payload;
  if (!isRecord(payload) || limitlessClobFrozenContext(payload) !== undefined)
    return payload;
  const signed = limitlessClobSubmittedOrder(payload);
  const tokenId = normalizeLimitlessScopedTokenId(order.token_id);
  const maker = normalizeAddress(signed?.maker);
  const signer = normalizeAddress(signed?.signer);
  if (
    !signed ||
    !tokenId ||
    typeof signed.signature !== "string" ||
    !maker ||
    !signer ||
    normalizeAddress(order.wallet_address) !== maker ||
    normalizeAddress(order.signer_address ?? order.wallet_address) !== signer ||
    (rawDigits(signed.feeRateBps) ?? 0n) <= 0n ||
    normalizeLimitlessScopedTokenId(rawDigits(signed.tokenId)) !== tokenId ||
    normalizeSide(signed.side) !== order.side
  )
    return payload;
  const { rows } = await db.query<{ metadata: unknown }>(
    `select market_row.metadata from unified_tokens token_row
      join unified_markets market_row on market_row.id=token_row.market_id
      where token_row.venue='limitless' and token_row.token_id=$1 limit 1`,
    [tokenId],
  );
  const exchange = resolveLimitlessMarketExchangeAddress(
    rows[0]?.metadata,
    env.limitlessClobAddress,
  );
  if (!exchange) return payload;
  try {
    const context = buildLimitlessClobSubmissionContext(exchange, signed);
    if (
      ethers
        .recoverAddress(context.orderHash, signed.signature)
        .toLowerCase() !== signer
    )
      return payload;
    return { ...payload, _hunchLimitlessClob: context };
  } catch {
    return payload;
  }
}

function extractTotalsRaw(
  execution: Record<string, unknown>,
): Record<string, unknown> | null {
  return isRecord(execution.totalsRaw) ? execution.totalsRaw : null;
}

function extractStoredLimitlessUpstreamPayload(
  payload: unknown,
): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload._hunchUpstream)) return payload._hunchUpstream;
  if (
    isRecord(payload.submitted) &&
    isRecord(payload.submitted._hunchUpstream)
  ) {
    return payload.submitted._hunchUpstream;
  }
  return null;
}

export function extractTxHashFromLimitlessStatus(
  status: LimitlessOrderStatusItem,
): string | null {
  return normalizeHash(parseLimitlessOrderResult(status.payload).txHash);
}

function shouldTryReceiptForStatusResult(
  result: LimitlessAccrualBuildResult,
): boolean {
  return Boolean(
    result.attempt?.reason.includes("contract-denominated") ||
    result.attempt?.reason.includes("USD fee total missing") ||
    result.attempt?.reason === "Limitless collateral fee provenance missing",
  );
}

export function buildStoredLimitlessOrderStatusItem(
  order: Pick<
    LimitlessAccrualOrderRow,
    "venue_order_id" | "client_order_id" | "order_payload"
  >,
): LimitlessOrderStatusItem | null {
  const upstream = extractStoredLimitlessUpstreamPayload(order.order_payload);
  if (!upstream) return null;
  if (upstream.status === "found" && isRecord(upstream.data)) {
    if (upstream.orderId !== order.venue_order_id) return null;
    return { orderId: order.venue_order_id, payload: upstream };
  }
  return {
    orderId: order.venue_order_id,
    payload: {
      status: "found",
      orderId: order.venue_order_id,
      clientOrderId: order.client_order_id ?? undefined,
      data: upstream,
    },
  };
}

function deriveUsdGrossRaw(totals: Record<string, unknown>): bigint | null {
  const usdGross = rawDigits(totals.usdGross);
  if (usdGross != null) return usdGross;
  const usdNet = rawDigits(totals.usdNet);
  const usdFee = rawDigits(totals.usdFee);
  if (usdNet != null && usdFee != null) return usdNet + usdFee;
  return null;
}

function floorBps(rawMicro: bigint, bps: number): bigint {
  if (rawMicro <= 0n || bps <= 0) return 0n;
  return (rawMicro * BigInt(bps)) / 10_000n;
}

function microToDecimal(rawMicro: bigint): string {
  return usdcMicroToDecimalString(rawMicro);
}

function looksLikeEvmTxHash(value: string | null | undefined): boolean {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isFilledOrderWithKnownTx(row: LimitlessAccrualOrderRow): boolean {
  return (
    looksLikeEvmTxHash(row.order_hash) &&
    Boolean(row.filled_at ?? row.last_update ?? row.posted_at)
  );
}

function parseLimitlessOrderFilledLog(
  log: LimitlessLogLike,
  fallbackIndex: number,
): ParsedLimitlessOrderFilledLog | null {
  try {
    const parsed = limitlessOrderFilledInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed || parsed.name !== "OrderFilled") return null;
    const address = normalizeAddress(log.address);
    const maker = normalizeAddress(parsed.args.maker);
    const taker = normalizeAddress(parsed.args.taker);
    const orderHash = normalizeHash(parsed.args.orderHash);
    if (!address || !maker || !taker || !orderHash) return null;
    return {
      address,
      logIndex: log.index ?? fallbackIndex,
      orderHash,
      maker,
      taker,
      makerAssetId: (parsed.args.makerAssetId as bigint).toString(),
      takerAssetId: (parsed.args.takerAssetId as bigint).toString(),
      makerAmountFilled: parsed.args.makerAmountFilled as bigint,
      takerAmountFilled: parsed.args.takerAmountFilled as bigint,
      fee: parsed.args.fee as bigint,
    };
  } catch {
    return null;
  }
}

function parseLimitlessFeeChargedLog(
  log: LimitlessLogLike,
  fallbackIndex: number,
): ParsedLimitlessFeeChargedLog | null {
  try {
    const parsed = limitlessFeeChargedInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed || parsed.name !== "FeeCharged") return null;
    const address = normalizeAddress(log.address);
    const receiver = normalizeAddress(parsed.args.receiver);
    if (!address || !receiver) return null;
    return {
      address,
      logIndex: log.index ?? fallbackIndex,
      receiver,
      tokenId: (parsed.args.tokenId as bigint).toString(),
      amount: parsed.args.amount as bigint,
    };
  } catch {
    return null;
  }
}

function parseLimitlessFeeRefundedLog(
  log: LimitlessLogLike,
  fallbackIndex: number,
): ParsedLimitlessFeeRefundedLog | null {
  try {
    const parsed = limitlessFeeRefundedInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });
    if (!parsed || parsed.name !== "FeeRefunded") return null;
    const address = normalizeAddress(log.address);
    const token = normalizeAddress(parsed.args.token);
    const to = normalizeAddress(parsed.args.to);
    if (!address || !token || !to) return null;
    return {
      address,
      logIndex: log.index ?? fallbackIndex,
      token,
      to,
      id: (parsed.args.id as bigint).toString(),
      amount: parsed.args.amount as bigint,
    };
  } catch {
    return null;
  }
}

function limitlessSideAssetMatches(
  log: ParsedLimitlessOrderFilledLog,
  side: "BUY" | "SELL" | null,
  tokenId: string | null,
): boolean {
  const rawTokenId = normalizeLimitlessRawTokenId(tokenId);
  if (!side) return true;
  if (side === "BUY") {
    return (
      log.makerAssetId === ZERO_ASSET_ID &&
      (!rawTokenId || log.takerAssetId === rawTokenId)
    );
  }
  return (
    log.takerAssetId === ZERO_ASSET_ID &&
    (!rawTokenId || log.makerAssetId === rawTokenId)
  );
}

function scoreLimitlessOrderFilledLog(
  log: ParsedLimitlessOrderFilledLog,
  inputs: {
    side: "BUY" | "SELL" | null;
    tokenId: string | null;
    walletAddresses: Set<string>;
  },
): number {
  let score = 0;
  if (inputs.walletAddresses.has(log.maker)) score += 100;
  if (inputs.walletAddresses.has(log.taker)) score += 30;
  if (limitlessSideAssetMatches(log, inputs.side, inputs.tokenId)) score += 60;
  if (
    normalizeLimitlessRawTokenId(inputs.tokenId) &&
    (log.makerAssetId === normalizeLimitlessRawTokenId(inputs.tokenId) ||
      log.takerAssetId === normalizeLimitlessRawTokenId(inputs.tokenId))
  ) {
    score += 20;
  }
  if (log.fee > 0n) score += 5;
  return score;
}

function findLimitlessFeeChargedForOrder(
  orderLog: ParsedLimitlessOrderFilledLog,
  feeLogs: ParsedLimitlessFeeChargedLog[],
): ParsedLimitlessFeeChargedLog | null {
  const candidates = feeLogs
    .filter(
      (log) =>
        log.address === orderLog.address &&
        log.amount === orderLog.fee &&
        log.logIndex <= orderLog.logIndex,
    )
    .sort((a, b) => b.logIndex - a.logIndex);
  return candidates[0] ?? null;
}

function findLimitlessFeeRefundedForFee(
  feeLog: ParsedLimitlessFeeChargedLog | null,
  tokenId: string,
  amount: bigint,
  refundLogs: ParsedLimitlessFeeRefundedLog[],
): ParsedLimitlessFeeRefundedLog | null {
  if (!feeLog) return null;
  const conditionalTokensAddress = normalizeAddress(
    env.limitlessConditionalTokensAddress,
  );
  const candidates = refundLogs
    .filter(
      (log) =>
        log.address === feeLog.receiver &&
        log.id === tokenId &&
        log.amount === amount &&
        log.logIndex >= feeLog.logIndex &&
        (!conditionalTokensAddress || log.token === conditionalTokensAddress),
    )
    .sort((a, b) => a.logIndex - b.logIndex);
  return candidates[0] ?? null;
}

function usdNotionalRawFromLimitlessLog(
  log: ParsedLimitlessOrderFilledLog,
): bigint | null {
  if (log.makerAssetId === ZERO_ASSET_ID) return log.makerAmountFilled;
  if (log.takerAssetId === ZERO_ASSET_ID) return log.takerAmountFilled;
  return null;
}

// Wire layout observed on Base, BUY 0x6dc5d11186a012965f75caa54b19442b06993e1ad88f44e59ac9502f48548016
// and SELL 0xf3c4ef69e4954e4f957c1cb30a857e5de6d76bc18e6f92ba541a634556b98aa8.
// The module event is not itself proof of a debit: pair it with the exact
// Base USDC transfer, and with the signed taker order's fill on its exchange.
function readLimitlessCollateralFeeProof(input: {
  module: string;
  fill: ParsedLimitlessOrderFilledLog;
  side: "BUY" | "SELL";
  logs: LimitlessLogLike[];
}): { fee: bigint; notional: bigint; logIndex: number } | null {
  const { fill, logs } = input;
  const tokenId = input.side === "BUY" ? fill.takerAssetId : fill.makerAssetId;
  const isChargeForOrder = (log: LimitlessLogLike) =>
    log.address.toLowerCase() === input.module &&
    log.topics[0] === collateralFeeTopic &&
    log.topics[1]?.toLowerCase() === fill.orderHash;
  const index = logs.findIndex(isChargeForOrder);
  if (
    index < 0 ||
    logs.some(
      (candidate, otherIndex) =>
        otherIndex > index && isChargeForOrder(candidate),
    )
  )
    return null;
  const log = logs[index];
  if (
    !log ||
    log.index == null ||
    !Number.isSafeInteger(log.index) ||
    log.topics.length !== 4 ||
    log.index <= fill.logIndex
  )
    return null;
  try {
    if (
      !/^0x0{24}[\da-f]{40}$/i.test(log.topics[2]) ||
      !ethers.isHexString(log.topics[3], 32) ||
      normalizeAddress(
        ethers.getAddress(ethers.dataSlice(log.topics[2], 12)),
      ) !== fill.maker ||
      BigInt(log.topics[3]).toString() !== tokenId ||
      ethers.dataLength(log.data) !== 32 * 8
    )
      return null;
    const [side, makerAmount, netNotional, shares, fee, , recipient] =
      ethers.AbiCoder.defaultAbiCoder().decode(
        [
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "uint256",
          "address",
          "address",
        ],
        log.data,
      ) as unknown as [
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
        string,
        string,
      ];
    const fillNotional = usdNotionalRawFromLimitlessLog(fill);
    const feeRecipient = normalizeAddress(recipient);
    if (
      side !== (input.side === "BUY" ? 0n : 1n) ||
      makerAmount !== fill.makerAmountFilled ||
      shares !==
        (input.side === "BUY"
          ? fill.takerAmountFilled
          : fill.makerAmountFilled) ||
      netNotional <= 0n ||
      fillNotional == null ||
      netNotional > fillNotional ||
      !feeRecipient ||
      feeRecipient === fill.maker ||
      fee <= 0n
    )
      return null;
    const transfer = logs[index - 1];
    if (
      !transfer ||
      (transfer.index ?? index - 1) !== (log.index ?? index) - 1 ||
      transfer.address.toLowerCase() !==
        env.limitlessUsdcAddress.toLowerCase() ||
      transfer.topics[0] !== erc20TransferTopic ||
      transfer.topics.length !== 3 ||
      !/^0x0{24}[\da-f]{40}$/i.test(transfer.topics[1]) ||
      !/^0x0{24}[\da-f]{40}$/i.test(transfer.topics[2]) ||
      !ethers.isHexString(transfer.data, 32)
    )
      return null;
    const paid = erc20TransferInterface.parseLog({
      data: transfer.data,
      topics: [...transfer.topics],
    });
    if (
      !paid ||
      normalizeAddress(paid.args[0]) !== fill.maker ||
      normalizeAddress(paid.args[1]) !== feeRecipient ||
      paid.args[2] !== fee
    )
      return null;
    return { fee, notional: netNotional, logIndex: log.index };
  } catch {
    return null;
  }
}

function effectiveBpsFromRaw(
  feeRaw: bigint,
  notionalRaw: bigint,
): number | null {
  if (feeRaw <= 0n || notionalRaw <= 0n) return null;
  const value = (feeRaw * 10_000n) / notionalRaw;
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function settlementStatus(execution: Record<string, unknown>): string | null {
  const status = textOrNull(execution.settlementStatus);
  return status ? status.toUpperCase() : null;
}

export function buildLimitlessVenueShareAccrualResult(inputs: {
  order: LimitlessAccrualOrderRow;
  status: LimitlessOrderStatusItem;
  config: LimitlessFeeShareConfig;
}): LimitlessAccrualBuildResult {
  const terminal = (
    reason: string,
    status: VenueFeeBackfillAttemptInput["status"] = "skipped",
  ): LimitlessAccrualBuildResult => ({
    accrual: null,
    receivable: null,
    attempt: {
      status,
      reason,
      retryable: status === "retry",
    },
  });
  const retry = (reason: string): LimitlessAccrualBuildResult =>
    terminal(reason, "retry");

  if (!inputs.config.active) return terminal("Limitless fee share inactive");
  if (collateralFeeContext(inputs.order.order_payload))
    return retry("Limitless collateral fee requires a finalized receipt");
  const data = extractStatusData(inputs.status.payload);
  if (!data) return retry("Limitless order status data missing");
  const execution = extractExecutionRecord(data);
  if (!execution) return retry("Limitless execution missing");
  if (statusNeedsCollateralProof(data, execution))
    return retry("Limitless collateral fee provenance missing");
  if (execution.matched !== true) return retry("Limitless order not matched");
  const status = settlementStatus(execution);
  if (!status) return retry("Limitless settlement status missing");
  if (FAILED_STATUSES.has(status)) {
    return terminal("Limitless settlement failed", "failed");
  }
  if (!SETTLED_STATUSES.has(status)) {
    return retry(`Limitless settlement is ${status}`);
  }
  const totals = extractTotalsRaw(execution);
  if (!totals) return terminal("Limitless fee totals missing");

  const orderRecord = extractOrderRecord(data);
  const side = normalizeSide(orderRecord?.side) ?? inputs.order.side;
  if (!side) return terminal("Limitless order side missing");
  const venueOrderId =
    textOrNull(inputs.status.payload.orderId) ?? inputs.order.venue_order_id;
  if (!venueOrderId) return retry("Limitless order id missing");
  const tokenId = textOrNull(orderRecord?.tokenId) ?? inputs.order.token_id;
  const filledAt =
    inputs.order.filled_at ??
    inputs.order.last_update ??
    inputs.order.posted_at ??
    new Date();

  const venueFeeRaw = rawDigits(totals.usdFee);
  const contractsFeeRaw = rawDigits(totals.contractsFee);
  const notionalRaw = deriveUsdGrossRaw(totals);
  if (contractsFeeRaw != null && contractsFeeRaw > 0n) {
    if (venueFeeRaw != null && venueFeeRaw > 0n) {
      return terminal(
        "Limitless fee totals include both USD and contracts fees",
      );
    }
    if (side !== "BUY") {
      return terminal("Limitless contracts fee is only expected on buys");
    }
    if (!tokenId) return retry("Limitless contracts fee token missing");
    const feeRaw = floorBps(contractsFeeRaw, inputs.config.shareBps);
    if (feeRaw <= 0n) return terminal("Limitless fee share is zero");

    return {
      accrual: null,
      receivable: buildLimitlessContractFeeReceivableInput({
        userId: inputs.order.user_id,
        walletAddress: inputs.order.wallet_address,
        signerAddress: inputs.order.signer_address,
        orderId: inputs.order.id,
        orderHash: inputs.order.order_hash ?? venueOrderId,
        venueOrderId,
        txHash: textOrNull(execution.txHash),
        logIndex: null,
        feeChargedLogIndex: null,
        feeRefundedLogIndex: null,
        feeReceiverAddress: null,
        rawTokenId: tokenId,
        side,
        role: "taker",
        feeRateBps: inputs.config.shareBps,
        grossTokenAmountRaw: contractsFeeRaw.toString(),
        receivableTokenAmountRaw: feeRaw.toString(),
        filledAt,
        sourceKind: "status",
      }),
      attempt: null,
    };
  }

  if (venueFeeRaw == null || notionalRaw == null) {
    return terminal(
      limitlessUsdFeeFailureReason(totals, venueFeeRaw, notionalRaw),
    );
  }
  const feeRaw = floorBps(venueFeeRaw, inputs.config.shareBps);
  if (venueFeeRaw <= 0n || notionalRaw <= 0n) {
    return terminal(
      limitlessUsdFeeFailureReason(totals, venueFeeRaw, notionalRaw),
    );
  }
  if (feeRaw <= 0n) return terminal("Limitless fee share is zero");

  const venueTradeId = textOrNull(execution.tradeEventId);
  const txHash = textOrNull(execution.txHash);
  const venueFillId = venueTradeId ?? txHash ?? venueOrderId;
  const venueFeeRateBps = numberOrNull(execution.feeRateBps);
  const venueEffectiveFeeBps = numberOrNull(execution.effectiveFeeBps);

  return {
    accrual: {
      userId: inputs.order.user_id,
      walletAddress: inputs.order.wallet_address,
      signerAddress: inputs.order.signer_address,
      venue: LIMITLESS_VENUE,
      feeProgram: LIMITLESS_FEE_PROGRAM,
      chainId: BASE_CHAIN_ID,
      orderId: inputs.order.id,
      orderHash: inputs.order.order_hash ?? venueOrderId,
      venueOrderId,
      venueFillId,
      venueTradeId,
      txHash,
      tokenId,
      side,
      role: "taker",
      attributionCode: null,
      feeRateBps: inputs.config.shareBps,
      feeBasis: "venue_fee_share",
      notionalAmountRaw: notionalRaw.toString(),
      notionalAmount: microToDecimal(notionalRaw),
      feeAmountRaw: feeRaw.toString(),
      feeAmount: microToDecimal(feeRaw),
      feeAsset: "USDC",
      venueFeeRateBps,
      venueEffectiveFeeBps,
      venueFeeAmountRaw: venueFeeRaw.toString(),
      venueFeeAmount: microToDecimal(venueFeeRaw),
      filledAt,
    },
    receivable: null,
    attempt: null,
  };
}

export function buildLimitlessVenueShareAccrualFromStatus(inputs: {
  order: LimitlessAccrualOrderRow;
  status: LimitlessOrderStatusItem;
  config: LimitlessFeeShareConfig;
}): VenueFeeAccrualInput | null {
  return buildLimitlessVenueShareAccrualResult(inputs).accrual;
}

export function buildLimitlessVenueShareAccrualFromReceiptLogs(inputs: {
  order: LimitlessAccrualOrderRow;
  txHash: string;
  logs: LimitlessLogLike[];
  config: LimitlessFeeShareConfig;
}): LimitlessAccrualBuildResult {
  const terminal = (
    reason: string,
    status: VenueFeeBackfillAttemptInput["status"] = "skipped",
  ): LimitlessAccrualBuildResult => ({
    accrual: null,
    receivable: null,
    attempt: {
      status,
      reason,
      retryable: status === "retry",
    },
  });
  const retry = (reason: string): LimitlessAccrualBuildResult =>
    terminal(reason, "retry");

  if (!inputs.config.active) return terminal("Limitless fee share inactive");
  const txHash = normalizeHash(inputs.txHash);
  if (!txHash) return retry("Limitless transaction hash invalid");

  const walletAddresses = new Set(
    [inputs.order.wallet_address, inputs.order.signer_address]
      .map(normalizeAddress)
      .filter((value): value is string => value != null),
  );
  if (!walletAddresses.size) {
    return retry("Limitless order wallet missing for onchain fee check");
  }
  const frozen = collateralFeeContext(inputs.order.order_payload);
  const legacyIdentity = trustedLimitlessLegacyIdentity(
    inputs.order.order_payload,
  );
  const module = normalizeAddress(frozen?.collateralFeeModule);
  const exchange = normalizeAddress(frozen?.exchangeAddress);
  const signedOrderHash = normalizeHash(frozen?.orderHash);
  if (frozen && inputs.order.order_type !== "FOK")
    return terminal("Limitless collateral GTC fee reconciliation unsupported");
  if (
    frozen &&
    (frozen.chainId !== 8453 ||
      frozen.contextVersion !== 1 ||
      !module ||
      !exchange ||
      module === exchange ||
      !signedOrderHash ||
      !inputs.order.side ||
      !normalizeLimitlessRawTokenId(inputs.order.token_id))
  ) {
    return retry("Limitless collateral fee identity missing");
  }

  const orderLogs = inputs.logs
    .map((log, index) => parseLimitlessOrderFilledLog(log, index))
    .filter((log): log is ParsedLimitlessOrderFilledLog => log != null)
    .filter((log) =>
      frozen
        ? log.address === exchange &&
          log.orderHash === signedOrderHash &&
          walletAddresses.has(log.maker)
        : legacyIdentity
          ? log.address === legacyIdentity.exchangeAddress.toLowerCase() &&
            log.orderHash === legacyIdentity.orderHash &&
            walletAddresses.has(log.maker)
          : walletAddresses.has(log.maker) || walletAddresses.has(log.taker),
    )
    .sort((a, b) => {
      const scoreDelta =
        scoreLimitlessOrderFilledLog(b, {
          side: inputs.order.side,
          tokenId: inputs.order.token_id,
          walletAddresses,
        }) -
        scoreLimitlessOrderFilledLog(a, {
          side: inputs.order.side,
          tokenId: inputs.order.token_id,
          walletAddresses,
        });
      return scoreDelta || a.logIndex - b.logIndex;
    });
  const matching = orderLogs.find((log) =>
    limitlessSideAssetMatches(log, inputs.order.side, inputs.order.token_id),
  );
  if (!matching) return retry("Limitless onchain order fill not found");
  if (module && (orderLogs.length !== 1 || matching.fee !== 0n))
    return retry("Limitless collateral fee fill is ambiguous");
  if (!module && matching.fee <= 0n) {
    // History and older reconciliation records might contain only the
    // provider's fill, not our frozen signing domain. Recognize this conflict
    // as missing proof; an untrusted emitter is never authority to pay it.
    const hasModuleCharge = inputs.logs.some(
      (log) =>
        log.topics[0] === collateralFeeTopic &&
        log.topics[1]?.toLowerCase() === matching.orderHash,
    );
    if (hasModuleCharge)
      return retry("Limitless collateral fee provenance missing");
    return terminal("Limitless onchain fee is zero");
  }
  const side =
    inputs.order.side ??
    (matching.makerAssetId === ZERO_ASSET_ID
      ? "BUY"
      : matching.takerAssetId === ZERO_ASSET_ID
        ? "SELL"
        : null);
  if (!side) return retry("Limitless onchain order side missing");
  const collateralProof = module
    ? readLimitlessCollateralFeeProof({
        module,
        fill: matching,
        side,
        logs: inputs.logs,
      })
    : null;
  if (module && !collateralProof)
    return retry("Limitless collateral fee transfer not verified");
  const venueFee = collateralProof?.fee ?? matching.fee;
  if (venueFee <= 0n) return terminal("Limitless onchain fee is zero");
  const feeLog = module
    ? null
    : findLimitlessFeeChargedForOrder(
        matching,
        inputs.logs
          .map((log, index) => parseLimitlessFeeChargedLog(log, index))
          .filter((log): log is ParsedLimitlessFeeChargedLog => log != null),
      );
  if (!module && !feeLog)
    return retry("Limitless onchain fee charged log not found");
  const feeRaw = floorBps(venueFee, inputs.config.shareBps);
  if (feeRaw <= 0n) return terminal("Limitless fee share is zero");

  if (feeLog && feeLog.tokenId !== ZERO_ASSET_ID) {
    const feeTokenId = feeLog.tokenId;
    const refundLogs = inputs.logs
      .map((log, index) => parseLimitlessFeeRefundedLog(log, index))
      .filter((log): log is ParsedLimitlessFeeRefundedLog => log != null);
    const refundLog = findLimitlessFeeRefundedForFee(
      feeLog,
      feeTokenId,
      matching.fee,
      refundLogs,
    );
    const filledAt =
      inputs.order.filled_at ??
      inputs.order.last_update ??
      inputs.order.posted_at ??
      new Date();
    return {
      accrual: null,
      receivable: buildLimitlessContractFeeReceivableInput({
        userId: inputs.order.user_id,
        walletAddress: inputs.order.wallet_address,
        signerAddress: inputs.order.signer_address,
        orderId: inputs.order.id,
        orderHash: inputs.order.order_hash ?? txHash,
        venueOrderId: inputs.order.venue_order_id,
        txHash,
        logIndex: matching.logIndex,
        feeChargedLogIndex: feeLog.logIndex,
        feeRefundedLogIndex: refundLog?.logIndex ?? null,
        feeReceiverAddress: feeLog.receiver,
        rawTokenId: feeTokenId,
        side,
        role: walletAddresses.has(matching.maker) ? "maker" : "taker",
        feeRateBps: inputs.config.shareBps,
        grossTokenAmountRaw: matching.fee.toString(),
        receivableTokenAmountRaw: feeRaw.toString(),
        filledAt,
        refunded: Boolean(refundLog),
      }),
      attempt: null,
    };
  }

  const notionalRaw =
    collateralProof?.notional ?? usdNotionalRawFromLimitlessLog(matching);
  if (notionalRaw == null || notionalRaw <= 0n) {
    return retry("Limitless onchain USD notional missing or zero");
  }

  const filledAt =
    inputs.order.filled_at ??
    inputs.order.last_update ??
    inputs.order.posted_at ??
    new Date();
  const venueFillId = collateralProof
    ? `collateral:${txHash}:${collateralProof.logIndex}`
    : `${txHash}:${matching.logIndex}`;
  const venueFeeEffectiveBps = effectiveBpsFromRaw(venueFee, notionalRaw);

  return {
    accrual: {
      userId: inputs.order.user_id,
      walletAddress: inputs.order.wallet_address,
      signerAddress: inputs.order.signer_address,
      venue: LIMITLESS_VENUE,
      feeProgram: LIMITLESS_FEE_PROGRAM,
      chainId: BASE_CHAIN_ID,
      orderId: inputs.order.id,
      orderHash:
        collateralProof && signedOrderHash
          ? signedOrderHash
          : (inputs.order.order_hash ?? txHash),
      venueOrderId: inputs.order.venue_order_id,
      venueFillId,
      venueTradeId: matching.orderHash,
      txHash,
      tokenId: inputs.order.token_id,
      side,
      role: walletAddresses.has(matching.maker) ? "maker" : "taker",
      attributionCode: null,
      feeRateBps: inputs.config.shareBps,
      feeBasis: "venue_fee_share",
      notionalAmountRaw: notionalRaw.toString(),
      notionalAmount: microToDecimal(notionalRaw),
      feeAmountRaw: feeRaw.toString(),
      feeAmount: microToDecimal(feeRaw),
      feeAsset: "USDC",
      venueFeeRateBps: module ? 0 : venueFeeEffectiveBps,
      venueEffectiveFeeBps: venueFeeEffectiveBps,
      venueFeeAmountRaw: venueFee.toString(),
      venueFeeAmount: microToDecimal(venueFee),
      filledAt,
    },
    receivable: null,
    attempt: null,
  };
}

export function getLimitlessFeeShareConfig(): LimitlessFeeShareConfig {
  const shareBps = clampShareBps(env.limitlessFeeShareBps);
  return { active: shareBps > 0, shareBps, effectiveAt: null, source: "env" };
}

export async function resolveLimitlessFeeShareConfig(
  pool: Pool,
): Promise<LimitlessFeeShareConfig> {
  const policy = await fetchActiveFeePolicy(pool, "limitless");
  const shareBps = clampShareBps(
    policy?.limitless_fee_share_bps ?? env.limitlessFeeShareBps,
  );
  return {
    active: shareBps > 0,
    shareBps,
    effectiveAt: policy?.effective_at ?? null,
    source: policy ? "db" : "env",
  };
}

export async function fetchLimitlessAccrualOrderStatuses(
  lookups: Array<{ orderId: string; clientOrderId?: string | null }>,
  fetchBatch = fetchSharedLimitlessOrderStatusBatch,
): Promise<{
  statuses: Map<string, LimitlessOrderStatusItem>;
  unavailable: boolean;
}> {
  if (!lookups.length) return { statuses: new Map(), unavailable: false };
  // Keep the two lookup identities in independent batches. An alias returned
  // by one batch must not overwrite the other batch's receipt locator.
  const orderIds = [...new Set(lookups.map((lookup) => lookup.orderId))];
  const clientIds = [
    ...new Set(
      lookups.flatMap((lookup) =>
        lookup.clientOrderId ? [lookup.clientOrderId] : [],
      ),
    ),
  ];
  const [byOrder, byClient] = await Promise.allSettled([
    fetchBatch(orderIds.map((orderId) => ({ orderId }))),
    clientIds.length
      ? fetchBatch(clientIds.map((clientOrderId) => ({ clientOrderId })))
      : new Map<string, LimitlessOrderStatusItem>(),
  ]);
  const results = new Map<string, LimitlessOrderStatusItem>();
  if (byOrder.status === "fulfilled")
    for (const key of orderIds) {
      const value = byOrder.value.get(key);
      if (value) results.set(key, value);
    }
  if (byClient.status === "fulfilled")
    for (const id of clientIds) {
      const key = `client:${id}`;
      const value = byClient.value.get(key);
      if (value) results.set(key, value);
    }
  return {
    statuses: results,
    unavailable:
      byOrder.status === "rejected" || byClient.status === "rejected",
  };
}

async function buildLimitlessVenueShareAccrualResultFromReceipt(inputs: {
  provider: ethers.JsonRpcProvider;
  order: LimitlessAccrualOrderRow;
  config: LimitlessFeeShareConfig;
}): Promise<LimitlessAccrualBuildResult> {
  const terminal = (
    reason: string,
    status: VenueFeeBackfillAttemptInput["status"] = "skipped",
  ): LimitlessAccrualBuildResult => ({
    accrual: null,
    receivable: null,
    attempt: {
      status,
      reason,
      retryable: status === "retry",
    },
  });
  const retry = (reason: string): LimitlessAccrualBuildResult =>
    terminal(reason, "retry");

  const txHash = normalizeHash(inputs.order.order_hash);
  if (!txHash) return retry("Limitless transaction hash missing");
  try {
    const receipt = trustedLimitlessLegacyIdentity(inputs.order.order_payload)
      ? (
          await readCanonicalFinalizedBuyReceipt(
            inputs.provider,
            txHash,
            () => undefined,
          )
        )?.receipt
      : await inputs.provider.getTransactionReceipt(txHash);
    if (!receipt) return retry("Limitless onchain receipt not found");
    if (receipt.status === 0) {
      return terminal("Limitless transaction reverted", "failed");
    }
    const result = buildLimitlessVenueShareAccrualFromReceiptLogs({
      order: inputs.order,
      txHash,
      logs: receipt.logs.map((log) => ({
        address: log.address,
        topics: log.topics,
        data: log.data,
        index: log.index,
      })),
      config: inputs.config,
    });
    if (
      result.accrual &&
      !hasTrustedLimitlessLegacyFeeRate(inputs.order.order_payload)
    )
      return retry(
        "Limitless USD fee receipt requires exact legacy order identity",
      );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return retry(`Limitless onchain receipt check failed: ${message}`);
  }
}

/** Local and venue tx hashes are locators, not evidence. Try each distinct
 * candidate once per batch; a bad locator must not pin the accrual. */
export async function resolveLimitlessCollateralAccrual(inputs: {
  provider: VerifiedBuyEvmProvider;
  order: LimitlessAccrualOrderRow;
  config: LimitlessFeeShareConfig;
  locators: readonly unknown[];
  checked: Set<string>;
  onReceiptAttempt?: (hash: string) => void;
  withinBudget?: () => boolean;
  shareAt?: (settledAt: Date) => Promise<number>;
}): Promise<LimitlessAccrualBuildResult> {
  const pending = (reason: string): LimitlessAccrualBuildResult => ({
    accrual: null,
    receivable: null,
    attempt: { status: "retry", reason, retryable: true },
  });
  if (!collateralFeeContext(inputs.order.order_payload))
    return pending("Limitless collateral fee provenance missing");
  let result = pending("Limitless collateral fee receipt locator missing");
  for (const locator of inputs.locators) {
    const txHash = normalizeHash(locator);
    if (!txHash || inputs.checked.has(txHash)) continue;
    let startedLocator = false;
    try {
      const evidence = await readCanonicalFinalizedBuyReceipt(
        inputs.provider,
        txHash,
        () => {
          if (inputs.withinBudget && !inputs.withinBudget())
            throw new Error(COLLATERAL_RPC_BUDGET_EXHAUSTED);
          if (!startedLocator) {
            startedLocator = true;
            inputs.onReceiptAttempt?.(txHash);
          }
        },
      );
      inputs.checked.add(txHash);
      if (!evidence || evidence.receipt.status !== 1) {
        result = pending("Limitless collateral fee canonical receipt pending");
        continue;
      }
      const proof = buildLimitlessVenueShareAccrualFromReceiptLogs({
        order: { ...inputs.order, filled_at: new Date(evidence.timestamp) },
        txHash,
        logs: evidence.receipt.logs,
        config: inputs.shareAt
          ? { ...inputs.config, shareBps: 10_000 }
          : inputs.config,
      });
      if (proof.accrual && inputs.shareAt) {
        const shareBps = clampShareBps(
          await inputs.shareAt(proof.accrual.filledAt),
        );
        const fee = floorBps(
          BigInt(proof.accrual.venueFeeAmountRaw ?? "0"),
          shareBps,
        );
        if (fee <= 0n)
          return {
            accrual: null,
            receivable: null,
            attempt: {
              status: "skipped",
              reason: "Limitless collateral fee share is zero at settlement",
              retryable: false,
            },
          };
        proof.accrual = {
          ...proof.accrual,
          feeRateBps: shareBps,
          feeAmount: microToDecimal(fee),
          feeAmountRaw: fee.toString(),
        };
      }
      if (proof.accrual || (proof.attempt && !proof.attempt.retryable))
        return proof;
      result = pending("Limitless collateral fee transfer not verified");
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === COLLATERAL_RPC_BUDGET_EXHAUSTED
      )
        return pending(COLLATERAL_RPC_BUDGET_EXHAUSTED);
      result = pending("Limitless collateral fee receipt lookup failed");
    }
  }
  return result;
}

export async function backfillLimitlessVenueShareAccruals(
  pool: Pool,
  options: {
    limit?: number;
    minAgeSec?: number;
    fetchStatusBatch?: typeof fetchSharedLimitlessOrderStatusBatch;
    collateralReceiptProvider?: VerifiedBuyEvmProvider;
  } = {},
): Promise<{ checked: number; upserted: number; skipped: number }> {
  const config = await resolveLimitlessFeeShareConfig(pool);
  if (!config.active && config.source === "env") {
    return { checked: 0, upserted: 0, skipped: 0 };
  }
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 50));
  const minAgeSec = Math.max(0, Math.trunc(options.minAgeSec ?? 60));
  const useEnvFallback = config.source === "env" && config.shareBps > 0;
  const { rows } = await pool.query<LimitlessAccrualOrderRow>(
    `
      with candidates as not materialized (
        select o.id, o.user_id, o.wallet_address, o.signer_address,
               o.venue_order_id, o.order_hash, o.token_id,
               case when o.side in ('BUY', 'SELL') then o.side else null end as side,
               o.filled_at, o.last_update, o.posted_at, o.order_payload, o.order_type,
               fee_context.is_collateral,
               coalesce(o.filled_at, o.last_update, o.posted_at) as candidate_time
        from (
          select terminal_order.*
          from orders terminal_order
          where terminal_order.venue='limitless'
            and terminal_order.venue_order_id is not null
            and lower(terminal_order.status) in ('filled', 'matched', 'mined', 'confirmed')
          union all
          select pending_order.*
          from orders pending_order
          where pending_order.venue='limitless' and pending_order.order_type='FOK'
            and pending_order.status in ('submitted','open','pending','delayed','unconfirmed','live','active')
            and ${limitlessFrozenCollateralSql("pending_order.order_payload")}
        ) o
        cross join lateral (values (${limitlessFrozenCollateralSql("o.order_payload")})) as fee_context(is_collateral)
        where o.venue = 'limitless'
          and o.venue_order_id ~* $1
          and coalesce(o.filled_at, o.last_update, o.posted_at, now()) <= now() - ($3::int * interval '1 second')
          and not exists (
            select 1
            from venue_fee_accruals a
            where a.venue = 'limitless'
              and a.fee_program = 'venue_share'
              and a.order_id = o.id
              and (not fee_context.is_collateral or a.venue_fill_id like 'collateral:%'
                   or a.status = 'collected' or a.fee_event_id is not null)
          )
          and not exists (
            select 1
            from limitless_contract_fee_receivables r
            where r.venue = 'limitless'
              and r.fee_program = 'venue_share'
              and r.order_id = o.id
          )
          and not exists (
            select 1
            from venue_fee_backfill_attempts b
            where b.venue = 'limitless'
              and b.fee_program = case when fee_context.is_collateral then $6::text else 'venue_share' end
              and b.order_id = o.id
              and (
                b.status in ('skipped', 'failed')
                or (
                  b.status = 'retry'
                  and coalesce(b.next_attempt_at, 'infinity'::timestamptz) > now()
                )
              )
          )
      ), eligible_candidates as not materialized (
      select c.id, c.user_id, c.wallet_address, c.signer_address,
             c.venue_order_id, c.order_hash, c.token_id, c.side,
             c.filled_at, c.last_update, c.posted_at, c.order_payload, c.order_type,
             coalesce(
               c.order_payload->>'clientOrderId',
               c.order_payload->'submitted'->>'clientOrderId',
               c.order_payload->'_hunchSubmitted'->>'clientOrderId',
               c.order_payload->'_hunchUpstream'->'execution'->>'clientOrderId',
               c.order_payload->'_hunchUpstream'->'order'->'execution'->>'clientOrderId'
             ) as client_order_id,
             coalesce(
               active_policy.limitless_fee_share_bps,
               case when $4::boolean then $5::int else null end
             ) as fee_share_bps, c.is_collateral, c.candidate_time,
             coalesce(collateral_attempt.next_attempt_at,c.candidate_time) as observation_due
      from candidates c
      left join venue_fee_backfill_attempts collateral_attempt on c.is_collateral
        and collateral_attempt.venue='limitless' and collateral_attempt.fee_program=$6::text
        and collateral_attempt.order_id=c.id
      left join lateral (
        select p.limitless_fee_share_bps
        from fee_policy p
        where p.venue = 'limitless'
          and p.effective_at <= c.candidate_time
        order by p.effective_at desc, p.created_at desc
        limit 1
      ) active_policy on true
      where (coalesce(
        active_policy.limitless_fee_share_bps,
        case when $4::boolean then $5::int else null end,
        0
      ) > 0 or c.is_collateral)
      )
      select admitted.*
      from (values (true), (false)) as admission_lane(is_collateral)
      cross join lateral (
        select eligible.*,
               row_number() over (order by eligible.observation_due asc nulls last, eligible.id) as lane_position
        from (
          select candidate.*
          from eligible_candidates candidate
          where candidate.is_collateral = admission_lane.is_collateral
          order by candidate.observation_due asc nulls last, candidate.id
          limit $2
        ) eligible
      ) admitted
      order by admitted.lane_position, admitted.is_collateral desc
      limit $2
    `,
    [
      UUID_RE.source,
      limit,
      minAgeSec,
      useEnvFallback,
      config.shareBps,
      LIMITLESS_COLLATERAL_ATTEMPT_PROGRAM,
    ],
  );
  if (!rows.length) return { checked: 0, upserted: 0, skipped: 0 };

  const collateralOrderIds = rows
    .filter((row) => collateralFeeContext(row.order_payload))
    .map((row) => row.id);
  if (collateralOrderIds.length) {
    // History can be stored before the exact submit proof. Do not let an
    // earlier provisional amount suppress or accompany the canonical debit.
    await pool.query(
      `update venue_fee_accruals
      set status = 'failed', verification_error = 'Limitless collateral fee supersedes provisional accrual', updated_at = now()
      where venue = 'limitless' and fee_program = 'venue_share'
        and order_id = any($1::uuid[]) and venue_fill_id not like 'collateral:%'
        and status in ('accrued','verified') and fee_event_id is null`,
      [collateralOrderIds],
    );
  }

  const accruals: Array<VenueFeeAccrualInput | null> = [];
  const verifiedCollateral: VenueFeeAccrualInput[] = [];
  const collateralChecks = new Map<
    string,
    { checked: Set<string>; reason: string }
  >();
  const receivables: Array<LimitlessContractFeeReceivableInput | null> = [];
  const attempts: VenueFeeBackfillAttemptInput[] = [];
  const rowsNeedingStatus: LimitlessAccrualOrderRow[] = [];
  let baseProvider: ethers.JsonRpcProvider | null = null;
  let collateralProvider: VerifiedBuyEvmProvider | null =
    options.collateralReceiptProvider ?? null;
  let skipped = 0;
  const rpcTimeoutMs = Math.min(env.baseRpcTimeoutMs, 15_000);
  // Keep a fresh-locator reserve even when old transaction hashes are slow.
  const collateralBudgetMs = 3 * rpcTimeoutMs;
  const collateralRpcSpentMs = { stored: 0, fresh: 0 };
  const collateralAttempted = new Set<string>();
  const shareBySettlement = new Map<number, number>();
  const shareAt = async (settledAt: Date) => {
    const time = settledAt.getTime();
    const cached = shareBySettlement.get(time);
    if (cached !== undefined) return cached;
    const policy = await fetchActiveFeePolicy(pool, "limitless", settledAt);
    const share = clampShareBps(
      policy?.limitless_fee_share_bps ?? (useEnvFallback ? config.shareBps : 0),
    );
    shareBySettlement.set(time, share);
    return share;
  };
  const resolveCollateral = async (
    row: LimitlessAccrualOrderRow,
    shareBps: number,
    locators: readonly unknown[],
    checked: Set<string>,
    phase: "stored" | "fresh",
  ) => {
    collateralProvider ??= createEvmRpcProvider(
      env.baseRpcUrl,
      8453,
      undefined,
      {
        timeoutMs: rpcTimeoutMs,
      },
    );
    const started = performance.now();
    const cursorKey = `${row.id}:${phase}`;
    const available = [
      ...new Set(
        locators
          .map(normalizeHash)
          .filter((hash): hash is string => Boolean(hash)),
      ),
    ];
    const prior = available.indexOf(feeObservationCursor.get(cursorKey) ?? "");
    const rotateAt = prior < 0 ? 0 : prior + 1;
    let lastProbed: string | undefined;
    try {
      return await resolveLimitlessCollateralAccrual({
        order: row,
        provider: collateralProvider,
        config: { ...config, active: true, shareBps },
        locators: [
          ...available.slice(rotateAt),
          ...available.slice(0, rotateAt),
        ],
        checked,
        onReceiptAttempt: (hash) => {
          lastProbed = hash;
        },
        shareAt,
        withinBudget: () =>
          collateralRpcSpentMs[phase] +
            performance.now() -
            started +
            rpcTimeoutMs <=
          collateralBudgetMs,
      });
    } finally {
      if (lastProbed) {
        collateralAttempted.add(row.id);
        feeObservationCursor.delete(cursorKey);
        if (feeObservationCursor.size >= MAX_FEE_LOCATOR_CURSORS) {
          const oldest = feeObservationCursor.keys().next();
          if (!oldest.done) feeObservationCursor.delete(oldest.value);
        }
        feeObservationCursor.set(cursorKey, lastProbed);
      }
      collateralRpcSpentMs[phase] += performance.now() - started;
    }
  };
  const finishCollateral = (
    row: LimitlessAccrualOrderRow,
    reason: string,
    retryable: boolean,
  ) => {
    skipped += 1;
    attempts.push({
      venue: LIMITLESS_VENUE,
      feeProgram: LIMITLESS_COLLATERAL_ATTEMPT_PROGRAM,
      orderId: row.id,
      venueOrderId: row.venue_order_id,
      status: retryable ? "retry" : "skipped",
      reason,
      // Unknown evidence can become available independently of this worker's
      // polling count. Keep the existing spaced schedule, not a permanent skip.
      consumeAttempt: !retryable,
      nextAttemptAt: retryable
        ? new Date(
            Date.now() +
              (reason === COLLATERAL_RPC_BUDGET_EXHAUSTED &&
              !collateralAttempted.has(row.id)
                ? COLLATERAL_CAPACITY_RETRY_MS
                : BACKFILL_RETRY_DELAY_MS),
          )
        : null,
    });
  };
  const buildOnchainResultFromStatusTx = async (
    row: LimitlessAccrualOrderRow,
    status: LimitlessOrderStatusItem,
    shareBps: number,
  ): Promise<LimitlessAccrualBuildResult | null> => {
    // Unknown collateral/legacy provenance cannot borrow another fill from
    // a provider-supplied hash. Enrichment into the frozen lane can wake it.
    const orderPayload = await recoverLegacyFeeOrderPayload(pool, row);
    if (!hasTrustedLimitlessLegacyFeeRate(orderPayload)) return null;
    const txHash =
      extractTxHashFromLimitlessStatus(status) ?? normalizeHash(row.order_hash);
    if (!txHash) return null;
    baseProvider ??= createEvmRpcProvider(env.baseRpcUrl, 8453, undefined, {
      timeoutMs: env.baseRpcTimeoutMs,
    });
    return buildLimitlessVenueShareAccrualResultFromReceipt({
      provider: baseProvider,
      order: {
        ...row,
        order_payload: orderPayload,
        order_hash: txHash,
      },
      config: {
        ...config,
        active: true,
        shareBps,
      },
    });
  };
  for (const row of rows) {
    const shareBps = clampShareBps(row.fee_share_bps);
    if (shareBps <= 0 && !collateralFeeContext(row.order_payload)) {
      skipped += 1;
      attempts.push({
        venue: LIMITLESS_VENUE,
        feeProgram: LIMITLESS_FEE_PROGRAM,
        orderId: row.id,
        venueOrderId: row.venue_order_id,
        status: "skipped",
        reason: "Limitless fee share inactive at order time",
        nextAttemptAt: null,
      });
      continue;
    }

    const storedStatus = buildStoredLimitlessOrderStatusItem(row);
    if (collateralFeeContext(row.order_payload)) {
      // GTC can settle in multiple transactions. The provider does not give
      // this worker a complete fill journal. Never count only the last fill.
      if (row.order_type !== "FOK") {
        finishCollateral(
          row,
          "Limitless collateral GTC fee reconciliation unsupported",
          false,
        );
        continue;
      }
      const checked = new Set<string>();
      const proof = await resolveCollateral(
        row,
        shareBps,
        [
          row.order_hash,
          storedStatus && extractTxHashFromLimitlessStatus(storedStatus),
          ...readLimitlessHistoryTxHashes(row.order_payload),
        ],
        checked,
        "stored",
      );
      if (proof.accrual) verifiedCollateral.push(proof.accrual);
      else if (proof.attempt && !proof.attempt.retryable)
        finishCollateral(row, proof.attempt.reason, false);
      else {
        collateralChecks.set(row.id, {
          checked,
          reason:
            proof.attempt?.reason ?? "Limitless collateral fee receipt pending",
        });
        rowsNeedingStatus.push(row);
      }
      continue;
    }
    if (!storedStatus) {
      rowsNeedingStatus.push(row);
      continue;
    }

    const result = buildLimitlessVenueShareAccrualResult({
      order: row,
      status: storedStatus,
      config: {
        ...config,
        active: true,
        shareBps,
      },
    });
    const accrual = result.accrual;
    if (accrual) {
      accruals.push(accrual);
      continue;
    }
    if (result.receivable) {
      receivables.push(result.receivable);
      continue;
    }
    if (shouldTryReceiptForStatusResult(result)) {
      const onchainResult = await buildOnchainResultFromStatusTx(
        row,
        storedStatus,
        shareBps,
      );
      if (onchainResult?.accrual) {
        accruals.push(onchainResult.accrual);
        continue;
      }
      if (onchainResult?.receivable) {
        receivables.push(onchainResult.receivable);
        continue;
      }
      if (onchainResult?.attempt) {
        result.attempt = onchainResult.attempt;
      }
    }
    if (result.attempt) {
      if (result.attempt.retryable) {
        rowsNeedingStatus.push(row);
      } else {
        skipped += 1;
        attempts.push({
          venue: LIMITLESS_VENUE,
          feeProgram: LIMITLESS_FEE_PROGRAM,
          orderId: row.id,
          venueOrderId: row.venue_order_id,
          status: result.attempt.status,
          reason: result.attempt.reason,
          nextAttemptAt: null,
        });
      }
    } else {
      skipped += 1;
    }
  }

  const { statuses, unavailable } = await fetchLimitlessAccrualOrderStatuses(
    rowsNeedingStatus.map((row) => ({
      orderId: row.venue_order_id,
      clientOrderId: row.client_order_id,
    })),
    options.fetchStatusBatch,
  );
  for (const row of rowsNeedingStatus) {
    const providerStatus = statuses.get(row.venue_order_id);
    const clientStatus = row.client_order_id
      ? statuses.get(`client:${row.client_order_id}`)
      : null;
    const status = providerStatus ?? clientStatus;
    const pendingCollateral = collateralChecks.get(row.id);
    if (pendingCollateral) {
      const exactStatusHashes = [providerStatus, clientStatus]
        .flatMap((item) =>
          item &&
          item.orderId === row.venue_order_id &&
          (!row.client_order_id ||
            !item.clientOrderId ||
            row.client_order_id === item.clientOrderId)
            ? [extractTxHashFromLimitlessStatus(item)]
            : [],
        )
        .filter((hash): hash is string => hash !== null);
      const alreadyStored = new Set([
        normalizeHash(row.order_hash),
        ...readLimitlessHistoryTxHashes(row.order_payload),
      ]);
      await retainLimitlessFeeReceiptLocators(pool, {
        orderId: row.id,
        userId: row.user_id,
        venueOrderId: row.venue_order_id,
        hashes: exactStatusHashes.filter((hash) => !alreadyStored.has(hash)),
      });
      const historical = await fetchLimitlessHistoryReceiptLocators(pool, {
        userId: row.user_id,
        walletAddress: row.wallet_address,
        tokenId: row.token_id,
        side: row.side,
        clientOrderId: row.client_order_id,
        providerOrderId: row.venue_order_id,
      });
      const freshTxs = exactStatusHashes.filter(
        (hash) => !pendingCollateral.checked.has(hash),
      );
      for (const hash of historical)
        if (!pendingCollateral.checked.has(hash) && !freshTxs.includes(hash))
          freshTxs.push(hash);
      if (!freshTxs.length) {
        finishCollateral(
          row,
          unavailable
            ? "Limitless collateral fee status lookup unavailable"
            : pendingCollateral.reason,
          true,
        );
      } else {
        const proof = await resolveCollateral(
          row,
          clampShareBps(row.fee_share_bps),
          freshTxs,
          pendingCollateral.checked,
          "fresh",
        );
        if (proof.accrual) verifiedCollateral.push(proof.accrual);
        else
          finishCollateral(
            row,
            proof.attempt?.reason ?? pendingCollateral.reason,
            proof.attempt?.retryable ?? true,
          );
      }
      continue;
    }
    if (!status) {
      const shareBps = clampShareBps(row.fee_share_bps);
      if (isFilledOrderWithKnownTx(row) && shareBps > 0) {
        baseProvider ??= createEvmRpcProvider(env.baseRpcUrl, 8453, undefined, {
          timeoutMs: env.baseRpcTimeoutMs,
        });
        const onchainResult =
          await buildLimitlessVenueShareAccrualResultFromReceipt({
            provider: baseProvider,
            order: {
              ...row,
              order_payload: await recoverLegacyFeeOrderPayload(pool, row),
            },
            config: {
              ...config,
              active: true,
              shareBps,
            },
          });
        if (onchainResult.accrual) {
          accruals.push(onchainResult.accrual);
          continue;
        }
        if (onchainResult.receivable) {
          receivables.push(onchainResult.receivable);
          continue;
        }
        skipped += 1;
        if (onchainResult.attempt) {
          attempts.push({
            venue: LIMITLESS_VENUE,
            feeProgram: LIMITLESS_FEE_PROGRAM,
            orderId: row.id,
            venueOrderId: row.venue_order_id,
            status: onchainResult.attempt.status,
            reason: onchainResult.attempt.reason,
            nextAttemptAt: onchainResult.attempt.retryable
              ? new Date(Date.now() + BACKFILL_RETRY_DELAY_MS)
              : null,
          });
          continue;
        }
      }
      skipped += 1;
      attempts.push({
        venue: LIMITLESS_VENUE,
        feeProgram: LIMITLESS_FEE_PROGRAM,
        orderId: row.id,
        venueOrderId: row.venue_order_id,
        status: "retry",
        reason: "Limitless order status not found",
        consumeAttempt: !unavailable,
        nextAttemptAt: new Date(Date.now() + BACKFILL_RETRY_DELAY_MS),
      });
      continue;
    }
    const shareBps = clampShareBps(row.fee_share_bps);
    const result = buildLimitlessVenueShareAccrualResult({
      order: row,
      status,
      config: {
        ...config,
        active: true,
        shareBps,
      },
    });
    const accrual = result.accrual;
    if (result.receivable) {
      receivables.push(result.receivable);
      continue;
    }
    if (shouldTryReceiptForStatusResult(result)) {
      const onchainResult = await buildOnchainResultFromStatusTx(
        row,
        status,
        shareBps,
      );
      if (onchainResult?.accrual) {
        accruals.push(onchainResult.accrual);
        continue;
      }
      if (onchainResult?.receivable) {
        receivables.push(onchainResult.receivable);
        continue;
      }
      if (onchainResult?.attempt) {
        result.attempt = onchainResult.attempt;
      }
    }
    if (!accrual) skipped += 1;
    if (result.attempt) {
      attempts.push({
        venue: LIMITLESS_VENUE,
        feeProgram: LIMITLESS_FEE_PROGRAM,
        orderId: row.id,
        venueOrderId: row.venue_order_id,
        status: result.attempt.status,
        reason: result.attempt.reason,
        nextAttemptAt: result.attempt.retryable
          ? new Date(Date.now() + BACKFILL_RETRY_DELAY_MS)
          : null,
      });
    }
    accruals.push(accrual);
  }
  const upsert = await upsertVenueFeeAccruals(pool, accruals);
  const collateralUpsert = await insertVerifiedLimitlessCollateralAccruals(
    pool,
    verifiedCollateral,
  );
  const insertedOrders = new Set(collateralUpsert.orderIds);
  const resolvedOrders = new Set(verifiedCollateral.map((fee) => fee.orderId));
  for (const row of rows) {
    if (!insertedOrders.has(row.id) && resolvedOrders.has(row.id))
      finishCollateral(
        row,
        "Limitless collateral debit already accounted for",
        false,
      );
  }
  const receivableUpsert = await upsertLimitlessContractFeeReceivables(
    pool,
    receivables,
  );
  if (collateralUpsert.upserted > 0) {
    await clearVenueFeeBackfillAttempts(pool, {
      venue: LIMITLESS_VENUE,
      feeProgram: LIMITLESS_COLLATERAL_ATTEMPT_PROGRAM,
      orderIds: collateralUpsert.orderIds,
    });
  }
  if (upsert.upserted > 0 || receivableUpsert.upserted > 0) {
    await clearVenueFeeBackfillAttempts(pool, {
      venue: LIMITLESS_VENUE,
      feeProgram: LIMITLESS_FEE_PROGRAM,
      orderIds: [
        ...accruals
          .filter((accrual): accrual is VenueFeeAccrualInput => accrual != null)
          .map((accrual) => accrual.orderId),
        ...receivables
          .filter(
            (receivable): receivable is LimitlessContractFeeReceivableInput =>
              receivable != null,
          )
          .map((receivable) => receivable.orderId),
      ],
    });
  }
  await markVenueFeeBackfillAttempts(pool, attempts, {
    maxRetryAttempts: BACKFILL_MAX_RETRY_ATTEMPTS,
  });
  return {
    checked: rows.length,
    upserted:
      upsert.upserted + collateralUpsert.upserted + receivableUpsert.upserted,
    skipped,
  };
}

export async function upsertLimitlessVenueShareAccrualFromOrderPayload(
  pool: Pool,
  inputs: {
    orderId: string;
    userId: string;
    walletAddress: string | null;
    signerAddress: string | null;
    venueOrderId: string;
    orderHash?: string | null;
    tokenId: string | null;
    side: "BUY" | "SELL";
    filledAt: Date | null;
    lastUpdate: Date | null;
    postedAt: Date | null;
    payload: unknown;
  },
): Promise<{ upserted: number }> {
  const config = await resolveLimitlessFeeShareConfig(pool);
  if (!config.active) return { upserted: 0 };
  const result = buildLimitlessVenueShareAccrualResult({
    order: {
      id: inputs.orderId,
      user_id: inputs.userId,
      wallet_address: inputs.walletAddress,
      signer_address: inputs.signerAddress,
      venue_order_id: inputs.venueOrderId,
      order_hash: inputs.orderHash ?? null,
      token_id: inputs.tokenId,
      side: inputs.side,
      filled_at: inputs.filledAt,
      last_update: inputs.lastUpdate,
      posted_at: inputs.postedAt,
    },
    status: {
      orderId: inputs.venueOrderId,
      payload: {
        status: "found",
        orderId: inputs.venueOrderId,
        data: inputs.payload,
      },
    },
    config,
  });
  const accrualUpsert = await upsertVenueFeeAccruals(pool, [result.accrual]);
  const receivableUpsert = await upsertLimitlessContractFeeReceivables(pool, [
    result.receivable,
  ]);
  if (result.accrual || result.receivable) {
    await clearVenueFeeBackfillAttempts(pool, {
      venue: LIMITLESS_VENUE,
      feeProgram: LIMITLESS_FEE_PROGRAM,
      orderIds: [inputs.orderId],
    });
  }
  return { upserted: accrualUpsert.upserted + receivableUpsert.upserted };
}

export async function verifyLimitlessVenueShareAccruals(
  pool: Pool,
  options: {
    limit?: number;
    fetchStatuses?: typeof fetchLimitlessAccrualOrderStatuses;
  } = {},
): Promise<{
  checked: number;
  verified: number;
  failed: number;
  skipped: number;
}> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 50));
  const { rows } = await pool.query<LimitlessAccrualRow>(
    `
      select a.id, a.user_id, a.wallet_address, o.signer_address,
             a.order_id, a.order_hash, a.venue_order_id, a.token_id, a.side,
             a.fee_rate_bps, a.filled_at, o.last_update, o.posted_at,
             a.tx_hash, o.order_payload
      from venue_fee_accruals a
      left join orders o on o.id = a.order_id
      where a.venue = 'limitless'
        and a.fee_program = 'venue_share'
        and a.status = 'accrued'
        and (a.verification_error is distinct from $3 or
             a.updated_at <= now() - ($4::int * interval '1 millisecond'))
        and a.venue_order_id is not null
        and a.venue_order_id ~* $1
      order by a.filled_at asc, a.created_at asc
      limit $2
    `,
    [
      UUID_RE.source,
      limit,
      LIMITLESS_USD_FEE_RECEIPT_REQUIRED,
      BACKFILL_RETRY_DELAY_MS,
    ],
  );
  if (!rows.length) return { checked: 0, verified: 0, failed: 0, skipped: 0 };

  const { statuses } = await (
    options.fetchStatuses ?? fetchLimitlessAccrualOrderStatuses
  )(
    rows
      .filter((row) => {
        const receiptTxHash =
          normalizeHash(row.tx_hash) ?? normalizeHash(row.order_hash);
        return !receiptTxHash || !row.side;
      })
      .filter((row) => {
        const stored = buildStoredLimitlessOrderStatusItem({
          venue_order_id: row.venue_order_id ?? "",
          client_order_id: null,
          order_payload: row.order_payload,
        });
        return (
          !stored ||
          (!extractTxHashFromLimitlessStatus(stored) &&
            !hasTrustedLimitlessLegacyFeeRate(row.order_payload))
        );
      })
      .map((row) => row.venue_order_id)
      .filter((orderId): orderId is string => Boolean(orderId))
      .map((orderId) => ({ orderId })),
  );

  let checked = 0;
  let verified = 0;
  let failed = 0;
  let skipped = 0;
  let baseProvider: ethers.JsonRpcProvider | null = null;
  const deferUnknownReceipt = (id: string) =>
    pool.query(
      `update venue_fee_accruals
    set verification_error=$2, updated_at=now() where id=$1 and status='accrued'`,
      [id, LIMITLESS_USD_FEE_RECEIPT_REQUIRED],
    );
  for (const row of rows) {
    checked += 1;
    const storedStatus = row.venue_order_id
      ? buildStoredLimitlessOrderStatusItem({
          venue_order_id: row.venue_order_id,
          client_order_id: null,
          order_payload: row.order_payload,
        })
      : null;
    const remoteStatus = row.venue_order_id
      ? statuses.get(row.venue_order_id)
      : null;
    const status = storedStatus ?? remoteStatus;
    const data = status ? extractStatusData(status.payload) : null;
    const execution = data ? extractExecutionRecord(data) : null;
    // This verifier is for the legacy program's provisional rows. New
    // collateral rows go directly to `verified` from the receipt-first lane.
    if (collateralFeeContext(row.order_payload)) {
      failed += 1;
      await pool.query(
        `update venue_fee_accruals
        set status = 'failed', verification_error = 'Limitless collateral fee requires receipt-first reconciliation', updated_at = now()
        where id = $1 and status = 'accrued'`,
        [row.id],
      );
      continue;
    }
    const orderPayload = await recoverLegacyFeeOrderPayload(pool, row);
    const trustedLegacy = hasTrustedLimitlessLegacyFeeRate(orderPayload);
    const needsExactReceipt = !!(
      data &&
      execution &&
      (rawDigits(extractTotalsRaw(execution)?.usdFee) ?? 0n) > 0n &&
      (statusNeedsCollateralProof(data, execution) || !trustedLegacy)
    );
    if (needsExactReceipt && !trustedLegacy) {
      skipped += 1;
      await deferUnknownReceipt(row.id);
      continue;
    }
    const receiptTxHash =
      normalizeHash(row.tx_hash) ??
      normalizeHash(row.order_hash) ??
      (needsExactReceipt && storedStatus
        ? extractTxHashFromLimitlessStatus(storedStatus)
        : null) ??
      (needsExactReceipt && remoteStatus
        ? extractTxHashFromLimitlessStatus(remoteStatus)
        : null);
    if (receiptTxHash && row.side) {
      baseProvider ??= createEvmRpcProvider(env.baseRpcUrl, 8453, undefined, {
        timeoutMs: env.baseRpcTimeoutMs,
      });
      const receiptResult =
        await buildLimitlessVenueShareAccrualResultFromReceipt({
          provider: baseProvider,
          order: {
            id: row.order_id,
            user_id: row.user_id,
            wallet_address: row.wallet_address,
            signer_address: row.signer_address,
            venue_order_id: row.venue_order_id ?? row.order_id,
            order_hash: receiptTxHash,
            token_id: row.token_id,
            side: row.side,
            filled_at: row.filled_at,
            last_update: row.last_update,
            posted_at: row.posted_at,
            order_payload: orderPayload,
          },
          config: {
            active: true,
            shareBps: row.fee_rate_bps,
            effectiveAt: null,
            source: "db",
          },
        });
      if (receiptResult.accrual) {
        verified += 1;
        await pool.query(
          `
            update venue_fee_accruals
            set status = 'verified',
                chain_verified_at = now(),
                verification_error = null,
                tx_hash = coalesce($2, tx_hash),
                venue_trade_id = coalesce($3, venue_trade_id),
                notional_amount_raw = $4,
                notional_amount = $5,
                fee_amount_raw = $6,
                fee_amount = $7,
                venue_fee_rate_bps = $8,
                venue_effective_fee_bps = $9,
                venue_fee_amount_raw = $10,
                venue_fee_amount = $11,
                updated_at = now()
            where id = $1
          `,
          [
            row.id,
            receiptResult.accrual.txHash,
            receiptResult.accrual.venueTradeId,
            receiptResult.accrual.notionalAmountRaw,
            receiptResult.accrual.notionalAmount,
            receiptResult.accrual.feeAmountRaw,
            receiptResult.accrual.feeAmount,
            receiptResult.accrual.venueFeeRateBps ?? null,
            receiptResult.accrual.venueEffectiveFeeBps ?? null,
            receiptResult.accrual.venueFeeAmountRaw ?? null,
            receiptResult.accrual.venueFeeAmount ?? null,
          ],
        );
        continue;
      }
      if (receiptResult.receivable) {
        failed += 1;
        await upsertLimitlessContractFeeReceivables(pool, [
          receiptResult.receivable,
        ]);
        await pool.query(
          `
            update venue_fee_accruals
            set status = 'failed',
                verification_error = 'Limitless fee was contract-denominated onchain; moved to contract-fee receivables',
                updated_at = now()
            where id = $1
          `,
          [row.id],
        );
        continue;
      }
      if (
        receiptResult.attempt &&
        (!receiptResult.attempt.retryable ||
          receiptResult.attempt.reason ===
            "Limitless collateral fee provenance missing")
      ) {
        failed += 1;
        await pool.query(
          `
            update venue_fee_accruals
            set status = 'failed',
                verification_error = $2,
                updated_at = now()
            where id = $1
          `,
          [row.id, receiptResult.attempt.reason],
        );
        continue;
      }
      skipped += 1;
      if (needsExactReceipt) await deferUnknownReceipt(row.id);
      continue;
    }
    if (needsExactReceipt) {
      skipped += 1;
      await deferUnknownReceipt(row.id);
      continue;
    }
    const executionStatus = execution ? settlementStatus(execution) : null;
    if (!status || !data || !execution || !executionStatus) {
      skipped += 1;
      continue;
    }
    if (FAILED_STATUSES.has(executionStatus)) {
      failed += 1;
      await pool.query(
        `
          update venue_fee_accruals
          set status = 'failed',
              verification_error = 'Limitless settlement failed',
              updated_at = now()
          where id = $1
        `,
        [row.id],
      );
      continue;
    }
    if (!SETTLED_STATUSES.has(executionStatus)) {
      skipped += 1;
      continue;
    }
    const totals = extractTotalsRaw(execution);
    const venueFeeRaw = totals ? rawDigits(totals.usdFee) : null;
    const notionalRaw = totals ? deriveUsdGrossRaw(totals) : null;
    if (venueFeeRaw == null || notionalRaw == null || venueFeeRaw <= 0n) {
      failed += 1;
      await pool.query(
        `
          update venue_fee_accruals
          set status = 'failed',
              verification_error = $2,
              updated_at = now()
          where id = $1
        `,
        [
          row.id,
          limitlessUsdFeeFailureReason(totals, venueFeeRaw, notionalRaw),
        ],
      );
      continue;
    }
    const feeRaw = floorBps(venueFeeRaw, row.fee_rate_bps);
    if (feeRaw <= 0n) {
      failed += 1;
      await pool.query(
        `
          update venue_fee_accruals
          set status = 'failed',
              verification_error = 'Limitless fee share is zero',
              updated_at = now()
          where id = $1
        `,
        [row.id],
      );
      continue;
    }

    verified += 1;
    await pool.query(
      `
        update venue_fee_accruals
        set status = 'verified',
            chain_verified_at = now(),
            verification_error = null,
            tx_hash = coalesce($2, tx_hash),
            venue_trade_id = coalesce($3, venue_trade_id),
            notional_amount_raw = $4,
            notional_amount = $5,
            fee_amount_raw = $6,
            fee_amount = $7,
            venue_fee_rate_bps = $8,
            venue_effective_fee_bps = $9,
            venue_fee_amount_raw = $10,
            venue_fee_amount = $11,
            updated_at = now()
        where id = $1
      `,
      [
        row.id,
        textOrNull(execution.txHash),
        textOrNull(execution.tradeEventId),
        notionalRaw.toString(),
        microToDecimal(notionalRaw),
        feeRaw.toString(),
        microToDecimal(feeRaw),
        numberOrNull(execution.feeRateBps),
        numberOrNull(execution.effectiveFeeBps),
        venueFeeRaw.toString(),
        microToDecimal(venueFeeRaw),
      ],
    );
  }

  return { checked, verified, failed, skipped };
}

export async function reconcileLimitlessVenueShareAccruals(
  pool: Pool,
  options: { limit?: number; minAgeSec?: number; dryRun?: boolean } = {},
): Promise<{
  backfill: Awaited<ReturnType<typeof backfillLimitlessVenueShareAccruals>>;
  verify: Awaited<ReturnType<typeof verifyLimitlessVenueShareAccruals>>;
  unlock: Awaited<ReturnType<typeof unlockVenueFeeAccruals>>;
  contractReceivableSync: Awaited<
    ReturnType<typeof syncLimitlessContractReceivablesFromAccruals>
  >;
  contractReceivables: Awaited<
    ReturnType<typeof reconcileLimitlessContractFeeReceivables>
  >;
}> {
  return withRewardsChainLocks(pool, [BASE_CHAIN_ID], async () => {
    const backfill = await backfillLimitlessVenueShareAccruals(pool, {
      limit: options.limit,
      minAgeSec: options.minAgeSec,
    });
    const verify = await verifyLimitlessVenueShareAccruals(pool, {
      limit: options.limit,
    });
    const contractReceivables = await reconcileLimitlessContractFeeReceivables(
      pool,
      {
        limit: options.limit,
        dryRun: options.dryRun,
      },
    );
    const unlock = await unlockVenueFeeAccruals(pool, {
      chainId: BASE_CHAIN_ID,
      venue: LIMITLESS_VENUE,
      limit: options.limit,
      dryRun: options.dryRun,
      assumeRewardsChainLock: true,
    });
    const contractReceivableSync = options.dryRun
      ? { synced: 0 }
      : await syncLimitlessContractReceivablesFromAccruals(pool);
    return {
      backfill,
      verify,
      unlock,
      contractReceivableSync,
      contractReceivables,
    };
  });
}
