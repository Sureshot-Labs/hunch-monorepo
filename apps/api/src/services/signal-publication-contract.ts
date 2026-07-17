import { createHash } from "node:crypto";

export const HOLDER_RESEARCH_PUBLICATION_DECISION_V1 = {
  authority: "holder_research_quality_gate",
  status: "PUBLISH",
  version: 1,
} as const;

export type HolderResearchPublicationDecisionV1 =
  typeof HOLDER_RESEARCH_PUBLICATION_DECISION_V1;

export const HOLDER_RESEARCH_PUBLICATION_DECISION_V1_METRICS_JSON =
  JSON.stringify({
    publicationDecisionV1: HOLDER_RESEARCH_PUBLICATION_DECISION_V1,
  });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type PublicationSide = "NO" | "YES";

export type TelegramMarketIdentityV1 = {
  asOf: string;
  eventId: string | null;
  eventTitle: string | null;
  marketGroupItemTitle: string | null;
  marketId: string;
  marketQuestion: string;
  predicate: string;
  selectedSide: PublicationSide;
  selectedSideLabel: string;
  source: "canonical_market" | "reviewed_presentation";
  subject: string;
  venue: string;
  version: 1;
};

export type SignalPriceSnapshotSideV1 = {
  ask: number | null;
  bid: number | null;
  mark: number | null;
};

export type SignalPriceSnapshotV1 = {
  asOf: string;
  displayPrice: number;
  displayPriceSource: "midpoint";
  displaySide: PublicationSide;
  marketId: string;
  NO: SignalPriceSnapshotSideV1;
  venue: string;
  version: 1;
  YES: SignalPriceSnapshotSideV1;
};

export type HolderResearchUpdateReason =
  | {
      after: number;
      asOf: string;
      before: number;
      delta: number;
      kind: "price_moved_against_thesis" | "price_moved_with_thesis";
      side: PublicationSide;
      unit: "probability";
    }
  | {
      after: number;
      asOf: string;
      before: number;
      delta: number;
      kind: "position_increased" | "position_reduced";
      scope: "representative_wallet" | "selected_side_cluster";
      side: PublicationSide;
      unit: "usd";
      walletId: string | null;
    }
  | {
      after: number;
      asOf: string;
      before: number;
      delta: number;
      direction: "decreased" | "increased";
      kind: "wallet_confluence_changed";
      side: PublicationSide;
      unit: "wallets";
    };

export type HolderResearchUpdateV1 = {
  baselineAsOf: string;
  baselineNoteId: string;
  changedAt: string;
  ctaIntent: "buy" | "open_market";
  fingerprint: string;
  materialityPolicy: {
    revision: string;
    thresholds: Record<string, number>;
    version: 1;
  };
  primaryReason: HolderResearchUpdateReason;
  reasons: HolderResearchUpdateReason[];
  selectedSide: PublicationSide;
  version: 1;
};

export type HolderResearchPublicationAuditV1 = {
  baselineNoteId: string | null;
  primaryReason: HolderResearchUpdateReason["kind"] | "initial";
  priceSnapshotAsOf: string;
  status: "accepted";
  updateFingerprint: string | null;
  version: 1;
};

export type HolderResearchPublicationRejectionReason =
  | "duplicate_delta"
  | "missing_baseline"
  | "missing_market_identity"
  | "missing_price_snapshot"
  | "no_meaningful_delta"
  | "non_renderable_delta"
  | "price_side_mismatch"
  | "stale_price_snapshot"
  | "unsupported_update_reason";

type PresentationInput = {
  positions: Record<
    PublicationSide,
    { canonicalLabel: string; shortLabel: string }
  >;
  predicate: string;
  source: string;
  subject: string;
};

type StrictTopInput = {
  ask: number | null;
  asOf: string;
  bid: number | null;
  tokenId: string;
};

export type HolderResearchUpdateSnapshot = {
  evidenceHolders: Array<{
    positionUsd: number;
    side: PublicationSide;
    walletId: string;
  }>;
  sides: Record<
    PublicationSide,
    { sharpHolders: number; usd: number; wallets: number }
  >;
  yesProbability: number | null;
};

export type HolderResearchUpdateMateriality = {
  minMeaningfulHolderPctDelta: number;
  minMeaningfulHolderUsdDelta: number;
  minMeaningfulOddsDelta: number;
  minMeaningfulSidePctDelta: number;
  minMeaningfulSideUsdDelta: number;
  strongPriceMoveCents: number;
};

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function probability(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed != null && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function publicationSide(value: unknown): PublicationSide | null {
  return value === "YES" || value === "NO" ? value : null;
}

function validIso(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function compactChildLabel(value: string): boolean {
  const normalized = value.trim();
  return (
    /^[↑↓↗↘]/u.test(normalized) ||
    /^(?:above|below|over|under)?\s*[<>≤≥$€£]?\s*[\d,.]+\s*[%kmbt]?$/iu.test(
      normalized,
    )
  );
}

function placeholderPresentation(value: string): boolean {
  return /^(?:this|the) market$/iu.test(value.trim());
}

export function buildTelegramMarketIdentityV1(input: {
  asOf?: Date;
  eventId: string | null;
  eventTitle: string | null;
  marketId: string;
  marketTitle: string;
  presentation: PresentationInput;
  selectedSide: PublicationSide;
  venue: string;
}): TelegramMarketIdentityV1 | null {
  const marketId = cleanString(input.marketId);
  const marketQuestion = cleanString(input.marketTitle);
  const venue = cleanString(input.venue);
  const eventId = cleanString(input.eventId);
  const eventTitle = cleanString(input.eventTitle);
  const reviewed = input.presentation.source === "approved_override";
  const presentationSubject = cleanString(input.presentation.subject);
  const presentationPredicate = cleanString(input.presentation.predicate);
  const selectedSideLabel = cleanString(
    input.presentation.positions[input.selectedSide]?.canonicalLabel,
  );
  if (!marketId || !marketQuestion || !venue || !selectedSideLabel) return null;

  const compactChild = compactChildLabel(marketQuestion);
  if (compactChild && !reviewed && !eventTitle) return null;

  const subject = reviewed
    ? presentationSubject
    : compactChild
      ? eventTitle
      : (eventTitle ?? marketQuestion);
  const predicate = reviewed
    ? presentationPredicate
    : compactChild && eventTitle
      ? `${eventTitle}: ${marketQuestion}`
      : marketQuestion;
  if (
    !subject ||
    !predicate ||
    placeholderPresentation(subject) ||
    placeholderPresentation(predicate)
  ) {
    return null;
  }

  return {
    asOf: (input.asOf ?? new Date()).toISOString(),
    eventId,
    eventTitle,
    marketGroupItemTitle:
      eventTitle &&
      eventTitle.toLocaleLowerCase() !== marketQuestion.toLocaleLowerCase()
        ? marketQuestion
        : null,
    marketId,
    marketQuestion,
    predicate,
    selectedSide: input.selectedSide,
    selectedSideLabel,
    source: reviewed ? "reviewed_presentation" : "canonical_market",
    subject,
    venue,
    version: 1,
  };
}

export function parseTelegramMarketIdentityV1(
  value: unknown,
): TelegramMarketIdentityV1 | null {
  const record = asRecord(value);
  const side = publicationSide(record?.selectedSide);
  const source = record?.source;
  const version = record?.version;
  const asOf = validIso(record?.asOf);
  const predicate = cleanString(record?.predicate);
  const selectedSideLabel = cleanString(record?.selectedSideLabel);
  const subject = cleanString(record?.subject);
  if (
    version !== 1 ||
    !side ||
    (source !== "canonical_market" && source !== "reviewed_presentation") ||
    !asOf ||
    !predicate ||
    !selectedSideLabel ||
    !subject ||
    placeholderPresentation(predicate) ||
    placeholderPresentation(subject)
  ) {
    return null;
  }
  const identity = buildTelegramMarketIdentityV1({
    asOf: new Date(asOf),
    eventId: cleanString(record?.eventId),
    eventTitle: cleanString(record?.eventTitle),
    marketId: cleanString(record?.marketId) ?? "",
    marketTitle: cleanString(record?.marketQuestion) ?? "",
    presentation: {
      positions: {
        YES: {
          canonicalLabel: side === "YES" ? selectedSideLabel : "YES",
          shortLabel: "YES",
        },
        NO: {
          canonicalLabel: side === "NO" ? selectedSideLabel : "NO",
          shortLabel: "NO",
        },
      },
      predicate,
      source:
        source === "reviewed_presentation" ? "approved_override" : "derived",
      subject,
    },
    selectedSide: side,
    venue: cleanString(record?.venue) ?? "",
  });
  if (!identity) return null;
  return {
    ...identity,
    eventId: cleanString(record?.eventId),
    eventTitle: cleanString(record?.eventTitle),
    marketGroupItemTitle: cleanString(record?.marketGroupItemTitle),
    predicate,
    selectedSideLabel,
    source,
    subject,
  };
}

function snapshotSide(
  top: StrictTopInput | null | undefined,
  input: { maxAgeMs: number; nowMs: number },
): { asOf: string; value: SignalPriceSnapshotSideV1 } | null {
  const asOf = validIso(top?.asOf);
  if (!asOf) return null;
  const ageMs = input.nowMs - Date.parse(asOf);
  if (ageMs < 0 || ageMs > input.maxAgeMs) return null;
  const bid = probability(top?.bid);
  const ask = probability(top?.ask);
  const mark =
    bid != null && ask != null && bid <= ask ? (bid + ask) / 2 : null;
  return { asOf, value: { ask, bid, mark } };
}

export function buildSignalPriceSnapshotV1(input: {
  marketId: string;
  maxAgeMs: number;
  now?: Date;
  selectedSide: PublicationSide;
  tops: Record<PublicationSide, StrictTopInput | null>;
  venue: string;
}):
  | {
      ok: false;
      reason: Extract<
        HolderResearchPublicationRejectionReason,
        | "missing_price_snapshot"
        | "price_side_mismatch"
        | "stale_price_snapshot"
      >;
    }
  | { ok: true; value: SignalPriceSnapshotV1 } {
  const now = input.now ?? new Date();
  const selectedRaw = input.tops[input.selectedSide];
  if (!selectedRaw) return { ok: false, reason: "missing_price_snapshot" };
  const selectedAsOf = validIso(selectedRaw.asOf);
  if (
    !selectedAsOf ||
    now.getTime() - Date.parse(selectedAsOf) > input.maxAgeMs
  ) {
    return { ok: false, reason: "stale_price_snapshot" };
  }
  const sides = {
    YES: snapshotSide(input.tops.YES, {
      maxAgeMs: input.maxAgeMs,
      nowMs: now.getTime(),
    }),
    NO: snapshotSide(input.tops.NO, {
      maxAgeMs: input.maxAgeMs,
      nowMs: now.getTime(),
    }),
  };
  const selected = sides[input.selectedSide];
  if (!selected) return { ok: false, reason: "stale_price_snapshot" };
  if (
    selected.value.bid == null ||
    selected.value.ask == null ||
    selected.value.mark == null
  ) {
    return { ok: false, reason: "price_side_mismatch" };
  }
  return {
    ok: true,
    value: {
      asOf: selected.asOf,
      displayPrice: selected.value.mark,
      displayPriceSource: "midpoint",
      displaySide: input.selectedSide,
      marketId: input.marketId,
      NO: sides.NO?.value ?? { ask: null, bid: null, mark: null },
      venue: input.venue,
      version: 1,
      YES: sides.YES?.value ?? { ask: null, bid: null, mark: null },
    },
  };
}

export function parseSignalPriceSnapshotV1(
  value: unknown,
): SignalPriceSnapshotV1 | null {
  const record = asRecord(value);
  const displaySide = publicationSide(record?.displaySide);
  const displayPrice = probability(record?.displayPrice);
  const asOf = validIso(record?.asOf);
  const readSide = (raw: unknown): SignalPriceSnapshotSideV1 | null => {
    const side = asRecord(raw);
    if (!side) return null;
    const bid = side.bid == null ? null : probability(side.bid);
    const ask = side.ask == null ? null : probability(side.ask);
    const mark = side.mark == null ? null : probability(side.mark);
    if (
      (side.bid != null && bid == null) ||
      (side.ask != null && ask == null) ||
      (side.mark != null && mark == null)
    ) {
      return null;
    }
    if (bid != null && ask != null) {
      if (
        bid > ask ||
        mark == null ||
        !approximatelyEqual(mark, (bid + ask) / 2)
      ) {
        return null;
      }
    } else if (mark != null) {
      return null;
    }
    return { ask, bid, mark };
  };
  const YES = readSide(record?.YES);
  const NO = readSide(record?.NO);
  if (
    record?.version !== 1 ||
    record.displayPriceSource !== "midpoint" ||
    !displaySide ||
    displayPrice == null ||
    !asOf ||
    !YES ||
    !NO ||
    !cleanString(record.marketId) ||
    !cleanString(record.venue)
  ) {
    return null;
  }
  const selected = displaySide === "YES" ? YES : NO;
  if (
    selected.bid == null ||
    selected.ask == null ||
    selected.mark == null ||
    selected.bid > selected.ask ||
    !approximatelyEqual(selected.mark, (selected.bid + selected.ask) / 2) ||
    !approximatelyEqual(displayPrice, selected.mark)
  ) {
    return null;
  }
  return {
    asOf,
    displayPrice,
    displayPriceSource: "midpoint",
    displaySide,
    marketId: cleanString(record.marketId) as string,
    NO,
    venue: cleanString(record.venue) as string,
    version: 1,
    YES,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function approximatelyEqual(
  left: number,
  right: number,
  epsilon = 1e-8,
): boolean {
  return Math.abs(left - right) <= epsilon;
}

function materialityRevision(
  thresholds: HolderResearchUpdateMateriality,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...thresholds }))
    .digest("hex")
    .slice(0, 16);
}

function holderAt(
  snapshot: HolderResearchUpdateSnapshot,
  walletId: string,
  side: PublicationSide,
): { positionUsd: number } | null {
  return (
    snapshot.evidenceHolders.find(
      (holder) => holder.walletId === walletId && holder.side === side,
    ) ?? null
  );
}

export function buildHolderResearchUpdateV1(input: {
  baselineAsOf: string;
  baselineNoteId: string;
  candidateMeaningfulReasons?: string[];
  current: HolderResearchUpdateSnapshot;
  currentPrice: SignalPriceSnapshotV1;
  holderWalletId?: string | null;
  materiality: HolderResearchUpdateMateriality;
  previous: HolderResearchUpdateSnapshot;
  selectedSide: PublicationSide;
  thesisKey: string;
}):
  | {
      ok: false;
      reason: Extract<
        HolderResearchPublicationRejectionReason,
        | "missing_baseline"
        | "no_meaningful_delta"
        | "non_renderable_delta"
        | "price_side_mismatch"
        | "unsupported_update_reason"
      >;
    }
  | { ok: true; value: HolderResearchUpdateV1 } {
  const baselineAsOf = validIso(input.baselineAsOf);
  if (!baselineAsOf || !cleanString(input.baselineNoteId)) {
    return { ok: false, reason: "missing_baseline" };
  }
  if (input.currentPrice.displaySide !== input.selectedSide) {
    return { ok: false, reason: "price_side_mismatch" };
  }

  const previousYes = probability(input.previous.yesProbability);
  const previousPrice =
    previousYes == null
      ? null
      : input.selectedSide === "YES"
        ? previousYes
        : 1 - previousYes;
  const currentPrice = input.currentPrice.displayPrice;
  const priceDelta =
    previousPrice == null ? null : currentPrice - previousPrice;
  const reasons: HolderResearchUpdateReason[] = [];
  let priceReason: HolderResearchUpdateReason | null = null;
  if (
    previousPrice != null &&
    priceDelta != null &&
    Math.abs(priceDelta) + 1e-9 >= input.materiality.minMeaningfulOddsDelta
  ) {
    priceReason = {
      after: round(currentPrice, 4),
      asOf: input.currentPrice.asOf,
      before: round(previousPrice, 4),
      delta: round(priceDelta, 4),
      kind:
        priceDelta >= 0
          ? "price_moved_with_thesis"
          : "price_moved_against_thesis",
      side: input.selectedSide,
      unit: "probability",
    };
    reasons.push(priceReason);
  }

  const holderWalletId = cleanString(input.holderWalletId);
  const previousHolder = holderWalletId
    ? holderAt(input.previous, holderWalletId, input.selectedSide)
    : null;
  const currentHolder = holderWalletId
    ? holderAt(input.current, holderWalletId, input.selectedSide)
    : null;
  const representative = previousHolder && currentHolder;
  const beforePosition = representative
    ? previousHolder.positionUsd
    : input.previous.sides[input.selectedSide].usd;
  const afterPosition = representative
    ? currentHolder.positionUsd
    : input.current.sides[input.selectedSide].usd;
  const positionDelta = afterPosition - beforePosition;
  const positionThreshold = representative
    ? Math.max(
        input.materiality.minMeaningfulHolderUsdDelta,
        Math.abs(beforePosition) *
          input.materiality.minMeaningfulHolderPctDelta,
      )
    : Math.max(
        input.materiality.minMeaningfulSideUsdDelta,
        Math.abs(beforePosition) * input.materiality.minMeaningfulSidePctDelta,
      );
  let positionReason: HolderResearchUpdateReason | null = null;
  if (Math.abs(positionDelta) + 1e-9 >= positionThreshold) {
    positionReason = {
      after: round(afterPosition, 2),
      asOf: input.currentPrice.asOf,
      before: round(beforePosition, 2),
      delta: round(positionDelta, 2),
      kind: positionDelta >= 0 ? "position_increased" : "position_reduced",
      scope: representative ? "representative_wallet" : "selected_side_cluster",
      side: input.selectedSide,
      unit: "usd",
      walletId: representative ? holderWalletId : null,
    };
    reasons.push(positionReason);
  }

  const beforeWallets = input.previous.sides[input.selectedSide].sharpHolders;
  const afterWallets = input.current.sides[input.selectedSide].sharpHolders;
  const walletDelta = afterWallets - beforeWallets;
  let walletReason: HolderResearchUpdateReason | null = null;
  if (walletDelta !== 0) {
    walletReason = {
      after: afterWallets,
      asOf: input.currentPrice.asOf,
      before: beforeWallets,
      delta: walletDelta,
      direction: walletDelta > 0 ? "increased" : "decreased",
      kind: "wallet_confluence_changed",
      side: input.selectedSide,
      unit: "wallets",
    };
    reasons.push(walletReason);
  }

  if (reasons.length === 0) {
    const unsupported = (input.candidateMeaningfulReasons ?? []).some(
      (reason) =>
        reason === "fresh_flow" ||
        reason === "force_recheck" ||
        reason === "holder_set_changed" ||
        reason === "related_position_changed",
    );
    return {
      ok: false,
      reason: unsupported ? "unsupported_update_reason" : "no_meaningful_delta",
    };
  }

  const strongPrice =
    priceReason &&
    Math.abs(priceReason.delta * 100) + 1e-9 >=
      input.materiality.strongPriceMoveCents
      ? priceReason
      : null;
  const primaryReason =
    strongPrice ?? positionReason ?? priceReason ?? walletReason;
  if (!primaryReason) return { ok: false, reason: "non_renderable_delta" };
  const ctaIntent =
    primaryReason.kind === "position_increased" ||
    (primaryReason.kind === "wallet_confluence_changed" &&
      primaryReason.direction === "increased") ||
    primaryReason.kind === "price_moved_with_thesis"
      ? "buy"
      : "open_market";
  const thresholds = Object.fromEntries(
    Object.entries(input.materiality).map(([key, value]) => [
      key,
      round(value, 8),
    ]),
  );
  const fingerprintPayload = {
    baselineNoteId: input.baselineNoteId,
    before: primaryReason.before,
    after: primaryReason.after,
    kind: primaryReason.kind,
    selectedSide: input.selectedSide,
    thesisKey: input.thesisKey,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(fingerprintPayload))
    .digest("hex");
  return {
    ok: true,
    value: {
      baselineAsOf,
      baselineNoteId: input.baselineNoteId,
      changedAt: input.currentPrice.asOf,
      ctaIntent,
      fingerprint,
      materialityPolicy: {
        revision: materialityRevision(input.materiality),
        thresholds,
        version: 1,
      },
      primaryReason,
      reasons,
      selectedSide: input.selectedSide,
      version: 1,
    },
  };
}

function parseUpdateReason(value: unknown): HolderResearchUpdateReason | null {
  const record = asRecord(value);
  const side = publicationSide(record?.side);
  const before = finiteNumber(record?.before);
  const after = finiteNumber(record?.after);
  const delta = finiteNumber(record?.delta);
  const asOf = validIso(record?.asOf);
  if (
    !record ||
    !side ||
    before == null ||
    after == null ||
    delta == null ||
    !asOf
  ) {
    return null;
  }
  if (
    (record.kind === "price_moved_with_thesis" ||
      record.kind === "price_moved_against_thesis") &&
    record.unit === "probability" &&
    probability(before) != null &&
    probability(after) != null &&
    approximatelyEqual(delta, after - before) &&
    ((record.kind === "price_moved_with_thesis" && delta > 0) ||
      (record.kind === "price_moved_against_thesis" && delta < 0))
  ) {
    return {
      after,
      asOf,
      before,
      delta,
      kind: record.kind,
      side,
      unit: "probability",
    };
  }
  if (
    (record.kind === "position_increased" ||
      record.kind === "position_reduced") &&
    record.unit === "usd" &&
    (record.scope === "representative_wallet" ||
      record.scope === "selected_side_cluster") &&
    before >= 0 &&
    after >= 0 &&
    approximatelyEqual(delta, after - before) &&
    ((record.kind === "position_increased" && delta > 0) ||
      (record.kind === "position_reduced" && delta < 0))
  ) {
    return {
      after,
      asOf,
      before,
      delta,
      kind: record.kind,
      scope: record.scope,
      side,
      unit: "usd",
      walletId: cleanString(record.walletId),
    };
  }
  if (
    record.kind === "wallet_confluence_changed" &&
    record.unit === "wallets" &&
    (record.direction === "increased" || record.direction === "decreased") &&
    Number.isInteger(before) &&
    Number.isInteger(after) &&
    Number.isInteger(delta) &&
    before >= 0 &&
    after >= 0 &&
    approximatelyEqual(delta, after - before) &&
    ((record.direction === "increased" && delta > 0) ||
      (record.direction === "decreased" && delta < 0))
  ) {
    return {
      after,
      asOf,
      before,
      delta,
      direction: record.direction,
      kind: "wallet_confluence_changed",
      side,
      unit: "wallets",
    };
  }
  return null;
}

export function parseHolderResearchUpdateV1(
  value: unknown,
): HolderResearchUpdateV1 | null {
  const record = asRecord(value);
  const selectedSide = publicationSide(record?.selectedSide);
  const reasons = Array.isArray(record?.reasons)
    ? record.reasons.map(parseUpdateReason)
    : [];
  const primaryReason = parseUpdateReason(record?.primaryReason);
  const policy = asRecord(record?.materialityPolicy);
  const thresholdsRecord = asRecord(policy?.thresholds);
  const thresholds = thresholdsRecord
    ? Object.fromEntries(
        Object.entries(thresholdsRecord).filter(
          (entry): entry is [string, number] => Number.isFinite(entry[1]),
        ),
      )
    : null;
  const baselineAsOf = validIso(record?.baselineAsOf);
  const changedAt = validIso(record?.changedAt);
  const parsedReasons = reasons.filter(
    (reason): reason is HolderResearchUpdateReason => reason != null,
  );
  const primarySerialized = primaryReason
    ? JSON.stringify(primaryReason)
    : null;
  if (
    record?.version !== 1 ||
    !selectedSide ||
    !primaryReason ||
    reasons.some((reason) => reason == null) ||
    reasons.length === 0 ||
    primaryReason.side !== selectedSide ||
    parsedReasons.some((reason) => reason.side !== selectedSide) ||
    !parsedReasons.some(
      (reason) => JSON.stringify(reason) === primarySerialized,
    ) ||
    !baselineAsOf ||
    !changedAt ||
    !cleanString(record.baselineNoteId) ||
    !cleanString(record.fingerprint) ||
    (record.ctaIntent !== "buy" && record.ctaIntent !== "open_market") ||
    policy?.version !== 1 ||
    !cleanString(policy.revision) ||
    !thresholds ||
    Object.keys(thresholds).length === 0
  ) {
    return null;
  }
  return {
    baselineAsOf,
    baselineNoteId: cleanString(record.baselineNoteId) as string,
    changedAt,
    ctaIntent: record.ctaIntent,
    fingerprint: cleanString(record.fingerprint) as string,
    materialityPolicy: {
      revision: cleanString(policy.revision) as string,
      thresholds,
      version: 1,
    },
    primaryReason,
    reasons: parsedReasons,
    selectedSide,
    version: 1,
  };
}

export function hasHolderResearchPublicationDecisionV1(
  metrics: unknown,
): boolean {
  const decision = asRecord(asRecord(metrics)?.publicationDecisionV1);
  return (
    decision?.version === HOLDER_RESEARCH_PUBLICATION_DECISION_V1.version &&
    decision.status === HOLDER_RESEARCH_PUBLICATION_DECISION_V1.status &&
    decision.authority === HOLDER_RESEARCH_PUBLICATION_DECISION_V1.authority
  );
}
