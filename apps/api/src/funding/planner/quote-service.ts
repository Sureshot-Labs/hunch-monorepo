import { randomBytes } from "node:crypto";
import type { Pool } from "@hunch/infra";

import type {
  FundingQuoteRequest,
  FundingQuoteSummary,
  JsonValue,
  Money,
} from "../domain/types.js";
import type { FundingRuntimePolicy } from "../policies/funding-policy.js";
import {
  FundingPersistenceError,
  createFundingQuote,
} from "../persistence/funding-operation-repository.js";
import {
  canonicalJsonEqual,
  canonicalJsonHash,
} from "../persistence/canonical.js";
import type { FundingPlanningStore } from "./planning-types.js";
import { FundingPlannerError, assertSameAsset } from "./money.js";

function jsonRecord(value: unknown): Readonly<Record<string, JsonValue>> {
  return value as Readonly<Record<string, JsonValue>>;
}

function sameMoney(left: Money | null, right: Money | null): boolean {
  if (!left || !right) return left === right;
  try {
    assertSameAsset(left.asset, right.asset, "quoted amount");
    return left.raw === right.raw;
  } catch {
    return false;
  }
}

function planMoney(
  value: Readonly<Record<string, JsonValue>> | null,
): Money | null {
  if (!value) return null;
  const asset = value.asset;
  const raw = value.raw;
  if (
    !asset ||
    typeof asset !== "object" ||
    Array.isArray(asset) ||
    typeof raw !== "string"
  ) {
    return null;
  }
  const assetRecord = asset as Readonly<Record<string, JsonValue>>;
  const networkId = assetRecord.networkId;
  const assetId = assetRecord.assetId;
  const decimals = assetRecord.decimals;
  if (
    typeof networkId !== "string" ||
    typeof assetId !== "string" ||
    typeof decimals !== "number"
  ) {
    return null;
  }
  return { asset: { networkId, assetId, decimals }, raw };
}

export class FundingQuoteService {
  constructor(
    private readonly dependencies: Readonly<{
      db: Pool;
      planningStore: FundingPlanningStore;
      createQuote?: typeof createFundingQuote;
      now?: () => Date;
    }>,
  ) {}

  async quote(
    input: Readonly<{
      userId: string;
      request: FundingQuoteRequest;
      policy: FundingRuntimePolicy;
      policyRevision: string;
      ownershipRevision: string;
    }>,
  ): Promise<FundingQuoteSummary> {
    if (
      input.policy.creationMode !== "on" ||
      !input.policy.gates.quoteCreation
    ) {
      throw new FundingPlannerError(
        "invalid_policy",
        "funding quote creation is disabled",
      );
    }
    const now = this.dependencies.now?.() ?? new Date();
    const planning = await this.dependencies.planningStore.fetchOwnedCurrent({
      userId: input.userId,
      projectionId: input.request.liquidityProjectionId,
      now,
    });
    if (!planning) {
      throw new FundingPlannerError(
        "stale_projection",
        "funding discovery projection is absent or expired",
      );
    }
    if (
      planning.policyVersion !== input.policy.version ||
      planning.policyRevision !== input.policyRevision ||
      planning.ownershipRevision !== input.ownershipRevision
    ) {
      throw new FundingPlannerError(
        "stale_projection",
        "funding discovery facts changed before quote creation",
      );
    }
    const selected = planning.plannerSnapshot.sources.find(
      (source) =>
        source.option.sourceOptionId === input.request.selectedSourceOptionId,
    );
    if (!selected || !selected.option.selectable) {
      throw new FundingPlannerError(
        "source_not_selected",
        "exactly one owned selectable source option is required",
      );
    }
    const storedPlan = selected.commitPlan;
    const plannedSource = planMoney(storedPlan.operation.requestedSourceAmount);
    const plannedDestination = planMoney(
      storedPlan.operation.requestedDestinationAmount,
    );
    const sourceMatches = sameMoney(
      input.request.confirmedSourceAmount,
      plannedSource,
    );
    const destinationMatches = sameMoney(
      input.request.requestedDestinationAmount,
      plannedDestination,
    );
    if (
      (selected.option.amountMode === "exact_input" && !sourceMatches) ||
      (selected.option.amountMode !== "exact_input" && !destinationMatches) ||
      (input.request.confirmedSourceAmount != null && !sourceMatches) ||
      (input.request.requestedDestinationAmount != null && !destinationMatches)
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "quote request raw amounts differ from the selected source plan",
      );
    }
    if (storedPlan.segments.length > 1) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "staged or second-segment funding plans are forbidden",
      );
    }
    const destination = planning.plannerSnapshot.destination;
    if (!destination || !planning.plannerSnapshot.placement) {
      throw new FundingPlannerError(
        "destination_unavailable",
        "funding projection has no exact destination and placement",
      );
    }
    if (
      !canonicalJsonEqual(
        storedPlan.operation.sourceSnapshot,
        selected.option,
      ) ||
      !canonicalJsonEqual(
        storedPlan.operation.destinationTargetSnapshot,
        destination.target,
      ) ||
      !canonicalJsonEqual(
        storedPlan.operation.venueBindingSnapshot,
        destination.bindingOption,
      ) ||
      !canonicalJsonEqual(
        storedPlan.operation.marketContextSnapshot,
        planning.plannerSnapshot.marketContext,
      ) ||
      !canonicalJsonEqual(
        storedPlan.operation.placementSnapshot,
        planning.plannerSnapshot.placement,
      )
    ) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "selected source plan differs from frozen placement or destination facts",
      );
    }
    const plan = {
      ...storedPlan,
      operation: {
        ...storedPlan.operation,
        supportMetadata: {
          ...(storedPlan.operation.supportMetadata ?? {}),
          discoveryProjectionId: planning.id,
          ownershipRevision: planning.ownershipRevision,
        },
      },
    };

    const consentToken = `consent_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(
      Math.min(
        planning.expiresAt.getTime(),
        Date.parse(selected.option.expiresAt),
        now.getTime() + input.policy.ttl.quoteMs,
      ),
    );
    if (expiresAt.getTime() <= now.getTime()) {
      throw new FundingPlannerError(
        "stale_projection",
        "selected source option expired before quote creation",
      );
    }
    const stored = await (this.dependencies.createQuote ?? createFundingQuote)(
      this.dependencies.db,
      {
        userId: input.userId,
        discoveryProjectionId: planning.id,
        selectedSourceOptionSnapshot:
          plan.operation.sourceSnapshot ?? jsonRecord(selected.option),
        marketContextSnapshot: planning.plannerSnapshot.marketContext
          ? jsonRecord(planning.plannerSnapshot.marketContext)
          : null,
        destinationOptionSnapshot: plan.operation.destinationTargetSnapshot,
        venueBindingSnapshot: plan.operation.venueBindingSnapshot,
        planSnapshot: plan,
        policyVersion: input.policy.version,
        policyRevision: input.policyRevision,
        canonicalRequest: input.request as unknown as JsonValue,
        consentToken,
        expiresAt,
      },
    );
    const firstSegment = plan.segments[0];
    const expected =
      firstSegment == null
        ? planning.plannerSnapshot.placement.destinationRequirement
        : planMoney(firstSegment.quotedExpectedOutput);
    const minimum =
      firstSegment == null
        ? planning.plannerSnapshot.placement.destinationRequirement
        : planMoney(firstSegment.quotedMinOutput);
    if (!expected || !minimum) {
      throw new FundingPersistenceError(
        "quote_mismatch",
        "stored plan lacks exact destination economics",
      );
    }
    return {
      quoteId: stored.id,
      liquidityProjectionId: planning.id,
      selectedSourceOptionId: selected.option.sourceOptionId,
      destinationOptionId: destination.option.destinationOptionId,
      venueBindingOptionId: destination.bindingOption.venueBindingOptionId,
      planKind: plan.operation.planKind,
      experienceMode:
        plan.operation.experienceMode === "inline"
          ? "inline_funding"
          : plan.operation.experienceMode,
      expectedDestination: expected,
      minimumDestination: minimum,
      fees: selected.option.fees,
      eta: selected.option.eta,
      requiredActions: selected.option.requiredActions,
      planHash: canonicalJsonHash(plan),
      consentToken,
      expiresAt: stored.expiresAt.toISOString(),
      policyVersion: stored.policyVersion,
    };
  }
}
