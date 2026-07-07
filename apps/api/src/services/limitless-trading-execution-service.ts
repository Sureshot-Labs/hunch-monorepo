import crypto from "node:crypto";
import { ethers } from "ethers";

import { AuthService } from "../auth.js";
import { env } from "../env.js";
import { isRecord } from "../lib/type-guards.js";
import {
  normalizeLimitlessRawTokenId,
  normalizeLimitlessScopedTokenId,
} from "../lib/limitless-token.js";
import {
  expireStaleLimitlessFokOrders,
  fetchStoredOrderWalletContext,
  markOrderPositionDeltaApplied,
  normalizeLimitlessFokOrderSizesForMarket,
  storeOrder,
} from "../repos/orders-repo.js";
import { buildOrderNotification, createNotificationSafe } from "./notifications.js";
import { tryRecordReferralFirstTradeConversion } from "./analytics-referrals.js";
import {
  applyOptimisticPositionTrade,
  reconcileExactPositionBalance,
} from "./positions-optimistic.js";
import { upsertLimitlessVenueShareAccrualFromOrderPayload } from "./limitless-fee-accruals.js";
import { recordLimitlessVolumeEvent } from "./limitless-volume-events.js";
import { syncLimitlessHistoryForWallet } from "./limitless-history.js";
import { quoteLimitlessAmmTrade } from "./limitless-trading-service.js";
import {
  fetchErc1155BalancesByOwner,
  fetchErc1155IsApprovedForAll,
  fetchEvmCode,
} from "./polygon-rpc.js";
import { fetchLimitlessOnchainSnapshot } from "./limitless-onchain.js";
import { buildLimitlessRedemptionPlan } from "./limitless-redemption-plan.js";
import { fetchConditionalTokensPayouts } from "./limitless-redemption.js";
import { recomputePositionMetricsForWallet } from "./positions-metrics.js";
import {
  amountUsd,
  applyOrderTradeEffects,
  bestAskForToken,
  createCapability,
  createServerWalletClient,
  getPrivyWalletId,
  hasServerWalletClientConfig,
  isOrderable,
  loadMarketForVenue,
  normalizeSide,
  parsePreparedPayload,
  randomUint256SaltDecimal,
  readiness,
  readString,
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
  deriveLimitlessSignedOrderSize,
  normalizeLimitlessMaybeRawAmount,
  normalizeLimitlessRawAmount,
} from "./limitless-order-normalization.js";
import type {
  PersistedTrade,
  PreparedTrade,
  SubmitResult,
  TradeIntent,
  TradeQuote,
  TradeQuoteInput,
  TradingReadiness,
  TradingReadinessInput,
} from "./trading-types.js";

const LIMITLESS_EIP712_NAME = "Limitless CTF Exchange";
const LIMITLESS_EIP712_VERSION = "1";
const LIMITLESS_CHAIN_ID = 8453;
const LIMITLESS_FOK_UNMATCHED_REASON = "market_order_unmatched";
const LIMITLESS_FOK_UNMATCHED_MESSAGE =
  "Order was not filled because no immediate match was available. Nothing was bought or sold. Try again or place a limit order.";
const LIMITLESS_CONNECT_LOCK_PREFIX = "lock:limitless:connect:";
const LIMITLESS_CONNECT_STORED_PROFILE_POLL_DELAYS_MS = [
  100, 250, 500, 1_000,
] as const;
const LIMITLESS_LEGACY_OPERATOR_BY_EXCHANGE: Readonly<Record<string, string>> =
  {
    [normalizeAddress("0x5a38afc17F7E97ad8d6C547ddb837E40B4aEDfC6")]:
      "0xb8daa4c8c9f690396f671bb601727a4c3741340c",
  };

const LIMITLESS_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

type LimitlessPreparedPayload = PreparedPayloadBase & {
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
  negRiskSpender?: string | null;
  refresh?: boolean | null;
  tokenId?: string | null;
};

type LimitlessAccountPayload = Record<string, unknown>;

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
  price?: number | null;
  side: "BUY" | "SELL";
  size: number;
  tokenId: string;
  txHash: string;
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
        ok: true;
        orderId: string;
        referralFirstTrade?: unknown;
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

function isLimitlessFokUnmatchedMessage(message: string | null): boolean {
  return message?.toLowerCase().includes("market order unmatched") ?? false;
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
      payload: { error: "Limitless profile mapping is missing for this wallet." },
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

async function lookupLimitlessPartnerAccountProfile(input: {
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
    profile: extractLimitlessPartnerAccountProfile(lookup.payload, input.account),
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
      if (storedProfile) {
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
          const partnerAccountLookup = await lookupLimitlessPartnerAccountProfile(
            {
              account: checksumAccount,
              clientType: input.clientType,
            },
          );
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

          const storedAfterConflict =
            await waitForStoredLimitlessProfileForAccount({
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

export async function syncLimitlessOpenOrdersRoute(input: {
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
  query: LimitlessOpenOrdersQuery;
  signer: string;
  userId: string;
}): Promise<LimitlessRouteOperationResult> {
  const authContext = await resolveLimitlessAuthContext(
    input.userId,
    input.signer,
  );
  if (!authContext) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Connect Limitless before trading." },
    };
  }
  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: input.signer,
  });
  if (!verification.ok) {
    return {
      ok: false,
      statusCode: 400,
      payload: {
        error: verification.message ?? "Limitless account is not ready.",
      },
    };
  }
  const requestAuth = buildLimitlessRequestAuthInputs(authContext);
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(input.query.slug)}/user-orders`,
    ...requestAuth,
    headers: buildLimitlessOnBehalfHeaders(verification.profile),
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
  let expiredStaleFok = 0;
  let metricsError: string | null = null;

  try {
    historyStats = await syncLimitlessHistoryForWallet(input.pool, {
      userId: input.userId,
      walletAddress: input.signer,
      authContext,
      limit: 100,
    });
    expiredStaleFok = await expireStaleLimitlessFokOrders(input.pool, {
      userId: input.userId,
      walletAddress: input.signer,
      marketSlug: input.query.slug,
      activeVenueOrderIds: orderIds,
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

  if (historyStats || expiredStaleFok > 0) {
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
    Boolean(creds) && Boolean(authContext) && isLimitlessPartnerHmacConfigured();
  let verifiedProfileBase: Awaited<
    ReturnType<typeof loadLimitlessProfileForWallet>
  > | null = null;

  const clobSpender = input.query.clobSpender ?? env.limitlessClobAddress;
  const negRiskSpender =
    input.query.negRiskSpender ?? env.limitlessNegRiskAddress;
  const adapterSpender = input.query.adapterSpender ?? null;
  const ammSpender = input.query.ammSpender ?? null;
  const tokenId = normalizeLimitlessRawTokenId(input.query.tokenId);

  const cacheEnabled = !refresh && env.limitlessAccountCacheTtlMs > 0;
  const cacheKey = buildLimitlessAccountCacheKey({
    userId: input.userId,
    signer,
    clobSpender: clobSpender ?? "none",
    negRiskSpender: negRiskSpender ?? "none",
    adapterSpender: adapterSpender ?? "none",
    ammSpender: ammSpender ?? "none",
    tokenId: tokenId ?? "none",
    credsUpdatedAt: credsUpdatedAtValue,
  });

  if (cacheEnabled) {
    const cached = readLimitlessAccountCache(cacheKey);
    if (cached) return { ok: true, payload: cached };
    const inflight = limitlessAccountInflight.get(cacheKey);
    if (inflight) {
      const payload = await inflight;
      return { ok: true, payload };
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
      const [
        code,
        snapshot,
        approvedClob,
        approvedNegRisk,
        approvedAdapter,
        approvedAmm,
        tokenBalanceMap,
        liveProfile,
      ] = await Promise.all([
        fetchEvmCode({
          rpcUrl: env.baseRpcUrl,
          timeoutMs: env.baseRpcTimeoutMs,
          address: signer,
        }),
        fetchLimitlessOnchainSnapshot({
          rpcUrl: env.baseRpcUrl,
          timeoutMs: env.baseRpcTimeoutMs,
          owner: signer,
          clobAddress: clobSpender,
          negRiskAddress: negRiskSpender,
          ammAddress: ammSpender,
        }),
        clobSpender
          ? fetchErc1155IsApprovedForAll({
              rpcUrl: env.baseRpcUrl,
              timeoutMs: env.baseRpcTimeoutMs,
              contractAddress: conditionalTokensAddress,
              owner: signer,
              operator: clobSpender,
              bypassCache: refresh,
            })
          : Promise.resolve(null),
        negRiskSpender
          ? fetchErc1155IsApprovedForAll({
              rpcUrl: env.baseRpcUrl,
              timeoutMs: env.baseRpcTimeoutMs,
              contractAddress: conditionalTokensAddress,
              owner: signer,
              operator: negRiskSpender,
              bypassCache: refresh,
            })
          : Promise.resolve(null),
        adapterSpender
          ? fetchErc1155IsApprovedForAll({
              rpcUrl: env.baseRpcUrl,
              timeoutMs: env.baseRpcTimeoutMs,
              contractAddress: conditionalTokensAddress,
              owner: signer,
              operator: adapterSpender,
              bypassCache: refresh,
            })
          : Promise.resolve(null),
        ammSpender
          ? fetchErc1155IsApprovedForAll({
              rpcUrl: env.baseRpcUrl,
              timeoutMs: env.baseRpcTimeoutMs,
              contractAddress: conditionalTokensAddress,
              owner: signer,
              operator: ammSpender,
              bypassCache: refresh,
            })
          : Promise.resolve(null),
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
      ]);

      const usdcBalance = snapshot.usdcBalance;
      const allowanceClob = snapshot.allowanceClob;
      const allowanceNegRisk = snapshot.allowanceNegRisk;
      const allowanceAmm = snapshot.allowanceAmm;
      const tokenBalanceRaw =
        tokenId && tokenBalanceMap ? (tokenBalanceMap.get(tokenId) ?? 0n) : null;
      const isContract = typeof code === "string" && code.length > 2;

      return {
        ok: true,
        venue: "limitless",
        chainId: 8453,
        signer,
        signerIsContract: isContract,
        rpcUrl: env.baseRpcUrl,
        usdc: {
          tokenAddress: env.limitlessUsdcAddress,
          decimals: 6,
          balance: ethers.formatUnits(usdcBalance, 6),
          balanceRaw: usdcBalance.toString(),
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
            ...(clobSpender ? { clob: approvedClob ?? false } : {}),
            ...(negRiskSpender ? { negRisk: approvedNegRisk ?? false } : {}),
            ...(adapterSpender ? { adapter: approvedAdapter ?? false } : {}),
            ...(ammSpender ? { amm: approvedAmm ?? false } : {}),
          },
        },
        profile: liveProfile ?? null,
        hasCredentials,
        ...(authContext?.authMode ? { authMode: authContext.authMode } : {}),
      };
    })();

    if (cacheEnabled) {
      limitlessAccountInflight.set(cacheKey, computePromise);
    }
    try {
      const payload = await computePromise;
      if (cacheEnabled) {
        writeLimitlessAccountCache(cacheKey, payload);
      }
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
  query: LimitlessRedemptionPlanQuery;
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

  const cancelledIds = extractLimitlessCanceledIds(upstream.payload, input.orderIds);
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

  const cancelledIds = extractLimitlessCanceledIds(upstream.payload, openOrderIds);
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

function normalizeRawLimitlessTokenIdFromUnknown(value: unknown): string | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
    ? normalizeLimitlessRawTokenId(value)
    : null;
}

type LimitlessTokenPair = { tokenNo: string | null; tokenYes: string | null };

function extractLimitlessPositionTokenIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => normalizeRawLimitlessTokenIdFromUnknown(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function extractLimitlessTokenPair(payload: unknown): LimitlessTokenPair | null {
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
      tokensRecord ? (tokensRecord.no ?? tokensRecord.NO ?? tokensRecord[1]) : null,
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
    marketRecord.exchangeAddress,
    marketRecord.exchange,
    marketRecord.venueExchange,
  ];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && ethers.isAddress(candidate.trim())) {
      return ethers.getAddress(candidate.trim());
    }
  }

  const venue = marketRecord.venue;
  if (isRecord(venue)) {
    const nestedCandidates = [venue.exchangeAddress, venue.exchange];
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
    token_yes: string | null;
    token_no: string | null;
  }>(
    `
      select token_yes, token_no
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
  if (dbTokenYes && dbTokenNo) {
    return { tokenYes: dbTokenYes, tokenNo: dbTokenNo };
  }

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
    ...(input.requestAuth as object),
  });
  if (!upstream.ok) {
    return dbTokenYes || dbTokenNo
      ? { tokenYes: dbTokenYes, tokenNo: dbTokenNo }
      : null;
  }

  const upstreamTokens = extractLimitlessTokenPair(upstream.payload);
  if (!upstreamTokens) {
    return dbTokenYes || dbTokenNo
      ? { tokenYes: dbTokenYes, tokenNo: dbTokenNo }
      : null;
  }

  return {
    tokenYes: upstreamTokens.tokenYes ?? dbTokenYes,
    tokenNo: upstreamTokens.tokenNo ?? dbTokenNo,
  };
}

export async function submitLimitlessClientSignedOrder(input: {
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

  if (!isLimitlessPartnerHmacConfigured()) {
    return {
      ok: false,
      statusCode: 503,
      payload: { error: "Limitless partner auth is not configured" },
    };
  }

  const authContext = await resolveLimitlessAuthContext(input.userId, signer);
  if (!authContext) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Connect Limitless before trading." },
    };
  }
  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: signer,
  });
  if (!verification.ok) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: verification.message ?? "Limitless account is not ready." },
    };
  }
  const profile = verification.profile;
  const requestAuth = buildLimitlessRequestAuthInputs(authContext);
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

  const side = normalizeOrderSide(order.side);
  if (!side) {
    return {
      ok: false,
      statusCode: 400,
      payload: { error: "Order side must be BUY/SELL (or 0/1)" },
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
    const signatureType = coerceOrderNumber(order.signatureType, "signatureType");
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
        payload: { error: "GTC orders require makerAmount, takerAmount, and side." },
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
  const clientOrderId = `hunch-${crypto.randomUUID()}`;
  const orderPayload = {
    order: orderForUpstream,
    orderType: input.body.orderType,
    marketSlug: input.body.marketSlug,
    ownerId,
    onBehalfOf: ownerId,
    clientOrderId,
  };

  const upstream = await limitlessRequest({
    method: "POST",
    requestPath: "/orders",
    ...(requestAuth as object),
    body: orderPayload,
  });

  if (!upstream.ok) {
    const upstreamMessage = extractLimitlessMessage(upstream.payload);
    if (
      input.body.orderType === "FOK" &&
      isLimitlessFokUnmatchedMessage(upstreamMessage)
    ) {
      const venueOrderId = extractLimitlessOrderIdFromMessage(upstreamMessage);
      if (venueOrderId) {
        const now = new Date();
        const rawError = stringifyLimitlessRawError(upstream.payload);
        await storeOrder(input.pool, {
          userId: input.userId,
          walletAddress: signer,
          signerAddress: signer,
          venue: "limitless",
          venueOrderId,
          tokenId: tokenId ?? null,
          side,
          orderType: input.body.orderType,
          price,
          size,
          status: "expired",
          errorMessage: LIMITLESS_FOK_UNMATCHED_MESSAGE,
          rawError,
          orderPayload,
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
            signer,
            venueOrderId,
            LIMITLESS_FOK_UNMATCHED_MESSAGE,
            rawError,
            now,
          ],
        );
      }

      return {
        ok: true,
        payload: {
          ok: false,
          reason: LIMITLESS_FOK_UNMATCHED_REASON,
          message: LIMITLESS_FOK_UNMATCHED_MESSAGE,
          status: "expired",
          executionStatus: "UNMATCHED",
          orderId: venueOrderId ?? undefined,
          payload: upstream.payload,
        },
      };
    }
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

  const venueOrderId =
    (isRecord(upstream.payload) &&
      isRecord(upstream.payload.order) &&
      typeof upstream.payload.order.id === "string" &&
      upstream.payload.order.id) ||
    null;

  if (!venueOrderId) {
    return {
      ok: false,
      statusCode: 502,
      payload: {
        error: "Limitless order placed but no orderId returned",
        payload: upstream.payload,
      },
    };
  }

  const status =
    (isRecord(upstream.payload) &&
      isRecord(upstream.payload.order) &&
      typeof upstream.payload.order.status === "string" &&
      upstream.payload.order.status) ||
    "submitted";

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
      ? (price ?? confirmedImmediateFill.notionalUsd / confirmedImmediateFill.shares)
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
    lastUpdate: confirmedFillAt,
    filledAt: confirmedFillAt,
  });

  if (confirmedFillAt) {
    try {
      await upsertLimitlessVenueShareAccrualFromOrderPayload(input.pool, {
        orderId: stored.order.id,
        userId: input.userId,
        walletAddress: signer,
        signerAddress: signer,
        venueOrderId,
        orderHash: null,
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
      referralFirstTrade = await tryRecordReferralFirstTradeConversion(input.pool, {
        userId: input.userId,
        venue: "limitless",
        status,
        sourceType: "order",
        sourceId: venueOrderId,
        txHash: null,
        logger: input.log,
      });
    }
    let optimisticApplied = false;
    if (confirmedImmediateFill) {
      try {
        const optimisticResult = await applyOptimisticPositionTrade(input.pool, {
          userId: input.userId,
          walletAddress: signer,
          venue: "limitless",
          tokenId,
          side,
          shares: confirmedImmediateFill.shares,
          notionalUsd: confirmedImmediateFill.notionalUsd,
        });
        optimisticApplied = optimisticResult.applied;
        if (optimisticResult.applied) {
          await markOrderPositionDeltaApplied(input.pool, {
            id: stored.order.id,
          });
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
      side,
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
}): Promise<LimitlessAmmQuoteRouteResult> {
  const amountUsdRaw =
    input.query.amountUsdRaw != null ? BigInt(input.query.amountUsdRaw) : null;
  const amountSharesRaw =
    input.query.amountSharesRaw != null
      ? BigInt(input.query.amountSharesRaw)
      : null;

  if (input.query.side === "BUY" && (amountUsdRaw == null || amountUsdRaw <= 0n)) {
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

export async function recordLimitlessAmmOrder(input: {
  body: LimitlessAmmOrderBody;
  log?: LimitlessRouteLogger | null;
  pool: ApiTradingApplicationServiceInput["pool"];
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
  const venueOrderId = `amm:${txHash}:${tokenId}`;
  const now = new Date();

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
    status: "filled",
    errorMessage: null,
    rawError: null,
    orderPayload: {
      ...input.body,
      tokenId,
      price,
    },
    orderHash: txHash,
    postedAt: now,
    lastUpdate: now,
    filledAt: now,
  });

  const referralFirstTrade =
    stored.kind === "stored"
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
  if (stored.kind === "stored" && fallbackNotional != null) {
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
      const optimisticResult = await applyOptimisticPositionTrade(input.pool, {
        userId: input.userId,
        walletAddress: signer,
        venue: "limitless",
        tokenId,
        side,
        shares: size,
        notionalUsd: fallbackNotional,
      });
      if (optimisticResult.applied) {
        await markOrderPositionDeltaApplied(input.pool, { id: stored.order.id });
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
        "Limitless AMM optimistic position update failed",
      );
    }
  }

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

  void createNotificationSafe(
    input.pool,
    buildOrderNotification({
      userId: input.userId,
      venue: "limitless",
      status: "filled",
      side,
      size,
      price: price ?? null,
      orderId: venueOrderId,
      tokenId,
      walletAddress: signer,
    }),
    input.log as never,
  );

  return {
    ok: true,
    payload: {
      ok: true,
      orderId: venueOrderId,
      referralFirstTrade: referralFirstTrade ?? undefined,
    },
  };
}

function isLimitlessAmmMarket(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const directFlags = [
    metadata.amm,
    metadata.isAmm,
    metadata.is_amm,
    metadata.ammOnly,
    metadata.amm_only,
  ];
  if (directFlags.some((value) => value === true)) return true;
  const mode =
    readString(metadata.executionMode) ??
    readString(metadata.execution_mode) ??
    readString(metadata.tradingMode) ??
    readString(metadata.trading_mode) ??
    readString(metadata.marketType) ??
    readString(metadata.market_type);
  return mode?.toLowerCase() === "amm";
}

async function getReadiness(
  ctx: ApiTradingApplicationServiceInput,
  input: TradingReadinessInput,
): Promise<TradingReadiness> {
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
    if (isLimitlessAmmMarket(market.metadata)) {
      return readiness("limitless", capabilities, {
        ok: false,
        code: "unsupported_capability",
        message:
          "Limitless AMM bot execution is not route-equivalent yet. Open Hunch to trade.",
      });
    }
    if (!market.slug || !market.token_yes || !market.token_no) {
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
  }
  if (!isLimitlessPartnerHmacConfigured()) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Limitless partner auth is not configured.",
      setupRequired: true,
    });
  }
  const authContext = await resolveLimitlessAuthContext(
    input.actor.userId,
    input.walletAddress,
  );
  if (!authContext) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: "Connect Limitless before bot trading.",
      setupRequired: true,
    });
  }
  const verification = await verifyLimitlessAuthContext({
    authContext,
    walletAddress: input.walletAddress,
  });
  if (!verification.ok) {
    return readiness("limitless", capabilities, {
      ok: false,
      code: "insufficient_readiness",
      message: verification.message ?? "Limitless account is not ready.",
      setupRequired: true,
    });
  }
  return readiness("limitless", capabilities, { ok: true });
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
  if (isLimitlessAmmMarket(market.metadata)) {
    throw tradingError({
      code: "unsupported_capability",
      message:
        "Limitless AMM bot execution is not route-equivalent yet. Open Hunch to trade.",
      venue: "limitless",
    });
  }
  const side = normalizeSide(intent.outcome ?? intent.target.outcome);
  const tokenId = tokenForSide(market, side);
  if (!isOrderable(market)) {
    throw tradingError({
      code: "invalid_trade_request",
      message: "Market is not open for orders.",
      venue: "limitless",
    });
  }
  const ask = await bestAskForToken(ctx.pool, tokenId);
  const metadataPrice =
    isRecord(market.metadata) && typeof market.metadata.price === "number"
      ? market.metadata.price
      : null;
  const price = ask ?? metadataPrice;
  if (!price || price <= 0 || price >= 1) {
    throw tradingError({
      code: "quote_unavailable",
      message: "Limitless market price is unavailable.",
      venue: "limitless",
    });
  }
  const amount = amountUsd(intent);
  const estimatedShares = amount / price;
  return {
    venue: "limitless",
    target: { ...intent.target, tokenId, raw: { market } },
    action: "BUY",
    amount: intent.amount,
    price,
    estimatedShares,
    estimatedNotionalUsd: amount,
    maxSpendUsd: amount,
    minReceiveShares: estimatedShares,
    fees: {},
    expiresAt: new Date(Date.now() + 30_000),
    raw: { price, tokenId },
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
  const direct =
    readString(upstream.payload.exchangeAddress) ??
    readString(upstream.payload.exchange_address) ??
    readString(upstream.payload.exchange);
  if (direct) return direct;
  const venue = isRecord(upstream.payload.venue) ? upstream.payload.venue : null;
  return venue
    ? (readString(venue.exchangeAddress) ??
        readString(venue.exchange_address) ??
        readString(venue.exchange))
    : null;
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
  if (isLimitlessAmmMarket(market.metadata)) {
    throw tradingError({
      code: "unsupported_capability",
      message:
        "Limitless AMM bot execution is not route-equivalent yet. Open Hunch to trade.",
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
    (isRecord(market.metadata) && readString(market.metadata.exchangeAddress)) ||
    (isRecord(market.metadata) && readString(market.metadata.exchange_address)) ||
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
        name: LIMITLESS_EIP712_NAME,
        version: LIMITLESS_EIP712_VERSION,
        chainId: LIMITLESS_CHAIN_ID,
        verifyingContract: exchangeAddress,
      },
      types: LIMITLESS_ORDER_TYPES,
      primaryType: "Order",
      message: order,
    },
  });
  const size = input.quote?.estimatedShares ?? amountUsd(intent) / price;

  return {
    preparedId: crypto.randomUUID(),
    venue: "limitless",
    intent,
    quote: input.quote ?? null,
    authorizationMode: "embedded_privy_evm",
    authorizationRequests: [],
    venuePayload: {
      kind: "limitless",
      marketSlug: market.slug,
      orderPayload: { ...order, signature },
      orderType: "FOK",
      ownerId: verification.profile.id,
      price,
      requestAuth: requestAuth as unknown as Record<string, unknown>,
      size,
      tokenId: normalizeLimitlessScopedTokenId(tokenId) ?? tokenId,
    } satisfies LimitlessPreparedPayload,
    expiresAt: new Date(Date.now() + 30_000),
  };
}

async function submitPreparedTrade(
  prepared: PreparedTrade,
): Promise<SubmitResult> {
  const payload = parsePreparedPayload<LimitlessPreparedPayload>(
    prepared,
    "limitless",
  );
  const upstream = await limitlessRequest({
    method: "POST",
    requestPath: "/orders",
    ...(payload.requestAuth as object),
    body: {
      order: payload.orderPayload,
      orderType: payload.orderType,
      marketSlug: payload.marketSlug,
      ownerId: payload.ownerId,
      onBehalfOf: payload.ownerId,
      clientOrderId: `hunch-${crypto.randomUUID()}`,
    },
  });
  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    if (message?.toLowerCase().includes("unmatched")) {
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

  const order =
    isRecord(upstream.payload) && isRecord(upstream.payload.order)
      ? upstream.payload.order
      : upstream.payload;
  const venueOrderId = isRecord(order) ? readString(order.id) : null;
  if (!venueOrderId) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Limitless order placed but no order id returned.",
      statusCode: 502,
      venue: "limitless",
    });
  }
  const status = isRecord(order) ? readString(order.status) : null;
  return {
    venue: "limitless",
    status: status && ["filled", "matched"].includes(status) ? "filled" : "submitted",
    venueOrderId,
    orderHash: null,
    txSignature: null,
    price: payload.price,
    size: payload.size,
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
    ? parsePreparedPayload<LimitlessPreparedPayload>(input.prepared, "limitless")
    : null;
  if (!payload || !input.submitResult.venueOrderId) {
    throw tradingError({
      code: "trade_submission_failed",
      message: "Limitless persistence requires a venue order id.",
      venue: "limitless",
    });
  }
  const stored = await storeOrder(ctx.pool, {
    userId: input.intent.actor.userId,
    walletAddress: input.intent.walletAddress,
    signerAddress: input.intent.walletAddress,
    venue: "limitless",
    venueOrderId: input.submitResult.venueOrderId,
    tokenId: payload.tokenId,
    side: "BUY",
    orderType: "FOK",
    price: payload.price,
    size: payload.size,
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
      _hunchUpstream: input.submitResult.raw,
    },
    filledAt: input.submitResult.status === "filled" ? new Date() : null,
  });
  return {
    venue: "limitless",
    orderId: stored.order.id,
    executionId: null,
    venueOrderId: stored.order.venue_order_id,
    status: stored.order.status,
    raw: stored,
  };
}

export function createLimitlessTradingExecutionService(
  ctx: ApiTradingApplicationServiceInput,
): ApiVenueTradingExecutor {
  return {
    venue: "limitless",
    capabilities: () => capabilities,
    getReadiness: (input) => getReadiness(ctx, input),
    quote: (input) => quote(ctx, input),
    prepareTrade: (input) =>
      prepareTrade(ctx, { intent: input.intent, quote: input.quote ?? null }),
    submitPreparedTrade: (input) => submitPreparedTrade(input.prepared),
    persistTrade: (input) => persistTrade(ctx, input),
    applyTradeEffects: (input) => applyOrderTradeEffects(ctx, input),
  };
}
