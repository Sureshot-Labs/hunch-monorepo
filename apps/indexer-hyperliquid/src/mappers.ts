import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";
import {
  parseMarketTextDates,
  resolveMarketCategory,
  type MarketCategoryResolution,
} from "@hunch/shared";
import type {
  HyperliquidAssetContext,
  HyperliquidMappedSnapshot,
  HyperliquidNetwork,
  HyperliquidOutcome,
  HyperliquidOutcomeAssetRow,
  HyperliquidOutcomeMetaResponse,
  HyperliquidOutcomeRow,
  HyperliquidParsedDescription,
  HyperliquidQuestion,
  HyperliquidQuestionRow,
  HyperliquidSideAsset,
  HyperliquidSideSpec,
  HyperliquidSpotMetaAndAssetCtxsResponse,
  HyperliquidUnifiedSide,
} from "./types.js";

const VENUE = "hyperliquid";
const OFFICIAL_OUTCOME_ASSET_OFFSET = 100_000_000;
const CRYPTO_UNDERLYINGS = new Set([
  "BTC",
  "ETH",
  "SOL",
  "HYPE",
  "DOGE",
  "XRP",
  "BNB",
  "ADA",
  "AVAX",
  "LINK",
  "SUI",
]);
type HyperliquidUnifiedStatus = "ACTIVE" | "CLOSED" | "SETTLED" | "ARCHIVED";

function toNumber(
  value: string | number | null | undefined,
): number | undefined {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOutcomeId(value: number | string): string {
  return String(value);
}

function parseUtcExpiry(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute] = match;
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function parseKeyValueSegments(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!/^[a-zA-Z][a-zA-Z0-9_]*:/.test(raw)) return values;
  for (const part of raw.split("|")) {
    const index = part.indexOf(":");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part
      .slice(index + 1)
      .trim()
      .replace(/[.,;]+$/, "");
    if (key) values[key] = value;
  }
  return values;
}

function parseEmbeddedMetadata(raw: string): Record<string, string> {
  const match = /(?:^|\s)metadata=([^\s]+)/.exec(raw);
  if (!match) return {};
  return parseKeyValueSegments(match[1]);
}

function hasUsMacroDateOnlyDeadlineCue(raw: string): boolean {
  return /\b(fed|fomc|federal reserve|cpi|bls|inflation|treasury|jobs report|payrolls|gdp|pce)\b/i.test(
    raw,
  );
}

export function parseHyperliquidDescription(
  description?: string | null,
): HyperliquidParsedDescription {
  const raw = description?.trim() ?? "";
  const metadata = parseEmbeddedMetadata(raw);
  const metadataIndex = raw.indexOf("metadata=");
  const structuredRaw = (metadataIndex >= 0 ? raw.slice(0, metadataIndex) : raw)
    .trim()
    .replace(/[.,;]+$/, "");
  const structuredValues = parseKeyValueSegments(structuredRaw);
  const values = { ...structuredValues, ...metadata };

  const expiry = values.expiry;
  const targetPrice = toNumber(values.targetPrice);
  const priceThresholds = values.priceThresholds
    ?.split(",")
    .map((value) => toNumber(value.trim()))
    .filter((value): value is number => typeof value === "number");

  const textDates = parseMarketTextDates({
    text: raw,
    allowDateOnlyUsEasternDeadline: hasUsMacroDateOnlyDeadlineCue(raw),
  });

  return {
    structured: Object.keys(values).length > 0,
    values,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    class: values.class,
    underlying: values.underlying,
    expiry,
    expiryTime: parseUtcExpiry(expiry),
    deadlineTime: textDates.deadlineTime,
    deadlineSource: textDates.deadlineSource,
    deadlineText: textDates.deadlineText,
    deadlineAssumption: textDates.deadlineAssumption,
    scheduledTime: textDates.scheduledTime,
    scheduledSource: textDates.scheduledSource,
    scheduledText: textDates.scheduledText,
    targetPrice,
    priceThresholds:
      priceThresholds && priceThresholds.length > 0
        ? priceThresholds
        : undefined,
    period: values.period,
  };
}

export function resolveHyperliquidCategory(
  parsed: HyperliquidParsedDescription,
  title?: string | null,
  description?: string | null,
): string | undefined {
  return resolveHyperliquidCategoryResolution(parsed, title, description)
    .category;
}

function structuredCategoryHint(
  parsed: HyperliquidParsedDescription,
): string | undefined {
  const category = parsed.metadata?.category ?? parsed.values.category;
  if (category) return category;
  const underlying = parsed.underlying?.toUpperCase();
  if (underlying && CRYPTO_UNDERLYINGS.has(underlying)) return "crypto";
  if (parsed.class?.startsWith("price")) return "crypto";
  return undefined;
}

function resolveHyperliquidCategoryResolution(
  parsed: HyperliquidParsedDescription,
  title?: string | null,
  description?: string | null,
): MarketCategoryResolution {
  return resolveMarketCategory({
    metadata: parsed.metadata,
    sourceCategory: structuredCategoryHint(parsed),
    title,
    description,
  });
}

function formatExpiryForTitle(expiry?: Date): string | undefined {
  if (!expiry) return undefined;
  return expiry.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function normalizeDisplayText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function resolutionParentheticalRegex(): RegExp {
  return /\s*\((?=[^)]*\b(?:resolves?|resolution|settles?|settlement)\b)[^)]*\)\s*/gi;
}

function sanitizeDisplayName(value: string | null | undefined): string {
  return normalizeDisplayText(
    normalizeDisplayText(value).replace(resolutionParentheticalRegex(), " "),
  );
}

function extractResolutionParentheticals(
  value: string | null | undefined,
): string[] {
  const raw = normalizeDisplayText(value);
  if (!raw) return [];
  const matches: string[] = [];
  for (const match of raw.matchAll(
    /\(([^)]*\b(?:resolves?|resolution|settles?|settlement)\b[^)]*)\)/gi,
  )) {
    const text = normalizeDisplayText(match[1]);
    if (text) matches.push(text);
  }
  return matches;
}

function descriptionWithEmbeddedResolution(
  description: string | null | undefined,
  sourceName: string | null | undefined,
): string | undefined {
  const base = normalizeDisplayText(description);
  const additions = extractResolutionParentheticals(sourceName).filter(
    (entry) => !base.toLowerCase().includes(entry.toLowerCase()),
  );
  const parts = [base, ...additions].filter(Boolean);
  return parts.length ? parts.join("\n\n") : undefined;
}

function marketDescription(
  outcome: HyperliquidOutcome,
  question?: HyperliquidQuestion,
): string | undefined {
  if (outcome.description) {
    return descriptionWithEmbeddedResolution(outcome.description, outcome.name);
  }
  const embeddedResolution = extractResolutionParentheticals(outcome.name);
  if (embeddedResolution.length) return embeddedResolution.join("\n\n");
  return normalizeDisplayText(question?.description) || undefined;
}

function titleFromStructuredDescription(
  outcome: HyperliquidOutcome,
  parsed: HyperliquidParsedDescription,
): string | undefined {
  if (
    parsed.class === "priceBinary" &&
    parsed.underlying &&
    typeof parsed.targetPrice === "number"
  ) {
    const expiry = formatExpiryForTitle(parsed.expiryTime);
    return expiry
      ? `Will ${parsed.underlying} be above ${parsed.targetPrice} at ${expiry}?`
      : `Will ${parsed.underlying} be above ${parsed.targetPrice}?`;
  }
  if (outcome.description?.startsWith("index:")) {
    return `${sanitizeDisplayName(outcome.name)} ${outcome.description}`;
  }
  return undefined;
}

function statusFromExpiry(expiry?: Date): HyperliquidUnifiedStatus {
  return expiry && expiry.getTime() <= Date.now() ? "CLOSED" : "ACTIVE";
}

function statusForOutcome(
  expiry: Date | undefined,
  isFallbackOutcome: boolean,
): HyperliquidUnifiedStatus {
  return isFallbackOutcome ? "ARCHIVED" : statusFromExpiry(expiry);
}

function resolveEndTime(
  parsed: HyperliquidParsedDescription,
): Date | undefined {
  return parsed.expiryTime ?? parsed.deadlineTime;
}

function parsePeriodMinutes(period: string | undefined): number | undefined {
  const match = /^(\d+)(m|h|d|w)$/i.exec(period ?? "");
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = match[2].toLowerCase();
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  if (unit === "d") return value * 24 * 60;
  if (unit === "w") return value * 7 * 24 * 60;
  return undefined;
}

function resolveDurationMinutes(
  primary: HyperliquidParsedDescription,
  fallback?: HyperliquidParsedDescription,
): number | undefined {
  return (
    parsePeriodMinutes(primary.period) ?? parsePeriodMinutes(fallback?.period)
  );
}

function titleFromQuestionOutcome(
  outcome: HyperliquidOutcome,
  question: HyperliquidQuestion,
  questionParsed: HyperliquidParsedDescription,
): string {
  const questionName = sanitizeDisplayName(question.name) || question.name;
  const outcomeName = sanitizeDisplayName(outcome.name) || outcome.name;
  const indexMatch = /^index:(\d+)$/.exec(outcome.description ?? "");
  const thresholds = questionParsed.priceThresholds ?? [];
  const expiry = formatExpiryForTitle(questionParsed.expiryTime);
  if (
    questionParsed.class === "priceBucket" &&
    questionParsed.underlying &&
    indexMatch &&
    thresholds.length > 0
  ) {
    const index = Number(indexMatch[1]);
    const prefix = `Will ${questionParsed.underlying}`;
    const suffix = expiry ? ` at ${expiry}?` : "?";
    if (index === 0) {
      return `${prefix} be below ${thresholds[0]}${suffix}`;
    }
    if (index === thresholds.length) {
      return `${prefix} be above ${thresholds[thresholds.length - 1]}${suffix}`;
    }
    if (index > 0 && index < thresholds.length) {
      return `${prefix} be between ${thresholds[index - 1]} and ${thresholds[index]}${suffix}`;
    }
  }

  return outcomeName || questionName;
}

function normalizeSideName(side: HyperliquidSideSpec, index: number): string {
  const name = String(side.name ?? "").trim();
  if (name) return name;
  return index === 0 ? "Yes" : index === 1 ? "No" : `Side ${index}`;
}

function normalizeOutcomeSide(
  side: HyperliquidSideSpec,
  index: number,
): HyperliquidUnifiedSide {
  const name = normalizeSideName(side, index).toLowerCase();
  if (name === "no") return "NO";
  return index === 1 && name !== "yes" ? "NO" : "YES";
}

export function buildHyperliquidSideAsset(
  outcome: HyperliquidOutcome,
  side: HyperliquidSideSpec,
  sideIndex: number,
  context?: HyperliquidAssetContext,
): HyperliquidSideAsset {
  const outcomeId = parseOutcomeId(outcome.outcome);
  const encoding = 10 * Number(outcome.outcome) + sideIndex;
  const officialAssetId = OFFICIAL_OUTCOME_ASSET_OFFSET + encoding;
  return {
    outcomeId,
    sideIndex,
    sideName: normalizeSideName(side, sideIndex),
    outcomeSide: normalizeOutcomeSide(side, sideIndex),
    encoding,
    coin: `#${encoding}`,
    tokenName: `+${encoding}`,
    officialAssetId,
    hunchTokenId: `${VENUE}:${officialAssetId}`,
    context,
  };
}

function buildAssetRow(
  asset: HyperliquidSideAsset,
): HyperliquidOutcomeAssetRow {
  const context = asset.context;
  return {
    outcome_id: asset.outcomeId,
    side_index: asset.sideIndex,
    side_name: asset.sideName,
    outcome_side: asset.outcomeSide,
    encoding: asset.encoding,
    coin: asset.coin,
    token_name: asset.tokenName,
    official_asset_id: asset.officialAssetId,
    hunch_token_id: asset.hunchTokenId,
    mark_px: toNumber(context?.markPx),
    mid_px: toNumber(context?.midPx),
    prev_day_px: toNumber(context?.prevDayPx),
    day_ntl_vlm: toNumber(context?.dayNtlVlm),
    day_base_vlm: toNumber(context?.dayBaseVlm),
    circulating_supply: toNumber(context?.circulatingSupply),
    total_supply: toNumber(context?.totalSupply),
    raw: context,
  };
}

function buildQuestionRefs(
  questions: HyperliquidQuestion[],
): Map<string, HyperliquidQuestion> {
  const refs = new Map<string, HyperliquidQuestion>();
  for (const question of questions) {
    const outcomeIds = [
      question.fallbackOutcome,
      ...(question.namedOutcomes ?? []),
    ].filter((value): value is number => typeof value === "number");
    for (const outcomeId of outcomeIds) {
      refs.set(parseOutcomeId(outcomeId), question);
    }
  }
  return refs;
}

function isQuestionFallbackOutcome(
  outcomeId: string,
  question?: HyperliquidQuestion,
): boolean {
  return question?.fallbackOutcome != null
    ? parseOutcomeId(question.fallbackOutcome) === outcomeId
    : false;
}

function questionOutcomeIds(question: HyperliquidQuestion): string[] {
  return [question.fallbackOutcome, ...(question.namedOutcomes ?? [])]
    .filter((value): value is number => typeof value === "number")
    .map(parseOutcomeId);
}

function marketTitle(
  outcome: HyperliquidOutcome,
  outcomeParsed: HyperliquidParsedDescription,
  question?: HyperliquidQuestion,
  questionParsed?: HyperliquidParsedDescription,
): string {
  if (question) {
    return titleFromQuestionOutcome(
      outcome,
      question,
      questionParsed ?? parseHyperliquidDescription(question.description),
    );
  }
  const structuredTitle = titleFromStructuredDescription(
    outcome,
    outcomeParsed,
  );
  if (structuredTitle) return structuredTitle;
  return sanitizeDisplayName(outcome.name) || outcome.name;
}

function hunchEventId(questionOrOutcomeId: string): string {
  return `${VENUE}:${questionOrOutcomeId}`;
}

function hunchMarketId(outcomeId: string): string {
  return `${VENUE}:outcome:${outcomeId}`;
}

function sideAssetsByOutcome(
  outcome: HyperliquidOutcome,
  contexts: Map<string, HyperliquidAssetContext>,
): HyperliquidSideAsset[] {
  return outcome.sideSpecs
    .slice(0, 2)
    .map((side, index) =>
      buildHyperliquidSideAsset(
        outcome,
        side,
        index,
        contexts.get(`#${10 * Number(outcome.outcome) + index}`),
      ),
    );
}

function findSide(
  assets: HyperliquidSideAsset[],
  side: HyperliquidUnifiedSide,
): HyperliquidSideAsset | undefined {
  return assets.find((asset) => asset.outcomeSide === side);
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value != null);
  if (defined.length === 0) return undefined;
  return defined.reduce((sum, value) => sum + value, 0);
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value != null);
  if (defined.length === 0) return undefined;
  return Math.max(...defined);
}

function buildMarketVolume24h(assets: HyperliquidSideAsset[]): {
  value?: number;
  source: string;
} {
  const dayBaseVolume = maxDefined(
    assets.map((asset) => toNumber(asset.context?.dayBaseVlm)),
  );
  if (dayBaseVolume != null) {
    return {
      value: dayBaseVolume,
      source: "max_side_dayBaseVlm_rolling_24h",
    };
  }
  return {
    value: sumDefined(
      assets.map((asset) => toNumber(asset.context?.dayNtlVlm)),
    ),
    source: "sum_side_dayNtlVlm_rolling_24h",
  };
}

function buildEventRows(
  outcomeMeta: HyperliquidOutcomeMetaResponse,
  questionRefs: Map<string, HyperliquidQuestion>,
  marketRows: UnifiedMarketRow[],
): UnifiedEventRow[] {
  const eventsByVenueId = new Map<string, UnifiedEventRow>();

  for (const question of outcomeMeta.questions ?? []) {
    const parsed = parseHyperliquidDescription(question.description);
    const categoryResolution = resolveHyperliquidCategoryResolution(
      parsed,
      question.name,
      question.description,
    );
    const category = categoryResolution.category;
    const endTime = resolveEndTime(parsed);
    const venueEventId = `question:${question.question}`;
    const title = sanitizeDisplayName(question.name) || question.name;
    const outcomeIds = new Set(questionOutcomeIds(question));
    const volume24h = sumDefined(
      marketRows
        .filter((market) =>
          outcomeIds.has(market.venue_market_id.replace(/^outcome:/, "")),
        )
        .map((market) => market.volume_24h),
    );
    eventsByVenueId.set(venueEventId, {
      id: hunchEventId(venueEventId),
      venue: VENUE,
      venue_event_id: venueEventId,
      title,
      description: question.description,
      category,
      status: statusFromExpiry(endTime),
      duration_minutes: resolveDurationMinutes(parsed),
      end_date: endTime,
      volume_24h: volume24h,
      metadata: {
        source: "outcomeMeta",
        hyperliquid: {
          kind: "question",
          questionId: String(question.question),
          fallbackOutcomeId:
            question.fallbackOutcome != null
              ? String(question.fallbackOutcome)
              : null,
          namedOutcomeIds: (question.namedOutcomes ?? []).map(String),
          settledNamedOutcomeIds: (question.settledNamedOutcomes ?? []).map(
            String,
          ),
          parsedDescription: parsed,
          categorySource: categoryResolution.categorySource,
          categoryConfidence: categoryResolution.categoryConfidence,
          categoryMatchedToken: categoryResolution.matchedToken,
          volume24hSource: "sum_child_market_volume_24h",
          volumeTotalAvailable: false,
        },
        raw: question,
      },
    });
  }

  for (const outcome of outcomeMeta.outcomes) {
    const outcomeId = parseOutcomeId(outcome.outcome);
    if (questionRefs.has(outcomeId)) continue;
    const parsed = parseHyperliquidDescription(outcome.description);
    const title = marketTitle(outcome, parsed);
    const categoryResolution = resolveHyperliquidCategoryResolution(
      parsed,
      title,
      outcome.description,
    );
    const category = categoryResolution.category;
    const endTime = resolveEndTime(parsed);
    const venueEventId = `outcome:${outcomeId}`;
    const market = marketRows.find(
      (row) => row.venue_market_id === venueEventId,
    );
    eventsByVenueId.set(venueEventId, {
      id: hunchEventId(venueEventId),
      venue: VENUE,
      venue_event_id: venueEventId,
      title,
      description: marketDescription(outcome),
      category,
      status: statusFromExpiry(endTime),
      duration_minutes: resolveDurationMinutes(parsed),
      end_date: endTime,
      volume_24h: market?.volume_24h,
      metadata: {
        source: "outcomeMeta",
        hyperliquid: {
          kind: "standaloneOutcome",
          outcomeId,
          parsedDescription: parsed,
          categorySource: categoryResolution.categorySource,
          categoryConfidence: categoryResolution.categoryConfidence,
          categoryMatchedToken: categoryResolution.matchedToken,
          volume24hSource: "market_volume_24h",
          volumeTotalAvailable: false,
        },
        raw: outcome,
      },
    });
  }

  return Array.from(eventsByVenueId.values());
}

function buildMarketRows(
  outcomeMeta: HyperliquidOutcomeMetaResponse,
  questionRefs: Map<string, HyperliquidQuestion>,
  contexts: Map<string, HyperliquidAssetContext>,
): {
  markets: UnifiedMarketRow[];
  assets: HyperliquidOutcomeAssetRow[];
  outcomes: HyperliquidOutcomeRow[];
  tokens: HyperliquidMappedSnapshot["tokens"];
} {
  const markets: UnifiedMarketRow[] = [];
  const assetRows: HyperliquidOutcomeAssetRow[] = [];
  const outcomeRows: HyperliquidOutcomeRow[] = [];
  const tokens: HyperliquidMappedSnapshot["tokens"] = [];

  for (const outcome of outcomeMeta.outcomes) {
    const outcomeId = parseOutcomeId(outcome.outcome);
    const question = questionRefs.get(outcomeId);
    const outcomeParsed = parseHyperliquidDescription(outcome.description);
    const questionParsed = parseHyperliquidDescription(question?.description);
    const title = marketTitle(outcome, outcomeParsed, question, questionParsed);
    const parsedForEnd = resolveEndTime(outcomeParsed)
      ? outcomeParsed
      : questionParsed;
    const endTime = resolveEndTime(parsedForEnd);
    const outcomeCategoryResolution = resolveHyperliquidCategoryResolution(
      outcomeParsed,
      title,
      outcome.description,
    );
    const questionCategoryResolution = question
      ? resolveHyperliquidCategoryResolution(
          questionParsed,
          question.name,
          question.description,
        )
      : undefined;
    const categoryResolution = outcomeCategoryResolution.category
      ? outcomeCategoryResolution
      : questionCategoryResolution;
    const category = categoryResolution?.category;
    const sideAssets = sideAssetsByOutcome(outcome, contexts);
    const yesAsset = findSide(sideAssets, "YES") ?? sideAssets[0];
    const noAsset = findSide(sideAssets, "NO") ?? sideAssets[1];
    const isFallbackOutcome = isQuestionFallbackOutcome(outcomeId, question);
    const marketId = hunchMarketId(outcomeId);
    const venueEventId = question
      ? `question:${question.question}`
      : `outcome:${outcomeId}`;
    const yesContext = yesAsset?.context;
    const volume24h = buildMarketVolume24h(sideAssets);
    const lastPrice = isFallbackOutcome
      ? undefined
      : (toNumber(yesContext?.markPx) ?? toNumber(yesContext?.midPx));
    const status = statusForOutcome(endTime, isFallbackOutcome);

    outcomeRows.push({
      outcome_id: outcomeId,
      question_id: question ? String(question.question) : undefined,
      name: outcome.name,
      description: outcome.description,
      status,
      side_specs: outcome.sideSpecs,
      parsed_description: outcomeParsed,
      category,
      expiration_time: endTime,
      raw: outcome,
    });

    for (const asset of sideAssets) {
      assetRows.push(buildAssetRow(asset));
      tokens.push({
        token_id: asset.hunchTokenId,
        market_id: marketId,
        side: asset.outcomeSide,
      });
    }

    markets.push({
      id: marketId,
      venue: VENUE,
      venue_market_id: `outcome:${outcomeId}`,
      event_id: hunchEventId(venueEventId),
      title,
      description: marketDescription(outcome, question),
      category,
      status,
      market_type: "binary",
      duration_minutes: resolveDurationMinutes(outcomeParsed, questionParsed),
      expiration_time: endTime,
      last_price: lastPrice,
      volume_24h: isFallbackOutcome ? undefined : volume24h.value,
      outcomes: JSON.stringify(
        sideAssets.map((asset) => asset.sideName || asset.outcomeSide),
      ),
      token_yes: yesAsset?.hunchTokenId,
      token_no: noAsset?.hunchTokenId,
      metadata: {
        source: "outcomeMeta",
        hyperliquid: {
          network: "mainnet",
          outcomeId,
          questionId: question ? String(question.question) : null,
          isFallbackOutcome,
          hiddenReason: isFallbackOutcome
            ? "hyperliquid_fallback_outcome"
            : undefined,
          coinIds: sideAssets.map((asset) => asset.coin),
          sideAssets: sideAssets.map((asset) => ({
            sideIndex: asset.sideIndex,
            sideName: asset.sideName,
            outcomeSide: asset.outcomeSide,
            encoding: asset.encoding,
            coin: asset.coin,
            tokenName: asset.tokenName,
            officialAssetId: asset.officialAssetId,
            hunchTokenId: asset.hunchTokenId,
          })),
          parsedDescription: outcomeParsed,
          questionParsedDescription: questionParsed.structured
            ? questionParsed
            : undefined,
          categorySource: categoryResolution?.categorySource,
          categoryConfidence: categoryResolution?.categoryConfidence,
          categoryMatchedToken: categoryResolution?.matchedToken,
          assetContexts: sideAssets.map((asset) => asset.context ?? null),
          volume24hSource: volume24h.source,
          volumeTotalAvailable: false,
          liquidityAvailable: false,
          openInterestAvailable: false,
        },
        raw: {
          outcome,
          question: question ?? null,
        },
      },
    });
  }

  return { markets, assets: assetRows, outcomes: outcomeRows, tokens };
}

function buildQuestionRows(
  questions: HyperliquidQuestion[],
): HyperliquidQuestionRow[] {
  return questions.map((question) => {
    const parsed = parseHyperliquidDescription(question.description);
    const endTime = resolveEndTime(parsed);
    const category = resolveHyperliquidCategory(
      parsed,
      question.name,
      question.description,
    );
    return {
      question_id: String(question.question),
      title: question.name,
      description: question.description,
      status: statusFromExpiry(endTime),
      fallback_outcome_id:
        question.fallbackOutcome != null
          ? String(question.fallbackOutcome)
          : undefined,
      named_outcome_ids: (question.namedOutcomes ?? []).map(String),
      settled_named_outcome_ids: (question.settledNamedOutcomes ?? []).map(
        String,
      ),
      outcome_ids: questionOutcomeIds(question),
      parsed_description: parsed,
      category,
      expiration_time: endTime,
      raw: question,
    };
  });
}

function assetContextMap(
  spotMetaAndAssetCtxs?: HyperliquidSpotMetaAndAssetCtxsResponse,
): Map<string, HyperliquidAssetContext> {
  const contexts = new Map<string, HyperliquidAssetContext>();
  const assetContexts = spotMetaAndAssetCtxs?.[1] ?? [];
  for (const context of assetContexts) {
    if (context.coin?.startsWith("#")) {
      contexts.set(context.coin, context);
    }
  }
  return contexts;
}

export function mapHyperliquidSnapshot(params: {
  network?: HyperliquidNetwork;
  outcomeMeta: HyperliquidOutcomeMetaResponse;
  spotMetaAndAssetCtxs?: HyperliquidSpotMetaAndAssetCtxsResponse;
}): HyperliquidMappedSnapshot {
  const network = params.network ?? "mainnet";
  const questions = params.outcomeMeta.questions ?? [];
  const refs = buildQuestionRefs(questions);
  const contexts = assetContextMap(params.spotMetaAndAssetCtxs);
  const { markets, assets, outcomes, tokens } = buildMarketRows(
    params.outcomeMeta,
    refs,
    contexts,
  );
  const events = buildEventRows(params.outcomeMeta, refs, markets);
  const questionRows = buildQuestionRows(questions);
  const standaloneOutcomeCount = params.outcomeMeta.outcomes.filter(
    (outcome) => !refs.has(parseOutcomeId(outcome.outcome)),
  ).length;

  for (const event of events) {
    event.metadata = {
      ...(event.metadata as Record<string, unknown>),
      hyperliquid: {
        ...((event.metadata as { hyperliquid?: Record<string, unknown> })
          .hyperliquid ?? {}),
        network,
      },
    };
  }
  for (const market of markets) {
    market.metadata = {
      ...(market.metadata as Record<string, unknown>),
      hyperliquid: {
        ...((market.metadata as { hyperliquid?: Record<string, unknown> })
          .hyperliquid ?? {}),
        network,
      },
    };
  }

  return {
    network,
    questions: questionRows,
    outcomes,
    assets,
    events,
    markets,
    tokens,
    diagnostics: {
      outcomeCount: params.outcomeMeta.outcomes.length,
      questionCount: questions.length,
      eventCount: events.length,
      marketCount: markets.length,
      tokenCount: tokens.length,
      standaloneOutcomeCount,
    },
  };
}
