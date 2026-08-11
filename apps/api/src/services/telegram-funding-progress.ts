import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import type {
  FundingReceiveReceipt,
  FundingReceiveSession,
} from "../funding/domain/types.js";
import { parseTelegramFundingAutomationPolicyV2 } from "../funding/execution/telegram-funding-automation-policy.js";
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
  assetSymbol: "pUSD" | "USDC.e" | "Multiple assets";
  context: TelegramFundingSessionContext;
  receipts: readonly FundingReceiveReceipt[];
  state: TelegramFundingProgressProjection["state"];
  terminal: boolean;
  receiveAddress?: string | null;
  automaticConversionEnabled?: boolean;
  sourceAssetSymbol?: "USDC.e";
  sourceRawAmount?: string | null;
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
    ...(input.automaticConversionEnabled
      ? { automaticConversionEnabled: true }
      : {}),
    ...(input.sourceAssetSymbol
      ? {
          sourceAssetSymbol: input.sourceAssetSymbol,
          sourceRawAmount: input.sourceRawAmount ?? sumRaw(input.receipts),
        }
      : {}),
  };
}

export function projectTelegramFundingProgress(input: {
  automaticConversionAvailable?: boolean;
  automaticConversionMode?: "available" | "soft_paused" | "hard_invalid";
  afterBroadcastBoundaryReceiptIds?: readonly string[];
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
  const automaticConversionConsented =
    input.consent?.automationEnabled === true &&
    parseTelegramFundingAutomationPolicyV2(input.consent.policySnapshot) !=
      null;
  const automaticConversionEnabled =
    automaticConversionConsented && input.automaticConversionAvailable === true;
  const automaticConversionMode =
    input.automaticConversionMode ??
    (input.automaticConversionAvailable === true
      ? "available"
      : input.automaticConversionAvailable === false
        ? "soft_paused"
        : undefined);
  const convertingUsdce = usdceReceipts.filter(
    (receipt) => receipt.status === "routing",
  );
  const afterBroadcastBoundaryReceiptIds = new Set(
    input.afterBroadcastBoundaryReceiptIds ?? [],
  );
  const afterBroadcastBoundary = convertingUsdce.some((receipt) =>
    afterBroadcastBoundaryReceiptIds.has(receipt.receiptId),
  );
  const attentionUsdce = usdceReceipts.filter(
    (receipt) =>
      receipt.status === "review_required" ||
      (receipt.status !== "ready" &&
        receipt.status !== "recovery_required" &&
        receipt.status !== "routing" &&
        (receipt.handling !== "automatic_conversion" ||
          !automaticConversionConsented)),
  );
  if (!afterBroadcastBoundary && attentionUsdce.length > 0) {
    return projection({
      assetSymbol: "USDC.e",
      context: input.context,
      receipts: attentionUsdce,
      state: "needs_attention",
      terminal: true,
    });
  }
  if (
    !afterBroadcastBoundary &&
    (recoveryReceipts.length > 0 ||
      input.session.status === "recovery_required")
  ) {
    const firstRecoveryAsset = recoveryReceipts[0]?.asset;
    const homogeneousRecovery =
      firstRecoveryAsset != null &&
      recoveryReceipts.every((receipt) =>
        sameAsset(receipt.asset, firstRecoveryAsset),
      )
        ? recoveryReceipts
        : [];
    const recoverySymbol = resolveKnownAccountAssetSymbol(
      homogeneousRecovery[0]?.asset ?? pUsdReceipts[0]?.asset,
    );
    return projection({
      assetSymbol:
        recoveryReceipts.length > 0 && homogeneousRecovery.length === 0
          ? "Multiple assets"
          : recoverySymbol === "USDC.e"
            ? "USDC.e"
            : "pUSD",
      context: input.context,
      receipts:
        recoveryReceipts.length > 0 ? homogeneousRecovery : pUsdReceipts,
      state: "needs_attention",
      terminal: true,
    });
  }
  if (convertingUsdce.length > 0) {
    const hardInvalid =
      !afterBroadcastBoundary && automaticConversionMode === "hard_invalid";
    const softPaused =
      !afterBroadcastBoundary && automaticConversionMode === "soft_paused";
    return projection({
      assetSymbol: "USDC.e",
      context: input.context,
      receipts: convertingUsdce,
      state: hardInvalid
        ? "needs_attention"
        : softPaused
          ? "waiting_for_routing"
          : "converting",
      terminal: hardInvalid,
      automaticConversionEnabled: !hardInvalid && !softPaused,
    });
  }
  const detectedUsdce = usdceReceipts.filter(
    (receipt) =>
      receipt.status === "observed" &&
      receipt.handling === "automatic_conversion" &&
      automaticConversionConsented,
  );
  if (detectedUsdce.length > 0) {
    if (automaticConversionMode === "hard_invalid") {
      return projection({
        assetSymbol: "USDC.e",
        context: input.context,
        receipts: detectedUsdce,
        state: "needs_attention",
        terminal: true,
      });
    }
    return projection({
      assetSymbol: "USDC.e",
      context: input.context,
      receipts: detectedUsdce,
      state:
        automaticConversionMode === "soft_paused"
          ? "waiting_for_routing"
          : "funds_received",
      terminal: false,
      automaticConversionEnabled: automaticConversionMode !== "soft_paused",
    });
  }
  const ready = input.receipts.filter((receipt) => receipt.status === "ready");
  if (ready.length > 0) {
    const allUsdce = ready.every(
      (receipt) => resolveKnownAccountAssetSymbol(receipt.asset) === "USDC.e",
    );
    return projection({
      assetSymbol: "pUSD",
      context: input.context,
      receipts: ready,
      state: "ready",
      terminal: true,
      automaticConversionEnabled: allUsdce || automaticConversionConsented,
      ...(allUsdce
        ? {
            sourceAssetSymbol: "USDC.e" as const,
          }
        : {}),
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
    automaticConversionEnabled,
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
      "waiting_for_routing",
      "converting",
      "ready",
      "expired",
      "cancelled",
      "needs_attention",
    ].includes(String(record.state)) ||
    typeof record.terminal !== "boolean" ||
    (record.assetSymbol !== "pUSD" &&
      record.assetSymbol !== "USDC.e" &&
      record.assetSymbol !== "Multiple assets") ||
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
  if (
    record.automaticConversionEnabled !== undefined &&
    typeof record.automaticConversionEnabled !== "boolean"
  ) {
    return null;
  }
  if (
    record.sourceAssetSymbol !== undefined &&
    record.sourceAssetSymbol !== "USDC.e"
  ) {
    return null;
  }
  if (
    record.sourceRawAmount !== undefined &&
    record.sourceRawAmount !== null &&
    typeof record.sourceRawAmount !== "string"
  ) {
    return null;
  }
  return record as TelegramFundingProgressProjection;
}
