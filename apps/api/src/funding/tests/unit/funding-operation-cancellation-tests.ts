#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { isSafelyCancellableStepLessIngress } from "../../reconciliation/funding-operation-cancellation.js";

const waitingDirectIngress = {
  planKind: "direct_external_handoff",
} as const;

const untouchedExternalIngressLifecycle = {
  status: "awaiting_external_funds",
  safety: { cancelAllowed: true },
} as const;

assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: waitingDirectIngress,
    stepCount: 0,
    lifecycle: untouchedExternalIngressLifecycle,
  }),
  true,
);
assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: waitingDirectIngress,
    stepCount: 0,
    lifecycle: {
      ...untouchedExternalIngressLifecycle,
      safety: { cancelAllowed: false },
    },
  }),
  false,
);
assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: waitingDirectIngress,
    stepCount: 1,
    lifecycle: untouchedExternalIngressLifecycle,
  }),
  false,
);
assert.equal(
  isSafelyCancellableStepLessIngress({
    operation: {
      ...waitingDirectIngress,
    },
    stepCount: 0,
    lifecycle: {
      ...untouchedExternalIngressLifecycle,
      status: "in_progress",
    },
  }),
  false,
);

console.log(
  "[funding-operation-cancellation-tests] step-less direct ingress cancellation remains pre-evidence and fail-closed",
);
