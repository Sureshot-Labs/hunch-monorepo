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

function minimumFundingUsdLabel(value: string): string {
  const [whole = "0", rawFraction = ""] = value.split(".", 2);
  const fraction = rawFraction.replace(/0+$/u, "");
  return `$${fraction ? `${whole}.${fraction}` : whole}`;
}

function fundingMoneyLabel(money: Money): string {
  return `${formatRawAmount(money.raw, money.asset.decimals)} ${
    resolveKnownAccountAssetSymbol(money.asset) ?? money.asset.assetId
  }`;
}

function fundingTargetChoiceToken(input: {
  automaticConversion: boolean;
  routeKey: string;
}): string {
  const tokenByRouteKey: Readonly<Record<string, string>> = {
    limitless_base_usdc_direct_v1: "ld",
    limitless_polygon_pusd_relay_v1: "lp",
    limitless_polygon_usdc_relay_v1: "ln",
    limitless_polygon_usdce_relay_v1: "le",
    polymarket_base_usdc_relay_v1: "pb",
    polymarket_polygon_pusd_direct_v1: "pd",
    polymarket_polygon_usdc_relay_v1: "pn",
    polymarket_polygon_usdce_wrap_v1: "pw",
    // Existing frozen sessions keep their original route identity.
    polymarket_polygon_pusd_usdce_v1: "a",
  };
  return (
    tokenByRouteKey[input.routeKey] ?? (input.automaticConversion ? "a" : "d")
  );
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
        : "A verified receive target is temporarily unavailable. Try again later.";
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
              choiceToken: fundingTargetChoiceToken({
                automaticConversion: input.automaticConversion,
                routeKey: input.presentation.routeKey,
              }),
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
  const targetRows = targets.map((target) => [
    {
      callback_data: telegramFundingCallbackData({
        choiceToken: fundingTargetChoiceToken({
          automaticConversion: target.automaticSourceAsset !== null,
          routeKey: target.presentation.routeKey,
        }),
        contextId: input.contextId,
        kind: "select",
      }),
      text:
        target.presentation.selectionButtonLabel ??
        `${target.presentation.acceptedAssetSymbols.join(" / ")} on ${target.presentation.networkLabel}`,
    },
  ]);
  const venueLabel = targets[0]?.presentation.venueLabel ?? "venue";
  return {
    fundingContextId: input.contextId,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        ...targetRows,
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
      `*Add funds to ${escapeTelegramMarkdownV2(venueLabel)}*`,
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

export function buildTelegramFundingActiveElsewhereMessage(
  input: Readonly<{
    projection?: TelegramFundingProgressProjection | null;
    venue?: string;
  }> = {},
): TelegramFundingMessage {
  const summary = input.projection
    ? buildTelegramFundingProgressMessageInternal({
        ...input.projection,
        receiveAddress: null,
      })
    : null;
  return {
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data:
              input.venue === "limitless" || input.venue === "polymarket"
                ? `hm:v1:deposit:${input.venue}`
                : "hm:v1:deposit",
            text: summary ? "🔄 Refresh active Deposit" : "Open Deposit",
          },
        ],
        [
          {
            callback_data: "hm:v1:deposit_cancel_active",
            text: "Cancel active Deposit",
          },
        ],
        [{ callback_data: "hm:v1:home", text: "🏠 Home" }],
      ],
    },
    text: summary
      ? joinTelegramMarkdownV2Lines([
          formatTelegramCalloutMarkdownV2({
            bodyMarkdownV2: escapeTelegramMarkdownV2(
              "The original card remains the verified address owner. Its current status is mirrored below without repeating the address.",
            ),
            icon: "ℹ️",
            title: "Active Deposit",
          }),
          "",
          summary.text,
        ])
      : formatTelegramCalloutMarkdownV2({
          bodyMarkdownV2: escapeTelegramMarkdownV2(
            "A transfer is already being monitored. Tap Open Deposit to check it, or return Home.",
          ),
          icon: "ℹ️",
          title: "Deposit already active",
        }),
  };
}

export function buildTelegramFundingBuyReturnAttachedMessage(): TelegramFundingMessage {
  return {
    parse_mode: "MarkdownV2",
    text: formatTelegramCalloutMarkdownV2({
      bodyMarkdownV2: escapeTelegramMarkdownV2(
        "This Buy was linked to the earlier Polymarket funding card. Continue there after funding is ready. No trade was submitted.",
      ),
      icon: "ℹ️",
      title: "Buy linked to active funding",
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
    reply_markup: NonNullable<TelegramFundingMessage["reply_markup"]>;
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
      ...(projection.minimumFundingUsd
        ? [
            formatTelegramFieldMarkdownV2(
              "Minimum to add",
              minimumFundingUsdLabel(projection.minimumFundingUsd),
            ),
          ]
        : []),
      escapeTelegramMarkdownV2("Scan to fill the verified receive address."),
      formatTelegramFieldMarkdownV2(
        "Expires at",
        expiryLabel(projection.expiresAt),
      ),
    ]),
    filename: `hunch-funding-${projection.fundingContextId}.png`,
    photo: new Uint8Array(png),
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: telegramFundingCallbackData({
              contextId: projection.fundingContextId,
              kind: "hide_qr",
            }),
            text: "🙈 Hide",
          },
        ],
      ],
    },
  };
}

function fundingProgressReplyMarkup(
  projection: TelegramFundingProgressProjection,
): TelegramFundingMessage["reply_markup"] {
  const homeRow = [
    {
      callback_data: "hm:v1:home",
      text: "🏠 Home",
    },
  ];
  if (projection.terminal) {
    return {
      inline_keyboard: [
        ...(projection.returnToMarketAvailable
          ? [
              [
                {
                  callback_data: telegramFundingCallbackData({
                    contextId: projection.fundingContextId,
                    kind: "back_to_market",
                  }),
                  text: "⬅️ Back to market",
                },
              ],
            ]
          : []),
        homeRow,
      ],
    };
  }
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
        homeRow,
      ],
    };
  }
  const moneyReceived =
    projection.rawAmount != null ||
    (projection.receiptBreakdown?.sourceReceiptCount ?? 0) > 0;
  const navigationButton =
    projection.returnToMarketAvailable && moneyReceived
      ? {
          callback_data: telegramFundingCallbackData({
            contextId: projection.fundingContextId,
            kind: "back_to_market",
          }),
          text: "⬅️ Back to market",
        }
      : {
          callback_data: telegramFundingCallbackData({
            contextId: projection.fundingContextId,
            kind: "cancel",
          }),
          text: "Cancel",
        };
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
        navigationButton,
      ],
      homeRow,
    ],
  };
}

function fundingReceiptBreakdownLines(
  projection: TelegramFundingProgressProjection,
): string[] {
  const breakdown = projection.receiptBreakdown;
  if (!breakdown) return [];
  const sourceAmount = (raw: string) =>
    `${formatRawAmount(raw, breakdown.sourceDecimals)} ${breakdown.sourceAssetSymbol}`;
  const destinationAmount = (raw: string) =>
    `${formatRawAmount(raw, breakdown.destinationDecimals)} ${breakdown.destinationAssetSymbol}`;
  const aggregateLines = [
    formatTelegramFieldMarkdownV2(
      "Total received",
      sourceAmount(breakdown.totalSourceRaw),
    ),
    ...(breakdown.readyDestinationRaw !== "0"
      ? [
          formatTelegramFieldMarkdownV2(
            "Ready",
            destinationAmount(breakdown.readyDestinationRaw),
          ),
        ]
      : []),
    ...(breakdown.convertingSourceRaw !== "0"
      ? [
          formatTelegramFieldMarkdownV2(
            "Converting",
            sourceAmount(breakdown.convertingSourceRaw),
          ),
        ]
      : []),
    ...(breakdown.queuedSourceRaw !== "0"
      ? [
          formatTelegramFieldMarkdownV2(
            "Queued",
            sourceAmount(breakdown.queuedSourceRaw),
          ),
        ]
      : []),
    ...(breakdown.attentionSourceRaw !== "0"
      ? [
          formatTelegramFieldMarkdownV2(
            "Needs attention",
            sourceAmount(breakdown.attentionSourceRaw),
          ),
        ]
      : []),
    formatTelegramFieldMarkdownV2(
      "Transfers",
      String(breakdown.sourceReceiptCount),
    ),
  ];
  const stateLabels: Record<
    (typeof breakdown.transfers)[number]["state"],
    string
  > = {
    queued: "Queued",
    converting: "Converting",
    ready: "Ready",
    needs_attention: "Needs attention",
  };
  const transferLines = breakdown.transfers.map((transfer, index) =>
    formatTelegramFieldMarkdownV2(
      `Transfer ${index + 1}`,
      `${sourceAmount(transfer.rawAmount)} — ${stateLabels[transfer.state]}`,
    ),
  );
  return [
    "",
    formatTelegramBoldMarkdownV2("Transfer summary"),
    ...aggregateLines,
    ...transferLines,
    ...(breakdown.hiddenTransferCount > 0
      ? [
          escapeTelegramMarkdownV2(
            `+ ${breakdown.hiddenTransferCount} more transfers`,
          ),
        ]
      : []),
  ];
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
  const conversionOutputDetected =
    projection.state === "converting" &&
    (projection.receiptBreakdown?.destinationReceiptCount ?? 0) > 0;
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
      title: conversionOutputDetected
        ? `Finalizing ${destinationAsset} funding`
        : `Converting ${sourceAsset} to ${destinationAsset}`,
      body: conversionOutputDetected
        ? `${destinationAsset} was detected. Backend confirmation is still in progress.`
        : amount
          ? `${amount} is being converted to ${destinationAsset}.`
          : `The received ${sourceAsset} is being converted to ${destinationAsset}.`,
    },
    ready: {
      icon: "✅",
      title: `${destinationAsset} ready`,
      body: amount
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
      ...fundingReceiptBreakdownLines(projection),
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
