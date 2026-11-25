import type { Pool } from "@hunch/infra";

import { fundingSidecarRuntimeConfig } from "../funding/runtime/sidecar-runtime-config.js";
import { isRecord } from "../lib/type-guards.js";
import {
  fetchLimitlessClobMarket,
  marketLimitlessFeePolicy,
} from "./limitless-clob-fee-runtime.js";
import { assertLimitlessMarketPayloadSlug } from "./limitless-clob-fees.js";
import {
  fetchOpenOrderCollateralLocks,
  normalizeCollateralWalletKey,
} from "./open-order-collateral.js";
import { fetchErc20BalanceOf } from "./polygon-rpc.js";

// Limitless's published admission reserve, not a quoted execution fee.
// https://docs.limitless.exchange/developers/migrate-to-new-trading-venues#balance-and-approval-checks
const STANDARD_RESERVE_BPS = 500n;
const BPS = 10_000n;
const USDC_SCALE = 1_000_000;

export type LimitlessCollateralBuyCheck = {
  status:
    | "ready"
    | "insufficient_principal"
    | "standard_reserve_shortfall"
    | "unavailable";
  principalRaw: string;
  balanceRaw: string | null;
  availableRaw: string | null;
  standardFeeReserveRaw: string | null;
  standardRequiredRaw: string | null;
  standardShortfallRaw: string | null;
  standardMaxBuyRaw: string | null;
};

export function maxLimitlessPrincipalRaw(budget: bigint, reserveBps: bigint) {
  return (budget * BPS) / (BPS + reserveBps);
}

export function standardLimitlessBuyTotalRaw(
  principal: bigint,
  reserveBps: bigint,
) {
  return principal + (principal * reserveBps + BPS - 1n) / BPS;
}

export function readLimitlessBuyReservePolicy(
  payload: unknown,
  marketSlug: string,
) {
  assertLimitlessMarketPayloadSlug(payload, marketSlug);
  const feePolicy = marketLimitlessFeePolicy(payload);
  const market =
    isRecord(payload) && isRecord(payload.market) ? payload.market : payload;
  const metadata =
    isRecord(market) && isRecord(market.metadata) ? market.metadata : null;
  const feeEnabled = typeof metadata?.fee === "boolean" ? metadata.fee : null;
  return {
    feePolicy,
    feeEnabled,
    reserveBps:
      feePolicy.mode === "legacy" || feeEnabled === false
        ? 0n
        : feeEnabled === true
          ? STANDARD_RESERVE_BPS
          : null,
  };
}

export function limitlessUsdToRaw(amount: number): bigint | null {
  const raw = Math.round(amount * USDC_SCALE);
  return Number.isSafeInteger(raw) && raw > 0 && raw / USDC_SCALE === amount
    ? BigInt(raw)
    : null;
}

export function limitlessEmbeddedFokBuyPrincipal(payload: {
  makerAmount: string | number;
  takerAmount: string | number;
  side: string | number;
}): bigint | null {
  const rawUint = (value: string | number) => {
    if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
    const text = String(value).trim();
    return /^(?:\d{1,78}|0x[\da-f]{1,64})$/i.test(text) ? BigInt(text) : null;
  };
  if (
    (String(payload.side).trim().toUpperCase() !== "BUY" &&
      rawUint(payload.side) !== 0n) ||
    rawUint(payload.takerAmount) !== 1n
  )
    return null;
  const principal = rawUint(payload.makerAmount);
  return principal !== null && principal > 0n && principal < 1n << 256n
    ? principal
    : null;
}

export function computeLimitlessCollateralBuyCheck(input: {
  principal: bigint;
  feeEnabled: boolean | null;
  balance: bigint | null;
  locked: bigint | null;
}): LimitlessCollateralBuyCheck {
  const { principal, feeEnabled, balance, locked } = input;
  const reserveBps =
    feeEnabled === null ? null : feeEnabled ? STANDARD_RESERVE_BPS : 0n;
  const required =
    reserveBps === null
      ? null
      : standardLimitlessBuyTotalRaw(principal, reserveBps);
  const available =
    balance === null || locked === null
      ? null
      : balance > locked
        ? balance - locked
        : 0n;
  const shortfall =
    required === null || available === null
      ? null
      : available < required
        ? required - available
        : 0n;
  return {
    status:
      balance !== null && balance < principal
        ? "insufficient_principal"
        : shortfall === null
          ? "unavailable"
          : shortfall > 0n
            ? "standard_reserve_shortfall"
            : "ready",
    principalRaw: principal.toString(),
    balanceRaw: balance?.toString() ?? null,
    availableRaw: available?.toString() ?? null,
    standardFeeReserveRaw:
      required === null ? null : (required - principal).toString(),
    standardRequiredRaw: required?.toString() ?? null,
    standardShortfallRaw: shortfall?.toString() ?? null,
    standardMaxBuyRaw:
      available !== null && reserveBps !== null
        ? maxLimitlessPrincipalRaw(available, reserveBps).toString()
        : null,
  };
}

export async function inspectLimitlessCollateralBuy(
  input: {
    db: Pick<Pool, "query">;
    userId: string;
    signer: string;
    principal: bigint;
    marketSlug: string;
    marketPayload?: unknown;
  },
  dependencies: {
    fetchMarket?: typeof fetchLimitlessClobMarket;
    readBalance?: typeof fetchErc20BalanceOf;
    readLocks?: typeof fetchOpenOrderCollateralLocks;
  } = {},
): Promise<LimitlessCollateralBuyCheck | null> {
  const { principal } = input;
  let facts: ReturnType<typeof readLimitlessBuyReservePolicy>;
  try {
    const payload =
      input.marketPayload ??
      (await (dependencies.fetchMarket ?? fetchLimitlessClobMarket)(
        input.marketSlug,
        { timeoutMs: 2_500 },
      ));
    facts = readLimitlessBuyReservePolicy(payload, input.marketSlug);
  } catch {
    return computeLimitlessCollateralBuyCheck({
      principal,
      feeEnabled: null,
      balance: null,
      locked: null,
    });
  }
  const { feePolicy: policy, feeEnabled } = facts;
  if (policy.mode !== "collateral") return null;
  const wallet = normalizeCollateralWalletKey(input.signer);
  if (!wallet)
    return computeLimitlessCollateralBuyCheck({
      principal,
      feeEnabled,
      balance: null,
      locked: null,
    });
  const [balance, locked] = await Promise.all([
    (dependencies.readBalance ?? fetchErc20BalanceOf)({
      tokenAddress: policy.collateralToken,
      owner: input.signer,
      rpcUrl: fundingSidecarRuntimeConfig.baseRpcUrl,
      timeoutMs: Math.min(fundingSidecarRuntimeConfig.baseRpcTimeoutMs, 3_000),
    }).catch(() => null),
    (dependencies.readLocks ?? fetchOpenOrderCollateralLocks)(input.db, {
      userId: input.userId,
      polymarketWallets: [],
      limitlessWallets: [input.signer],
    })
      .then((locks) => locks.limitless.get(wallet) ?? 0n)
      .catch(() => null),
  ]);
  return computeLimitlessCollateralBuyCheck({
    principal,
    feeEnabled,
    balance,
    locked,
  });
}

export function enforceLimitlessCollateralBuyCheck(
  check: LimitlessCollateralBuyCheck | null,
  requireStandardFeeReserve: boolean,
) {
  if (!check || check.status === "ready") return null;
  let error: string;
  let code: string;
  if (check.status === "insufficient_principal") {
    code = "limitless_collateral_balance_insufficient";
    error =
      "Not enough Base USDC for this Limitless buy. Review the amount or add funds.";
  } else if (!requireStandardFeeReserve) {
    // The partner profile API does not expose a collateral fee cap. Do not
    // reject a grandfathered caller on a standard-rate estimate.
    return null;
  } else if (check.status === "standard_reserve_shortfall") {
    code = "limitless_collateral_standard_reserve_shortfall";
    error =
      "Not enough available Base USDC for this buy plus the standard Limitless fee reserve. Review the amount or add funds.";
  } else {
    code = "limitless_collateral_check_unavailable";
    error =
      "Could not check the Base USDC balance and Limitless fee reserve. Refresh and try again.";
  }
  return {
    statusCode: check.status === "unavailable" ? 503 : 409,
    payload: { error, code, collateralBuy: check },
  };
}
