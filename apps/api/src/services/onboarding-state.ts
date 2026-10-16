import {
  onboardingStepNames,
  type OnboardingProgressInput,
  type OnboardingState,
  type OnboardingStepResult,
} from "../schemas/onboarding.js";
import { SocialError } from "./social-primitives.js";

export class OnboardingError extends SocialError {
  constructor(
    code: string,
    statusCode: number,
    public readonly onboarding?: OnboardingState,
  ) {
    super(code, statusCode);
    this.name = "OnboardingError";
  }
}

export function initialOnboardingState(legacy: boolean): OnboardingState {
  const result: OnboardingStepResult = legacy
    ? { status: "not_applicable", reason: "legacy_exempt" }
    : { status: "pending", reason: null };
  return {
    flowVersion: 1,
    revision: 0,
    status: legacy ? "completed" : "not_started",
    completionReason: legacy ? "legacy" : null,
    completedAt: null,
    nextStep: legacy ? null : "interests",
    interestIds: [],
    steps: {
      interests: { ...result },
      handle: { ...result },
      photo: { ...result },
      passkey: { ...result },
      notifications: { ...result },
      traders: { ...result },
    },
  };
}

export function nextOnboardingState(state: OnboardingState): OnboardingState {
  const revision = state.revision + 1;
  if (!Number.isSafeInteger(revision))
    throw new OnboardingError("onboarding_revision_exhausted", 409);
  return {
    ...state,
    revision,
    status: state.status === "not_started" ? "in_progress" : state.status,
    nextStep:
      state.status === "completed"
        ? null
        : (onboardingStepNames.find(
            (step) => state.steps[step].status === "pending",
          ) ?? null),
  };
}

export function hasExplicitInterestChoice(state: OnboardingState): boolean {
  return ["completed", "skipped"].includes(state.steps.interests.status);
}

export function normalizeOnboardingStep(
  input: OnboardingProgressInput,
): OnboardingStepResult {
  if (input.outcome === "completed") {
    if (input.reason != null) throw new OnboardingError("invalid_request", 400);
    return { status: "completed", reason: null };
  }
  const reason =
    input.reason ?? (input.outcome === "skipped" ? "user_skipped" : null);
  const allowed =
    input.outcome === "skipped"
      ? [
          "user_skipped",
          ...(input.step === "photo" ? ["no_photo"] : []),
          ...(input.step === "traders" ? ["suggestions_unavailable"] : []),
        ]
      : input.step === "passkey" || input.step === "notifications"
        ? ["feature_unavailable", "capability_unavailable"]
        : input.step === "traders"
          ? ["feature_unavailable", "insufficient_suggestions"]
          : [];
  if (reason === null || !allowed.includes(reason))
    throw new OnboardingError("invalid_request", 400);
  return { status: input.outcome, reason };
}

export function requireOnboardingRevision(
  state: OnboardingState,
  expected: number,
): void {
  if (expected !== state.revision)
    throw new OnboardingError("onboarding_revision_conflict", 409, state);
}

/** Callers already hold both users' lifecycle locks; evidence is from the resulting target profile. */
export function mergedOnboardingState(
  source: OnboardingState,
  target: OnboardingState,
  evidence: { handle: boolean; photo: boolean },
): OnboardingState {
  const merged = structuredClone(target);
  if (!hasExplicitInterestChoice(target) && hasExplicitInterestChoice(source)) {
    merged.interestIds = [...source.interestIds];
    merged.steps.interests = { ...source.steps.interests };
  }
  const completion =
    target.status === "completed"
      ? target
      : source.status === "completed"
        ? source
        : null;
  for (const step of onboardingStepNames) {
    if (step === "interests" || merged.steps[step].status !== "pending")
      continue;
    const candidate = source.steps[step];
    if (candidate.status === "pending") continue;
    if (
      candidate.status === "completed" &&
      ((step === "handle" && !evidence.handle) ||
        (step === "photo" && !evidence.photo))
    ) {
      // A completed source flow remains completed even if its asset/handle did not transfer.
      if (completion)
        merged.steps[step] = {
          status: "not_applicable",
          reason: "profile_not_transferred",
        };
      continue;
    }
    merged.steps[step] = { ...candidate };
  }
  if (completion) {
    merged.status = "completed";
    merged.completedAt = completion.completedAt;
    merged.completionReason = completion.completionReason;
    for (const step of onboardingStepNames) {
      if (merged.steps[step].status === "pending")
        merged.steps[step] = {
          status: "not_applicable",
          reason: "legacy_exempt",
        };
    }
    merged.nextStep = null;
  } else if (source.status === "in_progress") {
    merged.status = "in_progress";
  }
  // Repeated keepSource merges must not bump the revision without a new effect.
  if (JSON.stringify(merged) === JSON.stringify(target)) return target;
  return nextOnboardingState(merged);
}
