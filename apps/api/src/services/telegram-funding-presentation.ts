import {
  escapeTelegramMarkdownV2,
  formatTelegramBoldMarkdownV2,
  formatTelegramCalloutMarkdownV2,
  formatTelegramCodeMarkdownV2,
  formatTelegramFieldMarkdownV2,
  joinTelegramMarkdownV2Lines,
} from "./telegram-bot-trading-presentation.js";
import {
  telegramFundingCallbackData,
  type TelegramFundingMessage,
  type TelegramFundingProgressProjection,
} from "./telegram-funding-contracts.js";
import {
  telegramCustomEmojiMarkdownV2ForAsset,
  telegramCustomEmojiMarkdownV2ForNetwork,
  telegramCustomEmojiMarkdownV2ForVenue,
} from "./telegram-custom-emoji.js";
import { FUNDING_RECEIVE_SESSION_TTL_HOURS } from "../funding/receive/receive-session-constants.js";
import QRCode from "qrcode";
import {
  type TelegramFundingRoutePresentation,
  type TelegramFundingTargetCapability,
} from "./telegram-funding-route.js";
import type { FundingQuoteSummary, Money } from "../funding/domain/types.js";
import { resolveKnownAccountAssetSymbol } from "../account-value/known-asset-catalog.js";

function expiryLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC")
    : value;
}

function receiveWindowFields(expiresAt: string): string[] {
  return [
    formatTelegramFieldMarkdownV2(
      "Receive window",
      `${FUNDING_RECEIVE_SESSION_TTL_HOURS} hours`,
    ),
    formatTelegramFieldMarkdownV2("Expires at", expiryLabel(expiresAt)),
  ];
}

function formatRawAmount(raw: string, decimals: number): string {
  if (!/^[0-9]+$/u.test(raw)) return raw;
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fraction = padded.slice(-decimals).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function fundingMoneyLabel(money: Money): string {
  return `${formatRawAmount(money.raw, money.asset.decimals)} ${
    resolveKnownAccountAssetSymbol(money.asset) ?? money.asset.assetId
  }`;
}

export function buildTelegramFundingReviewQuoteMessage(input: {
  contextId: string;
  quote: FundingQuoteSummary;
}): TelegramFundingMessage {
  const source = input.quote.sourceAmounts
    .map(({ amount }) => fundingMoneyLabel(amount))
    .join(" + ");
  const estimatedFeeUsd = input.quote.fees
    .map((fee) => fee.estimatedUsd)
    .filter((value): value is string => value != null)
    .join(" + ");
  return {
    fundingContextId: input.contextId,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: telegramFundingCallbackData({
              consentToken: input.quote.consentToken,
              kind: "confirm_conversion",
            }),
            text: "Confirm conversion",
          },
        ],
        [
          {
            callback_data: telegramFundingCallbackData({
              contextId: input.contextId,
              kind: "refresh",
            }),
            text: "Back",
          },
        ],
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          "Review this fresh quote. Nothing is converted until you confirm.",
        ),
        icon: "🔄",
        title: "Confirm conversion",
      }),
      "",
      formatTelegramFieldMarkdownV2("Convert", source),
      formatTelegramFieldMarkdownV2(
        "Minimum received",
        fundingMoneyLabel(input.quote.minimumDestination),
      ),
      formatTelegramFieldMarkdownV2(
        "Estimated fees",
        estimatedFeeUsd ? `$${estimatedFeeUsd}` : "Included in quote",
      ),
      formatTelegramFieldMarkdownV2(
        "Quote expires",
        expiryLabel(input.quote.expiresAt),
      ),
    ]),
  };
}

export function buildTelegramFundingUnavailableMessage(input?: {
  reason?: "disabled" | "expired" | "unavailable";
}): TelegramFundingMessage {
  const message =
    input?.reason === "disabled"
      ? "Telegram Receive is not enabled right now. Existing transfers continue to be monitored."
      : input?.reason === "expired"
        ? "This funding session expired. Open Add funds again for a newly verified address."
        : "A verified Polymarket receive target is temporarily unavailable. Try again later.";
  return {
    parse_mode: "MarkdownV2",
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: escapeTelegramMarkdownV2(message),
      icon: "⚠️",
      title: "Receive unavailable",
    }),
  };
}

export function buildTelegramFundingTargetMessage(input: {
  automaticConversion: boolean;
  contextId: string;
  expiresAt: string;
  presentation: TelegramFundingRoutePresentation;
}): TelegramFundingMessage {
  const acceptedAssets = input.presentation.acceptedAssetSymbols.join(" / ");
  const button =
    input.presentation.selectionButtonLabel ??
    `${acceptedAssets} on ${input.presentation.networkLabel}`;
  const settlement =
    input.presentation.settlementLabel ??
    (input.automaticConversion ? "Automatic conversion" : "Direct");
  const instructions = input.presentation.instructions ?? [];
  const venueEmoji = telegramCustomEmojiMarkdownV2ForVenue(
    input.presentation.venueId,
  );
  const networkEmoji = telegramCustomEmojiMarkdownV2ForNetwork(
    input.presentation.networkLabel,
  );
  const assetEmoji = telegramCustomEmojiMarkdownV2ForAsset(
    input.presentation.automaticSourceAssetSymbol ??
      input.presentation.destinationAssetSymbol,
  );
  return {
    fundingContextId: input.contextId,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: telegramFundingCallbackData({
              choiceToken: input.automaticConversion ? "a" : "d",
              contextId: input.contextId,
              kind: "select",
            }),
            text: button,
          },
        ],
        [
          {
            callback_data: telegramFundingCallbackData({
              contextId: input.contextId,
              kind: "cancel",
            }),
            text: "Cancel",
          },
        ],
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      `${venueEmoji ? `${venueEmoji} ` : ""}*${escapeTelegramMarkdownV2(
        `Add funds to ${input.presentation.venueLabel}`,
      )}*`,
      "",
      escapeTelegramMarkdownV2(
        "Confirm the supported receive assets before the verified address is shown.",
      ),
      "",
      `${networkEmoji ? `${networkEmoji} ` : ""}${formatTelegramFieldMarkdownV2(
        "Network",
        input.presentation.networkLabel,
      )}`,
      `${assetEmoji ? `${assetEmoji} ` : ""}${formatTelegramFieldMarkdownV2(
        "Asset",
        acceptedAssets,
      )}`,
      formatTelegramFieldMarkdownV2("Settlement", settlement),
      "",
      ...instructions.map(escapeTelegramMarkdownV2),
      ...receiveWindowFields(input.expiresAt),
    ]),
    venue: input.presentation.venueId,
  };
}

export function buildTelegramFundingTargetChoicesMessage(input: {
  contextId: string;
  expiresAt: string;
  targets: readonly TelegramFundingTargetCapability[];
}): TelegramFundingMessage {
  const targets = input.targets.filter(
    (target, index, values) =>
      values.findIndex(
        (candidate) =>
          candidate.presentation.routeKey === target.presentation.routeKey,
      ) === index,
  );
  if (targets.length === 1 && targets[0]) {
    return buildTelegramFundingTargetMessage({
      automaticConversion: targets[0].automaticSourceAsset !== null,
      contextId: input.contextId,
      expiresAt: input.expiresAt,
      presentation: targets[0].presentation,
    });
  }
  return {
    fundingContextId: input.contextId,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...targets.map((target) => [
          {
            callback_data: telegramFundingCallbackData({
              choiceToken:
                target.presentation.routeKey === "polymarket_base_usdc_relay_v1"
                  ? "b"
                  : target.automaticSourceAsset
                    ? "a"
                    : "d",
              contextId: input.contextId,
              kind: "select",
            }),
            text:
              target.presentation.selectionButtonLabel ??
              `${target.presentation.acceptedAssetSymbols.join(" / ")} on ${target.presentation.networkLabel}`,
          },
        ]),
        [
          {
            callback_data: telegramFundingCallbackData({
              contextId: input.contextId,
              kind: "cancel",
            }),
            text: "Cancel",
          },
        ],
      ],
    },
    text: joinTelegramMarkdownV2Lines([
      "*Add funds to Polymarket*",
      "",
      escapeTelegramMarkdownV2("Choose the network and asset to receive."),
      ...receiveWindowFields(input.expiresAt),
    ]),
  };
}

export function buildTelegramFundingDeliveryQueuedMessage(input: {
  contextId: string;
}): TelegramFundingMessage {
  return {
    durableFundingDeliveryRequired: true,
    fundingContextId: input.contextId,
    parse_mode: "MarkdownV2",
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: escapeTelegramMarkdownV2(
        "The verified funding card is being updated.",
      ),
      icon: "⏳",
      title: "Receive update queued",
    }),
  };
}

export function buildTelegramFundingActiveElsewhereMessage(): TelegramFundingMessage {
  return {
    parse_mode: "MarkdownV2",
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: escapeTelegramMarkdownV2(
        "A transfer is already being monitored in an earlier Deposit screen. Finish that transfer there; it remains safe and active.",
      ),
      icon: "ℹ️",
      title: "Deposit already active",
    }),
  };
}

export function buildTelegramFundingCancelledMessage(): TelegramFundingMessage {
  return {
    parse_mode: "MarkdownV2",
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: escapeTelegramMarkdownV2(
        "The funding screen is closed. A transfer already sent to the verified address will still be detected during the observation window.",
      ),
      icon: "ℹ️",
      title: "Receive cancelled",
    }),
  };
}

export function buildTelegramFundingProgressMessage(
  projection: TelegramFundingProgressProjection,
): TelegramFundingMessage {
  return buildTelegramFundingProgressMessageInternal(projection);
}

function acceptedAssetsLabel(
  projection: TelegramFundingProgressProjection,
): string {
  return projection.presentation.acceptedAssetSymbols.join(" / ");
}

function automaticSourceLabel(
  projection: TelegramFundingProgressProjection,
): string {
  return (
    projection.presentation.automaticSourceAssetSymbol ??
    projection.presentation.destinationAssetSymbol
  );
}

export async function buildTelegramFundingQrPhoto(
  projection: TelegramFundingProgressProjection,
): Promise<
  Readonly<{
    caption: string;
    filename: string;
    photo: Uint8Array;
  }>
> {
  if (!projection.receiveAddress || projection.terminal) {
    throw new Error("funding QR requires an active verified address");
  }
  const png = await QRCode.toBuffer(projection.receiveAddress, {
    errorCorrectionLevel: "M",
    margin: 4,
    type: "png",
    width: 768,
  });
  return {
    caption: joinTelegramMarkdownV2Lines([
      formatTelegramBoldMarkdownV2(
        `${projection.presentation.venueLabel} funding QR`,
      ),
      "",
      formatTelegramFieldMarkdownV2(
        "Network",
        projection.presentation.networkLabel,
      ),
      formatTelegramFieldMarkdownV2("Asset", acceptedAssetsLabel(projection)),
      escapeTelegramMarkdownV2("Scan to fill the verified receive address."),
      formatTelegramFieldMarkdownV2(
        "Expires at",
        expiryLabel(projection.expiresAt),
      ),
    ]),
    filename: `hunch-funding-${projection.fundingContextId}.png`,
    photo: new Uint8Array(png),
  };
}

function fundingProgressReplyMarkup(
  projection: TelegramFundingProgressProjection,
): TelegramFundingMessage["reply_markup"] {
  if (projection.terminal) return undefined;
  if (projection.reviewContinuation && projection.reviewReceiptId) {
    return {
      inline_keyboard: [
        [
          {
            callback_data: telegramFundingCallbackData({
              kind: "review_conversion",
              receiptId: projection.reviewReceiptId,
            }),
            text: projection.reviewContinuation.label,
          },
        ],
        [
          {
            callback_data: telegramFundingCallbackData({
              contextId: projection.fundingContextId,
              kind: "refresh",
            }),
            text: "Not now",
          },
        ],
      ],
    };
  }
  return {
    inline_keyboard: [
      ...(projection.receiveAddress
        ? [
            [
              {
                copy_text: { text: projection.receiveAddress },
                text: "📋 Copy address",
              },
            ],
            [
              {
                callback_data: telegramFundingCallbackData({
                  contextId: projection.fundingContextId,
                  kind: "qr",
                }),
                text: "🔳 Show QR",
              },
            ],
          ]
        : []),
      [
        {
          callback_data: telegramFundingCallbackData({
            contextId: projection.fundingContextId,
            kind: "refresh",
          }),
          text: "🔄 Refresh",
        },
        {
          callback_data: telegramFundingCallbackData({
            contextId: projection.fundingContextId,
            kind: "cancel",
          }),
          text: "Cancel",
        },
      ],
    ],
  };
}

function buildTelegramFundingProgressMessageInternal(
  projection: TelegramFundingProgressProjection,
): TelegramFundingMessage {
  const { presentation } = projection;
  const destinationAsset = presentation.destinationAssetSymbol;
  const sourceAsset = automaticSourceLabel(projection);
  const amount = projection.rawAmount
    ? `${formatRawAmount(projection.rawAmount, presentation.decimals)} ${projection.assetSymbol}`
    : null;
  const stateCopy: Record<
    TelegramFundingProgressProjection["state"],
    { icon: string; title: string; body: string }
  > = {
    waiting_for_transfer: {
      icon: "⏳",
      title: "Waiting for transfer",
      body: projection.automaticConversionPaused
        ? `Send ${acceptedAssetsLabel(projection)} on ${presentation.networkLabel} to the verified receive address. Automatic ${sourceAsset} conversion is paused and will resume when funding is available.`
        : projection.automaticConversionEnabled
          ? `Send ${acceptedAssetsLabel(projection)} on ${presentation.networkLabel} to the verified receive address.`
          : `Send ${destinationAsset} on ${presentation.networkLabel} to the verified receive address.`,
    },
    funds_received: {
      icon: "📥",
      title: `${projection.assetSymbol} detected`,
      body: amount ? `${amount} was detected.` : "The transfer was detected.",
    },
    waiting_for_routing: {
      icon: "⏸️",
      title: `${sourceAsset} received`,
      body: amount
        ? `${amount} is preserved and waiting for automatic routing to resume.`
        : `The received ${sourceAsset} is preserved and waiting for automatic routing to resume.`,
    },
    converting: {
      icon: "🔄",
      title: `Converting ${sourceAsset} to ${destinationAsset}`,
      body: amount
        ? `${amount} is being converted to ${destinationAsset}.`
        : `The received ${sourceAsset} is being converted to ${destinationAsset}.`,
    },
    ready: {
      icon: "✅",
      title: `${destinationAsset} ready`,
      body:
        projection.sourceAssetSymbol && projection.sourceRawAmount
          ? `${formatRawAmount(
              projection.sourceRawAmount,
              presentation.decimals,
            )} ${projection.sourceAssetSymbol} was converted to ${amount ?? destinationAsset} and is now available at ${presentation.venueLabel}.`
          : amount
            ? `${amount} is now available at ${presentation.venueLabel}.`
            : `The received ${destinationAsset} is now available at ${presentation.venueLabel}.`,
    },
    expired: {
      icon: "⌛",
      title: "Receive expired",
      body: "Open Add funds again before sending another transfer.",
    },
    cancelled: {
      icon: "ℹ️",
      title: "Receive cancelled",
      body: "This funding screen no longer accepts new actions.",
    },
    unavailable: {
      icon: "⚠️",
      title: "Receive unavailable",
      body: "This receive address is no longer available. Open Add funds again to get the current verified address.",
    },
    needs_attention: {
      icon: "⚠️",
      title: "Funds need attention",
      body: amount
        ? `Automatic preparation of ${amount} did not complete. The transfer is preserved and needs review.`
        : "Automatic preparation did not complete. The received funds are preserved and need review.",
    },
  };
  const copy = stateCopy[projection.state];
  return {
    ...(projection.receiveAddress
      ? { durableFundingDeliveryRequired: true }
      : {}),
    fundingContextId: projection.fundingContextId,
    parse_mode: "MarkdownV2",
    reply_markup: fundingProgressReplyMarkup(projection),
    text: joinTelegramMarkdownV2Lines([
      `${telegramCustomEmojiMarkdownV2ForVenue(presentation.venueId)} *${escapeTelegramMarkdownV2(
        `${presentation.venueLabel} funding`,
      )}*`,
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(copy.body),
        icon: copy.icon,
        title: copy.title,
      }),
      ...(projection.receiveAddress
        ? [
            "",
            `📍 ${formatTelegramBoldMarkdownV2("Verified receive address")}`,
            formatTelegramCodeMarkdownV2(projection.receiveAddress),
          ]
        : []),
      "",
      formatTelegramFieldMarkdownV2("Network", presentation.networkLabel),
      formatTelegramFieldMarkdownV2(
        "Asset",
        projection.state === "waiting_for_transfer" &&
          projection.automaticConversionEnabled
          ? acceptedAssetsLabel(projection)
          : projection.assetSymbol,
      ),
      ...(projection.terminal ? [] : receiveWindowFields(projection.expiresAt)),
    ]),
    venue: presentation.venueId,
  };
}
