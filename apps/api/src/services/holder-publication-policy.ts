// Sidecar-safe subset: do not import the API-wide env/runtime-policy resolver.
import { fetchActiveRuntimePolicy } from "@hunch/db";
import type { DbQuery } from "../db.js";
import type { SignalBotNote } from "./signal-bot-contracts.js";
import { holderPublicationComparisonSchema } from "../schemas/holder-publication-comparison.js";
import {
  assessHolderSideChange,
  publicSnapshotPositions,
  type HolderContractHistory,
} from "./holder-research-publication-history.js";

export function parseHolderPublicationPolicy(value: unknown) {
  const row =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const finite = (key: string, fallback: number) =>
    typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0
      ? row[key]
      : fallback;
  return {
    singleGameSportsClusterOnly: row.singleGameSportsClusterOnly !== false,
    sideChangeRequiresEvidence: row.sideChangeRequiresEvidence !== false,
    minSidePositionUsd: finite("minSidePositionUsd", 25_000),
    minMeaningfulHolderUsdDelta: finite("minMeaningfulHolderUsdDelta", 5_000),
    minMeaningfulHolderPctDelta: finite("minMeaningfulHolderPctDelta", 0.25),
  };
}
export async function loadHolderPublicationPolicy(db: DbQuery) {
  const row = await fetchActiveRuntimePolicy(db, "holder_research");
  return parseHolderPublicationPolicy(row?.payload);
}
export function validatePendingHolderPublication(input: {
  note: SignalBotNote;
  policy: ReturnType<typeof parseHolderPublicationPolicy>;
  history: HolderContractHistory;
  side: "YES" | "NO";
}) {
  const { note, policy } = input;
  // The delivery reader recomputes marketSegment using current taxonomy.
  if (
    policy.singleGameSportsClusterOnly &&
    note.marketSegment?.endsWith("_game") &&
    (note.holderActorMode !== "sharp_cluster" ||
      (note.holderClusterSharpHolders ?? 0) < 2 ||
      (note.holderClusterSharpUsd ?? 0) < policy.minSidePositionUsd)
  ) {
    return { allowed: false, reason: "single_game_sports_cluster_required" };
  }
  const saved = note.metrics?.holderPublicationComparisonV1 as
    | Record<string, unknown>
    | undefined;
  const parsed = holderPublicationComparisonSchema.safeParse(saved?.comparison);
  return assessHolderSideChange({
    enabled: policy.sideChangeRequiresEvidence,
    side: input.side,
    history: input.history,
    comparison: parsed.success ? parsed.data : null,
    positions: publicSnapshotPositions(note.decisionSnapshot),
    externalResearch: note.modelMeta.external_research,
    externalFactEvidence: note.modelMeta.update_evidence,
    minUsd: policy.minMeaningfulHolderUsdDelta,
    minPct: policy.minMeaningfulHolderPctDelta,
    now: new Date(note.createdAt),
  });
}
