import type { DbQuery } from "../db.js";
import { getRedis } from "../redis.js";
import type { NotificationSeverity } from "../repos/notifications-repo.js";
import { insertNotification } from "../repos/notifications-repo.js";

type Logger = { warn: (obj: unknown, msg?: string) => void };

export type NotificationInput = {
  userId: string;
  type: string;
  title: string;
  body: string;
  severity?: NotificationSeverity;
  data?: unknown;
  dedupeKey?: string | null;
  replaceExisting?: boolean;
};

export type NotificationPayload = {
  id: string;
  type: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  data: unknown;
  readAt: string | null;
  createdAt: string;
};

function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return "";
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}

function parseScaledAmount(raw: string, decimals: number): number | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value) || decimals < 0 || decimals > 30) return null;
  const scale = 10 ** decimals;
  const parsed = Number(value) / scale;
  return Number.isFinite(parsed) ? parsed : null;
}

function formatScaledAmount(raw: string, decimals: number): string | null {
  const value = raw.trim();
  if (!/^\d+$/.test(value) || decimals < 0 || decimals > 30) return null;

  const amount = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  if (fraction === 0n) return whole.toString();

  const fractional = fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const trimmedFraction =
    fractional.length > 6 ? fractional.slice(0, 6) : fractional;
  const displayFraction = trimmedFraction.replace(/0+$/, "");
  return displayFraction
    ? `${whole.toString()}.${displayFraction}`
    : whole.toString();
}

function formatUsd(value: number | null, digits = 2): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `$${formatNumber(value, digits)}`;
}

function readPositiveNumber(
  value: number | string | null | undefined,
): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === "null" || trimmed === "undefined") {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function formatRewardClaimUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.000";
  if (value > 0 && value < 0.001) return "<$0.001";
  return formatUsd(value, 3) ?? "$0.000";
}

function formatVenue(venue: string): string {
  if (!venue) return "Venue";
  return venue.charAt(0).toUpperCase() + venue.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDataString(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function maybeRepairOrderNotificationBody(input: {
  body: string;
  data: unknown;
  type: string;
}): string {
  if (!input.type.startsWith("order_") && input.type !== "trade_executed") {
    return input.body;
  }
  if (!/\s@\s*(?:null|undefined|nan)\b/i.test(input.body)) {
    return input.body;
  }
  if (!isRecord(input.data)) {
    return input.body
      .replace(/\s@\s*(?:null|undefined|nan)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  const venue = readDataString(input.data, "venue") ?? "order";
  const side = readDataString(input.data, "side");
  const size = readPositiveNumber(
    input.data.size as number | string | null | undefined,
  );
  const price = readPositiveNumber(
    input.data.price as number | string | null | undefined,
  );
  const parts = [formatVenue(venue)];
  if (side) parts.push(side);
  if (size != null) parts.push(formatNumber(size, 4));
  if (price != null) {
    const formattedPrice = formatUsd(price, 4);
    if (formattedPrice) parts.push(`@ ${formattedPrice}`);
  }
  return parts.join(" ").trim() || input.body;
}

function readNotificationDataNumber(data: unknown, key: string): number | null {
  if (!isRecord(data)) return null;
  return readPositiveNumber(data[key] as number | string | null | undefined);
}

function isIncompleteOrderFilledNotification(input: NotificationInput) {
  if (input.type !== "order_filled") return false;
  const size = readNotificationDataNumber(input.data, "size");
  const price = readNotificationDataNumber(input.data, "price");
  return size == null || price == null;
}

function formatBridgeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "debridge") return "deBridge";
  if (normalized === "across") return "Across";
  return formatVenue(provider);
}

function formatChainLabel(chain?: string | number | null): string | null {
  if (chain == null) return null;
  const raw = String(chain).trim();
  if (!raw) return null;

  const normalized = raw.toLowerCase();
  if (
    normalized === "solana" ||
    normalized.startsWith("solana:") ||
    normalized === "7565164" ||
    normalized === "34268394551451"
  ) {
    return "Solana";
  }
  if (
    normalized === "base" ||
    normalized === "8453" ||
    normalized === "eip155:8453"
  ) {
    return "Base";
  }
  if (
    normalized === "polygon" ||
    normalized === "matic" ||
    normalized === "137" ||
    normalized === "eip155:137"
  ) {
    return "Polygon";
  }
  if (
    normalized === "ethereum" ||
    normalized === "eth" ||
    normalized === "1" ||
    normalized === "eip155:1"
  ) {
    return "Ethereum";
  }

  return raw;
}

function formatChainNetwork(chain?: string | number | null): string | null {
  if (chain == null) return null;
  const normalized = String(chain).trim().toLowerCase();
  if (
    normalized === "solana" ||
    normalized.startsWith("solana:") ||
    normalized === "7565164" ||
    normalized === "34268394551451"
  ) {
    return "solana";
  }
  if (
    normalized === "base" ||
    normalized === "8453" ||
    normalized === "eip155:8453"
  ) {
    return "base";
  }
  if (
    normalized === "polygon" ||
    normalized === "matic" ||
    normalized === "137" ||
    normalized === "eip155:137"
  ) {
    return "polygon";
  }
  if (
    normalized === "ethereum" ||
    normalized === "eth" ||
    normalized === "1" ||
    normalized === "eip155:1"
  ) {
    return "ethereum";
  }
  return null;
}

export function buildOrderNotification(input: {
  userId: string;
  venue: string;
  status?: string | null;
  action?: string | null;
  outcomeSide?: "NO" | "YES" | null;
  /** @deprecated Use action or outcomeSide when the caller knows the meaning. */
  side?: string | null;
  size?: number | string | null;
  price?: number | string | null;
  orderId?: string | null;
  marketId?: string | null;
  tokenId?: string | null;
  walletAddress?: string | null;
}): NotificationInput {
  const status = input.status?.toLowerCase() ?? "";
  let type = "order_created";
  let title = "Order submitted";
  let severity: NotificationSeverity = "info";
  let displayStatus = input.status ?? null;

  if (status === "delayed") {
    title = "Order delayed";
    severity = "warning";
    displayStatus = "pending";
  } else if (status === "cancelled" || status === "canceled") {
    type = "order_cancelled";
    title = "Order cancelled";
    severity = "warning";
  } else if (status === "unmatched") {
    type = "order_failed";
    title = "Order not filled";
    severity = "warning";
  } else if (status === "expired") {
    type = "order_failed";
    title = "Order expired";
    severity = "warning";
  } else if (status === "failed") {
    type = "order_failed";
    title = "Order failed";
    severity = "error";
  } else if (status === "filled" || status === "matched") {
    type = "order_filled";
    title = "Order filled";
    severity = "success";
  }

  const size = readPositiveNumber(input.size);
  const price = readPositiveNumber(input.price);
  const normalizedLegacySide = input.side?.trim().toUpperCase() ?? null;
  const normalizedExplicitAction = input.action?.trim().toUpperCase() ?? null;
  const action =
    (normalizedExplicitAction === "BUY" || normalizedExplicitAction === "SELL"
      ? normalizedExplicitAction
      : null) ??
    (normalizedLegacySide === "BUY" || normalizedLegacySide === "SELL"
      ? normalizedLegacySide
      : null);
  const outcomeSide =
    input.outcomeSide ??
    (normalizedLegacySide === "YES" || normalizedLegacySide === "NO"
      ? normalizedLegacySide
      : null);
  const parts: string[] = [formatVenue(input.venue)];
  if (action) parts.push(action);
  else if (outcomeSide) parts.push(outcomeSide);
  else if (input.side) parts.push(input.side);
  if (size != null) {
    parts.push(formatNumber(size, 4));
  }
  if (price != null) {
    const formattedPrice = formatUsd(price, 4);
    if (formattedPrice) parts.push(`@ ${formattedPrice}`);
  }

  const body = parts.join(" ").trim() || `${formatVenue(input.venue)} order`;
  const normalizedVenue = input.venue.trim().toLowerCase();
  const dedupeKey = input.orderId
    ? `order:${normalizedVenue}:${input.orderId}`
    : null;

  return {
    userId: input.userId,
    type,
    title,
    body,
    severity,
    data: {
      venue: input.venue,
      status: displayStatus,
      action,
      outcomeSide,
      side: input.side ?? null,
      size,
      price,
      orderId: input.orderId ?? null,
      marketId: input.marketId ?? null,
      tokenId: input.tokenId ?? null,
      walletAddress: input.walletAddress ?? null,
    },
    dedupeKey,
    replaceExisting: Boolean(dedupeKey),
  };
}

export function buildTradeNotification(input: {
  userId: string;
  venue: string;
  side?: string | null;
  amountUsd?: number | null;
  marketId?: string | null;
  txHash?: string | null;
  walletAddress?: string | null;
}): NotificationInput {
  const title = "Trade executed";
  const amount = formatUsd(input.amountUsd ?? null, 2);
  const bodyParts = [formatVenue(input.venue)];
  if (input.side) bodyParts.push(input.side);
  if (amount) bodyParts.push(amount);
  const body =
    bodyParts.join(" ").trim() || `${formatVenue(input.venue)} trade`;
  const dedupeKey = input.txHash ? `trade:${input.txHash}` : null;

  return {
    userId: input.userId,
    type: "trade_executed",
    title,
    body,
    severity: "success",
    data: {
      venue: input.venue,
      side: input.side ?? null,
      amountUsd: input.amountUsd ?? null,
      marketId: input.marketId ?? null,
      txHash: input.txHash ?? null,
      walletAddress: input.walletAddress ?? null,
    },
    dedupeKey,
  };
}

export function buildRedemptionNotification(input: {
  userId: string;
  venue: string;
  amountUsd?: number | null;
  marketId?: string | null;
  tokenId?: string | null;
  txHash?: string | null;
  walletAddress?: string | null;
}): NotificationInput {
  const title = "Redemption completed";
  const amount = formatUsd(input.amountUsd ?? null, 2);
  const bodyParts = [formatVenue(input.venue), "redemption"];
  if (amount) bodyParts.push(amount);
  const body = bodyParts.join(" ").trim() || "Redemption completed";
  const dedupeKey = input.txHash
    ? `redemption:${input.txHash}`
    : input.marketId && input.walletAddress
      ? `redemption:${input.venue}:${input.marketId}:${input.walletAddress}`
      : null;

  return {
    userId: input.userId,
    type: "redemption_completed",
    title,
    body,
    severity: "success",
    data: {
      venue: input.venue,
      amountUsd: input.amountUsd ?? null,
      marketId: input.marketId ?? null,
      tokenId: input.tokenId ?? null,
      txHash: input.txHash ?? null,
      walletAddress: input.walletAddress ?? null,
    },
    dedupeKey,
  };
}

export function buildBridgeNotification(input: {
  userId: string;
  provider: string;
  status: "completed" | "failed" | "refunded";
  srcChainId?: string | null;
  dstChainId?: string | null;
  bridgeOrderId?: string | null;
  txHash?: string | null;
}): NotificationInput {
  const title =
    input.status === "completed"
      ? "Bridge completed"
      : input.status === "refunded"
        ? "Bridge refunded"
        : "Bridge failed";
  const severity: NotificationSeverity =
    input.status === "completed"
      ? "success"
      : input.status === "refunded"
        ? "warning"
        : "error";
  const route =
    input.srcChainId && input.dstChainId
      ? `${formatChainLabel(input.srcChainId)} → ${formatChainLabel(input.dstChainId)}`
      : null;
  const body = route
    ? `${formatBridgeProvider(input.provider)} ${route}`
    : `${formatBridgeProvider(input.provider)} bridge`;
  const dedupeKey = input.bridgeOrderId
    ? `bridge:${input.bridgeOrderId}:${input.status}`
    : input.txHash
      ? `bridge:${input.txHash}:${input.status}`
      : null;

  return {
    userId: input.userId,
    type:
      input.status === "completed"
        ? "bridge_completed"
        : input.status === "refunded"
          ? "bridge_refunded"
          : "bridge_failed",
    title,
    body,
    severity,
    data: {
      provider: input.provider,
      status: input.status,
      srcChainId: input.srcChainId ?? null,
      dstChainId: input.dstChainId ?? null,
      bridgeOrderId: input.bridgeOrderId ?? null,
      txHash: input.txHash ?? null,
    },
    dedupeKey,
  };
}

function formatDepositChain(caip2?: string | null): string | null {
  return formatChainLabel(caip2);
}

function formatDepositNetwork(caip2?: string | null): string | null {
  return formatChainNetwork(caip2);
}

function normalizeDepositAssetAddress(
  asset: Record<string, unknown> | null | undefined,
): string {
  const address = typeof asset?.address === "string" ? asset.address : "";
  return address.toLowerCase();
}

function formatKnownDepositUsdAsset(
  asset: Record<string, unknown> | null | undefined,
): string | null {
  const mint = typeof asset?.mint === "string" ? asset.mint : "";
  const address = normalizeDepositAssetAddress(asset);
  if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") return "USDC";
  if (address === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") return "USDC";
  if (address === "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359") return "USDC";
  if (address === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174") return "USDC.e";
  if (address === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb") return "pUSD";
  return null;
}

function formatDepositAsset(
  asset: Record<string, unknown> | null | undefined,
  caip2?: string | null,
): string {
  const type = typeof asset?.type === "string" ? asset.type : "";
  const mint = typeof asset?.mint === "string" ? asset.mint : "";
  const address = typeof asset?.address === "string" ? asset.address : "";
  const normalizedCaip2 = caip2?.toLowerCase() ?? "";
  if (type === "native-token") {
    if (normalizedCaip2.startsWith("solana:")) return "SOL";
    if (normalizedCaip2 === "eip155:137") return "POL";
    return "native token";
  }
  const knownUsdAsset = formatKnownDepositUsdAsset({ mint, address });
  if (knownUsdAsset) return knownUsdAsset;
  if (type === "spl") return "SPL token";
  if (type === "erc20") return "token";
  return "funds";
}

function isDepositUsdStableAsset(
  asset: Record<string, unknown> | null | undefined,
): boolean {
  const mint = typeof asset?.mint === "string" ? asset.mint : "";
  const address = typeof asset?.address === "string" ? asset.address : "";
  return (
    mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ||
    address.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" ||
    address.toLowerCase() === "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" ||
    address.toLowerCase() === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174" ||
    address.toLowerCase() === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb"
  );
}

function inferDepositAssetDecimals(
  asset: Record<string, unknown> | null | undefined,
  caip2?: string | null,
): number | null {
  const type = typeof asset?.type === "string" ? asset.type : "";
  const normalizedCaip2 = caip2?.toLowerCase() ?? "";
  if (isDepositUsdStableAsset(asset)) return 6;
  if (type === "native-token") {
    if (normalizedCaip2.startsWith("solana:")) return 9;
    if (normalizedCaip2.startsWith("eip155:")) return 18;
  }
  return null;
}

function formatDepositAmountLabel(input: {
  amountRaw: string;
  asset: Record<string, unknown> | null | undefined;
  caip2?: string | null;
}): string | null {
  const decimals = inferDepositAssetDecimals(input.asset, input.caip2);
  if (decimals == null) return null;
  const amount = formatScaledAmount(input.amountRaw, decimals);
  if (!amount) return null;
  return `${amount} ${formatDepositAsset(input.asset, input.caip2)}`;
}

export function buildDepositNotification(input: {
  userId: string;
  source: string;
  walletAddress?: string | null;
  walletType?: string | null;
  caip2?: string | null;
  asset?: Record<string, unknown> | null;
  amountRaw: string;
  txHash?: string | null;
  idempotencyKey: string;
}): NotificationInput {
  const asset = formatDepositAsset(input.asset, input.caip2);
  const chain = formatDepositChain(input.caip2);
  const amountLabel = formatDepositAmountLabel({
    amountRaw: input.amountRaw,
    asset: input.asset,
    caip2: input.caip2,
  });
  const amountUsd = isDepositUsdStableAsset(input.asset)
    ? parseScaledAmount(input.amountRaw, 6)
    : null;
  const assetLabel = amountLabel ?? asset;
  const body = chain
    ? `${assetLabel} deposit received on ${chain}`
    : `${assetLabel} deposit received`;
  const dedupeKey = `deposit:${input.source}:${input.idempotencyKey}`;

  return {
    userId: input.userId,
    type: "deposit_received",
    title: "Deposit received",
    body,
    severity: "success",
    data: {
      category: "funds",
      source: input.source,
      walletAddress: input.walletAddress ?? null,
      walletType: input.walletType ?? null,
      caip2: input.caip2 ?? null,
      network: formatDepositNetwork(input.caip2),
      asset: input.asset ?? null,
      amountRaw: input.amountRaw,
      amountLabel,
      amountUsd,
      txHash: input.txHash ?? null,
    },
    dedupeKey,
  };
}

export function buildRewardNotification(input: {
  userId: string;
  status: "submitted" | "confirmed" | "failed";
  amountUsd: number;
  chainId: string;
  claimId: string;
  walletAddress: string;
}): NotificationInput {
  const titleMap = {
    submitted: "Cashback claim submitted",
    confirmed: "Cashback paid out",
    failed: "Cashback claim failed",
  } as const;
  const severityMap: Record<typeof input.status, NotificationSeverity> = {
    submitted: "info",
    confirmed: "success",
    failed: "error",
  };

  const amount = formatRewardClaimUsd(input.amountUsd);
  const chain = formatChainLabel(input.chainId) ?? input.chainId;
  const body = `${amount} on ${chain}`;
  const dedupeKey = `reward:${input.claimId}:${input.status}`;

  return {
    userId: input.userId,
    type: `reward_claim_${input.status}`,
    title: titleMap[input.status],
    body,
    severity: severityMap[input.status],
    data: {
      claimId: input.claimId,
      amountUsd: input.amountUsd,
      chainId: input.chainId,
      walletAddress: input.walletAddress,
      status: input.status,
    },
    dedupeKey,
  };
}

export function buildNotificationPayload(row: {
  id: string;
  type: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  data: unknown;
  read_at: Date | null;
  created_at: Date;
}): NotificationPayload {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: maybeRepairOrderNotificationBody({
      body: row.body,
      data: row.data,
      type: row.type,
    }),
    severity: row.severity,
    data: row.data ?? null,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function publishNotification(
  userId: string,
  payload: NotificationPayload,
): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  await redis.publish(`notify:${userId}`, JSON.stringify(payload));
}

export async function createNotificationSafe(
  db: DbQuery,
  input: NotificationInput,
  logger?: Logger,
  options: { publish?: boolean } = {},
): Promise<NotificationPayload | null> {
  try {
    const normalizedInput: NotificationInput = {
      ...input,
      body: maybeRepairOrderNotificationBody({
        body: input.body,
        data: input.data,
        type: input.type,
      }),
    };
    if (isIncompleteOrderFilledNotification(normalizedInput)) {
      const orderId = isRecord(normalizedInput.data)
        ? normalizedInput.data.orderId
        : null;
      logger?.warn?.(
        { orderId },
        "Skipping incomplete order filled notification",
      );
      return null;
    }
    const row = await insertNotification(db, normalizedInput);
    if (!row) return null;
    const payload = buildNotificationPayload(row);
    if (options.publish !== false) {
      await publishNotification(row.user_id, payload);
    }
    return payload;
  } catch (error) {
    if (logger?.warn) {
      logger.warn({ error, input }, "Failed to create notification");
    } else {
      console.warn("[notifications] failed", String(error));
    }
    return null;
  }
}
