export type MarketType =
  | "single_game_sports"
  | "sports_outright"
  | "politics_geo"
  | "crypto_macro"
  | "other";

export type MarketTypeFields = {
  category?: string | null;
  seriesKey?: string | null;
  seriesTitle?: string | null;
  eventTitle?: string | null;
  marketTitle?: string | null;
  closeTime?: string | Date | null;
  expirationTime?: string | Date | null;
};

function parseDateMs(value: string | Date | null | undefined): number | null {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function computeMarketHoursToClose(
  fields: Pick<MarketTypeFields, "closeTime" | "expirationTime">,
  now: Date = new Date(),
): number | null {
  const closeMs =
    parseDateMs(fields.closeTime) ?? parseDateMs(fields.expirationTime);
  if (closeMs == null) return null;
  return (closeMs - now.getTime()) / 3_600_000;
}

export function buildMarketTypeText(fields: MarketTypeFields): string {
  return [
    fields.category,
    fields.seriesKey,
    fields.seriesTitle,
    fields.eventTitle,
    fields.marketTitle,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

export function classifyMarketTypeFromText(
  text: string,
  hoursToClose: number | null,
): MarketType {
  const looksSports =
    /\b(sports?|soccer|football|baseball|basketball|tennis|hockey|cricket|mma|boxing|esports?|counter-strike|league of legends|fifa|world cup|nba|nfl|mlb|nhl)\b/.test(
      text,
    );
  if (looksSports) {
    if (
      /\b(winner|champion|championship|golden boot|top scorer|outright|tournament|world cup winner|league winner)\b/.test(
        text,
      )
    ) {
      return "sports_outright";
    }

    const looksHeadToHead =
      /\b(vs\.?|v\.?|versus)\b/.test(text) ||
      /\b(spread|handicap|moneyline|match winner|total goals|over\/under|o\/u)\b/.test(
        text,
      );
    if (looksHeadToHead || (hoursToClose != null && hoursToClose <= 72)) {
      return "single_game_sports";
    }
    return "sports_outright";
  }

  if (
    /\b(bitcoin|btc|ethereum|eth|crypto|fed|inflation|cpi|rates?|treasury|oil|gold)\b/.test(
      text,
    )
  ) {
    return "crypto_macro";
  }
  if (
    /\b(election|president|parliament|senate|congress|iran|hormuz|strait|shipping|china|taiwan|russia|ukraine|war|ceasefire|nuclear|invasion|tariff|politics|geopolitics)\b/.test(
      text,
    )
  ) {
    return "politics_geo";
  }

  return "other";
}

export function classifyMarketType(
  fields: MarketTypeFields,
  now: Date = new Date(),
): MarketType {
  return classifyMarketTypeFromText(
    buildMarketTypeText(fields),
    computeMarketHoursToClose(fields, now),
  );
}
