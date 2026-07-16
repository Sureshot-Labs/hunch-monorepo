import type { HolderResearchExternalResearchV2 } from "../schemas/holder-research.js";
import type {
  HolderResearchActorSummary,
  HolderResearchCandidate,
  HolderResearchDecisionFeaturesV2,
  HolderResearchHolder,
} from "./holder-research.js";

export type SignalEvidenceMetricV1 = {
  id: string;
  kind:
    | "track_record"
    | "pricing_edge"
    | "volume"
    | "conviction"
    | "capital"
    | "outside_odds";
  scope: "representative_wallet" | "wallet_cluster" | "external_market";
  measurement:
    | { kind: "scalar"; value: number; unit: string }
    | { kind: "range"; min: number; max: number; unit: string };
  horizonDays: number | null;
  sampleSize: number | null;
  source: { kind: string; label: string; url: string | null };
  asOf: string;
  quality: "verified" | "estimated" | "external";
  context: {
    zScore?: number;
    stakeUsd?: number;
    trades?: number;
  } | null;
};

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function primaryEvidenceHolder(
  candidate: HolderResearchCandidate,
  actor: HolderResearchActorSummary,
): HolderResearchHolder | null {
  const walletId = actor.primaryHolder?.walletId;
  if (!walletId) return null;
  return (
    candidate.market.holders.find((holder) => holder.walletId === walletId) ??
    null
  );
}

export function buildHolderResearchSignalEvidence(input: {
  actor: HolderResearchActorSummary;
  candidate: HolderResearchCandidate;
  externalResearch?: HolderResearchExternalResearchV2 | null;
  externalSearchWindowHours: number;
  features: HolderResearchDecisionFeaturesV2;
  now?: Date;
}): SignalEvidenceMetricV1[] {
  const now = input.now ?? new Date();
  const asOf =
    input.features.market.priceCheckedAt ??
    input.features.timing.positionSnapshotAt ??
    now.toISOString();
  const rows: SignalEvidenceMetricV1[] = [];
  const holder = primaryEvidenceHolder(input.candidate, input.actor);

  if (holder && finite(holder.pnl30dUsd)) {
    rows.push({
      id: "representative_wallet:track_record:30d",
      kind: "track_record",
      scope: "representative_wallet",
      measurement: { kind: "scalar", value: holder.pnl30dUsd, unit: "usd" },
      horizonDays: 30,
      sampleSize: holder.trades30d,
      source: {
        kind: "hunch_wallet_intel",
        label: "Representative wallet",
        url: null,
      },
      asOf,
      quality: "verified",
      context: null,
    });
  }

  if (
    holder &&
    finite(holder.resolvedWinRateEdge30d) &&
    finite(holder.resolvedEdgeZScore30d) &&
    finite(holder.resolvedEdgeSampleCount30d) &&
    finite(holder.resolvedStakeUsd30d)
  ) {
    rows.push({
      id: "representative_wallet:pricing_edge:30d",
      kind: "pricing_edge",
      scope: "representative_wallet",
      measurement: {
        kind: "scalar",
        value: holder.resolvedWinRateEdge30d,
        unit: "probability",
      },
      horizonDays: 30,
      sampleSize: holder.resolvedEdgeSampleCount30d,
      source: {
        kind: "hunch_wallet_intel",
        label: "Representative wallet",
        url: null,
      },
      asOf,
      quality: "verified",
      context: {
        zScore: holder.resolvedEdgeZScore30d,
        stakeUsd: holder.resolvedStakeUsd30d,
        ...(finite(holder.trades30d) ? { trades: holder.trades30d } : {}),
      },
    });
  }

  if (holder && finite(holder.volume30dUsd)) {
    rows.push({
      id: "representative_wallet:volume:30d",
      kind: "volume",
      scope: "representative_wallet",
      measurement: {
        kind: "scalar",
        value: holder.volume30dUsd,
        unit: "usd",
      },
      horizonDays: 30,
      sampleSize: holder.trades30d,
      source: {
        kind: "hunch_wallet_intel",
        label: "Representative wallet",
        url: null,
      },
      asOf,
      quality: "verified",
      context: null,
    });
  }

  const selected = input.features.selectedSide;
  if (input.actor.mode === "sharp_cluster" && selected) {
    if (selected.sharpHolderCount > 0) {
      rows.push({
        id: `conviction:${input.features.identity.thesisKey}`,
        kind: "conviction",
        scope: "wallet_cluster",
        measurement: {
          kind: "scalar",
          value: selected.sharpHolderCount,
          unit: "wallets",
        },
        horizonDays: null,
        sampleSize: selected.sharpHolderCount,
        source: {
          kind: "holder_research_v2",
          label: "Tracked strong wallets",
          url: null,
        },
        asOf,
        quality: "verified",
        context: null,
      });
    }
    if (selected.sharpUsd > 0) {
      rows.push({
        id: `capital:${input.features.identity.thesisKey}`,
        kind: "capital",
        scope: "wallet_cluster",
        measurement: {
          kind: "scalar",
          value: selected.sharpUsd,
          unit: "usd",
        },
        horizonDays: null,
        sampleSize: selected.sharpHolderCount,
        source: {
          kind: "holder_research_v2",
          label: "Tracked strong-wallet capital",
          url: null,
        },
        asOf,
        quality: "verified",
        context: null,
      });
    }
  }

  const odds = input.externalResearch?.comparableOdds;
  const oddsAt = odds ? Date.parse(odds.asOf) : Number.NaN;
  const maxAgeMs = Math.max(0, input.externalSearchWindowHours) * 3_600_000;
  if (
    odds &&
    odds.side === input.features.identity.side &&
    Number.isFinite(oddsAt) &&
    oddsAt <= now.getTime() + 5_000 &&
    now.getTime() - oddsAt <= maxAgeMs &&
    odds.sources.length > 0
  ) {
    rows.push({
      id: `outside_odds:${input.features.identity.thesisKey}:${odds.asOf}`,
      kind: "outside_odds",
      scope: "external_market",
      measurement: {
        kind: "range",
        min: odds.probabilityMin,
        max: odds.probabilityMax,
        unit: "probability",
      },
      horizonDays: null,
      sampleSize: odds.sources.length,
      source: {
        kind: "external_research",
        label: odds.sources.map((source) => source.title).join(", "),
        url: odds.sources[0]?.url ?? null,
      },
      asOf: odds.asOf,
      quality: "external",
      context: null,
    });
  }

  return rows;
}

export function selectTelegramSignalEvidence(
  rows: SignalEvidenceMetricV1[],
): SignalEvidenceMetricV1[] {
  const priority: SignalEvidenceMetricV1["kind"][] = [
    "pricing_edge",
    "track_record",
    "conviction",
    "capital",
    "outside_odds",
    "volume",
  ];
  return rows
    .slice()
    .sort(
      (left, right) =>
        priority.indexOf(left.kind) - priority.indexOf(right.kind),
    )
    .slice(0, 3);
}
