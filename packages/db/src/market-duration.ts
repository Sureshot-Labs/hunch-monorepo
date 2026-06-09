export type MarketDurationVenue =
  | "polymarket"
  | "limitless"
  | "kalshi"
  | string;

type NullableString = string | null | undefined;

export type MarketDurationInput = {
  venue: MarketDurationVenue;
  seriesKey?: NullableString;
  stableSlug?: NullableString;
  slug?: NullableString;
  title?: NullableString;
  openTime?: Date | string | number | null;
  closeTime?: Date | string | number | null;
};

function normalized(value: NullableString): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length ? trimmed : null;
}

function toPositiveMinutes(value: string | number | null): number | null {
  if (value == null) return null;
  const minutes =
    typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return minutes;
}

function parseUnitMinutes(amount: string, unit: string): number | null {
  const minutes = toPositiveMinutes(amount);
  if (minutes == null) return null;
  const normalizedUnit = unit.toLowerCase();
  if (normalizedUnit.startsWith("h")) return minutes * 60;
  return minutes;
}

function parseDurationToken(value: NullableString): number | null {
  const text = normalized(value);
  if (!text) return null;

  const compact = text.match(/(?:^|-)(\d+)(m|h)(?:-|$)/);
  if (compact) {
    return parseUnitMinutes(compact[1] ?? "", compact[2] ?? "");
  }

  const minute = text.match(/(?:^|-)(\d+)min(?:ute)?s?(?:-|$)/);
  if (minute) return toPositiveMinutes(minute[1] ?? null);

  const hour = text.match(/(?:^|-)(\d+)hour(?:s)?(?:-|$)/);
  if (hour) return parseUnitMinutes(hour[1] ?? "", "hour");

  if (/(?:^|-)hourly(?:-|$)/.test(text)) return 60;
  return null;
}

export function derivePolymarketDurationMinutes(
  seriesKey?: NullableString,
): number | null {
  const text = normalized(seriesKey);
  if (!text) return null;
  const suffix = text.match(/(?:^|-)(\d+)(m|h)$/);
  if (suffix) {
    return parseUnitMinutes(suffix[1] ?? "", suffix[2] ?? "");
  }
  if (/(?:^|-)hourly$/.test(text)) return 60;
  return null;
}

function parseLimitlessIntervalFallback(
  slug?: NullableString,
  title?: NullableString,
): number | null {
  const slugText = normalized(slug);
  if (slugText && /(?:^|-)up-or-down-/.test(slugText)) {
    const slugMatch = slugText.match(
      /(?:^|-)up-or-down-(\d+)-(mins?|minutes?|hours?)(?:-|$)/,
    );
    if (slugMatch) {
      return parseUnitMinutes(slugMatch[1] ?? "", slugMatch[2] ?? "");
    }
  }

  const titleText = normalized(title);
  if (titleText && /\bup or down\b/.test(titleText)) {
    const titleMatch = titleText.match(
      /\bup or down\s*-\s*(\d+)\s*(mins?|minutes?|hours?)\b/,
    );
    if (titleMatch) {
      return parseUnitMinutes(titleMatch[1] ?? "", titleMatch[2] ?? "");
    }
  }

  return null;
}

export function deriveLimitlessDurationMinutes(input: {
  stableSlug?: NullableString;
  slug?: NullableString;
  title?: NullableString;
}): number | null {
  return (
    parseDurationToken(input.stableSlug) ??
    parseLimitlessIntervalFallback(input.slug, input.title)
  );
}

function toTimestampMs(value: MarketDurationInput["openTime"]): number | null {
  if (value == null) return null;
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function deriveExactWindowDurationMinutes(input: {
  openTime?: MarketDurationInput["openTime"];
  closeTime?: MarketDurationInput["closeTime"];
}): number | null {
  const openMs = toTimestampMs(input.openTime);
  const closeMs = toTimestampMs(input.closeTime);
  if (openMs == null || closeMs == null || closeMs <= openMs) return null;
  const minutes = (closeMs - openMs) / 60_000;
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  return minutes;
}

export function deriveMarketDurationMinutes(
  input: MarketDurationInput,
): number | null {
  switch (input.venue) {
    case "polymarket":
      return derivePolymarketDurationMinutes(input.seriesKey);
    case "limitless":
      return deriveLimitlessDurationMinutes({
        stableSlug: input.stableSlug,
        slug: input.slug,
        title: input.title,
      });
    case "kalshi":
      return deriveExactWindowDurationMinutes({
        openTime: input.openTime,
        closeTime: input.closeTime,
      });
    default:
      return null;
  }
}
