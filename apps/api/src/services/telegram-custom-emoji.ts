export const TELEGRAM_CUSTOM_EMOJI = {
  base: {
    fallback: "🟦",
    id: "5398022443593935276",
  },
  hunch: {
    fallback: "🟠",
    id: "5397843223198607684",
  },
  hyperliquid: {
    fallback: "♾️",
    id: "5399869069077813370",
  },
  kalshi: {
    fallback: "♻️",
    id: "5398021142218842700",
  },
  limitless: {
    fallback: "↔️",
    id: "5399931384758312849",
  },
  polygon: {
    fallback: "🟣",
    id: "5397636596616964415",
  },
  polymarket: {
    fallback: "🔵",
    id: "5397742643654470005",
  },
  solana: {
    fallback: "🪙",
    id: "5397588853760501094",
  },
  usdc: {
    fallback: "💲",
    id: "5397914592670165457",
  },
} as const;

export type TelegramCustomEmojiName = keyof typeof TELEGRAM_CUSTOM_EMOJI;

const TELEGRAM_CUSTOM_EMOJI_MARKDOWN_V2_RE =
  /!\[([^\]\r\n]+)\]\(tg:\/\/emoji\?id=\d+\)/g;

export function telegramCustomEmojiId(name: TelegramCustomEmojiName): string {
  return TELEGRAM_CUSTOM_EMOJI[name].id;
}

export function telegramCustomEmojiMarkdownV2(
  name: TelegramCustomEmojiName,
): string {
  const emoji = TELEGRAM_CUSTOM_EMOJI[name];
  return `![${emoji.fallback}](tg://emoji?id=${emoji.id})`;
}

export function stripTelegramCustomEmojiMarkdownV2(value: string): string {
  return value.replace(TELEGRAM_CUSTOM_EMOJI_MARKDOWN_V2_RE, "$1");
}

export function stripTelegramCustomEmojiButtonIcons<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      stripTelegramCustomEmojiButtonIcons(entry),
    ) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const cleaned = Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      key === "icon_custom_emoji_id"
        ? []
        : [[key, stripTelegramCustomEmojiButtonIcons(entry)]],
    ),
  );
  return cleaned as T;
}

function normalizeSemanticValue(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

export function telegramVenueCustomEmojiName(
  venue: string | null | undefined,
): TelegramCustomEmojiName | null {
  switch (normalizeSemanticValue(venue)) {
    case "hyperliquid":
      return "hyperliquid";
    case "kalshi":
      return "kalshi";
    case "limitless":
      return "limitless";
    case "polymarket":
      return "polymarket";
    default:
      return null;
  }
}

export function telegramNetworkCustomEmojiName(
  network: string | null | undefined,
): TelegramCustomEmojiName | null {
  switch (normalizeSemanticValue(network)) {
    case "base":
      return "base";
    case "polygon":
      return "polygon";
    case "solana":
      return "solana";
    default:
      return null;
  }
}

export function telegramAssetCustomEmojiName(
  asset: string | null | undefined,
): TelegramCustomEmojiName | null {
  switch (normalizeSemanticValue(asset)) {
    case "pusd":
    case "usdc":
    case "usdc.e":
      return "usdc";
    default:
      return null;
  }
}

export function telegramCustomEmojiIdForVenue(
  venue: string | null | undefined,
): string | undefined {
  const name = telegramVenueCustomEmojiName(venue);
  return name ? telegramCustomEmojiId(name) : undefined;
}

export function telegramCustomEmojiMarkdownV2ForVenue(
  venue: string | null | undefined,
): string | null {
  const name = telegramVenueCustomEmojiName(venue);
  return name ? telegramCustomEmojiMarkdownV2(name) : null;
}

export function telegramCustomEmojiMarkdownV2ForNetwork(
  network: string | null | undefined,
): string | null {
  const name = telegramNetworkCustomEmojiName(network);
  return name ? telegramCustomEmojiMarkdownV2(name) : null;
}

export function telegramCustomEmojiMarkdownV2ForAsset(
  asset: string | null | undefined,
): string | null {
  const name = telegramAssetCustomEmojiName(asset);
  return name ? telegramCustomEmojiMarkdownV2(name) : null;
}
