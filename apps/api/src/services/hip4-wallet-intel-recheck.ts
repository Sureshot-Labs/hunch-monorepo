// Pure event-specific conflict policy. No provider, DB, API env or executor.
import {
  hip4TrackedFillFingerprint,
  type Hip4TrackedFillActivity,
} from "./hip4-wallet-intel.js";

export type Hip4TrackedActivityObservation = {
  provenance: "fresh_official_user_fills";
  observationId: string;
  observationStartedAtMs: number;
  conflictingFingerprint?: string | null;
};

/** The bounded current+repair response is one observation. Neither ordering nor
 * a repeated matching row later in that response can erase its contradiction. */
export function planHip4TrackedActivityBatch(
  activities: Hip4TrackedFillActivity[],
) {
  const byKey = new Map<
    string,
    { activity: Hip4TrackedFillActivity; conflictingFingerprint: string | null }
  >();
  for (const activity of activities) {
    const previous = byKey.get(activity.sourceEventKey);
    if (!previous)
      byKey.set(activity.sourceEventKey, {
        activity,
        conflictingFingerprint: null,
      });
    else if (
      hip4TrackedFillFingerprint(previous.activity) !==
      hip4TrackedFillFingerprint(activity)
    )
      previous.conflictingFingerprint = hip4TrackedFillFingerprint(activity);
  }
  return [...byKey.values()];
}

export function hip4TrackedActivityFlowProof(input: {
  metadata: Record<string, unknown>;
  sourceEventKey: string;
}): "eligible" | "disputed" | "legacy_ambiguous" | "invalid_proof" {
  const raw = input.metadata.nativeRecheck;
  // Old wallet-wide flags could already have been erased. No proof means that
  // the original's dispute history is unknown, not that it was verified clear.
  if (raw == null) return "legacy_ambiguous";
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid_proof";
  const proof = raw as Record<string, unknown>;
  if (
    proof.version !== 1 ||
    proof.provenance !== "fresh_official_user_fills" ||
    proof.sourceEventKey !== input.sourceEventKey ||
    proof.retainedFingerprint !== input.metadata.nativeFingerprint ||
    typeof proof.retainedFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.retainedFingerprint) ||
    typeof proof.lastObservedFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.lastObservedFingerprint) ||
    typeof proof.observationId !== "string" ||
    !proof.observationId ||
    !Number.isSafeInteger(proof.observationStartedAtMs) ||
    !Number.isSafeInteger(proof.checkedAtMs) ||
    Number(proof.observationStartedAtMs) > Number(proof.checkedAtMs)
  )
    return "invalid_proof";
  if (proof.state === "disputed") return "disputed";
  if (
    proof.state !== "verified" ||
    proof.lastObservedFingerprint !== proof.retainedFingerprint ||
    (proof.conflictAtMs != null &&
      (!Number.isSafeInteger(proof.conflictAtMs) ||
        Number(proof.observationStartedAtMs) <= Number(proof.conflictAtMs) ||
        proof.conflictObservationId === proof.observationId))
  )
    return "invalid_proof";
  return "eligible";
}
