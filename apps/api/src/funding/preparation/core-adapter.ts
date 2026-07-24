import { canonicalJsonHash } from "../persistence/canonical.js";
import type {
  PreparationCheckEvidence,
  PreparationInspectionInput,
  PreparationInput,
  PreparationPostcondition,
  PreparationResult,
  WalletPreparationAdapter,
} from "../domain/contracts.js";
import type {
  ActionSummary,
  EvmTransactionAction,
  ExternalHandoffAction,
  FundingReasonCode,
  JsonObject,
  NormalizedAction,
  PreparationExecutionMode,
  PreparationPurpose,
  SvmTransactionAction,
  SignatureAction,
  TradingWalletReadinessClass,
  VenueAccountBinding,
} from "../domain/types.js";

type WithoutActionId<Action extends NormalizedAction> = Omit<
  Action,
  "actionId"
>;

export type PreparationActionTemplate =
  | Readonly<{
      actionKey: string;
      action: WithoutActionId<EvmTransactionAction> | null;
      summary: ActionSummary;
    }>
  | Readonly<{
      actionKey: string;
      action: WithoutActionId<SvmTransactionAction> | null;
      summary: ActionSummary;
    }>
  | Readonly<{
      actionKey: string;
      action: WithoutActionId<SignatureAction> | null;
      summary: ActionSummary;
    }>
  | Readonly<{
      actionKey: string;
      action: WithoutActionId<ExternalHandoffAction> | null;
      summary: ActionSummary;
    }>;

export type PreparationFactCheck = Readonly<{
  checkId: string;
  status: PreparationCheckEvidence["status"];
  safeLabel: string;
  reasonCode: FundingReasonCode | null;
  actions: readonly PreparationActionTemplate[];
  postcondition: PreparationPostcondition | null;
}>;

export type VenuePreparationFacts = Readonly<{
  binding: VenueAccountBinding;
  safeLabel: string;
  purpose: PreparationPurpose;
  marketClass: string | null;
  readinessClass: TradingWalletReadinessClass;
  executionMode: PreparationExecutionMode;
  topology: string;
  observedAt: string;
  expiresAt: string;
  /**
   * Only compact, sanitized facts that can safely cross the API boundary.
   * The adapter rejects suspicious secret-shaped keys before returning them.
   */
  evidence: JsonObject;
  checks: readonly PreparationFactCheck[];
}>;

export type VenuePreparationFactsInspector = (
  input: PreparationInspectionInput,
) => Promise<VenuePreparationFacts>;

export type PreparationActionMaterializerInput = Readonly<{
  request: PreparationInput;
  facts: VenuePreparationFacts;
  inspectionRevision: string;
  requiredChecks: readonly PreparationFactCheck[];
  requiredActions: readonly PreparationActionTemplate[];
}>;

export type PreparationActionMaterializer = (
  input: PreparationActionMaterializerInput,
) => Promise<readonly PreparationActionTemplate[]>;

export type PreparationRequirementResolver = (
  input: Pick<PreparationInspectionInput, "purpose" | "marketClass">,
) => readonly string[] | null;

export type PreparationContractErrorCode =
  | "binding_mismatch"
  | "evidence_expired"
  | "evidence_invalid"
  | "evidence_stale"
  | "preparation_unavailable"
  | "unsupported_market_class";

export class PreparationContractError extends Error {
  constructor(
    readonly code: PreparationContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreparationContractError";
  }
}

const SECRET_KEY_PATTERN =
  /(?:authorization.?signature|api.?secret|passphrase|private.?key|secret.?key|wallet.?authorization.?key)/i;

function assertNoSecretKeys(value: unknown, path = "evidence"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoSecretKeys(entry, `${path}[${index}]`),
    );
    return;
  }
  if (value == null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new PreparationContractError(
        "evidence_invalid",
        `secret-shaped preparation evidence key is forbidden at ${path}.${key}`,
      );
    }
    assertNoSecretKeys(entry, `${path}.${key}`);
  }
}

function canonicalAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? trimmed.toLowerCase() : trimmed;
}

function sameBinding(
  expected: VenueAccountBinding,
  actual: VenueAccountBinding,
): boolean {
  return (
    expected.bindingId === actual.bindingId &&
    expected.venueId === actual.venueId &&
    expected.controllerWalletId === actual.controllerWalletId &&
    expected.executionWalletId === actual.executionWalletId &&
    canonicalAddress(expected.accountRef) ===
      canonicalAddress(actual.accountRef) &&
    expected.signingMode === actual.signingMode &&
    expected.settlementLocation.locationId ===
      actual.settlementLocation.locationId &&
    expected.settlementLocation.accountId ===
      actual.settlementLocation.accountId &&
    expected.settlementLocation.asset.networkId ===
      actual.settlementLocation.asset.networkId &&
    canonicalAddress(expected.settlementLocation.asset.assetId) ===
      canonicalAddress(actual.settlementLocation.asset.assetId) &&
    expected.settlementLocation.asset.decimals ===
      actual.settlementLocation.asset.decimals
  );
}

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

function actionSignerWalletId(
  action: Exclude<PreparationActionTemplate["action"], null>,
): string {
  if (action.kind === "evm_transaction") return action.senderWalletId;
  if (action.kind === "external_handoff") return action.actorWalletId;
  return action.signerWalletId;
}

function assertActionTemplates(
  facts: VenuePreparationFacts,
  checks: readonly PreparationFactCheck[],
): void {
  const actionKeys = new Set<string>();
  for (const check of checks) {
    for (const template of check.actions) {
      if (!template.actionKey.trim() || actionKeys.has(template.actionKey)) {
        throw new PreparationContractError(
          "evidence_invalid",
          "preparation action keys must be non-empty and unique",
        );
      }
      actionKeys.add(template.actionKey);
      if (!template.action) continue;
      if (
        actionSignerWalletId(template.action) !==
        facts.binding.executionWalletId
      ) {
        throw new PreparationContractError(
          "binding_mismatch",
          "preparation action signer does not match the exact execution wallet",
        );
      }
      if (
        template.action.networkId !==
        facts.binding.settlementLocation.asset.networkId
      ) {
        throw new PreparationContractError(
          "binding_mismatch",
          "preparation action network does not match the settlement network",
        );
      }
      if (template.summary.kind !== template.action.kind) {
        throw new PreparationContractError(
          "evidence_invalid",
          "preparation action summary kind does not match its action",
        );
      }
    }
    if (
      (check.status === "action_required" ||
        check.status === "user_action_required") &&
      check.actions.length === 0
    ) {
      throw new PreparationContractError(
        "evidence_invalid",
        `required preparation check ${check.checkId} has no normalized action`,
      );
    }
  }
}

function inspectionRevision(input: {
  adapterId: string;
  facts: VenuePreparationFacts;
  requiredChecks: readonly PreparationFactCheck[];
}): string {
  const digest = canonicalJsonHash({
    adapterId: input.adapterId,
    binding: input.facts.binding,
    checks: input.requiredChecks,
    evidence: input.facts.evidence,
    executionMode: input.facts.executionMode,
    marketClass: input.facts.marketClass,
    purpose: input.facts.purpose,
    readinessClass: input.facts.readinessClass,
    topology: input.facts.topology,
  });
  return `inspection_${digest.slice(0, 32)}`;
}

function statusFor(
  facts: VenuePreparationFacts,
  checks: readonly PreparationFactCheck[],
): PreparationResult["status"] {
  if (
    facts.readinessClass === "external_source_only" ||
    facts.readinessClass === "external_view_only" ||
    checks.some(
      (check) =>
        check.status === "pending" ||
        check.status === "unavailable" ||
        check.status === "unsupported",
    )
  ) {
    return "unavailable";
  }
  if (checks.some((check) => check.status === "user_action_required")) {
    return "user_action_required";
  }
  if (checks.some((check) => check.status === "action_required")) {
    return "setup_required";
  }
  return "ready";
}

function materializeAction(
  template: PreparationActionTemplate,
  input: {
    adapterId: string;
    operationId: string;
    inspectionRevision: string;
  },
): NormalizedAction {
  if (!template.action) {
    throw new PreparationContractError(
      "evidence_invalid",
      `preparation action ${template.actionKey} was not materialized`,
    );
  }
  const actionId = `action_${canonicalJsonHash({
    action: template.action,
    actionKey: template.actionKey,
    adapterId: input.adapterId,
    inspectionRevision: input.inspectionRevision,
    operationId: input.operationId,
  }).slice(0, 32)}`;
  return { ...template.action, actionId } as NormalizedAction;
}

export class PurposeAwareWalletPreparationAdapter implements WalletPreparationAdapter {
  constructor(
    readonly adapterId: string,
    private readonly inspectFacts: VenuePreparationFactsInspector,
    private readonly resolveRequirements: PreparationRequirementResolver,
    private readonly clock: () => Date = () => new Date(),
    private readonly materializeRequiredActions?: PreparationActionMaterializer,
  ) {}

  private async resolve(input: PreparationInspectionInput): Promise<{
    facts: VenuePreparationFacts;
    requiredChecks: readonly PreparationFactCheck[];
    result: PreparationResult;
  }> {
    const requiredCheckIds = this.resolveRequirements(input);
    if (!requiredCheckIds) {
      throw new PreparationContractError(
        "unsupported_market_class",
        "preparation purpose or market class is unsupported",
      );
    }
    const facts = await this.inspectFacts(input);
    if (
      facts.binding.settlementLocation.accountId !== input.accountId ||
      !sameBinding(input.binding, facts.binding) ||
      facts.purpose !== input.purpose ||
      facts.marketClass !== input.marketClass
    ) {
      throw new PreparationContractError(
        "binding_mismatch",
        "preparation evidence does not match the exact requested binding",
      );
    }
    assertNoSecretKeys(facts.evidence);
    const observedAt = Date.parse(facts.observedAt);
    const expiresAt = Date.parse(facts.expiresAt);
    if (
      !Number.isFinite(observedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= observedAt
    ) {
      throw new PreparationContractError(
        "evidence_invalid",
        "preparation evidence timestamps are invalid",
      );
    }

    const checksById = new Map<string, PreparationFactCheck>();
    for (const check of facts.checks) {
      if (!check.checkId.trim() || checksById.has(check.checkId)) {
        throw new PreparationContractError(
          "evidence_invalid",
          "preparation check IDs must be non-empty and unique",
        );
      }
      checksById.set(check.checkId, check);
    }
    const requiredChecks = requiredCheckIds.map((checkId) => {
      const check = checksById.get(checkId);
      if (!check) {
        return {
          checkId,
          status: "unavailable",
          safeLabel: "Required readiness evidence is unavailable",
          reasonCode: "market_evidence_unavailable",
          actions: [],
          postcondition: null,
        } satisfies PreparationFactCheck;
      }
      return check;
    });
    assertActionTemplates(facts, requiredChecks);
    const revision = inspectionRevision({
      adapterId: this.adapterId,
      facts,
      requiredChecks,
    });
    const actionTemplates = uniqueBy(
      requiredChecks.flatMap((check) => check.actions),
      (action) => action.actionKey,
    );
    const reasonCodes = uniqueBy(
      requiredChecks.flatMap((check) =>
        check.status === "satisfied" || !check.reasonCode
          ? []
          : [check.reasonCode],
      ),
      (reason) => reason,
    );
    const postconditions = uniqueBy(
      requiredChecks.flatMap((check) =>
        check.postcondition ? [check.postcondition] : [],
      ),
      (postcondition) => `${postcondition.kind}:${postcondition.safeLabel}`,
    );
    const result: PreparationResult = {
      status:
        expiresAt <= this.clock().getTime()
          ? "unavailable"
          : statusFor(facts, requiredChecks),
      binding: facts.binding,
      safeLabel: facts.safeLabel,
      purpose: facts.purpose,
      marketClass: facts.marketClass,
      readinessClass: facts.readinessClass,
      executionMode: facts.executionMode,
      topology: facts.topology,
      inspectionRevision: revision,
      inspectedAt: facts.observedAt,
      expiresAt: facts.expiresAt,
      requiredActions: actionTemplates.map((action) => action.summary),
      postconditions,
      reasonCodes:
        expiresAt <= this.clock().getTime()
          ? uniqueBy(
              [...reasonCodes, "preparation_evidence_stale" as const],
              (reason) => reason,
            )
          : reasonCodes,
      evidence: {
        facts: facts.evidence,
        checks: requiredChecks.map(
          ({ checkId, status, safeLabel, reasonCode }) => ({
            checkId,
            status,
            safeLabel,
            reasonCode,
          }),
        ),
      },
    };
    return { facts, requiredChecks, result };
  }

  async inspect(input: PreparationInspectionInput): Promise<PreparationResult> {
    return (await this.resolve(input)).result;
  }

  async prepare(input: PreparationInput): Promise<readonly NormalizedAction[]> {
    const resolved = await this.resolve(input);
    if (
      resolved.result.inspectionRevision !== input.expectedInspectionRevision
    ) {
      throw new PreparationContractError(
        "evidence_stale",
        "preparation evidence changed; inspect again before preparing actions",
      );
    }
    if (Date.parse(resolved.result.expiresAt) <= this.clock().getTime()) {
      throw new PreparationContractError(
        "evidence_expired",
        "preparation evidence expired; inspect again",
      );
    }
    if (resolved.result.status === "unavailable") {
      throw new PreparationContractError(
        "preparation_unavailable",
        "preparation is unavailable for the exact binding and purpose",
      );
    }
    if (resolved.result.status === "ready") return [];
    const requiredActions = uniqueBy(
      resolved.requiredChecks.flatMap((check) => check.actions),
      (action) => action.actionKey,
    );
    const templates = requiredActions.every((template) => template.action)
      ? requiredActions
      : await this.materializeActions(input, resolved, requiredActions);
    return templates.map((template) =>
      materializeAction(template, {
        adapterId: this.adapterId,
        operationId: input.operationId,
        inspectionRevision: resolved.result.inspectionRevision,
      }),
    );
  }

  private async materializeActions(
    input: PreparationInput,
    resolved: Awaited<
      ReturnType<PurposeAwareWalletPreparationAdapter["resolve"]>
    >,
    requiredActions: readonly PreparationActionTemplate[],
  ): Promise<readonly PreparationActionTemplate[]> {
    if (!this.materializeRequiredActions) {
      throw new PreparationContractError(
        "evidence_invalid",
        "preparation action materializer is not configured",
      );
    }
    const materialized = await this.materializeRequiredActions({
      request: input,
      facts: resolved.facts,
      inspectionRevision: resolved.result.inspectionRevision,
      requiredChecks: resolved.requiredChecks,
      requiredActions,
    });
    assertActionTemplates(resolved.facts, [
      {
        checkId: "materialized_actions",
        status: "action_required",
        safeLabel: "Materialized preparation actions",
        reasonCode: null,
        actions: materialized,
        postcondition: null,
      },
    ]);
    const expected = new Map(
      requiredActions.map((template) => [template.actionKey, template.summary]),
    );
    if (
      materialized.length !== expected.size ||
      materialized.some((template) => {
        const summary = expected.get(template.actionKey);
        return (
          !template.action ||
          !summary ||
          canonicalJsonHash(summary) !== canonicalJsonHash(template.summary)
        );
      })
    ) {
      throw new PreparationContractError(
        "evidence_invalid",
        "materialized preparation actions do not match the inspected requirements",
      );
    }
    return materialized;
  }
}
