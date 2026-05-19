import type { Pool } from "@hunch/infra";
import { env } from "../env.js";
import { withRewardsChainLocks } from "../lib/rewards-locks.js";
import { usdcMicroToDecimalString } from "../lib/usdc.js";
import { fetchActiveFeePolicy } from "../repos/fee-policy.js";
import { isRecord } from "../lib/type-guards.js";
import {
  limitlessRequest,
  extractLimitlessMessage,
} from "./limitless-client.js";
import {
  unlockVenueFeeAccruals,
  upsertVenueFeeAccruals,
  type VenueFeeAccrualInput,
} from "./venue-fee-accruals.js";

const BASE_CHAIN_ID = "8453";
const LIMITLESS_VENUE = "limitless";
const LIMITLESS_FEE_PROGRAM = "venue_share";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETTLED_STATUSES = new Set(["MINED", "CONFIRMED"]);
const FAILED_STATUSES = new Set(["FAILED"]);

type LimitlessFeeShareConfig = {
  active: boolean;
  shareBps: number;
};

type LimitlessOrderStatusItem = {
  orderId: string;
  payload: Record<string, unknown>;
};

type LimitlessAccrualOrderRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  signer_address: string | null;
  venue_order_id: string;
  order_hash: string | null;
  token_id: string | null;
  side: "BUY" | "SELL" | null;
  filled_at: Date | null;
  last_update: Date | null;
  posted_at: Date | null;
};

type LimitlessAccrualRow = {
  id: string;
  order_id: string;
  venue_order_id: string | null;
  fee_rate_bps: number;
};

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

function extractResults(payload: unknown): Record<string, unknown>[] {
  if (isRecord(payload) && Array.isArray(payload.results)) {
    return payload.results.filter(isRecord);
  }
  return [];
}

function extractStatusData(result: Record<string, unknown>): Record<string, unknown> | null {
  const data = isRecord(result.data) ? result.data : null;
  return data;
}

function extractOrderRecord(data: Record<string, unknown>): Record<string, unknown> | null {
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

function extractTotalsRaw(
  execution: Record<string, unknown>,
): Record<string, unknown> | null {
  return isRecord(execution.totalsRaw) ? execution.totalsRaw : null;
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

function settlementStatus(execution: Record<string, unknown>): string | null {
  const status = textOrNull(execution.settlementStatus);
  return status ? status.toUpperCase() : null;
}

function buildAccrualFromStatus(inputs: {
  order: LimitlessAccrualOrderRow;
  status: LimitlessOrderStatusItem;
  config: LimitlessFeeShareConfig;
}): VenueFeeAccrualInput | null {
  if (!inputs.config.active) return null;
  const data = extractStatusData(inputs.status.payload);
  if (!data) return null;
  const execution = extractExecutionRecord(data);
  if (!execution) return null;
  if (execution.matched !== true) return null;
  const status = settlementStatus(execution);
  if (!status || !SETTLED_STATUSES.has(status)) return null;
  const totals = extractTotalsRaw(execution);
  if (!totals) return null;

  const venueFeeRaw = rawDigits(totals.usdFee);
  const notionalRaw = deriveUsdGrossRaw(totals);
  if (venueFeeRaw == null || notionalRaw == null) return null;
  const feeRaw = floorBps(venueFeeRaw, inputs.config.shareBps);
  if (venueFeeRaw <= 0n || notionalRaw <= 0n || feeRaw <= 0n) return null;

  const orderRecord = extractOrderRecord(data);
  const side = normalizeSide(orderRecord?.side) ?? inputs.order.side;
  if (!side) return null;
  const venueOrderId =
    textOrNull(inputs.status.payload.orderId) ?? inputs.order.venue_order_id;
  const venueTradeId = textOrNull(execution.tradeEventId);
  const txHash = textOrNull(execution.txHash);
  const venueFillId = venueTradeId ?? txHash ?? venueOrderId;
  const tokenId = textOrNull(orderRecord?.tokenId) ?? inputs.order.token_id;
  const filledAt =
    inputs.order.filled_at ?? inputs.order.last_update ?? inputs.order.posted_at ?? new Date();
  const venueFeeRateBps = numberOrNull(execution.feeRateBps);
  const venueEffectiveFeeBps = numberOrNull(execution.effectiveFeeBps);

  return {
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
  };
}

export function getLimitlessFeeShareConfig(): LimitlessFeeShareConfig {
  const shareBps = clampShareBps(env.limitlessFeeShareBps);
  return { active: shareBps > 0, shareBps };
}

export async function resolveLimitlessFeeShareConfig(
  pool: Pool,
): Promise<LimitlessFeeShareConfig> {
  const policy = await fetchActiveFeePolicy(pool, "limitless");
  const shareBps = clampShareBps(
    policy?.limitless_fee_share_bps ?? env.limitlessFeeShareBps,
  );
  return { active: shareBps > 0, shareBps };
}

async function fetchLimitlessOrderStatusBatch(
  orderIds: string[],
): Promise<Map<string, LimitlessOrderStatusItem>> {
  if (!orderIds.length) return new Map();
  const upstream = await limitlessRequest({
    method: "POST",
    requestPath: "/orders/status/batch",
    auth: "partner_hmac",
    body: {
      items: orderIds.map((orderId) => ({ orderId })),
    },
  });
  if (!upstream.ok) {
    const message = extractLimitlessMessage(upstream.payload);
    throw new Error(
      message
        ? `Limitless order status batch failed (${upstream.status}): ${message}`
        : `Limitless order status batch failed (${upstream.status}).`,
    );
  }

  const out = new Map<string, LimitlessOrderStatusItem>();
  for (const result of extractResults(upstream.payload)) {
    if (result.status !== "found") continue;
    const orderId = textOrNull(result.orderId);
    if (!orderId) continue;
    out.set(orderId, { orderId, payload: result });
  }
  return out;
}

export async function backfillLimitlessVenueShareAccruals(
  pool: Pool,
  options: { limit?: number; minAgeSec?: number } = {},
): Promise<{ checked: number; upserted: number; skipped: number }> {
  const config = await resolveLimitlessFeeShareConfig(pool);
  if (!config.active) return { checked: 0, upserted: 0, skipped: 0 };
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 50));
  const minAgeSec = Math.max(0, Math.trunc(options.minAgeSec ?? 60));
  const { rows } = await pool.query<LimitlessAccrualOrderRow>(
    `
      select o.id, o.user_id, o.wallet_address, o.signer_address,
             o.venue_order_id, o.order_hash, o.token_id,
             case when o.side in ('BUY', 'SELL') then o.side else null end as side,
             o.filled_at, o.last_update, o.posted_at
      from orders o
      where o.venue = 'limitless'
        and o.venue_order_id ~* $1
        and lower(o.status) in ('filled', 'matched', 'mined', 'confirmed')
        and coalesce(o.filled_at, o.last_update, o.posted_at, now()) <= now() - ($3::int * interval '1 second')
        and not exists (
          select 1
          from venue_fee_accruals a
          where a.venue = 'limitless'
            and a.fee_program = 'venue_share'
            and a.order_id = o.id
        )
      order by coalesce(o.filled_at, o.last_update, o.posted_at) asc nulls last
      limit $2
    `,
    [UUID_RE.source, limit, minAgeSec],
  );
  if (!rows.length) return { checked: 0, upserted: 0, skipped: 0 };

  const statuses = await fetchLimitlessOrderStatusBatch(
    rows.map((row) => row.venue_order_id),
  );
  const accruals: Array<VenueFeeAccrualInput | null> = [];
  let skipped = 0;
  for (const row of rows) {
    const status = statuses.get(row.venue_order_id);
    if (!status) {
      skipped += 1;
      continue;
    }
    const accrual = buildAccrualFromStatus({ order: row, status, config });
    if (!accrual) skipped += 1;
    accruals.push(accrual);
  }
  const upsert = await upsertVenueFeeAccruals(pool, accruals);
  return { checked: rows.length, upserted: upsert.upserted, skipped };
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
  const accrual = buildAccrualFromStatus({
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
  return upsertVenueFeeAccruals(pool, [accrual]);
}

export async function verifyLimitlessVenueShareAccruals(
  pool: Pool,
  options: { limit?: number } = {},
): Promise<{ checked: number; verified: number; failed: number; skipped: number }> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 50));
  const { rows } = await pool.query<LimitlessAccrualRow>(
    `
      select id, order_id, venue_order_id, fee_rate_bps
      from venue_fee_accruals
      where venue = 'limitless'
        and fee_program = 'venue_share'
        and status = 'accrued'
        and venue_order_id is not null
        and venue_order_id ~* $1
      order by filled_at asc, created_at asc
      limit $2
    `,
    [UUID_RE.source, limit],
  );
  if (!rows.length) return { checked: 0, verified: 0, failed: 0, skipped: 0 };

  const statuses = await fetchLimitlessOrderStatusBatch(
    rows
      .map((row) => row.venue_order_id)
      .filter((orderId): orderId is string => Boolean(orderId)),
  );

  let checked = 0;
  let verified = 0;
  let failed = 0;
  let skipped = 0;
  for (const row of rows) {
    checked += 1;
    const orderId = row.venue_order_id;
    const status = orderId ? statuses.get(orderId) : null;
    const data = status ? extractStatusData(status.payload) : null;
    const execution = data ? extractExecutionRecord(data) : null;
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
              verification_error = 'Limitless fee totals missing or zero',
              updated_at = now()
          where id = $1
        `,
        [row.id],
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
}> {
  return withRewardsChainLocks(pool, [BASE_CHAIN_ID], async () => {
    const backfill = await backfillLimitlessVenueShareAccruals(pool, {
      limit: options.limit,
      minAgeSec: options.minAgeSec,
    });
    const verify = await verifyLimitlessVenueShareAccruals(pool, {
      limit: options.limit,
    });
    const unlock = await unlockVenueFeeAccruals(pool, {
      chainId: BASE_CHAIN_ID,
      venue: LIMITLESS_VENUE,
      feeProgram: LIMITLESS_FEE_PROGRAM,
      limit: options.limit,
      dryRun: options.dryRun,
      assumeRewardsChainLock: true,
    });
    return { backfill, verify, unlock };
  });
}
