import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";
import { sameAsset } from "../funding/domain/asset-identity.js";
import {
  parseFundingReceiveReviewContinuation,
  type FundingReceiveReceipt,
  type FundingReceiveSession,
} from "../funding/domain/types.js";
import { parseTelegramFundingAutomationPolicyV2 } from "../funding/execution/telegram-funding-automation-policy.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../funding/persistence/canonical.js";
import type { TelegramFundingProgressProjection } from "./telegram-funding-contracts.js";
import type {
  TelegramFundingConsent,
  TelegramFundingSessionContext,
} from "./telegram-funding-sessions.js";
import {
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
    parseTelegramFundingAutomationPolicyV2(input.consent.policySnapshot) !=
      null;
  const automaticConversionMode =
    input.automaticConversionMode ??
    (input.automaticConversionAvailable === true
      ? "available"
      : input.automaticConversionAvailable === false
        ? "soft_paused"
        : undefined);
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
    });
  }
  const ready = input.receipts.filter((receipt) => receipt.status === "ready");
  if (ready.length > 0) {
    const allSource =
      route.automaticSourceAsset != null &&
      ready.every((receipt) =>
        sameAsset(
          receipt.asset,
          route.automaticSourceAsset as NonNullable<
            typeof route.automaticSourceAsset
          >,
        ),
      );
    return projection({
      assetSymbol: presentation.destinationAssetSymbol,
      context: input.context,
      presentation,
      receipts: ready,
      state: "ready",
      terminal: true,
      automaticConversionEnabled: allSource || automaticConversionConsented,
      ...(allSource && presentation.automaticSourceAssetSymbol
        ? {
            sourceAssetSymbol: presentation.automaticSourceAssetSymbol,
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
    ...(record.automaticConversionEnabled === true
      ? { automaticConversionEnabled: true }
      : {}),
    ...(record.automaticConversionPaused === true
      ? { automaticConversionPaused: true }
      : {}),
    ...(hasSourceSymbol
      ? {
          sourceAssetSymbol: sourceAssetSymbol as string,
          sourceRawAmount: record.sourceRawAmount as string,
        }
      : {}),
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
