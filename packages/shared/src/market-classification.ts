export type CanonicalMarketCategory =
  | "sports"
  | "politics"
  | "crypto"
  | "macro"
  | "tech"
  | "weather"
  | "health"
  | "culture";

export type MarketCategory =
  | CanonicalMarketCategory
  | "mentions"
  | "other"
  | "economics"
  | "technology"
  | "entertainment";

export type MarketCategorySource =
  | "embedded_metadata"
  | "source_category"
  | "source_tag"
  | "text_keyword";

export type MarketCategoryConfidence = "high" | "medium";

export interface MarketCategoryResolution {
  category?: CanonicalMarketCategory | "mentions" | "other";
  categorySource?: MarketCategorySource;
  categoryConfidence?: MarketCategoryConfidence;
  matchedToken?: string;
}

export interface MarketCategoryResolutionInput {
  metadata?: Record<string, unknown> | null;
  sourceCategory?: string | null;
  sourceCategories?: readonly (string | null | undefined)[] | null;
  tags?: unknown;
  title?: string | null;
  description?: string | null;
}

export type MarketTextDateSource =
  | "explicit_utc_deadline"
  | "explicit_et_deadline"
  | "date_only_us_eastern_deadline"
  | "scheduled_et";

export interface MarketTextDates {
  deadlineTime?: Date;
  deadlineSource?: MarketTextDateSource;
  deadlineText?: string;
  deadlineAssumption?: string;
  scheduledTime?: Date;
  scheduledSource?: MarketTextDateSource;
  scheduledText?: string;
}

const CATEGORY_PRIORITY: readonly (CanonicalMarketCategory | "mentions")[] = [
  "mentions",
  "politics",
  "crypto",
  "sports",
  "macro",
  "tech",
  "culture",
  "weather",
  "health",
];

const IGNORE_CATEGORY_TOKENS = new Set([
  "15-min",
  "15m",
  "1h",
  "1d",
  "daily",
  "hourly",
  "monthly",
  "recurring",
  "weekly",
]);

const EXPLICIT_CATEGORY_MAP = new Map<
  string,
  CanonicalMarketCategory | "mentions" | "other"
>([
  ["mentions", "mentions"],
  ["mention", "mentions"],
  ["mention-markets", "mentions"],
  ["tweet-markets", "mentions"],
  ["tweets-markets", "mentions"],

  ["politics", "politics"],
  ["politic", "politics"],
  ["geopolitics", "politics"],
  ["global-politics", "politics"],
  ["global politics", "politics"],
  ["foreign-policy", "politics"],
  ["foreign policy", "politics"],
  ["world", "politics"],
  ["macro-geopolitics", "politics"],
  ["macro geopolitics", "politics"],
  ["military", "politics"],
  ["elections", "politics"],
  ["election", "politics"],
  ["ukraine", "politics"],
  ["ukraine-&-russia", "politics"],
  ["ukraine & russia", "politics"],
  ["iran", "politics"],
  ["israel", "politics"],
  ["middle-east", "politics"],
  ["middle east", "politics"],
  ["us-current-affairs", "politics"],
  ["current-affairs", "politics"],

  ["crypto", "crypto"],
  ["cryptocurrency", "crypto"],
  ["crypto-prices", "crypto"],
  ["crypto prices", "crypto"],
  ["bitcoin", "crypto"],
  ["btc", "crypto"],
  ["ethereum", "crypto"],
  ["eth", "crypto"],
  ["solana", "crypto"],
  ["xrp", "crypto"],
  ["ripple", "crypto"],
  ["nft", "crypto"],
  ["nfts", "crypto"],
  ["defi", "crypto"],
  ["pre-tge", "crypto"],
  ["nav-domain-crypto", "crypto"],

  ["sports", "sports"],
  ["sport", "sports"],
  ["games", "sports"],
  ["football", "sports"],
  ["football-matches", "sports"],
  ["football matches", "sports"],
  ["nba", "sports"],
  ["nba-playoffs", "sports"],
  ["nfl", "sports"],
  ["nhl", "sports"],
  ["mlb", "sports"],
  ["soccer", "sports"],
  ["basketball", "sports"],
  ["baseball", "sports"],
  ["hockey", "sports"],
  ["tennis", "sports"],
  ["cricket", "sports"],
  ["f1", "sports"],
  ["olympics", "sports"],
  ["winter-olympics", "sports"],
  ["esports", "sports"],
  ["counter-strike", "sports"],
  ["counter-strike-2", "sports"],
  ["cs2", "sports"],
  ["dota-2", "sports"],
  ["league-of-legends", "sports"],
  ["lol", "sports"],
  ["valorant", "sports"],
  ["honor-of-kings", "sports"],
  ["chess", "sports"],
  ["poker", "sports"],
  ["ufc", "sports"],
  ["ncaa", "sports"],
  ["ncaa-basketball", "sports"],
  ["cwbb", "sports"],
  ["cbb", "sports"],
  ["cfb", "sports"],
  ["epl", "sports"],
  ["premier-league", "sports"],
  ["efl-championship", "sports"],
  ["international-cricket", "sports"],
  ["la-liga", "sports"],
  ["mls", "sports"],
  ["bundesliga", "sports"],
  ["ligue-1", "sports"],
  ["khl", "sports"],
  ["ucl", "sports"],
  ["uel", "sports"],
  ["wnba", "sports"],
  ["brazil-serie-a", "sports"],
  ["saudi-professional-league", "sports"],
  ["serie-b", "sports"],
  ["champions-league", "sports"],
  ["euroleague-basketball", "sports"],
  ["primeira-liga", "sports"],
  ["fa-cup", "sports"],
  ["ligue-2", "sports"],
  ["fifa-friendly", "sports"],
  ["off-the-pitch", "sports"],
  ["nav-domain-sports", "sports"],
  ["nav-domain-sport", "sports"],

  ["macro", "macro"],
  ["economics", "macro"],
  ["economy", "macro"],
  ["finance", "macro"],
  ["financials", "macro"],
  ["business", "macro"],
  ["companies", "macro"],
  ["company-news", "macro"],
  ["company news", "macro"],
  ["commodities", "macro"],
  ["oil-gas", "macro"],
  ["oil & gas", "macro"],
  ["oil-and-gas", "macro"],
  ["korean-market", "macro"],
  ["nav-domain-finance", "macro"],

  ["tech", "tech"],
  ["technology", "tech"],
  ["science", "tech"],
  ["science-and-technology", "tech"],
  ["science and technology", "tech"],
  ["space", "tech"],
  ["ai", "tech"],
  ["big-tech", "tech"],
  ["nav-domain-technology", "tech"],

  ["culture", "culture"],
  ["entertainment", "culture"],
  ["pop-culture", "culture"],
  ["pop culture", "culture"],
  ["movies", "culture"],
  ["music", "culture"],
  ["awards", "culture"],
  ["celebrities", "culture"],
  ["art", "culture"],

  ["weather", "weather"],
  ["climate", "weather"],
  ["climate-and-weather", "weather"],
  ["climate and weather", "weather"],
  ["temperature", "weather"],

  ["health", "health"],
  ["medical", "health"],
  ["covid", "health"],
  ["coronavirus", "health"],
  ["pandemic", "health"],
  ["biotech", "health"],

  ["other", "other"],
]);

const TOKEN_SCORES: Record<CanonicalMarketCategory | "mentions", string[]> = {
  mentions: ["mention-markets", "tweets-markets"],
  politics: [
    "election",
    "elections",
    "president",
    "congress",
    "senate",
    "vote",
    "candidate",
    "government",
    "policy",
    "democrat",
    "republican",
    "biden",
    "trump",
    "iran",
    "israel",
    "ukraine",
    "russia",
    "ceasefire",
    "war",
    "sanctions",
    "putin",
  ],
  crypto: [
    "bitcoin",
    "btc",
    "ethereum",
    "eth",
    "crypto",
    "blockchain",
    "defi",
    "nft",
    "solana",
    "xrp",
    "ripple",
    "doge",
    "dogecoin",
    "hype",
    "token",
  ],
  sports: [
    "nfl",
    "nba",
    "mlb",
    "nhl",
    "soccer",
    "football",
    "basketball",
    "baseball",
    "hockey",
    "tennis",
    "cricket",
    "olympics",
    "championship",
    "playoff",
    "match",
    "ufc",
    "fifa",
    "esports",
  ],
  macro: [
    "fed",
    "fomc",
    "cpi",
    "pce",
    "inflation",
    "rates",
    "rate",
    "treasury",
    "unemployment",
    "payrolls",
    "jobs",
    "gdp",
    "recession",
    "economy",
    "economic",
    "finance",
    "earnings",
    "stocks",
    "commodities",
    "oil",
  ],
  tech: [
    "ai",
    "tech",
    "technology",
    "apple",
    "google",
    "microsoft",
    "tesla",
    "meta",
    "amazon",
    "openai",
    "spacex",
    "space",
  ],
  culture: [
    "movie",
    "film",
    "oscar",
    "netflix",
    "disney",
    "marvel",
    "celebrity",
    "music",
    "award",
    "grammy",
    "culture",
  ],
  weather: [
    "hurricane",
    "tornado",
    "weather",
    "climate",
    "temperature",
    "snow",
    "storm",
    "rain",
    "wildfire",
  ],
  health: [
    "covid",
    "pandemic",
    "vaccine",
    "health",
    "medical",
    "disease",
    "hospital",
    "biotech",
  ],
};

const PHRASE_SCORES: Record<CanonicalMarketCategory, readonly RegExp[]> = {
  politics: [/foreign policy/i, /middle east/i],
  crypto: [/crypto prices/i],
  sports: [/super bowl/i, /world cup/i],
  macro: [
    /federal reserve/i,
    /interest rates?/i,
    /rate (cut|hike|change)/i,
    /fed funds?/i,
    /jobs report/i,
    /consumer price index/i,
  ],
  tech: [/artificial intelligence/i],
  culture: [/star wars/i],
  weather: [/climate and weather/i],
  health: [/public health/i],
};

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeCategory(
  value: string | null | undefined,
): CanonicalMarketCategory | "mentions" | "other" | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return (
    EXPLICIT_CATEGORY_MAP.get(trimmed.toLowerCase()) ??
    EXPLICIT_CATEGORY_MAP.get(normalizeToken(trimmed))
  );
}

function extractMetadataCategory(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!metadata) return undefined;
  for (const key of ["category", "navCategory", "domain"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function tagToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeToken(value);
  return normalized || undefined;
}

function extractTagTokens(tags: unknown): string[] {
  const out = new Set<string>();
  const push = (value: unknown) => {
    const token = tagToken(value);
    if (token) out.add(token);
  };
  if (typeof tags === "string") {
    push(tags);
  } else if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === "string") {
        push(tag);
        continue;
      }
      if (!tag || typeof tag !== "object") continue;
      const record = tag as Record<string, unknown>;
      push(record.slug);
      push(record.label);
      push(record.name);
      push(record.title);
    }
  }
  return Array.from(out);
}

function textTokens(...inputs: Array<string | null | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const input of inputs) {
    if (!input) continue;
    const matches = input.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g);
    for (const token of matches ?? []) tokens.add(token);
  }
  return tokens;
}

function scoreTokens(tokens: readonly string[]): {
  category?: CanonicalMarketCategory | "mentions";
  matchedToken?: string;
} {
  const scores = new Map<CanonicalMarketCategory | "mentions", number>();
  const matched = new Map<CanonicalMarketCategory | "mentions", string>();
  for (const rawToken of tokens) {
    const token = normalizeToken(rawToken);
    if (!token || IGNORE_CATEGORY_TOKENS.has(token)) continue;
    const explicit = normalizeCategory(token);
    if (explicit && explicit !== "other") {
      const weight = explicit === "mentions" ? 10 : 3;
      scores.set(explicit, (scores.get(explicit) ?? 0) + weight);
      matched.set(explicit, token);
      continue;
    }
    for (const category of CATEGORY_PRIORITY) {
      if (!TOKEN_SCORES[category].includes(token)) continue;
      scores.set(category, (scores.get(category) ?? 0) + 1);
      matched.set(category, token);
    }
  }

  let best: {
    category: CanonicalMarketCategory | "mentions";
    score: number;
  } | null = null;
  let tied = false;
  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category);
    if (score == null) continue;
    if (!best || score > best.score) {
      best = { category, score };
      tied = false;
      continue;
    }
    if (best && score === best.score) tied = true;
  }

  if (!best || tied) return {};
  return {
    category: best.category,
    matchedToken: matched.get(best.category),
  };
}

function scoreText(
  title?: string | null,
  description?: string | null,
): {
  category?: CanonicalMarketCategory | "mentions";
  matchedToken?: string;
} {
  const text = `${title ?? ""} ${description ?? ""}`.trim();
  if (!text) return {};
  const tokens = textTokens(text);
  const tokenResult = scoreTokens(Array.from(tokens));

  const scores = new Map<CanonicalMarketCategory | "mentions", number>();
  if (tokenResult.category) {
    scores.set(tokenResult.category, 1);
  }
  const matched = new Map<CanonicalMarketCategory | "mentions", string>();
  if (tokenResult.category && tokenResult.matchedToken) {
    matched.set(tokenResult.category, tokenResult.matchedToken);
  }
  for (const [category, patterns] of Object.entries(PHRASE_SCORES) as Array<
    [CanonicalMarketCategory, readonly RegExp[]]
  >) {
    for (const pattern of patterns) {
      if (!pattern.test(text)) continue;
      scores.set(category, (scores.get(category) ?? 0) + 2);
      matched.set(category, pattern.source);
    }
  }

  let best: {
    category: CanonicalMarketCategory | "mentions";
    score: number;
  } | null = null;
  let tied = false;
  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category);
    if (score == null) continue;
    if (!best || score > best.score) {
      best = { category, score };
      tied = false;
      continue;
    }
    if (best && score === best.score) tied = true;
  }
  if (!best || tied) return {};
  return {
    category: best.category,
    matchedToken: matched.get(best.category),
  };
}

function resolveFromValues(values: readonly (string | null | undefined)[]): {
  category?: CanonicalMarketCategory | "mentions" | "other";
  token?: string;
} {
  for (const value of values) {
    const category = normalizeCategory(value);
    if (category) return { category, token: value ?? undefined };
  }
  return {};
}

export function resolveMarketCategory(
  input: MarketCategoryResolutionInput,
): MarketCategoryResolution {
  const metadataCategory = extractMetadataCategory(input.metadata);
  const fromMetadata = resolveFromValues([metadataCategory]);
  if (fromMetadata.category) {
    return {
      category: fromMetadata.category,
      categorySource: "embedded_metadata",
      categoryConfidence: "high",
      matchedToken: fromMetadata.token,
    };
  }

  const fromSource = resolveFromValues([
    input.sourceCategory,
    ...(input.sourceCategories ?? []),
  ]);
  if (fromSource.category) {
    return {
      category: fromSource.category,
      categorySource: "source_category",
      categoryConfidence: "high",
      matchedToken: fromSource.token,
    };
  }

  const tagTokens = extractTagTokens(input.tags);
  const fromTags = scoreTokens(tagTokens);
  if (fromTags.category) {
    return {
      category: fromTags.category,
      categorySource: "source_tag",
      categoryConfidence: "high",
      matchedToken: fromTags.matchedToken,
    };
  }

  const fromText = scoreText(input.title, input.description);
  if (fromText.category) {
    return {
      category: fromText.category,
      categorySource: "text_keyword",
      categoryConfidence: "medium",
      matchedToken: fromText.matchedToken,
    };
  }

  return {};
}

function parseMonth(value: string): number | undefined {
  return MONTH_INDEX[value.toLowerCase()];
}

function parseClock(
  hourText: string,
  minuteText: string,
  meridiem?: string,
): { hour: number; minute: number } | undefined {
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return undefined;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;
  const suffix = meridiem?.toLowerCase();
  if (suffix) {
    if (hour < 1 || hour > 12) return undefined;
    if (suffix === "pm" && hour !== 12) hour += 12;
    if (suffix === "am" && hour === 12) hour = 0;
  }
  return { hour, minute };
}

function timezoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type === "literal") continue;
    values[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    values.year,
    (values.month ?? 1) - 1,
    values.day,
    values.hour,
    values.minute,
    values.second,
  );
  return (asUtc - date.getTime()) / 60_000;
}

function dateTimeInZoneToUtc(
  year: number,
  monthIndex: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | undefined {
  const naiveUtc = Date.UTC(year, monthIndex, day, hour, minute, 0, 0);
  if (!Number.isFinite(naiveUtc)) return undefined;
  let guess = new Date(naiveUtc);
  for (let i = 0; i < 2; i += 1) {
    const offset = timezoneOffsetMinutes(guess, timeZone);
    guess = new Date(naiveUtc - offset * 60_000);
  }
  return Number.isFinite(guess.getTime()) ? guess : undefined;
}

function parseUtcDeadline(text: string): MarketTextDates | undefined {
  const match =
    /\bby\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\s+UTC\b/i.exec(
      text,
    );
  if (!match) return undefined;
  const [, monthName, day, year, hour, minute, meridiem] = match;
  const month = parseMonth(monthName);
  const clock = parseClock(hour, minute, meridiem);
  if (month == null || !clock) return undefined;
  const timestamp = Date.UTC(
    Number(year),
    month,
    Number(day),
    clock.hour,
    clock.minute,
  );
  if (!Number.isFinite(timestamp)) return undefined;
  return {
    deadlineTime: new Date(timestamp),
    deadlineSource: "explicit_utc_deadline",
    deadlineText: match[0],
  };
}

function parseEtDeadline(text: string): MarketTextDates | undefined {
  const match =
    /\bby\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\s+ET\s+on\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/i.exec(
      text,
    );
  if (!match) return undefined;
  const [, hour, minute, meridiem, monthName, day, year] = match;
  const month = parseMonth(monthName);
  const clock = parseClock(hour, minute, meridiem);
  if (month == null || !clock) return undefined;
  const date = dateTimeInZoneToUtc(
    Number(year),
    month,
    Number(day),
    clock.hour,
    clock.minute,
    "America/New_York",
  );
  if (!date) return undefined;
  return {
    deadlineTime: date,
    deadlineSource: "explicit_et_deadline",
    deadlineText: match[0],
  };
}

function parseScheduledEt(text: string): MarketTextDates | undefined {
  const match =
    /\bscheduled\s+for\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+ET\b/i.exec(
      text,
    );
  if (!match) return undefined;
  const [, monthName, day, year, hour, minute, meridiem] = match;
  const month = parseMonth(monthName);
  const clock = parseClock(hour, minute, meridiem);
  if (month == null || !clock) return undefined;
  const date = dateTimeInZoneToUtc(
    Number(year),
    month,
    Number(day),
    clock.hour,
    clock.minute,
    "America/New_York",
  );
  if (!date) return undefined;
  return {
    scheduledTime: date,
    scheduledSource: "scheduled_et",
    scheduledText: match[0],
  };
}

function parseDateOnlyUsEasternDeadline(
  text: string,
  allow: boolean,
): MarketTextDates | undefined {
  if (!allow) return undefined;
  const match = /\bby\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?!\s+at\b)/i.exec(
    text,
  );
  if (!match) return undefined;
  const [, monthName, day, year] = match;
  const month = parseMonth(monthName);
  if (month == null) return undefined;
  const date = dateTimeInZoneToUtc(
    Number(year),
    month,
    Number(day),
    23,
    59,
    "America/New_York",
  );
  if (!date) return undefined;
  return {
    deadlineTime: date,
    deadlineSource: "date_only_us_eastern_deadline",
    deadlineText: match[0],
    deadlineAssumption: "date_only_deadline_interpreted_as_23:59_ET",
  };
}

export function parseMarketTextDates(input: {
  text?: string | null;
  allowDateOnlyUsEasternDeadline?: boolean;
}): MarketTextDates {
  const text = input.text?.trim();
  if (!text) return {};
  return {
    ...(parseScheduledEt(text) ?? {}),
    ...(parseUtcDeadline(text) ??
      parseEtDeadline(text) ??
      parseDateOnlyUsEasternDeadline(
        text,
        input.allowDateOnlyUsEasternDeadline ?? false,
      ) ??
      {}),
  };
}
