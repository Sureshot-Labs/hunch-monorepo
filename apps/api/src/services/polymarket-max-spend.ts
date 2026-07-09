import {
  computeBuyCollateralLockedRaw,
  normalizeCollateralWalletKey,
} from "./open-order-collateral.js";
import { normalizeOpenOrder } from "./polymarket-clob-l2.js";

export type PolymarketFunderExecutionKind =
  | "safe"
  | "magic"
  | "deposit_wallet"
  | null;

function normalizeAddress(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function positiveBigInt(value: bigint | null | undefined): bigint {
  return value != null && value > 0n ? value : 0n;
}

export const POLYMARKET_BUY_APPROVAL_THRESHOLD = 1n << 255n;

export function polymarketAllowanceSatisfiesBuyApproval(
  value: bigint | null | undefined,
): boolean {
  return Boolean(value != null && value >= POLYMARKET_BUY_APPROVAL_THRESHOLD);
}

export function evaluatePolymarketBuyApprovalReadiness(inputs: {
  allowanceExchange: bigint | null | undefined;
  allowanceNegRisk: bigint | null | undefined;
  allowanceNegRiskAdapter?: bigint | null | undefined;
  negRisk: boolean | null | undefined;
  negRiskAdapterConfigured?: boolean | null | undefined;
}): { missing: string[]; ok: boolean } {
  const missing: string[] = [];
  const requireExchange = inputs.negRisk !== true;
  const requireNegRisk = inputs.negRisk !== false;
  if (
    requireExchange &&
    !polymarketAllowanceSatisfiesBuyApproval(inputs.allowanceExchange)
  ) {
    missing.push("exchange");
  }
  if (
    requireNegRisk &&
    !polymarketAllowanceSatisfiesBuyApproval(inputs.allowanceNegRisk)
  ) {
    missing.push("negRiskExchange");
  }
  if (
    requireNegRisk &&
    inputs.negRiskAdapterConfigured &&
    !polymarketAllowanceSatisfiesBuyApproval(inputs.allowanceNegRiskAdapter)
  ) {
    missing.push("negRiskAdapter");
  }
  return { missing, ok: missing.length === 0 };
}

export function computePolymarketExecutableFunds(inputs: {
  signer: string;
  funder: string;
  funderExecutionKind: PolymarketFunderExecutionKind;
  funderPusdRaw: bigint;
  funderLockedRaw?: bigint | null;
  signerPusdRaw?: bigint | null;
  signerLockedRaw?: bigint | null;
  signerUsdceRaw?: bigint | null;
}): {
  executableFundsRaw: bigint;
  funderPusdRaw: bigint;
  funderPusdAvailableRaw: bigint;
  funderLockedRaw: bigint;
  signerLockedRaw: bigint;
  signerPusdTopUpRaw: bigint;
  signerUsdceTopUpRaw: bigint;
  usesSignerTopUp: boolean;
} {
  const funderPusdRaw = positiveBigInt(inputs.funderPusdRaw);
  const funderLockedRaw = positiveBigInt(inputs.funderLockedRaw);
  const funderPusdAvailableRaw =
    funderPusdRaw > funderLockedRaw ? funderPusdRaw - funderLockedRaw : 0n;
  const usesSignerTopUp =
    inputs.funderExecutionKind === "deposit_wallet" &&
    normalizeAddress(inputs.signer) !== normalizeAddress(inputs.funder);
  const signerLockedRaw = usesSignerTopUp
    ? positiveBigInt(inputs.signerLockedRaw)
    : 0n;
  const signerPusdRaw = positiveBigInt(inputs.signerPusdRaw);
  const signerPusdTopUpRaw = usesSignerTopUp
    ? signerPusdRaw > signerLockedRaw
      ? signerPusdRaw - signerLockedRaw
      : 0n
    : 0n;
  const signerUsdceTopUpRaw = usesSignerTopUp
    ? positiveBigInt(inputs.signerUsdceRaw)
    : 0n;

  return {
    executableFundsRaw:
      funderPusdAvailableRaw + signerPusdTopUpRaw + signerUsdceTopUpRaw,
    funderPusdRaw,
    funderPusdAvailableRaw,
    funderLockedRaw,
    signerLockedRaw,
    signerPusdTopUpRaw,
    signerUsdceTopUpRaw,
    usesSignerTopUp,
  };
}

export function computePolymarketClobOpenOrderLocks(inputs: {
  orders: unknown[];
  wallets: string[];
}): Map<string, bigint> {
  const requestedWallets = new Set(
    inputs.wallets.map(normalizeCollateralWalletKey).filter(Boolean),
  );
  const locks = new Map<string, bigint>();
  if (requestedWallets.size === 0) return locks;

  for (const rawOrder of inputs.orders) {
    const order = normalizeOpenOrder(rawOrder);
    if (!order || order.side?.toUpperCase() !== "BUY") continue;

    const orderType = order.type?.trim().toUpperCase() ?? "";
    if (orderType && orderType !== "GTC" && orderType !== "GTD") continue;

    const walletKey = normalizeCollateralWalletKey(
      order.makerAddress ?? order.owner,
    );
    if (!walletKey || !requestedWallets.has(walletKey)) continue;

    const lockedRaw = computeBuyCollateralLockedRaw({
      venue: "polymarket",
      side: order.side,
      price: order.price,
      size: order.originalSize,
      filledSize: order.sizeMatched,
      orderPayload: null,
    });
    if (lockedRaw <= 0n) continue;

    locks.set(walletKey, (locks.get(walletKey) ?? 0n) + lockedRaw);
  }

  return locks;
}
