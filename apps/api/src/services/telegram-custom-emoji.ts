export const TELEGRAM_CUSTOM_EMOJI = {
  base: {
    fallback: "🟦",
    id: "5399884702758770830",
  },
  hunch: {
    fallback: "🟠",
    id: "5400370308941127529",
  },
  hyperliquid: {
    fallback: "♾️",
    id: "5397762885835332158",
  },
  kalshi: {
    fallback: "♻️",
    id: "5399820394213450697",
  },
  limitless: {
    fallback: "↔️",
    id: "5400267199661253196",
  },
  polygon: {
    fallback: "🟣",
    id: "5399966058029293176",
  },
  polymarket: {
    fallback: "🔵",
    id: "5397905371375383129",
  },
  solana: {
    fallback: "🪙",
    id: "5400271155326130010",
  },
  usdc: {
    fallback: "💲",
    id: "5400187523722944017",
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
