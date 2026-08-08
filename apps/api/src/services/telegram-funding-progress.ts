import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import type {
  FundingReceiveReceipt,
  FundingReceiveSession,
} from "../funding/domain/types.js";
import { canonicalJsonHash } from "../funding/persistence/canonical.js";
import type { TelegramFundingProgressProjection } from "./telegram-funding-contracts.js";
import type {
  TelegramFundingConsent,
  TelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";

function latestObservedAt(
  receipts: readonly FundingReceiveReceipt[],
): string | null {
  return (
    receipts
      .map((receipt) => receipt.observedAt)
      .sort((left, right) => right.localeCompare(left))[0] ?? null
  );
}

function sumRaw(receipts: readonly FundingReceiveReceipt[]): string | null {
  if (receipts.length === 0) return null;
  return receipts
    .reduce((total, receipt) => total + BigInt(receipt.rawAmount), 0n)
    .toString();
}

function projection(input: {
  assetSymbol: "pUSD" | "USDC.e";
  context: TelegramFundingSessionContext;
  receipts: readonly FundingReceiveReceipt[];
  state: TelegramFundingProgressProjection["state"];
  terminal: boolean;
  receiveAddress?: string | null;
}): TelegramFundingProgressProjection {
  return {
    version: 1,
    fundingContextId: input.context.id,
    state: input.state,
    terminal: input.terminal,
    assetSymbol: input.assetSymbol,
    networkLabel: "Polygon",
    rawAmount: sumRaw(input.receipts),
    decimals: 6,
    receiveAddress: input.receiveAddress ?? null,
    expiresAt: input.context.expiresAt,
    observedAt: latestObservedAt(input.receipts),
  };
}

export function projectTelegramFundingProgress(input: {
  consent: TelegramFundingConsent | null;
  context: TelegramFundingSessionContext;
  receipts: readonly FundingReceiveReceipt[];
  session: FundingReceiveSession;
  now?: Date;
}): TelegramFundingProgressProjection | null {
  const now = input.now ?? new Date();
  const usdceReceipts = input.receipts.filter(
    (receipt) => resolveKnownAccountAssetSymbol(receipt.asset) === "USDC.e",
  );
  const pUsdReceipts = input.receipts.filter(
    (receipt) => resolveKnownAccountAssetSymbol(receipt.asset) === "pUSD",
  );
  const recoveryReceipts = input.receipts.filter(
    (receipt) => receipt.status === "recovery_required",
  );

  // A direct pUSD consent is exact to pUSD. Any USDC.e receipt at the shared
  // address is visible, but never inherits conversion authority.
  if (usdceReceipts.length > 0) {
    return projection({
      assetSymbol: "USDC.e",
      context: input.context,
      receipts: usdceReceipts,
      state: "needs_attention",
      terminal: true,
    });
  }
  if (
    recoveryReceipts.length > 0 ||
    input.session.status === "recovery_required"
  ) {
    return projection({
      assetSymbol: "pUSD",
      context: input.context,
      receipts: recoveryReceipts.length > 0 ? recoveryReceipts : pUsdReceipts,
      state: "needs_attention",
      terminal: true,
    });
  }
  const ready = pUsdReceipts.filter((receipt) => receipt.status === "ready");
  if (ready.length > 0) {
    return projection({
      assetSymbol: "pUSD",
      context: input.context,
      receipts: ready,
      state: "ready",
      terminal: true,
    });
  }
  // A context whose target picker was superseded or never selected has not
  // disclosed financial data and has no registered progress card. Do not
  // create an unsolicited late expiry/cancellation delivery for it.
  if (!input.consent) return null;
  if (input.context.cancelledAt || input.session.status === "cancelled") {
    return projection({
      assetSymbol: "pUSD",
      context: input.context,
      receipts: [],
      state: "cancelled",
      terminal: true,
    });
  }
  if (
    input.session.status === "expired" ||
    new Date(input.context.expiresAt).getTime() <= now.getTime()
  ) {
    return projection({
      assetSymbol: "pUSD",
      context: input.context,
      receipts: [],
      state: "expired",
      terminal: true,
    });
  }
  if (pUsdReceipts.length > 0) {
    return projection({
      assetSymbol: "pUSD",
      context: input.context,
      receipts: pUsdReceipts,
      state: "funds_received",
      terminal: false,
    });
  }
  const consentedTarget = input.session.receiveTargets.find(
    (target) =>
      target.receiveTargetId === input.consent?.receiveTargetId &&
      target.acceptedAssets.some((accepted) =>
        sameAsset(accepted.asset, input.consent?.asset ?? accepted.asset),
      ),
  );
  return projection({
    assetSymbol: "pUSD",
    context: input.context,
    receipts: [],
    state: "waiting_for_transfer",
    terminal: false,
    receiveAddress: consentedTarget?.destinationAddress ?? null,
  });
}

export function telegramFundingProgressFingerprint(
  projectionValue: TelegramFundingProgressProjection,
): string {
  return canonicalJsonHash(projectionValue);
}

export function parseTelegramFundingProgressProjection(
  value: unknown,
): TelegramFundingProgressProjection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<TelegramFundingProgressProjection>;
  if (
    record.version !== 1 ||
    typeof record.fundingContextId !== "string" ||
    ![
      "waiting_for_transfer",
      "funds_received",
      "ready",
      "expired",
      "cancelled",
      "needs_attention",
    ].includes(String(record.state)) ||
    typeof record.terminal !== "boolean" ||
    (record.assetSymbol !== "pUSD" && record.assetSymbol !== "USDC.e") ||
    record.networkLabel !== "Polygon" ||
    record.decimals !== 6 ||
    (record.rawAmount !== null && typeof record.rawAmount !== "string") ||
    (record.receiveAddress !== null &&
      typeof record.receiveAddress !== "string") ||
    typeof record.expiresAt !== "string" ||
    (record.observedAt !== null && typeof record.observedAt !== "string")
  ) {
    return null;
  }
  return record as TelegramFundingProgressProjection;
}
