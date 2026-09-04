#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  deriveFundingLifecycle,
  deriveFundingLifecycleBeforeActionBroadcast,
  type FundingLifecycleActionAttempt,
  type FundingLifecycleActionFact,
  type FundingLifecycleFacts,
  type FundingLifecycleTransferEvidence,
} from "../../lifecycle/funding-lifecycle-projector.js";

const now = new Date("2026-09-03T10:00:00.000Z");
const destination = {
  networkId: "evm:8453",
  assetId: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  decimals: 6,
  raw: "1000000",
} as const;

function attempt(
  overrides: Partial<FundingLifecycleActionAttempt> = {},
): FundingLifecycleActionAttempt {
  return {
    attemptNumber: 1,
    outcome: "started",
    broadcastMayHaveOccurred: false,
    referenceKind: null,
    retryableAfterFailure: false,
    startedAt: now,
    updatedAt: now,
    receipt: null,
    ...overrides,
  };
}

function action(
  actionId: string,
  overrides: Partial<FundingLifecycleActionFact> = {},
): FundingLifecycleActionFact {
  return {
    actionId,
    ordinal: 0,
    executorId: "test-executor",
    routeLegId: null,
    dependsOnActionId: null,
    activation: "immediate",
    expiresAt: new Date(now.getTime() + 60_000),
    independentLane: true,
    mayMoveMoney: true,
    safeInternalHandoff: false,
    requiresSourceDebitEvidence: false,
    requiresVenueReadiness: false,
    attempts: [],
    ...overrides,
  };
}

function routeLeg(
  routeLegId: string,
  overrides: Partial<FundingLifecycleFacts["plan"]["routeLegs"][number]> = {},
): FundingLifecycleFacts["plan"]["routeLegs"][number] {
  return {
    routeLegId,
    requestedSource: destination,
    minimumDestination: destination,
    ...overrides,
  };
}

function transfer(
  kind: FundingLifecycleTransferEvidence["kind"],
  overrides: Partial<FundingLifecycleTransferEvidence> = {},
): FundingLifecycleTransferEvidence {
  return {
    kind,
    routeLegId: null,
    money: destination,
    finality: "finalized",
    canonical: true,
    observedAt: now,
    reorgedAt: null,
    replacementForTransferId: null,
    ...overrides,
    transferId:
      overrides.transferId ?? `${kind}:${overrides.routeLegId ?? "default"}`,
  };
}

function facts(
  overrides: Partial<FundingLifecycleFacts> = {},
): FundingLifecycleFacts {
  return {
    plan: {
      initialState: {
        status: "awaiting_user",
        progressStage: "source_action",
      },
      requestedDestination: destination,
      routeLegs: [],
      completionEvidence: "destination_credit",
    },
    actions: [action("first")],
    transfers: [],
    reservations: [{ mode: "subtract_available", state: "active" }],
    consumer: {
      required: true,
      completed: false,
      unresolved: false,
    },
    receive: null,
    now,
    ...overrides,
  };
}

{
  const startedFacts = facts({
    actions: [action("broadcast", { attempts: [attempt()] })],
  });
  assert.deepEqual(deriveFundingLifecycle(startedFacts).actions, [
    { actionId: "broadcast", state: "recovery_required", actionable: false },
  ]);
  assert.deepEqual(
    deriveFundingLifecycleBeforeActionBroadcast(startedFacts, {
      actionId: "broadcast",
      attemptNumber: 1,
    }).actions,
    [{ actionId: "broadcast", state: "action_required", actionable: true }],
    "the pre-broadcast check sees the same action-admission facts, not its own started attempt",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("polygon", { ordinal: 0 }),
        action("base", { ordinal: 1 }),
      ],
    }),
  );
  assert.equal(projection.status, "awaiting_user");
  assert.deepEqual(
    projection.actions.map((candidate) => [
      candidate.actionId,
      candidate.state,
      candidate.actionable,
    ]),
    [
      ["polygon", "action_required", true],
      ["base", "action_required", true],
    ],
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("confirmed-deposit-wallet-handoff", {
          ordinal: 0,
          safeInternalHandoff: true,
          attempts: [
            attempt({
              outcome: "ambiguous",
              broadcastMayHaveOccurred: true,
              referenceKind: "external_handoff",
              receipt: {
                status: "finalized",
                canonical: true,
                actionMatched: true,
                failureFinalized: false,
              },
            }),
          ],
        }),
        action("relay-not-broadcast", {
          ordinal: 1,
          dependsOnActionId: "confirmed-deposit-wallet-handoff",
          attempts: [attempt({ outcome: "failed" })],
        }),
      ],
    }),
  );
  assert.deepEqual(
    {
      status: projection.status,
      progressStage: projection.progressStage,
      terminal: projection.safety.terminal,
      reservationsMayRelease: projection.safety.reservationsMayRelease,
    },
    {
      status: "failed",
      progressStage: "terminal",
      terminal: true,
      reservationsMayRelease: true,
    },
    "a finalized Deposit Wallet-to-controller handoff must not strand cash when the following Relay action never broadcast",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("external-handoff", {
          ordinal: 0,
          attempts: [
            attempt({
              outcome: "ambiguous",
              broadcastMayHaveOccurred: true,
              referenceKind: "external_handoff",
              receipt: {
                status: "finalized",
                canonical: true,
                actionMatched: true,
                failureFinalized: false,
              },
            }),
          ],
        }),
        action("downstream-not-broadcast", {
          ordinal: 1,
          dependsOnActionId: "external-handoff",
          attempts: [attempt({ outcome: "failed" })],
        }),
      ],
    }),
  );
  assert.equal(
    projection.status,
    "recovery_required",
    "an external handoff remains protected when a later action fails",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("reorg-proven-safe-to-retry", {
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
              retryableAfterReorg: true,
              receipt: {
                status: "reorged",
                canonical: false,
                actionMatched: true,
                failureFinalized: false,
              },
            }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(projection.actions, [
    {
      actionId: "reorg-proven-safe-to-retry",
      state: "action_required",
      actionable: true,
    },
  ]);
  assert.equal(
    projection.safety.requiresWorker,
    false,
    "the durable bounded-reorg decision replaces the stale cache rearm",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("approval", {
          ordinal: 0,
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
              receipt: {
                status: "finalized",
                canonical: true,
                actionMatched: false,
                failureFinalized: false,
              },
            }),
          ],
        }),
        action("fund", { ordinal: 1, dependsOnActionId: "approval" }),
      ],
    }),
  );
  assert.deepEqual(projection.actions, [
    { actionId: "approval", state: "reconcile_required", actionable: false },
    { actionId: "fund", state: "reconcile_required", actionable: false },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      terminalCompletion: {
        code: "relay_allowance_cleanup_completed",
        decidedAt: now,
        actionId: "cleanup",
      },
      actions: [
        action("cleanup", {
          mayMoveMoney: false,
          attempts: [attempt({ outcome: "succeeded" })],
        }),
      ],
    }),
  );
  assert.deepEqual(
    { status: projection.status, progressStage: projection.progressStage },
    { status: "completed", progressStage: "terminal" },
    "a durable non-financial postcondition completes only its succeeded action",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      terminalCompletion: {
        code: "relay_allowance_cleanup_completed",
        decidedAt: now,
        actionId: "cleanup",
      },
      actions: [action("cleanup", { mayMoveMoney: false })],
    }),
  );
  assert.notEqual(
    projection.status,
    "completed",
    "a completion decision cannot fabricate an action that never succeeded",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "in_progress",
          progressStage: "committed",
        },
        requestedDestination: destination,
        routeLegs: [],
        completionEvidence: "destination_credit",
      },
    }),
  );
  assert.deepEqual(
    { status: projection.status, progressStage: projection.progressStage },
    { status: "in_progress", progressStage: "source_action" },
  );
  assert.equal(projection.safety.retryAllowed, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "in_progress",
          progressStage: "committed",
        },
        requestedDestination: destination,
        routeLegs: [],
        completionEvidence: "destination_credit",
      },
      actions: [action("sealed-telegram-action", { authorization: "blocked" })],
    }),
  );
  assert.deepEqual(projection.actions, [
    {
      actionId: "sealed-telegram-action",
      state: "planned",
      actionable: false,
    },
  ]);
  assert.deepEqual(
    { status: projection.status, progressStage: projection.progressStage },
    { status: "in_progress", progressStage: "source_action" },
    "an expired or revoked Telegram authority must not turn a planned server action into recovery or a new executable action",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("approval", {
          ordinal: 0,
          attempts: [attempt({ outcome: "succeeded" })],
        }),
        action("fund", {
          ordinal: 1,
          dependsOnActionId: "approval",
        }),
      ],
    }),
  );
  assert.deepEqual(
    projection.actions.map((candidate) => [
      candidate.actionId,
      candidate.state,
      candidate.actionable,
    ]),
    [
      ["approval", "succeeded", false],
      ["fund", "action_required", true],
    ],
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("ingress-child", {
          activation: "after_verified_ingress",
        }),
      ],
      receive: { open: true, expiresAt: new Date(now.getTime() + 60_000) },
    }),
  );
  assert.equal(projection.status, "awaiting_external_funds");
  assert.deepEqual(projection.actions, [
    { actionId: "ingress-child", state: "planned", actionable: false },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("ingress-child", {
          activation: "after_verified_ingress",
        }),
      ],
      transfers: [transfer("source_credit")],
    }),
  );
  assert.equal(projection.status, "in_progress");
  assert.equal(projection.progressStage, "source_observed");
  assert.deepEqual(projection.actions, [
    { actionId: "ingress-child", state: "action_required", actionable: true },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("broadcast", {
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "reconcile_required");
  assert.equal(projection.safety.requiresWorker, true);
  assert.equal(projection.safety.requiresManualRecovery, false);
  assert.deepEqual(projection.actions, [
    { actionId: "broadcast", state: "reconcile_required", actionable: false },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("broadcast", {
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
            }),
          ],
        }),
        action("separate-base-lane", { ordinal: 1, independentLane: true }),
      ],
    }),
  );
  assert.equal(projection.status, "reconcile_required");
  assert.deepEqual(projection.actions, [
    { actionId: "broadcast", state: "reconcile_required", actionable: false },
    {
      actionId: "separate-base-lane",
      state: "action_required",
      actionable: true,
    },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      now: new Date(now.getTime() + 61_000),
      actions: [
        action("broadcast", {
          expiresAt: new Date(now.getTime() + 60_000),
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresManualRecovery, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      manualRecovery: {
        code: "relay_cleanup_foreign_allowance_drift",
        requestedAt: now,
      },
      actions: [
        action("cleanup", {
          attempts: [
            attempt({ outcome: "submitted", broadcastMayHaveOccurred: true }),
          ],
        }),
      ],
    }),
  );
  assert.equal(
    projection.status,
    "recovery_required",
    "an explicit manual escalation outranks generic automatic reconciliation",
  );
  assert.equal(projection.safety.requiresManualRecovery, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [action("unfinished", { attempts: [attempt()] })],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresManualRecovery, false);
  assert.deepEqual(projection.actions, [
    { actionId: "unfinished", state: "recovery_required", actionable: false },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      now: new Date(now.getTime() + 61_000),
      reconciliation: {
        evidenceDeadline: new Date(now.getTime() + 60_000),
      },
      actions: [
        action("provider-receipt", {
          expiresAt: new Date(now.getTime() + 60_000),
          attempts: [
            attempt({
              outcome: "ambiguous",
              broadcastMayHaveOccurred: true,
              referenceKind: "provider_receipt",
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresManualRecovery, false);
  assert.equal(projection.safety.requiresWorker, true);
  assert.equal(
    projection.safety.reconciliationEvidenceTimedOut,
    false,
    "a durable provider receipt owns its replay lease instead of the generic deadline",
  );
  assert.equal(projection.errorCode, null);
  assert.deepEqual(projection.actions, [
    {
      actionId: "provider-receipt",
      state: "reconcile_required",
      actionable: false,
    },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      now: new Date(now.getTime() + 61_000),
      actions: [
        action("known-transaction-after-action-expiry", {
          expiresAt: new Date(now.getTime() + 60_000),
          attempts: [
            attempt({
              outcome: "ambiguous",
              broadcastMayHaveOccurred: true,
              referenceKind: "transaction",
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresManualRecovery, false);
  assert.equal(projection.safety.requiresWorker, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      automaticRecovery: {
        code: "reconciliation_evidence_timeout",
        requestedAt: now,
      },
      actions: [
        action("resolved-provider-reference", {
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
              referenceKind: "transaction",
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(
    projection.status,
    "recovery_required",
    "an elapsed evidence window remains recovery-required after its active timer is cleared",
  );
  assert.equal(projection.recoveryMode, "automatic_evidence");
  assert.equal(projection.errorCode, "reconciliation_evidence_timeout");
  assert.deepEqual(projection.actions, [
    {
      actionId: "resolved-provider-reference",
      state: "recovery_required",
      actionable: false,
    },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("provider-proven-safe-retry", {
          attempts: [
            attempt({
              outcome: "failed",
              retryableAfterFailure: true,
            }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(projection.actions, [
    {
      actionId: "provider-proven-safe-retry",
      state: "action_required",
      actionable: true,
    },
  ]);
  assert.equal(
    projection.status,
    "awaiting_user",
    "a provider-proven non-broadcast failure retries from its attempt fact, never an imperative step-cache write",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      manualRecovery: {
        code: "relay_cleanup_foreign_allowance_drift",
        requestedAt: now,
      },
      actions: [
        action("cleanup", {
          attempts: [attempt({ outcome: "failed" })],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.recoveryMode, "manual_review");
  assert.equal(projection.safety.requiresManualRecovery, true);
  assert.equal(projection.errorCode, "relay_cleanup_foreign_allowance_drift");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("stopped-before-late-broadcast", {
          attempts: [attempt({ outcome: "failed" })],
        }),
        action("late-broadcast", {
          ordinal: 1,
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
              referenceKind: "transaction",
            }),
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(
    {
      status: projection.status,
      progressStage: projection.progressStage,
      recoveryMode: projection.recoveryMode,
      errorCode: projection.errorCode,
    },
    {
      status: "recovery_required",
      progressStage: "source_action",
      recoveryMode: "automatic_evidence",
      errorCode: "late_broadcast_after_terminal_operation",
    },
    "a late possible broadcast reopens from durable attempt facts even if an old operation cache was terminal",
  );
}

{
  const projection = deriveFundingLifecycle(
    facts({
      terminalFailure: {
        code: "relay_allowance_ownership_changed",
        decidedAt: now,
        actionId: "deposit",
      },
      actions: [
        action("approval", {
          mayMoveMoney: false,
          attempts: [attempt({ outcome: "succeeded" })],
        }),
        action("deposit", {
          ordinal: 1,
          dependsOnActionId: "approval",
        }),
      ],
    }),
  );
  assert.equal(projection.status, "failed");
  assert.equal(projection.safety.terminal, true);
  assert.equal(projection.errorCode, "relay_allowance_ownership_changed");
  assert.deepEqual(projection.actions, [
    { actionId: "approval", state: "succeeded", actionable: false },
    { actionId: "deposit", state: "failed", actionable: false },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("receipt-reorg", {
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
              receipt: {
                status: "reorged",
                canonical: false,
                actionMatched: true,
                failureFinalized: false,
              },
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresManualRecovery, false);
  assert.equal(projection.safety.requiresWorker, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("receipt-mismatch", {
          attempts: [
            attempt({
              outcome: "submitted",
              broadcastMayHaveOccurred: true,
              receipt: {
                status: "mismatch",
                canonical: true,
                actionMatched: false,
                failureFinalized: false,
              },
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresManualRecovery, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("reported-success", {
          attempts: [attempt({ outcome: "succeeded" })],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "in_progress");
  assert.equal(projection.progressStage, "source_action");
  assert.equal(projection.safety.requiresWorker, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("late-failure", {
          attempts: [
            attempt({ attemptNumber: 1, outcome: "succeeded" }),
            attempt({
              attemptNumber: 2,
              outcome: "failed",
              receipt: {
                status: "failed",
                canonical: true,
                actionMatched: true,
                failureFinalized: true,
              },
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "reconcile_required");
  assert.equal(projection.safety.cancelAllowed, false);
  assert.equal(projection.safety.retryAllowed, false);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("cancelled", {
          attempts: [attempt({ outcome: "cancelled" })],
        }),
      ],
      transfers: [transfer("source_debit")],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.cancelAllowed, false);
  assert.equal(projection.safety.requiresWorker, true);
  assert.equal(projection.safety.retryAllowed, false);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("cancelled-after-debit", {
          attempts: [attempt({ outcome: "cancelled" })],
        }),
        action("otherwise-actionable-sibling", { ordinal: 1 }),
      ],
      transfers: [transfer("source_debit")],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresWorker, true);
  assert.equal(projection.safety.retryAllowed, false);
  assert.deepEqual(projection.actions, [
    {
      actionId: "cancelled-after-debit",
      state: "cancelled",
      actionable: false,
    },
    {
      actionId: "otherwise-actionable-sibling",
      state: "action_required",
      actionable: false,
    },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("failed", {
          attempts: [
            attempt({
              outcome: "failed",
              receipt: {
                status: "failed",
                canonical: true,
                actionMatched: true,
                failureFinalized: true,
              },
            }),
          ],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "awaiting_user");
  assert.equal(projection.safety.terminal, false);
  assert.deepEqual(projection.actions, [
    { actionId: "failed", state: "action_required", actionable: true },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("failed", { attempts: [attempt({ outcome: "failed" })] }),
      ],
    }),
  );
  assert.equal(projection.status, "failed");
  assert.equal(projection.safety.terminal, true);
  assert.equal(projection.safety.reservationsMayRelease, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      transfers: [transfer("refund_credit")],
    }),
  );
  assert.equal(projection.status, "refunded");
  assert.equal(projection.safety.reservationsMayRelease, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      actions: [
        action("cancelled", {
          attempts: [attempt({ outcome: "cancelled" })],
        }),
      ],
    }),
  );
  assert.equal(projection.status, "cancelled");
  assert.equal(projection.safety.terminal, true);
  assert.deepEqual(projection.actions, [
    { actionId: "cancelled", state: "cancelled", actionable: false },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      transfers: [transfer("destination_credit")],
      consumer: {
        required: true,
        completed: false,
        unresolved: false,
      },
    }),
  );
  assert.equal(projection.status, "ready");
  assert.equal(projection.progressStage, "ready_for_consumer");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      manualRecovery: { code: "receipt_mismatch", requestedAt: now },
      transfers: [transfer("destination_credit")],
      consumer: {
        required: true,
        completed: false,
        unresolved: false,
      },
    }),
  );
  assert.equal(
    projection.status,
    "ready",
    "final destination evidence must resolve a stale manual-recovery fact",
  );
  assert.equal(projection.recoveryMode, null);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("delegated-relay")],
        completionEvidence: "destination_credit",
      },
      actions: [
        action("delegated-deposit", {
          routeLegId: "delegated-relay",
          requiresSourceDebitEvidence: true,
          attempts: [attempt({ outcome: "succeeded" })],
        }),
      ],
      transfers: [
        transfer("destination_credit", { routeLegId: "delegated-relay" }),
      ],
    }),
  );
  assert.deepEqual(
    { status: projection.status, progressStage: projection.progressStage },
    { status: "reconcile_required", progressStage: "source_action" },
    "destination evidence alone must not complete a delegated source-debit route",
  );
  assert.equal(projection.safety.requiresWorker, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("delegated-relay")],
        completionEvidence: "destination_credit",
      },
      actions: [
        action("delegated-deposit", {
          routeLegId: "delegated-relay",
          requiresSourceDebitEvidence: true,
          attempts: [attempt({ outcome: "succeeded" })],
        }),
      ],
      transfers: [
        transfer("source_debit", { routeLegId: "delegated-relay" }),
        transfer("destination_credit", { routeLegId: "delegated-relay" }),
      ],
    }),
  );
  assert.equal(projection.status, "ready");
  assert.equal(projection.progressStage, "ready_for_consumer");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon"), routeLeg("base")],
        completionEvidence: "destination_credit",
      },
      actions: [
        action("polygon-deposit", {
          routeLegId: "polygon",
          requiresSourceDebitEvidence: true,
          attempts: [attempt({ outcome: "succeeded" })],
        }),
        action("base-deposit", {
          ordinal: 1,
          routeLegId: "base",
          requiresSourceDebitEvidence: true,
          attempts: [attempt({ outcome: "succeeded" })],
        }),
      ],
      transfers: [
        transfer("source_debit", { routeLegId: "polygon" }),
        transfer("destination_credit", { routeLegId: "polygon" }),
        transfer("destination_credit", { routeLegId: "base" }),
      ],
    }),
  );
  assert.equal(projection.status, "reconcile_required");
  assert.equal(projection.safety.requiresWorker, true);
}

{
  const unexpectedDestination = {
    ...destination,
    assetId: "0x0000000000000000000000000000000000000001",
  };
  const projection = deriveFundingLifecycle(
    facts({
      transfers: [
        transfer("destination_credit"),
        transfer("destination_credit", {
          transferId: "unexpected-destination-credit",
          money: unexpectedDestination,
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.requiresWorker, true);
  assert.equal(projection.safety.retryAllowed, false);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon"), routeLeg("base")],
        completionEvidence: "destination_credit",
      },
      transfers: [transfer("destination_credit", { routeLegId: "polygon" })],
    }),
  );
  assert.equal(projection.status, "in_progress");
  assert.equal(projection.progressStage, "routing");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "in_progress",
          progressStage: "routing",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon"), routeLeg("base")],
        completionEvidence: "destination_credit",
      },
      transfers: [transfer("refund_credit", { routeLegId: "polygon" })],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.progressStage, "routing");
  assert.equal(projection.safety.requiresWorker, true);
  assert.equal(projection.safety.retryAllowed, false);
}

{
  const polygonLeg = routeLeg("polygon");
  const solanaLeg = routeLeg("solana", {
    minimumDestination: { ...destination, raw: "4000000" },
  });
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: { ...destination, raw: "10000000" },
        routeLegs: [
          {
            ...polygonLeg,
            minimumDestination: { ...destination, raw: "6000000" },
          },
          solanaLeg,
        ],
        completionEvidence: "destination_credit",
      },
      actions: [
        action("polygon", {
          attempts: [attempt({ outcome: "succeeded" })],
        }),
        action("solana", { ordinal: 1 }),
      ],
      transfers: [
        transfer("destination_credit", {
          routeLegId: polygonLeg.routeLegId,
          money: { ...destination, raw: "6000000" },
        }),
      ],
    }),
  );
  assert.equal(projection.status, "in_progress");
  assert.equal(projection.progressStage, "routing");
  assert.equal(projection.actions[1]?.actionable, true);
}

{
  const polygonLeg = routeLeg("polygon", {
    minimumDestination: { ...destination, raw: "6000000" },
  });
  const solanaLeg = routeLeg("solana", {
    minimumDestination: { ...destination, raw: "4000000" },
  });
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: { ...destination, raw: "10000000" },
        routeLegs: [polygonLeg, solanaLeg],
        completionEvidence: "destination_credit",
      },
      transfers: [
        transfer("destination_credit", {
          routeLegId: polygonLeg.routeLegId,
          money: { ...destination, raw: "6000000" },
        }),
        transfer("destination_credit", {
          routeLegId: solanaLeg.routeLegId,
          money: { ...destination, raw: "4000000" },
        }),
      ],
    }),
  );
  assert.equal(projection.status, "ready");
  assert.equal(projection.progressStage, "ready_for_consumer");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon")],
        completionEvidence: "destination_credit",
      },
      actions: [
        action("polygon-fund", {
          routeLegId: "polygon",
          attempts: [attempt({ outcome: "succeeded" })],
        }),
      ],
      transfers: [
        transfer("source_debit", {
          routeLegId: "polygon",
          money: destination,
        }),
      ],
    }),
  );
  assert.deepEqual(projection.segments, [
    {
      routeLegId: "polygon",
      status: "submitted",
      actualInput: destination,
      actualOutput: null,
    },
  ]);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon")],
        completionEvidence: "destination_credit",
      },
      transfers: [
        transfer("destination_credit", {
          routeLegId: "polygon",
          money: destination,
        }),
      ],
    }),
  );
  assert.equal(projection.segments[0]?.status, "succeeded");
  assert.deepEqual(projection.segments[0]?.actualOutput, destination);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon")],
        completionEvidence: "destination_credit",
      },
      actions: [
        action("polygon-fund", {
          routeLegId: "polygon",
          attempts: [attempt({ outcome: "failed" })],
        }),
      ],
    }),
  );
  assert.equal(projection.segments[0]?.status, "failed");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon")],
        completionEvidence: "destination_credit",
      },
      transfers: [
        transfer("source_debit", {
          routeLegId: "polygon",
          finality: "reorged",
          canonical: false,
        }),
      ],
    }),
  );
  assert.equal(projection.segments[0]?.status, "recovery_required");
  assert.equal(projection.status, "recovery_required");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [routeLeg("polygon")],
        completionEvidence: "destination_credit",
      },
      transfers: [
        transfer("destination_credit", { routeLegId: "polygon" }),
        transfer("source_debit", {
          routeLegId: "polygon",
          finality: "reorged",
          canonical: false,
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.segments[0]?.status, "succeeded");
}

{
  const reorgedRefund = transfer("refund_credit", {
    transferId: "original-refund",
    finality: "reorged",
    canonical: false,
    reorgedAt: new Date(now.getTime() + 1_000),
  });
  const projection = deriveFundingLifecycle(
    facts({
      transfers: [
        reorgedRefund,
        transfer("refund_credit", {
          transferId: "replacement-refund",
          observedAt: new Date(now.getTime() + 1_001),
          replacementForTransferId: reorgedRefund.transferId,
        }),
      ],
    }),
  );
  assert.equal(projection.status, "refunded");
  assert.equal(projection.safety.terminal, true);
}

{
  const reorgedRefund = transfer("refund_credit", {
    transferId: "original-refund-with-wrong-successor",
    routeLegId: "polygon",
    finality: "reorged",
    canonical: false,
    reorgedAt: new Date(now.getTime() + 1_000),
  });
  const projection = deriveFundingLifecycle(
    facts({
      transfers: [
        reorgedRefund,
        transfer("refund_credit", {
          transferId: "wrong-amount-successor",
          routeLegId: "polygon",
          money: { ...destination, raw: "999999" },
          observedAt: new Date(now.getTime() + 1_001),
          replacementForTransferId: reorgedRefund.transferId,
        }),
      ],
    }),
  );
  assert.equal(projection.status, "recovery_required");
  assert.equal(projection.safety.terminal, false);
}

{
  const mixedCaseDestination = {
    ...destination,
    assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    raw: "1000000",
  };
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: mixedCaseDestination,
        routeLegs: [],
        completionEvidence: "destination_credit",
      },
      transfers: [
        transfer("destination_credit", {
          money: {
            ...mixedCaseDestination,
            assetId: mixedCaseDestination.assetId.toLowerCase(),
          },
        }),
      ],
    }),
  );
  assert.equal(projection.status, "ready");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [],
        completionEvidence: "destination_credit_and_venue_readiness",
      },
      transfers: [transfer("destination_credit"), transfer("venue_readiness")],
      consumer: {
        required: true,
        completed: false,
        unresolved: false,
      },
    }),
  );
  assert.equal(projection.status, "ready");
  assert.equal(projection.progressStage, "ready_for_consumer");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [],
        completionEvidence: "destination_credit_and_venue_readiness",
      },
      transfers: [transfer("destination_credit"), transfer("venue_readiness")],
      consumer: {
        required: true,
        completed: true,
        unresolved: false,
      },
    }),
  );
  assert.equal(projection.status, "completed");
  assert.equal(projection.safety.terminal, true);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: destination,
        routeLegs: [],
        completionEvidence: "venue_readiness",
      },
      transfers: [transfer("venue_readiness")],
      consumer: {
        required: true,
        completed: false,
        unresolved: false,
      },
    }),
  );
  assert.equal(projection.status, "ready");
  assert.equal(projection.progressStage, "ready_for_consumer");
}

{
  const projection = deriveFundingLifecycle(
    facts({
      transfers: [transfer("destination_credit")],
      consumer: {
        required: true,
        completed: false,
        unresolved: true,
      },
    }),
  );
  assert.equal(projection.status, "ready");
  assert.equal(projection.progressStage, "ready_for_consumer");
  assert.equal(projection.safety.cancelAllowed, false);
  assert.equal(projection.safety.requiresWorker, true);
  assert.equal(projection.safety.terminal, false);
}

{
  const projection = deriveFundingLifecycle(
    facts({
      transfers: [transfer("destination_credit")],
      consumer: {
        required: true,
        completed: false,
        settledWithoutConsumer: true,
        unresolved: true,
      },
    }),
  );
  assert.deepEqual(
    { status: projection.status, progressStage: projection.progressStage },
    { status: "completed", progressStage: "terminal" },
    "an expired pre-broadcast consumer cannot keep already-settled funding pending",
  );
}

{
  const leg = routeLeg("under-minimum", {
    minimumDestination: { ...destination, raw: "1000001" },
  });
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
        initialState: {
          status: "awaiting_user",
          progressStage: "source_action",
        },
        requestedDestination: leg.minimumDestination,
        routeLegs: [leg],
        completionEvidence: "destination_credit",
      },
      transfers: [
        transfer("destination_credit", {
          routeLegId: leg.routeLegId,
          money: destination,
        }),
      ],
    }),
  );
  assert.equal(projection.status, "in_progress");
  assert.equal(projection.progressStage, "routing");
  assert.equal(projection.segments[0]?.status, "settling");
}

{
  assert.throws(
    () =>
      deriveFundingLifecycle(
        facts({
          transfers: [
            transfer("destination_credit", { transferId: "duplicated" }),
            transfer("destination_credit", { transferId: "duplicated" }),
          ],
        }),
      ),
    /duplicate funding lifecycle transfer duplicated/u,
  );
}

{
  const base = facts({
    actions: [
      action("first", { ordinal: 0 }),
      action("second", { ordinal: 1 }),
    ],
    transfers: [transfer("source_credit"), transfer("intermediate_transfer")],
  });
  const reordered = deriveFundingLifecycle({
    ...base,
    actions: [...base.actions].reverse(),
    transfers: [...base.transfers].reverse(),
  });
  const canonical = deriveFundingLifecycle(base);
  assert.deepEqual(reordered, canonical);
}

{
  const directIngress = facts({
    plan: {
      initialState: {
        status: "awaiting_external_funds",
        progressStage: "source_action",
      },
      requestedDestination: destination,
      routeLegs: [],
      completionEvidence: "destination_credit",
    },
    actions: [],
    reservations: [{ mode: "advisory_destination", state: "active" }],
  });
  const beforeCancellation = deriveFundingLifecycle(directIngress);
  assert.deepEqual(
    {
      status: beforeCancellation.status,
      cancelAllowed: beforeCancellation.safety.cancelAllowed,
    },
    { status: "awaiting_external_funds", cancelAllowed: true },
  );

  const cancelled = deriveFundingLifecycle({
    ...directIngress,
    cancellation: { requestedAt: now },
  });
  assert.deepEqual(
    {
      status: cancelled.status,
      progressStage: cancelled.progressStage,
      terminal: cancelled.safety.terminal,
    },
    { status: "cancelled", progressStage: "terminal", terminal: true },
  );

  const lateTransfer = deriveFundingLifecycle({
    ...directIngress,
    cancellation: { requestedAt: now },
    transfers: [transfer("destination_credit")],
  });
  assert.deepEqual(
    {
      status: lateTransfer.status,
      terminal: lateTransfer.safety.terminal,
      requiresWorker: lateTransfer.safety.requiresWorker,
    },
    { status: "recovery_required", terminal: false, requiresWorker: true },
  );
}
