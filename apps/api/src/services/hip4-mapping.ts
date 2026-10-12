import {
  hip4BookSchema,
  hip4Complement,
  hip4Identity,
  hip4MetadataSchema,
  hip4OutcomeSchema,
  hip4SettlementSchema,
  hip4SpotMetadataSchema,
  type Hip4Environment,
  type Hip4ReadMarket,
  type Hip4ReadPolicy,
  type Hip4RawSnapshot,
} from "@hunch/shared";

export function hip4DescriptionFields(
  description: string,
): Record<string, string> {
  const entries = description.split("|").flatMap((part) => {
    const separator = part.indexOf(":");
    return separator > 0
      ? [[part.slice(0, separator), part.slice(separator + 1)]]
      : [];
  });
  return Object.fromEntries(entries);
}

function expiryFromFields(fields: Record<string, string>): string | null {
  // Deadline is NOT proof that orders were closed or that an outcome settled.
  const value = fields.expiry ?? fields.time ?? fields.resolutionDeadline;
  if (!value || !/^\d{8}-\d{4}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:00.000Z`;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === iso
    ? iso
    : null;
}

function label(value: string, fields: Record<string, string>): string {
  if (!value.startsWith("template:")) return value;
  return value
    .slice(9)
    .replace(/\{([^}]+)\}/g, (whole, field: string) => fields[field] ?? whole);
}

function title(
  name: string,
  fields: Record<string, string>,
  description: string,
): string {
  if (fields.participant) return fields.participant;
  if (fields.participantA && fields.participantB) {
    const matchup = `${fields.participantA} vs ${fields.participantB}`;
    return fields.line
      ? `${matchup} · ${fields.measure ?? "Total"} ${fields.line}`
      : matchup;
  }
  const underlying = fields.underlying ?? fields.perp ?? fields.shortName;
  const threshold = fields.targetPrice ?? fields.threshold ?? fields.target;
  if (underlying && threshold) return `${underlying} · ${threshold}`;
  if (!name.startsWith("template:")) return name;
  return description || name.slice(9);
}

export function mapHip4Market(input: {
  environment: Hip4Environment;
  outcome: number;
  metadata: unknown;
  spotMetadata: unknown;
  fetchedAt: string;
  generation: string;
  settlement?: unknown;
  previous?: { market: Hip4ReadMarket; raw: Hip4RawSnapshot } | null;
  settlementCheckedAt?: string;
}): { market: Hip4ReadMarket; raw: Hip4RawSnapshot } {
  const metadata = hip4MetadataSchema.parse(input.metadata);
  const spot = hip4SpotMetadataSchema.parse(input.spotMetadata);
  const settlement =
    input.settlement == null
      ? null
      : hip4SettlementSchema.parse(input.settlement);
  if (settlement && settlement.spec.outcome !== input.outcome)
    throw new Error("settlement_identity_mismatch");
  const outcome =
    metadata.outcomes.find((row) => row.outcome === input.outcome) ??
    settlement?.spec ??
    input.previous?.raw.outcome;
  if (!outcome) throw new Error("outcome_metadata_missing");
  hip4OutcomeSchema.parse(outcome);
  const groups = metadata.questions.filter(
    (q) =>
      q.fallbackOutcome === outcome.outcome ||
      q.namedOutcomes.includes(outcome.outcome) ||
      q.settledNamedOutcomes?.includes(outcome.outcome),
  );
  if (groups.length > 1) throw new Error("ambiguous_question_membership");
  // An incomplete generation is not evidence that membership was removed.
  // Reuse the last confirmed question as a whole, not a partial same-ID row.
  let question = groups[0] ?? input.previous?.raw.question;
  const previousQuestion = input.previous?.raw.question;
  if (question && previousQuestion?.question === question.question) {
    // Partial QuestionSpec updates must not erase known expiry/contract fields.
    const previousFields = hip4DescriptionFields(previousQuestion.description);
    const currentFields = hip4DescriptionFields(question.description);
    const missing = Object.entries(previousFields).filter(
      ([key]) => !currentFields[key],
    );
    question = {
      ...question,
      name: question.name || previousQuestion.name,
      description: question.description
        ? [
            question.description,
            ...missing.map(([key, value]) => `${key}:${value}`),
          ].join("|")
        : previousQuestion.description,
    };
  }
  const fields = {
    ...hip4DescriptionFields(question?.description ?? ""),
    ...hip4DescriptionFields(outcome.description),
  };
  const identity = hip4Identity(input.environment, outcome.outcome);
  const quote = spot.tokens.find((token) => token.name === outcome.quoteToken);
  const expiry = expiryFromFields(fields);
  const marketTitle = title(outcome.name, fields, outcome.description);
  const eventId = question
    ? `hyperliquid:${input.environment}:question:${question.question}`
    : identity.marketId;
  const market: Hip4ReadMarket = {
    version: 1,
    venue: "hyperliquid",
    environment: input.environment,
    marketId: identity.marketId,
    eventId,
    outcome: outcome.outcome,
    questionId: question?.question ?? null,
    isFallback: question?.fallbackOutcome === outcome.outcome,
    title:
      question?.fallbackOutcome === outcome.outcome ? "Other" : marketTitle,
    eventTitle: question
      ? title(
          question.name,
          hip4DescriptionFields(question.description),
          question.description,
        )
      : marketTitle,
    description: [question?.description, outcome.description]
      .filter(Boolean)
      .join("\n"),
    expiry,
    status: settlement
      ? "settled"
      : expiry && expiry <= input.fetchedAt
        ? "expired"
        : "observed",
    fetchedAt: input.fetchedAt,
    generation: input.generation,
    quoteToken: outcome.quoteToken ?? null,
    quoteTokenId: quote?.tokenId ?? null,
    quoteWeiDecimals: quote?.weiDecimals ?? null,
    feeScale: metadata.feeScale ?? null,
    deployerFeeScale: outcome.deployerFeeScale ?? null,
    sides: identity.sides.map((side) => {
      const token = spot.tokens.find((row) => row.name === side.tokenName);
      return {
        ...side,
        label: label(outcome.sideSpecs[side.sideIndex].name, fields),
        szDecimals: token?.szDecimals ?? null,
        weiDecimals: token?.weiDecimals ?? null,
        payout: settlement
          ? side.sideIndex === 0
            ? settlement.settleFraction
            : hip4Complement(settlement.settleFraction)
          : null,
        bid: null,
        ask: null,
        bookAt: null,
        bookState: "missing",
      };
    }),
    settlement: settlement
      ? {
          source: "settledOutcome",
          observedAt:
            input.previous?.market.settlement?.observedAt ??
            input.settlementCheckedAt ??
            input.fetchedAt,
          checkedAt:
            input.settlementCheckedAt ??
            input.previous?.market.settlement?.checkedAt ??
            input.previous?.market.settlement?.observedAt ??
            input.fetchedAt,
          details: settlement.details,
        }
      : null,
    coverage: {
      metadata: "fresh",
      trades: "missing",
      tradeObservedAt: null,
      tradeWindowStart: null,
      tradeWindowEnd: null,
      ranking: "unavailable",
      candles: "unavailable",
    },
    volumeUsd: null,
    openInterest: null,
    capabilities: {
      read: true,
      trade: false,
      copy: false,
      funding: false,
      automation: false,
    },
  };
  if (input.previous) {
    const previous = input.previous.market;
    market.sides = market.sides.map((side, index) => ({
      ...side,
      bid: previous.sides[index].bid,
      ask: previous.sides[index].ask,
      bookAt: previous.sides[index].bookAt,
      bookState: previous.sides[index].bookState,
      bookAttempt: previous.sides[index].bookAttempt,
    }));
    market.coverage = { ...previous.coverage, metadata: "fresh" };
    market.settlementAttempt = previous.settlementAttempt;
    // A cached outcome spec does not refresh metadata provenance.
    if (
      !metadata.outcomes.some((row) => row.outcome === input.outcome) &&
      !(settlement && input.settlementCheckedAt)
    ) {
      market.fetchedAt = previous.fetchedAt;
      market.generation = previous.generation;
    }
  }
  return {
    market,
    raw: {
      outcome,
      question: question ?? null,
      settlement,
      quote: quote ?? null,
      feeScale: metadata.feeScale ?? null,
      deployers: metadata.deployers,
    },
  };
}

export function applyHip4Book(
  market: Hip4ReadMarket,
  sideIndex: 0 | 1,
  payload: unknown,
  now: number,
  maxAgeMs: number,
): Hip4ReadMarket {
  const side = market.sides[sideIndex];
  const parsed = hip4BookSchema.safeParse(payload);
  if (!parsed.success) throw new Error("invalid_response");
  if (parsed.data.coin !== side.coin) throw new Error("wrong_identity");
  const book = parsed.data;
  if (book.time > now) throw new Error("future_hip4_book");
  const bids = book.levels[0].filter((level) => Number(level.sz) > 0);
  const asks = book.levels[1].filter((level) => Number(level.sz) > 0);
  const bid = bids.reduce<string | null>(
    (best, level) =>
      best == null || Number(level.px) > Number(best) ? level.px : best,
    null,
  );
  const ask = asks.reduce<string | null>(
    (best, level) =>
      best == null || Number(level.px) < Number(best) ? level.px : best,
    null,
  );
  if (bid != null && ask != null && Number(bid) > Number(ask))
    throw new Error("crossed_hip4_book");
  // First accepted value wins ties; arrival order cannot rewrite an observation.
  if (side.bookAt && Date.parse(side.bookAt) >= book.time)
    return {
      ...market,
      sides: market.sides.map((entry) =>
        entry.sideIndex === sideIndex
          ? {
              ...entry,
              bookAttempt: {
                at: new Date(now).toISOString(),
                result: "stale_observation",
              },
            }
          : entry,
      ),
    };
  return {
    ...market,
    sides: market.sides.map((entry) =>
      entry.sideIndex === sideIndex
        ? {
            ...entry,
            bid,
            ask,
            bookAt: new Date(book.time).toISOString(),
            bookAttempt: {
              at: new Date(now).toISOString(),
              result: now - book.time > maxAgeMs ? "stale_observation" : "ok",
            },
            bookState:
              now - book.time > maxAgeMs
                ? "stale"
                : bid == null && ask == null
                  ? "empty"
                  : "fresh",
          }
        : entry,
    ),
  };
}

export function ageHip4Market(
  market: Hip4ReadMarket,
  now: number,
  policy: Hip4ReadPolicy,
): Hip4ReadMarket {
  return {
    ...market,
    metadataValidUntil: new Date(
      Date.parse(market.fetchedAt) + policy.metadataMaxAgeMs,
    ).toISOString(),
    status: market.settlement
      ? "settled"
      : market.expiry && Date.parse(market.expiry) <= now
        ? "expired"
        : market.status,
    coverage: {
      ...market.coverage,
      metadata:
        now - Date.parse(market.fetchedAt) > policy.metadataMaxAgeMs
          ? "stale"
          : "fresh",
    },
    sides: market.sides.map((side) => ({
      ...side,
      bookValidUntil: side.bookAt
        ? new Date(Date.parse(side.bookAt) + policy.bookMaxAgeMs).toISOString()
        : null,
      bookState:
        side.bookAt && now - Date.parse(side.bookAt) > policy.bookMaxAgeMs
          ? "stale"
          : side.bookState,
    })),
  };
}
