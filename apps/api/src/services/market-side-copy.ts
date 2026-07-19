import {
  outcomeLabelForSide,
  outcomeLabelOrSide,
  parseMarketOutcomes,
} from "./wallet-intel-helpers.js";

export type MarketSideCopySide = "NO" | "YES";

export type MarketSideCopyKind =
  | "generic"
  | "named_outcome"
  | "team_yes_no"
  | "total";

export type MarketSideCopyInput = {
  eventDescription?: string | null;
  eventTitle?: string | null;
  marketDescription?: string | null;
  marketSegment?: string | null;
  marketSlug?: string | null;
  marketTitle?: string | null;
  outcomes?: unknown;
  resolutionSource?: string | null;
  side: MarketSideCopySide;
};

export type MarketSideCopy = {
  buttonLabel: string;
  copyKind: MarketSideCopyKind;
  copyVersion: "market_side_copy_v1";
  marketLine: string | null;
  plainPosition: string;
  priceLabel: string;
  rawOutcomeLabel: string;
  side: MarketSideCopySide;
  sideLabel: string;
  winCondition: string | null;
};

const COPY_VERSION = "market_side_copy_v1" as const;
const SHORT_LABEL_MAX_CHARS = 24;
const BUTTON_LABEL_MAX_CHARS = 14;
const OUTCOME_LABEL_MAX_CHARS = 3;
const OUTCOME_LABEL_VOWELS = /[AEIOUY]/g;

export function cleanPublicMarketText(
  value: string | null | undefined,
): string | null {
  const cleaned =
    value
      ?.replace(/\s+[-–—]\s+More Markets(?=\s*(?:[.!?,;:])?(?:\s|$))/gi, "")
      .trim()
      .replace(/\s+/g, " ") ?? "";
  return cleaned.length > 0 ? cleaned : null;
}

function cleanText(value: string | null | undefined): string | null {
  return cleanPublicMarketText(value);
}

function normalizeAlnumUpper(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "").toUpperCase();
}

export function abbreviateMarketSideLabel(
  label: string,
  maxLength = OUTCOME_LABEL_MAX_CHARS,
): string {
  const trimmed = label.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;

  const words = trimmed
    .split(/[\s/_-]+/g)
    .map(normalizeAlnumUpper)
    .filter(Boolean);
  if (words.length > 1) {
    const initials = words.map((word) => word[0]).join("");
    if (initials.length >= maxLength) return initials.slice(0, maxLength);
    const consonantTail = words
      .map((word) => word.slice(1).replace(OUTCOME_LABEL_VOWELS, ""))
      .join("");
    const fallbackTail = words.map((word) => word.slice(1)).join("");
    return `${initials}${consonantTail}${fallbackTail}`.slice(0, maxLength);
  }

  const normalized = words[0] ?? normalizeAlnumUpper(trimmed);
  if (!normalized) return trimmed.toUpperCase().slice(0, maxLength);
  const consonants = normalized.replace(OUTCOME_LABEL_VOWELS, "");
  if (consonants.length >= maxLength) return consonants.slice(0, maxLength);
  if (normalized.length >= maxLength) return normalized.slice(0, maxLength);
  return normalized;
}

function readableLabel(
  label: string,
  maxLength = BUTTON_LABEL_MAX_CHARS,
): string {
  const trimmed = label.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return abbreviateMarketSideLabel(trimmed);
}

function sideWord(
  side: MarketSideCopySide,
  explicitLabel: string | null,
): "over" | "under" {
  const normalized = explicitLabel?.trim().toLowerCase();
  if (normalized === "over" || normalized === "under") return normalized;
  return side === "YES" ? "over" : "under";
}

function textBag(input: MarketSideCopyInput): string {
  return [
    input.eventTitle,
    input.marketTitle,
    input.marketSlug,
    input.marketDescription,
    input.eventDescription,
    input.resolutionSource,
  ]
    .map((value) => cleanText(value))
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
}

function parseTotalLine(input: MarketSideCopyInput): number | null {
  const text = textBag(input);
  const patterns = [
    /\bo\/u\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\bover\s*\/\s*under\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\b(?:total|goals?|points?|runs?)\s*(?:o\/u|over\s*\/\s*under)?\s*([0-9]+(?:\.[0-9]+)?)/i,
    /\b(?:over|under)\s*([0-9]+(?:\.[0-9]+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function isTotalMarket(
  input: MarketSideCopyInput,
  explicitLabel: string | null,
) {
  const label = explicitLabel?.trim().toLowerCase();
  if (label === "over" || label === "under") return true;
  return /\b(o\/u|over\s*\/\s*under|total goals?|total points?|total runs?)\b/i.test(
    textBag(input),
  );
}

function totalNoun(input: MarketSideCopyInput): string {
  const text = textBag(input);
  if (/\b(first half|1st half|first-half|1h)\b/i.test(text)) {
    if (/\bpoints?\b/i.test(text)) return "first-half points";
    if (/\bruns?\b/i.test(text)) return "first-half runs";
    return "first-half goals";
  }
  if (/\bpoints?\b/i.test(text)) return "total points";
  if (/\bruns?\b/i.test(text)) return "total runs";
  if (/\bgoals?\b/i.test(text) || /soccer|fifa|uefa|football/i.test(text)) {
    return "total goals";
  }
  return "total";
}

function totalWinCondition(
  line: number,
  direction: "over" | "under",
  noun: string,
): string {
  const floor = Math.floor(line);
  if (Number.isInteger(line)) {
    return direction === "over"
      ? `more than ${line} ${noun}`
      : `fewer than ${line} ${noun}`;
  }
  return direction === "over" ? `${floor + 1}+ ${noun}` : `0-${floor} ${noun}`;
}

function cleanGenericMarketTitle(input: MarketSideCopyInput): string | null {
  const title = cleanText(input.marketTitle);
  if (!title) return null;
  const winQuestion = title.match(/^will\s+(.+?)\s+win(?:\b|[?])/i);
  const candidate = cleanText(winQuestion?.[1] ?? title);
  if (!candidate || candidate.length > SHORT_LABEL_MAX_CHARS) return null;
  if (!winQuestion && /[?]/.test(candidate)) return null;
  if (/\b(vs\.?|versus|o\/u|over\/under|spread|handicap)\b/i.test(title)) {
    return null;
  }
  const normalized = candidate.replace(/^will\s+/i, "").replace(/\s+win$/i, "");
  const upper = normalized.toUpperCase();
  if (upper === "YES" || upper === "NO") return null;
  return normalized;
}

function buildMarketLine(
  input: MarketSideCopyInput,
  label: string,
): string | null {
  const event = cleanText(input.eventTitle);
  const market = cleanText(input.marketTitle);
  if (
    event &&
    market &&
    event.toLowerCase() === market.toLowerCase() &&
    label.toLowerCase().startsWith(event.toLowerCase())
  ) {
    return label;
  }
  if (event) return `${event} · ${label}`;
  if (market && market !== label) return `${market} · ${label}`;
  return market ?? label;
}

function buildGenericBinaryMarketLine(
  input: MarketSideCopyInput,
  genericTitle: string,
): string | null {
  const event = cleanText(input.eventTitle);
  const market = cleanText(input.marketTitle);
  if (market && /^will\s+/i.test(market)) return market;
  if (event && event.toLowerCase() === genericTitle.toLowerCase()) return event;
  if (event) return `${event} · ${genericTitle}`;
  if (market && market.toLowerCase() !== genericTitle.toLowerCase()) {
    return `${market} · ${genericTitle}`;
  }
  return market ?? genericTitle;
}

function buildFallbackCopy(input: MarketSideCopyInput): MarketSideCopy {
  const rawOutcomeLabel = outcomeLabelOrSide(input.outcomes, input.side);
  const explicitOutcomeLabel = outcomeLabelForSide(input.outcomes, input.side);
  const explicitClean = cleanText(explicitOutcomeLabel);
  const rawClean = cleanText(rawOutcomeLabel) ?? input.side;
  const genericTitle = cleanGenericMarketTitle(input);
  const isRawSide = rawClean.toUpperCase() === input.side;
  const copyKind: MarketSideCopyKind = explicitClean
    ? "named_outcome"
    : genericTitle
      ? "team_yes_no"
      : "generic";
  const fullLabel = explicitClean
    ? readableLabel(explicitClean)
    : genericTitle
      ? input.side
      : isRawSide
        ? input.side
        : readableLabel(rawClean);
  const sideLabel = readableLabel(fullLabel);
  const plainPosition =
    copyKind === "team_yes_no" && genericTitle
      ? input.side === "YES"
        ? `backing ${genericTitle}`
        : `fading ${genericTitle}`
      : sideLabel;
  return {
    buttonLabel: readableLabel(fullLabel),
    copyKind,
    copyVersion: COPY_VERSION,
    marketLine:
      copyKind === "team_yes_no" && genericTitle
        ? buildGenericBinaryMarketLine(input, genericTitle)
        : buildMarketLine(input, sideLabel),
    plainPosition,
    priceLabel: copyKind === "team_yes_no" ? input.side : sideLabel,
    rawOutcomeLabel: rawClean,
    side: input.side,
    sideLabel,
    winCondition: null,
  };
}

export function buildMarketSideCopy(
  input: MarketSideCopyInput,
): MarketSideCopy {
  const outcomes = parseMarketOutcomes(input.outcomes);
  const explicitOutcomeLabel = outcomeLabelForSide(outcomes, input.side);
  if (isTotalMarket(input, explicitOutcomeLabel)) {
    const line = parseTotalLine(input);
    if (line != null) {
      const direction = sideWord(input.side, explicitOutcomeLabel);
      const noun = totalNoun(input);
      const sideLabel = `${direction === "over" ? "Over" : "Under"} ${line} ${noun}`;
      return {
        buttonLabel: sideLabel,
        copyKind: "total",
        copyVersion: COPY_VERSION,
        marketLine: buildMarketLine(input, sideLabel),
        plainPosition: sideLabel,
        priceLabel: sideLabel,
        rawOutcomeLabel: explicitOutcomeLabel ?? input.side,
        side: input.side,
        sideLabel,
        winCondition: totalWinCondition(line, direction, noun),
      };
    }
  }
  return buildFallbackCopy({ ...input, outcomes });
}

export function buildMarketSideCopyPair(
  input: Omit<MarketSideCopyInput, "side">,
): Record<MarketSideCopySide, MarketSideCopy> {
  return {
    YES: buildMarketSideCopy({ ...input, side: "YES" }),
    NO: buildMarketSideCopy({ ...input, side: "NO" }),
  };
}
