import type { TelegramPositionDetail } from "./telegram-bot-positions.js";
import type { TelegramBotTradingClientMessage } from "./telegram-bot-trading-client.js";
import { buildHunchMiniAppWebButton } from "./telegram-mini-app-buttons.js";
import { escapeTelegramMarkdownV2 } from "./telegram-bot-trading-presentation.js";

export function telegramPositionStatusLabel(status: string): string {
  switch (status) {
    case "market_open":
      return "Market open";
    case "redeemable":
      return "Ready to redeem";
    case "resolved_not_redeemable":
      return "Lost · Payout $0";
    case "redeemed":
      return "Redeemed";
    case "metadata_unavailable":
      return "Market details unavailable";
    default:
      return "Waiting for settlement";
  }
}

/** Terminal holdings are not trade tickets. Never sign, burn, or submit here. */
export function buildTelegramSettledPositionMessage(input: {
  appBaseUrl: string;
  telegramMiniAppEnabled?: boolean;
  page: number;
  detail: TelegramPositionDetail;
}): TelegramBotTradingClientMessage | null {
  const { detail, page } = input;
  if (
    detail.marketOrderable ||
    !["redeemable", "resolved_not_redeemable", "redeemed"].includes(
      detail.redemptionStatus,
    )
  )
    return null;
  const loss = detail.redemptionStatus === "resolved_not_redeemable";
  const hidden = detail.position.isHidden === true;
  const keyboard: NonNullable<
    TelegramBotTradingClientMessage["reply_markup"]
  >["inline_keyboard"] = [];
  if (loss)
    keyboard.push([
      {
        text: hidden ? "Show position" : "Hide loss",
        callback_data: `hm:v1:pos_${hidden ? "show" : "hide"}:${detail.position.id}:${page}`,
      },
    ]);
  const redeem = detail.redemptionStatus === "redeemable";
  const button = buildHunchMiniAppWebButton({
    appBaseUrl: input.appBaseUrl,
    enabled: input.telegramMiniAppEnabled === true,
    path: redeem
      ? `/portfolio?redeemPosition=${encodeURIComponent(detail.position.id)}`
      : "/portfolio",
    text: redeem ? "Redeem in Hunch" : "Open portfolio",
  });
  if (button) keyboard.push([button]);
  keyboard.push([
    { text: "⬅️ My positions", callback_data: `hm:v1:positions_page:${page}` },
  ]);
  keyboard.push([{ text: "🏠 Home", callback_data: "hm:v1:home" }]);
  return {
    parse_mode: "MarkdownV2",
    text: escapeTelegramMarkdownV2(
      [
        telegramPositionStatusLabel(detail.redemptionStatus),
        detail.eventTitle,
        detail.marketTitle,
        `${detail.side ?? "Position"} · ${detail.position.size} shares`,
        loss
          ? "This outcome lost. Payout is $0; selling is no longer available."
          : redeem
            ? "Review and redeem this position in Hunch."
            : "This position has already been redeemed.",
        loss
          ? hidden
            ? "Hidden from My positions. History is preserved. You can show it again below or in Hunch."
            : "Hide loss only hides this holding. No transaction is sent and history is preserved."
          : null,
        !button ? "Open Hunch and find this position in Portfolio." : null,
      ]
        .filter(Boolean)
        .join("\n\n"),
    ),
    reply_markup: { inline_keyboard: keyboard },
  };
}
