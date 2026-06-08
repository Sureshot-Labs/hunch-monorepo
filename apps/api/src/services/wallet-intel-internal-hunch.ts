export type InternalHunchFillSide = "BUY" | "SELL";
export type InternalHunchWalletChain = "polygon" | "base" | "solana";

export type InternalHunchFillActivityInput = {
  walletId: string;
  venue: string;
  marketId: string;
  outcomeSide: string | null;
  tokenId: string;
  orderId: string;
  orderFillId: string;
  venueFillId: string | null;
  venueTradeId: string | null;
  fillSize: number;
  fillPrice: number;
  fillSide: string | null;
  filledAt: Date;
};

export type InternalHunchFillActivityEvent = {
  walletId: string;
  venue: string;
  marketId: string;
  outcomeSide: string | null;
  action: InternalHunchFillSide;
  deltaShares: number;
  sizeUsd: number;
  price: number;
  occurredAt: string;
  metadata: Record<string, unknown>;
};

export type InternalHunchFillInitialShares = {
  walletId: string;
  venue: string;
  tokenId: string;
  shares: number;
};

export function normalizeInternalHunchWalletAddress(
  address: string | null | undefined,
  chain: InternalHunchWalletChain,
): string | null {
  const trimmed = address?.trim();
  if (!trimmed) return null;
  return chain === "solana" ? trimmed : trimmed.toLowerCase();
}

export function internalHunchWalletAddressesMatch(inputs: {
  chain: InternalHunchWalletChain;
  left: string | null | undefined;
  right: string | null | undefined;
}): boolean {
  const left = normalizeInternalHunchWalletAddress(inputs.left, inputs.chain);
  const right = normalizeInternalHunchWalletAddress(inputs.right, inputs.chain);
  return left != null && right != null && left === right;
}

export function shouldSuppressInternalHunchSnapshotDelta(inputs: {
  snapshotSource: string | null;
  hasPreviousSameKey: boolean;
  prevShares: number;
  currShares: number;
}): boolean {
  return (
    inputs.snapshotSource === "hunch_own_position_open" &&
    !inputs.hasPreviousSameKey &&
    inputs.prevShares <= 0 &&
    inputs.currShares > 0
  );
}

function compareFillInputs(
  left: InternalHunchFillActivityInput,
  right: InternalHunchFillActivityInput,
): number {
  const timeDiff = left.filledAt.getTime() - right.filledAt.getTime();
  if (timeDiff !== 0) return timeDiff;
  return left.orderFillId.localeCompare(right.orderFillId);
}

function isoTimestampWithMicroOffset(base: Date, offsetMicros: number): string {
  const epochMicros =
    BigInt(base.getTime()) * 1000n + BigInt(Math.max(0, offsetMicros));
  const microsPerSecond = 1_000_000n;
  const secondMillis = (epochMicros / microsPerSecond) * 1000n;
  const microOfSecond = Number(epochMicros % microsPerSecond);
  const secondIso = new Date(Number(secondMillis))
    .toISOString()
    .replace(/\.\d{3}Z$/, "");
  return `${secondIso}.${String(microOfSecond).padStart(6, "0")}Z`;
}

function fillShareKey(inputs: {
  walletId: string;
  venue: string;
  tokenId: string;
}): string {
  return `${inputs.walletId}:${inputs.venue}:${inputs.tokenId}`;
}

export function selectNewestInternalHunchFillReplayInputs<
  T extends Pick<InternalHunchFillActivityInput, "filledAt" | "orderFillId">,
>(rows: T[], limit: number): T[] {
  if (limit <= 0) return [];
  return [...rows]
    .sort((left, right) => {
      const timeDiff = right.filledAt.getTime() - left.filledAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return right.orderFillId.localeCompare(left.orderFillId);
    })
    .slice(0, Math.max(0, Math.trunc(limit)))
    .sort((left, right) => {
      const timeDiff = left.filledAt.getTime() - right.filledAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return left.orderFillId.localeCompare(right.orderFillId);
    });
}

export function buildInternalHunchFillActivityEvents(
  rows: InternalHunchFillActivityInput[],
  options: { initialShares?: InternalHunchFillInitialShares[] } = {},
): InternalHunchFillActivityEvent[] {
  const sortedRows = [...rows].sort(compareFillInputs);
  const runningShares = new Map<string, number>();
  const timestampOrdinals = new Map<string, number>();
  const events: InternalHunchFillActivityEvent[] = [];

  for (const initial of options.initialShares ?? []) {
    if (!Number.isFinite(initial.shares) || initial.shares <= 0) continue;
    runningShares.set(fillShareKey(initial), initial.shares);
  }

  for (const row of sortedRows) {
    const side = row.fillSide?.trim().toUpperCase();
    if (side !== "BUY" && side !== "SELL") continue;
    if (!Number.isFinite(row.fillSize) || row.fillSize <= 0) continue;
    if (!Number.isFinite(row.fillPrice) || row.fillPrice < 0) continue;

    const shareKey = fillShareKey(row);
    const prevShares = runningShares.get(shareKey) ?? 0;
    const signedSize = side === "BUY" ? row.fillSize : -row.fillSize;
    const currShares = Math.max(0, prevShares + signedSize);
    runningShares.set(shareKey, currShares);

    const timestampKey = [
      row.walletId,
      row.venue,
      row.marketId,
      row.outcomeSide ?? "",
      "trade",
      row.filledAt.toISOString(),
    ].join(":");
    const ordinal = timestampOrdinals.get(timestampKey) ?? 0;
    timestampOrdinals.set(timestampKey, ordinal + 1);

    events.push({
      walletId: row.walletId,
      venue: row.venue,
      marketId: row.marketId,
      outcomeSide: row.outcomeSide,
      action: side,
      deltaShares: row.fillSize,
      sizeUsd: Number((row.fillSize * row.fillPrice).toFixed(6)),
      price: row.fillPrice,
      occurredAt: isoTimestampWithMicroOffset(row.filledAt, ordinal),
      metadata: {
        source: "hunch_order_fill",
        tokenId: row.tokenId,
        orderId: row.orderId,
        orderFillId: row.orderFillId,
        venueFillId: row.venueFillId,
        venueTradeId: row.venueTradeId,
        prevShares: Number(prevShares.toFixed(12)),
        currShares: Number(currShares.toFixed(12)),
      },
    });
  }

  return events;
}
