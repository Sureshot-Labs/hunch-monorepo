import type { FastifyPluginAsync } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { ethers } from "ethers";
import { AuthService, createAuthMiddleware } from "../auth.js";
import { pool } from "../db.js";
import { env } from "../env.js";
import {
  normalizeLimitlessRawTokenId,
  normalizeLimitlessScopedTokenId,
} from "../lib/limitless-token.js";
import { isRecord } from "../lib/type-guards.js";
import { storeOrder } from "../repos/orders-repo.js";
import {
  fetchErc1155BalancesByOwner,
  fetchEvmCode,
  fetchErc1155IsApprovedForAll,
} from "../services/polygon-rpc.js";
import { fetchLimitlessOnchainSnapshot } from "../services/limitless-onchain.js";
import { fetchConditionalTokensPayouts } from "../services/limitless-redemption.js";
import {
  extractLimitlessMessage,
  limitlessRequest,
} from "../services/limitless-client.js";
import {
  buildOrderNotification,
  createNotificationSafe,
} from "../services/notifications.js";
import { applyOptimisticPositionTrade } from "../services/positions-optimistic.js";
import { recomputePositionMetricsForWallet } from "../services/positions-metrics.js";
import {
  syncLimitlessHistoryForWallet,
} from "../services/limitless-history.js";
import {
  limitlessAuthLoginBodySchema,
  limitlessAccountQuerySchema,
  limitlessAmmOrderBodySchema,
  limitlessCancelBatchBodySchema,
  limitlessHistoryQuerySchema,
  limitlessMarketExchangeQuerySchema,
  limitlessOpenOrdersQuerySchema,
  limitlessOrderBodySchema,
  limitlessOrderIdParamsSchema,
  limitlessRedemptionQuerySchema,
  limitlessSlugParamsSchema,
} from "../schemas/limitless-private.js";

type LimitlessProfile = {
  id?: number;
  account?: string;
  client?: string;
  rank?: { feeRateBps?: number; name?: string };
};

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function toChecksumAddress(value: string): string | null {
  try {
    return ethers.getAddress(value.trim());
  } catch {
    return null;
  }
}

// Legacy Limitless markets sometimes expose only exchange in /markets payload.
// For these, SELL CT approvals may require a separate operator not returned by API.
const LIMITLESS_LEGACY_OPERATOR_BY_EXCHANGE: Readonly<Record<string, string>> = {
  [normalizeAddress("0x5a38afc17F7E97ad8d6C547ddb837E40B4aEDfC6")]:
    "0xb8daa4c8c9f690396f671bb601727a4c3741340c",
};

function resolveLimitlessLegacyOperatorForExchange(
  exchangeAddress: string | null,
): string | null {
  if (!exchangeAddress) return null;
  const mapped = LIMITLESS_LEGACY_OPERATOR_BY_EXCHANGE[normalizeAddress(exchangeAddress)];
  return mapped ?? null;
}

function parseFeeRateBps(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return undefined;
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

function normalizeLimitlessPrice(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const normalized = value > 1 ? value / 100 : value;
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 1) {
    return null;
  }
  return normalized;
}

function normalizeLimitlessAmount(value: number | null): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return value > 1_000_000 ? value / 1_000_000 : value;
}

function isImmediateExecutionStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return (
    normalized === "matched" ||
    normalized === "filled" ||
    normalized === "partially_filled" ||
    normalized === "complete"
  );
}

function extractLimitlessImmediateFill(
  payload: unknown,
  side: "BUY" | "SELL",
  fallback: { price: number | null; size: number | null },
): { shares: number; notionalUsd: number } | null {
  const record = isRecord(payload)
    ? isRecord(payload.order)
      ? payload.order
      : payload
    : null;
  if (!record) return null;

  const sharesCandidates = [
    normalizeLimitlessAmount(
      parseNumberish(
        record.outcomeTokenAmount ??
          record.outcome_token_amount ??
          record.size ??
          record.amount ??
          record.quantity,
      ),
    ),
    normalizeLimitlessAmount(
      parseNumberish(side === "BUY" ? record.takerAmount : record.makerAmount),
    ),
    fallback.size,
  ];
  const shares = sharesCandidates.find(
    (value): value is number => value != null && Number.isFinite(value) && value > 0,
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
    normalizeLimitlessAmount(
      parseNumberish(record.collateralAmount ?? record.collateral_amount),
    ),
    normalizeLimitlessAmount(
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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4;
  const padded =
    padding === 0 ? normalized : `${normalized}${"=".repeat(4 - padding)}`;
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

function coerceOrderNumber(
  value: unknown,
  field: string,
  options: { allowFloat?: boolean } = {},
): number | null {
  if (value == null) return null;
  const raw =
    typeof value === "string" ? value.trim() : typeof value === "number" ? value : null;
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

function extractProfile(value: unknown): LimitlessProfile | null {
  if (!isRecord(value)) return null;
  const profileRaw = isRecord(value.profile) ? value.profile : value;
  if (!isRecord(profileRaw)) return null;
  const idCandidate =
    profileRaw.id ??
    profileRaw.userId ??
    profileRaw.user_id ??
    profileRaw.profileId ??
    profileRaw.profile_id;
  const idFromString =
    typeof idCandidate === "string" && idCandidate.trim()
      ? Number.parseInt(idCandidate, 10)
      : null;
  const id =
    typeof idCandidate === "number"
      ? idCandidate
      : typeof idFromString === "number" && Number.isFinite(idFromString)
        ? idFromString
        : null;
  const account =
    typeof profileRaw.account === "string"
      ? profileRaw.account
      : typeof profileRaw.address === "string"
        ? profileRaw.address
        : typeof profileRaw.walletAddress === "string"
          ? profileRaw.walletAddress
          : typeof profileRaw.wallet_address === "string"
            ? profileRaw.wallet_address
            : null;
  const normalizedAccount = account
    ? toChecksumAddress(account) ?? account.trim()
    : null;
  const client =
    typeof profileRaw.client === "string"
      ? profileRaw.client
      : typeof profileRaw.clientType === "string"
        ? profileRaw.clientType
        : typeof profileRaw.client_type === "string"
          ? profileRaw.client_type
          : null;
  const rankRaw = isRecord(profileRaw.rank) ? profileRaw.rank : null;
  const rankFeeRateBps =
    parseFeeRateBps(rankRaw?.feeRateBps) ??
    parseFeeRateBps(rankRaw?.fee_rate_bps) ??
    parseFeeRateBps(rankRaw?.feeRate) ??
    parseFeeRateBps(rankRaw?.fee_rate) ??
    parseFeeRateBps(profileRaw.feeRateBps) ??
    parseFeeRateBps(profileRaw.fee_rate_bps) ??
    parseFeeRateBps(profileRaw.feeRate) ??
    parseFeeRateBps(profileRaw.fee_rate) ??
    parseFeeRateBps(profileRaw.rankFeeRateBps) ??
    parseFeeRateBps(profileRaw.rank_fee_rate_bps);
  const rankName =
    (typeof rankRaw?.name === "string" && rankRaw.name) ||
    (typeof profileRaw.rank === "string" && profileRaw.rank) ||
    (typeof profileRaw.rankName === "string" && profileRaw.rankName) ||
    (typeof profileRaw.rank_name === "string" && profileRaw.rank_name) ||
    undefined;
  const rank =
    rankFeeRateBps != null || rankName
      ? {
          ...(rankFeeRateBps != null ? { feeRateBps: rankFeeRateBps } : {}),
          ...(rankName ? { name: rankName } : {}),
        }
      : undefined;
  return {
    ...(id != null ? { id } : {}),
    ...(normalizedAccount ? { account: normalizedAccount } : {}),
    ...(client ? { client } : {}),
    ...(rank ? { rank } : {}),
  };
}

function extractProfileFromSessionCookie(
  sessionCookie: string | null | undefined,
): LimitlessProfile | null {
  if (!sessionCookie) return null;
  const payload = decodeJwtPayload(sessionCookie);
  if (!payload) return null;
  return extractProfile(payload);
}

function mergeProfiles(
  base: LimitlessProfile | null,
  extra: LimitlessProfile | null,
): LimitlessProfile | null {
  if (!base && !extra) return null;
  const accountCandidate = base?.account ?? extra?.account ?? null;
  const accountNormalized = accountCandidate
    ? toChecksumAddress(accountCandidate) ?? accountCandidate.trim()
    : null;
  const rankFeeRateBps = base?.rank?.feeRateBps ?? extra?.rank?.feeRateBps;
  const rankName = base?.rank?.name ?? extra?.rank?.name;
  const rank =
    rankFeeRateBps != null || rankName
      ? {
          ...(rankFeeRateBps != null ? { feeRateBps: rankFeeRateBps } : {}),
          ...(rankName ? { name: rankName } : {}),
        }
      : undefined;
  return {
    ...(base?.id ?? extra?.id ? { id: base?.id ?? extra?.id } : {}),
    ...(accountNormalized ? { account: accountNormalized } : {}),
    ...(base?.client ?? extra?.client
      ? { client: base?.client ?? extra?.client }
      : {}),
    ...(rank ? { rank } : {}),
  };
}

async function fetchLimitlessProfileForAddress(inputs: {
  address: string;
  sessionCookie?: string | null;
}): Promise<LimitlessProfile | null> {
  const address = toChecksumAddress(inputs.address);
  if (!address) return null;
  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/profiles/${encodeURIComponent(address)}`,
    ...(inputs.sessionCookie ? { sessionCookie: inputs.sessionCookie } : {}),
  });
  if (!upstream.ok) return null;
  return extractProfile(upstream.payload);
}

function getHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name.toLowerCase()];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw[0];
  return undefined;
}

function isEvmWallet(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isBytes32(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

function deriveSize(
  orderType: string,
  side: "BUY" | "SELL" | null,
  makerAmount: number | null,
  takerAmount: number | null,
): number | null {
  if (!side) return null;
  if (orderType !== "GTC") return null;
  const shares = side === "BUY" ? takerAmount : makerAmount;
  if (shares == null) return null;
  return shares / 1_000_000;
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

function extractLimitlessOrders(payload: unknown): Record<string, unknown>[] {
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

function extractLimitlessOrderId(record: Record<string, unknown>): string | null {
  return normalizeOrderId(readOrderField(record, ["id", "orderId", "order_id"]));
}

function extractLimitlessTokenId(
  record: Record<string, unknown>,
): string | null {
  const raw = normalizeOrderId(
    readOrderField(record, ["tokenId", "token_id", "outcomeTokenId"]),
  );
  return normalizeLimitlessScopedTokenId(raw);
}

function extractLimitlessOrderSide(
  record: Record<string, unknown>,
): "BUY" | "SELL" | null {
  return normalizeOrderSide(readOrderField(record, ["side", "orderSide"]));
}

function extractLimitlessOrderType(
  record: Record<string, unknown>,
): "GTC" | "FOK" | null {
  const value = readOrderField(record, ["orderType", "type"]);
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (upper === "GTC" || upper === "FOK") return upper;
  }
  return null;
}

function extractLimitlessOrderStatus(record: Record<string, unknown>): string {
  const value = readOrderField(record, ["status", "orderStatus"]);
  if (typeof value === "string" && value.trim()) {
    const normalized = value.trim().toLowerCase();
    if (normalized === "open" || normalized === "active" || normalized === "live") {
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

function extractLimitlessOrderPrice(record: Record<string, unknown>): number | null {
  const value = readOrderField(record, [
    "price",
    "orderPrice",
    "limitPrice",
    "outcomeTokenPrice",
    "outcome_token_price",
  ]);
  return parseNumberish(value);
}

function extractLimitlessOrderSize(record: Record<string, unknown>): number | null {
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

function extractLimitlessCanceledIds(
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

function extractLimitlessMarketExchangeAddress(payload: unknown): string | null {
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

  // Approval target priority:
  // 1) operator/operatorAddress when provided (current Limitless UI behavior)
  // 2) adapter-style fields for older payload variants
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

function extractLimitlessExpectedExchangeAddress(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const nestedPayload = isRecord(payload.payload) ? payload.payload : null;
  const candidates: unknown[] = [
    payload.message,
    payload.error,
    nestedPayload?.message,
    nestedPayload?.error,
  ];

  const pattern =
    /exchange address for this market:\s*(0x[a-fA-F0-9]{40})/i;
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

type LimitlessTokenPair = { tokenYes: string | null; tokenNo: string | null };

function normalizeRawLimitlessTokenIdFromUnknown(value: unknown): string | null {
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
    ? normalizeLimitlessRawTokenId(value)
    : null;
}

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
    ) ?? positionIds[0] ?? null;
  const tokenNo =
    normalizeRawLimitlessTokenIdFromUnknown(
      tokensRecord
        ? (tokensRecord.no ?? tokensRecord.NO ?? tokensRecord[1])
        : null,
    ) ?? positionIds[1] ?? null;

  if (!tokenYes && !tokenNo) return null;
  return { tokenYes, tokenNo };
}

async function resolveLimitlessTokenPairForSlug(inputs: {
  slug: string;
  sessionCookie: string;
}): Promise<LimitlessTokenPair | null> {
  const slug = inputs.slug.trim();
  if (!slug) return null;

  const dbRow = await pool.query<{
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
  const dbTokenYes = normalizeLimitlessRawTokenId(dbRow.rows[0]?.token_yes ?? null);
  const dbTokenNo = normalizeLimitlessRawTokenId(dbRow.rows[0]?.token_no ?? null);
  if (dbTokenYes && dbTokenNo) {
    return { tokenYes: dbTokenYes, tokenNo: dbTokenNo };
  }

  const upstream = await limitlessRequest({
    method: "GET",
    requestPath: `/markets/${encodeURIComponent(slug)}`,
    sessionCookie: inputs.sessionCookie,
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

export const limitlessPrivateRoutes: FastifyPluginAsync = async (app) => {
  const z = app.withTypeProvider<ZodTypeProvider>();

  const resolveWalletAddresses = async (
    userId: string,
    walletAddress: string | undefined,
    requestedWallets: string[] | undefined,
  ): Promise<string[]> => {
    if (requestedWallets && requestedWallets.length) {
      const wallets = await AuthService.getUserWallets(userId);
      const walletMap = new Map(
        wallets.map((wallet) => [
          wallet.walletAddress.toLowerCase(),
          wallet.walletAddress,
        ]),
      );
      const resolved = requestedWallets
        .map((address) => address.trim().toLowerCase())
        .map((address) => walletMap.get(address))
        .filter((address): address is string => Boolean(address));
      return Array.from(new Set(resolved));
    }

    if (!walletAddress) return [];
    return [walletAddress];
  };

  /**
   * GET /auth/signing-message
   */
  z.get(
    "/auth/signing-message",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      if (!request.user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: "/auth/signing-message",
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless signing message failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const message = extractLimitlessMessage(upstream.payload);
      if (!message) {
        reply.code(502);
        return reply.send({
          error: "Limitless signing message invalid",
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, message });
    },
  );

  /**
   * POST /auth/login
   */
  z.post(
    "/auth/login",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessAuthLoginBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless login requires an EVM wallet address",
        });
      }

      const body = request.body;

      const headerAccount = getHeaderValue(request.headers, "x-account");
      const headerMessage = getHeaderValue(request.headers, "x-signing-message");
      const headerSignature = getHeaderValue(request.headers, "x-signature");

      const account = headerAccount ?? body.account;
      const signingMessage = headerMessage ?? body.signingMessage;
      const signature = headerSignature ?? body.signature;

      if (!account || !signingMessage || !signature) {
        reply.code(400);
        return reply.send({
          error: "Missing x-account, x-signing-message, or x-signature",
        });
      }

      if (normalizeAddress(account) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "x-account must match the selected wallet",
        });
      }
      const checksumAccount = toChecksumAddress(account);
      if (!checksumAccount) {
        reply.code(400);
        return reply.send({ error: "x-account is not a valid EVM address" });
      }

      const referralCode =
        (typeof body.referralCode === "string" && body.referralCode.trim()) ||
        (typeof body.r === "string" && body.r.trim()) ||
        (env.limitlessReferralCode || undefined);

      const clientType = body.client ?? "eoa";

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/auth/login",
        headers: {
          "x-account": checksumAccount,
          "x-signing-message": signingMessage,
          "x-signature": signature,
        },
        body: {
          client: clientType,
          ...(body.smartWallet ? { smartWallet: body.smartWallet } : {}),
          ...(referralCode ? { r: referralCode } : {}),
        },
        captureSessionCookie: true,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless login failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const sessionCookie = upstream.sessionCookie;
      if (!sessionCookie) {
        reply.code(502);
        return reply.send({
          error: "Limitless login did not return a session cookie",
          payload: upstream.payload,
        });
      }

      const profile = extractProfile(upstream.payload);
      const profileSafe: LimitlessProfile | null = profile
        ? { ...profile, client: profile.client ?? clientType }
        : { account: checksumAccount, client: clientType };

      try {
        await AuthService.createOrUpdateVenueCredentials(
          user.id,
          signer,
          "limitless",
          profileSafe?.account ?? checksumAccount,
          sessionCookie,
          profileSafe ? { profile: profileSafe } : undefined,
        );
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to store Limitless credentials",
        );
        reply.code(500);
        return reply.send({
          error: "Failed to store Limitless credentials",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        profile: profileSafe,
      });
    },
  );

  /**
   * GET /auth/verify
   */
  z.get(
    "/auth/verify",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({ error: "Limitless session not found" });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: "/auth/verify-auth",
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless verify failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        account: upstream.payload,
      });
    },
  );

  /**
   * POST /auth/logout
   */
  z.post(
    "/auth/logout",
    { preHandler: createAuthMiddleware() },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim() ?? null;
      let upstream:
        | Awaited<ReturnType<typeof limitlessRequest>>
        | null = null;
      if (sessionCookie) {
        upstream = await limitlessRequest({
          method: "POST",
          requestPath: "/auth/logout",
          sessionCookie,
          body: {},
        });
      }

      const deactivatedCount = await AuthService.deactivateVenueCredentials(
        user.id,
        "limitless",
        signer,
      );

      if (upstream && !upstream.ok) {
        app.log.warn(
          {
            userId: user.id,
            walletAddress: signer,
            status: upstream.status,
          },
          "Limitless upstream logout failed; local credentials were deactivated",
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        disconnected: true,
        deactivatedCount,
        upstream: upstream
          ? upstream.ok
            ? { ok: true, payload: upstream.payload }
            : { ok: false, status: upstream.status, payload: upstream.payload }
          : { ok: false, reason: "missing_session_cookie" },
      });
    },
  );

  /**
   * GET /account
   * Returns a wallet-scoped Limitless account snapshot (Base on-chain reads).
   */
  z.get(
    "/account",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessAccountQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signerRaw = request.walletAddress;
      if (!user || !signerRaw) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signerRaw)) {
        reply.code(400);
        return reply.send({
          error: "Limitless account snapshot requires an EVM wallet address",
        });
      }
      const signer = toChecksumAddress(signerRaw);
      if (!signer) {
        reply.code(400);
        return reply.send({
          error: "Limitless account snapshot requires a valid EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signerRaw,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      const storedProfile = extractProfile(creds?.additionalData ?? null);
      const sessionProfile = extractProfileFromSessionCookie(sessionCookie);
      const verifySession = request.query.verifySession === true;
      let sessionValid: boolean | null = null;
      let hasCredentials = Boolean(creds);

      if (verifySession) {
        if (!sessionCookie) {
          sessionValid = false;
          hasCredentials = false;
        } else {
          const verify = await limitlessRequest({
            method: "GET",
            requestPath: "/auth/verify-auth",
            sessionCookie,
          });
          sessionValid = verify.ok;
          if (!verify.ok) {
            hasCredentials = false;
          }
        }
      }

      try {
        const clobSpender =
          request.query.clobSpender ?? env.limitlessClobAddress;
        const negRiskSpender =
          request.query.negRiskSpender ?? env.limitlessNegRiskAddress;
        const adapterSpender = request.query.adapterSpender ?? null;
        const ammSpender = request.query.ammSpender ?? null;
        const tokenId = normalizeLimitlessRawTokenId(request.query.tokenId);
        const conditionalTokensAddress = env.limitlessConditionalTokensAddress;
        const effectiveSessionProfile =
          verifySession && sessionValid === false ? null : sessionProfile;
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
              })
            : Promise.resolve(null),
          negRiskSpender
            ? fetchErc1155IsApprovedForAll({
                rpcUrl: env.baseRpcUrl,
                timeoutMs: env.baseRpcTimeoutMs,
                contractAddress: conditionalTokensAddress,
                owner: signer,
                operator: negRiskSpender,
              })
            : Promise.resolve(null),
          adapterSpender
            ? fetchErc1155IsApprovedForAll({
                rpcUrl: env.baseRpcUrl,
                timeoutMs: env.baseRpcTimeoutMs,
                contractAddress: conditionalTokensAddress,
                owner: signer,
                operator: adapterSpender,
              })
            : Promise.resolve(null),
          ammSpender
            ? fetchErc1155IsApprovedForAll({
                rpcUrl: env.baseRpcUrl,
                timeoutMs: env.baseRpcTimeoutMs,
                contractAddress: conditionalTokensAddress,
                owner: signer,
                operator: ammSpender,
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
          hasCredentials
            ? fetchLimitlessProfileForAddress({
                address: signer,
                sessionCookie,
              })
            : Promise.resolve(null),
        ]);

        const profile = mergeProfiles(
          effectiveSessionProfile,
          mergeProfiles(storedProfile, liveProfile),
        );

        const usdcBalance = snapshot.usdcBalance;
        const allowanceClob = snapshot.allowanceClob;
        const allowanceNegRisk = snapshot.allowanceNegRisk;
        const allowanceAmm = snapshot.allowanceAmm;
        const tokenBalanceRaw =
          tokenId && tokenBalanceMap ? tokenBalanceMap.get(tokenId) ?? 0n : null;

        const isContract = typeof code === "string" && code.length > 2;

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
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
              ...(clobSpender
                ? { clob: approvedClob ?? false }
                : {}),
              ...(negRiskSpender
                ? { negRisk: approvedNegRisk ?? false }
                : {}),
              ...(adapterSpender
                ? { adapter: approvedAdapter ?? false }
                : {}),
              ...(ammSpender
                ? { amm: approvedAmm ?? false }
                : {}),
            },
          },
          profile: profile ?? null,
          hasCredentials,
          ...(sessionValid == null ? {} : { sessionValid }),
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to fetch Limitless account snapshot",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Limitless account snapshot",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * GET /redemption/status
   * Returns payout readiness for one or more Limitless conditions.
   */
  z.get(
    "/redemption/status",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessRedemptionQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless redemption requires an EVM wallet address",
        });
      }

      const conditionIds = request.query.conditionIds
        .map((value) => value.trim())
        .filter((value) => isBytes32(value));

      if (conditionIds.length === 0) {
        reply.code(400);
        return reply.send({ error: "No valid conditionIds provided." });
      }

      const adapter =
        typeof request.query.adapter === "string"
          ? request.query.adapter.trim()
          : null;

      try {
        const [payouts, adapterApproved] = await Promise.all([
          fetchConditionalTokensPayouts({ conditionIds }),
          adapter && isEvmWallet(adapter)
            ? fetchErc1155IsApprovedForAll({
                rpcUrl: env.baseRpcUrl,
                timeoutMs: env.baseRpcTimeoutMs,
                contractAddress: env.limitlessConditionalTokensAddress,
                owner: signer,
                operator: adapter,
              })
            : Promise.resolve(null),
        ]);

        reply.header("Content-Type", "application/json; charset=utf-8");
        return reply.send({
          ok: true,
          venue: "limitless",
          signer,
          conditionalTokens: {
            contractAddress: env.limitlessConditionalTokensAddress,
          },
          adapter: adapter ?? null,
          adapterApproved,
          conditions: payouts,
        });
      } catch (error) {
        app.log.error(
          { error, userId: user.id, signer },
          "Failed to fetch Limitless redemption status",
        );
        reply.code(502);
        return reply.send({
          error: "Failed to fetch Limitless redemption status",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /order
   */
  z.post(
    "/order",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless order requires an EVM wallet address",
        });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const verify = await limitlessRequest({
        method: "GET",
        requestPath: "/auth/verify-auth",
        sessionCookie,
      });
      if (!verify.ok) {
        await AuthService.deactivateVenueCredentials(user.id, "limitless", signer);
        reply.code(400);
        return reply.send({
          error: "Limitless session is invalid. Reconnect Limitless and retry.",
          status: verify.status,
          payload: verify.payload,
        });
      }
      const verifiedProfile = extractProfile(verify.payload);
      const verifiedAccount =
        typeof verifiedProfile?.account === "string"
          ? toChecksumAddress(verifiedProfile.account)
          : null;
      if (
        verifiedAccount &&
        normalizeAddress(verifiedAccount) !== normalizeAddress(signer)
      ) {
        await AuthService.deactivateVenueCredentials(user.id, "limitless", signer);
        reply.code(400);
        return reply.send({
          error:
            "Limitless session belongs to a different account. Reconnect Limitless for this wallet.",
          expected: signer,
          actual: verifiedAccount,
        });
      }

      const storedProfile = extractProfile(creds?.additionalData ?? null);
      const sessionProfile = extractProfileFromSessionCookie(sessionCookie);
      const liveProfile = await fetchLimitlessProfileForAddress({
        address: signer,
        sessionCookie,
      });
      const profile = mergeProfiles(
        mergeProfiles(verifiedProfile, sessionProfile),
        mergeProfiles(storedProfile, liveProfile),
      );
      const ownerId = profile?.id;
      if (!ownerId) {
        reply.code(400);
        return reply.send({
          error: "Limitless ownerId not available (connect first)",
        });
      }
      if (request.body.ownerId != null && request.body.ownerId !== ownerId) {
        app.log.warn(
          {
            userId: user.id,
            walletAddress: signer,
            requestedOwnerId: request.body.ownerId,
            sessionOwnerId: ownerId,
          },
          "Ignoring client-supplied Limitless ownerId; using session ownerId",
        );
      }

      const order = request.body.order;
      const orderSigner =
        typeof order.signer === "string" ? order.signer : "";
      if (normalizeAddress(orderSigner) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order signer must match the selected wallet",
        });
      }

      const maker = typeof order.maker === "string" ? order.maker : "";
      if (normalizeAddress(maker) !== normalizeAddress(signer)) {
        reply.code(400);
        return reply.send({
          error: "Order maker must match the selected wallet",
        });
      }
      const checksumSigner = toChecksumAddress(signer);
      if (!checksumSigner) {
        reply.code(400);
        return reply.send({
          error: "Selected wallet is not a valid EVM address",
        });
      }

      const side = normalizeOrderSide(order.side);
      if (!side) {
        reply.code(400);
        return reply.send({
          error: "Order side must be BUY/SELL (or 0/1)",
        });
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
        const feeRateBps = coerceOrderNumber(
          order.feeRateBps ?? 0,
          "feeRateBps",
        );
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
          reply.code(400);
          return reply.send({
            error: "Order numeric fields are required.",
          });
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
      } catch (error) {
        reply.code(400);
        return reply.send({
          error: error instanceof Error ? error.message : "Invalid order data.",
        });
      }

      if (request.body.orderType === "FOK") {
        if (coercedTakerAmount !== 1) {
          reply.code(400);
          return reply.send({
            error: "FOK orders require takerAmount to equal 1.",
          });
        }
        if (coercedNonce !== 0) {
          reply.code(400);
          return reply.send({
            error: "FOK orders require nonce to equal 0.",
          });
        }
        if (coercedPrice != null) {
          reply.code(400);
          return reply.send({
            error: "FOK orders must not include price.",
          });
        }
      } else {
        if (coercedPrice == null) {
          reply.code(400);
          return reply.send({
            error: "GTC orders require a price.",
          });
        }
        if (
          coercedMakerAmount == null ||
          coercedTakerAmount == null ||
          coercedSideValue == null
        ) {
          reply.code(400);
          return reply.send({
            error: "GTC orders require makerAmount, takerAmount, and side.",
          });
        }
        const priceRaw = Math.round(coercedPrice * 1_000_000);
        if (priceRaw <= 0 || priceRaw >= 1_000_000) {
          reply.code(400);
          return reply.send({
            error: "GTC price must be between 0 and 1.",
          });
        }
        if (priceRaw % 1_000 !== 0) {
          reply.code(400);
          return reply.send({
            error: "GTC price must align to 0.001 tick size.",
          });
        }
        const sharesRaw =
          coercedSideValue === 0 ? coercedTakerAmount : coercedMakerAmount;
        if (sharesRaw <= 0) {
          reply.code(400);
          return reply.send({
            error: "GTC share size must be positive.",
          });
        }
        if (sharesRaw % 1_000 !== 0) {
          reply.code(400);
          return reply.send({
            error: "GTC size must align to 0.001 shares.",
          });
        }
        const quoteRaw =
          coercedSideValue === 0 ? coercedMakerAmount : coercedTakerAmount;
        if (quoteRaw <= 0) {
          reply.code(400);
          return reply.send({
            error: "GTC quote size must be positive.",
          });
        }
        const numerator = BigInt(sharesRaw) * BigInt(priceRaw);
        const denominator = BigInt(1_000_000);
        const expectedQuote =
          coercedSideValue === 0
            ? Number((numerator + denominator - BigInt(1)) / denominator)
            : Number(numerator / denominator);
        if (Math.abs(expectedQuote - quoteRaw) > 1) {
          reply.code(400);
          return reply.send({
            error:
              "GTC order amounts are not aligned with price tick and share size.",
          });
        }
      }

      const requestedRawTokenId = normalizeRawLimitlessTokenIdFromUnknown(
        orderForUpstream.tokenId,
      );
      if (!requestedRawTokenId) {
        reply.code(400);
        return reply.send({ error: "Order tokenId is invalid." });
      }
      const marketTokens = await resolveLimitlessTokenPairForSlug({
        slug: request.body.marketSlug,
        sessionCookie,
      });
      const allowedRawTokenIds = [
        marketTokens?.tokenYes ?? null,
        marketTokens?.tokenNo ?? null,
      ].filter((entry): entry is string => Boolean(entry));
      if (!allowedRawTokenIds.length) {
        reply.code(400);
        return reply.send({
          error:
            "Unable to validate market tokens for this marketSlug. Please refresh and retry.",
        });
      }
      if (!allowedRawTokenIds.includes(requestedRawTokenId)) {
        reply.code(400);
        return reply.send({
          error: "Order tokenId does not belong to marketSlug.",
          marketSlug: request.body.marketSlug,
          tokenId: requestedRawTokenId,
        });
      }

      const orderPayload = {
        order: orderForUpstream,
        orderType: request.body.orderType,
        marketSlug: request.body.marketSlug,
        ownerId,
      };

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/orders",
        sessionCookie,
        body: orderPayload,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless order placement failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const venueOrderId =
        (isRecord(upstream.payload) &&
          isRecord(upstream.payload.order) &&
          typeof upstream.payload.order.id === "string" &&
          upstream.payload.order.id) ||
        null;

      if (!venueOrderId) {
        reply.code(502);
        return reply.send({
          error: "Limitless order placed but no orderId returned",
          payload: upstream.payload,
        });
      }

      const tokenId = normalizeLimitlessScopedTokenId(
        typeof order.tokenId === "string"
          ? order.tokenId
          : String(order.tokenId ?? ""),
      );
      const makerAmount = parseNumberish(order.makerAmount);
      const takerAmount = parseNumberish(order.takerAmount);
      const price = parseNumberish(order.price);
      const size = deriveSize(request.body.orderType, side, makerAmount, takerAmount);
      const status =
        (isRecord(upstream.payload) &&
          isRecord(upstream.payload.order) &&
          typeof upstream.payload.order.status === "string" &&
          upstream.payload.order.status) ||
        "submitted";

      const stored = await storeOrder(pool, {
        userId: user.id,
        walletAddress: signer,
        signerAddress: signer,
        venue: "limitless",
        venueOrderId,
        tokenId: tokenId ?? null,
        side,
        orderType: request.body.orderType,
        price,
        size,
        status,
        errorMessage: null,
        rawError: null,
        orderPayload,
      });

      if (
        stored.kind === "stored" &&
        request.body.orderType === "FOK" &&
        tokenId &&
        isImmediateExecutionStatus(status)
      ) {
        const immediateFill = extractLimitlessImmediateFill(upstream.payload, side, {
          price,
          size,
        });
        if (immediateFill) {
          try {
            await applyOptimisticPositionTrade(pool, {
              userId: user.id,
              walletAddress: signer,
              venue: "limitless",
              tokenId,
              side,
              shares: immediateFill.shares,
              notionalUsd: immediateFill.notionalUsd,
            });
          } catch (error) {
            app.log.warn(
              {
                error,
                userId: user.id,
                walletAddress: signer,
                tokenId,
                side,
              },
              "Limitless optimistic position update failed",
            );
          }
        }
      }

      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: user.id,
          venue: "limitless",
          status,
          side,
          size,
          price,
          orderId: venueOrderId,
          tokenId: tokenId ?? null,
          walletAddress: signer,
        }),
        app.log,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        orderId: venueOrderId,
        payload: upstream.payload,
      });
    },
  );

  /**
   * POST /orders/amm
   * Store on-chain AMM executions as filled orders for portfolio/position sync.
   */
  z.post(
    "/orders/amm",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessAmmOrderBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      if (!isEvmWallet(signer)) {
        reply.code(400);
        return reply.send({
          error: "Limitless AMM order requires an EVM wallet address",
        });
      }

      const tokenId = normalizeLimitlessScopedTokenId(request.body.tokenId);
      if (!tokenId) {
        reply.code(400);
        return reply.send({ error: "tokenId is required" });
      }

      const side = request.body.side;
      const size = request.body.size;
      const amountUsd = request.body.amountUsd ?? null;
      let price = request.body.price ?? null;
      if (price == null && amountUsd != null && size > 0) {
        price = amountUsd / size;
      }
      if (price != null && (!Number.isFinite(price) || price <= 0)) {
        price = null;
      }

      const txHash = request.body.txHash;
      const venueOrderId = `amm:${txHash}:${tokenId}`;
      const now = new Date();

      const stored = await storeOrder(pool, {
        userId: user.id,
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
          ...request.body,
          tokenId,
          price,
        },
        orderHash: txHash,
        postedAt: now,
        lastUpdate: now,
        filledAt: now,
      });

      const fallbackNotional =
        amountUsd != null && Number.isFinite(amountUsd) && amountUsd > 0
          ? amountUsd
          : price != null && Number.isFinite(price) && price > 0
            ? price * size
            : null;
      if (stored.kind === "stored" && fallbackNotional != null) {
        try {
          await applyOptimisticPositionTrade(pool, {
            userId: user.id,
            walletAddress: signer,
            venue: "limitless",
            tokenId,
            side,
            shares: size,
            notionalUsd: fallbackNotional,
          });
        } catch (error) {
          app.log.warn(
            {
              error,
              userId: user.id,
              walletAddress: signer,
              tokenId,
              side,
            },
            "Limitless AMM optimistic position update failed",
          );
        }
      }

      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: user.id,
          venue: "limitless",
          status: "filled",
          side,
          size,
          price: price ?? null,
          orderId: venueOrderId,
          tokenId,
          walletAddress: signer,
        }),
        app.log,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, orderId: venueOrderId });
    },
  );

  /**
   * POST /orders/sync
   * Fetch open orders from Limitless and upsert them into `orders`.
   */
  z.post(
    "/orders/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(
          request.query.slug,
        )}/user-orders`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless orders sync failed",
          status: upstream.status,
          payload: upstream.payload,
        });
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

        const result = await storeOrder(pool, {
          userId: user.id,
          walletAddress: signer,
          signerAddress: signer,
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
        });

        if (result.kind === "stored") storedNew += 1;
        if (result.kind === "exists") alreadyKnown += 1;
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "limitless",
        walletAddress: signer,
        fetched: ordersRaw.length,
        storedNew,
        alreadyKnown,
        skippedNoId,
        sampleVenueOrderIds: orderIds.slice(0, 10),
      });
    },
  );

  /**
   * POST /orders/history/sync
   * Fetch portfolio history from Limitless and upsert into `orders`.
   */
  z.post(
    "/orders/history/sync",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessHistoryQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const query = request.query;
      const walletAddresses = await resolveWalletAddresses(
        user.id,
        signer,
        query.wallets,
      );

      if (walletAddresses.length === 0) {
        reply.code(400);
        return reply.send({ error: "No wallets available to sync." });
      }

      const results: Array<{
        walletAddress: string;
        status: "ok" | "error" | "skipped";
        fetched?: number;
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
        if (!isEvmWallet(wallet)) {
          skipped += 1;
          results.push({
            walletAddress: wallet,
            status: "skipped",
            error: "EVM wallet required for Limitless.",
          });
          continue;
        }

        const creds = await AuthService.getVenueCredentials(
          user.id,
          "limitless",
          wallet,
        );
        const sessionCookie = creds?.apiSecret?.trim();
        if (!sessionCookie) {
          errors += 1;
          results.push({
            walletAddress: wallet,
            status: "error",
            error: "Limitless session not found (connect first).",
          });
          continue;
        }

        let stats;
        try {
          stats = await syncLimitlessHistoryForWallet(pool, {
            userId: user.id,
            walletAddress: wallet,
            sessionCookie,
            page: query.page,
            limit: query.limit,
            from: query.from,
            to: query.to,
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
          await recomputePositionMetricsForWallet(pool, {
            userId: user.id,
            walletAddress: wallet,
            venue: "limitless",
          });
        } catch (error) {
          app.log.error(
            { error, userId: user.id, walletAddress: wallet },
            "Limitless position metrics update failed",
          );
        }

        synced += 1;
        results.push({
          walletAddress: wallet,
          status: "ok",
          fetched: stats.fetched,
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

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        venue: "limitless",
        page: query.page,
        limit: query.limit,
        results,
        summary: {
          synced,
          skipped,
          errors,
        },
      });
    },
  );

  /**
   * GET /market/exchange
   * Resolve canonical exchange address for a market slug directly from Limitless.
   */
  z.get(
    "/market/exchange",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessMarketExchangeQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(request.query.slug)}`,
        ...(sessionCookie ? { sessionCookie } : {}),
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless market exchange fetch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const exchangeAddress = extractLimitlessMarketExchangeAddress(
        upstream.payload,
      );
      const adapterAddress = extractLimitlessMarketAdapterAddress(
        upstream.payload,
      );
      let canonicalExchangeAddress = exchangeAddress;
      let canonicalAdapterAddress = adapterAddress;

      if (sessionCookie && isEvmWallet(signer)) {
        const signerChecksum = toChecksumAddress(signer);
        const tokenPair = extractLimitlessTokenPair(upstream.payload);
        const probeTokenId = tokenPair?.tokenYes ?? tokenPair?.tokenNo ?? null;
        const storedProfile = extractProfile(creds?.additionalData ?? null);
        const sessionProfile = extractProfileFromSessionCookie(sessionCookie);
        const liveProfile = await fetchLimitlessProfileForAddress({
          address: signer,
          sessionCookie,
        });
        const profile = mergeProfiles(
          sessionProfile,
          mergeProfiles(storedProfile, liveProfile),
        );
        const ownerId = profile?.id;

        if (signerChecksum && ownerId && probeTokenId) {
          const probeSide = request.query.side === "SELL" ? 1 : 0;
          try {
            const probe = await limitlessRequest({
              method: "POST",
              requestPath: "/orders",
              sessionCookie,
              body: {
                order: {
                  salt: Date.now() * 1000,
                  maker: signerChecksum,
                  signer: signerChecksum,
                  taker: "0x0000000000000000000000000000000000000000",
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
                marketSlug: request.query.slug,
                ownerId,
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
            app.log.warn(
              { error, slug: request.query.slug },
              "Limitless canonical exchange probe failed",
            );
          }
        }
      }

      // Null-only fallback for legacy markets: when upstream payload does not
      // provide adapter/operator, derive known operator from canonical exchange.
      if (!canonicalAdapterAddress) {
        canonicalAdapterAddress = resolveLimitlessLegacyOperatorForExchange(
          canonicalExchangeAddress ?? exchangeAddress ?? null,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({
        ok: true,
        marketSlug: request.query.slug,
        exchangeAddress: canonicalExchangeAddress,
        adapterAddress: canonicalAdapterAddress,
      });
    },
  );

  /**
   * GET /orders/:orderId
   */
  z.get(
    "/orders/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/orders/${request.params.orderId}`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless order fetch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * DELETE /order/:orderId
   */
  z.delete(
    "/order/:orderId",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessOrderIdParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "DELETE",
        requestPath: `/orders/${request.params.orderId}`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      await pool.query(
        `
          update orders
          set status = 'cancelled',
              cancelled_at = now(),
              last_update = now()
          where user_id = $1
            and (wallet_address = $2 or signer_address = $2)
            and venue = 'limitless'
            and venue_order_id = $3
        `,
        [user.id, signer, request.params.orderId],
      );

      void createNotificationSafe(
        pool,
        buildOrderNotification({
          userId: user.id,
          venue: "limitless",
          status: "cancelled",
          orderId: request.params.orderId,
          walletAddress: signer,
        }),
        app.log,
      );

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * POST /orders/cancel-batch
   */
  z.post(
    "/orders/cancel-batch",
    {
      preHandler: createAuthMiddleware(),
      schema: { body: limitlessCancelBatchBodySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "POST",
        requestPath: "/orders/cancel-batch",
        sessionCookie,
        body: { orderIds: request.body.orderIds },
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel batch failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const cancelledIds = extractLimitlessCanceledIds(
        upstream.payload,
        request.body.orderIds,
      );
      if (cancelledIds.length) {
        await pool.query(
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
          [user.id, signer, cancelledIds],
        );

        void createNotificationSafe(
          pool,
          {
            userId: user.id,
            type: "order_cancelled",
            title: "Orders cancelled",
            body: `${cancelledIds.length} Limitless orders`,
            severity: "warning",
            data: {
              venue: "limitless",
              orderIds: cancelledIds,
              walletAddress: signer,
            },
            dedupeKey: `order_cancelled_batch:${cancelledIds[0] ?? "batch"}`,
          },
          app.log,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * DELETE /orders/all/:slug
   */
  z.delete(
    "/orders/all/:slug",
    {
      preHandler: createAuthMiddleware(),
      schema: { params: limitlessSlugParamsSchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      let openOrderIds: string[] = [];
      const openOrders = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${encodeURIComponent(
          request.params.slug,
        )}/user-orders`,
        sessionCookie,
      });
      if (openOrders.ok) {
        openOrderIds = extractLimitlessOrders(openOrders.payload)
          .map((order) => extractLimitlessOrderId(order))
          .filter((orderId): orderId is string => Boolean(orderId));
      } else {
        app.log.warn(
          {
            status: openOrders.status,
            payload: openOrders.payload,
            slug: request.params.slug,
          },
          "Limitless cancel all: failed to fetch open orders",
        );
      }

      const upstream = await limitlessRequest({
        method: "DELETE",
        requestPath: `/orders/all/${request.params.slug}`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless cancel all failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      const cancelledIds = extractLimitlessCanceledIds(
        upstream.payload,
        openOrderIds,
      );
      if (cancelledIds.length) {
        await pool.query(
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
          [user.id, signer, cancelledIds],
        );

        void createNotificationSafe(
          pool,
          {
            userId: user.id,
            type: "order_cancelled",
            title: "Orders cancelled",
            body: `${cancelledIds.length} Limitless orders`,
            severity: "warning",
            data: {
              venue: "limitless",
              orderIds: cancelledIds,
              walletAddress: signer,
            },
            dedupeKey: `order_cancelled_all:${cancelledIds[0] ?? "all"}`,
          },
          app.log,
        );
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );

  /**
   * GET /orders/open
   */
  z.get(
    "/orders/open",
    {
      preHandler: createAuthMiddleware(),
      schema: { querystring: limitlessOpenOrdersQuerySchema },
    },
    async (request, reply) => {
      const user = request.user;
      const signer = request.walletAddress;
      if (!user || !signer) {
        reply.code(401);
        return reply.send({ error: "Unauthorized" });
      }

      const creds = await AuthService.getVenueCredentials(
        user.id,
        "limitless",
        signer,
      );
      const sessionCookie = creds?.apiSecret?.trim();
      if (!sessionCookie) {
        reply.code(400);
        return reply.send({
          error: "Limitless session not found (connect first)",
        });
      }

      const upstream = await limitlessRequest({
        method: "GET",
        requestPath: `/markets/${request.query.slug}/user-orders`,
        sessionCookie,
      });

      if (!upstream.ok) {
        reply.code(502);
        return reply.send({
          error: "Limitless open orders failed",
          status: upstream.status,
          payload: upstream.payload,
        });
      }

      reply.header("Content-Type", "application/json; charset=utf-8");
      return reply.send({ ok: true, payload: upstream.payload });
    },
  );
};
