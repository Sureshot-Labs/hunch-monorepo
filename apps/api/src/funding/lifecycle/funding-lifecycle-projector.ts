/**
 * Funding's single lifecycle decision-maker.
 *
 * The input contains only immutable plan data and durable execution, money,
 * reservation, consumer, receive, and terminal-decision facts. In particular,
 * it deliberately does not accept materialized operation, step, or segment
 * status. `now` is explicit, keeping the reducer deterministic and testable.
 */

export type FundingLifecycleOperationStatus =
  | "awaiting_user"
  | "awaiting_external_funds"
  | "in_progress"
  | "ready"
  | "reconcile_required"
  | "recovery_required"
  | "completed"
  | "refunded"
  | "failed"
  | "cancelled";

export type FundingLifecycleProgressStage =
  | "committed"
  | "source_action"
  | "source_observed"
  | "routing"
  | "intermediate_observed"
  | "destination_observed"
  | "venue_preparation"
  | "ready_for_consumer"
  | "refunding"
  | "terminal";

export type FundingLifecycleActionState =
  | "planned"
  | "action_required"
  | "submitted"
  | "succeeded"
  | "reconcile_required"
  | "recovery_required"
  | "failed"
  | "cancelled";

export type FundingLifecycleTerminalOutcome = Extract<
  FundingLifecycleOperationStatus,
  "completed" | "refunded" | "failed" | "cancelled"
>;

export type FundingLifecycleMoney = Readonly<{
  networkId: string;
  assetId: string;
  decimals: number;
  raw: string;
}>;

export type FundingLifecycleActionReceipt = Readonly<{
  status:
    | "pending"
    | "confirmed"
    | "finalized"
    | "failed"
    | "mismatch"
    | "reorged";
  canonical: boolean;
  actionMatched: boolean | null;
  failureFinalized: boolean;
}>;

export type FundingLifecycleActionAttempt = Readonly<{
  attemptNumber: number;
  outcome:
    | "started"
    | "submitted"
    | "succeeded"
    | "failed"
    | "ambiguous"
    | "cancelled";
  broadcastMayHaveOccurred: boolean;
  receipt: FundingLifecycleActionReceipt | null;
}>;

export type FundingLifecycleActionFact = Readonly<{
  actionId: string;
  ordinal: number;
  /** Immutable owning route leg; null is an operation-level action. */
  routeLegId: string | null;
  dependsOnActionId: string | null;
  /** Immutable plan contract, not the old mutable `step.state`. */
  activation: "immediate" | "after_verified_ingress";
  expiresAt: Date | null;
  /** Distinct action lanes can proceed while another lane reconciles. */
  independentLane: boolean;
  /** The immutable action can debit, transfer, or otherwise move funding. */
  mayMoveMoney: boolean;
  /** This immutable action establishes destination-venue readiness. */
  requiresVenueReadiness: boolean;
  attempts: readonly FundingLifecycleActionAttempt[];
}>;

export type FundingLifecycleTransferEvidence = Readonly<{
  transferId: string;
  routeLegId: string | null;
  kind:
    | "source_debit"
    | "source_credit"
    | "intermediate_transfer"
    | "destination_credit"
    | "refund_credit"
    | "venue_readiness";
  money: FundingLifecycleMoney;
  finality: "observed" | "confirmed" | "finalized" | "reorged";
  canonical: boolean;
}>;

export type FundingLifecycleReservationFact = Readonly<{
  mode: "subtract_available" | "advisory_destination" | "settled_for_consumer";
  state: "active" | "consumed" | "released";
}>;

export type FundingLifecycleConsumerFact = Readonly<{
  required: boolean;
  /** A consumer-side attempt still owns a reservation or venue outcome. */
  completed: boolean;
  unresolved: boolean;
}>;

export type FundingLifecycleReceiveFact = Readonly<{
  open: boolean;
  expiresAt: Date;
}>;

export type FundingLifecyclePlanFact = Readonly<{
  requestedDestination: FundingLifecycleMoney | null;
  /** Immutable segment identity and the minimum that this leg must deliver. */
  routeLegs: readonly Readonly<{
    routeLegId: string;
    requestedSource: FundingLifecycleMoney;
    minimumDestination: FundingLifecycleMoney;
  }>[];
  /** Immutable plan topology determines which final evidence completes it. */
  completionEvidence:
    | "destination_credit"
    | "venue_readiness"
    | "destination_credit_and_venue_readiness";
}>;

export type FundingLifecycleFacts = Readonly<{
  plan: FundingLifecyclePlanFact;
  actions: readonly FundingLifecycleActionFact[];
  transfers: readonly FundingLifecycleTransferEvidence[];
  reservations: readonly FundingLifecycleReservationFact[];
  consumer: FundingLifecycleConsumerFact;
  receive: FundingLifecycleReceiveFact | null;
  now: Date;
}>;

export type FundingLifecycleActionProjection = Readonly<{
  actionId: string;
  state: FundingLifecycleActionState;
  actionable: boolean;
}>;

export type FundingLifecycleSegmentStatus =
  | "planned"
  | "awaiting_source"
  | "submitted"
  | "settling"
  | "succeeded"
  | "reconcile_required"
  | "recovery_required"
  | "refunding"
  | "refunded"
  | "failed";

export type FundingLifecycleSegmentProjection = Readonly<{
  routeLegId: string;
  status: FundingLifecycleSegmentStatus;
  actualInput: FundingLifecycleMoney | null;
  actualOutput: FundingLifecycleMoney | null;
}>;

export type FundingLifecycleSafetyProjection = Readonly<{
  moneyMayHaveMoved: boolean;
  requiresWorker: boolean;
  requiresManualRecovery: boolean;
  retryAllowed: boolean;
  cancelAllowed: boolean;
  reservationsMayRelease: boolean;
  terminal: boolean;
}>;

export type FundingLifecycleProjection = Readonly<{
  status: FundingLifecycleOperationStatus;
  progressStage: FundingLifecycleProgressStage;
  actions: readonly FundingLifecycleActionProjection[];
  segments: readonly FundingLifecycleSegmentProjection[];
  safety: FundingLifecycleSafetyProjection;
}>;

type ActionExecution =
  | "not_started"
  | "started"
  | "submitted"
  | "succeeded"
  | "retryable_failure"
  | "final_failure"
  | "cancelled"
  | "ambiguous";

function assertActionGraph(
  actions: readonly FundingLifecycleActionFact[],
  transfers: readonly FundingLifecycleTransferEvidence[],
): void {
  const ids = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.actionId)) {
      throw new Error(`duplicate funding lifecycle action ${action.actionId}`);
    }
    ids.add(action.actionId);
  }
  for (const action of actions) {
    if (
      action.dependsOnActionId !== null &&
      !ids.has(action.dependsOnActionId)
    ) {
      throw new Error(
        `funding lifecycle action ${action.actionId} has an unknown dependency`,
      );
    }
    const dependency = actions.find(
      (candidate) => candidate.actionId === action.dependsOnActionId,
    );
    if (dependency && dependency.ordinal >= action.ordinal) {
      throw new Error(
        `funding lifecycle action ${action.actionId} depends on a non-prior action`,
      );
    }
    const attemptNumbers = new Set<number>();
    for (const attempt of action.attempts) {
      if (
        !Number.isInteger(attempt.attemptNumber) ||
        attempt.attemptNumber <= 0
      ) {
        throw new Error(
          `funding lifecycle action ${action.actionId} has an invalid attempt number`,
        );
      }
      if (attemptNumbers.has(attempt.attemptNumber)) {
        throw new Error(
          `funding lifecycle action ${action.actionId} has duplicate attempts`,
        );
      }
      attemptNumbers.add(attempt.attemptNumber);
    }
  }
  const transferIds = new Set<string>();
  for (const transfer of transfers) {
    if (transferIds.has(transfer.transferId)) {
      throw new Error(
        `duplicate funding lifecycle transfer ${transfer.transferId}`,
      );
    }
    transferIds.add(transfer.transferId);
  }
}

function hasCanonicalFinalReceipt(
  receipt: FundingLifecycleActionReceipt | null,
): boolean {
  return (
    receipt?.status === "finalized" &&
    receipt.canonical &&
    receipt.actionMatched === true
  );
}

function hasCanonicalFinalFailure(
  receipt: FundingLifecycleActionReceipt | null,
): boolean {
  return (
    receipt?.status === "failed" &&
    receipt.canonical &&
    receipt.failureFinalized
  );
}

function unresolvedAttempt(attempt: FundingLifecycleActionAttempt): boolean {
  if (
    hasCanonicalFinalReceipt(attempt.receipt) ||
    hasCanonicalFinalFailure(attempt.receipt)
  ) {
    return false;
  }
  return (
    attempt.broadcastMayHaveOccurred ||
    attempt.outcome === "submitted" ||
    attempt.outcome === "ambiguous"
  );
}

function actionExecution(action: FundingLifecycleActionFact): ActionExecution {
  const attempts = [...action.attempts].sort(
    (left, right) => right.attemptNumber - left.attemptNumber,
  );
  const latest = attempts[0];
  if (!latest) return "not_started";
  if (hasCanonicalFinalReceipt(latest.receipt)) return "succeeded";
  if (hasCanonicalFinalFailure(latest.receipt)) return "retryable_failure";
  switch (latest.outcome) {
    case "started":
      return "started";
    case "submitted":
      return "submitted";
    case "succeeded":
      // The executor report itself is durable evidence for non-receipt actions
      // (for example a signature). Receipt evidence wins whenever it exists.
      return "succeeded";
    case "failed":
      return latest.broadcastMayHaveOccurred ? "ambiguous" : "final_failure";
    case "ambiguous":
      return "ambiguous";
    case "cancelled":
      return "cancelled";
  }
}

function hasUnresolvedMovement(action: FundingLifecycleActionFact): boolean {
  return action.attempts.some(unresolvedAttempt);
}

function actionMayHaveMovedMoney(action: FundingLifecycleActionFact): boolean {
  return (
    action.mayMoveMoney &&
    action.attempts.some(
      (attempt) =>
        attempt.outcome === "succeeded" ||
        hasCanonicalFinalReceipt(attempt.receipt),
    )
  );
}

function actionHasConflictingExecutionHistory(
  action: FundingLifecycleActionFact,
): boolean {
  return (
    actionMayHaveMovedMoney(action) && actionExecution(action) !== "succeeded"
  );
}

function actionCanonicalityConflict(
  action: FundingLifecycleActionFact,
): boolean {
  return action.attempts.some(
    (attempt) =>
      attempt.receipt?.status === "mismatch" ||
      attempt.receipt?.status === "reorged" ||
      (attempt.receipt !== null && !attempt.receipt.canonical),
  );
}

function isCanonicalFinal(transfer: FundingLifecycleTransferEvidence): boolean {
  return transfer.canonical && transfer.finality === "finalized";
}

function sameMoneyAsset(
  left: Pick<FundingLifecycleMoney, "networkId" | "assetId" | "decimals">,
  right: Pick<FundingLifecycleMoney, "networkId" | "assetId" | "decimals">,
): boolean {
  const canonicalAssetId = (networkId: string, assetId: string) =>
    networkId.startsWith("evm:") ? assetId.toLowerCase() : assetId;
  return (
    left.networkId === right.networkId &&
    canonicalAssetId(left.networkId, left.assetId) ===
      canonicalAssetId(right.networkId, right.assetId) &&
    left.decimals === right.decimals
  );
}

function sumDestination(
  transfers: readonly FundingLifecycleTransferEvidence[],
  plan: FundingLifecyclePlanFact,
): bigint | null {
  const requested = plan.requestedDestination;
  if (!requested) return null;
  const matching = transfers.filter(
    (transfer) =>
      isCanonicalFinal(transfer) &&
      transfer.kind === "destination_credit" &&
      sameMoneyAsset(transfer.money, requested),
  );
  if (matching.length === 0) return null;
  return matching.reduce(
    (total, transfer) => total + BigInt(transfer.money.raw),
    0n,
  );
}

function routeLegsSatisfied(
  transfers: readonly FundingLifecycleTransferEvidence[],
  plan: FundingLifecyclePlanFact,
): boolean {
  return plan.routeLegs.every((leg) => {
    const delivered = transfers
      .filter(
        (transfer) =>
          isCanonicalFinal(transfer) &&
          transfer.routeLegId === leg.routeLegId &&
          transfer.kind === "destination_credit" &&
          sameMoneyAsset(transfer.money, leg.minimumDestination),
      )
      .reduce((total, transfer) => total + BigInt(transfer.money.raw), 0n);
    return delivered >= BigInt(leg.minimumDestination.raw);
  });
}

function routeLegsRefunded(
  transfers: readonly FundingLifecycleTransferEvidence[],
  plan: FundingLifecyclePlanFact,
): boolean {
  return plan.routeLegs.every((leg) =>
    transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) &&
        transfer.routeLegId === leg.routeLegId &&
        transfer.kind === "refund_credit",
    ),
  );
}

function sumFinalTransfers(
  transfers: readonly FundingLifecycleTransferEvidence[],
  expected: FundingLifecycleMoney,
  kinds: readonly FundingLifecycleTransferEvidence["kind"][],
): FundingLifecycleMoney | null {
  const selected = transfers.filter(
    (transfer) =>
      isCanonicalFinal(transfer) &&
      kinds.includes(transfer.kind) &&
      sameMoneyAsset(transfer.money, expected),
  );
  if (selected.length === 0) return null;
  return {
    ...expected,
    raw: selected
      .reduce((total, transfer) => total + BigInt(transfer.money.raw), 0n)
      .toString(),
  };
}

function deriveSegmentProjections(
  facts: FundingLifecycleFacts,
): readonly FundingLifecycleSegmentProjection[] {
  return facts.plan.routeLegs.map((leg) => {
    const transfers = facts.transfers.filter(
      (transfer) => transfer.routeLegId === leg.routeLegId,
    );
    const actions = facts.actions.filter(
      (action) => action.routeLegId === leg.routeLegId,
    );
    const actualInput =
      sumFinalTransfers(transfers, leg.requestedSource, ["source_debit"]) ??
      sumFinalTransfers(transfers, leg.requestedSource, ["source_credit"]);
    const actualOutput = sumFinalTransfers(transfers, leg.minimumDestination, [
      "destination_credit",
    ]);
    const canonicalityConflict = transfers.some(
      (transfer) => transfer.finality === "reorged" || !transfer.canonical,
    );
    const unresolved = actions.some(hasUnresolvedMovement);
    const unresolvedExpired = actions.some(
      (action) => action.expiresAt !== null && action.expiresAt <= facts.now,
    );
    const refunded = transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) && transfer.kind === "refund_credit",
    );
    const intermediate = transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) && transfer.kind === "intermediate_transfer",
    );
    const reported = actions.some((action) =>
      ["submitted", "succeeded"].includes(actionExecution(action)),
    );
    const failed = actions.some(
      (action) => actionExecution(action) === "final_failure",
    );
    const awaitingIngress =
      actions.length > 0 &&
      actions.every(
        (action) =>
          action.activation === "after_verified_ingress" &&
          actionExecution(action) === "not_started",
      );

    const status: FundingLifecycleSegmentStatus = canonicalityConflict
      ? "recovery_required"
      : unresolved
        ? unresolvedExpired
          ? "recovery_required"
          : "reconcile_required"
        : refunded
          ? "refunded"
          : actualOutput !== null
            ? BigInt(actualOutput.raw) >= BigInt(leg.minimumDestination.raw)
              ? "succeeded"
              : "settling"
            : intermediate
              ? "settling"
              : actualInput !== null || reported
                ? "submitted"
                : failed
                  ? "failed"
                  : awaitingIngress
                    ? "awaiting_source"
                    : "planned";
    return {
      routeLegId: leg.routeLegId,
      status,
      actualInput,
      actualOutput,
    };
  });
}

function transferFacts(facts: FundingLifecycleFacts): Readonly<{
  canonicalityConflict: boolean;
  finalizedSource: boolean;
  finalizedIntermediate: boolean;
  finalizedDestination: boolean;
  finalizedVenueReadiness: boolean;
  finalizedRefund: boolean;
  destinationCreditRequirementMet: boolean;
  destinationCompletionMet: boolean;
  routeLegsSatisfied: boolean;
  routeLegsRefunded: boolean;
}> {
  const canonicalityConflict = facts.transfers.some(
    (transfer) => transfer.finality === "reorged" || !transfer.canonical,
  );
  const destinationTotal = sumDestination(facts.transfers, facts.plan);
  const requestedRaw = facts.plan.requestedDestination?.raw;
  const destinationCreditRequirementMet =
    destinationTotal !== null &&
    requestedRaw !== undefined &&
    destinationTotal >= BigInt(requestedRaw);
  const finalizedVenueReadiness = facts.transfers.some(
    (transfer) =>
      isCanonicalFinal(transfer) && transfer.kind === "venue_readiness",
  );
  const destinationCompletionMet =
    facts.plan.completionEvidence === "venue_readiness"
      ? finalizedVenueReadiness
      : facts.plan.completionEvidence === "destination_credit"
        ? destinationCreditRequirementMet
        : destinationCreditRequirementMet && finalizedVenueReadiness;
  return {
    canonicalityConflict,
    finalizedSource: facts.transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) &&
        (transfer.kind === "source_debit" || transfer.kind === "source_credit"),
    ),
    finalizedIntermediate: facts.transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) && transfer.kind === "intermediate_transfer",
    ),
    finalizedDestination: facts.transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) && transfer.kind === "destination_credit",
    ),
    finalizedVenueReadiness,
    finalizedRefund: facts.transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) && transfer.kind === "refund_credit",
    ),
    destinationCreditRequirementMet,
    destinationCompletionMet,
    routeLegsSatisfied: routeLegsSatisfied(facts.transfers, facts.plan),
    routeLegsRefunded: routeLegsRefunded(facts.transfers, facts.plan),
  };
}

function actionState(
  action: FundingLifecycleActionFact,
  dependencySucceeded: boolean,
  activationSatisfied: boolean,
  unresolvedMovement: boolean,
  now: Date,
): FundingLifecycleActionState {
  const execution = actionExecution(action);
  if (execution === "succeeded") return "succeeded";
  if (execution === "cancelled") return "cancelled";
  if (actionHasConflictingExecutionHistory(action)) {
    return "reconcile_required";
  }
  if (unresolvedMovement || execution === "ambiguous") {
    return "reconcile_required";
  }
  if (execution === "started" || execution === "submitted") return "submitted";
  if (execution === "retryable_failure") {
    if (
      !dependencySucceeded ||
      (action.activation === "after_verified_ingress" &&
        !activationSatisfied) ||
      (action.expiresAt !== null && action.expiresAt <= now)
    ) {
      return "planned";
    }
    return "action_required";
  }
  if (execution === "final_failure") return "failed";
  if (
    !dependencySucceeded ||
    (action.activation === "after_verified_ingress" && !activationSatisfied) ||
    (action.expiresAt !== null && action.expiresAt <= now)
  ) {
    return "planned";
  }
  return "action_required";
}

function progressFromEvidence(
  evidence: ReturnType<typeof transferFacts>,
  plan: FundingLifecyclePlanFact,
  consumer: FundingLifecycleConsumerFact,
): Readonly<{
  status: FundingLifecycleOperationStatus;
  progressStage: FundingLifecycleProgressStage;
}> | null {
  const destinationReady =
    evidence.destinationCompletionMet && evidence.routeLegsSatisfied;
  if (destinationReady) {
    if (!consumer.required || consumer.completed) {
      return { status: "completed", progressStage: "terminal" };
    }
    return { status: "ready", progressStage: "ready_for_consumer" };
  }
  if (
    evidence.finalizedDestination &&
    evidence.destinationCreditRequirementMet
  ) {
    return {
      status: "in_progress",
      progressStage:
        plan.routeLegs.length > 0 && !evidence.routeLegsSatisfied
          ? "routing"
          : "venue_preparation",
    };
  }
  if (evidence.finalizedDestination && plan.routeLegs.length > 0) {
    return { status: "in_progress", progressStage: "routing" };
  }
  if (evidence.finalizedVenueReadiness) {
    return { status: "in_progress", progressStage: "venue_preparation" };
  }
  if (evidence.finalizedIntermediate) {
    return { status: "in_progress", progressStage: "intermediate_observed" };
  }
  if (evidence.finalizedSource) {
    return { status: "in_progress", progressStage: "source_observed" };
  }
  return null;
}

function isTerminalStatus(
  status: FundingLifecycleOperationStatus,
): status is FundingLifecycleTerminalOutcome {
  return ["completed", "refunded", "failed", "cancelled"].includes(status);
}

/**
 * Computes one public lifecycle projection from durable facts. All callers —
 * HTTP, workers, cancellation, receive, and Telegram — use this exact
 * function after their fact loader is cut over.
 */
export function deriveFundingLifecycle(
  facts: FundingLifecycleFacts,
): FundingLifecycleProjection {
  assertActionGraph(facts.actions, facts.transfers);
  const evidence = transferFacts(facts);
  const unresolvedActions = facts.actions.filter(hasUnresolvedMovement);
  const unresolvedMovement = unresolvedActions.length > 0;
  const unresolvedActionExpired = unresolvedActions.some(
    (action) => action.expiresAt !== null && action.expiresAt <= facts.now,
  );
  const actionEvidenceConflict = facts.actions.some(actionCanonicalityConflict);
  const conflictingActionHistory = facts.actions.some(
    actionHasConflictingExecutionHistory,
  );
  const actionReportedMovement = facts.actions.some(actionMayHaveMovedMoney);
  const moneyMayHaveMoved =
    unresolvedMovement ||
    facts.consumer.unresolved ||
    actionReportedMovement ||
    facts.transfers.some(
      (transfer) =>
        transfer.kind !== "venue_readiness" &&
        transfer.finality !== "reorged" &&
        transfer.canonical,
    );
  const activationSatisfied = evidence.finalizedSource;
  const byId = new Map<string, FundingLifecycleActionProjection>();
  const actions = [...facts.actions]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((action) => {
      const dependency =
        action.dependsOnActionId === null
          ? null
          : (byId.get(action.dependsOnActionId) ?? null);
      const state = actionState(
        action,
        dependency === null || dependency.state === "succeeded",
        activationSatisfied,
        hasUnresolvedMovement(action),
        facts.now,
      );
      const actionable =
        state === "action_required" &&
        (!unresolvedMovement || action.independentLane);
      const projection = { actionId: action.actionId, state, actionable };
      byId.set(action.actionId, projection);
      return projection;
    });
  const canReleaseUntouchedReservations =
    !moneyMayHaveMoved &&
    !facts.consumer.unresolved &&
    facts.reservations.every((reservation) => reservation.state !== "consumed");

  let status: FundingLifecycleOperationStatus;
  let progressStage: FundingLifecycleProgressStage;
  let requiresWorker = false;
  let requiresManualRecovery = false;

  const allActionsCancelled =
    actions.length > 0 &&
    actions.every((action) => action.state === "cancelled");
  const hasFinalFailure = actions.some((action) => action.state === "failed");
  const hasActionable = actions.some((action) => action.actionable);
  const onlyTerminalOrBlockedActions = actions.every((action) =>
    ["failed", "cancelled", "planned"].includes(action.state),
  );

  if (evidence.canonicalityConflict || actionEvidenceConflict) {
    status = "recovery_required";
    progressStage = "source_action";
    requiresWorker = true;
    requiresManualRecovery = true;
  } else if (unresolvedMovement || conflictingActionHistory) {
    status = unresolvedActionExpired
      ? "recovery_required"
      : "reconcile_required";
    progressStage = "source_action";
    requiresWorker = true;
    requiresManualRecovery = unresolvedActionExpired;
  } else if (facts.consumer.unresolved) {
    status = "reconcile_required";
    progressStage = "ready_for_consumer";
    requiresWorker = true;
  } else if (evidence.finalizedRefund && evidence.routeLegsRefunded) {
    status = "refunded";
    progressStage = "terminal";
  } else if (allActionsCancelled && moneyMayHaveMoved) {
    // Cancellation closes only an untouched plan. Late evidence reopens it as
    // automatic reconciliation work instead of leaving a false terminal.
    status = "reconcile_required";
    progressStage = "source_observed";
    requiresWorker = true;
  } else {
    const evidenceProgress = progressFromEvidence(
      evidence,
      facts.plan,
      facts.consumer,
    );
    if (evidenceProgress) {
      status = evidenceProgress.status;
      progressStage = evidenceProgress.progressStage;
    } else if (actionReportedMovement) {
      status = "in_progress";
      progressStage = "source_action";
      requiresWorker = true;
    } else if (allActionsCancelled && !moneyMayHaveMoved) {
      status = "cancelled";
      progressStage = "terminal";
    } else if (
      hasFinalFailure &&
      onlyTerminalOrBlockedActions &&
      !moneyMayHaveMoved
    ) {
      status = "failed";
      progressStage = "terminal";
    } else if (hasActionable) {
      status = "awaiting_user";
      progressStage = "source_action";
    } else if (
      facts.receive !== null &&
      facts.receive.open &&
      facts.receive.expiresAt > facts.now
    ) {
      status = "awaiting_external_funds";
      progressStage = "source_action";
    } else if (
      actions.some(
        (action) =>
          action.state === "submitted" || action.state === "succeeded",
      )
    ) {
      status = "in_progress";
      progressStage = "source_action";
      requiresWorker = true;
    } else if (actions.some((action) => action.state === "failed")) {
      status = moneyMayHaveMoved ? "recovery_required" : "failed";
      progressStage = moneyMayHaveMoved ? "source_action" : "terminal";
      requiresWorker = moneyMayHaveMoved;
      requiresManualRecovery = moneyMayHaveMoved;
    } else {
      status = "recovery_required";
      progressStage = "source_action";
      requiresWorker = true;
      requiresManualRecovery = true;
    }
  }

  const resultTerminal = isTerminalStatus(status);
  const segments = deriveSegmentProjections(facts);
  const mayReleaseRefundedReservations =
    status === "refunded" &&
    evidence.finalizedRefund &&
    evidence.routeLegsRefunded &&
    !facts.consumer.unresolved &&
    facts.reservations.every((reservation) => reservation.state !== "consumed");
  return {
    status,
    progressStage,
    actions,
    segments,
    safety: {
      moneyMayHaveMoved,
      requiresWorker,
      requiresManualRecovery,
      retryAllowed: actions.some((action) => action.actionable),
      cancelAllowed: !resultTerminal && canReleaseUntouchedReservations,
      reservationsMayRelease:
        resultTerminal &&
        (canReleaseUntouchedReservations || mayReleaseRefundedReservations),
      terminal: resultTerminal,
    },
  };
}
