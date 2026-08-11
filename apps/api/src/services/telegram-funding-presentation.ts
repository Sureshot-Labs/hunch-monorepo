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
  telegramCustomEmojiMarkdownV2,
  telegramCustomEmojiMarkdownV2ForNetwork,
  telegramCustomEmojiMarkdownV2ForVenue,
} from "./telegram-custom-emoji.js";
import { FUNDING_RECEIVE_SESSION_TTL_HOURS } from "../funding/receive/receive-session-constants.js";

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

export type TelegramFundingReceivePresentationMode =
  | "pusd_direct"
  | "pusd_or_usdce_automatic"
  | "usdce_automatic";

function receivePresentation(mode: TelegramFundingReceivePresentationMode) {
  if (mode === "pusd_or_usdce_automatic") {
    return {
      asset: "pUSD / USDC.e",
      button: "pUSD / USDC.e on Polygon",
      settlement: "Direct / automatic 1:1 conversion",
      instructions: [
        "Send pUSD or USDC.e on Polygon.",
        "pUSD is credited directly.",
        "USDC.e is automatically converted 1:1 to pUSD.",
      ],
    } as const;
  }
  if (mode === "usdce_automatic") {
    return {
      asset: "USDC.e",
      button: "USDC.e on Polygon → pUSD",
      settlement: "Automatic 1:1 conversion",
      instructions: [
        "Send USDC.e on Polygon.",
        "USDC.e is automatically converted 1:1 to pUSD.",
      ],
    } as const;
  }
  return {
    asset: "pUSD",
    button: "pUSD on Polygon — direct",
    settlement: "Direct",
    instructions: [
      "Send only pUSD on Polygon.",
      "Other assets cannot be routed from this Telegram flow.",
    ],
  } as const;
}

export function buildTelegramFundingTargetMessage(input: {
  contextId: string;
  expiresAt: string;
  mode?: TelegramFundingReceivePresentationMode;
}): TelegramFundingMessage {
  const presentation = receivePresentation(input.mode ?? "pusd_direct");
  return {
    fundingContextId: input.contextId,
    parse_mode: "MarkdownV2",
    reply_markup: {
      inline_keyboard: [
        [
          {
            callback_data: telegramFundingCallbackData({
              choiceToken: "p",
              contextId: input.contextId,
              kind: "select",
            }),
            text: presentation.button,
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
      `${telegramCustomEmojiMarkdownV2ForVenue("polymarket")} *${escapeTelegramMarkdownV2(
        "Add funds to Polymarket",
      )}*`,
      "",
      escapeTelegramMarkdownV2(
        "Confirm the supported receive assets before the verified address is shown.",
      ),
      "",
      `${telegramCustomEmojiMarkdownV2ForNetwork("Polygon")} ${formatTelegramFieldMarkdownV2(
        "Network",
        "Polygon",
      )}`,
      `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2(
        "Asset",
        presentation.asset,
      )}`,
      formatTelegramFieldMarkdownV2("Settlement", presentation.settlement),
      "",
      ...presentation.instructions.map(escapeTelegramMarkdownV2),
      ...receiveWindowFields(input.expiresAt),
    ]),
    venue: "polymarket",
  };
}

export function buildTelegramFundingAddressMessage(input: {
  address: string;
  contextId: string;
  expiresAt: string;
  mode?: TelegramFundingReceivePresentationMode;
}): TelegramFundingMessage {
  const presentation = receivePresentation(input.mode ?? "pusd_direct");
  return {
    fundingContextId: input.contextId,
    parse_mode: "MarkdownV2",
    qrText: input.address,
    reply_markup: {
      inline_keyboard: [
        [{ copy_text: { text: input.address }, text: "📋 Copy address" }],
        [
          {
            callback_data: telegramFundingCallbackData({
              contextId: input.contextId,
              kind: "qr",
            }),
            text: "🔳 Show QR",
          },
        ],
        [
          {
            callback_data: telegramFundingCallbackData({
              contextId: input.contextId,
              kind: "refresh",
            }),
            text: "🔄 Refresh",
          },
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
      `${telegramCustomEmojiMarkdownV2ForVenue("polymarket")} *${escapeTelegramMarkdownV2(
        "Polymarket Receive",
      )}*`,
      "",
      `${telegramCustomEmojiMarkdownV2ForNetwork("Polygon")} ${formatTelegramFieldMarkdownV2(
        "Network",
        "Polygon",
      )}`,
      `${telegramCustomEmojiMarkdownV2("usdc")} ${formatTelegramFieldMarkdownV2(
        "Asset",
        presentation.asset,
      )}`,
      "",
      `📍 ${formatTelegramBoldMarkdownV2("Verified receive address")}`,
      formatTelegramCodeMarkdownV2(input.address),
      "",
      formatTelegramCalloutMarkdownV2({
        bodyMarkdownV2: escapeTelegramMarkdownV2(
          `${presentation.instructions.join(" ")} Your sending wallet must cover the Polygon network fee.`,
        ),
        icon: "⚠️",
        title: "Important",
      }),
      "",
      ...receiveWindowFields(input.expiresAt),
    ]),
    venue: "polymarket",
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
  const amount = projection.rawAmount
    ? `${formatRawAmount(projection.rawAmount, projection.decimals)} ${projection.assetSymbol}`
    : null;
  const stateCopy: Record<
    TelegramFundingProgressProjection["state"],
    { icon: string; title: string; body: string }
  > = {
    waiting_for_transfer: {
      icon: "⏳",
      title: "Waiting for transfer",
      body: projection.automaticConversionEnabled
        ? "Send pUSD or USDC.e on Polygon to the verified receive address."
        : "Send pUSD on Polygon to the verified receive address.",
    },
    funds_received: {
      icon: "📥",
      title:
        projection.assetSymbol === "USDC.e"
          ? "USDC.e detected"
          : "Funds received",
      body: amount ? `${amount} was detected.` : "The transfer was detected.",
    },
    waiting_for_routing: {
      icon: "⏸️",
      title: "USDC.e received",
      body: amount
        ? `${amount} is preserved and waiting for automatic routing to resume.`
        : "The received USDC.e is preserved and waiting for automatic routing to resume.",
    },
    converting: {
      icon: "🔄",
      title: "Converting USDC.e to pUSD",
      body: amount
        ? `${amount} is being converted to pUSD.`
        : "The received USDC.e is being converted to pUSD.",
    },
    ready: {
      icon: "✅",
      title: "pUSD ready",
      body:
        projection.sourceAssetSymbol === "USDC.e" && projection.sourceRawAmount
          ? `${formatRawAmount(
              projection.sourceRawAmount,
              projection.decimals,
            )} USDC.e was converted to ${amount ?? "pUSD"} and is now available at Polymarket.`
          : amount
            ? `${amount} is now available at Polymarket.`
            : "The received pUSD is now available at Polymarket.",
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
    fundingContextId: projection.fundingContextId,
    parse_mode: "MarkdownV2",
    reply_markup: projection.terminal
      ? undefined
      : {
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
        },
    text: joinTelegramMarkdownV2Lines([
      `${telegramCustomEmojiMarkdownV2ForVenue("polymarket")} *${escapeTelegramMarkdownV2(
        "Polymarket funding",
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
      formatTelegramFieldMarkdownV2("Network", projection.networkLabel),
      formatTelegramFieldMarkdownV2(
        "Asset",
        projection.state === "waiting_for_transfer" &&
          projection.automaticConversionEnabled
          ? "pUSD / USDC.e"
          : projection.assetSymbol,
      ),
      ...(projection.terminal ? [] : receiveWindowFields(projection.expiresAt)),
    ]),
    venue: "polymarket",
  };
}
