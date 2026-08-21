import crypto from "node:crypto";
import type { Pool } from "@hunch/infra";
import { ethers } from "ethers";

import { AuthService } from "../auth.js";
import { env } from "../env.js";
import {
  assertFundingReservationReadyForTrade,
  releaseFundingReservationForDefinitiveTradeFailure,
} from "../funding/persistence/funding-evidence-repository.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import { buildFundingTradeConsumerIntent } from "../funding/persistence/funding-trade-consumer-intent.js";
import {
  markFundingTradeAttemptSubmissionStarted,
  recordFundingTradeAttemptOutcome,
} from "../funding/persistence/funding-trade-attempt-repository.js";
import { isRecord } from "../lib/type-guards.js";
import {
  normalizeLimitlessRawTokenId,
  normalizeLimitlessScopedTokenId,
} from "../lib/limitless-token.js";
import {
  expireStaleLimitlessFokOrders,
  fetchLimitlessFokExecutionRepairCandidates,
  fetchStoredOrderWalletContext,
  markLimitlessFokFilledFromStoredExecution,
  normalizeLimitlessFokOrderSizesForMarket,
  storeOrder,
  updateOrderFromHistory,
} from "../repos/orders-repo.js";
import {
  claimFundingTradeAttemptForVenueConsumer,
  claimTelegramAppHandoffV2DirectTradeSubmission,
  failTelegramAppHandoffV2DirectTradeSubmission,
  type TelegramAppHandoffV2DirectTradeBinding,
  type TelegramAppHandoffV2DirectTradeSubmission,
  type TelegramAppHandoffV2ScopeAssertion,
} from "../repos/telegram-app-handoff-v2-direct-trade-repository.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "./notifications.js";
import { tryRecordReferralFirstTradeConversion } from "./analytics-referrals.js";
import {
  executeServerEmbeddedEthereumTransaction,
  waitForEmbeddedEthereumTransactionReceipt,
} from "./embedded-ethereum.js";
import { toPublicFundingTradeError } from "./funding-trade-public-errors.js";
import {
  applyOptimisticPositionTradeOnce,
  reconcileExactPositionBalance,
} from "./positions-optimistic.js";
import { upsertLimitlessVenueShareAccrualFromOrderPayload } from "./limitless-fee-accruals.js";
import { recordLimitlessVolumeEvent } from "./limitless-volume-events.js";
import { syncLimitlessHistoryForWallet } from "./limitless-history.js";
import {
  LIMITLESS_CLOB_CHAIN_ID,
  LIMITLESS_CLOB_EIP712_NAME,
  LIMITLESS_CLOB_EIP712_VERSION,
  LIMITLESS_CLOB_ORDER_TYPES,
  quoteLimitlessAmmTrade,
} from "./limitless-trading-service.js";
import {
  fetchErc1155BalancesByOwner,
  fetchErc1155IsApprovedForAll,
  fetchEvmCode,
} from "./polygon-rpc.js";
import { fetchLimitlessOnchainSnapshot } from "./limitless-onchain.js";
import { isLimitlessAmmMarketMetadata } from "./limitless-market-mode.js";
import { buildLimitlessRedemptionPlan } from "./limitless-redemption-plan.js";
import { fetchConditionalTokensPayouts } from "./limitless-redemption.js";
import { recomputePositionMetricsForWallet } from "./positions-metrics.js";
import { venueLifecycleAllowsTradingAction } from "./venue-lifecycle.js";
import {
  amountUsd,
  applyOrderTradeEffects,
  assertServerEvmWalletAuthorization,
  bestAskForToken,
  buildTelegramTradeSourceMetadata,
  createCapability,
  createServerWalletClient,
  executePreparedTradeLifecycle,
  getPrivyWalletId,
  hasServerWalletClientConfig,
  isOrderable,
  loadMarketForVenue,
  normalizeSide,
  parsePreparedPayload,
  randomUint256SaltDecimal,
  readiness,
  readString,
  signEvmMessage,
  signEvmTypedData,
  toChecksumAddress,
  tokenForSide,
  tradingError,
  USDC_SCALE,
  verifyLinkedWallet,
  ZERO_ADDRESS,
  type PreparedPayloadBase,
} from "./api-trading-common.js";
import type {
  ApiTradingApplicationServiceInput,
  ApiVenueTradingExecutor,
} from "./api-trading-types.js";
import {
  buildLimitlessRequestAuthInputs,
  extractLimitlessPartnerAccountProfile,
  extractLimitlessPartnerAccountProfiles,
  extractLimitlessProfile,
  loadLimitlessProfileForWallet,
  resolveLimitlessAuthContext,
  type LimitlessProfile,
  verifyLimitlessAuthContext,
} from "./limitless-auth.js";
import {
  extractLimitlessMessage,
  isLimitlessPartnerHmacConfigured,
  limitlessRequest,
} from "./limitless-client.js";
import {
  isLimitlessClobDefinitiveNoFill,
  quoteLimitlessClobMarket,
} from "./limitless-clob-quote.js";
import {
  extractLimitlessExecutionFill,
  isLimitlessFokUnmatchedMessage,
  parseLimitlessOrderResult,
} from "./limitless-order-result.js";
import {
  deriveLimitlessSignedOrderSize,
  normalizeLimitlessMaybeRawAmount,
  normalizeLimitlessRawAmount,
} from "./limitless-order-normalization.js";
import {
  fetchOpenOrderCollateralLocks,
  fetchOpenOrderPositionLocks,
  normalizeCollateralWalletKey,
} from "./open-order-collateral.js";
import type {
  ApplyTradeEffectsInput,
  EnsureReadinessInput,
  EnsureReadinessResult,
  PersistedTrade,
  PreparedTrade,
  SubmitPreparedTradeInput,
  SubmitResult,
  TradeEffectsResult,
  TradeIntent,
  TradeQuote,
  TradeQuoteInput,
  TradingReadiness,
  TradingReadinessInput,
} from "./trading-types.js";

const LIMITLESS_CHAIN_ID = LIMITLESS_CLOB_CHAIN_ID;
const LIMITLESS_FOK_UNMATCHED_REASON = "market_order_unmatched";
const LIMITLESS_FOK_UNMATCHED_MESSAGE =
  "Order was not filled because no immediate match was available. Nothing was bought or sold. Try again or place a limit order.";
const LIMITLESS_AMM_DEFAULT_SLIPPAGE_BPS = 30;
const LIMITLESS_AMM_RECEIPT_WAIT_MS = 90_000;
const LIMITLESS_CONNECT_LOCK_PREFIX = "lock:limitless:connect:";
const LIMITLESS_CONNECT_STORED_PROFILE_POLL_DELAYS_MS = [
  100, 250, 500, 1_000,
] as const;
const LIMITLESS_LEGACY_OPERATOR_BY_EXCHANGE: Readonly<Record<string, string>> =
  {
    [normalizeAddress("0x5a38afc17F7E97ad8d6C547ddb837E40B4aEDfC6")]:
      "0xb8daa4c8c9f690396f671bb601727a4c3741340c",
  };

const LIMITLESS_AMM_IFACE = new ethers.Interface([
  "function buy(uint256 investmentAmount,uint256 outcomeIndex,uint256 minOutcomeTokens) returns (uint256)",
  "function sell(uint256 returnAmount,uint256 outcomeIndex,uint256 maxOutcomeTokens) returns (uint256)",
]);

const ERC20_IFACE = new ethers.Interface([
  "function approve(address spender,uint256 value) returns (bool)",
]);

type LimitlessClobPreparedPayload = PreparedPayloadBase & {
  clientOrderId: string;
  kind: "limitless";
  marketSlug: string;
  orderPayload: Record<string, unknown>;
  orderType: "FOK";
  ownerId: number;
  price: number | null;
  requestAuth: Record<string, unknown>;
  size: number | null;
  tokenId: string | null;
};

type LimitlessAmmPreparedPayload = PreparedPayloadBase & {
  kind: "limitless";
  allowanceRaw: string;
  amountUsd: number;
  amountUsdRaw: string;
  approvalAmountRaw: string;
  approvalRequired: boolean;
  marketAddress: string;
  minOutcomeTokensRaw: string;
  outcomeIndex: number;
  price: number | null;
  sharesRaw: string;
  size: number;
  tokenId: string;
  tradeType: "amm";
};

type LimitlessPreparedPayload =
  | LimitlessAmmPreparedPayload
  | LimitlessClobPreparedPayload;

type LimitlessRouteLogger = {
  debug?: (input: unknown, message?: string) => void;
  error?: (input: unknown, message?: string) => void;
  warn?: (input: unknown, message?: string) => void;
};

type LimitlessClientOrderBody = {
  marketSlug: string;
  order: Record<string, unknown>;
  orderType: "FOK" | "GTC";
  ownerId?: number | null;
  fundingOperationId?: string;
  fundingReservationId?: string;
  telegramAppHandoffId?: string;
  telegramAppHandoffPlanFingerprint?: string;
};

type LimitlessAmmQuoteQuery = {
  amountSharesRaw?: string | null;
  amountUsdRaw?: string | null;
  marketAddress: string;
  outcomeIndex: number;
  side: "BUY" | "SELL";
};

type LimitlessAccountQuery = {
  adapterSpender?: string | null;
  ammSpender?: string | null;
  clobSpender?: string | null;
  marketSlug?: string | null;
  negRiskSpender?: string | null;
  refresh?: boolean | null;
  tokenId?: string | null;
};

type LimitlessAllowanceSnapshot = {
  allowance: string;
  allowanceRaw: string;
  spender: string;
};

type LimitlessAccountPayload = {
  authMode?: string;
  chainId: 8453;
  conditionalTokens: {
    contractAddress: string;
    isApprovedForAll: Partial<
      Record<"adapter" | "amm" | "clob" | "negRisk", boolean>
    >;
    tokenBalance?: {
      balance: string;
      balanceRaw: string;
      tokenId: string;
    };
  };
  hasCredentials: boolean;
  ok: true;
  profile: Awaited<ReturnType<typeof loadLimitlessProfileForWallet>> | null;
  signer: string;
  signerIsContract: boolean;
  usdc: {
    allowance: Partial<
      Record<"amm" | "clob" | "negRisk", LimitlessAllowanceSnapshot>
    >;
    balance: string;
    balanceRaw: string;
    collateral?: {
      availableBalance: string;
      availableBalanceRaw: string;
      currency: "USDC";
      lockedBalance: string;
      lockedBalanceRaw: string;
      marketSlug: string;
      orderCount: null;
    };
    decimals: 6;
    tokenAddress: string;
  };
  venue: "limitless";
};

type LimitlessAccountCacheEntry = {
  expiresAt: number;
  value: LimitlessAccountPayload;
};

const limitlessAccountCache = new Map<string, LimitlessAccountCacheEntry>();
const limitlessAccountInflight = new Map<
  string,
  Promise<LimitlessAccountPayload>
>();

type LimitlessAmmOrderBody = {
  amountUsd?: number | null;
  marketSlug?: string | null;
  price?: number | null;
  side: "BUY" | "SELL";
  size: number;
  tokenId: string;
  txHash: string;
  fundingTradeAttemptId?: string;
};

type LimitlessAmmHandoffBroadcastBody = {
  marketSlug?: string | null;
  telegramAppHandoffId: string;
  telegramAppHandoffPlanFingerprint: string;
  tokenId: string;
  /** Fully signed EIP-155 transaction. It is never persisted or replayed. */
  signedTransaction: string;
};

type LimitlessAmmFundingClaimBody = {
  amountUsdRaw: string;
  fundingOperationId: string;
  fundingReservationId: string;
  idempotencyKey: string;
  marketAddress: string;
  marketSlug?: string | null;
  tokenId: string;
  telegramAppHandoffId?: string;
  telegramAppHandoffPlanFingerprint?: string;
  transactionData: string;
};

type LimitlessOpenOrdersQuery = {
  slug: string;
};

type LimitlessMarketExchangeQuery = {
  forceCanonical?: boolean | null;
  side?: "BUY" | "SELL" | null;
  slug: string;
};

type LimitlessRedemptionStatusQuery = {
  adapter?: string | null;
  conditionIds: string[];
};

type LimitlessRedemptionPlanQuery = {
  adapter?: string | null;
  conditionId: string;
  negRisk?: boolean | null;
  outcome: "YES" | "NO";
  tokenId: string;
};

type LimitlessConnectClientType = "eoa" | "base" | "etherspot";

type LimitlessHistoryQuery = {
  cursor?: string | null;
  limit: number;
  wallets?: string[] | undefined;
};

export type LimitlessConnectResult =
  | { ok: true; authMode: "partner_hmac"; profile: LimitlessProfile }
  | {
      ok: false;
      httpStatus: number;
      error: string;
      status?: number;
      payload?: unknown;
    };

export type LimitlessClientSignedOrderResult =
  | {
      ok: false;
      payload: Record<string, unknown>;
      statusCode: number;
    }
  | {
      ok: true;
      payload: {
        ok: boolean;
        orderId?: string;
        status?: string;
        referralFirstTrade?: unknown;
        payload: unknown;
        reason?: string;
        message?: string;
        executionStatus?: string;
      };
    };

export type LimitlessAmmQuoteRouteResult =
  | {
      ok: true;
      payload: Record<string, unknown>;
    }
  | {
      ok: false;
      payload: { error: string };
      statusCode: number;
    };

export type LimitlessAmmRecordRouteResult =
  | {
      ok: true;
      payload: {
        dbOrderId: string;
        onchainConfirmed?: boolean;
        ok: true;
        orderId: string;
        referralFirstTrade?: unknown;
        status?: string;
      };
    }
  | {
      ok: false;
      payload: { error: string };
      statusCode: number;
    };

export type LimitlessRouteOperationResult =
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
  venue: "limitless",
});

function mapLimitlessUpstreamStatus(status: number): number {
  if (status === 401 || status === 403) return 400;
  if (status >= 400 && status < 500) return status;
  return 502;
}

/**
 * These are the only client responses that prove the CLOB rejected the order
 * before it could create one. Timeout, conflict and throttling responses can
 * all be returned after a proxy/venue boundary and must remain reconcilable by
 * the deterministic client order ID.
 */
function isLimitlessClobDefinitiveClientRejection(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

function buildLimitlessOnBehalfHeaders(
  profile: { id?: number | null } | null | undefined,
): Record<string, string> | undefined {
  return profile?.id != null
    ? { "x-on-behalf-of": String(profile.id) }
    : undefined;
}

function buildLimitlessOnBehalfQueryPath(
  path: string,
  profile: { id?: number | null } | null | undefined,
): string {
  const ownerId = profile?.id;
  if (ownerId == null) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}onBehalfOf=${encodeURIComponent(String(ownerId))}`;
}

function isLimitlessAmbiguousAlreadyCancelledOrderMessage(
  message: string | null | undefined,
): boolean {
  const normalized = message?.trim().toLowerCase() ?? "";
  return (
    normalized === "order not found or already canceled" ||
    normalized === "order not found or already cancelled"
  );
}

async function resolveLimitlessRouteAuth(input: {
  userId: string;
  walletAddress: string;
}): Promise<
  | {
      ok: true;
      authContext: NonNullable<
        Awaited<ReturnType<typeof resolveLimitlessAuthContext>>
      >;
      profile: NonNullable<
        Awaited<ReturnType<typeof loadLimitlessProfileForWallet>>
      >;
      requestAuth: ReturnType<typeof buildLimitlessRequestAuthInputs>;
    }
  | { ok: false; payload: Record<string, unknown>; statusCode: number }
> {
  if (!isLimitlessPartnerHmacConfigured()) {
    return {
      ok: false,
      statusCode: 503,
      payload: { error: "Limitless is temporarily unavailable." },
    };
  }

  const creds = await AuthService.getVenueCredentials(
    input.userId,
    "limitless",
    input.walletAddress,
  );
  const authContext = await resolveLimitlessAuthContext(
    input.userId,
    input.walletAddress,
  );

  if (!authContext || !creds) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Connect Limitless for this wallet first." },
    };
  }

  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: input.walletAddress,
  });
  if (!verification.ok) {
    return {
      ok: false,
      statusCode: mapLimitlessUpstreamStatus(verification.status),
      payload: {
        error:
          verification.message ??
          "Limitless connection is invalid for the selected wallet.",
        status: verification.status,
        payload: verification.payload,
      },
    };
  }

  const profile = await loadLimitlessProfileForWallet({
    walletAddress: input.walletAddress,
    authContext,
    additionalData: creds.additionalData ?? null,
    baseProfile: verification.profile,
  });

  if (!profile?.id) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Limitless profile mapping is missing for this wallet.",
      },
    };
  }

  return {
    ok: true,
    authContext,
    profile,
    requestAuth: buildLimitlessRequestAuthInputs(authContext),
  };
}

export async function fetchLimitlessSigningMessageRoute(): Promise<LimitlessRouteOperationResult> {
  if (!isLimitlessPartnerHmacConfigured()) {
    return {
      ok: false,
      statusCode: 503,
      payload: { error: "Limitless is temporarily unavailable." },
    };
  }

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: "/auth/signing-message",
  });

  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless signing message failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const message = extractLimitlessMessage(upstream.payload);
  if (!message) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless signing message invalid",
        payload: upstream.payload,
      },
    };
  }

  return {
    ok: true,
    payload: { ok: true, message },
  };
}

async function persistLimitlessProfileForWallet(input: {
  account: string;
  profile: LimitlessProfile;
  signer: string;
  userId: string;
}) {
  await AuthService.createOrUpdateVenueCredentials(
    input.userId,
    input.signer,
    "limitless",
    input.account,
    "",
    { authMode: "partner_hmac", profile: input.profile },
  );
}

async function withLimitlessConnectAdvisoryLock<T>(input: {
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  run: () => Promise<T>;
  userId: string;
  walletAddress: string;
}): Promise<T> {
  const lockKey = `${LIMITLESS_CONNECT_LOCK_PREFIX}${input.userId.trim().toLowerCase()}:${normalizeAddress(input.walletAddress)}`;
  const client = await input.pool.connect();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock(hashtext($1)::bigint)", [
      lockKey,
    ]);
    locked = true;
    return await input.run();
  } finally {
    if (locked) {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [
          lockKey,
        ]);
      } catch (error) {
        input.log?.error?.(
          { error, lockKey },
          "Failed to release Limitless connect advisory lock",
        );
      }
    }
    client.release();
  }
}

function normalizeLimitlessProfileForAccount(input: {
  account: string;
  clientType: LimitlessConnectClientType;
  profile: LimitlessProfile | null;
}): LimitlessProfile | null {
  if (!input.profile?.id) return null;
  if (
    input.profile.account &&
    normalizeAddress(input.profile.account) !== normalizeAddress(input.account)
  ) {
    return null;
  }

  return {
    ...input.profile,
    account: input.profile.account ?? input.account,
    client: input.profile.client ?? input.clientType,
  };
}

export async function inspectLimitlessPartnerAccountProfile(input: {
  account: string;
  clientType: LimitlessConnectClientType;
}): Promise<{
  message: string | null;
  profile: LimitlessProfile | null;
  returnedNonMatchingAccount: boolean;
  status: number;
}> {
  const lookup = await limitlessRequest({
    method: "GET",
    requestPath: `/profiles/partner-accounts?account=${encodeURIComponent(
      input.account,
    )}`,
    auth: "partner_hmac",
  });

  if (!lookup.ok) {
    return {
      status: lookup.status,
      message: extractLimitlessMessage(lookup.payload),
      profile: null,
      returnedNonMatchingAccount: false,
    };
  }

  const matchingProfile = normalizeLimitlessProfileForAccount({
    profile: extractLimitlessPartnerAccountProfile(
      lookup.payload,
      input.account,
    ),
    account: input.account,
    clientType: input.clientType,
  });
  const requestedAccount = normalizeAddress(input.account);
  const returnedNonMatchingAccount = extractLimitlessPartnerAccountProfiles(
    lookup.payload,
  ).some(
    (profile) =>
      profile.account != null &&
      normalizeAddress(profile.account) !== requestedAccount,
  );

  return {
    status: 200,
    message: null,
    profile: matchingProfile,
    returnedNonMatchingAccount:
      matchingProfile == null && returnedNonMatchingAccount,
  };
}

async function loadStoredLimitlessProfileForAccount(input: {
  account: string;
  clientType: LimitlessConnectClientType;
  userId: string;
}): Promise<LimitlessProfile | null> {
  const authContext = await resolveLimitlessAuthContext(
    input.userId,
    input.account,
  );
  if (!authContext) return null;

  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: input.account,
  });
  if (!verification.ok) return null;

  return normalizeLimitlessProfileForAccount({
    profile: verification.profile ?? authContext.storedProfile,
    account: input.account,
    clientType: input.clientType,
  });
}

async function waitForStoredLimitlessProfileForAccount(input: {
  account: string;
  clientType: LimitlessConnectClientType;
  userId: string;
}): Promise<LimitlessProfile | null> {
  const immediate = await loadStoredLimitlessProfileForAccount(input);
  if (immediate) return immediate;

  for (const delayMs of LIMITLESS_CONNECT_STORED_PROFILE_POLL_DELAYS_MS) {
    await sleep(delayMs);
    const profile = await loadStoredLimitlessProfileForAccount(input);
    if (profile) return profile;
  }

  return null;
}

export async function connectLimitlessPartnerAccountRoute(input: {
  account: string;
  clientType: LimitlessConnectClientType;
  forceReconnect?: boolean;
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  signature: string;
  signer: string;
  signingMessage: string;
  userId: string;
}): Promise<LimitlessConnectResult> {
  const checksumAccount = toChecksumAddress(input.account);
  if (!checksumAccount) {
    return {
      ok: false,
      httpStatus: 400,
      error: "x-account is not a valid EVM address",
    };
  }

  return withLimitlessConnectAdvisoryLock({
    pool: input.pool,
    log: input.log,
    userId: input.userId,
    walletAddress: checksumAccount,
    run: async () => {
      const storedProfile = await loadStoredLimitlessProfileForAccount({
        userId: input.userId,
        account: checksumAccount,
        clientType: input.clientType,
      });
      if (storedProfile && !input.forceReconnect) {
        return {
          ok: true,
          authMode: "partner_hmac",
          profile: storedProfile,
        };
      }

      const persistAndReturnProfile = async (
        profile: LimitlessProfile,
        logMessage: string,
        clientError = "Failed to store recovered Limitless credentials",
      ): Promise<LimitlessConnectResult> => {
        try {
          await persistLimitlessProfileForWallet({
            userId: input.userId,
            signer: input.signer,
            account: profile.account ?? checksumAccount,
            profile,
          });
        } catch (error) {
          input.log?.error?.(
            { error, userId: input.userId, signer: input.signer },
            logMessage,
          );
          return {
            ok: false,
            httpStatus: 500,
            error: clientError,
          };
        }

        return {
          ok: true,
          authMode: "partner_hmac",
          profile,
        };
      };

      const encodedSigningMessage = encodeLimitlessSigningMessageHeader(
        input.signingMessage,
      );
      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/profiles/partner-accounts",
        auth: "partner_hmac",
        body: {
          displayName: checksumAccount,
        },
        headers: {
          "x-account": checksumAccount,
          "x-signing-message": encodedSigningMessage,
          "x-signature": input.signature,
        },
      });

      if (!upstream.ok) {
        if (upstream.status === 409) {
          const partnerAccountLookup =
            await inspectLimitlessPartnerAccountProfile({
              account: checksumAccount,
              clientType: input.clientType,
            });
          if (partnerAccountLookup.profile) {
            return persistAndReturnProfile(
              partnerAccountLookup.profile,
              "Failed to store recovered Limitless credentials from partner account lookup",
            );
          }

          const upstreamExistingProfile = normalizeLimitlessProfileForAccount({
            profile: extractLimitlessProfile(upstream.payload),
            account: checksumAccount,
            clientType: input.clientType,
          });
          if (upstreamExistingProfile) {
            return persistAndReturnProfile(
              upstreamExistingProfile,
              "Failed to store recovered Limitless credentials from 409 response",
            );
          }

          const storedAfterConflict = input.forceReconnect
            ? null
            : await waitForStoredLimitlessProfileForAccount({
                userId: input.userId,
                account: checksumAccount,
                clientType: input.clientType,
              });
          if (storedAfterConflict) {
            return {
              ok: true,
              authMode: "partner_hmac",
              profile: storedAfterConflict,
            };
          }

          const upstreamMessage = extractLimitlessMessage(upstream.payload);
          input.log?.warn?.(
            {
              userId: input.userId,
              signer: input.signer,
              account: checksumAccount,
              upstreamStatus: upstream.status,
              upstreamMessage,
              profileLookupStatus: partnerAccountLookup.status,
              profileLookupMessage: partnerAccountLookup.message,
              profileLookupReturnedNonMatchingAccount:
                partnerAccountLookup.returnedNonMatchingAccount,
            },
            "Limitless profile exists but profile id could not be recovered",
          );

          return {
            ok: false,
            httpStatus: 409,
            error:
              "Limitless profile already exists but profile id could not be recovered",
            status: upstream.status,
            payload: {
              code: "limitless_profile_exists_unrecoverable",
              upstream: {
                status: upstream.status,
                message: upstreamMessage,
              },
              profileLookup: {
                status: partnerAccountLookup.status,
                message: partnerAccountLookup.message,
              },
            },
          };
        }

        return {
          ok: false,
          httpStatus:
            upstream.status >= 400 && upstream.status < 500
              ? upstream.status
              : 502,
          error: "Limitless connect failed",
          status: upstream.status,
          payload: upstream.payload,
        };
      }

      const profileSafe = normalizeLimitlessProfileForAccount({
        profile: extractLimitlessProfile(upstream.payload),
        account: checksumAccount,
        clientType: input.clientType,
      });

      if (!profileSafe?.id) {
        return {
          ok: false,
          httpStatus: 502,
          error:
            "Limitless partner account creation did not return a profile id",
          payload: upstream.payload,
        };
      }

      return persistAndReturnProfile(
        profileSafe,
        "Failed to store Limitless credentials",
        "Failed to store Limitless credentials",
      );
    },
  });
}

async function resolveLimitlessWalletAddresses(input: {
  requestedWallets: string[] | undefined;
  userId: string;
  walletAddress: string | undefined;
}): Promise<string[]> {
  if (input.requestedWallets && input.requestedWallets.length) {
    const wallets = await AuthService.getUserWallets(input.userId);
    const walletMap = new Map(
      wallets.map((wallet) => [
        wallet.walletAddress.toLowerCase(),
        wallet.walletAddress,
      ]),
    );
    const resolved = input.requestedWallets
      .map((address) => address.trim().toLowerCase())
      .map((address) => walletMap.get(address))
      .filter((address): address is string => Boolean(address));
    return Array.from(new Set(resolved));
  }

  return input.walletAddress ? [input.walletAddress] : [];
}

function extractLimitlessOrderIdFromMessage(
  message: string | null,
): string | null {
  if (!message) return null;
  const match =
    message.match(
      /\border[_\s-]*id\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
    ) ??
    message.match(/order(?:Id| ID| id)?[:\s]+([a-zA-Z0-9_-]{6,})/) ??
    message.match(/([0-9a-fA-F-]{24,})/);
  return match?.[1] ?? null;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function encodeLimitlessSigningMessageHeader(value: string): string {
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return trimmed;
  }
  return `0x${Buffer.from(value, "utf8").toString("hex")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildLimitlessAccountCacheKey(inputs: {
  adapterSpender: string;
  ammSpender: string;
  clobSpender: string;
  credsUpdatedAt: string | null;
  includeSignerCode: boolean;
  marketSlug: string;
  negRiskSpender: string;
  signer: string;
  tokenId: string;
  userId: string;
}): string {
  return [
    inputs.userId,
    normalizeAddress(inputs.signer),
    normalizeAddress(inputs.clobSpender),
    normalizeAddress(inputs.negRiskSpender),
    normalizeAddress(inputs.adapterSpender),
    normalizeAddress(inputs.ammSpender),
    inputs.includeSignerCode ? "signer-code" : "binding-owned-eoa",
    inputs.marketSlug,
    inputs.tokenId,
    inputs.credsUpdatedAt ?? "none",
  ].join("|");
}

function readLimitlessAccountCache(
  key: string,
): LimitlessAccountPayload | null {
  if (env.limitlessAccountCacheTtlMs <= 0) return null;
  const entry = limitlessAccountCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    limitlessAccountCache.delete(key);
    return null;
  }
  return entry.value;
}

function writeLimitlessAccountCache(
  key: string,
  value: LimitlessAccountPayload,
) {
  if (env.limitlessAccountCacheTtlMs <= 0) return;
  limitlessAccountCache.set(key, {
    value,
    expiresAt: Date.now() + env.limitlessAccountCacheTtlMs,
  });
}

function stringifyLimitlessRawError(payload: unknown): string | null {
  if (payload == null) return null;
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

function normalizeLimitlessPrice(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const normalized = value > 1 ? value / 100 : value;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 1) {
    return null;
  }
  return normalized;
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

function extractLimitlessImmediateFill(
  payload: unknown,
  side: "BUY" | "SELL",
  fallback: { price: number | null; size: number | null },
): { notionalUsd: number; shares: number } | null {
  const executionFill = extractLimitlessExecutionFill(payload);
  if (executionFill) {
    return {
      notionalUsd: executionFill.notionalUsd,
      shares: executionFill.shares,
    };
  }
  const record = isRecord(payload)
    ? isRecord(payload.order)
      ? payload.order
      : payload
    : null;
  if (!record) return null;

  const outcomeShares = normalizeLimitlessMaybeRawAmount(
    record.outcomeTokenAmount ??
      record.outcome_token_amount ??
      record.size ??
      record.amount ??
      record.quantity,
  );
  const sideAmountRaw = parseNumberish(
    side === "BUY" ? record.takerAmount : record.makerAmount,
  );
  const sideShares =
    side === "BUY" && sideAmountRaw != null && sideAmountRaw <= 1
      ? null
      : normalizeLimitlessRawAmount(sideAmountRaw);
  const sharesCandidates = [outcomeShares, fallback.size, sideShares];
  const shares = sharesCandidates.find(
    (value): value is number =>
      value != null && Number.isFinite(value) && value > 0,
  );
  if (shares == null) return null;

  const priceCandidates = [
    normalizeLimitlessPrice(
      parseNumberish(
        record.price ??
          record.orderPrice ??
          record.limitPrice ??
          record.outcomeTokenPrice ??
          record.outcome_token_price,
      ),
    ),
    normalizeLimitlessPrice(fallback.price),
  ];
  const unitPrice =
    priceCandidates.find(
      (value): value is number =>
        value != null && Number.isFinite(value) && value > 0,
    ) ?? null;

  const notionalCandidates = [
    normalizeLimitlessMaybeRawAmount(
      record.collateralAmount ?? record.collateral_amount,
    ),
    normalizeLimitlessRawAmount(
      parseNumberish(side === "BUY" ? record.makerAmount : record.takerAmount),
    ),
    unitPrice != null ? unitPrice * shares : null,
  ];
  const notionalUsd =
    notionalCandidates.find(
      (value): value is number =>
        value != null && Number.isFinite(value) && value > 0,
    ) ?? null;

  if (notionalUsd == null) return null;
  return { shares, notionalUsd };
}

function isLimitlessTerminalFillStatus(status: string): boolean {
  return status === "filled" || status === "matched";
}

function normalizeOrderSide(value: unknown): "BUY" | "SELL" | null {
  if (typeof value === "string") {
    const trimmed = value.trim().toUpperCase();
    if (trimmed === "BUY" || trimmed === "SELL") return trimmed;
    if (trimmed === "0") return "BUY";
    if (trimmed === "1") return "SELL";
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return "BUY";
    if (value === 1) return "SELL";
  }
  return null;
}

function readOrderField(
  record: Record<string, unknown>,
  keys: string[],
): unknown | null {
  for (const key of keys) {
    if (record[key] != null) return record[key];
  }
  if (isRecord(record.order)) {
    for (const key of keys) {
      if (record.order[key] != null) return record.order[key];
    }
  }
  return null;
}

function normalizeOrderId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString();
  }
  return null;
}

export function extractLimitlessOrders(
  payload: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (isRecord(payload)) {
    const collection =
      payload.orders ?? payload.data ?? payload.items ?? payload.results;
    if (Array.isArray(collection)) {
      return collection.filter(isRecord);
    }
    if (isRecord(collection)) {
      return [collection];
    }
    if (payload.id || payload.orderId || payload.order_id) {
      return [payload];
    }
  }
  return [];
}

export function extractLimitlessOrderId(
  record: Record<string, unknown>,
): string | null {
  return normalizeOrderId(
    readOrderField(record, ["id", "orderId", "order_id"]),
  );
}

export function extractLimitlessTokenId(
  record: Record<string, unknown>,
): string | null {
  const raw = normalizeOrderId(
    readOrderField(record, ["tokenId", "token_id", "outcomeTokenId"]),
  );
  return normalizeLimitlessScopedTokenId(raw);
}

export function extractLimitlessOrderSide(
  record: Record<string, unknown>,
): "BUY" | "SELL" | null {
  return normalizeOrderSide(readOrderField(record, ["side", "orderSide"]));
}

export function extractLimitlessOrderType(
  record: Record<string, unknown>,
): "GTC" | "FOK" | null {
  const value = readOrderField(record, ["orderType", "type"]);
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (upper === "GTC" || upper === "FOK") return upper;
  }
  return null;
}

export function extractLimitlessOrderStatus(
  record: Record<string, unknown>,
): string {
  const value = readOrderField(record, ["status", "orderStatus"]);
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === "open" ||
      normalized === "active" ||
      normalized === "live"
    ) {
      return "live";
    }
    if (normalized === "cancelled" || normalized === "canceled") {
      return "cancelled";
    }
    if (normalized === "filled" || normalized === "complete") {
      return "filled";
    }
    return normalized;
  }
  return "live";
}

export function extractLimitlessOrderPrice(
  record: Record<string, unknown>,
): number | null {
  const value = readOrderField(record, [
    "price",
    "orderPrice",
    "limitPrice",
    "outcomeTokenPrice",
    "outcome_token_price",
  ]);
  return parseNumberish(value);
}

export function extractLimitlessOrderSize(
  record: Record<string, unknown>,
): number | null {
  const value = readOrderField(record, [
    "size",
    "orderSize",
    "amount",
    "shares",
    "quantity",
    "outcomeAmount",
    "outcome_amount",
  ]);
  return parseNumberish(value);
}

export function extractLimitlessCanceledIds(
  payload: unknown,
  fallback: string[],
): string[] {
  if (!isRecord(payload)) return fallback;
  const candidates =
    payload.canceled ??
    payload.cancelled ??
    payload.canceledOrders ??
    payload.cancelledOrders;
  if (!Array.isArray(candidates)) return fallback;
  const ids = candidates
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      if (isRecord(entry)) {
        return normalizeOrderId(
          entry.orderId ?? entry.order_id ?? entry.id ?? null,
        );
      }
      return null;
    })
    .filter((entry): entry is string => Boolean(entry));
  return ids.length ? ids : fallback;
}

export async function repairLimitlessFokOrdersFromStoredExecution(input: {
  pool: ApiTradingApplicationServiceInput["pool"];
  userId: string;
  walletAddress: string;
  marketSlug: string;
  limit?: number;
}): Promise<number> {
  const candidates = await fetchLimitlessFokExecutionRepairCandidates(
    input.pool,
    {
      userId: input.userId,
      walletAddress: input.walletAddress,
      marketSlug: input.marketSlug,
      limit: input.limit ?? 100,
    },
  );
  const repairedAt = new Date();
  let repaired = 0;

  for (const candidate of candidates) {
    const parsed = parseLimitlessOrderResult(candidate.upstreamPayload);
    if (!parsed.terminalFill) continue;
    const executionFill = extractLimitlessExecutionFill(
      candidate.upstreamPayload,
    );
    if (!executionFill) continue;
    const updated = await markLimitlessFokFilledFromStoredExecution(
      input.pool,
      {
        id: candidate.id,
        price: executionFill.averagePrice,
        size: executionFill.shares,
        filledAt: repairedAt,
        orderHash: parsed.txHash ?? candidate.orderHash,
      },
    );
    if (updated) repaired += 1;
  }

  return repaired;
}

export async function syncLimitlessOpenOrdersRoute(input: {
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  query: LimitlessOpenOrdersQuery;
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  const partnerAuth = await resolveLimitlessRouteAuth({
    userId: input.userId,
    walletAddress: input.signer,
  });
  if (!partnerAuth.ok) return partnerAuth;
  const { profile, requestAuth } = partnerAuth;
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(input.query.slug)}/user-orders`,
    ...requestAuth,
    headers: buildLimitlessOnBehalfHeaders(profile),
  });

  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless orders sync failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const ordersRaw = extractLimitlessOrders(upstream.payload);
  let storedNew = 0;
  let alreadyKnown = 0;
  let skippedNoId = 0;
  const orderIds: string[] = [];

  for (const order of ordersRaw) {
    const venueOrderId = extractLimitlessOrderId(order);
    if (!venueOrderId) {
      skippedNoId += 1;
      continue;
    }
    orderIds.push(venueOrderId);

    const tokenId = extractLimitlessTokenId(order);
    const side = extractLimitlessOrderSide(order);
    const orderType = extractLimitlessOrderType(order);
    const status = extractLimitlessOrderStatus(order);
    const price = extractLimitlessOrderPrice(order);
    const size = extractLimitlessOrderSize(order);

    const result = await storeOrder(input.pool, {
      userId: input.userId,
      walletAddress: input.signer,
      signerAddress: input.signer,
      venue: "limitless",
      venueOrderId,
      tokenId: tokenId ?? null,
      side,
      orderType: orderType ?? undefined,
      price,
      size,
      status,
      errorMessage: null,
      rawError: null,
      orderPayload: order,
    });

    if (result.kind === "stored") storedNew += 1;
    if (result.kind === "exists") alreadyKnown += 1;
  }

  const normalizedFokSizes = await normalizeLimitlessFokOrderSizesForMarket(
    input.pool,
    {
      userId: input.userId,
      walletAddress: input.signer,
      marketSlug: input.query.slug,
    },
  );
  let historyStats: Awaited<
    ReturnType<typeof syncLimitlessHistoryForWallet>
  > | null = null;
  let historyError: string | null = null;
  let repairedStoredFok = 0;
  let repairError: string | null = null;
  let expiredStaleFok = 0;
  let metricsError: string | null = null;

  try {
    historyStats = await syncLimitlessHistoryForWallet(input.pool, {
      userId: input.userId,
      walletAddress: input.signer,
      authContext: partnerAuth.authContext,
      limit: 100,
    });
  } catch (error) {
    historyError =
      error instanceof Error ? error.message : "Limitless history sync failed.";
    input.log?.warn?.(
      {
        error,
        userId: input.userId,
        walletAddress: input.signer,
        marketSlug: input.query.slug,
      },
      "Limitless order history sync failed during order sync",
    );
  }

  try {
    repairedStoredFok = await repairLimitlessFokOrdersFromStoredExecution({
      pool: input.pool,
      userId: input.userId,
      walletAddress: input.signer,
      marketSlug: input.query.slug,
      limit: 100,
    });
    expiredStaleFok = await expireStaleLimitlessFokOrders(input.pool, {
      userId: input.userId,
      walletAddress: input.signer,
      marketSlug: input.query.slug,
      activeVenueOrderIds: orderIds,
    });
  } catch (error) {
    repairError =
      error instanceof Error
        ? error.message
        : "Limitless stored FOK repair failed.";
    input.log?.warn?.(
      {
        error,
        userId: input.userId,
        walletAddress: input.signer,
        marketSlug: input.query.slug,
      },
      "Limitless stored FOK repair failed during order sync",
    );
  }

  if (historyStats || repairedStoredFok > 0 || expiredStaleFok > 0) {
    try {
      await recomputePositionMetricsForWallet(input.pool, {
        userId: input.userId,
        walletAddress: input.signer,
        venue: "limitless",
      });
    } catch (error) {
      metricsError =
        error instanceof Error
          ? error.message
          : "Limitless position metrics update failed.";
      input.log?.error?.(
        { error, userId: input.userId, walletAddress: input.signer },
        "Limitless position metrics update failed during order sync",
      );
    }
  }

  return {
    ok: true,
    payload: {
      ok: true,
      venue: "limitless",
      walletAddress: input.signer,
      fetched: ordersRaw.length,
      storedNew,
      alreadyKnown,
      skippedNoId,
      normalizedFokSizes,
      repairedStoredFok,
      repairError,
      expiredStaleFok,
      history: historyStats,
      historyError,
      metricsError,
      sampleVenueOrderIds: orderIds.slice(0, 10),
    },
  };
}

export async function syncLimitlessOrderHistoryRoute(input: {
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  query: LimitlessHistoryQuery;
  signer: string | undefined;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  const walletAddresses = await resolveLimitlessWalletAddresses({
    userId: input.userId,
    walletAddress: input.signer,
    requestedWallets: input.query.wallets,
  });

  if (walletAddresses.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "No wallets available to sync." },
    };
  }

  const results: Array<{
    walletAddress: string;
    status: "ok" | "error" | "skipped";
    fetched?: number;
    nextCursor?: string | null;
    storedNew?: number;
    alreadyKnown?: number;
    skippedNoId?: number;
    skippedNoSide?: number;
    skippedNoOutcome?: number;
    skippedNoMarket?: number;
    skippedNoToken?: number;
    error?: string;
    sampleVenueOrderIds?: string[];
  }> = [];

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  for (const wallet of walletAddresses) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
      skipped += 1;
      results.push({
        walletAddress: wallet,
        status: "skipped",
        error: "EVM wallet required for Limitless.",
      });
      continue;
    }

    if (!isLimitlessPartnerHmacConfigured()) {
      errors += 1;
      results.push({
        walletAddress: wallet,
        status: "error",
        error: "Limitless is temporarily unavailable.",
      });
      continue;
    }

    const authContext = await resolveLimitlessAuthContext(input.userId, wallet);
    if (!authContext) {
      errors += 1;
      results.push({
        walletAddress: wallet,
        status: "error",
        error: "Connect Limitless for this wallet before syncing history.",
      });
      continue;
    }

    const verification = await verifyLimitlessAuthContext({
      authContext,
      walletAddress: wallet,
    });
    if (!verification.ok) {
      errors += 1;
      results.push({
        walletAddress: wallet,
        status: "error",
        error:
          verification.message ??
          "Limitless connection is invalid for this wallet.",
      });
      continue;
    }

    let stats;
    try {
      stats = await syncLimitlessHistoryForWallet(input.pool, {
        userId: input.userId,
        walletAddress: wallet,
        authContext,
        limit: input.query.limit,
        cursor: input.query.cursor ?? undefined,
      });
    } catch (error) {
      errors += 1;
      results.push({
        walletAddress: wallet,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Limitless history sync failed.",
      });
      continue;
    }

    try {
      await recomputePositionMetricsForWallet(input.pool, {
        userId: input.userId,
        walletAddress: wallet,
        venue: "limitless",
      });
    } catch (error) {
      input.log?.error?.(
        { error, userId: input.userId, walletAddress: wallet },
        "Limitless position metrics update failed",
      );
    }

    synced += 1;
    results.push({
      walletAddress: wallet,
      status: "ok",
      fetched: stats.fetched,
      nextCursor: stats.nextCursor,
      storedNew: stats.storedNew,
      alreadyKnown: stats.alreadyKnown,
      skippedNoId: stats.skippedNoId,
      skippedNoSide: stats.skippedNoSide,
      skippedNoOutcome: stats.skippedNoOutcome,
      skippedNoMarket: stats.skippedNoMarket,
      skippedNoToken: stats.skippedNoToken,
      sampleVenueOrderIds: stats.sampleVenueOrderIds,
    });
  }

  return {
    ok: true,
    payload: {
      ok: true,
      venue: "limitless",
      limit: input.query.limit,
      cursor: input.query.cursor ?? null,
      results,
      summary: {
        synced,
        skipped,
        errors,
      },
    },
  };
}

export async function fetchLimitlessAccountRoute(input: {
  db?: Pick<Pool, "query">;
  includeSignerCode?: boolean;
  log?: LimitlessRouteLogger | null;
  query: LimitlessAccountQuery;
  signerRaw: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  if (!isEvmWallet(input.signerRaw)) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Limitless account snapshot requires an EVM wallet address",
      },
    };
  }
  const signer = toChecksumAddress(input.signerRaw);
  if (!signer) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Limitless account snapshot requires a valid EVM wallet address",
      },
    };
  }

  const creds = await AuthService.getVenueCredentials(
    input.userId,
    "limitless",
    input.signerRaw,
  );
  const authContext = await resolveLimitlessAuthContext(
    input.userId,
    input.signerRaw,
  );
  const credsUpdatedAtValue =
    creds?.updatedAt instanceof Date
      ? creds.updatedAt.toISOString()
      : (creds?.updatedAt ?? null);
  const refresh = input.query.refresh === true;
  let hasCredentials =
    Boolean(creds) &&
    Boolean(authContext) &&
    isLimitlessPartnerHmacConfigured();
  let verifiedProfileBase: Awaited<
    ReturnType<typeof loadLimitlessProfileForWallet>
  > | null = null;

  const clobSpender = input.query.clobSpender ?? env.limitlessClobAddress;
  const negRiskSpender =
    input.query.negRiskSpender ?? env.limitlessNegRiskAddress;
  const adapterSpender = input.query.adapterSpender ?? null;
  const ammSpender = input.query.ammSpender ?? null;
  const tokenId = normalizeLimitlessRawTokenId(input.query.tokenId);
  const marketSlug = input.query.marketSlug?.trim() || null;
  const includeSignerCode = input.includeSignerCode !== false;

  const cacheEnabled = !refresh && env.limitlessAccountCacheTtlMs > 0;
  const cacheKey = buildLimitlessAccountCacheKey({
    userId: input.userId,
    signer,
    clobSpender: clobSpender ?? "none",
    negRiskSpender: negRiskSpender ?? "none",
    adapterSpender: adapterSpender ?? "none",
    ammSpender: ammSpender ?? "none",
    includeSignerCode,
    marketSlug: marketSlug ?? "none",
    tokenId: tokenId ?? "none",
    credsUpdatedAt: credsUpdatedAtValue,
  });

  if (cacheEnabled) {
    const cached = readLimitlessAccountCache(cacheKey);
    if (cached) return { ok: true, payload: cached };
  }
  const inflight = limitlessAccountInflight.get(cacheKey);
  if (inflight) {
    try {
      const payload = await inflight;
      return { ok: true, payload };
    } catch (error) {
      input.log?.error?.(
        { error, userId: input.userId, signer },
        "Failed to fetch shared Limitless account snapshot",
      );
      return {
        ok: false,
        statusCode: 502,
        payload: { error: "Failed to fetch Limitless account snapshot" },
      };
    }
  }

  if (hasCredentials && authContext) {
    const verification = await verifyLimitlessAuthContext({
      authContext,
      walletAddress: signer,
    });
    hasCredentials = verification.ok;
    if (verification.ok) {
      verifiedProfileBase = verification.profile;
    }
  }

  try {
    const conditionalTokensAddress = env.limitlessConditionalTokensAddress;
    const computePromise = (async (): Promise<LimitlessAccountPayload> => {
      const [code, snapshot, tokenBalanceMap, liveProfile, collateralLocks] =
        await Promise.all([
          includeSignerCode
            ? fetchEvmCode({
                rpcUrl: env.baseRpcUrl,
                timeoutMs: env.baseRpcTimeoutMs,
                address: signer,
              })
            : Promise.resolve("0x"),
          fetchLimitlessOnchainSnapshot({
            rpcUrl: env.baseRpcUrl,
            timeoutMs: env.baseRpcTimeoutMs,
            owner: signer,
            clobAddress: clobSpender,
            negRiskAddress: negRiskSpender,
            adapterAddress: adapterSpender,
            ammAddress: ammSpender,
            conditionalTokensAddress,
          }),
          tokenId
            ? fetchErc1155BalancesByOwner({
                rpcUrl: env.baseRpcUrl,
                timeoutMs: env.baseRpcTimeoutMs,
                contractAddress: conditionalTokensAddress,
                owner: signer,
                tokenIds: [tokenId],
              })
            : Promise.resolve(null),
          hasCredentials && authContext
            ? loadLimitlessProfileForWallet({
                walletAddress: signer,
                authContext,
                additionalData: creds?.additionalData ?? null,
                baseProfile: verifiedProfileBase,
              })
            : Promise.resolve(null),
          marketSlug && input.db
            ? fetchOpenOrderCollateralLocks(input.db, {
                userId: input.userId,
                polymarketWallets: [],
                limitlessWallets: [signer],
              })
            : Promise.resolve(null),
        ]);

      const usdcBalance = snapshot.usdcBalance;
      const allowanceClob = snapshot.allowanceClob;
      const allowanceNegRisk = snapshot.allowanceNegRisk;
      const allowanceAmm = snapshot.allowanceAmm;
      const tokenBalanceRaw =
        tokenId && tokenBalanceMap
          ? (tokenBalanceMap.get(tokenId) ?? 0n)
          : null;
      const isContract = typeof code === "string" && code.length > 2;
      const lockedCollateralRaw =
        collateralLocks == null
          ? null
          : (collateralLocks.limitless.get(
              normalizeCollateralWalletKey(signer),
            ) ?? 0n);
      const availableCollateralRaw =
        lockedCollateralRaw == null
          ? null
          : usdcBalance > lockedCollateralRaw
            ? usdcBalance - lockedCollateralRaw
            : 0n;

      return {
        ok: true,
        venue: "limitless",
        chainId: 8453,
        signer,
        signerIsContract: isContract,
        usdc: {
          tokenAddress: env.limitlessUsdcAddress,
          decimals: 6,
          balance: ethers.formatUnits(usdcBalance, 6),
          balanceRaw: usdcBalance.toString(),
          ...(marketSlug &&
          lockedCollateralRaw != null &&
          availableCollateralRaw != null
            ? {
                collateral: {
                  marketSlug,
                  availableBalance: ethers.formatUnits(
                    availableCollateralRaw,
                    6,
                  ),
                  availableBalanceRaw: availableCollateralRaw.toString(),
                  lockedBalance: ethers.formatUnits(lockedCollateralRaw, 6),
                  lockedBalanceRaw: lockedCollateralRaw.toString(),
                  orderCount: null,
                  currency: "USDC",
                },
              }
            : {}),
          allowance: {
            ...(clobSpender
              ? {
                  clob: {
                    spender: clobSpender,
                    allowance: ethers.formatUnits(allowanceClob ?? 0n, 6),
                    allowanceRaw: (allowanceClob ?? 0n).toString(),
                  },
                }
              : {}),
            ...(negRiskSpender
              ? {
                  negRisk: {
                    spender: negRiskSpender,
                    allowance: ethers.formatUnits(allowanceNegRisk ?? 0n, 6),
                    allowanceRaw: (allowanceNegRisk ?? 0n).toString(),
                  },
                }
              : {}),
            ...(ammSpender
              ? {
                  amm: {
                    spender: ammSpender,
                    allowance: ethers.formatUnits(allowanceAmm ?? 0n, 6),
                    allowanceRaw: (allowanceAmm ?? 0n).toString(),
                  },
                }
              : {}),
          },
        },
        conditionalTokens: {
          contractAddress: conditionalTokensAddress,
          ...(tokenId
            ? {
                tokenBalance: {
                  tokenId,
                  balance: ethers.formatUnits(tokenBalanceRaw ?? 0n, 6),
                  balanceRaw: (tokenBalanceRaw ?? 0n).toString(),
                },
              }
            : {}),
          isApprovedForAll: {
            ...(clobSpender ? { clob: snapshot.approvedClob ?? false } : {}),
            ...(negRiskSpender
              ? { negRisk: snapshot.approvedNegRisk ?? false }
              : {}),
            ...(adapterSpender
              ? { adapter: snapshot.approvedAdapter ?? false }
              : {}),
            ...(ammSpender ? { amm: snapshot.approvedAmm ?? false } : {}),
          },
        },
        profile: liveProfile ?? null,
        hasCredentials,
        ...(authContext?.authMode ? { authMode: authContext.authMode } : {}),
      };
    })();

    limitlessAccountInflight.set(cacheKey, computePromise);
    try {
      const payload = await computePromise;
      writeLimitlessAccountCache(cacheKey, payload);
      return { ok: true, payload };
    } finally {
      limitlessAccountInflight.delete(cacheKey);
    }
  } catch (error) {
    input.log?.error?.(
      { error, userId: input.userId, signer },
      "Failed to fetch Limitless account snapshot",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Failed to fetch Limitless account snapshot" },
    };
  }
}

function isBytes32(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

export async function fetchLimitlessRedemptionStatusRoute(input: {
  log?: LimitlessRouteLogger | null;
  query: LimitlessRedemptionStatusQuery;
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  if (!isEvmWallet(input.signer)) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Limitless redemption requires an EVM wallet address" },
    };
  }

  const conditionIds = input.query.conditionIds
    .map((value) => value.trim())
    .filter((value) => isBytes32(value));

  if (conditionIds.length === 0) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "No valid conditionIds provided." },
    };
  }

  const adapter =
    typeof input.query.adapter === "string" ? input.query.adapter.trim() : null;

  try {
    const [payouts, adapterApproved] = await Promise.all([
      fetchConditionalTokensPayouts({ conditionIds }),
      adapter && isEvmWallet(adapter)
        ? fetchErc1155IsApprovedForAll({
            rpcUrl: env.baseRpcUrl,
            timeoutMs: env.baseRpcTimeoutMs,
            contractAddress: env.limitlessConditionalTokensAddress,
            owner: input.signer,
            operator: adapter,
          })
        : Promise.resolve(null),
    ]);

    return {
      ok: true,
      payload: {
        ok: true,
        venue: "limitless",
        signer: input.signer,
        conditionalTokens: {
          contractAddress: env.limitlessConditionalTokensAddress,
        },
        adapter: adapter ?? null,
        adapterApproved,
        conditions: payouts,
      },
    };
  } catch (error) {
    input.log?.error?.(
      { error, userId: input.userId, signer: input.signer },
      "Failed to fetch Limitless redemption status",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Failed to fetch Limitless redemption status" },
    };
  }
}

export async function buildLimitlessRedemptionPlanRoute(input: {
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  query: LimitlessRedemptionPlanQuery;
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  if (
    !(await venueLifecycleAllowsTradingAction(
      input.pool,
      "limitless",
      "REDEEM",
    ))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Limitless redemption is temporarily disabled" },
    };
  }
  if (!isEvmWallet(input.signer)) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Limitless redemption requires an EVM wallet address" },
    };
  }

  try {
    const plan = await buildLimitlessRedemptionPlan({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      owner: input.signer,
      conditionId: input.query.conditionId,
      tokenId: input.query.tokenId,
      outcome: input.query.outcome,
      isNegRisk: input.query.negRisk === true,
      adapterAddress: input.query.adapter ?? null,
    });
    return { ok: true, payload: plan };
  } catch (error) {
    input.log?.error?.(
      {
        error,
        userId: input.userId,
        signer: input.signer,
        tokenId: input.query.tokenId,
        conditionId: input.query.conditionId,
        outcome: input.query.outcome,
      },
      "Failed to build Limitless redemption plan",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: { error: "Failed to prepare Limitless redemption" },
    };
  }
}

export async function fetchLimitlessMarketExchangeRoute(input: {
  log?: LimitlessRouteLogger | null;
  query: LimitlessMarketExchangeQuery;
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  const authContext = await resolveLimitlessAuthContext(
    input.userId,
    input.signer,
  );
  const requestAuth =
    authContext && isLimitlessPartnerHmacConfigured()
      ? buildLimitlessRequestAuthInputs(authContext)
      : {};

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(input.query.slug)}`,
    ...requestAuth,
  });

  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless market exchange fetch failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const exchangeAddress = extractLimitlessMarketExchangeAddress(
    upstream.payload,
  );
  const adapterAddress = extractLimitlessMarketAdapterAddress(upstream.payload);
  let canonicalExchangeAddress = exchangeAddress;
  let canonicalAdapterAddress = adapterAddress;

  if (
    (input.query.forceCanonical || !exchangeAddress) &&
    authContext &&
    isEvmWallet(input.signer)
  ) {
    const signerChecksum = toChecksumAddress(input.signer);
    const tokenPair = extractLimitlessTokenPair(upstream.payload);
    const probeTokenId = tokenPair?.tokenYes ?? tokenPair?.tokenNo ?? null;
    const profile = await loadLimitlessProfileForWallet({
      walletAddress: input.signer,
      authContext,
      additionalData: authContext.creds.additionalData ?? null,
    });
    const ownerId = profile?.id;

    if (signerChecksum && ownerId && probeTokenId) {
      const probeSide = input.query.side === "SELL" ? 1 : 0;
      try {
        const probe = await limitlessRequest({
          method: "POST",
          requestPath: "/orders",
          ...requestAuth,
          body: {
            order: {
              salt: Date.now() * 1000,
              maker: signerChecksum,
              signer: signerChecksum,
              taker: ZERO_ADDRESS,
              tokenId: probeTokenId,
              makerAmount: 1_000_000,
              takerAmount: 1,
              expiration: "0",
              nonce: 0,
              feeRateBps: 300,
              side: probeSide,
              signatureType: 0,
              signature: `0x${"0".repeat(130)}`,
            },
            orderType: "FOK",
            marketSlug: input.query.slug,
            ownerId,
            onBehalfOf: ownerId,
          },
        });
        if (!probe.ok) {
          const probedExchange = extractLimitlessExpectedExchangeAddress(
            probe.payload,
          );
          if (probedExchange) {
            canonicalExchangeAddress = probedExchange;
          }
        }
      } catch (error) {
        input.log?.warn?.(
          { error, slug: input.query.slug },
          "Limitless canonical exchange probe failed",
        );
      }
    }
  }

  if (!canonicalAdapterAddress) {
    canonicalAdapterAddress = resolveLimitlessLegacyOperatorForExchange(
      canonicalExchangeAddress ?? exchangeAddress ?? null,
    );
  }

  return {
    ok: true,
    payload: {
      ok: true,
      marketSlug: input.query.slug,
      exchangeAddress: canonicalExchangeAddress,
      adapterAddress: canonicalAdapterAddress,
    },
  };
}

export async function resolveLimitlessEmbeddedOrderSigningContext(input: {
  marketSlug: string;
  ownerId: number;
  payload: { side: string | number; tokenId: string | number | bigint };
  pool: ApiTradingApplicationServiceInput["pool"];
  requestAuth: Record<string, unknown>;
  signer: string;
}): Promise<{ exchangeAddress: string }> {
  const marketSlug = input.marketSlug.trim();
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(marketSlug)}`,
    ...(input.requestAuth as object),
  });

  if (!upstream.ok) {
    throw Object.assign(new Error("Limitless market exchange fetch failed"), {
      responseStatus: 502,
      responsePayload: {
        status: upstream.status,
        payload: upstream.payload,
      },
    });
  }

  const tokenId = normalizeLimitlessRawTokenId(input.payload.tokenId);
  if (!tokenId) {
    throw new Error("Embedded Limitless order token is invalid.");
  }

  const tokenPair =
    extractLimitlessTokenPair(upstream.payload) ??
    (await resolveLimitlessTokenPairForSlug({
      pool: input.pool,
      slug: marketSlug,
      requestAuth: input.requestAuth,
    }));
  if (!tokenPair?.tokenYes && !tokenPair?.tokenNo) {
    throw new Error("Unable to resolve Limitless market tokens.");
  }
  if (tokenId !== tokenPair.tokenYes && tokenId !== tokenPair.tokenNo) {
    throw new Error(
      "Embedded Limitless order token does not belong to this market.",
    );
  }

  const exchangeAddress = extractLimitlessMarketExchangeAddress(
    upstream.payload,
  );
  if (!exchangeAddress) {
    throw new Error("Unable to resolve Limitless exchange for this market.");
  }

  let canonicalExchangeAddress = exchangeAddress;
  const probeTokenId = tokenPair.tokenYes ?? tokenPair.tokenNo ?? tokenId;
  const signerChecksum = toChecksumAddress(input.signer);
  if (signerChecksum && input.ownerId && probeTokenId) {
    const probeSide = Number(input.payload.side) === 1 ? 1 : 0;
    try {
      const probe = await limitlessRequest({
        method: "POST",
        requestPath: "/orders",
        ...(input.requestAuth as object),
        body: {
          order: {
            salt: Date.now() * 1000,
            maker: signerChecksum,
            signer: signerChecksum,
            taker: ZERO_ADDRESS,
            tokenId: probeTokenId,
            makerAmount: 1_000_000,
            takerAmount: 1,
            expiration: "0",
            nonce: 0,
            feeRateBps: 300,
            side: probeSide,
            signatureType: 0,
            signature: `0x${"0".repeat(130)}`,
          },
          orderType: "FOK",
          marketSlug,
          ownerId: input.ownerId,
          onBehalfOf: input.ownerId,
        },
      });
      if (!probe.ok) {
        const probedExchange = extractLimitlessExpectedExchangeAddress(
          probe.payload,
        );
        if (probedExchange) {
          canonicalExchangeAddress = probedExchange;
        }
      }
    } catch (error) {
      void error;
    }
  }

  return { exchangeAddress: canonicalExchangeAddress };
}

export async function fetchLimitlessOrderRoute(input: {
  orderId: string;
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  const partnerAuth = await resolveLimitlessRouteAuth({
    userId: input.userId,
    walletAddress: input.signer,
  });
  if (!partnerAuth.ok) return partnerAuth;

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/orders/${input.orderId}`,
    ...partnerAuth.requestAuth,
    headers: buildLimitlessOnBehalfHeaders(partnerAuth.profile),
  });

  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless order fetch failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  return {
    ok: true,
    payload: { ok: true, payload: upstream.payload },
  };
}

export async function fetchLimitlessOpenOrdersRoute(input: {
  query: LimitlessOpenOrdersQuery;
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  const partnerAuth = await resolveLimitlessRouteAuth({
    userId: input.userId,
    walletAddress: input.signer,
  });
  if (!partnerAuth.ok) return partnerAuth;

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(input.query.slug)}/user-orders`,
    ...partnerAuth.requestAuth,
    headers: buildLimitlessOnBehalfHeaders(partnerAuth.profile),
  });

  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless open orders failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  return {
    ok: true,
    payload: { ok: true, payload: upstream.payload },
  };
}

async function markLimitlessLocalOrderCancelled(input: {
  orderId: string;
  pool: ApiTradingApplicationServiceInput["pool"];
  userId: string;
  walletAddress: string;
}) {
  return input.pool.query(
    `
      update orders
      set status = 'cancelled',
          cancelled_at = coalesce(cancelled_at, now()),
          last_update = now()
      where user_id = $1
        and (wallet_address = $2 or signer_address = $2)
        and venue = 'limitless'
        and venue_order_id = $3
        and lower(coalesce(status, '')) in (
          'pending',
          'submitted',
          'live',
          'open',
          'partially_filled'
        )
    `,
    [input.userId, input.walletAddress, input.orderId],
  );
}

async function notifyLimitlessCancel(input: {
  dedupePrefix?: "order_cancelled_all" | "order_cancelled_batch";
  log?: LimitlessRouteLogger | null;
  orderId?: string | null;
  orderIds?: string[];
  pool: ApiTradingApplicationServiceInput["pool"];
  userId: string;
  walletAddress: string;
}) {
  if (input.orderIds?.length) {
    void createNotificationSafe(
      input.pool,
      {
        userId: input.userId,
        type: "order_cancelled",
        title: "Orders cancelled",
        body: `${input.orderIds.length} Limitless orders`,
        severity: "warning",
        data: {
          venue: "limitless",
          orderIds: input.orderIds,
          walletAddress: input.walletAddress,
        },
        dedupeKey: `${input.dedupePrefix ?? "order_cancelled_batch"}:${
          input.orderIds[0] ??
          (input.dedupePrefix === "order_cancelled_all" ? "all" : "batch")
        }`,
      },
      input.log as never,
    );
    return;
  }
  if (input.orderId) {
    void createNotificationSafe(
      input.pool,
      buildOrderNotification({
        userId: input.userId,
        venue: "limitless",
        status: "cancelled",
        orderId: input.orderId,
        walletAddress: input.walletAddress,
      }),
      input.log as never,
    );
  }
}

export async function cancelLimitlessOrderRoute(input: {
  orderId: string;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  if (
    !(await venueLifecycleAllowsTradingAction(
      input.pool,
      "limitless",
      "CANCEL",
    ))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Limitless cancellations are temporarily disabled" },
    };
  }
  const storedWalletContext = await fetchStoredOrderWalletContext(input.pool, {
    userId: input.userId,
    venue: "limitless",
    venueOrderId: input.orderId,
  });
  const cancelWallet =
    storedWalletContext?.walletAddress ??
    storedWalletContext?.signerAddress ??
    input.signer;
  const partnerAuth = await resolveLimitlessRouteAuth({
    userId: input.userId,
    walletAddress: cancelWallet,
  });
  if (!partnerAuth.ok) return partnerAuth;

  const upstream = await limitlessRequest({
    method: "POST",
    requestPath: buildLimitlessOnBehalfQueryPath(
      "/orders/cancel",
      partnerAuth.profile,
    ),
    ...partnerAuth.requestAuth,
    body: { orderId: input.orderId },
  });

  if (!upstream.ok) {
    const upstreamMessage = extractLimitlessMessage(upstream.payload);
    if (isLimitlessAmbiguousAlreadyCancelledOrderMessage(upstreamMessage)) {
      const cancelResult = await markLimitlessLocalOrderCancelled({
        pool: input.pool,
        userId: input.userId,
        walletAddress: cancelWallet,
        orderId: input.orderId,
      });
      const changed = (cancelResult.rowCount ?? 0) > 0;
      if (changed) {
        await notifyLimitlessCancel({
          log: null,
          pool: input.pool,
          userId: input.userId,
          walletAddress: cancelWallet,
          orderId: input.orderId,
        });
      }
      return {
        ok: true,
        payload: {
          ok: true,
          changed,
          idempotent: true,
          payload: upstream.payload,
        },
      };
    }

    return {
      ok: false,
      statusCode: mapLimitlessUpstreamStatus(upstream.status),
      payload: {
        error: "Limitless cancel failed",
        ...(upstreamMessage ? { message: upstreamMessage } : {}),
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const cancelResult = await markLimitlessLocalOrderCancelled({
    pool: input.pool,
    userId: input.userId,
    walletAddress: cancelWallet,
    orderId: input.orderId,
  });
  const changed = (cancelResult.rowCount ?? 0) > 0;
  if (changed) {
    await notifyLimitlessCancel({
      log: null,
      pool: input.pool,
      userId: input.userId,
      walletAddress: cancelWallet,
      orderId: input.orderId,
    });
  }

  return {
    ok: true,
    payload: { ok: true, changed, payload: upstream.payload },
  };
}

export async function cancelLimitlessOrdersBatchRoute(input: {
  orderIds: string[];
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  if (
    !(await venueLifecycleAllowsTradingAction(
      input.pool,
      "limitless",
      "CANCEL",
    ))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Limitless cancellations are temporarily disabled" },
    };
  }
  const partnerAuth = await resolveLimitlessRouteAuth({
    userId: input.userId,
    walletAddress: input.signer,
  });
  if (!partnerAuth.ok) return partnerAuth;

  const upstream = await limitlessRequest({
    method: "POST",
    requestPath: buildLimitlessOnBehalfQueryPath(
      "/orders/cancel-batch",
      partnerAuth.profile,
    ),
    ...partnerAuth.requestAuth,
    body: { orderIds: input.orderIds },
  });

  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless cancel batch failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const cancelledIds = extractLimitlessCanceledIds(
    upstream.payload,
    input.orderIds,
  );
  if (cancelledIds.length) {
    await input.pool.query(
      `
        update orders
        set status = 'cancelled',
            cancelled_at = now(),
            last_update = now()
        where user_id = $1
          and (wallet_address = $2 or signer_address = $2)
          and venue = 'limitless'
          and venue_order_id = ANY($3::text[])
      `,
      [input.userId, input.signer, cancelledIds],
    );
    await notifyLimitlessCancel({
      dedupePrefix: "order_cancelled_batch",
      log: null,
      pool: input.pool,
      userId: input.userId,
      walletAddress: input.signer,
      orderIds: cancelledIds,
    });
  }

  return { ok: true, payload: { ok: true, payload: upstream.payload } };
}

export async function cancelAllLimitlessOrdersRoute(input: {
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  slug: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  if (
    !(await venueLifecycleAllowsTradingAction(
      input.pool,
      "limitless",
      "CANCEL",
    ))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Limitless cancellations are temporarily disabled" },
    };
  }
  const partnerAuth = await resolveLimitlessRouteAuth({
    userId: input.userId,
    walletAddress: input.signer,
  });
  if (!partnerAuth.ok) return partnerAuth;

  let openOrderIds: string[] = [];
  const openOrders = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(input.slug)}/user-orders`,
    ...partnerAuth.requestAuth,
    headers: buildLimitlessOnBehalfHeaders(partnerAuth.profile),
  });
  if (openOrders.ok) {
    openOrderIds = extractLimitlessOrders(openOrders.payload)
      .map((order) => extractLimitlessOrderId(order))
      .filter((orderId): orderId is string => Boolean(orderId));
  } else {
    input.log?.warn?.(
      {
        status: openOrders.status,
        payload: openOrders.payload,
        slug: input.slug,
      },
      "Limitless cancel all: failed to fetch open orders",
    );
  }

  const upstream = await limitlessRequest({
    method: "DELETE",
    requestPath: buildLimitlessOnBehalfQueryPath(
      `/orders/all/${encodeURIComponent(input.slug)}`,
      partnerAuth.profile,
    ),
    ...partnerAuth.requestAuth,
  });

  if (!upstream.ok) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless cancel all failed",
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const cancelledIds = extractLimitlessCanceledIds(
    upstream.payload,
    openOrderIds,
  );
  if (cancelledIds.length) {
    await input.pool.query(
      `
        update orders
        set status = 'cancelled',
            cancelled_at = now(),
            last_update = now()
        where user_id = $1
          and (wallet_address = $2 or signer_address = $2)
          and venue = 'limitless'
          and venue_order_id = ANY($3::text[])
      `,
      [input.userId, input.signer, cancelledIds],
    );
    await notifyLimitlessCancel({
      dedupePrefix: "order_cancelled_all",
      log: input.log,
      pool: input.pool,
      userId: input.userId,
      walletAddress: input.signer,
      orderIds: cancelledIds,
    });
  }

  return { ok: true, payload: { ok: true, payload: upstream.payload } };
}

function coerceOrderNumber(
  value: unknown,
  field: string,
  options: { allowFloat?: boolean } = {},
): number | null {
  if (value == null) return null;
  const raw =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number"
        ? value
        : null;
  if (raw == null || raw === "") return null;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Order ${field} must be a valid number.`);
  }
  if (!options.allowFloat && !Number.isSafeInteger(parsed)) {
    throw new Error(`Order ${field} must be a safe integer.`);
  }
  return parsed;
}

function isEvmWallet(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function deriveSize(
  orderType: string,
  side: "BUY" | "SELL" | null,
  makerAmount: number | null,
  takerAmount: number | null,
): number | null {
  return deriveLimitlessSignedOrderSize({
    orderType,
    side,
    makerAmount,
    takerAmount,
  });
}

function normalizeRawLimitlessTokenIdFromUnknown(
  value: unknown,
): string | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
    ? normalizeLimitlessRawTokenId(value)
    : null;
}

type LimitlessTokenPair = {
  marketId: string | null;
  tokenNo: string | null;
  tokenYes: string | null;
};

function extractLimitlessPositionTokenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeRawLimitlessTokenIdFromUnknown(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function extractLimitlessTokenPair(
  payload: unknown,
): Omit<LimitlessTokenPair, "marketId"> | null {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return null;

  const tokensRecord = isRecord(marketRecord.tokens)
    ? marketRecord.tokens
    : isRecord(marketRecord.token)
      ? marketRecord.token
      : null;
  const positionIds = extractLimitlessPositionTokenIds(
    marketRecord.position_ids ?? marketRecord.positionIds,
  );

  const tokenYes =
    normalizeRawLimitlessTokenIdFromUnknown(
      tokensRecord
        ? (tokensRecord.yes ?? tokensRecord.YES ?? tokensRecord[0])
        : null,
    ) ??
    positionIds[0] ??
    null;
  const tokenNo =
    normalizeRawLimitlessTokenIdFromUnknown(
      tokensRecord
        ? (tokensRecord.no ?? tokensRecord.NO ?? tokensRecord[1])
        : null,
    ) ??
    positionIds[1] ??
    null;

  if (!tokenYes && !tokenNo) return null;
  return { tokenYes, tokenNo };
}

function extractLimitlessMarketExchangeAddress(
  payload: unknown,
): string | null {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return null;

  const directCandidates = [
    marketRecord.negRiskExchange,
    marketRecord.neg_risk_exchange,
    marketRecord.exchangeAddress,
    marketRecord.exchange_address,
    marketRecord.exchange,
    marketRecord.venueExchange,
    marketRecord.venue_exchange,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
      return ethers.getAddress(candidate.trim());
    }
  }

  const venue = marketRecord.venue;
  if (isRecord(venue)) {
    const nestedCandidates = [
      venue.negRiskExchange,
      venue.neg_risk_exchange,
      venue.exchangeAddress,
      venue.exchange_address,
      venue.exchange,
      venue.venueExchange,
      venue.venue_exchange,
    ];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
        return ethers.getAddress(candidate.trim());
      }
    }
  }

  return null;
}

function extractLimitlessMarketAdapterAddress(payload: unknown): string | null {
  const marketRecord = isRecord(payload)
    ? isRecord(payload.market)
      ? payload.market
      : payload
    : null;
  if (!marketRecord) return null;

  const directCandidates = [
    marketRecord.operator,
    marketRecord.operatorAddress,
    marketRecord.negRiskOperator,
    marketRecord.negRiskOperatorAddress,
    marketRecord.negRiskAdapter,
    marketRecord.adapter,
    marketRecord.adapterAddress,
    marketRecord.venueAdapter,
    marketRecord.exchangeAdapter,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
      return ethers.getAddress(candidate.trim());
    }
  }

  const venue = marketRecord.venue;
  if (isRecord(venue)) {
    const nestedCandidates = [
      venue.operator,
      venue.operatorAddress,
      venue.negRiskOperator,
      venue.negRiskOperatorAddress,
      venue.adapter,
      venue.adapterAddress,
      venue.exchangeAdapter,
    ];
    for (const candidate of nestedCandidates) {
      if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
        return ethers.getAddress(candidate.trim());
      }
    }
  }

  return null;
}

function extractLimitlessExpectedExchangeAddress(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;

  const nestedPayload = isRecord(payload.payload) ? payload.payload : null;
  const candidates: unknown[] = [
    payload.message,
    payload.error,
    nestedPayload?.message,
    nestedPayload?.error,
  ];

  const pattern = /exchange address for this market:\s*(0x[a-fA-F0-9]{40})/i;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(pattern);
    if (!match?.[1]) continue;
    const value = match[1].trim();
    if (!ethers.isAddress(value)) continue;
    return ethers.getAddress(value);
  }

  return null;
}

function resolveLimitlessLegacyOperatorForExchange(
  exchangeAddress: string | null,
): string | null {
  if (!exchangeAddress) return null;
  const mapped =
    LIMITLESS_LEGACY_OPERATOR_BY_EXCHANGE[normalizeAddress(exchangeAddress)];
  return mapped ?? null;
}

async function resolveLimitlessTokenPairForSlug(input: {
  pool: ApiTradingApplicationServiceInput["pool"];
  requestAuth: Record<string, unknown>;
  slug: string;
}): Promise<LimitlessTokenPair | null> {
  const slug = input.slug.trim();
  if (!slug) return null;

  const dbRow = await input.pool.query<{
    id: string;
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select id, token_yes, token_no
      from unified_markets
      where venue = 'limitless'
        and slug = $1
      limit 1
    `,
    [slug],
  );
  const dbTokenYes = normalizeLimitlessRawTokenId(
    dbRow.rows[0]?.token_yes ?? null,
  );
  const dbTokenNo = normalizeLimitlessRawTokenId(
    dbRow.rows[0]?.token_no ?? null,
  );
  const marketId = dbRow.rows[0]?.id ?? null;
  if (dbTokenYes && dbTokenNo) {
    return { marketId, tokenYes: dbTokenYes, tokenNo: dbTokenNo };
  }

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
    ...(input.requestAuth as object),
  });
  if (!upstream.ok) {
    return dbTokenYes || dbTokenNo
      ? { marketId, tokenYes: dbTokenYes, tokenNo: dbTokenNo }
      : null;
  }

  const upstreamTokens = extractLimitlessTokenPair(upstream.payload);
  if (!upstreamTokens) {
    return dbTokenYes || dbTokenNo
      ? { marketId, tokenYes: dbTokenYes, tokenNo: dbTokenNo }
      : null;
  }

  return {
    marketId,
    tokenYes: upstreamTokens.tokenYes ?? dbTokenYes,
    tokenNo: upstreamTokens.tokenNo ?? dbTokenNo,
  };
}

function submitLimitlessClobOrderToVenue(input: {
  body: unknown;
  requestAuth: unknown;
}): ReturnType<typeof limitlessRequest> {
  return limitlessRequest({
    method: "POST",
    requestPath: "/orders",
    ...(input.requestAuth as object),
    body: input.body,
  });
}

function extractLimitlessSubmittedOrder(payload: unknown): {
  order: unknown;
  status: string | null;
  venueOrderId: string | null;
} {
  const parsed = parseLimitlessOrderResult(payload);
  return {
    order: parsed.order,
    status: parsed.status,
    venueOrderId: parsed.venueOrderId,
  };
}

type LimitlessFokNoFillInput = {
  orderPayload: unknown;
  pool: ApiTradingApplicationServiceInput["pool"];
  price: number | null;
  rawPayload: unknown;
  side: "BUY" | "SELL";
  signer: string;
  size: number | null;
  tokenId: string | null;
  userId: string;
  venueOrderId: string | null;
};

async function recordLimitlessFokNoFill(
  input: LimitlessFokNoFillInput,
): Promise<Extract<LimitlessClientSignedOrderResult, { ok: true }>["payload"]> {
  if (input.venueOrderId) {
    const now = new Date();
    const rawError = stringifyLimitlessRawError(input.rawPayload);
    await storeOrder(input.pool, {
      userId: input.userId,
      walletAddress: input.signer,
      signerAddress: input.signer,
      venue: "limitless",
      venueOrderId: input.venueOrderId,
      tokenId: input.tokenId,
      side: input.side,
      orderType: "FOK",
      price: input.price,
      size: input.size,
      status: "expired",
      errorMessage: LIMITLESS_FOK_UNMATCHED_MESSAGE,
      rawError,
      orderPayload: input.orderPayload,
      lastUpdate: now,
    });
    await input.pool.query(
      `
        update orders
        set status = 'expired',
            error_message = $4,
            raw_error = coalesce($5, raw_error),
            last_update = $6
        where user_id = $1
          and (wallet_address = $2 or signer_address = $2)
          and venue = 'limitless'
          and venue_order_id = $3
      `,
      [
        input.userId,
        input.signer,
        input.venueOrderId,
        LIMITLESS_FOK_UNMATCHED_MESSAGE,
        rawError,
        now,
      ],
    );
  }

  return {
    ok: false,
    reason: LIMITLESS_FOK_UNMATCHED_REASON,
    message: LIMITLESS_FOK_UNMATCHED_MESSAGE,
    status: "expired",
    executionStatus: "UNMATCHED",
    orderId: input.venueOrderId ?? undefined,
    payload: input.rawPayload,
  };
}

/**
 * A FOK no-fill is the single CLOB outcome that conclusively proves no trade
 * occurred. Both a rejected FOK response and a successful no-fill response
 * converge here so funding reservations and sealed direct intents cannot
 * drift into different terminal semantics.
 */
async function finalizeLimitlessFokNoFill(
  input: LimitlessFokNoFillInput & {
    clientOrderId: string;
    directHandoffBinding: TelegramAppHandoffV2DirectTradeBinding | null;
    directHandoffSubmission: TelegramAppHandoffV2DirectTradeSubmission | null;
    fundingReservation: TradeIntent["fundingReservation"] | null;
    fundingTradeAttemptId: string | null;
  },
): Promise<Extract<LimitlessClientSignedOrderResult, { ok: true }>["payload"]> {
  const noFill = await recordLimitlessFokNoFill(input);
  if (input.fundingReservation && input.fundingTradeAttemptId) {
    await releaseFundingReservationForDefinitiveTradeFailure(input.pool, {
      userId: input.userId,
      link: input.fundingReservation,
      tradeAttemptId: input.fundingTradeAttemptId,
      outcomeReason: "trade_no_fill",
      errorCode: "trade_no_fill",
      externalReference: input.venueOrderId ?? input.clientOrderId,
      broadcastMayHaveOccurred: true,
    });
  }
  if (
    input.directHandoffBinding &&
    input.directHandoffSubmission &&
    !input.fundingReservation
  ) {
    await failTelegramAppHandoffV2DirectTradeSubmission(input.pool, {
      binding: input.directHandoffBinding,
      reason: {
        code: "limitless_trade_no_fill",
        message: `Limitless could not fill the sealed ${
          input.directHandoffSubmission.action === "sell" ? "Sell" : "Buy"
        }. Nothing was submitted.`,
      },
      submission: input.directHandoffSubmission,
      userId: input.userId,
    });
  }
  return noFill;
}

function buildLimitlessClobDirectHandoffSubmission(input: {
  action: "buy" | "sell";
  makerAmount: number | null;
  marketId: string | null;
  signer: string;
  tokenId: string | null;
}): TelegramAppHandoffV2DirectTradeSubmission | null {
  if (
    !input.marketId ||
    !input.tokenId ||
    input.makerAmount == null ||
    !Number.isSafeInteger(input.makerAmount) ||
    input.makerAmount <= 0
  ) {
    return null;
  }
  return {
    action: input.action,
    executionKind: "clob",
    marketId: input.marketId,
    outcomeTokenId: input.tokenId,
    // Limitless requires the literal FOK sentinel. Buy is capped by spend and
    // Sell by exact source shares; the protocol has no signed proceeds floor.
    receiveRaw: "1",
    signer: input.signer,
    spendRaw: input.makerAmount.toString(),
    venue: "limitless",
  };
}

async function claimLimitlessClobDirectHandoff(input: {
  assertCurrentScope: TelegramAppHandoffV2ScopeAssertion | undefined;
  binding: TelegramAppHandoffV2DirectTradeBinding;
  clientOrderId: string;
  orderFingerprint: string;
  marketSlug: string;
  orderType: "FOK" | "GTC";
  ownerId: number;
  pool: ApiTradingApplicationServiceInput["pool"];
  price: number | null;
  readSellPositionAvailableRaw?: () => Promise<string>;
  size: number | null;
  submission: TelegramAppHandoffV2DirectTradeSubmission;
  tokenId: string | null;
  userId: string;
}): Promise<void> {
  if (!input.assertCurrentScope) {
    throw new Error("sealed handoff scope cannot be verified");
  }
  await claimTelegramAppHandoffV2DirectTradeSubmission(input.pool, {
    assertCurrentScope: input.assertCurrentScope,
    binding: input.binding,
    reconcileKeys: {
      clientOrderId: input.clientOrderId,
      orderFingerprint: input.orderFingerprint,
      tradeType: "clob",
    },
    // The durable claim never retains or replays the client signature.
    recoveryPayload: {
      clientOrderId: input.clientOrderId,
      kind: "limitless",
      marketSlug: input.marketSlug,
      orderPayload: { clientOrderId: input.clientOrderId },
      orderType: input.orderType,
      ownerId: input.ownerId,
      price: input.price,
      requestAuth: { auth: "partner_hmac" },
      size: input.size,
      tokenId: input.tokenId,
    },
    readSellPositionAvailableRaw: input.readSellPositionAvailableRaw,
    submission: input.submission,
    userId: input.userId,
  });
}

export async function submitLimitlessClientSignedOrder(input: {
  assertTelegramAppHandoffV2Scope?: TelegramAppHandoffV2ScopeAssertion;
  body: LimitlessClientOrderBody;
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<LimitlessClientSignedOrderResult> {
  const signer = input.signer;
  if (!isEvmWallet(signer)) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Limitless order requires an EVM wallet address" },
    };
  }

  const side = normalizeOrderSide(input.body.order.side);
  if (!side) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Order side must be BUY/SELL (or 0/1)" },
    };
  }
  const fundingReservation =
    input.body.fundingOperationId && input.body.fundingReservationId
      ? {
          operationId: input.body.fundingOperationId,
          reservationId: input.body.fundingReservationId,
        }
      : null;
  const directHandoffBinding =
    input.body.telegramAppHandoffId &&
    input.body.telegramAppHandoffPlanFingerprint
      ? {
          handoffId: input.body.telegramAppHandoffId,
          planFingerprint: input.body.telegramAppHandoffPlanFingerprint,
        }
      : null;
  if (
    Boolean(input.body.fundingOperationId) !==
    Boolean(input.body.fundingReservationId)
  ) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          "fundingOperationId and fundingReservationId must be provided together",
      },
    };
  }
  if (
    Boolean(input.body.telegramAppHandoffId) !==
    Boolean(input.body.telegramAppHandoffPlanFingerprint)
  ) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          "telegramAppHandoffId and telegramAppHandoffPlanFingerprint must be provided together",
      },
    };
  }
  // Telegram v2 never creates a resting Limitless order. It signs one FOK
  // trade, so closing or replaying the Mini App cannot leave a GTC order live
  // at the venue. Buy is bounded by spend; Sell is bounded by source shares.
  if (directHandoffBinding && input.body.orderType !== "FOK") {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "A sealed Telegram handoff requires a FOK trade." },
    };
  }
  if (fundingReservation && side !== "BUY") {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Funding reservations can only be linked to buys" },
    };
  }
  if (
    !(await venueLifecycleAllowsTradingAction(input.pool, "limitless", side))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Limitless trading action is temporarily disabled" },
    };
  }

  const partnerAuth = await resolveLimitlessRouteAuth({
    userId: input.userId,
    walletAddress: signer,
  });
  if (!partnerAuth.ok) return partnerAuth;
  const { profile, requestAuth } = partnerAuth;
  const ownerId = profile?.id;
  if (!ownerId) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Limitless profile mapping is missing for this wallet.",
      },
    };
  }
  if (input.body.ownerId != null && input.body.ownerId !== ownerId) {
    input.log?.warn?.(
      {
        userId: input.userId,
        walletAddress: signer,
        requestedOwnerId: input.body.ownerId,
        resolvedOwnerId: ownerId,
      },
      "Ignoring client-supplied Limitless ownerId; using resolved ownerId",
    );
  }

  const order = input.body.order;
  const orderSigner = typeof order.signer === "string" ? order.signer : "";
  if (normalizeAddress(orderSigner) !== normalizeAddress(signer)) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Order signer must match the selected wallet" },
    };
  }

  const maker = typeof order.maker === "string" ? order.maker : "";
  if (normalizeAddress(maker) !== normalizeAddress(signer)) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Order maker must match the selected wallet" },
    };
  }
  const checksumSigner = toChecksumAddress(signer);
  if (!checksumSigner) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Selected wallet is not a valid EVM address" },
    };
  }

  let orderForUpstream: Record<string, unknown>;
  let coercedMakerAmount: number | null = null;
  let coercedTakerAmount: number | null = null;
  let coercedNonce: number | null = null;
  let coercedPrice: number | null = null;
  let coercedSideValue: number | null = null;
  try {
    const salt = coerceOrderNumber(order.salt, "salt");
    const makerAmount = coerceOrderNumber(order.makerAmount, "makerAmount");
    const takerAmount = coerceOrderNumber(order.takerAmount, "takerAmount");
    const expirationValue = order.expiration;
    const expiration =
      typeof expirationValue === "string"
        ? expirationValue.trim()
        : expirationValue == null
          ? null
          : String(expirationValue);
    const nonce = coerceOrderNumber(order.nonce, "nonce");
    const feeRateBps = coerceOrderNumber(order.feeRateBps ?? 0, "feeRateBps");
    const profileFeeRateBps = profile.rank?.feeRateBps;
    if (
      profileFeeRateBps != null &&
      Number.isFinite(profileFeeRateBps) &&
      profileFeeRateBps >= 0 &&
      feeRateBps != null &&
      feeRateBps !== Math.trunc(profileFeeRateBps)
    ) {
      return {
        ok: false,
        statusCode: 409,
        payload: {
          error: "Limitless fee rate changed. Refresh the order and try again.",
        },
      };
    }
    const sideValue = coerceOrderNumber(order.side, "side");
    const signatureType = coerceOrderNumber(
      order.signatureType,
      "signatureType",
    );
    const price =
      order.price == null
        ? null
        : coerceOrderNumber(order.price, "price", { allowFloat: true });

    if (
      salt == null ||
      makerAmount == null ||
      takerAmount == null ||
      expiration == null ||
      expiration === "" ||
      nonce == null ||
      sideValue == null ||
      signatureType == null
    ) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "Order numeric fields are required." },
      };
    }

    coercedMakerAmount = makerAmount;
    coercedTakerAmount = takerAmount;
    coercedNonce = nonce;
    coercedPrice = price;
    coercedSideValue = sideValue;
    orderForUpstream = {
      ...order,
      maker: checksumSigner,
      signer: checksumSigner,
      salt,
      makerAmount,
      takerAmount,
      expiration,
      nonce,
      feeRateBps,
      side: sideValue,
      signatureType,
      ...(price == null ? {} : { price }),
    };
  } catch {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Invalid order data." },
    };
  }

  if (input.body.orderType === "FOK") {
    // Limitless defines FOK takerAmount as the literal market-order sentinel.
    // It is not a minimum-receive field, so no sealed handoff may reinterpret
    // it as one. AMM uses its signed minOutcomeTokens argument instead.
    if (coercedTakerAmount !== 1) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "FOK orders require takerAmount to equal 1." },
      };
    }
    if (coercedNonce !== 0) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "FOK orders require nonce to equal 0." },
      };
    }
    if (coercedPrice != null) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "FOK orders must not include price." },
      };
    }
  } else {
    if (coercedPrice == null) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "GTC orders require a price." },
      };
    }
    if (
      coercedMakerAmount == null ||
      coercedTakerAmount == null ||
      coercedSideValue == null
    ) {
      return {
        ok: false,
        statusCode: 400,
        payload: {
          error: "GTC orders require makerAmount, takerAmount, and side.",
        },
      };
    }
    const priceRaw = Math.round(coercedPrice * 1_000_000);
    if (priceRaw <= 0 || priceRaw >= 1_000_000) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "GTC price must be between 0 and 1." },
      };
    }
    if (priceRaw % 1_000 !== 0) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "GTC price must align to 0.001 tick size." },
      };
    }
    const sharesRaw =
      coercedSideValue === 0 ? coercedTakerAmount : coercedMakerAmount;
    if (sharesRaw <= 0) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "GTC share size must be positive." },
      };
    }
    if (sharesRaw % 1_000 !== 0) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "GTC size must align to 0.001 shares." },
      };
    }
    const quoteRaw =
      coercedSideValue === 0 ? coercedMakerAmount : coercedTakerAmount;
    if (quoteRaw <= 0) {
      return {
        ok: false,
        statusCode: 400,
        payload: { error: "GTC quote size must be positive." },
      };
    }
    const numerator = BigInt(sharesRaw) * BigInt(priceRaw);
    const denominator = BigInt(1_000_000);
    const expectedQuote =
      coercedSideValue === 0
        ? Number((numerator + denominator - BigInt(1)) / denominator)
        : Number(numerator / denominator);
    if (Math.abs(expectedQuote - quoteRaw) > 1) {
      return {
        ok: false,
        statusCode: 400,
        payload: {
          error:
            "GTC order amounts are not aligned with price tick and share size.",
        },
      };
    }
  }

  const requestedRawTokenId = normalizeRawLimitlessTokenIdFromUnknown(
    orderForUpstream.tokenId,
  );
  if (!requestedRawTokenId) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Order tokenId is invalid." },
    };
  }
  const marketTokens = await resolveLimitlessTokenPairForSlug({
    pool: input.pool,
    slug: input.body.marketSlug,
    requestAuth,
  });
  const allowedRawTokenIds = [
    marketTokens?.tokenYes ?? null,
    marketTokens?.tokenNo ?? null,
  ].filter((entry): entry is string => Boolean(entry));
  if (!allowedRawTokenIds.length) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          "Unable to validate market tokens for this marketSlug. Please refresh and retry.",
      },
    };
  }
  if (!allowedRawTokenIds.includes(requestedRawTokenId)) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "Order tokenId does not belong to marketSlug.",
        marketSlug: input.body.marketSlug,
        tokenId: requestedRawTokenId,
      },
    };
  }
  const tokenId = normalizeLimitlessScopedTokenId(requestedRawTokenId);
  const makerAmount = coercedMakerAmount;
  const takerAmount = coercedTakerAmount;
  const price = coercedPrice;
  const size = deriveSize(input.body.orderType, side, makerAmount, takerAmount);
  if (side === "SELL") {
    const requestedSharesRaw = BigInt(makerAmount);
    if (!directHandoffBinding) {
      const availability = await resolveLimitlessAvailablePositionRaw({
        pool: input.pool,
        signer,
        tokenId: requestedRawTokenId,
        userId: input.userId,
      });
      if (availability.availableRaw < requestedSharesRaw) {
        return {
          ok: false,
          statusCode: 409,
          payload: {
            code: "limitless_sell_balance_changed",
            error: "Limitless position balance changed.",
            availableSharesRaw: availability.availableRaw.toString(),
            requestedSharesRaw: requestedSharesRaw.toString(),
          },
        };
      }
    }
  }
  // The generic v2 funding continuation is single-flight. Reuse its provider
  // id across two browser tabs instead of duplicating its final venue trade.
  const clientOrderId = directHandoffBinding
    ? `hunch-th2-${directHandoffBinding.handoffId}`
    : `hunch-${crypto.randomUUID()}`;
  const orderPayload = {
    order: orderForUpstream,
    orderType: input.body.orderType,
    marketSlug: input.body.marketSlug,
    ownerId,
    onBehalfOf: ownerId,
    clientOrderId,
  };
  // Limitless identifies the request by clientOrderId, but a v2 handoff must
  // never treat that deterministic id as authority to resend changed signed
  // FOK bytes. Persist the canonical signed-order fingerprint with the claim.
  const orderFingerprint = canonicalJsonHash(orderForUpstream);
  const fundingMarketId = marketTokens?.marketId ?? null;
  let fundingConsumerIntent: ReturnType<
    typeof buildFundingTradeConsumerIntent
  > | null = null;
  const directHandoffSubmission = directHandoffBinding
    ? buildLimitlessClobDirectHandoffSubmission({
        action: side === "SELL" ? "sell" : "buy",
        makerAmount,
        marketId: fundingMarketId,
        signer,
        tokenId,
      })
    : null;
  if (directHandoffBinding && !directHandoffSubmission) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Telegram handoff market binding is unavailable" },
    };
  }
  if (
    fundingReservation &&
    fundingMarketId &&
    requestedRawTokenId &&
    makerAmount != null &&
    Number.isSafeInteger(makerAmount) &&
    makerAmount > 0
  ) {
    try {
      fundingConsumerIntent = buildFundingTradeConsumerIntent({
        venueId: "limitless",
        marketId: fundingMarketId,
        marketContextId: requestedRawTokenId,
        spend: {
          asset: {
            networkId: "evm:8453",
            assetId: env.limitlessUsdcAddress,
            decimals: 6,
          },
          raw: makerAmount.toString(),
        },
      });
    } catch {
      return {
        ok: false,
        statusCode: 409,
        payload: {
          code: "funding_intent_invalid",
          error: "Funding reservation market binding is unavailable",
        },
      };
    }
  }
  if (fundingReservation) {
    if (!fundingConsumerIntent) {
      return {
        ok: false,
        statusCode: 409,
        payload: { error: "Funding reservation market binding is unavailable" },
      };
    }
    try {
      if (!directHandoffBinding || !directHandoffSubmission) {
        await assertFundingReservationReadyForTrade(input.pool, {
          userId: input.userId,
          link: fundingReservation,
          intent: fundingConsumerIntent,
        });
      } else if (!input.assertTelegramAppHandoffV2Scope) {
        throw new Error("sealed handoff scope cannot be verified");
      }
    } catch (error) {
      return {
        ok: false,
        statusCode: 409,
        payload: toPublicFundingTradeError(error),
      };
    }
  }

  const claimCurrentFundingTradeAttempt = async () => {
    if (!fundingReservation || !fundingConsumerIntent || !fundingMarketId) {
      throw new Error("Funding reservation market binding is unavailable");
    }
    const canonicalFingerprint = canonicalJsonHash({
      executionPath: "limitless_clob",
      marketId: fundingMarketId,
      marketSlug: input.body.marketSlug,
      order: orderForUpstream,
      orderType: input.body.orderType,
      signer: signer.toLowerCase(),
    });
    return claimFundingTradeAttemptForVenueConsumer(input.pool, {
      canonicalFingerprint,
      consumerIntent: fundingConsumerIntent,
      executionPath: "limitless_clob",
      externalReference: clientOrderId,
      handoff:
        directHandoffBinding &&
        directHandoffSubmission &&
        input.assertTelegramAppHandoffV2Scope
          ? {
              assertCurrentScope: input.assertTelegramAppHandoffV2Scope,
              binding: directHandoffBinding,
              submission: directHandoffSubmission,
            }
          : null,
      idempotencyKey: `limitless-clob:${canonicalFingerprint}`,
      marketId: fundingMarketId,
      operationId: fundingReservation.operationId,
      reservationId: fundingReservation.reservationId,
      userId: input.userId,
      venueId: "limitless",
    });
  };

  if (input.body.orderType === "FOK") {
    const amount = normalizeLimitlessRawAmount(makerAmount);
    const depthQuote = await quoteLimitlessClobMarket({
      ...(side === "BUY" ? { amountUsd: amount } : { amountShares: amount }),
      side,
      slug: input.body.marketSlug,
      tokenId: requestedRawTokenId,
    });
    if (depthQuote.status === "unavailable") {
      return {
        ok: false,
        statusCode: 502,
        payload: {
          code: "quote_unavailable",
          error: "Limitless depth quote is temporarily unavailable.",
        },
      };
    }
    if (isLimitlessClobDefinitiveNoFill(depthQuote.status)) {
      if (fundingReservation) {
        try {
          const claim = await claimCurrentFundingTradeAttempt();
          if (!claim.claimed) {
            return {
              ok: false,
              statusCode: 409,
              payload: {
                error:
                  "This funding reservation already has a trade attempt that must reconcile.",
              },
            };
          }
          await releaseFundingReservationForDefinitiveTradeFailure(input.pool, {
            userId: input.userId,
            link: fundingReservation,
            tradeAttemptId: claim.attempt.id,
            outcomeReason: "trade_no_fill",
            errorCode: "trade_no_fill",
            externalReference: clientOrderId,
            broadcastMayHaveOccurred: false,
            handoffFailure: {
              code: "trade_no_fill",
              message: `Limitless had no immediate liquidity for the ${side === "SELL" ? "Sell" : "Buy"}.`,
            },
          });
        } catch (error) {
          return {
            ok: false,
            statusCode: 409,
            payload: toPublicFundingTradeError(error),
          };
        }
      }
      if (
        directHandoffBinding &&
        directHandoffSubmission &&
        !fundingReservation
      ) {
        try {
          await claimLimitlessClobDirectHandoff({
            assertCurrentScope: input.assertTelegramAppHandoffV2Scope,
            binding: directHandoffBinding,
            clientOrderId,
            orderFingerprint,
            marketSlug: input.body.marketSlug,
            orderType: input.body.orderType,
            ownerId,
            pool: input.pool,
            price,
            ...(side === "SELL"
              ? {
                  readSellPositionAvailableRaw: async () =>
                    (
                      await resolveLimitlessAvailablePositionRaw({
                        pool: input.pool,
                        signer,
                        tokenId: requestedRawTokenId,
                        userId: input.userId,
                      })
                    ).availableRaw.toString(),
                }
              : {}),
            size,
            submission: directHandoffSubmission,
            tokenId,
            userId: input.userId,
          });
          await failTelegramAppHandoffV2DirectTradeSubmission(input.pool, {
            binding: directHandoffBinding,
            reason: {
              code: "limitless_trade_no_fill",
              message: `Limitless had no immediate liquidity for the sealed ${side === "SELL" ? "Sell" : "Buy"}.`,
            },
            submission: directHandoffSubmission,
            userId: input.userId,
          });
        } catch {
          return {
            ok: false,
            statusCode: 409,
            payload: {
              error: "Telegram handoff is no longer valid for this trade",
            },
          };
        }
      }
      return {
        ok: true,
        payload: {
          ok: false,
          reason: depthQuote.status,
          message:
            depthQuote.status === "insufficient_depth"
              ? "Not enough liquidity to fill this order."
              : "No liquidity is available for this order.",
          executionStatus: "UNMATCHED",
          payload: null,
        },
      };
    }
  }
  if (directHandoffBinding && directHandoffSubmission) {
    try {
      if (fundingReservation) {
        if (!input.assertTelegramAppHandoffV2Scope) {
          throw new Error("sealed handoff scope cannot be verified");
        }
        // The funded consumer's durable attempt claim below performs the
        // sealed scope check atomically with its no-cancel boundary.
      } else {
        await claimLimitlessClobDirectHandoff({
          binding: directHandoffBinding,
          assertCurrentScope: input.assertTelegramAppHandoffV2Scope,
          clientOrderId,
          orderFingerprint,
          marketSlug: input.body.marketSlug,
          orderType: input.body.orderType,
          ownerId,
          pool: input.pool,
          price,
          ...(side === "SELL"
            ? {
                readSellPositionAvailableRaw: async () =>
                  (
                    await resolveLimitlessAvailablePositionRaw({
                      pool: input.pool,
                      signer,
                      tokenId: requestedRawTokenId,
                      userId: input.userId,
                    })
                  ).availableRaw.toString(),
              }
            : {}),
          size,
          submission: directHandoffSubmission,
          tokenId,
          userId: input.userId,
        });
      }
    } catch {
      return {
        ok: false,
        statusCode: 409,
        payload: {
          error: "Telegram handoff is no longer valid for this trade",
        },
      };
    }
  }

  let fundingTradeAttemptId: string | null = null;
  let fundingTradeClaimToken: string | null = null;
  if (fundingReservation) {
    try {
      const claim = await claimCurrentFundingTradeAttempt();
      if (!claim.claimed) {
        return {
          ok: false,
          statusCode: 409,
          payload: {
            error:
              "This funding reservation already has a trade attempt that must reconcile.",
          },
        };
      }
      fundingTradeAttemptId = claim.attempt.id;
      fundingTradeClaimToken = claim.attempt.claimToken;
    } catch (error) {
      return {
        ok: false,
        statusCode: 409,
        payload: toPublicFundingTradeError(error),
      };
    }
  }

  if (fundingReservation && fundingTradeAttemptId && fundingTradeClaimToken) {
    try {
      await markFundingTradeAttemptSubmissionStarted(input.pool, {
        userId: input.userId,
        operationId: fundingReservation.operationId,
        reservationId: fundingReservation.reservationId,
        attemptId: fundingTradeAttemptId,
        claimToken: fundingTradeClaimToken,
      });
    } catch (error) {
      return {
        ok: false,
        statusCode: 409,
        payload: toPublicFundingTradeError(error),
      };
    }
  }

  const finalizeCurrentFokNoFill = (
    rawPayload: unknown,
    venueOrderId: string | null,
  ) =>
    finalizeLimitlessFokNoFill({
      clientOrderId,
      directHandoffBinding,
      directHandoffSubmission,
      fundingReservation,
      fundingTradeAttemptId,
      orderPayload,
      pool: input.pool,
      price,
      rawPayload,
      side,
      signer,
      size,
      tokenId,
      userId: input.userId,
      venueOrderId,
    });

  let upstream: Awaited<ReturnType<typeof submitLimitlessClobOrderToVenue>>;
  try {
    upstream = await submitLimitlessClobOrderToVenue({
      body: orderPayload,
      requestAuth,
    });
  } catch (error) {
    if (fundingTradeAttemptId) {
      await recordFundingTradeAttemptOutcome(input.pool, {
        userId: input.userId,
        attemptId: fundingTradeAttemptId,
        outcome: "ambiguous",
        externalReference: clientOrderId,
        errorCode: "limitless_submit_state_unknown",
        broadcastMayHaveOccurred: true,
      });
    }
    // The provider may have accepted a request whose response was lost. Leave
    // a direct handoff executing for reconciliation; never reopen this trade.
    throw error;
  }

  if (!upstream.ok) {
    const upstreamMessage = extractLimitlessMessage(upstream.payload);
    if (
      input.body.orderType === "FOK" &&
      isLimitlessFokUnmatchedMessage(upstreamMessage)
    ) {
      const venueOrderId = extractLimitlessOrderIdFromMessage(upstreamMessage);
      const noFill = await finalizeCurrentFokNoFill(
        upstream.payload,
        venueOrderId,
      );
      return {
        ok: true,
        payload: noFill,
      };
    }
    if (fundingReservation && fundingTradeAttemptId) {
      if (upstream.status >= 500) {
        await recordFundingTradeAttemptOutcome(input.pool, {
          userId: input.userId,
          attemptId: fundingTradeAttemptId,
          outcome: "ambiguous",
          externalReference: clientOrderId,
          errorCode: "limitless_submit_state_unknown",
          broadcastMayHaveOccurred: true,
        });
      } else {
        await releaseFundingReservationForDefinitiveTradeFailure(input.pool, {
          userId: input.userId,
          link: fundingReservation,
          tradeAttemptId: fundingTradeAttemptId,
          outcomeReason: "trade_rejected",
          errorCode: "limitless_trade_rejected",
          externalReference: clientOrderId,
          broadcastMayHaveOccurred: true,
        });
      }
    }
    if (
      directHandoffBinding &&
      directHandoffSubmission &&
      !fundingReservation &&
      isLimitlessClobDefinitiveClientRejection(upstream.status)
    ) {
      try {
        await failTelegramAppHandoffV2DirectTradeSubmission(input.pool, {
          binding: directHandoffBinding,
          reason: {
            code: "limitless_trade_rejected",
            message:
              upstreamMessage ??
              `Limitless rejected the sealed ${side === "SELL" ? "Sell" : "Buy"} before accepting it.`,
          },
          submission: directHandoffSubmission,
          userId: input.userId,
        });
      } catch (error) {
        input.log?.warn?.(
          { error, clientOrderId, userId: input.userId },
          "Limitless direct rejection remains reconciling",
        );
      }
    }
    // A timeout, conflict, throttle, 5xx, or a failed terminal write is not
    // proof that a CLOB request did not reach the venue. Those direct
    // handoffs remain executing until the exact clientOrderId has a result.
    return {
      ok: false,
      statusCode: mapLimitlessUpstreamStatus(upstream.status),
      payload: {
        error: "Limitless order placement failed",
        ...(upstreamMessage ? { message: upstreamMessage } : {}),
        status: upstream.status,
        payload: upstream.payload,
      },
    };
  }

  const submittedOrder = extractLimitlessSubmittedOrder(upstream.payload);
  const venueOrderId = submittedOrder.venueOrderId;
  const parsedResult = parseLimitlessOrderResult(upstream.payload);

  if (input.body.orderType === "FOK" && parsedResult.explicitNoFill) {
    const noFill = await finalizeCurrentFokNoFill(
      upstream.payload,
      venueOrderId,
    );
    return {
      ok: true,
      payload: noFill,
    };
  }

  if (!venueOrderId) {
    if (fundingTradeAttemptId) {
      await recordFundingTradeAttemptOutcome(input.pool, {
        userId: input.userId,
        attemptId: fundingTradeAttemptId,
        outcome: "ambiguous",
        externalReference: parsedResult.txHash ?? clientOrderId,
        errorCode: "limitless_order_id_missing",
        broadcastMayHaveOccurred: true,
      });
    }
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless order placed but no orderId returned",
        payload: upstream.payload,
      },
    };
  }

  const status = submittedOrder.status ?? "submitted";

  const immediateFill =
    input.body.orderType === "FOK"
      ? extractLimitlessImmediateFill(upstream.payload, side, { price, size })
      : null;
  const confirmedImmediateFill =
    immediateFill != null && isLimitlessTerminalFillStatus(status)
      ? immediateFill
      : null;
  const storedPrice =
    confirmedImmediateFill && confirmedImmediateFill.shares > 0
      ? (price ??
        confirmedImmediateFill.notionalUsd / confirmedImmediateFill.shares)
      : price;
  const storedSize =
    confirmedImmediateFill && confirmedImmediateFill.shares > 0
      ? (size ?? confirmedImmediateFill.shares)
      : size;
  const confirmedFillAt = confirmedImmediateFill ? new Date() : null;
  const storedOrderPayload = {
    ...orderPayload,
    _hunchUpstream: upstream.payload,
  };

  const stored = await storeOrder(input.pool, {
    userId: input.userId,
    walletAddress: signer,
    signerAddress: signer,
    venue: "limitless",
    venueOrderId,
    tokenId: tokenId ?? null,
    side,
    orderType: input.body.orderType,
    price: storedPrice,
    size: storedSize,
    status,
    errorMessage: null,
    rawError: null,
    orderPayload: storedOrderPayload,
    orderHash: parsedResult.txHash,
    fundingReservation,
    fundingTradeAttemptId,
    telegramAppHandoffV2DirectTrade:
      directHandoffBinding && directHandoffSubmission && !fundingReservation
        ? { ...directHandoffBinding, ...directHandoffSubmission }
        : null,
    lastUpdate: confirmedFillAt,
    filledAt: confirmedFillAt,
  }).catch(async (error) => {
    if (fundingTradeAttemptId) {
      await recordFundingTradeAttemptOutcome(input.pool, {
        userId: input.userId,
        attemptId: fundingTradeAttemptId,
        outcome: "ambiguous",
        externalReference: parsedResult.txHash ?? venueOrderId,
        errorCode: "limitless_local_persistence_failed",
        broadcastMayHaveOccurred: true,
      }).catch(() => {});
    }
    throw error;
  });

  if (confirmedFillAt && confirmedImmediateFill) {
    await updateOrderFromHistory(input.pool, {
      id: stored.order.id,
      status: "filled",
      price: storedPrice,
      size: storedSize,
      filledAt: confirmedFillAt,
      lastUpdate: confirmedFillAt,
      orderHash: parsedResult.txHash,
    });
  }

  if (confirmedFillAt) {
    try {
      await upsertLimitlessVenueShareAccrualFromOrderPayload(input.pool, {
        orderId: stored.order.id,
        userId: input.userId,
        walletAddress: signer,
        signerAddress: signer,
        venueOrderId,
        orderHash: parsedResult.txHash,
        tokenId: tokenId ?? null,
        side,
        filledAt: confirmedFillAt,
        lastUpdate: confirmedFillAt,
        postedAt: stored.order.posted_at,
        payload: upstream.payload,
      });
    } catch (error) {
      input.log?.warn?.(
        {
          error,
          userId: input.userId,
          walletAddress: signer,
          venueOrderId,
        },
        "Limitless venue fee share accrual upsert failed",
      );
    }
  }

  let referralFirstTrade = null;
  if (stored.kind === "stored" && input.body.orderType === "FOK" && tokenId) {
    if (confirmedImmediateFill) {
      referralFirstTrade = await tryRecordReferralFirstTradeConversion(
        input.pool,
        {
          userId: input.userId,
          venue: "limitless",
          status,
          sourceType: "order",
          sourceId: venueOrderId,
          txHash: null,
          logger: input.log,
        },
      );
    }
    let optimisticApplied = false;
    if (confirmedImmediateFill) {
      try {
        const optimisticResult = await applyOptimisticPositionTradeOnce(
          input.pool,
          {
            orderId: stored.order.id,
            userId: input.userId,
            walletAddress: signer,
            venue: "limitless",
            tokenId,
            side,
            shares: confirmedImmediateFill.shares,
            notionalUsd: confirmedImmediateFill.notionalUsd,
          },
        );
        optimisticApplied = optimisticResult.applied;
      } catch (error) {
        input.log?.warn?.(
          {
            error,
            userId: input.userId,
            walletAddress: signer,
            tokenId,
            side,
          },
          "Limitless optimistic position update failed",
        );
      }
    }
    input.log?.debug?.(
      {
        userId: input.userId,
        walletAddress: signer,
        tokenId,
        side,
        status,
        hasImmediateFill: Boolean(immediateFill),
        optimisticApplied,
      },
      "Limitless optimistic position evaluation",
    );
  }

  void createNotificationSafe(
    input.pool,
    buildOrderNotification({
      userId: input.userId,
      venue: "limitless",
      status,
      action: side,
      size: storedSize,
      price: storedPrice,
      orderId: venueOrderId,
      tokenId: tokenId ?? null,
      walletAddress: signer,
    }),
    input.log as never,
  );

  return {
    ok: true,
    payload: {
      ok: true,
      orderId: venueOrderId,
      status,
      referralFirstTrade: referralFirstTrade ?? undefined,
      payload: upstream.payload,
    },
  };
}

export async function quoteLimitlessAmmRoute(input: {
  query: LimitlessAmmQuoteQuery;
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
}): Promise<LimitlessAmmQuoteRouteResult> {
  if (
    !(await venueLifecycleAllowsTradingAction(
      input.pool,
      "limitless",
      input.query.side,
    ))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Limitless trading action is temporarily disabled" },
    };
  }
  const amountUsdRaw =
    input.query.amountUsdRaw != null ? BigInt(input.query.amountUsdRaw) : null;
  const amountSharesRaw =
    input.query.amountSharesRaw != null
      ? BigInt(input.query.amountSharesRaw)
      : null;

  if (
    input.query.side === "BUY" &&
    (amountUsdRaw == null || amountUsdRaw <= 0n)
  ) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "amountUsdRaw is required for BUY quotes" },
    };
  }

  if (
    input.query.side === "SELL" &&
    (amountSharesRaw == null || amountSharesRaw <= 0n)
  ) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "amountSharesRaw is required for SELL quotes" },
    };
  }

  try {
    const quote = await quoteLimitlessAmmTrade({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      marketAddress: input.query.marketAddress,
      outcomeIndex: input.query.outcomeIndex,
      side: input.query.side,
      amountUsdRaw,
      amountSharesRaw,
    });

    return {
      ok: true,
      payload: {
        ok: true,
        ...(quote as Record<string, unknown>),
      },
    };
  } catch (error) {
    input.log?.warn?.(
      {
        error,
        marketAddress: input.query.marketAddress,
        outcomeIndex: input.query.outcomeIndex,
        side: input.query.side,
      },
      "Limitless AMM quote failed",
    );
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error:
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Unable to fetch Limitless AMM quote",
      },
    };
  }
}

async function resolveLimitlessFundingMarketId(
  pool: ApiTradingApplicationServiceInput["pool"],
  input: Readonly<{ marketSlug?: string | null; tokenId: string }>,
): Promise<string | null> {
  const marketResult = await pool.query<{ id: string }>(
    `
      select distinct market.id
      from unified_markets market
      left join unified_tokens token
        on token.market_id = market.id
       and token.venue = 'limitless'
      where market.venue = 'limitless'
        and (
          ($1::text is not null and market.slug = $1)
          or token.token_id = $2
        )
      order by market.id
      limit 2
    `,
    [
      input.marketSlug?.trim() || null,
      normalizeLimitlessScopedTokenId(input.tokenId),
    ],
  );
  return marketResult.rows.length === 1
    ? (marketResult.rows[0]?.id ?? null)
    : null;
}

async function buildLimitlessAmmFundingHandoffSubmission(input: {
  amountUsdRaw: string;
  marketAddress: string;
  marketId: string;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  tokenId: string;
  transactionData: string;
}): Promise<TelegramAppHandoffV2DirectTradeSubmission | null> {
  let market: LimitlessTradingMarket;
  try {
    market = await loadMarketForVenue(input.pool, input.marketId, "limitless");
  } catch {
    return null;
  }
  const expectedMarketAddress = readLimitlessAmmMarketAddress(market.metadata);
  if (
    !expectedMarketAddress ||
    normalizeAddress(expectedMarketAddress) !==
      normalizeAddress(input.marketAddress)
  ) {
    return null;
  }
  const rawTokenId = normalizeLimitlessRawTokenId(input.tokenId);
  const scopedTokenId = rawTokenId
    ? normalizeLimitlessScopedTokenId(rawTokenId)
    : null;
  const expectedOutcomeIndex =
    rawTokenId && normalizeLimitlessRawTokenId(market.token_yes) === rawTokenId
      ? 0n
      : rawTokenId &&
          normalizeLimitlessRawTokenId(market.token_no) === rawTokenId
        ? 1n
        : null;
  if (!rawTokenId || !scopedTokenId || expectedOutcomeIndex == null) {
    return null;
  }
  try {
    const decoded = LIMITLESS_AMM_IFACE.parseTransaction({
      data: input.transactionData,
    });
    if (!decoded || decoded.name !== "buy") return null;
    const investmentRaw = BigInt(decoded.args[0]);
    const outcomeIndex = BigInt(decoded.args[1]);
    const minimumReceiveRaw = BigInt(decoded.args[2]);
    if (
      investmentRaw !== BigInt(input.amountUsdRaw) ||
      outcomeIndex !== expectedOutcomeIndex ||
      minimumReceiveRaw <= 0n
    ) {
      return null;
    }
    return {
      action: "buy",
      executionKind: "amm",
      marketId: input.marketId,
      outcomeTokenId: scopedTokenId,
      receiveRaw: minimumReceiveRaw.toString(),
      signer: input.signer,
      spendRaw: investmentRaw.toString(),
      venue: "limitless",
    };
  } catch {
    return null;
  }
}

export async function claimLimitlessAmmFundingTrade(input: {
  assertTelegramAppHandoffV2Scope?: TelegramAppHandoffV2ScopeAssertion;
  body: LimitlessAmmFundingClaimBody;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}) {
  const marketId = await resolveLimitlessFundingMarketId(input.pool, {
    marketSlug: input.body.marketSlug,
    tokenId: input.body.tokenId,
  });
  if (!marketId) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: { error: "Funding reservation market binding is unavailable" },
    };
  }
  const marketContextId = normalizeLimitlessRawTokenId(input.body.tokenId);
  const tokenId = marketContextId
    ? normalizeLimitlessScopedTokenId(marketContextId)
    : null;
  if (!marketContextId || !tokenId) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: { error: "Funding reservation token binding is unavailable" },
    };
  }
  let consumerIntent: ReturnType<typeof buildFundingTradeConsumerIntent>;
  try {
    consumerIntent = buildFundingTradeConsumerIntent({
      venueId: "limitless",
      marketId,
      marketContextId,
      spend: {
        asset: {
          networkId: "evm:8453",
          assetId: env.limitlessUsdcAddress,
          decimals: 6,
        },
        raw: input.body.amountUsdRaw,
      },
    });
  } catch {
    return {
      ok: false as const,
      statusCode: 409,
      payload: {
        code: "funding_intent_invalid",
        error: "Funding reservation market binding is unavailable",
      },
    };
  }
  const canonicalFingerprint = canonicalJsonHash({
    amountUsdRaw: input.body.amountUsdRaw,
    executionPath: "limitless_amm",
    marketAddress: input.body.marketAddress.toLowerCase(),
    marketId,
    signer: input.signer.toLowerCase(),
    tokenId: normalizeLimitlessScopedTokenId(input.body.tokenId),
    transactionData: input.body.transactionData.toLowerCase(),
  });
  const directHandoffBinding =
    input.body.telegramAppHandoffId &&
    input.body.telegramAppHandoffPlanFingerprint
      ? {
          handoffId: input.body.telegramAppHandoffId,
          planFingerprint: input.body.telegramAppHandoffPlanFingerprint,
        }
      : null;
  const directHandoffSubmission = directHandoffBinding
    ? await buildLimitlessAmmFundingHandoffSubmission({
        amountUsdRaw: input.body.amountUsdRaw,
        marketAddress: input.body.marketAddress,
        marketId,
        pool: input.pool,
        signer: input.signer,
        tokenId: input.body.tokenId,
        transactionData: input.body.transactionData,
      })
    : null;
  if (
    directHandoffBinding &&
    (!directHandoffSubmission || !input.assertTelegramAppHandoffV2Scope)
  ) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: { error: "Telegram handoff is no longer valid for this trade" },
    };
  }
  try {
    const claim = await claimFundingTradeAttemptForVenueConsumer(input.pool, {
      canonicalFingerprint,
      consumerIntent,
      executionPath: "limitless_amm",
      handoff:
        directHandoffBinding &&
        directHandoffSubmission &&
        input.assertTelegramAppHandoffV2Scope
          ? {
              assertCurrentScope: input.assertTelegramAppHandoffV2Scope,
              binding: directHandoffBinding,
              submission: directHandoffSubmission,
            }
          : null,
      idempotencyKey: input.body.idempotencyKey,
      marketId,
      operationId: input.body.fundingOperationId,
      reservationId: input.body.fundingReservationId,
      userId: input.userId,
      venueId: "limitless",
    });
    if (!claim.claimed) {
      return {
        ok: false as const,
        statusCode: 409,
        payload: {
          error:
            "This funding reservation already has a trade attempt that must reconcile.",
          attemptId: claim.attempt.id,
          state: claim.attempt.state,
        },
      };
    }
    return {
      ok: true as const,
      payload: {
        ok: true,
        attemptId: claim.attempt.id,
        claimToken: claim.attempt.claimToken,
        state: claim.attempt.state,
      },
    };
  } catch (error) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: toPublicFundingTradeError(error),
    };
  }
}

export async function recordLimitlessAmmFundingTradeOutcome(input: {
  attemptId: string;
  errorCode?: string | null;
  outcome: "ambiguous" | "not_broadcast";
  pool: ApiTradingApplicationServiceInput["pool"];
  txHash?: string | null;
  userId: string;
}) {
  try {
    const attempt = await recordFundingTradeAttemptOutcome(input.pool, {
      userId: input.userId,
      attemptId: input.attemptId,
      outcome:
        input.outcome === "ambiguous" ? "ambiguous" : "definitive_failure",
      externalReference: input.txHash,
      errorCode: input.errorCode,
      broadcastMayHaveOccurred: input.outcome === "ambiguous",
    });
    return {
      ok: true as const,
      payload: { ok: true, attemptId: attempt.id, state: attempt.state },
    };
  } catch (error) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: toPublicFundingTradeError(error),
    };
  }
}

export async function startLimitlessAmmFundingTrade(input: {
  attemptId: string;
  claimToken: string;
  fundingOperationId: string;
  fundingReservationId: string;
  pool: ApiTradingApplicationServiceInput["pool"];
  userId: string;
}) {
  try {
    const attempt = await markFundingTradeAttemptSubmissionStarted(input.pool, {
      userId: input.userId,
      operationId: input.fundingOperationId,
      reservationId: input.fundingReservationId,
      attemptId: input.attemptId,
      claimToken: input.claimToken,
    });
    return {
      ok: true as const,
      payload: { ok: true, attemptId: attempt.id, state: attempt.state },
    };
  } catch (error) {
    return {
      ok: false as const,
      statusCode: 409,
      payload: toPublicFundingTradeError(error),
    };
  }
}

/**
 * Broadcast one client-signed AMM trade for a sealed v2 handoff.
 *
 * The raw transaction is validated and its deterministic hash is durably
 * claimed before the RPC broadcast.  This is intentionally not the legacy
 * `/orders/amm` receipt recorder: a post-broadcast callback alone cannot
 * recover a Mini App that closes between wallet send and HTTP return.
 */
export async function broadcastLimitlessAmmTelegramAppHandoffTrade(input: {
  assertTelegramAppHandoffV2Scope?: TelegramAppHandoffV2ScopeAssertion;
  body: LimitlessAmmHandoffBroadcastBody;
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  signer: string;
  userId: string;
}): Promise<
  | {
      ok: true;
      payload: {
        ok: true;
        retrySameSignedTransaction?: true;
        status: "submitted" | "reconciling";
        txHash: string;
      };
    }
  | { ok: false; statusCode: number; payload: { error: string } }
> {
  const signer = toChecksumAddress(input.signer);
  const binding: TelegramAppHandoffV2DirectTradeBinding = {
    handoffId: input.body.telegramAppHandoffId,
    planFingerprint: input.body.telegramAppHandoffPlanFingerprint,
  };
  if (!signer || !input.assertTelegramAppHandoffV2Scope) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "A sealed AMM trade requires an authenticated EVM wallet.",
      },
    };
  }

  let transaction: ethers.Transaction;
  try {
    transaction = ethers.Transaction.from(input.body.signedTransaction);
  } catch {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "The AMM transaction is not a signed EVM transaction.",
      },
    };
  }
  const txHash = transaction.hash;
  if (
    !txHash ||
    !transaction.from ||
    normalizeAddress(transaction.from) !== normalizeAddress(signer) ||
    transaction.chainId !== BigInt(LIMITLESS_CHAIN_ID) ||
    transaction.value !== 0n
  ) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error:
          "The signed AMM transaction does not match this wallet or network.",
      },
    };
  }

  const rawTokenId = normalizeLimitlessRawTokenId(input.body.tokenId);
  const tokenId = rawTokenId
    ? normalizeLimitlessScopedTokenId(rawTokenId)
    : null;
  const marketId = rawTokenId
    ? await resolveLimitlessFundingMarketId(input.pool, {
        marketSlug: input.body.marketSlug,
        tokenId: rawTokenId,
      })
    : null;
  if (!rawTokenId || !tokenId || !marketId) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "The sealed AMM market or outcome is unavailable." },
    };
  }

  let market: LimitlessTradingMarket;
  try {
    market = await loadMarketForVenue(input.pool, marketId, "limitless");
  } catch {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "The sealed AMM market is no longer available." },
    };
  }
  const marketAddress = readLimitlessAmmMarketAddress(market.metadata);
  // The token, rather than a label, is the durable outcome identity.  Derive
  // the AMM index from that token and reject a transaction for any other leg.
  const expectedOutcomeIndex =
    normalizeLimitlessRawTokenId(market.token_yes) === rawTokenId
      ? 0
      : normalizeLimitlessRawTokenId(market.token_no) === rawTokenId
        ? 1
        : null;
  if (
    !isLimitlessAmmMarketMetadata(market.metadata) ||
    !marketAddress ||
    expectedOutcomeIndex == null ||
    !transaction.to ||
    normalizeAddress(transaction.to) !== normalizeAddress(marketAddress)
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        error:
          "The signed transaction is not for the sealed Limitless AMM market.",
      },
    };
  }

  let action: "BUY" | "SELL" = "BUY";
  let sourceRaw = 0n;
  let destinationRaw = 0n;
  try {
    const decoded = LIMITLESS_AMM_IFACE.parseTransaction({
      data: transaction.data,
      value: transaction.value,
    });
    if (!decoded || (decoded.name !== "buy" && decoded.name !== "sell")) {
      throw new Error("not_trade");
    }
    action = decoded.name === "sell" ? "SELL" : "BUY";
    const firstAmount = BigInt(decoded.args[0]);
    const decodedOutcomeIndex = BigInt(decoded.args[1]);
    const thirdAmount = BigInt(decoded.args[2]);
    if (
      firstAmount <= 0n ||
      thirdAmount <= 0n ||
      decodedOutcomeIndex !== BigInt(expectedOutcomeIndex)
    ) {
      throw new Error("out_of_scope");
    }
    // buy(investment, outcome, minShares), sell(minReturn, outcome, maxShares)
    sourceRaw = action === "BUY" ? firstAmount : thirdAmount;
    destinationRaw = action === "BUY" ? thirdAmount : firstAmount;
  } catch {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "The signed transaction is not the exact sealed AMM trade.",
      },
    };
  }

  const amountUsd =
    Number(action === "BUY" ? sourceRaw : destinationRaw) / USDC_SCALE;
  const size =
    Number(action === "BUY" ? destinationRaw : sourceRaw) / USDC_SCALE;
  if (!Number.isFinite(amountUsd) || !Number.isFinite(size) || size <= 0) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: "The AMM transaction amount is outside supported bounds.",
      },
    };
  }
  const submission: TelegramAppHandoffV2DirectTradeSubmission = {
    action: action === "SELL" ? "sell" : "buy",
    executionKind: "amm",
    marketId,
    outcomeTokenId: tokenId,
    receiveRaw: destinationRaw.toString(),
    signer,
    spendRaw: sourceRaw.toString(),
    venue: "limitless",
  };
  if (
    !(await venueLifecycleAllowsTradingAction(input.pool, "limitless", action))
  ) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Limitless trading action is temporarily disabled" },
    };
  }
  try {
    await claimTelegramAppHandoffV2DirectTradeSubmission(input.pool, {
      assertCurrentScope: input.assertTelegramAppHandoffV2Scope,
      binding,
      reconcileKeys: { orderHash: txHash, tradeType: "amm" },
      recoveryPayload: {
        allowanceRaw: "0",
        amountUsd,
        action,
        amountUsdRaw: (action === "BUY"
          ? sourceRaw
          : destinationRaw
        ).toString(),
        approvalAmountRaw: action === "BUY" ? sourceRaw.toString() : "0",
        approvalRequired: false,
        kind: "limitless",
        marketAddress,
        minimumDestinationRaw: destinationRaw.toString(),
        outcomeIndex: expectedOutcomeIndex,
        price: amountUsd / size,
        sharesRaw: (action === "BUY" ? destinationRaw : sourceRaw).toString(),
        size,
        tokenId,
        tradeType: "amm",
      },
      ...(action === "SELL"
        ? {
            readSellPositionAvailableRaw: async () =>
              (
                await resolveLimitlessAvailablePositionRaw({
                  pool: input.pool,
                  signer,
                  tokenId: rawTokenId,
                  userId: input.userId,
                })
              ).availableRaw.toString(),
          }
        : {}),
      submission,
      userId: input.userId,
    });
  } catch {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Telegram handoff is no longer valid for this trade." },
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(env.baseRpcUrl);
    const broadcast = await provider.broadcastTransaction(
      input.body.signedTransaction,
    );
    if (broadcast.hash.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("RPC returned a different transaction hash");
    }
  } catch (error) {
    // A lost RPC response can still mean the signed transaction was accepted.
    // Its hash was recorded before this call, so reconciliation—not a second
    // trade—owns the next step.
    input.log?.warn?.(
      { error, txHash, userId: input.userId },
      "Limitless AMM handoff broadcast outcome is ambiguous",
    );
    return {
      ok: true,
      payload: {
        ok: true,
        retrySameSignedTransaction: true,
        status: "reconciling",
        txHash,
      },
    };
  }

  try {
    const recorded = await recordLimitlessAmmOrder({
      body: {
        amountUsd,
        marketSlug: input.body.marketSlug,
        price: amountUsd / size,
        side: action,
        size,
        tokenId,
        txHash,
      },
      log: input.log,
      onchainConfirmed: false,
      pool: input.pool,
      settlementMode: "confirmed",
      signer,
      telegramAppHandoffV2DirectTrade: { ...binding, ...submission },
      userId: input.userId,
    });
    if (!recorded.ok) {
      const knownRevert = recorded.payload.error
        .toLowerCase()
        .includes("failed onchain");
      if (knownRevert) {
        try {
          await failTelegramAppHandoffV2DirectTradeSubmission(input.pool, {
            binding,
            reason: {
              code: "limitless_amm_reverted",
              message: `The sealed Limitless AMM ${action === "SELL" ? "Sell" : "Buy"} reverted onchain.`,
            },
            submission,
            userId: input.userId,
          });
        } catch (error) {
          input.log?.warn?.(
            { error, txHash, userId: input.userId },
            "Limitless AMM handoff revert awaits reconciliation",
          );
          return {
            ok: true,
            payload: { ok: true, status: "reconciling", txHash },
          };
        }
        return {
          ok: false,
          statusCode: recorded.statusCode,
          payload: recorded.payload,
        };
      }
      input.log?.warn?.(
        { error: recorded.payload.error, txHash, userId: input.userId },
        "Limitless AMM handoff record is awaiting reconciliation",
      );
      return { ok: true, payload: { ok: true, status: "reconciling", txHash } };
    }
  } catch (error) {
    input.log?.warn?.(
      { error, txHash, userId: input.userId },
      "Limitless AMM handoff broadcast persisted for reconciliation",
    );
    return { ok: true, payload: { ok: true, status: "reconciling", txHash } };
  }
  return { ok: true, payload: { ok: true, status: "submitted", txHash } };
}

export async function recordLimitlessAmmOrder(input: {
  body: LimitlessAmmOrderBody;
  log?: LimitlessRouteLogger | null;
  onchainConfirmed?: boolean;
  pool: ApiTradingApplicationServiceInput["pool"];
  settlementMode?: "confirmed" | "legacy_assume_filled";
  source?: Record<string, unknown> | null;
  fundingReservation?: TradeIntent["fundingReservation"];
  fundingTradeAttemptId?: string | null;
  telegramAppHandoffV2DirectTrade?:
    | (TelegramAppHandoffV2DirectTradeBinding &
        TelegramAppHandoffV2DirectTradeSubmission)
    | null;
  signer: string;
  userId: string;
}): Promise<LimitlessAmmRecordRouteResult> {
  const signer = input.signer;
  if (!isEvmWallet(signer)) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Limitless AMM order requires an EVM wallet address" },
    };
  }

  const tokenId = normalizeLimitlessScopedTokenId(input.body.tokenId);
  if (!tokenId) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "tokenId is required" },
    };
  }

  const side = input.body.side;
  if (input.telegramAppHandoffV2DirectTrade && input.fundingReservation) {
    return {
      ok: false,
      statusCode: 409,
      payload: {
        error:
          "A direct Telegram handoff cannot also consume a funding reservation",
      },
    };
  }
  if (input.fundingReservation && side !== "BUY") {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Funding reservations can only be linked to buys" },
    };
  }
  if (input.fundingReservation && !input.fundingTradeAttemptId) {
    return {
      ok: false,
      statusCode: 409,
      payload: { error: "Funding trade attempt claim is required" },
    };
  }
  const size = input.body.size;
  const amountUsd = input.body.amountUsd ?? null;
  let price = input.body.price ?? null;
  if (price == null && amountUsd != null && size > 0) {
    price = amountUsd / size;
  }
  if (price != null && (!Number.isFinite(price) || price <= 0)) {
    price = null;
  }

  const txHash = input.body.txHash;
  const settlementMode = input.settlementMode ?? "confirmed";
  let onchainConfirmed =
    settlementMode === "legacy_assume_filled" ||
    input.onchainConfirmed === true;
  if (settlementMode === "confirmed" && input.onchainConfirmed !== true) {
    try {
      await waitForEmbeddedEthereumTransactionReceipt({
        chainId: LIMITLESS_CHAIN_ID,
        context: "Limitless AMM order",
        timeoutMs: 15_000,
        txHash,
      });
      onchainConfirmed = true;
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Limitless AMM transaction is not confirmed yet.";
      if (message.toLowerCase().includes("failed onchain")) {
        return {
          ok: false,
          statusCode: 409,
          payload: { error: message },
        };
      }
      input.log?.warn?.(
        { error, txHash, userId: input.userId, walletAddress: signer },
        "Limitless AMM transaction not confirmed yet; recording pending order",
      );
    }
  }
  const venueOrderId = `amm:${txHash}:${tokenId}`;
  const now = new Date();
  const status = onchainConfirmed ? "filled" : "submitted";
  const filledAt = onchainConfirmed ? now : null;

  const stored = await storeOrder(input.pool, {
    userId: input.userId,
    walletAddress: signer,
    signerAddress: signer,
    venue: "limitless",
    venueOrderId,
    tokenId,
    side,
    orderType: "FOK",
    price,
    size,
    status,
    errorMessage: null,
    rawError: null,
    orderPayload: {
      ...input.body,
      ...(input.source ?? {}),
      onchainConfirmed,
      settlementMode,
      tokenId,
      price,
    },
    orderHash: txHash,
    fundingReservation: input.fundingReservation,
    fundingTradeAttemptId: input.fundingTradeAttemptId,
    telegramAppHandoffV2DirectTrade:
      input.telegramAppHandoffV2DirectTrade ?? null,
    postedAt: now,
    lastUpdate: now,
    filledAt,
  });
  if (onchainConfirmed) {
    await input.pool.query(
      `
        update orders
        set status = 'filled',
            filled_at = coalesce(filled_at, $2),
            last_update = greatest(coalesce(last_update, $2), $2)
        where id = $1
          and status is distinct from 'filled'
      `,
      [stored.order.id, now],
    );
  }

  const referralFirstTrade =
    onchainConfirmed && stored.kind === "stored"
      ? await tryRecordReferralFirstTradeConversion(input.pool, {
          userId: input.userId,
          venue: "limitless",
          status: "filled",
          sourceType: "amm",
          sourceId: venueOrderId,
          txHash,
          logger: input.log,
        })
      : null;

  const fallbackNotional =
    amountUsd != null && Number.isFinite(amountUsd) && amountUsd > 0
      ? amountUsd
      : price != null && Number.isFinite(price) && price > 0
        ? price * size
        : null;
  if (onchainConfirmed && fallbackNotional != null) {
    try {
      await recordLimitlessVolumeEvent(input.pool, {
        userId: input.userId,
        walletAddress: signer,
        sourceId: venueOrderId,
        notionalUsd: fallbackNotional,
        createdAt: now,
      });
    } catch (error) {
      input.log?.warn?.(
        {
          error,
          userId: input.userId,
          walletAddress: signer,
          orderId: venueOrderId,
        },
        "Limitless AMM volume event insert failed",
      );
    }
    try {
      await applyOptimisticPositionTradeOnce(input.pool, {
        orderId: stored.order.id,
        userId: input.userId,
        walletAddress: signer,
        venue: "limitless",
        tokenId,
        side,
        shares: size,
        notionalUsd: fallbackNotional,
      });
    } catch (error) {
      input.log?.warn?.(
        {
          error,
          userId: input.userId,
          walletAddress: signer,
          tokenId,
          side,
        },
        "Limitless AMM optimistic position update failed",
      );
    }
  }

  if (onchainConfirmed) {
    try {
      const rawTokenId = normalizeLimitlessRawTokenId(tokenId);
      if (rawTokenId) {
        const balanceMap = await fetchErc1155BalancesByOwner({
          rpcUrl: env.baseRpcUrl,
          timeoutMs: env.baseRpcTimeoutMs,
          contractAddress: env.limitlessConditionalTokensAddress,
          owner: signer,
          tokenIds: [rawTokenId],
        });
        const exactRawBalance = balanceMap.get(rawTokenId) ?? 0n;
        const exactSize = Number(ethers.formatUnits(exactRawBalance, 6));
        const buyStaleTolerance = Math.max(0.01, size * 0.02);
        const likelyStaleBuyBalance =
          side === "BUY" && exactSize + buyStaleTolerance < size;
        if (!likelyStaleBuyBalance) {
          await reconcileExactPositionBalance(input.pool, {
            userId: input.userId,
            walletAddress: signer,
            venue: "limitless",
            tokenId,
            size: exactSize,
            averagePrice: price,
          });
        }
      }
    } catch (error) {
      input.log?.warn?.(
        {
          error,
          userId: input.userId,
          walletAddress: signer,
          tokenId,
          side,
        },
        "Limitless AMM exact position reconciliation failed",
      );
    }
  }

  if (onchainConfirmed) {
    void createNotificationSafe(
      input.pool,
      buildOrderNotification({
        userId: input.userId,
        venue: "limitless",
        status: "filled",
        action: side,
        size,
        price: price ?? null,
        orderId: venueOrderId,
        tokenId,
        walletAddress: signer,
      }),
      input.log as never,
    );
  }

  return {
    ok: true,
    payload: {
      dbOrderId: stored.order.id,
      onchainConfirmed,
      ok: true,
      orderId: venueOrderId,
      referralFirstTrade: referralFirstTrade ?? undefined,
      status,
    },
  };
}

export function isLimitlessBotClobExecutable(): boolean {
  return false;
}

type LimitlessTradingMarket = Awaited<ReturnType<typeof loadMarketForVenue>>;

function readLimitlessAmmMarketAddress(metadata: unknown): string | null {
  if (!isRecord(metadata)) return null;
  return toChecksumAddress(
    readString(metadata.address) ??
      readString(metadata.marketAddress) ??
      readString(metadata.market_address) ??
      readString(metadata.ammAddress) ??
      readString(metadata.amm_address),
  );
}

function resolveLimitlessAmmOutcomeIndex(
  market: LimitlessTradingMarket,
  side: "NO" | "YES",
): number | null {
  const selected = normalizeLimitlessRawTokenId(tokenForSide(market, side));
  const yes = normalizeLimitlessRawTokenId(market.token_yes);
  const no = normalizeLimitlessRawTokenId(market.token_no);
  if (selected && yes && selected === yes) return 0;
  if (selected && no && selected === no) return 1;
  return side === "YES" ? 0 : 1;
}

function amountUsdRawValue(intent: TradeIntent): bigint {
  const amount = amountUsd(intent);
  const raw = Math.floor(amount * USDC_SCALE + 1e-9);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Trade amount must be positive.",
      venue: "limitless",
    });
  }
  return BigInt(raw);
}

function amountSharesRawValue(intent: TradeIntent): bigint {
  if (isRecord(intent.raw)) {
    const raw = readString(intent.raw.sharesRaw);
    if (raw && /^\d+$/u.test(raw) && BigInt(raw) > 0n) return BigInt(raw);
  }
  if (intent.amount.type !== "shares") {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Sell quantity must be expressed as shares.",
      venue: "limitless",
    });
  }
  try {
    const raw = ethers.parseUnits(intent.amount.value, 6);
    if (raw > 0n) return raw;
  } catch {
    // Handled by the common public error below.
  }
  throw tradingError({
    code: "invalid_trade_request",
    message: "Sell quantity must be positive.",
    venue: "limitless",
  });
}

function amountFromRaw(raw: bigint): number {
  return Number(raw) / USDC_SCALE;
}

export async function resolveLimitlessAvailablePositionRaw(inputs: {
  pool: Pick<Pool, "query">;
  signer: string;
  tokenId: string;
  userId: string;
}): Promise<{
  availableRaw: bigint;
  balanceRaw: bigint;
  lockedRaw: bigint;
  signer: string;
}> {
  const signer = toChecksumAddress(inputs.signer);
  const tokenId = normalizeLimitlessRawTokenId(inputs.tokenId);
  if (!signer || !tokenId) {
    throw new Error(
      "Limitless sell position requires an EVM wallet and token.",
    );
  }
  const [balances, locks] = await Promise.all([
    fetchErc1155BalancesByOwner({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      contractAddress: env.limitlessConditionalTokensAddress,
      owner: signer,
      tokenIds: [tokenId],
    }),
    fetchOpenOrderPositionLocks(inputs.pool, {
      userId: inputs.userId,
      venue: "limitless",
      wallet: signer,
    }),
  ]);
  const balanceRaw = balances.get(tokenId) ?? 0n;
  const lockKey = `${signer.toLowerCase()}:${tokenId}`;
  const lockedRaw = locks.get(lockKey) ?? 0n;
  return {
    availableRaw: balanceRaw > lockedRaw ? balanceRaw - lockedRaw : 0n,
    balanceRaw,
    lockedRaw,
    signer,
  };
}

function applySlippageDown(value: bigint, bps: number): bigint {
  if (bps <= 0) return value;
  return (value * BigInt(10_000 - bps)) / 10_000n;
}

function encodeLimitlessAmmUsdcApproval(spender: string, amount: bigint) {
  return ERC20_IFACE.encodeFunctionData("approve", [spender, amount]);
}

function encodeLimitlessAmmBuy(input: {
  amountUsdRaw: bigint;
  minOutcomeTokensRaw: bigint;
  outcomeIndex: number;
}) {
  return LIMITLESS_AMM_IFACE.encodeFunctionData("buy", [
    input.amountUsdRaw,
    BigInt(input.outcomeIndex),
    input.minOutcomeTokensRaw,
  ]);
}

async function sendLimitlessServerEvmTransaction(input: {
  data: string;
  label: string;
  onSubmitted?: (txHash: string) => Promise<void> | void;
  signer: string;
  to: string;
  walletId: string;
}): Promise<string> {
  try {
    return await executeServerEmbeddedEthereumTransaction({
      chainId: LIMITLESS_CHAIN_ID,
      signer: input.signer,
      onSubmitted: input.onSubmitted,
      timeoutMs: LIMITLESS_AMM_RECEIPT_WAIT_MS,
      transaction: {
        data: input.data,
        id: input.label.toLowerCase().replace(/\s+/g, "-"),
        label: input.label,
        sponsor: true,
        to: input.to,
      },
      walletClient: createServerWalletClient(),
      walletId: input.walletId,
    });
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim()
        ? error.message
        : `${input.label} was not confirmed onchain.`;
    throw tradingError({
      code: "trade_submission_failed",
      message,
      statusCode: message.includes("did not return a transaction hash")
        ? 502
        : 504,
      venue: "limitless",
    });
  }
}

type LimitlessAmmSubmitDependencies = {
  fetchOnchainSnapshot: typeof fetchLimitlessOnchainSnapshot;
  sendTransaction: typeof sendLimitlessServerEvmTransaction;
};

const limitlessAmmSubmitDependencies: LimitlessAmmSubmitDependencies = {
  fetchOnchainSnapshot: fetchLimitlessOnchainSnapshot,
  sendTransaction: sendLimitlessServerEvmTransaction,
};

function buildLimitlessConnectionReadiness(input: {
  autoRepairable: boolean;
  code: "limitless_connect_required" | "limitless_reconnect_required";
  message: string;
}): TradingReadiness {
  return readiness("limitless", capabilities, {
    ok: false,
    code: input.code,
    message: input.message,
    repair: {
      kind: input.autoRepairable ? "auto" : "app_required",
      code: input.code,
      message: input.message,
      sideEffect: "connection",
    },
    setupRequired: true,
  });
}

function evaluateLimitlessBalanceReadiness(usdcBalance: bigint) {
  const maxExecutableBuyUsd = Number(usdcBalance) / USDC_SCALE;
  if (usdcBalance <= 0n) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "limitless_no_executable_funds",
      maxExecutableBuyUsd: 0,
      message: "No Limitless USDC funds are available for bot trading.",
      setupRequired: true,
    });
  }
  return readiness("limitless", capabilities, {
    ok: true,
    maxExecutableBuyUsd,
  });
}

function limitlessClobBotTradingDisabledReadiness(
  input: {
    maxExecutableBuyUsd?: number;
  } = {},
): TradingReadiness {
  return readiness("limitless", capabilities, {
    ok: false,
    code: "limitless_clob_slippage_guard_unavailable",
    message:
      "Limitless CLOB bot trading is disabled until slippage can be enforced by the submitted order.",
    ...(input.maxExecutableBuyUsd == null
      ? {}
      : { maxExecutableBuyUsd: input.maxExecutableBuyUsd }),
  });
}

async function observeLimitlessWalletUsdcBalance(input: {
  ctx: ApiTradingApplicationServiceInput;
  walletAddress: string;
}): Promise<number | null> {
  try {
    const snapshot = await fetchLimitlessOnchainSnapshot({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      owner: input.walletAddress,
    });
    const balanceUsd = Number(snapshot.usdcBalance) / USDC_SCALE;
    return Number.isFinite(balanceUsd) && balanceUsd >= 0 ? balanceUsd : null;
  } catch (error) {
    input.ctx.logger?.warn?.(
      {
        error,
        walletAddress: input.walletAddress,
      },
      "Limitless app-handoff balance observation failed",
    );
    return null;
  }
}

async function getReadiness(
  ctx: ApiTradingApplicationServiceInput,
  input: TradingReadinessInput,
): Promise<TradingReadiness> {
  let targetAmmAddress: string | null = null;
  if (input.action && input.action !== "BUY") {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "unsupported_capability",
      message: "Telegram bot trading currently supports buy only.",
    });
  }
  if (!input.privyWalletId) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Selected wallet is missing a Privy wallet id.",
      setupRequired: true,
    });
  }
  if (!hasServerWalletClientConfig()) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Server-side Privy wallet authorization is not configured.",
      setupRequired: true,
    });
  }
  if (input.walletChain !== "ethereum" || !input.walletAddress) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Limitless bot trading requires a verified EVM Trading Wallet.",
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
    return readiness("limitless", capabilities, {
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
      "limitless",
    );
    if (isLimitlessAmmMarketMetadata(market.metadata)) {
      const marketAddress = readLimitlessAmmMarketAddress(market.metadata);
      if (!marketAddress || !market.token_yes || !market.token_no) {
        return readiness("limitless", capabilities, {
          ok: false,
          code: "insufficient_readiness",
          message: "Limitless AMM market is missing onchain routing data.",
        });
      }
      targetAmmAddress = marketAddress;
    } else if (!market.slug || !market.token_yes || !market.token_no) {
      return readiness("limitless", capabilities, {
        ok: false,
        code: "insufficient_readiness",
        message: "Limitless market is missing CLOB routing data.",
      });
    }
    if (!isOrderable(market)) {
      return readiness("limitless", capabilities, {
        ok: false,
        code: "market_not_orderable",
        message: "Market is not currently open for orders.",
      });
    }
    if (
      !isLimitlessAmmMarketMetadata(market.metadata) &&
      input.actor.kind === "telegram_bot" &&
      !isLimitlessBotClobExecutable()
    ) {
      const maxExecutableBuyUsd = await observeLimitlessWalletUsdcBalance({
        ctx,
        walletAddress: input.walletAddress,
      });
      return limitlessClobBotTradingDisabledReadiness({
        ...(maxExecutableBuyUsd == null ? {} : { maxExecutableBuyUsd }),
      });
    }
  }
  if (!isLimitlessPartnerHmacConfigured()) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "limitless_partner_auth_unconfigured",
      message: "Limitless partner auth is not configured.",
      setupRequired: true,
    });
  }
  const authContext = await resolveLimitlessAuthContext(
    input.actor.userId,
    input.walletAddress,
  );
  if (!authContext) {
    const code = "limitless_connect_required";
    const message = "Connect Limitless before bot trading.";
    const autoRepairable = Boolean(
      input.executionAuthorization?.privyUserId?.trim(),
    );
    return buildLimitlessConnectionReadiness({
      autoRepairable,
      code,
      message,
    });
  }
  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: input.walletAddress,
  });
  if (!verification.ok) {
    const code = "limitless_reconnect_required";
    const message = verification.message ?? "Limitless account is not ready.";
    const autoRepairable = Boolean(
      input.executionAuthorization?.privyUserId?.trim(),
    );
    return buildLimitlessConnectionReadiness({
      autoRepairable,
      code,
      message,
    });
  }
  if (targetAmmAddress || !input.target?.marketId) {
    try {
      const snapshot = await fetchLimitlessOnchainSnapshot({
        rpcUrl: env.baseRpcUrl,
        timeoutMs: env.baseRpcTimeoutMs,
        owner: input.walletAddress,
        ammAddress: targetAmmAddress,
      });
      return evaluateLimitlessBalanceReadiness(snapshot.usdcBalance);
    } catch (error) {
      ctx.logger?.warn?.(
        {
          error,
          userId: input.actor.userId,
          walletAddress: input.walletAddress,
        },
        "Limitless bot balance readiness check failed",
      );
      return readiness("limitless", capabilities, {
        ok: false,
        code: "limitless_balance_status_unavailable",
        message: "Limitless balance status is temporarily unavailable.",
      });
    }
  }
  return readiness("limitless", capabilities, { ok: true });
}

async function ensureReadiness(
  ctx: ApiTradingApplicationServiceInput,
  input: EnsureReadinessInput,
): Promise<EnsureReadinessResult> {
  const initial = input.existingReadiness ?? (await getReadiness(ctx, input));
  if (initial.executable || initial.repair?.kind !== "auto") {
    return { readiness: initial, changed: false, sideEffects: [] };
  }

  const signer = toChecksumAddress(input.walletAddress);
  const walletId =
    input.executionAuthorization?.privyWalletId?.trim() ??
    input.privyWalletId?.trim() ??
    "";
  if (!signer || !walletId) {
    return { readiness: initial, changed: false, sideEffects: [] };
  }

  const sideEffects: EnsureReadinessResult["sideEffects"] = [];
  let repairError: unknown = null;
  try {
    await assertServerEvmWalletAuthorization({
      privyUserId: input.executionAuthorization?.privyUserId,
      signer,
      venue: "limitless",
      walletId,
    });
    const signingMessageResult = await fetchLimitlessSigningMessageRoute();
    if (!signingMessageResult.ok) {
      throw tradingError({
        code: "insufficient_readiness",
        message:
          readString(signingMessageResult.payload.error) ??
          "Limitless signing message is unavailable.",
        statusCode: signingMessageResult.statusCode,
        venue: "limitless",
      });
    }
    const signingMessage = readString(signingMessageResult.payload.message);
    if (!signingMessage) {
      throw tradingError({
        code: "insufficient_readiness",
        message: "Limitless signing message is invalid.",
        statusCode: 502,
        venue: "limitless",
      });
    }
    const signature = await signEvmMessage({
      walletClient: createServerWalletClient(),
      walletId,
      signer,
      message: signingMessage,
    });
    const connected = await connectLimitlessPartnerAccountRoute({
      account: signer,
      clientType: "eoa",
      forceReconnect: initial.reasonCode === "limitless_reconnect_required",
      pool: ctx.pool,
      signature,
      signer,
      signingMessage,
      userId: input.actor.userId,
    });
    if (!connected.ok) {
      throw tradingError({
        code: "insufficient_readiness",
        message: connected.error,
        statusCode: connected.httpStatus,
        venue: "limitless",
      });
    }
    sideEffects.push("connection");
  } catch (error) {
    repairError = error;
  }

  const finalReadiness = await getReadiness(ctx, input).catch(() => initial);
  return {
    readiness: finalReadiness,
    changed: sideEffects.length > 0,
    sideEffects,
    raw: repairError
      ? {
          error:
            repairError instanceof Error
              ? repairError.message
              : "Readiness repair failed",
        }
      : undefined,
  };
}

async function quote(
  ctx: ApiTradingApplicationServiceInput,
  input: TradeQuoteInput,
): Promise<TradeQuote> {
  const intent = input.intent;
  const market = await loadMarketForVenue(
    ctx.pool,
    intent.target.marketId,
    "limitless",
  );
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const action = intent.action;
  if (isLimitlessAmmMarketMetadata(market.metadata)) {
    if (!isOrderable(market)) {
      throw tradingError({
        code: "invalid_trade_request",
        message: "Market is not open for orders.",
        venue: "limitless",
      });
    }
    const marketAddress = readLimitlessAmmMarketAddress(market.metadata);
    const tokenId = normalizeLimitlessScopedTokenId(tokenForSide(market, side));
    const outcomeIndex = resolveLimitlessAmmOutcomeIndex(market, side);
    if (!marketAddress || !tokenId || outcomeIndex == null) {
      throw tradingError({
        code: "insufficient_readiness",
        message: "Limitless AMM routing data is unavailable.",
        venue: "limitless",
      });
    }
    const amountUsdRaw = action === "BUY" ? amountUsdRawValue(intent) : null;
    const amountSharesRaw =
      action === "SELL" ? amountSharesRawValue(intent) : null;
    const ammQuote = await quoteLimitlessAmmTrade({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      marketAddress,
      outcomeIndex,
      side: action,
      amountUsdRaw,
      amountSharesRaw,
    });
    const sharesRaw =
      ammQuote.sharesRaw != null ? BigInt(ammQuote.sharesRaw) : null;
    const returnAmountRaw =
      ammQuote.returnAmountRaw != null
        ? BigInt(ammQuote.returnAmountRaw)
        : null;
    if (
      sharesRaw == null ||
      sharesRaw <= 0n ||
      (action === "SELL" && (returnAmountRaw == null || returnAmountRaw <= 0n))
    ) {
      throw tradingError({
        code: "quote_unavailable",
        message: "Limitless AMM quote is unavailable.",
        venue: "limitless",
      });
    }
    const nominalAmountUsd = action === "BUY" ? amountUsd(intent) : null;
    const estimatedShares = amountFromRaw(sharesRaw);
    const estimatedNotionalUsd =
      action === "BUY"
        ? nominalAmountUsd
        : amountFromRaw(returnAmountRaw ?? 0n);
    const price =
      estimatedShares > 0 && estimatedNotionalUsd != null
        ? estimatedNotionalUsd / estimatedShares
        : null;
    return {
      venue: "limitless",
      target: {
        ...intent.target,
        tokenId,
        raw: { market, marketAddress, outcomeIndex },
      },
      action,
      amount: intent.amount,
      currentPrice: price,
      price,
      estimatedShares,
      estimatedNotionalUsd,
      maxSpendUsd: action === "BUY" ? nominalAmountUsd : null,
      minimumReceiveUsd: action === "SELL" ? estimatedNotionalUsd : null,
      minReceiveShares: action === "BUY" ? estimatedShares : null,
      fees: {},
      expiresAt: new Date(Date.now() + 30_000),
      raw: {
        amountSharesRaw: amountSharesRaw?.toString() ?? null,
        amountUsdRaw: amountUsdRaw?.toString() ?? null,
        kind: "limitless_amm",
        marketAddress,
        outcomeIndex,
        returnAmountRaw: returnAmountRaw?.toString() ?? null,
        sharesRaw: sharesRaw.toString(),
        tokenId,
      },
    };
  }
  const tokenId = normalizeLimitlessRawTokenId(tokenForSide(market, side));
  if (!isOrderable(market)) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Market is not open for orders.",
      venue: "limitless",
    });
  }
  if (!tokenId || !market.slug) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Limitless CLOB routing data is unavailable.",
      venue: "limitless",
    });
  }
  const orderAmountUsd = action === "BUY" ? amountUsd(intent) : null;
  const sharesRaw = action === "SELL" ? amountSharesRawValue(intent) : null;
  const depthQuote = await quoteLimitlessClobMarket({
    ...(action === "BUY"
      ? { amountUsd: orderAmountUsd }
      : { amountShares: amountFromRaw(sharesRaw ?? 0n) }),
    side: action,
    slug: market.slug,
    tokenId,
  });
  if (depthQuote.status !== "ready") {
    throw tradingError({
      code: "quote_unavailable",
      message:
        depthQuote.status === "unavailable"
          ? "Limitless market depth is unavailable."
          : "Limitless market has insufficient immediate liquidity.",
      venue: "limitless",
    });
  }
  const price = depthQuote.averagePrice;
  const estimatedShares = depthQuote.executableShares;
  const estimatedNotionalUsd = depthQuote.totalNotional;
  return {
    venue: "limitless",
    target: { ...intent.target, tokenId, raw: { market } },
    action,
    amount: intent.amount,
    currentPrice: price,
    price,
    estimatedShares,
    estimatedNotionalUsd,
    maxSpendUsd: action === "BUY" ? orderAmountUsd : null,
    minimumReceiveUsd: action === "SELL" ? estimatedNotionalUsd : null,
    minReceiveShares: action === "BUY" ? estimatedShares : null,
    fees: {},
    expiresAt: new Date(Date.now() + 30_000),
    raw: {
      kind: "limitless_clob",
      tokenId,
      totalNotionalUsd: estimatedNotionalUsd,
      worstPrice: depthQuote.worstPrice,
    },
  };
}

function canonicalLimitlessOrderPayload(payload: Record<string, unknown>) {
  return {
    ...payload,
    maker: ethers.getAddress(String(payload.maker)),
    signer: ethers.getAddress(String(payload.signer)),
    taker: ethers.getAddress(String(payload.taker ?? ZERO_ADDRESS)),
    feeRateBps: String(payload.feeRateBps ?? "0"),
  };
}

function digestPreparedPayload(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function deterministicLimitlessClientOrderId(intent: TradeIntent): string {
  return `hunch-${crypto
    .createHash("sha256")
    .update(intent.idempotencyKey)
    .digest("hex")
    .slice(0, 32)}`;
}

async function fetchLimitlessExchangeAddress(input: {
  marketSlug: string;
  requestAuth: Record<string, unknown>;
}): Promise<string | null> {
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(input.marketSlug)}`,
    ...(input.requestAuth as object),
  });
  if (!upstream.ok || !isRecord(upstream.payload)) return null;
  return extractLimitlessMarketExchangeAddress(upstream.payload);
}

async function prepareLimitlessAmmTrade(input: {
  intent: TradeIntent;
  market: LimitlessTradingMarket;
  quote?: TradeQuote | null;
}): Promise<PreparedTrade> {
  const intent = input.intent;
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const signer = toChecksumAddress(intent.walletAddress);
  const marketAddress = readLimitlessAmmMarketAddress(input.market.metadata);
  const tokenId = normalizeLimitlessScopedTokenId(
    tokenForSide(input.market, side),
  );
  const outcomeIndex = resolveLimitlessAmmOutcomeIndex(input.market, side);
  if (!signer || !marketAddress || !tokenId || outcomeIndex == null) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Limitless AMM market or wallet is invalid.",
      venue: "limitless",
    });
  }
  if (!isOrderable(input.market)) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Market is not open for orders.",
      venue: "limitless",
    });
  }

  const authContext = await resolveLimitlessAuthContext(
    intent.actor.userId,
    signer,
  );
  if (!authContext) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Limitless account is not connected.",
      venue: "limitless",
    });
  }
  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: signer,
  });
  if (!verification.ok || !verification.profile?.id) {
    throw tradingError({
      code: "insufficient_readiness",
      message: !verification.ok
        ? (verification.message ?? "Limitless account is not ready.")
        : "Limitless account is not ready.",
      venue: "limitless",
    });
  }

  const amountRaw = amountUsdRawValue(intent);
  const amount = amountUsd(intent);
  let sharesRaw =
    isRecord(input.quote?.raw) && input.quote.raw.kind === "limitless_amm"
      ? BigInt(String(input.quote.raw.sharesRaw ?? "0"))
      : null;
  if (sharesRaw == null || sharesRaw <= 0n) {
    const freshQuote = await quoteLimitlessAmmTrade({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      marketAddress,
      outcomeIndex,
      side: "BUY",
      amountUsdRaw: amountRaw,
      amountSharesRaw: null,
    });
    sharesRaw =
      freshQuote.sharesRaw != null ? BigInt(freshQuote.sharesRaw) : null;
  }
  if (sharesRaw == null || sharesRaw <= 0n) {
    throw tradingError({
      code: "quote_unavailable",
      message: "Limitless AMM quote is unavailable.",
      venue: "limitless",
    });
  }

  const snapshot = await fetchLimitlessOnchainSnapshot({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    owner: signer,
    ammAddress: marketAddress,
  });
  if (snapshot.usdcBalance < amountRaw) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Insufficient USDC balance for this Limitless AMM buy.",
      venue: "limitless",
    });
  }
  const allowanceRaw = snapshot.allowanceAmm ?? 0n;
  const minOutcomeTokensRaw = applySlippageDown(
    sharesRaw,
    intent.slippageBps ?? LIMITLESS_AMM_DEFAULT_SLIPPAGE_BPS,
  );
  const size = amountFromRaw(sharesRaw);
  const price = size > 0 ? amount / size : null;
  const preparedDigest = digestPreparedPayload({
    amountUsdRaw: amountRaw.toString(),
    marketAddress,
    minOutcomeTokensRaw: minOutcomeTokensRaw.toString(),
    outcomeIndex,
    tokenId,
    tradeType: "amm",
  });

  return {
    preparedId: crypto.randomUUID(),
    venue: "limitless",
    intent,
    quote: input.quote ?? null,
    authorizationMode: "embedded_privy_evm",
    authorizationRequests: [],
    reconcileKeys: {
      amountUsdRaw: amountRaw.toString(),
      idempotencyKey: intent.idempotencyKey,
      intentId: intent.id ?? null,
      marketAddress,
      preparedDigest,
      tokenId,
      tradeType: "amm",
      venue: "limitless",
    },
    venuePayload: {
      kind: "limitless",
      allowanceRaw: allowanceRaw.toString(),
      amountUsd: amount,
      amountUsdRaw: amountRaw.toString(),
      approvalAmountRaw: amountRaw.toString(),
      approvalRequired: allowanceRaw < amountRaw,
      marketAddress,
      minOutcomeTokensRaw: minOutcomeTokensRaw.toString(),
      outcomeIndex,
      price,
      sharesRaw: sharesRaw.toString(),
      size,
      tokenId,
      tradeType: "amm",
    } satisfies LimitlessAmmPreparedPayload,
    expiresAt: new Date(Date.now() + 30_000),
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
    "limitless",
  );
  if (isLimitlessAmmMarketMetadata(market.metadata)) {
    return prepareLimitlessAmmTrade({
      intent,
      market,
      quote: input.quote ?? null,
    });
  }
  if (intent.actor.kind === "telegram_bot" && !isLimitlessBotClobExecutable()) {
    throw tradingError({
      code: "unsupported_capability",
      message:
        "Limitless CLOB bot trading is disabled until slippage can be enforced by the submitted order.",
      venue: "limitless",
    });
  }
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const tokenId = normalizeLimitlessRawTokenId(tokenForSide(market, side));
  const signer = toChecksumAddress(intent.walletAddress);
  if (!signer || !tokenId || !market.slug) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Limitless market or wallet is invalid.",
      venue: "limitless",
    });
  }

  const authContext = await resolveLimitlessAuthContext(
    intent.actor.userId,
    signer,
  );
  if (!authContext) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Limitless account is not connected.",
      venue: "limitless",
    });
  }
  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: signer,
  });
  if (!verification.ok || !verification.profile?.id) {
    throw tradingError({
      code: "insufficient_readiness",
      message: !verification.ok
        ? (verification.message ?? "Limitless account is not ready.")
        : "Limitless account is not ready.",
      venue: "limitless",
    });
  }

  const requestAuth = buildLimitlessRequestAuthInputs(authContext);
  const price =
    input.quote?.price ??
    (await bestAskForToken(
      ctx.pool,
      normalizeLimitlessScopedTokenId(tokenId) ?? tokenId,
    ));
  if (!price || price <= 0 || price >= 1) {
    throw tradingError({
      code: "quote_unavailable",
      message: "Limitless quote price is unavailable.",
      venue: "limitless",
    });
  }

  const exchangeAddress =
    extractLimitlessMarketExchangeAddress(market.metadata) ||
    (await fetchLimitlessExchangeAddress({
      marketSlug: market.slug,
      requestAuth,
    }));
  if (!exchangeAddress) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Limitless exchange address is unavailable.",
      venue: "limitless",
    });
  }

  const makerAmount = Math.floor(amountUsd(intent) * USDC_SCALE + 1e-9);
  const order = canonicalLimitlessOrderPayload({
    salt: randomUint256SaltDecimal(),
    maker: signer,
    signer,
    taker: ZERO_ADDRESS,
    tokenId,
    makerAmount,
    takerAmount: 1,
    expiration: "0",
    nonce: "0",
    feeRateBps: verification.profile.rank?.feeRateBps ?? 0,
    side: 0,
    signatureType: 0,
  });
  const signature = await signEvmTypedData({
    walletClient: createServerWalletClient(),
    walletId: getPrivyWalletId(intent),
    signer,
    typedData: {
      domain: {
        name: LIMITLESS_CLOB_EIP712_NAME,
        version: LIMITLESS_CLOB_EIP712_VERSION,
        chainId: LIMITLESS_CHAIN_ID,
        verifyingContract: exchangeAddress,
      },
      types: LIMITLESS_CLOB_ORDER_TYPES,
      primaryType: "Order",
      message: order,
    },
  });
  const size = input.quote?.estimatedShares ?? amountUsd(intent) / price;
  const clientOrderId = deterministicLimitlessClientOrderId(intent);

  return {
    preparedId: crypto.randomUUID(),
    venue: "limitless",
    intent,
    quote: input.quote ?? null,
    authorizationMode: "embedded_privy_evm",
    authorizationRequests: [],
    reconcileKeys: {
      clientOrderId,
      idempotencyKey: intent.idempotencyKey,
      intentId: intent.id ?? null,
      marketSlug: market.slug,
      tokenId: normalizeLimitlessScopedTokenId(tokenId) ?? tokenId,
      tradeType: "clob",
      venue: "limitless",
    },
    venuePayload: {
      clientOrderId,
      kind: "limitless",
      marketSlug: market.slug,
      orderPayload: { ...order, signature },
      orderType: "FOK",
      ownerId: verification.profile.id,
      price,
      requestAuth: requestAuth as unknown as Record<string, unknown>,
      size,
      tokenId: normalizeLimitlessScopedTokenId(tokenId) ?? tokenId,
    } satisfies LimitlessClobPreparedPayload,
    expiresAt: new Date(Date.now() + 30_000),
  };
}

async function submitLimitlessAmmPreparedTrade(
  input: {
    onBroadcastSubmitted?: (submitResult: SubmitResult) => Promise<void> | void;
    onBeforeBroadcast?: () => Promise<void> | void;
    onSetupTransactionSubmitted?: (input: {
      kind: "approval";
      txHash: string;
    }) => Promise<void> | void;
    payload: LimitlessAmmPreparedPayload;
    prepared: PreparedTrade;
  },
  dependencies: LimitlessAmmSubmitDependencies = limitlessAmmSubmitDependencies,
): Promise<SubmitResult> {
  const payload = input.payload;
  const signer = toChecksumAddress(input.prepared.intent.walletAddress);
  const marketAddress = toChecksumAddress(payload.marketAddress);
  if (!signer || !marketAddress) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Limitless AMM prepared trade has an invalid wallet or market.",
      venue: "limitless",
    });
  }
  const amountUsdRaw = BigInt(payload.amountUsdRaw);
  const minOutcomeTokensRaw = BigInt(payload.minOutcomeTokensRaw);
  const walletId = getPrivyWalletId(input.prepared.intent);
  const snapshot = await dependencies.fetchOnchainSnapshot({
    rpcUrl: env.baseRpcUrl,
    timeoutMs: env.baseRpcTimeoutMs,
    owner: signer,
    ammAddress: marketAddress,
  });
  if (snapshot.usdcBalance < amountUsdRaw) {
    throw tradingError({
      code: "insufficient_readiness",
      message: "Insufficient USDC balance for this Limitless AMM buy.",
      venue: "limitless",
    });
  }

  const allowanceRaw = snapshot.allowanceAmm ?? 0n;
  if (allowanceRaw < amountUsdRaw) {
    await dependencies.sendTransaction({
      data: encodeLimitlessAmmUsdcApproval(marketAddress, amountUsdRaw),
      label: "Limitless AMM USDC approval",
      onSubmitted: (txHash) =>
        input.onSetupTransactionSubmitted?.({
          kind: "approval",
          txHash,
        }),
      signer,
      to: env.limitlessUsdcAddress,
      walletId,
    });
    const refreshed = await dependencies.fetchOnchainSnapshot({
      rpcUrl: env.baseRpcUrl,
      timeoutMs: env.baseRpcTimeoutMs,
      owner: signer,
      ammAddress: marketAddress,
    });
    if ((refreshed.allowanceAmm ?? 0n) < amountUsdRaw) {
      throw tradingError({
        code: "insufficient_readiness",
        message: "Limitless AMM approval did not become active.",
        venue: "limitless",
      });
    }
  }

  await input.onBeforeBroadcast?.();
  const txHash = await dependencies.sendTransaction({
    data: encodeLimitlessAmmBuy({
      amountUsdRaw,
      minOutcomeTokensRaw,
      outcomeIndex: payload.outcomeIndex,
    }),
    label: "Limitless AMM buy",
    onSubmitted: async (hash) => {
      await input.onBroadcastSubmitted?.({
        venue: "limitless",
        status: "submitted",
        venueOrderId: `amm:${hash}:${payload.tokenId}`,
        orderHash: hash,
        txSignature: hash,
        price: payload.price,
        size: payload.size,
        raw: { payload, txHash: hash },
      });
    },
    signer,
    to: marketAddress,
    walletId,
  });

  return {
    venue: "limitless",
    status: "filled",
    venueOrderId: `amm:${txHash}:${payload.tokenId}`,
    orderHash: txHash,
    txSignature: txHash,
    price: payload.price,
    size: payload.size,
    raw: { payload, txHash },
  };
}

export const limitlessTradingExecutionTestHooks = {
  buildConnectionReadiness: buildLimitlessConnectionReadiness,
  clobBotTradingDisabledReadiness: limitlessClobBotTradingDisabledReadiness,
  evaluateBalanceReadiness: evaluateLimitlessBalanceReadiness,
  submitAmmPreparedTrade: submitLimitlessAmmPreparedTrade,
};

function parseLimitlessPreparedPayload(
  prepared: PreparedTrade,
): LimitlessPreparedPayload {
  return parsePreparedPayload<LimitlessPreparedPayload>(prepared, "limitless");
}

function isLimitlessAmmPreparedPayload(
  payload: LimitlessPreparedPayload,
): payload is LimitlessAmmPreparedPayload {
  return "tradeType" in payload && payload.tradeType === "amm";
}

async function submitPreparedTrade(
  input: SubmitPreparedTradeInput,
): Promise<SubmitResult> {
  const prepared = input.prepared;
  const payload = parseLimitlessPreparedPayload(prepared);
  if (isLimitlessAmmPreparedPayload(payload)) {
    return submitLimitlessAmmPreparedTrade({
      onBroadcastSubmitted: input.onBroadcastSubmitted,
      onBeforeBroadcast: input.onBeforeBroadcast,
      onSetupTransactionSubmitted: input.onSetupTransactionSubmitted,
      payload,
      prepared,
    });
  }
  if (payload.orderType === "FOK") {
    const orderSide = normalizeOrderSide(payload.orderPayload.side);
    const rawMakerAmount = parseNumberish(payload.orderPayload.makerAmount);
    const preflightAmount = normalizeLimitlessRawAmount(rawMakerAmount);
    const preflightTokenId = normalizeRawLimitlessTokenIdFromUnknown(
      payload.tokenId ?? payload.orderPayload.tokenId,
    );
    if (!orderSide || !preflightAmount || !preflightTokenId) {
      throw tradingError({
        code: "trade_submission_failed",
        message: "Limitless prepared order is invalid.",
        statusCode: 400,
        venue: "limitless",
      });
    }
    const depthQuote = await quoteLimitlessClobMarket({
      ...(orderSide === "BUY"
        ? { amountUsd: preflightAmount }
        : { amountShares: preflightAmount }),
      side: orderSide,
      slug: payload.marketSlug,
      tokenId: preflightTokenId,
    });
    if (depthQuote.status === "unavailable") {
      throw tradingError({
        code: "quote_unavailable",
        message: "Limitless depth quote is temporarily unavailable.",
        statusCode: 502,
        venue: "limitless",
      });
    }
    if (isLimitlessClobDefinitiveNoFill(depthQuote.status)) {
      return {
        venue: "limitless",
        status: "no_fill",
        venueOrderId: null,
        orderHash: null,
        txSignature: null,
        price: payload.price,
        size: payload.size,
        raw: {
          reason: depthQuote.status,
          message:
            depthQuote.status === "insufficient_depth"
              ? "Not enough liquidity to fill this order."
              : "No liquidity is available for this order.",
          prepared: payload,
        },
      };
    }
  }
  await input.onBeforeBroadcast?.();
  const upstream = await submitLimitlessClobOrderToVenue({
    requestAuth: payload.requestAuth,
    body: {
      order: payload.orderPayload,
      orderType: payload.orderType,
      marketSlug: payload.marketSlug,
      ownerId: payload.ownerId,
      onBehalfOf: payload.ownerId,
      clientOrderId: payload.clientOrderId,
    },
  });
  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    if (isLimitlessFokUnmatchedMessage(message)) {
      return {
        venue: "limitless",
        status: "no_fill",
        venueOrderId: extractLimitlessOrderIdFromMessage(message),
        orderHash: null,
        txSignature: null,
        price: payload.price,
        size: payload.size,
        raw: {
          reason: LIMITLESS_FOK_UNMATCHED_REASON,
          message: LIMITLESS_FOK_UNMATCHED_MESSAGE,
          payload: upstream.payload,
          prepared: payload,
        },
      };
    }
    throw tradingError({
      code: "trade_submission_failed",
      message: message ?? "Limitless order placement failed.",
      statusCode: upstream.status >= 500 ? 502 : upstream.status,
      venue: "limitless",
    });
  }

  const submittedOrder = extractLimitlessSubmittedOrder(upstream.payload);
  const parsedResult = parseLimitlessOrderResult(upstream.payload);
  const venueOrderId = submittedOrder.venueOrderId;
  if (parsedResult.explicitNoFill) {
    return {
      venue: "limitless",
      status: "no_fill",
      venueOrderId,
      orderHash: null,
      txSignature: null,
      price: payload.price,
      size: payload.size,
      raw: {
        reason: LIMITLESS_FOK_UNMATCHED_REASON,
        message: LIMITLESS_FOK_UNMATCHED_MESSAGE,
        payload: upstream.payload,
        prepared: payload,
      },
    };
  }
  if (!venueOrderId) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Limitless order placed but no order id returned.",
      statusCode: 502,
      venue: "limitless",
    });
  }
  const executionFill = extractLimitlessExecutionFill(upstream.payload);
  const submitStatus = parsedResult.terminalFill ? "filled" : "submitted";
  const submitPrice = executionFill?.averagePrice ?? payload.price;
  const submitSize = executionFill?.shares ?? payload.size;
  await input.onBroadcastSubmitted?.({
    venue: "limitless",
    status: submitStatus,
    venueOrderId,
    orderHash: parsedResult.txHash,
    txSignature: parsedResult.txHash,
    price: submitPrice,
    size: submitSize,
    raw: { payload: upstream.payload, prepared: payload },
  });
  return {
    venue: "limitless",
    status: submitStatus,
    venueOrderId,
    orderHash: parsedResult.txHash,
    txSignature: parsedResult.txHash,
    price: submitPrice,
    size: submitSize,
    raw: { payload: upstream.payload, prepared: payload },
  };
}

async function persistTrade(
  ctx: ApiTradingApplicationServiceInput,
  input: {
    intent: TradeIntent;
    prepared?: PreparedTrade | null;
    submitResult: SubmitResult;
  },
): Promise<PersistedTrade> {
  const payload = input.prepared
    ? parseLimitlessPreparedPayload(input.prepared)
    : null;
  if (!payload || !input.submitResult.venueOrderId) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Limitless persistence requires a venue order id.",
      venue: "limitless",
    });
  }
  const orderSide = input.intent.action === "SELL" ? "SELL" : "BUY";
  if (isLimitlessAmmPreparedPayload(payload)) {
    const txHash =
      input.submitResult.orderHash ?? input.submitResult.txSignature;
    if (!txHash) {
      throw tradingError({
        code: "trade_submission_failed",
        message: "Limitless AMM persistence requires a transaction hash.",
        venue: "limitless",
      });
    }
    const recorded = await recordLimitlessAmmOrder({
      body: {
        amountUsd: payload.amountUsd,
        marketSlug:
          typeof input.intent.target.venueMarketId === "string"
            ? input.intent.target.venueMarketId
            : undefined,
        price: payload.price ?? undefined,
        side: orderSide,
        size: payload.size,
        tokenId: payload.tokenId,
        txHash,
      },
      log: ctx.logger as LimitlessRouteLogger,
      onchainConfirmed: true,
      pool: ctx.pool,
      source: buildTelegramTradeSourceMetadata(input),
      fundingReservation: input.intent.fundingReservation,
      fundingTradeAttemptId: input.intent.fundingTradeAttemptId,
      signer: input.intent.walletAddress,
      userId: input.intent.actor.userId,
    });
    if (!recorded.ok) {
      throw tradingError({
        code: "trade_submission_failed",
        message: recorded.payload.error,
        statusCode: recorded.statusCode,
        venue: "limitless",
      });
    }
    return {
      venue: "limitless",
      orderId: recorded.payload.dbOrderId,
      executionId: null,
      venueOrderId: recorded.payload.orderId,
      status: "filled",
      raw: {
        effectsApplied: true,
        tokenId: payload.tokenId,
        walletAddress: input.intent.walletAddress,
      },
    };
  }
  const upstreamPayload =
    isRecord(input.submitResult.raw) && "payload" in input.submitResult.raw
      ? input.submitResult.raw.payload
      : input.submitResult.raw;
  const filledAt = input.submitResult.status === "filled" ? new Date() : null;
  const stored = await storeOrder(ctx.pool, {
    userId: input.intent.actor.userId,
    walletAddress: input.intent.walletAddress,
    signerAddress: input.intent.walletAddress,
    venue: "limitless",
    venueOrderId: input.submitResult.venueOrderId,
    tokenId: payload.tokenId,
    side: orderSide,
    orderType: "FOK",
    price: input.submitResult.price ?? payload.price,
    size: input.submitResult.size ?? payload.size,
    status:
      input.submitResult.status === "filled"
        ? "filled"
        : input.submitResult.status === "no_fill"
          ? "expired"
          : "submitted",
    errorMessage:
      input.submitResult.status === "no_fill"
        ? LIMITLESS_FOK_UNMATCHED_MESSAGE
        : null,
    rawError: null,
    orderPayload: {
      ...payload.orderPayload,
      ...buildTelegramTradeSourceMetadata(input),
      _hunchUpstream: upstreamPayload,
    },
    orderHash: input.submitResult.orderHash,
    fundingReservation:
      input.submitResult.status === "no_fill"
        ? null
        : input.intent.fundingReservation,
    fundingTradeAttemptId: input.intent.fundingTradeAttemptId,
    filledAt,
  });
  if (filledAt) {
    await updateOrderFromHistory(ctx.pool, {
      id: stored.order.id,
      status: "filled",
      price: input.submitResult.price ?? payload.price,
      size: input.submitResult.size ?? payload.size,
      filledAt,
      lastUpdate: filledAt,
      orderHash: input.submitResult.orderHash,
    });
  }
  return {
    venue: "limitless",
    orderId: stored.order.id,
    executionId: null,
    venueOrderId: stored.order.venue_order_id,
    status:
      input.submitResult.status === "filled" ? "filled" : stored.order.status,
    raw: {
      stored,
      upstreamPayload,
      filledAt,
      tokenId: payload.tokenId,
      walletAddress: input.intent.walletAddress,
    },
  };
}

async function applyLimitlessTradeEffects(
  ctx: ApiTradingApplicationServiceInput,
  input: ApplyTradeEffectsInput,
): Promise<TradeEffectsResult> {
  if (
    isRecord(input.persisted.raw) &&
    input.persisted.raw.effectsApplied === true
  ) {
    return {
      ok: true,
      notificationsCreated: 1,
      positionDeltaApplied: true,
      raw: { effectsApplied: true },
    };
  }
  if (input.submitResult.status === "filled") {
    const orderSide = input.intent.action === "SELL" ? "SELL" : "BUY";
    const raw = isRecord(input.persisted.raw) ? input.persisted.raw : null;
    const stored = raw && isRecord(raw.stored) ? raw.stored : null;
    const order = stored && isRecord(stored.order) ? stored.order : null;
    const orderId = readString(order?.id);
    const venueOrderId =
      input.submitResult.venueOrderId ?? readString(order?.venue_order_id);
    const tokenId = readString(raw?.tokenId) ?? input.intent.target.tokenId;
    const walletAddress =
      readString(raw?.walletAddress) ?? input.intent.walletAddress;
    const filledAt = raw?.filledAt instanceof Date ? raw.filledAt : new Date();
    const postedAt =
      order?.posted_at instanceof Date ? order.posted_at : filledAt;
    const upstreamPayload = raw?.upstreamPayload;
    if (orderId && venueOrderId && upstreamPayload != null) {
      try {
        await upsertLimitlessVenueShareAccrualFromOrderPayload(ctx.pool, {
          orderId,
          userId: input.intent.actor.userId,
          walletAddress,
          signerAddress: walletAddress,
          venueOrderId,
          orderHash: input.submitResult.orderHash ?? null,
          tokenId,
          side: orderSide,
          filledAt,
          lastUpdate: filledAt,
          postedAt,
          payload: upstreamPayload,
        });
      } catch (error) {
        ctx.logger?.warn?.(
          {
            error,
            intentId: input.intent.id,
            userId: input.intent.actor.userId,
            venueOrderId,
          },
          "Limitless bot venue fee share accrual upsert failed",
        );
      }
    }
  }
  return applyOrderTradeEffects(ctx, input);
}

export function createLimitlessTradingExecutionService(
  ctx: ApiTradingApplicationServiceInput,
): ApiVenueTradingExecutor {
  return {
    venue: "limitless",
    capabilities: () => capabilities,
    ensureReadiness: (input) => ensureReadiness(ctx, input),
    getReadiness: (input) => getReadiness(ctx, input),
    quote: (input) => quote(ctx, input),
    prepareTrade: (input) =>
      prepareTrade(ctx, { intent: input.intent, quote: input.quote ?? null }),
    submitPreparedTrade,
    persistTrade: (input) => persistTrade(ctx, input),
    applyTradeEffects: (input) => applyLimitlessTradeEffects(ctx, input),
    executePreparedTrade: (input) =>
      executePreparedTradeLifecycle({
        executeInput: input,
        submitPreparedTrade,
        persistTrade: (persistInput) => persistTrade(ctx, persistInput),
        applyTradeEffects: (effectsInput) =>
          applyLimitlessTradeEffects(ctx, effectsInput),
      }),
  };
}
