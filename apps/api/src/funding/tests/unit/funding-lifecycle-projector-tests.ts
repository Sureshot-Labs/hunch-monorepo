#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  deriveFundingLifecycle,
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
    routeLegId: null,
    dependsOnActionId: null,
    activation: "immediate",
    expiresAt: new Date(now.getTime() + 60_000),
    independentLane: true,
    mayMoveMoney: true,
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
  assert.equal(projection.status, "reconcile_required");
  assert.equal(projection.safety.cancelAllowed, false);
  assert.equal(projection.safety.requiresWorker, true);
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
      plan: {
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
  const polygonLeg = routeLeg("polygon");
  const solanaLeg = routeLeg("solana", {
    minimumDestination: { ...destination, raw: "4000000" },
  });
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
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
  const mixedCaseDestination = {
    ...destination,
    assetId: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
    raw: "1000000",
  };
  const projection = deriveFundingLifecycle(
    facts({
      plan: {
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
  assert.equal(projection.status, "reconcile_required");
  assert.equal(projection.progressStage, "ready_for_consumer");
  assert.equal(projection.safety.cancelAllowed, false);
  assert.equal(projection.safety.requiresWorker, true);
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
