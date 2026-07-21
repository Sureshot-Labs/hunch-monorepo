import {
  telegramRichBold,
  telegramRichMarked,
  telegramRichParagraph,
  telegramRichText,
  type TelegramInputRichBlock,
  type TelegramRichText,
} from "./telegram-rich-message.js";

export function escapeTelegramMarkdownV2(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

// Telegram clients collapse ordinary empty lines at blockquote boundaries.
// U+2800 keeps one visually blank row without adding visible decoration.
export const TELEGRAM_VISUAL_BLANK_LINE = "\u2800";

export function formatTelegramBoldMarkdownV2(value: string): string {
  return `*${escapeTelegramMarkdownV2(value)}*`;
}

export function formatTelegramItalicMarkdownV2(value: string): string {
  return `_${escapeTelegramMarkdownV2(value)}_`;
}

export function formatTelegramCodeMarkdownV2(value: string): string {
  return `\`${value.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

export function formatTelegramTextWithCommandsMarkdownV2(
  value: string,
): string {
  const matches = Array.from(value.matchAll(/(?<![:/])\/[a-z][a-z0-9_]*/gi));
  if (matches.length === 0) return escapeTelegramMarkdownV2(value);
  const rendered: string[] = [];
  let offset = 0;
  for (const match of matches) {
    const command = match[0] ?? "";
    const index = match.index ?? 0;
    rendered.push(escapeTelegramMarkdownV2(value.slice(offset, index)));
    rendered.push(formatTelegramCodeMarkdownV2(command));
    offset = index + command.length;
  }
  rendered.push(escapeTelegramMarkdownV2(value.slice(offset)));
  return rendered.join("");
}

export function formatTelegramFieldMarkdownV2(
  label: string,
  value: string,
): string {
  return `${formatTelegramBoldMarkdownV2(`${label}:`)} ${escapeTelegramMarkdownV2(value)}`;
}

export function formatTelegramFieldWithMarkdownV2(
  label: string,
  markdownValue: string,
): string {
  return `${formatTelegramBoldMarkdownV2(`${label}:`)} ${markdownValue}`;
}

export function formatTelegramBlockquoteMarkdownV2(
  markdownLines: readonly string[],
): string {
  return markdownLines
    .flatMap((line) => line.split("\n"))
    .map((line) => `>${line || TELEGRAM_VISUAL_BLANK_LINE}`)
    .join("\n");
}

export function joinTelegramMarkdownV2Lines(
  markdownLines: readonly string[],
): string {
  const rendered: string[] = [];
  for (let index = 0; index < markdownLines.length; index += 1) {
    const line = markdownLines[index] ?? "";
    rendered.push(line);
    const finalPhysicalLine = line.split("\n").at(-1) ?? "";
    if (!finalPhysicalLine.startsWith(">")) continue;

    let nextIndex = index + 1;
    while (
      nextIndex < markdownLines.length &&
      !(markdownLines[nextIndex] ?? "").trim()
    ) {
      nextIndex += 1;
    }
    if (nextIndex >= markdownLines.length) continue;

    rendered.push(TELEGRAM_VISUAL_BLANK_LINE);
    index = nextIndex - 1;
  }
  return rendered.join("\n");
}

export function formatTelegramCalloutMarkdownV2(input: {
  bodyMarkdownV2: string | readonly string[];
  icon: string;
  title: string;
}): string {
  return formatTelegramBlockquoteMarkdownV2([
    `${input.icon} ${formatTelegramBoldMarkdownV2(input.title)}`,
    ...(typeof input.bodyMarkdownV2 === "string"
      ? [input.bodyMarkdownV2]
      : input.bodyMarkdownV2),
  ]);
}

export function formatTelegramRichTitle(
  icon: TelegramRichText,
  title: string,
): TelegramInputRichBlock {
  return telegramRichParagraph(
    telegramRichText(icon, " ", telegramRichBold(title)),
  );
}

export function formatTelegramRichCallout(input: {
  body: TelegramRichText;
  icon: TelegramRichText;
  marked?: boolean;
  title: string;
}): TelegramInputRichBlock {
  const content = telegramRichText(
    input.icon,
    " ",
    telegramRichBold(input.title),
    "\n",
    input.body,
  );
  return telegramRichParagraph(
    input.marked === false ? content : telegramRichMarked(content),
  );
}

export function formatTelegramLivePrice(
  value: number | null | undefined,
): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  return `${(value * 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  })}¢`;
}

export function formatTelegramQuotePrice(price: number | null): string {
  return price == null || !Number.isFinite(price)
    ? "market"
    : `${Math.round(price * 1000) / 10}c`;
}

export function formatTelegramTtl(seconds: number): string {
  const bounded = Math.max(1, Math.round(seconds));
  if (bounded < 60) return `${bounded} seconds`;
  const minutes = Math.max(1, Math.round(bounded / 60));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function formatTelegramQuoteTtl(expiresAt: Date | null): string | null {
  if (!expiresAt) return null;
  const seconds = Math.max(
    1,
    Math.ceil((expiresAt.getTime() - Date.now()) / 1000),
  );
  return formatTelegramTtl(seconds);
}

export function buildTelegramTradeProgressMessage(
  state: "processing" | "resolving",
): string {
  return state === "processing"
    ? "⏳ *Processing trade*\n\nThe bot is submitting and checking the result\\. Do not retry this market\\."
    : "⏳ *Still resolving*\n\nThe bot is checking automatically\\. Do not retry this market\\.";
}
