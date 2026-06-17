import { randomBytes } from "node:crypto";
import type { Pool } from "@hunch/infra";
import type { DbQuery } from "../db.js";
import {
  countReferralsForReferralCode,
  fetchUserReferralCode,
  findActiveReferralCodeForAttach,
} from "../repos/rewards.js";
import {
  fetchPositionShareSourceById,
  fetchShareSnapshot,
  fetchTopPositionShareSource,
  insertShareSnapshot,
  type PositionShareSourceRow,
  type ShareKind,
} from "../repos/shares.js";
import {
  fetchPositionPnlSummaryForResolvedScope,
  resolvePositionPnlScope,
} from "../repos/positions-repo.js";
import { normalizeReferralCode } from "./rewards.js";

const SHARE_ID_RANDOM_BYTES = 17;
const SHARE_ID_BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export class ShareSnapshotError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

type PublicImageRef = {
  url: string | null;
  fallbackKey: string;
};

type PublicPositionSnapshot = {
  positionId: string;
  positionStatus?: "open" | "closed";
  venue: string;
  eventId: string | null;
  marketId: string | null;
  eventTitle: string | null;
  marketTitle: string | null;
  outcome: "YES" | "NO" | null;
  side?: string;
  size: string;
  entryPrice: string | null;
  exitPrice?: null;
  currentPrice: string | null;
  realizedPnlCents: number;
  unrealizedPnlCents: number;
  totalPnlCents: number;
  pnlPercentBasisPoints: number | null;
  openedAt?: string;
  closedAt?: string | null;
  image: PublicImageRef;
};

type PortfolioPnlSnapshot = {
  asOf: string;
  referralCode: string | null;
  realizedPnlCents: number;
  unrealizedPnlCents: number;
  totalPnlCents: number;
  unrealizedPnlPercentBasisPoints: number | null;
  topPosition: PublicPositionSnapshot | null;
};

type TradePnlSnapshot = {
  source: "position";
  asOf: string;
  referralCode: string | null;
} & PublicPositionSnapshot;

type PublicShareResponse = {
  id: string;
  kind: ShareKind;
  createdAt: string;
} & Record<string, unknown>;

function randomBase62(length: number): string {
  let value = "";
  while (value.length < length) {
    for (const byte of randomBytes(SHARE_ID_RANDOM_BYTES)) {
      if (value.length >= length) break;
      const max = Math.floor(256 / SHARE_ID_BASE62.length) * SHARE_ID_BASE62.length;
      if (byte >= max) continue;
      value += SHARE_ID_BASE62[byte % SHARE_ID_BASE62.length];
    }
  }
  return value;
}

function generateShareId(kind: ShareKind): string {
  return `${kind === "portfolio_pnl" ? "pnl" : "trade"}_${randomBase62(22)}`;
}

function parseNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usdToCents(value: number): number {
  return Math.round(value * 100);
}

function percentToBasisPoints(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function ratioToBasisPoints(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 10_000);
}

function positionPnlPercentBasisPoints(inputs: {
  totalPnl: number;
  realizedPnl: number;
  costBasis: number | null;
}): number | null {
  if (inputs.costBasis == null) return null;
  if (Math.abs(inputs.realizedPnl) > 1e-9) return null;
  return ratioToBasisPoints(inputs.totalPnl, inputs.costBasis);
}

function normalizeOutcome(value: string | null | undefined): "YES" | "NO" | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === "YES" || normalized === "NO" ? normalized : null;
}

function decimalString(value: number | null, maxFractionDigits = 6): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  const fixed = value.toFixed(maxFractionDigits);
  return fixed.replace(/\.?0+$/, "");
}

function dbDecimalString(value: string | null): string | null {
  if (value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return decimalString(parsed, 8);
}

function midpoint(bid: number | null, ask: number | null): number | null {
  if (bid != null && ask != null && ask >= bid) return (bid + ask) / 2;
  return bid ?? ask ?? null;
}

function resolveCurrentPrice(row: PositionShareSourceRow): number | null {
  const outcome = normalizeOutcome(row.outcome_side);
  const resolvedOutcome = normalizeOutcome(row.resolved_outcome);
  if (outcome && resolvedOutcome) return outcome === resolvedOutcome ? 1 : 0;

  const pctBps = parseOptionalNumber(row.resolved_outcome_pct);
  if (outcome && pctBps != null) {
    const yesPayout = Math.min(Math.max(pctBps / 10_000, 0), 1);
    return outcome === "YES" ? yesPayout : 1 - yesPayout;
  }

  if (outcome === "YES") {
    return (
      midpoint(
        parseOptionalNumber(row.best_bid_yes),
        parseOptionalNumber(row.best_ask_yes),
      ) ?? parseOptionalNumber(row.last_price)
    );
  }
  if (outcome === "NO") {
    const noMid = midpoint(
      parseOptionalNumber(row.best_bid_no),
      parseOptionalNumber(row.best_ask_no),
    );
    if (noMid != null) return noMid;
    const lastPrice = parseOptionalNumber(row.last_price);
    return lastPrice == null ? null : 1 - lastPrice;
  }
  return parseOptionalNumber(row.last_price);
}

function publicImageRef(row: PositionShareSourceRow): PublicImageRef {
  const marketOrToken = row.market_id ?? row.token_id;
  return {
    url: row.event_image ?? row.market_image ?? null,
    fallbackKey: `${row.venue}:${marketOrToken}`,
  };
}

function buildPublicPositionSnapshot(
  row: PositionShareSourceRow,
  options: { includeTradeFields: boolean },
): PublicPositionSnapshot {
  const size = parseNumber(row.size);
  const averagePrice = parseOptionalNumber(row.average_price);
  const realizedPnl = parseNumber(row.realized_pnl);
  const unrealizedPnl = parseNumber(row.unrealized_pnl_effective);
  const totalPnl = realizedPnl + unrealizedPnl;
  const costBasis =
    averagePrice != null && size > 0 ? averagePrice * size : null;
  const positionStatus =
    row.side !== "FLAT" && size > 0 ? ("open" as const) : ("closed" as const);
  const currentPrice = resolveCurrentPrice(row);

  return {
    positionId: row.position_id,
    ...(options.includeTradeFields ? { positionStatus } : {}),
    venue: row.venue,
    eventId: row.event_id,
    marketId: row.market_id,
    eventTitle: row.event_title,
    marketTitle: row.market_title,
    outcome: normalizeOutcome(row.outcome_side),
    ...(options.includeTradeFields ? { side: row.side } : {}),
    size: dbDecimalString(row.size) ?? "0",
    entryPrice: dbDecimalString(row.average_price),
    ...(options.includeTradeFields ? { exitPrice: null } : {}),
    currentPrice: decimalString(currentPrice, 6),
    realizedPnlCents: usdToCents(realizedPnl),
    unrealizedPnlCents: usdToCents(unrealizedPnl),
    totalPnlCents: usdToCents(totalPnl),
    pnlPercentBasisPoints: positionPnlPercentBasisPoints({
      totalPnl,
      realizedPnl,
      costBasis,
    }),
    ...(options.includeTradeFields
      ? {
          openedAt: row.created_at.toISOString(),
          closedAt:
            positionStatus === "closed" ? row.updated_at.toISOString() : null,
        }
      : {}),
    image: publicImageRef(row),
  };
}

async function resolveShareReferralCode(
  pool: DbQuery,
  inputs: { userId: string; referralCode?: string | null },
): Promise<string | null> {
  const supplied = inputs.referralCode !== undefined;
  const rawCode =
    supplied
      ? inputs.referralCode
      : await fetchUserReferralCode(pool, inputs.userId);
  if (rawCode == null || rawCode.trim() === "") return null;

  const normalized = normalizeReferralCode(rawCode);
  if (!normalized) {
    if (!supplied) return null;
    throw new ShareSnapshotError(400, "Invalid referral code");
  }

  const active = await findActiveReferralCodeForAttach(pool, normalized);
  if (!active) {
    if (!supplied) return null;
    throw new ShareSnapshotError(400, "Invalid referral code");
  }
  const maxUses = active.max_uses == null ? null : Number(active.max_uses);
  if (maxUses != null) {
    const currentUses = await countReferralsForReferralCode(
      pool,
      active.referral_code_id,
    );
    if (currentUses >= maxUses) {
      if (!supplied) return null;
      throw new ShareSnapshotError(400, "Invalid referral code");
    }
  }
  return active.code;
}

async function insertGeneratedShare(
  pool: DbQuery,
  inputs: {
    kind: ShareKind;
    userId: string;
    referralCode: string | null;
    snapshot: PortfolioPnlSnapshot | TradePnlSnapshot;
  },
): Promise<PublicShareResponse> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = generateShareId(inputs.kind);
    try {
      const row = await insertShareSnapshot(pool, {
        id,
        kind: inputs.kind,
        userId: inputs.userId,
        referralCode: inputs.referralCode,
        snapshot: inputs.snapshot,
      });
      return mapShareSnapshotRow(row);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : null;
      if (code !== "23505" || attempt === 3) throw error;
    }
  }
  throw new Error("Failed to create share snapshot");
}

function mapShareSnapshotRow(row: {
  id: string;
  kind: ShareKind;
  created_at: Date;
  snapshot: unknown;
}): PublicShareResponse {
  const snapshot =
    row.snapshot && typeof row.snapshot === "object" ? row.snapshot : {};
  return {
    ...(snapshot as Record<string, unknown>),
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createPortfolioPnlShare(
  pool: Pool,
  inputs: {
    userId: string;
    walletAddresses: string[];
    referralCode?: string | null;
    venue?: string;
    venues?: string[];
    topPositionId?: string | null;
  },
): Promise<PublicShareResponse> {
  if (inputs.walletAddresses.length === 0) {
    throw new ShareSnapshotError(400, "No wallets available to query.");
  }

  const [referralCode, pnlScope] = await Promise.all([
    resolveShareReferralCode(pool, {
      userId: inputs.userId,
      referralCode: inputs.referralCode,
    }),
    resolvePositionPnlScope(pool, {
      userId: inputs.userId,
      walletAddresses: inputs.walletAddresses,
      venue: inputs.venue,
      venues: inputs.venues,
    }),
  ]);

  const [summary, topPositionRow] = await Promise.all([
    fetchPositionPnlSummaryForResolvedScope(pool, {
      userId: inputs.userId,
      walletAddresses: pnlScope.walletAddresses,
      venueList: pnlScope.venueList,
    }),
    inputs.topPositionId
      ? fetchPositionShareSourceById(pool, {
          userId: inputs.userId,
          positionId: inputs.topPositionId,
          walletAddresses: pnlScope.walletAddresses,
          venues: pnlScope.venueList,
        })
      : fetchTopPositionShareSource(pool, {
          userId: inputs.userId,
          walletAddresses: pnlScope.walletAddresses,
          venues: pnlScope.venueList,
        }),
  ]);

  if (inputs.topPositionId && !topPositionRow) {
    throw new ShareSnapshotError(404, "Position not found");
  }

  const snapshot: PortfolioPnlSnapshot = {
    asOf: new Date().toISOString(),
    referralCode,
    realizedPnlCents: usdToCents(summary.realizedPnlAllTime),
    unrealizedPnlCents: usdToCents(summary.unrealizedPnlCurrent),
    totalPnlCents: usdToCents(
      summary.realizedPnlAllTime + summary.unrealizedPnlCurrent,
    ),
    unrealizedPnlPercentBasisPoints: percentToBasisPoints(
      summary.unrealizedPnlPercentCurrent,
    ),
    topPosition: topPositionRow
      ? buildPublicPositionSnapshot(topPositionRow, {
          includeTradeFields: false,
        })
      : null,
  };

  return insertGeneratedShare(pool, {
    kind: "portfolio_pnl",
    userId: inputs.userId,
    referralCode,
    snapshot,
  });
}

export async function createTradePnlShare(
  pool: Pool,
  inputs: {
    userId: string;
    positionId: string;
    referralCode?: string | null;
  },
): Promise<PublicShareResponse> {
  const [referralCode, positionRow] = await Promise.all([
    resolveShareReferralCode(pool, {
      userId: inputs.userId,
      referralCode: inputs.referralCode,
    }),
    fetchPositionShareSourceById(pool, {
      userId: inputs.userId,
      positionId: inputs.positionId,
    }),
  ]);
  if (!positionRow) {
    throw new ShareSnapshotError(404, "Position not found");
  }

  const snapshot: TradePnlSnapshot = {
    source: "position",
    asOf: new Date().toISOString(),
    referralCode,
    ...buildPublicPositionSnapshot(positionRow, {
      includeTradeFields: true,
    }),
  };

  return insertGeneratedShare(pool, {
    kind: "trade_pnl",
    userId: inputs.userId,
    referralCode,
    snapshot,
  });
}

export async function getPublicShareSnapshot(
  pool: DbQuery,
  inputs: { id: string; kind?: ShareKind },
): Promise<PublicShareResponse | null> {
  const row = await fetchShareSnapshot(pool, inputs);
  return row ? mapShareSnapshotRow(row) : null;
}
