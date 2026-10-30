import type { IntelTag, IntelTags } from "../schemas/intel-tags.js";
import { verifiedBuyFactsSchema } from "../schemas/social-trade.js";
import { buildSocialInstrument } from "./social-instrument.js";
import { publicHunchSources } from "./hunch-public-presentation.js";
import { publicHunchPricePresentation } from "./hunch-price-presentation.js";
import {
  compareHolderPositionQuantities,
  publicSnapshotPositions,
  type HolderPublicPosition,
} from "./holder-research-publication-history.js";
import {
  hasHolderResearchPublicationDecisionV1,
  parseHolderResearchUpdateV1,
  type HolderResearchUpdateReason,
} from "./signal-publication-contract.js";

export type IntelTagNote = {
  id: string;
  source_id: string;
  note_type: string;
  status: string;
  created_at: Date | string;
  lineage: unknown;
  metrics: unknown;
  model_meta: unknown;
};
export type IntelTagMarket = {
  venue: string | null;
  token_id: string | null;
  metadata: unknown;
  expiration_time: Date | string | null;
  resolved_outcome: string | null;
  resolved_outcome_pct: string | number | null;
};
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function iso(value: unknown): string | null {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function side(value: unknown): "YES" | "NO" | null {
  return value === "YES" || value === "NO" ? value : null;
}
export function emptyIntelTags(): IntelTags {
  return { tags: [], primaryTag: null, tagsVersion: 1 };
}
function instrument(note: IntelTagNote) {
  const parsed = verifiedBuyFactsSchema.shape.instrument.safeParse(
    record(note.metrics).socialInstrumentV1,
  );
  if (
    !parsed.success ||
    parsed.data.marketId !== note.source_id ||
    parsed.data.outcome !== side(record(note.lineage).side)
  )
    return null;
  return parsed.data;
}
function sameInstrument(a: IntelTagNote, b: IntelTagNote): boolean {
  const left = instrument(a),
    right = instrument(b);
  return Boolean(
    left &&
    right &&
    left.marketId === right.marketId &&
    left.venue === right.venue &&
    left.outcome === right.outcome &&
    left.tokenId === right.tokenId &&
    left.generation === right.generation &&
    left.expiry === right.expiry,
  );
}
/** Duplicate or contradictory rows must not count one wallet twice. */
function positions(snapshot: unknown, through: string): HolderPublicPosition[] {
  const unique = new Map<string, HolderPublicPosition>();
  const duplicates = new Set<string>();
  for (const row of publicSnapshotPositions(snapshot)) {
    const key = `${row.walletId}:${row.side}`;
    if (unique.has(key)) duplicates.add(key);
    const observed = iso(row.observedAt);
    if (
      !observed ||
      observed > through ||
      row.positionShares === null ||
      row.positionShares < 0
    )
      continue;
    unique.set(key, { ...row, observedAt: observed });
  }
  return [...unique.entries()]
    .filter(([key]) => !duplicates.has(key))
    .map(([, row]) => row);
}
function reasonCode(reason: HolderResearchUpdateReason): IntelTag["code"] {
  if (reason.kind === "new_external_fact") return "new_evidence";
  if (
    reason.kind === "price_moved_against_thesis" ||
    reason.kind === "price_moved_with_thesis"
  )
    return "price_update";
  return "wallet_activity";
}

/** Pure display classification. No current wallet metrics, model inference or publication decisions. */
export function classifyIntelTags(input: {
  note: IntelTagNote;
  baseline?: IntelTagNote;
  market?: IntelTagMarket;
  limitlessPositionContract?: string;
  now?: number;
}): IntelTags {
  const { note, baseline, market } = input;
  const result = emptyIntelTags();
  const metrics = record(note.metrics),
    lineage = record(note.lineage),
    meta = record(note.model_meta);
  const selected = side(lineage.side),
    publishedAt = iso(note.created_at);
  // Context currently has no producer-owned qualification/update contract. Do not infer one from prose.
  if (
    note.note_type !== "signal" ||
    !["active", "superseded"].includes(note.status) ||
    !hasHolderResearchPublicationDecisionV1(metrics) ||
    !selected ||
    !publishedAt
  )
    return result;
  const parsedUpdate = parseHolderResearchUpdateV1(
    metrics.holderResearchUpdateV1,
  );
  const now = input.now ?? Date.now();
  // created_at is PostgreSQL transaction time, before the producer's evaluatedAt.
  // The saved evaluation time, not a made-up grace period, bounds its observations.
  const update =
    parsedUpdate &&
    parsedUpdate.selectedSide === selected &&
    Date.parse(parsedUpdate.changedAt) <= now &&
    parsedUpdate.baselineAsOf < parsedUpdate.changedAt
      ? parsedUpdate
      : null;
  const evaluatedAt = update?.changedAt ?? publishedAt;
  if (Date.parse(publishedAt) > now) return result;
  const currentPositions = positions(lineage.decision_snapshot, evaluatedAt);
  const actor = record(meta.primary_holder_credentials),
    primary = record(actor.primaryHolder);
  const strong = currentPositions.filter(
    (row) =>
      row.side === selected && row.strong && (row.positionShares ?? 0) > 0,
  );
  const featured =
    actor.side === selected
      ? actor.mode === "single_holder"
        ? strong.filter(
            (row) =>
              row.walletId === primary.walletId && primary.side === selected,
          )
        : actor.mode === "sharp_cluster" &&
            Number(record(actor.cluster).sharpHolders) >= 2
          ? strong
          : []
      : [];
  if (
    featured.length &&
    (actor.mode !== "sharp_cluster" || featured.length >= 2)
  ) {
    result.tags.push({
      code: "top_trader",
      label: "Top Trader",
      basis: {
        side: selected,
        scope:
          actor.mode === "single_holder"
            ? "representative_wallet"
            : "wallet_cluster",
        qualifiedWalletCount: featured.length,
        atPublication: evaluatedAt,
        qualification: "saved_historical_qualification",
      },
    });
  }
  if (update) {
    const thresholds = update.materialityPolicy.thresholds;
    const baselineAt = baseline && iso(baseline.created_at);
    if (
      baseline &&
      baseline.id === update.baselineNoteId &&
      baselineAt &&
      baselineAt <= update.baselineAsOf &&
      baselineAt < publishedAt &&
      baseline.note_type === "signal" &&
      ["active", "superseded"].includes(baseline.status) &&
      hasHolderResearchPublicationDecisionV1(baseline.metrics) &&
      sameInstrument(note, baseline) &&
      Number.isFinite(thresholds.minMeaningfulHolderUsdDelta) &&
      thresholds.minMeaningfulHolderUsdDelta >= 0 &&
      Number.isFinite(thresholds.minMeaningfulHolderPctDelta) &&
      thresholds.minMeaningfulHolderPctDelta >= 0
    ) {
      const changes = compareHolderPositionQuantities({
        previous: positions(
          record(baseline.lineage).decision_snapshot,
          update.baselineAsOf,
        ),
        current: currentPositions,
        after: update.baselineAsOf,
        minUsd: thresholds.minMeaningfulHolderUsdDelta,
        minPct: thresholds.minMeaningfulHolderPctDelta,
        now: new Date(update.changedAt),
      });
      const sides = (["YES", "NO"] as const).flatMap((observedSide) => {
        // Opposite-side snapshots do not carry a separate token/generation in v1.
        // Only classify them when both notes' canonical binary instruments also match (checked above).
        const rows = changes.flatMap((row) =>
          row.side === observedSide &&
          row.afterShares !== undefined &&
          row.beforeShares !== undefined
            ? [{ after: row.afterShares, before: row.beforeShares }]
            : [],
        );
        return rows.length
          ? [
              {
                side: observedSide,
                increasedWallets: rows.filter((row) => row.after > row.before)
                  .length,
                reducedWallets: rows.filter(
                  (row) => row.after > 0 && row.after < row.before,
                ).length,
                exitedWallets: rows.filter(
                  (row) => row.after === 0 && row.before > 0,
                ).length,
              },
            ]
          : [];
      });
      if (sides.length)
        result.tags.push({
          code: "wallet_activity",
          label: "Wallet Activity",
          basis: {
            source: "observed_position_quantity_change",
            baselineAt: update.baselineAsOf,
            observedThrough: update.changedAt,
            sides,
          },
        });
    }
    const price = update.reasons.find(
      (reason) =>
        reason.kind === "price_moved_with_thesis" ||
        reason.kind === "price_moved_against_thesis",
    );
    if (
      price &&
      (price.kind === "price_moved_with_thesis" ||
        price.kind === "price_moved_against_thesis") &&
      price.asOf > update.baselineAsOf &&
      price.asOf <= update.changedAt
    ) {
      result.tags.push({
        code: "price_update",
        label: "Price Update",
        basis: {
          side: selected,
          before: price.before,
          after: price.after,
          baselineAt: update.baselineAsOf,
          observedAt: price.asOf,
          direction:
            price.kind === "price_moved_with_thesis"
              ? "with_thesis"
              : "against_thesis",
        },
      });
    }
    const sources = publicHunchSources({
      kind: "signal",
      metrics,
      modelMeta: meta,
    });
    for (const reason of update.reasons) {
      if (
        reason.kind !== "new_external_fact" ||
        reason.eventAt > update.changedAt ||
        reason.sourcePublishedAt > update.changedAt
      )
        continue;
      const source = sources.find((item) => item.url === reason.sourceUrl);
      if (!source) continue;
      result.tags.push({
        code: "new_evidence",
        label: "New Evidence",
        basis: {
          side: selected,
          eventAt: reason.eventAt,
          sourcePublishedAt: reason.sourcePublishedAt,
          source: { id: source.id, headline: source.headline, url: source.url },
        },
      });
      break;
    }
  }
  const saved = instrument(note);
  if (saved && market?.venue === saved.venue) {
    const current = buildSocialInstrument({
      marketId: note.source_id,
      venue: market.venue,
      outcome: selected,
      tokenId: market.token_id,
      expiry: iso(market.expiration_time),
      metadata: market.metadata,
      limitlessPositionContract: input.limitlessPositionContract,
    });
    const presentation = publicHunchPricePresentation({
      kind: note.note_type,
      side: selected,
      researchedSide: null,
      researchedAt: null,
      researchedPrice: null,
      acceptingOrders: false,
      venue: market.venue,
      metadata: market.metadata,
      marketUpdatedAt: null,
      resolvedOutcome: market.resolved_outcome,
      quoteAsOf: null,
      quotePrice: null,
    });
    const pct = market.resolved_outcome_pct;
    const expectedPct = selected === "YES" ? 10000 : 0;
    if (
      current &&
      current.tokenId === saved.tokenId &&
      current.generation === saved.generation &&
      current.expiry === saved.expiry &&
      presentation.selectedSideResult === "WIN" &&
      (pct === null ||
        (String(pct).trim() !== "" && Number(pct) === expectedPct))
    ) {
      result.tags.push({
        code: "winning_bet",
        label: "Winning Bet",
        basis: {
          side: selected,
          result: "WIN",
          source: "canonical_market_resolution",
        },
      });
    }
  }
  const order: IntelTag["code"][] = [
    "winning_bet",
    "wallet_activity",
    "new_evidence",
    "price_update",
    "top_trader",
  ];
  const available = new Set(result.tags.map((tag) => tag.code));
  const primaryReasonCode = update && reasonCode(update.primaryReason);
  result.primaryTag = available.has("winning_bet")
    ? "winning_bet"
    : primaryReasonCode && available.has(primaryReasonCode)
      ? primaryReasonCode
      : (order.find((code) => available.has(code)) ?? null);
  result.tags.sort((a, b) =>
    a.code === result.primaryTag
      ? -1
      : b.code === result.primaryTag
        ? 1
        : order.indexOf(a.code) - order.indexOf(b.code),
  );
  return result;
}
