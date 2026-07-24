import { canonicalJsonHash } from "../persistence/canonical.js";
import type {
  PositionActionExecutor,
  PositionActionInput,
  PositionActionInspectionInput,
  PositionActionReadiness,
  PositionActionReconcileInput,
  PositionActionResult,
  PreparationPostcondition,
} from "../domain/contracts.js";
import type {
  FundingReasonCode,
  JsonObject,
  NormalizedAction,
  VenueAccountBinding,
} from "../domain/types.js";
import {
  PreparationContractError,
  type PreparationActionTemplate,
  type PreparationFactCheck,
} from "./core-adapter.js";

export type PositionActionFacts = Readonly<{
  action: PositionActionInspectionInput["action"];
  venueId: string;
  positionRef: string;
  ownerBinding: VenueAccountBinding;
  observedAt: string;
  expiresAt: string;
  evidence: JsonObject;
  checks: readonly PreparationFactCheck[];
}>;

export type PositionActionFactsInspector = (
  input: PositionActionInspectionInput,
) => Promise<PositionActionFacts>;

export type PositionActionReconciler = (
  input: PositionActionReconcileInput,
) => Promise<PositionActionResult>;

function uniqueBy<Key, Value>(
  values: readonly Value[],
  key: (value: Value) => Key,
): Value[] {
  const seen = new Set<Key>();
  const output: Value[] = [];
  for (const value of values) {
    const itemKey = key(value);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    output.push(value);
  }
  return output;
}

function materializeAction(
  template: PreparationActionTemplate,
  input: {
    actionOperationId: string;
    adapterId: string;
    inspectionRevision: string;
  },
): NormalizedAction {
  if (!template.action) {
    throw new PreparationContractError(
      "evidence_invalid",
      `position action ${template.actionKey} was not materialized`,
    );
  }
  const actionId = `action_${canonicalJsonHash({
    action: template.action,
    actionKey: template.actionKey,
    actionOperationId: input.actionOperationId,
    adapterId: input.adapterId,
    inspectionRevision: input.inspectionRevision,
  }).slice(0, 32)}`;
  return { ...template.action, actionId } as NormalizedAction;
}

function revision(input: {
  adapterId: string;
  facts: PositionActionFacts;
  checks: readonly PreparationFactCheck[];
}): string {
  return `position_inspection_${canonicalJsonHash({
    action: input.facts.action,
    adapterId: input.adapterId,
    checks: input.checks,
    evidence: input.facts.evidence,
    ownerBinding: input.facts.ownerBinding,
    positionRef: input.facts.positionRef,
    venueId: input.facts.venueId,
  }).slice(0, 32)}`;
}

export class OwnerBoundPositionActionExecutor implements PositionActionExecutor {
  constructor(
    readonly adapterId: string,
    private readonly requiredCheckIds: readonly string[],
    private readonly inspectFacts: PositionActionFactsInspector,
    private readonly reconcileAction: PositionActionReconciler,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async resolve(input: PositionActionInspectionInput): Promise<{
    checks: readonly PreparationFactCheck[];
    facts: PositionActionFacts;
    readiness: PositionActionReadiness;
  }> {
    const facts = await this.inspectFacts(input);
    if (
      facts.action !== input.action ||
      facts.venueId !== input.venueId ||
      facts.positionRef !== input.positionRef ||
      facts.ownerBinding.bindingId !== input.ownerBindingId ||
      facts.ownerBinding.settlementLocation.accountId !== input.accountId
    ) {
      throw new PreparationContractError(
        "binding_mismatch",
        "position action evidence does not match the exact owner binding",
      );
    }
    const checkById = new Map(
      facts.checks.map((check) => [check.checkId, check]),
    );
    if (checkById.size !== facts.checks.length) {
      throw new PreparationContractError(
        "evidence_invalid",
        "position action check IDs must be unique",
      );
    }
    const checks = this.requiredCheckIds.map(
      (checkId): PreparationFactCheck =>
        checkById.get(checkId) ?? {
          checkId,
          status: "unavailable",
          safeLabel: "Required position evidence is unavailable",
          reasonCode: "market_evidence_unavailable",
          actions: [],
          postcondition: null,
        },
    );
    for (const check of checks) {
      if (
        (check.status === "action_required" ||
          check.status === "user_action_required") &&
        check.actions.length === 0
      ) {
        throw new PreparationContractError(
          "evidence_invalid",
          `required position check ${check.checkId} has no action`,
        );
      }
      for (const action of check.actions) {
        if (!action.action) {
          throw new PreparationContractError(
            "evidence_invalid",
            `position action ${action.actionKey} was not materialized`,
          );
        }
        const signerWalletId =
          action.action.kind === "evm_transaction"
            ? action.action.senderWalletId
            : action.action.kind === "external_handoff"
              ? action.action.actorWalletId
              : action.action.signerWalletId;
        if (signerWalletId !== facts.ownerBinding.executionWalletId) {
          throw new PreparationContractError(
            "binding_mismatch",
            "position action signer does not control the owner binding",
          );
        }
      }
    }
    const expiresAt = Date.parse(facts.expiresAt);
    const hasUnavailable = checks.some(
      (check) =>
        check.status === "pending" ||
        check.status === "unavailable" ||
        check.status === "unsupported",
    );
    const reasonCodes = uniqueBy(
      checks.flatMap((check) =>
        check.status !== "satisfied" && check.reasonCode
          ? [check.reasonCode]
          : [],
      ),
      (code) => code,
    );
    const actionTemplates = uniqueBy(
      checks.flatMap((check) => check.actions),
      (action) => action.actionKey,
    );
    const postconditions = uniqueBy(
      checks.flatMap((check) =>
        check.postcondition ? [check.postcondition] : [],
      ),
      (postcondition: PreparationPostcondition) =>
        `${postcondition.kind}:${postcondition.safeLabel}`,
    );
    const inspectionRevision = revision({
      adapterId: this.adapterId,
      facts,
      checks,
    });
    return {
      facts,
      checks,
      readiness: {
        ready:
          !hasUnavailable &&
          expiresAt > this.clock().getTime() &&
          checks.every((check) => check.status === "satisfied"),
        action: input.action,
        venueId: input.venueId,
        positionRef: input.positionRef,
        ownerBindingId: input.ownerBindingId,
        inspectionRevision,
        inspectedAt: facts.observedAt,
        expiresAt: facts.expiresAt,
        requiredActions: actionTemplates.map((action) => action.summary),
        postconditions,
        reasonCodes:
          expiresAt <= this.clock().getTime()
            ? uniqueBy(
                [...reasonCodes, "preparation_evidence_stale" as const],
                (code: FundingReasonCode) => code,
              )
            : reasonCodes,
        evidence: {
          facts: facts.evidence,
          checks: checks.map(({ checkId, status, safeLabel, reasonCode }) => ({
            checkId,
            status,
            safeLabel,
            reasonCode,
          })),
        },
      },
    };
  }

  async inspect(
    input: PositionActionInspectionInput,
  ): Promise<PositionActionReadiness> {
    return (await this.resolve(input)).readiness;
  }

  async prepare(
    input: PositionActionInput,
  ): Promise<readonly NormalizedAction[]> {
    const resolved = await this.resolve(input);
    if (
      resolved.readiness.inspectionRevision !== input.expectedInspectionRevision
    ) {
      throw new PreparationContractError(
        "evidence_stale",
        "position action evidence changed; inspect again",
      );
    }
    if (Date.parse(resolved.readiness.expiresAt) <= this.clock().getTime()) {
      throw new PreparationContractError(
        "evidence_expired",
        "position action evidence expired",
      );
    }
    if (
      resolved.checks.some(
        (check) =>
          check.status === "pending" ||
          check.status === "unavailable" ||
          check.status === "unsupported",
      )
    ) {
      throw new PreparationContractError(
        "preparation_unavailable",
        "position action is unavailable for the exact owner binding",
      );
    }
    return uniqueBy(
      resolved.checks.flatMap((check) => check.actions),
      (action) => action.actionKey,
    ).map((template) =>
      materializeAction(template, {
        actionOperationId: input.actionOperationId,
        adapterId: this.adapterId,
        inspectionRevision: resolved.readiness.inspectionRevision,
      }),
    );
  }

  reconcile(
    input: PositionActionReconcileInput,
  ): Promise<PositionActionResult> {
    return this.reconcileAction(input);
  }
}
