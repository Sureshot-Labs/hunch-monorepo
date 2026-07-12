export function escapeTelegramMarkdownV2(value: string): string {
  return value.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
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
