import { escapeTelegramMarkdownV2 } from "./signal-delivery.js";
import type { SignalNotificationHeadline } from "./signal-notification-headline.js";
import { telegramCustomEmojiMarkdownV2 } from "./telegram-custom-emoji.js";
import { TELEGRAM_VISUAL_BLANK_LINE } from "./telegram-bot-trading-presentation.js";

function bold(value: string): string {
  return `*${escapeTelegramMarkdownV2(value)}*`;
}

function escapeUrl(value: string): string {
  return value.replace(/[)\\]/g, (char) => `\\${char}`);
}

export function formatHunchTelegramTitle(value: string): string {
  return `${telegramCustomEmojiMarkdownV2("hunch")} ${bold(value)}`;
}

export function formatTelegramNativeTitle(icon: string, value: string): string {
  return `${icon} ${bold(value)}`;
}

export function formatTelegramItalic(value: string): string {
  return `_${escapeTelegramMarkdownV2(value)}_`;
}

export function formatTelegramLink(label: string, url: string): string {
  return `__[${escapeTelegramMarkdownV2(label)}](${escapeUrl(url)})__`;
}

export function formatSignalNotificationHeadlineMarkdown(
  headline: SignalNotificationHeadline,
): string {
  const continuation = headline.continuation
    ? ` ${escapeTelegramMarkdownV2(headline.continuation)}`
    : "";
  return `${headline.emoji} ${bold(headline.hook)}${continuation}`;
}

export function joinTelegramMessageBlocks(
  blocks: Array<string | null | undefined>,
): string {
  return blocks
    .filter((block): block is string => Boolean(block?.trim()))
    .join(`\n${TELEGRAM_VISUAL_BLANK_LINE}\n`);
}

export function formatTelegramBlockquote(lines: string[]): string {
  return lines
    .map((line) => `>${line || TELEGRAM_VISUAL_BLANK_LINE}`)
    .join("\n");
}
