import crypto from "node:crypto";
import { ethers } from "ethers";

import { AuthService, type User } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import { markHotTokens } from "../lib/hot-tokens.js";
import { requestPriceRefreshForTokens } from "../lib/price-refresh.js";
import { isRecord } from "../lib/type-guards.js";
import { fetchPolymarketMarketInfo } from "../repos/polymarket-markets.js";
import {
  fetchStoredOrderWalletContext,
  storeOrder,
} from "../repos/orders-repo.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./notifications.js";
import { applyOptimisticPositionTrade } from "./positions-optimistic.js";
import { tryRecordReferralFirstTradeConversion } from "./analytics-referrals.js";
import {
  amountUsd,
  applyOrderTradeEffects,
  createCapability,
  createServerWalletClient,
  extractQuoteRaw,
  getPrivyWalletId,
  hasServerWalletClientConfig,
  isOrderable,
  loadMarketForVenue,
  normalizeSide,
  parsePreparedPayload,
  POLYGON_CHAIN_ID,
  randomUint256SaltDecimal,
  readiness,
  readNumber,
  readString,
  signEvmTypedData,
  toChecksumAddress,
  tokenForSide,
  tradingError,
  USDC_SCALE,
  verifyLinkedWallet,
  ZERO_BYTES32,
  type PreparedPayloadBase,
} from "./api-trading-common.js";
import type {
  ApiTradingApplicationServiceInput,
  ApiVenueTradingExecutor,
} from "./api-trading-types.js";
import {
  resolvePolymarketFeePolicySnapshot,
  validatePolymarketOrderBuilderCodeForConfig,
} from "./polymarket-builder-fees.js";
import {
  extractOrderArray,
  extractOrderId,
  extractTokenId,
  fetchPolymarketOrderByHash,
  normalizeOpenOrder,
  polymarketL2Request,
  type PolymarketL2Credentials,
} from "./polymarket-clob-l2.js";
import {
  derivePolymarketFunders,
  type PolymarketFunderCandidate,
} from "./polymarket-funder.js";
import {
  buildEmbeddedExecutionSingleFlightKey,
  type EmbeddedExecutionSingleFlightRedis,
  getEmbeddedExecutionSingleFlightPromise,
  runEmbeddedExecutionSingleFlight,
} from "./embedded-execution-singleflight.js";
import { requestPolymarketCredentials } from "./polymarket-credentials.js";
import {
  buildEmbeddedPolymarketConnectRequest,
  buildEmbeddedPolymarketOrderRequest,
  buildEmbeddedPolymarketTypedDataRequest,
  executeEmbeddedPolymarketConnectRequest,
  executeEmbeddedPolymarketOrderRequest,
  executeEmbeddedPolymarketTypedDataRequest,
  executeEmbeddedSignerApprovalRequests,
  prepareEmbeddedPolymarketSignerApprovalRequests,
  resolveEmbeddedPolymarketWalletContext,
  type DepositWalletBatchPurpose,
  type EmbeddedPolymarketTypedData,
  type PolymarketOrderPayload,
} from "./polymarket-embedded.js";
import {
  findMaxPolymarketMarketBuyUsdForFunds,
  quotePolymarketOrder,
} from "./polymarket-trading-service.js";
import { buildPolymarketRedemptionPlan } from "./polymarket-redemption-plan.js";
import {
  fetchErc1155BalancesByOwner,
  fetchEvmCode,
  fetchPolymarketOrderHashV2,
  fetchPolymarketOrderStatus,
  fetchPolymarketOrderStatusV2,
} from "./polygon-rpc.js";
import {
  fetchPolymarketOnchainSnapshot,
  POLYGON_NATIVE_USDC_ADDRESS,
} from "./polymarket-onchain.js";
import {
  type PolymarketClosedReasonHint,
  type PolymarketNoFillTerminalStatus,
  type PolymarketTerminalReconcileStatus,
  POLYMARKET_UNCONFIRMED_STATUS,
  canApplyPolymarketNoFillTerminalStatus,
  isPolymarketUnconfirmedStatus,
  resolvePolymarketTerminalReconcileStatus,
  resolvePolymarketUnconfirmedReconcileDecision,
  summarizePolymarketClobOrderExecution,
  summarizePolymarketOnchainOrderExecution,
  summarizePolymarketV2OnchainOrderExecution,
} from "./polymarket-order-execution.js";
import { syncPolymarketTradesForSigner } from "./positions-sync.js";
import { fetchOpenOrderCollateralLocks } from "./open-order-collateral.js";
import { PolymarketQuoteError } from "./polymarket-quote.js";
import {
  computePolymarketClobOpenOrderLocks,
  computePolymarketExecutableFunds,
  type PolymarketFunderExecutionKind,
} from "./polymarket-max-spend.js";
import type {
  PreparedTrade,
  SubmitResult,
  TradeIntent,
  TradeQuote,
  TradeQuoteInput,
  TradingReadiness,
  TradingReadinessInput,
} from "./trading-types.js";

const POLY_DECIMALS = 6;
const POLYMARKET_CREDENTIALS_INVALID_CODE = "polymarket_credentials_invalid";
const POLYMARKET_UNCONFIRMED_LIMIT = 25;
const POLYMARKET_CLOB_NOT_FOUND_NO_FILL_GRACE_MS = 10_000;
const POLYMARKET_UNCONFIRMED_TRADE_SYNC_LOOKBACK_MS = 30_000;
const POLYMARKET_ORDER_RETRY_DELAYS_MS = [250, 750, 1500] as const;
const POLYMARKET_SELL_BALANCE_CHANGED_CODE = "POLYMARKET_SELL_BALANCE_CHANGED";
const POLYMARKET_SERVICE_NOT_READY_STATUS = 425;
const POLYMARKET_SUBMIT_SETTLEMENT_ATTEMPTS = 5;
const POLYMARKET_SUBMIT_SETTLEMENT_DELAY_MS = 800;
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type PolymarketL2RequestResult = Awaited<ReturnType<typeof polymarketL2Request>>;

const ORDER_TYPE_STRING =
  "Order(uint256 salt,address maker,address signer,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint8 side,uint8 signatureType,uint256 timestamp,bytes32 metadata,bytes32 builder)";

const POLYMARKET_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ],
} as const;

const POLYMARKET_TYPED_DATA_SIGN_TYPES = {
  TypedDataSign: [
    { name: "contents", type: "Order" },
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ],
  ...POLYMARKET_ORDER_TYPES,
} as const;

type PolymarketPreparedPayload = PreparedPayloadBase & {
  exchangeAddress: string;
  feePolicySnapshot: unknown;
  kind: "polymarket";
  orderHash: string;
  orderPayload: Record<string, unknown>;
  orderType: "FOK";
  positionWalletAddress: string;
  price: number | null;
  size: number | null;
  tokenId: string | null;
};

type PolymarketSide = "BUY" | "SELL";
type PolymarketOrderType = "FAK" | "FOK" | "GTC" | "GTD";
type PolymarketClobOrderType = "FOK" | "GTC" | "GTD";

type PolymarketRouteLogger = {
  error?: (input: unknown, message?: string) => void;
  warn?: (input: unknown, message?: string) => void;
};

type PolymarketWarnLogger = {
  warn: (input: unknown, message?: string) => void;
};

function optionalWarnLogger(
  log?: PolymarketRouteLogger | null,
): PolymarketWarnLogger | undefined {
  return log?.warn
    ? {
        warn: (input, message) => log.warn?.(input, message),
      }
    : undefined;
}

function requiredWarnLogger(
  log?: PolymarketRouteLogger | null,
): PolymarketWarnLogger {
  return optionalWarnLogger(log) ?? { warn: () => undefined };
}

type PolymarketClientOrderBody = {
  deferExec?: boolean;
  exchangeAddress?: string | null;
  negRisk?: boolean | null;
  order: Record<string, unknown>;
  orderType?: unknown;
  positionWalletAddress?: string | null;
};

type PolymarketOpenOrdersQuery = {
  asset_id?: string | null;
  assetId?: string | null;
  id?: string | null;
  market?: string | null;
};

type PolymarketBalanceAllowanceSyncBody = {
  assetType: string;
  signatureType?: number | null;
  tokenId?: string | null;
};

type PolymarketCancelOrderBody = {
  orderID: string;
};

type PolymarketOrderHashBody = {
  exchangeAddress?: string | null;
  negRisk?: boolean | null;
  order: Record<string, unknown>;
};

type PolymarketMaxSpendBody = {
  amountType?: string | null;
  funderAddress?: string | null;
  orderType?: string | null;
  slippageBps?: number | null;
  tokenId: string;
};

type PolymarketFunderDeriveQuery = {
  includeMagicProxy?: unknown;
  refresh?: unknown;
  walletAddress?: string | null;
};

type PolymarketFunderDeriveBatchBody = {
  includeMagicProxy?: boolean | null;
  refresh?: boolean | null;
  wallets: string[];
};

type PolymarketQuoteBody = {
  amount?: number | null;
  amountType?: "usd" | "shares" | null;
  amountUsd?: number | null;
  limitPrice?: number | null;
  orderType?: PolymarketOrderType | null;
  side: PolymarketSide;
  slippageBps?: number | null;
  tokenId: string;
};

type PolymarketMarketInfoQuery = {
  conditionId?: string | null;
  marketId?: string | null;
  tokenId?: string | null;
};

type PolymarketOrderParamsQuery = {
  tokenId: string;
};

type PolymarketAccountQuery = {
  funderAddress?: string | null;
  refresh?: boolean | null;
};

type PolymarketRedemptionPlanQuery = {
  conditionId?: string | null;
  funderAddress?: string | null;
  negRisk?: boolean | null;
  negRiskParentConditionId?: string | null;
  negRiskRequestId?: string | null;
  outcome: "YES" | "NO";
  questionId?: string | null;
  tokenId: string;
};

type PolymarketEmbeddedSignOrderPrepareBody = {
  exchangeAddress: string;
  order: PolymarketOrderPayload;
};

type PolymarketEmbeddedSignOrderBody =
  PolymarketEmbeddedSignOrderPrepareBody & {
    authorizationSignature: string;
  };

type PolymarketEmbeddedSignTypedDataPrepareBody = {
  depositWalletBatchPurpose?: DepositWalletBatchPurpose | null;
  id?: string | null;
  label?: string | null;
  typedData: EmbeddedPolymarketTypedData;
};

type PolymarketEmbeddedSignTypedDataBody =
  PolymarketEmbeddedSignTypedDataPrepareBody & {
    authorizationSignature: string;
  };

type EmbeddedAuthorizationRequestSignature = {
  id: string;
  signature: string;
};

type PolymarketEmbeddedEnsureReadyBody = {
  funderAddress?: string | null;
};

type PolymarketEmbeddedEnsureReadyExecuteBody =
  PolymarketEmbeddedEnsureReadyBody & {
    connectNonce?: number | null;
    connectTimestamp?: string | null;
    signedRequests: EmbeddedAuthorizationRequestSignature[];
  };

type PolymarketOrdersSyncBody = {
  orderIds?: string[];
  targetWalletAddress?: string | null;
};

type PolymarketSyncLogger = {
  error: (input: unknown, message?: string) => void;
  warn: (input: unknown, message?: string) => void;
};

type PolymarketAccountPayload = Record<string, unknown>;

type PolymarketAccountCacheEntry = {
  value: PolymarketAccountPayload;
  expiresAt: number;
};

const polymarketAccountCache = new Map<string, PolymarketAccountCacheEntry>();
const polymarketAccountInflight = new Map<
  string,
  Promise<PolymarketAccountPayload>
>();

type PolymarketUnconfirmedRow = {
  id: string;
  venue_order_id: string | null;
  token_id: string | null;
  side: string | null;
  wallet_address: string | null;
  price: number | string | null;
  size: number | string | null;
  order_type: string | null;
  order_hash: string | null;
  order_payload: unknown | null;
  order_payload_version: string | null;
  posted_at: Date | null;
};

export type PolymarketClientSignedOrderResult =
  | {
      ok: false;
      payload: Record<string, unknown>;
      statusCode: number;
    }
  | {
      ok: true;
      payload: {
        ok: true;
        venue: "polymarket";
        orderId: string;
        orderHash: string;
        status: string;
        stored: string;
        referralFirstTrade?: unknown;
        payload: unknown;
      };
    };

export type PolymarketRouteOperationResult =
  | {
      ok: false;
      payload: Record<string, unknown>;
      statusCode: number;
    }
  | {
      ok: true;
      payload: Record<string, unknown>;
    };

const capabilities = createCapability({
  authorizationMode: "embedded_privy_evm",
  venue: "polymarket",
});
const EMBEDDED_APPROVAL_THRESHOLD = 1n << 255n;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAddress(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

function normalizeFeeBps(value: unknown): number {
  if (value == null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function normalizeEvmAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function approvalSatisfiesEmbeddedAutomation(
  value: bigint | null | undefined,
): boolean {
  return Boolean(value != null && value >= EMBEDDED_APPROVAL_THRESHOLD);
}

function isEvmAddress(value: string | null | undefined): value is string {
  return typeof value === "string" && EVM_ADDRESS_RE.test(value.trim());
}

function buildPolymarketCancelSignerCandidates(inputs: {
  requestedWalletAddress: string | null | undefined;
  storedSignerAddress: string | null | undefined;
  storedWalletAddress: string | null | undefined;
}): string[] {
  return Array.from(
    new Map(
      [
        inputs.storedSignerAddress,
        inputs.requestedWalletAddress,
        inputs.storedWalletAddress,
      ]
        .filter(isEvmAddress)
        .map((address) => [address.toLowerCase(), address]),
    ).values(),
  );
}

export async function resolveEmbeddedPolymarketEnsureReadyState(input: {
  requestedFunder?: string | null;
  signer: string;
  user: User;
}) {
  const context = await resolveEmbeddedPolymarketWalletContext({
    user: input.user,
    signer: input.signer,
  });
  let credsInfo = await AuthService.getVenueCredentialsInfo(
    input.user.id,
    "polymarket",
    input.signer,
  );
  const storedFunder = credsInfo?.funderAddress ?? null;
  const funderDerivation = await derivePolymarketFunders({
    signer: input.signer,
    storedFunder: input.requestedFunder ?? storedFunder,
    includeMagicProxy: true,
    bypassCodeCache: true,
  });
  const signerNormalized = normalizeEvmAddress(input.signer);
  const findCandidate = (address: string | null | undefined) => {
    const normalized = normalizeEvmAddress(address);
    if (!normalized) return null;
    return (
      funderDerivation.candidates.find(
        (candidate) => normalizeEvmAddress(candidate.funder) === normalized,
      ) ?? null
    );
  };
  const requestedCandidate = findCandidate(input.requestedFunder ?? null);
  const storedCandidate =
    requestedCandidate &&
    storedFunder &&
    normalizeEvmAddress(storedFunder) ===
      normalizeEvmAddress(requestedCandidate.funder)
      ? requestedCandidate
      : findCandidate(storedFunder);
  const desiredDistinctCandidate =
    (requestedCandidate &&
    normalizeEvmAddress(requestedCandidate.funder) !== signerNormalized
      ? requestedCandidate
      : null) ??
    (storedCandidate &&
    normalizeEvmAddress(storedCandidate.funder) !== signerNormalized
      ? storedCandidate
      : null);
  const canPreserveDistinctCandidate = Boolean(
    desiredDistinctCandidate?.deployed &&
    (desiredDistinctCandidate.signatureType === 2 ||
      desiredDistinctCandidate.signatureType === 3 ||
      desiredDistinctCandidate.contractKind === "SAFE_LIKE"),
  );
  const effectiveDistinctFunder = canPreserveDistinctCandidate
    ? (desiredDistinctCandidate?.funder ?? null)
    : null;
  const effectiveFunder = effectiveDistinctFunder ?? input.signer;
  const shouldClearStoredFunder = Boolean(
    storedFunder &&
    normalizeEvmAddress(storedFunder) !== signerNormalized &&
    !effectiveDistinctFunder,
  );
  const shouldUpdateStoredFunder = Boolean(
    credsInfo &&
    effectiveDistinctFunder &&
    normalizeEvmAddress(credsInfo?.funderAddress ?? null) !==
      normalizeEvmAddress(effectiveDistinctFunder),
  );

  if (shouldClearStoredFunder) {
    await AuthService.updateVenueFunderAddress(
      input.user.id,
      input.signer,
      "polymarket",
      null,
    );
    credsInfo = await AuthService.getVenueCredentialsInfo(
      input.user.id,
      "polymarket",
      input.signer,
    );
  } else if (shouldUpdateStoredFunder && effectiveDistinctFunder) {
    await AuthService.updateVenueFunderAddress(
      input.user.id,
      input.signer,
      "polymarket",
      effectiveDistinctFunder,
    );
    credsInfo = await AuthService.getVenueCredentialsInfo(
      input.user.id,
      "polymarket",
      input.signer,
    );
  }

  const snapshot = await fetchPolymarketOnchainSnapshot({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    signer: input.signer,
    funder: effectiveFunder,
    includeFeeCollectorNonce: false,
    negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress,
    ctfCollateralAdapterAddress: env.polymarketCtfCollateralAdapterAddress,
    negRiskCollateralAdapterAddress:
      env.polymarketNegRiskCollateralAdapterAddress,
    feeCollectorAddress: null,
  });

  const approvalRequests = prepareEmbeddedPolymarketSignerApprovalRequests({
    context,
    funder: effectiveFunder,
    currentApprovals: {
      exchangeApproved: snapshot.okExchange,
      negRiskExchangeApproved: snapshot.okNegRisk,
      negRiskAdapterApproved: env.polymarketNegRiskAdapterAddress
        ? (snapshot.okNegRiskAdapter ?? false)
        : true,
      ctfCollateralAdapterApproved: env.polymarketCtfCollateralAdapterAddress
        ? (snapshot.okCtfCollateralAdapter ?? false)
        : true,
      negRiskCollateralAdapterApproved:
        env.polymarketNegRiskCollateralAdapterAddress
          ? (snapshot.okNegRiskCollateralAdapter ?? false)
          : true,
      feeCollectorApproved: true,
      exchangeAllowanceOk: approvalSatisfiesEmbeddedAutomation(
        snapshot.allowanceExchange,
      ),
      negRiskExchangeAllowanceOk: approvalSatisfiesEmbeddedAutomation(
        snapshot.allowanceNegRisk,
      ),
      negRiskAdapterAllowanceOk: env.polymarketNegRiskAdapterAddress
        ? approvalSatisfiesEmbeddedAutomation(
            snapshot.allowanceNegRiskAdapter ?? null,
          )
        : true,
      feeCollectorAllowanceOk: true,
    },
  });

  return {
    context,
    credsInfo,
    effectiveFunder,
    effectiveDistinctFunder,
    approvalRequests,
    clearedStoredFunder: shouldClearStoredFunder,
  };
}

export function buildEmbeddedPolymarketEnsureReadyResponse(args: {
  approvalExecution?: {
    funder: string;
    funderKind: "signer" | "safe" | "magic" | "deposit_wallet";
    signer: string;
    transactionHashes: string[];
  } | null;
  approvalsApplied?: boolean;
  clearedStoredFunder: boolean;
  connected?: boolean;
  effectiveDistinctFunder: string | null;
  effectiveFunder: string;
  signer: string;
}) {
  return {
    ok: true,
    signer: args.signer,
    funder: args.effectiveFunder,
    funderSource: args.effectiveDistinctFunder ? "stored" : "signer",
    connected: args.connected ?? false,
    clearedStoredFunder: args.clearedStoredFunder,
    approvalsApplied: args.approvalsApplied ?? false,
    approvalExecution: args.approvalExecution ?? null,
  };
}

export async function prepareEmbeddedPolymarketEnsureReadyRoute(input: {
  body: PolymarketEmbeddedEnsureReadyBody;
  log?: PolymarketRouteLogger | null;
  signer: string;
  user: User;
}): Promise<PolymarketRouteOperationResult> {
  try {
    const lockKey =
      normalizeEvmAddress(input.signer) ?? input.signer.toLowerCase();
    const existingExecution = getEmbeddedExecutionSingleFlightPromise<
      Record<string, unknown>
    >(
      buildEmbeddedExecutionSingleFlightKey(
        "polymarket-private",
        "embedded-ensure-ready",
        lockKey,
      ),
    );
    if (existingExecution) {
      await existingExecution;
      const settledState = await resolveEmbeddedPolymarketEnsureReadyState({
        user: input.user,
        signer: input.signer,
        requestedFunder: input.body.funderAddress ?? null,
      });
      return {
        ok: true,
        payload: {
          ok: true,
          signer: input.signer,
          funder: settledState.effectiveFunder,
          funderSource: settledState.effectiveDistinctFunder
            ? "stored"
            : "signer",
          clearedStoredFunder: settledState.clearedStoredFunder,
          requests: [],
        },
      };
    }

    const state = await resolveEmbeddedPolymarketEnsureReadyState({
      user: input.user,
      signer: input.signer,
      requestedFunder: input.body.funderAddress ?? null,
    });

    const requests = [...state.approvalRequests];
    if (!state.credsInfo) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = crypto.randomInt(1_000_000_000);
      requests.unshift(
        buildEmbeddedPolymarketConnectRequest({
          context: state.context,
          timestamp,
          nonce,
        }),
      );
      return {
        ok: true,
        payload: {
          ok: true,
          signer: input.signer,
          funder: state.effectiveFunder,
          funderSource: state.effectiveDistinctFunder ? "stored" : "signer",
          clearedStoredFunder: state.clearedStoredFunder,
          connectTimestamp: timestamp,
          connectNonce: nonce,
          requests,
        },
      };
    }

    return {
      ok: true,
      payload: {
        ok: true,
        signer: input.signer,
        funder: state.effectiveFunder,
        funderSource: state.effectiveDistinctFunder ? "stored" : "signer",
        clearedStoredFunder: state.clearedStoredFunder,
        requests,
      },
    };
  } catch (error) {
    input.log?.error?.(
      { error, userId: input.user.id, signer: input.signer },
      "Failed to prepare embedded Polymarket readiness",
    );
    return {
      ok: false,
      statusCode: 500,
      payload: {
        error:
          error instanceof Error
            ? error.message
            : "Embedded setup preparation failed",
      },
    };
  }
}

export async function executeEmbeddedPolymarketEnsureReadyRoute(input: {
  body: PolymarketEmbeddedEnsureReadyExecuteBody;
  log?: PolymarketRouteLogger | null;
  redis?: EmbeddedExecutionSingleFlightRedis | null;
  signer: string;
  user: User;
}): Promise<PolymarketRouteOperationResult> {
  try {
    const lockKey =
      normalizeEvmAddress(input.signer) ?? input.signer.toLowerCase();
    const singleFlightKey = buildEmbeddedExecutionSingleFlightKey(
      "polymarket-private",
      "embedded-ensure-ready",
      lockKey,
    );
    const existingExecution =
      getEmbeddedExecutionSingleFlightPromise<Record<string, unknown>>(
        singleFlightKey,
      );
    if (existingExecution) {
      return {
        ok: true,
        payload: await existingExecution,
      };
    }

    const result = await runEmbeddedExecutionSingleFlight({
      key: singleFlightKey,
      redis: input.redis,
      run: async () => {
        const state = await resolveEmbeddedPolymarketEnsureReadyState({
          user: input.user,
          signer: input.signer,
          requestedFunder: input.body.funderAddress ?? null,
        });

        let connected = false;
        if (!state.credsInfo) {
          const connectRequest = input.body.signedRequests.find(
            (entry) => entry.id === "polymarket-connect",
          );
          if (!connectRequest?.signature?.trim()) {
            throw new Error(
              "Missing Privy authorization signature for Polymarket connect",
            );
          }
          const connectTimestamp = input.body.connectTimestamp?.trim() ?? "";
          const connectNonce = input.body.connectNonce;
          if (!connectTimestamp || connectNonce == null) {
            throw new Error(
              "Embedded Polymarket connect requires the prepared timestamp and nonce.",
            );
          }
          const preparedConnectRequest = buildEmbeddedPolymarketConnectRequest({
            context: state.context,
            timestamp: connectTimestamp,
            nonce: connectNonce,
          });
          const connectSignature =
            await executeEmbeddedPolymarketConnectRequest({
              request: preparedConnectRequest,
              authorizationSignature: connectRequest.signature,
            });
          const { apiKey, apiSecret, passphrase } =
            await requestPolymarketCredentials({
              walletAddress: input.signer,
              signature: connectSignature,
              timestamp: connectTimestamp,
              nonce: connectNonce,
            });
          const additionalData: Record<string, unknown> = {
            passphrase,
            ...(state.effectiveDistinctFunder
              ? { funderAddress: state.effectiveDistinctFunder }
              : {}),
          };
          await AuthService.createOrUpdateVenueCredentials(
            input.user.id,
            input.signer,
            "polymarket",
            apiKey,
            apiSecret,
            additionalData,
          );
          connected = true;
        }

        const approvalRequests = state.approvalRequests;
        const approvalSignatures = input.body.signedRequests.filter((entry) =>
          entry.id.startsWith("approval-"),
        );
        const txHashes = await executeEmbeddedSignerApprovalRequests({
          requests: approvalRequests,
          signatures: approvalSignatures,
        });

        return buildEmbeddedPolymarketEnsureReadyResponse({
          signer: input.signer,
          effectiveFunder: state.effectiveFunder,
          effectiveDistinctFunder: state.effectiveDistinctFunder,
          clearedStoredFunder: state.clearedStoredFunder,
          connected,
          approvalsApplied: txHashes.length > 0,
          approvalExecution:
            txHashes.length > 0
              ? {
                  signer: input.signer,
                  funder: state.effectiveFunder,
                  funderKind: "signer",
                  transactionHashes: txHashes,
                }
              : null,
        });
      },
    });

    return {
      ok: true,
      payload: result,
    };
  } catch (error) {
    const responseStatus =
      typeof (error as { responseStatus?: unknown })?.responseStatus ===
      "number"
        ? (error as { responseStatus: number }).responseStatus
        : 500;
    const responsePayload =
      (error as { responsePayload?: unknown })?.responsePayload ?? undefined;
    input.log?.error?.(
      { error, userId: input.user.id, signer: input.signer },
      "Failed to execute embedded Polymarket readiness",
    );
    return {
      ok: false,
      statusCode: responseStatus,
      payload: {
        error: error instanceof Error ? error.message : "Embedded setup failed",
        ...(responsePayload !== undefined && isRecord(responsePayload)
          ? (responsePayload as Record<string, unknown>)
          : {}),
      },
    };
  }
}

function summarizePolymarketCancelPayload(inputs: {
  payload: unknown;
  orderId: string;
}): {
  canceled: string[];
  isCanceled: boolean;
  notCanceledReason: string | null;
} {
  const canceledRaw = isRecord(inputs.payload) ? inputs.payload.canceled : null;
  const canceled = Array.isArray(canceledRaw)
    ? canceledRaw.filter((value): value is string => typeof value === "string")
    : [];

  if (canceled.includes(inputs.orderId)) {
    return { canceled, isCanceled: true, notCanceledReason: null };
  }

  const notCanceled = isRecord(inputs.payload)
    ? inputs.payload.not_canceled
    : null;
  const notCanceledReason =
    isRecord(notCanceled) && typeof notCanceled[inputs.orderId] === "string"
      ? (notCanceled[inputs.orderId] as string)
      : canceled.length === 0
        ? `Order[${inputs.orderId}] was not canceled by Polymarket`
        : null;

  return { canceled, isCanceled: false, notCanceledReason };
}

function isPolymarketAlreadyClosedReason(
  reason: string | null | undefined,
): boolean {
  if (!reason) return false;
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes("already canceled") ||
    normalized.includes("already cancelled") ||
    normalized.includes("already matched") ||
    normalized.includes("matched orders can't be canceled") ||
    normalized.includes("matched orders can't be cancelled") ||
    normalized.includes("matched orders cannot be canceled") ||
    normalized.includes("matched orders cannot be cancelled") ||
    normalized.includes("can't be found") ||
    normalized.includes("cannot be found") ||
    normalized.includes("not found")
  );
}

function resolvePolymarketClosedReasonHint(
  reason: string | null | undefined,
): PolymarketClosedReasonHint {
  if (!reason) return null;
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return null;
  const mentionsMatched =
    normalized.includes("matched orders can't be canceled") ||
    normalized.includes("matched orders can't be cancelled") ||
    normalized.includes("matched orders cannot be canceled") ||
    normalized.includes("matched orders cannot be cancelled") ||
    normalized.includes("already matched") ||
    normalized.includes(" or matched");
  const mentionsCancelled =
    normalized.includes("already canceled") ||
    normalized.includes("already cancelled");
  const mentionsNotFound =
    normalized.includes("can't be found") ||
    normalized.includes("cannot be found") ||
    normalized.includes("not found");
  if ((mentionsMatched && mentionsCancelled) || mentionsNotFound) {
    return null;
  }
  if (
    normalized.includes("matched orders can't be canceled") ||
    normalized.includes("matched orders can't be cancelled") ||
    normalized.includes("matched orders cannot be canceled") ||
    normalized.includes("matched orders cannot be cancelled") ||
    normalized.includes("already matched")
  ) {
    return "matched";
  }
  if (mentionsCancelled) {
    return "cancelled";
  }
  return null;
}

function buildPolymarketAccountCacheKey(inputs: {
  credentialsKey: string;
  funder: string;
  funderUpdatedAt: string | null;
  signer: string;
  userId: string;
}): string {
  return [
    inputs.userId,
    normalizeAddress(inputs.signer),
    normalizeAddress(inputs.funder),
    inputs.credentialsKey,
    inputs.funderUpdatedAt ?? "none",
  ].join("|");
}

function readPolymarketAccountCache(
  key: string,
): PolymarketAccountPayload | null {
  if (env.polymarketAccountCacheTtlMs <= 0) return null;
  const entry = polymarketAccountCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    polymarketAccountCache.delete(key);
    return null;
  }
  return entry.value;
}

function writePolymarketAccountCache(
  key: string,
  value: PolymarketAccountPayload,
) {
  if (env.polymarketAccountCacheTtlMs <= 0) return;
  polymarketAccountCache.set(key, {
    value,
    expiresAt: Date.now() + env.polymarketAccountCacheTtlMs,
  });
}

function extractPolymarketUpstreamMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const trimmed = payload.trim();
    return trimmed.length ? trimmed : null;
  }
  if (!isRecord(payload)) return null;

  const direct = [
    payload.error,
    payload.message,
    payload.msg,
    payload.detail,
    payload.reason,
  ];
  for (const value of direct) {
    if (typeof value === "string" && value.trim().length) {
      return value.trim();
    }
  }

  const nestedError = payload.error;
  if (isRecord(nestedError)) {
    const nested = [
      nestedError.message,
      nestedError.error,
      nestedError.msg,
      nestedError.detail,
      nestedError.reason,
    ];
    for (const value of nested) {
      if (typeof value === "string" && value.trim().length) {
        return value.trim();
      }
    }
  }

  const errors = payload.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "string" && entry.trim().length) {
        return entry.trim();
      }
      if (isRecord(entry)) {
        const nested = [
          entry.message,
          entry.error,
          entry.msg,
          entry.detail,
          entry.reason,
        ];
        for (const value of nested) {
          if (typeof value === "string" && value.trim().length) {
            return value.trim();
          }
        }
      }
    }
  }

  return null;
}

function isPolymarketInvalidApiKeyResponse(inputs: {
  status: number;
  payload: unknown;
}): boolean {
  if (inputs.status !== 401) return false;
  const message = extractPolymarketUpstreamMessage(inputs.payload);
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes("unauthorized/invalid api key") ||
    normalized.includes("invalid api key")
  );
}

async function invalidatePolymarketCredentialsForInvalidApiKey(inputs: {
  endpoint: string;
  log?: PolymarketRouteLogger | null;
  signer: string;
  upstream: { status: number; payload: unknown };
  userId: string;
}): Promise<boolean> {
  if (!isPolymarketInvalidApiKeyResponse(inputs.upstream)) return false;

  const upstreamMessage = extractPolymarketUpstreamMessage(
    inputs.upstream.payload,
  );
  let deactivated = 0;
  try {
    deactivated = await AuthService.deactivateVenueCredentials(
      inputs.userId,
      "polymarket",
      inputs.signer,
    );
  } catch (error) {
    inputs.log?.error?.(
      {
        error,
        userId: inputs.userId,
        signer: inputs.signer,
        endpoint: inputs.endpoint,
        upstreamStatus: inputs.upstream.status,
        upstreamMessage,
      },
      "Failed to deactivate stale Polymarket credentials",
    );
  }

  inputs.log?.warn?.(
    {
      userId: inputs.userId,
      signer: inputs.signer,
      endpoint: inputs.endpoint,
      upstreamStatus: inputs.upstream.status,
      upstreamMessage,
      deactivated,
    },
    "Polymarket credentials invalidated after CLOB auth failure",
  );

  return true;
}

function isPolymarketDepositWalletRequiredMessage(
  message: string | null,
): boolean {
  const normalized = message?.toLowerCase() ?? "";
  return (
    normalized.includes("maker address not allowed") &&
    normalized.includes("deposit wallet")
  );
}

function polymarketCredentialsInvalidPayload(upstream: {
  status: number;
  payload: unknown;
}): Record<string, unknown> {
  return {
    error: "Reconnect Polymarket to refresh trading credentials.",
    code: POLYMARKET_CREDENTIALS_INVALID_CODE,
    reconnectRequired: true,
    status: upstream.status,
    payload: upstream.payload,
  };
}

function extractPolymarketOrderStatus(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct = payload.status;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }
  if (isRecord(payload.order)) {
    const nested = payload.order.status;
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }
  const result = payload.result;
  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }
  return null;
}

function isPolymarketOrderLookupNotFoundResponse(
  status: number | null | undefined,
  payload: unknown,
  orderId: string,
): boolean {
  if (status === 404) return true;
  if (status !== 400 && status !== 410) return false;
  const message = extractPolymarketUpstreamMessage(payload)?.toLowerCase();
  if (!message) return false;
  const hasNotFoundText =
    message.includes("not found") ||
    message.includes("can't be found") ||
    message.includes("cannot be found");
  if (!hasNotFoundText) return false;
  const normalizedOrderId = orderId.trim().toLowerCase();
  if (normalizedOrderId.length > 0 && message.includes(normalizedOrderId)) {
    return true;
  }
  return Boolean(
    message.match(
      /\b(order|hash)\b.{0,80}(not found|can't be found|cannot be found)/,
    ) ??
    message.match(
      /(not found|can't be found|cannot be found).{0,80}\b(order|hash)\b/,
    ),
  );
}

export async function reconcilePolymarketTerminalOrder(inputs: {
  userId: string;
  venueOrderId: string;
  statusHint?: PolymarketClosedReasonHint;
  externalFilledSize?: number | null;
  externalFillPrice?: number | null;
  externalHasExecution?: boolean;
  skipOnchainExecutionCheck?: boolean;
  allowAmbiguousNoFillReconcile?: boolean;
  allowExternalExecutionEvidence?: boolean;
  terminalNoFillStatus?: PolymarketNoFillTerminalStatus | null;
}): Promise<{
  status: PolymarketTerminalReconcileStatus;
  tokenId: string | null;
  side: string | null;
  size: number | null;
  price: number | null;
  walletAddress: string | null;
} | null> {
  const { rows } = await pool.query<{
    id: string;
    status: string | null;
    token_id: string | null;
    side: string | null;
    wallet_address: string | null;
    price: number | string | null;
    size: number | string | null;
    order_hash: string | null;
    order_payload: unknown | null;
    order_payload_version: string | null;
    order_type: string | null;
    filled_size: number | string | null;
    average_fill_price: number | string | null;
    has_positive_fill_rows: boolean;
  }>(
    `
      select
        id,
        status,
        token_id,
        side,
        wallet_address,
        price,
        size,
        order_hash,
        order_payload,
        order_payload_version,
        order_type,
        filled_size,
        average_fill_price,
        exists (
          select 1
          from order_fills f
          where f.order_id = orders.id
            and coalesce(f.fill_size, 0) > 0
        ) as has_positive_fill_rows
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
      order by
        (order_hash is not null)::int desc,
        posted_at desc nulls last,
        id desc
      limit 1
    `,
    [inputs.userId, inputs.venueOrderId],
  );

  const row = rows[0];
  if (!row) return null;

  const orderHash = row.order_hash?.trim() ?? null;
  const makerAmount = readMakerAmountFromOrderPayload(row.order_payload);
  const filledSize = parsePositiveNumber(row.filled_size);
  const orderSize = parsePositiveNumber(row.size);
  const averageFillPrice = parsePositiveNumber(row.average_fill_price);
  const orderPrice = parsePositiveNumber(row.price);
  const orderType = row.order_type?.trim().toUpperCase() ?? "";
  const externalFilledSize = parsePositiveNumber(inputs.externalFilledSize);
  const externalFillPrice = parsePositiveNumber(inputs.externalFillPrice);
  const hasExternalExecution =
    inputs.externalHasExecution === true || externalFilledSize != null;
  const hasStoredFill = filledSize != null || row.has_positive_fill_rows;
  const storedFillKind =
    hasStoredFill &&
    (orderType === "FOK" ||
      (filledSize != null && orderSize != null && filledSize >= orderSize))
      ? "full"
      : hasStoredFill
        ? "partial"
        : null;
  let executionSummary: { hasExecution: boolean } | null = null;

  if (
    !inputs.skipOnchainExecutionCheck &&
    !hasStoredFill &&
    orderHash &&
    makerAmount != null &&
    makerAmount > 0n
  ) {
    const exchangeAddress = await resolvePolymarketOrderExchangeAddress({
      tokenId: row.token_id?.trim() || null,
    });
    executionSummary = await fetchPolymarketExecutionSummary({
      exchangeAddress,
      orderHash,
      makerAmount,
      orderPayloadVersion:
        row.order_payload_version ??
        resolvePolymarketOrderPayloadVersion(row.order_payload),
    });
  }

  const hasExecutionEvidence =
    hasStoredFill ||
    executionSummary?.hasExecution === true ||
    (inputs.allowExternalExecutionEvidence !== false && hasExternalExecution);
  const hasDefinitiveNoFillEvidence = inputs.statusHint === "cancelled";
  if (
    !hasExecutionEvidence &&
    !hasDefinitiveNoFillEvidence &&
    inputs.allowAmbiguousNoFillReconcile !== true
  ) {
    return null;
  }

  const nextStatus = resolvePolymarketTerminalReconcileStatus({
    statusHint: inputs.statusHint,
    hasStoredFill:
      storedFillKind === "full" || (!hasStoredFill && hasExecutionEvidence),
    storedFillKind,
    executionSummary,
    noFillStatus: inputs.terminalNoFillStatus ?? null,
  });
  if (!nextStatus) return null;
  const allowPartialTerminalClose =
    storedFillKind === "partial" &&
    (nextStatus === "cancelled" || nextStatus === "expired");
  if (
    nextStatus !== "matched" &&
    !allowPartialTerminalClose &&
    !canApplyPolymarketNoFillTerminalStatus({
      currentStatus: row.status,
      hasPositiveFillRows: row.has_positive_fill_rows,
    })
  ) {
    return null;
  }

  const updateResult = await pool.query(
    `
      update orders o
      set status = $2,
          cancelled_at = case when $2 = 'cancelled' then coalesce(cancelled_at, now()) else cancelled_at end,
          filled_at = case when $2 = 'matched' then coalesce(filled_at, now()) else filled_at end,
          filled_size = case
            when $2 = 'matched' and $4::numeric is not null and coalesce(filled_size, 0) = 0
              then $4::numeric
            else filled_size
          end,
          average_fill_price = case
            when $2 = 'matched' and $5::numeric is not null and average_fill_price is null
              then $5::numeric
            else average_fill_price
          end,
          last_update = now()
      where o.user_id = $1
        and o.id = $6
        and o.venue = 'polymarket'
        and o.venue_order_id = $3
        and (
          $2 = 'matched'
          or (
            $7::boolean = true
            and lower(coalesce(o.status, '')) = 'partially_filled'
            and exists (
              select 1
              from order_fills f
              where f.order_id = o.id
                and coalesce(f.fill_size, 0) > 0
            )
          )
          or (
            lower(coalesce(o.status, '')) in ('pending', 'submitted', 'live', 'open', 'delayed', 'unconfirmed')
            and not exists (
              select 1
              from order_fills f
              where f.order_id = o.id
                and coalesce(f.fill_size, 0) > 0
            )
          )
        )
    `,
    [
      inputs.userId,
      nextStatus,
      inputs.venueOrderId,
      externalFilledSize,
      externalFillPrice,
      row.id,
      allowPartialTerminalClose,
    ],
  );

  if ((updateResult.rowCount ?? 0) === 0) return null;

  return {
    status: nextStatus,
    tokenId: row.token_id ?? null,
    side: row.side ?? null,
    size:
      nextStatus === "matched"
        ? (externalFilledSize ?? filledSize ?? orderSize)
        : orderSize,
    price:
      nextStatus === "matched"
        ? (externalFillPrice ?? averageFillPrice ?? orderPrice)
        : orderPrice,
    walletAddress: row.wallet_address ?? null,
  };
}

export async function markPolymarketDelayedOrderUnconfirmed(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `
      update orders
      set status = $3,
          last_update = now()
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
        and lower(coalesce(status, '')) = 'delayed'
    `,
    [inputs.userId, inputs.venueOrderId, POLYMARKET_UNCONFIRMED_STATUS],
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasPolymarketOrderExecutionEvidence(
  orderId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ has_execution: boolean }>(
    `
      select
        (
          lower(coalesce(o.status, '')) in ('matched', 'filled', 'partially_filled')
          or coalesce(o.filled_size, 0) > 0
          or exists (
            select 1
            from order_fills f
            where f.order_id = o.id
              and coalesce(f.fill_size, 0) > 0
          )
        ) as has_execution
      from orders o
      where o.id = $1
      limit 1
    `,
    [orderId],
  );
  return rows[0]?.has_execution === true;
}

export async function hasPolymarketVenueOrderExecutionEvidence(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const { rows } = await pool.query<{ has_execution: boolean }>(
    `
      select
        (
          lower(coalesce(o.status, '')) in ('matched', 'filled', 'partially_filled')
          or coalesce(o.filled_size, 0) > 0
          or exists (
            select 1
            from order_fills f
            where f.order_id = o.id
              and coalesce(f.fill_size, 0) > 0
          )
        ) as has_execution
      from orders o
      where o.user_id = $1
        and o.venue = 'polymarket'
        and o.venue_order_id = $2
      limit 1
    `,
    [inputs.userId, inputs.venueOrderId],
  );
  return rows[0]?.has_execution === true;
}

export async function isPolymarketOrderNoFillGraceElapsed(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const { rows } = await pool.query<{ posted_at: Date | null }>(
    `
      select posted_at
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
      order by posted_at desc nulls last
      limit 1
    `,
    [inputs.userId, inputs.venueOrderId],
  );
  return isPolymarketNoFillGraceElapsed(rows[0]?.posted_at ?? null);
}

export async function fetchPolymarketClobOrderExecutionEvidence(inputs: {
  creds: PolymarketL2Credentials;
  log: { warn: (payload: unknown, message?: string) => void };
  orderId: string;
  signer: string;
}): Promise<{
  checked: boolean;
  externalFillPrice: number | null;
  externalFilledSize: number | null;
  hasExecution: boolean;
  orderType: string | null;
  orderStatus: string | null;
  payload: unknown;
  statusHint: PolymarketClosedReasonHint;
}> {
  try {
    const upstream = await fetchPolymarketOrderByHash({
      baseUrl: env.polymarketClobBase,
      timeoutMs: 10_000,
      address: inputs.signer,
      creds: inputs.creds,
      orderHash: inputs.orderId,
    });

    if (!upstream.ok) {
      if (
        isPolymarketOrderLookupNotFoundResponse(
          upstream.status,
          upstream.payload,
          inputs.orderId,
        )
      ) {
        return {
          checked: true,
          externalFillPrice: null,
          externalFilledSize: null,
          hasExecution: false,
          orderType: null,
          orderStatus: "not_found",
          payload: upstream.payload,
          statusHint: null,
        };
      }

      inputs.log.warn(
        {
          orderId: inputs.orderId,
          signer: inputs.signer,
          status: upstream.status,
          payload: upstream.payload,
        },
        "Polymarket cancel reconcile order status lookup failed",
      );
      return {
        checked: false,
        externalFillPrice: null,
        externalFilledSize: null,
        hasExecution: false,
        orderType: null,
        orderStatus: null,
        payload: upstream.payload,
        statusHint: null,
      };
    }

    if (!upstream.order) {
      inputs.log.warn(
        {
          orderId: inputs.orderId,
          signer: inputs.signer,
          payload: upstream.payload,
        },
        "Polymarket order status lookup returned no order",
      );
      return {
        checked: true,
        externalFillPrice: null,
        externalFilledSize: null,
        hasExecution: false,
        orderType: null,
        orderStatus: "not_found",
        payload: upstream.payload,
        statusHint: null,
      };
    }

    const summary = summarizePolymarketClobOrderExecution({
      associateTrades: upstream.order?.associateTrades ?? null,
      sizeMatched: upstream.order?.sizeMatched ?? null,
      status: upstream.order?.status ?? null,
    });

    return {
      checked: true,
      externalFillPrice: summary.hasExecution
        ? parsePositiveNumber(upstream.order?.price)
        : null,
      externalFilledSize: summary.hasExecution
        ? parsePositiveNumber(upstream.order?.sizeMatched)
        : null,
      hasExecution: summary.hasExecution,
      orderType: upstream.order?.type ?? null,
      orderStatus: upstream.order?.status ?? null,
      payload: upstream.payload,
      statusHint: summary.statusHint,
    };
  } catch (error) {
    inputs.log.warn(
      { error, orderId: inputs.orderId, signer: inputs.signer },
      "Polymarket cancel reconcile order status lookup errored",
    );
    return {
      checked: false,
      externalFillPrice: null,
      externalFilledSize: null,
      hasExecution: false,
      orderType: null,
      orderStatus: null,
      payload: null,
      statusHint: null,
    };
  }
}

function isPolymarketClobOpenStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  return (
    normalized === "open" ||
    normalized === "live" ||
    normalized === "pending" ||
    normalized === "partially_filled"
  );
}

function isPolymarketClobCancelledStatus(status: string | null | undefined) {
  const normalized = status?.trim().toLowerCase() ?? "";
  return (
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized === "cancelled_by_user" ||
    normalized === "canceled_by_user"
  );
}

export function isPolymarketClobNoFillTerminalStatus(
  status: string | null | undefined,
) {
  return resolvePolymarketClobNoFillTerminalStatus(status) != null;
}

export function resolvePolymarketClobNoFillTerminalStatus(
  status: string | null | undefined,
): PolymarketNoFillTerminalStatus | null {
  const normalized = status?.trim().toLowerCase() ?? "";
  if (normalized === "expired") return "expired";
  if (
    normalized === "not_found" ||
    normalized === "invalid" ||
    normalized === "unmatched"
  ) {
    return "unmatched";
  }
  return null;
}

function isPolymarketPendingLocalOrderStatus(
  status: string | null | undefined,
) {
  const normalized = status?.trim().toLowerCase() ?? "";
  return normalized === "delayed" || normalized === "unconfirmed";
}

async function markPolymarketOrderLiveFromClob(inputs: {
  userId: string;
  venueOrderId: string;
}): Promise<boolean> {
  const result = await pool.query(
    `
      update orders
      set status = 'live',
          last_update = now()
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = $2
        and lower(coalesce(status, '')) in ('delayed', 'unconfirmed')
        and cancelled_at is null
        and lower(coalesce(status, '')) in ('pending', 'submitted', 'live', 'open', 'delayed', 'unconfirmed')
    `,
    [inputs.userId, inputs.venueOrderId],
  );
  return (result.rowCount ?? 0) > 0;
}

function normalizePolymarketOrdersSyncOrderIds(
  values: string[] | undefined,
): string[] {
  if (!values?.length) return [];
  const ids = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    ids.set(trimmed.toLowerCase(), trimmed);
  }
  return Array.from(ids.values());
}

async function fetchStoredPolymarketOrderSigners(inputs: {
  userId: string;
  orderIds: string[];
}): Promise<string[]> {
  if (inputs.orderIds.length === 0) return [];
  const { rows } = await pool.query<{ signer_address: string | null }>(
    `
      select distinct signer_address
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = any($2::text[])
        and signer_address is not null
      order by signer_address
    `,
    [inputs.userId, inputs.orderIds],
  );
  return rows
    .map((row) => row.signer_address?.trim() ?? "")
    .filter((address) => EVM_ADDRESS_RE.test(address));
}

async function fetchStoredPolymarketOrderWallets(inputs: {
  userId: string;
  orderIds: string[];
}): Promise<string[]> {
  if (inputs.orderIds.length === 0) return [];
  const { rows } = await pool.query<{ wallet_address: string | null }>(
    `
      select distinct wallet_address
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = any($2::text[])
        and wallet_address is not null
      order by wallet_address
    `,
    [inputs.userId, inputs.orderIds],
  );
  return rows
    .map((row) => row.wallet_address?.trim() ?? "")
    .filter((address) => EVM_ADDRESS_RE.test(address));
}

async function fetchPolymarketCredentialSignersForTargetWallet(inputs: {
  userId: string;
  targetWalletAddress: string | null;
}): Promise<string[]> {
  const target = inputs.targetWalletAddress?.trim() ?? "";
  if (!EVM_ADDRESS_RE.test(target)) return [];
  const { rows } = await pool.query<{ wallet_address: string }>(
    `
      select wallet_address
      from user_venue_credentials
      where user_id = $1
        and venue = 'polymarket'
        and is_active = true
        and (
          lower(wallet_address) = lower($2)
          or lower(coalesce(funder_address, '')) = lower($2)
        )
      order by
        case when lower(wallet_address) = lower($2) then 0 else 1 end,
        last_used_at desc nulls last,
        updated_at desc
    `,
    [inputs.userId, target],
  );
  return rows
    .map((row) => row.wallet_address.trim())
    .filter((address) => EVM_ADDRESS_RE.test(address));
}

async function resolvePolymarketOrdersSyncSignerCandidates(inputs: {
  userId: string;
  authWalletAddress: string | null | undefined;
  orderIds: string[];
  targetWalletAddress: string | null;
}): Promise<{ authFallbackSigner: string | null; signers: string[] }> {
  const candidates = new Map<string, string>();
  let authFallbackSigner: string | null = null;
  const isTargeted =
    inputs.orderIds.length > 0 || Boolean(inputs.targetWalletAddress?.trim());
  const addCandidate = (value: string | null | undefined) => {
    const trimmed = value?.trim() ?? "";
    if (!EVM_ADDRESS_RE.test(trimmed)) return;
    candidates.set(trimmed.toLowerCase(), trimmed);
  };

  for (const signer of await fetchStoredPolymarketOrderSigners({
    userId: inputs.userId,
    orderIds: inputs.orderIds,
  })) {
    addCandidate(signer);
  }

  for (const signer of await fetchPolymarketCredentialSignersForTargetWallet({
    userId: inputs.userId,
    targetWalletAddress: inputs.targetWalletAddress,
  })) {
    addCandidate(signer);
  }

  for (const wallet of await fetchStoredPolymarketOrderWallets({
    userId: inputs.userId,
    orderIds: inputs.orderIds,
  })) {
    for (const signer of await fetchPolymarketCredentialSignersForTargetWallet({
      userId: inputs.userId,
      targetWalletAddress: wallet,
    })) {
      addCandidate(signer);
    }
  }

  if (!isTargeted) {
    addCandidate(inputs.authWalletAddress);
  } else if (inputs.orderIds.length > 0 && candidates.size === 0) {
    const trimmed = inputs.authWalletAddress?.trim() ?? "";
    if (EVM_ADDRESS_RE.test(trimmed)) {
      authFallbackSigner = trimmed;
    }
  }
  if (inputs.orderIds.length > 0 && authFallbackSigner == null && isTargeted) {
    const trimmed = inputs.authWalletAddress?.trim() ?? "";
    if (EVM_ADDRESS_RE.test(trimmed)) {
      authFallbackSigner = trimmed;
    }
  }
  return {
    authFallbackSigner,
    signers: Array.from(candidates.values()),
  };
}

function normalizePolymarketSyncWalletAliases(
  values: Array<string | null | undefined>,
): string[] {
  const aliases = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (!EVM_ADDRESS_RE.test(trimmed)) continue;
    aliases.set(trimmed.toLowerCase(), trimmed.toLowerCase());
  }
  return Array.from(aliases.values());
}

function resolvePolymarketSignerWalletAliases(inputs: {
  signer: string;
  funderAddress?: string | null;
  authWalletAddress?: string | null;
  targetWalletAddress?: string | null;
}): string[] {
  const signerAliases = normalizePolymarketSyncWalletAliases([
    inputs.signer,
    inputs.funderAddress,
  ]);
  const signerAliasSet = new Set(signerAliases);
  const optionalAliases = normalizePolymarketSyncWalletAliases([
    inputs.authWalletAddress,
    inputs.targetWalletAddress,
  ]).filter((alias) => signerAliasSet.has(alias));
  return normalizePolymarketSyncWalletAliases([
    ...signerAliases,
    ...optionalAliases,
  ]);
}

async function backfillPolymarketRequestedOrderSigner(inputs: {
  userId: string;
  signerAddress: string;
  requestedOrderIds: string[];
  walletAliases: string[];
}): Promise<number> {
  if (
    inputs.requestedOrderIds.length === 0 ||
    inputs.walletAliases.length === 0
  ) {
    return 0;
  }
  const result = await pool.query(
    `
      update orders
      set signer_address = $2
      where user_id = $1
        and venue = 'polymarket'
        and venue_order_id = any($3::text[])
        and (signer_address is null or btrim(signer_address) = '')
        and lower(coalesce(wallet_address, '')) = any($4::text[])
    `,
    [
      inputs.userId,
      inputs.signerAddress,
      inputs.requestedOrderIds,
      inputs.walletAliases,
    ],
  );
  return result.rowCount ?? 0;
}

function isPolymarketNoFillGraceElapsed(postedAt: Date | null | undefined) {
  if (!postedAt) return false;
  return (
    Date.now() - postedAt.getTime() >=
    POLYMARKET_CLOB_NOT_FOUND_NO_FILL_GRACE_MS
  );
}

function resolvePolymarketUnconfirmedTradeSyncAfterSecOverride(
  rows: Array<{ posted_at: Date | null | undefined }>,
): number | null {
  let earliestPostedAtMs: number | null = null;
  for (const row of rows) {
    const postedAtMs = row.posted_at?.getTime();
    if (postedAtMs == null || !Number.isFinite(postedAtMs)) continue;
    earliestPostedAtMs =
      earliestPostedAtMs == null
        ? postedAtMs
        : Math.min(earliestPostedAtMs, postedAtMs);
  }
  if (earliestPostedAtMs == null) return null;
  return Math.max(
    0,
    Math.floor(
      (earliestPostedAtMs - POLYMARKET_UNCONFIRMED_TRADE_SYNC_LOOKBACK_MS) /
        1000,
    ),
  );
}

function resolvePolymarketOpenOrderTimestampMs(inputs: {
  createdAt?: string | null;
  postedAt?: Date | null;
}): number | null {
  const createdAt = parseNumberish(inputs.createdAt);
  if (createdAt != null && createdAt > 0) {
    return createdAt > 1_000_000_000_000 ? createdAt : createdAt * 1000;
  }
  const postedAtMs = inputs.postedAt?.getTime();
  return postedAtMs != null && Number.isFinite(postedAtMs) ? postedAtMs : null;
}

function resolvePolymarketTradeSyncAfterSecFromMs(
  timestampMs: number | null,
): number | null {
  if (timestampMs == null || !Number.isFinite(timestampMs)) return null;
  return Math.max(
    0,
    Math.floor(
      (timestampMs - POLYMARKET_UNCONFIRMED_TRADE_SYNC_LOOKBACK_MS) / 1000,
    ),
  );
}

async function reconcileDelayedPolymarketOrdersAfterOpenSync(inputs: {
  creds: PolymarketL2Credentials;
  openVenueOrderIds: string[];
  requestedOrderIds: string[];
  signerAddress: string;
  userId: string;
  walletAliases: string[];
  log: { warn: (payload: unknown, message?: string) => void };
}) {
  const { rows } = await pool.query<{
    id: string;
    venue_order_id: string;
    order_type: string | null;
    posted_at: Date | null;
  }>(
    `
      select id, venue_order_id, order_type, posted_at
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and lower(coalesce(status, '')) = 'delayed'
        and venue_order_id is not null
        and (
          lower(coalesce(signer_address, '')) = any($2::text[])
          or lower(coalesce(wallet_address, '')) = any($2::text[])
        )
        and (
          venue_order_id = any($3::text[])
          or not (venue_order_id = any($4::text[]))
        )
      order by
        (venue_order_id = any($3::text[])) desc,
        posted_at desc nulls last,
        last_update desc nulls last
      limit $5
    `,
    [
      inputs.userId,
      inputs.walletAliases,
      inputs.requestedOrderIds,
      inputs.openVenueOrderIds,
      25 + inputs.requestedOrderIds.length,
    ],
  );

  let checked = 0;
  let matchedCount = 0;
  let cancelledCount = 0;
  let unmatchedCount = 0;
  let unconfirmedCount = 0;
  let skippedOpenCount = 0;
  let liveCount = 0;
  let expiredCount = 0;
  const tradeSyncAfterSecOverride =
    resolvePolymarketUnconfirmedTradeSyncAfterSecOverride(rows);
  let tradeSyncForFillPromise: Promise<void> | null = null;
  const syncFillsOnce = () => {
    tradeSyncForFillPromise ??= (async () => {
      await syncPolymarketTradesForSigner(
        pool,
        {
          userId: inputs.userId,
          signerAddress: inputs.signerAddress,
        },
        {
          afterSecOverride: tradeSyncAfterSecOverride,
        },
      );
    })();
    return tradeSyncForFillPromise;
  };

  for (const row of rows) {
    const orderId = row.venue_order_id?.trim();
    if (!orderId) continue;
    const evidence = await fetchPolymarketClobOrderExecutionEvidence({
      creds: inputs.creds,
      log: inputs.log,
      orderId,
      signer: inputs.signerAddress,
    });
    if (!evidence.checked) continue;
    checked += 1;
    if (evidence.hasExecution) {
      try {
        await syncFillsOnce();
      } catch (error) {
        inputs.log.warn(
          {
            error,
            userId: inputs.userId,
            signerAddress: inputs.signerAddress,
            orderId,
            afterSecOverride: tradeSyncAfterSecOverride,
          },
          "Polymarket delayed order fill sync failed",
        );
      }
      if (!(await hasPolymarketOrderExecutionEvidence(row.id))) {
        const marked = await markPolymarketDelayedOrderUnconfirmed({
          userId: inputs.userId,
          venueOrderId: orderId,
        });
        if (marked) unconfirmedCount += 1;
        continue;
      }
    }

    if (
      !evidence.hasExecution &&
      isPolymarketClobOpenStatus(evidence.orderStatus)
    ) {
      skippedOpenCount += 1;
      const markedLive = await markPolymarketOrderLiveFromClob({
        userId: inputs.userId,
        venueOrderId: orderId,
      });
      if (markedLive) liveCount += 1;
      continue;
    }

    const noFillTerminalStatus = evidence.hasExecution
      ? null
      : resolvePolymarketClobNoFillTerminalStatus(evidence.orderStatus);

    const reconciled = await reconcilePolymarketTerminalOrder({
      userId: inputs.userId,
      venueOrderId: orderId,
      statusHint: evidence.statusHint,
      externalFilledSize: evidence.externalFilledSize,
      externalFillPrice: evidence.externalFillPrice,
      externalHasExecution: evidence.hasExecution,
      skipOnchainExecutionCheck: true,
      allowAmbiguousNoFillReconcile:
        noFillTerminalStatus != null &&
        isPolymarketNoFillGraceElapsed(row.posted_at),
      allowExternalExecutionEvidence: false,
      terminalNoFillStatus: noFillTerminalStatus,
    });

    if (reconciled?.status === "matched") matchedCount += 1;
    if (reconciled?.status === "cancelled") cancelledCount += 1;
    if (reconciled?.status === "unmatched") unmatchedCount += 1;
    if (reconciled?.status === "expired") expiredCount += 1;
    if (!reconciled) {
      const marked = await markPolymarketDelayedOrderUnconfirmed({
        userId: inputs.userId,
        venueOrderId: orderId,
      });
      if (marked) unconfirmedCount += 1;
    }
    if (reconciled && reconciled.status !== "matched") {
      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: inputs.userId,
          venue: "polymarket",
          status: reconciled.status,
          side: reconciled.side,
          size: reconciled.size,
          price: reconciled.price,
          orderId,
          tokenId: reconciled.tokenId,
          walletAddress: reconciled.walletAddress ?? inputs.signerAddress,
        }),
        inputs.log,
      );
    }
  }

  return {
    checked,
    matchedCount,
    cancelledCount,
    unmatchedCount,
    expiredCount,
    unconfirmedCount,
    skippedOpenCount,
    liveCount,
  };
}

async function reconcileUnconfirmedOrders(inputs: {
  creds: PolymarketL2Credentials;
  userId: string;
  requestedOrderIds: string[];
  signerAddress: string;
  walletAliases: string[];
  log: { warn: (payload: unknown, message?: string) => void };
}) {
  const { rows } = await pool.query<PolymarketUnconfirmedRow>(
    `
      select
        id,
        venue_order_id,
        token_id,
        side,
        wallet_address,
        price,
        size,
        order_type,
        order_hash,
        order_payload,
        order_payload_version,
        posted_at
      from orders
      where user_id = $1
        and venue = 'polymarket'
        and status = $3
        and (
          order_hash is not null
          or venue_order_id is not null
        )
        and (
          lower(coalesce(signer_address, '')) = any($2::text[])
          or lower(coalesce(wallet_address, '')) = any($2::text[])
        )
      order by
        (venue_order_id = any($4::text[])) desc,
        posted_at desc nulls last
      limit $5
    `,
    [
      inputs.userId,
      inputs.walletAliases,
      POLYMARKET_UNCONFIRMED_STATUS,
      inputs.requestedOrderIds,
      POLYMARKET_UNCONFIRMED_LIMIT + inputs.requestedOrderIds.length,
    ],
  );

  if (!rows.length) {
    return {
      checked: 0,
      confirmedCount: 0,
      cancelledCount: 0,
      unmatchedCount: 0,
      expiredCount: 0,
    };
  }

  let confirmedCount = 0;
  let cancelledCount = 0;
  let unmatchedCount = 0;
  let expiredCount = 0;
  const exchangeAddressByTokenId = new Map<string, string>();
  const tradeSyncAfterSecOverride =
    resolvePolymarketUnconfirmedTradeSyncAfterSecOverride(rows);
  let tradeSyncForFillPromise: Promise<void> | null = null;
  const syncUnconfirmedFillsOnce = () => {
    tradeSyncForFillPromise ??= (async () => {
      await syncPolymarketTradesForSigner(
        pool,
        {
          userId: inputs.userId,
          signerAddress: inputs.signerAddress,
        },
        {
          afterSecOverride: tradeSyncAfterSecOverride,
        },
      );
    })();
    return tradeSyncForFillPromise;
  };

  for (const row of rows) {
    const orderHash = row.order_hash?.trim();
    const makerAmount = readMakerAmountFromOrderPayload(row.order_payload);

    try {
      if (orderHash && makerAmount != null && makerAmount > 0n) {
        const tokenId = row.token_id?.trim() || null;
        let exchangeAddress =
          tokenId != null
            ? (exchangeAddressByTokenId.get(tokenId) ?? null)
            : null;
        if (!exchangeAddress) {
          exchangeAddress = await resolvePolymarketOrderExchangeAddress({
            tokenId,
          });
          if (tokenId) {
            exchangeAddressByTokenId.set(tokenId, exchangeAddress);
          }
        }

        const summary = await fetchPolymarketExecutionSummary({
          exchangeAddress,
          orderHash,
          makerAmount,
          orderPayloadVersion:
            row.order_payload_version ??
            resolvePolymarketOrderPayloadVersion(row.order_payload),
        });
        const decision = resolvePolymarketUnconfirmedReconcileDecision(summary);
        if (decision === "sync_for_fill") {
          try {
            await syncUnconfirmedFillsOnce();
          } catch (error) {
            inputs.log.warn(
              {
                error,
                userId: inputs.userId,
                signerAddress: inputs.signerAddress,
                orderId: row.id,
                venueOrderId: row.venue_order_id,
                afterSecOverride: tradeSyncAfterSecOverride,
              },
              "Polymarket unconfirmed order fill sync failed",
            );
          }
          if (await hasPolymarketOrderExecutionEvidence(row.id)) {
            confirmedCount += 1;
          }
          continue;
        }
        if (!isPolymarketUnconfirmedStatus(decision)) {
          const updateResult = await pool.query(
            `
              update orders o
              set status = $2,
                  filled_at = null,
                  last_update = now()
              where o.id = $1
                and o.status = $3
                and lower(coalesce(o.status, '')) in ('pending', 'submitted', 'live', 'open', 'delayed', 'unconfirmed')
                and not exists (
                  select 1
                  from order_fills f
                  where f.order_id = o.id
                    and coalesce(f.fill_size, 0) > 0
                )
            `,
            [row.id, decision, POLYMARKET_UNCONFIRMED_STATUS],
          );
          if ((updateResult.rowCount ?? 0) === 0) continue;
          if (decision === "unmatched") {
            unmatchedCount += 1;
            void createNotificationSafe(
              pool,
              buildOrderNotification({
                userId: inputs.userId,
                venue: "polymarket",
                status: decision,
                side: row.side,
                size: row.size,
                price: row.price,
                orderId: row.venue_order_id,
                tokenId: row.token_id,
                walletAddress: row.wallet_address ?? inputs.signerAddress,
              }),
              inputs.log,
            );
          }
          continue;
        }
      }

      const venueOrderId = row.venue_order_id?.trim();
      if (venueOrderId) {
        const evidence = await fetchPolymarketClobOrderExecutionEvidence({
          creds: inputs.creds,
          log: inputs.log,
          orderId: venueOrderId,
          signer: inputs.signerAddress,
        });
        if (!evidence.checked) continue;
        if (evidence.hasExecution) {
          try {
            await syncUnconfirmedFillsOnce();
          } catch (error) {
            inputs.log.warn(
              {
                error,
                userId: inputs.userId,
                signerAddress: inputs.signerAddress,
                orderId: row.id,
                venueOrderId,
                afterSecOverride: tradeSyncAfterSecOverride,
              },
              "Polymarket unconfirmed order fill sync failed",
            );
          }
          if (!(await hasPolymarketOrderExecutionEvidence(row.id))) {
            continue;
          }
          if (
            evidence.statusHint === "cancelled" ||
            isPolymarketClobCancelledStatus(evidence.orderStatus)
          ) {
            const reconciled = await reconcilePolymarketTerminalOrder({
              userId: inputs.userId,
              venueOrderId,
              statusHint: "cancelled",
              externalFilledSize: null,
              externalFillPrice: null,
              externalHasExecution: false,
              skipOnchainExecutionCheck: true,
              allowAmbiguousNoFillReconcile: true,
              allowExternalExecutionEvidence: false,
              terminalNoFillStatus: null,
            });
            if (reconciled?.status === "cancelled") {
              cancelledCount += 1;
              void createNotificationSafe(
                pool,
                buildOrderNotification({
                  userId: inputs.userId,
                  venue: "polymarket",
                  status: "cancelled",
                  side: reconciled.side,
                  size: reconciled.size,
                  price: reconciled.price,
                  orderId: venueOrderId,
                  tokenId: reconciled.tokenId,
                  walletAddress:
                    reconciled.walletAddress ?? inputs.signerAddress,
                }),
                inputs.log,
              );
              continue;
            }
          }
          confirmedCount += 1;
          continue;
        }
        if (
          evidence.statusHint === "cancelled" ||
          isPolymarketClobCancelledStatus(evidence.orderStatus)
        ) {
          const reconciled = await reconcilePolymarketTerminalOrder({
            userId: inputs.userId,
            venueOrderId,
            statusHint: "cancelled",
            externalFilledSize: null,
            externalFillPrice: null,
            externalHasExecution: false,
            skipOnchainExecutionCheck: true,
            allowAmbiguousNoFillReconcile: true,
            allowExternalExecutionEvidence: false,
            terminalNoFillStatus: null,
          });
          if (reconciled?.status === "cancelled") {
            cancelledCount += 1;
            void createNotificationSafe(
              pool,
              buildOrderNotification({
                userId: inputs.userId,
                venue: "polymarket",
                status: "cancelled",
                side: reconciled.side,
                size: reconciled.size,
                price: reconciled.price,
                orderId: venueOrderId,
                tokenId: reconciled.tokenId,
                walletAddress: reconciled.walletAddress ?? inputs.signerAddress,
              }),
              inputs.log,
            );
          }
          continue;
        }
        if (isPolymarketClobOpenStatus(evidence.orderStatus)) {
          await markPolymarketOrderLiveFromClob({
            userId: inputs.userId,
            venueOrderId,
          });
          continue;
        }
        const noFillTerminalStatus = resolvePolymarketClobNoFillTerminalStatus(
          evidence.orderStatus,
        );
        if (
          noFillTerminalStatus != null &&
          isPolymarketNoFillGraceElapsed(row.posted_at)
        ) {
          const reconciled = await reconcilePolymarketTerminalOrder({
            userId: inputs.userId,
            venueOrderId,
            statusHint: null,
            externalFilledSize: null,
            externalFillPrice: null,
            externalHasExecution: false,
            skipOnchainExecutionCheck: true,
            allowAmbiguousNoFillReconcile: true,
            allowExternalExecutionEvidence: false,
            terminalNoFillStatus: noFillTerminalStatus,
          });
          if (
            reconciled?.status === "unmatched" ||
            reconciled?.status === "expired"
          ) {
            if (reconciled.status === "unmatched") unmatchedCount += 1;
            if (reconciled.status === "expired") expiredCount += 1;
            void createNotificationSafe(
              pool,
              buildOrderNotification({
                userId: inputs.userId,
                venue: "polymarket",
                status: reconciled.status,
                side: reconciled.side,
                size: reconciled.size,
                price: reconciled.price,
                orderId: venueOrderId,
                tokenId: reconciled.tokenId,
                walletAddress: reconciled.walletAddress ?? inputs.signerAddress,
              }),
              inputs.log,
            );
          }
        }
      }
    } catch (error) {
      inputs.log.warn(
        {
          error,
          userId: inputs.userId,
          signerAddress: inputs.signerAddress,
          orderId: row.id,
          orderHash,
        },
        "Polymarket unconfirmed order reconcile failed",
      );
    }
  }

  return {
    checked: rows.length,
    confirmedCount,
    cancelledCount,
    unmatchedCount,
    expiredCount,
  };
}

type PolymarketOrdersSyncStats = {
  changed: boolean;
  fetched: number;
  storedNew: number;
  alreadyKnown: number;
  skippedNoId: number;
  sampleVenueOrderIds: string[];
  tradeSync: {
    insertedFillCount: number;
    persistedFillCount: number;
    positionsRecomputed: boolean;
  };
  delayedSync: {
    checked: number;
    matchedCount: number;
    cancelledCount: number;
    unmatchedCount: number;
    expiredCount: number;
    unconfirmedCount: number;
    skippedOpenCount: number;
    liveCount: number;
  };
  settlementSync: {
    checked: number;
    confirmedCount: number;
    cancelledCount: number;
    unmatchedCount: number;
    expiredCount: number;
  };
};

type PolymarketOrdersSyncSignerResult =
  | {
      ok: true;
      signer: string;
      stats: PolymarketOrdersSyncStats;
    }
  | {
      ok: false;
      kind: "credentials_invalid" | "upstream";
      status: number;
      payload: unknown;
      tried?: { get: string };
    };

function emptyPolymarketOrdersSyncStats(): PolymarketOrdersSyncStats {
  return {
    changed: false,
    fetched: 0,
    storedNew: 0,
    alreadyKnown: 0,
    skippedNoId: 0,
    sampleVenueOrderIds: [],
    tradeSync: {
      insertedFillCount: 0,
      persistedFillCount: 0,
      positionsRecomputed: false,
    },
    delayedSync: {
      checked: 0,
      matchedCount: 0,
      cancelledCount: 0,
      unmatchedCount: 0,
      expiredCount: 0,
      unconfirmedCount: 0,
      skippedOpenCount: 0,
      liveCount: 0,
    },
    settlementSync: {
      checked: 0,
      confirmedCount: 0,
      cancelledCount: 0,
      unmatchedCount: 0,
      expiredCount: 0,
    },
  };
}

function mergePolymarketOrdersSyncStats(
  base: PolymarketOrdersSyncStats,
  next: PolymarketOrdersSyncStats,
): PolymarketOrdersSyncStats {
  return {
    changed: base.changed || next.changed,
    fetched: base.fetched + next.fetched,
    storedNew: base.storedNew + next.storedNew,
    alreadyKnown: base.alreadyKnown + next.alreadyKnown,
    skippedNoId: base.skippedNoId + next.skippedNoId,
    sampleVenueOrderIds: [
      ...base.sampleVenueOrderIds,
      ...next.sampleVenueOrderIds,
    ].slice(0, 10),
    tradeSync: {
      insertedFillCount:
        base.tradeSync.insertedFillCount + next.tradeSync.insertedFillCount,
      persistedFillCount:
        base.tradeSync.persistedFillCount + next.tradeSync.persistedFillCount,
      positionsRecomputed:
        base.tradeSync.positionsRecomputed ||
        next.tradeSync.positionsRecomputed,
    },
    delayedSync: {
      checked: base.delayedSync.checked + next.delayedSync.checked,
      matchedCount:
        base.delayedSync.matchedCount + next.delayedSync.matchedCount,
      cancelledCount:
        base.delayedSync.cancelledCount + next.delayedSync.cancelledCount,
      unmatchedCount:
        base.delayedSync.unmatchedCount + next.delayedSync.unmatchedCount,
      expiredCount:
        base.delayedSync.expiredCount + next.delayedSync.expiredCount,
      unconfirmedCount:
        base.delayedSync.unconfirmedCount + next.delayedSync.unconfirmedCount,
      skippedOpenCount:
        base.delayedSync.skippedOpenCount + next.delayedSync.skippedOpenCount,
      liveCount: base.delayedSync.liveCount + next.delayedSync.liveCount,
    },
    settlementSync: {
      checked: base.settlementSync.checked + next.settlementSync.checked,
      confirmedCount:
        base.settlementSync.confirmedCount + next.settlementSync.confirmedCount,
      cancelledCount:
        base.settlementSync.cancelledCount + next.settlementSync.cancelledCount,
      unmatchedCount:
        base.settlementSync.unmatchedCount + next.settlementSync.unmatchedCount,
      expiredCount:
        base.settlementSync.expiredCount + next.settlementSync.expiredCount,
    },
  };
}

async function syncPolymarketOrdersForSigner(inputs: {
  userId: string;
  signer: string;
  creds: PolymarketL2Credentials & { funderAddress?: string | null };
  authWalletAddress?: string | null;
  requestedOrderIds: string[];
  targetWalletAddress?: string | null;
  log: PolymarketSyncLogger;
}): Promise<PolymarketOrdersSyncSignerResult> {
  const requestPathAll = "/data/orders";
  const walletAliases = resolvePolymarketSignerWalletAliases({
    signer: inputs.signer,
    funderAddress: inputs.creds.funderAddress,
    authWalletAddress: inputs.authWalletAddress,
    targetWalletAddress: inputs.targetWalletAddress,
  });
  const signerBackfillCount = await backfillPolymarketRequestedOrderSigner({
    userId: inputs.userId,
    signerAddress: inputs.signer,
    requestedOrderIds: inputs.requestedOrderIds,
    walletAliases,
  });

  const upstream = await polymarketL2Request({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 10_000,
    address: inputs.signer,
    creds: {
      apiKey: inputs.creds.apiKey,
      apiSecret: inputs.creds.apiSecret,
      apiPassphrase: inputs.creds.apiPassphrase,
    },
    method: "GET",
    requestPath: requestPathAll,
  });

  if (!upstream.ok) {
    if (
      await invalidatePolymarketCredentialsForInvalidApiKey({
        userId: inputs.userId,
        signer: inputs.signer,
        endpoint: "orders/sync",
        upstream,
        log: inputs.log,
      })
    ) {
      return {
        ok: false,
        kind: "credentials_invalid",
        status: upstream.status,
        payload: upstream.payload,
      };
    }

    return {
      ok: false,
      kind: "upstream",
      status: upstream.status,
      tried: { get: requestPathAll },
      payload: upstream.payload,
    };
  }

  const ordersRaw = extractOrderArray(upstream.payload);
  const funder = inputs.creds.funderAddress ?? inputs.signer;

  let storedNew = 0;
  let alreadyKnown = 0;
  let skippedNoId = 0;
  let existingOpenMarkedLive = 0;
  let openOrderExecutionEvidenceCount = 0;
  let openOrderExecutionAfterSecOverride: number | null = null;
  const orderIds: string[] = [];

  for (const o of ordersRaw) {
    const venueOrderId = extractOrderId(o);
    if (!venueOrderId) {
      skippedNoId += 1;
      continue;
    }
    orderIds.push(venueOrderId);

    const normalizedOpenOrder = normalizeOpenOrder(o);
    const openOrderExecution = summarizePolymarketClobOrderExecution({
      associateTrades: normalizedOpenOrder?.associateTrades ?? null,
      sizeMatched: normalizedOpenOrder?.sizeMatched ?? null,
      status: normalizedOpenOrder?.status ?? null,
    });
    const tokenId = normalizedOpenOrder?.assetId ?? extractTokenId(o);
    const record = isRecord(o) ? o : null;
    const orderType =
      (record ? extractOrderType(record) : null) ??
      (normalizedOpenOrder?.type
        ? normalizeOrderType(normalizedOpenOrder.type)
        : null);
    const sideRaw =
      normalizedOpenOrder?.side?.toUpperCase() ??
      (typeof record?.side === "string" ? record.side.toUpperCase() : null);
    const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : null;
    const derivedAmounts =
      side && record
        ? derivePriceAndSize(record, side)
        : { price: null, size: null };
    const { price, size } =
      derivedAmounts.price != null && derivedAmounts.size != null
        ? derivedAmounts
        : derivePriceAndSizeFromOpenOrder(normalizedOpenOrder, side);
    const orderWalletAddress = normalizedOpenOrder?.makerAddress ?? funder;

    const result = await storeOrder(pool, {
      userId: inputs.userId,
      walletAddress: orderWalletAddress,
      signerAddress: inputs.signer,
      venue: "polymarket",
      venueOrderId,
      tokenId,
      side,
      orderType: orderType ?? undefined,
      price,
      size,
      status: "live",
      errorMessage: null,
      rawError: null,
      orderPayload: o,
    });

    if (result.kind === "stored") storedNew += 1;
    if (openOrderExecution.hasExecution) {
      openOrderExecutionEvidenceCount += 1;
      const candidateAfterSec = resolvePolymarketTradeSyncAfterSecFromMs(
        resolvePolymarketOpenOrderTimestampMs({
          createdAt: normalizedOpenOrder?.createdAt ?? null,
          postedAt: result.order.posted_at,
        }),
      );
      if (candidateAfterSec != null) {
        openOrderExecutionAfterSecOverride =
          openOrderExecutionAfterSecOverride == null
            ? candidateAfterSec
            : Math.min(openOrderExecutionAfterSecOverride, candidateAfterSec);
      }
    }
    if (result.kind === "exists") {
      alreadyKnown += 1;
      if (
        !openOrderExecution.hasExecution &&
        isPolymarketPendingLocalOrderStatus(result.order.status)
      ) {
        const markedLive = await markPolymarketOrderLiveFromClob({
          userId: inputs.userId,
          venueOrderId,
        });
        if (markedLive) existingOpenMarkedLive += 1;
      }
    }
  }

  let tradeSync = {
    insertedFillCount: 0,
    persistedFillCount: 0,
    positionsRecomputed: false,
  };
  try {
    tradeSync = await syncPolymarketTradesForSigner(
      pool,
      {
        userId: inputs.userId,
        signerAddress: inputs.signer,
      },
      {
        afterSecOverride: openOrderExecutionAfterSecOverride,
      },
    );
  } catch (error) {
    inputs.log.error(
      { error, userId: inputs.userId, signer: inputs.signer },
      "Polymarket trade sync during orders sync failed",
    );
  }

  let delayedSync = {
    checked: 0,
    matchedCount: 0,
    cancelledCount: 0,
    unmatchedCount: 0,
    expiredCount: 0,
    unconfirmedCount: 0,
    skippedOpenCount: 0,
    liveCount: 0,
  };
  try {
    delayedSync = await reconcileDelayedPolymarketOrdersAfterOpenSync({
      creds: {
        apiKey: inputs.creds.apiKey,
        apiSecret: inputs.creds.apiSecret,
        apiPassphrase: inputs.creds.apiPassphrase,
      },
      openVenueOrderIds: orderIds,
      requestedOrderIds: inputs.requestedOrderIds,
      signerAddress: inputs.signer,
      userId: inputs.userId,
      walletAliases,
      log: inputs.log,
    });
  } catch (error) {
    inputs.log.error(
      { error, userId: inputs.userId, signer: inputs.signer },
      "Polymarket delayed order reconcile during orders sync failed",
    );
  }

  let settlementSync = {
    checked: 0,
    confirmedCount: 0,
    cancelledCount: 0,
    unmatchedCount: 0,
    expiredCount: 0,
  };
  try {
    settlementSync = await reconcileUnconfirmedOrders({
      creds: {
        apiKey: inputs.creds.apiKey,
        apiSecret: inputs.creds.apiSecret,
        apiPassphrase: inputs.creds.apiPassphrase,
      },
      userId: inputs.userId,
      requestedOrderIds: inputs.requestedOrderIds,
      signerAddress: inputs.signer,
      walletAliases,
      log: inputs.log,
    });
  } catch (error) {
    inputs.log.error(
      { error, userId: inputs.userId, signer: inputs.signer },
      "Polymarket unconfirmed order reconcile during orders sync failed",
    );
  }

  const stats: PolymarketOrdersSyncStats = {
    changed:
      storedNew > 0 ||
      signerBackfillCount > 0 ||
      existingOpenMarkedLive > 0 ||
      openOrderExecutionEvidenceCount > 0 ||
      tradeSync.insertedFillCount > 0 ||
      tradeSync.persistedFillCount > 0 ||
      delayedSync.matchedCount > 0 ||
      delayedSync.cancelledCount > 0 ||
      delayedSync.unmatchedCount > 0 ||
      delayedSync.expiredCount > 0 ||
      delayedSync.unconfirmedCount > 0 ||
      delayedSync.liveCount > 0 ||
      settlementSync.confirmedCount > 0 ||
      settlementSync.cancelledCount > 0 ||
      settlementSync.unmatchedCount > 0 ||
      settlementSync.expiredCount > 0,
    fetched: ordersRaw.length,
    storedNew,
    alreadyKnown,
    skippedNoId,
    sampleVenueOrderIds: orderIds.slice(0, 10),
    tradeSync,
    delayedSync: {
      ...delayedSync,
      liveCount: delayedSync.liveCount + existingOpenMarkedLive,
    },
    settlementSync,
  };

  return {
    ok: true,
    signer: inputs.signer,
    stats,
  };
}

function derivePriceAndSizeFromOpenOrder(
  order: ReturnType<typeof normalizeOpenOrder>,
  side: PolymarketSide | null,
): { price: number | null; size: number | null } {
  if (!order || !side) return { price: null, size: null };

  const price =
    typeof order.price === "string" && order.price.trim().length > 0
      ? Number(order.price)
      : null;
  const size =
    typeof order.originalSize === "string" &&
    order.originalSize.trim().length > 0
      ? Number(order.originalSize)
      : null;

  if (
    price == null ||
    size == null ||
    !Number.isFinite(price) ||
    !Number.isFinite(size)
  ) {
    return { price: null, size: null };
  }

  return { price, size };
}

function extractOrderType(
  order: Record<string, unknown>,
): PolymarketOrderType | null {
  const raw =
    order.orderType ?? order.order_type ?? order.type ?? order.order_type;
  return normalizeOrderType(raw);
}

export async function fetchPolymarketMarketInfoRoute(input: {
  log?: PolymarketRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  query: PolymarketMarketInfoQuery;
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  if (!input.signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket market info requires an EVM wallet address",
      },
    };
  }

  try {
    const info = await fetchPolymarketMarketInfo(input.pool, {
      tokenId: input.query.tokenId ?? undefined,
      marketId: input.query.marketId ?? undefined,
      conditionId: input.query.conditionId ?? undefined,
    });

    if (!info) {
      return {
        ok: false,
        statusCode: 404,
        payload: { error: "Polymarket market not found" },
      };
    }

    let clobTokenIds: string[] | null = null;
    if (info.clob_token_ids) {
      try {
        const parsed = JSON.parse(info.clob_token_ids);
        if (Array.isArray(parsed)) {
          clobTokenIds = parsed.map((value) => String(value));
        }
      } catch {
        clobTokenIds = null;
      }
    }

    const negRisk = info.neg_risk != null ? Boolean(info.neg_risk) : null;
    const takerFeeBps = normalizeFeeBps(info.taker_fee_bps);
    const makerFeeBps = normalizeFeeBps(info.maker_fee_bps);

    return {
      ok: true,
      payload: {
        ok: true,
        tokenId: input.query.tokenId ?? null,
        marketId: input.query.marketId ?? null,
        conditionId: input.query.conditionId ?? null,
        polymarketId: info.polymarket_id,
        unifiedMarketId: info.unified_market_id,
        clobTokenIds,
        tokenYes: clobTokenIds?.[0] ?? null,
        tokenNo: clobTokenIds?.[1] ?? null,
        negRisk,
        exchangeAddress: exchangeAddressForNegRisk(negRisk),
        orderPriceMinTickSize:
          info.order_price_min_tick_size != null
            ? Number(info.order_price_min_tick_size)
            : null,
        orderMinSize:
          info.order_min_size != null ? Number(info.order_min_size) : null,
        acceptingOrders:
          info.accepting_orders != null ? Boolean(info.accepting_orders) : null,
        takerFeeBps,
        makerFeeBps,
      },
    };
  } catch (error) {
    input.log?.error?.(
      {
        error,
        userId: input.userId,
        signer: input.signer,
        query: input.query,
      },
      "Failed to fetch Polymarket market info",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Failed to fetch Polymarket market info" },
    };
  }
}

export async function buildPolymarketOrderParamsRoute(input: {
  pool: ApiTradingApplicationServiceInput["pool"];
  query: PolymarketOrderParamsQuery;
  signer: string;
}): Promise<PolymarketRouteOperationResult> {
  if (!input.signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket order params require an EVM wallet address",
      },
    };
  }

  const tokenId = input.query.tokenId.trim();
  if (!tokenId) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "tokenId is required" },
    };
  }

  const marketInfo = await fetchPolymarketMarketInfo(input.pool, { tokenId });
  const takerFeeBps = normalizeFeeBps(marketInfo?.taker_fee_bps);
  const makerFeeBps = normalizeFeeBps(marketInfo?.maker_fee_bps);
  const feePolicySnapshot = await resolvePolymarketFeePolicySnapshot(
    input.pool,
  );

  return {
    ok: true,
    payload: {
      ok: true,
      version: "polymarket_clob_v2",
      tokenId,
      timestamp: Date.now().toString(),
      metadata: ZERO_BYTES32,
      builder: feePolicySnapshot.builderCode,
      exchangeAddress:
        marketInfo?.neg_risk === true
          ? env.polymarketNegRiskExchangeAddress
          : env.polymarketExchangeAddress,
      collateralAddress: env.polymarketUsdcAddress,
      takerFeeBps,
      makerFeeBps,
      builderCollectionMode: feePolicySnapshot.collectionMode,
      builderTakerFeeBps: feePolicySnapshot.builderTakerFeeBps,
      builderMakerFeeBps: feePolicySnapshot.builderMakerFeeBps,
      builderRateSource: feePolicySnapshot.builderRateSource,
      builderEnabled: feePolicySnapshot.builderEnabled,
    },
  };
}

export async function quotePolymarketOrderRoute(input: {
  body: PolymarketQuoteBody;
  log?: PolymarketRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  if (!input.signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Polymarket quote requires an EVM wallet address" },
    };
  }

  const body = input.body;
  const tokenId = body.tokenId.trim();
  if (!tokenId) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "tokenId is required" },
    };
  }

  void markHotTokens({ tokenIds: [tokenId], venue: "polymarket" });
  void requestPriceRefreshForTokens({
    tokenIds: [tokenId],
    venue: "polymarket",
  });

  const orderType = normalizeOrderTypeForClob(body.orderType ?? "FOK");
  const amountType = (body.amountType ?? "usd") === "shares" ? "shares" : "usd";
  const amountUsdInput =
    amountType === "usd" ? (body.amountUsd ?? body.amount) : null;
  const amountSharesInput = amountType === "shares" ? body.amount : null;

  try {
    const quote = await quotePolymarketOrder(input.pool, {
      tokenId,
      side: body.side,
      orderType,
      amountType,
      amountUsdInput,
      amountSharesInput,
      limitPrice: body.limitPrice,
      slippageBps: body.slippageBps,
      logWarn: ({ error, tokenId: warningTokenId, conditionId }) =>
        input.log?.warn?.(
          { error, tokenId: warningTokenId, conditionId },
          "Failed to fetch Polymarket CLOB fee curve; using local fee fallback",
        ),
    });

    return {
      ok: true,
      payload: quote,
    };
  } catch (error) {
    if (error instanceof PolymarketQuoteError) {
      return {
        ok: false,
        statusCode: error.statusCode,
        payload: { error: error.publicMessage },
      };
    }
    input.log?.error?.(
      { error, userId: input.userId, signer: input.signer, body },
      "Failed to quote Polymarket order",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Polymarket quote failed" },
    };
  }
}

export async function derivePolymarketFundersRoute(input: {
  authenticatedWalletAddress?: string | null;
  query: PolymarketFunderDeriveQuery;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const walletOverride =
    typeof input.query.walletAddress === "string"
      ? input.query.walletAddress.trim()
      : null;
  const signer = walletOverride || input.authenticatedWalletAddress;
  if (!signer) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "walletAddress is required" },
    };
  }

  if (!signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket funder derive requires an EVM wallet address",
      },
    };
  }

  if (walletOverride) {
    const walletRecord = await AuthService.getUserWalletByAddress(
      input.userId,
      signer,
    );
    if (!walletRecord) {
      return {
        ok: false,
        statusCode: 403,
        payload: { error: "walletAddress does not belong to the current user" },
      };
    }
  }

  const credsInfo = await AuthService.getVenueCredentialsInfo(
    input.userId,
    "polymarket",
    signer,
  );

  const includeMagicProxy =
    parseOptionalBoolean(input.query.includeMagicProxy) ?? false;
  const refresh = parseOptionalBoolean(input.query.refresh) === true;

  const result = await derivePolymarketFunders({
    signer,
    storedFunder: credsInfo?.funderAddress ?? null,
    includeMagicProxy,
    bypassCodeCache: refresh,
  });

  return {
    ok: true,
    payload: {
      ok: true,
      ...result,
    },
  };
}

export async function derivePolymarketFundersBatchRoute(input: {
  body: PolymarketFunderDeriveBatchBody;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const wallets = Array.from(new Set(input.body.wallets.map(normalizeAddress)));

  const userWallets = await AuthService.getUserWallets(input.userId);
  const allowedWallets = new Set(
    userWallets.map((wallet) => normalizeAddress(wallet.walletAddress)),
  );

  for (const wallet of wallets) {
    if (!allowedWallets.has(wallet)) {
      return {
        ok: false,
        statusCode: 403,
        payload: { error: "walletAddress does not belong to the current user" },
      };
    }
  }

  const includeMagicProxy = Boolean(input.body.includeMagicProxy);
  const refresh = input.body.refresh === true;

  const results: Record<string, unknown> = {};
  for (const wallet of wallets) {
    try {
      const credsInfo = await AuthService.getVenueCredentialsInfo(
        input.userId,
        "polymarket",
        wallet,
      );
      results[wallet] = await derivePolymarketFunders({
        signer: wallet,
        storedFunder: credsInfo?.funderAddress ?? null,
        includeMagicProxy,
        bypassCodeCache: refresh,
      });
    } catch {
      results[wallet] = {
        error: "Funder derive failed",
      };
    }
  }

  return {
    ok: true,
    payload: {
      ok: true,
      results,
    },
  };
}

export async function buildPolymarketRedemptionPlanRoute(input: {
  log?: PolymarketRouteLogger | null;
  query: PolymarketRedemptionPlanQuery;
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  if (!input.signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket redemption requires an EVM wallet address",
      },
    };
  }

  try {
    const credsInfo = await AuthService.getVenueCredentialsInfo(
      input.userId,
      "polymarket",
      input.signer,
    );
    const funder =
      input.query.funderAddress ?? credsInfo?.funderAddress ?? input.signer;
    const plan = await buildPolymarketRedemptionPlan({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      funder,
      conditionalTokensAddress: env.polymarketConditionalTokensAddress,
      collateralTokenAddress: env.polymarketUsdcAddress,
      legacyCollateralTokenAddress: env.polymarketUsdceAddress,
      negRiskAdapterAddress: env.polymarketNegRiskAdapterAddress ?? null,
      ctfCollateralAdapterAddress:
        env.polymarketCtfCollateralAdapterAddress ?? null,
      negRiskCollateralAdapterAddress:
        env.polymarketNegRiskCollateralAdapterAddress ?? null,
      outcome: input.query.outcome,
      positionTokenId: input.query.tokenId,
      conditionId: input.query.conditionId ?? null,
      questionId: input.query.questionId ?? null,
      negRiskParentConditionId: input.query.negRiskParentConditionId ?? null,
      negRiskRequestId: input.query.negRiskRequestId ?? null,
      isNegRisk: input.query.negRisk === true,
    });

    return {
      ok: true,
      payload: plan,
    };
  } catch (error) {
    input.log?.error?.(
      {
        error,
        userId: input.userId,
        signer: input.signer,
        tokenId: input.query.tokenId,
        outcome: input.query.outcome,
      },
      "Failed to build Polymarket redemption plan",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Failed to prepare Polymarket redemption" },
    };
  }
}

export async function prepareEmbeddedPolymarketOrderSignatureRoute(input: {
  body: PolymarketEmbeddedSignOrderPrepareBody;
  signer: string;
  user: User;
}): Promise<PolymarketRouteOperationResult> {
  try {
    const context = await resolveEmbeddedPolymarketWalletContext({
      user: input.user,
      signer: input.signer,
    });
    const authorizationRequest = buildEmbeddedPolymarketOrderRequest({
      context,
      payload: input.body.order,
      exchangeAddress: input.body.exchangeAddress,
    });
    return {
      ok: true,
      payload: { ok: true, request: authorizationRequest },
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          error instanceof Error
            ? error.message
            : "Failed to prepare order signature",
      },
    };
  }
}

export async function executeEmbeddedPolymarketOrderSignatureRoute(input: {
  body: PolymarketEmbeddedSignOrderBody;
  signer: string;
  user: User;
}): Promise<PolymarketRouteOperationResult> {
  try {
    const context = await resolveEmbeddedPolymarketWalletContext({
      user: input.user,
      signer: input.signer,
    });
    const authorizationRequest = buildEmbeddedPolymarketOrderRequest({
      context,
      payload: input.body.order,
      exchangeAddress: input.body.exchangeAddress,
    });
    const signature = await executeEmbeddedPolymarketOrderRequest({
      request: authorizationRequest,
      authorizationSignature: input.body.authorizationSignature,
    });
    return {
      ok: true,
      payload: { ok: true, signature },
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: error instanceof Error ? error.message : "Failed to sign order",
      },
    };
  }
}

export async function prepareEmbeddedPolymarketTypedDataSignatureRoute(input: {
  body: PolymarketEmbeddedSignTypedDataPrepareBody;
  signer: string;
  user: User;
}): Promise<PolymarketRouteOperationResult> {
  try {
    const context = await resolveEmbeddedPolymarketWalletContext({
      user: input.user,
      signer: input.signer,
    });
    const authorizationRequest = buildEmbeddedPolymarketTypedDataRequest({
      context,
      typedData: input.body.typedData,
      id: input.body.id,
      label: input.body.label,
      depositWalletBatchPurpose: input.body.depositWalletBatchPurpose,
    });
    return {
      ok: true,
      payload: { ok: true, request: authorizationRequest },
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          error instanceof Error
            ? error.message
            : "Failed to prepare typed-data signature",
      },
    };
  }
}

export async function executeEmbeddedPolymarketTypedDataSignatureRoute(input: {
  body: PolymarketEmbeddedSignTypedDataBody;
  signer: string;
  user: User;
}): Promise<PolymarketRouteOperationResult> {
  try {
    const context = await resolveEmbeddedPolymarketWalletContext({
      user: input.user,
      signer: input.signer,
    });
    const authorizationRequest = buildEmbeddedPolymarketTypedDataRequest({
      context,
      typedData: input.body.typedData,
      id: input.body.id,
      label: input.body.label,
      depositWalletBatchPurpose: input.body.depositWalletBatchPurpose,
    });
    const signature = await executeEmbeddedPolymarketTypedDataRequest({
      request: authorizationRequest,
      authorizationSignature: input.body.authorizationSignature,
    });
    return {
      ok: true,
      payload: { ok: true, signature },
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          error instanceof Error ? error.message : "Failed to sign typed data",
      },
    };
  }
}

export async function computePolymarketOrderHashRoute(input: {
  body: PolymarketOrderHashBody;
  log?: PolymarketRouteLogger | null;
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const signer = input.signer;
  if (!signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket order hash requires an EVM wallet address",
      },
    };
  }

  const body = input.body;
  const order = body.order;
  const orderTokenId = typeof order.tokenId === "string" ? order.tokenId : "";
  if (orderTokenId) {
    void markHotTokens({ tokenIds: [orderTokenId], venue: "polymarket" });
    void requestPriceRefreshForTokens({
      tokenIds: [orderTokenId],
      venue: "polymarket",
    });
  }
  const credsInfo = await AuthService.getVenueCredentialsInfo(
    input.userId,
    "polymarket",
    signer,
  );
  const funder = credsInfo?.funderAddress ?? signer;
  const walletValidation = validatePolymarketOrderWallets({
    order,
    selectedSigner: signer,
    configuredFunder: funder,
  });
  if (!walletValidation.ok) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: walletValidation.error },
    };
  }

  const side = normalizeOrderSide(order.side);
  if (!side) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Order side must be BUY/SELL (or 0/1)" },
    };
  }

  const normalizedForHash = normalizeOrderForHash(order, side);
  if (!normalizedForHash) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Order payload is missing required hash fields" },
    };
  }

  const exchangeAddress =
    (typeof body.exchangeAddress === "string" && body.exchangeAddress) ||
    exchangeAddressForNegRisk(body.negRisk ?? null) ||
    env.polymarketExchangeAddress;

  try {
    const orderHash = await fetchPolymarketOrderHashV2({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      exchangeAddress,
      order: normalizedForHash,
    });

    return {
      ok: true,
      payload: {
        ok: true,
        orderHash,
        exchangeAddress,
      },
    };
  } catch (error) {
    input.log?.error?.(
      { error, userId: input.userId, signer },
      "Failed to compute Polymarket order hash",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Polymarket order hash failed" },
    };
  }
}

export async function computePolymarketMaxSpendRoute(input: {
  body: PolymarketMaxSpendBody;
  log?: PolymarketRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const signer = input.signer;
  if (!signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Polymarket max spend requires an EVM wallet address" },
    };
  }

  const body = input.body;
  const tokenId = body.tokenId.trim();
  void markHotTokens({ tokenIds: [tokenId], venue: "polymarket" });
  void requestPriceRefreshForTokens({
    tokenIds: [tokenId],
    venue: "polymarket",
  });
  const orderType = body.orderType ?? "FOK";
  const amountType = body.amountType ?? "usd";

  if (orderType !== "FOK" || amountType !== "usd") {
    return {
      ok: true,
      payload: polymarketMaxSpendUnavailable(
        "unsupported_order_type",
        "Polymarket max spend currently supports market BUY FOK USD orders only.",
      ),
    };
  }

  const creds = await AuthService.getVenueCredentials(
    input.userId,
    "polymarket",
    signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return {
      ok: true,
      payload: polymarketMaxSpendUnavailable(
        "missing_credentials",
        "Polymarket credentials not found.",
      ),
    };
  }

  const requestedFunder = body.funderAddress ?? creds.funderAddress ?? null;
  const funder = toChecksumAddress(requestedFunder);
  if (!funder || funder === toChecksumAddress(signer)) {
    return {
      ok: true,
      payload: polymarketMaxSpendUnavailable(
        "unsupported_wallet",
        "Polymarket max spend requires a configured executable funder.",
      ),
    };
  }

  let funderExecutionKind: PolymarketFunderExecutionKind = null;
  try {
    const funderDerivation = await derivePolymarketFunders({
      signer,
      storedFunder: funder,
      includeMagicProxy: true,
      bypassCodeCache: false,
    });
    const candidate = findPolymarketFunderCandidateByAddress(
      funderDerivation.candidates,
      funder,
    );
    funderExecutionKind =
      resolvePolymarketFunderExecutionKindForMaxSpend(candidate);
    if (
      !candidate ||
      candidate.deployed !== true ||
      (funderExecutionKind !== "deposit_wallet" &&
        funderExecutionKind !== "safe")
    ) {
      return {
        ok: true,
        payload: polymarketMaxSpendUnavailable(
          "unsupported_wallet",
          "Configured Polymarket funder cannot execute backend-supported orders.",
        ),
      };
    }
  } catch (error) {
    input.log?.warn?.(
      { error, userId: input.userId, signer, funder },
      "Failed to resolve Polymarket max-spend funder",
    );
    return {
      ok: true,
      payload: polymarketMaxSpendUnavailable(
        "unsupported_wallet",
        "Configured Polymarket funder could not be validated.",
      ),
    };
  }

  let funds: Awaited<ReturnType<typeof resolvePolymarketMaxSpendFunds>>;
  try {
    funds = await resolvePolymarketMaxSpendFunds({
      userId: input.userId,
      signer,
      funder,
      funderExecutionKind,
      pool: input.pool,
      creds: {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        apiPassphrase: creds.apiPassphrase,
      },
    });
  } catch (error) {
    if (
      error instanceof PolymarketMaxSpendLiveOrderLocksError &&
      (await invalidatePolymarketCredentialsForInvalidApiKey({
        userId: input.userId,
        signer,
        endpoint: "max-spend/open-orders",
        upstream: error.upstream,
        log: input.log,
      }))
    ) {
      return {
        ok: false,
        statusCode: 401,
        payload: polymarketCredentialsInvalidPayload(error.upstream),
      };
    }
    input.log?.warn?.(
      { error, userId: input.userId, signer, funder },
      "Failed to resolve Polymarket max-spend balances",
    );
    return {
      ok: true,
      payload: polymarketMaxSpendUnavailable(
        "balance_unavailable",
        "Polymarket balances are unavailable.",
      ),
    };
  }

  if (funds.executableFundsRaw <= 0n) {
    return {
      ok: true,
      payload: polymarketMaxSpendUnavailable(
        "no_executable_funds",
        "No executable Polymarket funds are available.",
      ),
    };
  }

  try {
    const maxSpend = await findMaxPolymarketMarketBuyUsdForFunds(input.pool, {
      tokenId,
      executableFundsRaw: funds.executableFundsRaw,
      slippageBps: body.slippageBps ?? undefined,
      logWarn: ({ error, tokenId: warningTokenId, conditionId }) =>
        input.log?.warn?.(
          { error, tokenId: warningTokenId, conditionId },
          "Failed to fetch Polymarket CLOB fee curve; using local fee fallback",
        ),
    });

    if (!maxSpend.ok) {
      return {
        ok: true,
        payload: polymarketMaxSpendUnavailable(
          maxSpend.reason,
          maxSpend.reason === "no_liquidity"
            ? "No executable Polymarket liquidity is available for the max spend amount."
            : "Executable funds are below the minimum Polymarket order amount.",
        ),
      };
    }

    const quote = maxSpend.quote;
    return {
      ok: true,
      payload: {
        ok: true,
        reason: "ok",
        tokenId,
        side: "BUY",
        orderType: "FOK",
        amountType: "usd",
        maxAmountUsd: Number(maxSpend.maxAmountUsdRaw) / 1_000_000,
        maxAmountUsdRaw: maxSpend.maxAmountUsdRaw,
        totalRequiredUsdcRaw: quote.totalRequiredUsdcRaw ?? "0",
        totalFeeEstimateRaw: quote.totalFeeEstimateRaw,
        platformFeeEstimateRaw: quote.platformFeeEstimateRaw,
        builderFeeEstimateRaw: quote.builderFeeEstimateRaw,
        makerAmount: quote.makerAmount,
        takerAmount: quote.takerAmount,
        price: quote.price,
        size: quote.size,
        amountUsdUsed: quote.amountUsdUsed,
        bestBid: quote.bestBid,
        bestAsk: quote.bestAsk,
        slippageBps: quote.slippageBps,
        executableFundsRaw: funds.executableFundsRaw.toString(),
        funderPusdRaw: funds.funderPusdRaw.toString(),
        funderPusdAvailableRaw: funds.funderPusdAvailableRaw.toString(),
        funderLockedRaw: funds.funderLockedRaw.toString(),
        signerLockedRaw: funds.signerLockedRaw.toString(),
        signerPusdTopUpRaw: funds.signerPusdTopUpRaw.toString(),
        signerUsdceTopUpRaw: funds.signerUsdceTopUpRaw.toString(),
        usesSignerTopUp: funds.usesSignerTopUp,
      },
    };
  } catch (error) {
    if (error instanceof PolymarketQuoteError) {
      if (error.reason === "missing_top_of_book") {
        return {
          ok: true,
          payload: polymarketMaxSpendUnavailable(
            "no_liquidity",
            "No executable Polymarket liquidity is available.",
          ),
        };
      }
      if (error.reason === "amount_too_small") {
        return {
          ok: true,
          payload: polymarketMaxSpendUnavailable(
            "below_min_order",
            "Executable funds are below the minimum Polymarket order amount.",
          ),
        };
      }
      return {
        ok: true,
        payload: polymarketMaxSpendUnavailable(
          "quote_unavailable",
          error.publicMessage,
        ),
      };
    }
    input.log?.error?.(
      { error, userId: input.userId, signer, body },
      "Failed to compute Polymarket max spend",
    );
    return {
      ok: true,
      payload: polymarketMaxSpendUnavailable(
        "quote_unavailable",
        "Polymarket max spend quote is unavailable.",
      ),
    };
  }
}

export async function fetchPolymarketAccountRoute(input: {
  log?: PolymarketRouteLogger | null;
  query: PolymarketAccountQuery;
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const signer = input.signer;
  if (!signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket account snapshot requires an EVM wallet address",
      },
    };
  }

  const credsInfo = await AuthService.getVenueCredentialsInfo(
    input.userId,
    "polymarket",
    signer,
  );
  const requestedFunder = input.query.funderAddress;
  const funder = requestedFunder ?? credsInfo?.funderAddress ?? signer;
  const funderSource = requestedFunder
    ? "query"
    : credsInfo?.funderAddress
      ? "credentials"
      : "signer";
  const credentialsUpdatedAtValue =
    credsInfo?.updatedAt instanceof Date
      ? credsInfo.updatedAt.toISOString()
      : (credsInfo?.updatedAt ?? null);
  const credentialsKey = credsInfo
    ? `${credsInfo.id}|${credentialsUpdatedAtValue ?? "none"}`
    : "none";
  const funderUpdatedAtValue =
    credsInfo?.funderUpdatedAt instanceof Date
      ? credsInfo.funderUpdatedAt.toISOString()
      : (credsInfo?.funderUpdatedAt ?? null);
  const refresh = input.query.refresh === true;
  const cacheEnabled = !refresh && env.polymarketAccountCacheTtlMs > 0;
  const cacheKey = buildPolymarketAccountCacheKey({
    userId: input.userId,
    signer,
    funder,
    credentialsKey,
    funderUpdatedAt: funderUpdatedAtValue,
  });

  if (cacheEnabled) {
    const cached = readPolymarketAccountCache(cacheKey);
    if (cached) {
      return { ok: true, payload: cached };
    }
    const inflight = polymarketAccountInflight.get(cacheKey);
    if (inflight) {
      return { ok: true, payload: await inflight };
    }
  }

  try {
    const negRiskAdapterAddress =
      env.polymarketNegRiskAdapterAddress?.trim() || "";
    const ctfCollateralAdapterAddress =
      env.polymarketCtfCollateralAdapterAddress?.trim() || "";
    const negRiskCollateralAdapterAddress =
      env.polymarketNegRiskCollateralAdapterAddress?.trim() || "";
    const funderDistinctFromSigner =
      toChecksumAddress(funder) !== toChecksumAddress(signer);
    const computePromise = (async (): Promise<PolymarketAccountPayload> => {
      const [code, snapshot] = await Promise.all([
        fetchEvmCode({
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
          address: funder,
        }),
        fetchPolymarketOnchainSnapshot({
          rpcUrl: env.polygonRpcUrl,
          timeoutMs: env.polygonRpcTimeoutMs,
          signer,
          funder,
          includeSignerUsdc: funderDistinctFromSigner,
          includeFeeCollectorNonce: false,
          negRiskAdapterAddress,
          ctfCollateralAdapterAddress,
          negRiskCollateralAdapterAddress,
          feeCollectorAddress: null,
        }),
      ]);

      const pusdBalance = snapshot.pusdBalance;
      const usdceBalance = snapshot.usdceBalance;
      const nativeUsdcBalance = snapshot.nativeUsdcBalance;
      const signerPusdBalance =
        snapshot.signerPusdBalance ?? snapshot.pusdBalance;
      const signerUsdceBalance =
        snapshot.signerUsdceBalance ?? snapshot.usdceBalance;
      const signerNativeUsdcBalance =
        snapshot.signerNativeUsdcBalance ?? snapshot.nativeUsdcBalance;
      const allowanceExchange = snapshot.allowanceExchange;
      const allowanceNegRisk = snapshot.allowanceNegRisk;
      const okExchange = snapshot.okExchange;
      const okNegRisk = snapshot.okNegRisk;
      const okNegRiskAdapter = snapshot.okNegRiskAdapter;
      const okCtfCollateralAdapter = snapshot.okCtfCollateralAdapter;
      const okNegRiskCollateralAdapter = snapshot.okNegRiskCollateralAdapter;
      const allowanceNegRiskAdapter = snapshot.allowanceNegRiskAdapter;

      const isContract = typeof code === "string" && code.length > 2;
      const pusdStatus = {
        tokenAddress: env.polymarketUsdcAddress,
        decimals: 6,
        balance: ethers.formatUnits(pusdBalance, 6),
        balanceRaw: pusdBalance.toString(),
        allowance: {
          exchange: {
            spender: env.polymarketExchangeAddress,
            allowance: ethers.formatUnits(allowanceExchange, 6),
            allowanceRaw: allowanceExchange.toString(),
          },
          negRiskExchange: {
            spender: env.polymarketNegRiskExchangeAddress,
            allowance: ethers.formatUnits(allowanceNegRisk, 6),
            allowanceRaw: allowanceNegRisk.toString(),
          },
          ...(negRiskAdapterAddress
            ? {
                negRiskAdapter: {
                  spender: negRiskAdapterAddress,
                  allowance: ethers.formatUnits(
                    allowanceNegRiskAdapter ?? 0n,
                    6,
                  ),
                  allowanceRaw: (allowanceNegRiskAdapter ?? 0n).toString(),
                },
              }
            : {}),
        },
      };

      return {
        ok: true,
        venue: "polymarket",
        chainId: 137,
        signer,
        funder,
        funderSource,
        funderUpdatedAt: credsInfo?.funderUpdatedAt ?? null,
        funderIsContract: isContract,
        rpcUrl: env.polygonRpcUrl,
        negRiskAdapterAddress: negRiskAdapterAddress || null,
        ctfCollateralAdapterAddress: ctfCollateralAdapterAddress || null,
        negRiskCollateralAdapterAddress:
          negRiskCollateralAdapterAddress || null,
        pusd: pusdStatus,
        usdc: pusdStatus,
        nativeUsdc: {
          tokenAddress: POLYGON_NATIVE_USDC_ADDRESS,
          decimals: 6,
          balance: ethers.formatUnits(nativeUsdcBalance, 6),
          balanceRaw: nativeUsdcBalance.toString(),
        },
        usdce: {
          tokenAddress: env.polymarketUsdceAddress,
          decimals: 6,
          balance: ethers.formatUnits(usdceBalance, 6),
          balanceRaw: usdceBalance.toString(),
        },
        signerPusd: {
          tokenAddress: env.polymarketUsdcAddress,
          decimals: 6,
          balance: ethers.formatUnits(signerPusdBalance, 6),
          balanceRaw: signerPusdBalance.toString(),
        },
        signerUsdc: {
          tokenAddress: env.polymarketUsdcAddress,
          decimals: 6,
          balance: ethers.formatUnits(signerPusdBalance, 6),
          balanceRaw: signerPusdBalance.toString(),
        },
        signerUsdce: {
          tokenAddress: env.polymarketUsdceAddress,
          decimals: 6,
          balance: ethers.formatUnits(signerUsdceBalance, 6),
          balanceRaw: signerUsdceBalance.toString(),
        },
        signerNativeUsdc: {
          tokenAddress: POLYGON_NATIVE_USDC_ADDRESS,
          decimals: 6,
          balance: ethers.formatUnits(signerNativeUsdcBalance, 6),
          balanceRaw: signerNativeUsdcBalance.toString(),
        },
        conditionalTokens: {
          contractAddress: env.polymarketConditionalTokensAddress,
          isApprovedForAll: {
            exchange: okExchange,
            negRiskExchange: okNegRisk,
            ...(negRiskAdapterAddress
              ? { negRiskAdapter: okNegRiskAdapter }
              : {}),
            ...(ctfCollateralAdapterAddress
              ? { ctfCollateralAdapter: okCtfCollateralAdapter }
              : {}),
            ...(negRiskCollateralAdapterAddress
              ? { negRiskCollateralAdapter: okNegRiskCollateralAdapter }
              : {}),
          },
          operatorApprovals: snapshot.operatorApprovals,
        },
        hasCredentials: Boolean(credsInfo),
      };
    })();

    if (cacheEnabled) {
      polymarketAccountInflight.set(cacheKey, computePromise);
    }
    try {
      const payload = await computePromise;
      if (cacheEnabled) {
        writePolymarketAccountCache(cacheKey, payload);
      }
      return { ok: true, payload };
    } finally {
      polymarketAccountInflight.delete(cacheKey);
    }
  } catch (error) {
    input.log?.error?.(
      { error, userId: input.userId, signer, funder },
      "Failed to fetch Polymarket account snapshot",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Failed to fetch Polymarket account snapshot" },
    };
  }
}

export async function syncPolymarketOrdersRoute(input: {
  authWalletAddress?: string | null;
  body: PolymarketOrdersSyncBody;
  log: PolymarketSyncLogger;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const body = input.body ?? {};
  const requestedOrderIds = normalizePolymarketOrdersSyncOrderIds(
    body.orderIds,
  );
  const targetWalletAddress = body.targetWalletAddress ?? null;
  const signerResolution = await resolvePolymarketOrdersSyncSignerCandidates({
    userId: input.userId,
    authWalletAddress: input.authWalletAddress,
    orderIds: requestedOrderIds,
    targetWalletAddress,
  });
  const signerCandidates = signerResolution.signers;

  if (
    signerCandidates.length === 0 &&
    signerResolution.authFallbackSigner == null
  ) {
    return {
      ok: true,
      payload: {
        ok: true,
        venue: "polymarket",
        walletAddress: input.authWalletAddress ?? targetWalletAddress,
        skipped: true,
        reason: "missing_credentials",
        targetedAuthFallback: false,
        ...emptyPolymarketOrdersSyncStats(),
      },
    };
  }

  let usedCredentials = false;
  let targetedAuthFallback = false;
  let aggregate = emptyPolymarketOrdersSyncStats();
  const syncedSigners: string[] = [];

  for (const signer of signerCandidates) {
    const creds = await AuthService.getVenueCredentials(
      input.userId,
      "polymarket",
      signer,
    );
    if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
      continue;
    }
    usedCredentials = true;

    const result = await syncPolymarketOrdersForSigner({
      userId: input.userId,
      signer,
      creds: {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        apiPassphrase: creds.apiPassphrase,
        funderAddress: creds.funderAddress ?? null,
      },
      authWalletAddress: input.authWalletAddress,
      requestedOrderIds,
      targetWalletAddress,
      log: input.log,
    });
    if (!result.ok) {
      if (result.kind === "credentials_invalid") {
        return {
          ok: false,
          statusCode: 401,
          payload: polymarketCredentialsInvalidPayload({
            status: result.status,
            payload: result.payload,
          }),
        };
      }
      return {
        ok: false,
        statusCode: 502,
        payload: {
          error: "Polymarket orders sync failed",
          status: result.status,
          tried: result.tried,
          payload: result.payload,
        },
      };
    }

    syncedSigners.push(result.signer);
    aggregate = mergePolymarketOrdersSyncStats(aggregate, result.stats);
  }

  const fallbackSigner = signerResolution.authFallbackSigner;
  if (
    !usedCredentials &&
    fallbackSigner &&
    !signerCandidates.some(
      (signer) => signer.toLowerCase() === fallbackSigner.toLowerCase(),
    )
  ) {
    const creds = await AuthService.getVenueCredentials(
      input.userId,
      "polymarket",
      fallbackSigner,
    );
    if (creds?.apiKey && creds.apiSecret && creds.apiPassphrase) {
      usedCredentials = true;
      targetedAuthFallback = true;
      const result = await syncPolymarketOrdersForSigner({
        userId: input.userId,
        signer: fallbackSigner,
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
          funderAddress: creds.funderAddress ?? null,
        },
        authWalletAddress: input.authWalletAddress,
        requestedOrderIds,
        targetWalletAddress,
        log: input.log,
      });
      if (!result.ok) {
        if (result.kind === "credentials_invalid") {
          return {
            ok: false,
            statusCode: 401,
            payload: polymarketCredentialsInvalidPayload({
              status: result.status,
              payload: result.payload,
            }),
          };
        }
        return {
          ok: false,
          statusCode: 502,
          payload: {
            error: "Polymarket orders sync failed",
            status: result.status,
            tried: result.tried,
            payload: result.payload,
          },
        };
      }
      syncedSigners.push(result.signer);
      aggregate = mergePolymarketOrdersSyncStats(aggregate, result.stats);
    }
  }

  if (!usedCredentials) {
    return {
      ok: true,
      payload: {
        ok: true,
        venue: "polymarket",
        walletAddress: input.authWalletAddress ?? targetWalletAddress,
        skipped: true,
        reason: "missing_credentials",
        targetedAuthFallback,
        ...emptyPolymarketOrdersSyncStats(),
      },
    };
  }

  return {
    ok: true,
    payload: {
      ok: true,
      venue: "polymarket",
      walletAddress: syncedSigners[0] ?? input.authWalletAddress,
      syncedSigners,
      targetedAuthFallback,
      ...aggregate,
    },
  };
}

export async function fetchPolymarketOpenOrdersRoute(input: {
  log?: PolymarketRouteLogger | null;
  query: PolymarketOpenOrdersQuery;
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const signer = input.signer;
  if (!signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket open orders require an EVM wallet address",
      },
    };
  }

  const creds = await AuthService.getVenueCredentials(
    input.userId,
    "polymarket",
    signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Polymarket credentials not found (connect first)" },
    };
  }

  const params = new URLSearchParams();
  const assetId = input.query.assetId ?? input.query.asset_id;
  if (assetId) params.set("asset_id", assetId);
  if (input.query.market) params.set("market", input.query.market);
  if (input.query.id) params.set("id", input.query.id);

  const requestPath = params.toString().length
    ? `/data/orders?${params.toString()}`
    : "/data/orders";

  const upstream = await polymarketL2Request({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 10_000,
    address: signer,
    creds: {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      apiPassphrase: creds.apiPassphrase,
    },
    method: "GET",
    requestPath,
  });

  if (!upstream.ok) {
    if (
      await invalidatePolymarketCredentialsForInvalidApiKey({
        userId: input.userId,
        signer,
        endpoint: "orders/open",
        upstream,
        log: input.log,
      })
    ) {
      return {
        ok: false,
        statusCode: 401,
        payload: polymarketCredentialsInvalidPayload(upstream),
      };
    }

    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Polymarket open orders failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const orders = extractOrderArray(upstream.payload);
  return {
    ok: true,
    payload: {
      ok: true,
      venue: "polymarket",
      count: orders.length,
      orders,
    },
  };
}

export async function syncPolymarketBalanceAllowanceRoute(input: {
  body: PolymarketBalanceAllowanceSyncBody;
  log?: PolymarketRouteLogger | null;
  signer: string;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const signer = input.signer;
  if (!signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket balance sync requires an EVM wallet address",
      },
    };
  }

  const creds = await AuthService.getVenueCredentials(
    input.userId,
    "polymarket",
    signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Polymarket credentials not found (connect first)" },
    };
  }

  const params = new URLSearchParams({
    asset_type: input.body.assetType,
  });
  if (input.body.signatureType != null) {
    params.set("signature_type", input.body.signatureType.toString());
  }
  if (input.body.tokenId) {
    params.set("token_id", input.body.tokenId);
  }

  const upstream = await polymarketL2Request({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 10_000,
    address: signer,
    creds: {
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      apiPassphrase: creds.apiPassphrase,
    },
    method: "GET",
    requestPath: `/balance-allowance/update?${params.toString()}`,
  });

  if (!upstream.ok) {
    if (
      await invalidatePolymarketCredentialsForInvalidApiKey({
        userId: input.userId,
        signer,
        endpoint: "balance-allowance/sync",
        upstream,
        log: input.log,
      })
    ) {
      return {
        ok: false,
        statusCode: 401,
        payload: polymarketCredentialsInvalidPayload(upstream),
      };
    }

    return {
      ok: false,
      statusCode:
        upstream.status >= 500
          ? 502
          : upstream.status >= 400
            ? upstream.status
            : 400,
      payload: {
        error: "Polymarket balance sync failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  return {
    ok: true,
    payload: {
      ok: true,
      venue: "polymarket",
      assetType: input.body.assetType,
      signatureType: input.body.signatureType ?? null,
      tokenId: input.body.tokenId ?? null,
      payload: upstream.payload,
    },
  };
}

export async function cancelPolymarketOrderRoute(input: {
  body: PolymarketCancelOrderBody;
  log?: PolymarketRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  requestedWalletAddress?: string | null;
  userId: string;
}): Promise<PolymarketRouteOperationResult> {
  const warnLog = requiredWarnLogger(input.log);
  const notificationLog = optionalWarnLogger(input.log);
  const storedOrderWalletContext = await fetchStoredOrderWalletContext(
    input.pool,
    {
      userId: input.userId,
      venue: "polymarket",
      venueOrderId: input.body.orderID,
    },
  );

  const signerCandidates = buildPolymarketCancelSignerCandidates({
    requestedWalletAddress: input.requestedWalletAddress,
    storedSignerAddress: storedOrderWalletContext?.signerAddress,
    storedWalletAddress: storedOrderWalletContext?.walletAddress,
  });

  if (signerCandidates.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket cancel requires an EVM signer wallet address",
      },
    };
  }

  let resolvedSigner: string | null = null;
  let resolvedPayload: unknown = null;
  let lastUpstreamFailure: { status: number; payload: unknown } | null = null;
  let lastInvalidCredentialsFailure: {
    status: number;
    payload: unknown;
  } | null = null;
  let lastCancelRejection: {
    creds: PolymarketL2Credentials;
    signer: string;
    reason: string;
    payload: unknown;
  } | null = null;
  let hasPolymarketCredentials = false;

  for (const signer of signerCandidates) {
    const creds = await AuthService.getVenueCredentials(
      input.userId,
      "polymarket",
      signer,
    );
    if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
      continue;
    }
    hasPolymarketCredentials = true;

    const upstream = await polymarketL2Request({
      baseUrl: env.polymarketClobBase,
      timeoutMs: 10_000,
      address: signer,
      creds: {
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        apiPassphrase: creds.apiPassphrase,
      },
      method: "DELETE",
      requestPath: "/order",
      body: { orderID: input.body.orderID },
    });

    if (!upstream.ok) {
      if (
        await invalidatePolymarketCredentialsForInvalidApiKey({
          userId: input.userId,
          signer,
          endpoint: "order/cancel",
          upstream,
          log: input.log,
        })
      ) {
        lastInvalidCredentialsFailure = {
          status: upstream.status,
          payload: upstream.payload,
        };
        continue;
      }

      lastUpstreamFailure = {
        status: upstream.status,
        payload: upstream.payload,
      };
      continue;
    }

    const cancelSummary = summarizePolymarketCancelPayload({
      payload: upstream.payload,
      orderId: input.body.orderID,
    });

    if (cancelSummary.isCanceled) {
      resolvedSigner = signer;
      resolvedPayload = upstream.payload;
      break;
    }

    if (cancelSummary.notCanceledReason) {
      lastCancelRejection = {
        creds: {
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          apiPassphrase: creds.apiPassphrase,
        },
        signer,
        reason: cancelSummary.notCanceledReason,
        payload: upstream.payload,
      };
    }
  }

  if (!resolvedSigner) {
    if (!hasPolymarketCredentials) {
      return {
        ok: false,
        statusCode: 400,
        payload: {
          error: "Polymarket credentials not found (connect first)",
        },
      };
    }

    if (lastCancelRejection) {
      if (isPolymarketAlreadyClosedReason(lastCancelRejection.reason)) {
        const fallbackStatusHint = resolvePolymarketClosedReasonHint(
          lastCancelRejection.reason,
        );
        const clobOrderEvidence =
          await fetchPolymarketClobOrderExecutionEvidence({
            creds: lastCancelRejection.creds,
            log: warnLog,
            orderId: input.body.orderID,
            signer: lastCancelRejection.signer,
          });
        let tradeSync: Awaited<
          ReturnType<typeof syncPolymarketTradesForSigner>
        > | null = null;
        if (clobOrderEvidence.hasExecution) {
          try {
            tradeSync = await syncPolymarketTradesForSigner(input.pool, {
              userId: input.userId,
              signerAddress: lastCancelRejection.signer,
            });
          } catch (error) {
            input.log?.error?.(
              {
                error,
                userId: input.userId,
                signer: lastCancelRejection.signer,
                orderId: input.body.orderID,
              },
              "Polymarket trade sync before cancel reconcile failed",
            );
          }
          if (
            !(await hasPolymarketVenueOrderExecutionEvidence({
              userId: input.userId,
              venueOrderId: input.body.orderID,
            }))
          ) {
            const markedUnconfirmed =
              await markPolymarketDelayedOrderUnconfirmed({
                userId: input.userId,
                venueOrderId: input.body.orderID,
              });
            return {
              ok: true,
              payload: {
                ok: true,
                venue: "polymarket",
                orderId: input.body.orderID,
                signer: lastCancelRejection.signer,
                status: POLYMARKET_UNCONFIRMED_STATUS,
                reconciled: false,
                pendingReconcile: true,
                changed: markedUnconfirmed,
                reason: lastCancelRejection.reason,
                payload: lastCancelRejection.payload,
                orderStatusPayload: clobOrderEvidence.payload ?? undefined,
                tradeSync: tradeSync ?? undefined,
              },
            };
          }
        }

        const statusHint = clobOrderEvidence.statusHint ?? fallbackStatusHint;
        const allowMissingOrderNoFill =
          isPolymarketClobNoFillTerminalStatus(clobOrderEvidence.orderStatus) &&
          (await isPolymarketOrderNoFillGraceElapsed({
            userId: input.userId,
            venueOrderId: input.body.orderID,
          }));
        const terminalNoFillStatus = resolvePolymarketClobNoFillTerminalStatus(
          clobOrderEvidence.orderStatus,
        );
        let reconciled = await reconcilePolymarketTerminalOrder({
          userId: input.userId,
          venueOrderId: input.body.orderID,
          statusHint,
          externalFilledSize: clobOrderEvidence.externalFilledSize,
          externalFillPrice: clobOrderEvidence.externalFillPrice,
          externalHasExecution: clobOrderEvidence.hasExecution,
          skipOnchainExecutionCheck: true,
          allowAmbiguousNoFillReconcile: allowMissingOrderNoFill,
          allowExternalExecutionEvidence: false,
          terminalNoFillStatus,
        });
        if (!reconciled || reconciled.status === "matched") {
          try {
            tradeSync ??= await syncPolymarketTradesForSigner(input.pool, {
              userId: input.userId,
              signerAddress: lastCancelRejection.signer,
            });
            if (!reconciled && tradeSync.insertedFillCount > 0) {
              reconciled = await reconcilePolymarketTerminalOrder({
                userId: input.userId,
                venueOrderId: input.body.orderID,
                statusHint,
                externalFilledSize: clobOrderEvidence.externalFilledSize,
                externalFillPrice: clobOrderEvidence.externalFillPrice,
                externalHasExecution: clobOrderEvidence.hasExecution,
                skipOnchainExecutionCheck: true,
                allowAmbiguousNoFillReconcile: allowMissingOrderNoFill,
                allowExternalExecutionEvidence: false,
                terminalNoFillStatus,
              });
            }
          } catch (error) {
            input.log?.error?.(
              {
                error,
                userId: input.userId,
                signer: lastCancelRejection.signer,
                orderId: input.body.orderID,
              },
              "Polymarket trade sync after cancel reconcile failed",
            );
          }
        }

        if (!reconciled) {
          const markedUnconfirmed = await markPolymarketDelayedOrderUnconfirmed(
            {
              userId: input.userId,
              venueOrderId: input.body.orderID,
            },
          );
          return {
            ok: true,
            payload: {
              ok: true,
              venue: "polymarket",
              orderId: input.body.orderID,
              signer: lastCancelRejection.signer,
              status: POLYMARKET_UNCONFIRMED_STATUS,
              reconciled: false,
              pendingReconcile: true,
              changed: markedUnconfirmed,
              reason: lastCancelRejection.reason,
              payload: lastCancelRejection.payload,
              orderStatusPayload: clobOrderEvidence.payload ?? undefined,
              tradeSync: tradeSync ?? undefined,
            },
          };
        }

        const reconciledStatus = reconciled.status;
        if (reconciledStatus !== "matched") {
          void createNotificationSafe(
            input.pool,
            buildOrderNotification({
              userId: input.userId,
              venue: "polymarket",
              status: reconciledStatus,
              side: reconciled.side ?? null,
              size: reconciled.size ?? null,
              price: reconciled.price ?? null,
              orderId: input.body.orderID,
              tokenId: reconciled.tokenId ?? null,
              walletAddress:
                reconciled.walletAddress ?? lastCancelRejection.signer,
            }),
            notificationLog,
          );
        }
        return {
          ok: true,
          payload: {
            ok: true,
            venue: "polymarket",
            orderId: input.body.orderID,
            signer: lastCancelRejection.signer,
            status: reconciledStatus ?? "cancelled",
            reconciled: true,
            changed: true,
            payload: lastCancelRejection.payload,
            orderStatusPayload: clobOrderEvidence.payload ?? undefined,
            tradeSync: tradeSync ?? undefined,
          },
        };
      }

      return {
        ok: false,
        statusCode: 409,
        payload: {
          error: "Polymarket cancel rejected",
          signer: lastCancelRejection.signer,
          reason: lastCancelRejection.reason,
          payload: lastCancelRejection.payload,
        },
      };
    }

    if (lastInvalidCredentialsFailure) {
      return {
        ok: false,
        statusCode: 401,
        payload: polymarketCredentialsInvalidPayload(
          lastInvalidCredentialsFailure,
        ),
      };
    }

    if (lastUpstreamFailure) {
      return {
        ok: false,
        statusCode: 502,
        payload: {
          error: "Polymarket cancel failed",
          status: lastUpstreamFailure.status,
          payload: lastUpstreamFailure.payload,
        },
      };
    }

    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Polymarket cancel failed" },
    };
  }

  const cancelUpdate = await input.pool.query(
    `
      update orders o
      set status = 'cancelled',
          cancelled_at = coalesce(cancelled_at, now()),
          last_update = now()
      where o.user_id = $1
        and o.venue = 'polymarket'
        and o.venue_order_id = $2
        and lower(coalesce(o.status, '')) in (
          'pending',
          'submitted',
          'live',
          'open',
          'delayed',
          'unconfirmed',
          'partially_filled'
        )
    `,
    [input.userId, input.body.orderID],
  );

  if ((cancelUpdate.rowCount ?? 0) > 0) {
    void createNotificationSafe(
      input.pool,
      buildOrderNotification({
        userId: input.userId,
        venue: "polymarket",
        status: "cancelled",
        orderId: input.body.orderID,
        walletAddress: resolvedSigner,
      }),
      notificationLog,
    );
  }

  return {
    ok: true,
    payload: {
      ok: true,
      venue: "polymarket",
      orderId: input.body.orderID,
      signer: resolvedSigner,
      status: "cancelled",
      changed: (cancelUpdate.rowCount ?? 0) > 0,
      payload: resolvedPayload,
    },
  };
}

function normalizeOrderSide(value: unknown): PolymarketSide | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (upper === "BUY" || upper === "SELL") return upper;
    if (upper === "0") return "BUY";
    if (upper === "1") return "SELL";
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }

  return null;
}

function normalizeNumberishString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return null;
}

function parseInteger(value: unknown): bigint | null {
  const raw = normalizeNumberishString(value);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return BigInt(Math.trunc(parsed));
}

function normalizeSignatureType(value: unknown): number | null {
  const raw = normalizeNumberishString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function validatePolymarketOrderWallets(inputs: {
  configuredFunder: string;
  order: Record<string, unknown>;
  selectedSigner: string;
}):
  | { depositWallet: boolean; maker: string; ok: true; orderSigner: string }
  | {
      error: string;
      ok: false;
    } {
  const orderSigner =
    typeof inputs.order.signer === "string" ? inputs.order.signer : "";
  const maker =
    typeof inputs.order.maker === "string" ? inputs.order.maker : "";
  const signatureType = normalizeSignatureType(inputs.order.signatureType);
  const depositWallet = signatureType === 3;
  const legacySafe = signatureType === 2;
  const selectedSigner = normalizeAddress(inputs.selectedSigner);
  const configuredFunder = normalizeAddress(inputs.configuredFunder);
  const normalizedOrderSigner = normalizeAddress(orderSigner);
  const normalizedMaker = normalizeAddress(maker);

  if (!normalizedOrderSigner || !normalizedMaker) {
    return { ok: false, error: "Order signer and maker are required" };
  }

  if (depositWallet) {
    if (!configuredFunder || configuredFunder === selectedSigner) {
      return {
        ok: false,
        error:
          "Polymarket deposit-wallet orders require a configured deposit wallet funder",
      };
    }
    if (
      normalizedOrderSigner !== configuredFunder ||
      normalizedMaker !== configuredFunder
    ) {
      return {
        ok: false,
        error:
          "Deposit-wallet orders must use the configured Polymarket funder as maker and signer",
      };
    }
    return { ok: true, orderSigner, maker, depositWallet };
  }

  if (!legacySafe) {
    return {
      ok: false,
      error:
        "Polymarket orders require a deposit wallet or deployed legacy Safe funder",
    };
  }

  if (!configuredFunder || configuredFunder === selectedSigner) {
    return {
      ok: false,
      error: "Polymarket legacy Safe orders require a configured Safe funder",
    };
  }

  if (normalizedOrderSigner !== selectedSigner) {
    return { ok: false, error: "Order signer must match the selected wallet" };
  }
  if (normalizedMaker !== configuredFunder) {
    return {
      ok: false,
      error:
        "Order maker does not match the configured Polymarket funder/vault",
    };
  }

  return { ok: true, orderSigner, maker, depositWallet };
}

function normalizeOrderType(value: unknown): PolymarketOrderType | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  if (
    upper === "GTC" ||
    upper === "GTD" ||
    upper === "FAK" ||
    upper === "FOK"
  ) {
    return upper;
  }
  return null;
}

function normalizeOrderTypeForClob(value: unknown): PolymarketClobOrderType {
  const normalized = normalizeOrderType(value);
  if (normalized === "FAK") return "FOK";
  if (normalized === "GTC" || normalized === "GTD" || normalized === "FOK") {
    return normalized;
  }
  return "GTC";
}

function parseNumberish(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isImmediateExecutionStatus(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return normalized === "matched" || normalized === "filled";
}

function readRecordField(
  record: Record<string, unknown> | null,
  keys: string[],
): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function parsePositiveNumber(value: unknown): number | null {
  const numeric = parseNumberish(value);
  if (numeric == null || !Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function parsePositiveMicroToUi(value: unknown): number | null {
  const numeric = parsePositiveNumber(value);
  if (numeric == null) return null;
  const ui = numeric / 1_000_000;
  if (!Number.isFinite(ui) || ui <= 0) return null;
  return ui;
}

function extractPolymarketImmediateFill(inputs: {
  fallbackPrice: number | null;
  fallbackSize: number | null;
  payload: unknown;
  side: PolymarketSide;
  status: string;
}): { fromPayload: boolean; notionalUsd: number; shares: number } | null {
  const payloadRecord = isRecord(inputs.payload) ? inputs.payload : null;
  const orderRecord = payloadRecord
    ? isRecord(payloadRecord.order)
      ? payloadRecord.order
      : payloadRecord
    : null;

  const statusNormalized = inputs.status.trim().toLowerCase();
  const side =
    normalizeOrderSide(
      readRecordField(orderRecord, ["side", "orderSide", "order_side"]),
    ) ?? inputs.side;

  const payloadShares =
    parsePositiveNumber(
      readRecordField(orderRecord, [
        "filled_size",
        "filledSize",
        "size_matched",
        "sizeMatched",
        "matched_amount",
        "matchedAmount",
      ]),
    ) ??
    parsePositiveMicroToUi(
      readRecordField(
        orderRecord,
        side === "BUY"
          ? ["filled_taker_amount", "filledTakerAmount"]
          : ["filled_maker_amount", "filledMakerAmount"],
      ),
    );

  const payloadPrice = parsePositiveNumber(
    readRecordField(orderRecord, [
      "average_fill_price",
      "averageFillPrice",
      "fill_price",
      "fillPrice",
      "price",
    ]),
  );

  const payloadNotional =
    parsePositiveMicroToUi(
      readRecordField(
        orderRecord,
        side === "BUY"
          ? ["filled_maker_amount", "filledMakerAmount"]
          : ["filled_taker_amount", "filledTakerAmount"],
      ),
    ) ??
    (payloadShares != null && payloadPrice != null
      ? payloadShares * payloadPrice
      : null);

  if (
    payloadShares != null &&
    payloadNotional != null &&
    Number.isFinite(payloadShares) &&
    payloadShares > 0 &&
    Number.isFinite(payloadNotional) &&
    payloadNotional > 0
  ) {
    return {
      shares: payloadShares,
      notionalUsd: payloadNotional,
      fromPayload: true,
    };
  }

  if (statusNormalized === "partially_filled") return null;

  if (
    inputs.fallbackPrice != null &&
    inputs.fallbackSize != null &&
    Number.isFinite(inputs.fallbackPrice) &&
    Number.isFinite(inputs.fallbackSize) &&
    inputs.fallbackPrice > 0 &&
    inputs.fallbackSize > 0
  ) {
    return {
      shares: inputs.fallbackSize,
      notionalUsd: inputs.fallbackPrice * inputs.fallbackSize,
      fromPayload: false,
    };
  }

  return null;
}

function isPolymarketServiceNotReadyResponse(inputs: {
  status: number;
  payload: unknown;
}): boolean {
  if (inputs.status !== POLYMARKET_SERVICE_NOT_READY_STATUS) return false;
  const message = extractPolymarketUpstreamMessage(inputs.payload);
  if (!message) return true;
  return message.toLowerCase().includes("service not ready");
}

async function submitPolymarketClobOrderWithRetry(input: {
  address: string;
  body: unknown;
  creds: PolymarketL2Credentials;
  log?: PolymarketRouteLogger | null;
  logContext?: Record<string, unknown>;
}): Promise<PolymarketL2RequestResult> {
  const submitOrder = () =>
    polymarketL2Request({
      baseUrl: env.polymarketClobBase,
      timeoutMs: 10_000,
      address: input.address,
      creds: input.creds,
      method: "POST",
      requestPath: "/order",
      body: input.body,
    });

  let upstream = await submitOrder();
  for (
    let attempt = 0;
    !upstream.ok &&
    isPolymarketServiceNotReadyResponse(upstream) &&
    attempt < POLYMARKET_ORDER_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    const delayMs = POLYMARKET_ORDER_RETRY_DELAYS_MS[attempt] ?? 0;
    input.log?.warn?.(
      {
        upstreamStatus: upstream.status,
        upstreamPayload: upstream.payload,
        ...(input.logContext ?? {}),
        retryAttempt: attempt + 1,
        retryDelayMs: delayMs,
      },
      "Polymarket order service not ready; retrying same signed order",
    );
    await sleep(delayMs);
    upstream = await submitOrder();
  }
  return upstream;
}

function exchangeAddressForNegRisk(negRisk: boolean | null): string | null {
  if (negRisk == null) return null;
  return negRisk
    ? env.polymarketNegRiskExchangeAddress
    : env.polymarketExchangeAddress;
}

function parseBigIntValue(
  value: string | number | bigint | null | undefined,
): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return BigInt(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

type PolymarketMaxSpendUnavailableReason =
  | "missing_credentials"
  | "unsupported_wallet"
  | "unsupported_order_type"
  | "quote_unavailable"
  | "balance_unavailable"
  | "no_executable_funds"
  | "no_liquidity"
  | "below_min_order";

function polymarketMaxSpendUnavailable(
  reason: PolymarketMaxSpendUnavailableReason,
  message: string,
) {
  return { ok: false, reason, message };
}

function resolvePolymarketFunderExecutionKindForMaxSpend(
  candidate: PolymarketFunderCandidate | null | undefined,
): PolymarketFunderExecutionKind {
  if (!candidate) return null;
  if (candidate.source === "magic_proxy") return "magic";
  if (candidate.source === "safe_proxy") return "safe";
  if (candidate.source === "stored") {
    if (candidate.signatureType === 3) return "deposit_wallet";
    if (
      candidate.signatureType === 2 &&
      candidate.contractKind === "SAFE_LIKE"
    ) {
      return "safe";
    }
    if (candidate.signatureType === 1) return "magic";
  }
  return null;
}

function findPolymarketFunderCandidateByAddress(
  candidates: PolymarketFunderCandidate[],
  address: string,
): PolymarketFunderCandidate | null {
  const normalized = toChecksumAddress(address);
  if (!normalized) return null;
  return (
    candidates.find(
      (candidate) => toChecksumAddress(candidate.funder) === normalized,
    ) ?? null
  );
}

class PolymarketMaxSpendLiveOrderLocksError extends Error {
  constructor(readonly upstream: { status: number; payload: unknown }) {
    super("Failed to fetch live Polymarket open-order locks");
    this.name = "PolymarketMaxSpendLiveOrderLocksError";
  }
}

async function fetchPolymarketMaxSpendLiveOpenOrderLocks(inputs: {
  creds: PolymarketL2Credentials;
  signer: string;
  wallets: string[];
}): Promise<Map<string, bigint>> {
  const upstream = await polymarketL2Request({
    baseUrl: env.polymarketClobBase,
    timeoutMs: 10_000,
    address: inputs.signer,
    creds: inputs.creds,
    method: "GET",
    requestPath: "/data/orders",
  });

  if (!upstream.ok) {
    throw new PolymarketMaxSpendLiveOrderLocksError(upstream);
  }

  return computePolymarketClobOpenOrderLocks({
    orders: extractOrderArray(upstream.payload),
    wallets: inputs.wallets,
  });
}

function maxRaw(a: bigint | null | undefined, b: bigint | null | undefined) {
  const left = a != null && a > 0n ? a : 0n;
  const right = b != null && b > 0n ? b : 0n;
  return left > right ? left : right;
}

async function resolvePolymarketMaxSpendFunds(inputs: {
  creds: PolymarketL2Credentials;
  funder: string;
  funderExecutionKind: PolymarketFunderExecutionKind;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<{
  executableFundsRaw: bigint;
  funderPusdRaw: bigint;
  funderPusdAvailableRaw: bigint;
  funderLockedRaw: bigint;
  signerLockedRaw: bigint;
  signerPusdTopUpRaw: bigint;
  signerUsdceTopUpRaw: bigint;
  usesSignerTopUp: boolean;
}> {
  const signerNormalized = toChecksumAddress(inputs.signer);
  const funderNormalized = toChecksumAddress(inputs.funder);
  if (!signerNormalized || !funderNormalized) {
    throw new Error("Invalid Polymarket signer or funder address.");
  }

  const includeSignerUsdc =
    inputs.funderExecutionKind === "deposit_wallet" &&
    signerNormalized !== funderNormalized;
  const lockWallets = includeSignerUsdc
    ? [funderNormalized, signerNormalized]
    : [funderNormalized];
  const negRiskAdapterAddress =
    env.polymarketNegRiskAdapterAddress?.trim() || "";
  const [snapshot, localCollateralLocks, liveCollateralLocks] =
    await Promise.all([
      fetchPolymarketOnchainSnapshot({
        rpcUrl: env.polygonRpcUrl,
        timeoutMs: env.polygonRpcTimeoutMs,
        signer: signerNormalized,
        funder: funderNormalized,
        includeSignerUsdc,
        includeFeeCollectorNonce: false,
        negRiskAdapterAddress,
        feeCollectorAddress: null,
      }),
      fetchOpenOrderCollateralLocks(inputs.pool, {
        userId: inputs.userId,
        polymarketWallets: lockWallets,
        limitlessWallets: [],
      }),
      fetchPolymarketMaxSpendLiveOpenOrderLocks({
        signer: signerNormalized,
        creds: inputs.creds,
        wallets: lockWallets,
      }),
    ]);
  const funderLockKey = funderNormalized.toLowerCase();
  const signerLockKey = signerNormalized.toLowerCase();
  const funderLockedRaw = maxRaw(
    localCollateralLocks.polymarket.get(funderLockKey),
    liveCollateralLocks.get(funderLockKey),
  );
  const signerLockedRaw = maxRaw(
    localCollateralLocks.polymarket.get(signerLockKey),
    liveCollateralLocks.get(signerLockKey),
  );

  return computePolymarketExecutableFunds({
    signer: signerNormalized,
    funder: funderNormalized,
    funderExecutionKind: inputs.funderExecutionKind,
    funderPusdRaw: snapshot.pusdBalance,
    funderLockedRaw,
    signerPusdRaw: snapshot.signerPusdBalance,
    signerLockedRaw,
    signerUsdceRaw: snapshot.signerUsdceBalance,
  });
}

function readMakerAmountFromOrderPayload(orderPayload: unknown): bigint | null {
  if (!isRecord(orderPayload)) return null;
  const makerAmount = orderPayload.makerAmount;
  if (
    makerAmount == null ||
    typeof makerAmount === "string" ||
    typeof makerAmount === "number" ||
    typeof makerAmount === "bigint"
  ) {
    return parseBigIntValue(makerAmount);
  }
  return null;
}

function isPolymarketOrderPayloadV2(orderPayload: unknown): boolean {
  return (
    isRecord(orderPayload) &&
    "timestamp" in orderPayload &&
    "metadata" in orderPayload &&
    "builder" in orderPayload
  );
}

function resolvePolymarketOrderPayloadVersion(orderPayload: unknown): string {
  return isPolymarketOrderPayloadV2(orderPayload)
    ? "polymarket_clob_v2"
    : "polymarket_clob_v1";
}

async function resolvePolymarketOrderExchangeAddress(inputs: {
  explicitExchangeAddress?: string | null;
  tokenId?: string | null;
}): Promise<string> {
  const explicit = inputs.explicitExchangeAddress?.trim();
  if (explicit) return explicit;

  const tokenId = inputs.tokenId?.trim();
  if (tokenId) {
    const marketInfo = await fetchPolymarketMarketInfo(pool, { tokenId });
    const marketExchangeAddress = exchangeAddressForNegRisk(
      marketInfo?.neg_risk ?? null,
    );
    if (marketExchangeAddress) return marketExchangeAddress;
  }

  return env.polymarketExchangeAddress;
}

async function fetchPolymarketExecutionSummary(inputs: {
  exchangeAddress: string;
  makerAmount: bigint;
  orderHash: string;
  orderPayloadVersion?: string | null;
}) {
  if (inputs.orderPayloadVersion === "polymarket_clob_v2") {
    const onchainStatus = await fetchPolymarketOrderStatusV2({
      rpcUrl: env.polygonRpcUrl,
      timeoutMs: env.polygonRpcTimeoutMs,
      exchangeAddress: inputs.exchangeAddress,
      orderHash: inputs.orderHash,
    });
    return summarizePolymarketV2OnchainOrderExecution({
      makerAmount: inputs.makerAmount,
      filled: onchainStatus.filled,
      remaining: onchainStatus.remaining,
    });
  }

  const onchainStatus = await fetchPolymarketOrderStatus({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    exchangeAddress: inputs.exchangeAddress,
    orderHash: inputs.orderHash,
  });
  return summarizePolymarketOnchainOrderExecution({
    makerAmount: inputs.makerAmount,
    remaining: onchainStatus.remaining,
    isFilledOrCancelled: onchainStatus.isFilledOrCancelled,
  });
}

async function waitForPolymarketExecutionConfirmation(inputs: {
  exchangeAddress: string;
  makerAmount: bigint;
  orderHash: string;
  orderPayloadVersion?: string | null;
}) {
  for (
    let attempt = 0;
    attempt < POLYMARKET_SUBMIT_SETTLEMENT_ATTEMPTS;
    attempt += 1
  ) {
    const summary = await fetchPolymarketExecutionSummary(inputs);
    if (summary.hasExecution) return summary;
    if (attempt < POLYMARKET_SUBMIT_SETTLEMENT_ATTEMPTS - 1) {
      await sleep(POLYMARKET_SUBMIT_SETTLEMENT_DELAY_MS);
    }
  }
  return null;
}

function normalizeOrderForPayload(
  order: Record<string, unknown>,
  side: PolymarketSide,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...order };

  normalized.side = side;

  const signatureType = normalizeSignatureType(order.signatureType);
  if (signatureType !== null) {
    normalized.signatureType = signatureType;
  }

  const saltRaw = normalizeNumberishString(order.salt);
  if (saltRaw !== null) {
    const saltNumber = Number(saltRaw);
    normalized.salt = Number.isSafeInteger(saltNumber) ? saltNumber : saltRaw;
  }

  for (const key of [
    "tokenId",
    "makerAmount",
    "takerAmount",
    "timestamp",
    "expiration",
  ]) {
    const value = normalizeNumberishString(order[key]);
    if (value !== null) normalized[key] = value;
  }

  return normalized;
}

type NormalizedPolymarketOrderV2 = {
  salt: string;
  maker: string;
  signer: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  side: number;
  signatureType: number;
  timestamp: string;
  metadata: string;
  builder: string;
  signature: string;
};

function normalizeOrderForHash(
  order: Record<string, unknown>,
  side: PolymarketSide,
): NormalizedPolymarketOrderV2 | null {
  const signatureType = normalizeSignatureType(order.signatureType);
  if (signatureType == null) return null;

  const maker = typeof order.maker === "string" ? order.maker.trim() : "";
  const signer = typeof order.signer === "string" ? order.signer.trim() : "";
  if (!maker || !signer) return null;

  const salt = normalizeNumberishString(order.salt);
  const tokenId = normalizeNumberishString(order.tokenId);
  const makerAmount = normalizeNumberishString(order.makerAmount);
  const takerAmount = normalizeNumberishString(order.takerAmount);
  const timestamp = normalizeNumberishString(order.timestamp);
  const metadata =
    typeof order.metadata === "string" ? order.metadata.trim() : "";
  const builder = typeof order.builder === "string" ? order.builder.trim() : "";
  if (
    !salt ||
    !tokenId ||
    !makerAmount ||
    !takerAmount ||
    !timestamp ||
    !metadata ||
    !builder
  ) {
    return null;
  }

  const signature =
    typeof order.signature === "string" ? order.signature.trim() : "";
  if (!signature) return null;

  return {
    salt,
    maker,
    signer,
    tokenId,
    makerAmount,
    takerAmount,
    side: side === "BUY" ? 0 : 1,
    signatureType,
    timestamp,
    metadata,
    builder,
    signature,
  };
}

function derivePriceAndSize(
  order: Record<string, unknown>,
  side: PolymarketSide,
): { price: number | null; size: number | null } {
  const makerAmount = parseInteger(order.makerAmount);
  const takerAmount = parseInteger(order.takerAmount);
  if (!makerAmount || !takerAmount) return { price: null, size: null };
  if (makerAmount === 0n || takerAmount === 0n) {
    return { price: null, size: null };
  }

  const price =
    side === "BUY"
      ? Number(makerAmount) / Number(takerAmount)
      : Number(takerAmount) / Number(makerAmount);

  const sizeMicro = side === "BUY" ? takerAmount : makerAmount;
  const size = Number(sizeMicro) / 10 ** POLY_DECIMALS;

  if (!Number.isFinite(price) || !Number.isFinite(size)) {
    return { price: null, size: null };
  }

  return { price, size };
}

function buildWrappedDepositWalletSignature(input: {
  appDomain: Record<string, unknown>;
  innerSignature: string;
  message: Record<string, unknown>;
}): string {
  const domainSep = ethers.TypedDataEncoder.hashDomain(input.appDomain);
  const contentsHash = ethers.TypedDataEncoder.hashStruct(
    "Order",
    POLYMARKET_ORDER_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    input.message,
  );
  const typeStringHex = ethers.hexlify(ethers.toUtf8Bytes(ORDER_TYPE_STRING));
  const lenHex = (186).toString(16).padStart(4, "0");
  return `0x${input.innerSignature.replace(/^0x/, "")}${domainSep.slice(2)}${contentsHash.slice(2)}${typeStringHex.slice(2)}${lenHex}`;
}

async function signPolymarketOrder(input: {
  candidate: PolymarketFunderCandidate;
  exchangeAddress: string;
  order: Record<string, unknown>;
  signer: string;
  walletId: string;
}): Promise<string> {
  const appDomain = {
    name: "Polymarket CTF Exchange",
    version: "2",
    chainId: POLYGON_CHAIN_ID,
    verifyingContract: input.exchangeAddress,
  };
  const walletClient = createServerWalletClient();

  if (input.candidate.signatureType === 3) {
    const typedData = {
      domain: appDomain,
      types: POLYMARKET_TYPED_DATA_SIGN_TYPES,
      primaryType: "TypedDataSign",
      message: {
        contents: input.order,
        name: "DepositWallet",
        version: "1",
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: input.candidate.funder,
        salt: ZERO_BYTES32,
      },
    };
    const innerSignature = await signEvmTypedData({
      walletClient,
      walletId: input.walletId,
      signer: input.signer,
      typedData,
    });
    return buildWrappedDepositWalletSignature({
      appDomain,
      innerSignature,
      message: input.order,
    });
  }

  if (input.candidate.signatureType !== 2) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Unsupported Polymarket funder signature mode.",
      venue: "polymarket",
    });
  }

  return signEvmTypedData({
    walletClient,
    walletId: input.walletId,
    signer: input.signer,
    typedData: {
      domain: appDomain,
      types: POLYMARKET_ORDER_TYPES,
      primaryType: "Order",
      message: input.order,
    },
  });
}

export async function submitPolymarketClientSignedOrder(input: {
  body: PolymarketClientOrderBody;
  log?: PolymarketRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<PolymarketClientSignedOrderResult> {
  const signer = input.signer;
  if (!signer.startsWith("0x")) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket order placement requires an EVM wallet address",
      },
    };
  }

  const creds = await AuthService.getVenueCredentials(
    input.userId,
    "polymarket",
    signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket credentials not found (connect first)",
      },
    };
  }

  const order = input.body.order;
  const funder = creds.funderAddress ?? signer;
  const walletValidation = validatePolymarketOrderWallets({
    order,
    selectedSigner: signer,
    configuredFunder: funder,
  });
  if (!walletValidation.ok) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: walletValidation.error },
    };
  }

  const side = normalizeOrderSide(order.side);
  if (!side) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Order side must be BUY/SELL (or 0/1)",
      },
    };
  }

  const positionWalletAddress =
    typeof input.body.positionWalletAddress === "string" &&
    input.body.positionWalletAddress.trim()
      ? input.body.positionWalletAddress.trim()
      : null;
  if (positionWalletAddress && side === "SELL") {
    const normalizedPositionWallet = positionWalletAddress.toLowerCase();
    if (
      normalizedPositionWallet !== signer.toLowerCase() &&
      normalizedPositionWallet !== funder.toLowerCase()
    ) {
      return {
        ok: false,
        statusCode: 400,
        payload: {
          error:
            "positionWalletAddress must match the signer or Polymarket funder",
        },
      };
    }
  }

  const orderType = normalizeOrderTypeForClob(input.body.orderType);
  const orderTokenId = extractTokenId(order);
  if (!isPolymarketOrderPayloadV2(order)) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          "Polymarket CLOB V1 order payloads are no longer supported. Build and sign a CLOB V2 order with timestamp, metadata, and builder fields.",
      },
    };
  }

  const feePolicySnapshot = await resolvePolymarketFeePolicySnapshot(
    input.pool,
  );
  const builderValidation = validatePolymarketOrderBuilderCodeForConfig(
    typeof order.builder === "string" ? order.builder : null,
    {
      active: feePolicySnapshot.collectionMode === "builder",
      builderCode: feePolicySnapshot.builderCode,
      takerFeeBps: feePolicySnapshot.builderTakerFeeBps,
      makerFeeBps: feePolicySnapshot.builderMakerFeeBps,
    },
  );
  if (!builderValidation.ok) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: builderValidation.error },
    };
  }

  const marketInfo = orderTokenId
    ? await fetchPolymarketMarketInfo(input.pool, { tokenId: orderTokenId })
    : null;

  const normalizedOrder = normalizeOrderForPayload(order, side);
  const normalizedForHash = normalizeOrderForHash(order, side);
  if (normalizedOrder.expiration == null) {
    normalizedOrder.expiration = "0";
  }
  const orderPayload = normalizedForHash ?? normalizedOrder;

  const exchangeAddress =
    (typeof input.body.exchangeAddress === "string" &&
      input.body.exchangeAddress.trim()) ||
    exchangeAddressForNegRisk(
      input.body.negRisk ?? marketInfo?.neg_risk ?? null,
    ) ||
    env.polymarketExchangeAddress;

  if (!normalizedForHash) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Order payload is missing required hash fields",
      },
    };
  }

  if (side === "SELL") {
    const requestedSharesRaw = parseBigIntValue(normalizedForHash.makerAmount);
    const sellTokenId = normalizedForHash.tokenId;
    if (requestedSharesRaw != null && requestedSharesRaw > 0n && sellTokenId) {
      const balances = await fetchErc1155BalancesByOwner({
        rpcUrl: env.polygonRpcUrl,
        timeoutMs: env.polygonRpcTimeoutMs,
        contractAddress: env.polymarketConditionalTokensAddress,
        owner: funder,
        tokenIds: [sellTokenId],
      });
      const availableSharesRaw = balances.get(sellTokenId) ?? 0n;
      if (availableSharesRaw < requestedSharesRaw) {
        return {
          ok: false,
          statusCode: 400,
          payload: {
            error: "Polymarket position balance changed",
            code: POLYMARKET_SELL_BALANCE_CHANGED_CODE,
            tokenId: sellTokenId,
            owner: funder,
            availableSharesRaw: availableSharesRaw.toString(),
            requestedSharesRaw: requestedSharesRaw.toString(),
            availableShares: ethers.formatUnits(availableSharesRaw, 6),
            requestedShares: ethers.formatUnits(requestedSharesRaw, 6),
          },
        };
      }
    }
  }

  const orderHash = await fetchPolymarketOrderHashV2({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    exchangeAddress,
    order: normalizedForHash,
  });

  const payload = {
    order: normalizedOrder,
    owner: creds.apiKey,
    orderType,
    ...(input.body.deferExec !== undefined
      ? { deferExec: input.body.deferExec }
      : {}),
  };
  const clobCreds = {
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    apiPassphrase: creds.apiPassphrase,
  };

  const upstream = await submitPolymarketClobOrderWithRetry({
    address: signer,
    body: payload,
    creds: clobCreds,
    log: input.log,
    logContext: {
      signer,
      funder,
      tokenId: orderTokenId,
      orderType,
      orderHash,
    },
  });

  if (!upstream.ok) {
    if (
      await invalidatePolymarketCredentialsForInvalidApiKey({
        userId: input.userId,
        signer,
        endpoint: "order",
        upstream,
        log: input.log,
      })
    ) {
      return {
        ok: false,
        statusCode: 401,
        payload: {
          error: "Reconnect Polymarket to refresh trading credentials.",
          code: POLYMARKET_CREDENTIALS_INVALID_CODE,
          reconnectRequired: true,
          status: upstream.status,
          payload: upstream.payload,
        },
      };
    }

    const upstreamMessage = extractPolymarketUpstreamMessage(upstream.payload);
    input.log?.warn?.(
      {
        upstreamStatus: upstream.status,
        upstreamMessage,
        upstreamPayload: upstream.payload,
        signer,
        funder,
        tokenId: orderTokenId,
        orderType,
      },
      "Polymarket order placement upstream failed",
    );
    const responseStatus =
      upstream.status >= 500
        ? 502
        : upstream.status >= 400
          ? upstream.status
          : 400;
    return {
      ok: false,
      statusCode: responseStatus,
      payload: {
        error: "Polymarket order placement failed",
        ...(isPolymarketDepositWalletRequiredMessage(upstreamMessage)
          ? {
              code: "polymarket_deposit_wallet_required",
              message:
                "This Polymarket wallet must trade through its deposit wallet. Configure the deposit wallet funder and retry.",
            }
          : {}),
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  if (isRecord(upstream.payload) && upstream.payload.success === false) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Polymarket order rejected",
        payload: upstream.payload,
      },
    };
  }

  const venueOrderId = extractOrderId(upstream.payload);
  if (!venueOrderId) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Polymarket order placed but no orderId returned",
        payload: upstream.payload,
      },
    };
  }

  const tokenId = extractTokenId(order);
  const { price, size } = derivePriceAndSize(order, side);
  const statusRaw =
    extractPolymarketOrderStatus(upstream.payload) ?? "submitted";
  const immediateFill = extractPolymarketImmediateFill({
    payload: upstream.payload,
    side,
    status: statusRaw,
    fallbackPrice: price,
    fallbackSize: size,
  });
  const shouldConfirmImmediateExecution =
    orderType === "FOK" &&
    (isImmediateExecutionStatus(statusRaw) ||
      immediateFill?.fromPayload === true);

  let status = statusRaw;
  if (shouldConfirmImmediateExecution) {
    const makerAmount = parseBigIntValue(normalizedForHash.makerAmount);
    if (makerAmount != null && makerAmount > 0n) {
      try {
        const execution = await waitForPolymarketExecutionConfirmation({
          exchangeAddress,
          orderHash,
          makerAmount,
          orderPayloadVersion:
            resolvePolymarketOrderPayloadVersion(orderPayload),
        });
        status = execution?.hasExecution
          ? "matched"
          : POLYMARKET_UNCONFIRMED_STATUS;
      } catch (error) {
        input.log?.warn?.(
          {
            error,
            userId: input.userId,
            signer,
            funder,
            tokenId,
            orderHash,
          },
          "Polymarket submit-time on-chain confirmation failed",
        );
        status = POLYMARKET_UNCONFIRMED_STATUS;
      }
    } else {
      status = POLYMARKET_UNCONFIRMED_STATUS;
    }
  }

  const stored = await storeOrder(input.pool, {
    userId: input.userId,
    walletAddress: funder,
    signerAddress: signer,
    venue: "polymarket",
    venueOrderId,
    tokenId,
    side,
    orderType,
    price,
    size,
    status,
    errorMessage: null,
    rawError: null,
    orderPayload,
    orderPayloadVersion: resolvePolymarketOrderPayloadVersion(orderPayload),
    orderHash,
    feeBps: null,
    feeAuth: null,
    feeAuthSig: null,
    feeCollectorAddress: null,
    feeDeadline: null,
    feePolicySnapshot,
  });

  const referralFirstTrade =
    stored.kind === "stored" && status === "matched"
      ? await tryRecordReferralFirstTradeConversion(input.pool, {
          userId: input.userId,
          venue: "polymarket",
          status,
          sourceType: "order",
          sourceId: venueOrderId,
          txHash: orderHash,
          logger: input.log,
        })
      : null;

  if (
    stored.kind === "stored" &&
    status === "matched" &&
    tokenId &&
    immediateFill
  ) {
    const optimisticPositionWalletAddress =
      side === "SELL" && positionWalletAddress ? positionWalletAddress : funder;
    try {
      await applyOptimisticPositionTrade(input.pool, {
        userId: input.userId,
        walletAddress: optimisticPositionWalletAddress,
        venue: "polymarket",
        tokenId,
        side,
        shares: immediateFill.shares,
        notionalUsd: immediateFill.notionalUsd,
      });
    } catch (error) {
      input.log?.warn?.(
        {
          error,
          userId: input.userId,
          walletAddress: optimisticPositionWalletAddress,
          funder,
          tokenId,
          side,
        },
        "Polymarket optimistic position update failed",
      );
    }
  }

  void createNotificationSafe(
    input.pool,
    buildOrderNotification({
      userId: input.userId,
      venue: "polymarket",
      status,
      side,
      size,
      price,
      orderId: venueOrderId,
      tokenId,
      walletAddress: funder,
    }),
    input.log as never,
  );

  return {
    ok: true,
    payload: {
      ok: true,
      venue: "polymarket",
      orderId: venueOrderId,
      orderHash,
      status,
      stored: stored.kind,
      referralFirstTrade: referralFirstTrade ?? undefined,
      payload: upstream.payload,
    },
  };
}

async function getReadiness(
  ctx: ApiTradingApplicationServiceInput,
  input: TradingReadinessInput,
): Promise<TradingReadiness> {
  if (input.action && input.action !== "BUY") {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "unsupported_capability",
      message: "Telegram bot trading currently supports buy only.",
    });
  }
  if (!input.privyWalletId) {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Selected wallet is missing a Privy wallet id.",
      setupRequired: true,
    });
  }
  if (!hasServerWalletClientConfig()) {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Server-side Privy wallet authorization is not configured.",
      setupRequired: true,
    });
  }
  if (input.walletChain !== "ethereum" || !input.walletAddress) {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Polymarket bot trading requires a verified EVM Trading Wallet.",
      setupRequired: true,
    });
  }
  if (
    !(await verifyLinkedWallet({
      pool: ctx.pool,
      userId: input.actor.userId,
      walletAddress: input.walletAddress,
      walletChain: input.walletChain,
    }))
  ) {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Selected wallet is no longer linked and verified.",
      setupRequired: true,
    });
  }
  if (input.target?.marketId) {
    const market = await loadMarketForVenue(
      ctx.pool,
      input.target.marketId,
      "polymarket",
    );
    if (!isOrderable(market)) {
      return readiness("polymarket", capabilities, {
        ok: false,
        code: "market_not_orderable",
        message: "Market is not currently open for orders.",
      });
    }
  }

  const signer = toChecksumAddress(input.walletAddress);
  if (!signer) {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "invalid_trade_request",
      message: "Polymarket bot trading requires a valid EVM address.",
    });
  }
  const creds = await AuthService.getVenueCredentials(
    input.actor.userId,
    "polymarket",
    signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Connect Polymarket CLOB credentials before bot trading.",
      setupRequired: true,
    });
  }
  const funders = await derivePolymarketFunders({
    signer,
    storedFunder: creds.funderAddress ?? null,
    includeMagicProxy: true,
  });
  if (!funders.recommended) {
    return readiness("polymarket", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message:
        "Deploy or select a Polymarket deposit wallet before bot trading.",
      setupRequired: true,
    });
  }
  return readiness("polymarket", capabilities, { ok: true });
}

async function quote(
  ctx: ApiTradingApplicationServiceInput,
  input: TradeQuoteInput,
): Promise<TradeQuote> {
  const intent = input.intent;
  const market = await loadMarketForVenue(
    ctx.pool,
    intent.target.marketId,
    "polymarket",
  );
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const tokenId = tokenForSide(market, side);
  if (!isOrderable(market)) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Market is not open for orders.",
      venue: "polymarket",
    });
  }
  const orderQuote = await quotePolymarketOrder(ctx.pool, {
    tokenId,
    side: "BUY",
    orderType: "FOK",
    amountType: "usd",
    amountUsdInput: amountUsd(intent),
    slippageBps: intent.slippageBps ?? 100,
    logWarn: (args) =>
      ctx.logger?.warn?.(args, "Polymarket bot quote context warning"),
  });
  return {
    venue: "polymarket",
    target: { ...intent.target, tokenId, raw: { market } },
    action: "BUY",
    amount: intent.amount,
    price: orderQuote.price,
    estimatedShares: orderQuote.size,
    estimatedNotionalUsd: orderQuote.amountUsdUsed,
    maxSpendUsd:
      orderQuote.totalRequiredUsdcRaw != null
        ? Number(orderQuote.totalRequiredUsdcRaw) / USDC_SCALE
        : orderQuote.amountUsdUsed,
    minReceiveShares: orderQuote.size,
    fees: {
      platformFeeEstimateRaw: orderQuote.platformFeeEstimateRaw,
      builderFeeEstimateRaw: orderQuote.builderFeeEstimateRaw,
      totalFeeEstimateRaw: orderQuote.totalFeeEstimateRaw,
    },
    expiresAt: new Date(Date.now() + 30_000),
    raw: orderQuote,
  };
}

async function prepareTrade(
  ctx: ApiTradingApplicationServiceInput,
  input: { intent: TradeIntent; quote?: TradeQuote | null },
): Promise<PreparedTrade> {
  const intent = input.intent;
  const market = await loadMarketForVenue(
    ctx.pool,
    intent.target.marketId,
    "polymarket",
  );
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const tokenId = tokenForSide(market, side);
  const signer = toChecksumAddress(intent.walletAddress);
  if (!signer) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Polymarket bot trading requires a valid EVM wallet.",
      venue: "polymarket",
    });
  }

  const creds = await AuthService.getVenueCredentials(
    intent.actor.userId,
    "polymarket",
    signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Polymarket CLOB credentials are missing.",
      venue: "polymarket",
    });
  }

  const funders = await derivePolymarketFunders({
    signer,
    storedFunder: creds.funderAddress ?? null,
    includeMagicProxy: true,
    bypassCodeCache: true,
  });
  const candidate = funders.recommended;
  if (!candidate) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Polymarket deposit wallet or Safe funder is not ready.",
      venue: "polymarket",
    });
  }

  const rawQuote =
    extractQuoteRaw<{
      exchangeAddress?: string | null;
      makerAmount: string;
      price: number;
      size: number;
      takerAmount: string;
    }>(input.quote) ?? (await quote(ctx, { intent })).raw;
  if (!isRecord(rawQuote)) {
    throw tradingError({
      code: "quote_unavailable",
      message: "Polymarket quote is unavailable.",
      venue: "polymarket",
    });
  }

  const exchangeAddress =
    readString(rawQuote.exchangeAddress) ??
    (isRecord(market.metadata) && market.metadata.negRisk === true
      ? env.polymarketNegRiskExchangeAddress
      : env.polymarketExchangeAddress);
  const feePolicySnapshot = await resolvePolymarketFeePolicySnapshot(ctx.pool);
  const builderValidation = validatePolymarketOrderBuilderCodeForConfig(
    feePolicySnapshot.builderCode,
    {
      active: feePolicySnapshot.collectionMode === "builder",
      builderCode: feePolicySnapshot.builderCode,
      takerFeeBps: feePolicySnapshot.builderTakerFeeBps,
      makerFeeBps: feePolicySnapshot.builderMakerFeeBps,
    },
  );
  if (!builderValidation.ok) {
    throw tradingError({
      code: "invalid_trade_request",
      message: builderValidation.error,
      venue: "polymarket",
    });
  }

  const signerForPayload =
    candidate.signatureType === 3 ? candidate.funder : signer;
  const order = {
    salt: randomUint256SaltDecimal(),
    maker: candidate.funder,
    signer: signerForPayload,
    tokenId,
    makerAmount: String(rawQuote.makerAmount),
    takerAmount: String(rawQuote.takerAmount),
    side: 0,
    signatureType: candidate.signatureType,
    timestamp: Math.floor(Date.now() / 1000).toString(),
    metadata: ZERO_BYTES32,
    builder: feePolicySnapshot.builderCode,
    expiration: "0",
  };
  const signature = await signPolymarketOrder({
    candidate,
    exchangeAddress,
    order,
    signer,
    walletId: getPrivyWalletId(intent),
  });
  const orderPayload = { ...order, signature };
  const orderHash = await fetchPolymarketOrderHashV2({
    rpcUrl: env.polygonRpcUrl,
    timeoutMs: env.polygonRpcTimeoutMs,
    exchangeAddress,
    order: orderPayload,
  });

  return {
    preparedId: crypto.randomUUID(),
    venue: "polymarket",
    intent,
    quote: input.quote ?? null,
    authorizationMode: "embedded_privy_evm",
    authorizationRequests: [],
    venuePayload: {
      kind: "polymarket",
      exchangeAddress,
      orderPayload,
      orderHash,
      orderType: "FOK",
      positionWalletAddress: candidate.funder,
      price: readNumber(rawQuote.price),
      size: readNumber(rawQuote.size),
      tokenId,
      feePolicySnapshot,
    } satisfies PolymarketPreparedPayload,
    expiresAt: new Date(Date.now() + 30_000),
  };
}

function extractPolymarketMessage(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return null;
  return readString(payload.error) ?? readString(payload.message);
}

function extractStatus(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const record = isRecord(payload.order) ? payload.order : payload;
  return readString(record.status) ?? readString(record.executionStatus);
}

async function submitPreparedTrade(
  ctx: ApiTradingApplicationServiceInput,
  prepared: PreparedTrade,
): Promise<SubmitResult> {
  const payload = parsePreparedPayload<PolymarketPreparedPayload>(
    prepared,
    "polymarket",
  );
  const signer = prepared.intent.walletAddress;
  const creds = await AuthService.getVenueCredentials(
    prepared.intent.actor.userId,
    "polymarket",
    signer,
  );
  if (!creds?.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Polymarket CLOB credentials are missing.",
      venue: "polymarket",
    });
  }

  const requestBody = {
    order: payload.orderPayload,
    owner: creds.apiKey,
    orderType: payload.orderType,
  };
  const clobCreds = {
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    apiPassphrase: creds.apiPassphrase,
  };
  const upstream = await submitPolymarketClobOrderWithRetry({
    address: signer,
    body: requestBody,
    creds: clobCreds,
    log: ctx.logger,
    logContext: {
      signer,
      tokenId: payload.tokenId,
      orderType: payload.orderType,
      orderHash: payload.orderHash,
    },
  });
  if (!upstream.ok) {
    if (
      await invalidatePolymarketCredentialsForInvalidApiKey({
        userId: prepared.intent.actor.userId,
        signer,
        endpoint: "order",
        upstream,
        log: ctx.logger,
      })
    ) {
      throw tradingError({
        code: POLYMARKET_CREDENTIALS_INVALID_CODE,
        message: "Reconnect Polymarket to refresh trading credentials.",
        statusCode: 401,
        venue: "polymarket",
      });
    }
    throw tradingError({
      code: "trade_submission_failed",
      message:
        extractPolymarketMessage(upstream.payload) ??
        "Polymarket order placement failed.",
      statusCode: upstream.status >= 500 ? 502 : upstream.status,
      venue: "polymarket",
    });
  }
  if (isRecord(upstream.payload) && upstream.payload.success === false) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Polymarket order rejected.",
      venue: "polymarket",
    });
  }
  const venueOrderId = extractOrderId(upstream.payload);
  if (!venueOrderId) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Polymarket order placed but no order id returned.",
      statusCode: 502,
      venue: "polymarket",
    });
  }

  const statusRaw = extractStatus(upstream.payload) ?? "submitted";
  const immediateFill = extractPolymarketImmediateFill({
    payload: upstream.payload,
    side: "BUY",
    status: statusRaw,
    fallbackPrice: payload.price,
    fallbackSize: payload.size,
  });
  const shouldConfirmImmediateExecution =
    payload.orderType === "FOK" &&
    (isImmediateExecutionStatus(statusRaw) ||
      immediateFill?.fromPayload === true);
  let status = statusRaw;
  if (shouldConfirmImmediateExecution) {
    const makerAmount = readMakerAmountFromOrderPayload(payload.orderPayload);
    if (makerAmount != null && makerAmount > 0n) {
      try {
        const execution = await waitForPolymarketExecutionConfirmation({
          exchangeAddress: payload.exchangeAddress,
          makerAmount,
          orderHash: payload.orderHash,
          orderPayloadVersion: resolvePolymarketOrderPayloadVersion(
            payload.orderPayload,
          ),
        });
        status = execution?.hasExecution
          ? "matched"
          : POLYMARKET_UNCONFIRMED_STATUS;
      } catch (error) {
        ctx.logger?.warn?.(
          {
            error,
            userId: prepared.intent.actor.userId,
            signer,
            tokenId: payload.tokenId,
            orderHash: payload.orderHash,
          },
          "Polymarket submit-time on-chain confirmation failed",
        );
        status = POLYMARKET_UNCONFIRMED_STATUS;
      }
    } else {
      status = POLYMARKET_UNCONFIRMED_STATUS;
    }
  }
  return {
    venue: "polymarket",
    status: ["matched", "filled"].includes(status) ? "filled" : "submitted",
    venueOrderId,
    orderHash: payload.orderHash,
    txSignature: null,
    price: payload.price,
    size: payload.size,
    raw: { payload: upstream.payload, prepared: payload, status },
  };
}

export function createPolymarketTradingExecutionService(
  ctx: ApiTradingApplicationServiceInput,
): ApiVenueTradingExecutor {
  return {
    venue: "polymarket",
    capabilities: () => capabilities,
    getReadiness: (input) => getReadiness(ctx, input),
    quote: (input) => quote(ctx, input),
    prepareTrade: (input) =>
      prepareTrade(ctx, { intent: input.intent, quote: input.quote ?? null }),
    submitPreparedTrade: (input) => submitPreparedTrade(ctx, input.prepared),
    persistTrade: async (input) => {
      const payload = input.prepared
        ? parsePreparedPayload<PolymarketPreparedPayload>(
            input.prepared,
            "polymarket",
          )
        : null;
      if (!payload || !input.submitResult.venueOrderId) {
        throw tradingError({
          code: "trade_submission_failed",
          message: "Polymarket persistence requires a venue order id.",
          venue: "polymarket",
        });
      }
      const submitRawStatus = readString(
        isRecord(input.submitResult.raw) ? input.submitResult.raw.status : null,
      );
      const storedStatus =
        input.submitResult.status === "filled"
          ? "matched"
          : submitRawStatus === POLYMARKET_UNCONFIRMED_STATUS
            ? POLYMARKET_UNCONFIRMED_STATUS
            : "submitted";
      const stored = await storeOrder(ctx.pool, {
        userId: input.intent.actor.userId,
        walletAddress: payload.positionWalletAddress,
        signerAddress: input.intent.walletAddress,
        venue: "polymarket",
        venueOrderId: input.submitResult.venueOrderId,
        tokenId: payload.tokenId,
        side: "BUY",
        orderType: "FOK",
        price: payload.price,
        size: payload.size,
        status: storedStatus,
        errorMessage: null,
        rawError: null,
        orderPayload: payload.orderPayload,
        orderPayloadVersion: "v2",
        orderHash: payload.orderHash,
        feePolicySnapshot: payload.feePolicySnapshot,
        filledAt: input.submitResult.status === "filled" ? new Date() : null,
      });
      return {
        venue: "polymarket",
        orderId: stored.order.id,
        executionId: null,
        venueOrderId: stored.order.venue_order_id,
        status: stored.order.status,
        raw: {
          stored,
          tokenId: payload.tokenId,
          walletAddress: payload.positionWalletAddress,
        },
      };
    },
    applyTradeEffects: (input) => applyOrderTradeEffects(ctx, input),
  };
}
