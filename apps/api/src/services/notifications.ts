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

function formatUsd(value: number | null, digits = 2): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `$${formatNumber(value, digits)}`;
}

function formatVenue(venue: string): string {
  if (!venue) return "Venue";
  return venue.charAt(0).toUpperCase() + venue.slice(1);
}

export function buildOrderNotification(input: {
  userId: string;
  venue: string;
  status?: string | null;
  side?: string | null;
  size?: number | null;
  price?: number | null;
  orderId?: string | null;
  marketId?: string | null;
  tokenId?: string | null;
  walletAddress?: string | null;
}): NotificationInput {
  const status = input.status?.toLowerCase() ?? "";
  let type = "order_created";
  let title = "Order submitted";
  let severity: NotificationSeverity = "info";

  if (status === "cancelled" || status === "canceled") {
    type = "order_cancelled";
    title = "Order cancelled";
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

  const parts: string[] = [formatVenue(input.venue)];
  if (input.side) parts.push(input.side);
  if (input.size != null && input.size > 0) {
    parts.push(formatNumber(input.size, 4));
  }
  if (input.price != null && input.price > 0) {
    parts.push(`@ ${formatUsd(input.price, 4)}`);
  }

  const body = parts.join(" ").trim() || `${formatVenue(input.venue)} order`;
  const dedupeKey = input.orderId ? `${type}:${input.orderId}` : null;

  return {
    userId: input.userId,
    type,
    title,
    body,
    severity,
    data: {
      venue: input.venue,
      status: input.status ?? null,
      side: input.side ?? null,
      size: input.size ?? null,
      price: input.price ?? null,
      orderId: input.orderId ?? null,
      marketId: input.marketId ?? null,
      tokenId: input.tokenId ?? null,
      walletAddress: input.walletAddress ?? null,
    },
    dedupeKey,
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
  const body = bodyParts.join(" ").trim() || `${formatVenue(input.venue)} trade`;
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
  status: "completed" | "failed";
  srcChainId?: string | null;
  dstChainId?: string | null;
  bridgeOrderId?: string | null;
  txHash?: string | null;
}): NotificationInput {
  const title =
    input.status === "completed" ? "Bridge completed" : "Bridge failed";
  const severity: NotificationSeverity =
    input.status === "completed" ? "success" : "error";
  const route =
    input.srcChainId && input.dstChainId
      ? `${input.srcChainId} → ${input.dstChainId}`
      : null;
  const body = route
    ? `${input.provider} ${route}`
    : `${input.provider} bridge`;
  const dedupeKey = input.bridgeOrderId
    ? `bridge:${input.bridgeOrderId}:${input.status}`
    : input.txHash
      ? `bridge:${input.txHash}:${input.status}`
      : null;

  return {
    userId: input.userId,
    type: input.status === "completed" ? "bridge_completed" : "bridge_failed",
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

  const amount = formatUsd(input.amountUsd, 2) ?? "$0.00";
  const body = `${amount} on ${input.chainId}`;
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

function buildPayload(row: {
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
    body: row.body,
    severity: row.severity,
    data: row.data ?? null,
    readAt: row.read_at ? row.read_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

async function publishNotification(
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
): Promise<NotificationPayload | null> {
  try {
    const row = await insertNotification(db, input);
    if (!row) return null;
    const payload = buildPayload(row);
    await publishNotification(row.user_id, payload);
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
