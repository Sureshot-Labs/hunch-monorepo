import type { UnifiedEventRow, UnifiedMarketRow } from "@hunch/db";
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

export function parseHyperliquidDescription(
  description?: string | null,
): HyperliquidParsedDescription {
  const raw = description?.trim() ?? "";
  const values: Record<string, string> = {};
  if (raw.includes("|") || /^[a-zA-Z][a-zA-Z0-9_]*:/.test(raw)) {
    for (const part of raw.split("|")) {
      const index = part.indexOf(":");
      if (index <= 0) continue;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (key) values[key] = value;
    }
  }

  const expiry = values.expiry;
  const targetPrice = toNumber(values.targetPrice);
  const priceThresholds = values.priceThresholds
    ?.split(",")
    .map((value) => toNumber(value.trim()))
    .filter((value): value is number => typeof value === "number");

  return {
    structured: Object.keys(values).length > 0,
    values,
    class: values.class,
    underlying: values.underlying,
    expiry,
    expiryTime: parseUtcExpiry(expiry),
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
): string | undefined {
  const underlying = parsed.underlying?.toUpperCase();
  if (underlying && CRYPTO_UNDERLYINGS.has(underlying)) return "crypto";
  if (parsed.class?.startsWith("price")) return "crypto";
  return undefined;
}

function formatExpiryForTitle(expiry?: Date): string | undefined {
  if (!expiry) return undefined;
  return expiry.toISOString().replace("T", " ").slice(0, 16) + " UTC";
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
    return `${outcome.name} ${outcome.description}`;
  }
  return undefined;
}

function statusFromExpiry(expiry?: Date): HyperliquidUnifiedStatus {
  return expiry && expiry.getTime() <= Date.now() ? "CLOSED" : "ACTIVE";
}

function titleFromQuestionOutcome(
  outcome: HyperliquidOutcome,
  question: HyperliquidQuestion,
  questionParsed: HyperliquidParsedDescription,
): string {
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

  if (outcome.description) {
    return `${question.name}: ${outcome.name} (${outcome.description})`;
  }
  return `${question.name}: ${outcome.name}`;
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
  return outcome.name;
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

function buildMarketVolume24h(
  assets: HyperliquidSideAsset[],
): number | undefined {
  return sumDefined(assets.map((asset) => toNumber(asset.context?.dayNtlVlm)));
}

function buildEventRows(
  outcomeMeta: HyperliquidOutcomeMetaResponse,
  questionRefs: Map<string, HyperliquidQuestion>,
  marketRows: UnifiedMarketRow[],
): UnifiedEventRow[] {
  const eventsByVenueId = new Map<string, UnifiedEventRow>();

  for (const question of outcomeMeta.questions ?? []) {
    const parsed = parseHyperliquidDescription(question.description);
    const category = resolveHyperliquidCategory(parsed);
    const venueEventId = `question:${question.question}`;
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
      title: question.name,
      description: question.description,
      category,
      status: statusFromExpiry(parsed.expiryTime),
      end_date: parsed.expiryTime,
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
          volume24hSource: "sum_market_side_dayNtlVlm_rolling",
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
    const category = resolveHyperliquidCategory(parsed);
    const venueEventId = `outcome:${outcomeId}`;
    const market = marketRows.find(
      (row) => row.venue_market_id === venueEventId,
    );
    eventsByVenueId.set(venueEventId, {
      id: hunchEventId(venueEventId),
      venue: VENUE,
      venue_event_id: venueEventId,
      title: marketTitle(outcome, parsed),
      description: outcome.description,
      category,
      status: statusFromExpiry(parsed.expiryTime),
      end_date: parsed.expiryTime,
      volume_24h: market?.volume_24h,
      metadata: {
        source: "outcomeMeta",
        hyperliquid: {
          kind: "standaloneOutcome",
          outcomeId,
          parsedDescription: parsed,
          volume24hSource: "sum_side_dayNtlVlm_rolling",
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
    const parsedForExpiry = outcomeParsed.expiryTime
      ? outcomeParsed
      : questionParsed;
    const category =
      resolveHyperliquidCategory(outcomeParsed) ??
      resolveHyperliquidCategory(questionParsed);
    const sideAssets = sideAssetsByOutcome(outcome, contexts);
    const yesAsset = findSide(sideAssets, "YES") ?? sideAssets[0];
    const noAsset = findSide(sideAssets, "NO") ?? sideAssets[1];
    const marketId = hunchMarketId(outcomeId);
    const venueEventId = question
      ? `question:${question.question}`
      : `outcome:${outcomeId}`;
    const yesContext = yesAsset?.context;
    const volume24h = buildMarketVolume24h(sideAssets);
    const lastPrice =
      toNumber(yesContext?.markPx) ?? toNumber(yesContext?.midPx);
    const status = statusFromExpiry(parsedForExpiry.expiryTime);

    outcomeRows.push({
      outcome_id: outcomeId,
      question_id: question ? String(question.question) : undefined,
      name: outcome.name,
      description: outcome.description,
      status,
      side_specs: outcome.sideSpecs,
      parsed_description: outcomeParsed,
      category,
      expiration_time: parsedForExpiry.expiryTime,
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
      title: marketTitle(outcome, outcomeParsed, question, questionParsed),
      description: outcome.description ?? question?.description,
      category,
      status,
      market_type: "binary",
      expiration_time: parsedForExpiry.expiryTime,
      last_price: lastPrice,
      volume_24h: volume24h,
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
          assetContexts: sideAssets.map((asset) => asset.context ?? null),
          volume24hSource: "sum_side_dayNtlVlm_rolling",
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
    return {
      question_id: String(question.question),
      title: question.name,
      description: question.description,
      status: statusFromExpiry(parsed.expiryTime),
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
      category: resolveHyperliquidCategory(parsed),
      expiration_time: parsed.expiryTime,
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
