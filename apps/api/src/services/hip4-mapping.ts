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
      ? [[part.slice(0, separator).trim(), part.slice(separator + 1).trim()]]
      : [];
  });
  return Object.fromEntries(entries);
}

function expiryFromFields(fields: Record<string, string>): string | null {
  // Deadline is NOT proof that orders were closed or that an outcome settled.
  const value =
    fields.expiry ??
    fields.time ??
    fields.resolutionDeadline ??
    fields.decisionDeadline ??
    fields.listingDeadline ??
    fields.dateTime;
  if (!value || !/^\d{8}(?:-\d{4})?$/.test(value)) return null;
  const dateOnly = value.length === 8;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${dateOnly ? "00:00" : `${value.slice(9, 11)}:${value.slice(11, 13)}`}:00.000Z`;
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== iso)
    return null;
  // The provider's `date` template hint means end of day UTC; it must not
  // expire at that day's start. Use the exclusive next-midnight boundary.
  return dateOnly ? new Date(parsed.getTime() + 86_400_000).toISOString() : iso;
}

function label(value: string, fields: Record<string, string>): string {
  if (!value.startsWith("template:")) return value;
  return value
    .slice(9)
    .replace(/\{([^}]+)\}/g, (whole, field: string) => fields[field] ?? whole);
}

function title(name: string, fields: Record<string, string>): string {
  if (fields.participant) return fields.participant;
  if (fields.candidate) return fields.candidate;
  if (name === "template:awardOther") return "Other candidate";
  if (name === "template:sportsContestDraw2") return "Draw";
  if (name === "template:policyRateDecrease") return "Rate decrease";
  if (name === "template:policyRateIncrease") return "Rate increase";
  if (name === "template:policyRateNoChange") return "No rate change";
  if (name === "template:companyIpoConfirmed" && fields.company)
    return `${fields.company} · IPO confirmation`;
  if (name === "template:companyIpoFirstDayMarketCap" && fields.company)
    return [
      `${fields.company} · IPO first-day market cap`,
      fields.marketCapThresholdB ? `$${fields.marketCapThresholdB}B` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  if (fields.participantA && fields.participantB) {
    const matchup = `${fields.participantA} vs ${fields.participantB}`;
    if (fields.spread)
      return `${matchup} · ${fields.participantA} ${fields.spread}`;
    return fields.line
      ? `${matchup} · ${fields.measure ?? "Total"} ${fields.line}`
      : matchup;
  }
  const underlying = fields.underlying ?? fields.perp ?? fields.shortName;
  const threshold = fields.targetPrice ?? fields.threshold ?? fields.target;
  if (underlying && threshold) return `${underlying} · ${threshold}`;
  if (fields.competition)
    return [
      fields.competition,
      fields.season,
      name === "template:sportsTournamentWinner" ? "Winner" : null,
    ]
      .filter(Boolean)
      .join(" · ");
  if (fields.award)
    return [fields.award, fields.period].filter(Boolean).join(" · ");
  if (fields.institution)
    return [fields.institution, fields.decisionLabel]
      .filter(Boolean)
      .join(" · ");
  if (underlying)
    return [
      underlying,
      fields.period,
      fields.index == null ? null : `Bucket ${fields.index}`,
    ]
      .filter(Boolean)
      .join(" · ");
  if (!name.startsWith("template:")) return name;
  // Unknown templates retain a readable identifier. Serialized contract fields
  // belong in the preserved description, never in a table/card heading.
  const templateName = name.slice(9).replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return templateName.charAt(0).toUpperCase() + templateName.slice(1);
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
  const marketTitle = title(outcome.name, fields);
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
      ? title(question.name, hip4DescriptionFields(question.description))
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
    volume24h: input.previous?.market.volume24h ?? null,
    volumeAttempt: input.previous?.market.volumeAttempt,
    indicativePrices: input.previous?.market.indicativePrices ?? null,
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
    // Metadata freshness does not refresh either context observation.
    volume24h: market.volume24h
      ? {
          ...market.volume24h,
          validUntil: new Date(
            Math.min(
              Date.parse(market.volume24h.validUntil),
              Date.parse(market.volume24h.observedAt) + policy.volumeMaxAgeMs,
            ),
          ).toISOString(),
        }
      : null,
    indicativePrices: market.indicativePrices
      ? {
          ...market.indicativePrices,
          validUntil: new Date(
            Math.min(
              Date.parse(market.indicativePrices.validUntil),
              Date.parse(market.indicativePrices.observedAt) +
                policy.bookMaxAgeMs,
            ),
          ).toISOString(),
        }
      : null,
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
