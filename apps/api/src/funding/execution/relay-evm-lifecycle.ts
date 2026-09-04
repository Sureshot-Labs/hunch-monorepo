import {
  deriveFundingLifecycle,
  type FundingLifecycleFacts,
} from "../lifecycle/funding-lifecycle-projector.js";

function relayActionAndProjection(
  facts: FundingLifecycleFacts,
  actionId: string,
) {
  const lifecycle = deriveFundingLifecycle(facts);
  return {
    lifecycle,
    action: facts.actions.find((candidate) => candidate.actionId === actionId),
    projection: lifecycle.actions.find(
      (candidate) => candidate.actionId === actionId,
    ),
  };
}

/**
 * The sealed action's limited attempts or deadline have been exhausted. It is
 * a pure fact calculation shared by Relay maintenance and cleanup planning;
 * neither caller may infer it from a materialized step cache.
 */
export function relayActionAttemptBudgetExhausted(
  facts: FundingLifecycleFacts,
  actionId: string,
): boolean {
  const action = facts.actions.find(
    (candidate) => candidate.actionId === actionId,
  );
  return (
    action !== undefined &&
    ((action.expiresAt !== null && action.expiresAt <= facts.now) ||
      action.attempts.length >= 2)
  );
}

/**
 * Relay's allowance lane is released only for an action that has actually
 * stopped accepting useful work. The old step-state predicate could be stale
 * at exactly the expiry/retry boundary that maintenance must handle.
 */
export function relayActionNeedsAllowanceMaintenance(
  facts: FundingLifecycleFacts | null,
  actionId: string,
): boolean {
  if (!facts) return false;
  const { lifecycle, action, projection } = relayActionAndProjection(
    facts,
    actionId,
  );
  if (!action || !projection || lifecycle.safety.terminal) return false;
  const exhausted = relayActionAttemptBudgetExhausted(facts, actionId);
  return (
    projection.state === "failed" ||
    projection.state === "recovery_required" ||
    (exhausted &&
      (projection.state === "planned" ||
        projection.state === "action_required"))
  );
}

/**
 * Cleanup may follow a verified approval immediately. Otherwise it needs a
 * bounded exhausted approval, never a transient in-flight or fresh action.
 */
export function relayActionCanCreateCleanup(
  facts: FundingLifecycleFacts | null,
  actionId: string,
): boolean {
  if (!facts) return false;
  const { lifecycle, projection } = relayActionAndProjection(facts, actionId);
  if (!projection || lifecycle.safety.terminal) return false;
  if (projection.state === "succeeded") return true;
  return (
    relayActionAttemptBudgetExhausted(facts, actionId) &&
    ["planned", "action_required", "failed", "recovery_required"].includes(
      projection.state,
    )
  );
}
