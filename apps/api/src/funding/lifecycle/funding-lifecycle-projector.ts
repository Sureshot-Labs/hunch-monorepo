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
  referenceKind: "transaction" | "provider_receipt" | "external_handoff" | null;
  startedAt: Date;
  updatedAt: Date;
  receipt: FundingLifecycleActionReceipt | null;
}>;

export type FundingLifecycleActionFact = Readonly<{
  actionId: string;
  ordinal: number;
  executorId: string;
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
  /** The action needs an exact canonical source-debit before completion. */
  requiresSourceDebitEvidence: boolean;
  /** This immutable action establishes destination-venue readiness. */
  requiresVenueReadiness: boolean;
  /**
   * Live authority fact for a server-delegated Telegram action. It is not a
   * step cache: `blocked` means the sealed intent or its reservation is no
   * longer usable, so the action must remain unstartable.
   */
  authorization?: "granted" | "blocked";
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
  observedAt: Date;
  reorgedAt: Date | null;
  replacementForTransferId: string | null;
}>;

export type FundingLifecycleReservationFact = Readonly<{
  mode: "subtract_available" | "advisory_destination" | "settled_for_consumer";
  state: "active" | "consumed" | "released";
}>;

export type FundingLifecycleConsumerFact = Readonly<{
  required: boolean;
  /** A consumer-side trade has been accepted. */
  completed: boolean;
  /** Funding is settled, but its unbroadcast consumer reservation was released. */
  settledWithoutConsumer?: boolean;
  unresolved: boolean;
}>;

export type FundingLifecycleReceiveFact = Readonly<{
  open: boolean;
  expiresAt: Date;
}>;

/**
 * A durable worker timing fact. It is not an operation-status cache: it is
 * the deadline of an already-open reconciliation evidence window.
 */
export type FundingLifecycleReconciliationFact = Readonly<{
  evidenceDeadline: Date | null;
}>;

/** A user cancellation recorded after the no-money-movement check. */
export type FundingLifecycleCancellationFact = Readonly<{
  requestedAt: Date;
}>;

/** A typed human/worker escalation fact, not an operation-status cache. */
export type FundingLifecycleManualRecoveryFact = Readonly<{
  code: string;
  requestedAt: Date;
}>;

export type FundingLifecyclePlanFact = Readonly<{
  /** Immutable committed baseline from `funding_quotes.plan_snapshot`. */
  initialState: Readonly<{
    status: FundingLifecycleOperationStatus;
    progressStage: FundingLifecycleProgressStage;
  }>;
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
  cancellation?: FundingLifecycleCancellationFact | null;
  manualRecovery?: FundingLifecycleManualRecoveryFact | null;
  reconciliation?: FundingLifecycleReconciliationFact;
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
  /** A route action may have transferred money beyond the user's source. */
  externalEffectMayHaveOccurred: boolean;
  /** Any cash evidence exists, including a safe source credit still owned by the user. */
  moneyMayHaveMoved: boolean;
  /** The persisted automatic-evidence deadline elapsed while money may be in flight. */
  reconciliationEvidenceTimedOut: boolean;
  /** A provider receipt has its own replay lease, distinct from generic evidence timeout. */
  awaitingProviderReceipt: boolean;
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
  recoveryMode: "automatic_evidence" | "manual_review" | null;
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

// A durable provider receipt is a recoverable handoff, not an abandoned user
// action. Its executor owns the bounded replay lease even after the quote's
// ordinary action deadline passes.
function hasRecoverableProviderReceiptWait(
  action: FundingLifecycleActionFact,
): boolean {
  return action.attempts.some(
    (attempt) =>
      unresolvedAttempt(attempt) &&
      attempt.outcome === "ambiguous" &&
      attempt.broadcastMayHaveOccurred &&
      attempt.referenceKind === "provider_receipt",
  );
}

// An action deadline limits *starting a new action*. Once an attempt has a
// durable transaction/provider reference, reconciliation owns the already
// possible broadcast and can continue automatically after that deadline.
function hasRecoverableBroadcastReference(
  action: FundingLifecycleActionFact,
): boolean {
  return action.attempts.some(
    (attempt) =>
      unresolvedAttempt(attempt) &&
      attempt.broadcastMayHaveOccurred &&
      (attempt.referenceKind === "transaction" ||
        attempt.referenceKind === "provider_receipt"),
  );
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

function actionRequiresManualRecovery(
  action: FundingLifecycleActionFact,
): boolean {
  // A reorg is a normal bounded-evidence condition: the worker can look for a
  // canonical replacement. A receipt mismatch instead says the observed
  // transfer is not this sealed action and must never be retried implicitly.
  return action.attempts.some(
    (attempt) => attempt.receipt?.status === "mismatch",
  );
}

function isCanonicalFinal(transfer: FundingLifecycleTransferEvidence): boolean {
  return transfer.canonical && transfer.finality === "finalized";
}

function sameTransferIdentity(
  left: FundingLifecycleTransferEvidence,
  right: FundingLifecycleTransferEvidence,
): boolean {
  return (
    left.routeLegId === right.routeLegId &&
    left.money.raw === right.money.raw &&
    sameMoneyAsset(left.money, right.money)
  );
}

function transferHasRecordedRefundSuccessor(
  reorgedRefund: FundingLifecycleTransferEvidence,
  transfers: readonly FundingLifecycleTransferEvidence[],
): boolean {
  const reorgedAt = reorgedRefund.reorgedAt;
  if (reorgedRefund.kind !== "refund_credit" || reorgedAt === null) {
    return false;
  }
  return transfers.some(
    (candidate) =>
      candidate.transferId !== reorgedRefund.transferId &&
      candidate.kind === "refund_credit" &&
      sameTransferIdentity(candidate, reorgedRefund) &&
      candidate.replacementForTransferId === reorgedRefund.transferId &&
      candidate.observedAt.getTime() >= reorgedAt.getTime() &&
      (isCanonicalFinal(candidate) ||
        (candidate.finality === "reorged" && !candidate.canonical)),
  );
}

function hasUnresolvedCanonicalityConflict(
  transfers: readonly FundingLifecycleTransferEvidence[],
): boolean {
  return transfers.some(
    (transfer) =>
      (transfer.finality === "reorged" || !transfer.canonical) &&
      (transfer.kind !== "refund_credit" ||
        !transferHasRecordedRefundSuccessor(transfer, transfers)),
  );
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
  const finalizedDestinationCredits = transfers.filter(
    (transfer) =>
      isCanonicalFinal(transfer) && transfer.kind === "destination_credit",
  );
  // A finalized credit in a different asset/network cannot be silently
  // discarded. It is evidence that this sealed route needs reconciliation;
  // accepting only the matching credit would let mixed evidence complete a
  // route that the legacy reducer correctly kept unresolved.
  if (
    finalizedDestinationCredits.some(
      (transfer) => !sameMoneyAsset(transfer.money, requested),
    )
  ) {
    return null;
  }
  if (finalizedDestinationCredits.length === 0) return null;
  return finalizedDestinationCredits.reduce(
    (total, transfer) => total + BigInt(transfer.money.raw),
    0n,
  );
}

function hasIncompatibleFinalDestinationCredit(
  transfers: readonly FundingLifecycleTransferEvidence[],
  expected: FundingLifecycleMoney,
  routeLegId?: string,
): boolean {
  return transfers.some(
    (transfer) =>
      isCanonicalFinal(transfer) &&
      transfer.kind === "destination_credit" &&
      (routeLegId === undefined || transfer.routeLegId === routeLegId) &&
      !sameMoneyAsset(transfer.money, expected),
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
    const incompatibleDestinationCredit = hasIncompatibleFinalDestinationCredit(
      transfers,
      leg.minimumDestination,
      leg.routeLegId,
    );
    const canonicalityConflict = hasUnresolvedCanonicalityConflict(transfers);
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
    const cancelled =
      actions.length > 0 &&
      actions.every((action) => actionExecution(action) === "cancelled");
    const awaitingIngress =
      actions.length > 0 &&
      actions.every(
        (action) =>
          action.activation === "after_verified_ingress" &&
          actionExecution(action) === "not_started",
      );

    // Segment state is monotonic once money has been terminally accounted for.
    // A later source/receipt reorg reopens the *operation* for evidence work,
    // but must not attempt the illegal cache transition succeeded -> recovery.
    const status: FundingLifecycleSegmentStatus = refunded
      ? "refunded"
      : incompatibleDestinationCredit
        ? "recovery_required"
        : actualOutput !== null
          ? BigInt(actualOutput.raw) >= BigInt(leg.minimumDestination.raw)
            ? "succeeded"
            : canonicalityConflict
              ? "recovery_required"
              : "settling"
          : canonicalityConflict
            ? "recovery_required"
            : unresolved
              ? unresolvedExpired
                ? "recovery_required"
                : "reconcile_required"
              : intermediate
                ? "settling"
                : actualInput !== null || reported
                  ? "submitted"
                  : failed || cancelled
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
  destinationEvidenceConflict: boolean;
  finalizedSource: boolean;
  finalizedSourceDebit: boolean;
  finalizedIntermediate: boolean;
  finalizedDestination: boolean;
  finalizedVenueReadiness: boolean;
  finalizedRefund: boolean;
  destinationCreditRequirementMet: boolean;
  destinationCompletionMet: boolean;
  sourceDebitRequirementsMet: boolean;
  sourceDebitEvidencePending: boolean;
  partialRefundEvidence: boolean;
  routeLegsSatisfied: boolean;
  routeLegsRefunded: boolean;
}> {
  const canonicalityConflict = hasUnresolvedCanonicalityConflict(
    facts.transfers,
  );
  const destinationTotal = sumDestination(facts.transfers, facts.plan);
  const requestedRaw = facts.plan.requestedDestination?.raw;
  const destinationEvidenceConflict =
    (facts.plan.requestedDestination !== null &&
      hasIncompatibleFinalDestinationCredit(
        facts.transfers,
        facts.plan.requestedDestination,
      )) ||
    facts.plan.routeLegs.some((leg) =>
      hasIncompatibleFinalDestinationCredit(
        facts.transfers,
        leg.minimumDestination,
        leg.routeLegId,
      ),
    );
  const destinationCreditRequirementMet =
    destinationTotal !== null &&
    requestedRaw !== undefined &&
    destinationTotal >= BigInt(requestedRaw);
  const finalizedVenueReadiness = facts.transfers.some(
    (transfer) =>
      isCanonicalFinal(transfer) && transfer.kind === "venue_readiness",
  );
  const finalizedSourceDebit = facts.transfers.some(
    (transfer) =>
      isCanonicalFinal(transfer) && transfer.kind === "source_debit",
  );
  const destinationCompletionMet =
    facts.plan.completionEvidence === "venue_readiness"
      ? finalizedVenueReadiness
      : facts.plan.completionEvidence === "destination_credit"
        ? destinationCreditRequirementMet
        : destinationCreditRequirementMet && finalizedVenueReadiness;
  const sourceDebitRequirementsMet = facts.actions
    .filter((action) => action.requiresSourceDebitEvidence)
    .every(
      (action) =>
        actionExecution(action) === "succeeded" &&
        facts.transfers.some(
          (transfer) =>
            isCanonicalFinal(transfer) &&
            transfer.kind === "source_debit" &&
            // An operation-wide action has no leg to bind. A leg-bound
            // action must not borrow a debit from another source lane.
            (action.routeLegId === null ||
              transfer.routeLegId === action.routeLegId),
        ),
    );
  const sourceDebitEvidencePending = facts.actions.some(
    (action) =>
      action.requiresSourceDebitEvidence &&
      actionExecution(action) === "succeeded" &&
      !facts.transfers.some(
        (transfer) =>
          isCanonicalFinal(transfer) &&
          transfer.kind === "source_debit" &&
          (action.routeLegId === null ||
            transfer.routeLegId === action.routeLegId),
      ),
  );
  const finalizedRefund = facts.transfers.some(
    (transfer) =>
      isCanonicalFinal(transfer) && transfer.kind === "refund_credit",
  );
  const routeLegsAreRefunded = routeLegsRefunded(facts.transfers, facts.plan);
  return {
    canonicalityConflict,
    destinationEvidenceConflict,
    finalizedSource: facts.transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) &&
        (transfer.kind === "source_debit" || transfer.kind === "source_credit"),
    ),
    finalizedSourceDebit,
    finalizedIntermediate: facts.transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) && transfer.kind === "intermediate_transfer",
    ),
    finalizedDestination: facts.transfers.some(
      (transfer) =>
        isCanonicalFinal(transfer) && transfer.kind === "destination_credit",
    ),
    finalizedVenueReadiness,
    finalizedRefund,
    destinationCreditRequirementMet,
    destinationCompletionMet,
    sourceDebitRequirementsMet,
    sourceDebitEvidencePending,
    partialRefundEvidence:
      finalizedRefund && facts.plan.routeLegs.length > 0 && !routeLegsAreRefunded,
    routeLegsSatisfied: routeLegsSatisfied(facts.transfers, facts.plan),
    routeLegsRefunded: routeLegsAreRefunded,
  };
}

function actionState(
  action: FundingLifecycleActionFact,
  dependencySucceeded: boolean,
  activationSatisfied: boolean,
  unresolvedMovement: boolean,
  reconciliationEvidenceTimedOut: boolean,
  now: Date,
): FundingLifecycleActionState {
  const execution = actionExecution(action);
  if (execution === "succeeded") return "succeeded";
  if (execution === "cancelled") return "cancelled";
  if (actionCanonicalityConflict(action)) return "recovery_required";
  if (actionHasConflictingExecutionHistory(action)) {
    return "reconcile_required";
  }
  if (unresolvedMovement || execution === "ambiguous") {
    return reconciliationEvidenceTimedOut &&
      !hasRecoverableProviderReceiptWait(action)
      ? "recovery_required"
      : "reconcile_required";
  }
  if (execution === "started") return "recovery_required";
  if (execution === "submitted") return "submitted";
  if (action.authorization === "blocked") return "planned";
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
    evidence.destinationCompletionMet &&
    evidence.routeLegsSatisfied &&
    evidence.sourceDebitRequirementsMet;
  if (destinationReady) {
    if (
      !consumer.required ||
      consumer.completed ||
      consumer.settledWithoutConsumer === true
    ) {
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
): status is Extract<
  FundingLifecycleOperationStatus,
  "completed" | "refunded" | "failed" | "cancelled"
> {
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
  const awaitingProviderReceipt = unresolvedActions.some(
    hasRecoverableProviderReceiptWait,
  );
  const expiredUnresolvedActions = unresolvedActions.filter(
    (action) => action.expiresAt !== null && action.expiresAt <= facts.now,
  );
  const unresolvedActionExpired = expiredUnresolvedActions.length > 0;
  const unresolvedActionNeedsManualRecovery = expiredUnresolvedActions.some(
    (action) => !hasRecoverableBroadcastReference(action),
  );
  const actionEvidenceConflict = facts.actions.some(actionCanonicalityConflict);
  const actionManualRecovery = facts.actions.some(actionRequiresManualRecovery);
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
  // A source credit is observable money, but not an irreversible route
  // effect: it is still in the user's source wallet.  That distinction lets a
  // route stop after a harmless approval without stranding the received cash.
  const externalEffectMayHaveOccurred =
    facts.consumer.unresolved ||
    facts.actions.some(
      (action) => action.mayMoveMoney && hasUnresolvedMovement(action),
    ) ||
    actionReportedMovement ||
    facts.transfers.some(
      (transfer) =>
        transfer.canonical &&
        transfer.finality !== "reorged" &&
        transfer.kind !== "source_credit" &&
        transfer.kind !== "venue_readiness",
    );
  const evidenceDeadline = facts.reconciliation?.evidenceDeadline ?? null;
  const reconciliationEvidenceTimedOut =
    evidenceDeadline !== null &&
    evidenceDeadline.getTime() <= facts.now.getTime() &&
    moneyMayHaveMoved;
  const actionHasTerminalStop = facts.actions.some((action) => {
    const execution = actionExecution(action);
    return execution === "final_failure" || execution === "cancelled";
  });
  const actionabilityBlockedByEvidence =
    evidence.canonicalityConflict ||
    evidence.destinationEvidenceConflict ||
    actionEvidenceConflict ||
    evidence.sourceDebitEvidencePending ||
    evidence.partialRefundEvidence ||
    actionHasTerminalStop;
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
        reconciliationEvidenceTimedOut,
        facts.now,
      );
      const actionable =
        state === "action_required" &&
        !actionabilityBlockedByEvidence &&
        (!unresolvedMovement || action.independentLane);
      const projection = { actionId: action.actionId, state, actionable };
      byId.set(action.actionId, projection);
      return projection;
    });
  const canReleaseUntouchedReservations =
    !externalEffectMayHaveOccurred &&
    facts.reservations.every((reservation) => reservation.state !== "consumed");

  let status: FundingLifecycleOperationStatus;
  let progressStage: FundingLifecycleProgressStage;
  let requiresWorker = false;
  let requiresManualRecovery = false;

  const hasStoppedAction = actions.some(
    (action) => action.state === "failed" || action.state === "cancelled",
  );
  const hasFinalFailure = actions.some((action) => action.state === "failed");
  const hasUnfinishedAction = actions.some(
    (action) => action.state === "recovery_required",
  );
  const hasActionable = actions.some((action) => action.actionable);
  const hasBlockedAuthorization = facts.actions.some(
    (action) => action.authorization === "blocked",
  );
  const evidenceProgress = progressFromEvidence(
    evidence,
    facts.plan,
    facts.consumer,
  );
  const finalEvidenceResolved =
    evidenceProgress?.status === "ready" ||
    evidenceProgress?.status === "completed";
  const pristinePlan =
    facts.receive === null &&
    facts.transfers.length === 0 &&
    facts.actions.every((action) => action.attempts.length === 0) &&
    !facts.consumer.completed &&
    !facts.consumer.unresolved &&
    facts.reservations.every((reservation) => reservation.state === "active") &&
    // An in-progress route with an immediate action has already reached its
    // first actionable lifecycle stage. Keeping it at `committed` would make
    // the worker complete its idle wait instead of requeueing that action.
    (facts.plan.initialState.status !== "in_progress" ||
      facts.actions.length === 0);

  if (
    evidence.canonicalityConflict ||
    evidence.destinationEvidenceConflict ||
    actionEvidenceConflict
  ) {
    status = "recovery_required";
    progressStage = "source_action";
    requiresWorker = true;
    requiresManualRecovery =
      actionManualRecovery || facts.manualRecovery != null;
  } else if (unresolvedMovement || conflictingActionHistory) {
    status =
      unresolvedActionExpired || reconciliationEvidenceTimedOut
        ? "recovery_required"
        : "reconcile_required";
    progressStage = "source_action";
    requiresWorker = true;
    requiresManualRecovery =
      unresolvedActionNeedsManualRecovery && !awaitingProviderReceipt;
  } else if (evidence.sourceDebitEvidencePending) {
    // A delegated action can report success before the authoritative debit
    // arrives. Keep it on the automatic evidence path; presenting the
    // destination as ready here could consume a route whose source was never
    // proven, while manual recovery would strand a normal delayed observer.
    status = "reconcile_required";
    progressStage = "source_action";
    requiresWorker = true;
  } else if (evidence.partialRefundEvidence) {
    // One composite leg has been refunded while another remains unsettled.
    // This is neither a completed refund nor a fresh route: the remaining
    // money needs bounded evidence work before anything may be retried.
    status = "recovery_required";
    progressStage = "routing";
    requiresWorker = true;
  } else if (facts.consumer.unresolved) {
    const evidenceProgress = progressFromEvidence(
      evidence,
      facts.plan,
      facts.consumer,
    );
    // The money is still ready for its already-claimed consumer. Keep that
    // stable `ready` projection (and its reservation) while the trade outcome
    // is reconciled; marking funding itself as unavailable strands a valid
    // late trade result.
    if (facts.consumer.required && evidenceProgress?.status === "ready") {
      status = "ready";
      progressStage = "ready_for_consumer";
      requiresWorker = true;
    } else if (
      facts.consumer.settledWithoutConsumer === true &&
      evidenceProgress?.status === "completed"
    ) {
      status = "completed";
      progressStage = "terminal";
    } else {
      status = "reconcile_required";
      progressStage = "ready_for_consumer";
      requiresWorker = true;
    }
  } else if (evidence.finalizedRefund && evidence.routeLegsRefunded) {
    status = "refunded";
    progressStage = "terminal";
  } else if (facts.cancellation != null) {
    // Cancellation is a durable decision fact, recorded only while the
    // lifecycle proves that money has not moved. A late observed transfer
    // still wins this branch and stays on recovery rather than disappearing.
    status = externalEffectMayHaveOccurred
      ? "recovery_required"
      : "cancelled";
    progressStage = externalEffectMayHaveOccurred
      ? "source_action"
      : "terminal";
    requiresWorker = externalEffectMayHaveOccurred;
  } else if (hasStoppedAction) {
    // A final action failure/cancellation can become terminal only before any
    // money movement. Once a debit, credit, or executor movement report
    // exists, recovery owns the route; a sibling action must not make it look
    // actionable again.
    status = externalEffectMayHaveOccurred
      ? "recovery_required"
      : hasFinalFailure
        ? "failed"
        : "cancelled";
    progressStage = externalEffectMayHaveOccurred
      ? "source_action"
      : "terminal";
    requiresWorker = externalEffectMayHaveOccurred;
  } else if (facts.manualRecovery != null && !finalEvidenceResolved) {
    // This is an explicit escalation fact, never a stale cache value. Final
    // money evidence above still wins and resolves the incident normally.
    status = "recovery_required";
    progressStage = "source_action";
    requiresWorker = true;
    requiresManualRecovery = true;
  } else {
    if (pristinePlan) {
      status = facts.plan.initialState.status;
      progressStage = facts.plan.initialState.progressStage;
    } else if (evidenceProgress) {
      status = evidenceProgress.status;
      progressStage = evidenceProgress.progressStage;
    } else if (hasUnfinishedAction) {
      status = "recovery_required";
      progressStage = "source_action";
      requiresWorker = true;
    } else if (reconciliationEvidenceTimedOut) {
      status = "recovery_required";
      progressStage = "source_action";
      requiresWorker = true;
    } else if (actionReportedMovement) {
      status = "in_progress";
      progressStage = "source_action";
      requiresWorker = true;
    } else if (hasActionable) {
      // A plan that was committed as an automatic route remains in-progress
      // when a receipt proves a retry is safe.  This comes from the immutable
      // committed plan, not from the materialized operation status cache.
      status =
        facts.plan.initialState.status === "in_progress"
          ? "in_progress"
          : "awaiting_user";
      progressStage = "source_action";
    } else if (hasBlockedAuthorization) {
      // A server-delegated action must never be fabricated from an old step
      // cache after its sealed Telegram authority disappears. Keep the route
      // live for authority reconciliation, but expose no executable action.
      status = "in_progress";
      progressStage = "source_action";
      requiresWorker = true;
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
    recoveryMode:
      status === "recovery_required"
        ? requiresManualRecovery
          ? "manual_review"
          : "automatic_evidence"
        : null,
    actions,
    segments,
    safety: {
      externalEffectMayHaveOccurred,
      moneyMayHaveMoved,
      reconciliationEvidenceTimedOut,
      awaitingProviderReceipt,
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
