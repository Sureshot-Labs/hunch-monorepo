export function escapeTelegramMarkdownV2(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

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
