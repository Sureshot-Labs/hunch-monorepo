import { ethers } from "ethers";
import type { Pool } from "@hunch/infra";
import { env } from "../env.js";
import { usdcMicroToDecimalString } from "../lib/usdc.js";
import { withRewardsChainLocks } from "../lib/rewards-locks.js";
import { fetchActiveFeePolicy } from "../repos/fee-policy.js";
import {
  unlockVenueFeeAccruals,
  upsertVenueFeeAccruals,
  type VenueFeeAccrualInput,
} from "./venue-fee-accruals.js";

const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const POLYGON_CHAIN_ID = "137";
const POLYMARKET_VENUE = "polymarket";
const POLYMARKET_BUILDER_FEE_PROGRAM = "builder";
const MAX_TAKER_BUILDER_FEE_BPS = 100;
const MAX_MAKER_BUILDER_FEE_BPS = 50;
const DECIMAL_SCALE = 1_000_000_000_000n;
const DECIMAL_SCALE_DIGITS = 12;
const USDC_SCALE = 1_000_000n;
const BUILDER_RATE_CACHE_TTL_MS = 60_000;
const BUILDER_RATE_FETCH_TIMEOUT_MS = 2_500;
const ORDER_FILLED_EVENT =
  "event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint8 side, uint256 tokenId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee, bytes32 builder, bytes32 metadata)";
const orderFilledInterface = new ethers.Interface([ORDER_FILLED_EVENT]);

export type PolymarketFeeCollectionMode = "none" | "fee_auth" | "builder";
export type PolymarketBuilderRateSource =
  | "polymarket"
  | "fallback"
  | "disabled"
  | "none";

export type PolymarketBuilderFeeConfig = {
  active: boolean;
  builderCode: string;
  takerFeeBps: number;
  makerFeeBps: number;
  rateSource?: PolymarketBuilderRateSource;
  builderEnabled?: boolean;
};

export type PolymarketFeePolicySnapshot = {
  venue: "polymarket";
  collectionMode: PolymarketFeeCollectionMode;
  builderCode: string;
  builderTakerFeeBps: number;
  builderMakerFeeBps: number;
  builderRateSource: PolymarketBuilderRateSource;
  builderEnabled: boolean;
  legacyFeeBps: number;
  feePolicyId: string | null;
  capturedAt: string;
};

export type PolymarketBuilderFeeAccrualInput = {
  userId: string;
  walletAddress: string | null;
  signerAddress: string | null;
  orderId: string;
  orderHash: string;
  venueOrderId: string | null;
  venueFillId: string;
  venueTradeId: string | null;
  txHash: string | null;
  tokenId: string | null;
  side: "BUY" | "SELL";
  role: "maker" | "taker";
  size: string | number | null;
  price: string | number | null;
  filledAt: Date;
  orderBuilderCode: string | null;
  feePolicySnapshot: unknown | null;
};

function clampBps(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

function normalizeBytes32(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return ZERO_BYTES32;
  return trimmed.toLowerCase();
}

function normalizeAddress(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    return ethers.getAddress(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
}

function normalizeHash(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function decimalToScaled(value: string | number | null | undefined): bigint | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const fractionPadded = fraction
    .slice(0, DECIMAL_SCALE_DIGITS)
    .padEnd(DECIMAL_SCALE_DIGITS, "0");
  return BigInt(whole || "0") * DECIMAL_SCALE + BigInt(fractionPadded || "0");
}

function multiplyDecimalToMicroFloor(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
): bigint {
  const leftScaled = decimalToScaled(left);
  const rightScaled = decimalToScaled(right);
  if (leftScaled == null || rightScaled == null) return 0n;
  return (leftScaled * rightScaled * USDC_SCALE) / (DECIMAL_SCALE * DECIMAL_SCALE);
}

export function calculatePolymarketBuilderFeeRaw(
  rawMicro: bigint,
  bps: number,
): bigint {
  if (rawMicro <= 0n || bps <= 0) return 0n;
  const raw = (rawMicro * BigInt(Math.trunc(bps))) / 10_000n;
  return raw - (raw % 10n);
}

function microToDecimal(rawMicro: bigint): string {
  return usdcMicroToDecimalString(rawMicro);
}

function buildPolymarketBuilderFeeConfig(inputs: {
  builderCode: string | null | undefined;
  takerFeeBps: number | null | undefined;
  makerFeeBps: number | null | undefined;
}): PolymarketBuilderFeeConfig {
  const builderCode = normalizeBytes32(inputs.builderCode);
  const takerFeeBps = clampBps(
    inputs.takerFeeBps ?? 0,
    MAX_TAKER_BUILDER_FEE_BPS,
  );
  const makerFeeBps = clampBps(
    inputs.makerFeeBps ?? 0,
    MAX_MAKER_BUILDER_FEE_BPS,
  );
  const active = builderCode !== ZERO_BYTES32;
  return {
    active,
    builderCode: active ? builderCode : ZERO_BYTES32,
    takerFeeBps: active ? takerFeeBps : 0,
    makerFeeBps: active ? makerFeeBps : 0,
    rateSource: active ? "fallback" : "none",
    builderEnabled: active,
  };
}

function resolveBuilderCodeWithEnvFallback(
  policyBuilderCode: string | null | undefined,
): string {
  const policyCode = normalizeBytes32(policyBuilderCode);
  if (policyCode !== ZERO_BYTES32) return policyCode;
  return normalizeBytes32(env.polymarketBuilderCode);
}

function buildPolymarketBuilderFeeConfigFromSnapshot(
  snapshot: PolymarketFeePolicySnapshot | null,
): PolymarketBuilderFeeConfig | null {
  if (!snapshot) return null;
  if (snapshot.collectionMode !== "builder") {
    return {
      active: false,
      builderCode: ZERO_BYTES32,
      takerFeeBps: 0,
      makerFeeBps: 0,
      rateSource: snapshot.builderRateSource,
      builderEnabled: snapshot.builderEnabled,
    };
  }
  return {
    active: true,
    builderCode: normalizeBytes32(snapshot.builderCode),
    takerFeeBps: clampBps(
      snapshot.builderTakerFeeBps,
      MAX_TAKER_BUILDER_FEE_BPS,
    ),
    makerFeeBps: clampBps(
      snapshot.builderMakerFeeBps,
      MAX_MAKER_BUILDER_FEE_BPS,
    ),
    rateSource: snapshot.builderRateSource,
    builderEnabled: snapshot.builderEnabled,
  };
}

type CachedBuilderRates = {
  expiresAt: number;
  result:
    | {
        kind: "ok";
        makerFeeBps: number;
        takerFeeBps: number;
      }
    | { kind: "disabled" }
    | { kind: "error"; error: string };
};

const builderRateCache = new Map<string, CachedBuilderRates>();

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function readFiniteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchLivePolymarketBuilderRates(
  builderCode: string,
): Promise<CachedBuilderRates["result"]> {
  const normalizedBuilderCode = normalizeBytes32(builderCode);
  if (normalizedBuilderCode === ZERO_BYTES32) {
    return { kind: "disabled" };
  }

  const now = Date.now();
  const cached = builderRateCache.get(normalizedBuilderCode);
  if (cached && cached.expiresAt > now) return cached.result;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    BUILDER_RATE_FETCH_TIMEOUT_MS,
  );

  let result: CachedBuilderRates["result"];
  try {
    const res = await fetch(
      `${normalizeBaseUrl(env.polymarketClobBase)}/fees/builder-fees/${normalizedBuilderCode}`,
      {
        headers: {
          accept: "application/json",
          "user-agent": "Hunch-API/1.0",
        },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      result = { kind: "error", error: `HTTP ${res.status}` };
    } else {
      const json = (await res.json()) as unknown;
      if (!isRecord(json)) {
        result = { kind: "error", error: "invalid response" };
      } else if (json.enabled === false) {
        result = { kind: "disabled" };
      } else {
        const maker = readFiniteNumber(json.builder_maker_fee_rate_bps);
        const taker = readFiniteNumber(json.builder_taker_fee_rate_bps);
        if (maker == null || taker == null) {
          result = { kind: "error", error: "missing builder fee rates" };
        } else {
          result = {
            kind: "ok",
            makerFeeBps: clampBps(maker, MAX_MAKER_BUILDER_FEE_BPS),
            takerFeeBps: clampBps(taker, MAX_TAKER_BUILDER_FEE_BPS),
          };
        }
      }
    }
  } catch (error) {
    result = {
      kind: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }

  builderRateCache.set(normalizedBuilderCode, {
    expiresAt: now + BUILDER_RATE_CACHE_TTL_MS,
    result,
  });
  return result;
}

export function clearPolymarketBuilderRateCacheForTests(): void {
  builderRateCache.clear();
}

export function getPolymarketBuilderFeeConfig(): PolymarketBuilderFeeConfig {
  return buildPolymarketBuilderFeeConfig({
    builderCode: env.polymarketBuilderCode,
    takerFeeBps: env.polymarketBuilderTakerFeeBps,
    makerFeeBps: env.polymarketBuilderMakerFeeBps,
  });
}

export async function resolvePolymarketBuilderFeeConfig(
  pool: Pool,
): Promise<PolymarketBuilderFeeConfig> {
  const snapshot = await resolvePolymarketFeePolicySnapshot(pool);
  return (
    buildPolymarketBuilderFeeConfigFromSnapshot(snapshot) ??
    buildPolymarketBuilderFeeConfig({
      builderCode: null,
      takerFeeBps: 0,
      makerFeeBps: 0,
    })
  );
}

async function resolveLocalPolymarketBuilderFeeConfig(pool: Pool): Promise<{
  config: PolymarketBuilderFeeConfig;
  feePolicyId: string | null;
  legacyFeeBps: number;
}> {
  const policy = await fetchActiveFeePolicy(pool, "polymarket");
  const config = buildPolymarketBuilderFeeConfig({
    builderCode: resolveBuilderCodeWithEnvFallback(
      policy?.polymarket_builder_code,
    ),
    takerFeeBps:
      policy?.polymarket_builder_taker_fee_bps ??
      env.polymarketBuilderTakerFeeBps,
    makerFeeBps:
      policy?.polymarket_builder_maker_fee_bps ??
      env.polymarketBuilderMakerFeeBps,
  });
  return {
    config,
    feePolicyId: policy?.id ?? null,
    legacyFeeBps: clampBps(policy?.fee_bps ?? env.feeBpsPolymarket, 10_000),
  };
}

export function getPolymarketFeeCollectionMode(): PolymarketFeeCollectionMode {
  if (getPolymarketBuilderFeeConfig().active) return "builder";
  return "none";
}

export async function resolvePolymarketFeeCollectionMode(
  pool: Pool,
): Promise<PolymarketFeeCollectionMode> {
  if ((await resolvePolymarketBuilderFeeConfig(pool)).active) return "builder";
  return "none";
}

export async function resolvePolymarketFeePolicySnapshot(
  pool: Pool,
): Promise<PolymarketFeePolicySnapshot> {
  const { config: localBuilderConfig, feePolicyId, legacyFeeBps } =
    await resolveLocalPolymarketBuilderFeeConfig(pool);
  let builderConfig: PolymarketBuilderFeeConfig = localBuilderConfig;
  if (localBuilderConfig.active) {
    const live = await fetchLivePolymarketBuilderRates(
      localBuilderConfig.builderCode,
    );
    if (live.kind === "ok") {
      builderConfig = {
        active: true,
        builderCode: localBuilderConfig.builderCode,
        makerFeeBps: live.makerFeeBps,
        takerFeeBps: live.takerFeeBps,
        rateSource: "polymarket",
        builderEnabled: true,
      };
    } else if (live.kind === "disabled") {
      builderConfig = {
        active: false,
        builderCode: ZERO_BYTES32,
        makerFeeBps: 0,
        takerFeeBps: 0,
        rateSource: "disabled",
        builderEnabled: false,
      };
    } else if (
      localBuilderConfig.makerFeeBps <= 0 &&
      localBuilderConfig.takerFeeBps <= 0
    ) {
      builderConfig = {
        active: false,
        builderCode: ZERO_BYTES32,
        makerFeeBps: 0,
        takerFeeBps: 0,
        rateSource: "fallback",
        builderEnabled: false,
      };
    } else {
      builderConfig = {
        ...localBuilderConfig,
        rateSource: "fallback",
        builderEnabled: true,
      };
    }
  }
  const collectionMode: PolymarketFeeCollectionMode = builderConfig.active
    ? "builder"
    : "none";

  return {
    venue: "polymarket",
    collectionMode,
    builderCode: builderConfig.builderCode,
    builderTakerFeeBps: builderConfig.takerFeeBps,
    builderMakerFeeBps: builderConfig.makerFeeBps,
    builderRateSource: builderConfig.rateSource ?? "none",
    builderEnabled: builderConfig.builderEnabled === true,
    legacyFeeBps,
    feePolicyId,
    capturedAt: new Date().toISOString(),
  };
}

export function normalizePolymarketFeePolicySnapshot(
  value: unknown,
): PolymarketFeePolicySnapshot | null {
  if (!isRecord(value)) return null;
  if (value.venue !== "polymarket") return null;
  const collectionMode = value.collectionMode;
  if (
    collectionMode !== "none" &&
    collectionMode !== "fee_auth" &&
    collectionMode !== "builder"
  ) {
    return null;
  }
  return {
    venue: "polymarket",
    collectionMode,
    builderCode: normalizeBytes32(
      typeof value.builderCode === "string" ? value.builderCode : null,
    ),
    builderTakerFeeBps: clampBps(
      Number(value.builderTakerFeeBps ?? 0),
      MAX_TAKER_BUILDER_FEE_BPS,
    ),
    builderMakerFeeBps: clampBps(
      Number(value.builderMakerFeeBps ?? 0),
      MAX_MAKER_BUILDER_FEE_BPS,
    ),
    builderRateSource:
      value.builderRateSource === "polymarket" ||
      value.builderRateSource === "fallback" ||
      value.builderRateSource === "disabled" ||
      value.builderRateSource === "none"
        ? value.builderRateSource
        : collectionMode === "builder"
          ? "fallback"
          : "none",
    builderEnabled:
      typeof value.builderEnabled === "boolean"
        ? value.builderEnabled
        : collectionMode === "builder",
    legacyFeeBps: clampBps(Number(value.legacyFeeBps ?? 0), 10_000),
    feePolicyId: typeof value.feePolicyId === "string" ? value.feePolicyId : null,
    capturedAt:
      typeof value.capturedAt === "string"
        ? value.capturedAt
        : new Date(0).toISOString(),
  };
}

export function getExpectedPolymarketBuilderCode(): string {
  return getPolymarketBuilderFeeConfig().builderCode;
}

export function validatePolymarketOrderBuilderCodeForConfig(
  builder: string | null | undefined,
  config: PolymarketBuilderFeeConfig,
): { ok: true } | { ok: false; error: string } {
  const expected = config.builderCode;
  const actual = normalizeBytes32(builder);
  if (actual === expected) return { ok: true };
  if (expected === ZERO_BYTES32) {
    return {
      ok: false,
      error: "Order builder code must be zero when Polymarket builder fees are disabled",
    };
  }
  return {
    ok: false,
    error: "Order builder code does not match the configured Polymarket builder policy",
  };
}

export function validatePolymarketOrderBuilderCode(
  builder: string | null | undefined,
): { ok: true } | { ok: false; error: string } {
  return validatePolymarketOrderBuilderCodeForConfig(
    builder,
    getPolymarketBuilderFeeConfig(),
  );
}

export function isHunchPolymarketBuilderCode(
  value: string | null | undefined,
  config: PolymarketBuilderFeeConfig = getPolymarketBuilderFeeConfig(),
): boolean {
  return config.active && normalizeBytes32(value) === config.builderCode;
}

export function buildPolymarketBuilderFeeAccrual(
  input: PolymarketBuilderFeeAccrualInput,
  fallbackConfig: PolymarketBuilderFeeConfig = getPolymarketBuilderFeeConfig(),
): VenueFeeAccrualInput | null {
  const snapshot = normalizePolymarketFeePolicySnapshot(input.feePolicySnapshot);
  if (snapshot && snapshot.collectionMode !== "builder") return null;
  const snapshotConfig = buildPolymarketBuilderFeeConfigFromSnapshot(snapshot);
  const config = snapshotConfig ?? fallbackConfig;
  const orderBuilderCode = normalizeBytes32(input.orderBuilderCode);
  if (!config.active || orderBuilderCode !== config.builderCode) return null;

  const feeRateBps =
    input.role === "maker" ? config.makerFeeBps : config.takerFeeBps;
  if (feeRateBps <= 0) return null;

  const notionalRaw = multiplyDecimalToMicroFloor(input.size, input.price);
  const feeRaw = calculatePolymarketBuilderFeeRaw(notionalRaw, feeRateBps);
  const orderHash = normalizeHash(input.orderHash);
  if (notionalRaw <= 0n || feeRaw <= 0n || !orderHash) return null;

  return {
    userId: input.userId,
    walletAddress: input.walletAddress,
    signerAddress: input.signerAddress,
    venue: POLYMARKET_VENUE,
    feeProgram: POLYMARKET_BUILDER_FEE_PROGRAM,
    chainId: POLYGON_CHAIN_ID,
    orderId: input.orderId,
    orderHash,
    venueOrderId: input.venueOrderId,
    venueFillId: input.venueFillId,
    venueTradeId: input.venueTradeId,
    txHash: normalizeHash(input.txHash) || null,
    tokenId: input.tokenId,
    side: input.side,
    role: input.role,
    attributionCode: config.builderCode,
    feeRateBps,
    feeBasis: "notional",
    notionalAmountRaw: notionalRaw.toString(),
    notionalAmount: microToDecimal(notionalRaw),
    feeAmountRaw: feeRaw.toString(),
    feeAmount: microToDecimal(feeRaw),
    feeAsset: "pUSD",
    filledAt: input.filledAt,
  };
}

export async function upsertPolymarketBuilderFeeAccruals(
  pool: Pool,
  inputs: Array<ReturnType<typeof buildPolymarketBuilderFeeAccrual>>,
): Promise<{ upserted: number }> {
  return upsertVenueFeeAccruals(pool, inputs);
}

type BuilderFeeAccrualRow = {
  id: string;
  user_id: string;
  wallet_address: string | null;
  venue: string;
  fee_program: string;
  chain_id: string | null;
  order_hash: string;
  venue_fill_id: string;
  venue_trade_id: string | null;
  tx_hash: string | null;
  token_id: string | null;
  side: "BUY" | "SELL";
  attribution_code: string | null;
  fee_rate_bps: number;
  fee_amount: string;
  fee_amount_raw: string;
  fee_asset: string;
  filled_at: Date;
};

function parseOrderFilledLog(log: ethers.Log): null | {
  orderHash: string;
  tokenId: string;
  builder: string;
  side: "BUY" | "SELL" | null;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
  fee: bigint;
  logIndex: number;
} {
  try {
    const parsed = orderFilledInterface.parseLog(log);
    if (!parsed || parsed.name !== "OrderFilled") return null;
    const sideRaw = Number(parsed.args.side);
    return {
      orderHash: normalizeHash(parsed.args.orderHash as string),
      tokenId: (parsed.args.tokenId as bigint).toString(),
      builder: normalizeBytes32(parsed.args.builder as string),
      side: sideRaw === 0 ? "BUY" : sideRaw === 1 ? "SELL" : null,
      makerAmountFilled: parsed.args.makerAmountFilled as bigint,
      takerAmountFilled: parsed.args.takerAmountFilled as bigint,
      fee: parsed.args.fee as bigint,
      logIndex: log.index,
    };
  } catch {
    return null;
  }
}

function verifiedPolymarketNotionalRaw(
  side: "BUY" | "SELL",
  log: NonNullable<ReturnType<typeof parseOrderFilledLog>>,
): bigint {
  return side === "BUY" ? log.makerAmountFilled : log.takerAmountFilled;
}

export async function verifyPolymarketBuilderFeeAccruals(
  pool: Pool,
  options: { limit?: number } = {},
): Promise<{ checked: number; verified: number; failed: number; skipped: number }> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 25), 250));
  const { rows } = await pool.query<BuilderFeeAccrualRow>(
    `
      select id, user_id, wallet_address, venue, fee_program, chain_id,
             order_hash, venue_fill_id, venue_trade_id, tx_hash, token_id, side,
             attribution_code, fee_rate_bps, fee_amount, fee_amount_raw, fee_asset,
             filled_at
      from venue_fee_accruals
      where venue = 'polymarket'
        and fee_program = 'builder'
        and status = 'accrued'
        and tx_hash is not null
      order by filled_at asc, created_at asc
      limit $1
    `,
    [limit],
  );
  if (!rows.length) {
    return { checked: 0, verified: 0, failed: 0, skipped: 0 };
  }

  const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl, undefined, {
    staticNetwork: true,
  });
  let checked = 0;
  let verified = 0;
  let failed = 0;
  let skipped = 0;
  const exchangeAddresses = new Set(
    [env.polymarketExchangeAddress, env.polymarketNegRiskExchangeAddress]
      .map((address) => normalizeAddress(address).toLowerCase())
      .filter(Boolean),
  );

  for (const row of rows) {
    checked += 1;
    try {
      const txHash = normalizeHash(row.tx_hash);
      if (!txHash) {
        skipped += 1;
        continue;
      }
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) {
        skipped += 1;
        continue;
      }
      if (receipt.status === 0) {
        failed += 1;
        await pool.query(
          `
            update venue_fee_accruals
            set status = 'failed',
                verification_error = 'transaction reverted',
                updated_at = now()
            where id = $1
          `,
          [row.id],
        );
        continue;
      }

      const matching = receipt.logs
        .filter((log) => exchangeAddresses.has(normalizeAddress(log.address).toLowerCase()))
        .map(parseOrderFilledLog)
        .find(
          (log) =>
            log &&
            log.orderHash === normalizeHash(row.order_hash) &&
            log.builder === normalizeBytes32(row.attribution_code) &&
            log.side === row.side &&
            (!row.token_id || log.tokenId === row.token_id),
        );

      if (!matching) {
        failed += 1;
        await pool.query(
          `
            update venue_fee_accruals
            set status = 'failed',
                verification_error = 'matching OrderFilled event not found',
                updated_at = now()
            where id = $1
          `,
          [row.id],
        );
        continue;
      }

      const notionalRaw = verifiedPolymarketNotionalRaw(row.side, matching);
      const calculatedFeeRaw = calculatePolymarketBuilderFeeRaw(
        notionalRaw,
        Number(row.fee_rate_bps),
      );
      const feeRaw =
        matching.fee > 0n && matching.fee < calculatedFeeRaw
          ? matching.fee
          : calculatedFeeRaw;
      if (notionalRaw <= 0n || feeRaw <= 0n) {
        failed += 1;
        await pool.query(
          `
            update venue_fee_accruals
            set status = 'failed',
                verification_error = 'verified notional or fee is zero',
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
              log_index = $2,
              notional_amount_raw = $3,
              notional_amount = $4,
              fee_amount_raw = $5,
              fee_amount = $6,
              updated_at = now()
          where id = $1
        `,
        [
          row.id,
          matching.logIndex,
          notionalRaw.toString(),
          microToDecimal(notionalRaw),
          feeRaw.toString(),
          microToDecimal(feeRaw),
        ],
      );
    } catch (error) {
      skipped += 1;
      await pool.query(
        `
          update venue_fee_accruals
          set verification_error = $2,
              updated_at = now()
          where id = $1
        `,
        [row.id, error instanceof Error ? error.message : String(error)],
      );
    }
  }

  return { checked, verified, failed, skipped };
}

export async function unlockPolymarketBuilderFeeAccruals(
  pool: Pool,
  options: {
    limit?: number;
    dryRun?: boolean;
    assumeRewardsChainLock?: boolean;
  } = {},
): Promise<{ considered: number; unlocked: number; skipped: number; budgetMicro: string }> {
  return unlockVenueFeeAccruals(pool, {
    chainId: POLYGON_CHAIN_ID,
    venue: POLYMARKET_VENUE,
    feeProgram: POLYMARKET_BUILDER_FEE_PROGRAM,
    limit: options.limit,
    dryRun: options.dryRun,
    assumeRewardsChainLock: options.assumeRewardsChainLock,
  });
}

export async function reconcilePolymarketBuilderFeeAccruals(
  pool: Pool,
  options: { limit?: number; dryRun?: boolean } = {},
): Promise<{
  verify: Awaited<ReturnType<typeof verifyPolymarketBuilderFeeAccruals>>;
  unlock: Awaited<ReturnType<typeof unlockPolymarketBuilderFeeAccruals>>;
}> {
  return withRewardsChainLocks(pool, [POLYGON_CHAIN_ID], async () => {
    const verify = await verifyPolymarketBuilderFeeAccruals(pool, {
      limit: options.limit,
    });
    const unlock = await unlockPolymarketBuilderFeeAccruals(pool, {
      limit: options.limit,
      dryRun: options.dryRun,
      assumeRewardsChainLock: true,
    });
    return { verify, unlock };
  });
}
