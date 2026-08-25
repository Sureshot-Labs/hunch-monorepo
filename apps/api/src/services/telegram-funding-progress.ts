import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import { rawForUsdCeil } from "../account-value/decimal.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import {
  parseFundingReceiveReviewContinuation,
  type FundingReceiveReceipt,
  type FundingReceiveSession,
} from "../funding/domain/types.js";
import {
  parseTelegramFundingAutomationPolicyV2,
  parseTelegramRelayEvmAutomationPolicyV3,
} from "../funding/execution/telegram-funding-automation-policy.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../funding/persistence/canonical.js";
import type {
  TelegramFundingProgressProjection,
  TelegramFundingReceiptBreakdown,
  TelegramFundingSourceReceiptState,
} from "./telegram-funding-contracts.js";
import type {
  TelegramFundingConsent,
  TelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";
import {
  isTelegramSolanaRetainedFundingMode,
  parseTelegramFundingRoutePresentation,
  resolveTelegramFundingConsentRoute,
  type TelegramFundingRoute,
  type TelegramFundingRoutePresentation,
} from "./telegram-funding-route.js";

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

function sumRawOrZero(receipts: readonly FundingReceiveReceipt[]): string {
  return sumRaw(receipts) ?? "0";
}

function sourceReceiptState(
  receipt: FundingReceiveReceipt,
  automaticConversionConsented: boolean,
): TelegramFundingSourceReceiptState {
  switch (receipt.status) {
    case "observed":
      return receipt.handling === "automatic_conversion" &&
        automaticConversionConsented
        ? "queued"
        : "needs_attention";
    case "routing":
      return "converting";
    case "ready":
      return "ready";
    case "review_required":
    case "recovery_required":
      return "needs_attention";
  }
}

function buildReceiptBreakdown(input: {
  automaticConversionConsented: boolean;
  destinationReceipts: readonly FundingReceiveReceipt[];
  presentation: TelegramFundingRoutePresentation;
  route: TelegramFundingRoute;
  sourceReceipts: readonly FundingReceiveReceipt[];
}): TelegramFundingReceiptBreakdown | undefined {
  if (!input.route.automaticSourceAsset || input.sourceReceipts.length === 0) {
    return undefined;
  }
  const byState = (state: TelegramFundingSourceReceiptState) =>
    input.sourceReceipts.filter(
      (receipt) =>
        sourceReceiptState(receipt, input.automaticConversionConsented) ===
        state,
    );
  const ordered = [...input.sourceReceipts].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.receiptId.localeCompare(right.receiptId),
  );
  const transfers = ordered.slice(0, 5).map((receipt) => ({
    rawAmount: receipt.rawAmount,
    state: sourceReceiptState(receipt, input.automaticConversionConsented),
  }));
  const readyDestination = input.destinationReceipts.filter(
    (receipt) => receipt.status === "ready",
  );
  return {
    sourceAssetSymbol:
      input.presentation.automaticSourceAssetSymbol ??
      input.presentation.destinationAssetSymbol,
    sourceDecimals: input.route.automaticSourceAsset.decimals,
    totalSourceRaw: sumRawOrZero(input.sourceReceipts),
    queuedSourceRaw: sumRawOrZero(byState("queued")),
    convertingSourceRaw: sumRawOrZero(byState("converting")),
    readySourceRaw: sumRawOrZero(byState("ready")),
    attentionSourceRaw: sumRawOrZero(byState("needs_attention")),
    sourceReceiptCount: input.sourceReceipts.length,
    destinationAssetSymbol: input.presentation.destinationAssetSymbol,
    destinationDecimals: input.route.destinationAsset.decimals,
    readyDestinationRaw: sumRawOrZero(readyDestination),
    destinationReceiptCount: readyDestination.length,
    transfers,
    hiddenTransferCount: input.sourceReceipts.length - transfers.length,
  };
}

function projection(input: {
  assetSymbol: string;
  context: TelegramFundingSessionContext;
  presentation: TelegramFundingRoutePresentation;
  receipts: readonly FundingReceiveReceipt[];
  state: TelegramFundingProgressProjection["state"];
  terminal: boolean;
  receiveAddress?: string | null;
  automaticConversionEnabled?: boolean;
  automaticConversionPaused?: boolean;
  sourceAssetSymbol?: string;
  sourceRawAmount?: string | null;
  receiptBreakdown?: TelegramFundingReceiptBreakdown;
  reviewContinuation?: FundingReceiveReceipt["reviewContinuation"];
  reviewReceiptId?: string;
}): TelegramFundingProgressProjection {
  return {
    version: 2,
    fundingContextId: input.context.id,
    state: input.state,
    terminal: input.terminal,
    presentation: input.presentation,
    assetSymbol: input.assetSymbol,
    rawAmount: sumRaw(input.receipts),
    receiveAddress: input.receiveAddress ?? null,
    expiresAt: input.context.expiresAt,
    observedAt: latestObservedAt(input.receipts),
    ...(input.context.origin === "buy_return_context" &&
    input.context.initialMinimumFundingUsd
      ? { minimumFundingUsd: input.context.initialMinimumFundingUsd }
      : {}),
    ...(input.context.origin === "buy_return_context"
      ? { returnToMarketAvailable: true }
      : {}),
    ...(input.automaticConversionEnabled
      ? { automaticConversionEnabled: true }
      : {}),
    ...(input.automaticConversionPaused
      ? { automaticConversionPaused: true }
      : {}),
    ...(input.sourceAssetSymbol
      ? {
          sourceAssetSymbol: input.sourceAssetSymbol,
          sourceRawAmount: input.sourceRawAmount ?? sumRaw(input.receipts),
        }
      : {}),
    ...(input.receiptBreakdown
      ? { receiptBreakdown: input.receiptBreakdown }
      : {}),
    ...(input.reviewContinuation
      ? { reviewContinuation: input.reviewContinuation }
      : {}),
    ...(input.reviewReceiptId
      ? { reviewReceiptId: input.reviewReceiptId }
      : {}),
  };
}

function frozenPresentation(
  consent: TelegramFundingConsent,
): TelegramFundingRoutePresentation | null {
  return parseTelegramFundingRoutePresentation(
    consent.policySnapshot.presentation,
  );
}

function receiptSymbol(
  receipt: FundingReceiveReceipt | undefined,
  route: TelegramFundingRoute,
): string {
  if (!receipt) return route.presentation.destinationAssetSymbol;
  if (sameAsset(receipt.asset, route.destinationAsset)) {
    return route.presentation.destinationAssetSymbol;
  }
  if (
    route.automaticSourceAsset &&
    sameAsset(receipt.asset, route.automaticSourceAsset)
  ) {
    return (
      route.presentation.automaticSourceAssetSymbol ??
      route.presentation.destinationAssetSymbol
    );
  }
  return "Multiple assets";
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
  if (!input.consent) return null;
  const route = resolveTelegramFundingConsentRoute(input.consent);
  const presentation = route?.presentation ?? frozenPresentation(input.consent);
  if (!route || !presentation) {
    return presentation
      ? projection({
          assetSymbol: presentation.destinationAssetSymbol,
          context: input.context,
          presentation,
          receipts: [],
          state: "needs_attention",
          terminal: true,
        })
      : null;
  }
  const sourceReceipts = route.automaticSourceAsset
    ? input.receipts.filter((receipt) =>
        sameAsset(
          receipt.asset,
          route.automaticSourceAsset as NonNullable<
            typeof route.automaticSourceAsset
          >,
        ),
      )
    : [];
  const destinationReceipts = input.receipts.filter((receipt) =>
    sameAsset(receipt.asset, route.destinationAsset),
  );
  const unsupportedReceipts = input.receipts.filter(
    (receipt) =>
      !receipt.reviewContinuation &&
      !sameAsset(receipt.asset, route.destinationAsset) &&
      (!route.automaticSourceAsset ||
        !sameAsset(receipt.asset, route.automaticSourceAsset)),
  );
  const recoveryReceipts = input.receipts.filter(
    (receipt) => receipt.status === "recovery_required",
  );
  const reviewReceipts = input.receipts.filter(
    (receipt) =>
      receipt.status === "review_required" && receipt.reviewContinuation,
  );
  const automaticConversionConsented =
    input.consent.automationEnabled === true &&
    route.automaticSourceAsset != null &&
    (parseTelegramFundingAutomationPolicyV2(input.consent.policySnapshot) !=
      null ||
      parseTelegramRelayEvmAutomationPolicyV3(input.consent.policySnapshot) !=
        null);
  const automaticConversionMode =
    input.automaticConversionMode ??
    (input.automaticConversionAvailable === true
      ? "available"
      : input.automaticConversionAvailable === false
        ? "soft_paused"
        : undefined);
  const receiptBreakdown = buildReceiptBreakdown({
    automaticConversionConsented,
    destinationReceipts,
    presentation,
    route,
    sourceReceipts,
  });
  const convertingSource = sourceReceipts.filter(
    (receipt) => receipt.status === "routing",
  );
  const afterBroadcastBoundaryReceiptIds = new Set(
    input.afterBroadcastBoundaryReceiptIds ?? [],
  );
  const afterBroadcastBoundary = convertingSource.some((receipt) =>
    afterBroadcastBoundaryReceiptIds.has(receipt.receiptId),
  );
  if (unsupportedReceipts.length > 0) {
    const unsupportedSymbols = new Set(
      unsupportedReceipts
        .map((receipt) => resolveKnownAccountAssetSymbol(receipt.asset))
        .filter((symbol) => symbol != null),
    );
    return projection({
      assetSymbol:
        unsupportedSymbols.size === 1
          ? ([...unsupportedSymbols][0] ?? "Multiple assets")
          : "Multiple assets",
      context: input.context,
      presentation,
      receipts: unsupportedReceipts,
      state: "needs_attention",
      terminal: true,
      receiptBreakdown,
    });
  }
  const reviewReceipt = [...reviewReceipts].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.receiptId.localeCompare(right.receiptId),
  )[0];
  if (reviewReceipt?.reviewContinuation) {
    return projection({
      assetSymbol:
        resolveKnownAccountAssetSymbol(reviewReceipt.asset) ??
        presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: [reviewReceipt],
      reviewContinuation: reviewReceipt.reviewContinuation,
      reviewReceiptId: reviewReceipt.receiptId,
      state: "needs_attention",
      terminal: false,
    });
  }
  const attentionSource = sourceReceipts.filter(
    (receipt) =>
      receipt.status === "review_required" ||
      (receipt.status !== "ready" &&
        receipt.status !== "recovery_required" &&
        receipt.status !== "routing" &&
        (receipt.handling !== "automatic_conversion" ||
          !automaticConversionConsented)),
  );
  if (!afterBroadcastBoundary && attentionSource.length > 0) {
    return projection({
      assetSymbol:
        presentation.automaticSourceAssetSymbol ??
        presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: attentionSource,
      state: "needs_attention",
      terminal: true,
      receiptBreakdown,
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
    const recoverySymbol = receiptSymbol(
      homogeneousRecovery[0] ?? destinationReceipts[0],
      route,
    );
    return projection({
      assetSymbol:
        recoveryReceipts.length > 0 && homogeneousRecovery.length === 0
          ? "Multiple assets"
          : recoverySymbol,
      context: input.context,
      presentation,
      receipts:
        recoveryReceipts.length > 0 ? homogeneousRecovery : destinationReceipts,
      state: "needs_attention",
      terminal: true,
      receiptBreakdown,
    });
  }
  if (convertingSource.length > 0) {
    const hardInvalid =
      !afterBroadcastBoundary && automaticConversionMode === "hard_invalid";
    const softPaused =
      !afterBroadcastBoundary && automaticConversionMode === "soft_paused";
    return projection({
      assetSymbol:
        presentation.automaticSourceAssetSymbol ??
        presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: convertingSource,
      state: hardInvalid
        ? "needs_attention"
        : softPaused
          ? "waiting_for_routing"
          : "converting",
      terminal: hardInvalid,
      automaticConversionEnabled: !hardInvalid && !softPaused,
      receiptBreakdown,
    });
  }
  const detectedSource = sourceReceipts.filter(
    (receipt) =>
      receipt.status === "observed" &&
      receipt.handling === "automatic_conversion" &&
      automaticConversionConsented,
  );
  if (detectedSource.length > 0) {
    if (automaticConversionMode === "hard_invalid") {
      return projection({
        assetSymbol:
          presentation.automaticSourceAssetSymbol ??
          presentation.destinationAssetSymbol,
        context: input.context,
        presentation,
        receipts: detectedSource,
        state: "needs_attention",
        terminal: true,
        receiptBreakdown,
      });
    }
    return projection({
      assetSymbol:
        presentation.automaticSourceAssetSymbol ??
        presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: detectedSource,
      state:
        automaticConversionMode === "soft_paused"
          ? "waiting_for_routing"
          : "funds_received",
      terminal: false,
      automaticConversionEnabled: automaticConversionMode !== "soft_paused",
      receiptBreakdown,
    });
  }
  const readyDestination = destinationReceipts.filter(
    (receipt) => receipt.status === "ready",
  );
  const allSourceReady =
    sourceReceipts.length > 0 &&
    sourceReceipts.every((receipt) => receipt.status === "ready");
  if (allSourceReady && isTelegramSolanaRetainedFundingMode(route.mode)) {
    // A canonical SOL receipt proves only that the owned Solana wallet now
    // holds the source asset. It is terminal for generic Add Funds, but it is
    // never venue-readiness evidence for a Buy. The API decorator may now
    // build the ordinary client-executed funding plan from this fresh source.
    return projection({
      assetSymbol:
        presentation.automaticSourceAssetSymbol ??
        presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: sourceReceipts,
      state:
        input.context.origin === "buy_return_context"
          ? "funds_received"
          : "ready",
      terminal: input.context.origin !== "buy_return_context",
    });
  }
  if (readyDestination.length > 0 || allSourceReady) {
    const readyReceipts =
      readyDestination.length > 0 ? readyDestination : sourceReceipts;
    const minimumFundingRaw =
      input.context.origin === "buy_return_context" &&
      input.context.initialMinimumFundingUsd
        ? rawForUsdCeil({
            usd: input.context.initialMinimumFundingUsd,
            decimals: route.destinationAsset.decimals,
            unitPriceUsd: "1",
          })
        : null;
    if (
      minimumFundingRaw !== null &&
      BigInt(sumRawOrZero(readyReceipts)) < BigInt(minimumFundingRaw)
    ) {
      return projection({
        assetSymbol: presentation.destinationAssetSymbol,
        context: input.context,
        presentation,
        receipts: readyReceipts,
        state: "funds_received",
        terminal: false,
        automaticConversionEnabled: automaticConversionConsented,
        receiptBreakdown,
        ...(sourceReceipts.length > 0 && presentation.automaticSourceAssetSymbol
          ? {
              sourceAssetSymbol: presentation.automaticSourceAssetSymbol,
              sourceRawAmount: sumRaw(sourceReceipts),
            }
          : {}),
      });
    }
    return projection({
      assetSymbol: presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      // Destination evidence is authoritative when present. The source-only
      // fallback preserves the established full-receipt conversion contract,
      // where `ready` means the exact conversion postcondition was proven.
      receipts: readyReceipts,
      state: "ready",
      terminal: true,
      automaticConversionEnabled: automaticConversionConsented,
      receiptBreakdown,
      ...(sourceReceipts.length > 0 && presentation.automaticSourceAssetSymbol
        ? {
            sourceAssetSymbol: presentation.automaticSourceAssetSymbol,
            sourceRawAmount: sumRaw(sourceReceipts),
          }
        : {}),
    });
  }
  if (input.context.cancelledAt || input.session.status === "cancelled") {
    return projection({
      assetSymbol: presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
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
      assetSymbol: presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: [],
      state: "expired",
      terminal: true,
    });
  }
  if (destinationReceipts.length > 0) {
    return projection({
      assetSymbol: presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: destinationReceipts,
      state: "funds_received",
      terminal: false,
      receiptBreakdown,
    });
  }
  if (
    automaticConversionConsented &&
    automaticConversionMode === "hard_invalid"
  ) {
    return projection({
      assetSymbol: presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: [],
      state: "needs_attention",
      terminal: true,
      receiptBreakdown,
    });
  }
  const consentedTarget = input.session.receiveTargets.find(
    (target) =>
      target.receiveTargetId === input.consent?.receiveTargetId &&
      target.acceptedAssets.some(
        (accepted) =>
          (accepted.handling === "direct" &&
            sameAsset(accepted.asset, route.destinationAsset)) ||
          (accepted.handling === "automatic_conversion" &&
            route.automaticSourceAsset != null &&
            sameAsset(accepted.asset, route.automaticSourceAsset)),
      ),
  );
  return projection({
    assetSymbol: presentation.destinationAssetSymbol,
    context: input.context,
    presentation,
    receipts: [],
    state: "waiting_for_transfer",
    terminal: false,
    receiveAddress: consentedTarget?.destinationAddress ?? null,
    automaticConversionEnabled: automaticConversionConsented,
    automaticConversionPaused:
      automaticConversionConsented && automaticConversionMode === "soft_paused",
  });
}

export function projectTelegramFundingUnavailable(
  context: TelegramFundingSessionContext,
  presentation: TelegramFundingRoutePresentation,
): TelegramFundingProgressProjection {
  return projection({
    assetSymbol: presentation.destinationAssetSymbol,
    context,
    presentation,
    receipts: [],
    state: "unavailable",
    terminal: true,
  });
}

export function projectTelegramFundingCancelled(
  context: TelegramFundingSessionContext,
  presentation: TelegramFundingRoutePresentation,
): TelegramFundingProgressProjection {
  return projection({
    assetSymbol: presentation.destinationAssetSymbol,
    context,
    presentation,
    receipts: [],
    state: "cancelled",
    terminal: true,
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
  const record = value as Record<string, unknown>;
  const presentation = parseTelegramFundingRoutePresentation(
    record.presentation,
  );
  const state = record.state;
  const assetSymbol =
    typeof record.assetSymbol === "string" ? record.assetSymbol.trim() : "";
  const sourceAssetSymbol =
    typeof record.sourceAssetSymbol === "string"
      ? record.sourceAssetSymbol.trim()
      : null;
  const canonicalTimestamp = (timestamp: unknown): timestamp is string => {
    if (typeof timestamp !== "string") return false;
    const parsed = new Date(timestamp);
    return (
      !Number.isNaN(parsed.getTime()) && parsed.toISOString() === timestamp
    );
  };
  const canonicalRaw = (raw: unknown): raw is string =>
    typeof raw === "string" && /^(0|[1-9][0-9]*)$/u.test(raw);
  const minimumFundingUsd = record.minimumFundingUsd;
  const hasMinimumFundingUsd = minimumFundingUsd !== undefined;
  if (
    hasMinimumFundingUsd &&
    (typeof minimumFundingUsd !== "string" ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(minimumFundingUsd) ||
      !/[1-9]/u.test(minimumFundingUsd))
  ) {
    return null;
  }
  const breakdownValue = record.receiptBreakdown;
  let receiptBreakdown: TelegramFundingReceiptBreakdown | null = null;
  if (breakdownValue !== undefined) {
    if (
      !breakdownValue ||
      typeof breakdownValue !== "object" ||
      Array.isArray(breakdownValue)
    ) {
      return null;
    }
    const breakdownRecord = breakdownValue as Record<string, unknown>;
    const sourceAsset =
      typeof breakdownRecord.sourceAssetSymbol === "string"
        ? breakdownRecord.sourceAssetSymbol.trim()
        : "";
    const destinationAsset =
      typeof breakdownRecord.destinationAssetSymbol === "string"
        ? breakdownRecord.destinationAssetSymbol.trim()
        : "";
    const sourceDecimals = breakdownRecord.sourceDecimals;
    const destinationDecimals = breakdownRecord.destinationDecimals;
    const sourceReceiptCount = breakdownRecord.sourceReceiptCount;
    const destinationReceiptCount = breakdownRecord.destinationReceiptCount;
    const hiddenTransferCount = breakdownRecord.hiddenTransferCount;
    const transfersValue = breakdownRecord.transfers;
    const rawFields = [
      breakdownRecord.totalSourceRaw,
      breakdownRecord.queuedSourceRaw,
      breakdownRecord.convertingSourceRaw,
      breakdownRecord.readySourceRaw,
      breakdownRecord.attentionSourceRaw,
      breakdownRecord.readyDestinationRaw,
    ];
    if (
      sourceAsset.length === 0 ||
      sourceAsset.length > 64 ||
      sourceAsset !== presentation?.automaticSourceAssetSymbol ||
      destinationAsset.length === 0 ||
      destinationAsset.length > 64 ||
      destinationAsset !== presentation?.destinationAssetSymbol ||
      !Number.isInteger(sourceDecimals) ||
      Number(sourceDecimals) < 0 ||
      Number(sourceDecimals) > 36 ||
      !Number.isInteger(destinationDecimals) ||
      Number(destinationDecimals) < 0 ||
      Number(destinationDecimals) > 36 ||
      !Number.isSafeInteger(sourceReceiptCount) ||
      Number(sourceReceiptCount) < 1 ||
      !Number.isSafeInteger(destinationReceiptCount) ||
      Number(destinationReceiptCount) < 0 ||
      !Number.isSafeInteger(hiddenTransferCount) ||
      Number(hiddenTransferCount) < 0 ||
      !rawFields.every(canonicalRaw) ||
      !Array.isArray(transfersValue) ||
      transfersValue.length > 5 ||
      Number(sourceReceiptCount) !==
        transfersValue.length + Number(hiddenTransferCount)
    ) {
      return null;
    }
    const transfers = transfersValue.map((transfer) => {
      if (
        !transfer ||
        typeof transfer !== "object" ||
        Array.isArray(transfer)
      ) {
        return null;
      }
      const transferRecord = transfer as Record<string, unknown>;
      return canonicalRaw(transferRecord.rawAmount) &&
        ["queued", "converting", "ready", "needs_attention"].includes(
          String(transferRecord.state),
        )
        ? {
            rawAmount: transferRecord.rawAmount,
            state: transferRecord.state as TelegramFundingSourceReceiptState,
          }
        : null;
    });
    if (transfers.some((transfer) => transfer === null)) return null;
    const [
      totalSourceRaw,
      queuedSourceRaw,
      convertingSourceRaw,
      readySourceRaw,
      attentionSourceRaw,
      readyDestinationRaw,
    ] = rawFields as [string, string, string, string, string, string];
    if (
      BigInt(totalSourceRaw) !==
      BigInt(queuedSourceRaw) +
        BigInt(convertingSourceRaw) +
        BigInt(readySourceRaw) +
        BigInt(attentionSourceRaw)
    ) {
      return null;
    }
    receiptBreakdown = {
      sourceAssetSymbol: sourceAsset,
      sourceDecimals: Number(sourceDecimals),
      totalSourceRaw,
      queuedSourceRaw,
      convertingSourceRaw,
      readySourceRaw,
      attentionSourceRaw,
      sourceReceiptCount: Number(sourceReceiptCount),
      destinationAssetSymbol: destinationAsset,
      destinationDecimals: Number(destinationDecimals),
      readyDestinationRaw,
      destinationReceiptCount: Number(destinationReceiptCount),
      transfers: transfers as TelegramFundingReceiptBreakdown["transfers"],
      hiddenTransferCount: Number(hiddenTransferCount),
    };
  }
  if (
    record.version !== 2 ||
    typeof record.fundingContextId !== "string" ||
    ![
      "waiting_for_transfer",
      "funds_received",
      "waiting_for_routing",
      "converting",
      "ready",
      "expired",
      "cancelled",
      "unavailable",
      "needs_attention",
    ].includes(String(state)) ||
    typeof record.terminal !== "boolean" ||
    !presentation ||
    assetSymbol.length === 0 ||
    assetSymbol.length > 64 ||
    (record.rawAmount !== null && !canonicalRaw(record.rawAmount)) ||
    (record.receiveAddress !== null &&
      (typeof record.receiveAddress !== "string" ||
        record.receiveAddress.trim().length === 0)) ||
    !canonicalTimestamp(record.expiresAt) ||
    (record.observedAt !== null && !canonicalTimestamp(record.observedAt))
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
    record.automaticConversionPaused !== undefined &&
    typeof record.automaticConversionPaused !== "boolean"
  ) {
    return null;
  }
  if (
    record.returnToMarketAvailable !== undefined &&
    typeof record.returnToMarketAvailable !== "boolean"
  ) {
    return null;
  }
  if (
    record.sourceAssetSymbol !== undefined &&
    (typeof record.sourceAssetSymbol !== "string" ||
      record.sourceAssetSymbol.trim().length === 0 ||
      record.sourceAssetSymbol.length > 64)
  ) {
    return null;
  }
  if (
    record.sourceRawAmount !== undefined &&
    record.sourceRawAmount !== null &&
    !canonicalRaw(record.sourceRawAmount)
  ) {
    return null;
  }
  const reviewValue = record.reviewContinuation;
  const review = parseFundingReceiveReviewContinuation(reviewValue);
  const reviewReceiptId = record.reviewReceiptId;
  if (
    reviewValue !== undefined &&
    (!review || presentation.reviewAction?.label !== review.label)
  ) {
    return null;
  }
  const hasSourceSymbol = record.sourceAssetSymbol !== undefined;
  const hasSourceAmount = record.sourceRawAmount !== undefined;
  const reviewPending = review !== null;
  const hasReviewReceiptId = reviewReceiptId !== undefined;
  const stateIsAlwaysTerminal = [
    "ready",
    "expired",
    "cancelled",
    "unavailable",
  ].includes(String(state));
  const stateIsAlwaysNonterminal = [
    "waiting_for_transfer",
    "funds_received",
    "waiting_for_routing",
    "converting",
  ].includes(String(state));
  if (
    hasSourceSymbol !== hasSourceAmount ||
    (hasSourceAmount && record.sourceRawAmount === null) ||
    (hasSourceSymbol && state !== "ready") ||
    reviewPending !== hasReviewReceiptId ||
    (hasReviewReceiptId &&
      (typeof reviewReceiptId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          reviewReceiptId,
        ))) ||
    (reviewPending &&
      (state !== "needs_attention" || record.terminal !== false)) ||
    (!reviewPending &&
      state === "needs_attention" &&
      record.terminal !== true) ||
    (stateIsAlwaysTerminal && record.terminal !== true) ||
    (stateIsAlwaysNonterminal && record.terminal !== false) ||
    (record.receiveAddress !== null && state !== "waiting_for_transfer") ||
    (record.automaticConversionPaused === true &&
      record.automaticConversionEnabled !== true)
  ) {
    return null;
  }
  const normalized: TelegramFundingProgressProjection = {
    version: 2,
    fundingContextId: record.fundingContextId,
    state: state as TelegramFundingProgressProjection["state"],
    terminal: record.terminal,
    presentation,
    assetSymbol,
    rawAmount: record.rawAmount as string | null,
    receiveAddress: record.receiveAddress as string | null,
    expiresAt: record.expiresAt,
    observedAt: record.observedAt as string | null,
    ...(hasMinimumFundingUsd
      ? { minimumFundingUsd: minimumFundingUsd as string }
      : {}),
    ...(record.automaticConversionEnabled === true
      ? { automaticConversionEnabled: true }
      : {}),
    ...(record.automaticConversionPaused === true
      ? { automaticConversionPaused: true }
      : {}),
    ...(record.returnToMarketAvailable === true
      ? { returnToMarketAvailable: true }
      : {}),
    ...(hasSourceSymbol
      ? {
          sourceAssetSymbol: sourceAssetSymbol as string,
          sourceRawAmount: record.sourceRawAmount as string,
        }
      : {}),
    ...(receiptBreakdown ? { receiptBreakdown } : {}),
    ...(review ? { reviewContinuation: review } : {}),
    ...(review && typeof reviewReceiptId === "string"
      ? { reviewReceiptId }
      : {}),
  };
  // Rebuilding and comparing rejects unknown keys, explicit false optionals,
  // whitespace aliases, and non-canonical nested presentation/review data.
  try {
    return canonicalJsonEqual(value, normalized) ? normalized : null;
  } catch {
    return null;
  }
}

export type TelegramFundingRetainedTerminal =
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      kind: "valid";
      projection: TelegramFundingProgressProjection;
    }>
  | Readonly<{ kind: "invalid" }>;

export function resolveTelegramFundingRetainedTerminal(
  value: unknown,
  contextId: string,
): TelegramFundingRetainedTerminal {
  if (value === null) return { kind: "absent" };
  const projectionValue = parseTelegramFundingProgressProjection(value);
  return projectionValue?.fundingContextId === contextId &&
    projectionValue.terminal &&
    projectionValue.receiveAddress === null
    ? { kind: "valid", projection: projectionValue }
    : { kind: "invalid" };
}

export function isTelegramFundingReadyTerminalProjection(
  value: unknown,
  contextId: string,
): boolean {
  const retained = resolveTelegramFundingRetainedTerminal(value, contextId);
  return retained.kind === "valid" && retained.projection.state === "ready";
}
