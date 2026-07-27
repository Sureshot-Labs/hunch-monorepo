#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { isSafelyCancellableStepLessIngress } from "../../reconciliation/funding-operation-cancellation.js";

const waitingDirectIngress = {
  planKind: "direct_external_handoff",
  status: "awaiting_external_funds",
  progressStage: "source_action",
} as const;

assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: waitingDirectIngress,
    stepCount: 0,
    hasUnsafeExternalEffects: false,
  }),
  true,
);
assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: waitingDirectIngress,
    stepCount: 0,
    hasUnsafeExternalEffects: true,
  }),
  false,
);
assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: waitingDirectIngress,
    stepCount: 1,
    hasUnsafeExternalEffects: false,
  }),
  false,
);
assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: {
      ...waitingDirectIngress,
      status: "in_progress",
      progressStage: "source_observed",
    },
    stepCount: 0,
    hasUnsafeExternalEffects: false,
  }),
  false,
);

console.log(
  "[funding-operation-cancellation-tests] step-less direct ingress cancellation remains pre-evidence and fail-closed",
);
