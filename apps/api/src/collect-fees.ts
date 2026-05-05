#!/usr/bin/env tsx

import { tx } from "@hunch/infra";
import { ethers } from "ethers";
import { pathToFileURL } from "node:url";
import { pool } from "./db.js";
import { env } from "./env.js";
import { abis } from "./lib/contracts.js";
import { resolveFeeEventSnapshotAtWrite } from "./services/rewards-fee-snapshot.js";

type FeeOrderRow = {
  user_id: string;
  wallet_address: string | null;
  signer_address: string | null;
  id: string;
  status: string | null;
  filled_size: string | number | null;
  order_hash: string | null;
  order_payload: unknown | null;
  order_payload_version: string | null;
  fee_auth: unknown | null;
  fee_auth_sig: string | null;
  fee_deadline: number | null;
  fee_collector_address: string | null;
  fee_collect_attempts: number | null;
};

type OrderStructV1 = {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: number;
  signatureType: number;
  signature: string;
};

type OrderStructV2 = {
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

type FeeAuthStructV1 = {
  signer: string;
  vault: string;
  exchange: string;
  orderHash: string;
  feeBps: string;
  nonce: string;
  deadline: string;
};

type FeeAuthStructV3 = {
  signer: string;
  vault: string;
  exchange: string;
  orderHash: string;
  feeBps: string;
  deadline: string;
};

type CollectorVersion = "v1" | "v2";

export type CollectFeesOptions = {
  dryRun: boolean;
  readOnly: boolean;
  limit: number;
  maxAttempts: number;
  dustRemainingMicro: bigint;
  orderHash?: string;
  includeExpired: boolean;
  archiveLegacy: boolean;
  txConfirmations: number;
  txTimeoutMs: number;
  collectorVersion: CollectorVersion;
};

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DUST_REMAINING = 1000n;
const DEFAULT_TX_CONFIRMATIONS = 1;
const DEFAULT_TX_TIMEOUT_MS = 120_000;
const USDC_DECIMALS = 6n;
const NOTHING_TO_CHARGE_SELECTOR = "0x35d06979";
let scriptReadOnly = false;

export function parseCollectFeesArgs(
  args: string[] = process.argv.slice(2),
): CollectFeesOptions {
  const getValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const next = args[idx + 1];
    return next && !next.startsWith("--") ? next : undefined;
  };
  const hasFlag = (flag: string): boolean => args.includes(flag);

  const limitRaw = getValue("--limit");
  const maxAttemptsRaw = getValue("--max-attempts");
  const dustRaw = getValue("--dust-remaining");
  const orderHash = getValue("--order-hash");
  const txConfirmationsRaw = getValue("--tx-confirmations");
  const txTimeoutRaw = getValue("--tx-timeout-ms");
  const collectorVersionRaw = getValue("--collector-version")?.toLowerCase();
  const collectorVersion: CollectorVersion =
    collectorVersionRaw === "v1" ? "v1" : "v2";

  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : DEFAULT_LIMIT;
  const maxAttempts = maxAttemptsRaw
    ? Math.max(1, Number(maxAttemptsRaw))
    : DEFAULT_MAX_ATTEMPTS;
  const dustParsed = dustRaw ? Number(dustRaw) : Number.NaN;
  const dustRemainingMicro = Number.isFinite(dustParsed)
    ? BigInt(Math.max(0, Math.trunc(dustParsed)))
    : DEFAULT_DUST_REMAINING;
  const txConfirmations = txConfirmationsRaw
    ? Math.max(0, Number(txConfirmationsRaw))
    : DEFAULT_TX_CONFIRMATIONS;
  const txTimeoutParsed = txTimeoutRaw ? Number(txTimeoutRaw) : Number.NaN;
  const txTimeoutMs = Number.isFinite(txTimeoutParsed)
    ? Math.max(0, Math.trunc(txTimeoutParsed))
    : DEFAULT_TX_TIMEOUT_MS;

  const readOnly = hasFlag("--read-only");
  return {
    dryRun: hasFlag("--dry-run") || readOnly,
    readOnly,
    includeExpired: hasFlag("--include-expired"),
    archiveLegacy: hasFlag("--archive-legacy"),
    limit: Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT,
    maxAttempts: Number.isFinite(maxAttempts)
      ? Math.trunc(maxAttempts)
      : DEFAULT_MAX_ATTEMPTS,
    dustRemainingMicro,
    orderHash: orderHash?.trim(),
    txConfirmations,
    txTimeoutMs,
    collectorVersion,
  };
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeOrderSide(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const upper = trimmed.toUpperCase();
    if (upper === "BUY") return 0;
    if (upper === "SELL") return 1;
    if (upper === "0") return 0;
    if (upper === "1") return 1;
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) return 0;
    if (value === 1) return 1;
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

function normalizeSignatureType(value: unknown): number | null {
  const raw = normalizeNumberishString(value);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function normalizeOrderPayloadV1(raw: unknown): OrderStructV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;

  const side = normalizeOrderSide(payload.side);
  const signatureType = normalizeSignatureType(payload.signatureType);
  const salt = normalizeNumberishString(payload.salt);
  const tokenId = normalizeNumberishString(payload.tokenId);
  const makerAmount = normalizeNumberishString(payload.makerAmount);
  const takerAmount = normalizeNumberishString(payload.takerAmount);
  const expiration = normalizeNumberishString(payload.expiration);
  const nonce = normalizeNumberishString(payload.nonce);
  const feeRateBps = normalizeNumberishString(payload.feeRateBps);
  const signature =
    typeof payload.signature === "string" ? payload.signature.trim() : "";

  const maker = typeof payload.maker === "string" ? payload.maker.trim() : "";
  const signer =
    typeof payload.signer === "string" ? payload.signer.trim() : "";
  const taker = typeof payload.taker === "string" ? payload.taker.trim() : "";

  if (
    side == null ||
    signatureType == null ||
    !salt ||
    !tokenId ||
    !makerAmount ||
    !takerAmount ||
    !expiration ||
    !nonce ||
    !feeRateBps ||
    !maker ||
    !signer ||
    !taker ||
    !signature
  ) {
    return null;
  }

  return {
    salt,
    maker,
    signer,
    taker,
    tokenId,
    makerAmount,
    takerAmount,
    expiration,
    nonce,
    feeRateBps,
    side,
    signatureType,
    signature,
  };
}

function normalizeOrderPayloadV2(raw: unknown): OrderStructV2 | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;

  const side = normalizeOrderSide(payload.side);
  const signatureType = normalizeSignatureType(payload.signatureType);
  const salt = normalizeNumberishString(payload.salt);
  const tokenId = normalizeNumberishString(payload.tokenId);
  const makerAmount = normalizeNumberishString(payload.makerAmount);
  const takerAmount = normalizeNumberishString(payload.takerAmount);
  const timestamp = normalizeNumberishString(payload.timestamp);
  const metadata =
    typeof payload.metadata === "string" ? payload.metadata.trim() : "";
  const builder =
    typeof payload.builder === "string" ? payload.builder.trim() : "";
  const signature =
    typeof payload.signature === "string" ? payload.signature.trim() : "";

  const maker = typeof payload.maker === "string" ? payload.maker.trim() : "";
  const signer =
    typeof payload.signer === "string" ? payload.signer.trim() : "";

  if (
    side == null ||
    signatureType == null ||
    !salt ||
    !tokenId ||
    !makerAmount ||
    !takerAmount ||
    !timestamp ||
    !metadata ||
    !builder ||
    !maker ||
    !signer ||
    !signature
  ) {
    return null;
  }

  return {
    salt,
    maker,
    signer,
    tokenId,
    makerAmount,
    takerAmount,
    side,
    signatureType,
    timestamp,
    metadata,
    builder,
    signature,
  };
}

function normalizeFeeAuthV1(raw: unknown): FeeAuthStructV1 | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;

  const signer =
    typeof payload.signer === "string" ? payload.signer.trim() : "";
  const vault = typeof payload.vault === "string" ? payload.vault.trim() : "";
  const exchange =
    typeof payload.exchange === "string" ? payload.exchange.trim() : "";
  const orderHash =
    typeof payload.orderHash === "string" ? payload.orderHash.trim() : "";

  const feeBps = normalizeNumberishString(payload.feeBps);
  const nonce = normalizeNumberishString(payload.nonce);
  const deadline = normalizeNumberishString(payload.deadline);

  if (!signer || !vault || !exchange || !orderHash) return null;
  if (!feeBps || !nonce || !deadline) return null;

  return {
    signer,
    vault,
    exchange,
    orderHash,
    feeBps,
    nonce,
    deadline,
  };
}

function normalizeFeeAuthV3(raw: unknown): FeeAuthStructV3 | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;

  const signer =
    typeof payload.signer === "string" ? payload.signer.trim() : "";
  const vault = typeof payload.vault === "string" ? payload.vault.trim() : "";
  const exchange =
    typeof payload.exchange === "string" ? payload.exchange.trim() : "";
  const orderHash =
    typeof payload.orderHash === "string" ? payload.orderHash.trim() : "";

  const feeBps = normalizeNumberishString(payload.feeBps);
  const deadline = normalizeNumberishString(payload.deadline);

  if (!signer || !vault || !exchange || !orderHash) return null;
  if (!feeBps || !deadline) return null;

  return {
    signer,
    vault,
    exchange,
    orderHash,
    feeBps,
    deadline,
  };
}

function truncateError(value: string, max = 500): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function includesSelector(value: unknown, selector: string): boolean {
  const target = selector.toLowerCase();
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length) {
    const current = stack.pop();
    if (current == null) continue;
    if (typeof current === "string") {
      if (current.toLowerCase().includes(target)) return true;
      continue;
    }
    if (typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const nested of Object.values(current as Record<string, unknown>)) {
      stack.push(nested);
    }
  }
  return false;
}

function isNothingToChargeError(error: unknown): boolean {
  return includesSelector(error, NOTHING_TO_CHARGE_SELECTOR);
}

function formatUsdcAmount(raw: bigint): string {
  const divisor = 10n ** USDC_DECIMALS;
  const integer = raw / divisor;
  const fraction = raw % divisor;
  const fractionStr = fraction.toString().padStart(Number(USDC_DECIMALS), "0");
  return `${integer.toString()}.${fractionStr}`;
}

async function insertFeeEvent(inputs: {
  userId: string;
  walletAddress: string | null;
  orderHash: string;
  feeAmount: bigint;
  txHash: string;
  feeAsset: string;
}) {
  if (scriptReadOnly) return;
  const amount = formatUsdcAmount(inputs.feeAmount);
  await tx(pool, async (client) => {
    const snapshot = await resolveFeeEventSnapshotAtWrite(client, {
      userId: inputs.userId,
      eventTime: new Date(),
      feeUsd: amount,
    });

    const result = await client.query<{ id: string }>(
      `
        insert into fee_events (
          id,
          user_id,
          wallet_address,
          venue,
          chain_id,
          source_type,
          source_id,
          fee_amount,
          fee_asset,
          fee_usd,
          cashback_bps_applied,
          referral_bps_applied,
          cashback_earned_usdc,
          referral_earned_usdc,
          liability_snapshot_source,
          tx_hash,
          collected_at,
          status,
          created_at,
          updated_at
        )
        values (
          gen_random_uuid(),
          $1, $2, 'polymarket', '137', 'order', $3,
          $4, $5, $4, $6, $7, $8, $9, $10, $11, now(), 'collected', now(), now()
        )
        on conflict (user_id, source_type, source_id)
        do update set
          tx_hash = excluded.tx_hash,
          collected_at = excluded.collected_at,
          status = excluded.status,
          updated_at = now()
        where fee_events.fee_amount = excluded.fee_amount
          and fee_events.fee_usd = excluded.fee_usd
          and fee_events.cashback_bps_applied = excluded.cashback_bps_applied
          and fee_events.referral_bps_applied = excluded.referral_bps_applied
          and fee_events.cashback_earned_usdc = excluded.cashback_earned_usdc
          and fee_events.referral_earned_usdc = excluded.referral_earned_usdc
          and fee_events.liability_snapshot_source = excluded.liability_snapshot_source
        returning id
      `,
      [
        inputs.userId,
        inputs.walletAddress,
        inputs.orderHash,
        amount,
        inputs.feeAsset,
        snapshot.cashbackBpsApplied,
        snapshot.referralBpsApplied,
        snapshot.cashbackEarnedUsdc,
        snapshot.referralEarnedUsdc,
        snapshot.liabilitySnapshotSource,
        inputs.txHash,
      ],
    );
    if (!result.rows.length) {
      throw new Error(
        `fee_events immutable economic mismatch for source_id=${inputs.orderHash}`,
      );
    }
  });
}

function rowLabel(row: FeeOrderRow, orderHash?: string): string {
  const hash =
    orderHash ??
    (typeof row.order_hash === "string" ? normalizeHex(row.order_hash) : "");
  return hash || `row:${row.id}`;
}

async function fetchPendingOrders(
  options: CollectFeesOptions,
  feeCollectorAddress: string,
): Promise<FeeOrderRow[]> {
  const params: Array<string | number> = [options.maxAttempts];
  let whereClause = `
    WHERE venue = 'polymarket'
      AND order_hash IS NOT NULL
      AND fee_auth_sig IS NOT NULL
      AND order_payload IS NOT NULL
      AND fee_collected_at IS NULL
      AND COALESCE(fee_collect_attempts, 0) < $1
  `;

  if (!options.archiveLegacy && feeCollectorAddress) {
    params.push(feeCollectorAddress.toLowerCase());
    whereClause += ` AND (fee_collector_address IS NULL OR lower(fee_collector_address) = $${params.length})`;
  }

  if (options.collectorVersion === "v2") {
    whereClause += ` AND order_payload_version = 'polymarket_clob_v2'`;
  } else {
    whereClause += ` AND (order_payload_version IS NULL OR order_payload_version = 'polymarket_clob_v1')`;
  }

  if (options.orderHash) {
    params.push(options.orderHash);
    whereClause += ` AND order_hash = $${params.length}`;
  }

  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT;
  params.push(limit);

  const query = `
    SELECT
      user_id,
      wallet_address,
      signer_address,
      id,
      status,
      filled_size,
      order_hash,
      order_payload,
      order_payload_version,
      fee_auth,
      fee_auth_sig,
      fee_deadline,
      fee_collector_address,
      fee_collect_attempts
    FROM orders
    ${whereClause}
    ORDER BY
      (fee_auth->>'signer') ASC NULLS LAST,
      NULLIF(fee_auth->>'nonce', '')::numeric ASC NULLS LAST,
      posted_at ASC NULLS LAST
    LIMIT $${params.length}
  `;

  const { rows } = await pool.query<FeeOrderRow>(query, params);
  return rows;
}

async function updateFeeSuccess(
  id: string,
  attempts: number,
  txHash: string,
): Promise<void> {
  if (scriptReadOnly) return;
  await pool.query(
    `
      UPDATE orders
      SET
        fee_collected_at = now(),
        fee_collect_tx_hash = $1,
        fee_collect_error = NULL,
        fee_collect_attempts = $2
      WHERE id = $3
    `,
    [txHash, attempts, id],
  );
}

async function updateFeeError(
  id: string,
  attempts: number,
  error: string,
): Promise<void> {
  if (scriptReadOnly) return;
  await pool.query(
    `
      UPDATE orders
      SET
        fee_collect_error = $1,
        fee_collect_attempts = $2
      WHERE id = $3
    `,
    [truncateError(error), attempts, id],
  );
}

async function archiveFeeError(
  id: string,
  attempts: number,
  error: string,
): Promise<void> {
  if (scriptReadOnly) return;
  await pool.query(
    `
      UPDATE orders
      SET
        fee_collect_error = $1,
        fee_collect_attempts = $2,
        fee_collected_at = now()
      WHERE id = $3
    `,
    [truncateError(error), attempts, id],
  );
}

async function updateFeeNote(id: string, note: string): Promise<void> {
  if (scriptReadOnly) return;
  await pool.query(
    `
      UPDATE orders
      SET fee_collect_error = $1
      WHERE id = $2
    `,
    [truncateError(note), id],
  );
}

export type CollectFeesRunResult = {
  dryRunCount: number;
  collected: number;
  skippedLive: number;
  skippedNoCharge: number;
  skippedNothing: number;
  skippedError: number;
};

export async function runCollectFees(
  options: CollectFeesOptions,
): Promise<CollectFeesRunResult> {
  scriptReadOnly = options.readOnly;
  const feeCollectorAddress =
    options.collectorVersion === "v1"
      ? env.feeCollectorLegacyAddress?.trim() || env.feeCollectorAddress?.trim()
      : env.feeCollectorAddress?.trim();
  const privateKey =
    options.collectorVersion === "v1"
      ? env.feeCollectorLegacyPrivateKey?.trim() || env.feeCollectorPrivateKey
      : env.feeCollectorPrivateKey;

  if (!feeCollectorAddress) {
    throw new Error("Missing HUNCH_FEE_COLLECTOR_ADDRESS");
  }
  if (!privateKey && !options.dryRun) {
    throw new Error("Missing HUNCH_FEE_COLLECTOR_PRIVATE_KEY");
  }

  const provider = new ethers.JsonRpcProvider(env.polygonRpcUrl);
  const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;
  const collector = new ethers.Contract(
    feeCollectorAddress,
    options.collectorVersion === "v2"
      ? abis.PolymarketFeeCollectorClobV2
      : abis.PolymarketFeeCollector,
    wallet ?? provider,
  );
  const collectorIface = new ethers.Interface(
    options.collectorVersion === "v2"
      ? abis.PolymarketFeeCollectorClobV2
      : abis.PolymarketFeeCollector,
  );
  const exchangeAbi =
    options.collectorVersion === "v2"
      ? abis.IPolymarketExchangeV2
      : abis.IPolymarketExchange;
  const feeAsset = options.collectorVersion === "v2" ? "pUSD" : "USDC";

  const orders = await fetchPendingOrders(options, feeCollectorAddress);
  console.log(
    `Found ${orders.length} pending fee orders (collectorVersion=${options.collectorVersion}, dryRun=${options.dryRun}, readOnly=${options.readOnly})`,
  );
  if (orders.length > 0) {
    console.log(
      "Pending rows include any with prior errors; use fee_collect_error to inspect skipped items.",
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let skippedLive = 0;
  let skippedNoCharge = 0;
  let skippedNothing = 0;
  let skippedError = 0;
  let dryRunCount = 0;
  let collected = 0;

  for (const row of orders) {
    const attempts = (row.fee_collect_attempts ?? 0) + 1;
    const orderHash = row.order_hash ? normalizeHex(row.order_hash) : "";
    const label = rowLabel(row, orderHash);

    const orderStatus = row.status?.trim().toLowerCase() ?? "";
    const filledSize = parseNumber(row.filled_size) ?? 0;
    if (
      (orderStatus.includes("cancel") || orderStatus.includes("expire")) &&
      filledSize <= 0
    ) {
      const reason = `Order ${orderStatus || "cancelled"} with no fills`;
      console.log(`Skip ${label}: ${reason}`);
      skippedNoCharge += 1;
      await archiveFeeError(row.id, attempts, reason);
      continue;
    }

    if (!orderHash) {
      const reason = "Missing order_hash";
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      if (options.archiveLegacy) {
        await archiveFeeError(row.id, attempts, `${reason} (archived)`);
      } else {
        await updateFeeError(row.id, attempts, reason);
      }
      continue;
    }

    const order =
      options.collectorVersion === "v2"
        ? normalizeOrderPayloadV2(row.order_payload)
        : normalizeOrderPayloadV1(row.order_payload);
    if (!order) {
      const reason = "Invalid order_payload";
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      if (options.archiveLegacy) {
        await archiveFeeError(row.id, attempts, `${reason} (archived)`);
      } else {
        await updateFeeError(row.id, attempts, reason);
      }
      continue;
    }

    const feeAuth =
      options.collectorVersion === "v2"
        ? normalizeFeeAuthV3(row.fee_auth)
        : normalizeFeeAuthV1(row.fee_auth);
    if (!feeAuth) {
      const reason = "Invalid fee_auth payload";
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      await updateFeeError(row.id, attempts, reason);
      continue;
    }

    if (
      row.fee_collector_address &&
      normalizeHex(row.fee_collector_address) !==
        normalizeHex(feeCollectorAddress)
    ) {
      const reason = `Fee collector address mismatch (row=${row.fee_collector_address}, expected=${feeCollectorAddress})`;
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      if (options.archiveLegacy) {
        await archiveFeeError(
          row.id,
          attempts,
          "Fee collector address mismatch (archived)",
        );
      } else {
        await updateFeeError(
          row.id,
          attempts,
          "Fee collector address mismatch",
        );
      }
      continue;
    }

    const feeAuthSig = row.fee_auth_sig?.trim() ?? "";
    if (!feeAuthSig) {
      const reason = "Missing fee_auth_sig";
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      if (options.archiveLegacy) {
        await archiveFeeError(row.id, attempts, `${reason} (archived)`);
      } else {
        await updateFeeError(row.id, attempts, reason);
      }
      continue;
    }

    if (!options.includeExpired && row.fee_deadline) {
      if (nowSec > row.fee_deadline) {
        const reason = `Fee auth deadline expired (deadline=${row.fee_deadline}, now=${nowSec})`;
        console.log(`Skip ${label}: ${reason}`);
        skippedError += 1;
        if (options.archiveLegacy) {
          await archiveFeeError(
            row.id,
            attempts,
            "Fee auth deadline expired (archived)",
          );
        } else {
          await updateFeeError(row.id, attempts, "Fee auth deadline expired");
        }
        continue;
      }
    }

    const exchange = new ethers.Contract(
      feeAuth.exchange,
      exchangeAbi,
      provider,
    );

    const computedHash = await exchange.hashOrder(order);
    if (normalizeHex(computedHash) !== orderHash) {
      const reason = `order_hash mismatch (db=${orderHash}, computed=${normalizeHex(
        computedHash,
      )})`;
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      await updateFeeError(row.id, attempts, "order_hash mismatch");
      continue;
    }

    const allowed = await collector.allowedExchanges(feeAuth.exchange);
    if (!allowed) {
      const reason = `Exchange not allowlisted (${feeAuth.exchange})`;
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      await updateFeeError(row.id, attempts, "Exchange not allowlisted");
      continue;
    }

    let status: { isFilledOrCancelled: boolean; remaining: bigint };
    try {
      const rawStatus = await exchange.getOrderStatus(orderHash);
      if (options.collectorVersion === "v2") {
        status = {
          isFilledOrCancelled: Boolean(rawStatus.filled),
          remaining: BigInt(rawStatus.remaining),
        };
      } else {
        status = {
          isFilledOrCancelled: Boolean(rawStatus.isFilledOrCancelled),
          remaining: BigInt(rawStatus.remaining),
        };
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown order status error";
      console.log(`Skip ${label}: getOrderStatus failed (${message})`);
      skippedError += 1;
      await updateFeeError(
        row.id,
        attempts,
        `getOrderStatus failed: ${message}`,
      );
      continue;
    }

    const makerAmount = BigInt(order.makerAmount);
    const remainingRaw = status.remaining;
    const remaining =
      remainingRaw <= options.dustRemainingMicro ? 0n : remainingRaw;

    const v2DefaultUnfilled =
      options.collectorVersion === "v2" &&
      !status.isFilledOrCancelled &&
      remainingRaw === 0n;
    if (!status.isFilledOrCancelled && (remaining > 0n || v2DefaultUnfilled)) {
      console.log(
        `Skip ${label}: order still live (remaining=${remainingRaw}, maker=${makerAmount})`,
      );
      skippedLive += 1;
      continue;
    }

    const makerFilled = makerAmount > remaining ? makerAmount - remaining : 0n;

    const charged = await collector.makerFilledCharged(orderHash);
    if (makerFilled <= charged) {
      console.log(
        `Skip ${label}: nothing to charge yet (filled=${makerFilled}, charged=${charged})`,
      );
      skippedNothing += 1;
      continue;
    }

    if (options.dryRun) {
      console.log(
        `Dry run: would collect fee for ${orderHash} (filled=${makerFilled}, charged=${charged})`,
      );
      dryRunCount += 1;
      continue;
    }

    if (!wallet) {
      await updateFeeError(row.id, attempts, "Missing fee collector signer");
      continue;
    }

    try {
      const tx = await collector.collectFee(order, feeAuth, feeAuthSig);
      console.log(`collectFee tx ${tx.hash} for ${orderHash}`);
      const receipt = await provider.waitForTransaction(
        tx.hash,
        options.txConfirmations,
        options.txTimeoutMs,
      );
      if (!receipt) {
        throw new Error(
          `collectFee tx not confirmed within ${options.txTimeoutMs}ms`,
        );
      }
      if (receipt.status === 0) {
        throw new Error("collectFee tx reverted");
      }
      if (receipt) {
        let feeAmount: bigint | null = null;
        for (const log of receipt.logs) {
          try {
            const parsed = collectorIface.parseLog(log);
            if (!parsed || parsed.name !== "FeeCollected") continue;
            const rawOrderHash = parsed.args.orderHash;
            const eventOrderHash =
              typeof rawOrderHash === "string"
                ? normalizeHex(rawOrderHash)
                : "";
            if (eventOrderHash && eventOrderHash !== orderHash) continue;
            feeAmount = BigInt(parsed.args.feeAmount);
            break;
          } catch {
            // ignore unrelated logs
          }
        }

        if (feeAmount != null) {
          const wallet =
            row.wallet_address ??
            row.signer_address ??
            (typeof feeAuth.signer === "string" ? feeAuth.signer : null);
          await insertFeeEvent({
            userId: row.user_id,
            walletAddress: wallet,
            orderHash,
            feeAmount,
            txHash: tx.hash,
            feeAsset,
          });
        }
      }
      await updateFeeSuccess(row.id, attempts, tx.hash);
      collected += 1;
    } catch (error) {
      if (isNothingToChargeError(error)) {
        console.log(`Skip ${label}: nothing to charge yet (on-chain)`);
        skippedNothing += 1;
        await updateFeeNote(row.id, "NothingToCharge");
        continue;
      }
      const message =
        error instanceof Error ? error.message : "Unknown collectFee error";
      console.log(`Error ${label}: ${message}`);
      skippedError += 1;
      await updateFeeError(row.id, attempts, message);
    }
  }

  console.log(
    `Done. dryRun=${dryRunCount}, collected=${collected}, skippedLive=${skippedLive}, skippedNoCharge=${skippedNoCharge}, skippedNothing=${skippedNothing}, skippedError=${skippedError}`,
  );
  return {
    dryRunCount,
    collected,
    skippedLive,
    skippedNoCharge,
    skippedNothing,
    skippedError,
  };
}

function isDirectExecution(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  return pathToFileURL(entrypoint).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  runCollectFees(parseCollectFeesArgs())
    .then(async () => {
      await pool.end();
    })
    .catch(async (error) => {
      console.error("[collect-fees]", error);
      process.exitCode = 1;
      await pool.end();
    });
}
