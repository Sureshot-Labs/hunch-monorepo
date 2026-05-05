export type SignalMarketContractMatchInput = {
  evidenceText: string;
  eventTitle: string;
  marketTitle: string | null;
  closeTime?: string | null;
  referenceTime?: Date;
};

export type SignalTargetAnchorAlignmentInput = {
  evidenceText: string;
  eventTitle: string | null;
  marketTitle: string | null;
};

export type SignalTargetAnchorAlignment = {
  score: number;
  evidenceAnchors: string[];
  targetAnchors: string[];
  overlap: string[];
  hasStrongEvidenceAnchors: boolean;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeText(value: string): string {
  return value
    .replace(/[↑]/g, " up ")
    .replace(/[↓]/g, " down ")
    .replace(/[–—-]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type TokenStats = {
  count: number;
  sawAllCaps: boolean;
  sawDigits: boolean;
  sawLeadingCapital: boolean;
};

const ALIGNMENT_STOPWORDS = new Set([
  "about",
  "after",
  "ahead",
  "around",
  "before",
  "between",
  "close",
  "contract",
  "contracts",
  "event",
  "events",
  "game",
  "games",
  "headline",
  "latest",
  "line",
  "market",
  "markets",
  "match",
  "matches",
  "news",
  "odds",
  "official",
  "price",
  "prices",
  "report",
  "reported",
  "reports",
  "result",
  "results",
  "season",
  "signal",
  "state",
  "status",
  "team",
  "teams",
  "today",
  "tomorrow",
  "tonight",
  "update",
  "updated",
  "updates",
  "week",
  "winner",
  "winners",
  "year",
  "years",
]);

function collectTokenStats(value: string): Map<string, TokenStats> {
  const out = new Map<string, TokenStats>();
  const matches = value.match(/[A-Za-z0-9]+/g) ?? [];
  for (const rawToken of matches) {
    const token = normalizeText(rawToken);
    if (token.length < 3) continue;
    if (ALIGNMENT_STOPWORDS.has(token)) continue;
    const stats = out.get(token) ?? {
      count: 0,
      sawAllCaps: false,
      sawDigits: false,
      sawLeadingCapital: false,
    };
    stats.count += 1;
    const lettersOnly = rawToken.replace(/[^A-Za-z]/g, "");
    if (
      lettersOnly.length >= 2 &&
      lettersOnly === lettersOnly.toUpperCase() &&
      lettersOnly !== lettersOnly.toLowerCase()
    ) {
      stats.sawAllCaps = true;
    }
    if (/\d/.test(rawToken)) stats.sawDigits = true;
    if (/^[A-Z][a-z]/.test(rawToken)) stats.sawLeadingCapital = true;
    out.set(token, stats);
  }
  return out;
}

function sortAnchors(stats: Map<string, TokenStats>): string[] {
  return [...stats.entries()]
    .sort(
      (left, right) =>
        right[1].count - left[1].count ||
        Number(right[1].sawAllCaps) - Number(left[1].sawAllCaps) ||
        Number(right[1].sawDigits) - Number(left[1].sawDigits) ||
        right[0].length - left[0].length ||
        left[0].localeCompare(right[0]),
    )
    .map(([token]) => token);
}

function extractEvidenceAnchors(value: string): string[] {
  const stats = collectTokenStats(value);
  const anchors = new Map<string, TokenStats>();
  for (const [token, tokenStats] of stats.entries()) {
    if (
      tokenStats.sawAllCaps ||
      tokenStats.sawDigits ||
      tokenStats.sawLeadingCapital ||
      (tokenStats.count >= 2 && token.length >= 4)
    ) {
      anchors.set(token, tokenStats);
    }
  }
  return sortAnchors(anchors).slice(0, 8);
}

function extractTargetAnchors(value: string): string[] {
  const stats = collectTokenStats(value);
  const anchors = new Map<string, TokenStats>();
  for (const [token, tokenStats] of stats.entries()) {
    if (tokenStats.sawAllCaps || tokenStats.sawDigits || token.length >= 4) {
      anchors.set(token, tokenStats);
    }
  }
  return sortAnchors(anchors).slice(0, 12);
}

function tokenSet(value: string): Set<string> {
  const out = new Set<string>();
  for (const token of normalizeText(value).split(" ")) {
    if (token.length < 3) continue;
    out.add(token);
  }
  return out;
}

function lexicalSimilarity(a: string, b: string): number {
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap += 1;
  }
  const denom = Math.sqrt(aTokens.size * bTokens.size);
  if (denom <= 0) return 0;
  return clamp01(overlap / denom);
}

function parseScaledNumber(rawValue: string, suffix: string): number | null {
  const numeric = Number(rawValue.replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  const normalizedSuffix = suffix.trim().toLowerCase();
  if (normalizedSuffix === "k") return numeric * 1_000;
  if (normalizedSuffix === "m") return numeric * 1_000_000;
  if (normalizedSuffix === "b") return numeric * 1_000_000_000;
  if (normalizedSuffix === "t") return numeric * 1_000_000_000_000;
  return numeric;
}

function extractNumericAnchors(value: string): number[] {
  const out: number[] = [];
  const seen = new Set<string>();
  const regex = /(?:[$€£])?\s*(\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*([kmbt]))?/gi;
  for (const match of value.matchAll(regex)) {
    const rawValue = match[1] ?? "";
    const suffix = match[2] ?? "";
    const parsed = parseScaledNumber(rawValue, suffix);
    if (parsed == null) continue;
    if (parsed >= 1900 && parsed <= 2100 && Number.isInteger(parsed)) {
      continue;
    }
    const rounded = Number(parsed.toFixed(6));
    const key = rounded.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rounded);
  }
  return out;
}

function numericAnchorScore(
  evidence: number[],
  candidate: number[],
): number | null {
  if (evidence.length === 0 || candidate.length === 0) return null;
  let total = 0;
  for (const evidenceValue of evidence) {
    let best = 0;
    for (const candidateValue of candidate) {
      const denom = Math.max(
        Math.abs(evidenceValue),
        Math.abs(candidateValue),
        1,
      );
      const closeness =
        1 - Math.min(1, Math.abs(evidenceValue - candidateValue) / denom);
      if (closeness > best) best = closeness;
    }
    total += best;
  }
  return clamp01(total / evidence.length);
}

type OperatorClass =
  | "above"
  | "below"
  | "winner"
  | "nominee"
  | "deadline"
  | "after"
  | "up"
  | "down";

const OPERATOR_PATTERNS: Array<{ key: OperatorClass; patterns: RegExp[] }> = [
  {
    key: "above",
    patterns: [
      /\babove\b/i,
      /\bover\b/i,
      /\bat least\b/i,
      /\bor above\b/i,
      /\bhigher than\b/i,
      /\bexceed(?:s|ed|ing)?\b/i,
    ],
  },
  {
    key: "below",
    patterns: [
      /\bbelow\b/i,
      /\bunder\b/i,
      /\bat most\b/i,
      /\bor below\b/i,
      /\blower than\b/i,
      /\bless than\b/i,
      /\bfewer than\b/i,
    ],
  },
  {
    key: "winner",
    patterns: [
      /\bwinner\b/i,
      /\bmatch winner\b/i,
      /\bto win\b/i,
      /\bwins?\b/i,
      /\bchampion\b/i,
      /\badvance(?:s|d|ing)?\b/i,
      /\bqualif(?:y|ies|ied|ying)\b/i,
      /\bbeat(?:s|ing)?\b/i,
      /\bdefeat(?:s|ed|ing)?\b/i,
    ],
  },
  {
    key: "nominee",
    patterns: [/\bnominee?\b/i, /\bnomination\b/i, /\bprimary\b/i],
  },
  {
    key: "deadline",
    patterns: [
      /\bby\b/i,
      /\bbefore\b/i,
      /\bdeadline\b/i,
      /\bend of\b/i,
      /\bthrough\b/i,
    ],
  },
  {
    key: "after",
    patterns: [/\bafter\b/i, /\bfollowing\b/i],
  },
  {
    key: "up",
    patterns: [
      /\bup\b/i,
      /\brise\b/i,
      /\braise\b/i,
      /\bincrease\b/i,
      /\bhike\b/i,
    ],
  },
  {
    key: "down",
    patterns: [
      /\bdown\b/i,
      /\bfall\b/i,
      /\blower\b/i,
      /\bdecrease\b/i,
      /\bcut\b/i,
    ],
  },
];

function extractOperatorAnchors(value: string): Set<OperatorClass> {
  const out = new Set<OperatorClass>();
  for (const entry of OPERATOR_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(value))) {
      out.add(entry.key);
    }
  }
  return out;
}

function operatorAnchorScore(
  evidence: Set<OperatorClass>,
  candidate: Set<OperatorClass>,
): number | null {
  if (evidence.size === 0 || candidate.size === 0) return null;
  let overlap = 0;
  for (const key of evidence) {
    if (candidate.has(key)) overlap += 1;
  }
  return clamp01(overlap / evidence.size);
}

const MONTH_PATTERNS: Array<{ key: string; patterns: RegExp[] }> = [
  { key: "jan", patterns: [/\bjanuary\b/i, /\bjan\b/i] },
  { key: "feb", patterns: [/\bfebruary\b/i, /\bfeb\b/i] },
  { key: "mar", patterns: [/\bmarch\b/i, /\bmar\b/i] },
  { key: "apr", patterns: [/\bapril\b/i, /\bapr\b/i] },
  { key: "may", patterns: [/\bmay\b/i] },
  { key: "jun", patterns: [/\bjune\b/i, /\bjun\b/i] },
  { key: "jul", patterns: [/\bjuly\b/i, /\bjul\b/i] },
  { key: "aug", patterns: [/\baugust\b/i, /\baug\b/i] },
  { key: "sep", patterns: [/\bseptember\b/i, /\bsep\b/i, /\bsept\b/i] },
  { key: "oct", patterns: [/\boctober\b/i, /\boct\b/i] },
  { key: "nov", patterns: [/\bnovember\b/i, /\bnov\b/i] },
  { key: "dec", patterns: [/\bdecember\b/i, /\bdec\b/i] },
];

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function extractTimeAnchors(
  value: string,
  closeTime?: string | null,
  referenceTime?: Date,
): Set<string> {
  const out = new Set<string>();
  for (const entry of MONTH_PATTERNS) {
    if (entry.patterns.some((pattern) => pattern.test(value))) {
      out.add(entry.key);
    }
  }

  const lower = value.toLowerCase();
  if (lower.includes("today") || lower.includes("tonight")) out.add("today");
  if (lower.includes("tomorrow")) out.add("tomorrow");
  if (lower.includes("this week")) out.add("this_week");
  if (lower.includes("next week")) out.add("next_week");
  if (lower.includes("this month")) out.add("this_month");
  if (lower.includes("next month")) out.add("next_month");
  if (lower.includes("this year")) out.add("this_year");
  if (lower.includes("next year")) out.add("next_year");
  if (lower.includes("end of month")) out.add("end_of_month");
  if (lower.includes("end of year")) out.add("end_of_year");

  if (!closeTime) return out;
  const parsed = new Date(closeTime);
  if (Number.isNaN(parsed.getTime())) return out;
  const now = referenceTime ?? new Date();
  const monthKey =
    MONTH_PATTERNS[Math.max(0, Math.min(11, parsed.getUTCMonth()))]?.key;
  if (monthKey) out.add(monthKey);
  if (sameUtcDay(parsed, now)) out.add("today");

  const tomorrow = new Date(now.getTime());
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (sameUtcDay(parsed, tomorrow)) out.add("tomorrow");

  if (
    parsed.getUTCFullYear() === now.getUTCFullYear() &&
    parsed.getUTCMonth() === now.getUTCMonth()
  ) {
    out.add("this_month");
  }
  const nextMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  if (
    parsed.getUTCFullYear() === nextMonth.getUTCFullYear() &&
    parsed.getUTCMonth() === nextMonth.getUTCMonth()
  ) {
    out.add("next_month");
  }
  if (parsed.getUTCFullYear() === now.getUTCFullYear()) out.add("this_year");
  if (parsed.getUTCFullYear() === now.getUTCFullYear() + 1)
    out.add("next_year");

  const endOfMonth = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0),
  );
  if (parsed.getUTCDate() === endOfMonth.getUTCDate()) out.add("end_of_month");
  if (parsed.getUTCMonth() === 11 && parsed.getUTCDate() === 31)
    out.add("end_of_year");

  const diffMs = parsed.getTime() - now.getTime();
  if (diffMs >= 0 && diffMs <= 7 * 24 * 60 * 60 * 1000) out.add("this_week");
  if (diffMs > 7 * 24 * 60 * 60 * 1000 && diffMs <= 14 * 24 * 60 * 60 * 1000) {
    out.add("next_week");
  }
  return out;
}

function timeAnchorScore(
  evidence: Set<string>,
  candidate: Set<string>,
): number | null {
  if (evidence.size === 0 || candidate.size === 0) return null;
  let overlap = 0;
  for (const key of evidence) {
    if (candidate.has(key)) overlap += 1;
  }
  return clamp01(overlap / evidence.size);
}

export function scoreSignalTargetAnchorAlignment(
  input: SignalTargetAnchorAlignmentInput,
): SignalTargetAnchorAlignment {
  const evidenceAnchors = extractEvidenceAnchors(input.evidenceText);
  const targetAnchors = extractTargetAnchors(
    `${input.eventTitle ?? ""} ${input.marketTitle ?? ""}`.trim(),
  );
  const targetSet = new Set(targetAnchors);
  const overlap = evidenceAnchors.filter((token) => targetSet.has(token));
  const score =
    evidenceAnchors.length > 0
      ? clamp01(overlap.length / evidenceAnchors.length)
      : 0;
  return {
    score,
    evidenceAnchors,
    targetAnchors,
    overlap,
    hasStrongEvidenceAnchors: evidenceAnchors.length >= 2,
  };
}

export function scoreSignalMarketContractMatch(
  input: SignalMarketContractMatchInput,
): number {
  const evidenceText = input.evidenceText.trim();
  const eventTitle = input.eventTitle.trim();
  const marketTitle = input.marketTitle?.trim() ?? "";
  const combinedText = `${eventTitle} ${marketTitle}`.trim();

  let weighted = 0;
  let totalWeight = 0;

  const add = (weight: number, score: number | null): void => {
    if (score == null || !Number.isFinite(score)) return;
    weighted += weight * clamp01(score);
    totalWeight += weight;
  };

  add(0.35, marketTitle ? lexicalSimilarity(evidenceText, marketTitle) : null);
  add(0.2, lexicalSimilarity(evidenceText, combinedText));
  add(0.1, lexicalSimilarity(evidenceText, eventTitle));
  add(
    0.15,
    numericAnchorScore(
      extractNumericAnchors(evidenceText),
      extractNumericAnchors(combinedText),
    ),
  );
  add(
    0.1,
    operatorAnchorScore(
      extractOperatorAnchors(evidenceText),
      extractOperatorAnchors(combinedText),
    ),
  );
  add(
    0.1,
    timeAnchorScore(
      extractTimeAnchors(evidenceText, null, input.referenceTime),
      extractTimeAnchors(combinedText, input.closeTime, input.referenceTime),
    ),
  );

  if (totalWeight <= 0) return 0;
  return clamp01(weighted / totalWeight);
}
