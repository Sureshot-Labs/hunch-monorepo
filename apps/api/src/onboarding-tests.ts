import assert from "node:assert/strict";
import {
  onboardingCompleteBodySchema,
  onboardingInterestsBodySchema,
  onboardingProgressBodySchema,
  onboardingStateSchema,
} from "./schemas/onboarding.js";
import {
  initialOnboardingState,
  mergedOnboardingState,
  nextOnboardingState,
  normalizeOnboardingStep,
  requireOnboardingRevision,
} from "./services/onboarding-state.js";

const fresh = initialOnboardingState(false);
const legacy = initialOnboardingState(true);
assert.equal(fresh.nextStep, "interests");
assert.equal(fresh.status, "not_started");
assert.deepEqual(fresh.interestIds, []);
assert.equal(legacy.status, "completed");
assert.equal(legacy.completionReason, "legacy");
assert.equal(legacy.completedAt, null);
assert.equal(legacy.nextStep, null);
assert.notEqual(
  fresh.steps.interests,
  fresh.steps.handle,
  "step mutations cannot leak into other steps",
);
onboardingStateSchema.parse(fresh);
onboardingStateSchema.parse(legacy);
for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
  assert.equal(
    onboardingCompleteBodySchema.safeParse({ expectedRevision }).success,
    false,
  );
}
for (const extra of [
  { userId: "someone" },
  { completedAt: new Date().toISOString() },
  { status: "completed" },
  { revision: 1 },
]) {
  assert.equal(
    onboardingCompleteBodySchema.safeParse({ expectedRevision: 0, ...extra })
      .success,
    false,
  );
}
assert.equal(
  onboardingInterestsBodySchema.safeParse({
    expectedRevision: 0,
    outcome: "not_applicable",
    interestIds: [],
  }).success,
  false,
);
assert.equal(
  onboardingProgressBodySchema.safeParse({
    expectedRevision: 0,
    step: "interests",
    outcome: "completed",
  }).success,
  false,
);
assert.equal(
  onboardingProgressBodySchema.safeParse({
    expectedRevision: 0,
    step: "handle",
    outcome: "pending",
  }).success,
  false,
);
assert.equal(
  onboardingProgressBodySchema.safeParse({
    expectedRevision: 0,
    step: "passkey",
    outcome: "not_applicable",
    reason: "legacy_exempt",
  }).success,
  false,
);
assert.deepEqual(
  normalizeOnboardingStep({
    expectedRevision: 0,
    step: "handle",
    outcome: "skipped",
  }),
  { status: "skipped", reason: "user_skipped" },
);
assert.deepEqual(
  normalizeOnboardingStep({
    expectedRevision: 0,
    step: "photo",
    outcome: "skipped",
    reason: "no_photo",
  }),
  { status: "skipped", reason: "no_photo" },
);
for (const step of ["passkey", "notifications"] as const) {
  assert.equal(
    normalizeOnboardingStep({
      expectedRevision: 0,
      step,
      outcome: "not_applicable",
      reason: "capability_unavailable",
    }).status,
    "not_applicable",
  );
}
assert.throws(
  () =>
    normalizeOnboardingStep({
      expectedRevision: 0,
      step: "handle",
      outcome: "not_applicable",
      reason: "feature_unavailable",
    }),
  /invalid_request/,
);
assert.throws(
  () =>
    normalizeOnboardingStep({
      expectedRevision: 0,
      step: "passkey",
      outcome: "completed",
      reason: "user_skipped",
    }),
  /invalid_request/,
);
assert.throws(
  () =>
    normalizeOnboardingStep({
      expectedRevision: 0,
      step: "photo",
      outcome: "skipped",
      reason: "suggestions_unavailable",
    }),
  /invalid_request/,
);
for (const revision of [1, 999])
  assert.throws(
    () => requireOnboardingRevision(fresh, revision),
    /onboarding_revision_conflict/,
  );
requireOnboardingRevision(fresh, 0);

const selected = structuredClone(fresh);
selected.interestIds = ["usElections", "politics", "trump"];
selected.steps.interests = { status: "completed", reason: null };
const started = nextOnboardingState(selected);
assert.equal(started.nextStep, "handle");
assert.equal(started.status, "in_progress");
assert.equal(started.revision, 1);
const skipped = structuredClone(started);
skipped.interestIds = [];
skipped.steps.interests = { status: "skipped", reason: "user_skipped" };
const evidence = { handle: false, photo: false };
const explicitTarget = mergedOnboardingState(started, skipped, evidence);
assert.equal(
  explicitTarget,
  skipped,
  "source must not override an explicit target Skip",
);
const adopted = mergedOnboardingState(started, legacy, evidence);
assert.deepEqual(
  adopted.interestIds,
  selected.interestIds,
  "legacy exemption is not a choice to skip interests",
);
assert.equal(adopted.status, "completed");
assert.equal(adopted.completionReason, "legacy");
assert.equal(adopted.completedAt, null);
assert.equal(adopted.nextStep, null);
assert.equal(
  mergedOnboardingState(started, adopted, evidence),
  adopted,
  "repeated keepSource merge is a no-op",
);
const done = structuredClone(started);
for (const step of Object.values(done.steps))
  Object.assign(step, { status: "completed", reason: null });
Object.assign(done, {
  status: "completed",
  completionReason: "flow",
  completedAt: "2026-10-16T12:00:00.000Z",
  nextStep: null,
});
const transferred = mergedOnboardingState(done, skipped, evidence);
assert.equal(transferred.completedAt, done.completedAt);
assert.deepEqual(transferred.interestIds, []);
assert.equal(transferred.steps.interests.status, "skipped");
assert.equal(
  transferred.steps.photo.status,
  "not_applicable",
  "do not claim a source photo transferred without target evidence",
);
assert.equal(transferred.steps.photo.reason, "profile_not_transferred");
const originalCompletion = structuredClone(done);
originalCompletion.completedAt = "2026-10-15T12:00:00.000Z";
assert.equal(
  mergedOnboardingState(done, originalCompletion, evidence).completedAt,
  originalCompletion.completedAt,
);
console.log(
  "[onboarding-tests] schemas, optional steps, exact revisions, merge choice and completion invariants passed",
);
