function cleanTitle(value: string | null | undefined): string | null {
  const cleaned = value?.trim().replace(/\s+/g, " ");
  return cleaned ? cleaned : null;
}

function titleKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export type TelegramMarketIdentity = {
  buttonLabel: string;
  lines: [string] | [string, string];
};

const TELEGRAM_VENUE_LABELS: Readonly<Record<string, string>> = {
  kalshi: "Kalshi",
  limitless: "Limitless",
  polymarket: "Polymarket",
};

export function formatTelegramVenueLabel(
  venue: string | null | undefined,
): string {
  const normalized = venue?.trim().toLocaleLowerCase("en-US") ?? "";
  return TELEGRAM_VENUE_LABELS[normalized] ?? "Market";
}

/**
 * Keeps a multi-market event question together with the selected market or
 * outcome. The body follows the trade-card order; compact controls lead with
 * the actionable market label so it survives Telegram button truncation.
 */
export function buildTelegramMarketIdentity(input: {
  eventTitle: string | null | undefined;
  marketTitle: string | null | undefined;
}): TelegramMarketIdentity {
  const eventTitle = cleanTitle(input.eventTitle);
  const marketTitle = cleanTitle(input.marketTitle) ?? "Prediction market";
  if (eventTitle && titleKey(eventTitle) !== titleKey(marketTitle)) {
    return {
      buttonLabel: `${marketTitle} · ${eventTitle}`,
      lines: [eventTitle, marketTitle],
    };
  }
  const title = eventTitle ?? marketTitle;
  return { buttonLabel: title, lines: [title] };
}
