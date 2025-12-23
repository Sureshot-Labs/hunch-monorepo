#!/usr/bin/env tsx

import { abis } from "@hunch/contracts";
import { ethers } from "ethers";
import { pool } from "./db.js";
import { env } from "./env.js";

type FeeOrderRow = {
  id: string;
  status: string | null;
  filled_size: string | number | null;
  order_hash: string | null;
  order_payload: unknown | null;
  fee_auth: unknown | null;
  fee_auth_sig: string | null;
  fee_deadline: number | null;
  fee_collector_address: string | null;
  fee_collect_attempts: number | null;
};

type OrderStruct = {
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

type FeeAuthStruct = {
  signer: string;
  vault: string;
  exchange: string;
  orderHash: string;
  feeBps: string;
  nonce: string;
  deadline: string;
};

type ScriptOptions = {
  dryRun: boolean;
  limit: number;
  maxAttempts: number;
  dustRemainingMicro: bigint;
  orderHash?: string;
  includeExpired: boolean;
  archiveLegacy: boolean;
};

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_DUST_REMAINING = 1000n;

function parseArgs(): ScriptOptions {
  const args = process.argv.slice(2);
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

  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : DEFAULT_LIMIT;
  const maxAttempts = maxAttemptsRaw
    ? Math.max(1, Number(maxAttemptsRaw))
    : DEFAULT_MAX_ATTEMPTS;
  const dustParsed = dustRaw ? Number(dustRaw) : Number.NaN;
  const dustRemainingMicro = Number.isFinite(dustParsed)
    ? BigInt(Math.max(0, Math.trunc(dustParsed)))
    : DEFAULT_DUST_REMAINING;

  return {
    dryRun: hasFlag("--dry-run"),
    includeExpired: hasFlag("--include-expired"),
    archiveLegacy: hasFlag("--archive-legacy"),
    limit: Number.isFinite(limit) ? Math.trunc(limit) : DEFAULT_LIMIT,
    maxAttempts: Number.isFinite(maxAttempts)
      ? Math.trunc(maxAttempts)
      : DEFAULT_MAX_ATTEMPTS,
    dustRemainingMicro,
    orderHash: orderHash?.trim(),
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

function normalizeOrderPayload(raw: unknown): OrderStruct | null {
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
  const signer = typeof payload.signer === "string" ? payload.signer.trim() : "";
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

function normalizeFeeAuth(raw: unknown): FeeAuthStruct | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;

  const signer = typeof payload.signer === "string" ? payload.signer.trim() : "";
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

function truncateError(value: string, max = 500): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function rowLabel(row: FeeOrderRow, orderHash?: string): string {
  const hash =
    orderHash ??
    (typeof row.order_hash === "string" ? normalizeHex(row.order_hash) : "");
  return hash || `row:${row.id}`;
}

async function fetchPendingOrders(
  options: ScriptOptions,
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

  if (options.orderHash) {
    params.push(options.orderHash);
    whereClause += ` AND order_hash = $${params.length}`;
  }

  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT;
  params.push(limit);

  const query = `
    SELECT
      id,
      status,
      filled_size,
      order_hash,
      order_payload,
      fee_auth,
      fee_auth_sig,
      fee_deadline,
      fee_collector_address,
      fee_collect_attempts
    FROM orders
    ${whereClause}
    ORDER BY
      (fee_auth->>'signer') ASC NULLS LAST,
      (fee_auth->>'nonce')::numeric ASC NULLS LAST,
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

async function main() {
  const options = parseArgs();
  const feeCollectorAddress = env.feeCollectorAddress?.trim();
  const privateKey = env.feeCollectorPrivateKey;

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
    abis.PolymarketFeeCollector,
    wallet ?? provider,
  );

  const orders = await fetchPendingOrders(options, feeCollectorAddress);
  console.log(
    `Found ${orders.length} pending fee orders (dryRun=${options.dryRun})`,
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
      await updateFeeError(row.id, attempts, reason);
      continue;
    }

    const order = normalizeOrderPayload(row.order_payload);
    if (!order) {
      const reason = "Invalid order_payload";
      console.log(`Skip ${label}: ${reason}`);
      skippedError += 1;
      await updateFeeError(row.id, attempts, reason);
      continue;
    }

    const feeAuth = normalizeFeeAuth(row.fee_auth);
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
      await updateFeeError(row.id, attempts, reason);
      continue;
    }

    if (!options.includeExpired && row.fee_deadline) {
      if (nowSec > row.fee_deadline) {
        const reason = `Fee auth deadline expired (deadline=${row.fee_deadline}, now=${nowSec})`;
        console.log(`Skip ${label}: ${reason}`);
        skippedError += 1;
        await updateFeeError(row.id, attempts, "Fee auth deadline expired");
        continue;
      }
    }

    const exchange = new ethers.Contract(
      feeAuth.exchange,
      abis.IPolymarketExchange,
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
      status = {
        isFilledOrCancelled: Boolean(rawStatus.isFilledOrCancelled),
        remaining: BigInt(rawStatus.remaining),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown order status error";
      console.log(`Skip ${label}: getOrderStatus failed (${message})`);
      skippedError += 1;
      await updateFeeError(row.id, attempts, `getOrderStatus failed: ${message}`);
      continue;
    }

    const makerAmount = BigInt(order.makerAmount);
    const remainingRaw = status.remaining;
    const remaining =
      remainingRaw <= options.dustRemainingMicro ? 0n : remainingRaw;

    if (!status.isFilledOrCancelled && remaining > 0n) {
      console.log(
        `Skip ${label}: order still live (remaining=${remaining}, maker=${makerAmount})`,
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
      await tx.wait();
      await updateFeeSuccess(row.id, attempts, tx.hash);
      collected += 1;
    } catch (error) {
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
  await pool.end();
}

main().catch((error) => {
  console.error("[collect-fees]", error);
  process.exitCode = 1;
});
