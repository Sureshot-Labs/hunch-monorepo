export type MarketType =
  | "single_game_sports"
  | "sports_outright"
  | "politics_geo"
  | "crypto_macro"
  | "other";

export type MarketSegment =
  | "sports_soccer_game"
  | "sports_tennis_game"
  | "sports_baseball_game"
  | "sports_basketball_game"
  | "sports_cricket_game"
  | "sports_esports_game"
  | "sports_other_game"
  | "sports_outright"
  | "politics_geo"
  | "crypto_btc"
  | "crypto_eth"
  | "crypto_alt"
  | "macro_rates"
  | "macro_commodities"
  | "macro_equities"
  | "tech_ai"
  | "mentions"
  | "entertainment"
  | "weather"
  | "health"
  | "other";

export type MarketCategoryFamily =
  | "sports"
  | "politics"
  | "crypto"
  | "macro"
  | "technology"
  | "weather"
  | "health"
  | "culture"
  | "mentions";

export type MarketTaxonomy = {
  marketType: MarketType;
  marketSegment: MarketSegment;
};

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
  const ms =
    value instanceof Date ? value.getTime() : new Date(value).getTime();
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
  return classifyMarketTaxonomyFromText(text, hoursToClose).marketType;
}

export function classifyMarketSegmentFromText(
  text: string,
  hoursToClose: number | null,
): MarketSegment {
  return classifyMarketTaxonomyFromText(text, hoursToClose).marketSegment;
}

function sportsGameSegment(text: string): MarketSegment {
  if (
    /\b(soccer|fifa|world cup|uefa|premier league|champions league|laliga|la liga|serie a|bundesliga|mls|football)\b/.test(
      text,
    )
  ) {
    return "sports_soccer_game";
  }
  if (
    /\b(tennis|wta|atp|wimbledon|roland garros|us open|australian open|bad homburg|eastbourne)\b/.test(
      text,
    )
  ) {
    return "sports_tennis_game";
  }
  if (/\b(baseball|mlb)\b/.test(text)) return "sports_baseball_game";
  if (/\b(basketball|nba|wnba|ncaab)\b/.test(text)) {
    return "sports_basketball_game";
  }
  if (/\b(cricket|icc|t20|ipl)\b/.test(text)) return "sports_cricket_game";
  if (
    /\b(esports?|counter-strike|counter strike|cs2|league of legends|dota|valorant|bo3|bo5|game [1-5] winner)\b/.test(
      text,
    )
  ) {
    return "sports_esports_game";
  }
  return "sports_other_game";
}

function classifySportsTaxonomy(
  text: string,
  hoursToClose: number | null,
): MarketTaxonomy {
  const looksHeadToHead =
    /\b(vs\.?|v\.?|versus)\b/.test(text) ||
    /\b(spread|handicap|moneyline|match winner|game [1-5] winner|total goals|over\/under|o\/u|bo3|bo5)\b/.test(
      text,
    );
  if (looksHeadToHead || (hoursToClose != null && hoursToClose <= 72)) {
    return {
      marketType: "single_game_sports",
      marketSegment: sportsGameSegment(text),
    };
  }

  if (
    /\b(winner|champion|championship|golden boot|top scorer|outright|tournament|world cup winner|league winner)\b/.test(
      text,
    )
  ) {
    return {
      marketType: "sports_outright",
      marketSegment: "sports_outright",
    };
  }

  return {
    marketType: "sports_outright",
    marketSegment: "sports_outright",
  };
}

export function classifyMarketTaxonomyFromText(
  text: string,
  hoursToClose: number | null,
): MarketTaxonomy {
  const looksSports =
    /\b(sports?|soccer|football|baseball|basketball|tennis|hockey|cricket|mma|boxing|esports?|counter-strike|counter strike|league of legends|dota|valorant|fifa|world cup|nba|nfl|mlb|nhl|wta|atp|bo3|bo5)\b/.test(
      text,
    );
  if (looksSports) {
    return classifySportsTaxonomy(text, hoursToClose);
  }

  if (
    /\b(election|president|parliament|senate|congress|iran|hormuz|strait|shipping|china|taiwan|russia|ukraine|war|ceasefire|nuclear|invasion|tariff|politics|geopolitics)\b/.test(
      text,
    )
  ) {
    return { marketType: "politics_geo", marketSegment: "politics_geo" };
  }

  if (/\b(bitcoin|btc)\b/.test(text)) {
    return { marketType: "crypto_macro", marketSegment: "crypto_btc" };
  }
  if (/\b(ethereum|ether|eth)\b/.test(text)) {
    return { marketType: "crypto_macro", marketSegment: "crypto_eth" };
  }
  if (
    /\b(crypto|solana|sol\b|xrp|bnb|ton\b|wlfi|mnt\b|doge|nfts?|pre-tge)\b/.test(
      text,
    )
  ) {
    return { marketType: "crypto_macro", marketSegment: "crypto_alt" };
  }
  if (/\b(fed|inflation|cpi|rates?|treasury|fomc)\b/.test(text)) {
    return { marketType: "crypto_macro", marketSegment: "macro_rates" };
  }
  if (/\b(oil|crude|gold|silver|xag|paxg|commodit)/.test(text)) {
    return { marketType: "crypto_macro", marketSegment: "macro_commodities" };
  }
  if (
    /\b(stock|stocks|equities|equity|s&p|spy|nasdaq|dow|kospi|coinbase|robinhood|microsoft|msft|intel|intc|tsm|oxy|tesla|nvda)\b/.test(
      text,
    )
  ) {
    return { marketType: "crypto_macro", marketSegment: "macro_equities" };
  }
  if (
    /\b(ai|artificial intelligence|openai|anthropic|claude|chatgpt|model|technology|tech)\b/.test(
      text,
    )
  ) {
    return { marketType: "other", marketSegment: "tech_ai" };
  }
  if (/\b(mentions?|tweets?|twitter|x posts?)\b/.test(text)) {
    return { marketType: "other", marketSegment: "mentions" };
  }
  if (
    /\b(entertainment|celebrity|movie|music|album|oscars?|grammys?|culture|jesus|aliens?)\b/.test(
      text,
    )
  ) {
    return { marketType: "other", marketSegment: "entertainment" };
  }
  if (/\b(weather|hurricane|temperature|rain|snow|climate)\b/.test(text)) {
    return { marketType: "other", marketSegment: "weather" };
  }
  if (/\b(health|covid|coronavirus|pandemic|medical|biotech)\b/.test(text)) {
    return { marketType: "other", marketSegment: "health" };
  }

  return { marketType: "other", marketSegment: "other" };
}

export function classifyMarketType(
  fields: MarketTypeFields,
  now: Date = new Date(),
): MarketType {
  return classifyMarketTaxonomy(fields, now).marketType;
}

export function classifyMarketSegment(
  fields: MarketTypeFields,
  now: Date = new Date(),
): MarketSegment {
  return classifyMarketTaxonomy(fields, now).marketSegment;
}

export function classifyMarketTaxonomy(
  fields: MarketTypeFields,
  now: Date = new Date(),
): MarketTaxonomy {
  return classifyMarketTaxonomyFromText(
    buildMarketTypeText(fields),
    computeMarketHoursToClose(fields, now),
  );
}

export function marketSegmentCategoryFamily(
  segment: MarketSegment,
): MarketCategoryFamily | null {
  if (segment.startsWith("sports_")) return "sports";
  if (segment === "politics_geo") return "politics";
  if (segment.startsWith("crypto_")) return "crypto";
  if (segment.startsWith("macro_")) return "macro";
  if (segment === "tech_ai") return "technology";
  if (segment === "weather") return "weather";
  if (segment === "health") return "health";
  if (segment === "mentions") return "mentions";
  if (segment === "entertainment") return "culture";
  return null;
}

export function formatMarketSegmentLabel(
  segment: MarketSegment | string | null | undefined,
): string {
  switch (segment) {
    case "sports_soccer_game":
      return "Soccer games";
    case "sports_tennis_game":
      return "Tennis games";
    case "sports_baseball_game":
      return "Baseball games";
    case "sports_basketball_game":
      return "Basketball games";
    case "sports_cricket_game":
      return "Cricket games";
    case "sports_esports_game":
      return "Esports games";
    case "sports_other_game":
      return "Sports games";
    case "sports_outright":
      return "Sports outrights";
    case "politics_geo":
      return "Geo / politics";
    case "crypto_btc":
      return "BTC";
    case "crypto_eth":
      return "ETH";
    case "crypto_alt":
      return "Crypto alts";
    case "macro_rates":
      return "Rates / Fed";
    case "macro_commodities":
      return "Commodities";
    case "macro_equities":
      return "Equities";
    case "tech_ai":
      return "AI / tech";
    case "mentions":
      return "Mentions";
    case "entertainment":
      return "Entertainment";
    case "weather":
      return "Weather";
    case "health":
      return "Health";
    case "other":
    case null:
    case undefined:
      return "Other";
    default:
      return segment
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}

export function formatMarketTypeLabel(
  marketType: MarketType | string | null | undefined,
): string {
  switch (marketType) {
    case "single_game_sports":
      return "Single-game sports";
    case "sports_outright":
      return "Sports outrights";
    case "politics_geo":
      return "Geo / politics";
    case "crypto_macro":
      return "Crypto / macro";
    case "other":
    case null:
    case undefined:
      return "Other";
    default:
      return marketType
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
  }
}
